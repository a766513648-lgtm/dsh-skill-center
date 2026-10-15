/**
 * Tests for moving a skill to the trash and putting it back.
 *
 * The gates matter more than the happy path: deleting the wrong thing is the one
 * mistake in this plugin that costs the user work, so every refusal is asserted
 * explicitly, along with the promise that a refusal leaves the disk untouched.
 *
 * @module test/trash.test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  emptyTrash,
  moveToTrash,
  readTrash,
  restoreFromTrash,
  trashHome,
  trashIndexPath,
  type DeleteRequest,
} from '../src/core/trash.ts';
import { makeTempDir, removeDir } from './helpers.mts';
import { otherVolumeDir } from './volumes.mts';

/** Lay out one skills root with a single bundle skill and return its paths. */
async function makeRoot(home: string, name = 'alpha'): Promise<{ root: string; request: DeleteRequest }> {
  const root = join(home, 'skills');
  const bundle = join(root, name);
  await mkdir(bundle, { recursive: true });
  await writeFile(
    join(bundle, 'SKILL.md'),
    `---\nname: ${name}\ndescription: A skill.\n---\n\nBody text.\n`,
    'utf8',
  );
  return {
    root,
    request: {
      rootPath: root,
      rootKey: 'custom:0',
      scope: 'user',
      name,
      path: join(bundle, 'SKILL.md'),
      kind: 'bundle',
      loadable: true,
    },
  };
}

test('a skill moves into the trash and disappears from its root', async () => {
  const home = await makeTempDir();
  try {
    const { root, request } = await makeRoot(home);
    const result = await moveToTrash({ dshHome: home, request });
    assert.equal(result.ok, true, 'the move should succeed');
    assert.equal(existsSync(join(root, 'alpha')), false, 'the bundle must be gone from the root');

    const trash = await readTrash(home);
    assert.equal(trash.entries.length, 1, 'the trash should hold one entry');
    assert.equal(trash.entries[0]?.name, 'alpha');
    assert.equal(trash.entries[0]?.originalPath, join(root, 'alpha'));
    assert.equal(existsSync(join(trashHome(home), trash.entries[0].storedName, 'SKILL.md')), true, 'the file must be in the trash');
  } finally {
    await removeDir(home);
  }
});

test('restoring puts the exact bytes back', async () => {
  const home = await makeTempDir();
  try {
    const { root, request } = await makeRoot(home);
    const before = await readFile(join(root, 'alpha', 'SKILL.md'), 'utf8');
    const moved = await moveToTrash({ dshHome: home, request });
    assert.equal(moved.ok, true);

    const restored = await restoreFromTrash({ dshHome: home, id: (moved as { value: { id: string } }).value.id });
    assert.equal(restored.ok, true, 'restore should succeed');
    assert.equal(await readFile(join(root, 'alpha', 'SKILL.md'), 'utf8'), before, 'the file must come back unchanged');
    assert.equal((await readTrash(home)).entries.length, 0, 'the entry must leave the index');
  } finally {
    await removeDir(home);
  }
});

test('a project-scoped skill is refused and left in place', async () => {
  const home = await makeTempDir();
  try {
    const { root, request } = await makeRoot(home);
    const result = await moveToTrash({ dshHome: home, request: { ...request, scope: 'project' } });
    assert.equal(result.ok, false);
    assert.equal((result as { error: { code: string } }).error.code, 'error.delete.project');
    assert.equal(existsSync(join(root, 'alpha', 'SKILL.md')), true, 'nothing may move');
  } finally {
    await removeDir(home);
  }
});

test('a skill DSH cannot load is refused and left in place', async () => {
  const home = await makeTempDir();
  try {
    const { root, request } = await makeRoot(home);
    const result = await moveToTrash({ dshHome: home, request: { ...request, loadable: false } });
    assert.equal(result.ok, false);
    assert.equal((result as { error: { code: string } }).error.code, 'error.delete.unloadable');
    assert.equal(existsSync(join(root, 'alpha', 'SKILL.md')), true, 'nothing may move');
  } finally {
    await removeDir(home);
  }
});

test('a skill reported outside its root is refused', async () => {
  const home = await makeTempDir();
  try {
    const { request } = await makeRoot(home);
    const other = join(home, 'elsewhere');
    await mkdir(other, { recursive: true });
    await writeFile(join(other, 'SKILL.md'), 'x', 'utf8');

    const result = await moveToTrash({ dshHome: home, request: { ...request, path: join(other, 'SKILL.md'), kind: 'flat' } });
    assert.equal(result.ok, false);
    assert.equal((result as { error: { code: string } }).error.code, 'error.delete.outsideRoot');
    assert.equal(existsSync(join(other, 'SKILL.md')), true, 'the outside file must be untouched');
  } finally {
    await removeDir(home);
  }
});

test('a symbolic link is refused', async () => {
  const home = await makeTempDir();
  try {
    const { root, request } = await makeRoot(home);
    const real = join(home, 'real-skill');
    await mkdir(real, { recursive: true });
    await writeFile(join(real, 'SKILL.md'), 'x', 'utf8');
    const link = join(root, 'linked');
    try {
      await symlink(real, link, 'junction');
    } catch {
      return; // Creating links is not always permitted; the gate is covered by the path checks either way.
    }

    const result = await moveToTrash({
      dshHome: home,
      request: { ...request, name: 'linked', path: join(link, 'SKILL.md') },
    });
    assert.equal(result.ok, false, 'a link must never be moved');
    assert.equal(existsSync(link), true, 'the link must still be there');
    assert.equal(existsSync(join(real, 'SKILL.md')), true, 'the target must be untouched');
  } finally {
    await removeDir(home);
  }
});

test('restoring refuses when the original path is occupied again', async () => {
  const home = await makeTempDir();
  try {
    const { root, request } = await makeRoot(home);
    const moved = await moveToTrash({ dshHome: home, request });
    assert.equal(moved.ok, true);

    // The user recreated a skill with the same name in the meantime.
    await mkdir(join(root, 'alpha'), { recursive: true });
    await writeFile(join(root, 'alpha', 'SKILL.md'), 'new', 'utf8');

    const restored = await restoreFromTrash({ dshHome: home, id: (moved as { value: { id: string } }).value.id });
    assert.equal(restored.ok, false);
    assert.equal((restored as { error: { code: string } }).error.code, 'error.restore.occupied');
    assert.equal(await readFile(join(root, 'alpha', 'SKILL.md'), 'utf8'), 'new', 'the new file must be left alone');
    assert.equal((await readTrash(home)).entries.length, 1, 'the entry must stay so it can be restored later');
  } finally {
    await removeDir(home);
  }
});

test('emptying the trash removes the stored copies', async () => {
  const home = await makeTempDir();
  try {
    const { request } = await makeRoot(home);
    const moved = await moveToTrash({ dshHome: home, request });
    assert.equal(moved.ok, true);
    const stored = join(trashHome(home), (moved as { value: { storedName: string } }).value.storedName);
    assert.equal(existsSync(stored), true);

    const emptied = await emptyTrash(home);
    assert.equal(emptied.ok, true);
    assert.equal((emptied as { value: { removed: number } }).value.removed, 1);
    assert.equal(existsSync(stored), false, 'the stored copy must be gone');
    assert.equal((await readTrash(home)).entries.length, 0, 'the index must be empty');
  } finally {
    await removeDir(home);
  }
});

test('a flat skill file is moved as a file, not a directory', async () => {
  const home = await makeTempDir();
  try {
    const root = join(home, 'skills');
    await mkdir(root, { recursive: true });
    const file = join(root, 'flat.md');
    await writeFile(file, '---\nname: flat\ndescription: A flat skill.\n---\n\nBody.\n', 'utf8');

    const result = await moveToTrash({
      dshHome: home,
      request: { rootPath: root, rootKey: 'custom:0', scope: 'user', name: 'flat', path: file, kind: 'flat', loadable: true },
    });
    assert.equal(result.ok, true, 'a flat skill should move');
    assert.equal(existsSync(file), false, 'the file must be gone');
    const trash = await readTrash(home);
    assert.equal(existsSync(join(trashHome(home), trash.entries[0].storedName)), true, 'the file must be in the trash');
    assert.equal(trash.entries[0].kind, 'flat');
  } finally {
    await removeDir(home);
  }
});

test('a skill on another volume still moves into the trash', async (t) => {
  // The real failure this covers: the trash lives beside the state file in the DSH
  // home, while a profile can keep its skills on a different drive. `rename` cannot
  // cross volumes — on Windows it fails outright — so the move has to fall back to
  // copy-then-remove. The suite's temp home is on the system volume, so a skills
  // root placed elsewhere exercises exactly that path.
  const home = await makeTempDir();
  const other = await otherVolumeDir('cross-volume');
  if (other === undefined) {
    await removeDir(home);
    t.skip('this machine has a single volume, so the cross-volume path cannot run');
    return;
  }
  try {
    const root = join(other, 'skills');
    const bundle = join(root, 'cross-skill');
    await mkdir(bundle, { recursive: true });
    const contents = '---\nname: cross-skill\ndescription: On another drive.\n---\n\nBody.\n';
    await writeFile(join(bundle, 'SKILL.md'), contents, 'utf8');

    const result = await moveToTrash({
      dshHome: home,
      request: {
        rootPath: root,
        rootKey: 'custom:0',
        scope: 'user',
        name: 'cross-skill',
        path: join(bundle, 'SKILL.md'),
        kind: 'bundle',
        loadable: true,
      },
    });
    assert.equal(result.ok, true, `the move must survive a volume change: ${JSON.stringify((result as { error?: unknown }).error)}`);
    assert.equal(existsSync(bundle), false, 'the original must be gone');

    const trash = await readTrash(home);
    assert.equal(trash.entries.length, 1);
    const stored = join(trashHome(home), trash.entries[0].storedName, 'SKILL.md');
    assert.equal(existsSync(stored), true, 'the copy must be in the trash');
    assert.equal(await readFile(stored, 'utf8'), contents, 'the copy must be byte-identical');

    // And it must come back the same way.
    const restored = await restoreFromTrash({ dshHome: home, id: trash.entries[0].id });
    assert.equal(restored.ok, true, 'restoring across volumes must work too');
    assert.equal(await readFile(join(bundle, 'SKILL.md'), 'utf8'), contents, 'the restored file must be identical');
  } finally {
    await removeDir(home);
    await removeDir(other);
  }
});

test('a corrupt index degrades to an empty list with a warning', async () => {
  const home = await makeTempDir();
  try {
    await mkdir(trashHome(home), { recursive: true });
    await writeFile(trashIndexPath(home), '{ not json', 'utf8');
    const trash = await readTrash(home);
    assert.equal(trash.entries.length, 0);
    assert.equal(trash.warning?.code, 'warning.trash.corrupt', 'the panel must be told, not silently empty');
  } finally {
    await removeDir(home);
  }
});

test('a record that tries to escape the trash directory is ignored', async () => {
  const home = await makeTempDir();
  try {
    await mkdir(trashHome(home), { recursive: true });
    await writeFile(
      trashIndexPath(home),
      JSON.stringify({
        version: 1,
        entries: [
          { id: 'a', name: 'evil', rootKey: 'custom:0', originalPath: join(home, 'x'), storedName: '..\\..\\windows', kind: 'bundle', removedAt: '2026-01-01T00:00:00.000Z' },
          { id: 'b', name: 'ok', rootKey: 'custom:0', originalPath: join(home, 'y'), storedName: 'fine', kind: 'bundle', removedAt: '2026-01-01T00:00:00.000Z' },
        ],
      }),
      'utf8',
    );
    const trash = await readTrash(home);
    assert.equal(trash.entries.some((entry) => entry.name === 'evil'), false, 'a traversal record must be dropped');
    assert.equal(trash.entries.some((entry) => entry.name === 'ok'), true, 'valid records must survive');
  } finally {
    await removeDir(home);
  }
});

test('an unrecorded file in the trash is still reported', async () => {
  const home = await makeTempDir();
  try {
    const trashDir = trashHome(home);
    await mkdir(join(trashDir, 'orphan'), { recursive: true });
    await writeFile(join(trashDir, 'orphan', 'SKILL.md'), 'x', 'utf8');
    const trash = await readTrash(home);
    assert.equal(trash.entries.length, 1, 'an interrupted move must not be invisible');
    assert.equal(trash.entries[0]?.name, 'orphan');
  } finally {
    await removeDir(home);
  }
});
