/**
 * Turning one skill on or off.
 *
 * Skill Center writes the two frontmatter flags the DSH filesystem provider
 * already understands, rather than keeping a private shadow copy of the skill:
 *
 * - off  → `disable-model-invocation: true` and `user-invocable: false`
 * - on   → both keys removed, so the skill's own defaults apply again
 *
 * The host registry only decides *which* provider wins a skill name; the
 * invocation policy that keeps a skill out of the model catalog and the slash
 * menu is resolved at the consumer boundary, so writing it into the document is
 * what actually switches the skill off — and it survives restarts, other
 * clients, and direct edits.
 *
 * @module core/toggle
 */

import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** Lines that switch the model and command surfaces off. */
const DISABLED_LINES: readonly string[] = ['disable-model-invocation: true', 'user-invocable: false'];

/** Keys this module inserts or removes. */
const MANAGED_KEYS: readonly string[] = ['disable-model-invocation', 'user-invocable'];

/** Result of rewriting one skill document. */
export interface PatchResult {
  /** The rewritten document. */
  readonly text: string;
  /** Whether the text differs from the input. */
  readonly changed: boolean;
  /** Problems that prevent the rewrite. */
  readonly error?: { code: string; message: string };
}

/**
 * Split a document into its frontmatter lines and everything after the block.
 * @param text - the raw document.
 * @returns the block boundaries, or undefined when there is no usable block.
 */
function locateBlock(text: string): { lines: string[]; end: number } | undefined {
  const lines = text.split('\n');
  if ((lines[0] ?? '').trim() !== '---') return undefined;
  for (let index = 1; index < lines.length; index += 1) {
    if ((lines[index] ?? '').trim() === '---') return { lines, end: index };
  }
  return undefined;
}

/**
 * Rewrite a skill document so it is enabled or disabled.
 *
 * The rewrite is confined to the frontmatter block: the closing delimiter is
 * preserved, the body is untouched, and pre-existing keys are stripped so
 * repeated toggles stay idempotent and identical writes are skipped.
 * @param text - the current document.
 * @param disabled - whether the skill should end up switched off.
 * @returns the new text, whether it changed, and any error.
 */
export function applyPatch(text: string, disabled: boolean): PatchResult {
  const block = locateBlock(text);
  if (block === undefined) {
    return {
      text,
      changed: false,
      error: {
        code: 'error.toggle.frontmatter',
        message: 'This skill has no usable frontmatter block, so Skill Center will not rewrite it.',
      },
    };
  }

  const kept: string[] = [];
  for (let index = 1; index < block.end; index += 1) {
    const line = block.lines[index] ?? '';
    const match = /^([A-Za-z0-9_-]+)\s*:/.exec(line);
    const key = match?.[1];
    if (key !== undefined && MANAGED_KEYS.includes(key)) continue;
    kept.push(line);
  }
  if (disabled) kept.push(...DISABLED_LINES);

  const next = ['---', ...kept, '---', ...block.lines.slice(block.end + 1)].join('\n');
  return { text: next, changed: next !== text };
}

/**
 * Apply the toggle to the file on disk, atomically and only when needed.
 * @param filePath - the skill's instruction file.
 * @param disabled - whether the skill should end up switched off.
 * @returns whether the file changed, plus any error.
 */
export async function toggleSkillFile(filePath: string, disabled: boolean): Promise<{ changed: boolean; error?: { code: string; message: string } }> {
  let text: string;
  try {
    text = await readFile(filePath, 'utf8');
  } catch {
    return { changed: false, error: { code: 'error.toggle.unreadable', message: 'The skill file could not be read.' } };
  }

  const patched = applyPatch(text, disabled);
  if (patched.error !== undefined) return { changed: false, error: patched.error };
  if (!patched.changed) return { changed: false };

  const temporary = join(dirname(filePath), `.skill-center-${process.pid}-${Date.now()}.tmp`);
  try {
    await writeFile(temporary, patched.text, { encoding: 'utf8', flag: 'wx' });
    await rename(temporary, filePath);
  } catch {
    await rm(temporary, { force: true }).catch(() => undefined);
    return { changed: false, error: { code: 'error.toggle.write', message: 'The skill file could not be written; it may be read-only.' } };
  }
  return { changed: true };
}
