import { isDeepStrictEqual } from 'node:util';

import { GITHUB_WEB } from './host.ts';
import { CLI, PRODUCT } from './names.ts';
import { GUARD_CALLER_PATH, WORKFLOW_PATH } from './onboard-pull.ts';
import { skipQueueDraftEdit } from './queue-draft.ts';

export { GUARD_CALLER_PATH } from './onboard-pull.ts';

/** niyam's shared Guard, which the caller runs at a release (#469). */
export const SHARED_GUARD = `${PRODUCT}/.github/workflows/shared-guard.yml`;
/**
 * The caller's one job, by id and name: not `Guard`, which today's Guard
 * refuses as an added job of its own check's name, and not `niyam`, which
 * niyam.yml's job already is.
 */
export const CALLER_JOB = `${CLI}-guard`;
/** The check the caller reports, the same in every client and in niyam. */
export const CALLER_CHECK = `${CALLER_JOB} / judge`;

/** How the caller's header starts: a file that starts so is onboard's, which onboard writes again whatever it holds. */
const CALLER_MARK = `# Written by ${CLI} onboard: the shared Guard's caller.`;

/**
 * Whether `text` is onboard's caller, at a release and branch or edited by
 * hand since: onboard writes such a file again, and refuses to overwrite any
 * other, the repository's own.
 */
export async function callerIsOnboards(text: string): Promise<boolean> {
  return text.startsWith(CALLER_MARK) || (await callerAt(text)) !== undefined;
}

/** What the caller and its job may read, and nothing more: the shared Guard reads the pull request through the API. */
const READ_ONLY = ['contents: read', 'pull-requests: read', 'issues: read'];

/**
 * The shared Guard's caller, as onboard writes it: run by
 * pull_request_target on pull requests to `branch`, the default branch, so
 * GitHub runs the default branch's copy of it, never a pull request's; read
 * only, at the top and on its one job; and that job only calls the shared
 * Guard at `version`, the release niyam.yml pins, with no `with:`, no
 * `secrets:` and no steps, as the Guard's `isCaller` asks. Its header names
 * no version, so a run that moves the pin changes the `uses:` line alone.
 * Its job skips an edit of Mergify's queue draft that changes no title or
 * base (`QUEUE_DRAFT_EDIT`). GitHub reports a skipped caller job under its
 * own name alone, so the draft's last `niyam-guard / judge` at that head
 * stands, a refusal included. `older` leaves the skip out, as releases
 * before it wrote the caller.
 */
export function guardCaller(branch: string, version: string, older = false): string {
  return [
    `${CALLER_MARK} onboard writes it again on every run, its pin`,
    `# moving with ${WORKFLOW_PATH}'s; change it by running onboard, not by hand. It holds nothing a pull`,
    "# request could weaken: pull_request_target runs the default branch's copy of it, and the Guard it",
    `# calls runs from the ${CLI} release it pins. Its check is ${CALLER_CHECK}.`,
    'on:',
    '  pull_request_target:',
    '    types: [opened, edited, synchronize, reopened]',
    `    branches: [${JSON.stringify(branch)}]`,
    '',
    'permissions:',
    ...READ_ONLY.map((line) => `  ${line}`),
    '',
    'jobs:',
    `  ${CALLER_JOB}:`,
    `    name: ${CALLER_JOB}`,
    // In ${{ }}: YAML would read a bare leading ! as a tag, and GitHub's docs ask for it there.
    ...(older ? [] : skipQueueDraftEdit('${{ ', ' }}')),
    '    permissions:',
    ...READ_ONLY.map((line) => `      ${line}`),
    `    uses: ${SHARED_GUARD}@v${version}`,
    '',
  ].join('\n');
}

/** The release and branch of a caller as onboard writes it. */
export interface CallerAt {
  version: string;
  branch: string;
  /** Written as releases before the queue-draft skip wrote it, which judge every edit of Mergify's draft. */
  older?: true;
}

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** The caller's `uses:` before the release onboard pins, and that release's form. */
const PIN_PREFIX = `${SHARED_GUARD}@v`;
const RELEASE = /^\d+\.\d+\.\d+$/;

/** A `uses:` line calling the shared Guard at a release, whatever else the file holds. */
const PIN_LINE = new RegExp(`^\\s*uses:\\s*["']?${escape(SHARED_GUARD)}@v(\\d+\\.\\d+\\.\\d+)["']?\\s*(?:#.*)?$`, 'gm');

/**
 * The releases of the shared Guard that `text` calls, read line by line so a
 * caller edited by hand still counts: onboard's downgrade guard reads them
 * beside niyam.yml's, so an older CLI never moves the caller's pin back.
 */
export function callerPins(text: string): string[] {
  return [...text.matchAll(PIN_LINE)].map((match) => match[1] as string);
}

/**
 * The release and branch of `text` when it is the caller as onboard writes
 * it at some release and branch, read as YAML, so its comments and layout do
 * not count; undefined for any other file: another trigger, types, branch
 * list, permission, job, `with:`, `secrets:` or steps, or a pin that is not
 * a release of the shared Guard. doctor marks such a file; onboard writes
 * it again when it is still onboard's (`callerIsOnboards`), and otherwise
 * refuses to overwrite it.
 */
export async function callerAt(text: string): Promise<CallerAt | undefined> {
  const { parse } = await import('yaml');
  let doc: { on?: { pull_request_target?: { branches?: unknown[] } }; jobs?: Record<string, { uses?: unknown } | undefined> };
  try {
    // An empty file is null, read as a mapping of nothing.
    doc = (parse(text) as typeof doc | null) ?? {};
  } catch {
    // fail-open: a file that is not YAML is no caller onboard wrote, which onboard refuses to overwrite and doctor marks.
    return undefined;
  }
  // Read off the file, then held to the whole template: a uses: or a branch list of any other shape differs from it.
  const version = String(doc.jobs?.[CALLER_JOB]?.uses).slice(PIN_PREFIX.length);
  const branch = doc.on?.pull_request_target?.branches?.[0];
  if (typeof branch !== 'string' || !RELEASE.test(version)) return undefined;
  if (isDeepStrictEqual(doc, parse(guardCaller(branch, version)))) return { version, branch };
  return isDeepStrictEqual(doc, parse(guardCaller(branch, version, true))) ? { version, branch, older: true } : undefined;
}

/** The one branch niyam.yml's pushes run on, read as YAML; undefined when it names none or several, or does not parse. */
export async function pushBranch(text: string): Promise<string | undefined> {
  const { parse } = await import('yaml');
  let doc: { on?: { push?: { branches?: unknown } } };
  try {
    doc = (parse(text) as typeof doc | null) ?? {};
  } catch {
    // fail-open: a workflow that is not YAML names no branch, which doctor says leaves the caller unchecked.
    return undefined;
  }
  const branches = doc.on?.push?.branches;
  return Array.isArray(branches) && branches.length === 1 && typeof branches[0] === 'string' ? branches[0] : undefined;
}

/** What onboard does with the caller. */
export type CallerUpdate = { kind: 'same' } | { kind: 'write'; text: string } | { kind: 'rewrite'; text: string } | { kind: 'repin'; text: string; from?: string; branch?: string; drafts?: true };

/**
 * What onboard does with the caller, given the checkout's `before` and,
 * when it is onboard's, the release and branch it is at (`at`): write it
 * where there is none, move its pin to `version` and its branch to `branch`,
 * add the queue-draft skip to an older one (`drafts`), or write it again
 * where only its comments or layout differ.
 */
export function callerUpdate(before: string | undefined, at: CallerAt | undefined, branch: string, version: string): CallerUpdate {
  const text = guardCaller(branch, version);
  if (before === undefined) return { kind: 'write', text };
  if (before === text) return { kind: 'same' };
  const from = at !== undefined && at.version !== version ? at.version : undefined;
  const moved = at !== undefined && at.branch !== branch ? branch : undefined;
  const drafts = at?.older === true;
  if (from === undefined && moved === undefined && !drafts) return { kind: 'rewrite', text };
  return { kind: 'repin', text, ...(from === undefined ? {} : { from }), ...(moved === undefined ? {} : { branch: moved }), ...(drafts ? { drafts } : {}) };
}

/** What a caller update changes, in a few words for the plan. */
export function callerDetail(update: Exclude<CallerUpdate, { kind: 'same' }>, version: string): string {
  if (update.kind === 'write') return `new, the shared Guard at v${version}`;
  if (update.kind === 'rewrite') return 'written again';
  return [...(update.from ? [`pin → v${version}`] : []), ...(update.branch ? [`branch → ${update.branch}`] : []), ...(update.drafts ? ["skips Mergify's queue-draft edits"] : [])].join(', ');
}

/** What a caller update changes, in full for the pull request's description. */
export function callerWhat(update: Exclude<CallerUpdate, { kind: 'same' }>, version: string, branch: string): string {
  const holds = `on each pull request to ${branch} it runs ${PRODUCT}'s Guard at v${version}, the release ${WORKFLOW_PATH} pins, as the check ${CALLER_CHECK}, and does nothing else`;
  if (update.kind === 'write') return `write ${GUARD_CALLER_PATH}, the shared Guard's caller: ${holds}`;
  if (update.kind === 'rewrite') return `write ${GUARD_CALLER_PATH}, the shared Guard's caller, again as onboard writes it: ${holds}`;
  const parts = [
    ...(update.from ? [`move its pin from v${update.from} to v${version}`] : []),
    ...(update.branch ? [`run it on pull requests to the default branch, ${update.branch}`] : []),
    ...(update.drafts ? [`skip an edit of Mergify's queue draft that changes no title or base, so the draft's last ${CALLER_CHECK} at its head stands`] : []),
  ];
  return `in ${GUARD_CALLER_PATH}, the shared Guard's caller, ${parts.join(' and ')}`;
}

/**
 * The step a public repository's owner takes once, for onboard's "By hand"
 * and the pull request's "Left to do by hand": from 2026-12-02 GitHub blocks
 * pull_request_target in public repositories without a policy that allows
 * it for the workflow, and the caller runs on nothing else.
 */
export function policySteps(slug: string): { byHand: string; later: string } {
  const at = `${GITHUB_WEB}/${slug}/settings/actions`;
  return {
    byHand: `Once for ${slug}: allow pull_request_target for ${GUARD_CALLER_PATH} in a new policy under Settings → Actions → Policies, at ${at}, since from 2026-12-02 GitHub blocks it in public repositories without one; skip it if done.`,
    later: `Allow pull_request_target for \`${GUARD_CALLER_PATH}\` in a new policy under ${slug} → Settings → Actions → Policies (${at}): from 2026-12-02 GitHub blocks the event in public repositories without one, and the shared Guard's caller runs on it alone.`,
  };
}
