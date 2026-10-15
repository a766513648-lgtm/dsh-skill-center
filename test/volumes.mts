/**
 * Helpers for tests that need two different volumes.
 *
 * The plugin has to move skill directories between the skills root and its trash,
 * and `rename` cannot cross volumes. Proving the copy-then-remove fallback then
 * requires two drives — but which drives exist is a property of the machine, not of
 * the project, so nothing here may name one. The volume is discovered at run time
 * and the tests skip when there is only one.
 *
 * @module test/volumes
 */

import { access, constants, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, parse } from 'node:path';

/** Root of the volume the system temp directory is on, e.g. `C:\`. */
function systemVolume(): string {
  return parse(tmpdir()).root;
}

/** Candidates to check, in a stable order, without naming any machine's drives. */
function candidateRoots(): string[] {
  const roots: string[] = [];
  for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
    roots.push(`${letter}:\\`);
  }
  return roots;
}

/**
 * Find a writable directory on a volume other than the system one.
 *
 * The directory is created under `<other-volume>\dsh-skill-center-test\<name>` and
 * is the caller's to remove. Nothing is created when no second volume is available.
 *
 * @param name - a subdirectory name to keep concurrent tests apart.
 * @returns the directory, or undefined when this machine has a single volume.
 */
export async function otherVolumeDir(name: string): Promise<string | undefined> {
  const system = systemVolume().toLowerCase();
  for (const root of candidateRoots()) {
    if (root.toLowerCase() === system) continue;
    const directory = join(root, 'dsh-skill-center-test', name);
    try {
      await access(root, constants.F_OK);
      await mkdir(directory, { recursive: true });
      // A writable check, so a read-only optical or network drive is skipped.
      await access(directory, constants.W_OK);
      return directory;
    } catch {
      continue;
    }
  }
  return undefined;
}
