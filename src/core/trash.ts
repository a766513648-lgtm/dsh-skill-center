/**
 * Moving a skill out of its root and putting it back.
 *
 * Deleting a skill is the one operation here that destroys something the user
 * wrote, so it is implemented the recoverable way: the bundle directory (or the
 * flat markdown file) is *moved* into a trash directory beside the state file, and
 * a record remembers where it came from. Nothing is ever unlinked, so a mistake
 * costs a click rather than a file.
 *
 * Two properties are defended explicitly, because both are the kind of mistake
 * that is only noticed after it matters:
 *
 * - **Only DSH's own skills are touched.** A project-scoped root is refused, so a
 *   skill committed into a repository is never moved out from under version
 *   control, and other agents' directories (`~/.claude/skills`, `~/.codex/...`)
 *   are never roots here at all.
 * - **Only skills DSH can actually load are touched.** A skill with broken
 *   frontmatter may have been misread; that is a reason to fix it or leave it
 *   alone, not a reason to move it.
 *
 * @module core/trash
 */

import { cp, lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { skillCenterHome } from './store.ts';

/** Bookkeeping version; a document with another version is ignored, not guessed at. */
export const TRASH_VERSION = 1;

/** One skill that was moved out of a root. */
export interface TrashEntry {
  /** Stable identifier used to restore it. */
  readonly id: string;
  /** Skill name at the time it was removed. */
  readonly name: string;
  /** Root identifier it was removed from. */
  readonly rootKey: string;
  /** Absolute path it will be restored to. */
  readonly originalPath: string;
  /** Where it sits now, relative to the trash directory. */
  readonly storedName: string;
  /** Whether it was a directory bundle or a flat markdown file. */
  readonly kind: 'bundle' | 'flat';
  /** When it was removed, ISO 8601. */
  readonly removedAt: string;
}

/** Why an operation was refused. */
export interface TrashRefusal {
  /** Stable code the browser localizes. */
  readonly code: string;
  /** English explanation. */
  readonly message: string;
}

/** Result of a mutating operation. */
export type TrashResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: TrashRefusal };

/** What the caller wants removed. */
export interface DeleteRequest {
  /** Absolute skills root the skill currently sits in. */
  readonly rootPath: string;
  /** Root identifier, remembered so the panel can address it after a restore. */
  readonly rootKey: string;
  /** Whether the root belongs to the current project. */
  readonly scope: 'user' | 'project';
  /** Skill name. */
  readonly name: string;
  /** Instruction file path reported by the scan. */
  readonly path: string;
  /** Bundle or flat file. */
  readonly kind: 'bundle' | 'flat';
  /** Whether DSH can load the skill; a skill that cannot be loaded is refused. */
  readonly loadable: boolean;
}

/** Trash directory for one DSH home. */
export function trashHome(dshHome: string): string {
  return join(skillCenterHome(dshHome), 'trash');
}

/** Path of the bookkeeping document. */
export function trashIndexPath(dshHome: string): string {
  return join(trashHome(dshHome), 'index.json');
}

/** Compare paths the way this platform's file system does. */
function identity(path: string): string {
  return process.platform === 'win32' ? path.toLowerCase() : path;
}

/**
 * Move a file or directory, falling back to copy-then-delete.
 *
 * `rename` fails across volumes — on Windows a profile on `C:` and a skills root on
 * another drive is an ordinary setup, and the trash lives beside the state file. A
 * plain move therefore cannot be assumed, so a failed rename is retried as copy
 * followed by removal of the source. The copy comes first on purpose: if it fails
 * partway the original is still there, which is the right failure for a delete.
 *
 * @param from - absolute source path.
 * @param to - absolute destination path.
 * @returns whether the content now exists only at `to`.
 */
async function relocate(from: string, to: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    await rename(from, to);
    return { ok: true };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'unknown';
    // Anything other than a cross-device rename is worth trying the copy path for
    // too: some Windows configurations report EPERM or EACCES for the same cause.
    try {
      await cp(from, to, { recursive: true, errorOnExist: true, force: false });
    } catch (copyError) {
      return { ok: false, reason: `rename ${code}, copy ${(copyError as NodeJS.ErrnoException).code ?? 'failed'}` };
    }
    try {
      await rm(from, { recursive: true, force: false });
    } catch (removeError) {
      // The copy exists but the original could not be removed. Leaving both is a
      // duplicated skill, not a lost one, so it is reported rather than hidden.
      return { ok: false, reason: `copied but could not remove the original (${(removeError as NodeJS.ErrnoException).code ?? 'failed'})` };
    }
    return { ok: true };
  }
}

/** Whether `child` is inside `parent` (or is `parent`), by path containment. */
function contains(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Load the trash index.
 *
 * A document that cannot be read or parsed yields an empty index plus a warning:
 * the files are still on disk, so refusing to show *anything* would be worse than
 * showing an empty list with a note.
 * @param dshHome - resolved DSH home.
 * @returns the entries and an optional warning.
 */
export async function loadTrash(dshHome: string): Promise<{ entries: TrashEntry[]; warning?: TrashRefusal }> {
  let raw: string;
  try {
    raw = await readFile(trashIndexPath(dshHome), 'utf8');
  } catch {
    return { entries: [] };
  }
  try {
    const parsed = JSON.parse(raw) as { version?: unknown; entries?: unknown };
    if (parsed.version !== TRASH_VERSION || !Array.isArray(parsed.entries)) {
      return {
        entries: [],
        warning: { code: 'warning.trash.version', message: 'The trash index was written by another version and is shown as empty.' },
      };
    }
    const entries: TrashEntry[] = [];
    for (const item of parsed.entries) {
      const entry = usableEntry(item, dshHome);
      if (entry !== undefined) entries.push(entry);
    }
    return { entries };
  } catch {
    return {
      entries: [],
      warning: { code: 'warning.trash.corrupt', message: 'The trash index is not valid JSON; recoverable skills are listed as empty.' },
    };
  }
}

/**
 * Accept one stored record only if it is well formed and cannot escape the trash.
 * @param value - raw record from the document.
 * @param dshHome - resolved DSH home.
 * @returns the record, or undefined when it must be dropped.
 */
function usableEntry(value: unknown, dshHome: string): TrashEntry | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  const strings = ['id', 'name', 'rootKey', 'originalPath', 'storedName', 'kind', 'removedAt'] as const;
  for (const key of strings) {
    if (typeof raw[key] !== 'string' || (raw[key] as string) === '') return undefined;
  }
  const kind = raw.kind;
  if (kind !== 'bundle' && kind !== 'flat') return undefined;
  // The stored name must stay inside the trash directory: a record is data on disk
  // and must not be able to point the restore at somewhere else.
  const storedName = raw.storedName as string;
  if (storedName.includes('/') || storedName.includes('\\') || storedName === '.' || storedName === '..') return undefined;
  if (!contains(trashHome(dshHome), join(trashHome(dshHome), storedName))) return undefined;
  return {
    id: raw.id as string,
    name: raw.name as string,
    rootKey: raw.rootKey as string,
    originalPath: resolve(raw.originalPath as string),
    storedName,
    kind,
    removedAt: raw.removedAt as string,
  };
}

/** Write the index, creating the trash directory if needed. */
async function saveTrash(dshHome: string, entries: readonly TrashEntry[]): Promise<void> {
  await mkdir(trashHome(dshHome), { recursive: true });
  const document = `${JSON.stringify({ version: TRASH_VERSION, entries }, null, 2)}\n`;
  const target = trashIndexPath(dshHome);
  const temporary = `${target}.tmp`;
  await writeFile(temporary, document, 'utf8');
  await rename(temporary, target);
}

/** Build an identifier that sorts by time and cannot collide within a run. */
function newId(now: Date, seed: string): string {
  const stamp = now.toISOString().replace(/[-:.]/g, '').slice(0, 15);
  return `${stamp}-${seed}`;
}

/**
 * Move one skill into the trash.
 *
 * Everything is checked before anything moves: the source must be exactly where the
 * scan said it was, inside the root it was reported under, and must not be a
 * symbolic link or a Windows junction. A move that cannot be completed leaves the
 * skill where it was.
 *
 * @param params - the DSH home and what to remove.
 * @returns the new entry, or a refusal.
 */
export async function moveToTrash(params: {
  dshHome: string;
  request: DeleteRequest;
  now?: Date;
}): Promise<TrashResult<TrashEntry>> {
  const { dshHome, request } = params;
  const now = params.now ?? new Date();

  // Gate 1: project-scoped skills are never moved out of a repository.
  if (request.scope !== 'user') {
    return { ok: false, error: { code: 'error.delete.project', message: 'Skills inside a project are managed by that project and are not removed here.' } };
  }

  // Gate 2: a skill DSH cannot load may have been misread; do not act on it.
  if (!request.loadable) {
    return { ok: false, error: { code: 'error.delete.unloadable', message: 'This skill cannot be loaded, so it is not removed. Fix or remove it by hand.' } };
  }

  const rootPath = resolve(request.rootPath);
  const filePath = resolve(request.path);

  // Gate 3: the file must be inside the root it was reported under.
  if (!contains(rootPath, filePath)) {
    return { ok: false, error: { code: 'error.delete.outsideRoot', message: 'The skill is not inside the skills directory it was reported under.' } };
  }

  const target = request.kind === 'bundle' ? dirname(filePath) : filePath;
  if (!contains(rootPath, target) || target === rootPath) {
    return { ok: false, error: { code: 'error.delete.outsideRoot', message: 'The skill is not inside the skills directory it was reported under.' } };
  }

  // Gate 4: the root itself must be a real directory, not a link or a junction.
  try {
    const rootInfo = await lstat(rootPath);
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
      return { ok: false, error: { code: 'error.delete.rootUnsafe', message: 'The skills directory is not a real directory.' } };
    }
    // The same canonical-form comparison as the bundle gate below, and for the same
    // reason: on Windows `resolve` preserves an 8.3 short name while `realpath`
    // expands it (`C:\Users\RUNNER~1\...`), so comparing a canonical path with a
    // resolved one compares spellings, not locations, and refuses an ordinary
    // directory. A junction still differs from its canonical form.
    const [resolvedRoot, resolvedRootParent] = await Promise.all([realpath(rootPath), realpath(dirname(rootPath))]);
    if (identity(resolvedRoot) !== identity(join(resolvedRootParent, basename(rootPath)))) {
      return { ok: false, error: { code: 'error.delete.rootUnsafe', message: 'The skills directory resolves to another location.' } };
    }
  } catch {
    return { ok: false, error: { code: 'error.delete.missing', message: 'The skills directory no longer exists.' } };
  }

  // Gate 5: the skill itself must be a real file or directory, not a link.
  try {
    const info = await lstat(target);
    if (info.isSymbolicLink()) {
      return { ok: false, error: { code: 'error.delete.symlink', message: 'This skill is a symbolic link and is not moved.' } };
    }
  } catch {
    return { ok: false, error: { code: 'error.delete.missing', message: 'The skill is no longer on disk; refresh the list.' } };
  }

  // Gate 6: for a *directory* bundle, the resolved location must still be the place
  // it claims to be. On Windows a junction reports as an ordinary directory and
  // `lstat` cannot see it, so a bundle that looks local can actually redirect
  // somewhere else — and moving it would take the target with it.
  //
  // This runs only for directories: a file cannot be a junction, so for a flat skill
  // `lstat` has already answered the question. Both sides are canonicalised, because
  // comparing a canonical path with a merely resolved one compares spellings rather
  // than locations and trips over Windows 8.3 short names (`C:\Users\RUNNER~1\...`).
  if (request.kind === 'bundle') {
    try {
      const parent = dirname(target);
      const [resolvedParent, resolvedTarget] = await Promise.all([realpath(parent), realpath(target)]);
      // A junction has its own canonical path, so it no longer equals the canonical
      // parent joined with its name. An ordinary subdirectory still does.
      if (identity(resolvedTarget) !== identity(join(resolvedParent, basename(target)))) {
        return {
          ok: false,
          error: { code: 'error.delete.symlink', message: 'This skill resolves to another location and is not moved.' },
        };
      }
    } catch {
      return { ok: false, error: { code: 'error.delete.missing', message: 'The skill is no longer on disk; refresh the list.' } };
    }
  }

  const trashDir = trashHome(dshHome);
  try {
    await mkdir(trashDir, { recursive: true });
  } catch {
    return { ok: false, error: { code: 'error.delete.trash', message: 'The trash directory could not be created.' } };
  }

  // The trash must be a real directory too, or a link there would redirect the move.
  try {
    const info = await lstat(trashDir);
    if (info.isSymbolicLink()) {
      return { ok: false, error: { code: 'error.delete.trash', message: 'The trash directory is a symbolic link.' } };
    }
  } catch {
    return { ok: false, error: { code: 'error.delete.trash', message: 'The trash directory could not be read.' } };
  }

  const entry: TrashEntry = {
    id: newId(now, Math.random().toString(36).slice(2, 8)),
    name: request.name,
    rootKey: request.rootKey,
    originalPath: target,
    storedName: `${now.getTime()}-${request.name}`,
    kind: request.kind,
    removedAt: now.toISOString(),
  };

  const stored = join(trashDir, entry.storedName);
  try {
    const existing = await lstat(stored);
    void existing;
    return { ok: false, error: { code: 'error.delete.trash', message: 'A stored copy already exists; try again.' } };
  } catch {
    // Not there: the expected case.
  }

  const moved = await relocate(target, stored);
  if (!moved.ok) {
    return { ok: false, error: { code: 'error.delete.move', message: `The skill could not be moved into the trash; it is unchanged (${moved.reason}).` } };
  }

  const loaded = await loadTrash(dshHome);
  try {
    await saveTrash(dshHome, [...loaded.entries, entry]);
  } catch {
    // The skill moved but was not recorded. Put it back rather than leave it in a
    // directory nothing knows about.
    const rollback = await relocate(stored, target);
    if (!rollback.ok) {
      return { ok: false, error: { code: 'error.delete.rollback', message: 'The skill was moved but could not be recorded or put back.' } };
    }
    return { ok: false, error: { code: 'error.delete.record', message: 'The move could not be recorded; the skill is unchanged.' } };
  }

  return { ok: true, value: entry };
}

/**
 * Put a stored skill back where it came from.
 * @param params - the DSH home and the entry id to restore.
 * @returns the restored entry, or a refusal.
 */
export async function restoreFromTrash(params: { dshHome: string; id: string }): Promise<TrashResult<TrashEntry>> {
  const { dshHome, id } = params;
  const loaded = await loadTrash(dshHome);
  const entry = loaded.entries.find((item) => item.id === id);
  if (entry === undefined) {
    return { ok: false, error: { code: 'error.restore.unknown', message: 'That entry is no longer in the trash; refresh the list.' } };
  }

  const stored = join(trashHome(dshHome), entry.storedName);
  try {
    await lstat(stored);
  } catch {
    return { ok: false, error: { code: 'error.restore.missing', message: 'The stored copy is gone; there is nothing to restore.' } };
  }

  try {
    await lstat(entry.originalPath);
    return {
      ok: false,
      error: { code: 'error.restore.occupied', message: 'Something already exists at the original path; it was left alone.' },
    };
  } catch {
    // Not there: the expected case.
  }

  try {
    await mkdir(dirname(entry.originalPath), { recursive: true });
  } catch {
    return { ok: false, error: { code: 'error.restore.move', message: 'The skill could not be moved back.' } };
  }
  // Same cross-volume problem as deleting: the trash and the skills root need not
  // share a drive, so restoring cannot rely on `rename` either.
  const back = await relocate(stored, entry.originalPath);
  if (!back.ok) {
    return { ok: false, error: { code: 'error.restore.move', message: `The skill could not be moved back (${back.reason}).` } };
  }

  const remaining = loaded.entries.filter((item) => item.id !== id);
  try {
    await saveTrash(dshHome, remaining);
  } catch {
    return { ok: false, error: { code: 'error.restore.record', message: 'The skill was put back but the trash index could not be updated.' } };
  }

  return { ok: true, value: entry };
}

/**
 * Delete everything in the trash for good.
 * @param dshHome - resolved DSH home.
 * @returns how many entries were removed.
 */
export async function emptyTrash(dshHome: string): Promise<TrashResult<{ removed: number }>> {
  const trashDir = trashHome(dshHome);
  const loaded = await loadTrash(dshHome);

  // Refuse to wipe a path that is not the trash directory this module owns.
  if (!contains(skillCenterHome(dshHome), trashDir)) {
    return { ok: false, error: { code: 'error.trash.outside', message: 'The trash directory is outside the Skill Center directory.' } };
  }

  let removed = 0;
  for (const entry of loaded.entries) {
    const stored = join(trashDir, entry.storedName);
    if (!contains(trashDir, stored)) continue;
    try {
      await rm(stored, { recursive: true, force: true });
      removed += 1;
    } catch {
      // Leave it recorded so a failed removal can be retried.
    }
  }

  try {
    await saveTrash(dshHome, []);
  } catch {
    return { ok: false, error: { code: 'error.trash.record', message: 'The trash could not be emptied cleanly.' } };
  }
  return { ok: true, value: { removed } };
}

/**
 * Describe the trash for the panel: the recorded entries plus anything on disk that
 * is not recorded, so an interrupted move is visible instead of invisible.
 * @param dshHome - resolved DSH home.
 * @returns the entries, an optional warning, and whether the directory exists.
 */
export async function readTrash(dshHome: string): Promise<{ entries: TrashEntry[]; exists: boolean; warning?: TrashRefusal }> {
  const loaded = await loadTrash(dshHome);
  const trashDir = trashHome(dshHome);
  let names: string[];
  try {
    names = await readdir(trashDir);
  } catch {
    return { entries: loaded.entries, exists: false, ...(loaded.warning === undefined ? {} : { warning: loaded.warning }) };
  }
  for (const name of names) {
    if (name === 'index.json' || name.endsWith('.tmp')) continue;
    if (loaded.entries.some((entry) => entry.storedName === name)) continue;
    loaded.entries.push({
      id: `unrecorded:${name}`,
      name,
      rootKey: '',
      originalPath: '',
      storedName: name,
      kind: 'bundle',
      removedAt: '',
    });
  }
  return { entries: loaded.entries, exists: true, ...(loaded.warning === undefined ? {} : { warning: loaded.warning }) };
}
