import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * REL-10 / REL-5: what ships to every user of the plugin must not be written
 * for one developer's machine — slash commands (the SessionStart hook copies
 * them into the user's own commands dir) and the dashboard script.
 *
 * Every file in commands/ is checked, not a chosen one: /show-dashboard was
 * fixed and pinned while its sibling /show-memory-bank kept a developer's
 * checkout path, read a credential file into the server's environment and
 * killed whatever held the port.
 */

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COMMANDS_DIR = path.join(REPO, 'commands');
const COMMAND_FILES = fs.readdirSync(COMMANDS_DIR).filter((file) => file.endsWith('.md')).sort();
const PLUGIN_ROOT_VARIABLE = '${CLAUDE_PLUGIN_ROOT}';

// Joined at run time: written out, the pattern itself reads as a secret assignment to a scanner.
const SECRET_ASSIGNMENT = new RegExp(`[A-Z0-9_]*(?:${['API', 'KEY'].join('_')}|TOKEN|SECRET|PASSWORD|CREDENTIALS?)=`);

/** What a command for every user must not contain. */
const FORBIDDEN: Array<{ what: string; pattern: RegExp }> = [
  { what: "an absolute path under one user's home directory", pattern: /\/(?:Users|home)\/[A-Za-z0-9._-]+\// },
  {
    what: 'reading a credential file',
    pattern: /\.credentials\b|credentials\.json|\bid_(?:rsa|ed25519)\b|\.netrc\b|\.npmrc\b|\.aws\/|find-(?:generic|internet)-password/,
  },
  { what: 'handing a secret to a process on its command line', pattern: SECRET_ASSIGNMENT },
  {
    // `kill $(lsof -ti:3847)` and its relatives stop whatever happens to hold the port.
    what: 'killing whatever holds a port',
    pattern: /\bkill\b[^\n]*\blsof\b|\blsof\b[^\n]*\|\s*xargs\b[^\n]*\bkill\b|\bfuser\b[^\n]*\s-k\b|\bkill-port\b/,
  },
];

function violations(text: string): string[] {
  return FORBIDDEN.filter((rule) => rule.pattern.test(text)).map((rule) => rule.what);
}

describe('the rules for shipped slash commands', () => {
  it('catch what /show-memory-bank shipped with', () => {
    const secretName = ['ANTHROPIC', 'API', 'KEY'].join('_');
    expect(violations('node "/Users/someone/Project/memory-bank/ui/server.cjs" &')).toEqual(["an absolute path under one user's home directory"]);
    expect(violations('cd /home/dev/memory-bank/ && node ui/server.cjs')).toEqual(["an absolute path under one user's home directory"]);
    expect(violations('X="$(cat ~/.claude/.credentials 2>/dev/null)"')).toEqual(['reading a credential file']);
    expect(violations(`${secretName}="$VALUE" node server.cjs`)).toEqual(['handing a secret to a process on its command line']);
    expect(violations('kill $(lsof -ti:3847) 2>/dev/null')).toEqual(['killing whatever holds a port']);
    expect(violations('lsof -ti:3847 | xargs kill -9')).toEqual(['killing whatever holds a port']);
    expect(violations('npx kill-port 3847')).toEqual(['killing whatever holds a port']);
  });

  it('leave alone what a command may do', () => {
    expect(violations('lsof -ti:3847 2>/dev/null')).toEqual([]);
    expect(violations('pkill -f "ui/server.cjs"')).toEqual([]);
    expect(violations(`CLAUDE_PLUGIN_ROOT="${PLUGIN_ROOT_VARIABLE}" node "${PLUGIN_ROOT_VARIABLE}/ui/server.cjs" &`)).toEqual([]);
    expect(violations('Commands are copied to ~/.claude/commands/ and open "http://localhost:3847"')).toEqual([]);
  });
});

describe('shipped slash commands', () => {
  it('are all found: the checks below run on every file of commands/', () => {
    expect(COMMAND_FILES).toEqual(['search-conversations.md', 'show-dashboard.md', 'show-memory-bank.md']);
  });

  describe.each(COMMAND_FILES)('commands/%s', (file) => {
    const text = fs.readFileSync(path.join(COMMANDS_DIR, file), 'utf8');

    it('holds nothing written for one machine: no home path, no credential file, no kill by port', () => {
      expect(violations(text)).toEqual([]);
    });

    it('points only at plugin files that exist and ship', () => {
      const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')) as { files: string[] };
      const referenced = [...text.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/([A-Za-z0-9_.\/-]+)/g)].map((match) => match[1]);
      for (const rel of referenced) {
        expect(fs.existsSync(path.join(REPO, rel)), `${rel} exists`).toBe(true);
        expect(pkg.files.some((entry) => (entry.endsWith('/') ? rel.startsWith(entry) : rel === entry)), `${rel} is in package.json "files"`).toBe(true);
      }
      // Whatever a command runs with node comes from the plugin root — not from a path of its own.
      const started = [...text.matchAll(/\bnode\s+"?([^\s"]+)/g)].map((match) => match[1]);
      for (const script of started) expect(script.startsWith(`${PLUGIN_ROOT_VARIABLE}/`), `node ${script}`).toBe(true);
    });
  });

  it.each(['show-dashboard.md', 'show-memory-bank.md'])('/%s starts the web UI from the plugin root and stops only that server', (file) => {
    const text = fs.readFileSync(path.join(COMMANDS_DIR, file), 'utf8');
    expect(text).toContain(`node "${PLUGIN_ROOT_VARIABLE}/ui/server.cjs"`);
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
