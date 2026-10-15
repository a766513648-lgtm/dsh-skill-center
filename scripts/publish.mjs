/**
 * Publish the package to npm, having first proved the tarball is installable.
 *
 * The published artifact has one requirement that the repository does not: it must
 * contain the built `lib/`, because a package installed from the registry is not
 * built on the consumer's machine. The `prepack` script builds it, and this script
 * then unpacks the tarball and checks it, so a publish cannot ship a package whose
 * entry points are missing.
 *
 * The token is read from `NPM_TOKEN`, never from an argument or a file: it would end
 * up in a shell history or a committed `.npmrc`.
 *
 * Usage:
 *   $env:NPM_TOKEN = 'npm_...'; node scripts/publish.mjs --dry-run
 *   $env:NPM_TOKEN = 'npm_...'; node scripts/publish.mjs
 *
 * @module scripts/publish
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dryRun = process.argv.includes('--dry-run');
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

/** Run one command in the project directory, inheriting this process's output. */
function run(command, args, extraEnv = {}) {
  return execFileSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, ...extraEnv },
  });
}

/** Capture one command's stdout, for the checks below. */
function capture(command, args) {
  return execFileSync(command, args, { cwd: root, encoding: 'utf8', shell: process.platform === 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
}

if (manifest.private === true) {
  console.error('package.json still says private: true, which npm refuses to publish.');
  process.exit(2);
}
if (manifest.version === undefined) {
  console.error('package.json has no version.');
  process.exit(2);
}

// Always publish something that was actually tested.
console.log('--- verify ---');
run('npm', ['run', 'verify']);

console.log('--- build and pack ---');
rmSync(join(root, 'lib'), { recursive: true, force: true });
// The filename is derived rather than read back: `npm pack --json` prints the
// `prepack` build's output ahead of its own JSON, which makes the output unparseable.
const unscoped = manifest.name.replace(/^@/, '').replace('/', '-');
const tarball = `${unscoped}-${manifest.version}.tgz`;
run('npm', ['pack']);
if (!existsSync(join(root, tarball))) {
  console.error(`npm pack did not produce ${tarball}`);
  process.exit(2);
}
console.log(`tarball: ${tarball}`);

// The repository gitignores `lib/`, so a package that lost it would still pack
// successfully and then fail on every consumer's machine. This is the check that
// makes the difference visible here instead of there.
console.log('--- inspect the tarball ---');
const listing = capture('tar', ['-tzf', join(root, tarball)]);
const files = listing.split('\n').map((line) => line.trim()).filter((line) => line !== '');
const required = [
  'package/lib/index.js',
  'package/lib/client.js',
  'package/lib/package.json',
  'package/package.json',
  'package/cordis.patch.yml',
];
const missing = required.filter((needed) => !files.includes(needed));
if (missing.length > 0) {
  console.error(`the tarball is missing: ${missing.join(', ')}`);
  console.error(`it contains: ${files.join(', ')}`);
  process.exit(2);
}
console.log(`tarball holds ${String(files.length)} entries, including both entry points`);

// A stray development dependency in the runtime half would fail on install, and the
// build tests already guard that — repeating the check on the packed bytes is cheap.
//
// Comments are stripped first: this project's own documentation mentions
// `require('fflate')` while explaining why that dependency is deliberately *not*
// used, and a scan that reads prose would report documentation as a defect.
const hostBundle = execFileSync('tar', ['-xzOf', join(root, tarball), 'package/lib/index.js'], { encoding: 'utf8' })
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
for (const match of hostBundle.matchAll(/\brequire\(["']([^"']+)["']\)/g)) {
  const specifier = match[1];
  if (typeof specifier !== 'string') continue;
  if (specifier.startsWith('node:') || specifier.startsWith('.')) continue;
  console.error(`the packed host half requires "${specifier}", which npm would not install for a plugin.`);
  process.exit(2);
}
console.log('the packed host half requires only Node builtins');

if (dryRun) {
  console.log('--- dry run ---');
  run('npm', ['publish', tarball, '--dry-run', '--access', 'public', '--registry', 'https://registry.npmjs.org/']);
  console.log('dry run finished; nothing was published');
  process.exit(0);
}

const token = process.env.NPM_TOKEN;
if (typeof token !== 'string' || token === '') {
  console.error('Set NPM_TOKEN first. The token is read from the environment so it cannot land in a file.');
  process.exit(2);
}

console.log('--- publish ---');
mkdirSync(join(root, '.npm-publish'), { recursive: true });
// A throwaway npm config, so the token is used for this command only and never
// written into the project or the user's own `.npmrc`.
const npmrc = join(root, '.npm-publish', 'npmrc');
execFileSync('node', ['-e', `require('node:fs').writeFileSync(${JSON.stringify(npmrc)}, '//registry.npmjs.org/:_authToken=' + process.env.NPM_TOKEN + '\\n')`], {
  cwd: root,
  stdio: 'inherit',
});
try {
  run('npm', ['publish', tarball, '--access', 'public', '--registry', 'https://registry.npmjs.org/', '--userconfig', npmrc]);
} finally {
  rmSync(join(root, '.npm-publish'), { recursive: true, force: true });
  rmSync(join(root, tarball), { force: true });
}
console.log(`published @suifengshiqu/skill-center@${manifest.version}`);
if (!existsSync(join(root, 'lib'))) console.log('note: lib/ was removed; run npm run build before using it locally');
