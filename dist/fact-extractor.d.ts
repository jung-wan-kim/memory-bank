import Database from 'better-sqlite3';
import type { ExtractedFact } from './types.js';
export declare const EXTRACTION_SYSTEM_PROMPT = "You are an expert at extracting long-term facts from conversations.\n\n## Rules\n- 1 fact = 1 sentence (concise)\n- Ignore trivial exchanges (greetings, \"yes\", \"thanks\")\n- Code snippets are NOT facts - extract only decisions/patterns\n- No duplicate facts within the same batch\n- Prefer durable facts (decisions, conventions, constraints, lessons) over\n  session-ephemeral details (\"user is currently editing file X\" is NOT a fact)\n- Capture problem\u2192solution lessons as \"pattern\"\n  (e.g., \"X error in this project is caused by Y and fixed by Z\")\n\n## scope determination\n- project: specific files/paths/DB/API/framework/business logic\n- global: coding style, language/response format, common tool usage\n\n## Output format (JSON array)\n[\n  {\n    \"fact\": \"User uses Riverpod for state management\",\n    \"fact_kr\": \"\uC0AC\uC6A9\uC790\uB294 \uC0C1\uD0DC \uAD00\uB9AC\uC5D0 Riverpod\uC744 \uC0AC\uC6A9\uD55C\uB2E4\",\n    \"category\": \"decision\",\n    \"scope_type\": \"project\",\n    \"confidence\": 0.9\n  }\n]\n\n## fact_kr rules\n- Natural Korean translation of \"fact\"\n- Keep technical terms (API/tool/framework names, file paths, commands) in English\n\n## category choices\n- decision: architecture/technology decisions\n- preference: user preferences\n- pattern: repeated patterns\n- knowledge: project knowledge\n- constraint: constraints\n\n## confidence criteria\n- 0.9+: explicit decision/declaration\n- 0.7-0.9: inferred from behavior\n- Below 0.7: do not extract";
/** 선점(claim)을 잃어 작업을 중단할 때 던진다. 호출자는 이것을 실패가 아니라
 *  "다른 러너가 이 세션을 가져갔다"로 읽어야 한다 — 예산을 소모하지 않는다. */
export declare class ClaimLostError extends Error {
    constructor(message: string);
}
/**
 * Whether an exchange is worth sending to the extraction LLM.
 * Filters harness artifacts (local command output), bare slash commands,
 * and trivial acknowledgements — they waste LLM calls and produce noise facts.
 */
export declare function isSubstantiveExchange(userMessage: string, assistantMessage: string): boolean;
/** Normalize fact text for cross-batch duplicate detection within a session. */
export declare function normalizeFactText(fact: string): string;
/**
 * Confidence gate for extracted facts. Rejects missing/NaN confidence —
 * `undefined < 0.7` is false, so a naive `<` check would accept unscored
 * facts from malformed LLM output.
 */
export declare function passesConfidenceGate(confidence: unknown): boolean;
/**
 * Cap LLM calls for long sessions by picking evenly spread batches, so the
 * beginning, middle, and end of a session are all represented instead of
 * only the head.
 */
export declare function selectSpreadBatches<T>(batches: T[], maxBatches: number): T[];
export declare function buildExtractionPrompt(exchanges: Array<{
    user_message: string;
    assistant_message: string;
}>): string;
/**
 * @param stats 선택적 out-param. deterministic 실패로 **폐기된 배치 수**를 돌려준다
 *   (dead-letter 회계). 선택적이라 기존 호출자는 그대로 동작한다.
 */
export declare function extractFactsFromExchanges(db: Database.Database, sessionId: string, stats?: {
    droppedBatches: number;
}, 
/**
 * 배치마다 호출되는 리스 갱신 훅. 리스보다 오래 걸리는 정상 추출이 회수 대상이
 * 되어 다른 워커가 선점하는 것을 막는다(R7 HIGH-1). throw 하면 즉시 중단한다 —
 * 이미 claim 을 잃었다는 뜻이므로 계속하면 중복 작업이다.
 */
renewLease?: () => void): Promise<ExtractedFact[]>;
export declare function saveExtractedFacts(db: Database.Database, facts: ExtractedFact[], project: string, sourceExchangeIds: string[], codingAgent?: string, 
/**
 * 🚨 저장 구간은 파이프라인에서 **가장 긴** 단계다 — fact 당 임베딩 2회 +
 * classifyAndLinkFact(내부에서 callHaiku = 헤드리스 세션 1회)를 최대 20 fact 반복.
 * 여기가 리스 밖이면 정상 작업이 회수돼 다른 워커가 같은 세션을 저장한다
 * (Codex R8 HIGH: R7 HIGH-1 의 잔존 구간). fact 마다 갱신·소유권 확인한다.
 */
renewLease?: () => void, 
/**
 * 🚨 완료 마커를 **fact 삽입과 같은 트랜잭션 안에서** 쓰기 위한 커밋 훅.
 * 갱신 행 수를 반환하며 0 이면(=선점을 잃음) 트랜잭션 전체가 롤백된다.
 *
 * 체크포인트(리스 확인)를 아무리 촘촘히 박아도 **마지막 확인과 커밋 사이**에는
 * 항상 창이 남는다 — R7(배치)→R8(저장 루프)→R9(루프 꼬리)로 같은 결함이 세 번
 * 좁아지기만 했다. 원인은 "저장"과 "소유권 확정"이 서로 다른 시점이라는 구조다.
 * 둘을 원자적으로 묶으면 창의 크기와 무관하게 닫힌다: 커밋 순간 소유권이 없으면
 * fact 도 남지 않으므로 중복이 생길 수 없다.
 */
commitMarker?: (extracted: number, saved: number) => number): Promise<string[]>;
/**
 * 추출 실패의 분류 — **라우팅(예산 소모 여부)과 보고(로그·카운터)가 같은 정의를 쓴다.**
 *
 * 🚨 이전에는 소비자가 3분류(handoff/provider/internal)인데 실제 이연 판정은 4분류였다:
 * deterministic 한 공급자 거절(400/413/422 · prompt-too-long)은 재시도해도 같은 결과라
 * 재시도 예산(-4, 3회 후 -2 영구제외)을 **소모하는데**, 워커는 그것을 'provider' 로 세어
 * "will retry next run" 이라 보고하고 internalFailures 도 0 이라 아무 경보가 없었다.
 * 즉 예산이 조용히 타들어가는 동안 로그는 "곧 재시도됨"이라고 말했다(Codex R12 HIGH).
 * 분류를 4분류로 맞추고 라우팅 술어까지 같은 모듈에 둬서 둘이 어긋날 수 없게 한다.
 */
export type ExtractionFailureKind = 'handoff' | 'provider_transient' | 'provider_deterministic' | 'internal';
export declare function classifyExtractionFailure(err: unknown): ExtractionFailureKind;
/**
 * 소비자 보고·집계 표 — 라벨·문구뿐 아니라 **카운터 버킷과 예산 소모 여부까지** 여기서
 * 나온다. 워커가 자체 분기를 들면 "예산 판정과 카운터가 반대로 붙는" 실수를 테스트가
 * 잡지 못한다(문자열 검사는 워커가 결과를 무시해도 통과) — 분기 자체를 없앤다.
 *
 * `escalate`: 운영자가 손을 대야 하는 실패인가. R12 수정 과정에서 요약줄의
 * "INTERNAL failures — 런타임/DB 점검 필요" 경보가 일반 예산 회계로 대체돼 사라졌던
 * 것을 이 플래그로 복원한다(Codex R13 MEDIUM — 내가 만든 회귀).
 */
export declare const FAILURE_REPORT: Record<ExtractionFailureKind, {
    label: string;
    note: string;
    bucket: 'handoff' | 'transient' | 'budget';
    consumesBudget: boolean;
    escalate: boolean;
}>;
/**
 * 이 실패가 재시도 예산을 소모하는가. runFactExtraction 의 라우팅과 워커의 보고가
 * **같은 술어**를 보게 해서 "예산은 타는데 로그는 재시도된다고 말하는" 모순을 막는다.
 */
export declare function failureConsumesBudget(kind: ExtractionFailureKind): boolean;
export declare function runFactExtraction(db: Database.Database, sessionId: string, project: string, codingAgent?: string, 
/**
 * claimVariant: 선점 조건. 'hook'(기본)은 살아있는 claim 만 존중하고 확정 마커
 * 위에서도 선점한다(--resume 세션 재추출은 의도된 동작). 'worker'는 자기가
 * pending 으로 선정했던 상태(미기록 / -4 / 리스만료 claim)일 때만 선점한다 —
 * 선정 후 훅이 먼저 확정했다면 그 위를 덮지 않아 중복 추출이 생기지 않는다.
 * 선점·복원을 이 함수가 단독으로 소유하므로 호출자 간 로직 분기가 없다.
 */
opts?: {
    claimVariant?: 'worker' | 'hook';
}): Promise<{
    extracted: number;
    saved: number;
    skipped?: 'claim_not_acquired' | 'claim_error' | 'excluded_project' | 'excluded_project_unmarked';
}>;
