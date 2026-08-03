export declare function llmWorkdir(): string;
export declare function pruneLlmTranscripts(now?: number): void;
/**
 * Call Haiku via Claude Agent SDK (no API key needed inside Claude Code —
 * billed to the local subscription, NOT a metered API key).
 * Falls back to direct Anthropic SDK only if ANTHROPIC_API_KEY is set
 * (standalone use outside Claude Code).
 *
 * 복구 계약 (2026-07-17 — 사용자 피드백 "에러나거나 0바이트인데 재시도·복구가 없다"):
 *  - **빈 응답('')도 실패**다. 모든 호출자가 JSON 을 요구하므로 빈 본문은 유효한 답이
 *    될 수 없는데, 예전엔 '' 를 반환해 호출자가 "정상적으로 아무것도 없음"으로 소비했다
 *    (consolidator 는 verdict 'none' 으로 확정+예산 소모, fact-extractor 는 배치를 조용히
 *    버리고 세션을 extraction_log 에 완료 기록 → 그 대화의 fact 영구 손실).
 *  - transient(빈 응답·429/5xx/네트워크/타임아웃)와 unknown 은 **유한 재시도**(기본 2회,
 *    지수 백오프)로 일회성 flake 를 흡수한다. 같은 파일 계열의 임베딩 경로는 이미
 *    probe+재시도로 flake 를 흡수하고 있었고(ontology-classifier), LLM 경로만 없었다.
 *  - deterministic(400/413/max_tokens 등 이 요청 자체가 잘못됨)은 **재시도하지 않는다** —
 *    같은 입력은 같은 결과이고 재시도는 예산 낭비다.
 *  - 재시도를 소진하면 '' 가 아니라 **throw** 한다. 그래야 호출자의 3분류(transient 는
 *    보류·재시도, deterministic 은 attempt 소모)가 비로소 작동한다 (fail-loud).
 * 호출자 계약: 성공 반환값은 **비어있지 않음이 보장**된다.
 */
export declare function callHaiku(systemPrompt: string, userMessage: string, maxTokens?: number): Promise<string>;
export declare function parseJsonResponse<T>(text: string): T | null;
