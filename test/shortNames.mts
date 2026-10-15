/**
 * Find a path spelling that uses a Windows 8.3 short name, without spawning anything.
 *
 * The suite may not spawn a process with piped stdio, so PowerShell is not an option
 * inside a test, and `Add-Type` is not available either. A short name can be found
 * instead by looking for a sibling entry whose name matches the 8.3 shape and is the
 * same file as the long one — a pure `statSync` question.
 *
 * @module test/shortNames
 */

import { readdirSync, statSync } from 'node:fs';
import { dirname, join, parse } from 'node:path';

/** Whether one path is the same file system object as another. */
function sameEntry(left: string, right: string): boolean {
  try {
    const a = statSync(left);
    const b = statSync(right);
    return a.ino !== 0 && a.ino === b.ino && a.dev === b.dev;
  } catch {
    return false;
  }
}

/** Whether a name looks like an 8.3 short name, e.g. `RUNNER~1` or `PROGRA~1`. */
function isShortShape(name: string): boolean {
  return /^[^.]{1,6}~[0-9](\.[^.]{1,3})?$/.test(name);
}

/**
 * Find a short-named sibling that points at the same directory.
 *
 * @param path - an existing directory, or a path inside one.
 * @returns a path to the same directory written with a short component, or undefined
 * when this volume has no 8.3 names (or the entry is already spelled that way).
 */
export function shortNameVariant(path: string): string | undefined {
  let current = path;
  // Walk up a few levels; the short component is usually an ancestor such as
  // `C:\Users\RUNNER~1\AppData\...`.
  for (let depth = 0; depth < 4; depth += 1) {
    const parent = dirname(current);
    if (parent === current) break;
    const wanted = parse(current).base;
    let siblings;
    try {
      siblings = readdirSync(parent);
    } catch {
      break;
    }
    for (const candidate of siblings) {
      if (candidate === wanted || !isShortShape(candidate)) continue;
      const candidatePath = join(parent, candidate);
      if (!sameEntry(candidatePath, current)) continue;
      // Rebuild the original path with this component replaced by its short form.
      const rest = path.slice(current.length);
      const swapped = `${join(parent, candidate)}${rest}`;
      if (swapped !== path) return swapped;
    }
    current = parent;
  }
  return undefined;
}
