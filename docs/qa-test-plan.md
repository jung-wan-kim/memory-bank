# QA Test Plan — 1.9.0 공용 MCP 서버 + 세션별 중계 (2026-11-14)

범위: 로컬 MCP 서버를 "세션마다 전체 서버"에서 "공용 서버 1개(신원마다) + 세션별 중계"로 바꾸는 릴리스. 한 서버를 여러 세션이 같이 써도 프로젝트 범위·DB·환경이 섞이지 않아야 한다.
요구 소스: `docs/plans/2026-11-14-shared-mcp-server.md`(AC-001~AC-016, Spec 의 제약, Program Design 규칙 1~9) · `.requirements-lock.md`.
대상: `src/mcp-server.ts`(진입점) · `src/server-core.ts` · `src/stdio-server.ts` · `src/session-context.ts` · `src/shared-identity.ts` · `src/unix-socket.ts` · `src/socket-transport.ts` · `src/shared-server-core.ts` · `src/shared-server.ts` · `src/relay.ts` · `src/inject-daemon.ts` · 릴리스 1.9.0.
실행 표면: MCP 서버(stdio — 실행기 → 중계 → 유닉스 소켓 → 공용 서버), UserPromptSubmit 훅이 쓰는 주입 소켓. 화면 변경 없음(웹 UI 서버는 이번 변경 밖).
이전 plan(1.8.0 전수 감사)은 git 이력(`46f2663`)에 있다.
이 plan 은 계획 확정 직후, 구현 전에 썼다 — 각 TC 의 테스트 파일은 구현과 함께(실패를 먼저 확인하고) 쓴다. 시나리오 변경은 요구가 바뀔 때만.

## 수용 기준 매핑 (AC Coverage)

- AC-001: 서버 환경이 같은 세션 3개(작업 폴더는 서로 다름)가 공용 서버 1개에 붙는다. 8개를 동시에 시작해도 서버는 1개이고 0이 아닌 코드로 끝나는 중계가 없다 → TC-RELAY-001, TC-RELAY-005, TC-SRV-002, TC-E2E-001
- AC-002: 프로젝트 A·B 세션이 한 서버를 동시에 쓸 때 `project` 인자 없는 `search_facts`·`list_tags`·`trace_fact`·`cross_project_insights` 가 각자 프로젝트 + 공용 사실만 쓴다(교차 0건, 번갈아 50회). 프로젝트 기본값 5곳은 전부 한 도우미를 거친다 → TC-SCOPE-001, TC-SCOPE-002
- AC-003: 작업 폴더 선언이 없거나 빈 문자열·상대 경로이거나, 신원이 다르거나, 첫 줄 형식이 틀린 접속은 거부된다. `cwd: null` 은 접속되지만 프로젝트 기본값을 쓰는 호출만 오류로 답한다 → TC-SRV-001, TC-SCOPE-002, TC-NEG-002
- AC-004: 공용 서버에서 닿는 모듈 전체에 `process.cwd(` · `process.chdir(` 가 0건이다 → TC-SCOPE-003
- AC-005: 공용 서버에서 닿는 모듈이 읽는 환경변수 이름은 전부 서버 환경 허용 목록에 있다. 서버는 허용 목록 환경만 받고, 허용 목록 값이 다른 세션은 다른 서버를 쓴다 → TC-ENV-001, TC-ENV-002, TC-NEG-002
- AC-006: 프롬프트 주입 요청에 `cwd` 가 없거나 비었거나 상대 경로면 `{ok:false}` 로 답한다 → TC-SCOPE-004
- AC-007: 접속이 0인 채 유휴 시간이 지나면 공용 서버가 끝나고 소켓·pid 파일이 사라진다(훅 요청은 그 시간을 늘리지 않는다). 자기 소켓 이름을 잃은 서버는 접속 0에서 끝나고 후임의 소켓 파일을 지우지 않는다 → TC-SRV-003, TC-SRV-004
- AC-008: 공용 서버가 강제 종료되면 중계가 다시 붙어 다음 호출이 성공하고, 진행 중이던 요청은 JSON-RPC 오류로 끝난다. 답을 받지 못한 `initialize` 는 오류 없이 새 서버의 답을 받는다 → TC-RELAY-002, TC-E2E-001
- AC-009: 디스크의 플러그인 버전이 바뀌면 새 중계가 새 버전 서버를 쓰고, 옛 서버는 접속 0에서 끝난다 → TC-UPD-002, TC-SRV-005
- AC-010: 1.8.0 실행기 원문이 새 `dist` 를 띄워도 `initialize`·도구 호출·버전 교체가 동작한다. 이 브랜치의 실행기는 그 원문과 바이트 단위로 같다 → TC-UPD-001
- AC-011: 공용 서버를 쓸 수 없는 조건(소켓 경로 초과, `MEMORY_BANK_SHARED_SERVER=0`, 끄기 파일)에서는 세션별 서버 방식으로 동작하고 stderr 에 그 사실을 한 줄로 적는다. 공용 서버 프로세스는 뜨지 않고 범위 규칙은 같다 → TC-RELAY-004, TC-ENV-003
- AC-012: 공용 서버를 띄우지 못하면 조용히 다른 방식으로 넘어가지 않는다 — 막 시작한 중계는 0이 아닌 코드로 끝나고, 오래 산 중계는 끝나지 않고 요청마다 JSON-RPC 오류로 답하다가 서버가 다시 뜨면 다음 호출이 성공한다 → TC-NEG-001
- AC-013: 응답하지 않는 서버가 이름을 쥐고 있으면, 중계는 기한 뒤 그 서버(pid 파일 + 명령줄 확인)를 끝내고 새 서버를 띄워 붙는다 → TC-RELAY-003
- AC-014: 빌드와 기존 테스트 전건이 통과하고, 테스트가 끝난 뒤 이 저장소 경로의 서버·중계 프로세스가 남지 않는다 → TC-BUILD-001, TC-NEG-003
- AC-015: 버전 표기 3곳과 CHANGELOG 가 1.9.0 으로 일치하고, 문서가 새 구조와 기본값 문구를 반영한다 → TC-REL-001
- AC-016: 이 Mac 에 설치한 뒤 — 공용 서버 수 = 신원 수, 로컬 memory-bank 프로세스 메모리 합계가 설치 전보다 줄고, 서로 다른 프로젝트의 실제 세션 2개에서 `search_facts` 기본 호출의 `Project` 표기가 각자 폴더다 → TC-E2E-001

## 공통 전제 조건

- `npm run build` 뒤 `dist/` 가 소스와 같다(`npm test` 의 pretest 가 확인한다).
- 테스트는 `test/setup.ts` 가 정한 임시 설정 폴더에서만 돈다. 실제 대화 DB 경로를 열려 하면 `src/test-guard.ts` 가 막는다. `test/setup.ts` 의 기본값은 `MEMORY_BANK_SHARED_SERVER=0`(세션별 서버 방식)이고, 공용 방식 테스트만 `test/helpers/shared-harness.ts` 로 짧은 설정 폴더(소켓 경로 한도 안)와 짧은 유휴 시간을 써서 켠다.
- 공용 방식 테스트가 띄운 서버는 테스트가 끝날 때 끝낸다(유휴 종료를 기다리거나 하네스가 pid 로 끝낸다). 스위트 뒤 잔존 프로세스 0 이 TC-BUILD-001 의 일부다.
- LLM 호출은 닫힌 포트(`ANTHROPIC_BASE_URL=http://127.0.0.1:9`)로 막혀 있다. 실제 호출·과금 없음.
- 라이브 항목(TC-E2E-001 의 설치본 다리, TC-REL-001 의 릴리스 확인)은 릴리스 뒤 이 Mac 의 설치 폴더와 떠 있는 프로세스를 읽는다. 환경변수 값·사실 문장은 출력하지 않는다(이름·건수·해시 앞자리만).

## 레벨1 시나리오 (TC-*)

### SCOPE: 프로젝트 범위

#### TC-SCOPE-001: 두 세션이 한 서버를 써도 기본 범위가 섞이지 않는다
**심각도**: CRITICAL
- Given: 한 설정 폴더의 DB 에 프로젝트 A 전용 사실, 프로젝트 B 전용 사실, 공용 사실이 각각 들어 있다. 공용 서버 1개에 접속 2개 — hello 의 `cwd` 는 A, B
- When: 두 접속이 `project` 인자 없이 `search_facts`·`list_tags`·`trace_fact`·`cross_project_insights` 를 번갈아 50회 부른다(동시에 겹치게)
- Then: A 접속의 답에는 B 전용 사실이 0건, B 접속의 답에는 A 전용 사실이 0건, 공용 사실은 양쪽에 나온다. `search_facts` 답의 `Project` 표기는 각자 폴더다. `project` 를 명시한 호출은 그 값대로 나온다
- verify: `npx vitest run test/shared-server-scope.test.ts` / evidence: 테스트 이름과 교차 건수 0

#### TC-SCOPE-002: 프로젝트 기본값은 한 도우미에서만 나오고, 작업 폴더를 모르면 그 호출만 실패한다
**심각도**: CRITICAL
- Given: `sessionProject(ctx, explicit)` 와 `server-core.ts` 원문
- When: `ctx.cwd` 가 절대 경로 / `null` 인 두 경우로 호출, 원문에서 기본값 자리를 센다
- Then: 명시 값이 비어 있지 않은 문자열이면 그 값, 아니면 `ctx.cwd`. `cwd` 가 `null` 이면 오류(메시지에 `project` 를 넘기라는 안내)이고 빈 문자열·`null` 을 돌려주는 경로가 없다. `server-core.ts` 의 기본값 5곳(`search_facts`·`list_tags`·`ask_avatar`·`trace_fact`·`cross_project_insights`)이 전부 `sessionProject(` 를 쓰고 `process.cwd` 는 0건. `cwd: null` 접속에서 범위 없는 도구(`graph_stats`)와 `project` 를 준 `search_facts` 는 동작한다
- verify: `npx vitest run test/session-context.test.ts` 와 `npx vitest run test/shared-server-scope.test.ts -t "TC-SCOPE-002"` / evidence: 테스트 이름

#### TC-SCOPE-003: 공용 서버에서 닿는 모듈은 서버의 작업 폴더를 읽지 않는다
**심각도**: CRITICAL
- Given: `src/shared-server.ts`·`src/shared-server-core.ts`·`src/server-core.ts`·`src/inject-daemon.ts` 에서 import 를 따라간 모듈 전체
- When: 각 파일에서 `process.cwd(` 와 `process.chdir(` 를 찾는다
- Then: 0건. 따라간 모듈 수가 30개 이상이다(탐색이 비어서 통과하는 일이 없게). 일부러 `process.cwd()` 를 넣은 가짜 모듈 목록에서는 같은 검사가 실패한다
- verify: `npx vitest run test/server-scope-guard.test.ts -t "process.cwd"` / evidence: 테스트 이름과 모듈 수

#### TC-SCOPE-004: 주입 요청은 작업 폴더가 없으면 계산하지 않는다
**심각도**: HIGH
- Given: 주입 데몬이 소켓을 쥐고 있다
- When: `cwd` 가 없는 요청 / 빈 문자열 / 상대 경로 / 정상 절대 경로 요청을 보낸다
- Then: 앞의 셋은 `{ok:false}`(이유 포함)이고 계산 함수가 불리지 않는다. 정상 요청은 그 `cwd` 로 계산된다. 데몬 자신의 작업 폴더가 프로젝트로 쓰이는 경로가 없다
- verify: `npx vitest run test/inject-daemon-protocol.test.ts -t "cwd"` / evidence: 테스트 이름

### ENV: 서버 환경·신원·방식 판정

#### TC-ENV-001: 서버가 읽는 환경변수 이름은 전부 허용 목록에 있다
**심각도**: CRITICAL
- Given: TC-SCOPE-003 과 같은 모듈 집합
- When: `process.env.NAME`·`process.env['NAME']`·`env.NAME` 읽기를 모은다. `process.env` 를 통째로 쓰는 자리를 모은다
- Then: 모든 이름이 `isServerEnvName` 을 통과한다. 통째 사용은 등록된 자리(기본 인자)뿐이다. 허용 목록 밖 이름을 읽는 가짜 모듈에서는 검사가 실패한다
- verify: `npx vitest run test/server-scope-guard.test.ts -t "environment"` / evidence: 테스트 이름과 이름 수

#### TC-ENV-002: 서버 환경은 세션 고유 값을 싣지 않고, 값이 다르면 신원이 다르다
**심각도**: CRITICAL
- Given: 세션 환경 예시(세션 id·메시징 소켓/토큰·프로젝트 폴더·플러그인 루트·터미널 변수·셸 비밀값 포함)
- When: `serverEnvFor(env, cwd)` 와 `sharedServerIdentity()` 를 여러 조합으로 부른다
- Then: 결과에 세션 고유 이름과 허용 목록 밖 이름이 없다. 상대 경로인 설정 폴더·DB 경로는 `cwd` 기준 절대 경로로 바뀐다. 허용 목록 값 하나(예: LLM 주소, DB 경로, 로캘)가 다르면 신원이 다르고, 세션 고유 값·운영 변수(`PATH` 등)만 다르면 신원이 같다. 버전이나 코드 지문이 다르면 신원이 다르다. 소켓 이름은 `mb-shared-<버전>-<신원 8자>.sock` 이고 주입 데몬의 정리 정규식에 걸리지 않는다
- verify: `npx vitest run test/shared-identity.test.ts` / evidence: 테스트 이름

#### TC-ENV-003: 공용 서버를 쓸 수 없는 조건은 이유와 함께 세션별 방식으로 판정된다
**심각도**: HIGH
- Given: `sharedMode()` 입력 — 스위치 `MEMORY_BANK_SHARED_SERVER=0` / 끄기 파일 `<색인 폴더>/shared-server.off` / 소켓 경로가 한도를 넘는 설정 폴더 / 버전을 읽을 수 없는 루트 / `.ts` 진입(미빌드) / 작업 폴더를 못 읽었는데 상대 경로 환경이 있는 경우
- When: 각 입력으로 판정한다
- Then: 각각 `session-local` 이고 이유가 `switch-off`·`switch-off-file`·`socket-path-too-long`·`no-version`·`not-built`·`relative-path` 중 맞는 값이다. 조건이 없으면 `shared` 이고 소켓 경로·신원·서버 환경·서버 진입 파일을 준다
- verify: `npx vitest run test/shared-identity.test.ts -t "sharedMode"` / evidence: 테스트 이름

### SRV: 공용 서버

#### TC-SRV-001: 첫 줄(hello)이 맞지 않는 접속은 도구에 닿지 못한다
**심각도**: CRITICAL
- Given: 공용 서버 1개(테스트 프로세스 안에서 시작)
- When: 접속해 첫 줄로 — 형식이 틀린 JSON / `mb_relay` 없는 JSON-RPC `tools/call` / `cwd` 누락 / 빈 `cwd` / 상대 경로 `cwd` / 다른 신원 / 정상 hello — 를 보낸다
- Then: 정상 hello 만 `{ok:true, pid, version}` 을 받고 이후 `initialize`·`tools/list` 가 된다. 나머지는 `{ok:false, error}`(`bad-hello`·`bad-cwd`·`identity-mismatch`)를 받고 접속이 닫히며, 그 접속으로 보낸 `tools/call` 은 실행되지 않는다. 거절이 다른 접속에 영향을 주지 않는다
- verify: `npx vitest run test/shared-server-hello.test.ts -t "hello"` / evidence: 테스트 이름

#### TC-SRV-002: 한 이름에는 서버가 하나뿐이다
**심각도**: HIGH
- Given: 서버 1개가 소켓 이름을 쥐고 있다 / 죽은 서버가 남긴 소켓 파일만 있다
- When: 같은 신원으로 서버를 한 번 더 시작한다
- Then: 살아 있는 서버가 있으면 두 번째는 `name-taken` 으로 끝나고 첫 서버의 소켓 파일·접속은 그대로다. 죽은 파일만 있으면 정리한 뒤 뜬다. 소켓 파일 모드는 600 이고 pid 파일에 서버 pid 가 적힌다
- verify: `npx vitest run test/shared-server-hello.test.ts -t "one server"` / evidence: 테스트 이름

#### TC-SRV-003: 접속이 없는 서버는 유휴 시간 뒤 끝난다 — 훅 요청이 있어도
**심각도**: HIGH
- Given: 유휴 시간을 짧게 준 서버, 접속 1개
- When: 접속을 닫고, 유휴 시간 동안 주입 소켓으로 요청을 계속 보낸다
- Then: 유휴 시간 뒤 서버가 종료 코드 0 으로 끝나고 소켓 파일과 pid 파일이 없다. 접속이 다시 붙으면 유휴 시계가 멈춘다(끝나지 않는다)
- verify: `npx vitest run test/shared-server-hello.test.ts -t "idle"` 와 `npx vitest run test/shared-server-e2e.test.ts -t "idle"` / evidence: 테스트 이름

#### TC-SRV-004: 이름을 잃은 서버는 후임의 파일을 지우지 않고 끝난다
**심각도**: HIGH
- Given: 서버 A 가 떠 있고 접속 1개가 있다. A 의 소켓 파일을 지우고 같은 경로에 서버 B 를 띄운다
- When: A 의 자기 점검 주기가 지나고, A 의 접속을 닫는다
- Then: A 는 은퇴 상태가 되고 접속이 0이 되면 끝난다. 그 뒤에도 B 의 소켓 파일이 남아 있고 B 에 새로 접속할 수 있다
- verify: `npx vitest run test/shared-server-hello.test.ts -t "lost its name"` / evidence: 테스트 이름

#### TC-SRV-005: 디스크의 버전이나 코드가 바뀌면 서버가 은퇴한다
**심각도**: MEDIUM
- Given: 임시 플러그인 루트에서 뜬 서버(접속 1개)
- When: 그 루트의 `package.json` 버전을 바꾼다(또는 `dist` 의 파일 내용을 바꾼다) → 자기 점검 주기 경과 → 접속을 닫는다
- Then: 접속이 있는 동안에는 계속 답하고, 접속이 0이 되면 유휴 시간을 기다리지 않고 끝난다. 버전 파일을 읽을 수 없는 동안에는 은퇴하지 않는다
- verify: `npx vitest run test/shared-server-hello.test.ts -t "TC-SRV-005"` 와 `npx vitest run test/shared-server-update.test.ts -t "retire"` / evidence: 테스트 이름

### RELAY: 중계

#### TC-RELAY-001: 세션 여럿이 서버 하나를 쓴다 — 동시에 시작해도
**심각도**: CRITICAL
- Given: 같은 설정 폴더·같은 환경, 작업 폴더가 서로 다른 세션
- When: `dist/mcp-server.js` 를 3개 차례로, 그리고 8개를 동시에 띄워 각각 `initialize` → `tools/list` 를 보낸다
- Then: 전부 11개 도구를 받는다. `shared-server.js` 프로세스는 1개다. 0이 아닌 코드로 끝난 중계가 없다. 각 중계 프로세스는 DB·임베딩 모듈을 올리지 않는다(중계의 stdout 은 JSON-RPC 줄뿐)
- verify: `npx vitest run test/shared-server-e2e.test.ts -t "one shared server"` / evidence: 테스트 이름과 서버 수 1

#### TC-RELAY-002: 서버가 죽어도 세션은 이어진다
**심각도**: CRITICAL
- Given: 중계 1개가 서버에 붙어 `initialize` 를 마쳤다
- When: (a) 오래 걸리는 호출이 진행 중일 때 서버를 SIGKILL 한다 (b) 그 뒤 `tools/list` 를 보낸다 (c) 다른 실행에서, `initialize` 를 보낸 직후 답이 오기 전에 서버를 죽인다
- Then: (a) 진행 중이던 요청은 JSON-RPC 오류(`-32001`)로 끝난다 (b) 새 서버가 뜨고 `tools/list` 가 성공한다 — 클라이언트는 `initialize` 를 다시 보내지 않았다 (c) `initialize` 는 오류 없이 새 서버의 답을 한 번 받는다(답이 두 번 오지 않는다)
- verify: `npx vitest run test/shared-server-e2e.test.ts -t "reconnect"` / evidence: 테스트 이름

#### TC-RELAY-003: 응답하지 않는 서버는 끝내고 새로 띄운다
**심각도**: HIGH
- Given: 소켓 이름을 쥐고 접속은 받지만 답하지 않는 가짜 서버(명령줄에 `shared-server.js` 와 `--mb-shared=<신원8>`), pid 파일에 그 pid
- When: 중계를 띄워 `initialize` 를 보낸다(hello 기한은 테스트용으로 짧게)
- Then: 기한 뒤 가짜 서버가 끝나고, 새 서버가 떠서 `initialize` 가 성공한다. pid 파일이 명령줄이 다른 프로세스를 가리키면 그 프로세스는 끝내지 않는다
- verify: `npx vitest run test/shared-server-e2e.test.ts -t "unresponsive"` / evidence: 테스트 이름

#### TC-RELAY-004: 끄면 지금까지처럼 세션마다 서버가 돈다
**심각도**: HIGH
- Given: `MEMORY_BANK_SHARED_SERVER=0` / 끄기 파일 / 소켓 경로가 한도를 넘는 설정 폴더
- When: `dist/mcp-server.js` 를 띄워 `initialize` → `tools/list` → `project` 없는 `search_facts` 를 보낸다
- Then: 11개 도구를 받고 `search_facts` 의 `Project` 는 그 프로세스의 작업 폴더다. stderr 에 `shared server off: <이유>` 한 줄이 있다. `shared-server.js` 프로세스와 `mb-shared-*.sock` 파일이 없다. 긴 경로에서는 기존 테스트가 고정한 동작(`inject daemon off` 고지, 소켓 0개)이 그대로다
- verify: `npx vitest run test/shared-server-e2e.test.ts -t "session-local"` 와 `npx vitest run test/inject-daemon-long-socket-path.test.ts` / evidence: 테스트 이름

#### TC-RELAY-005: 세션이 끝나도 서버는 다른 세션을 위해 남는다
**심각도**: HIGH
- Given: 중계 2개가 한 서버에 붙어 있다
- When: 한 중계의 stdin 을 닫는다 / 다른 중계에 SIGTERM 을 보낸다
- Then: 두 중계 모두 종료 코드 0 으로 끝난다. 첫 중계가 끝난 뒤에도 서버는 살아 있고 남은 중계의 호출이 성공한다. 중계는 소켓 파일을 지우지 않는다
- verify: `npx vitest run test/shared-server-e2e.test.ts -t "session ends"` / evidence: 테스트 이름

### UPD: 업그레이드 경로

#### TC-UPD-001: 1.8.0 실행기가 새 dist 를 띄워도 동작한다
**심각도**: CRITICAL
- Given: 임시 플러그인 루트 — `cli/mcp-server-wrapper.js` 는 v1.8.0 원문(픽스처), `dist/` 는 이 브랜치의 빌드, `package.json`, `node_modules`
- When: 실행기를 띄워 `initialize` → `tools/list` → `tools/call` 을 보낸다
- Then: 전부 성공한다. 실행기가 npm 구조 작업을 하지 않았다(stderr 에 그 흔적 없음). `cli/mcp-server-wrapper.js` 가 픽스처와 바이트 단위로 같다
- verify: `npx vitest run test/shared-server-update.test.ts -t "1.8.0 wrapper"` / evidence: 테스트 이름

#### TC-UPD-002: 버전이 바뀌면 세션이 새 서버로 옮겨 간다
**심각도**: CRITICAL
- Given: TC-UPD-001 의 루트에서 실행기 → 중계 → 서버(버전 X)가 돌고 `initialize` 를 마쳤다
- When: 루트의 `package.json` 버전을 Y 로 바꾼다 → 실행기의 감시 주기(테스트용으로 짧게) 경과 → `tools/list` 를 보낸다
- Then: `tools/list` 가 성공한다(클라이언트는 `initialize` 를 다시 보내지 않았다). 버전 Y 이름의 소켓과 서버가 생겼고, 버전 X 서버는 접속 0이 되어 끝났다
- verify: `npx vitest run test/shared-server-update.test.ts -t "version"` / evidence: 테스트 이름

### NEG: 하면 안 되는 일이 일어나지 않는다

#### TC-NEG-001: 서버를 못 띄울 때 조용히 다른 방식으로 넘어가지 않는다
**심각도**: CRITICAL
- Given: 임시 플러그인 루트의 `dist/shared-server.js` 를 "곧바로 종료 코드 70" 인 파일로 바꿨다
- When: (a) 중계를 새로 띄워 `initialize` 를 보낸다 (b) 다른 실행에서, 정상 서버로 붙어 있던 오래 산 중계(젊은 기간을 테스트용으로 짧게)에서 서버 파일을 고장 낸 뒤 서버를 죽이고 `tools/list` 를 보낸다 → 서버 파일을 되돌리고 다시 `tools/list`
- Then: (a) 중계가 0이 아닌 코드로 끝나고 stderr 에 이유가 있다. 그 프로세스가 직접 도구에 답한 흔적(전체 서버를 자기 안에서 돈 흔적)이 없다 (b) 중계는 살아 있고 `tools/list` 는 JSON-RPC 오류로 답한다(멈추지 않는다). 되돌린 뒤의 `tools/list` 는 성공한다
- verify: `npx vitest run test/shared-server-update.test.ts -t "cannot start"` / evidence: 테스트 이름

#### TC-NEG-002: 남의 세션 값이 서버에 들어가지 않는다
**심각도**: HIGH
- Given: 중계를 세션 고유 환경(세션 id·메시징 토큰·프로젝트 폴더·임의의 셸 비밀값 `MB_TEST_SECRET`)과 함께 띄웠다
- When: 뜬 `shared-server.js` 프로세스의 환경을 조회한다(이름만)
- Then: 세션 고유 이름과 `MB_TEST_SECRET` 이 서버 환경에 없다. 허용 목록 이름(설정 폴더 등)은 있다. hello 가 거절된 접속으로 보낸 호출은 어느 것도 실행되지 않는다(TC-SRV-001 과 같은 서버에서 호출 수 0)
- verify: `npx vitest run test/shared-server-e2e.test.ts -t "server environment"` / evidence: 테스트 이름

#### TC-NEG-003: 범위 규칙이 범위 없는 도구를 건드리지 않는다
**심각도**: HIGH
- Given: stdio 로 11개 도구를 부르는 기존 테스트(`test/mcp-server-stdio.test.ts`)
- When: 같은 호출을 세션별 방식과 공용 방식 양쪽으로 돌린다
- Then: 양쪽 모두 기존 단언이 통과한다 — `read`·`search`·`search_ontology`·`graph_stats`·`explore_graph`·`tag_fact` 의 답이 이번 변경 전과 같다(프로젝트 경계가 새로 생기지 않았다)
- verify: `npx vitest run test/mcp-server-stdio.test.ts` / evidence: 테스트 이름과 두 방식의 통과 수

### BUILD·REL

#### TC-BUILD-001: 빌드·전체 테스트 통과, 남는 프로세스 없음
**심각도**: CRITICAL
- Given: 이 브랜치의 작업 폴더(자체 node_modules)
- When: `npm run build` → `npm test` → 이 저장소 경로를 명령줄에 가진 `mcp-server.js`·`shared-server.js` 프로세스 조회
- Then: 빌드 rc 0, 테스트 실패 0(dist 신선도 검사 포함), 조회 0건
- verify: `npm run build && npm test` 와 `ps` 조회 / evidence: `.qa-artifacts/v1.9.0/level1/build.log` · `unit.log` · `leftover.txt`

#### TC-REL-001: 버전·문서가 1.9.0 구조를 말한다
**심각도**: HIGH
- Given: 릴리스 커밋
- When: 버전 3곳(`package.json`·`.claude-plugin/plugin.json`·`.claude-plugin/marketplace.json`)과 `CHANGELOG.md` 를 읽고, 문서(README·README-KR·CLAUDE.md·MCP-TOOLS.md)에서 새 구조·끄는 법·환경변수를 찾는다
- Then: 버전이 전부 1.9.0, CHANGELOG 에 `[1.9.0]` 절이 있다. 문서에 공용 서버·중계·끄는 법(`MEMORY_BANK_SHARED_SERVER=0`, 끄기 파일)·새 환경변수가 있고, "프로젝트 기본값은 세션의 작업 폴더"라는 설명이 도구 설명과 어긋나지 않는다. 릴리스 뒤: 태그 `v1.9.0` 과 GitHub 릴리스가 있다
- verify: `npx vitest run test/version-consistency.test.ts test/project-profile-tools.test.ts test/mcp-tool-names.test.ts` 와 `gh release view v1.9.0` / evidence: 테스트 이름, 릴리스 URL

### E2E

#### TC-E2E-001: 설치된 모양 그대로 — 실행기에서 공용 서버까지, 죽었다 살아나고 끝날 때까지
**심각도**: CRITICAL
**대상**: ① 테스트 환경(임시 플러그인 루트 + 짧은 설정 폴더 — 레벨1) ② 이 Mac 의 설치본(릴리스·설치 뒤 재실행 — 레벨4, 배포 URL 이 없는 로컬 플러그인이라 설치본이 배포 뒤 확인이다)
**여정 단계**:
1. 실행기(`cli/mcp-server-wrapper.js`)를 작업 폴더 A·B 로 하나씩 띄운다 → 각각 `initialize` → `tools/list`(11개)
2. `shared-server.js` 프로세스가 1개인지 센다
3. 양쪽에서 `project` 없는 `search_facts` → `Project` 표기가 각자 폴더, 상대 프로젝트 전용 사실 0건
4. 서버를 강제 종료 → 양쪽에서 다시 `tools/list` → 성공(새 서버 1개)
5. 두 세션을 끝낸다(stdin 종료) → 유휴 시간 뒤 서버가 끝나고 소켓·pid 파일이 없다
6. ② 설치본 다리: 설치 뒤 떠 있는 세션들에서 — 공용 서버 수 = 신원 수, 로컬 memory-bank 프로세스 메모리 합계(top MEM 기준)가 설치 전 3.7GB 보다 작다, 서로 다른 프로젝트의 실제 세션 2개에서 `search_facts` 기본 호출의 `Project` 가 각자 폴더다
**기대 결과**: 여정 전 단계 무중단 완주. 화면이 없는 표면이라 스크린샷 비교는 해당 없음(헤드리스 — stdout JSON 과 프로세스 조회가 증거)
- verify: `npx vitest run test/shared-server-e2e.test.ts -t "journey"` 와 설치 뒤 측정 스크립트 / evidence: `.qa-artifacts/v1.9.0/level1/shared-e2e.log`, `.qa-artifacts/v1.9.0/level4/live-measure.json`

## 시나리오 요약

| 카테고리 | 시나리오 수 | CRITICAL | HIGH | MEDIUM | LOW |
|---------|-----------|----------|------|--------|-----|
| SCOPE | 4 | 3 | 1 | 0 | 0 |
| ENV | 3 | 2 | 1 | 0 | 0 |
| SRV | 5 | 1 | 3 | 1 | 0 |
| RELAY | 5 | 2 | 3 | 0 | 0 |
| UPD | 2 | 2 | 0 | 0 | 0 |
| NEG | 3 | 1 | 2 | 0 | 0 |
| BUILD·REL | 2 | 1 | 1 | 0 | 0 |
| E2E | 1 | 1 | 0 | 0 | 0 |
| **총계** | **25** | **13** | **11** | **1** | **0** |

검증 레벨 사다리: 레벨2 H-* 8건 · 레벨3 A-* 6건 (게이트 비계수)

## 테스트 실행 순서

1. BUILD (`npm run build`) — 항상 먼저
2. SCOPE · ENV (정적 가드와 순수 함수 — 서버를 띄우지 않는다)
3. SRV (테스트 프로세스 안의 공용 서버)
4. RELAY · NEG · UPD (실제 프로세스: 실행기 → 중계 → 서버)
5. 전체 스위트(`npm test`)와 잔존 프로세스 조회
6. REL (릴리스 커밋 뒤)
7. E2E (레벨1 에서 ① 테스트 환경, 릴리스·설치 뒤 ② 설치본)

## 레벨2 휴리스틱 체크리스트 (H-*)

비UI 프로젝트 판: 에러 메시지 품질 · 종료 코드 계약 · 비정상 입력 · 동시성·지연 · 상태 커버리지 · 잔존물 · 문서 일관성 · 자원 실측.

#### H-001: 실패 메시지가 원인과 다음 행동을 말하는가
- 등급: HIGH
- 확인: 세션별 방식 고지 줄, 기동 실패 stderr, hello 거절 stderr, 재접속 중 JSON-RPC 오류 메시지, `cwd` 를 모를 때의 도구 오류를 실제로 받아 읽는다 → 각 메시지에 무엇이 실패했고 사용자가 무엇을 하면 되는지(끄는 법·로그 위치·`project` 인자)가 있다. 서버 로그에는 환경변수 값이 없고 이름만 있다

#### H-002: 종료 코드가 계약대로인가
- 등급: HIGH
- 확인: 서버를 세 경우(이름이 이미 쥐어짐 / 재시도 대상 / 모듈 로드 실패)로 직접 실행해 종료 코드 76·75·70 을 본다. 중계를 세 경우(stdin 종료 / SIGTERM / 기동 실패)로 실행해 0·0·1 을 본다. 1.8.0 실행기가 각 코드를 어떻게 취급하는지(구조 작업·재기동 예산) 로그로 대조한다

#### H-003: 이상한 첫 줄·끊긴 접속에 서버가 버티는가
- 등급: HIGH
- 확인: 줄바꿈 없는 수 MB 데이터, 깨진 UTF-8, hello 반쯤 보내고 끊기, hello 뒤 곧바로 끊기, 접속만 하고 아무것도 안 보내기(100개)를 보낸 뒤 → 서버가 살아 있고 정상 접속의 호출이 성공하며 접속 수 집계가 0으로 돌아온다(유휴 종료가 막히지 않는다)

#### H-004: 한 세션의 무거운 호출이 다른 세션을 얼마나 늦추는가
- 등급: HIGH
- 확인: 접속 A 가 대화 검색을 연달아 부르는 동안 접속 B 의 `graph_stats` 와 주입 요청의 지연을 잰다(p50·p95) → 주입이 3초 예산 안에 드는 비율과 최악 지연을 기록한다. 접속 30개를 동시에 붙여 `tools/list` 가 전부 성공하는지 본다

#### H-005: 빈 상태·잠긴 상태에서 첫 호출
- 등급: MEDIUM
- 확인: DB 가 없는 새 설정 폴더에서 공용 방식 첫 호출(스키마 생성)이 두 접속에서 동시에 와도 한 번만 만들어지고 오류가 없다. 다른 프로세스가 쓰기 잠금을 쥔 동안의 호출이 오류 메시지로 끝나고 서버가 멈추지 않는다

#### H-006: 비정상 종료 뒤 남는 것
- 등급: HIGH
- 확인: 서버 SIGKILL·중계 SIGKILL·기동 도중 중계 SIGKILL 뒤 색인 폴더의 `mb-shared-*.sock`·`.pid`·`.lock` 과 프로세스를 조회한다 → 다음 세션이 그 잔존물 위에서 정상으로 뜨고(잠금이 낡은 것으로 판정된다), 죽은 소켓 파일은 다음 서버가 정리한다. 로그 파일이 1MB 를 넘으면 `.old` 로 한 번 돈다

#### H-007: 문서와 실제가 같은가
- 등급: MEDIUM
- 확인: README·CLAUDE.md·CHANGELOG 가 말하는 환경변수 이름·기본값·끄는 법을 코드의 상수와 대조하고, 문서의 끄는 법(환경변수·파일)을 실제로 해 보아 세션별 방식으로 뜨는지 확인한다. 용어(공용 서버·중계·신원)가 문서 사이에서 같은 뜻으로 쓰인다

#### H-008: 줄어든 만큼이 실제로 줄었는가
- 등급: MEDIUM
- 확인: 중계 프로세스 1개의 메모리(top MEM), 세션 N개일 때 합계를 세션별 방식과 나란히 잰다(같은 설정 폴더, 임베딩 모델을 올린 상태와 안 올린 상태) → 수치를 기록하고 중계가 DB·모델 관련 네이티브 라이브러리를 열지 않았는지 `lsof` 로 본다

## 레벨3 적대 시나리오 (A-*)

공격 표면: 색인 폴더 안의 유닉스 소켓·pid 파일·잠금 파일(같은 사용자 프로세스가 건드릴 수 있다), 분리 프로세스의 수명, 접속 첫 줄.

#### A-001: 다른 사용자·다른 프로세스가 소켓에 붙을 수 있는가
- 등급: CRITICAL
- 확인: 소켓 파일 모드가 600 이고 색인 폴더가 700 인지 실측한다(bind 직후의 짧은 틈 포함 — umask 로 만드는지 사후 chmod 인지). 같은 사용자의 임의 프로세스가 정상 hello 로 남의 폴더를 선언하는 것은 기존 신뢰 경계(같은 uid 는 DB 파일을 직접 읽을 수 있다) 안인지 문서로 확인한다

#### A-002: 신원이 다른데 같은 서버에 붙는 길이 있는가
- 등급: HIGH
- 확인: 소켓 이름의 신원 8자만 같고 전체 신원이 다른 hello, 버전만 다른 hello, 신원 칸이 숫자·배열인 hello 를 보낸다 → 전부 거절. 환경 값 하나만 다른 두 중계를 실제로 띄워 서버가 2개 뜨는지 본다

#### A-003: 서버가 뜨기 전에 그 이름을 선점하면
- 등급: HIGH
- 확인: 소켓 경로에 미리 일반 파일 / 다른 곳을 가리키는 심링크 / 답하지 않는 리스너 / 틀린 답을 하는 리스너를 놓고 중계를 띄운다 → 중계가 hello 답을 확인하기 전에는 세션의 요청 내용을 보내지 않고, 심링크가 가리키는 파일을 지우지 않으며, 무한 재시도·무한 프로세스 생성 없이 오류로 끝나거나 정리 뒤 정상으로 뜬다

#### A-004: pid 파일을 속이면 엉뚱한 프로세스를 끝내는가
- 등급: HIGH
- 확인: 답하지 않는 리스너를 놓고 pid 파일에 무관한 프로세스(테스트가 띄운 `sleep` 류)의 pid, 음수, 1, 문자열을 적는다 → 중계가 그 프로세스에 신호를 보내지 않는다

#### A-005: 기동 잠금을 쥔 채 죽거나, 수십 개가 한꺼번에 시작하면
- 등급: HIGH
- 확인: 잠금 파일을 만들고 죽은 pid 를 적어 둔다 / 살아 있는 무관한 pid 를 적어 둔다 / 중계 30개를 동시에 띄운다 → 교착 없이 서버 1개로 수렴하고, 0이 아닌 코드로 끝나는 중계가 없으며, 잠금 파일이 남지 않는다

#### A-006: 서버가 뜨자마자 계속 죽으면
- 등급: MEDIUM
- 확인: 서버가 hello 직후 매번 죽게 만든 뒤 중계를 60초 둔다 → 그동안 만들어진 서버 프로세스 수가 재시도 간격 규칙(1→2→4…30초, 연속 10회 뒤에는 요청이 올 때만)을 넘지 않고, 중계의 메모리·대기열이 계속 늘지 않는다

## 변경 이력

| 날짜 | 변경 유형 | 내용 | 사유 |
|------|----------|------|------|
| 2026-11-14 | 재작성 | 1.9.0 공용 MCP 서버 — 레벨1 25건, 레벨2 8건, 레벨3 6건 | 릴리스 범위가 바뀜(1.8.0 plan 은 git 이력 `46f2663`) |
