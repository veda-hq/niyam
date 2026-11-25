import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isDeepStrictEqual } from 'node:util';

import { pathsFor, sessionEnv } from './agent.ts';
import { AGENT, AGENT_ID, blobName, capture, FakeSys, HOME, PULL_URL, TOKEN } from './fake.test.ts';
import type { Call } from './fake.test.ts';
import { HOOKS_PATH, LEFTOVER_CLOUD_SETUP_PATH, MOVED_FILES, ONBOARD_BRANCH, ONBOARD_FILES, WORKFLOW_PATH, autoMerge, mergeQueue, openPull, pullTitle, remoteFile } from './onboard-pull.ts';
import type { Change, PullTarget } from './onboard-pull.ts';

describe("onboard's files", () => {
  it('are where clients hold them, and its branch is the one a run again updates', () => {
    assert.deepEqual(ONBOARD_FILES, [
      '.github/niyam.json',
      '.claude/settings.json',
      '.claude/sarathi.json',
      '.github/workflows/niyam.yml',
      '.github/workflows/niyam-guard.yml',
      '.github/niyam/cloud-setup.sh',
      '.github/process-rules/cloud-setup.sh',
    ]);
    assert.deepEqual(MOVED_FILES, { '.github/process-rules/cloud-setup.sh': '.github/niyam/cloud-setup.sh' });
    assert.equal(ONBOARD_BRANCH, 'niyam/onboard');
  });
});

describe('pullTitle', () => {
  const plain = 'chore(niyam): onboard at v1.2.3';

  it('is plain Conventional Commits when the history gives no emoji style, or none', () => {
    assert.equal(pullTitle('1.2.3', undefined), plain, 'GitHub did not say');
    assert.equal(pullTitle('1.2.3', []), plain);
    assert.equal(pullTitle('1.2.3', ['feat: a thing', 'fix(api): b', '✨ feat: c']), plain, 'most subjects lead with no emoji');
    assert.equal(pullTitle('1.2.3', ['✨ feat: a', 'fix: b']), plain, 'half is not most');
    assert.equal(pullTitle('1.2.3', ['feat: add ✨ sparkles', 'fix: 🐛 b']), plain, 'an emoji past the start leads nothing');
    assert.equal(pullTitle('1.2.3', ['✨ feat: a\n\nits body', '🐛 fix: b\nmore']), plain, 'a whole message is not a subject');
  });

  it('reads the emoji and the rest of the subject apart, however many spaces part them', () => {
    assert.equal(pullTitle('1.2.3', ['🔥  chore: a', '🔥   chore(x): b']), `🔥 ${plain}`);
  });

  it("leads with an emoji when most of the default branch's recent subjects do", () => {
    assert.equal(pullTitle('1.2.3', ['✨ feat(ui): a', '🐛 fix: b', 'docs: c']), `🔧 ${plain}`, 'no chore to copy: the gitmoji for configuration');
    assert.equal(pullTitle('1.2.3', ['✨ feat: a', 'Merge pull request #4 from x/y', 'Merge branch main']), `🔧 ${plain}`, "merge commits are git's, not the repo's style");
  });

  it("copies the emoji the repo used for onboard before, else the one it uses most for chores", () => {
    assert.equal(pullTitle('1.2.3', ['🔥 chore(tooling): a', '♻️ refactor: b', '🔥 chore: c', '🧹 chore(x): d']), `🔥 ${plain}`);
    assert.equal(pullTitle('1.2.3', ['🔥 chore(tooling): a', '🔥 chore: c', '📦 chore(process-rules): onboard at v1.2.2']), `🔥 ${plain}`, 'not an onboard before niyam (P-57)');
    assert.equal(pullTitle('1.2.3', ['♻️ refactor: a', '⬆️ chore(deps): b', '👨‍💻 feat: c']), `⬆️ ${plain}`, 'emoji of more than one code point');
    assert.equal(pullTitle('1.2.3', ['🇮🇳 chore(i18n): a', '👍🏽 feat: b', '🧑🏿‍💻 fix: c']), `🇮🇳 ${plain}`, 'flags, skin tones and joined emoji');
    assert.equal(pullTitle('1.2.3', ['👨‍💻 chore: a', '👨‍💻 chore: b', 'fix: c']), `👨‍💻 ${plain}`, 'joined emoji alone');
    assert.equal(pullTitle('1.2.3', ['🧑🏿‍🤝‍🧑🏻 chore: a', '🧑🏿‍🤝‍🧑🏻 chore: b']), `🧑🏿‍🤝‍🧑🏻 ${plain}`, 'skin tones on joined emoji');
    assert.equal(pullTitle('1.2.3', ['📦 chore(niyam): onboard at v1.2.2', '🔥 chore: a', '🔥 chore: b']), `📦 ${plain}`, 'an earlier onboard wins over the most');
    assert.equal(pullTitle('1.2.3', ['🎉 feat: undo chore(niyam) x', '🔥 chore: a']), `🔥 ${plain}`, 'an onboard is a subject that starts so');
    assert.equal(pullTitle('1.2.3', ['🎉 feat: a chore b', '🧹 chore: c']), `🧹 ${plain}`, 'a chore is a subject that starts so');
    assert.equal(pullTitle('1.2.3', ['🧹 chore: a', '🔥 chore: b', '🔥 chore: c']), `🔥 ${plain}`, 'the most, not the first');
  });

  it('writes a gitmoji shortcode when the repo does', () => {
    assert.equal(pullTitle('1.2.3', [':sparkles: feat: a', ':bug: fix: b']), `:wrench: ${plain}`);
    assert.equal(pullTitle('1.2.3', [':sparkles: feat: a', ':fire: chore: b']), `:fire: ${plain}`);
    assert.equal(pullTitle('1.2.3', [':sparkles: feat: a', '✨ fix: b']), `🔧 ${plain}`, 'half is not most');
  });
});

describe('remoteFile', () => {
  const URL = 'https://api.github.com/repos/example-org/example-app/contents/a/b.yml?ref=feature%2Fx';
  const at = (status: number, json: unknown): FakeSys => new FakeSys().route('GET', URL, { status, json });
  const read = (sys: FakeSys) => remoteFile(sys, 'example-org/example-app', 'a/b.yml', 'feature/x', TOKEN);

  it("reads a file's text on a ref, as the agent", async () => {
    const sys = at(200, { content: Buffer.from('name: café\n').toString('base64'), encoding: 'base64' });
    assert.deepEqual(await read(sys), { text: 'name: café\n' });
    assert.deepEqual(sys.requests, [{ url: URL, method: 'GET', token: TOKEN }]);
  });

  it('reads none when GitHub says the file or ref is not there', async () => {
    assert.deepEqual(await read(at(404, { message: 'Not Found' })), {});
  });

  it('says what went wrong when GitHub could not be asked or would not say', async () => {
    const problem = (why: string) => ({ problem: `GitHub did not give a/b.yml on feature/x (${why})` });
    assert.deepEqual(await read(at(500, { content: Buffer.from('x').toString('base64') })), problem('HTTP 500'));
    assert.deepEqual(await read(at(200, null)), problem('HTTP 200'));
    assert.deepEqual(await read(at(200, [{ name: 'c.yml' }])), problem('HTTP 200'), 'a folder');
    const down = new FakeSys();
    down.http = () => Promise.reject(new Error('ECONNRESET'));
    assert.deepEqual(await read(down), problem('no answer'));
  });
});

describe('mergeQueue', () => {
  const REPO = 'https://api.github.com/repos/example-org/example-app';
  /** GitHub holding these files on main, and answering `failing` for any path it names. */
  const on = (files: Record<string, string>, failing: Record<string, number> = {}): FakeSys => {
    const sys = new FakeSys();
    for (const path of ['.mergify.yml', '.mergify/config.yml', '.github/mergify.yml']) {
      const text = files[path];
      const status = failing[path] ?? (text === undefined ? 404 : 200);
      sys.route('GET', `${REPO}/contents/${path}?ref=main`, { status, json: status === 200 ? { content: Buffer.from(text ?? '').toString('base64'), encoding: 'base64' } : { message: 'Not Found' } });
    }
    return sys;
  };
  const find = (sys: FakeSys) => mergeQueue(sys, 'example-org/example-app', 'main', TOKEN);
  const queueRule = 'queue_rules:\n  # the one queue\n  - name: default\n    merge_method: squash\n';
  const autoQueue = 'pull_request_rules:\n  - name: queue when green\n    conditions:\n      - base=main\n      - check-success=CI\n    actions:\n      queue:\n';

  it('finds a queue that takes pull requests by itself, in the first config Mergify reads, as the agent', async () => {
    for (const path of ['.mergify.yml', '.mergify/config.yml', '.github/mergify.yml']) assert.equal(await find(on({ [path]: queueRule + autoQueue })), path);
    const sys = on({ '.mergify.yml': `queue_rules: [\n  { name: default,\n    merge_method: squash },\n]\nmerge_protections_settings:\n  auto_merge_conditions: true\n` });
    assert.equal(await find(sys), '.mergify.yml', "flow style over several lines, and merge protections' auto-merge");
    assert.equal(await find(on({ '.mergify.yml': `${queueRule}merge_protection_settings:\n  auto_merge_conditions:\n    - base=main\n` })), '.mergify.yml', 'auto-merge for some pull requests, the other spelling');
    assert.ok(sys.requests.every((r) => r.token === TOKEN));
  });

  it('finds none without a config, a queue rule, or a rule that queues without a label', async () => {
    assert.equal(await find(on({})), undefined);
    assert.equal(await find(on({ '.mergify.yml': autoQueue })), undefined, 'no queue rule');
    assert.equal(await find(on({ '.mergify.yml': queueRule })), undefined, 'queued by command only');
    assert.equal(await find(on({ '.mergify.yml': 'queue_rules: []\n' + autoQueue })), undefined, 'an empty list');
    assert.equal(await find(on({ '.mergify.yml': `${queueRule}pull_request_rules:\n  - conditions: [label=queue]\n    actions: { queue: {} }\n` })), undefined, 'queued once labelled');
    assert.equal(await find(on({ '.mergify.yml': `# ${queueRule}` })), undefined, 'commented out');
    assert.equal(await find(on({ '.mergify.yml': 'queue_rules:\n  - name: default\n    autoqueue: true\n' })), undefined, "autoqueue, which Mergify replaced");
    assert.equal(await find(on({ '.mergify.yml': `${queueRule}merge_protections_settings:\n  auto_merge_conditions: [label=automerge]\n` })), undefined, 'auto-merge once labelled');
    assert.equal(await find(on({ '.mergify.yml': `${queueRule}merge_protections_settings:\n  auto_merge_conditions: null\n` })), undefined, 'auto-merge off');
    assert.equal(await find(on({ '.mergify.yml': 'pull_request_rules: []\n', '.github/mergify.yml': queueRule + autoQueue })), undefined, 'Mergify reads the first config only');
    assert.equal(await find(on({ '.mergify.yml': '', '.github/mergify.yml': queueRule + autoQueue })), undefined, 'an empty first config');
  });

  it('finds a rule asking for a label only by a top-level condition that starts with one', async () => {
    const rule = (conditions: string) => find(on({ '.mergify.yml': `${queueRule}pull_request_rules:\n  - conditions: ${conditions}\n    actions: { queue: {} }\n` }));
    assert.equal(await rule('[base=main, label=queue]'), undefined, 'one label among other conditions');
    assert.equal(await rule('[label = queue]'), undefined, 'spaces before the operator');
    assert.equal(await rule('[label~=^queue]'), undefined, 'a label pattern');
    assert.equal(await rule("['  label=queue']"), undefined, 'leading spaces');
    assert.equal(await rule('[-label=wip]'), '.mergify.yml', 'a label it must not have');
    assert.equal(await rule('[{ or: [label=a, label=b] }, base=main]'), '.mergify.yml', 'labels nested under or');
  });

  it("finds no queuing in a rule whose actions are not a map holding queue", async () => {
    const rules = (yaml: string) => find(on({ '.mergify.yml': `${queueRule}pull_request_rules:\n${yaml}` }));
    assert.equal(await rules('  - conditions: [base=main]\n    actions: queue\n'), undefined, 'actions as a word');
    assert.equal(await rules('  - conditions: [base=main]\n    actions:\n'), undefined, 'no actions');
    assert.equal(await rules('  - conditions: [base=main]\n    actions: { comment: { message: hi } }\n'), undefined, 'other actions');
    assert.equal(await rules('  -\n  - conditions: [base=main]\n    actions: { merge: {} }\n'), undefined, 'an empty rule');
    assert.equal(await rules('  -\n  - actions: { queue: {} }\n'), '.mergify.yml', 'an empty rule before one that queues');
  });

  it('finds none when GitHub does not say, or the config is not YAML', async () => {
    assert.equal(await find(on({ '.github/mergify.yml': queueRule + autoQueue }, { '.mergify.yml': 500 })), undefined);
    assert.equal(await find(on({ '.mergify.yml': 'queue_rules: [\n' })), undefined);
    const down = on({});
    down.http = () => Promise.reject(new Error('ECONNRESET'));
    assert.equal(await find(down), undefined);
  });
});

describe('openPull', () => {
  const target: PullTarget = { agent: AGENT, id: AGENT_ID, token: TOKEN, slug: 'example-org/example-app', branch: 'main', version: '1.2.3' };
  const DIR = '/tmp/niyam-1';
  const REMOTE = 'https://github.com/example-org/example-app.git';
  const workflow: Change = { path: WORKFLOW_PATH, before: 'old\n', text: 'new\n', what: 'runs v1.2.3' };
  const leftover: Change = { path: LEFTOVER_CLOUD_SETUP_PATH, before: 'setup\n', text: undefined, what: 'deleted, moved' };
  const hooks: Change = { path: HOOKS_PATH, before: undefined, text: '{}\n', what: 'added' };
  const changes = [workflow, leftover, hooks];

  /** GitHub's default branch holding what this checkout has before each change, and each exec's options. */
  const on = (tip: Map<string, string> = new Map(changes.flatMap((c) => (c.before === undefined ? [] : [[c.path, c.before] as const])))) => {
    const sys = new FakeSys();
    sys.tip = tip;
    const options: object[] = [];
    const exec = sys.exec.bind(sys);
    sys.exec = (command, args, given = {}) => {
      options.push(given);
      return exec(command, args, given);
    };
    return { sys, options, ...capture() };
  };
  /** A git step whose arguments start with `prefix` fails, as git says ` boom`. */
  const failing = (prefix: string, result = { code: 1, stdout: '', stderr: ' boom\n' }) => (call: Call) => (call.args.join(' ').startsWith(prefix) ? result : undefined);
  const gitSteps = (sys: FakeSys) => sys.calls.map((call) => [call.args.join(' '), call.input]);
  const description = (notes: string[]) =>
    [
      '`niyam onboard` v1.2.3, run by the owner, sets this repository up. The owner approved the plan holding every change below at the terminal:',
      '',
      '- `.github/workflows/niyam.yml`: runs v1.2.3',
      '- `.github/process-rules/cloud-setup.sh`: deleted, moved',
      '- `.claude/settings.json`: added',
      '',
      ...notes,
      'Merge it to finish onboarding; agent sessions then work as ExampleBot. Running onboard again updates this pull request.',
    ].join('\n');

  it("commits each change on the default branch's tip as the agent, pushes it to onboard's branch and opens the pull request", async () => {
    const { sys, options, io, err } = on();
    assert.deepEqual(await openPull(sys, io, target, changes, ['- a note']), { url: PULL_URL, id: 'PR_7' });
    assert.deepEqual(err, []);
    assert.deepEqual(gitSteps(sys), [
      ['init -q', undefined],
      [`fetch -q --depth=1 --filter=blob:none ${REMOTE} refs/heads/main`, undefined],
      ['read-tree FETCH_HEAD', undefined],
      ['rev-parse --verify -q FETCH_HEAD:.github/workflows/niyam.yml', undefined],
      ['hash-object --stdin', 'old\n'],
      ['hash-object -w --stdin', 'new\n'],
      [`update-index --add --cacheinfo 100644,${blobName('new\n')},.github/workflows/niyam.yml`, undefined],
      ['rev-parse --verify -q FETCH_HEAD:.github/process-rules/cloud-setup.sh', undefined],
      ['hash-object --stdin', 'setup\n'],
      ['update-index --force-remove .github/process-rules/cloud-setup.sh', undefined],
      ['rev-parse --verify -q FETCH_HEAD:.claude/settings.json', undefined],
      ['hash-object -w --stdin', '{}\n'],
      [`update-index --add --cacheinfo 100644,${blobName('{}\n')},.claude/settings.json`, undefined],
      ['write-tree --missing-ok', undefined],
      ['commit-tree -S tree1 -p FETCH_HEAD -m chore(niyam): onboard at v1.2.3', undefined],
      [`push -q ${REMOTE} +abc123:refs/heads/niyam/onboard`, undefined],
    ]);
    assert.deepEqual(Object.fromEntries(sys.committed), { '.github/workflows/niyam.yml': 'new\n', '.claude/settings.json': '{}\n' });
    assert.deepEqual([...sys.deleted], ['.github/process-rules/cloud-setup.sh']);
    // In the temporary repository, as the agent, with input only where git reads some.
    const env = sessionEnv({}, AGENT, AGENT_ID, TOKEN, pathsFor(HOME, AGENT));
    assert.ok(sys.calls.every((call) => call.command === 'git' && call.cwd === DIR && isDeepStrictEqual(call.env, env)));
    assert.deepEqual(
      options.map((given) => Object.keys(given).join(' ')),
      sys.calls.map((call) => (call.input === undefined ? 'cwd env' : 'cwd env input')),
    );
    assert.deepEqual(sys.removed, [DIR]);
    const opened = sys.requests.find((request) => request.method === 'POST');
    assert.deepEqual(opened, {
      url: 'https://api.github.com/repos/example-org/example-app/pulls',
      method: 'POST',
      token: TOKEN,
      body: { title: 'chore(niyam): onboard at v1.2.3', head: 'niyam/onboard', base: 'main', body: description(['- a note', '']) },
    });
  });

  it('lists no notes when it is given none', async () => {
    const { sys, io } = on();
    assert.deepEqual(await openPull(sys, io, target, changes), { url: PULL_URL, id: 'PR_7' });
    assert.equal((sys.requests.find((request) => request.method === 'POST')?.body as { body: string }).body, description([]));
  });

  it("refuses a file the default branch has otherwise than this checkout, so nothing on it is undone", async () => {
    const refused = async (tip: Map<string, string>, change: Change) => {
      const { sys, io, err } = on(tip);
      assert.equal(await openPull(sys, io, target, [change]), 1);
      assert.deepEqual(err, [`onboard: ${change.path} on main is not what this checkout has; bring this checkout up to date with main and run onboard again`]);
      assert.ok(!sys.calls.some((call) => call.args[0] === 'update-index' || call.args[0] === 'push'));
      assert.deepEqual(sys.removed, [DIR]);
    };
    await refused(new Map([[WORKFLOW_PATH, 'changed on main\n']]), workflow);
    await refused(new Map(), workflow);
    await refused(new Map([[HOOKS_PATH, 'added on main\n']]), hooks);
  });

  it('says which step failed and how, and deletes the temporary repository, opening nothing', async () => {
    const cases: [string, string, { code: number; stdout: string; stderr: string }?][] = [
      ['init', 'git init failed: boom'],
      ['fetch', 'git fetch failed: boom'],
      ['read-tree', 'git read-tree failed: boom'],
      ['update-index --force-remove', 'deleting .github/process-rules/cloud-setup.sh failed: boom'],
      ['hash-object -w', 'storing .github/workflows/niyam.yml failed: boom'],
      ['update-index --add', 'staging .github/workflows/niyam.yml failed: boom'],
      ['write-tree', 'git write-tree failed: boom'],
      ['commit-tree', 'signing the commit failed: boom'],
      ['commit-tree', 'signing the commit failed: ', { code: 0, stdout: '\n', stderr: '' }],
      ['commit-tree', 'signing the commit failed: boom', { code: 1, stdout: 'abc123\n', stderr: ' boom\n' }],
      ['push', 'pushing as ExampleBot failed: boom'],
    ];
    for (const [step, said, result] of cases) {
      const { sys, io, err } = on();
      sys.execOverride = failing(step, result);
      assert.equal(await openPull(sys, io, target, changes), 1, step);
      assert.deepEqual(err, [`onboard: ${said}`], step);
      assert.equal(sys.calls.at(-1)?.args.join(' ').startsWith(step), true, `${step} is the last step`);
      assert.ok(!sys.requests.some((request) => request.method === 'POST'), step);
      assert.deepEqual(sys.removed, [DIR], step);
    }
  });

  const PULLS = '/repos/example-org/example-app/pulls';
  const OPEN = `${PULLS}?state=open&head=example-org:niyam/onboard`;
  const OPEN_URL = 'https://github.com/example-org/example-app/pull/5';
  const titleOf = (sys: FakeSys): unknown => (sys.requests.find((request) => request.method === 'POST')?.body as { title?: unknown } | undefined)?.title;

  it("titles the pull request in the style of the default branch's recent subjects, read as the agent", async () => {
    const { sys, io } = on();
    const commits = `/repos/example-org/example-app/commits?sha=release%2F1&per_page=20`;
    sys.route('GET', commits, {
      status: 200,
      json: [null, {}, { commit: {} }, { commit: { message: 5 } }, { commit: { message: '✨ feat: a\n\nits body' } }, { commit: { message: '🐛 fix: b' } }],
    });
    assert.deepEqual(await openPull(sys, io, { ...target, branch: 'release/1' }, changes), { url: PULL_URL, id: 'PR_7' });
    assert.equal(titleOf(sys), '🔧 chore(niyam): onboard at v1.2.3');
    assert.ok(sys.calls.some((call) => call.args.join(' ') === 'commit-tree -S tree1 -p FETCH_HEAD -m 🔧 chore(niyam): onboard at v1.2.3'));
    assert.deepEqual(
      sys.requests.filter((request) => request.url.includes('/commits?')).map((request) => [request.url, request.token]),
      [[`https://api.github.com${commits}`, TOKEN]],
    );
  });

  it('takes no style when GitHub does not list the commits', async () => {
    const styled = { status: 200, json: [{ commit: { message: '✨ feat: a' } }, { commit: { message: '🐛 fix: b' } }] };
    for (const answer of [{ ...styled, status: 500 }, { status: 200, json: {} }, undefined]) {
      const { sys, io } = on();
      if (answer) sys.route('GET', '/repos/example-org/example-app/commits?sha=main&per_page=20', answer);
      else {
        const http = sys.http.bind(sys);
        sys.http = (url, options) => (url.includes('/commits?') ? Promise.reject(new Error('ECONNRESET')) : http(url, options));
      }
      assert.deepEqual(await openPull(sys, io, target, changes), { url: PULL_URL, id: 'PR_7' }, JSON.stringify(answer));
      assert.equal(titleOf(sys), 'chore(niyam): onboard at v1.2.3', JSON.stringify(answer));
    }
  });

  it('gives no id for a pull request GitHub opened without a text one', async () => {
    const { sys, io } = on();
    sys.route('POST', PULLS, { status: 201, json: { number: 7, html_url: PULL_URL, node_id: 7 } });
    assert.deepEqual(await openPull(sys, io, target, changes), { url: PULL_URL, id: undefined });
  });

  it('updates the pull request open on its branch already, its title and description', async () => {
    for (const [patched, node, said] of [
      [200, 'PR_5', []],
      [500, 5, [`onboard: could not update the description of ${OPEN_URL} (HTTP 500)`]],
    ] as [number, unknown, string[]][]) {
      const { sys, io, err } = on();
      sys.route('POST', PULLS, { status: 422, json: { message: 'Validation Failed' } });
      sys.route('GET', OPEN, { status: 200, json: [{ number: 5, html_url: OPEN_URL, node_id: node }] });
      sys.route('PATCH', `${PULLS}/5`, { status: patched, json: {} });
      assert.deepEqual(await openPull(sys, io, target, changes), { url: OPEN_URL, id: typeof node === 'string' ? node : undefined });
      assert.deepEqual(err, said);
      assert.deepEqual(
        sys.requests.filter((request) => request.method !== 'GET' || request.url.includes('state=open')),
        [
          { url: `https://api.github.com${PULLS}`, method: 'POST', token: TOKEN, body: { title: 'chore(niyam): onboard at v1.2.3', head: 'niyam/onboard', base: 'main', body: description([]) } },
          { url: `https://api.github.com${OPEN}`, method: 'GET', token: TOKEN },
          { url: `https://api.github.com${PULLS}/5`, method: 'PATCH', token: TOKEN, body: { title: 'chore(niyam): onboard at v1.2.3', body: description([]) } },
        ],
      );
    }
  });

  it('says why GitHub did not open the pull request, the changes left on its branch', async () => {
    const someone = [{ number: 5, html_url: OPEN_URL, node_id: 'PR_5' }];
    const cases: [{ status: number; json: unknown }, { status: number; json: unknown }, string][] = [
      [{ status: 500, json: { message: 'boom' } }, { status: 200, json: someone }, 'HTTP 500: boom'],
      [{ status: 500, json: null }, { status: 200, json: [] }, 'HTTP 500'],
      [{ status: 422, json: { message: 5 } }, { status: 200, json: [] }, 'HTTP 422'],
      [{ status: 422, json: { message: 'Validation Failed' } }, { status: 200, json: {} }, 'HTTP 422: Validation Failed'],
    ];
    for (const [opened, open, why] of cases) {
      const { sys, io, err } = on();
      sys.route('POST', PULLS, opened);
      sys.route('GET', OPEN, open);
      assert.equal(await openPull(sys, io, target, changes), 1, why);
      assert.deepEqual(err, [`onboard: GitHub did not open the pull request (${why}); the changes are on niyam/onboard`]);
      assert.ok(!sys.requests.some((request) => request.method === 'PATCH'), why);
      assert.deepEqual(sys.removed, [DIR]);
    }
  });
});

describe('autoMerge', () => {
  const REPO = '/repos/example-org/example-app';
  const GRAPHQL = 'https://api.github.com/graphql';
  const QUERY = 'mutation($id: ID!, $method: PullRequestMergeMethod!) { enablePullRequestAutoMerge(input: { pullRequestId: $id, mergeMethod: $method }) { pullRequest { id } } }';
  const DONE = { status: 200, json: { data: { enablePullRequestAutoMerge: { pullRequest: { id: 'PR_7' } } } } };
  const merging = (settings: unknown, reply: { status: number; json: unknown } = DONE): FakeSys => new FakeSys().route('GET', REPO, { status: 200, json: settings }).route('POST', GRAPHQL, reply);
  const ask = (sys: FakeSys, id: string | undefined) => autoMerge(sys, 'example-org/example-app', TOKEN, id);

  it('turns it on with the first merge method the repository allows, as the agent', async () => {
    for (const [settings, method] of [
      [{}, 'SQUASH'],
      [null, 'SQUASH'],
      [{ allow_auto_merge: true, allow_squash_merge: true }, 'SQUASH'],
      [{ allow_squash_merge: false }, 'REBASE'],
      [{ allow_squash_merge: false, allow_rebase_merge: false }, 'MERGE'],
    ] as [unknown, string][]) {
      const sys = merging(settings);
      assert.equal(await ask(sys, 'PR_7'), undefined, JSON.stringify(settings));
      assert.deepEqual(sys.requests, [
        { url: `https://api.github.com${REPO}`, method: 'GET', token: TOKEN },
        { url: GRAPHQL, method: 'POST', token: TOKEN, body: { query: QUERY, variables: { id: 'PR_7', method } } },
      ]);
    }
  });

  it('says why not before asking GitHub, where the repository or the pull request rules it out', async () => {
    const cases: [unknown, string | undefined, object][] = [
      [{ allow_auto_merge: false }, 'PR_7', { problem: 'example-org/example-app does not allow auto-merge', notAllowed: true }],
      [{ allow_squash_merge: false, allow_rebase_merge: false, allow_merge_commit: false }, 'PR_7', { problem: 'example-org/example-app allows no merge method' }],
      [{}, undefined, { problem: 'GitHub gave no id for the pull request' }],
      [{}, '', { problem: 'GitHub gave no id for the pull request' }],
    ];
    for (const [settings, id, why] of cases) {
      const sys = merging(settings);
      assert.deepEqual(await ask(sys, id), why);
      assert.ok(!sys.requests.some((request) => request.url === GRAPHQL));
    }
  });

  it('says what GitHub said when it refused, and whether auto-merge is not allowed', async () => {
    const data = DONE.json.data;
    const cases: [{ status: number; json: unknown }, object | undefined][] = [
      [{ status: 200, json: { errors: [], data } }, undefined],
      [{ status: 200, json: { errors: [{ message: 'Pull request is in clean status' }], data } }, { problem: 'Pull request is in clean status' }],
      [{ status: 200, json: { errors: [{ message: 'one' }, { message: 'two' }] } }, { problem: 'one; two' }],
      [{ status: 200, json: { errors: [{ message: 'Auto merge is not allowed for this repository' }] } }, { problem: 'Auto merge is not allowed for this repository', notAllowed: true }],
      [{ status: 200, json: { errors: [{ message: 'Auto-merge is NOT ENABLED here' }] } }, { problem: 'Auto-merge is NOT ENABLED here', notAllowed: true }],
      [{ status: 200, json: { errors: [{}] } }, { problem: 'HTTP 200' }],
      [{ status: 200, json: {} }, { problem: 'HTTP 200' }],
      [{ status: 200, json: null }, { problem: 'HTTP 200' }],
      [{ status: 500, json: { data } }, { problem: 'HTTP 500' }],
    ];
    for (const [reply, why] of cases) assert.deepEqual(await ask(merging({}, reply), 'PR_7'), why, JSON.stringify(reply));
  });
});
