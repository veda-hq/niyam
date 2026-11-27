import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AGENT, FakeSys, ROOT, capture } from './fake.test.ts';
import {
  CLOSED_EXIT,
  MERGED_EXIT,
  addCandidates,
  agreed,
  ciSignals,
  dedupe,
  excerpt,
  failureType,
  findingSignals,
  judge,
  newestRuns,
  normalizeBody,
  pollOf,
  prSignals,
  proxyThreads,
  readChecks,
  readFindings,
  readRules,
  restComments,
  signalArgs,
  signalSettings,
  threadSignals,
  unconfirmedFindings,
  verdictLine,
  type CheckRun,
  type Checks,
  type Judged,
  type Poll,
  type RawSignal,
  type Rules,
} from './pr-signals.ts';
import { connection, nextCursor, restList } from './pages.ts';

const REPO = '/repos/example-org/example-app';
const HEAD = 'a'.repeat(40);
/** GitHub Actions' app id, as a ruleset's integration_id names it. */
const ACTIONS = 15368;
const RULES = `${REPO}/rules/branches/main`;
/** The pull request #7 as GitHub gives it, open on HEAD. */
const OPEN = { state: 'open', merged_at: null, head: { sha: HEAD }, base: { ref: 'main' } };
/** The `ci` of the session's pull request: its one required check passed. */
const GREEN = { mergeable: 'clean', checkRuns: 1, actionsRuns: 1, verdict: 'green', required: [{ name: 'ci', conclusion: 'success' }], minimum: 'ruleset' };

describe('signalArgs', () => {
  it('reads a pull request number, with --ci-only anywhere', () => {
    assert.deepEqual(signalArgs(['7']), { pr: 7, ciOnly: false, wait: false, timeout: 60 });
    assert.deepEqual(signalArgs(['--ci-only', '#7']), { pr: 7, ciOnly: true, wait: false, timeout: 60 });
  });

  it('reads --wait, and --timeout in minutes with it, in any order', () => {
    assert.deepEqual(signalArgs(['7', '--wait']), { pr: 7, ciOnly: false, wait: true, timeout: 60 });
    assert.deepEqual(signalArgs(['7', '--wait', '--timeout', '9']), { pr: 7, ciOnly: false, wait: true, timeout: 9 });
    assert.deepEqual(signalArgs(['--timeout', '120', '--ci-only', '--wait', '7']), { pr: 7, ciOnly: true, wait: true, timeout: 120 });
  });

  for (const [args, message] of [
    [[], /needs a pull request number/],
    [['07'], /unexpected argument "07"/],
    [['7', '8'], /unexpected argument "8"/],
    [['7', '--ci-only', '--ci-only'], /unexpected argument "--ci-only"/],
    [['7', '--wait', '--wait'], /unexpected argument "--wait"/],
    [['7', '--wait', '--timeout', '9', '--timeout', '9'], /unexpected argument "--timeout"/],
    [['7', '--timeout', '9'], /^Error: --timeout goes with --wait$/],
    [['7', '--wait', '--timeout'], /^Error: --timeout takes whole minutes from 1, such as --timeout 9$/],
    [['7', '--wait', '--timeout', '0'], /^Error: --timeout takes whole minutes from 1/],
    [['7', '--wait', '--timeout', '09'], /^Error: --timeout takes whole minutes from 1/],
    [['7', '--wait', '--timeout', '1.5'], /^Error: --timeout takes whole minutes from 1/],
    [['7', '--wait', '--timeout', '9m'], /^Error: --timeout takes whole minutes from 1/],
    [['7', '--wait', '--timeout', 'x9'], /^Error: --timeout takes whole minutes from 1/],
    [['7', '--wait', '--timeout', '9'.repeat(20)], /^Error: --timeout takes whole minutes from 1/],
    [['7', '--wait', '--timeout', ' 9'], /^Error: --timeout takes whole minutes from 1/],
    [['7', '--wait', '--timeout', '9 '], /^Error: --timeout takes whole minutes from 1/],
  ] as const) {
    it(`refuses ${JSON.stringify(args)}`, () => assert.throws(() => signalArgs(args), message));
  }
});

describe('signalSettings', () => {
  it('reads the bots and findings file, and none named as none', () => {
    assert.deepEqual(signalSettings({ owner: 'o', agent: 'a' }), { bots: [] });
    assert.deepEqual(signalSettings(null), { bots: [] });
    assert.deepEqual(signalSettings({ signals: { bots: ['review-bot', 'other[bot]'], findings: '.tmp/review/findings.json' } }), {
      bots: ['review-bot', 'other[bot]'],
      findings: '.tmp/review/findings.json',
    });
    assert.deepEqual(signalSettings({ signals: {} }), { bots: [] });
    assert.deepEqual(signalSettings({ signals: { minCheckRuns: 1 } }), { bots: [], minCheckRuns: 1 });
    assert.deepEqual(signalSettings({ signals: { bots: [], minCheckRuns: 32 } }), { bots: [], minCheckRuns: 32 });
  });

  for (const [signals, message] of [
    [[], /"signals" must be an object/],
    ['x', /"signals" must be an object/],
    [null, /"signals" must be an object/],
    [{ bot: [] }, /unknown key "bot"; it takes "bots", "findings" and "minCheckRuns"/],
    [{ minCheckRuns: 0 }, /minCheckRuns must be a whole number from 1$/],
    [{ minCheckRuns: -2 }, /minCheckRuns must be a whole number from 1$/],
    [{ minCheckRuns: 1.5 }, /minCheckRuns must be a whole number from 1$/],
    [{ minCheckRuns: '3' }, /minCheckRuns must be a whole number from 1$/],
    [{ minCheckRuns: null }, /minCheckRuns must be a whole number from 1$/],
    [{ bots: 'review-bot' }, /bots must be a list of GitHub logins/],
    [{ bots: ['not a login'] }, /bots must be a list of GitHub logins/],
    [{ bots: [3] }, /bots must be a list of GitHub logins/],
    [{ findings: '/etc/passwd' }, /findings must be a path inside the repository/],
    [{ findings: '../x.json' }, /findings must be a path inside the repository/],
    [{ findings: '' }, /findings must be a path inside the repository/],
    [{ findings: 3 }, /findings must be a path inside the repository/],
  ] as const) {
    it(`refuses ${JSON.stringify(signals)}`, () => assert.throws(() => signalSettings({ signals }), message));
  }
});

describe('normalizeBody', () => {
  it('drops the markers that differ between where a finding was reported', () => {
    assert.equal(normalizeBody('[cubic] P1: The **limit**\n  is `wrong` severity: high'), 'the limit is wrong');
  });
});

const thread = (body: string, more: Partial<RawSignal> = {}): RawSignal => ({ source: 'review-thread', thread: 'PRRT_1', comment: 'PRRC_1', author: 'someone', file: 'src/a.ts', line: 3, body, ...more });
const local = (body: string, more: Partial<RawSignal> = {}): RawSignal => ({ source: 'local-findings', file: 'src/a.ts', line: 3, body, ...more });

describe('dedupe', () => {
  it('folds one concern at one line, keeping the thread, its sources and the severity', () => {
    const [one, ...rest] = dedupe([local('P1: Limit is wrong', { severity: 'P1' }), thread('limit is wrong')], []);
    assert.equal(rest.length, 0);
    assert.deepEqual(one, { ...thread('limit is wrong'), id: 'SIG-001', severity: 'P1', sources: ['local-findings', 'review-thread'], threads: [{ thread: 'PRRT_1', comment: 'PRRC_1' }] });
  });

  it("folds two bots' threads at one line into one signal that keeps both threads, the first one's ids its own", () => {
    const signals = dedupe(
      [
        local('Off-by-one in the loop bound'),
        thread('The limit is off by one.', { author: 'review-bot[bot]', thread: 'PRRT_a', comment: 'PRRC_a' }),
        thread('Loop bound exceeds the array.', { author: 'other-bot', thread: 'PRRT_b', comment: 'PRRC_b' }),
      ],
      ['review-bot', 'other-bot'],
    );
    assert.equal(signals.length, 1);
    const [one] = signals;
    assert.deepEqual([one?.thread, one?.comment, one?.author, one?.sources], ['PRRT_a', 'PRRC_a', 'review-bot[bot]', ['local-findings', 'review-thread']]);
    assert.deepEqual(one?.threads, [
      { thread: 'PRRT_a', comment: 'PRRC_a' },
      { thread: 'PRRT_b', comment: 'PRRC_b' },
    ]);
  });

  it('gives a lone thread its own one entry, a thread and a local finding one, and a signal with no thread none', () => {
    const [lone, folded, bare] = dedupe(
      [thread('a'), thread('b', { line: 9, author: 'review-bot', thread: 'PRRT_9', comment: 'PRRC_9' }), local('other', { line: 9 }), local('c', { line: 20 })],
      ['review-bot'],
    );
    assert.deepEqual(lone?.threads, [{ thread: 'PRRT_1', comment: 'PRRC_1' }]);
    assert.deepEqual([folded?.thread, folded?.comment, folded?.threads, folded?.sources], ['PRRT_9', 'PRRC_9', [{ thread: 'PRRT_9', comment: 'PRRC_9' }], ['review-thread', 'local-findings']]);
    assert.equal(bare?.threads, undefined);
    const [noComment] = dedupe([{ source: 'review-thread', thread: 'PRRT_x', file: null, line: null, body: 'x' }], []);
    assert.deepEqual(noComment?.threads, [{ thread: 'PRRT_x' }]);
  });

  it("folds a bot's thread and the local finding at one line, worded differently", () => {
    const signals = dedupe([thread('The limit is off by one.', { author: 'review-bot[bot]' }), local('Off-by-one in the loop bound')], ['review-bot']);
    assert.deepEqual(
      signals.map((s) => [s.id, s.source, s.sources]),
      [['SIG-001', 'review-thread', ['review-thread', 'local-findings']]],
    );
  });

  it("keeps apart different findings: another line, a person's thread, a pull-request-level bot finding", () => {
    const signals = dedupe(
      [
        thread('a', { author: 'someone' }),
        local('b'),
        local('c', { line: 9 }),
        thread('d', { author: 'review-bot', file: null, line: null }),
        local('e', { file: null, line: null }),
        { source: 'review-thread', thread: 'PRRT_2', file: 'src/a.ts', line: 9, body: 'f' },
      ],
      ['review-bot'],
    );
    assert.deepEqual(
      signals.map((s) => s.id),
      ['SIG-001', 'SIG-002', 'SIG-003', 'SIG-004', 'SIG-005', 'SIG-006'],
    );
  });

  it('keeps the first of two findings with no thread, and the thread of the first when both have one', () => {
    const [kept] = dedupe([local('same'), { source: 'ci-failure', file: 'src/a.ts', line: 3, body: 'same', severity: 'x' }], []);
    assert.deepEqual([kept?.source, kept?.severity, kept?.thread], ['local-findings', 'x', undefined]);
    const [first] = dedupe([thread('same', { thread: 'PRRT_a' }), thread('same', { thread: 'PRRT_b', comment: 'PRRC_b' })], []);
    assert.deepEqual([first?.thread, first?.comment, first?.threads], ['PRRT_a', 'PRRC_1', [{ thread: 'PRRT_a', comment: 'PRRC_1' }, { thread: 'PRRT_b', comment: 'PRRC_b' }]]);
    const [carried] = dedupe([local('same'), thread('same', { thread: 'PRRT_c' }), local('same')], []);
    assert.deepEqual([carried?.thread, carried?.sources, carried?.threads], ['PRRT_c', ['local-findings', 'review-thread'], [{ thread: 'PRRT_c', comment: 'PRRC_1' }]]);
  });
});

describe('addCandidates', () => {
  it('adds resolved threads nearby or alike, with the history of each file once', () => {
    const asked: string[] = [];
    const [near, alike, none] = addCandidates(
      dedupe([thread('a new concern here'), thread('the cache key misses the tenant id', { file: 'src/b.ts', line: 90 }), thread('unrelated', { file: null, line: null })], []),
      [
        { file: 'src/a.ts', line: 10, preview: 'something else entirely', createdAt: 't1' },
        { file: 'src/c.ts', line: 1, preview: 'cache key misses the tenant', createdAt: 't2' },
        { file: 'src/a.ts', line: 14, preview: 'too far away', createdAt: 't1' },
        { file: null, line: null, preview: 'short' },
      ],
      (file, since) => {
        asked.push(`${file}@${since}`);
        return file === 'src/c.ts' ? '' : 'diff --git a/src/a.ts';
      },
    );
    assert.deepEqual(near?.candidates, [{ file: 'src/a.ts', line: 10, preview: 'something else entirely', createdAt: 't1', matchedBy: 'proximity', diff: 'diff --git a/src/a.ts' }]);
    assert.deepEqual(alike?.candidates, [{ file: 'src/c.ts', line: 1, preview: 'cache key misses the tenant', createdAt: 't2', matchedBy: 'body' }]);
    assert.equal(none?.candidates, undefined);
    assert.deepEqual(asked, ['src/a.ts@t1', 'src/c.ts@t2']);
  });

  it('says both when a resolved thread is near and alike', () => {
    const [one] = addCandidates(dedupe([thread('the limit is wrong here')], []), [{ file: 'src/a.ts', line: 4, preview: 'the limit is wrong' }], () => '');
    assert.equal(one?.candidates?.[0]?.matchedBy, 'both');
  });
});

describe('readFindings', () => {
  it('tells a clean review from no review and from a failed one', () => {
    assert.deepEqual(readFindings(null), { status: 'absent', findings: [] });
    assert.deepEqual(readFindings('{"issues":[]}'), { status: 'ok', findings: [] });
    assert.deepEqual(readFindings('{}'), { status: 'ok', findings: [] });
    assert.deepEqual(readFindings('{"issues":[],"metadata":{"status":"failed","exit":137}}'), { status: 'failed', findings: [], reason: 'the review exited 137' });
    assert.deepEqual(readFindings('{"issues":[{"title":"t"}],"metadata":{"status":"failed","failureReason":"killed"}}'), { status: 'failed', findings: [{ title: 't' }], reason: 'killed' });
    assert.deepEqual(readFindings('{"metadata":{"status":"failed"}}'), { status: 'failed', findings: [], reason: 'the review exited non-zero' });
    assert.deepEqual(readFindings('not json'), { status: 'failed', findings: [], reason: 'the findings file is not JSON' });
  });
});

describe('unconfirmedFindings', () => {
  it("names each of a failed review's findings by its file, line and title", () => {
    assert.deepEqual(unconfirmedFindings([{ title: 't', file: ' src/a.ts ', line: 4 }, { description: 'd', path: 'src/b.ts' }, { title: '', description: 'e' }, {}]), [
      { file: 'src/a.ts', line: 4, title: 't' },
      { file: 'src/b.ts', line: null, title: 'd' },
      { file: null, line: null, title: 'e' },
      { file: null, line: null, title: '' },
    ]);
  });
});

describe('findingSignals', () => {
  it("keeps the pull request's findings and drops another branch's", () => {
    assert.deepEqual(
      findingSignals(
        [
          { title: 'Limit', description: 'is wrong', file: 'src/a.ts', line: 3, priority: 'P1' },
          { title: 'Old', path: 'src/gone.ts', line: 1 },
          { title: 'Whole PR', severity: 'P3' },
          { title: 'Blank path', file: '  ' },
        ],
        new Set(['src/a.ts']),
      ),
      {
        kept: [
          { source: 'local-findings', file: 'src/a.ts', line: 3, body: 'Limit — is wrong', severity: 'P1' },
          { source: 'local-findings', file: null, line: null, body: 'Whole PR', severity: 'P3' },
          { source: 'local-findings', file: null, line: null, body: 'Blank path' },
        ],
        dropped: 1,
      },
    );
  });
});

describe('excerpt and failureType', () => {
  it('keeps the error lines of a log, 40 at most', () => {
    assert.equal(excerpt('ok\nerror TS2322: no\nall good\n✗ failed test'), 'error TS2322: no\n✗ failed test');
    assert.equal(excerpt(Array.from({ length: 50 }, (_, i) => `error ${i}`).join('\n')).split('\n').length, 40);
    assert.equal(excerpt('2026-11-14T17:05:17.9145970Z ✗ #32 names no slice\n2026-11-14T17:05:17Z fine'), '✗ #32 names no slice');
  });

  it('names the kind of failure', () => {
    assert.deepEqual(
      ['error TS2322', 'eslint: no-unused', 'vitest: 1 failed', 'build failed', 'exit 1'].map(failureType),
      ['typecheck', 'lint', 'test', 'build', 'other'],
    );
  });
});

describe('threadSignals', () => {
  it('makes open threads signals and keeps resolved ones to compare with, skipping a thread with no comment', () => {
    assert.deepEqual(
      threadSignals([
        { id: 'PRRT_1', resolved: false, first: { id: 'PRRC_1', author: 'bot', body: 'Fix it', path: 'a.ts', line: 2, createdAt: 't' } },
        { id: 'PRRT_2', resolved: true, first: { id: 'PRRC_2', body: 'x'.repeat(300), path: null, line: null } },
        { id: 'PRRT_3', resolved: false },
      ]),
      {
        signals: [{ source: 'review-thread', thread: 'PRRT_1', comment: 'PRRC_1', body: 'Fix it', file: 'a.ts', line: 2, author: 'bot', createdAt: 't' }],
        resolved: [{ file: null, line: null, preview: 'x'.repeat(200) }],
      },
    );
  });
});

describe('pages', () => {
  it('reads a connection to its end, and refuses one that would end it early or never', async () => {
    const pages = [
      { nodes: [1], pageInfo: { hasNextPage: true, endCursor: 'c1' } },
      { nodes: null, pageInfo: { hasNextPage: true, endCursor: 'c2' } },
      { nodes: [2], pageInfo: { hasNextPage: false } },
    ];
    const asked: (string | null)[] = [];
    assert.deepEqual(
      await connection('the list', async (after) => {
        asked.push(after);
        return pages[asked.length - 1] ?? {};
      }),
      [1, 2],
    );
    assert.deepEqual(asked, [null, 'c1', 'c2']);
    assert.throws(() => nextCursor(null, undefined, 'the list'), /the list: a page did not say whether more follow/);
    assert.throws(() => nextCursor(null, { hasNextPage: 'yes' }, 'the list'), /did not say whether more follow/);
    assert.throws(() => nextCursor(null, { hasNextPage: true, endCursor: '' }, 'the list'), /more follow but gives no cursor/);
    assert.throws(() => nextCursor('c1', { hasNextPage: true, endCursor: 'c1' }, 'the list'), /gave back the cursor just read/);
    await assert.rejects(connection('the list', async () => ({ nodes: [], pageInfo: { hasNextPage: true, endCursor: String(Math.random()) } }), 3), /the list: more than 3 pages/);
  });

  it('reads a REST list to a short page, under a key when asked, and refuses any other answer', async () => {
    const sys = new FakeSys();
    sys.route('GET', `${REPO}/x?per_page=100&page=1`, { status: 200, json: Array.from({ length: 100 }, (_, i) => i) });
    sys.route('GET', `${REPO}/x?per_page=100&page=2`, { status: 200, json: [100] });
    assert.equal((await restList(sys, 't', 'repos/example-org/example-app/x')).length, 101);
    sys.route('GET', `${REPO}/y?a=1&per_page=100&page=1`, { status: 200, json: { runs: ['r'] } });
    assert.deepEqual(await restList(sys, 't', 'repos/example-org/example-app/y?a=1', 'runs'), ['r']);
    sys.route('GET', `${REPO}/z?per_page=100&page=1`, { status: 200, json: { runs: 'r' } });
    await assert.rejects(restList(sys, 't', 'repos/example-org/example-app/z', 'runs'), /cannot read repos\/example-org\/example-app\/z \(HTTP 200\)/);
    sys.route('GET', `${REPO}/z?per_page=100&page=1`, { status: 404, json: null });
    await assert.rejects(restList(sys, 't', 'repos/example-org/example-app/z'), /\(HTTP 404\)/);
    await assert.rejects(restList(sys, 't', 'repos/example-org/example-app/x', undefined, 1), /more than 1 pages/);
  });
});

/** A session reading pull request #7, open at HEAD, with what each test routes. */
function session(pull: Record<string, unknown> = {}): FakeSys {
  const sys = new FakeSys();
  sys.env = { NIYAM_AGENT: AGENT, GH_TOKEN: 'ghp_good' };
  sys.route('GET', `${REPO}/pulls/7`, { status: 200, json: { state: 'open', merged_at: null, head: { sha: HEAD }, base: { ref: 'main' }, mergeable_state: 'clean', ...pull } });
  sys.route('GET', `${REPO}/commits/${HEAD}/check-runs?per_page=100&page=1`, { status: 200, json: { check_runs: [{ id: 1, name: 'ci', status: 'completed', conclusion: 'success', app: { id: ACTIONS, slug: 'github-actions' } }] } });
  sys.route('GET', `${REPO}/commits/${HEAD}/status?per_page=100&page=1`, { status: 200, json: { statuses: [] } });
  sys.route('GET', `${RULES}?per_page=100&page=1`, { status: 200, json: [{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'ci', integration_id: ACTIONS }] } }] });
  sys.route('GET', `${REPO}/pulls/7/files?per_page=100&page=1`, { status: 200, json: [{ filename: 'src/a.ts' }] });
  sys.route('POST', '/graphql', () => ({
    status: 200,
    json: {
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              pageInfo: { hasNextPage: false },
              nodes: [
                { id: 'PRRT_open', isResolved: false, comments: { nodes: [{ id: 'PRRC_open', author: { login: 'review-bot' }, body: 'The limit is off by one.', path: 'src/a.ts', line: 3, createdAt: '2026-11-14T00:00:00Z' }] } },
                { id: 'PRRT_done', isResolved: true, comments: { nodes: [{ id: 'PRRC_done', author: null, body: 'Rename it.', path: 'src/a.ts', originalLine: 8, createdAt: '2026-11-13T00:00:00Z' }] } },
                { id: 'PRRT_empty', isResolved: false, comments: { nodes: [] } },
                { id: 'PRRT_bare', isResolved: false },
              ],
            },
          },
        },
      },
    },
  }));
  sys.files.set(`${ROOT}/.github/niyam.json`, JSON.stringify({ owner: 'example-owner', agent: AGENT, signals: { bots: ['review-bot'], findings: '.tmp/review/findings.json' } }));
  return sys;
}

async function run(sys: FakeSys, args: string[]): Promise<{ code: number; out: string[]; err: string[] }> {
  const { io, out, err } = capture();
  return { code: await prSignals(sys, io, args), out, err };
}

const parsed = (result: { out: string[] }): { signals: { id: string; source: string; sources: string[]; thread?: string; comment?: string; threads?: unknown[]; body: string; candidates?: unknown[] }[]; [key: string]: unknown } =>
  JSON.parse(result.out.join('\n')) as never;

describe('prSignals', () => {
  it("prints open threads, folding the bot's local copy into its thread, with resolved ones to compare with", async () => {
    const sys = session();
    sys.files.set(`${ROOT}/.tmp/review/findings.json`, JSON.stringify({ issues: [{ title: 'Off-by-one', file: 'src/a.ts', line: 3 }, { title: 'Stale', file: 'src/old.ts', line: 1 }] }));
    const result = await run(sys, ['7']);
    assert.equal(result.code, 0);
    const out = parsed(result);
    assert.deepEqual(
      out.signals.map((s) => [s.id, s.source, s.sources, s.thread, s.comment, s.threads]),
      [['SIG-001', 'review-thread', ['review-thread', 'local-findings'], 'PRRT_open', 'PRRC_open', [{ thread: 'PRRT_open', comment: 'PRRC_open' }]]],
    );
    assert.deepEqual(out.resolved, [{ file: 'src/a.ts', line: 8, preview: 'Rename it.', createdAt: '2026-11-13T00:00:00Z' }]);
    assert.deepEqual([out.ok, out.pr, out.cloud, out.duplicates, out.findings], [true, 7, false, 1, { status: 'ok', droppedOffDiff: 1 }]);
    assert.deepEqual(out.ci, GREEN);
    assert.equal(out.signals[0]?.candidates?.length, 1);
    assert.deepEqual(result.err, []);
    const query = sys.requests.find((r) => r.url.endsWith('/graphql'))?.body as { variables: Record<string, unknown> };
    assert.deepEqual(query.variables, { owner: 'example-org', name: 'example-app', pr: 7 });
  });

  it('refuses a merged pull request before reading anything, so a stale findings file makes no signal', async () => {
    const sys = session({ state: 'closed', merged_at: '2026-11-14T01:00:00Z' });
    sys.files.set(`${ROOT}/.tmp/review/findings.json`, JSON.stringify({ issues: [{ title: 'Stale', file: 'src/a.ts', line: 3 }] }));
    const result = await run(sys, ['7']);
    assert.equal(result.code, MERGED_EXIT);
    assert.deepEqual(result.err, ['✗ #7 merged at 2026-11-14T01:00:00Z; nothing to answer']);
    assert.deepEqual(parsed(result), { ok: false, reason: 'pr-not-open', pr: 7, state: 'MERGED', mergedAt: '2026-11-14T01:00:00Z', phase: 'start' } as never);
    assert.deepEqual(
      sys.requests.map((r) => r.url),
      [`https://api.github.com${REPO}/pulls/7`],
    );
  });

  it('refuses a closed pull request, and one that merged while its signals were read', async () => {
    const closed = await run(session({ state: 'closed' }), ['7']);
    assert.deepEqual([closed.code, closed.err], [CLOSED_EXIT, ['✗ #7 is closed without merging; nothing to answer']]);
    const sys = session();
    let reads = 0;
    sys.route('GET', `${REPO}/pulls/7`, () => ({ status: 200, json: { ...OPEN, state: reads++ ? 'closed' : 'open', merged_at: reads > 1 ? '2026-11-14T02:00:00Z' : null } }));
    const late = await run(sys, ['7']);
    assert.equal(late.code, MERGED_EXIT);
    assert.deepEqual(late.err, ['✗ #7 merged at 2026-11-14T02:00:00Z; nothing to answer (it changed while the signals were read)']);
    assert.equal((parsed(late) as { phase?: string }).phase, 'before-print');
  });

  it('refuses a page of threads that says more follow but gives no cursor', async () => {
    const sys = session();
    sys.route('POST', '/graphql', { status: 200, json: { data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: true, endCursor: null }, nodes: [] } } } } } });
    await assert.rejects(run(sys, ['7']), /the review threads of #7: a page says more follow but gives no cursor/);
  });

  it('throws when GitHub cannot show the pull request or its threads', async () => {
    const none = session();
    none.route('GET', `${REPO}/pulls/7`, { status: 404, json: null });
    await assert.rejects(run(none, ['7']), /cannot read pull request #7 in example-org\/example-app \(HTTP 404\)/);
    const missing = session();
    missing.route('POST', '/graphql', { status: 200, json: { data: { repository: { pullRequest: null } } } });
    await assert.rejects(run(missing, ['7']), /GitHub shows no pull request #7 in example-org\/example-app/);
    const refused = session();
    refused.route('POST', '/graphql', { status: 200, json: { data: null, errors: [{ message: 'Bad credentials' }] } });
    await assert.rejects(run(refused, ['7']), /GitHub refused to read the review threads of #7 \(HTTP 200: Bad credentials\)/);
    const forbidden = session();
    forbidden.route('POST', '/graphql', { status: 403, json: null });
    await assert.rejects(run(forbidden, ['7']), /\(HTTP 403\)$/);
  });

  it('says a failed local review failed, never that it found nothing', async () => {
    const sys = session();
    sys.files.set(`${ROOT}/.tmp/review/findings.json`, JSON.stringify({ issues: [], metadata: { status: 'failed', exit: 137 } }));
    const result = await run(sys, ['7']);
    assert.deepEqual(parsed(result).findings, { status: 'failed', reason: 'the review exited 137' });
    assert.deepEqual(result.err, ["⚠ the local review failed (the review exited 137): its findings are missing, so lean on the bots' threads"]);
    assert.ok(!sys.requests.some((r) => r.url.includes('/files')));
  });

  it("leaves a failed local review's findings out of signals, under findings.unconfirmed", async () => {
    const sys = session();
    sys.files.set(
      `${ROOT}/.tmp/review/findings.json`,
      JSON.stringify({ issues: [{ title: 'Off-by-one', file: 'src/a.ts', line: 3 }, { description: 'Stale cache', path: 'src/b.ts' }], metadata: { status: 'failed', failureReason: 'timed out' } }),
    );
    const result = await run(sys, ['7']);
    const out = parsed(result);
    assert.deepEqual(
      out.signals.map((s) => [s.source, s.sources, s.thread]),
      [['review-thread', ['review-thread'], 'PRRT_open']],
    );
    assert.equal(out.duplicates, 0);
    assert.deepEqual(out.findings, {
      status: 'failed',
      reason: 'timed out',
      unconfirmed: [
        { file: 'src/a.ts', line: 3, title: 'Off-by-one' },
        { file: 'src/b.ts', line: null, title: 'Stale cache' },
      ],
    });
    assert.deepEqual(result.err, [
      "⚠ the local review failed (timed out): its 2 finding(s) are left out of signals, under findings.unconfirmed; check whether each file and line changed since, and lean on the bots' threads",
    ]);
    assert.ok(!sys.requests.some((r) => r.url.includes('/files')));
  });

  it('reads no findings file when none is there or the settings name none', async () => {
    assert.deepEqual(parsed(await run(session(), ['7'])).findings, { status: 'absent' });
    const unnamed = session();
    unnamed.files.set(`${ROOT}/.github/niyam.json`, JSON.stringify({ owner: 'example-owner', agent: AGENT }));
    assert.equal(parsed(await run(unnamed, ['7'])).findings, undefined);
    const bare = session();
    bare.files.delete(`${ROOT}/.github/niyam.json`);
    assert.equal((await run(bare, ['7'])).code, 0);
  });

  it('with --ci-only reads the checks alone', async () => {
    const sys = session();
    sys.files.set(`${ROOT}/.tmp/review/findings.json`, JSON.stringify({ issues: [{ title: 'x', file: 'src/a.ts', line: 1 }] }));
    const out = parsed(await run(sys, ['7', '--ci-only']));
    assert.deepEqual([out.signals, out.resolved, out.findings, out.ci], [[], [], undefined, GREEN]);
    assert.ok(!sys.requests.some((r) => r.url.endsWith('/graphql')));
  });

  it('cuts a long file history short', async () => {
    const sys = session();
    sys.execOverride = (call) => (call.command === 'git' && call.args[0] === 'log' ? { code: 0, stdout: 'x'.repeat(5000), stderr: '' } : undefined);
    sys.route('POST', '/graphql', {
      status: 200,
      json: {
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                pageInfo: { hasNextPage: false },
                nodes: [
                  { id: 'PRRT_open', isResolved: false, comments: { nodes: [{ id: 'PRRC_open', body: 'Near.', path: 'src/a.ts', line: 3 }] } },
                  { id: 'PRRT_done', isResolved: true, comments: { nodes: [{ id: 'PRRC_done', body: 'Old.', path: 'src/a.ts', line: 4, createdAt: 't' }] } },
                ],
              },
            },
          },
        },
      },
    });
    const [candidate] = (parsed(await run(sys, ['7'])).signals[0]?.candidates ?? []) as { diff?: string }[];
    assert.equal(candidate?.diff, `${'x'.repeat(4000)}\n…[cut]`);
    sys.execOverride = (call) => (call.command === 'git' && call.args[0] === 'log' ? { code: 128, stdout: '', stderr: 'bad' } : undefined);
    const [none] = (parsed(await run(sys, ['7'])).signals[0]?.candidates ?? []) as { diff?: string }[];
    assert.equal(none?.diff, undefined);
  });

  it('refuses a session with no token', async () => {
    const sys = session();
    delete sys.env.GH_TOKEN;
    assert.deepEqual(await run(sys, ['7']), { code: 1, out: [], err: ['✗ this session has no token; run niyam doctor'] });
  });

  it('says a conflicted pull request runs no CI, so its empty list is not green', async () => {
    const sys = session({ mergeable_state: 'dirty' });
    sys.route('GET', `${REPO}/commits/${HEAD}/check-runs?per_page=100&page=1`, { status: 200, json: { check_runs: [] } });
    const result = await run(sys, ['7', '--ci-only']);
    assert.equal(result.code, 0);
    const out = parsed(result);
    assert.deepEqual([out.signals, out.ci], [[], { mergeable: 'dirty', checkRuns: 0, actionsRuns: 0, verdict: 'conflicted', required: [{ name: 'ci', conclusion: 'missing' }], minimum: 'ruleset' }]);
    assert.deepEqual(result.err, ['⚠ CI on #7 is conflicted: it has merge conflicts, so GitHub runs no pull_request workflows on it; merge the base and push before reading it as clear']);
  });

  it('says when a required check has no run on the head yet, though another app ran', async () => {
    const sys = session();
    sys.route('GET', `${REPO}/commits/${HEAD}/check-runs?per_page=100&page=1`, { status: 200, json: { check_runs: [{ id: 3, name: 'Cubic', status: 'completed', conclusion: 'success', app: { id: 9, slug: 'cubic' } }] } });
    const result = await run(sys, ['7', '--ci-only']);
    assert.equal(result.code, 0);
    assert.deepEqual(parsed(result).ci, { mergeable: 'clean', checkRuns: 1, actionsRuns: 0, verdict: 'short', required: [{ name: 'ci', conclusion: 'missing' }], minimum: 'ruleset' });
    assert.deepEqual(result.err, [`⚠ CI on #7 is short: the required "ci" has no run on ${HEAD}`]);
  });

  it("takes the later read's mergeable state, unless GitHub is still working it out", async () => {
    for (const [first, later, want] of [
      ['dirty', 'unknown', 'dirty'],
      [undefined, 'clean', 'clean'],
      ['clean', undefined, 'clean'],
      [undefined, undefined, null],
    ] as const) {
      const sys = session();
      let reads = 0;
      sys.route('GET', `${REPO}/pulls/7`, () => ({ status: 200, json: { ...OPEN, mergeable_state: reads++ ? later : first } }));
      const result = await run(sys, ['7', '--ci-only']);
      const ci = parsed(result).ci as { mergeable: unknown; verdict: unknown };
      assert.deepEqual([ci.mergeable, ci.verdict], [want, want === 'dirty' ? 'conflicted' : want === null ? 'pending' : 'green']);
      assert.equal(result.err.length, want === 'clean' ? 0 : 1);
    }
  });

  it("keeps the first read's mergeable state when a push moved the head while the checks were read", async () => {
    const sys = session();
    let reads = 0;
    sys.route('GET', `${REPO}/pulls/7`, () => (reads++ ? { status: 200, json: { ...OPEN, head: { sha: 'b'.repeat(40) }, mergeable_state: 'dirty' } } : { status: 200, json: { ...OPEN, mergeable_state: 'clean' } }));
    const result = await run(sys, ['7', '--ci-only']);
    assert.deepEqual(parsed(result).ci, GREEN);
    assert.deepEqual(result.err, []);
  });
});

/** What ciSignals found, without the checks it read. */
const withoutChecks = ({ signals, checkRuns, actionsRuns }: Awaited<ReturnType<typeof ciSignals>>): Record<string, unknown> => ({ signals, checkRuns, actionsRuns });

describe('ciSignals', () => {
  it("gives each failing check's error lines, from its job's log when GitHub Actions ran it", async () => {
    const sys = session();
    sys.route('GET', `${REPO}/commits/${HEAD}/check-runs?per_page=100&page=1`, {
      status: 200,
      json: {
        check_runs: [
          { id: 11, name: 'ci / test', conclusion: 'failure', app: { slug: 'github-actions' } },
          { id: 12, name: 'ci / lint', conclusion: 'success', app: { slug: 'github-actions' } },
          { id: 13, name: 'Cubic', conclusion: 'failure', app: { slug: 'cubic' }, output: { title: 'Review failed', summary: '' } },
          { id: 14, name: 'ci / build', conclusion: 'timed_out', app: { slug: 'github-actions' } },
          { id: 15, name: 'ci / pending', conclusion: null, app: { slug: 'github-actions' } },
        ],
      },
    });
    sys.route('GET', `${REPO}/actions/jobs/11/logs`, { status: 200, json: null, text: 'setup\nerror TS2322: wrong type\ndone' });
    sys.route('GET', `${REPO}/actions/jobs/14/logs`, { status: 410, json: null });
    sys.route('GET', `${REPO}/commits/${HEAD}/status?per_page=100&page=1`, {
      status: 200,
      json: { statuses: [{ context: 'deploy', state: 'error', description: 'build failed' }, { context: 'other', state: 'success' }] },
    });
    assert.deepEqual(withoutChecks(await ciSignals(sys, 't', 'example-org/example-app', HEAD)), {
      signals: [
        { source: 'ci-failure', check: 'ci / test', file: null, line: null, body: 'error TS2322: wrong type', failureType: 'typecheck' },
        { source: 'ci-failure', check: 'Cubic', file: null, line: null, body: 'Cubic: failure\nReview failed', failureType: 'other' },
        { source: 'ci-failure', check: 'ci / build', file: null, line: null, body: 'ci / build: timed_out', failureType: 'build' },
        { source: 'ci-failure', check: 'deploy', file: null, line: null, body: 'deploy: error\nbuild failed', failureType: 'build' },
      ],
      checkRuns: 5,
      actionsRuns: 4,
    });
    assert.equal(sys.requests.find((r) => r.url.endsWith('/jobs/11/logs'))?.token, 't');
  });

  it('never lets a pass of the same name hide a failure, and folds one failure reported twice', async () => {
    const sys = session();
    sys.route('GET', `${REPO}/commits/${HEAD}/check-runs?per_page=100&page=1`, {
      status: 200,
      json: {
        check_runs: [
          { id: 21, name: 'Work rules', conclusion: 'failure', app: { slug: 'github-actions' } },
          { id: 22, name: 'Work rules', conclusion: 'failure', app: { slug: 'github-actions' } },
          { id: 23, name: 'Work rules', conclusion: 'success', app: { slug: 'github-actions' } },
        ],
      },
    });
    sys.route('GET', `${REPO}/actions/jobs/21/logs`, { status: 200, json: null, text: '2026-11-14T17:05:12.8364488Z ✗ #7 names no slice' });
    sys.route('GET', `${REPO}/actions/jobs/22/logs`, { status: 200, json: null, text: '2026-11-14T17:05:17.9145970Z ✗ #7 names no slice' });
    const failures = (await ciSignals(sys, 't', 'example-org/example-app', HEAD)).signals;
    assert.deepEqual(
      failures.map((s) => s.body),
      ['✗ #7 names no slice', '✗ #7 names no slice'],
    );
    assert.equal(dedupe(failures, []).length, 1);
  });

  it('keeps the name when a log has no error lines, and refuses a check it cannot read', async () => {
    const sys = session();
    sys.route('GET', `${REPO}/commits/${HEAD}/check-runs?per_page=100&page=1`, { status: 200, json: { check_runs: [{ id: 11, name: 'ci', conclusion: 'cancelled', app: { slug: 'github-actions' } }] } });
    sys.route('GET', `${REPO}/actions/jobs/11/logs`, { status: 200, json: null });
    assert.deepEqual((await ciSignals(sys, 't', 'example-org/example-app', HEAD)).signals.map((s) => s.body), ['ci: cancelled']);
    sys.route('GET', `${REPO}/commits/${HEAD}/check-runs?per_page=100&page=1`, { status: 200, json: { check_runs: [{ name: 'no id' }] } });
    await assert.rejects(ciSignals(sys, 't', 'example-org/example-app', HEAD), /lists a check run with no id or name/);
    sys.route('GET', `${REPO}/commits/${HEAD}/check-runs?per_page=100&page=1`, { status: 200, json: { check_runs: [] } });
    sys.route('GET', `${REPO}/commits/${HEAD}/status?per_page=100&page=1`, { status: 200, json: { statuses: [{ context: 'x' }] } });
    await assert.rejects(ciSignals(sys, 't', 'example-org/example-app', HEAD), /lists a status with no name or state/);
  });
});

describe('prSignals in a Claude cloud session', () => {
  /** The proxy's routes for #7: thread 123 open with a reply, 130 resolved, 140 whose comment is gone. */
  function cloud(): FakeSys {
    const sys = session();
    sys.env.CLAUDE_CODE_REMOTE = 'true';
    sys.route('POST', '/graphql', { status: 403, json: { message: 'GraphQL is refused' } });
    sys.route('GET', `${REPO}/pulls/7/comments?per_page=100&page=1`, {
      status: 200,
      json: [
        { id: 123, user: { login: 'review-bot[bot]' }, body: 'The limit is off by one.', path: 'src/a.ts', original_line: 3, created_at: '2026-11-14T00:00:00Z' },
        { id: 124, in_reply_to_id: 123, user: { login: AGENT }, body: 'Looking.' },
        { id: 130, body: 'Rename it.', path: 'src/a.ts', line: 30 },
      ],
    });
    sys.route('GET', `${REPO}/pulls/7/ccr/review_threads`, {
      status: 200,
      json: [
        { resolved: false, comment_ids: [123, 124] },
        { resolved: true, comment_ids: [130] },
        { resolved: false, comment_ids: [140] },
      ],
    });
    return sys;
  }

  it("reads the threads over the proxy's REST routes, naming each by its first comment's number", async () => {
    const sys = cloud();
    const out = parsed(await run(sys, ['7']));
    assert.equal(out.cloud, true);
    assert.deepEqual(
      out.signals.map((s) => [s.source, s.thread, s.comment, s.body]),
      [['review-thread', '123', '123', 'The limit is off by one.']],
    );
    assert.deepEqual(out.resolved, [{ file: 'src/a.ts', line: 30, preview: 'Rename it.' }]);
    assert.ok(!sys.requests.some((r) => r.url.endsWith('/graphql')));
    const [signal] = out.signals as unknown as { author?: string; createdAt?: string }[];
    assert.deepEqual([signal?.author, signal?.createdAt], ['review-bot[bot]', '2026-11-14T00:00:00Z']);
    assert.ok(sys.requests.filter((r) => r.url.includes('/ccr/')).every((r) => r.token === 'ghp_good'));
  });

  it('refuses a thread list or comment it cannot read', async () => {
    const bad = cloud();
    bad.route('GET', `${REPO}/pulls/7/ccr/review_threads`, { status: 200, json: [{ resolved: false, comment_ids: [] }] });
    await assert.rejects(run(bad, ['7']), /ccr\/review_threads lists a thread it does not name/);
    const down = cloud();
    down.route('GET', `${REPO}/pulls/7/ccr/review_threads`, { status: 502, json: null });
    await assert.rejects(run(down, ['7']), /cannot read repos\/example-org\/example-app\/pulls\/7\/ccr\/review_threads \(HTTP 502\)/);
    const nameless = cloud();
    nameless.route('GET', `${REPO}/pulls/7/comments?per_page=100&page=1`, { status: 200, json: [{ body: 'no id' }] });
    await assert.rejects(run(nameless, ['7']), /a review comment on #7 has no id/);
  });
});

describe('pr-signals at the edges', () => {
  it('reads only a bare number from 1, of any length', () => {
    assert.deepEqual(signalArgs(['17']), { pr: 17, ciOnly: false, wait: false, timeout: 60 });
    for (const arg of ['7x', 'x7', '#', '-7']) assert.throws(() => signalArgs([arg]), { message: `unexpected argument "${arg}"` });
  });

  it('reads settings that are not an object as none, and a bot only as a whole login', () => {
    assert.deepEqual(signalSettings('x'), { bots: [] });
    assert.deepEqual(signalSettings(undefined), { bots: [] });
    assert.throws(() => signalSettings({ signals: { bots: ['a[bot]b'] } }), /bots must be a list of GitHub logins/);
    assert.deepEqual(signalSettings({ signals: { findings: 'review/' } }), { bots: [], findings: 'review/' });
  });

  it('drops every marker, however it is written, and only where it is a word', () => {
    assert.equal(normalizeBody('[a] x [b] P2 fix p3:y'), 'x fix y');
    assert.equal(normalizeBody('top1 and p12 stay'), 'top1 and p12 stay');
    assert.equal(normalizeBody('severity high a severity:low b severity : mid c severities stay xseverity: d'), 'a b c severities stay xseverity: d');
    assert.equal(normalizeBody('a_b ~c >d #e'), 'a b c d e');
  });

  it("folds a bot's thread and a local finding at a file with no line only on the same body, keeping the winner's severity", () => {
    assert.equal(dedupe([thread('one', { author: 'review-bot', line: null }), local('two', { line: null })], ['review-bot']).length, 2);
    const [one] = dedupe([local('same', { severity: 'P2' }), thread('same', { severity: 'P1' })], []);
    assert.equal(one?.severity, 'P1');
  });

  it('takes a resolved thread as near only with both lines known, within ten lines', () => {
    const resolved = [
      { file: 'src/a.ts', line: 13, preview: 'p13' },
      { file: 'src/a.ts', line: 14, preview: 'p14' },
      { file: 'src/a.ts', line: 5, preview: 'p5' },
      { file: 'src/a.ts', line: null, preview: 'pnull' },
      { file: null, line: 3, preview: 'nofile' },
    ];
    const [atLine, noLine, noFile] = addCandidates(dedupe([thread('x'), thread('y', { line: null }), thread('z', { file: null })], []), resolved, () => '');
    assert.deepEqual(atLine?.candidates, [
      { file: 'src/a.ts', line: 13, preview: 'p13', matchedBy: 'proximity' },
      { file: 'src/a.ts', line: 5, preview: 'p5', matchedBy: 'proximity' },
    ]);
    assert.equal(noLine?.candidates, undefined);
    assert.equal(noFile?.candidates, undefined);
  });

  it('takes a resolved thread as alike when either body holds the other, from 12 characters', () => {
    const resolved = [
      { file: 'src/z.ts', line: 50, preview: 'The cache key misses the tenant id' },
      { file: 'src/z.ts', line: 60, preview: 'twelve chars' },
    ];
    const [shorter, exact] = addCandidates(dedupe([thread('cache key misses', { file: 'src/x.ts' }), thread('twelve chars', { file: 'src/y.ts' })], []), resolved, () => '');
    assert.deepEqual(shorter?.candidates, [{ ...resolved[0], matchedBy: 'body' }]);
    assert.deepEqual(exact?.candidates, [{ ...resolved[1], matchedBy: 'body' }]);
  });

  it("reads a file's history once for two signals near one thread, and none for a thread with no time", () => {
    const asked: string[] = [];
    const signals = addCandidates(
      dedupe([thread('x'), thread('y', { line: 4 })], []),
      [
        { file: 'src/a.ts', line: 3, preview: 'p', createdAt: 't' },
        { file: 'src/a.ts', line: 5, preview: 'q' },
      ],
      (file, since) => {
        asked.push(`${file}@${since}`);
        return 'd';
      },
    );
    for (const signal of signals) {
      assert.deepEqual(signal.candidates, [
        { file: 'src/a.ts', line: 3, preview: 'p', createdAt: 't', matchedBy: 'proximity', diff: 'd' },
        { file: 'src/a.ts', line: 5, preview: 'q', matchedBy: 'proximity' },
      ]);
    }
    assert.deepEqual(asked, ['src/a.ts@t']);
  });

  it('reads a findings file of null, or with no metadata, as a clean review', () => {
    assert.deepEqual(readFindings('null'), { status: 'ok', findings: [] });
    assert.deepEqual(readFindings('{"metadata":null}'), { status: 'ok', findings: [] });
  });

  it('keeps every kind of error line, and strips only a leading log time', () => {
    assert.equal(excerpt(['Fail here', '✖ one', '✘ two', 'cannot x', 'missing y', 'expected z', 'ERROR up', 'fine'].join('\n')), ['Fail here', '✖ one', '✘ two', 'cannot x', 'missing y', 'expected z', 'ERROR up'].join('\n'));
    assert.equal(excerpt('2026-11-14T17:05:17Z error a\n2026-11-14T17:05:17.12Z error b\nat 2026-11-14T17:05:17Z error c'), 'error a\nerror b\nat 2026-11-14T17:05:17Z error c');
  });

  it('names each kind of failure by any of its words', () => {
    assert.deepEqual(
      ['tsc exited', 'type error', 'ts123', 'lint found', 'jest', 'expect(x)', 'compile', 'bundling', 'ts12'].map(failureType),
      ['typecheck', 'typecheck', 'typecheck', 'lint', 'test', 'test', 'build', 'build', 'other'],
    );
  });

  it('reads every review comment over REST as it is, and refuses one with no whole id', async () => {
    const sys = new FakeSys();
    sys.route('GET', `${REPO}/pulls/7/comments?per_page=100&page=1`, {
      status: 200,
      json: [
        { id: 5, in_reply_to_id: 0, user: null, body: 3, path: 4, line: 'x', original_line: 'y', created_at: 9 },
        { id: 6, in_reply_to_id: 5, user: { login: 'u' }, body: 'b', path: 'p', line: 2, original_line: 1, created_at: 't' },
      ],
    });
    assert.deepEqual(await restComments(sys, 't', 'example-org/example-app', 7), [
      { id: 5, inReplyTo: null, body: '', path: null, line: null },
      { id: 6, inReplyTo: 5, author: 'u', body: 'b', path: 'p', line: 2, createdAt: 't' },
    ]);
    for (const bad of [null, { id: 0 }, { id: 1.5 }, { id: '5' }]) {
      sys.route('GET', `${REPO}/pulls/7/comments?per_page=100&page=1`, { status: 200, json: [bad] });
      await assert.rejects(restComments(sys, 't', 'example-org/example-app', 7), /a review comment on #7 has no id/, JSON.stringify(bad));
    }
  });

  it("reads the proxy's thread list as it is, and refuses one it cannot read", async () => {
    const route = `${REPO}/pulls/7/ccr/review_threads`;
    const sys = new FakeSys().route('GET', route, { status: 200, json: [{ resolved: true, comment_ids: [1, 2] }] });
    assert.deepEqual(await proxyThreads(sys, 't', 'example-org/example-app', 7), [{ resolved: true, comments: [1, 2] }]);
    sys.route('GET', route, { status: 200, json: {} });
    await assert.rejects(proxyThreads(sys, 't', 'example-org/example-app', 7), /cannot read repos\/example-org\/example-app\/pulls\/7\/ccr\/review_threads \(HTTP 200\)/);
    for (const bad of [null, { comment_ids: [1] }, { resolved: false, comment_ids: '1' }, { resolved: false, comment_ids: [0] }]) {
      sys.route('GET', route, { status: 200, json: [bad] });
      await assert.rejects(proxyThreads(sys, 't', 'example-org/example-app', 7), /lists a thread it does not name/, JSON.stringify(bad));
    }
  });

  it("names a failing check by its conclusion when GitHub Actions did not run it or its log is gone, and refuses entries it cannot read", async () => {
    const sys = session();
    sys.route('GET', `${REPO}/commits/${HEAD}/check-runs?per_page=100&page=1`, {
      status: 200,
      json: {
        check_runs: [
          { id: 5, name: 'x', conclusion: 'startup_failure', app: null },
          { id: 6, name: 'y', conclusion: 'failure', app: { slug: 'github-actions' } },
        ],
      },
    });
    sys.route('GET', `${REPO}/actions/jobs/6/logs`, { status: 410, json: null, text: 'error x' });
    assert.deepEqual(withoutChecks(await ciSignals(sys, 't', 'example-org/example-app', HEAD)), {
      signals: [
        { source: 'ci-failure', check: 'x', file: null, line: null, body: 'x: startup_failure', failureType: 'other' },
        { source: 'ci-failure', check: 'y', file: null, line: null, body: 'y: failure', failureType: 'other' },
      ],
      checkRuns: 2,
      actionsRuns: 1,
    });
    for (const bad of [null, { id: 5 }]) {
      sys.route('GET', `${REPO}/commits/${HEAD}/check-runs?per_page=100&page=1`, { status: 200, json: { check_runs: [bad] } });
      await assert.rejects(ciSignals(sys, 't', 'example-org/example-app', HEAD), /lists a check run with no id or name/);
    }
    sys.route('GET', `${REPO}/commits/${HEAD}/check-runs?per_page=100&page=1`, { status: 200, json: { check_runs: [] } });
    sys.route('GET', `${REPO}/commits/${HEAD}/status?per_page=100&page=1`, { status: 200, json: { statuses: [null] } });
    await assert.rejects(ciSignals(sys, 't', 'example-org/example-app', HEAD), /lists a status with no name or state/);
  });

  it('refuses a pull request GitHub answers other than 200 or without its state, head and base', async () => {
    for (const [status, json] of [
      [500, OPEN],
      [200, {}],
      [200, { state: 'open', base: { ref: 'main' } }],
      [200, { state: 'open', head: { sha: HEAD } }],
      [200, { ...OPEN, base: { ref: 7 } }],
    ] as const) {
      const sys = session();
      sys.route('GET', `${REPO}/pulls/7`, { status, json });
      await assert.rejects(run(sys, ['7']), new RegExp(`^Error: cannot read pull request #7 in example-org/example-app \\(HTTP ${status}\\)$`));
    }
  });

  it('refuses threads GitHub gives with errors beside its data, or with no body', async () => {
    const partial = session();
    partial.route('POST', '/graphql', { status: 200, json: { data: { repository: null }, errors: [{ message: 'partial' }] } });
    await assert.rejects(run(partial, ['7']), /GitHub refused to read the review threads of #7 \(HTTP 200: partial\)/);
    const empty = session();
    empty.route('POST', '/graphql', { status: 200, json: null });
    await assert.rejects(run(empty, ['7']), /GitHub refused to read the review threads of #7 \(HTTP 200\)$/);
  });

  it('reads every page of threads, a comment with no body, path or line as such', async () => {
    const sys = session();
    const pages = [
      { pageInfo: { hasNextPage: true, endCursor: 'c1' }, nodes: [{ id: 'PRRT_a', isResolved: false, comments: { nodes: [{ id: 'PRRC_a' }] } }] },
      { pageInfo: { hasNextPage: false }, nodes: [{ id: 'PRRT_b', isResolved: false, comments: {} }] },
    ];
    let page = 0;
    sys.route('POST', '/graphql', () => ({ status: 200, json: { data: { repository: { pullRequest: { reviewThreads: pages[page++] } } } } }));
    const out = parsed(await run(sys, ['7']));
    assert.deepEqual(out.signals, [{ source: 'review-thread', thread: 'PRRT_a', comment: 'PRRC_a', body: '', file: null, line: null, sources: ['review-thread'], threads: [{ thread: 'PRRT_a', comment: 'PRRC_a' }], id: 'SIG-001' }]);
    assert.deepEqual(
      sys.requests.filter((r) => r.url.endsWith('/graphql')).map((r) => (r.body as { variables: Record<string, unknown> }).variables),
      [
        { owner: 'example-org', name: 'example-app', pr: 7 },
        { owner: 'example-org', name: 'example-app', pr: 7, after: 'c1' },
      ],
    );
  });

  it('says nothing dropped when every finding is on the diff, and lists no files for an empty review', async () => {
    const kept = session();
    kept.files.set(`${ROOT}/.tmp/review/findings.json`, JSON.stringify({ issues: [{ title: 'x', file: 'src/a.ts', line: 1 }] }));
    kept.route('GET', `${REPO}/pulls/7/files?per_page=100&page=1`, { status: 200, json: [null, { filename: 'src/a.ts' }] });
    const out = parsed(await run(kept, ['7']));
    assert.deepEqual(out.findings, { status: 'ok' });
    assert.ok(out.signals.some((s) => s.sources.includes('local-findings')));
    const empty = session();
    empty.files.set(`${ROOT}/.tmp/review/findings.json`, JSON.stringify({ issues: [] }));
    assert.deepEqual(parsed(await run(empty, ['7'])).findings, { status: 'ok' });
    assert.ok(!empty.requests.some((r) => r.url.includes('/files')));
  });

  it("reads a resolved thread's file history since it opened, whole up to 4000 characters", async () => {
    const sys = session();
    const calls: { args: readonly string[]; cwd?: string }[] = [];
    sys.execOverride = (call) => {
      if (call.command !== 'git' || call.args[0] !== 'log') return undefined;
      calls.push({ args: call.args, ...(call.cwd ? { cwd: call.cwd } : {}) });
      return { code: 0, stdout: 'x'.repeat(4000), stderr: '' };
    };
    const [candidate] = (parsed(await run(sys, ['7'])).signals[0]?.candidates ?? []) as { diff?: string }[];
    assert.equal(candidate?.diff, 'x'.repeat(4000));
    assert.deepEqual(calls, [{ args: ['log', '-p', '--after=2026-11-13T00:00:00Z', '--', 'src/a.ts'], cwd: ROOT }]);
  });
});

describe('pr-signals, as GitHub answers', () => {
  it('drops each marker as a space, so the words around it stay apart', () => {
    assert.equal(normalizeBody('a[b]c'), 'a c');
    assert.equal(normalizeBody('x:p1:y'), 'x: y');
    assert.equal(normalizeBody('x:severity:high:y'), 'x: :y');
  });

  it("folds only a bot's own login at one place, and no other source with an author", () => {
    assert.equal(dedupe([thread('one', { author: 'review[bot]-bot' }), local('two')], ['review-bot']).length, 2, 'only a trailing [bot] marks a bot');
    assert.equal(dedupe([{ source: 'ci-failure', file: 'src/a.ts', line: 3, author: 'review-bot', body: 'one' }, local('two')], ['review-bot']).length, 2);
    assert.equal(dedupe([thread('one', { author: 'review-bot', file: null }), local('two', { file: null })], ['review-bot']).length, 2);
    assert.equal(dedupe([thread('same'), thread('same', { line: 9 })], []).length, 2);
    assert.equal(dedupe([thread('same'), thread('same', { file: 'src/b.ts' })], []).length, 2);
  });

  it('reads the pull request with the session token, and refuses one with no state, or no body', async () => {
    for (const json of [null, { head: { sha: HEAD } }]) {
      const sys = session();
      sys.route('GET', `${REPO}/pulls/7`, { status: 200, json });
      await assert.rejects(run(sys, ['7']), /^Error: cannot read pull request #7 in example-org\/example-app \(HTTP 200\)$/, JSON.stringify(json));
    }
    const sys = session();
    await run(sys, ['7', '--ci-only']);
    const reads = sys.requests.filter((r) => r.url.endsWith('/pulls/7'));
    assert.equal(reads.length, 2);
    assert.ok(reads.every((r) => r.token === 'ghp_good'));
  });

  it('says a closed pull request in full, with no merge time as null', async () => {
    const result = await run(session({ state: 'closed', merged_at: undefined }), ['7']);
    assert.deepEqual(parsed(result), { ok: false, reason: 'pr-not-open', pr: 7, state: 'CLOSED', mergedAt: null, phase: 'start' } as never);
  });

  it('asks GitHub for the threads in one query', async () => {
    const sys = session();
    await run(sys, ['7']);
    const query = (sys.requests.find((r) => r.url.endsWith('/graphql'))?.body as { query: string }).query;
    assert.equal(
      query,
      'query($owner: String!, $name: String!, $pr: Int!, $after: String) { repository(owner: $owner, name: $name) { pullRequest(number: $pr) { reviewThreads(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { id isResolved comments(first: 1) { nodes { id author { login } body path line originalLine createdAt } } } } } } }',
    );
  });

  it('refuses threads GitHub answers other than 200 though it gives data, or with no data, saying its error when it gives one', async () => {
    const data = { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] } } } };
    for (const [status, json] of [
      [403, { data }],
      [200, { data: null }],
      [200, { data: null, errors: [] }],
      [200, { data: null, errors: [{}] }],
    ] as const) {
      const sys = session();
      sys.route('POST', '/graphql', { status, json });
      await assert.rejects(run(sys, ['7']), new RegExp(`^Error: GitHub refused to read the review threads of #7 \\(HTTP ${status}\\)$`), JSON.stringify(json));
    }
    const nobody = session();
    nobody.route('POST', '/graphql', { status: 200, json: { data: { repository: null } } });
    await assert.rejects(run(nobody, ['7']), /^Error: GitHub shows no pull request #7 in example-org\/example-app$/);
  });

  it("takes a review comment's original line when it has no line now", async () => {
    const sys = new FakeSys().route('GET', `${REPO}/pulls/7/comments?per_page=100&page=1`, { status: 200, json: [{ id: 7, original_line: 3 }] });
    assert.deepEqual(await restComments(sys, 't', 'example-org/example-app', 7), [{ id: 7, inReplyTo: null, body: '', path: null, line: 3 }]);
  });

  it("reads the proxy's thread list with the token, and refuses any answer but 200, or a thread whose every comment it cannot name", async () => {
    const route = `${REPO}/pulls/7/ccr/review_threads`;
    const sys = new FakeSys().route('GET', route, { status: 200, json: [] });
    assert.deepEqual(await proxyThreads(sys, 'tok', 'example-org/example-app', 7), []);
    assert.equal(sys.requests.at(-1)?.token, 'tok');
    sys.route('GET', route, { status: 502, json: [] });
    await assert.rejects(proxyThreads(sys, 't', 'example-org/example-app', 7), /\(HTTP 502\)$/);
    sys.route('GET', route, { status: 200, json: [{ resolved: false, comment_ids: [1, 0] }] });
    await assert.rejects(proxyThreads(sys, 't', 'example-org/example-app', 7), /lists a thread it does not name/);
  });

  it('words a failing check from its text parts alone, and asks a log only of GitHub Actions, as text', async () => {
    const sys = session();
    sys.route('GET', `${REPO}/commits/${HEAD}/check-runs?per_page=100&page=1`, {
      status: 200,
      json: {
        check_runs: [
          { id: 31, name: 'x', conclusion: 'failure', app: { slug: 'other' }, output: { title: 5, summary: 'S' } },
          { id: 32, name: 'y', conclusion: 'failure', app: { slug: 'github-actions' } },
        ],
      },
    });
    sys.route('GET', `${REPO}/actions/jobs/32/logs`, { status: 200, json: null, text: 'error z' });
    sys.route('GET', `${REPO}/commits/${HEAD}/status?per_page=100&page=1`, {
      status: 200,
      json: { statuses: [{ context: 'd', state: 'failure', description: '' }, { context: 'e', state: 'error', description: 5 }] },
    });
    const http = sys.http.bind(sys);
    const asked: { url: string; options: unknown }[] = [];
    sys.http = (url, options) => {
      asked.push({ url, options });
      return http(url, options);
    };
    assert.deepEqual(
      (await ciSignals(sys, 't', 'example-org/example-app', HEAD)).signals.map((s) => s.body),
      ['x: failure\nS', 'error z', 'd: failure', 'e: error'],
    );
    assert.deepEqual(
      asked.filter((one) => one.url.includes('/logs')),
      [{ url: `https://api.github.com${REPO}/actions/jobs/32/logs`, options: { token: 't', text: true } }],
    );
  });

  it('reads no history from a git log that failed, whatever it printed', async () => {
    const sys = session();
    sys.execOverride = (call) => (call.command === 'git' && call.args[0] === 'log' ? { code: 1, stdout: 'partial', stderr: 'bad' } : undefined);
    const [candidate] = (parsed(await run(sys, ['7'])).signals[0]?.candidates ?? []) as { diff?: string }[];
    assert.ok(candidate);
    assert.equal(candidate.diff, undefined);
  });
});

/** A check run that GitHub Actions ran and finished, unless `more` says otherwise. */
const runOf = (id: number, name: string, conclusion: string | null, more: Partial<CheckRun> = {}): CheckRun => ({ id, name, app: ACTIONS, actions: true, status: 'completed', conclusion, ...more });
const CI: Rules = { required: [{ context: 'ci', app: ACTIONS }] };
const NONE: Rules = { required: [] };
const checksOf = (runs: CheckRun[], statuses: Checks['statuses'] = []): Checks => ({ runs, statuses });
/** The verdict alone. */
const verdictOf = (runs: CheckRun[], rules: Rules = CI, mergeable: string | null = 'clean', min?: number, statuses: Checks['statuses'] = []): string => judge(checksOf(runs, statuses), rules, mergeable, min).verdict;

describe('judge', () => {
  it('is green when every required check passed on its newest run, with what it judged by', () => {
    assert.deepEqual(judge(checksOf([runOf(1, 'ci', 'success'), runOf(2, 'other', 'failure')]), CI, 'clean'), {
      verdict: 'green',
      required: [{ name: 'ci', conclusion: 'success' }],
      minimum: 'ruleset',
      failing: [],
      running: [],
      missing: [],
      counted: 2,
      floor: 0,
    } satisfies Judged);
  });

  it('judges in order: unjudged, conflicted, failed, pending, short, green', () => {
    const failed = runOf(1, 'ci', 'failure');
    const going = runOf(2, 'lint', null, { status: 'in_progress' });
    assert.equal(verdictOf([failed, going], { unread: 'HTTP 403' }, 'dirty'), 'unjudged');
    assert.equal(verdictOf([failed, going], CI, 'dirty'), 'conflicted');
    assert.equal(verdictOf([failed, going], CI, 'unknown'), 'failed');
    assert.equal(verdictOf([going], CI, 'clean'), 'pending');
    assert.equal(verdictOf([runOf(3, 'lint', 'success')], CI, 'clean'), 'short');
    const both: Rules = { required: [{ context: 'ci', app: ACTIONS }, { context: 'build' }] };
    assert.deepEqual(judge(checksOf([runOf(5, 'ci', 'success')]), both, 'clean').verdict, 'short');
    assert.equal(verdictOf([runOf(4, 'ci', 'success')], CI, 'blocked'), 'green');
  });

  it('says why it is unjudged, and judges no required check then', () => {
    assert.deepEqual(judge(checksOf([runOf(1, 'ci', 'success')]), { unread: 'cannot read it (HTTP 403)' }, 'clean'), {
      verdict: 'unjudged',
      required: [],
      minimum: 'default',
      reason: 'cannot read it (HTTP 403)',
      failing: [],
      running: [],
      missing: [],
      counted: 1,
      floor: 1,
    } satisfies Judged);
  });

  it('lets the newest run of a name decide, by its id wherever it is listed', () => {
    assert.equal(verdictOf([runOf(1, 'ci', 'failure'), runOf(2, 'ci', 'success')]), 'green');
    assert.equal(verdictOf([runOf(2, 'ci', 'success'), runOf(1, 'ci', 'cancelled')]), 'green');
    assert.equal(verdictOf([runOf(1, 'ci', 'success'), runOf(2, 'ci', 'failure')]), 'failed');
    assert.equal(verdictOf([runOf(2, 'ci', 'failure'), runOf(1, 'ci', 'success')]), 'failed');
  });

  it('reads an older failure under a newer run still going as pending, not failed', () => {
    const judged = judge(checksOf([runOf(1, 'ci', 'failure'), runOf(2, 'ci', null, { status: 'queued' })]), CI, 'clean');
    assert.deepEqual([judged.verdict, judged.required, judged.running], ['pending', [{ name: 'ci', conclusion: 'pending' }], ['ci']]);
  });

  it('passes success, neutral and skipped, and fails every other conclusion', () => {
    for (const conclusion of ['success', 'neutral', 'skipped']) assert.equal(verdictOf([runOf(1, 'ci', conclusion)]), 'green', conclusion);
    for (const conclusion of ['failure', 'cancelled', 'timed_out', 'action_required', 'stale', 'startup_failure']) assert.equal(verdictOf([runOf(1, 'ci', conclusion)]), 'failed', conclusion);
  });

  it('reads a run as finished only when its status says completed', () => {
    for (const status of [null, 'queued', 'in_progress', 'waiting', 'requested', 'pending']) {
      const judged = judge(checksOf([runOf(1, 'ci', 'success', { status })]), CI, 'clean');
      assert.deepEqual([judged.verdict, judged.required[0]?.conclusion], ['pending', 'pending'], String(status));
    }
  });

  it("takes a required check from the app its rule names, or from any app's newest run", () => {
    const cubic = runOf(5, 'ci', 'failure', { app: 9, actions: false });
    assert.deepEqual(judge(checksOf([cubic]), CI, 'clean').required, [{ name: 'ci', conclusion: 'missing' }]);
    assert.equal(verdictOf([cubic, runOf(3, 'ci', 'success')]), 'green');
    assert.equal(verdictOf([cubic, runOf(3, 'ci', 'success')], { required: [{ context: 'ci' }] }), 'failed');
    assert.equal(verdictOf([runOf(3, 'ci', 'success'), cubic], { required: [{ context: 'ci' }] }), 'failed');
    assert.equal(verdictOf([runOf(7, 'ci', 'success', { app: null }), cubic], { required: [{ context: 'ci' }] }), 'green');
  });

  it("takes a required check from a commit status when no run has its name, and a run's over a status", () => {
    for (const [state, verdict, conclusion] of [
      ['success', 'green', 'success'],
      ['pending', 'pending', 'pending'],
      ['failure', 'failed', 'failure'],
      ['error', 'failed', 'error'],
    ] as const) {
      const judged = judge(checksOf([], [{ context: 'ci', state }]), CI, 'clean');
      assert.deepEqual([judged.verdict, judged.required], [verdict, [{ name: 'ci', conclusion }]], state);
    }
    assert.equal(verdictOf([runOf(1, 'ci', 'success')], CI, 'clean', undefined, [{ context: 'ci', state: 'failure' }]), 'green');
  });

  it('waits for every run and status, required or not, but fails only on a required one', () => {
    const judged = judge(checksOf([runOf(1, 'ci', 'success'), runOf(2, 'Lane', null, { status: 'in_progress' }), runOf(3, 'Lane', null, { status: 'queued' })], [{ context: 'deploy', state: 'pending' }]), CI, 'clean');
    assert.deepEqual([judged.verdict, judged.running], ['pending', ['Lane', 'deploy']]);
    assert.equal(verdictOf([runOf(1, 'ci', 'success'), runOf(2, 'Lane', 'failure')], CI, 'clean', undefined, [{ context: 'deploy', state: 'error' }]), 'green');
  });

  it('waits while GitHub has not worked out whether the pull request merges', () => {
    for (const state of [null, 'unknown']) assert.equal(verdictOf([runOf(1, 'ci', 'success')], CI, state), 'pending');
    for (const state of ['clean', 'blocked', 'unstable', 'behind', 'has_hooks']) assert.equal(verdictOf([runOf(1, 'ci', 'success')], CI, state), 'green');
  });

  it('needs no run count beyond the required checks, a status among them', () => {
    const judged = judge(checksOf([], [{ context: 'ci', state: 'success' }]), CI, 'clean');
    assert.deepEqual([judged.verdict, judged.counted, judged.floor], ['green', 0, 0]);
  });

  it('without required checks, lets every name and status decide', () => {
    assert.equal(verdictOf([runOf(1, 'a', 'success'), runOf(2, 'b', 'failure')], NONE), 'failed');
    assert.equal(verdictOf([runOf(1, 'a', 'success'), runOf(2, 'b', 'failure'), runOf(3, 'b', 'success')], NONE), 'green');
    assert.equal(verdictOf([runOf(1, 'a', 'success')], NONE, 'clean', undefined, [{ context: 'deploy', state: 'failure' }]), 'failed');
    assert.equal(verdictOf([runOf(1, 'a', 'success')], NONE, 'clean', undefined, [{ context: 'deploy', state: 'success' }]), 'green');
    const judged = judge(checksOf([runOf(1, 'a', 'failure')], [{ context: 'deploy', state: 'error' }]), NONE, 'clean');
    assert.deepEqual([judged.required, judged.failing], [[], ['a', 'deploy']]);
  });

  it('by default, needs one GitHub Actions run that was not skipped', () => {
    const skipped = runOf(1, 'judge', 'skipped');
    const cubic = runOf(2, 'Cubic', 'success', { app: 9, actions: false });
    assert.deepEqual(judge(checksOf([skipped, cubic]), NONE, 'clean'), {
      verdict: 'short',
      required: [],
      minimum: 'default',
      failing: [],
      running: [],
      missing: [],
      counted: 0,
      floor: 1,
    } satisfies Judged);
    assert.equal(verdictOf([], NONE), 'short');
    assert.equal(verdictOf([skipped, cubic, runOf(3, 'test', 'success')], NONE), 'green');
    assert.equal(verdictOf([runOf(3, 'test', 'neutral')], NONE), 'green');
  });

  it('with minCheckRuns, needs that many runs from any app that finished and were not skipped', () => {
    const cubic = runOf(2, 'Cubic', 'success', { app: 9, actions: false });
    const judged = judge(checksOf([runOf(1, 'judge', 'skipped'), cubic]), NONE, 'clean', 2);
    assert.deepEqual([judged.verdict, judged.minimum, judged.counted, judged.floor], ['short', 'settings', 1, 2]);
    assert.equal(verdictOf([cubic, runOf(3, 'test', 'success')], NONE, 'clean', 2), 'green');
    assert.equal(verdictOf([cubic], NONE, 'clean', 1), 'green');
    assert.equal(verdictOf([cubic, runOf(3, 'test', 'success')], NONE, 'clean', 3), 'short');
    assert.equal(judge(checksOf([cubic, runOf(4, 'test', 'success', { status: 'in_progress' })]), NONE, 'clean', 2).counted, 1);
    assert.equal(judge(checksOf([runOf(1, 'ci', 'success')]), CI, 'clean', 5).minimum, 'ruleset');
    assert.equal(verdictOf([runOf(1, 'ci', 'success')], CI, 'clean', 5), 'green');
  });
});

/** A judgement, with no names behind it unless `more` gives them. */
const judgedAs = (verdict: Judged['verdict'], more: Partial<Judged> = {}): Judged => ({ verdict, required: [], minimum: 'ruleset', failing: [], running: [], missing: [], counted: 0, floor: 0, ...more });

describe('verdictLine', () => {
  it('says nothing of a green verdict, and names what holds any other', () => {
    assert.equal(verdictLine(7, HEAD, judgedAs('green')), undefined);
    assert.equal(
      verdictLine(7, HEAD, judgedAs('unjudged', { reason: 'cannot read it (HTTP 403)' })),
      "⚠ CI on #7 is unjudged: the base branch's required checks cannot be read (cannot read it (HTTP 403)), so it is never read as green",
    );
    assert.equal(
      verdictLine(7, HEAD, judgedAs('conflicted')),
      '⚠ CI on #7 is conflicted: it has merge conflicts, so GitHub runs no pull_request workflows on it; merge the base and push before reading it as clear',
    );
    assert.equal(verdictLine(7, HEAD, judgedAs('failed', { failing: ['ci', 'lint'] })), '⚠ CI on #7 failed: "ci", "lint" did not pass on its newest run');
    assert.equal(verdictLine(7, HEAD, judgedAs('pending', { running: ['Lane (src)'] })), `⚠ CI on #7 is pending: "Lane (src)" still running on ${HEAD}`);
    assert.equal(verdictLine(7, HEAD, judgedAs('pending')), '⚠ CI on #7 is pending: GitHub has not worked out whether it merges yet');
    assert.equal(verdictLine(7, HEAD, judgedAs('short', { missing: ['ci', 'Typecheck, test, build'] })), `⚠ CI on #7 is short: the required "ci", "Typecheck, test, build" has no run on ${HEAD}`);
    assert.equal(
      verdictLine(7, HEAD, judgedAs('short', { minimum: 'default', floor: 1 })),
      `⚠ CI on #7 is short: no GitHub Actions run that was not skipped is on ${HEAD}, and the repository names no required checks`,
    );
    assert.equal(
      verdictLine(7, HEAD, judgedAs('short', { minimum: 'settings', counted: 1, floor: 3 })),
      `⚠ CI on #7 is short: 1 of the 3 check runs "minCheckRuns" asks for finished on ${HEAD} without being skipped`,
    );
  });
});

describe('readChecks and newestRuns', () => {
  it('reads each run with its app, status and output, and each status with its description', async () => {
    const sys = session();
    sys.route('GET', `${REPO}/commits/${HEAD}/check-runs?per_page=100&page=1`, {
      status: 200,
      json: {
        check_runs: [
          { id: 1, name: 'ci', status: 'completed', conclusion: 'success', app: { id: ACTIONS, slug: 'github-actions' }, output: { title: 'T', summary: 'S' } },
          { id: 2, name: 'Cubic', status: 'in_progress', conclusion: null, app: { id: 0, slug: 'cubic' }, output: { title: 3 } },
          { id: 3, name: 'bare', status: 4, conclusion: 5, app: null, output: null },
        ],
      },
    });
    sys.route('GET', `${REPO}/commits/${HEAD}/status?per_page=100&page=1`, { status: 200, json: { statuses: [{ context: 'deploy', state: 'pending', description: 'going' }, { context: 'x', state: 'success', description: null }] } });
    assert.deepEqual(await readChecks(sys, 't', 'example-org/example-app', HEAD), {
      runs: [
        { id: 1, name: 'ci', app: ACTIONS, actions: true, status: 'completed', conclusion: 'success', title: 'T', summary: 'S' },
        { id: 2, name: 'Cubic', app: null, actions: false, status: 'in_progress', conclusion: null },
        { id: 3, name: 'bare', app: null, actions: false, status: null, conclusion: null },
      ],
      statuses: [{ context: 'deploy', state: 'pending', description: 'going' }, { context: 'x', state: 'success' }],
    });
  });

  it('keeps the run with the highest id of each name and app, and the first listing of a run listed twice', () => {
    const runs = [runOf(4, 'ci', 'success'), runOf(9, 'ci', 'failure'), runOf(6, 'ci', 'success'), runOf(9, 'ci', 'success'), runOf(2, 'ci', 'success', { app: 9 }), runOf(3, 'ci', 'success', { app: null })];
    assert.deepEqual(
      [...newestRuns(runs)].map(([key, run]) => [key, run.id, run.conclusion]),
      [
        [`${ACTIONS}/ci`, 9, 'failure'],
        ['9/ci', 2, 'success'],
        ['/ci', 3, 'success'],
      ],
    );
  });
});

describe('superseded failures', () => {
  it('marks a failure that a newer passing run of its name and app replaced, and no other', async () => {
    const sys = session();
    sys.route('GET', `${REPO}/commits/${HEAD}/check-runs?per_page=100&page=1`, {
      status: 200,
      json: {
        check_runs: [
          { id: 1, name: 'judge', status: 'completed', conclusion: 'failure', app: { id: ACTIONS, slug: 'github-actions' } },
          { id: 2, name: 'judge', status: 'completed', conclusion: 'skipped', app: { id: ACTIONS, slug: 'github-actions' } },
          { id: 3, name: 'lint', status: 'completed', conclusion: 'failure', app: { id: ACTIONS, slug: 'github-actions' } },
          { id: 4, name: 'lint', status: 'in_progress', conclusion: null, app: { id: ACTIONS, slug: 'github-actions' } },
          { id: 5, name: 'review', status: 'completed', conclusion: 'failure', app: { id: 9, slug: 'cubic' } },
          { id: 6, name: 'review', status: 'completed', conclusion: 'success', app: { id: ACTIONS, slug: 'github-actions' } },
          { id: 7, name: 'test', status: 'completed', conclusion: 'cancelled', app: { id: ACTIONS, slug: 'github-actions' } },
          { id: 8, name: 'test', status: 'completed', conclusion: 'failure', app: { id: ACTIONS, slug: 'github-actions' } },
          { id: 9, name: 'odd', status: 'completed', conclusion: 'failure', app: { id: ACTIONS, slug: 'github-actions' } },
          { id: 10, name: 'odd', status: 'in_progress', conclusion: 'success', app: { id: ACTIONS, slug: 'github-actions' } },
        ],
      },
    });
    const { signals } = await ciSignals(sys, 't', 'example-org/example-app', HEAD);
    assert.deepEqual(
      signals.map((s) => [s.body, s.superseded]),
      [
        ['judge: failure', true],
        ['lint: failure', undefined],
        ['review: failure', undefined],
        ['test: cancelled', undefined],
        ['test: failure', undefined],
        ['odd: failure', undefined],
      ],
    );
    assert.ok(!('superseded' in (signals[1] as object)));
  });

  it('folds one failure into a superseded signal only when every copy of it is superseded', () => {
    const failure = (superseded: boolean): RawSignal => ({ source: 'ci-failure', check: 'ci', file: null, line: null, body: 'ci: failure', ...(superseded ? { superseded: true as const } : {}) });
    assert.equal(dedupe([failure(true), failure(true)], [])[0]?.superseded, true);
    for (const pair of [
      [failure(true), failure(false)],
      [failure(false), failure(true)],
    ]) {
      const [folded] = dedupe(pair, []);
      assert.deepEqual([dedupe(pair, []).length, folded && 'superseded' in folded], [1, false]);
    }
  });
});

describe('readRules', () => {
  it("reads the checks every ruleset on the base requires, each once, with the app it names", async () => {
    const sys = session();
    sys.route('GET', `${RULES}?per_page=100&page=1`, {
      status: 200,
      json: [
        { type: 'pull_request', parameters: { required_approving_review_count: 0 } },
        null,
        { type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'ci', integration_id: ACTIONS }, { context: 'Cubic', integration_id: 0 }, { context: 'ci', integration_id: ACTIONS }] } },
        { type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'ci' }, { context: 'deploy', integration_id: '9' }, { context: 'ci', integration_id: 9 }] } },
      ],
    });
    assert.deepEqual(await readRules(sys, 't', 'example-org/example-app', 'main'), {
      required: [{ context: 'ci', app: ACTIONS }, { context: 'Cubic' }, { context: 'ci' }, { context: 'deploy' }, { context: 'ci', app: 9 }],
    });
    assert.equal(sys.requests.at(-1)?.token, 't');
  });

  it('reads every page, and names each part of the base in the path', async () => {
    const sys = session();
    const route = `${REPO}/rules/branches/release/a%20b`;
    sys.route('GET', `${route}?per_page=100&page=1`, { status: 200, json: Array.from({ length: 100 }, () => ({ type: 'deletion' })) });
    sys.route('GET', `${route}?per_page=100&page=2`, { status: 200, json: [{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'ci' }] } }] });
    assert.deepEqual(await readRules(sys, 't', 'example-org/example-app', 'release/a b'), { required: [{ context: 'ci' }] });
  });

  it('reads a base with no required checks as none', async () => {
    const sys = session();
    sys.route('GET', `${RULES}?per_page=100&page=1`, { status: 200, json: [] });
    assert.deepEqual(await readRules(sys, 't', 'example-org/example-app', 'main'), { required: [] });
  });

  it('says why it cannot read the rules, never that there are none', async () => {
    const sys = session();
    sys.route('GET', `${RULES}?per_page=100&page=1`, { status: 403, json: { message: 'Forbidden' } });
    assert.deepEqual(await readRules(sys, 't', 'example-org/example-app', 'main'), { unread: 'cannot read repos/example-org/example-app/rules/branches/main (HTTP 403)' });
    sys.route('GET', `${RULES}?per_page=100&page=1`, () => {
      throw new Error('the request timed out');
    });
    assert.deepEqual(await readRules(sys, 't', 'example-org/example-app', 'main'), { unread: 'the request timed out' });
    for (const [parameters, unread] of [
      [undefined, 'a required_status_checks rule on main names no checks'],
      [null, 'a required_status_checks rule on main names no checks'],
      [{ required_status_checks: 'ci' }, 'a required_status_checks rule on main names no checks'],
      [{ required_status_checks: [null] }, 'a required_status_checks rule on main names a check with no name'],
      [{ required_status_checks: [{ context: '' }] }, 'a required_status_checks rule on main names a check with no name'],
      [{ required_status_checks: [{ context: 3 }] }, 'a required_status_checks rule on main names a check with no name'],
    ] as const) {
      sys.route('GET', `${RULES}?per_page=100&page=1`, { status: 200, json: [{ type: 'required_status_checks', parameters }] });
      assert.deepEqual(await readRules(sys, 't', 'example-org/example-app', 'main'), { unread }, JSON.stringify(parameters));
    }
  });
});

describe('prSignals says whether CI is green', () => {
  it("reads the required checks from the pull request's own base", async () => {
    const sys = session({ base: { ref: 'release/2' } });
    sys.route('GET', `${REPO}/rules/branches/release/2?per_page=100&page=1`, { status: 200, json: [{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'build' }] } }] });
    const result = await run(sys, ['7', '--ci-only']);
    assert.deepEqual(parsed(result).ci, { mergeable: 'clean', checkRuns: 1, actionsRuns: 1, verdict: 'short', required: [{ name: 'build', conclusion: 'missing' }], minimum: 'ruleset' });
    assert.deepEqual(result.err, [`⚠ CI on #7 is short: the required "build" has no run on ${HEAD}`]);
  });

  it('is unjudged, with its reason, when the rules cannot be read, and still exits 0', async () => {
    const sys = session();
    sys.route('GET', `${RULES}?per_page=100&page=1`, { status: 403, json: null });
    const result = await run(sys, ['7', '--ci-only']);
    const reason = 'cannot read repos/example-org/example-app/rules/branches/main (HTTP 403)';
    assert.equal(result.code, 0);
    assert.deepEqual(parsed(result).ci, { mergeable: 'clean', checkRuns: 1, actionsRuns: 1, verdict: 'unjudged', required: [], minimum: 'default', reason });
    assert.deepEqual(result.err, [`⚠ CI on #7 is unjudged: the base branch's required checks cannot be read (${reason}), so it is never read as green`]);
  });

  it("takes the minimum from the settings' minCheckRuns where no ruleset names a check", async () => {
    const sys = session();
    sys.route('GET', `${RULES}?per_page=100&page=1`, { status: 200, json: [] });
    sys.files.set(`${ROOT}/.github/niyam.json`, JSON.stringify({ owner: 'example-owner', agent: AGENT, signals: { minCheckRuns: 2 } }));
    const result = await run(sys, ['7', '--ci-only']);
    assert.equal(result.code, 0);
    assert.deepEqual(parsed(result).ci, { mergeable: 'clean', checkRuns: 1, actionsRuns: 1, verdict: 'short', required: [], minimum: 'settings' });
    assert.deepEqual(result.err, [`⚠ CI on #7 is short: 1 of the 2 check runs "minCheckRuns" asks for finished on ${HEAD} without being skipped`]);
  });

  it('lists a superseded failure beside a green verdict, and fails on a live one', async () => {
    const sys = session();
    const actions = { id: ACTIONS, slug: 'github-actions' };
    sys.route('GET', `${REPO}/commits/${HEAD}/check-runs?per_page=100&page=1`, {
      status: 200,
      json: { check_runs: [{ id: 1, name: 'ci', status: 'completed', conclusion: 'failure', app: actions }, { id: 2, name: 'ci', status: 'completed', conclusion: 'success', app: actions }] },
    });
    const green = await run(sys, ['7', '--ci-only']);
    assert.deepEqual([(parsed(green).ci as { verdict: string }).verdict, parsed(green).signals.map((s) => [s.body, (s as { superseded?: boolean }).superseded]), green.err], ['green', [['ci: failure', true]], []]);
    sys.route('GET', `${REPO}/commits/${HEAD}/check-runs?per_page=100&page=1`, {
      status: 200,
      json: { check_runs: [{ id: 2, name: 'ci', status: 'completed', conclusion: 'success', app: actions }, { id: 3, name: 'ci', status: 'completed', conclusion: 'failure', app: actions }] },
    });
    const failed = await run(sys, ['7', '--ci-only']);
    assert.deepEqual([(parsed(failed).ci as { verdict: string }).verdict, failed.code, failed.err], ['failed', 0, ['⚠ CI on #7 failed: "ci" did not pass on its newest run']]);
  });
});

const ACTIONS_APP = { id: ACTIONS, slug: 'github-actions' };
/** A GitHub Actions run that finished, and one still going. */
const done = (id: number, name = 'ci', conclusion = 'success'): Record<string, unknown> => ({ id, name, status: 'completed', conclusion, app: ACTIONS_APP });
const going = (id: number, name = 'ci'): Record<string, unknown> => ({ id, name, status: 'in_progress', conclusion: null, app: ACTIONS_APP });
const HEAD_B = 'b'.repeat(40);

/**
 * A session whose head's check runs answer each read in turn, the last again after, and whose pull request reads
 * answer the same way when `pulls` are given. Its clock moves on by each sleep.
 */
function waiting(answers: Record<string, unknown>[][], pulls: Record<string, unknown>[] = [], head = HEAD): FakeSys {
  const sys = session();
  let reads = 0;
  sys.route('GET', `${REPO}/commits/${head}/check-runs?per_page=100&page=1`, () => {
    // A deadline for the poll loop: a 60-minute wait reads 122 times, so a mutant that never ends it stops here.
    if (reads > 200) throw new Error('the wait polled past its timeout');
    return { status: 200, json: { check_runs: answers[Math.min(reads++, answers.length - 1)] } };
  });
  if (pulls.length) {
    let pullReads = 0;
    sys.route('GET', `${REPO}/pulls/7`, () => ({ status: 200, json: { ...OPEN, mergeable_state: 'clean', ...pulls[Math.min(pullReads++, pulls.length - 1)] } }));
  }
  const start = sys.now().getTime();
  sys.now = () => new Date(start + sys.slept.reduce((total, ms) => total + ms, 0));
  return sys;
}

const reads = (sys: FakeSys, part: string): number => sys.requests.filter((r) => r.url.includes(part)).length;

describe('pollOf and agreed', () => {
  const settledPoll = (more: Partial<Poll> = {}): Poll => ({ head: HEAD, ids: '1,2', settled: true, verdict: 'green', ...more });

  it('names the runs by id in number order, and is settled only with every run done, no status pending and the state known', () => {
    const runs = [runOf(10, 'a', 'success'), runOf(9, 'b', 'success'), runOf(100, 'c', 'failure')];
    assert.deepEqual(pollOf(HEAD, checksOf(runs), 'clean', 'failed'), { head: HEAD, ids: '9,10,100', settled: true, verdict: 'failed' });
    assert.equal(pollOf(HEAD, checksOf([...runs, runOf(11, 'd', null, { status: 'queued' })]), 'clean', 'pending').settled, false);
    assert.equal(pollOf(HEAD, checksOf(runs, [{ context: 'deploy', state: 'pending' }]), 'clean', 'pending').settled, false);
    assert.equal(pollOf(HEAD, checksOf(runs, [{ context: 'deploy', state: 'success' }]), 'blocked', 'failed').settled, true);
    for (const state of [null, 'unknown']) assert.equal(pollOf(HEAD, checksOf(runs), state, 'pending').settled, false, String(state));
  });

  it('agrees on green only when both polls settled on the same head, runs and verdict, and never on short', () => {
    assert.equal(agreed(settledPoll(), settledPoll()), true);
    assert.equal(agreed(undefined, settledPoll()), false);
    for (const [last, now] of [
      [settledPoll({ settled: false }), settledPoll()],
      [settledPoll(), settledPoll({ settled: false })],
      [settledPoll({ head: HEAD_B }), settledPoll()],
      [settledPoll({ ids: '1' }), settledPoll()],
      [settledPoll({ verdict: 'failed' }), settledPoll()],
      [settledPoll({ verdict: 'short' }), settledPoll({ verdict: 'short' })],
    ] as const) {
      assert.equal(agreed(last, now), false, JSON.stringify([last, now]));
    }
  });

  it('ends early on failed, conflicted and unjudged at two polls of one head and verdict, whatever still runs', () => {
    for (const verdict of ['failed', 'conflicted', 'unjudged'] as const) {
      assert.equal(agreed(settledPoll({ verdict, settled: false, ids: '1' }), settledPoll({ verdict, settled: false })), true, verdict);
      assert.equal(agreed(undefined, settledPoll({ verdict })), false, verdict);
      assert.equal(agreed(settledPoll({ verdict, head: HEAD_B }), settledPoll({ verdict })), false, verdict);
      assert.equal(agreed(settledPoll({ verdict: 'pending', settled: false }), settledPoll({ verdict })), false, verdict);
    }
  });
});

describe('pr-signals --wait', () => {
  it('waits for every run to finish, ends at two agreeing settled polls, then reads in full and exits 0 on green', async () => {
    const sys = waiting([[going(1)], [done(1)], [done(1)]]);
    const result = await run(sys, ['7', '--wait']);
    assert.equal(result.code, 0);
    assert.deepEqual(sys.slept, [30_000, 30_000]);
    assert.equal(reads(sys, '/check-runs'), 4);
    const out = parsed(result);
    assert.deepEqual([out.ok, out.ci], [true, GREEN]);
    assert.equal(reads(sys, '/graphql'), 1);
    assert.deepEqual(result.err, []);
  });

  it('starts the count again when a new run appears, as one a finished workflow starts', async () => {
    const sys = waiting([[done(1)], [done(1), done(2, 'late')], [done(1), done(2, 'late')]]);
    const result = await run(sys, ['7', '--wait', '--ci-only']);
    assert.deepEqual([result.code, sys.slept.length, reads(sys, '/graphql')], [0, 2, 0]);
  });

  it('ends early on a failure while another run still goes, downloading logs only in the full read', async () => {
    const sys = waiting([[done(1, 'ci', 'failure'), going(2, 'Lane (src)')], [done(1, 'ci', 'failure'), going(2, 'Lane (src)'), going(3, 'late')]]);
    sys.route('GET', `${REPO}/actions/jobs/1/logs`, { status: 200, json: null, text: 'error: it broke' });
    const result = await run(sys, ['7', '--wait', '--ci-only']);
    assert.deepEqual([result.code, sys.slept, reads(sys, '/logs')], [5, [30_000], 1]);
    assert.deepEqual(result.err, ['⚠ CI on #7 failed: "ci" did not pass on its newest run']);
    assert.equal((parsed(result).ci as { verdict: string }).verdict, 'failed');
  });

  it('ends at 6 on a conflicted head once its verdict agrees twice, though its pull_request_target runs still go', async () => {
    const sys = waiting([[done(1), going(2, 'judge')]], [{ mergeable_state: 'clean' }, { mergeable_state: 'dirty' }]);
    const result = await run(sys, ['7', '--wait', '--ci-only']);
    assert.deepEqual([result.code, sys.slept.length], [6, 2]);
  });

  it('ends at 7 when the rules cannot be read', async () => {
    const sys = waiting([[done(1)]]);
    sys.route('GET', `${RULES}?per_page=100&page=1`, { status: 403, json: null });
    const result = await run(sys, ['7', '--wait', '--ci-only']);
    assert.deepEqual([result.code, sys.slept.length, (parsed(result).ci as { verdict: string }).verdict], [7, 1, 'unjudged']);
  });

  it('polls a short head on, ending once the late required check has run', async () => {
    const lint = done(2, 'lint');
    const sys = waiting([[lint], [lint], [lint], [lint, done(3)]]);
    const result = await run(sys, ['7', '--wait', '--ci-only']);
    assert.deepEqual([result.code, sys.slept.length], [0, 4]);
  });

  it('at the timeout, prints the last poll and exits 7 while short', async () => {
    const sys = waiting([[done(2, 'lint')]]);
    const result = await run(sys, ['7', '--wait', '--timeout', '1']);
    assert.deepEqual([result.code, sys.slept], [7, [30_000, 30_000]]);
    assert.deepEqual(parsed(result), {
      ok: false,
      reason: 'ci-not-settled',
      pr: 7,
      head: HEAD,
      minutes: 1,
      ci: { mergeable: 'clean', checkRuns: 1, actionsRuns: 1, verdict: 'short', required: [{ name: 'ci', conclusion: 'missing' }], minimum: 'ruleset' },
    } as never);
    assert.deepEqual(result.err, ['⚠ CI on #7 did not settle within 1 minute(s); the last poll read it as short', `⚠ CI on #7 is short: the required "ci" has no run on ${HEAD}`]);
    assert.equal(reads(sys, '/graphql'), 0);
  });

  it('at the timeout, exits 8 while pending, and 7 while unjudged', async () => {
    const pending = waiting([[going(1)]]);
    const result = await run(pending, ['7', '--wait', '--timeout', '2']);
    assert.deepEqual([result.code, pending.slept.length, (parsed(result).ci as { verdict: string }).verdict], [8, 4, 'pending']);
    assert.equal(result.err[0], '⚠ CI on #7 did not settle within 2 minute(s); the last poll read it as pending');
    const unjudged = waiting([[going(1)]]);
    unjudged.route('GET', `${RULES}?per_page=100&page=1`, { status: 403, json: null });
    assert.equal((await run(unjudged, ['7', '--wait', '--timeout', '1'])).code, 7);
    // A failure that a newer run replaced, still going, is pending, not failed.
    const rerun = waiting([[done(1, 'ci', 'failure'), going(2)]]);
    assert.equal((await run(rerun, ['7', '--wait', '--timeout', '1'])).code, 8);
    // Green on the last poll alone, with no second poll to agree: still pending, with only the timeout's line.
    const late = waiting([[going(1)], [going(1)], [done(1)]]);
    const lateResult = await run(late, ['7', '--wait', '--timeout', '1']);
    assert.deepEqual([lateResult.code, (parsed(lateResult).ci as { verdict: string }).verdict, lateResult.err], [8, 'green', ['⚠ CI on #7 did not settle within 1 minute(s); the last poll read it as green']]);
  });

  it('says when a push moves the head, and counts again on the new one', async () => {
    const sys = waiting([[done(1)]], [{}, { head: { sha: HEAD_B } }]);
    let readsB = 0;
    sys.route('GET', `${REPO}/commits/${HEAD_B}/check-runs?per_page=100&page=1`, () => {
      if (readsB++ > 200) throw new Error('the wait polled past its timeout');
      return { status: 200, json: { check_runs: [done(5)] } };
    });
    sys.route('GET', `${REPO}/commits/${HEAD_B}/status?per_page=100&page=1`, { status: 200, json: { statuses: [] } });
    const result = await run(sys, ['7', '--wait', '--ci-only']);
    assert.deepEqual([result.code, sys.slept.length], [0, 2]);
    assert.deepEqual(result.err, [`⚠ #7's head moved from ${HEAD} to ${HEAD_B}, so the wait counts its polls again`]);
    assert.equal(reads(sys, `/commits/${HEAD_B}/check-runs`), 3);
  });

  it('exits 3 when the pull request merges while it waits, saying so', async () => {
    const sys = waiting([[going(1)]], [{}, { state: 'closed', merged_at: '2026-11-27T03:00:00Z' }]);
    const result = await run(sys, ['7', '--wait']);
    assert.equal(result.code, MERGED_EXIT);
    assert.deepEqual(parsed(result), { ok: false, reason: 'pr-not-open', pr: 7, state: 'MERGED', mergedAt: '2026-11-27T03:00:00Z', phase: 'wait' } as never);
    assert.deepEqual(result.err, ['✗ #7 merged at 2026-11-27T03:00:00Z; nothing to answer (it changed while CI was waited on)']);
    const closed = waiting([[going(1)]], [{}, { state: 'closed' }]);
    assert.equal((await run(closed, ['7', '--wait'])).code, CLOSED_EXIT);
  });

  it('exits with the full read\'s verdict, so a run that starts after the polls holds it', async () => {
    const sys = waiting([[done(1)], [done(1)], [done(1), going(2, 'late')]]);
    const result = await run(sys, ['7', '--wait', '--ci-only']);
    assert.deepEqual([result.code, (parsed(result).ci as { verdict: string }).verdict], [8, 'pending']);
  });

  it('without --wait, reads once and sleeps never', async () => {
    const sys = waiting([[going(1)]]);
    assert.deepEqual([(await run(sys, ['7', '--ci-only'])).code, sys.slept], [0, []]);
  });
});
