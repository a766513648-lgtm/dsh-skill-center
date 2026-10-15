/**
 * Durable enable/disable state for Skill Center.
 *
 * The state file records only the *disabled* skill names per root, so an
 * untouched skill is enabled and a fresh install needs no file at all. Writes
 * are atomic (temp file + rename) and validated on read: a corrupt or
 * unreadable document degrades to "everything enabled" with a warning rather
 * than taking the panel down.
 *
 * @module core/store
 */

import { mkdir, readFile, rename, rm, lstat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** Serialized document version; bumped only on an incompatible layout change. */
const STATE_VERSION = 1;

/** Upper bound on remembered roots, so a hostile file cannot exhaust memory. */
const MAX_ROOTS = 32;

/** Upper bound on remembered names per root. */
const MAX_NAMES_PER_ROOT = 5000;

/** One root's disabled skill names. */
interface RootState {
  /** Skill names (as addressed by the registry) that are turned off. */
  disabled: Set<string>;
}

/** Whole-document state. */
export interface SkillCenterState {
  /** Disabled names keyed by root identifier. */
  readonly roots: Map<string, RootState>;
  /** Non-fatal problem encountered while loading, if any. */
  readonly warning?: { code: string; message: string };
}

/** Where the state lives for one DSH home. */
export function skillCenterHome(dshHome: string): string {
  return join(dshHome, 'skill-center');
}

/** Path of the state document for one DSH home. */
export function stateFilePath(dshHome: string): string {
  return join(skillCenterHome(dshHome), 'state.json');
}

/** An empty state: every discovered skill is enabled. */
export function emptyState(): SkillCenterState {
  return { roots: new Map() };
}

/** Reject names that could not address a skill, so a bad file cannot smuggle keys. */
function usableName(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 && !value.includes('/') && !value.includes('\\');
}

/**
 * Validate and decode a parsed JSON document.
 * @param value - the value returned by `JSON.parse`.
 * @returns the decoded state, or undefined when the document is not usable.
 */
function decodeDocument(value: unknown): SkillCenterState | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const document = value as { version?: unknown; roots?: unknown };
  if (document.version !== STATE_VERSION) return undefined;
  if (typeof document.roots !== 'object' || document.roots === null) return undefined;

  const roots = new Map<string, RootState>();
  for (const [key, entry] of Object.entries(document.roots as Record<string, unknown>)) {
    if (roots.size >= MAX_ROOTS) break;
    if (typeof key !== 'string' || key.length === 0 || key.length > 128) continue;
    if (!Array.isArray(entry)) continue;
    const disabled = new Set<string>();
    for (const name of entry) {
      if (disabled.size >= MAX_NAMES_PER_ROOT) break;
      if (usableName(name)) disabled.add(name);
    }
    roots.set(key, { disabled });
  }
  return { roots };
}

/**
 * Load the state document, degrading to an empty state on any failure.
 * @param dshHome - the DSH home directory that owns the state.
 * @returns the loaded state plus a warning when it could not be read.
 */
export async function loadState(dshHome: string): Promise<SkillCenterState> {
  const file = stateFilePath(dshHome);
  let raw: string;
  try {
    const info = await lstat(file);
    if (info.isSymbolicLink() || !info.isFile()) {
      return { roots: new Map(), warning: { code: 'warning.state.unsafe', message: 'The state file is not a regular file, so it was ignored.' } };
    }
    if (info.size > 4 << 20) {
      return { roots: new Map(), warning: { code: 'warning.state.tooLarge', message: 'The state file is unexpectedly large, so it was ignored.' } };
    }
    raw = await readFile(file, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return emptyState();
    return { roots: new Map(), warning: { code: 'warning.state.unreadable', message: 'The state file could not be read; every skill is treated as enabled.' } };
  }

  try {
    const decoded = decodeDocument(JSON.parse(raw));
    if (decoded === undefined) {
      return { roots: new Map(), warning: { code: 'warning.state.corrupt', message: 'The state file has an unsupported shape; every skill is treated as enabled.' } };
    }
    return decoded;
  } catch {
    return { roots: new Map(), warning: { code: 'warning.state.corrupt', message: 'The state file is not valid JSON; every skill is treated as enabled.' } };
  }
}

/**
 * Test whether one skill is currently disabled.
 *
 * The flag is remembered against the skill's name as well as its root, so a
 * skill stays switched off when the directory it lives in changes — moving
 * `~/.dsh/skills` to a configured `customSkillDirs` root is exactly that, and
 * matching on the root alone would silently switch everything back on.
 * @param state - loaded state.
 * @param rootKey - root identifier, e.g. `dsh` or `custom:0`.
 * @param name - skill name.
 * @returns whether the skill is turned off.
 */
export function isDisabled(state: SkillCenterState, rootKey: string, name: string): boolean {
  if (state.roots.get(rootKey)?.disabled.has(name) === true) return true;
  // Fall back to any other root that remembers this name, which is what keeps a
  // moved skill switched off.
  for (const [key, entry] of state.roots) {
    if (key !== rootKey && entry.disabled.has(name)) return true;
  }
  return false;
}

/**
 * Return a copy of the state with one skill's flag changed.
 *
 * The change is written under the given root and cleared from every other root
 * that remembered the same name, so a skill moved between roots ends up with one
 * consistent answer instead of a stale one pointing at where it used to live.
 * @param state - loaded state; not mutated.
 * @param rootKey - root identifier.
 * @param name - skill name.
 * @param disabled - the desired flag.
 * @returns the updated state.
 */
export function withDisabled(state: SkillCenterState, rootKey: string, name: string, disabled: boolean): SkillCenterState {
  const roots = new Map(state.roots);
  for (const [key, entry] of roots) {
    if (key === rootKey || !entry.disabled.has(name)) continue;
    const next = new Set(entry.disabled);
    next.delete(name);
    if (next.size === 0) roots.delete(key);
    else roots.set(key, { disabled: next });
  }
  const current = roots.get(rootKey) ?? { disabled: new Set<string>() };
  const next = new Set(current.disabled);
  if (disabled) next.add(name);
  else next.delete(name);
  if (next.size === 0) roots.delete(rootKey);
  else roots.set(rootKey, { disabled: next });
  return { roots };
}

/** Encode the state for disk, sorting keys so the file diffs cleanly. */
function encodeDocument(state: SkillCenterState): string {
  const roots: Record<string, string[]> = {};
  for (const key of [...state.roots.keys()].sort()) {
    const entry = state.roots.get(key);
    if (entry === undefined || entry.disabled.size === 0) continue;
    roots[key] = [...entry.disabled].sort();
  }
  return `${JSON.stringify({ version: STATE_VERSION, roots }, null, 2)}\n`;
}

/**
 * Persist the state atomically.
 * @param dshHome - the DSH home directory that owns the state.
 * @param state - the state to write.
 * @returns nothing; throws when the write cannot be completed.
 */
export async function saveState(dshHome: string, state: SkillCenterState): Promise<void> {
  const home = skillCenterHome(dshHome);
  const file = stateFilePath(dshHome);
  await mkdir(home, { recursive: true });
  const info = await lstat(home);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('The Skill Center state directory is not a real directory.');

  const temporary = join(dirname(file), `.state-${process.pid}-${Date.now()}.tmp`);
  try {
    await writeFile(temporary, encodeDocument(state), { encoding: 'utf8', flag: 'wx' });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}
