import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { getDbPath } from './paths.js';
import { canonicalArchiveName } from './archive-io.js';
import { slugifyPath } from './project-canon.js';
import { EXTRACTION_STATE, pendingExtractionCoreQuery, getExtractionConfig, } from './pending-extraction.js';
/**
 * Convert a filesystem path to the Claude Code project slug used in the
 * `exchanges.project` column (e.g. /Users/me/app → -Users-me-app).
 * Uses the canonical slug rule from project-canon ('/', '.', '_' → '-').
 * Values that already look like slugs are returned unchanged.
 */
export function projectSlug(project) {
    if (!project.startsWith('/'))
        return project;
    return slugifyPath(project);
}
const UUID_JSONL = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;
/**
 * Whether an archive path is a main-session conversation (UUID-named file)
 * as opposed to a subagent transcript (agent-*.jsonl). Summaries are only
 * ever generated for main sessions.
 */
export function isMainConversation(archivePath) {
    return UUID_JSONL.test(path.basename(archivePath));
}
function emptyReport() {
    return {
        generatedAt: new Date().toISOString(),
        coverage: {
            totalConversations: 0,
            mainConversations: 0,
            agentTranscripts: 0,
            totalSessions: 0,
            totalExchanges: 0,
            projectCount: 0,
            dateRange: null,
            extraction: { processed: 0, seeded: 0, errors: 0, retrying: 0, pending: 0 },
            summaries: { withSummary: 0, withoutSummary: 0 },
        },
        facts: { active: 0, inactive: 0, byCategory: [], byScope: [] },
        domains: [],
        projects: [],
        timeline: [],
        recommendations: [],
    };
}
export async function analyzeHistory(options = {}) {
    const dbPath = options.dbPath || getDbPath();
    const topProjects = options.topProjects ?? 15;
    const timelineMonths = options.timelineMonths ?? 12;
    let dbExists = true;
    try {
        fs.accessSync(dbPath);
    }
    catch {
        dbExists = false;
    }
    if (!dbExists)
        return emptyReport();
    const db = new Database(dbPath, { readonly: true });
    db.pragma('busy_timeout = 5000');
    try {
        const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()
            .map(t => t.name));
        const report = emptyReport();
        if (!tables.has('exchanges'))
            return report;
        // ── Coverage ───────────────────────────────────────────────────────────
        const cov = db.prepare(`
      SELECT
        COUNT(DISTINCT archive_path) AS conversations,
        COUNT(DISTINCT session_id) AS sessions,
        COUNT(*) AS exchanges,
        COUNT(DISTINCT project) AS projects,
        MIN(timestamp) AS earliest,
        MAX(timestamp) AS latest
      FROM exchanges
    `).get();
        report.coverage.totalConversations = cov.conversations;
        report.coverage.totalSessions = cov.sessions;
        report.coverage.totalExchanges = cov.exchanges;
        report.coverage.projectCount = cov.projects;
        report.coverage.dateRange = cov.earliest && cov.latest
            ? { earliest: cov.earliest, latest: cov.latest }
            : null;
        // ── Extraction coverage ────────────────────────────────────────────────
        if (tables.has('extraction_log')) {
            const ext = db.prepare(`
        SELECT
          SUM(CASE WHEN extracted >= 0 THEN 1 ELSE 0 END) AS processed,
          SUM(CASE WHEN extracted = ${EXTRACTION_STATE.SEED} THEN 1 ELSE 0 END) AS seeded,
          SUM(CASE WHEN extracted = ${EXTRACTION_STATE.PERMANENT} THEN 1 ELSE 0 END) AS errors,
          SUM(CASE WHEN extracted = ${EXTRACTION_STATE.RETRIABLE_INTERNAL} THEN 1 ELSE 0 END) AS retrying
        FROM extraction_log
      `).get();
            report.coverage.extraction.processed = ext.processed ?? 0;
            report.coverage.extraction.seeded = ext.seeded ?? 0;
            report.coverage.extraction.errors = ext.errors ?? 0;
            report.coverage.extraction.retrying = ext.retrying ?? 0;
            // 🚨 손으로 복제하지 않는다. 이 자리에 사본을 두면 반드시 드리프트한다 —
            // 실제로 -4(재시도 예산) 예외만 반영하고 -3(만료 리스 회수) 예외가 빠져서,
            // 주석은 "워커/훅과 같은 의미"라고 주장하는데 35분 된 claim 세션을 '처리됨'
            // 으로 세어 백로그를 과소보고했다(Codex R24 MEDIUM). 단일 소스를 그대로 쓴다.
            //
            // 의미 변화 고지: 공유 쿼리는 최소 교환수·제외 프로젝트 필터를 포함하므로
            // 이 수치는 "워커가 실제로 집을 세션 수"가 된다(이전에는 그 필터가 없는
            // 원시 집계였다). 리포트 목적상 이쪽이 더 정확하다.
            const { sql: pendingSql, params: pendingParams } = pendingExtractionCoreQuery(getExtractionConfig());
            try {
                const pending = db.prepare(`SELECT COUNT(*) AS n FROM (${pendingSql})`)
                    .get(...pendingParams);
                report.coverage.extraction.pending = pending.n;
            }
            catch (e) {
                // 공유 쿼리는 cwd 컬럼을 요구한다(정본 스키마에 있고 initDatabase 가
                // 마이그레이션한다). analyze 는 readonly 로 열어 마이그레이션하지 않으므로,
                // 아주 오래된 미마이그레이션 DB 에서는 실패할 수 있다 — 그때는 사본을
                // 만들어 드리프트를 재생산하는 대신 **측정 불가를 표면화**한다.
                console.error(`analyze: pending 집계 불가(구버전 스키마 추정) — 0 으로 보고하지 않습니다: `
                    + `${e instanceof Error ? e.message : String(e)}`);
                report.coverage.extraction.pending = cov.sessions;
            }
        }
        else {
            report.coverage.extraction.pending = cov.sessions;
        }
        // ── Summary coverage (summary files live next to archived .jsonl) ─────
        // Only main-session conversations (UUID-named) get summaries; subagent
        // transcripts (agent-*.jsonl) are excluded by design.
        // One readdir per archive directory instead of per-file access checks —
        // the real index has ~54K main conversations across <100 directories.
        const conversationPaths = db.prepare('SELECT DISTINCT archive_path FROM exchanges')
            .all();
        const dirListings = new Map();
        const dirListing = (dir) => {
            let names = dirListings.get(dir);
            if (!names) {
                names = new Set();
                try {
                    for (const f of fs.readdirSync(dir))
                        names.add(canonicalArchiveName(f));
                }
                catch {
                    // directory missing — treat as empty
                }
                dirListings.set(dir, names);
            }
            return names;
        };
        let mainConversations = 0;
        let withSummary = 0;
        for (const { archive_path } of conversationPaths) {
            if (!archive_path || !isMainConversation(archive_path))
                continue;
            mainConversations++;
            const summaryName = path.basename(archive_path).replace(/\.jsonl$/, '-summary.txt');
            if (dirListing(path.dirname(archive_path)).has(summaryName)) {
                withSummary++;
            }
        }
        report.coverage.mainConversations = mainConversations;
        report.coverage.agentTranscripts = cov.conversations - mainConversations;
        report.coverage.summaries.withSummary = withSummary;
        report.coverage.summaries.withoutSummary = mainConversations - withSummary;
        // ── Facts ──────────────────────────────────────────────────────────────
        const factsBySlug = new Map();
        if (tables.has('facts')) {
            const factTotals = db.prepare(`
        SELECT
          SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END) AS active,
          SUM(CASE WHEN is_active = 0 THEN 1 ELSE 0 END) AS inactive
        FROM facts
      `).get();
            report.facts.active = factTotals.active ?? 0;
            report.facts.inactive = factTotals.inactive ?? 0;
            report.facts.byCategory = db.prepare(`
        SELECT COALESCE(category, 'uncategorized') AS category, COUNT(*) AS count
        FROM facts WHERE is_active = 1
        GROUP BY category ORDER BY count DESC
      `).all();
            report.facts.byScope = db.prepare(`
        SELECT scope_type AS scope, COUNT(*) AS count
        FROM facts WHERE is_active = 1
        GROUP BY scope_type ORDER BY count DESC
      `).all();
            // Per-project fact counts. scope_project may hold either a cwd path or
            // an already-slugged project name — normalize both to the slug form.
            const factProjects = db.prepare(`
        SELECT scope_project, COUNT(*) AS n
        FROM facts
        WHERE is_active = 1 AND scope_project IS NOT NULL
        GROUP BY scope_project
      `).all();
            for (const row of factProjects) {
                const slug = projectSlug(row.scope_project);
                factsBySlug.set(slug, (factsBySlug.get(slug) ?? 0) + row.n);
            }
        }
        // ── Ontology domains ───────────────────────────────────────────────────
        if (tables.has('ontology_domains') && tables.has('ontology_categories') && tables.has('facts')) {
            report.domains = db.prepare(`
        SELECT d.name AS domain, COUNT(f.id) AS facts
        FROM ontology_domains d
        JOIN ontology_categories c ON c.domain_id = d.id
        JOIN facts f ON f.ontology_category_id = c.id AND f.is_active = 1
        GROUP BY d.id ORDER BY facts DESC
        LIMIT 10
      `).all();
        }
        // ── Per-project rollups ────────────────────────────────────────────────
        const projectRows = db.prepare(`
      SELECT
        project,
        COUNT(DISTINCT archive_path) AS conversations,
        COUNT(DISTINCT session_id) AS sessions,
        COUNT(*) AS exchanges,
        MIN(timestamp) AS firstActivity,
        MAX(timestamp) AS lastActivity
      FROM exchanges
      GROUP BY project
      ORDER BY exchanges DESC
      LIMIT ?
    `).all(topProjects);
        report.projects = projectRows.map(p => ({
            project: p.project,
            conversations: p.conversations,
            sessions: p.sessions,
            exchanges: p.exchanges,
            facts: factsBySlug.get(p.project) ?? 0,
            firstActivity: p.firstActivity,
            lastActivity: p.lastActivity,
        }));
        // ── Monthly timeline ───────────────────────────────────────────────────
        report.timeline = db.prepare(`
      SELECT
        substr(timestamp, 1, 7) AS month,
        COUNT(*) AS exchanges,
        COUNT(DISTINCT session_id) AS sessions
      FROM exchanges
      WHERE timestamp IS NOT NULL AND timestamp != ''
      GROUP BY month
      ORDER BY month DESC
      LIMIT ?
    `).all(timelineMonths).reverse();
        // ── Recommendations ────────────────────────────────────────────────────
        const rec = [];
        if (report.coverage.extraction.pending > 0) {
            rec.push(`${report.coverage.extraction.pending} sessions have no extracted facts yet — run scripts/backfill-extract-worker.js (requires ANTHROPIC_API_KEY).`);
        }
        if (report.coverage.summaries.withoutSummary > 0) {
            rec.push(`${report.coverage.summaries.withoutSummary} conversations are missing summaries — run "memory-bank sync" (generates up to 10 per run).`);
        }
        if (report.coverage.extraction.errors > 0) {
            rec.push(`${report.coverage.extraction.errors} sessions failed extraction — check backfill-extract.log in the index directory.`);
        }
        if (rec.length === 0) {
            rec.push('Analysis coverage is complete — no backfill needed.');
        }
        report.recommendations = rec;
        return report;
    }
    finally {
        db.close();
    }
}
function pct(part, total) {
    if (total === 0)
        return '0.0%';
    return ((part / total) * 100).toFixed(1) + '%';
}
function fmtDate(iso) {
    if (!iso)
        return '-';
    return iso.slice(0, 10);
}
/**
 * Escape DB-sourced text for Markdown table cells — crafted project/category
 * names must not be able to inject fake rows or headings into the report.
 */
function mdCell(value) {
    return value
        .replace(/\\/g, '\\\\') // backslashes first, or `\|` input re-arms the pipe
        .replace(/\|/g, '\\|')
        .replace(/[\r\n]+/g, ' ');
}
export function formatAnalysisMarkdown(report) {
    const c = report.coverage;
    const lines = [];
    lines.push('# Conversation History Analysis');
    lines.push('');
    lines.push(`Generated: ${report.generatedAt}`);
    lines.push('');
    lines.push('## Coverage');
    lines.push('');
    lines.push(`- Conversations: ${c.totalConversations.toLocaleString()} (main sessions ${c.mainConversations.toLocaleString()}, agent transcripts ${c.agentTranscripts.toLocaleString()})`);
    lines.push(`- Sessions: ${c.totalSessions.toLocaleString()}`);
    lines.push(`- Exchanges: ${c.totalExchanges.toLocaleString()}`);
    lines.push(`- Projects: ${c.projectCount.toLocaleString()}`);
    if (c.dateRange) {
        lines.push(`- Date range: ${fmtDate(c.dateRange.earliest)} ~ ${fmtDate(c.dateRange.latest)}`);
    }
    lines.push('');
    lines.push('| Pipeline | Done | Pending | Coverage |');
    lines.push('|----------|------|---------|----------|');
    const extDone = c.extraction.processed + c.extraction.seeded;
    // Failed sessions stay in the denominator — errors are not coverage.
    const extTotal = extDone + c.extraction.pending + c.extraction.errors;
    const extRemaining = c.extraction.pending + c.extraction.errors;
    lines.push(`| Fact extraction | ${extDone.toLocaleString()} | ${extRemaining.toLocaleString()} | ${pct(extDone, extTotal)} |`);
    lines.push(`| Summaries (main sessions) | ${c.summaries.withSummary.toLocaleString()} | ${c.summaries.withoutSummary.toLocaleString()} | ${pct(c.summaries.withSummary, c.mainConversations)} |`);
    lines.push('');
    lines.push('## Facts');
    lines.push('');
    lines.push(`- Active: ${report.facts.active.toLocaleString()} / Inactive: ${report.facts.inactive.toLocaleString()}`);
    if (report.facts.byCategory.length > 0) {
        lines.push('');
        lines.push('| Category | Count |');
        lines.push('|----------|-------|');
        for (const row of report.facts.byCategory) {
            lines.push(`| ${mdCell(row.category)} | ${row.count.toLocaleString()} |`);
        }
    }
    if (report.facts.byScope.length > 0) {
        lines.push('');
        lines.push('| Scope | Count |');
        lines.push('|-------|-------|');
        for (const row of report.facts.byScope) {
            lines.push(`| ${mdCell(row.scope)} | ${row.count.toLocaleString()} |`);
        }
    }
    lines.push('');
    if (report.domains.length > 0) {
        lines.push('## Top Knowledge Domains');
        lines.push('');
        lines.push('| Domain | Facts |');
        lines.push('|--------|-------|');
        for (const d of report.domains) {
            lines.push(`| ${mdCell(d.domain)} | ${d.facts.toLocaleString()} |`);
        }
        lines.push('');
    }
    if (report.projects.length > 0) {
        lines.push('## Top Projects');
        lines.push('');
        lines.push('| Project | Conversations | Sessions | Exchanges | Facts | First | Last |');
        lines.push('|---------|---------------|----------|-----------|-------|-------|------|');
        for (const p of report.projects) {
            lines.push(`| ${mdCell(p.project)} | ${p.conversations.toLocaleString()} | ${p.sessions.toLocaleString()} | ${p.exchanges.toLocaleString()} | ${p.facts.toLocaleString()} | ${fmtDate(p.firstActivity)} | ${fmtDate(p.lastActivity)} |`);
        }
        lines.push('');
    }
    if (report.timeline.length > 0) {
        lines.push('## Monthly Activity');
        lines.push('');
        lines.push('| Month | Sessions | Exchanges |');
        lines.push('|-------|----------|-----------|');
        for (const m of report.timeline) {
            lines.push(`| ${mdCell(m.month)} | ${m.sessions.toLocaleString()} | ${m.exchanges.toLocaleString()} |`);
        }
        lines.push('');
    }
    lines.push('## Recommendations');
    lines.push('');
    for (const r of report.recommendations) {
        lines.push(`- ${r}`);
    }
    lines.push('');
    return lines.join('\n');
}
