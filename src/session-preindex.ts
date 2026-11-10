import fs from 'fs';
import path from 'path';
import { parseGuarded } from './conversation-guard.js';
import { getExcludedProjects, getProjectsDir, isExcludedProject } from './paths.js';

/**
 * Index one session's transcript right before its facts are extracted.
 *
 * Conversations are indexed only by the SessionStart sync, and facts are
 * extracted at SessionEnd from the index. A session that starts and ends with
 * no other session starting in between is therefore extracted before any of
 * its exchanges are indexed (measured 2026-11-10: 93.7% of the SessionEnd
 * worker's results were 0/0, 88% of those in under 0.2 s — no LLM call). The
 * SessionEnd worker calls this first, so the extractor reads the whole session.
 *
 * The indexing itself is indexer.ts's indexSession (the `index-session` CLI
 * path). Two things it does not do are handled here:
 *  - indexSession indexes any transcript it finds; sync skips one that carries
 *    an exclusion marker. A session the user marked as not-to-be-indexed must
 *    stay unindexed on this path too, so the marker check runs first.
 *  - importing indexer.ts sets CLAUDE_CODE_MAX_OUTPUT_TOKENS for the whole
 *    process (the summarizer's cap). No summary is made here, and the
 *    extraction calls that follow in the same worker keep their own setting.
 */

// One list, one rule: the markers and the check are conversation-guard.ts's — the same ones sync and
// the indexer use (only the text of user messages counts).
export { EXCLUSION_MARKERS as INDEX_EXCLUSION_MARKERS } from './conversation-guard.js';

export type PreindexResult =
  | { status: 'indexed' }             // indexSession ran over this session's transcript
  | { status: 'no_transcript' }       // no transcript for this session under a non-excluded project
  | { status: 'excluded_marker' }     // the transcript carries an exclusion marker — left unindexed
  | { status: 'invalid_session_id' }  // not a session id — nothing was looked up
  | { status: 'failed'; error: string };

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The transcript indexSession would pick for this session (same walk: the first
 * non-excluded project folder holding a .jsonl whose name contains the id), or null.
 */
export function findSessionTranscript(sessionId: string): string | null {
  const projectsDir = getProjectsDir();
  let projects: string[];
  try {
    projects = fs.readdirSync(projectsDir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; // no transcripts root at all
    throw e;
  }
  const excluded = getExcludedProjects();
  for (const project of projects) {
    if (isExcludedProject(project, excluded)) continue;
    const projectPath = path.join(projectsDir, project);
    if (!fs.statSync(projectPath).isDirectory()) continue;
    const file = fs.readdirSync(projectPath).find((f) => f.includes(sessionId) && f.endsWith('.jsonl'));
    if (file) return path.join(projectPath, file);
  }
  return null;
}

/**
 * Index `sessionId`'s transcript (no summary). Never throws: the caller is a
 * detached worker whose next step — extraction — reports for itself whether
 * anything is indexed.
 */
export async function preindexSession(sessionId: string): Promise<PreindexResult> {
  // indexSession matches the id as a substring of the file name; anything
  // shorter than a real id could select another session's transcript.
  if (!SESSION_ID.test(sessionId)) return { status: 'invalid_session_id' };

  const outputCap = process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS;
  try {
    const transcript = findSessionTranscript(sessionId);
    if (!transcript) return { status: 'no_transcript' };

    // A transcript that cannot be read is not indexed here: "could not check"
    // must not become "no marker".
    const project = path.basename(path.dirname(transcript));
    const { excluded } = await parseGuarded(transcript, project, transcript);
    if (excluded) {
      return { status: 'excluded_marker' };
    }

    const { indexSession } = await import('./indexer.js');
    await indexSession(sessionId, 1, true);
    return { status: 'indexed' };
  } catch (e) {
    return { status: 'failed', error: e instanceof Error ? e.message : String(e) };
  } finally {
    if (outputCap === undefined) delete process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS;
    else process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = outputCap;
  }
}
