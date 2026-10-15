/**
 * Unit tests for the stored on/off state.
 *
 * @module test/store.test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { emptyState, isDisabled, loadState, saveState, stateFilePath, withDisabled } from '../src/core/store.ts';
import { makeTempDir, removeDir } from './helpers.mts';

test('a fresh home has no state and reports nothing disabled', async () => {
  const home = await makeTempDir();
  try {
    const state = await loadState(home);
    assert.equal(state.warning, undefined);
    assert.equal(isDisabled(state, 'dsh', 'anything'), false);
  } finally {
    await removeDir(home);
  }
});

test('saves and reloads disabled names per root', async () => {
  const home = await makeTempDir();
  try {
    let state = withDisabled(emptyState(), 'dsh', 'alpha', true);
    state = withDisabled(state, 'dsh', 'beta', true);
    state = withDisabled(state, 'project-dsh:abc', 'alpha', true);
    await saveState(home, state);

    const reloaded = await loadState(home);
    assert.equal(isDisabled(reloaded, 'dsh', 'alpha'), true);
    assert.equal(isDisabled(reloaded, 'dsh', 'beta'), true);
    assert.equal(isDisabled(reloaded, 'project-dsh:abc', 'alpha'), true);
    assert.equal(isDisabled(reloaded, 'dsh', 'gamma'), false);
  } finally {
    await removeDir(home);
  }
});

test('re-enabling drops the name and then the whole root', async () => {
  const home = await makeTempDir();
  try {
    const on = withDisabled(withDisabled(emptyState(), 'dsh', 'alpha', true), 'dsh', 'alpha', false);
    await saveState(home, on);
    const reloaded = await loadState(home);
    assert.equal(isDisabled(reloaded, 'dsh', 'alpha'), false);

    const raw = await import('node:fs/promises').then((fs) => fs.readFile(stateFilePath(home), 'utf8'));
    assert.match(raw, /"roots":\s*\{\}/);
  } finally {
    await removeDir(home);
  }
});

test('a skill stays switched off after its directory moves to another root', () => {
  // Written while the skill lived in `dsh`, read back under a configured root.
  const state = withDisabled(emptyState(), 'dsh', 'alpha', true);
  assert.equal(isDisabled(state, 'custom:0', 'alpha'), true, 'the flag must follow the name');
  assert.equal(isDisabled(state, 'custom:0', 'beta'), false, 'other skills are unaffected');
});

test('switching a moved skill back on clears the stale root entry', () => {
  const moved = withDisabled(emptyState(), 'dsh', 'alpha', true);
  const enabled = withDisabled(moved, 'custom:0', 'alpha', false);
  assert.equal(isDisabled(enabled, 'dsh', 'alpha'), false, 'the old root must not keep the name');
  assert.equal(isDisabled(enabled, 'custom:0', 'alpha'), false);
  assert.equal(enabled.roots.size, 0, 'no empty root should be left behind');
});

test('a corrupt document degrades to everything enabled, with a warning', async () => {
  const home = await makeTempDir();
  try {
    await mkdir(join(home, 'skill-center'), { recursive: true });
    await writeFile(join(home, 'skill-center', 'state.json'), '{ this is not json', 'utf8');
    const state = await loadState(home);
    assert.equal(state.warning?.code, 'warning.state.corrupt');
    assert.equal(isDisabled(state, 'dsh', 'alpha'), false);
  } finally {
    await removeDir(home);
  }
});

test('an unsupported version is treated as corrupt', async () => {
  const home = await makeTempDir();
  try {
    await mkdir(join(home, 'skill-center'), { recursive: true });
    await writeFile(join(home, 'skill-center', 'state.json'), JSON.stringify({ version: 99, roots: { dsh: ['alpha'] } }), 'utf8');
    const state = await loadState(home);
    assert.equal(state.warning?.code, 'warning.state.corrupt');
  } finally {
    await removeDir(home);
  }
});

test('drops unusable keys instead of trusting the file', async () => {
  const home = await makeTempDir();
  try {
    await mkdir(join(home, 'skill-center'), { recursive: true });
    await writeFile(
      join(home, 'skill-center', 'state.json'),
      JSON.stringify({ version: 1, roots: { dsh: ['good', 'bad/name', '../../escape', 42, ''] } }),
      'utf8',
    );
    const state = await loadState(home);
    assert.equal(isDisabled(state, 'dsh', 'good'), true);
    assert.equal(isDisabled(state, 'dsh', 'bad/name'), false);
    assert.equal(isDisabled(state, 'dsh', '../../escape'), false);
  } finally {
    await removeDir(home);
  }
});

test('the state document is written atomically without leftovers', async () => {
  const home = await makeTempDir();
  try {
    await saveState(home, withDisabled(emptyState(), 'dsh', 'alpha', true));
    const entries = await import('node:fs/promises').then((fs) => fs.readdir(join(home, 'skill-center')));
    assert.deepEqual(entries, ['state.json']);
  } finally {
    await removeDir(home);
  }
});
