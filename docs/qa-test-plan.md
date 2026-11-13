# QA Test Plan — 1.9.0 공용 MCP 서버 + 세션별 중계 (2026-11-14)

범위: 로컬 MCP 서버를 "세션마다 전체 서버"에서 "공용 서버 1개(신원마다) + 세션별 중계"로 바꾸는 릴리스. 한 서버를 여러 세션이 같이 써도 프로젝트 범위·DB·환경이 섞이지 않아야 한다.
요구 소스: `docs/plans/2026-11-14-shared-mcp-server.md`(AC-001~AC-018, Spec 의 제약, Program Design 규칙 1~10) · `.requirements-lock.md`.
대상: `src/mcp-server.ts`(진입점) · `src/server-core.ts` · `src/stdio-server.ts` · `src/session-context.ts` · `src/shared-identity.ts` · `src/unix-socket.ts` · `src/socket-transport.ts` · `src/shared-server-core.ts` · `src/shared-server.ts` · `src/relay.ts` · `src/inject-daemon.ts` · 릴리스 1.9.0.
실행 표면: MCP 서버(stdio — 실행기 → 중계 → 유닉스 소켓 → 공용 서버), UserPromptSubmit 훅이 쓰는 주입 소켓. 화면 변경 없음(웹 UI 서버는 이번 변경 밖).
이전 plan(1.8.0 전수 감사)은 git 이력(`46f2663`)에 있다.
이 plan 은 계획 확정 직후, 구현 전에 썼다 — 각 TC 의 테스트 파일은 구현과 함께(실패를 먼저 확인하고) 쓴다. 시나리오 변경은 요구가 바뀔 때만. 레벨3 에서 요구가 바뀐 부분(신원 규칙, AC-017·AC-018)은 맨 아래 변경 이력에 적었다.

## 수용 기준 매핑 (AC Coverage)

- AC-001: 서버 환경이 같은 세션 3개(작업 폴더는 서로 다름)가 공용 서버 1개에 붙는다. 8개를 동시에 시작해도 서버는 1개이고 0이 아닌 코드로 끝나는 중계가 없다 → TC-RELAY-001, TC-RELAY-005, TC-SRV-002, TC-E2E-001
- AC-002: 프로젝트 A·B 세션이 한 서버를 동시에 쓸 때 `project` 인자 없는 `search_facts`·`list_tags`·`trace_fact`·`cross_project_insights` 가 각자 프로젝트 + 공용 사실만 쓴다(교차 0건, 번갈아 50회). 프로젝트 기본값 5곳은 전부 한 도우미를 거친다 → TC-SCOPE-001, TC-SCOPE-002
- AC-003: 작업 폴더 선언이 없거나 빈 문자열·상대 경로이거나, 신원이 다르거나, 첫 줄 형식이 틀린 접속은 거부된다. `cwd: null` 은 접속되지만 프로젝트 기본값을 쓰는 호출만 오류로 답한다 → TC-SRV-001, TC-SCOPE-002, TC-NEG-002
- AC-004: 공용 서버에서 닿는 모듈 전체에 `process.cwd(` · `process.chdir(` 가 0건이다 → TC-SCOPE-003
- AC-005: 공용 서버에서 닿는 모듈이 자기 프로세스에서 읽는 환경변수 이름은 전부 서버 설정 또는 운영 변수 목록에 있다. 서버 프로세스는 그 환경만 받고(세션 고유 값과 세션의 LLM 설정·로캘은 넘어가지 않는다), 서버 설정 값이 다른 세션은 다른 서버를 쓴다. LLM 설정·로캘만 다른 세션은 같은 서버를 쓴다 → TC-ENV-001, TC-ENV-002, TC-ENV-004, TC-NEG-002
- AC-006: 프롬프트 주입 요청에 `cwd` 가 없거나 비었거나 상대 경로면 `{ok:false}` 로 답한다 → TC-SCOPE-004
- AC-007: 접속이 0인 채 유휴 시간이 지나면 공용 서버가 끝나고 소켓·pid 파일이 사라진다(훅 요청은 그 시간을 늘리지 않는다). 자기 소켓 이름을 잃은 서버는 접속 0에서 끝나고 후임의 소켓 파일을 지우지 않는다 → TC-SRV-003, TC-SRV-004
- AC-008: 공용 서버가 강제 종료되면 중계가 다시 붙어 다음 호출이 성공하고, 진행 중이던 요청은 JSON-RPC 오류로 끝난다. 답을 받지 못한 `initialize` 는 오류 없이 새 서버의 답을 받는다 → TC-RELAY-002, TC-E2E-001
- AC-009: 디스크의 플러그인 버전이 바뀌면 새 중계가 새 버전 서버를 쓰고, 옛 서버는 접속 0에서 끝난다 → TC-UPD-002, TC-SRV-005
- AC-010: 1.8.0 실행기 원문이 새 `dist` 를 띄워도 `initialize`·도구 호출·버전 교체가 동작한다. 이 브랜치의 실행기는 그 원문과 바이트 단위로 같다 → TC-UPD-001
- AC-011: 공용 서버를 쓰지 않는 조건 여섯 가지(`MEMORY_BANK_SHARED_SERVER=0`, 끄기 파일, Windows, 소스 실행, 소켓 경로 초과, 작업 폴더를 모르는데 상대 경로 설정)에서는 세션별 서버 방식으로 동작하고 stderr 에 그 사유를 한 줄로 적는다. 공용 서버 프로세스는 뜨지 않고 범위 규칙은 같다. 이 밖의 사유로 세션별 방식이 되지 않는다 → TC-RELAY-004, TC-ENV-003
- AC-012: 공용 서버를 띄우지 못하면 조용히 다른 방식으로 넘어가지 않는다 — 막 시작한 중계는 0이 아닌 코드로 끝나고, 오래 산 중계는 끝나지 않고 요청마다 JSON-RPC 오류로 답하다가 서버가 다시 뜨면 다음 호출이 성공한다. 설치 결함(컴파일된 서버 파일 없음 · 버전을 읽을 수 없음)도 같다 → TC-NEG-001, TC-NEG-007
- AC-013: 응답하지 않는 서버가 이름을 쥐고 있으면, 중계는 기한 뒤 그 서버(pid 파일 + 명령줄 확인)를 끝내고 새 서버를 띄워 붙는다 → TC-RELAY-003
- AC-014: 빌드와 기존 테스트 전건이 통과하고, 테스트가 끝난 뒤 이 저장소 경로의 서버·중계 프로세스가 남지 않는다 → TC-BUILD-001, TC-NEG-003
- AC-015: 버전 표기 3곳과 CHANGELOG 가 1.9.0 으로 일치하고, 문서가 새 구조와 기본값 문구를 반영한다 → TC-REL-001 (태그·GitHub 릴리스는 레벨4 O-002)
- AC-016: 이 Mac 에 설치한 뒤 — 공용 서버 수 = 신원 수, 로컬 memory-bank 프로세스 메모리 합계가 설치 전보다 줄고, 서로 다른 프로젝트의 실제 세션 2개에서 `search_facts` 기본 호출의 `Project` 표기가 각자 폴더다 → 판정은 레벨4 O-001(설치본). 같은 성질을 테스트 환경에서 보는 것은 TC-E2E-001
- AC-017: 세션의 것은 접속이 선언한다 — 한 서버를 쓰는 두 세션의 `ask_avatar` LLM 호출은 각자 선언한 LLM 설정으로 나가고, `read`·`list_tags` 의 출력은 각자 로캘을 따르며, `read` 의 상대 경로는 호출한 세션의 작업 폴더 기준이다. 서버 설정·운영 변수·세션 고유 이름을 선언한 접속과 지원하지 않는 로캘은 거부된다. LLM 설정 가운데 넘기지 못한 것이 있는 세션은 그 이름을 선언하고, 그 세션의 `ask_avatar` 는 넘어온 나머지만으로 LLM 을 부르지 않고 그 이름을 적은 오류로 답한다(LLM 호출 0건, 다른 도구와 이웃 세션은 그대로). 서버가 읽는 모듈에 프로세스 기본 로캘 표기 · 등록되지 않은 한 인자 `path.resolve` · 등록되지 않은 프로세스 생성이 0건이다 → TC-SCOPE-005, TC-SCOPE-006, TC-ENV-004, TC-SRV-001
- AC-018: 장애가 되풀이될 때 중계가 폭주하지 않는다 — 뜨자마자 끝나는 서버는 둘째 급사부터 간격을 두고 다시 띄우고, 공용 서버가 아닌 답을 하는 리스너에는 한 번만 접속하며, 기다리는 동안 온 호출은 곧바로 오류로 답한다. 주인 없는 기동 잠금은 떠 있는 서버가 지운다 → TC-NEG-004, TC-NEG-005, TC-NEG-006

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

#### TC-SCOPE-005: 서버는 자기 프로세스의 기본값을 세션에 빌려주지 않는다
**심각도**: CRITICAL
- Given: TC-SCOPE-003 과 같은 모듈 집합(공용 서버에서 닿는 모듈 전체)
- When: ① `child_process`·`worker_threads`·`cluster` 와 LLM SDK 두 종을 들여오는 파일을 모은다 ② 인자 없는 `toLocale*()` · 인자 하나인 `localeCompare` · 인자 없는 `new Intl.*()` 를 찾는다 ③ 인자 하나인 `path.resolve(` 줄을 모은다
- Then: ① 프로세스를 띄우는 파일은 `deps-heal.ts`(npm)뿐이고 LLM SDK 는 `llm.ts` 만 들여온다. `llm.ts` 의 LLM 호출은 세션 환경을 넘기는 한 줄을, 예비 클라이언트는 호출의 환경으로 만든 옵션을 쓴다. `callHaiku` 를 부르는 서버 모듈은 `avatar-responder.ts` 뿐이고 세션 환경을 넘긴다 ② 0건이고, 로캘을 인자로 받는 호출이 13곳 이상 있다 ③ 등록된 8줄과 정확히 같다. 가짜 모듈(인자 없는 호출·자식 프로세스 import)에서는 검사가 실패한다
- verify: `npx vitest run test/server-scope-guard.test.ts -t "TC-SCOPE-005"` / evidence: 테스트 이름

#### TC-SCOPE-006: 한 서버를 쓰는 세션들이 각자의 LLM 설정·로캘·경로 기준으로 답을 받는다
**심각도**: CRITICAL
- Given: 테스트 프로세스 안의 공용 서버(실제 도구 11개). LLM SDK 는 넘겨받은 환경을 기록하는 대역. 보관 폴더에 대화 파일 하나(날짜 하나, 토큰 수 1,234,567), 사실에 `apple`·`zebra`·`äpple` 태그
- When: ① LLM 설정이 다른 두 세션이 동시에 `ask_avatar` 를 30회씩 부른다. 설정을 선언하지 않은 세션도 함께 부른다 ② 로캘이 `en-US`·`de-DE` 인 두 세션이 같은 파일을 동시에 `read` 10회, `sv-SE`·`de-DE` 세션이 `list_tags` ③ 서버 프로세스의 작업 폴더를 보관 폴더로 옮겨 놓고, 작업 폴더가 다른 세 세션(보관 폴더의 부모 · 무관한 폴더 · 모름)이 상대 경로로 `read`
- Then: ① LLM 호출 60건 전부가 부른 세션의 값을 받고 상대 세션의 값은 한 건도 없다. 선언하지 않은 세션의 호출에는 이웃 세션의 값이 없고, 서버 프로세스 환경에 세션 값이 적히지 않는다 ② 각 답의 날짜·숫자가 그 세션 로캘의 표기이고 상대 로캘 표기는 없다. 태그 순서가 두 로캘에서 다르다 ③ 부모 폴더 세션만 성공하고, 서버 폴더 기준으로만 맞는 경로는 실패하며, 무관한 폴더 세션은 `Access denied`, 작업 폴더를 모르는 세션은 절대 경로를 넘기라는 오류를 받는다(절대 경로는 성공)
- verify: `npx vitest run test/shared-server-session-env.test.ts` / evidence: 테스트 이름

### ENV: 서버 환경·신원·방식 판정

#### TC-ENV-001: 서버가 읽는 환경변수 이름은 전부 허용 목록에 있다
**심각도**: CRITICAL
- Given: TC-SCOPE-003 과 같은 모듈 집합
- When: `process.env.NAME`·`process.env['NAME']`·`env.NAME` 읽기를 모은다. `process.env` 를 통째로 쓰는 자리를 모은다. 호출의 환경(`llmEnv.NAME`) 읽기를 모은다
- Then: 프로세스에서 읽는 모든 이름이 서버 설정(`identity`) 또는 운영 변수(`passthrough`)다 — 세션의 LLM 설정(`child`)을 프로세스에서 읽는 줄은 없다. 통째 사용은 등록된 자리뿐이다. 호출의 환경에서 읽는 이름은 `llm.ts` 한 파일의 네 개이고 전부 `child` 다. 목록 밖 이름이나 세션의 LLM 설정을 프로세스에서 읽는 가짜 모듈에서는 검사가 실패한다
- verify: `npx vitest run test/server-scope-guard.test.ts -t "TC-ENV-001"` / evidence: 테스트 이름과 이름 수

#### TC-ENV-002: 서버 환경은 세션 고유 값을 싣지 않고, 값이 다르면 신원이 다르다
**심각도**: CRITICAL
- Given: 세션 환경 예시(세션 id·메시징 소켓/토큰·프로젝트 폴더·플러그인 루트·터미널 변수·셸 비밀값 포함)
- When: `serverEnvFor(env, cwd)` 와 `sharedServerIdentity()` 를 여러 조합으로 부른다
- Then: 결과에 세션 고유 이름, 세션의 LLM 설정·로캘, 목록 밖 이름이 없다. 상대 경로인 설정 폴더·DB 경로는 `cwd` 기준 절대 경로로 바뀐다. 서버 설정 값 하나(예: DB 경로, 임베딩 모델, 시간대, 프록시)가 다르면 신원이 다르고, 세션 고유 값·운영 변수(`PATH` 등)·LLM 설정·로캘만 다르면 신원이 같다. 버전이나 코드 지문이 다르면 신원이 다르다. 소켓 이름은 `mb-shared-<버전>-<신원 8자>.sock` 이고 주입 데몬의 정리 정규식에 걸리지 않는다. 주인이 죽은 기동 잠금은 1초가 지나면 고아로 판정되고, 살아 있는 프로세스의 잠금은 고아가 아니다
- verify: `npx vitest run test/shared-identity.test.ts` / evidence: 테스트 이름

#### TC-ENV-003: 공용 서버를 쓸 수 없는 조건은 이유와 함께 세션별 방식으로 판정된다
**심각도**: HIGH
- Given: `sharedMode()` 입력 — 스위치 `MEMORY_BANK_SHARED_SERVER=0` / 끄기 파일 `<색인 폴더>/shared-server.off` / Windows / `.ts` 진입(소스 실행) / 소켓 경로가 한도를 넘는 설정 폴더 / 작업 폴더를 못 읽었는데 상대 경로 환경이 있는 경우 / 그리고 설치 결함 둘: 진입 파일 옆에 서버 파일이 없는 루트, 버전을 읽을 수 없는 루트
- When: 각 입력으로 판정한다
- Then: 앞의 여섯은 `session-local` 이고 이유가 `switch-off`·`switch-off-file`·`windows`·`source-run`·`socket-path-too-long`·`relative-path` 중 맞는 값이다. 설치 결함 둘은 `session-local` 이 아니라 `broken`(`server-file-missing`·`no-version`)이다 — 단 끄기 스위치나 끄기 파일이 함께 있으면 그것이 먼저다. 조건이 없으면 `shared` 이고 소켓 경로·신원·서버 환경·서버 진입 파일을 준다
- verify: `npx vitest run test/shared-identity.test.ts -t "sharedMode"` / evidence: 테스트 이름

#### TC-ENV-004: 세션의 LLM 설정과 로캘은 접속과 함께 간다
**심각도**: CRITICAL
- Given: ① `callHaiku` 와 LLM SDK 대역(넘겨받은 옵션을 기록) ② 실제 프로세스: 같은 설정 폴더를 쓰되 LLM 계정·접속 주소·모델·클라이언트 옵션·`LANG`·`CLAUDE_CONFIG_DIR` 이 다른 두 세션 ③ 서버 소켓 이름으로 듣고 hello 를 기록하는 대역 서버 ④ API 키와, 한 값이 한도(8KB)를 넘는 추가 헤더 설정을 가진 세션
- When: ① 세션 설정을 주고/빈 설정을 주고/주지 않고 `callHaiku` 를 부른다. Agent SDK 가 실패하게 하고 API 키가 있는/없는 세션 설정으로 부른다 ② 두 세션을 띄워 초기화하고 도구를 부른다 ③ 세션 고유 값·셸 비밀값과 함께 중계를 띄운다 ④ 그 세션을 띄워 `search_facts` 와 `ask_avatar` 를 부른다
- Then: ① 세션 설정은 프로세스 환경 위에 얹혀 자식 환경으로 넘어가고 프로세스 환경에는 적히지 않는다. 빈 설정도 명시적 환경이다(이웃 세션 값 없음). 주지 않으면 환경 옵션 자체가 없다. 예비 클라이언트는 세션의 키·주소·토큰·추가 헤더로 만들어지고, 키가 없으면 만들어지지 않고 원래 오류가 돌아온다 ② 두 세션의 서버 표식이 같고 서버 프로세스는 1개이며 각자 자기 프로젝트로 답을 받는다 ③ hello 의 `env` 는 `childEnvFor()` 결과와 같고 LLM 설정 종류의 이름만 있으며 세션 id·토큰·프로젝트 폴더·`PATH`·`HOME`·설정 폴더가 없다. `locale` 은 그 세션 프로세스의 기본 로캘(`de-DE`)이다. 다 넘어갔으므로 `envMissing` 은 빈 목록이다 ④ stderr 에 넘기지 못한 설정의 이름과 "`ask_avatar` 는 오류로 답한다"가 한 줄로 나오고, 도구 11개와 `search_facts` 는 그대로 동작한다. `ask_avatar` 는 3초 안에 그 이름을 적은 오류(`isError`)로 답하고 키 값은 답에 없으며, 서버 로그에 LLM 호출 실패 기록이 없다(호출 자체를 하지 않았다)
- verify: `npx vitest run test/llm-child-env.test.ts` 와 `npx vitest run test/shared-server-e2e.test.ts -t "session settings"` / evidence: 테스트 이름

### SRV: 공용 서버

#### TC-SRV-001: 첫 줄(hello)이 맞지 않는 접속은 도구에 닿지 못한다
**심각도**: CRITICAL
- Given: 공용 서버 1개(테스트 프로세스 안에서 시작)
- When: 접속해 첫 줄로 — 형식이 틀린 JSON / `mb_relay` 없는 JSON-RPC `tools/call` / `cwd` 누락 / 빈 `cwd` / 상대 경로 `cwd` / 다른 신원 / `env`·`envMissing`·`locale` 누락 / `env` 에 LLM 설정이 아닌 이름(`PATH`·`NODE_OPTIONS`·서버 설정·세션 id·`__proto__`) / 문자열이 아닌 값·NUL·9,000바이트 값 / 목록이 아닌 `envMissing`·LLM 설정이 아닌 이름·같은 이름 두 번·`env` 에도 있는 이름 / 형식이 틀린 로캘 / 정상 hello — 를 보낸다
- Then: 정상 hello 만 `{ok:true, pid, version}` 을 받고 이후 `initialize`·`tools/list` 가 된다. 세션 설정을 실은 정상 hello 는 그 값이 그 접속의 컨텍스트에 그대로 들어가고, 넘기지 못한 설정 이름을 선언한 정상 hello 는 그 이름이 컨텍스트에 들어간다. 나머지는 `{ok:false, error}`(`bad-hello`·`bad-cwd`·`bad-env`·`identity-mismatch`)를 받고 접속이 닫히며, 그 접속으로 보낸 `tools/call` 은 실행되지 않는다. 거절이 다른 접속에 영향을 주지 않는다
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
- verify: `npx vitest run test/shared-server-e2e.test.ts -t "unresponsive"` 와 `npx vitest run test/shared-server-e2e.test.ts -t "watchdog"` / evidence: 테스트 이름

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

#### TC-NEG-004: 공용 서버가 아닌 것이 소켓 이름으로 답해도 중계가 폭주하지 않는다
**심각도**: HIGH
- Given: 서버 소켓 이름으로 듣고, 받은 줄마다 hello 답이 아닌 JSON 으로 답하며 접속 수를 세는 프로세스
- When: (a) 중계를 새로 띄워 `initialize` 를 보낸다 (b) "막 시작" 기간을 1ms 로 줄인 중계를 띄워 `tools/list` 를 보내고, 세 번째 접속을 본 직후 한 번 더 보낸다
- Then: (a) 중계가 10초 안에 코드 1 로 끝나고 stderr 에 "공용 서버가 아닌 프로세스가 소켓에서 답한다"는 이유가 있다. 접속은 정확히 1번, 도구 답 0건, 서버 프로세스 0개, 세션별 방식으로 넘어간 흔적 없음 (b) 중계는 살아 있고 호출은 `-32003` 과 그 이유로 답한다. 두 번째 호출은 다음 시도(4초 뒤)를 기다리지 않고 1.5초 안에 답한다. 처음 5초 동안 접속은 3번이다(0·1·3초)
- verify: `npx vitest run test/shared-server-e2e.test.ts -t "wrong listener"` / evidence: 테스트 이름

#### TC-NEG-005: 뜨자마자 끝나는 서버를 쉬지 않고 다시 띄우지 않는다
**심각도**: HIGH
- Given: 임시 플러그인 루트 — 서버 진입 파일을 "진짜 서버를 돌리다가 접속을 받기 시작한 지 0.6초 뒤 끝나는" 대역으로 바꿨다(표시 파일이 있는 동안만)
- When: 중계를 띄워 초기화하고 지켜본다. 세 번째 급사 뒤 표시 파일을 지운다
- Then: 첫 급사는 곧바로 다시 붙는다. 둘째 급사 뒤 중계가 "서버가 뜨자마자 계속 끝난다"고 적고, 세 번째 서버는 그로부터 1.8초 이상 뒤에, 네 번째 서버는 셋째 급사로부터 3.6초 이상 뒤에 뜬다. 네 번째 서버는 남고 `tools/list` 가 11개로 답한다. 중계는 끝나지 않았고, 서버는 모두 4개였으며, 클라이언트는 `initialize` 답을 한 번만 받았다
- verify: `npx vitest run test/shared-server-update.test.ts -t "crash loop"` / evidence: 테스트 이름

#### TC-NEG-006: 주인 없는 기동 잠금이 남아도 다음 시작이 늦지 않고, 떠 있는 서버가 치운다
**심각도**: MEDIUM
- Given: 존재하지 않는 pid 가 적힌 5초 묵은 잠금 파일
- When: (a) 서버가 없는 상태에서 중계를 띄운다 (b) 서버가 떠 있는 상태에서 같은 잠금을 다시 만든다 (c) 살아 있는 프로세스의 pid 를 적은 잠금을 만든다
- Then: (a) 중계가 잠금이 낡기를 기다리지 않고 붙고, 자기 잠금을 돌려놓는다 (b) 서버가 자기 점검 몇 번 안에(5초 이내) 잠금을 지우고 로그에 남긴다 (c) 1.2초 뒤에도 잠금이 그대로다
- verify: `npx vitest run test/shared-server-update.test.ts -t "start lock"` / evidence: 테스트 이름

#### TC-NEG-007: 설치가 깨졌을 때 말없이 세션마다 서버를 띄우지 않는다
**심각도**: CRITICAL
- Given: 임시 플러그인 루트에서 (a) `dist/shared-server.js` 를 지웠다 (b) `package.json` 에서 버전을 뺐다
- When: 각 루트의 진입 파일로 세션을 띄워 `initialize` 를 보낸다. (a) 루트에서 `MEMORY_BANK_SHARED_SERVER=0` 을 주고 한 번 더 띄운다
- Then: 두 경우 모두 코드 1 로 끝나고 stderr 가 무엇이 없는지와 끄는 스위치를 말한다. "세션별 방식으로 돈다"는 줄이 없고 도구 답이 0건이다. 스위치를 준 세션은 그 사유를 한 줄로 적고 도구 11개로 답한다
- verify: `npx vitest run test/shared-server-update.test.ts -t "incomplete install"` / evidence: 테스트 이름

### BUILD·REL

#### TC-BUILD-001: 빌드·전체 테스트 통과, 남는 프로세스 없음
**심각도**: CRITICAL
- Given: 이 브랜치의 작업 폴더(자체 node_modules)
- When: `npm run build` → `npm test` → 이 저장소 경로를 명령줄에 가진 `mcp-server.js`·`shared-server.js` 프로세스 조회
- Then: 빌드 rc 0, 테스트 실패 0(dist 신선도 검사 포함), 조회 0건
- verify: `npm run build && npm test` 와 `ps` 조회 / evidence: `.qa-artifacts/v1.9.0/level1/build.log` · `unit.log` · `leftover.json`(조회 명령·걸러 낸 조건·조회한 프로세스 수·남은 줄)

#### TC-REL-001: 버전·문서가 1.9.0 구조를 말한다
**심각도**: HIGH
- Given: 릴리스 커밋(저장소 안에서 확인할 수 있는 것만 — 태그와 GitHub 릴리스는 릴리스 뒤에야 있으므로 레벨4 O-002 가 본다)
- When: 버전 3곳(`package.json`·`.claude-plugin/plugin.json`·`.claude-plugin/marketplace.json`)과 `CHANGELOG.md` 를 읽고, 문서(README·README-KR·CLAUDE.md·MCP-TOOLS.md)에서 새 구조·끄는 법·환경변수를 찾는다
- Then: 버전이 전부 1.9.0, CHANGELOG 에 `[1.9.0]` 절이 있다. 문서에 공용 서버·중계·끄는 법(`MEMORY_BANK_SHARED_SERVER=0`, 끄기 파일)·새 환경변수가 있고, "프로젝트 기본값은 세션의 작업 폴더"라는 설명이 도구 설명과 어긋나지 않는다
- verify: `npx vitest run test/version-consistency.test.ts test/project-profile-tools.test.ts test/mcp-tool-names.test.ts` / evidence: 테스트 이름

### E2E

#### TC-E2E-001: 설치된 모양 그대로 — 실행기에서 공용 서버까지, 죽었다 살아나고 끝날 때까지
**심각도**: CRITICAL
**대상**: 테스트 환경(임시 플러그인 루트 + 짧은 설정 폴더). 이 Mac 의 설치본에서 보는 것은 레벨4 O-001 이다 — 릴리스·설치 뒤에만 실행할 수 있어 레벨1 통과 수에 넣지 않는다
**여정 단계**:
1. 실행기(`cli/mcp-server-wrapper.js`)를 작업 폴더 A·B 로 하나씩 띄운다 → 각각 `initialize` → `tools/list`(11개)
2. `shared-server.js` 프로세스가 1개인지 센다
3. 양쪽에서 `project` 없는 `search_facts` → `Project` 표기가 각자 폴더, 상대 프로젝트 전용 사실 0건
4. 서버를 강제 종료 → 양쪽에서 다시 `tools/list` → 성공(새 서버 1개)
5. 두 세션을 끝낸다(stdin 종료) → 유휴 시간 뒤 서버가 끝나고 소켓·pid 파일이 없다
**기대 결과**: 여정 전 단계 무중단 완주. 화면이 없는 표면이라 스크린샷 비교는 해당 없음(헤드리스 — stdout JSON 과 프로세스 조회가 증거)
- verify: `npx vitest run test/shared-server-e2e.test.ts -t "journey"` / evidence: `.qa-artifacts/v1.9.0/level1/shared-e2e.log`

## 시나리오 요약

| 카테고리 | 시나리오 수 | CRITICAL | HIGH | MEDIUM | LOW |
|---------|-----------|----------|------|--------|-----|
| SCOPE | 6 | 5 | 1 | 0 | 0 |
| ENV | 4 | 3 | 1 | 0 | 0 |
| SRV | 5 | 1 | 3 | 1 | 0 |
| RELAY | 5 | 2 | 3 | 0 | 0 |
| UPD | 2 | 2 | 0 | 0 | 0 |
| NEG | 7 | 2 | 4 | 1 | 0 |
| BUILD·REL | 2 | 1 | 1 | 0 | 0 |
| E2E | 1 | 1 | 0 | 0 | 0 |
| **총계** | **32** | **17** | **13** | **2** | **0** |

검증 레벨 사다리: 레벨2 H-* 8건 · 레벨3 A-* 6건 · 레벨4 O-* 2건 (게이트 비계수)

## 테스트 실행 순서

1. BUILD (`npm run build`) — 항상 먼저
2. SCOPE · ENV (정적 가드와 순수 함수 — 서버를 띄우지 않는다)
3. SRV (테스트 프로세스 안의 공용 서버)
4. RELAY · NEG · UPD (실제 프로세스: 실행기 → 중계 → 서버)
5. 전체 스위트(`npm test`)와 잔존 프로세스 조회
6. REL (릴리스 커밋 뒤 — 저장소 안의 것)
7. E2E (테스트 환경 여정)
8. 레벨4 O-* (`main` 반영 · 태그 · 릴리스 · 이 Mac 설치 뒤)

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
- 확인: 서버 SIGKILL·중계 SIGKILL·기동 도중 중계 SIGKILL 뒤 색인 폴더의 `mb-shared-*.sock`·`.pid`·`.lock` 과 프로세스를 조회한다 → 다음 세션이 그 잔존물 위에서 정상으로 뜨고(주인 없는 잠금은 다음 중계가 넘겨받고 떠 있는 서버가 지운다 — 남은 잠금이 다음 기동을 얼마나 늦추는지 잰다), 죽은 소켓 파일은 다음 서버가 정리한다. 로그 파일이 1MB 를 넘으면 `.old` 로 한 번 돈다

#### H-007: 문서와 실제가 같은가
- 등급: MEDIUM
- 확인: README·CLAUDE.md·CHANGELOG 가 말하는 환경변수 이름·기본값·끄는 법을 코드의 상수와 대조하고, 문서의 끄는 법(환경변수·파일)을 실제로 해 보아 세션별 방식으로 뜨는지 확인한다. 용어(공용 서버·중계·신원)가 문서 사이에서 같은 뜻으로 쓰인다

#### H-008: 줄어든 만큼이 실제로 줄었는가
- 등급: MEDIUM
- 확인: 중계 프로세스 1개의 메모리(`footprint` 의 물리 메모리 — `ps rss` 는 공유 페이지를 포함하고 압축분을 빼서 출렁인다), 세션 N개일 때 합계를 세션별 방식과 나란히 잰다(같은 설정 폴더, 임베딩 모델을 올린 상태와 안 올린 상태) → 수치를 기록하고, 중계가 연 파일을 `lsof` 로 모아 빈 node 프로세스가 여는 것과의 차이에 DB·모델 관련 네이티브 라이브러리가 없는지 본다(중계 전부를 본다)

## 레벨3 적대 시나리오 (A-*)

공격 표면: 색인 폴더 안의 유닉스 소켓·pid 파일·잠금 파일(같은 사용자 프로세스가 건드릴 수 있다), 분리 프로세스의 수명, 접속 첫 줄.

#### A-001: 다른 사용자·다른 프로세스가 소켓에 붙을 수 있는가
- 등급: CRITICAL
- 확인: 소켓 파일 모드가 600 이고 색인 폴더가 700 인지 실측한다(bind 직후의 짧은 틈 포함 — umask 로 만드는지 사후 chmod 인지). 같은 사용자의 임의 프로세스가 정상 hello 로 남의 폴더를 선언하는 것은 기존 신뢰 경계(같은 uid 는 DB 파일을 직접 읽을 수 있다) 안인지 문서로 확인한다

#### A-002: 신원이 다른데 같은 서버에 붙는 길이 있는가
- 등급: HIGH
- 확인: 소켓 이름의 신원 8자만 같고 전체 신원이 다른 hello, 버전만 다른 hello, 신원 칸이 숫자·배열인 hello 를 보낸다 → 전부 거절. 접속이 선언하는 세션 설정으로 서버 쪽 값을 바꾸려는 hello(`env` 에 서버 설정·`HOME`·`PATH`·`NODE_OPTIONS`·세션 id·`__proto__`, 형식이 틀리거나 지원하지 않는 `locale`, `env`·`locale` 누락)도 전부 거절이고, 올바른 hello 는 받아들여진다(대조). 서버 설정 값 하나만 다른 두 중계를 실제로 띄워 서버가 2개 뜨는지, 세션 전용 값만 다른 두 중계는 1개인지 본다

#### A-003: 서버가 뜨기 전에 그 이름을 선점하면
- 등급: HIGH
- 확인: 소켓 경로에 미리 일반 파일 / 다른 곳을 가리키는 심링크 / 답하지 않는 리스너 / 틀린 답을 하는 리스너를 놓고 중계를 띄운다 → 중계가 hello 답을 확인하기 전에는 세션의 요청 내용을 보내지 않고, 심링크가 가리키는 파일을 지우지 않으며, 무한 재시도·무한 프로세스 생성 없이 오류로 끝나거나 정리 뒤 정상으로 뜬다. 판정 기준: 25초 동안 중계가 끝나거나 오류를 말하거나 연결되는 신호가 하나는 있어야 하고(조용한 무한 대기 금지), 리스너가 받은 접속은 10번 이내, 띄운 서버 프로세스는 상한 이내다

#### A-004: pid 파일을 속이면 엉뚱한 프로세스를 끝내는가
- 등급: HIGH
- 확인: 답하지 않는 리스너를 놓고 pid 파일에 무관한 프로세스(테스트가 띄운 `sleep` 류)의 pid, 음수, 1, 문자열을 적는다 → 중계가 그 프로세스에 신호를 보내지 않는다

#### A-005: 기동 잠금을 쥔 채 죽거나, 수십 개가 한꺼번에 시작하면
- 등급: HIGH
- 확인: 잠금 파일을 만들고 죽은 pid 를 적어 둔다 / 살아 있는 무관한 pid 를 적어 둔다 / 중계 30개를 동시에 띄운다 → 교착 없이 서버 1개로 수렴하고, 0이 아닌 코드로 끝나는 중계가 없으며, 서버가 떠 있는 동안 주인 없는 잠금 파일이 남지 않는다. 살아 있는 무관한 pid 가 적힌 방금 만든 잠금은 지어내야만 생기는 상태다 — 이때 첫 연결이 얼마나 늦는지를 잰다(상한: 기동 대기 30초 + 15초)

#### A-006: 서버가 뜨자마자 계속 죽으면
- 등급: MEDIUM
- 확인: 서버가 hello 직후 매번 죽게 만든 뒤 중계를 60초 둔다 → 그동안 만들어진 서버 프로세스 수가 급사 규칙(첫 급사는 곧바로, 둘째부터 2→4→8→16→30초 대기 — 60초에 약 6번, 판정 상한 9번)을 넘지 않고, 중계의 메모리·대기열이 계속 늘지 않으며, 그동안 보낸 호출이 답(결과든 오류든)을 받고, 죽이기를 멈추면 60초 안에 호출이 다시 성공한다

## 레벨4 운영 확인 (O-*)

릴리스하고 이 Mac 에 설치한 뒤에만 실행할 수 있는 확인이다. 레벨1 의 통과 수(`.qa-cycle-passed`)에 들어가지 않고, 실행 전에는 '실행 안 함'으로 적는다.

#### O-001: 설치본 — 서버 수, 메모리, 실제 세션의 범위
- 등급: CRITICAL
- 확인: 설치 직전과 설치 뒤(떠 있던 세션의 실행기가 자식을 새 중계로 바꾼 뒤)에 로컬 memory-bank 프로세스를 같은 방법으로 센다 → ① 떠 있는 공용 서버 수 = 중계들의 환경으로 계산한 신원 수이고, 신원마다 소켓과 살아 있는 서버가 있다 ② 프로세스 메모리 합계(`top` 의 MEM)가 설치 직전보다 작고 계획 시점 기준(3.7GB)보다도 작다 — 아직 옛 전체 서버를 돌리는 세션이 남아 있으면 그 수를 함께 적는다 ③ 서로 다른 프로젝트 폴더에서 연 실제 세션 2개가 `project` 없이 부른 `search_facts` 의 도구 결과 `Project` 줄이 각자 폴더다(모델의 말이 아니라 도구 결과 원문에서 읽는다)
- evidence: `.qa-artifacts/v1.9.0/level4/pre-install.json` · `post-install.json` · `scope-checks.json` · `live-measure.json`

#### O-002: 릴리스 표면이 한 버전을 가리키는가
- 등급: HIGH
- 확인: 원격 `main` 의 커밋, 태그 `v1.9.0` 이 가리키는 커밋, GitHub 릴리스(`gh release view v1.9.0`), 이 Mac 의 마켓플레이스 사본과 설치 기록의 버전·커밋을 읽는다 → 전부 같은 커밋·1.9.0 이다
- evidence: `.qa-artifacts/v1.9.0/level4/release-surface.json`

## 변경 이력

| 날짜 | 변경 유형 | 내용 | 사유 |
|------|----------|------|------|
| 2026-11-14 | 재작성 | 1.9.0 공용 MCP 서버 — 레벨1 25건, 레벨2 8건, 레벨3 6건 | 릴리스 범위가 바뀜(1.8.0 plan 은 git 이력 `46f2663`) |
| 2026-11-14 | 추가 | TC-SCOPE-005·TC-SCOPE-006·TC-ENV-004·TC-NEG-004~007 (레벨1 32건). AC-017·AC-018 매핑 | 레벨3 에서 요구가 바뀜: ① 실제 세션 20개가 처음 신원 규칙으로 서버 7개로 갈려, 세션의 LLM 설정·로캘을 신원에서 빼고 접속이 선언하게 함 ② 적대 프로브 A-003(접속 폭주)·A-006(재기동 폭주)과 독립 반박(설치 결함의 조용한 전환, `read` 상대 경로)이 찾은 결함을 회귀 시나리오로 승격 |
| 2026-11-14 | 수정 | TC-ENV-001·002·003, TC-SRV-001 의 기대 결과 — 신원에서 LLM 설정·로캘 제외, 세션별 방식 사유 6가지와 설치 결함 구분, hello 의 `env`·`locale` 검사 | 위 ①과 같은 요구 변경 |
| 2026-11-14 | 수정 | H-006·H-008, A-002·A-003·A-005·A-006 의 확인 문구에 판정 기준을 적음 | 1회차 실행에서 기준이 문구에 없어 프로브가 과판정·오판정했다(남은 잠금, 중계가 여는 시스템 라이브러리, 접속 횟수 상한) |
| 2026-11-14 | 구조 | TC-E2E-001 의 설치본 다리와 TC-REL-001 의 태그·릴리스 확인을 레벨4 `O-001`·`O-002` 로 옮김. TC-ENV-004 에 '넘기지 못한 설정' 사례 추가 | 독립 반박 2라운드: 레벨1 통과 수가 아직 실행하지 않은 다리를 품고 있었다(같은 지적이 두 번) — 수치를 고쳐 적는 대신 실행 시점이 다른 확인을 다른 절로 나눴다. 세션의 LLM 설정을 일부만 넘긴 채 LLM 을 부르던 경로를 오류로 바꿨다 |
