import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FIELDS, ISSUE_TYPES, LABELS, VIEWS, boardStarted, boardSwept, graphql, setUpBoard, setUpViews, stepDue, viewsChecklist } from './board.ts';
import type { BoardStep } from './board.ts';
import { BUILT_IN, Board, COPY_URL, OWNER_TOKEN, RestBoard, SLUG, STATUS_OPTIONS, STEP_OPTIONS, URL, defaultView, repoJson, settledViews } from './fake-board.test.ts';
import type { FakeItem } from './fake-board.test.ts';
import { FakeSys, capture } from './fake.test.ts';
import type { HttpResult } from './types.ts';

async function setUp(
  sys: FakeSys,
  answers = ['y', 'y', 'y', 'y', 'y'],
): Promise<{ url: string | undefined; byHand: string[] | undefined; out: string[]; err: string[]; steps: BoardStep[] }> {
  sys.answers = [...answers];
  const { io, out, err } = capture();
  const steps: BoardStep[] = [];
  const confirm = async (question: string, step: BoardStep) => {
    steps.push(step);
    return /^y/.test(await sys.ask(question));
  };
  const board = await setUpBoard(sys, io, confirm, SLUG, 'example-owner', OWNER_TOKEN);
  return { url: board?.url, byHand: board?.byHand, out, err, steps };
}

/** Has `answer` give GitHub's GraphQL answer to the queries it answers, and the board answer the rest. */
function intercept(sys: FakeSys, answer: (query: string, variables: Record<string, unknown>) => HttpResult | undefined): void {
  const inner = sys.routes.get('POST https://api.github.com/graphql') as () => HttpResult;
  sys.route('POST', '/graphql', () => {
    const { query, variables } = sys.requests.at(-1)?.body as { query: string; variables: Record<string, unknown> };
    return answer(query, variables) ?? inner();
  });
}

/** The GraphQL requests whose query holds `operation`, by their query and variables. */
const sent = (sys: FakeSys, operation: string): { query: string; variables: Record<string, unknown> }[] =>
  sys.requests.flatMap((r) => (r.url.endsWith('/graphql') && (r.body as { query: string }).query.includes(operation) ? [r.body as { query: string; variables: Record<string, unknown> }] : []));

describe('the work model', () => {
  it('has these labels, views and steps by hand', () => {
    assert.deepEqual(LABELS, [
      { name: 'approved', color: '0e8a16', description: "The owner's approval to start" },
      { name: 'needs-owner', color: 'd93f0b', description: 'Waits on the owner' },
      { name: 'mechanical', color: 'c5def5', description: 'A change with no product decision in it' },
      { name: 'veto', color: 'b60205', description: 'The owner may reverse this routine decision for a week' },
      { name: 'expiring', color: 'fbca04', description: 'An override whose expiry is within 30 days' },
      { name: 'cannot-run-here', color: 'bfd4f2', description: 'A decision check that reads files only a laptop has' },
    ]);
    assert.deepEqual(VIEWS, [
      { name: 'Needs you', layout: 'TABLE_LAYOUT', filter: 'label:needs-owner is:open', show: ['Parent issue'], hide: ['Assignees'] },
      { name: 'Board', layout: 'BOARD_LAYOUT', filter: 'type:Slice,Brief', show: ['Linked pull requests'], hide: [] },
      { name: 'Work items', layout: 'TABLE_LAYOUT', filter: 'type:"Work item"', show: ['Sub-issues progress'], hide: [] },
      { name: 'Decisions', layout: 'TABLE_LAYOUT', filter: 'type:Decision', show: [], hide: [] },
      { name: 'Reviews due', layout: 'TABLE_LAYOUT', filter: '"Review date":<=@today', show: [], hide: [] },
    ]);
    assert.deepEqual(viewsChecklist('https://example.test/p'), [
      "Finish the Project https://example.test/p by hand (GitHub's API cannot):",
      '  [ ] Needs you: add the Type column (+ at the right of the headers → Type, then Save)',
      '  [ ] Work items: group by Step',
      '  [ ] Decisions: group by Decision',
      '  [ ] Workflows → Auto-archive items: is:closed updated:<@today-7d',
    ]);
  });
});

describe('graphql', () => {
  for (const [name, answer, message] of [
    ['an error status, though it gives data', { status: 502, json: { data: {} } }, "GitHub's GraphQL API refused: HTTP 502"],
    ['errors beside its data', { status: 200, json: { data: {}, errors: [{ message: 'one' }, { message: 'two' }] } }, "GitHub's GraphQL API refused: one; two"],
    ['no answer at all', { status: 200, json: null }, "GitHub's GraphQL API refused: HTTP 200"],
    ['an error status with no errors listed', { status: 502, json: {} }, "GitHub's GraphQL API refused: HTTP 502"],
  ] as const) {
    it(`throws when GitHub gives ${name}`, async () => {
      const sys = new FakeSys();
      sys.route('POST', '/graphql', answer);
      await assert.rejects(graphql(sys, 'tok', 'query { viewer { login } }', {}), { message });
    });
  }
});

describe('setUpViews', () => {
  /** A board with the Project's views as `change` leaves the settled ones; returns what setUpViews sent and the views after. */
  async function views(change: (views: ReturnType<typeof settledViews>) => void): Promise<{ sent: string[] | undefined; after: ReturnType<typeof settledViews> }> {
    const sys = new FakeSys();
    const board = new Board(sys);
    const had = settledViews();
    change(had);
    board.project = { fields: [...BUILT_IN, ...FIELDS.map((f) => f.name)], linked: true, views: had, grouped: true };
    const result = await setUpViews(sys, OWNER_TOKEN, async () => true, 'P_1', 'example-app work');
    assert.ok(sent(sys, 'views(first').every(({ query }) => query.includes('views(first: 50) { nodes { id name layout filter configuration { visibleFields(first: 50) { nodes { ... on ProjectV2FieldCommon { name } } } } } }')));
    return { sent: result, after: board.project.views ?? [] };
  }

  it('sends nothing for views that are right', async () => {
    assert.deepEqual((await views(() => {})).sent, []);
  });

  it('hides a column the spec hides, though it shows every column it asks for', async () => {
    const { sent: names, after } = await views((had) => {
      had[0]!.visible = ['Title', 'Assignees', 'Status', 'Parent issue'];
    });
    assert.deepEqual(names, ['Needs you']);
    assert.deepEqual(after[0]?.visible, ['Title', 'Status', 'Parent issue']);
  });

  it('sends no columns for a view whose layout alone is wrong', async () => {
    const { sent: names, after } = await views((had) => {
      had[1]!.layout = 'TABLE_LAYOUT';
    });
    assert.deepEqual(names, []);
    assert.equal(after[1]?.layout, 'BOARD_LAYOUT');
  });

  it("leaves out a visible column the Project's fields do not list", async () => {
    const { sent: names, after } = await views((had) => {
      had[0]!.visible = ['Title', 'Assignees', 'Labels'];
    });
    assert.deepEqual(names, ['Needs you']);
    assert.deepEqual(after[0]?.visible, ['Title', 'Parent issue']);
  });
});

describe('setUpBoard', () => {
  it('builds the Project, its fields and views when the template cannot be copied', async () => {
    const sys = new FakeSys();
    const board = new Board(sys);
    board.template = 'missing';
    const { url, out, err, steps } = await setUp(sys);
    assert.deepEqual(err, []);
    assert.equal(url, URL);
    assert.deepEqual(steps, ['issue types', 'labels', 'project', 'fields', 'views']);
    assert.deepEqual(sys.asked.slice(1, 4), [
      'Add the labels approved, needs-owner, mechanical, veto, expiring, cannot-run-here to example-org/example-app?',
      'Create the Project "example-app work" for example-org from the niyam template, linked to example-org/example-app?',
      'Add the fields Step, Decision, Review date to "example-app work"?',
    ]);
    assert.deepEqual(
      sys.requests.filter((r) => r.method === 'POST' && r.url.endsWith('/labels')).map((r) => r.body),
      LABELS.map(({ name, color, description }) => ({ name, color, description })),
    );
    assert.ok(sys.requests.every((r) => r.token === OWNER_TOKEN));
    assert.deepEqual(board.titles, ['example-app work']);
    assert.deepEqual(board.issueTypes, ['Task', 'Bug', ...ISSUE_TYPES.map((t) => t.name)]);
    assert.deepEqual(board.labels, ['bug', ...LABELS.map((l) => l.name)]);
    assert.deepEqual(board.project?.fields, [...BUILT_IN, ...FIELDS.map((f) => f.name)]);
    assert.deepEqual(board.disabledTypes, ['Task', 'Bug']);
    assert.deepEqual(out.slice(0, 7), [
      '✓ disabled the issue types Task, Bug in example-org, outside the work model, once no issue held them; not deleted, so they can be enabled again',
      '✓ issue types in example-org: Work item, Slice, State, Decision, Brief',
      '✓ labels: approved, needs-owner, mechanical, veto, expiring, cannot-run-here',
      '- the niyam template could not be copied (GitHub shows no Project 4 in athya-hq); building the Project instead',
      `✓ Project "example-app work": ${URL}`,
      '✓ fields: Step, Decision, Review date',
      '✓ views: Needs you, Board, Work items, Decisions, Reviews due',
    ]);
    assert.deepEqual(out.slice(7), viewsChecklist(URL));
    assert.deepEqual(board.project?.views, [
      { id: 'V_1', name: 'Needs you', layout: 'TABLE_LAYOUT', filter: 'label:needs-owner is:open', visible: ['Title', 'Status', 'Parent issue'] },
      { id: 'V_2', name: 'Board', layout: 'BOARD_LAYOUT', filter: 'type:Slice,Brief', visible: ['Title', 'Assignees', 'Status', 'Linked pull requests'] },
      { id: 'V_3', name: 'Work items', layout: 'TABLE_LAYOUT', filter: 'type:"Work item"', visible: ['Title', 'Assignees', 'Status', 'Sub-issues progress'] },
      { id: 'V_4', name: 'Decisions', layout: 'TABLE_LAYOUT', filter: 'type:Decision', visible: ['Title', 'Assignees', 'Status'] },
      { id: 'V_5', name: 'Reviews due', layout: 'TABLE_LAYOUT', filter: '"Review date":<=@today', visible: ['Title', 'Assignees', 'Status'] },
    ]);
    assert.equal(
      sys.asked[0],
      'Issue types are an organisation-wide setting, so they apply to every repository in example-org, not only example-app. In the example-org organisation, add the issue types Work item, Slice, State, Decision, Brief, then disable Task, Bug, which can be enabled again?',
    );
    assert.ok(sys.asked.includes('Set up the views Needs you, Board, Work items, Decisions, Reviews due in "example-app work" (renaming "View 1" to "Needs you")?'));
    assert.ok(sys.requests.filter((r) => r.url.includes('/orgs/') || r.url.includes('/labels') || r.url.endsWith('/graphql')).every((r) => r.token === OWNER_TOKEN));
    const step = sys.requests.find((r) => (r.body as { variables?: { name?: string } } | undefined)?.variables?.name === 'Step');
    assert.deepEqual((step?.body as { variables: unknown }).variables, {
      project: 'P_1',
      name: 'Step',
      type: 'SINGLE_SELECT',
      options: ['Frame', 'Specify', 'Slice', 'Build', 'Done'].map((name) => ({ name, color: 'GRAY', description: '' })),
    });
    const date = sys.requests.find((r) => (r.body as { variables?: { name?: string } } | undefined)?.variables?.name === 'Review date');
    assert.deepEqual((date?.body as { variables: { type: string; options: unknown } }).variables.type, 'DATE');
  });

  it('uses the default title for a blank one', async () => {
    const sys = new FakeSys();
    const board = new Board(sys);
    board.template = 'missing';
    sys.answers = ['y', 'y', 'y', 'y', 'y'];
    await setUpBoard(sys, capture().io, async (q) => /^y/.test(await sys.ask(q)), SLUG, 'example-owner', OWNER_TOKEN, '  ');
    assert.deepEqual(board.titles, ['example-app work']);
  });

  it('asks nothing when everything is there', async () => {
    const sys = new FakeSys();
    const board = new Board(sys);
    board.issueTypes = ISSUE_TYPES.map((t) => t.name.toUpperCase());
    board.labels = LABELS.map((l) => l.name);
    board.project = { fields: [...BUILT_IN, ...FIELDS.map((f) => f.name)], linked: true, views: settledViews(), grouped: true };
    const { url, out } = await setUp(sys, []);
    assert.ok(!out.some((line) => line.startsWith('Finish the Project')));
    assert.equal(url, URL);
    assert.deepEqual(sys.asked, []);
    assert.ok(!board.operations.includes('createProjectV2('));
  });

  it('adds an option a field made before it lacks, sending each kept option with its id', async () => {
    const sys = new FakeSys();
    const board = new Board(sys);
    board.issueTypes = ISSUE_TYPES.map((t) => t.name);
    board.labels = LABELS.map((l) => l.name);
    board.project = { fields: [...BUILT_IN, ...FIELDS.map((f) => f.name)], linked: true, views: settledViews(), grouped: true, options: { Step: ['Frame', 'Specify', 'Slice', 'build'] } };
    const { err, steps } = await setUp(sys, ['y']);
    assert.deepEqual(err, []);
    assert.deepEqual(steps, ['fields']);
    assert.deepEqual(sys.asked, ['Add the option Done to the field Step in "example-app work"?']);
    assert.deepEqual(board.project.options, { Step: ['Frame', 'Specify', 'Slice', 'build', 'Done'] });
    const sent = sys.requests.find((r) => String((r.body as { query?: string } | undefined)?.query).includes('updateProjectV2Field('));
    assert.deepEqual((sent?.body as { variables: unknown }).variables, {
      field: 'F_Step',
      options: [
        ...['Frame', 'Specify', 'Slice', 'build'].map((name) => ({ id: `O_Step_${name}`, name, color: 'GRAY', description: '' })),
        { name: 'Done', color: 'GRAY', description: '' },
      ],
    });
    // A rerun finds the option there and asks nothing.
    sys.asked = [];
    await setUp(sys, []);
    assert.deepEqual(sys.asked, []);
  });

  it('says "options" for two a field lacks', async () => {
    const sys = new FakeSys();
    const board = new Board(sys);
    board.issueTypes = ISSUE_TYPES.map((t) => t.name);
    board.labels = LABELS.map((l) => l.name);
    board.project = { fields: [...BUILT_IN, ...FIELDS.map((f) => f.name)], linked: true, views: settledViews(), grouped: true, options: { Step: ['Frame', 'Specify', 'Slice'] } };
    await setUp(sys, ['n']);
    assert.deepEqual(sys.asked, ['Add the options Build, Done to the field Step in "example-app work"?']);
  });

  it('says "workflow" for one that is off', async () => {
    const sys = new FakeSys();
    const board = new Board(sys);
    board.copyAbsent = [];
    board.copyOff = ['Pull request merged'];
    const { byHand } = await setUp(sys, ['y', 'y', 'y']);
    assert.deepEqual(byHand, [`Once for the board: turn on the workflow Pull request merged at ${COPY_URL}/workflows, which GitHub's API cannot.`]);
  });

  it('skips label entries GitHub gives without a name', async () => {
    const sys = new FakeSys();
    const board = new Board(sys);
    board.issueTypes = ISSUE_TYPES.map((t) => t.name);
    sys.route('GET', `/repos/${SLUG}/labels?per_page=100&page=1`, { status: 200, json: [null, { name: 5 }, ...LABELS.map((l) => ({ name: l.name }))] });
    await setUp(sys);
    assert.ok(!sys.requests.some((r) => r.method === 'POST' && r.url.endsWith('/labels')));
  });

  for (const [name, answer] of [
    ['an error status', { status: 500, json: repoJson() }],
    ['no answer', { status: 200, json: null }],
    ['no node id', { status: 200, json: { ...repoJson(), node_id: 5 } }],
    ['no name', { status: 200, json: { ...repoJson(), name: 5 } }],
    ['no owner', { status: 200, json: { ...repoJson(), owner: null } }],
  ] as const) {
    it(`throws when GitHub's answer for the repository has ${name}`, async () => {
      const sys = new FakeSys();
      new Board(sys);
      sys.route('GET', `/repos/${SLUG}`, answer);
      await assert.rejects(setUp(sys), { message: `cannot read example-org/example-app as example-owner (HTTP ${answer.status})` });
    });
  }

  it('builds the Project when GitHub shows no template organisation', async () => {
    const sys = new FakeSys();
    new Board(sys);
    intercept(sys, (query) => (query.includes('projectV2(number') ? { status: 200, json: { data: { organization: null } } } : undefined));
    const { out } = await setUp(sys);
    assert.ok(out.includes('- the niyam template could not be copied (GitHub shows no Project 4 in athya-hq); building the Project instead'));
  });

  it("waits for every field of a copy, not only some of them", async () => {
    const sys = new FakeSys();
    new Board(sys);
    let partial = true;
    intercept(sys, (query, variables) => {
      if (query !== 'query($id: ID!) { node(id: $id) { ... on ProjectV2 { fields(first: 50) { nodes { ... on ProjectV2FieldCommon { name } } } } } }' || variables.id !== 'P_2' || !partial) return undefined;
      partial = false;
      return { status: 200, json: { data: { node: { fields: { nodes: [{ name: 'Title' }, { name: 'Step' }] } } } } };
    });
    await setUp(sys, ['y', 'y', 'y']);
    assert.deepEqual(sys.slept, [3000]);
  });

  for (const [name, groups] of [
    ['only some of its views are grouped', { 'Work items': ['Step'], Decisions: [] }],
    ['other views hold the grouping', { Board: ['Step'], Mine: ['Decision'], 'Work items': [], Decisions: [] }],
    ['its views are grouped by other fields', { 'Work items': ['Status'], Decisions: ['Status'] }],
  ] as const) {
    it(`offers to replace a Project when ${name}`, async () => {
      const sys = new FakeSys();
      const board = new Board(sys);
      board.issueTypes = ISSUE_TYPES.map((t) => t.name);
      board.labels = LABELS.map((l) => l.name);
      board.project = { fields: [...BUILT_IN, ...FIELDS.map((f) => f.name)], linked: true, views: settledViews(), grouped: true };
      const nodes = Object.entries(groups).map(([view, by]) => ({ name: view, groupByFields: { nodes: (by as readonly string[]).map((field) => ({ name: field })) } }));
      intercept(sys, (query) => (query.includes('groupByFields') ? { status: 200, json: { data: { node: { views: { nodes }, workflows: { nodes: [] } } } } } : undefined));
      const { steps } = await setUp(sys, ['n']);
      assert.match(sys.asked[0] ?? '', /^"example-app work" lacks what only the niyam template sets/);
      assert.deepEqual(steps, ['replace']);
    });
  }

  it('adds no option to a field the work model gives none, though the owner gave it some', async () => {
    const sys = new FakeSys();
    const board = new Board(sys);
    board.issueTypes = ISSUE_TYPES.map((t) => t.name);
    board.labels = LABELS.map((l) => l.name);
    board.project = { fields: [...BUILT_IN, ...FIELDS.map((f) => f.name)], linked: true, views: settledViews(), grouped: true, options: { 'Review date': ['Soon'] } };
    const { url } = await setUp(sys, []);
    assert.equal(url, URL);
    assert.deepEqual(sys.asked, []);
  });

  it('stops when the owner says no to an option', async () => {
    const sys = new FakeSys();
    const board = new Board(sys);
    board.issueTypes = ISSUE_TYPES.map((t) => t.name);
    board.labels = LABELS.map((l) => l.name);
    board.project = { fields: [...BUILT_IN, ...FIELDS.map((f) => f.name)], linked: true, views: settledViews(), grouped: true, options: { Step: ['Frame'], Decision: ['Tripped'] } };
    const { url, err } = await setUp(sys, ['n']);
    assert.equal(url, undefined);
    assert.deepEqual(sys.asked, ['Add the options Specify, Slice, Build, Done to the field Step and Needs owner, Decided by the routine to the field Decision in "example-app work"?']);
    assert.deepEqual(err, ['onboard: stopped at "fields"; nothing after it was changed, and no pull request was opened']);
    assert.ok(!board.operations.includes('updateProjectV2Field('));
  });

  it('names only the issue types the organisation lacks, saying they reach every repository in it', async () => {
    const sys = new FakeSys();
    const board = new Board(sys);
    board.issueTypes = ['Task', 'Work item', 'Slice', 'State'];
    board.labels = LABELS.map((l) => l.name);
    board.project = { fields: [...BUILT_IN, ...FIELDS.map((f) => f.name)], linked: true, views: settledViews(), grouped: true };
    await setUp(sys, ['y']);
    assert.deepEqual(sys.asked, [
      'Issue types are an organisation-wide setting, so they apply to every repository in example-org, not only example-app. In the example-org organisation, add the issue types Decision, Brief, then disable Task, which can be enabled again?',
    ]);
    assert.deepEqual(board.issueTypes, ['Task', 'Work item', 'Slice', 'State', 'Decision', 'Brief']);
    assert.deepEqual(board.disabledTypes, ['Task']);
  });

  it('skips issue types for a personal repository', async () => {
    const sys = new FakeSys();
    new Board(sys, false);
    sys.acceptToken(OWNER_TOKEN, 'example-owner', { 'x-oauth-scopes': 'project' });
    const { url, out } = await setUp(sys, ['y', 'y', 'y', 'y']);
    assert.equal(url, COPY_URL);
    assert.equal(out[0], '- issue types: GitHub has them for organisations only; skipped for a personal repository');
  });

  it('copies the template for a new Project, links it, and leaves only Auto-add to project by hand', async () => {
    const sys = new FakeSys();
    const board = new Board(sys);
    board.copyPending = 2;
    const { url, out, err, byHand } = await setUp(sys, ['y', 'y', 'y']);
    assert.deepEqual(err, []);
    assert.equal(url, COPY_URL);
    // The template's copy lacks it, as it names a repository, and GitHub's API cannot add it.
    assert.deepEqual(byHand, [
      `Once for the board: at ${COPY_URL}/workflows, add the workflow Auto-add to project, for the repository example-org/example-app with the filter is:issue is:open, which GitHub's API cannot; then niyam board-audit lists the open issues still not on the board.`,
    ]);
    assert.deepEqual(board.titles, ['example-app work']);
    assert.ok(board.project?.linked);
    assert.deepEqual(sys.slept, [3000, 3000], 'waits for the fields GitHub adds after the copy');
    assert.deepEqual(sys.asked.slice(2), ['Create the Project "example-app work" for example-org from the niyam template, linked to example-org/example-app?']);
    assert.deepEqual(out.slice(3), [
      `✓ Project "example-app work": ${COPY_URL}`,
      '✓ fields: Step, Decision, Review date',
      '✓ views: Needs you, Board, Work items, Decisions, Reviews due',
      "- Board shows slices and briefs; Done keeps one until the Auto-archive items workflow archives it, with the template's filter is:closed updated:<@today-7d, which GitHub's API can neither read nor set",
      `Add the workflow Auto-add to project, for the repository example-org/example-app with the filter is:issue is:open in ${COPY_URL} → Workflows (GitHub's API cannot); it adds issues as they open or change, not those already open, which niyam board-audit lists`,
    ]);
    assert.ok(!board.operations.some((o) => o === 'createProjectV2(' || o === 'createProjectV2Field' || o.includes('ProjectV2View')));
  });

  it('names both auto-add workflows when a Project has neither, as veda-hq\'s "niyam work" had no Auto-add to project', async () => {
    const sys = new FakeSys();
    const board = new Board(sys);
    board.copyAbsent = ['Auto-add to project', 'Auto-add sub-issues to project'];
    const { out, byHand } = await setUp(sys, ['y', 'y', 'y']);
    const steps = 'Auto-add to project, for the repository example-org/example-app with the filter is:issue is:open; Auto-add sub-issues to project, turned on';
    assert.equal(out.at(-1), `Add the workflows ${steps} in ${COPY_URL} → Workflows (GitHub's API cannot); it adds issues as they open or change, not those already open, which niyam board-audit lists`);
    assert.deepEqual(byHand, [`Once for the board: at ${COPY_URL}/workflows, add the workflows ${steps}, which GitHub's API cannot; then niyam board-audit lists the open issues still not on the board.`]);
  });

  it('asks for no auto-add workflow a Project has set up', async () => {
    const sys = new FakeSys();
    const board = new Board(sys);
    board.copyAbsent = [];
    const { out, byHand } = await setUp(sys, ['y', 'y', 'y']);
    assert.deepEqual(byHand, []);
    assert.ok(!out.some((line) => line.startsWith('Add the workflow')));
  });

  it("names a copy's workflows that are off", async () => {
    const sys = new FakeSys();
    const board = new Board(sys);
    board.copyAbsent = [];
    board.copyOff = ['Item added to project', 'Pull request merged'];
    const { out, byHand } = await setUp(sys, ['y', 'y', 'y']);
    assert.equal(out.at(-1), `Turn on the workflows Item added to project, Pull request merged in ${COPY_URL} → Workflows (GitHub's API cannot)`);
    assert.deepEqual(byHand, [`Once for the board: turn on the workflows Item added to project, Pull request merged at ${COPY_URL}/workflows, which GitHub's API cannot.`]);
    assert.ok(!out.some((line) => line.startsWith('Finish the Project')));
  });

  it("throws when a copy's fields never arrive", async () => {
    const sys = new FakeSys();
    const board = new Board(sys);
    board.copyPending = 100;
    await assert.rejects(setUp(sys), new Error(`the copy ${COPY_URL} has no fields Step, Decision, Review date yet; run onboard again`));
    assert.equal(sys.slept.length, 19);
  });

  it('builds the Project when GitHub refuses the copy', async () => {
    const sys = new FakeSys();
    const board = new Board(sys);
    board.template = 'refused';
    const { url, out } = await setUp(sys);
    assert.equal(url, URL);
    assert.ok(out.includes("- the niyam template could not be copied (GitHub's GraphQL API refused: Resource not accessible by integration); building the Project instead"));
    assert.deepEqual(out.slice(-viewsChecklist(URL).length), viewsChecklist(URL));
    assert.ok(board.operations.includes('createProjectV2('));
  });

  /** A Project made before the template: not grouped, with items and a field the template lacks. */
  function older(board: Board, items: FakeItem[]): void {
    board.issueTypes = ISSUE_TYPES.map((t) => t.name);
    board.labels = LABELS.map((l) => l.name);
    board.project = { fields: [...BUILT_IN, ...FIELDS.map((f) => f.name), 'Estimate', 'Notes'], linked: true, views: settledViews(), items };
  }

  it('replaces a Project made before the template with a copy, moving its open items and their values', async () => {
    const sys = new FakeSys();
    const board = new Board(sys);
    older(board, [
      { content: 'ISSUE_a', values: { Status: 'In Progress', Step: 'Build', 'Review date': '2026-11-01', Estimate: 3, Notes: 'n' } },
      { draft: { title: 'An idea', body: 'Some words' }, values: { Decision: 'Tripped' } },
      { content: 'ISSUE_old', archived: true, values: { Status: 'Done' } },
      { content: 'ISSUE_c', values: { Step: 'Gone' } },
      { content: 'ISSUE_done', state: 'CLOSED', values: {} },
      { content: 'PR_merged', state: 'MERGED', values: {} },
      { content: 'PR_open', state: 'OPEN', values: {} },
    ]);
    const { url, out, err } = await setUp(sys, ['y']);
    assert.deepEqual(err, []);
    assert.equal(url, COPY_URL);
    assert.deepEqual(sys.asked, [
      '"example-app work" lacks what only the niyam template sets (the views\' grouping, the workflows). Replace it with a copy of the template, moving its 4 open items with their Status, Step, Decision and Review date (not Estimate, Notes, which the template lacks), and close it as "example-app work (old)"?',
    ]);
    assert.deepEqual(board.project?.items, [
      { content: 'ISSUE_a', values: { Status: 'In progress', Step: 'Build', 'Review date': '2026-11-01' } },
      { draft: { title: 'An idea', body: 'Some words' }, values: { Decision: 'Tripped' } },
      { content: 'ISSUE_c', values: {} },
      { content: 'PR_open', values: {} },
    ]);
    assert.ok(board.project?.linked);
    const order = board.operations.filter((o) => o === 'updateProjectV2(' || o === 'copyProjectV2');
    assert.deepEqual(order, ['updateProjectV2(', 'copyProjectV2', 'updateProjectV2('], 'renamed before the copy, closed after the move');
    assert.deepEqual(sent(sys, 'updateProjectV2('), [
      { query: 'mutation($project: ID!, $title: String!) { updateProjectV2(input: { projectId: $project, title: $title }) { projectV2 { id } } }', variables: { project: 'P_1', title: 'example-app work (old)' } },
      { query: 'mutation($project: ID!, $title: String!) { updateProjectV2(input: { projectId: $project, title: $title, closed: true }) { projectV2 { id } } }', variables: { project: 'P_1', title: 'example-app work (old)' } },
    ]);
    assert.ok(sent(sys, 'items(first').every(({ query }) => query.includes('... on ProjectV2ItemFieldTextValue { text field { ... on ProjectV2FieldCommon { name } } }')));
    assert.deepEqual({ title: board.old?.title, closed: board.old?.closed }, { title: 'example-app work (old)', closed: true });
    assert.deepEqual(out.slice(2, 4), [
      `✓ moved 4 items to the copy; closed the old Project as "example-app work (old)": ${URL}`,
      `✓ Project "example-app work": ${COPY_URL}`,
    ]);
    assert.ok(!out.some((line) => line.startsWith('Finish the Project')));
  });

  it('moves text and number values to a copy that has their fields, and a date to a field with options', async () => {
    const sys = new FakeSys();
    const board = new Board(sys);
    older(board, [{ content: 'ISSUE_a', values: { Step: 'Build', 'Review date': '2026-11-01', Estimate: 3, Notes: 'n' } }]);
    intercept(sys, (query) => {
      // moveItems' read of the copy's fields: give it Notes and Estimate, and options on Review date that no value names.
      if (!query.includes('options { id name } }')) return undefined;
      const answer = board.graphql(sys.requests.at(-1)?.body as { query: string; variables: Record<string, unknown> }) as { status: number; json: { data: { node: { fields: { nodes: Record<string, unknown>[] } } } } };
      const nodes = answer.json.data.node.fields.nodes;
      for (const node of nodes) if (node.name === 'Review date') node.options = [{ id: 'O_x', name: 'x' }];
      nodes.push({ id: 'F_Notes', name: 'Notes' }, { id: 'F_Estimate', name: 'Estimate' });
      return answer;
    });
    await setUp(sys, ['y']);
    assert.deepEqual(board.project?.items, [{ content: 'ISSUE_a', values: { Step: 'Build', 'Review date': '2026-11-01', Estimate: 3, Notes: 'n' } }]);
  });

  it('moves every page of items, and says "item" for one', async () => {
    const sys = new FakeSys();
    const board = new Board(sys);
    older(board, [{ content: 'ISSUE_a', values: {} }]);
    board.project!.fields = [...BUILT_IN, ...FIELDS.map((f) => f.name)];
    board.itemsPerPage = 1;
    board.project!.items!.push({ content: 'ISSUE_b', values: {} }, { content: 'ISSUE_c', values: {} });
    await setUp(sys, ['y']);
    assert.deepEqual(board.project?.items?.map((item) => item.content), ['ISSUE_a', 'ISSUE_b', 'ISSUE_c']);

    const one = new FakeSys();
    const single = new Board(one);
    older(single, [{ content: 'ISSUE_a', values: {} }]);
    single.project!.fields = [...BUILT_IN, ...FIELDS.map((f) => f.name)];
    const { out } = await setUp(one, ['y']);
    assert.match(one.asked[0] ?? '', /moving its 1 open item with their Status, Step, Decision and Review date, and close it/);
    assert.ok(out.includes(`✓ moved 1 item to the copy; closed the old Project as "example-app work (old)": ${URL}`));
  });

  it('keeps a Project made before the template when the owner says no, naming what is left to do', async () => {
    const sys = new FakeSys();
    const board = new Board(sys);
    older(board, [{ content: 'ISSUE_a', values: {} }]);
    const { url, out, byHand } = await setUp(sys, ['n']);
    assert.equal(url, URL);
    assert.deepEqual(byHand, [`Once for the board: at ${URL}, add the Type column to Needs you, group Work items by Step and Decisions by Decision, and set the Auto-archive items workflow to is:closed updated:<@today-7d, which GitHub's API cannot.`]);
    assert.ok(!board.operations.includes('copyProjectV2'));
    assert.equal(board.project?.closed, undefined);
    assert.deepEqual(out.slice(-viewsChecklist(URL).length), viewsChecklist(URL));
  });

  it('keeps a Project made before the template when GitHub refuses the copy', async () => {
    const sys = new FakeSys();
    const board = new Board(sys);
    older(board, [{ content: 'ISSUE_a', values: {} }]);
    board.template = 'refused';
    const { url, out } = await setUp(sys, ['y']);
    assert.equal(url, URL);
    assert.deepEqual({ title: board.project?.title, closed: board.project?.closed }, { title: 'example-app work', closed: undefined }, 'renamed back, its closed state untouched');
    assert.ok(out.includes("- the niyam template could not be copied (GitHub's GraphQL API refused: Resource not accessible by integration); keeping the Project as it is"));
    assert.deepEqual(out.slice(-viewsChecklist(URL).length), viewsChecklist(URL));
  });

  for (const [index, step] of ['issue types', 'labels', 'project', 'fields', 'views'].entries()) {
    it(`stops when "${step}" is declined, changing nothing from it on`, async () => {
      const sys = new FakeSys();
      const board = new Board(sys);
      board.template = 'missing';
      const { url, err } = await setUp(sys, [...Array<string>(index).fill('y'), 'n']);
      assert.deepEqual({ url, err }, { url: undefined, err: [`onboard: stopped at "${step}"; nothing after it was changed, and no pull request was opened`] });
      assert.equal(board.issueTypes.length, index > 0 ? 7 : 2);
      assert.equal(board.labels.length, index > 1 ? 7 : 1);
      assert.equal(board.project === undefined, index < 3);
      assert.deepEqual(board.project?.fields ?? [], index === 3 ? BUILT_IN : index === 4 ? [...BUILT_IN, ...FIELDS.map((f) => f.name)] : []);
      assert.deepEqual(board.project?.views ?? [], index > 2 ? [defaultView()] : []);
    });
  }

  it("links a same-titled Project that is not linked to the repo", async () => {
    const sys = new FakeSys();
    const board = new Board(sys);
    board.project = { fields: FIELDS.map((f) => f.name), linked: false, views: settledViews(), grouped: true };
    const { url, steps } = await setUp(sys, ['y', 'y', 'y']);
    assert.equal(url, URL);
    assert.ok(steps.includes('link'));
    assert.ok(board.project.linked);
    assert.ok(sys.asked.includes('Link the Project "example-app work" to example-org/example-app?'));
  });

  it('stops when linking is declined', async () => {
    const sys = new FakeSys();
    const board = new Board(sys);
    board.project = { fields: FIELDS.map((f) => f.name), linked: false, grouped: true };
    const { err } = await setUp(sys, ['y', 'y', 'n']);
    assert.deepEqual(err, ['onboard: stopped at "project"; nothing after it was changed, and no pull request was opened']);
    assert.equal(board.project.linked, false);
  });

  it('finds the Project on a later page instead of making another', async () => {
    const sys = new FakeSys();
    const board = new Board(sys);
    board.project = { fields: FIELDS.map((f) => f.name), linked: true, views: settledViews(), grouped: true };
    board.otherPages = 2;
    await setUp(sys, ['y', 'y']);
    assert.deepEqual(board.operations.filter((o) => o === 'projectsV2('), ['projectsV2(', 'projectsV2(', 'projectsV2(']);
    assert.ok(!board.operations.includes('createProjectV2('));
  });

  it('reads every page of labels before adding any', async () => {
    const sys = new FakeSys();
    const board = new Board(sys);
    board.issueTypes = ISSUE_TYPES.map((t) => t.name);
    const many = Array.from({ length: 100 }, (_, i) => ({ name: `l${i}` }));
    sys.route('GET', `/repos/${SLUG}/labels?per_page=100&page=1`, { status: 200, json: many });
    sys.route('GET', `/repos/${SLUG}/labels?per_page=100&page=2`, { status: 200, json: LABELS.map((l) => ({ name: l.name })) });
    await setUp(sys, ['y', 'y']);
    assert.ok(!sys.requests.some((r) => r.method === 'POST' && r.url.endsWith('/labels')));
  });

  it('updates the views that have the names, and makes the missing ones, leaving others alone', async () => {
    const sys = new FakeSys();
    const board = new Board(sys);
    const views = settledViews();
    views[1] = { ...views[1]!, layout: 'TABLE_LAYOUT', filter: 'is:open', visible: ['Title', 'Assignees'] };
    board.project = { fields: [...BUILT_IN, ...FIELDS.map((f) => f.name)], linked: true, views: [...views.slice(0, 4), { id: 'V_9', name: 'Mine', layout: 'TABLE_LAYOUT', filter: null, visible: ['Title'] }], grouped: true };
    const { out } = await setUp(sys, ['y', 'y', 'y']);
    assert.ok(out.includes('✓ views: Needs you, Board, Work items, Decisions, Reviews due'));
    assert.ok(sys.asked.includes('Set up the views Board, Reviews due in "example-app work"?'));
    assert.deepEqual(board.project.views?.map((v) => v.name), ['Needs you', 'Board', 'Work items', 'Decisions', 'Mine', 'Reviews due']);
    assert.deepEqual(board.project.views?.[1], { id: 'V_2', name: 'Board', layout: 'BOARD_LAYOUT', filter: 'type:Slice,Brief', visible: ['Title', 'Assignees', 'Linked pull requests'] });
    assert.deepEqual(board.project.views?.[4], { id: 'V_9', name: 'Mine', layout: 'TABLE_LAYOUT', filter: null, visible: ['Title'] });
  });

  it('makes no duplicates when run again', async () => {
    const sys = new FakeSys();
    const board = new Board(sys);
    await setUp(sys);
    const asked = sys.asked.length;
    const { url } = await setUp(sys, []);
    assert.equal(url, COPY_URL);
    assert.equal(sys.asked.length, asked);
    assert.deepEqual(board.titles, ['example-app work']);
    assert.deepEqual(board.project?.views?.map((v) => v.name), VIEWS.map((v) => v.name));
    assert.ok(!board.operations.some((o) => o.includes('ProjectV2View') || o === 'createProjectV2Field'));
  });

  it('hides Assignees on Needs you and shows Parent issue, keeping columns the owner added, then leaves it', async () => {
    const sys = new FakeSys();
    const board = new Board(sys);
    const views = settledViews();
    views[0] = { ...views[0]!, visible: ['Title', 'Assignees', 'Status', 'Linked pull requests', 'Sub-issues progress'] };
    board.project = { fields: [...BUILT_IN, ...FIELDS.map((f) => f.name)], linked: true, views, grouped: true };
    const { out, byHand } = await setUp(sys, ['y', 'y', 'y']);
    assert.ok(sys.asked.includes('Set up the views Needs you in "example-app work"?'));
    assert.deepEqual(board.project.views?.[0]?.visible, ['Title', 'Status', 'Linked pull requests', 'Sub-issues progress', 'Parent issue']);
    assert.deepEqual(board.project.views?.slice(1), settledViews().slice(1));
    // The column list could not name Type, so the owner is told how to show it again.
    const again = `Needs you's columns were set through GitHub's API, which cannot see a Type column, so one shown there may be gone; in ${URL}: Needs you: add the Type column (+ at the right of the headers → Type, then Save)`;
    assert.ok(out.includes(again));
    assert.deepEqual(byHand, [`Once for the board: at ${URL}, add the Type column to Needs you again, which GitHub's API cannot.`]);
    // A rerun sends no columns, so a Type the owner adds stays.
    const operations = board.operations.length;
    const rerun = await setUp(sys, ['y', 'y']);
    assert.ok(!board.operations.slice(operations).some((o) => o.includes('ProjectV2View')));
    assert.ok(!rerun.out.includes(again));
    assert.deepEqual(rerun.byHand, []);
  });

  it('changes no columns of a view whose fields are right but whose filter is not', async () => {
    const sys = new FakeSys();
    const board = new Board(sys);
    const views = settledViews();
    views[3] = { ...views[3]!, filter: 'is:open', visible: ['Title', 'Status', 'Labels'] };
    board.project = { fields: [...BUILT_IN, ...FIELDS.map((f) => f.name)], linked: true, views, grouped: true };
    const { byHand } = await setUp(sys, ['y', 'y', 'y']);
    assert.deepEqual(board.project.views?.[3], { ...settledViews()[3]!, visible: ['Title', 'Status', 'Labels'] });
    const update = sys.requests.find((r) => String((r.body as { query?: string } | undefined)?.query).includes('updateProjectV2View'));
    assert.equal((update?.body as { variables: { configuration: unknown } }).variables.configuration, null);
    assert.deepEqual(byHand, []);
  });

  it('renames the default view to the first view the Project lacks, with no other change', async () => {
    const sys = new FakeSys();
    const board = new Board(sys);
    const views = settledViews();
    board.project = { fields: [...BUILT_IN, ...FIELDS.map((f) => f.name)], linked: true, views: [views[0]!, { ...views[1]!, name: 'View 1' }, ...views.slice(2)], grouped: true };
    await setUp(sys, ['y', 'y', 'y']);
    assert.ok(sys.asked.includes('Set up the views Board in "example-app work" (renaming "View 1" to "Board")?'));
    assert.deepEqual(board.project.views, settledViews());
    assert.deepEqual(board.operations.filter((o) => o.includes('View')), ['updateProjectV2View']);
  });

  it('leaves a default view alone once every view is there', async () => {
    const sys = new FakeSys();
    const board = new Board(sys);
    const spare = { id: 'V_9', name: 'View 1', layout: 'TABLE_LAYOUT', filter: null, visible: ['Title'] };
    board.project = { fields: [...BUILT_IN, ...FIELDS.map((f) => f.name)], linked: true, views: [spare, ...settledViews()], grouped: true };
    await setUp(sys, ['y', 'y']);
    assert.ok(!sys.asked.some((q) => q.startsWith('Set up the views')));
    assert.deepEqual(board.project.views, [spare, ...settledViews()]);
    assert.ok(!board.operations.some((o) => o.includes('ProjectV2View')));
  });

  for (const [name, change, message] of [
    ['the repo', (sys: FakeSys) => sys.route('GET', `/repos/${SLUG}`, { status: 404, json: null }), /cannot read example-org\/example-app as example-owner \(HTTP 404\)/],
    ['the issue types', (sys: FakeSys) => sys.route('GET', '/orgs/example-org/issue-types?per_page=100&page=1', { status: 403, json: null }), /cannot read https:\/\/api\.github\.com\/orgs\/example-org\/issue-types \(HTTP 403\)/],
    ['adding an issue type', (sys: FakeSys) => sys.route('POST', '/orgs/example-org/issue-types', { status: 422, json: null }), /did not add the issue type Work item \(HTTP 422\)/],
    ['adding a label', (sys: FakeSys) => sys.route('POST', `/repos/${SLUG}/labels`, { status: 422, json: null }), /did not add the label approved \(HTTP 422\)/],
    ['GraphQL', (sys: FakeSys) => sys.route('POST', '/graphql', { status: 200, json: { errors: [{ message: 'no project scope' }] } }), /GraphQL API refused: no project scope/],
    ['GraphQL by status', (sys: FakeSys) => sys.route('POST', '/graphql', { status: 502, json: null }), /GraphQL API refused: HTTP 502/],
    ['the owner', (sys: FakeSys) => sys.route('POST', '/graphql', { status: 200, json: { data: { organization: null } } }), /GitHub has no organization example-org/],
  ] as const) {
    it(`throws when GitHub refuses ${name}`, async () => {
      const sys = new FakeSys();
      new Board(sys);
      change(sys);
      await assert.rejects(setUp(sys), message);
    });
  }
});

describe('boardStarted', () => {
  const ISSUE = `https://api.github.com/repos/${SLUG}/issues`;
  /** Slice #12, open, under work item #10, read through REST. */
  function slice(sys: FakeSys, parent: { status: number; json: unknown } = { status: 200, json: { number: 10, type: { name: 'Work item' } } }): void {
    sys.route('GET', `${ISSUE}/12`, { status: 200, json: { number: 12, state: 'open', url: `${ISSUE}/12`, type: { name: 'Slice' } } });
    sys.route('GET', `${ISSUE}/12/parent`, parent);
  }

  it("moves a user's own board, reading every page", async () => {
    const sys = new FakeSys();
    slice(sys);
    const board = new RestBoard(sys, 'users');
    board.perPage = 1;
    board.projects.unshift({ number: 1, title: 'old', closed: true, fields: { Status: STATUS_OPTIONS }, items: [{ issue: 12, values: {} }] });
    board.workItems = [22, 21, 20, 10];
    board.projects[1]!.items.push({ issue: 22, values: {} });
    assert.deepEqual(await boardStarted(sys, 'tok', SLUG, 12), [
      '✓ board: slice #12 is In Progress in "example-app work"',
      '✓ board: work item #10 is at Step Build in "example-app work"',
      '✓ board: work item #22 had no Step; it is at Frame in "example-app work"',
      '✓ board: work item #20 had no Step; it is at Frame in "example-app work"',
    ]);
    // A closed Project is not anyone's board.
    assert.ok(!sys.requests.some((r) => r.url.includes('/projectsV2/1/')));
    assert.ok(sys.requests.some((r) => r.url.startsWith('https://api.github.com/users/example-org/projectsV2?')));
  });

  it('moves only open issues of this repository, on the board and not archived', async () => {
    const sys = new FakeSys();
    slice(sys);
    const board = new RestBoard(sys);
    board.projects[0]!.items = [
      { issue: 12, repo: 'example-org/other', values: { Status: 'Todo' } },
      { issue: 12, kind: 'PullRequest', values: { Status: 'Todo' } },
      { issue: 12, kind: 'DraftIssue', values: {} },
      { issue: 10, archived: true, values: { Step: 'Slice' } },
      // An issue that is not an open Work item keeps no Step.
      { issue: 31, values: {} },
      { issue: 30, values: {} },
    ];
    // None of those items is slice #12 on this repository's board, so it says the slice is not on the board.
    assert.deepEqual(await boardStarted(sys, 'tok', SLUG, 12), [
      '! board: slice #12 is not on the board: no open Project of example-org with a Status field holds it unarchived, so it did not move to In Progress',
    ]);
    assert.deepEqual(board.writes, []);
  });

  it('says a slice missing from the board is not on it, and still moves its work item', async () => {
    const sys = new FakeSys();
    slice(sys);
    const board = new RestBoard(sys);
    board.projects[0]!.items = board.projects[0]!.items.filter((item) => item.issue !== 12);
    board.projects.push({ number: 5, title: 'roadmap', fields: { Title: null, Step: STEP_OPTIONS }, items: [{ issue: 12, values: {} }] });
    board.projects.push({ number: 6, title: 'notes', fields: { Title: null }, items: [{ issue: 12, values: {} }] });
    board.workItems = [10];
    assert.deepEqual(await boardStarted(sys, 'tok', SLUG, 12), [
      '✓ board: work item #10 is at Step Build in "example-app work"',
      '! board: slice #12 is not on the board: no open Project of example-org with a Status field holds it unarchived, so it did not move to In Progress',
    ]);
    // A Project's items are read with the field ids it has, and not at all with neither field.
    assert.ok(sys.requests.some((r) => r.url === 'https://api.github.com/orgs/example-org/projectsV2/5/items?per_page=100&fields=2'));
    assert.ok(!sys.requests.some((r) => r.url.includes('/projectsV2/6/items')));
  });

  it("says when a Project's Status has no option In Progress, and still makes the other moves", async () => {
    const sys = new FakeSys();
    slice(sys);
    const board = new RestBoard(sys);
    board.projects[0]!.fields.Status = ['Todo', 'Done'];
    board.projects.push({ number: 5, title: 'roadmap', fields: { Title: null, Status: STATUS_OPTIONS }, items: [{ issue: 12, values: { Status: 'Todo' } }] });
    board.workItems = [10];
    assert.deepEqual(await boardStarted(sys, 'tok', SLUG, 12), [
      '✓ board: slice #12 is In Progress in "roadmap"',
      '✓ board: work item #10 is at Step Build in "example-app work"',
      `! board: Status in "example-app work" has no option In Progress, so slice #12 stays where it is; add the option to the Project's Status field`,
    ]);
    assert.equal(board.projects[0]!.items[0]!.values.Status, 'Todo');
  });

  it('writes nothing for a slice In Progress already and a work item at Build', async () => {
    const sys = new FakeSys();
    slice(sys);
    const board = new RestBoard(sys);
    board.projects[0]!.items = [
      { issue: 12, values: { Status: 'In Progress' } },
      { issue: 10, values: { Status: 'Todo', Step: 'Build' } },
    ];
    board.workItems = [10];
    assert.deepEqual(await boardStarted(sys, 'tok', SLUG, 12), []);
    assert.deepEqual(board.writes, []);
  });

  it("moves no work item for a slice with no parent, or one that is not a Work item's", async () => {
    for (const parent of [
      { status: 404, json: { message: 'No parent issue found' } },
      // GitHub's 404 says no parent, whatever else it holds.
      { status: 404, json: { message: 'No parent issue found', number: 10, type: { name: 'Work item' } } },
      { status: 200, json: { number: 10, type: { name: 'Slice' } } },
      { status: 200, json: { number: 10 } },
      { status: 200, json: null },
    ]) {
      const sys = new FakeSys();
      slice(sys, parent);
      const board = new RestBoard(sys);
      // #10 is a Work item on the board, at Slice: only a slice it is the parent of moves it to Build.
      board.workItems = [10, 21];
      assert.deepEqual(await boardStarted(sys, 'tok', SLUG, 12), ['✓ board: slice #12 is In Progress in "example-app work"'], JSON.stringify(parent));
    }
  });

  it('reads the parent at the issue URL GitHub gives, or builds it, with the token', async () => {
    const sys = new FakeSys();
    slice(sys);
    sys.route('GET', `${ISSUE}/12`, { status: 200, json: { number: 12, state: 'open' } });
    new RestBoard(sys);
    assert.deepEqual(await boardStarted(sys, 'tok', SLUG, 12), [
      '✓ board: slice #12 is In Progress in "example-app work"',
      '✓ board: work item #10 is at Step Build in "example-app work"',
      '✓ board: work item #20 had no Step; it is at Frame in "example-app work"',
    ]);
    assert.equal(sys.requests.find((r) => r.url === `${ISSUE}/12/parent`)?.token, 'tok');
  });

  it("names a move GitHub refuses, and makes the others", async () => {
    const sys = new FakeSys();
    slice(sys);
    new RestBoard(sys).refuse = (method, path) => (method === 'PATCH' && path.endsWith('/items/100') ? { status: 403, json: { message: 'Resource not accessible by integration' } } : undefined);
    assert.deepEqual(await boardStarted(sys, 'tok', SLUG, 12), [
      `! board: slice #12 was not moved to In Progress in "example-app work" (GitHub's REST API refused PATCH /orgs/example-org/projectsV2/3/items/100: HTTP 403 Resource not accessible by integration)`,
      '✓ board: work item #10 is at Step Build in "example-app work"',
      '✓ board: work item #20 had no Step; it is at Frame in "example-app work"',
    ]);
  });

  it('moves the parent first wherever it sits on the board, then the newest', async () => {
    const sys = new FakeSys();
    slice(sys);
    const board = new RestBoard(sys);
    board.workItems = [10, 20, 21, 30];
    board.projects[0]!.items = [{ issue: 12, values: { Status: 'Todo' } }, { issue: 30, values: {} }, { issue: 21, values: {} }, { issue: 20, values: {} }, { issue: 10, values: {} }];
    assert.deepEqual(await boardStarted(sys, 'tok', SLUG, 12), [
      '✓ board: slice #12 is In Progress in "example-app work"',
      '✓ board: work item #10 had no Step; it is at Build in "example-app work"',
      '✓ board: work item #30 had no Step; it is at Frame in "example-app work"',
      '✓ board: work item #21 had no Step; it is at Frame in "example-app work"',
      '✓ board: work item #20 had no Step; it is at Frame in "example-app work"',
    ]);
  });

  it('reads plain option names, and skips an option with none', async () => {
    const repo = `https://api.github.com/repos/${SLUG}`;
    const item = (id: number, number: number, type: string, field: number, value: string) => ({ id, content_type: 'Issue', content: { number, repository_url: repo, state: 'open', type: { name: type } }, fields: [{ id: field, value: { name: value } }] });
    const fields = (status: unknown) => [
      { id: 1, name: 'Title', data_type: 'title' },
      { id: 2, name: 'Status', data_type: 'single_select', ...(status as object) },
      { id: 3, name: 'Step', data_type: 'single_select', options: [{ id: '3_x', name: { html: 'x' } }, ...STEP_OPTIONS.map((option) => ({ id: `3_${option}`, name: option }))] },
    ];
    for (const [status, expected] of [
      [{ options: STATUS_OPTIONS.map((option) => ({ id: `2_${option.replaceAll(' ', '-')}`, name: option })) }, ['✓ board: slice #12 is In Progress in "example-app work"', '✓ board: work item #10 is at Step Build in "example-app work"']],
      [{}, ['✓ board: work item #10 is at Step Build in "example-app work"', `! board: Status in "example-app work" has no option In Progress, so slice #12 stays where it is; add the option to the Project's Status field`]],
    ] as const) {
      const sys = new FakeSys();
      slice(sys);
      new RestBoard(sys).refuse = (method, path) => {
        if (method !== 'GET') return undefined;
        if (path === '/orgs/example-org/projectsV2/3/fields') return { status: 200, json: fields(status) };
        if (path === '/orgs/example-org/projectsV2/3/items') return { status: 200, json: [item(100, 12, 'Slice', 2, 'Todo'), item(101, 10, 'Work item', 3, 'Slice')] };
        return undefined;
      };
      assert.deepEqual(await boardStarted(sys, 'tok', SLUG, 12), expected);
    }
  });

  it('skips a closed Project, whichever way GitHub marks it closed', async () => {
    for (const marks of [{ state: 'closed', closed_at: null }, { state: 'open', closed_at: '2026-11-01T00:00:00Z' }]) {
      const sys = new FakeSys();
      slice(sys);
      new RestBoard(sys).refuse = (method, path) => (path === '/orgs/example-org/projectsV2' ? { status: 200, json: [{ number: 3, title: 'example-app work', ...marks }] } : undefined);
      assert.deepEqual(await boardStarted(sys, 'tok', SLUG, 12), [
        '! board: slice #12 is not on the board: no open Project of example-org with a Status field holds it unarchived, so it did not move to In Progress',
      ]);
      assert.ok(!sys.requests.some((r) => r.url.includes('/projectsV2/3/')));
    }
  });

  it('takes a Status that is not a single select for none', async () => {
    const sys = new FakeSys();
    slice(sys);
    const board = new RestBoard(sys);
    board.projects[0]!.fields = { Title: null, Status: null, Step: STEP_OPTIONS };
    assert.deepEqual(await boardStarted(sys, 'tok', SLUG, 12), [
      '✓ board: work item #10 is at Step Build in "example-app work"',
      '✓ board: work item #20 had no Step; it is at Frame in "example-app work"',
      '! board: slice #12 is not on the board: no open Project of example-org with a Status field holds it unarchived, so it did not move to In Progress',
    ]);
  });

  it('follows a next page whose Link header has no space before rel', async () => {
    const sys = new FakeSys();
    const board = new RestBoard(sys);
    let first = true;
    board.refuse = (method, path) => {
      if (path !== '/orgs/example-org/projectsV2' || !first) return undefined;
      first = false;
      return { status: 200, json: [], headers: { link: '<https://api.github.com/orgs/example-org/projectsV2?per_page=100&after=0>;rel="next"' } };
    };
    assert.deepEqual(await boardSwept(sys, 'tok', SLUG), ['✓ board: work item #20 had no Step; it is at Frame in "example-app work"']);
  });

  for (const [name, json] of [
    ['no answer', null],
    ['no owner', {}],
  ] as const) {
    it(`takes the owner from the slug when GitHub's answer for the repository has ${name}`, async () => {
      const sys = new FakeSys();
      new RestBoard(sys);
      sys.route('GET', `/repos/${SLUG}`, { status: 200, json });
      assert.deepEqual(await boardSwept(sys, 'tok', SLUG), ['✓ board: work item #20 had no Step; it is at Frame in "example-app work"']);
    });
  }

  it('skips an item whose issue GitHub hides, and reads one with no fields or sub-issues', async () => {
    const sys = new FakeSys();
    const repo = `https://api.github.com/repos/${SLUG}`;
    new RestBoard(sys).refuse = (method, path) =>
      method === 'GET' && path === '/orgs/example-org/projectsV2/3/items'
        ? {
            status: 200,
            json: [
              { id: 100, content_type: 'Issue', content: null },
              { id: 101, content_type: 'Issue', content: { number: 10 } },
              { id: 102, content_type: 'Issue', content: { number: 20, repository_url: repo, state: 'open', type: { name: 'Work item' } } },
              { id: 103, content_type: 'Issue', content: { number: 21, repository_url: repo, state: 'open', type: { name: 'Work item' } }, fields: [] },
            ],
          }
        : undefined;
    assert.deepEqual(await boardSwept(sys, 'tok', SLUG), [
      '✓ board: work item #21 had no Step; it is at Frame in "example-app work"',
      '✓ board: work item #20 had no Step; it is at Frame in "example-app work"',
    ]);
  });

  it('names every option a Project lacks in its one line', async () => {
    const sys = new FakeSys();
    const board = new RestBoard(sys);
    board.workItems = [10, 20, 21, 40, 43];
    board.projects[0]!.fields.Step = ['Frame'];
    board.projects[0]!.items.push({ issue: 40, state: 'closed', values: {} }, { issue: 43, subIssues: { total: 1, completed: 0 }, values: {} });
    assert.deepEqual(await boardSwept(sys, 'tok', SLUG), [
      '✓ board: work item #20 had no Step; it is at Frame in "example-app work"',
      '! board: Step in "example-app work" has no option Slice, Done, so work items that belong there stay where they are; niyam onboard adds it',
    ]);
  });

  it("throws when GitHub's REST API refuses a read, naming it", async () => {
    const parent = new FakeSys();
    slice(parent, { status: 403, json: { message: 'Forbidden' } });
    new RestBoard(parent);
    await assert.rejects(boardStarted(parent, 'tok', SLUG, 12), { message: `GitHub's REST API refused GET /repos/${SLUG}/issues/12/parent: HTTP 403 Forbidden` });
    // A 404 that does not say the slice has no parent is a read that failed.
    const hidden = new FakeSys();
    slice(hidden, { status: 404, json: { message: 'Not Found' } });
    new RestBoard(hidden);
    await assert.rejects(boardStarted(hidden, 'tok', SLUG, 12), { message: `GitHub's REST API refused GET /repos/${SLUG}/issues/12/parent: HTTP 404 Not Found` });
    // A message that says no parent counts only with a 404, and only as text.
    const forbidden = new FakeSys();
    slice(forbidden, { status: 403, json: { message: 'No parent access here' } });
    new RestBoard(forbidden);
    await assert.rejects(boardStarted(forbidden, 'tok', SLUG, 12), { message: `GitHub's REST API refused GET /repos/${SLUG}/issues/12/parent: HTTP 403 No parent access here` });
    const listed = new FakeSys();
    slice(listed, { status: 404, json: { message: ['No parent issue found'] } });
    new RestBoard(listed);
    await assert.rejects(boardStarted(listed, 'tok', SLUG, 12), { message: `GitHub's REST API refused GET /repos/${SLUG}/issues/12/parent: HTTP 404` });
    for (const status of [199, 300]) {
      const odd = new FakeSys();
      slice(odd);
      new RestBoard(odd).refuse = (method, path) => (path.endsWith('/fields') ? { status, json: [] } : undefined);
      await assert.rejects(boardStarted(odd, 'tok', SLUG, 12), { message: `GitHub's REST API refused GET /orgs/example-org/projectsV2/3/fields?per_page=100: HTTP ${status}` });
    }
    const bare = new FakeSys();
    slice(bare, { status: 500, json: null });
    new RestBoard(bare);
    await assert.rejects(boardStarted(bare, 'tok', SLUG, 12), { message: `GitHub's REST API refused GET /repos/${SLUG}/issues/12/parent: HTTP 500` });
    const fields = new FakeSys();
    slice(fields);
    new RestBoard(fields).refuse = (method, path) => (path.endsWith('/fields') ? { status: 502, json: null } : undefined);
    await assert.rejects(boardStarted(fields, 'tok', SLUG, 12), { message: "GitHub's REST API refused GET /orgs/example-org/projectsV2/3/fields?per_page=100: HTTP 502" });
    const list = new FakeSys();
    slice(list);
    new RestBoard(list).refuse = (method, path) => (path === '/orgs/example-org/projectsV2' ? { status: 200, json: { message: 'not a list' } } : undefined);
    await assert.rejects(boardStarted(list, 'tok', SLUG, 12), { message: "GitHub's REST API did not answer a list (/orgs/example-org/projectsV2?per_page=100)" });
  });

  it('moves every work item to the Step its facts give, forward only, and a closed one to Done', async () => {
    const sys = new FakeSys();
    slice(sys);
    const board = new RestBoard(sys);
    board.workItems = [10, 20, 21, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51];
    board.projects[0]!.items.push(
      // Closed: Done, whatever Step it had.
      { issue: 40, state: 'closed', subIssues: { total: 3, completed: 3 }, values: { Step: 'Frame' } },
      { issue: 41, state: 'closed', values: {} },
      { issue: 42, state: 'closed', values: { Step: 'Done' } },
      // Open with slices filed: Slice; with one closed: Build.
      { issue: 43, subIssues: { total: 9, completed: 0 }, values: { Step: 'Frame' } },
      { issue: 44, subIssues: { total: 2, completed: 1 }, values: { Step: 'Specify' } },
      // Never back: an owner's Specify, or Build before any slice closed, stays.
      { issue: 45, values: { Step: 'Specify' } },
      { issue: 46, subIssues: { total: 2, completed: 0 }, values: { Step: 'Build' } },
      // Reopened: leaves Done for where its facts put it.
      { issue: 47, subIssues: { total: 1, completed: 0 }, values: { Step: 'Done' } },
      // An option the owner added stays, open or closed.
      { issue: 48, state: 'closed', values: { Step: 'Parked' } },
      // Not a Work item: no Step.
      { issue: 49, type: 'Brief', state: 'closed', values: {} },
      { issue: 50, type: null, values: {} },
      // Archived: off the board.
      { issue: 51, archived: true, state: 'closed', values: { Step: 'Build' } },
    );
    board.projects[0]!.fields.Step = [...STEP_OPTIONS, 'Parked'];
    assert.deepEqual(await boardStarted(sys, 'tok', SLUG, 12), [
      '✓ board: slice #12 is In Progress in "example-app work"',
      '✓ board: work item #10 is at Step Build in "example-app work"',
      '✓ board: work item #47 is at Step Slice in "example-app work"',
      '✓ board: work item #44 is at Step Build in "example-app work"',
      '✓ board: work item #43 is at Step Slice in "example-app work"',
      '✓ board: work item #41 had no Step; it is at Done in "example-app work"',
      '✓ board: work item #40 is closed; it is at Step Done in "example-app work"',
      '✓ board: work item #20 had no Step; it is at Frame in "example-app work"',
    ]);
    const steps = Object.fromEntries(board.projects[0]!.items.map((item) => [item.issue, item.values.Step]));
    assert.deepEqual(steps, { 12: undefined, 10: 'Build', 20: 'Frame', 21: 'Frame', 40: 'Done', 41: 'Done', 42: 'Done', 43: 'Slice', 44: 'Build', 45: 'Specify', 46: 'Build', 47: 'Slice', 48: 'Parked', 49: undefined, 50: undefined, 51: 'Build' });
    // The items hold their issues, so no issue is read on its own.
    assert.ok(!sys.requests.some((r) => /\/issues(\?|\/(?!12\b))/.test(r.url)));
  });

  it('says once for each Project whose Step lacks an option a move needs, and makes the other moves', async () => {
    const sys = new FakeSys();
    slice(sys);
    const board = new RestBoard(sys);
    board.workItems = [10, 20, 21, 40, 41];
    board.projects[0]!.fields.Step = ['Frame', 'Specify', 'Slice', 'Build'];
    board.projects[0]!.items.push({ issue: 40, state: 'closed', values: { Step: 'Build' } }, { issue: 41, state: 'closed', values: {} });
    board.projects.push({ number: 5, title: 'roadmap', fields: { Title: null, Step: ['Frame', 'Build'] }, items: [{ issue: 40, state: 'closed', values: {} }, { issue: 41, state: 'closed', values: {} }, { issue: 21, values: {} }] });
    assert.deepEqual(await boardStarted(sys, 'tok', SLUG, 12), [
      '✓ board: slice #12 is In Progress in "example-app work"',
      '✓ board: work item #10 is at Step Build in "example-app work"',
      '✓ board: work item #21 had no Step; it is at Frame in "roadmap"',
      '✓ board: work item #20 had no Step; it is at Frame in "example-app work"',
      '! board: Step in "example-app work" has no option Done, so work items that belong there stay where they are; niyam onboard adds it',
      '! board: Step in "roadmap" has no option Done, so work items that belong there stay where they are; niyam onboard adds it',
    ]);
  });

  it('sweeps the board without a slice', async () => {
    const sys = new FakeSys();
    const board = new RestBoard(sys);
    board.workItems = [10, 20, 21, 40];
    board.projects[0]!.items.push({ issue: 40, state: 'closed', values: { Step: 'Frame' } });
    assert.deepEqual(await boardSwept(sys, 'tok', SLUG), [
      '✓ board: work item #40 is closed; it is at Step Done in "example-app work"',
      '✓ board: work item #20 had no Step; it is at Frame in "example-app work"',
    ]);
    // Work item #10 is at Slice with no slice closed: it stays.
    assert.equal(board.projects[0]!.items[1]!.values.Step, 'Slice');
  });

  it('gives the Step the facts put a work item at, or none when it stays', () => {
    const open = (value: string | undefined, total = 0, completed = 0) => ({ value, state: 'open', subIssues: { total, completed } });
    assert.equal(stepDue(open(undefined)), 'Frame');
    assert.equal(stepDue(open('frame', 1)), 'Slice');
    assert.equal(stepDue(open('Slice', 1, 1)), 'Build');
    assert.equal(stepDue(open('Specify'), true), 'Build');
    assert.equal(stepDue(open('Build')), undefined);
    assert.equal(stepDue(open('Frame')), undefined);
    assert.equal(stepDue(open('Slice', 1)), undefined);
    assert.equal(stepDue(open('Done')), 'Frame');
    assert.equal(stepDue({ ...open('Build'), state: 'closed' }), 'Done');
    assert.equal(stepDue({ ...open('done'), state: 'closed' }), undefined);
    assert.equal(stepDue({ ...open('Parked'), state: 'closed' }), undefined);
  });

  it('reads nothing more for a closed slice', async () => {
    const sys = new FakeSys();
    sys.route('GET', `${ISSUE}/12`, { status: 200, json: { number: 12, state: 'closed' } });
    new RestBoard(sys);
    assert.deepEqual(await boardStarted(sys, 'tok', SLUG, 12), []);
    assert.equal(sys.requests.length, 1);
  });
});
