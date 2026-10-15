/**
 * Checks for the panel's scrollbar styling.
 *
 * The stylesheet is a module constant because `style` attributes cannot address a
 * `::-webkit-scrollbar` pseudo-element, so it is asserted directly here rather than
 * scraped out of a render. The scroll container's own inline styles are checked
 * against rendered markup, because a container with no bounded height never
 * scrolls and would never show a bar at all.
 *
 * @module test/clientScroll.test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { ensureScrollStyles, SCROLLBAR_CSS, SCROLL_CLASS } from '../src/client/scrollStyles.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
const React = require('react');

test('the scrollbar stylesheet styles the thumb and inverts with the theme', () => {
  const css = SCROLLBAR_CSS;

  assert.match(css, new RegExp(`\\.${SCROLL_CLASS}::-webkit-scrollbar\\b`), 'the scrollbar must be sized');
  assert.match(css, /width:\s*12px/, 'the bar must be comfortably wider than the Host overlay default');
  assert.match(css, /::-webkit-scrollbar-track/, 'the track must be styled, or the bar reads as missing');
  assert.match(css, /::-webkit-scrollbar-thumb/, 'the thumb must be styled');
  assert.match(css, /scrollbar-width:\s*thin/, 'the standard property must be set too');

  // The themed label token leads, because the Host's scrollbar palette is a dark
  // grey in dark mode and nearly vanishes against a dark panel.
  const thumbRule = /\.skill-center-scroll::-webkit-scrollbar-thumb \{[\s\S]*?\}/.exec(css);
  assert.ok(thumbRule !== null, 'the thumb rule must exist');
  assert.match(thumbRule[0], /--dsw-alias-label-tertiary/, 'the inverting label token must come first');
  assert.match(thumbRule[0], /--dsh-scrollbar-thumb/, 'the Host scrollbar variable must still be honoured');
  assert.match(thumbRule[0], /--dsw-alias-scrollbar-bg-l1/, 'and its alias too');

  const dark = /@media \(prefers-color-scheme: dark\) \{[\s\S]*?background-color:\s*([^;]+);/.exec(css);
  const light = /@media \(prefers-color-scheme: light\) \{[\s\S]*?background-color:\s*([^;]+);/.exec(css);
  assert.ok(dark !== null, 'a dark-mode default must exist');
  assert.ok(light !== null, 'a light-mode default must exist');
  assert.notEqual(dark[1], light[1], 'light and dark must not resolve to the same colour');
  // Inverted contrast is the point: a light thumb on dark, a dark thumb on light.
  assert.match(dark[1], /rgba\(2[0-9]{2},/, 'the dark-mode default must be a light colour');
  assert.match(light[1], /rgba\(6[0-9],/, 'the light-mode default must be a dark colour');
});

test('the stylesheet is attached once, even from several mounts', () => {
  const attached = [];
  const present = new Set();
  const fakeDocument = {
    getElementById: (id) => (present.has(id) ? { id } : null),
    createElement: () => ({ id: '', textContent: '' }),
    head: {
      appendChild: (node) => {
        attached.push(node);
        present.add(node.id);
      },
    },
  };

  const globals = globalThis;
  const previous = globals.document;
  let first;
  let second;
  let third;
  try {
    globals.document = fakeDocument;
    first = ensureScrollStyles();
    second = ensureScrollStyles();
    third = ensureScrollStyles();
  } finally {
    globals.document = previous;
  }

  assert.equal(attached.length, 1, 'the stylesheet must be attached exactly once');
  assert.equal(attached[0].textContent, SCROLLBAR_CSS, 'the attached text must be the stylesheet');
  assert.match(first, /^attached \d+ chars/, 'the first call must report a real attachment');
  assert.equal(second, 'already attached', 'later calls must be no-ops');
  assert.equal(third, 'already attached');
});

test('the skill list is a bounded, scrollable container', async (t) => {
  const html = await renderSectionMarkup();
  if (html === undefined) {
    t.skip('minimal diagnostic variant: no page to measure');
    return;
  }

  const marker = `class="${SCROLL_CLASS}"`;
  const at = html.indexOf(marker);
  assert.ok(at >= 0, 'the list must carry the scroll class');

  const styleStart = html.indexOf('style="', at);
  const styleEnd = html.indexOf('"', styleStart + 7);
  const style = html.slice(styleStart + 7, styleEnd);

  assert.match(style, /overflow-y:\s*auto/, 'the list must scroll vertically');
  assert.match(style, /min-height:\s*0/, 'a flex child needs min-height:0 to be allowed to shrink');
  assert.match(style, /flex:\s*1/, 'the list must take the space its parent leaves');
  assert.match(style, /scrollbar-width:\s*thin/, 'the inline fallback must ride along');
  assert.match(style, /scrollbar-color:/, 'the inline fallback colour must too');

  // The assertive part. `flex: 1` only scrolls when an ancestor resolves a height,
  // and inside another plugin's modal that is not guaranteed: measured in Chromium,
  // the card computed `max-height: none`, grew past the viewport, and clipped a list
  // that had grown to its full content height — a list that could not be scrolled.
  // A viewport cap makes the list a scroll container on its own.
  assert.match(style, /max-height:\s*\d+vh/, 'the list needs its own viewport cap to be reliably scrollable');
});

test('the page actually renders the URL install row', async (t) => {
  const html = await renderSectionMarkup();
  if (html === undefined) {
    t.skip('minimal diagnostic variant: no page to render');
    return;
  }

  // A component that is defined but never placed in the tree is invisible to every
  // other check: the bundle contains it, the types are satisfied, and the UI simply
  // never shows it. That is exactly how the install row once shipped missing, so the
  // rendered markup is asserted rather than the source.
  assert.match(html, /installPlaceholder/, 'the paste-a-link input must be rendered');
  assert.match(html, /placeholder="[^"]+"/, 'the input must carry its placeholder');
});

/** Render the settings section with a few skills loaded. */
async function renderSectionMarkup() {
  const source = readFileSync(join(root, 'lib', 'client.js'), 'utf8');
  // The minimal variant registers a different, throwaway section, so there is no
  // page here to measure and no styling contract to hold it to.
  if (source.includes('skill-center/minimal')) return undefined;
  const primitives = new Proxy({}, {
    get: (_target, name) => {
      if (name === '__esModule') return true;
      if (name === 'Input') {
        // The real Input renders a text box with its placeholder; a stub that drops
        // the placeholder would make the assertion below unable to see it.
        return (props) => React.createElement('input', {
          value: props?.value ?? '',
          placeholder: props?.placeholder,
          'aria-label': props?.['aria-label'],
          readOnly: true,
        });
      }
      if (name === 'Switch') return (props) => React.createElement('span', { 'data-switch': String(props?.checked) });
      return (props) => React.createElement('div', { 'data-primitive': String(name) }, props?.children ?? null);
    },
  });
  const stubs = { react: React, 'react/jsx-runtime': require('react/jsx-runtime'), '@deepseek-ai/dsh-client-ui-primitives': primitives };
  const registrations = [];
  const sandbox = {
    window: { __ModuleLoader__: { load: (row) => registrations.push(row) } },
    console,
    Promise,
    Symbol,
    URL,
    Map,
    Set,
    React,
    document: { getElementById: () => null, createElement: () => ({ id: '', textContent: '' }), head: { appendChild: () => undefined } },
    fetch: () => Promise.reject(new Error('no network')),
  };
  vm.createContext(sandbox);
  new vm.Script(source, { filename: 'client.js' }).runInContext(sandbox);

  const face = registrations[0].factory((specifier) => {
    if (specifier in stubs) return stubs[specifier];
    throw new Error(`unexpected external require: ${specifier}`);
  });

  const made = [];
  face.apply({
    effect: (factory) => factory(),
    locale: { bind: (ns) => (key) => `${ns}:${key}`, register: () => () => undefined },
    slots: {
      inject: (_key, callback) => callback(),
      register: (options, component) => {
        made.push({ options, component });
        return () => undefined;
      },
    },
  });

  const section = made.find((item) => item.options.name === 'settings.section');
  if (section === undefined) return undefined; // the minimal variant has no page
  const skills = [1, 2, 3, 4].map((n) => ({
    name: `demo-${n}`,
    description: `Skill number ${n}, long enough to wrap.`,
    rootKey: 'custom:0',
    rootLabel: 'skill-hub',
    scope: 'user',
    path: 'O:\\hub\\demo\\SKILL.md',
    kind: 'bundle',
    loadable: true,
    disabled: n % 2 === 0,
    diagnostics: [],
  }));
  const snapshot = {
    loaded: true,
    busy: false,
    pane: 'list',
    query: '',
    hideDisabled: false,
    data: {
      roots: [{ key: 'custom:0', label: 'skill-hub', scope: 'user', path: 'O:\\hub', exists: true, skills }],
      summary: { total: skills.length, disabled: 2, issues: 0 },
      warnings: [],
    },
  };
  const store = {
    subscribe: () => () => undefined,
    getSnapshot: () => snapshot,
    load: async () => undefined,
    dispose: () => undefined,
    setQuery: () => undefined,
    setHideDisabled: () => undefined,
    openDetail: async () => undefined,
    closeDetail: () => undefined,
    toggle: async () => undefined,
  };

  const { renderToStaticMarkup } = await import('react-dom/server');
  return renderToStaticMarkup(React.createElement(section.component, { ...section.options.inject(), store }));
}
