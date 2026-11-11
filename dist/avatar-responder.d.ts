import Database from 'better-sqlite3';
import type { AvatarResponse } from './types.js';
import type { LlmErrorClass } from './llm-error-class.js';
/**
 * Why no answer could be generated, when the LLM call failed. Absent on an answer (including "nothing in
 * memory about this"). The `answer` text of a failure is a notice for the user, not an answer — a caller
 * that shows it has to mark it as an error (the MCP tool sets isError).
 */
export type AvatarFailure = 'login' | 'refusal' | LlmErrorClass;
export interface AvatarResult extends AvatarResponse {
    failure?: AvatarFailure;
}
export declare function askAvatar(db: Database.Database, question: string, project?: string): Promise<AvatarResult>;
