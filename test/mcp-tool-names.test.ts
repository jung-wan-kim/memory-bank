import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// SQ-05 — the search agent's frontmatter and the skill docs named a tool the server does not register
// (`show`; the tool is `read`), so the agent's allow-list had no way to open a conversation. Every tool
// name a shipped document mentions must be one the server registers.

const REPO = path.resolve(__dirname, '..');
const SERVER_SRC = fs.readFileSync(path.join(REPO, 'src/mcp-server.ts'), 'utf8');

/** Tool names in the ListTools answer (the registration list). */
function registeredTools(): string[] {
  const start = SERVER_SRC.indexOf('server.setRequestHandler(ListToolsRequestSchema');
  const end = SERVER_SRC.indexOf('server.setRequestHandler(CallToolRequestSchema');
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return [...SERVER_SRC.slice(start, end).matchAll(/^\s{8}name: '([a-z_]+)',$/gm)].map((m) => m[1]);
}

/** Tool names the CallTool handler answers. */
function handledTools(): string[] {
  const start = SERVER_SRC.indexOf('server.setRequestHandler(CallToolRequestSchema');
  return [...SERVER_SRC.slice(start).matchAll(/if \(name === '([a-z_]+)'\)/g)].map((m) => m[1]);
}

function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(md|json|js|mjs|cjs|sh|txt)$/.test(e.name)) out.push(p);
  }
  return out;
}

/** Everything shipped to a user that can name a tool: agent/skill/command/prompt docs, hooks, scripts, READMEs. */
const DOCS = [
  ...['agents', 'skills', 'commands', 'prompts', 'hooks', 'scripts'].flatMap((d) => walk(path.join(REPO, d))),
  ...['README.md', 'README-KR.md', 'CLAUDE.md', 'CODEX.md', '.claude-plugin/plugin.json'].map((f) => path.join(REPO, f)),
].filter((f) => fs.existsSync(f));

describe('MCP tool names: server and documents agree', () => {
  const registered = registeredTools();

  it('the server registers the tools it handles, and handles the tools it registers', () => {
    expect(registered.length).toBeGreaterThanOrEqual(11);
    expect(new Set(registered).size).toBe(registered.length);
    expect([...handledTools()].sort()).toEqual([...registered].sort());
    expect(registered).toContain('search');
    expect(registered).toContain('read');
  });

  it('scans the shipped documents', () => {
    const rel = DOCS.map((f) => path.relative(REPO, f));
    expect(rel).toContain(path.join('agents', 'search-conversations.md'));
    expect(rel).toContain(path.join('skills', 'remembering-conversations', 'SKILL.md'));
    expect(rel).toContain(path.join('skills', 'remembering-conversations', 'MCP-TOOLS.md'));
    expect(rel).toContain(path.join('prompts', 'search-agent.md'));
  });

  it('every fully-qualified tool name in a document is a registered tool', () => {
    const unknown: string[] = [];
    let mentions = 0;
    for (const file of DOCS) {
      const text = fs.readFileSync(file, 'utf8');
      for (const m of text.matchAll(/mcp__[A-Za-z0-9_-]*memory-bank__([A-Za-z0-9_]+)/g)) {
        mentions++;
        if (!registered.includes(m[1])) unknown.push(`${path.relative(REPO, file)}: ${m[0]}`);
      }
    }
    expect(mentions).toBeGreaterThanOrEqual(5);
    expect(unknown).toEqual([]);
  });

  it('the search agent is allowed both tools its instructions tell it to use', () => {
    const agent = fs.readFileSync(path.join(REPO, 'agents/search-conversations.md'), 'utf8');
    const toolsLine = agent.split('\n').find((l) => l.startsWith('tools:'));
    expect(toolsLine).toBeDefined();
    const allowed = [...toolsLine!.matchAll(/mcp__[A-Za-z0-9_-]*memory-bank__([A-Za-z0-9_]+)/g)].map((m) => m[1]);
    expect(allowed.sort()).toEqual(['read', 'search']);
  });

  it('a tool named in backticks in the agent/skill/prompt docs is a registered tool', () => {
    // "the `x` tool", "using `x` to …", "## x" headings of the tools reference
    const unknown: string[] = [];
    let mentions = 0;
    const files = DOCS.filter((f) => /\/(agents|skills|prompts)\//.test(f) && f.endsWith('.md'));
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8');
      const names = [
        ...[...text.matchAll(/`([a-z_]+)` tool\b/g)].map((m) => m[1]),
        ...[...text.matchAll(/\busing `([a-z_]+)` to\b/g)].map((m) => m[1]),
      ];
      for (const name of names) {
        mentions++;
        if (!registered.includes(name)) unknown.push(`${path.relative(REPO, file)}: \`${name}\``);
      }
    }
    expect(mentions).toBeGreaterThanOrEqual(4);
    expect(unknown).toEqual([]);
  });

  it('the tools reference documents every registered tool under its own name', () => {
    const ref = fs.readFileSync(path.join(REPO, 'skills/remembering-conversations/MCP-TOOLS.md'), 'utf8');
    const headings = [...ref.matchAll(/^## ([a-z_]+)$/gm)].map((m) => m[1]);
    expect(headings.sort()).toEqual([...registered].sort());
  });
});
