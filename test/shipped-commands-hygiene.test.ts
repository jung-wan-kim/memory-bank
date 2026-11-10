import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * REL-10: what ships to every user of the plugin must not be written for one
 * developer's machine — slash commands (the SessionStart hook copies them into
 * the user's own commands dir) and the dashboard script.
 */

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('shipped slash commands', () => {
  it('/show-dashboard starts the web UI from the plugin root and stops only that server', () => {
    const text = fs.readFileSync(path.join(REPO, 'commands', 'show-dashboard.md'), 'utf8');
    expect(text).toContain('node "${CLAUDE_PLUGIN_ROOT}/ui/server.cjs"');
    expect(text).not.toMatch(/\/Users\/[A-Za-z0-9._-]+\//);
    // `kill $(lsof -ti:3847)` kills whatever happens to hold the port.
    expect(text).not.toMatch(/kill \$\(lsof -ti:\d+\)/);
    expect(text).toContain('pkill -f "ui/server.cjs"');
  });
});

describe('web UI dashboard', () => {
  it('shortens a path under any home directory, not one particular user\'s', () => {
    const source = fs.readFileSync(path.join(REPO, 'ui', 'server.cjs'), 'utf8');
    const line = source.split('\n').find((l) => l.startsWith('function shortPath(p)'));
    expect(line, 'shortPath in the dashboard script').toBeDefined();
    // The dashboard script lives inside a template literal of server.cjs: one level of backslash escaping.
    const body = line!.replace(/\\\\/g, '\\');
    const shortPath = new Function('getPath', `${body}; return shortPath;`)((p: string) => p) as (p: string) => string;
    expect(shortPath('/Users/alice/work/app')).toBe('~/work/app');
    expect(shortPath('/home/bob/src/tool')).toBe('~/src/tool');
    expect(shortPath('/opt/shared/repo')).toBe('/opt/shared/repo');
    expect(source).not.toMatch(/jung-wankim/);
  });
});
