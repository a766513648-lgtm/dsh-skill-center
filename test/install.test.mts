/**
 * Tests for the ZIP reader and the URL installer.
 *
 * Fixtures are built by `zipWriter` rather than by the reader, and downloads are
 * intercepted by replacing `globalThis.fetch`, so nothing here depends on the
 * network and no assertion is circular.
 *
 * @module test/install.test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readZip } from '../src/core/zip.ts';
import { installFromUrl } from '../src/core/install.ts';
import { makeDirAt, makeTempDir, removeDir } from './helpers.mts';
import { makeZip } from './zipWriter.mts';

/** A valid skill document. */
function skillDoc(name: string, description = 'A skill.'): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\nBody for ${name}.\n`;
}

/** Run one install with `fetch` stubbed to answer with fixed bytes. */
async function installWith(
  body: Buffer | string,
  options: { url: string; targetRoot: string; existingNames?: string[]; contentType?: string; status?: number },
) {
  const payload = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    // A bare repository link first asks the API for the default branch; answer that
    // so the archive request can be checked.
    if (url.startsWith('https://api.github.com/repos/')) {
      const body = Buffer.from(JSON.stringify({ default_branch: 'main' }), 'utf8');
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: { get: (name) => (String(name).toLowerCase() === 'content-type' ? 'application/json' : null) },
        json: async () => JSON.parse(body.toString('utf8')),
        arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
      };
    }
    const status = options.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 404 ? 'Not Found' : 'OK',
      headers: {
        get: (name) => {
          const lower = String(name).toLowerCase();
          if (lower === 'content-type') return options.contentType ?? 'application/octet-stream';
          if (lower === 'content-length') return String(payload.length);
          return null;
        },
      },
      json: async () => {
        throw new Error('not JSON');
      },
      arrayBuffer: async () => payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength),
    };
  });
  try {
    const result = await installFromUrl({
      url: options.url,
      targetRoot: options.targetRoot,
      existingNames: options.existingNames ?? [],
    });
    return { result, calls };
  } finally {
    globalThis.fetch = original;
  }
}

test('the ZIP reader recovers stored and deflated entries', () => {
  const archive = makeZip([
    { name: 'bundle/SKILL.md', contents: skillDoc('bundle-skill') },
    { name: 'bundle/notes.txt', contents: 'compressed hello', deflate: true },
    { name: 'bundle/', contents: '' },
  ]);

  const read = readZip(archive);
  assert.equal(read.ok, true, `the archive should read: ${JSON.stringify((read as { error?: unknown }).error)}`);
  const entries = (read as { entries: { name: string; data: Buffer }[] }).entries;
  assert.deepEqual(entries.map((entry) => entry.name), ['bundle/SKILL.md', 'bundle/notes.txt'], 'directories are skipped');
  assert.equal(entries[0]?.data.toString('utf8'), skillDoc('bundle-skill'));
  assert.equal(entries[1]?.data.toString('utf8'), 'compressed hello', 'the deflated entry must round-trip');
});

test('the ZIP reader reports a corrupted archive instead of returning junk', () => {
  const archive = makeZip([{ name: 'a.txt', contents: 'hello' }]);
  // Flip a byte inside the stored data; the checksum must catch it.
  const damaged = Buffer.from(archive);
  const position = damaged.indexOf(Buffer.from('hello'));
  damaged[position] = 0x68 + 1;

  const read = readZip(damaged);
  assert.equal(read.ok, false);
  assert.equal((read as { error: { code: string } }).error.code, 'error.zip.crc');
});

test('a repository archive installs the skill it contains', async () => {
  const target = await makeTempDir('skill-center-target-');
  try {
    const archive = makeZip([
      { name: 'repo-main/SKILL.md', contents: skillDoc('from-repo', 'Installed from a repository.') },
      { name: 'repo-main/reference.md', contents: 'extra material' },
      { name: 'repo-main/README.md', contents: 'not a skill' },
    ]);

    const { result, calls } = await installWith(archive, {
      url: 'https://github.com/owner/repo',
      targetRoot: target,
    });

    assert.equal(result.ok, true, `install failed: ${JSON.stringify((result as { error?: unknown }).error)}`);
    const skills = (result as { skills: { name: string; files: number; source: string }[] }).skills;
    assert.equal(skills.length, 1, 'the wrapper folder must be stripped, leaving one skill');
    assert.equal(skills[0]?.name, 'from-repo');
    assert.equal(skills[0]?.source, 'repository');
    assert.equal(existsSync(join(target, 'from-repo', 'SKILL.md')), true);
    assert.equal(existsSync(join(target, 'from-repo', 'reference.md')), true, 'files beside SKILL.md come along');
    assert.match(calls[0]?.url ?? '', /api\.github\.com\/repos\/owner\/repo$/, 'a bare repository link resolves its default branch first');
    assert.match(calls[1]?.url ?? '', /codeload\.github\.com\/owner\/repo\/zip\/refs\/heads\/main$/, 'the archive is then fetched for that branch');
  } finally {
    await removeDir(target);
  }
});

test('a tree link narrows the install to one folder', async () => {
  const target = await makeTempDir('skill-center-target-');
  try {
    const archive = makeZip([
      { name: 'repo-main/README.md', contents: 'x' },
      { name: 'repo-main/skills/wanted/SKILL.md', contents: skillDoc('wanted', 'The one that was asked for.') },
      { name: 'repo-main/skills/other/SKILL.md', contents: skillDoc('other', 'Not asked for.') },
    ]);

    const { result } = await installWith(archive, {
      url: 'https://github.com/owner/repo/tree/main/skills/wanted',
      targetRoot: target,
    });

    assert.equal(result.ok, true, `install failed: ${JSON.stringify((result as { error?: unknown }).error)}`);
    const skills = (result as { skills: { name: string }[] }).skills;
    assert.deepEqual(skills.map((skill) => skill.name), ['wanted'], 'only the requested folder is installed');
  } finally {
    await removeDir(target);
  }
});

test('an archive escapes nothing when entries try to traverse', async () => {
  const target = await makeTempDir('skill-center-target-');
  const outside = await makeTempDir('skill-center-outside-');
  try {
    const archive = makeZip([
      { name: 'evil/SKILL.md', contents: skillDoc('evil', 'Legitimate skill.') },
      { name: '../../escaped.txt', contents: 'should never be written' },
      { name: 'evil/../../../escaped-deep.txt', contents: 'nor this' },
    ]);

    const { result } = await installWith(archive, { url: 'https://example.com/skill.zip', targetRoot: target });
    assert.equal(result.ok, true, `the legitimate part should still install: ${JSON.stringify((result as { error?: unknown }).error)}`);
    assert.equal(existsSync(join(outside, 'escaped.txt')), false);
    assert.equal(existsSync(join(target, '..', 'escaped.txt')), false, 'no traversal entry may land beside the target');
    assert.equal(existsSync(join(target, 'evil', 'SKILL.md')), true);
    const skipped = (result as { skipped: number }).skipped;
    assert.ok(skipped >= 2, `traversal entries must be counted as skipped, got ${String(skipped)}`);
  } finally {
    await removeDir(target);
    await removeDir(outside);
  }
});

test('a raw SKILL.md link installs a one-file bundle', async () => {
  const target = await makeTempDir('skill-center-target-');
  try {
    const { result } = await installWith(skillDoc('single-skill', 'From a raw file.'), {
      url: 'https://raw.githubusercontent.com/owner/repo/main/SKILL.md',
      targetRoot: target,
      contentType: 'text/plain',
    });
    assert.equal(result.ok, true, `install failed: ${JSON.stringify((result as { error?: unknown }).error)}`);
    assert.equal((result as { skills: { source: string }[] }).skills[0]?.source, 'document');
    assert.equal(await readFile(join(target, 'single-skill', 'SKILL.md'), 'utf8'), skillDoc('single-skill', 'From a raw file.'));
  } finally {
    await removeDir(target);
  }
});

test('an HTML page is refused with advice instead of being written as a skill', async () => {
  const target = await makeTempDir('skill-center-target-');
  try {
    const { result } = await installWith('<!doctype html><html><body>a web page</body></html>', {
      url: 'https://example.com/some-skill',
      targetRoot: target,
      contentType: 'text/html',
    });
    assert.equal(result.ok, false);
    assert.equal((result as { error: { code: string } }).error.code, 'error.install.html');
  } finally {
    await removeDir(target);
  }
});

test('an install refuses to overwrite an installed skill', async () => {
  const target = await makeTempDir('skill-center-target-');
  try {
    await mkdir(join(target, 'taken'), { recursive: true });
    await writeFile(join(target, 'taken', 'SKILL.md'), skillDoc('taken', 'The original.'), 'utf8');

    const archive = makeZip([{ name: 'taken/SKILL.md', contents: skillDoc('taken', 'The replacement.') }]);
    const { result } = await installWith(archive, {
      url: 'https://example.com/skill.zip',
      targetRoot: target,
      existingNames: ['taken'],
    });

    assert.equal(result.ok, false);
    assert.equal((result as { error: { code: string } }).error.code, 'error.install.exists');
    assert.equal(
      await readFile(join(target, 'taken', 'SKILL.md'), 'utf8'),
      skillDoc('taken', 'The original.'),
      'the installed skill must be untouched',
    );
  } finally {
    await removeDir(target);
  }
});

test('an archive with no SKILL.md is refused', async () => {
  const target = await makeTempDir('skill-center-target-');
  try {
    const archive = makeZip([{ name: 'docs/README.md', contents: 'nothing to see' }]);
    const { result } = await installWith(archive, { url: 'https://example.com/notaskill.zip', targetRoot: target });
    assert.equal(result.ok, false);
    assert.equal((result as { error: { code: string } }).error.code, 'error.install.noSkill');
  } finally {
    await removeDir(target);
  }
});

test('a skill whose name DSH cannot load is refused', async () => {
  const target = await makeTempDir('skill-center-target-');
  try {
    const archive = makeZip([{ name: 'x/SKILL.md', contents: '---\nname: Not_Kebab\ndescription: Bad name.\n---\n\nBody.\n' }]);
    const { result } = await installWith(archive, { url: 'https://example.com/bad.zip', targetRoot: target });
    assert.equal(result.ok, false);
    assert.equal((result as { error: { code: string } }).error.code, 'error.install.name');
  } finally {
    await removeDir(target);
  }
});

test('a skill without a description is refused, because DSH requires one', async () => {
  const target = await makeTempDir('skill-center-target-');
  try {
    const archive = makeZip([{ name: 'x/SKILL.md', contents: '---\nname: no-description\n---\n\nBody.\n' }]);
    const { result } = await installWith(archive, { url: 'https://example.com/nod.zip', targetRoot: target });
    assert.equal(result.ok, false);
    assert.equal((result as { error: { code: string } }).error.code, 'error.install.description');
  } finally {
    await removeDir(target);
  }
});

test('a local address is refused before any request is made', async () => {
  const target = await makeTempDir('skill-center-target-');
  try {
    const { result, calls } = await installWith('nope', {
      url: 'http://127.0.0.1:8080/skill.zip',
      targetRoot: target,
    });
    assert.equal(result.ok, false);
    assert.equal((result as { error: { code: string } }).error.code, 'error.install.local');
    assert.equal(calls.length, 0, 'a refused address must not be fetched');
  } finally {
    await removeDir(target);
  }
});

test('a non-http scheme is refused', async () => {
  const target = await makeTempDir('skill-center-target-');
  try {
    const { result } = await installWith('nope', { url: 'file:///C:/secret/SKILL.md', targetRoot: target });
    assert.equal(result.ok, false);
    assert.equal((result as { error: { code: string } }).error.code, 'error.install.scheme');
  } finally {
    await removeDir(target);
  }
});

test('a not-found response is reported as a status problem', async () => {
  const target = await makeTempDir('skill-center-target-');
  try {
    const { result } = await installWith('missing', {
      url: 'https://example.com/gone.zip',
      targetRoot: target,
      status: 404,
    });
    assert.equal(result.ok, false);
    assert.equal((result as { error: { code: string } }).error.code, 'error.install.status');
  } finally {
    await removeDir(target);
  }
});

test('the install target is created when it does not exist yet', async () => {
  const base = await makeTempDir('skill-center-base-');
  const target = join(base, 'not-yet');
  try {
    const archive = makeZip([{ name: 'fresh/SKILL.md', contents: skillDoc('fresh') }]);
    const { result } = await installWith(archive, { url: 'https://example.com/fresh.zip', targetRoot: target });
    assert.equal(result.ok, true, `install failed: ${JSON.stringify((result as { error?: unknown }).error)}`);
    assert.equal(existsSync(join(target, 'fresh', 'SKILL.md')), true);
  } finally {
    await removeDir(base);
  }
});

test('an install into a real skills root is visible to a scan', async () => {
  // Guards the property the panel depends on: what an install writes is what the
  // scanner then reads, with no second registration step. A temporary directory is
  // enough — the rooted-path handling is covered by the cross-volume test in the
  // trash suite — so this does not need a second drive.
  const home = await makeTempDir('skill-center-home-');
  const hub = await makeDirAt(join(await makeTempDir('skill-center-hub-'), 'root'));
  try {
    const archive = makeZip([{ name: 'hub/SKILL.md', contents: skillDoc('scan-visible', 'Should appear in a scan.') }]);
    const { result } = await installWith(archive, { url: 'https://example.com/hub.zip', targetRoot: hub });
    assert.equal(result.ok, true, `install failed: ${JSON.stringify((result as { error?: unknown }).error)}`);

    const { scanSkills } = await import('../src/core/scan.ts');
    const scan = await scanSkills({ dshHome: home, extraRoots: [hub] });
    const names = scan.roots.flatMap((root) => root.skills.map((skill) => skill.name));
    assert.ok(names.includes('scan-visible'), `the installed skill must be scannable, saw ${names.join(', ')}`);
  } finally {
    await removeDir(home);
    await removeDir(hub);
  }
});
