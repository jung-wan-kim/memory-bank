---
name: qa-scenarios
description: Memory Bank 프로젝트 QA 시나리오 맵
---

# QA Scenarios — Memory Bank

## 프로젝트 테스트 컨텍스트
- 프레임워크: Vitest 3.x (Node.js 환경)
- 실행 명령: `npm test`
- 브라우저 테스트: 없음 (Node.js CLI + MCP 서버)

## 기능별 시나리오 맵

| 기능 | 모듈 | 시나리오 수 | 우선순위 |
|------|------|------------|---------|
| JSONL 파싱 | `parser.ts` | 6 | HIGH |
| DB 스키마/마이그레이션 | `db.ts` | 4 | HIGH |
| 벡터 검색 | `search.ts` | 5 | HIGH |
| 텍스트 검색 | `search.ts` | 3 | HIGH |
| 멀티 개념 검색 | `search.ts` | 3 | MEDIUM |
| Fact 추출 | `fact-extractor.ts` | 4 | MEDIUM |
| Fact 통합 | `consolidator.ts` | 5 | MEDIUM |
| MCP search 도구 | `mcp-server.ts` | 4 | HIGH |
| MCP read 도구 | `mcp-server.ts` | 3 | HIGH |
| MCP search_facts 도구 | `mcp-server.ts` | 3 | MEDIUM |
| 파일 싱크 | `sync.ts` | 4 | HIGH |
| 대화 표시 | `show.ts` | 3 | LOW |
| 온톨로지 | `ontology-*.ts` | 3 | LOW |
| Avatar 응답 | `avatar-responder.ts` | 2 | LOW |

## 핵심 사용자 플로우

### Flow 1: Sync → Index → Search (Happy Path)
1. JSONL 파일이 `~/.claude/projects/`에 존재
2. `syncConversations()` 호출 → 파일 복사 + 인덱싱
3. `searchConversations("query")` → 벡터 유사도 기반 결과 반환
4. 결과에 project, timestamp, snippet, similarity 포함

### Flow 2: Fact Lifecycle
1. 세션 종료 시 `extractFactsFromExchanges()` 호출
2. LLM이 JSON 배열로 fact 추출 (confidence >= 0.7)
3. `saveExtractedFacts()` → embedding 생성 + DB 저장
4. `consolidateFacts()` → 중복/모순/진화 판정
5. `searchSimilarFacts()` → 벡터 검색으로 조회

### Flow 3: MCP Tool Call
1. Claude Code가 `search` 도구 호출
2. Zod 스키마로 입력 검증
3. 검색 실행 (vector/text/both)
4. Markdown 또는 JSON 응답 반환

## 시나리오 생성 규칙
- 새 MCP 도구 추가 시: 입력 검증, 정상 실행, 에러 반환 시나리오 작성
- DB 스키마 변경 시: 마이그레이션 멱등성 + 기존 데이터 보존 검증
- 검색 로직 변경 시: 빈 결과, 단일 결과, 다수 결과 + 날짜 필터 조합

## 엣지케이스 체크리스트
- [ ] 빈 JSONL 파일 파싱
- [ ] 잘못된 JSON 라인 (malformed) 스킵
- [ ] 빈 user_message 또는 assistant_message
- [ ] 384차원이 아닌 embedding 벡터
- [ ] DB 파일 경로에 한글/공백 포함
- [ ] LIKE 메타문자 (`%`, `_`) 포함된 검색어
- [ ] 날짜 필터 `after`/`before` 범위 밖 데이터
- [ ] 동시 DB 접근 (busy_timeout 동작)
- [ ] 대용량 대화 파일 (10,000+ 라인)
- [ ] LLM API 타임아웃/에러 시 graceful degradation
- [ ] `.jsonl` 아닌 파일로 read 도구 호출 시 에러
- [ ] 존재하지 않는 파일 경로로 read 호출
