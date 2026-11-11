export declare function ledgerDir(): string;
/** 파일명 안전화: uuid/영숫자/dash/underscore 외 전부 제거. 빈 결과면 null. */
export declare function sanitizeSessionId(sessionId: string | undefined | null): string | null;
/** 세션의 기존 주입 id 집합. 없거나 깨졌으면 빈 집합 (fail-open). */
export declare function loadLedger(sessionId: string | undefined | null): Set<string>;
/**
 * 신규 주입 id 를 원장에 추가 저장. 삽입순 유지 + MAX_IDS(800) 상한(oldest evict).
 * 저장 시 7일 지난 다른 세션 원장을 opportunistic 정리.
 */
export declare function appendLedger(sessionId: string | undefined | null, existing: Set<string>, newIds: string[]): void;
/**
 * 세션 원장을 비운다 — 컨텍스트 압축(compaction) 뒤에 부른다 (scripts/ledger-reset-hook.js).
 *
 * 원장의 전제는 「이미 주입한 fact 는 대화 컨텍스트에 있다」인데, 압축은 그 fact 를 요약으로
 * 바꾸면서 세션 id 는 그대로 둔다. 원장이 남으면 사라진 fact 가 세션이 끝날 때까지
 * 「이미 실음」으로 막힌다(실측 2026-11-10: 원장 94개 중 11세션이 압축을 겪었고 그 원장에 315건,
 * 활동 중인 세션은 주입 때마다 mtime 이 갱신돼 7일 정리에도 걸리지 않는다).
 *
 * 그 세션의 파일 하나만 지운다. 반환: 지운 키 수(원장이 없었으면 0), 쓸 수 없는 세션 id 면 null.
 * 다른 함수와 달리 실패를 삼키지 않는다 — 지우지 못했는데 조용히 돌아오면 호출자가
 * 「초기화됨」으로 기록하고 그 세션은 계속 막힌다. 호출자가 로그에 남긴다.
 */
export declare function resetLedger(sessionId: string | undefined | null): number | null;
