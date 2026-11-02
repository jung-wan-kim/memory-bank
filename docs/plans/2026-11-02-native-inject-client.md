# 프롬프트 훅 네이티브 씬 클라이언트 + 검색 연결 mmap (2026-11-02, /team — Rust 전환 분석 권고 2·4)

출발점: 2026-11-02 Rust 전환 성능 분석. 로컬 플러그인의 무거운 계산(sqlite-vec·FTS5·ONNX·SQLite)은 이미 네이티브라 전면 Rust 재작성의 이득은
10~20% 에 그친다. 프롬프트마다 도는 UserPromptSubmit 훅의 웜 경로만은 다르다 — 실측(웜 데몬, 끝에서 끝):

| 구간 | 실측 | 비고 |
|---|---|---|
| `bash hooks/inject-context.sh` → node 씬 클라이언트 전체 | 110~160ms | 3회 |
| 그중 데몬 작업(embed+search+related, 로그 `duration_ms`) | 18~90ms | 같은 호출 |
| 남는 몫 = Node 기동 + 가벼운 import + 소켓 왕복 | 70~90ms | node 단독 기동 60ms |
| 라이브 로그 1.7.8(78회) 데몬 몫 p50 | 344ms (embed 79 / search 246) | 격리 실행은 embed 10~45 / search 17~20 |

격리 실험(2026-11-02): 120초 유휴 뒤 검색 18→41ms(2배, 15초 keep-alive 로도 37ms) — 라이브의 10배 격차는 재현되지 않음. 동시 node 기동 8개 아래서
임베딩 38→130ms(3.4배), 검색은 불변. `PRAGMA mmap_size=256MB` 로 `vec_facts_kr` KNN 16.8→9.6ms, 128MB 캐시 추가 시 7.1ms.
결론: 웜 경로에서 줄일 수 있는 확정 몫은 **프로세스 기동 60~90ms** 와 **벡터 스캔 mmap** 이다. 라이브 search 246ms 의 나머지는 프롬프트 제출 순간의
CPU 경합(훅 다발 기동)으로 추정되며 이 계획은 그것을 재지 않고 줄인다(네이티브 클라이언트 = 그 순간의 node 기동 하나 감소).

## Spec (목표/제약/용어)

- **목표**: 훅 웜 경로의 프로세스 몫을 ≤10ms 로(끝에서 끝 ≤40ms, 데몬 작업 제외), 검색 연결에 mmap 을 켜 벡터 KNN 을 줄인다. 전면 Rust 재작성은 하지 않는다.
- **제약**
  - 훅은 어떤 경우에도 프롬프트를 깨지 않는다(종료 코드 0). 네이티브 클라이언트의 모든 실패는 **node 스크립트로 폴백**하고 폴백 사유를 로그에 남긴다(조용한 실패 금지).
  - 데몬 프로토콜(줄 단위 JSON, `warming`, `ok/context/ledger_keys`)·주입 로그 스키마(`inject-log.ts`)·세션 원장 형식(`inject-ledger.ts`)·프롬프트 게이트
    (`prompt-gate.ts`)는 JS 클라이언트와 **동일** — 패리티 테스트로 고정한다.
  - 공개 플러그인이다. cargo 가 없는 사용자는 기존 node 경로 그대로. 바이너리는 git 에 넣지 않는다 — SessionStart 비동기 훅이 cargo 가 있을 때만 빌드해
    사용자 디렉토리(`<indexDir>/bin/`)에 둔다(live-apply 는 코드 폴더 `dist/scripts/cli/hooks` 만 옮기므로 그 밖에 둔다).
  - 바이너리는 자기 소스 해시를 내장하고, 래퍼는 플러그인의 `native/inject-client/SRC_HASH` 와 같을 때만 쓴다(옛 바이너리가 새 프로토콜에 붙지 않게 — 불일치는 node 경로 + 재빌드).
  - 훅 입력은 stdin JSON(scaffold NEVER DO: 환경변수 의존 금지). 기존 테스트 전부 통과. 릴리스는 1.7.9(표면 3곳 + CHANGELOG + 태그 + GitHub 릴리스 + 설치 캐시).
- **용어**
  - *씬 클라이언트*: UserPromptSubmit 훅에서 데몬에 프롬프트를 보내고 블록을 stdout 에 쓰는 프로세스(지금은 `scripts/inject-context.js`).
  - *웜 경로*: 데몬이 응답한 경우. *폴백*: 데몬 실패(`no-daemon`·`daemon-timeout`·`daemon-closed`·`daemon-error`)로 node 스크립트가 로컬 계산하는 경우.
  - *indexDir*: `$MEMORY_BANK_CONFIG_DIR` 또는 `$XDG_CONFIG_HOME/superpowers` 또는 `~/.config/superpowers` 아래 `conversation-index`.

## Plan Summary

**Scope:** 7 tasks across ~14 files — complexity MEDIUM (릴리스 포함, DB 변경 없음)

**Key Deliverables:**
1. Rust 크레이트 `native/inject-client/` — JS 클라이언트 웜 경로의 1:1 포트 + 실패 시 node 폴백 exec
2. `scripts/inject-context.js`: `MEMORY_BANK_INJECT_REQ_ID` 로 req_id 승계(데몬 줄과 폴백 줄을 한 프롬프트로 묶는 기존 계약 유지)
3. `hooks/inject-context.sh`: 해시 일치하는 네이티브 바이너리 우선, 없으면 node
4. `scripts/build-native-client.sh` + SessionStart 비동기 훅 등록(`hooks/hooks.json`) — cargo 있을 때만, 해시 다를 때만 빌드
5. 데몬·로그에 `client_impl`(`native`|`node`) 필드 — 라이브에서 어느 클라이언트가 왔는지 측정 가능
6. `getSearchDb()` 에 `PRAGMA mmap_size`(기본 256MB, `MEMORY_BANK_SQLITE_MMAP_BYTES`, 0 = 끔)
7. 릴리스 1.7.9 + 설치 캐시 갱신 + 라이브 로그 확인

**Domain Glossary**

| Term | Definition | Usage |
|---|---|---|
| `SRC_HASH` | `native/inject-client/src/**`·`Cargo.toml` 의 sha256(정렬 연결) 앞 16자. 저장소 파일 `native/inject-client/SRC_HASH` 에 커밋, 바이너리에 `env!` 로 내장 | 래퍼 비교·빌드 스크립트·테스트 핀 |
| `client_impl` | 주입 로그 선택 필드 `'native' \| 'node'` — 클라이언트가 요청 메타로 보내고 데몬이 로그 줄에 싣는다 | inject-log.ts·inject-daemon.ts·inject-core.ts |
| `MEMORY_BANK_NATIVE_CLIENT` | 래퍼가 바이너리 경로를 덮어쓸 때 쓰는 env(테스트용) | hooks/inject-context.sh |

**Acceptance Criteria:**

- AC-001 네이티브 클라이언트 웜 경로 ≡ JS 클라이언트: 가짜 데몬 4경우((a) 즉시 `ok`+context+ledger_keys (b) `warming` 뒤 `ok` (c) `ok:false`
  (d) 끊김) 에서 stdout 바이트·원장 파일 내용·폴백 사유가 JS 와 같다.
  verify: `npx vitest run test/native-inject-client.test.ts -t "AC-001"` / evidence: 테스트 이름
- AC-002 프롬프트 게이트 패리티: 작업 알림·슬래시 명령(인자 있음/없음)·system-reminder 뒤 본문·짧은 프롬프트·Codex 봉투·빈 입력 — skipped 로그 줄의
  `status/reason/via/client/has_session/project/prompt_len` 이 JS 와 같고 stdout 은 비어 있다.
  verify: `npx vitest run test/native-inject-client.test.ts -t "AC-002"` / evidence: 테스트 이름
- AC-003 폴백: 데몬 없음 → node 스크립트를 `MEMORY_BANK_INJECT_FALLBACK_REASON=no-daemon` + 같은 `MEMORY_BANK_INJECT_REQ_ID` 로 실행하고 stdin 원문을
  그대로 넘긴다; 폴백 로그 줄의 `req_id` 가 네이티브 요청의 것과 같다. node 를 못 찾으면 stderr 1줄 + exit 0 + 출력 없음.
  verify: `npx vitest run test/native-inject-client.test.ts -t "AC-003"` / evidence: 테스트 이름
- AC-004 래퍼 선택 규칙: 바이너리 있음+실행 가능+해시 일치 → 네이티브, 해시 불일치·없음·실행 불가 → node. 둘 다 stdout 결과 동일.
  verify: `npx vitest run test/inject-hook-wrapper.test.ts` / evidence: 테스트 이름
- AC-005 속도: 가짜 데몬(즉시 응답) 기준 네이티브 클라이언트 끝에서 끝 중앙값(7회) ≤ 25ms 이고 JS 클라이언트의 절반 미만.
  verify: `npx vitest run test/native-inject-client.test.ts -t "AC-005"`(수치 출력) / evidence: 테스트 출력 두 숫자
- AC-006 빌드 스크립트: cargo 없음 → stderr "cargo 없음 — node 경로 유지" + exit 0 + 파일 변화 없음; 해시 같음 → 재빌드 없음(exit 0, 로그 1줄);
  해시 다름 → 빌드 후 `<indexDir>/bin/memory-bank-inject-client` + `.srchash` 교체(임시 파일 → rename).
  verify: `npx vitest run test/build-native-client.test.ts` / evidence: 테스트 이름
- AC-007 `getSearchDb()` 연결의 `PRAGMA mmap_size` 가 268435456 이고, `MEMORY_BANK_SQLITE_MMAP_BYTES=0` 이면 0; 잘못된 값은 기본값 + stderr 1줄.
  verify: `npx vitest run test/search-perf-guards.test.ts -t "mmap"` / evidence: 테스트 이름
- AC-008 `client_impl` 이 데몬 로그 줄에 실린다(네이티브 `native`, JS `node`); 모르는 값은 버린다.
  verify: `npx vitest run test/inject-daemon-protocol.test.ts -t "client_impl"` / evidence: 테스트 이름
- AC-009 `npm run build` rc=0, `npm test` 전체 통과(cargo 있는 이 기계에서 네이티브 테스트 포함).
  verify: 두 명령 / evidence: `.qa-artifacts/build.log`·`test.log`
- AC-010 릴리스 1.7.9: package.json·plugin.json·marketplace.json 버전, CHANGELOG 항목, 태그 v1.7.9, GitHub 릴리스, 설치 캐시 1.7.9 디렉터리.
  verify: `git show HEAD:package.json` · `gh release view v1.7.9` · `ls ~/.claude/plugins/cache/memory-bank-dev/memory-bank/1.7.9` / evidence: 명령 출력
- AC-011 라이브: 설치 뒤 SessionStart 빌드가 `<indexDir>/bin/memory-bank-inject-client` 를 만들고(로그 `native-build.log`), 실제 프롬프트의 주입 로그 줄에
  `plugin_version 1.7.9`·`client_impl native` 가 찍히며, 래퍼 끝에서 끝 5회 중앙값 ≤ 40ms(데몬 웜).
  verify: `tail` 로그 + `/usr/bin/time -p bash hooks/inject-context.sh <<< '<봉투>'` ×5 / evidence: 명령 출력
- AC-012 npm 발행(2026-11-02 사용자 요청 "npm 도 릴리즈해"): 타르볼이 플러그인으로 동작할 파일만 담는다 — hooks.json·plugin.json 이 `${CLAUDE_PLUGIN_ROOT}/` 로 가리키는 경로 전부, `bin`·`main` 대상,
  `native/inject-client/{Cargo.toml,Cargo.lock,SRC_HASH,src/*.rs}`, `dist/`·`cli/`·`hooks/`·`scripts/`; `.codex/`·`.claude/`·`docs/`·`bench/`·`test/`·`src/`·`CLAUDE.md`·`marketplace.json` 은 없다. 레지스트리의 `memory-bank@1.7.9` 는 `gitHead` 가 발행 커밋이다.
  verify: `npx vitest run test/npm-pack-contents.test.ts` · `npm view memory-bank@1.7.9 version gitHead dist.fileCount` / evidence: 테스트 이름 · 명령 출력(`.qa-artifacts/npm-publish.log`)

**Steps:**

1. **크레이트** — `native/inject-client/{Cargo.toml, src/main.rs, src/gate.rs, src/log.rs, src/ledger.rs, SRC_HASH}`(new). 의존: `serde_json`, `uuid`(v4).
   `main.rs`: stdin(비-TTY, ≤2000ms) → 봉투 파싱(`prompt/cwd/session_id`, `turn_id`→codex·`transcript_path`→claude-code, env `USER_PROMPT/CWD/SESSION_ID`
   폴백 + Codex 봉투 풀기) → `gate.rs`(`injectionQuery` 포트: MIN 20자, `<command-message>/<command-name>` 의 `<command-args>`, 선행 `<system-reminder>` 제거,
   기계 접두 4종) → skipped 면 `log.rs` 로 줄 추가(키 순서 JS 와 같게: ts, status, reason, project, prompt_len, via, has_session, client, entrypoint, req_id, client_impl)
   → 소켓 경로(`$MEMORY_BANK_PLUGIN_ROOT/package.json` 버전, 정규식·103바이트 규칙, 아니면 legacy 이름) → `UnixStream` connect 300ms / 응답 3s / warming 20s →
   `ok` 면 stdout 에 context+`\n` 쓰고 성공 시에만 `ledger.rs`(sanitize·800 상한·tmp+rename·7일 정리) → 끝. 실패 → `exec node <root>/scripts/inject-context.js`
   (env `MEMORY_BANK_INJECT_FALLBACK_REASON`·`MEMORY_BANK_INJECT_REQ_ID`, stdin 원문 파이프, stdout/stderr 상속, 종료 코드 전달 — 단 최종은 래퍼의 `|| true`).
   검증: `cargo build --release` rc=0, `cargo test`(게이트 단위 시험 — JS 테스트 입력 재사용).
2. **JS 쪽 작은 변경** — `scripts/inject-context.js`: `req_id: process.env.MEMORY_BANK_INJECT_REQ_ID || randomUUID()`(형식 검증: `[A-Za-z0-9-]{1,40}`), 메타에
   `client_impl: 'node'`. `src/inject-daemon.ts`·`src/inject-core.ts`·`src/inject-log.ts`: `client_impl` 통과(`native|node` 만). 검증: AC-008 테스트.
3. **래퍼·빌드** — `hooks/inject-context.sh`: `BIN=${MEMORY_BANK_NATIVE_CLIENT:-<indexDir>/bin/memory-bank-inject-client}`; `[ -x "$BIN" ] && [ "$(cat
   "$BIN.srchash")" = "$(cat "$HOOK_DIR/../native/inject-client/SRC_HASH")" ]` → `MEMORY_BANK_PLUGIN_ROOT=<root> "$BIN"`, 아니면 기존 node 줄. 둘 다 `|| true`.
   `scripts/build-native-client.sh`(new): cargo 탐색(PATH + `~/.cargo/bin`) → 없으면 stderr 1줄 exit 0 → 해시 비교 → `cargo build --release
   --target-dir <indexDir>/native-build` → 바이너리·해시를 임시 이름으로 복사 뒤 rename → `<indexDir>/logs/native-build.log` 1줄. `hooks/hooks.json`
   SessionStart 에 `"async": true` 로 등록. `SRC_HASH` 는 `scripts/native-src-hash.mjs`(new) 가 계산하고 테스트가 커밋된 값과 대조(불일치 = 실패).
   검증: AC-004·AC-006 테스트.
4. **mmap** — `src/search.ts` `getSearchDb()`: 연결 직후 `db.pragma('mmap_size=' + bytes)`; `bytes` = env 정수(≥0) 또는 268435456, 잘못된 값은 기본값 + stderr.
   검증: AC-007 테스트 + 실측(`vec_facts_kr` KNN 중앙값 전/후 — 보고에 숫자).
5. **패리티 테스트** — `test/native-inject-client.test.ts`(new): `describe.skipIf(!cargo)` 로 감싸되 skip 시 콘솔에 "cargo 없음 — 네이티브 테스트 미실행" 을 남긴다;
   `beforeAll` 에서 크레이트 빌드(저장소 밖 target). 가짜 데몬은 `test/inject-daemon-socket.test.ts` 의 서버 패턴을 헬퍼로 뽑아(`test/helpers/fake-inject-daemon.ts`,
   new) 양쪽 테스트가 같이 쓴다(Extract Function). 각 경우에 JS·네이티브를 같은 입력으로 실행해 stdout·원장·로그 필드 비교, AC-005 시간 측정.
   `test/inject-hook-wrapper.test.ts`(new): 래퍼를 `bash` 로 실행(등록된 명령 문자열 그대로), 가짜 바이너리(해시 일치/불일치/실행 불가)로 선택 규칙 확인.
   `test/build-native-client.test.ts`(new): PATH 에서 cargo 를 뺀 환경, 해시 같음/다름.
6. **빌드·전체 테스트** — `npm run build`, `npm test` → 로그는 `.qa-artifacts/`.
7. **릴리스 1.7.9** — 버전 3곳·CHANGELOG(`## [1.7.9]` — 바뀐 점: 네이티브 씬 클라이언트(선택, cargo 필요)·mmap·`client_impl`)·커밋·태그·push·
   `gh release create v1.7.9` → 마켓플레이스 갱신(`claude plugin update` 경로는 1.7.8 릴리스 때의 절차를 `docs/qa-test-plan.md` TC-JUDGE-014 와 git 이력에서 확인해 그대로)
   → 새 세션에서 SessionStart 빌드 로그·첫 프롬프트 로그 줄 확인(AC-011).

## Program Design

```
native/inject-client/
  Cargo.toml            [package] name = "memory-bank-inject-client", edition 2021; [dependencies] serde_json, uuid = { features = ["v4"] }
  SRC_HASH              16 hex — scripts/native-src-hash.mjs 산출, 테스트가 핀
  src/main.rs           fn main() -> ExitCode  { let input = read_stdin(2000ms); let env = parse_envelope(&input); let q = gate::injection_query(&env.prompt);
                        match q { Skip(reason) => log::append_skipped(..), Use(_) => match daemon::ask(..) { Ok(ans) => deliver(ans), Err(reason) => fallback::exec_node(reason, &input) } } }
  src/gate.rs           injection_query(&str) -> Query  (prompt-gate.ts 1:1 — 상수 MIN_PROMPT_CHARS=20, MACHINE_PREFIXES 4종)
  src/daemon.rs         socket_path(index_dir, version) ; ask(prompt, cwd, session_id, meta) -> Result<Answer, FailReason>  (300ms/3s/20s)
  src/ledger.rs         load(session_id) ; append(session_id, keys)  (sanitize, 800 cap, tmp+rename, prune 7d)
  src/log.rs            append_line(index_dir, serde_json::Value)  (5MB 회전 → .old)
  src/fallback.rs       exec_node(reason, req_id, raw_stdin) -> ExitCode
scripts/build-native-client.sh   scripts/native-src-hash.mjs   hooks/inject-context.sh(수정)   hooks/hooks.json(수정: SessionStart async 빌드)
scripts/inject-context.js(수정: req_id 승계, client_impl)   src/inject-daemon.ts · src/inject-core.ts · src/inject-log.ts(수정: client_impl)   src/search.ts(수정: mmap)
test/native-inject-client.test.ts · test/inject-hook-wrapper.test.ts · test/build-native-client.test.ts · test/helpers/fake-inject-daemon.ts(new)
```

파울러 냄새 점검: JS 클라이언트와 네이티브 클라이언트는 의도된 중복(Duplicated Code)이다 — 하나는 폴백·호환 경로, 하나는 속도 경로. 드리프트는 패리티
테스트가 잡는다(이 저장소의 sync/async 호스트 관례와 같음). 가짜 데몬은 두 테스트 파일에 중복돼 있던 것을 헬퍼로 뽑는다(Extract Function). `gate.rs` 는
`prompt-gate.ts` 를 그대로 옮긴 것이라 두 벌이지만 테스트 입력을 공유해 같은 판정을 강제한다. 남긴 이유: Rust 가 TS 모듈을 import 할 수 없다.

## Risks / Stop rules

- 네이티브 클라이언트가 블록을 **부분 출력**한 뒤 실패하면 폴백이 블록을 한 번 더 쓸 수 있다 → 출력은 응답 전체를 받은 뒤 한 번에 쓰고, 쓰기 시작 뒤에는 폴백하지 않는다
  (JS 와 같은 순서: print first, record second).
- `cargo build` 가 SessionStart 에서 CPU 를 쓴다(첫 1회 20~60초, 비동기) — 네트워크 없는 기계에서 크레이트 다운로드가 실패하면 로그 1줄 + node 경로 유지(기능 손실 없음).
- 릴리스 뒤 설치 캐시가 갱신되지 않으면 1.7.8 코드가 계속 돈다 → AC-011 은 설치 캐시 디렉터리 존재를 먼저 확인하고, 안 되면 `not_verified` 로 보고(사용자 작업 떠넘김 금지 —
  1.7.8 때 쓴 갱신 명령을 재사용).
- 패리티가 한 경우라도 깨지면 래퍼 기본값을 node 로 두고(네이티브는 `MEMORY_BANK_NATIVE_CLIENT` 명시 때만) 릴리스한다 — 속도보다 동일 동작.
- mmap 은 읽기 전용 연결에만 — 쓰기 연결(색인·워커)은 건드리지 않는다(WAL 과 mmap 의 상호작용을 이 계획에서 재지 않았다).

## Open Questions (→ `docs/plans/open-questions.md`)

- [ ] 라이브 search_ms p50 246ms(격리 17ms) 의 원인 확정 — 프롬프트 제출 순간의 훅 다발 CPU 경합 가설. 졸업 트리거: 1.7.9 라이브 로그 1주 뒤 `client_impl=native` 줄의
      search_ms 분포가 그대로면(≥200ms) 데몬 안 측정 보강(`process.cpuUsage` 전/후·동시 프로세스 수)으로 재진단.
- [ ] 사실 벡터 표 int8@600 이행(2026-10-16 계획 7단계) — 지금도 float32(37+31MB). 가드가 1.7.6 프로세스(아직 실행 중)를 거부한다. 졸업 트리거: 옛 세션 종료 뒤 `scripts/migrate-vec-facts-int8.mjs` 실행 결정.
- [ ] 다른 플랫폼(linux-x64 등) 프리빌트 배포 여부. 졸업 트리거: cargo 없는 사용자의 요청 또는 GitHub Release 자산 빌드 파이프라인 결정.

## Deviations (구현 중 계획에서 벗어난 것 — 2026-11-02)

- D0 목표 미달: "훅 웜 경로의 프로세스 몫 ≤ 10ms" 는 약 15ms(래퍼 12.3 + 바이너리 3.4, 실데몬 끝-끝 32.5ms − 데몬 16~17ms)로 미달이다. 남은 몫의 대부분은 bash 래퍼의 기동(6.7ms)이다 — 래퍼를 없애고 hooks.json 이 바이너리를 직접 부르는 안은 바이너리 부재 때의 폴백을 바이너리 밖에서 해야 해 이번 범위 밖.

- D1 폴백 신호 env 이름: 계획(AC-003·Step 1)은 `MEMORY_BANK_INJECT_FALLBACK_REASON` 으로 적었지만 그 변수는 JS 클라이언트가 **node ABI 재실행**에 쓰는 신호라
  의미가 다르다(재실행은 `{ failed: reason }` 로 끝내는 분기가 따로 있다). 네이티브 → node 인계는 새 변수 `MEMORY_BANK_INJECT_DAEMON_FAILED` 로 하고
  JS 는 `^[a-z-]{1,40}$` 로 검증한다(`scripts/inject-context.js`). AC-003 의 검증(테스트 이름)은 그대로, 시나리오 TC-NAT-003 은 새 이름으로 적었다.
- D2 빌드 스크립트 시험 훅: `MEMORY_BANK_CARGO`(cargo 경로 또는 `none` = cargo 없는 기계처럼) — 테스트가 PATH 에서 cargo 를 빼는 것만으로는
  `~/.cargo/bin`·`/opt/homebrew/bin` 탐색을 막을 수 없어서 추가했다(AC-006 의 "cargo 없음" 경우).
- D3 패리티 테스트 하네스 결함 2건을 구현 중 고쳤다: ① 클라이언트를 `spawnSync` 로 돌리면 vitest 워커의 이벤트 루프가 막혀 같은 프로세스의 가짜 데몬이
  답하지 못한다 — 두 클라이언트가 모두 3초 뒤 폴백으로 끝나 8/10 실패했고, 비동기 `spawn`(`runChild`) 으로 바꾸자 통과(실측: 네이티브 3.4ms·node 79.8ms).
  ② `baseEnv` 가 `extra` 를 펼친 **뒤** `USER_PROMPT` 를 지워 Codex 봉투 경우가 두 클라이언트 모두 skipped/empty 로 끝났다(패리티는 성립했지만 Codex 경로가
  시험되지 않음) — 지우기 → `extra` 적용 순서로 바꿨다.
- D4 connect 300ms 타이머 없음: unix 소켓 connect 는 ENOENT/ECONNREFUSED 로 즉시 답하므로 네이티브는 타이머 없이 `no-daemon` 으로 간다(JS 의 300ms 타이머는
  이 경우 어차피 울리지 않는다). 응답 3s·warming 20s 는 계획대로.
- D5 구조 리뷰 `[새]` 냄새 3건을 기능과 분리한 단계로 수정: `js_string`/`truthy` 를 `src/jsval.rs` 로(Duplicated Code), `envelope::parse` 를
  `read_stdin_fields`/`read_user_prompt_env` 로 분리(Long Function), 래퍼의 인덱스 경로 유도를 `INDEX_DIR` 하나로(Duplicated Code). 소스 해시는
  `46ce7203813a5c63` → `c81fdeeed2288d48` 로 재고정(중간 `11634903540f0873` 은 cargo dead_code 경고 처리 전).
- D6 `gate::Query::Use(String)` payload 는 비테스트 빌드에서 읽히지 않아(클라이언트는 원문 프롬프트를 보내고 데몬이 다시 유도 — JS 와 같은 계약) cargo 경고가
  났다 → `#[cfg_attr(not(test), allow(dead_code))]` 로 두고 단위 테스트가 추출 문장을 계속 대조한다.
- D8 warming 상한(A-001(e)): JS `askDaemon` 은 warming 줄마다 20초 타이머를 다시 걸어 warming 만 반복하는 데몬에 끝없이 매였고, 네이티브 포팅도 같은 뜻(읽기마다 20초)이라 둘 다
  적대 시나리오에서 322초 뒤 강제 종료로 끝났다 → 두 클라이언트 모두 **첫 warming 부터 절대 20초 기한**(다음 warming 은 연장 없음)으로 고쳤다 — JS 쪽 동작 변경은 계획 밖이지만 패리티(AC-001)와
  "훅은 프롬프트를 깨지 않는다" 계약을 지키려면 함께 바꿔야 했다. 패리티 테스트 'A-001 (e)' 가 두 클라이언트를 같은 데몬에 동시에 넣어 20초 안팎·요청 1회씩을 고정.
- D9 패리티 테스트의 빌드 위치: Step 5 는 "저장소 밖 target" 이라 했지만 테스트는 크레이트의 `target/`(gitignore) 에 빌드한다 — SessionStart 빌드만 `<indexDir>/native-build` 를 쓴다.
- D10 독립 반박 1라운드(HIGH 2·MEDIUM 5·LOW 13) 반영: ① E2E 가 같은 session_id 로 돌려 dedup 된 빈 블록끼리 비교했던 것을 회차마다 다른 id 로 바꿔 실제 블록 바이트를 비교
  ② README 의 "~3ms end to end" 를 가짜 데몬/실데몬 수치로 분리 ③ 데몬 `truncateFact` 코드포인트 경계 + 네이티브의 짝 없는 서로게이트 허용 ④ 폴백 줄 `client_impl: native`
  ⑤ AC-005 테스트의 `.qa-artifacts` mkdir ⑥ live-apply 항목에 `native/` ⑦ 패리티 입력 표(비객체 JSON·숫자/불 prompt·BOM·CRLF·U+0085·FEFF) ⑧ stdin `null` ⑨ JS 공백 집합
  ⑩ 숫자 문자열화 ⑪ 바이트 단위 절대 기한 ⑫ `PERSONAL_SUPERPOWERS_DIR` ⑬ 설치 순서(핀 먼저 삭제) ⑭ 핀에 Cargo.lock ⑮ "읽기 전용 연결" 서술 정정 ⑯ 검증 불가 수치 삭제
  ⑰ 패닉 가능 `eprintln!` 제거 ⑱ 폴백에 남은 훅 예산 전달 ⑲ 목표 "프로세스 몫 ≤ 10ms" 미달(≈15ms) 명시 ⑳ 문서·시나리오 정합(아래 D9, QA 계획 A-001 기대값). 백오프(F14 후반)·
  stdin 2초 절단의 멀티바이트 경계(F10)는 잔여 목록.
- D11 독립 반박 2라운드(CRITICAL 0·HIGH 0·MEDIUM 2·LOW 7, 회귀 2/9 — 종료 규칙 ①로 루프 종료, 9건은 한 번에 고치고 재비평하지 않음) 반영: ① [MEDIUM·회귀] 서로게이트 정리기가 `\` 다음 바이트가
  비ASCII 일 때 `&text[i..i+2]` 로 패닉(블록 없이 종료 — 래퍼가 err.log 로 묶어 프롬프트는 살지만 주입이 빠짐) → ASCII 일 때만 2바이트 복사 + 단위 테스트 ② [MEDIUM·회귀] 문서 수치가
  인용 파일과 어긋남(107→112, 32.1→32.5, 11.9→12.3, 3.5/78.2→3.4/75.0 재측정, cargo 5→8, 패리티 15→17) ③ 쓰기 기한(connect 뒤 3초 절대 기한을 `write_all` 앞에 잡고 WouldBlock/TimedOut →
  `daemon-timeout`) ④ 봉투(stdin·`USER_PROMPT`)도 파싱 전에 같은 정리기 ⑤ 패리티 표에 기대값 열 ⑥ 원장 800 상한·한 청크 warming+ok·`\`+비ASCII 테스트 ⑦ "읽기 전용 연결" → "쓰기 가능한 연결이지만
  읽기만 한다" ⑧ 인덱스 디렉터리 우선순위(`MEMORY_BANK_CONFIG_DIR` → `PERSONAL_SUPERPOWERS_DIR` → `XDG_CONFIG_HOME/superpowers` → `~/.config/superpowers`)를 JS·래퍼·빌드 스크립트에 같게 ⑨ 보고서
  수치 일치. 정리기는 `src/jsval.rs` 로 옮겼고 소스 해시는 `14bd07782bcccd12` → `d9428017839de77b`. 잔여(고치지 않음): 빌드 실패 백오프, stdin 2초 절단의 멀티바이트 경계. 끝-끝 32.5/112ms 인용은
  `012f4a6` 바이너리의 측정이다 — 그 뒤 변경은 시간 경로를 건드리지 않고, 최종 HEAD 의 E2E 재실행은 레벨1 판정(≤40ms·블록 동일)으로만 `.qa-evidence.json` 에 남긴다(수치 재인용 없음).
- D12 npm 발행(AC-012, 태그 뒤 추가): 태그 `v1.7.9` 트리를 `git archive` 로 꺼내 `npm pack --dry-run` 한 결과 `.npmignore` 의 `src/`·`scripts/` 가 깊이 무관하게 적용돼 **`scripts/`(SessionStart·UserPromptSubmit 훅이 전부 참조)와
  `native/inject-client/src/` 가 빠지고** `.codex` 46·`docs` 25·`bench` 19·`.claude` 16 파일 등이 들어갔다(276 파일, 7.8MB) — 그대로 발행하면 npm 설치본은 훅이 깨진 패키지다. `package.json` 에 `files` 화이트리스트
  (+`publishConfig.access=public`)를 넣고 `.npmignore` 의 `src/` 를 `/src/` 로 고정, `scripts/`·`.claude-plugin/` 제외를 없앴다. 내용은 `test/npm-pack-contents.test.ts`(TC-REL-002) 가 훅·plugin.json 참조 경로 전부·`bin`·`main`·
  네이티브 .rs 전건 포함과 개발 파일 제외를 고정한다. 따라서 npm 1.7.9 타르볼은 태그 커밋이 아니라 이 패키징 커밋(문서·패키징만 다름, 코드·dist 동일)에서 나오며 `gitHead` 로 식별한다. 발행 자격: `~/.npmrc` 의 토큰이
  `GET /-/whoami` 에서 E401 — 환경변수·키체인·발행 자동화 어디에도 다른 자격이 없어 발행 명령 자체는 사용자가 토큰을 갱신한 뒤 깨끗한 worktree 에서 `npm publish` 로 돈다(비밀값은 적지 않는다).
- D7 mmap 실측 수치(계획 Step 4 "보고에 숫자"): 구현 뒤 재측정(실DB 읽기 전용, 같은 질의 LIMIT 50, 워밍 뒤 9회 중앙값, `c780271`, `.qa-artifacts/knn-mmap.json`)은
  mmap 끔 → 256MB 가 `vec_facts` 8.1 → 8.0ms, `vec_facts_kr` 7.0 → 6.7ms 로 **잡음 수준**. 설계 단계의 16.8 → 9.6ms 는 캐시가 식은 첫 호출을 기본값 쪽에 둔 순서
  효과였다(권고 ④의 근거 정정). mmap 은 비용이 없어 유지하되 성능 개선으로 세지 않는다. AC-005 인용 수치는 단독 실행 3.4/75.0ms(`ac-005-timing-cited.json`, 06:06Z, 릴리즈 바이너리 소스 해시 `d9428017839de77b`).

P3_SNAPSHOT: .qa-artifacts/p3-snapshot.json
