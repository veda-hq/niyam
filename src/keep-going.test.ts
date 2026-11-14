import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { sessionRecord } from './agent.ts';
import { PROXY_TOKEN } from './cloud.ts';
import { FakeSys, HOME, ROOT, capture, type Call } from './fake.test.ts';
import { GITHUB_API } from './host.ts';
import {
  CAP,
  STOP_COMMAND,
  STORE,
  backgroundTask,
  carriedElsewhere,
  decide,
  gather,
  gitVerb,
  keepGoing,
  keepGoingSettings,
  pushInFlight,
  readPr,
  settingsAt,
  stopHook,
  type Facts,
  type PullRequest,
} from './keep-going.ts';
import { run } from './run.ts';
import { realSys } from './sys.ts';

const HEAD = 'a'.repeat(40);
const OLD = 'b'.repeat(40);
const SETTINGS = keepGoingSettings({ keepGoing: { base: 'main' } });
/** A client's own words: another trunk, an older print-mode variable, its owner's name and its tag. */
const CLIENT = keepGoingSettings({ keepGoing: { base: 'main', trunks: ['prod'], printMode: ['OLD_PRINT_MODE'], owner: 'Pat', tag: 'D-9 stop hook' } });

function facts(over: Partial<Facts> = {}): Facts {
  return { desktop: false, print: false, subagent: false, branch: 'feature', head: HEAD, ahead: 2, carried: false, note: null, remote: HEAD, pr: null, pushing: false, dirty: false, ...over };
}

const open = (over: Partial<PullRequest> = {}): PullRequest => ({ number: 7, state: 'OPEN', isDraft: false, headRefOid: HEAD, ...over });

function reason(decision: ReturnType<typeof decide>): string {
  assert.equal(decision.stop, false);
  return 'reason' in decision ? decision.reason : '';
}

describe('decide', () => {
  it('lets a stop through where the rule does not hold', () => {
    for (const over of [{ subagent: true }, { ahead: 0 }, { ahead: null }, { branch: '' }, { branch: 'main' }, { carried: true }, { pushing: true }, { pr: 'unknown' as const }]) {
      assert.equal(decide(facts(over), null, SETTINGS).stop, true, JSON.stringify(over));
    }
    assert.equal(decide(facts({ branch: 'prod' }), null, CLIENT).stop, true);
    assert.equal(decide(facts({ branch: 'prod' }), null, SETTINGS).stop, false);
  });

  it('sends a terminal session with a ready PR back to carry it to merge', () => {
    assert.match(reason(decide(facts({ pr: open() }), null, SETTINGS)), /^Branch feature has 2 commit\(s\) origin\/main lacks, and started work runs to merge\. PR 7 is open: carry it to merge, polling checks and review threads with foreground waits\. Do not end a turn waiting on something that cannot wake you\. If only the owner can unblock it.*\(niyam keep-going, 1 of 5\.\)$/);
  });

  it('lets a desktop session with every commit on a ready PR stop, and nothing short of that', () => {
    assert.equal(decide(facts({ desktop: true, pr: open() }), null, SETTINGS).stop, true);
    assert.match(reason(decide(facts({ desktop: true, pr: open(), dirty: true }), null, SETTINGS)), /PR 7 is open/);
    assert.match(reason(decide(facts({ desktop: true, pr: open({ isDraft: true }) }), null, SETTINGS)), /PR 7 is a draft: finish the work, push, mark it ready/);
    assert.match(reason(decide(facts({ desktop: true, pr: open(), remote: OLD }), null, SETTINGS)), /local commits are not on the remote: push them; run the push as a background task/);
    assert.match(reason(decide(facts({ desktop: true, pr: open({ state: 'CLOSED' }) }), null, SETTINGS)), /PR 7 was closed without merging: reopen it, or record why the work stops/);
  });

  it('asks for a first push and a PR on a branch never pushed', () => {
    assert.match(reason(decide(facts({ remote: null }), null, SETTINGS)), /the branch is not on the remote: push it; run the push as a background task so you are told when it exits; no pull request yet: open it\./);
  });

  it('holds a print-mode stop while a push runs, and tells it to push in the foreground', () => {
    assert.match(reason(decide(facts({ print: true, pushing: true }), null, SETTINGS)), /a commit, push or background task is running, and in print mode it dies with this turn: wait for it in the foreground/);
    assert.match(reason(decide(facts({ print: true, remote: null }), null, SETTINGS)), /in print mode nothing wakes you: run the push in the foreground with the longest Bash timeout/);
    assert.equal(decide(facts({ print: true, pr: 'unknown' }), null, SETTINGS).stop, true);
  });

  it('releases a merge of this commit only, and not with work left on top', () => {
    assert.equal(decide(facts({ pr: open({ state: 'MERGED' }) }), null, SETTINGS).stop, true);
    assert.match(reason(decide(facts({ pr: open({ state: 'MERGED', headRefOid: OLD }) }), null, SETTINGS)), /PR 7 merged an older commit; the work since is not merged/);
    assert.equal(decide(facts({ pr: open({ state: 'MERGED' }), dirty: true }), null, SETTINGS).stop, false);
  });

  it('counts at one commit, starts again at a new one, and at the cap records why it let go', () => {
    let counter = null as ReturnType<typeof decide>['counter'] | null;
    for (let n = 1; n <= CAP; n++) {
      const decision = decide(facts(), counter, CLIENT);
      assert.match(reason(decision), new RegExp(`\\(D-9 stop hook, ${n} of ${CAP}\\.\\)$`));
      assert.match(reason(decision), /If only Pat can unblock it/);
      counter = decision.counter;
    }
    const capped = decide(facts(), counter, CLIENT);
    assert.deepEqual(capped, { stop: true, counter: { head: HEAD, count: CAP + 1 }, record: `stop hook: the session tried to stop ${CAP + 1} times at ${HEAD.slice(0, 9)} with no new commit and gave no reason; cause unknown, Pat to look (D-9 stop hook cap)` });
    assert.equal(decide(facts({ head: OLD }), counter, SETTINGS).counter.count, 1);
  });

  it('lets a stop note at this commit through, its reason shown once', () => {
    const note = { branch: 'feature', head: HEAD, reason: 'waiting on the owner', at: 'now' };
    assert.deepEqual(decide(facts({ note }), null, SETTINGS), { stop: true, counter: { head: HEAD, count: 0 }, say: 'waiting on the owner' });
    assert.deepEqual(decide(facts({ note: { ...note, shown: true } }), null, SETTINGS), { stop: true, counter: { head: HEAD, count: 0 } });
    assert.equal(decide(facts({ note: { ...note, head: OLD } }), null, SETTINGS).stop, false);
    assert.equal(decide(facts({ note: { ...note, branch: 'other' } }), null, SETTINGS).stop, false);
  });
});

describe('settingsAt', () => {
  it("takes origin's default branch when no base is set, else main", () => {
    assert.equal(settingsAt(checkout({ 'symbolic-ref --quiet --short refs/remotes/origin/HEAD': 'origin/trunk' }), ROOT).base, 'trunk');
    assert.equal(settingsAt(checkout({ 'symbolic-ref --quiet --short refs/remotes/origin/HEAD': null }), ROOT).base, 'main');
    const set = checkout();
    set.files.set(`${ROOT}/.github/niyam.json`, JSON.stringify({ keepGoing: { base: 'develop' } }));
    assert.equal(settingsAt(set, ROOT).base, 'develop');
    const none = checkout();
    none.files.delete(`${ROOT}/.github/niyam.json`);
    assert.equal(settingsAt(none, ROOT).base, 'main');
  });
});

describe('keepGoingSettings', () => {
  it('names the first key it cannot take', () => {
    assert.deepEqual(keepGoingSettings(null), keepGoingSettings({}));
    assert.equal(keepGoingSettings({}).base, '');
    for (const [value, error] of [
      [[], /must be an object/],
      [{ nope: 1 }, /unknown key "nope"/],
      [{ base: '../x' }, /base must be a branch name/],
      [{ trunks: 'prod' }, /trunks must be a list of branch names/],
      [{ printMode: ['lower'] }, /printMode must be a list of variable names/],
      [{ owner: '' }, /owner must be one line/],
      [{ tag: 'a\nb' }, /tag must be one line/],
    ] as const) {
      assert.throws(() => keepGoingSettings({ keepGoing: value }), error);
    }
  });
});

describe('the process checks', () => {
  it('reads a git commit or push as one, past global options only', () => {
    assert.equal(gitVerb(['/usr/bin/git', '-C', 'x', '-c', 'a=b', '--no-pager', 'push']), true);
    assert.equal(gitVerb(['git', 'commit', '-m', 'x']), true);
    assert.equal(gitVerb(['git', 'log', '--grep', 'push']), false);
    assert.equal(gitVerb(['git', '-C']), false);
    assert.equal(gitVerb(['node', 'push']), false);
  });

  function withProcesses(table: string, cwd: Record<string, string> = {}): FakeSys {
    const sys = new FakeSys();
    sys.execOverride = (call) => {
      if (call.command === 'ps') return { code: 0, stdout: table, stderr: '' };
      if (call.command === 'lsof') {
        const path = cwd[call.args[2] as string];
        return path === undefined ? { code: 1, stdout: '', stderr: '' } : { code: 0, stdout: `p${call.args[2]}\nfcwd\nn${path}\n`, stderr: '' };
      }
      return undefined;
    };
    return sys;
  }

  it('finds a push or commit whose working directory is in this worktree, and nothing else', () => {
    const table = ' 11 git push origin x\n 12 git commit -m y\n 13 git log --grep push\nx junk\n';
    assert.equal(pushInFlight(withProcesses(table, { 11: `${ROOT}/sub` }), ROOT), true);
    assert.equal(pushInFlight(withProcesses(table, { 12: ROOT }), ROOT), true);
    assert.equal(pushInFlight(withProcesses(table, { 11: `${ROOT}-other`, 13: ROOT }), ROOT), false);
    const none = new FakeSys();
    none.execOverride = () => ({ code: 1, stdout: '', stderr: '' });
    assert.equal(pushInFlight(none, ROOT), false);
  });

  it("finds a snapshot shell under the Claude process, and nothing else", () => {
    const table = ' 20 99 /bin/zsh -c source /h/.claude/shell-snapshots/snapshot-zsh-1.sh && sleep 9\n 21 1 /bin/zsh -c source /h/.claude/shell-snapshots/snapshot-zsh-2.sh\n 22 99 node other\n';
    assert.equal(backgroundTask(withProcesses(table), '99', ROOT), true);
    assert.equal(backgroundTask(withProcesses(table), '98', ROOT), false);
    assert.equal(backgroundTask(withProcesses(table), undefined, ROOT), false);
    const none = new FakeSys();
    none.execOverride = () => ({ code: 1, stdout: '', stderr: '' });
    assert.equal(backgroundTask(none, '99', ROOT), false);
  });

  it('reads another remote branch holding HEAD as carried, and git silent as carried too', () => {
    const at = (refs: string | null): FakeSys => {
      const sys = new FakeSys();
      sys.execOverride = () => (refs === null ? { code: 1, stdout: '', stderr: '' } : { code: 0, stdout: refs, stderr: '' });
      return sys;
    };
    assert.equal(carriedElsewhere(at('origin/feature\norigin/main\norigin/HEAD\norigin\n'), ROOT, 'feature', 'main'), false);
    assert.equal(carriedElsewhere(at('origin/group\n'), ROOT, 'feature', 'main'), true);
    assert.equal(carriedElsewhere(at(null), ROOT, 'feature', 'main'), true);
  });
});

/** A checkout's git answers, and GitHub's pulls, as FakeSys gives them. */
function checkout(answers: Record<string, string | null> = {}): FakeSys {
  const sys = new FakeSys();
  const git: Record<string, string | null> = {
    'rev-parse --show-toplevel': ROOT,
    'rev-parse HEAD': HEAD,
    'symbolic-ref --quiet --short HEAD': 'feature',
    'rev-parse --verify --quiet @{u}': HEAD,
    'rev-list --count origin/main..HEAD': '2',
    'status --porcelain -- . :(exclude).tmp/keep-going :(exclude).tmp/pr-autocreate': '',
    'symbolic-ref --quiet --short refs/remotes/origin/HEAD': 'origin/main',
    'config --get remote.origin.url': 'https://github.com/example-org/example-app.git',
    'for-each-ref --contains HEAD --format=%(refname:short) refs/remotes/origin': 'origin/feature',
    ...answers,
  };
  sys.execOverride = (call: Call) => {
    if (call.command === 'git') {
      const answer = git[call.args.join(' ')];
      return answer === null || answer === undefined ? { code: 1, stdout: '', stderr: '' } : { code: 0, stdout: `${answer}\n`, stderr: '' };
    }
    if (call.command === 'ps') return { code: 0, stdout: '', stderr: '' };
    return undefined;
  };
  sys.env = { GH_TOKEN: 'ghp_shell' };
  return sys;
}

function pulls(sys: FakeSys, list: unknown[] | (() => { status: number; json: unknown })): void {
  sys.handlers.push((method, url) => {
    if (method !== 'GET' || !url.startsWith(`${GITHUB_API}/repos/example-org/example-app/pulls?`)) return undefined;
    return typeof list === 'function' ? list() : { status: 200, json: list };
  });
}

/** Sessions session-start recorded as the agent, in a cloud session, where the proxy's token is the agent's. */
function asAgent(sys: FakeSys, ...ids: string[]): FakeSys {
  sys.ready();
  for (const id of ids) sys.files.set(sessionRecord(HOME, id) as string, `${JSON.stringify({ agent: 'ExampleBot' })}\n`);
  sys.env = { ...sys.env, CLAUDE_CODE_REMOTE: 'true' };
  return sys;
}

const restPull = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ number: 7, state: 'open', draft: false, merged_at: null, head: { sha: HEAD, repo: { full_name: 'Example-Org/example-app' } }, ...over });

describe('readPr', () => {
  it('reads the PR over REST: merged, open, closed and draft', async () => {
    for (const [pull, want] of [
      [restPull(), open()],
      [restPull({ draft: true }), open({ isDraft: true })],
      [restPull({ state: 'closed', merged_at: '2026-11-01T00:00:00Z' }), open({ state: 'MERGED' })],
      [restPull({ state: 'closed' }), open({ state: 'CLOSED' })],
    ] as const) {
      const sys = checkout();
      pulls(sys, [pull]);
      assert.deepEqual(await readPr(sys, ROOT, 'feature', HEAD, undefined), want);
    }
    const sys = checkout();
    pulls(sys, []);
    assert.equal(await readPr(sys, ROOT, 'feature', HEAD, undefined), null);
    assert.match(sys.requests[0]?.url ?? '', /pulls\?head=example-org%3Afeature&state=all&per_page=100&page=1$/);
  });

  it("skips a fork's PR of the same name, and takes the one carrying this commit over a newer one", async () => {
    const sys = checkout();
    pulls(sys, [restPull({ number: 9, head: { sha: HEAD, repo: { full_name: 'fork/example-app' } } }), restPull({ number: 8, head: { sha: HEAD, repo: null } }), restPull({ number: 6, head: { sha: OLD, repo: { full_name: 'example-org/example-app' } } }), restPull({ number: 5 })]);
    assert.equal((await readPr(sys, ROOT, 'feature', HEAD, undefined) as PullRequest).number, 5);
    assert.equal((await readPr(sys, ROOT, 'feature', 'c'.repeat(40), undefined) as PullRequest).number, 6);
  });

  it('reads unknown with no GitHub origin, no token, a refused or unreadable answer', async () => {
    assert.equal(await readPr(checkout({ 'config --get remote.origin.url': 'git@gitlab.com:a/b.git' }), ROOT, 'feature', HEAD, undefined), 'unknown');
    assert.equal(await readPr(checkout({ 'config --get remote.origin.url': null }), ROOT, 'feature', HEAD, undefined), 'unknown');
    const noToken = checkout();
    noToken.env = {};
    assert.equal(await readPr(noToken, ROOT, 'feature', HEAD, undefined), 'unknown');
    const refused = checkout();
    pulls(refused, () => ({ status: 403, json: { message: 'no' } }));
    assert.equal(await readPr(refused, ROOT, 'feature', HEAD, undefined), 'unknown');
    for (const bad of [{ number: 'x' }, restPull({ draft: 'no' }), restPull({ head: {} })]) {
      const sys = checkout();
      pulls(sys, [bad]);
      assert.equal(await readPr(sys, ROOT, 'feature', HEAD, undefined), 'unknown');
    }
  });

  it('reads every page, and gives up past ten', async () => {
    const sys = checkout();
    const full = Array.from({ length: 100 }, (_, n) => restPull({ number: 1000 + n, head: { sha: OLD, repo: { full_name: 'example-org/example-app' } } }));
    let page = 0;
    pulls(sys, () => (++page === 1 ? { status: 200, json: full } : { status: 200, json: [restPull()] }));
    assert.equal((await readPr(sys, ROOT, 'feature', HEAD, undefined) as PullRequest).number, 7);
    assert.match(sys.requests[1]?.url ?? '', /&page=2$/);
    assert.equal(sys.requests[0]?.timeoutMs, 15_000);
    const endless = checkout();
    pulls(endless, full);
    assert.equal(await readPr(endless, ROOT, 'feature', HEAD, undefined), 'unknown');
    assert.equal(endless.requests.length, 10);
    const offline = checkout();
    offline.http = () => Promise.reject(new Error('offline'));
    assert.equal(await readPr(offline, ROOT, 'feature', HEAD, undefined), 'unknown');
  });

  it("reads as the session's agent, or not at all, and then says how to fix it", async () => {
    const sys = checkout();
    pulls(sys, [restPull()]);
    const said: string[] = [];
    assert.equal(await readPr(sys, ROOT, 'feature', HEAD, 'abc-123', (line) => said.push(line)), 'unknown');
    assert.match(said[0] ?? '', /^niyam could not act as the agent \(.*\); run `niyam doctor`$/);
    assert.equal(await readPr(sys, ROOT, 'feature', HEAD, 'abc-123'), 'unknown');
    sys.ready();
    sys.files.set(sessionRecord(HOME, 'abc-123') as string, `${JSON.stringify({ agent: 'ExampleBot' })}\n`);
    sys.env = { CLAUDE_CODE_REMOTE: 'true' };
    assert.deepEqual(await readPr(sys, ROOT, 'feature', HEAD, 'abc-123'), open());
    assert.equal(sys.requests.at(-1)?.token, PROXY_TOKEN);
  });
});

describe('gather', () => {
  it('reads the branch, the PR, and nothing past a reason to stop', async () => {
    const sys = checkout();
    pulls(sys, [restPull()]);
    sys.env = { ...sys.env, CLAUDE_CODE_ENTRYPOINT: 'claude-desktop', OLD_PRINT_MODE: '1' };
    assert.deepEqual(await gather(sys, ROOT, CLIENT, false, undefined), facts({ desktop: true, print: true, pr: open() }));
    const sub = checkout();
    assert.deepEqual(await gather(sub, ROOT, SETTINGS, true, undefined), facts({ subagent: true, ahead: null }));
    assert.equal(sub.requests.length, 0);
  });

  it('reports a detached HEAD, a missing commit and an unknown count without asking GitHub', async () => {
    const sys = checkout({ 'symbolic-ref --quiet --short HEAD': null, 'rev-parse HEAD': null, 'rev-list --count origin/main..HEAD': null });
    const got = await gather(sys, ROOT, SETTINGS, false, undefined);
    assert.deepEqual([got.branch, got.head, got.ahead, got.pr], ['', '', null, null]);
    assert.equal(sys.requests.length, 0);
  });

  it('counts against the configured base, and does not ask about other branches once its own is pushed', async () => {
    const sys = checkout({ 'rev-list --count origin/trunk..HEAD': '3', 'for-each-ref --contains HEAD --format=%(refname:short) refs/remotes/origin': 'origin/group' });
    pulls(sys, []);
    const got = await gather(sys, ROOT, keepGoingSettings({ keepGoing: { base: 'trunk' } }), false, undefined);
    assert.deepEqual([got.ahead, got.carried], [3, false]);
    const unpushed = checkout({ 'rev-parse --verify --quiet @{u}': null, 'for-each-ref --contains HEAD --format=%(refname:short) refs/remotes/origin': 'origin/group' });
    assert.equal((await gather(unpushed, ROOT, SETTINGS, false, undefined)).carried, true);
  });

  it('skips GitHub at a stop note that holds, or past a push in flight', async () => {
    const noted = checkout();
    noted.files.set(`${ROOT}/${STORE}/stop-note.json`, JSON.stringify({ branch: 'feature', head: HEAD, reason: 'r', at: 'x' }));
    assert.equal((await gather(noted, ROOT, SETTINGS, false, undefined)).note?.reason, 'r');
    assert.equal(noted.requests.length, 0);
    const pushing = checkout();
    const base = pushing.execOverride;
    pushing.env = { ...pushing.env, CLAUDE_PID: '99' };
    pushing.execOverride = (call) => (call.command === 'ps' ? { code: 0, stdout: ' 5 99 /bin/zsh -c source /x/shell-snapshots/snapshot-1.sh\n', stderr: '' } : base(call));
    assert.equal((await gather(pushing, ROOT, SETTINGS, false, undefined)).pushing, true);
    assert.equal(pushing.requests.length, 0);
  });
});

describe('stopHook', () => {
  it('blocks with a reason and keeps the count per session', async () => {
    const sys = asAgent(checkout(), 's1');
    pulls(sys, [restPull()]);
    const first = JSON.parse(await stopHook(sys, JSON.stringify({ session_id: 's1', cwd: ROOT }))) as { decision: string; reason: string };
    assert.equal(first.decision, 'block');
    assert.match(first.reason, /1 of 5/);
    assert.equal(sys.files.get(`${ROOT}/${STORE}/s1.json`), JSON.stringify({ head: HEAD, count: 1 }));
    assert.match(await stopHook(sys, JSON.stringify({ session_id: 's1', cwd: ROOT })), /2 of 5/);
    assert.match(await stopHook(sys, JSON.stringify({ cwd: ROOT })), /1 of 5/);
    assert.ok(sys.files.has(`${ROOT}/${STORE}/unknown.json`));
  });

  it('shows a stop note once, then lets go silently', async () => {
    const sys = checkout();
    sys.files.set(`${ROOT}/${STORE}/stop-note.json`, JSON.stringify({ branch: 'feature', head: HEAD, reason: 'stuck on the owner', at: 'x' }));
    assert.equal(await stopHook(sys, JSON.stringify({ session_id: 's', cwd: ROOT })), JSON.stringify({ systemMessage: 'Stopped: stuck on the owner' }));
    assert.equal(JSON.parse(sys.files.get(`${ROOT}/${STORE}/stop-note.json`) as string).shown, true);
    assert.equal(await stopHook(sys, JSON.stringify({ session_id: 's', cwd: ROOT })), '');
  });

  it('at the cap writes the stop note itself, says so once, then lets go', async () => {
    const sys = asAgent(checkout(), 's');
    pulls(sys, [restPull()]);
    sys.files.set(`${ROOT}/${STORE}/s.json`, JSON.stringify({ head: HEAD, count: CAP }));
    const capped = JSON.parse(await stopHook(sys, JSON.stringify({ session_id: 's', cwd: ROOT }))) as { decision: string; reason: string; systemMessage: string };
    assert.equal(capped.decision, 'block');
    assert.match(capped.reason, /^The stop hook wrote a stop note for feature: started work is held at a{9} with no reason given\. Tell the owner/);
    assert.match(capped.systemMessage, /^feature stopped by the hook: stop hook: the session tried to stop 6 times/);
    assert.equal(await stopHook(sys, JSON.stringify({ session_id: 's', cwd: ROOT })), '');
  });

  it('prints nothing when the stop is allowed, the input is unusable, or anything throws', async () => {
    const sys = checkout({ 'rev-list --count origin/main..HEAD': '0' });
    assert.equal(await stopHook(sys, JSON.stringify({ cwd: ROOT })), '');
    for (const input of ['', 'null', '{x', JSON.stringify({})]) assert.equal(await stopHook(sys, input), '');
    assert.equal(await stopHook(checkout({ 'rev-parse --show-toplevel': null }), JSON.stringify({ cwd: ROOT })), '');
    const torn = checkout();
    torn.files.set(`${ROOT}/${STORE}/stop-note.json`, '{torn');
    assert.equal(await stopHook(torn, JSON.stringify({ cwd: ROOT })), '');
    const bad = checkout();
    bad.files.set(`${ROOT}/.github/niyam.json`, JSON.stringify({ keepGoing: { nope: 1 } }));
    assert.equal(await stopHook(bad, JSON.stringify({ cwd: ROOT })), '');
    const fromEnv = asAgent(checkout(), 'x');
    pulls(fromEnv, []);
    fromEnv.env = { ...fromEnv.env, CLAUDE_PROJECT_DIR: ROOT };
    assert.match(await stopHook(fromEnv, JSON.stringify({ session_id: 'x' })), /no pull request yet: open it/);
  });
});

describe('niyam keep-going', () => {
  it('writes the stop note at this branch and commit, trimmed, naming who to tell', async () => {
    const sys = checkout();
    sys.files.set(`${ROOT}/.github/niyam.json`, JSON.stringify({ keepGoing: { owner: 'Pat' } }));
    const seen = capture();
    assert.equal(await keepGoing(sys, seen.io, ['--stop', '  waiting', 'on', 'Pat  ']), 0);
    assert.deepEqual(seen.out, [`Stop note written for feature at ${HEAD.slice(0, 9)}; a new commit voids it. Tell Pat what happened, why, and the options; then stop.`]);
    assert.deepEqual(JSON.parse(sys.files.get(`${ROOT}/${STORE}/stop-note.json`) as string), { branch: 'feature', head: HEAD, reason: 'waiting on Pat', at: sys.now().toISOString() });
  });

  it('refuses a stop with no reason or off a branch (exit 1), and says who to tell when the settings are torn', async () => {
    const empty = capture();
    assert.equal(await keepGoing(checkout(), empty.io, ['--stop', ' ']), 1);
    assert.deepEqual(empty.out, [`Say why in plain English: ${STOP_COMMAND}`]);
    const detached = capture();
    assert.equal(await keepGoing(checkout({ 'symbolic-ref --quiet --short HEAD': null }), detached.io, ['--stop', 'x']), 1);
    assert.deepEqual(detached.out, ['Not on a branch of a git checkout.']);
    const torn = checkout();
    torn.files.set(`${ROOT}/.github/niyam.json`, '{');
    const seen = capture();
    assert.equal(await keepGoing(torn, seen.io, ['--stop', 'x']), 0);
    assert.match(seen.out[0] as string, /Tell the owner/);
  });

  it('as the hook reads stdin, prints its decision or nothing, and always exits 0', async () => {
    const sys = checkout();
    pulls(sys, []);
    sys.stdin = JSON.stringify({ cwd: ROOT });
    const seen = capture();
    assert.equal(await keepGoing(sys, seen.io, []), 0);
    assert.match(seen.out[0] as string, /"decision":"block"/);
    sys.stdin = '';
    const quiet = capture();
    assert.equal(await keepGoing(sys, quiet.io, []), 0);
    assert.deepEqual(quiet.out, []);
    sys.readStdin = () => {
      throw new Error('EBADF');
    };
    assert.equal(await keepGoing(sys, capture().io, []), 0);
  });

  it('runs from the command line, and fails open when the machine cannot be read', async () => {
    const seen = capture();
    assert.equal(await run(['keep-going'], seen.io, () => Promise.reject(new Error('no home'))), 0);
    assert.equal(await run(['keep-going', '--stop', 'x'], seen.io, () => Promise.reject('plain')), 1);
    assert.deepEqual(seen.err, ['niyam keep-going: no home', 'niyam keep-going: plain']);
  });
});

describe('keep-going on real git', () => {
  const dirs: string[] = [];
  after(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  it('lets a checkout with nothing started stop, holds one with work, and takes --stop at its commit', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'niyam-keep-going-')));
    dirs.push(dir);
    const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
    const bare = join(dir, 'origin.git');
    const work = join(dir, 'work');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare], { env });
    mkdirSync(work);
    const git = (...args: string[]): string => execFileSync('git', args, { cwd: work, encoding: 'utf8', env }).trim();
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@example.invalid');
    git('config', 'user.name', 'T');
    git('config', 'commit.gpgsign', 'false');
    git('remote', 'add', 'origin', bare);
    writeFileSync(join(work, 'a'), 'a\n');
    git('add', 'a');
    git('commit', '-q', '-m', 'base');
    git('push', '-q', '-u', 'origin', 'main');
    const sys = { ...realSys(), env: { PATH: process.env.PATH ?? '' }, cwd: work, home: dir };
    assert.equal(await stopHook(sys, JSON.stringify({ cwd: work })), '');
    assert.equal(await stopHook(sys, JSON.stringify({ cwd: dir })), '');
    git('checkout', '-q', '-b', 'feature');
    writeFileSync(join(work, 'b'), 'b\n');
    git('add', 'b');
    git('commit', '-q', '-m', 'work');
    // origin is no GitHub repository, so the pull request is unknown and the stop goes through; unpushed it is held first.
    assert.equal(await stopHook(sys, JSON.stringify({ cwd: work })), '');
    const seen = capture();
    assert.equal(await keepGoing(sys, seen.io, ['--stop', 'proven', 'unneeded']), 0);
    assert.deepEqual(JSON.parse(readFileSync(join(work, STORE, 'stop-note.json'), 'utf8')).head, git('rev-parse', 'HEAD'));

    // A desktop session with every commit on a ready PR stops at every turn end, its own records not read as work
    // left, where the repository does not ignore .tmp/.
    rmSync(join(work, '.tmp'), { recursive: true, force: true });
    git('remote', 'set-url', 'origin', 'https://github.com/example-org/example-app.git');
    git('config', `url.${bare}.insteadOf`, 'https://github.com/example-org/example-app.git');
    git('push', '-q', '-u', 'origin', 'feature');
    mkdirSync(join(work, '.tmp/pr-autocreate'), { recursive: true });
    writeFileSync(join(work, '.tmp/pr-autocreate/feature-0.json'), '{}');
    const head = git('rev-parse', 'HEAD');
    const desktop = {
      ...sys,
      env: { ...sys.env, CLAUDE_CODE_ENTRYPOINT: 'claude-desktop', GH_TOKEN: 'ghp_shell' },
      http: () => Promise.resolve({ status: 200, json: [restPull({ head: { sha: head, repo: { full_name: 'example-org/example-app' } } })] }),
    };
    assert.equal(await stopHook(desktop, JSON.stringify({ cwd: work })), '');
    assert.equal(await stopHook(desktop, JSON.stringify({ cwd: work })), '');
    writeFileSync(join(work, 'b'), 'edited\n');
    assert.match(await stopHook(desktop, JSON.stringify({ cwd: work })), /PR 7 is open/);
  });
});
