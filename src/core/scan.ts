/**
 * Discovery of local DSH skills.
 *
 * Skill Center reads the same two roots the DSH filesystem provider scans for
 * user-owned skills: the global `<dshHome>/skills` directory and the current
 * project's `<projectRoot>/.dsh/skills`. Each root contributes directory
 * bundles (`<name>/SKILL.md`) and flat files (`<name>.md`); nested bundles are
 * deliberately not discovered, matching the host provider.
 *
 * @module core/scan
 */

import { lstat, opendir, readFile, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { checkName, parseSkillDoc, SKILL_NAME_RE } from './parse.ts';
import type { Diagnostic } from './parse.ts';

/** A skill whose format is good enough for DSH to load. */
export interface SkillEntry {
  /** Name that addresses the skill in the registry. */
  readonly name: string;
  /** Root identifier, e.g. `dsh` or `project-dsh:<hash>`. */
  readonly rootKey: string;
  /** Localized-elsewhere label for the root. */
  readonly rootLabel: string;
  /** Whether the root is the current project rather than the global home. */
  readonly scope: 'user' | 'project';
  /** Absolute path of the instruction file. */
  readonly path: string;
  /** Whether the skill is a directory bundle or a flat markdown file. */
  readonly kind: 'bundle' | 'flat';
  /** Frontmatter description, already read during the scan. */
  readonly description: string;
  /** Whether the registry can load this skill. */
  readonly loadable: boolean;
  /** Problems found while reading. */
  readonly diagnostics: readonly Diagnostic[];
}

/** One scanned root and its outcome. */
export interface ScannedRoot {
  /** Root identifier. */
  readonly key: string;
  /** Label for the UI. */
  readonly label: string;
  /** Whether this root belongs to the current project. */
  readonly scope: 'user' | 'project';
  /** Absolute directory path. */
  readonly path: string;
  /** The project the root belongs to, when scoped to one. */
  readonly projectRoot?: string;
  /** Whether the directory exists. */
  readonly exists: boolean;
  /** Skills discovered in this root. */
  readonly skills: readonly SkillEntry[];
  /** Non-fatal problem for the whole root, if any. */
  readonly warning?: Diagnostic;
}

/** Result of scanning both roots for one session. */
export interface ScanResult {
  /** Every root considered, in global-then-project order. */
  readonly roots: readonly ScannedRoot[];
}

/** Compare paths the way this platform's file system does. */
function identity(path: string): string {
  return process.platform === 'win32' ? path.toLowerCase() : path;
}

/** Stable short identity for a project path. */
function projectKey(projectRoot: string): string {
  const canonical = process.platform === 'win32' ? projectRoot.toLowerCase() : projectRoot;
  return createHash('sha256').update(canonical).digest('hex').slice(0, 12);
}

/**
 * Read one candidate entry inside a skills root.
 * @param rootDir - absolute skills directory.
 * @param entryName - the directory entry name.
 * @returns the skill, or undefined when the entry is not a skill.
 */
async function readEntry(rootDir: string, entryName: string): Promise<{ entry: Omit<SkillEntry, 'rootKey' | 'rootLabel' | 'scope'> } | undefined> {
  const lower = entryName.toLowerCase();
  const isDirectoryCandidate = lower !== 'skill.md' && !lower.endsWith('.md');
  const flatName = lower.endsWith('.md') && lower !== 'skill.md' ? entryName.slice(0, -3) : undefined;
  const formatName = isDirectoryCandidate ? entryName : flatName;
  if (formatName === undefined || !SKILL_NAME_RE.test(formatName)) return undefined;

  const target = join(rootDir, entryName);
  const docPath = isDirectoryCandidate ? join(target, 'SKILL.md') : target;

  let docInfo;
  try {
    const entryInfo = await lstat(target);
    if (entryInfo.isSymbolicLink()) return undefined;
    if (isDirectoryCandidate && !entryInfo.isDirectory()) return undefined;
    if (!isDirectoryCandidate && !entryInfo.isFile()) return undefined;
    docInfo = await lstat(docPath);
  } catch {
    return undefined;
  }
  if (!docInfo.isFile() || docInfo.isSymbolicLink()) return undefined;

  let text: string;
  try {
    text = await readFile(docPath, 'utf8');
  } catch {
    return {
      entry: {
        name: formatName,
        path: docPath,
        kind: isDirectoryCandidate ? 'bundle' : 'flat',
        description: '',
        loadable: false,
        diagnostics: [
          {
            code: 'error.document.unreadable',
            level: 'error',
            message: 'The instruction file could not be read.',
          },
        ],
      },
    };
  }

  const parsed = parseSkillDoc(text);
  const nameCheck = checkName(parsed.declaredName, formatName);
  const diagnostics: Diagnostic[] = [...parsed.diagnostics];
  if (!nameCheck.valid && nameCheck.diagnostic !== undefined) {
    if (!diagnostics.some((item) => item.code === nameCheck.diagnostic?.code)) diagnostics.push(nameCheck.diagnostic);
  }
  if (nameCheck.valid && parsed.declaredName !== formatName) {
    diagnostics.push({
      code: 'warning.name.mismatch',
      level: 'warning',
      message: `Frontmatter name "${parsed.declaredName}" differs from the entry name "${formatName}"; DSH addresses it as "${parsed.declaredName}".`,
    });
  }

  return {
    entry: {
      name: nameCheck.valid ? parsed.declaredName : formatName,
      path: docPath,
      kind: isDirectoryCandidate ? 'bundle' : 'flat',
      description: parsed.description,
      loadable: nameCheck.valid && parsed.frontmatterClosed && parsed.hasFrontmatter && parsed.description !== '',
      diagnostics,
    },
  };
}

/**
 * Scan one skills root.
 * @param params - root identity and directory.
 * @returns the root's skills sorted by name.
 */
export async function scanRoot(params: {
  key: string;
  label: string;
  scope: 'user' | 'project';
  path: string;
  projectRoot?: string;
}): Promise<ScannedRoot> {
  const base = {
    key: params.key,
    label: params.label,
    scope: params.scope,
    path: params.path,
    ...(params.projectRoot === undefined ? {} : { projectRoot: params.projectRoot }),
  };

  let directory;
  try {
    const info = await lstat(params.path);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      return {
        ...base,
        exists: false,
        skills: [],
        warning: { code: 'warning.root.unsafe', level: 'warning', message: 'The skills directory is not a real directory and was skipped.' },
      };
    }
    // On Windows a junction reports as an ordinary directory and is not a
    // symbolic link, so `lstat` alone cannot see it. The check below catches that
    // redirect (and any other reparse point) before the directory is read.
    //
    // It compares the canonical directory with the canonical *parent* joined to its
    // own name, and that shape matters. A short name is not a redirect but it is a
    // different spelling, so any test built on textual equality trips over it:
    // `C:\Users\RUNNER~1\...\skills` and its realpath are the same location and are
    // never equal as strings. Building the expectation from the canonical parent
    // instead makes this a structural test — an ordinary subdirectory always
    // matches, a junction never does — which is what the gate is actually about.
    const parent = dirname(resolve(params.path));
    const [resolved, resolvedParent] = await Promise.all([
      realpath(params.path),
      realpath(parent).catch(() => parent),
    ]);
    if (identity(resolved) !== identity(join(resolvedParent, basename(resolve(params.path))))) {
      return {
        ...base,
        exists: false,
        skills: [],
        warning: {
          code: 'warning.root.unsafe',
          level: 'warning',
          message: 'The skills directory resolves to another location and was skipped.',
        },
      };
    }
    directory = await opendir(params.path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ...base, exists: false, skills: [] };
    return {
      ...base,
      exists: false,
      skills: [],
      warning: { code: 'warning.root.unreadable', level: 'warning', message: 'The skills directory could not be read.' },
    };
  }

  const names: string[] = [];
  let truncated = false;
  try {
    for await (const item of directory) {
      if (names.length >= 2000) {
        truncated = true;
        break;
      }
      names.push(item.name);
    }
  } catch {
    return {
      ...base,
      exists: true,
      skills: [],
      warning: { code: 'warning.root.unreadable', level: 'warning', message: 'The skills directory could not be fully read.' },
    };
  }

  const settled = await Promise.all(names.sort((a, b) => a.localeCompare(b, 'en')).map((name) => readEntry(params.path, name)));
  const skills: SkillEntry[] = [];
  for (const result of settled) {
    if (result === undefined) continue;
    skills.push({ ...result.entry, rootKey: params.key, rootLabel: params.label, scope: params.scope });
  }
  skills.sort((a, b) => a.name.localeCompare(b.name, 'en'));

  return {
    ...base,
    exists: true,
    skills,
    ...(truncated
      ? { warning: { code: 'warning.root.truncated', level: 'warning', message: 'The directory holds more entries than Skill Center scans.' } as Diagnostic }
      : {}),
  };
}

/**
 * Scan the global and project roots for one session.
 *
 * The global side covers both places skills can live: the default
 * `<dshHome>/skills` and each directory listed in `extraRoots`. The second list
 * exists because DSH's filesystem provider accepts `customSkillDirs`, so a
 * profile can keep its skills somewhere else entirely — a directory the panel
 * has to watch too, or it would list nothing while DSH happily loads them.
 *
 * @param params - the DSH home, any extra skill roots, and the current project root.
 * @returns every root's result, globals first.
 */
export async function scanSkills(params: {
  dshHome: string;
  extraRoots?: readonly string[] | undefined;
  projectRoot?: string | undefined;
}): Promise<ScanResult> {
  const globalPath = join(params.dshHome, 'skills');
  const roots: ScannedRoot[] = [
    await scanRoot({ key: 'dsh', label: 'DSH skills', scope: 'user', path: globalPath }),
  ];

  for (const [index, directory] of (params.extraRoots ?? []).entries()) {
    if (typeof directory !== 'string' || directory === '') continue;
    roots.push(
      await scanRoot({
        key: `custom:${index}`,
        label: basename(directory) || directory,
        scope: 'user',
        path: directory,
      }),
    );
  }

  const projectRoot = params.projectRoot;
  if (typeof projectRoot === 'string' && projectRoot !== '') {
    let canonical = projectRoot;
    try {
      canonical = await realpath(projectRoot);
    } catch {
      // Keep the reported path; the scan below reports the failure.
    }
    roots.push(
      await scanRoot({
        key: `project-dsh:${projectKey(canonical)}`,
        label: `${basename(canonical) || canonical} (project)`,
        scope: 'project',
        // `canonical` is already the resolved form, so the root check inside
        // `scanRoot` compares like with like instead of reporting a redirect that is
        // only a difference in spelling.
        path: resolve(join(canonical, '.dsh', 'skills')),
        projectRoot: canonical,
      }),
    );
  }

  return { roots };
}
