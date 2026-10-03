/**
 * Project scope canonicalization.
 *
 * Canonical format for facts.scope_project is the absolute project path
 * (e.g. /Users/me/Project/foo). Claude Code archive directories use a slug
 * format (-Users-me-Project-foo) and historic data / cross-device sync can
 * still carry slugs. fact-db matches scope_project by exact equality, so all
 * read and write paths normalize through this module.
 */
const slugCache = new Map();
export function isSlugProject(project) {
    return typeof project === 'string' && project.startsWith('-');
}
/**
 * Claude Code archive dir name: '/', '.', '_' replaced with '-'.
 * (e.g. /Users/me/.claude → -Users-me--claude, article21_admin → article21-admin)
 */
export function slugifyPath(p) {
    return p.replace(/[/._]/g, '-');
}
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
export function exchangeProjectKeys(project) {
    if (!project)
        return [];
    if (isSlugProject(project))
        return [project];
    return [...new Set([project.replace(/[^a-zA-Z0-9]/g, '-'), slugifyPath(project), project])];
}
/**
 * Resolve a slug-format project to its absolute path using the exchanges
 * table as ground truth (project column stores slugs, cwd stores real paths).
 * Path-format input passes through unchanged. Unresolvable slugs are
 * returned as-is so callers never lose data.
 */
export function canonicalizeProject(db, project) {
    if (!project || !isSlugProject(project))
        return project;
    const cached = slugCache.get(project);
    if (cached)
        return cached;
    let resolved = project;
    try {
        const rows = db.prepare(`
      SELECT cwd, COUNT(*) AS n FROM exchanges
      WHERE project = ? AND cwd IS NOT NULL
      GROUP BY cwd ORDER BY n DESC
    `).all(project);
        const exact = rows.find((r) => slugifyPath(r.cwd) === project);
        resolved = (exact || rows[0])?.cwd ?? project;
    }
    catch {
        // exchanges table may not exist yet (fresh DB) — keep input
    }
    if (resolved !== project)
        slugCache.set(project, resolved);
    return resolved;
}
/**
 * Self-healing: normalize any slug-format scope_project rows that slipped in
 * (e.g. imported from another device before it picked up this code).
 * Guarded by a cheap indexed probe so it is safe to run on every DB open.
 * Returns the number of healed rows.
 */
export function autoHealScopeProjects(db) {
    let healed = 0;
    try {
        const probe = db.prepare("SELECT 1 FROM facts WHERE scope_type = 'project' AND scope_project LIKE '-%' LIMIT 1").get();
        if (!probe)
            return 0;
        const slugs = db.prepare("SELECT DISTINCT scope_project AS s FROM facts WHERE scope_type = 'project' AND scope_project LIKE '-%'").all();
        const now = new Date().toISOString();
        for (const { s } of slugs) {
            const canon = canonicalizeProject(db, s);
            if (canon && canon !== s) {
                const r = db.prepare("UPDATE facts SET scope_project = ?, updated_at = ? WHERE scope_type = 'project' AND scope_project = ?").run(canon, now, s);
                healed += r.changes;
            }
        }
    }
    catch {
        // healing must never break DB open
    }
    return healed;
}
