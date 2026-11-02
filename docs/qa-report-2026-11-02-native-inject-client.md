# QA 보고 — 2026-11-02 네이티브 inject 클라이언트 + 검색 연결 mmap (memory-bank 1.7.9)

계획 `docs/plans/2026-11-02-native-inject-client.md` · 시나리오 `docs/qa-test-plan.md` · 커밋 `4134888`(계획) → `c59ffb5`(구현) → … → `012f4a6`(독립 반박 1라운드 반영) → `08b4a02`(2라운드 반영, 태그 `v1.7.9`). Rust 전환 분석(2026-11-02)의 권고 ②(프롬프트 훅의 얇은 클라이언트만 네이티브로)·④(검색 연결 mmap)를 구현한 결과다.

## 결과

| 측정 | 값 | 측정 식별 |
|---|---|---|
| 클라이언트 자체 비용(즉시 답하는 가짜 데몬, 7회 중앙값) | 네이티브 3.4ms · node 75.0ms | `.qa-artifacts/ac-005-timing-cited.json`(06:06Z, 단독 실행, 릴리즈 바이너리 소스 해시 `d9428017839de77b`) |
| 실데몬 끝-끝(훅 래퍼 포함, 5회 중앙값, 회차마다 다른 session_id) | 네이티브 32.5ms · node 112ms, 블록 917자 바이트 동일 | `.qa-artifacts/e2e-live-cited.json` @012f4a6(부하 평균 22) — 그 뒤 Rust 변경은 이스케이프 정리·기한 처리만, 최종 HEAD 의 재실행은 레벨1 판정(≤40ms·블록 동일)으로 `.qa-evidence.json` 에 |
| 데몬 몫(같은 실행의 주입 로그 `duration_ms`) | 중앙값 16~17ms(표본 16~24ms, node 16~21ms) | `inject-context.jsonl` 의 1.7.9 데몬 줄 |
| bash 래퍼 왕복(즉시 종료 바이너리, 교차 15쌍) | 첫 네이티브 래퍼 29.7ms → 지금 12.3ms | `.qa-artifacts/wrapper-overhead.json` |
| 프로세스 몫(끝-끝 − 데몬) | ≈15ms — 계획 목표 ≤ 10ms **미달**(D0) | 위 둘의 차 |
| mmap(워밍 뒤 9회 중앙값, LIMIT 50) | `vec_facts` 8.1 → 8.0ms · `vec_facts_kr` 7.0 → 6.7ms — **잡음 수준**, 분석 단계의 16.8 → 9.6 은 순서 효과(D7) | `.qa-artifacts/knn-mmap.json` @c780271 |

## 검증 레벨 사다리

| 레벨 | 판정 | 근거 |
|---|---|---|
| 1 기능 | PASS | `npm run build` rc 0 · dist 커밋과 동일 · `08b4a02`(2라운드 반영) 전체 재실행 vitest 82파일 927건(패리티 17·래퍼 6·빌드 5·해시 3·프로토콜 10·소켓 11·fact-text 3·live-apply 9 포함) · cargo 8/8 · TC-E2E-001 릴리즈 전 다리(HEAD 체크아웃의 실서버 1.7.9·실DB·실훅) 네이티브 30.9ms · node 107.3ms, 블록 917자 바이트 동일 PASS — `.qa-artifacts/level1-run.log` @08b4a02 |
| 2 휴리스틱 | PASS 4/4 | H-001 빌드 스크립트 메시지(cargo 없음·네트워크 실패·산출물 없음·해시 불일치 전부 exit 0 + 원인 + "node 경로 유지") · H-002 래퍼(segfault·exit 1·무출력·err.log 1MB 상한 → 훅 stdout/stderr 비움, exit 0) — 1차 FAIL: bash 의 segfault 안내가 훅 stderr 로 새어 나와 브레이스 그룹으로 err.log 에 묶음(81ff55e) · H-003 문서 수치 = 측정 파일(AC-005·mmap·래퍼·README) · H-004 해시 바뀌면 래퍼 node + 재빌드 — 1차 FAIL: `native-src-hash.mjs` 의 직접 실행 판별이 `/tmp`→`/private/tmp` 심링크 뒤에서 무출력 no-op(실제 결함) → realpath 비교 + 회귀 테스트(81ff55e) |
| 3 적대 | PASS | A-001 (a)(b)(c)(d) 패리티 테스트, (e) warming 만 반복하는 데몬 — **1차 FAIL: 두 클라이언트 모두 끝없이 매임**(JS 는 warming 마다 20초 재무장, 네이티브는 읽기마다 20초) → 첫 warming 부터 절대 20초(29b406b) → PASS · A-002 원장 파일명 주입(패리티 테스트) · A-003 래퍼 env 남용(디렉터리·심링크·해시 없음·해시 불일치 → node, 대조군만 실행) PASS · 독립 반박(harsh-critic) 1라운드 CRITICAL 0 · HIGH 2 · MEDIUM 5 · LOW 13 → 20건 전부 반영(`012f4a6`, 계획 D10) · 2라운드: 아래 "독립 반박 2라운드" |
| 4 운영 | PASS | 배포 URL 없음(로컬 플러그인) — 릴리스 표면 정렬과 설치 캐시 라이브로 대신(아래 "릴리스"): 캐시 1.7.9 의 빌드 스크립트가 빈 설정 디렉터리에서 바이너리를 7초에 빌드(`--src-hash` = `d9428017839de77b`) · 캐시의 실서버 + 캐시의 훅으로 네이티브 31.8ms · node 109.5ms, 블록 1001자 바이트 동일, 주입 로그 15줄 `plugin_version 1.7.9`·`client_impl` native 10/node 5 |

## 독립 반박이 바꾼 것 (1라운드)

HIGH 2: E2E 가 같은 session_id 로 돌려 dedup 된 빈 블록끼리 비교하던 공허 판정(회차마다 다른 id 로 바꿔 실제 917자 블록 비교) · README 의 "~3ms end to end" 가 가짜 데몬 수치(실데몬 32ms 로 분리). MEDIUM 5: 데몬 `truncateFact` 의 UTF-16 경계 절단으로 짝 없는 서로게이트가 실리면 네이티브가 콜드 폴백을 타던 패리티 결함(절단을 코드포인트 경계로 + 네이티브는 U+FFFD 로 JS 와 같은 바이트) · 폴백 줄 `client_impl: native` · AC-005 테스트의 폴더 생성 · live-apply 에 `native/` · 패리티 입력 표. LOW 13: stdin `null`·JS 공백 집합·숫자 문자열화·바이트 단위 절대 기한·`PERSONAL_SUPERPOWERS_DIR`·설치 순서·핀에 Cargo.lock·"읽기 전용" 서술·근거 없는 수치 삭제와 교차 측정·패닉 가능 `eprintln!`·폴백 예산 전달·목표 미달 명시·문서 정합.

## 독립 반박 2라운드

CRITICAL 0 · HIGH 0 · MEDIUM 2 · LOW 7(회귀 2건/9 — 직전 수정이 만든 결함 22%, 과반 아님). 종료 규칙 ①(첫 치명·높음 0 라운드)로 루프를 끝내고 9건을 한 번에 고쳤다(재비평 없음, 계획 D11). MEDIUM: 서로게이트 정리기가 `\` 뒤 비ASCII 바이트에서 패닉(1라운드 수정의 회귀 — 폴백이 아니라 블록 없는 종료, 래퍼가 err.log 로 묶어 프롬프트는 산다) → ASCII 일 때만 2바이트 복사 + 테스트 · 문서 수치가 인용 파일과 어긋남(107→112, 32.1→32.5, 11.9→12.3, AC-005 는 릴리즈 바이너리로 재측정 3.4/75.0). LOW: 쓰기 기한(3초 절대 기한을 write 앞에) · 봉투(stdin·`USER_PROMPT`)에도 정리기 · 패리티 표 기대값 열 · 원장 800 상한·한 청크·`\`+비ASCII 테스트 · "읽기 전용 연결" 서술 · 인덱스 디렉터리 우선순위를 JS·래퍼·빌드에 같게 · 보고서 수치 일치. Codex 교차 리뷰는 N/A(사용자 토글 off).

## 릴리스 (Phase 5, 2026-11-02)

- 표면 정렬: 버전 3곳(package.json·plugin.json·marketplace.json) 1.7.9 · CHANGELOG [1.7.9] · 태그 `v1.7.9` → `08b4a02` · GitHub 릴리스 공개 06:22Z(노트 = CHANGELOG 절) · npm: 사용자 요청(2026-11-02 "npm 도 릴리즈해")으로 발행 대상이 됐다 — 태그 트리의 `npm pack --dry-run` 이 훅 스크립트·네이티브 소스 누락과 개발 파일 포함을 드러내(계획 D12) `files` 화이트리스트 + `.npmignore` 고정 + TC-REL-002 테스트로 패키지 내용을 바로잡았다. 발행 자격은 `~/.npmrc` 토큰이 `GET /-/whoami` 에서 E401(환경변수·키체인·발행 자동화에 다른 자격 없음)이라 `npm publish` 는 토큰 갱신 뒤 깨끗한 worktree 에서 실행한다 — 그때까지 AC-012 의 레지스트리 절반은 `deferred`.
- 설치: `claude plugin marketplace update memory-bank-dev`(클론 `08b4a02`) → `claude plugin update memory-bank@memory-bank-dev` 1.7.7 → 1.7.9(Claude Code 재시작 뒤 적용). 캐시의 `SRC_HASH` 와 `hooks/inject-context.sh` 는 HEAD 와 바이트 동일.
- AC-011 라이브(설치 캐시에서, `.qa-artifacts/e2e-live-cache.json` 06:26Z): 첫 시도는 캐시에 `node_modules` 가 없어 `dist/mcp-server.js` 가 뜨지 않았다(ABORT) — README "Dependency self-heal (v1.4.2)" 의 알려진 동작으로, 플러그인 래퍼 `cli/mcp-server-wrapper.js` 가 첫 실행에 `npm install --prefer-offline --no-audit --no-fund` 를 돌린다. 같은 명령을 캐시에서 실행(242 패키지 9초)한 뒤 재실행 PASS: 소켓 405ms, 네이티브 31.8ms · node 109.5ms, 블록 1001자 바이트 동일, 주입 로그 15줄 전부 `plugin_version 1.7.9`, `client_impl` native 10/node 5, `via daemon`, `status injected`, session_id 평문 없음. 빌드 스크립트는 이미 같은 해시의 bin 을 보고 "up to date" 로 끝났으므로, 빈 설정 디렉터리(`MEMORY_BANK_CONFIG_DIR`)를 주어 캐시 트리만으로 처음부터 빌드되는지 따로 확인했다 — "built d9428017839de77b in 7s", 바이너리 `--src-hash` 동일.
- 증거: `.qa-evidence.json` release 단계(레벨4 PASS, AC-001~011 전부 verified, head `08b4a02`). 문서만 바꾸는 이 보고 커밋도 push 게이트 규칙(증거 head = HEAD)에 따라 레벨1~3 재실행 뒤에만 push 된다.

## 계획 이탈 (D0~D11 — 전문은 계획 문서)

D0 프로세스 몫 ≤ 10ms 미달(≈15ms, bash 기동 6.7ms 가 대부분) · D1 폴백 env `MEMORY_BANK_INJECT_DAEMON_FAILED` · D2 `MEMORY_BANK_CARGO` 시험 훅 · D3 테스트 하네스 비동기 spawn·env 정리 순서 · D4 connect 타이머 없음 · D5 구조 리팩토링(jsval·parse 분리·INDEX_DIR)과 SRC_HASH 재고정 · D6 dead_code 경고 처리 · D7 mmap 이득 잡음 수준 · D8 warming 절대 20초(JS 도 변경) · D9 테스트 빌드 위치 · D10 반박 1라운드 20건 · D11 반박 2라운드 9건(패닉 회귀 1 포함)과 SRC_HASH `d9428017839de77b`.

## 남은 한계·잔여 목록

cargo 없는 기계는 바뀌지 않는다(프리빌트 없음) · 빌드 실패 백오프 없음(SessionStart 마다 재시도) · stdin 2초 절단이 멀티바이트 경계에 걸리면 U+FFFD(JS 는 바이트 보류) · 라이브 `search_ms` p50 246ms 의 원인은 미확정(open-questions, `client_impl` 로 가른다) · mmap 은 비용이 없어 유지하되 성능 개선으로 세지 않는다.
