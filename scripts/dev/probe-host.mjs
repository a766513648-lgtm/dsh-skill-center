/**
 * Diagnostic probe: mount the built host half on a minimal cordis host and
 * report exactly what `apply` does, including any thrown error.
 *
 * The fake context records how it is driven, so a mismatch between the API this
 * plugin uses and the API cordis actually provides shows up as the real
 * exception instead of a generic "failed to activate".
 *
 * @module scripts/probe-host
 */

import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const target = process.argv[2] ?? join(process.cwd(), 'lib', 'index.js');
const url = target.startsWith('file:') ? target : pathToFileURL(target).href;

const module = await import(url);
console.log('exports:', Object.keys(module).sort().join(', '));
console.log('name:', module.name, '| inject:', JSON.stringify(module.inject));

const calls = [];
const ctx = {
  effect(factory, label) {
    calls.push(`effect(${String(label)})`);
    const dispose = factory();
    return dispose;
  },
  on(event, handler) {
    calls.push(`on(${event})`);
    return () => undefined;
  },
  emit(event) {
    calls.push(`emit(${event})`);
  },
  get(name) {
    calls.push(`get(${name})`);
    return undefined;
  },
  skills: {
    registerProvider(create) {
      calls.push('skills.registerProvider');
      create({ signal: new AbortController().signal, invalidate: () => undefined });
      return () => undefined;
    },
  },
  webServer: {
    register(route) {
      calls.push(`webServer.register(${route.kind} ${route.path})`);
      return () => undefined;
    },
  },
  sessions: { list: () => [] },
};

try {
  const result = module.apply(ctx);
  console.log('apply returned:', result === undefined ? 'undefined' : typeof result);
  if (result !== null && typeof result === 'object' && typeof result.then === 'function') {
    await result;
    console.log('apply promise resolved');
  }
  console.log('calls observed:');
  for (const call of calls) console.log('  -', call);
  console.log('PROBE RESULT: apply completed without throwing');
} catch (error) {
  console.log('PROBE RESULT: apply THREW');
  console.log('  name:', error?.constructor?.name);
  console.log('  message:', error?.message);
  console.log('  stack:', String(error?.stack).split('\n').slice(0, 12).join('\n'));
  process.exitCode = 1;
}
