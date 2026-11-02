# QA Test Plan — 프롬프트 훅 네이티브 씬 클라이언트 + 검색 연결 mmap (2026-11-02, /team, Rust 전환 분석 권고 2·4)

범위: `docs/plans/2026-11-02-native-inject-client.md` (AC-001~AC-011).
대상: `native/inject-client/`(Rust 크레이트 — 데몬 웜 경로·프롬프트 게이트·원장·로그·node 폴백) · `hooks/inject-context.sh`(바이너리 선택 규칙) ·
`scripts/build-native-client.sh`·`scripts/native-src-hash.mjs`(SessionStart 비동기 빌드·소스 해시) · `scripts/inject-context.js`(req_id 승계·`client_impl`) ·
`src/inject-daemon.ts`·`src/inject-core.ts`·`src/inject-log.ts`(`client_impl` 통과) · `src/search.ts`(`PRAGMA mmap_size`) · 릴리스 1.7.9.
실행 표면: UserPromptSubmit 훅(stdin JSON → stdout 블록), SessionStart 비동기 훅(빌드), 로컬 SQLite 검색 연결. 웹 UI 없음 — 브라우저 QA 해당 없음.
이전 plan(2026-10-19 Memorilla 적용)은 git 이력(`bdb6d6f` 이전)에 있다.

## 수용 기준 매핑 (AC Coverage)

- AC-001: 네이티브 클라이언트 웜 경로가 JS 클라이언트와 같다(가짜 데몬 4경우 — stdout 바이트·원장 파일·폴백 사유) → TC-NAT-001, TC-NEG-001, TC-E2E-001
- AC-002: 프롬프트 게이트 패리티 — skipped 로그 줄 필드가 JS 와 같고 stdout 은 비어 있다 → TC-NAT-002, TC-NEG-003
- AC-003: 폴백 — 데몬 실패 시 node 스크립트를 같은 `req_id`·사유로 실행하고 stdin 원문을 넘긴다, node 없음은 stderr 1줄 + exit 0 → TC-NAT-003, TC-NEG-002
- AC-004: 래퍼 선택 규칙 — 해시 일치·실행 가능한 바이너리만 네이티브, 그 밖은 node, 결과 동일 → TC-WRAP-001, TC-NEG-002
- AC-005: 속도 — 가짜 데몬 기준 네이티브 끝에서 끝 중앙값(7회) ≤ 25ms 이고 JS 의 절반 미만 → TC-PERF-001
- AC-006: 빌드 스크립트 — cargo 없음·해시 같음·해시 다름 세 경우의 동작 → TC-BUILD-001
- AC-007: `getSearchDb()` 연결의 `PRAGMA mmap_size` 기본 268435456, env 0 → 0, 잘못된 값 → 기본값 + stderr → TC-MMAP-001
- AC-008: `client_impl` 이 데몬 로그 줄에 실린다(`native`|`node`, 모르는 값은 버림) → TC-LOG-001
- AC-009: `npm run build` rc 0 · `npm test` 전체 통과(네이티브 테스트 포함) · SRC_HASH 핀 일치 → TC-BUILD-002, TC-HASH-001
- AC-010: 릴리스 1.7.9 — 버전 3곳·CHANGELOG·태그·GitHub 릴리스·설치 캐시 → TC-REL-001
- AC-011: 라이브 — SessionStart 빌드 산출물, 실제 프롬프트 로그 줄의 `plugin_version 1.7.9`·`client_impl native`, 래퍼 끝에서 끝 5회 중앙값 ≤ 40ms → TC-E2E-001
- AC-012: npm 발행 — 타르볼이 플러그인 런타임 파일만 담는다(hooks.json·plugin.json 이 가리키는 경로 전부·`bin`·`main`·네이티브 소스 포함, 개발·QA·작업 공간 파일 제외), 레지스트리 `memory-bank@1.7.9` 의 `gitHead` 가 발행 커밋 → TC-REL-002

## 공통 전제 조건

- `npm run build` 뒤 `dist/` 가 소스와 같다(JS 클라이언트·데몬·테스트가 `dist/` 를 읽는다).
- 네이티브 테스트는 이 기계에 cargo 가 있을 때 돈다(`/opt/homebrew/bin/cargo`). cargo 가 없으면 `describe.skipIf` 로 건너뛰되 콘솔에 사유를 남긴다 — 이 저장소의 QA 는 cargo 가 있는 기계에서만 PASS 를 선언한다.
- 가짜 데몬 소켓은 `/tmp/mbsk-*` 처럼 짧은 경로(unix 소켓 104바이트 한계). 테스트의 index 디렉터리는 `MEMORY_BANK_CONFIG_DIR` 로 격리한다.
- 라이브 항목(TC-E2E-001·TC-REL-001)은 사용자 디렉터리(`~/.config/superpowers/conversation-index`)와 GitHub 릴리스를 읽는다 — 로그 전문은 `.qa-artifacts/` 에 저장하고 세션 id 는 출력하지 않는다.

## 레벨1 시나리오 (TC-*)

### NAT: 네이티브 클라이언트 패리티

#### TC-NAT-001: 웜 경로 4경우가 JS 클라이언트와 같다
**심각도**: CRITICAL
- Given: 가짜 데몬(헬퍼 `test/helpers/fake-inject-daemon.ts`) (a) 즉시 `{ok:true, context, ledger_keys}` (b) `{warming:true}` 뒤 `ok` (c) `{ok:false}` (d) 요청을 받고 연결을 끊음; 같은 봉투(prompt·cwd·session_id·transcript_path)
- When: JS 클라이언트(`node scripts/inject-context.js`)와 네이티브 바이너리를 각각 같은 `MEMORY_BANK_CONFIG_DIR` 아래 돌린다(폴백은 `MEMORY_BANK_NATIVE_TEST_NO_FALLBACK=1` 로 node 실행 대신 사유만 stderr 에 적게 해서 비교)
- Then: (a)(b) stdout 바이트 동일(`context + "\n"`), 원장 파일 `state/inject-ledger/<sid>.json` 내용 동일(키 순서 포함) · (c)(d) stdout 비어 있고 폴백 사유가 `daemon-error`·`daemon-closed` 로 JS 와 같다 · 데몬이 받은 요청 JSON 의 키 집합이 같다(`prompt, cwd, session_id, client, entrypoint, req_id, client_impl`)
- verify: `npx vitest run test/native-inject-client.test.ts -t "AC-001"` / evidence: 테스트 이름

#### TC-NAT-002: 프롬프트 게이트 패리티
**심각도**: CRITICAL
- Given: 게이트 입력 11종(작업 알림·슬래시 명령 인자 있음/없음/짧음·system-reminder 뒤 본문/닫히지 않음·local-command·cross-session·teammate·짧은 프롬프트·빈 입력·Codex 봉투)
- When: 두 클라이언트를 같은 입력으로 실행(데몬 없음)
- Then: skipped 입력은 stdout 비어 있고 로그 줄의 `status/reason/via/client/has_session/project/prompt_len` 이 같다; 검색 대상 입력(슬래시 인자·reminder 뒤 본문)은 데몬에 보낸 `prompt` 가 JS 와 같다(원문 그대로 — 게이트는 판정만, 검색 질의 추출은 데몬 쪽 `computeInjectResult` 가 한다)
- verify: `npx vitest run test/native-inject-client.test.ts -t "AC-002"` + `cargo test`(gate 단위 시험 — JS 테스트 입력 재사용) / evidence: 테스트 이름

#### TC-NAT-003: 데몬 실패 → node 폴백 실행
**심각도**: CRITICAL
- Given: 데몬 없음(소켓 파일 없음), `PATH` 에 가짜 `node`(받은 env·stdin 을 파일에 기록)
- When: 네이티브 바이너리 실행
- Then: 가짜 node 가 `<root>/scripts/inject-context.js` 를 인자로 받고 env 에 `MEMORY_BANK_INJECT_DAEMON_FAILED=no-daemon`·`MEMORY_BANK_INJECT_REQ_ID=<네이티브가 만든 id>` 가 있으며 stdin 원문이 바이트 그대로 전달된다; `PATH` 에 node 가 없으면 stderr 1줄(`inject-client: node not found — …`) + exit 0 + stdout 비어 있음
- verify: `npx vitest run test/native-inject-client.test.ts -t "AC-003"` / evidence: 테스트 이름

### WRAP·BUILD: 래퍼와 빌드

#### TC-WRAP-001: 래퍼의 바이너리 선택 규칙
**심각도**: HIGH
- Given: `MEMORY_BANK_NATIVE_CLIENT` 로 가짜 바이너리(stdout 에 `NATIVE` 를 쓰는 셸 스크립트) 지정, 옆에 `.srchash`
- When: `bash hooks/inject-context.sh`(등록된 명령 문자열 그대로) 를 ① 해시 일치 ② 해시 불일치 ③ 파일 없음 ④ 실행 권한 없음 으로 실행
- Then: ① stdout `NATIVE` ② ③ ④ node 경로 실행(가짜 node 가 `NODE` 출력) — 넷 모두 exit 0
- verify: `npx vitest run test/inject-hook-wrapper.test.ts` / evidence: 테스트 이름

#### TC-BUILD-001: SessionStart 빌드 스크립트 세 경우
**심각도**: HIGH
- Given: `scripts/build-native-client.sh`, 격리 `MEMORY_BANK_CONFIG_DIR`
- When: ① `PATH` 에 cargo 없음(+ `CARGO_HOME` 비움) ② 바이너리·`.srchash` 가 이미 `SRC_HASH` 와 같음 ③ `.srchash` 가 다름(가짜 cargo 가 바이너리 파일을 만든다)
- Then: ① stderr "cargo 없음 — node 경로 유지", exit 0, 파일 변화 없음 ② exit 0, 로그 1줄 "up to date", 파일 mtime 불변 ③ `<indexDir>/bin/memory-bank-inject-client` 와 `.srchash` 가 교체(임시 이름 → rename), `logs/native-build.log` 에 1줄
- verify: `npx vitest run test/build-native-client.test.ts` / evidence: 테스트 이름

#### TC-HASH-001: SRC_HASH 핀
**심각도**: HIGH
- Given: `native/inject-client/SRC_HASH`(커밋), `scripts/native-src-hash.mjs`
- When: 해시 계산 스크립트 실행
- Then: 출력 16자가 커밋된 값과 같다(다르면 소스를 바꾸고 핀을 안 올린 것 — 실패)
- verify: `npx vitest run test/native-src-hash.test.ts` / evidence: 테스트 이름

#### TC-BUILD-002: 빌드·전체 테스트
**심각도**: CRITICAL
- 단계: `npm run build > .qa-artifacts/build.log 2>&1` → `npm test > .qa-artifacts/test.log 2>&1`
- 기대: 두 rc 0, 실패 테스트 0, 네이티브 테스트가 skip 이 아니라 실행됨(로그에 "cargo 없음" 없음)
- 증거: 두 로그

### PERF·MMAP·LOG

#### TC-PERF-001: 네이티브 끝에서 끝 지연
**심각도**: HIGH
- Given: 즉시 응답 가짜 데몬, 20자 이상 프롬프트
- When: 네이티브·JS 각 7회 실행, 벽시계 측정
- Then: 네이티브 중앙값 ≤ 25ms, JS 중앙값의 절반 미만(두 수치 출력)
- verify: `npx vitest run test/native-inject-client.test.ts -t "AC-005"` / evidence: 테스트 출력 두 숫자

#### TC-MMAP-001: 검색 연결 mmap
**심각도**: HIGH
- Given: 임시 DB(`MEMORY_BANK_DB_PATH`)
- When: `getSearchDb()` 뒤 `PRAGMA mmap_size` 조회 — env 없음 / `MEMORY_BANK_SQLITE_MMAP_BYTES=0` / `=abc`
- Then: 268435456 / 0 / 268435456 + stderr 1줄; 쓰기 연결(`initDatabase` 직접)은 건드리지 않음(기본 0 그대로)
- verify: `npx vitest run test/search-perf-guards.test.ts -t "mmap"` / evidence: 테스트 이름

#### TC-LOG-001: client_impl 로그 필드
**심각도**: MEDIUM
- Given: 실제 데몬(`startInjectDaemon`, computeInjectResult 모킹)
- When: 요청에 `client_impl: "native"` / `"node"` / `"other"` / 없음
- Then: computeInjectResult 가 받은 meta 가 `native` / `node` / undefined / undefined 이고 JS 클라이언트는 `client_impl: "node"` 를 보낸다
- verify: `npx vitest run test/inject-daemon-protocol.test.ts -t "client_impl"` / evidence: 테스트 이름

### REL: 릴리스

#### TC-REL-001: 릴리스 표면 1.7.9
**심각도**: HIGH
- 단계: `git show HEAD:package.json`·`.claude-plugin/plugin.json`·`.claude-plugin/marketplace.json` 버전 → CHANGELOG `## [1.7.9]` → `git tag v1.7.9` 존재 → `gh release view v1.7.9` → `ls ~/.claude/plugins/cache/memory-bank-dev/memory-bank/1.7.9`
- 기대: 전부 1.7.9, 릴리스 노트에 네이티브 클라이언트·mmap·`client_impl`
- 증거: 명령 출력 `.qa-artifacts/release-1.7.9.log`

#### TC-REL-002: npm 타르볼 내용
**심각도**: HIGH
- Given: `package.json` 의 `files` 화이트리스트 + `publishConfig.access=public`, `.npmignore` 의 `/src/`(깊이 고정)
- When: 테스트가 저장소 루트에서 `npm pack --dry-run --json --ignore-scripts` 를 돌려 파일 목록을 읽는다(작업 트리의 추적되지 않은 로컬 파일도 같은 규칙으로 걸러진다)
- Then: hooks.json·plugin.json 이 `${CLAUDE_PLUGIN_ROOT}/` 로 가리키는 파일 전부(8개 이상), `bin` 4개·`main` 대상, `native/inject-client/{Cargo.toml,Cargo.lock,SRC_HASH}` 와 디스크의 `.rs` 전건이 들어 있고, `.codex/`·`.claude/`·`docs/`·`bench/`·`test/`·`src/`·`vercel/`·`.qa-*`·`CLAUDE.md`·`CODEX.md`·`marketplace.json`·`.env*` 는 없다. 압축 전 20MB 미만
- verify: `npx vitest run test/npm-pack-contents.test.ts` / evidence: 테스트 이름(3건)
- 발행 뒤(자격 있을 때): `npm view memory-bank@1.7.9 version gitHead dist.fileCount` 가 1.7.9·발행 커밋·테스트가 본 파일 수와 같다 → `.qa-artifacts/npm-publish.log`

### NEG: 금지 동작이 일어나지 않음

#### TC-NEG-001: 블록을 두 번 쓰지 않는다
**심각도**: HIGH
- Given: 데몬이 `ok` 줄을 보낸 뒤 바로 연결을 끊음(응답 전체는 한 줄로 도착)
- When: 네이티브 실행
- Then: stdout 에 블록이 정확히 한 번, 폴백(node) 실행 없음 — 응답을 전부 받은 뒤 한 번에 쓰고, 쓰기 시작 뒤에는 폴백하지 않는다
- verify: `npx vitest run test/native-inject-client.test.ts -t "NEG-001"` / evidence: 테스트 이름

#### TC-NEG-002: 옛 바이너리는 쓰지 않는다
**심각도**: HIGH
- Given: 해시가 다른 바이너리(`.srchash` 불일치) 또는 `.srchash` 파일 없음
- When: 래퍼 실행
- Then: node 경로로 간다(가짜 바이너리는 실행되지 않는다 — 실행되면 마커 파일을 만들도록 해 부재를 단언)
- verify: `npx vitest run test/inject-hook-wrapper.test.ts -t "NEG-002"` / evidence: 테스트 이름

#### TC-NEG-003: 입력이 없으면 검색하지 않는다
**심각도**: MEDIUM
- Given: stdin 비어 있음(또는 TTY), env `USER_PROMPT` 없음
- When: 네이티브 실행
- Then: exit 0, stdout 비어 있음, 로그 줄 `status: skipped, reason: empty, via: client` (JS 와 같다), 데몬 연결 없음
- verify: `npx vitest run test/native-inject-client.test.ts -t "NEG-003"` / evidence: 테스트 이름

### 저니 (E2E)

#### TC-E2E-001: 설치된 플러그인에서 실제 프롬프트 주입(라이브)
**심각도**: CRITICAL
**대상**: ① 이 기계의 설치 캐시 1.7.9(`~/.claude/plugins/cache/memory-bank-dev/memory-bank/1.7.9`) ② 배포 URL: 해당 없음(로컬 플러그인 — `post_deploy` 는 `not_applicable` + 사유)
**여정 단계**:
1. 릴리스 뒤 설치 캐시 1.7.9 디렉터리 확인 → `bash <cache>/scripts/build-native-client.sh` 를 SessionStart 와 같은 명령으로 실행 → `<indexDir>/bin/memory-bank-inject-client` + `.srchash` 생성, `logs/native-build.log` 1줄
2. 데몬이 떠 있는 상태(이 세션의 MCP 서버 1.7.9 — 없으면 `node <cache>/dist/mcp-server.js` 를 띄워 소켓 생성 확인)에서 UserPromptSubmit 봉투를 `bash <cache>/hooks/inject-context.sh` 에 5회 넣어 끝에서 끝 시간 측정 — **회차·클라이언트마다 다른 `session_id`** 로(같은 id 는 두 번째부터 dedup 되어 빈 블록이 나와 비교가 공허해진다), 블록이 비어 있지 않고 네이티브·node 바이트가 같은지 본다. 릴리즈 전에는 HEAD 체크아웃을 `<cache>` 자리에 두고 같은 단계를 돌린다(릴리즈 전 다리); 설치 캐시 다리는 릴리즈 뒤 AC-011.
3. 주입 로그 마지막 줄들에 `plugin_version 1.7.9`·`client_impl native`·`via daemon` 이 찍힌다
4. 5회 중앙값 ≤ 40ms(데몬 웜) — 네이티브 전 같은 봉투의 JS 경로 5회와 비교 수치 기록
**기대 결과**: 여정 무중단 완주, 블록 출력(또는 `no-match`)이 JS 경로와 같은 내용, 로그에 세션 id 평문 없음(`session_key` 만)
**증거**: `.qa-artifacts/e2e-live.log`

## 시나리오 요약

| 카테고리 | TC | 심각도 |
|---|---|---|
| NAT | TC-NAT-001·002·003 | CRITICAL ×3 |
| WRAP·BUILD | TC-WRAP-001·TC-BUILD-001·TC-HASH-001·TC-BUILD-002 | HIGH ×3 · CRITICAL ×1 |
| PERF·MMAP·LOG | TC-PERF-001·TC-MMAP-001·TC-LOG-001 | HIGH ×2 · MEDIUM ×1 |
| REL | TC-REL-001·TC-REL-002 | HIGH ×2 |
| NEG | TC-NEG-001·002·003 | HIGH ×2 · MEDIUM ×1 |
| E2E | TC-E2E-001 | CRITICAL |

총 15 TC — CRITICAL 5 · HIGH 8 · MEDIUM 2. E2E 1 · NEG 3.
검증 레벨 사다리: 레벨2 H-* 4건 · 레벨3 A-* 3건 (게이트 비계수)

## 테스트 실행 순서

1. 단위(구현 뒤, 로컬): TC-HASH-001 → TC-NAT-002(cargo test) → TC-NAT-001·003 → TC-NEG-001·003 → TC-WRAP-001·TC-NEG-002 → TC-BUILD-001 → TC-MMAP-001 → TC-LOG-001 → TC-PERF-001 → TC-BUILD-002
2. 릴리스: TC-REL-001
3. 라이브: TC-E2E-001

## 레벨2 휴리스틱 체크리스트 (H-*)

#### H-001: 빌드 스크립트의 메시지가 다음 행동을 알려 준다
- 등급: MEDIUM
- 확인: cargo 없음·네트워크 없음(크레이트 다운로드 실패)·빌드 실패 각각 로그 1줄에 원인과 "node 경로 유지" 가 적히고 exit 0, 바이너리는 바뀌지 않는다

#### H-002: 래퍼는 어떤 실패에도 프롬프트를 깨지 않는다
- 등급: HIGH
- 확인: 바이너리가 segfault/exit 1/무출력이어도 래퍼 exit 0; stderr 는 `inject-context.err.log` 로 가고 1MB 상한 유지

#### H-003: 문서 수치가 실측과 같다
- 등급: MEDIUM
- 확인: CHANGELOG·CLAUDE.md 의 지연 수치(끝에서 끝·KNN mmap 전후)가 `.qa-artifacts/` 의 측정 파일과 같다(측정 식별 명시)

#### H-004: 네이티브 클라이언트는 해시가 바뀌면 다음 세션에 다시 빌드된다
- 등급: MEDIUM
- 확인: 소스 한 글자를 바꿔 `SRC_HASH` 를 다시 계산하면 래퍼가 node 로 가고(옛 바이너리 미사용), 빌드 스크립트가 다시 빌드한다 — 두 단계가 같은 해시 파일을 읽는다

## 레벨3 적대 시나리오 (A-*)

#### A-001: 적대적 데몬 응답
- 등급: CRITICAL
- 확인: 응답 줄이 (a) 1MB 넘는 한 줄 (b) JSON 아님 (c) `context` 가 문자열 아님 (d) `ledger_keys` 에 비문자열 (e) `warming` 만 반복 (f) 줄바꿈 없이 바이트만 조금씩 (g) 짝 없는 서로게이트 이스케이프 — 네이티브는 JS 와 같게 (a) 그대로 전달 (b) `daemon-error` 폴백 (c) JS `String()` 처럼 문자열화해 출력 (d) 문자열 키만 원장에 (e) 첫 warming 부터 20초 뒤 `daemon-timeout` (f) 3초 뒤 `daemon-timeout` (g) `U+FFFD` 로 같은 바이트; 어느 경우도 패닉·비정상 종료 없음(exit 0)

#### A-002: 원장 파일명 주입
- 등급: HIGH
- 확인: `session_id` 가 `../../etc/x`·`a/b`·공백·3자 이하·200자 일 때 원장 파일이 index 디렉터리 밖에 생기지 않고 JS 의 `sanitizeSessionId` 와 같은 이름(또는 기록 생략)이 된다

#### A-003: 래퍼 env 로 임의 실행 유도
- 등급: HIGH
- 확인: `MEMORY_BANK_NATIVE_CLIENT` 가 디렉터리·심링크·해시 파일 없는 실행 파일을 가리킬 때 래퍼는 그것을 실행하지 않고 node 로 간다(해시 파일과 일치할 때만 실행) — 해시 파일 자체가 공격자 통제라면 바이너리도 그렇다는 점을 문서에 적는다(이 env 는 테스트용이며 사용자 계정 안의 파일만 가리킨다)

## 변경 이력

- 2026-11-02: Rust 전환 분석 권고 2(네이티브 씬 클라이언트)·4(mmap)로 새로 작성(이전 Memorilla 적용 plan 은 git 이력).

## Delta 2026-11-02 (구현 뒤 보강)

- 하네스 결함 2건을 고치고 시나리오는 그대로 유지: ① 클라이언트 실행을 `spawnSync` → 비동기 `spawn`(`runChild`) — 동기 실행은 같은 프로세스의 가짜 데몬이 답할 수 없어 TC-NAT-001~003·TC-PERF-001·TC-NEG-001·A-001·A-002 가 전부 폴백으로 끝났다(거짓 실패). ② `baseEnv` 의 환경 정리를 `extra` 적용 **앞**으로 — 뒤에 지우면 Codex 봉투 경우(TC-NAT-002 의 `USER_PROMPT`)가 두 클라이언트 모두 skipped/empty 로 끝나 비교가 공허했다.
- TC-NAT-003 의 폴백 env 이름은 `MEMORY_BANK_INJECT_DAEMON_FAILED`(계획 D1). 구조 리팩토링(`jsval.rs`·`parse` 분리·`INDEX_DIR`)으로 `SRC_HASH` 가 `c81fdeeed2288d48` 로 재고정됐고 TC-HASH-001 은 재고정 뒤 통과.
- 레벨3 A-001(e)(warming 만 반복하는 데몬)에서 네이티브·JS 둘 다 끝없이 기다리는 것을 찾아(322초 뒤 강제 종료) 두 클라이언트에 첫 warming 부터 절대 20초 기한을 넣었다(계획 D8). 패리티 테스트 'A-001 (e)' 추가 — TC 수는 그대로(기존 TC-NAT-001 블록의 경우 추가).
- 2026-11-02 npm 발행 요청: AC-012·TC-REL-002 추가(타르볼 내용 테스트). 태그 트리의 dry-run 에서 `scripts/`·네이티브 소스 누락과 개발 파일 포함을 확인한 뒤의 보강.
