import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';

import { githubSlug, isNoToken, SETTINGS_PATH } from './agent.ts';
import { agentEnv } from './as-agent.ts';
import { GITHUB_API, GITHUB_HOST } from './host.ts';
import { commands } from './shell.ts';
import type { HttpResult, Output, Sys } from './types.ts';
import { sessionToken } from './work.ts';

/**
 * Push, then pull request, for every push made in a client repository
 * (docs/decisions.md, W-56.4). git has no post-push hook, and pre-push runs
 * before the refs are sent, so the only proof a push landed is the remote
 * holding the commit. Three entry points share one decision:
 *
 *   claude-hook     Claude Code's PostToolUse(Bash) and Stop hook: a push the
 *                   session made, and the instruction to switch Autofix on.
 *   spawn-watchers  The pre-push hook, git's ref lines on stdin: one detached
 *                   `watch` per pushed branch, so a terminal push is covered.
 *   watch           Polls `git ls-remote` until the remote branch holds the
 *                   pushed commit, then makes sure the branch has its PR.
 *
 * A fourth, refuse-retired, opens nothing: the pre-push hook calls it before
 * its expensive checks, with the same ref lines, to refuse a push to a branch
 * whose pull request already merged. It asks GitHub what ensurePr asks and
 * judges by the same rule (retiredBy).
 *
 * Records live in `.tmp/pr-autocreate/` in the formats the Python original
 * wrote, which the desktop app's mods read. Pull requests are listed, opened
 * and read through GitHub's REST API, which a cloud session's proxy allows.
 * Nothing here fails a push or holds a session on its own error: claude-hook's
 * one non-zero exit is 2 at Stop, the Autofix instruction; spawn-watchers' is
 * 3, an opt-out it could not record; refuse-retired's is 3, a retired branch,
 * and 4 when it crashed, so a crash never reads as a branch found live.
 */

/** `.github/niyam.json`'s `"prAutocreate"`: what a client sets. */
export interface AutocreateSettings {
  /** The branch pull requests target. */
  base: string;
  /** Whether a pull request opens as a draft. */
  draft: boolean;
  /** Branches that never get one. */
  protected: string[];
  /** Branch prefixes that never get one, such as merge-queue branches. */
  skip: string[];
  /** Older names of the opt-out variable, read beside NIYAM_PR_AUTOCREATE. */
  optOut: string[];
  /** How the pushing session writes the real description, in the placeholder body and the instruction. */
  describe: string;
  /** A page saying why a merged pull request retires its branch, named in that note. */
  retired?: string;
  /** The command that retires a branch, `{number}` its merged pull request, named when a push to one is refused. */
  retire?: string;
  /** A last line for the placeholder body. */
  footer?: string;
}

const DEFAULTS: AutocreateSettings = {
  base: 'main',
  draft: false,
  protected: ['main', 'master', 'develop', 'prod', 'production'],
  skip: ['mergify/', 'gh-readonly-queue/'],
  optOut: [],
  describe: '`gh pr edit --body-file`',
};

const where = `${SETTINGS_PATH} "prAutocreate"`;
const BRANCH = /^(?!\/)(?!.*\/\/)(?!.*\.\.)[\w.\/+-]+$/;
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;

function strings(value: unknown, name: string, test: (item: string) => boolean): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string' && test(item))) throw new Error(`${where}.${name} must be a list of ${name === 'optOut' ? 'variable names' : 'branch names'}`);
  return value as string[];
}

function line(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim() || /[\r\n]/.test(value)) throw new Error(`${where}.${name} must be one line`);
  return value;
}

/** The settings, from the parsed settings file; throws naming the first bad key. */
export function autocreateSettings(raw: unknown): AutocreateSettings {
  const value = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>).prAutocreate : undefined;
  if (value === undefined) return { ...DEFAULTS };
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${where} must be an object`);
  const { base = DEFAULTS.base, draft = DEFAULTS.draft, protected: guarded = DEFAULTS.protected, skip = DEFAULTS.skip, optOut = DEFAULTS.optOut, describe, retired, retire, footer, ...rest } = value as Record<string, unknown>;
  const extra = Object.keys(rest)[0];
  if (extra !== undefined) throw new Error(`${where} has an unknown key "${extra}"; it takes "base", "draft", "protected", "skip", "optOut", "describe", "retired", "retire" and "footer"`);
  if (typeof base !== 'string' || !BRANCH.test(base)) throw new Error(`${where}.base must be a branch name`);
  if (typeof draft !== 'boolean') throw new Error(`${where}.draft must be true or false`);
  const settings: AutocreateSettings = {
    base,
    draft,
    protected: strings(guarded, 'protected', (item) => BRANCH.test(item)),
    skip: strings(skip, 'skip', (item) => item.length > 0 && BRANCH.test(item)),
    optOut: strings(optOut, 'optOut', (item) => ENV_NAME.test(item)),
    describe: line(describe, 'describe') ?? DEFAULTS.describe,
  };
  const page = line(retired, 'retired');
  if (page !== undefined && !/^https:\/\/\S+$/.test(page)) throw new Error(`${where}.retired must be an https link`);
  const way = line(retire, 'retire');
  if (way !== undefined && !way.includes('{number}')) throw new Error(`${where}.retire must name the merged pull request as {number}`);
  const last = line(footer, 'footer');
  return { ...settings, ...(page === undefined ? {} : { retired: page }), ...(way === undefined ? {} : { retire: way }), ...(last === undefined ? {} : { footer: last }) };
}

/** The settings in the repository at `root`; the defaults where it has no settings file. */
export function settingsAt(sys: Sys, root: string): AutocreateSettings {
  const path = `${root}/${SETTINGS_PATH}`;
  if (!sys.exists(path)) return { ...DEFAULTS };
  let raw: unknown;
  try {
    raw = JSON.parse(sys.read(path));
  } catch (error) {
    throw new Error(`${SETTINGS_PATH} cannot be read: ${error instanceof Error ? error.message : String(error)}`);
  }
  return autocreateSettings(raw);
}

/** The variable that turns automatic pull requests off for one push, whatever the client. */
export const OPT_OUT_VAR = 'NIYAM_PR_AUTOCREATE';
export const REMOTE = 'origin';
export const STATE_DIR = '.tmp/pr-autocreate';
export const MARKER = '<!-- pr-autocreate: placeholder body -->';
/** How many pushes a branch's opt-out record keeps. */
export const OPTOUT_KEPT = 50;
const OPTOUT_LINE = /^([0-9a-f]{40}|[0-9a-f]{64}) ([01])$/;
const ZERO_SHA = /^0+$/;
const LOCK_WAIT_MS = 90_000;
const LOCK_STALE_MS = 180_000;

/** Whether a push of `name` can get a pull request. */
export function eligible(settings: AutocreateSettings, name: string): boolean {
  return !!name && name !== settings.base && !settings.protected.includes(name) && !settings.skip.some((prefix) => name.startsWith(prefix));
}

/** Whether this push said no automatic pull request. */
export function optedOutNow(sys: Sys, settings: AutocreateSettings): boolean {
  return [OPT_OUT_VAR, ...settings.optOut].some((name) => sys.env[name] === '0');
}

export function stateDir(root: string): string {
  return `${root}/${STATE_DIR}`;
}

/** A branch's record: a readable prefix for people, a digest that keeps `a/b` and `a_b` apart. */
export function statePath(root: string, branch: string): string {
  const readable = branch.replace(/[^A-Za-z0-9._-]/g, '_');
  const digest = createHash('sha256').update(branch, 'utf8').digest('hex').slice(0, 12);
  return `${stateDir(root)}/${readable}-${digest}.json`;
}

export function optoutPath(root: string, branch: string): string {
  return statePath(root, branch).replace(/\.json$/, '.optout');
}

/** A pull request as a decision reads it. */
export interface Pull {
  number: number;
  url: string;
  state: 'OPEN' | 'MERGED' | 'CLOSED';
}

/** How many pull requests one listing of a branch asks for. */
export const PR_LIST_LIMIT = 20;

/**
 * The merged pull request that retired a branch, given its pull requests, or
 * undefined. A branch with an open one is live whatever merged before it; one
 * whose pull requests only closed unmerged was never retired. ensurePr opens
 * none for a retired branch, and refuse-retired refuses a push to one.
 */
export function retiredBy(pulls: readonly Pull[]): Pull | undefined {
  if (pulls.some((pull) => pull.state === 'OPEN')) return undefined;
  return pulls.find((pull) => pull.state === 'MERGED');
}

/** A branch's record. */
export interface State {
  remoteSha: string;
  branch: string;
  pr: Pull | null;
  created: boolean;
  notes: string[];
  /** Seconds since the epoch, when an opted-out push's "no PR" was decided. */
  optedOutAt?: number;
}

function loadState(sys: Sys, root: string, branch: string): Partial<State> {
  try {
    const value: unknown = JSON.parse(sys.read(statePath(root, branch)));
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Partial<State>) : {};
  } catch {
    return {};
  }
}

function saveState(sys: Sys, root: string, state: State): void {
  sys.mkdir(stateDir(root));
  sys.write(statePath(root, state.branch), JSON.stringify(state));
}

/**
 * The opt-out record's (sha, flag) pairs, oldest first: none without a
 * record, undefined when it cannot be read or is not what recordOptout
 * writes (at least one line, each ending in a newline).
 */
export function optoutLines(sys: Sys, root: string, branch: string): [string, string][] | undefined {
  const path = optoutPath(root, branch);
  if (!sys.exists(path)) return [];
  let text: string;
  try {
    text = sys.read(path);
  } catch {
    return undefined;
  }
  if (!text.endsWith('\n')) return undefined;
  const pairs: [string, string][] = [];
  for (const each of text.slice(0, -1).split('\n')) {
    const match = OPTOUT_LINE.exec(each);
    if (!match) return undefined;
    pairs.push([match[1] as string, match[2] as string]);
  }
  return pairs;
}

/**
 * Did the push that sent `sha` opt out? Its own line decides, not the
 * branch's last push: pre-push writes before git sends the refs, so a push
 * that then fails must not change what a landed commit means. A record that
 * cannot be read fails closed, and so does a full one without `sha`, whose
 * line the trim may have dropped.
 */
export function optedOut(sys: Sys, root: string, branch: string, sha: string): boolean {
  const pairs = optoutLines(sys, root, branch);
  if (pairs === undefined) return true;
  const flags = pairs.filter(([lineSha]) => lineSha === sha).map(([, flag]) => flag);
  if (flags.length === 0) return pairs.length >= OPTOUT_KEPT;
  return flags[flags.length - 1] === '1';
}

/**
 * How long an opted-out branch's "no PR" stands before GitHub is asked again,
 * so a turn end does not list pull requests every time.
 */
function recheckSeconds(sys: Sys): number {
  const seconds = Number(sys.env.NIYAM_PR_OPTOUT_RECHECK ?? '60');
  return Number.isFinite(seconds) && seconds >= 0 && sys.env.NIYAM_PR_OPTOUT_RECHECK?.trim() !== '' ? seconds : 60;
}

/**
 * One pull-request decision at a time per branch: the watcher and a session's
 * hook can reach the same push. A lock older than three minutes is abandoned.
 */
export async function withLock<T>(sys: Sys, root: string, branch: string, body: () => Promise<T> | T): Promise<T> {
  sys.mkdir(stateDir(root));
  const path = `${statePath(root, branch)}.lock`;
  const deadline = sys.now().getTime() + LOCK_WAIT_MS;
  while (!sys.claim(path)) {
    const changed = sys.modified(path);
    if (changed === undefined) continue;
    if (sys.now().getTime() - changed.getTime() > LOCK_STALE_MS) {
      sys.remove(path);
      continue;
    }
    if (sys.now().getTime() > deadline) throw new Error(`lock ${path} held too long`);
    await sys.sleep(500);
  }
  try {
    return await body();
  } finally {
    sys.remove(path);
  }
}

/**
 * Records whether the push sending `sha` opted out, one "<sha> 1|0" line per
 * push, the last OPTOUT_KEPT kept. The trim never drops the last line for
 * `remoteSha`, the commit the remote branch holds before this push: later
 * pushes, failed ones included, cannot evict the choice that landed. Under the
 * branch lock, and replaced whole. An unreadable record is started afresh.
 */
export async function recordOptout(sys: Sys, root: string, branch: string, sha: string, opted: boolean, remoteSha?: string): Promise<void> {
  await withLock(sys, root, branch, () => {
    const pairs: [string, string][] = [...(optoutLines(sys, root, branch) ?? []), [sha, opted ? '1' : '0']];
    let kept = pairs.slice(-OPTOUT_KEPT);
    const landed = pairs.filter(([lineSha]) => lineSha === remoteSha);
    const last = landed[landed.length - 1];
    if (last && !kept.includes(last)) kept = [last, ...pairs.slice(-(OPTOUT_KEPT - 1))];
    sys.replace(optoutPath(root, branch), kept.map(([lineSha, flag]) => `${lineSha} ${flag}\n`).join(''));
  });
}

function git(sys: Sys, root: string, args: readonly string[]): string | undefined {
  const result = sys.exec('git', args, { cwd: root, timeoutMs: 30_000 });
  return result.code === 0 ? result.stdout.trim() : undefined;
}

/** Whether the commit has nothing the base lacks; false when the base cannot be read. */
function nothingAhead(sys: Sys, root: string, base: string, sha: string): boolean {
  const ref = `refs/remotes/${REMOTE}/${base}`;
  return git(sys, root, ['rev-parse', '--verify', '--quiet', ref]) !== undefined && git(sys, root, ['rev-list', '--count', `${ref}..${sha}`]) === '0';
}

/** How pull requests are listed, opened and read: GitHub's REST API, with the token it is given. */
export class Pulls {
  private readonly sys: Sys;
  readonly slug: string;
  /** The token, or how to find it at the first request: a record that answers needs none. */
  private token: string | (() => string | { problem: string });
  /** In a Claude cloud session: no Autofix to switch on, so a Stop is never held. */
  readonly cloud: boolean;

  constructor(sys: Sys, slug: string, token: string | (() => string | { problem: string }), cloud: boolean) {
    this.sys = sys;
    this.slug = slug;
    this.token = token;
    this.cloud = cloud;
  }

  private async call(method: string, route: string, body?: unknown): Promise<HttpResult | string> {
    if (typeof this.token === 'function') {
      const found = this.token();
      if (typeof found !== 'string') return found.problem;
      this.token = found;
    }
    try {
      return await this.sys.http(`${GITHUB_API}/repos/${this.slug}/${route}`, { method, token: this.token, timeoutMs: method === 'POST' ? 60_000 : 30_000, ...(body === undefined ? {} : { body }) });
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  /** A REST pull as a decision reads it, or undefined when a field it decides by is missing. */
  static read(value: unknown): Pull | undefined {
    if (typeof value !== 'object' || value === null) return undefined;
    const pull = value as Record<string, unknown>;
    if (!Number.isInteger(pull.number) || typeof pull.html_url !== 'string' || !pull.html_url || (pull.state !== 'open' && pull.state !== 'closed')) return undefined;
    return { number: pull.number as number, url: pull.html_url, state: pull.merged_at ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED' };
  }

  /** The branch's pull requests, newest first; a string says why they could not be listed. */
  async list(branch: string): Promise<Pull[] | string> {
    const listed = await this.listing(branch);
    return typeof listed === 'string' ? listed : listed.pulls;
  }

  /**
   * The branch's pull requests, newest first, and whether GitHub's page was
   * full (`PR_LIST_LIMIT` entries before any was dropped), so it may hold
   * back more; a string says why they could not be listed.
   */
  async listing(branch: string): Promise<{ pulls: Pull[]; full: boolean } | string> {
    const owner = this.slug.split('/')[0] as string;
    const got = await this.call('GET', `pulls?head=${encodeURIComponent(`${owner}:${branch}`)}&state=all&per_page=${PR_LIST_LIMIT}`);
    if (typeof got === 'string') return got;
    if (got.status !== 200) return `GitHub answered ${got.status} listing pull requests`;
    // Any unreadable part makes the whole list unreadable: a pull request
    // missed here would be opened again, and a misread one kept as closed.
    if (!Array.isArray(got.json)) return 'GitHub listed pull requests unreadably';
    const pulls: Pull[] = [];
    for (const item of got.json as unknown[]) {
      const pull = Pulls.read(item);
      if (!pull) return 'GitHub listed pull requests unreadably';
      const head = (item as { head?: { ref?: unknown } }).head?.ref;
      if (head === branch) pulls.push(pull);
    }
    return { pulls, full: got.json.length >= PR_LIST_LIMIT };
  }

  /** Opens a pull request: it, or "none ahead" when the branch adds nothing, or why it could not. */
  async create(branch: string, base: string, title: string, body: string, draft: boolean): Promise<Pull | { noneAhead: true } | string> {
    const got = await this.call('POST', 'pulls', { head: branch, base, title, body, draft });
    if (typeof got === 'string') return got;
    const pull = got.status === 201 ? Pulls.read(got.json) : undefined;
    if (pull) return pull;
    const text = JSON.stringify(got.json ?? '');
    if (got.status === 422 && /no commits between/i.test(text)) return { noneAhead: true };
    return `GitHub answered ${got.status} opening a pull request`;
  }

  /** The pull request's body now; undefined when GitHub cannot say. */
  async body(number: number): Promise<string | undefined> {
    const got = await this.call('GET', `pulls/${number}`);
    if (typeof got === 'string' || got.status !== 200) return undefined;
    const body = (got.json as { body?: unknown } | null)?.body;
    return typeof body === 'string' ? body : body === null ? '' : undefined;
  }
}

/** The placeholder body: what the push sent, and how the session replaces it. */
export function placeholder(sys: Sys, root: string, settings: AutocreateSettings, branch: string, sha: string): { title: string; body: string } {
  const ref = `refs/remotes/${REMOTE}/${settings.base}`;
  const hasBase = git(sys, root, ['rev-parse', '--verify', '--quiet', ref]) !== undefined;
  const log = git(sys, root, ['log', '--no-merges', '--reverse', '--format=%h %s', hasBase ? `${ref}..${sha}` : sha]) ?? '';
  const commits = log.split('\n').filter((each) => each.includes(' ')).map((each) => {
    const at = each.indexOf(' ');
    return { short: each.slice(0, at), subject: each.slice(at + 1) };
  });
  const listed = commits.slice(0, 50).map(({ short, subject }) => `- ${subject} (\`${short}\`)`);
  if (commits.length > 50) listed.push(`- …and ${commits.length - 50} more`);
  const body = [
    MARKER,
    `Opened automatically when \`${branch}\` was pushed. The pushing session replaces this body with the full description (${settings.describe}).`,
    '',
    '## Commits',
    '',
    ...listed,
    ...(settings.footer ? ['', settings.footer] : []),
    '',
  ].join('\n');
  return { title: commits[0]?.subject ?? branch, body };
}

/**
 * The branch's decision for the pushed `sha`: its record, or why GitHub could
 * not be asked (to retry). GitHub is asked once per pushed commit; the record
 * keeps the answer, which is also how a session learns of a pull request a
 * terminal push opened. When the push that sent `sha` opted out, a branch
 * with no pull request gets none, and that answer stands for
 * NIYAM_PR_OPTOUT_RECHECK seconds only, so the session's own is found later.
 */
export async function ensurePr(sys: Sys, root: string, settings: AutocreateSettings, branch: string, sha: string, pulls: Pulls): Promise<State | { problem: string }> {
  return withLock(sys, root, branch, async () => {
    const known = loadState(sys, root, branch);
    if (known.remoteSha === sha) {
      const checked = known.optedOutAt;
      if (typeof checked !== 'number') return known as State;
      if (optedOut(sys, root, branch, sha) && sys.now().getTime() / 1000 - checked < recheckSeconds(sys)) return known as State;
    }
    const listed = await pulls.list(branch);
    if (typeof listed === 'string') return { problem: `could not list PRs for ${branch} (${listed}); will retry` };
    const open = listed.find((pull) => pull.state === 'OPEN');
    const merged = retiredBy(listed);
    let pr: Pull | null = null;
    let created = false;
    const notes: string[] = [];
    if (open) pr = open;
    else if (merged) {
      notes.push(`Branch ${branch} already has MERGED PR #${merged.number}, so no new PR was opened: a merged PR retires its branch${settings.retired ? ` (${settings.retired})` : ''}.`);
    } else if (listed[0]) {
      notes.push(`Branch ${branch}'s PR #${listed[0].number} was closed without merging, so no new PR was opened; reopening it is the user's call.`);
    } else if (optedOut(sys, root, branch, sha)) {
      const state: State = { remoteSha: sha, branch, pr: null, created: false, notes: [], optedOutAt: sys.now().getTime() / 1000 };
      saveState(sys, root, state);
      return state;
    } else if (nothingAhead(sys, root, settings.base, sha)) {
      notes.push(`Branch ${branch} has no commits ahead of ${settings.base}, so no PR was opened.`);
    } else {
      const { title, body } = placeholder(sys, root, settings, branch, sha);
      const made = await pulls.create(branch, settings.base, title, body, settings.draft);
      if (typeof made === 'object' && 'noneAhead' in made) {
        notes.push(`Branch ${branch} has no commits ahead of ${settings.base}, so no PR was opened.`);
      } else if (typeof made === 'string') {
        // A creator running at the same time makes this one fail on the pull request it opened.
        const again = await pulls.list(branch);
        const found = typeof again === 'string' ? undefined : again.find((pull) => pull.state === 'OPEN');
        if (!found) return { problem: `could not create a PR for ${branch} (${made}); will retry` };
        pr = found;
      } else {
        pr = made;
        created = true;
      }
    }
    const state: State = { remoteSha: sha, branch, pr, created, notes };
    saveState(sys, root, state);
    return state;
  });
}

// ---------------------------------------------------------------- claude-hook

/** Where a Bash command's first `git push` goes: the repository, and a branch when it names one. */
export interface PushTarget {
  dir: string;
  /** The destination branch; undefined for "the current branch's upstream". */
  branch?: string;
  /** False when only git itself can say what is pushed: the watcher reads its ref lines instead. */
  resolvable: boolean;
}

const VALUE_OPTS = new Set(['-o', '--push-option', '--receive-pack', '--exec']);
const UNRESOLVABLE_OPTS = new Set(['--all', '--mirror', '--tags', '--repo', '--prune', '--delete', '-d']);

/**
 * The first `git push` of a Bash command, read as a shell reads it. Anything
 * this cannot name exactly (several refspecs, another remote, --all,
 * --git-dir, a word only the shell can expand) is unresolvable.
 */
export function pushTarget(command: string, cwd: string, home: string): PushTarget | undefined {
  let simples;
  try {
    simples = commands(command, () => undefined);
  } catch {
    return { dir: cwd, resolvable: false };
  }
  for (const { words } of simples) {
    const start = words.findIndex((word) => word.text === 'git');
    if (start < 0) continue;
    let dir = cwd;
    let at = start + 1;
    let unresolvable = false;
    while (at < words.length && (words[at]?.text ?? '').startsWith('-')) {
      const option = (words[at] as { text: string }).text;
      const next = words[at + 1];
      if (option === '-C' && next) {
        if (!next.known) unresolvable = true;
        dir = resolve(dir, next.text.replace(/^~(?=$|\/)/, home));
        at += 2;
      } else if (option === '-c' && next) at += 2;
      else if (option.startsWith('--git-dir') || option.startsWith('--work-tree')) {
        unresolvable = true;
        at++;
      } else at++;
    }
    if (words[at]?.text !== 'push') continue;
    if (unresolvable) return { dir: cwd, resolvable: false };
    const positionals: string[] = [];
    for (let each = at + 1; each < words.length; each++) {
      const word = words[each] as { text: string; known: boolean };
      if (VALUE_OPTS.has(word.text)) {
        each++;
        continue;
      }
      if (UNRESOLVABLE_OPTS.has(word.text.split('=')[0] as string)) return { dir, resolvable: false };
      if (!word.text.startsWith('-')) {
        if (!word.known) return { dir, resolvable: false };
        positionals.push(word.text);
      }
    }
    if (positionals[0] !== undefined && positionals[0] !== REMOTE) return { dir, resolvable: false };
    const refspecs = positionals.slice(1);
    if (refspecs.length === 0) return { dir, resolvable: true };
    if (refspecs.length > 1) return { dir, resolvable: false };
    const spec = (refspecs[0] as string).replace(/^\+/, '');
    let destination = spec.includes(':') ? spec.slice(spec.indexOf(':') + 1) : spec;
    if (destination === '' || destination === 'HEAD') return { dir, resolvable: true };
    if (destination.startsWith('refs/heads/')) destination = destination.slice('refs/heads/'.length);
    else if (destination.startsWith('refs/')) return { dir, resolvable: false };
    return { dir, branch: destination, resolvable: true };
  }
  return undefined;
}

/** The instruction a session in the desktop app gets: switch Autofix on for the pull request. */
export function reminder(pr: Pull, opened: string, created: boolean, cloud: boolean): string {
  if (cloud) {
    return `PR #${pr.number} (${pr.url}) ${opened}\nThis cloud session has no Autofix: CI, conflicts and review comments reach no one until a session reads them (gh api; GraphQL is refused here).`;
  }
  // The tag claims the session opened the pull request, so one merely found
  // on the branch gets it only when the session knows it ran that create.
  const claim = created ? 'Write' : 'Only if this session itself ran the `gh pr create` that opened this PR (in a background command, say), write';
  return (
    `PR #${pr.number} (${pr.url}) ${opened}\n` +
    'Standing instruction from the user: Autofix must be ON for every PR a session pushes. Do this now, before anything else:\n' +
    '1. If mcp__ccd_pr__get_status is not yet a callable tool, it may only be deferred: run ToolSearch with query "select:mcp__ccd_pr__get_status,mcp__ccd_pr__bind_pr,mcp__ccd_pr__set_monitor" to load its schema before concluding it is unavailable.\n' +
    `2. ${claim} this line in your reply text, exactly: <pr-created>${pr.url}</pr-created>\n` +
    'The app lets a session turn Autofix on only for a PR it is sure the session opened, and it learns that only from a FOREGROUND `gh pr create` result or this tag; a PR opened by this hook or inside a background command has neither. Never write the tag for a PR this session did not open.\n' +
    `3. Call mcp__ccd_pr__get_status. If it reports no bound PR, call mcp__ccd_pr__bind_pr with url ${pr.url}.\n` +
    `4. If auto_fix is not true, call mcp__ccd_pr__set_monitor with {"auto_fix": true, "address_comments": true, "url": "${pr.url}"}. If it says the app is not sure this session opened the PR, or has not read it yet, call get_status once more and retry set_monitor once.\n` +
    "If ToolSearch cannot find mcp__ccd_pr__* at all (truly not the desktop app), or get_status/bind_pr/set_monitor still fails, tell the user in one line that Autofix could not be enabled and why, quoting the app's reason (the tag counts only within 15 minutes of the PR's creation, from the PR's own branch, and when the app's gh login authored it) — never fail silently and leave it off unreported."
  );
}

/** How the session replaces the placeholder body. */
function editHint(settings: AutocreateSettings, pulls: Pulls, number: number): string {
  return pulls.cloud ? `gh api -X PATCH repos/${pulls.slug}/pulls/${number} -F body=@FILE` : settings.describe;
}

/** The instruction for the record's open pull request, once per session and pull request; empty when there is nothing to say. */
async function autofixMessage(sys: Sys, root: string, settings: AutocreateSettings, state: State, session: unknown, pulls: Pulls): Promise<string | { problem: string }> {
  const pr = state.pr;
  if (!pr || pr.state !== 'OPEN' || !pr.url) return '';
  const who = String(session ?? 'nosession').replace(/[^A-Za-z0-9._-]/g, '_');
  const ack = `${stateDir(root)}/acks/${who}-${pr.number}`;
  if (sys.exists(ack)) return '';
  try {
    sys.mkdir(dirname(ack));
    sys.write(ack, '');
  } catch (error) {
    return { problem: `could not record the Autofix ack (${error instanceof Error ? error.message : String(error)}); not instructing, to avoid a loop` };
  }
  let opened = `is open for branch ${state.branch}.`;
  if (state.created) {
    opened = `was opened automatically for branch ${state.branch} after the push landed.`;
    const replace = `replace it with the real description (${editHint(settings, pulls, pr.number)}) before asking anyone to review it.`;
    const body = await pulls.body(pr.number);
    if (body === undefined) opened += ` If its body is still the automatic placeholder, ${replace}`;
    else if (body.includes(MARKER)) opened += ` Its body is still the automatic placeholder: ${replace}`;
  }
  return reminder(pr, opened, state.created, pulls.cloud);
}

/** The pull requests' transport for a repository, or why GitHub cannot be asked. */
export type PullsOf = (sys: Sys, root: string, session: string | undefined) => Pulls | { problem: string };

/**
 * The transport with the token GitHub is asked with: a session's hook acts
 * as the session's agent, with every check `as-agent` makes, and never as
 * anyone else; the watcher, which no session runs, as the push's own
 * GH_TOKEN, or gh's signed-in account.
 */
export function pullsFor(sys: Sys, root: string, session: string | undefined): Pulls | { problem: string } {
  const slug = githubSlug(git(sys, root, ['config', '--get', `remote.${REMOTE}.url`]) ?? '');
  if (!slug) return { problem: `${REMOTE} is not a ${GITHUB_HOST} repository` };
  const cloud = sys.env.CLAUDE_CODE_REMOTE === 'true';
  return new Pulls(sys, slug, () => tokenFor(sys, root, session), cloud);
}

function tokenFor(sys: Sys, root: string, session: string | undefined): string | { problem: string } {
  if (session !== undefined) {
    const env = agentEnv(sys, session, root);
    if ('problem' in env) return { problem: `niyam could not act as the agent (${env.problem}); run \`niyam doctor\`` };
    // agentEnv always sets it; a lock's placeholder is no token.
    const token = env.env.GH_TOKEN;
    return token && !isNoToken(token) ? token : { problem: 'niyam gave the agent no token; run `niyam doctor`' };
  }
  const token = sessionToken(sys);
  if (token) return token;
  const read = sys.exec('gh', ['auth', 'token', '-h', GITHUB_HOST], { cwd: root, timeoutMs: 30_000 });
  const found = read.code === 0 ? read.stdout.trim() : '';
  return found && !isNoToken(found) ? found : { problem: 'no GitHub token: GH_TOKEN is unset and gh is signed in to no account' };
}

/**
 * Claude Code's PostToolUse(Bash) and Stop hook, its input on stdin. A
 * foreground push that landed, or at Stop the branch's push, gets its pull
 * request; the session is told once to switch Autofix on. Exit 2 only at
 * Stop, for that instruction; everything else exits 0.
 */
export async function claudeHook(sys: Sys, io: Output, stdin: string, pullsOf: PullsOf = pullsFor): Promise<number> {
  const bail = (message: string): number => {
    io.err(`pr-autocreate: ${message}`);
    return 0;
  };
  let data: unknown;
  try {
    data = JSON.parse(stdin || 'null');
  } catch {
    return bail('hook input is not valid JSON; nothing done');
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return bail('hook input is not a JSON object; nothing done');
  const input = data as Record<string, unknown>;
  // The main session's Stop catches a subagent's push.
  if (input.agent_id) return 0;
  const event = input.hook_event_name;
  const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : (sys.env.CLAUDE_PROJECT_DIR ?? '');
  // A folder that is not there, or not in a repository, has nothing pushed: rev-parse below fails.
  if (!cwd) return 0;
  let dir = cwd;
  let named: string | undefined;
  if (event === 'PostToolUse') {
    if (input.tool_name !== 'Bash') return 0;
    const tool = typeof input.tool_input === 'object' && input.tool_input !== null ? (input.tool_input as Record<string, unknown>) : {};
    const command = typeof tool.command === 'string' ? tool.command : '';
    // A background push is still running; the Stop half catches it.
    if (tool.run_in_background) return 0;
    const target = pushTarget(command, cwd, sys.home);
    if (!target?.resolvable) return 0;
    dir = target.dir;
    named = target.branch;
  } else if (event === 'Stop') {
    if (input.stop_hook_active) return 0;
  } else return 0;

  const root = git(sys, dir, ['rev-parse', '--show-toplevel']);
  if (!root) return 0;
  let settings: AutocreateSettings;
  try {
    settings = settingsAt(sys, root);
  } catch (error) {
    return bail(`${error instanceof Error ? error.message : String(error)}; nothing done`);
  }
  let branch = named;
  if (branch === undefined) {
    const current = git(sys, root, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    if (!current) return 0;
    const upstream = git(sys, root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
    if (upstream && !upstream.startsWith(`${REMOTE}/`)) return 0;
    branch = upstream ? upstream.slice(REMOTE.length + 1) : current;
  }
  if (!eligible(settings, branch)) return 0;
  // The proof it landed: git moves the tracking ref only on a push that did.
  const remoteSha = git(sys, root, ['rev-parse', '--verify', '--quiet', `refs/remotes/${REMOTE}/${branch}`]);
  if (!remoteSha) return 0;
  if (sys.exec('git', ['merge-base', '--is-ancestor', remoteSha, 'HEAD'], { cwd: root }).code !== 0) return 0;
  if (nothingAhead(sys, root, settings.base, remoteSha)) return 0;

  const session = typeof input.session_id === 'string' && input.session_id ? input.session_id : undefined;
  const pulls = pullsOf(sys, root, session);
  if ('problem' in pulls) return bail(pulls.problem);
  let state: State | { problem: string };
  try {
    state = await ensurePr(sys, root, settings, branch, remoteSha, pulls);
  } catch (error) {
    return bail(`PR check failed for ${branch} (${error instanceof Error ? error.message : String(error)})`);
  }
  if ('problem' in state) return bail(state.problem);

  let message = await autofixMessage(sys, root, settings, state, session, pulls);
  if (typeof message !== 'string') return bail(message.problem);
  if (!message && state.notes.length > 0 && event === 'PostToolUse') {
    message = state.notes.join('\n');
    try {
      saveState(sys, root, { ...state, notes: [] });
    } catch {
      // The note is said again next time; nothing worse.
    }
  }
  if (!message) return 0;
  if (event === 'Stop' && pulls.cloud) {
    io.out(JSON.stringify({ systemMessage: message }));
    return 0;
  }
  if (event === 'Stop') {
    io.err(message);
    return 2;
  }
  io.out(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: message } }));
  return 0;
}

// ------------------------------------------------------ spawn-watchers / watch

/** `--name value` pairs; throws on anything else. */
function flags(args: readonly string[], names: readonly string[]): Map<string, string> {
  const found = new Map<string, string>();
  for (let at = 0; at < args.length; at++) {
    const arg = args[at] as string;
    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1;
    const name = eq > 0 ? arg.slice(0, eq) : arg;
    if (!names.includes(name)) throw new Error(`unexpected argument "${arg}"`);
    const value = eq > 0 ? arg.slice(eq + 1) : args[++at];
    if (value === undefined || (eq < 0 && value.startsWith('--'))) throw new Error(`${name} needs a value`);
    if (found.has(name)) throw new Error(`${name} is given twice`);
    found.set(name, value);
  }
  return found;
}

/**
 * The branches git's pre-push ref lines update on the remote, in order: each
 * refs/heads/* destination with a real local commit. A deletion (an all-zero
 * local sha), a tag and a line that is not a ref line name none. The branch
 * is the remote ref, the pull request's head: `git push origin HEAD:x` pushes x.
 */
export function pushedRefs(stdin: string): { localSha: string; branch: string; remoteSha: string }[] {
  const refs: { localSha: string; branch: string; remoteSha: string }[] = [];
  for (const each of stdin.split('\n')) {
    const parts = each.trim().split(/\s+/);
    if (parts.length !== 4) continue;
    const [, localSha, remoteRef, remoteSha] = parts as [string, string, string, string];
    if (ZERO_SHA.test(localSha) || !remoteRef.startsWith('refs/heads/')) continue;
    refs.push({ localSha, branch: remoteRef.slice('refs/heads/'.length), remoteSha });
  }
  return refs;
}

/** refuse-retired's exits: a push to a retired branch, and a check that crashed. */
export const RETIRED_REFUSAL = 3;
export const RETIRED_UNCHECKED = 4;

/**
 * The pre-push hook's check before its expensive ones, git's ref lines on
 * stdin. A push to a branch whose pull request already merged, with none
 * open, recreates a branch the merge retired, and its commits then sit in no
 * pull request: RETIRED_REFUSAL names each such branch and the way out. A
 * branch GitHub cannot answer for warns in one line and refuses nothing, as
 * every other path here fails open; so does a listing as long as one page,
 * which may hold back the open pull request that keeps the branch live.
 */
export async function refuseRetired(sys: Sys, io: Output, args: readonly string[], stdin: string, pullsOf: PullsOf = pullsFor): Promise<number> {
  const unchecked = (why: string): number => {
    io.out(`⚠️  Could not check whether a pushed branch's PR already merged (${why}); not checked.`);
    return RETIRED_UNCHECKED;
  };
  let root: string;
  let remote: string;
  try {
    const given = flags(args, ['--root', '--remote']);
    const named = given.get('--root');
    if (!named) throw new Error('refuse-retired needs --root <repository>');
    root = named;
    remote = given.get('--remote') ?? '';
  } catch (error) {
    return unchecked(error instanceof Error ? error.message : String(error));
  }
  // A workflow's push is not a session reviving a branch, and its token answers for no worktree.
  if (sys.env.CI || remote !== REMOTE) return 0;
  let settings: AutocreateSettings;
  try {
    settings = settingsAt(sys, root);
  } catch (error) {
    return unchecked(error instanceof Error ? error.message : String(error));
  }
  const branches = [...new Set(pushedRefs(stdin).map((ref) => ref.branch).filter((branch) => eligible(settings, branch)))];
  if (branches.length === 0) return 0;
  const pulls = pullsOf(sys, root, undefined);
  const retired: [string, number][] = [];
  const skip = (branch: string, why: string): void => io.out(`⚠️  Could not ask GitHub whether ${branch}'s PR already merged (${why}); not checked.`);
  for (const branch of branches) {
    const listed = 'problem' in pulls ? pulls.problem : await pulls.listing(branch);
    if (typeof listed === 'string') {
      skip(branch, listed);
      continue;
    }
    if (listed.full) {
      skip(branch, `GitHub listed ${PR_LIST_LIMIT} or more PRs, more than one page shows`);
      continue;
    }
    const pull = retiredBy(listed.pulls);
    if (pull) retired.push([branch, pull.number]);
  }
  for (const [branch, number] of retired) {
    io.out(`❌ Error: ${branch} already has MERGED PR #${number} and no open PR. Pushing it`);
    io.out('   recreates a branch the merge retired, and the commits after the merge land in no PR.');
    if (settings.retire) {
      io.out('   Retire it: move the commits missing from the PR head to a fresh branch, then push that:');
      io.out(`     ${settings.retire.replaceAll('{number}', String(number))}`);
    } else {
      io.out(`   Move the commits missing from the PR head to a fresh branch, then push that${settings.retired ? ` (${settings.retired})` : ''}.`);
    }
  }
  return retired.length > 0 ? RETIRED_REFUSAL : 0;
}

/**
 * The pre-push hook's half, git's ref lines on stdin: records each pushed
 * branch's opt-out before the refs are sent, then starts one detached watcher
 * per branch. Exit 3 only when an opt-out cannot be recorded, so the push is
 * refused rather than given a pull request at turn end; otherwise 0.
 */
export async function spawnWatchers(sys: Sys, io: Output, args: readonly string[], stdin: string): Promise<number> {
  let root: string;
  let remote: string;
  try {
    const given = flags(args, ['--root', '--remote']);
    const named = given.get('--root');
    if (!named) throw new Error('spawn-watchers needs --root <repository>');
    root = named;
    remote = given.get('--remote') ?? '';
  } catch (error) {
    io.err(`pr-autocreate: ${error instanceof Error ? error.message : String(error)}; no PR watcher started`);
    return 0;
  }
  if (sys.env.CI || remote !== REMOTE) return 0;
  let settings: AutocreateSettings;
  try {
    settings = settingsAt(sys, root);
  } catch (error) {
    io.err(`pr-autocreate: ${error instanceof Error ? error.message : String(error)}; no PR watcher started`);
    return 0;
  }
  const opted = optedOutNow(sys, settings);
  const names = [OPT_OUT_VAR, ...settings.optOut].join(' or ');
  const started: string[] = [];
  for (const { localSha, branch, remoteSha } of pushedRefs(stdin)) {
    if (!eligible(settings, branch)) continue;
    // Written before the refs are sent, so no turn-end hook sees the push land without it.
    try {
      await recordOptout(sys, root, branch, localSha, opted, remoteSha);
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      if (opted) {
        io.out(`❌ Could not record ${names}=0 for ${branch} (${why}), so a PR could open for it at turn end; push refused. Fix the cause, or push without the variable.`);
        return 3;
      }
      io.out(`⚠️  Could not record ${branch}'s push for the PR opt-out (${why}); if an earlier push of this commit said ${names}=0, no PR opens for it automatically: open one yourself.`);
    }
    if (opted) continue;
    try {
      sys.mkdir(stateDir(root));
      // Its own session and no inherited descriptors: git, the hook's
      // supervisor and a closing terminal neither wait on it nor end it.
      sys.detach(sys.runtime.node, [sys.runtime.cli, 'pr-autocreate', 'watch', '--root', root, '--branch', branch, '--sha', localSha], { cwd: root, log: `${stateDir(root)}/watch.log` });
      started.push(branch);
    } catch (error) {
      io.out(`⚠️  Could not start the PR watcher for ${branch} (${error instanceof Error ? error.message : String(error)}); open its PR yourself.`);
    }
  }
  if (started.length > 0) io.out(`→ PR watcher started for ${started.join(', ')}: a ${settings.draft ? 'draft' : 'ready'} PR opens once the push lands.`);
  return 0;
}

function seconds(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === '') return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error(`${name} must be a number of seconds`);
  return number;
}

/** The watcher's arguments, its timings from flags or NIYAM_PR_WATCH_* variables, in seconds. */
export function watchArgs(sys: Sys, args: readonly string[]): { root: string; branch: string; sha: string; timeout: number; interval: number; retryWindow: number; retryInterval: number } {
  const given = flags(args, ['--root', '--branch', '--sha', '--timeout', '--interval', '--retry-window', '--retry-interval']);
  const need = (name: string): string => {
    const value = given.get(name);
    if (!value) throw new Error(`watch needs ${name}`);
    return value;
  };
  return {
    root: need('--root'),
    branch: need('--branch'),
    sha: need('--sha'),
    timeout: seconds(given.get('--timeout') ?? sys.env.NIYAM_PR_WATCH_TIMEOUT, 900, '--timeout'),
    interval: seconds(given.get('--interval') ?? sys.env.NIYAM_PR_WATCH_INTERVAL, 5, '--interval'),
    retryWindow: seconds(given.get('--retry-window') ?? sys.env.NIYAM_PR_RETRY_WINDOW, 600, '--retry-window'),
    retryInterval: seconds(given.get('--retry-interval') ?? sys.env.NIYAM_PR_RETRY_INTERVAL, 30, '--retry-interval'),
  };
}

/**
 * Waits for the remote branch to hold the pushed commit, then makes sure the
 * branch has its pull request, retrying GitHub for a bounded window. Every
 * line goes to the watch log; a give-up says "<branch>: gave up", which a
 * client's push instructions may tell a session to look for.
 */
export async function watch(sys: Sys, io: Output, args: readonly string[], pullsOf: PullsOf = pullsFor): Promise<number> {
  const log = (message: string): void => io.out(`${sys.now().toISOString().slice(0, 19)} ${message}`);
  let parsed: ReturnType<typeof watchArgs>;
  try {
    parsed = watchArgs(sys, args);
  } catch (error) {
    log(`watch: ${error instanceof Error ? error.message : String(error)}; no PR opened`);
    return 0;
  }
  const { root, branch, sha } = parsed;
  const ref = `refs/heads/${branch}`;
  const deadline = sys.now().getTime() + parsed.timeout * 1000;
  for (;;) {
    const heads = sys.exec('git', ['ls-remote', REMOTE, ref], { cwd: root, timeoutMs: 30_000 });
    if (heads.code === 0 && heads.stdout.trim().split(/\s+/)[0] === sha) break;
    if (sys.now().getTime() >= deadline) {
      log(`${branch}: gave up: ${sha.slice(0, 8)} never reached ${ref} within ${parsed.timeout}s; no PR opened`);
      return 0;
    }
    await sys.sleep(parsed.interval * 1000);
  }
  let settings: AutocreateSettings;
  try {
    settings = settingsAt(sys, root);
  } catch (error) {
    log(`${branch}: gave up: ${error instanceof Error ? error.message : String(error)}; no PR opened`);
    return 0;
  }
  const retryDeadline = sys.now().getTime() + parsed.retryWindow * 1000;
  for (;;) {
    const pulls = pullsOf(sys, root, undefined);
    let state: State | { problem: string };
    try {
      state = 'problem' in pulls ? pulls : await ensurePr(sys, root, settings, branch, sha, pulls);
    } catch (error) {
      state = { problem: error instanceof Error ? error.message : String(error) };
    }
    if (!('problem' in state)) {
      const pr = state.pr;
      log(`${branch}: ${pr ? `PR #${pr.number} ${state.created ? 'created' : 'exists'} (${pr.url})` : state.notes.join(' ') || 'no PR'}`);
      return 0;
    }
    if (sys.now().getTime() >= retryDeadline) {
      log(`${branch}: gave up: ${state.problem}, after ${parsed.retryWindow}s of retries`);
      return 0;
    }
    log(`${branch}: ${state.problem}; retrying`);
    await sys.sleep(parsed.retryInterval * 1000);
  }
}

/** `niyam pr-autocreate <claude-hook | spawn-watchers | refuse-retired | watch> ...`: never a usage exit, which would hold a hook. */
export async function prAutocreate(sys: Sys, io: Output, args: readonly string[]): Promise<number> {
  const [mode, ...rest] = args;
  try {
    if (mode === 'claude-hook') return await claudeHook(sys, io, sys.readStdin());
    if (mode === 'spawn-watchers') return await spawnWatchers(sys, io, rest, sys.readStdin());
    if (mode === 'refuse-retired') return await refuseRetired(sys, io, rest, sys.readStdin());
    if (mode === 'watch') return await watch(sys, io, rest);
    io.err(`pr-autocreate: unknown mode "${mode ?? ''}"; it takes claude-hook, spawn-watchers, refuse-retired or watch; nothing done`);
    return 0;
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    // A crash is not "not retired": the hook reports RETIRED_UNCHECKED as not checked, never the 0 of a live branch.
    if (mode === 'refuse-retired') {
      io.out(`⚠️  Could not check whether a pushed branch's PR already merged (pr-autocreate crashed: ${why}); not checked.`);
      return RETIRED_UNCHECKED;
    }
    io.err(`pr-autocreate: unexpected error (${why}); nothing done`);
    return 0;
  }
}
