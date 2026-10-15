/**
 * Switch the browser half between its real and minimal variants.
 *
 * The two variants exist to separate "the client module machinery cannot load
 * this plugin at all" from "something inside the page throws":
 *
 * - `real`    — the actual settings page (default).
 * - `minimal` — one static paragraph, no data, no host calls, plus a failure
 *               report back to the host log.
 *
 * Usage: `node scripts/variant.mjs real|minimal`
 *
 * @module scripts/variant
 */

import { copyFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const target = join(root, 'src', 'client', 'index.ts');

const variants = {
  real: join(root, 'variants', 'client-real.bak.ts'),
  minimal: join(root, 'variants', 'client-minimal.ts.bak'),
};

const requested = process.argv[2];
if (requested === undefined || !(requested in variants)) {
  console.error(`usage: node scripts/variant.mjs ${Object.keys(variants).join('|')}`);
  process.exitCode = 2;
} else {
  const source = variants[requested];
  await copyFile(source, target);
  const content = await readFile(target, 'utf8');
  const marker = content.includes('minimal self-reporting build') ? 'minimal' : 'real';
  console.log(`client half is now the ${marker} variant (from ${source.replace(root, '.')})`);
}
