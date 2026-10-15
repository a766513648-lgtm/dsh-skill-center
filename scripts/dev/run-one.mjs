/**
 * Run one probe script through the same transpiling the suite uses.
 *
 * `node --test <file>` and a bare `node <file>.mts` both fail here — the first
 * spawns a child it is not allowed to spawn, the second does not strip types — so
 * probes go through the transpiler into the scratch tree and run from there.
 *
 * Usage: `node scripts/run-one.mjs scripts/check-roots.mts`
 *
 * @module scripts/run-one
 */

import ts from 'typescript';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, relative, resolve as resolvePath } from 'node:path';

// This file lives in `scripts/dev/`, so the project root is two levels up.
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const outRoot = join(root, '.test-build', 'probe');
const entry = process.argv[2];
if (entry === undefined) {
  console.error('usage: node scripts/dev/run-one.mjs <script.mts>');
  process.exit(2);
}

const extensions = ['.ts', '.tsx', '.mts', '.js'];
const compilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  jsx: ts.JsxEmit.ReactJSX,
  esModuleInterop: true,
  newLine: ts.NewLineKind.LineFeed,
};

/** Resolve a relative specifier against the source tree. */
function resolveSource(specifier, importer) {
  const base = resolvePath(dirname(importer), specifier);
  for (const candidate of [base, ...extensions.map((extension) => `${base}${extension}`)]) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/** Map a source path into the scratch tree. */
function outPath(file) {
  return join(outRoot, relative(root, file).replace(/\.(ts|tsx|mts)$/, '.js'));
}

/** Transpile one file, pointing its relative imports at the scratch tree. */
async function emit(file) {
  const source = ts.sys.readFile(file);
  if (source === undefined) throw new Error(`cannot read ${file}`);
  const result = ts.transpileModule(source, { compilerOptions, fileName: file, reportDiagnostics: true });
  const errors = (result.diagnostics ?? []).filter((item) => item.category === ts.DiagnosticCategory.Error);
  if (errors.length > 0) {
    throw new Error(errors.map((item) => ts.flattenDiagnosticMessageText(item.messageText, ' ')).join('; '));
  }
  const code = result.outputText.replace(/(\bfrom\s+|\bimport\s*\(|\bimport\s+)(["'])([^"']+)\2/g, (match, prefix, quote, specifier) => {
    if (!specifier.startsWith('.')) return match;
    const resolved = resolveSource(specifier, file);
    if (resolved === undefined) return match;
    let next = relative(dirname(outPath(file)), outPath(resolved)).split('\\').join('/');
    if (!next.startsWith('.')) next = `./${next}`;
    return `${prefix}${quote}${next}${quote}`;
  });
  const target = outPath(file);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, code, 'utf8');
}

await rm(outRoot, { recursive: true, force: true });
// Emit the whole source tree so imports resolve, then run the entry.
const walk = async (dir) => {
  const { readdir } = await import('node:fs/promises');
  const found = [];
  for (const item of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, item.name);
    if (item.isDirectory()) found.push(...(await walk(full)));
    else if (/\.(ts|tsx|mts)$/.test(item.name)) found.push(full);
  }
  return found;
};
for (const file of await walk(join(root, 'src'))) await emit(file);
await emit(resolvePath(root, entry));

await import(pathToFileURL(outPath(resolvePath(root, entry))).href);
