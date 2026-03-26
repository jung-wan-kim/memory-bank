#!/usr/bin/env node
/**
 * Memory Bank Web UI v2
 * Cinematic dark-theme conversation explorer
 */
const http = require('http');
const path = require('path');
const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, '..');
const Database = require(path.join(PLUGIN_ROOT, 'node_modules/better-sqlite3'));

const DB_PATH = path.join(process.env.HOME, '.config/superpowers/conversation-index/db.sqlite');
const PORT = process.env.PORT || 3847;

let db;
try { db = new Database(DB_PATH, { readonly: true }); }
catch (e) { console.error(`DB open failed: ${DB_PATH}\n${e.message}`); process.exit(1); }

function query(sql, params = []) { return db.prepare(sql).all(...params); }
function queryOne(sql, params = []) { return db.prepare(sql).get(...params); }

// Translation cache (in-memory, persists during server lifetime)
const translationCache = new Map();

async function translateTexts(texts) {
  if (!texts || texts.length === 0) return [];

  // Filter already cached
  const uncached = [];
  const results = new Array(texts.length);
  for (let i = 0; i < texts.length; i++) {
    const cached = translationCache.get(texts[i]);
    if (cached) { results[i] = cached; }
    else { uncached.push({ index: i, text: texts[i] }); }
  }

  if (uncached.length === 0) return results;

  const textsToTranslate = uncached.map(u => u.text);

  try {
    // Use translate-worker.mjs (Agent SDK - no API key needed)
    const { execFileSync } = require('child_process');
    const workerPath = path.join(__dirname, 'translate-worker.mjs');
    const output = execFileSync('node', [workerPath], {
      input: JSON.stringify(textsToTranslate),
      encoding: 'utf-8',
      timeout: 30000,
      env: { ...process.env, NODE_NO_WARNINGS: '1' }
    });

    const translated = JSON.parse(output.trim());
    for (let i = 0; i < uncached.length; i++) {
      const kr = translated[i] || uncached[i].text;
      results[uncached[i].index] = kr;
      translationCache.set(uncached[i].text, kr);
    }
  } catch (e) {
    console.error('Translation failed:', e.message);
    for (const { index, text } of uncached) results[index] = text;
  }

  return results;
}

const apiHandlers = {
  '/api/stats': () => {
    const total = queryOne('SELECT COUNT(*) as cnt FROM exchanges');
    const projects = queryOne('SELECT COUNT(DISTINCT project) as cnt FROM exchanges');
    const tools = queryOne('SELECT COUNT(*) as cnt FROM tool_calls');
    const dateRange = queryOne('SELECT MIN(timestamp) as first_ts, MAX(timestamp) as last_ts FROM exchanges');
    return { total: total.cnt, projects: projects.cnt, tools: tools.cnt, first: dateRange.first_ts, last: dateRange.last_ts };
  },

  '/api/projects': () => {
    return query(`
      SELECT p.project, p.count, p.first_seen, p.last_seen, lp.user_message as last_prompt, cwd_t.real_path
      FROM (
        SELECT project, COUNT(*) as count, MIN(timestamp) as first_seen, MAX(timestamp) as last_seen
        FROM exchanges GROUP BY project
      ) p
      LEFT JOIN (
        SELECT project, MIN(cwd) as real_path
        FROM exchanges
        WHERE cwd IS NOT NULL AND length(cwd) > 1
        GROUP BY project
      ) cwd_t ON p.project = cwd_t.project
      LEFT JOIN (
        SELECT e1.project, e1.user_message
        FROM exchanges e1
        INNER JOIN (
          SELECT project, MAX(timestamp) as max_ts
          FROM exchanges
          WHERE user_message NOT LIKE '%<observed_from_primary_session>%'
            AND user_message NOT LIKE '%<task-notification>%'
            AND user_message NOT LIKE '%<what_happened>%'
            AND user_message NOT LIKE '%<command-%'
            AND user_message NOT LIKE '%<local-command-%'
            AND user_message NOT LIKE 'PROGRESS SUMMARY%'
            AND user_message NOT LIKE 'Warmup%'
            AND user_message NOT LIKE 'cd %'
            AND user_message NOT LIKE '# /%'
            AND user_message NOT LIKE '%<system-reminder>%'
            AND user_message NOT LIKE '%<teammate-message%'
            AND user_message NOT LIKE '[Image:%'
            AND length(user_message) > 2 AND length(user_message) < 2000
          GROUP BY project
        ) e2 ON e1.project = e2.project AND e1.timestamp = e2.max_ts
          AND e1.user_message NOT LIKE '%<observed_from_primary_session>%'
          AND e1.user_message NOT LIKE '%<task-notification>%'
          AND e1.user_message NOT LIKE '%<what_happened>%'
          AND e1.user_message NOT LIKE '%<command-%'
          AND e1.user_message NOT LIKE '%<local-command-%'
          AND e1.user_message NOT LIKE 'PROGRESS SUMMARY%'
          AND e1.user_message NOT LIKE 'Warmup%'
          AND e1.user_message NOT LIKE 'cd %'
          AND e1.user_message NOT LIKE '# /%'
          AND length(e1.user_message) > 2 AND length(e1.user_message) < 2000
      ) lp ON p.project = lp.project
      ORDER BY p.last_seen DESC
    `);
  },

  '/api/search': (params) => {
    const q = params.get('q') || '', project = params.get('project') || '';
    const limit = Math.min(parseInt(params.get('limit') || '50'), 200);
    const offset = parseInt(params.get('offset') || '0');
    let where = [], args = [];
    if (q) { where.push('(e.user_message LIKE ? OR e.assistant_message LIKE ?)'); args.push(`%${q}%`, `%${q}%`); }
    if (project) { where.push('e.project = ?'); args.push(project); }
    const wc = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const cnt = queryOne(`SELECT COUNT(*) as cnt FROM exchanges e ${wc}`, args);
    const rows = query(`SELECT e.id, e.project, e.timestamp, e.user_message, e.assistant_message, e.session_id, e.cwd, e.git_branch FROM exchanges e ${wc} ORDER BY e.timestamp DESC LIMIT ? OFFSET ?`, [...args, limit, offset]);
    return { total: cnt.cnt, offset, limit, results: rows };
  },

  '/api/exchange': (params) => {
    const id = params.get('id');
    if (!id) return { error: 'id required' };
    const row = queryOne('SELECT * FROM exchanges WHERE id = ?', [id]);
    const tools = query('SELECT * FROM tool_calls WHERE exchange_id = ? ORDER BY timestamp', [id]);
    return { exchange: row, tools };
  },

  '/api/user-prompts': (params) => {
    const q = params.get('q') || '', project = params.get('project') || '';
    const limit = Math.min(parseInt(params.get('limit') || '50'), 200);
    const offset = parseInt(params.get('offset') || '0');
    let where = ["e.user_message NOT LIKE '%<observed_from_primary_session>%'", "e.user_message NOT LIKE '%<what_happened>%'", "length(e.user_message) > 1", "length(e.user_message) < 5000"];
    let args = [];
    if (q) { where.push('e.user_message LIKE ?'); args.push(`%${q}%`); }
    if (project) { where.push('e.project = ?'); args.push(project); }
    const wc = 'WHERE ' + where.join(' AND ');
    const cnt = queryOne(`SELECT COUNT(*) as cnt FROM exchanges e ${wc}`, args);
    const rows = query(`SELECT e.id, e.project, e.timestamp, e.user_message, e.session_id FROM exchanges e ${wc} ORDER BY e.timestamp DESC LIMIT ? OFFSET ?`, [...args, limit, offset]);
    return { total: cnt.cnt, offset, limit, results: rows };
  }
};

// Project detail API
apiHandlers['/api/project-detail'] = (params) => {
  const project = params.get('project');
  if (!project) return { error: 'project required' };

  const info = queryOne(`
    SELECT COUNT(*) as exchanges, COUNT(DISTINCT session_id) as sessions,
           MIN(timestamp) as first_seen, MAX(timestamp) as last_seen,
           COUNT(DISTINCT git_branch) as branches
    FROM exchanges WHERE project = ?
  `, [project]);

  const toolUsage = query(`
    SELECT tc.tool_name, COUNT(*) as cnt
    FROM tool_calls tc JOIN exchanges e ON tc.exchange_id = e.id
    WHERE e.project = ?
    GROUP BY tc.tool_name ORDER BY cnt DESC LIMIT 20
  `, [project]);

  const activity = query(`
    SELECT date(timestamp) as day, COUNT(*) as cnt
    FROM exchanges WHERE project = ?
    GROUP BY date(timestamp) ORDER BY day DESC LIMIT 60
  `, [project]);

  const recentPrompts = query(`
    SELECT user_message, timestamp FROM exchanges
    WHERE project = ? AND length(user_message) > 5 AND length(user_message) < 2000
      AND user_message NOT LIKE '%<system-reminder>%'
      AND user_message NOT LIKE '%<command-%'
      AND user_message NOT LIKE '%<local-command-%'
      AND user_message NOT LIKE 'Warmup%'
    ORDER BY timestamp DESC LIMIT 10
  `, [project]);

  let facts = [];
  try {
    facts = query(`
      SELECT fact, category, scope_type FROM facts
      WHERE is_active = 1 AND (scope_project = ? OR scope_type = 'global')
      ORDER BY consolidated_count DESC LIMIT 20
    `, [project]);
  } catch(e) {}

  const sessions = query(`
    SELECT session_id, MIN(timestamp) as started, MAX(timestamp) as ended, COUNT(*) as exchanges
    FROM exchanges WHERE project = ? AND session_id IS NOT NULL
    GROUP BY session_id ORDER BY started DESC LIMIT 15
  `, [project]);

  return { project, info, toolUsage, activity, recentPrompts, facts, sessions };
};

// Translation API (async handler - special case)
const asyncHandlers = {
  '/api/translate': async (params, body) => {
    const texts = body && body.texts ? body.texts : [];
    if (!texts.length) return { translated: [] };
    const translated = await translateTexts(texts.slice(0, 50)); // max 50 at a time
    return { translated };
  }
};

// Graph 3D data API
apiHandlers['/api/graph-data'] = () => {
  const projects = query(`
    SELECT project, COUNT(*) as exchanges, COUNT(DISTINCT session_id) as sessions,
           MIN(timestamp) as first_seen, MAX(timestamp) as last_seen,
           COUNT(DISTINCT git_branch) as branches
    FROM exchanges GROUP BY project ORDER BY exchanges DESC
  `);
  const toolUsage = query(`
    SELECT e.project, tc.tool_name, COUNT(*) as cnt
    FROM tool_calls tc JOIN exchanges e ON tc.exchange_id = e.id
    GROUP BY e.project, tc.tool_name ORDER BY cnt DESC
  `);
  const connections = query(`
    SELECT DISTINCT e1.project as source, e2.project as target, COUNT(*) as strength
    FROM exchanges e1 JOIN exchanges e2 ON e1.session_id = e2.session_id AND e1.project < e2.project
    GROUP BY e1.project, e2.project HAVING strength > 2
  `);
  const allTools = query(`
    SELECT tool_name, COUNT(*) as cnt FROM tool_calls GROUP BY tool_name ORDER BY cnt DESC LIMIT 50
  `);
  let facts = [];
  try { facts = query(`SELECT id, fact, category, scope_type, scope_project FROM facts WHERE is_active = 1 LIMIT 200`); } catch(e) {}
  let domains = [];
  try { domains = query(`SELECT id, name, description FROM ontology_domains`); } catch(e) {}
  let relations = [];
  try { relations = query(`SELECT source_fact_id, relation_type, target_fact_id FROM ontology_relations LIMIT 500`); } catch(e) {}
  return { projects, toolUsage, connections, timeline: [], allTools, facts, domains, relations };
};

// Serve graph-3d.html with live data injected server-side
function serveGraph3D(res) {
  const fs = require('fs');
  const graphPath = path.join(PLUGIN_ROOT, 'docs', 'graph-3d.html');
  if (fs.existsSync(graphPath)) {
    let html = fs.readFileSync(graphPath, 'utf-8');
    // Replace hardcoded var R={...} data with live DB data
    const liveData = apiHandlers['/api/graph-data']();
    html = html.replace(
      /var R=\{[\s\S]*?\n(?=var DOM=)/,
      `var R=${JSON.stringify(liveData)};\n`
    );
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(html);
  } else {
    res.writeHead(404); res.end('graph-3d.html not found');
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/' || url.pathname === '/graph') {
    serveGraph3D(res);
    return;
  }
  if (url.pathname === '/dashboard') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(getHTML());
    return;
  }
  // Async API handlers (translation etc.)
  if (asyncHandlers[url.pathname]) {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const parsed = body ? JSON.parse(body) : {};
        const result = await asyncHandlers[url.pathname](url.searchParams, parsed);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }
  if (apiHandlers[url.pathname]) {
    try {
      const result = apiHandlers[url.pathname](url.searchParams);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(result));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, () => console.log(`Memory Bank UI: http://localhost:${PORT}`));
process.on('SIGINT', () => { db.close(); process.exit(); });
process.on('SIGTERM', () => { db.close(); process.exit(); });

function getHTML() {
  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Memory Bank</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500&family=Outfit:wght@300;400;500;600;700&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{
  --bg:#08090c;--bg-card:rgba(14,16,22,0.85);--bg-glass:rgba(20,24,36,0.6);
  --bg-hover:rgba(30,36,52,0.7);--border:rgba(255,255,255,0.06);--border-hover:rgba(255,255,255,0.12);
  --text:#d4d8e8;--text-dim:#6b7394;--text-bright:#f0f2fa;
  --accent:#6c8aff;--accent-glow:rgba(108,138,255,0.15);--accent2:#34d399;--accent2-glow:rgba(52,211,153,0.12);
  --warn:#f59e0b;--err:#ef4444;
  --radius:12px;--radius-sm:8px;
}
html{font-size:15px}
body{font-family:'Outfit',sans-serif;background:var(--bg);color:var(--text);min-height:100vh;
  background-image:radial-gradient(ellipse 80% 60% at 50% -20%, rgba(108,138,255,0.06), transparent),
                    radial-gradient(ellipse 60% 40% at 80% 100%, rgba(52,211,153,0.04), transparent);
}
::selection{background:var(--accent);color:#fff}
::-webkit-scrollbar{width:6px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:rgba(255,255,255,0.1);border-radius:3px}

/* Header */
.header{padding:20px 32px;display:flex;align-items:center;justify-content:space-between;
  border-bottom:1px solid var(--border);backdrop-filter:blur(20px);position:sticky;top:0;z-index:100;
  background:rgba(8,9,12,0.8)}
.logo{display:flex;align-items:center;gap:12px}
.logo-icon{width:32px;height:32px;border-radius:8px;
  background:linear-gradient(135deg,var(--accent),#a78bfa);
  display:flex;align-items:center;justify-content:center;font-size:16px;font-weight:700;color:#fff}
.logo h1{font-size:20px;font-weight:600;color:var(--text-bright);letter-spacing:-0.5px}
.logo span{font-size:11px;color:var(--text-dim);font-weight:400;letter-spacing:1px;text-transform:uppercase;margin-left:4px}
.header-stats{display:flex;gap:20px}
.stat{text-align:right}
.stat-value{font-family:'JetBrains Mono',monospace;font-size:18px;font-weight:500;color:var(--text-bright)}
.stat-label{font-size:11px;color:var(--text-dim);text-transform:uppercase;letter-spacing:0.5px}

/* Tabs */
.tabs{display:flex;gap:4px;padding:12px 32px;border-bottom:1px solid var(--border);background:rgba(8,9,12,0.5)}
.tab{padding:8px 20px;cursor:pointer;border-radius:20px;color:var(--text-dim);font-size:13px;font-weight:500;
  transition:all 0.2s;letter-spacing:0.2px}
.tab:hover{color:var(--text);background:var(--bg-glass)}
.tab.active{color:var(--accent);background:var(--accent-glow);font-weight:600}

/* Content */
#content{padding:24px 32px;animation:fadeIn 0.3s ease}
@keyframes fadeIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}

/* Controls */
.controls{display:flex;gap:10px;margin-bottom:20px;flex-wrap:wrap}
.search-input{flex:1;min-width:240px;background:var(--bg-glass);border:1px solid var(--border);color:var(--text-bright);
  padding:10px 16px;border-radius:20px;font-size:14px;font-family:'Outfit',sans-serif;
  backdrop-filter:blur(10px);transition:all 0.2s}
.search-input:focus{border-color:var(--accent);outline:none;box-shadow:0 0 0 3px var(--accent-glow)}
.search-input::placeholder{color:var(--text-dim)}
select{background:var(--bg-glass);border:1px solid var(--border);color:var(--text);padding:10px 16px;
  border-radius:20px;font-size:13px;font-family:'Outfit',sans-serif;cursor:pointer;backdrop-filter:blur(10px)}
select:focus{border-color:var(--accent);outline:none}
.btn{background:linear-gradient(135deg,var(--accent),#818cf8);color:#fff;border:none;padding:10px 24px;
  border-radius:20px;cursor:pointer;font-size:13px;font-weight:600;font-family:'Outfit',sans-serif;
  transition:all 0.2s;letter-spacing:0.3px}
.btn:hover{transform:translateY(-1px);box-shadow:0 4px 16px rgba(108,138,255,0.3)}
.btn-ghost{background:var(--bg-glass);color:var(--text);border:1px solid var(--border);font-weight:500}
.btn-ghost:hover{border-color:var(--border-hover);transform:translateY(-1px);box-shadow:0 2px 8px rgba(0,0,0,0.3)}

/* Sort Toggle */
.sort-bar{display:flex;align-items:center;gap:4px;margin-bottom:20px;background:var(--bg-glass);
  border:1px solid var(--border);border-radius:20px;padding:3px;width:fit-content}
.sort-btn{padding:6px 16px;border-radius:17px;border:none;background:transparent;color:var(--text-dim);
  font-size:12px;font-weight:500;cursor:pointer;font-family:'Outfit',sans-serif;transition:all 0.2s;letter-spacing:0.2px}
.sort-btn.active{background:var(--accent-glow);color:var(--accent);font-weight:600}
.sort-btn:hover:not(.active){color:var(--text)}

/* Group */
.group{margin-bottom:28px}
.group-title{font-size:12px;font-weight:600;color:var(--text-dim);text-transform:uppercase;letter-spacing:1.5px;
  margin-bottom:12px;display:flex;align-items:center;gap:10px}
.group-title::after{content:'';flex:1;height:1px;background:var(--border)}
.group-count{font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--text-dim);
  background:var(--bg-glass);padding:2px 10px;border-radius:10px;font-weight:400}

/* Project Cards */
.project-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:10px}
.project-card{background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius);
  padding:16px 18px;cursor:pointer;transition:all 0.25s;position:relative;overflow:hidden;
  display:flex;flex-direction:column}
.project-card::before{content:'';position:absolute;top:0;left:0;right:0;height:2px;
  background:linear-gradient(90deg,var(--accent),var(--accent2));opacity:0;transition:opacity 0.25s}
.project-card:hover{border-color:var(--border-hover);transform:translateY(-2px);
  box-shadow:0 8px 32px rgba(0,0,0,0.4)}
.project-card:hover::before{opacity:1}
.project-name{font-size:14px;font-weight:600;color:var(--text-bright);margin-bottom:2px;
  word-break:break-all;line-height:1.4}
.project-path{font-size:11px;color:var(--text-dim);margin-bottom:8px;font-family:'JetBrains Mono',monospace;
  opacity:0.7;word-break:break-all}
.project-prompt{font-size:12px;color:var(--text-dim);margin-bottom:10px;line-height:1.5;
  max-height:36px;overflow:hidden;font-style:italic;opacity:0.8}
.project-prompt{flex:1}
.project-meta{display:flex;justify-content:space-between;align-items:center;margin-top:auto}
.project-stat{font-family:'JetBrains Mono',monospace;font-size:12px;color:var(--accent);font-weight:500}
.project-date{font-size:11px;color:var(--text-dim)}

/* Exchange List */
.exchange-list{display:flex;flex-direction:column;gap:6px}
.exchange-item{background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-sm);
  padding:14px 18px;cursor:pointer;transition:all 0.2s}
.exchange-item:hover{border-color:var(--border-hover);background:var(--bg-hover)}
.exchange-msg{font-size:13px;color:var(--text-bright);margin-bottom:8px;white-space:pre-wrap;
  max-height:72px;overflow:hidden;line-height:1.5}
.exchange-meta{display:flex;gap:16px;font-size:11px;color:var(--text-dim)}
.exchange-meta .project-tag{color:var(--accent);font-weight:500}

/* Detail */
.detail-view{background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius);padding:24px}
.detail-header{display:flex;gap:16px;margin-bottom:20px;flex-wrap:wrap;font-size:12px;color:var(--text-dim)}
.detail-header span{background:var(--bg-glass);padding:4px 12px;border-radius:16px}
.msg-block{padding:16px;border-radius:var(--radius-sm);margin-bottom:10px;white-space:pre-wrap;
  font-size:13px;line-height:1.7;max-height:500px;overflow-y:auto}
.msg-user{background:rgba(108,138,255,0.06);border-left:3px solid var(--accent)}
.msg-assistant{background:rgba(52,211,153,0.05);border-left:3px solid var(--accent2)}
.msg-tool{background:rgba(245,158,11,0.05);border-left:3px solid var(--warn);font-family:'JetBrains Mono',monospace;
  font-size:12px;padding:10px 14px;margin:4px 0}
.msg-label{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px;display:block}
.msg-user .msg-label{color:var(--accent)}
.msg-assistant .msg-label{color:var(--accent2)}

/* Pagination */
.pagination{display:flex;gap:10px;padding:20px 0;justify-content:center;align-items:center}
.page-info{color:var(--text-dim);font-size:13px;font-family:'JetBrains Mono',monospace}

/* Searchable Select */
.searchable-select{position:relative;min-width:220px}
.ss-trigger{background:var(--bg-glass);border:1px solid var(--border);color:var(--text);padding:10px 36px 10px 16px;
  border-radius:20px;font-size:13px;font-family:'Outfit',sans-serif;cursor:pointer;backdrop-filter:blur(10px);
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;transition:all 0.2s;width:100%}
.ss-trigger:hover{border-color:var(--border-hover)}
.ss-trigger.open{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-glow);border-radius:20px 20px 0 0}
.ss-trigger::after{content:'';position:absolute;right:14px;top:50%;transform:translateY(-50%);
  border:5px solid transparent;border-top:5px solid var(--text-dim);transition:transform 0.2s}
.ss-trigger.open::after{transform:translateY(-50%) rotate(180deg)}
.ss-dropdown{position:absolute;top:100%;left:0;right:0;background:var(--bg-card);border:1px solid var(--accent);
  border-top:none;border-radius:0 0 12px 12px;max-height:320px;overflow:hidden;z-index:200;
  display:none;flex-direction:column;box-shadow:0 12px 40px rgba(0,0,0,0.5)}
.ss-dropdown.open{display:flex}
.ss-search{background:var(--bg-glass);border:none;border-bottom:1px solid var(--border);color:var(--text-bright);
  padding:10px 14px;font-size:13px;font-family:'Outfit',sans-serif;outline:none}
.ss-search::placeholder{color:var(--text-dim)}
.ss-list{overflow-y:auto;max-height:264px}
.ss-option{padding:8px 14px;cursor:pointer;font-size:13px;color:var(--text);transition:background 0.15s;
  display:flex;justify-content:space-between;align-items:center}
.ss-option:hover,.ss-option.highlighted{background:var(--bg-hover);color:var(--text-bright)}
.ss-option.selected{color:var(--accent);font-weight:500}
.ss-option .ss-count{font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--text-dim)}
.ss-empty{padding:12px 14px;font-size:12px;color:var(--text-dim);text-align:center;font-style:italic}

/* Utils */
.result-count{font-family:'JetBrains Mono',monospace;font-size:13px;color:var(--text-dim);margin-bottom:16px}

/* Responsive */
@media(max-width:1200px){
  .project-grid{grid-template-columns:repeat(auto-fill,minmax(280px,1fr))}
}
@media(max-width:768px){
  .header{padding:14px 16px;flex-direction:column;gap:12px;align-items:flex-start}
  .header-stats{gap:16px}
  .stat-value{font-size:15px}
  .tabs{padding:8px 16px;overflow-x:auto;-webkit-overflow-scrolling:touch}
  #content{padding:16px}
  .project-grid{grid-template-columns:1fr}
  .controls{flex-direction:column}
  .search-input{min-width:100%}
  .exchange-meta{flex-wrap:wrap}
  .detail-header{flex-wrap:wrap;gap:8px}
  .pagination{flex-wrap:wrap}
}
@media(max-width:480px){
  .header-stats{flex-wrap:wrap;gap:10px}
  .stat{text-align:left}
  .logo h1{font-size:17px}
  .project-card{padding:12px 14px}
  .project-name{font-size:13px}
  .msg-block{padding:12px;font-size:12px}
}
</style>
</head>
<body>

<div class="header">
  <div class="logo">
    <div class="logo-icon">M</div>
    <div><h1>Memory Bank</h1></div>
  </div>
  <div class="header-stats" id="stats"></div>
</div>

<div class="tabs">
  <div class="tab active" data-tab="projects">Projects</div>
  <div class="tab" data-tab="search">Search</div>
  <div class="tab" data-tab="prompts">User Prompts</div>
</div>

<div id="content"></div>

<script>
let currentTab='projects',currentProject='',searchOffset=0,projectSortBy='last_seen';

function esc(s){if(!s)return'';const d=document.createElement('div');d.textContent=s;return d.innerHTML}
// real_path가 있으면 사용, 없으면 project key에서 추정
const projectPathMap={};
function registerPath(project,realPath){if(realPath)projectPathMap[project]=realPath}
function getPath(p){return projectPathMap[p]||p}
function shortPath(p){return getPath(p).replace(/^\\/Users\\/jung-wankim\\//,'~/')}
function projectName(p){
  const full=getPath(p);
  const parts=full.split('/').filter(Boolean);
  return parts[parts.length-1]||full;
}
function shortProject(p){return shortPath(p)}
function getGroup(p){
  const full=getPath(p);
  if(full.includes('/Project/Claude/'))return'Claude';
  if(full.includes('/Project/bs-hanyang/')||full.includes('/Project/bs/'))return'BS Hanyang';
  if(full.includes('/Project/hugh-soft/')||full.includes('/Project/hugh/'))return'Hugh Soft';
  if(full.includes('/Project/')){const m=full.match(/\\/Project\\/([^/]+)/);return m?m[1]:'Project'}
  if(full.includes('plugins')||full.includes('.claude'))return'Plugins';
  return'Other';
}
function fmtDate(ts){if(!ts)return'';const d=new Date(ts);return d.toLocaleDateString('ko-KR')+' '+d.toLocaleTimeString('ko-KR',{hour:'2-digit',minute:'2-digit'})}
function relativeDate(ts){if(!ts)return'';const d=Date.now()-new Date(ts).getTime();const m=Math.floor(d/60000);if(m<60)return m+'m ago';const h=Math.floor(m/60);if(h<24)return h+'h ago';const dy=Math.floor(h/24);if(dy<7)return dy+'d ago';return fmtDate(ts)}
function truncate(s,n=200){if(!s)return'';return s.length>n?s.substring(0,n)+'...':s}
async function api(p){return(await fetch(p)).json()}
function setContent(h){const el=document.getElementById('content');el.innerHTML=h;el.style.animation='none';el.offsetHeight;el.style.animation='fadeIn 0.3s ease'}
function getEl(id){return document.getElementById(id)}

async function loadStats(){
  const s=await api('/api/stats');
  getEl('stats').innerHTML=
    '<div class="stat"><div class="stat-value">'+s.total.toLocaleString()+'</div><div class="stat-label">exchanges</div></div>'+
    '<div class="stat"><div class="stat-value">'+s.projects+'</div><div class="stat-label">projects</div></div>'+
    '<div class="stat"><div class="stat-value">'+s.tools.toLocaleString()+'</div><div class="stat-label">tool calls</div></div>';
}

document.querySelector('.tabs').addEventListener('click',e=>{
  const tab=e.target.dataset?.tab;if(!tab)return;
  currentTab=tab;searchOffset=0;
  document.querySelectorAll('.tab').forEach(t=>t.classList.toggle('active',t.dataset.tab===tab));
  if(tab==='projects')showProjects();else if(tab==='search')showSearchUI();else if(tab==='prompts')showPromptsUI();
});

async function showProjects(){
  const projects=await api('/api/projects');
  projects.forEach(p=>registerPath(p.project,p.real_path));
  projects.sort((a,b)=>{
    if(projectSortBy==='count')return b.count-a.count;
    if(projectSortBy==='name')return shortProject(a.project).localeCompare(shortProject(b.project));
    return new Date(b.last_seen)-new Date(a.last_seen);
  });
  const groups={};
  projects.forEach(p=>{const g=getGroup(p.project);if(!groups[g])groups[g]=[];groups[g].push(p)});

  let html='<div class="sort-bar">'+
    '<button class="sort-btn'+(projectSortBy==='last_seen'?' active':'')+'" data-sort="last_seen">Latest</button>'+
    '<button class="sort-btn'+(projectSortBy==='count'?' active':'')+'" data-sort="count">Most</button>'+
    '<button class="sort-btn'+(projectSortBy==='name'?' active':'')+'" data-sort="name">A-Z</button></div>';

  for(const[group,items]of Object.entries(groups)){
    const total=items.reduce((s,p)=>s+p.count,0);
    html+='<div class="group"><div class="group-title">'+esc(group)+
      '<span class="group-count">'+items.length+' projects &middot; '+total.toLocaleString()+' exchanges</span></div>'+
      '<div class="project-grid">'+items.map(p=>
        '<div class="project-card" data-project="'+esc(p.project)+'">'+
        '<div class="project-name">'+esc(projectName(p.project))+'</div>'+
        '<div class="project-path">'+esc(shortPath(p.project))+'</div>'+
        (p.last_prompt?'<div class="project-prompt">'+esc(truncate(p.last_prompt,120))+'</div>':'')+
        '<div class="project-meta"><span class="project-stat">'+p.count.toLocaleString()+' exchanges</span>'+
        '<span class="project-date">'+relativeDate(p.last_seen)+'</span></div></div>'
      ).join('')+'</div></div>';
  }
  setContent(html);
  document.querySelectorAll('.sort-btn').forEach(b=>b.addEventListener('click',()=>{projectSortBy=b.dataset.sort;showProjects()}));
  document.querySelectorAll('.project-card').forEach(c=>c.addEventListener('click',()=>browseProject(c.dataset.project)));
}

async function browseProject(project){currentProject=project;await doSearch('',project,0)}

async function showSearchUI(){
  setContent('<div class="controls"><input type="search" class="search-input" id="searchInput" placeholder="Search all conversations...">'+
    '<div class="searchable-select" id="projectFilter"></div>'+
    '<button class="btn" id="searchBtn">Search</button></div><div id="results"></div>');
  await initSearchableSelect('projectFilter',doSearchFromUI);
  getEl('searchBtn').addEventListener('click',doSearchFromUI);
  getEl('searchInput').addEventListener('keydown',e=>{if(e.key==='Enter')doSearchFromUI()});
  getEl('searchInput').focus();
  doSearchFromUI();
}

async function showPromptsUI(){
  setContent('<div class="controls"><input type="search" class="search-input" id="promptInput" placeholder="Search user prompts...">'+
    '<div class="searchable-select" id="promptProject"></div>'+
    '<button class="btn" id="promptBtn">Search</button></div><div id="results"></div>');
  await initSearchableSelect('promptProject',doPromptSearchFromUI);
  getEl('promptBtn').addEventListener('click',doPromptSearchFromUI);
  getEl('promptInput').addEventListener('keydown',e=>{if(e.key==='Enter')doPromptSearchFromUI()});
  getEl('promptInput').focus();
  doPromptSearchFromUI();
}

const ssState={};
async function initSearchableSelect(containerId,onChange){
  const projects=await api('/api/projects');
  projects.forEach(p=>registerPath(p.project,p.real_path));
  const options=[{value:'',label:'All Projects',count:null},...projects.map(p=>({value:p.project,label:shortProject(p.project),count:p.count}))];
  ssState[containerId]={value:'',options};
  const container=getEl(containerId);
  container.innerHTML='<div class="ss-trigger" data-ss="'+containerId+'">All Projects</div>'+
    '<div class="ss-dropdown" id="ss-dd-'+containerId+'">'+
    '<input type="text" class="ss-search" placeholder="Search projects..." id="ss-search-'+containerId+'">'+
    '<div class="ss-list" id="ss-list-'+containerId+'"></div></div>';
  renderSSOptions(containerId);
  const trigger=container.querySelector('.ss-trigger');
  const dd=getEl('ss-dd-'+containerId);
  const searchInput=getEl('ss-search-'+containerId);
  trigger.addEventListener('click',e=>{
    e.stopPropagation();
    const isOpen=dd.classList.contains('open');
    closeAllSS();
    if(!isOpen){dd.classList.add('open');trigger.classList.add('open');searchInput.value='';renderSSOptions(containerId);searchInput.focus()}
  });
  searchInput.addEventListener('input',()=>renderSSOptions(containerId,searchInput.value));
  searchInput.addEventListener('click',e=>e.stopPropagation());
  searchInput.addEventListener('keydown',e=>{
    if(e.key==='Escape'){closeAllSS()}
    if(e.key==='Enter'){const first=getEl('ss-list-'+containerId).querySelector('.ss-option');if(first)first.click()}
  });
  container._getValue=()=>ssState[containerId].value;
  container._onChange=onChange;
}

function renderSSOptions(containerId,filter){
  const st=ssState[containerId];
  const list=getEl('ss-list-'+containerId);
  const filtered=filter?st.options.filter(o=>o.label.toLowerCase().includes(filter.toLowerCase())):st.options;
  if(filtered.length===0){list.innerHTML='<div class="ss-empty">No projects found</div>';return}
  list.innerHTML=filtered.map(o=>
    '<div class="ss-option'+(o.value===st.value?' selected':'')+'" data-value="'+esc(o.value)+'">'+
    '<span>'+esc(o.label)+'</span>'+(o.count!=null?'<span class="ss-count">'+o.count.toLocaleString()+'</span>':'')+'</div>'
  ).join('');
  list.querySelectorAll('.ss-option').forEach(opt=>{
    opt.addEventListener('click',e=>{
      e.stopPropagation();
      const val=opt.dataset.value;
      st.value=val;
      const container=getEl(containerId);
      container.querySelector('.ss-trigger').textContent=filtered.find(o=>o.value===val)?.label||'All Projects';
      closeAllSS();
      if(container._onChange)container._onChange();
    });
  });
}

function closeAllSS(){
  document.querySelectorAll('.ss-dropdown.open').forEach(d=>{d.classList.remove('open');d.parentElement.querySelector('.ss-trigger').classList.remove('open')});
}
document.addEventListener('click',closeAllSS);

function getSSValue(containerId){const c=getEl(containerId);return c&&c._getValue?c._getValue():''}

async function doSearchFromUI(){searchOffset=0;await doSearch(getEl('searchInput')?.value||'',getSSValue('projectFilter'),0)}

async function doSearch(q,project,offset){
  const data=await api('/api/search?'+new URLSearchParams({q,project,limit:50,offset}));
  renderResults(data,q,project);
}

let promptOffset=0;
async function doPromptSearchFromUI(){promptOffset=0;await doPromptSearch(getEl('promptInput')?.value||'',getSSValue('promptProject'),0)}

async function doPromptSearch(q,project,offset){
  const data=await api('/api/user-prompts?'+new URLSearchParams({q,project,limit:50,offset}));
  renderPromptResults(data,q,project);
}

function renderPromptResults(data,q,project){
  const el=getEl('results');
  const range=data.total>0?(data.offset+1)+'-'+Math.min(data.offset+data.limit,data.total):'0';
  const totalPages=Math.max(1,Math.ceil(data.total/50));
  const curPage=Math.floor(data.offset/50)+1;
  const items=data.results.map(r=>
    '<div class="exchange-item" data-id="'+esc(r.id)+'"><div class="exchange-msg">'+esc(truncate(r.user_message,300))+'</div>'+
    '<div class="exchange-meta"><span class="project-tag">'+esc(shortProject(r.project))+'</span><span>'+relativeDate(r.timestamp)+'</span></div></div>'
  ).join('');
  el.innerHTML='<div class="result-count">'+data.total.toLocaleString()+' prompts &middot; '+range+'</div>'+
    '<div class="exchange-list">'+items+'</div>'+
    '<div class="pagination">'+
    (data.offset>0?'<button class="btn btn-ghost prevBtn">Prev</button>':'')+
    '<span class="page-info">Page '+curPage+'/'+totalPages+'</span>'+
    (data.offset+data.limit<data.total?'<button class="btn btn-ghost nextBtn">Next</button>':'')+'</div>';
  promptOffset=data.offset;
  el.querySelectorAll('.exchange-item').forEach(c=>c.addEventListener('click',()=>showExchange(c.dataset.id)));
  el.querySelector('.prevBtn')?.addEventListener('click',()=>doPromptSearch(q,project,Math.max(0,promptOffset-50)));
  el.querySelector('.nextBtn')?.addEventListener('click',()=>doPromptSearch(q,project,promptOffset+50));
}

function renderResults(data,q,project){
  const el=getEl('results')||getEl('content');
  const header=project&&!q?'<button class="btn btn-ghost" id="backBtn" style="margin-bottom:16px">Back to Projects</button>'+
    '<h2 style="font-size:18px;font-weight:600;color:var(--text-bright);margin-bottom:16px">'+esc(shortProject(project))+'</h2>':'';
  el.innerHTML=header+
    '<div class="result-count">'+data.total.toLocaleString()+' results &middot; '+(data.offset+1)+'-'+Math.min(data.offset+data.limit,data.total)+'</div>'+
    '<div class="exchange-list">'+data.results.map(r=>
      '<div class="exchange-item" data-id="'+esc(r.id)+'"><div class="exchange-msg">'+esc(truncate(r.user_message,300))+'</div>'+
      '<div class="exchange-meta"><span class="project-tag">'+esc(shortProject(r.project))+'</span><span>'+relativeDate(r.timestamp)+'</span></div></div>'
    ).join('')+'</div>'+
    '<div class="pagination">'+
    (data.offset>0?'<button class="btn btn-ghost prevBtn">Prev</button>':'')+
    '<span class="page-info">Page '+(Math.floor(data.offset/50)+1)+'/'+Math.ceil(data.total/50)+'</span>'+
    (data.offset+data.limit<data.total?'<button class="btn btn-ghost nextBtn">Next</button>':'')+'</div>';
  searchOffset=data.offset;
  el.querySelectorAll('.exchange-item').forEach(c=>c.addEventListener('click',()=>showExchange(c.dataset.id)));
  el.querySelector('#backBtn')?.addEventListener('click',()=>showProjects());
  el.querySelector('.prevBtn')?.addEventListener('click',()=>doSearch(q,project,Math.max(0,searchOffset-50)));
  el.querySelector('.nextBtn')?.addEventListener('click',()=>doSearch(q,project,searchOffset+50));
}

async function showExchange(id){
  const data=await api('/api/exchange?id='+id);if(!data.exchange)return;
  const e=data.exchange;
  const el=getEl('results')||getEl('content');
  el.innerHTML=
    '<button class="btn btn-ghost" id="detailBack" style="margin-bottom:16px">Back</button>'+
    '<div class="detail-view">'+
    '<div class="detail-header"><span>'+esc(shortProject(e.project))+'</span><span>'+fmtDate(e.timestamp)+'</span>'+
    (e.git_branch?'<span>'+esc(e.git_branch)+'</span>':'')+'</div>'+
    '<div class="msg-block msg-user"><span class="msg-label">User</span>'+esc(e.user_message)+'</div>'+
    '<div class="msg-block msg-assistant"><span class="msg-label">Assistant</span>'+esc(truncate(e.assistant_message,4000))+'</div>'+
    (data.tools.length?'<div style="margin-top:16px"><span class="msg-label" style="color:var(--warn)">Tool Calls ('+data.tools.length+')</span>'+
      data.tools.map(t=>'<div class="msg-block msg-tool"><strong>'+esc(t.tool_name)+'</strong>'+(t.is_error?' [ERROR]':'')+
      '\\n'+esc(truncate(t.tool_input,300))+'</div>').join('')+'</div>':'')+
    '</div>';
  getEl('detailBack').addEventListener('click',()=>{if(currentProject)browseProject(currentProject);else{const t=currentTab;document.querySelector('[data-tab="'+t+'"]')?.click()}});
}

loadStats();showProjects();
</script>
</body>
</html>`;
}
