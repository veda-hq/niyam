import { posix } from 'node:path';

import { SETTINGS_PATH, repoAt } from './agent.ts';
import { type DocKind, type DocSettings, basenamesOnRef, gitOut, kindNamed, loadDocSettings, localBasenames } from './doc-numbers.ts';
import type { Output, Sys } from './types.ts';

/**
 * Moves a numbered document to another number, taking every reference with it: the file (`git mv`, or a plain
 * rename when git does not track it yet), its own frontmatter key, every citation (`ADR-0057`) and full or relative
 * path in tracked files, and the bare relationship values (`supersedes: '0040'`) the settings name. The rename was
 * never the expensive part of a clash; finding every reference is, so this does it. A dry run by default: some prose
 * narrates history, and only a person can tell, so `--apply` writes.
 */

const FOUR_DIGITS = /^\d{4}$/;
const literal = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const citationOf = (kind: DocKind, number: string): string => `${kind.citation}-${number}`;

/** Tracked files that contain `needle`, by path; under `dir` when given. */
export function filesContaining(sys: Sys, root: string, needle: string, dir?: string): string[] {
  const out = gitOut(sys, root, ['grep', '-l', '-F', '--', needle, ...(dir === undefined ? [] : [dir])]);
  return out === null ? [] : out.split('\n').filter(Boolean);
}

/** Whether a renumber leaves `path` as written: it records what a document was called then. */
export function isHistory(settings: DocSettings, path: string): boolean {
  const matches = (pattern: string) => (pattern.endsWith('/') ? path.startsWith(pattern) : path === pattern);
  if (settings.history.some((pattern) => pattern.startsWith('!') && matches(pattern.slice(1)))) return false;
  return settings.history.some((pattern) => !pattern.startsWith('!') && matches(pattern));
}

/** The relationship keys `path` carries for `kind`, or none. */
export function relationshipKeysFor(kind: DocKind, path: string): readonly string[] {
  for (const [dir, keys] of Object.entries(kind.relationships)) if (path.startsWith(`${dir}/`)) return keys;
  return [];
}

/**
 * Citations of `from` become `to`, and paths to the old file name the new one. A citation needs a non-digit after
 * it, so `ADR-0057` never matches in `ADR-00571`. A relative path (`../rfcs/…`, `../../rfcs/…`) is rewritten only
 * when, resolved against the file that holds it (`path`), it lands on this very document.
 */
export function rewriteReferences(text: string, kind: DocKind, from: string, to: string, oldName: string, newName: string, path: string): string {
  const citation = new RegExp(`${citationOf(kind, literal(from))}(?!\\d)`, 'g');
  const sibling = kind.dir.slice(kind.dir.lastIndexOf('/') + 1);
  const relative = new RegExp(`(?<![\\w./-])((?:\\.\\./)+${literal(sibling)}/)${literal(oldName)}`, 'g');
  const fromDir = posix.dirname(path);
  return text
    .replaceAll(`${kind.dir}/${oldName}`, `${kind.dir}/${newName}`)
    .replace(relative, (match, prefix: string) => (posix.normalize(posix.join(fromDir, `${prefix}${oldName}`)) === `${kind.dir}/${oldName}` ? `${prefix}${newName}` : match))
    .replace(citation, citationOf(kind, to));
}

/**
 * Bare numbers under the relationship keys `path` carries for `kind`: a scalar (`key: '0040'`, `key: 0040`,
 * `key: '0040 (a note)'`), a flow list (`key: ["0022", 0023]`), a block list (`- '0022 (…)'`) and a flow list
 * wrapped over lines, with `# comments`, blank lines in a block and CRLF. A value that is only numbers and commas
 * names each of them; any other value names one document, its leading number, and the rest is description. Keys the
 * kind does not own are left alone: a bare number there could name either kind.
 */
export function rewriteRelationships(text: string, kind: DocKind, from: string, to: string, path: string): string {
  const keys = new Set(relationshipKeysFor(kind, path));
  if (keys.size === 0) return text;
  const swap = (value: string) => (value === from ? to : value);
  const LIST = /^\s*\d{4}(\s*,\s*\d{4})*\s*$/;
  const swapInner = (inner: string) => (LIST.test(inner) ? inner.replace(/\d{4}/g, swap) : inner.replace(/^(\s*)(\d{4})(?!\d)/, (_whole, lead: string, number: string) => `${lead}${swap(number)}`));
  const swapElement = (element: string) => {
    const quoted = /^(\s*)(['"])([\s\S]*)\2(\s*)$/.exec(element);
    if (quoted === null) return swapInner(element);
    const [, pre, quote, inner, post] = quoted as unknown as [string, string, string, string, string];
    return `${pre}${quote}${swapInner(inner)}${quote}${post}`;
  };
  // Top-level commas only; a backslash escapes only inside double quotes, as in YAML.
  const splitElements = (segment: string) => {
    const parts: string[] = [];
    let current = '';
    let quote: string | null = null;
    let escaped = false;
    for (const ch of segment) {
      if (escaped) escaped = false;
      else if (quote === '"' && ch === '\\') escaped = true;
      else if (quote !== null) {
        if (ch === quote) quote = null;
      } else if (ch === "'" || ch === '"') quote = ch;
      else if (ch === ',') {
        parts.push(current);
        current = '';
        continue;
      }
      current += ch;
    }
    parts.push(current);
    return parts;
  };
  const swapElements = (segment: string) => splitElements(segment).map(swapElement).join(',');
  // A comment starts at a # outside quotes that opens the segment or follows whitespace.
  const splitComment = (segment: string): [string, string] => {
    let quote: string | null = null;
    let escaped = false;
    for (const [i, ch] of [...segment].entries()) {
      if (escaped) escaped = false;
      else if (quote === '"' && ch === '\\') escaped = true;
      else if (quote !== null) {
        if (ch === quote) quote = null;
      } else if (ch === "'" || ch === '"') quote = ch;
      else if (ch === '#' && (i === 0 || /\s/.test(segment[i - 1] as string))) return [segment.slice(0, i), segment.slice(i)];
    }
    return [segment, ''];
  };
  const swapFlowLine = (body: string) => {
    const [, open, inner, close] = /^(\s*\[?)([\s\S]*?)(\]?\s*)$/.exec(body) as unknown as [string, string, string, string];
    return `${open}${swapElements(inner)}${close}`;
  };
  const lines = text.split('\n');
  let mode: 'block' | 'flow' | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    const whole = lines[i] as string;
    const eol = whole.endsWith('\r') ? '\r' : '';
    const [body, comment] = splitComment(eol === '' ? whole : whole.slice(0, -1));
    if (mode === 'flow') {
      lines[i] = `${swapFlowLine(body)}${comment}${eol}`;
      if (/\]\s*$/.test(body)) mode = null;
      continue;
    }
    if (mode === 'block') {
      const item = /^(\s+-\s*)(.*)$/.exec(body);
      if (item !== null) {
        if (/^['"]?\d{4}/.test(item[2] as string)) lines[i] = `${item[1] as string}${swapElements(item[2] as string)}${comment}${eol}`;
        continue;
      }
      if (/^\s*$/.test(body)) continue;
      if (/^\s+\[/.test(body)) {
        lines[i] = `${swapFlowLine(body)}${comment}${eol}`;
        mode = /\]\s*$/.test(body) ? null : 'flow';
        continue;
      }
      mode = null;
    }
    const entry = /^\s*([A-Za-z_][A-Za-z0-9_]*):(.*)$/.exec(body);
    if (entry === null || !keys.has(entry[1] as string)) continue;
    const key = entry[1] as string;
    const rest = entry[2] as string;
    const head = body.slice(0, body.indexOf(`${key}:`) + key.length + 1);
    if (/^\s*$/.test(rest)) {
      mode = 'block';
      continue;
    }
    if (/^\s*\[/.test(rest)) {
      lines[i] = `${head}${swapFlowLine(rest)}${comment}${eol}`;
      if (!/\]\s*$/.test(rest)) mode = 'flow';
      continue;
    }
    if (/^\s*['"]?\d{4}/.test(rest)) lines[i] = `${head}${swapElements(rest)}${comment}${eol}`;
  }
  return lines.join('\n');
}

/** Every rewrite that applies to `path`. */
export function rewriteAll(text: string, kind: DocKind, from: string, to: string, oldName: string, newName: string, path: string): string {
  return rewriteRelationships(rewriteReferences(text, kind, from, to, oldName, newName, path), kind, from, to, path);
}

/**
 * Frontmatter lines that still name `from` bare after the rewrite, under keys no kind owns for `path` (`related:`):
 * a bare number there could name either kind, so a person decides, and the command says so rather than exit 0 in
 * silence. A block list's items count under their key.
 */
export function residualBareRefs(settings: DocSettings, text: string, from: string, path: string): string[] {
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (block === null) return [];
  const bare = new RegExp(`(?<![A-Za-z0-9-])${literal(from)}(?!\\d)`);
  const classified = new Set(Object.values(settings.kinds).flatMap((kind) => [kind.frontmatterKey, ...relationshipKeysFor(kind, path)]));
  const flagged: string[] = [];
  let enclosing: string | null = null;
  for (const line of (block[1] as string).split('\n')) {
    const entry = /^\s*([A-Za-z_][A-Za-z0-9_]*):/.exec(line);
    if (entry !== null) enclosing = entry[1] as string;
    else if (!/^\s*-\s/.test(line) && line.trim() !== '') enclosing = null;
    if (!bare.test(line) || (enclosing !== null && classified.has(enclosing))) continue;
    flagged.push(line.trim());
  }
  return flagged;
}

/** The document's own frontmatter key (`adr: '0057'`) moved to `to`. */
export function rewriteFrontmatter(text: string, kind: DocKind, from: string, to: string): string {
  return text.replace(new RegExp(`^(${kind.frontmatterKey}:\\s*['"]?)${literal(from)}(['"]?\\s*)$`, 'm'), `$1${to}$2`);
}

export interface Plan {
  readonly from: string;
  readonly to: string;
  readonly oldPath: string;
  readonly newPath: string;
  readonly oldName: string;
  readonly newName: string;
  readonly tracked: boolean;
  readonly referencing: readonly string[];
  readonly residual: readonly { path: string; line: string }[];
}

/** What a renumber would change, or why it cannot: the target must be free here and on origin/main. */
export function plan(sys: Sys, root: string, settings: DocSettings, kind: DocKind, from: string, to: string): { ok: true; plan: Plan } | { ok: false; error: string } {
  const local = localBasenames(sys, kind, root);
  const sources = local.filter((name) => name.startsWith(`${from}-`));
  if (sources.length === 0) return { ok: false, error: `no ${kind.citation} numbered ${from} in ${kind.dir}/` };
  if (sources.length > 1) return { ok: false, error: `${String(sources.length)} files claim ${from} (${sources.join(', ')}) — resolve that collision first, one file at a time` };
  const here = local.filter((name) => name.startsWith(`${to}-`));
  if (here.length > 0) return { ok: false, error: `${to} is already used locally by ${here.join(', ')}` };
  const onMain = basenamesOnRef(sys, kind, 'origin/main', root);
  if (onMain === null) return { ok: false, error: 'could not read `origin/main` — run `git fetch origin main` first, or the new number may collide exactly as the old one did' };
  const there = onMain.filter((name) => name.startsWith(`${to}-`));
  if (there.length > 0) return { ok: false, error: `${to} is already used on origin/main by ${there.join(', ')}` };
  const oldName = sources[0] as string;
  const newName = `${to}-${oldName.slice(from.length + 1)}`;
  const oldPath = `${kind.dir}/${oldName}`;
  const newPath = `${kind.dir}/${newName}`;
  const tracked = gitOut(sys, root, ['ls-files', '--error-unmatch', '--', oldPath]) !== null;
  const candidates = new Set([...filesContaining(sys, root, citationOf(kind, from)), ...filesContaining(sys, root, oldPath)]);
  for (const dir of Object.keys(kind.relationships)) for (const path of filesContaining(sys, root, from, dir)) candidates.add(path);
  candidates.delete(oldPath);
  // A file kept only if the rewrite changes it: `git grep -F ADR-0057` also finds ADR-00571.
  const referencing: string[] = [];
  const residual: { path: string; line: string }[] = [];
  const docDirs = Object.keys(kind.relationships);
  for (const path of [...candidates].sort()) {
    if (isHistory(settings, path)) continue;
    const before = sys.read(`${root}/${path}`);
    const after = rewriteAll(before, kind, from, to, oldName, newName, path);
    if (after !== before) referencing.push(path);
    if (docDirs.some((dir) => path.startsWith(`${dir}/`))) for (const line of residualBareRefs(settings, after, from, path)) residual.push({ path, line });
  }
  return { ok: true, plan: { from, to, oldPath, newPath, oldName, newName, tracked, referencing, residual } };
}

/** Writes the plan: the move, then every rewrite; returns the files written. */
export function applyPlan(sys: Sys, root: string, kind: DocKind, p: Plan): string[] {
  if (p.tracked) {
    const moved = sys.exec('git', ['mv', p.oldPath, p.newPath], { cwd: root });
    if (moved.code !== 0) throw new Error(`git mv ${p.oldPath} ${p.newPath}: ${moved.stderr.trim()}`);
  } else {
    sys.confine(root, `${root}/${p.newPath}`);
    sys.write(`${root}/${p.newPath}`, sys.read(`${root}/${p.oldPath}`));
    sys.remove(`${root}/${p.oldPath}`);
  }
  const movedAt = `${root}/${p.newPath}`;
  sys.confine(root, movedAt);
  sys.write(movedAt, rewriteAll(rewriteFrontmatter(sys.read(movedAt), kind, p.from, p.to), kind, p.from, p.to, p.oldName, p.newName, p.newPath));
  const changed = [p.newPath];
  for (const path of p.referencing) {
    const at = `${root}/${path}`;
    const before = sys.read(at);
    const after = rewriteAll(before, kind, p.from, p.to, p.oldName, p.newName, path);
    if (after === before) continue;
    sys.confine(root, at);
    sys.write(at, after);
    changed.push(path);
  }
  return changed;
}

/** renumber-doc's arguments: a kind, two four-digit numbers, and --apply. */
export function renumberArgs(args: readonly string[]): { kind: string; from: string; to: string; apply: boolean } {
  const rest = args.filter((arg) => arg !== '--apply');
  const odd = rest.find((arg) => arg.startsWith('-'));
  if (odd !== undefined) throw new Error(`renumber-doc: unknown option "${odd}"`);
  const [kind, from, to, extra] = rest;
  if (kind === undefined || from === undefined || to === undefined || extra !== undefined || !FOUR_DIGITS.test(from) || !FOUR_DIGITS.test(to)) throw new Error('renumber-doc needs a document kind and two four-digit numbers: renumber-doc <kind> <from> <to> [--apply]');
  if (from === to) throw new Error(`renumber-doc: ${from} and ${to} are the same number`);
  return { kind, from, to, apply: args.includes('--apply') };
}

/** `niyam renumber-doc <kind> <from> <to> [--apply]`: shows the plan, and with --apply writes it. */
export function renumberDoc(sys: Sys, io: Output, args: readonly string[]): number {
  const parsed = renumberArgs(args);
  const { root } = repoAt(sys);
  const settings = loadDocSettings(sys, root);
  const kind = kindNamed(settings, parsed.kind);
  if (kind === undefined) {
    io.err(`niyam renumber-doc: no document kind "${parsed.kind}"; ${SETTINGS_PATH} names ${Object.keys(settings.kinds).join(', ')}`);
    return 2;
  }
  const result = plan(sys, root, settings, kind, parsed.from, parsed.to);
  if (!result.ok) {
    io.err(`❌ ${result.error}`);
    return 1;
  }
  const p = result.plan;
  io.out(`${p.oldPath}\n  → ${p.newPath}\n`);
  if (p.referencing.length === 0) io.out('No other tracked file references it.');
  else io.out([`${String(p.referencing.length)} referencing file(s):`, ...p.referencing.map((path) => `  - ${path}`)].join('\n'));
  if (p.residual.length > 0) io.out([`\n⚠️  ${String(p.residual.length)} bare reference(s) to ${p.from} under keys this tool does not rewrite (ambiguous namespace) — review by hand:`, ...p.residual.map(({ path, line }) => `  - ${path}: ${line}`)].join('\n'));
  if (!parsed.apply) {
    io.out('\nDry run — nothing changed. Review the list above (some prose narrates history rather than citing a live decision), then re-run with --apply.');
    return 0;
  }
  const changed = applyPlan(sys, root, kind, p);
  io.out(`\n✅ Renumbered ${p.from} → ${p.to}; ${String(changed.length)} file(s) written.\n   Review with \`git diff\` and \`git status\`, then commit.`);
  return 0;
}
