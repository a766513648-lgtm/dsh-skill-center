/**
 * Render the panel and screenshot it, for the README.
 *
 * The page is the real component from the built bundle, laid over the real
 * `Modal.module.css` and the panel's own stylesheet, with a store stand-in that
 * supplies skills. That keeps the pictures honest: the layout, colours, spacing and
 * scrollbar are the ones the application produces, only the surrounding application
 * is left out.
 *
 * Usage: `node scripts/dev/render-shots.mjs <what> [theme]`
 *   what:  list | trash | create | confirm
 *   theme: dark (default) | light
 *
 * @module scripts/dev/render-shots
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const React = require('react');
const root = 'O:\\DSH_Workship\\dsh-skill-center';
const primitives = join(root, 'node_modules', '@deepseek-ai', 'dsh-client-ui-primitives', 'lib');

const what = process.argv[2] ?? 'list';
const theme = process.argv[3] ?? 'dark';

const source = readFileSync(join(root, 'lib', 'client.js'), 'utf8');
const primitivesStub = new Proxy({}, {
  get: (_target, name) => {
    if (name === '__esModule') return true;
    if (name === 'Input') {
      return (props) => React.createElement('input', {
        value: props?.value ?? '',
        placeholder: props?.placeholder,
        'aria-label': props?.['aria-label'],
        readOnly: true,
      });
    }
    if (name === 'Switch') {
      return (props) => React.createElement('span', {
        'data-switch': String(props?.checked),
        'data-disabled': String(Boolean(props?.disabled)),
      });
    }
    if (name === 'Tag') {
      return (props) => React.createElement('span', { className: 'shot-tag', 'data-tone': props?.tone }, props?.children ?? null);
    }
    return (props) => React.createElement('div', { 'data-primitive': String(name) }, props?.children ?? null);
  },
});
const stubs = {
  react: React,
  'react/jsx-runtime': require('react/jsx-runtime'),
  '@deepseek-ai/dsh-client-ui-primitives': primitivesStub,
};

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
/**
 * Pull the English dictionary out of the bundle.
 *
 * The page asks its translator for strings, and a stub that echoes the key renders a
 * screenshot full of `settings.skillCenter:title`. The real dictionary is already in
 * the bundle, so it is read from there rather than duplicated here — a screenshot
 * that shows invented copy would be worse than no screenshot.
 */
const literals = new Map();
const dictionary = /exports\.en = \{([\s\S]*?)\n\};/.exec(source);
if (dictionary === null) throw new Error('the English dictionary was not found in the bundle');
for (const match of dictionary[1].matchAll(/(?:'([^']+)'|([A-Za-z][A-Za-z0-9]*)):\s*'((?:[^'\\]|\\.)*)'/g)) {
  literals.set(match[1] ?? match[2], match[3].replace(/\\'/g, "'"));
}

/** Translate the way the shell's bound translator does, with `{name}` substitution. */
function translate(key, params) {
  const text = literals.get(key);
  if (text === undefined) return key;
  return params === undefined
    ? text
    : text.replace(/\{(\w+)\}/g, (_whole, name) => String(params[name] ?? `{${name}}`));
}

face.apply({
  effect: (factory) => factory(),
  locale: { bind: () => translate, register: () => () => undefined },
  slots: {
    inject: (_key, callback) => callback(),
    register: (options, component) => {
      made.push({ options, component });
      return () => undefined;
    },
  },
});

const section = made.find((item) => item.options.name === 'settings.section');
if (section === undefined) throw new Error('the settings section is not registered');

const names = [
  ['demo-code-review', 'Review a Git diff for correctness, edge cases and missing tests before it is committed.', false],
  ['demo-hello', 'A minimal demo skill used to check that Skill Center lists, opens and switches skills.', true],
  ['grill-me', 'Interview the user relentlessly about a plan or design until reaching shared understanding.', false],
  ['demo-release-notes', 'Turn a range of commits into plain-language release notes grouped by impact.', true],
];
const skills = names.map(([name, description, disabled]) => ({
  name,
  description,
  rootKey: 'custom:0',
  rootLabel: 'skill-hub',
  scope: 'user',
  path: `O:\\DSH_Workship\\skill-hub\\${name}\\SKILL.md`,
  kind: 'bundle',
  loadable: true,
  disabled,
  diagnostics: [],
}));

const hub = 'O:\\DSH_Workship\\skill-hub';
const base = {
  loaded: true,
  busy: false,
  query: '',
  hideDisabled: false,
  roots: [hub, 'C:\\Users\\you\\.dsh\\skills'],
  targetRoot: hub,
  data: {
    roots: [{ key: 'custom:0', label: 'skill-hub', scope: 'user', path: hub, exists: true, skills }],
    summary: { total: skills.length, disabled: 2, issues: 0 },
    warnings: [],
  },
};

const snapshot = {
  list: { ...base, pane: 'list' },
  confirm: { ...base, pane: 'list' },
  create: { ...base, pane: 'create' },
  trash: {
    ...base,
    pane: 'trash',
    trash: {
      exists: true,
      entries: [
        { id: 'a', name: 'demo-hello', originalPath: `${hub}\\demo-hello`, removedAt: '2026-10-15T05:20:00.000Z' },
        { id: 'b', name: 'old-skill', originalPath: `${hub}\\old-skill`, removedAt: '2026-10-14T18:02:00.000Z' },
      ],
    },
  },
}[what];
if (snapshot === undefined) throw new Error(`unknown target: ${what}`);

const store = {
  subscribe: () => () => undefined,
  getSnapshot: () => snapshot,
  load: async () => undefined,
  dispose: () => undefined,
  setQuery: () => undefined,
  setHideDisabled: () => undefined,
  setTargetRoot: () => undefined,
  loadRoots: async () => undefined,
  openDetail: async () => undefined,
  closeDetail: () => undefined,
  toggle: async () => undefined,
  remove: async () => true,
  openTrash: async () => undefined,
  restore: async () => true,
  emptyTrash: async () => true,
  openCreate: () => undefined,
  closePane: () => undefined,
  create: async () => true,
  install: async () => true,
  dismissNotice: () => undefined,
};

const { renderToStaticMarkup } = await import('react-dom/server');
const page = renderToStaticMarkup(React.createElement(section.component, { ...section.options.inject(), store }));

// The delete confirmation is its own dialog, opened by a click; render it directly
// so the shot shows the dialog rather than the row that opens it.
const opened = what === 'confirm';

const modalCss = readFileSync(join(primitives, 'Modal.module.css'), 'utf8');
const buttonCss = readFileSync(join(primitives, 'Button.module.css'), 'utf8');
const switchCss = readFileSync(join(primitives, 'Switch.module.css'), 'utf8');
const inputCss = readFileSync(join(primitives, 'Input.module.css'), 'utf8');
const tagCss = readFileSync(join(primitives, 'Tag.module.css'), 'utf8');

const scrollSource = readFileSync(join(root, 'src', 'client', 'scrollStyles.ts'), 'utf8');
const cssMatch = /export const SCROLLBAR_CSS = `([\s\S]*?)`;/.exec(scrollSource);
if (cssMatch === null) throw new Error('SCROLLBAR_CSS not found');
const scrollCss = cssMatch[1]
  .replace(/\$\{SCROLL_CLASS\}/g, 'skill-center-scroll')
  .replace(/\$\{THUMB_HOVER\}/g, 'var(--dsw-alias-label-secondary, rgba(226,230,236,.95))')
  .replace(/\$\{THUMB\}/g, 'var(--dsw-alias-label-tertiary, var(--dsh-scrollbar-thumb, rgba(200,204,210,.8)))');

const dark = {
  '--dsw-alias-bg-layer-1': '#262a31',
  '--dsw-alias-bg-layer-2': '#1f2228',
  '--dsw-alias-bg-layer-3': '#2c313a',
  '--dsw-alias-bg-base': '#16181c',
  '--dsw-alias-bg-mask-1': 'rgba(0,0,0,.45)',
  '--dsw-alias-label-primary': '#e6e8ec',
  '--dsw-alias-label-secondary': '#c8ced8',
  '--dsw-alias-label-tertiary': '#9098a3',
  '--dsw-alias-border-l4': '#333944',
  '--dsw-alias-border-l3': '#3a4150',
  '--dsw-alias-link': '#6aa3ff',
  '--dsw-alias-state-error-primary': '#ff6b6b',
  '--dsw-alias-state-success-primary': '#57d9a3',
  '--dsw-alias-interactive-bg-hover': 'rgba(255,255,255,.06)',
  '--dsw-alias-interactive-bg-active': 'rgba(255,255,255,.1)',
  '--dsw-alias-label-primary-foreground': '#10131a',
  '--dsw-alias-button-primary-fill': '#e6e8ec',
  '--dsw-alias-scrollbar-bg-l1': '#3a3f47',
  '--dsw-alias-scrollbar-hover-l1': '#e6e8ec',
  '--dsw-alias-tag-neutral-bg': '#2c313a',
  '--dsw-static-neutral-200': '#e6e8ec',
  '--dsw-static-neutral-700': '#3a3f47',
  page: '#16181c',
};
const light = {
  '--dsw-alias-bg-layer-1': '#ffffff',
  '--dsw-alias-bg-layer-2': '#f7f8fa',
  '--dsw-alias-bg-layer-3': '#eceef2',
  '--dsw-alias-bg-base': '#ffffff',
  '--dsw-alias-bg-mask-1': 'rgba(20,22,26,.25)',
  '--dsw-alias-label-primary': '#1f2328',
  '--dsw-alias-label-secondary': '#4b5563',
  '--dsw-alias-label-tertiary': '#6b7280',
  '--dsw-alias-border-l4': '#dfe3e8',
  '--dsw-alias-border-l3': '#cfd5dd',
  '--dsw-alias-link': '#0969da',
  '--dsw-alias-state-error-primary': '#b42318',
  '--dsw-alias-state-success-primary': '#1f7a3f',
  '--dsw-alias-interactive-bg-hover': 'rgba(0,0,0,.05)',
  '--dsw-alias-interactive-bg-active': 'rgba(0,0,0,.08)',
  '--dsw-alias-label-primary-foreground': '#ffffff',
  '--dsw-alias-button-primary-fill': '#1f2328',
  '--dsw-alias-scrollbar-bg-l1': '#c9ced6',
  '--dsw-alias-scrollbar-hover-l1': '#9aa1ab',
  '--dsw-alias-tag-neutral-bg': '#eceef2',
  '--dsw-static-neutral-200': '#e6e8ec',
  '--dsw-static-neutral-700': '#3a3f47',
  page: '#eef0f3',
};
const tokens = theme === 'light' ? light : dark;
const variables = Object.entries(tokens)
  .filter(([key]) => key.startsWith('--'))
  .map(([key, value]) => `  ${key}: ${value};`)
  .join('\n');

const dialog = opened
  ? `<div class="root"><div class="mask"></div>
  <div class="dialog" style="max-height:100%">
    <div class="header"><h2 class="title">Delete "demo-hello"?</h2><button class="close">&times;</button></div>
    <p class="description">The folder is moved into Skill Center's trash, not erased. You can put it back from the Trash view at any time.</p>
    <div class="body"><div class="shot-dialog-actions">
      <span class="shot-button outline">Cancel</span><span class="shot-button primary">Move to trash</span>
    </div></div>
  </div></div>`
  : `<div class="root"><div class="mask"></div>
  <div class="dialog" style="max-height:100%">
    <div class="header"><h2 class="title">Skill Center</h2><button class="close">&times;</button></div>
    <p class="description">Browse the skills DSH can load and switch them on or off.</p>
    <div class="body">
      <div class="skill-center-modal-content" style="height:80vh;max-height:80vh;min-height:0;display:flex">
${page}
      </div>
    </div>
  </div></div>`;

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>skill center shot</title>
<style>
:root {
${variables}
  --dsw-radius-panel: 12px; --dsw-radius-sm: 8px; --dsw-radius-md: 10px; --dsw-radius-lg: 14px;
  --dsh-scrollbar-thumb: var(--dsw-alias-scrollbar-bg-l1); --dsh-scrollbar-width: 5px;
  --dsw-font-xs-13: 13px; --ds-font-family-code: ui-monospace, Consolas, monospace;
  --dsw-elevation-prominent: 0 12px 32px rgba(0,0,0,.35); --ds-transition-duration: 0s; --ds-ease-in-out: ease;
  --dsw-mask-blur: none; --dsh-frame-overlay-top: 24px; --dsh-frame-chrome-top: 0px;
}
body { margin: 0; background: ${tokens.page}; font: 14px "Segoe UI","Microsoft YaHei",sans-serif; }
${modalCss}
${buttonCss}
${switchCss}
${inputCss}
${tagCss}
.skill-center-modal-content { display: flex; flex-direction: column; min-height: 0; }
/* Real primitives cannot load here (they pull clsx), so the few they render are
   drawn with the same tokens they use. */
.shot-tag { display:inline-flex; align-items:center; height:22px; padding:0 8px; border-radius:var(--dsw-radius-sm);
  font-size:12px; color:var(--dsw-alias-label-secondary); background:var(--dsw-alias-bg-layer-3); }
.shot-tag[data-tone='danger'] { color:var(--dsw-alias-state-error-primary); }
.shot-tag[data-tone='warning'] { color:#d9822b; }
.shot-tag[data-tone='info'] { color:var(--dsw-alias-link); }
.shot-tag[data-tone='quiet'] { opacity:.75; }
[data-switch] { width:36px; height:20px; border-radius:999px; background:var(--dsw-alias-bg-layer-3); position:relative; display:inline-block; flex:none; }
[data-switch]::after { content:''; position:absolute; top:2px; left:2px; width:16px; height:16px; border-radius:50%; background:var(--dsw-alias-label-tertiary); transition:none; }
[data-switch='true'] { background:var(--dsw-alias-state-business-primary,#2f6feb); }
[data-switch='true']::after { left:auto; right:2px; background:#fff; }
[data-switch][data-disabled='true'] { opacity:.5; }
[data-primitive='Button'] { display:inline-flex; align-items:center; justify-content:center; gap:6px; height:36px; padding:0 14px;
  border-radius:var(--dsw-radius-md); border:1px solid var(--dsw-alias-border-l3); background:transparent;
  color:var(--dsw-alias-label-primary); font-size:13px; cursor:pointer; }
[data-primitive='Button'][data-variant='primary'], .shot-button.primary { background:var(--dsw-alias-button-primary-fill); color:var(--dsw-alias-label-primary-foreground); border-color:transparent; }
input { height:36px; padding:0 12px; border-radius:var(--dsw-radius-md); border:1px solid var(--dsw-alias-border-l4);
  background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-label-primary); font-size:13px; width:100%; box-sizing:border-box; }
.shot-dialog-actions { display:flex; gap:8px; justify-content:flex-end; padding-bottom:4px; }
.shot-button { display:inline-flex; align-items:center; justify-content:center; height:36px; padding:0 14px;
  border-radius:var(--dsw-radius-md); border:1px solid var(--dsw-alias-border-l3); font-size:13px; }
${scrollCss}
</style></head>
<body>
${dialog}
</body></html>`;

const dir = join(root, 'docs', 'shots');
mkdirSync(dir, { recursive: true });
const file = join(dir, `${what}-${theme}.html`);
writeFileSync(file, html, 'utf8');
console.log(`wrote ${file}`);
console.log(`page markup: ${String(page.length)} chars`);
