/**
 * Installing a skill from a URL.
 *
 * Three shapes are supported, because those are what people actually paste:
 *
 * - a link to a repository (`github.com/owner/repo`, optionally `/tree/<ref>/<path>`),
 *   which is turned into that repository's archive for the ref;
 * - a link to a `.zip` archive;
 * - a link to a single `SKILL.md` file, which becomes a one-file bundle.
 *
 * Every archive is treated as hostile input until it has been read: entry names may
 * not escape the target directory, a skill must have a name DSH will accept, and a
 * name that already exists is refused. Nothing is written until *all* of that has
 * passed, so a rejected install leaves the skills root exactly as it was.
 *
 * @module core/install
 */

import { mkdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { checkName, parseSkillDoc } from './parse.ts';
import { readZip } from './zip.ts';

/** Cap on a single download, in bytes. */
const MAX_BYTES = 8 * 1024 * 1024;

/** Cap on entries read from one archive. */
const MAX_ENTRIES = 800;

/** Cap on bundle files written from one archive. */
const MAX_FILES_PER_BUNDLE = 200;

/** How long a download may take. */
const FETCH_TIMEOUT_MS = 25_000;

/** What the caller asked to install. */
export interface InstallRequest {
  /** The pasted URL. */
  readonly url: string;
  /** Directory new skills are written into. */
  readonly targetRoot: string;
  /** Directory names already present in the target, so overwrites are refused. */
  readonly existingNames: readonly string[];
}

/** One skill that was written. */
export interface InstalledSkill {
  /** Skill name, taken from the folder or the frontmatter. */
  readonly name: string;
  /** Directory it was written to. */
  readonly directory: string;
  /** How many files it contains. */
  readonly files: number;
  /** What the download turned out to be. */
  readonly source: 'repository' | 'archive' | 'document';
}

/** Outcome of an install. */
export type InstallResult =
  | { readonly ok: true; readonly skills: InstalledSkill[]; readonly skipped: number }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } };

/** A file that will be written, relative to its bundle directory. */
interface PendingFile {
  /** Path inside the bundle, forward slashes. */
  readonly relative: string;
  /** File contents. */
  readonly data: Buffer;
}

/** One skill about to be written. */
interface PendingBundle {
  /** Bundle directory name. */
  readonly name: string;
  /** Files to write. */
  readonly files: PendingFile[];
  /** What the download turned out to be. */
  readonly source: InstalledSkill['source'];
}

/** An address that was understood. */
type Source =
  | {
      readonly kind: 'repository';
      readonly owner: string;
      readonly repo: string;
      readonly ref: string;
      readonly refKind: 'branch' | 'tag' | 'default';
      readonly subPath: string;
      readonly label: string;
    }
  | { readonly kind: 'archive'; readonly url: string }
  | { readonly kind: 'document'; readonly url: string };

/** Refuse a URL that is not a plain web address. */
function parseUrl(raw: string): { ok: true; url: URL } | { ok: false; error: { code: string; message: string } } {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, error: { code: 'error.install.url', message: 'That is not a valid URL. Paste a full https:// address.' } };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, error: { code: 'error.install.scheme', message: 'Only http and https links can be fetched.' } };
  }
  // A skill URL never points at this machine, and following one could reach
  // services that are not meant to be reachable from a plugin.
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.local')) {
    return { ok: false, error: { code: 'error.install.local', message: 'Links to this machine are not fetched.' } };
  }
  return { ok: true, url };
}

/**
 * Classify a pasted address.
 * @param raw - the pasted text.
 * @returns the address in a form the downloader can use.
 */
function classify(raw: string): { ok: true; source: Source } | { ok: false; error: { code: string; message: string } } {
  const parsed = parseUrl(raw);
  if (!parsed.ok) return parsed;
  const { url } = parsed;
  const host = url.hostname.toLowerCase();

  if (host === 'github.com' || host === 'www.github.com') {
    const segments = url.pathname.split('/').filter((part) => part !== '');
    if (segments.length < 2) {
      return { ok: false, error: { code: 'error.install.github', message: 'A GitHub link needs an owner and a repository, for example https://github.com/owner/repo.' } };
    }
    const owner = segments[0] ?? '';
    const repo = (segments[1] ?? '').replace(/\.git$/, '');
    if (owner === '' || repo === '') {
      return { ok: false, error: { code: 'error.install.github', message: 'A GitHub link needs an owner and a repository.' } };
    }
    // `/tree/<ref>/<path>` points inside a repository; `/blob/...` points at a file
    // and is handled as a raw document below.
    if (segments[2] === 'tree' && segments.length >= 4) {
      const ref = segments[3] ?? '';
      return {
        ok: true,
        source: {
          kind: 'repository',
          owner,
          repo,
          ref,
          refKind: 'branch',
          subPath: segments.slice(4).join('/'),
          label: `${owner}/${repo}`,
        },
      };
    }
    if (segments[2] === 'blob' && segments.length >= 5) {
      const ref = segments[3] ?? '';
      const path = segments.slice(4).join('/');
      return {
        ok: true,
        source: { kind: 'document', url: `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${path}` },
      };
    }
    // A bare repository link has no ref, and codeload rejects a request without one
    // (it answers 404 rather than redirecting), while assuming `main` breaks every
    // repository still on `master`. The default branch is therefore looked up from
    // the public API before the archive is requested.
    return {
      ok: true,
      source: { kind: 'repository', owner, repo, ref: '', refKind: 'default', subPath: '', label: `${owner}/${repo}` },
    };
  }

  if (host === 'raw.githubusercontent.com') {
    return { ok: true, source: { kind: 'document', url: url.href } };
  }
  return { ok: true, source: { kind: 'archive', url: url.href } };
}

/**
 * Decide what a download actually is, from its bytes.
 *
 * A URL is a poor predictor: a link with no extension can serve a zip, an HTML
 * page or a markdown file. The bytes are not ambiguous — an archive starts with
 * `PK`, and anything else is treated as text to be classified further.
 * @param body - the downloaded bytes.
 * @returns whether the payload is an archive.
 */
function looksLikeArchive(body: Buffer): boolean {
  return body.length >= 4 && body[0] === 0x50 && body[1] === 0x4b;
}

/** Download one address, refusing anything oversized. */
async function download(url: string): Promise<{ ok: true; body: Buffer; contentType: string } | { ok: false; error: { code: string; message: string } }> {
  let response: Response;
  try {
    response = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { accept: 'application/zip, text/markdown, text/plain, */*' },
    });
  } catch (error) {
    const cause = (error as { cause?: { code?: string; message?: string } }).cause;
    const detail = cause?.code ?? cause?.message ?? (error as Error).message;
    return { ok: false, error: { code: 'error.install.fetch', message: `The download failed: ${String(detail)}` } };
  }

  if (!response.ok) {
    return {
      ok: false,
      error: { code: 'error.install.status', message: `The server answered ${String(response.status)} ${response.statusText}. Check the link is public.` },
    };
  }

  const declared = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > MAX_BYTES) {
    return { ok: false, error: { code: 'error.install.tooLarge', message: `That download is ${String(Math.round(declared / 1024 / 1024))} MB, over the ${String(MAX_BYTES / 1024 / 1024)} MB limit.` } };
  }

  let body: Buffer;
  try {
    body = Buffer.from(await response.arrayBuffer());
  } catch {
    return { ok: false, error: { code: 'error.install.fetch', message: 'The download was interrupted.' } };
  }
  if (body.length > MAX_BYTES) {
    return { ok: false, error: { code: 'error.install.tooLarge', message: `That download is over the ${String(MAX_BYTES / 1024 / 1024)} MB limit.` } };
  }
  return { ok: true, body, contentType: response.headers.get('content-type') ?? '' };
}

/**
 * Reject an entry path that could escape the bundle directory.
 * @param name - path as recorded in the archive.
 * @returns whether it is a plain relative path.
 */
function safeRelativePath(name: string): boolean {
  const normalized = name.split('\\').join('/');
  if (normalized.startsWith('/')) return false;
  if (/^[a-zA-Z]:/.test(normalized)) return false;
  const parts = normalized.split('/');
  return !parts.includes('..') && !parts.includes('');
}

/** Read the `name:` value out of a frontmatter block, without a YAML dependency. */
function frontmatterName(text: string): string | undefined {
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (match === null) return undefined;
  for (const line of (match[1] ?? '').split(/\r?\n/)) {
    const pair = /^name:\s*(.+?)\s*$/.exec(line);
    if (pair === null) continue;
    const raw = (pair[1] ?? '').replace(/^["']|["']$/g, '');
    return raw === '' ? undefined : raw;
  }
  return undefined;
}

/**
 * Turn archive entries into the skills they contain.
 *
 * A skill is a `SKILL.md` and whatever sits beside it, so the archive is grouped by
 * the directory each `SKILL.md` lives in. The single top-level folder a GitHub
 * archive adds (`repo-ref/`) is stripped first, so a repository containing one skill
 * at its root installs as that skill rather than as `repo-main`.
 *
 * @param entries - files read from the archive.
 * @param subPath - a path inside the repository to narrow the search to.
 * @returns the bundles to write, or why none could be formed.
 */
function bundlesFromArchive(
  entries: readonly { name: string; data: Buffer }[],
  subPath: string,
): { ok: true; bundles: PendingBundle[]; skipped: number } | { ok: false; error: { code: string; message: string } } {
  const files = entries.filter((entry) => safeRelativePath(entry.name));
  const skippedUnsafe = entries.length - files.length;
  if (files.length === 0) {
    return { ok: false, error: { code: 'error.install.empty', message: 'The archive contained no usable files.' } };
  }

  // Strip the wrapper folder when every path shares one.
  const firstSegments = new Set(files.map((entry) => entry.name.split('/')[0] ?? ''));
  const hasWrapper = firstSegments.size === 1 && files.every((entry) => entry.name.includes('/'));
  const stripWrapper = (name: string): string => {
    if (!hasWrapper) return name;
    const cut = name.indexOf('/');
    return cut < 0 ? name : name.slice(cut + 1);
  };

  let scoped = files.map((entry) => ({ ...entry, name: stripWrapper(entry.name) }));
  if (subPath !== '') {
    const prefix = subPath.endsWith('/') ? subPath : `${subPath}/`;
    scoped = scoped.filter((entry) => entry.name.startsWith(prefix)).map((entry) => ({ ...entry, name: entry.name.slice(prefix.length) }));
    if (scoped.length === 0) {
      return { ok: false, error: { code: 'error.install.path', message: `Nothing was found under "${subPath}" in that repository.` } };
    }
  }

  // Group by the directory holding each SKILL.md.
  const byDirectory = new Map<string, PendingFile[]>();
  for (const entry of scoped) {
    const segments = entry.name.split('/');
    const file = segments[segments.length - 1] ?? '';
    const directory = segments.slice(0, -1).join('/');
    if (file !== 'SKILL.md') continue;
    if (!byDirectory.has(directory)) byDirectory.set(directory, []);
  }
  if (byDirectory.size === 0) {
    return { ok: false, error: { code: 'error.install.noSkill', message: 'No SKILL.md was found in that download.' } };
  }

  let skipped = skippedUnsafe;
  for (const entry of scoped) {
    const segments = entry.name.split('/');
    const directory = segments.slice(0, -1).join('/');
    const bucket = byDirectory.get(directory);
    if (bucket === undefined) {
      skipped += 1;
      continue;
    }
    if (bucket.length >= MAX_FILES_PER_BUNDLE) {
      skipped += 1;
      continue;
    }
    bucket.push({ relative: segments[segments.length - 1] ?? entry.name, data: entry.data });
  }

  const bundles: PendingBundle[] = [];
  for (const [directory, files2] of byDirectory) {
    const fallbackName = directory === '' ? '' : (directory.split('/').pop() ?? '');
    const skillFile = files2.find((file) => file.relative === 'SKILL.md');
    const declared = skillFile === undefined ? undefined : frontmatterName(skillFile.data.toString('utf8'));
    const name = (declared ?? fallbackName).trim();
    if (name === '') {
      return { ok: false, error: { code: 'error.install.name', message: 'A SKILL.md in that download has no name and its folder is unnamed.' } };
    }
    const check = checkName(name, name);
    if (!check.valid) {
      return {
        ok: false,
        error: { code: 'error.install.name', message: `That download contains a skill named "${name}", which DSH cannot load.` },
      };
    }
    bundles.push({ name, files: files2, source: 'repository' });
  }

  return { ok: true, bundles, skipped };
}

/** Turn a single markdown document into a one-file bundle. */
function bundleFromDocument(body: Buffer, source: Source): { ok: true; bundle: PendingBundle } | { ok: false; error: { code: string; message: string } } {
  const text = body.toString('utf8');
  const trimmed = text.trimStart();
  if (trimmed.toLowerCase().startsWith('<!doctype html') || trimmed.toLowerCase().startsWith('<html')) {
    return {
      ok: false,
      error: { code: 'error.install.html', message: 'That link returned a web page, not a skill file. Use the repository link, or the file\'s "Raw" address.' },
    };
  }
  const declared = frontmatterName(text);
  if (declared === undefined) {
    return { ok: false, error: { code: 'error.install.frontmatter', message: 'That file has no frontmatter block with a name.' } };
  }
  const check = checkName(declared, declared);
  if (!check.valid) {
    return { ok: false, error: { code: 'error.install.name', message: `The skill is named "${declared}", which DSH cannot load.` } };
  }
  const parsed = parseSkillDoc(text);
  if (parsed.description === undefined || parsed.description === '') {
    return { ok: false, error: { code: 'error.install.description', message: 'That skill has no description, which DSH requires.' } };
  }
  void source;
  return { ok: true, bundle: { name: declared, files: [{ relative: 'SKILL.md', data: Buffer.from(text, 'utf8') }], source: 'document' } };
}

/**
 * Look up a repository's default branch.
 * @param owner - repository owner.
 * @param repo - repository name.
 * @returns the branch name, or why it could not be read.
 */
async function defaultBranch(owner: string, repo: string): Promise<{ ok: true; branch: string } | { ok: false; error: { code: string; message: string } }> {
  const api = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  let response: Response;
  try {
    response = await fetch(api, {
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'dsh-skill-center' },
    });
  } catch (error) {
    const cause = (error as { cause?: { code?: string } }).cause;
    return { ok: false, error: { code: 'error.install.fetch', message: `GitHub could not be reached (${String(cause?.code ?? (error as Error).message)}).` } };
  }
  if (response.status === 404) {
    return { ok: false, error: { code: 'error.install.status', message: `No public repository "${owner}/${repo}" was found.` } };
  }
  if (!response.ok) {
    return { ok: false, error: { code: 'error.install.status', message: `GitHub answered ${String(response.status)} for "${owner}/${repo}".` } };
  }
  try {
    const payload = (await response.json()) as { default_branch?: unknown };
    const branch = typeof payload.default_branch === 'string' ? payload.default_branch : '';
    if (branch === '') {
      return { ok: false, error: { code: 'error.install.github', message: `"${owner}/${repo}" has no default branch.` } };
    }
    return { ok: true, branch };
  } catch {
    return { ok: false, error: { code: 'error.install.status', message: 'GitHub returned an unreadable answer.' } };
  }
}

/**
 * Download a skill and write it into a skills root.
 * @param request - the URL, the target root, and the names already there.
 * @returns the written skills, or the reason nothing was written.
 */
export async function installFromUrl(request: InstallRequest): Promise<InstallResult> {
  const classified = classify(request.url);
  if (!classified.ok) return { ok: false, error: classified.error };
  const { source } = classified;

  // A repository download needs a ref before codeload will serve it.
  let archiveUrl: string;
  if (source.kind === 'repository') {
    let ref = source.ref;
    if (source.refKind === 'default') {
      const resolved = await defaultBranch(source.owner, source.repo);
      if (!resolved.ok) return { ok: false, error: resolved.error };
      ref = resolved.branch;
    }
    archiveUrl = `https://codeload.github.com/${source.owner}/${source.repo}/zip/refs/heads/${encodeURIComponent(ref)}`;
  } else {
    archiveUrl = source.url;
  }

  const fetched = await download(archiveUrl);
  if (!fetched.ok) return { ok: false, error: fetched.error };

  // The declared kind is a hint; the payload decides. A repository archive is
  // always one, a raw file never is, and an arbitrary link is whatever arrived.
  const isArchive = source.kind === 'repository' ? true : source.kind === 'document' ? false : looksLikeArchive(fetched.body);
  const sourceKind: InstalledSkill['source'] =
    source.kind === 'repository' ? 'repository' : isArchive ? 'archive' : 'document';

  let pending: { bundles: PendingBundle[]; skipped: number };
  if (isArchive) {
    const archive = readZip(fetched.body);
    if (!archive.ok) return { ok: false, error: archive.error };
    if (archive.entries.length > MAX_ENTRIES) {
      return { ok: false, error: { code: 'error.install.tooManyEntries', message: `That archive holds ${String(archive.entries.length)} files, over the ${String(MAX_ENTRIES)} limit.` } };
    }
    const formed = bundlesFromArchive(archive.entries, source.kind === 'repository' ? source.subPath : '');
    if (!formed.ok) return { ok: false, error: formed.error };
    pending = { bundles: formed.bundles.map((bundle) => ({ ...bundle, source: sourceKind })), skipped: formed.skipped };
  } else {
    const made = bundleFromDocument(fetched.body, source);
    if (!made.ok) return { ok: false, error: made.error };
    pending = { bundles: [{ ...made.bundle, source: 'document' }], skipped: 0 };
  }

  // Validate everything before writing anything, so a refusal cannot leave a
  // half-installed skill behind.
  const taken = new Set(request.existingNames.map((name) => name.toLowerCase()));
  const seen = new Set<string>();
  for (const bundle of pending.bundles) {
    const lower = bundle.name.toLowerCase();
    if (taken.has(lower)) {
      return { ok: false, error: { code: 'error.install.exists', message: `A skill named "${bundle.name}" is already installed; nothing was written.` } };
    }
    if (seen.has(lower)) {
      return { ok: false, error: { code: 'error.install.duplicate', message: `That download contains two skills named "${bundle.name}".` } };
    }
    seen.add(lower);
    const skill = bundle.files.find((file) => file.relative === 'SKILL.md');
    if (skill === undefined) {
      return { ok: false, error: { code: 'error.install.noSkill', message: `The bundle "${bundle.name}" has no SKILL.md.` } };
    }
    const parsed = parseSkillDoc(skill.data.toString('utf8'));
    if (parsed.description === undefined || parsed.description === '') {
      return { ok: false, error: { code: 'error.install.description', message: `The skill "${bundle.name}" has no description, which DSH requires.` } };
    }
  }

  const written: InstalledSkill[] = [];
  for (const bundle of pending.bundles) {
    const directory = join(request.targetRoot, bundle.name);
    try {
      await mkdir(directory, { recursive: true });
      for (const file of bundle.files) {
        const target = join(directory, ...file.relative.split('/'));
        await mkdir(join(target, '..'), { recursive: true });
        await writeFile(target, file.data);
      }
      await stat(directory);
    } catch {
      return { ok: false, error: { code: 'error.install.write', message: `"${bundle.name}" could not be written to ${request.targetRoot}.` } };
    }
    written.push({ name: bundle.name, directory, files: bundle.files.length, source: bundle.source });
  }

  return { ok: true, skills: written, skipped: pending.skipped };
}
