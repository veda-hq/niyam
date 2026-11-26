import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AGENT, FakeSys, ROOT, capture } from './fake.test.ts';
import { ALL_FILED, closeIfDone, workDone, workItemDone } from './work-done.ts';

const SLUG = 'example-org/example-app';
const OTHER = 'example-org/example-plans';
const OWNER = 'example-owner';
const OWNERS = [OWNER];
const API = 'https://api.github.com';
const ITEM = `/repos/${SLUG}/issues/10`;
const APPROVED = '2026-10-02T00:00:00Z';
const CLOSED = '2026-10-04T00:00:00Z';
const LATER = '2026-10-05T00:00:00Z';
const FILED = 'The spec.\n\n**Slices:** all filed\n';

type Node = Record<string, unknown>;

/** An issue of `repo`, closed as completed unless `fields` say otherwise. */
const issue = (number: number, fields: Node = {}, repo = SLUG): Node => ({
  number,
  url: `${API}/repos/${repo}/issues/${number}`,
  type: { name: 'Slice' },
  state: 'closed',
  state_reason: 'completed',
  closed_at: CLOSED,
  ...fields,
});

/**
 * GitHub holding Work item #10, approved by the owner, whose spec says its
 * slices are all filed, with slices #12 and #13 closed as completed and no
 * States; `change` alters the model before the routes read it.
 */
function model(change: (m: { item: Node; timeline: Node[]; subIssues: Node[]; states: Map<number, Node[]>; comments: Node[] }) => void = () => {}): FakeSys {
  const m = {
    item: { number: 10, url: `${API}${ITEM}`, type: { name: 'Work item' }, state: 'open', body: FILED, labels: [{ name: 'approved' }] } as Node,
    timeline: [{ event: 'labeled', created_at: APPROVED, actor: { login: OWNER }, label: { name: 'approved' } }] as Node[],
    subIssues: [issue(12), issue(13)],
    states: new Map<number, Node[]>(),
    comments: [] as Node[],
  };
  change(m);
  const sys = new FakeSys();
  sys.route('GET', ITEM, () => ({ status: 200, json: m.item }));
  sys.route('GET', `${ITEM}/timeline?per_page=100&page=1`, () => ({ status: 200, json: m.timeline }));
  sys.route('GET', `${ITEM}/sub_issues?per_page=100&page=1`, () => ({ status: 200, json: m.subIssues }));
  sys.route('GET', `${ITEM}/comments?per_page=100&page=1`, () => ({ status: 200, json: m.comments }));
  for (const one of m.subIssues) {
    sys.route('GET', `${String(one.url)}/sub_issues?per_page=100&page=1`, () => ({ status: 200, json: m.states.get(one.number as number) ?? [] }));
  }
  sys.route('POST', `${ITEM}/comments`, { status: 201, json: {} });
  sys.route('PATCH', ITEM, { status: 200, json: {} });
  return sys;
}

const why = async (sys: FakeSys): Promise<string | undefined> => {
  const verdict = await workItemDone(sys, 'ghs_run', SLUG, 10, OWNERS);
  return verdict.done ? undefined : verdict.why;
};
const writes = (sys: FakeSys): unknown[] => sys.requests.filter((r) => r.method !== 'GET').map((r) => [r.method, r.url.replace(API, ''), r.body]);

describe('ALL_FILED', () => {
  it('reads the line on its own, in any case, with or without a full stop', () => {
    assert.equal(ALL_FILED.test('Spec.\n\n**Slices:** all filed'), true);
    assert.equal(ALL_FILED.test('**slices:**  All Filed.\nmore'), true);
    assert.equal(ALL_FILED.test('**Slices:** all filed but one'), false);
    assert.equal(ALL_FILED.test('The **Slices:** all filed line'), false);
    assert.equal(ALL_FILED.test('**Slices:**\n1. #12'), false);
    assert.equal(ALL_FILED.test('Not the **Slices:** all filed'), false);
    assert.equal(ALL_FILED.test('x**Slices:** all filed'), false);
    assert.equal(ALL_FILED.test('**Slices:** all filedx'), false);
  });
});

describe('workItemDone', () => {
  it('is done when every slice is closed, one of them as completed, and the spec says all are filed', async () => {
    const sys = model();
    const verdict = await workItemDone(sys, 'ghs_run', SLUG, 10, OWNERS);
    assert.equal(verdict.done, true);
    assert.deepEqual(verdict.done && verdict.subIssues.map((one) => one.number), [12, 13]);
    assert.deepEqual([...new Set(sys.requests.map((request) => request.token))], ['ghs_run']);
  });

  it('counts a closed sub-issue of no type, and an issue with no labels at all', async () => {
    assert.equal(await why(model((m) => m.subIssues.push(issue(14, { type: null })))), undefined);
    assert.equal(await why(model((m) => delete m.item.labels)), undefined);
  });

  it('reads no more than the Work item when its spec does not say its slices are all filed', async () => {
    const sys = model(({ item }) => (item.body = 'The spec.\n\n**Slices:**\n1. #12'));
    assert.equal(await why(sys), 'its body has no "**Slices:** all filed" line, so it may have slices still to file');
    assert.deepEqual(sys.requests.map((r) => r.url.replace(API, '')), [ITEM]);
    assert.equal(await why(model(({ item }) => (item.body = null))), 'its body has no "**Slices:** all filed" line, so it may have slices still to file');
  });

  for (const [name, change, line] of [
    ['an issue that is not a Work item', (m: { item: Node }) => (m.item.type = { name: 'Slice' }), 'it is not a Work item'],
    ['an issue with no type', (m: { item: Node }) => (m.item.type = null), 'it is not a Work item'],
    ['a pull request', (m: { item: Node }) => (m.item.pull_request = {}), 'it is not a Work item'],
    ['a Work item closed already', (m: { item: Node }) => (m.item.state = 'closed'), 'it is closed already'],
    ['a Work item an ask waits on', (m: { item: Node }) => (m.item.labels = [{ name: 'approved' }, { name: 'needs-owner' }]), 'an ask waits on it (it is labelled needs-owner)'],
  ] as const) {
    it(`keeps open ${name}`, async () => {
      assert.equal(await why(model(change)), line);
    });
  }

  it('keeps open a Work item the owner has not approved, or whose approved label someone else added or took off', async () => {
    const line = `${OWNER} has not approved it (no approved label of theirs is on it)`;
    assert.equal(await why(model((m) => (m.timeline = []))), line);
    assert.equal(await why(model((m) => ((m.timeline[0] as Node).actor = { login: 'someone' }))), line);
    assert.equal(await why(model((m) => ((m.timeline[0] as Node).actor = null))), line);
    assert.equal(await why(model((m) => m.timeline.push({ event: 'unlabeled', created_at: LATER, actor: { login: OWNER }, label: { name: 'approved' } }))), line);
    assert.equal(
      await why(model((m) => m.timeline.push({ event: 'labeled', created_at: LATER, actor: { login: 'someone' }, label: { name: 'bug' } }, { event: 'commented', created_at: LATER }))),
      undefined,
    );
  });

  it('keeps open a Work item with no sub-issues, or with some GitHub does not list to this token', async () => {
    assert.equal(await why(model((m) => (m.subIssues = []))), 'it has no sub-issues');
    assert.equal(
      await why(model((m) => (m.item.sub_issues_summary = { total: 3 }))),
      'GitHub lists 2 of its 3 sub-issues; the rest cannot be read with this token, so it cannot tell they are closed',
    );
    assert.equal(await why(model((m) => (m.item.sub_issues_summary = { total: 2 }))), undefined);
    assert.equal(await why(model((m) => (m.item.sub_issues_summary = null))), undefined);
  });

  it('keeps open a Work item with a sub-issue still open, of any type, here or in another repository', async () => {
    assert.equal(await why(model((m) => (m.subIssues[1] = issue(13, { state: 'open', closed_at: null })))), '#13 is still open');
    assert.equal(
      await why(model((m) => m.subIssues.push(issue(14, { type: { name: 'Task' }, state: 'open' }), issue(5, { state: 'open' }, OTHER)))),
      `#14, ${OTHER}#5 are still open`,
    );
  });

  it('keeps open a Work item whose closed slice still has an open State, a fix still owed', async () => {
    assert.equal(await why(model((m) => m.states.set(12, [issue(31, { type: { name: 'State' }, state: 'open' })]))), '#31 under its slices is still open');
    assert.equal(
      await why(model((m) => m.states.set(13, [issue(31, { state: 'open' }), issue(32, { state: 'open' })]))),
      '#31, #32 under its slices are still open',
    );
    assert.equal(await why(model((m) => m.states.set(12, [issue(31, { type: { name: 'State' }, state_reason: 'not_planned' })]))), undefined);
  });

  it('keeps open a Work item none of whose slices closed as completed, for the owner', async () => {
    const line = "none of its slices closed as completed, so it built nothing, and closing it is the owner's";
    assert.equal(await why(model((m) => (m.subIssues = [issue(12, { state_reason: 'not_planned' }), issue(13, { state_reason: 'not_planned' })]))), line);
    assert.equal(await why(model((m) => (m.subIssues = [issue(14, { type: { name: 'Task' } })]))), line);
  });

  it('keeps open a Work item reopened after its last sub-issue closed, until one closes after the reopen', async () => {
    const reopened = { event: 'reopened', created_at: LATER };
    assert.equal(await why(model((m) => m.timeline.push(reopened))), 'it was reopened after the last of its sub-issues closed');
    const afterReopen = '2026-10-06T00:00:00Z';
    const slice = model((m) => {
      m.timeline.push(reopened);
      m.subIssues.push(issue(14, { closed_at: afterReopen }));
    });
    assert.equal(await why(slice), undefined);
    const state = model((m) => {
      m.timeline.push(reopened);
      m.states.set(12, [issue(31, { closed_at: afterReopen })]);
    });
    assert.equal(await why(state), undefined);
    const undated = model((m) => {
      m.timeline.push(reopened);
      m.subIssues = [issue(12, { closed_at: null })];
    });
    assert.equal(await why(undated), 'it was reopened after the last of its sub-issues closed');
    assert.equal(await why(model((m) => m.timeline.push({ event: 'reopened', created_at: APPROVED }))), undefined);
    assert.equal(await why(model((m) => m.timeline.push({ event: 'reopened', created_at: CLOSED }))), undefined);
  });

  it('reads every page of a long list', async () => {
    const many = Array.from({ length: 100 }, (_, n) => issue(100 + n));
    const sys = model((m) => (m.subIssues = many));
    sys.route('GET', `${ITEM}/sub_issues?per_page=100&page=2`, { status: 200, json: [issue(300, { state: 'open' })] });
    for (const one of many) sys.route('GET', `${String(one.url)}/sub_issues?per_page=100&page=1`, { status: 200, json: [] });
    assert.equal(await why(sys), '#300 is still open');
  });

  it('fails naming what it could not read', async () => {
    const gone = model();
    gone.route('GET', ITEM, { status: 404, json: { message: 'Not Found' } });
    await assert.rejects(workItemDone(gone, 'ghs_run', SLUG, 10, OWNERS), /^Error: cannot read #10: Not Found \(\/repos\/example-org\/example-app\/issues\/10\)$/);
    const timeline = model();
    timeline.route('GET', `${ITEM}/timeline?per_page=100&page=1`, { status: 502, json: null });
    await assert.rejects(workItemDone(timeline, 'ghs_run', SLUG, 10, OWNERS), /^Error: cannot read #10's timeline: HTTP 502 /);
    const odd = model();
    odd.route('GET', `${ITEM}/sub_issues?per_page=100&page=1`, { status: 200, json: { message: 'odd' } });
    await assert.rejects(workItemDone(odd, 'ghs_run', SLUG, 10, OWNERS), /^Error: cannot read #10's sub-issues: GitHub did not answer a list \(\/repos\/example-org\/example-app\/issues\/10\/sub_issues\)$/);
    const states = model();
    states.route('GET', `${ITEM.replace('/10', '/13')}/sub_issues?per_page=100&page=1`, { status: 500, json: null });
    await assert.rejects(workItemDone(states, 'ghs_run', SLUG, 10, OWNERS), /^Error: cannot read #13's States: HTTP 500 /);
  });
});

describe('closeIfDone', () => {
  it('comments naming its sub-issues and what closed the last, then closes it as completed', async () => {
    const sys = model();
    const { io, out } = capture();
    assert.equal(await closeIfDone(sys, io, 'ghs_run', SLUG, 10, OWNERS, '#40'), true);
    assert.deepEqual(out, ['✓ #10: closed, since all 2 of its sub-issues are closed (#12, #13)']);
    assert.deepEqual(writes(sys), [
      ['POST', `${ITEM}/comments`, { body: 'All of its sub-issues are closed (#12, #13), the last by #40, and its spec says its slices are all filed: closing this Work item.' }],
      ['PATCH', ITEM, { state: 'closed', state_reason: 'completed' }],
    ]);
  });

  it('names no pull request when none is given, and posts no second comment', async () => {
    const sys = model();
    const { io } = capture();
    await closeIfDone(sys, io, 'ghs_run', SLUG, 10, OWNERS);
    assert.deepEqual((writes(sys)[0] as unknown[])[2], { body: 'All of its sub-issues are closed (#12, #13), and its spec says its slices are all filed: closing this Work item.' });
    const again = model((m) => m.comments.push({ body: null }, { body: 'All of its sub-issues are closed (#12, #13), the last by #40, and …' }));
    await closeIfDone(again, io, 'ghs_run', SLUG, 10, OWNERS, '#41');
    assert.deepEqual(writes(again), [['PATCH', ITEM, { state: 'closed', state_reason: 'completed' }]]);
  });

  it('says why a Work item stays open, and writes nothing', async () => {
    const sys = model((m) => (m.subIssues[0] = issue(12, { state: 'open' })));
    const { io, out } = capture();
    assert.equal(await closeIfDone(sys, io, 'ghs_run', SLUG, 10, OWNERS, '#40'), false);
    assert.deepEqual(out, ['- #10 stays open: #12 is still open']);
    assert.deepEqual(writes(sys), []);
  });

  it('says how to fix a workflow that grants no issues: write, and fails on any other refusal', async () => {
    const { io } = capture();
    const unwritable = model();
    unwritable.route('POST', `${ITEM}/comments`, { status: 403, json: { message: 'Resource not accessible by integration' } });
    await assert.rejects(closeIfDone(unwritable, io, 'ghs_run', SLUG, 10, OWNERS), /^Error: cannot comment on #10: Resource not accessible by integration; the client workflow needs issues: write here, so run niyam onboard to update it$/);
    const refused = model();
    refused.route('PATCH', ITEM, { status: 500, json: null });
    await assert.rejects(closeIfDone(refused, io, 'ghs_run', SLUG, 10, OWNERS), /^Error: cannot close #10: HTTP 500$/);
    const unread = model();
    unread.route('GET', `${ITEM}/comments?per_page=100&page=1`, { status: 500, json: null });
    await assert.rejects(closeIfDone(unread, io, 'ghs_run', SLUG, 10, OWNERS), /^Error: cannot read #10's comments: HTTP 500 \(/);
  });
});

describe('workDone', () => {
  const OPEN = `/repos/${SLUG}/issues?state=open&type=Work%20item&per_page=100&page=1`;
  /** The hourly run: Work item #10 as `model` holds it, and the open Work items `open` lists. */
  function hourly(open: Node[], change?: Parameters<typeof model>[0]): FakeSys {
    const sys = model(change);
    sys.env = { GITHUB_REPOSITORY: SLUG, GH_TOKEN: 'ghs_run' };
    sys.route('GET', OPEN, { status: 200, json: open });
    return sys;
  }
  async function run(sys: FakeSys): Promise<string[]> {
    const { io, out } = capture();
    assert.equal(await workDone(sys, io), 0);
    return out;
  }

  it('closes each open Work item that is done, naming no pull request', async () => {
    const sys = hourly([{ number: 10, body: FILED }]);
    assert.deepEqual(await run(sys), ['✓ #10: closed, since all 2 of its sub-issues are closed (#12, #13)']);
    assert.deepEqual(writes(sys), [
      ['POST', `${ITEM}/comments`, { body: 'All of its sub-issues are closed (#12, #13), and its spec says its slices are all filed: closing this Work item.' }],
      ['PATCH', ITEM, { state: 'closed', state_reason: 'completed' }],
    ]);
  });

  it('reads past the list only a Work item whose body says its slices are all filed, and no pull request', async () => {
    const sys = hourly([
      { number: 10, body: FILED },
      { number: 11, body: 'The spec.\n\n**Slices:**\n1. #14' },
      { number: 15, body: null },
      { number: 16, body: FILED, pull_request: {} },
    ], (m) => (m.subIssues[1] = issue(13, { state: 'open' })));
    assert.deepEqual(await run(sys), ['- #10 stays open: #13 is still open']);
    assert.deepEqual(sys.requests.filter((request) => /\/issues\/1[156]\b/.test(request.url)), []);
    assert.deepEqual(writes(sys), []);
  });

  it('says so in one line when no open Work item says its slices are all filed', async () => {
    assert.deepEqual(await run(hourly([])), ['work-done: 0 open Work items, none saying its slices are all filed; nothing to close']);
    assert.deepEqual(await run(hourly([{ number: 11, body: 'No line.' }])), ['work-done: 1 open Work item, none saying its slices are all filed; nothing to close']);
  });

  it('closes nothing with the work rules off, before the repository adopts niyam, or in a personal repository', async () => {
    const off = hourly([{ number: 10, body: FILED }]);
    off.files.set(`${ROOT}/.github/niyam.json`, JSON.stringify({ owner: OWNER, agent: AGENT, features: ['identity'] }));
    assert.deepEqual(await run(off), ['work-done: work-rules is off in .github/niyam.json; nothing to check']);
    const before = hourly([{ number: 10, body: FILED }]);
    before.files.delete(`${ROOT}/.github/niyam.json`);
    assert.match((await run(before))[0] ?? '', /^work-done: /);
    const personal = hourly([{ number: 10, body: FILED }]);
    personal.ownerType = 'User';
    assert.match((await run(personal))[0] ?? '', /^work-done: work-rules is off on a repository owned by a personal account/);
    assert.deepEqual([...writes(off), ...writes(before), ...writes(personal)], []);
    assert.equal([off, before, personal].some((sys) => sys.requests.some((request) => request.url.endsWith(OPEN))), false);
  });

  it('needs the Actions environment, and fails naming a list it cannot read', async () => {
    await assert.rejects(workDone(new FakeSys(), capture().io), /^Error: work-done runs in GitHub Actions: GITHUB_REPOSITORY and GH_TOKEN must be set$/);
    const token = new FakeSys();
    token.env = { GITHUB_REPOSITORY: SLUG };
    await assert.rejects(workDone(token, capture().io), /work-done runs in GitHub Actions/);
    const unread = hourly([]);
    unread.route('GET', OPEN, { status: 403, json: { message: 'Resource not accessible by integration' } });
    await assert.rejects(run(unread), /^Error: cannot read example-org\/example-app's open Work items: Resource not accessible by integration \(\/repos\/example-org\/example-app\/issues\?state=open&type=Work%20item&per_page=100&page=1\)$/);
  });
});
