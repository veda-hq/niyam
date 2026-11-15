import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';

import { NO_TOKEN, sessionRecord } from './agent.ts';
import { PROXY_TOKEN } from './cloud.ts';
import { FakeSys, HOME, ROOT, capture } from './fake.test.ts';
import { GITHUB_API } from './host.ts';
import {
  MARKER,
  OPTOUT_KEPT,
  PR_LIST_LIMIT,
  Pulls,
  RETIRED_REFUSAL,
  RETIRED_UNCHECKED,
  autocreateSettings,
  claudeHook,
  ensurePr,
  optedOut,
  optoutLines,
  optoutPath,
  prAutocreate,
  pullsFor,
  pushTarget,
  pushedRefs,
  recordOptout,
  refuseRetired,
  retiredBy,
  spawnWatchers,
  statePath,
  watch,
  watchArgs,
  withLock,
  type PullsOf,
} from './pr-autocreate.ts';
import { run } from './run.ts';
import { realSys } from './sys.ts';
import type { HttpResult, Sys } from './types.ts';

const SLUG = 'example-org/example-app';
const URL_OF = `https://github.com/${SLUG}.git`;
const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);

/** A GitHub that holds pull requests for one repository, as REST answers them. */
class FakeGitHub {
  pulls: { number: number; head: string; state: 'open' | 'closed'; merged_at: string | null; body: string | null }[] = [];
  calls: { method: string; route: string; body?: unknown }[] = [];
  /** Answers to give next, in order, before the real one. */
  queued: (HttpResult | Error)[] = [];
  /** What POST answers instead of opening one. */
  createAnswer: HttpResult | undefined;
  bodyStatus = 200;
  extra: unknown[] = [];

  http = async (url: string, options: { method?: string; body?: unknown } = {}): Promise<HttpResult> => {
    const method = options.method ?? 'GET';
    const route = url.slice(`${GITHUB_API}/repos/${SLUG}/`.length);
    this.calls.push({ method, route, ...(options.body === undefined ? {} : { body: options.body }) });
    const next = this.queued.shift();
    if (next instanceof Error) throw next;
    if (next) return next;
    const rest = (pull: FakeGitHub['pulls'][number]): unknown => ({ number: pull.number, html_url: `https://github.com/${SLUG}/pull/${pull.number}`, state: pull.state, merged_at: pull.merged_at, head: { ref: pull.head }, body: pull.body });
    if (method === 'GET' && route.startsWith('pulls?')) {
      const head = decodeURIComponent(/head=([^&]+)/.exec(route)?.[1] ?? '').split(':')[1];
      return { status: 200, json: [...this.pulls.filter((pull) => pull.head === head).reverse().map(rest), ...this.extra] };
    }
    if (method === 'POST' && route === 'pulls') {
      if (this.createAnswer) return this.createAnswer;
      const body = options.body as { head: string; body: string };
      const pull = { number: 100 + this.pulls.length, head: body.head, state: 'open' as const, merged_at: null, body: body.body };
      this.pulls.push(pull);
      return { status: 201, json: rest(pull) };
    }
    const number = Number(/^pulls\/(\d+)$/.exec(route)?.[1]);
    const found = this.pulls.find((pull) => pull.number === number);
    if (method === 'GET' && found) return { status: this.bodyStatus, json: rest(found) };
    return { status: 404, json: { message: 'Not Found' } };
  };

  count(method: string, prefix: string): number {
    return this.calls.filter((call) => call.method === method && call.route.startsWith(prefix)).length;
  }
}

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** A clone with a bare origin standing in for GitHub, main pushed and `feature` pushed one commit ahead. */
function world(): { dir: string; work: string; bare: string; git: (...args: string[]) => string; commit: (name: string) => string } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'niyam-autocreate-')));
  dirs.push(dir);
  const bare = join(dir, 'origin.git');
  const work = join(dir, 'work');
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const git = (...args: string[]): string => execFileSync('git', args, { cwd: work, encoding: 'utf8', env }).trim();
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare], { env });
  mkdirSync(work);
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.invalid');
  git('config', 'user.name', 'T');
  git('config', 'commit.gpgsign', 'false');
  git('remote', 'add', 'origin', URL_OF);
  git('config', `url.${bare}.insteadOf`, URL_OF);
  let n = 0;
  const commit = (name: string): string => {
    writeFileSync(join(work, `f${n++}.txt`), `${name}\n`);
    git('add', '-A');
    git('commit', '-q', '-m', name);
    return git('rev-parse', 'HEAD');
  };
  commit('base');
  git('push', '-q', '-u', 'origin', 'main');
  git('checkout', '-q', '-b', 'feature');
  commit('✨ feat: the first change');
  git('push', '-q', '-u', 'origin', 'feature');
  return { dir, work, bare, git, commit };
}

/** The real machine, with GitHub, the clock and detached processes faked. */
function machine(github: FakeGitHub, home: string, env: Record<string, string> = {}): Sys & { clock: number; detached: unknown[][] } {
  const real = realSys();
  const sys = {
    ...real,
    env: { PATH: process.env.PATH ?? '', ...env },
    home,
    clock: Date.parse('2026-11-15T10:00:00Z'),
    detached: [] as unknown[][],
    http: github.http,
    now: () => new Date(sys.clock),
    sleep: async (ms: number) => {
      sys.clock += ms;
    },
    detach: (command: string, args: readonly string[], options: { cwd: string; log: string }) => {
      sys.detached.push([command, ...args, options.log]);
    },
  };
  return sys;
}

const viaToken = (cloud = false): PullsOf => (sys) => new Pulls(sys, SLUG, 'ghp_test', cloud);

function input(event: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ hook_event_name: event, session_id: 's1', ...extra });
}

function bash(cwd: string, command: string, extra: Record<string, unknown> = {}): string {
  return input('PostToolUse', { cwd, tool_name: 'Bash', tool_input: { command, ...extra } });
}

async function hook(sys: Sys, stdin: string, pullsOf: PullsOf = viaToken()): Promise<{ code: number; out: string[]; err: string[] }> {
  const seen = capture();
  const code = await claudeHook(sys, seen.io, stdin, pullsOf);
  return { code, out: seen.out, err: seen.err };
}

function context(out: string[]): string {
  return (JSON.parse(out[0] as string) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext;
}

function record(work: string, branch: string): Record<string, unknown> {
  return JSON.parse(readFileSync(statePath(work, branch), 'utf8')) as Record<string, unknown>;
}

describe('pr-autocreate claude-hook (real git, GitHub faked)', () => {
  let w: ReturnType<typeof world>;
  let github: FakeGitHub;
  let sys: ReturnType<typeof machine>;
  beforeEach(() => {
    w = world();
    github = new FakeGitHub();
    sys = machine(github, w.dir);
  });

  it('(1) leaves a Bash call that pushes nothing alone', async () => {
    assert.deepEqual(await hook(sys, bash(w.work, 'git status')), { code: 0, out: [], err: [] });
    assert.deepEqual(await hook(sys, input('PostToolUse', { cwd: w.work, tool_name: 'Read' })), { code: 0, out: [], err: [] });
    assert.deepEqual(await hook(sys, input('SessionStart', { cwd: w.work })), { code: 0, out: [], err: [] });
    assert.equal(github.calls.length, 0);
  });

  it('(2) does nothing at Stop on a branch never pushed', async () => {
    w.git('checkout', '-q', '-b', 'local-only');
    w.commit('local');
    assert.equal((await hook(sys, input('Stop', { cwd: w.work }))).code, 0);
    assert.equal(github.calls.length, 0);
  });

  it('(3) leaves a background push to the Stop half', async () => {
    assert.equal((await hook(sys, bash(w.work, 'git push', { run_in_background: true }))).code, 0);
    assert.equal(github.calls.length, 0);
  });

  it('(4) opens a ready pull request for a foreground push that landed, and tells the session to switch Autofix on', async () => {
    const got = await hook(sys, bash(w.work, 'git push origin feature'));
    assert.equal(got.code, 0);
    const [create] = github.calls.filter((call) => call.method === 'POST');
    const body = create?.body as { head: string; base: string; title: string; body: string; draft: boolean };
    assert.deepEqual([body.head, body.base, body.title, body.draft], ['feature', 'main', '✨ feat: the first change', false]);
    assert.ok(body.body.startsWith(`${MARKER}\nOpened automatically when \`feature\` was pushed.`));
    assert.match(body.body, /## Commits\n\n- ✨ feat: the first change \(`[0-9a-f]+`\)\n$/);
    const said = context(got.out);
    assert.match(said, /^PR #100 \(https:\/\/github\.com\/example-org\/example-app\/pull\/100\) was opened automatically for branch feature after the push landed\. Its body is still the automatic placeholder: replace it with the real description \(`gh pr edit --body-file`\)/);
    assert.match(said, /2\. Write this line in your reply text, exactly: <pr-created>https:\/\/github\.com\/example-org\/example-app\/pull\/100<\/pr-created>/);
    // The record the desktop app's mods read.
    const kept = record(w.work, 'feature');
    assert.deepEqual([kept.branch, kept.remoteSha, kept.created, kept.notes], ['feature', w.git('rev-parse', 'HEAD'), true, []]);
    assert.deepEqual(kept.pr, { number: 100, url: 'https://github.com/example-org/example-app/pull/100', state: 'OPEN' });
  });

  it('(5) asks GitHub once per pushed commit and tells a session once, looking up no token when the record answers', async () => {
    await hook(sys, bash(w.work, 'git push'));
    const asked = github.calls.length;
    let looked = 0;
    const counted: PullsOf = (each) => new Pulls(each, SLUG, () => {
      looked++;
      return { problem: 'niyam could not act as the agent (x); run `niyam doctor`' };
    }, false);
    assert.deepEqual(await hook(sys, bash(w.work, 'git push'), counted), { code: 0, out: [], err: [] });
    assert.deepEqual(await hook(sys, input('Stop', { cwd: w.work }), counted), { code: 0, out: [], err: [] });
    assert.equal(github.calls.length, asked);
    assert.equal(looked, 0);
  });

  it('(18) keeps branch names that differ only by / and _ apart', async () => {
    assert.notEqual(statePath(w.work, 'claude/a'), statePath(w.work, 'claude_a'));
    assert.match(statePath(w.work, 'claude/a'), /\/\.tmp\/pr-autocreate\/claude_a-[0-9a-f]{12}\.json$/);
    w.git('checkout', '-q', '-b', 'claude/a');
    w.git('push', '-q', '-u', 'origin', 'claude/a');
    w.git('checkout', '-q', '-b', 'claude_a');
    w.git('push', '-q', '-u', 'origin', 'claude_a');
    await hook(sys, input('Stop', { cwd: w.work }));
    w.git('checkout', '-q', 'claude/a');
    await hook(sys, input('Stop', { cwd: w.work }));
    assert.deepEqual([record(w.work, 'claude/a').branch, record(w.work, 'claude_a').branch], ['claude/a', 'claude_a']);
    assert.equal(github.count('POST', 'pulls'), 2);
  });

  it('(6) tells another session once, at Stop, by holding it (exit 2)', async () => {
    await hook(sys, bash(w.work, 'git push'));
    const got = await hook(sys, input('Stop', { cwd: w.work, session_id: 's2' }));
    assert.equal(got.code, 2);
    assert.match(got.err.join('\n'), /^PR #100 .*Its body is still the automatic placeholder/);
    assert.equal((await hook(sys, input('Stop', { cwd: w.work, session_id: 's2' }))).code, 0);
    assert.equal((await hook(sys, input('Stop', { cwd: w.work, stop_hook_active: true, session_id: 's3' }))).code, 0);
  });

  it("(6b) words the placeholder by the pull request's body now", async () => {
    await hook(sys, bash(w.work, 'git push'));
    (github.pulls[0] as { body: string | null }).body = 'The real description.';
    const replaced = await hook(sys, input('Stop', { cwd: w.work, session_id: 's2' }));
    assert.doesNotMatch(replaced.err.join('\n'), /placeholder/);
    github.bodyStatus = 500;
    const unknown = await hook(sys, input('Stop', { cwd: w.work, session_id: 's3' }));
    assert.match(unknown.err.join('\n'), /If its body is still the automatic placeholder, replace it/);
    (github.pulls[0] as { body: string | null }).body = null;
    github.bodyStatus = 200;
    const empty = await hook(sys, input('Stop', { cwd: w.work, session_id: 's4' }));
    assert.doesNotMatch(empty.err.join('\n'), /placeholder/);
  });

  it('(7) names an open pull request it did not open, and opens none', async () => {
    github.pulls.push({ number: 7, head: 'feature', state: 'open', merged_at: null, body: 'x' });
    const got = await hook(sys, input('Stop', { cwd: w.work }));
    assert.equal(got.code, 2);
    assert.match(got.err.join('\n'), /^PR #7 \(\S+\) is open for branch feature\.\n/);
    assert.match(got.err.join('\n'), /2\. Only if this session itself ran the `gh pr create`/);
    assert.equal(github.count('POST', 'pulls'), 0);
  });

  it('(8) opens none for a branch with a merged pull request, and says why once', async () => {
    sys = machine(github, w.dir);
    github.pulls.push({ number: 5, head: 'feature', state: 'closed', merged_at: '2026-11-01T00:00:00Z', body: '' });
    const settings = join(w.work, '.github');
    mkdirSync(settings);
    writeFileSync(join(settings, 'niyam.json'), JSON.stringify({ prAutocreate: { retired: 'https://example.invalid/retire' } }));
    const got = await hook(sys, bash(w.work, 'git push'));
    assert.equal(context(got.out), 'Branch feature already has MERGED PR #5, so no new PR was opened: a merged PR retires its branch (https://example.invalid/retire).');
    assert.equal(github.count('POST', 'pulls'), 0);
    assert.deepEqual(record(w.work, 'feature').notes, []);
    assert.deepEqual((await hook(sys, bash(w.work, 'git push'))).out, []);
    assert.deepEqual(await hook(sys, input('Stop', { cwd: w.work })), { code: 0, out: [], err: [] });
  });

  it('(9) opens none for a branch whose pull request was closed unmerged', async () => {
    github.pulls.push({ number: 6, head: 'feature', state: 'closed', merged_at: null, body: '' });
    const got = await hook(sys, bash(w.work, 'git push'));
    assert.equal(context(got.out), "Branch feature's PR #6 was closed without merging, so no new PR was opened; reopening it is the user's call.");
    assert.equal(github.count('POST', 'pulls'), 0);
  });

  it('(10) fails open when GitHub fails, keeps nothing, and tries again next time', async () => {
    github.queued.push({ status: 502, json: null });
    const got = await hook(sys, bash(w.work, 'git push'));
    assert.deepEqual(got, { code: 0, out: [], err: ['pr-autocreate: could not list PRs for feature (GitHub answered 502 listing pull requests); will retry'] });
    assert.deepEqual(readdirSync(join(w.work, '.tmp/pr-autocreate')).filter((name) => name.endsWith('.json')), []);
    github.queued.push(new Error('fetch failed'));
    assert.match((await hook(sys, bash(w.work, 'git push'))).err.join(''), /\(fetch failed\); will retry/);
    assert.equal((await hook(sys, input('Stop', { cwd: w.work }))).code, 2);
  });

  it('(11) leaves subagents, protected branches and malformed input alone', async () => {
    assert.equal((await hook(sys, input('Stop', { cwd: w.work, agent_id: 'sub' }))).code, 0);
    w.git('checkout', '-q', 'main');
    assert.equal((await hook(sys, bash(w.work, 'git push'))).code, 0);
    assert.equal((await hook(sys, bash(w.work, 'git push origin main'))).code, 0);
    assert.equal(github.calls.length, 0);
    assert.deepEqual(await hook(sys, '{not json'), { code: 0, out: [], err: ['pr-autocreate: hook input is not valid JSON; nothing done'] });
    assert.deepEqual(await hook(sys, '[1]'), { code: 0, out: [], err: ['pr-autocreate: hook input is not a JSON object; nothing done'] });
    assert.equal((await hook(sys, '')).code, 0);
    assert.equal((await hook(sys, input('Stop', { cwd: join(w.dir, 'nowhere') }))).code, 0);
    assert.equal((await hook(sys, input('Stop', { cwd: w.dir }))).code, 0);
    assert.equal((await hook({ ...sys, env: {} }, input('Stop', { cwd: '' }))).code, 0);
    assert.equal(github.calls.length, 0);
  });

  it('finds the repository from CLAUDE_PROJECT_DIR when the input names no folder', async () => {
    const got = await hook({ ...sys, env: { ...sys.env, CLAUDE_PROJECT_DIR: w.work } }, input('Stop'));
    assert.equal(got.code, 2);
  });

  it('leaves a merge-queue branch and one whose upstream is another remote alone', async () => {
    w.git('push', '-q', 'origin', 'feature:mergify/merge-queue/x');
    assert.equal((await hook(sys, bash(w.work, 'git push origin HEAD:mergify/merge-queue/x'))).code, 0);
    w.git('remote', 'add', 'fork', w.bare);
    w.git('push', '-q', '-u', 'fork', 'feature');
    assert.equal((await hook(sys, input('Stop', { cwd: w.work }))).code, 0);
    assert.equal(github.calls.length, 0);
  });

  it("does nothing when the remote's branch is not in HEAD, or adds nothing to main", async () => {
    w.git('checkout', '-q', '-b', 'elsewhere', 'main');
    w.git('branch', '-q', '--set-upstream-to', 'origin/feature');
    assert.equal((await hook(sys, input('Stop', { cwd: w.work }))).code, 0);
    w.git('push', '-q', '-u', 'origin', 'elsewhere');
    assert.equal((await hook(sys, input('Stop', { cwd: w.work }))).code, 0);
    assert.equal(github.calls.length, 0);
  });

  it('(15) honours an explicit destination refspec', async () => {
    w.git('push', '-q', 'origin', 'HEAD:other');
    await hook(sys, bash(w.work, 'git push origin HEAD:refs/heads/other'));
    assert.equal((github.calls.find((call) => call.method === 'POST')?.body as { head: string }).head, 'other');
  });

  it('(16) reads `git -C` as the repository, not the hook folder', async () => {
    const got = await hook(sys, bash(w.dir, 'git -C work push'));
    assert.equal(got.code, 0);
    assert.equal(github.count('POST', 'pulls'), 1);
  });

  it('(17) leaves a push it cannot name exactly to the watcher', async () => {
    github.pulls.push({ number: 9, head: 'feature', state: 'open', merged_at: null, body: '' });
    for (const command of ['git push --all', 'git push origin a b', 'git push fork feature', 'git push origin "$TARGET"', 'git --git-dir=.git push', 'git -C "$DIR" push', 'git push origin refs/tags/v1', "git push 'unclosed"]) {
      assert.deepEqual(await hook(sys, bash(w.work, command)), { code: 0, out: [], err: [] }, command);
    }
    assert.equal(github.calls.length, 0);
  });

  it('(20) in a cloud session names the pull request and never holds Stop', async () => {
    const cloud = machine(github, w.dir, { CLAUDE_CODE_REMOTE: 'true' });
    const got = await hook(cloud, input('Stop', { cwd: w.work }), viaToken(true));
    assert.equal(got.code, 0);
    const said = (JSON.parse(got.out[0] as string) as { systemMessage: string }).systemMessage;
    assert.match(said, /^PR #100 .*\(gh api -X PATCH repos\/example-org\/example-app\/pulls\/100 -F body=@FILE\)/);
    assert.match(said, /This cloud session has no Autofix/);
  });

  it('opens a draft when the settings say so, and names the footer', async () => {
    mkdirSync(join(w.work, '.github'));
    writeFileSync(join(w.work, '.github/niyam.json'), JSON.stringify({ prAutocreate: { draft: true, footer: '🤖 Generated', describe: '`/ship` step 9' } }));
    const got = await hook(sys, bash(w.work, 'git push'));
    const body = github.calls.find((call) => call.method === 'POST')?.body as { draft: boolean; body: string };
    assert.equal(body.draft, true);
    assert.match(body.body, /full description \(`\/ship` step 9\)\./);
    assert.match(body.body, /\n\n🤖 Generated\n$/);
    assert.match(context(got.out), /real description \(`\/ship` step 9\)/);
  });

  it('says nothing done when the settings cannot be read', async () => {
    mkdirSync(join(w.work, '.github'));
    writeFileSync(join(w.work, '.github/niyam.json'), '{');
    const got = await hook(sys, bash(w.work, 'git push'));
    assert.equal(got.code, 0);
    assert.match(got.err.join(''), /^pr-autocreate: \.github\/niyam\.json cannot be read: .*; nothing done$/);
    writeFileSync(join(w.work, '.github/niyam.json'), JSON.stringify({ prAutocreate: { draft: 'yes' } }));
    assert.match((await hook(sys, bash(w.work, 'git push'))).err.join(''), /prAutocreate"\.draft must be true or false; nothing done/);
  });

  it('says why when GitHub cannot be asked, and when the decision throws', async () => {
    const refused: PullsOf = (each) => new Pulls(each, SLUG, () => ({ problem: 'niyam could not act as the agent (x); run `niyam doctor`' }), false);
    assert.deepEqual(await hook(sys, bash(w.work, 'git push'), refused), { code: 0, out: [], err: ['pr-autocreate: could not list PRs for feature (niyam could not act as the agent (x); run `niyam doctor`); will retry'] });
    assert.deepEqual((await hook(sys, bash(w.work, 'git push'), () => ({ problem: 'origin is not a github.com repository' }))).err, ['pr-autocreate: origin is not a github.com repository']);
    const throwing: PullsOf = (each) => Object.assign(new Pulls(each, SLUG, 't', false), { list: () => Promise.reject(new Error('boom')) });
    assert.deepEqual((await hook(sys, bash(w.work, 'git push'), throwing)).err, ['pr-autocreate: PR check failed for feature (boom)']);
  });

  it('does not instruct when the ack cannot be written, so a session never loops', async () => {
    mkdirSync(join(w.work, '.tmp/pr-autocreate'), { recursive: true });
    writeFileSync(join(w.work, '.tmp/pr-autocreate/acks'), 'a file where the folder goes');
    const got = await hook(sys, input('Stop', { cwd: w.work }));
    assert.equal(got.code, 0);
    assert.match(got.err.join(''), /^pr-autocreate: could not record the Autofix ack \(.*\); not instructing, to avoid a loop$/);
  });
});

describe('pr-autocreate spawn-watchers and watch (real git, GitHub faked)', () => {
  let w: ReturnType<typeof world>;
  let github: FakeGitHub;
  let sys: ReturnType<typeof machine>;
  beforeEach(() => {
    w = world();
    github = new FakeGitHub();
    sys = machine(github, w.dir);
  });

  const zero = '0'.repeat(40);
  async function spawn(lines: string, args = ['--root', w.work, '--remote', 'origin'], on: Sys = sys): Promise<{ code: number; out: string[]; err: string[] }> {
    const seen = capture();
    const code = await spawnWatchers(on, seen.io, args, lines);
    return { code, out: seen.out, err: seen.err };
  }

  it("(13) starts one detached watcher per pushed branch from git's ref lines", async () => {
    const got = await spawn([
      `refs/heads/feature ${SHA} refs/heads/feature ${OTHER}`,
      `refs/heads/x ${SHA} refs/heads/main ${OTHER}`,
      `(delete) ${zero} refs/heads/gone ${OTHER}`,
      `refs/tags/v1 ${SHA} refs/tags/v1 ${zero}`,
      'not a ref line',
      '',
    ].join('\n'));
    assert.deepEqual(got, { code: 0, out: ['→ PR watcher started for feature: a ready PR opens once the push lands.'], err: [] });
    assert.deepEqual(sys.detached, [[sys.runtime.node, sys.runtime.cli, 'pr-autocreate', 'watch', '--root', w.work, '--branch', 'feature', '--sha', SHA, join(w.work, '.tmp/pr-autocreate/watch.log')]]);
    assert.equal(readFileSync(optoutPath(w.work, 'feature'), 'utf8'), `${SHA} 0\n`);
  });

  it('starts none in CI, for another remote, or without --root', async () => {
    const line = `refs/heads/feature ${SHA} refs/heads/feature ${OTHER}`;
    assert.equal((await spawn(line, ['--root', w.work, '--remote', 'origin'], { ...sys, env: { CI: 'true' } })).code, 0);
    assert.equal((await spawn(line, ['--root', w.work, '--remote', 'fork'])).code, 0);
    assert.equal((await spawn(line, ['--root', w.work])).code, 0);
    assert.deepEqual(await spawn(line, ['--remote', 'origin']), { code: 0, out: [], err: ['pr-autocreate: spawn-watchers needs --root <repository>; no PR watcher started'] });
    assert.deepEqual((await spawn(line, ['--root'])).err, ['pr-autocreate: --root needs a value; no PR watcher started']);
    assert.deepEqual((await spawn(line, ['--nope', 'x'])).err, ['pr-autocreate: unexpected argument "--nope"; no PR watcher started']);
    assert.deepEqual((await spawn(line, ['--root=a', '--root=b'])).err, ['pr-autocreate: --root is given twice; no PR watcher started']);
    assert.deepEqual(sys.detached, []);
  });

  it('starts none when the settings cannot be read, and says a draft when they ask for one', async () => {
    mkdirSync(join(w.work, '.github'));
    writeFileSync(join(w.work, '.github/niyam.json'), JSON.stringify({ prAutocreate: [] }));
    const line = `refs/heads/feature ${SHA} refs/heads/feature ${OTHER}`;
    assert.match((await spawn(line)).err.join(''), /"prAutocreate" must be an object; no PR watcher started/);
    writeFileSync(join(w.work, '.github/niyam.json'), JSON.stringify({ prAutocreate: { draft: true } }));
    assert.deepEqual((await spawn(line)).out, ['→ PR watcher started for feature: a draft PR opens once the push lands.']);
  });

  it('says so when a watcher cannot start, and goes on', async () => {
    const failing = { ...sys, detach: () => { throw new Error('spawn EACCES'); } };
    assert.deepEqual(await spawn(`refs/heads/feature ${SHA} refs/heads/feature ${OTHER}`, undefined, failing), { code: 0, out: ['⚠️  Could not start the PR watcher for feature (spawn EACCES); open its PR yourself.'], err: [] });
  });

  async function watching(args: string[], pullsOf: PullsOf = viaToken()): Promise<string[]> {
    const seen = capture();
    assert.equal(await watch(sys, seen.io, args, pullsOf), 0);
    return seen.out;
  }

  it('(12) opens the pull request once the push lands', async () => {
    const sha = w.git('rev-parse', 'HEAD');
    const out = await watching(['--root', w.work, '--branch', 'feature', '--sha', sha]);
    assert.deepEqual(out, ['2026-11-15T10:00:00 feature: PR #100 created (https://github.com/example-org/example-app/pull/100)']);
    // A second watcher for the same commit reads the record and asks GitHub nothing.
    const asked = github.calls.length;
    assert.deepEqual(await watching(['--root', w.work, '--branch', 'feature', '--sha', sha]), out);
    assert.equal(github.calls.length, asked);
    github.pulls.push({ number: 4, head: 'other', state: 'open', merged_at: null, body: '' });
    w.git('push', '-q', 'origin', 'HEAD:other');
    assert.deepEqual(await watching(['--root', w.work, '--branch', 'other', '--sha', sha]), ['2026-11-15T10:00:00 other: PR #4 exists (https://github.com/example-org/example-app/pull/4)']);
  });

  it('gives up when the push never lands, in the line push instructions look for', async () => {
    const out = await watching(['--root', w.work, '--branch', 'feature', '--sha', OTHER, '--timeout', '10', '--interval', '5']);
    assert.deepEqual(out, [`2026-11-15T10:00:10 feature: gave up: ${OTHER.slice(0, 8)} never reached refs/heads/feature within 10s; no PR opened`]);
    assert.equal(github.calls.length, 0);
  });

  it('(19) retries a transient GitHub failure after the push landed, then gives up after its window', async () => {
    const sha = w.git('rev-parse', 'HEAD');
    github.queued.push({ status: 503, json: null });
    const out = await watching(['--root', w.work, '--branch', 'feature', '--sha', sha, '--retry-interval', '30']);
    assert.deepEqual(out, ['2026-11-15T10:00:00 feature: could not list PRs for feature (GitHub answered 503 listing pull requests); will retry; retrying', '2026-11-15T10:00:30 feature: PR #100 created (https://github.com/example-org/example-app/pull/100)']);
    const fresh = world();
    sys = machine(github, fresh.dir, { NIYAM_PR_RETRY_WINDOW: '60', NIYAM_PR_RETRY_INTERVAL: '30' });
    const failing: PullsOf = () => ({ problem: 'no GitHub token' });
    const gaveUp = await watching(['--root', fresh.work, '--branch', 'feature', '--sha', fresh.git('rev-parse', 'HEAD')], failing);
    assert.equal(gaveUp.at(-1), '2026-11-15T10:01:00 feature: gave up: no GitHub token, after 60s of retries');
    const throwing: PullsOf = (each) => Object.assign(new Pulls(each, SLUG, 't', false), { list: () => Promise.reject(new Error('boom')) });
    assert.match((await watching(['--root', fresh.work, '--branch', 'feature', '--sha', fresh.git('rev-parse', 'HEAD'), '--retry-window', '0'], throwing)).at(-1) ?? '', /feature: gave up: boom, after 0s/);
  });

  it('gives up on a branch with no commits ahead of the base', async () => {
    w.git('checkout', '-q', '-b', 'empty', 'main');
    w.git('push', '-q', 'origin', 'empty');
    const out = await watching(['--root', w.work, '--branch', 'empty', '--sha', w.git('rev-parse', 'HEAD')]);
    assert.deepEqual(out, ['2026-11-15T10:00:00 empty: Branch empty has no commits ahead of main, so no PR was opened.']);
    assert.equal(github.count('POST', 'pulls'), 0);
  });

  it('says what it could not read, and opens nothing', async () => {
    assert.deepEqual(await watching(['--root', w.work]), ['2026-11-15T10:00:00 watch: watch needs --branch; no PR opened']);
    assert.deepEqual(await watching(['--root', w.work, '--branch', 'b', '--sha', SHA, '--timeout', 'soon']), ['2026-11-15T10:00:00 watch: --timeout must be a number of seconds; no PR opened']);
    mkdirSync(join(w.work, '.github'));
    writeFileSync(join(w.work, '.github/niyam.json'), JSON.stringify({ prAutocreate: { nope: 1 } }));
    const out = await watching(['--root', w.work, '--branch', 'feature', '--sha', w.git('rev-parse', 'HEAD')]);
    assert.match(out[0] as string, /feature: gave up: .*unknown key "nope".*; no PR opened$/);
  });

  it('reads its timings from flags first, then NIYAM_PR_WATCH_* variables', () => {
    const on = new FakeSys();
    on.env = { NIYAM_PR_WATCH_TIMEOUT: '30', NIYAM_PR_WATCH_INTERVAL: ' ' };
    assert.deepEqual(watchArgs(on, ['--root', 'r', '--branch', 'b', '--sha', 's', '--interval=1']), { root: 'r', branch: 'b', sha: 's', timeout: 30, interval: 1, retryWindow: 600, retryInterval: 30 });
    assert.throws(() => watchArgs(on, ['--root', 'r', '--branch', 'b', '--sha', 's', '--retry-window', '-1']), /--retry-window must be a number of seconds/);
  });

  describe('(21) the opt-out', () => {
    const optedOutLine = (): string => `refs/heads/feature ${w.git('rev-parse', 'HEAD')} refs/heads/feature ${OTHER}`;

    it('records the choice before the refs are sent, and starts no watcher', async () => {
      const got = await spawn(optedOutLine(), undefined, { ...sys, env: { NIYAM_PR_AUTOCREATE: '0' } });
      assert.deepEqual(got, { code: 0, out: [], err: [] });
      assert.deepEqual(sys.detached, []);
      assert.equal(readFileSync(optoutPath(w.work, 'feature'), 'utf8'), `${w.git('rev-parse', 'HEAD')} 1\n`);
    });

    it("keeps an older client's name working beside NIYAM_PR_AUTOCREATE", async () => {
      mkdirSync(join(w.work, '.github'));
      writeFileSync(join(w.work, '.github/niyam.json'), JSON.stringify({ prAutocreate: { optOut: ['LEGACY_PR_AUTOCREATE'] } }));
      await spawn(optedOutLine(), undefined, { ...sys, env: { LEGACY_PR_AUTOCREATE: '0' } });
      assert.match(readFileSync(optoutPath(w.work, 'feature'), 'utf8'), / 1\n$/);
    });

    it('gives an opted-out push no pull request at Stop, and finds the one the session opens itself', async () => {
      await spawn(optedOutLine(), undefined, { ...sys, env: { NIYAM_PR_AUTOCREATE: '0' } });
      assert.deepEqual(await hook(sys, input('Stop', { cwd: w.work })), { code: 0, out: [], err: [] });
      assert.equal(github.count('POST', 'pulls'), 0);
      assert.equal(typeof record(w.work, 'feature').optedOutAt, 'number');
      // Within the recheck window GitHub is not asked again.
      const asked = github.calls.length;
      github.pulls.push({ number: 8, head: 'feature', state: 'open', merged_at: null, body: 'mine' });
      assert.equal((await hook(sys, input('Stop', { cwd: w.work }))).code, 0);
      assert.equal(github.calls.length, asked);
      sys.clock += 61_000;
      const found = await hook(sys, input('Stop', { cwd: w.work }));
      assert.equal(found.code, 2);
      assert.match(found.err.join(''), /^PR #8 \(\S+\) is open for branch feature\./);
    });

    it('takes the opt-out back when the same commit is pushed without it', async () => {
      await spawn(optedOutLine(), undefined, { ...sys, env: { NIYAM_PR_AUTOCREATE: '0' } });
      await hook(sys, input('Stop', { cwd: w.work }));
      await spawn(optedOutLine());
      assert.equal((await hook(sys, input('Stop', { cwd: w.work }))).code, 2);
      assert.equal(github.count('POST', 'pulls'), 1);
    });

    it('refuses the push (3) when an opt-out cannot be written, and only warns for a push without one', async () => {
      mkdirSync(optoutPath(w.work, 'feature'), { recursive: true });
      const refused = await spawn(optedOutLine(), undefined, { ...sys, env: { NIYAM_PR_AUTOCREATE: '0' } });
      assert.equal(refused.code, 3);
      assert.match(refused.out.join(''), /^❌ Could not record NIYAM_PR_AUTOCREATE=0 for feature \(.*\), so a PR could open for it at turn end; push refused\./);
      const warned = await spawn(optedOutLine());
      assert.equal(warned.code, 0);
      assert.match(warned.out[0] as string, /^⚠️ {2}Could not record feature's push for the PR opt-out/);
      assert.equal(sys.detached.length, 1);
    });
  });
});

describe('the opt-out record', () => {
  const root = ROOT;
  const path = optoutPath(root, 'feature');

  it('fails closed on a record recordOptout never writes, and on a full one without the commit', () => {
    const sys = new FakeSys();
    assert.equal(optedOut(sys, root, 'feature', SHA), false);
    for (const text of [`${SHA} 1`, `${SHA} 2\n`, 'junk\n', '\n']) {
      sys.files.set(path, text);
      assert.equal(optoutLines(sys, root, 'feature'), undefined, JSON.stringify(text));
      assert.equal(optedOut(sys, root, 'feature', SHA), true);
    }
    sys.files.set(path, `${OTHER} 0\n`.repeat(OPTOUT_KEPT));
    assert.equal(optedOut(sys, root, 'feature', SHA), true);
    sys.files.set(path, `${SHA} 1\n${OTHER} 0\n${SHA} 0\n`);
    assert.equal(optedOut(sys, root, 'feature', SHA), false);
    sys.read = () => {
      throw new Error('EACCES');
    };
    assert.equal(optoutLines(sys, root, 'feature'), undefined);
  });

  it('keeps the last OPTOUT_KEPT pushes, and never trims the line of the commit the remote holds', async () => {
    const sys = new FakeSys();
    const landed = 'c'.repeat(40);
    sys.files.set(path, `${landed} 1\n`);
    for (let n = 0; n < OPTOUT_KEPT + 5; n++) await recordOptout(sys, root, 'feature', n.toString(16).padStart(40, '0'), false, landed);
    const lines = (sys.files.get(path) as string).split('\n').filter(Boolean);
    assert.equal(lines.length, OPTOUT_KEPT);
    assert.equal(lines[0], `${landed} 1`);
    assert.equal(optedOut(sys, root, 'feature', landed), true);
    assert.ok(sys.replaced.includes(path));
    sys.files.set(path, 'unreadable');
    await recordOptout(sys, root, 'feature', SHA, true);
    assert.equal(sys.files.get(path), `${SHA} 1\n`);
  });

  it('waits for the branch lock a decision holds, abandons a stale one, and gives up after 90 seconds', async () => {
    const sys = new FakeSys();
    const lock = `${statePath(root, 'feature')}.lock`;
    sys.files.set(lock, '');
    let order: string[] = [];
    const held = withLock(sys, root, 'feature', () => order.push('ran'));
    sys.sleep = async (ms) => {
      sys.slept.push(ms);
      order.push('waited');
      sys.files.delete(lock);
    };
    await held;
    assert.deepEqual(order, ['waited', 'ran']);
    assert.equal(sys.files.has(lock), false);

    order = [];
    sys.files.set(lock, '');
    sys.mtimes.set(lock, new Date(sys.now().getTime() - 181_000));
    await withLock(sys, root, 'feature', () => order.push('ran'));
    assert.deepEqual(order, ['ran']);

    sys.files.set(lock, '');
    sys.mtimes.set(lock, sys.now());
    let clock = sys.now().getTime();
    sys.now = () => new Date(clock);
    sys.sleep = async (ms) => {
      clock += ms;
    };
    await assert.rejects(withLock(sys, root, 'feature', () => order.push('never')), /lock .* held too long/);
    assert.equal(sys.files.has(lock), true);
  });

  it('claims again when the lock goes between the claim and its age', async () => {
    const sys = new FakeSys();
    let first = true;
    sys.claim = () => {
      if (first) {
        first = false;
        return false;
      }
      return true;
    };
    sys.modified = () => undefined;
    assert.equal(await withLock(sys, root, 'feature', () => 'ran'), 'ran');
  });
});

describe('ensurePr', () => {
  function fake(): { sys: FakeSys; github: FakeGitHub; pulls: Pulls } {
    const sys = new FakeSys();
    const github = new FakeGitHub();
    sys.http = github.http as FakeSys['http'];
    sys.execOverride = (call) => (call.command === 'git' ? { code: 1, stdout: '', stderr: '' } : undefined);
    return { sys, github, pulls: new Pulls(sys, SLUG, 't', false) };
  }
  const settings = autocreateSettings({});

  it('takes the open pull request a racing creator opened when its own create fails', async () => {
    const { sys, github, pulls } = fake();
    github.createAnswer = { status: 422, json: { message: 'Validation Failed', errors: [{ message: 'A pull request already exists for example-org:feature.' }] } };
    const raced = Object.assign(pulls, {
      list: async (branch: string) => (github.count('POST', 'pulls') === 0 ? [] : [{ number: 3, url: 'u', state: 'OPEN' as const }].filter(() => branch === 'feature')),
    });
    const state = await ensurePr(sys, ROOT, settings, 'feature', SHA, raced);
    assert.deepEqual(state, { remoteSha: SHA, branch: 'feature', pr: { number: 3, url: 'u', state: 'OPEN' }, created: false, notes: [] });
  });

  it('retries a create that failed with no pull request to find, and keeps nothing', async () => {
    const { sys, github, pulls } = fake();
    github.createAnswer = { status: 500, json: null };
    assert.deepEqual(await ensurePr(sys, ROOT, settings, 'feature', SHA, pulls), { problem: 'could not create a PR for feature (GitHub answered 500 opening a pull request); will retry' });
    github.createAnswer = undefined;
    github.queued.push(new Error('socket hang up'));
    github.queued.push({ status: 200, json: [] });
    github.queued.push({ status: 500, json: null });
    assert.match(JSON.stringify(await ensurePr(sys, ROOT, settings, 'feature', SHA, pulls)), /could not list PRs for feature \(socket hang up\)/);
    assert.match(JSON.stringify(await ensurePr(sys, ROOT, settings, 'feature', SHA, pulls)), /could not create a PR for feature/);
    assert.equal(sys.exists(statePath(ROOT, 'feature')), false);
  });

  it('records no commits ahead when GitHub says so', async () => {
    const { sys, github, pulls } = fake();
    github.createAnswer = { status: 422, json: { message: 'Validation Failed', errors: [{ message: 'No commits between main and feature' }] } };
    const state = await ensurePr(sys, ROOT, settings, 'feature', SHA, pulls);
    assert.deepEqual('notes' in state && state.notes, ['Branch feature has no commits ahead of main, so no PR was opened.']);
  });

  it('reads the whole list as unreadable when one pull is, and drops pulls of another branch', async () => {
    const { sys, github, pulls } = fake();
    github.extra = [{ number: 'x' }];
    assert.deepEqual(await pulls.list('feature'), 'GitHub listed pull requests unreadably');
    github.extra = [{ number: 4, html_url: 'u', state: 'open', merged_at: null, head: { ref: 'not-feature' } }];
    assert.deepEqual(await pulls.list('feature'), []);
    github.queued.push({ status: 200, json: { message: 'not a list' } });
    assert.deepEqual(await pulls.list('feature'), 'GitHub listed pull requests unreadably');
    for (const value of [null, 'x', { number: 1, html_url: '', state: 'open' }, { number: 1, html_url: 'u', state: 'draft' }]) assert.equal(Pulls.read(value), undefined);
    github.queued.push({ status: 201, json: { number: 1 } });
    assert.equal(await pulls.create('feature', 'main', 't', 'b', false), 'GitHub answered 201 opening a pull request');
    github.queued.push(new Error('offline'));
    assert.equal(await pulls.create('feature', 'main', 't', 'b', false), 'offline');
    github.queued.push({ status: 200, json: { body: 7 } });
    assert.equal(await pulls.body(1), undefined);
    github.queued.push(new Error('offline'));
    assert.equal(await pulls.body(1), undefined);
  });

  it('names a non-Error failure as text', async () => {
    const { sys, pulls } = fake();
    sys.http = () => Promise.reject('plain');
    assert.equal(await pulls.list('feature'), 'plain');
  });

  it('keeps an opted-out branch\'s "no PR" for NIYAM_PR_OPTOUT_RECHECK seconds', async () => {
    const { sys, github, pulls } = fake();
    sys.files.set(optoutPath(ROOT, 'feature'), `${SHA} 1\n`);
    await ensurePr(sys, ROOT, settings, 'feature', SHA, pulls);
    const asked = github.calls.length;
    for (const value of ['5', 'soon', '-1', '']) {
      sys.env = { NIYAM_PR_OPTOUT_RECHECK: value };
      await ensurePr(sys, ROOT, settings, 'feature', SHA, pulls);
    }
    assert.equal(github.calls.length, asked);
    sys.env = { NIYAM_PR_OPTOUT_RECHECK: '0' };
    await ensurePr(sys, ROOT, settings, 'feature', SHA, pulls);
    assert.equal(github.calls.length, asked + 1);
    sys.files.set(statePath(ROOT, 'feature'), '[]');
    await ensurePr(sys, ROOT, settings, 'feature', SHA, pulls);
    assert.equal(github.calls.length, asked + 2);
  });
});

describe('pushTarget', () => {
  const cwd = '/w';
  it('reads where a push goes', () => {
    assert.deepEqual(pushTarget('git push', cwd, HOME), { dir: cwd, resolvable: true });
    assert.deepEqual(pushTarget('cd x && git push -u origin HEAD', cwd, HOME), { dir: cwd, resolvable: true });
    assert.deepEqual(pushTarget('git push origin +feature:', cwd, HOME), { dir: cwd, resolvable: true });
    assert.deepEqual(pushTarget('git -c a=b -C ~/r push --force-with-lease -o ci.skip origin feature', cwd, HOME), { dir: `${HOME}/r`, branch: 'feature', resolvable: true });
    assert.deepEqual(pushTarget('git push origin local:refs/heads/remote', cwd, HOME), { dir: cwd, branch: 'remote', resolvable: true });
    assert.deepEqual(pushTarget('git status; git push origin x | cat', cwd, HOME), { dir: cwd, branch: 'x', resolvable: true });
    assert.deepEqual(pushTarget('sudo git --no-pager push', cwd, HOME), { dir: cwd, resolvable: true });
  });

  it('names nothing for a command that pushes nothing, and only git can say for the rest', () => {
    assert.equal(pushTarget('git status && echo push', cwd, HOME), undefined);
    assert.equal(pushTarget('git -C', cwd, HOME), undefined);
    for (const command of ['git push --delete origin x', 'git push origin --tags', 'git push --mirror', 'git --work-tree=x push', 'git push upstream', 'git push origin $(branch)']) {
      assert.equal(pushTarget(command, cwd, HOME)?.resolvable, false, command);
    }
  });
});

describe('autocreateSettings', () => {
  it('takes the defaults, or what the client sets', () => {
    assert.deepEqual(autocreateSettings(null), autocreateSettings({}));
    assert.deepEqual(autocreateSettings({ prAutocreate: { base: 'trunk', protected: ['release'], skip: [], optOut: ['OLD_VAR'], retired: 'https://x.invalid/a', retire: 'tool retire --pr {number}', footer: 'f' } }), {
      base: 'trunk',
      draft: false,
      protected: ['release'],
      skip: [],
      optOut: ['OLD_VAR'],
      describe: '`gh pr edit --body-file`',
      retired: 'https://x.invalid/a',
      retire: 'tool retire --pr {number}',
      footer: 'f',
    });
  });

  it('names the first key it cannot take', () => {
    for (const [value, error] of [
      [{ base: '../x' }, /base must be a branch name/],
      [{ protected: 'main' }, /protected must be a list of branch names/],
      [{ skip: [''] }, /skip must be a list of branch names/],
      [{ optOut: ['lower'] }, /optOut must be a list of variable names/],
      [{ describe: 'a\nb' }, /describe must be one line/],
      [{ footer: ' ' }, /footer must be one line/],
      [{ retired: 'http://x' }, /retired must be an https link/],
      [{ retire: 'tool retire' }, /retire must name the merged pull request as \{number\}/],
      [{ retire: 'a\nb' }, /retire must be one line/],
    ] as const) {
      assert.throws(() => autocreateSettings({ prAutocreate: value }), error);
    }
  });
});

describe('pullsFor: the token GitHub is asked with', () => {
  const ID = 'abc-123';
  function at(): FakeSys {
    const sys = new FakeSys().ready();
    sys.execOverride = (call) => (call.command === 'git' && call.args[0] === 'config' ? { code: 0, stdout: `${URL_OF}\n`, stderr: '' } : undefined);
    return sys;
  }

  /** The token the transport's first request carries, or why it made none. */
  async function tokenOf(sys: FakeSys, session: string | undefined): Promise<string | undefined> {
    const pulls = pullsFor(sys, ROOT, session);
    assert.ok(pulls instanceof Pulls);
    sys.requests.length = 0;
    const listed = await pulls.list('feature');
    return typeof listed === 'string' && sys.requests.length === 0 ? listed : sys.requests[0]?.token;
  }

  it("acts as the session's agent, or not at all", async () => {
    const sys = at();
    assert.match((await tokenOf(sys, ID)) ?? '', /^niyam could not act as the agent \(.*\); run `niyam doctor`$/);
    sys.files.set(sessionRecord(HOME, ID) as string, `${JSON.stringify({ agent: 'ExampleBot' })}\n`);
    sys.env = { CLAUDE_CODE_REMOTE: 'true' };
    const cloud = pullsFor(sys, ROOT, ID);
    assert.ok(cloud instanceof Pulls && cloud.cloud && cloud.slug === SLUG);
    assert.equal(await tokenOf(sys, ID), PROXY_TOKEN);
  });

  it("uses the push's GH_TOKEN for the watcher, else gh's account, never the lock's placeholder", async () => {
    const sys = at();
    sys.env = { GH_TOKEN: 'ghp_push' };
    assert.equal(await tokenOf(sys, undefined), 'ghp_push');
    sys.env = { GH_TOKEN: NO_TOKEN };
    const base = sys.execOverride;
    sys.execOverride = (call) => (call.command === 'gh' ? { code: 0, stdout: 'ghp_gh\n', stderr: '' } : base(call));
    assert.equal(await tokenOf(sys, undefined), 'ghp_gh');
    sys.execOverride = (call) => (call.command === 'gh' ? { code: 0, stdout: `${NO_TOKEN}\n`, stderr: '' } : base(call));
    assert.equal(await tokenOf(sys, undefined), 'no GitHub token: GH_TOKEN is unset and gh is signed in to no account');
    sys.execOverride = (call) => (call.command === 'gh' ? { code: 1, stdout: '', stderr: 'no' } : base(call));
    assert.equal(await tokenOf(sys, undefined), 'no GitHub token: GH_TOKEN is unset and gh is signed in to no account');
  });

  it('finds the token once, at the first request', async () => {
    const sys = at();
    let found = 0;
    const pulls = new Pulls(sys, SLUG, () => {
      found++;
      return 'ghp_once';
    }, false);
    await pulls.list('a');
    await pulls.body(1);
    assert.equal(found, 1);
    assert.deepEqual(sys.requests.map((request) => request.token), ['ghp_once', 'ghp_once']);
  });

  it('asks nothing of a repository whose origin is not on GitHub', () => {
    const sys = at();
    sys.execOverride = () => ({ code: 0, stdout: 'git@gitlab.com:a/b.git\n', stderr: '' });
    assert.deepEqual(pullsFor(sys, ROOT, undefined), { problem: 'origin is not a github.com repository' });
  });
});

describe('niyam pr-autocreate', () => {
  it('never exits with a usage error, which would hold a hook', async () => {
    const seen = capture();
    assert.equal(await run(['pr-autocreate'], seen.io, () => new FakeSys()), 0);
    assert.equal(await run(['pr-autocreate', 'nope', '--x'], seen.io, () => new FakeSys()), 0);
    assert.deepEqual(seen.err, [
      'pr-autocreate: unknown mode ""; it takes claude-hook, spawn-watchers, refuse-retired or watch; nothing done',
      'pr-autocreate: unknown mode "nope"; it takes claude-hook, spawn-watchers, refuse-retired or watch; nothing done',
    ]);
  });

  it('exits 0 when the machine cannot even be read', async () => {
    const seen = capture();
    assert.equal(await run(['pr-autocreate', 'claude-hook'], seen.io, () => Promise.reject(new Error('no home'))), 0);
    assert.deepEqual(seen.err, ['pr-autocreate: unexpected error (no home); nothing done']);
    assert.equal(await run(['pr-autocreate', 'claude-hook'], seen.io, () => Promise.reject('plain')), 0);
  });

  it('reads the hook and pre-push input from stdin, and fails open on its own error', async () => {
    const sys = new FakeSys();
    sys.stdin = 'not json';
    const hooked = capture();
    assert.equal(await prAutocreate(sys, hooked.io, ['claude-hook']), 0);
    assert.deepEqual(hooked.err, ['pr-autocreate: hook input is not valid JSON; nothing done']);
    sys.stdin = '';
    assert.equal(await prAutocreate(sys, capture().io, ['spawn-watchers', '--root', ROOT, '--remote', 'origin']), 0);
    const watched = capture();
    assert.equal(await prAutocreate(sys, watched.io, ['watch']), 0);
    assert.match(watched.out[0] as string, /watch: watch needs --root; no PR opened$/);
    sys.readStdin = () => {
      throw new Error('EBADF');
    };
    const broken = capture();
    assert.equal(await prAutocreate(sys, broken.io, ['claude-hook']), 0);
    assert.deepEqual(broken.err, ['pr-autocreate: unexpected error (EBADF); nothing done']);
  });

  it('runs refuse-retired from stdin, and a crash there exits RETIRED_UNCHECKED, never the 0 of a live branch', async () => {
    const sys = new FakeSys();
    sys.stdin = '';
    assert.equal(await prAutocreate(sys, capture().io, ['refuse-retired', '--root', ROOT, '--remote', 'origin']), 0);
    sys.readStdin = () => {
      throw new Error('EBADF');
    };
    const broken = capture();
    assert.equal(await prAutocreate(sys, broken.io, ['refuse-retired', '--root', ROOT, '--remote', 'origin']), RETIRED_UNCHECKED);
    assert.deepEqual(broken.out, ["⚠️  Could not check whether a pushed branch's PR already merged (pr-autocreate crashed: EBADF); not checked."]);
    sys.readStdin = () => {
      throw 'plain';
    };
    const plain = capture();
    assert.equal(await prAutocreate(sys, plain.io, ['refuse-retired']), RETIRED_UNCHECKED);
    assert.match(plain.out[0] as string, /pr-autocreate crashed: plain\); not checked\.$/);
  });
});

describe('pr-autocreate refuse-retired (real git, GitHub faked)', () => {
  let w: ReturnType<typeof world>;
  let github: FakeGitHub;
  let sys: ReturnType<typeof machine>;
  beforeEach(() => {
    w = world();
    github = new FakeGitHub();
    sys = machine(github, w.dir);
  });

  const zero = '0'.repeat(40);
  const line = (branch: string): string => `refs/heads/${branch} ${SHA} refs/heads/${branch} ${OTHER}`;
  async function refuse(lines: string, args = ['--root', w.work, '--remote', 'origin'], pullsOf: PullsOf = viaToken(), on: Sys = sys): Promise<{ code: number; out: string[]; err: string[] }> {
    const seen = capture();
    const code = await refuseRetired(on, seen.io, args, lines, pullsOf);
    return { code, out: seen.out, err: seen.err };
  }

  it('(L-04) refuses a push to a branch whose PR merged, with none open, and names the way out', async () => {
    github.pulls.push({ number: 7, head: 'feature', state: 'closed', merged_at: '2026-11-14T00:00:00Z', body: '' });
    assert.deepEqual(await refuse(line('feature')), {
      code: RETIRED_REFUSAL,
      out: [
        '❌ Error: feature already has MERGED PR #7 and no open PR. Pushing it',
        '   recreates a branch the merge retired, and the commits after the merge land in no PR.',
        '   Move the commits missing from the PR head to a fresh branch, then push that.',
      ],
      err: [],
    });
  });

  it("names the client's retire command, or its page, when the settings give one", async () => {
    github.pulls.push({ number: 7, head: 'feature', state: 'closed', merged_at: '2026-11-14T00:00:00Z', body: '' });
    mkdirSync(join(w.work, '.github'));
    writeFileSync(join(w.work, '.github/niyam.json'), JSON.stringify({ prAutocreate: { retire: 'tool retire --pr {number}' } }));
    assert.deepEqual((await refuse(line('feature'))).out.slice(2), ['   Retire it: move the commits missing from the PR head to a fresh branch, then push that:', '     tool retire --pr 7']);
    writeFileSync(join(w.work, '.github/niyam.json'), JSON.stringify({ prAutocreate: { retired: 'https://x.invalid/retired' } }));
    assert.deepEqual((await refuse(line('feature'))).out.slice(2), ['   Move the commits missing from the PR head to a fresh branch, then push that (https://x.invalid/retired).']);
  });

  it('passes a live branch: an open PR after a merged one, one closed unmerged, or none', async () => {
    github.pulls.push({ number: 7, head: 'feature', state: 'closed', merged_at: '2026-11-14T00:00:00Z', body: '' });
    github.pulls.push({ number: 8, head: 'feature', state: 'open', merged_at: null, body: '' });
    github.pulls.push({ number: 9, head: 'closed-one', state: 'closed', merged_at: null, body: '' });
    assert.deepEqual(await refuse([line('feature'), line('closed-one'), line('fresh')].join('\n')), { code: 0, out: [], err: [] });
    assert.equal(github.count('GET', 'pulls?'), 3);
  });

  it('judges no deletion, tag, protected branch, other remote or CI push, and asks GitHub nothing for them', async () => {
    github.pulls.push({ number: 7, head: 'feature', state: 'closed', merged_at: '2026-11-14T00:00:00Z', body: '' });
    const lines = [`(delete) ${zero} refs/heads/feature ${OTHER}`, `refs/tags/v1 ${SHA} refs/tags/v1 ${zero}`, `refs/heads/x ${SHA} refs/heads/main ${OTHER}`, 'not a ref line'].join('\n');
    assert.equal((await refuse(lines)).code, 0);
    assert.equal((await refuse(line('feature'), ['--root', w.work, '--remote', 'fork'])).code, 0);
    assert.equal((await refuse(line('feature'), undefined, undefined, { ...sys, env: { CI: 'true' } })).code, 0);
    assert.equal(github.calls.length, 0);
  });

  it('asks once per branch, however many ref lines push it', async () => {
    assert.equal((await refuse([line('feature'), `refs/heads/local ${SHA} refs/heads/feature ${OTHER}`].join('\n'))).code, 0);
    assert.equal(github.count('GET', 'pulls?'), 1);
  });

  it('warns and refuses nothing when GitHub cannot answer, or a page may hold back the open PR', async () => {
    github.queued.push({ status: 502, json: null });
    assert.deepEqual(await refuse(line('feature')), { code: 0, out: ["⚠️  Could not ask GitHub whether feature's PR already merged (GitHub answered 502 listing pull requests); not checked."], err: [] });
    const full = `⚠️  Could not ask GitHub whether feature's PR already merged (GitHub listed ${PR_LIST_LIMIT} or more PRs, more than one page shows); not checked.`;
    for (let n = 0; n < PR_LIST_LIMIT; n++) github.pulls.push({ number: n + 1, head: 'feature', state: 'closed', merged_at: '2026-11-14T00:00:00Z', body: '' });
    assert.deepEqual((await refuse(line('feature'))).out, [full]);
    // A page filled by other heads counts too: what it held back may be this branch's open PR.
    github.pulls = [{ number: 1, head: 'feature', state: 'closed', merged_at: '2026-11-14T00:00:00Z', body: '' }];
    github.extra = Array.from({ length: PR_LIST_LIMIT - 1 }, (_, n) => ({ number: 50 + n, html_url: `https://github.com/${SLUG}/pull/${50 + n}`, state: 'closed', merged_at: null, head: { ref: 'other' } }));
    assert.deepEqual((await refuse(line('feature'))).out, [full]);
    github.extra = github.extra.slice(1);
    assert.equal((await refuse(line('feature'))).code, RETIRED_REFUSAL);
    assert.deepEqual((await refuse(line('feature'), undefined, () => ({ problem: 'origin is not a github.com repository' }))).out, [
      "⚠️  Could not ask GitHub whether feature's PR already merged (origin is not a github.com repository); not checked.",
    ]);
  });

  it('exits RETIRED_UNCHECKED on arguments or settings it cannot read', async () => {
    assert.deepEqual(await refuse(line('feature'), ['--remote', 'origin']), {
      code: RETIRED_UNCHECKED,
      out: ["⚠️  Could not check whether a pushed branch's PR already merged (refuse-retired needs --root <repository>); not checked."],
      err: [],
    });
    assert.match((await refuse(line('feature'), ['--nope'])).out[0] as string, /unexpected argument "--nope"/);
    mkdirSync(join(w.work, '.github'));
    writeFileSync(join(w.work, '.github/niyam.json'), JSON.stringify({ prAutocreate: [] }));
    const bad = await refuse(line('feature'));
    assert.equal(bad.code, RETIRED_UNCHECKED);
    assert.match(bad.out[0] as string, /"prAutocreate" must be an object\); not checked\.$/);
  });
});

describe('retiredBy and pushedRefs', () => {
  const pull = (number: number, state: 'OPEN' | 'MERGED' | 'CLOSED') => ({ number, url: `https://github.com/${SLUG}/pull/${number}`, state });
  it('a merged PR retires a branch only while none is open', () => {
    assert.equal(retiredBy([]), undefined);
    assert.equal(retiredBy([pull(1, 'CLOSED')]), undefined);
    assert.equal(retiredBy([pull(2, 'OPEN'), pull(1, 'MERGED')]), undefined);
    assert.deepEqual(retiredBy([pull(3, 'CLOSED'), pull(1, 'MERGED')]), pull(1, 'MERGED'));
  });

  it("reads git's pre-push ref lines: the remote branch of each real commit", () => {
    assert.deepEqual(pushedRefs([`refs/heads/a ${SHA} refs/heads/b ${OTHER}`, `x ${'0'.repeat(40)} refs/heads/gone ${OTHER}`, `refs/tags/t ${SHA} refs/tags/t ${OTHER}`, '  ', 'a b c'].join('\n')), [
      { localSha: SHA, branch: 'b', remoteSha: OTHER },
    ]);
  });
});
