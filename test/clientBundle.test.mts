/**
 * Executes the built browser half inside a stand-in for the Web client's module
 * system, so a broken internal module reference fails here instead of as a blank
 * settings page in the browser.
 *
 * @module test/clientBundle.test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
const React = require('react');

/** Stand-ins for the libraries the shell hands a client plugin through its import map. */
function shellStubs() {
  const react = require('react');
  return {
    react,
    'react/jsx-runtime': require('react/jsx-runtime'),
    '@deepseek-ai/dsh-client-ui-primitives': new Proxy({}, {
      get: (_target, name) => {
        if (name === '__esModule') return true;
        if (name === 'Modal') {
          // The real Modal returns null while closed; a stub that always
          // rendered would hide the difference between "opened" and "not".
          return (props) => (props?.open === true
            ? react.createElement('div', { 'data-primitive': 'Modal' }, props.children ?? null)
            : null);
        }
        // Any other primitive renders as an inert element so the bundle only has
        // to resolve and call it.
        return (props) => react.createElement('div', { 'data-primitive': String(name) }, props?.children ?? null);
      },
    }),
    '@deepseek-ai/dsh-client-ui-slots': {},
    '@deepseek-ai/dsh-client-locale': {},
  };
}

/**
 * Load the built client bundle with a recorded module loader.
 * @returns the registrations the bundle made and the ids it required.
 */
function loadClientBundle() {
  const source = readFileSync(join(root, 'lib', 'client.js'), 'utf8');
  const registrations = [];
  const required = new Set();
  const stubs = shellStubs();

  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(row) {
          registrations.push(row);
        },
      },
    },
    // Shared globals the shell provides.
    React: stubs.react,
    console,
    setTimeout,
    clearTimeout,
    queueMicrotask,
    Promise,
    Symbol,
    URL,
    fetch: () => Promise.reject(new Error('no network in this test')),
  };
  sandbox.globalThis = sandbox;

  const context = vm.createContext(sandbox);
  new vm.Script(source, { filename: 'lib/client.js' }).runInContext(context);

  return { registrations, required, stubs, source };
}

test('the bundle registers exactly one module under the package name', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const { registrations } = loadClientBundle();
  assert.equal(registrations.length, 1);
  assert.equal(registrations[0]?.id, manifest.name);
  assert.equal(typeof registrations[0]?.factory, 'function');
});

test('the factory materialises the plugin face without touching the host shell', () => {
  const { registrations, stubs } = loadClientBundle();
  const row = registrations[0];
  const provided = new Set();
  const requireFromShell = (specifier) => {
    provided.add(specifier);
    if (specifier in stubs) return stubs[specifier];
    throw new Error(`unexpected external require: ${specifier}`);
  };

  const face = row.factory(requireFromShell);
  assert.equal(typeof face.apply, 'function');
  assert.deepEqual([...face.inject].sort(), ['locale', 'slots']);
  assert.ok(provided.size > 0, 'the bundle must resolve its shared libraries through the shell');
  for (const specifier of provided) {
    assert.ok(specifier in stubs, `${specifier} is not a declared shared library`);
  }
});

test('applying the plugin registers dictionaries and one settings section', (t) => {
  const { registrations, stubs, source } = loadClientBundle();

  // The minimal variant only proves the client module machinery can load this
  // bundle; it carries no page state, so the page-specific expectations below do
  // not apply to it. `scripts/probe-client.mjs` covers that variant instead.
  if (source.includes('skill-center/minimal')) {
    t.skip('minimal diagnostic variant: no page state to inject');
    return;
  }

  const face = registrations[0].factory((specifier) => {
    if (specifier in stubs) return stubs[specifier];
    throw new Error(`unexpected external require: ${specifier}`);
  });

  const effects = [];
  const registrationsMade = [];
  const waited = [];
  const ctx = {
    effect(factory, label) {
      effects.push(label);
      const dispose = factory();
      if (typeof dispose === 'function') effects.push(`${label}:disposer`);
      return dispose;
    },
    locale: {
      bind: (namespace) => (key) => `${namespace}:${key}`,
      register: (namespace, dicts) => {
        registrationsMade.push({ kind: 'locale', namespace, locales: Object.keys(dicts) });
        return () => undefined;
      },
    },
    slots: {
      // The real contract: contribute only after the declaring plugin exists.
      // A stub that ran the callback eagerly would hide exactly the race that
      // "slot ... is not declared" comes from.
      inject(key, callback) {
        waited.push(key);
        const dispose = callback();
        return () => {
          if (typeof dispose === 'function') dispose();
        };
      },
      register: (options, component) => {
        registrationsMade.push({ kind: 'slot', options, component });
        return () => undefined;
      },
    },
  };

  face.apply(ctx);

  const locale = registrationsMade.find((item) => item.kind === 'locale');
  assert.deepEqual(locale, { kind: 'locale', namespace: 'settings.skillCenter', locales: ['zh', 'en'] });

  // A page must wait for the shell to declare its slots rather than registering
  // straight away, or activation races and throws. Both entry points are
  // contributions into slots another plugin declares.
  assert.deepEqual(
    [...waited].sort(),
    ['conversation.input.left', 'settings.section'],
    'both entry points must be contributed through slots.inject',
  );

  const slot = registrationsMade.find((item) => item.kind === 'slot' && item.options.name === 'settings.section');
  assert.equal(slot?.options.name, 'settings.section');
  assert.equal(slot?.options.id, 'skill-center');
  assert.equal(typeof slot?.options.label(), 'string');
  assert.equal(typeof slot?.component, 'function');

  // The real page carries a store and a translator for its slot to inject.
  const injected = slot?.options.inject();
  assert.equal(typeof injected?.store?.load, 'function');
  assert.equal(typeof injected?.t, 'function');

  // The composer button shares that same store, so both views cannot disagree.
  const button = registrationsMade.find((item) => item.kind === 'slot' && item.options.name === 'conversation.input.left');
  assert.equal(button?.options.id, 'skill-center-button');
  assert.equal(button?.options.order, 10, 'the button sits first in the left lane');
  assert.equal(typeof button?.component, 'function');
  const buttonFace = button?.options.inject();
  assert.equal(buttonFace?.store, injected?.store, 'the button must reuse the section store');

  // Tearing down the fiber must dispose the dictionary effect.
  assert.ok(effects.some((label) => String(label).includes('skill-center')), 'effects must be labelled');
});

test('the composer button renders its label', async (t) => {
  const { registrations, stubs, source } = loadClientBundle();
  if (source.includes('skill-center/minimal')) {
    t.skip('minimal diagnostic variant: no page to drive');
    return;
  }
  const face = registrations[0].factory((specifier) => {
    if (specifier in stubs) return stubs[specifier];
    throw new Error(`unexpected external require: ${specifier}`);
  });

  const made = [];
  const ctx = {
    effect: (factory) => factory(),
    locale: {
      bind: (namespace) => (key) => `${namespace}:${key}`,
      register: (namespace, dicts) => {
        made.push({ kind: 'locale', namespace, dicts });
        return () => undefined;
      },
    },
    slots: {
      inject: (_key, callback) => callback(),
      register: (options, component) => {
        made.push({ kind: 'slot', options, component });
        return () => undefined;
      },
    },
  };
  face.apply(ctx);

  const entry = made.find((item) => item.kind === 'slot' && item.options.name === 'conversation.input.left');
  assert.ok(entry !== undefined, 'the composer button must be registered');

  const { renderToStaticMarkup } = await import('react-dom/server');
  const html = renderToStaticMarkup(React.createElement(entry.component, entry.options.inject()));

  // The button shows its localized label; the modal stays closed until a click.
  assert.match(html, /settings\.skillCenter:openButton/, 'the button must render its localized label');
  assert.doesNotMatch(html, /data-primitive="Modal"/, 'the modal must not render before it is opened');
});

test('the modal hosts the real page, sharing the section store', async (t) => {
  const { registrations, stubs, source } = loadClientBundle();
  if (source.includes('skill-center/minimal')) {
    t.skip('minimal diagnostic variant: no page to drive');
    return;
  }
  const face = registrations[0].factory((specifier) => {
    if (specifier in stubs) return stubs[specifier];
    throw new Error(`unexpected external require: ${specifier}`);
  });

  const made = [];
  const ctx = {
    effect: (factory) => factory(),
    locale: {
      bind: (namespace) => (key) => `${namespace}:${key}`,
      register: (namespace, dicts) => {
        made.push({ kind: 'locale', namespace, dicts });
        return () => undefined;
      },
    },
    slots: {
      inject: (_key, callback) => callback(),
      register: (options, component) => {
        made.push({ kind: 'slot', options, component });
        return () => undefined;
      },
    },
  };
  face.apply(ctx);

  const button = made.find((item) => item.kind === 'slot' && item.options.name === 'conversation.input.left');
  const section = made.find((item) => item.kind === 'slot' && item.options.name === 'settings.section');
  const { renderToStaticMarkup } = await import('react-dom/server');

  // Render the page the modal hosts, with the section's own injected face: this
  // is the composition the button reveals.
  const page = renderToStaticMarkup(React.createElement(section.component, section.options.inject()));
  assert.match(page, /settings\.skillCenter:title/, 'the hosted page is the Skill Center');
  assert.match(page, /settings\.skillCenter:description/, 'the hosted page keeps its description');

  // Both entry points were handed the same store object.
  assert.equal(button.options.inject().store, section.options.inject().store);
});
