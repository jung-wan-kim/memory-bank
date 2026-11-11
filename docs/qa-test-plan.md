# QA Test Plan — 1.8.0 전수 감사·독립 검수 반영 (2026-11-11)

범위: 2026-11-10 전수 감사(8개 축, 발견 107건)에서 고치기로 한 것 — 사실 통합 정지, 추출 누락, 분류·관계, 검색·MCP 도구, 저장·색인·동기화, 주입·훅, 보안, 개발 밀폐 — 그리고 그 병합본을 실데이터 사본으로 독립 검수(8개 관점, 발견 74건)해 나온 것(AC-017~AC-022), 고친 뒤 다시 검수(6개 관점, 발견 39건)해 나온 것(AC-023~AC-024). 수용 기준 AC-001~AC-024.
대상: `src/`(통합·추출·온톨로지·검색·색인·동기화·주입·보안 모듈) · `scripts/`(훅·워커·정리 스크립트) · `hooks/hooks.json` · `ui/server.cjs` · 릴리스 1.8.0.
실행 표면: MCP 서버(stdio), SessionStart·SessionEnd·UserPromptSubmit 훅, CLI(`memory-bank index|search|show`), 로컬 웹 UI 서버(127.0.0.1 — JSON API 와 정적 페이지, 이번 변경은 서버 쪽 방어뿐이라 화면 변경 없음).
이전 plan(2026-11-02 네이티브 클라이언트)은 git 이력(`681c995`)에 있다.
이 plan 은 감사 발견에서 파생했고 구현 뒤에 문서로 옮겼다 — 각 TC 의 테스트는 구현과 함께(실패를 먼저 확인하고) 쓰였다.

## 수용 기준 매핑 (AC Coverage)

- AC-001: 사실 통합이 sqlite-vec KNN 한도(4,096) 안에서 다시 돈다 — 예전에 멈추던 조건을 지나가고, 실패는 이유와 함께 기록되며 같은 실패가 이어지면 물러난다 → TC-CONS-001, TC-CONS-002, TC-E2E-001
- AC-002: 통합이 내용이 마지막으로 말해진 시각 순서로 판정하고, 병합은 전부 아니면 전무이며, 문장이 바뀌면 벡터를 다시 만든다 → TC-CONS-003
- AC-003: 세션이 끝나면 색인 뒤에 추출하고, 긴 세션도 끝까지 추출하며, 같은 세션을 두 번 추출하지 않는다 → TC-EXT-001, TC-EXT-002
- AC-004: 자격증명 모양 문자열이 든 사실은 저장·가져오기 양쪽에서 거부하고, 템플릿·세션 환경 문장을 사실로 저장하지 않는다 → TC-EXT-003, TC-EXT-004
- AC-005: 같은 이름의 분류를 다시 만들지 않고, 저장당 분류 호출은 1회이며, 잘못된 방향의 SUPERSEDES 를 쓰지 않는다 → TC-ONT-001, TC-ONT-002
- AC-006: 검색이 기계 잡음을 기본으로 빼고(색인 쪽과 같은 판정), 필터를 건 검색이 결과를 잃지 않으며, 일치 표시가 실제와 같다 → TC-SRCH-001, TC-SRCH-002
- AC-007: MCP 도구가 stdio 서버에서 동작한다 — `read` 는 쪽을 나눠 읽고 보관 폴더 밖 경로를 같은 답으로 거부하며, `search_ontology` 출력은 상한을 넘지 않는다 → TC-MCP-001, TC-MCP-002, TC-NEG-002, TC-E2E-001
- AC-008: `index --rebuild` 는 사실·온톨로지를 지우지 않고, `index --repair` 는 묻지 않고 지우지 않는다 → TC-STORE-001, TC-STORE-002
- AC-009: 색인은 한 턴에 한 행이고, 변화 없는 대화를 다시 임베딩하지 않으며, 세션 시작 유지보수가 통계와 벡터 표를 맞춘다 → TC-STORE-003
- AC-010: 압축 뒤 주입 원장이 비워지고, 핵심 사실은 프로젝트 우선이며, 프롬프트 훅은 시간 예산 안에서만 대체 계산을 한다 → TC-INJ-001, TC-INJ-002
- AC-011: 웹 UI 서버는 이 기기에서만 닿고(Host·Origin 검사, 상한), SDK 세션은 격리되며, 색인 파일은 소유자 전용이고, 가져오기는 지시문 꼴 문장을 받지 않는다 → TC-SEC-001, TC-SEC-002
- AC-012: 테스트는 실제 대화 DB 를 열지 않고, dist 가 소스와 다르면 테스트가 시작되지 않는다 → TC-DEV-001
- AC-013: 정리 스크립트는 기본이 미리 보기이고 그때 DB 를 바꾸지 않으며, 깨진 입력·모르는 인자는 조용히 넘어가지 않는다 → TC-SCR-001, TC-NEG-001
- AC-014: `npm run build` rc 0 · dist 가 소스와 같다 · `npm test` 전체 통과 → TC-BUILD-001
- AC-015: 릴리스 1.8.0 — 버전 3곳·CHANGELOG·태그·GitHub 릴리스·설치 캐시 → TC-REL-001
- AC-016: 라이브 — 설치본 1.8.0 이 실제 색인에서 통합을 다시 진행시키고(실패 기록 없이 커서 전진 또는 사유 기록), 훅과 MCP 도구가 동작한다 → TC-E2E-001
- AC-017: 통합이 문장을 다시 쓴 사실이 한국어 질의에서 빠지지 않는다 — 한국어 문장·한국어 벡터를 새 문장 것으로 채우고, 예전에 잃은 것은 되찾으며, 판정 사이에 바뀐 쌍·앞선 시각이 적힌 상태 파일에서 조용히 틀리지 않는다 → TC-R2-001
- AC-018: 비밀값 검사가 봇 API 주소 안의 토큰·웹훅 주소·접두 있는 키·접속 주소의 비밀번호를 잡고, 저장·가져오기·내보내기 세 경로가 같은 판정을 쓰며, 가져오기는 category·횟수·이름 칸도 검사한다 → TC-R2-002
- AC-019: 색인이 이미 있는 온전한 행을 잃지 않는다 — 늦은 짧은 사본·끝이 잘린 보관 파일·번호가 어긋난 분류 응답에서 지우거나 잘못 붙이지 않고, 정리 도구가 쓰기 잠금을 오래 쥐지 않으며, 미리 보기는 큰 DB 에서도 끝난다 → TC-R2-003
- AC-020: 에이전트 필터 검색이 서버를 붙잡지 않고, 다중 개념 검색에서 의미 일치가 빠지지 않으며, `read` 가 긴 메시지와 잘린 도구 출력을 끝까지 읽게 해 준다 → TC-R2-004
- AC-021: 소켓 경로가 한도를 넘는 설치에서도 MCP 서버가 뜨고, 데몬이 남의 살아 있는 소켓을 지우지 않으며, 공백 든 설치 경로에서 훅이 돈다 → TC-R2-005
- AC-022: 새로 받은 저장소에서 `npm install` 뒤 `npm test` 가 돌고, 대시보드 첫 화면이 큰 DB 에서 응답하며, 배포되는 명령 문서에 개발자 기기 경로·자격증명 읽기·포트로 끝내기가 없고, 버전 표기 세 곳이 같다 → TC-R2-006
- AC-023: 다시 검수해 나온 회귀가 고쳐졌다 — `read` 가 맺음 줄대로 이어 읽으면 같은 쪽을 되풀이하지 않고, 다중 개념 검색의 낱말 일치가 키워드 순서를 지키며, 옛 버전이 색인을 되살려도 추출이 느려지지 않고, 꼬리 바이트가 붙은 보관 파일이 읽히며, rebuild 뒤에도 사실의 출처가 풀린다 → TC-R3-001, TC-R3-002, TC-R3-004
- AC-024: 비밀값 판정이 식별자(UUID·해시)를 자격증명으로 보지 않고, 동기화 파일은 쓸 때마다 소유자 전용이며, 바뀐 것이 없는 내보내기는 다시 판정하지 않고, 출력의 category 는 다섯 이름뿐이다 → TC-R3-003, TC-R3-005

## 공통 전제 조건

- `npm run build` 뒤 `dist/` 가 소스와 같다(`npm test` 의 pretest 가 확인한다 — 다르면 시작하지 않는다).
- 테스트는 `test/setup.ts` 가 정한 임시 설정 폴더에서만 돈다. 실제 대화 DB 경로를 열려 하면 `src/test-guard.ts` 가 막는다.
- LLM 호출은 가짜(`test/helpers/fake-agent-sdk*.mjs`)로 대체한다. 실제 호출·과금 없음.
- 실데이터 항목(TC-E2E-001 의 사본 다리, 레벨2·3)은 운영 DB 의 `.backup` 사본에서만 돈다. 대화 본문·사실 문장은 출력하지 않는다(건수·id 앞 8자만). 로그 전문은 `.qa-artifacts/`.
- 라이브 항목(TC-REL-001·TC-E2E-001 의 설치본 다리)은 릴리스 뒤 사용자 디렉터리와 GitHub 릴리스를 읽는다.

## 레벨1 시나리오 (TC-*)

### CONS: 사실 통합

#### TC-CONS-001: 후보 검색이 KNN 한도를 넘지 않는다
**심각도**: CRITICAL
- Given: 같은 범위에 사실이 한도보다 많이 있는 DB(예전에는 k=12,800 을 요청해 매번 실패)
- When: 통합 후보 검색 실행
- Then: 요청 k 가 4,096 을 넘지 않고, 후보가 문턱 아래로 내려가면 일찍 끝나며, 한도에 닿으면 알린다
- verify: `npx vitest run test/consolidate-knn-cap.test.ts` / evidence: 테스트 이름

#### TC-CONS-002: 실패가 기록되고 같은 실패가 이어지면 물러난다
**심각도**: HIGH
- Given: 통합 워커, 실패하는 LLM·깨진 상태 파일·보류 사실 0건
- When: 워커와 SessionStart 훅 실행
- Then: 로그에 `worker: ERROR fact=… kind=… msg=…`, 상태 파일에 연속 실패 수, 5회 뒤 다음 시도 간격이 5분부터 최대 6시간으로 벌어진다; 보류 사실이 없으면 워커를 띄우지 않는다
- verify: `npx vitest run test/consolidate-errors.test.ts test/consolidate-health.test.ts test/consolidate-hook-gate.test.ts` / evidence: 테스트 이름

#### TC-CONS-003: 판정 방향·병합 원자성·재임베딩
**심각도**: CRITICAL
- Given: 생성 시각이 다른 사실 쌍, 영어·한국어로 적힌 같은 내용, 병합·대체·유지 판정을 돌려주는 가짜 LLM
- When: 통합 적용
- Then: '기존/새' 방향이 내용이 마지막으로 말해진 시각 순서로 정해진다; 병합은 확인 횟수 합산·출처 합치기·벡터 행 정리가 한 트랜잭션이다(중간 실패 시 변화 없음); 문장이 바뀐 사실은 새 벡터를 갖는다(한국어 쪽은 TC-R2-001)
- verify: `npx vitest run test/consolidate-apply.test.ts test/consolidate-worker.test.ts test/consolidate-kr-candidates.test.ts` / evidence: 테스트 이름

### EXT: 사실 추출

#### TC-EXT-001: 색인 뒤에 추출하고, 색인이 없으면 완료로 표시하지 않는다
**심각도**: CRITICAL
- Given: 아직 색인되지 않은 세션의 종료 신호
- When: 추출 워커 실행
- Then: 그 세션을 먼저 색인한 뒤 추출한다; 색인된 대화가 없으면 '0건 완료' 표식을 쓰지 않아 다음 backfill 이 다시 집는다
- verify: `npx vitest run test/extraction-index-lag.test.ts test/fact-extract-worker-execution.test.ts` / evidence: 테스트 이름

#### TC-EXT-002: 긴 세션 끝까지·반복 종료·조용한 시간
**심각도**: HIGH
- Given: 구간이 여러 개인 긴 세션, 같은 세션의 종료 신호 2회, 진행 중인 세션
- When: 추출과 backfill 실행
- Then: 모든 구간이 처리되고 세션당 상한은 구간 수에 비례한다(호출 상한 `MEMORY_BANK_MAX_EXTRACT_CALLS`); 새 대화가 없으면 다시 추출하지 않는다; 마지막 대화 뒤 60분이 안 된 세션은 backfill 이 건너뛴다
- verify: `npx vitest run test/extraction-fact-cap.test.ts test/extraction-repeat-session-end.test.ts test/extraction-quiet-period.test.ts` / evidence: 테스트 이름

#### TC-EXT-003: 자격증명 모양 문자열이 든 사실은 저장되지 않는다
**심각도**: CRITICAL
- Given: 여러 제공자의 키·토큰·개인키 블록 모양 문자열이 든 사실(합성 값)
- When: 추출 저장 경로와 sync 가져오기 경로에 넣는다
- Then: 양쪽 모두 저장하지 않고, 로그에는 건수와 종류만 남으며 문자열은 남지 않는다
- verify: `npx vitest run test/secret-scan.test.ts test/extraction-secret-reject.test.ts` / evidence: 테스트 이름

#### TC-EXT-004: 템플릿·세션 환경 문장 거부, category 접기, worktree 범위
**심각도**: MEDIUM
- Given: 추출 프롬프트의 예시 문장, '프로젝트는 …에 있다' 꼴 문장, 다섯 분류 밖의 category 이름, worktree 경로에서 끝난 세션
- When: 저장
- Then: 템플릿·환경 문장은 사유별 건수와 함께 거부, category 는 가까운 분류로 접힘, 프로젝트 사실은 본 저장소 범위
- verify: `npx vitest run test/extraction-fact-hygiene.test.ts test/fact-validity.test.ts test/extraction-worktree-scope.test.ts` / evidence: 테스트 이름

### ONT: 분류·관계

#### TC-ONT-001: 분류 재사용과 배치 분류
**심각도**: HIGH
- Given: 대소문자·공백·구두점만 다른 분류 이름, 다른 도메인으로 답하는 가짜 분류기, 한 번에 저장되는 사실 20건
- When: 저장 시점 분류
- Then: 기존 분류를 재사용하고 새 행을 만들지 않는다; 분류 호출은 저장당 1회; 응답에 빠진 사실만 다음 백필 대상으로 남는다
- verify: `npx vitest run test/ontology-name-key.test.ts test/ontology-category-reuse.test.ts test/ontology-batch-save.test.ts` / evidence: 테스트 이름

#### TC-ONT-002: SUPERSEDES 방향 가드
**심각도**: HIGH
- Given: 한 추출에서 나온 사실 쌍, 반대 방향 관계가 이미 있는 쌍, 자기 자신
- When: 관계 저장
- Then: 셋 다 SUPERSEDES 를 쓰지 않는다; 정상 개정(나중 사실이 앞선 사실을 대체)은 저장된다
- verify: `npx vitest run test/ontology-relation-guards.test.ts` / evidence: 테스트 이름

### SRCH: 검색

#### TC-SRCH-001: 기계 잡음 제외와 색인·검색 판정 일치
**심각도**: CRITICAL
- Given: 사람 턴과 기계 턴(서브에이전트 워밍업·관찰자 프롬프트)이 섞인 색인
- When: 기본 검색과 `include_noise` 검색; 같은 (메시지, 사이드체인) 격자에 색인 쪽 함수와 검색 쪽 SQL 조건을 적용
- Then: 기본 검색 결과에 기계 턴이 없고 `include_noise` 로 돌아온다; 두 판정이 격자 전체에서 같은 답을 낸다
- verify: `npx vitest run test/noise.test.ts test/noise-search-parity.test.ts test/search-noise-fold.test.ts` / evidence: 테스트 이름

#### TC-SRCH-002: 필터 검색·일치 표시·다중 개념·CLI
**심각도**: HIGH
- Given: 날짜·에이전트 필터에 맞는 행이 가까운 후보 밖에 있는 색인, 키워드로만 찾아지는 행, 모든 낱말이 한 교환에 든 다중 개념 질의
- When: 의미·키워드·both 검색, json 응답, CLI
- Then: 필터에 맞는 행이 결과에 나온다(모자라면 잘렸다고 적는다); 키워드 행은 'keyword match'; both 는 limit 만큼; 다중 개념은 모든 낱말이 든 교환을 먼저; json 응답은 발췌와 이어 읽을 위치; CLI 는 모르는 옵션을 오류로 끝낸다
- verify: `npx vitest run test/search-filter-overfetch.test.ts test/multi-concept.test.ts test/search-multi-concept-keyword.test.ts test/search-json.test.ts test/search-cli.test.ts` / evidence: 테스트 이름

### MCP: 도구

#### TC-MCP-001: stdio 서버에서 도구가 동작한다
**심각도**: CRITICAL
- Given: 빌드된 MCP 서버를 자식 프로세스로 띄운다(임시 설정 폴더)
- When: 도구 목록 조회, `read`(범위·쪽 나눔), 보관 폴더 밖 경로(파일이 있는 경우와 없는 경우)
- Then: 등록된 도구 이름이 문서·에이전트가 가리키는 이름과 같다; `read` 는 요청한 줄 범위만 돌려주고 이어 읽을 줄 번호를 알려 준다; 밖 경로는 파일 유무와 무관하게 같은 답
- verify: `npx vitest run test/mcp-server-stdio.test.ts test/read-guard.test.ts test/read-range.test.ts test/mcp-tool-names.test.ts` / evidence: 테스트 이름

#### TC-MCP-002: search_ontology 상한과 사실 도구의 범위 적용
**심각도**: HIGH
- Given: 분류가 수천 개인 모양의 DB, 다른 프로젝트에 더 가까운 사실이 있는 DB
- When: `search_ontology`(필터 없음·domain·category), `search_facts`·`trace_fact`·`explore_graph`
- Then: 출력이 20,000자를 넘지 않고 필터가 없으면 건수만; 프로젝트 범위가 후보를 자르기 전에 적용돼 범위 안 사실이 나온다
- verify: `npx vitest run test/ontology-browse.test.ts test/facts-tool.test.ts test/mcp-facts.test.ts` / evidence: 테스트 이름

### STORE: 저장·색인·동기화

#### TC-STORE-001: rebuild 가 사실 층을 지우지 않는다
**심각도**: CRITICAL
- Given: 사실·온톨로지·태그가 있는 DB, 보관 폴더에 없는 대화의 색인 행
- When: `index --rebuild`(기본·`--allow-index-loss`)
- Then: DB 파일을 지우지 않고 대화 색인만 다시 만든다; 사실·온톨로지·태그 행 수 불변; 되살릴 수 없는 행이 있으면 기본은 아무것도 바꾸지 않고 멈춘다
- verify: `npx vitest run test/rebuild.test.ts test/index-cli-safety.test.ts` / evidence: 테스트 이름

#### TC-STORE-002: repair 는 묻지 않고 지우지 않는다
**심각도**: CRITICAL
- Given: 하위 폴더에 파일이 있는 색인 행, 파일이 없는 색인 행
- When: `index --repair`(기본·`--prune-missing`·문턱 초과)
- Then: 파일이 실제로 있으면 고아가 아니다; 기본은 보고만; `--prune-missing` 은 백업 뒤 삭제; 전체의 5%를 넘으면 `--yes` 없이는 멈춘다
- verify: `npx vitest run test/verify-repair-safety.test.ts test/verify.test.ts` / evidence: 테스트 이름

#### TC-STORE-003: 한 턴 한 행·증분 동기화·유지보수
**심각도**: HIGH
- Given: 자라는 대화 파일, 변화 없는 대화, 도구 호출이 있는 대화, 통계가 없는 DB
- When: 같은 파일을 여러 번 동기화, 세션 시작 유지보수
- Then: 같은 턴이 두 행이 되지 않는다; 변화 없는 대화는 다시 임베딩하지 않는다; 도구 호출 행이 재색인마다 늘지 않는다; 유지보수가 ANALYZE 를 돌리고 벡터 표를 사실 표와 맞춘다; 동기화마다 로그 한 줄
- verify: `npx vitest run test/snapshot-dedupe.test.ts test/sync-incremental.test.ts test/exchange-store.test.ts test/db-maintenance.test.ts test/sync-log.test.ts test/session-start-maintenance.test.ts` / evidence: 테스트 이름

### INJ: 주입·훅

#### TC-INJ-001: 압축 뒤 주입 원장 초기화
**심각도**: HIGH
- Given: 사실이 주입된 세션, SessionStart(`compact`) 신호
- When: 원장 초기화 훅 실행 뒤 같은 프롬프트
- Then: 원장이 비워져 같은 사실이 다시 주입된다; 원장에 쓰는 코드는 정해진 기록자뿐이다
- verify: `npx vitest run test/ledger-reset-compact.test.ts test/ledger-writers.test.ts` / evidence: 테스트 이름

#### TC-INJ-002: 핵심 사실 선택·훅 예산·데몬 소켓·버전 점검·내보내기
**심각도**: HIGH
- Given: 프로젝트 사실과 전역 사실이 섞인 DB, 응답하지 않는 데몬, 죽은 소켓 파일, 원격 태그 조회가 막힌 환경
- When: 세션 시작 블록 생성, 프롬프트 훅, 데몬 시작, 버전 점검, 변화 없는 내보내기
- Then: 프로젝트 사실 먼저·전역 최대 3건; 남은 예산이 모자라면 대체 계산을 시작하지 않고 사유를 남긴다; 죽은 소켓만 치운다; 버전 점검은 JSON 한 줄이고 원격 실패가 훅을 붙잡지 않는다; 변화 없는 내보내기는 파일을 쓰지 않는다
- verify: `npx vitest run test/top-facts-selection.test.ts test/inject-fallback-budget.test.ts test/inject-daemon-reclaim.test.ts test/version-drift-check.test.ts test/sync-export-unchanged.test.ts` / evidence: 테스트 이름

### SEC: 보안

#### TC-SEC-001: 웹 UI 서버는 이 기기에서만 닿는다
**심각도**: CRITICAL
- Given: `ui/server.cjs` 를 임시 포트로 띄운다
- When: 다른 Host·다른 Origin·프록시 헤더가 붙은 요청, `limit=-1`, 1MB 넘는 본문, 토큰 없이 다른 주소에 열기
- Then: 127.0.0.1 에만 열리고 CORS 헤더가 없다; 다른 Host·Origin 은 403; `limit=-1` 은 400; 토큰 없이는 다른 주소에 열리지 않는다; 웹 요청이 띄우는 SDK 세션은 설정·도구 없이 한 턴
- verify: `npx vitest run test/ui-server.test.ts test/ui-llm-isolation.test.ts test/replacement-os-publication.test.ts` / evidence: 테스트 이름

#### TC-SEC-002: 파일 권한·가져오기 지시문 검사·HTML 내보내기
**심각도**: HIGH
- Given: 0755/0644 로 만들어진 색인 폴더와 DB, 지시문 꼴 문장이 든 가져오기 파일, HTML·스크립트 문자열이 든 대화
- When: DB 를 처음 연다, sync 가져오기, `show --format html`
- Then: 폴더 0700·DB 0600 으로 좁혀지고 표식이 남는다(심링크는 따라가지 않는다); 지시문 꼴 문장은 사실로 받지 않고 건수를 보고하며 받은 사실에는 출처가 기록된다; HTML 내보내기에서 원시 HTML 은 글자로 나온다
- verify: `npx vitest run test/file-perms.test.ts test/import-guard.test.ts test/show.test.ts` / evidence: 테스트 이름

### DEV·SCR·BUILD·REL

#### TC-DEV-001: 테스트 밀폐와 dist 신선도
**심각도**: HIGH
- Given: 실제 대화 DB 경로를 여는 코드, 소스와 다른 dist
- When: 테스트 환경에서 실행, 신선도 검사 실행
- Then: 실제 경로를 열면 실패한다; dist 가 다르면 'npm run build 먼저' 로 멈춘다
- verify: `npx vitest run test/test-guard.test.ts test/check-dist-fresh.test.ts` / evidence: 테스트 이름

#### TC-SCR-001: 정리 스크립트의 기본은 미리 보기다
**심각도**: HIGH
- Given: 정리 대상이 있는 임시 DB
- When: 스크립트 6종을 인자 없이, 그리고 실행 인자와 함께 돌린다
- Then: 인자 없이는 대상만 보여 주고 DB 가 바뀌지 않는다; 실행 시 백업·되돌리기 수단이 생기고 결과가 미리 보기 수치와 같다
- verify: `npx vitest run test/dedupe-exact-facts.test.ts test/reembed-rewritten.test.ts test/requeue-zero-markers.test.ts test/redact-secret-facts.test.ts test/purge-llm-sessions.test.ts test/merge-singleton-categories.test.ts` / evidence: 테스트 이름

#### TC-BUILD-001: 빌드와 전체 테스트
**심각도**: CRITICAL
- Given: 릴리스 커밋의 작업 트리
- When: `npm run build` 뒤 `npm test`
- Then: 빌드 rc 0, 빌드 뒤 `git status --porcelain dist` 가 비어 있다(커밋된 dist 가 소스와 같다), 전체 테스트 실패 0
- verify: `npm run build && git status --porcelain dist && npm test` / evidence: `.qa-artifacts/test-full.log`

#### TC-REL-001: 릴리스 표면 정렬
**심각도**: HIGH
- Given: 릴리스 커밋
- When: 버전 표면 조회
- Then: `package.json`·`.claude-plugin/plugin.json`·`.claude-plugin/marketplace.json` 이 1.8.0, CHANGELOG 에 1.8.0 항목, 원격 태그 `v1.8.0` 이 릴리스 커밋, GitHub 릴리스가 최신, 이 기계의 설치 캐시가 1.8.0
- verify: `gh release view v1.8.0 --json tagName,isDraft` + `git ls-remote --tags origin v1.8.0` + 설치 캐시 폴더 확인 / evidence: `.qa-artifacts/release.log`

### R2: 독립 검수 뒤 수정

#### TC-R2-001: 다시 쓰인 사실의 한국어 문장·벡터, 판정 순서, 상태 파일
**심각도**: HIGH
- Given: 문장을 다시 쓰는 판정을 돌려주는 가짜 LLM, 한국어 문장이 있는 사실 쌍, 판정을 기다리는 사이 한쪽이 꺼진 쌍, 시계보다 앞선 시각이 적힌 물러나기 기록·커서
- When: 통합 적용, 통합 워커 실행
- Then: 다시 쓰인 사실에 새 문장의 한국어 문장과 한국어 벡터가 있다(판정이 주지 않으면 비우고 `kr_missing` 으로 센다); 예전에 잃은 한국어 문장을 꺼진 사실에서 되찾는다; 방향은 내용 시각으로 정한다; 바뀐 쌍의 판정은 적용하지 않는다; 앞선 시각은 당기고 로그에 남긴다
- verify: `npx vitest run test/consolidate-kr-carry.test.ts test/fact-kr-restore.test.ts test/consolidate-content-order.test.ts test/consolidate-stale-pair.test.ts test/consolidate-fresh-driver.test.ts test/consolidate-clock.test.ts` / evidence: 테스트 이름

#### TC-R2-002: 비밀값 형식과 세 경로의 같은 판정
**심각도**: CRITICAL
- Given: 봇 API 주소 안의 토큰·웹훅 주소·접두 있는 키·비밀번호가 든 접속 주소 꼴의 지어낸 문자열, category·횟수·이름 칸에 지시문이나 범위 밖 값이 든 가져오기 파일
- When: 사실 저장, 동기화 가져오기, 동기화 내보내기
- Then: 세 경로 모두 그 사실을 거부하거나 싣지 않고 건수와 종류만 남긴다; 가져오기는 category 를 다섯 이름으로 접고 횟수를 1~100 으로 받으며 지시문 꼴 칸을 거부한다; 넘긴 줄은 사유별로 로그에 남는다
- verify: `npx vitest run test/secret-scan.test.ts test/secret-shapes-all-paths.test.ts test/sync-export-withheld.test.ts test/sync-import-skips.test.ts test/import-guard.test.ts test/redact-secret-facts.test.ts test/file-perms.test.ts` / evidence: 테스트 이름

#### TC-R2-003: 색인이 온전한 행을 잃지 않고 잠금을 오래 쥐지 않는다
**심각도**: CRITICAL
- Given: 같은 턴의 더 짧은 늦은 사본, 끝이 잘린 `.zst` 보관 파일, 번호가 빠지거나 겹친 배치 분류 응답, 다른 연결이 쓰기를 기다리는 DB, `run-locks` 폴더가 없는 기기
- When: 색인(sync), `index --rebuild`, 턴 사본 접기, `--prune-missing`, `requeue-zero-markers` 미리 보기와 `--apply`
- Then: 온전한 행이 남는다; 잘린 보관 파일은 읽기 오류이고 rebuild 가 그 행을 지우지 않는다; 번호가 어긋난 응답은 적용되지 않는다; 다른 연결이 5초 안에 쓰기 잠금을 얻는다; sync 가 폴더를 만들고 돈다
- verify: `npx vitest run test/snapshot-replace.test.ts test/truncated-archive.test.ts test/archive-io.test.ts test/ontology-batch-numbering.test.ts test/maintenance-locks.test.ts test/sync-lock.test.ts test/requeue-zero-markers.test.ts test/index-cli-safety.test.ts test/verify-repair-safety.test.ts` / evidence: 테스트 이름

#### TC-R2-004: 에이전트 필터·다중 개념·read 이어 읽기
**심각도**: HIGH
- Given: 행이 적은 `coding_agent` 값과 색인에 없는 값, 낱말 일치가 `limit` 을 채우는 다중 개념 질의, 40,000자를 넘는 한 메시지와 2,000자를 넘는 도구 출력이 든 대화
- When: `search`, `read`(맺음 줄이 알려 주는 값으로 이어 읽기, `full: true`)
- Then: 필터 검색이 벡터 색인을 상한까지 훑지 않는다; 의미 일치 대화가 결과에 든다; 쪽을 이어 붙이면 전체와 같고 한글 경계가 깨지지 않는다
- verify: `npx vitest run test/search-agent-filter-plan.test.ts test/search-filter-overfetch.test.ts test/multi-concept.test.ts test/search-multi-concept-keyword.test.ts test/read-continue.test.ts test/read-range.test.ts test/mcp-server-stdio.test.ts` / evidence: 테스트 이름

#### TC-R2-005: 긴 소켓 경로·남의 소켓·공백 든 경로·스위치
**심각도**: HIGH
- Given: 소켓 이름이 유닉스 소켓 한도를 넘는 설정 폴더, 다른 버전 이름의 살아 있는 소켓, 공백이 든 플러그인 경로, 훅 환경에만 둔 주입 끄기 스위치
- When: MCP 서버 시작, 데몬의 소켓 되찾기, `hooks/hooks.json` 의 명령 실행, 프롬프트 훅
- Then: 서버가 initialize 에 답한다(데몬 없이 훅이 직접 계산, 사유 기록); 살아 있는 남의 소켓은 남는다; 훅이 돈다; 주입이 꺼진다
- verify: `npx vitest run test/inject-daemon-long-socket-path.test.ts test/inject-daemon-retry.test.ts test/inject-daemon-reclaim.test.ts test/inject-daemon-socket.test.ts test/hooks-json-quoting.test.ts test/inject-host-switch-client.test.ts test/version-drift-check.test.ts test/build-native-client.test.ts` / evidence: 테스트 이름

#### TC-R2-006: 새 클론의 pretest·대시보드 첫 화면·명령 문서·버전 표기
**심각도**: HIGH
- Given: 의존성 판이 다른 새 클론 모양의 번들, 대화·도구 호출이 많은 DB, 배포되는 `commands/*.md`, 버전이 적힌 세 파일
- When: 신선도 검사, `/api/graph-data` 요청, 명령 설치 스크립트, 버전 일치 테스트
- Then: 번들은 빌드 표식으로 판정되고 소스가 바뀌면 막는다(심링크 `node_modules` 로 만든 번들은 거부); 응답이 수 초 안에 오고 행이 같다; 명령 문서에 사용자 홈 절대 경로·자격증명 파일 읽기·포트로 끝내기가 없다; 세 파일과 CHANGELOG 의 버전이 같다
- verify: `npx vitest run test/check-dist-fresh.test.ts test/ui-graph-data.test.ts test/install-commands.test.ts test/shipped-commands-hygiene.test.ts test/version-consistency.test.ts test/live-apply.test.ts` / evidence: 테스트 이름

### R3: 다시 검수한 뒤 수정

#### TC-R3-001: read 맺음 줄대로 이어 읽기·다중 개념 순서·날짜 범위·인자 생략
**심각도**: HIGH
- Given: 한 번의 응답보다 긴 메시지가 든 대화, 모든 낱말이 든 대화가 여럿인 다중 개념 질의, `after` 가 `before` 와 같거나 더 뒤인 날짜 범위, `arguments` 를 뺀 `tools/call`
- When: `read`(맺음 줄이 이름 붙인 값을 전부 넘겨 이어 읽기, `startLine` 만 넘기기), `search`, 인자 없는 도구 호출
- Then: 맺음 줄의 값으로 끝까지 읽힌다; `startLine` 만 넘긴 응답은 같은 쪽이 다시 온다는 것과 건너뛸 줄을 적는다; 문서가 인용한 맺음 줄이 실제 출력과 같다; 낱말 일치 목록은 키워드 순서 그대로다; 빈 날짜 범위는 임베딩 전에 오류다; 인자를 뺀 호출에 서버가 답한다
- verify: `npx vitest run test/read-footer-docs.test.ts test/read-continue.test.ts test/search-multi-concept-keyword.test.ts test/search-date-range.test.ts test/mcp-server-stdio.test.ts` / evidence: 테스트 이름

#### TC-R3-002: 되살아난 색인·세션 판정·한국어 문장 되찾기 재시도·통합 잠금
**심각도**: HIGH
- Given: 옛 버전이 `idx_facts_active` 를 되살린 DB, 선색인이 실패한 세션, 쓰기 잠금으로 실패한 한국어 문장 되찾기, 죽은 pid 의 통합 잠금과 동시에 시작한 워커 여럿
- When: 사실 추출의 분류별·범위별 사실 수 조회, backfill 대상 판정, 통합 워커와 `reembed-rewritten-facts --fact-kr clear`, 잠금 획득
- Then: 그 조회가 되살아난 색인을 타지 않고 값이 같다; 판정이 그 세션의 대화만 읽는다; 실패한 되찾기는 다음 실행에서 다시 하고 `clear` 는 끝에 되찾기를 돌린다; 쥔 구간이 겹치지 않는다
- verify: `npx vitest run test/facts-active-index-back.test.ts test/pending-extraction-session.test.ts test/fact-kr-restore.test.ts test/reembed-rewritten.test.ts test/consolidate-lock.test.ts test/consolidate-content-order.test.ts test/fact-extract-worker-execution.test.ts` / evidence: 테스트 이름

#### TC-R3-003: 식별자 오탐·환경변수 이름 꼴·동기화 파일 권한·판정 재사용
**심각도**: HIGH
- Given: 키워드 바로 뒤에 UUID·해시가 온 문장과 값이라고 밝힌 문장, 접미가 붙은 대문자 환경변수 이름 대입, 0644 로 남은 동기화 파일, 바뀐 것이 없는 사실 집합, 같은 문장이 이미 있는 가져오기 파일
- When: 사실 저장 판정, 동기화 내보내기·가져오기, `redact-secret-facts --apply` 와 `--undo`
- Then: 식별자는 받고 값이라고 밝힌 문장·환경변수 대입은 거부한다; 내보내기가 쓰는 파일은 쓸 때마다 0600 이다; 바뀐 것이 없으면 판정 0회이고 내용·판정 코드가 바뀌면 다시 판정한다; 들이지 않은 같은 문장 건수가 결과와 로그에 남는다; 전부 되돌리면 벡터 백업 표가 없어진다
- verify: `npx vitest run test/secret-scan.test.ts test/sync-export-perms.test.ts test/sync-export-judgment-reuse.test.ts test/sync-import-skips.test.ts test/sync-hook-messages.test.ts test/redact-secret-facts.test.ts` / evidence: 테스트 이름

#### TC-R3-004: 꼬리 바이트가 붙은 보관 파일·rebuild 뒤 사실 출처·출처 옮기기 묶음
**심각도**: HIGH
- Given: 온전한 zstd 프레임 뒤에 프레임이 아닌 바이트가 붙은 `.zst`, 미완 프레임이 붙거나 중간에서 끝난 `.zst`, 옛 턴 사본을 출처로 지목하는 사실, 다른 연결이 쓰기를 기다리는 DB, 1부터 센 배치 분류 응답
- When: 보관 파일 읽기와 `index-conversations --verify`, `index --rebuild`, 턴 사본 접기 `--apply`, `requeue-zero-markers --apply`, 배치 분류
- Then: 꼬리 바이트 파일은 온전한 프레임까지 읽히고 verify 가 따로 한 줄로 알린다(미완 프레임·중간 잘림은 계속 읽기 오류); rebuild 뒤 사실의 출처가 남는 사본을 가리킨다; 출처 옮기기가 짧은 묶음으로 나뉜다; 1부터 빠짐없이 센 응답은 적용되고 다시 묻는 횟수가 n+3 을 넘지 않는다
- verify: `npx vitest run test/archive-io.test.ts test/truncated-archive.test.ts test/rebuild.test.ts test/snapshot-dedupe.test.ts test/ontology-batch-numbering.test.ts test/requeue-zero-markers.test.ts` / evidence: 테스트 이름

#### TC-R3-005: 출력의 category·삭제 묶음·문서와 서버의 도구 목록·새 클론의 첫 테스트·대시보드 기억
**심각도**: MEDIUM
- Given: category 칸에 줄바꿈·긴 문자열이 든 사실, 지울 행이 많은 DB, `CLAUDE.md`·`CODEX.md` 의 도구 목록, 재생 뒤에 모델 캐시 파일이 생긴 벤치 폴더, 항목이 많은 임시 폴더, 바뀌지 않은 DB
- When: 주입 블록·세션 시작 블록 출력, `purge-llm-sessions --apply`, 프로필 문서 대조, 주입 보고, 신선도 검사 테스트, `/api/graph-data` 두 번 요청
- Then: 블록의 category 는 다섯 이름 중 하나다; 삭제가 묶음으로 끊긴다; 문서의 도구 목록이 서버 등록 목록과 같다; 모델 캐시만 달라진 보고는 멈추지 않고 소스가 바뀌면 멈춘다; 픽스처가 붐비는 폴더 밖에 만들어진다; 둘째 응답이 같은 `computedAt` 이고 다른 연결이 쓴 뒤에는 다시 계산한다
- verify: `npx vitest run test/category-label-output.test.ts test/purge-llm-sessions-locks.test.ts test/e2e-native-inject-live-socket.test.ts test/project-profile-tools.test.ts test/inject-report.test.ts test/check-dist-fresh.test.ts test/ui-graph-data.test.ts test/version-drift-check.test.ts` / evidence: 테스트 이름

### NEG: 실패 경로

#### TC-NEG-001: 깨진 입력을 조용히 넘기지 않는다
**심각도**: HIGH
- Given: 손상된 통합 상태 파일, 모르는 CLI 옵션·잘못된 날짜, 모르는 스크립트 인자(`--dryrun`)
- When: 워커·CLI·스크립트 실행
- Then: 상태 파일 손상은 기본값으로 이어 가되 기록이 남는다; CLI·스크립트는 실행 전에 오류로 끝난다(예전: 무시하고 실제 병합)
- verify: `npx vitest run test/consolidate-health.test.ts test/search-cli.test.ts test/index-cli-safety.test.ts test/merge-singleton-categories.test.ts` / evidence: 테스트 이름

#### TC-NEG-002: read 의 범위 오류 응답
**심각도**: MEDIUM
- Given: 줄 수보다 큰 시작 줄, 끝이 시작보다 앞선 범위
- When: `read` 호출
- Then: 총 줄 수와 함께 오류로 답하고 서버는 계속 응답한다
- verify: `npx vitest run test/read-range.test.ts test/mcp-server-stdio.test.ts` / evidence: 테스트 이름

### E2E

#### TC-E2E-001: 설치 형태로 실데이터에서 세션 한 바퀴
**심각도**: CRITICAL
**대상**: ① 릴리스 전: 릴리스 커밋의 트리를 운영 DB 사본(`.backup`)에 붙인다 ② 릴리스 뒤: 이 기계의 설치 캐시 1.8.0 과 실제 색인. 배포 URL: 해당 없음(로컬 플러그인 — `post_deploy` 는 `not_applicable` + 사유)
**여정 단계**:
1. DB 를 새 코드로 처음 연다 — 스키마 변경·유지보수가 끝나고 사실·관계·분류·대화 턴 행 수가 줄지 않는다(문서화된 벡터 행 정리 제외)
2. `hooks/hooks.json` 에 등록된 명령 문자열 그대로 SessionStart 훅들을 실행한다 — exit 0, 핵심 사실 블록 출력
3. UserPromptSubmit 훅에 봉투를 넣는다 — exit 0, 블록 또는 `no-match`, timeout(30초) 안
4. MCP 서버(stdio)에서 `search`·`search_facts`·`read`·`search_ontology` 를 부른다 — 결과가 오고 기계 잡음이 섞이지 않는다
5. 통합 워커를 돌린다 — 예전에 멈추던 사실을 지나가거나(LLM 가능), LLM 이 막혀 있으면 사유가 기록되고 죽지 않는다
6. SessionEnd 훅 — 추출 워커가 뜨고 색인 뒤 추출 순서를 지킨다
**기대 결과**: 여정 무중단 완주, 행 수 보존, 훅 전부 exit 0, 로그에 대화 본문 없음
**증거**: `.qa-artifacts/e2e-copy.log`(사본 다리) · `.qa-artifacts/e2e-live.log`(설치본 다리)

## 시나리오 요약

| 카테고리 | TC | 건수 |
|---|---|---|
| CONS | TC-CONS-001·002·003 | CRITICAL ×2 · HIGH ×1 |
| EXT | TC-EXT-001·002·003·004 | CRITICAL ×2 · HIGH ×1 · MEDIUM ×1 |
| ONT | TC-ONT-001·002 | HIGH ×2 |
| SRCH | TC-SRCH-001·002 | CRITICAL ×1 · HIGH ×1 |
| MCP | TC-MCP-001·002 | CRITICAL ×1 · HIGH ×1 |
| STORE | TC-STORE-001·002·003 | CRITICAL ×2 · HIGH ×1 |
| INJ | TC-INJ-001·002 | HIGH ×2 |
| SEC | TC-SEC-001·002 | CRITICAL ×1 · HIGH ×1 |
| DEV·SCR·BUILD·REL | TC-DEV-001·TC-SCR-001·TC-BUILD-001·TC-REL-001 | CRITICAL ×1 · HIGH ×3 |
| R2 | TC-R2-001~006 | CRITICAL ×2 · HIGH ×4 |
| R3 | TC-R3-001~005 | HIGH ×4 · MEDIUM ×1 |
| NEG | TC-NEG-001·002 | HIGH ×1 · MEDIUM ×1 |
| E2E | TC-E2E-001 | CRITICAL ×1 |

총 38 TC — CRITICAL 13 · HIGH 22 · MEDIUM 3. E2E 1 · NEG 2.
검증 레벨 사다리: 레벨2 H-* 5건 · 레벨3 A-* 4건 (게이트 비계수)

## 테스트 실행 순서

1. 단위·통합(로컬): TC-BUILD-001 이 전체를 돈다 — 그 로그에서 TC 별 파일의 통과를 확인한다
2. 사본 다리: TC-E2E-001 ①
3. 릴리스: TC-REL-001
4. 라이브: TC-E2E-001 ②

## 레벨2 휴리스틱 체크리스트 (H-*)

#### H-001: 4GB 색인에 새 코드를 처음 붙여도 훅이 시간 제한 안에 끝난다
- 등급: HIGH
- 확인: 운영 DB 사본에서 첫 DB 열기·지연 마이그레이션·세션 시작 유지보수의 소요가 등록된 훅 timeout 안이고, 두 번째 실행은 변화가 없다(멱등)

#### H-002: 옛 버전 프로세스와 같은 DB 를 함께 써도 깨지지 않는다
- 등급: HIGH
- 확인: 새 코드가 연 DB 를 1.7.7·1.7.9 의 MCP 서버·훅이 읽고 쓸 때 오류·조용한 오기록이 없다; 기기 간 내보내기·가져오기가 두 버전 사이를 왕복한다

#### H-003: 새 거부 규칙이 정상 데이터를 버리지 않는다
- 등급: HIGH
- 확인: 운영 사본의 활성 사실 전부에 비밀값 검사·유효성 규칙·가져오기 지시문 검사를, 대화 턴 전부에 잡음 판정을 읽기 전용으로 적용해 사유별 건수를 센다 — 과잉 차단이면 규칙을 좁힌다

#### H-004: 문서의 수치와 환경변수가 코드·실측과 같다
- 등급: MEDIUM
- 확인: README·CLAUDE.md·CHANGELOG 가 새 환경변수·새 기본값·새 스크립트를 코드와 같게 적는다; 코드에 없는 것을 약속하지 않는다

#### H-005: 잘린 출력이 깨지지 않는다
- 등급: MEDIUM
- 확인: `read`·`search`(json)·`search_ontology`·Related 줄의 자르기가 한글 등 멀티바이트 글자 중간을 끊지 않고, 잘린 JSON 이 유효하며, 이어 읽는 방법이 응답에 있다

## 레벨3 적대 시나리오 (A-*)

#### A-001: read 도구 경로 우회
- 등급: CRITICAL
- 확인: 심링크·`..`·중복 슬래시·보관 폴더와 접두가 같은 형제 폴더·대소문자 변형으로 보관 폴더 밖 파일을 읽을 수 없고, 응답 차이로 파일 존재 여부를 알 수 없다

#### A-002: 웹 UI 서버 우회
- 등급: CRITICAL
- 확인: Host 헤더 위조(DNS 리바인딩), 다른 출처에서의 단순 POST, 프록시 헤더, 큰 본문·동시 연결, 비밀번호 추측 반복으로 대화 데이터에 닿거나 서버를 멈출 수 없다

#### A-003: 가져오기·저장 경로 주입
- 등급: HIGH
- 확인: 다른 기기에서 온 파일에 지시문 꼴 문장·자격증명 모양 문자열·HTML 을 섞어도 사실로 저장되지 않거나 실행 가능한 형태로 나가지 않는다; 검사를 피하는 변형(공백·유니코드·줄바꿈)을 시도한다

#### A-004: 동시 실행 경합
- 등급: HIGH
- 확인: 세션 두 개가 동시에 시작(유지보수·통합 워커·데몬 시작), 같은 세션 종료 신호 두 번, 색인 중 rebuild 가 겹쳐도 손상·중복 저장·영구 잠금이 없다

## 변경 이력

- 2026-11-11: 1.8.0 전수 감사 반영 범위로 새로 작성(이전 네이티브 클라이언트 plan 은 git 이력 `681c995`).
- 2026-11-11: 병합본 독립 검수(8개 관점, 발견 74건) 뒤 수정 라운드의 수용 기준 AC-017~AC-022 와 TC-R2-001~006 추가, AC-002·TC-CONS-003 의 판정 순서·한국어 문장 서술을 수정 뒤 동작으로 고침.
- 2026-11-11: 고친 병합본을 다시 검수(6개 관점, 발견 39건)한 뒤의 수정분으로 AC-023~AC-024 와 TC-R3-001~005 추가.
