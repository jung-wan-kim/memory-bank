# 공용 MCP 서버 — 세션마다 서버를 띄우지 않고, 범위가 섞이지 않는 구조 (v1.9.0)

요청(2026-11-14 `/team`): "꼬이지 않는 구조로 개편해". 앞선 대화의 권장 구조 — 서버 1개를 여러 세션이 같이 쓰고,
세션에는 작은 중계 프로세스만 남긴다 — 를 프로젝트 범위·DB·환경이 섞이지 않게 구현한다.

분류: `broad initiative` (전송 구조 변경 + 수명 관리 + 업그레이드 경로). 대상 저장소: memory-bank (이 저장소).

계획 반박 1회(수명·경쟁 / 범위·신원 / 호환·빌드 3관점) 결과를 반영한 판이다 — 바뀐 결정은 `## Deviations` 맨 위.

## Plan Summary

**Scope:** 10 단계 · 새 소스 9개 + 수정 3개 + 새 테스트 7개 + 고치는 테스트 약 8개 — complexity HIGH

**Key Deliverables**
1. 공용 서버(`dist/shared-server.js`): 신원(identity)마다 1개. 접속마다 MCP 서버 인스턴스와 작업 폴더를 따로 가진다.
2. 중계(relay): stdio ⇄ 유닉스 소켓. 서버가 없으면 띄우고, 끊기면 다시 붙는다. 실행기(`cli/mcp-server-wrapper.js`)는 고치지 않는다 — 자식이 중계로 바뀔 뿐이다.
3. 범위 규칙: 프로젝트는 **접속이 선언한 작업 폴더에서만** 나온다. 서버 자신의 `process.cwd()` 는 어디에서도 쓰지 않는다(정적 테스트로 고정).
4. 신원 규칙: 서버 프로세스가 받는 환경은 서버 자신의 설정(허용 목록)뿐이고(세션 고유 값 제외), 코드 버전 · 코드 지문 · 그 설정 값이 전부 같을 때만 한 서버를 쓴다. 세션의 것(LLM 설정·로캘)은 신원에 넣지 않고 접속이 선언한다(레벨3 실측 반영 — `## Deviations`).
5. 세션별 서버 방식 유지: 공용 서버를 쓰지 않는 조건 여섯 가지(끄기 스위치 · 끄기 파일 · Windows · 소스 실행 · 소켓 경로 초과 · 작업 폴더를 모르는데 상대 경로 설정)에서는 지금처럼 동작하고 stderr 한 줄로 알린다. 설치 결함은 이 조건이 아니다 — 실패로 끝난다.
6. 업그레이드 경로: 이미 떠 있는 1.8.0 실행기가 새 `dist/mcp-server.js` 를 띄워도 그대로 동작한다.
7. 문서 · 버전 1.9.0 · 릴리스 · 이 Mac 설치 뒤 실측.

**Domain Glossary**

| Term | Definition | Usage |
|---|---|---|
| 공용 서버 (shared server) | 임베딩 모델·DB·도구 11개를 가진 분리(detached) 프로세스. 신원마다 1개 | `src/shared-server.ts`, `src/shared-server-core.ts`, 소켓 `mb-shared-<버전>-<신원8>.sock` |
| 중계 (relay) | 세션의 stdio 와 공용 서버 소켓을 잇는 얇은 프로세스. DB·모델을 올리지 않는다 | `src/relay.ts`, 진입 `src/mcp-server.ts` |
| 서버 환경 (server env) | 중계가 서버를 띄울 때 넘기는 환경: 허용 접두사·이름에 든 것만, 세션 고유 이름은 제외, 경로 값은 절대 경로로 | `src/shared-identity.ts` `serverEnvFor()` |
| 신원 (identity) | 한 서버를 같이 써도 되는 조건의 해시: 코드 버전 + 코드 지문 + 서버 자신의 설정(서버 코드가 직접 읽는 환경 — 운영 변수와 세션의 LLM 설정·로캘 제외) | `sharedServerIdentity()` |
| 코드 지문 (dist fingerprint) | `dist/*.js` 내용의 sha256. 버전 문자열이 같아도 코드가 다르면 다른 서버 | `distFingerprint()` |
| 작업 폴더 선언 (hello cwd) | 중계가 접속 첫 줄에 보내는 자기 `process.cwd()`(절대 경로) 또는 읽지 못했음을 뜻하는 `null` | `SessionContext.cwd`, `validSessionCwd()` |
| 세션별 서버 방식 (session-local) | 1.8.0 까지의 구조: stdio 프로세스가 직접 전체 서버를 돈다 | `src/stdio-server.ts` |
| 감독자 | 중계의 부모 프로세스(실행기). 자식이 10초 안에 죽으면 npm 구조 작업을 하고, 버전이 바뀌면 자식을 바꾼다 | `cli/mcp-server-wrapper.js` (변경 없음) |

**Acceptance Criteria**

- AC-001: 서버 환경이 같은 세션 3개(작업 폴더는 서로 다름)가 공용 서버 1개에 붙는다. 8개를 동시에 시작해도 서버는 1개이고 0이 아닌 코드로 끝나는 중계가 없다.
  - verify: `npx vitest run test/shared-server-e2e.test.ts -t "one shared server"` → exit 0
  - evidence: `.qa-artifacts/v1.9.0/level1/shared-e2e.log`
- AC-002: 프로젝트 A·B 세션이 한 서버를 동시에 쓸 때, `project` 인자 없는 `search_facts`·`list_tags`·`trace_fact`·`cross_project_insights` 가 각자 프로젝트 + 공용 사실만 쓴다(교차 0건, 번갈아 50회). 프로젝트 기본값 5곳(`ask_avatar` 포함)은 전부 한 도우미(`sessionProject`)를 거친다.
  - verify: `npx vitest run test/shared-server-scope.test.ts` → exit 0
  - evidence: 같은 폴더 `shared-scope.log`
- AC-003: 작업 폴더 선언이 없거나 빈 문자열·상대 경로이거나, 신원이 다르거나, 첫 줄 형식이 틀린 접속은 거부된다(도구 호출에 도달하지 못한다). `cwd: null`(작업 폴더를 읽지 못한 세션)은 접속되지만 프로젝트 기본값을 쓰는 호출만 오류로 답하고 `project` 를 준 호출과 범위 없는 도구는 동작한다.
  - verify: `npx vitest run test/shared-server-hello.test.ts` → exit 0
  - evidence: `shared-hello.log`
- AC-004: 공용 서버에서 닿는 모듈 전체에 `process.cwd(` · `process.chdir(` 가 0건이다.
  - verify: `npx vitest run test/server-scope-guard.test.ts -t "process.cwd"` → exit 0
  - evidence: `scope-guard.log`
- AC-005: 공용 서버에서 닿는 모듈이 자기 프로세스에서 읽는 환경변수 이름은 전부 서버 설정(신원) 또는 운영 변수 목록에 있다. 서버 프로세스는 그 환경만 받고(세션 id·메시징 소켓·프로젝트 폴더 같은 세션 고유 값과 세션의 LLM 설정·로캘은 넘어가지 않는다), 서버 설정 값이 다른 세션은 다른 서버를 쓴다. LLM 설정·로캘만 다른 세션은 같은 서버를 쓴다.
  - verify: `npx vitest run test/server-scope-guard.test.ts -t "TC-ENV-001"` 와 `npx vitest run test/shared-identity.test.ts` → 둘 다 exit 0
  - evidence: `scope-guard.log`, `shared-identity.log`
- AC-006: 프롬프트 주입 요청에 `cwd` 가 없거나 비었거나 상대 경로면 `{ok:false}` 로 답한다(서버 폴더로 대체하지 않는다).
  - verify: `npx vitest run test/inject-daemon-protocol.test.ts -t "cwd"` → exit 0
  - evidence: `inject-protocol.log`
- AC-007: 접속이 0인 채 유휴 시간이 지나면 공용 서버가 끝나고 소켓·pid 파일이 사라진다(훅 요청은 그 시간을 늘리지 않는다). 자기 소켓 이름을 잃은 서버는 접속 0에서 끝나고 후임의 소켓 파일을 지우지 않는다.
  - verify: `npx vitest run test/shared-server-e2e.test.ts -t "idle"` 와 `npx vitest run test/shared-server-hello.test.ts -t "lost its name"` → exit 0
  - evidence: `shared-e2e.log`, `shared-hello.log`
- AC-008: 공용 서버가 강제 종료되면 중계가 다시 붙어(핸드셰이크 재생) 다음 호출이 성공하고, 진행 중이던 요청은 JSON-RPC 오류로 끝난다. 답을 받지 못한 `initialize` 는 오류 없이 새 서버의 답을 받는다.
  - verify: `npx vitest run test/shared-server-e2e.test.ts -t "reconnect"` → exit 0
  - evidence: `shared-e2e.log`
- AC-009: 디스크의 플러그인 버전이 바뀌면(실행기가 자식을 바꾼다) 새 중계가 새 버전 서버를 쓰고, 옛 서버는 접속 0에서 끝난다.
  - verify: `npx vitest run test/shared-server-update.test.ts -t "version"` → exit 0
  - evidence: `shared-update.log`
- AC-010: 1.8.0 실행기 원문(픽스처)이 새 `dist` 를 띄워도 `initialize`·도구 호출·버전 교체가 동작한다. 이 브랜치의 실행기는 그 원문과 바이트 단위로 같다.
  - verify: `npx vitest run test/shared-server-update.test.ts -t "1.8.0 wrapper"` → exit 0
  - evidence: `shared-update.log`
- AC-011: 공용 서버를 쓰지 않는 조건 여섯 가지(`MEMORY_BANK_SHARED_SERVER=0`, 끄기 파일, Windows, 소스 실행, 소켓 경로 초과, 작업 폴더를 모르는데 상대 경로 설정)에서는 세션별 서버 방식으로 동작하고 stderr 에 그 사유를 한 줄로 적는다. 공용 서버 프로세스는 뜨지 않고 범위 규칙은 같다. 이 밖의 사유로 세션별 방식이 되지 않는다.
  - verify: `npx vitest run test/shared-server-e2e.test.ts -t "session-local"` 와 `npx vitest run test/inject-daemon-long-socket-path.test.ts` 와 `npx vitest run test/shared-identity.test.ts -t "sharedMode"` → 전부 exit 0
  - evidence: `shared-e2e.log`, `long-socket.log`
- AC-012: 공용 서버를 띄우지 못하면 조용히 다른 방식으로 넘어가지 않는다 — 막 시작한 중계는 0이 아닌 코드로 끝나고(감독자의 구조 작업 대상), 오래 산 중계는 끝나지 않고 요청마다 JSON-RPC 오류로 답하다가 서버가 다시 뜨면 다음 호출이 성공한다. 설치 결함(컴파일된 서버 파일 없음 · 버전을 읽을 수 없음)도 같다 — 진입점이 무엇이 없는지 적고 0이 아닌 코드로 끝나며, 끄기 스위치를 준 세션만 세션별 방식으로 돈다.
  - verify: `npx vitest run test/shared-server-update.test.ts -t "cannot start"` 와 `npx vitest run test/shared-server-update.test.ts -t "incomplete install"` → 둘 다 exit 0
  - evidence: `shared-e2e.log`
- AC-013: 응답하지 않는 서버가 이름을 쥐고 있으면, 중계는 기한 뒤 그 서버(pid 파일 + 명령줄 확인)를 끝내고 새 서버를 띄워 붙는다.
  - verify: `npx vitest run test/shared-server-e2e.test.ts -t "unresponsive"` 와 `npx vitest run test/shared-server-e2e.test.ts -t "watchdog"` → 둘 다 exit 0
  - evidence: `shared-e2e.log`
- AC-014: 빌드와 기존 테스트 전건이 통과하고, 테스트가 끝난 뒤 이 저장소 경로의 서버·중계 프로세스가 남지 않는다.
  - verify: `npm run build` → exit 0, `npm test` → exit 0 (실패 0), `ps` 조회 0건
  - evidence: `.qa-artifacts/v1.9.0/level1/build.log`, `unit.log`, `leftover.json`
- AC-015: 버전 표기 3곳과 CHANGELOG 가 1.9.0 으로 일치하고, 문서가 새 구조와 기본값 문구를 반영한다.
  - verify: `npx vitest run test/version-consistency.test.ts test/project-profile-tools.test.ts` → exit 0
  - evidence: `docs.log`
- AC-016 (운영): 이 Mac 에 설치한 뒤 — 공용 서버 수 = 신원 수, 로컬 memory-bank 프로세스 메모리 합계가 설치 전(3.7GB)보다 줄고, 서로 다른 프로젝트의 실제 세션 2개에서 `search_facts` 기본 호출의 `Project` 표기가 각자 폴더다.
  - verify: `python3 <측정 스크립트>` 출력 JSON 의 `shared_servers`, `mem_total_mb`, `scope_checks[]`
  - evidence: `.qa-artifacts/v1.9.0/level4/live-measure.json`
- AC-017: 세션의 것은 접속이 선언한다 — 한 서버를 쓰는 두 세션의 `ask_avatar` LLM 호출은 각자 선언한 LLM 설정으로 나가고(동시 30회, 상대 세션 값 0건), `read`·`list_tags` 의 출력은 각자 로캘을 따르며, `read` 의 상대 경로는 호출한 세션의 작업 폴더 기준이다(작업 폴더를 모르면 오류). 서버 설정·운영 변수·세션 고유 이름을 선언한 접속과 런타임이 지원하지 않는 로캘은 거부된다. LLM 설정 가운데 넘기지 못한 것이 있는 세션은 그 이름을 선언하고, 그 세션의 `ask_avatar` 는 넘어온 나머지만으로 LLM 을 부르지 않고 그 이름을 적은 오류로 답한다(LLM 호출 0건, 다른 도구와 이웃 세션은 그대로). 서버가 읽는 모듈에 프로세스 기본 로캘 표기 · 등록되지 않은 한 인자 `path.resolve` · 등록되지 않은 프로세스 생성이 0건이다.
  - verify: `npx vitest run test/shared-server-session-env.test.ts test/llm-child-env.test.ts test/shared-server-hello.test.ts` 와 `npx vitest run test/server-scope-guard.test.ts -t "TC-SCOPE-005"` 와 `npx vitest run test/shared-server-e2e.test.ts -t "session settings"` → 전부 exit 0
  - evidence: `session-env.log`, `scope-guard.log`, `shared-e2e.log`
- AC-018: 장애가 되풀이될 때 중계가 폭주하지 않는다 — 뜨자마자 끝나는 서버는 둘째 급사부터 2초·4초 이상 간격을 두고 다시 띄우고, 공용 서버가 아닌 답을 하는 리스너에는 막 시작한 중계가 한 번만 접속하고 0이 아닌 코드로 끝나며, 서버가 없어 기다리는 동안 온 호출은 1.5초 안에 오류로 답한다. 주인 없는 기동 잠금은 떠 있는 서버가 자기 점검 주기 안에 지우고, 살아 있는 프로세스가 쥔 잠금은 지우지 않는다.
  - verify: `npx vitest run test/shared-server-update.test.ts -t "crash loop"` 와 `npx vitest run test/shared-server-update.test.ts -t "start lock"` 와 `npx vitest run test/shared-server-e2e.test.ts -t "wrong listener"` → 전부 exit 0
  - evidence: `shared-update.log`, `shared-e2e.log`

**Steps** — 아래 `## Steps` 절.

**Risks / Stop rules** — 아래 `## Risks / Stop rules` 절.

**Open Questions** — 아래 `## Open Questions` 절.

## Spec (목표/제약/용어)

**목표.** memory-bank 로컬 MCP 서버를 "세션마다 전체 서버" 에서 "공용 서버 1개 + 세션별 중계" 로 바꾸되, 세션의
프로젝트 범위·DB·환경이 다른 세션과 섞이지 않게 한다.

**제약.**
- 범위는 접속이 선언한 작업 폴더에서만. 서버의 `process.cwd()` · 누락 값의 대체 금지(실패는 실패로).
- 선언 폴더 문자열은 지금 서버의 `process.cwd()` 와 글자 단위로 같아야 한다(`scope_project` 는 완전 일치 비교).
- 빈 값·null 프로젝트는 "전 프로젝트"로 읽히는 함수가 있다(`project-family.ts:242`, `fact-db.ts:887-891·1148·1189`, `avatar-responder.ts:76`) — 그런 값이 도구에 닿지 않게 한다.
- 훅 클라이언트(node·native)와 주입 소켓 이름·요청 형식은 바꾸지 않는다(`SRC_HASH` 유지).
- 이미 떠 있는 1.8.0 실행기가 새 `dist/mcp-server.js` 를 자식으로 띄운다: 인자 없음 · 10초 안 종료는 npm 구조 작업 · 재생한 `initialize` 는 20초 안 응답 · 자식 종료는 전부 충돌로 계산(예산 3, 재설정 없음).
- `cli/mcp-server-wrapper.js` 는 한 글자도 바꾸지 않는다. `dist/mcp-server.js` 경로와 stdio 계약(stdout 은 JSON-RPC 줄만, stdin 종료 시 exit 0) 유지.
- package.json `bundle` 스크립트 모양 유지(번들은 `dist/mcp-server.js` 하나 — 이제 얇은 진입점). 공용 서버와 세션별 서버는 번들하지 않고 tsc 산출물로 실행한다(번들에 넣으면 네이티브 모듈 import 가 번들 맨 위로 올라가 중계가 무거워진다).
- `.codex/hooks/*.sh` 2개(내 것이 아닌 미커밋 변경)와 저장소 밖 Codex 필터는 건드리지 않는다.
- 운영 DB(`~/.config/superpowers/…/db.sqlite`)에 스키마 변경·대량 쓰기 없음.
- `main` push = 떠 있는 세션과 공개 사용자에게 배포. 검증 전에는 기능 브랜치만 push 한다.
- 원래 프로젝트 경계가 없는 도구(`search` 의 관련 지식, `explore_graph`, `search_ontology`, `graph_stats`, `read`, `tag_fact`)의 동작은 바꾸지 않는다.

**용어.** 위 Domain Glossary. "꼬인다" = 한 세션의 요청이 다른 세션의 프로젝트·DB·환경 기준으로 계산되는 것.

## Program Design

### 프로세스 구조

```
지금:   클라이언트 ─ 실행기(16MB) ─ dist/mcp-server.js (전체 서버 50~420MB)   × 세션 수
이후:   클라이언트 ─ 실행기 ─ dist/mcp-server.js = 중계(작다) ─┐
        클라이언트 ─ 실행기 ─ 중계 ────────────────────────────┼─ mb-shared-<버전>-<신원8>.sock ─ dist/shared-server.js (신원당 1개)
        클라이언트 ─ 실행기 ─ 중계 ────────────────────────────┘                                └ inject-daemon-<버전>.sock (훅용, 그대로)
```

실행기는 지금처럼 45초마다 디스크 버전을 보고 자식을 바꾼다 → 새 중계 코드가 새 신원을 계산해 새 서버로 간다.
중계가 버전 이동을 직접 하지 않으므로 "옛 중계 코드가 새 버전의 소켓 이름을 옛 규칙으로 계산"하는 일이 없다.

### 파일 트리 diff

```
src/
  mcp-server.ts            [수정] stdio 진입점(얇다): 방식 판정 → 중계(runRelay) 또는 세션별 서버(동적 import)
  server-core.ts           [new]  도구 11개 선언·처리. createMemoryBankServer(ctx) — import 부작용 없음
  stdio-server.ts          [new]  세션별 서버 방식: 주입 데몬 + StdioServerTransport (지금 main() 의 내용)
  session-context.ts       [new]  SessionContext, validSessionCwd(), sessionProject()
  own-cwd.ts               [new]  ownCwd() — 자기 프로세스의 작업 폴더를 읽는 유일한 곳(세션 쪽 전용)
  shared-identity.ts       [new]  서버 환경 허용 목록, serverEnvFor(), spawnEnvFor(), distFingerprint(), sharedServerIdentity(), 소켓·pid·잠금 경로
  shared-mode.ts           [new]  sharedMode() — 세션 쪽 판정(스위치·끄기 파일·빌드 여부). 서버가 읽는 모듈 밖
  shared-protocol.ts       [new]  hello 형식 · 제어 줄 접두사 · 서버 종료 코드 (import 없음 — 중계 번들이 서버 의존성을 끌어오지 않게)
  unix-socket.ts           [new]  probeSocket · socketIdentity · removeIfDead (inject-daemon.ts 에서 옮김)
  socket-transport.ts      [new]  net.Socket 위의 MCP Transport + 제어 줄(mb_relay ping/pong)
  shared-server-core.ts    [new]  startSharedServer(): 단일 바인드 · hello 검증 · 접속별 Server · 유휴/은퇴/자기점검 · pid 파일
  shared-server.ts         [new]  분리 프로세스 진입점: 살아 있는 서버 확인 → 무거운 모듈 로드 → 바인드, 종료 코드 계약
  relay.ts                 [new]  runRelay(): 접속·기동(잠금)·hello·재생·재접속·무응답 처리
  inject-daemon.ts         [수정] cwd 검증(대체 제거), 소켓 도우미는 unix-socket.ts 에서
test/
  setup.ts                                                                               [수정] 기본 MEMORY_BANK_SHARED_SERVER=0
  shared-identity.test.ts · shared-server-hello.test.ts · shared-server-scope.test.ts ·
  shared-server-e2e.test.ts · shared-server-update.test.ts · server-scope-guard.test.ts ·
  session-context.test.ts                                                                [new]
  fixtures/wrapper-1.8.0.js                                                              [new] v1.8.0 실행기 원문
  helpers/shared-harness.ts                                                              [new] 짧은 설정 폴더·임시 플러그인 루트·stdio 클라이언트·잔존 프로세스 정리
```

### 타입·시그니처

```ts
// session-context.ts
export interface SessionContext { readonly cwd: string | null;                 // null = 세션이 자기 작업 폴더를 읽지 못했다
  readonly childEnv?: Readonly<Record<string, string>> | null;                  // 그 세션의 LLM 설정(없음/null = 프로세스가 곧 세션)
  readonly childEnvMissing?: readonly string[];                                 // 넘기지 못한 LLM 설정의 이름 — 있으면 LLM 호출을 하지 않는다
  readonly locale?: string }                                                    // 출력 로캘(BCP 47)
export function sessionLlmEnv(ctx: SessionContext): Readonly<Record<string, string>> | null   // childEnv 를 읽는 유일한 길. childEnvMissing 이 있으면 throw
export function validSessionCwd(v: unknown): v is string   // 문자열 · path.isAbsolute · 1..4096바이트 · NUL 없음
export function sessionProject(ctx: SessionContext, explicit: unknown, argument = 'project'): string   // explicit 이 비어 있지 않은 문자열이면 그것, 아니면 ctx.cwd, null 이면 throw(메시지에 argument 이름)

// server-core.ts
export function createMemoryBankServer(ctx: SessionContext): Server   // cwd 가 null 도 유효한 문자열도 아니면 throw

// shared-identity.ts  (Node 내장 + version-guard.ts 만 import)
export function serverEnvKind(name: string): 'identity' | 'passthrough' | 'child' | null   // child = 접속이 선언하는 세션의 LLM 설정 · null = 넘기지 않는다
export function childEnvFor(env: NodeJS.ProcessEnv, cwd: string | null): { env: Record<string, string>; dropped: string[] }   // dropped = 한도 초과·풀 수 없는 상대 경로
export function validChildEnv(v: unknown): v is Record<string, string> · validChildEnvMissing(v: unknown, env: Record<string, string>): v is string[]
export function serverEnvFor(env: NodeJS.ProcessEnv, cwd: string | null): Record<string, string> | null   // 신원에 드는 환경. null = 상대 경로 설정인데 cwd 를 모른다
export function spawnEnvFor(env: NodeJS.ProcessEnv, serverEnv: Record<string, string>): Record<string, string>   // 서버 환경 + 운영 변수
export function distFingerprint(distDir: string): string
export function sharedServerIdentity(o: { version: string; fingerprint: string; serverEnv: Record<string, string> }): string   // sha256 hex
export function sharedSocketPathIn(indexDir: string, version: string, identity: string, maxBytes?: number): string | null
export function sharedPidPath(socketPath: string): string · sharedLockPath(socketPath: string): string · sharedServerArg(identity: string): string   // '--mb-shared=<신원8>'

// shared-mode.ts  (세션 쪽 — 서버가 읽는 모듈 밖)
export type SharedMode = { kind: 'shared'; socketPath: string; indexDir: string; identity: string; version: string; serverEnv: Record<string, string>; serverEntry: string }
                       | { kind: 'session-local'; reason: 'switch-off' | 'switch-off-file' | 'windows' | 'source-run' | 'relative-path' | 'socket-path-too-long' }
                       | { kind: 'broken'; reason: 'server-file-missing' | 'no-version' }   // 설치 결함 — 세션별 방식으로 넘기지 않고 exit 1
export function sharedMode(o: { entryUrl: string; env: NodeJS.ProcessEnv; cwd: string | null; version?: string | null; platform?: NodeJS.Platform }): SharedMode

// 접속 첫 줄(중계 → 서버)과 답(서버 → 중계). 이후는 MCP JSON-RPC 줄 + 제어 줄({mb_relay:1, ping|pong:n}).
type RelayHello = { mb_relay: 1; identity: string; version: string; cwd: string | null;
                    env: Record<string, string>; envMissing: string[]; locale: string | null; pid: number }
type HelloReply = { mb_relay: 1; ok: true; pid: number; version: string }
                | { mb_relay: 1; ok: false; error: 'bad-hello' | 'bad-cwd' | 'bad-env' | 'identity-mismatch' }

// shared-protocol.ts
export const EXIT_NAME_TAKEN = 76, EXIT_RETRY = 75, EXIT_START_FAILED = 70   // 0 은 계약에 없다 — 답하기 전의 0 은 기동 실패

// shared-server-core.ts
export interface SharedServerHandle { connections(): number; retiring(): string | null; close(): Promise<void> }
export type StartResult = { kind: 'serving'; handle: SharedServerHandle } | { kind: 'name-taken' } | { kind: 'retry'; why: string }
export function startSharedServer(o: { identity: string; version: string; socketPath: string; createServer: (ctx: SessionContext) => Server;
  idleMs: number; tickMs: number; retireGraceMs?: number; helloTimeoutMs?: number; bindWaitMs?: number; staleReason?: () => string | null;
  onStop: (o: { reason: string; listenerClosed: boolean }) => void | Promise<void>; log?: (line: string) => void }): Promise<StartResult>

// relay.ts
export function runRelay(mode: Extract<SharedMode, { kind: 'shared' }>, session: { cwd: string | null; env: Record<string, string>; envMissing: string[]; locale: string | null }): void
```

### 규칙

1. **범위** — 도구 기본값 5곳은 `sessionProject(ctx, params.project)`. `ctx.cwd` 가 문자열이면 `validSessionCwd` 를 통과한 값뿐이고, `null` 이면 그 호출만 오류("세션의 작업 폴더를 읽지 못했다 — `project` 를 넘겨라")로 답한다(null 이 범위 필터로 흘러가지 않는다). 주입 요청도 같은 검증(실패 = `{ok:false}`).
2. **서버 환경** — 중계가 서버를 띄울 때 넘기는 환경은 `serverEnvFor()` 가 만든 것(서버 설정)과 운영 변수뿐이다.
   - 서버 설정(신원에 든다): 접두사 `MEMORY_BANK_` `TEST_` + 이름 `HOME` `XDG_CONFIG_HOME` `PERSONAL_SUPERPOWERS_DIR` `CONVERSATION_SEARCH_EXCLUDE_PROJECTS` 프록시·인증서 변수 `TZ` — 서버 코드나 그 프로세스의 Node 런타임이 직접 읽는 값이다.
   - 세션의 것(서버 프로세스에 넣지 않는다 — 접속의 hello 가 선언하고 그 접속의 호출에만 쓴다, 규칙 10): 접두사 `ANTHROPIC_` `CLAUDE_` `_CLAUDE_` `AWS_` `GOOGLE_` `CLOUD_ML_` `VERTEX_` `DISABLE_` `ENABLE_` + 이름 `CLAUDECODE` `API_TIMEOUT_MS` `MAX_THINKING_TOKENS` `LANG` `LC_*`. 처음 판은 이 값들도 서버 설정에 넣었다(Deviations 의 '레벨3 실측 반영').
   - 빼는 것(세션 고유·중계 전용): `CLAUDE_CODE_SESSION_ID` `CLAUDE_CODE_MESSAGING_SOCKET` `CLAUDE_CODE_MESSAGING_TOKEN` `CLAUDE_PROJECT_DIR` `CLAUDE_PLUGIN_ROOT` `CLAUDE_PLUGIN_DATA` `CLAUDE_CODE_SSE_PORT` `CLAUDE_ENV_FILE` `MEMORY_BANK_SHARED_SERVER` `MEMORY_BANK_RELAY_*` `MEMORY_BANK_WRAPPER_*` `MEMORY_BANK_INJECT_REQ_ID`.
   - 운영 변수(넘기되 신원에는 넣지 않는다): `PATH` `USER` `LOGNAME` `SHELL` `TMPDIR` — 먼저 서버를 띄운 세션의 값이 쓰인다(데이터·범위에 영향 없음).
   - 경로 값 변수(`MEMORY_BANK_CONFIG_DIR` `PERSONAL_SUPERPOWERS_DIR` `XDG_CONFIG_HOME` `MEMORY_BANK_DB_PATH` `TEST_DB_PATH` `TEST_ARCHIVE_DIR` `TEST_PROJECTS_DIR` `CLAUDE_CONFIG_DIR`)의 상대 경로는 중계의 작업 폴더 기준 절대 경로로 바꿔 넘긴다(서버의 작업 폴더는 색인 폴더라 그대로 넘기면 다른 곳을 가리킨다). 작업 폴더를 읽지 못했는데 상대 경로가 있으면 세션별 서버 방식.
   - 근거(이 Mac 실측, 값 미출력): 지금 서버는 세션 환경을 통째로 물려받는다 — 세션 id·메시징 소켓/토큰·프로젝트 폴더(15개 중 14가지 값)가 `ask_avatar` 의 LLM 자식까지 내려간다. 공용 서버에서는 이것이 남의 세션 값이 되므로 뺀다.
3. **신원** — `sha256(JSON{ v: 버전, f: 코드 지문, env: 서버 환경에서 운영 변수를 뺀 [이름, 값] 정렬 목록 })`. 서버는 시작할 때 자기 `process.env` 로 같은 계산을 해 소켓 이름을 정하고, hello 의 신원이 자기 것과 다르면 거부한다.
   세션 고유 값이 허용 목록에 새로 섞이면 세션마다 서버가 따로 뜬다(공유가 안 될 뿐 섞이지 않는다 — 안전한 쪽으로 실패). 서버 로그에 신원 8자와 포함된 이름(값 없음)을 남겨 진단할 수 있게 한다.
4. **소켓 이름** — `mb-shared-<버전>-<신원 앞 8자>.sock` (색인 폴더 안, 모드 600) + 같은 이름의 `.pid`. 주입 데몬의 정리 정규식 `inject-daemon(-…)?.sock` 과 겹치지 않는다. 경로가 한도(macOS 103 / Linux 107바이트)를 넘으면 세션별 서버 방식.
5. **서버 기동·종료 코드** — ① 그 이름에 살아 있는 서버가 답하면 exit 76(`name-taken`) ② 무거운 모듈(`server-core` 와 그 아래) 로드 — 실패하면 exit 70(`start-failed`) ③ 바인드: 이름이 있는데 소켓이 아니면(일반 파일·심링크) 바인드하지 않는다. `EADDRINUSE` 면 다시 확인해 살아 있으면 exit 76, 죽은 파일이면 `removeIfDead`(나이 2초 + 1초 뒤 재확인 + inode 동일)가 판정할 수 있을 때까지 기다렸다가(상한 8초) 다시 바인드, 그래도 안 되면 exit 75(`retry`) ④ pid 파일 기록, 죽은 `mb-shared-*.sock` 정리, 주입 데몬 시작.
   바인드된 서버는 곧 준비된 서버다(무거운 로드가 바인드 앞이라 "바인드 뒤 import 실패"가 없다).
6. **서버 수명** — 접속 0 이 `MEMORY_BANK_SHARED_IDLE_MS`(기본 10분) 이어지면 종료(훅 요청은 세지 않는다 — 세션이 없는 서버가 훅 때문에 살아남지 않게): 리스너 닫기(이름이 아직 내 것일 때만) → 접속 수 재확인(그 사이 붙은 접속이 있으면 은퇴 상태로 그 접속이 끝날 때까지 돈다) → 주입 데몬 닫기 → pid 파일 삭제 → exit 0.
   `MEMORY_BANK_SHARED_TICK_MS`(기본 45초)마다 자기 점검: 소켓 경로의 inode 가 내 것이 아니거나 없다 / 디스크 버전 ≠ 내 버전(읽지 못하면 같은 것으로 본다) / 코드 지문이 달라졌다 → "은퇴"(접속 0이 되면 5초 뒤 종료). 이름을 잃은 서버는 리스너를 닫지 않고 끝난다(닫으면 libuv 가 후임의 파일을 이름으로 지운다).
   `uncaughtException` → 로그 후 exit 1(중계들이 다시 붙으며 새로 띄운다), `unhandledRejection` → 로그만.
   stderr 는 `<색인 폴더>/logs/shared-server.log` — 띄우는 쪽이 1MB 를 넘으면 `.old` 로 한 번 돌린 뒤 붙여 쓰기로 연다.
7. **중계** — 시작 즉시 stdin 줄을 기록·대기열에 넣고 접속한다.
   - 접속 실패(`ENOENT`, 또는 `ECONNREFUSED` 가 짧은 재시도 3회 뒤에도) → 기동 잠금(`mb-shared-…​.lock`, `wx` 생성 + pid, 주인 pid 가 죽었거나 30초가 지나면 낡은 것) 을 잡고 → 접속을 한 번 더 확인하고 → 서버를 띄운다(ABI 가 맞는 node · `cwd`=색인 폴더 · `detached` · 환경 = 서버 환경 · 인자 `--mb-shared=<신원8>`). 잠금을 못 잡으면 기다리며 접속을 다시 시도한다.
   - 띄운 서버가 끝난 코드: 76 → 다른 서버가 이름을 쥐었다(계속 접속 시도) · 75 → 간격을 두고 다시 · 그 밖(0 포함) → **기동 실패**.
   - 기동 실패 + 그 이름에 답하는 서버 없음: 중계가 막 시작했으면(`process.uptime()` < `MEMORY_BANK_RELAY_YOUNG_MS` 기본 8초 — 감독자의 10초 기준보다 2초 여유) exit 1 → 감독자가 npm 구조 작업. 아니면 끝나지 않고 대기 중·이후 요청에 JSON-RPC 오류로 답하며 다시 시도한다(간격 1→2→4…30초, 연속 10회 뒤에는 요청이 올 때만 30초 간격으로). 기다리는 동안 온 요청은 다음 시도까지 붙들지 않고 그 자리에서 오류로 답한다.
   - 이름으로 답하는 것이 공용 서버가 아니면(hello 답이 형식에 안 맞음 — `not-ours`): 다시 물어도 같은 답이고 그 이름을 빼앗을 수도 없으므로 곧바로 위 "기동 실패"와 같이 처리한다. 그 밖에 "답은 하는데 붙지 못하는" 상태는 5번까지만 다시 본다.
   - 접속한 지 `MEMORY_BANK_RELAY_STABLE_MS`(기본 10초) 안에 끊기는 일이 연달아 일어나면(뜨자마자 끝나는 서버): 첫 번째는 곧바로 다시 붙고, 두 번째부터 2→4→8→16→30초를 기다린다.
   - hello 답이 `MEMORY_BANK_RELAY_HELLO_MS`(기본 10초) 안에 없으면 응답 없는 서버로 본다: pid 파일의 pid 가 `shared-server.js` 와 `--mb-shared=<신원8>` 을 명령줄에 가진 프로세스일 때만 SIGTERM → 2초 뒤 SIGKILL, 그 뒤 새로 띄운다. 요청이 30초 넘게 답이 없으면 제어 줄 ping 을 보내고, 30초 안에 pong 이 없으면 같은 처리를 한다(바쁜 서버는 pong 으로 구분된다).
   - 접속이 끊기면: 답이 안 나간 요청은 `-32001` 로 끝내고(단 `initialize` 는 붙들었다가 새 접속에 다시 보낸다), 다시 붙어 기록한 `initialize`·`initialized` 를 재생하고(이미 답한 `initialize` 의 답은 삼킨다) 이어 간다.
   - hello 가 거절되면(`bad-cwd`·`bad-env`·`identity-mismatch`·`bad-hello` — 정상 중계에서는 나올 수 없는 값) stderr 에 이유를 적고 exit 1. 다시 시도해도 같은 답이므로 반복하지 않는다.
   - 끝나는 경우: stdin 종료·SIGTERM·SIGINT(exit 0), 위의 "막 시작 + 기동 실패"(exit 1), hello 거절(exit 1). 중계는 소켓 파일을 지우지 않는다.
8. **세션별 서버 방식** — `dist/mcp-server.js` 가 자기 파일 옆의 `stdio-server.js` 를 실행 시점 경로로 동적 import(번들에 넣지 않는다). stderr 에 `shared server off: <이유> — this session runs its own server` 한 줄. `tsx` 로 `src/mcp-server.ts` 를 돌리면(확장자 `.ts`) 이유는 `source-run`. 사유는 여섯 가지뿐이다(`switch-off` · `switch-off-file` · `windows` · `source-run` · `relative-path` · `socket-path-too-long`). 컴파일된 진입 파일 옆에 `shared-server.js` 가 없거나 버전을 읽을 수 없으면 사유가 아니라 설치 결함(`broken`)이다 — 진입점이 무엇이 없는지 적고 exit 1(끄기 스위치·끄기 파일이 있으면 그것이 먼저다).
   끄기: `MEMORY_BANK_SHARED_SERVER=0` 또는 파일 `<색인 폴더>/shared-server.off`(환경을 바꾸기 어려운 떠 있는 세션용 — 실행기가 자식을 다시 띄울 때부터 적용).
9. **가드** — `test/server-scope-guard.test.ts` 가 `shared-server.ts` · `shared-server-core.ts` · `server-core.ts` · `inject-daemon.ts` 에서 닿는 모듈 전체를 따라가 ① `process.cwd(`·`process.chdir(` 0건 ② `process.env.NAME`·`env.NAME` 은 전부 `serverEnvKind` 가 `identity` 또는 `passthrough` 인 이름(세션의 LLM 설정은 호출의 환경 `llmEnv` 에서만 읽는다) ③ `process.env` 를 통째로 쓰는 자리는 등록된 것뿐임을 확인한다. 진입점 `mcp-server.ts`·`relay.ts`·`stdio-server.ts` 와 `shared-mode.ts`·`own-cwd.ts` 는 세션 자신의 프로세스라 대상이 아니고, 서버가 읽는 모듈에서 닿지 않는다는 것도 같은 테스트가 확인한다.
10. **세션의 것은 접속이 선언한다** — hello 는 작업 폴더에 더해 `env`(그 세션의 LLM 설정: 규칙 2 의 '세션의 것' 이름만, `childEnvFor()` 가 만든다)와 `locale`(세션 프로세스의 기본 로캘, 모르면 null)을 싣는다. 서버는 `validChildEnv`·`validSessionLocale` 로 검사해(다른 종류의 이름·문자열 아닌 값·한도 초과·지원하지 않는 로캘 → `bad-env` 거절) `SessionContext { cwd, childEnv, locale }` 로 그 접속의 MCP 서버 인스턴스에만 준다.
    - LLM 호출(`ask_avatar` → `callHaiku`)은 `childEnv` 를 서버 프로세스 환경 위에 얹어 자식 프로세스의 환경으로 넘긴다. 예비 경로(API 키로 직접 호출)의 접속 주소·토큰·추가 헤더도 같은 환경에서 읽는다. `childEnv` 가 없으면(세션별 방식 — 프로세스가 곧 세션) 지금까지처럼 프로세스 환경을 물려준다.
    - 날짜·숫자 표기와 이름 정렬은 `ctx.locale` 을 인자로 받는다. `read` 의 상대 경로는 `ctx.cwd` 기준으로 푼다(null 이면 오류).
    - 한도: 이름 256개 · 값 하나 8KB · 전체 32KB(JSON 직렬화 기준). 실제 세션 실측 최대치(이름 25~26개 · 전체 1.3KB · 값 하나 185바이트 — `.qa-artifacts/v1.9.0/level3/census/`)의 25배 이상이고 hello 한 줄 상한 64KB 안에 든다. 한도를 넘거나 상대 경로인데 작업 폴더를 모르는 값은 `env` 에 싣지 못한다 — 중계는 그 이름을 stderr 에 적고 hello 의 `envMissing` 으로 선언하며, 서버는 그 접속의 LLM 호출을 하지 않는다(`sessionLlmEnv()` 가 이름을 적은 오류를 던진다). 넘어온 나머지만으로 LLM 을 부르는 경로는 없다.
    - 가드(`test/server-scope-guard.test.ts` TC-SCOPE-005): 서버가 읽는 모듈에서 프로세스를 띄우는 곳은 `deps-heal.ts`(npm)와 `llm.ts` 뿐이고, 인자 없는 `toLocale*()` · 인자 하나인 `localeCompare` · 인자 없는 `new Intl.*()` 가 0건이며, 인자 하나인 `path.resolve` 는 등록된 목록뿐이다.

### 냄새 점검 (파울러 24종 — 확정 전)

- 긴 함수: `mcp-server.ts` 의 처리기(430줄)를 옮기는 단계는 **옮기기만** 한다(함수 추출은 이번 범위 밖 — 기존 냄새, 보고만).
- 전역 데이터: 모듈 최상위 `server` 를 없애고 팩토리가 접속별로 만든다(냄새 제거).
- 뒤엉킨 변경: 소켓 생사 판정을 `unix-socket.ts` 로 모아 주입 데몬과 공용 서버가 같은 구현을 쓴다(중복 방지). 중계는 `wrapper-core.ts` 의 `LineSplitter`·`SupervisorState` 를 다시 쓴다(핸드셰이크 기록을 또 만들지 않는다).
- 추측성 일반화 회피: HTTP 접속구 · 실행기 재작성 · 빌드 단계의 지문 파일은 넣지 않는다. (처음 판은 접속별 LLM 환경 전달도 여기 두었다 — 레벨3 실측에서 필요가 확인돼 규칙 10 으로 넣었다. Deviations 참조)

### 단계별 두 모자

구조 변경 단계(S1 · S4)는 동작을 바꾸지 않고 테스트 통과로 끝낸다. 기능 단계와 한 단계로 합치지 않는다.

## Steps

| # | 모자 | 내용 | 건드리는 파일 | 검증 |
|---|---|---|---|---|
| S0 | — | 기준선: 작업 폴더에서 `npm run build` · `npm test` (완료 — 빌드 rc 0, 2,115 통과·1 건너뜀·1 부하성 실패(단독 재실행 통과)) | — | 기록 |
| S1 | 구조 | 도구 선언·처리를 `server-core.ts` 로 옮기고(`createMemoryBankServer(ctx)`), `stdio-server.ts` 가 지금 `main()` 을 맡는다. `mcp-server.ts` 는 그것을 부르기만. 원문을 읽는 테스트 5개의 대상 파일 변경 | `src/mcp-server.ts` `src/server-core.ts` `src/stdio-server.ts` · `test/mcp-tool-names` `project-profile-tools` `mcp-facts` `search-perf-guards` `mcp-server-stdio` | `npm run build` + 관련 테스트 exit 0 (동작 불변) |
| S2 | 기능 | `SessionContext`·`validSessionCwd`·`sessionProject`. 기본값 5곳. 주입 데몬 cwd 검증. 정적 가드(cwd) | `src/session-context.ts` `src/server-core.ts` `src/inject-daemon.ts` · `test/session-context.test.ts` `test/server-scope-guard.test.ts` `test/inject-daemon-protocol.test.ts` | AC-004 · AC-006 테스트 |
| S3 | 기능 | 서버 환경·코드 지문·신원·소켓 이름·방식 판정 + 환경 가드 | `src/shared-identity.ts` · `test/shared-identity.test.ts` `test/server-scope-guard.test.ts` | AC-005 테스트 |
| S4 | 구조 | 소켓 생사 판정 도우미를 `unix-socket.ts` 로 옮긴다 | `src/unix-socket.ts` `src/inject-daemon.ts` | inject-daemon 테스트 exit 0 |
| S5 | 기능 | 소켓 전송 + 공용 서버(hello · 접속별 Server · 단일 바인드 · 유휴/은퇴/자기점검 · pid 파일 · 종료 코드) | `src/socket-transport.ts` `src/shared-server-core.ts` `src/shared-server.ts` · `test/shared-server-hello.test.ts` `test/shared-server-scope.test.ts` `test/helpers/shared-harness.ts` | AC-002 · AC-003 · AC-007(이름 소실) 테스트 |
| S6 | 기능 | 중계 + stdio 진입점 방식 전환. `test/setup.ts` 기본값 끔 | `src/relay.ts` `src/mcp-server.ts` `test/setup.ts` · `test/shared-server-e2e.test.ts` | AC-001 · 007 · 008 · 011 · 012 · 013 테스트 |
| S7 | 기능 | 버전 교체·1.8.0 실행기 픽스처 테스트(임시 플러그인 루트: dist 복사 + package.json 복사 + node_modules 링크) | `test/shared-server-update.test.ts` `test/fixtures/wrapper-1.8.0.js` | AC-009 · AC-010 테스트, `wrapper-e2e` `node-abi` 통과 |
| S8 | 기능 | 토폴로지를 가정한 기존 테스트·스크립트 정렬(소켓 목록 단언, e2e 스크립트), 프로세스 판정에 공용 서버가 잡히는지 테스트 추가 | `test/inject-daemon-long-socket-path.test.ts` `scripts/e2e-native-inject-live.mjs` `test/migrate-vec-facts-int8.test.ts` | 전체 테스트 exit 0 |
| S9 | 기능 | 문서·버전·잠금: README · README-KR · CLAUDE.md · CODEX.md · MCP-TOOLS.md · CHANGELOG `[1.9.0]` · 버전 3곳 · `.requirements-lock.md` 행 추가 · `npm run build` 로 dist 재생성 | 해당 문서 · `package.json` `.claude-plugin/*.json` · `dist/**` | AC-014 · AC-015 |
| S10 | — | Phase 3 마무리: 구조 코드 리뷰(범위는 git 으로 계산) | — | 새 냄새 0 또는 Deviations 기록 |

커밋 포인트: S1 · S4 뒤(구조), S2~S3 · S5 · S6 · S7~S8 뒤(기능), S9(릴리스 커밋 — Phase 4 Step 1 의 최종 커밋).

대규모 변경의 신뢰 원천: 기존 스위트(1.8.0 기준 178파일 2,117건) + stdio 로 11개 도구를 부르는 `test/mcp-server-stdio.test.ts` 가 재작성 전후를 고정한다.

## Risks / Stop rules

- **범위 누출**(가장 큼): 가드 테스트(AC-004·005) + 격리 테스트(AC-002) 가 통과하지 못하면 릴리스하지 않는다.
- **업그레이드 경로**: 떠 있는 1.8.0 실행기들이 새 중계를 자식으로 띄운다. AC-010 이 실패하면 `main` 에 올리지 않는다.
- **한 프로세스 장애 = 그 신원의 전 세션**: 서버가 죽으면 그 서버를 쓰는 세션의 도구·주입이 함께 끊긴다 → 중계의 재접속·재기동(AC-008)과 무응답 처리(AC-013), 로그 파일로 완화. 남는 위험: 죽는 동안의 요청은 오류로 끝난다.
- **줄 서기**: 한 세션의 긴 동기 구간(대화 검색 라운드당 45~300ms, DB 잠금 대기 최대 5초)이 다른 세션의 호출과 프롬프트 주입을 늦춘다. 주입은 3초를 넘기면 훅의 자체 계산으로 떨어진다(기존 동작). 레벨2 에서 동시 호출 지연을 잰다.
- **무응답 판정의 오판**: 30초 넘게 pong 이 없는 "바쁜" 서버를 끝낼 수 있다. 지금 코드의 가장 긴 동기 구간은 DB 잠금 대기 5초라 여유가 있다. 오판하면 그 신원의 세션이 한 번 재접속한다(데이터 손실 없음).
- **고아 프로세스**(이 플러그인의 과거 사고): 분리 프로세스는 접속 0 + 유휴 · 이름 소실 · 버전 은퇴로만 끝난다. 테스트는 짧은 유휴 시간으로 돌리고, 스위트 뒤 잔존 프로세스 0을 레벨1 에서 확인한다(AC-014).
- **번들하지 않은 서버**: 서버·세션별 서버가 설치 폴더의 node_modules 버전으로 돈다(지금까지는 MCP SDK·zod 가 번들에 들어 있었다). 워커 5종은 이미 그렇게 돈다. 폴더마다 해석 버전이 다를 수 있다(이 Mac: zod 4.6.5 대 4.6.7) — 중계와 서버 사이는 줄 단위 JSON 이라 영향 없음.
- **중단 규칙**: 같은 실패를 전략 4회(직접 수정 → 구조 변경 → harsh-critic 절차 → 리셋) 돌려도 못 풀면 릴리스 없이 기능 브랜치 상태로 보고한다. 기능 삭제·no-op 으로 통과시키지 않는다.
- **되돌리기**: 설치 뒤 문제가 나면 `<색인 폴더>/shared-server.off` 파일(떠 있는 세션 포함, 다음 자식 교체부터) 또는 `MEMORY_BANK_SHARED_SERVER=0`, 또는 1.8.0 재설치. DB 변경이 없어 데이터 복구는 필요 없다.

## Open Questions

- [ ] 클라우드 MCP(`memory-bank-cloud` 의 stdio 서버 13개, 1.6GB)에 같은 구조 적용 — 졸업 트리거: 사용자가 클라우드 쪽도 요청.
- [ ] Codex 세션의 실제 작업 폴더 — Codex 필터가 `cwd` 를 플러그인 폴더로 고정해 지금도 프로젝트 사실이 기본 검색에 안 걸린다. 졸업 트리거: Codex 가 MCP 서버에 작업 폴더를 넘기는 수단 확인.
- [ ] 저장 쪽 — 프로젝트가 아닌 폴더(다른 플러그인 폴더 5,119건 · 홈 344건 · 상위 폴더 370건)에 묶인 사실의 재분류. 졸업 트리거: 사용자 결정(운영 DB 대량 변경).
- [ ] 주입 소켓은 (색인 폴더, 버전)당 1개인데 서버는 신원당 1개 — DB 경로를 환경으로 바꾼 신원의 서버가 주입 소켓을 쥐면 다른 세션의 훅이 그 DB 로 계산된다. 1.8.0 에도 있는 동작이다(서버 N개 중 하나가 쥔다). 독립 반박이 두 번 '높음'으로 지적했고 고치지 않았다: 실제 세션 집계에서 서버를 가른 값은 `MEMORY_BANK_AGENT_SOURCES` 하나이고, 그 값을 읽는 코드는 주입·서버 경로에서 호출되지 않는다(`.qa-artifacts/v1.9.0/level3/census/agent-sources-reach.json`) — 실데이터에서 판정이 달라지는 경우가 없다. 대신 이 상태가 되면 각 서버가 로그에 한 줄 적는다(`prompt injection: …`). 졸업 트리거: 세션마다 DB 경로·임베딩 모델·주입 스위치를 다르게 주는 쓰임이 생길 때 — 주입 요청에 신원을 실을 수 있게 훅 클라이언트를 바꾼다(`SRC_HASH` 변경 동반).
- [ ] 세션당 프로세스 2개(실행기 + 중계) → 1개 — 실행기가 중계를 겸하면 버전이 바뀐 뒤에도 옛 중계 코드가 남는다. 졸업 트리거: 실행기가 자기 자신을 새 코드로 다시 실행하는 방법을 검증한 뒤.
- [x] 신원이 갈리는 설정 차이를 줄이기 — LLM 환경을 접속별로 넘기면 Claude Code 세션과 Codex 세션이 한 서버를 쓸 수 있다. 졸업: 레벨3 실측에서 서버 수가 실제로 문제였다(세션 20개 → 서버 7개). 규칙 10 으로 구현했다(같은 20개 → 2개).
- [ ] 서버 설정 중 서버 코드가 실제로는 쓰지 않는 값(`MEMORY_BANK_AGENT_SOURCES` — 동기화 워커만 쓴다)을 신원에서 빼기 — 지금은 `MEMORY_BANK_` 접두 전체를 서버 설정으로 본다(안전한 쪽). 졸업 트리거: 이런 값 때문에 서버가 갈리는 세션이 늘 때(지금 실측 20개 중 1개).
- [ ] 같은 사용자 계정의 다른 프로세스가 소켓 이름을 먼저 차지하거나 기동 잠금을 지어내는 경우 — 요청 내용은 넘어가지 않지만 세션이 오류로 끝나거나 첫 연결이 최대 46초 늦는다(레벨3 A-003·A-005 실측). 졸업 트리거: 다른 사용자와 색인 폴더를 함께 쓰는 배치가 생길 때.
- [ ] Windows 에서 공용 서버(이름 있는 파이프) — 졸업 트리거: Windows 검증 환경.
- [ ] `runRelay`(270줄 — 레벨3 수정으로 230줄에서 늘었다)·`startSharedServer`(212줄)를 상태를 필드로 가진 객체로 바꾸기(Replace Function with Command) — 졸업 트리거: 중계·서버 수명 규칙을 다음에 고칠 때(그때 구조 변경을 먼저 한 커밋으로).
- [ ] 드리프트 정리(`WORKER_RE`)에 공용 서버 포함 — 지금은 서버가 스스로 은퇴한다. 졸업 트리거: 은퇴하지 않고 남는 서버가 관측될 때.

## Deviations

- (레벨3 실측 반영 — 신원 규칙 변경) 이 Mac 에 실제로 열려 있던 세션 20개의 환경을 처음 판의 신원 규칙에 넣어 보니 공용 서버가 7개(5·5·4·3·1·1·1)로 갈렸다. 가른 것은 세션마다 다른 LLM 관련 값(진입점 표시·클라이언트 옵션·계정 설정)이었고, 이 값들은 서버 코드가 읽지 않고 `ask_avatar` 의 LLM 자식만 쓴다. 그래서 LLM 설정과 로캘을 신원에서 빼고 접속이 선언하게 바꿨다(규칙 2·10, AC-005 문구, AC-017 추가). 같은 20개가 새 규칙으로는 2개(19 + 1, 차이는 `MEMORY_BANK_AGENT_SOURCES` 하나)다 — `.qa-artifacts/v1.9.0/level3/identity-census.json`(값은 기록하지 않았다). 처음 판 Deviations 의 "로캘 변수는 신원에 넣었다"는 이 변경으로 뒤집혔다: 로캘도 접속이 선언한다.
- (레벨3 독립 반박 반영) ① 설치 결함(`shared-server.js` 없음 · 버전 불명)을 세션별 방식 사유(`not-built`·`no-version`)로 넘기던 것을 실패(`broken`, exit 1)로 바꿨다 — AC-012 와 어긋나는 조용한 전환이었다. 소스 실행은 `source-run` 으로 이름을 바꿔 남겼다(AC-011·AC-012 문구). ② `read` 의 상대 경로가 서버 프로세스의 작업 폴더(색인 폴더) 기준으로 풀리던 것을 호출한 세션의 작업 폴더 기준으로 바꿨다. ③ 시간·크기 기본값에 근거를 주석으로 적었다(실측 인용, 판단값은 판단값이라고 명시).
- (레벨3 적대 프로브 반영) ① A-003: 공용 서버가 아닌 답을 하는 리스너 앞에서 중계가 25초 동안 481번 다시 접속하며 오류도 종료도 내지 않았다 → `not-ours` 판정과 재확인 상한 5회. ② A-006: 뜨자마자 죽는 서버를 60초에 20번 다시 띄웠다 → 둘째 급사부터 2→4→…30초 대기(`MEMORY_BANK_RELAY_STABLE_MS`). ③ 재시도 대기 중에 온 호출이 다음 시도까지(최대 30초) 붙들려 있었다 → 그 자리에서 오류로 답한다. ④ 주인 없는 기동 잠금은 다음 중계가 넘겨받고, 떠 있는 서버도 시작할 때와 자기 점검 때 지운다(AC-018 추가).
- (같은 수정에서 찾은 것) LLM 예비 경로의 Anthropic 클라이언트가 접속 주소·토큰·추가 헤더를 자기 프로세스 환경에서 읽는다 — 공용 서버에서는 세션의 키가 세션이 정한 주소가 아닌 기본 주소로 나갈 수 있어, 호출의 환경에서 읽어 넘기게 했다(`fallbackClientOptions`). 형식만 맞고 런타임이 지원하지 않는 로캘 태그는 조용히 서버 기본 로캘로 찍히므로 거절한다.
- (변이 실행) 위 수정을 지키는 테스트가 실제로 결함을 잡는지 변이로 확인한다 — 변이별 기록(실행한 커밋 · 실패한 테스트 · 원본 복원 확인)은 `.qa-artifacts/v1.9.0/level3/mutation/summary.json`, 로그는 같은 폴더. 요약은 일부만 다시 돌려도 나머지 기록이 남도록 변이 id 별로 갱신한다(처음에는 덮어써서 한 건만 남았다 — 독립 반박 2라운드 지적).
- (독립 반박 2라운드 반영) 판정은 높음 1 · 중간 6 이었고 중간 6 가운데 5가 1라운드 수정이 남긴 것이었다. 줄을 하나씩 고치는 대신 원인 쪽을 바꿨다. ① 세션의 LLM 설정 중 넘기지 못한 것을 빼고 계속하던 것(승인 없는 대체 경로) → 접속이 그 이름을 선언하고 그 세션의 LLM 호출은 오류로 답한다(`envMissing` · `sessionLlmEnv`, AC-017 문구). ② 레벨1 통과 수가 설치·릴리스 뒤에만 실행되는 다리를 품던 것 → QA 계획서에서 그 확인을 레벨4 `O-001`·`O-002` 로 나눴다. ③ 근거 산출물이 없던 수치(옛 규칙 7갈래 · 세션 설정 크기) → 원본 실행 출력과 지금 시점 재집계를 `level3/census/` 에 남겼다. ④ 이 문서의 타입·규칙 절을 코드에 맞췄다. 높음 1(주입 소켓)은 Open Questions 의 사유로 남긴다.
- (수정분 구조 점검) 새 냄새 1 — Long Function: `runRelay` 가 230줄에서 270줄로 늘었다(급사 대기·틀린 리스너 판정·대기 중 호출 응답이 같은 접속 상태기계에 들어갔다). 고치지 않았다 — 사유와 졸업 조건은 Open Questions 의 기존 항목과 같다. 새 로직 중 상태가 없는 부분은 함수로 뺐다(`retryLater`, `startLockHolder`·`removeOrphanStartLock`, `childEnvFor`·`validChildEnv`, `fallbackClientOptions`).

- (계획 반박 반영) 실행기가 중계를 겸하는 안을 뺐다 — 중계 코드가 세션 끝까지 옛 코드로 남아 다음 버전의 신원·소켓 이름을 옛 규칙으로 계산한다. 실행기는 고치지 않는다.
- (계획 반박 반영) 서버의 무거운 모듈 로드를 바인드 앞으로 옮기고 종료 코드 계약(0 / 75 / 70)을 넣었다 — 네이티브 모듈 고장이 "바인드 뒤" 실패가 되어 구조 작업이 걸리지 않던 문제.
- (계획 반박 반영) 유휴 판정에서 훅 요청을 뺐다 · 답 못 받은 `initialize` 는 오류로 끝내지 않는다 · 무응답 서버 처리(pid 파일 + ping)를 넣었다 · 끄기 파일을 넣었다 · 테스트 기본값은 끔.
- (실측 반영) 신원을 "서버가 읽는 이름 목록"에서 "서버가 받는 환경 전체(허용 목록)"로 바꿨다 — 지금 서버는 세션 환경을 통째로 물려받아 LLM 자식에게 넘기므로, 이름 몇 개만 신원에 넣으면 나머지가 남의 세션 값으로 섞인다. 로캘 변수는 `read` 의 날짜·숫자 표기에 쓰여 신원에 넣었다.
- (구현 중 발견) 이름 선점의 종료 코드를 0 에서 76 으로 바꿨다 — 바인드 전의 대기가 전부 `unref` 타이머라, 서버가 할 일 없이 코드 0 으로 끝나는 경우가 있었고 중계가 그것을 "다른 서버가 이름을 쥠"으로 읽어 끝없이 기다렸다. 0 은 이제 계약에 없는 코드(= 기동 실패)다. 서버 진입점은 바인드가 결정될 때까지 이벤트 루프를 붙든다.
- (구현 중 발견) 바인드는 죽은 소켓 파일이 판정 가능해질 때까지(나이 2초 + 재확인 1초) 스스로 기다린다(상한 8초) — 방금 죽은 서버의 파일 앞에서 곧바로 75 로 물러나면 중계의 재시도와 맞물려 기동이 수 초씩 늦어졌다.
- (구현 중 발견) 이름이 소켓이 아니면(일반 파일·매달린 심링크) 바인드하지 않는다 — `listen` 이 심링크를 따라가 엉뚱한 자리에 소켓을 만들었다.
- (구조) 세션 쪽 판정(`sharedMode`)을 `shared-mode.ts` 로, hello·종료 코드 상수를 `shared-protocol.ts` 로, 자기 작업 폴더 읽기를 `own-cwd.ts` 로 나눴다 — 서버가 읽는 모듈이 세션의 스위치를 읽지 않게 하고(가드 테스트의 서버 진입 목록에 `shared-server.ts`·`shared-server-core.ts` 포함), 중계 번들이 서버 의존성을 끌어오지 않게 하려는 것.
- (추가) 세션별 방식 사유 `relative-path`(상대 경로 설정인데 작업 폴더를 못 읽음), 진단용 `MEMORY_BANK_RELAY_DEBUG=1`(중계가 접속 이벤트를 stderr 에 적는다 — 서버에는 넘기지 않는다).
- (검증 명령 정정) AC-011·AC-012 와 QA 계획서 TC-SCOPE-002·TC-ENV-003·TC-SRV-005·TC-NEG-001 의 검증 명령을 실제 테스트 위치·이름으로 고쳤다 — TC-NEG-001 의 명령은 테스트 0건에 걸리는 헛검증이었다(전건 실행 대조: 명령 26개 중 1개). 시나리오의 Given/When/Then 은 그대로이고, TC-ENV-003 의 이유 목록에 `relative-path` 를, H-002 의 기대 코드를 76·75·70 으로 맞췄다.
- (S8) `mcp-server-stdio` 를 두 방식으로 돌린다(TC-NEG-003, 방식당 28건) · 배포 꾸러미 테스트가 두 서버 진입 파일의 import 폐쇄 전체를 확인한다 · 이관 가드의 프로세스 판정 테스트에 공용 서버를 넣었다 · 실 훅 E2E 스크립트는 자기 서버(짧은 유휴 시간 = 다른 신원)를 띄우고 그 서버가 끝난 것까지 확인한다 · 소켓 한도를 넘는 설정 폴더의 실행 테스트를 추가했다(AC-011 의 세 조건 전부 실행으로 확인).
- (S10 구조 리뷰 — 범위 76파일, 소스 15개) 새 냄새 4 · 기존 2.
  - [새] Duplicated Code · `src/relay.ts`·`src/shared-server.ts` 의 `positiveMs` 동일 본문 → Move Function(`shared-protocol.ts`) 으로 고쳤다.
  - [새] Duplicated Code · `test/shared-server-e2e.test.ts`·`test/shared-server-update.test.ts` 의 "시작한 것 추적 + 정리" 묶음 → Extract Function(`createRig()`) 으로 고쳤다.
  - [새] Long Function · `src/relay.ts` `runRelay`(230줄) · `src/shared-server-core.ts` `startSharedServer`(204줄) — 고치지 않았다. 둘 다 접속 상태기계 하나를 클로저 변수로 가진 함수이고 안쪽은 이름 붙은 함수(각 50줄 미만)로 나뉘어 있다. 처방(Replace Function with Command)은 재접속·재생·종료의 순서에 기대는 코드를 통째로 옮기는 일이라 릴리스 직전에는 얻는 것보다 회귀 위험이 크다고 판단했다 — Open Questions 에 올렸다.
  - [기존] Long Function · `src/server-core.ts` 의 도구 처리기(옮기기만 했다) · `src/inject-daemon.ts` `startInjectDaemon` — 보고만.
- (S10 리뷰 중 발견한 동작 결함) 중계의 침묵 시계가 요청을 보낼 때 갱신되지 않았다 — "한가하면 시계를 다시 맞춘다"는 줄이 요청을 기록한 **뒤**에 실행돼 요청에는 늘 거짓이었다. 그래서 오래 쉰 세션의 첫 호출에 곧바로 ping 이 나갔다(서버가 살아 있으면 pong 으로 끝나 해는 없었지만, 5초짜리 동기 구간에 걸리면 감시가 의도보다 일찍 움직인다). 시계를 요청 기록 **전에** 맞추게 고치고, 실행 테스트가 없던 감시 경로에 테스트 3건을 넣었다(쉬다 온 호출엔 ping 없음 — 수정 전 코드에서 실패 확인 / 바쁜 서버는 pong 으로 남는다 / 멈춘 서버는 끝내고 새 서버로 잇는다).
- (사용자 제약) 단계 push 는 기능 브랜치(`feat/shared-server`)로 한다 — `main` push 는 떠 있는 세션에 곧바로 배포되므로 레벨3 까지 통과한 뒤 Phase 5 에서 한다.

P3_SNAPSHOT: /private/tmp/claude-501/-Users-jung-wankim-Project-Claude-memory-bank-cloud/ea9a737f-ad52-45f6-992d-30c071014ff0/scratchpad/mbproc/p3-snapshot.json
