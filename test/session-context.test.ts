import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { sessionContext, sessionProject, validSessionCwd, validSessionLocale } from '../src/session-context.js';

// TC-SCOPE-002 — the project a tool falls back to comes from the session the call belongs to, through one
// helper. A missing value must never reach a scope filter: several of them read an empty project as "every
// project" (project-family.ts, fact-db.ts, avatar-responder.ts).

const REPO = path.resolve(__dirname, '..');

describe('validSessionCwd', () => {
  it('accepts an absolute path', () => {
    expect(validSessionCwd('/Users/a/project')).toBe(true);
    expect(validSessionCwd('/')).toBe(true);
    expect(validSessionCwd('/with space/한글')).toBe(true);
  });

  it('refuses everything else', () => {
    for (const bad of [undefined, null, '', ' ', '.', './x', 'relative/path', '~/x', 42, {}, [], true, '/a\0b', `/${'x'.repeat(5000)}`]) {
      expect(validSessionCwd(bad), JSON.stringify(bad)).toBe(false);
    }
  });
});

describe('sessionContext', () => {
  it('holds an absolute path, or null for a session that could not read its own', () => {
    expect(sessionContext('/Users/a/project').cwd).toBe('/Users/a/project');
    expect(sessionContext(null).cwd).toBeNull();
  });

  it('throws on a value that is neither', () => {
    for (const bad of [undefined, '', 'relative', 7]) {
      expect(() => sessionContext(bad), JSON.stringify(bad)).toThrow(/working directory/);
    }
  });
});

describe("what else a session declares as its own: the LLM child's settings and the locale", () => {
  it('a session served by a shared server carries both; one in its own process carries neither', () => {
    const served = sessionContext('/Users/a/project', { childEnv: { ANTHROPIC_BASE_URL: 'https://x.invalid' }, locale: 'ko-KR' });
    expect(served).toEqual({ cwd: '/Users/a/project', childEnv: { ANTHROPIC_BASE_URL: 'https://x.invalid' }, locale: 'ko-KR' });
    expect(sessionContext('/Users/a/project')).toEqual({ cwd: '/Users/a/project' });
    expect(sessionContext('/Users/a/project', { childEnv: null })).toEqual({ cwd: '/Users/a/project' });
  });

  it('an empty declaration is still a declaration: the child must not fall back to inheriting the server', () => {
    expect(sessionContext('/x', { childEnv: {} })).toEqual({ cwd: '/x', childEnv: {} });
  });

  it('a locale is a language tag this runtime accepts, or it is refused — never repaired', () => {
    for (const ok of ['en-US', 'ko-KR', 'de', 'zh-Hant-TW', 'en-u-hc-h23']) expect(validSessionLocale(ok), ok).toBe(true);
    for (const bad of [undefined, null, '', 'C', 'POSIX', 'ko_KR', 'en_US.UTF-8', 'not a tag', 7, {}, 'x'.repeat(65)]) {
      expect(validSessionLocale(bad), JSON.stringify(bad)).toBe(false);
    }
    expect(() => sessionContext('/x', { locale: 'ko_KR.UTF-8' })).toThrow(/locale/);
  });
});

describe('sessionProject', () => {
  const ctx = sessionContext('/Users/a/project');

  it('an explicit project wins', () => {
    expect(sessionProject(ctx, '/Users/a/other')).toBe('/Users/a/other');
  });

  it('nothing given: the session working directory, character for character', () => {
    expect(sessionProject(ctx, undefined)).toBe('/Users/a/project');
    expect(sessionProject(ctx, '')).toBe('/Users/a/project');
    expect(sessionProject(ctx, null)).toBe('/Users/a/project');
  });

  it('no working directory and nothing given: an error that names the argument — never an empty project', () => {
    const blind = sessionContext(null);
    expect(() => sessionProject(blind, undefined)).toThrow(/`project`/);
    expect(() => sessionProject(blind, '')).toThrow(/`project`/);
    expect(() => sessionProject(blind, undefined, 'current_project')).toThrow(/`current_project`/);
    expect(sessionProject(blind, '/Users/a/other')).toBe('/Users/a/other');
  });
});

describe('the tools take their default project from the session (src/server-core.ts)', () => {
  const src = fs.readFileSync(path.join(REPO, 'src/server-core.ts'), 'utf8');

  it('the five defaults go through sessionProject, in the tools that have one', () => {
    const start = src.indexOf('async function handleCallTool(');
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start);
    const byTool = new Map<string, number>();
    const tools = [...body.matchAll(/if \(name === '([a-z_]+)'\)/g)];
    tools.forEach((m, i) => {
      const section = body.slice(m.index!, i + 1 < tools.length ? tools[i + 1].index! : body.length);
      byTool.set(m[1], (section.match(/sessionProject\(ctx, /g) ?? []).length);
    });
    const withDefault = [...byTool].filter(([, n]) => n > 0).map(([name]) => name).sort();
    expect(withDefault).toEqual(['ask_avatar', 'cross_project_insights', 'list_tags', 'search_facts', 'trace_fact']);
    expect([...byTool.values()].reduce((a, b) => a + b, 0)).toBe(5);
  });

  it('nothing in it reads the working directory of the process it runs in', () => {
    expect(src).not.toMatch(/process\.cwd\(/);
    expect(src).not.toMatch(/process\.chdir\(/);
  });

  it('a server is made for one session', () => {
    expect(src).toMatch(/export function createMemoryBankServer\(ctx: SessionContext\): Server/);
  });
});
