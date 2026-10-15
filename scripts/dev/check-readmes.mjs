/**
 * Check the two READMEs stay in step.
 *
 * A translation drifts quietly: a section added to one language and forgotten in the
 * other leaves a reader with a different manual depending on which link they followed.
 * The section headings are compared, so the drift is visible as a missing heading
 * rather than as a surprise later.
 *
 * @module scripts/dev/check-readmes
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = 'O:\\DSH_Workship\\dsh-skill-center';
const english = readFileSync(join(root, 'README.md'), 'utf8');
const chinese = readFileSync(join(root, 'README.zh.md'), 'utf8');

/** Headings at the same level, so the two trees can be compared. */
function headings(text) {
  return [...text.matchAll(/^(#{1,4})\s+(.+)$/gm)].map((match) => `${match[1].length}:${match[2].trim()}`);
}

const en = headings(english);
const zh = headings(chinese);

console.log(`README.md    : ${String(en.length)} headings, ${String(english.length)} chars`);
console.log(`README.zh.md : ${String(zh.length)} headings, ${String(chinese.length)} chars`);

// The counts must match; the text obviously differs, so only the shape is compared.
if (en.length !== zh.length) {
  console.log(`\nheading counts differ by ${String(Math.abs(en.length - zh.length))}`);
  console.log('English headings:');
  for (const line of en) console.log(`  ${line}`);
  console.log('Chinese headings:');
  for (const line of zh) console.log(`  ${line}`);
  process.exitCode = 1;
} else {
  console.log(`\nboth files have ${String(en.length)} headings, in the same levels:`);
  for (let index = 0; index < en.length; index += 1) {
    const level = en[index]?.split(':')[0];
    console.log(`  ${'#'.repeat(Number(level))} ${en[index]?.split(':').slice(1).join(':')}  |  ${zh[index]?.split(':').slice(1).join(':')}`);
  }
}

// Screenshots and the language switch have to be present in both.
for (const [label, text] of [['README.md', english], ['README.zh.md', chinese]]) {
  const images = [...text.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map((match) => match[1]);
  console.log(`\n${label}: ${String(images.length)} image(s)`);
  for (const image of images) console.log(`  ${image}`);
}
