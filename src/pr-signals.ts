import { API, SETTINGS_PATH, isLogin, repoAt } from './agent.ts';
import { connection, restList, type Page } from './pages.ts';
import type { Output, Sys } from './types.ts';
import { sessionToken } from './work.ts';

/** Where a signal came from: a review thread, a failing check, or the client's local review findings file. */
export type Source = 'review-thread' | 'ci-failure' | 'local-findings';

/** One concern about the pull request, after duplicates are folded together. */
export interface Signal {
  id: string;
  source: Source;
  /** Every source that reported it. */
  sources: Source[];
  /** The id `niyam review-thread` takes: the thread's node id (PRRT_…), or in a cloud session its first comment's REST id. */
  thread?: string;
  /** The id `review-thread --comment-id` takes for the thread's first comment: its node id, or in a cloud session its REST id. */
  comment?: string;
  /**
   * Every review thread folded into this signal, `thread` and `comment` first: answer each, as an unresolved
   * duplicate still holds the merge.
   */
  threads?: ThreadRef[];
  author?: string;
  file: string | null;
  line: number | null;
  body: string;
  createdAt?: string;
  severity?: string;
  check?: string;
  failureType?: 'lint' | 'typecheck' | 'test' | 'build' | 'other';
  /** A failing check run that a newer passing run of the same name and app replaced: listed, but not what decides. */
  superseded?: true;
  /** Resolved threads that may be the same concern: a hint for the reader, never a verdict. */
  candidates?: Candidate[];
}

/** A review thread a signal answers: the ids `review-thread` takes. */
export interface ThreadRef {
  thread: string;
  comment?: string;
}

/** A resolved thread, kept so a new finding can be told apart from one already answered. */
export interface Resolved {
  file: string | null;
  line: number | null;
  preview: string;
  createdAt?: string;
  author?: string;
}

export interface Candidate extends Resolved {
  matchedBy: 'proximity' | 'body' | 'both';
  /** `git log -p` of the file since the resolved thread was opened, cut short: where to look, not proof. */
  diff?: string;
}

/** A signal before its id and sources are given. */
export type RawSignal = Omit<Signal, 'id' | 'sources'> & { sources?: Source[] };

/**
 * What `.github/niyam.json`'s `"signals"` names: review bots, the local review's findings file, and the fewest check
 * runs CI is green with where the base branch's rulesets require no check.
 */
export interface SignalSettings {
  /** Logins of review bots whose thread and local finding at one line are the same review, worded twice. */
  bots: string[];
  /** A findings file the client's local review writes, relative to the repository. */
  findings?: string;
  /** The fewest check runs that finished and were not skipped, where no ruleset names a required check. */
  minCheckRuns?: number;
}

/** Exit codes when the pull request is not open: nothing to answer. */
export const MERGED_EXIT = 3;
export const CLOSED_EXIT = 4;

/**
 * `--wait`'s exit for each verdict: 0 green, 5 failed, 6 conflicted, 7 unjudged or still short, 8 still pending.
 * None clashes with 1, 2, merged (3), closed (4) or LOCKED (77); `gh pr checks` uses 8 for pending checks too.
 */
export const WAIT_EXIT: Readonly<Record<Verdict, number>> = { green: 0, failed: 5, conflicted: 6, unjudged: 7, short: 7, pending: 8 };

/** How long `--wait` waits by default, in minutes, and how long between its polls. */
export const WAIT_MINUTES = 60;
export const POLL_MS = 30_000;

/** What `pr-signals` was asked: the pull request, whether to read the checks alone, and whether and how long to wait. */
export interface SignalArgs {
  pr: number;
  ciOnly: boolean;
  wait: boolean;
  /** Minutes `--wait` waits at most. */
  timeout: number;
}

/** `<pr> [--ci-only] [--wait [--timeout <minutes>]]`, refusing anything else. */
export function signalArgs(args: readonly string[]): SignalArgs {
  let pr: number | undefined;
  let ciOnly = false;
  let wait = false;
  let timeout: number | undefined;
  for (let at = 0; at < args.length; at++) {
    const arg = args[at] as string;
    if (arg === '--ci-only' && !ciOnly) ciOnly = true;
    else if (arg === '--wait' && !wait) wait = true;
    else if (arg === '--timeout' && timeout === undefined) {
      // A missing value reads as "undefined", which is no number.
      const text = String(args[++at]);
      const minutes = Number(text);
      if (!/^[1-9]\d*$/.test(text) || !Number.isSafeInteger(minutes)) throw new Error('--timeout takes whole minutes from 1, such as --timeout 9');
      timeout = minutes;
    } else if (pr === undefined && /^#?[1-9]\d*$/.test(arg)) pr = Number(arg.replace('#', ''));
    else throw new Error(`unexpected argument "${arg}"`);
  }
  if (pr === undefined) throw new Error('pr-signals needs a pull request number');
  if (timeout !== undefined && !wait) throw new Error('--timeout goes with --wait');
  return { pr, ciOnly, wait, timeout: timeout ?? WAIT_MINUTES };
}

/** The `"signals"` settings; none named is no bots and no findings file. Throws on a malformed entry. */
export function signalSettings(raw: unknown): SignalSettings {
  const value = (raw as { signals?: unknown } | null | undefined)?.signals;
  if (value === undefined) return { bots: [] };
  const where = `${SETTINGS_PATH}: "signals"`;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${where} must be an object`);
  const { bots = [], findings, minCheckRuns, ...rest } = value as Record<string, unknown>;
  const extra = Object.keys(rest)[0];
  if (extra !== undefined) throw new Error(`${where} has an unknown key "${extra}"; it takes "bots", "findings" and "minCheckRuns"`);
  if (!Array.isArray(bots) || !bots.every((bot) => typeof bot === 'string' && isLogin(bot.replace(/\[bot\]$/, '')))) {
    throw new Error(`${where}.bots must be a list of GitHub logins`);
  }
  if (findings !== undefined && (typeof findings !== 'string' || !findings || findings.startsWith('/') || findings.split('/').includes('..'))) {
    throw new Error(`${where}.findings must be a path inside the repository, such as ".tmp/review/findings.json"`);
  }
  // Number.isSafeInteger is false for anything but a number.
  if (minCheckRuns !== undefined && !(Number.isSafeInteger(minCheckRuns) && (minCheckRuns as number) > 0)) throw new Error(`${where}.minCheckRuns must be a whole number from 1`);
  return { bots: bots as string[], ...(findings === undefined ? {} : { findings }), ...(minCheckRuns === undefined ? {} : { minCheckRuns: minCheckRuns as number }) };
}

/**
 * A finding's body for comparing: lower case, one space between words, without the markers that differ between
 * where it was reported ("[bot]", "P1:", "severity: high", markdown).
 */
export function normalizeBody(body: string): string {
  return body
    .toLowerCase()
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\bp[0-9]\b\s*:?/g, ' ')
    .replace(/\bseverity\b\s*:?\s*\w+/g, ' ')
    .replace(/[`*_~>#]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const bare = (login: string): string => login.toLowerCase().replace(/\[bot\]$/, '');

/**
 * Folds signals that are one concern into one, numbered SIG-001 on: those at one file and line with the same
 * body, and a bot's thread and the local finding at one concrete file and line, the same review worded twice. A
 * pull-request-level finding (no file or line) folds only on its body, so two different ones never merge. The
 * thread's copy wins, as it is the one review-thread answers; otherwise the first. Every thread folded in is kept
 * under `threads`, the winner's first, so answering each answers them all.
 */
export function dedupe(raw: readonly RawSignal[], bots: readonly string[]): Signal[] {
  const own = (s: RawSignal): ThreadRef[] => s.threads ?? (s.thread ? [{ thread: s.thread, ...(s.comment ? { comment: s.comment } : {}) }] : []);
  const bot = new Set(bots.map(bare));
  const fromBot = (s: RawSignal): boolean => s.source === 'local-findings' || (s.source === 'review-thread' && s.author !== undefined && bot.has(bare(s.author)));
  const same = (a: RawSignal, b: RawSignal): boolean =>
    a.file === b.file && a.line === b.line && (normalizeBody(a.body) === normalizeBody(b.body) || (a.file !== null && a.line !== null && fromBot(a) && fromBot(b)));
  const merged: RawSignal[] = [];
  for (const signal of raw) {
    const at = merged.findIndex((kept) => same(kept, signal));
    if (at < 0) {
      const threads = own(signal);
      merged.push({ ...signal, sources: [signal.source], ...(threads.length ? { threads } : {}) });
      continue;
    }
    const kept = merged[at] as RawSignal;
    const winner = signal.source === 'review-thread' && kept.source !== 'review-thread' ? signal : kept;
    const loser = winner === kept ? signal : kept;
    const threads = [...own(winner), ...own(loser)];
    // A failure is superseded only when every copy of it is: one live copy keeps it a failure.
    const { superseded: _, ...rest } = winner;
    merged[at] = {
      ...rest,
      ...threads[0],
      ...(winner.severity ?? loser.severity ? { severity: (winner.severity ?? loser.severity) as string } : {}),
      // Every signal in `merged` was given its sources when it went in.
      sources: [...new Set([...(kept.sources as Source[]), signal.source])],
      ...(threads.length ? { threads } : {}),
      ...(winner.superseded && loser.superseded ? { superseded: true as const } : {}),
    };
  }
  return merged.map((signal, i) => ({ ...signal, id: `SIG-${String(i + 1).padStart(3, '0')}`, sources: signal.sources as Source[] }));
}

const NEAR_LINES = 10;
const MIN_OVERLAP = 12;

/**
 * Adds to each signal the resolved threads that may be the same concern: within ten lines in the same file, or a
 * body one holds the other of (12 characters or more), and the file's history since, from `history`. A hint only.
 */
export function addCandidates(signals: Signal[], resolved: readonly Resolved[], history: (file: string, since: string) => string): Signal[] {
  const seen = new Map<string, string>();
  for (const signal of signals) {
    const body = normalizeBody(signal.body);
    const found: Candidate[] = [];
    for (const item of resolved) {
      const near = signal.file !== null && item.file === signal.file && signal.line !== null && item.line !== null && Math.abs(item.line - signal.line) <= NEAR_LINES;
      const preview = normalizeBody(item.preview);
      const alike = preview.length >= MIN_OVERLAP && (body.includes(preview) || preview.includes(body));
      if (!near && !alike) continue;
      const candidate: Candidate = { ...item, matchedBy: near && alike ? 'both' : near ? 'proximity' : 'body' };
      if (item.file && item.createdAt) {
        const key = `${item.file}@${item.createdAt}`;
        if (!seen.has(key)) seen.set(key, history(item.file, item.createdAt));
        const diff = seen.get(key);
        if (diff) candidate.diff = diff;
      }
      found.push(candidate);
    }
    if (found.length) signal.candidates = found;
  }
  return signals;
}

/** One finding in the local findings file. */
export interface Finding {
  title?: string;
  description?: string;
  file?: string;
  path?: string;
  line?: number;
  priority?: string;
  severity?: string;
}

/**
 * The local findings file's state: `ok`, a review that finished (no findings is a clean review); `failed`, one that
 * crashed or was killed, whose empty list proves nothing and whose findings may be an earlier push's; `absent`, no
 * file.
 */
export type FindingsRead = { status: 'ok' | 'absent'; findings: Finding[] } | { status: 'failed'; findings: Finding[]; reason: string };

/** Reads the findings file's text, or null when there is none. A file that says its review failed never reads as clean. */
export function readFindings(text: string | null): FindingsRead {
  if (text === null) return { status: 'absent', findings: [] };
  let parsed: { issues?: unknown; metadata?: { status?: unknown; failureReason?: unknown; exit?: unknown } };
  try {
    parsed = JSON.parse(text) as typeof parsed;
  } catch {
    return { status: 'failed', findings: [], reason: 'the findings file is not JSON' };
  }
  const findings = Array.isArray(parsed?.issues) ? (parsed.issues as Finding[]) : [];
  if (parsed?.metadata?.status === 'failed') {
    const { failureReason, exit } = parsed.metadata;
    return { status: 'failed', findings, reason: typeof failureReason === 'string' ? failureReason : `the review exited ${typeof exit === 'number' ? exit : 'non-zero'}` };
  }
  return { status: 'ok', findings };
}

/** The pull request as `pr-signals` reads it. */
interface Pull {
  state: 'OPEN' | 'MERGED' | 'CLOSED';
  mergedAt: string | null;
  head: string;
  /** The branch it merges into, whose rulesets name the required checks. */
  base: string;
  /** GitHub's `mergeable_state` (`clean`, `dirty`, `blocked`, …), or null when it gives none. */
  mergeable: string | null;
}

async function readPull(sys: Sys, token: string, slug: string, pr: number): Promise<Pull> {
  const { status, json } = await sys.http(`${API}/repos/${slug}/pulls/${pr}`, { token });
  const pull = json as { state?: unknown; merged_at?: unknown; head?: { sha?: unknown }; base?: { ref?: unknown }; mergeable_state?: unknown } | null;
  if (status !== 200 || typeof pull?.state !== 'string' || typeof pull.head?.sha !== 'string' || typeof pull.base?.ref !== 'string') {
    throw new Error(`cannot read pull request #${pr} in ${slug} (HTTP ${status})`);
  }
  const mergedAt = typeof pull.merged_at === 'string' ? pull.merged_at : null;
  const mergeable = typeof pull.mergeable_state === 'string' ? pull.mergeable_state : null;
  return { state: mergedAt ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED', mergedAt, head: pull.head.sha, base: pull.base.ref, mergeable };
}

/** Refuses a pull request that is not open: a stale findings file must not make signals for a merged one. */
function notOpen(io: Output, pr: number, pull: Pull, phase: 'start' | 'wait' | 'before-print'): number | undefined {
  if (pull.state === 'OPEN') return undefined;
  const why = pull.state === 'MERGED' ? `#${pr} merged at ${pull.mergedAt as string}` : `#${pr} is closed without merging`;
  const when = phase === 'before-print' ? ' (it changed while the signals were read)' : phase === 'wait' ? ' (it changed while CI was waited on)' : '';
  io.err(`✗ ${why}; nothing to answer${when}`);
  io.out(JSON.stringify({ ok: false, reason: 'pr-not-open', pr, state: pull.state, mergedAt: pull.mergedAt, phase }, null, 2));
  return pull.state === 'MERGED' ? MERGED_EXIT : CLOSED_EXIT;
}

async function graphql(sys: Sys, token: string, query: string, variables: Record<string, unknown>, what: string): Promise<unknown> {
  const { status, json } = await sys.http(`${API}/graphql`, { method: 'POST', token, body: { query, variables } });
  const reply = json as { data?: unknown; errors?: { message?: string }[] } | null;
  if (status !== 200 || !reply?.data || reply.errors?.length) {
    throw new Error(`GitHub refused to ${what} (HTTP ${status}${reply?.errors?.[0]?.message ? `: ${reply.errors[0].message}` : ''})`);
  }
  return reply.data;
}

export const THREADS_QUERY =
  'query($owner: String!, $name: String!, $pr: Int!, $after: String) { repository(owner: $owner, name: $name) { pullRequest(number: $pr) { reviewThreads(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { id isResolved comments(first: 1) { nodes { id author { login } body path line originalLine createdAt } } } } } } }';

/** A thread as both transports give it: its id, whether it is resolved, and its first comment. */
interface Thread {
  id: string;
  resolved: boolean;
  first?: { id: string; author?: string; body: string; path: string | null; line: number | null; createdAt?: string };
}

interface GraphThread {
  id: string;
  isResolved: boolean;
  comments?: { nodes?: { id: string; author?: { login?: string } | null; body?: string; path?: string | null; line?: number | null; originalLine?: number | null; createdAt?: string }[] };
}

/** The threads over GraphQL, every page read. */
async function graphThreads(sys: Sys, token: string, slug: string, pr: number): Promise<Thread[]> {
  const [owner, name] = slug.split('/') as [string, string];
  const nodes = await connection<GraphThread>(`the review threads of #${pr}`, async (after) => {
    const data = (await graphql(sys, token, THREADS_QUERY, { owner, name, pr, ...(after === null ? {} : { after }) }, `read the review threads of #${pr}`)) as {
      repository?: { pullRequest?: { reviewThreads?: Page<GraphThread> } | null } | null;
    };
    const threads = data.repository?.pullRequest?.reviewThreads;
    if (!threads) throw new Error(`GitHub shows no pull request #${pr} in ${slug}`);
    return threads;
  });
  return nodes.map((node) => {
    const first = node.comments?.nodes?.[0];
    return {
      id: node.id,
      resolved: node.isResolved,
      ...(first
        ? {
            first: {
              id: first.id,
              ...(first.author?.login ? { author: first.author.login } : {}),
              body: first.body ?? '',
              path: first.path ?? null,
              line: first.line ?? first.originalLine ?? null,
              ...(first.createdAt ? { createdAt: first.createdAt } : {}),
            },
          }
        : {}),
    };
  });
}

/** A review comment over REST. */
export interface RestComment {
  id: number;
  inReplyTo: number | null;
  author?: string;
  body: string;
  path: string | null;
  line: number | null;
  createdAt?: string;
}

// Number.isSafeInteger is false for anything but a number.
const isId = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;

/** Every review comment on the pull request, replies too, over REST. */
export async function restComments(sys: Sys, token: string, slug: string, pr: number): Promise<RestComment[]> {
  return (await restList(sys, token, `repos/${slug}/pulls/${pr}/comments`)).map((raw) => {
    const c = raw as { id?: unknown; in_reply_to_id?: unknown; user?: { login?: unknown } | null; body?: unknown; path?: unknown; line?: unknown; original_line?: unknown; created_at?: unknown };
    if (!isId(c?.id)) throw new Error(`a review comment on #${pr} has no id`);
    const line = typeof c.line === 'number' ? c.line : typeof c.original_line === 'number' ? c.original_line : null;
    return {
      id: c.id,
      inReplyTo: isId(c.in_reply_to_id) ? c.in_reply_to_id : null,
      ...(typeof c.user?.login === 'string' ? { author: c.user.login } : {}),
      body: typeof c.body === 'string' ? c.body : '',
      path: typeof c.path === 'string' ? c.path : null,
      line,
      ...(typeof c.created_at === 'string' ? { createdAt: c.created_at } : {}),
    };
  });
}

/**
 * The cloud proxy's thread list (`ccr/review_threads`): every thread, unpaged, each named by its comments' REST
 * ids, the first naming the thread. An entry it cannot read throws.
 */
export async function proxyThreads(sys: Sys, token: string, slug: string, pr: number): Promise<{ resolved: boolean; comments: number[] }[]> {
  const route = `repos/${slug}/pulls/${pr}/ccr/review_threads`;
  const { status, json } = await sys.http(`${API}/${route}`, { token });
  if (status !== 200 || !Array.isArray(json)) throw new Error(`cannot read ${route} (HTTP ${status})`);
  return json.map((entry: { resolved?: unknown; comment_ids?: unknown } | null) => {
    const ids = entry?.comment_ids;
    if (typeof entry?.resolved !== 'boolean' || !Array.isArray(ids) || ids.length === 0 || !ids.every(isId)) throw new Error(`${route} lists a thread it does not name`);
    return { resolved: entry.resolved, comments: ids as number[] };
  });
}

/** The threads in a cloud session, where the proxy refuses GraphQL: a thread is its first comment's REST id. */
async function cloudThreads(sys: Sys, token: string, slug: string, pr: number): Promise<Thread[]> {
  const byId = new Map((await restComments(sys, token, slug, pr)).map((c) => [c.id, c]));
  return (await proxyThreads(sys, token, slug, pr)).map(({ resolved, comments }) => {
    const first = byId.get(comments[0] as number);
    return {
      id: String(comments[0]),
      resolved,
      ...(first
        ? {
            first: {
              id: String(first.id),
              ...(first.author ? { author: first.author } : {}),
              body: first.body,
              path: first.path,
              line: first.line,
              ...(first.createdAt ? { createdAt: first.createdAt } : {}),
            },
          }
        : {}),
    };
  });
}

/** Open threads as signals; resolved ones as what a new finding is compared with. A thread with no comment is skipped. */
export function threadSignals(threads: readonly Thread[]): { signals: RawSignal[]; resolved: Resolved[] } {
  const signals: RawSignal[] = [];
  const resolved: Resolved[] = [];
  for (const { id, resolved: done, first } of threads) {
    if (!first) continue;
    const shared = { file: first.path, line: first.line, ...(first.author ? { author: first.author } : {}), ...(first.createdAt ? { createdAt: first.createdAt } : {}) };
    if (done) resolved.push({ ...shared, preview: first.body.slice(0, 200) });
    else signals.push({ source: 'review-thread', thread: id, comment: first.id, body: first.body, ...shared });
  }
  return { signals, resolved };
}

/** Check-run conclusions and status states that are a failure. */
const FAILED = new Set(['failure', 'timed_out', 'cancelled', 'startup_failure', 'error']);
/** Log lines kept as a failure's excerpt: errors only. */
const ERROR_LINE = /error|fail|✖|✗|✘|cannot|missing|expected/i;
const EXCERPT_LINES = 40;

export function failureType(text: string): NonNullable<Signal['failureType']> {
  const t = text.toLowerCase();
  if (/tsc|type(check)?|ts\d{3,}/.test(t)) return 'typecheck';
  if (/eslint|lint/.test(t)) return 'lint';
  if (/test|vitest|jest|expect\(/.test(t)) return 'test';
  if (/build|compile|bundl/.test(t)) return 'build';
  return 'other';
}

/** The time GitHub Actions starts each log line with. */
const LOG_TIME = /^\d{4}-\d\d-\d\dT[\d:.]+Z /;

/** The error lines of a log, at most 40, without the time each starts with. */
export function excerpt(log: string): string {
  return log
    .split('\n')
    .map((line) => line.replace(LOG_TIME, ''))
    .filter((line) => ERROR_LINE.test(line))
    .slice(0, EXCERPT_LINES)
    .join('\n');
}

/** A check run on the head, as the verdict reads it. */
export interface CheckRun {
  id: number;
  name: string;
  /** The id of the app that ran it, which a ruleset's `integration_id` names; null when GitHub gives none. */
  app: number | null;
  /** Whether GitHub Actions ran it. */
  actions: boolean;
  /** `completed` once it finished; `queued`, `in_progress` and the like before. */
  status: string | null;
  /** Null until it finished. */
  conclusion: string | null;
  title?: string;
  summary?: string;
}

/** A commit status on the head: the newest of its context, as GitHub's combined status gives it. */
export interface CommitStatus {
  context: string;
  state: string;
  description?: string;
}

/** The head's check runs and statuses. */
export interface Checks {
  runs: CheckRun[];
  statuses: CommitStatus[];
}

const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const only = <K extends string>(key: K, value: string | undefined): Partial<Record<K, string>> => (value === undefined ? {} : ({ [key]: value } as Record<K, string>));

/** The head commit's check runs and statuses, every page read: a check left out reads as one that is not there. */
export async function readChecks(sys: Sys, token: string, slug: string, head: string): Promise<Checks> {
  const commit = `repos/${slug}/commits/${head}`;
  const runs = (await restList(sys, token, `${commit}/check-runs`, 'check_runs')).map((raw): CheckRun => {
    const run = raw as { id?: unknown; name?: unknown; status?: unknown; conclusion?: unknown; app?: { id?: unknown; slug?: unknown } | null; output?: { title?: unknown; summary?: unknown } | null };
    if (!isId(run?.id) || typeof run.name !== 'string') throw new Error(`${commit} lists a check run with no id or name`);
    return {
      id: run.id,
      name: run.name,
      app: isId(run.app?.id) ? run.app.id : null,
      actions: run.app?.slug === 'github-actions',
      status: text(run.status) ?? null,
      conclusion: text(run.conclusion) ?? null,
      ...only('title', text(run.output?.title)),
      ...only('summary', text(run.output?.summary)),
    };
  });
  const statuses = (await restList(sys, token, `${commit}/status`, 'statuses')).map((raw): CommitStatus => {
    const status = raw as { context?: unknown; state?: unknown; description?: unknown };
    if (typeof status?.context !== 'string' || typeof status.state !== 'string') throw new Error(`${commit} lists a status with no name or state`);
    return { context: status.context, state: status.state, ...only('description', text(status.description)) };
  });
  return { runs, statuses };
}

/** A check's key by its app and name: `<app id>/<name>`, or `/<name>` with no app. */
const keyOf = (app: number | null | undefined, name: string): string => `${app ?? ''}/${name}`;

/**
 * The newest run of each name and app, by its key: the one that decides, as GitHub takes it. Run ids grow with time.
 * A run listed twice, as a page can shift while it is read, keeps its first listing.
 */
export function newestRuns(runs: readonly CheckRun[]): Map<string, CheckRun> {
  const newest = new Map<string, CheckRun>();
  for (const run of runs) {
    const key = keyOf(run.app, run.name);
    if ((newest.get(key)?.id ?? 0) < run.id) newest.set(key, run);
  }
  return newest;
}

/** The conclusions a required check passes with: "Required status checks must have a successful, skipped, or neutral status". */
const PASSED = new Set(['success', 'neutral', 'skipped']);

/**
 * The head commit's failing check runs and statuses, each with the error lines of its log when GitHub Actions ran
 * it (a check run's id is its job's), else its name, conclusion and summary. A failing run that a newer passing run
 * of the same name and app replaced is marked `superseded`. With them, the checks read, how many check runs the head
 * has, and how many GitHub Actions ran.
 */
export async function ciSignals(sys: Sys, token: string, slug: string, head: string): Promise<{ signals: RawSignal[]; checks: Checks; checkRuns: number; actionsRuns: number }> {
  const checks = await readChecks(sys, token, slug, head);
  const newest = newestRuns(checks.runs);
  // Every failing run is kept, even when a run of that name passed: two workflows can name a job alike, and a
  // pass must never hide a failure. The same failure reported twice has the same lines, and dedupe folds it.
  const signals: RawSignal[] = [];
  for (const run of checks.runs) {
    // A conclusion of null, while the run goes on, is in no set of failures.
    if (!FAILED.has(run.conclusion as string)) continue;
    let body = [`${run.name}: ${run.conclusion}`, run.title, run.summary].filter(Boolean).join('\n');
    if (run.actions) {
      const log = await sys.http(`${API}/repos/${slug}/actions/jobs/${run.id}/logs`, { token, text: true });
      const lines = log.status === 200 && log.text ? excerpt(log.text) : '';
      if (lines) body = lines;
    }
    // This run failed, so a newest run of its key that passed is another one.
    const replaced = newest.get(keyOf(run.app, run.name)) as CheckRun;
    const superseded = replaced.status === 'completed' && PASSED.has(replaced.conclusion as string);
    signals.push({ source: 'ci-failure', check: run.name, file: null, line: null, body, failureType: failureType(body), ...(superseded ? { superseded: true as const } : {}) });
  }
  for (const status of checks.statuses) {
    if (!FAILED.has(status.state)) continue;
    const body = [`${status.context}: ${status.state}`, status.description].filter(Boolean).join('\n');
    signals.push({ source: 'ci-failure', check: status.context, file: null, line: null, body, failureType: failureType(body) });
  }
  return { signals, checks, checkRuns: checks.runs.length, actionsRuns: checks.runs.filter((run) => run.actions).length };
}

/** A check the base branch's rulesets require: its name, and the app that must run it when the rule names one. */
export interface RequiredCheck {
  context: string;
  app?: number;
}

/** The base branch's required checks, or why they cannot be read. */
export type Rules = { required: RequiredCheck[] } | { unread: string };

/**
 * The checks the rulesets on `base` require, from `GET /repos/{owner}/{repo}/rules/branches/{base}`, as Guard reads
 * them, every page read. A refusal or an answer it cannot read is `unread`, never no required checks.
 */
export async function readRules(sys: Sys, token: string, slug: string, base: string): Promise<Rules> {
  let rules: unknown[];
  try {
    rules = await restList(sys, token, `repos/${slug}/rules/branches/${base.split('/').map(encodeURIComponent).join('/')}`);
  } catch (error) {
    // fail-open: carrying on is safe, as unread rules make the verdict unjudged, never green.
    return { unread: (error as Error).message };
  }
  const required = new Map<string, RequiredCheck>();
  for (const rule of rules) {
    const { type, parameters } = (rule ?? {}) as { type?: unknown; parameters?: { required_status_checks?: unknown } | null };
    if (type !== 'required_status_checks') continue;
    const checks = parameters?.required_status_checks;
    if (!Array.isArray(checks)) return { unread: `a required_status_checks rule on ${base} names no checks` };
    for (const check of checks as ({ context?: unknown; integration_id?: unknown } | null)[]) {
      if (typeof check?.context !== 'string' || !check.context) return { unread: `a required_status_checks rule on ${base} names a check with no name` };
      const app = isId(check.integration_id) ? check.integration_id : undefined;
      required.set(keyOf(app, check.context), { context: check.context, ...(app === undefined ? {} : { app }) });
    }
  }
  return { required: [...required.values()] };
}

/** What `pr-signals` says of CI: green only when it has run, settled and passed. */
export type Verdict = 'green' | 'pending' | 'failed' | 'conflicted' | 'short' | 'unjudged';

/** A required check as the verdict found it: the conclusion of its newest run, `pending` before it finished, or `missing`. */
export interface RequiredResult {
  name: string;
  conclusion: string;
}

/** The verdict, and what it was judged by: the names behind it, for the line it prints. */
export interface Judged {
  verdict: Verdict;
  required: RequiredResult[];
  /** Where the minimum came from: the rulesets' required checks, `"signals": { "minCheckRuns" }`, or one GitHub Actions run. */
  minimum: 'ruleset' | 'settings' | 'default';
  /** Why the rules could not be read, when unjudged. */
  reason?: string;
  failing: string[];
  running: string[];
  missing: string[];
  /** The runs that count toward the minimum, and the minimum, where no ruleset names a required check. */
  counted: number;
  floor: number;
}

/** A deciding run's or status's state: passed, failed, still going, or not on the head. */
type State = 'pass' | 'fail' | 'running' | 'missing';

const runState = (run: CheckRun): State => (run.status !== 'completed' ? 'running' : PASSED.has(run.conclusion as string) ? 'pass' : 'fail');
const statusState = (status: CommitStatus): State => (status.state === 'pending' ? 'running' : status.state === 'success' ? 'pass' : 'fail');

/**
 * Judges CI on the head, in this order: `unjudged` when the rules cannot be read; `conflicted` on a `dirty` pull
 * request; `failed` when a deciding run finished and did not pass; `pending` while any run or status goes on, or
 * GitHub has not worked out the mergeable state; `short` when a required check is missing or fewer runs than the
 * minimum finished; else `green`. With required checks, those decide, each by its newest run, or its status when no
 * run has its name. Without, every name on the head decides, so one failed run is never read as green.
 */
export function judge(checks: Checks, rules: Rules, mergeable: string | null, minCheckRuns?: number): Judged {
  const named = 'required' in rules ? rules.required : [];
  const minimum = named.length ? 'ruleset' : minCheckRuns === undefined ? 'default' : 'settings';
  const newest = [...newestRuns(checks.runs).values()];
  const status = new Map(checks.statuses.map((one) => [one.context, one]));
  const required: RequiredResult[] = [];
  const deciding: { name: string; state: State }[] = named.length
    ? named.map(({ context, app }) => {
        const run = newest.filter((one) => one.name === context && (app === undefined || one.app === app)).sort((a, b) => b.id - a.id)[0];
        const commit = status.get(context);
        const state = run ? runState(run) : commit ? statusState(commit) : 'missing';
        required.push({ name: context, conclusion: state === 'running' ? 'pending' : run ? (run.conclusion as string) : commit ? commit.state : state });
        return { name: context, state };
      })
    : [...newest.map((run) => ({ name: run.name, state: runState(run) })), ...checks.statuses.map((one) => ({ name: one.context, state: statusState(one) }))];
  const withState = (state: State): string[] => deciding.filter((one) => one.state === state).map((one) => one.name);
  const failing = withState('fail');
  const missing = withState('missing');
  const running = [...new Set([...checks.runs.filter((run) => runState(run) === 'running').map((run) => run.name), ...checks.statuses.filter((one) => statusState(one) === 'running').map((one) => one.context)])];
  const floor = named.length ? 0 : (minCheckRuns ?? 1);
  const counted = checks.runs.filter((run) => run.status === 'completed' && run.conclusion !== 'skipped' && (minimum !== 'default' || run.actions)).length;
  const verdict: Verdict =
    'unread' in rules
      ? 'unjudged'
      : mergeable === 'dirty'
        ? 'conflicted'
        : failing.length
          ? 'failed'
          : running.length || mergeable === null || mergeable === 'unknown'
            ? 'pending'
            : // Every deciding check has finished and none failed: one that did not pass is missing.
              !deciding.every((one) => one.state === 'pass') || counted < floor
              ? 'short'
              : 'green';
  return { verdict, required, minimum, ...only('reason', 'unread' in rules ? rules.unread : undefined), failing, running, missing, counted, floor };
}

/** The line standard error gets for a verdict that is not green, naming what failed, is missing or still runs. */
export function verdictLine(pr: number, head: string, judged: Judged): string | undefined {
  const names = (list: readonly string[]): string => list.map((name) => `"${name}"`).join(', ');
  switch (judged.verdict) {
    case 'unjudged':
      return `⚠ CI on #${pr} is unjudged: the base branch's required checks cannot be read (${judged.reason as string}), so it is never read as green`;
    case 'conflicted':
      return `⚠ CI on #${pr} is conflicted: it has merge conflicts, so GitHub runs no pull_request workflows on it; merge the base and push before reading it as clear`;
    case 'failed':
      return `⚠ CI on #${pr} failed: ${names(judged.failing)} did not pass on its newest run`;
    case 'pending':
      return judged.running.length
        ? `⚠ CI on #${pr} is pending: ${names(judged.running)} still running on ${head}`
        : `⚠ CI on #${pr} is pending: GitHub has not worked out whether it merges yet`;
    case 'short':
      if (judged.missing.length) return `⚠ CI on #${pr} is short: the required ${names(judged.missing)} has no run on ${head}`;
      return judged.minimum === 'default'
        ? `⚠ CI on #${pr} is short: no GitHub Actions run that was not skipped is on ${head}, and the repository names no required checks`
        : `⚠ CI on #${pr} is short: ${judged.counted} of the ${judged.floor} check runs "minCheckRuns" asks for finished on ${head} without being skipped`;
  }
  // Green needs no line.
  return undefined;
}

/** Whether GitHub has worked out the pull request's `mergeable_state`: it says `unknown` while it computes it. */
const settled = (state: string | null): state is string => state !== null && state !== 'unknown';

/** The local findings as signals, without those citing a file the pull request does not change: another branch's. */
export function findingSignals(findings: readonly Finding[], changed: ReadonlySet<string>): { kept: RawSignal[]; dropped: number } {
  const kept: RawSignal[] = [];
  let dropped = 0;
  for (const finding of findings) {
    const file = (finding.file ?? finding.path ?? '').trim();
    if (file && !changed.has(file)) {
      dropped++;
      continue;
    }
    const severity = finding.priority ?? finding.severity;
    kept.push({
      source: 'local-findings',
      file: file || null,
      line: typeof finding.line === 'number' ? finding.line : null,
      body: [finding.title, finding.description].filter(Boolean).join(' — '),
      ...(severity ? { severity } : {}),
    });
  }
  return { kept, dropped };
}

/** A failed local review's finding, printed but never a signal: it may be the previous push's. */
export interface Unconfirmed {
  file: string | null;
  line: number | null;
  title: string;
}

/** A failed local review's findings, each by its file, line and title. */
export function unconfirmedFindings(findings: readonly Finding[]): Unconfirmed[] {
  return findings.map((finding) => ({
    file: (finding.file ?? finding.path ?? '').trim() || null,
    line: typeof finding.line === 'number' ? finding.line : null,
    title: [finding.title, finding.description].find(Boolean) ?? '',
  }));
}

const DIFF_CHARS = 4000;

/** The `ci` object `pr-signals` prints. */
function ciOf(mergeable: string | null, checks: Checks, judged: Judged): Record<string, unknown> {
  return {
    mergeable,
    checkRuns: checks.runs.length,
    actionsRuns: checks.runs.filter((run) => run.actions).length,
    verdict: judged.verdict,
    required: judged.required,
    minimum: judged.minimum,
    ...only('reason', judged.reason),
  };
}

/** One light poll of CI: what two polls must agree on, and whether this one has settled. */
export interface Poll {
  head: string;
  /** The check runs' ids, in order. */
  ids: string;
  /** Every run completed, no status pending, and a mergeable state GitHub has worked out. */
  settled: boolean;
  verdict: Verdict;
}

/** A poll of `checks` on `head`: settled once every run has completed, no status is pending and the state is known. */
export function pollOf(head: string, checks: Checks, mergeable: string | null, verdict: Verdict): Poll {
  return {
    head,
    ids: checks.runs
      .map((run) => run.id)
      .sort((a, b) => a - b)
      .join(','),
    settled: checks.runs.every((run) => run.status === 'completed') && !checks.statuses.some((one) => one.state === 'pending') && settled(mergeable),
    verdict,
  };
}

/** Verdicts that end the wait early: waiting changes no conflicted head or unread rules, and a failure can be fixed now. */
const EARLY = new Set<Verdict>(['failed', 'conflicted', 'unjudged']);

/**
 * Whether two polls in a row end the wait. Both must show the same head and the same verdict. `failed`, `conflicted`
 * and `unjudged` need no more, so other runs still going hold none of them. Green needs both settled on the same
 * check runs. `short` never ends it, since a required check that starts late looks missing at first.
 */
export function agreed(last: Poll | undefined, now: Poll): boolean {
  if (last?.head !== now.head || last.verdict !== now.verdict) return false;
  return EARLY.has(now.verdict) || (now.verdict !== 'short' && last.settled && now.settled && last.ids === now.ids);
}

/**
 * Polls CI every 30 s with light reads (the pull request, its head's check runs and statuses, the base's rules: no
 * logs, threads or findings) until two polls in a row agree, then returns the pull request as the last poll read it,
 * for the full read. Returns the exit
 * instead when the pull request merged or closed meanwhile (3 or 4), or when `minutes` ran out, after printing the
 * last poll: 7 still short or unjudged, else 8.
 */
async function waitForCi(sys: Sys, io: Output, token: string, slug: string, pr: number, first: Pull, minutes: number, minCheckRuns: number | undefined): Promise<{ exit: number } | { pull: Pull }> {
  const deadline = sys.now().getTime() + minutes * 60_000;
  let pull = first;
  let last: Poll | undefined;
  for (;;) {
    if (last && last.head !== pull.head) io.err(`⚠ #${pr}'s head moved from ${last.head} to ${pull.head}, so the wait counts its polls again`);
    const checks = await readChecks(sys, token, slug, pull.head);
    const judged = judge(checks, await readRules(sys, token, slug, pull.base), pull.mergeable, minCheckRuns);
    const now = pollOf(pull.head, checks, pull.mergeable, judged.verdict);
    if (agreed(last, now)) return { pull };
    last = now;
    if (sys.now().getTime() >= deadline) {
      const exit = judged.verdict === 'short' || judged.verdict === 'unjudged' ? WAIT_EXIT.short : WAIT_EXIT.pending;
      io.err(`⚠ CI on #${pr} did not settle within ${minutes} minute(s); the last poll read it as ${judged.verdict}`);
      const line = verdictLine(pr, pull.head, judged);
      if (line) io.err(line);
      io.out(JSON.stringify({ ok: false, reason: 'ci-not-settled', pr, head: pull.head, minutes, ci: ciOf(pull.mergeable, checks, judged) }, null, 2));
      return { exit };
    }
    await sys.sleep(POLL_MS);
    pull = await readPull(sys, token, slug, pr);
    const refused = notOpen(io, pr, pull, 'wait');
    if (refused !== undefined) return { exit: refused };
  }
}

/**
 * Prints, as one JSON object, a pull request's open review threads, its failing checks (error lines only) and the
 * local review's findings, duplicates folded, each thread with the ids `review-thread` takes; resolved threads come
 * with it, to tell a new finding from one answered. Refuses a pull request that is not open, before reading anything
 * and again before printing. Says under `ci` whether CI is green, and on standard error why when it is not, exiting
 * 0 whatever the verdict. With `--wait`, it first polls until CI settles, and exits with the verdict. In a Claude
 * cloud session
 * the threads come over the proxy's REST routes.
 */
export async function prSignals(sys: Sys, io: Output, args: readonly string[]): Promise<number> {
  const { pr, ciOnly, wait, timeout } = signalArgs(args);
  const { root, slug } = repoAt(sys);
  const settingsPath = `${root}/${SETTINGS_PATH}`;
  const settings = signalSettings(sys.exists(settingsPath) ? (JSON.parse(sys.read(settingsPath)) as unknown) : {});
  const token = sessionToken(sys);
  if (!token) {
    io.err('✗ this session has no token; run niyam doctor');
    return 1;
  }
  const cloud = sys.env.CLAUDE_CODE_REMOTE === 'true';
  let pull = await readPull(sys, token, slug, pr);
  const refused = notOpen(io, pr, pull, 'start');
  if (refused !== undefined) return refused;
  if (wait) {
    const waited = await waitForCi(sys, io, token, slug, pr, pull, timeout, settings.minCheckRuns);
    if ('exit' in waited) return waited.exit;
    pull = waited.pull;
  }

  const threads = ciOnly ? { signals: [], resolved: [] } : threadSignals(await (cloud ? cloudThreads : graphThreads)(sys, token, slug, pr));
  const checks = await ciSignals(sys, token, slug, pull.head);
  const rules = await readRules(sys, token, slug, pull.base);
  let findings: { status: FindingsRead['status']; reason?: string; droppedOffDiff?: number; unconfirmed?: Unconfirmed[] } | undefined;
  let local: RawSignal[] = [];
  if (!ciOnly && settings.findings) {
    const path = `${root}/${settings.findings}`;
    const read = readFindings(sys.exists(path) ? sys.read(path) : null);
    if (read.status === 'failed') {
      // A failed run's file can hold the previous push's findings, which a later commit may have fixed: none is a signal.
      const unconfirmed = unconfirmedFindings(read.findings);
      findings = { status: read.status, reason: read.reason, ...(unconfirmed.length ? { unconfirmed } : {}) };
      io.err(
        unconfirmed.length
          ? `⚠ the local review failed (${read.reason}): its ${unconfirmed.length} finding(s) are left out of signals, under findings.unconfirmed; check whether each file and line changed since, and lean on the bots' threads`
          : `⚠ the local review failed (${read.reason}): its findings are missing, so lean on the bots' threads`,
      );
    } else {
      findings = { status: read.status };
      if (read.findings.length) {
        const changed = new Set((await restList(sys, token, `repos/${slug}/pulls/${pr}/files`)).map((file) => String((file as { filename?: unknown } | null)?.filename)));
        const { kept, dropped } = findingSignals(read.findings, changed);
        local = kept;
        if (dropped) findings.droppedOffDiff = dropped;
      }
    }
  }

  const raw = [...threads.signals, ...checks.signals, ...local];
  const signals = addCandidates(dedupe(raw, settings.bots), threads.resolved, (file, since) => {
    const log = sys.exec('git', ['log', '-p', `--after=${since}`, '--', file], { cwd: root });
    if (log.code !== 0) return '';
    return log.stdout.length > DIFF_CHARS ? `${log.stdout.slice(0, DIFF_CHARS)}\n…[cut]` : log.stdout;
  });

  // Reading takes a while, and a green pull request can merge meanwhile.
  const after = await readPull(sys, token, slug, pr);
  const late = notOpen(io, pr, after, 'before-print');
  if (late !== undefined) return late;
  // The later read is likelier to have the state worked out; while GitHub computes it, or once a push has moved the
  // head past the commit whose checks were read, the first read's stands.
  const later = after.head === pull.head && settled(after.mergeable);
  const mergeable = later ? after.mergeable : pull.mergeable;
  const judged = judge(checks.checks, rules, mergeable, settings.minCheckRuns);
  const ci = ciOf(mergeable, checks.checks, judged);
  const line = verdictLine(pr, pull.head, judged);
  if (line) io.err(line);
  io.out(
    JSON.stringify(
      { ok: true, pr, cloud, ci, signals, resolved: threads.resolved, duplicates: raw.length - signals.length, ...(findings ? { findings } : {}) },
      null,
      2,
    ),
  );
  // The plain read exits 0 whatever the verdict, so its callers keep working; the wait exits with it.
  return wait ? WAIT_EXIT[judged.verdict] : 0;
}
