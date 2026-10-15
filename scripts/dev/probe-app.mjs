/**
 * Diagnostic probe: mount the plugin on a real cordis application.
 *
 * The static probe showed `apply` does not throw on its own, so the failure has
 * to come from cordis's own mount semantics — an unavailable injected service, a
 * module shape cordis refuses, or an effect that misbehaves under a real fiber.
 * This runs the plugin through the actual runtime.
 *
 * @module scripts/probe-app
 */

import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { Context, Service } = require('@deepseek-ai/cordis');

const target = process.argv[2] ?? join(process.cwd(), 'lib', 'index.js');
const url = target.startsWith('file:') ? target : pathToFileURL(target).href;

/** One stub service so a declared injection can resolve. */
class Stub extends Service {
  constructor(ctx, name) {
    super(ctx, name, true);
    this.stubName = name;
  }
}

const app = new Context();

// Provide the services the plugin declares. `skills` and `webServer` are plain
// objects with the two methods the plugin calls; `sessions` mirrors the shape
// the plugin probes for.
app.provide('skills', {
  registerProvider(create) {
    create({ signal: new AbortController().signal, invalidate: () => undefined });
    return () => undefined;
  },
});
app.provide('webServer', {
  register(route) {
    return () => undefined;
  },
});
app.provide('sessions', { list: () => [] });

app.on('internal/error', (error) => {
  console.log('internal/error:', error?.message ?? String(error));
});

// Cordis 4 has no explicit start; plugins mount through `app.plugin()`.
const before = Date.now();
try {
  const module = await import(url);
  console.log('imported:', Object.keys(module).sort().join(', '));

  const fork = app.plugin(module.default ?? module, { name: 'probe' });
  console.log('plugin() returned:', typeof fork);
  console.log('fiber phase before wait:', String(fork?.state ?? fork?.status ?? 'unknown'));

  await new Promise((resolve) => setTimeout(resolve, 400));
  console.log('fiber state:', String(fork?.state ?? 'unknown'));
  if (typeof fork?.dispose === 'function') await fork.dispose();
  console.log('PROBE RESULT: mounted in', Date.now() - before, 'ms');
} catch (error) {
  console.log('PROBE RESULT: THREW');
  console.log('  name:', error?.constructor?.name);
  console.log('  message:', error?.message);
  console.log('  stack:', String(error?.stack).split('\n').slice(0, 14).join('\n'));
  process.exitCode = 1;
} finally {
  // Nothing to stop: cordis 4 disposes through the fork handle.
}
