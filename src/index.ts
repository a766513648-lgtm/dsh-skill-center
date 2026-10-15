/**
 * Skill Center — host half.
 *
 * Registers the browser API under `/api/skill-center` and contributes a
 * read-only skill provider so a skill that Skill Center switches off also
 * disappears from the model-facing catalog and the slash menu.
 *
 * The provider deliberately ranks ahead of the DSH filesystem provider but
 * carries only the *policy*: bodies are read from the same instruction file the
 * host provider would have read, so Skill Center never becomes a second source
 * of truth for skill content.
 *
 * @module @dsh-workship/skill-center
 */

import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Context } from '@deepseek-ai/cordis';
// Type-only on purpose: this import exists so TypeScript applies the package's
// module augmentation (`ctx.webServer`). A side-effect import would survive
// bundling as a real `require`, and the Host does not put its own packages on a
// plugin's runtime resolution path — the whole plugin would then fail to import
// with MODULE_NOT_FOUND and never appear in Settings.
import type {} from '@deepseek-ai/dsh-host-webserver';
import type { SkillCandidate, SkillDefinition, SkillProviderControl } from '@deepseek-ai/dsh-skill';
import type { SkillEntry, ScanResult } from './core/scan.ts';
import { scanSkills } from './core/scan.ts';
import { emptyState, isDisabled, loadState, saveState, withDisabled } from './core/store.ts';
import type { SkillCenterState } from './core/store.ts';
import { toggleSkillFile } from './core/toggle.ts';
import { emptyTrash, moveToTrash, readTrash, restoreFromTrash } from './core/trash.ts';
import { installFromUrl } from './core/install.ts';
import { checkName } from './core/parse.ts';
import type { DiagnosticView, DetailResponse, RootView, SkillView, StateResponse } from './contract.ts';

/** Plugin name registered in the host composition. */
export const name = 'skill-center';

/** Services this plugin needs before it applies. */
export const inject = ['skills', 'webServer', 'sessions'];

/** Prefix every route of this plugin lives under. */
const ROUTE_PREFIX = '/api/skill-center';

/** Rank for the gating provider: lower wins, so this outranks `filesystem`. */
const GATE_RANK = 50;

/** Provider name shown in skill provenance. */
const PROVIDER_NAME = 'skill-center';

/** Upper bound on a request body, in bytes. */
const MAX_BODY_BYTES = 64 * 1024;

/** Marker header the browser half sends on every write. */
const CLIENT_MARKER = 'x-skill-center';

/** Resolve the DSH home this host process uses. */
function dshHome(): string {
  const configured = process.env.DSH_HOME;
  return typeof configured === 'string' && configured !== '' ? configured : join(homedir(), '.dsh');
}

/**
 * Read the extra skill roots any profile under this DSH home configures.
 *
 * DSH's filesystem provider accepts `customSkillDirs`, so a profile can keep its
 * skills outside `<dshHome>/skills`. The panel has to look where DSH looks, or it
 * would show an empty list while DSH loads those skills happily. The value is
 * read from the profiles' own patch layers — the same files the Host composes
 * from — rather than being configured a second time here, so the two cannot
 * drift.
 *
 * Every profile is read rather than just the running one. The running profile's
 * name is not reliably available inside a plugin: the desktop launcher may pass
 * it through a variable this process never sees, and guessing wrong silently
 * yields an empty root list — which is exactly how the panel once came up empty
 * with skills sitting on disk. Reading a sibling profile's roots as well is
 * harmless: they are directories the same user already configured, and each one
 * still has to exist to be listed.
 *
 * The parse is deliberately narrow: it finds the `customSkillDirs` sequence under
 * the `skill-filesystem` entry and takes its quoted items. A profile that
 * configures roots some other way (a `!!js` expression, for instance) is not
 * second-guessed; those skills simply do not appear in the panel.
 *
 * @param home - the resolved DSH home.
 * @returns absolute, existing directories, deduplicated, in profile order.
 */
export function configuredSkillRoots(home: string): string[] {
  const profilesDir = join(home, 'profiles');
  let profiles: string[];
  try {
    profiles = readdirSync(profilesDir).sort();
  } catch {
    return [];
  }

  const found: string[] = [];
  for (const profile of profiles) {
    for (const directory of skillRootsFromPatch(join(profilesDir, profile, 'cordis.patch.yml'))) {
      if (!found.includes(directory)) found.push(directory);
    }
  }

  // Only directories that exist: a configured root that is not there yet is not
  // a place to list, and reporting it would add an empty group to the panel.
  return found.filter((directory) => {
    try {
      return statSync(directory).isDirectory();
    } catch {
      return false;
    }
  });
}

/**
 * Extract the `customSkillDirs` items from one patch layer.
 * @param file - absolute path of the profile's patch file.
 * @returns absolute directories in configuration order.
 */
function skillRootsFromPatch(file: string): string[] {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return [];
  }

  const lines = text.split(/\r?\n/);
  const found: string[] = [];
  let inEntry = false;
  let inList = false;
  let listIndent = -1;

  for (const line of lines) {
    const entry = /^\s*-\s*id:\s*(.+?)\s*$/.exec(line);
    if (entry !== null) {
      inEntry = entry[1] === 'skill-filesystem';
      inList = false;
      continue;
    }
    if (!inEntry) continue;

    const indent = (/^\s*/.exec(line)?.[0].length ?? 0);
    const item = /^\s*-\s*(.+?)\s*$/.exec(line);

    if (inList) {
      // A deeper dash is another path; anything else ends the sequence.
      const value = item?.[1]?.replace(/^["']|["']$/g, '') ?? '';
      if (item !== null && indent > listIndent && value !== '') {
        found.push(resolve(value));
        continue;
      }
      inList = false;
    }

    const key = /^\s*customSkillDirs\s*:\s*(.*)$/.exec(line);
    if (key === null) continue;
    const inline = (key[1] ?? '').trim();
    if (inline !== '') {
      // Inline form: `customSkillDirs: ['a', 'b']`.
      for (const match of inline.matchAll(/['"]([^'"]+)['"]/g)) {
        const inlinePath = match[1];
        if (inlinePath !== undefined && inlinePath !== '') found.push(resolve(inlinePath));
      }
      continue;
    }
    inList = true;
    listIndent = indent;
  }

  return found;
}

/** Convert one diagnostic into wire form. */
function toView(entry: { code: string; level: 'error' | 'warning'; message: string }): DiagnosticView {
  return { code: entry.code, level: entry.level, message: entry.message };
}

/** Split a document into frontmatter text and body, tolerating a missing block. */
function splitDocument(raw: string): { frontmatter: string; body: string } {
  const lines = raw.replace(/^\uFEFF/, '').split('\n');
  if ((lines[0] ?? '').trim() !== '---') return { frontmatter: '', body: raw.trim() };
  for (let index = 1; index < lines.length; index += 1) {
    if ((lines[index] ?? '').trim() === '---') {
      return { frontmatter: lines.slice(0, index + 1).join('\n'), body: lines.slice(index + 1).join('\n').trim() };
    }
  }
  return { frontmatter: '', body: raw.trim() };
}

/** Read one request body as JSON. */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        settled = true;
        reject(Object.assign(new Error('Request body is too large.'), { statusCode: 413, code: 'error.request.tooLarge' }));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      const raw = Buffer.concat(chunks).toString('utf8');
      if (raw === '') {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(Object.assign(new Error('Request body is not valid JSON.'), { statusCode: 400, code: 'error.request.invalidJson' }));
      }
    });
    req.on('error', (error) => {
      if (settled) return;
      settled = true;
      reject(error instanceof Error ? error : new Error('Request stream failed.'));
    });
  });
}

/** Write one JSON response. */
function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  if (res.writableEnded || res.destroyed) return;
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

/** Write one JSON failure. */
function sendError(res: ServerResponse, error: unknown): void {
  const candidate = error as { statusCode?: unknown; code?: unknown; message?: unknown } | undefined;
  const status = typeof candidate?.statusCode === 'number' ? candidate.statusCode : 500;
  sendJson(res, status, {
    ok: false,
    code: typeof candidate?.code === 'string' ? candidate.code : 'error.internal',
    error: typeof candidate?.message === 'string' ? candidate.message : 'Unexpected failure.',
  });
}

/** Create a typed failure the route layer can turn into a response. */
function failure(message: string, code: string, statusCode: number): Error {
  return Object.assign(new Error(message), { code, statusCode });
}

/** Reduce free text to a skill name the registry will accept. */
function normalizeSkillName(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '');
}

/** Escape a single-line YAML value for a double-quoted scalar. */
function yamlScalar(value: string): string {
  const oneLine = value.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
  return `"${oneLine.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Write a new skill into one of the configured skills roots.
 *
 * The target is the first configured `customSkillDirs` entry, so a profile that
 * keeps its skills outside the DSH home gets new ones in the same place; otherwise
 * the default `<home>/skills` is used. Nothing existing is ever overwritten: an
 * occupied name is a refusal, not a merge.
 *
 * The document is built here rather than copied from a template, and the body is
 * stored as a literal block scalar, so a description containing quotes or a body
 * containing `---` cannot break the frontmatter.
 * @param params - the DSH home, the configured extra roots, and the request body.
 * @returns the created directory, or a refusal.
 */
async function createSkill(params: {
  home: string;
  extraRoots: readonly string[];
  body: Record<string, unknown>;
}): Promise<{ ok: true; value: { directory: string } } | { ok: false; error: { code: string; message: string } }> {
  const { home, extraRoots, body } = params;
  const target = extraRoots[0] ?? join(home, 'skills');

  const rawName = typeof body.name === 'string' ? body.name.trim() : '';
  const description = typeof body.description === 'string' ? body.description.trim() : '';
  const instructions = typeof body.body === 'string' ? body.body : '';

  if (rawName === '') return { ok: false, error: { code: 'error.create.name', message: 'A name is required.' } };
  if (description === '') {
    return { ok: false, error: { code: 'error.create.description', message: 'A description is required; DSH uses it to decide when the skill applies.' } };
  }
  if (description.length > 1000) {
    return { ok: false, error: { code: 'error.create.description', message: 'The description is too long.' } };
  }

  const name = normalizeSkillName(rawName);
  const check = checkName(name, name);
  if (!check.valid || name === '') {
    return {
      ok: false,
      error: { code: 'error.create.name', message: `"${rawName}" does not reduce to a usable skill name (lowercase letters, digits and dashes).` },
    };
  }

  const directory = join(target, name);
  try {
    await mkdir(target, { recursive: true });
  } catch {
    return { ok: false, error: { code: 'error.create.root', message: `The skills directory could not be created: ${target}` } };
  }

  // `mkdir` without `recursive` fails when the directory exists, which is exactly
  // the check wanted here — and it is atomic, unlike a separate existence test.
  try {
    await mkdir(directory, { recursive: false });
  } catch {
    return { ok: false, error: { code: 'error.create.exists', message: `A skill named "${name}" is already there; nothing was overwritten.` } };
  }

  const truncated = instructions.length > 200_000;
  const bodyText = truncated
    ? `${instructions.slice(0, 200_000)}\n\n<!-- Truncated by Skill Center at 200000 characters. -->\n`
    : instructions;
  const document = `---\nname: ${name}\ndescription: ${yamlScalar(description)}\n---\n\n${bodyText.trim()}\n`;

  try {
    await writeFile(join(directory, 'SKILL.md'), document, 'utf8');
  } catch {
    return { ok: false, error: { code: 'error.create.write', message: 'The skill file could not be written.' } };
  }

  return { ok: true, value: { directory } };
}

/**
 * Read the working directory of the session the caller is looking at.
 *
 * The session service shape has moved between DSH releases, so every access is
 * defensive: an unfamiliar host degrades to "global skills only" instead of
 * failing the request.
 * @param ctx - the host context.
 * @param sessionId - the session the browser is showing, when known.
 * @returns an absolute directory, or undefined when it cannot be determined.
 */
function activeCwd(ctx: Context, sessionId: string | undefined): string | undefined {
  try {
    const container = (ctx as Context & { sessions?: unknown }).sessions;
    if (typeof container !== 'object' || container === null) return undefined;
    const service = container as { get?: (id: string) => unknown; list?: () => unknown };
    let record: unknown;
    if (typeof sessionId === 'string' && sessionId !== '' && typeof service.get === 'function') {
      record = service.get(sessionId);
    } else if (typeof service.list === 'function') {
      const list = service.list();
      if (Array.isArray(list) && list.length > 0) record = list[list.length - 1];
    }
    const candidate = (record as { cwd?: unknown; header?: { cwd?: unknown } } | undefined)?.cwd
      ?? (record as { header?: { cwd?: unknown } } | undefined)?.header?.cwd;
    return typeof candidate === 'string' && candidate !== '' ? candidate : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Write a diagnostic line to stderr.
 *
 * The Host reports a plugin that fails to activate as `<name>: failed` and
 * nothing more, so a mount that misbehaves has to leave its own trail. stderr is
 * the channel the startup audit itself reports on, so this needs no writable
 * directory. Every write is guarded: diagnostics must never become the reason
 * the plugin fails.
 * @param event - short event name.
 * @param detail - optional extra facts.
 */
function diag(event: string, detail?: unknown): void {
  try {
    const line = `${new Date().toISOString()} pid=${String(process.pid)} ${event}${detail === undefined ? '' : ` ${JSON.stringify(detail)}`}`;
    process.stderr.write(`skill-center: ${line}\n`);
  } catch {
    // stderr may be closed in some embeddings.
  }
}

/** Record an error, preferring its stack over its message. */
function diagError(event: string, error: unknown): void {
  const candidate = error as { stack?: unknown; message?: unknown } | undefined;
  diag(event, { error: typeof candidate?.stack === 'string' ? candidate.stack : String(candidate?.message ?? error) });
}

/**
 * Apply the host half.
 * @param ctx - the host plugin context.
 */
export function apply(ctx: Context): void {
  const home = dshHome();
  const extraRoots = configuredSkillRoots(home);
  // One line on success, one on failure. The Loader reports a plugin that fails
  // to activate as `<name>: failed` with no reason at all, so this trail is what
  // makes a broken mount diagnosable; the resolved roots ride along, so an empty
  // panel can be told apart from a panel looking in the wrong place. A working
  // plugin should not narrate any more than that.
  try {
    applyInner(ctx, home, extraRoots);
    diag('started', { roots: [join(home, 'skills'), ...extraRoots] });
  } catch (error) {
    diagError('failed to start', error);
    throw error;
  }
}

/**
 * Register the provider and the browser API.
 * @param ctx - the host plugin context.
 * @param home - the resolved DSH home.
 * @param extraRoots - skill roots the profile configures beyond `<home>/skills`.
 */
function applyInner(ctx: Context, home: string, extraRoots: readonly string[]): void {
  let cache: { scan: ScanResult; state: SkillCenterState } | undefined;
  /** Live provider controls, so a file change can invalidate the host catalog. */
  const controls = new Set<SkillProviderControl>();

  /** Rescan every root and reload the stored flags. */
  const refresh = async (projectRoot: string | undefined): Promise<{ scan: ScanResult; state: SkillCenterState }> => {
    const [scan, state] = await Promise.all([
      scanSkills({ dshHome: home, extraRoots, projectRoot }),
      loadState(home),
    ]);
    cache = { scan, state };
    return cache;
  };

  /** Invalidate the host's skill catalog after Skill Center changed a file. */
  const invalidate = (): void => {
    for (const control of controls) {
      try {
        control.invalidate();
      } catch {
        // A disposed registration aborts its own control; nothing to do here.
      }
    }
  };

  /** Locate one skill in the latest scan. */
  const findSkill = (rootKey: string, skillName: string): SkillEntry | undefined => {
    for (const root of cache?.scan.roots ?? []) {
      if (root.key !== rootKey) continue;
      return root.skills.find((entry) => entry.name === skillName);
    }
    return undefined;
  };

  /**
   * The skills root a delete may act on, or an empty string for one it may not.
   *
   * This is the gate that keeps deletion inside DSH's own skills: only a root the
   * profile configured through `customSkillDirs` (or the default `<home>/skills`)
   * answers with a path. A project root — `<project>/.dsh/skills`, which is under
   * version control — and every other source answer with `''`, and the delete path
   * then refuses. Skill Center may switch a project skill on or off; it may not
   * move it out of the repository.
   * @param rootKey - root identifier from the panel.
   * @returns the root's directory, or an empty string when it is not removable.
   */
  const userRootPath = (rootKey: string): string => {
    const allowed = [join(home, 'skills'), ...extraRoots];
    for (const root of cache?.scan.roots ?? []) {
      if (root.key !== rootKey) continue;
      return allowed.includes(root.path) ? root.path : '';
    }
    return '';
  };

  /** Build the response the panel renders. */
  const buildState = async (projectRoot: string | undefined): Promise<StateResponse> => {
    const { scan, state } = await refresh(projectRoot);
    const roots: RootView[] = [];
    let total = 0;
    let disabledCount = 0;
    let issues = 0;

    for (const root of scan.roots) {
      const skills: SkillView[] = root.skills.map((entry) => {
        const disabled = isDisabled(state, entry.rootKey, entry.name);
        total += 1;
        if (disabled) disabledCount += 1;
        if (entry.diagnostics.length > 0) issues += 1;
        return {
          name: entry.name,
          description: entry.description,
          rootKey: entry.rootKey,
          rootLabel: entry.rootLabel,
          scope: entry.scope,
          path: entry.path,
          kind: entry.kind,
          loadable: entry.loadable,
          disabled,
          diagnostics: entry.diagnostics.map(toView),
        };
      });
      roots.push({
        key: root.key,
        label: root.label,
        scope: root.scope,
        path: root.path,
        exists: root.exists,
        skills,
        ...(root.warning === undefined ? {} : { warning: toView(root.warning) }),
      });
    }

    const warnings: DiagnosticView[] =
      state.warning === undefined ? [] : [{ code: state.warning.code, level: 'warning', message: state.warning.message }];

    return {
      roots,
      summary: { total, disabled: disabledCount, issues },
      ...(projectRoot === undefined ? {} : { projectRoot }),
      warnings,
    };
  };

  /** Read one skill's document for the detail view. */
  const buildDetail = async (rootKey: string, skillName: string): Promise<DetailResponse> => {
    if (cache === undefined) await refresh(undefined);
    const entry = findSkill(rootKey, skillName);
    if (entry === undefined) throw failure(`Unknown skill: ${skillName}`, 'error.skill.notFound', 404);
    const raw = await readFile(entry.path, 'utf8').catch(() => '');
    const { frontmatter, body } = splitDocument(raw);
    return {
      rootKey: entry.rootKey,
      name: entry.name,
      description: entry.description,
      path: entry.path,
      body,
      frontmatter,
      diagnostics: entry.diagnostics.map(toView),
      disabled: isDisabled(cache?.state ?? emptyState(), entry.rootKey, entry.name),
      loadable: entry.loadable,
    };
  };

  // The gating provider re-states the invocation policy for every skill it can
  // see, ranks ahead of the filesystem provider, and reads bodies from the same
  // files, so an enabled skill behaves exactly as it did without this plugin.
  ctx.effect(
    () => {
      try {
        const dispose = ctx.skills.registerProvider((control) => {
          controls.add(control);
          control.signal.addEventListener('abort', () => controls.delete(control), { once: true });
          return {
            name: PROVIDER_NAME,
            list: async (): Promise<readonly SkillCandidate[]> => {
              try {
                const snapshot = cache ?? (await refresh(activeCwd(ctx, undefined)));
                const candidates: SkillCandidate[] = [];
                for (const root of snapshot.scan.roots) {
                  for (const entry of root.skills) {
                    if (!entry.loadable) continue;
                    const disabled = isDisabled(snapshot.state, entry.rootKey, entry.name);
                    candidates.push({
                      name: entry.name,
                      description: entry.description,
                      invocation: { modelInvocable: !disabled, userInvocable: !disabled },
                      source: entry.scope === 'project' ? 'project-dsh' : 'user-dsh',
                      provider: PROVIDER_NAME,
                      rank: GATE_RANK,
                      path: entry.path,
                      resourceBase: { kind: 'directory', path: dirname(entry.path) },
                      locator: { path: entry.path },
                    });
                  }
                }
                return candidates;
              } catch (error) {
                // A throw here surfaces to the model as a failed skill listing,
                // which is otherwise reported with no reason at all.
                diagError('skill listing failed', error);
                throw error;
              }
            },
            get: async (candidate: SkillCandidate): Promise<SkillDefinition | undefined> => {
              const locator = candidate.locator as { path?: unknown } | undefined;
              const path = typeof locator?.path === 'string' ? locator.path : undefined;
              if (path === undefined) return undefined;
              const content = await readFile(path, 'utf8').catch(() => undefined);
              if (content === undefined) return undefined;
              const { body } = splitDocument(content);
              return {
                name: candidate.name,
                description: candidate.description,
                invocation: candidate.invocation,
                source: candidate.source,
                provider: PROVIDER_NAME,
                resourceBase: candidate.resourceBase,
                path,
                content: body,
              };
            },
          };
        });
        return dispose;
      } catch (error) {
        diagError('provider registration failed', error);
        throw error;
      }
    },
    'skill-center: gating skill provider',
  );

  ctx.effect(
    () => {
      try {
        const dispose = ctx.webServer.register({
          kind: 'prefix',
          path: ROUTE_PREFIX,
          handler: async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
          try {
            const url = new URL(req.url ?? '/', 'http://localhost');
            const action = url.pathname.slice(ROUTE_PREFIX.length).replace(/\/+$/, '');
            const sessionHeader = req.headers['x-skill-center-session'];
            const projectRoot = activeCwd(ctx, typeof sessionHeader === 'string' ? sessionHeader : undefined);

            if (req.method === 'GET' && action === '/state') {
              sendJson(res, 200, await buildState(projectRoot));
              return;
            }

            if (req.method === 'GET' && action === '/diag') {
              // Temporary diagnostic surface: report whether this plugin is the
              // one serving the request, plus the live skill catalog as the
              // registry sees it.
              let catalog: unknown;
              try {
                catalog = (await ctx.skills.list({})).map((item) => ({ name: item.name, provider: item.provider }));
              } catch (error) {
                catalog = { error: String((error as Error)?.message ?? error) };
              }
              sendJson(res, 200, {
                plugin: 'skill-center',
                pid: process.pid,
                applyRan: true,
                skills: catalog,
              });
              return;
            }

            if (req.method === 'GET' && action === '/trash') {
              // A read, so it belongs with the other GETs rather than after the
              // POST-only guard below.
              const trash = await readTrash(home);
              sendJson(res, 200, {
                entries: trash.entries.filter((entry) => entry.originalPath !== ''),
                exists: trash.exists,
                ...(trash.warning === undefined ? {} : { warning: trash.warning }),
              });
              return;
            }

            if (req.method === 'POST' && action === '/client-report') {
              // The browser half reports its own failures here. A client plugin
              // that fails to activate leaves no trace the Host can read, so
              // without this the only evidence lives in a console nobody can
              // open. stderr is captured by the desktop log.
              const report = (await readJsonBody(req)) as Record<string, unknown>;
              try {
                process.stderr.write(`skill-center/client-report: ${JSON.stringify(report)}\n`);
              } catch {
                // stderr may be closed in some embeddings.
              }
              sendJson(res, 200, { ok: true });
              return;
            }

            if (req.method !== 'POST') {
              sendJson(res, 405, { ok: false, code: 'error.request.method', error: `Method not allowed: ${req.method ?? 'unknown'}` });
              return;
            }
            if (req.headers[CLIENT_MARKER] !== '1') {
              sendJson(res, 403, { ok: false, code: 'error.request.forbidden', error: 'Missing client marker.' });
              return;
            }

            const body = (await readJsonBody(req)) as Record<string, unknown>;

            if (action === '/detail') {
              sendJson(res, 200, await buildDetail(String(body.rootKey ?? ''), String(body.name ?? '')));
              return;
            }

            if (action === '/toggle') {
              const rootKey = String(body.rootKey ?? '');
              const skillName = String(body.name ?? '');
              const disabled = body.disabled === true;
              if (cache === undefined) await refresh(projectRoot);

              const entry = findSkill(rootKey, skillName);
              if (entry === undefined) throw failure(`Unknown skill: ${skillName}`, 'error.skill.notFound', 404);
              if (!entry.loadable) {
                throw failure('DSH cannot load this skill, so its state was not changed.', 'error.skill.notLoadable', 400);
              }

              const result = await toggleSkillFile(entry.path, disabled);
              if (result.error !== undefined) {
                sendJson(res, 400, { ok: false, code: result.error.code, error: result.error.message });
                return;
              }

              const next = withDisabled(cache?.state ?? emptyState(), rootKey, skillName, disabled);
              await saveState(home, next);
              if (cache !== undefined) cache = { scan: cache.scan, state: next };
              invalidate();

              sendJson(res, 200, { name: skillName, disabled, changed: result.changed });
              return;
            }

            if (action === '/delete') {
              const rootKey = String(body.rootKey ?? '');
              const skillName = String(body.name ?? '');
              if (cache === undefined) await refresh(projectRoot);

              const entry = findSkill(rootKey, skillName);
              if (entry === undefined) throw failure(`Unknown skill: ${skillName}`, 'error.skill.notFound', 404);

              const rootPath = userRootPath(rootKey);
              const result = await moveToTrash({
                dshHome: home,
                request: {
                  rootPath,
                  rootKey,
                  // Only DSH's own skills are removable; `userRootPath` answers the
                  // empty string for anything else, which the gate then refuses.
                  scope: rootPath === '' ? 'project' : 'user',
                  name: entry.name,
                  path: entry.path,
                  kind: entry.kind,
                  loadable: entry.loadable,
                },
              });
              if (!result.ok) {
                sendJson(res, 400, { ok: false, code: result.error.code, error: result.error.message });
                return;
              }

              const next = withDisabled(cache?.state ?? emptyState(), rootKey, skillName, false);
              await saveState(home, next);
              if (cache !== undefined) cache = { scan: cache.scan, state: next };
              invalidate();
              sendJson(res, 200, { ok: true, entry: result.value });
              return;
            }

            if (action === '/restore') {
              const result = await restoreFromTrash({ dshHome: home, id: String(body.id ?? '') });
              if (!result.ok) {
                sendJson(res, 400, { ok: false, code: result.error.code, error: result.error.message });
                return;
              }
              invalidate();
              sendJson(res, 200, { ok: true, entry: result.value });
              return;
            }

            if (action === '/empty-trash') {
              const result = await emptyTrash(home);
              if (!result.ok) {
                sendJson(res, 400, { ok: false, code: result.error.code, error: result.error.message });
                return;
              }
              sendJson(res, 200, { ok: true, removed: result.value.removed });
              return;
            }

            if (action === '/create') {
              const created = await createSkill({ home, extraRoots, body });
              if (!created.ok) {
                sendJson(res, 400, { ok: false, code: created.error.code, error: created.error.message });
                return;
              }
              invalidate();
              sendJson(res, 200, { ok: true, directory: created.value.directory });
              return;
            }

            if (action === '/install') {
              const url = String(body.url ?? '');
              if (url.trim() === '') {
                sendJson(res, 400, { ok: false, code: 'error.install.url', error: 'Paste a link to a skill.' });
                return;
              }
              if (cache === undefined) await refresh(projectRoot);
              const targetRoot = extraRoots[0] ?? join(home, 'skills');
              // Every name already present in the target, so the install can refuse
              // an overwrite rather than replace someone's skill.
              const existingNames = (cache?.scan.roots ?? [])
                .filter((root) => root.path === targetRoot)
                .flatMap((root) => root.skills.map((entry) => entry.name));

              const installed = await installFromUrl({ url, targetRoot, existingNames });
              if (!installed.ok) {
                sendJson(res, 400, { ok: false, code: installed.error.code, error: installed.error.message });
                return;
              }
              invalidate();
              sendJson(res, 200, { ok: true, skills: installed.skills, skipped: installed.skipped });
              return;
            }

            sendJson(res, 404, { ok: false, code: 'error.request.unknownAction', error: `Unknown action: ${action}` });
          } catch (error) {
            sendError(res, error);
          }
        },
        });
        return dispose;
      } catch (error) {
        diagError('route registration failed', error);
        throw error;
      }
    },
    'skill-center: browser API',
  );
}
