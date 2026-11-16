import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { auditArgs, boardAudit } from './board-audit.ts';
import { BUILT_IN, Board, OWNER_TOKEN, SLUG, URL } from './fake-board.test.ts';
import { FakeSys, ROOT, capture } from './fake.test.ts';
import { run } from './run.ts';

const SETTINGS = `${ROOT}/.github/niyam.json`;
const CONTENTS = `/repos/${SLUG}/contents/.github/niyam.json`;
const AUDIT = ['BoardAuditProject', 'BoardAuditIssues', 'BoardAuditItems'];

/** GitHub with the app's board, "example-app work", and a clone of the app here whose settings name no Project. */
function setUp(settings: Record<string, unknown> = {}): { sys: FakeSys; board: Board } {
  const sys = new FakeSys();
  const board = new Board(sys);
  sys.env = { GH_TOKEN: OWNER_TOKEN };
  sys.files.set(SETTINGS, JSON.stringify({ owner: 'example-owner', agent: 'ExampleBot', ...settings }));
  board.project = { fields: [...BUILT_IN], linked: true };
  return { sys, board };
}

async function audit(sys: FakeSys, args: string[] = []): Promise<{ code: number; out: string[]; err: string[] }> {
  const { io, out, err } = capture();
  const code = await run(['board-audit', ...args], io, () => sys);
  return { code, out, err };
}

const WORKFLOWS_ON = ['✓ workflow Auto-add to project is on', '✓ workflow Auto-add sub-issues to project is on'];
const CAVEAT = "  GitHub's API shows whether a workflow is on, not the repository or filter it adds from; Auto-add adds an issue only as it opens or changes, never one already open";

describe('board-audit', () => {
  it('says the board matches when every open issue is on it with a Status that agrees, changing nothing', async () => {
    const { sys, board } = setUp();
    board.auditIssues = [
      { number: 1, on: [{ status: 'Todo' }] },
      { number: 2, on: [{}] },
      { number: 3, closed: true, on: [{ status: 'Done' }] },
      { number: 4, closed: true, on: [{ archived: true, status: 'In Progress' }] },
      { number: 5, closed: true },
    ];
    const { code, out, err } = await audit(sys);
    assert.deepEqual(err, []);
    assert.deepEqual(out, [
      `board-audit: ${SLUG} on "example-app work" (${URL})`,
      ...WORKFLOWS_ON,
      CAVEAT,
      '✓ every open issue is on the board',
      "✓ every item's Status agrees with its issue",
      'board-audit: the board matches the repository',
    ]);
    assert.equal(code, 0);
    assert.deepEqual(board.operations, AUDIT, 'reads only');
    assert.ok(sys.requests.every((request) => request.token === OWNER_TOKEN && (request.method === 'GET' || request.url.endsWith('/graphql'))));
  });

  it('says open issues archived on the board without counting them: exit 0, but not "matches"', async () => {
    const { sys, board } = setUp();
    board.auditIssues = [{ number: 1, on: [{}] }, { number: 140, on: [{ archived: true }] }];
    const { code, out } = await audit(sys);
    assert.equal(code, 0);
    assert.deepEqual(out.slice(-3), [
      '- 1 open issue is archived on the board, so hidden there; restore any that belong on it: #140',
      "✓ every item's Status agrees with its issue",
      'board-audit: nothing to fix but the archived issues above',
    ]);
  });

  it('lists open issues not on the board, Statuses that disagree, and auto-add workflows missing or off; exit 3', async () => {
    const { sys, board } = setUp();
    board.project!.absent = ['Auto-add to project'];
    board.project!.off = ['Auto-add sub-issues to project'];
    board.auditIssues = [
      { number: 3376 },
      { number: 3468, on: [{ project: 'P_OTHER', status: 'Todo' }] },
      { number: 12, on: [{ archived: true, status: 'Todo' }] },
      { number: 140, on: [{ archived: true }] },
      { number: 7, on: [{ status: 'done' }] },
      { number: 3204, closed: true, on: [{ status: 'In Progress' }] },
      { number: 8, closed: true, on: [{}] },
      // Another repository's issue, and a pull request, on the same board: not this audit's.
      { number: 9, closed: true, repo: 'example-org/other', on: [{ status: 'Todo' }] },
      { number: 10, closed: true, pull: true, on: [{ status: 'Todo' }] },
    ];
    const { code, out } = await audit(sys);
    assert.deepEqual(out, [
      `board-audit: ${SLUG} on "example-app work" (${URL})`,
      `✗ workflow Auto-add to project is missing: add it at ${URL}/workflows, for the repository ${SLUG} with the filter is:issue is:open (GitHub's API cannot)`,
      `✗ workflow Auto-add sub-issues to project is off: turn it on at ${URL}/workflows`,
      CAVEAT,
      `✗ 2 open issues are not on the board: add them at ${URL} (+ Add item, then #N), or gh project item-add`,
      '  #3376 Issue 3376',
      '  #3468 Issue 3468',
      '- 2 open issues are archived on the board, so hidden there; restore any that belong on it: #12, #140',
      `✗ 3 items' Status disagree with the issue: set it at ${URL}`,
      '  #7 is open, Status done: Issue 7',
      '  #8 is closed, Status empty: Issue 8',
      '  #3204 is closed, Status In Progress: Issue 3204',
      'board-audit: 7 to fix',
    ]);
    assert.equal(code, 3);
    assert.deepEqual(board.operations, AUDIT);
  });

  it('says one of each in the singular', async () => {
    const { sys, board } = setUp();
    board.auditIssues = [{ number: 1 }, { number: 2, closed: true, on: [{ status: 'Todo' }] }, { number: 3, on: [{ archived: true }] }];
    const { out } = await audit(sys);
    assert.ok(out.includes('- 1 open issue is archived on the board, so hidden there; restore any that belong on it: #3'), out.join('\n'));
    assert.ok(out.includes(`✗ 1 open issue is not on the board: add it at ${URL} (+ Add item, then #N), or gh project item-add`), out.join('\n'));
    assert.ok(out.includes(`✗ 1 item's Status disagrees with the issue: set it at ${URL}`), out.join('\n'));
  });

  it("reads every page: the owner's Projects, the open issues and the board's items", async () => {
    const { sys, board } = setUp();
    board.otherPages = 2;
    board.itemsPerPage = 1;
    board.auditIssues = [{ number: 1 }, { number: 2, on: [{}] }, { number: 3, closed: true, on: [{ status: 'Todo' }] }];
    const { code, out } = await audit(sys);
    assert.equal(code, 3);
    assert.ok(out.includes('  #1 Issue 1'));
    assert.ok(out.includes('  #3 is closed, Status Todo: Issue 3'));
    assert.deepEqual(
      board.operations.filter((operation) => operation === 'BoardAuditProject'),
      ['BoardAuditProject', 'BoardAuditProject', 'BoardAuditProject'],
    );
  });

  it("audits the Project the clone's settings name, or the one named with --project", async () => {
    const { sys, board } = setUp({ project: ' Athya work ' });
    board.project!.title = 'Athya work';
    const { code, out } = await audit(sys);
    assert.equal(code, 0);
    assert.equal(out[0], `board-audit: ${SLUG} on "Athya work" (${URL})`);

    const named = setUp();
    named.board.project!.title = 'Our board';
    assert.equal((await audit(named.sys, ['--project', 'Our board'])).code, 0);
  });

  it("reads a named repository's settings from GitHub, outside its clone", async () => {
    const { sys, board } = setUp();
    sys.inRepo = false;
    board.project!.title = 'Athya work';
    sys.route('GET', CONTENTS, { status: 200, json: { content: Buffer.from(JSON.stringify({ project: 'Athya work' })).toString('base64') } });
    const { code, out } = await audit(sys, [SLUG]);
    assert.equal(code, 0);
    assert.equal(out[0], `board-audit: ${SLUG} on "Athya work" (${URL})`);
  });

  it('takes "<repo> work" when the settings GitHub has name no Project, or there are none', async () => {
    for (const answer of [{ status: 404, json: null }, { status: 200, json: { content: Buffer.from('{}').toString('base64') } }]) {
      const { sys } = setUp();
      sys.origin = 'https://github.com/example-org/another.git';
      sys.route('GET', CONTENTS, answer);
      const { code, out } = await audit(sys, [SLUG]);
      assert.equal(code, 0, out.join('\n'));
      assert.equal(out[0], `board-audit: ${SLUG} on "example-app work" (${URL})`);
    }
  });

  it('could not run, exit 1: settings GitHub will not give, no such Project, owner or repository', async () => {
    const refused = setUp();
    refused.sys.inRepo = false;
    refused.sys.route('GET', CONTENTS, { status: 403, json: { message: 'Forbidden' } });
    assert.deepEqual(await audit(refused.sys, [SLUG]), { code: 1, out: [], err: [`niyam board-audit: cannot read ${SLUG}'s .github/niyam.json (HTTP 403)`] });

    const none = setUp();
    none.board.project = undefined;
    assert.deepEqual((await audit(none.sys)).err, ['niyam board-audit: example-org has no open Project titled "example-app work"; name it with --project']);

    const closed = setUp();
    closed.board.project!.closed = true;
    assert.equal((await audit(closed.sys)).code, 1);

    const nobody = setUp();
    nobody.board.noOwner = true;
    assert.deepEqual((await audit(nobody.sys)).err, ['niyam board-audit: GitHub shows no owner example-org with Projects']);

    const elsewhere = setUp();
    elsewhere.sys.route('GET', '/repos/example-org/gone/contents/.github/niyam.json', { status: 404, json: null });
    assert.deepEqual(await audit(elsewhere.sys, ['example-org/gone', '--project', 'example-app work']), { code: 1, out: [], err: ['niyam board-audit: GitHub shows no repository example-org/gone'] });
  });

  it('needs GH_TOKEN', async () => {
    const { sys } = setUp();
    sys.env = {};
    const { code, err } = await audit(sys);
    assert.equal(code, 1);
    assert.match(err[0] ?? '', /^niyam board-audit: board-audit needs GH_TOKEN/);
    assert.deepEqual(sys.requests, []);
  });

  it('says it cannot run in a Claude cloud session, whose proxy refuses Projects, and reads nothing', async () => {
    const { sys } = setUp();
    sys.env = { GH_TOKEN: OWNER_TOKEN, CLAUDE_CODE_REMOTE: 'true' };
    const { io, out, err } = capture();
    assert.equal(await boardAudit(sys, io, []), 1);
    assert.deepEqual(out, []);
    assert.deepEqual(err, ["board-audit: cannot run in a Claude cloud session: its GitHub proxy refuses GraphQL and an organisation's Projects (veda-hq/niyam#399), so nothing was checked; run it on a Mac"]);
    assert.deepEqual(sys.requests, []);
  });

  it('takes a repository and --project, and refuses anything else as bad usage', async () => {
    assert.deepEqual(auditArgs([]), {});
    assert.deepEqual(auditArgs(['athya-hq/athya_mono', '--project', 'Athya work']), { slug: 'athya-hq/athya_mono', project: 'Athya work' });
    assert.throws(() => auditArgs(['--project']), /needs the Project's title/);
    assert.throws(() => auditArgs(['--project', '--x']), /needs the Project's title/);
    assert.throws(() => auditArgs(['a/b', 'c/d']), /not "c\/d"/);
    assert.throws(() => auditArgs(['--fix']), /takes \[owner\/repo\] \[--project <title>\], not "--fix"/);
    const { sys } = setUp();
    const { code, err } = await audit(sys, ['--fix']);
    assert.equal(code, 2);
    assert.match(err[0] ?? '', /^niyam: board-audit takes/);
  });
});
