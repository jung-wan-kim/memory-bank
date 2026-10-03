# 주입 파이프라인 v2 — 세션 dedup · 토큰 예산 · tail-latency

## 실측 근거 (Phase 0)

| 항목 | 측정값 | 문제 |
|------|--------|------|
| 주입률 | 최근 500회 중 74% injected, 평균 5.5~8건 | — |
| 토큰 비용 | fact 평균 140자(p90 207) × 8건 ≈ 1,360자 ≈ **~470 tok/프롬프트** | 30-프롬프트 세션 ≈ 10k tok |
| **세션 내 중복** | dedup 장치 없음 — 같은 fact가 세션에서 반복 주입 (실관측 3회+) | **최대 토큰 낭비원** |
| 지연 | daemon median 1,057ms · p90 4.4s | detectRepeat(313k exchanges 벡터검색 p95 498ms) tail + 드레인 경합(7/10) |
| session_id | hook stdin에 있으나 파이프라인에 미전달 | dedup 구조적 불가 |
| ingest | 7일 13,764 신규 fact | 건강 — 변경 불필요 |

## 설계 (bounded-constant-memory-injection 규칙 적용)

1. **세션 dedup ledger** `src/inject-ledger.ts` (NEW)
   - `<indexDir>/state/inject-ledger/<session_id>.json` — 세션당 주입된 fact id 집합
   - 같은 fact는 세션에서 **1회만 주입** (대화 컨텍스트에 이미 있음 — 재주입은 순수 낭비)
   - bounded: 400 id 상한(oldest evict; v1.7.0 부터 800 — id 와 본문 키를 함께 넣는다), 7일 TTL 파일 정리, 원자적 쓰기(tmp+rename), session_id sanitize
2. **토큰 예산**: fact당 160자 절단 + 블록 총 1,000자 예산 (초과 시 하위 관련도부터 제외)
3. **tail-latency**: detectRepeat 250ms timebox (Promise.race) — p95 tail 절단
   - (2026-10-03 정정) better-sqlite3 검색은 동기라 Promise.race 로 선점할 수 없다 — 이 방식은 효과가 없었다. 지금은 시작 전 경과 예산을 확인해 생략하고, 반복 감지 자체가 기본으로 꺼져 있다(`src/inject-core.ts` 의 `REPEAT_ELAPSED_BUDGET_MS`)
4. **session_id 배관**: hook stdin → inject-context.js → daemon payload → `computeInjectResult`(블록과 원장 키) → 클라이언트가 출력 뒤 원장 기록
   - (2026-10-03, v1.7.1~1.7.4 에서 바뀜) 처음 설계는 데몬이 계산하며 원장까지 썼다. 클라이언트가 기다리다 포기한 블록이 「이미 실음」으로 남는 결함이 있어, 원장은 블록을 실제로 출력한 쪽(`inject-context.js` 의 `deliver`, 세션 시작 훅)이 쓰기 성공 뒤에만 기록하게 바꿨다. 기록자 목록은 `test/ledger-writers.test.ts` 가 고정한다
5. **관측성**: inject 로그에 `chars`(주입 크기)·`deduped`(절약 건수) 필드 — 실효 절감을 로그로 상시 측정 (fail-loud)

## 수용 기준

- [ ] 같은 session_id로 2회 호출 시 두 번째는 동일 fact 재주입 0 (dedup 실증)
- [ ] 다른 session_id는 독립 (세션 격리)
- [ ] fact 절단·블록 예산 적용 (주입 블록 ≤ ~1,050자)
- [ ] ledger bounded (400 cap·TTL·sanitize) 단위테스트
- [ ] 기존 vitest 전체 회귀 없음
- [ ] 실 주입 e2e: 실제 프롬프트로 1회차 주입 → 2회차 dedup 확인 (스크립트 실행 증거)

## Deviations
- (기록용) hard-process-contract.json 부재 — 이 repo는 /init-project 미적용, 본 세션 이전 /team 2회와 동일하게 진행.
