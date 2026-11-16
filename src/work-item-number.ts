import { SETTINGS_PATH, repoAt } from './agent.ts';
import {
  type Allocation,
  type DocKind,
  type DocSettings,
  type RunGh,
  type WorkItem,
  type WorkItems,
  allocate,
  basenamesOnRef,
  detail,
  frozenEntries,
  ghIn,
  listWorkItems,
  loadDocSettings,
  numberFromFilename,
  numberFromName,
  numberFromWorkItemTitle,
  prClaimedNumbers,
  schema,
  wholeNumber,
} from './doc-numbers.ts';
import type { Output, Sys } from './types.ts';

/**
 * Work item numbers, checked on the issues themselves: a session that files a Work item by hand, or from another
 * repository, never runs the allocator, so a workflow runs this on the issues' own events (filed, typed, retitled)
 * and on a schedule. Each run renumbers, to the allocator's next free numbers:
 *
 *   1. the issue the event names, when anything else holds its number: it just took the number, so it yields;
 *   2. then every other clash: of two Work items with one number the earlier-filed keeps it, and a Work item yields
 *      to a document on main, an open pull request's new document, or a frozen folder (for an issue filed after
 *      `lastMovedIssue`).
 *
 * Each renumbered issue gets a comment naming its old number and the holder, posted once. With `workItems.label`,
 * every run also labels each Work item still without it, read before any write.
 */

export interface Renumber {
  readonly issue: number;
  readonly from: string;
  readonly to: string;
  readonly holder: string;
  readonly title: string;
}

export interface Sources {
  readonly items: readonly WorkItem[];
  readonly mainNames: readonly string[];
  readonly prNumbers: ReadonlySet<string>;
}

interface EventItem {
  readonly item: WorkItem;
  readonly work: string;
}

interface Move {
  readonly item: WorkItem;
  readonly work: string;
  readonly holder: string;
}

const describe = (item: WorkItem): string => `#${String(item.number)} (${item.title})`;

/** What outside the Work items holds `number` against `item`, or null. */
function externalHolder(settings: DocSettings, kind: DocKind, item: WorkItem, number: string, s: Sources): string | null {
  const doc = s.mainNames.find((name) => numberFromFilename(name) === number);
  if (doc !== undefined) return `\`${kind.dir}/${doc}\` on main`;
  if (s.prNumbers.has(number)) return `an open pull request's new ${kind.citation}-${number}`;
  if (item.number <= (settings.workItems?.lastMovedIssue ?? 0)) return null;
  const frozen = frozenEntries(settings, kind.kind).find((path) => numberFromName(path) === number);
  return frozen === undefined ? null : `the frozen work folder \`${frozen}\``;
}

/** Which Work items must move, each with what holds its number. */
export function planMoves(settings: DocSettings, kind: DocKind, sources: Sources, event: EventItem | null): Map<number, Move> {
  const moving = new Map<number, Move>();
  const items = [...sources.items].sort((a, b) => a.number - b.number);
  if (event !== null) {
    const other = items.find((i) => i.workNumber === event.work && i.number !== event.item.number);
    const holder = other === undefined ? externalHolder(settings, kind, event.item, event.work, sources) : describe(other);
    if (holder !== null) moving.set(event.item.number, { item: event.item, work: event.work, holder });
  }
  const keeper = new Map<string, WorkItem>();
  for (const item of items) {
    const work = item.workNumber;
    if (work === null || moving.has(item.number)) continue;
    const first = keeper.get(work);
    if (first === undefined) keeper.set(work, item);
    else moving.set(item.number, { item, work, holder: describe(first) });
  }
  for (const [work, item] of keeper) {
    const holder = externalHolder(settings, kind, item, work, sources);
    if (holder !== null) moving.set(item.number, { item, work, holder });
  }
  return moving;
}

/** The hidden line that tells a rerun this renumber is already explained. */
export function renumberMarker(from: string, to: string): string {
  return `<!-- work-item-number: renumbered from ${from} to ${to} -->`;
}

/** The comment a renumbered issue carries. */
export function renumberComment(work: WorkItems, from: string, to: string, holder: string): string {
  const reserve = work.reserveCommand ?? `niyam doc-number ${work.kind} --reserve`;
  return [
    `Renumbered from ${from} to ${to}: ${from} is already held by ${holder}. Numbers are identity and never reused.`,
    '',
    `A Work item takes its number from \`${reserve}\` before \`gh issue create\`. This one was filed without it, so the \`work-item-number\` check took the next free number from the same allocator.`,
    renumberMarker(from, to),
  ].join('\n');
}

/** One issue as `gh api …/issues/N --jq '{number, title, type: .type.name}'` gives it; `type` is null untyped. */
const IssueSchema = schema((value): { title: string; type: string | null } => {
  const { title, type } = (typeof value === 'object' && value !== null ? value : {}) as { title?: unknown; type?: unknown };
  if (typeof title !== 'string' || (type !== null && typeof type !== 'string')) throw new Error('unexpected shape');
  return { title, type };
});

/** The event's issue as a Work item, or why it needs nothing; throws when it cannot be read. */
function readEvent(work: WorkItems, gh: RunGh, issue: number, previousTitle: string | undefined): EventItem | string {
  const at = `#${String(issue)}`;
  const raw = gh(['api', `repos/{owner}/{repo}/issues/${String(issue)}`, '--jq', '{number, title, type: .type.name}']);
  let read: { title: string; type: string | null };
  try {
    read = IssueSchema.parse(JSON.parse(raw));
  } catch (error) {
    throw new Error(error instanceof SyntaxError ? `${at} came back as text that is not JSON` : `${at} came back in an unexpected shape`);
  }
  const { title, type } = read;
  if (type !== work.issueType) return `${at} is not a ${work.issueType}`;
  const workNumber = numberFromWorkItemTitle(title);
  if (workNumber === null) return `${at}'s title carries no number`;
  // A retitle that keeps the number took nothing new, so an earlier holder must not yield to it.
  if (previousTitle !== undefined && numberFromWorkItemTitle(previousTitle) === workNumber) return `${at} kept its number ${workNumber}`;
  return { item: { number: issue, title, workNumber }, work: workNumber };
}

/**
 * Comment, then retitle: a run that stops between them leaves the clash, so a rerun renumbers again and, finding the
 * marker, does not comment twice. A title changed since the run listed it stops the renumber: that edit's own run
 * checks it again.
 */
function applyRenumber(work: WorkItems, gh: RunGh, move: Renumber, was: string): void {
  const issue = String(move.issue);
  const unchanged = () => {
    const now = gh(['api', `repos/{owner}/{repo}/issues/${issue}`, '--jq', '.title']).trimEnd();
    if (now !== was) throw new Error(`its title changed during the run, to "${now}"; that edit's own run checks it again`);
  };
  unchanged();
  const comments = gh(['api', '--paginate', `repos/{owner}/{repo}/issues/${issue}/comments`, '--jq', '.[].body']);
  if (!comments.includes(renumberMarker(move.from, move.to))) gh(['issue', 'comment', issue, '--body', renumberComment(work, move.from, move.to, move.holder)]);
  unchanged();
  gh(['issue', 'edit', issue, '--title', move.title]);
}

export type Check = { ok: true; note: string | null; renumbers: readonly Renumber[]; applied: boolean } | { ok: false; error: string };

export interface CheckOptions {
  readonly apply?: boolean;
  readonly issue?: number;
  readonly previousTitle?: string;
  readonly ref?: string;
  /** The allocator; a test may give its own answer. */
  readonly allocate?: () => Allocation;
}

/** Checks the event's issue and every Work item; with `apply`, renumbers each clash. An incomplete source is an error. */
export function checkWorkItemNumbers(sys: Sys, root: string, settings: DocSettings, gh: RunGh, options: CheckOptions = {}): Check {
  const work = settings.workItems as WorkItems;
  const kind = settings.kinds[work.kind] as DocKind;
  const ref = options.ref ?? 'origin/main';
  let event: EventItem | null = null;
  let note: string | null = null;
  if (options.issue !== undefined) {
    let read: EventItem | string;
    try {
      read = readEvent(work, gh, options.issue, options.previousTitle);
    } catch (error) {
      // fail-open: the failure is the return value, and the command exits 1 on it.
      return { ok: false, error: `could not read #${String(options.issue)}: ${detail(error)}` };
    }
    if (typeof read === 'string') note = read;
    else event = read;
  }
  const mainNames = basenamesOnRef(sys, kind, ref, root);
  if (mainNames === null) return { ok: false, error: `could not read \`${ref}\` — fetch it first` };
  const listed = listWorkItems(work, gh);
  const claims = prClaimedNumbers(kind, mainNames, gh);
  const warnings = [...listed.warnings, ...claims.warnings];
  if (warnings.length > 0) return { ok: false, error: `sources incomplete: ${warnings.join('; ')}` };
  const moving = planMoves(settings, kind, { items: listed.items, mainNames, prNumbers: claims.numbers }, event);
  if (moving.size === 0) return { ok: true, note, renumbers: [], applied: options.apply ?? false };
  // A preview, not a reservation: a runner's reservation refs die with it. A number picked blind could clash again,
  // so a warning is an error here. Every number above the allocator's answer is free, so the moves count up.
  const next = options.allocate ? options.allocate() : allocate(sys, root, settings, kind, { ref, gh });
  if (!next.ok) return next;
  if (next.warnings.length > 0) return { ok: false, error: `allocator incomplete: ${next.warnings.join('; ')}` };
  const first = /^\d{4}$/.test(next.next) ? wholeNumber(next.next) : Number.NaN;
  if (!/^\d{4}$/.test(next.next) || first < 1 || first + moving.size > 10_000) return { ok: false, error: `no room for ${String(moving.size)} number(s) from ${next.next}` };
  const planned = [...moving.values()].map(({ item, work: from, holder }, index) => {
    const to = String(first + index).padStart(4, '0');
    return { move: { issue: item.number, from, to, holder, title: item.title.trimStart().replace(/^\d{4}/, to) }, was: item.title };
  });
  const renumbers = planned.map(({ move }) => move);
  if (!options.apply) return { ok: true, note, renumbers, applied: false };
  for (const { move, was } of planned) {
    try {
      applyRenumber(work, gh, move, was);
    } catch (error) {
      // fail-open: the failure is the return value, and the command exits 1 on it.
      return { ok: false, error: `could not renumber #${String(move.issue)}: ${detail(error)}` };
    }
  }
  return { ok: true, note, renumbers, applied: true };
}

/** Every Work item still without `label`, read before any write; a run that cannot read it changes nothing. */
export function unlabelledWorkItems(work: WorkItems & { label: string }, gh: RunGh): { ok: true; issues: number[] } | { ok: false; error: string } {
  const issues: number[] = [];
  try {
    const out = gh(['api', '--paginate', `repos/{owner}/{repo}/issues?state=all&type=${encodeURIComponent(work.issueType)}&per_page=100`, '--jq', `.[] | select(.type.name == ${JSON.stringify(work.issueType)}) | select(any(.labels[]; .name == ${JSON.stringify(work.label)}) | not) | .number`]);
    for (const line of out.split('\n')) {
      if (line === '') continue;
      if (!/^[1-9]\d{0,8}$/.test(line)) throw new Error(`unexpected issue number "${line}"`);
      issues.push(wholeNumber(line));
    }
  } catch (error) {
    // fail-open: the failure is the return value, and the command exits 1 on it.
    return { ok: false, error: `could not list unlabelled Work items: ${detail(error)}` };
  }
  return { ok: true, issues };
}

/** work-item-number's arguments: `--issue N` and `--apply`. */
export function workItemArgs(args: readonly string[]): { issue?: number; apply: boolean } {
  let issue: number | undefined;
  let apply = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === '--apply') apply = true;
    else if (arg === '--issue' || arg.startsWith('--issue=')) {
      const value = arg === '--issue' ? args[++i] : arg.slice('--issue='.length);
      if (value === undefined || !/^[1-9]\d{0,7}$/.test(value)) throw new Error('work-item-number --issue needs an issue number');
      if (issue !== undefined) throw new Error('work-item-number takes one --issue');
      issue = wholeNumber(value);
    } else throw new Error(`work-item-number: unexpected argument "${arg}"`);
  }
  return { ...(issue === undefined ? {} : { issue }), apply };
}

/**
 * `niyam work-item-number [--issue N] [--apply]`: a preview, or with --apply the renumbers and labels. A retitle's
 * old title comes in WORK_ITEM_PREVIOUS_TITLE, never an argument: anyone filing an issue chooses it.
 */
export function workItemNumber(sys: Sys, io: Output, args: readonly string[]): number {
  const parsed = workItemArgs(args);
  const { root } = repoAt(sys);
  const settings = loadDocSettings(sys, root);
  const work = settings.workItems;
  if (work === undefined) {
    io.err(`niyam work-item-number: ${SETTINGS_PATH}'s "docNumbers" names no "workItems"`);
    return 2;
  }
  const gh = ghIn(sys, root);
  const label = work.label;
  const unlabelled = label === undefined ? ({ ok: true, issues: [] } as const) : unlabelledWorkItems({ ...work, label }, gh);
  if (!unlabelled.ok) {
    io.err(`❌ ${unlabelled.error}`);
    return 1;
  }
  const previous = sys.env.WORK_ITEM_PREVIOUS_TITLE;
  const result = checkWorkItemNumbers(sys, root, settings, gh, { apply: parsed.apply, ...(parsed.issue === undefined ? {} : { issue: parsed.issue }), ...(previous === undefined ? {} : { previousTitle: previous }) });
  let code = 0;
  if (result.ok) {
    if (result.note !== null) io.out(`✓ ${result.note}`);
    if (result.renumbers.length === 0) io.out('✓ no Work item shares a number');
    const verb = result.applied ? '✓ renumbered' : '→ would renumber';
    for (const move of result.renumbers) io.out(`${verb} #${String(move.issue)} from ${move.from} to ${move.to} (${move.from} is held by ${move.holder})`);
  } else {
    io.err(`❌ ${result.error}`);
    code = 1;
  }
  if (label === undefined) return code;
  // Labelled whatever the number check found: the board needs every Work item.
  if (parsed.apply) {
    for (const issue of unlabelled.issues) {
      try {
        gh(['issue', 'edit', String(issue), '--add-label', label]);
      } catch (error) {
        // fail-open: reported, and the command exits 1.
        io.err(`❌ could not label #${String(issue)}: ${detail(error)}`);
        return 1;
      }
    }
  }
  if (unlabelled.issues.length === 0) io.out(`✓ every Work item carries ${label}`);
  for (const issue of unlabelled.issues) io.out(`${parsed.apply ? '✓ labelled' : '→ would label'} #${String(issue)} ${label}`);
  return code;
}
