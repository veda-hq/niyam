import { basename, dirname } from 'node:path';

import { githubSlug, isNoToken, SETTINGS_PATH } from './agent.ts';
import { agentEnv } from './as-agent.ts';
import { restList } from './pages.ts';
import type { Output, Sys } from './types.ts';
import { sessionToken } from './work.ts';

/**
 * Claude Code's Stop hook: a session whose branch has commits the default
 * branch lacks keeps going until its pull request merges (docs/decisions.md,
 * W-56.5). Started work stops only when merged, stuck on the owner, or proven
 * unneeded; a session that ends a turn waiting on something that cannot wake
 * it stalls for hours, so this sends it back with what is left.
 *
 * The session may stop when any of these holds:
 * - it is a subagent;
 * - its branch is the base or another trunk, detached, has no commit the
 *   base lacks (or git cannot say), or has its commits inside another remote
 *   branch while its own is not pushed (that branch carries them);
 * - it wrote a stop note at this commit (`niyam keep-going --stop <why>`);
 *   the hook shows the owner the reason once;
 * - its pull request merged at this commit, or GitHub cannot say (fail open);
 * - a background task, or a `git commit` or `git push` in its worktree,
 *   still runs (its exit wakes the session), unless it runs in print mode,
 *   where the task dies with the turn;
 * - it is a desktop session, clean, with every commit on a ready pull
 *   request: the app's Autofix wakes it;
 * - it was sent back five times at one commit: the hook writes the stop note
 *   itself and sends it back once more to say so.
 *
 * Otherwise it is sent back with what is left and the count ("1 of 5"). A
 * new commit resets the count and voids a stop note. A cloud session is held
 * the same way, since nothing there wakes a stopped one; pull requests are
 * read over REST, which its proxy allows.
 */

export const CAP = 5;
export const STORE = '.tmp/keep-going';
export const PRINT_MODE_VAR = 'NIYAM_PRINT_MODE';
export const STOP_COMMAND = 'niyam keep-going --stop "<why, in plain English>"';

/** `.github/niyam.json`'s `"keepGoing"`. */
export interface KeepGoingSettings {
  /** The branch work merges into. */
  base: string;
  /** Other shared branches, whose unpushed commits are not a session's. */
  trunks: string[];
  /** Older names of the print-mode variable, read beside NIYAM_PRINT_MODE. */
  printMode: string[];
  /** Who a session tells when it stops: a name, or "the owner". */
  owner: string;
  /** What the messages call this hook. */
  tag: string;
}

const DEFAULTS: KeepGoingSettings = { base: 'main', trunks: [], printMode: [], owner: 'the owner', tag: 'niyam keep-going' };
const where = `${SETTINGS_PATH} "keepGoing"`;
const BRANCH = /^(?!\/)(?!.*\/\/)(?!.*\.\.)[\w.\/+-]+$/;

function oneLine(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim() || /[\r\n]/.test(value)) throw new Error(`${where}.${name} must be one line`);
  return value;
}

/** The settings, from the parsed settings file; throws naming the first bad key. */
export function keepGoingSettings(raw: unknown): KeepGoingSettings {
  const value = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>).keepGoing : undefined;
  if (value === undefined) return { ...DEFAULTS };
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${where} must be an object`);
  const { base = DEFAULTS.base, trunks = DEFAULTS.trunks, printMode = DEFAULTS.printMode, owner = DEFAULTS.owner, tag = DEFAULTS.tag, ...rest } = value as Record<string, unknown>;
  const extra = Object.keys(rest)[0];
  if (extra !== undefined) throw new Error(`${where} has an unknown key "${extra}"; it takes "base", "trunks", "printMode", "owner" and "tag"`);
  if (typeof base !== 'string' || !BRANCH.test(base)) throw new Error(`${where}.base must be a branch name`);
  if (!Array.isArray(trunks) || !trunks.every((item) => typeof item === 'string' && BRANCH.test(item))) throw new Error(`${where}.trunks must be a list of branch names`);
  if (!Array.isArray(printMode) || !printMode.every((item) => typeof item === 'string' && /^[A-Z_][A-Z0-9_]*$/.test(item))) throw new Error(`${where}.printMode must be a list of variable names`);
  return { base, trunks: trunks as string[], printMode: printMode as string[], owner: oneLine(owner, 'owner'), tag: oneLine(tag, 'tag') };
}

function settingsAt(sys: Sys, root: string): KeepGoingSettings {
  const path = `${root}/${SETTINGS_PATH}`;
  return sys.exists(path) ? keepGoingSettings(JSON.parse(sys.read(path)) as unknown) : { ...DEFAULTS };
}

export interface PullRequest {
  number: number;
  state: 'OPEN' | 'MERGED' | 'CLOSED';
  isDraft: boolean;
  headRefOid: string;
}

/** A session's recorded reason to stop, valid at one commit. */
export interface StopNote {
  branch: string;
  head: string;
  reason: string;
  at: string;
  /** Already shown to the owner on a stop it let through. */
  shown?: boolean;
}

export interface Facts {
  desktop: boolean;
  /** Print mode (`claude -p`): the process ends with the turn, so nothing wakes it. */
  print: boolean;
  subagent: boolean;
  /** The checked-out branch, or '' when detached. */
  branch: string;
  head: string;
  /** Commits on HEAD the base lacks; null when git cannot say. */
  ahead: number | null;
  /** Another remote branch holds HEAD while this branch's own does not. */
  carried: boolean;
  note: StopNote | null;
  /** The remote-tracking commit of this branch, or null when never pushed. */
  remote: string | null;
  /** null: no pull request; 'unknown': GitHub could not say. */
  pr: PullRequest | null | 'unknown';
  /** A background task, or a commit or push, is running: its exit wakes the session. */
  pushing: boolean;
  /** Tracked files changed but not committed. */
  dirty: boolean;
}

export interface Counter {
  head: string;
  count: number;
}

export type Decision =
  /** `record`: the cap was reached; write it as the stop note. `say`: a stop note's reason, not yet shown. */
  { stop: true; counter: Counter; record?: string; say?: string } | { stop: false; reason: string; counter: Counter };

const noteHolds = (facts: Facts): facts is Facts & { note: StopNote } => facts.note !== null && facts.note.branch === facts.branch && facts.note.head === facts.head;

/** Work the rule does not hold: nothing to merge, or not the session's. */
function notStarted(facts: Facts, settings: KeepGoingSettings): boolean {
  return !(facts.ahead !== null && facts.ahead > 0) || facts.branch === '' || facts.branch === settings.base || settings.trunks.includes(facts.branch) || facts.carried;
}

export function decide(facts: Facts, previous: Counter | null, settings: KeepGoingSettings): Decision {
  const counter = previous?.head === facts.head ? previous : { head: facts.head, count: 0 };
  const { pr } = facts;
  if (facts.subagent || notStarted(facts, settings)) return { stop: true, counter };
  if (noteHolds(facts)) return facts.note.shown ? { stop: true, counter } : { stop: true, counter, say: facts.note.reason };
  if ((facts.pushing && !facts.print) || pr === 'unknown') return { stop: true, counter };
  // A merge releases the session only if it merged this commit: a reused
  // branch name can still show an older merged pull request, and work left
  // uncommitted on top is not merged either.
  if (pr?.state === 'MERGED' && pr.headRefOid === facts.head && !facts.dirty) return { stop: true, counter };
  const pushed = facts.remote === facts.head;
  // A draft still needs the session; only a ready pull request waits on
  // events Autofix reports, and only once nothing is left uncommitted.
  if (facts.desktop && pr?.state === 'OPEN' && !pr.isDraft && pushed && !facts.dirty) return { stop: true, counter };

  const count = counter.count + 1;
  const next = { head: facts.head, count };
  if (count > CAP) {
    return {
      stop: true,
      counter: next,
      record: `stop hook: the session tried to stop ${CAP + 1} times at ${facts.head.slice(0, 9)} with no new commit and gave no reason; cause unknown, ${settings.owner} to look (${settings.tag} cap)`,
    };
  }
  const release = `If only ${settings.owner} can unblock it, or it is proven unneeded, run \`${STOP_COMMAND}\` and say so to ${settings.owner}; then you may stop. After ${CAP}, the hook writes that note itself.`;
  // A running task in print mode (only then does one get here): gather read
  // nothing past it, since the task may still be changing the branch.
  const left = facts.pushing ? ['a commit, push or background task is running, and in print mode it dies with this turn: wait for it in the foreground'] : stillToDo(facts, pr, pushed);
  const what = `Branch ${facts.branch} has ${facts.ahead} commit(s) origin/${settings.base} lacks, and started work runs to merge`;
  return {
    stop: false,
    counter: next,
    reason: `${what}. ${left.join('; ')}. Do not end a turn waiting on something that cannot wake you. ${release} (${settings.tag}, ${count} of ${CAP}.)`,
  };
}

/** What is left before the merge. */
function stillToDo(facts: Facts, pr: PullRequest | null, pushed: boolean): string[] {
  const left: string[] = [];
  if (!pushed) {
    left.push(facts.remote === null ? 'the branch is not on the remote: push it' : 'local commits are not on the remote: push them');
    left.push(facts.print ? 'in print mode nothing wakes you: run the push in the foreground with the longest Bash timeout' : 'run the push as a background task so you are told when it exits');
  }
  if (pr === null) left.push('no pull request yet: open it');
  else if (pr.state === 'MERGED') left.push(`PR ${pr.number} merged an older commit; the work since is not merged: commit it and open a new PR`);
  else if (pr.state !== 'OPEN') left.push(`PR ${pr.number} was closed without merging: reopen it, or record why the work stops`);
  else if (pushed && pr.isDraft) left.push(`PR ${pr.number} is a draft: finish the work, push, mark it ready`);
  else if (pushed) left.push(`PR ${pr.number} is open: carry it to merge, polling checks and review threads with foreground waits`);
  return left;
}

function out(sys: Sys, root: string, command: string, args: readonly string[]): string | null {
  const result = sys.exec(command, args, { cwd: root, timeoutMs: 20_000 });
  return result.code === 0 ? result.stdout.trim() : null;
}

/**
 * Is this command line `git [global options] commit|push …`? Only global
 * options may precede git's command, so `git log --grep push` is not one.
 */
export function gitVerb(words: readonly string[]): boolean {
  const start = words.findIndex((word) => basename(word) === 'git');
  if (start < 0) return false;
  for (let at = start + 1; at < words.length; at++) {
    const word = words[at] as string;
    if (word === '-C' || word === '-c') at++;
    else if (!word.startsWith('-')) return word === 'push' || word === 'commit';
  }
  return false;
}

/** Is a `git commit` or `git push` running with its working directory in this worktree? */
export function pushInFlight(sys: Sys, root: string): boolean {
  const table = out(sys, root, 'ps', ['-Ao', 'pid=,command=']);
  if (table === null) return false;
  return table
    .split('\n')
    .flatMap((line) => {
      const [pid = '', ...words] = line.trim().split(/\s+/);
      return /^\d+$/.test(pid) && gitVerb(words) ? [pid] : [];
    })
    .some((pid) => {
      const path = out(sys, root, 'lsof', ['-a', '-p', pid, '-d', 'cwd', '-Fn'])
        ?.split('\n')
        .find((line) => line.startsWith('n'))
        ?.slice(1);
      return path !== undefined && (path === root || path.startsWith(`${root}/`));
    });
}

/**
 * Does the Claude process `claudePid` still run a background task? Its Bash
 * tasks are direct children running a shell that sources a snapshot from
 * `shell-snapshots/`; at Stop every foreground one has ended.
 */
export function backgroundTask(sys: Sys, claudePid: string | undefined, root: string): boolean {
  if (!claudePid) return false;
  const table = out(sys, root, 'ps', ['-Ao', 'pid=,ppid=,command=']);
  if (table === null) return false;
  return table.split('\n').some((line) => {
    const match = /^\s*\d+\s+(\d+)\s+(.*)$/.exec(line);
    return match !== null && match[1] === claudePid && /\/shell-snapshots\/snapshot-/.test(match[2] as string);
  });
}

/** Does a remote branch other than this one and the base hold HEAD? Git silent reads as "carried" (fail open). */
export function carriedElsewhere(sys: Sys, root: string, branch: string, base: string): boolean {
  const refs = out(sys, root, 'git', ['for-each-ref', '--contains', 'HEAD', '--format=%(refname:short)', 'refs/remotes/origin']);
  if (refs === null) return true;
  const own = new Set([`origin/${branch}`, `origin/${base}`, 'origin/HEAD', 'origin']);
  return refs.split('\n').some((ref) => ref !== '' && !own.has(ref));
}

const notePath = (root: string): string => `${root}/${STORE}/stop-note.json`;

/** The worktree's stop note, or null. A torn note throws: the hook fails open. */
export function readStopNote(sys: Sys, root: string): StopNote | null {
  const path = notePath(root);
  return sys.exists(path) ? (JSON.parse(sys.read(path)) as StopNote) : null;
}

export function writeStopNote(sys: Sys, root: string, note: StopNote): void {
  sys.mkdir(dirname(notePath(root)));
  sys.write(notePath(root), `${JSON.stringify(note)}\n`);
}

/** The token to read the pull request with: the session's agent, or the shell's own outside a session; undefined when there is none. */
function tokenFor(sys: Sys, root: string, session: string | undefined): string | undefined {
  if (session === undefined) return sessionToken(sys);
  const env = agentEnv(sys, session, root);
  if ('problem' in env) return undefined;
  const token = env.env.GH_TOKEN;
  return token && !isNoToken(token) ? token : undefined;
}

/**
 * This branch's pull request, from REST: the one from this repository
 * carrying this commit, else the newest from it; null with none; 'unknown'
 * when origin is not on GitHub, there is no token, or GitHub cannot say.
 */
export async function readPr(sys: Sys, root: string, branch: string, head: string, session: string | undefined): Promise<PullRequest | null | 'unknown'> {
  const slug = githubSlug(out(sys, root, 'git', ['config', '--get', 'remote.origin.url']) ?? '');
  if (!slug) return 'unknown';
  const token = tokenFor(sys, root, session);
  if (!token) return 'unknown';
  let pulls: unknown[];
  try {
    pulls = await restList(sys, token, `repos/${slug}/pulls?head=${encodeURIComponent(`${slug.split('/')[0]}:${branch}`)}&state=all`);
  } catch {
    return 'unknown';
  }
  const own: PullRequest[] = [];
  for (const item of pulls) {
    const pull = item as { number?: unknown; state?: unknown; draft?: unknown; merged_at?: unknown; head?: { sha?: unknown; repo?: { full_name?: unknown } | null } };
    if (!Number.isInteger(pull.number) || typeof pull.state !== 'string' || typeof pull.draft !== 'boolean' || typeof pull.head?.sha !== 'string') return 'unknown';
    // A fork's branch can share the name.
    const from = pull.head.repo?.full_name;
    if (typeof from !== 'string' || from.toLowerCase() !== slug.toLowerCase()) continue;
    own.push({ number: pull.number as number, state: pull.merged_at ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED', isDraft: pull.draft, headRefOid: pull.head.sha });
  }
  // A reused branch name lists several: the one carrying this commit is the branch's, else the newest.
  return own.find((pr) => pr.headRefOid === head) ?? own[0] ?? null;
}

export async function gather(sys: Sys, root: string, settings: KeepGoingSettings, subagent: boolean, session: string | undefined): Promise<Facts> {
  const head = out(sys, root, 'git', ['rev-parse', 'HEAD']) ?? '';
  const branch = out(sys, root, 'git', ['symbolic-ref', '--quiet', '--short', 'HEAD']) ?? '';
  const facts: Facts = {
    desktop: sys.env.CLAUDE_CODE_ENTRYPOINT === 'claude-desktop',
    print: [PRINT_MODE_VAR, ...settings.printMode].some((name) => sys.env[name] === '1'),
    subagent,
    branch,
    head,
    ahead: null,
    carried: false,
    note: null,
    remote: out(sys, root, 'git', ['rev-parse', '--verify', '--quiet', '@{u}']),
    pr: null,
    pushing: false,
    dirty: false,
  };
  if (subagent) return facts;
  const ahead = Number(out(sys, root, 'git', ['rev-list', '--count', `origin/${settings.base}..HEAD`]) ?? NaN);
  facts.ahead = Number.isInteger(ahead) ? ahead : null;
  if (notStarted(facts, settings)) return facts;
  facts.carried = facts.remote !== head && carriedElsewhere(sys, root, branch, settings.base);
  facts.note = readStopNote(sys, root);
  if (notStarted(facts, settings) || noteHolds(facts)) return facts;
  facts.pushing = backgroundTask(sys, sys.env.CLAUDE_PID, root) || pushInFlight(sys, root);
  if (facts.pushing) return facts;
  facts.dirty = Boolean(out(sys, root, 'git', ['status', '--porcelain']));
  facts.pr = await readPr(sys, root, branch, head, session);
  return facts;
}

/** The hook: reads the Stop input, returns a block decision, a message, or nothing. Never throws. */
export async function stopHook(sys: Sys, input: string): Promise<string> {
  try {
    const data = JSON.parse(input || 'null') as { session_id?: unknown; cwd?: unknown; agent_id?: unknown } | null;
    const cwd = typeof data?.cwd === 'string' && data.cwd ? data.cwd : sys.env.CLAUDE_PROJECT_DIR;
    if (!data || !cwd) return '';
    const root = out(sys, cwd, 'git', ['rev-parse', '--show-toplevel']);
    if (!root) return '';
    const settings = settingsAt(sys, root);
    const session = typeof data.session_id === 'string' && data.session_id ? data.session_id : undefined;
    const file = `${root}/${STORE}/${(session ?? 'unknown').replace(/[^\w-]/g, '_')}.json`;
    const previous = sys.exists(file) ? (JSON.parse(sys.read(file)) as Counter) : null;
    const facts = await gather(sys, root, settings, Boolean(data.agent_id), session);
    const decision = decide(facts, previous, settings);
    sys.mkdir(`${root}/${STORE}`);
    sys.write(file, JSON.stringify(decision.counter));
    if (!decision.stop) return JSON.stringify({ decision: 'block', reason: decision.reason });
    if (decision.say !== undefined && facts.note) {
      // Shown once: the session already said so; this makes sure the owner saw it.
      writeStopNote(sys, root, { ...facts.note, shown: true });
      return JSON.stringify({ systemMessage: `Stopped: ${decision.say}` });
    }
    if (decision.record) {
      writeStopNote(sys, root, { branch: facts.branch, head: facts.head, reason: decision.record, at: sys.now().toISOString(), shown: true });
      return JSON.stringify({
        decision: 'block',
        reason: `The stop hook wrote a stop note for ${facts.branch}: started work is held at ${facts.head.slice(0, 9)} with no reason given. Tell ${settings.owner} what happened, why, and the options; then stop.`,
        systemMessage: `${facts.branch} stopped by the hook: ${decision.record}.`,
      });
    }
    return '';
  } catch {
    return '';
  }
}

/** `--stop <why>`: records why started work stops at this commit (stuck on the owner, or proven unneeded). */
export function recordStop(sys: Sys, reason: string): { ok: boolean; message: string } {
  const root = out(sys, sys.cwd, 'git', ['rev-parse', '--show-toplevel']);
  const head = root && out(sys, root, 'git', ['rev-parse', 'HEAD']);
  const branch = root && out(sys, root, 'git', ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (!root || !head || !branch) return { ok: false, message: 'Not on a branch of a git checkout.' };
  if (reason.trim() === '') return { ok: false, message: `Say why in plain English: ${STOP_COMMAND}` };
  let owner = DEFAULTS.owner;
  try {
    owner = settingsAt(sys, root).owner;
  } catch {
    // The note matters more than the name it is told to.
  }
  writeStopNote(sys, root, { branch, head, reason: reason.trim(), at: sys.now().toISOString() });
  return { ok: true, message: `Stop note written for ${branch} at ${head.slice(0, 9)}; a new commit voids it. Tell ${owner} what happened, why, and the options; then stop.` };
}

/**
 * `niyam keep-going`, Claude Code's Stop hook (its input on stdin, exit 0
 * always), or `niyam keep-going --stop <why>` (exit 1 when no note was written).
 */
export async function keepGoing(sys: Sys, io: Output, args: readonly string[]): Promise<number> {
  if (args[0] === '--stop') {
    const { ok, message } = recordStop(sys, args.slice(1).join(' '));
    io.out(message);
    return ok ? 0 : 1;
  }
  let input = '';
  try {
    input = sys.readStdin();
  } catch {
    return 0;
  }
  const said = await stopHook(sys, input);
  if (said) io.out(said);
  return 0;
}
