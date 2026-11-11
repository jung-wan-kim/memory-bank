import Database from 'better-sqlite3';
import type { ExtractedFact } from './types.js';
export declare const EXTRACTION_SYSTEM_PROMPT = "You are an expert at extracting long-term facts from conversations.\n\n## Rules\n- 1 fact = 1 sentence (concise)\n- Ignore trivial exchanges (greetings, \"yes\", \"thanks\")\n- Code snippets are NOT facts - extract only decisions/patterns\n- Credentials are NOT facts - never copy an API key, token, password or any other\n  secret value into a fact (that a credential exists, or where it is kept, can be one)\n- No duplicate facts within the same batch\n- Prefer durable facts (decisions, conventions, constraints, lessons) over\n  session-ephemeral details (\"user is currently editing file X\" is NOT a fact)\n- The session's environment is NOT a fact: where the project folder is, that it\n  is a git repository, which branch is checked out\n- Capture problem\u2192solution lessons as \"pattern\"\n  (e.g., \"X error in this project is caused by Y and fixed by Z\")\n\n## scope determination\n- project: specific files/paths/DB/API/framework/business logic\n- global: coding style, language/response format, common tool usage\n\n## Output format (JSON array)\n[\n  {\n    \"fact\": \"<one English sentence stating the fact>\",\n    \"fact_kr\": \"<the same sentence in natural Korean>\",\n    \"category\": \"decision\",\n    \"scope_type\": \"project\",\n    \"confidence\": 0.9\n  }\n]\n(This shows the shape only. Write real sentences in \"fact\" and \"fact_kr\" \u2014 never copy the bracketed text.)\n\n## fact_kr rules\n- Natural Korean translation of \"fact\"\n- Keep technical terms (API/tool/framework names, file paths, commands) in English\n\n## category choices\n- decision: architecture/technology decisions\n- preference: user preferences\n- pattern: repeated patterns\n- knowledge: project knowledge\n- constraint: constraints\n\n## confidence criteria\n- 0.9+: explicit decision/declaration\n- 0.7-0.9: inferred from behavior\n- Below 0.7: do not extract";
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
/** 세션당 저장 상한 — 선택된 배치 수에 비례하고, 바닥과 절대 상한 사이에 든다. */
export declare function sessionFactCap(selectedBatches: number): number;
/**
 * 배치별 후보에서 `cap` 건을 고른다. 합이 상한 이하면 전부(순서 그대로).
 * 넘으면 배치마다 신뢰도 높은 것부터 한 건씩 돌아가며 뽑는다 — 어느 배치도 다른
 * 배치의 후보 때문에 통째로 밀려나지 않는다. 마지막 바퀴에 자리가 모자라면 그 바퀴
 * 후보 중 신뢰도 높은 것, 같으면 뒤쪽 배치 것을 고른다(긴 세션의 결론은 뒤에 있다).
 * 결과는 원래 순서(배치 순, 배치 안에서는 LLM 이 낸 순)다.
 */
export declare function selectFactsAcrossBatches<T extends {
    confidence: number;
}>(perBatch: T[][], cap: number): T[];
/**
 * The most extraction batches MEMORY_BANK_MAX_EXTRACT_CALLS can ask for. A
 * session stores at most ABSOLUTE_MAX_FACTS_PER_SESSION facts, picked one per
 * batch in turn (selectFactsAcrossBatches): with this many batches every slot is
 * already taken by a batch's best fact, so a further batch is a call whose
 * result cannot be stored. Without a ceiling the value was used as given —
 * 1000 sent all 80 batches of a 400-exchange session (measured).
 */
export declare const MAX_EXTRACT_CALLS_CEILING = 60;
/**
 * How many extraction batches one session may send (MEMORY_BANK_MAX_EXTRACT_CALLS,
 * default 12, at most MAX_EXTRACT_CALLS_CEILING). `clampedFrom` is the value
 * asked for when it was above the ceiling. Anything that is not a positive
 * integer is the default — it is not read by its leading digits ('1e3' is not 1).
 *
 * This bounds the BATCHES, not every LLM call of a session: a batch whose call
 * fails for a transient reason is tried again inside callHaiku (3 attempts by
 * default), and every stored fact gets its ontology classification and
 * relation calls on top.
 */
export declare function extractCallBudget(): {
    calls: number;
    clampedFrom?: number;
};
/**
 * 이 세션의 project 사실을 묶을 범위. linked worktree(그 하위 폴더 포함)에서 끝난 세션은
 * 본 저장소 루트로 읽고, 그 밖에는 받은 경로 그대로다.
 *
 * scope_project 는 세션이 끝난 순간의 cwd 였다. worktree 는 일이 끝나면 지워지고, 지워진
 * 경로의 사실은 어느 저장소에서도 보이지 않는다(읽는 쪽의 저장소 묶음 판정 —
 * project-family.ts — 은 디스크에 없는 경로를 어느 저장소의 것으로도 보지 않는다. 저장소
 * 밖에 둔 worktree 의 사실은 폴더가 있는 동안에도 저장소에서 안 보인다). 추출 시점에는
 * 폴더가 있어 본 저장소를 확인할 수 있으므로 그때 옮겨 적는다.
 *
 * 판정은 resolveRepoRoots 하나다 — `.git` 파일이 가리키는 관리 폴더의 역참조까지 맞아야
 * 본 저장소로 인정한다. 그래서 아래는 전부 받은 경로 그대로다: 저장소 루트와 그 하위 폴더
 * (예전부터 정확한 경로가 범위였다), 저장소가 아닌 폴더, 디스크에 없는 경로(어느
 * 저장소였는지 알 수 없다 — 추측하지 않는다), 홈 폴더가 본 저장소인 경우, 슬러그 꼴 이름.
 *
 * 본 저장소가 추출 제외 목록에 있으면 옮기지 않는다 — 제외된 범위에 사실을 넣지 않는다
 * (그 세션을 추출할지는 예전 판정 그대로다: 저장소 밖의 worktree 는 예전에도 추출됐다).
 *
 * 원래 폴더는 사실의 source_exchange_ids → exchanges.cwd 로 되짚을 수 있다.
 */
export declare function extractionScopeProject(project: string): string;
export declare function buildExtractionPrompt(exchanges: Array<{
    user_message: string;
    assistant_message: string;
}>): string;
/**
 * @param stats 선택적 out-param. deterministic 실패로 **폐기된 배치 수**를 돌려준다
 *   (dead-letter 회계). 선택적이라 기존 호출자는 그대로 동작한다.
 *   `truncatedFacts` 는 세션 상한 때문에 저장 대상에서 빠진 후보 수다.
 */
export declare function extractFactsFromExchanges(db: Database.Database, sessionId: string, stats?: ExtractionStats, 
/**
 * 배치마다 호출되는 리스 갱신 훅. 리스보다 오래 걸리는 정상 추출이 회수 대상이
 * 되어 다른 워커가 선점하는 것을 막는다(R7 HIGH-1). throw 하면 즉시 중단한다 —
 * 이미 claim 을 잃었다는 뜻이므로 계속하면 중복 작업이다.
 */
renewLease?: () => void): Promise<ExtractedFact[]>;
export declare function saveExtractedFacts(db: Database.Database, facts: ExtractedFact[], project: string, sourceExchangeIds: string[], codingAgent?: string, 
/**
 * 🚨 저장 구간은 파이프라인에서 **가장 긴** 단계다 — fact 당 임베딩 2회 +
 * classifyAndLinkFact(내부에서 callHaiku = 헤드리스 세션 1회)를 세션 상한(sessionFactCap)까지 반복.
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
/** extractFactsFromExchanges 의 out-param (dead-letter·상한 회계). */
export interface ExtractionStats {
    droppedBatches: number;
    /** 세션 상한 때문에 저장 대상에서 빠진 후보 수 */
    truncatedFacts?: number;
    /** 자격증명 모양 문자열이 들어 있어 버린 사실 수 */
    rejectedSecrets?: number;
    /** fact-validity 가 거부한 사실 수(사유별) — 템플릿 잔여물·프롬프트 예시·세션 환경 상용구 */
    rejectedInvalid?: Record<string, number>;
    /** 이번 추출이 읽은 그 세션의 교환 수 — 완료 마커(seen_exchanges)에 남긴다 */
    seenExchanges?: number;
}
/** runFactExtraction 의 결과. `skipped` 가 있으면 이 세션은 이번 실행에서 처리되지 않았다. */
export interface ExtractionRunResult {
    extracted: number;
    saved: number;
    /** 세션 상한 때문에 잘린 후보 수(0 이면 없음) — 워커가 로그에 남긴다 */
    truncated?: number;
    /** 자격증명 모양 문자열이 들어 있어 저장하지 않은 사실 수(0 이면 없음) */
    rejectedSecrets?: number;
    /** fact-validity 가 거부한 사실 수(사유별, 없으면 생략) — 프롬프트를 바꾼 뒤 예시 베끼기가 느는지 로그로 본다 */
    rejectedInvalid?: Record<string, number>;
    /** project 사실을 받은 경로가 아닌 본 저장소 루트에 묶었을 때만 — 그 루트(worktree 세션) */
    scopeProject?: string;
    skipped?: 'claim_not_acquired' | 'claim_error' | 'excluded_project' | 'excluded_project_unmarked' | 'not_indexed' | 'no_new_exchanges';
}
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
}): Promise<ExtractionRunResult>;
