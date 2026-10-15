/**
 * Build Skill Center's two runtime halves without any external bundler.
 *
 * The Windows sandbox this project is developed in refuses `spawn` with piped
 * stdio, which is exactly how esbuild's JavaScript API starts its native
 * service — so the build uses the TypeScript compiler that is already a
 * devDependency and runs entirely in-process:
 *
 * 1. Every module is transpiled to CommonJS.
 * 2. The host half is emitted as one CommonJS file that Node loads through its
 *    CJS→ESM interop, exposing the named exports the Loader asks for.
 * 3. The browser half is emitted as one lazy factory in the Web client's module
 *    system format (`window.__ModuleLoader__.load({ id, factory })`), with an
 *    internal module table so sibling modules resolve without a bundler and
 *    Host-shared libraries resolve through the shell's import map.
 *
 * @module scripts/build
 */

import ts from 'typescript';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outdir = join(root, 'lib');
const srcDir = join(root, 'src');

const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const packageName = manifest.name;

/** Extensions the bundler understands, in resolution order. */
const RESOLVE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.js', '.mjs', '.json'];

/** Shared transpile settings; modules only, resolution is this script's job. */
const transpileOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.CommonJS,
  esModuleInterop: true,
  jsx: ts.JsxEmit.ReactJSX,
  sourceMap: false,
  inlineSourceMap: false,
  newLine: ts.NewLineKind.LineFeed,
};

/**
 * Rewrite an import/export specifier so the emitted `require` names the right file.
 * @param specifier - the specifier as written in source.
 * @param importer - absolute path of the importing module.
 * @returns the specifier the emitted require should use.
 */
function rewriteSpecifier(specifier, importer) {
  if (!specifier.startsWith('.')) return specifier;
  const resolved = resolveSpecifier(specifier, importer);
  if (resolved === undefined) return specifier;
  const relativePath = relative(dirname(importer), resolved).split('\\').join('/');
  return relativePath.startsWith('.') ? relativePath : `./${relativePath}`;
}

/**
 * Resolve one relative specifier to a real file.
 * @param specifier - the specifier as written in source.
 * @param importer - absolute path of the importing module.
 * @returns the absolute file path, or undefined when nothing matches.
 */
function resolveSpecifier(specifier, importer) {
  const base = resolve(dirname(importer), specifier);
  const candidates = [base, ...RESOLVE_EXTENSIONS.map((extension) => `${base}${extension}`)];
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return undefined;
}

/**
 * Transpile one module to CommonJS, rewriting relative specifiers.
 * @param absolute - absolute source path.
 * @returns the emitted JavaScript.
 */
function transpile(absolute) {
  const source = ts.sys.readFile(absolute);
  if (source === undefined) throw new Error(`cannot read ${absolute}`);
  const output = ts.transpileModule(source, {
    compilerOptions: transpileOptions,
    fileName: absolute,
    reportDiagnostics: true,
  });
  const errors = (output.diagnostics ?? []).filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
  if (errors.length > 0) {
    const detail = errors.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')).join('; ');
    throw new Error(`${relative(root, absolute)}: ${detail}`);
  }

  let code = output.outputText;
  // Rewrite only the specifiers that name a sibling module, so packages keep
  // resolving through the Host's runtime.
  code = code.replace(/require\((["'])([^"']+)\1\)/g, (match, quote, specifier) => {
    const next = rewriteSpecifier(specifier, absolute);
    return next === specifier ? match : `require(${quote}${next}${quote})`;
  });
  return code;
}

/** Collect every source module under a directory. */
async function collect(dir) {
  const { readdir } = await import('node:fs/promises');
  const found = [];
  for (const item of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, item.name);
    if (item.isDirectory()) found.push(...(await collect(full)));
    else if (/\.(ts|tsx)$/.test(item.name)) found.push(full);
  }
  return found.sort();
}

/** Wrap one module's code in a named inner function the table can call. */
function wrap(name, code) {
  return `function ${name}(exports, require, module, __filename, __dirname) {\n${code}\n}`;
}

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

// ── Host half ────────────────────────────────────────────────────────────────
const hostEntry = join(srcDir, 'index.ts');
const hostNames = new Map([[hostEntry, '__host_main']]);
for (const file of await collect(srcDir)) {
  if (file.startsWith(join(srcDir, 'client'))) continue;
  if (!hostNames.has(file)) hostNames.set(file, `__host_${hostNames.size}`);
}

// The host entry's public names, read from the source so the emitted host
// bundle can publish them statically (see the interop note further down).
const hostEntrySource = ts.sys.readFile(hostEntry) ?? '';
const hostExportNames = [
  ...new Set(
    [...hostEntrySource.matchAll(/^export\s+(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm)].map((match) => match[1]),
  ),
];

const hostParts = [  `/* ${packageName} — host half. Generated by scripts/build.mjs; edit src/ instead. */`,
  '"use strict";',
  'Object.defineProperty(exports, "__esModule", { value: true });',
];
for (const [file, name] of hostNames) {
  hostParts.push(wrap(name, transpile(file)));
}
hostParts.push('const __host_table = {');
for (const [file, name] of hostNames) {
  hostParts.push(`  ${JSON.stringify(relative(root, file).split('\\').join('/'))}: ${name},`);
}
hostParts.push('};');
hostParts.push(`const __host_entry = ${hostNames.get(hostEntry)};`);
// Every module is also reachable by its specifier with a `.js` extension, which
// is what the TypeScript sources write (`./core/scan.js` for `core/scan.ts`).
hostParts.push('const __host_aliases = {};');
hostParts.push('for (const key of Object.keys(__host_table)) {');
hostParts.push('  __host_aliases[key] = key;');
hostParts.push('  if (key.endsWith(".ts")) __host_aliases[`${key.slice(0, -3)}.js`] = key;');
hostParts.push('  if (key.endsWith(".tsx")) __host_aliases[`${key.slice(0, -4)}.js`] = key;');
hostParts.push('}');
hostParts.push(
  'function __host_resolve(specifier, from) {',
  '  const path = require("node:path");',
  // `from` is already a table key (`src/core/scan.ts`), so it is joined as a
  // relative module id rather than resolved as an absolute path.
  '  const base = path.posix.join(path.posix.dirname(from), specifier);',
  '  for (const candidate of [base, ...["", ".ts", ".tsx", ".js", ".mjs", ".json"].map((extension) => base + extension)]) {',
  '    if (__host_aliases[candidate] !== undefined) return __host_aliases[candidate];',
  '  }',
  '  return undefined;',
  '}',
  'function __host_require(specifier, from) {',
  '  if (specifier.startsWith(".")) {',
  '    const key = __host_resolve(specifier, from);',
  '    if (key === undefined) throw new Error(`unresolved module ${specifier} from ${from}`);',
  '    return __host_materialize(key);',
  '  }',
  '  return require(specifier);',
  '}',
  'const __host_cache = new Map();',
  'function __host_call(key) {',
  '  const cached = __host_cache.get(key);',
  '  if (cached !== undefined) return cached;',
  '  const record = { exports: {} };',
  '  __host_cache.set(key, record);',
  '  const path = require("node:path");',
  '  __host_table[key](record.exports, (specifier) => __host_require(specifier, key), { exports: record.exports }, key, path.posix.dirname(key));',
  '  return record;',
  '}',
  'function __host_materialize(key) {',
  '  return __host_call(key).exports;',
  '}',
  '',
  '// The host half is a CommonJS module: the module table needs lazy',
  '// per-module execution, and the Loader reads the named exports through',
  '// Node\'s CJS interop. Node only sees statically written `exports.x =`',
  '// assignments (a loop is invisible to it), so each name is written literally',
  '// below, and lib/package.json marks this folder as CommonJS so the package\'s',
  '// own `"type": "module"` does not make Node parse the file as ESM.',
  '',
  '// The entry is materialised into the factory\'s own exports object. Calling it',
  '// through the cache would give it a private record instead, and the Loader',
  '// would receive an empty module.',
  '__host_cache.set("src/index.ts", { exports });',
  '__host_entry(exports, (specifier) => __host_require(specifier, "src/index.ts"), { exports }, "src/index.ts", "src");',
  '',
);
await writeFile(join(outdir, 'index.js'), hostParts.join('\n\n'), 'utf8');
await writeFile(join(outdir, 'package.json'), `${JSON.stringify({ type: 'commonjs' }, null, 2)}\n`, 'utf8');

// ── Browser half ─────────────────────────────────────────────────────────────
const clientEntry = join(srcDir, 'client', 'index.ts');

/**
 * Collect the modules reachable from one entry by following relative imports.
 *
 * Walking the graph rather than globbing the directory keeps a file that no
 * entry imports out of the bundle — which is how a diagnostic variant stays
 * small instead of silently shipping the real page alongside it.
 * @param entry - absolute entry module.
 * @returns the reachable source files, including the entry.
 */
function reachable(entry) {
  const found = new Set();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop();
    if (found.has(file)) continue;
    found.add(file);
    const source = ts.sys.readFile(file);
    if (source === undefined) continue;
    for (const match of source.matchAll(/(?:\bfrom\s+|\bimport\s*\(|\bimport\s+)(["'])([^"']+)\1/g)) {
      const specifier = match[2];
      if (!specifier.startsWith('.')) continue;
      const resolved = resolveSpecifier(specifier, file);
      if (resolved !== undefined && !found.has(resolved)) queue.push(resolved);
    }
  }
  return [...found];
}

const clientFiles = reachable(clientEntry);
const clientNames = new Map();
let counter = 0;
for (const file of [...clientFiles].sort()) {
  clientNames.set(file, `__mod${counter}`);
  counter += 1;
}

const banner = [
  `/* ${packageName} — browser half. Generated by scripts/build.mjs; edit src/ instead. */`,
  'window.__ModuleLoader__.load({',
  `\tid: ${JSON.stringify(packageName)},`,
  '\tfactory: (require) => {',
  '\t\tvar module = { exports: {} };',
  '\t\tvar exports = module.exports;',
  '\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });',
  '',
].join('\n');

const body = [];
for (const [file, name] of clientNames) {
  body.push(wrap(name, transpile(file)));
}
body.push('const __table = {');
for (const [file, name] of clientNames) {
  const key = relative(join(srcDir, 'client'), file).split('\\').join('/');
  body.push(`  ${JSON.stringify(key.startsWith('.') ? key : key)}: ${name},`);
}
body.push('};');
body.push(
  'const __cache = new Map();',
  'function __resolve(specifier) {',
  '  // Table keys are written relative to src/client, so a "./" prefix from the',
  '  // emitted require has to be dropped before a key can match.',
  '  const bare = specifier.replace(/^\\.\\//, "");',
  '  const candidates = [specifier, bare];',
  '  for (const value of [specifier, bare]) {',
  '    for (const suffix of [".js", ".ts", ".tsx", ".mjs"]) {',
  '      if (value.endsWith(suffix)) {',
  '        const stem = value.slice(0, -suffix.length);',
  '        candidates.push(`${stem}.ts`, `${stem}.tsx`, stem);',
  '      }',
  '    }',
  '  }',
  '  for (const candidate of candidates) {',
  '    if (__table[candidate] !== undefined) return candidate;',
  '  }',
  '  return undefined;',
  '}',
  'function __require(specifier) {',
  '  const key = __resolve(specifier);',
  '  if (key === undefined) {',
  '    if (specifier.startsWith(".")) throw new Error(`skill-center: unresolved internal module ${specifier}`);',
  '    return require(specifier);',
  '  }',
  '  const cached = __cache.get(key);',
  '  if (cached !== undefined) return cached.exports;',
  '  const inner = { exports: {} };',
  '  __cache.set(key, inner);',
  `  __table[key](inner.exports, __require, inner, key, "");`,
  '  return inner.exports;',
  '}',
  '',
  '// The entry writes into the factory\'s own exports object. Materialising it',
  '// through the cache would hand it a private record and the Loader would get an',
  '// empty module, so the cache is seeded and the entry is called directly.',
  '__cache.set("index.ts", module);',
  '__table["index.ts"](module.exports, __require, module, "index.ts", "");',
);

const footer = ['', 'return module.exports;', '\t}', '});', ''].join('\n');
await writeFile(join(outdir, 'client.js'), `${banner}\n${body.join('\n\n')}\n${footer}`, 'utf8');

const hostBytes = statSync(join(outdir, 'index.js')).size;
const clientBytes = statSync(join(outdir, 'client.js')).size;
console.log(`built ${packageName}: lib/index.js ${hostBytes} B, lib/client.js ${clientBytes} B`);
