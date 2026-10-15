/**
 * Build smoke tests: the artifacts must be loadable in the shapes the host and
 * the browser module system expect.
 *
 * @module test/build.test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The suite may run from a transpiled scratch copy, so the project root is
// anchored to this file's own location rather than to the working directory.
const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);

/**
 * Remove comments from emitted JavaScript.
 *
 * The scan below looks for real `require` calls, and prose can contain the same
 * shape: this project's own doc comments say things like `require('fflate')` while
 * explaining why a dependency is *not* used. Without this, documentation would be
 * reported as a build error.
 * @param source - emitted JavaScript.
 * @returns the source with comments blanked out.
 */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

/** Every `require("...")` target in one artifact. */
function requiredSpecifiers(source: string): string[] {
  return [...new Set([...withoutComments(source).matchAll(/\brequire\(["']([^"']+)["']\)/g)].map((match) => match[1]))];
}

/**
 * Assert that an artifact only requires what its runtime can actually resolve.
 *
 * A bundle may reach the Node standard library and the packages the Host
 * already loads for it. Anything else is a build mistake: the plugin directory
 * is installed on its own, so the Host's packages are not on its resolution
 * path, and one stray `require` makes the whole plugin fail to import.
 * @param label - artifact name for the failure message.
 * @param source - the emitted JavaScript.
 * @param allowed - package names the runtime provides.
 */
function assertNoUndistributedRequires(label: string, source: string, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  for (const specifier of requiredSpecifiers(source)) {
    if (specifier.startsWith('node:')) continue;
    if (specifier.startsWith('.')) continue;
    assert.ok(
      allowedSet.has(specifier),
      `${label} requires "${specifier}", which the Host does not provide to a plugin`,
    );
  }
}

test('the host half loads and exposes the plugin face', async () => {
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const loaded = require(join(root, 'lib', 'index.js'));
  assert.equal(typeof loaded.apply, 'function');
  assert.equal(loaded.name, 'skill-center');
  assert.deepEqual(loaded.inject, ['skills', 'webServer', 'sessions']);
  assert.equal(loaded.apply.length, 1, 'apply must take the host context');
  assert.equal(manifest.main, 'lib/index.js');
});

test('the host artifact is marked CommonJS so the package type does not break it', async () => {
  const marker = JSON.parse(await readFile(join(root, 'lib', 'package.json'), 'utf8'));
  assert.equal(marker.type, 'commonjs');
});

test('the browser half registers the expected module id', async () => {
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const source = await readFile(join(root, 'lib', 'client.js'), 'utf8');
  assert.match(source, /window\.__ModuleLoader__\.load\(\{/);
  assert.ok(source.includes(JSON.stringify(manifest.name)), 'module id must equal the package name');
  assert.match(source, /factory: \(require\) => \{/);
  assert.match(source, /return module\.exports;/);
  assert.ok(manifest.dsh.client.inject.length > 0, 'dsh.client.inject must be declared');
  assert.ok(manifest.dsh.client.external.includes('react'), 'react must stay external');
});

test('every relative require in the client bundle resolves to a bundled module', async () => {
  const source = await readFile(join(root, 'lib', 'client.js'), 'utf8');

  // One table row per module: `"<key>": __modN,`. The whitespace class stays
  // line-local so a blank line cannot make one match swallow the next key.
  const table = new Set([...source.matchAll(/^[ \t]*"([^"]+)": __mod\d+,/gm)].map((match) => match[1]));
  assert.ok(table.size >= 2, `expected the internal table to hold the modules, saw ${table.size}`);
  assert.ok(table.has('index.ts'), 'the client entry must be in the table');

  // The bundle carries only what the entry reaches. The real page pulls in its
  // store and the shared contract; the minimal diagnostic variant reaches
  // neither, which is the point of that variant.
  const isMinimal = /VARIANT/.test(source) && /minimal/.test(source);
  if (!isMinimal) {
    assert.ok(table.has('store.ts'), 'the store must be bundled into the real page');
    assert.ok(table.has('../contract.ts'), 'the shared contract must be bundled into the real page');
  }

  const relativeRequires = [...source.matchAll(/require\("(\.[^"]+)"\)/g)].map((match) => match[1]);
  assert.ok(relativeRequires.length > 0, 'the bundle should reference its own modules');

  for (const specifier of new Set(relativeRequires)) {
    // Table keys are relative to src/client, so "./" is not part of a key.
    const bare = specifier.replace(/^\.\//, '');
    const stem = bare.replace(/\.(js|ts|tsx|mjs)$/, '');
    const resolvable = [bare, `${stem}.ts`, `${stem}.tsx`, stem].some((candidate) => table.has(candidate));
    assert.ok(resolvable, `relative require ${specifier} has no bundled module behind it`);
  }
});

test('published artifacts stay small enough to ship', async () => {
  const host = await stat(join(root, 'lib', 'index.js'));
  const client = await stat(join(root, 'lib', 'client.js'));
  assert.ok(host.size < 200_000, `host bundle is ${host.size} bytes`);
  assert.ok(client.size < 200_000, `client bundle is ${client.size} bytes`);
});

test('the host half requires nothing the host does not provide', async () => {
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const source = await readFile(join(root, 'lib', 'index.js'), 'utf8');

  // The plugin ships on its own, so the only packages its runtime may reach are
  // its own declared dependencies (empty today) plus its peers.
  const allowed = [...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.peerDependencies ?? {})];
  assertNoUndistributedRequires('lib/index.js', source, allowed);
});

test('the browser half only requires the libraries it declares to the shell', async () => {
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const source = await readFile(join(root, 'lib', 'client.js'), 'utf8');

  // The shell's import map is the pump; `dsh.client.external` is the manifest of
  // what this bundle is allowed to ask it for.
  assertNoUndistributedRequires('lib/client.js', source, manifest.dsh.client.external ?? []);
});

test('the browser half only references theme tokens the Host actually defines', async (t) => {
  const source = await readFile(join(root, 'lib', 'client.js'), 'utf8');

  // The minimal variant is a throwaway probe that only proves the module machinery
  // can load a bundle; it has no page and therefore no theme contract.
  if (source.includes('skill-center/minimal')) {
    t.skip('minimal diagnostic variant: no page styles to check');
    return;
  }

  // Invented token names resolve to nothing and silently fall back to whatever
  // default was written beside them — the page then ignores the theme entirely.
  // That is exactly how the cards once came out white in dark mode. Every token
  // below is one the shipped stylesheets define; `--dsh-scrollbar-*` come from the
  // theme package's own scrollbar stylesheet, the rest from the component CSS.
  const allowed = [
    '--dsw-alias-bg-base',
    '--dsw-alias-bg-layer-1',
    '--dsw-alias-bg-layer-2',
    '--dsw-alias-bg-layer-3',
    '--dsw-alias-label-primary',
    '--dsw-alias-label-secondary',
    '--dsw-alias-label-tertiary',
    '--dsw-alias-border-l4',
    '--dsw-alias-interactive-bg-hover',
    '--dsw-alias-state-error-primary',
    '--dsw-alias-state-success-primary',
    '--dsw-alias-link',
    '--dsw-alias-scrollbar-bg-l1',
    '--dsw-alias-scrollbar-hover-l1',
    '--dsw-radius-sm',
    '--dsw-radius-md',
    '--dsw-radius-lg',
    '--dsw-font-xs-13',
    '--ds-font-family-code',
    '--dsh-scrollbar-thumb',
    '--dsh-scrollbar-thumb-hover',
    '--dsh-scrollbar-width',
  ];

  const used = [...new Set([...source.matchAll(/var\((--[a-z0-9-]+)/g)].map((match) => match[1]))];
  assert.ok(used.length > 0, 'the page should read theme tokens');
  for (const token of used) {
    assert.ok(allowed.includes(token), `unknown theme token ${token}`);
  }

  // The specific invented family from the first attempt must never come back.
  for (const invented of ['--dsh-surface-', '--dsh-text-', '--dsh-border-', '--dsh-danger-', '--dsh-accent-']) {
    assert.ok(!source.includes(`var(${invented}`), `${invented}* does not exist in the Host theme`);
  }
});

test('no shipped or source file carries a byte-order mark', async () => {
  // A UTF-8 BOM makes the Host's strict JSON reader throw, and its only symptom is
  // `skipping profile bundle "<name>": SyntaxError` on stderr followed by the plugin
  // silently never appearing — the hardest failure mode this project has hit, and one
  // that a text editor or a Windows scripting one-liner introduces with no visible
  // difference in the file.
  //
  // This used to check three manifests, and a bulk edit through a shell one-liner then
  // put a BOM on eighteen source files without any of them being noticed. The check now
  // walks everything that ships or is read by tooling, because the invisible failure is
  // the same wherever it lands.
  const skipped = new Set(['node_modules', '.test-build', 'lib', '.git', 'docs']);
  const walk = (dir) => {
    const found = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (skipped.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) found.push(...walk(full));
      else if (/\.(json|md|mjs|mts|ts|tsx|yml|yaml)$/.test(entry.name)) found.push(full);
    }
    return found;
  };

  const offenders = [];
  for (const file of walk(root)) {
    const bytes = await readFile(file);
    if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
      offenders.push(file.slice(root.length));
    }
  }
  // Named individually: a bare deep-equal on the array says only that some file is
  // wrong, which is the least useful thing to know about an invisible defect.
  assert.equal(offenders.length, 0, `these files start with a UTF-8 BOM: ${offenders.join(', ')}`);

  // And the manifests must stay parseable as plain JSON.
  for (const relativePath of ['package.json', 'lib/package.json']) {
    const text = await readFile(join(root, ...relativePath.split('/')), 'utf8');
    assert.doesNotThrow(() => JSON.parse(text), `${relativePath} is not valid JSON`);
  }
});
