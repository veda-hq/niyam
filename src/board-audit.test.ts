import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { pathsFor, sessionScript } from './agent.ts';
import { auditArgs, boardAudit } from './board-audit.ts';
import { BUILT_IN, Board, OWNER_TOKEN, SLUG, URL } from './fake-board.test.ts';
import { FakeSys, ROOT, capture } from './fake.test.ts';
import { run } from './run.ts';
import type { HttpResult } from './types.ts';

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
  // No audit here reads 30 pages: past them GitHub refuses, so a read that never ends fails at once.
  const answer = sys.routes.get(GRAPHQL) as () => HttpResult;
  let asked = 0;
  sys.route('POST', '/graphql', () => (++asked > 30 ? { status: 500, json: { message: 'read more pages than the board has' } } : answer()));
  return { sys, board };
}

const GRAPHQL = 'POST https://api.github.com/graphql';

/** The board's items with `extra` added to the last page, as GitHub may list them. */
function withItems(sys: FakeSys, extra: Record<string, unknown>[]): void {
  const answer = sys.routes.get(GRAPHQL) as () => HttpResult;
  sys.route('POST', '/graphql', () => {
    const asked = (sys.requests.at(-1)?.body as { query: string }).query;
    const result = answer();
    if (!asked.includes('BoardAuditItems')) return result;
    const { data } = result.json as { data: { node: { items: { nodes: unknown[] } } } };
    return { ...result, json: { data: { node: { ...data.node, items: { ...data.node.items, nodes: [...data.node.items.nodes, ...extra] } } } } };
  });
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

  it('reads a missing issue on a later page', async () => {
    const { sys, board } = setUp();
    board.itemsPerPage = 1;
    board.auditIssues = [{ number: 1, on: [{}] }, { number: 2 }];
    const { code, out } = await audit(sys);
    assert.equal(code, 3);
    assert.ok(out.includes('  #2 Issue 2'), out.join('\n'));
  });

  it('lists the missing and the archived by number', async () => {
    const { sys, board } = setUp();
    board.auditIssues = [{ number: 5 }, { number: 3 }, { number: 4 }, { number: 9, on: [{ archived: true }] }, { number: 6, on: [{ archived: true }] }, { number: 8, on: [{ archived: true }] }];
    const { out } = await audit(sys);
    assert.deepEqual(out.slice(4, 9), [
      `✗ 3 open issues are not on the board: add them at ${URL} (+ Add item, then #N), or gh project item-add`,
      '  #3 Issue 3',
      '  #4 Issue 4',
      '  #5 Issue 5',
      '- 3 open issues are archived on the board, so hidden there; restore any that belong on it: #6, #8, #9',
    ]);
  });

  it('passes over an item with no number or no repository, and names one with no title by its number', async () => {
    const { sys } = setUp();
    withItems(sys, [
      { isArchived: false, status: { name: 'Done' }, content: { __typename: 'Issue', title: 'no number', state: 'OPEN', repository: { nameWithOwner: SLUG } } },
      { isArchived: false, status: { name: 'Done' }, content: { __typename: 'Issue', number: 60, title: 'no repository', state: 'OPEN' } },
      { isArchived: false, status: { name: 'Done' }, content: { __typename: 'Issue', number: 50, state: 'OPEN', repository: { nameWithOwner: SLUG } } },
    ]);
    const { out } = await audit(sys);
    assert.deepEqual(out.slice(-3), [`✗ 1 item's Status disagrees with the issue: set it at ${URL}`, '  #50 is open, Status Done: ', 'board-audit: 1 to fix']);
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

  it("reads another repository's settings from GitHub, even inside a clone with its own", async () => {
    const { sys, board } = setUp({ project: 'Local work' });
    board.project!.title = 'Other work';
    sys.route('GET', '/repos/example-org/other/contents/.github/niyam.json', { status: 200, json: { content: Buffer.from(JSON.stringify({ project: 'Other work' })).toString('base64') } });
    assert.deepEqual((await audit(sys, ['example-org/other'])).err, ['niyam board-audit: GitHub shows no repository example-org/other']);
    assert.equal(sys.requests.find((request) => request.url.endsWith('/repos/example-org/other/contents/.github/niyam.json'))?.token, OWNER_TOKEN);
  });

  it('reads the settings from GitHub in a clone that has none', async () => {
    const { sys, board } = setUp();
    sys.files.delete(SETTINGS);
    board.project!.title = 'Athya work';
    sys.route('GET', CONTENTS, { status: 200, json: { content: Buffer.from(JSON.stringify({ project: 'Athya work' })).toString('base64') } });
    const { code, out } = await audit(sys);
    assert.equal(code, 0);
    assert.equal(out[0], `board-audit: ${SLUG} on "Athya work" (${URL})`);
  });

  it('could not run when GitHub answers the settings with no content, or refuses them with some', async () => {
    for (const [status, json] of [[200, {}], [200, { content: 7 }], [500, { content: Buffer.from('{}').toString('base64') }]] as const) {
      const { sys } = setUp();
      sys.inRepo = false;
      sys.route('GET', CONTENTS, { status, json });
      assert.deepEqual((await audit(sys, [SLUG])).err, [`niyam board-audit: cannot read ${SLUG}'s .github/niyam.json (HTTP ${status})`], JSON.stringify(json));
    }
  });

  it('takes "<repo> work" when the settings GitHub has name no Project, or there are none', async () => {
    for (const answer of [
      { status: 404, json: null },
      { status: 200, json: { content: Buffer.from('{}').toString('base64') } },
      { status: 200, json: { content: Buffer.from('null').toString('base64') } },
      { status: 200, json: { content: Buffer.from('"x"').toString('base64') } },
      { status: 200, json: { content: Buffer.from(JSON.stringify({ project: '   ' })).toString('base64') } },
      { status: 200, json: { content: Buffer.from(JSON.stringify({ project: 7 })).toString('base64') } },
    ]) {
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

  describe('with no GH_TOKEN, as in the owner\'s terminal once niyam machine has signed them out of gh (#548)', () => {
    const AGENT_TOKEN = 'ghp_agent';
    const setUpAgent = (sys: FakeSys, agent: string) =>
      sys.files.set(`${sys.home}/.config/niyam/${agent.toLowerCase()}/session.sh`, sessionScript(agent, 42, pathsFor(sys.home, agent)));
    const readsAs = (sys: FakeSys, token: string) => sys.requests.length > 0 && sys.requests.every((request) => request.token === token);

    it("reads the board as the agent the clone's settings name, with its token from this Mac's keychain", async () => {
      const { sys } = setUp();
      sys.env = {};
      sys.keychain.set('niyam/ExampleBot', AGENT_TOKEN);
      const { code, err } = await audit(sys);
      assert.deepEqual(err, []);
      assert.equal(code, 0);
      assert.ok(readsAs(sys, AGENT_TOKEN));
      const top = sys.calls.find((call) => call.command === 'git' && call.args[0] === 'rev-parse');
      assert.deepEqual([top?.args, top?.cwd], [['rev-parse', '--show-toplevel'], ROOT]);
    });

    it('takes a git that fails as no clone, whatever it printed, and a clone with no settings as none', async () => {
      const failed = setUp({ agent: 'OtherBot' });
      failed.sys.env = {};
      setUpAgent(failed.sys, 'ExampleBot');
      failed.sys.keychain.set('niyam/ExampleBot', AGENT_TOKEN);
      failed.sys.execOverride = (call) => (call.command === 'git' && call.args.join(' ') === 'rev-parse --show-toplevel' ? { code: 128, stdout: `${ROOT}\n`, stderr: 'fatal' } : undefined);
      assert.deepEqual((await audit(failed.sys, [SLUG, '--project', 'example-app work'])).err, []);
      assert.ok(readsAs(failed.sys, AGENT_TOKEN), 'as the one agent set up here, not the OtherBot the settings name');

      const bare = setUp();
      bare.sys.env = {};
      bare.sys.files.delete(SETTINGS);
      setUpAgent(bare.sys, 'ExampleBot');
      bare.sys.keychain.set('niyam/ExampleBot', AGENT_TOKEN);
      assert.deepEqual((await audit(bare.sys, [SLUG, '--project', 'example-app work'])).err, []);
      assert.ok(readsAs(bare.sys, AGENT_TOKEN));
    });

    it("reads the keychain under the login as niyam machine spelled it, whatever case the settings use", async () => {
      const { sys } = setUp({ agent: 'examplebot' });
      sys.env = {};
      setUpAgent(sys, 'ExampleBot');
      sys.keychain.set('niyam/ExampleBot', AGENT_TOKEN);
      const { code, err } = await audit(sys);
      assert.deepEqual(err, []);
      assert.equal(code, 0);
      assert.ok(readsAs(sys, AGENT_TOKEN));
    });

    it("takes a locked session's placeholder as no token: reads nothing, and never the keychain's instead", async () => {
      const { sys } = setUp();
      sys.env = { GH_TOKEN: 'niyam-no-agent-token' };
      sys.keychain.set('niyam/ExampleBot', AGENT_TOKEN);
      assert.deepEqual(await audit(sys), {
        code: 1,
        out: [],
        err: ["niyam board-audit: board-audit has no token: GH_TOKEN is the lock's niyam-no-agent-token, as in a session niyam has not given the agent identity, so nothing was read; run niyam doctor"],
      });
      assert.deepEqual(sys.requests, []);
      assert.ok(!sys.calls.some((call) => call.command === '/usr/bin/security'), 'never reads the keychain');
    });

    it('on a platform with no token store, says GH_TOKEN is needed there, not niyam machine, and reads nothing', async () => {
      const { sys } = setUp();
      sys.env = {};
      sys.platform = 'linux';
      assert.deepEqual(await audit(sys), {
        code: 1,
        out: [],
        err: ["niyam board-audit: board-audit needs GH_TOKEN here, as an agent session has it: niyam supports macOS only, where the keychain holds the agent's token; this machine runs linux"],
      });
      assert.deepEqual(sys.requests, []);
    });

    it('outside a clone, reads as the one agent niyam machine set up on this Mac', async () => {
      const { sys } = setUp();
      sys.env = {};
      sys.inRepo = false;
      setUpAgent(sys, 'ExampleBot');
      sys.keychain.set('niyam/ExampleBot', AGENT_TOKEN);
      const { code, err } = await audit(sys, [SLUG, '--project', 'example-app work']);
      assert.deepEqual(err, []);
      assert.equal(code, 0);
      assert.ok(readsAs(sys, AGENT_TOKEN));
    });

    it("says how to set the agent up, never the owner's gh token, and reads nothing", async () => {
      const none = setUp();
      none.sys.env = {};
      assert.deepEqual(await audit(none.sys), {
        code: 1,
        out: [],
        err: ["niyam board-audit: board-audit needs GH_TOKEN, as an agent session has it, or ExampleBot's token from this Mac's keychain, which holds none; run niyam machine ExampleBot"],
      });

      const nobody = setUp();
      nobody.sys.env = {};
      nobody.sys.inRepo = false;
      assert.deepEqual((await audit(nobody.sys, [SLUG])).err, [
        "niyam board-audit: board-audit needs GH_TOKEN, as an agent session has it, or the agent's token from this Mac's keychain: niyam machine has set up no agent on this Mac; run niyam machine <agent>, or run it in an agent session",
      ]);

      const two = setUp();
      two.sys.env = {};
      two.sys.inRepo = false;
      setUpAgent(two.sys, 'ExampleBot');
      setUpAgent(two.sys, 'OtherBot');
      two.sys.keychain.set('niyam/ExampleBot', AGENT_TOKEN);
      assert.match((await audit(two.sys, [SLUG])).err[0] ?? '', /niyam machine has set up ExampleBot and OtherBot on this Mac, and no \.github\/niyam\.json here names one; run it in a clone of the repository, or in an agent session$/);

      const listed = setUp({ agent: ['ExampleBot', 'OtherBot'] });
      listed.sys.env = {};
      listed.sys.keychain.set('niyam/ExampleBot', AGENT_TOKEN);
      assert.match((await audit(listed.sys)).err[0] ?? '', /names the agents .*, and niyam machine has set up none of them on this machine; or run it in an agent session$/);

      for (const { sys } of [none, nobody, two, listed]) assert.deepEqual(sys.requests, []);
      for (const { sys } of [none, nobody, two, listed]) assert.ok(!sys.calls.some((call) => call.command === 'gh'), 'never asks gh for a token');
    });

    it('in a clone whose settings name several agents, reads as the one niyam machine set up on this Mac', async () => {
      const { sys } = setUp({ agent: ['ExampleBot', 'OtherBot'] });
      sys.env = {};
      setUpAgent(sys, 'OtherBot');
      sys.keychain.set('niyam/OtherBot', AGENT_TOKEN);
      const { code, err } = await audit(sys);
      assert.deepEqual(err, []);
      assert.equal(code, 0);
      assert.ok(readsAs(sys, AGENT_TOKEN));
    });
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
    for (const arg of ['x a/b', 'a/b c', 'a/b/c']) assert.throws(() => auditArgs([arg]), new RegExp(`not "${arg}"`), arg);
    assert.deepEqual(auditArgs(['--project', 'One', 'a/b', '--project', 'Two']), { slug: 'a/b', project: 'Two' }, 'the last --project counts');
    const { sys } = setUp();
    const { code, err } = await audit(sys, ['--fix']);
    assert.equal(code, 2);
    assert.match(err[0] ?? '', /^niyam: board-audit takes/);
  });
});
