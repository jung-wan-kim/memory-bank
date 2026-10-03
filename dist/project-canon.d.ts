import Database from 'better-sqlite3';
export declare function isSlugProject(project: string | null | undefined): boolean;
/**
 * Claude Code archive dir name: '/', '.', '_' replaced with '-'.
 * (e.g. /Users/me/.claude → -Users-me--claude, article21_admin → article21-admin)
 */
export declare function slugifyPath(p: string): string;
/**
 * Values to compare against `exchanges.project` for a hook-supplied project.
 *
 * Hooks hand us the absolute cwd; `exchanges.project` stores Claude Code's
 * archive-dir slug. Comparing the two directly never matches — detectRepeat
 * returned 0 matches across 2,686 injection events for exactly this reason
 * (measured 2026-10-03). Claude Code builds the slug by replacing EVERY
 * non-alphanumeric char with '-' (a Korean path segment becomes dashes), which
 * is wider than slugifyPath's '/', '.', '_' rule, so both forms are returned.
 * Slug input, and any value that is already a stored label, passes through.
 */
export declare function exchangeProjectKeys(project: string): string[];
/**
 * Resolve a slug-format project to its absolute path using the exchanges
 * table as ground truth (project column stores slugs, cwd stores real paths).
 * Path-format input passes through unchanged. Unresolvable slugs are
 * returned as-is so callers never lose data.
 */
export declare function canonicalizeProject(db: Database.Database, project: string): string;
/**
 * Self-healing: normalize any slug-format scope_project rows that slipped in
 * (e.g. imported from another device before it picked up this code).
 * Guarded by a cheap indexed probe so it is safe to run on every DB open.
 * Returns the number of healed rows.
 */
export declare function autoHealScopeProjects(db: Database.Database): number;
