import { SETTINGS_PATH, repoAt } from './agent.ts';
import type { Output, Sys } from './types.ts';

/**
 * Numbered documents (`docs/adr/0059-slug.md`) and the numbers they share: one allocator that hands out a number
 * nothing else holds, and reserves it for good. A number is identity and is never reused, so a reservation reads
 * everything that can hold one, not the author's own tree:
 *
 *   1. the main branch's tree, and this working tree;
 *   2. every ref in the repository and every linked worktree, through the reserver;
 *   3. the reservation refs (`reservations`, one per number), which every worktree of the clone shares;
 *   4. open pull requests: a pull request that adds `<dir>/NNNN-*.md` holds NNNN until it merges or closes;
 *   5. for the kind Work items take their numbers from, the Work item issues' titles (`NNNN — …`), open and closed,
 *      and a fixed list of retired folders (`workItems.frozen`).
 *
 * Sources 4 and 5 need `gh`. Without them a preview still answers, with a warning, and `--reserve` refuses: a
 * permanent claim is never made blind.
 *
 * The settings are the `"docNumbers"` entry of `.github/niyam.json`, or the JSON file it names by its path in the
 * repository (a package's file, say), so one repository can share them with another.
 */

/** One family of numbered documents. */
export interface DocKind {
  /** Its name on the command line (`adr`). */
  readonly kind: string;
  /** Where its documents are, by path in the repository. */
  readonly dir: string;
  /** Its prose form, `ADR` for `ADR-0058`. */
  readonly citation: string;
  /** The frontmatter key that holds a document's own number. */
  readonly frontmatterKey: string;
  /**
   * Frontmatter keys whose bare values (`supersedes: '0040'`) name a document of this kind, by the folder of the
   * file that carries them: the same key name means a different kind in another folder.
   */
  readonly relationships: Readonly<Record<string, readonly string[]>>;
}

/** Work items: issues titled `NNNN — …` that take their numbers from one kind's reservation. */
export interface WorkItems {
  /** The kind whose numbers they take. */
  readonly kind: string;
  /** Their GitHub issue type. */
  readonly issueType: string;
  /** A label every Work item carries, which `work-item-number` adds; none when unset. */
  readonly label?: string;
  /**
   * The last issue moved from a retired folder under that folder's own number: an issue up to this one and its
   * folder are one piece of work, not a clash.
   */
  readonly lastMovedIssue?: number;
  /** Retired numbered folders whose numbers stay taken: their folder, and their names. */
  readonly frozen?: { readonly dir: string; readonly entries: readonly string[] };
  /** The command a renumber comment tells people to reserve with. */
  readonly reserveCommand?: string;
}

export interface DocSettings {
  /** The reservation refs' prefix; `{kind}` is the kind's name: `refs/docs/{kind}-reservations/`. */
  readonly reservations: string;
  readonly kinds: Readonly<Record<string, DocKind>>;
  readonly workItems?: WorkItems;
  /**
   * Paths a renumber leaves as written, because they record what a document was called then: a folder ending in /,
   * or a file; `!` before one keeps it rewritten.
   */
  readonly history: readonly string[];
}

const where = `${SETTINGS_PATH}: "docNumbers"`;
const PATH = /^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[\w@+=,.\/-]+$/;
const KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

function record(value: unknown, at: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${at} must be an object`);
  return value as Record<string, unknown>;
}

function only(value: Record<string, unknown>, at: string, keys: readonly string[]): void {
  const extra = Object.keys(value).find((key) => !keys.includes(key));
  if (extra !== undefined) throw new Error(`${at} has an unknown key "${extra}"; it takes ${keys.map((key) => `"${key}"`).join(', ')}`);
}

function text(value: unknown, at: string, pattern?: RegExp): string {
  if (typeof value !== 'string' || !value.trim() || /[\r\n]/.test(value) || (pattern && !pattern.test(value))) throw new Error(`${at} must be ${pattern === PATH ? 'a path in the repository' : 'one line of text'}`);
  return value;
}

function texts(value: unknown, at: string, pattern?: RegExp): string[] {
  if (!Array.isArray(value)) throw new Error(`${at} must be a list`);
  return value.map((one, i) => text(one, `${at}[${String(i)}]`, pattern));
}

function docKind(name: string, raw: unknown): DocKind {
  const at = `${where}.kinds.${name}`;
  const value = record(raw, at);
  only(value, at, ['dir', 'citation', 'frontmatterKey', 'relationships']);
  const relationships: Record<string, string[]> = {};
  for (const [dir, keys] of Object.entries(record(value.relationships ?? {}, `${at}.relationships`))) {
    text(dir, `${at}.relationships key`, PATH);
    relationships[dir] = texts(keys, `${at}.relationships.${dir}`, KEY);
  }
  return {
    kind: name,
    dir: text(value.dir, `${at}.dir`, PATH),
    citation: text(value.citation, `${at}.citation`, /^[A-Z][A-Za-z]*$/),
    frontmatterKey: text(value.frontmatterKey ?? name, `${at}.frontmatterKey`, KEY),
    relationships,
  };
}

function workItems(raw: unknown, kinds: Record<string, DocKind>): WorkItems {
  const at = `${where}.workItems`;
  const value = record(raw, at);
  only(value, at, ['kind', 'issueType', 'label', 'lastMovedIssue', 'frozen', 'reserveCommand']);
  const kind = text(value.kind, `${at}.kind`);
  if (!Object.hasOwn(kinds, kind)) throw new Error(`${at}.kind names "${kind}", which "kinds" does not have`);
  const last = value.lastMovedIssue;
  if (last !== undefined && (!Number.isSafeInteger(last) || (last as number) < 1)) throw new Error(`${at}.lastMovedIssue must be an issue number`);
  let frozen: WorkItems['frozen'];
  if (value.frozen !== undefined) {
    const f = record(value.frozen, `${at}.frozen`);
    only(f, `${at}.frozen`, ['dir', 'entries']);
    const entries = texts(f.entries, `${at}.frozen.entries`, /^\d{4}-[\w.-]+$/);
    frozen = { dir: text(f.dir, `${at}.frozen.dir`, PATH), entries };
  }
  return {
    kind,
    issueType: text(value.issueType, `${at}.issueType`),
    ...(value.label === undefined ? {} : { label: text(value.label, `${at}.label`) }),
    ...(last === undefined ? {} : { lastMovedIssue: last as number }),
    ...(frozen === undefined ? {} : { frozen }),
    ...(value.reserveCommand === undefined ? {} : { reserveCommand: text(value.reserveCommand, `${at}.reserveCommand`) }),
  };
}

/** The settings from their raw JSON; throws with the reason on anything malformed. */
export function docSettings(raw: unknown): DocSettings {
  const value = record(raw, where);
  only(value, where, ['reservations', 'kinds', 'workItems', 'history']);
  const reservations = text(value.reservations, `${where}.reservations`);
  if (!/^refs\/[\w.{}\/-]+\/$/.test(reservations) || !reservations.includes('{kind}')) throw new Error(`${where}.reservations must be a ref prefix under refs/ that names {kind} and ends in /`);
  const kinds: Record<string, DocKind> = {};
  for (const [name, kind] of Object.entries(record(value.kinds, `${where}.kinds`))) {
    if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error(`${where}.kinds: "${name}" must be a lower-case word`);
    kinds[name] = docKind(name, kind);
  }
  if (Object.keys(kinds).length === 0) throw new Error(`${where}.kinds must name at least one kind`);
  const history = value.history === undefined ? [] : texts(value.history, `${where}.history`, /^!?(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[\w@+=,.\/-]+$/);
  return {
    reservations,
    kinds,
    ...(value.workItems === undefined ? {} : { workItems: workItems(value.workItems, kinds) }),
    history,
  };
}

/**
 * The settings for the repository at `root`: `"docNumbers"` in its `.github/niyam.json`, or the file that entry
 * names. Throws when there are none, or they cannot be read: nothing is allocated from a guess.
 */
export function loadDocSettings(sys: Sys, root: string): DocSettings {
  const path = `${root}/${SETTINGS_PATH}`;
  if (!sys.exists(path)) throw new Error(`${SETTINGS_PATH} not found in ${root}`);
  const entry = NiyamFileSchema.parse(JSON.parse(sys.read(path))).docNumbers;
  if (entry === undefined) throw new Error(`${SETTINGS_PATH} has no "docNumbers": name the document kinds there, or the JSON file that does`);
  if (typeof entry !== 'string') return docSettings(entry);
  const file = text(entry, where, PATH);
  if (!sys.exists(`${root}/${file}`)) throw new Error(`${where} names ${file}, which is not there (run pnpm install?)`);
  return DocSettingsSchema.parse(JSON.parse(sys.read(`${root}/${file}`)));
}

/** A kind by its name on the command line, in any case; undefined when the settings have none. */
export function kindNamed(settings: DocSettings, name: string | undefined): DocKind | undefined {
  if (name === undefined) return undefined;
  const lower = name.toLowerCase();
  return Object.hasOwn(settings.kinds, lower) ? settings.kinds[lower] : undefined;
}

/** A document's file name: four digits, a hyphen, a slug, `.md`. */
const NUMBERED_DOC = /^(\d{4})-.*\.md$/;
/** A numbered folder or file: four digits and a hyphen. */
const NUMBERED_ENTRY = /^(\d{4})-/;

/** The four-digit number a document's file name declares, or null. */
export function numberFromFilename(name: string): string | null {
  return NUMBERED_DOC.exec(name)?.[1] ?? null;
}

/** The four-digit number a numbered entry's name opens with, or null. */
export function numberFromEntry(name: string): string | null {
  return NUMBERED_ENTRY.exec(name)?.[1] ?? null;
}

/** The number a file name or a path (`docs/work/0110-y`) declares, or null; only a path has a slash. */
export function numberFromName(name: string): string | null {
  return name.includes('/') ? numberFromEntry(name.slice(name.lastIndexOf('/') + 1)) : numberFromFilename(name);
}

/**
 * Four digits that open a Work item title: `0150 — setup …` or `0150-slug`. A number later in the title is a
 * citation, and a date (`2026-11-05 …`) or a longer run of digits is not a work number. Missing a work number could
 * hand it out again, while misreading a title only skips a number, so only a whole `YYYY-MM-DD` reads as a date.
 */
const WORK_ITEM_TITLE = /^(\d{4})(?!\d|-\d\d-\d\d(?!\d))/;

/** The work number a Work item title opens with, or null. */
export function numberFromWorkItemTitle(title: string): string | null {
  return WORK_ITEM_TITLE.exec(title.trimStart())?.[1] ?? null;
}

/** The frozen folders a kind counts, by path (`docs/work/0105-x`); none for a kind Work items do not take. */
export function frozenEntries(settings: DocSettings, kind: string): string[] {
  const frozen = settings.workItems?.kind === kind ? settings.workItems.frozen : undefined;
  return frozen ? frozen.entries.map((entry) => `${frozen.dir}/${entry}`) : [];
}

/** The distinct numbers of a kind's frozen folders, ascending. */
export function frozenNumbers(settings: DocSettings, kind: string): string[] {
  return [...new Set(frozenEntries(settings, kind).map((path) => numberFromName(path) as string))].sort();
}

/** What a caught value says; one whose text cannot be read says so instead of throwing out of the handler. */
export function detail(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch {
    // fail-open: this describes an error being reported already; a placeholder is better than a second throw.
    return 'an error whose text could not be read';
  }
}

/**
 * A validator in the Standard Schema shape (https://standardschema.dev), for JSON that comes from outside: `parse`
 * gives the value `check` made of it, or throws why not. niyam carries no schema library, so each check is written
 * here, once per producer, beside what reads its output.
 */
export interface Schema<T> {
  readonly '~standard': {
    readonly version: 1;
    readonly vendor: 'niyam';
    validate(value: unknown): { value: T } | { issues: { message: string }[] };
  };
  parse(value: unknown): T;
}

/** A Schema whose check is `check`. */
export function schema<T>(check: (value: unknown) => T): Schema<T> {
  return {
    '~standard': {
      version: 1,
      vendor: 'niyam',
      validate(value) {
        try {
          return { value: check(value) };
        } catch (error) {
          // fail-open: an invalid value is the answer here, reported as the issue.
          return { issues: [{ message: detail(error) }] };
        }
      },
    },
    parse: check,
  };
}

/** `.github/niyam.json`, for its `"docNumbers"` entry. */
export const NiyamFileSchema = schema((value) => ({ docNumbers: record(value, SETTINGS_PATH).docNumbers }));

/** The `"docNumbers"` settings, or the file they are in. */
export const DocSettingsSchema = schema(docSettings);

/** One open pull request from `gh pr list --json number,files`: its number, its listed paths, and how many it listed. */
export interface Pull {
  readonly number: unknown;
  readonly paths: string[];
  readonly listed: number;
}

/** `gh pr list --json number,files`: a list; an entry without files lists none, and a file without a path is skipped. */
export const PullListSchema = schema((value): Pull[] => {
  if (!Array.isArray(value)) throw new Error('`gh pr list` returned an unexpected shape');
  return (value as unknown[]).map((pr) => {
    // JSON gives no functions, and a number or a string has no such fields: only null needs standing in for.
    const entry = (pr ?? {}) as { number?: unknown; files?: unknown };
    const files = Array.isArray(entry.files) ? (entry.files as unknown[]) : [];
    const paths = files.map((file) => (file as { path?: unknown } | null)?.path).filter((path): path is string => typeof path === 'string');
    return { number: entry.number, paths, listed: files.length };
  });
});

/** One line of the Work item list: `{number, title}`. */
export const WorkItemLineSchema = schema((value): { number: number; title: string } => {
  const { number, title } = (typeof value === 'object' && value !== null ? value : {}) as { number?: unknown; title?: unknown };
  if (!Number.isInteger(number) || typeof title !== 'string') throw new Error('not {number, title}');
  return { number: number as number, title };
});

/** A whole number from digits the caller has matched; throws on anything else. */
export function wholeNumber(digits: string): number {
  const number = Number(digits);
  if (!/^\d+$/.test(digits) || !Number.isSafeInteger(number)) throw new Error(`"${digits}" is not a whole number`);
  return number;
}

/** git's output, or null when git failed: "could not tell" is never "nothing there". */
export function gitOut(sys: Sys, root: string | undefined, args: readonly string[]): string | null {
  const result = sys.exec('git', args, root === undefined ? {} : { cwd: root });
  return result.code === 0 ? result.stdout : null;
}

/** git's output; throws with git's own error when it failed. */
function gitMust(sys: Sys, root: string, args: readonly string[]): string {
  const result = sys.exec('git', args, { cwd: root });
  if (result.code !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr.trim() || `exit ${String(result.code)}`}`);
  return result.stdout;
}

/** The kind's numbered documents in the working tree, by file name. */
export function localBasenames(sys: Sys, kind: DocKind, root: string): string[] {
  return sys.list(`${root}/${kind.dir}`).filter((name) => NUMBERED_DOC.test(name)).sort();
}

/**
 * The kind's numbered documents on a ref's tree, by file name; null when the ref cannot be read, which is not the
 * same as a ref with none.
 */
export function basenamesOnRef(sys: Sys, kind: DocKind, ref: string, root: string): string[] | null {
  const out = gitOut(sys, root, ['ls-tree', '--name-only', ref, `${kind.dir}/`]);
  if (out === null) return null;
  // A blank line names no document, so the name filter drops it.
  return out
    .split('\n')
    .map((path) => path.slice(path.lastIndexOf('/') + 1))
    .filter((name) => NUMBERED_DOC.test(name))
    .sort();
}

/** `gh` with its output as text, run in `root`; throws when gh fails. */
export type RunGh = (args: readonly string[]) => string;

/** gh run by `sys` in `root`. */
export function ghIn(sys: Sys, root: string): RunGh {
  return (args) => {
    const result = sys.exec('gh', args, { cwd: root });
    if (result.code !== 0) throw new Error(result.stderr.trim() || `gh exited ${String(result.code)}`);
    return result.stdout;
  };
}

/** Open pull requests read at most; far above a repository's steady state. */
const PR_SCAN_LIMIT = 100;
/** Files `gh pr list --json files` gives per pull request before it stops. */
const PR_FILES_PAGE = 100;
/** Files the REST files list gives at most, paged or not. */
const PR_FILES_REST_LIMIT = 3000;

export interface Layer {
  readonly numbers: Set<string>;
  /** Why a layer could not be read whole; any warning makes `--reserve` refuse. */
  readonly warnings: string[];
}

/** Every file of one pull request, paged through the REST list, or why it could not be read whole. */
function allPrFiles(number: unknown, gh: RunGh): { ok: true; paths: string[] } | { ok: false; reason: string } {
  if (!Number.isInteger(number)) return { ok: false, reason: 'no PR number' };
  let paths: string[];
  try {
    paths = gh(['api', `repos/{owner}/{repo}/pulls/${String(number)}/files`, '--paginate', '--jq', '.[].filename'])
      .split('\n')
      .filter((line) => line !== '');
  } catch {
    // fail-open: the caller makes this a warning, and a warning makes --reserve refuse.
    return { ok: false, reason: '`gh api` failed' };
  }
  if (paths.length >= PR_FILES_REST_LIMIT) return { ok: false, reason: `the API stops at ${String(PR_FILES_REST_LIMIT)} files` };
  return { ok: true, paths };
}

/**
 * Numbers open pull requests hold: a pull request holds NNNN when it adds `<dir>/NNNN-*.md` that `mainNames` (the
 * main branch's file names) does not have. Editing a document holds nothing.
 */
export function prClaimedNumbers(kind: DocKind, mainNames: readonly string[], gh: RunGh): Layer {
  const warnings: string[] = [];
  const numbers = new Set<string>();
  let raw: string;
  try {
    raw = gh(['pr', 'list', '--state', 'open', '--limit', String(PR_SCAN_LIMIT), '--json', 'number,files']);
  } catch {
    // fail-open: a preview must never block an author; the warning makes --reserve refuse.
    warnings.push('could not read open PRs via `gh` (not installed, not authenticated, or offline) — numbers claimed by unmerged PRs were NOT considered');
    return { numbers, warnings };
  }
  let pulls: Pull[];
  try {
    pulls = PullListSchema.parse(JSON.parse(raw));
  } catch (error) {
    // fail-open: as above, the warning is what makes --reserve refuse.
    warnings.push(error instanceof SyntaxError ? '`gh pr list` returned output that is not JSON — PR claims were NOT considered' : '`gh pr list` returned an unexpected shape — PR claims were NOT considered');
    return { numbers, warnings };
  }
  if (pulls.length >= PR_SCAN_LIMIT) warnings.push(`${String(pulls.length)} open PRs listed (the scan limit) — there may be more, and any claim they carry was NOT considered`);
  const onMain = new Set(mainNames);
  const prefix = `${kind.dir}/`;
  for (const pr of pulls) {
    let paths = pr.paths;
    // A pull request at the page's end may hide a document past it: read its whole list.
    if (pr.listed >= PR_FILES_PAGE) {
      const full = allPrFiles(pr.number, gh);
      if (full.ok) paths = full.paths;
      else warnings.push(`PR #${String(pr.number)} has ${String(pr.listed)}+ files and its full file list could not be read (${full.reason}) — any claim past its first ${String(pr.listed)} listed files was NOT considered`);
    }
    for (const path of paths) {
      if (!path.startsWith(prefix)) continue;
      const name = path.slice(prefix.length);
      const number = numberFromFilename(name);
      if (number !== null && !onMain.has(name)) numbers.add(number);
    }
  }
  return { numbers, warnings };
}

export interface WorkItem {
  readonly number: number;
  readonly title: string;
  readonly workNumber: string | null;
}

/**
 * Every Work item issue, open and closed, through the REST list (search caps at 1000 and lags a new issue). Any
 * warning empties the list: a reservation or a clash check must not work from part of it.
 */
export function listWorkItems(work: WorkItems, gh: RunGh): { items: WorkItem[]; warnings: string[] } {
  const none = (warning: string) => ({ items: [], warnings: [warning] });
  let raw: string;
  try {
    raw = gh(['api', '--paginate', `repos/{owner}/{repo}/issues?state=all&type=${encodeURIComponent(work.issueType)}&per_page=100`, '--jq', `.[] | select(.type.name == ${JSON.stringify(work.issueType)}) | {number, title}`]);
  } catch {
    // fail-open: a preview must never block an author; the warning makes --reserve refuse.
    return none('could not read Work item issues via `gh` (not installed, not authenticated, or offline) — numbers in their titles were NOT considered');
  }
  const items: WorkItem[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    let parsed: { number: number; title: string };
    try {
      parsed = WorkItemLineSchema.parse(JSON.parse(line));
    } catch (error) {
      // fail-open: the warning is what makes --reserve refuse.
      return none(error instanceof SyntaxError ? 'the Work item issue list returned a line that is not JSON — Work item titles were NOT considered' : 'the Work item issue list returned an unexpected shape — Work item titles were NOT considered');
    }
    const { number, title } = parsed;
    items.push({ number, title, workNumber: numberFromWorkItemTitle(title) });
  }
  // A repository with Work items has some, so an empty answer is GitHub answering wrongly, not "none".
  if (items.length === 0) return none('the Work item issue list came back empty — Work item titles were NOT considered');
  return { items, warnings: [] };
}

/**
 * Candidates skipped for a failure this process cannot classify before it reports the first. `update-ref` says
 * "cannot lock ref" for a lost race, a held lock, a directory/file clash and an unwritable ref store alike; only the
 * first can be told apart, by the ref now being there. A skipped number is a gap for good.
 */
const INDETERMINATE_SKIP_LIMIT = 3;

/**
 * Picks the next free number of `kind` and, unless `dryRun`, claims it for good with a reservation ref, created
 * atomically by `update-ref` so two worktrees never get one number. Reads every ref's history of the kind's folder,
 * every reservation ref and every linked worktree's folder, beside `alsoTaken` (numbers the caller knows of that git
 * cannot see). `warn` hears of each candidate it has to skip.
 */
export function reserveDocNumber(sys: Sys, root: string, settings: DocSettings, kind: DocKind, options: { alsoTaken?: Iterable<number>; dryRun?: boolean; warn?: (line: string) => void } = {}): string {
  const { dir, citation } = kind;
  const prefix = settings.reservations.replaceAll('{kind}', kind.kind);
  const used = new Set<number>(options.alsoTaken ?? []);
  const escape = (literal: string) => literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(?:${escape(dir)}/|${escape(prefix)})(\\d{4})\\b`, 'g');
  const note = (out: string) => {
    for (const match of out.matchAll(pattern)) used.add(wholeNumber(match[1] as string));
  };
  note(gitMust(sys, root, ['log', '--all', '--format=', '--name-only', '--', dir]));
  note(gitMust(sys, root, ['for-each-ref', prefix]));
  for (const line of gitMust(sys, root, ['worktree', 'list', '--porcelain']).split('\n')) {
    if (!line.startsWith('worktree ')) continue;
    for (const name of sys.list(`${line.slice('worktree '.length)}/${dir}`)) note(`${dir}/${name}`);
  }
  let head: string | undefined;
  let first: Error | undefined;
  let skipped = 0;
  for (let number = Math.max(0, ...used) + 1; number <= 9999; number += 1) {
    const formatted = String(number).padStart(4, '0');
    if (options.dryRun) return formatted;
    // HEAD only to create a ref, so a preview needs no commit.
    head ??= gitMust(sys, root, ['rev-parse', 'HEAD']).trim();
    const ref = `${prefix}${formatted}`;
    const made = sys.exec('git', ['-c', 'core.filesRefLockTimeout=2000', 'update-ref', ref, head, ''], { cwd: root });
    if (made.code === 0) return formatted;
    // Lost the race outright: the winner's ref is there, so go on.
    if (gitOut(sys, root, ['show-ref', '--verify', ref]) !== null) continue;
    // Not there: a competitor between taking the lock and renaming it into place looks the same as a broken ref
    // store, so skip, but only so many times.
    first ??= new Error(`could not claim ${citation} ${formatted}: ${made.stderr.trim()}`);
    skipped += 1;
    if (skipped > INDETERMINATE_SKIP_LIMIT) throw first;
    options.warn?.(`${citation} ${formatted} could not be claimed; skipping it.\n${made.stderr.trim()}`);
  }
  throw new Error(`${citation} number space exhausted`);
}

export interface AllocateOptions {
  readonly offline?: boolean;
  readonly reserve?: boolean;
  readonly ref?: string;
  readonly gh: RunGh;
  readonly warn?: (line: string) => void;
}

export type Allocation =
  | { ok: true; next: string; sources: { main: number; local: number; pullRequests: number; workItems: number; frozen: number }; warnings: string[] }
  | { ok: false; error: string };

/** Every taken number, then the next free one, previewed or reserved, with where the taken ones came from. */
export function allocate(sys: Sys, root: string, settings: DocSettings, kind: DocKind, options: AllocateOptions): Allocation {
  const ref = options.ref ?? 'origin/main';
  const mainNames = basenamesOnRef(sys, kind, ref, root);
  if (mainNames === null) return { ok: false, error: `could not read \`${ref}\` — fetch it first (\`git fetch origin main\`). Allocating without it would hand out a number main may already use.` };
  const localNames = localBasenames(sys, kind, root);
  const taken = new Set<string>();
  for (const name of [...mainNames, ...localNames]) taken.add(numberFromFilename(name) as string);
  const frozen = frozenNumbers(settings, kind.kind);
  for (const number of frozen) taken.add(number);
  const warnings: string[] = [];
  const countsWorkItems = settings.workItems?.kind === kind.kind;
  let pullRequests = 0;
  let workItems = 0;
  let complete = true;
  if (options.offline) {
    complete = false;
    warnings.push('--offline: numbers claimed by unmerged PRs were NOT considered');
    if (countsWorkItems) warnings.push('--offline: numbers in Work item issue titles were NOT considered');
  } else {
    const claims = prClaimedNumbers(kind, mainNames, options.gh);
    warnings.push(...claims.warnings);
    if (claims.warnings.length > 0) complete = false;
    for (const number of claims.numbers) taken.add(number);
    pullRequests = claims.numbers.size;
    if (countsWorkItems && settings.workItems) {
      const listed = listWorkItems(settings.workItems, options.gh);
      warnings.push(...listed.warnings);
      if (listed.warnings.length > 0) complete = false;
      const numbers = new Set(listed.items.flatMap((item) => (item.workNumber === null ? [] : [item.workNumber])));
      for (const number of numbers) taken.add(number);
      workItems = numbers.size;
    }
  }
  if (options.reserve && !complete) return { ok: false, error: `refusing to RESERVE while the GitHub scan is incomplete — a permanent claim must not be made blind to what open PRs and Work items hold. Re-run without \`--reserve\` to preview, or fix the cause: ${warnings.join('; ')}` };
  let next: string;
  try {
    next = reserveDocNumber(sys, root, settings, kind, { alsoTaken: [...taken].map(wholeNumber), dryRun: !options.reserve, ...(options.warn ? { warn: options.warn } : {}) });
  } catch (error) {
    // fail-open: the failure is the return value, and the command exits 1 on it.
    return { ok: false, error: `could not reserve a ${kind.citation} number: ${detail(error).trim()}` };
  }
  return { ok: true, next, sources: { main: mainNames.length, local: localNames.length, pullRequests, workItems, frozen: frozen.length }, warnings };
}

const FLAGS = ['--json', '--offline', '--reserve'];

/** doc-number's arguments: one kind, and its flags. */
export function docNumberArgs(args: readonly string[]): { kind: string; json: boolean; offline: boolean; reserve: boolean } {
  const kinds = args.filter((arg) => !FLAGS.includes(arg));
  const odd = kinds.find((arg) => arg.startsWith('-'));
  if (odd !== undefined) throw new Error(`doc-number: unknown option "${odd}"`);
  if (kinds.length !== 1) throw new Error('doc-number needs one document kind, such as adr');
  return { kind: kinds[0] as string, json: args.includes('--json'), offline: args.includes('--offline'), reserve: args.includes('--reserve') };
}

/**
 * `niyam doc-number <kind> [--reserve] [--json] [--offline]`: the next free number alone on standard output, for
 * `$(…)`, and where it came from on standard error; `--reserve` claims it for good.
 */
export function docNumber(sys: Sys, io: Output, args: readonly string[]): number {
  const parsed = docNumberArgs(args);
  const { root } = repoAt(sys);
  const settings = loadDocSettings(sys, root);
  const kind = kindNamed(settings, parsed.kind);
  if (kind === undefined) {
    io.err(`niyam doc-number: no document kind "${parsed.kind}"; ${SETTINGS_PATH} names ${Object.keys(settings.kinds).join(', ')}`);
    return 2;
  }
  const result = allocate(sys, root, settings, kind, { offline: parsed.offline, reserve: parsed.reserve, gh: ghIn(sys, root), warn: io.err });
  if (!result.ok) {
    io.err(`❌ ${result.error}`);
    return 1;
  }
  if (parsed.json) {
    io.out(JSON.stringify({ kind: kind.kind, ...result }, null, 2));
    return 0;
  }
  for (const warning of result.warnings) io.err(`⚠️  ${warning}`);
  const { main, local, pullRequests, workItems, frozen } = result.sources;
  const work = settings.workItems?.kind === kind.kind ? `, ${String(workItems)} in Work item titles, ${String(frozen)} frozen work folder numbers` : '';
  io.err(`→ next free ${kind.citation} number, against ${String(main)} on origin/main, ${String(local)} local, ${String(pullRequests)} claimed by open PRs${work}${parsed.reserve ? ', reserved' : ' (a preview; --reserve claims it)'}:`);
  io.out(result.next);
  return 0;
}
