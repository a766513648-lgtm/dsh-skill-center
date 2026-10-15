/**
 * End-to-end tests for the host half's browser API.
 *
 * The plugin is applied to a stand-in host context, then driven through fake
 * Node requests and responses. This exercises routing, the write guard, the
 * scan, the on/off rewrite on disk, and the state file together.
 *
 * @module test/hostApi.test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { makeTempDir, removeDir, writeBundle } from './helpers.mts';
import { makeZip } from './zipWriter.mts';

/** Load the built host half with `DSH_HOME` pointed at a throwaway directory. */
async function loadHost(home) {
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const module = await import(`${pathToFileURL(join(process.cwd(), 'lib', 'index.js')).href}?home=${encodeURIComponent(home)}`);
  return {
    module,
    restore() {
      if (previous === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = previous;
    },
  };
}

/**
 * Apply the plugin to a fake context and return the registered route handler.
 * @param module - the loaded host half.
 * @param options - an optional session working directory, so a project root appears.
 * @returns the route plus the recorded registrations.
 */
function applyWithFakeHost(module, options = {}) {
  const routes = [];
  const disposers = [];
  const providers = [];
  const effects = [];
  const sessions = options.sessionCwd === undefined
    ? { list: () => [] }
    : { list: () => [{ cwd: options.sessionCwd }], get: () => ({ cwd: options.sessionCwd }) };
  const ctx = {
    effect(factory, label) {
      effects.push(label);
      const dispose = factory();
      if (typeof dispose === 'function') disposers.push(dispose);
      return dispose;
    },
    skills: {
      registerProvider(create) {
        const control = { signal: new AbortController().signal, invalidate: () => undefined };
        providers.push(create(control));
        return () => undefined;
      },
    },
    webServer: {
      register(route) {
        routes.push(route);
        return () => undefined;
      },
    },
    sessions,
    logger: { info: () => undefined },
  };

  module.apply(ctx);
  assert.equal(routes.length, 1, 'exactly one API route must be registered');
  return { route: routes[0], providers, effects };
}

/** A fake request the handler can read as a Node stream. */
function fakeRequest({ method = 'GET', url = '/', headers = {}, body } = {}) {
  const listeners = new Map();
  const chunks = [];
  if (body !== undefined) chunks.push(Buffer.from(JSON.stringify(body), 'utf8'));
  const request = {
    method,
    url,
    headers,
    socket: { remoteAddress: '127.0.0.1' },
    on(event, handler) {
      listeners.set(event, handler);
      return this;
    },
    resume() {},
  };
  // Deliver the body after the handler has subscribed.
  queueMicrotask(() => {
    for (const chunk of chunks) listeners.get('data')?.(chunk);
    listeners.get('end')?.();
  });
  return request;
}

/** A fake response that records what the handler wrote. */
function fakeResponse() {
  const result = { status: undefined, headers: undefined, body: '' };
  return {
    result,
    writableEnded: false,
    destroyed: false,
    once() {},
    writeHead(status, headers) {
      result.status = status;
      result.headers = headers;
      return this;
    },
    end(payload) {
      this.writableEnded = true;
      if (typeof payload === 'string') result.body = payload;
      return this;
    },
  };
}

/** Issue one request and parse the JSON answer. */
async function call(route, options) {
  const request = fakeRequest(options);
  const response = fakeResponse();
  await route.handler(request, response);
  return { status: response.result.status, json: response.result.body === '' ? undefined : JSON.parse(response.result.body) };
}

/** Set up a DSH home with two skills and an applied plugin. */
async function setup(options = {}) {
  const home = await makeTempDir('skill-center-home-');
  await writeBundle(join(home, 'skills'), 'alpha-skill', { description: 'First skill.' });
  await writeBundle(join(home, 'skills'), 'beta-skill', { description: 'Second skill.' });
  const { module, restore } = await loadHost(home);
  const host = applyWithFakeHost(module, options);
  return { home, host, restore: () => restore(), module };
}

test('GET /state lists the skills of the global root', async () => {
  const { home, host, restore } = await setup();
  try {
    assert.equal(host.route.kind, 'prefix');
    assert.equal(host.route.path, '/api/skill-center');

    const { status, json } = await call(host.route, { url: '/api/skill-center/state' });
    assert.equal(status, 200);
    assert.equal(json.roots.length, 1);
    assert.equal(json.roots[0].key, 'dsh');
    assert.equal(json.roots[0].exists, true);
    assert.deepEqual(json.roots[0].skills.map((skill) => skill.name), ['alpha-skill', 'beta-skill']);
    assert.deepEqual(json.summary, { total: 2, disabled: 0, issues: 0 });
    assert.equal(json.warnings.length, 0);
  } finally {
    restore();
    await removeDir(home);
  }
});

test('POST /detail returns the body of one skill', async () => {
  const { home, host, restore } = await setup();
  try {
    const { status, json } = await call(host.route, {
      method: 'POST',
      url: '/api/skill-center/detail',
      headers: { 'x-skill-center': '1' },
      body: { rootKey: 'dsh', name: 'alpha-skill' },
    });
    assert.equal(status, 200);
    assert.equal(json.name, 'alpha-skill');
    assert.equal(json.description, 'First skill.');
    assert.equal(json.body, 'Follow these steps.');
    assert.match(json.frontmatter, /^---\n/);
    assert.equal(json.disabled, false);
    assert.equal(json.loadable, true);
  } finally {
    restore();
    await removeDir(home);
  }
});

test('POST /detail answers 404 for an unknown skill', async () => {
  const { home, host, restore } = await setup();
  try {
    const { status, json } = await call(host.route, {
      method: 'POST',
      url: '/api/skill-center/detail',
      headers: { 'x-skill-center': '1' },
      body: { rootKey: 'dsh', name: 'nope' },
    });
    assert.equal(status, 404);
    assert.equal(json.code, 'error.skill.notFound');
  } finally {
    restore();
    await removeDir(home);
  }
});

test('writes without the client marker are refused', async () => {
  const { home, host, restore } = await setup();
  try {
    const { status, json } = await call(host.route, {
      method: 'POST',
      url: '/api/skill-center/toggle',
      body: { rootKey: 'dsh', name: 'alpha-skill', disabled: true },
    });
    assert.equal(status, 403);
    assert.equal(json.code, 'error.request.forbidden');
  } finally {
    restore();
    await removeDir(home);
  }
});

test('unsupported methods are refused', async () => {
  const { home, host, restore } = await setup();
  try {
    const { status, json } = await call(host.route, { method: 'PUT', url: '/api/skill-center/state' });
    assert.equal(status, 405);
    assert.equal(json.code, 'error.request.method');
  } finally {
    restore();
    await removeDir(home);
  }
});

test('an unknown action answers 404', async () => {
  const { home, host, restore } = await setup();
  try {
    const { status, json } = await call(host.route, {
      method: 'POST',
      url: '/api/skill-center/nonsense',
      headers: { 'x-skill-center': '1' },
      body: {},
    });
    assert.equal(status, 404);
    assert.equal(json.code, 'error.request.unknownAction');
  } finally {
    restore();
    await removeDir(home);
  }
});

test('toggling a skill off rewrites the file and records the state', async () => {
  const { home, host, restore } = await setup();
  try {
    const off = await call(host.route, {
      method: 'POST',
      url: '/api/skill-center/toggle',
      headers: { 'x-skill-center': '1' },
      body: { rootKey: 'dsh', name: 'alpha-skill', disabled: true },
    });
    assert.equal(off.status, 200);
    assert.deepEqual(off.json, { name: 'alpha-skill', disabled: true, changed: true });

    const file = join(home, 'skills', 'alpha-skill', 'SKILL.md');
    const written = await readFile(file, 'utf8');
    assert.match(written, /disable-model-invocation: true/);
    assert.match(written, /user-invocable: false/);

    const state = JSON.parse(await readFile(join(home, 'skill-center', 'state.json'), 'utf8'));
    assert.deepEqual(state, { version: 1, roots: { dsh: ['alpha-skill'] } });

    const after = await call(host.route, { url: '/api/skill-center/state' });
    assert.deepEqual(after.json.summary, { total: 2, disabled: 1, issues: 0 });
    const alpha = after.json.roots[0].skills.find((skill) => skill.name === 'alpha-skill');
    assert.equal(alpha.disabled, true);

    // Switching it back on must restore the original document.
    const on = await call(host.route, {
      method: 'POST',
      url: '/api/skill-center/toggle',
      headers: { 'x-skill-center': '1' },
      body: { rootKey: 'dsh', name: 'alpha-skill', disabled: false },
    });
    assert.equal(on.status, 200);
    assert.equal(await readFile(file, 'utf8'), '---\nname: alpha-skill\ndescription: First skill.\n---\n\nFollow these steps.\n');
  } finally {
    restore();
    await removeDir(home);
  }
});

test('toggling refuses a skill DSH cannot load', async () => {
  const home = await makeTempDir('skill-center-bad-');
  try {
    const skills = join(home, 'skills');
    await writeBundle(skills, 'valid-one');
    const { writeFile: write, mkdir } = await import('node:fs/promises');
    await mkdir(join(skills, 'broken-one'), { recursive: true });
    await write(join(skills, 'broken-one', 'SKILL.md'), '---\nname: Bad Name\ndescription: x\n---\n\nbody\n', 'utf8');

    const { module, restore } = await loadHost(home);
    const host = applyWithFakeHost(module);
    try {
      const { status, json } = await call(host.route, {
        method: 'POST',
        url: '/api/skill-center/toggle',
        headers: { 'x-skill-center': '1' },
        body: { rootKey: 'dsh', name: 'broken-one', disabled: true },
      });
      assert.equal(status, 400);
      assert.equal(json.code, 'error.skill.notLoadable');
    } finally {
      restore();
    }
  } finally {
    await removeDir(home);
  }
});

test('the gating provider mirrors the skill set and honours the off flag', async () => {
  const { home, host, restore } = await setup();
  try {
    assert.equal(host.providers.length, 1);
    const provider = host.providers[0];
    assert.equal(provider.name, 'skill-center');

    const before = await provider.list({});
    assert.deepEqual(before.map((candidate) => candidate.name), ['alpha-skill', 'beta-skill']);
    assert.ok(before.every((candidate) => candidate.invocation.modelInvocable && candidate.invocation.userInvocable));
    assert.ok(before.every((candidate) => candidate.provider === 'skill-center'));
    assert.ok(before.every((candidate) => candidate.rank === 50), 'the gate must outrank the filesystem provider');

    const loaded = await provider.get(before[0], {});
    assert.equal(loaded.content, 'Follow these steps.');

    await call(host.route, {
      method: 'POST',
      url: '/api/skill-center/toggle',
      headers: { 'x-skill-center': '1' },
      body: { rootKey: 'dsh', name: 'alpha-skill', disabled: true },
    });

    const after = await provider.list({});
    const alpha = after.find((candidate) => candidate.name === 'alpha-skill');
    assert.equal(alpha.invocation.modelInvocable, false);
    assert.equal(alpha.invocation.userInvocable, false);
    const beta = after.find((candidate) => candidate.name === 'beta-skill');
    assert.equal(beta.invocation.modelInvocable, true);
  } finally {
    restore();
    await removeDir(home);
  }
});

test('POST /delete moves a skill into the trash, and /restore brings it back', async () => {
  const { home, host, restore } = await setup();
  try {
    const bundle = join(home, 'skills', 'alpha-skill');
    const before = await readFile(join(bundle, 'SKILL.md'), 'utf8');

    const deleted = await call(host.route, {
      method: 'POST',
      url: '/api/skill-center/delete',
      headers: { 'x-skill-center': '1' },
      body: { rootKey: 'dsh', name: 'alpha-skill' },
    });
    assert.equal(deleted.status, 200, `the delete should succeed, got ${JSON.stringify(deleted.json)}`);
    assert.equal(existsSync(bundle), false, 'the bundle must leave the root');

    // The panel's list must no longer offer it.
    const listed = await call(host.route, { url: '/api/skill-center/state' });
    assert.deepEqual(listed.json.roots[0].skills.map((skill) => skill.name), ['beta-skill']);

    // The trash must offer it for recovery.
    const trash = await call(host.route, { url: '/api/skill-center/trash' });
    assert.equal(trash.status, 200);
    assert.equal(trash.json.entries.length, 1);
    assert.equal(trash.json.entries[0].name, 'alpha-skill');

    const restored = await call(host.route, {
      method: 'POST',
      url: '/api/skill-center/restore',
      headers: { 'x-skill-center': '1' },
      body: { id: trash.json.entries[0].id },
    });
    assert.equal(restored.status, 200, 'the restore should succeed');
    assert.equal(await readFile(join(bundle, 'SKILL.md'), 'utf8'), before, 'the file must come back unchanged');
    assert.equal((await call(host.route, { url: '/api/skill-center/trash' })).json.entries.length, 0);
  } finally {
    restore();
    await removeDir(home);
  }
});

test('POST /delete refuses a skill that belongs to a project', async () => {
  const project = await makeTempDir('skill-center-project-');
  try {
    await writeBundle(join(project, '.dsh', 'skills'), 'project-skill', { description: 'Lives in a repo.' });
    const { home, host, restore } = await setup({ sessionCwd: project });
    try {
      const listed = await call(host.route, { url: '/api/skill-center/state' });
      const projectRoot = listed.json.roots.find((root) => root.scope === 'project');
      assert.ok(projectRoot !== undefined, 'the project root must be scanned');

      const refused = await call(host.route, {
        method: 'POST',
        url: '/api/skill-center/delete',
        headers: { 'x-skill-center': '1' },
        body: { rootKey: projectRoot.key, name: 'project-skill' },
      });
      assert.equal(refused.status, 400, 'a project skill must be refused');
      assert.equal(refused.json.code, 'error.delete.project');
      assert.equal(
        existsSync(join(project, '.dsh', 'skills', 'project-skill', 'SKILL.md')),
        true,
        'the repository copy must be untouched',
      );
    } finally {
      restore();
      await removeDir(home);
    }
  } finally {
    await removeDir(project);
  }
});

test('POST /empty-trash removes the stored copies', async () => {
  const { home, host, restore } = await setup();
  try {
    await call(host.route, {
      method: 'POST',
      url: '/api/skill-center/delete',
      headers: { 'x-skill-center': '1' },
      body: { rootKey: 'dsh', name: 'beta-skill' },
    });
    const emptied = await call(host.route, {
      method: 'POST',
      url: '/api/skill-center/empty-trash',
      headers: { 'x-skill-center': '1' },
      body: {},
    });
    assert.equal(emptied.status, 200);
    assert.equal(emptied.json.removed, 1);
    assert.equal((await call(host.route, { url: '/api/skill-center/trash' })).json.entries.length, 0);
  } finally {
    restore();
    await removeDir(home);
  }
});

test('POST /create writes a new skill into the configured root', async () => {
  const home = await makeTempDir('skill-center-home-');
  try {
    const hub = join(home, 'hub');
    await mkdir(join(home, 'profiles', 'desktop'), { recursive: true });
    await writeFile(
      join(home, 'profiles', 'desktop', 'cordis.patch.yml'),
      `- id: skill-filesystem\n  config:\n    customSkillDirs:\n      - '${hub}'\n`,
      'utf8',
    );
    await mkdir(hub, { recursive: true });

    const { module, restore } = await loadHost(home);
    try {
      const host = applyWithFakeHost(module);
      const created = await call(host.route, {
        method: 'POST',
        url: '/api/skill-center/create',
        headers: { 'x-skill-center': '1' },
        body: { name: 'My New Skill', description: 'Has "quotes" and: colons.', body: '# Steps\n\n1. Do it.' },
      });
      assert.equal(created.status, 200, 'creation should succeed');
      assert.equal(existsSync(join(hub, 'my-new-skill', 'SKILL.md')), true, 'the skill must land in the configured root');

      const written = await readFile(join(hub, 'my-new-skill', 'SKILL.md'), 'utf8');
      assert.match(written, /^---\nname: my-new-skill\n/, 'the name must be normalized and unquoted');
      assert.match(written, /description: "Has \\"quotes\\" and: colons\."/, 'the description must be escaped safely');
      assert.match(written, /\n---\n\n# Steps/, 'the body must follow the frontmatter');

      // It must be visible to the panel straight away.
      const listed = await call(host.route, { url: '/api/skill-center/state' });
      const names = listed.json.roots.flatMap((root) => root.skills.map((skill) => skill.name));
      assert.ok(names.includes('my-new-skill'), 'the new skill must appear in the list');
    } finally {
      restore();
    }
  } finally {
    await removeDir(home);
  }
});

test('POST /create refuses to overwrite an existing skill', async () => {
  const { home, host, restore } = await setup();
  try {
    const refused = await call(host.route, {
      method: 'POST',
      url: '/api/skill-center/create',
      headers: { 'x-skill-center': '1' },
      body: { name: 'alpha-skill', description: 'A duplicate.' },
    });
    assert.equal(refused.status, 400);
    assert.equal(refused.json.code, 'error.create.exists');
    assert.equal(
      await readFile(join(home, 'skills', 'alpha-skill', 'SKILL.md'), 'utf8'),
      '---\nname: alpha-skill\ndescription: First skill.\n---\n\nFollow these steps.\n',
      'the existing file must be untouched',
    );
  } finally {
    restore();
    await removeDir(home);
  }
});

test('POST /create requires a description', async () => {
  const { home, host, restore } = await setup();
  try {
    const refused = await call(host.route, {
      method: 'POST',
      url: '/api/skill-center/create',
      headers: { 'x-skill-center': '1' },
      body: { name: 'no-description' },
    });
    assert.equal(refused.status, 400);
    assert.equal(refused.json.code, 'error.create.description');
  } finally {
    restore();
    await removeDir(home);
  }
});

test('GET /roots offers exactly the directories a skill may be written to', async () => {
  const home = await makeTempDir('skill-center-home-');
  try {
    const hub = join(home, 'hub');
    await mkdir(join(home, 'profiles', 'desktop'), { recursive: true });
    await writeFile(
      join(home, 'profiles', 'desktop', 'cordis.patch.yml'),
      `- id: skill-filesystem\n  config:\n    customSkillDirs:\n      - '${hub}'\n`,
      'utf8',
    );
    await mkdir(hub, { recursive: true });

    const { module, restore } = await loadHost(home);
    try {
      const host = applyWithFakeHost(module);
      const { status, json } = await call(host.route, { url: '/api/skill-center/roots' });
      assert.equal(status, 200);
      // The configured root comes first — it is the preference — and the DSH default
      // is always available.
      assert.deepEqual(json.roots, [hub, join(home, 'skills')]);
    } finally {
      restore();
    }
  } finally {
    await removeDir(home);
  }
});

test('an unregistered destination is refused rather than written to', async () => {
  // The control lets the browser choose among directories the profile configured. It
  // must not become a way to write anywhere, so a path outside that list is refused
  // even though the request is otherwise well formed.
  const { home, host, restore } = await setup();
  const elsewhere = await makeTempDir('skill-center-elsewhere-');
  try {
    const refused = await call(host.route, {
      method: 'POST',
      url: '/api/skill-center/create',
      headers: { 'x-skill-center': '1' },
      body: { name: 'sneaky', description: 'Should not be written.', targetRoot: elsewhere },
    });
    assert.equal(refused.status, 400);
    assert.equal(refused.json.code, 'error.root.notAllowed');
    assert.equal(existsSync(join(elsewhere, 'sneaky')), false, 'nothing may be written outside the registered roots');
  } finally {
    restore();
    await removeDir(home);
    await removeDir(elsewhere);
  }
});

test('a chosen destination is honoured by both create and install', async () => {
  const home = await makeTempDir('skill-center-home-');
  try {
    const first = join(home, 'first-root');
    const second = join(home, 'second-root');
    await mkdir(join(home, 'profiles', 'desktop'), { recursive: true });
    await writeFile(
      join(home, 'profiles', 'desktop', 'cordis.patch.yml'),
      `- id: skill-filesystem\n  config:\n    customSkillDirs:\n      - '${first}'\n      - '${second}'\n`,
      'utf8',
    );
    await mkdir(first, { recursive: true });
    await mkdir(second, { recursive: true });

    const { module, restore } = await loadHost(home);
    try {
      const host = applyWithFakeHost(module);
      const listed = await call(host.route, { url: '/api/skill-center/roots' });
      // The configured roots first, in their own order, then the DSH default, which is
      // always somewhere a skill may legitimately live.
      assert.deepEqual(
        listed.json.roots,
        [first, second, join(home, 'skills')],
        'every writable root is offered, configured ones first',
      );

      const created = await call(host.route, {
        method: 'POST',
        url: '/api/skill-center/create',
        headers: { 'x-skill-center': '1' },
        body: { name: 'second-choice', description: 'Goes to the second root.', targetRoot: second },
      });
      assert.equal(created.status, 200, `create failed: ${JSON.stringify(created.json)}`);
      assert.equal(existsSync(join(second, 'second-choice', 'SKILL.md')), true, 'the chosen root must receive it');
      assert.equal(existsSync(join(first, 'second-choice')), false, 'the first root must stay untouched');

      // The same choice must drive an install. The download is stubbed so the test
      // exercises the destination rather than the network.
      const originalFetch = globalThis.fetch;
      const payload = makeZip([{ name: 'picked/SKILL.md', contents: '---\nname: picked\ndescription: Installed into the chosen root.\n---\n\nbody\n' }]);
      globalThis.fetch = async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: { get: (name: string) => (String(name).toLowerCase() === 'content-length' ? String(payload.length) : null) },
        arrayBuffer: async () => payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength),
      });
      let installed;
      try {
        installed = await call(host.route, {
          method: 'POST',
          url: '/api/skill-center/install',
          headers: { 'x-skill-center': '1' },
          body: { url: 'https://example.com/skill.zip', targetRoot: second },
        });
      } finally {
        globalThis.fetch = originalFetch;
      }
      assert.equal(installed.status, 200, `install failed: ${JSON.stringify(installed.json)}`);
      assert.equal(existsSync(join(second, 'picked', 'SKILL.md')), true, 'the install must land in the chosen root');
      assert.equal(existsSync(join(first, 'picked')), false, 'and not in the default one');
    } finally {
      restore();
    }
  } finally {
    await removeDir(home);
  }
});
