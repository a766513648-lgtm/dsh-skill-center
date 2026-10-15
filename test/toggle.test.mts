/**
 * Unit tests for the on/off rewrite of a skill document.
 *
 * @module test/toggle.test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { applyPatch, toggleSkillFile } from '../src/core/toggle.ts';
import { makeTempDir, removeDir, skillDoc, writeBundle } from './helpers.mts';

test('switching off appends both invocation flags', () => {
  const original = skillDoc({ name: 'demo', body: 'Keep me.' });
  const result = applyPatch(original, true);
  assert.equal(result.changed, true);
  assert.equal(result.error, undefined);
  assert.match(result.text, /^---\nname: demo\ndescription: A test skill\.\ndisable-model-invocation: true\nuser-invocable: false\n---\n/);
  assert.ok(result.text.endsWith('Keep me.\n'));
});

test('switching back on removes exactly the managed keys', () => {
  const disabled = applyPatch(skillDoc({ name: 'demo' }), true).text;
  const enabled = applyPatch(disabled, false);
  assert.equal(enabled.changed, true);
  assert.equal(enabled.text, skillDoc({ name: 'demo' }));
});

test('toggling twice is idempotent', () => {
  const once = applyPatch(skillDoc({ name: 'demo' }), true).text;
  const twice = applyPatch(once, true);
  assert.equal(twice.changed, false);
  assert.equal(twice.text, once);
});

test('removes a pre-existing flag written by hand', () => {
  const original = skillDoc({ name: 'demo', extra: 'disable-model-invocation: false' });
  const result = applyPatch(original, true);
  const occurrences = result.text.match(/disable-model-invocation/g) ?? [];
  assert.equal(occurrences.length, 1);
  assert.match(result.text, /disable-model-invocation: true/);
});

test('preserves unrelated frontmatter keys and their order', () => {
  const original = '---\nname: demo\ndescription: Keeps keys.\nwhenToUse: Sometimes\nmetadata:\n  owner: me\n---\n\nBody\n';
  const off = applyPatch(original, true).text;
  assert.match(off, /whenToUse: Sometimes/);
  assert.match(off, /metadata:\n  owner: me/);
  const on = applyPatch(off, false).text;
  assert.equal(on, original);
});

test('refuses a document without usable frontmatter', () => {
  const result = applyPatch('# no frontmatter\n', true);
  assert.equal(result.changed, false);
  assert.equal(result.error?.code, 'error.toggle.frontmatter');
});

test('writes the change to disk atomically and reports it', async () => {
  const root = await makeTempDir();
  try {
    const file = await writeBundle(root, 'disk-skill');
    const result = await toggleSkillFile(file, true);
    assert.equal(result.changed, true);
    assert.equal(result.error, undefined);
    const written = await readFile(file, 'utf8');
    assert.match(written, /disable-model-invocation: true/);

    const again = await toggleSkillFile(file, true);
    assert.equal(again.changed, false);

    const back = await toggleSkillFile(file, false);
    assert.equal(back.changed, true);
    assert.equal(await readFile(file, 'utf8'), skillDoc({ name: 'disk-skill' }));
  } finally {
    await removeDir(root);
  }
});

test('reports a missing file instead of throwing', async () => {
  const result = await toggleSkillFile('does/not/exist/SKILL.md', true);
  assert.equal(result.changed, false);
  assert.equal(result.error?.code, 'error.toggle.unreadable');
});
