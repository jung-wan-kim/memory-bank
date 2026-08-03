/**
 * Single source of truth for "which sessions still need cross-project fact
 * extraction". BOTH the backfill-extract worker (to pick sessions to process)
 * AND the SessionStart hook (to decide whether to spawn that worker) must use
 * the IDENTICAL predicate — otherwise the spawn condition drifts from the work
 * condition. Observed drift (2026-07-11): the hook counted any session missing
 * from extraction_log (509), while the worker additionally drops
 * memory-bank-llm pollution sessions and sessions below MIN_EXCHANGES and so
 * only processed 4 — leaving 505 phantom "pending" sessions that the worker can
 * never clear, so the hook spawned the worker (model load + LLM setup) on EVERY
 * session start forever, for nothing.
 */

function boundedInt(raw: string | undefined, def: number, cap: number): number {
  if (raw === undefined || !/^\d+$/.test(raw.trim())) return def;
  const n = parseInt(raw.trim(), 10);
  return Number.isFinite(n) && n >= 1 && n <= cap ? n : def;
}

export interface ExtractionConfig {
  minExchanges: number;
  excludeProjects: string[];
}

/** Env-derived config, identical for the worker and the hook. */
export function getExtractionConfig(): ExtractionConfig {
  const excludeProjects = (
    process.env.BACKFILL_EXCLUDE_PROJECTS ||
    '/Users/jung-wankim/Project/Claude/memory-bank'
  )
    .split(',')
    .map((s) => s.trim())
    // 후행 슬래시 제거 — 남겨두면 경계 매칭이 `p + '/'` 로 '//' 를 만들어 하위 경로가
    // 배제에서 풀린다. 소비자(SQL 필터·isExcludedProject)가 같은 값을 봐야 한다.
    .map((s) => s.replace(/\/+$/, ''))
    .filter(Boolean);
  // Default 2: 1-exchange sessions are overwhelmingly automated-worker /
  // monitoring noise that yields no durable facts. Interpolated into SQL →
  // boundedInt (not bare parseInt) so garbage can't reach the query text.
  const minExchanges = boundedInt(process.env.BACKFILL_MIN_EXCHANGES, 2, 1000);
  return { minExchanges, excludeProjects };
}

/**
 * extraction_log.extracted 의 상태 코드 (음수는 전부 "fact 0건"의 사유 구분).
 *
 * 🚨 이 3-상태가 없으면 세션 처리는 두 나쁜 선택 사이를 왕복한다 — 실패를 기록하면
 * pending 에서 영구 제외되어 fact 가 영영 안 생기고(손실), 기록하지 않고 이연하면
 * 런타임이 깨졌을 때 최신 세션만 매 run 재시도되며 오래된 백로그가 기아한다.
 * 실제로 이 진동이 Codex 적대 리뷰 R3(기아)↔R4(손실)에서 관측됐다. 해법은 어느
 * 한쪽을 고르는 게 아니라 **재시도 예산을 가진 제3의 터미널 상태**다:
 *   -1  seed        : 과거에 이미 fact 를 만든 세션 (재추출 금지)
 *   -2  permanent   : 같은 입력이면 같은 결과인 실패 (per-request 거절) — 재시도 무의미
 *   -4  retriable   : 내부 실패(DB/임베딩/파서). saved 컬럼에 시도 횟수를 적고,
 *                     예산이 남아 있는 동안은 pending 에 **다시 포함**된다. 예산을
 *                     소진하면 워커가 -2 로 승격해 큐가 영원히 물리지 않는다.
 * (공급자 장애는 애초에 행을 쓰지 않고 이연한다 — 예산 소모 없이 회복 시 재개.)
 */
export const EXTRACTION_STATE = {
  SEED: -1,
  PERMANENT: -2,
  /** 처리 중 선점(claim). 리스 만료 후에는 pending 으로 되돌아온다. */
  CLAIMED: -3,
  RETRIABLE_INTERNAL: -4,
} as const;

/** 내부 실패 재시도 예산 — 소진하면 PERMANENT 로 승격(무한 재시도 방지). */
export const MAX_INTERNAL_RETRIES = 3;

/**
 * claim 리스 수명(분). 이 시간이 지난 claim 은 "죽은 소유자"로 보고 회수한다.
 *
 * 리스가 없으면 추출 도중 프로세스가 죽었을 때 claim 이 영원히 남아 세션이
 * 영구 미추출된다 — R4 와 같은 손실 클래스가 claim 축에서 재현되는 것이다.
 * 추출 1회는 LLM·임베딩·온톨로지까지 수 분이므로 넉넉히 잡는다.
 */
export const CLAIM_LEASE_MINUTES = 30;

/**
 * SQLite 식 "리스가 아직 살아있는 claim" 조건 (테이블 별칭을 받는다).
 *
 * 🚨 `datetime(...)` 으로 **양쪽을 파싱**해 비교한다. processed_at 은 JS
 * `toISOString()`(`2026-08-02T10:48:32.698Z`)인데 `datetime('now',…)` 는 공백 구분
 * (`2026-08-02 11:18:32`)이라, 문자열로 비교하면 index 10 에서 'T'(0x54) > ' '(0x20)
 * 이 되어 **같은 UTC 날짜의 만료 claim 이 언제나 fresh 로 판정**된다. 실효 리스가
 * 30분이 아니라 "날짜가 바뀔 때까지"(최대 ~24.5시간)가 되어, 죽은 소유자의 claim 이
 * 세션을 하루 가까이 잠근다 — 소비자 4곳(pending 쿼리·worker/hook claim·제외 마커)
 * 전부에 영향(Codex R23, 실측 재현: 1시간 만료 claim 이 fresh=1).
 */
export function freshClaimPredicate(alias = 'extraction_log'): string {
  // 손상 타임스탬프는 "살아있지 않다"로 판정한다(COALESCE). 그러지 않으면 NULL 비교가
  // 3치논리로 번져 `NOT (fresh)` 가 NULL 이 되고, hook 변형 선점이 조용히 실패한다.
  return `${alias}.extracted = ${EXTRACTION_STATE.CLAIMED}`
    + ` AND COALESCE(datetime(${alias}.processed_at) > datetime('now', '-${CLAIM_LEASE_MINUTES} minutes'), 0)`;
}

/**
 * 세션 선점 SQL — **LLM 호출 전에** 실행해 중복 추출을 구조적으로 차단한다.
 *
 * SessionEnd 훅 워커와 backfill 워커 사이에는 어떤 직렬화 수단도 없었고, 마커는
 * 파이프라인 *끝*에 써지므로 창이 수 분간 열려 있었다 — 둘이 같은 세션을 집으면
 * 각자 fact 를 저장해 중복이 쌓인다(facts.id 는 randomUUID, 내용 UNIQUE 없음).
 * 마커 시점 가드로는 늦다: 그때는 이미 파이프라인이 두 번 돈 뒤다. (Codex R6 HIGH)
 *
 * 두 변형이 필요한 이유 — 호출자의 정당한 기대가 다르다:
 *  - 'worker': 자기가 pending 으로 **선정했던 상태**일 때만 선점한다. 선정 후 훅이
 *    먼저 끝내 성공 마커를 썼다면 그 위를 덮지 않는다(재추출=중복 차단).
 *  - 'hook'  : 현재 세션을 처리하므로 확정 마커 위에서도 선점할 수 있어야 한다
 *    (--resume 으로 교환이 늘어난 세션의 재추출은 의도된 동작). 단 살아있는
 *    claim 만은 존중한다.
 * 실행 후 `changes === 1` 이어야 소유권 획득이다(0 이면 타 라이터 소유 → skip).
 */
export function claimSessionSql(variant: 'worker' | 'hook'): string {
  const owned = variant === 'worker'
    // pending 이었던 상태만: 재시도 대상(-4) 또는 리스 만료 claim
    ? `extraction_log.extracted = ${EXTRACTION_STATE.RETRIABLE_INTERNAL}`
      // 🚨 손상 타임스탬프(NULL·파싱 불가)도 회수 대상이다. pending 쿼리는 그런 행을
      //    이미 회수 대상으로 보는데 여기서만 선점이 실패하면, 세션이 **pending 인데
      //    처리 불가**가 되어 매 run 슬롯만 먹는다(무한 재선정). `IS NULL` 로 명시.
      + ` OR (extraction_log.extracted = ${EXTRACTION_STATE.CLAIMED}`
      + ` AND (datetime(extraction_log.processed_at) IS NULL`
      + `      OR datetime(extraction_log.processed_at) <= datetime('now', '-${CLAIM_LEASE_MINUTES} minutes')))`
    // 살아있는 claim 이 아니면 무엇이든 선점 가능
    : `NOT (${freshClaimPredicate()})`;
  // 🚨 소유권 토큰(claim_owner)이 없으면 "내 claim 만 건드린다"는 계약을 SQL 로
  // 표현할 수 없다 — `extracted = -3` 은 **상태**만 보므로 A 의 롤백이 B 의 살아있는
  // claim 을 지우거나 덮어써 상호배제가 깨진다(Codex R7 HIGH-2).
  // 파라미터 순서: (session_id, processed_at, claim_owner)
  return `
    INSERT INTO extraction_log (session_id, processed_at, extracted, saved, claim_owner)
    VALUES (?, ?, ${EXTRACTION_STATE.CLAIMED}, 0, ?)
    ON CONFLICT(session_id) DO UPDATE SET processed_at = excluded.processed_at,
      extracted = ${EXTRACTION_STATE.CLAIMED}, saved = 0, claim_owner = excluded.claim_owner
    WHERE ${owned}`;
}

/**
 * 리스 갱신(heartbeat). 파라미터: (processed_at, session_id, claim_owner)
 *
 * 리스는 "소유자가 죽었을 때 회수"하기 위한 것이지 "정상 작업에 제한시간을 두기"
 * 위한 것이 아니다. 갱신이 없으면 리스보다 오래 걸리는 **정상 추출**이 살아있는 채로
 * 회수 대상이 되어 다른 워커가 선점 → 양쪽이 fact 를 저장한다(Codex R7 HIGH-1).
 * `changes === 0` 이면 이미 claim 을 잃은 것이므로 즉시 중단해야 중복이 안 생긴다.
 */
export function renewClaimSql(): string {
  return `UPDATE extraction_log SET processed_at = ?
          WHERE session_id = ? AND extracted = ${EXTRACTION_STATE.CLAIMED} AND claim_owner = ?`;
}

/**
 * 내부 실패 마커 UPSERT — 워커/테스트가 공유하는 단일 소스.
 * `WHERE` 가드가 다른 라이터의 확정 마커(성공/seed/영구)를 덮는 것을 막는다.
 * 자기 claim(-3)과 이전 재시도(-4)만 갱신 대상이다.
 */
export function failureMarkerUpsertSql(): string {
  // 파라미터: (session_id, processed_at, extracted, saved, claim_owner)
  // 내가 쥔 claim 위에서만 실패 마커를 남긴다 — 다른 라이터의 확정 마커(성공/seed/
  // 영구)도, **다른 라이터의 claim** 도 덮지 않는다.
  return `
    INSERT INTO extraction_log (session_id, processed_at, extracted, saved, claim_owner)
    VALUES (?, ?, ?, ?, NULL)
    ON CONFLICT(session_id) DO UPDATE SET processed_at = excluded.processed_at,
      extracted = excluded.extracted, saved = excluded.saved, claim_owner = NULL
    WHERE extraction_log.extracted = ${EXTRACTION_STATE.CLAIMED}
      AND extraction_log.claim_owner = ?`;
}

/**
 * Core SELECT over pending-extraction sessions, through GROUP BY / HAVING but
 * WITHOUT any ORDER BY / LIMIT — callers wrap it:
 *   worker: `${sql} ORDER BY ts DESC LIMIT ?`   (params + limit)
 *   hook:   `SELECT 1 FROM (${sql}) LIMIT 1`     (params)
 * Columns: sid, ts, n.
 */
export function pendingExtractionCoreQuery(cfg: ExtractionConfig): { sql: string; params: string[] } {
  const exTerms = cfg.excludeProjects;
  // `x.session_id IS NOT NULL` is load-bearing: one NULL inside NOT IN makes the
  // whole predicate NULL (3-valued logic) → zero pending sessions → silent drain.
  const exClause = `AND e.session_id NOT IN (
      SELECT DISTINCT x.session_id FROM exchanges x
      WHERE x.session_id IS NOT NULL
        AND (x.cwd LIKE '%/memory-bank-llm'
      ${exTerms.length ? 'OR ' + exTerms.map(() => 'x.cwd = ?').join(' OR ') : ''})
    )`;
  const sql = `
    SELECT e.session_id AS sid, MAX(e.timestamp) AS ts, COUNT(*) AS n
    FROM exchanges e
    WHERE e.is_sidechain = 0 AND e.session_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM extraction_log l
        WHERE l.session_id = e.session_id
          -- 재시도 예산이 남은 내부 실패(-4)는 '처리됨'이 아니다 → 여전히 pending.
          -- 이 예외가 없으면 일시적 런타임 장애 한 번에 세션이 영구 손실된다.
          AND NOT (l.extracted = ${EXTRACTION_STATE.RETRIABLE_INTERNAL}
                   AND l.saved < ${MAX_INTERNAL_RETRIES})
          -- 리스가 만료된 claim(-3)도 미처리다. 소유자가 죽었을 수 있으므로
          -- 회수해야 한다 — 그렇지 않으면 claim 자체가 새로운 영구손실 통로가 된다.
          AND NOT (l.extracted = ${EXTRACTION_STATE.CLAIMED}
                   AND datetime(l.processed_at) <= datetime('now', '-${CLAIM_LEASE_MINUTES} minutes'))
      )
      ${exClause}
    GROUP BY e.session_id
    HAVING COUNT(*) >= ${cfg.minExchanges}`;
  return { sql, params: exTerms };
}
