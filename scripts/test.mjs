/**
 * Test entry point.
 *
 * Two constraints shape this script:
 *
 * - The Windows sandbox this project is developed in refuses `spawn` with piped
 *   stdio, which is how `node --test` starts an isolated child per test file.
 *   Importing the suites here runs them inside one process instead.
 * - The sources are plain TypeScript. Rather than relying on a runtime type
 *   stripper, every source and test file is transpiled once into a scratch
 *   directory, so the suite runs the same JavaScript the build would emit.
 *
 * @module scripts/test
 */

import ts from 'typescript';
import { mkdir, readdir, rm, writeFile, cp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, relative, resolve as resolvePath } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outRoot = join(root, '.test-build');
const srcDir = join(root, 'src');
const testDir = join(root, 'test');

const RESOLVE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.js'];
/** Options shared by every transpile call. */
const compilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  jsx: ts.JsxEmit.ReactJSX,
  esModuleInterop: true,
  sourceMap: false,
  newLine: ts.NewLineKind.LineFeed,
};

/** Walk a directory and return every file the suite needs to transpile. */
async function collect(dir) {
  const found = [];
  for (const item of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, item.name);
    if (item.isDirectory()) found.push(...(await collect(full)));
    else if (/\.(ts|tsx|mjs|mts)$/.test(item.name)) found.push(full);
  }
  return found.sort();
}

/** Resolve a relative specifier against the real source tree. */
function resolveSource(specifier, importer) {
  const base = resolvePath(dirname(importer), specifier);
  for (const candidate of [base, ...RESOLVE_EXTENSIONS.map((extension) => `${base}${extension}`)]) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/** Map a source path to its scratch output path. */
function outputPath(file) {
  const rel = relative(root, file);
  const withoutExtension = rel.replace(/\.(ts|tsx|mjs|mts)$/, '');
  return join(outRoot, ...withoutExtension.split(/[\\/]/)).concat('.js');
}

/**
 * Point relative imports at the transpiled tree.
 *
 * Covers `import ... from`, bare `import "..."` and dynamic `import("...")`, so
 * both the TypeScript sources and the plain `.mjs` test files resolve inside
 * the scratch directory instead of reaching for a `.ts` file.
 * @param code - emitted JavaScript.
 * @param file - the source file the code came from.
 * @returns the code with rewritten specifiers.
 */
function rewriteSpecifiers(code, file) {
  return code.replace(/(\bfrom\s+|\bimport\s*\(|\bimport\s+)(["'])([^"']+)\2/g, (match, prefix, quote, specifier) => {
    if (!specifier.startsWith('.')) return match;
    const resolved = resolveSource(specifier, file);
    if (resolved === undefined) return match;
    let next = relative(dirname(outputPath(file)), outputPath(resolved)).split('\\').join('/');
    if (!next.startsWith('.')) next = `./${next}`;
    return `${prefix}${quote}${next}${quote}`;
  });
}

/** Transpile one file and point its relative imports at the transpiled tree. */
function transpileFile(file) {
  const source = ts.sys.readFile(file);
  if (source === undefined) throw new Error(`cannot read ${file}`);
  const result = ts.transpileModule(source, {
    compilerOptions,
    fileName: file,
    reportDiagnostics: true,
  });
  const errors = (result.diagnostics ?? []).filter((item) => item.category === ts.DiagnosticCategory.Error);
  if (errors.length > 0) {
    throw new Error(`${relative(root, file)}: ${errors.map((item) => ts.flattenDiagnosticMessageText(item.messageText, ' ')).join('; ')}`);
  }
  return rewriteSpecifiers(result.outputText, file);
}

await rm(outRoot, { recursive: true, force: true });
const files = [...(await collect(srcDir)), ...(await collect(testDir))];
for (const file of files) {
  const target = outputPath(file);
  await mkdir(dirname(target), { recursive: true });
  // Every file goes through the transpiler: the test files are plain ESM but
  // still carry TypeScript type annotations, so copying them verbatim would
  // leave those annotations in JavaScript the runtime cannot parse.
  await writeFile(target, transpileFile(file), 'utf8');
}
// Tests read the manifest and the built artifacts to assert the published
// shape, so the scratch tree mirrors the project layout for those files.
await writeFile(join(outRoot, 'package.json'), ts.sys.readFile(join(root, 'package.json')) ?? '', 'utf8');
await cp(join(root, 'lib'), join(outRoot, 'lib'), { recursive: true });
// Files the suites assert on directly, so the scratch tree mirrors the package.
for (const name of ['cordis.patch.yml', 'README.md']) {
  await cp(join(root, name), join(outRoot, name));
}

const testFiles = (await readdir(join(outRoot, 'test'))).filter((name) => /\.test\.(js|mjs)$/.test(name)).sort();
if (testFiles.length === 0) throw new Error('no test files found');
console.log(`test files: ${testFiles.join(', ')}`);

for (const file of testFiles) {
  try {
    await import(pathToFileURL(join(outRoot, 'test', file)).href);
  } catch (error) {
    console.error(`failed to load ${file}:`, error);
    process.exitCode = 1;
  }
}
