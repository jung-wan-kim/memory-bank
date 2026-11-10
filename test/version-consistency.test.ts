import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * REL-11: one release version, written in three files that nothing compared.
 *
 *  - package.json `version` — what the plugin's own code reads: the MCP
 *    wrapper's live swap, the session-start drift check (its "this session"
 *    and "marketplace clone" versions), live-apply, the inject daemon socket
 *    name, the logs.
 *  - .claude-plugin/plugin.json `version` and .claude-plugin/marketplace.json
 *    `plugins[].version` — what Claude Code installs by (it names the cache
 *    dir after it).
 *
 * Bump only package.json and every session is told "update available — run
 * claude plugin update" for a version Claude Code has nothing to install;
 * bump only the two manifests and an update ships that the drift check never
 * mentions. The changelog entry of the version is checked with them: it is
 * what the release notes are cut from.
 */

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

interface Versions { package: unknown; plugin: unknown; marketplace: unknown[] }

function readVersions(root: string): Versions {
  const json = (rel: string) => JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));
  const marketplace = json('.claude-plugin/marketplace.json');
  return {
    package: json('package.json').version,
    plugin: json('.claude-plugin/plugin.json').version,
    marketplace: (marketplace.plugins as Array<{ name?: string; version?: unknown }>)
      .filter((plugin) => plugin.name === 'memory-bank')
      .map((plugin) => plugin.version),
  };
}

/** The places that disagree with package.json — empty when the three are one version. */
function mismatches(v: Versions): string[] {
  const out: string[] = [];
  if (typeof v.package !== 'string' || !/^\d+\.\d+\.\d+$/.test(v.package)) out.push(`package.json version is not X.Y.Z: ${JSON.stringify(v.package)}`);
  if (v.plugin !== v.package) out.push(`.claude-plugin/plugin.json: ${JSON.stringify(v.plugin)}`);
  if (v.marketplace.length !== 1) out.push(`.claude-plugin/marketplace.json lists the memory-bank plugin ${v.marketplace.length} times`);
  for (const version of v.marketplace) {
    if (version !== v.package) out.push(`.claude-plugin/marketplace.json: ${JSON.stringify(version)}`);
  }
  return out;
}

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function fixture(pkg: string, plugin: string, marketplace: string[]): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-version-'));
  made.push(tmp);
  fs.mkdirSync(path.join(tmp, '.claude-plugin'));
  fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ version: pkg }));
  fs.writeFileSync(path.join(tmp, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'memory-bank', version: plugin }));
  fs.writeFileSync(path.join(tmp, '.claude-plugin', 'marketplace.json'),
    JSON.stringify({ plugins: marketplace.map((version) => ({ name: 'memory-bank', version })) }));
  return tmp;
}

describe('release version', () => {
  it('is the same in package.json, plugin.json and marketplace.json', () => {
    const versions = readVersions(REPO);
    expect(mismatches(versions), JSON.stringify(versions)).toEqual([]);
  });

  it('has its entry in CHANGELOG.md', () => {
    const { package: version } = readVersions(REPO);
    const headings = fs.readFileSync(path.join(REPO, 'CHANGELOG.md'), 'utf8').split('\n').filter((line) => line.startsWith('## ['));
    expect(headings.some((line) => line.startsWith(`## [${version}]`)), `a "## [${version}]" heading`).toBe(true);
  });

  it('the comparison reports each file that was left behind in a bump', () => {
    expect(mismatches(readVersions(fixture('1.8.0', '1.8.0', ['1.8.0'])))).toEqual([]);
    expect(mismatches(readVersions(fixture('1.8.0', '1.7.9', ['1.8.0'])))).toEqual(['.claude-plugin/plugin.json: "1.7.9"']);
    expect(mismatches(readVersions(fixture('1.8.0', '1.8.0', ['1.7.9'])))).toEqual(['.claude-plugin/marketplace.json: "1.7.9"']);
    expect(mismatches(readVersions(fixture('1.7.9', '1.8.0', ['1.8.0'])))).toEqual([
      '.claude-plugin/plugin.json: "1.8.0"', '.claude-plugin/marketplace.json: "1.8.0"',
    ]);
    expect(mismatches(readVersions(fixture('1.8', '1.8', ['1.8'])))).toEqual(['package.json version is not X.Y.Z: "1.8"']);
    expect(mismatches(readVersions(fixture('1.8.0', '1.8.0', [])))).toEqual(['.claude-plugin/marketplace.json lists the memory-bank plugin 0 times']);
  });
});
