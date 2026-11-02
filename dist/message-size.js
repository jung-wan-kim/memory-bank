/**
 * Oversize guard (ported from obra/episodic-memory #139). A single message that
 * pastes a whole transcript or tool dump is not a memory, and embedding it
 * bloats the index for no recall gain. The embedder only reads the first 2000
 * characters anyway (embeddings.ts), so the rest is pure storage.
 */
export const DEFAULT_MAX_MESSAGE_BYTES = 256 * 1024;
export function getMaxMessageBytes(env = process.env) {
    const raw = env.MEMORY_BANK_MAX_MESSAGE_BYTES;
    const parsed = raw !== undefined ? Number.parseInt(raw, 10) : NaN;
    return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_MESSAGE_BYTES;
}
export function isOversizeExchange(exchange, maxBytes) {
    return (Buffer.byteLength(exchange.userMessage ?? '', 'utf8') > maxBytes ||
        Buffer.byteLength(exchange.assistantMessage ?? '', 'utf8') > maxBytes);
}
