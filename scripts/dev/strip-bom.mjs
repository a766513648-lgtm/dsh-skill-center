/**
 * Strip a UTF-8 byte-order mark from the project's text files.
 *
 * The BOM is invisible in an editor and breaks strict readers: the Host's JSON parser
 * reports only `SyntaxError: Unexpected token '﻿'` followed by the plugin silently
 * never loading, and `tsc` treats a BOM'd file inconsistently with the rest of the
 * tree. Windows tooling adds one without asking, so it is removed here rather than
 * relied on not being introduced.
 *
 * @module scripts/dev/strip-bom
 */

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = 'O:\\DSH_Workship\\dsh-skill-center';
const extensions = /\.(json|md|mjs|mts|ts|tsx|yml|yaml)$/;
const skip = new Set(['node_modules', '.test-build', 'lib', '.git', 'docs', '.probe', '.skill-center-test']);

/** Every text file that ships or is read by tooling. */
function walk(dir, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, found);
    else if (extensions.test(entry.name)) found.push(full);
  }
  return found;
}

let stripped = 0;
for (const file of walk(root)) {
  const bytes = readFileSync(file);
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    writeFileSync(file, bytes.subarray(3));
    stripped += 1;
    console.log(`stripped ${file.replace(`${root}\\`, '')}`);
  }
}
console.log(stripped === 0 ? 'no byte-order marks found' : `${String(stripped)} file(s) cleaned`);
