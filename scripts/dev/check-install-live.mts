/**
 * End-to-end install check against real public URLs.
 *
 * The unit tests stub `fetch`, so they prove the logic and not the world. This runs
 * the same code path with the real network and prints what happened for each link,
 * including the refusal reasons, so a real-world shape that was not anticipated is
 * visible before a user meets it.
 *
 * Usage: node scripts/run-one.mjs scripts/check-install-live.mts
 *
 * @module scripts/check-install-live
 */

import { mkdir, readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { installFromUrl } from '../../src/core/install.ts';

// A scratch directory beside the repository, so the probe is portable.
const target = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '.skill-center-test', 'live-install');
await mkdir(target, { recursive: true });

const urls = [
  'https://github.com/octocat/Hello-World',
  'https://github.com/obra/superpowers',
  'https://github.com/obra/superpowers/tree/main/skills/brainstorming',
  'https://raw.githubusercontent.com/octocat/Hello-World/master/README',
];

for (const url of urls) {
  console.log(`\n=== ${url}`);
  const existing = await readdir(target).catch(() => []);
  const result = await installFromUrl({ url, targetRoot: target, existingNames: existing });
  if (result.ok) {
    for (const skill of result.skills) {
      console.log(`  installed "${skill.name}" (${skill.source}, ${String(skill.files)} files) -> ${skill.directory}`);
      const skillFile = join(skill.directory, 'SKILL.md');
      if (existsSync(skillFile)) {
        const text = await readFile(skillFile, 'utf8');
        console.log(`    first line: ${text.split('\n')[0] ?? ''}`);
      }
    }
    console.log(`  skipped ${String(result.skipped)} entries`);
  } else {
    console.log(`  refused: ${result.error.code}`);
    console.log(`  message: ${result.error.message}`);
  }
}

console.log('\n--- what landed ---');
for (const name of await readdir(target)) console.log(`  ${name}`);
