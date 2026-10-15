/**
 * Wire contract between the host half and the browser half of Skill Center.
 *
 * Both halves import these types, so a change to a response shape breaks the
 * type check on either side instead of failing at runtime in the UI.
 *
 * @module contract
 */

/** One problem attached to a skill. */
export interface DiagnosticView {
  /** Stable code; the browser localizes the codes it knows. */
  readonly code: string;
  /** Whether the skill is unusable or merely suspicious. */
  readonly level: 'error' | 'warning';
  /** English fallback message from the host. */
  readonly message: string;
}

/** One skill as listed in the panel. */
export interface SkillView {
  /** Name that addresses the skill. */
  readonly name: string;
  /** Short routing description. */
  readonly description: string;
  /** Root this entry came from. */
  readonly rootKey: string;
  /** Root label. */
  readonly rootLabel: string;
  /** Whether the root is global or project scoped. */
  readonly scope: 'user' | 'project';
  /** Instruction file path. */
  readonly path: string;
  /** Directory bundle or flat markdown file. */
  readonly kind: 'bundle' | 'flat';
  /** Whether DSH can load this skill at all. */
  readonly loadable: boolean;
  /** Whether Skill Center currently switches it off. */
  readonly disabled: boolean;
  /** Problems found while reading it. */
  readonly diagnostics: readonly DiagnosticView[];
}

/** One scanned skills root. */
export interface RootView {
  /** Root identifier. */
  readonly key: string;
  /** Root label. */
  readonly label: string;
  /** Whether the root is global or project scoped. */
  readonly scope: 'user' | 'project';
  /** Absolute directory path. */
  readonly path: string;
  /** Whether the directory exists. */
  readonly exists: boolean;
  /** Skills found in this root. */
  readonly skills: readonly SkillView[];
  /** Root-level problem, if any. */
  readonly warning?: DiagnosticView;
}

/** Response of `GET /state`. */
export interface StateResponse {
  /** Every root considered for the current session. */
  readonly roots: readonly RootView[];
  /** Counters used by the panel header. */
  readonly summary: {
    /** Skills in total. */
    readonly total: number;
    /** Skills currently switched off. */
    readonly disabled: number;
    /** Skills with at least one diagnostic. */
    readonly issues: number;
  };
  /** The project root the session is scoped to, when known. */
  readonly projectRoot?: string;
  /** Host-level warnings, for example an unreadable state file. */
  readonly warnings: readonly DiagnosticView[];
}

/** Response of `POST /detail`. */
export interface DetailResponse {
  /** Root identifier the skill belongs to. */
  readonly rootKey: string;
  /** The skill's addressing name. */
  readonly name: string;
  /** Frontmatter description. */
  readonly description: string;
  /** Instruction file path. */
  readonly path: string;
  /** Full markdown body after the frontmatter. */
  readonly body: string;
  /** Frontmatter block as written, or an empty string when absent. */
  readonly frontmatter: string;
  /** Problems found while reading it. */
  readonly diagnostics: readonly DiagnosticView[];
  /** Whether Skill Center switches it off. */
  readonly disabled: boolean;
  /** Whether DSH can load it. */
  readonly loadable: boolean;
}

/** Request body of `POST /toggle`. */
export interface ToggleRequest {
  /** Root identifier the skill belongs to. */
  readonly rootKey: string;
  /** Skill name. */
  readonly name: string;
  /** Whether the skill should end up switched off. */
  readonly disabled: boolean;
}

/** Response of `POST /toggle`. */
export interface ToggleResponse {
  /** The skill name. */
  readonly name: string;
  /** The resulting flag. */
  readonly disabled: boolean;
  /** Whether the instruction file was rewritten. */
  readonly changed: boolean;
}

/** One skill that was moved out of a skills root and can be put back. */
export interface TrashEntryView {
  /** Identifier used to restore it. */
  readonly id: string;
  /** Skill name at the time it was removed. */
  readonly name: string;
  /** Absolute path it will be restored to. */
  readonly originalPath: string;
  /** When it was removed, ISO 8601. */
  readonly removedAt: string;
}

/** Response of `GET /trash`. */
export interface TrashResponse {
  /** Recoverable skills, newest first. */
  readonly entries: readonly TrashEntryView[];
  /** Whether the trash directory exists at all. */
  readonly exists: boolean;
  /** Non-fatal problem, for example an unreadable index. */
  readonly warning?: DiagnosticView;
}

/** Request body of `POST /delete`. */
export interface DeleteRequest {
  /** Root identifier the skill belongs to. */
  readonly rootKey: string;
  /** Skill name. */
  readonly name: string;
}

/** Response of `POST /delete`. */
export interface DeleteResponse {
  /** Always true on success. */
  readonly ok: true;
  /** The recorded entry. */
  readonly entry: TrashEntryView;
}

/** Response of `GET /roots`. */
export interface RootsResponse {
  /** Directories a new skill may be written into, in preference order. */
  readonly roots: readonly string[];
}

/** Request body of `POST /create`. */
export interface CreateRequest {
  /** Display name; the host normalizes it into a skill name. */
  readonly name: string;
  /** Frontmatter description, required. */
  readonly description: string;
  /** Instruction body. */
  readonly body?: string;
  /** Directory to write into, from `GET /roots`. Defaults to the first. */
  readonly targetRoot?: string;
}

/** Response of `POST /create`. */
export interface CreateResponse {
  /** Always true on success. */
  readonly ok: true;
  /** Directory the skill was written to. */
  readonly directory: string;
}

/** Request body of `POST /install`. */
export interface InstallRequest {
  /** Link to a repository, a `.zip`, or a single `SKILL.md`. */
  readonly url: string;
  /** Directory to write into, from `GET /roots`. Defaults to the first. */
  readonly targetRoot?: string;
}

/** One skill written by an install. */
export interface InstalledSkillView {
  /** Skill name. */
  readonly name: string;
  /** Directory it was written to. */
  readonly directory: string;
  /** How many files it contains. */
  readonly files: number;
  /** What the link turned out to be. */
  readonly source: 'repository' | 'archive' | 'document';
}

/** Response of `POST /install`. */
export interface InstallResponse {
  /** Always true on success. */
  readonly ok: true;
  /** Skills that were written; one link can carry several. */
  readonly skills: readonly InstalledSkillView[];
  /** Files that were ignored, for example entries that tried to escape. */
  readonly skipped: number;
}

/** Error envelope returned for any failed request. */
export interface ErrorResponse {
  /** Always false for failures. */
  readonly ok: false;
  /** Stable error code. */
  readonly code: string;
  /** English message. */
  readonly error: string;
}
