/**
 * Unit tests for reading a profile's extra skill roots.
 *
 * The panel must watch the same directories DSH loads skills from; these tests
 * pin the narrow YAML reading that keeps the two from drifting, including the
 * cases it deliberately does not handle.
 *
 * @module test/skillRoots.test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { configuredSkillRoots } from '../src/index.ts';
import { makeTempDir, removeDir } from './helpers.mts';

/** Write a profile patch layer that configures the given skill roots. */
async function writeProfile(home: string, profile: string, body: string): Promise<void> {
  const dir = join(home, 'profiles', profile);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'cordis.patch.yml'), body, 'utf8');
}

test('reads a nested customSkillDirs list', async () => {
  const home = await makeTempDir();
  try {
    const skills = join(home, 'hub');
    await mkdir(skills, { recursive: true });
    await writeProfile(
      home,
      'desktop',
      [
        '# comment',
        '- id: skill-filesystem',
        "  name: '@deepseek-ai/dsh-skill-filesystem'",
        '  config:',
        '    customSkillDirs:',
        `      - '${skills}'`,
        '- id: agent-default-model',
        '  config:',
        '    model: deepseek-flash',
      ].join('\n'),
    );
    assert.deepEqual(configuredSkillRoots(home), [resolve(skills)]);
  } finally {
    await removeDir(home);
  }
});

test('reads several roots and keeps their order', async () => {
  const home = await makeTempDir();
  try {
    const first = join(home, 'one');
    const second = join(home, 'two');
    await mkdir(first, { recursive: true });
    await mkdir(second, { recursive: true });
    await writeProfile(
      home,
      'desktop',
      ['- id: skill-filesystem', '  config:', '    customSkillDirs:', `      - '${first}'`, `      - "${second}"`].join('\n'),
    );
    assert.deepEqual(configuredSkillRoots(home), [resolve(first), resolve(second)]);
  } finally {
    await removeDir(home);
  }
});

test('reads the inline list form', async () => {
  const home = await makeTempDir();
  try {
    const skills = join(home, 'inline');
    await mkdir(skills, { recursive: true });
    await writeProfile(home, 'desktop', `- id: skill-filesystem\n  config:\n    customSkillDirs: ['${skills}']\n`);
    assert.deepEqual(configuredSkillRoots(home), [resolve(skills)]);
  } finally {
    await removeDir(home);
  }
});

test('skips roots that are not there, and reads nothing from other entries', async () => {
  const home = await makeTempDir();
  try {
    const missing = join(home, 'not-created');
    const other = join(home, 'other');
    await mkdir(other, { recursive: true });
    await writeProfile(
      home,
      'desktop',
      [
        '- id: some-other-plugin',
        '  config:',
        '    customSkillDirs:',
        `      - '${other}'`,
        '- id: skill-filesystem',
        '  config:',
        '    customSkillDirs:',
        `      - '${missing}'`,
      ].join('\n'),
    );
    // The other entry's list is ignored, and a missing directory is not listed.
    assert.deepEqual(configuredSkillRoots(home), []);
  } finally {
    await removeDir(home);
  }
});

test('collects roots from every profile, not just one', async () => {
  // The running profile's name is not reliably visible inside a plugin, so the
  // reader looks at all of them; a root configured in any profile is listed once.
  const home = await makeTempDir();
  try {
    const desktopRoot = join(home, 'from-desktop');
    const webRoot = join(home, 'from-web');
    await mkdir(desktopRoot, { recursive: true });
    await mkdir(webRoot, { recursive: true });
    await writeProfile(home, 'desktop', `- id: skill-filesystem\n  config:\n    customSkillDirs:\n      - '${desktopRoot}'\n`);
    await writeProfile(
      home,
      'web',
      `- id: skill-filesystem\n  config:\n    customSkillDirs:\n      - '${webRoot}'\n      - '${desktopRoot}'\n`,
    );
    const roots = configuredSkillRoots(home);
    assert.deepEqual(roots, [resolve(desktopRoot), resolve(webRoot)], 'both profiles contribute, without duplicates');
  } finally {
    await removeDir(home);
  }
});

test('answers an empty list when the profile has no patch layer', async () => {
  const home = await makeTempDir();
  try {
    assert.deepEqual(configuredSkillRoots(home), []);
  } finally {
    await removeDir(home);
  }
});

test('a malformed layer does not throw', async () => {
  const home = await makeTempDir();
  try {
    await writeProfile(home, 'desktop', '- id: skill-filesystem\n  config:\n    customSkillDirs: [\n      - "unterminated\n');
    assert.deepEqual(configuredSkillRoots(home), []);
  } finally {
    await removeDir(home);
  }
});
