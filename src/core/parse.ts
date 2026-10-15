/**
 * Frontmatter parsing for local DSH skills.
 *
 * A skill is either a directory bundle `<name>/SKILL.md` or a flat `<name>.md`
 * file. Both start with an optional YAML frontmatter block delimited by `---`.
 * This module reads that block without pulling in a YAML dependency: the skill
 * contract uses a small, flat subset (scalars and boolean flags), and being
 * permissive here keeps unreadable skills visible in the panel with a
 * diagnosis instead of silently dropping them.
 *
 * @module core/parse
 */

/** Skill name grammar accepted by the DSH registry. */
const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Windows device names are not usable as directory entries. */
const DEVICE_NAME_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

/** Outcome severity for one skill. */
export type DiagnosticLevel = 'error' | 'warning';

/** One problem found while reading a skill. */
export interface Diagnostic {
  /** Stable machine-readable code. */
  readonly code: string;
  /** Whether the skill is unusable (error) or merely suspicious (warning). */
  readonly level: DiagnosticLevel;
  /** Human-readable English message; the panel localizes common codes. */
  readonly message: string;
}

/** Parsed view of one skill file. */
export interface ParsedSkill {
  /** Frontmatter `name`, verbatim (may be empty or invalid). */
  readonly declaredName: string;
  /** Frontmatter `description`, verbatim. */
  readonly description: string;
  /** Frontmatter `whenToUse`, verbatim. */
  readonly whenToUse: string;
  /** Whether a frontmatter block was present at all. */
  readonly hasFrontmatter: boolean;
  /** Whether the block could be delimited by a closing `---` line. */
  readonly frontmatterClosed: boolean;
  /** Markdown body after the frontmatter, trimmed. */
  readonly body: string;
  /** Problems found while parsing; empty when the skill looks healthy. */
  readonly diagnostics: readonly Diagnostic[];
}

/** Result of comparing a frontmatter name with the on-disk entry name. */
export interface NameCheck {
  /** Whether the declared name is usable as a skill name. */
  readonly valid: boolean;
  /** Diagnostic to attach when it is not. */
  readonly diagnostic?: Diagnostic;
}

/** Strip a byte-order mark so a BOM cannot break the `---` detection. */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Decode one scalar value from a frontmatter line.
 *
 * Double-quoted values are decoded as JSON so escape sequences survive;
 * single-quoted values follow YAML's doubled-quote rule; everything else is
 * taken literally with surrounding whitespace removed.
 * @param raw - the text after the first colon.
 * @returns the decoded scalar.
 */
function decodeScalar(raw: string): string {
  const text = raw.trim();
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    try {
      const value: unknown = JSON.parse(text);
      if (typeof value === 'string') return value;
    } catch {
      // Fall through: keep the literal text rather than failing the skill.
    }
  }
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) {
    return text.slice(1, -1).replace(/''/g, "'");
  }
  return text;
}

/**
 * Read the `key: value` pairs of a frontmatter block.
 *
 * Block scalars (`>` and `|`) are folded into a single string; nested
 * structures are recorded as their first-level key only, which is all the
 * skill contract uses.
 * @param lines - the full document split into lines.
 * @param end - index of the closing `---` line.
 * @returns the decoded key/value map.
 */
function readPairs(lines: readonly string[], end: number): Map<string, string> {
  const pairs = new Map<string, string>();
  for (let i = 1; i < end; i += 1) {
    const line = lines[i] ?? '';
    const match = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (match === null) continue;
    const key = match[1] ?? '';
    const raw = match[2] ?? '';
    const block = /^([>|])[-+]?\s*$/.exec(raw);
    if (block === null) {
      pairs.set(key, decodeScalar(raw));
      continue;
    }
    const collected: string[] = [];
    while (i + 1 < end) {
      const next = lines[i + 1] ?? '';
      if (!/^\s/.test(next) && next !== '') break;
      i += 1;
      collected.push(next);
    }
    const indents = collected
      .filter((text) => text.trim() !== '')
      .map((text) => (/^\s*/.exec(text)?.[0].length ?? 0));
    const indent = indents.length > 0 ? Math.min(...indents) : 0;
    const normalized = collected.map((text) => text.slice(Math.min(indent, text.length)));
    pairs.set(key, (block[1] === '>' ? normalized.join(' ') : normalized.join('\n')).replace(/[ \t]+/g, ' ').trim());
  }
  return pairs;
}

/**
 * Parse one skill document.
 * @param text - the raw file contents.
 * @returns the parsed fields, body, and any diagnostics.
 */
export function parseSkillDoc(text: string): ParsedSkill {
  const source = stripBom(text);
  const lines = source.split(/\r?\n/);
  const diagnostics: Diagnostic[] = [];

  if (lines[0]?.trim() !== '---') {
    return {
      declaredName: '',
      description: '',
      whenToUse: '',
      hasFrontmatter: false,
      frontmatterClosed: false,
      body: source.trim(),
      diagnostics: [
        {
          code: 'error.frontmatter.missing',
          level: 'error',
          message: 'The file does not start with a frontmatter block (---).',
        },
      ],
    };
  }

  let end = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if ((lines[i] ?? '').trim() === '---') {
      end = i;
      break;
    }
  }

  if (end < 0) {
    return {
      declaredName: '',
      description: '',
      whenToUse: '',
      hasFrontmatter: true,
      frontmatterClosed: false,
      body: lines.slice(1).join('\n').trim(),
      diagnostics: [
        {
          code: 'error.frontmatter.unclosed',
          level: 'error',
          message: 'The frontmatter block is never closed with a --- line.',
        },
      ],
    };
  }

  const pairs = readPairs(lines, end);
  const declaredName = pairs.get('name') ?? '';
  const description = pairs.get('description') ?? '';

  if (declaredName === '') {
    diagnostics.push({
      code: 'error.name.missing',
      level: 'error',
      message: 'Frontmatter has no name key.',
    });
  } else if (!SKILL_NAME_RE.test(declaredName)) {
    diagnostics.push({
      code: 'error.name.format',
      level: 'error',
      message: `The name "${declaredName}" is not kebab-case (lowercase letters, digits and single hyphens).`,
    });
  } else if (DEVICE_NAME_RE.test(declaredName)) {
    diagnostics.push({
      code: 'error.name.device',
      level: 'error',
      message: `The name "${declaredName}" is a reserved Windows device name.`,
    });
  }

  if (description === '') {
    diagnostics.push({
      code: 'error.description.missing',
      level: 'error',
      message: 'Frontmatter has no description key.',
    });
  }

  return {
    declaredName,
    description,
    whenToUse: pairs.get('whenToUse') ?? '',
    hasFrontmatter: true,
    frontmatterClosed: true,
    body: lines.slice(end + 1).join('\n').trim(),
    diagnostics,
  };
}

/**
 * Check whether a frontmatter name can address this skill.
 * @param declaredName - the name read from frontmatter.
 * @param entryName - the name derived from the file system entry.
 * @returns validity plus the diagnostic to attach when invalid.
 */
export function checkName(declaredName: string, entryName: string): NameCheck {
  if (declaredName === '') {
    return {
      valid: false,
      diagnostic: {
        code: 'error.name.missing',
        level: 'error',
        message: `No name in frontmatter; the folder name "${entryName}" cannot address it.`,
      },
    };
  }
  if (!SKILL_NAME_RE.test(declaredName)) {
    return {
      valid: false,
      diagnostic: {
        code: 'error.name.format',
        level: 'error',
        message: `The name "${declaredName}" is not kebab-case, so DSH cannot load this skill.`,
      },
    };
  }
  return { valid: true };
}

/** Expose the grammar for callers that validate candidate skill names. */
export { SKILL_NAME_RE, DEVICE_NAME_RE };
