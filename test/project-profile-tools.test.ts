import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * The two project profiles an agent reads first — CLAUDE.md (Claude Code) and CODEX.md (Codex) — each list
 * the MCP tools in their overview. The lists are written by hand: CODEX.md still named 9 tools after
 * `tag_fact` and `list_tags` made it 11. Each list must be the server's registration list.
 */

const REPO = path.resolve(__dirname, '..');
const SERVER_SRC = fs.readFileSync(path.join(REPO, 'src/server-core.ts'), 'utf8');

/** Tool names in the ListTools answer (the registration list — read the way test/mcp-tool-names.test.ts reads it). */
function registeredTools(): string[] {
  const start = SERVER_SRC.indexOf('async function handleListTools(');
  const end = SERVER_SRC.indexOf('async function handleCallTool(');
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  // the two functions are what the server answers with
  expect(SERVER_SRC).toContain('server.setRequestHandler(ListToolsRequestSchema, handleListTools)');
  expect(SERVER_SRC).toContain('server.setRequestHandler(CallToolRequestSchema, (request) => handleCallTool(session, request))');
  return [...SERVER_SRC.slice(start, end).matchAll(/^\s{8}name: '([a-z_]+)',$/gm)].map((m) => m[1]);
}

/** The tool names of the overview line that says what the MCP server exposes: every `name` or `a, b, c` code span on it. */
function listedTools(file: string): string[] {
  const text = fs.readFileSync(path.join(REPO, file), 'utf8');
  const lines = text.split('\n').filter((l) => /MCP server/.test(l) && /\bexposing\b/.test(l));
  expect(lines, `${file}: one line says what the MCP server exposes`).toHaveLength(1);
  return [...lines[0].matchAll(/`([^`]+)`/g)].flatMap((m) => m[1].split(/,\s*/)).filter((name) => /^[a-z_]+$/.test(name));
}

describe('project profiles list the MCP tools the server registers', () => {
  const registered = registeredTools();

  it('reads the registration list', () => {
    expect(registered.length).toBeGreaterThanOrEqual(11);
    expect(registered).toEqual(expect.arrayContaining(['search', 'read', 'tag_fact', 'list_tags']));
  });

  for (const file of ['CLAUDE.md', 'CODEX.md']) {
    it(`${file} names every registered tool, and nothing the server does not register`, () => {
      expect(listedTools(file).sort()).toEqual([...registered].sort());
    });
  }
});
