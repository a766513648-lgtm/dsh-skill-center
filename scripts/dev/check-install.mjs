/**
 * Confirm the installed plugin is byte-for-byte the local build.
 *
 * @module scripts/check-install
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';

// Anchored to this file rather than to a hard-coded absolute path, so the check
// works on any machine and from any working directory.
const project = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const profile = process.argv[2] ?? 'desktop';
const installed = join(homedir(), '.dsh', 'profiles', profile, 'node_modules', '@dsh-workship', 'skill-center');

const digest = (path) => createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 16);

/** Hash both sides of one relative path, reporting a missing side as such. */
function compare(relative) {
  const read = (base) => {
    try {
      return digest(join(base, ...relative.split('/')));
    } catch {
      return 'MISSING';
    }
  };
  const local = read(project);
  const shipped = read(installed);
  return { relative, local, shipped, same: local === shipped };
}

const results = ['package.json', 'cordis.patch.yml', 'lib/index.js', 'lib/client.js', 'lib/package.json'].map(compare);
for (const row of results) {
  console.log(`${row.same ? 'OK  ' : 'DIFF'} ${row.relative.padEnd(20)} local=${row.local} installed=${row.shipped}`);
}

const expected = new Set(['package.json', 'cordis.patch.yml', 'README.md', 'lib']);
const extra = readdirSync(installed).filter((name) => !expected.has(name));
console.log(`\nextra entries: ${extra.length === 0 ? '(none)' : extra.join(', ')}`);
console.log(`installed at: ${statSync(installed).mtime.toISOString()}`);
console.log(results.every((row) => row.same) ? '\nRESULT: matches the local build' : '\nRESULT: MISMATCH');
