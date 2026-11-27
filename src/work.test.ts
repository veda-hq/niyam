import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import type { Settings } from './agent.ts';
import { RestBoard } from './fake-board.test.ts';
import { AGENT, FakeSys, ROOT, SETTINGS, capture } from './fake.test.ts';
import { askProblem } from './asks.ts';
import { PROXY_TOKEN } from './cloud.ts';
import { deleteBranchCommand, fileState, prMerged, prStarted, prePush, prWorkRules, propose, pullUrl, section, sessionToken, sliceProblems, slicesNamed, statesNamed } from './work.ts';

const SLUG = 'example-org/example-app';
/** Another repository, where a slice this one builds can be planned. */
const PLANS = 'example-org/example-plans';
/** Its issues' own addresses. */
const P = `https://github.com/${PLANS}/issues`;
/** Issues' own addresses, as the work rules name them for the owner to act on (#557). */
const W = `https://github.com/${SLUG}/issues`;
const OWNER = 'example-owner';
const ACCOUNTS = { owners: [OWNER], agents: [AGENT] };
const T0 = '2026-10-01T00:00:00Z';
const APPROVED = '2026-10-02T00:00:00Z';
const LATER = '2026-10-03T00:00:00Z';
/** After the approval and before LATER: a sub-issue left the work item, so the slice may have left and come back. */
const LEFT = '2026-10-02T12:00:00Z';
const LATEST = '2026-10-04T00:00:00Z';

type Node = Record<string, unknown>;

/** The Approvals issue, as settings that name one name it. */
const APPROVALS = 700;
const WITH_APPROVALS = { ...ACCOUNTS, approvals: APPROVALS };

/** Slice #12 under work item #10, approved by the owner, with nothing else; the Approvals issue, #700, with no comments. */
function graph(): {
  issue: Node;
  timeline: Node[];
  own: Node[];
  siblings: Node[];
  states: Node[];
  comments: Node[];
  thumbs: Map<string, Node[]>;
  approvals: Node[];
} {
  const timeline: Node[] = [
    { event: 'sub_issue_added', created_at: T0, sub_issue: { number: 12 } },
    { event: 'labeled', created_at: APPROVED, actor: { login: OWNER }, label: { name: 'approved' } },
  ];
  // The slice's own timeline: when it was put under its work item, as GITHUB_TOKEN reads it, naming no parent.
  const own: Node[] = [{ event: 'parent_issue_added', created_at: T0, parent_issue: null }];
  // The work item's other sub-issues, each with its own timeline.
  const siblings: Node[] = [];
  const states: Node[] = [];
  const comments: Node[] = [];
  const approvals: Node[] = [];
  const issue: Node = {
    number: 12,
    title: 'Add the thing',
    body: 'Slice P-01 of #10.\n\n**You will see:** the thing.\n- on every page\n\n**Why:** it is asked for.\n\n**Needs:** —',
    state: 'open',
    type: { name: 'Slice' },
    comments,
    parent: { number: 10, type: { name: 'Work item' } },
    timeline,
    own,
    siblings,
    states,
    thumbs: new Map<string, Node[]>(),
    approvals,
  };
  return { issue, timeline, own, siblings, states, comments, thumbs: issue.thumbs as Map<string, Node[]>, approvals };
}

const ISSUES = `https://api.github.com/repos/${SLUG}/issues`;
const LIST = /^(.*?)[?&]per_page=100&page=(\d+)$/;

/** What GitHub's REST API answers `url` with for slice `issue`'s model, or undefined for a path it does not hold. */
function answer(issue: Node | null, url: string, issues = ISSUES): { status: number; json: unknown } | undefined {
  const list = LIST.exec(url);
  const path = (list ? list[1] as string : url).replace(issues, '');
  const page = (items: Node[] | undefined): { status: number; json: unknown } | undefined => {
    if (!items) return undefined;
    const from = (Number(list?.[2]) - 1) * 100;
    // GitHub answers the page after the last one, empty; a run that reads past it never stops, so it is not there.
    return from > items.length ? undefined : { status: 200, json: items.slice(from, from + 100) };
  };
  if (!issue) return undefined;
  if (path === `/${APPROVALS}/comments`) return page(issue.approvals as Node[]);
  const parent = issue.parent as Node | null;
  const states = (issue.states as Node[]).map((state): Node => ({ ...state, url: `${issues}/${state.number}` }));
  // As a workflow's GITHUB_TOKEN reads a private repository: no parent_issue_url, the parent from its endpoint alone.
  if (path === '/12') return { status: 200, json: { ...issue, url: `${issues}/12`, parent_issue_url: null } };
  if (path === '/12/parent') {
    return parent ? { status: 200, json: { ...parent, url: `${issues}/10` } } : { status: 404, json: { message: 'No parent issue found' } };
  }
  // The work item itself, open with no "**Slices:** all filed" line unless the parent says otherwise, and its comments.
  if (path === '/10') return parent ? { status: 200, json: { state: 'open', body: '', labels: [], ...parent, url: `${issues}/10` } } : undefined;
  if (path === '/10/comments') return page((parent?.comments as Node[] | undefined) ?? []);
  if (path === '/10/timeline') return page(issue.timeline as Node[]);
  if (path === '/12/timeline') return page(issue.own as Node[]);
  const siblings = (issue.siblings as Node[] | undefined) ?? [];
  if (path === '/10/sub_issues') return page([{ ...issue, url: `${issues}/12` }, ...siblings.map((one) => ({ ...one, url: `${issues}/${one.number}` }))]);
  const sibling = siblings.find((one) => path === `/${one.number}/timeline`);
  if (sibling) return page(sibling.own as Node[]);
  if (path === '/12/comments') return page(issue.comments as Node[]);
  if (path === '/12/sub_issues') return page(states);
  const own = /^\/(\d+)(\/comments|\/parent)?$/.exec(path);
  const state = states.find((one) => one.number === Number(own?.[1]));
  if (state && own?.[2] === '/parent') return { status: 200, json: { ...issue, url: `${issues}/12` } };
  if (state) return own?.[2] ? page(state.comments as Node[]) : { status: 200, json: state };
  const reactions = /^\/comments\/([^/]+)\/reactions\?content=%2B1$/.exec(path);
  // A deleted comment reads as 404.
  if (reactions && reactions[1] !== 'gone') return page((issue.thumbs as Map<string, Node[]>).get(reactions[1] as string) ?? []);
  return undefined;
}

/** GitHub as slice `issue`'s model says, read when asked so a test can change it after; routes a test sets win. */
function github(sys: FakeSys, issue: Node | null, pulls: Node[] = [], repo = SLUG): void {
  const issues = `https://api.github.com/repos/${repo}/issues`;
  const http = sys.http.bind(sys);
  sys.http = (url, options = {}) => {
    const key = `${options.method ?? 'GET'} ${url}`;
    if (!sys.routes.has(key) && (options.method ?? 'GET') === 'GET' && url.startsWith(issues)) {
      sys.route('GET', url, () => answer(issue, url, issues) ?? { status: 404, json: { message: 'Not Found' } });
    }
    return http(url, options);
  };
  sys.route('GET', `/repos/${SLUG}/pulls?state=open&per_page=100&page=1`, { status: 200, json: pulls });
  // No open Work items, and one Project holding slice #12 In Progress already, so a push moves nothing on the board.
  sys.route('GET', `${ISSUES}?state=open&type=Work%20item&sort=created&direction=desc&per_page=100`, { status: 200, json: [] });
  const project = '/orgs/example-org/projectsV2/3';
  sys.route('GET', '/orgs/example-org/projectsV2?per_page=100', { status: 200, json: [{ number: 3, title: 'example-app work' }] });
  sys.route('GET', `${project}/fields?per_page=100`, { status: 200, json: [{ id: 2, name: 'Status', data_type: 'single_select', options: [{ id: 'in-progress', name: 'In Progress' }] }] });
  sys.route('GET', `${project}/items?per_page=100&fields=2`, {
    status: 200,
    json: [{ id: 100, content_type: 'Issue', content: { number: 12, repository_url: `https://api.github.com/repos/${SLUG}`, state: 'open' }, fields: [{ id: 2, value: { name: 'In Progress' } }] }],
  });
}

let ids = 0;
const comment = (body: string, created_at = LATEST, login = OWNER, edited: string | null = null): Node => ({
  event: 'commented',
  id: `IC_${++ids}`,
  node_id: `IC_${ids}`,
  user: { login },
  body,
  created_at,
  updated_at: edited ?? created_at,
  // Where the owner acts on it; the propose tests' proposals are on slice #12.
  html_url: `https://github.com/${SLUG}/issues/12#issuecomment-${ids}`,
});
const thumb = (created_at = LATEST, login = OWNER): Node => ({ user: { login }, created_at });

/** After LATEST: when a comment made at LATEST was edited. */
const EDITED = '2026-10-05T00:00:00Z';

/**
 * The work rules on slice `issue`, with GitHub's GraphQL API listing each
 * comment's revisions by `revisions`, newest first, the comment as written
 * last; or refusing it, as a Claude cloud session's proxy does. Also how many
 * times they asked GraphQL.
 */
async function withEdits(issue: Node, revisions: Record<string, string[]> | 'refused', accounts: Settings = ACCOUNTS): Promise<{ problems: string[]; graphql: number }> {
  const sys = new FakeSys();
  github(sys, issue);
  sys.route('POST', '/graphql', () => {
    if (revisions === 'refused') return { status: 403, json: { message: 'Forbidden' } };
    const { ids } = (sys.requests.at(-1)?.body as { variables: { ids: string[] } }).variables;
    const nodes = ids.map((id) => ({ id, userContentEdits: { totalCount: revisions[id]?.length ?? 0, nodes: (revisions[id] ?? []).map((login) => ({ editor: { login } })) } }));
    return { status: 200, json: { data: { nodes } } };
  });
  const found = await sliceProblems(sys, 'tok', SLUG, 12, accounts, {});
  return { problems: found, graphql: sys.requests.filter((request) => request.url.endsWith('/graphql')).length };
}

const OTHERS_EDITED = ' (a "Decision:" comment someone other than an owner edited does not count)';
const UNREAD = ' (an edited "Decision:" comment counts only once GitHub\'s GraphQL API shows owners made every edit, and it did not answer here)';

async function problems(issue: Node | null, pulls: Node[] = [], mine: { pull?: number; branch?: string } = {}, accounts: Settings = ACCOUNTS): Promise<string[]> {
  const sys = new FakeSys();
  github(sys, issue, pulls);
  return sliceProblems(sys, 'tok', SLUG, 12, accounts, mine);
}

/** A second owner and a second agent, as settings listing two of each name them. */
const OWNER_2 = 'Second-Owner';
const AGENT_2 = 'OtherBot';
const TEAM = { owners: [OWNER, OWNER_2], agents: [AGENT, AGENT_2] };
const TEAM_SETTINGS = JSON.stringify({ owner: TEAM.owners, agent: TEAM.agents });

describe('slicesNamed', () => {
  const here = (number: number): { repo: string; number: number } => ({ repo: SLUG, number });
  it('reads "Slice: #N" lines and issue links, once each', () => {
    assert.deepEqual(slicesNamed(`Intro\nSlice: #12\nslice:  https://github.com/${SLUG}/issues/7 \nSlice: #12\nnot Slice: #9`, SLUG), [here(12), here(7)]);
    assert.deepEqual(slicesNamed('Fixes #12', SLUG), []);
  });

  it("reads another repository's slice by its link or as owner/name#N, in its own repository", () => {
    const plans = { repo: 'athya-hq/athya_mono', number: 3850 };
    assert.deepEqual(slicesNamed('Slice: https://github.com/athya-hq/athya_mono/issues/3850', SLUG), [plans]);
    assert.deepEqual(slicesNamed('Slice: athya-hq/athya_mono#3850', SLUG), [plans]);
    // The same slice twice, written both ways and in another case, is one; a number here is another slice.
    assert.deepEqual(slicesNamed('Slice: athya-hq/athya_mono#3850\nSlice: https://github.com/Athya-HQ/athya_mono/issues/3850\nSlice: #3850', SLUG), [plans, here(3850)]);
  });

  it('reads a link or owner/name#N naming this repository, in any case, as a slice here', () => {
    assert.deepEqual(slicesNamed('Slice: Example-Org/example-app#12\nSlice: #12', SLUG), [here(12)]);
    assert.deepEqual(slicesNamed('Slice: https://github.com/example-org/Example-App/issues/12', SLUG), [here(12)]);
  });

  it('reads no other shapes', () => {
    assert.deepEqual(
      slicesNamed('Slice: athya_mono#3850\nSlice: https://example.com/a/b/issues/3\nSlice: a/b#3 and more\nSlice: a/b/c#3\nSlice: https://github.com/a/b?x/issues/3\nSlice: https://github.com/a%2Fb/c/issues/3', SLUG),
      [],
    );
  });
});

describe('pullUrl and deleteBranchCommand', () => {
  it("takes GitHub's https address for a pull request, else builds it", () => {
    assert.equal(pullUrl(SLUG, 3, `https://github.com/${SLUG}/pull/3`), `https://github.com/${SLUG}/pull/3`);
    for (const given of ['http://example.com/pull/3', 7, undefined]) assert.equal(pullUrl(SLUG, 3, given), `https://github.com/${SLUG}/pull/3`, String(given));
  });

  it('names a branch in full only when it starts with - or +', () => {
    assert.equal(deleteBranchCommand('fix-a+b'), 'git push origin --delete fix-a+b');
    assert.equal(deleteBranchCommand('-x'), 'git push origin --delete refs/heads/-x');
  });
});

describe('statesNamed', () => {
  it('reads each "State: #N" line, by number or link, without repeats, and not prose', () => {
    assert.deepEqual(statesNamed(`Builds State #30 of P-01.\nSlice: #12\nState: #31\nstate:  https://github.com/${SLUG}/issues/32 \nState: #31`, SLUG), [
      { repo: SLUG, number: 31 },
      { repo: SLUG, number: 32 },
    ]);
    assert.deepEqual(statesNamed('State: a/b#4\nState: https://github.com/a/b/issues/5', SLUG), [
      { repo: 'a/b', number: 4 },
      { repo: 'a/b', number: 5 },
    ]);
  });
});

describe('section', () => {
  it("reads a body's section up to the next one, or nothing when it is missing or empty", () => {
    const body = 'Intro\r\n**Why:** because\r\n- **Bold.** a point\r\n**Needs:** —\n**Empty:**  \n**Cost:**';
    assert.equal(section(body, 'why'), 'because\n- **Bold.** a point');
    assert.equal(section(body, 'Needs'), '—');
    assert.equal(section(body, 'Empty'), undefined);
    assert.equal(section(body, 'Cost'), undefined);
    assert.equal(section(body, 'You will see'), undefined);
  });

  it('reads a section on the first line, to the end, ended only by a line that starts a section, indented or not', () => {
    assert.equal(section('**Why:** a\nb', 'Why'), 'a\nb');
    assert.equal(section('**Why:** a\nsee **Note:** b\n  **Cost:** c', 'Why'), 'a\nsee **Note:** b');
  });
});

describe('sliceProblems', () => {
  it('lets an approved slice be built', async () => {
    assert.deepEqual(await problems(graph().issue), []);
  });

  for (const [name, change, problem] of [
    ['a missing issue', () => null, '#12 is not an issue in example-org/example-app'],
    ['an issue that is not a Slice', (g: ReturnType<typeof graph>) => ({ ...g.issue, type: null }), '#12 is not a Slice (its type is none)'],
    ['a slice with no work item', (g: ReturnType<typeof graph>) => ({ ...g.issue, parent: null }), '#12 is not a sub-issue of a Work item'],
    ['a slice under an issue that is not a Work item', (g: ReturnType<typeof graph>) => ({ ...g.issue, parent: { number: 10, type: { name: 'Slice' } } }), '#12 is not a sub-issue of a Work item'],
    ['a slice under an issue of no type', (g: ReturnType<typeof graph>) => ({ ...g.issue, parent: { number: 10, type: null } }), '#12 is not a sub-issue of a Work item'],
  ] as const) {
    it(`refuses ${name}`, async () => {
      assert.deepEqual(await problems(change(graph())), [problem]);
    });
  }

  it('fails closed, saying so, when the parent cannot be read', async () => {
    const sys = new FakeSys();
    github(sys, graph().issue);
    sys.route('GET', `/repos/${SLUG}/issues/12/parent`, { status: 403, json: { message: 'Resource not accessible by integration' } });
    assert.deepEqual(await sliceProblems(sys, 'tok', SLUG, 12, ACCOUNTS, {}), ["could not read #12's parent (HTTP 403: Resource not accessible by integration)"]);
    sys.route('GET', `/repos/${SLUG}/issues/12/parent`, { status: 404, json: { message: 'Not Found' } });
    assert.deepEqual(await sliceProblems(sys, 'tok', SLUG, 12, ACCOUNTS, {}), ["could not read #12's parent (HTTP 404: Not Found)"]);
    sys.route('GET', `/repos/${SLUG}/issues/12/parent`, { status: 502, json: null });
    assert.deepEqual(await sliceProblems(sys, 'tok', SLUG, 12, ACCOUNTS, {}), ["could not read #12's parent (HTTP 502)"]);
    sys.route('GET', `/repos/${SLUG}/issues/12/parent`, { status: 500, json: { message: 'No parent issue found' } });
    assert.deepEqual(await sliceProblems(sys, 'tok', SLUG, 12, ACCOUNTS, {}), ["could not read #12's parent (HTTP 500: No parent issue found)"], 'only a 404 says there is none');
  });

  it("throws on a list GitHub does not hold, naming the read, where only the Approvals issue's and reactions may be missing", async () => {
    const COMMENTS = `/repos/${SLUG}/issues/12/comments?per_page=100&page=1`;
    const sys = new FakeSys();
    github(sys, graph().issue);
    sys.route('GET', COMMENTS, { status: 404, json: { message: 'Not Found' } });
    await assert.rejects(sliceProblems(sys, 'tok', SLUG, 12, ACCOUNTS, {}), { message: `cannot read #12: Not Found (${COMMENTS})` });
  });

  it('throws when GitHub will not list the open pull requests, or answers no list', async () => {
    for (const [status, json] of [[500, []], [200, {}]] as const) {
      const sys = new FakeSys();
      github(sys, graph().issue);
      sys.route('GET', `/repos/${SLUG}/pulls?state=open&per_page=100&page=1`, { status, json });
      await assert.rejects(sliceProblems(sys, 'tok', SLUG, 12, ACCOUNTS, {}), { message: `cannot list open pull requests (HTTP ${status})` });
    }
  });

  it('warns of a closed slice only where asked to, and by the open States of the branch\'s own pull request', async () => {
    const g = graph();
    g.issue.state = 'closed';
    g.states.push({ number: 31, title: 'Fix', type: { name: 'State' }, state: 'open', state_reason: null, closed_at: null, comments: [] });
    assert.deepEqual(await problems(g.issue), [], 'neither warnings nor States asked for');
    const pulls = [
      { number: 40, body: 'Slice: #12\nState: #31', head: { ref: 'work', repo: { full_name: SLUG } } },
      { number: 41, body: null, head: { ref: 'other', repo: { full_name: SLUG } } },
    ];
    const sys = new FakeSys();
    github(sys, g.issue, pulls);
    const warnings: string[] = [];
    assert.deepEqual(await sliceProblems(sys, 'tok', SLUG, 12, ACCOUNTS, { branch: 'work', warnings }), []);
    assert.deepEqual(warnings, []);
  });

  it('refuses an unapproved start', async () => {
    const g = graph();
    g.timeline.splice(1, 1);
    assert.deepEqual(await problems(g.issue), [`work item #10, ${W}/10, is not approved: example-owner adds the approved label before any slice starts`]);
  });

  it('refuses an approval taken back', async () => {
    const g = graph();
    g.timeline.push({ event: 'unlabeled', created_at: LATER, actor: { login: OWNER }, label: { name: 'approved' } });
    assert.match((await problems(g.issue))[0] ?? '', /is not approved/);
  });

  it('refuses an approval by anyone but the owner', async () => {
    const g = graph();
    g.timeline[1] = { event: 'labeled', created_at: APPROVED, actor: { login: AGENT }, label: { name: 'approved' } };
    assert.deepEqual(await problems(g.issue), [`work item #10, ${W}/10, was labeled approved by ExampleBot, not example-owner`]);
    g.timeline[1] = { event: 'labeled', created_at: APPROVED, actor: null, label: { name: 'approved' } };
    assert.deepEqual(await problems(g.issue), [`work item #10, ${W}/10, was labeled approved by someone unknown, not example-owner`]);
  });

  it('ignores other labels', async () => {
    const g = graph();
    g.timeline.push({ event: 'labeled', created_at: LATER, actor: { login: AGENT }, label: { name: 'mechanical' } });
    assert.deepEqual(await problems(g.issue), []);
  });

  describe('a slice added after approval', () => {
    const added = (): ReturnType<typeof graph> => {
      const g = graph();
      g.timeline[0] = { event: 'sub_issue_added', created_at: LATER, sub_issue: { number: 12 } };
      return g;
    };
    const proposed =
      `#12 was added to work item #10, ${W}/10, after its approval; example-owner reacts 👍 on ExampleBot's proposal on #12, ${W}/12, or adds a "Decision:" comment naming #12 on ${W}/12, or #12 links example-owner's request for it on #10`;
    const refused = `${proposed}; ExampleBot proposes it with: niyam propose 12 --page <page url>`;

    it('is refused without the owner\'s decision', async () => {
      assert.deepEqual(await problems(added().issue), [refused]);
    });

    it('passes with the owner\'s Decision: comment naming it on the work item', async () => {
      const g = added();
      g.timeline.push(comment('Decision: add #12, it is needed'));
      assert.deepEqual(await problems(g.issue), []);
    });

    it('passes with the owner\'s Decision: comment on the slice', async () => {
      const g = added();
      g.comments.push(comment('Decision: keep it'));
      assert.deepEqual(await problems(g.issue), []);
    });

    for (const [name, made] of [
      ['by the agent', comment('Decision: add #12', LATEST, AGENT)],
      ['before the slice was added', comment('Decision: add #12', APPROVED)],
      ['naming another slice', comment('Decision: add #120')],
      ['without the Decision: prefix', comment('ok, add #12')],
      ['with no author', { ...comment('Decision: add #12'), user: null }],
    ] as const) {
      it(`ignores a comment ${name}`, async () => {
        const g = added();
        g.timeline.push(made);
        assert.deepEqual(await problems(g.issue), [refused]);
      });
    }

    describe('a batch answer on the Approvals issue', () => {
      const batched = `${proposed}, or example-owner comments on #700, the Approvals issue, ${W}/700, with a first line "Decision: approve #12"`;
      const proposes = '; ExampleBot proposes it with: niyam propose 12 --page <page url>';

      it("passes when the first line of the owner's comment there approves it among others", async () => {
        const g = added();
        g.approvals.push(comment('Decision: approve #31 #12 #40\nThe rest are reasons.'));
        assert.deepEqual(await problems(g.issue, [], {}, WITH_APPROVALS), []);
      });

      for (const [name, made] of [
        ['naming it only below the first line', comment('Decision: approve #31\nNot #12 yet: W-36 lands first.')],
        ['by the agent', comment('Decision: approve #12', LATEST, AGENT)],
        ['made before the slice was added', comment('Decision: approve #12', APPROVED)],
        ['that does not open "Decision: approve"', comment('Decision: #12 is fine')],
        ["naming another repository's #12, or #120", comment('Decision: approve other/repo#12 #120')],
      ] as const) {
        it(`ignores a comment there ${name}, and says how to answer`, async () => {
          const g = added();
          g.approvals.push(made);
          assert.deepEqual(await problems(g.issue, [], {}, WITH_APPROVALS), [`${batched}${proposes}`]);
        });
      }

      it('reads no Approvals issue when an unedited Decision: on the slice settles it', async () => {
        const g = added();
        g.comments.push(comment('Decision: keep it'));
        const sys = new FakeSys();
        github(sys, g.issue);
        assert.deepEqual(await sliceProblems(sys, 'tok', SLUG, 12, WITH_APPROVALS, {}), []);
        assert.equal(sys.requests.some((request) => request.url.includes(`/issues/${APPROVALS}/`)), false);
      });

      it('reads no Approvals issue where the settings name none', async () => {
        const g = added();
        g.approvals.push(comment('Decision: approve #12'));
        const sys = new FakeSys();
        github(sys, g.issue);
        assert.deepEqual(await sliceProblems(sys, 'tok', SLUG, 12, ACCOUNTS, {}), [refused]);
        assert.equal(sys.requests.some((request) => request.url.includes(`/issues/${APPROVALS}/`)), false);
      });

      it('answers nothing, and fails nothing, where GitHub cannot find the Approvals issue', async () => {
        assert.deepEqual(await problems(added().issue, [], {}, { ...ACCOUNTS, approvals: 701 }), [`${batched.replace('#700', '#701').replace('issues/700', 'issues/701')}${proposes}`]);
      });

      it('refuses one the agent edited, and takes one owners alone edited', async () => {
        const g = added();
        const made = comment('Decision: approve #12', LATEST, OWNER, EDITED);
        g.approvals.push(made);
        assert.deepEqual(await withEdits(g.issue, { [made.id as string]: [AGENT, OWNER] }, WITH_APPROVALS), { problems: [`${batched}${OTHERS_EDITED}${proposes}`], graphql: 1 });
        assert.deepEqual(await withEdits(g.issue, { [made.id as string]: [OWNER, OWNER] }, WITH_APPROVALS), { problems: [], graphql: 1 });
      });
    });

    describe("an owner's edited Decision:", () => {
      const proposes = '; ExampleBot proposes it with: niyam propose 12 --page <page url>';

      it('is refused when the agent edited it, on the slice or on the work item', async () => {
        const g = added();
        const made = comment('Decision: keep it', LATEST, OWNER, EDITED);
        g.comments.push(made);
        assert.deepEqual(await withEdits(g.issue, { [made.id as string]: [AGENT, OWNER] }), { problems: [`${proposed}${OTHERS_EDITED}${proposes}`], graphql: 1 });
        const h = added();
        const there = comment('Decision: add #12', LATEST, OWNER, EDITED);
        h.timeline.push(there);
        // An agent's edit counts against it even when an owner edited it again after.
        assert.deepEqual(await withEdits(h.issue, { [there.id as string]: [OWNER, AGENT, OWNER] }), { problems: [`${proposed}${OTHERS_EDITED}${proposes}`], graphql: 1 });
      });

      it('passes when owners alone edited it, on the slice or on the work item', async () => {
        const g = added();
        const made = comment('Decision: keep it', LATEST, OWNER, EDITED);
        g.comments.push(made);
        assert.deepEqual(await withEdits(g.issue, { [made.id as string]: [OWNER, OWNER] }), { problems: [], graphql: 1 });
        const h = added();
        const there = comment('Decision: add #12', LATEST, OWNER, EDITED);
        h.timeline.push(there);
        assert.deepEqual(await withEdits(h.issue, { [there.id as string]: [OWNER, OWNER] }), { problems: [], graphql: 1 });
      });

      it('does not count where GraphQL is refused, and says why', async () => {
        const g = added();
        g.comments.push(comment('Decision: keep it', LATEST, OWNER, EDITED));
        assert.deepEqual(await withEdits(g.issue, 'refused'), { problems: [`${proposed}${UNREAD}${proposes}`], graphql: 1 });
      });

      it('asks GraphQL nothing when an unedited decision, or a request, settles it', async () => {
        const g = added();
        g.comments.push(comment('Decision: keep it', LATEST, OWNER, EDITED), comment('Decision: keep it'));
        assert.deepEqual(await withEdits(g.issue, 'refused'), { problems: [], graphql: 0 });
        const h = added();
        const request = { ...comment('Please add the thing', APPROVED), id: 4321 };
        h.issue.body = `${h.issue.body as string}\n\nRequested: https://github.com/${SLUG}/issues/10#issuecomment-4321`;
        h.timeline.push(request, comment('Decision: add #12', LATEST, OWNER, EDITED));
        assert.deepEqual(await withEdits(h.issue, 'refused'), { problems: [], graphql: 0 });
      });

      it("still passes with the owner's 👍 on the proposal", async () => {
        const g = added();
        const made = comment('Decision: keep it', LATEST, OWNER, EDITED);
        const proposal = comment('Proposal: add #12', LATER, AGENT);
        g.comments.push(made, proposal);
        g.thumbs.set(proposal.id as string, [thumb()]);
        assert.deepEqual(await withEdits(g.issue, { [made.id as string]: [AGENT, OWNER] }), { problems: [], graphql: 1 });
      });
    });

    describe("a request on the work item the slice links", () => {
      const LINK = `https://github.com/${SLUG}/issues/10#issuecomment-`;
      /** Slice #12 added after approval, its body linking `link`, with `made` on the work item. */
      const linking = (made: Node, link = `${LINK}${made.id as number}`): ReturnType<typeof graph> => {
        const g = added();
        g.issue.body = `${g.issue.body as string}\n\nRequested: ${link}`;
        g.timeline.push(made);
        return g;
      };
      const request = (created_at = APPROVED, login = OWNER, edited: string | null = null): Node => ({ ...comment('Please add the thing', created_at, login, edited), id: 4321 });

      it("passes with the owner's comment, made before the slice was added", async () => {
        assert.deepEqual(await problems(linking(request()).issue), []);
        // GitHub writes a repository's name as it likes; the link may differ in case.
        assert.deepEqual(await problems(linking(request(), `${LINK.replace(SLUG, SLUG.toUpperCase())}4321`).issue), []);
      });

      for (const [name, made, link] of [
        ['by anyone else', request(APPROVED, AGENT), undefined],
        ['with no author', { ...request(), user: null }, undefined],
        ['made after the slice was added', request(LATEST), undefined],
        ['edited since it was made', request(APPROVED, OWNER, APPROVED.replace('02T', '02T01')), undefined],
        ['on another issue', request(), `https://github.com/${SLUG}/issues/11#issuecomment-4321`],
        ['in another repository', request(), `https://github.com/example-org/other-app/issues/10#issuecomment-4321`],
        ['that is not the one linked', request(), `${LINK}43210`],
      ] as const) {
        it(`does not pass with a comment ${name}`, async () => {
          assert.deepEqual(await problems(linking(made, link).issue), [refused]);
        });
      }

      it('does not pass when the slice links nothing, or GitHub holds no such comment', async () => {
        const g = added();
        g.timeline.push(request());
        assert.deepEqual(await problems(g.issue), [refused]);
        const h = added();
        h.issue.body = `${LINK}4321`;
        assert.deepEqual(await problems(h.issue), [refused]);
      });
    });

    it('checks the latest addition when a slice is removed and added again', async () => {
      const g = graph();
      g.timeline.push({ event: 'sub_issue_added', created_at: LATER, sub_issue: { number: 12 } });
      assert.deepEqual(await problems(g.issue), [refused]);
    });

    it('ignores the add of another slice', async () => {
      const g = graph();
      g.timeline.push({ event: 'sub_issue_added', created_at: LATEST, sub_issue: null });
      g.timeline.push({ event: 'sub_issue_added', created_at: LATER, sub_issue: { number: 13 } });
      g.siblings.push({ number: 14, type: { name: 'Slice' }, own: [{ event: 'parent_issue_added', created_at: LATEST, parent_issue: null }] });
      assert.deepEqual(await problems(g.issue), []);
    });

    it("reads a late addition from the slice's own timeline when GITHUB_TOKEN hides which issue was added", async () => {
      const g = graph();
      g.timeline[0] = { event: 'sub_issue_added', created_at: T0, sub_issue: null };
      g.timeline.push({ event: 'sub_issue_added', created_at: LATER, sub_issue: null });
      g.own.push({ event: 'parent_issue_added', created_at: LATER, parent_issue: null });
      assert.deepEqual(await problems(g.issue), [refused]);
    });

    it("owes the owner's say for a hidden late addition no sub-issue accounts for", async () => {
      const g = graph();
      g.timeline[0] = { event: 'sub_issue_added', created_at: T0, sub_issue: null };
      g.timeline.push({ event: 'sub_issue_removed', created_at: LEFT, sub_issue: null });
      g.timeline.push({ event: 'sub_issue_added', created_at: LATER, sub_issue: null });
      // The slice's own record is only its first addition, before approval: the later one may be it, added again.
      assert.deepEqual(await problems(g.issue), [refused]);
      g.own.length = 0;
      assert.deepEqual(await problems(g.issue), [refused], 'with no record of its own either');
      g.timeline.pop();
      assert.deepEqual(await problems(g.issue), [], 'hidden additions before approval owe nothing');
    });

    it("puts a hidden late addition down to the sibling whose own timeline records it", async () => {
      const g = graph();
      g.timeline.push({ event: 'sub_issue_removed', created_at: LEFT, sub_issue: null });
      g.timeline.push({ event: 'sub_issue_added', created_at: LATER, sub_issue: null });
      g.siblings.push({ number: 13, type: { name: 'Slice' }, own: [{ event: 'parent_issue_added', created_at: LATER, parent_issue: null }] });
      assert.deepEqual(await problems(g.issue), []);
      g.siblings[0] = { number: 13, type: { name: 'Slice' }, own: [{ event: 'parent_issue_added', created_at: LATEST, parent_issue: null }] };
      assert.deepEqual(await problems(g.issue), [refused], 'a sibling added at another moment does not account for it');
    });

    it('puts a hidden late addition down to another issue when the slice has not left the work item since its first addition', async () => {
      // athya-hq/athya-rules#214: a sub-issue added after the approval and removed minutes later; no sub-issue's
      // timeline records the addition now, and the slice, under the work item throughout, cannot have been added again.
      const g = graph();
      g.timeline.push({ event: 'sub_issue_added', created_at: LATER, sub_issue: null });
      g.timeline.push({ event: 'sub_issue_removed', created_at: LATEST, sub_issue: null });
      assert.deepEqual(await problems(g.issue), [], 'the removal came after the addition');
      g.timeline.push({ event: 'sub_issue_removed', created_at: LEFT, sub_issue: { number: 13 } });
      assert.deepEqual(await problems(g.issue), [], 'a removal naming another issue is not the slice leaving');
      g.timeline.push({ event: 'sub_issue_removed', created_at: T0, sub_issue: null });
      assert.deepEqual(await problems(g.issue), [], "a removal at the slice's first addition is not after it");
    });

    for (const [why, removal] of [
      ['naming no issue, between its first addition and the hidden one', { created_at: LEFT, sub_issue: null }],
      ['naming the slice', { created_at: LEFT, sub_issue: { number: 12 } }],
      ['at the moment of the hidden addition', { created_at: LATER, sub_issue: null }],
    ] as const) {
      it(`owes the owner's say for a hidden late addition after a removal ${why}`, async () => {
        const g = graph();
        g.timeline.push({ event: 'sub_issue_removed', ...removal });
        g.timeline.push({ event: 'sub_issue_added', created_at: LATER, sub_issue: null });
        assert.deepEqual(await problems(g.issue), [refused]);
      });
    }

    it("owes the owner's say where a time it weighs does not parse, as it may be any time", async () => {
      const removal = graph();
      removal.timeline.push({ event: 'sub_issue_removed', created_at: 'soon', sub_issue: null });
      removal.timeline.push({ event: 'sub_issue_added', created_at: LATER, sub_issue: null });
      assert.deepEqual(await problems(removal.issue), [refused], 'a removal at no readable time');
      const addition = graph();
      addition.timeline.push({ event: 'sub_issue_removed', created_at: LEFT, sub_issue: { number: 13 } });
      addition.timeline.push({ event: 'sub_issue_added', created_at: 'soon', sub_issue: null });
      assert.deepEqual(await problems(addition.issue), [refused], 'an addition at no readable time');
      const own = graph();
      own.own[0] = { event: 'parent_issue_added', created_at: 'soon', parent_issue: null };
      own.timeline[0] = { event: 'sub_issue_added', created_at: T0, sub_issue: null };
      own.timeline.push({ event: 'sub_issue_removed', created_at: T0, sub_issue: null });
      own.timeline.push({ event: 'sub_issue_added', created_at: LATER, sub_issue: null });
      assert.deepEqual(await problems(own.issue), [refused], "the slice's own addition at no readable time");
    });

    it('owes the owner\'s say for a hidden late addition when the slice has no addition on record, removal or not', async () => {
      const g = graph();
      g.timeline[0] = { event: 'sub_issue_added', created_at: T0, sub_issue: null };
      g.own.length = 0;
      g.timeline.push({ event: 'sub_issue_added', created_at: LATER, sub_issue: null });
      assert.deepEqual(await problems(g.issue), [refused]);
    });

    /** The timelines a run read, by issue number, in order. */
    const timelines = (sys: FakeSys): string[] => sys.requests.flatMap((r) => /\/issues\/(\d+)\/timeline\?/.exec(r.url)?.slice(1, 2) ?? []);

    it("reads a sibling's timeline only while an unnamed addition is left to put down, never the slice's own again", async () => {
      const g = graph();
      g.timeline.push({ event: 'sub_issue_removed', created_at: LEFT, sub_issue: null });
      g.timeline.push({ event: 'sub_issue_added', created_at: LATER, sub_issue: null });
      g.siblings.push(
        { number: 13, type: { name: 'Slice' }, own: [{ event: 'parent_issue_added', created_at: LATER, parent_issue: null }] },
        { number: 14, type: { name: 'Slice' }, own: [] },
      );
      const sys = new FakeSys();
      github(sys, g.issue);
      assert.deepEqual(await sliceProblems(sys, 'tok', SLUG, 12, ACCOUNTS, {}), []);
      assert.deepEqual(timelines(sys), ['10', '12', '13']);
    });

    it('reads no sibling when no unnamed addition comes after the approval, one made at its moment included', async () => {
      for (const at of [T0, APPROVED]) {
        const g = graph();
        g.timeline.push({ event: 'sub_issue_added', created_at: at, sub_issue: null });
        g.siblings.push({ number: 13, type: { name: 'Slice' }, own: [] });
        const sys = new FakeSys();
        github(sys, g.issue);
        assert.deepEqual(await sliceProblems(sys, 'tok', SLUG, 12, ACCOUNTS, {}), [], at);
        assert.ok(!sys.requests.some((r) => r.url.includes('/10/sub_issues')), at);
      }
    });

    it("takes the latest addition, whichever record names it first, and none at the approval's own moment", async () => {
      const g = graph();
      g.own[0] = { event: 'parent_issue_added', created_at: LATER, parent_issue: null };
      assert.deepEqual(await problems(g.issue), [refused], 'its own timeline later than the work item says');
      const h = graph();
      h.timeline[0] = { event: 'sub_issue_added', created_at: APPROVED, sub_issue: { number: 12 } };
      assert.deepEqual(await problems(h.issue), [], 'added at the moment of approval');
    });

    it("counts only additions: neither another event on the slice's own timeline nor a removal from the work item", async () => {
      const g = graph();
      g.own.push({ event: 'labeled', created_at: LATEST, actor: { login: OWNER }, label: { name: 'mechanical' } });
      g.timeline.push({ event: 'sub_issue_removed', created_at: LATER, sub_issue: { number: 12 } });
      assert.deepEqual(await problems(g.issue), []);
    });

    it("counts a Decision: or a request only after the addition, an owner's comment alone, opening its comment", async () => {
      for (const [why, made, want] of [
        ['a decision at the very moment of the addition', comment('Decision: keep it', LATER), [refused]],
        ['a decision opened by spaces', comment('  Decision: keep it'), []],
        ['a decision named in passing', comment('Not a Decision: yet'), [refused]],
      ] as const) {
        const g = added();
        g.comments.push(made);
        assert.deepEqual(await problems(g.issue), want, why);
      }
      const g = added();
      g.issue.body = `Requested: https://github.com/${SLUG}/issues/10#issuecomment-4321`;
      g.timeline.push({ ...comment('Please add it', LATER), id: 4321 });
      assert.deepEqual(await problems(g.issue), [refused], 'a request at the very moment of the addition');
      const h = added();
      h.issue.body = null;
      h.timeline.push({ event: 'reviewed', user: { login: OWNER }, body: 'Decision: add #12', created_at: LATEST, updated_at: LATEST });
      assert.deepEqual(await problems(h.issue), [refused], 'another event that carries a body, and a slice with none');
    });

    it("reads a request in a repository whose name has a dot only by the dot", async () => {
      const DOTTED = 'example-org/example.app';
      const link = (slug: string): ReturnType<typeof graph> => {
        const g = added();
        g.issue.body = `Requested: https://github.com/${slug}/issues/10#issuecomment-4321`;
        g.timeline.push({ ...comment('Please add it', APPROVED), id: 4321 });
        return g;
      };
      for (const [slug, want] of [[DOTTED, 0], ['example-org/exampleXapp', 1]] as const) {
        const sys = new FakeSys();
        github(sys, link(slug).issue, [], DOTTED);
        sys.route('GET', `/repos/${DOTTED}/pulls?state=open&per_page=100&page=1`, { status: 200, json: [] });
        assert.equal((await sliceProblems(sys, 'tok', DOTTED, 12, ACCOUNTS, {})).length, want, slug);
      }
    });

    it('finds a proposal opened by spaces, not one named in passing, nor one by no account', async () => {
      const nobody: Node = { ...comment('Proposal: add #12', LATER, AGENT), user: null };
      for (const [made, want] of [
        [comment('  Proposal: add #12', LATER, AGENT), []],
        [comment('Re Proposal: add #12', LATER, AGENT), [refused]],
        [nobody, [refused]],
      ] as const) {
        const g = added();
        g.comments.push(made);
        g.thumbs.set(made.id as string, [thumb()]);
        assert.deepEqual(await problems(g.issue), want, made.body as string);
      }
    });

    it("counts a 👍 only after the addition and after the proposal's last edit, neither at their moment", async () => {
      for (const [why, edited, at, want] of [
        ['at the moment of the addition', null, LATER, 1],
        ['before the proposal was edited', EDITED, LATEST, 1],
        ['at the moment of the edit', EDITED, EDITED, 1],
        ['after the edit', EDITED, '2026-10-06T00:00:00Z', 0],
      ] as const) {
        const g = added();
        const made = comment('Proposal: add #12', LATER, AGENT, edited);
        g.comments.push(made);
        g.thumbs.set(made.id as string, [thumb(at)]);
        assert.equal((await problems(g.issue)).length, want, why);
      }
    });

    it("reads no Approvals issue when the settings name none, and reads no reactions to a proposal once a decision settles it", async () => {
      const sys = new FakeSys();
      const g = added();
      const made = comment('Proposal: add #12', LATER, AGENT);
      g.comments.push(made, comment('Decision: keep it'));
      github(sys, g.issue);
      assert.deepEqual(await sliceProblems(sys, 'tok', SLUG, 12, ACCOUNTS, {}), []);
      assert.ok(!sys.requests.some((r) => r.url.includes('/reactions')));
      const none = new FakeSys();
      github(none, added().issue);
      assert.deepEqual(await sliceProblems(none, 'tok', SLUG, 12, ACCOUNTS, {}), [refused]);
      assert.ok(!none.requests.some((r) => r.url.includes('/issues/undefined/')));
    });

    describe("the owner's 👍 on the agent's proposal", () => {
      /** Slice #12 added after approval, with the agent's proposal on it and these 👍s. */
      const withProposal = (thumbs: Node[], made: Node = comment('Proposal: add #12 (Add the thing) to work item #10', LATER, AGENT)): ReturnType<typeof graph> => {
        const g = added();
        g.comments.push(made);
        g.thumbs.set(made.id as string, thumbs);
        return g;
      };

      it('reads every page of a proposal\'s 👍s', async () => {
        assert.deepEqual(await problems(withProposal([...Array.from({ length: 100 }, () => thumb(LATEST, AGENT)), thumb()]).issue), []);
      });

      it('passes, made after the slice was added', async () => {
        assert.deepEqual(await problems(withProposal([thumb(LATEST, AGENT), thumb()]).issue), []);
      });

      it('passes, made after the proposal was last edited', async () => {
        const made = comment('Proposal: add #12', LATER, AGENT, LATER);
        assert.deepEqual(await problems(withProposal([thumb()], made).issue), []);
      });

      // The refusal names the propose command while the agent's proposal is missing.
      for (const [name, thumbs, made, expected] of [
        ['by the agent', [thumb(LATEST, AGENT)], undefined, proposed],
        ['by anyone else', [thumb(LATEST, 'someone'), { user: null, created_at: LATEST }], undefined, proposed],
        ['made before the slice was added', [thumb(APPROVED)], undefined, proposed],
        ['on a proposal edited after it', [thumb(LATER)], comment('Proposal: add #12', LATER, AGENT, LATEST), proposed],
        ["on the owner's own proposal", [thumb()], comment('Proposal: add #12', LATER, OWNER), refused],
        ['on an agent comment that is not a proposal', [thumb()], comment('Added #12 for the owner', LATER, AGENT), refused],
        ['on a proposal for another issue', [thumb()], comment('Proposal: drop state #30 (of #12)', LATER, AGENT), refused],
        ['on a proposal naming #12abc', [thumb()], comment('Proposal: add #12abc', LATER, AGENT), refused],
      ] as const) {
        it(`does not pass when ${name}`, async () => {
          const proposal = made ?? comment('Proposal: add #12 (Add the thing) to work item #10', LATER, AGENT);
          // With the agent's proposal there, the refusal names its own address, where the owner reacts (#557).
          const want = expected === proposed ? proposed.replace(`ExampleBot's proposal on #12, ${W}/12`, `ExampleBot's proposal, ${proposal.html_url as string}`) : expected;
          assert.match(want, /#issuecomment-|propose 12/);
          assert.deepEqual(await problems(withProposal([...thumbs], proposal).issue), [want]);
        });
      }

      it('finds a proposal that later comments pushed back, reading every page of the slice\'s comments', async () => {
        const sys = new FakeSys();
        const g = added();
        const made = comment('Proposal: add #12', LATER, AGENT);
        g.thumbs.set(made.id as string, [thumb()]);
        for (let i = 0; i < 100; i++) g.comments.push(comment('Later talk', LATEST, AGENT));
        g.comments.push(made);
        github(sys, g.issue);
        assert.deepEqual(await sliceProblems(sys, 'tok', SLUG, 12, ACCOUNTS, {}), []);
        assert.ok(sys.requests.some((r) => r.url === `${ISSUES}/12/comments?per_page=100&page=2`));
      });

      it('reads no reactions when a Decision: settles it, or nothing was proposed', async () => {
        const sys = new FakeSys();
        const g = withProposal([thumb()]);
        g.comments.push(comment('Decision: keep it'));
        github(sys, g.issue);
        assert.deepEqual(await sliceProblems(sys, 'tok', SLUG, 12, ACCOUNTS, {}), []);
        const none = new FakeSys();
        github(none, added().issue);
        await sliceProblems(none, 'tok', SLUG, 12, ACCOUNTS, {});
        for (const run of [sys, none]) assert.ok(!run.requests.some((r) => r.url.includes('/reactions')));
      });

      it("reads each proposal's 👍s, a deleted proposal having none", async () => {
        const sys = new FakeSys();
        const g = added();
        g.comments.push(comment('Proposal: add #12', LATER, AGENT));
        g.comments.push({ ...comment('Proposal: add #12', LATER, AGENT), id: 'gone' });
        const last = comment('Proposal: add #12', LATER, AGENT);
        g.comments.push(last);
        g.thumbs.set(last.id as string, [thumb()]);
        github(sys, g.issue);
        assert.deepEqual(await sliceProblems(sys, 'tok', SLUG, 12, ACCOUNTS, {}), []);
        assert.equal(sys.requests.filter((r) => r.url.includes('/reactions')).length, 3);
      });
    });
  });

  describe('a dropped state', () => {
    const state = (extra: Node = {}): Node => ({
      number: 30,
      type: { name: 'State' },
      state_reason: 'not_planned',
      closed_at: LATER,
      comments: [],
      ...extra,
    });
    const refused =
      `state #30, ${W}/30, was closed as not planned after approval; example-owner reacts 👍 on ExampleBot's proposal for it on #12, ${W}/12, or adds a "Decision:" comment to it; ExampleBot proposes it with: niyam propose 30 --page <page url>`;

    it('is refused without the owner\'s decision', async () => {
      const g = graph();
      g.states.push(state());
      assert.deepEqual(await problems(g.issue), [refused]);
    });

    it("passes with the owner's Decision: on the state, or naming it on the slice", async () => {
      const g = graph();
      g.states.push(state({ comments: [comment('Decision: drop it')] }));
      assert.deepEqual(await problems(g.issue), []);
      const h = graph();
      h.states.push(state());
      h.comments.push(comment('Decision: drop #30'));
      assert.deepEqual(await problems(h.issue), []);
    });

    it("refuses the owner's Decision: the agent edited, on the state or the slice, and takes one owners alone edited", async () => {
      const onState = comment('Decision: drop it', LATEST, OWNER, EDITED);
      const g = graph();
      g.states.push(state({ comments: [onState] }));
      const why = refused.replace('; ExampleBot proposes', `${OTHERS_EDITED}; ExampleBot proposes`);
      assert.deepEqual(await withEdits(g.issue, { [onState.id as string]: [AGENT, OWNER] }), { problems: [why], graphql: 1 });
      assert.deepEqual(await withEdits(g.issue, { [onState.id as string]: [OWNER, OWNER] }), { problems: [], graphql: 1 });
      const onSlice = comment('Decision: drop #30', LATEST, OWNER, EDITED);
      const h = graph();
      h.states.push(state());
      h.comments.push(onSlice);
      assert.deepEqual(await withEdits(h.issue, { [onSlice.id as string]: [AGENT, OWNER] }), { problems: [why], graphql: 1 });
      // An unedited Decision: on the state still settles it, and needs no GraphQL.
      const i = graph();
      i.states.push(state({ comments: [comment('Decision: drop it')] }));
      i.comments.push(onSlice);
      assert.deepEqual(await withEdits(i.issue, 'refused'), { problems: [], graphql: 0 });
    });

    it("passes with the owner's batch answer on the Approvals issue made after the state was dropped, not before", async () => {
      const g = graph();
      g.states.push(state());
      g.approvals.push(comment('Decision: approve #30'));
      assert.deepEqual(await problems(g.issue, [], {}, WITH_APPROVALS), []);
      const h = graph();
      h.states.push(state());
      h.approvals.push(comment('Decision: approve #30', APPROVED));
      const batched = refused.replace('; ExampleBot proposes', `, or example-owner comments on #700, the Approvals issue, ${W}/700, with a first line "Decision: approve #30"; ExampleBot proposes`);
      assert.deepEqual(await problems(h.issue, [], {}, WITH_APPROVALS), [batched]);
    });

    it('reads the Approvals issue once a check, for an added slice and a dropped state alike', async () => {
      const g = graph();
      g.timeline[0] = { event: 'sub_issue_added', created_at: LATER, sub_issue: { number: 12 } };
      g.states.push(state());
      g.approvals.push(comment('Decision: approve #30 #12'));
      const sys = new FakeSys();
      github(sys, g.issue);
      assert.deepEqual(await sliceProblems(sys, 'tok', SLUG, 12, WITH_APPROVALS, {}), []);
      assert.equal(sys.requests.filter((request) => request.url.includes(`/issues/${APPROVALS}/comments`)).length, 1);
    });

    it("passes with the owner's 👍 on the agent's proposal for it on the slice", async () => {
      const g = graph();
      g.states.push(state());
      const made = comment('Proposal: drop state #30 (Empty list), closed as not planned', LATER, AGENT);
      g.comments.push(made);
      g.thumbs.set(made.id as string, [thumb()]);
      assert.deepEqual(await problems(g.issue), []);
      g.thumbs.set(made.id as string, [thumb(LATEST, AGENT)]);
      assert.deepEqual(await problems(g.issue), [refused.replace(/; ExampleBot proposes it with: .*$/, '').replace(`proposal for it on #12, ${W}/12`, `proposal for it, ${made.html_url as string}`)]);
    });

    describe('past the first page of states', () => {
      /** Slice #12 with 150 states: 100 on the first page, 50 on a second, the dropped one #149 among them. */
      const many = (dropped: Node): ReturnType<typeof graph> => {
        const g = graph();
        for (let n = 0; n < 149; n++) g.states.push(state({ number: n, closed_at: null }));
        g.states.push(state({ number: 149, ...dropped }));
        return g;
      };

      it('refuses a state dropped on the second page', async () => {
        assert.deepEqual(await problems(many({}).issue), [refused.replaceAll('#30', '#149').replace('issues/30,', 'issues/149,').replace('propose 30', 'propose 149')]);
      });

      it("passes with the owner's Decision: among the state's earlier comments", async () => {
        const comments = [...Array.from({ length: 100 }, () => comment('a note', LATER, AGENT)), comment('Decision: drop it')];
        assert.deepEqual(await problems(many({ comments }).issue), []);
      });
    });

    for (const [name, extra] of [
      ['completed', { state_reason: 'completed' }],
      ['dropped before approval', { closed_at: T0 }],
      ['open', { closed_at: null }],
      ['not a State', { type: { name: 'Brief' } }],
      ['of no type', { type: null }],
    ] as const) {
      it(`ignores a state ${name}`, async () => {
        const g = graph();
        g.states.push(state(extra));
        assert.deepEqual(await problems(g.issue), []);
      });
    }

    it('owes the owner a state dropped at the very moment of approval', async () => {
      const g = graph();
      g.states.push(state({ closed_at: APPROVED }));
      assert.deepEqual(await problems(g.issue), [refused]);
    });

    it("counts a Decision: on the slice only for the state it names, and then reads nothing more for it", async () => {
      const g = graph();
      g.states.push(state());
      g.comments.push(comment('Decision: add #12'));
      assert.deepEqual(await problems(g.issue), [refused], 'a decision naming another issue');
      const sys = new FakeSys();
      const h = graph();
      h.states.push(state());
      h.comments.push(comment('Decision: drop #30'));
      github(sys, h.issue);
      assert.deepEqual(await sliceProblems(sys, 'tok', SLUG, 12, WITH_APPROVALS, {}), []);
      assert.ok(!sys.requests.some((r) => r.url.includes('/30/comments') || r.url.includes(`/${APPROVALS}/comments`)));
    });
  });

  describe('a second pull request', () => {
    const pull = (number: number, body: string | null, ref = `b${number}`, repo: string | null = SLUG): Node => ({
      number,
      body,
      head: { ref, repo: repo === null ? null : { full_name: repo } },
    });
    /** The refusal for pull request `number` from branch `b<number>` here: its address, and the command that deletes its branch (#557). */
    const second = (number: number, ref = `b${number}`): string =>
      `#12 already has pull request #${number}, https://github.com/${SLUG}/pull/${number}; one slice, one pull request. If #${number} is superseded, close it and delete its branch: git push origin --delete ${ref}`;
    const fork = (number: number): string => `#12 already has pull request #${number}, https://github.com/${SLUG}/pull/${number}; one slice, one pull request. If #${number} is superseded, close it`;

    it('is refused', async () => {
      assert.deepEqual(await problems(graph().issue, [pull(5, 'Slice: #12'), pull(6, null), pull(7, 'Slice: #13')]), [
        second(5),
      ]);
    });

    it('does not count the pull request or branch being checked', async () => {
      assert.deepEqual(await problems(graph().issue, [pull(5, 'Slice: #12')], { pull: 5 }), []);
      assert.deepEqual(await problems(graph().issue, [pull(5, 'Slice: #12', 'feature', 'Example-Org/Example-App')], { branch: 'feature' }), []);
    });

    it("counts a fork's pull request from a branch of the same name", async () => {
      assert.deepEqual(await problems(graph().issue, [pull(6, 'Slice: #12', 'feature', 'someone/example-app'), pull(7, 'Slice: #12', 'feature', null)], { branch: 'feature' }), [
        fork(6),
        fork(7),
      ]);
    });

    it("gives GitHub's own address for it, and quotes a branch the shell would split (#557)", async () => {
      const given = { ...pull(5, 'Slice: #12', "it's mine"), html_url: 'https://github.com/example-org/example-app/pull/5?given' };
      assert.deepEqual(await problems(graph().issue, [given]), [
        "#12 already has pull request #5, https://github.com/example-org/example-app/pull/5?given; one slice, one pull request. If #5 is superseded, close it and delete its branch: git push origin --delete 'it'\\''s mine'",
      ]);
      // A branch git would read as an option or a forced push is named in full.
      for (const ref of ['-x', '+x']) {
        assert.deepEqual(await problems(graph().issue, [pull(5, 'Slice: #12', ref)]), [second(5, `refs/heads/${ref}`)]);
      }
    });

    it('reads every page of open pull requests', async () => {
      const sys = new FakeSys();
      github(sys, graph().issue, Array.from({ length: 100 }, (_, i) => pull(100 + i, 'none')));
      sys.route('GET', `/repos/${SLUG}/pulls?state=open&per_page=100&page=2`, { status: 200, json: [pull(9, 'Slice: #12')] });
      assert.deepEqual(await sliceProblems(sys, 'tok', SLUG, 12, ACCOUNTS, {}), [second(9)]);
    });
  });

  it('reads every page of the work item\'s timeline', async () => {
    const sys = new FakeSys();
    const g = graph();
    // The approval comes after 100 other events, on the second page.
    g.timeline.splice(1, 0, ...Array.from({ length: 100 }, () => ({ event: 'cross-referenced', created_at: T0 })));
    github(sys, g.issue);
    assert.deepEqual(await sliceProblems(sys, 'tok', SLUG, 12, ACCOUNTS, {}), []);
    assert.ok(sys.requests.some((r) => r.url === `${ISSUES}/10/timeline?per_page=100&page=2`));
  });

  it('says how to fix a client workflow without issues: read', async () => {
    const sys = new FakeSys();
    sys.route('GET', `${ISSUES}/12`, { status: 403, json: { message: 'Resource not accessible by integration' } });
    await assert.rejects(sliceProblems(sys, 'tok', SLUG, 12, ACCOUNTS, {}), /needs issues: read, so run niyam onboard to update it/);
  });

  it('throws when GitHub will not answer', async () => {
    const sys = new FakeSys();
    sys.route('GET', `${ISSUES}/12`, { status: 403, json: { message: 'no access' } });
    await assert.rejects(sliceProblems(sys, 'tok', SLUG, 12, ACCOUNTS, {}), /cannot read #12: no access \(\/repos\/example-org\/example-app\/issues\/12\)/);
    sys.route('GET', `${ISSUES}/12`, { status: 502, json: null });
    await assert.rejects(sliceProblems(sys, 'tok', SLUG, 12, ACCOUNTS, {}), /cannot read #12: HTTP 502/);
    const listless = new FakeSys();
    github(listless, graph().issue);
    listless.route('GET', `${ISSUES}/12/comments?per_page=100&page=1`, { status: 200, json: {} });
    await assert.rejects(sliceProblems(listless, 'tok', SLUG, 12, ACCOUNTS, {}), /GitHub did not answer a list \(\/repos\/example-org\/example-app\/issues\/12\/comments\)/);
    sys.routes.delete(`GET ${ISSUES}/12`);
    github(sys, graph().issue);
    sys.route('GET', `/repos/${SLUG}/pulls?state=open&per_page=100&page=1`, { status: 403, json: null });
    await assert.rejects(sliceProblems(sys, 'tok', SLUG, 12, ACCOUNTS, {}), /cannot list open pull requests \(HTTP 403\)/);
  });

  describe('a slice in another repository', () => {
    const PLANS_ISSUES = `https://api.github.com/repos/${PLANS}/issues`;
    const theirs = { repo: PLANS, number: 12 };
    async function foreign(issue: Node | null, pulls: Node[] = [], accounts: Settings = ACCOUNTS, mine: { pull?: number; states?: { repo: string; number: number }[] } = {}): Promise<{ problems: string[]; sys: FakeSys }> {
      const sys = new FakeSys();
      github(sys, issue, pulls, PLANS);
      return { problems: await sliceProblems(sys, 'tok', SLUG, theirs, accounts, mine), sys };
    }

    it('lets it be built when it is a Slice under a Work item the owner approved there, reading nothing of this repository\'s #12', async () => {
      const { problems: found, sys } = await foreign(graph().issue);
      assert.deepEqual(found, []);
      assert.ok(sys.requests.some((request) => request.url === `${PLANS_ISSUES}/12`));
      assert.ok(sys.requests.some((request) => request.url.startsWith(`${PLANS_ISSUES}/10/timeline`)));
      assert.equal(sys.requests.some((request) => request.url.startsWith(`${ISSUES}/`)), false);
    });

    for (const status of [404, 403]) {
      it(`refuses one the token cannot read (HTTP ${status}), naming it in full`, async () => {
        const sys = new FakeSys();
        github(sys, graph().issue, [], PLANS);
        sys.route('GET', `${PLANS_ISSUES}/12`, { status, json: { message: status === 404 ? 'Not Found' : 'Resource not accessible by integration' } });
        assert.deepEqual(await sliceProblems(sys, 'tok', SLUG, theirs, ACCOUNTS, {}), [
          `${PLANS}#12 cannot be read with this token (HTTP ${status}: ${status === 404 ? 'Not Found' : 'Resource not accessible by integration'}): a slice in another repository counts only where the token reads that repository, and a workflow's GITHUB_TOKEN reads no private repository but ${SLUG}`,
        ]);
      });
    }

    it('throws, reading it once, when GitHub there answers otherwise', async () => {
      const sys = new FakeSys();
      sys.route('GET', `${PLANS_ISSUES}/12`, { status: 502, json: null });
      await assert.rejects(sliceProblems(sys, 'tok', SLUG, theirs, ACCOUNTS, {}), new RegExp(`^Error: cannot read ${PLANS}#12: HTTP 502 \\(/repos/${PLANS}/issues/12\\)$`));
      assert.equal(sys.requests.filter((request) => request.url === `${PLANS_ISSUES}/12`).length, 1);
    });

    it('refuses a pull request there', async () => {
      const sys = new FakeSys();
      sys.route('GET', `${PLANS_ISSUES}/12`, { status: 200, json: { number: 12, pull_request: {} } });
      assert.deepEqual(await sliceProblems(sys, 'tok', SLUG, theirs, ACCOUNTS, {}), [`${PLANS}#12 is a pull request, not an issue`]);
    });

    it('refuses one GitHub there answers 401, or 404 with no message, naming the status alone', async () => {
      for (const [status, json, said] of [[401, { message: 'Bad credentials' }, `HTTP 401: Bad credentials`], [404, null, 'HTTP 404']] as const) {
        const sys = new FakeSys();
        sys.route('GET', `${PLANS_ISSUES}/12`, { status, json });
        assert.deepEqual(await sliceProblems(sys, 'tok', SLUG, theirs, ACCOUNTS, {}), [
          `${PLANS}#12 cannot be read with this token (${said}): a slice in another repository counts only where the token reads that repository, and a workflow's GITHUB_TOKEN reads no private repository but ${SLUG}`,
        ]);
      }
    });

    it('names it in full when a read there fails, saying the token cannot read the repository where GitHub says so', async () => {
      const TIMELINE = `/repos/${PLANS}/issues/10/timeline?per_page=100&page=1`;
      for (const [message, hint] of [
        ['Resource not accessible by integration', `; this token cannot read ${PLANS}`],
        ['Server Error', ''],
      ] as const) {
        const sys = new FakeSys();
        github(sys, graph().issue, [], PLANS);
        sys.route('GET', TIMELINE, { status: 500, json: { message } });
        await assert.rejects(sliceProblems(sys, 'tok', SLUG, theirs, ACCOUNTS, {}), { message: `cannot read ${PLANS}#12: ${message} (${TIMELINE})${hint}` });
      }
    });

    it('asks with the token, here and there', async () => {
      for (const [slug, which] of [[SLUG, 12], [PLANS, theirs]] as const) {
        const sys = new FakeSys();
        github(sys, graph().issue, [], slug);
        assert.deepEqual(await sliceProblems(sys, 'tok', SLUG, which, ACCOUNTS, {}), []);
        assert.deepEqual(sys.requests.filter((r) => r.token !== 'tok').map((r) => r.url), [], slug);
      }
    });

    it("tells another repository's closed slice to file its State in a clone there, named owner/name#N", async () => {
      const g = graph();
      g.issue.state = 'closed';
      const { problems: found } = await foreign(g.issue, [], ACCOUNTS, { pull: 40, states: [] });
      assert.deepEqual(found, [
        `${PLANS}#12 is closed, so this pull request is a fix: file it as a State under ${PLANS}#12 with (in a clone of ${PLANS}) niyam state 12 --title "…" and name it with a line "State: ${PLANS}#N"`,
      ]);
    });

    it('refuses one that is not a Slice, or not under a Work item, naming it in full', async () => {
      assert.deepEqual((await foreign({ ...graph().issue, type: { name: 'Task' } })).problems, [`${PLANS}#12 is not a Slice (its type is Task)`]);
      assert.deepEqual((await foreign({ ...graph().issue, parent: null })).problems, [`${PLANS}#12 is not a sub-issue of a Work item`]);
    });

    it('refuses one whose Work item there is not approved, or approved by someone else', async () => {
      const g = graph();
      g.timeline.splice(1, 1);
      assert.deepEqual((await foreign(g.issue)).problems, [`work item ${PLANS}#10, ${P}/10, is not approved: example-owner adds the approved label before any slice starts`]);
      g.timeline.push({ event: 'labeled', created_at: APPROVED, actor: { login: AGENT }, label: { name: 'approved' } });
      assert.deepEqual((await foreign(g.issue)).problems, [`work item ${PLANS}#10, ${P}/10, was labeled approved by ExampleBot, not example-owner`]);
    });

    describe('added after approval', () => {
      const added = (): ReturnType<typeof graph> => {
        const g = graph();
        g.timeline[0] = { event: 'sub_issue_added', created_at: LATER, sub_issue: { number: 12 } };
        return g;
      };
      const proposed = `${PLANS}#12 was added to work item ${PLANS}#10, ${P}/10, after its approval; example-owner reacts 👍 on ExampleBot's proposal on ${PLANS}#12, ${P}/12, or adds a "Decision:" comment naming #12 on ${P}/12, or ${PLANS}#12 links example-owner's request for it on ${PLANS}#10`;
      const proposes = `; ExampleBot proposes it in a clone of ${PLANS} with: niyam propose 12 --page <page url>`;

      it('is refused without the owner\'s say there, which is to be proposed from its own repository', async () => {
        assert.deepEqual((await foreign(added().issue)).problems, [`${proposed}${proposes}`]);
      });

      it("passes with the owner's 👍 on the agent's proposal there", async () => {
        const g = added();
        const proposal = comment('Proposal: add #12 (Add the thing) to work item #10.', LATER, AGENT);
        g.comments.push(proposal);
        g.thumbs.set(proposal.id as string, [thumb()]);
        const { problems: found, sys } = await foreign(g.issue);
        assert.deepEqual(found, []);
        assert.ok(sys.requests.some((request) => request.url.startsWith(`https://api.github.com/repos/${PLANS}/issues/comments/${proposal.id}/reactions`)));
      });

      it("passes with a batch answer on that repository's Approvals issue, never this one's", async () => {
        const g = added();
        g.approvals.push(comment('Decision: approve #12'));
        const settings = { status: 200, json: { content: Buffer.from(JSON.stringify({ approvals: APPROVALS })).toString('base64') } };
        const sys = new FakeSys();
        github(sys, g.issue, [], PLANS);
        sys.route('GET', `/repos/${PLANS}/contents/.github/niyam.json`, settings);
        // This repository's settings name an Approvals issue of their own number, which is not read.
        assert.deepEqual(await sliceProblems(sys, 'tok', SLUG, theirs, { ...ACCOUNTS, approvals: 999 }, {}), []);
        assert.equal(sys.requests.some((request) => request.url.includes('/issues/999/')), false);
      });

      it('names that Approvals issue in full, and none where its settings cannot be read', async () => {
        const sys = new FakeSys();
        github(sys, added().issue, [], PLANS);
        sys.route('GET', `/repos/${PLANS}/contents/.github/niyam.json`, { status: 200, json: { content: Buffer.from(JSON.stringify({ approvals: APPROVALS })).toString('base64') } });
        assert.deepEqual(await sliceProblems(sys, 'tok', SLUG, theirs, ACCOUNTS, {}), [
          `${proposed}, or example-owner comments on ${PLANS}#700, the Approvals issue, ${P}/700, with a first line "Decision: approve #12"${proposes}`,
        ]);
        // The settings there unread (404 here): no batch path, as for a repository whose settings name none.
        assert.deepEqual((await foreign(added().issue, [], WITH_APPROVALS)).problems, [`${proposed}${proposes}`]);
      });
    });

    it('reads its States there, and refuses a State named in this repository', async () => {
      const g = graph();
      g.states.push({ number: 31, title: 'The thing', type: { name: 'State' }, state: 'open', state_reason: null, closed_at: null, comments: [] });
      assert.deepEqual((await foreign(g.issue, [], ACCOUNTS, { states: [{ repo: PLANS, number: 31 }] })).problems, []);
      assert.deepEqual((await foreign(g.issue, [], ACCOUNTS, { states: [{ repo: SLUG, number: 31 }] })).problems, [
        `#31 is not a State under slice ${PLANS}#12; a "State: #N" line names a State sub-issue of the slice the pull request builds`,
      ]);
    });

    it('is one slice per pull request by its whole name: this repository\'s #12 is another slice', async () => {
      const pulls = [
        { number: 6, body: 'Slice: #12', head: { ref: 'a', repo: { full_name: SLUG } } },
        { number: 7, body: `Slice: https://github.com/${PLANS}/issues/12`, head: { ref: 'b', repo: { full_name: SLUG } } },
      ];
      assert.deepEqual((await foreign(graph().issue, pulls)).problems, [`${PLANS}#12 already has pull request #7, https://github.com/${SLUG}/pull/7; one slice, one pull request. If #7 is superseded, close it and delete its branch: git push origin --delete b`]);
      const sys = new FakeSys();
      github(sys, graph().issue, [pulls[1] as Node]);
      assert.deepEqual(await sliceProblems(sys, 'tok', SLUG, 12, ACCOUNTS, {}), []);
    });
  });
});

describe('prWorkRules', () => {
  const EVENT = '/tmp/event.json';
  function actions(pull: Node | undefined): FakeSys {
    const sys = new FakeSys();
    sys.env = { GITHUB_EVENT_PATH: EVENT, GITHUB_REPOSITORY: SLUG, GH_TOKEN: 'ghs_run' };
    sys.files.set(EVENT, JSON.stringify(pull ? { pull_request: pull } : {}));
    return sys;
  }
  const agentPull = (body: string | null): Node => ({ number: 40, body, user: { login: AGENT }, head: { ref: 'work' } });
  async function check(sys: FakeSys): Promise<{ code: number; out: string[]; err: string[] }> {
    const { io, out, err } = capture();
    return { code: await prWorkRules(sys, io), out, err };
  }

  for (const line of [`Slice: https://github.com/${PLANS}/issues/12`, `Slice: ${PLANS}#12`]) {
    it(`passes an agent pull request naming another repository's slice as "${line}"`, async () => {
      const sys = actions(agentPull(`Builds the thing.\n\n${line}`));
      github(sys, graph().issue, [{ number: 40, body: line, head: { ref: 'work' } }], PLANS);
      assert.deepEqual(await check(sys), { code: 0, out: [`✓ pr-work-rules: #40 builds slice ${PLANS}#12, which may be built`], err: [] });
    });
  }

  it("refuses another repository's slice that the workflow's token cannot read", async () => {
    const sys = actions(agentPull(`Slice: ${PLANS}#12`));
    github(sys, graph().issue, [], PLANS);
    sys.route('GET', `/repos/${PLANS}/issues/12`, { status: 404, json: { message: 'Not Found' } });
    assert.deepEqual(await check(sys), {
      code: 1,
      out: [],
      err: [
        `✗ ${PLANS}#12 cannot be read with this token (HTTP 404: Not Found): a slice in another repository counts only where the token reads that repository, and a workflow's GITHUB_TOKEN reads no private repository but ${SLUG}`,
        'pr-work-rules: refused by the work rules',
      ],
    });
  });

  it('passes an agent pull request naming a slice that may be built', async () => {
    const sys = actions(agentPull('Builds the thing.\n\nSlice: #12'));
    github(sys, graph().issue, [{ number: 40, body: 'Slice: #12', head: { ref: 'work' } }]);
    assert.deepEqual(await check(sys), { code: 0, out: ['✓ pr-work-rules: #40 builds slice #12, which may be built'], err: [] });
    assert.equal(sys.requests[0]?.token, 'ghs_run');
  });

  /** Slice #12 closed, with State #31 filed under it after approval to fix it, and #30, an earlier State, delivered. */
  function fixed(): ReturnType<typeof graph> {
    const g = graph();
    g.issue.state = 'closed';
    g.issue.closed_at = LATER;
    g.states.push(
      { number: 30, title: 'The thing', type: { name: 'State' }, state: 'closed', state_reason: 'completed', closed_at: LATER, comments: [] },
      { number: 31, title: 'Fix: the thing on narrow pages', type: { name: 'State' }, state: 'open', state_reason: null, closed_at: null, comments: [] },
    );
    return g;
  }

  it('passes a fix: a pull request naming the closed slice it fixes, and the State filed under it after approval', async () => {
    const sys = actions(agentPull('Fixes the thing on narrow pages.\n\nSlice: #12\nState: #31'));
    github(sys, fixed().issue);
    assert.deepEqual(await check(sys), { code: 0, out: ['✓ pr-work-rules: #40 builds slice #12, which may be built'], err: [] });
  });

  for (const [name, body] of [
    ['names no State', 'Fixes state #31.\n\nSlice: #12'],
    ['names only a State delivered already', 'Slice: #12\nState: #30'],
  ] as const) {
    it(`refuses a fix for a closed slice that ${name}, so the merge could not close it`, async () => {
      const sys = actions(agentPull(body));
      github(sys, fixed().issue);
      assert.deepEqual(await check(sys), {
        code: 1,
        out: [],
        err: ['✗ #12 is closed, so this pull request is a fix: file it as a State under #12 with niyam state 12 --title "…" and name it with a line "State: #N"', 'pr-work-rules: refused by the work rules'],
      });
    });
  }

  // An event after the merge reads the slice the merge closed (#649: #598's description edited 7 seconds after its
  // merge, run 45394953619).
  for (const [merged, said] of [
    [true, 'merged'],
    [false, 'closed'],
  ] as const) {
    it(`passes a pull request already ${said}, its slice closed, reading no slice`, async () => {
      const sys = actions({ ...agentPull('Slice: #12'), state: 'closed', merged });
      github(sys, fixed().issue);
      assert.deepEqual(await check(sys), { code: 0, out: [`pr-work-rules: #40 is ${said}; nothing to judge`], err: [] });
      assert.deepEqual(
        sys.requests.filter((request) => request.url.includes('/issues/')),
        [],
      );
    });
  }

  it('judges an open pull request as before: a closed slice it names with no State is a fix still owed', async () => {
    const sys = actions({ ...agentPull('Slice: #12'), state: 'open', merged: false });
    github(sys, fixed().issue);
    assert.deepEqual(await check(sys), {
      code: 1,
      out: [],
      err: ['✗ #12 is closed, so this pull request is a fix: file it as a State under #12 with niyam state 12 --title "…" and name it with a line "State: #N"', 'pr-work-rules: refused by the work rules'],
    });
  });

  it('refuses a "State:" line naming anything but a State under the slice', async () => {
    const g = graph();
    g.states.push({ number: 33, title: 'A note', type: { name: 'Task' }, state: 'open', state_reason: null, closed_at: null, comments: [] });
    const sys = actions(agentPull('Slice: #12\nState: #33\nState: #99'));
    github(sys, g.issue);
    const { code, err } = await check(sys);
    assert.equal(code, 1);
    assert.deepEqual(err, [
      '✗ #33 is not a State under slice #12; a "State: #N" line names a State sub-issue of the slice the pull request builds',
      '✗ #99 is not a State under slice #12; a "State: #N" line names a State sub-issue of the slice the pull request builds',
      'pr-work-rules: refused by the work rules',
    ]);
  });

  it('passes an open slice with or without a "State:" line', async () => {
    const g = graph();
    g.states.push({ number: 31, title: 'The thing', type: { name: 'State' }, state: 'open', state_reason: null, closed_at: null, comments: [] });
    for (const body of ['Slice: #12', 'Slice: #12\nState: #31']) {
      const sys = actions(agentPull(body));
      github(sys, g.issue);
      assert.equal((await check(sys)).code, 0);
    }
  });

  it('refuses an agent pull request whose slice may not be built', async () => {
    const g = graph();
    g.timeline.splice(1, 1);
    const sys = actions(agentPull('Slice: #12'));
    github(sys, g.issue);
    const { code, err } = await check(sys);
    assert.equal(code, 1);
    assert.deepEqual(err, [`✗ work item #10, ${W}/10, is not approved: example-owner adds the approved label before any slice starts`, 'pr-work-rules: refused by the work rules']);
  });

  for (const [body, problem] of [
    [null, '#40 names no slice; add a line "Slice: #N" to its description'],
    ['Slice: #12\nSlice: #13', '#40 names 2 slices (#12, #13); an agent pull request builds exactly one'],
  ] as const) {
    it(`refuses an agent pull request with body ${JSON.stringify(body)}`, async () => {
      assert.deepEqual((await check(actions(agentPull(body)))).err, [`✗ ${problem}`, 'pr-work-rules: refused by the work rules']);
    });
  }

  describe("onboard's pull request", () => {
    const onboardPull = (repo = SLUG, ref = 'niyam/onboard'): Node => ({ number: 42, body: 'onboard', user: { login: AGENT }, head: { ref, repo: { full_name: repo } } });
    const files = (sys: FakeSys, list: Node[]): void => {
      sys.route('GET', `/repos/${SLUG}/pulls/42/files?per_page=100&page=1`, { status: 200, json: list });
    };

    it('passes one changing only the files onboard writes, naming no slice', async () => {
      const sys = actions(onboardPull('Example-Org/Example-App'));
      files(sys, [
        { filename: '.github/niyam.json', status: 'modified' },
        { filename: '.claude/settings.json', status: 'added' },
        { filename: '.github/workflows/niyam.yml' },
        // The shared Guard's caller (#470).
        { filename: '.github/workflows/niyam-guard.yml', status: 'added' },
        { filename: '.github/niyam/cloud-setup.sh', status: 'added' },
      ]);
      assert.deepEqual(await check(sys), { code: 0, out: ["✓ pr-work-rules: #42 is onboard's, changing only the files onboard writes, so it names no slice"], err: [] });
      assert.equal(sys.requests[0]?.token, 'ghs_run');
    });

    it("passes one that also changes sarathi's hook list, where onboard writes niyam's handlers (P-66)", async () => {
      const sys = actions(onboardPull());
      files(sys, [{ filename: '.claude/settings.json', status: 'modified' }, { filename: '.claude/sarathi.json', status: 'modified' }]);
      assert.deepEqual((await check(sys)).out, ["✓ pr-work-rules: #42 is onboard's, changing only the files onboard writes, so it names no slice"]);
      const removed = actions(onboardPull());
      files(removed, [{ filename: '.claude/sarathi.json', status: 'removed' }]);
      assert.equal((await check(removed)).code, 1, 'deleting it is not onboard\'s');
    });

    for (const [name, list] of [
      ['changes another file', [{ filename: '.github/niyam.json' }, { filename: 'src/app.ts' }]],
      // onboard leaves CODEOWNERS to the client, so a change to it is the work rules' to judge.
      ...(['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'] as const).map((filename) => [`changes ${filename}`, [{ filename: '.github/niyam.json' }, { filename }]] as const),
      ['moves another file into one onboard writes', [{ filename: '.claude/settings.json', previous_filename: 'src/settings.json' }]],
      ['deletes one onboard writes', [{ filename: '.github/workflows/niyam.yml', status: 'removed' }]],
      // Since P-57 onboard deletes one file, the cloud setup file before P-56, only into its new name.
      ['deletes the cloud setup file before P-56, writing no new one', [{ filename: '.github/process-rules/cloud-setup.sh', status: 'removed' }, { filename: '.github/niyam.json' }]],
      ['deletes the new cloud setup file', [{ filename: '.github/niyam/cloud-setup.sh', status: 'removed' }, { filename: '.github/process-rules/cloud-setup.sh' }]],
      ['deletes the workflow before P-56, which no release moves since P-57', [{ filename: '.github/workflows/process-rules.yml', status: 'removed' }, { filename: '.github/workflows/niyam.yml' }]],
      ['deletes the settings file before niyam, which no release moves since P-57', [{ filename: '.github/process-rules.json', status: 'removed' }, { filename: '.github/niyam.json' }]],
      ['changes the workflow before P-56', [{ filename: '.github/workflows/process-rules.yml' }]],
      ['moves the hooks into the settings file', [{ filename: '.github/niyam.json', previous_filename: '.claude/settings.json', status: 'renamed' }]],
      ['moves the workflow before P-56 into the new one', [{ filename: '.github/workflows/niyam.yml', previous_filename: '.github/workflows/process-rules.yml', status: 'renamed' }]],
      ['copies a file of its own into one onboard writes', [{ filename: '.github/niyam.json', previous_filename: 'src/settings.json', status: 'copied' }]],
      ['deletes one onboard writes beside the new cloud setup file', [{ filename: '.github/workflows/niyam.yml', status: 'removed' }, { filename: '.github/niyam/cloud-setup.sh', status: 'modified' }]],
    ] as const) {
      it(`holds one that ${name} to the work rules`, async () => {
        const sys = actions(onboardPull());
        files(sys, [...list]);
        assert.deepEqual((await check(sys)).err[0], '✗ #42 names no slice; add a line "Slice: #N" to its description');
      });
    }

    for (const [name, list] of [
      ['deletes the cloud setup file before P-56, writing the new one', [
        { filename: '.github/niyam/cloud-setup.sh', status: 'modified' },
        { filename: '.github/process-rules/cloud-setup.sh', status: 'removed' },
      ]],
      ['moves it, as GitHub shows a file renamed', [{ filename: '.github/niyam/cloud-setup.sh', previous_filename: '.github/process-rules/cloud-setup.sh', status: 'renamed' }]],
      ['copies the new one under the name before P-56, as GitHub may show it written under both', [{ filename: '.github/process-rules/cloud-setup.sh', previous_filename: '.github/niyam/cloud-setup.sh', status: 'copied' }]],
      ['lists a file as coming from itself', [{ filename: '.github/niyam.json', previous_filename: '.github/niyam.json', status: 'modified' }]],
    ] as const) {
      it(`passes one that ${name} (P-57)`, async () => {
        const sys = actions(onboardPull());
        files(sys, [...list]);
        assert.deepEqual((await check(sys)).out, ["✓ pr-work-rules: #42 is onboard's, changing only the files onboard writes, so it names no slice"]);
      });
    }

    it('passes one deleting the cloud setup file before P-56 beside a new one the base branch has already', async () => {
      const sys = actions(onboardPull());
      sys.files.set(`${sys.cwd}/.github/niyam/cloud-setup.sh`, '#!/bin/bash\n');
      files(sys, [{ filename: '.github/process-rules/cloud-setup.sh', status: 'removed' }]);
      assert.equal((await check(sys)).code, 0);
    });

    it('holds one from the onboard branch before P-56 to the work rules (P-57)', async () => {
      const sys = actions(onboardPull(SLUG, 'process-rules/onboard'));
      files(sys, [{ filename: '.github/niyam.json', status: 'modified' }]);
      assert.deepEqual((await check(sys)).err[0], '✗ #42 names no slice; add a line "Slice: #N" to its description');
    });

    it("holds a fork's branch of that name to the work rules, without reading its files", async () => {
      const sys = actions(onboardPull('someone/example-app'));
      assert.deepEqual((await check(sys)).err[0], '✗ #42 names no slice; add a line "Slice: #N" to its description');
      assert.ok(!sys.requests.some((r) => r.url.includes('/files')));
      const gone = actions({ ...onboardPull(), head: { ref: 'niyam/onboard', repo: null } });
      assert.deepEqual((await check(gone)).err[0], '✗ #42 names no slice; add a line "Slice: #N" to its description', 'a branch whose repository is gone');
    });
  });

  describe('a pull request from a dependabot/ branch', () => {
    const branch = 'dependabot/npm_and_yarn/x-1.2.3';
    const refused = (number: number, ref: string): string[] => [
      `✗ #${number} is from the branch ${ref}, but only dependabot[bot] opens pull requests from dependabot/ branches, which a review may skip as Dependabot's; push it to a branch of another name`,
      'pr-work-rules: refused by the work rules',
    ];

    const REPO = `/repos/${SLUG}`;
    const ZERO = '0'.repeat(40);
    /** Dependabot's pull request #43 carrying `commits`, with the pushes GitHub recorded to its branch, oldest first. */
    function dependabots(login: string, commits: string[], pushes: { type: string; actor: string | null; before: string; after: string; brings: string[] }[]): FakeSys {
      const sys = actions({ number: 43, body: 'Bumps x.', user: { login }, base: { sha: 'base0' }, head: { ref: branch, repo: { full_name: SLUG } } });
      sys.route('GET', `${REPO}/pulls/43/commits?per_page=100&page=1`, { status: 200, json: commits.map((sha) => ({ sha })) });
      sys.route('GET', `${REPO}/activity?ref=${encodeURIComponent(`refs/heads/${branch}`)}&per_page=100`, {
        status: 200,
        json: [...pushes].reverse().map((push) => ({ activity_type: push.type, actor: push.actor ? { login: push.actor } : null, before: push.before, after: push.after })),
      });
      for (const push of pushes) {
        const from = push.type === 'push' && push.before !== ZERO ? push.before : 'base0';
        sys.route('GET', `${REPO}/compare/${from}...${push.after}?per_page=100&page=1`, { status: 200, json: { commits: push.brings.map((sha) => ({ sha })) } });
      }
      return sys;
    }
    const created = { type: 'branch_creation', actor: 'dependabot[bot]', before: ZERO, after: 'd1', brings: ['d1'] };

    it("passes Dependabot's own, whatever the case of its login, rebased or not", async () => {
      for (const login of ['dependabot[bot]', 'Dependabot[bot]']) {
        const rebased = { type: 'force_push', actor: login, before: 'd1', after: 'd2', brings: ['d2'] };
        for (const [commits, pushes] of [[['d1'], [created]], [['d2'], [created, rebased]]] as const) {
          const sys = dependabots(login, [...commits], [...pushes]);
          assert.deepEqual(await check(sys), { code: 0, out: [`pr-work-rules: #43 is by ${login}, not an agent; the work rules bind agent pull requests`], err: [] });
        }
      }
    });

    it('refuses Dependabot\'s carrying a commit someone else pushed, as 505 did', async () => {
      const sys = dependabots('dependabot[bot]', ['d1', 'a1'], [created, { type: 'push', actor: AGENT, before: 'd1', after: 'a1', brings: ['a1'] }]);
      assert.deepEqual(await check(sys), {
        code: 1,
        out: [],
        err: [
          `✗ #43 is dependabot[bot]'s, which no work rule binds and a review may skip, but it carries a1 (pushed by ${AGENT}); open a pull request of your own that carries the bump and the change, and close this one`,
          'pr-work-rules: refused by the work rules',
        ],
      });
    });

    it('reads the record again for a commit it does not yet credit, then fails closed, naming one by a gone account', async () => {
      const sys = dependabots('dependabot[bot]', ['d1', 'g1', 'n1'], [created, { type: 'push', actor: null, before: 'd1', after: 'g1', brings: ['g1'] }]);
      const { code, err } = await check(sys);
      assert.equal(code, 1);
      assert.match(err[0] ?? '', /carries g1 \(pushed by an account GitHub no longer names\), n1 \(no push recorded yet\)/);
      assert.equal(sys.requests.filter((r) => r.url.includes('/activity')).length, 6);
    });

    it('fails closed without a head repository or a base, or with more commits than GitHub lists', async () => {
      for (const pull of [
        { number: 43, body: null, user: { login: 'dependabot[bot]' }, base: { sha: 'base0' }, head: { ref: branch, repo: null } },
        { number: 43, body: null, user: { login: 'dependabot[bot]' }, head: { ref: branch, repo: { full_name: SLUG } } },
      ]) {
        assert.match((await check(actions(pull))).err[0] ?? '', /has no record GitHub can read/);
      }
      const sys = dependabots('dependabot[bot]', [], []);
      const page = Array.from({ length: 100 }, (_, i) => ({ sha: `c${i}` }));
      for (const n of [1, 2, 3]) sys.route('GET', `${REPO}/pulls/43/commits?per_page=100&page=${n}`, { status: 200, json: page });
      assert.match((await check(sys)).err[0] ?? '', /has 250 or more commits/);
      const exactly = dependabots('dependabot[bot]', [], []);
      for (const [n, length] of [[1, 100], [2, 100], [3, 50]] as const) {
        exactly.route('GET', `${REPO}/pulls/43/commits?per_page=100&page=${n}`, { status: 200, json: Array.from({ length }, (_, i) => ({ sha: `c${n}-${i}` })) });
      }
      assert.match((await check(exactly)).err[0] ?? '', /has 250 or more commits/, '250 exactly');
    });

    it('names a stray commit by its short id', async () => {
      const sha = 'f'.repeat(40);
      const sys = dependabots('dependabot[bot]', ['d1', sha], [created, { type: 'push', actor: AGENT, before: 'd1', after: sha, brings: [sha] }]);
      assert.match((await check(sys)).err[0] ?? '', new RegExp(`carries ${'f'.repeat(7)} \\(pushed by ${AGENT}\\);`));
    });

    it("refuses an agent's, though it names a slice that may be built, without reading the slice", async () => {
      const sys = actions({ number: 40, body: 'Slice: #12', user: { login: AGENT }, head: { ref: branch } });
      github(sys, graph().issue, [{ number: 40, body: 'Slice: #12', head: { ref: branch } }]);
      assert.deepEqual(await check(sys), { code: 1, out: [], err: refused(40, branch) });
      assert.ok(!sys.requests.some((r) => r.url.includes('/issues/12')));
    });

    it("refuses an owner's, and a fork's of any author", async () => {
      for (const [number, login, repo] of [[41, OWNER, SLUG], [44, 'someone', 'someone/example-app']] as const) {
        const sys = actions({ number, body: null, user: { login }, head: { ref: 'dependabot/x', repo: { full_name: repo } } });
        assert.deepEqual(await check(sys), { code: 1, out: [], err: refused(number, 'dependabot/x') });
      }
    });

    it('holds only the prefix: a branch merely naming Dependabot passes as before', async () => {
      const sys = actions({ number: 41, body: null, user: { login: OWNER }, head: { ref: 'fix-dependabot/x' } });
      assert.equal((await check(sys)).code, 0);
    });
  });

  it('checks nothing in a repository not adopted on its base, with work-rules off, or owned by a personal account', async () => {
    const unadopted = actions(agentPull('Slice: #12'));
    unadopted.files.delete(`${ROOT}/.github/niyam.json`);
    const off = actions(agentPull('Slice: #12'));
    off.files.set(`${ROOT}/.github/niyam.json`, JSON.stringify({ owner: OWNER, agent: AGENT, features: ['identity'] }));
    const personal = actions(agentPull('Slice: #12'));
    personal.route('GET', `/repos/${SLUG}`, { status: 200, json: { owner: { type: 'User' } } });
    for (const [sys, said] of [
      [unadopted, 'pr-work-rules: the base branch has no .github/niyam.json, so the repo is not adopted on its base yet; nothing to check'],
      [off, 'pr-work-rules: work-rules is off in .github/niyam.json; nothing to check'],
      [personal, 'pr-work-rules: work-rules is off on a repository owned by a personal account, since GitHub has issue types for organisations only; nothing to check'],
    ] as const) {
      assert.deepEqual(await check(sys), { code: 0, out: [said], err: [] });
      assert.ok(!sys.requests.some((r) => r.url.includes('/issues/')), said);
    }
  });

  it('needs each of the Actions variables', async () => {
    for (const name of ['GITHUB_EVENT_PATH', 'GITHUB_REPOSITORY', 'GH_TOKEN']) {
      const sys = actions(agentPull('Slice: #12'));
      delete sys.env[name];
      await assert.rejects(check(sys), /pr-work-rules runs in GitHub Actions/, name);
    }
  });

  it('refuses a State line naming an issue the slice does not hold, or a sub-issue of no type, though the slice has a State', async () => {
    const g = graph();
    g.states.push(
      { number: 31, title: 'The thing', type: { name: 'State' }, state: 'open', state_reason: null, closed_at: null, comments: [] },
      { number: 34, title: 'Untyped', type: null, state: 'open', state_reason: null, closed_at: null, comments: [] },
    );
    const sys = actions(agentPull('Slice: #12\nState: #99\nState: #34'));
    github(sys, g.issue);
    assert.deepEqual((await check(sys)).err, [
      '✗ #99 is not a State under slice #12; a "State: #N" line names a State sub-issue of the slice the pull request builds',
      '✗ #34 is not a State under slice #12; a "State: #N" line names a State sub-issue of the slice the pull request builds',
      'pr-work-rules: refused by the work rules',
    ]);
  });

  it('takes no open sub-issue but a State as the State a fix names', async () => {
    const g = fixed();
    g.states.push(
      { number: 33, title: 'A note', type: { name: 'Task' }, state: 'open', state_reason: null, closed_at: null, comments: [] },
      { number: 34, title: 'Untyped', type: null, state: 'open', state_reason: null, closed_at: null, comments: [] },
    );
    const sys = actions(agentPull('Slice: #12\nState: #33\nState: #34'));
    github(sys, g.issue);
    assert.deepEqual((await check(sys)).err, [
      '✗ #33 is not a State under slice #12; a "State: #N" line names a State sub-issue of the slice the pull request builds',
      '✗ #34 is not a State under slice #12; a "State: #N" line names a State sub-issue of the slice the pull request builds',
      '✗ #12 is closed, so this pull request is a fix: file it as a State under #12 with niyam state 12 --title "…" and name it with a line "State: #N"',
      'pr-work-rules: refused by the work rules',
    ]);
  });

  it("leaves the owner's pull requests alone", async () => {
    const sys = actions({ number: 41, body: null, user: { login: OWNER }, head: { ref: 'x' } });
    assert.deepEqual(await check(sys), { code: 0, out: ['pr-work-rules: #41 is by example-owner, not an agent; the work rules bind agent pull requests'], err: [] });
  });

  it('skips events that are not pull requests', async () => {
    assert.deepEqual((await check(actions(undefined))).out, ['pr-work-rules: not a pull request; nothing to check']);
  });

  it('needs the Actions environment', async () => {
    await assert.rejects(check(new FakeSys()), /pr-work-rules runs in GitHub Actions/);
  });

  it('reads the settings from the checkout', async () => {
    const sys = actions(agentPull('Slice: #12'));
    github(sys, graph().issue);
    await check(sys);
    assert.equal(sys.cwd, ROOT);
  });
});

describe('sessionToken', () => {
  it("is the session's own token, or in a Claude cloud session the proxy's, and never a lock's placeholder", () => {
    const sys = new FakeSys();
    for (const [env, token] of [
      [{ GH_TOKEN: 'ghp_good' }, 'ghp_good'],
      [{ GH_TOKEN: 'niyam-no-agent-token' }, undefined],
      [{}, undefined],
      [{ CLAUDE_CODE_REMOTE: 'false' }, undefined],
      [{ CLAUDE_CODE_REMOTE: 'true' }, PROXY_TOKEN],
      [{ CLAUDE_CODE_REMOTE: 'true', GH_TOKEN: 'niyam-no-agent-token' }, PROXY_TOKEN],
    ] as const) {
      sys.env = { ...env };
      assert.equal(sessionToken(sys), token, JSON.stringify(env));
    }
  });
});

describe('prePush', () => {
  const LOCAL = 'a'.repeat(40);
  const REMOTE = 'b'.repeat(40);
  const ZERO = '0'.repeat(40);
  function session(log: string): FakeSys {
    const sys = new FakeSys();
    sys.env = { NIYAM_AGENT: AGENT, GH_TOKEN: 'ghp_good' };
    sys.execOverride = (call) => (call.args[0] === 'log' ? { code: 0, stdout: log, stderr: '' } : undefined);
    github(sys, graph().issue);
    sys.acceptToken('ghp_good', AGENT);
    return sys;
  }
  async function push(sys: FakeSys, lines: string): Promise<{ code: number; err: string[] }> {
    const { io, err } = capture();
    return { code: await prePush(sys, io, lines, 'https://github.com/example-org/example-app.git', 'origin'), err };
  }

  it('lets an agent push commits naming a slice that may be built', async () => {
    const sys = session('Add the thing\n\nSlice: #12\n');
    assert.deepEqual(await push(sys, `refs/heads/work ${LOCAL} refs/heads/work ${REMOTE}\n`), { code: 0, err: [] });
    assert.deepEqual(sys.calls.find((c) => c.args[0] === 'log')?.args, ['log', '--format=%B', LOCAL, '--not', REMOTE, '--remotes']);
    assert.equal(sys.requests[0]?.token, 'ghp_good');
  });

  it('reads only a commit id of zeros alone as none, not one that starts or ends with zeros', async () => {
    for (const [local, remote] of [[`0${'a'.repeat(39)}`, `${'b'.repeat(39)}0`], [`${'a'.repeat(39)}0`, `0${'b'.repeat(39)}`]]) {
      const sys = session('Add the thing\n\nSlice: #12\n');
      assert.deepEqual(await push(sys, `refs/heads/work ${local} refs/heads/work ${remote}\n`), { code: 0, err: [] });
      assert.deepEqual(sys.calls.find((c) => c.args[0] === 'log')?.args, ['log', '--format=%B', local, '--not', remote, '--remotes']);
    }
  });

  describe('a push to a branch whose pull request merged', () => {
    const HEADS = `/repos/${SLUG}/pulls?head=example-org%3Awork&state=all&per_page=20`;
    const pull = (number: number, state: 'open' | 'closed', merged = false): Node => ({
      number,
      html_url: `https://github.com/${SLUG}/pull/${number}`,
      state,
      merged_at: merged ? LATER : null,
      head: { ref: 'work' },
    });
    const listed = (sys: FakeSys): number => sys.requests.filter((request) => request.url.endsWith(HEADS)).length;

    it('is refused, before the work rules, as refuse-retired refuses it', async () => {
      const sys = session('Add the thing\n\nSlice: #12\n');
      sys.route('GET', HEADS, { status: 200, json: [pull(5, 'closed', true)] });
      assert.deepEqual(await push(sys, `refs/heads/work ${LOCAL} refs/heads/work ${REMOTE}\n`), {
        code: 1,
        err: [
          '❌ Error: work already has MERGED PR #5 and no open PR. Pushing it',
          '   recreates a branch the merge retired, and the commits after the merge land in no PR.',
          '   Move the commits missing from the PR head to a fresh branch, then push that.',
          'pre-push: refused; a merged pull request retired this branch',
        ],
      });
      assert.equal(listed(sys), 1);
      assert.equal(sys.requests.find((request) => request.url.endsWith(HEADS))?.token, 'ghp_good');
      assert.equal(sys.calls.some((call) => call.args[0] === 'log'), false, 'the work rules were not read');
    });

    it("names the client's way out where its settings set one", async () => {
      const sys = session('Slice: #12');
      sys.files.set(`${ROOT}/.github/niyam.json`, JSON.stringify({ owner: OWNER, agent: AGENT, prAutocreate: { retire: 'scripts/retire-branch.sh {number}' } }));
      sys.route('GET', HEADS, { status: 200, json: [pull(5, 'closed', true)] });
      const refused = await push(sys, `refs/heads/work ${LOCAL} refs/heads/work ${REMOTE}\n`);
      assert.equal(refused.code, 1);
      assert.deepEqual(refused.err.slice(2), ['   Retire it: move the commits missing from the PR head to a fresh branch, then push that:', '     scripts/retire-branch.sh 5', 'pre-push: refused; a merged pull request retired this branch']);
    });

    it('goes ahead when the branch has an open pull request too, or only closed ones', async () => {
      for (const pulls of [[pull(6, 'open'), pull(5, 'closed', true)], [pull(5, 'closed')]]) {
        const sys = session('Slice: #12');
        sys.route('GET', HEADS, { status: 200, json: pulls });
        assert.deepEqual(await push(sys, `refs/heads/work ${LOCAL} refs/heads/work ${REMOTE}\n`), { code: 0, err: [] });
        assert.equal(listed(sys), 1);
      }
    });

    it('warns in one line and goes ahead when GitHub cannot be asked', async () => {
      const sys = session('Slice: #12');
      sys.route('GET', HEADS, { status: 502, json: { message: 'Bad Gateway' } });
      assert.deepEqual(await push(sys, `refs/heads/work ${LOCAL} refs/heads/work ${REMOTE}\n`), {
        code: 0,
        err: ["⚠️  Could not ask GitHub whether work's PR already merged (GitHub answered 502 listing pull requests); not checked."],
      });
      sys.route('GET', HEADS, () => {
        throw new Error('socket hang up');
      });
      assert.deepEqual(await push(sys, `refs/heads/work ${LOCAL} refs/heads/work ${REMOTE}\n`), {
        code: 0,
        err: ["⚠️  Could not ask GitHub whether work's PR already merged (socket hang up); not checked."],
      });
      // A crash in the check is no live branch either: it says so, and the work rules go on.
      const env = sys.env;
      sys.env = new Proxy(env, {
        get: (target, name) => {
          if (name === 'CI') throw new Error('the environment is gone');
          return target[name as string];
        },
      });
      assert.deepEqual(await push(sys, `refs/heads/work ${LOCAL} refs/heads/work ${REMOTE}\n`), {
        code: 0,
        err: ["⚠️  Could not check whether a pushed branch's PR already merged (the environment is gone); not checked."],
      });
    });

    it('asks nothing for a push to another remote, a deletion or the base branch', async () => {
      const sys = session('Slice: #12');
      sys.route('GET', HEADS, { status: 200, json: [pull(5, 'closed', true)] });
      const { io, err } = capture();
      assert.equal(await prePush(sys, io, `refs/heads/work ${LOCAL} refs/heads/work ${REMOTE}\n`, 'https://github.com/example-org/example-app.git', 'upstream'), 0);
      assert.deepEqual(err, []);
      assert.deepEqual(await push(sys, `(delete) ${ZERO} refs/heads/work ${REMOTE}\nrefs/heads/main ${LOCAL} refs/heads/main ${REMOTE}\n`), { code: 0, err: [] });
      assert.deepEqual(sys.requests.filter((request) => request.url.includes('/pulls?head=')), [], 'no branch was listed');
    });
  });

  describe('a push for a slice closed already', () => {
    /** Slice #12 closed, with State #30 delivered and State #31 open under it. */
    function closed(pulls: Node[] = []): FakeSys {
      const sys = session('Fix the thing on narrow pages\n\nSlice: #12\n');
      const g = graph();
      g.issue.state = 'closed';
      g.issue.closed_at = LATER;
      g.states.push(
        { number: 30, title: 'The thing', type: { name: 'State' }, state: 'closed', state_reason: 'completed', closed_at: LATER, comments: [] },
        { number: 31, title: 'Fix: the thing on narrow pages', type: { name: 'State' }, state: 'open', state_reason: null, closed_at: null, comments: [] },
      );
      github(sys, g.issue, pulls);
      return sys;
    }
    const own = (body: string, ref = 'work', repo = SLUG): Node => ({ number: 40, body, head: { ref, repo: { full_name: repo } } });
    const WARNING = '⚠️  #12 is closed, so its next pull request is a fix and needs a State: niyam state 12 --title "…"';

    it('warns that its pull request needs a State, with the command that files one, and goes ahead', async () => {
      assert.deepEqual(await push(closed(), `refs/heads/work ${LOCAL} refs/heads/work ${REMOTE}\n`), { code: 0, err: [WARNING] });
    });

    it("warns while the branch's own pull request names no open State under the slice", async () => {
      for (const body of ['Slice: #12', 'Slice: #12\nState: #30', 'Slice: #12\nState: #99']) {
        assert.deepEqual(await push(closed([own(body)]), `refs/heads/work ${LOCAL} refs/heads/work ${REMOTE}\n`), { code: 0, err: [WARNING] }, body);
      }
      // A fork's branch of the same name is not this push's pull request, but another one for the slice.
      const forked = await push(closed([own('Slice: #12\nState: #31', 'work', 'someone/example-app')]), `refs/heads/work ${LOCAL} refs/heads/work ${REMOTE}\n`);
      assert.equal(forked.code, 1);
      assert.deepEqual(forked.err.slice(0, 1), [WARNING]);
    });

    it("says nothing once the branch's pull request names an open State under it", async () => {
      assert.deepEqual(await push(closed([own('Slice: #12\nState: #31')]), `refs/heads/work ${LOCAL} refs/heads/work ${REMOTE}\n`), { code: 0, err: [] });
    });

    it('says nothing for an open slice', async () => {
      assert.deepEqual(await push(session('Slice: #12'), `refs/heads/work ${LOCAL} refs/heads/work ${REMOTE}\n`), { code: 0, err: [] });
    });

    it('warns before what refuses the push', async () => {
      const sys = closed([{ number: 41, body: 'Slice: #12', head: { ref: 'other', repo: { full_name: SLUG } } }]);
      const refused = await push(sys, `refs/heads/work ${LOCAL} refs/heads/work ${REMOTE}\n`);
      assert.equal(refused.code, 1);
      assert.deepEqual(refused.err.slice(0, 1), [WARNING]);
      assert.match(refused.err[1] ?? '', /^✗ #12 already has pull request #41/);
    });
  });

  it('runs the hand-off gate where the repository names its plumbing, before the work rules', async () => {
    const sys = session('Slice: #12');
    sys.files.set(`${ROOT}/.github/niyam.json`, JSON.stringify({ owner: 'example-owner', agent: AGENT, handoff: { plumbing: ['.github/workflows/'] } }));
    const answers: Record<string, string> = { 'rev-parse --abbrev-ref HEAD': 'work', 'rev-parse HEAD': LOCAL, 'rev-parse --symbolic-full-name origin/main': 'refs/remotes/origin/main', 'merge-base origin/main HEAD': REMOTE, 'diff --name-only origin/main...HEAD': '.github/workflows/ci.yml' };
    sys.execOverride = (call) => {
      const answer = answers[call.args.join(' ')];
      return answer !== undefined ? { code: 0, stdout: `${answer}\n`, stderr: '' } : call.args[0] === 'log' ? { code: 0, stdout: 'Slice: #12', stderr: '' } : undefined;
    };
    const refused = await push(sys, `refs/heads/work ${LOCAL} refs/heads/work ${REMOTE}\n`);
    assert.equal(refused.code, 1);
    assert.match(refused.err[0] ?? '', /^✗ handoff: this branch changes 1 shared-plumbing file\(s\) \(\.github\/workflows\/ci.yml\)/);
    assert.equal(sys.calls.some((call) => call.args[0] === 'log'), false, 'the work rules were not read');
    answers['diff --name-only origin/main...HEAD'] = 'src/a.ts';
    assert.deepEqual(await push(sys, `refs/heads/work ${LOCAL} refs/heads/work ${REMOTE}\n`), { code: 0, err: [] });
  });

  it('reads only commits no remote has for a new branch', async () => {
    const sys = session('Slice: #12');
    await push(sys, `refs/heads/work ${LOCAL} refs/heads/work ${ZERO}\n`);
    assert.deepEqual(sys.calls.find((c) => c.args[0] === 'log')?.args, ['log', '--format=%B', LOCAL, '--not', '--remotes']);
  });

  it('refuses commits naming no slice, or two', async () => {
    assert.deepEqual(await push(session('Tidy up'), `refs/heads/work ${LOCAL} refs/heads/work ${REMOTE}`), {
      code: 1,
      err: ['✗ the commits for work name no slice; add a trailer "Slice: #N" to a commit message', 'pre-push: refused by the work rules'],
    });
    assert.equal((await push(session('Slice: #12\nSlice: #13'), `refs/heads/work ${LOCAL} refs/heads/work ${REMOTE}`)).err[0], '✗ the commits for work name 2 slices (#12, #13); one push builds one slice');
  });

  describe("a trailer naming another repository's slice", () => {
    function planned(log: string): FakeSys {
      const sys = session(log);
      // This repository has no #12: the slice is planned in PLANS.
      github(sys, null);
      github(sys, graph().issue, [], PLANS);
      // The board holds that repository's #12 In Progress already, so the push moves nothing.
      sys.route('GET', `/repos/${PLANS}`, { status: 200, json: { owner: { login: 'example-org', type: sys.ownerType } } });
      sys.route('GET', `/repos/${PLANS}/issues?state=open&type=Work%20item&sort=created&direction=desc&per_page=100`, { status: 200, json: [] });
      sys.route('GET', '/orgs/example-org/projectsV2/3/items?per_page=100&fields=2', {
        status: 200,
        json: [{ id: 100, content_type: 'Issue', content: { number: 12, repository_url: `https://api.github.com/repos/${PLANS}`, state: 'open' }, fields: [{ id: 2, value: { name: 'In Progress' } }] }],
      });
      return sys;
    }

    for (const trailer of [`Slice: https://github.com/${PLANS}/issues/12`, `Slice: ${PLANS}#12`]) {
      it(`lets an agent push commits naming it as "${trailer}"`, async () => {
        const sys = planned(`Add the thing\n\n${trailer}\n`);
        assert.deepEqual(await push(sys, `refs/heads/work ${LOCAL} refs/heads/work ${REMOTE}\n`), { code: 0, err: [] });
        assert.ok(sys.requests.some((request) => request.url === `https://api.github.com/repos/${PLANS}/issues/12`));
      });
    }

    it('refuses one the agent cannot read there', async () => {
      const sys = planned(`Slice: ${PLANS}#12`);
      sys.route('GET', `/repos/${PLANS}/issues/12`, { status: 404, json: { message: 'Not Found' } });
      assert.deepEqual(await push(sys, `refs/heads/work ${LOCAL} refs/heads/work ${REMOTE}\n`), {
        code: 1,
        err: [
          `✗ ${PLANS}#12 cannot be read with this token (HTTP 404: Not Found): a slice in another repository counts only where the token reads that repository, and a workflow's GITHUB_TOKEN reads no private repository but ${SLUG}`,
          'pre-push: refused by the work rules',
        ],
      });
    });

    it('counts it and this repository\'s #12 as two slices', async () => {
      const sys = planned(`Slice: #12\nSlice: ${PLANS}#12`);
      assert.equal((await push(sys, `refs/heads/work ${LOCAL} refs/heads/work ${REMOTE}`)).err[0], `✗ the commits for work name 2 slices (#12, ${PLANS}#12); one push builds one slice`);
    });
  });

  describe('a push of only a merge, such as of the default branch', () => {
    const MAIN = 'c'.repeat(40);
    const MERGE = "Merge branch 'main' into work\n";
    function merged(parents: string, pushed = MERGE): FakeSys {
      const sys = session('');
      sys.execOverride = (call) => {
        if (call.args[0] !== 'log') return undefined;
        if (call.args.includes('--format=%P')) return { code: 0, stdout: parents, stderr: '' };
        const stdout = call.args.includes('--no-merges') ? 'Add the thing\n\nSlice: #12\n' : pushed;
        return { code: 0, stdout, stderr: '' };
      };
      return sys;
    }

    it("is judged by the branch's own commits", async () => {
      const sys = merged(`${REMOTE} ${MAIN}\n`);
      assert.deepEqual(await push(sys, `refs/heads/work ${LOCAL} refs/heads/work ${REMOTE}`), { code: 0, err: [] });
      assert.deepEqual(sys.calls.filter((c) => c.args[0] === 'log').at(-1)?.args, ['log', '--no-merges', '--format=%B', LOCAL, '--not', MAIN]);
    });

    it('is refused beside a commit of its own naming no slice', async () => {
      const sys = merged(`${REMOTE} ${MAIN}\n${REMOTE}\n`, `${MERGE}\nTidy up\n`);
      assert.equal((await push(sys, `refs/heads/work ${LOCAL} refs/heads/work ${REMOTE}`)).err[0], '✗ the commits for work name no slice; add a trailer "Slice: #N" to a commit message');
    });

    it('passes beside a commit of its own naming the slice, without reading past the merges', async () => {
      const sys = merged(`${REMOTE} ${MAIN}\n${REMOTE}\n`, `${MERGE}\nAdd more\n\nSlice: #12\n`);
      assert.deepEqual(await push(sys, `refs/heads/work ${LOCAL} refs/heads/work ${REMOTE}`), { code: 0, err: [] });
      assert.ok(!sys.calls.some((c) => c.args.includes('--no-merges')));
    });
  });

  it('refuses a slice that may not be built', async () => {
    const sys = session('Slice: #12');
    const g = graph();
    g.timeline.splice(1, 1);
    github(sys, g.issue);
    assert.equal((await push(sys, `refs/heads/work ${LOCAL} refs/heads/work ${REMOTE}`)).code, 1);
  });

  it('passes deletes, pushes with nothing new, and pushes outside agent sessions', async () => {
    assert.equal((await push(session('Slice: #12'), `(delete) ${ZERO} refs/heads/work ${REMOTE}\n\n`)).code, 0);
    assert.equal((await push(session(''), `refs/heads/work ${LOCAL} refs/heads/work ${REMOTE}`)).code, 0);
    const owner = session('Tidy up');
    owner.env = {};
    assert.equal((await push(owner, `refs/heads/work ${LOCAL} refs/heads/work ${REMOTE}`)).code, 0);
  });

  it('refuses an agent session with no token, at the identity guard', async () => {
    // The lock's placeholder is no token.
    for (const token of [undefined, 'niyam-no-agent-token']) {
      for (const name of ['NIYAM_AGENT']) {
        const sys = session('Slice: #12');
        sys.env = { [name]: AGENT, ...(token ? { GH_TOKEN: token } : {}) };
        const { code, err } = await push(sys, `refs/heads/work ${LOCAL} refs/heads/work ${REMOTE}`);
        assert.deepEqual({ code, last: err.at(-1) }, { code: 1, last: `pre-push: refused; an agent session pushes to GitHub only as ${AGENT}` }, `${name} ${token}`);
      }
    }
  });

  it('refuses work rules it cannot read when git pushes as the agent without GH_TOKEN', async () => {
    const sys = session('Slice: #12');
    sys.env = { NIYAM_AGENT: AGENT };
    const log = sys.execOverride;
    sys.execOverride = (call) =>
      call.args.join(' ') === 'credential fill' ? { code: 0, stdout: 'password=ghp_good\n', stderr: '' } : log(call);
    assert.deepEqual(await push(sys, `refs/heads/work ${LOCAL} refs/heads/work ${REMOTE}`), {
      code: 1,
      err: [
        // The retired-branch check fails open; the work rules do not.
        "⚠️  Could not ask GitHub whether work's PR already merged (this agent session has no token; run niyam doctor); not checked.",
        '✗ this agent session has no token, so the work rules cannot be checked; run niyam doctor',
        'pre-push: refused by the work rules',
      ],
    });
    // Never gh's signed-in account, the owner's on this Mac.
    assert.equal(sys.calls.some((call) => call.command === 'gh'), false);
  });

  it('counts the slices across every ref of one push', async () => {
    const sys = session('');
    sys.execOverride = (call) =>
      call.args[0] === 'log' ? { code: 0, stdout: call.args[2]?.endsWith(LOCAL) ? 'Slice: #12\n' : 'Slice: #13\n', stderr: '' } : undefined;
    const lines = `refs/heads/a ${LOCAL} refs/heads/a ${REMOTE}\nrefs/heads/b ${'c'.repeat(40)} refs/heads/b ${REMOTE}\n`;
    assert.equal((await push(sys, lines)).err[0], '✗ the commits for a, b name 2 slices (#12, #13); one push builds one slice');
  });

  it('refuses one slice pushed to two branches at once', async () => {
    const lines = `refs/heads/a ${LOCAL} refs/heads/a ${REMOTE}\nrefs/heads/b ${LOCAL} refs/heads/b ${REMOTE}\n`;
    assert.deepEqual((await push(session('Slice: #12'), lines)).err, ['✗ one push builds one slice on one branch; this one pushes a, b', 'pre-push: refused by the work rules']);
  });

  it('skips a ref line it cannot read, or one that names no remote ref', async () => {
    assert.equal((await push(session('Tidy up'), 'garbage\n')).code, 0);
    assert.deepEqual(await push(session('Tidy up'), `refs/heads/work ${LOCAL}\n`), { code: 0, err: [] });
  });

  it('passes a push whose log holds only blank lines', async () => {
    assert.deepEqual(await push(session('\n \n'), `refs/heads/work ${LOCAL} refs/heads/work ${REMOTE}\n`), { code: 0, err: [] });
  });

  it('names a ref outside refs/heads/ as it is', async () => {
    assert.equal((await push(session('Tidy up'), `refs/tags/v1 ${LOCAL} refs/tags/refs/heads/v1 ${REMOTE}\n`)).err[0], '✗ the commits for refs/tags/refs/heads/v1 name no slice; add a trailer "Slice: #N" to a commit message');
  });

  it('passes with the work rules off, or in a repository a personal account owns, saying so', async () => {
    const off = session('Tidy up');
    off.files.set(`${ROOT}/.github/niyam.json`, JSON.stringify({ owner: OWNER, agent: AGENT, features: ['identity'] }));
    assert.deepEqual(await push(off, `refs/heads/work ${LOCAL} refs/heads/work ${REMOTE}\n`), { code: 0, err: ['pre-push: work-rules is off in .github/niyam.json; nothing to check'] });
    const personal = session('Tidy up');
    personal.ownerType = 'User';
    assert.deepEqual(await push(personal, `refs/heads/work ${LOCAL} refs/heads/work ${REMOTE}\n`), {
      code: 0,
      err: ['pre-push: work-rules is off on a repository owned by a personal account, since GitHub has issue types for organisations only; nothing to check'],
    });
  });

  it('reads the log with git, in the repository', async () => {
    const sys = session('Slice: #12');
    await push(sys, `refs/heads/work ${LOCAL} refs/heads/work ${REMOTE}\n`);
    const log = sys.calls.find((c) => c.args[0] === 'log');
    assert.deepEqual([log?.command, log?.cwd], ['git', ROOT]);
  });

  it('throws when git log fails, saying what git said', async () => {
    const sys = session('');
    sys.execOverride = (call) => (call.args[0] === 'log' ? { code: 128, stdout: '', stderr: 'bad revision\n' } : undefined);
    await assert.rejects(push(sys, `refs/heads/work ${LOCAL} refs/heads/work ${REMOTE}`), { message: 'git log failed: bad revision' });
  });

  describe('with the default branch GitHub names', () => {
    const TIP = 'c'.repeat(40);
    const ORIGIN = 'refs/remotes/origin/main^{commit}';
    const LINE = `refs/heads/work ${LOCAL} refs/heads/work ${REMOTE}\n`;
    /** GitHub's answer for the repository, naming its default branch `branch`. */
    const named = (sys: FakeSys, branch: unknown): void => {
      sys.route('GET', `/repos/${SLUG}`, { status: 200, json: { owner: { type: 'Organization' }, default_branch: branch } });
    };
    /**
     * An agent session pushing commits that name slice #12, where GitHub names
     * the default branch `branch` and answers for its tip, at `path`, with `ref`;
     * `git rev-parse --verify` answers `parsed` for each name, and fails for any other.
     */
    function where(branch: unknown, ref?: { status: number; json: unknown }, parsed: Record<string, { code: number; stdout: string }> = {}, path = 'main'): FakeSys {
      const sys = session('Slice: #12');
      named(sys, branch);
      if (ref) sys.route('GET', `/repos/${SLUG}/git/ref/heads/${path}`, ref);
      const log = sys.execOverride;
      sys.execOverride = (call) => (call.args[0] === 'rev-parse' && call.args[1] === '--verify' ? { stderr: '', ...(parsed[call.args[3] as string] ?? { code: 1, stdout: '' }) } : log(call));
      return sys;
    }
    const verified = (sys: FakeSys): FakeSys['calls'] => sys.calls.filter((c) => c.args[0] === 'rev-parse' && c.args[1] === '--verify');
    const parsedAt = (sys: FakeSys): string[] => verified(sys).map((c) => c.args[3] as string);
    /** The commits the push's log reads past as the default branch's, after the remote and --remotes. */
    const tipsOf = (sys: FakeSys): string[] => (sys.calls.find((c) => c.args[0] === 'log')?.args ?? []).slice(6);

    it("reads past GitHub's tip and origin's ref, each as git names its commit in the repository, asking nothing more of a push that names its slice", async () => {
      const ahead = 'd'.repeat(40);
      const sys = where('main', { status: 200, json: { object: { sha: TIP } } }, { [`${TIP}^{commit}`]: { code: 0, stdout: `${TIP}\n` }, [ORIGIN]: { code: 0, stdout: `${ahead}\n` } });
      assert.deepEqual(await push(sys, LINE), { code: 0, err: [] });
      assert.deepEqual(parsedAt(sys), [`${TIP}^{commit}`, ORIGIN]);
      assert.deepEqual(tipsOf(sys), [TIP, ahead]);
      assert.ok(verified(sys).every((c) => c.command === 'git' && c.cwd === ROOT));
      assert.equal(sys.requests.find((r) => r.url.endsWith('/git/ref/heads/main'))?.token, 'ghp_good');
      assert.ok(!sys.calls.some((c) => c.args.includes('--merges')), 'no merges were read');
    });

    it('takes a SHA-256 tip, on a default branch whose name has a slash', async () => {
      const tip = 'e'.repeat(64);
      const sys = where('release/v1', { status: 200, json: { object: { sha: tip } } }, { [`${tip}^{commit}`]: { code: 0, stdout: `${tip}\n` } }, 'release/v1');
      assert.deepEqual(await push(sys, LINE), { code: 0, err: [] });
      assert.deepEqual(parsedAt(sys), [`${tip}^{commit}`, 'refs/remotes/origin/release/v1^{commit}']);
      assert.deepEqual(tipsOf(sys), [tip]);
    });

    it('reads no tip from an answer that gives no commit id', async () => {
      for (const ref of [
        { status: 404, json: { object: { sha: TIP } } },
        { status: 200, json: null },
        { status: 200, json: {} },
        { status: 200, json: { object: { sha: 5 } } },
        // Not text, though it reads as a commit id once made one.
        { status: 200, json: { object: { sha: [TIP] } } },
        { status: 200, json: { object: { sha: `x${TIP}` } } },
        { status: 200, json: { object: { sha: `${TIP}0` } } },
      ]) {
        const sys = where('main', ref);
        assert.deepEqual(await push(sys, LINE), { code: 0, err: [] }, JSON.stringify(ref));
        assert.deepEqual(parsedAt(sys), [ORIGIN], JSON.stringify(ref));
      }
    });

    it('counts only what git names as a commit, and each once', async () => {
      const failed = where('main', { status: 200, json: { object: { sha: TIP } } }, { [`${TIP}^{commit}`]: { code: 1, stdout: `${TIP}\n` }, [ORIGIN]: { code: 0, stdout: 'HEAD\n' } });
      assert.deepEqual(await push(failed, LINE), { code: 0, err: [] });
      assert.deepEqual(tipsOf(failed), []);
      const same = where('main', { status: 200, json: { object: { sha: TIP } } }, { [`${TIP}^{commit}`]: { code: 0, stdout: `${TIP}\n` }, [ORIGIN]: { code: 0, stdout: `${TIP}\n` } });
      await push(same, LINE);
      assert.deepEqual(tipsOf(same), [TIP]);
    });

    it('reads nothing of a default branch GitHub names as no text', async () => {
      for (const branch of ['', 7]) {
        const sys = where(branch);
        assert.deepEqual(await push(sys, LINE), { code: 0, err: [] }, String(branch));
        assert.ok(!sys.requests.some((r) => r.url.includes('/git/ref/')), String(branch));
        assert.deepEqual(parsedAt(sys), [], String(branch));
      }
    });

    describe('and a merge that brought it', () => {
      const MAIN = 'f'.repeat(40);
      /**
       * A push whose merges' parents are `parents`, where GitHub names the
       * default branch `branch` and compares it with MAIN as `compared` says.
       * Read past MAIN, the push's commits name slice #12 alone; read past the
       * clone's tips alone, which are none, they name main's #20 too.
       */
      function merging(compared?: { status: number; json: unknown }, parents = `${REMOTE} ${MAIN}\n`, branch = 'main'): FakeSys {
        const sys = session('');
        named(sys, branch);
        if (compared) sys.route('GET', `/repos/${SLUG}/compare/${branch}...${MAIN}?per_page=1`, compared);
        sys.execOverride = (call) => {
          if (call.args[0] === 'rev-parse' && call.args[1] === '--verify') return { code: 1, stdout: '', stderr: '' };
          if (call.args[0] !== 'log') return undefined;
          if (call.args.includes('--merges')) return { code: 0, stdout: parents, stderr: '' };
          return { code: 0, stdout: call.args.includes(MAIN) ? 'Slice: #12\n' : 'Slice: #12\nSlice: #20\n', stderr: '' };
        };
        return sys;
      }
      const logs = (sys: FakeSys): string[] => sys.calls.filter((c) => c.args[0] === 'log').map((c) => c.args.join(' '));
      const compares = (sys: FakeSys): string[] => sys.requests.filter((r) => r.url.includes('/compare/')).map((r) => r.url.replace(`https://api.github.com/repos/${SLUG}`, ''));
      const RANGE = `${LOCAL} --not ${REMOTE} --remotes`;

      it("reads past the commit it brought that GitHub says is on the default branch, or is its tip", async () => {
        for (const status of ['behind', 'identical']) {
          const sys = merging({ status: 200, json: { status } });
          assert.deepEqual(await push(sys, LINE), { code: 0, err: [] }, status);
          assert.deepEqual(logs(sys), [`log --format=%B ${RANGE}`, `log --merges --format=%P ${RANGE}`, `log --format=%B ${RANGE} ${MAIN}`], status);
          assert.equal(sys.requests.find((r) => r.url.includes('/compare/'))?.token, 'ghp_good', status);
        }
      });

      it('reads no further where GitHub does not say the commit is on it', async () => {
        for (const compared of [{ status: 404, json: { status: 'behind' } }, { status: 200, json: null }, { status: 200, json: { status: 'ahead' } }, undefined]) {
          const sys = merging(compared);
          assert.deepEqual((await push(sys, LINE)).err[0], '✗ the commits for work name 2 slices (#12, #20); one push builds one slice', JSON.stringify(compared));
          assert.deepEqual(logs(sys), [`log --format=%B ${RANGE}`, `log --merges --format=%P ${RANGE}`], JSON.stringify(compared));
        }
      });

      it('asks only of the commit ids the merges brought past their first parent', async () => {
        const sys = merging({ status: 200, json: { status: 'behind' } }, `${REMOTE} ${MAIN} not-a-commit\n\n${REMOTE}\n`);
        assert.deepEqual(await push(sys, LINE), { code: 0, err: [] });
        assert.deepEqual(compares(sys), [`/compare/main...${MAIN}?per_page=1`]);
      });

      it('asks of a default branch whose name has a slash', async () => {
        const sys = merging({ status: 200, json: { status: 'behind' } }, undefined, 'release/v1');
        assert.deepEqual(await push(sys, LINE), { code: 0, err: [] });
        assert.deepEqual(compares(sys), [`/compare/release/v1...${MAIN}?per_page=1`]);
      });
    });
  });

  describe('on a real git history, where the default branch carries other slices', () => {
    const dir = mkdtempSync(join(tmpdir(), 'process-rules-pre-push-'));
    after(() => rmSync(dir, { recursive: true, force: true }));
    const ENV = {
      PATH: process.env.PATH,
      HOME: dir,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'a',
      GIT_AUTHOR_EMAIL: 'a@example.invalid',
      GIT_COMMITTER_NAME: 'a',
      GIT_COMMITTER_EMAIL: 'a@example.invalid',
    };
    let made = 0;
    /** Runs real git in `cwd`, failing the test on an error. */
    const git = (cwd: string, ...args: string[]): string => {
      const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: ENV });
      assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
      return result.stdout.trim();
    };
    const commit = (cwd: string, message: string): string => {
      writeFileSync(join(cwd, `file-${++made}`), message);
      git(cwd, 'add', '.');
      git(cwd, 'commit', '-q', '-m', message);
      return git(cwd, 'rev-parse', 'HEAD');
    };
    /**
     * A remote whose default branch, main, has squash-merged two other
     * slices, and a clone `name` of it with its work branch at main's first
     * commit; `other` is a second clone, from which main moves on.
     */
    function history(name: string): { clone: string; other: string } {
      const remote = join(dir, `${name}.git`);
      git(dir, 'init', '-q', '--bare', '-b', 'main', remote);
      const other = join(dir, `${name}-other`);
      git(dir, 'clone', '-q', remote, other);
      git(other, 'switch', '-q', '-c', 'main');
      commit(other, 'Start');
      git(other, 'push', '-q', 'origin', 'main');
      const clone = join(dir, name);
      git(dir, 'clone', '-q', remote, clone);
      git(clone, 'switch', '-q', '-c', 'work');
      commit(other, 'Build P-20 (#30)\n\nSlice: #20');
      commit(other, 'Build P-21 (#31)\n\nSlice: #21');
      git(other, 'push', '-q', 'origin', 'main');
      return { clone, other };
    }
    /**
     * An agent session in `clone`, whose git log and rev-parse --verify are
     * real; GitHub names main's tip as `tip`, and compares main with each
     * commit `compared` names as its status says.
     */
    function real(clone: string, tip?: string, compared: Record<string, string> = {}): FakeSys {
      const sys = session('');
      sys.execOverride = (call) => {
        if (call.args[0] !== 'log' && call.args.slice(0, 3).join(' ') !== 'rev-parse --verify --quiet') return undefined;
        const result = spawnSync('git', call.args, { cwd: clone, encoding: 'utf8', env: ENV });
        return { code: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
      };
      sys.route('GET', `/repos/${SLUG}`, { status: 200, json: { owner: { type: 'Organization' }, default_branch: 'main' } });
      sys.route('GET', `/repos/${SLUG}/git/ref/heads/main`, tip ? { status: 200, json: { object: { sha: tip } } } : { status: 404, json: { message: 'Not Found' } });
      for (const [commit, status] of Object.entries(compared)) sys.route('GET', `/repos/${SLUG}/compare/main...${commit}?per_page=1`, { status: 200, json: { status } });
      return sys;
    }
    const line = (clone: string, remote = ZERO): string => `refs/heads/work ${git(clone, 'rev-parse', 'HEAD')} refs/heads/work ${remote}\n`;
    /** Fetches main into FETCH_HEAD alone, as a single-branch clone does, and merges it. */
    const mergeFetched = (clone: string): void => {
      git(clone, 'fetch', '-q', 'origin', 'main');
      git(clone, 'update-ref', '-d', 'refs/remotes/origin/main');
      git(clone, 'merge', '-q', '--no-edit', 'FETCH_HEAD');
    };

    it("passes a new branch's first push, naming its slice, beside main's slices", async () => {
      const { clone, other } = history('first');
      git(clone, 'fetch', '-q', 'origin');
      git(clone, 'reset', '-q', '--hard', 'origin/main');
      commit(clone, 'Add the thing\n\nSlice: #12');
      assert.deepEqual(await push(real(clone, git(other, 'rev-parse', 'HEAD')), line(clone)), { code: 0, err: [] });
    });

    it("passes a merge of main whose commits name other slices, though the clone's ref for main is missing", async () => {
      const { clone, other } = history('merge');
      commit(clone, 'Add the thing\n\nSlice: #12');
      git(clone, 'push', '-q', 'origin', 'work');
      const pushed = git(clone, 'rev-parse', 'HEAD');
      mergeFetched(clone);
      const fetched = git(other, 'rev-parse', 'HEAD');
      assert.deepEqual(await push(real(clone, fetched), line(clone, pushed)), { code: 0, err: [] });
      // Main moves on after the fetch: GitHub's tip is not in the clone, so GitHub says what the merge brought.
      commit(other, 'Build P-22 (#32)\n\nSlice: #22');
      git(other, 'push', '-q', 'origin', 'main');
      const tip = git(other, 'rev-parse', 'HEAD');
      const sys = real(clone, tip, { [fetched]: 'behind' });
      assert.deepEqual(await push(sys, line(clone, pushed)), { code: 0, err: [] });
      assert.ok(sys.requests.some((r) => r.url.endsWith(`/compare/main...${fetched}?per_page=1`)));
      // Where GitHub cannot say, or says the merged commit is not on main, main's commits count as the push's own, as before.
      for (const compared of [{}, { [fetched]: 'diverged' }]) {
        assert.equal((await push(real(clone, tip, compared), line(clone, pushed))).err[0], '✗ the commits for work name 2 slices (#21, #20); one push builds one slice');
      }
    });

    it('asks GitHub nothing when the push names its one slice', async () => {
      const { clone } = history('asked');
      commit(clone, 'Add the thing\n\nSlice: #12');
      const sys = real(clone);
      assert.deepEqual(await push(sys, line(clone)), { code: 0, err: [] });
      assert.ok(!sys.requests.some((r) => r.url.includes('/compare/')));
    });

    it('passes a merge tip with no trailer, and a commit with none, on a branch that already names its slice', async () => {
      const { clone, other } = history('tip');
      commit(clone, 'Add the thing\n\nSlice: #12');
      git(clone, 'push', '-q', 'origin', 'work');
      const pushed = git(clone, 'rev-parse', 'HEAD');
      git(clone, 'fetch', '-q', 'origin');
      commit(clone, 'Tidy up');
      git(clone, 'merge', '-q', '--no-edit', 'origin/main');
      // GitHub's tip is newer than the clone has, so the remote-tracking ref alone says where main is.
      commit(other, 'Build P-22 (#32)\n\nSlice: #22');
      git(other, 'push', '-q', 'origin', 'main');
      assert.deepEqual(await push(real(clone, git(other, 'rev-parse', 'HEAD')), line(clone, pushed)), { code: 0, err: [] });
    });

    it("refuses a push naming no slice on a branch whose own commits name two", async () => {
      const { clone, other } = history('two');
      commit(clone, 'Add the thing\n\nSlice: #12');
      commit(clone, 'Add another\n\nSlice: #13');
      git(clone, 'push', '-q', 'origin', 'work');
      const pushed = git(clone, 'rev-parse', 'HEAD');
      mergeFetched(clone);
      commit(clone, 'Tidy up');
      assert.deepEqual(await push(real(clone, git(other, 'rev-parse', 'HEAD')), line(clone, pushed)), {
        code: 1,
        err: ['✗ the commits for work name 2 slices (#13, #12); one push builds one slice', 'pre-push: refused by the work rules'],
      });
    });

    it('refuses a push naming no slice on a branch whose own commits name none', async () => {
      const { clone, other } = history('none');
      commit(clone, 'Tidy up');
      assert.equal((await push(real(clone, git(other, 'rev-parse', 'HEAD')), line(clone))).err[0], '✗ the commits for work name no slice; add a trailer "Slice: #N" to a commit message');
    });
  });

  describe('the work board', () => {
    /** The board's writes, as the option each sets on which item. */
    const moves = (board: RestBoard): string[] =>
      board.writes.map(({ path, body }) => `${path.split('/').at(-1)} ${(body as { fields: { id: number; value: string }[] }).fields.map((field) => `${field.id}:${field.value}`).join(' ')}`);
    const pushing = `refs/heads/work ${LOCAL} refs/heads/work ${REMOTE}`;

    it('moves the slice to In Progress, its work item to Build, and a work item with no Step to Frame, through REST alone', async () => {
      const sys = session('Slice: #12');
      const board = new RestBoard(sys);
      assert.deepEqual(await push(sys, pushing), {
        code: 0,
        err: [
          '✓ board: slice #12 is In Progress in "example-app work"',
          '✓ board: work item #10 is at Step Build in "example-app work"',
          '✓ board: work item #20 had no Step; it is at Frame in "example-app work"',
        ],
      });
      assert.deepEqual(moves(board), ['100 2:2_In-Progress', '101 3:3_Build', '102 3:3_Frame']);
      assert.deepEqual(
        board.projects[0]?.items.map((item) => item.values),
        [{ Status: 'In Progress' }, { Status: 'Todo', Step: 'Build' }, { Step: 'Frame' }, { Step: 'Frame' }],
      );
      // A cloud session's proxy refuses GraphQL, so the push never asks it.
      assert.ok(!sys.requests.some((r) => r.url.endsWith('/graphql')));
      assert.ok(sys.requests.filter((r) => r.url.includes('projectsV2')).every((r) => r.token === 'ghp_good'));
    });

    it('moves nothing already there, closed, or on a Project without the field or option', async () => {
      const sys = session('Slice: #12');
      const board = new RestBoard(sys);
      const project = board.projects[0]!;
      project.items = [{ issue: 12, values: { Status: 'in progress' } }, { issue: 10, values: { Step: 'Build' } }, { issue: 21, values: { Step: 'Frame' } }];
      board.projects.push(
        { number: 5, title: 'other', fields: { Title: null, Status: ['Todo'], Notes: null }, items: [{ issue: 12, values: { Status: 'Todo' } }, { issue: 20, values: {} }] },
        { number: 6, title: 'no board', fields: { Title: null }, items: [{ issue: 12, values: {} }] },
      );
      // The Project whose Status cannot take In Progress is named, not passed over as in place (#473).
      assert.deepEqual(await push(sys, pushing), {
        code: 0,
        err: [`! board: Status in "other" has no option In Progress, so slice #12 stays where it is; add the option to the Project's Status field`],
      });
      assert.deepEqual(moves(board), []);
      // A Project with neither field is not read for its items.
      assert.ok(!sys.requests.some((r) => r.url.includes('/projectsV2/6/items')));
      const closed = session('Slice: #12');
      github(closed, { ...graph().issue, state: 'closed' });
      const untouched = new RestBoard(closed);
      // A closed slice moves nothing; the push says only that its pull request needs a State.
      assert.deepEqual(await push(closed, pushing), { code: 0, err: ['⚠️  #12 is closed, so its next pull request is a fix and needs a State: niyam state 12 --title "…"'] });
      assert.deepEqual(moves(untouched), []);
      assert.ok(!closed.requests.some((r) => r.url.includes('projectsV2')));
    });

    it('says when it cannot read the board, and lets the push go on', async () => {
      const sys = session('Slice: #12');
      const board = new RestBoard(sys);
      board.refuse = (method, path) => (path === '/orgs/example-org/projectsV2' ? { status: 403, json: { message: 'Forbidden' } } : undefined);
      assert.deepEqual(await push(sys, pushing), {
        code: 0,
        err: ["! board: could not read where #12 and its work item are on the board, so nothing moved (GitHub's REST API refused GET /orgs/example-org/projectsV2?per_page=100: HTTP 403 Forbidden); the push goes on"],
      });
    });

    it("says only that the workflow moves the slice when a Claude cloud session's proxy refuses the board", async () => {
      const sys = session('Slice: #12');
      const board = new RestBoard(sys);
      // The proxy's answer for any path outside repos/{owner}/{repo}/… (veda-hq/veda#102).
      const message = 'This GitHub API path is not available: sessions are bound to their configured repositories. Use repository-scoped endpoints (repos/{owner}/{repo}/...).';
      board.refuse = (method, path) => (path === '/orgs/example-org/projectsV2' ? { status: 403, json: { message } } : undefined);
      assert.deepEqual(await push(sys, pushing), {
        code: 0,
        err: ["- board: this cloud session cannot reach the board; niyam's workflow moves #12 when its pull request opens"],
      });
      assert.deepEqual(moves(board), []);
    });

    it('makes the other moves when GitHub refuses one', async () => {
      const sys = session('Slice: #12');
      const board = new RestBoard(sys);
      board.refuse = (method, path) => (method === 'PATCH' && path.endsWith('/items/101') ? { status: 403, json: { message: 'Resource not accessible by integration' } } : undefined);
      assert.deepEqual(await push(sys, pushing), {
        code: 0,
        err: [
          '✓ board: slice #12 is In Progress in "example-app work"',
          '! board: work item #10 was not moved to Build in "example-app work" (GitHub\'s REST API refused PATCH /orgs/example-org/projectsV2/3/items/101: HTTP 403 Resource not accessible by integration)',
          '✓ board: work item #20 had no Step; it is at Frame in "example-app work"',
        ],
      });
    });

    it('moves nothing with the board feature off', async () => {
      const sys = session('Slice: #12');
      sys.files.set(`${ROOT}/.github/niyam.json`, JSON.stringify({ owner: OWNER, agent: AGENT, features: ['identity', 'work-rules'] }));
      const board = new RestBoard(sys);
      assert.deepEqual(await push(sys, pushing), { code: 0, err: [] });
      assert.deepEqual(moves(board), []);
      assert.ok(!sys.requests.some((r) => r.url.includes('projectsV2')));
    });

    it('moves nothing for a push the work rules refuse', async () => {
      const sys = session('Slice: #12');
      const g = graph();
      g.timeline.splice(1, 1);
      github(sys, g.issue);
      const board = new RestBoard(sys);
      assert.equal((await push(sys, pushing)).code, 1);
      assert.deepEqual(moves(board), []);
      assert.ok(!sys.requests.some((r) => r.url.includes('projectsV2')));
    });
  });
});

describe('prMerged', () => {
  const EVENT = '/tmp/event.json';
  const ISSUE = `/repos/${SLUG}/issues/12`;
  function actions(pull: Node | undefined, defaultBranch = 'main'): FakeSys {
    const sys = new FakeSys();
    sys.env = { GITHUB_EVENT_PATH: EVENT, GITHUB_REPOSITORY: SLUG, GH_TOKEN: 'ghs_run' };
    sys.files.set(EVENT, JSON.stringify({ ...(pull ? { pull_request: pull } : {}), repository: { default_branch: defaultBranch } }));
    github(sys, graph().issue);
    sys.route('POST', `${ISSUE}/comments`, { status: 201, json: {} });
    sys.route('PATCH', ISSUE, { status: 200, json: {} });
    return sys;
  }
  const merged = (body: string | null, base = 'main'): Node => ({ number: 40, body, merged: true, base: { ref: base } });
  /** What a run says of slice #12's Work item, #10, whose spec does not say its slices are all filed. */
  const STAYS = '- #10 stays open: its body has no "**Slices:** all filed" line, so it may have slices still to file';
  async function run(sys: FakeSys): Promise<{ code: number; out: string[] }> {
    const { io, out } = capture();
    return { code: await prMerged(sys, io), out };
  }
  const writes = (sys: FakeSys): unknown[] => sys.requests.filter((r) => r.method !== 'GET').map((r) => [r.method, r.url.replace('https://api.github.com', ''), r.body, r.token]);

  it('closes the slice a merged pull request names, with a comment linking it', async () => {
    const sys = actions(merged('Builds the thing.\n\nSlice: #12'));
    assert.deepEqual(await run(sys), { code: 0, out: ['✓ #12: closed, built in #40', STAYS] });
    assert.deepEqual(writes(sys), [
      ['POST', `${ISSUE}/comments`, { body: 'Built in #40, merged into main.' }, 'ghs_run'],
      ['PATCH', ISSUE, { state: 'closed', state_reason: 'completed' }, 'ghs_run'],
    ]);
  });

  it('comments on a slice GitHub closed already, and leaves an issue that is not a slice as it is', async () => {
    const sys = actions(merged('Closes #12\n\nSlice: #12\nSlice: #99'));
    const g = graph();
    g.issue.state = 'closed';
    github(sys, g.issue);
    assert.deepEqual(await run(sys), {
      code: 0,
      out: ['✓ #12 is closed already; commented that it was built in #40', '- #99 is not a Slice in example-org/example-app; left as it is', STAYS],
    });
    assert.deepEqual(writes(sys), [['POST', `${ISSUE}/comments`, { body: 'Built in #40, merged into main.' }, 'ghs_run']]);
  });

  it("leaves a slice and a State in another repository as they are, never this repository's of the same number", async () => {
    const sys = actions(merged(`Slice: https://github.com/${PLANS}/issues/12\nState: ${PLANS}#31`));
    assert.deepEqual(await run(sys), { code: 0, out: [`- ${PLANS}#12 is in another repository; left as it is`, `- ${PLANS}#31 is in another repository; left as it is`] });
    assert.deepEqual(writes(sys), []);
    assert.equal(sys.requests.some((request) => request.url.includes('/issues/12')), false);
  });

  it('comments only once, closed or open, however often it runs', async () => {
    const g = graph();
    g.comments.push(comment('Built in #400, merged into main.', LATEST, 'github-actions[bot]'), comment('Built in #40, merged into main.', LATEST, 'github-actions[bot]'));
    const open = actions(merged('Slice: #12'));
    github(open, g.issue);
    assert.deepEqual(await run(open), { code: 0, out: ['✓ #12: closed, built in #40', STAYS] });
    assert.deepEqual(writes(open), [['PATCH', ISSUE, { state: 'closed', state_reason: 'completed' }, 'ghs_run']]);
    g.issue.state = 'closed';
    const closed = actions(merged('Slice: #12'));
    github(closed, g.issue);
    assert.deepEqual(await run(closed), { code: 0, out: ['✓ #12 is closed already and says it was built in #40', STAYS] });
    assert.deepEqual(writes(closed), []);
  });

  it('comments on a slice whose only comment names another pull request', async () => {
    const g = graph();
    g.issue.state = 'closed';
    g.comments.push(comment('Built in #400, merged into main.', LATEST, 'github-actions[bot]'));
    const sys = actions(merged('Slice: #12'));
    github(sys, g.issue);
    assert.deepEqual((await run(sys)).out, ['✓ #12 is closed already; commented that it was built in #40', STAYS]);
  });

  for (const [name, pull, line] of [
    ['a pull request closed unmerged', { number: 40, body: 'Slice: #12', merged: false, base: { ref: 'main' } }, 'pr-merged: not a merged pull request; nothing to close'],
    ['an event that is not a pull request', undefined, 'pr-merged: not a merged pull request; nothing to close'],
    ['a merge into another branch', merged('Slice: #12', 'stack'), 'pr-merged: #40 merged into stack, not main; its slices stay open until their work reaches main'],
    ['a pull request naming no slice', merged('Tidy up'), 'pr-merged: #40 names no slice; nothing to close'],
  ] as const) {
    it(`closes nothing for ${name}`, async () => {
      const sys = actions(pull as Node | undefined);
      assert.deepEqual(await run(sys), { code: 0, out: [line] });
      assert.deepEqual(writes(sys), []);
    });
  }

  it('closes nothing with the work rules off, or before the repo adopts niyam', async () => {
    const off = actions(merged('Slice: #12'));
    off.files.set(`${ROOT}/.github/niyam.json`, JSON.stringify({ owner: OWNER, agent: AGENT, features: ['identity'] }));
    assert.equal((await run(off)).out[0], 'pr-merged: work-rules is off in .github/niyam.json; nothing to check');
    const before = actions(merged('Slice: #12'));
    before.files.delete(`${ROOT}/.github/niyam.json`);
    assert.match((await run(before)).out[0] ?? '', /^pr-merged: /);
    assert.deepEqual([...writes(off), ...writes(before)], []);
  });


  it('closes nothing in a personal repository', async () => {
    const sys = actions(merged('Slice: #12'));
    sys.ownerType = 'User';
    assert.match((await run(sys)).out[0] ?? '', /^pr-merged: work-rules is off on a repository owned by a personal account/);
    assert.deepEqual(writes(sys), []);
  });

  it('says how to fix a client workflow that grants no issues: write', async () => {
    const sys = actions(merged('Slice: #12'));
    sys.route('POST', `${ISSUE}/comments`, { status: 403, json: { message: 'Resource not accessible by integration' } });
    await assert.rejects(run(sys), /cannot close #12: Resource not accessible by integration; the client workflow needs a job with issues: write/);
    const refused = actions(merged('Slice: #12'));
    refused.route('PATCH', ISSUE, { status: 500, json: null });
    await assert.rejects(run(refused), /^Error: cannot close #12: HTTP 500$/);
    const g = graph();
    g.issue.state = 'closed';
    const closed = actions(merged('Slice: #12'));
    github(closed, g.issue);
    closed.route('POST', `${ISSUE}/comments`, { status: 403, json: { message: 'Resource not accessible by integration' } });
    await assert.rejects(run(closed), /cannot comment on #12: Resource not accessible by integration; the client workflow needs a job with issues: write/);
  });

  it('needs the Actions environment', async () => {
    await assert.rejects(run(new FakeSys()), /pr-merged runs in GitHub Actions/);
  });

  it('needs each of GITHUB_EVENT_PATH, GITHUB_REPOSITORY and GH_TOKEN', async () => {
    for (const name of ['GITHUB_EVENT_PATH', 'GITHUB_REPOSITORY', 'GH_TOKEN']) {
      const sys = actions(merged('Slice: #12'));
      delete sys.env[name];
      await assert.rejects(run(sys), { message: 'pr-merged runs in GitHub Actions: GITHUB_EVENT_PATH, GITHUB_REPOSITORY and GH_TOKEN must be set' }, name);
      assert.deepEqual(writes(sys), [], name);
    }
  });

  it('closes the slice of an event that names no repository', async () => {
    const sys = actions(merged('Slice: #12'));
    sys.files.set(EVENT, JSON.stringify({ pull_request: merged('Slice: #12') }));
    assert.deepEqual(await run(sys), { code: 0, out: ['✓ #12: closed, built in #40', STAYS] });
  });

  it('leaves an issue with no type as it is, named as a slice or as a State', async () => {
    const sys = actions(merged('Slice: #12\nState: #31'));
    sys.route('GET', ISSUE, { status: 200, json: { number: 12, type: null, state: 'open', url: `https://api.github.com${ISSUE}` } });
    sys.route('GET', `/repos/${SLUG}/issues/31`, { status: 200, json: { number: 31, type: null, state: 'open', url: `https://api.github.com/repos/${SLUG}/issues/31` } });
    assert.deepEqual(await run(sys), { code: 0, out: ['- #12 is not a Slice in example-org/example-app; left as it is', '- #31 is not a State in example-org/example-app; left as it is'] });
    assert.deepEqual(writes(sys), []);
  });

  describe('the States it names', () => {
    const STATE = `/repos/${SLUG}/issues/31`;
    /** Slice #12, closed, and State #31 under it as `state` says, its writes routed. */
    function delivering(body: string, state: Node = {}): FakeSys {
      const sys = actions(merged(body));
      const g = graph();
      g.issue.state = 'closed';
      g.states.push({ number: 31, title: 'Fix: the thing on narrow pages', type: { name: 'State' }, state: 'open', state_reason: null, closed_at: null, comments: [], ...state });
      github(sys, g.issue);
      sys.route('POST', `${STATE}/comments`, { status: 201, json: {} });
      sys.route('PATCH', STATE, { status: 200, json: {} });
      return sys;
    }

    it('closes each State under the slice a "State: #N" line names, with a comment linking the pull request', async () => {
      const sys = delivering('Fixes the thing on narrow pages.\n\nSlice: #12\nState: #31');
      assert.deepEqual(await run(sys), { code: 0, out: ['✓ #12 is closed already; commented that it was built in #40', '✓ #31: closed, built in #40', STAYS] });
      assert.deepEqual(writes(sys), [
        ['POST', `${ISSUE}/comments`, { body: 'Built in #40, merged into main.' }, 'ghs_run'],
        ['POST', `${STATE}/comments`, { body: 'Built in #40, merged into main.' }, 'ghs_run'],
        ['PATCH', STATE, { state: 'closed', state_reason: 'completed' }, 'ghs_run'],
      ]);
    });

    it('leaves a State named only in prose open, as before', async () => {
      const sys = delivering('Builds State #31 of P-01.\n\nSlice: #12');
      assert.deepEqual((await run(sys)).out, ['✓ #12 is closed already; commented that it was built in #40', STAYS]);
      assert.deepEqual(writes(sys).filter((write) => String((write as string[])[1]).startsWith(STATE)), []);
    });

    it('comments once on a State GitHub closed already', async () => {
      const sys = delivering('Closes #31\n\nSlice: #12\nState: #31', { state: 'closed', state_reason: 'completed', closed_at: LATEST });
      assert.deepEqual((await run(sys)).out[1], '✓ #31 is closed already; commented that it was built in #40');
      const again = delivering('Slice: #12\nState: #31', { state: 'closed', state_reason: 'completed', closed_at: LATEST, comments: [comment('Built in #40, merged into main.', LATEST, 'github-actions[bot]')] });
      assert.deepEqual((await run(again)).out[1], '✓ #31 is closed already and says it was built in #40');
      assert.deepEqual(writes(again).filter((write) => String((write as string[])[1]).startsWith(STATE)), []);
    });

    it('leaves a State dropped as not planned, one under a slice the pull request does not name, and an issue that is not a State', async () => {
      const dropped = delivering('Slice: #12\nState: #31', { state: 'closed', state_reason: 'not_planned', closed_at: LATEST });
      assert.deepEqual((await run(dropped)).out[1], '- #31 was closed as not planned; left as it is');
      const elsewhere = delivering('Slice: #12\nState: #31');
      elsewhere.route('GET', `${STATE}/parent`, { status: 200, json: { number: 13, type: { name: 'Slice' }, url: `https://api.github.com/repos/${SLUG}/issues/13` } });
      assert.deepEqual((await run(elsewhere)).out[1], '- #31 is not a State under a slice #40 names; left as it is');
      const orphan = delivering('Slice: #12\nState: #31');
      orphan.route('GET', `${STATE}/parent`, { status: 404, json: { message: 'No parent issue found' } });
      assert.deepEqual((await run(orphan)).out[1], '- #31 is not a State under a slice #40 names; left as it is');
      const unsliced = delivering('Slice: #12\nState: #31');
      unsliced.route('GET', ISSUE, { status: 200, json: { number: 12, type: { name: 'Task' }, state: 'closed', url: `https://api.github.com${ISSUE}` } });
      assert.deepEqual((await run(unsliced)).out, ['- #12 is not a Slice in example-org/example-app; left as it is', '- #31 is not a State under a slice #40 names; left as it is']);
      const other = delivering('Slice: #12\nState: #31\nState: #99', { type: { name: 'Task' } });
      assert.deepEqual((await run(other)).out.slice(1), ['- #31 is not a State in example-org/example-app; left as it is', '- #99 is not a State in example-org/example-app; left as it is', STAYS]);
      assert.deepEqual([dropped, elsewhere, orphan, unsliced, other].flatMap((sys) => writes(sys).filter((write) => String((write as string[])[1]).startsWith(STATE))), []);
    });

    it("fails when it cannot read a State's parent, or GitHub refuses the close", async () => {
      const unread = delivering('Slice: #12\nState: #31');
      unread.route('GET', `${STATE}/parent`, { status: 502, json: null });
      await assert.rejects(run(unread), /^Error: cannot close #31: could not read #31's parent \(HTTP 502\)$/);
      const refused = delivering('Slice: #12\nState: #31');
      refused.route('PATCH', STATE, { status: 403, json: { message: 'Resource not accessible by integration' } });
      await assert.rejects(run(refused), /cannot close #31: Resource not accessible by integration; the client workflow needs a job with issues: write/);
    });
  });

  describe('the Work item above it (#655)', () => {
    const ITEM = `/repos/${SLUG}/issues/10`;
    const STATE = `/repos/${SLUG}/issues/31`;
    const CLOSING = 'All of its sub-issues are closed (#12), the last by #40, and its spec says its slices are all filed: closing this Work item.';
    /** Slice #12 under Work item #10, whose spec says its slices are all filed; a close GitHub records, as it would. */
    function finishing(body: string, change: (g: ReturnType<typeof graph>) => void = () => {}): FakeSys {
      const sys = actions(merged(body));
      const g = graph();
      g.issue.parent = { number: 10, type: { name: 'Work item' }, body: 'The spec.\n\n**Slices:** all filed', labels: [{ name: 'approved' }], comments: [] };
      change(g);
      github(sys, g.issue);
      const closes = (one: Node) => (): { status: number; json: unknown } => {
        Object.assign(one, { state: 'closed', state_reason: 'completed', closed_at: LATEST });
        return { status: 200, json: {} };
      };
      sys.route('PATCH', ISSUE, closes(g.issue));
      const state = g.states[0];
      if (state) {
        sys.route('POST', `${STATE}/comments`, { status: 201, json: {} });
        sys.route('PATCH', STATE, closes(state));
      }
      sys.route('POST', `${ITEM}/comments`, { status: 201, json: {} });
      sys.route('PATCH', ITEM, { status: 200, json: {} });
      return sys;
    }
    const onItem = (sys: FakeSys): unknown[] => writes(sys).filter((write) => String((write as string[])[1]).startsWith(ITEM));

    it('closes the Work item when the merge closes its last slice, saying which pull request did', async () => {
      const sys = finishing('Slice: #12');
      assert.deepEqual(await run(sys), { code: 0, out: ['✓ #12: closed, built in #40', '✓ #10: closed, since all 1 of its sub-issues are closed (#12)'] });
      assert.deepEqual(onItem(sys), [
        ['POST', `${ITEM}/comments`, { body: CLOSING }, 'ghs_run'],
        ['PATCH', ITEM, { state: 'closed', state_reason: 'completed' }, 'ghs_run'],
      ]);
    });

    it('closes it when the merge closes the last State under its closed slice', async () => {
      const sys = finishing('Slice: #12\nState: #31', (g) => {
        Object.assign(g.issue, { state: 'closed', state_reason: 'completed', closed_at: LATER });
        g.states.push({ number: 31, title: 'Fix: the thing', type: { name: 'State' }, state: 'open', state_reason: null, closed_at: null, comments: [] });
      });
      assert.deepEqual((await run(sys)).out, [
        '✓ #12 is closed already; commented that it was built in #40',
        '✓ #31: closed, built in #40',
        '✓ #10: closed, since all 1 of its sub-issues are closed (#12)',
      ]);
    });

    it('judges a Work item once, however many of its slices the pull request names', async () => {
      const sys = finishing('Slice: #12\nSlice: #13', (g) => {
        g.siblings.push({ number: 13, title: 'Add more', type: { name: 'Slice' }, state: 'open', state_reason: null, closed_at: null, own: [] });
      });
      const SIBLING = `/repos/${SLUG}/issues/13`;
      const sibling = { number: 13, title: 'Add more', type: { name: 'Slice' }, state: 'open', url: `https://api.github.com${SIBLING}` };
      sys.route('GET', SIBLING, { status: 200, json: sibling });
      sys.route('GET', `${SIBLING}/parent`, { status: 200, json: { number: 10, type: { name: 'Work item' }, url: `https://api.github.com${ITEM}` } });
      sys.route('GET', `${SIBLING}/comments?per_page=100&page=1`, { status: 200, json: [] });
      sys.route('POST', `${SIBLING}/comments`, { status: 201, json: {} });
      sys.route('PATCH', SIBLING, { status: 200, json: {} });
      assert.deepEqual((await run(sys)).out, ['✓ #12: closed, built in #40', '✓ #13: closed, built in #40', '- #10 stays open: #13 is still open']);
      assert.equal(sys.requests.filter((request) => request.method === 'GET' && request.url.endsWith(ITEM)).length, 1);
    });

    it("leaves a Work item in another repository to that repository's jobs, and a slice under no Work item alone", async () => {
      const foreign = finishing('Slice: #12');
      foreign.route('GET', `${ISSUE}/parent`, { status: 200, json: { number: 10, type: { name: 'Work item' }, url: `https://api.github.com/repos/${PLANS}/issues/10` } });
      assert.deepEqual((await run(foreign)).out, ['✓ #12: closed, built in #40', "- #12's Work item is in another repository; left to its own jobs"]);
      const orphan = finishing('Slice: #12');
      orphan.route('GET', `${ISSUE}/parent`, { status: 404, json: { message: 'No parent issue found' } });
      assert.deepEqual((await run(orphan)).out, ['✓ #12: closed, built in #40']);
      assert.deepEqual([...onItem(foreign), ...onItem(orphan)], []);
    });

    it('leaves a slice whose parent has no type alone', async () => {
      const sys = finishing('Slice: #12');
      sys.route('GET', `${ISSUE}/parent`, { status: 200, json: { number: 10, type: null, url: `https://api.github.com${ITEM}` } });
      assert.deepEqual((await run(sys)).out, ['✓ #12: closed, built in #40']);
      assert.deepEqual(onItem(sys), []);
    });

    it("fails when it cannot read a slice's Work item", async () => {
      const sys = finishing('Slice: #12');
      sys.route('GET', `${ISSUE}/parent`, { status: 502, json: null });
      await assert.rejects(run(sys), /^Error: cannot judge #12's Work item: could not read #12's parent \(HTTP 502\)$/);
    });
  });
});

describe('prStarted', () => {
  const EVENT = '/tmp/event.json';
  /** The Slice started job on pull request #40 with `body`, slice #12 as graph() has it, and the board app's token unless `board` is null. */
  function actions(body: string | null, board: string | null = 'ghs_board'): FakeSys {
    const sys = new FakeSys();
    sys.env = { GITHUB_EVENT_PATH: EVENT, GITHUB_REPOSITORY: SLUG, GH_TOKEN: 'ghs_run', ...(board === null ? {} : { NIYAM_BOARD_TOKEN: board }) };
    sys.files.set(EVENT, JSON.stringify({ pull_request: { number: 40, body } }));
    github(sys, graph().issue, [{ number: 40, body, head: { ref: 'work', repo: { full_name: SLUG } } }]);
    return sys;
  }
  async function run(sys: FakeSys): Promise<{ code: number; out: string[]; err: string[] }> {
    const { io, out, err } = capture();
    return { code: await prStarted(sys, io), out, err };
  }
  const writes = (board: RestBoard): string[] => board.writes.map(({ path }) => path.split('/').at(-1) as string);
  const boardReads = (sys: FakeSys): boolean => sys.requests.some((r) => r.url.includes('projectsV2'));

  it("moves the slice to In Progress and its work item to Build with the board app's token, reading the slice with the workflow's", async () => {
    const sys = actions('Builds the thing.\n\nSlice: #12');
    const board = new RestBoard(sys);
    assert.deepEqual(await run(sys), {
      code: 0,
      out: [
        '✓ board: slice #12 is In Progress in "example-app work"',
        '✓ board: work item #10 is at Step Build in "example-app work"',
        '✓ board: work item #20 had no Step; it is at Frame in "example-app work"',
      ],
      err: [],
    });
    assert.deepEqual(writes(board), ['100', '101', '102']);
    assert.ok(sys.requests.filter((r) => r.url.includes('projectsV2')).every((r) => r.token === 'ghs_board'));
    assert.ok(sys.requests.filter((r) => r.url.endsWith('/issues/10/timeline?per_page=100&page=1')).every((r) => r.token === 'ghs_run'), 'the work rules read with GH_TOKEN');
    assert.ok(!sys.requests.some((r) => r.url.endsWith('/graphql')));
  });

  it("says so and passes without the board app's token, reading nothing", async () => {
    const sys = actions('Slice: #12', null);
    const board = new RestBoard(sys);
    assert.deepEqual(await run(sys), {
      code: 0,
      out: [
        'pr-started: no board app token here (the NIYAM_BOARD_APP_ID and NIYAM_BOARD_APP_KEY secrets are not passed, or GitHub would not make the token), so #12 moves on the board only from a desktop push',
      ],
      err: [],
    });
    assert.deepEqual(writes(board), []);
    assert.ok(!sys.requests.some((r) => r.url.includes('/issues/12')), 'the slice is not read');
    // An empty token is what the workflow passes when the token step is skipped or fails.
    assert.match((await run(actions('Slice: #12', ''))).out[0] ?? '', /^pr-started: no board app token here/);
  });

  it('says the slice and its work item are in place when a later run, on a push or an edit, finds them moved', async () => {
    const sys = actions('Slice: #12');
    const board = new RestBoard(sys);
    board.projects[0]!.items = [
      { issue: 12, values: { Status: 'In Progress' } },
      { issue: 10, values: { Status: 'Todo', Step: 'Build' } },
    ];
    board.workItems = [10];
    assert.deepEqual(await run(sys), { code: 0, out: ['pr-started: #12 and its work item are where they belong on the board already'], err: [] });
    assert.deepEqual(writes(board), []);
  });

  it('says the slice is not on the board, not that it is in place, when no Project holds it', async () => {
    const sys = actions('Slice: #12');
    const board = new RestBoard(sys);
    board.projects[0]!.items = [{ issue: 10, values: { Status: 'Todo', Step: 'Build' } }];
    board.workItems = [10];
    assert.deepEqual(await run(sys), {
      code: 0,
      out: ['! board: slice #12 is not on the board: no open Project of example-org with a Status field holds it unarchived, so it did not move to In Progress'],
      err: [],
    });
    assert.deepEqual(writes(board), []);
  });

  it("says the Project's Status has no option In Progress, not that the slice is in place", async () => {
    const sys = actions('Slice: #12');
    const board = new RestBoard(sys);
    board.projects[0]!.fields.Status = ['Todo', 'Done'];
    board.projects[0]!.items = [
      { issue: 12, values: { Status: 'Todo' } },
      { issue: 10, values: { Status: 'Todo', Step: 'Build' } },
    ];
    board.workItems = [10];
    assert.deepEqual(await run(sys), {
      code: 0,
      out: [`! board: Status in "example-app work" has no option In Progress, so slice #12 stays where it is; add the option to the Project's Status field`],
      err: [],
    });
    assert.deepEqual(writes(board), []);
  });

  it('moves nothing for a slice the work rules refuse, and passes, as Work rules fails the pull request', async () => {
    const sys = actions('Slice: #12');
    const g = graph();
    g.timeline.splice(1, 1);
    github(sys, g.issue);
    const board = new RestBoard(sys);
    assert.deepEqual(await run(sys), { code: 0, out: ['pr-started: #12 may not be built yet (Work rules says why), so nothing moves on the board'], err: [] });
    assert.deepEqual(writes(board), []);
    assert.equal(boardReads(sys), false);
  });

  for (const [body, line] of [
    [null, 'pr-started: #40 names no slice; nothing moves on the board'],
    ['Slice: #12\nSlice: #13', 'pr-started: #40 names 2 slices; nothing moves on the board'],
  ] as const) {
    it(`moves nothing for a pull request with body ${JSON.stringify(body)}`, async () => {
      const sys = actions(body);
      const board = new RestBoard(sys);
      assert.deepEqual(await run(sys), { code: 0, out: [line], err: [] });
      assert.deepEqual(writes(board), []);
    });
  }

  it('says when GitHub refuses the board, and passes', async () => {
    const sys = actions('Slice: #12');
    const board = new RestBoard(sys);
    board.refuse = (method, path) => (path === '/orgs/example-org/projectsV2' ? { status: 403, json: { message: 'Resource not accessible by integration' } } : undefined);
    assert.deepEqual(await run(sys), {
      code: 0,
      out: ["! board: nothing moved for #12 (GitHub's REST API refused GET /orgs/example-org/projectsV2?per_page=100: HTTP 403 Resource not accessible by integration); the pull request's checks go on"],
      err: [],
    });
  });

  it('moves nothing with the board or work-rules feature off', async () => {
    for (const [features, line] of [
      [['identity', 'work-rules'], `pr-started: board is off in .github/niyam.json; nothing to check`],
      [['identity', 'board'], `pr-started: work-rules is off in .github/niyam.json; nothing to check`],
    ] as const) {
      const sys = actions('Slice: #12');
      sys.files.set(`${ROOT}/.github/niyam.json`, JSON.stringify({ owner: OWNER, agent: AGENT, features }));
      const board = new RestBoard(sys);
      assert.deepEqual(await run(sys), { code: 0, out: [line], err: [] });
      assert.deepEqual(writes(board), []);
      assert.equal(boardReads(sys), false);
    }
  });

  it('moves nothing for an event that is not a pull request', async () => {
    const sys = actions('Slice: #12');
    sys.files.set(EVENT, '{}');
    assert.deepEqual(await run(sys), { code: 0, out: ['pr-started: not a pull request; nothing to move'], err: [] });
  });

  it('moves nothing before the repo adopts niyam, or in a repository a personal account owns', async () => {
    const before = actions('Slice: #12');
    before.files.delete(`${ROOT}/.github/niyam.json`);
    const personal = actions('Slice: #12');
    personal.ownerType = 'User';
    for (const [sys, line] of [
      [before, 'pr-started: the base branch has no .github/niyam.json, so the repo is not adopted on its base yet; nothing to check'],
      [personal, 'pr-started: work-rules is off on a repository owned by a personal account, since GitHub has issue types for organisations only; nothing to check'],
    ] as const) {
      const board = new RestBoard(sys);
      assert.deepEqual(await run(sys), { code: 0, out: [line], err: [] });
      assert.deepEqual(writes(board), []);
      assert.equal(boardReads(sys), false);
    }
  });

  it('needs each of GITHUB_EVENT_PATH, GITHUB_REPOSITORY and GH_TOKEN', async () => {
    for (const name of ['GITHUB_EVENT_PATH', 'GITHUB_REPOSITORY', 'GH_TOKEN']) {
      const sys = actions('Slice: #12');
      delete sys.env[name];
      await assert.rejects(run(sys), { message: 'pr-started runs in GitHub Actions: GITHUB_EVENT_PATH, GITHUB_REPOSITORY and GH_TOKEN must be set' }, name);
    }
  });
});

describe('propose', () => {
  const ISSUE = `/repos/${SLUG}/issues/12`;
  /** An agent session, slice #12 added after approval, and state #30 of it dropped after approval. */
  function session(g = graph()): { sys: FakeSys; g: ReturnType<typeof graph> } {
    const sys = new FakeSys();
    sys.env = { NIYAM_AGENT: AGENT, GH_TOKEN: 'ghp_good' };
    sys.acceptToken('ghp_good', AGENT);
    github(sys, g.issue);
    let made = 0;
    sys.route('POST', `${ISSUE}/comments`, () => ({ status: 201, json: { html_url: `https://github.com/example-org/example-app/issues/12#issuecomment-${++made}` } }));
    sys.route('POST', `${ISSUE}/labels`, { status: 200, json: [] });
    sys.route('DELETE', `${ISSUE}/labels/needs-owner`, { status: 200, json: [] });
    return { sys, g };
  }
  const owing = (): ReturnType<typeof graph> => {
    const g = graph();
    g.timeline[0] = { event: 'sub_issue_added', created_at: LATER, sub_issue: { number: 12 } };
    g.states.push({
      number: 30,
      title: 'Empty list',
      body: 'The list shows a note when empty.\n\n**Why:** the list is never empty now.\n\n**Cost:** nothing anyone would see.',
      type: { name: 'State' },
      state_reason: 'not_planned',
      closed_at: LATER,
      comments: [],
    });
    return g;
  };
  /** The published page each run's proposals point to, unless a test runs without one. */
  const PAGE = 'https://claude.ai/artifact/W48-page';
  async function withPage(sys: FakeSys, page: string | undefined, ...numbers: number[]): Promise<{ code: number; out: string[]; err: string[] }> {
    const { io, out, err } = capture();
    return { code: await propose(sys, io, numbers.length > 0 ? numbers : [12], page), out, err };
  }
  async function run(sys: FakeSys, ...numbers: number[]): Promise<{ code: number; out: string[]; err: string[] }> {
    return withPage(sys, PAGE, ...numbers);
  }
  /** Settings that name #700 as the Approvals issue. */
  const withApprovals = (sys: FakeSys): void => {
    sys.files.set(`${ROOT}/.github/niyam.json`, JSON.stringify({ ...JSON.parse(SETTINGS), approvals: APPROVALS }));
  };
  const BATCH = `example-owner answers all 2 with one comment on https://github.com/${SLUG}/issues/700, the Approvals issue, whose first line is this (deleting a number leaves that one waiting):`;
  const posted = (sys: FakeSys): string[] =>
    sys.requests.filter((r) => r.method === 'POST' && r.url.endsWith('/comments')).map((r) => (r.body as { body: string }).body);

  it("proposes each decision the slice owes, as the agent, and labels it for the owner's Needs you view", async () => {
    const { sys } = session(owing());
    assert.deepEqual(await run(sys), {
      code: 0,
      out: [
        '✓ #12: proposed on #12: https://github.com/example-org/example-app/issues/12#issuecomment-1',
        '✓ state #30: proposed on #12: https://github.com/example-org/example-app/issues/12#issuecomment-2',
        "#12 is labeled needs-owner, waiting on example-owner's 👍 on https://github.com/example-org/example-app/issues/12#issuecomment-1 and https://github.com/example-org/example-app/issues/12#issuecomment-2",
      ],
      err: [],
    });
    const ask = '@example-owner: react 👍 to this comment to approve it, or comment "Decision:".';
    // A pointer: what is proposed, the page that argues it, how to answer.
    assert.deepEqual(posted(sys), [
      ['Proposal: add #12 (Add the thing) to work item #10.', `Page: ${PAGE}`, ask].join('\n\n'),
      ["Proposal: drop state #30 (Empty list), closed as not planned after work item #10's approval.", `Page: ${PAGE}`, ask].join('\n\n'),
    ]);
    // Each passes the guard's own rule for asks: a page link, at most 500 characters.
    for (const body of posted(sys)) assert.equal(askProblem({ text: body, known: true, opensUnknown: false }, [OWNER]), undefined);
    assert.deepEqual(sys.requests.find((r) => r.url.endsWith('/labels'))?.body, { labels: ['needs-owner'] });
  });

  it('refuses, posting nothing, while a body lacks what its proposal says', async () => {
    const g = owing();
    g.issue.body = 'Slice P-01 of #10.\n\n**You will see:**\n\n**Needs:** —';
    (g.states[0] as Node).body = null;
    const { sys } = session(g);
    assert.deepEqual(await run(sys), {
      code: 1,
      out: [],
      err: [
        '✗ #12\'s body has no "**You will see:**" or "**Why:**" section; write it there first, so the proposal says what changes and why',
        '✗ state #30\'s body has no "**Why:**" section; write it there first, so the proposal says what changes and why',
        'propose: refused by the work rules',
      ],
    });
    assert.deepEqual(posted(sys), []);
    // What is already proposed, or settled, needs nothing more.
    g.comments.push(comment('Proposal: add #12', LATER, AGENT));
    ((g.states[0] as Node).comments as Node[]).push(comment('Decision: drop it'));
    assert.equal((await run(sys)).code, 0);
    assert.deepEqual(posted(sys), []);
  });

  it('refuses, posting nothing, without a page to point to, and prints the command to run', async () => {
    const { sys } = session(owing());
    const why = 'no proposal yet, and a proposal is a short pointer to the published page that argues it: publish the page, then run';
    assert.deepEqual(await withPage(sys, undefined), {
      code: 1,
      out: [],
      err: [`✗ #12 and state #30 have ${why} niyam propose 12 --page <page url>`, 'propose: refused by the work rules'],
    });
    assert.equal((await withPage(sys, undefined, 30)).err[0], `✗ state #30 has ${why} niyam propose 30 --page <page url>`);
    assert.deepEqual(posted(sys), []);
  });

  it('refuses a link that is no published page, before asking GitHub anything', async () => {
    const { sys } = session(owing());
    for (const page of ['https://example.com/page', 'https://claude.ai/artifact/abc extra', 'see https://claude.ai/artifact/abc', '']) {
      assert.deepEqual(
        await withPage(sys, page),
        {
          code: 1,
          out: [],
          err: [`✗ --page takes the link of a published page (https://claude.ai/artifact/… or https://claude.ai/code/artifact/…), not "${page}"`, 'propose: refused by the work rules'],
        },
        page,
      );
    }
    assert.deepEqual(sys.requests, []);
    assert.equal((await withPage(sys, 'https://claude.ai/code/artifact/abc-1')).code, 0);
    assert.match(posted(sys)[0] ?? '', /\n\nPage: https:\/\/claude\.ai\/code\/artifact\/abc-1\n\n/);
  });

  it('refuses, posting nothing, a proposal the guard would refuse: a title too long for 500 characters', async () => {
    const g = owing();
    g.issue.title = 'x'.repeat(450);
    const { sys } = session(g);
    const { code, err } = await run(sys);
    assert.equal(code, 1);
    assert.match(err[0] ?? '', /^✗ #12's proposal is not posted: this comment asks the owner \(it opens with "Proposal:"\), and it runs \d+ characters, over 500; shorten #12's title$/);
    assert.equal(err.length, 2);
    assert.deepEqual(posted(sys), []);
  });

  describe('with an Approvals issue', () => {
    it('says each proposal can be answered there, and ends with the batch answer, ready to paste', async () => {
      const { sys } = session(owing());
      withApprovals(sys);
      const { code, out } = await run(sys);
      assert.equal(code, 0);
      assert.deepEqual(out.slice(-2), [BATCH, 'Decision: approve #12 #30']);
      const asks = posted(sys).map((body) => body.split('\n\n').at(-1));
      const ask = `@example-owner: react 👍 to this comment to approve it, or comment "Decision:", or answer the batch on Approvals, ${W}/700.`;
      assert.deepEqual(asks, [ask, ask]);
    });

    it('names each waiting proposal once, though several numbers share a slice', async () => {
      const g = owing();
      g.comments.push(comment('Proposal: add #12', LATER, AGENT), comment('Proposal: drop state #30', LATER, AGENT));
      const { sys } = session(g);
      withApprovals(sys);
      const { code, out } = await run(sys, 12, 30, 12);
      assert.equal(code, 0);
      assert.deepEqual(out.filter((line) => line.startsWith('Decision:')), ['Decision: approve #12 #30']);
      assert.equal(out.filter((line) => line === BATCH).length, 1);
      // Both were proposed before, so each run links them and posts nothing.
      assert.deepEqual(posted(sys), []);
      // The issues asked for lead, in the order given, then what else waits on their slices.
      const { sys: again } = session(g);
      withApprovals(again);
      assert.equal((await run(again, 30)).out.at(-1), 'Decision: approve #30 #12');
    });

    it('still hands over what waits when one of the numbers is refused, and fails', async () => {
      const { sys } = session(owing());
      withApprovals(sys);
      sys.route('GET', `/repos/${SLUG}/issues/30/parent`, { status: 403, json: { message: 'Resource not accessible by integration' } });
      const { code, out, err } = await run(sys, 30, 12);
      assert.equal(code, 1);
      assert.equal(err[0], "✗ could not read #30's parent (HTTP 403: Resource not accessible by integration)");
      assert.deepEqual(out.slice(-2), [BATCH, 'Decision: approve #30 #12']);
    });

    it('leaves out what has no proposal yet, and says "it" for one', async () => {
      const { sys } = session(owing());
      withApprovals(sys);
      const { out } = await run(sys, 30);
      assert.deepEqual(out.slice(-2), [
        `example-owner answers it with one comment on https://github.com/${SLUG}/issues/700, the Approvals issue, whose first line is this (deleting a number leaves that one waiting):`,
        'Decision: approve #30',
      ]);
      assert.match(out.at(-3) ?? '', /; ExampleBot proposes #12 with: niyam propose 12 --page <page url>$/);
    });

    it('prints no batch answer when nothing waits', async () => {
      const g = owing();
      g.comments.push(comment('Decision: add it'));
      ((g.states[0] as Node).comments as Node[]).push(comment('Decision: drop it'));
      const { sys } = session(g);
      withApprovals(sys);
      const { code, out } = await run(sys, 12, 30);
      assert.equal(code, 0);
      assert.equal(out.some((line) => line.startsWith('Decision:') || line.includes('Approvals issue')), false);
    });
  });

  it('proposes a state alone, given the state', async () => {
    const { sys } = session(owing());
    const { out } = await run(sys, 30);
    assert.equal(out[0], '✓ state #30: proposed on #12: https://github.com/example-org/example-app/issues/12#issuecomment-1');
    assert.equal(posted(sys).length, 1);
  });

  it("refuses a state whose slice cannot be read, saying so", async () => {
    const { sys } = session(owing());
    sys.route('GET', `/repos/${SLUG}/issues/30/parent`, { status: 403, json: { message: 'Resource not accessible by integration' } });
    assert.deepEqual(await run(sys, 30), {
      code: 1,
      out: [],
      err: ["✗ could not read #30's parent (HTTP 403: Resource not accessible by integration)", 'propose: refused by the work rules'],
    });
    assert.deepEqual(posted(sys), []);
  });

  it("posts nothing twice, linking the waiting proposal itself, and keeps the label while the owner has not decided", async () => {
    const g = owing();
    const older = comment('Proposal: add #12', LATER, AGENT);
    const made = comment('Proposal: add #12', LATER, AGENT);
    g.comments.push(older, made);
    // On the slice, any Decision: also settles its addition.
    ((g.states[0] as Node).comments as Node[]).push(comment('Decision: drop it'));
    const { sys } = session(g);
    // The newest proposal's own comment, never the slice's top or the needs-owner list.
    assert.notEqual(older.html_url, made.html_url);
    assert.deepEqual((await run(sys)).out, [
      `#12: proposed on #12, waiting on example-owner's 👍: ${made.html_url as string}`,
      '✓ state #30: example-owner has decided',
      `#12 is labeled needs-owner, waiting on example-owner's 👍 on ${made.html_url as string}`,
    ]);
    assert.deepEqual(posted(sys), []);
    // Linking what is already posted, and labeling, needs no page.
    assert.equal((await withPage(sys, undefined)).code, 0);
    assert.deepEqual(posted(sys), []);
  });

  it("links, given a state, the slice's own waiting proposal too, or says how to post it", async () => {
    const g = owing();
    const { sys } = session(g);
    assert.deepEqual((await run(sys, 30)).out, [
      '✓ state #30: proposed on #12: https://github.com/example-org/example-app/issues/12#issuecomment-1',
      "#12 is labeled needs-owner, waiting on example-owner's 👍 on https://github.com/example-org/example-app/issues/12#issuecomment-1; ExampleBot proposes #12 with: niyam propose 12 --page <page url>",
    ]);
    const made = comment('Proposal: add #12', LATER, AGENT);
    g.comments.push(made);
    ((g.states[0] as Node).comments as Node[]).push(comment('Decision: drop it'));
    assert.deepEqual((await run(sys, 30)).out, [
      '✓ state #30: example-owner has decided',
      `#12 is labeled needs-owner, waiting on example-owner's 👍 on ${made.html_url as string}`,
    ]);
    g.comments.pop();
    assert.deepEqual((await run(sys, 30)).out, [
      '✓ state #30: example-owner has decided',
      '#12 is labeled needs-owner; ExampleBot proposes #12 with: niyam propose 12 --page <page url>',
    ]);
  });

  it('still counts a proposal GitHub answered without its link as posted', async () => {
    const g = owing();
    g.states.pop();
    const { sys } = session(g);
    sys.route('POST', `${ISSUE}/comments`, { status: 201, json: null });
    assert.deepEqual((await run(sys)).out, ['✓ #12: proposed on #12', '#12 is labeled needs-owner']);
  });

  it("takes the label off once the owner's 👍 settles everything", async () => {
    const g = owing();
    g.states.pop();
    const made = comment('Proposal: add #12', LATER, AGENT);
    g.comments.push(made);
    g.thumbs.set(made.id as string, [thumb()]);
    const { sys } = session(g);
    assert.deepEqual((await run(sys)).out, ['✓ #12: example-owner has decided', '✓ #12: nothing waits on example-owner']);
    assert.ok(sys.requests.some((r) => r.method === 'DELETE'));
    sys.route('DELETE', `${ISSUE}/labels/needs-owner`, { status: 404, json: null });
    assert.equal((await run(sys)).code, 0);
    sys.route('DELETE', `${ISSUE}/labels/needs-owner`, { status: 403, json: null });
    await assert.rejects(run(sys), /cannot take needs-owner off #12 \(HTTP 403\)/);
  });

  it('says when the issue owes the owner nothing', async () => {
    assert.deepEqual(await run(session().sys), { code: 0, out: ['propose: #12 needs no decision from example-owner'], err: [] });
  });

  it('refuses a slice the work rules stop outright', async () => {
    const g = graph();
    g.timeline.splice(1, 1);
    assert.deepEqual(await run(session(g).sys), {
      code: 1,
      out: [],
      err: [`✗ work item #10, ${W}/10, is not approved: example-owner adds the approved label before any slice starts`, 'propose: refused by the work rules'],
    });
  });

  it('refuses a session with no token, or not working as the agent', async () => {
    const { sys } = session();
    sys.env = {};
    assert.deepEqual((await run(sys)).err, ['✗ this session has no token; run niyam doctor', 'propose: refused by the work rules']);
    sys.env = { GH_TOKEN: 'niyam-no-agent-token' };
    assert.equal((await run(sys)).err[0], '✗ this session has no token; run niyam doctor', "the lock's placeholder");
    sys.env = { GH_TOKEN: 'process-rules-no-agent-token' };
    assert.equal((await run(sys)).err[0], "✗ propose posts as ExampleBot, but this session's token is refused", "0.6.9's placeholder is a token GitHub refuses (P-57)");
    sys.env = { GH_TOKEN: 'ghp_owner' };
    assert.equal((await run(sys)).err[0], "✗ propose posts as ExampleBot, but this session's token is refused");
    sys.acceptToken('ghp_owner', OWNER);
    assert.equal((await run(sys)).err[0], "✗ propose posts as ExampleBot, but this session's token is example-owner");
  });

  it('throws when GitHub will not take the comment or the label', async () => {
    const { sys } = session(owing());
    sys.route('POST', `${ISSUE}/comments`, { status: 403, json: null });
    await assert.rejects(run(sys), /cannot comment on #12 \(HTTP 403\)/);
    const other = session(owing()).sys;
    other.route('POST', `${ISSUE}/comments`, { status: 201, json: null });
    other.route('POST', `${ISSUE}/labels`, { status: 404, json: null });
    await assert.rejects(run(other), /cannot label #12 needs-owner \(HTTP 404\)/);
  });

  it('passes when the work rules are off', async () => {
    const { sys } = session();
    sys.files.set(`${ROOT}/.github/niyam.json`, JSON.stringify({ ...JSON.parse(SETTINGS), features: ['identity'] }));
    const { code, out } = await run(sys);
    assert.equal(code, 0);
    assert.match(out[0] ?? '', /^propose: .*work-rules/);
  });

  it('passes in a repository a personal account owns, posting nothing', async () => {
    const { sys } = session(owing());
    sys.ownerType = 'User';
    assert.deepEqual(await run(sys), {
      code: 0,
      out: ['propose: work-rules is off on a repository owned by a personal account, since GitHub has issue types for organisations only; nothing to check'],
      err: [],
    });
    assert.deepEqual(posted(sys), []);
  });

  it('refuses a token GitHub names as the agent but does not answer for', async () => {
    const { sys } = session(owing());
    sys.route('GET', '/user', { status: 500, json: { login: AGENT } });
    assert.deepEqual(await run(sys), { code: 1, out: [], err: ["✗ propose posts as ExampleBot, but this session's token is ExampleBot", 'propose: refused by the work rules'] });
    assert.deepEqual(posted(sys), []);
  });

  it('names, given a state, each other decision its slice waits on that has no proposal', async () => {
    const g = owing();
    g.states.push({ number: 31, title: 'Old filter', body: '**Why:** nobody filters.', type: { name: 'State' }, state_reason: 'not_planned', closed_at: LATER, comments: [] });
    const { sys } = session(g);
    assert.deepEqual((await run(sys, 30)).out.at(-1), [
      "#12 is labeled needs-owner, waiting on example-owner's 👍 on https://github.com/example-org/example-app/issues/12#issuecomment-1",
      '; ExampleBot proposes #12 with: niyam propose 12 --page <page url>',
      '; ExampleBot proposes #31 with: niyam propose 31 --page <page url>',
    ].join(''));
  });

  it("refuses a State whose parent GitHub gives no type, as no slice's", async () => {
    const { sys } = session(owing());
    sys.route('GET', `/repos/${SLUG}/issues/30/parent`, { status: 200, json: { number: 12, type: null, url: `https://api.github.com${ISSUE}` } });
    assert.equal((await run(sys, 30)).code, 1);
    assert.deepEqual(posted(sys), []);
  });

  describe('with an Approvals issue, and a number it cannot propose', () => {
    it('hands over only what waits, past a number that is no issue or has no type', async () => {
      const { sys } = session(owing());
      withApprovals(sys);
      sys.route('GET', `/repos/${SLUG}/issues/13`, { status: 200, json: { number: 13, type: null, state: 'open', url: `https://api.github.com/repos/${SLUG}/issues/13` } });
      const { code, out } = await run(sys, 99, 13, 12);
      assert.equal(code, 1);
      assert.deepEqual(out.filter((line) => line.startsWith('Decision:')), ['Decision: approve #12 #30']);
    });

    it('hands over nothing for a run that proposes nothing', async () => {
      const gaps = owing();
      gaps.issue.body = 'Slice P-01 of #10.';
      const long = owing();
      long.issue.title = 'x'.repeat(450);
      for (const [name, sys, page] of [
        ['nothing owed', session().sys, PAGE],
        ['a body with no Why', session(gaps).sys, PAGE],
        ['no page', session(owing()).sys, undefined],
        ['a title too long', session(long).sys, PAGE],
      ] as const) {
        withApprovals(sys);
        const { out, err } = await withPage(sys, page);
        assert.deepEqual(out.filter((line) => line.startsWith('Decision:') || line.includes('Approvals issue')), [], name);
        assert.deepEqual(err.slice(1), name === 'nothing owed' ? [] : ['propose: refused by the work rules'], name);
      }
    });
  });
});

describe('fileState', () => {
  const FILE = `/repos/${SLUG}/issues`;
  const ATTACH = `/repos/${SLUG}/issues/12/sub_issues`;
  /** An agent session and slice #12, closed unless `open`; GitHub files the State as #31, whose id is 9031. */
  function session(open = false): FakeSys {
    const sys = new FakeSys();
    sys.env = { NIYAM_AGENT: AGENT, GH_TOKEN: 'ghp_good' };
    sys.acceptToken('ghp_good', AGENT);
    const g = graph();
    if (!open) g.issue.state = 'closed';
    github(sys, g.issue);
    sys.route('POST', FILE, { status: 201, json: { id: 9031, number: 31, html_url: `${W}/31` } });
    sys.route('POST', ATTACH, { status: 201, json: { number: 12 } });
    return sys;
  }
  async function run(sys: FakeSys, slice = 12, title = 'Fix: the thing on narrow pages'): Promise<{ code: number; out: string[]; err: string[] }> {
    const { io, out, err } = capture();
    return { code: await fileState(sys, io, slice, title), out, err };
  }
  const writes = (sys: FakeSys): Array<{ method: string | undefined; url: string; body: unknown; token: string | undefined }> =>
    sys.requests.filter((request) => request.method === 'POST').map(({ method, url, body, token }) => ({ method, url, body, token }));

  it('files a State under a closed slice, attached by its id, and prints the line that names it', async () => {
    const sys = session();
    assert.deepEqual(await run(sys), {
      code: 0,
      out: [`✓ #31, ${W}/31: a State under #12`, 'Put this line under the pull request\'s "Slice: #12" line:', 'State: #31'],
      err: [],
    });
    assert.deepEqual(writes(sys), [
      { method: 'POST', url: `https://api.github.com${FILE}`, body: { title: 'Fix: the thing on narrow pages', body: 'Part of #12.', type: 'State' }, token: 'ghp_good' },
      // The id, not the number: GitHub's sub-issues API takes the issue's id.
      { method: 'POST', url: `https://api.github.com${ATTACH}`, body: { sub_issue_id: 9031 }, token: 'ghp_good' },
    ]);
  });

  it('files one under an open slice too, saying its pull request needs none while it stays open', async () => {
    const filed = await run(session(true));
    assert.equal(filed.code, 0);
    assert.deepEqual(filed.out.slice(1), [
      '#12 is open, so its pull request needs no State while it stays open; once it closes, the pull request that fixes it names this one under its "Slice: #12" line:',
      'State: #31',
    ]);
  });

  it('refuses an issue that is not a Slice, filing nothing', async () => {
    const sys = session();
    sys.route('GET', `${ISSUES}/12`, { status: 200, json: { number: 12, url: `${ISSUES}/12`, state: 'open', type: { name: 'Work item' } } });
    assert.deepEqual(await run(sys), { code: 1, out: [], err: ['✗ #12 is not a Slice (its type is Work item); a State is filed under the slice it is part of'] });
    sys.route('GET', `${ISSUES}/12`, { status: 404, json: { message: 'Not Found' } });
    assert.deepEqual(await run(sys), { code: 1, out: [], err: [`✗ #12 is not an issue in ${SLUG}`] });
    sys.route('GET', `${ISSUES}/12`, { status: 200, json: { number: 12, url: `${ISSUES}/12`, pull_request: {}, type: null } });
    assert.deepEqual(await run(sys), { code: 1, out: [], err: [`✗ #12 is not an issue in ${SLUG}`] });
    assert.deepEqual(writes(sys), []);
  });

  it('says GitHub refused, when it files no State', async () => {
    const sys = session();
    sys.route('POST', FILE, { status: 422, json: { message: 'Validation Failed' } });
    assert.deepEqual(await run(sys), { code: 1, out: [], err: ['✗ GitHub did not file the State (HTTP 422: Validation Failed)'] });
    assert.equal(writes(sys).length, 1, 'nothing was attached');
  });

  it('fails, with the call that attaches it, when the State is filed but not attached', async () => {
    const sys = session();
    sys.route('POST', ATTACH, { status: 422, json: { message: 'Validation Failed' } });
    assert.deepEqual(await run(sys), {
      code: 1,
      out: [],
      err: [`✗ #31, ${W}/31, was filed but not attached under #12 (HTTP 422: Validation Failed); attach it with: gh api --method POST repos/${SLUG}/issues/12/sub_issues -F sub_issue_id=9031`],
    });
  });

  it('files nothing without a token', async () => {
    const sys = session();
    sys.env = { NIYAM_AGENT: AGENT };
    assert.deepEqual(await run(sys), { code: 1, out: [], err: ['✗ this session has no token; run niyam doctor'] });
    assert.deepEqual(writes(sys), []);
  });

  it('files nothing with the work rules off, or in a repository a personal account owns, saying so', async () => {
    const off = session();
    off.files.set(`${ROOT}/.github/niyam.json`, JSON.stringify({ ...JSON.parse(SETTINGS), features: ['identity'] }));
    const personal = session();
    personal.ownerType = 'User';
    for (const [sys, line] of [
      [off, 'state: work-rules is off in .github/niyam.json; nothing to check'],
      [personal, 'state: work-rules is off on a repository owned by a personal account, since GitHub has issue types for organisations only; nothing to check'],
    ] as const) {
      assert.deepEqual(await run(sys), { code: 0, out: [line], err: [] });
      assert.deepEqual(writes(sys), []);
    }
  });

  it('refuses an issue with no type, saying it has none', async () => {
    const sys = session();
    sys.route('GET', `${ISSUES}/12`, { status: 200, json: { number: 12, url: `${ISSUES}/12`, state: 'open', type: null } });
    assert.deepEqual(await run(sys), { code: 1, out: [], err: ['✗ #12 is not a Slice (its type is none); a State is filed under the slice it is part of'] });
  });

  it("refuses an answer that files no State with an id and a number, saying what GitHub said", async () => {
    for (const [filed, why] of [
      [{ status: 200, json: { id: 9031, number: 31 } }, 'HTTP 200'],
      [{ status: 201, json: null }, 'HTTP 201'],
      [{ status: 201, json: { id: '9031', number: 31 } }, 'HTTP 201'],
      [{ status: 201, json: { id: 9031 } }, 'HTTP 201'],
      [{ status: 422, json: {} }, 'HTTP 422'],
      [{ status: 422, json: { message: '' } }, 'HTTP 422'],
      [{ status: 422, json: { message: 5 } }, 'HTTP 422'],
    ] as const) {
      const sys = session();
      sys.route('POST', FILE, filed);
      assert.deepEqual(await run(sys), { code: 1, out: [], err: [`✗ GitHub did not file the State (${why})`] }, JSON.stringify(filed));
    }
  });

  it("names the State by GitHub's https address for it, or else by its own", async () => {
    for (const [html_url, url] of [
      [`${W}/31#state`, `${W}/31#state`],
      ['http://example.com/31', `${W}/31`],
      [5, `${W}/31`],
      [undefined, `${W}/31`],
    ] as const) {
      const sys = session();
      sys.route('POST', FILE, { status: 201, json: { id: 9031, number: 31, html_url } });
      assert.equal((await run(sys)).out[0], `✓ #31, ${url}: a State under #12`, String(html_url));
    }
  });
});

describe('with two owners and two agents', () => {
  const added = (): ReturnType<typeof graph> => {
    const g = graph();
    g.timeline[0] = { event: 'sub_issue_added', created_at: LATER, sub_issue: { number: 12 } };
    return g;
  };
  const dropped = (g = graph()): ReturnType<typeof graph> => {
    g.states.push({ number: 30, type: { name: 'State' }, state_reason: 'not_planned', closed_at: LATER, comments: [] });
    return g;
  };

  it("takes either owner's approval of the work item, and no one else's", async () => {
    const g = graph();
    g.timeline[1] = { event: 'labeled', created_at: APPROVED, actor: { login: 'second-owner' }, label: { name: 'approved' } };
    assert.deepEqual(await problems(g.issue, [], {}, TEAM), []);
    g.timeline[1] = { event: 'labeled', created_at: APPROVED, actor: { login: AGENT_2 }, label: { name: 'approved' } };
    assert.deepEqual(await problems(g.issue, [], {}, TEAM), [`work item #10, ${W}/10, was labeled approved by OtherBot, not example-owner or Second-Owner`]);
    g.timeline.splice(1, 1);
    assert.deepEqual(await problems(g.issue, [], {}, TEAM), [`work item #10, ${W}/10, is not approved: example-owner or Second-Owner adds the approved label before any slice starts`]);
  });

  it("names both owners and both agents in what a slice added after approval owes", async () => {
    assert.deepEqual(await problems(added().issue, [], {}, TEAM), [
      `#12 was added to work item #10, ${W}/10, after its approval; example-owner or Second-Owner reacts 👍 on ExampleBot or OtherBot's proposal on #12, ${W}/12, or adds a "Decision:" comment naming #12 on ${W}/12, or #12 links example-owner or Second-Owner's request for it on #10; ExampleBot or OtherBot proposes it with: niyam propose 12 --page <page url>`,
    ]);
  });

  it("takes the second owner's Decision: comment, on the work item or the slice", async () => {
    const g = added();
    g.timeline.push(comment('Decision: add #12', LATEST, OWNER_2));
    assert.deepEqual(await problems(g.issue, [], {}, TEAM), []);
    const h = added();
    h.comments.push(comment('Decision: keep it', LATEST, OWNER_2));
    assert.deepEqual(await problems(h.issue, [], {}, TEAM), []);
    // Not an agent's, either one.
    const i = added();
    i.comments.push(comment('Decision: keep it', LATEST, AGENT_2));
    assert.equal((await problems(i.issue, [], {}, TEAM)).length, 1);
  });

  it("takes the second owner's request on the work item, which the slice links", async () => {
    const g = added();
    const request = { ...comment('Please add a slice for the thing', APPROVED, OWNER_2), id: 777 };
    g.timeline.push(request);
    g.issue.body = `${g.issue.body as string}\n\nAsked for in https://github.com/${SLUG}/issues/10#issuecomment-777`;
    assert.deepEqual(await problems(g.issue, [], {}, TEAM), []);
  });

  it("takes either owner's 👍 on either agent's proposal", async () => {
    for (const [agent, owner] of [[AGENT_2, OWNER], [AGENT, OWNER_2], [AGENT_2, 'SECOND-OWNER']] as const) {
      const g = added();
      const made = comment('Proposal: add #12 (Add the thing) to work item #10', LATER, agent);
      g.comments.push(made);
      g.thumbs.set(made.id as string, [thumb(LATEST, owner)]);
      assert.deepEqual(await problems(g.issue, [], {}, TEAM), [], `${owner} on ${agent}'s proposal`);
    }
    const g = added();
    const made = comment('Proposal: add #12', LATER, AGENT_2);
    g.comments.push(made);
    g.thumbs.set(made.id as string, [thumb(LATEST, AGENT)]);
    assert.equal((await problems(g.issue, [], {}, TEAM)).length, 1, "an agent's 👍 does not count");
  });

  it("takes the second owner's Decision: or 👍 on a dropped state", async () => {
    const g = dropped();
    assert.deepEqual(await problems(g.issue, [], {}, TEAM), [
      `state #30, ${W}/30, was closed as not planned after approval; example-owner or Second-Owner reacts 👍 on ExampleBot or OtherBot's proposal for it on #12, ${W}/12, or adds a "Decision:" comment to it; ExampleBot or OtherBot proposes it with: niyam propose 30 --page <page url>`,
    ]);
    g.comments.push(comment('Decision: drop #30', LATEST, OWNER_2));
    assert.deepEqual(await problems(g.issue, [], {}, TEAM), []);
    const h = dropped();
    const made = comment('Proposal: drop state #30 (Empty list)', LATER, AGENT_2);
    h.comments.push(made);
    h.thumbs.set(made.id as string, [thumb(LATEST, OWNER_2)]);
    assert.deepEqual(await problems(h.issue, [], {}, TEAM), []);
  });

  it("holds the second agent's pull request to the work rules, and leaves the second owner's alone", async () => {
    const EVENT = '/tmp/event.json';
    const actions = (login: string, body: string | null): FakeSys => {
      const sys = new FakeSys();
      sys.env = { GITHUB_EVENT_PATH: EVENT, GITHUB_REPOSITORY: SLUG, GH_TOKEN: 'ghs_run' };
      sys.files.set(`${ROOT}/.github/niyam.json`, TEAM_SETTINGS);
      sys.files.set(EVENT, JSON.stringify({ pull_request: { number: 40, body, user: { login }, head: { ref: 'work' } } }));
      github(sys, graph().issue);
      return sys;
    };
    const check = async (sys: FakeSys): Promise<{ code: number; out: string[]; err: string[] }> => {
      const { io, out, err } = capture();
      return { code: await prWorkRules(sys, io), out, err };
    };
    assert.deepEqual(await check(actions(AGENT_2, 'Slice: #12')), { code: 0, out: ['✓ pr-work-rules: #40 builds slice #12, which may be built'], err: [] });
    assert.equal((await check(actions('otherbot', null))).code, 1);
    assert.deepEqual((await check(actions(OWNER_2, null))).out, ['pr-work-rules: #40 is by Second-Owner, not an agent; the work rules bind agent pull requests']);
  });

  it('lets either agent push, and refuses an owner', async () => {
    const push = async (login: string): Promise<{ code: number; err: string[] }> => {
      const sys = new FakeSys();
      sys.files.set(`${ROOT}/.github/niyam.json`, TEAM_SETTINGS);
      sys.env = { NIYAM_AGENT: login, GH_TOKEN: 'ghp_good' };
      sys.execOverride = (call) => (call.args[0] === 'log' ? { code: 0, stdout: 'Slice: #12\n', stderr: '' } : undefined);
      github(sys, graph().issue);
      sys.acceptToken('ghp_good', login);
      const { io, err } = capture();
      return { code: await prePush(sys, io, `refs/heads/work ${'a'.repeat(40)} refs/heads/work ${'b'.repeat(40)}\n`, 'https://github.com/example-org/example-app.git', 'origin'), err };
    };
    assert.deepEqual(await push(AGENT), { code: 0, err: [] });
    assert.deepEqual(await push(AGENT_2), { code: 0, err: [] });
    assert.deepEqual((await push(OWNER_2)).err, [
      '✗ this push would reach GitHub as Second-Owner, not ExampleBot or OtherBot; agent sessions push only as ExampleBot or OtherBot: this session was not given the agent identity, which sends GitHub over HTTPS; tell the owner',
      'pre-push: refused; an agent session pushes to GitHub only as ExampleBot or OtherBot',
    ]);
  });

  it('proposes as the second agent, asking both owners', async () => {
    const sys = new FakeSys();
    sys.files.set(`${ROOT}/.github/niyam.json`, TEAM_SETTINGS);
    sys.env = { NIYAM_AGENT: AGENT_2, GH_TOKEN: 'ghp_good' };
    sys.acceptToken('ghp_good', AGENT_2);
    github(sys, added().issue);
    sys.route('POST', `/repos/${SLUG}/issues/12/comments`, { status: 201, json: { html_url: `https://github.com/${SLUG}/issues/12#issuecomment-9` } });
    sys.route('POST', `/repos/${SLUG}/issues/12/labels`, { status: 200, json: [] });
    const { io, out } = capture();
    assert.equal(await propose(sys, io, [12], 'https://claude.ai/artifact/W48-page'), 0);
    assert.equal(out.at(-1), `#12 is labeled needs-owner, waiting on example-owner or Second-Owner's 👍 on https://github.com/${SLUG}/issues/12#issuecomment-9`);
    const body = (sys.requests.find((r) => r.method === 'POST' && r.url.endsWith('/comments'))?.body as { body: string }).body;
    assert.match(body, /\n\n@example-owner or @Second-Owner: react 👍 to this comment to approve it, or comment "Decision:"\.$/);
    sys.acceptToken('ghp_good', OWNER_2);
    const refused = capture();
    assert.equal(await propose(sys, refused.io, [12]), 1);
    assert.equal(refused.err[0], "✗ propose posts as ExampleBot or OtherBot, but this session's token is Second-Owner");
  });
});
