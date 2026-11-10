import { SUMMARIZER_CONTEXT_MARKER } from './constants.js';
import { parseConversation } from './parser.js';
import { ConversationExchange } from './types.js';

/**
 * Text that opts a conversation out of the index: a session whose USER message
 * carries one of these is never indexed or summarized (the summarizer's own
 * sessions, and sessions that ask not to be remembered).
 */
export const EXCLUSION_MARKERS: readonly string[] = [
  '<INSTRUCTIONS-TO-EPISODIC-MEMORY>DO NOT INDEX THIS CHAT</INSTRUCTIONS-TO-EPISODIC-MEMORY>',
  'Only use NO_INSIGHTS_FOUND',
  SUMMARIZER_CONTEXT_MARKER,
];

export function hasExclusionMarker(text: string): boolean {
  return EXCLUSION_MARKERS.some(marker => text.includes(marker));
}

export interface GuardedConversation {
  exchanges: ConversationExchange[];
  /** A user message carries an exclusion marker — do not index, do not summarize. */
  excluded: boolean;
}

/**
 * Parse a conversation and judge the exclusion markers in the same pass.
 *
 * Only the text of user messages counts. The check used to read the whole file
 * into one string and search that, which had two failures (measured
 * 2026-11-10): a file over ~512MB threw ERR_STRING_TOO_LONG, the error was
 * swallowed as "no marker", and the conversation was indexed unchecked; and a
 * session that merely READ a file containing a marker (tool output) was dropped
 * whole — 7 real sessions, 324 exchanges, on one index.
 *
 * A file that cannot be read to the end REJECTS: "could not judge" is never
 * "not excluded". Callers must leave such a file unindexed for this run and
 * report the error.
 */
export async function parseGuarded(
  filePath: string,
  project: string,
  archivePath: string,
): Promise<GuardedConversation> {
  let excluded = false;
  const exchanges = await parseConversation(filePath, project, archivePath, {
    userText: (text) => {
      if (!excluded && hasExclusionMarker(text)) excluded = true;
    },
  });
  return { exchanges, excluded };
}
