import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * scripts/install-commands.sh (a SessionStart hook) copies the plugin's slash
 * commands into the user's own commands dir.
 *
 * A plugin command points at plugin files as `${CLAUDE_PLUGIN_ROOT}/…`. Claude
 * Code fills that in for the plugin's own commands only: a user-scope copy is
 * not a plugin component, and the variable is not in the environment of the
 * Bash tool — a copy that still says `${CLAUDE_PLUGIN_ROOT}` runs
 * `node "/ui/server.cjs"`. So the copy must carry the plugin root itself
 * (REL-5: a shipped command has to work wherever the plugin is installed).
 *
 * Every run uses a temp HOME; nothing of the real ~/.claude is read or written.
 */

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(REPO, 'scripts', 'install-commands.sh');
const VARIABLE = '${CLAUDE_PLUGIN_ROOT}';
// The shells the hook can meet: macOS still ships bash 3.2 as /bin/bash; `bash` on PATH may be 5.x.
const SHELLS = ['/bin/bash', 'bash'].filter((shell, index, all) => all.indexOf(shell) === index);

let tmp: string;
let home: string;

function install(shell: string, pluginRoot: string | null, script = SCRIPT) {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: home };
  if (pluginRoot !== null) env.CLAUDE_PLUGIN_ROOT = pluginRoot;
  const r = spawnSync(shell, [script], { env, encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function installed(name: string): string {
  return fs.readFileSync(path.join(home, '.claude', 'commands', name), 'utf8');
}

/** A plugin root with one command, in a directory whose name is hostile to shell text substitution. */
function fakePlugin(dirName: string, commandText: string): string {
  const root = path.join(tmp, dirName);
  fs.mkdirSync(path.join(root, 'commands'), { recursive: true });
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.copyFileSync(SCRIPT, path.join(root, 'scripts', 'install-commands.sh'));
  fs.writeFileSync(path.join(root, 'commands', 'demo.md'), commandText);
  return root;
}

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mb-install-commands-')));
  home = path.join(tmp, 'home');
  fs.mkdirSync(home);
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe.each(SHELLS)('scripts/install-commands.sh under %s', (shell) => {
  it('copies every shipped command, with the plugin root written in where the command names it', () => {
    const r = install(shell, REPO);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);

    const shipped = fs.readdirSync(path.join(REPO, 'commands')).filter((f) => f.endsWith('.md')).sort();
    expect(shipped.length).toBeGreaterThanOrEqual(3);
    expect(fs.readdirSync(path.join(home, '.claude', 'commands')).sort()).toEqual(shipped);

    for (const name of shipped) {
      const source = fs.readFileSync(path.join(REPO, 'commands', name), 'utf8');
      const copy = installed(name);
      expect(copy, name).not.toContain(VARIABLE);
      expect(copy, name).toBe(source.split(VARIABLE).join(REPO));
    }
    // The dashboard command of the copy starts a file that exists.
    const started = /node "([^"]+\/ui\/server\.cjs)"/.exec(installed('show-dashboard.md'));
    expect(started, 'the node command in the installed /show-dashboard').not.toBeNull();
    expect(fs.existsSync(started![1])).toBe(true);
  });

  it('writes the root literally, whatever characters its path has', () => {
    const text = `Run:\n\n    node "${VARIABLE}/ui/server.cjs" --root "${VARIABLE}"\n\nno variable on this line\n`;
    const root = fakePlugin('plug in & co \\1 $HOME', text);
    const r = install(shell, root);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(installed('demo.md')).toBe(text.split(VARIABLE).join(root));
  });

  it('finds the plugin root from its own location when the variable is not set', () => {
    const root = fakePlugin('standalone', `node "${VARIABLE}/ui/server.cjs"\n`);
    const r = install(shell, null, path.join(root, 'scripts', 'install-commands.sh'));
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(installed('demo.md')).toBe(`node "${root}/ui/server.cjs"\n`);
  });

  it('leaves an up-to-date copy alone, and rewrites it when the plugin root moves', () => {
    const text = `node "${VARIABLE}/ui/server.cjs"\n`;
    const first = fakePlugin('v1', text);
    expect(install(shell, first).status).toBe(0);
    const target = path.join(home, '.claude', 'commands', 'demo.md');
    const old = new Date('2020-01-01T00:00:00Z');
    fs.utimesSync(target, old, old);

    expect(install(shell, first).status).toBe(0);
    expect(fs.statSync(target).mtimeMs).toBe(old.getTime());

    // A plugin update: the same command under a new root.
    const second = fakePlugin('v2', text);
    expect(install(shell, second).status).toBe(0);
    expect(installed('demo.md')).toBe(`node "${second}/ui/server.cjs"\n`);
    // Nothing but the commands is left in the user's commands dir.
    expect(fs.readdirSync(path.join(home, '.claude', 'commands'))).toEqual(['demo.md']);
  });
});
