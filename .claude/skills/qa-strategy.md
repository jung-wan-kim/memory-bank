---
name: qa-strategy
description: Memory Bank 프로젝트 QA 전략 및 테스트 가이드
---

# QA Strategy — Memory Bank

## 테스트 프레임워크

- **Vitest 3.x** (globals: true, environment: node)
- 테스트 타임아웃: 30초 (임베딩 모델 로딩 포함)
- 테스트 위치: `test/**/*.test.ts`

## 실행 명령

```bash
npm test                              # 전체 테스트
npx vitest run test/parser.test.ts    # 단일 파일
npx vitest --watch                    # watch 모드
npm run build                         # TypeScript 컴파일 + esbuild 번들
```

## 테스트 계층

### 단위 테스트 (Unit)
| 파일 | 대상 |
|------|------|
| `test/parser.test.ts` | JSONL 파싱, exchange 추출 |
| `test/db.test.ts` | DB 마이그레이션, exchange CRUD |
| `test/fact-db.test.ts` | Fact CRUD, 벡터 검색 |
| `test/show.test.ts` | Markdown/HTML 렌더링 |
| `test/stats.test.ts` | 통계 계산 |
| `test/llm.test.ts` | LLM 호출 래퍼 |
| `test/verify.test.ts` | 데이터 무결성 검증 |
| `test/api-config.test.ts` | API 설정 로직 |

### 통합 테스트 (Integration)
| 파일 | 대상 |
|------|------|
| `test/integration.test.ts` | Sync → Index → Search 전체 흐름 |
| `test/sync.test.ts` | 파일 복사, 인덱싱 파이프라인 |
| `test/fact-integration.test.ts` | Fact 추출 → 저장 → 통합 흐름 |
| `test/consolidator.test.ts` | Fact 중복/모순/진화 판정 |
| `test/mcp-facts.test.ts` | MCP search_facts 도구 |
| `test/multi-concept.test.ts` | 멀티 개념 AND 검색 |

## 모킹 패턴

### DB 격리
```typescript
// 각 테스트는 독립 temp DB 사용
const testDir = path.join(os.tmpdir(), 'test-' + Date.now());
process.env.TEST_DB_PATH = path.join(testDir, 'test.db');
// afterEach에서 fs.rmSync(testDir, { recursive: true })
```

### 콘솔 출력 억제
```typescript
import { suppressConsole } from './test-utils.js';
const restoreConsole = suppressConsole();
```

### LLM 모킹
- `test/llm.test.ts`에서 Anthropic SDK를 vitest mock으로 대체
- `test/consolidator.test.ts`에서 `callHaiku` 함수를 직접 mock

### 임베딩 모킹
- 통합 테스트는 실제 `@xenova/transformers` 모델 사용 (384-dim)
- 단위 테스트에서는 `new Array(384).fill(0.1)` 더미 임베딩 사용

## QA Gate (커밋 전 필수)

```bash
# 1. 빌드 성공
npm run build

# 2. 전체 테스트 통과
npm test

# 3. 테스트 수 확인 (현재 109개 이상)
npx vitest run 2>&1 | grep "Tests"
```

## 알려진 제약

- `better-sqlite3` native 모듈은 Node.js 버전과 일치해야 함
  - 불일치 시: `npm rebuild better-sqlite3`
- 임베딩 모델 첫 로딩에 수 초 소요 (모델 캐시 후 빠름)
- sqlite-vec 가상 테이블은 INSERT OR REPLACE 미지원 → DELETE 후 INSERT
