import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  bodyAt,
  changeRuns,
  client,
  guardsNamed,
  isGuardFile,
  isTestFile,
  jobNames,
  judge,
  main,
  named,
  newer,
  onlyShaMoves,
  ownersIn,
  reports,
  section,
  sliceOf,
  testChange,
  versionMoves,
} from './guard.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'guard-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

const REPO = 'o/r';
const OWNERS = ['Owner'];
const APPROVED = '2026-01-02T00:00:00Z';
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

const WORKFLOW = (jobs) => `name: x\non: push\njobs:\n${jobs.map(([id, name]) => `  ${id}:\n${name ? `    name: ${name}\n` : ''}    runs-on: ubuntu-latest\n    steps: [{ run: 'true' }]\n`).join('')}`;

/**
 * A GitHub that answers what `over` gives over a default: pull request 1
 * building slice #10 of Work item #9, which Owner approved, the slice's
 * body `body`, unedited since before the approval.
 */
function github({ files = [], body = '**Guards:** `.github/workflows/ci.yml`', pull = {}, contents = {}, over = {} } = {}) {
  const calls = [];
  const routes = {
    [`/repos/${REPO}/pulls/1`]: { title: '✨ feat(x): y', body: 'Slice: #10', user: { login: 'AthyaBot' }, changed_files: files.length, base: { sha: 'b' }, head: { sha: 'h' }, ...pull },
    [`/repos/${REPO}/pulls/1/files`]: files,
    [`/repos/${REPO}/compare/b...h`]: { merge_base_commit: { sha: 'm' } },
    [`/repos/${REPO}/issues/10/parent`]: { number: 9 },
    [`/repos/${REPO}/issues/9/timeline`]: [{ event: 'labeled', label: { name: 'approved' }, actor: { login: 'owner' }, created_at: APPROVED }],
    [`/repos/${REPO}/issues/10/timeline`]: [{ event: 'parent_issue_added', created_at: '2026-01-01T00:00:00Z' }],
    [`/repos/${REPO}/issues/10/comments`]: [],
    [`/repos/${REPO}/rules/branches/main`]: [
      { type: 'pull_request' },
      { type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'Typecheck, test, build' }, { context: 'niyam / Work rules' }] } },
    ],
    '/graphql': { data: { repository: { issue: { body, createdAt: '2026-01-01T00:00:00Z', lastEditedAt: null, userContentEdits: { totalCount: 0, nodes: [] } } } } },
    ...over,
  };
  const answer = (path) => {
    calls.push(path);
    const [bare, query = ''] = path.split('?');
    if (bare.includes('/contents/')) {
      const key = `${decodeURIComponent(bare.split('/contents/')[1])}@${new URLSearchParams(query).get('ref')}`;
      return key in contents ? { status: 200, text: contents[key] } : { status: 404, text: '' };
    }
    if (/page=[2-9]/.test(query)) return { status: 200, json: [] };
    const route = routes[bare];
    if (route === undefined) return { status: 404, json: { message: 'Not Found' } };
    if (route && typeof route === 'object' && typeof route.status === 'number') return route;
    return { status: 200, json: route, text: JSON.stringify(route) };
  };
  return { calls, get: async (path) => answer(path), post: async (path) => answer(path) };
}

const modified = (filename, patch = '@@ -1 +1 @@\n-a\n+b', extra = {}) => ({ filename, status: 'modified', patch, ...extra });

describe('which files the guard watches', () => {
  test('guard files', () => {
    for (const path of ['.github/workflows/ci.yml', '.github/niyam.json', '.githooks/pre-push', '.dvara.json', '.dvara/records-baseline.json', '.gitleaks.toml', '.trufflehog-exclude', 'scripts/guard.mjs', 'package.json']) {
      assert.ok(isGuardFile(path), path);
    }
    for (const path of ['src/cli.ts', 'scripts/fixtures/a.mjs', 'README.md', '.dvara/other.json', 'docs/decisions.md']) assert.ok(!isGuardFile(path), path);
  });

  test('test files', () => {
    assert.ok(isTestFile('src/a.test.ts'));
    assert.ok(isTestFile('scripts/a.test.mjs'));
    assert.ok(isTestFile('b.spec.js'));
    assert.ok(!isTestFile('src/a.ts'));
    assert.ok(!isTestFile('src/test.ts'));
  });
});

describe('reading the slice', () => {
  test('section reads up to the next section', () => {
    assert.equal(section('**You will see:** x\n**Guards:** `a`\n- `b`\n**Cost:** c', 'Guards'), '`a`\n- `b`');
    assert.equal(section('**Guards:**\n\n**Cost:** c', 'Guards'), undefined);
    assert.equal(section('nothing', 'Guards'), undefined);
  });

  test('guardsNamed takes paths and patterns, not prose', () => {
    assert.deepEqual(guardsNamed('`.github/workflows/ci.yml`, `scripts/*.mjs` and\n- .githooks/\n- (package.json).'), ['.github/workflows/ci.yml', 'scripts/*.mjs', '.githooks/', 'package.json']);
    assert.deepEqual(guardsNamed(undefined), []);
  });

  test('named matches paths, folders and globs', () => {
    assert.ok(named(['a/b.yml'], 'a/b.yml'));
    assert.ok(named(['.github/'], '.github/workflows/ci.yml'));
    assert.ok(named(['scripts/*.mjs'], 'scripts/guard.mjs'));
    assert.ok(!named(['scripts/*.mjs'], 'scripts/x/guard.mjs'));
    assert.ok(named(['.github/**'], '.github/workflows/ci.yml'));
    assert.ok(named(['.github/**/ci.yml'], '.github/workflows/ci.yml'));
    assert.ok(!named(['a.yml'], 'b.yml'));
    assert.ok(!named(['.github/'], 'src/.github/x'));
  });

  test('sliceOf reads the first Slice: line', () => {
    assert.equal(sliceOf('x\nSlice: #12\nSlice: #13'), 12);
    assert.equal(sliceOf('Slice: https://github.com/o/r/issues/7'), 7);
    assert.equal(sliceOf('no slice'), undefined);
    assert.equal(sliceOf(undefined), undefined);
  });

  test('bodyAt reads the revision live at the time', () => {
    const issue = {
      body: 'now',
      createdAt: '2026-01-01',
      lastEditedAt: '2026-01-05',
      userContentEdits: { totalCount: 3, nodes: [{ editedAt: '2026-01-05', diff: 'now' }, { editedAt: '2026-01-03', diff: 'middle' }, { editedAt: '2026-01-01', diff: 'first' }] },
    };
    assert.equal(bodyAt(issue, '2026-01-04'), 'middle');
    assert.equal(bodyAt(issue, '2026-01-02'), 'first');
    assert.equal(bodyAt(issue, '2026-01-06'), 'now');
    assert.equal(bodyAt(issue, '2025-12-31'), undefined);
    assert.equal(bodyAt({ ...issue, lastEditedAt: null }, '2026-01-02'), 'now');
    assert.equal(bodyAt({ ...issue, userContentEdits: { ...issue.userContentEdits, totalCount: 101 } }, '2026-01-04'), undefined);
    assert.equal(bodyAt({ ...issue, userContentEdits: undefined }, '2026-01-04'), undefined);
    assert.equal(bodyAt({ ...issue, userContentEdits: { totalCount: 1, nodes: [{ editedAt: '2026-01-03', diff: 'x', deletedAt: '2026-01-04' }] } }, '2026-01-04'), undefined);
    assert.equal(bodyAt({ ...issue, userContentEdits: { totalCount: 1, nodes: [{ editedAt: '2026-01-05', diff: 'x' }] } }, '2026-01-04'), undefined);
  });

  test('ownersIn reads one owner or a list', () => {
    assert.deepEqual(ownersIn('{"owner":"A"}'), ['A']);
    assert.deepEqual(ownersIn('{"owner":["A","B"]}'), ['A', 'B']);
    assert.throws(() => ownersIn('{"owner":[]}'), /no owner/);
    assert.throws(() => ownersIn('{}'), /no owner/);
  });
});

describe('reading a change', () => {
  test('changeRuns pairs each removed block with the added one after it', () => {
    assert.deepEqual(changeRuns('@@ -1,4 +1,4 @@\n a\n-b\n-c\n+B\n d\n+e\n-f'), [
      { removed: ['b', 'c'], added: ['B'] },
      { removed: [], added: ['e'] },
      { removed: ['f'], added: [] },
    ]);
    assert.equal(changeRuns(undefined), undefined);
  });

  test('testChange counts tests and skips', () => {
    assert.deepEqual(testChange([{ removed: ["test('a', () => {"], added: ["test('b', () => {"] }]), { fewer: false, skipped: false });
    assert.deepEqual(testChange([{ removed: ["it('a', () => {"], added: [] }]), { fewer: true, skipped: false });
    assert.deepEqual(testChange([{ removed: ["test('a', () => {"], added: ["test.skip('a', () => {"] }]), { fewer: false, skipped: true });
    assert.deepEqual(testChange([{ removed: [], added: ["test('a', { todo: true }, () => {"] }]), { fewer: false, skipped: true });
  });

  test('newer compares releases', () => {
    assert.ok(newer('0.6.17', '0.6.16'));
    assert.ok(newer('1.0.0', '0.9.9'));
    assert.ok(!newer('0.6.16', '0.6.16'));
    assert.ok(!newer('0.6.9', '0.6.10'));
  });

  test('onlyShaMoves takes Dependabot sha moves alone', () => {
    const move = { removed: [`      - uses: actions/checkout@${SHA_A} # v7.0.0`], added: [`      - uses: actions/checkout@${SHA_B} # v7.0.1`] };
    assert.ok(onlyShaMoves([move]));
    assert.ok(!onlyShaMoves([{ ...move, added: [`      - uses: evil/checkout@${SHA_B} # v7.0.1`] }]));
    assert.ok(!onlyShaMoves([{ ...move, added: [`      - uses: actions/checkout@${SHA_B}`] }]));
    assert.ok(!onlyShaMoves([{ ...move, added: ['      - uses: actions/checkout@v7'] }]));
    assert.ok(!onlyShaMoves([{ removed: move.removed, added: [] }]));
    assert.ok(!onlyShaMoves([{ removed: ['run: pnpm check'], added: ['run: true'] }]));
  });

  test('versionMoves counts onboard version moves, and refuses anything more', () => {
    const run = (removed, added) => [{ removed, added }];
    const H1 = '1'.repeat(64);
    const H2 = '2'.repeat(64);
    assert.equal(versionMoves(run(['    uses: veda-hq/niyam/.github/workflows/checks.yml@v0.6.16'], ['    uses: veda-hq/niyam/.github/workflows/checks.yml@v0.6.17']), '0.6.17'), 1);
    // A sha256 alone may move; other versions on the line stay.
    assert.equal(versionMoves(run([`echo "${H1}  $dir/niyam.tgz"`], [`echo "${H2}  $dir/niyam.tgz"`]), '0.6.17'), 0);
    assert.equal(versionMoves(run(['# niyam 0.6.16, Node 24.21.0'], ['# niyam 0.6.17, Node 24.21.0']), '0.6.17'), 1);
    assert.equal(versionMoves(run(['# niyam 0.6.16, Node 24.21.0'], ['# niyam 0.6.17, Node 24.22.0']), '0.6.17'), -1);
    assert.equal(versionMoves(run(['run: pnpm check 0.6.16'], ['run: true 0.6.17']), '0.6.17'), -1);
    assert.equal(versionMoves(run(['a 0.6.18'], ['a 0.6.17']), '0.6.17'), -1);
    assert.equal(versionMoves(run(['a 0.6.16'], ['a 0.6.19']), '0.6.17'), -1);
    assert.equal(versionMoves(run(['a 0.6.16'], ['a']), '0.6.17'), -1);
    assert.equal(versionMoves(run(['a 0.6.16'], []), '0.6.17'), -1);
  });

  test("versionMoves takes onboard's own 0.6.17 lines (#348), prose aside", () => {
    const H1 = 'd0124574c85fd69bf958c1574d2afc5ab953360fc7877926ed2ac7165ab747ef';
    const H2 = 'a7a266229704903d855abbc2d7c4ff2bc48f01f3c38dff17dde5a19f0aeab6a2';
    const runs = changeRuns(
      [
        '@@ -1,4 +1,4 @@',
        '-# niyam 0.6.16 for Claude cloud sessions: Node 24.21.0 and the CLI, as niyam on PATH.',
        '+# niyam 0.6.17 for Claude cloud sessions: Node 24.21.0 and the CLI, as niyam on PATH.',
        ' set -euo pipefail',
        '-curl -fsSL --connect-timeout 10 --max-time 120 -o "$dir/niyam.tgz" https://github.com/veda-hq/niyam/releases/download/v0.6.16/veda-hq-niyam-0.6.16.tgz',
        `-echo "${H1}  $dir/niyam.tgz" | sha256sum -c --quiet -`,
        '-cli="$dir/cli-0.6.16"',
        '+curl -fsSL --connect-timeout 10 --max-time 120 -o "$dir/niyam.tgz" https://github.com/veda-hq/niyam/releases/download/v0.6.17/veda-hq-niyam-0.6.17.tgz',
        `+echo "${H2}  $dir/niyam.tgz" | sha256sum -c --quiet -`,
        '+cli="$dir/cli-0.6.17"',
      ].join('\n'),
    );
    assert.equal(versionMoves(runs, '0.6.17'), 4);
  });

  test('jobNames reads names, else ids', () => {
    assert.deepEqual(jobNames(WORKFLOW([['check', 'Typecheck, test, build'], ['other']])), ['Typecheck, test, build', 'other']);
    assert.deepEqual(jobNames('name: x\non: push\n'), []);
    assert.equal(jobNames('a: [b'), undefined);
    assert.equal(jobNames('- a'), undefined);
    assert.equal(jobNames('jobs: [a]'), undefined);
    assert.deepEqual(jobNames('jobs:\n  a: null'), ['a']);
  });

  test('reports a check by name, matrix leg or reusable job', () => {
    assert.ok(reports('Guard', 'Guard'));
    assert.ok(reports('niyam', 'niyam / Work rules'));
    assert.ok(reports('Build', 'Build (ubuntu)'));
    assert.ok(reports('${{ matrix.x }}', 'Guard'));
    assert.ok(!reports('Guards', 'Guard'));
    assert.ok(!reports('Work rules', 'niyam / Work rules'));
  });
});

describe('judging a pull request', () => {
  test('a change to no guard file passes without reading the slice', async () => {
    const gh = github({ files: [modified('src/cli.ts'), modified('README.md')] });
    assert.deepEqual(await judge(gh, REPO, 1, OWNERS), []);
    assert.ok(!gh.calls.includes('/graphql'));
    assert.ok(!gh.calls.some((call) => call.includes('/issues/')));
  });

  test('a guard file the approved Guards: names passes', async () => {
    assert.deepEqual(await judge(github({ files: [modified('.github/workflows/ci.yml')], contents: ciContents() }), REPO, 1, OWNERS), []);
  });

  test('a guard file the Guards: does not name is refused, naming the file and how to pass', async () => {
    const [refusal, ...rest] = await judge(github({ files: [modified('.githooks/pre-push')] }), REPO, 1, OWNERS);
    assert.equal(rest.length, 0);
    assert.equal(refusal.file, '.githooks/pre-push');
    assert.match(refusal.message, /changes a guard file, \.githooks\/pre-push/);
    assert.match(refusal.message, /slice #10's \*\*Guards:\*\* section, as it stood when Work item #9 got the approved label/);
    assert.match(refusal.message, /name `\.githooks\/pre-push` in the slice's \*\*Guards:\*\* section/);
    assert.match(refusal.message, /edit or push this pull request/);
  });

  test('a Guards: line written after the approval does not count', async () => {
    const issue = {
      body: '**Guards:** `.githooks/`',
      createdAt: '2026-01-01T00:00:00Z',
      lastEditedAt: '2026-01-03T00:00:00Z',
      userContentEdits: { totalCount: 2, nodes: [{ editedAt: '2026-01-03T00:00:00Z', diff: '**Guards:** `.githooks/`' }, { editedAt: '2026-01-01T00:00:00Z', diff: 'no guards' }] },
    };
    const over = { '/graphql': { data: { repository: { issue } } } };
    const refusals = await judge(github({ files: [modified('.githooks/pre-push')], over }), REPO, 1, OWNERS);
    assert.equal(refusals.length, 1);
    // One written before it does.
    issue.userContentEdits.nodes[1].diff = '**Guards:** `.githooks/`';
    assert.deepEqual(await judge(github({ files: [modified('.githooks/pre-push')], over }), REPO, 1, OWNERS), []);
  });

  test('a slice whose revisions GitHub cuts short, or GraphQL that does not answer, is refused', async () => {
    const issue = { body: 'x', createdAt: '2026-01-01T00:00:00Z', lastEditedAt: '2026-01-03T00:00:00Z', userContentEdits: { totalCount: 200, nodes: [] } };
    let [refusal] = await judge(github({ files: [modified('.githooks/pre-push')], over: { '/graphql': { data: { repository: { issue } } } } }), REPO, 1, OWNERS);
    assert.match(refusal.message, /does not show every revision of slice #10's body/);
    [refusal] = await judge(github({ files: [modified('.githooks/pre-push')], over: { '/graphql': { status: 502, json: undefined } } }), REPO, 1, OWNERS);
    assert.match(refusal.message, /GraphQL API did not give slice #10's body revisions \(HTTP 502\)/);
  });

  test('a pull request that names no slice is refused', async () => {
    const [refusal] = await judge(github({ files: [modified('.githooks/pre-push')], pull: { body: null } }), REPO, 1, OWNERS);
    assert.match(refusal.message, /names no slice\. Add a "Slice: #N" line/);
  });

  test('a Work item not approved, or approved by someone else, is refused', async () => {
    for (const events of [[], [{ event: 'labeled', label: { name: 'approved' }, actor: { login: 'AthyaBot' }, created_at: APPROVED }], [
      { event: 'labeled', label: { name: 'approved' }, actor: { login: 'Owner' }, created_at: APPROVED },
      { event: 'unlabeled', label: { name: 'approved' }, actor: { login: 'Owner' }, created_at: APPROVED },
    ]]) {
      const [refusal] = await judge(github({ files: [modified('.githooks/pre-push')], over: { [`/repos/${REPO}/issues/9/timeline`]: events } }), REPO, 1, OWNERS);
      assert.match(refusal.message, /Work item #9 is not approved by Owner/);
    }
  });

  test('a slice under no Work item is refused', async () => {
    const [refusal] = await judge(github({ files: [modified('.githooks/pre-push')], over: { [`/repos/${REPO}/issues/10/parent`]: { status: 404, json: { message: 'No parent issue found' } } } }), REPO, 1, OWNERS);
    assert.match(refusal.message, /slice #10 is not a sub-issue of a Work item GitHub can read \(HTTP 404\)/);
  });

  test('a slice added after approval counts from the Decision that settled it', async () => {
    const joined = { [`/repos/${REPO}/issues/10/timeline`]: [{ event: 'parent_issue_added', created_at: '2026-01-03T00:00:00Z' }] };
    const issue = {
      body: '**Guards:** `.githooks/`',
      createdAt: '2026-01-03T00:00:00Z',
      lastEditedAt: '2026-01-05T00:00:00Z',
      userContentEdits: { totalCount: 2, nodes: [{ editedAt: '2026-01-05T00:00:00Z', diff: '**Guards:** `.githooks/`' }, { editedAt: '2026-01-03T00:00:00Z', diff: 'none' }] },
    };
    const graphql = { '/graphql': { data: { repository: { issue } } } };
    const decision = (at, extra = {}) => ({ user: { login: 'Owner' }, body: 'Decision: yes, #10', created_at: at, updated_at: at, ...extra });
    const files = [modified('.githooks/pre-push')];

    // None yet.
    let [refusal] = await judge(github({ files, over: { ...joined, ...graphql } }), REPO, 1, OWNERS);
    assert.match(refusal.message, /joined Work item #9 after its approval, and Owner has written no unedited Decision:/);

    // One on the slice after the Guards: line: it counts from then.
    const later = { [`/repos/${REPO}/issues/10/comments`]: [decision('2026-01-06T00:00:00Z')] };
    assert.deepEqual(await judge(github({ files, over: { ...joined, ...graphql, ...later } }), REPO, 1, OWNERS), []);

    // One on the Work item naming the slice before it: the Guards: line came after it.
    const onItem = {
      [`/repos/${REPO}/issues/9/timeline`]: [
        { event: 'labeled', label: { name: 'approved' }, actor: { login: 'Owner' }, created_at: APPROVED },
        { event: 'commented', ...decision('2026-01-04T00:00:00Z') },
        { event: 'commented', ...decision('2026-01-04T01:00:00Z', { body: 'Decision: about #11' }) },
      ],
    };
    [refusal] = await judge(github({ files, over: { ...joined, ...graphql, ...later, ...onItem } }), REPO, 1, OWNERS);
    assert.match(refusal.message, /as it stood when Owner's Decision: settled slice #10 \(2026-01-04T00:00:00Z\)/);

    // An edited one, or another login's, does not count.
    const edited = { [`/repos/${REPO}/issues/10/comments`]: [decision('2026-01-06T00:00:00Z', { updated_at: '2026-01-07T00:00:00Z' }), decision('2026-01-06T00:00:00Z', { user: { login: 'AthyaBot' } })] };
    [refusal] = await judge(github({ files, over: { ...joined, ...graphql, ...edited } }), REPO, 1, OWNERS);
    assert.match(refusal.message, /no unedited Decision:/);
  });

  test('package.json counts for its scripts alone', async () => {
    const pkg = (scripts) => JSON.stringify({ version: scripts ? '2' : '1', scripts: scripts ?? { check: 'pnpm test' } });
    const files = [modified('package.json')];
    assert.deepEqual(await judge(github({ files, contents: { 'package.json@m': pkg(), 'package.json@h': pkg(undefined).replace('"1"', '"3"') } }), REPO, 1, OWNERS), []);
    const [refusal] = await judge(github({ files, contents: { 'package.json@m': pkg(), 'package.json@h': pkg({ check: 'true' }) } }), REPO, 1, OWNERS);
    assert.match(refusal.message, /changes the scripts of package\.json, a guard file/);
    // Not JSON, or removed, changes them too.
    assert.equal((await judge(github({ files, contents: { 'package.json@m': pkg(), 'package.json@h': '{' } }), REPO, 1, OWNERS)).length, 1);
    assert.equal((await judge(github({ files: [{ ...files[0], status: 'removed' }], contents: { 'package.json@m': pkg() } }), REPO, 1, OWNERS)).length, 1);
  });

  test('a file GitHub cannot give fails closed', async () => {
    await assert.rejects(judge(github({ files: [modified('package.json')], contents: {}, over: { [`/repos/${REPO}/compare/b...h`]: { status: 500, json: { message: 'oops' } } } }), REPO, 1, OWNERS), /GitHub did not answer \/repos\/o\/r\/compare\/b\.\.\.h \(HTTP 500: oops\)/);
    const gh = github({ files: [modified('package.json')] });
    const get = gh.get;
    gh.get = async (path, options) => (path.includes('/contents/') ? { status: 403, text: '' } : get(path, options));
    await assert.rejects(judge(gh, REPO, 1, OWNERS), /did not answer package\.json at h \(HTTP 403\)/);
    await assert.rejects(judge(github({ over: { [`/repos/${REPO}/pulls/1/files`]: { a: 1 } } }), REPO, 1, OWNERS), /did not answer a list/);
  });

  test('a renamed guard file counts under both names', async () => {
    const refusals = await judge(github({ files: [{ filename: 'docs/x.sh', previous_filename: '.githooks/pre-push', status: 'renamed', patch: '' }] }), REPO, 1, OWNERS);
    assert.deepEqual(refusals.map((refusal) => refusal.file), ['.githooks/pre-push']);
  });

  test('test files: deleted, fewer tests, skips, renamed away or unreadable need naming', async () => {
    const one = async (file, body = 'none') => judge(github({ files: [file], body }), REPO, 1, OWNERS);
    assert.match((await one({ filename: 'src/a.test.ts', status: 'removed' }))[0].message, /deletes a test file, src\/a\.test\.ts/);
    assert.match((await one(modified('src/a.test.ts', "@@ -1 +0,0 @@\n-test('a', () => {})")))[0].message, /fewer test\( or it\( calls than main/);
    assert.match((await one(modified('src/a.test.ts', "@@ -1 +1 @@\n-test('a', () => {})\n+test.only('a', () => {})")))[0].message, /adds \.skip, \.only or todo/);
    assert.match((await one({ filename: 'src/a.ts', previous_filename: 'src/a.test.ts', status: 'renamed', patch: '' }))[0].message, /deletes a test file, src\/a\.test\.ts/);
    assert.match((await one({ filename: 'src/a.test.ts', status: 'modified' }))[0].message, /whose diff GitHub does not show/);
    assert.deepEqual(await one(modified('src/a.test.ts', "@@ -1 +1,2 @@\n-test('a', () => {})\n+test('a', () => {\n+})")), []);
    assert.deepEqual(await one({ filename: 'src/b.test.ts', status: 'added', patch: "@@ -0,0 +1 @@\n+test('b', () => {})" }), []);
    // Named, it passes.
    assert.deepEqual(await one({ filename: 'src/a.test.ts', status: 'removed' }, '**Guards:** `src/a.test.ts`'), []);
  });

  test('a file list GitHub truncates fails closed', async () => {
    const [refusal] = await judge(github({ files: [modified('README.md')], pull: { changed_files: 3001 } }), REPO, 1, OWNERS);
    assert.match(refusal.message, /GitHub listed 1 of this pull request's 3001 changed files/);
  });

  test('Dependabot moving uses: shas passes unnamed; anything more does not', async () => {
    const patch = `@@ -1 +1 @@\n-      - uses: actions/checkout@${SHA_A} # v7.0.0\n+      - uses: actions/checkout@${SHA_B} # v7.0.1`;
    const files = [modified('.github/workflows/release.yml', patch)];
    const contents = { '.github/workflows/release.yml@h': WORKFLOW([['a']]), '.github/workflows/release.yml@m': WORKFLOW([['a']]) };
    assert.deepEqual(await judge(github({ files, contents, body: 'none', pull: { user: { login: 'dependabot[bot]' } } }), REPO, 1, OWNERS), []);
    assert.equal((await judge(github({ files, contents, body: 'none' }), REPO, 1, OWNERS)).length, 1);
    const more = [...files, modified('.githooks/pre-push')];
    assert.equal((await judge(github({ files: more, contents, body: 'none', pull: { user: { login: 'dependabot[bot]' } } }), REPO, 1, OWNERS)).length, 2);
  });

  test('onboard moving niyam to a newer release on main passes unnamed', async () => {
    const patch = '@@ -1 +1 @@\n-    uses: veda-hq/niyam/.github/workflows/checks.yml@v0.6.16\n+    uses: veda-hq/niyam/.github/workflows/checks.yml@v0.6.17';
    const files = [modified('.github/workflows/niyam.yml', patch)];
    const contents = { '.github/workflows/niyam.yml@h': WORKFLOW([['niyam']]), '.github/workflows/niyam.yml@m': WORKFLOW([['niyam']]) };
    const pull = { title: '🔧 chore(niyam): onboard at v0.6.17' };
    const TAG = 'c'.repeat(40);
    const COMMIT = 'd'.repeat(40);
    const tagged = (status, ref = { object: { type: 'tag', sha: TAG } }) => ({
      [`/repos/${REPO}/git/ref/tags/v0.6.17`]: ref,
      [`/repos/${REPO}/git/tags/${TAG}`]: { object: { type: 'commit', sha: COMMIT } },
      [`/repos/${REPO}/compare/main...${COMMIT}`]: { status },
    });
    assert.deepEqual(await judge(github({ files, contents, body: 'none', pull, over: tagged('behind') }), REPO, 1, OWNERS), []);
    assert.deepEqual(await judge(github({ files, contents, body: 'none', pull, over: tagged('identical') }), REPO, 1, OWNERS), []);
    // A lightweight tag names its commit itself.
    assert.deepEqual(await judge(github({ files, contents, body: 'none', pull, over: tagged('behind', { object: { type: 'commit', sha: COMMIT } }) }), REPO, 1, OWNERS), []);
    // A tag off main, one GitHub cannot find, or an annotated tag it cannot read, is no exemption.
    assert.equal((await judge(github({ files, contents, body: 'none', pull, over: tagged('diverged') }), REPO, 1, OWNERS)).length, 1);
    assert.equal((await judge(github({ files, contents, body: 'none', pull }), REPO, 1, OWNERS)).length, 1);
    assert.equal((await judge(github({ files, contents, body: 'none', pull, over: { ...tagged('behind'), [`/repos/${REPO}/git/tags/${TAG}`]: { status: 404, json: {} } } }), REPO, 1, OWNERS)).length, 1);
    // Nor are sha256 swaps that move no version.
    const swap = [modified('.github/niyam/cloud-setup.sh', `@@ -1 +1 @@\n-x ${'1'.repeat(64)}\n+x ${'2'.repeat(64)}`)];
    assert.equal((await judge(github({ files: swap, body: 'none', pull, over: tagged('behind') }), REPO, 1, OWNERS)).length, 1);
    // Nor is a title for another release than the lines move to.
    assert.equal((await judge(github({ files, contents, body: 'none', pull: { title: 'chore(niyam): onboard at v0.6.18' } }), REPO, 1, OWNERS)).length, 1);
  });

  test('a job named after a required check is refused, Guards: or not', async () => {
    const one = async (now, before, status = 'modified') =>
      judge(
        github({
          files: [modified('.github/workflows/ci.yml', '@@ -1 +1 @@\n-a\n+b', { status })],
          contents: { '.github/workflows/ci.yml@h': now, ...(before ? { '.github/workflows/ci.yml@m': before } : {}) },
        }),
        REPO,
        1,
        OWNERS,
      );
    assert.deepEqual(await one(WORKFLOW([['check', 'Typecheck, test, build']]), WORKFLOW([['check', 'Typecheck, test, build']])), []);
    let [refusal] = await one(WORKFLOW([['check', 'Typecheck, test, build'], ['copy', 'Typecheck, test, build']]).replace('copy:', 'copy2:'), WORKFLOW([['other']]));
    assert.match(refusal.message, /adds the job "Typecheck, test, build", which reports "Typecheck, test, build", a check main's ruleset requires/);
    [refusal] = await one(WORKFLOW([['g', 'Guard']]), undefined, 'added');
    assert.match(refusal.message, /reports "Guard"/);
    [refusal] = await one(WORKFLOW([['niyam']]), WORKFLOW([['other']]));
    assert.match(refusal.message, /reports "niyam \/ Work rules"/);
    [refusal] = await one(WORKFLOW([['x', '"${{ inputs.name }}"']]), WORKFLOW([['other']]));
    assert.match(refusal.message, /whose name is an expression/);
    [refusal] = await one('jobs: [', WORKFLOW([['other']]));
    assert.match(refusal.message, /does not parse as a workflow/);
    // A second job of a required name counts as added.
    [refusal] = await one(WORKFLOW([['check', 'Typecheck, test, build'], ['again', 'Typecheck, test, build']]), WORKFLOW([['check', 'Typecheck, test, build']]));
    assert.match(refusal.message, /adds the job "Typecheck, test, build"/);
    // A base that no longer parses keeps no names.
    [refusal] = await one(WORKFLOW([['g', 'Guard']]), 'jobs: [');
    assert.match(refusal.message, /reports "Guard"/);
  });

  test('a workflow change when the ruleset cannot be read fails closed', async () => {
    const files = [modified('.github/workflows/ci.yml')];
    const contents = ciContents();
    await assert.rejects(judge(github({ files, contents, over: { [`/repos/${REPO}/rules/branches/main`]: { status: 403, json: { message: 'Resource not accessible' } } } }), REPO, 1, OWNERS), /HTTP 403: Resource not accessible/);
    await assert.rejects(judge(github({ files, contents, over: { [`/repos/${REPO}/rules/branches/main`]: { a: 1 } } }), REPO, 1, OWNERS), /rules as a list/);
  });

  test('a removed workflow reports nothing', async () => {
    assert.deepEqual(await judge(github({ files: [{ filename: '.github/workflows/ci.yml', status: 'removed' }] }), REPO, 1, OWNERS), []);
  });
});

/** ci.yml at the merge base and the head, with the same required job. */
function ciContents() {
  const ci = WORKFLOW([['check', 'Typecheck, test, build']]);
  return { '.github/workflows/ci.yml@h': ci, '.github/workflows/ci.yml@m': ci };
}

describe('main', () => {
  const root = join(scratch, 'repo');
  mkdirSync(join(root, '.github'), { recursive: true });
  writeFileSync(join(root, '.github', 'niyam.json'), JSON.stringify({ owner: 'Owner', agent: 'AthyaBot' }));
  const output = () => {
    const lines = [];
    return { lines, log: (line) => lines.push(['log', line]), error: (line) => lines.push(['error', line]) };
  };
  const env = { REPO, PR: '1', GH_TOKEN: 'x' };

  test('passes, refuses, fails closed and checks its usage', async () => {
    let out = output();
    assert.equal(await main(env, out, github({ files: [modified('src/a.ts')] }), root), 0);
    assert.match(out.lines[0][1], /^Guard: /);

    out = output();
    assert.equal(await main(env, out, github({ files: [modified('.githooks/pre-push')] }), root), 1);
    assert.match(out.lines[0][1], /^::error file=\.githooks\/pre-push::This pull request changes a guard file/);

    out = output();
    assert.equal(await main(env, out, github({ files: [modified('README.md')], pull: { changed_files: 9 } }), root), 1);
    assert.match(out.lines[0][1], /^::error::GitHub listed 1/);

    out = output();
    assert.equal(await main(env, out, github({ over: { [`/repos/${REPO}/pulls/1`]: { status: 404, json: { message: 'Not Found' } } } }), root), 1);
    assert.match(out.lines[0][1], /^::error::Guard could not judge this pull request: GitHub did not answer \/repos\/o\/r\/pulls\/1 \(HTTP 404: Not Found\)/);

    out = output();
    assert.equal(await main(env, out, github(), join(scratch, 'missing')), 1);

    for (const bad of [{ ...env, REPO: undefined }, { ...env, REPO: 'a b' }, { ...env, PR: 'x' }, { ...env, PR: '0' }, { ...env, GH_TOKEN: undefined }]) {
      out = output();
      assert.equal(await main(bad, out, undefined, root), 2);
      assert.match(out.lines[0][1], /^usage:/);
    }
  });

  test('client calls GitHub with the token, as JSON or raw', async () => {
    const seen = [];
    const doFetch = async (url, init) => {
      seen.push({ url, init });
      return { status: 200, text: async () => (url.endsWith('raw') ? 'plain text' : '{"a":1}') };
    };
    const gh = client('tok', 'https://api.example', doFetch);
    assert.deepEqual(await gh.get('/x'), { status: 200, json: { a: 1 }, text: '{"a":1}' });
    assert.deepEqual(await gh.get('/raw', { raw: true }), { status: 200, json: undefined, text: 'plain text' });
    await gh.post('/graphql', { query: 'q' });
    assert.equal(seen[0].url, 'https://api.example/x');
    assert.equal(seen[0].init.headers.authorization, 'Bearer tok');
    assert.equal(seen[1].init.headers.accept, 'application/vnd.github.raw');
    assert.equal(seen[2].init.method, 'POST');
    assert.equal(seen[2].init.body, '{"query":"q"}');
    assert.equal(seen[2].init.headers['content-type'], 'application/json');
    assert.equal(client('t').get.length, 2);
  });
});
