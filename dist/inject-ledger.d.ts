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
