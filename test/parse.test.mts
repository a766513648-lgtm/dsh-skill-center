/**
 * Unit tests for frontmatter parsing.
 *
 * @module test/parse.test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkName, parseSkillDoc } from '../src/core/parse.ts';
import { skillDoc } from './helpers.mts';

test('parses a healthy skill document', () => {
  const parsed = parseSkillDoc(skillDoc({ name: 'code-review', description: 'Review code.', body: 'Do the review.' }));
  assert.equal(parsed.hasFrontmatter, true);
  assert.equal(parsed.frontmatterClosed, true);
  assert.equal(parsed.declaredName, 'code-review');
  assert.equal(parsed.description, 'Review code.');
  assert.equal(parsed.body, 'Do the review.');
  assert.deepEqual(parsed.diagnostics, []);
});

test('reports a missing frontmatter block', () => {
  const parsed = parseSkillDoc('# Just a heading\n\nNo frontmatter here.');
  assert.equal(parsed.hasFrontmatter, false);
  assert.equal(parsed.diagnostics[0]?.code, 'error.frontmatter.missing');
});

test('reports an unclosed frontmatter block', () => {
  const parsed = parseSkillDoc('---\nname: broken\ndescription: x\n');
  assert.equal(parsed.hasFrontmatter, true);
  assert.equal(parsed.frontmatterClosed, false);
  assert.equal(parsed.diagnostics[0]?.code, 'error.frontmatter.unclosed');
});

test('rejects a name that is not kebab-case', () => {
  const parsed = parseSkillDoc(skillDoc({ name: 'Code Review' }));
  assert.ok(parsed.diagnostics.some((item) => item.code === 'error.name.format'));
});

test('rejects a reserved Windows device name', () => {
  const parsed = parseSkillDoc(skillDoc({ name: 'nul' }));
  assert.ok(parsed.diagnostics.some((item) => item.code === 'error.name.device'));
});

test('requires a description', () => {
  const parsed = parseSkillDoc('---\nname: lonely\n---\n\nbody\n');
  assert.ok(parsed.diagnostics.some((item) => item.code === 'error.description.missing'));
});

test('decodes quoted and single-quoted scalars', () => {
  const parsed = parseSkillDoc('---\nname: quoted\ndescription: "He said \\"hi\\"."\nwhenToUse: \'it\'\'s fine\'\n---\n\nbody\n');
  assert.equal(parsed.description, 'He said "hi".');
  assert.equal(parsed.whenToUse, "it's fine");
});

test('folds a block scalar description', () => {
  const parsed = parseSkillDoc('---\nname: folded\ndescription: >\n  First part\n  second part\n---\n\nbody\n');
  assert.equal(parsed.description, 'First part second part');
});

test('tolerates a byte-order mark', () => {
  const parsed = parseSkillDoc(`\uFEFF${skillDoc({ name: 'bom-skill' })}`);
  assert.equal(parsed.hasFrontmatter, true);
  assert.equal(parsed.declaredName, 'bom-skill');
});

test('tolerates CRLF line endings', () => {
  const parsed = parseSkillDoc('---\r\nname: crlf-skill\r\ndescription: Windows file.\r\n---\r\n\r\nbody\r\n');
  assert.equal(parsed.declaredName, 'crlf-skill');
  assert.equal(parsed.body, 'body');
  assert.deepEqual(parsed.diagnostics, []);
});

test('checkName accepts a matching kebab-case name', () => {
  assert.equal(checkName('code-review', 'code-review').valid, true);
});

test('checkName rejects a name that cannot address the skill', () => {
  assert.equal(checkName('', 'folder-name').valid, false);
  assert.equal(checkName('Not Kebab', 'not-kebab').valid, false);
});
