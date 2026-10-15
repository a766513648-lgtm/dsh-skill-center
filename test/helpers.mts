/**
 * Shared helpers for the test suite.
 *
 * @module test/helpers
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Create a throwaway directory that the caller removes when done. */
export async function makeTempDir(prefix = 'skill-center-'): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

/**
 * Create a throwaway directory at an explicit path.
 *
 * Used by the cross-volume test: `makeTempDir` always lands on the system temp
 * volume, so a case that needs two *different* volumes has to place one by hand.
 * @param path - absolute directory to create.
 * @returns the same path.
 */
export async function makeDirAt(path: string): Promise<string> {
  await mkdir(path, { recursive: true });
  return path;
}

/** Remove a throwaway directory, tolerating an already-missing path. */
export async function removeDir(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true }).catch(() => undefined);
}

/** Write one file, creating parent directories as needed. */
export async function writeFileAt(root: string, relativePath: string, contents: string): Promise<string> {
  const target = join(root, ...relativePath.split('/'));
  await mkdir(join(target, '..'), { recursive: true });
  await writeFile(target, contents, 'utf8');
  return target;
}

/** Create a directory-bundle skill under a skills root. */
export async function writeBundle(root: string, name: string, options: { description?: string; body?: string; extra?: string } = {}): Promise<string> {
  return writeFileAt(root, `${name}/SKILL.md`, skillDoc({ name, ...options }));
}

/** Create a flat-file skill under a skills root. */
export async function writeFlat(root: string, name: string, options: { description?: string; body?: string; extra?: string } = {}): Promise<string> {
  return writeFileAt(root, `${name}.md`, skillDoc({ name, ...options }));
}

/** Build a valid skill document. */
export function skillDoc(options: { name: string; description?: string; body?: string; extra?: string }): string {
  const description = options.description ?? 'A test skill.';
  const body = options.body ?? 'Follow these steps.';
  const extra = options.extra === undefined ? '' : `${options.extra}\n`;
  return `---\nname: ${options.name}\ndescription: ${description}\n${extra}---\n\n${body}\n`;
}
