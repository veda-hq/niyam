import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';
import { parse } from 'yaml';

import { BUILT_IN, Board, COPY_URL, OWNER_TOKEN, URL, repoJson, settledViews } from './fake-board.test.ts';
import { FIELDS, ISSUE_TYPES, LABELS } from './board.ts';
import { AGENT, AGENT_ID, FakeSys, HOME, PULL_URL, RELEASE_SHA256, ROOT, TOKEN, capture, diskWrites, keyOnClipboard } from './fake.test.ts';
import { cloudRepoScript } from './cloud.ts';
import { tarballName } from './names.ts';
import { CLOUD_SETUP_PATH, GUARD_CALLER_PATH, LEFTOVER_CLOUD_SETUP_PATH } from './onboard-pull.ts';
import { CALLER_CHECK, callerAt, callerPins, callerDetail, callerUpdate, callerWhat, guardCaller, pushBranch } from './guard-caller.ts';
import type { HttpResult } from './types.ts';
import { pathsFor, sessionScript } from './agent.ts';
import { FEATURES } from './features.ts';
import { BY_HAND_WIDTH, wrap } from './layout.ts';
import { packageVersion } from './version.ts';
import { GUARD_COMMAND, HOOK_COMMAND, HOOKS_PATH, OLDER_GUARD_COMMANDS, OLDER_READ_ONLY_IF, READ_ONLY_IF, OLDER_HOOK_COMMANDS, OLDER_PRE_PUSH_HOOKS, PRE_PUSH_HOOK, ARTIFACT_RULES, AUTO_FIX_RULES, OLDER_REVIEW_THREAD_RULE, REVIEW_THREAD_RULE, SARATHI_HANDLERS, SARATHI_PATH, SETUP_FIRST, WORKFLOW_PATH, PRODUCT, autoFixRuleNeeds, boardAppSteps, claudeSettings, jobsWithoutLibrary, onboard, onboardArgs, prePushHook, runsSarathiFor, sarathiRunner, workflow, workflowPins, workflowUpdate } from './onboard.ts';
import { BASE_ENV } from './agent.ts';
import {
  BASE_ENV_069,
  CALLER_0720,
  CLOUD_SETUP_068,
  GUARD_COMMAND_052,
  GUARD_COMMAND_0610,
  GUARD_COMMAND_067,
  GUARD_COMMAND_069,
  HOOK_COMMAND_020,
  HOOK_COMMAND_050,
  HOOK_COMMAND_052,
  HOOK_COMMAND_0610,
  HOOK_COMMAND_0616,
  HOOK_COMMAND_067,
  HOOK_COMMAND_069,
  PRE_PUSH_HOOK_050,
  PRE_PUSH_HOOK_052,
  PRE_PUSH_HOOK_0610,
  PRE_PUSH_HOOK_067,
  PRE_PUSH_HOOK_069,
  SETTINGS_068_MONO,
  SETTINGS_068_NIYAM,
  SETTINGS_068_SANDBOX,
  WORKFLOW_068_MONO,
  WORKFLOW_068_NIYAM,
  WORKFLOW_068_SANDBOX,
} from './older-texts.test.ts';
import { actionsKey, sealedValue } from './fake-secrets.test.ts';

const SETTINGS = `${ROOT}/.github/niyam.json`;
const HOOKS = `${ROOT}/${HOOKS_PATH}`;
const WORKFLOW = `${ROOT}/${WORKFLOW_PATH}`;
/** The workflow under its name before P-56, which no release reads since P-57. */
const OLD_WORKFLOW = `${ROOT}/.github/workflows/process-rules.yml`;
/** A workflow as releases before P-56 wrote it: the job ids and the input naming the release say process-rules. */
const oldIds = (text: string): string => text.replace(/^ {2}niyam(-weekly|-merged|-asks)?:$/gm, '  process-rules$1:').replaceAll('      niyam-ref:', '      process-rules-ref:');
/** The workflow onboard writes with every feature on: the Figma secrets on each job, and the board app's on the pull request job. */
const full = (branch: string, version: string, schedule?: string): string => workflow(branch, version, true, schedule, undefined, true);
const PRE_PUSH = `${ROOT}/.git/hooks/pre-push`;
const REPO = '/repos/example-org/example-app';
const COLLABORATOR = `${REPO}/collaborators/ExampleBot`;
const PUSH = { status: 200, json: repoJson() };
const SESSION_ENTRY = { hooks: [{ type: 'command', command: HOOK_COMMAND }] };
const GUARD_ENTRY = { matcher: 'Bash', hooks: [{ type: 'command', command: GUARD_COMMAND }] };
/** The Claude Code settings this release writes into an empty project. */
/** The rules onboard allows, in the order it adds them. */
const ALLOW = [REVIEW_THREAD_RULE, ...AUTO_FIX_RULES, ...ARTIFACT_RULES];
const CLAUDE = { hooks: { SessionStart: [SESSION_ENTRY], PreToolUse: [GUARD_ENTRY] }, env: BASE_ENV, permissions: { allow: ALLOW } };
const VERIFIED = {
  status: 200,
  json: { committer: { login: AGENT }, commit: { verification: { verified: true, reason: 'valid' } } },
};

/** A Mac set up for the agent, a client repo with nothing in it yet, the agent able to push, yes to everything. */
function fresh(): FakeSys {
  const sys = new FakeSys().ready();
  sys.files.delete(SETTINGS);
  sys.route('GET', '/users/example-owner', { status: 200, json: { id: 1, login: 'example-owner' } });
  sys.route('GET', '/users/example-org', { status: 200, json: { login: 'example-org', type: 'Organization' } });
  sys.route('GET', REPO, PUSH);
  sys.route('GET', `${REPO}/commits/abc123`, VERIFIED);
  // An organisation with no issue types yet, so the owner signs in after the plan; GitHub's defaults have their own tests.
  new Board(sys).issueTypes = [];
  // Settings, hook, workflow, pre-push hook; issue types, labels, Project; test commit; and spares.
  sys.answers = Array<string>(12).fill('y');
  return sys;
}

/** The checkout's files, git's own folder aside. */
function checkout(sys: FakeSys): Map<string, string> {
  return new Map([...sys.files].filter(([path]) => path.startsWith(`${ROOT}/`) && !path.startsWith(`${ROOT}/.git/`)));
}

/** The repository's files as onboard's pull request leaves them: what it committed, else what the checkout has. */
function repo(sys: FakeSys): { get(path: string): string | undefined; has(path: string): boolean } {
  const get = (path: string): string | undefined => (sys.deleted.has(path.slice(ROOT.length + 1)) ? undefined : (sys.committed.get(path.slice(ROOT.length + 1)) ?? sys.files.get(path)));
  return { get, has: (path) => get(path) !== undefined };
}

/** As when the owner merges onboard's pull request: what it committed is now in the checkout. */
function merge(sys: FakeSys): void {
  for (const [path, text] of sys.committed) sys.files.set(`${ROOT}/${path}`, text);
  for (const path of sys.deleted) sys.files.delete(`${ROOT}/${path}`);
  sys.committed.clear();
  sys.deleted.clear();
}

/** How many times onboard had the owner sign in in the browser. */
function signIns(sys: FakeSys): number {
  return sys.calls.filter((call) => call.command === 'gh' && call.args[1] === 'login').length;
}

/** Runs onboard, checking it leaves the checkout as it found it. */
async function run(sys: FakeSys, named: string[] = ['example-owner', AGENT]): Promise<{ code: number; out: string[]; err: string[] }> {
  const { io, out, err } = capture();
  const before = checkout(sys);
  const code = await onboard(sys, io, named);
  assert.deepEqual(checkout(sys), before, "onboard changed the owner's checkout");
  return { code, out, err };
}

/** The plan's items under the group whose title starts with `title`: "label: detail", or the label alone. */
/** The repo's cloud setup file, as this release writes it. */
const CLOUD = `${ROOT}/${CLOUD_SETUP_PATH}`;
/** The same under its name before P-56, which releases up to 0.6.10 wrote alike, and onboard deletes since P-57. */
const OLD_CLOUD = `${ROOT}/${LEFTOVER_CLOUD_SETUP_PATH}`;
const CLOUD_FILE = cloudRepoScript(packageVersion(), RELEASE_SHA256);
/** The shared Guard's caller (#470), as this release writes it for a default branch of main. */
const CALLER = `${ROOT}/${GUARD_CALLER_PATH}`;
const CALLER_FILE = guardCaller('main', packageVersion());

function planned(out: string[], title: string): string[] {
  const start = out.findIndex((line) => line.startsWith(`◇  ${title}`));
  if (start === -1) return [];
  const items: string[] = [];
  for (const line of out.slice(start + 1)) {
    const item = /^│ {4}(\S.*)$/.exec(line)?.[1];
    if (item === undefined) break;
    const [label, detail] = item.split(/ {2,}/);
    items.push(detail ? `${label}: ${detail}` : (label as string));
  }
  return items;
}

/** What the run left to do by hand, as it printed it last: each numbered step, its wrapped lines joined again. */
function byHand(out: string[]): string[] {
  const start = out.lastIndexOf('◇  By hand');
  if (start === -1) return [];
  const steps: string[] = [];
  for (const line of out.slice(start + 1)) {
    if (!line.startsWith('│')) break;
    const numbered = /^│ {4}\d+\. (.*)$/.exec(line)?.[1];
    if (numbered !== undefined) steps.push(numbered);
    else if (line.trim() !== '│') steps[steps.length - 1] += ` ${line.slice(1).trim()}`;
  }
  return steps;
}

/** The title and description of the pull request onboard opened, if it opened one. */
function opened(sys: FakeSys): { title: string; body: string } | undefined {
  const pull = sys.requests.find((r) => r.method === 'POST' && r.url.endsWith(`${REPO}/pulls`));
  return pull?.body as { title: string; body: string } | undefined;
}

/** Whether onboard changed anything outside the checkout: a write to GitHub, a push, a sign-in or a hook. */
function changedNothing(sys: FakeSys): boolean {
  const writes = sys.requests.filter((r) => r.method !== 'GET' && !(r.method === 'POST' && r.url.endsWith('/graphql') && /^\s*query/.test((r.body as { query?: string } | undefined)?.query ?? '')));
  return writes.length === 0 && !sys.calls.some((c) => c.command === 'git' && c.args[0] === 'push') && signIns(sys) === 0 && !sys.files.has(PRE_PUSH);
}

/**
 * The review routine step's last lines, from its link on: where the link's
 * release breaks the line moves with the version's length (v0.7.9, v0.7.10),
 * so they are wrapped as byHandLines wraps a step's second line on.
 */
const reviewTail = (v: string): string[] =>
  wrap(`https://github.com/veda-hq/niyam/blob/v${v}/routines/review.md; skip it if done.`, BY_HAND_WIDTH - 1 - '    2. '.length).map((line) => `│       ${line}`);

describe('onboard', () => {
  it("opens the files as the agent's pull request, finds the agent can push, and proves a Verified commit", async () => {
    const sys = fresh();
    const { code, out, err } = await run(sys);
    assert.deepEqual(err, []);
    assert.equal(code, 0);
    assert.deepEqual(JSON.parse(repo(sys).get(SETTINGS) ?? ''), { owner: 'example-owner', agent: 'ExampleBot', features: [...FEATURES] });
    assert.deepEqual(JSON.parse(repo(sys).get(HOOKS) ?? ''), CLAUDE);
    assert.equal(repo(sys).get(WORKFLOW), full('main', packageVersion()));
    assert.equal(repo(sys).get(CALLER), CALLER_FILE);
    assert.equal(sys.files.get(PRE_PUSH), PRE_PUSH_HOOK);
    assert.equal(sys.modes.get(PRE_PUSH), 0o755);
    assert.deepEqual(sys.dirs.filter((d) => d.startsWith(ROOT)), [], 'no folder made in the checkout');
    const v = packageVersion();
    assert.deepEqual(out, [
      `◆  niyam onboard   v${v}`,
      '│  example-org/example-app · owner example-owner · agent ExampleBot',
      '│',
      '◇  Pull request',
      `│    niyam.json      new, ${FEATURES.length} features on`,
      '│    settings.json   new',
      '│    workflow        new',
      `│    guard caller    new, the shared Guard at v${v}`,
      `│    cloud-setup.sh  new, installs v${packageVersion()}`,
      '│    auto-merge      when checks pass',
      '│',
      '◇  GitHub — one sign-in as example-owner',
      // GitHub lists the agent no secrets here; the organisation has its board app, which onboard shares with no click.
      '│    board app    two clicks in the browser, if it is new',
      '│    board        set up or check',
      '│    issue types  org-wide: add 5',
      '│      add        Work item, Slice, State, Decision, Brief',
      '│',
      '◇  This Mac',
      '│    pre-push hook  new',
      '│',
      '◇  Claude cloud — by hand, once per claude.ai account',
      "│    claude.ai's GitHub  as ExampleBot",
      '│',
      '◇  Check',
      '│    one signed test commit by ExampleBot, deleted after',
      '│',
      '◇  Sign in to GitHub as example-owner, for this run only: repo, project, admin:org',
      '│  one-time code 1881-F156 (copied)',
      '│  approve it at https://github.com/login/device',
      '◇  Signed in as example-owner',
      '◇  board app',
      '◇  board',
      '◇  pre-push hook',
      '◇  test commit Verified as ExampleBot',
      '◇  pull request',
      '│',
      '◇  By hand',
      // A copy of the template has no Auto-add to project, which names a repository.
      '│    1. Once for the board: at',
      `│       ${COPY_URL}/workflows, add the`,
      '│       workflow Auto-add to project, for the repository example-org/example-app',
      "│       with the filter is:issue is:open, which GitHub's API cannot; then niyam",
      '│       board-audit lists the open issues still not on the board.',
      '│',
      '│    2. Once for example-org/example-app: in Claude Code, run /schedule and',
      "│       create a weekly routine on it, with claude.ai's GitHub connected as",
      '│       ExampleBot and the prompt below the line in',
      // GitHub lists no verdict by the agent here, so the routine may not run yet.
      ...reviewTail(v),
      '│',
      '│    3. Once per claude.ai account: sign in at https://claude.ai/code and',
      '│       connect GitHub as ExampleBot (or change it at',
      '│       https://claude.ai/customize/connectors); skip it if done.',
      '│',
      `└  ${PULL_URL}  merges itself when checks pass`,
    ]);
    assert.ok(out.every((line) => line.length <= 80 || !line.startsWith('│ ')), 'every by-hand line fits 80 columns');
    assert.deepEqual(sys.chosen, ['Go ahead?'], 'one question');
    assert.deepEqual(sys.opened, ['https://github.com/login/device'], 'the browser opens at the sign-in');
    assert.equal(sys.spinning, 0, 'every spinner stopped');
    assert.deepEqual(sys.spun, ['board app', 'board', 'pre-push hook', 'test commit Verified as ExampleBot', 'pull request']);
    const git = sys.calls.filter((c) => c.command === 'git' && c.env);
    assert.deepEqual(git.map((c) => c.args.slice(0, 2).join(' ')), [
      'ls-remote https://github.com/example-org/example-app.git',
      'init -q',
      'fetch -q',
      'commit-tree -S',
      'push -q',
      'push -q',
      // The pull request's commit, in a temporary repository: never the checkout.
      'init -q',
      'fetch -q',
      'read-tree FETCH_HEAD',
      ...['settings', 'hooks', 'cloud setup', 'workflow', 'guard caller'].flatMap(() => ['rev-parse --verify', 'hash-object -w', 'update-index --add']),
      'write-tree --missing-ok',
      'commit-tree -S',
      'push -q',
    ]);
    assert.ok(git.every((c) => c.env?.GH_TOKEN === TOKEN && c.env.GIT_COMMITTER_EMAIL === '42+ExampleBot@users.noreply.github.com'), 'every git step as the agent');
    assert.ok(git.slice(6).every((c) => c.cwd === '/tmp/niyam-2'), 'the pull request is made in a temporary repository');
    assert.deepEqual(git.at(-1)?.args, ['push', '-q', 'https://github.com/example-org/example-app.git', '+abc123:refs/heads/niyam/onboard']);
    assert.ok(sys.removed.includes('/tmp/niyam-2'), 'the temporary repository is deleted');
    assert.deepEqual([...sys.committed.keys()], ['.github/niyam.json', '.claude/settings.json', CLOUD_SETUP_PATH, '.github/workflows/niyam.yml', GUARD_CALLER_PATH]);
    assert.deepEqual([...sys.deleted], [], 'nothing to move in a fresh repo');
    assert.equal(sys.committed.get(CLOUD_SETUP_PATH), cloudRepoScript(v, RELEASE_SHA256), 'the cloud setup file, at the pin, checked against the release');
    assert.equal(sys.committed.has(LEFTOVER_CLOUD_SETUP_PATH), false, 'not under its name before P-56 (P-57)');
    const pull = sys.requests.find((r) => r.method === 'POST' && r.url.endsWith(`${REPO}/pulls`));
    assert.equal(pull?.token, TOKEN, 'the agent opens the pull request');
    const { title, head, base, body } = pull?.body as { title: string; head: string; base: string; body: string };
    assert.deepEqual([title, head, base], [`chore(niyam): onboard at v${v}`, 'niyam/onboard', 'main']);
    assert.deepEqual(git.at(-2)?.args.slice(-2), ['-m', `chore(niyam): onboard at v${v}`], 'the commit header is the title');
    assert.match(body, /^- `\.github\/niyam\.json`: owner example-owner approves, agent ExampleBot builds, with identity, .* on$/m);
    assert.match(body, /^- `\.github\/workflows\/niyam\.yml`: write \.github\/workflows\/niyam\.yml, which runs the shared niyam checks$/m);
    assert.ok(
      body.includes(
        `\n- \`${GUARD_CALLER_PATH}\`: write ${GUARD_CALLER_PATH}, the shared Guard's caller: on each pull request to main it runs veda-hq/niyam's Guard at v${v}, the release ${WORKFLOW_PATH} pins, as the check niyam-guard / judge, and does nothing else\n`,
      ),
      body,
    );
    assert.ok(!body.includes('pull_request_target'), 'a repository GitHub does not call public is asked for no policy');
    // The long explanations the terminal no longer prints.
    assert.ok(
      body.includes(
        "\nDone at the terminal, outside this pull request:\n\n- board app:\n  - example-org's board app secrets shared with example-org/example-app\n  - example-org's board app installed on example-org/example-app\n- board:\n  - issue types in example-org: Work item, Slice, State, Decision, Brief\n",
      ),
      body,
    );
    assert.ok(body.includes(`\n  - Project "example-app work": ${COPY_URL}\n  - fields: Step, Decision, Review date\n`), body);
    assert.ok(body.includes('\n- pre-push hook:\n  - wrote the pre-push git hook .git/hooks/pre-push, which checks an agent session pushes to GitHub as the agent, and the work rules\n'), body);
    assert.ok(body.includes('\n  - committer: ExampleBot; verified: true (valid)\n  - GitHub shows the test commit Verified by ExampleBot\n'), body);
    assert.ok(body.includes(`\nLeft to do by hand:\n\n- Once for the board: at ${COPY_URL}/workflows, add the workflow Auto-add to project, for the repository example-org/example-app with the filter is:issue is:open, which GitHub's API cannot; then niyam board-audit lists the open issues still not on the board.\n- The review routine: create a weekly Claude routine on example-org/example-app`), body);
    assert.ok(
      body.includes(
        `\n- Claude cloud sessions, once per claude.ai account: connect claude.ai's GitHub as ExampleBot. Each session with no niyam installs it from ${CLOUD_SETUP_PATH}, which onboard keeps at the pin, so there is nothing to paste; what niyam cloud-setup prints, put in the cloud environment's Setup script, makes sessions start faster, since Claude caches what a Setup script installs.\n`,
      ),
      body,
    );
    assert.ok(body.includes(`\n- \`${CLOUD_SETUP_PATH}\`: installs niyam ${packageVersion()} in Claude cloud sessions, its download checked against its sha256\n`), body);
    assert.ok(!body.includes('Finish the Project'), 'a copy of the template leaves nothing to do by hand');
    assert.deepEqual(sys.calls.filter((c) => c.command === 'rm').at(-1)?.args, ['-rf', '/tmp/verify']);
    const reads = sys.requests.filter((r) => r.url === `https://api.github.com${REPO}`);
    assert.equal(reads[0]?.token, TOKEN, 'checks access as the agent');
  });

  const TRACE = `${REPO}/issues/comments?since=2026-10-09T12:00:00.000Z&sort=created&direction=desc&per_page=100&page=1`;

  it('leaves the review routine off the by-hand steps once the agent has given a verdict on the repository', async () => {
    const sys = fresh();
    sys.route('GET', TRACE, {
      status: 200,
      json: [{ body: 'Held for example-owner: it spends money', user: { login: 'examplebot' }, issue_url: `https://api.github.com${REPO}/issues/3045`, created_at: '2026-10-27T06:00:00Z' }],
    });
    const { code, out } = await run(sys);
    assert.equal(code, 0);
    assert.ok(!out.some((line) => line.includes('/schedule') || line.includes('routines/review.md')), out.join('\n'));
    assert.ok(out.includes('│    2. Once per claude.ai account: sign in at https://claude.ai/code and'), out.join('\n'));
    const pull = sys.requests.find((r) => r.method === 'POST' && r.url.endsWith(`${REPO}/pulls`));
    const { body } = pull?.body as { body: string };
    assert.ok(!body.includes('The review routine'), body);
    const from = body.indexOf('Done at the terminal');
    const to = body.indexOf('Left to do by hand');
    assert.ok(from !== -1 && to > from, body);
    assert.ok(body.slice(from, to).includes('\n- review routine: ExampleBot gave a verdict on #3045 on 2026-10-27, so it runs\n'), body);
  });

  it('leaves the review routine by hand when GitHub cannot list the comments', async () => {
    const sys = fresh();
    sys.route('GET', TRACE, () => {
      throw new Error('fetch failed');
    });
    const { code, out } = await run(sys);
    assert.equal(code, 0);
    assert.ok(reviewTail(packageVersion()).every((line) => out.includes(line)), out.join('\n'));
    const pull = sys.requests.find((r) => r.method === 'POST' && r.url.endsWith(`${REPO}/pulls`));
    const { body } = pull?.body as { body: string };
    assert.ok(body.includes('\n- The review routine: create a weekly Claude routine on example-org/example-app'), body);
    assert.ok(!body.includes('- review routine:'), body);
  });

  it("uses GitHub's spelling of logins typed in another case", async () => {
    const sys = fresh();
    sys.route('GET', '/users/EXAMPLE-OWNER', { status: 200, json: { id: 1, login: 'example-owner' } });
    assert.equal((await run(sys, ['EXAMPLE-OWNER', 'examplebot'])).code, 0);
    assert.match(repo(sys).get(SETTINGS) ?? '', /"owner": "example-owner",\n {2}"agent": "ExampleBot"/);
  });

  it('reads the accounts from existing settings, and skips what is done', async () => {
    const sys = fresh();
    sys.files.set(SETTINGS, JSON.stringify({ owner: 'example-owner', agent: AGENT }));
    sys.files.set(HOOKS, JSON.stringify(CLAUDE));
    sys.files.set(WORKFLOW, full('main', packageVersion()));
    sys.files.set(PRE_PUSH, PRE_PUSH_HOOK);
    sys.files.set(CLOUD, CLOUD_FILE).set(CALLER, CALLER_FILE);
    const board = new Board(sys);
    board.issueTypes = ISSUE_TYPES.map((t) => t.name);
    board.labels = LABELS.map((l) => l.name);
    board.project = { fields: [...BUILT_IN, ...FIELDS.map((f) => f.name)], linked: true, views: settledViews(), grouped: true };
    // The organisation's board app secrets are shared with the repository already.
    sys.route('GET', `${REPO}/actions/secrets?per_page=100&page=1`, { status: 200, json: { secrets: [] } });
    sys.route('GET', `${REPO}/actions/organization-secrets?per_page=100&page=1`, { status: 200, json: { secrets: [{ name: 'NIYAM_BOARD_APP_ID' }, { name: 'NIYAM_BOARD_APP_KEY' }] } });
    const { code, out } = await run(sys, []);
    assert.equal(code, 0);
    assert.deepEqual(sys.chosen, ['Go ahead?']);
    assert.deepEqual(planned(out, 'Pull request'), [], 'no file to change');
    assert.deepEqual(planned(out, 'This Mac'), [], 'the pre-push hook is there');
    assert.deepEqual(planned(out, 'Claude cloud — by hand, once'), [], 'the cloud setup file is there, so the account was connected before');
    assert.deepEqual(planned(out, 'GitHub'), ['board: set up or check', 'issue types: org-wide, the work model’s alone']);
    assert.ok(!sys.requests.some((r) => r.url.endsWith('/pulls')), 'nothing to change, no pull request');
    assert.ok(!sys.calls.some((c) => c.args[0] === 'read-tree'));
    assert.ok(out.includes('└  Done; no file changes, so no pull request.'), out.join('\n'));
  });

  it('deletes the cloud setup file under its name before P-56, which 0.6.10 wrote alike, and then changes nothing (P-57)', async () => {
    const sys = fresh();
    sys.files.set(SETTINGS, JSON.stringify({ owner: 'example-owner', agent: AGENT }));
    sys.files.set(HOOKS, JSON.stringify(CLAUDE));
    sys.files.set(WORKFLOW, full('main', packageVersion()));
    sys.files.set(CLOUD, CLOUD_FILE).set(OLD_CLOUD, CLOUD_FILE).set(CALLER, CALLER_FILE);
    sys.files.set(PRE_PUSH, PRE_PUSH_HOOK);
    const board = new Board(sys);
    board.issueTypes = ISSUE_TYPES.map((t) => t.name);
    board.labels = LABELS.map((l) => l.name);
    board.project = { fields: [...BUILT_IN, ...FIELDS.map((f) => f.name)], linked: true, views: settledViews(), grouped: true };
    const { code, out, err } = await run(sys, []);
    assert.deepEqual(err, []);
    assert.equal(code, 0);
    assert.deepEqual(planned(out, 'Pull request'), ['cloud-setup.sh: process-rules/cloud-setup.sh deleted', 'auto-merge: when checks pass']);
    assert.deepEqual([...sys.deleted], [LEFTOVER_CLOUD_SETUP_PATH]);
    assert.deepEqual([...sys.committed.keys()], []);
    const body = opened(sys)?.body ?? '';
    assert.ok(body.includes(`\n- \`${LEFTOVER_CLOUD_SETUP_PATH}\`: moved to ${CLOUD_SETUP_PATH}, which the Setup snippet since 0.6.10 runs\n`), body);
    assert.ok(body.includes(`a Setup script pasted before niyam 0.6.10 runs ${LEFTOVER_CLOUD_SETUP_PATH}, which this pull request deletes; if yours is one, delete niyam's part of it, since sessions now install niyam themselves, or paste what niyam cloud-setup prints over it. If the repo has its own Setup script, put this first, then the repo's own: a repo's script may end with exit, and nothing after that runs.`), body);
    merge(sys);
    const again = await run(sys, []);
    assert.equal(again.code, 0);
    assert.deepEqual(planned(again.out, 'Pull request'), [], 'a run again is a no-op');
    assert.ok(again.out.includes('└  Done; no file changes, so no pull request.'), again.out.join('\n'));
  });

  it('writes the new cloud setup file beside one only under its name before P-56, deleting that, and asks for the one paste (P-57)', async () => {
    const sys = fresh();
    sys.files.set(OLD_CLOUD, CLOUD_SETUP_068);
    const { code, out } = await run(sys);
    assert.equal(code, 0);
    assert.ok(planned(out, 'Pull request').includes(`cloud-setup.sh: new, installs v${packageVersion()}, process-rules/cloud-setup.sh deleted`), out.join('\n'));
    assert.equal(repo(sys).get(CLOUD), CLOUD_FILE);
    assert.equal(repo(sys).has(OLD_CLOUD), false);
    assert.ok(byHand(out).includes('Once per claude.ai account: sign in at https://claude.ai/code and connect GitHub as ExampleBot (or change it at https://claude.ai/customize/connectors); skip it if done.'), out.join('\n'));
  });

  it('reads nothing from the settings file and workflow before niyam, and leaves them where they are (P-57)', async () => {
    const sys = fresh();
    sys.files.delete(SETTINGS);
    sys.files.set(`${ROOT}/.github/process-rules.json`, SETTINGS_068_NIYAM);
    sys.files.set(OLD_WORKFLOW, WORKFLOW_068_NIYAM);
    const { code, out } = await run(sys);
    assert.equal(code, 0);
    assert.ok(planned(out, 'Pull request').some((line) => line.startsWith('niyam.json: new')), out.join('\n'));
    assert.ok(planned(out, 'Pull request').includes('workflow: new'), out.join('\n'));
    assert.deepEqual([...sys.deleted], []);
    assert.equal(sys.files.get(OLD_WORKFLOW), WORKFLOW_068_NIYAM);
  });

  describe('issue types outside the work model', () => {
    const settled = (): { sys: FakeSys; board: Board } => {
      const sys = fresh();
      sys.files.set(SETTINGS, JSON.stringify({ owner: 'example-owner', agent: AGENT }));
      sys.files.set(HOOKS, JSON.stringify(CLAUDE));
      sys.files.set(WORKFLOW, workflow('main', packageVersion(), true));
      sys.files.set(PRE_PUSH, PRE_PUSH_HOOK);
      sys.files.set(CLOUD, CLOUD_FILE);
      const board = new Board(sys);
      board.issueTypes = [...ISSUE_TYPES.map((t) => t.name), 'Task'];
      board.labels = LABELS.map((l) => l.name);
      board.project = { fields: [...BUILT_IN, ...FIELDS.map((f) => f.name)], linked: true, views: settledViews(), grouped: true };
      board.issues = [{ repo: 'example-org/example-app', number: 12, type: 'Task' }];
      return { sys, board };
    };

    it('shows the issues it retypes and the types it disables in the one plan, then does it as the owner', async () => {
      const { sys, board } = settled();
      const { code, out } = await run(sys, []);
      assert.equal(code, 0);
      assert.deepEqual(sys.chosen, ['Go ahead?']);
      const at = out.findIndex((line) => line.startsWith('│    issue types '));
      assert.deepEqual(out.slice(at - 1, at + 3), [
        '│    board             set up or check',
        '│    issue types       org-wide: retype 1, disable 1',
        '│      example-app#12  Task → Brief',
        '│      disable         Task',
      ]);
      assert.equal(board.issues[0]?.type, 'Brief');
      assert.deepEqual(board.disabledTypes, ['Task']);
      const before = sys.requests.findIndex((r) => r.method === 'PATCH');
      assert.ok(sys.requests.slice(0, before).some((r) => r.url.includes('/issues?type=Task') && r.token === TOKEN), 'the plan reads as the agent');
      assert.ok(sys.requests.filter((r) => r.method === 'PATCH' || r.method === 'PUT').every((r) => r.token === OWNER_TOKEN), 'the owner changes them');
    });

    it('shows the owner the issues only the owner can see, signing in before the plan', async () => {
      const { sys, board } = settled();
      board.orgRepos = [{ full_name: 'example-org/example-app' }, { full_name: 'example-org/hidden' }];
      board.issues.push({ repo: 'example-org/hidden', number: 3, type: 'Task' });
      // The agent sees only example-app.
      sys.route('GET', '/orgs/example-org/repos?type=all&per_page=100&page=1', () =>
        sys.requests.at(-1)?.token === OWNER_TOKEN ? { status: 200, json: board.orgRepos } : { status: 200, json: [{ full_name: 'example-org/example-app' }] },
      );
      const { code, out } = await run(sys, []);
      assert.equal(code, 0);
      const signed = out.findIndex((line) => line.startsWith('◇  Signed in as example-owner'));
      const plan = out.findIndex((line) => line.startsWith('◇  GitHub — signed in as example-owner'));
      assert.ok(signed !== -1 && signed < plan, out.join('\n'));
      assert.ok(out.includes('│      hidden#3        Task → Brief'), out.join('\n'));
      assert.deepEqual(board.issues.map((issue) => issue.type), ['Brief', 'Brief']);
    });

    it('types open issues with no type in the one plan, signing in before it, with no other type to disable', async () => {
      const { sys, board } = settled();
      board.issueTypes = ISSUE_TYPES.map((t) => t.name);
      board.issues = [
        { repo: 'example-org/example-app', number: 20, type: 'Work item', subIssues: 2 },
        { repo: 'example-org/example-app', number: 21, type: null, parent: 20 },
        { repo: 'example-org/example-app', number: 22, type: null, parent: 20 },
        { repo: 'example-org/example-app', number: 30, type: null },
      ];
      const { code, out } = await run(sys, []);
      assert.equal(code, 0);
      const at = out.findIndex((line) => line.startsWith('│    issue types '));
      assert.deepEqual(out.slice(at, at + 4), [
        '│    issue types           org-wide: type 3',
        '│      example-app#21–#22  no type → Slice: its parent #20 is a Work item',
        '│      example-app#30      no type → Brief: it has no parent and no sub-issues',
        '│      closed, no type     left as they are',
      ]);
      const signed = out.findIndex((line) => line.startsWith('◇  Signed in as example-owner'));
      assert.ok(signed !== -1 && signed < at, out.join('\n'));
      assert.deepEqual(board.issues.map((issue) => issue.type), ['Work item', 'Slice', 'Slice', 'Brief']);
    });

    it('goes through for a disabled type, which GitHub lists no issues by, signing in before the plan, and says so in it', async () => {
      const { sys, board } = settled();
      board.disabledTypes = ['Task'];
      board.issues = [];
      const { code, out } = await run(sys, []);
      assert.equal(code, 0, out.join('\n'));
      const at = out.findIndex((line) => line.startsWith('│    issue types '));
      assert.deepEqual(out.slice(at, at + 2), [
        '│    issue types  org-wide, the work model’s alone',
        '│      disabled   Task: GitHub lists no issues by a disabled type, so onboard cannot tell whether any holds one',
      ]);
      // The agent cannot see every repository, so the owner, whose sign-in the board step needs anyway, reads them first.
      const signed = out.findIndex((line) => line.startsWith('◇  Signed in as example-owner'));
      assert.ok(signed !== -1 && signed < at, out.join('\n'));
      assert.deepEqual(board.disabledTypes, ['Task']);
    });

    it('lists, in the dry run, what the agent sees, signing in to nothing', async () => {
      const { sys, board } = settled();
      const { code, out } = await run(sys, ['example-owner', AGENT, '--dry-run']);
      assert.equal(code, 0);
      assert.ok(out.includes('│      example-app#12  Task → Brief'), out.join('\n'));
      assert.ok(!sys.requests.some((r) => r.token === OWNER_TOKEN));
      assert.equal(board.issues[0]?.type, 'Task');
    });

    it('stops before the plan when the owner does not sign in', async () => {
      const { sys, board } = settled();
      sys.ghToken = undefined;
      const { code, err } = await run(sys, []);
      assert.equal(code, 1);
      assert.deepEqual(err, ['onboard: the GitHub sign-in in the browser did not finish']);
      assert.deepEqual(sys.chosen, [], 'no plan was asked about');
      assert.equal(board.issues[0]?.type, 'Task');
    });

    it('says it reads them once signed in when the agent cannot', async () => {
      const { sys, board } = settled();
      const types = sys.routes.get('GET https://api.github.com/orgs/example-org/issue-types?per_page=100&page=1') as () => HttpResult;
      sys.route('GET', '/orgs/example-org/issue-types?per_page=100&page=1', () => (sys.requests.at(-1)?.token === OWNER_TOKEN ? types() : { status: 403, json: null }));
      const { code, out } = await run(sys, ['example-owner', AGENT, '--dry-run']);
      assert.equal(code, 0);
      assert.ok(out.some((line) => /^│ {4}issue types {2,}org-wide, read once signed in$/.test(line)), out.join('\n'));
      assert.equal(board.issues[0]?.type, 'Task');
    });

    it('reads them as the owner before the plan when the agent cannot, and says why in the pull request', async () => {
      const { sys } = settled();
      const types = sys.routes.get('GET https://api.github.com/orgs/example-org/issue-types?per_page=100&page=1') as () => HttpResult;
      sys.route('GET', '/orgs/example-org/issue-types?per_page=100&page=1', () => (sys.requests.at(-1)?.token === OWNER_TOKEN ? types() : { status: 403, json: null }));
      const { code, out } = await run(sys, []);
      assert.equal(code, 0, out.join('\n'));
      assert.ok(out.includes('│      example-app#12  Task → Brief'), out.join('\n'));
      assert.ok(!out.some((line) => line.includes('read once signed in')), out.join('\n'));
      assert.match(
        opened(sys)?.body ?? '',
        /^- onboard signed in before showing its plan: the organisation has issue types outside the work model or open issues with no type, and only the owner sees every repository that holds them\.$/m,
      );
    });

    it('takes a Project title that is not text as none', async () => {
      const { sys } = settled();
      sys.files.set(SETTINGS, JSON.stringify({ owner: 'example-owner', agent: AGENT, project: 7 }));
      const { code, err } = await run(sys, []);
      assert.deepEqual({ code, err }, { code: 0, err: [] });
    });
  });

  it('keeps the cloud setup file at the pin, asking for the Setup script paste only the first time', async () => {
    const settled = (sys: FakeSys): void => {
      sys.files.set(SETTINGS, JSON.stringify({ owner: 'example-owner', agent: AGENT, features: ['identity'] }));
      sys.files.set(HOOKS, JSON.stringify(CLAUDE));
      sys.files.set(PRE_PUSH, PRE_PUSH_HOOK);
      // The shared Guard's caller, which onboard writes whatever the features (#485).
      sys.files.set(CALLER, guardCaller('main', packageVersion()));
    };
    const older = fresh();
    settled(older);
    older.files.set(CLOUD, cloudRepoScript('0.5.2', 'cd'.repeat(32)));
    const upgraded = await run(older, []);
    assert.equal(upgraded.code, 0);
    assert.deepEqual(planned(upgraded.out, 'Pull request'), [`cloud-setup.sh: v0.5.2 → v${packageVersion()}`, 'auto-merge: when checks pass']);
    assert.deepEqual(planned(upgraded.out, 'Claude cloud — by hand, once'), [], 'onboarded before: nothing by hand');
    assert.deepEqual(byHand(upgraded.out), []);
    assert.match(opened(older)?.body ?? '', /\n- test commit Verified as ExampleBot:\n(?: {2}- .*\n)+\n\nMerge it to finish onboarding;/, 'nothing left by hand: no list of it');
    assert.equal(older.committed.get(CLOUD_SETUP_PATH), CLOUD_FILE);

    const edited = fresh();
    settled(edited);
    edited.files.set(CLOUD, `${CLOUD_FILE}echo ours\n`);
    assert.deepEqual(planned((await run(edited, [])).out, 'Pull request'), ['cloud-setup.sh: written again', 'auto-merge: when checks pass']);
    assert.equal(edited.committed.get(CLOUD_SETUP_PATH), CLOUD_FILE);

    const unreleased = fresh();
    settled(unreleased);
    unreleased.route('GET', `/repos/veda-hq/niyam/releases/tags/v${packageVersion()}`, { status: 404, json: { message: 'Not Found' } });
    const left = await run(unreleased, []);
    assert.equal(left.code, 0);
    assert.ok(left.out.includes(`│  ! ${CLOUD_SETUP_PATH} left as it is: GitHub answered HTTP 404 for the v${packageVersion()} release`), left.out.join('\n'));
    assert.deepEqual(planned(left.out, 'Pull request'), []);
    assert.deepEqual(planned(left.out, 'Claude cloud — by hand, once'), [], 'onboarded before: nothing by hand');

    const undigested = fresh();
    settled(undigested);
    undigested.route('GET', `/repos/veda-hq/niyam/releases/tags/v${packageVersion()}`, { status: 200, json: { assets: [{ name: `${tarballName(packageVersion())}`, digest: null }] } });
    assert.ok((await run(undigested, ['--dry-run'])).out.includes(`│  ! ${CLOUD_SETUP_PATH} left as it is: the v${packageVersion()} release names no sha256 for ${tarballName(packageVersion())}`));

    const down = fresh();
    settled(down);
    const http = down.http.bind(down);
    down.http = (url, options) => (url.includes('/releases/tags/') ? Promise.reject(new Error('GET api.github.com/repos could not be made: ECONNRESET')) : http(url, options));
    assert.ok(
      (await run(down, ['--dry-run'])).out.includes(
        `│  ! ${CLOUD_SETUP_PATH} left as it is: GitHub could not be asked for the v${packageVersion()} release (GET api.github.com/repos could not be made: ECONNRESET)`,
      ),
    );
  });

  it('leaves CODEOWNERS as it is, naming the owner or not, and asks nothing about it', async () => {
    for (const [path, text] of [
      ['.github/CODEOWNERS', '# Owners\n* @example-owner\n/app/ @example-org/core @EXAMPLE-OWNER # app team\n'],
      ['CODEOWNERS', '* @example-org/core\n'],
    ] as const) {
      const sys = fresh();
      sys.files.set(`${ROOT}/${path}`, text);
      const { code, out, err } = await run(sys);
      assert.equal(code, 0, err.join('\n'));
      assert.ok(!sys.committed.has(path), 'the pull request leaves it out');
      assert.equal(repo(sys).get(`${ROOT}/${path}`), text);
      assert.ok(![...out, ...err, ...sys.asked, ...sys.chosen, opened(sys)?.body ?? ''].some((line) => line.includes('CODEOWNERS')), 'nothing says anything about it');
    }
  });

  describe('with settings listing two owners and two agents', () => {
    const TEAM = { owner: ['example-owner', 'Second-Owner'], agent: ['OtherBot', AGENT], features: [...FEATURES] };
    const team = (): FakeSys => {
      const sys = fresh();
      sys.files.set(SETTINGS, `${JSON.stringify(TEAM, null, 2)}\n`);
      sys.files.set(pathsFor(HOME, AGENT).session, sessionScript(AGENT, AGENT_ID, pathsFor(HOME, AGENT)));
      return sys;
    };

    it('works as the owner the browser signed in as and the agent set up on this Mac, leaving the lists as they are', async () => {
      const sys = team();
      const { code, out, err } = await run(sys, []);
      assert.equal(code, 0, [...out, ...err].join('\n'));
      assert.ok(out.includes('│  example-org/example-app · owner example-owner · agent ExampleBot'), out.join('\n'));
      assert.equal(repo(sys).get(SETTINGS), `${JSON.stringify(TEAM, null, 2)}\n`);
      // Only the sign-in tells which owner ran it, so it comes before the plan, and the pull request says why.
      assert.ok(out.indexOf('◇  Signed in as example-owner') < out.findIndex((line) => line.startsWith('◆')), out.join('\n'));
      assert.ok(out.includes('◇  GitHub — signed in as example-owner'), out.join('\n'));
      assert.match(opened(sys)?.body ?? '', /^- onboard signed in before showing its plan: \.github\/niyam\.json names several owners, and only the sign-in tells which one ran it\.$/m);
    });

    it('works as the second owner when the browser signs in as them, with one sign-in', async () => {
      const sys = team();
      sys.acceptToken(OWNER_TOKEN, 'Second-Owner', { 'x-oauth-scopes': 'repo, read:org, project, admin:org, workflow' });
      sys.route('GET', '/users/Second-Owner', { status: 200, json: { id: 2, login: 'Second-Owner' } });
      const { code, out, err } = await run(sys, []);
      assert.equal(code, 0, [...out, ...err].join('\n'));
      assert.ok(out.includes('│  example-org/example-app · owner Second-Owner · agent ExampleBot'), out.join('\n'));
      assert.equal(signIns(sys), 1);
      assert.ok(out.includes('◇  Sign in to GitHub as example-owner or Second-Owner, for this run only: repo, project, admin:org'), out.join('\n'));
      const login = sys.calls.find((call) => call.command === 'gh' && call.args[1] === 'login')?.args ?? [];
      assert.equal(login[login.indexOf('-s') + 1], 'project,admin:org', 'the sign-in that names the owner asks for the scopes the features need');
    });

    it('refuses a sign-in as an account the owners do not hold, or one that fails', async () => {
      const someone = team();
      someone.acceptToken(OWNER_TOKEN, 'someone');
      assert.deepEqual((await run(someone, [])).err, [
        'onboard: the browser signed in to GitHub as someone, but .github/niyam.json names the owners example-owner or Second-Owner; sign in there as one of them and run it again',
      ]);
      const failed = team();
      failed.ghToken = undefined;
      assert.deepEqual((await run(failed, [])).err, ['onboard: the GitHub sign-in in the browser did not finish; name the owner: niyam onboard <owner>']);
    });

    it('takes the owner and agent named, when the lists hold them', async () => {
      const sys = team();
      sys.route('GET', '/users/examplebot', { status: 200, json: { id: AGENT_ID, login: AGENT } });
      const { code, out } = await run(sys, ['EXAMPLE-OWNER', 'examplebot']);
      assert.equal(code, 0);
      assert.equal(repo(sys).get(SETTINGS), `${JSON.stringify(TEAM, null, 2)}\n`);
      assert.ok(out.includes('◇  Sign in to GitHub as example-owner, for this run only: repo, project, admin:org'), out.join('\n'));
      assert.ok(out.indexOf('◇  Signed in as example-owner') > out.findIndex((line) => line.startsWith('◆')), 'after the plan');
    });

    it('refuses accounts the lists do not hold, and an agent it cannot tell', async () => {
      const outside = team();
      assert.deepEqual((await run(outside, ['someone', AGENT])).err, [
        'onboard: .github/niyam.json already names owner example-owner or Second-Owner and agent OtherBot or ExampleBot; edit or delete it to change them',
      ]);
      const agentOutside = team();
      assert.deepEqual((await run(agentOutside, ['example-owner', 'SomeBot'])).err, [
        'onboard: .github/niyam.json already names owner example-owner or Second-Owner and agent OtherBot or ExampleBot; edit or delete it to change them',
      ]);
      const unset = team();
      unset.files.delete(pathsFor(HOME, AGENT).session);
      assert.deepEqual((await run(unset, [])).err, [
        'onboard: .github/niyam.json names the agents OtherBot or ExampleBot, and niyam machine has set up none of them on this machine; name the owner and the agent: niyam onboard <owner> <agent>',
      ]);
    });
  });

  for (const [release, older] of OLDER_HOOK_COMMANDS.entries()) {
    it(`upgrades an older release's hooks in place (${release})`, async () => {
      const sys = fresh();
      sys.files.set(HOOKS, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo hi' }, { type: 'command', command: older }] }] } }));
      const { out } = await run(sys);
      assert.ok(planned(out, 'Pull request').includes('settings.json: hooks updated, lock, allow rules'), out.join('\n'));
      assert.ok(
        opened(sys)?.body.includes(
          "\n- `.claude/settings.json`: replace the older SessionStart hook that runs niyam session-start with this release's; " +
            "add the PreToolUse hook that refuses gh and git's remote commands outside the agent identity; " +
            `set GH_TOKEN, GITHUB_TOKEN and ${Object.keys(BASE_ENV).length - 2} more in env, so GitHub is locked out until session-start gives the agent identity; ` +
            'allow niyam review-thread without a prompt, so agent sessions answer review threads on their own pull requests; ' +
            `allow ${AUTO_FIX_RULES.join(', ')} without a prompt, so agent sessions turn Auto-fix on for their own pull requests; ` +
            `allow ${ARTIFACT_RULES.join(', ')} without a prompt, so agent sessions publish the page an ask to the owner links\n`,
        ),
        opened(sys)?.body,
      );
      assert.deepEqual(JSON.parse(repo(sys).get(HOOKS) ?? ''), {
        hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo hi' }, { type: 'command', command: HOOK_COMMAND }] }], PreToolUse: [GUARD_ENTRY] },
        env: BASE_ENV,
        permissions: { allow: ALLOW },
      });
    });
  }

  it('sets only the lock variables that differ, keeping the client\'s own', () => {
    const { text, changes } = claudeSettings(JSON.stringify({ ...CLAUDE, env: { ...BASE_ENV, A: '1', GH_TOKEN: 'mine' } }));
    assert.deepEqual(JSON.parse(text).env, { ...BASE_ENV, A: '1' });
    assert.deepEqual(changes, ["update GH_TOKEN in env to this release's lock"]);
    const { changes: unset, labels } = claudeSettings(JSON.stringify({ ...CLAUDE, env: { ...BASE_ENV, GH_TOKEN: undefined } }));
    assert.deepEqual(unset, ['set GH_TOKEN in env, so GitHub is locked out until session-start gives the agent identity']);
    assert.deepEqual(labels, ['lock']);
  });

  it("updates 0.6.9's lock in env to niyam's placeholder token and SSH refusal, in place (P-55)", () => {
    const { text, changes, labels } = claudeSettings(JSON.stringify({ ...CLAUDE, env: { ...BASE_ENV_069, A: '1' } }, null, 2));
    assert.deepEqual(JSON.parse(text).env, { ...BASE_ENV, A: '1' });
    assert.equal(BASE_ENV.GH_TOKEN, 'niyam-no-agent-token');
    assert.equal(BASE_ENV.GIT_SSH_COMMAND, "echo 'niyam: SSH is off in agent sessions; GitHub goes over HTTPS' >&2; false");
    assert.deepEqual(changes, ["update GH_TOKEN, GITHUB_TOKEN, GIT_SSH_COMMAND in env to this release's lock"]);
    assert.deepEqual(labels, ['lock updated']);
    assert.deepEqual(claudeSettings(text).changes, [], 'once updated, nothing more');
  });

  it("adds the review-thread rule to the client's own allow list once", () => {
    const { text, changes, labels } = claudeSettings(JSON.stringify({ ...CLAUDE, permissions: { allow: ['Bash(pnpm test)', ...AUTO_FIX_RULES, ...ARTIFACT_RULES], deny: ['Read(.env)'] } }));
    assert.deepEqual(JSON.parse(text).permissions, { allow: ['Bash(pnpm test)', ...AUTO_FIX_RULES, ...ARTIFACT_RULES, REVIEW_THREAD_RULE], deny: ['Read(.env)'] });
    assert.deepEqual(changes, ['allow niyam review-thread without a prompt, so agent sessions answer review threads on their own pull requests']);
    assert.deepEqual(labels, ['review rule']);
    assert.deepEqual(claudeSettings(text).changes, []);
  });

  it('replaces the review-thread rule under the old command in its place, and leaves both where both are there', () => {
    const before = JSON.stringify({ ...CLAUDE, permissions: { allow: ['Bash(pnpm test)', OLDER_REVIEW_THREAD_RULE, ...AUTO_FIX_RULES, ...ARTIFACT_RULES] } });
    const { text, changes, labels } = claudeSettings(before);
    assert.deepEqual(JSON.parse(text).permissions.allow, ['Bash(pnpm test)', REVIEW_THREAD_RULE, ...AUTO_FIX_RULES, ...ARTIFACT_RULES]);
    assert.deepEqual(changes, [`replace ${OLDER_REVIEW_THREAD_RULE} with ${REVIEW_THREAD_RULE}, the CLI's own name`]);
    assert.deepEqual(labels, ['review rule']);
    assert.equal(REVIEW_THREAD_RULE, 'Bash(niyam review-thread *)');
    assert.equal(OLDER_REVIEW_THREAD_RULE, 'Bash(process-rules review-thread *)');
    const both = JSON.stringify({ ...CLAUDE, permissions: { allow: [OLDER_REVIEW_THREAD_RULE, REVIEW_THREAD_RULE, ...AUTO_FIX_RULES, ...ARTIFACT_RULES] } });
    assert.deepEqual(claudeSettings(both), { text: both, changes: [], labels: [] });
  });

  it('adds the Auto-fix rules to a fresh file', () => {
    const { text, changes, labels } = claudeSettings(undefined);
    assert.deepEqual(JSON.parse(text).permissions, { allow: ALLOW });
    assert.ok(changes.includes(`allow ${AUTO_FIX_RULES.join(', ')} without a prompt, so agent sessions turn Auto-fix on for their own pull requests`), changes.join('\n'));
    assert.deepEqual(labels, ['hooks added', 'lock', 'allow rules']);
    assert.deepEqual(claudeSettings(text).changes, []);
  });

  it('leaves a file that already allows the Auto-fix and artifact rules as it is', () => {
    const before = `${JSON.stringify({ ...CLAUDE, permissions: { allow: [...AUTO_FIX_RULES, 'Bash(pnpm test)', REVIEW_THREAD_RULE, ...ARTIFACT_RULES], ask: ['Bash(git push *)'] } }, null, 2)}\n`;
    assert.deepEqual(claudeSettings(before), { text: before, changes: [], labels: [] });
  });

  it('adds no Auto-fix rule where the whole pull request server is allowed', () => {
    for (const server of ['mcp__ccd_pr', 'mcp__ccd_pr__*']) {
      assert.deepEqual(claudeSettings(JSON.stringify({ ...CLAUDE, permissions: { allow: [REVIEW_THREAD_RULE, server, ...ARTIFACT_RULES] } })).changes, [], server);
    }
    assert.ok(claudeSettings(JSON.stringify({ ...CLAUDE, permissions: { allow: [REVIEW_THREAD_RULE, 'mcp__ccd_pr_*', ...ARTIFACT_RULES] } })).labels.includes('Auto-fix rules'));
  });

  it("adds only the Auto-fix rules a file lacks, after the client's own", () => {
    const { text, changes, labels } = claudeSettings(JSON.stringify({ ...CLAUDE, permissions: { allow: ['Bash(pnpm test)', REVIEW_THREAD_RULE, 'mcp__ccd_pr__get_status', ...ARTIFACT_RULES] } }));
    assert.deepEqual(JSON.parse(text).permissions, {
      allow: ['Bash(pnpm test)', REVIEW_THREAD_RULE, 'mcp__ccd_pr__get_status', ...ARTIFACT_RULES, 'mcp__ccd_pr__bind_pr', 'mcp__ccd_pr__set_monitor'],
    });
    assert.deepEqual(changes, ['allow mcp__ccd_pr__bind_pr, mcp__ccd_pr__set_monitor without a prompt, so agent sessions turn Auto-fix on for their own pull requests']);
    assert.deepEqual(labels, ['Auto-fix rules']);
    assert.deepEqual(claudeSettings(text).changes, []);
  });

  it("adds only the artifact rules a file lacks, after the client's own", () => {
    assert.deepEqual(ARTIFACT_RULES, ['mcp__claude-artifacts__publish_version', 'mcp__claude-artifacts__publish_files', 'mcp__claude-artifacts__edit_version']);
    const { text, changes, labels } = claudeSettings(JSON.stringify({ ...CLAUDE, permissions: { allow: ['Bash(pnpm test)', REVIEW_THREAD_RULE, ...AUTO_FIX_RULES, 'mcp__claude-artifacts__publish_files'] } }));
    assert.deepEqual(JSON.parse(text).permissions, {
      allow: ['Bash(pnpm test)', REVIEW_THREAD_RULE, ...AUTO_FIX_RULES, 'mcp__claude-artifacts__publish_files', 'mcp__claude-artifacts__publish_version', 'mcp__claude-artifacts__edit_version'],
    });
    assert.deepEqual(changes, ['allow mcp__claude-artifacts__publish_version, mcp__claude-artifacts__edit_version without a prompt, so agent sessions publish the page an ask to the owner links']);
    assert.deepEqual(labels, ['artifact rules']);
    assert.deepEqual(claudeSettings(text).changes, []);
  });

  it('reads no settings, no permissions, and lists that are not arrays or hold other than text, as naming no rule', () => {
    const none = { missing: [...AUTO_FIX_RULES], denied: [], leftOut: [], deniedBy: [], leftOutBy: [] };
    for (const settings of [null, {}, { permissions: {} }, { permissions: { allow: 'mcp__ccd_pr', deny: 'mcp__ccd_pr' } }, { permissions: { allow: [42, ['mcp__ccd_pr']], deny: [7, null] } }]) {
      assert.deepEqual(autoFixRuleNeeds(settings), none, JSON.stringify(settings));
    }
  });

  it("denies only by a glob after the server's own name, with the glob's other characters as written", () => {
    const needs = (deny: string[]) => autoFixRuleNeeds({ permissions: { deny } });
    assert.deepEqual(needs(['mcp__ccd_xx__*', 'mcp__ccd_pr__get.*', 'Bash(rm *)']), { missing: [...AUTO_FIX_RULES], denied: [], leftOut: [], deniedBy: [], leftOutBy: [] }, 'another server, a literal dot');
    assert.deepEqual(needs(['Bash(rm *)', 'mcp__ccd_pr__get_*']), {
      missing: ['mcp__ccd_pr__bind_pr', 'mcp__ccd_pr__set_monitor'],
      denied: ['mcp__ccd_pr__get_status'],
      leftOut: ['mcp__ccd_pr__get_status'],
      deniedBy: ['mcp__ccd_pr__get_*'],
      leftOutBy: ['mcp__ccd_pr__get_*'],
    });
    assert.deepEqual(autoFixRuleNeeds({ permissions: { allow: ['mcp__ccd_pr'], deny: ['mcp__ccd_pr__bind_pr'] } }), {
      missing: [],
      denied: ['mcp__ccd_pr__bind_pr'],
      leftOut: [],
      deniedBy: ['mcp__ccd_pr__bind_pr'],
      leftOutBy: [],
    }, 'the whole server allowed: nothing lacks, and nothing is left out');
  });

  it('adds no artifact rule where the whole artifacts server is allowed', () => {
    for (const server of ['mcp__claude-artifacts', 'mcp__claude-artifacts__*']) {
      assert.deepEqual(claudeSettings(JSON.stringify({ ...CLAUDE, permissions: { allow: [REVIEW_THREAD_RULE, ...AUTO_FIX_RULES, server] } })).changes, [], server);
    }
    assert.ok(claudeSettings(JSON.stringify({ ...CLAUDE, permissions: { allow: [REVIEW_THREAD_RULE, ...AUTO_FIX_RULES, 'mcp__claude-artifacts_*'] } })).labels.includes('artifact rules'));
  });

  it('adds no artifact rule the file denies, by server or by tool, and says so instead', () => {
    for (const server of ['mcp__claude-artifacts', 'mcp__claude-artifacts__*']) {
      const before = JSON.stringify({ ...CLAUDE, permissions: { allow: [REVIEW_THREAD_RULE, ...AUTO_FIX_RULES], deny: ['Artifact', server] } });
      assert.deepEqual(claudeSettings(before), { text: before, changes: [], labels: [], denied: [`artifact rules left out: .claude/settings.json denies ${server}`] }, server);
    }
    const one = claudeSettings(JSON.stringify({ ...CLAUDE, permissions: { allow: [REVIEW_THREAD_RULE, ...AUTO_FIX_RULES], deny: ['mcp__claude-artifacts__edit_version'] } }));
    assert.deepEqual(JSON.parse(one.text).permissions.allow, [REVIEW_THREAD_RULE, ...AUTO_FIX_RULES, 'mcp__claude-artifacts__publish_version', 'mcp__claude-artifacts__publish_files']);
    assert.deepEqual(one.changes, ['allow mcp__claude-artifacts__publish_version, mcp__claude-artifacts__publish_files without a prompt, so agent sessions publish the page an ask to the owner links']);
    assert.deepEqual(one.labels, ['artifact rules']);
    assert.deepEqual(one.denied, ['mcp__claude-artifacts__edit_version left out: .claude/settings.json denies mcp__claude-artifacts__edit_version']);
    assert.deepEqual(claudeSettings(one.text).changes, [], 'a second run changes nothing');
    // Every tool, every MCP tool, and a glob in the tool's name deny as Claude Code matches them.
    for (const every of ['*', 'mcp__*']) {
      const before = JSON.stringify({ ...CLAUDE, permissions: { allow: [REVIEW_THREAD_RULE, ...AUTO_FIX_RULES, ...ARTIFACT_RULES], deny: [every] } });
      assert.deepEqual(claudeSettings(before), { text: before, changes: [], labels: [] }, every);
      const lacking = claudeSettings(JSON.stringify({ ...CLAUDE, permissions: { allow: [REVIEW_THREAD_RULE], deny: [every] } }));
      assert.deepEqual(lacking.changes, [], every);
      assert.deepEqual(lacking.denied, [`Auto-fix rules left out: .claude/settings.json denies ${every}`, `artifact rules left out: .claude/settings.json denies ${every}`], every);
    }
    const prefixed = claudeSettings(JSON.stringify({ ...CLAUDE, permissions: { allow: [REVIEW_THREAD_RULE, ...AUTO_FIX_RULES], deny: ['mcp__claude-artifacts__publish_*'] } }));
    assert.deepEqual(JSON.parse(prefixed.text).permissions.allow, [REVIEW_THREAD_RULE, ...AUTO_FIX_RULES, 'mcp__claude-artifacts__edit_version']);
    assert.deepEqual(prefixed.denied, ['mcp__claude-artifacts__publish_version, mcp__claude-artifacts__publish_files left out: .claude/settings.json denies mcp__claude-artifacts__publish_*']);
    // A near miss, a glob in the server's name, which Claude Code's page does not describe, and a deny that is not a list deny nothing.
    for (const deny of [['mcp__claude-artifacts_*'], ['mcp__claude-art*'], ['mcp__claude-artifacts__publish'], 'mcp__claude-artifacts']) {
      const near = claudeSettings(JSON.stringify({ ...CLAUDE, permissions: { allow: [REVIEW_THREAD_RULE, ...AUTO_FIX_RULES], deny } }));
      assert.deepEqual(JSON.parse(near.text).permissions.allow, ALLOW, JSON.stringify(deny));
      assert.equal(near.denied, undefined);
    }
  });

  it('adds no Auto-fix rule the file denies, and says each group it leaves out', () => {
    const before = JSON.stringify({ ...CLAUDE, permissions: { allow: [REVIEW_THREAD_RULE], deny: ['mcp__ccd_pr', 'mcp__claude-artifacts__*'] } });
    assert.deepEqual(claudeSettings(before), {
      text: before,
      changes: [],
      labels: [],
      denied: ['Auto-fix rules left out: .claude/settings.json denies mcp__ccd_pr', 'artifact rules left out: .claude/settings.json denies mcp__claude-artifacts__*'],
    });
    const two = claudeSettings(JSON.stringify({ ...CLAUDE, permissions: { allow: [REVIEW_THREAD_RULE, ...ARTIFACT_RULES], deny: ['mcp__ccd_pr__set_monitor', 'mcp__ccd_pr__bind_pr'] } }));
    assert.deepEqual(JSON.parse(two.text).permissions.allow, [REVIEW_THREAD_RULE, ...ARTIFACT_RULES, 'mcp__ccd_pr__get_status']);
    assert.deepEqual(two.denied, ['mcp__ccd_pr__bind_pr, mcp__ccd_pr__set_monitor left out: .claude/settings.json denies mcp__ccd_pr__set_monitor, mcp__ccd_pr__bind_pr']);
    // An allow rule already there for a denied tool is the owner's, and stays; nothing is left out, so nothing is said.
    const kept = JSON.stringify({ ...CLAUDE, permissions: { allow: ALLOW, deny: ['mcp__claude-artifacts'] } });
    assert.deepEqual(claudeSettings(kept), { text: kept, changes: [], labels: [] });
    const some = claudeSettings(JSON.stringify({ ...CLAUDE, permissions: { allow: [REVIEW_THREAD_RULE, ...AUTO_FIX_RULES, 'mcp__claude-artifacts__publish_files'], deny: ['mcp__claude-artifacts'] } }));
    assert.deepEqual(some.changes, []);
    assert.deepEqual(some.denied, ['mcp__claude-artifacts__publish_version, mcp__claude-artifacts__edit_version left out: .claude/settings.json denies mcp__claude-artifacts']);
    // A deny behind a tool the file allows already is not named as a cause.
    const causes = claudeSettings(JSON.stringify({ ...CLAUDE, permissions: { allow: [REVIEW_THREAD_RULE, ...AUTO_FIX_RULES, 'mcp__claude-artifacts__publish_files'], deny: ['mcp__claude-artifacts__publish_files', 'mcp__claude-artifacts__edit_version'] } }));
    assert.deepEqual(causes.denied, ['mcp__claude-artifacts__edit_version left out: .claude/settings.json denies mcp__claude-artifacts__edit_version']);
    const whole = JSON.stringify({ ...CLAUDE, permissions: { allow: [REVIEW_THREAD_RULE, ...AUTO_FIX_RULES, 'mcp__claude-artifacts'], deny: ['mcp__claude-artifacts__edit_version'] } });
    assert.deepEqual(claudeSettings(whole), { text: whole, changes: [], labels: [] }, 'the whole server allowed: nothing would be added');
  });

  it("shows the rules a client's deny leaves out in the plan, with no settings.json change", async () => {
    const sys = fresh();
    sys.files.set(SETTINGS, JSON.stringify({ owner: 'example-owner', agent: AGENT, features: ['identity'] }));
    sys.files.set(HOOKS, JSON.stringify({ ...CLAUDE, permissions: { allow: [REVIEW_THREAD_RULE, ...AUTO_FIX_RULES], deny: ['mcp__claude-artifacts'] } }));
    sys.files.set(PRE_PUSH, PRE_PUSH_HOOK);
    const { code, out } = await run(sys, ['--dry-run']);
    assert.equal(code, 0);
    assert.ok(out.includes('│  ! artifact rules left out: .claude/settings.json denies mcp__claude-artifacts'), out.join('\n'));
    assert.ok(!planned(out, 'Pull request').some((item) => item.startsWith('settings.json')), out.join('\n'));
  });

  it('says allow rules when it adds the Auto-fix and artifact rules together', () => {
    const { text, changes, labels } = claudeSettings(JSON.stringify({ ...CLAUDE, permissions: { allow: [REVIEW_THREAD_RULE] } }));
    assert.deepEqual(JSON.parse(text).permissions.allow, ALLOW);
    assert.equal(changes.length, 2, changes.join('\n'));
    assert.deepEqual(labels, ['allow rules']);
  });

  it('refuses an env that is not an object, and a file that is not one', () => {
    assert.throws(() => claudeSettings(JSON.stringify({ ...CLAUDE, permissions: { allow: 'all' } })), /^Error: \.claude\/settings\.json: permissions\.allow is not an array$/);
    assert.throws(() => claudeSettings('{ "env": [] }'), /^Error: \.claude\/settings\.json: env is not an object$/);
    assert.throws(() => claudeSettings('[]'), /^Error: \.claude\/settings\.json is not a JSON object$/);
  });

  it("swaps only the older SessionStart command, keeping the file's layout", async () => {
    const sys = fresh();
    const older = JSON.stringify(OLDER_HOOK_COMMANDS[0]);
    const text = `{\r\n    "hooks": {\r\n        "Stop": [ { "hooks": [ { "command": ${older} } ] } ],\r\n        "SessionStart": [ { "hooks": [ { "command": ${older} } ] } ]\r\n    }\r\n}\r\n`;
    sys.files.set(HOOKS, text);
    await run(sys);
    const at = text.lastIndexOf(older);
    const swapped = `${text.slice(0, at)}${JSON.stringify(HOOK_COMMAND)}${text.slice(at + older.length)}`;
    const written = repo(sys).get(HOOKS) ?? '';
    assert.ok(written.startsWith(swapped.slice(0, swapped.lastIndexOf('\r\n    }'))), written);
    assert.ok(written.includes('\r\n        "PreToolUse": [\r\n            {\r\n                "matcher": "Bash",'), 'added in the file\'s own layout');
    assert.deepEqual(JSON.parse(written).env, BASE_ENV);
  });

  it('refuses a settings file it cannot add the hook to, before asking', async () => {
    const sys = fresh();
    sys.files.set(HOOKS, '{ "hooks": { "SessionStart": "x" } }');
    await assert.rejects(run(sys), /^Error: \.claude\/settings\.json: hooks\.SessionStart is not an array$/);
    assert.equal(repo(sys).get(HOOKS), '{ "hooks": { "SessionStart": "x" } }');
    assert.deepEqual(sys.chosen, [], 'refused before the plan');
  });

  it("leaves a client's own hook that mentions session-start alone", async () => {
    const sys = fresh();
    const own = 'my-wrapper && process-rules session-start';
    sys.files.set(HOOKS, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: own }] }] } }));
    await run(sys);
    const commands = JSON.parse(repo(sys).get(HOOKS) ?? '').hooks.SessionStart.flatMap((g: { hooks: { command: string }[] }) => g.hooks.map((h) => h.command));
    assert.deepEqual(commands, [own, HOOK_COMMAND]);
  });

  it('changes nothing at a no, opening no pull request and signing in to nothing', async () => {
    for (const answer of ['n', '']) {
      const sys = fresh();
      sys.files.set(SETTINGS, JSON.stringify({ owner: 'example-owner', agent: AGENT }));
      sys.files.set(HOOKS, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ command: OLDER_HOOK_COMMANDS[0] }] }, null, { hooks: 'x' }] } }));
      sys.route('GET', REPO, { status: 404, json: { message: 'Not Found' } });
      sys.answers = [answer];
      const { code, out, err } = await run(sys, []);
      assert.deepEqual({ code, err }, { code: 1, err: [] });
      assert.deepEqual(sys.chosen, ['Go ahead?']);
      assert.equal(out.at(-1), '└  Nothing changed, and no pull request was opened.');
      assert.ok(planned(out, 'GitHub').includes('ExampleBot write access'), out.join('\n'));
      assert.ok(changedNothing(sys), 'nothing written, pushed or signed in to');
      assert.deepEqual(sys.spun, []);
    }
  });

  describe('the hook commands, in a real shell', () => {
    const home = mkdtempSync(join(tmpdir(), 'niyam-home-'));
    const bin = mkdtempSync(join(tmpdir(), 'niyam-bin-'));
    const launcher = join(home, '.config/niyam/bin/niyam');
    after(() => {
      rmSync(home, { recursive: true, force: true });
      rmSync(bin, { recursive: true, force: true });
    });
    /** A CLI at `path` that runs `body`. */
    const cli = (path: string, body: string): void => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    };
    const shell = (command: string, env: Record<string, string>, input = '') =>
      spawnSync('bash', ['-c', command], { encoding: 'utf8', input, env: { HOME: home, PATH: '/usr/bin:/bin', ...env } });

    it('session-start: its output, in a cloud session too, else STOP with why', () => {
      rmSync(launcher, { force: true });
      cli(join(bin, 'process-rules'), 'echo "the old command ran"');
      cli(join(bin, 'niyam'), 'echo "ran $* with $(cat)"');
      assert.equal(shell(HOOK_COMMAND, { PATH: `${bin}:/usr/bin:/bin`, CLAUDE_CODE_REMOTE: 'true' }, '{}').stdout, 'ran session-start with {}\n');
      assert.equal(shell(HOOK_COMMAND, { PATH: `${bin}:/usr/bin:/bin` }, '{"session_id":"s"}').stdout, 'ran session-start with {"session_id":"s"}\n');
      assert.match(
        shell(HOOK_COMMAND, {}).stdout,
        /^niyam: STOP\. niyam session-start did not run here \(.*niyam: (?:command )?not found\), so this session cannot be given the agent identity and GitHub is locked out of it\./,
      );
      cli(launcher, 'echo "env: node: No such file or directory" >&2; exit 127');
      assert.match(shell(HOOK_COMMAND, { PATH: `${bin}:/usr/bin:/bin` }).stdout, /^niyam: STOP\. niyam session-start did not run here \(env: node: No such file or directory\)/);
      cli(launcher, 'echo "launched $*"');
      assert.equal(shell(HOOK_COMMAND, {}).stdout, 'launched session-start\n', 'the launcher, with nothing on PATH');
    });

    describe('in a Claude cloud session with no CLI, the SessionStart hook installs it from the clone (P-60, #334)', () => {
      const project = mkdtempSync(join(tmpdir(), 'niyam-clone-'));
      const setup = join(project, CLOUD_SETUP_PATH);
      const ran = join(project, 'setup-ran');
      after(() => rmSync(project, { recursive: true, force: true }));
      /** The clone's cloud setup file, which records that it ran, then runs `body`. */
      const setupDoes = (body: string): void => {
        rmSync(ran, { force: true });
        cli(setup, `: > "${ran}"\n${body}`);
      };
      /** A cloud session's hook run: `CLAUDE_CODE_REMOTE` and the project folder Claude Code gives hooks, with `bin` on PATH. */
      const cloudHook = (env: Record<string, string> = {}, input = '{"session_id":"s"}') =>
        shell(HOOK_COMMAND, { PATH: `${bin}:/usr/bin:/bin`, CLAUDE_CODE_REMOTE: 'true', CLAUDE_PROJECT_DIR: project, ...env }, input);
      const user = spawnSync('id', ['-un'], { encoding: 'utf8' }).stdout.trim();
      const uid = spawnSync('id', ['-u'], { encoding: 'utf8' }).stdout.trim();
      const STOP = /^niyam: STOP\. niyam session-start did not run here \(.*niyam: (?:command )?not found\), so this session cannot be given the agent identity/;
      beforeEach(() => {
        rmSync(launcher, { force: true });
        rmSync(join(bin, 'niyam'), { force: true });
        rmSync(setup, { force: true });
      });

      it('installs niyam, says so, and runs session-start with the hook\'s input, the install\'s own output dropped', () => {
        setupDoes(`echo "Node unpacked"; echo "a warning" >&2\nprintf '#!/bin/sh\\necho "installed niyam ran $* with $(cat)"\\n' > "${bin}/niyam"; chmod 755 "${bin}/niyam"`);
        const { stdout, status } = cloudHook();
        assert.equal(status, 0);
        assert.equal(
          stdout,
          `niyam: this cloud session had no niyam, so the SessionStart hook installed it from ${CLOUD_SETUP_PATH}.\ninstalled niyam ran session-start with {"session_id":"s"}\n`,
        );
      });

      it('names the install\'s last error line and the user it ran as, then stops', () => {
        setupDoes('echo "downloading" >&2\necho "mkdir: cannot create directory /opt/niyam: Permission denied" >&2\nexit 1');
        const [said, stop, ...rest] = cloudHook().stdout.split('\n');
        assert.equal(said, `niyam: this cloud session has no niyam, and installing it from ${CLOUD_SETUP_PATH} as ${user} (uid ${uid}) failed: mkdir: cannot create directory /opt/niyam: Permission denied`);
        assert.match(stop ?? '', STOP);
        assert.deepEqual(rest, ['']);
      });

      it('says to run onboard when the clone has no cloud setup file, then stops', () => {
        const [said, stop] = cloudHook().stdout.split('\n');
        assert.equal(said, `niyam: this cloud session has no niyam, and the clone has no ${CLOUD_SETUP_PATH} to install it from; run niyam onboard, which writes it.`);
        assert.match(stop ?? '', STOP);
      });

      it('installs nothing where a CLI is found, or outside a cloud session', () => {
        setupDoes('exit 0');
        cli(join(bin, 'niyam'), 'echo "niyam on PATH ran $*"');
        assert.equal(cloudHook().stdout, 'niyam on PATH ran session-start\n');
        rmSync(join(bin, 'niyam'));
        cli(launcher, 'echo "launcher ran $*"');
        assert.equal(cloudHook().stdout, 'launcher ran session-start\n');
        rmSync(launcher);
        for (const env of [{ CLAUDE_CODE_REMOTE: '' }, { CLAUDE_CODE_REMOTE: 'false' }]) {
          assert.match(cloudHook(env).stdout, STOP, 'a Mac session with no CLI stops, as before');
        }
        assert.equal(existsSync(ran), false, 'the cloud setup file never ran');
      });

      it("finds the cloud setup file from the working folder where Claude Code gives no project folder", () => {
        setupDoes(`printf '#!/bin/sh\\necho "installed niyam ran $*"\\n' > "${bin}/niyam"; chmod 755 "${bin}/niyam"`);
        const { stdout } = spawnSync('bash', ['-c', HOOK_COMMAND], { encoding: 'utf8', cwd: project, input: '', env: { HOME: home, PATH: `${bin}:/usr/bin:/bin`, CLAUDE_CODE_REMOTE: 'true' } });
        assert.equal(stdout, `niyam: this cloud session had no niyam, so the SessionStart hook installed it from ${CLOUD_SETUP_PATH}.\ninstalled niyam ran session-start\n`);
      });
    });

    it('pre-push: the owner\'s pushes go ahead; an agent session\'s runs the CLI, refused without one', () => {
      rmSync(launcher, { force: true });
      const hook = (env: Record<string, string>) => spawnSync('sh', ['-c', `${PRE_PUSH_HOOK}`, 'pre-push', 'origin', 'url'], { encoding: 'utf8', env: { HOME: home, PATH: '/usr/bin:/bin', ...env } });
      assert.equal(hook({}).status, 0);
      for (const env of [{ CLAUDECODE: '1' }, { NIYAM_AGENT: AGENT }, { CLAUDECODE: '1', CLAUDE_CODE_REMOTE: 'true' }]) {
        const refused = hook(env);
        assert.deepEqual({ status: refused.status, stderr: refused.stderr }, { status: 1, stderr: 'niyam: the CLI is not installed, so this agent push cannot be checked\n' });
      }
      cli(launcher, 'echo "ran $*"; exit 1');
      assert.deepEqual((({ status, stdout }) => ({ status, stdout }))(hook({ CLAUDECODE: '1' })), { status: 1, stdout: 'ran pre-push origin url\n' });
      cli(launcher, 'exit 0');
      assert.equal(hook({ CLAUDECODE: '1' }).status, 0);
    });

    it('guard: commands naming neither gh nor git go ahead without the CLI; others as the CLI says, refused when it cannot run', () => {
      rmSync(launcher, { force: true });
      const input = (command: string): string => JSON.stringify({ session_id: 's', tool_input: { command } });
      assert.equal(shell(GUARD_COMMAND, {}, input('ls')).status, 0);
      assert.equal(shell(GUARD_COMMAND, {}, input('ls .github && echo high')).status, 0, 'gh and git as words only');
      assert.equal(shell(GUARD_COMMAND, {}, input('/usr/bin/gh pr list')).status, 2);
      const described = JSON.stringify({ session_id: 's', cwd: '/x/github', tool_input: { command: 'echo "git"x', description: 'Run gh' } });
      assert.equal(shell(GUARD_COMMAND, {}, described.replace('echo \\"git\\"x', 'ls')).status, 0, 'only the command counts');
      assert.equal(shell(GUARD_COMMAND, {}, described).status, 2, 'escaped quotes inside the command');
      assert.equal(shell(GUARD_COMMAND, {}, '{ "tool_input": { "command": "echo \\"a\\" && gh pr list" } }').status, 2);
      const missing = shell(GUARD_COMMAND, {}, input('git push'));
      assert.equal(missing.status, 2);
      assert.match(missing.stderr, /niyam: refused, because the niyam CLI did not run here to check this command\./);
      assert.equal(shell(GUARD_COMMAND, { CLAUDE_CODE_REMOTE: 'true' }, input('git push')).status, 2, 'in a cloud session too');
      cli(launcher, 'cat > "$HOME/seen"; exit 0');
      assert.equal(shell(GUARD_COMMAND, {}, input('gh pr list')).status, 0);
      assert.equal(readFileSync(join(home, 'seen'), 'utf8'), input('gh pr list'));
      cli(launcher, 'echo "niyam: refused, why" >&2; exit 2');
      assert.deepEqual(
        (({ status, stderr }) => ({ status, stderr }))(shell(GUARD_COMMAND, {}, input('gh pr list'))),
        { status: 2, stderr: 'niyam: refused, why\n' },
      );
      cli(launcher, 'exit 1');
      assert.equal(shell(GUARD_COMMAND, {}, input('gh pr list')).status, 2);
    });

    describe('with the launcher, the folder before P-55, or neither (P-57)', () => {
      const old = join(home, '.config/process-rules/bin/process-rules');
      /** Which launchers there are, each saying which it is; none leaves niyam on PATH, from `bin`. */
      const launchers = (which: { now?: boolean; old?: boolean }): void => {
        rmSync(launcher, { force: true });
        rmSync(old, { force: true });
        if (which.now) cli(launcher, 'echo "new launcher ran $*"');
        if (which.old) cli(old, 'echo "old launcher ran $*"');
        cli(join(bin, 'niyam'), 'echo "niyam on PATH ran $*"');
      };
      const path = { PATH: `${bin}:/usr/bin:/bin` };
      for (const [state, which, ran] of [
        ['the launcher only', { now: true }, 'new launcher'],
        ['the old launcher only, which no release runs since P-57', { old: true }, 'niyam on PATH'],
        ['both, the old one never', { now: true, old: true }, 'new launcher'],
        ['neither, niyam on PATH', {}, 'niyam on PATH'],
      ] as const) {
        it(`this release's hooks run ${ran} with ${state}`, () => {
          launchers(which);
          assert.equal(shell(HOOK_COMMAND, path, '{}').stdout, `${ran} ran session-start\n`);
          assert.equal(shell(GUARD_COMMAND, path, JSON.stringify({ tool_input: { command: 'gh pr list' } })).stdout, `${ran} ran guard\n`);
          const pushed = spawnSync('sh', ['-c', PRE_PUSH_HOOK, 'pre-push', 'origin', 'url'], { encoding: 'utf8', env: { HOME: home, ...path, CLAUDECODE: '1' } });
          assert.equal(pushed.stdout, `${ran} ran pre-push origin url\n`);
        });
      }

      it("0.6.10's hooks, not yet replaced, still run the launcher, and niyam on PATH once machine has removed the old folder", () => {
        launchers({ now: true });
        assert.equal(shell(HOOK_COMMAND_0610, path, '{}').stdout, 'new launcher ran session-start\n');
        assert.equal(shell(GUARD_COMMAND_0610, path, JSON.stringify({ tool_input: { command: 'gh pr list' } })).stdout, 'new launcher ran guard\n');
        const pushed = spawnSync('sh', ['-c', PRE_PUSH_HOOK_0610, 'pre-push', 'origin', 'url'], { encoding: 'utf8', env: { HOME: home, ...path, NIYAM_AGENT: AGENT } });
        assert.equal(pushed.stdout, 'new launcher ran pre-push origin url\n');
        launchers({});
        assert.equal(shell(HOOK_COMMAND_0610, path, '{}').stdout, 'niyam on PATH ran session-start\n');
      });

      it("the pre-push hook checks an agent session's push named by NIYAM_AGENT or CLAUDECODE, and lets anyone else's go", () => {
        launchers({ now: true });
        const hook = (env: Record<string, string>) => spawnSync('sh', ['-c', PRE_PUSH_HOOK, 'pre-push', 'origin', 'url'], { encoding: 'utf8', env: { HOME: home, ...path, ...env } });
        for (const env of [{ NIYAM_AGENT: AGENT }, { NIYAM_AGENT: AGENT, PROCESS_RULES_AGENT: AGENT }, { CLAUDECODE: '1' }]) {
          assert.equal(hook(env).stdout, 'new launcher ran pre-push origin url\n', JSON.stringify(env));
        }
        for (const env of [{}, { NIYAM_AGENT: '' }, { PROCESS_RULES_AGENT: AGENT }, { CLAUDECODE: '0' }]) {
          assert.deepEqual((({ status, stdout }) => ({ status, stdout }))(hook(env)), { status: 0, stdout: '' }, JSON.stringify(env));
        }
      });
    });
  });

  it('adds the hook when the command only appears elsewhere', async () => {
    const sys = fresh();
    const lookalike = { hooks: { Stop: [{ hooks: [{ type: 'command', command: HOOK_COMMAND }] }], SessionStart: [{ hooks: [{ command: 'echo niyam is set up elsewhere' }] }, {}] } };
    sys.files.set(HOOKS, JSON.stringify(lookalike));
    const { out } = await run(sys);
    assert.ok(planned(out, 'Pull request').includes('settings.json: hooks added, lock, allow rules'), out.join('\n'));
    assert.match(opened(sys)?.body ?? '', /^- `\.claude\/settings\.json`: add the SessionStart hook/m);
    assert.equal(JSON.parse(repo(sys).get(HOOKS) ?? '').hooks.SessionStart.length, 3);
  });

  it('uses GitHub\'s spelling of the accounts existing settings name', async () => {
    const sys = fresh();
    sys.files.set(SETTINGS, JSON.stringify({ owner: 'Example-Owner', agent: 'examplebot' }));
    sys.route('GET', '/users/Example-Owner', { status: 200, json: { id: 1, login: 'example-owner' } });
    const { code, out } = await run(sys, []);
    assert.equal(code, 0);
    assert.ok(out.includes('│  example-org/example-app · owner example-owner · agent ExampleBot'), out.join('\n'));
    assert.ok(out.includes('◇  test commit Verified as ExampleBot'));
  });

  it('refuses a repository with no commits, before pushing anything', async () => {
    const sys = fresh();
    sys.remoteHead = '';
    const { code, out, err } = await run(sys);
    assert.deepEqual({ code, err }, {
      code: 1,
      err: [
        'onboard: example-org/example-app has no commits yet; push a first commit to it, then onboard again',
        'onboard: stopped at "test commit Verified as ExampleBot"; nothing after it was changed, and no pull request was opened',
      ],
    });
    assert.ok(out.includes('■  test commit Verified as ExampleBot'));
    assert.ok(!out.some((line) => line.startsWith('└')), 'no ending');
    assert.ok(!sys.calls.some((c) => c.args[0] === 'push'));
  });

  it('keeps the hooks a client already has', async () => {
    const sys = fresh();
    const own = { hooks: [{ type: 'command', command: 'echo hi' }] };
    sys.files.set(HOOKS, JSON.stringify({ env: { A: '1' }, hooks: { SessionStart: [own], Stop: [own] } }));
    await run(sys);
    assert.deepEqual(JSON.parse(repo(sys).get(HOOKS) ?? ''), {
      env: { A: '1', ...BASE_ENV },
      hooks: { SessionStart: [own, SESSION_ENTRY], Stop: [own], PreToolUse: [GUARD_ENTRY] },
      permissions: { allow: ALLOW },
    });
  });

  it("replaces an older release's pre-push hook", async () => {
    const sys = fresh();
    sys.files.set(PRE_PUSH, OLDER_PRE_PUSH_HOOKS[0] as string);
    const { out } = await run(sys);
    assert.deepEqual(planned(out, 'This Mac'), ['pre-push hook: older one replaced']);
    assert.match(opened(sys)?.body ?? '', /^ {2}- replaced the older pre-push git hook \.git\/hooks\/pre-push, which checks/m);
    assert.equal(sys.files.get(PRE_PUSH), PRE_PUSH_HOOK);
  });

  it('finds the CLI in the launcher, then on PATH, in every hook, naming nothing before niyam (P-57)', () => {
    const find = 'cli="$HOME/.config/niyam/bin/niyam"; [ -x "$cli" ] || cli=niyam; ';
    assert.ok(HOOK_COMMAND.startsWith(find), HOOK_COMMAND);
    assert.ok(GUARD_COMMAND.includes(find), GUARD_COMMAND);
    assert.ok(PRE_PUSH_HOOK.includes('[ -z "$NIYAM_AGENT" ] && [ "$CLAUDECODE" != 1 ] && exit 0\ncli="$HOME/.config/niyam/bin/niyam"\n[ -x "$cli" ] || cli=niyam\n'), PRE_PUSH_HOOK);
    for (const text of [HOOK_COMMAND, GUARD_COMMAND, PRE_PUSH_HOOK]) assert.doesNotMatch(text, /process-rules|PROCESS_RULES/);
  });

  it('writes the pre-push hook as it reads, and knows each older hook as the release that wrote it wrote it', () => {
    assert.deepEqual(PRE_PUSH_HOOK.split('\n'), [
      '#!/bin/sh',
      '# Written by niyam onboard: before an agent session pushes, that it pushes as the agent, then the work rules.',
      "# Anyone else's push goes ahead. Without the CLI nothing can check an agent session's push, so it is refused.",
      '[ -z "$NIYAM_AGENT" ] && [ "$CLAUDECODE" != 1 ] && exit 0',
      'cli="$HOME/.config/niyam/bin/niyam"',
      '[ -x "$cli" ] || cli=niyam',
      'if ! command -v "$cli" >/dev/null 2>&1; then',
      '  echo "niyam: the CLI is not installed, so this agent push cannot be checked" >&2',
      '  exit 1',
      'fi',
      'exec "$cli" pre-push "$@"',
      '',
    ]);
    assert.deepEqual(OLDER_PRE_PUSH_HOOKS, [PRE_PUSH_HOOK_0610, PRE_PUSH_HOOK_069, PRE_PUSH_HOOK_067, PRE_PUSH_HOOK_052, PRE_PUSH_HOOK_050]);
    assert.deepEqual(OLDER_HOOK_COMMANDS, [HOOK_COMMAND_0616, HOOK_COMMAND_0610, HOOK_COMMAND_069, HOOK_COMMAND_067, HOOK_COMMAND_052, HOOK_COMMAND_020, HOOK_COMMAND_050]);
    assert.deepEqual(OLDER_GUARD_COMMANDS, [GUARD_COMMAND_0610, GUARD_COMMAND_069, GUARD_COMMAND_067, GUARD_COMMAND_052]);
  });

  it("replaces 0.6.16's SessionStart hook in place, which stopped a cloud session with no CLI (P-60)", async () => {
    assert.ok(OLDER_HOOK_COMMANDS.includes(HOOK_COMMAND_0616));
    assert.notEqual(HOOK_COMMAND, HOOK_COMMAND_0616);
    const sys = fresh();
    const entry = (command: string, extra = {}) => ({ ...extra, hooks: [{ type: 'command', command }] });
    const own = entry('echo mine');
    sys.files.set(HOOKS, JSON.stringify({ hooks: { SessionStart: [own, entry(HOOK_COMMAND_0616)], PreToolUse: [GUARD_ENTRY] }, env: BASE_ENV, permissions: { allow: ALLOW } }, null, 2));
    const { out } = await run(sys);
    assert.ok(planned(out, 'Pull request').includes('settings.json: hooks updated'), out.join('\n'));
    assert.deepEqual(JSON.parse(repo(sys).get(HOOKS) ?? ''), { hooks: { SessionStart: [own, SESSION_ENTRY], PreToolUse: [GUARD_ENTRY] }, env: BASE_ENV, permissions: { allow: ALLOW } });
  });

  it("replaces 0.6.10's hooks and pre-push hook in place, keeping the client's own (P-57)", async () => {
    assert.ok(OLDER_HOOK_COMMANDS.includes(HOOK_COMMAND_0610) && OLDER_GUARD_COMMANDS.includes(GUARD_COMMAND_0610) && OLDER_PRE_PUSH_HOOKS.includes(PRE_PUSH_HOOK_0610));
    const sys = fresh();
    const entry = (command: string, extra = {}) => ({ ...extra, hooks: [{ type: 'command', command }] });
    const own = entry('echo mine');
    sys.files.set(HOOKS, JSON.stringify({ hooks: { SessionStart: [own, entry(HOOK_COMMAND_0610)], PreToolUse: [entry(GUARD_COMMAND_0610, { matcher: 'Bash' })] }, env: BASE_ENV, permissions: { allow: ALLOW } }, null, 2));
    sys.files.set(PRE_PUSH, PRE_PUSH_HOOK_0610);
    const { out } = await run(sys);
    assert.ok(planned(out, 'Pull request').includes('settings.json: hooks updated'), out.join('\n'));
    assert.deepEqual(planned(out, 'This Mac'), ['pre-push hook: older one replaced']);
    assert.deepEqual(JSON.parse(repo(sys).get(HOOKS) ?? ''), { hooks: { SessionStart: [own, SESSION_ENTRY], PreToolUse: [GUARD_ENTRY] }, env: BASE_ENV, permissions: { allow: ALLOW } });
    assert.equal(sys.files.get(PRE_PUSH), PRE_PUSH_HOOK);
  });

  it("replaces 0.6.9's hooks, pre-push hook and lock in place, which name the old folder, variable and token (P-55)", async () => {
    assert.ok(OLDER_HOOK_COMMANDS.includes(HOOK_COMMAND_069) && OLDER_GUARD_COMMANDS.includes(GUARD_COMMAND_069) && OLDER_PRE_PUSH_HOOKS.includes(PRE_PUSH_HOOK_069));
    const sys = fresh();
    const entry = (command: string, extra = {}) => ({ ...extra, hooks: [{ type: 'command', command }] });
    sys.files.set(HOOKS, JSON.stringify({ hooks: { SessionStart: [entry(HOOK_COMMAND_069)], PreToolUse: [entry(GUARD_COMMAND_069, { matcher: 'Bash' })] }, env: BASE_ENV_069, permissions: { allow: ALLOW } }, null, 2));
    sys.files.set(PRE_PUSH, PRE_PUSH_HOOK_069);
    const { out } = await run(sys);
    assert.ok(planned(out, 'Pull request').includes('settings.json: hooks updated, lock updated'), out.join('\n'));
    assert.deepEqual(planned(out, 'This Mac'), ['pre-push hook: older one replaced']);
    assert.match(opened(sys)?.body ?? '', /update GH_TOKEN, GITHUB_TOKEN, GIT_SSH_COMMAND in env to this release's lock/);
    assert.deepEqual(JSON.parse(repo(sys).get(HOOKS) ?? ''), { hooks: { SessionStart: [SESSION_ENTRY], PreToolUse: [GUARD_ENTRY] }, env: BASE_ENV, permissions: { allow: ALLOW } });
    assert.equal(sys.files.get(PRE_PUSH), PRE_PUSH_HOOK);
  });


  it("leaves the client's own pre-push hook, naming the line to add", async () => {
    const sys = fresh();
    sys.files.set(PRE_PUSH, '#!/bin/sh\nnpm test\n');
    const { out } = await run(sys);
    assert.deepEqual(planned(out, 'This Mac'), []);
    assert.ok(byHand(out).includes('Once on this Mac: add the line `niyam pre-push "$@"` to the pre-push git hook .git/hooks/pre-push, which is your own.'), out.join('\n'));
    assert.ok(opened(sys)?.body.includes('\n- Add the line `niyam pre-push "$@"` to the pre-push git hook .git/hooks/pre-push, which is your own.\n'), 'the pull request lists it too');
    assert.equal(sys.files.get(PRE_PUSH), '#!/bin/sh\nnpm test\n');
  });

  it('writes the hook where git keeps hooks inside the repository', async () => {
    const sys = fresh();
    sys.execOverride = (call) => (call.args[1] === '--git-path' ? { code: 0, stdout: `${ROOT}/.git/hooks/pre-push\n`, stderr: '' } : undefined);
    await run(sys);
    assert.equal(sys.files.get(`${ROOT}/.git/hooks/pre-push`), PRE_PUSH_HOOK);
  });

  it('leaves a hooks folder shared by other repositories alone, naming the line to add', async () => {
    const sys = fresh();
    sys.execOverride = (call) => (call.args[1] === '--git-path' ? { code: 0, stdout: '/shared/hooks/pre-push\n', stderr: '' } : undefined);
    const { out } = await run(sys);
    assert.ok(byHand(out).includes('Once on this Mac: add the line `niyam pre-push "$@"` to the pre-push git hook /shared/hooks/pre-push, which git runs from outside this repository.'), out.join('\n'));
    assert.ok(!sys.files.has('/shared/hooks/pre-push'));
  });

  it("asks git in the repository where the hook is, and reads a hook that runs the CLI however it is spaced as this release's", () => {
    const sys = fresh();
    sys.files.set(PRE_PUSH, '#!/bin/sh\nexec  niyam  pre-push "$@"\n');
    const before = sys.calls.length;
    assert.deepEqual(prePushHook(sys, ROOT), { path: '.git/hooks/pre-push', file: PRE_PUSH, state: 'ours' });
    assert.deepEqual(sys.calls.slice(before), [
      { command: 'git', args: ['rev-parse', '--git-path', 'hooks/pre-push'], cwd: ROOT },
      { command: 'git', args: ['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd: ROOT },
    ]);
  });

  it("takes a hook in git's own folder outside the repository, as a worktree's is, or in the repository outside git's folder, as its own to write", () => {
    const answer = (stdout: string) => ({ code: 0, stdout, stderr: '' });
    const worktree = fresh();
    worktree.execOverride = (call) => (call.args[1] === '--git-path' ? answer('/main/.git/hooks/pre-push\n') : call.args.includes('--git-common-dir') ? answer('/main/.git\n') : undefined);
    assert.deepEqual(prePushHook(worktree, ROOT), { path: '/main/.git/hooks/pre-push', file: '/main/.git/hooks/pre-push', state: 'missing' });
    const husky = fresh();
    husky.execOverride = (call) => (call.args[1] === '--git-path' ? answer('.husky/pre-push\n') : undefined);
    assert.deepEqual(prePushHook(husky, ROOT), { path: '.husky/pre-push', file: `${ROOT}/.husky/pre-push`, state: 'missing' });
  });

  it('counts only a hook line that runs the rules, not a mention, nor the command before niyam (P-57)', async () => {
    for (const text of ['#!/bin/sh\n# TODO: niyam pre-push\n', '#!/bin/sh\nnpm test\n  process-rules pre-push "$@"\n']) {
      const sys = fresh();
      sys.files.set(PRE_PUSH, text);
      assert.ok(byHand((await run(sys)).out).includes('Once on this Mac: add the line `niyam pre-push "$@"` to the pre-push git hook .git/hooks/pre-push, which is your own.'), text);
    }
    const ours = fresh();
    ours.files.set(PRE_PUSH, '#!/bin/sh\nnpm test\n  niyam pre-push "$@"\n');
    const { out } = await run(ours);
    assert.deepEqual(planned(out, 'This Mac'), []);
    assert.ok(!byHand(out).some((line) => line.includes('pre-push')));
  });

  describe('a hook that hands off to a body under dvara (#540)', () => {
    // athya_mono's .husky/pre-push since its W-61 (athya-hq/athya_mono#3814), as written.
    const HANDOFF = [
      '#!/usr/bin/env bash',
      "# Athya's pre-push runs from athya-rules, under dvara (0114 W-61).",
      '. scripts/lib/select-node.sh && athya_select_node || exit 1',
      '. scripts/lib/deps-fallback.sh && athya_deps_bootstrap . pre-push || exit 1',
      'B=node_modules/@athya-hq/rules/dvara/hooks/pre-push',
      '[ -x node_modules/.bin/dvara ] || { echo "❌ pre-push: node_modules has no dvara" >&2; exit 1; }',
      '[ -f "$B" ] || { echo "❌ pre-push: athya-rules is not installed" >&2; exit 1; }',
      'exec node_modules/.bin/dvara run "$B" "$@"',
      '',
    ].join('\n');
    const BODY = `${ROOT}/node_modules/@athya-hq/rules/dvara/hooks/pre-push`;
    // athya-rules 0.5.7's body, its niyam lines as written.
    const BODY_TEXT = [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'if [ "$#" -gt 0 ] && [ "${CLAUDE_CODE_REMOTE:-}" != true ] &&',
      '   { [ -n "${NIYAM_AGENT:-}" ] || [ "${CLAUDECODE:-}" = 1 ]; }; then',
      '  cli="$HOME/.config/niyam/bin/niyam"',
      '  [ -x "$cli" ] || cli=niyam',
      '  "$cli" pre-push "$@" <<<"$PREPUSH_REFS" || exit 1',
      'fi',
      'pnpm test',
      '',
    ].join('\n');
    const ADD = 'Once on this Mac: add the line `niyam pre-push "$@"` to the pre-push git hook .git/hooks/pre-push, which is your own.';

    /** A repository whose hook is `hook` and whose body, unless null, is `body`. */
    function handingOff(hook: string, body: string | null = BODY_TEXT): FakeSys {
      const sys = fresh();
      sys.files.set(PRE_PUSH, hook);
      if (body !== null) sys.files.set(BODY, body);
      return sys;
    }

    it("reads athya_mono's hook, whose body runs niyam, as wired: no step by hand, the hook left as it is", async () => {
      const sys = handingOff(HANDOFF);
      assert.deepEqual(prePushHook(sys, ROOT), { path: '.git/hooks/pre-push', file: PRE_PUSH, state: 'body', body: 'node_modules/@athya-hq/rules/dvara/hooks/pre-push' });
      const { out } = await run(sys);
      assert.deepEqual(planned(out, 'This Mac'), []);
      assert.ok(!byHand(out).some((line) => line.includes('pre-push')), out.join('\n'));
      assert.ok(!(opened(sys)?.body ?? '').includes('pre-push git hook'), 'nor the pull request');
      assert.equal(sys.files.get(PRE_PUSH), HANDOFF);
    });

    it('follows a literal path, a braced or quoted variable, and a path through ./ and ..', () => {
      for (const line of [
        'dvara run node_modules/@athya-hq/rules/dvara/hooks/pre-push "$@"',
        'B="node_modules/@athya-hq/rules/dvara/hooks/pre-push"\nexec dvara run ${B} "$@"',
        `exec ./node_modules/.bin/dvara run '${BODY}' "$@"`,
        'exec dvara run ./hooks/../node_modules/@athya-hq/rules/dvara/hooks/pre-push "$@"',
      ]) {
        assert.equal(prePushHook(handingOff(`#!/bin/sh\n${line}\n`), ROOT).state, 'body', line);
      }
    });

    it('follows a hand-off however its words are spaced, a variable of any name, and an indented assignment', () => {
      for (const hook of [
        '  exec  ./node_modules/.bin/dvara  run  node_modules/@athya-hq/rules/dvara/hooks/pre-push  "$@" ',
        'BODY=node_modules/@athya-hq/rules/dvara/hooks/pre-push\nexec dvara run "$BODY" "$@"',
        'BODY=node_modules/@athya-hq/rules/dvara/hooks/pre-push\nexec dvara run ${BODY} "$@"',
        '  B=node_modules/@athya-hq/rules/dvara/hooks/pre-push \nexec dvara run "$B" "$@"',
        'B=node_modules/@athya-hq/rules/dvara/hooks/pre-push\nexec dvara run "$B" "$@"\nB=other',
        `${HANDOFF}  #node_modules/.bin/dvara run other "$@"`,
      ]) {
        assert.equal(prePushHook(handingOff(`#!/bin/sh\n${hook}\n`), ROOT).state, 'body', hook);
      }
    });

    it('takes a hand-off after blocks closed on their own lines, on one line, by elif, and in an expansion as run', () => {
      for (const before of [
        'if [ -n "$X" ]; then\n  echo x\nelif [ -n "$Y" ]; then\n  echo y\nfi',
        'true;if [ -n "$X" ]; then :;fi',
        'true; if [ -n "$X" ]; then :; fi',
        'echo done',
        'echo "${X:-{}"',
      ]) {
        assert.equal(prePushHook(handingOff(HANDOFF.replace('exec node_modules', `${before}\nexec node_modules`)), ROOT).state, 'body', before);
      }
    });

    it('leaves a hand-off it would read only by a looser match as the client\'s own, even where that match names a body', () => {
      const PATH = 'node_modules/@athya-hq/rules/dvara/hooks/pre-push';
      for (const [why, hook, planted] of [
        ['a hand-off after a command', `true && dvara run ${PATH} "$@"`],
        ['a hand-off followed by more', `dvara run ${PATH} "$@" || exit 1`],
        ['a quote after a word', `dvara run x'${PATH}' "$@"`],
        ['a word after a quote', `dvara run '${PATH}'x "$@"`],
        ['a variable after a word', `B=${PATH}\ndvara run x$B "$@"`],
        ['a variable before a path', `B=${PATH}\ndvara run $B/ "$@"`],
        ['the variable only exported', `export B=${PATH}\ndvara run "$B" "$@"`],
        ['the variable set inside another assignment', 'C=B=x\ndvara run "$B" "$@"', `${ROOT}/B=x`],
        ['a glob', 'dvara run hooks/* "$@"', `${ROOT}/hooks/*`],
      ] as const) {
        const sys = handingOff(`#!/bin/sh\n${hook}\n`);
        if (planted !== undefined) sys.files.set(planted, BODY_TEXT);
        assert.equal(prePushHook(sys, ROOT).state, 'own', why);
      }
    });

    it("leaves as the client's own any hand-off it cannot follow to a body that runs niyam", async () => {
      const misses: [string, string, string?][] = [
        ['the body is not there', HANDOFF],
        ['the body runs no niyam', HANDOFF, '#!/bin/sh\npnpm test\n# "$cli" pre-push is run elsewhere\n'],
        ['the hand-off is a comment', HANDOFF.replace('exec node_modules', '# exec node_modules')],
        ['the variable is never assigned', HANDOFF.replace('B=node_modules', 'C=node_modules')],
        ['the variable is assigned twice', HANDOFF.replace('B=node_modules', 'B=other\nB=node_modules')],
        ['the variable is built from another', HANDOFF.replace('B=node_modules', 'B=$HOME/node_modules')],
        ['the variable is set again with a comment', HANDOFF.replace('[ -x', 'B=other # note\n[ -x')],
        ['the variable is exported again', HANDOFF.replace('[ -x', 'export B=other\n[ -x')],
        ['the variable is set again from a command', HANDOFF.replace('[ -x', 'B="$(cmd arg)"\n[ -x')],
        ['the variable is set again on a condition', HANDOFF.replace('[ -x', '[ -n "$X" ] && B=other\n[ -x')],
        ['the variable is added to', HANDOFF.replace('[ -x', 'B+=/x\n[ -x')],
        ['the variable is set after the hand-off', HANDOFF.replace('B=node_modules/@athya-hq/rules/dvara/hooks/pre-push\n', '').replace('"$B" "$@"\n', '"$B" "$@"\nB=node_modules/@athya-hq/rules/dvara/hooks/pre-push\n')],
        ['the variable is only set with a comment', HANDOFF.replace('B=node_modules/@athya-hq/rules/dvara/hooks/pre-push', 'B=node_modules/@athya-hq/rules/dvara/hooks/pre-push # body')],
        ['the hand-off is inside an if block', HANDOFF.replace('exec node_modules', 'if [ -n "$X" ]; then\n  exec node_modules').replace('"$B" "$@"\n', '"$B" "$@"\nfi\n')],
        ['the hand-off is inside a function', HANDOFF.replace('exec node_modules', 'push() {\n  exec node_modules').replace('"$B" "$@"\n', '"$B" "$@"\n}\n')],
        ['the hand-off is inside a loop', HANDOFF.replace('exec node_modules', 'while false; do\nexec node_modules').replace('"$B" "$@"\n', '"$B" "$@"\ndone\n')],
        ['the variable is set inside an if block', HANDOFF.replace('B=node_modules/@athya-hq/rules/dvara/hooks/pre-push', 'if [ -n "$X" ]; then\nB=node_modules/@athya-hq/rules/dvara/hooks/pre-push\nfi')],
        ['the path leaves the repository', '#!/bin/sh\nexec dvara run ../elsewhere/pre-push "$@"\n'],
        ['git\'s arguments are not passed', HANDOFF.replace('"$B" "$@"', '"$B"')],
        ['two hand-offs', `${HANDOFF}exec dvara run other "$@"\n`],
        ['a marker comment alone', '#!/bin/sh\n# niyam onboard recognises the "$cli" pre-push line\npnpm test\n'],
      ];
      for (const [why, hook, body] of misses) {
        const sys = handingOff(hook, why === 'the body is not there' ? null : body);
        sys.files.set(join(ROOT, '../elsewhere/pre-push'), BODY_TEXT);
        assert.equal(prePushHook(sys, ROOT).state, 'own', why);
      }
      const unreadable = handingOff(HANDOFF);
      const read = unreadable.read.bind(unreadable);
      unreadable.read = (path: string) => {
        if (path === BODY) throw new Error('EISDIR: illegal operation on a directory');
        return read(path);
      };
      assert.equal(prePushHook(unreadable, ROOT).state, 'own', 'a body it cannot read');
      const closed = 'if [ -n "$X" ]; then echo x; fi\n[ -x d ] || { echo "${B} missing"; exit 1; }\n';
      assert.equal(prePushHook(handingOff(HANDOFF.replace('exec node_modules', `${closed}exec node_modules`)), ROOT).state, 'body', 'blocks closed before the hand-off');
      const { out } = await run(handingOff(HANDOFF, null));
      assert.ok(byHand(out).includes(ADD), out.join('\n'));
    });
  });

  it('replaces a workflow that differs', async () => {
    const sys = fresh();
    sys.files.set(WORKFLOW, 'old');
    sys.route('GET', REPO, { status: 200, json: repoJson(true, 'trunk') });
    const { out } = await run(sys);
    assert.ok(planned(out, 'Pull request').includes('workflow: replaced'), out.join('\n'));
    assert.match(repo(sys).get(WORKFLOW) ?? '', /branches: \["trunk"\]/);
  });


  it('moves only the version pins of a workflow already split', async () => {
    const sys = fresh();
    const own = full('main', '0.5.2').replace('name: niyam\n', 'name: niyam\n# Our own note.\n');
    sys.files.set(WORKFLOW, own);
    const { out } = await run(sys);
    assert.ok(planned(out, 'Pull request').includes(`workflow: pins → v${packageVersion()}`), out.join('\n'));
    assert.ok(opened(sys)?.body.includes(`in .github/workflows/niyam.yml, move the version pins from v0.5.2 to v${packageVersion()}, leaving the rest as it is`));
    assert.equal(repo(sys).get(WORKFLOW), own.replaceAll('0.5.2', packageVersion()));
    assert.deepEqual([...sys.deleted], []);
  });



  it('leaves a split workflow at this release alone', async () => {
    const sys = fresh();
    const own = full('main', packageVersion()).replace('name: niyam\n', 'name: niyam\n# Our own note.\n');
    sys.files.set(WORKFLOW, own);
    const { out } = await run(sys);
    assert.ok(!planned(out, 'Pull request').some((item) => item.startsWith('workflow')), out.join('\n'));
    assert.equal(repo(sys).get(WORKFLOW), own);
  });

  it("refuses to pin a release whose tag is not on main, or when GitHub cannot say, changing nothing (P-61)", async () => {
    const compare = `/repos/veda-hq/niyam/compare/refs/tags/v${packageVersion()}...refs/heads/main?per_page=1`;
    for (const [answer, message] of [
      [
        { status: 200, json: { status: 'diverged', base_commit: { sha: '7c'.repeat(20) } } },
        `onboard: the v${packageVersion()} tag is on commit ${'7c'.repeat(6)}, which is not on veda-hq/niyam's main (GitHub's comparison: "diverged"); a release comes only from main, so this tag is not one; nothing changed`,
      ],
      [{ status: 502, json: null }, `onboard: GitHub answered HTTP 502 when asked whether the v${packageVersion()} tag is on main; nothing changed`],
    ] as const) {
      const sys = fresh();
      sys.route('GET', compare, answer);
      const before = new Map(sys.files);
      const { code, err } = await run(sys);
      assert.deepEqual({ code, err }, { code: 1, err: [message] });
      assert.deepEqual(sys.files, before, 'writes nothing');
      assert.equal(sys.requests.find((request) => request.url.endsWith(compare))?.token, TOKEN, "asks with the agent's token (#546)");
      assert.equal(sys.requests.some((request) => request.method !== 'GET'), false, 'changes nothing on GitHub');
    }
  });

  it('refuses inside an agent session, named by NIYAM_AGENT', async () => {
    for (const env of [{ NIYAM_AGENT: AGENT }]) {
      const sys = fresh();
      Object.assign(sys.env, env);
      assert.deepEqual(await run(sys), { code: 1, out: [], err: ['onboard: run it in your own terminal, not in an agent session'] }, JSON.stringify(env));
    }
  });

  for (const [name, named, change, message] of [
    [
      'without accounts the first time, when this Mac suggests none',
      [],
      (sys: FakeSys) => {
        sys.ghToken = undefined;
        sys.answers = ['', ''];
      },
      'onboard: name the owner and the agent account: niyam onboard <owner> <agent>',
    ],
    ['the same account twice', ['example-owner', 'Example-Owner'], () => undefined, 'onboard: the owner and the agent must be different accounts'],
    [
      'accounts other than the settings name',
      ['someone', AGENT],
      (sys: FakeSys) => sys.files.set(SETTINGS, JSON.stringify({ owner: 'example-owner', agent: AGENT })),
      'onboard: .github/niyam.json already names owner example-owner and agent ExampleBot; edit or delete it to change them',
    ],
    [
      'a Mac not set up for the agent',
      ['example-owner', AGENT],
      (sys: FakeSys) => sys.keychain.clear(),
      'onboard: this Mac is not set up for ExampleBot (no token stored for ExampleBot); run niyam machine ExampleBot, then onboard again',
    ],
  ] as const) {
    it(`refuses ${name}`, async () => {
      const sys = fresh();
      sys.route('GET', '/users/Example-Owner', { status: 200, json: { id: 1, login: 'example-owner' } });
      change(sys);
      const { code, err } = await run(sys, [...named]);
      assert.deepEqual({ code, err }, { code: 1, err: [message] });
    });
  }

  describe('finding the accounts', () => {
    /** A Mac where machine set up the agent, and the owner's browser approves the sign-in. */
    function setUp(agents: string[]): FakeSys {
      const sys = fresh();
      for (const agent of agents) {
        sys.files.set(`${sys.home}/.config/niyam/${agent.toLowerCase()}/session.sh`, sessionScript(agent, 42, pathsFor(sys.home, agent)));
      }
      sys.files.set(`${sys.home}/.config/niyam/locked/gh/hosts.yml`, '');
      return sys;
    }

    it("takes the one-run sign-in's login as owner and the one agent set up here, with Enter", async () => {
      const sys = setUp([AGENT]);
      sys.answers = ['', '', 'y'];
      const { code, out } = await run(sys, []);
      assert.equal(code, 0);
      assert.equal(out[0], '◇  Sign in to GitHub as the owner, for this run only: repo, project, admin:org', 'no owner is known before the sign-in, which comes before the plan');
      assert.match(opened(sys)?.body ?? '', /^- onboard signed in before showing its plan, to suggest the owner by the account the browser signed in as\.$/m);
      assert.deepEqual(sys.asked.slice(0, 2), ['The owner, who approves [example-owner]: ', 'The agent, which builds [ExampleBot]: ']);
      assert.deepEqual(JSON.parse(repo(sys).get(SETTINGS) ?? '').owner, 'example-owner');
      assert.equal(signIns(sys), 1, 'the sign-in that suggested the owner serves the board too');
    });

    it('lists the agents set up here and takes what is typed', async () => {
      const sys = setUp(['OtherBot', AGENT]);
      sys.answers = ['', 'examplebot', 'y'];
      const { code, out } = await run(sys, []);
      assert.equal(code, 0);
      assert.ok(out.includes('Accounts set up here for the agent: OtherBot, ExampleBot'));
      assert.equal(JSON.parse(repo(sys).get(SETTINGS) ?? '').agent, AGENT);
    });

    it('asks for both accounts when run with no arguments at all', async () => {
      const sys = setUp([AGENT]);
      sys.answers = ['', '', 'y'];
      const { io, err } = capture();
      assert.equal(await onboard(sys, io), 0, err.join('\n'));
      assert.deepEqual(sys.asked.slice(0, 2), ['The owner, who approves [example-owner]: ', 'The agent, which builds [ExampleBot]: ']);
    });

    it("names why this Mac is not set up for the agent: a token GitHub answers for someone else, or no signing key", async () => {
      const someone = fresh();
      someone.acceptToken(TOKEN, 'someone');
      const wrong = await run(someone);
      assert.deepEqual({ code: wrong.code, err: wrong.err }, { code: 1, err: ['onboard: this Mac is not set up for ExampleBot (the token acts as someone, not ExampleBot); run niyam machine ExampleBot, then onboard again'] });
      const keyless = fresh();
      const { key } = pathsFor(HOME, AGENT);
      keyless.files.delete(key);
      const missing = await run(keyless);
      assert.deepEqual({ code: missing.code, err: missing.err }, { code: 1, err: [`onboard: this Mac is not set up for ExampleBot (${key} is missing); run niyam machine ExampleBot, then onboard again`] });
    });

    it("reads with no other agent's token for an agent named that has none here", async () => {
      const sys = setUp([AGENT]);
      sys.route('GET', '/users/OtherBot', { status: 200, json: { id: 7, login: 'OtherBot' } });
      const { code, err } = await run(sys, ['example-owner', 'OtherBot']);
      assert.equal(code, 1);
      assert.deepEqual(err, ['onboard: this Mac is not set up for OtherBot (no token stored for OtherBot); run niyam machine OtherBot, then onboard again']);
      const release = sys.requests.filter((request) => request.url.includes('/compare/refs/tags/'));
      assert.ok(release.length > 0 && release.every((request) => request.token === undefined), JSON.stringify(release));
    });

    it('lists no accounts for one suggestion, and reads an answer of spaces as Enter and one in spaces as typed', async () => {
      const sys = setUp([AGENT]);
      sys.answers = ['   ', ' examplebot ', 'y'];
      const { code, out } = await run(sys, []);
      assert.equal(code, 0);
      assert.ok(!out.some((line) => line.startsWith('Accounts set up here')), out.join('\n'));
      assert.deepEqual(sys.asked.slice(0, 2), ['The owner, who approves [example-owner]: ', 'The agent, which builds [ExampleBot]: ']);
      assert.deepEqual(JSON.parse(repo(sys).get(SETTINGS) ?? ''), { owner: 'example-owner', agent: AGENT, features: [...FEATURES] });
    });

    it('refuses to ask for the agent with no terminal to ask in', async () => {
      const sys = setUp([AGENT]);
      sys.tty = false;
      const { code, err } = await run(sys, ['example-owner', '--yes']);
      assert.deepEqual({ code, err }, { code: 1, err: ['onboard: name the owner and the agent account: niyam onboard <owner> <agent>'] });
      assert.deepEqual(sys.asked, []);
    });

    it('warns an organisation of no feature that needs issue types', async () => {
      const sys = fresh();
      sys.files.set(SETTINGS, JSON.stringify({ owner: 'example-owner', agent: AGENT, features: [...FEATURES] }));
      const { code, out } = await run(sys, []);
      assert.equal(code, 0);
      assert.ok(!out.some((line) => line.includes('organisations only')), out.join('\n'));
    });

    it('suggests no owner when the sign-in fails or GitHub will not answer', async () => {
      const sys = setUp([AGENT]);
      sys.ghToken = 'gho_unknown';
      sys.answers = ['', ''];
      assert.deepEqual((await run(sys, [])).err, ['onboard: name the owner and the agent account: niyam onboard <owner> <agent>']);
      assert.equal(sys.asked[0], 'The owner, who approves: ');
      const down = setUp([AGENT]);
      // GitHub answers whether the release is on main, then nothing more.
      const answers = down.http.bind(down);
      down.http = (url, options) => (url.includes('/compare/') ? answers(url, options) : Promise.reject(new Error('offline')));
      down.answers = ['', ''];
      assert.deepEqual((await run(down, [])).err, ['onboard: name the owner and the agent account: niyam onboard <owner> <agent>']);
      assert.equal(down.asked[0], 'The owner, who approves: ');
    });
  });

  describe("the owner's one-run sign-in", () => {
    /** The scopes onboard's sign-in asked gh for, one list per sign-in. */
    const asked = (sys: FakeSys): string[][] =>
      sys.calls.filter((c) => c.args[1] === 'login').map((c) => (c.args.includes('-s') ? (c.args[c.args.indexOf('-s') + 1] ?? '').split(',') : []));

    it("signs in once, for the board's scopes, with the owner's gh folder untouched and the temporary one gone", async () => {
      const sys = fresh();
      sys.files.set(`${sys.home}/.config/gh/hosts.yml`, 'github.com:\n    oauth_token: gho_owners_own\n');
      const { code, out } = await run(sys);
      assert.equal(code, 0);
      assert.deepEqual(asked(sys), [['project', 'admin:org']]);
      const line = out.indexOf('◇  Sign in to GitHub as example-owner, for this run only: repo, project, admin:org');
      assert.ok(line >= 0, out.join('\n'));
      // gh's code and link, without its lines about the temporary folder's setup.
      assert.deepEqual(out.slice(line + 1, line + 4), ['│  one-time code 1881-F156 (copied)', '│  approve it at https://github.com/login/device', '◇  Signed in as example-owner']);
      assert.ok(!out.some((text) => /plain text|git protocol|Logged in as|Authentication complete/.test(text)), out.join('\n'));
      assert.deepEqual(sys.removed, sys.temps);
      const gh = sys.calls.filter((c) => c.command === 'gh');
      assert.ok(gh.length > 0 && gh.every((c) => c.env?.GH_CONFIG_DIR === sys.temps[0]), "gh never runs on the owner's own folder");
      assert.equal(sys.files.get(`${sys.home}/.config/gh/hosts.yml`), 'github.com:\n    oauth_token: gho_owners_own\n');
      assert.ok(!sys.requests.some((r) => r.token === 'gho_owners_own'));
    });

    it('asks a personal repository for projects alone', async () => {
      const sys = fresh();
      sys.route('GET', '/users/example-org', { status: 200, json: { login: 'example-org', type: 'User' } });
      sys.route('GET', REPO, { status: 200, json: repoJson(false) });
      sys.acceptToken(OWNER_TOKEN, 'example-owner', { 'x-oauth-scopes': 'repo, project' });
      assert.equal((await run(sys)).code, 0);
      assert.deepEqual(asked(sys), [['project']]);
    });

    it('does not sign in when no step needs the owner', async () => {
      const sys = fresh();
      assert.equal((await run(sys, ['example-owner', AGENT, '--features', 'identity,pr-identity'])).code, 0);
      assert.equal(signIns(sys), 0);
    });

    it("signs in for the board's scopes when --add turns it on", async () => {
      const sys = fresh();
      sys.files.set(SETTINGS, JSON.stringify({ owner: 'example-owner', agent: AGENT, features: ['identity'] }));
      assert.equal((await run(sys, ['--add', 'board'])).code, 0);
      assert.deepEqual(asked(sys), [['project', 'admin:org']]);
      assert.deepEqual(sys.removed, sys.temps);
    });

    it('says it signed in as no one when the sign-in is turned down', async () => {
      const sys = fresh();
      sys.ghToken = undefined;
      const { code, out } = await run(sys);
      assert.equal(code, 1);
      assert.ok(out.includes('◇  Sign in to GitHub as example-owner, for this run only: repo, project, admin:org'), out.join('\n'));
      assert.ok(!out.some((line) => line.startsWith('◇  Signed in as')), out.join('\n'));
    });

    for (const [name, change, message] of [
      ['a sign-in as someone else', (sys: FakeSys) => sys.acceptToken(OWNER_TOKEN, 'someone'), 'onboard: the browser signed in to GitHub as someone, not the owner example-owner; sign in to github.com there as example-owner and run it again'],
      ['a sign-in turned down', (sys: FakeSys) => (sys.ghToken = undefined), 'onboard: the GitHub sign-in in the browser did not finish'],
    ] as const) {
      it(`stops at ${name}, with the temporary folder gone`, async () => {
        const sys = fresh();
        change(sys);
        const { code, err } = await run(sys);
        // The board app is the first step that acts as the owner.
        assert.deepEqual({ code, err }, { code: 1, err: [message, 'onboard: stopped at "board app"; nothing after it was changed, and no pull request was opened'] });
        assert.equal(sys.temps.length, 1);
        assert.deepEqual(sys.removed, sys.temps);
        assert.ok(!sys.requests.some((r) => /\/labels|\/issue-types|\/graphql$/.test(r.url) && (r.method !== 'GET' || r.token === OWNER_TOKEN)), 'the board is not touched');
      });
    }
  });

  describe('a personal repository', () => {
    /** A repository a personal account owns: GitHub gives it no issue types. */
    function personal(): FakeSys {
      const sys = fresh();
      sys.route('GET', '/users/example-org', { status: 200, json: { login: 'example-org', type: 'User' } });
      sys.route('GET', REPO, { status: 200, json: repoJson(false) });
      sys.acceptToken(OWNER_TOKEN, 'example-owner', { 'x-oauth-scopes': 'repo, project' });
      return sys;
    }
    const WHY = 'example-org/example-app is owned by a personal account, and GitHub has issue types for organisations only';

    it('gets the features it can run when none are named, saying which it left off', async () => {
      const sys = personal();
      const { code, out } = await run(sys);
      assert.equal(code, 0);
      assert.equal(out[2], '│  ! personal account: work-rules, figma, decisions left off');
      assert.ok(!planned(out, 'GitHub').some((item) => item.startsWith('issue types')), 'GitHub has issue types for organisations only');
      assert.deepEqual(JSON.parse(repo(sys).get(SETTINGS) ?? '').features, ['identity', 'pr-identity', 'board', 'review']);
      assert.equal(repo(sys).get(WORKFLOW), workflow('main', packageVersion(), false, undefined, undefined, true));
    });

    it('refuses --features that need issue types, writing nothing', async () => {
      const sys = personal();
      const { code, err } = await run(sys, ['example-owner', AGENT, '--features', 'board,work-rules']);
      assert.deepEqual({ code, err }, { code: 1, err: [`onboard: ${WHY}, so work-rules cannot run here; leave it out of --features`] });
      assert.equal(repo(sys).get(SETTINGS), undefined);
      const both = personal();
      assert.deepEqual((await run(both, ['example-owner', AGENT, '--features', 'decisions,figma'])).err, [`onboard: ${WHY}, so figma, decisions cannot run here; leave them out of --features`]);
    });

    it('takes --features that need no issue types', async () => {
      const sys = personal();
      assert.equal((await run(sys, ['example-owner', AGENT, '--features', 'pr-identity'])).code, 0);
      assert.deepEqual(JSON.parse(repo(sys).get(SETTINGS) ?? '').features, ['identity', 'pr-identity']);
    });

    for (const feature of ['work-rules', 'figma', 'decisions']) {
      it(`refuses --add ${feature}, changing nothing`, async () => {
        const sys = personal();
        const settings = JSON.stringify({ owner: 'example-owner', agent: AGENT, features: ['identity'] });
        sys.files.set(SETTINGS, settings);
        const { code, err } = await run(sys, ['--add', feature]);
        assert.deepEqual({ code, err }, { code: 1, err: [`onboard: ${WHY}, so ${feature} cannot run here`] });
        assert.equal(repo(sys).get(SETTINGS), settings);
        assert.deepEqual(sys.chosen, []);
      });
    }

    it('refuses --add before renaming an older feature, changing nothing', async () => {
      const sys = personal();
      const settings = JSON.stringify({ owner: 'example-owner', agent: AGENT, features: ['identity', 'design'] });
      sys.files.set(SETTINGS, settings);
      assert.equal((await run(sys, ['--add', 'work-rules'])).code, 1);
      assert.equal(repo(sys).get(SETTINGS), settings);
      assert.deepEqual(sys.chosen, []);
    });

    it('names the features its settings list that cannot run there', async () => {
      const sys = personal();
      sys.files.set(SETTINGS, JSON.stringify({ owner: 'example-owner', agent: AGENT, features: ['identity', 'decisions'] }));
      const { code, out } = await run(sys, []);
      assert.equal(code, 0);
      assert.equal(out[2], '│  ! decisions: organisations only; take it out of features');
    });

    it('takes --add of a feature already on, or of one that needs no issue types', async () => {
      for (const [features, add] of [
        [['identity', 'work-rules'], 'work-rules'],
        [['identity'], 'review'],
      ] as const) {
        const sys = personal();
        sys.files.set(SETTINGS, JSON.stringify({ owner: 'example-owner', agent: AGENT, features }));
        const { code, err } = await run(sys, ['--add', add]);
        assert.deepEqual({ code, err }, { code: 0, err: [] }, add);
      }
    });

    it('warns of no feature its settings list that runs there, and names several that cannot', async () => {
      const none = personal();
      none.files.set(SETTINGS, JSON.stringify({ owner: 'example-owner', agent: AGENT, features: ['identity', 'board'] }));
      const fine = await run(none, []);
      assert.equal(fine.code, 0);
      assert.ok(!fine.out.some((line) => line.includes('organisations only')), fine.out.join('\n'));
      const several = personal();
      several.files.set(SETTINGS, JSON.stringify({ owner: 'example-owner', agent: AGENT, features: ['identity', 'work-rules', 'decisions'] }));
      const { out } = await run(several, []);
      assert.equal(out[2], '│  ! work-rules, decisions: organisations only; take them out of features');
    });

    it('asks GitHub once whether an organisation owns it', async () => {
      const sys = personal();
      await run(sys);
      assert.equal(sys.requests.filter((r) => r.url.endsWith('/users/example-org')).length, 1);
    });
  });

  describe('where sarathi runs the hooks (P-66)', () => {
    const SARATHI = `${ROOT}/${SARATHI_PATH}`;
    const runner = (event: string, timeout: number, matcher?: string) => ({
      ...(matcher === undefined ? {} : { matcher }),
      hooks: [{ type: 'command', command: `"$CLAUDE_PROJECT_DIR"/.claude/hooks/sarathi.sh ${event}`, timeout }],
    });
    /** veda's settings as onboarding left them: sarathi's entry per event, and niyam's two hooks beside them. */
    const VEDA = {
      permissions: { allow: ALLOW },
      hooks: {
        SessionStart: [runner('SessionStart', 120), SESSION_ENTRY],
        PreToolUse: [runner('PreToolUse', 70, 'Bash|Edit|Write|MultiEdit|NotebookEdit'), GUARD_ENTRY],
        Stop: [runner('Stop', 15)],
      },
      env: BASE_ENV,
    };
    const LIST = { kavach: { python: 'python3' }, hooks: { PreToolUse: [{ matcher: 'Bash', guard: 'command' }], Stop: [{ command: 'echo stop', timeout: 10 }] } };
    const UNDER_SARATHI = {
      ...VEDA,
      hooks: { SessionStart: [runner('SessionStart', 600)], PreToolUse: [runner('PreToolUse', 70, 'Bash|Edit|Write|MultiEdit|NotebookEdit')], Stop: [runner('Stop', 15)] },
    };
    const HANDLERS = { ...LIST, hooks: { ...LIST.hooks, PreToolUse: [...LIST.hooks.PreToolUse, SARATHI_HANDLERS.PreToolUse], SessionStart: [SARATHI_HANDLERS.SessionStart] } };

    it('writes the handlers sarathi needs, the command each hook runs today', () => {
      assert.deepEqual(SARATHI_HANDLERS, {
        SessionStart: { command: HOOK_COMMAND, timeout: 600 },
        PreToolUse: { matcher: 'Bash', command: GUARD_COMMAND, failClosed: true },
      });
    });

    it("moves niyam's hooks out of settings.json into sarathi.json, and gives sarathi's SessionStart entry their time", () => {
      const before = `${JSON.stringify(VEDA, null, 2)}\n`;
      const { text, changes, labels, sarathi } = claudeSettings(before, `${JSON.stringify(LIST, null, 2)}\n`);
      assert.deepEqual(JSON.parse(text), UNDER_SARATHI);
      assert.deepEqual(changes, [
        `take out the SessionStart hook that runs niyam session-start, which ${SARATHI_PATH} now runs under sarathi`,
        "give sarathi's SessionStart hook 600 s, so niyam's handler under it has its time",
        `take out the PreToolUse hook that refuses gh and git's remote commands outside the agent identity, which ${SARATHI_PATH} now runs under sarathi`,
      ]);
      assert.deepEqual(labels, ['hooks moved to sarathi.json', 'sarathi timeout']);
      assert.deepEqual(JSON.parse(sarathi?.text ?? ''), HANDLERS);
      assert.deepEqual(sarathi?.changes, [
        'add the SessionStart hook that runs niyam session-start, as a handler sarathi runs',
        "add the PreToolUse hook that refuses gh and git's remote commands outside the agent identity, as a handler sarathi runs",
      ]);
      assert.deepEqual(sarathi?.labels, ['hooks added']);
      assert.ok((sarathi?.text ?? '').startsWith('{\n  "kavach": {\n    "python": "python3"\n  },'), 'in the file\'s layout');
      // Run again: nothing more in either file.
      assert.deepEqual(claudeSettings(text, sarathi?.text), { text, changes: [], labels: [] });
    });

    it('swaps an older command in sarathi.json in place, and adds nothing to settings.json', () => {
      const list = { hooks: { SessionStart: [{ command: OLDER_HOOK_COMMANDS[0], timeout: 600 }], PreToolUse: [{ matcher: 'Bash', command: OLDER_GUARD_COMMANDS[0], failClosed: true }] } };
      const before = JSON.stringify(UNDER_SARATHI);
      const { text, changes, sarathi } = claudeSettings(before, JSON.stringify(list));
      assert.equal(text, before);
      assert.deepEqual(changes, []);
      assert.deepEqual(JSON.parse(sarathi?.text ?? ''), { hooks: { SessionStart: [SARATHI_HANDLERS.SessionStart], PreToolUse: [SARATHI_HANDLERS.PreToolUse] } });
      assert.deepEqual(sarathi?.changes, [
        "replace the older SessionStart hook that runs niyam session-start with this release's",
        "replace the older PreToolUse hook that refuses gh and git's remote commands outside the agent identity with this release's",
      ]);
      assert.deepEqual(sarathi?.labels, ['hooks updated']);
    });

    it("takes an older release's hook out of settings.json, and niyam's hook alone out of a group it shares", () => {
      const settings = {
        ...UNDER_SARATHI,
        hooks: { ...UNDER_SARATHI.hooks, SessionStart: [{ hooks: [{ type: 'command', command: 'echo hi' }, { type: 'command', command: OLDER_HOOK_COMMANDS[1] }] }, runner('SessionStart', 600)] },
      };
      const { text, changes } = claudeSettings(JSON.stringify(settings), JSON.stringify(HANDLERS));
      assert.deepEqual(JSON.parse(text).hooks.SessionStart, [{ hooks: [{ type: 'command', command: 'echo hi' }] }, runner('SessionStart', 600)]);
      assert.deepEqual(changes, [`take out the SessionStart hook that runs niyam session-start, which ${SARATHI_PATH} now runs under sarathi`]);
    });

    it("takes out niyam's hooks past groups that are not hooks, and times a sarathi entry that gives no time", () => {
      const untimed = { hooks: [{ type: 'command', command: `"$CLAUDE_PROJECT_DIR"/.claude/hooks/sarathi.sh SessionStart` }] };
      const odd = [null, { hooks: [] }, { hooks: 'x' }, { hooks: [null, { type: 'command', command: HOOK_COMMAND }] }];
      const settings = { ...UNDER_SARATHI, hooks: { ...UNDER_SARATHI.hooks, SessionStart: [...odd, untimed] } };
      const { text, changes, labels } = claudeSettings(JSON.stringify(settings), JSON.stringify(HANDLERS));
      assert.deepEqual(JSON.parse(text).hooks.SessionStart, [null, { hooks: [] }, { hooks: 'x' }, { hooks: [null] }, runner('SessionStart', 600)]);
      assert.deepEqual(changes, [
        `take out the SessionStart hook that runs niyam session-start, which ${SARATHI_PATH} now runs under sarathi`,
        "give sarathi's SessionStart hook 600 s, so niyam's handler under it has its time",
      ]);
      assert.deepEqual(labels, ['hooks moved to sarathi.json', 'sarathi timeout']);
    });

    it("gives a handler moved there by hand session-start's 600 s, and sarathi's PreToolUse entry the guard's 60 s", () => {
      const settings = { ...UNDER_SARATHI, hooks: { ...UNDER_SARATHI.hooks, PreToolUse: [runner('PreToolUse', 30, 'Bash')] } };
      const list = { hooks: { SessionStart: [{ command: HOOK_COMMAND }], PreToolUse: [SARATHI_HANDLERS.PreToolUse] } };
      const { text, changes, labels, sarathi } = claudeSettings(JSON.stringify(settings), JSON.stringify(list));
      assert.deepEqual(JSON.parse(text).hooks.PreToolUse, [runner('PreToolUse', 60, 'Bash')]);
      assert.deepEqual(changes, ["give sarathi's PreToolUse hook 60 s, so niyam's handler under it has its time"]);
      assert.deepEqual(labels, ['sarathi timeout']);
      assert.deepEqual(JSON.parse(sarathi?.text ?? '').hooks.SessionStart, [SARATHI_HANDLERS.SessionStart]);
      assert.deepEqual(sarathi?.changes, ['give the SessionStart hook that runs niyam session-start 600 s, as long as Claude Code gives it in the settings']);
      assert.deepEqual(sarathi?.labels, ['timeout']);
    });

    it("keeps a hook in settings.json for an event sarathi doesn't run, or runs with a matcher that hides it", () => {
      // sarathi runs PreToolUse for Edit alone, and no SessionStart.
      const settings = { hooks: { PreToolUse: [runner('PreToolUse', 70, 'Edit|Write')], Stop: [runner('Stop', 15)] }, env: BASE_ENV, permissions: { allow: ALLOW } };
      const { text, changes, sarathi } = claudeSettings(JSON.stringify(settings), JSON.stringify(LIST));
      assert.deepEqual(JSON.parse(text).hooks, { ...settings.hooks, PreToolUse: [runner('PreToolUse', 70, 'Edit|Write'), GUARD_ENTRY], SessionStart: [SESSION_ENTRY] });
      assert.equal(changes.length, 2);
      assert.equal(sarathi, undefined);
      // An entry with no matcher, or a regular expression that takes Bash, lets the guard fire.
      for (const matcher of [undefined, '*', 'Ba.*']) {
        const all = { hooks: { PreToolUse: [runner('PreToolUse', 70, matcher)] } };
        assert.deepEqual(JSON.parse(claudeSettings(JSON.stringify(all), '{ "hooks": {} }').sarathi?.text ?? '').hooks.PreToolUse, [SARATHI_HANDLERS.PreToolUse], String(matcher));
      }
      // A SessionStart entry for one source alone would hide session-start on resume.
      const startup = { hooks: { SessionStart: [runner('SessionStart', 600, 'startup')] } };
      assert.deepEqual(JSON.parse(claudeSettings(JSON.stringify(startup), '{ "hooks": {} }').text).hooks.SessionStart, [runner('SessionStart', 600, 'startup'), SESSION_ENTRY]);
    });

    it("leaves settings.json alone where there is no sarathi.json, even when it runs sarathi", () => {
      const { text, sarathi } = claudeSettings(JSON.stringify(VEDA));
      assert.deepEqual(JSON.parse(text), VEDA);
      assert.equal(sarathi, undefined);
    });

    it('refuses a sarathi.json it cannot edit', () => {
      const settings = JSON.stringify(UNDER_SARATHI);
      assert.throws(() => claudeSettings(settings, '{'), /^Error: \.claude\/sarathi\.json is not JSON \(/);
      assert.throws(() => claudeSettings(settings, '[]'), /^Error: \.claude\/sarathi\.json is not a JSON object$/);
      assert.throws(() => claudeSettings(settings, '{ "hooks": [] }'), /^Error: \.claude\/sarathi\.json: hooks is not an object$/);
      for (const text of ['7', 'null']) {
        assert.throws(() => claudeSettings(settings, text), /^Error: \.claude\/sarathi\.json is not a JSON object$/, text);
        assert.throws(() => claudeSettings(text), /^Error: \.claude\/settings\.json is not a JSON object$/, text);
      }
    });

    it("moves the guard under sarathi only where sarathi's matcher, as names or a regular expression, takes Bash", () => {
      const moved = (matcher: string): boolean => claudeSettings(JSON.stringify({ hooks: { PreToolUse: [runner('PreToolUse', 70, matcher)] } }), '{ "hooks": {} }').sarathi !== undefined;
      for (const [matcher, want] of [
        ['^Bash', true],
        ['', true],
        ['Bas', false],
        ['(', false],
      ] as const) {
        assert.equal(moved(matcher), want, matcher);
      }
      const start = claudeSettings(JSON.stringify({ hooks: { SessionStart: [runner('SessionStart', 600, '.*')] } }), '{ "hooks": {} }');
      assert.deepEqual(JSON.parse(start.text).hooks.SessionStart, [runner('SessionStart', 600, '.*'), SESSION_ENTRY], 'a handler for every source is not one any matcher covers');
    });

    it("reads sarathi's entry and its handlers past what is not a hook, and times only niyam's handler", () => {
      assert.equal(sarathiRunner(null, 'PreToolUse'), undefined);
      assert.equal(sarathiRunner({}, 'PreToolUse'), undefined);
      const groups = [null, { hooks: 'x' }, { matcher: 7, hooks: [null, { command: 'echo' }, { command: 'sarathi hook PreToolUse', timeout: 'x' }] }];
      assert.deepEqual(sarathiRunner({ hooks: { PreToolUse: groups } }, 'PreToolUse'), { group: 2, hook: 2 });
      assert.equal(runsSarathiFor('sarathi check', 'PreToolUse'), false);
      assert.equal(runsSarathiFor('run PreToolUse', 'PreToolUse'), false);
      assert.equal(runsSarathiFor('sarathi hook PreToolUse', 'PreToolUse'), true);
      const settings = JSON.stringify(UNDER_SARATHI);
      const listed = claudeSettings(settings, JSON.stringify({ hooks: { PreToolUse: [null, SARATHI_HANDLERS.PreToolUse], SessionStart: [{ command: 'echo other' }, { command: HOOK_COMMAND, timeout: '900' }] } }));
      assert.deepEqual(JSON.parse(listed.sarathi?.text ?? '').hooks, { PreToolUse: [null, SARATHI_HANDLERS.PreToolUse], SessionStart: [{ command: 'echo other' }, { command: HOOK_COMMAND, timeout: 600 }] });
      const short = claudeSettings(settings, JSON.stringify({ hooks: { PreToolUse: [SARATHI_HANDLERS.PreToolUse], SessionStart: [{ command: HOOK_COMMAND, timeout: 60 }] } }));
      assert.deepEqual(JSON.parse(short.sarathi?.text ?? '').hooks.SessionStart, [SARATHI_HANDLERS.SessionStart]);
    });

    it('adds its hook past settings entries that are not hooks, and finds none in a list that is not one', () => {
      const odd = [null, { hooks: 'x' }, { hooks: [null, 'x'] }, { hooks: { type: 'command', command: HOOK_COMMAND } }];
      const { text } = claudeSettings(JSON.stringify({ ...CLAUDE, hooks: { ...CLAUDE.hooks, SessionStart: odd } }));
      assert.deepEqual(JSON.parse(text).hooks.SessionStart, [...odd, SESSION_ENTRY]);
      assert.throws(() => claudeSettings(JSON.stringify({ hooks: { SessionStart: { hooks: [{ type: 'command', command: HOOK_COMMAND }] } } })), /^Error: \.claude\/settings\.json: hooks\.SessionStart is not an array$/);
    });

    it('adds a handler to a sarathi.json with no hooks yet, and finds none in a list that is not one', () => {
      const settings = JSON.stringify({ hooks: { PreToolUse: [runner('PreToolUse', 70, 'Bash')] } });
      assert.deepEqual(JSON.parse(claudeSettings(settings, '{}').sarathi?.text ?? '').hooks, { PreToolUse: [SARATHI_HANDLERS.PreToolUse] });
      assert.throws(() => claudeSettings(settings, JSON.stringify({ hooks: { PreToolUse: { command: GUARD_COMMAND } } })), /^Error: \.claude\/sarathi\.json: hooks\.PreToolUse is not an array$/);
    });

    it("plans each change to sarathi.json, a handler added and one given its time", async () => {
      const sys = fresh();
      sys.files.set(HOOKS, `${JSON.stringify(UNDER_SARATHI, null, 2)}\n`);
      sys.files.set(SARATHI, JSON.stringify({ hooks: { SessionStart: [{ command: HOOK_COMMAND, timeout: 60 }] } }));
      const { code, out } = await run(sys);
      assert.equal(code, 0, out.join('\n'));
      assert.ok(planned(out, 'Pull request').includes('sarathi.json: hooks added, timeout'), out.join('\n'));
    });

    it("opens a pull request that changes both files, and runs again changing nothing", async () => {
      const sys = fresh();
      sys.files.set(HOOKS, `${JSON.stringify(VEDA, null, 2)}\n`);
      sys.files.set(SARATHI, `${JSON.stringify(LIST, null, 2)}\n`);
      const { code, out } = await run(sys);
      assert.equal(code, 0, out.join('\n'));
      const pull = planned(out, 'Pull request');
      assert.ok(pull.includes('settings.json: hooks moved to sarathi.json, sarathi timeout'), pull.join('\n'));
      assert.ok(pull.includes('sarathi.json: hooks added'), pull.join('\n'));
      assert.deepEqual(JSON.parse(repo(sys).get(HOOKS) ?? ''), UNDER_SARATHI);
      assert.deepEqual(JSON.parse(repo(sys).get(SARATHI) ?? ''), HANDLERS);
      assert.ok(opened(sys)?.body.includes(`\n- \`${SARATHI_PATH}\`: add the SessionStart hook that runs niyam session-start, as a handler sarathi runs; `), opened(sys)?.body);
      merge(sys);
      const again = fresh();
      again.files = sys.files;
      const second = await run(again);
      assert.equal(second.code, 0, second.err.join('\n'));
      assert.ok(second.out.some((line) => line.startsWith('◇  ')), 'it planned');
      assert.ok(!planned(second.out, 'Pull request').some((item) => /^s(ettings|arathi)\.json/.test(item)), second.out.join('\n'));
    });
  });

  describe("keeping the client's settings layout", () => {
    it('adds only its entries to an existing file', async () => {
      const sys = fresh();
      const text = '{\n  "env": { "A": "1" },\n  "hooks": {\n    "Stop": [{ "hooks": [] }]\n  }\n}\n';
      sys.files.set(HOOKS, text);
      await run(sys);
      const out = repo(sys).get(HOOKS) ?? '';
      assert.ok(out.startsWith('{\n  "env": { "A": "1",'), out);
      assert.ok(out.includes('\n  "hooks": {\n    "Stop": [{ "hooks": [] }],\n    "SessionStart": ['), out);
      assert.deepEqual(JSON.parse(out), { env: { A: '1', ...BASE_ENV }, hooks: { Stop: [{ hooks: [] }], SessionStart: [SESSION_ENTRY], PreToolUse: [GUARD_ENTRY] }, permissions: { allow: ALLOW } });
    });

    it("swaps an older release's command in the text", async () => {
      const sys = fresh();
      const older = OLDER_HOOK_COMMANDS[0] as string;
      sys.files.set(HOOKS, `{ "env": { "A": "1" }, "hooks": { "SessionStart": [{ "hooks": [{ "type": "command", "command": ${JSON.stringify(older)} }] }] } }\n`);
      await run(sys);
      assert.ok((repo(sys).get(HOOKS) ?? '').includes(`"SessionStart": [{ "hooks": [{ "type": "command", "command": ${JSON.stringify(HOOK_COMMAND)} }] }]`));
    });
  });

  it('refuses a name that is not a login', async () => {
    await assert.rejects(run(fresh(), ['-x', AGENT]), /"-x" is not a GitHub login/);
  });

  it('refuses hooks settings that are not an object', async () => {
    const sys = fresh();
    sys.files.set(HOOKS, '[]');
    await assert.rejects(run(sys), /\.claude\/settings\.json is not a JSON object/);
  });

  it('refuses a Mac whose key is missing', async () => {
    const sys = fresh();
    sys.files.delete(`${sys.home}/.ssh/examplebot_signing`);
    assert.equal((await run(sys)).code, 1);
  });

  describe('agent access', () => {
    it("gives an organisation member access with the owner's one-run token", async () => {
      const sys = fresh();
      let added = false;
      sys.route('GET', REPO, () => (added ? PUSH : { status: 404, json: null }));
      sys.route('GET', '/user/repository_invitations?per_page=100&page=1', { status: 200, json: [] });
      sys.route('PUT', COLLABORATOR, () => {
        added = true;
        return { status: 204, json: null };
      });
      const { code, out } = await run(sys);
      assert.equal(code, 0);
      const put = sys.requests.find((r) => r.method === 'PUT');
      assert.deepEqual([put?.token, put?.body], [OWNER_TOKEN, { permission: 'push' }]);
      assert.equal(signIns(sys), 1, 'one sign-in for the access and the board');
      assert.ok(!sys.requests.some((r) => r.url.includes('/pulls?state=open')), 'an agent that cannot see the repository has no onboard pull request open on it');
      assert.equal(sys.requests.filter((r) => r.url.includes('/user/repository_invitations')).length, 1, 'a member given access has no invitation to read again');
      assert.ok(planned(out, 'Pull request').includes('workflow: new'), out.join('\n'));
      assert.ok(opened(sys)?.body.includes('\n- ExampleBot can push:\n  - gave ExampleBot, which cannot see example-org/example-app, write access, as example-owner\n'), opened(sys)?.body);
    });

    it('stops when GitHub refuses the agent once given access', async () => {
      const sys = fresh();
      let added = false;
      sys.route('GET', REPO, () => (added ? { status: 401, json: null } : { status: 404, json: null }));
      sys.route('GET', '/user/repository_invitations?per_page=100&page=1', { status: 200, json: [] });
      sys.route('PUT', COLLABORATOR, () => {
        added = true;
        return { status: 204, json: null };
      });
      const { code, err } = await run(sys);
      assert.deepEqual({ code, err }, { code: 1, err: ['onboard: GitHub refused (HTTP 401)', 'onboard: stopped at "ExampleBot can push"; nothing after it was changed, and no pull request was opened'] });
    });

    it('plans either merge until the agent can push, then asks the default branch for a merge queue', async () => {
      const sys = fresh();
      let added = false;
      sys.route('GET', REPO, () => (added ? { status: 200, json: { ...repoJson(), allow_auto_merge: false } } : { status: 404, json: null }));
      sys.route('GET', '/user/repository_invitations?per_page=100&page=1', { status: 200, json: [] });
      sys.route('PUT', COLLABORATOR, () => {
        added = true;
        return { status: 204, json: null };
      });
      const config = 'queue_rules:\n  - name: default\nmerge_protections_settings:\n  auto_merge_conditions: true\n';
      sys.route('GET', `${REPO}/contents/.mergify.yml?ref=main`, () => (added ? { status: 200, json: { content: Buffer.from(config).toString('base64') } } : { status: 404, json: null }));
      const { code, out } = await run(sys);
      assert.equal(code, 0);
      assert.ok(planned(out, 'Pull request').includes('auto-merge or merge queue: when checks pass'), out.join('\n'));
      assert.ok(out.includes(`└  ${PULL_URL}  the merge queue merges it when checks pass`), out.join('\n'));
      assert.ok(!byHand(out).some((line) => line.startsWith('auto-merge')));
    });

    it('invites, then accepts the invitation as the agent', async () => {
      const sys = fresh();
      let accepted = false;
      let invited = false;
      sys.route('GET', REPO, () => (accepted ? PUSH : { status: 404, json: null }));
      sys.route('GET', '/user/repository_invitations?per_page=100&page=1', () => ({
        status: 200,
        json: invited ? [{ id: 9, repository: { full_name: 'Example-Org/Example-App' } }, { id: 'x' }, null] : [],
      }));
      sys.route('PATCH', '/user/repository_invitations/9', () => {
        accepted = true;
        return { status: 204, json: null };
      });
      sys.route('PUT', COLLABORATOR, () => {
        invited = true;
        return { status: 201, json: {} };
      });
      const { code, out } = await run(sys);
      assert.equal(code, 0);
      assert.equal(sys.requests.find((r) => r.method === 'PATCH')?.token, TOKEN);
      assert.ok(planned(out, 'GitHub — one sign-in').includes('ExampleBot write access'), out.join('\n'));
      assert.ok(out.includes('◇  ExampleBot can push'));
    });

    it('offers write access to an agent that can only read, then accepts the invitation', async () => {
      const sys = fresh();
      let accepted = false;
      let invited = false;
      sys.route('GET', REPO, () => (accepted ? PUSH : { status: 200, json: { ...repoJson(), permissions: { push: false } } }));
      sys.route('GET', '/user/repository_invitations?per_page=100&page=1', () => ({
        status: 200,
        json: invited ? [{ id: 9, repository: { full_name: 'example-org/example-app' } }] : [],
      }));
      sys.route('PATCH', '/user/repository_invitations/9', () => {
        accepted = true;
        return { status: 204, json: null };
      });
      sys.route('PUT', COLLABORATOR, () => {
        invited = true;
        return { status: 201, json: {} };
      });
      const { code, out } = await run(sys);
      assert.equal(code, 0);
      assert.ok(planned(out, 'Pull request').includes('auto-merge or merge queue: when checks pass'), 'an agent that cannot push is told no default branch yet');
      assert.ok(invited, 'grants write access');
      const body = opened(sys)?.body ?? '';
      assert.ok(body.includes('\n- ExampleBot can push:\n  - gave ExampleBot, which can read but not push to example-org/example-app, write access, as example-owner\n'), body);
      assert.ok(body.includes("\n  - accepted ExampleBot's invitation to example-org/example-app, as ExampleBot\n"), body);
    });

    it('finds an invitation on a later page', async () => {
      const sys = fresh();
      let accepted = false;
      sys.route('GET', REPO, () => (accepted ? PUSH : { status: 404, json: null }));
      const others = Array.from({ length: 100 }, (_, i) => ({ id: i, repository: { full_name: `example-org/other-${i}` } }));
      sys.route('GET', '/user/repository_invitations?per_page=100&page=1', { status: 200, json: others });
      sys.route('GET', '/user/repository_invitations?per_page=100&page=2', { status: 200, json: [{ id: 900, repository: { full_name: 'example-org/example-app' } }] });
      sys.route('PATCH', '/user/repository_invitations/900', () => {
        accepted = true;
        return { status: 204, json: null };
      });
      assert.equal((await run(sys)).code, 0);
    });

    it('reads the invitations as the agent, a page at a time, a short page the last, and takes no answer but a list for none', async () => {
      const INVITES = '/user/repository_invitations?per_page=100';
      const ours = [{ id: 9, repository: { full_name: 'example-org/example-app' } }];
      for (const answer of [
        { status: 200, json: [{ id: 1, repository: { full_name: 'example-org/other' } }] },
        { status: 500, json: ours },
        { status: 200, json: {} },
      ]) {
        const sys = fresh();
        sys.route('GET', REPO, { status: 404, json: null });
        sys.route('GET', `${INVITES}&page=1`, answer);
        sys.route('PUT', COLLABORATOR, { status: 204, json: null });
        await run(sys);
        const read = sys.requests.filter((r) => r.url.includes(INVITES));
        assert.ok(read.length > 0 && read.every((r) => r.token === TOKEN && r.url.endsWith('&page=1')), JSON.stringify(answer));
        assert.ok(!sys.requests.some((r) => r.method === 'PATCH'), 'accepts no invitation it did not read');
      }
    });

    it("reads GitHub's answer for the repository whatever it holds: none, no permissions, no default branch", async () => {
      for (const json of [null, { default_branch: 'main' }, { permissions: { push: true } }, { permissions: { push: false }, default_branch: 7 }]) {
        const sys = fresh();
        sys.route('GET', REPO, { status: 200, json });
        sys.route('GET', '/user/repository_invitations?per_page=100&page=1', { status: 200, json: [] });
        await run(sys);
        assert.ok(sys.requests.some((r) => r.url.includes('/user/repository_invitations')), `${JSON.stringify(json)}: read, so the agent is given access`);
        assert.ok(!sys.requests.some((r) => /\/contents\/.*\?ref=(?:undefined|7|Stryker)/.test(r.url)), `${JSON.stringify(json)}: no branch read but a named one`);
      }
    });

    it('accepts a pending invitation without inviting again', async () => {
      const sys = fresh();
      let accepted = false;
      sys.route('GET', REPO, () => (accepted ? PUSH : { status: 404, json: null }));
      sys.route('GET', '/user/repository_invitations?per_page=100&page=1', { status: 200, json: [{ id: 9, repository: { full_name: 'example-org/example-app' } }] });
      sys.route('PATCH', '/user/repository_invitations/9', () => {
        accepted = true;
        return { status: 204, json: null };
      });
      const { code, out } = await run(sys, ['example-owner', AGENT, '--features', 'identity']);
      assert.equal(code, 0);
      assert.ok(!sys.requests.some((r) => r.method === 'PUT'), 'invites no one');
      assert.deepEqual(planned(out, 'GitHub'), ['ExampleBot accepts its invitation']);
      assert.ok(out.includes('◇  GitHub'), 'no sign-in: the agent accepts it');
      assert.equal(signIns(sys), 0);
    });

    for (const [name, setUp, message] of [
      [
        'GitHub refusing to add the agent',
        (sys: FakeSys) => {
          sys.route('GET', REPO, { status: 404, json: null });
          sys.route('GET', '/user/repository_invitations?per_page=100&page=1', { status: 500, json: null });
          sys.route('PUT', COLLABORATOR, { status: 403, json: { message: 'Must have admin rights to Repository.' } });
        },
        ['onboard: GitHub did not add ExampleBot (HTTP 403: Must have admin rights to Repository.)', '  Add it yourself: example-org/example-app → Settings → Collaborators → Add people → ExampleBot, role Write.'],
      ],
      [
        'GitHub refusing to add the agent, saying nothing more',
        (sys: FakeSys) => {
          sys.route('GET', REPO, { status: 404, json: null });
          sys.route('GET', '/user/repository_invitations?per_page=100&page=1', { status: 200, json: [] });
          sys.route('PUT', COLLABORATOR, { status: 403, json: null });
        },
        ['onboard: GitHub did not add ExampleBot (HTTP 403)', '  Add it yourself: example-org/example-app → Settings → Collaborators → Add people → ExampleBot, role Write.'],
      ],
      [
        'an invitation GitHub will not accept',
        (sys: FakeSys) => {
          sys.route('GET', REPO, { status: 404, json: null });
          sys.route('GET', '/user/repository_invitations?per_page=100&page=1', { status: 200, json: [{ id: 9, repository: { full_name: 'example-org/example-app' } }] });
          sys.route('PATCH', '/user/repository_invitations/9', { status: 403, json: null });
        },
        ['onboard: GitHub did not accept the invitation (HTTP 403)'],
      ],
      [
        'an agent still without access',
        (sys: FakeSys) => {
          sys.route('GET', REPO, { status: 404, json: null });
          sys.route('GET', '/user/repository_invitations?per_page=100&page=1', { status: 200, json: [] });
          sys.route('PUT', COLLABORATOR, { status: 204, json: null });
        },
        ['onboard: ExampleBot still cannot see example-org/example-app; check the invitation reached ExampleBot'],
      ],
      [
        'an agent still read-only',
        (sys: FakeSys) => {
          sys.route('GET', REPO, { status: 200, json: { ...repoJson(), permissions: { push: false } } });
          sys.route('GET', '/user/repository_invitations?per_page=100&page=1', { status: 200, json: [] });
          sys.route('PUT', COLLABORATOR, { status: 204, json: null });
        },
        ['onboard: ExampleBot can read example-org/example-app but still not push; check the invitation reached ExampleBot, or give it the Write role'],
      ],
      [
        'an organisation requiring SAML',
        (sys: FakeSys) =>
          sys.route('GET', REPO, {
            status: 403,
            json: { message: 'Resource protected by organization SAML enforcement.' },
            headers: { 'x-github-sso': 'required; url=https://github.com/orgs/example-org/sso?authorization_request=abc' },
          }),
        ['onboard: the organisation requires SAML single sign-on; authorise the token for it at https://github.com/orgs/example-org/sso?authorization_request=abc'],
      ],
      [
        'an organisation blocking classic tokens',
        (sys: FakeSys) =>
          sys.route('GET', REPO, {
            status: 403,
            json: { message: 'example-org forbids access via a personal access tokens (classic).' },
          }),
        [
          'onboard: the organisation does not allow classic tokens ("example-org forbids access via a personal access tokens (classic)."); an organisation owner can allow them under Settings → Personal access tokens',
        ],
      ],
      [
        'an organisation blocking classic tokens, said of one token',
        (sys: FakeSys) => sys.route('GET', REPO, { status: 403, json: { message: 'example-org forbids a personal access token (classic).' } }),
        [
          'onboard: the organisation does not allow classic tokens ("example-org forbids a personal access token (classic)."); an organisation owner can allow them under Settings → Personal access tokens',
        ],
      ],
      [
        'any other refusal',
        (sys: FakeSys) => sys.route('GET', REPO, { status: 401, json: null }),
        ['onboard: GitHub refused (HTTP 401)'],
      ],
      [
        'a refusal with a message',
        (sys: FakeSys) => sys.route('GET', REPO, { status: 451, json: { message: 'blocked' } }),
        ['onboard: GitHub refused (HTTP 451: blocked)'],
      ],
    ] as const) {
      it(`names ${name}`, async () => {
        const sys = fresh();
        setUp(sys);
        const { code, err } = await run(sys);
        // Found while planning, a refusal stops before the plan; found after the yes, it stops that step.
        const planning = !message[0]?.includes('ExampleBot') && !message[0]?.includes('invitation');
        assert.deepEqual({ code, err }, {
          code: 1,
          err: [...message, ...(planning ? [] : ['onboard: stopped at "ExampleBot can push"; nothing after it was changed, and no pull request was opened'])],
        });
        assert.equal(sys.chosen.length, planning ? 0 : 1);
      });
    }
  });

  describe('test commit', () => {
    it('deletes the branch even when GitHub cannot be asked', async () => {
      const sys = fresh();
      sys.route('GET', `${REPO}/commits/abc123`, () => {
        throw new Error('down');
      });
      const { code, out, err } = await run(sys);
      assert.equal(code, 1);
      assert.deepEqual(err, ['onboard: cannot ask GitHub whether the test commit is Verified (down); open the link above to see', 'onboard: stopped at "test commit Verified as ExampleBot"; nothing after it was changed, and no pull request was opened']);
      assert.ok(out.includes('│  Test commit https://github.com/example-org/example-app/commit/abc123'), out.join('\n'));
      assert.ok(out.includes('│  Deleted the throwaway branch niyam/verify-examplebot-1793361600000.'));
      assert.deepEqual(sys.slept, [2000, 4000, 6000, 8000]);
      assert.equal(sys.requests.filter((r) => r.url.endsWith(`${REPO}/commits/abc123`)).length, 5, 'asked five times');
      assert.equal(sys.calls.at(-1)?.command, 'rm');
    });

    it('asks again when GitHub cannot be asked for a moment, and prints the result', async () => {
      const sys = fresh();
      const answers: (() => HttpResult)[] = [
        () => {
          throw new Error('fetch failed');
        },
        () => ({ status: 422, json: { message: 'No commit found' } }),
        () => VERIFIED,
      ];
      sys.route('GET', `${REPO}/commits/abc123`, () => (answers.shift() as () => HttpResult)());
      const { code, out, err } = await run(sys);
      assert.deepEqual({ code, err }, { code: 0, err: [] });
      assert.ok(out.includes('◇  test commit Verified as ExampleBot'));
      assert.ok(opened(sys)?.body.includes('\n  - GitHub shows the test commit Verified by ExampleBot\n'));
      assert.deepEqual(sys.slept, [2000, 4000]);
    });

    it('makes the test commit in a folder of its own, with git told exactly what to do', async () => {
      const sys = fresh();
      assert.equal((await run(sys)).code, 0);
      assert.deepEqual(sys.calls.filter((c) => c.command === 'mktemp').map((c) => c.args), [['-d']]);
      const url = 'https://github.com/example-org/example-app.git';
      const branch = 'refs/heads/niyam/verify-examplebot-1793361600000';
      assert.deepEqual(sys.calls.filter((c) => c.command === 'git' && c.cwd === '/tmp/verify').map((c) => c.args), [
        ['ls-remote', url, 'HEAD'],
        ['init', '-q'],
        ['fetch', '-q', '--depth=1', '--filter=blob:none', url, 'HEAD'],
        ['commit-tree', '-S', 'FETCH_HEAD^{tree}', '-p', 'FETCH_HEAD', '-m', 'niyam: signing check for ExampleBot'],
        ['push', '-q', url, `abc123:${branch}`],
        ['push', '-q', url, `:${branch}`],
      ]);
      assert.ok(sys.calls.some((c) => c.command === 'rm' && c.args.join(' ') === '-rf /tmp/verify'));
    });

    it('refuses a repository with no commits, even when git prints a blank line for it, and goes past a failed look', async () => {
      const blank = fresh();
      blank.execOverride = (call) => (call.command === 'git' && call.args[0] === 'ls-remote' ? { code: 0, stdout: '\n', stderr: '' } : undefined);
      const empty = await run(blank);
      assert.deepEqual({ code: empty.code, err: empty.err }, { code: 1, err: ['onboard: example-org/example-app has no commits yet; push a first commit to it, then onboard again', 'onboard: stopped at "test commit Verified as ExampleBot"; nothing after it was changed, and no pull request was opened'] });
      // ls-remote failing says nothing about commits: fetch, which needs them, says the rest.
      const failed = fresh();
      failed.execOverride = (call) => (call.command === 'git' && call.args[0] === 'ls-remote' ? { code: 2, stdout: '', stderr: 'no route\n' } : undefined);
      const { code, err } = await run(failed);
      assert.deepEqual({ code, err }, { code: 0, err: [] });
    });

    it('fails a signing that gives no commit id, or that fails whatever it printed', async () => {
      for (const [code, stdout] of [
        [0, '\n'],
        [1, 'abc123\n'],
      ] as const) {
        const sys = fresh();
        sys.execOverride = (call) => (call.command === 'git' && call.args[0] === 'commit-tree' && call.cwd === '/tmp/verify' ? { code, stdout, stderr: 'no key\n' } : undefined);
        const ran = await run(sys);
        assert.deepEqual({ code: ran.code, err: ran.err }, { code: 1, err: ['onboard: signing the test commit failed: no key', 'onboard: stopped at "test commit Verified as ExampleBot"; nothing after it was changed, and no pull request was opened'] }, stdout);
      }
    });

    it("says GitHub's reason as GitHub gives it, dashes and all", async () => {
      const sys = fresh();
      sys.route('GET', `${REPO}/commits/abc123`, { status: 200, json: { committer: { login: AGENT }, commit: { verification: { verified: true, reason: 'valid - by key' } } } });
      assert.equal((await run(sys)).code, 0);
      assert.ok(opened(sys)?.body.includes('\n  - committer: ExampleBot; verified: true (valid - by key)\n'), opened(sys)?.body);
    });

    it('names the last answer when GitHub keeps refusing', async () => {
      const sys = fresh();
      sys.route('GET', `${REPO}/commits/abc123`, { status: 502, json: null });
      const { code, err } = await run(sys);
      assert.deepEqual({ code, err }, { code: 1, err: ['onboard: cannot ask GitHub whether the test commit is Verified (HTTP 502); open the link above to see', 'onboard: stopped at "test commit Verified as ExampleBot"; nothing after it was changed, and no pull request was opened'] });
    });

    it('says so when the branch cannot be deleted', async () => {
      const sys = fresh();
      sys.execOverride = (call) =>
        call.command === 'git' && call.args[3]?.startsWith(':') ? { code: 1, stdout: '', stderr: 'protected\n' } : undefined;
      const { code, err } = await run(sys);
      assert.equal(code, 0);
      assert.deepEqual(err, ['onboard: could not delete niyam/verify-examplebot-1793361600000; delete it on GitHub: protected']);
    });

    for (const [args, message] of [
      ['init', 'onboard: git init failed: boom'],
      ['fetch', 'onboard: git fetch failed: boom'],
      ['commit-tree', 'onboard: signing the test commit failed: boom'],
      ['push', 'onboard: pushing as ExampleBot failed: boom'],
    ] as const) {
      it(`reports a failed git ${args} and cleans up`, async () => {
        const sys = fresh();
        sys.execOverride = (call) =>
          call.command === 'git' && call.args[0] === args ? { code: 1, stdout: '', stderr: 'boom\n' } : undefined;
        const { code, err } = await run(sys);
        assert.deepEqual({ code, err }, { code: 1, err: [message, 'onboard: stopped at "test commit Verified as ExampleBot"; nothing after it was changed, and no pull request was opened'] });
        assert.equal(sys.calls.at(-1)?.command, 'rm');
      });
    }

    for (const [name, json, shown] of [
      ['unverified', { committer: { login: AGENT }, commit: { verification: { verified: false, reason: 'unknown_key' } } }, `committer: ${AGENT}; verified: false (unknown_key)`],
      ['committed by someone else', { committer: { login: 'example-owner' }, commit: { verification: { verified: true, reason: 'valid' } } }, 'committer: example-owner; verified: true (valid)'],
      ['unreadable', null, 'committer: none; verified: undefined (no reason)'],
      ['of no commit and no committer', { committer: null }, 'committer: none; verified: undefined (no reason)'],
    ] as const) {
      it(`fails a test commit that is ${name}`, async () => {
        const sys = fresh();
        sys.route('GET', `${REPO}/commits/abc123`, { status: 200, json });
        const { code, out, err } = await run(sys);
        assert.equal(code, 1);
        assert.ok(out.includes(`│  ${shown}`), out.join('\n'));
        assert.deepEqual(err, ['onboard: GitHub does not show the commit Verified by ExampleBot', 'onboard: stopped at "test commit Verified as ExampleBot"; nothing after it was changed, and no pull request was opened']);
      });
    }
  });

});

describe('staged adoption', () => {
  it('sets up identity alone, with the pre-push hook but no workflow or board', async () => {
    const sys = fresh();
    const { code, out } = await run(sys, ['example-owner', AGENT, '--features', 'identity']);
    assert.equal(code, 0);
    assert.deepEqual(JSON.parse(repo(sys).get(SETTINGS) ?? '').features, ['identity']);
    assert.ok(repo(sys).has(HOOKS));
    assert.ok(!repo(sys).has(WORKFLOW));
    assert.ok(repo(sys).has(CLOUD), 'cloud sessions, for every adopter');
    assert.equal(sys.files.get(PRE_PUSH), PRE_PUSH_HOOK, 'the identity guard, for every adopter');
    const boardRequest = (r: { url: string; body?: unknown }): boolean =>
      (r.url.endsWith('/graphql') && !JSON.stringify(r.body).includes('enablePullRequestAutoMerge')) || r.url.includes('/labels') || r.url.includes('/issue-types');
    assert.ok(!sys.requests.some(boardRequest), 'no board');
    assert.deepEqual(planned(out, 'Pull request'), ['niyam.json: new, 1 feature on', 'settings.json: new', `guard caller: new, the shared Guard at v${packageVersion()}`, `cloud-setup.sh: new, installs v${packageVersion()}`, 'auto-merge: when checks pass']);
    assert.deepEqual(planned(out, 'GitHub'), [], 'no board, and the agent can push');
    assert.deepEqual(planned(out, 'This Mac'), ['pre-push hook: new']);
    assert.ok(out.includes(`└  ${PULL_URL}  merges itself when checks pass`));
    assert.deepEqual([...sys.committed.keys()], ['.github/niyam.json', '.claude/settings.json', CLOUD_SETUP_PATH, GUARD_CALLER_PATH]);
    assert.deepEqual(byHand(out), ['Once per claude.ai account: sign in at https://claude.ai/code and connect GitHub as ExampleBot (or change it at https://claude.ai/customize/connectors); skip it if done.']);
    assert.deepEqual(sys.chosen, ['Go ahead?']);
  });


  it('turns one more feature on, keeping the other settings', async () => {
    const sys = fresh();
    sys.files.set(SETTINGS, JSON.stringify({ owner: 'example-owner', agent: AGENT, features: ['identity'], project: 'Example work', note: 'kept' }));
    sys.files.set(HOOKS, JSON.stringify(CLAUDE));
    // GitHub's default Task and Bug, so the owner signs in before the plan.
    const board = new Board(sys);
    const { code, out } = await run(sys, ['--add', 'board']);
    assert.equal(code, 0);
    assert.deepEqual(board.titles, ['Example work']);
    assert.deepEqual(board.disabledTypes, ['Task', 'Bug']);
    assert.deepEqual(JSON.parse(repo(sys).get(SETTINGS) ?? ''), {
      owner: 'example-owner',
      agent: AGENT,
      features: ['identity', 'board'],
      project: 'Example work',
      note: 'kept',
    });
    assert.deepEqual(planned(out, 'Pull request'), ['niyam.json: turn board on', 'workflow: new', `guard caller: new, the shared Guard at v${packageVersion()}`, `cloud-setup.sh: new, installs v${packageVersion()}`, 'auto-merge: when checks pass']);
    assert.ok(planned(out, 'GitHub — signed in as example-owner').includes('board: set up or check'));
    // The board's Needs you labels and the type of each new issue come from the workflow's asks job; its In Progress move, from the board app's secrets.
    assert.equal(repo(sys).get(WORKFLOW), workflow('main', packageVersion(), false, undefined, undefined, true));
  });



  it('renames design to figma, takes the library key out of older settings and sets it as the FIGMA_LIBRARY secret', async () => {
    const sys = fresh();
    sys.files.set(SETTINGS, JSON.stringify({ owner: 'example-owner', agent: AGENT, features: ['identity', 'design'], figma: { library: 'LibKey0123abc' } }));
    sys.files.set(HOOKS, JSON.stringify(CLAUDE));
    sys.files.set(PRE_PUSH, PRE_PUSH_HOOK);
    const pair = await actionsKey(sys);
    const { code, out, err } = await run(sys);
    assert.deepEqual([code, err], [0, []]);
    assert.deepEqual(planned(out, 'Pull request'), ['niyam.json: design → figma, figma key out', 'workflow: new', `guard caller: new, the shared Guard at v${packageVersion()}`, `cloud-setup.sh: new, installs v${packageVersion()}`, 'auto-merge: when checks pass']);
    assert.deepEqual(planned(out, 'GitHub — one sign-in as example-owner'), ['FIGMA_LIBRARY secret']);
    assert.match(
      opened(sys)?.body ?? '',
      /^- `\.github\/niyam\.json`: rename the design feature to figma and take out "figma" and set its library key as the FIGMA_LIBRARY Actions secret$/m,
    );
    assert.ok(opened(sys)?.body.includes('\n- FIGMA_LIBRARY secret:\n  - set the FIGMA_LIBRARY Actions secret to the library key taken out of the settings\n'), opened(sys)?.body);
    assert.deepEqual(JSON.parse(repo(sys).get(SETTINGS) ?? ''), { owner: 'example-owner', agent: AGENT, features: ['identity', 'figma'] });
    const sent = sealedValue(sys, pair);
    assert.deepEqual([sent.value, sent.keyId, sent.token], ['LibKey0123abc', 'key-1', OWNER_TOKEN], "sealed with the repository's key, as the owner for this run");
    assert.equal(signIns(sys), 1);
    assert.ok(out.includes('◇  FIGMA_LIBRARY secret'));
    const said = [...out, ...err, ...sys.asked, opened(sys)?.body ?? ''];
    assert.ok(!said.some((line) => line.includes('LibKey0123abc')), 'the key never appears in the output');
    assert.ok(!said.some((line) => /\bgh (secret|auth|api)\b/.test(line)), 'the owner is never told to run gh');
    assert.equal(repo(sys).get(WORKFLOW), workflow('main', packageVersion(), true));
  });

  it('stops when the FIGMA_LIBRARY secret cannot be set, saying why without the key', async () => {
    const sys = fresh();
    sys.files.set(SETTINGS, JSON.stringify({ owner: 'example-owner', agent: AGENT, features: ['identity'], figma: { library: 'LibKey0123abc' } }));
    await actionsKey(sys, { status: 403, json: { message: 'Must have admin rights to Repository.' } });
    const { code, out, err } = await run(sys);
    assert.equal(code, 1);
    assert.deepEqual(err, [
      'onboard: GitHub did not set the FIGMA_LIBRARY secret (HTTP 403: Must have admin rights to Repository.)',
      'onboard: stopped at "FIGMA_LIBRARY secret"; nothing after it was changed, and no pull request was opened',
    ]);
    assert.ok(out.includes('■  FIGMA_LIBRARY secret'));
    assert.ok(![...out, ...err].some((line) => line.includes('LibKey0123abc')));
    assert.ok(!sys.requests.some((r) => r.url.endsWith('/pulls')));
  });

  it('stops when the owner does not sign in to set the FIGMA_LIBRARY secret', async () => {
    const sys = fresh();
    sys.files.set(SETTINGS, JSON.stringify({ owner: 'example-owner', agent: AGENT, features: ['identity'], figma: { library: 'LibKey0123abc' } }));
    sys.ghToken = undefined;
    const { code, err } = await run(sys);
    assert.deepEqual([code, err], [1, ['onboard: the GitHub sign-in in the browser did not finish', 'onboard: stopped at "FIGMA_LIBRARY secret"; nothing after it was changed, and no pull request was opened']]);
    assert.ok(!sys.requests.some((r) => r.method === 'PUT'));
  });

  it('renames design alone, and stops at a no', async () => {
    const sys = fresh();
    sys.files.set(SETTINGS, JSON.stringify({ owner: 'example-owner', agent: AGENT, features: ['identity', 'design'] }));
    sys.answers = ['n'];
    const { code, out } = await run(sys);
    assert.equal(code, 1);
    assert.ok(planned(out, 'Pull request').includes('niyam.json: design → figma'), out.join('\n'));
    assert.deepEqual(JSON.parse(repo(sys).get(SETTINGS) ?? '').features, ['identity', 'design']);
    assert.ok(changedNothing(sys));
    const yes = fresh();
    yes.files.set(SETTINGS, JSON.stringify({ owner: 'example-owner', agent: AGENT, features: ['identity', 'design'] }));
    assert.equal((await run(yes)).code, 0);
    assert.match(opened(yes)?.body ?? '', /^- `\.github\/niyam\.json`: rename the design feature to figma$/m);
  });

  it('takes out a library key from settings that list no features', async () => {
    const sys = fresh();
    sys.files.set(SETTINGS, JSON.stringify({ owner: 'example-owner', agent: AGENT, figma: {} }));
    const { out } = await run(sys);
    assert.deepEqual(JSON.parse(repo(sys).get(SETTINGS) ?? ''), { owner: 'example-owner', agent: AGENT });
    assert.ok(!out.some((line) => line.includes('gh secret set')));
    assert.ok(planned(out, 'Pull request').includes('niyam.json: figma key out'), out.join('\n'));
    assert.match(opened(sys)?.body ?? '', /^- `\.github\/niyam\.json`: take out "figma", since the library key belongs in the FIGMA_LIBRARY Actions secret$/m);
    // With no library there is no key to set by hand.
    assert.ok(!byHand(out).some((line) => line.includes('FIGMA_LIBRARY')), out.join('\n'));
    assert.ok(!(opened(sys)?.body ?? '').includes('figma.library'));
  });

  it('stores no library key that is not text', async () => {
    const sys = fresh();
    sys.files.set(SETTINGS, JSON.stringify({ owner: 'example-owner', agent: AGENT, features: ['identity'], figma: { library: 123 } }));
    const { code, out } = await run(sys);
    assert.equal(code, 0);
    assert.deepEqual(planned(out, 'GitHub'), []);
    assert.ok(!sys.requests.some((r) => r.url.includes('/actions/secrets')), 'nothing that is not a file key is stored as one');
  });

  it('says when a workflow of its own passes no FIGMA_LIBRARY with figma on', async () => {
    const sys = fresh();
    sys.files.set(SETTINGS, JSON.stringify({ owner: 'example-owner', agent: AGENT, features: ['identity', 'figma'] }));
    sys.files.set(HOOKS, JSON.stringify(CLAUDE));
    sys.files.set(PRE_PUSH, PRE_PUSH_HOOK);
    const own = workflow('main', packageVersion(), true).replaceAll('      FIGMA_LIBRARY: ${{ secrets.FIGMA_LIBRARY }}\n', '      OTHER: ${{ secrets.OTHER }}\n');
    sys.files.set(WORKFLOW, own);
    const { out } = await run(sys);
    assert.equal(repo(sys).get(WORKFLOW), own);
    assert.ok(byHand(out).includes('Once for example-org/example-app: in .github/workflows/niyam.yml, add FIGMA_LIBRARY: ${{ secrets.FIGMA_LIBRARY }} under the secrets of niyam, niyam-weekly, niyam-merged, niyam-asks, so the design check runs there.'), out.join('\n'));
    assert.ok(opened(sys) === undefined || opened(sys)?.body.includes('pass the shared checks no FIGMA_LIBRARY secret'));
    // With a change to open, the pull request says the same.
    const opening = fresh();
    opening.files.set(SETTINGS, JSON.stringify({ owner: 'example-owner', agent: AGENT, features: ['identity', 'figma'] }));
    opening.files.set(WORKFLOW, own);
    assert.equal((await run(opening)).code, 0);
    assert.ok(
      opened(opening)?.body.includes(
        '\n- In .github/workflows/niyam.yml, niyam, niyam-weekly, niyam-merged, niyam-asks pass the shared checks no FIGMA_LIBRARY secret, so the design check stays off there; add `FIGMA_LIBRARY: ${{ secrets.FIGMA_LIBRARY }}` under their secrets.\n',
      ),
      opened(opening)?.body,
    );
    // A workflow the pull request replaces passes it: nothing to do by hand then, though the plan was made without the branch.
    const replaced = fresh();
    replaced.files.set(SETTINGS, JSON.stringify({ owner: 'example-owner', agent: AGENT, features: ['identity', 'figma'] }));
    replaced.files.set(WORKFLOW, 'old');
    let added = false;
    replaced.route('GET', REPO, () => (added ? PUSH : { status: 404, json: null }));
    replaced.route('GET', '/user/repository_invitations?per_page=100&page=1', { status: 200, json: [] });
    replaced.route('PUT', COLLABORATOR, () => {
      added = true;
      return { status: 204, json: null };
    });
    const after = await run(replaced, []);
    assert.equal(after.code, 0, after.err.join('\n'));
    assert.ok(planned(after.out, 'Pull request').includes('workflow: write or update'), 'until the agent can push, the plan cannot say which');
    assert.ok(!byHand(after.out).some((line) => line.includes('FIGMA_LIBRARY')), after.out.join('\n'));
  });

  it('names each job that passes no FIGMA_LIBRARY, and takes `secrets: inherit` as passing it', () => {
    const both = workflow('main', '0.5.5', true);
    assert.deepEqual(jobsWithoutLibrary(both), []);
    const [head = '', weekly = ''] = both.split('  niyam-weekly:');
    const prOnly = `${head.replace('      FIGMA_LIBRARY: ${{ secrets.FIGMA_LIBRARY }}\n', '      OTHER: ${{ secrets.OTHER }}\n')}  niyam-weekly:${weekly}`;
    assert.deepEqual(jobsWithoutLibrary(prOnly), ['niyam']);
    assert.deepEqual(jobsWithoutLibrary(prOnly.replace(/ {4}secrets:\n(?: {6}.*\n)+/, '    secrets: inherit\n')), []);
    assert.deepEqual(jobsWithoutLibrary(workflow('main', '0.5.5', false)), ['niyam', 'niyam-weekly', 'niyam-merged', 'niyam-asks']);
  });

  it('prints no command for an older library value that is not a file key', async () => {
    const sys = fresh();
    sys.files.set(SETTINGS, JSON.stringify({ owner: 'example-owner', agent: AGENT, features: ['identity'], figma: { library: 'x; rm -rf ~' } }));
    const { out } = await run(sys);
    assert.ok(byHand(out).includes("Once for example-org/example-app: add the Actions secret FIGMA_LIBRARY, the design library's Figma file key, at https://github.com/example-org/example-app/settings/secrets/actions."), out.join('\n'));
    assert.deepEqual(planned(out, 'GitHub'), []);
    assert.ok(!out.some((line) => line.includes('gh secret set')));
    assert.ok(!sys.requests.some((r) => r.url.includes('/actions/secrets')), 'nothing that is not a file key is stored as one');
    assert.ok(
      opened(sys)?.body.includes(
        `\n- The "figma.library" taken out was not a Figma file key; set the FIGMA_LIBRARY Actions secret to the design library's file key under example-org/example-app → Settings → Secrets and variables → Actions.`,
      ),
      opened(sys)?.body,
    );
  });

  it('writes the workflow for each feature that runs the shared checks, and none for identity alone', async () => {
    for (const feature of ['pr-identity', 'board', 'work-rules', 'figma', 'decisions', 'review']) {
      const sys = fresh();
      await run(sys, ['example-owner', AGENT, '--features', feature]);
      assert.ok(repo(sys).has(WORKFLOW), feature);
    }
    const alone = fresh();
    assert.equal((await run(alone, ['example-owner', AGENT, '--features', 'identity'])).code, 0);
    assert.ok(!repo(alone).has(WORKFLOW));
  });

  it('writes the workflow and pre-push hook once work rules are on', async () => {
    const sys = fresh();
    await run(sys, ['example-owner', AGENT, '--features', 'work-rules']);
    assert.deepEqual(JSON.parse(repo(sys).get(SETTINGS) ?? '').features, ['identity', 'work-rules']);
    assert.ok(repo(sys).has(WORKFLOW) && sys.files.has(PRE_PUSH));
  });

  it('adds nothing when the feature is already on', async () => {
    const sys = fresh();
    sys.files.set(SETTINGS, JSON.stringify({ owner: 'example-owner', agent: AGENT, features: ['identity'] }));
    sys.files.set(HOOKS, JSON.stringify(CLAUDE));
    sys.files.set(SETTINGS, JSON.stringify({ owner: 'example-owner', agent: AGENT, features: ['identity', 'pr-identity'] }));
    sys.files.set(WORKFLOW, workflow('main', packageVersion(), false));
    sys.files.set(PRE_PUSH, PRE_PUSH_HOOK);
    sys.files.set(CLOUD, CLOUD_FILE);
    sys.files.set(CALLER, CALLER_FILE);
    const before = repo(sys).get(SETTINGS);
    const { out } = await run(sys, ['--add', 'pr-identity']);
    assert.deepEqual(planned(out, 'Pull request'), []);
    assert.deepEqual(planned(out, 'Check'), ['one signed test commit by ExampleBot, deleted after']);
    assert.equal(repo(sys).get(SETTINGS), before);
  });

  for (const [name, args, change, message] of [
    ['--features for a repo that has settings', ['--features', 'board'], (sys: FakeSys) => sys.files.set(SETTINGS, JSON.stringify({ owner: 'example-owner', agent: AGENT })), 'onboard: .github/niyam.json already lists its features; turn one more on with --add <feature>'],
    ['--add with no settings', ['--add', 'board'], () => undefined, 'onboard: there is no .github/niyam.json to add to; run niyam onboard <owner> <agent> first'],
  ] as const) {
    it(`refuses ${name}`, async () => {
      const sys = fresh();
      change(sys);
      const { code, err } = await run(sys, [...args]);
      assert.deepEqual({ code, err }, { code: 1, err: [message] });
    });
  }

  it('leaves the settings alone when a turned-on feature\'s setup stops', async () => {
    const sys = fresh();
    const before = JSON.stringify({ owner: 'example-owner', agent: AGENT, features: ['identity'] });
    sys.files.set(SETTINGS, before);
    sys.files.set(HOOKS, JSON.stringify(CLAUDE));
    sys.files.set(PRE_PUSH, PRE_PUSH_HOOK);
    sys.route('POST', '/orgs/example-org/issue-types', { status: 422, json: null });
    await assert.rejects(run(sys, ['--add', 'board']), /GitHub did not add the issue type Work item \(HTTP 422\)/);
    assert.equal(repo(sys).get(SETTINGS), before);
    assert.equal(sys.spinning, 0, 'the spinner stops when a step throws');
  });

  it('changes nothing when turning a feature on is declined', async () => {
    const sys = fresh();
    sys.files.set(SETTINGS, JSON.stringify({ owner: 'example-owner', agent: AGENT, features: ['identity'] }));
    sys.answers = ['n'];
    const { code, err } = await run(sys, ['--add', 'board']);
    assert.deepEqual({ code, err }, { code: 1, err: [] });
    assert.ok(changedNothing(sys));
  });
});

describe('the plan and its one question', () => {
  it('goes ahead without asking with --yes, with no terminal too', async () => {
    const sys = fresh();
    sys.tty = false;
    sys.answers = [];
    const { code, out, err } = await run(sys, ['example-owner', AGENT, '--yes']);
    assert.deepEqual({ code, err }, { code: 0, err: [] });
    assert.deepEqual(sys.chosen, [], 'no question');
    assert.ok(out.includes('◇  Go ahead? Yes (--yes)'));
    assert.ok(out.indexOf('◇  Go ahead? Yes (--yes)') > out.indexOf('◇  Check'), 'after the plan');
    assert.ok(out.includes(`└  ${PULL_URL}  merges itself when checks pass`));
    assert.equal(sys.files.get(PRE_PUSH), PRE_PUSH_HOOK);
  });

  it("turns auto-merge on for its pull request as the agent, squashing, so it merges itself", async () => {
    const sys = fresh();
    const board = new Board(sys);
    sys.route('GET', REPO, { status: 200, json: { ...repoJson(), allow_auto_merge: true, allow_squash_merge: false, allow_rebase_merge: true } });
    const { code, out } = await run(sys);
    assert.equal(code, 0);
    assert.ok(planned(out, 'Pull request').includes('auto-merge: when checks pass'));
    assert.deepEqual(board.autoMerge, { id: 'PR_7', method: 'REBASE' }, 'the first method the repository allows');
    const asked = sys.requests.find((r) => JSON.stringify(r.body ?? '').includes('enablePullRequestAutoMerge'));
    assert.equal(asked?.token, TOKEN, 'as the agent');
    assert.ok(out.includes(`└  ${PULL_URL}  merges itself when checks pass`));
    assert.ok(!byHand(out).some((line) => line.startsWith('auto-merge')));
    const squash = fresh();
    const squashing = new Board(squash);
    await run(squash);
    assert.deepEqual(squashing.autoMerge, { id: 'PR_7', method: 'SQUASH' }, 'squash when GitHub does not say otherwise');
  });

  it("titles the pull request and its commit in the default branch's style: an emoji first when its subjects have one", async () => {
    const sys = fresh();
    const subjects = ['✨ feat(app): a (#9)', '🔥 chore(tooling): b (#8)', '🔧 chore(niyam): onboard at v0.5.1 (#7)', 'Merge pull request #6 from example-org/x'];
    sys.route('GET', `${REPO}/commits?sha=main&per_page=20`, { status: 200, json: subjects.map((message) => ({ commit: { message: `${message}\n\nbody` } })) });
    const { code, err } = await run(sys);
    assert.deepEqual({ code, err }, { code: 0, err: [] });
    const title = `🔧 chore(niyam): onboard at v${packageVersion()}`;
    assert.equal(opened(sys)?.title, title);
    const commit = sys.calls.find((c) => c.command === 'git' && c.args[0] === 'commit-tree' && c.cwd === '/tmp/niyam-2');
    assert.deepEqual(commit?.args.slice(-2), ['-m', title], 'the commit header is the title');
    assert.equal(sys.requests.find((r) => r.url.includes('/commits?'))?.token, TOKEN, 'asked as the agent');
  });

  it('lets a Mergify merge queue merge it, without asking the owner to turn auto-merge on', async () => {
    const sys = fresh();
    const board = new Board(sys);
    sys.route('GET', REPO, { status: 200, json: { ...repoJson(), allow_auto_merge: false } });
    const config = 'queue_rules:\n  - name: default\npull_request_rules:\n  - name: queue when green\n    conditions: [check-success=CI]\n    actions:\n      queue:\n';
    sys.route('GET', `${REPO}/contents/.mergify.yml?ref=main`, { status: 200, json: { content: Buffer.from(config).toString('base64') } });
    const { code, out, err } = await run(sys);
    assert.deepEqual({ code, err }, { code: 0, err: [] });
    assert.ok(planned(out, 'Pull request').includes('merge queue: Mergify, when checks pass'), out.join('\n'));
    assert.ok(!planned(out, 'Pull request').some((item) => item.startsWith('auto-merge')));
    assert.equal(board.autoMerge, undefined, "GitHub's auto-merge is left to the queue");
    assert.ok(!sys.requests.some((r) => JSON.stringify(r.body ?? '').includes('enablePullRequestAutoMerge')));
    assert.ok(out.includes(`└  ${PULL_URL}  the merge queue merges it when checks pass`), out.join('\n'));
    assert.ok(!byHand(out).some((line) => line.startsWith('auto-merge')), byHand(out).join('\n'));
  });

  it('asks the owner to merge it when the repository does not allow auto-merge, or GitHub refuses it', async () => {
    const off = fresh();
    const board = new Board(off);
    off.route('GET', REPO, { status: 200, json: { ...repoJson(), allow_auto_merge: false } });
    const { code, out, err } = await run(off);
    assert.deepEqual({ code, err }, { code: 0, err: [] });
    assert.equal(board.autoMerge, undefined, 'not asked for');
    assert.ok(out.includes(`└  Merge ${PULL_URL}`));
    assert.equal(byHand(out)[0], `Now: turn on Allow auto-merge at https://github.com/example-org/example-app/settings, or merge ${PULL_URL} yourself once its checks pass.`);
    for (const [refusal, line] of [
      ['Pull request is in clean status', `Now: merge ${PULL_URL} yourself once its checks pass, since GitHub refused auto-merge (Pull request is in clean status).`],
      ['Pull request Auto merge is not allowed for this repository', `Now: turn on Allow auto-merge at https://github.com/example-org/example-app/settings, or merge ${PULL_URL} yourself once its checks pass.`],
    ]) {
      const sys = fresh();
      new Board(sys).autoMergeRefusal = refusal;
      const refused = await run(sys);
      assert.equal(refused.code, 0);
      assert.ok(refused.out.includes(`└  Merge ${PULL_URL}`));
      assert.equal(byHand(refused.out)[0], line);
    }
    const down = fresh();
    const http = down.http.bind(down);
    down.http = (url, options) =>
      JSON.stringify(options?.body ?? '').includes('enablePullRequestAutoMerge') ? Promise.reject(new Error('POST api.github.com/graphql could not be made: ECONNRESET')) : http(url, options);
    const cut = await run(down);
    assert.deepEqual({ code: cut.code, err: cut.err }, { code: 0, err: [] });
    assert.ok(cut.out.includes(`└  Merge ${PULL_URL}`));
    assert.equal(byHand(cut.out)[0], `Now: merge ${PULL_URL} yourself once its checks pass, since GitHub refused auto-merge (POST api.github.com/graphql could not be made: ECONNRESET).`);
    const none = fresh();
    none.route('GET', REPO, { status: 200, json: { ...repoJson(), allow_squash_merge: false, allow_rebase_merge: false, allow_merge_commit: false } });
    assert.equal(byHand((await run(none)).out)[0], `Now: merge ${PULL_URL} yourself once its checks pass, since GitHub refused auto-merge (example-org/example-app allows no merge method).`);
  });

  it('prints the plan and changes nothing with --dry-run, with no terminal too', async () => {
    const sys = fresh();
    sys.tty = false;
    sys.answers = [];
    const { code, out, err } = await run(sys, ['example-owner', AGENT, '--dry-run']);
    assert.deepEqual({ code, err }, { code: 0, err: [] });
    assert.deepEqual(sys.chosen, []);
    assert.equal(out[0], `◆  niyam onboard   v${packageVersion()}`);
    assert.deepEqual(planned(out, 'Pull request'), [
      `niyam.json: new, ${FEATURES.length} features on`,
      'settings.json: new',
      'workflow: new',
      `guard caller: new, the shared Guard at v${packageVersion()}`,
      `cloud-setup.sh: new, installs v${packageVersion()}`,
      'auto-merge: when checks pass',
    ]);
    assert.deepEqual(planned(out, 'Claude cloud — by hand, once'), [`claude.ai's GitHub: as ${AGENT}`]);
    assert.equal(out.at(-1), '└  Dry run: nothing changed.');
    assert.ok(changedNothing(sys), 'nothing written, pushed or signed in to');
    assert.deepEqual(sys.committed.size, 0);
    assert.ok(!sys.opened.length, 'no browser');
  });

  it('signs in to nothing for a dry run, refusing one that would need the sign-in to choose the owner', async () => {
    const sys = fresh();
    sys.files.set(SETTINGS, JSON.stringify({ owner: ['example-owner', 'Second-Owner'], agent: AGENT }));
    const { code, err } = await run(sys, ['--dry-run']);
    assert.deepEqual({ code, err }, {
      code: 1,
      err: ['onboard: .github/niyam.json names the owners example-owner or Second-Owner; name yours for a dry run, which signs in to nothing: niyam onboard <owner> --dry-run'],
    });
    assert.equal(signIns(sys), 0);
    const first = fresh();
    first.files.set(`${first.home}/.config/niyam/examplebot/session.sh`, sessionScript(AGENT, 42, pathsFor(first.home, AGENT)));
    first.answers = ['example-owner', ''];
    assert.equal((await run(first, ['--dry-run'])).code, 0);
    assert.equal(signIns(first), 0, 'no sign-in to suggest the owner');
    assert.equal(first.asked[0], 'The owner, who approves: ');
  });

  it('refuses in one line with no terminal and no --yes, asking nothing', async () => {
    const sys = fresh();
    sys.tty = false;
    assert.deepEqual(await run(sys), { code: 1, out: [], err: ['onboard: no terminal to ask in; pass --yes to go ahead without asking, or --dry-run to see the plan'] });
    assert.deepEqual([sys.chosen, sys.asked], [[], []]);
    const unnamed = fresh();
    unnamed.tty = false;
    assert.deepEqual((await run(unnamed, ['--yes'])).err, ['onboard: name the owner and the agent account: niyam onboard <owner> <agent>']);
    assert.deepEqual(unnamed.asked, []);
  });

  it('keeps every item of the plan short', async () => {
    const sys = fresh();
    sys.files.set(WORKFLOW, workflow('main', '0.5.2', true));
    sys.files.set(HOOKS, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ command: OLDER_HOOK_COMMANDS[0] }] }] } }));
    sys.files.set(PRE_PUSH, OLDER_PRE_PUSH_HOOKS[0] as string);
    const { out } = await run(sys, ['example-owner', AGENT, '--dry-run']);
    const items = out.filter((line) => line.startsWith('│    '));
    assert.ok(items.length >= 6, out.join('\n'));
    for (const line of items) assert.ok(line.length <= 60, `${line.length} columns: ${line}`);
  });

  it('colours the plan only on a terminal with colours, and never with NO_COLOR', async () => {
    const coloured = fresh();
    coloured.env = { TERM: 'xterm-256color' };
    const { out } = await run(coloured, ['example-owner', AGENT, '--dry-run']);
    assert.equal(out[0], `\u001b[36m◆\u001b[0m  niyam onboard   v${packageVersion()}`);
    assert.ok(out.includes('\u001b[32m◇\u001b[0m  Check'));
    for (const env of [{ TERM: 'xterm-256color', NO_COLOR: '1' }, { TERM: 'dumb' }]) {
      const plain = fresh();
      plain.env = env;
      assert.ok(!(await run(plain, ['example-owner', AGENT, '--dry-run'])).out.some((line) => line.includes('\u001b[')));
    }
    const piped = fresh();
    piped.tty = false;
    piped.env = { TERM: 'xterm-256color' };
    assert.ok(!(await run(piped, ['example-owner', AGENT, '--dry-run'])).out.some((line) => line.includes('\u001b[')));
  });

  it("shows gh's own errors from the sign-in, as gh wrote them", async () => {
    const sys = fresh();
    sys.ghToken = undefined;
    const { out } = await run(sys);
    assert.ok(out.includes('│  authentication cancelled'), out.join('\n'));
    // The board app is the first step that acts as the owner.
    assert.ok(out.includes('■  board app'));
  });

  it('works out the workflow once the agent can push, when the default branch is not known before', async () => {
    const sys = fresh();
    let added = false;
    sys.route('GET', REPO, () => (added ? { status: 200, json: repoJson(true, 'trunk') } : { status: 404, json: null }));
    sys.route('GET', '/user/repository_invitations?per_page=100&page=1', { status: 200, json: [] });
    sys.route('PUT', COLLABORATOR, () => {
      added = true;
      return { status: 204, json: null };
    });
    const { code, out } = await run(sys);
    assert.equal(code, 0);
    assert.ok(planned(out, 'Pull request').includes('workflow: new'), out.join('\n'));
    assert.match(repo(sys).get(WORKFLOW) ?? '', /branches: \["trunk"\]/);
    // An existing workflow may change with the branch, which only GitHub can say: the plan says so.
    const existing = fresh();
    existing.files.set(WORKFLOW, workflow('main', packageVersion(), true));
    existing.route('GET', REPO, { status: 404, json: null });
    existing.route('GET', '/user/repository_invitations?per_page=100&page=1', { status: 200, json: [] });
    assert.ok(planned((await run(existing, ['example-owner', AGENT, '--dry-run'])).out, 'Pull request').includes('workflow: write or update'));
  });

  it("leaves a Project made before the template as it is, naming what is left to do by hand", async () => {
    const sys = fresh();
    const board = new Board(sys);
    board.issueTypes = ISSUE_TYPES.map((t) => t.name);
    board.labels = LABELS.map((l) => l.name);
    board.project = { fields: [...BUILT_IN, ...FIELDS.map((f) => f.name)], linked: true, views: settledViews(), items: [{ content: 'ISSUE_a', values: {} }] };
    const { code, out } = await run(sys);
    assert.equal(code, 0);
    assert.ok(!board.operations.includes('copyProjectV2'), 'not replaced');
    assert.equal(board.project?.closed, undefined);
    assert.equal(byHand(out)[0], `Once for the board: at ${URL}, add the Type column to Needs you, group Work items by Step and Decisions by Decision, and set the Auto-archive items workflow to is:closed updated:<@today-7d, which GitHub's API cannot.`);
    assert.ok(opened(sys)?.body.includes('  - Finish the Project'), 'the checklist is in the pull request');
  });
});

describe("onboard's pull request", () => {
  /** onboard's git step whose arguments start with `prefix`, in the temporary repository, failing. */
  const failing = (sys: FakeSys, prefix: string): void => {
    sys.execOverride = (call) =>
      call.cwd?.startsWith('/tmp/niyam-') && call.args.join(' ').startsWith(prefix) ? { code: 1, stdout: '', stderr: 'boom\n' } : undefined;
  };

  for (const [step, said] of [
    ['init', 'onboard: git init failed: boom'],
    ['fetch', 'onboard: git fetch failed: boom'],
    ['hash-object -w', 'onboard: storing .github/niyam.json failed: boom'],
    ['update-index', 'onboard: staging .github/niyam.json failed: boom'],
    ['write-tree', 'onboard: git write-tree failed: boom'],
    ['commit-tree', 'onboard: signing the commit failed: boom'],
    ['push -q https://github.com/example-org/example-app.git +', 'onboard: pushing as ExampleBot failed: boom'],
  ] as const) {
    it(`deletes the temporary repository and opens nothing when ${step} fails`, async () => {
      const sys = fresh();
      failing(sys, step);
      const { code, err } = await run(sys);
      assert.deepEqual({ code, err }, { code: 1, err: [said, 'onboard: stopped at "pull request"; nothing after it was changed, and no pull request was opened'] });
      const temp = sys.calls.find((c) => c.args[0] === 'init' && c.cwd?.startsWith('/tmp/niyam-'))?.cwd;
      assert.ok(temp && sys.removed.includes(temp), 'the temporary repository is deleted');
      assert.ok(!sys.requests.some((r) => r.method === 'POST' && r.url.endsWith('/pulls')));
    });
  }

  it('deletes a moved file in the index, and stops when git cannot', async () => {
    const moving = (): FakeSys => {
      const sys = fresh();
      sys.files.set(OLD_CLOUD, CLOUD_FILE);
      return sys;
    };
    const sys = moving();
    assert.equal((await run(sys)).code, 0);
    assert.ok(sys.calls.some((c) => c.cwd === '/tmp/niyam-2' && c.args.join(' ') === `update-index --force-remove ${LEFTOVER_CLOUD_SETUP_PATH}`));
    assert.ok(!(opened(sys)?.body ?? '').includes('a Setup script pasted before niyam 0.6.10'), 'a first cloud setup file asks for no Setup script change');
    // Beside the new file, a Setup script pasted before 0.6.10 may run the old one.
    const both = moving();
    both.files.set(CLOUD, CLOUD_FILE);
    const beside = await run(both);
    assert.equal(beside.code, 0);
    assert.ok(planned(beside.out, 'Pull request').includes(`cloud-setup.sh: ${LEFTOVER_CLOUD_SETUP_PATH.slice('.github/'.length)} deleted`), planned(beside.out, 'Pull request').join('\n'));
    assert.ok(opened(both)?.body.includes(`\n- Claude cloud sessions: a Setup script pasted before niyam 0.6.10 runs ${LEFTOVER_CLOUD_SETUP_PATH}, which this pull request deletes;`), opened(both)?.body);
    // Where no new file is written, the old one stays.
    const unreleased = moving();
    unreleased.route('GET', `/repos/veda-hq/niyam/releases/tags/v${packageVersion()}`, { status: 404, json: { message: 'Not Found' } });
    assert.equal((await run(unreleased)).code, 0);
    assert.ok(!unreleased.deleted.has(LEFTOVER_CLOUD_SETUP_PATH));
    const failed = moving();
    failing(failed, 'update-index --force-remove');
    const { code, err } = await run(failed);
    assert.deepEqual({ code, err }, { code: 1, err: [`onboard: deleting ${LEFTOVER_CLOUD_SETUP_PATH} failed: boom`, 'onboard: stopped at "pull request"; nothing after it was changed, and no pull request was opened'] });
  });

  it('refuses a file the default branch has otherwise than this checkout, pushing nothing', async () => {
    const sys = fresh();
    sys.tip = new Map([['.github/niyam.json', '{"owner":"someone-else"}\n']]);
    const { code, err } = await run(sys);
    assert.equal(code, 1);
    assert.deepEqual(err, ['onboard: .github/niyam.json on main is not what this checkout has; bring this checkout up to date with main and run onboard again', 'onboard: stopped at "pull request"; nothing after it was changed, and no pull request was opened']);
    assert.ok(!sys.calls.some((c) => c.args.join(' ').includes('refs/heads/niyam/onboard')));
    assert.ok(sys.removed.includes('/tmp/niyam-2'));
  });

  it('updates the pull request a run before opened', async () => {
    const sys = fresh();
    sys.route('POST', `${REPO}/pulls`, { status: 422, json: { message: 'Validation Failed' } });
    sys.route('GET', `${REPO}/pulls?state=open&head=example-org:niyam/onboard`, { status: 200, json: [{ number: 5, html_url: 'https://github.com/example-org/example-app/pull/5' }] });
    sys.route('PATCH', `${REPO}/pulls/5`, { status: 200, json: {} });
    const { code, out, err } = await run(sys);
    assert.deepEqual([code, err], [0, []]);
    const patched = sys.requests.find((r) => r.method === 'PATCH');
    assert.equal(patched?.token, TOKEN);
    assert.match((patched?.body as { body: string }).body, /Running onboard again updates this pull request\.$/);
    assert.equal((patched?.body as { title: string }).title, `chore(niyam): onboard at v${packageVersion()}`, 'an older title is made conventional');
    assert.ok(out.includes('└  Merge https://github.com/example-org/example-app/pull/5'), 'no id from the open list: the owner merges it');
    assert.ok(byHand(out).includes('Now: merge https://github.com/example-org/example-app/pull/5 yourself once its checks pass, since GitHub refused auto-merge (GitHub gave no id for the pull request).'), out.join('\n'));
  });

  it('asks for no onboard pull request from the branch before P-56, and pushes to niyam/onboard (P-57)', async () => {
    const sys = fresh();
    sys.route('GET', `${REPO}/pulls?state=open&head=example-org:process-rules/onboard`, { status: 200, json: [{ number: 9 }] });
    assert.equal((await run(sys)).code, 0);
    assert.ok(!sys.requests.some((r) => r.url.includes('process-rules/onboard')));
    assert.equal((opened(sys) as { head?: string } | undefined)?.head, 'niyam/onboard');
  });

  it('says so when the description of the open pull request cannot be updated, and goes on', async () => {
    const sys = fresh();
    sys.route('POST', `${REPO}/pulls`, { status: 422, json: { message: 'Validation Failed' } });
    sys.route('GET', `${REPO}/pulls?state=open&head=example-org:niyam/onboard`, { status: 200, json: [{ number: 5, html_url: 'https://github.com/example-org/example-app/pull/5' }] });
    const { code, err } = await run(sys);
    assert.deepEqual([code, err], [0, ['onboard: could not update the description of https://github.com/example-org/example-app/pull/5 (HTTP 404)']]);
  });

  for (const [name, route, said] of [
    ['refuses it', { status: 403, json: { message: 'Resource not accessible' } }, 'onboard: GitHub did not open the pull request (HTTP 403: Resource not accessible); the changes are on niyam/onboard'],
    ['finds no open one after a 422', { status: 422, json: null }, 'onboard: GitHub did not open the pull request (HTTP 422); the changes are on niyam/onboard'],
  ] as const) {
    it(`fails when GitHub ${name}`, async () => {
      const sys = fresh();
      sys.route('POST', `${REPO}/pulls`, route);
      const { code, err } = await run(sys);
      assert.deepEqual({ code, err }, { code: 1, err: [said, 'onboard: stopped at "pull request"; nothing after it was changed, and no pull request was opened'] });
    });
  }

  it('describes a new workflow as written, and one it does not know as replaced', async () => {
    const path = WORKFLOW_PATH.replaceAll('.', '\\.');
    const sys = fresh();
    assert.equal((await run(sys)).code, 0);
    assert.match(opened(sys)?.body ?? '', new RegExp(`^- \`${path}\`: write ${path}, which runs the shared niyam checks$`, 'm'));
    assert.equal(sys.requests.filter((r) => r.url.includes('/contents/.mergify.yml')).length, 1, 'the merge queue is asked about once, where the agent could push from the start');
    const own = fresh();
    own.files.set(WORKFLOW, 'name: ours\n');
    const replaced = await run(own);
    assert.equal(replaced.code, 0);
    assert.ok(planned(replaced.out, 'Pull request').includes('workflow: replaced'), replaced.out.join('\n'));
    assert.match(opened(own)?.body ?? '', new RegExp(`^- \`${path}\`: replace ${path}, which runs the shared niyam checks$`, 'm'));
  });

  it("adds a settings change to the settings file's own line in the plan", async () => {
    const sys = fresh();
    sys.files.set(SETTINGS, JSON.stringify({ owner: 'example-owner', agent: AGENT, features: ['identity'] }));
    sys.route('GET', '/user/ssh_signing_keys?per_page=100', { status: 200, json: [{ id: 3, title: 'niyam cloud signing', key: 'ssh-ed25519 AAAAcloud', created_at: '2026-11-16T00:00:00Z' }] });
    const { code, out } = await run(sys);
    assert.equal(code, 0, out.join('\n'));
    const pull = planned(out, 'Pull request');
    assert.equal(pull[0], 'settings.json: new', pull.join('\n'));
    assert.ok(pull.includes("niyam.json: pin ExampleBot's cloud signing key, which cloud sessions check theirs against"), pull.join('\n'));
  });

  it('commits each file once, with every change to it described', async () => {
    const sys = fresh();
    sys.files.set(SETTINGS, JSON.stringify({ owner: 'example-owner', agent: AGENT, features: ['identity'], figma: { library: 'abc' } }));
    sys.files.set(HOOKS, JSON.stringify(CLAUDE));
    sys.files.set(PRE_PUSH, PRE_PUSH_HOOK);
    sys.files.set(CLOUD, CLOUD_FILE);
    new Board(sys);
    await actionsKey(sys);
    const { code, out } = await run(sys, ['--add', 'board']);
    assert.equal(code, 0);
    assert.deepEqual([...sys.committed.keys()], ['.github/niyam.json', WORKFLOW_PATH, GUARD_CALLER_PATH]);
    const { body } = sys.requests.find((r) => r.method === 'POST' && r.url.endsWith('/pulls'))?.body as { body: string };
    assert.match(body, /^- `\.github\/niyam\.json`: take out "figma" .*; turn board on$/m);
    assert.ok(planned(out, 'Pull request').includes('niyam.json: figma key out, turn board on'), out.join('\n'));
    assert.equal(signIns(sys), 1, 'one sign-in, for the secret and the board');
    const login = sys.calls.find((call) => call.command === 'gh' && call.args[1] === 'login')?.args ?? [];
    assert.equal(login[login.indexOf('-s') + 1], 'project,admin:org', "the sign-in for the secret asks for the board's scopes too");
  });
});

describe('onboardArgs', () => {
  it('reads logins, --features and --add', () => {
    assert.deepEqual(onboardArgs(['a', 'b', '--features', 'board, work-rules']), { named: ['a', 'b'], features: ['identity', 'board', 'work-rules'] });
    assert.deepEqual(onboardArgs(['--add', 'review']), { named: [], add: 'review' });
    assert.deepEqual(onboardArgs(['a', '--yes', 'b', '--dry-run']), { named: ['a', 'b'], yes: true, dryRun: true });
  });

  for (const [args, message] of [
    [['--features'], /--features needs a value/],
    [['--add', 'board,review'], /--add takes one feature other than identity/],
    [['--add', 'identity'], /--add takes one feature other than identity/],
    [['--features', 'boards'], /unknown feature boards; the features are identity, pr-identity/],
    [['--force'], /unknown option --force/],
    [['a', 'b', 'c'], /unexpected argument "c"/],
  ] as const) {
    it(`refuses ${args.join(' ')}`, () => {
      assert.throws(() => onboardArgs([...args]), message);
    });
  }
});

describe('workflow', () => {
  it('names the settings file above a schedule the settings set', () => {
    assert.match(workflow('main', '0.1.0', false, '5 4 * * 2'), /^ {2}# The decisions job: cron 5 4 \* \* 2, UTC, as "schedule" in \.github\/niyam\.json sets it\.$/m);
  });

  it('reads no pin of athya-hq/process-rules, the repo before niyam, nor a process-rules-ref, and replaces a workflow with the ids before P-56 (P-57)', () => {
    const before = workflow('main', '0.6.1', false).replaceAll('veda-hq/niyam/', 'athya-hq/process-rules/');
    assert.deepEqual(workflowPins(before), Array(4).fill('0.6.1'), 'only the niyam-ref lines');
    assert.deepEqual(workflowPins(oldIds(workflow('main', '0.6.1', false))), Array(4).fill('0.6.1'), 'only the uses: lines');
    assert.deepEqual(workflowUpdate(oldIds(workflow('main', '0.6.1', false)), 'main', '0.6.2', false), { kind: 'replace', text: workflow('main', '0.6.2', false) });
  });

  it('writes, at the same pin, what 0.6.8 wrote for veda-hq/niyam, but for the ids P-56 renamed and the queue-draft skip (#685)', () => {
    assert.equal(oldIds(workflow('main', '0.6.8', false)).replace(READ_ONLY_IF, OLDER_READ_ONLY_IF), WORKFLOW_068_NIYAM);
  });

  it("calls the product's shared checks on pull requests and the default branch", () => {
    const text = workflow('main', '0.1.0', true);
    assert.match(text, /uses: veda-hq\/niyam\/\.github\/workflows\/checks\.yml@v0\.1\.0\n {4}with:\n {6}niyam-ref: v0\.1\.0\n/);
    assert.doesNotMatch(text, /process-rules/, 'nothing of the old name since P-56');
    assert.match(text, /branches: \["main"\]/);
    assert.match(text, /^# To upgrade, change the version on every line that names it \(two per job\)\.$/m);
    assert.deepEqual(workflowPins(text), Array(8).fill('0.1.0'));
  });

  it('keeps pull request and push runs read-only, and writes to issues on the weekly run and a merged pull request alone', () => {
    const text = workflow('main', '0.1.0', true);
    assert.match(text, /^permissions:\n {2}contents: read\n {2}issues: read\n {2}pull-requests: read$/m);
    assert.match(text, /^ {4}types: \[opened, synchronize, reopened, edited, closed\]$/m);
    const [, prJob = '', weeklyJob = '', mergedJob = '', asksJob = ''] = text.split(/^ {2}(?:niyam|niyam-weekly|niyam-merged|niyam-asks):$/m);
    assert.ok(
      prJob.includes(
        "    name: niyam\n    # Not on an edit of Mergify's queue draft that changes no title or base: its head's runs stand (veda-hq/niyam#685).\n    if: >-\n" +
          "      (github.event_name == 'pull_request' && github.event.action != 'closed' && !(github.event.action == 'edited' && !github.event.changes.title && !github.event.changes.base &&\n" +
          "      github.event.pull_request.user.login == 'mergify[bot]' && github.event.pull_request.user.type == 'Bot' &&\n" +
          "      startsWith(github.event.pull_request.head.ref, 'mergify/merge-queue/') &&\n" +
          '      github.event.pull_request.head.repo.full_name == github.repository &&\n' +
          "      !contains(github.event.pull_request.title, ' pull requests ahead'))) || github.event_name == 'push'\n    uses:",
      ),
      'every pull request event but closed and an edit of Mergify\'s queue draft at its head, and pushes',
    );
    assert.doesNotMatch(prJob, /permissions:|: write/);
    assert.match(weeklyJob, /^ {4}if: \(github\.event_name == 'schedule' && github\.event\.schedule != '41 \* \* \* \*'\) \|\| github\.event_name == 'workflow_dispatch'$/m);
    assert.match(weeklyJob, /^ {4}permissions:\n {6}contents: read\n {6}issues: write\n {6}pull-requests: read$/m);
    assert.ok(
      asksJob.includes(
        "    if: >-\n      ((github.event_name == 'issue_comment' || github.event_name == 'pull_request_review_comment') &&\n      contains(fromJSON('[\"OWNER\", \"MEMBER\", \"COLLABORATOR\"]'), github.event.comment.author_association) &&\n      (contains(github.event.comment.body, 'Needs you:') || contains(github.event.comment.body, 'Proposal:') ||\n      contains(github.event.comment.body, 'Decision:'))) ||\n      (github.event_name == 'issues' && github.event.label.name == 'approved') ||\n      (github.event_name == 'issues' && (github.event.action == 'opened' || github.event.action == 'reopened')) ||\n      (github.event_name == 'schedule' && github.event.schedule == '41 * * * *')\n",
      ),
      'only comments by the owner, a member or a collaborator that may ask or decide, the approved label, an issue opened or reopened, and the hourly sweep',
    );
    assert.match(asksJob, /^ {4}permissions:\n {6}contents: read\n {6}issues: write\n {6}pull-requests: write$/m);
    assert.ok(text.includes("  issue_comment:\n    types: [created]\n  pull_request_review_comment:\n    types: [created]\n  # opened, reopened: an issue with no type gets the work model's.\n  issues:\n    types: [labeled, opened, reopened]\n  # The weekly decisions job: Mondays, 06:17 UTC.\n  schedule:\n    - cron: '17 6 * * 1'\n    # Hourly: the owner's 👍 on an ask takes its needs-owner label off.\n    - cron: '41 * * * *'\n  workflow_dispatch:\n"));
    assert.ok(
      mergedJob.includes(
        "    if: >-\n      github.event_name == 'pull_request' && github.event.action == 'closed' && github.event.pull_request.merged &&\n      github.event.pull_request.base.ref == github.event.repository.default_branch &&\n      github.event.pull_request.head.repo.full_name == github.repository\n",
      ),
      'only a merge into the default branch from the repository itself',
    );
    assert.match(mergedJob, /^ {4}permissions:\n {6}contents: read\n {6}issues: write\n {6}pull-requests: read$/m);
    assert.equal(text.match(/issues: write/g)?.length, 3);
  });
});

/** What adding the needs-owner job says, which also types each new issue. */
const ASKS_WHAT =
  "add a job that labels an issue needs-owner where the agent asks the owner, and takes it off at the owner's approved label, Decision: comment or (hourly) 👍 and start the needs-owner job when an issue is opened or reopened too, which gives one with no type the work model's";

/** What adding the queue-draft skip (#685) says. */
const DRAFTS_WHAT = "skip the pull request job on an edit of Mergify's queue draft that changes no title or base, so the draft's last niyam checks at its head stand";

/** `text`, a workflow onboard writes, with the read-only job's condition as releases before the queue-draft skip (#685) wrote it. */
function beforeDrafts(text: string): string {
  assert.equal(text.split(READ_ONLY_IF).length, 2);
  return text.replace(READ_ONLY_IF, OLDER_READ_ONLY_IF);
}

/** The three-job workflow releases before the needs-owner job wrote, from this release's. */
function threeJobs(version: string, figma: boolean, schedule?: string): string {
  return beforeDrafts(workflow('main', version, figma, schedule))
    .replace(/\n {2}# An ask labels its issue[\s\S]*$/, '\n')
    .replace('# The weekly, merged and needs-owner jobs are split out', '# The weekly and merged jobs are split out')
    .replace(/ {2}# A comment that asks the owner[^\n]*\n {2}issue_comment:\n {4}types: \[created\]\n {2}pull_request_review_comment:\n {4}types: \[created\]\n(?: {2}# opened, reopened:[^\n]*\n)? {2}issues:\n {4}types: \[labeled(?:, opened, reopened)?\]\n/, '')
    .replace(/ {4}# Hourly:[^\n]*\n {4}- cron: '41 \* \* \* \*'\n/, '')
    .replace("(github.event_name == 'schedule' && github.event.schedule != '41 * * * *') || github.event_name == 'workflow_dispatch'", "github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'");
}

/** The two-job workflow releases before the merged job wrote, from this release's. */
function twoJobs(version: string, figma: boolean): string {
  return threeJobs(version, figma)
    .replace(/\n {2}# A merged pull request[\s\S]*$/, '')
    .replace('# The weekly and merged jobs are split out', '# The weekly job is split out')
    .replace('    # edited: a changed "Slice: #N" line is checked again; closed: a merged pull request closes its slice.\n    types: [opened, synchronize, reopened, edited, closed]', '    # edited: a changed "Slice: #N" line is checked again.\n    types: [opened, synchronize, reopened, edited]')
    .replace("(github.event_name == 'pull_request' && github.event.action != 'closed') || github.event_name == 'push'", "github.event_name == 'pull_request' || github.event_name == 'push'");
}

describe('workflowUpdate', () => {
  it('writes a missing workflow and leaves the same one alone', () => {
    assert.deepEqual(workflowUpdate(undefined, 'main', '0.5.3', true), { kind: 'write', text: workflow('main', '0.5.3', true) });
    assert.deepEqual(workflowUpdate(workflow('main', '0.5.3', true), 'main', '0.5.3', true), { kind: 'same' });
  });

  it('moves the pins of a split workflow, quoted or not, and nothing else', () => {
    const before = workflow('main', '0.5.2', true)
      .replace("branches: [\"main\"]", "branches: ['main']")
      .replace('name: niyam\n', 'name: niyam\n# Our own note: split by hand at v0.5.2.\n')
      .replace('niyam-ref: v0.5.2\n    secrets', "niyam-ref: 'v0.5.2'\n    secrets");
    const update = workflowUpdate(before, 'main', '0.5.3', true);
    assert.equal(update.kind, 'repin');
    assert.ok(update.kind === 'repin');
    assert.equal(update.from, '0.5.2');
    assert.equal(update.text, before.replaceAll('0.5.2', '0.5.3').replace('split by hand at v0.5.3', 'split by hand at v0.5.2'));
    assert.match(update.text, /^# Our own note: split by hand at v0\.5\.2\.$/m);
    assert.deepEqual(workflowPins(update.text), Array(8).fill('0.5.3'));
  });


  it("sets each job's Figma secrets to what figma needs, leaving secrets of the client's own", () => {
    const older = workflow('main', '0.5.4', false).replaceAll(
      '      niyam-ref: v0.5.4\n',
      '      niyam-ref: v0.5.4\n    secrets:\n      FIGMA_TOKEN: ${{ secrets.FIGMA_TOKEN }}\n',
    );
    assert.deepEqual(workflowUpdate(older, 'main', '0.5.5', true), { kind: 'repin', text: workflow('main', '0.5.5', true), from: '0.5.4', secrets: true });
    assert.deepEqual(workflowUpdate(older, 'main', '0.5.5', false), { kind: 'repin', text: workflow('main', '0.5.5', false), from: '0.5.4', secrets: true });
    assert.deepEqual(workflowUpdate(workflow('main', '0.5.5', true), 'main', '0.5.5', false), { kind: 'repin', text: workflow('main', '0.5.5', false), secrets: true });
    const own = older.replaceAll('FIGMA_TOKEN: ${{ secrets.FIGMA_TOKEN }}\n', 'FIGMA_TOKEN: ${{ secrets.FIGMA_TOKEN }}\n      OTHER: ${{ secrets.OTHER }}\n');
    const update = workflowUpdate(own, 'main', '0.5.5', false);
    assert.ok(update.kind === 'repin' && !update.secrets && update.text === own.replaceAll('0.5.4', '0.5.5'));
    const kept = workflowUpdate(own, 'main', '0.5.5', true);
    assert.ok(kept.kind === 'repin' && !kept.secrets && kept.text === own.replaceAll('0.5.4', '0.5.5'));
  });

  it("passes the board app's secrets on the pull request job alone, beside the Figma secrets, and takes them off with board off (P-70)", () => {
    const BOARD_LINES = '      NIYAM_BOARD_APP_ID: ${{ secrets.NIYAM_BOARD_APP_ID }}\n      NIYAM_BOARD_APP_KEY: ${{ secrets.NIYAM_BOARD_APP_KEY }}\n';
    const both = workflow('main', '0.5.5', true, undefined, undefined, true);
    // The niyam job's block alone: Figma first, then the board app's.
    assert.equal(both.split(BOARD_LINES).length, 2);
    assert.ok(both.includes(`    secrets:\n      FIGMA_TOKEN: \${{ secrets.FIGMA_TOKEN }}\n      FIGMA_LIBRARY: \${{ secrets.FIGMA_LIBRARY }}\n${BOARD_LINES}\n  # The weekly run alone`));
    const boardOnly = workflow('main', '0.5.5', false, undefined, undefined, true);
    assert.equal(boardOnly.match(/^ {4}secrets:$/gm)?.length, 1, 'no Figma secrets, so only the niyam job has a block');
    assert.ok(boardOnly.includes(`      niyam-ref: v0.5.5\n    secrets:\n${BOARD_LINES}\n  # The weekly run alone`));

    // An upgrade from a Figma-only workflow adds the board app's lines and moves the pins, so the shared checks it calls declare them.
    assert.deepEqual(workflowUpdate(workflow('main', '0.5.4', true), 'main', '0.5.5', true, undefined, undefined, true), { kind: 'repin', text: both, from: '0.5.4', board: true });
    assert.deepEqual(workflowUpdate(workflow('main', '0.5.4', false), 'main', '0.5.5', false, undefined, undefined, true), { kind: 'repin', text: boardOnly, from: '0.5.4', board: true });
    // A round trip back to off, and Figma off with board kept.
    assert.deepEqual(workflowUpdate(both, 'main', '0.5.5', true), { kind: 'repin', text: workflow('main', '0.5.5', true), board: true });
    assert.deepEqual(workflowUpdate(both, 'main', '0.5.5', false, undefined, undefined, true), { kind: 'repin', text: boardOnly, secrets: true });
    assert.deepEqual(workflowUpdate(both, 'main', '0.5.5', true, undefined, undefined, true), { kind: 'same' });

    // A block with a secret of the client's own, or secrets: inherit, is left as it is.
    const own = workflow('main', '0.5.4', true).replace('FIGMA_LIBRARY: ${{ secrets.FIGMA_LIBRARY }}\n', 'FIGMA_LIBRARY: ${{ secrets.FIGMA_LIBRARY }}\n      OTHER: ${{ secrets.OTHER }}\n');
    const kept = workflowUpdate(own, 'main', '0.5.5', true, undefined, undefined, true);
    assert.ok(kept.kind === 'repin' && !kept.board && kept.text.includes('      OTHER: ${{ secrets.OTHER }}\n\n  # The weekly run alone'), 'the niyam job kept its own block');
    const inherit = workflow('main', '0.5.4', false).replace('      niyam-ref: v0.5.4\n\n  # The weekly run alone', '      niyam-ref: v0.5.4\n    secrets: inherit\n\n  # The weekly run alone');
    const inherited = workflowUpdate(inherit, 'main', '0.5.5', false, undefined, undefined, true);
    assert.ok(inherited.kind === 'repin' && !inherited.board && inherited.text.includes('    secrets: inherit\n') && !inherited.text.includes('NIYAM_BOARD_APP_ID'));
  });

  it("with no one at the terminal, says how to set up the board app for the secrets the repository lacks, its own and its organization's counted, and nothing once both are set", async () => {
    const BOTH = ['NIYAM_BOARD_APP_ID', 'NIYAM_BOARD_APP_KEY'] as const;
    assert.equal(
      boardAppSteps('example-org/example-app', BOTH),
      'Once for example-org: make a GitHub App with organization Projects read and write and repository Issues read at https://github.com/organizations/example-org/settings/apps/new, install it on example-org/example-app, and set its client id as NIYAM_BOARD_APP_ID and its private key as NIYAM_BOARD_APP_KEY, Actions secrets of the organization or of https://github.com/example-org/example-app/settings/secrets/actions. Until then a slice moves to In Progress on the board only from a desktop push.',
    );
    const secrets = (sys: FakeSys, own: string[], org: string[]): void => {
      sys.route('GET', `${REPO}/actions/secrets?per_page=100&page=1`, { status: 200, json: { total_count: own.length, secrets: own.map((name) => ({ name })) } });
      sys.route('GET', `${REPO}/actions/organization-secrets?per_page=100&page=1`, { status: 200, json: { total_count: org.length, secrets: org.map((name) => ({ name })) } });
    };
    for (const [own, org, steps] of [
      [[], [], boardAppSteps('example-org/example-app', BOTH)],
      [['FIGMA_TOKEN'], ['NIYAM_BOARD_APP_ID'], boardAppSteps('example-org/example-app', ['NIYAM_BOARD_APP_KEY'])],
      [['NIYAM_BOARD_APP_KEY'], ['NIYAM_BOARD_APP_ID'], undefined],
    ] as const) {
      const sys = fresh();
      sys.tty = false;
      secrets(sys, [...own], [...org]);
      const { code, out } = await run(sys, ['example-owner', AGENT, '--yes']);
      assert.equal(code, 0);
      assert.ok(!sys.requests.some((r) => r.url.includes('/orgs/example-org/actions/secrets')), 'no board app step');
      const lines = byHand(out).filter((line) => line.includes('GitHub App'));
      assert.deepEqual(lines, steps === undefined ? [] : [steps], `${own.join(',')} / ${org.join(',')}`);
      if (steps !== undefined) assert.ok(opened(sys)?.body.includes(`\n- ${steps}`), 'and in the pull request, left to do by hand');
    }
    assert.ok(boardAppSteps('example-org/example-app', ['NIYAM_BOARD_APP_KEY']).includes('and set its private key as NIYAM_BOARD_APP_KEY, Actions secrets'));
    // Secrets GitHub will not list may be set already, which the step says.
    const unread = fresh();
    unread.tty = false;
    unread.route('GET', `${REPO}/actions/secrets?per_page=100&page=1`, { status: 403, json: { message: 'Must have admin rights' } });
    const { out: unreadOut } = await run(unread, ['example-owner', AGENT, '--yes']);
    assert.deepEqual(byHand(unreadOut).filter((line) => line.includes('GitHub App')), [boardAppSteps('example-org/example-app', BOTH, true)]);
    // Board off, or a personal repository, whose checks skip the work rules: no app to set up.
    const off = fresh();
    off.files.set(SETTINGS, JSON.stringify({ owner: 'example-owner', agent: AGENT, features: ['identity', 'work-rules'] }));
    assert.ok(!byHand((await run(off)).out).some((line) => line.includes('GitHub App')));
  });

  it('sets up the board app as the owner at the terminal, leaving by hand, in both places, only what GitHub refused, and going on', async () => {
    const sys = fresh();
    sys.route('GET', '/orgs/example-org/actions/secrets?per_page=100&page=1', { status: 403, json: { message: 'Must have admin rights' } });
    const { code, out } = await run(sys);
    assert.equal(code, 0);
    assert.ok(planned(out, 'GitHub').includes('board app: two clicks in the browser, if it is new'), out.join('\n'));
    const left = `${boardAppSteps('example-org/example-app', ['NIYAM_BOARD_APP_ID', 'NIYAM_BOARD_APP_KEY'])} onboard did not: GitHub would not list example-org's Actions secrets.`;
    assert.ok(out.includes('◇  board app'), 'the step passes: the run goes on');
    assert.ok(!opened(sys)?.body.includes('\n- board app:'), 'a step that said nothing is not listed as done at the terminal');
    assert.ok(byHand(out).includes(left), out.join('\n'));
    assert.ok(opened(sys)?.body.includes(`\n- ${left}`), 'and in the pull request, left to do by hand');
    // An agent's or a cloud session cannot click in the owner's browser.
    for (const env of [{ CLAUDECODE: '1' }, { CLAUDE_CODE_REMOTE: 'true' }]) {
      const agent = fresh();
      agent.env = env;
      const { out: planOnly } = await run(agent, ['example-owner', AGENT, '--dry-run']);
      assert.ok(!planned(planOnly, 'GitHub').some((item) => item.startsWith('board app')), JSON.stringify(env));
    }
  });

  it("asks to pass, or stop passing, the board app's secrets", async () => {
    const sys = fresh();
    sys.files.set(SETTINGS, JSON.stringify({ owner: 'example-owner', agent: AGENT, features: ['identity', 'board'] }));
    sys.files.set(HOOKS, JSON.stringify(CLAUDE));
    sys.files.set(PRE_PUSH, PRE_PUSH_HOOK);
    sys.files.set(CLOUD, CLOUD_FILE);
    sys.files.set(WORKFLOW, workflow('main', packageVersion(), false));
    const on = await run(sys);
    assert.equal(on.out[0], `◆  niyam onboard   v${packageVersion()}`, 'a workflow at this release moves from none');
    assert.ok(planned(on.out, 'Pull request').includes('workflow: board app secrets'), on.out.join('\n'));
    assert.ok(
      opened(sys)?.body.includes(
        `\n- \`${WORKFLOW_PATH}\`: in ${WORKFLOW_PATH}, pass the pull request job's checks the board app's NIYAM_BOARD_APP_ID and NIYAM_BOARD_APP_KEY secrets, which move a slice to In Progress when its pull request opens, leaving the rest as it is\n`,
      ),
    );
    assert.equal(repo(sys).get(WORKFLOW), workflow('main', packageVersion(), false, undefined, undefined, true));
    merge(sys);
    sys.files.set(SETTINGS, JSON.stringify({ owner: 'example-owner', agent: AGENT, features: ['identity', 'work-rules'] }));
    sys.requests.length = 0;
    sys.answers = ['y'];
    const off = await run(sys);
    assert.deepEqual(planned(off.out, 'Pull request'), ['workflow: no board app secrets', 'auto-merge: when checks pass']);
    assert.ok(opened(sys)?.body.includes(`\n- \`${WORKFLOW_PATH}\`: in ${WORKFLOW_PATH}, stop passing the board app secrets, with board off, leaving the rest as it is\n`), opened(sys)?.body);
    assert.equal(repo(sys).get(WORKFLOW), workflow('main', packageVersion(), false));
  });

  it("sets the header's version alone where only the header names an older release", async () => {
    const v = packageVersion();
    const sys = fresh();
    sys.files.set(SETTINGS, JSON.stringify({ owner: 'example-owner', agent: AGENT, features: ['identity', 'work-rules'] }));
    sys.files.set(HOOKS, JSON.stringify(CLAUDE));
    sys.files.set(PRE_PUSH, PRE_PUSH_HOOK);
    sys.files.set(CLOUD, CLOUD_FILE).set(CALLER, CALLER_FILE);
    sys.files.set(WORKFLOW, workflow('main', v, false).replace(`checks at v${v}`, 'checks at v0.5.0'));
    const { code, out } = await run(sys);
    assert.equal(code, 0, out.join('\n'));
    assert.deepEqual(planned(out, 'Pull request'), [`workflow: header → v${v}`, 'auto-merge: when checks pass']);
    assert.ok(opened(sys)?.body.includes(`\n- \`${WORKFLOW_PATH}\`: in ${WORKFLOW_PATH}, set the version in its header comment to v${v}, leaving the rest as it is\n`), opened(sys)?.body);
    assert.equal(repo(sys).get(WORKFLOW), workflow('main', v, false));
  });

  it('asks to pass, or stop passing, the Figma secrets', async () => {
    const sys = fresh();
    sys.files.set(SETTINGS, JSON.stringify({ owner: 'example-owner', agent: AGENT, features: ['identity', 'work-rules'] }));
    sys.files.set(HOOKS, JSON.stringify(CLAUDE));
    sys.files.set(PRE_PUSH, PRE_PUSH_HOOK);
    sys.files.set(CLOUD, CLOUD_FILE).set(CALLER, CALLER_FILE);
    sys.files.set(WORKFLOW, workflow('main', packageVersion(), true));
    const off = await run(sys);
    assert.deepEqual(planned(off.out, 'Pull request'), ['workflow: no Figma secrets', 'auto-merge: when checks pass']);
    assert.ok(!byHand(off.out).some((line) => line.includes('FIGMA_LIBRARY')), 'with figma off no job needs the library');
    assert.ok(opened(sys)?.body.includes(`\n- \`${WORKFLOW_PATH}\`: in ${WORKFLOW_PATH}, stop passing Figma secrets, with figma off, leaving the rest as it is\n`));
    assert.equal(repo(sys).get(WORKFLOW), workflow('main', packageVersion(), false));
    merge(sys);
    sys.files.set(SETTINGS, JSON.stringify({ owner: 'example-owner', agent: AGENT, features: ['identity', 'figma'] }));
    sys.requests.length = 0;
    sys.answers = ['y'];
    const on = await run(sys);
    assert.deepEqual(planned(on.out, 'Pull request'), ['workflow: Figma secrets', 'auto-merge: when checks pass']);
    assert.ok(opened(sys)?.body.includes(`\n- \`${WORKFLOW_PATH}\`: in ${WORKFLOW_PATH}, pass the FIGMA_TOKEN and FIGMA_LIBRARY secrets, leaving the rest as it is\n`));
  });

  it('follows a changed default branch in a split workflow, keeping its quotes', () => {
    const before = workflow('main', '0.5.3', true).replace('branches: ["main"]', "branches: ['main']");
    assert.deepEqual(workflowUpdate(before, 'trunk', '0.5.3', true), { kind: 'repin', text: before.replace("['main']", "['trunk']"), branch: 'trunk' });
    const update = workflowUpdate(workflow('main', '0.5.2', true), 'trunk', '0.5.3', true);
    assert.deepEqual(update, { kind: 'repin', text: workflow('trunk', '0.5.3', true), from: '0.5.2', branch: 'trunk' });
  });

  it('writes the schedule the settings set into the workflow', async () => {
    const sys = fresh();
    sys.files.set(SETTINGS, JSON.stringify({ owner: 'example-owner', agent: AGENT, schedule: '0 9 * * 1-5' }));
    const { code } = await run(sys, []);
    assert.equal(code, 0);
    const text = repo(sys).get(WORKFLOW) ?? '';
    assert.equal(text, full('main', packageVersion(), '0 9 * * 1-5'));
    assert.ok(text.includes(`  # The decisions job: cron 0 9 * * 1-5, UTC, as "schedule" in .github/niyam.json sets it.\n  schedule:\n    - cron: '0 9 * * 1-5'\n`));
    assert.ok(workflow('main', packageVersion(), true).includes("  # The weekly decisions job: Mondays, 06:17 UTC.\n  schedule:\n    - cron: '17 6 * * 1'\n"));
  });

  it('refuses a settings schedule that is not a cron before changing anything', async () => {
    const sys = fresh();
    sys.files.set(SETTINGS, JSON.stringify({ owner: 'example-owner', agent: AGENT, schedule: 'Mondays' }));
    await assert.rejects(run(sys, []), /"schedule" must be a five-field cron/);
    assert.deepEqual(sys.asked, []);
    assert.ok(!repo(sys).has(WORKFLOW));
  });

  it('asks to move a split workflow to a changed schedule, leaving the rest as it is', async () => {
    const sys = fresh();
    sys.files.set(SETTINGS, JSON.stringify({ owner: 'example-owner', agent: AGENT, schedule: '30 5 * * 2' }));
    sys.files.set(HOOKS, JSON.stringify(CLAUDE));
    sys.files.set(PRE_PUSH, PRE_PUSH_HOOK);
    sys.files.set(CLOUD, CLOUD_FILE).set(CALLER, CALLER_FILE);
    const own = full('main', packageVersion()).replace('name: niyam\n', 'name: niyam\n# Our own note.\n');
    sys.files.set(WORKFLOW, own);
    const { code, out } = await run(sys, []);
    assert.equal(code, 0);
    assert.deepEqual(planned(out, 'Pull request'), ['workflow: schedule → 30 5 * * 2', 'auto-merge: when checks pass']);
    assert.ok(opened(sys)?.body.includes(`\n- \`${WORKFLOW_PATH}\`: in ${WORKFLOW_PATH}, run the weekly decisions job on the schedule .github/niyam.json sets, cron 30 5 * * 2 UTC, leaving the rest as it is\n`));
    assert.equal(repo(sys).get(WORKFLOW), full('main', packageVersion(), '30 5 * * 2').replace('name: niyam\n', 'name: niyam\n# Our own note.\n'));
  });

  it('follows a changed schedule in a split workflow, keeping its quotes and leaving a cron of its own', () => {
    const plain = workflow('main', '0.5.3', true);
    assert.deepEqual(workflowUpdate(plain, 'main', '0.5.3', true, '0 9 * * 1-5'), { kind: 'repin', text: workflow('main', '0.5.3', true, '0 9 * * 1-5'), schedule: '0 9 * * 1-5' });
    assert.deepEqual(workflowUpdate(workflow('main', '0.5.3', true, '0 9 * * 1-5'), 'main', '0.5.3', true), { kind: 'repin', text: plain, schedule: '17 6 * * 1' });
    const quoted = plain.replace("- cron: '17 6 * * 1'", '- cron: "17  6 * * 1"');
    assert.deepEqual(workflowUpdate(quoted, 'main', '0.5.3', true), { kind: 'same' });
    const moved = workflowUpdate(quoted, 'main', '0.5.3', true, '0 9 * * 1');
    assert.ok(moved.kind === 'repin' && moved.text.includes('    - cron: "0 9 * * 1"\n'));
    const bare = plain.replace("- cron: '17 6 * * 1'", '- cron: 17 6 * * 1');
    const unquoted = workflowUpdate(bare, 'main', '0.5.3', true, '0 9 * * 1');
    assert.ok(unquoted.kind === 'repin' && unquoted.text.includes("    - cron: '0 9 * * 1'\n"));
    const uncommented = plain.replace('  # The weekly decisions job: Mondays, 06:17 UTC.\n', '');
    const kept = workflowUpdate(uncommented, 'main', '0.5.3', true, '0 9 * * 1');
    assert.ok(kept.kind === 'repin' && kept.text === uncommented.replace("'17 6 * * 1'", "'0 9 * * 1'"));
    const two = plain.replace("    - cron: '17 6 * * 1'\n", "    - cron: '17 6 * * 1'\n    - cron: '0 12 * * 5'\n");
    assert.deepEqual(workflowUpdate(two, 'main', '0.5.3', true, '0 9 * * 1'), { kind: 'same' });
    const apart = plain.replace("    - cron: '17 6 * * 1'\n", "    - cron: '17 6 * * 1'\n\n    # Fridays too.\n    - cron: '0 12 * * 5'\n");
    assert.deepEqual(workflowUpdate(apart, 'main', '0.5.3', true, '0 9 * * 1'), { kind: 'same' });
    const noted = plain.replace("- cron: '17 6 * * 1'", "- cron: '17 6 * * 1' # ours");
    assert.deepEqual(workflowUpdate(noted, 'main', '0.5.3', true, '0 9 * * 1'), { kind: 'same' });
  });

  for (const [quote, written] of [
    ['"', '"it\'s \\"new\\""'],
    ["'", "'it''s \"new\"'"],
    ['', '"it\'s \\"new\\""'],
  ] as const) {
    it(`escapes a default branch with quotes in it, ${quote ? `in ${quote} quotes` : 'bare'}`, () => {
      const before = workflow('main', '0.5.3', true).replace('branches: ["main"]', `branches: [${quote}main${quote}]`);
      const update = workflowUpdate(before, 'it\'s "new"', '0.5.3', true);
      assert.ok(update.kind === 'repin');
      assert.ok(update.text.includes(`\n    branches: [${written}]\n`));
    });
  }

  for (const branch of ['1.0', '2026', '2026-11-01', 'true', 'No', 'null', '0x1F']) {
    it(`quotes a bare default branch YAML would not read as a string, ${branch}`, () => {
      const before = workflow('main', '0.5.3', true).replace('branches: ["main"]', 'branches: [main]');
      const update = workflowUpdate(before, branch, '0.5.3', true);
      assert.ok(update.kind === 'repin');
      assert.ok(update.text.includes(`\n    branches: ["${branch}"]\n`));
    });
  }

  it('leaves a bare branch bare', () => {
    const before = workflow('main', '0.5.3', true).replace('branches: ["main"]', 'branches: [main]');
    const update = workflowUpdate(before, 'release/2.0', '0.5.3', true);
    assert.ok(update.kind === 'repin');
    assert.match(update.text, /^ {4}branches: \[release\/2\.0\]$/m);
  });

  it('leaves a push trigger listing several branches as it is', () => {
    const before = workflow('main', '0.5.2', true).replace('branches: ["main"]', 'branches: ["main", "release"]');
    const update = workflowUpdate(before, 'trunk', '0.5.3', true);
    assert.ok(update.kind === 'repin');
    assert.match(update.text, /branches: \["main", "release"\]/);
    assert.equal(update.branch, undefined);
  });

  it('asks to follow the default branch alone when the pins are current', async () => {
    const sys = fresh();
    sys.files.set(WORKFLOW, full('main', packageVersion()));
    sys.route('GET', REPO, { status: 200, json: repoJson(true, 'trunk') });
    const { out } = await run(sys);
    assert.ok(planned(out, 'Pull request').includes('workflow: branch → trunk'), out.join('\n'));
    assert.ok(opened(sys)?.body.includes(`\n- \`${WORKFLOW_PATH}\`: in ${WORKFLOW_PATH}, run pushes on the default branch, trunk, leaving the rest as it is\n`));
    assert.equal(repo(sys).get(WORKFLOW), full('trunk', packageVersion()));
  });

  it('replaces a workflow it does not recognise, a split one with a pin missing included', () => {
    assert.deepEqual(workflowUpdate('old', 'main', '0.5.3', true), { kind: 'replace', text: workflow('main', '0.5.3', true) });
    const halfPinned = workflow('main', '0.5.2', true).replace(/\n {4}with:\n {6}niyam-ref: v0\.5\.2\n {4}secrets:/, '\n    secrets:');
    assert.equal(workflowPins(halfPinned).length, 7);
    assert.equal(workflowUpdate(halfPinned, 'main', '0.5.3', true).kind, 'replace');
    const changed = twoJobs('0.5.2', true).replace("github.event_name == 'pull_request' || github.event_name == 'push'", "github.event_name == 'push'");
    assert.equal(workflowUpdate(changed, 'main', '0.5.3', true).kind, 'replace');
  });

  it('adds the merged job to a two-job workflow, moving its pins and keeping what the client changed', () => {
    for (const figma of [true, false]) {
      assert.deepEqual(workflowUpdate(twoJobs('0.5.6', figma), 'main', '0.5.16', figma), { kind: 'repin', text: workflow('main', '0.5.16', figma), from: '0.5.6', merged: true, asks: true, types: true, drafts: true });
    }
    const own = twoJobs('0.5.6', true)
      .replace('# The weekly job is split out so pull request and push runs stay read-only.\n', '')
      .replace('name: niyam\n', 'name: niyam\n# Our own note.\n');
    const update = workflowUpdate(`${own}\n\n`, 'main', '0.5.16', true);
    assert.ok(update.kind === 'repin' && update.merged);
    assert.equal(update.text, `${workflow('main', '0.5.16', true).replace(/^# The weekly, merged and needs-owner jobs[^\n]*\n/m, '').replace('name: niyam\n', 'name: niyam\n# Our own note.\n')}`);
  });

  it('asks to add the merged job', async () => {
    const sys = fresh();
    sys.files.set(SETTINGS, JSON.stringify({ owner: 'example-owner', agent: AGENT, features: ['identity', 'work-rules'] }));
    sys.files.set(HOOKS, JSON.stringify(CLAUDE));
    sys.files.set(PRE_PUSH, PRE_PUSH_HOOK);
    sys.files.set(CLOUD, CLOUD_FILE).set(CALLER, CALLER_FILE);
    sys.files.set(WORKFLOW, twoJobs('0.5.6', false));
    const { out } = await run(sys);
    assert.deepEqual(planned(out, 'Pull request'), [`workflow: pins → v${packageVersion()}, merged job, needs-owner job, issue types for new issues, skips Mergify's queue-draft edits`, 'auto-merge: when checks pass']);
    assert.equal(out[0], `◆  niyam onboard   v0.5.6 → v${packageVersion()}`);
    assert.ok(opened(sys)?.body.includes(`\n- \`${WORKFLOW_PATH}\`: in ${WORKFLOW_PATH}, move the version pins from v0.5.6 to v${packageVersion()} and add a job that closes the slice a merged pull request names, the one pull request run that writes to issues and ${ASKS_WHAT} and ${DRAFTS_WHAT}, leaving the rest as it is\n`));
    assert.equal(repo(sys).get(WORKFLOW), workflow('main', packageVersion(), false));
  });

  it('adds the needs-owner job to a three-job workflow, moving its pins and keeping what the client changed', () => {
    for (const figma of [true, false]) {
      assert.deepEqual(workflowUpdate(threeJobs('0.5.26', figma), 'main', '0.5.27', figma), { kind: 'repin', text: workflow('main', '0.5.27', figma), from: '0.5.26', asks: true, types: true, drafts: true });
    }
    assert.deepEqual(workflowUpdate(threeJobs('0.5.27', true), 'main', '0.5.27', true), { kind: 'repin', text: workflow('main', '0.5.27', true), asks: true, types: true, drafts: true });
    // One already given the queue-draft skip by hand: adding the job is all that changes.
    const skipped = threeJobs('0.5.27', true).replace(OLDER_READ_ONLY_IF, READ_ONLY_IF);
    assert.deepEqual(workflowUpdate(skipped, 'main', '0.5.27', true), { kind: 'repin', text: workflow('main', '0.5.27', true), asks: true, types: true });
    assert.deepEqual(workflowUpdate(threeJobs('0.5.26', true, '0 9 * * 1-5'), 'main', '0.5.27', true, '0 9 * * 1-5'), { kind: 'repin', text: workflow('main', '0.5.27', true, '0 9 * * 1-5'), from: '0.5.26', asks: true, types: true, drafts: true });
    const own = threeJobs('0.5.26', true).replace(/^# The weekly and merged jobs[^\n]*\n/m, '').replace('name: niyam\n', 'name: niyam\n# Our own note.\n');
    const update = workflowUpdate(own, 'main', '0.5.27', true);
    assert.ok(update.kind === 'repin' && update.asks);
    assert.equal(update.text, workflow('main', '0.5.27', true).replace(/^# The weekly, merged and needs-owner jobs[^\n]*\n/m, '').replace('name: niyam\n', 'name: niyam\n# Our own note.\n'));
    assert.deepEqual(workflowPins(update.text), Array(8).fill('0.5.27'));
  });

  it('starts the needs-owner job when an issue is opened or reopened, where 0.6.3 started it on the approved label alone', () => {
    const older = (version: string, figma: boolean) =>
      workflow('main', version, figma)
        .replace("  # opened, reopened: an issue with no type gets the work model's.\n  issues:\n    types: [labeled, opened, reopened]\n", '  issues:\n    types: [labeled]\n')
        .replace("      (github.event_name == 'issues' && (github.event.action == 'opened' || github.event.action == 'reopened')) ||\n", '')
        .replace("  # An issue opened or reopened with no type gets the work model's.\n", '');
    for (const figma of [true, false]) {
      assert.deepEqual(workflowUpdate(older('0.6.3', figma), 'main', '0.6.4', figma), { kind: 'repin', text: workflow('main', '0.6.4', figma), from: '0.6.3', types: true });
    }
    assert.deepEqual(workflowUpdate(older('0.6.4', true), 'main', '0.6.4', true), { kind: 'repin', text: workflow('main', '0.6.4', true), types: true });
    // A workflow whose issue trigger the client changed keeps it, and only its pins move.
    const own = older('0.6.3', false).replace('    types: [labeled]\n', '    types: [labeled, closed]\n');
    assert.deepEqual(workflowUpdate(own, 'main', '0.6.4', false), { kind: 'repin', text: own.replaceAll('0.6.3', '0.6.4'), from: '0.6.3' });
  });

  it('starts the needs-owner job on a comment from an owner, member or collaborator alone, where 0.5.28 started it on anyone\'s', async () => {
    const older = (version: string, figma: boolean) => workflow('main', version, figma).replace(/^ {6}contains\(fromJSON[^\n]*\n/m, '');
    for (const figma of [true, false]) {
      assert.deepEqual(workflowUpdate(older('0.5.28', figma), 'main', '0.5.29', figma), { kind: 'repin', text: workflow('main', '0.5.29', figma), from: '0.5.28', authors: true });
    }
    assert.deepEqual(workflowUpdate(older('0.5.29', true), 'main', '0.5.29', true), { kind: 'repin', text: workflow('main', '0.5.29', true), authors: true });
    assert.deepEqual(workflowUpdate(workflow('main', '0.5.28', true), 'main', '0.5.29', true), { kind: 'repin', text: workflow('main', '0.5.29', true), from: '0.5.28' });
    const sys = fresh();
    sys.files.set(SETTINGS, JSON.stringify({ owner: 'example-owner', agent: AGENT, features: ['identity', 'work-rules'] }));
    sys.files.set(HOOKS, JSON.stringify(CLAUDE));
    sys.files.set(PRE_PUSH, PRE_PUSH_HOOK);
    sys.files.set(CLOUD, CLOUD_FILE).set(CALLER, CALLER_FILE);
    sys.files.set(WORKFLOW, older(packageVersion(), false));
    const { out } = await run(sys);
    assert.deepEqual(planned(out, 'Pull request'), ['workflow: needs-owner job only for owners, members and collaborators', 'auto-merge: when checks pass']);
    assert.ok(opened(sys)?.body.includes(`\n- \`${WORKFLOW_PATH}\`: in ${WORKFLOW_PATH}, start the needs-owner job only on a comment by the owner, a member or a collaborator, leaving the rest as it is\n`));
    assert.equal(repo(sys).get(WORKFLOW), workflow('main', packageVersion(), false));
  });


  it('replaces a three-job workflow whose weekly job or schedule is its own', () => {
    const weekly = threeJobs('0.5.26', true).replace("github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'", "github.event_name == 'schedule'");
    assert.equal(workflowUpdate(weekly, 'main', '0.5.27', true).kind, 'replace');
    const crons = threeJobs('0.5.26', true).replace("    - cron: '17 6 * * 1'\n", "    - cron: '17 6 * * 1'\n    - cron: '0 12 * * 5'\n");
    assert.equal(workflowUpdate(crons, 'main', '0.5.27', true).kind, 'replace');
  });

  it('asks to add the needs-owner job', async () => {
    const sys = fresh();
    sys.files.set(SETTINGS, JSON.stringify({ owner: 'example-owner', agent: AGENT, features: ['identity', 'work-rules'] }));
    sys.files.set(HOOKS, JSON.stringify(CLAUDE));
    sys.files.set(PRE_PUSH, PRE_PUSH_HOOK);
    sys.files.set(CLOUD, CLOUD_FILE).set(CALLER, CALLER_FILE);
    sys.files.set(WORKFLOW, threeJobs(packageVersion(), false));
    const { out } = await run(sys);
    assert.deepEqual(planned(out, 'Pull request'), ["workflow: needs-owner job, issue types for new issues, skips Mergify's queue-draft edits", 'auto-merge: when checks pass']);
    assert.ok(opened(sys)?.body.includes(`\n- \`${WORKFLOW_PATH}\`: in ${WORKFLOW_PATH}, ${ASKS_WHAT} and ${DRAFTS_WHAT}, leaving the rest as it is\n`));
    assert.equal(repo(sys).get(WORKFLOW), workflow('main', packageVersion(), false));
  });

});

describe('workflowUpdate, read to the letter', () => {
  const V = '0.5.5';
  /** This release's workflow at V, every feature on. */
  const NOW = full('main', V);
  const update = (before: string, branch = 'main', schedule?: string) => workflowUpdate(before, branch, V, true, schedule, undefined, true);
  const USES = '    uses: veda-hq/niyam/.github/workflows/checks.yml@v0.1.0';

  it('names the jobs that pass no FIGMA_LIBRARY, reading the jobs under jobs: alone, each to its last line', () => {
    const PUSH = 'on:\n  push:\n    # veda-hq/niyam/.github/workflows/checks.yml@v0.1.0 runs below\n';
    const LIBRARY = `${USES}\n    secrets:\n      FIGMA_LIBRARY: \${{ secrets.FIGMA_LIBRARY }}\n`;
    for (const [why, text, want] of [
      ['jobs: alone, not a line that ends with it', `# Calls the shared jobs:\n${PUSH}jobs:\n  niyam:\n${LIBRARY}`, []],
      ['jobs: with a space after it', `${PUSH}jobs: \n  niyam:\n${LIBRARY}`, []],
      ['jobs: alone, not a line that starts with it', `jobs: below\n${PUSH}jobs:\n  niyam:\n${LIBRARY}`, []],
      ['a job whose key has spaces after it', `jobs:\n  niyam:  \n${USES}\n`, ['niyam']],
      ['a job read past its first line and a blank one', `jobs:\n  niyam:\n    name: x\n\n${USES}\n`, ['niyam']],
      ['a last line with no newline', `jobs:\n  niyam:\n${USES}`, ['niyam']],
      ['a key indented under a key that is not a job', `jobs:\n  rules: # ours\n    steps:\n      - uses: veda-hq/niyam/.github/workflows/checks.yml@v1\n`, []],
      ['secrets inherited only by name', `jobs:\n  niyam:\n${USES}\n    secrets: inherited\n`, ['niyam']],
      ['secrets: inherit deeper than a job passes it', `jobs:\n  niyam:\n${USES}\n    with:\n      secrets: inherit\n`, ['niyam']],
      ['secrets: inherit spaced', `jobs:\n  niyam:\n${USES}\n    secrets:  inherit  \n`, []],
    ] as const) {
      assert.deepEqual(jobsWithoutLibrary(text), want, why);
    }
  });

  it("reads the pins of its own lines alone, and calls the product's shared workflow by a name no pattern reads as more", () => {
    assert.deepEqual(workflowPins('      niyam-ref:v0.1.0\n#  niyam-ref: v9.9.9\n'), ['0.1.0']);
    assert.match(PRODUCT, /^[\w-]+\/[\w-]+$/);
  });

  it('moves a header with no last dot, and reads only the first line as the header', () => {
    const plain = full('main', '0.5.2').replace(/\.\n/, '\n');
    const moved = update(plain);
    assert.ok(moved.kind === 'repin' && moved.text === NOW.replace(/\.\n/, '\n'), JSON.stringify(moved));
    const own = NOW.replace(/^.*\n/, '# Our own header.\n').replace('name: niyam\n', 'name: niyam\n  # Written by niyam onboard: the shared niyam checks at v0.5.2.\n');
    assert.deepEqual(update(own), { kind: 'same' });
  });

  it("moves the push branch only where it stands alone on its line in brackets, spaced or not, and after the trigger's own key", () => {
    assert.deepEqual(update(NOW.replace('branches: ["main"]', 'branches: ["main"] # the default'), 'trunk'), { kind: 'same' });
    const spaced = NOW.replace('branches: ["main"]', 'branches: [ main ]');
    assert.deepEqual(update(spaced, 'trunk'), { kind: 'repin', text: spaced.replace('[ main ]', '[ trunk ]'), branch: 'trunk' });
    const note = '# Pushes run on  push:\n    branches: ["main"]\n';
    const moved = update(`${note}${NOW}`, 'trunk');
    assert.ok(moved.kind === 'repin' && moved.text === `${note}${NOW.replace('branches: ["main"]', 'branches: ["trunk"]')}`, JSON.stringify(moved));
  });

  it('writes a branch bare only where YAML reads it as that word', () => {
    const bare = NOW.replace('branches: ["main"]', 'branches: [main]');
    for (const branch of ['nope', 'canon']) {
      const moved = update(bare, branch);
      assert.ok(moved.kind === 'repin' && moved.text.includes(`branches: [${branch}]`), branch);
    }
  });

  it('replaces a workflow whose jobs are not the template, by id or by pin count, at every age', () => {
    const own = (id: string) => `\n  ${id}:\n    runs-on: x\n`;
    const pin = '\n  own:\n    with:\n      niyam-ref: v0.5.5\n';
    for (const [why, before] of [
      ['the pull request job renamed', NOW.replace('\n  niyam:\n', '\n  rules:\n')],
      ['two jobs, the weekly one renamed', twoJobs(V, true).replace('\n  niyam-weekly:\n', '\n  niyam-later:\n')],
      ['two jobs and one of its own named as the merged job', `${twoJobs(V, true)}${own('niyam-merged')}`],
      ['two jobs and a fifth pin', `${twoJobs(V, true)}${pin}`],
      ['three jobs, the weekly one renamed', threeJobs(V, true).replace('\n  niyam-weekly:\n', '\n  niyam-later:\n')],
      ['three jobs and one of its own named as the needs-owner job', `${threeJobs(V, true)}${own('niyam-asks')}`],
      ['three jobs and a seventh pin', `${threeJobs(V, true)}${pin}`],
    ] as const) {
      assert.equal(update(before).kind, 'replace', why);
    }
  });

  it('adds the merged job alone to two jobs whose schedule the needs-owner job cannot be added to', () => {
    const before = twoJobs(V, true).replace("    - cron: '17 6 * * 1'\n", "    - cron: '17 6 * * 1'\n    - cron: '0 0 * * *'\n");
    const added = update(before);
    assert.ok(added.kind === 'repin' && added.merged === true, JSON.stringify(added));
    assert.ok(added.text.includes('\n  niyam-merged:\n') && !added.text.includes('\n  niyam-asks:\n'), added.text);
  });

  it('reads a cron only as the schedule onboard writes, trimmed, and leaves one it cannot read', () => {
    const two = NOW.replace("    - cron: '17 6 * * 1'\n", "    - cron: '17 6 * * 1'\n    - cron: '0 0 * * *'\n");
    assert.deepEqual(update(two, 'main', '5 4 * * 2'), { kind: 'same' });
    assert.deepEqual(update(NOW.replace("- cron: '17 6 * * 1'", "- cron: ' 17 6 * * 1 '")), { kind: 'same' });
  });

  it("leaves the needs-owner job's triggers alone where its label clause is not one a release wrote", () => {
    const edited = NOW.replace("  # opened, reopened: an issue with no type gets the work model's.\n  issues:\n    types: [labeled, opened, reopened]\n", '  issues:\n    types: [labeled]\n')
      .replace("      (github.event_name == 'issues' && (github.event.action == 'opened' || github.event.action == 'reopened')) ||\n", '')
      .replace("github.event.label.name == 'approved'", "github.event.label.name == 'ok'");
    assert.deepEqual(update(edited), { kind: 'same' });
  });

  it('reads a job key with spaces after it as that job', () => {
    assert.deepEqual(update(NOW.replace('  niyam-weekly:\n', '  niyam-weekly:  \n')), { kind: 'same' });
  });
});

describe("the shared Guard's caller (#470)", () => {
  const v = packageVersion();
  /** A repository onboard set up at `version`, every file as that release wrote it, the caller among them. */
  function onboarded(version: string, branch = 'main'): FakeSys {
    const sys = fresh();
    sys.files.set(SETTINGS, JSON.stringify({ owner: 'example-owner', agent: AGENT }));
    sys.files.set(HOOKS, JSON.stringify(CLAUDE));
    sys.files.set(WORKFLOW, full(branch, version));
    sys.files.set(PRE_PUSH, PRE_PUSH_HOOK);
    sys.files.set(CLOUD, CLOUD_FILE);
    sys.files.set(CALLER, guardCaller(branch, version));
    return sys;
  }

  it('moves its pin with the rest on a run again, changing its uses: line alone, then leaves it', async () => {
    const sys = onboarded('0.5.2');
    const { code, out, err } = await run(sys, []);
    assert.deepEqual(err, []);
    assert.equal(code, 0);
    assert.ok(planned(out, 'Pull request').includes(`guard caller: pin → v${v}`), out.join('\n'));
    assert.equal(repo(sys).get(CALLER), CALLER_FILE);
    assert.ok(opened(sys)?.body.includes(`\n- \`${GUARD_CALLER_PATH}\`: in ${GUARD_CALLER_PATH}, the shared Guard's caller, move its pin from v0.5.2 to v${v}\n`), opened(sys)?.body);
    const before = guardCaller('main', '0.5.2').split('\n');
    assert.deepEqual(
      CALLER_FILE.split('\n').filter((line, at) => line !== before[at]),
      [`    uses: veda-hq/niyam/.github/workflows/shared-guard.yml@v${v}`],
      "the Guard takes a change of the pin's version alone as onboard's",
    );
    merge(sys);
    sys.requests.length = 0;
    const again = await run(sys, []);
    assert.equal(again.code, 0);
    assert.ok(!planned(again.out, 'Pull request').some((item) => item.startsWith('guard caller')), again.out.join('\n'));
    assert.equal(sys.committed.has(GUARD_CALLER_PATH), false);
  });

  it("runs on pull requests to the repository's default branch, whatever its name, and follows it when it changes", async () => {
    const sys = fresh();
    sys.route('GET', REPO, { status: 200, json: repoJson(true, 'trunk') });
    assert.equal((await run(sys)).code, 0);
    assert.equal(repo(sys).get(CALLER), guardCaller('trunk', v));
    assert.match(repo(sys).get(CALLER) ?? '', /^ {4}branches: \["trunk"\]$/m);
    assert.ok(opened(sys)?.body.includes(`the shared Guard's caller: on each pull request to trunk it runs`), opened(sys)?.body);
    // A caller onboard wrote for main, in a repository whose default branch is now trunk.
    const moved = onboarded(v);
    moved.route('GET', REPO, { status: 200, json: repoJson(true, 'trunk') });
    const { out } = await run(moved, []);
    assert.ok(planned(out, 'Pull request').includes('guard caller: branch → trunk'), out.join('\n'));
    assert.equal(repo(moved).get(CALLER), guardCaller('trunk', v));
    assert.ok(opened(moved)?.body.includes(`\n- \`${GUARD_CALLER_PATH}\`: in ${GUARD_CALLER_PATH}, the shared Guard's caller, run it on pull requests to the default branch, trunk\n`), opened(moved)?.body);
  });

  it('writes again a caller of its own whose comments or layout were changed by hand', async () => {
    const sys = onboarded(v);
    sys.files.set(CALLER, `# Our own note.\n${CALLER_FILE}`);
    const { out } = await run(sys, []);
    assert.ok(planned(out, 'Pull request').includes('guard caller: written again'), out.join('\n'));
    assert.equal(repo(sys).get(CALLER), CALLER_FILE);
    assert.ok(opened(sys)?.body.includes(`\n- \`${GUARD_CALLER_PATH}\`: write ${GUARD_CALLER_PATH}, the shared Guard's caller, again as onboard writes it: on each pull request to main`), opened(sys)?.body);
  });

  it('writes again a caller of its own edited by hand, whatever it now holds', async () => {
    for (const edited of [
      CALLER_FILE.replace('    uses:', '    with:\n      ref: main\n    uses:'),
      CALLER_FILE.replace(`@v${v}`, `@${'a'.repeat(40)}`),
      CALLER_FILE.replace('on:\n', 'on:\n  pull_request:\n'),
    ]) {
      const sys = onboarded(v);
      sys.files.set(CALLER, edited);
      const { code, out } = await run(sys, []);
      assert.equal(code, 0, out.join('\n'));
      assert.ok(planned(out, 'Pull request').includes('guard caller: written again'), out.join('\n'));
      assert.equal(repo(sys).get(CALLER), CALLER_FILE);
    }
  });

  it('refuses a niyam-guard.yml onboard did not write, naming it, and changes nothing', async () => {
    // onboard's header is what makes a file onboard's; without it, even the caller's shape is the repository's own.
    const headerless = CALLER_FILE.split('\n').filter((line) => !line.startsWith('#')).join('\n');
    for (const own of [
      'on: pull_request\njobs:\n  guard:\n    runs-on: ubuntu-latest\n    steps:\n      - run: true\n',
      headerless.replace('    uses:', '    with:\n      ref: main\n    uses:'),
      headerless.replace(`@v${v}`, `@${'a'.repeat(40)}`),
    ]) {
      const sys = onboarded(v);
      sys.files.set(CALLER, own);
      // Without it, a run that went ahead would write the pre-push hook.
      sys.files.delete(PRE_PUSH);
      sys.answers = [];
      const { code, out, err } = await run(sys, []);
      assert.equal(code, 1);
      assert.deepEqual(err, [
        `onboard: ${GUARD_CALLER_PATH} is not the shared Guard's caller as onboard writes it, and onboard does not overwrite a workflow of the repository's own; nothing changed. Rename or delete it, then run onboard again.`,
      ]);
      assert.deepEqual(out, [], 'no plan');
      assert.deepEqual(sys.chosen, [], 'nothing asked');
      assert.ok(changedNothing(sys), 'nothing written, pushed or signed in to');
      assert.equal(sys.committed.size, 0);
    }
  });

  it('writes the caller whatever the features, work rules off or identity alone, and refuses one it did not write (#485)', async () => {
    for (const features of ['identity,pr-identity', 'identity']) {
      const sys = fresh();
      const { code, out } = await run(sys, ['example-owner', AGENT, '--features', features]);
      assert.equal(code, 0, out.join('\n'));
      assert.ok(planned(out, 'Pull request').includes(`guard caller: new, the shared Guard at v${packageVersion()}`), out.join('\n'));
      assert.equal(sys.committed.get(GUARD_CALLER_PATH), CALLER_FILE, features);
      const own = fresh();
      own.files.set(CALLER, 'on: push\n');
      const refused = await run(own, ['example-owner', AGENT, '--features', features]);
      assert.equal(refused.code, 1, features);
      assert.equal(repo(own).get(CALLER), 'on: push\n');
    }
  });

  it('asks a public repository, and only a public one, to allow pull_request_target for the caller', async () => {
    const step = `Once for example-org/example-app: allow pull_request_target for ${GUARD_CALLER_PATH} in a new policy under Settings → Actions → Policies, at https://github.com/example-org/example-app/settings/actions, since from 2026-12-02 GitHub blocks it in public repositories without one; skip it if done.`;
    const later = `\n- Allow pull_request_target for \`${GUARD_CALLER_PATH}\` in a new policy under example-org/example-app → Settings → Actions → Policies (https://github.com/example-org/example-app/settings/actions): from 2026-12-02 GitHub blocks the event in public repositories without one, and the shared Guard's caller runs on it alone.`;
    for (const shown of [{ private: false }, { visibility: 'public' }]) {
      const sys = fresh();
      sys.route('GET', REPO, { status: 200, json: { ...repoJson(), ...shown } });
      const { code, out } = await run(sys);
      assert.equal(code, 0);
      assert.ok(byHand(out).includes(step), byHand(out).join('\n'));
      assert.ok(opened(sys)?.body.includes(later), opened(sys)?.body);
      // Kept as it is on a run again, the step stays, skipped if done.
      merge(sys);
      const again = await run(sys, []);
      assert.ok(byHand(again.out).includes(step), byHand(again.out).join('\n'));
    }
    const closed = fresh();
    closed.route('GET', REPO, { status: 200, json: { ...repoJson(), private: true, visibility: 'private' } });
    const { out } = await run(closed);
    assert.ok(!out.join('\n').includes('pull_request_target'), out.join('\n'));
    assert.ok(!opened(closed)?.body.includes('pull_request_target'), opened(closed)?.body);
    // With work rules off the caller is still written, so the step is still asked for (#485).
    const off = fresh();
    off.route('GET', REPO, { status: 200, json: { ...repoJson(), private: false } });
    assert.ok(byHand((await run(off, ['example-owner', AGENT, '--features', 'identity,pr-identity'])).out).includes(step));
  });

  it('works out the caller once the agent can push, when the default branch is not known before', async () => {
    const sys = fresh();
    let added = false;
    sys.route('GET', REPO, () => (added ? { status: 200, json: repoJson(true, 'trunk') } : { status: 404, json: null }));
    sys.route('GET', '/user/repository_invitations?per_page=100&page=1', { status: 200, json: [] });
    sys.route('PUT', COLLABORATOR, () => {
      added = true;
      return { status: 204, json: null };
    });
    const { code, out } = await run(sys);
    assert.equal(code, 0);
    assert.ok(planned(out, 'Pull request').includes(`guard caller: new, the shared Guard at v${v}`), out.join('\n'));
    assert.equal(repo(sys).get(CALLER), guardCaller('trunk', v));
    const existing = onboarded(v);
    existing.route('GET', REPO, { status: 404, json: null });
    existing.route('GET', '/user/repository_invitations?per_page=100&page=1', { status: 200, json: [] });
    assert.ok(planned((await run(existing, ['example-owner', AGENT, '--dry-run'])).out, 'Pull request').includes('guard caller: write or update'));
  });

  it('moves the pin, the branch or both, and says each in the plan and the pull request', () => {
    const before = guardCaller('main', '0.5.2');
    assert.deepEqual(callerUpdate(undefined, undefined, 'main', v), { kind: 'write', text: CALLER_FILE });
    assert.deepEqual(callerUpdate(CALLER_FILE, { version: v, branch: 'main' }, 'main', v), { kind: 'same' });
    const both = callerUpdate(before, { version: '0.5.2', branch: 'main' }, 'trunk', v);
    assert.deepEqual(both, { kind: 'repin', text: guardCaller('trunk', v), from: '0.5.2', branch: 'trunk' });
    assert.equal(both.kind === 'repin' && callerDetail(both, v), `pin → v${v}, branch → trunk`);
    assert.equal(both.kind === 'repin' && callerWhat(both, v, 'trunk'), `in ${GUARD_CALLER_PATH}, the shared Guard's caller, move its pin from v0.5.2 to v${v} and run it on pull requests to the default branch, trunk`);
    // A text onboard cannot place is written as onboard writes it: onboard refuses one before it gets here.
    assert.deepEqual(callerUpdate('on: push\n', undefined, 'main', v), { kind: 'rewrite', text: CALLER_FILE });
  });

  it("adds the queue-draft skip to a caller from before it, saying so, and reads that caller as onboard's (#685)", async () => {
    assert.deepEqual(await callerAt(CALLER_0720), { version: '0.7.20', branch: 'main', older: true });
    assert.equal(guardCaller('main', '0.7.20', true), CALLER_0720, 'older is the caller 0.7.20 wrote');
    assert.deepEqual(await callerAt(guardCaller('trunk', v, true)), { version: v, branch: 'trunk', older: true });
    const pinned = callerUpdate(CALLER_0720, { version: '0.7.20', branch: 'main', older: true }, 'main', v);
    assert.deepEqual(pinned, { kind: 'repin', text: CALLER_FILE, from: '0.7.20', drafts: true });
    assert.equal(pinned.kind === 'repin' && callerDetail(pinned, v), `pin → v${v}, skips Mergify's queue-draft edits`);
    const at = guardCaller('main', v, true);
    const same = callerUpdate(at, { version: v, branch: 'main', older: true }, 'main', v);
    assert.deepEqual(same, { kind: 'repin', text: CALLER_FILE, drafts: true });
    assert.equal(same.kind === 'repin' && callerDetail(same, v), "skips Mergify's queue-draft edits");
    assert.equal(
      same.kind === 'repin' && callerWhat(same, v, 'main'),
      `in ${GUARD_CALLER_PATH}, the shared Guard's caller, skip an edit of Mergify's queue draft that changes no title or base, so the draft's last niyam-guard / judge at its head stands`,
    );

    const sys = onboarded(v);
    sys.files.set(WORKFLOW, beforeDrafts(full('main', '0.7.20')));
    sys.files.set(CALLER, CALLER_0720);
    const { code, out } = await run(sys, []);
    assert.equal(code, 0, out.join('\n'));
    const plan = planned(out, 'Pull request');
    assert.ok(plan.includes(`workflow: pins → v${v}, skips Mergify's queue-draft edits`), plan.join('\n'));
    assert.ok(plan.includes(`guard caller: pin → v${v}, skips Mergify's queue-draft edits`), plan.join('\n'));
    assert.equal(repo(sys).get(WORKFLOW), full('main', v));
    assert.equal(repo(sys).get(CALLER), CALLER_FILE);
    const body = opened(sys)?.body ?? '';
    assert.ok(body.includes(`\n- \`${WORKFLOW_PATH}\`: in ${WORKFLOW_PATH}, move the version pins from v0.7.20 to v${v} and ${DRAFTS_WHAT}, leaving the rest as it is\n`), body);
    assert.ok(
      body.includes(`\n- \`${GUARD_CALLER_PATH}\`: in ${GUARD_CALLER_PATH}, the shared Guard's caller, move its pin from v0.7.20 to v${v} and skip an edit of Mergify's queue draft that changes no title or base, so the draft's last niyam-guard / judge at its head stands\n`),
      body,
    );
  });

  it("writes a branch YAML would read as another value quoted, and the caller's header names no release", async () => {
    for (const branch of ['main', 'release/1.0', 'true', '1.0', "it's"]) {
      const text = guardCaller(branch, v);
      assert.deepEqual(await callerAt(text), { version: v, branch }, branch);
    }
    assert.ok(!/\d+\.\d+\.\d+/.test(CALLER_FILE.split('\non:')[0] ?? ''), 'a pin move changes no header line');
  });

  it("is what the Guard's isCaller takes as the caller: pull_request_target alone, one job reporting niyam-guard / judge, only a release's uses:", () => {
    // As scripts/guard.mjs reads a workflow (workflowOf, isCaller), here so that no guard file changes.
    for (const branch of ['main', 'trunk']) {
      const doc = parse(guardCaller(branch, v)) as { on: Record<string, unknown>; permissions: unknown; jobs: Record<string, Record<string, unknown>> };
      assert.deepEqual(Object.keys(doc.on), ['pull_request_target']);
      assert.deepEqual(doc.on.pull_request_target, { types: ['opened', 'edited', 'synchronize', 'reopened'], branches: [branch] });
      const read = { contents: 'read', 'pull-requests': 'read', issues: 'read' };
      assert.deepEqual(doc.permissions, read);
      const skip =
        "${{ !(github.event.action == 'edited' && !github.event.changes.title && !github.event.changes.base && github.event.pull_request.user.login == 'mergify[bot]' && github.event.pull_request.user.type == 'Bot' && " +
        "startsWith(github.event.pull_request.head.ref, 'mergify/merge-queue/') && github.event.pull_request.head.repo.full_name == github.repository && !contains(github.event.pull_request.title, ' pull requests ahead')) }}";
      assert.deepEqual(doc.jobs, { 'niyam-guard': { name: 'niyam-guard', if: skip, permissions: read, uses: `veda-hq/niyam/.github/workflows/shared-guard.yml@v${v}` } });
      assert.ok(guardCaller(branch, v).includes("    name: niyam-guard\n    # Not on an edit of Mergify's queue draft that changes no title or base: its head's runs stand (veda-hq/niyam#685).\n    if: >-\n      ${{ !(github.event.action"));
      assert.match(doc.jobs['niyam-guard']?.uses as string, /^veda-hq\/niyam\/\.github\/workflows\/shared-guard\.yml@(v\d+\.\d+\.\d+|[0-9a-f]{40})$/);
      assert.equal(`${doc.jobs['niyam-guard']?.name as string} / judge`, CALLER_CHECK);
    }
  });
});

describe('onboard never moves the pin backwards', () => {
  const newer = '99.0.0';
  const encoded = (text: string) => ({ status: 200, json: { content: Buffer.from(text).toString('base64') } });

  it('refuses when the checkout already pins a newer release', async () => {
    const sys = fresh();
    sys.files.set(WORKFLOW, workflow('main', newer, false));
    const { code, err } = await run(sys);
    assert.equal(code, 1);
    assert.match(err.join('\n'), new RegExp(`pins niyam v${newer}.*this is v${packageVersion()}`));
    assert.match(err.join('\n'), /first: niyam upgrade$/m, 'says how to update');
    assert.equal(opened(sys), undefined, 'opens no pull request');
    assert.equal(signIns(sys), 0, 'asks the owner for nothing');
  });

  it("refuses when the default branch on GitHub pins a newer release than a checkout that is behind", async () => {
    const sys = fresh();
    sys.route('GET', `${REPO}/contents/${WORKFLOW_PATH}?ref=main`, encoded(workflow('main', newer, false)));
    const { code, err } = await run(sys);
    assert.equal(code, 1);
    assert.match(err.join('\n'), new RegExp(`v${newer} \\(\\S+ on main\\)`));
    assert.equal(opened(sys), undefined);
  });

  const OPEN_PULLS = `${REPO}/pulls?state=open&head=example-org:niyam/onboard`;

  for (const [branch, path] of [['niyam/onboard', WORKFLOW_PATH]] as const) {
    it(`refuses to overwrite an onboard pull request that a newer release opened, from ${branch} with ${path}`, async () => {
      const sys = fresh();
      sys.route('GET', `${REPO}/pulls?state=open&head=example-org:${branch}`, { status: 200, json: [{ number: 7 }] });
      sys.route('GET', `${REPO}/contents/${path}?ref=${encodeURIComponent(branch)}`, encoded(workflow('main', newer, false)));
      const { code, err } = await run(sys);
      assert.equal(code, 1);
      assert.match(err.join('\n'), new RegExp(`v${newer} \\(${path.replaceAll('.', '\\.')} on ${branch}\\)`));
      assert.equal(opened(sys), undefined);
      assert.equal(sys.calls.some((call) => call.command === 'git' && call.args.includes('push')), false, 'pushes nothing');
    });
  }

  it("refuses when the shared Guard's caller pins a newer release, here or on GitHub, edited by hand or not", async () => {
    const here = fresh();
    here.files.set(CALLER, guardCaller('main', newer).replace('    uses:', '    with:\n      ref: x\n    uses:'));
    const fromHere = await run(here);
    assert.equal(fromHere.code, 1);
    assert.match(fromHere.err.join('\n'), new RegExp(`v${newer} \\(${GUARD_CALLER_PATH.replaceAll('.', '\\.')} in this checkout\\)`));

    const remote = fresh();
    remote.route('GET', `${REPO}/contents/${GUARD_CALLER_PATH}?ref=main`, encoded(guardCaller('main', newer)));
    const fromGitHub = await run(remote);
    assert.equal(fromGitHub.code, 1);
    assert.match(fromGitHub.err.join('\n'), new RegExp(`v${newer} \\(${GUARD_CALLER_PATH.replaceAll('.', '\\.')} on main\\)`));
    assert.equal(opened(remote), undefined);

    const unanswered = fresh();
    unanswered.route('GET', `${REPO}/contents/${GUARD_CALLER_PATH}?ref=main`, { status: 502, json: null });
    const silent = await run(unanswered);
    assert.equal(silent.code, 1);
    assert.match(silent.err.join('\n'), /niyam-guard\.yml on main \(HTTP 502\)/);
  });

  it("pushBranch reads niyam.yml's one push branch, and none from a file that is not YAML", async () => {
    assert.equal(await pushBranch('on:\n  push:\n    branches: [trunk]\n'), 'trunk');
    assert.equal(await pushBranch('on:\n  push:\n    branches: [a, b]\n'), undefined);
    assert.equal(await pushBranch('on: ['), undefined);
  });

  it('callerPins reads every release of the shared Guard a file calls, quoted or commented', () => {
    assert.deepEqual(callerPins(guardCaller('main', '1.2.3')), ['1.2.3']);
    assert.deepEqual(callerPins("    uses: 'veda-hq/niyam/.github/workflows/shared-guard.yml@v1.0.0' # pinned\n  b:\n    uses: veda-hq/niyam/.github/workflows/shared-guard.yml@v2.0.0\n"), ['1.0.0', '2.0.0']);
    assert.deepEqual(callerPins('    uses: veda-hq/niyam/.github/workflows/checks.yml@v9.0.0\n    uses: veda-hq/niyam/.github/workflows/shared-guard.yml@main\n'), []);
  });

  it('leaves alone an onboard branch no open pull request uses', async () => {
    const sys = fresh();
    sys.route('GET', `${REPO}/contents/${WORKFLOW_PATH}?ref=niyam%2Fonboard`, encoded(workflow('main', newer, false)));
    const { code } = await run(sys);
    assert.equal(code, 0, 'a closed pull request\'s branch is pushed over');
  });


  it('refuses when GitHub does not say what the repository pins', async () => {
    for (const [path, answer] of [
      [`${REPO}/contents/${WORKFLOW_PATH}?ref=main`, { status: 502, json: null }],
      [OPEN_PULLS, { status: 403, json: { message: 'Forbidden' } }],
    ] as const) {
      const sys = fresh();
      sys.route('GET', path, answer);
      const { code, err } = await run(sys);
      assert.equal(code, 1, path);
      assert.match(err.join('\n'), /HTTP (502|403).*run it again/, path);
      assert.equal(opened(sys), undefined, path);
    }
  });

  it('reads the default branch when the agent can only read the repository', async () => {
    const sys = fresh();
    sys.route('GET', REPO, { status: 200, json: { ...repoJson(), permissions: { push: false } } });
    sys.route('GET', `${REPO}/contents/${WORKFLOW_PATH}?ref=main`, encoded(workflow('main', newer, false)));
    const { code, err } = await run(sys);
    assert.equal(code, 1);
    assert.match(err.join('\n'), /on main\)/);
  });

  it('refuses a newer checkout before asking the owner to sign in', async () => {
    const sys = fresh();
    sys.files.set(WORKFLOW, workflow('main', newer, false));
    const { io, err } = capture();
    assert.equal(await onboard(sys, io, []), 1);
    assert.match(err.join('\n'), /never moves the pin back/);
    assert.equal(signIns(sys), 0);
  });

  it('refuses when the cloud setup file installs a newer release; the files before P-56 count for nothing (P-57)', async () => {
    for (const [path, text] of [[CLOUD, cloudRepoScript(newer, RELEASE_SHA256)]] as const) {
      const sys = fresh();
      sys.files.set(path, text);
      const { code, err } = await run(sys);
      assert.equal(code, 1, path);
      assert.ok(err[0]?.includes(`(${path.slice(ROOT.length + 1)} in this checkout)`), err[0]);
      assert.equal(opened(sys), undefined);
    }
  });

  it('names the newest of the pins it finds, wherever it stands among them, and where', async () => {
    const here = fresh();
    here.files.set(WORKFLOW, workflow('main', newer, false));
    here.files.set(CALLER, guardCaller('main', '98.0.0'));
    assert.match((await run(here)).err[0] ?? '', new RegExp(`v${newer} \\(${WORKFLOW_PATH.replaceAll('.', '\\.')} in this checkout\\)`));
    const remote = fresh();
    remote.route('GET', `${REPO}/contents/${WORKFLOW_PATH}?ref=main`, encoded(workflow('main', newer, false)));
    remote.route('GET', `${REPO}/contents/${GUARD_CALLER_PATH}?ref=main`, encoded(guardCaller('main', '98.0.0')));
    assert.match((await run(remote)).err[0] ?? '', new RegExp(`v${newer} \\(${WORKFLOW_PATH.replaceAll('.', '\\.')} on main\\)`));
  });

  it("says GitHub gave no answer, or not a list, about onboard's open pull request", async () => {
    for (const [answer, said] of [
      ['throws', 'no answer'],
      [{ status: 500, json: [] }, 'HTTP 500'],
      [{ status: 200, json: {} }, 'HTTP 200'],
    ] as const) {
      const sys = fresh();
      if (answer === 'throws') {
        const http = sys.http.bind(sys);
        sys.http = (url, options) => (url.endsWith(OPEN_PULLS) ? Promise.reject(new Error('socket hang up')) : http(url, options));
      } else {
        sys.route('GET', OPEN_PULLS, answer);
      }
      const { code, err } = await run(sys);
      assert.deepEqual({ code, err }, { code: 1, err: [`onboard: GitHub did not say whether an onboard pull request is open (${said}); run it again`] });
    }
  });

  it('goes ahead when every pin is this release or older', async () => {
    const sys = fresh();
    sys.files.set(WORKFLOW, workflow('main', '0.0.1', false));
    sys.route('GET', `${REPO}/contents/${WORKFLOW_PATH}?ref=main`, encoded(workflow('main', '0.0.1', false)));
    const { code } = await run(sys);
    assert.equal(code, 0);
  });
});

describe("the agent's cloud signing key (#417)", () => {
  const KEYS = '/user/ssh_signing_keys';
  /** What onboard says to run where it makes no key itself. */
  const KEY_BY_HAND =
    "Once for ExampleBot: in your own terminal on your Mac, run niyam cloud-key ExampleBot, paste the line it puts on the clipboard into each Claude cloud environment's variables, then run niyam onboard here again, which pins the key in .github/niyam.json.";
  const NO_KEY = 'onboard: ExampleBot has no cloud signing key yet; everything before it is done, and no environment holds the key the pull request pins';
  /** The cloud signing keys the settings onboard leaves pin, by agent. */
  const pins = (sys: FakeSys): unknown => (JSON.parse(repo(sys).get(SETTINGS) ?? '{}') as { cloudSigningKeys?: unknown }).cloudSigningKeys;
  const PIN = "pin ExampleBot's cloud signing key, which cloud sessions check theirs against";
  const PASTE =
    "Now: NIYAM_SIGNING_KEY=… is on the clipboard. Paste it as one line into each Claude cloud environment's variables: https://claude.ai/code → the environment's settings. A new session there makes ExampleBot's commits its own; its first niyam line says so.";

  /** A fresh run for an agent whose signing keys are the Mac's alone; GitHub registers the new one as id 99, and the clipboard takes what it is given. */
  function keyless(): FakeSys & { clipboard: string[] } {
    const sys = Object.assign(fresh(), { clipboard: [] as string[] });
    let added: string | undefined;
    sys.route('GET', `${KEYS}?per_page=100`, { status: 200, json: [{ id: 1, title: 'niyam signing', key: 'ssh-ed25519 AAAAkey', created_at: '2026-10-01T00:00:00Z' }] });
    sys.route('GET', KEYS, () => ({ status: 200, json: [{ key: 'ssh-ed25519 AAAAmac' }, ...(added ? [{ key: added }] : [])] }));
    sys.handlers.push((method, url, body) => {
      if (method !== 'POST' || url !== `https://api.github.com${KEYS}`) return undefined;
      added = (body as { key: string }).key;
      return { status: 201, json: { id: 99, title: 'niyam cloud signing', key: added } };
    });
    sys.route('DELETE', `${KEYS}/99`, { status: 204, json: null });
    sys.execOverride = ({ command, input }) => {
      if (command !== '/usr/bin/pbcopy') return undefined;
      sys.clipboard.push(input ?? '');
      return { code: 0, stdout: '', stderr: '' };
    };
    return sys;
  }
  const keyMade = (sys: FakeSys): boolean => sys.requests.some((request) => request.method === 'POST' && request.url.endsWith(KEYS));

  it('plans one for an agent with none, and makes it last, after the pull request, with the one yes', async () => {
    const sys = keyless();
    const writes = diskWrites(sys);
    // The same run for an agent that has its key, which makes none: the key step must add no write to disk.
    const keyed = fresh();
    const keyedWrites = diskWrites(keyed);
    await run(keyed);
    const { code, out, err } = await run(sys);
    assert.deepEqual(err, []);
    assert.equal(code, 0);
    assert.deepEqual(planned(out, 'Claude cloud'), ["claude.ai's GitHub: as ExampleBot", 'signing key: for ExampleBot, on the clipboard']);
    assert.deepEqual(sys.chosen, ['Go ahead?'], 'one question');
    assert.deepEqual(sys.spun.slice(-2), ['pull request', 'cloud signing key for ExampleBot']);
    const urls = sys.requests.filter((request) => request.method === 'POST').map((request) => request.url);
    assert.ok(urls.indexOf(`https://api.github.com${REPO}/pulls`) < urls.indexOf(`https://api.github.com${KEYS}`), 'the pull request opens first');
    const onClipboard = keyOnClipboard(sys.clipboard[0]);
    assert.ok(!('problem' in onClipboard), JSON.stringify(onClipboard));
    assert.equal(sys.clipboard.length, 1);
    const posted = sys.requests.find((request) => request.method === 'POST' && request.url.endsWith(KEYS));
    assert.deepEqual(posted?.body, { title: 'niyam cloud signing', key: `${onClipboard.publicLine} ExampleBot cloud signing` });
    assert.equal(posted?.token, TOKEN, "as the agent, with its stored token");
    assert.ok(!out.join('\n').includes((sys.clipboard[0] ?? '').slice(20, 60)) && !out.join('\n').includes(onClipboard.text.split('\n')[1] ?? ''), 'the key is never printed');
    assert.ok(!sys.calls.some((call) => call.command === 'ssh-keygen' && call.args.includes('ExampleBot cloud signing')), 'made in memory, with no ssh-keygen (#437)');
    assert.ok(!writes.some((write) => write.data?.includes(onClipboard.text.split('\n')[1] ?? '')), 'the key is written to no file, even for a moment');
    assert.ok(keyedWrites.length > 0, 'the record sees the writes the other steps make');
    assert.equal(writes.length, keyedWrites.length, 'the key step writes nothing to disk and makes no folder');
    assert.ok(out.includes('◇  cloud signing key for ExampleBot'));
    assert.equal(byHand(out)[0], PASTE, 'the paste comes first, while the clipboard holds it');
    assert.ok(!byHand(out).includes(KEY_BY_HAND));
    // Made at the plan, so the pull request pins the very key registered last (#447); the Mac's own key is no cloud key.
    assert.equal(planned(out, 'Pull request')[0], `niyam.json: new, ${FEATURES.length} features on, ${PIN}`);
    assert.deepEqual(pins(sys), { ExampleBot: [onClipboard.publicLine] });
  });

  it('pins the cloud signing keys GitHub lists, and changes nothing once they are pinned (#447)', async () => {
    const sys = fresh();
    sys.route('GET', `${KEYS}?per_page=100`, {
      status: 200,
      json: [
        { id: 1, title: 'niyam signing', key: 'ssh-ed25519 AAAAkey ExampleBot', created_at: '2026-10-01T00:00:00Z' },
        { id: 3, title: 'niyam cloud signing', key: 'ssh-ed25519 AAAAcloud ExampleBot cloud signing', created_at: '2026-11-16T00:00:00Z' },
        { id: 4, title: 'niyam cloud signing', key: 'ssh-ed25519 AAAAnewer ExampleBot cloud signing', created_at: '2026-11-17T00:00:00Z' },
      ],
    });
    const first = await run(sys);
    assert.equal(first.code, 0, first.err.join('\n'));
    assert.equal(planned(first.out, 'Pull request')[0], `niyam.json: new, ${FEATURES.length} features on, pin ExampleBot's cloud signing keys, which cloud sessions check theirs against`);
    assert.deepEqual(pins(sys), { ExampleBot: ['ssh-ed25519 AAAAcloud', 'ssh-ed25519 AAAAnewer'] }, 'the cloud keys alone, without their comments');
    assert.ok(!keyMade(sys));
    merge(sys);
    const again = await run(sys);
    assert.equal(again.code, 0, again.err.join('\n'));
    assert.ok(!planned(again.out, 'Pull request').some((item) => item.startsWith('niyam.json')), again.out.join('\n'));
  });

  it("re-pins when the keys change, drops the agent's pin once GitHub lists none, and keeps other agents' pins (#447)", async () => {
    const sys = fresh();
    sys.route('GET', `${KEYS}?per_page=100`, { status: 200, json: [{ id: 4, title: 'niyam cloud signing', key: 'ssh-ed25519 AAAAnewer', created_at: '2026-11-17T00:00:00Z' }] });
    assert.equal((await run(sys)).code, 0);
    merge(sys);
    const settings = JSON.parse(sys.files.get(SETTINGS) as string) as Record<string, unknown>;
    // As the owner left it: the agent's login in another case, an old key since deleted from GitHub, and another agent's.
    sys.files.set(SETTINGS, `${JSON.stringify({ ...settings, cloudSigningKeys: { OtherBot: ['ssh-ed25519 AAAAother'], examplebot: ['ssh-ed25519 AAAAgone'] } }, null, 2)}\n`);
    const changed = await run(sys);
    assert.equal(changed.code, 0, changed.err.join('\n'));
    assert.ok(planned(changed.out, 'Pull request').includes(`niyam.json: ${PIN}`), changed.out.join('\n'));
    assert.deepEqual(pins(sys), { OtherBot: ['ssh-ed25519 AAAAother'], examplebot: ['ssh-ed25519 AAAAnewer'] });
    merge(sys);
    sys.route('GET', `${KEYS}?per_page=100`, { status: 200, json: [{ id: 1, title: 'niyam signing', key: 'ssh-ed25519 AAAAkey', created_at: '2026-10-01T00:00:00Z' }] });
    sys.env = { ...sys.env, CLAUDECODE: '1' };
    const gone = await run(sys);
    assert.equal(gone.code, 0, gone.err.join('\n'));
    assert.ok(planned(gone.out, 'Pull request').includes("niyam.json: drop ExampleBot's cloud signing keys, which GitHub no longer lists"), gone.out.join('\n'));
    assert.deepEqual(pins(sys), { OtherBot: ['ssh-ed25519 AAAAother'] });
    assert.ok(!keyMade(sys), 'where cloud-key would refuse, none is made, so none is pinned');
  });

  it('pins no cloud signing key GitHub lists with no key text', async () => {
    const sys = fresh();
    sys.route('GET', `${KEYS}?per_page=100`, {
      status: 200,
      json: [
        { id: 3, title: 'niyam cloud signing', key: 'ssh-ed25519 AAAAcloud', created_at: '2026-11-16T00:00:00Z' },
        { id: 5, title: 'niyam cloud signing', key: 7, created_at: '2026-11-17T00:00:00Z' },
      ],
    });
    assert.equal((await run(sys)).code, 0);
    assert.deepEqual(pins(sys), { ExampleBot: ['ssh-ed25519 AAAAcloud'] });
  });

  it('warns that it did not check the keys when asking GitHub for them fails, and makes none', async () => {
    const sys = keyless();
    const http = sys.http.bind(sys);
    sys.http = (url, options): Promise<HttpResult> => (url.endsWith(`${KEYS}?per_page=100`) ? Promise.reject(new Error('fetch failed')) : http(url, options));
    const { code, out } = await run(sys);
    assert.equal(code, 0);
    assert.ok(out.includes('│  ! cloud signing key not checked (fetch failed); niyam cloud-key ExampleBot makes one'), out.join('\n'));
    assert.ok(!keyMade(sys));
  });

  it('leaves the pin as it is when GitHub does not list the keys (#447)', async () => {
    const sys = fresh();
    sys.files.set(SETTINGS, `${JSON.stringify({ owner: 'example-owner', agent: AGENT, cloudSigningKeys: { ExampleBot: ['ssh-ed25519 AAAAcloud'] } }, null, 2)}\n`);
    sys.route('GET', `${KEYS}?per_page=100`, { status: 403, json: null });
    const { code, out } = await run(sys);
    assert.equal(code, 0);
    assert.ok(!planned(out, 'Pull request').some((item) => /cloud signing/.test(item)), out.join('\n'));
    assert.deepEqual(pins(sys), { ExampleBot: ['ssh-ed25519 AAAAcloud'] });
  });

  it('makes none, and says nothing about it but the pin, for an agent that has one, as on a second repo', async () => {
    const sys = fresh();
    sys.route('GET', `${KEYS}?per_page=100`, {
      status: 200,
      json: [
        { id: 1, title: 'niyam signing', key: 'ssh-ed25519 AAAAkey', created_at: '2026-10-01T00:00:00Z' },
        { id: 3, title: 'niyam cloud signing', key: 'ssh-ed25519 AAAAcloud', created_at: '2026-11-16T00:00:00Z' },
      ],
    });
    const { code, out } = await run(sys);
    assert.equal(code, 0);
    assert.ok(!keyMade(sys));
    assert.ok(!out.some((line) => /signing key|cloud-key|NIYAM_SIGNING_KEY/.test(line) && !line.includes(PIN)), out.join('\n'));
    assert.deepEqual(pins(sys), { ExampleBot: ['ssh-ed25519 AAAAcloud'] });
    assert.ok(sys.requests.some((request) => request.url === `https://api.github.com${KEYS}?per_page=100` && request.token === TOKEN), "decided by the agent's own list");
  });

  it('plans none where cloud-key would refuse, naming it under By hand instead', async () => {
    for (const env of [{ CLAUDECODE: '1' }, { CLAUDE_CODE_REMOTE: 'true' }]) {
      const sys = keyless();
      sys.env = { ...sys.env, ...env };
      const { code, out } = await run(sys);
      assert.equal(code, 0, JSON.stringify(env));
      assert.deepEqual(planned(out, 'Claude cloud'), ["claude.ai's GitHub: as ExampleBot"]);
      assert.ok(!keyMade(sys));
      assert.equal(byHand(out).at(-1), KEY_BY_HAND);
    }
    const dry = keyless();
    const { code, out } = await run(dry, ['example-owner', AGENT, '--dry-run']);
    assert.equal(code, 0);
    assert.deepEqual(planned(out, 'Claude cloud'), ["claude.ai's GitHub: as ExampleBot"]);
    assert.ok(!keyMade(dry));
    assert.ok(changedNothing(dry));
  });

  it('refuses a Mac with no token store before any plan, as before, where cloud-key would refuse too', async () => {
    const sys = keyless();
    sys.platform = 'linux';
    const { code, err } = await run(sys);
    assert.equal(code, 1);
    assert.match(err[0] ?? '', /^onboard: this Mac is not set up for ExampleBot \(no token stored for ExampleBot\)/);
    assert.ok(!keyMade(sys));
  });

  it('only warns when the key fails, leaving the pull request and everything before it in place', async () => {
    const full = keyless();
    full.execOverride = ({ command }) => (command === '/usr/bin/pbcopy' ? { code: 1, stdout: '', stderr: 'pbcopy: no pasteboard' } : undefined);
    const { code, out, err } = await run(full);
    assert.equal(code, 0);
    assert.ok(opened(full), 'the pull request is open');
    assert.ok(out.includes('■  cloud signing key for ExampleBot'), out.join('\n'));
    assert.ok(out.includes('│  ✗ the clipboard did not take the key (pbcopy: no pasteboard), so the key was deleted from GitHub again; nothing is on the clipboard'));
    assert.ok(full.requests.some((request) => request.method === 'DELETE' && request.url.endsWith(`${KEYS}/99`)));
    assert.deepEqual(err, [NO_KEY]);
    assert.ok(out.includes(`└  ${PULL_URL}  merges itself when checks pass`));
    assert.equal(byHand(out).at(-1), KEY_BY_HAND);
    assert.ok(!byHand(out).includes(PASTE));
    // A step that throws is the same failure.
    const offline = keyless();
    const http = offline.http.bind(offline);
    offline.http = (url, options): Promise<HttpResult> => (options?.method === 'POST' && url.endsWith(KEYS) ? Promise.reject(new Error('fetch failed')) : http(url, options));
    const thrown = await run(offline);
    assert.equal(thrown.code, 0);
    assert.ok(opened(offline));
    assert.deepEqual(thrown.err, ['onboard: fetch failed', NO_KEY]);
    assert.equal(byHand(thrown.out).at(-1), KEY_BY_HAND);
    // A Ctrl-C there deletes the key again and ends the run as a Ctrl-C does, the pull request still open.
    const stopped = keyless();
    const fetch = stopped.http.bind(stopped);
    stopped.http = (url, options): Promise<HttpResult> => {
      if (options?.method === 'POST' && url.endsWith(KEYS)) stopped.interrupt();
      return fetch(url, options);
    };
    const halted = await run(stopped);
    assert.equal(halted.code, 130);
    assert.ok(opened(stopped));
    assert.ok(stopped.requests.some((request) => request.method === 'DELETE' && request.url.endsWith(`${KEYS}/99`)));
    assert.equal(byHand(halted.out).at(-1), KEY_BY_HAND);
  });

  it('warns in the plan and makes none when GitHub does not list the keys, which could leave a second one', async () => {
    const sys = keyless();
    sys.route('GET', `${KEYS}?per_page=100`, { status: 403, json: null });
    const { code, out } = await run(sys);
    assert.equal(code, 0);
    assert.ok(out.includes("│  ! cloud signing key not checked (GitHub answered HTTP 403 when asked for ExampleBot's signing keys); niyam cloud-key ExampleBot makes one"), out.join('\n'));
    assert.ok(!keyMade(sys));
  });
});

describe('onboard on a Mac with no requests left that need no token (#546)', () => {
  /**
   * The Mac veda-hq/veda's onboard ran on, 2026-11-22: every read of GitHub's
   * API with no token is refused for the rate limit, 0 left of 60, until
   * 08:55:21Z. A read with a token is answered as before.
   */
  function limited(sys: FakeSys): FakeSys & { refused: string[] } {
    const http = sys.http.bind(sys);
    const refused: string[] = [];
    sys.http = (url, options = {}) => {
      if (options.token || !url.startsWith('https://api.github.com/')) return http(url, options);
      refused.push(url);
      return Promise.resolve({ status: 403, json: { message: 'API rate limit exceeded' }, headers: { 'x-ratelimit-limit': '60', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1795337721' } });
    };
    return Object.assign(sys, { refused });
  }

  it("gets past the owner-type check and through the run, asking with the agent's token", async () => {
    const sys = limited(fresh());
    const { code, err } = await run(sys);
    assert.deepEqual(err, []);
    assert.equal(code, 0);
    const owners = sys.requests.filter((request) => request.url.endsWith('/users/example-org'));
    assert.deepEqual(owners.map((request) => request.token), [TOKEN]);
    assert.ok(sys.requests.some((request) => request.url.includes('/compare/refs/tags/') && request.token === TOKEN), 'the release tag is checked with the token');
    assert.ok(opened(sys), 'the pull request opened');
    assert.deepEqual(sys.refused, [], 'no read went out with no token');
  });

  it('does the same with settings and no agent named, using the agent the settings name', async () => {
    const sys = limited(fresh());
    sys.files.set(SETTINGS, `${JSON.stringify({ owner: 'example-owner', agent: AGENT, features: [...FEATURES] }, null, 2)}\n`);
    const { code, err } = await run(sys, []);
    assert.deepEqual(err, []);
    assert.equal(code, 0);
    const users = sys.requests.filter((request) => request.url.includes('/users/'));
    assert.ok(users.some((request) => request.url.endsWith('/users/example-org')), 'the owner type is asked');
    assert.ok(users.every((request) => request.token === TOKEN), JSON.stringify(users));
    assert.deepEqual(sys.refused, [], 'no read went out with no token');
  });

  it('with no settings and no agent named, asks with the token of the agent set up here', async () => {
    const sys = limited(fresh());
    sys.files.set(`${sys.home}/.config/niyam/${AGENT.toLowerCase()}/session.sh`, sessionScript(AGENT, 42, pathsFor(sys.home, AGENT)));
    sys.files.set(`${sys.home}/.config/niyam/locked/gh/hosts.yml`, '');
    sys.answers = ['', '', 'y'];
    const { code, err } = await run(sys, []);
    assert.deepEqual(err, []);
    assert.equal(code, 0);
    assert.deepEqual(sys.requests.filter((request) => request.url.endsWith('/users/example-org')).map((request) => request.token), [TOKEN]);
    assert.deepEqual(sys.refused, [], 'no read went out with no token');
  });

  it('finds the agent named in another case by the spelling machine set it up under', async () => {
    const sys = limited(fresh());
    sys.files.set(`${sys.home}/.config/niyam/${AGENT.toLowerCase()}/session.sh`, sessionScript(AGENT, 42, pathsFor(sys.home, AGENT)));
    const { code, err } = await run(sys, ['example-owner', AGENT.toLowerCase()]);
    assert.deepEqual(err, []);
    assert.equal(code, 0);
    assert.deepEqual(sys.refused, [], 'no read went out with no token');
  });

  it('reads no agent from settings it cannot read, leaving their refusal for later', async () => {
    const sys = limited(fresh());
    sys.files.set(SETTINGS, '{');
    const { code, err } = await run(sys, []);
    assert.equal(code, 1);
    assert.match(err[0] ?? '', /^onboard: GitHub could not say whether the v[\d.]+ tag is on main: GitHub's limit for requests with no token/);
  });

  it("asks as the agent once it is known, not as another agent the settings list first", async () => {
    const sys = fresh();
    sys.files.set(SETTINGS, JSON.stringify({ owner: 'example-owner', agent: ['OtherBot', AGENT], features: [...FEATURES] }));
    sys.files.set(pathsFor(HOME, AGENT).session, sessionScript(AGENT, AGENT_ID, pathsFor(HOME, AGENT)));
    sys.setToken('OtherBot', 'gho_other');
    const { code, err } = await run(sys, []);
    assert.equal(code, 0, err.join('\n'));
    assert.deepEqual(sys.requests.filter((request) => request.url.endsWith('/users/example-org')).map((request) => request.token), [TOKEN]);
  });

  it('asks as the agent chosen at the prompt, not as another agent set up here first', async () => {
    const sys = fresh();
    for (const agent of ['OtherBot', AGENT]) sys.files.set(pathsFor(HOME, agent).session, sessionScript(agent, AGENT_ID, pathsFor(HOME, agent)));
    sys.setToken('OtherBot', 'gho_other');
    sys.answers = [AGENT, 'y'];
    const { code, err } = await run(sys, ['example-owner']);
    assert.equal(code, 0, err.join('\n'));
    assert.ok(sys.requests.some((request) => request.token === 'gho_other'), 'the first read is as the agent set up first');
    assert.deepEqual(sys.requests.filter((request) => request.url.endsWith('/users/example-org')).map((request) => request.token), [TOKEN]);
  });

  it('with settings it cannot read, asks with the token of the agent set up here', async () => {
    const sys = limited(fresh());
    sys.files.set(SETTINGS, '{');
    sys.files.set(`${sys.home}/.config/niyam/${AGENT.toLowerCase()}/session.sh`, sessionScript(AGENT, 42, pathsFor(sys.home, AGENT)));
    // Past the release check, the settings branch refuses them with the parse's own reason.
    await assert.rejects(run(sys, []), SyntaxError);
    assert.ok(sys.requests.some((request) => request.url.includes('/compare/refs/tags/') && request.token === TOKEN), JSON.stringify(sys.requests));
    assert.deepEqual(sys.refused, [], 'no read went out with no token');
  });

  it('names the rate limit and its reset when this Mac holds no token to ask with', async () => {
    const sys = limited(fresh());
    sys.keychain.clear();
    const { code, err } = await run(sys);
    assert.equal(code, 1);
    assert.deepEqual(err, [
      `onboard: GitHub could not say whether the v${packageVersion()} tag is on main: GitHub's limit for requests with no token, 60 an hour from this address, has run out until 08:55 UTC (HTTP 403); nothing changed`,
    ]);
    assert.ok(changedNothing(sys));
  });
});
