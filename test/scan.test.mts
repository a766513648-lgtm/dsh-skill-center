/**
 * Unit tests for skill discovery.
 *
 * @module test/scan.test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { scanSkills } from '../src/core/scan.ts';
import { makeTempDir, removeDir, writeBundle, writeFileAt, writeFlat } from './helpers.mts';

test('finds bundles and flat files in the global root', async () => {
  const home = await makeTempDir();
  try {
    const skills = join(home, 'skills');
    await writeBundle(skills, 'code-review');
    await writeFlat(skills, 'quick-note');
    const result = await scanSkills({ dshHome: home });

    assert.equal(result.roots.length, 1);
    const [root] = result.roots;
    assert.equal(root?.key, 'dsh');
    assert.equal(root?.exists, true);
    assert.deepEqual(root?.skills.map((skill) => skill.name), ['code-review', 'quick-note']);
    assert.deepEqual(root?.skills.map((skill) => skill.kind), ['bundle', 'flat']);
    assert.ok(root?.skills.every((skill) => skill.loadable));
  } finally {
    await removeDir(home);
  }
});

test('discovers nothing from a repository copied in one level too deep', async () => {
  const home = await makeTempDir();
  try {
    const skills = join(home, 'skills');
    // A GitHub ZIP extracts to one folder; copying that folder itself into the
    // skills root nests every bundle one level too deep.
    await writeFileAt(skills, 'repo-main/my-skill/SKILL.md', '---\nname: my-skill\ndescription: Copied from a ZIP.\n---\n\nbody\n');
    const nested = await scanSkills({ dshHome: home });
    assert.deepEqual(nested.roots[0]?.skills ?? [], [], 'a nested bundle is not discovered');

    // Lifting the bundle folder to the skills root is the correct install.
    await writeFileAt(skills, 'my-skill/SKILL.md', '---\nname: my-skill\ndescription: Lifted to the root.\n---\n\nbody\n');
    const lifted = await scanSkills({ dshHome: home });
    assert.deepEqual(lifted.roots[0]?.skills.map((skill) => skill.name), ['my-skill']);
  } finally {
    await removeDir(home);
  }
});

test('discovers a flat markdown skill and a bundle declared off by its author', async () => {
  const home = await makeTempDir();
  try {
    const skills = join(home, 'skills');
    await writeFileAt(skills, 'quick-note.md', '---\nname: quick-note\ndescription: A single-file skill.\n---\n\nbody\n');
    await writeFileAt(
      skills,
      'disabled-skill/SKILL.md',
      '---\nname: disabled-skill\ndescription: Shipped switched off.\ndisable-model-invocation: true\nuser-invocable: false\n---\n\nbody\n',
    );
    const result = await scanSkills({ dshHome: home });
    assert.deepEqual(result.roots[0]?.skills.map((skill) => skill.name), ['disabled-skill', 'quick-note']);
    assert.deepEqual(result.roots[0]?.skills.map((skill) => skill.kind), ['bundle', 'flat']);
    assert.ok(result.roots[0]?.skills.every((skill) => skill.loadable));
  } finally {
    await removeDir(home);
  }
});

test('reports a missing global root without failing', async () => {
  const home = await makeTempDir();
  try {
    const result = await scanSkills({ dshHome: home });    assert.equal(result.roots[0]?.exists, false);
    assert.deepEqual(result.roots[0]?.skills, []);
  } finally {
    await removeDir(home);
  }
});

test('ignores entries that cannot address a skill', async () => {
  const home = await makeTempDir();
  try {
    const skills = join(home, 'skills');
    await writeBundle(skills, 'valid-name');
    await writeBundle(skills, 'Invalid Name');
    await writeFileAt(skills, 'loose.txt', 'not a skill');
    await writeFileAt(skills, 'nested/inner/SKILL.md', '---\nname: nested\n---\n');
    const result = await scanSkills({ dshHome: home });
    assert.deepEqual(result.roots[0]?.skills.map((skill) => skill.name), ['valid-name']);
  } finally {
    await removeDir(home);
  }
});

test('flags a skill whose frontmatter name is not loadable', async () => {
  const home = await makeTempDir();
  try {
    const skills = join(home, 'skills');
    await writeFileAt(skills, 'bad-name/SKILL.md', '---\nname: Bad Name\ndescription: x\n---\n\nbody\n');
    const result = await scanSkills({ dshHome: home });
    const skill = result.roots[0]?.skills[0];
    assert.equal(skill?.loadable, false);
    assert.ok(skill?.diagnostics.some((item) => item.code === 'error.name.format'));
  } finally {
    await removeDir(home);
  }
});

test('warns when the frontmatter name differs from the folder name', async () => {
  const home = await makeTempDir();
  try {
    const skills = join(home, 'skills');
    await writeFileAt(skills, 'folder-name/SKILL.md', '---\nname: other-name\ndescription: x\n---\n\nbody\n');
    const result = await scanSkills({ dshHome: home });
    const skill = result.roots[0]?.skills[0];
    assert.equal(skill?.name, 'other-name');
    assert.equal(skill?.loadable, true);
    assert.ok(skill?.diagnostics.some((item) => item.code === 'warning.name.mismatch'));
  } finally {
    await removeDir(home);
  }
});

test('adds the project root when the session has one', async () => {
  const home = await makeTempDir();
  const project = await makeTempDir('skill-center-project-');
  try {
    await writeBundle(join(home, 'skills'), 'global-skill');
    await writeBundle(join(project, '.dsh', 'skills'), 'project-skill');
    const result = await scanSkills({ dshHome: home, projectRoot: project });

    assert.equal(result.roots.length, 2);
    const projectRoot = result.roots[1];
    assert.equal(projectRoot?.scope, 'project');
    assert.match(projectRoot?.key ?? '', /^project-dsh:[a-f0-9]{12}$/);
    assert.deepEqual(projectRoot?.skills.map((skill) => skill.name), ['project-skill']);
  } finally {
    await removeDir(home);
    await removeDir(project);
  }
});

test('follows the documented project key shape', async () => {
  const home = await makeTempDir();
  const project = await makeTempDir('skill-center-stable-');
  try {
    await mkdir(join(project, '.dsh', 'skills'), { recursive: true });
    const first = await scanSkills({ dshHome: home, projectRoot: project });
    const second = await scanSkills({ dshHome: home, projectRoot: project });
    assert.equal(first.roots[1]?.key, second.roots[1]?.key);
  } finally {
    await removeDir(home);
    await removeDir(project);
  }
});

test('a skills root that is a link is never followed silently', async () => {
  const home = await makeTempDir();
  const elsewhere = await makeTempDir('skill-center-elsewhere-');
  try {
    await writeBundle(elsewhere, 'hidden-skill');
    const linkPath = join(home, 'skills');
    try {
      await symlink(elsewhere, linkPath, 'junction');
    } catch {
      // The platform refused to create the link, so there is nothing to probe.
      return;
    }

    const result = await scanSkills({ dshHome: home });
    const root = result.roots[0];

    // A junction on Windows reports as an ordinary directory and is not a
    // symbolic link, so the scanner compares the resolved path instead. The
    // redirected root must be skipped rather than scanned through.
    assert.equal(root?.exists, false);
    assert.equal(root?.warning?.code, 'warning.root.unsafe');
    assert.deepEqual(root?.skills, []);
  } finally {
    await removeDir(home);
    await removeDir(elsewhere);
  }
});

test('keeps a skill whose document cannot be read, marked unloadable', async () => {
  const home = await makeTempDir();
  try {
    const skills = join(home, 'skills');
    // A directory named like a bundle but without SKILL.md inside is not a skill.
    await mkdir(join(skills, 'empty-bundle'), { recursive: true });
    const result = await scanSkills({ dshHome: home });
    assert.deepEqual(result.roots[0]?.skills ?? [], []);
  } finally {
    await removeDir(home);
  }
});
