import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { briefToIssue, loadYaml, type BriefIssue } from './brief.ts';
import { FakeSys, ROOT, SETTINGS, capture, draft, type Call } from './fake.test.ts';
import {
  RUN_LOG,
  assertDeclared,
  brief,
  briefArgs,
  citesAuthority,
  handoff,
  handoffArgs,
  handoffSettings,
  isPlumbing,
  parseHistory,
  parseRunLog,
  repeatedFailure,
  type Entry,
  type GateInput,
  type HookRun,
  type Triggers,
} from './handoff.ts';
import { run as cli } from './run.ts';
import { realSys } from './sys.ts';
import type { ExecResult, Sys } from './types.ts';

const yaml = await loadYaml();
const REPO = '/repos/example-org/example-app';
const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const FIX = 'c'.repeat(40);

describe('handoffSettings', () => {
  it('reads none as the gate off, and fills the defaults', () => {
    assert.equal(handoffSettings({ owner: 'o' }), undefined);
    assert.equal(handoffSettings(null), undefined);
    assert.equal(handoffSettings('text'), undefined);
    assert.deepEqual(handoffSettings({ handoff: { plumbing: ['.github/workflows/', 'package.json'] } }), { plumbing: ['.github/workflows/', 'package.json'], ignoreStages: [], base: 'origin/main' });
    assert.deepEqual(handoffSettings({ handoff: { plumbing: ['a/'], history: '.tmp/h.jsonl', ignoreStages: ['gate'], template: 'docs/brief.md', base: 'origin/trunk' } }), {
      plumbing: ['a/'],
      history: '.tmp/h.jsonl',
      ignoreStages: ['gate'],
      template: 'docs/brief.md',
      base: 'origin/trunk',
    });
  });

  for (const [handoff, message] of [
    [[], /"handoff" must be an object/],
    [null, /"handoff" must be an object/],
    [5, /"handoff" must be an object/],
    [{ plumbing: ['a/'], extra: 1 }, /unknown key "extra"/],
    [{ plumbing: [] }, /plumbing must be a non-empty list/],
    [{ plumbing: ['/etc/'] }, /plumbing must be a non-empty list/],
    [{ plumbing: ['a/', '/etc/'] }, /plumbing must be a non-empty list/],
    [{ plumbing: [3] }, /plumbing must be a non-empty list/],
    [{ plumbing: ['a/'], base: 3 }, /base must be a ref/],
    [{ plumbing: ['a/'], history: '../h' }, /handoff"\.history must be a path in the repository/],
    [{ plumbing: ['a/'], template: 3 }, /handoff"\.template must be a path/],
    [{ plumbing: ['a/'], ignoreStages: [1] }, /ignoreStages must be a list of stage names/],
    [{ plumbing: ['a/'], base: '--x' }, /base must be a ref/],
    [{ plumbing: ['a/'], base: '' }, /base must be a ref/],
  ] as const) {
    it(`refuses ${JSON.stringify(handoff)}`, () => assert.throws(() => handoffSettings({ handoff }), message));
  }
});

describe('isPlumbing', () => {
  it('matches a folder on a segment boundary, and a file by its whole path', () => {
    const plumbing = ['.github/workflows/', 'package.json'];
    assert.equal(isPlumbing('.github/workflows/ci.yml', plumbing), true);
    assert.equal(isPlumbing('./package.json', plumbing), true);
    assert.equal(isPlumbing('.github/workflows-old/ci.yml', plumbing), false);
    assert.equal(isPlumbing('apps/web/package.json', plumbing), false);
    assert.equal(isPlumbing('package.json.bak', plumbing), false);
    // Only a leading ./ is dropped.
    assert.equal(isPlumbing('docs/./package.json', ['docs/package.json']), false);
  });
});

const run = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  schema: 1,
  id: 'r',
  invocation: 'git push',
  startedAt: '2026-11-14T00:00:00Z',
  durationMs: 10,
  kind: 'pre-push',
  exitCode: 1,
  branch: 'feature/a',
  fingerprint: 'f1',
  stages: [
    { name: 'lint', startMs: 0, durationMs: 5, status: 'passed' },
    { name: 'test', startMs: 5, durationMs: 5, status: 'failed' },
  ],
  ...over,
});
const lines = (...runs: unknown[]): string => runs.map((one) => (typeof one === 'string' ? one : JSON.stringify(one))).join('\n');

describe('parseHistory', () => {
  it('keeps whole runs and counts the rest', () => {
    const parsed = parseHistory(lines(run(), '', 'not json', 'null', run({ id: 3 }), run({ stages: [{ name: 'x' }] }), run({ branch: null, fingerprint: undefined }), run({ branch: 4 })));
    assert.equal(parsed.runs.length, 2);
    assert.equal(parsed.malformed, 5);
  });

  it('keeps a run only when every field its writer writes has its type, each checked on its own', () => {
    const stage = { name: 'test', startMs: 0, durationMs: 1, status: 'failed' };
    const good = [run({ id: 'a' }), run({ id: 'b', branch: null, fingerprint: null }), run({ id: 'c', branch: undefined, fingerprint: undefined }), run({ id: 'd', stages: [] })];
    const bad = [
      'not json',
      'null',
      '5',
      '"text"',
      ...['schema', 'durationMs', 'exitCode'].map((field) => run({ [field]: '1' })),
      ...['id', 'invocation', 'startedAt', 'kind'].map((field) => run({ [field]: 1 })),
      run({ branch: 4 }),
      run({ fingerprint: 4 }),
      run({ stages: 'test' }),
      run({ stages: [null] }),
      run({ stages: [stage, { ...stage, status: 1 }] }),
      ...['startMs', 'durationMs'].map((field) => run({ stages: [{ ...stage, [field]: '1' }] })),
      run({ stages: [{ ...stage, name: 1 }] }),
    ];
    // Blank lines, spaces only included, are no line at all.
    const parsed = parseHistory(lines(...good, '', '   ', ...bad));
    assert.deepEqual([parsed.runs.map((one) => (one as unknown as { id: string }).id), parsed.malformed], [['a', 'b', 'c', 'd'], bad.length]);
    assert.deepEqual(parseHistory(undefined), { runs: [], malformed: 0 });
  });
});

describe('repeatedFailure', () => {
  const runs = (list: Record<string, unknown>[]): HookRun[] => parseHistory(lines(...list)).runs;

  const threshold = { failures: 3, trees: 2 };
  const lint = { stages: [{ name: 'lint', startMs: 0, durationMs: 1, status: 'failed' }] };

  it('fires on three failures of one stage across two trees, on this branch', () => {
    const fired = repeatedFailure(runs([run(), run({ fingerprint: 'f2' }), run({ fingerprint: null })]), 'feature/a', []);
    assert.deepEqual(fired, { fired: true, stage: 'test', failures: 3, trees: 2, threshold });
  });

  it('names nothing with no failure on the branch', () => {
    assert.deepEqual(repeatedFailure([], 'feature/a', []), { fired: false, stage: null, failures: 0, trees: 0, threshold });
  });

  it('counts nothing of another branch or kind, a pass, an ignored stage, or a run with no failed stage', () => {
    const noise = [
      run({ branch: 'feature/b' }),
      run({ kind: 'pre-commit' }),
      run({ exitCode: 0 }),
      run({ stages: [{ name: 'gate', startMs: 0, durationMs: 1, status: 'timed_out' }] }),
      run({ stages: [{ name: 'lint', startMs: 0, durationMs: 1, status: 'skipped' }] }),
    ];
    assert.deepEqual(repeatedFailure(runs(noise), 'feature/a', ['gate']), { fired: false, stage: null, failures: 0, trees: 0, threshold });
    // Two real failures among the noise are a near miss, named with their own counts and nothing else's.
    assert.deepEqual(repeatedFailure(runs([...noise, run(), run({ fingerprint: 'f2' })]), 'feature/a', ['gate']), { fired: false, stage: 'test', failures: 2, trees: 2, threshold });
  });

  it('names the stage nearest the trigger when none fires: most failures, then most trees, then the first seen', () => {
    assert.deepEqual(repeatedFailure(runs([run(), run()]), 'feature/a', []), { fired: false, stage: 'test', failures: 2, trees: 1, threshold });
    // Three failures in one tree is still short of the trigger; it is nearer than two.
    assert.deepEqual(repeatedFailure(runs([run({ ...lint }), run({ ...lint, fingerprint: 'f2' }), run(), run(), run()]), 'feature/a', []), {
      fired: false,
      stage: 'test',
      failures: 3,
      trees: 1,
      threshold,
    });
    assert.equal(repeatedFailure(runs([run(), run(), run({ ...lint }), run({ ...lint, fingerprint: 'f2' })]), 'feature/a', []).stage, 'lint');
    assert.equal(repeatedFailure(runs([run(), run({ ...lint })]), 'feature/a', []).stage, 'test');
  });

  it('needs two trees, and names the stage that failed most', () => {
    assert.equal(repeatedFailure(runs([run(), run(), run()]), 'feature/a', []).fired, false);
    const both = [run(), run({ fingerprint: 'f2' }), run({ fingerprint: 'f3' }), run({ ...lint }), run({ ...lint, fingerprint: 'f2' }), run({ ...lint, fingerprint: 'f3' }), run({ ...lint, fingerprint: 'f4' })];
    assert.deepEqual(repeatedFailure(runs(both), 'feature/a', []), { fired: true, stage: 'lint', failures: 4, trees: 4, threshold });
  });

  it('counts a stage that timed out as one that failed', () => {
    const timedOut = { stages: [{ name: 'test', startMs: 0, durationMs: 1, status: 'timed_out' }] };
    assert.deepEqual(repeatedFailure(runs([run(timedOut), run({ ...timedOut, fingerprint: 'f2' }), run(timedOut)]), 'feature/a', []), { fired: true, stage: 'test', failures: 3, trees: 2, threshold });
  });

  it('names the stage that fired most whatever the order, and the first seen of two that fired as often', () => {
    const tests = [run(), run({ fingerprint: 'f2' }), run({ fingerprint: 'f3' })];
    const lints = [run({ ...lint }), run({ ...lint, fingerprint: 'f2' }), run({ ...lint, fingerprint: 'f3' })];
    assert.equal(repeatedFailure(runs([...lints, run({ ...lint, fingerprint: 'f4' }), ...tests]), 'feature/a', []).stage, 'lint');
    assert.equal(repeatedFailure(runs([...lints, ...tests]), 'feature/a', []).stage, 'lint');
    assert.equal(repeatedFailure(runs([...tests, ...lints]), 'feature/a', []).stage, 'test');
  });

  it('names the stage with more failures as nearest, before one on more trees', () => {
    const near = repeatedFailure(runs([run(), run(), run(), run({ ...lint }), run({ ...lint, fingerprint: 'f2' })]), 'feature/a', []);
    assert.deepEqual(near, { fired: false, stage: 'test', failures: 3, trees: 1, threshold });
  });

  it('names a stage that fired over one that failed more without firing', () => {
    const near = [run(), run(), run(), run(), run()];
    const fires = [run({ ...lint }), run({ ...lint, fingerprint: 'f2' }), run({ ...lint })];
    assert.deepEqual(repeatedFailure(runs([...near, ...fires]), 'feature/a', []), { fired: true, stage: 'lint', failures: 3, trees: 2, threshold });
    assert.deepEqual(repeatedFailure(runs([...fires, ...near]), 'feature/a', []), { fired: true, stage: 'lint', failures: 3, trees: 2, threshold });
  });
});

const entry = (over: Partial<Entry> = {}): Entry => ({
  ts: '2026-11-14T00:00:00Z',
  callSite: 'push-skill',
  branch: 'feature/a',
  baseRef: 'origin/main',
  baseSha: BASE,
  headSha: HEAD,
  triggers: ['plumbing-edit'],
  disposition: 'own-work',
  reason: 'the workflow change is this slice',
  briefs: [],
  spawned: 'n/a',
  ...over,
});

describe('parseRunLog and citesAuthority', () => {
  it('keeps whole declarations and counts the rest', () => {
    const parsed = parseRunLog(lines(entry(), '', '{', entry({ callSite: 'x' as Entry['callSite'] }), entry({ briefs: [1] as unknown as string[] }), entry({ spawned: 'later' as Entry['spawned'] })));
    assert.deepEqual([parsed.entries.length, parsed.malformed], [1, 4]);
  });

  it('keeps a declaration only when every field has its type, each checked on its own', () => {
    const good = [entry({ ts: 'a' }), entry({ ts: 'b', disposition: 'gate-pass', callSite: 'hook-verify', spawned: 'chip', triggers: [], briefs: ['#1'] })];
    const bad = [
      'null',
      '5',
      ...['ts', 'branch', 'baseRef', 'baseSha', 'headSha', 'reason'].map((field) => entry({ [field]: 1 } as unknown as Partial<Entry>)),
      ...['callSite', 'disposition', 'spawned'].map((field) => entry({ [field]: 1 } as unknown as Partial<Entry>)),
      entry({ triggers: 'plumbing-edit' as unknown as string[] }),
      entry({ triggers: [1] as unknown as string[] }),
    ];
    const parsed = parseRunLog(lines(...good, '   ', ...bad));
    assert.deepEqual([parsed.entries.map((one) => one.ts), parsed.malformed], [['a', 'b'], bad.length]);
  });

  it('accepts an issue, a link, an id, an ADR or a commit as where the owner decided', () => {
    for (const reason of ['per #12', '#12', 'https://x.test/a', 'http://x.test/a', 'see ABC-12', 'ADR-0001', 'in abc1234']) assert.equal(citesAuthority(reason), true, reason);
    assert.equal(citesAuthority('Alok said so'), false);
    assert.equal(citesAuthority('a#12'), false);
  });
});

describe('assertDeclared', () => {
  const plumbing: Triggers = { plumbing: { fired: true, paths: ['a/1', 'a/2', 'a/3', 'a/4', 'a/5', 'a/6'] }, repeated: { fired: false, stage: null, failures: 0, trees: 0, threshold: { failures: 3, trees: 2 } } };
  const both: Triggers = { ...plumbing, repeated: { fired: true, stage: 'test', failures: 3, trees: 2, threshold: { failures: 3, trees: 2 } } };
  const brief = (over: Partial<BriefIssue> = {}): BriefIssue => ({ number: 9, state: 'OPEN', stateReason: null, type: 'Brief', body: briefToIssue(draft(), 'T').body, closingSha: null, ...over });
  const input = (over: Partial<GateInput> = {}): GateInput => ({
    triggers: plumbing,
    baseSha: BASE,
    headSha: HEAD,
    branch: 'feature/a',
    entries: [entry()],
    changedFiles: ['a/1'],
    yaml,
    pathExists: () => true,
    pathDeletedSince: () => false,
    isAncestorOfHead: () => true,
    readIssue: async () => brief(),
    ...over,
  });

  it('passes a push that fired nothing, and one declared own work', async () => {
    const none = await assertDeclared(input({ triggers: { plumbing: { fired: false, paths: [] }, repeated: plumbing.repeated }, entries: [] }));
    assert.deepEqual([none.ok, none.reason], [true, 'no-trigger']);
    const own = await assertDeclared(input());
    assert.deepEqual([own.ok, own.reason, own.matched], [true, 'declared', entry()]);
    assert.match(own.detail, /changes 6 shared-plumbing file\(s\) \(a\/1, a\/2, a\/3, a\/4, a\/5, …\); declared "own-work"/);
  });

  for (const [name, over, reason, detail] of [
    ['an empty log', { entries: [] }, 'empty-run-log', /holds no declaration/],
    ['a log only the gate wrote', { entries: [entry({ callSite: 'pre-push-hook' }), entry({ callSite: 'hook-verify' })] }, 'no-push-skill-entry', /there: hook-verify, pre-push-hook\)/],
    ['a declaration of another head', { entries: [entry({ headSha: FIX })] }, 'stale-head-sha', /covered head ccccccc, but this push carries aaaaaaa/],
    ['a declaration against another base', { entries: [entry({ baseSha: FIX })] }, 'stale-base-sha', /against base ccccccc, but this push compares with bbbbbbb/],
    ['a trigger that fired after the declaration', { triggers: both }, 'trigger-not-declared', /failed 3 times at stage "test" across 2 working trees, but .* covered only \[plumbing-edit\]; repeated-stage-failure fired after it/],
    ['a declaration with no triggers', { triggers: both, entries: [entry({ triggers: [] })] }, 'trigger-not-declared', /covered only \[none\]/],
    ["the gate's own record", { entries: [entry({ disposition: 'gate-pass' })] }, 'declaration-not-concluded', /"gate-pass", the gate's own record/],
    ['own work with no reason', { entries: [entry({ reason: ' ' })] }, 'missing-reason', /"own-work" was declared with no --reason/],
    ['a dismissal citing nothing', { entries: [entry({ disposition: 'dismissed', reason: 'owner said' })] }, 'uncited-dismissal', /Got: "owner said"/],
    ['a hand-off with no brief', { entries: [entry({ disposition: 'handed-off' })], template: 'docs/brief.md' }, 'missing-brief', /write one from docs\/brief.md and open it/],
    ['a carrying with no brief, and no template', { entries: [entry({ disposition: 'carrying' })] }, 'missing-brief', /write one and open it/],
    ['a brief that is not an issue', { entries: [entry({ disposition: 'handed-off', briefs: ['docs/b.md'] })] }, 'brief-not-an-issue', /"docs\/b.md" is not a Brief issue/],
    ['a blocking brief still open', { entries: [entry({ disposition: 'handed-off', briefs: ['#9'] })], readIssue: async () => brief({ body: briefToIssue(draft({ blocking: 'yes' }), 'T').body }) }, 'handoff-not-landed', /#9 is blocking and still open/],
  ] as const) {
    it(`refuses ${name}`, async () => {
      const verdict = await assertDeclared(input(over as Partial<GateInput>));
      assert.deepEqual([verdict.ok, verdict.reason, verdict.matched], [false, reason, null]);
      assert.match(verdict.detail, detail);
    });
  }

  it('passes a cited dismissal, and briefs that hold, the newest covering declaration deciding', async () => {
    const dismissed = await assertDeclared(input({ entries: [entry({ reason: '' }), entry({ disposition: 'dismissed', reason: 'per #12' })] }));
    assert.deepEqual([dismissed.ok, dismissed.matched?.disposition], [true, 'dismissed']);
    const read: number[] = [];
    const carrying = await assertDeclared(
      input({
        entries: [entry({ disposition: 'carrying', briefs: ['#9', '#10'] })],
        template: 'docs/brief.md',
        readIssue: async (n) => (read.push(n), brief({ body: briefToIssue(draft({}, '## What I verified\nx\n## Why I did not hand off\ny'), 'T').body })),
      }),
    );
    assert.deepEqual([carrying.ok, carrying.reason, carrying.detail.endsWith('declared "carrying" with #9, #10'), read], [true, 'declared', true, [9, 10]]);
  });

  it('says why a push that fired nothing goes, and names each trigger that fired', async () => {
    const none = await assertDeclared(input({ triggers: { plumbing: { fired: false, paths: [] }, repeated: plumbing.repeated }, entries: [] }));
    assert.equal(none.detail, 'this push changes no shared plumbing and shows no stage failing again and again');
    const five: Triggers = { ...plumbing, plumbing: { fired: true, paths: ['a/1', 'a/2', 'a/3', 'a/4', 'a/5'] } };
    assert.match((await assertDeclared(input({ triggers: five, entries: [] }))).detail, /^this branch changes 5 shared-plumbing file\(s\) \(a\/1, a\/2, a\/3, a\/4, a\/5\), and /);
    const repeated: Triggers = { plumbing: { fired: false, paths: [] }, repeated: both.repeated };
    assert.match((await assertDeclared(input({ triggers: repeated, entries: [] }))).detail, /^the push has failed 3 times at stage "test" across 2 working trees, and /);
    assert.match((await assertDeclared(input({ triggers: both, entries: [] }))).detail, /^this branch changes 6 .*, …\) and the push has failed 3 times/);
  });

  it('names a declaration with no head as none, and every trigger it covered or missed', async () => {
    assert.match((await assertDeclared(input({ entries: [entry({ headSha: '' })] }))).detail, /covered head \(none\), but/);
    const partial = await assertDeclared(input({ triggers: both, entries: [entry({ triggers: ['x', 'y'] })] }));
    assert.match(partial.detail, /covered only \[x, y\]; plumbing-edit, repeated-stage-failure fired after it/);
  });

  for (const ref of ['x#9', '#9x', '#09']) {
    it(`refuses a brief "${ref}" that is not #N`, async () => {
      const verdict = await assertDeclared(input({ entries: [entry({ disposition: 'handed-off', briefs: [ref] })] }));
      assert.deepEqual([verdict.ok, verdict.reason], [false, 'brief-not-an-issue']);
    });
  }

  it('judges a carried brief as carried: blocking and open, blaming a file this branch changed', async () => {
    const body = briefToIssue(draft({ blocking: 'yes' }, '## What I verified\nx\n## Why I did not hand off\ny'), 'T').body;
    const verdict = await assertDeclared(input({ entries: [entry({ disposition: 'carrying', briefs: ['#9'] })], changedFiles: ['tools/lint.sh'], readIssue: async () => brief({ body }) }));
    assert.deepEqual([verdict.ok, verdict.reason], [true, 'declared']);
  });
});

describe('handoffArgs and briefArgs', () => {
  it('reads one mode and its options, as --flag value or --flag=value', () => {
    assert.deepEqual(handoffArgs(['--detect']), { mode: 'detect', reason: '', briefs: [], spawned: 'n/a' });
    assert.deepEqual(handoffArgs(['--record', '--base=origin/x', '--disposition', 'handed-off', '--reason', 'r', '--brief', '#1, #2,', '--open-brief', 'b.md', '--call-site', 'push-skill', '--spawned', 'chip']), {
      mode: 'record',
      base: 'origin/x',
      disposition: 'handed-off',
      reason: 'r',
      briefs: ['#1', '#2'],
      openBrief: 'b.md',
      callSite: 'push-skill',
      spawned: 'chip',
    });
    assert.deepEqual(handoffArgs(['--assert-fresh', '--call-site', 'hook-verify']), { mode: 'assert-fresh', reason: '', briefs: [], callSite: 'hook-verify', spawned: 'n/a' });
    // An inline value runs from the first = to the end, lines included.
    assert.equal(handoffArgs(['--record', '--disposition=own-work', '--reason=a=b\nc']).reason, 'a=b\nc');
  });

  for (const [args, message] of [
    [[], /takes one of --detect, --record or --assert-fresh/],
    [['--detect', '--record'], /takes one of/],
    [['--detect', '--detect'], /--detect is given twice/],
    [['--detect', 'x'], /unexpected argument "x"/],
    [['--detect=x'], /unexpected argument "--detect=x"/],
    [['--detect', 'x--base=origin/x'], /unexpected argument "x--base=origin\/x"/],
    [['--record', '--disposition', 'own-work', '--reason', ' '], /--reason needs a value/],
    [['--detect', '--reason', 'r'], /--detect does not take --reason/],
    [['--assert-fresh', '--brief', '#1'], /--assert-fresh does not take --brief/],
    [['--record', '--reason'], /--reason needs a value/],
    [['--record', '--reason', '--base'], /--reason needs a value/],
    [['--record', '--reason='], /--reason needs a value/],
    [['--record'], /--record needs --disposition own-work\|handed-off\|carrying\|dismissed$/],
    [['--record', '--disposition', 'gate-pass'], /, not "gate-pass"/],
    [['--record', '--disposition', 'handed-off', '--open-brief', 'b.md'], /--open-brief needs --reason/],
    [['--record', '--disposition', 'own-work', '--call-site', 'ci'], /--call-site takes push-skill\|pre-push-hook\|hook-verify, not "ci"/],
    [['--detect', '--call-site', 'push-skill'], /--detect does not take --call-site/],
    [['--assert-fresh', '--call-site', 'push-skill'], /cannot run as "push-skill"/],
    [['--record', '--disposition', 'own-work', '--spawned', 'later'], /--spawned takes chip\|manual\|unavailable\|n\/a, not "later"/],
  ] as const) {
    it(`refuses ${JSON.stringify(args)}`, () => assert.throws(() => handoffArgs(args), message));
  }

  it('reads one draft, linted or opened', () => {
    assert.deepEqual(briefArgs(['b.md']), { draft: 'b.md', lint: false });
    assert.deepEqual(briefArgs(['--lint', 'b.md']), { draft: 'b.md', lint: true });
    for (const args of [[], ['--lint'], ['a', 'b'], ['--open']]) assert.throws(() => briefArgs(args), /brief takes one draft file/);
  });
});

/** A repository on branch feature/a whose branch changes `changed`, with `.github/niyam.json` naming `handoff`. */
function repo(changed: string[], handoff: unknown = { plumbing: ['.github/workflows/'], history: '.tmp/history.jsonl', template: 'docs/brief.md' }, extra: Record<string, unknown> = {}): FakeSys {
  const sys = new FakeSys();
  sys.files.set(`${ROOT}/.github/niyam.json`, JSON.stringify({ ...JSON.parse(SETTINGS), ...(handoff === null ? {} : { handoff }), ...extra }));
  sys.env.GH_TOKEN = 'tok';
  const git = (call: Call): ExecResult | undefined => {
    const args = call.args.join(' ');
    const ok = (stdout = ''): ExecResult => ({ code: 0, stdout, stderr: '' });
    if (args === 'rev-parse --abbrev-ref HEAD') return ok('feature/a\n');
    if (args === 'rev-parse HEAD') return ok(`${HEAD}\n`);
    if (args.startsWith('rev-parse --symbolic-full-name ')) return ok(`${call.args[2]?.startsWith('origin/') ? `refs/remotes/${call.args[2]}` : call.args[2]}\n`);
    // Only the exact questions are answered; any other git call fails, as an unexpected one.
    if (args.startsWith('merge-base --is-ancestor ')) return { code: args === `merge-base --is-ancestor ${FIX} HEAD` ? 0 : 1, stdout: '', stderr: '' };
    if (/^merge-base origin\/\S+ HEAD$/.test(args)) return ok(`${BASE}\n`);
    if (args.startsWith('diff --name-only')) return ok(changed.map((file) => `${file}\n`).join(''));
    // gone.sh was there before FIX, which removed it.
    if (args.startsWith('cat-file -e')) return { code: ['HEAD:tools/lint.sh', 'HEAD:docs/brief.md', `${FIX}^:gone.sh`].includes(call.args[2] ?? '') ? 0 : 1, stdout: '', stderr: '' };
    return undefined;
  };
  gits.set(sys, git);
  sys.execOverride = (call) => (call.command === 'git' ? git(call) : undefined);
  return sys;
}

/** Each fake repository's git answers, for a test that changes one. */
const gits = new WeakMap<FakeSys, (call: Call) => ExecResult | undefined>();

const logged = (sys: FakeSys): Entry[] => parseRunLog(sys.files.get(`${ROOT}/${RUN_LOG}`) ?? '').entries;

describe('handoff', () => {
  it('says what fires', async () => {
    const sys = repo(['.github/workflows/ci.yml', 'src/a.ts']);
    const { out, io } = capture();
    assert.equal(await handoff(sys, io, ['--detect']), 0);
    const shown = JSON.parse(out.join('\n')) as { fired: string[]; changedFiles: number; baseRef: string };
    assert.deepEqual([shown.fired, shown.changedFiles, shown.baseRef], [['plumbing-edit'], 2, 'origin/main']);
    assert.ok(sys.calls.some((call) => call.args.join(' ') === 'diff --name-only origin/main...HEAD'));
  });

  it('counts the push history it is given', async () => {
    const sys = repo(['src/a.ts']);
    sys.files.set(`${ROOT}/.tmp/history.jsonl`, lines(run(), run({ fingerprint: 'f2' }), run()));
    const { out, io } = capture();
    assert.equal(await handoff(sys, io, ['--detect', '--base', 'origin/trunk']), 0);
    assert.deepEqual((JSON.parse(out.join('\n')) as { fired: string[] }).fired, ['repeated-stage-failure']);
  });

  it('names the stage nearest the repeated-failure trigger before it fires, and none with no failure', async () => {
    const detect = async (history: string): Promise<{ fired: string[]; triggers: Triggers }> => {
      const sys = repo(['src/a.ts']);
      sys.files.set(`${ROOT}/.tmp/history.jsonl`, history);
      const { out, io } = capture();
      assert.equal(await handoff(sys, io, ['--detect']), 0);
      return JSON.parse(out.join('\n')) as { fired: string[]; triggers: Triggers };
    };
    const near = await detect(lines(run(), run()));
    assert.deepEqual([near.fired, near.triggers.repeated], [[], { fired: false, stage: 'test', failures: 2, trees: 1, threshold: { failures: 3, trees: 2 } }]);
    const none = await detect('');
    assert.deepEqual([none.fired, none.triggers.repeated], [[], { fired: false, stage: null, failures: 0, trees: 0, threshold: { failures: 3, trees: 2 } }]);
  });

  it('records a declaration that the gate then passes, recording its own verdict', async () => {
    const sys = repo(['.github/workflows/ci.yml']);
    const { io, err, out } = capture();
    assert.equal(await handoff(sys, io, ['--record', '--disposition', 'own-work', '--reason', 'the workflow is this slice']), 0);
    assert.equal(await handoff(sys, io, ['--assert-fresh']), 0);
    assert.deepEqual(err, []);
    assert.match(out.at(-1) ?? '', /^✓ handoff: .*declared "own-work": the workflow is this slice/);
    assert.deepEqual(
      logged(sys).map((one) => [one.callSite, one.disposition, one.triggers, one.headSha, one.baseSha]),
      [
        ['push-skill', 'own-work', ['plumbing-edit'], HEAD, BASE],
        ['pre-push-hook', 'gate-pass', ['plumbing-edit'], HEAD, BASE],
      ],
    );
  });

  it('refuses a push with no declaration, and says how to declare', async () => {
    const sys = repo(['.github/workflows/ci.yml']);
    const { io, err } = capture();
    assert.equal(await handoff(sys, io, ['--assert-fresh', '--call-site', 'hook-verify']), 1);
    assert.match(err[0] ?? '', /^✗ handoff: this branch changes 1 shared-plumbing file\(s\) \(\.github\/workflows\/ci.yml\), and .* holds no declaration/);
    assert.match(err.join('\n'), /niyam handoff --record --base origin\/main --disposition/);
    assert.deepEqual(logged(sys).map((one) => [one.callSite, one.disposition]), [['hook-verify', 'gate-refused']]);
  });

  it('skips quietly when nothing fires, and when the repository turned the gate off', async () => {
    const sys = repo(['src/a.ts']);
    const { io, out, err } = capture();
    assert.equal(await handoff(sys, io, ['--assert-fresh']), 0);
    assert.deepEqual(logged(sys).map((one) => one.disposition), ['gate-skipped']);
    const off = repo(['.github/workflows/ci.yml'], null);
    assert.equal(await handoff(off, io, ['--assert-fresh']), 0);
    off.files.delete(`${ROOT}/.github/niyam.json`);
    assert.equal(await handoff(off, io, ['--assert-fresh']), 0);
    assert.deepEqual([out, err, off.files.has(`${ROOT}/${RUN_LOG}`)], [[], [], false]);
    await assert.rejects(handoff(off, io, ['--detect']), /names no "handoff": the gate is off/);
  });

  it("takes the base's settings over the branch's, so a branch cannot turn the gate off in the push it gates", async () => {
    const sys = repo(['.github/niyam.json', '.github/workflows/ci.yml'], null);
    const atBase = (stdout: string, code = 0) => (sys.execOverride = (call) => (call.args[0] === 'show' ? (call.args[1] === 'origin/main:.github/niyam.json' ? { code, stdout, stderr: '' } : undefined) : gits.get(sys)?.(call)));
    atBase(JSON.stringify({ handoff: { plumbing: ['.github/workflows/'] } }));
    const { io, err } = capture();
    assert.equal(await handoff(sys, io, ['--assert-fresh']), 1);
    assert.match(err[0] ?? '', /changes 2 shared-plumbing file\(s\) \(\.github\/niyam.json, \.github\/workflows\/ci.yml\)/);
    // A base whose settings do not read decides nothing; the branch's then do.
    atBase('{');
    assert.equal(await handoff(sys, io, ['--assert-fresh']), 0);
    atBase('', 128);
    assert.equal(await handoff(sys, io, ['--assert-fresh', '--base', 'origin/trunk']), 0);
  });

  it('refuses a base that is no remote-tracking branch, and reads the base copy from the remote default', async () => {
    // The branch's own settings point the base at itself, so the push would be compared with itself.
    const sys = repo(['.github/workflows/ci.yml'], { plumbing: ['.github/workflows/'], base: 'HEAD' });
    await assert.rejects(handoff(sys, capture().io, ['--assert-fresh']), /the base "HEAD" is not a remote-tracking branch/);
    await assert.rejects(handoff(sys, capture().io, ['--detect', '--base', 'feature/a']), /the base "feature\/a" is not a remote-tracking branch/);
    const shows: string[] = [];
    sys.execOverride = (call) =>
      call.args[0] === 'symbolic-ref'
        ? { code: 0, stdout: 'origin/trunk\n', stderr: '' }
        : call.args[0] === 'show'
          ? (shows.push(call.args[1] ?? ''), { code: 0, stdout: JSON.stringify({ handoff: { plumbing: ['.github/workflows/'], base: 'origin/trunk' } }), stderr: '' })
          : gits.get(sys)?.(call);
    assert.equal(await handoff(sys, capture().io, ['--assert-fresh']), 1);
    assert.deepEqual([...new Set(shows)], ['origin/trunk:.github/niyam.json']);
  });

  it('says which git question it could not answer', async () => {
    const sys = repo([]);
    sys.execOverride = (call) => (call.args[0] === 'diff' ? { code: 128, stdout: '', stderr: 'bad' } : gits.get(sys)?.(call));
    await assert.rejects(handoff(sys, capture().io, ['--detect']), /git cannot tell what this branch changes against origin\/main/);
  });

  it('opens a brief, adds it to the board, records it, and the gate reads it back', async () => {
    const sys = repo(['.github/workflows/ci.yml'], { plumbing: ['.github/workflows/'] }, { project: 'Board' });
    sys.files.set(`${ROOT}/.tmp/b.md`, draft({ 'blocking': 'yes' }));
    sys.cwd = `${ROOT}/.tmp`;
    sys
      .route('POST', `${REPO}/issues`, { status: 201, json: { number: 9, id: 900, html_url: 'https://github.com/example-org/example-app/issues/9' } })
      .route('GET', REPO, { status: 200, json: { owner: { login: 'example-org', type: 'Organization' } } })
      .route('GET', '/orgs/example-org/projectsV2?per_page=100&page=1', { status: 200, json: [{ number: 4, title: 'Board' }] })
      .route('POST', '/orgs/example-org/projectsV2/4/items', { status: 201, json: {} });
    const { io, out, err } = capture();
    assert.equal(await handoff(sys, io, ['--record', '--disposition', 'handed-off', '--reason', 'r', '--brief', '#9', '--open-brief', 'b.md', '--spawned', 'chip']), 0);
    assert.match(out[0] ?? '', /^✓ opened #9 on "Board": /);
    assert.deepEqual(logged(sys).map((one) => [one.briefs, one.spawned]), [[['#9'], 'chip']]);
    const body = (sys.requests.find((one) => one.method === 'POST' && one.url.endsWith('/issues'))?.body as { body: string }).body;
    // Blocking and still open: the gate stops the push until the fix lands.
    sys.route('GET', `${REPO}/issues/9`, { status: 200, json: { number: 9, state: 'open', type: { name: 'Brief' }, body } });
    assert.equal(await handoff(sys, io, ['--assert-fresh']), 1);
    assert.match(err.join('\n'), /#9 is blocking and still open/);
    // Closed by the merged fix, which this branch has merged in.
    sys
      .route('GET', `${REPO}/issues/9`, { status: 200, json: { number: 9, state: 'closed', state_reason: 'completed', type: { name: 'Brief' }, body } })
      .route('GET', `${REPO}/issues/9/timeline?per_page=100&page=1`, {
        status: 200,
        json: [{ event: 'cross-referenced', source: { issue: { number: 10, repository_url: `https://api.github.com${REPO}`, pull_request: { merged_at: '2026-11-14' } } } }],
      })
      .route('GET', REPO, { status: 200, json: { owner: { login: 'example-org', type: 'Organization' }, default_branch: 'main' } })
      .route('GET', `${REPO}/pulls/10`, { status: 200, json: { body: 'Fixes #9', merged_at: '2026-11-14', merge_commit_sha: FIX, base: { ref: 'main' } } });
    assert.equal(await handoff(sys, io, ['--assert-fresh']), 0);
  });

  it('records a brief even when the board will not take it, and reads none without a token', async () => {
    const sys = repo(['.github/workflows/ci.yml'], { plumbing: ['.github/workflows/'] }, { project: 'Board' });
    sys.files.set(`${ROOT}/b.md`, draft());
    sys.route('POST', `${REPO}/issues`, { status: 201, json: { number: 9, id: 900, html_url: 'u' } }).route('GET', REPO, { status: 403, json: null });
    const { io, err } = capture();
    assert.equal(await handoff(sys, io, ['--record', '--disposition', 'handed-off', '--reason', 'r', '--open-brief', `${ROOT}/b.md`]), 0);
    assert.match(err[0] ?? '', /^⚠ opened u but could not add it to "Board" \(GitHub refused to read example-org\/example-app \(HTTP 403\)\); add it by hand/);
    assert.deepEqual(logged(sys).map((one) => one.briefs), [['#9']]);
    delete sys.env.GH_TOKEN;
    assert.equal(await handoff(sys, io, ['--assert-fresh']), 1);
    assert.match(err.at(-3) ?? '', /#9 could not be read from GitHub/);
  });

  it('opens a brief with no board named', async () => {
    const sys = repo(['.github/workflows/ci.yml']);
    sys.files.set(`${ROOT}/b.md`, draft());
    sys.route('POST', `${REPO}/issues`, { status: 201, json: { number: 9, id: 900, html_url: 'u' } });
    const { io, out } = capture();
    assert.equal(await handoff(sys, io, ['--record', '--disposition', 'carrying', '--reason', 'r', '--open-brief', 'b.md']), 1);
    assert.equal(await brief(sys, io, ['b.md']), 0);
    assert.deepEqual(out, ['✓ opened #9: u']);
  });

  for (const [name, setup, args, message] of [
    ['a draft outside the repository', () => {}, ['--open-brief', '/etc/b.md'], /must be a file in the repository: \/etc\/b.md/],
    ['a draft that is not there', () => {}, ['--open-brief', 'gone.md'], /no brief draft at gone.md/],
    ['a draft that does not lint', (sys: FakeSys) => sys.files.set(`${ROOT}/b.md`, draft({ blocking: 'maybe' })), ['--open-brief', 'b.md'], /^✗ b.md: frontmatter `blocking` must be yes or no/],
    ['a session with no token', (sys: FakeSys) => (sys.files.set(`${ROOT}/b.md`, draft()), delete sys.env.GH_TOKEN), ['--open-brief', 'b.md'], /no token; run niyam doctor/],
  ] as const) {
    it(`opens no issue for ${name}`, async () => {
      const sys = repo(['.github/workflows/ci.yml']);
      setup(sys);
      const { io, err } = capture();
      assert.equal(await handoff(sys, io, ['--record', '--disposition', 'handed-off', '--reason', 'r', ...args]), 1);
      assert.match(err[0] ?? '', message);
      assert.equal(sys.requests.filter((one) => one.method === 'POST').length, 0);
      assert.equal(sys.files.has(`${ROOT}/${RUN_LOG}`), false);
    });
  }

  it('opens a brief only to hand off or carry', async () => {
    const { io, err } = capture();
    assert.equal(await handoff(repo([]), io, ['--record', '--disposition', 'own-work', '--reason', 'r', '--open-brief', 'b.md']), 1);
    assert.match(err[0] ?? '', /--open-brief goes with --disposition handed-off or carrying, not "own-work"/);
  });

  it('asks git in the repository, reading the base copy at the remote default', async () => {
    const sys = repo(['.github/workflows/ci.yml']);
    assert.equal(await handoff(sys, capture().io, ['--assert-fresh']), 1);
    const git = sys.calls.filter((call) => call.command === 'git');
    assert.deepEqual(git.find((call) => call.args[0] === 'symbolic-ref'), { command: 'git', args: ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], cwd: ROOT });
    assert.deepEqual(git.find((call) => call.args[0] === 'show'), { command: 'git', args: ['show', 'origin/main:.github/niyam.json'], cwd: ROOT });
    assert.deepEqual(git.find((call) => call.args[1] === '--abbrev-ref'), { command: 'git', args: ['rev-parse', '--abbrev-ref', 'HEAD'], cwd: ROOT });
    // A remote default git cannot name, or names as nothing, is origin/main.
    for (const head of [{ code: 1, stdout: 'origin/trunk\n', stderr: '' }, { code: 0, stdout: '\n', stderr: '' }]) {
      const shows: string[] = [];
      sys.execOverride = (call) => {
        if (call.args[0] === 'symbolic-ref') return head;
        if (call.args[0] === 'show') shows.push(call.args[1] ?? '');
        return gits.get(sys)?.(call);
      };
      await handoff(sys, capture().io, ['--assert-fresh']);
      assert.deepEqual([...new Set(shows)], ['origin/main:.github/niyam.json']);
    }
  });

  it("reads no base copy git failed to show, even with text on its output", async () => {
    const sys = repo(['src/a.ts'], { plumbing: ['.github/workflows/'] });
    sys.execOverride = (call) => (call.args[0] === 'show' ? { code: 128, stdout: JSON.stringify({ handoff: { plumbing: ['src/'] } }), stderr: '' } : gits.get(sys)?.(call));
    assert.equal(await handoff(sys, capture().io, ['--assert-fresh']), 0);
    assert.deepEqual(logged(sys).map((one) => one.disposition), ['gate-skipped']);
  });

  for (const [name, failing, message] of [
    ['the branch', 'rev-parse --abbrev-ref HEAD', 'git cannot tell the branch'],
    ['where the branch left the base', 'merge-base origin/main HEAD', 'git cannot tell where this branch left origin/main'],
    ['the head commit', 'rev-parse HEAD', 'git cannot tell the head commit'],
  ] as const) {
    it(`says git could not tell ${name}`, async () => {
      const sys = repo([]);
      sys.execOverride = (call) => (call.args.join(' ') === failing ? { code: 128, stdout: '', stderr: 'bad' } : gits.get(sys)?.(call));
      await assert.rejects(handoff(sys, capture().io, ['--detect']), { message });
    });
  }

  it('counts no changed file when the branch changes none', async () => {
    const { out, io } = capture();
    assert.equal(await handoff(repo([]), io, ['--detect']), 0);
    assert.equal((JSON.parse(out.join('\n')) as { changedFiles: number }).changedFiles, 0);
  });

  it('records into .tmp/push, says what it recorded, and keeps every brief named', async () => {
    const sys = repo(['.github/workflows/ci.yml']);
    const { io, out } = capture();
    assert.equal(await handoff(sys, io, ['--record', '--disposition', 'own-work', '--reason', 'r', '--brief', '#8']), 0);
    assert.ok(sys.dirs.includes(`${ROOT}/.tmp/push`));
    const [recorded] = logged(sys) as [Entry];
    assert.deepEqual(recorded, { ts: recorded.ts, callSite: 'push-skill', branch: 'feature/a', baseRef: 'origin/main', baseSha: BASE, headSha: HEAD, triggers: ['plumbing-edit'], disposition: 'own-work', reason: 'r', briefs: ['#8'], spawned: 'n/a' });
    assert.deepEqual(JSON.parse(out.join('\n')), { recorded, runLog: RUN_LOG });
    sys.files.set(`${ROOT}/b.md`, draft());
    sys.route('POST', `${REPO}/issues`, { status: 201, json: { number: 9, id: 900, html_url: 'u' } });
    assert.equal(await handoff(sys, io, ['--record', '--disposition', 'handed-off', '--reason', 'r', '--brief', '#8', '--open-brief', 'b.md']), 0);
    assert.deepEqual(logged(sys).at(-1)?.briefs, ['#8', '#9']);
  });

  it('refuses in full, naming the template, and records the refusal with no brief', async () => {
    const sys = repo(['.github/workflows/ci.yml']);
    const { io, err } = capture();
    assert.equal(await handoff(sys, io, ['--record', '--disposition', 'handed-off', '--reason', 'r']), 0);
    assert.equal(await handoff(sys, io, ['--assert-fresh']), 1);
    assert.deepEqual(err, [
      '✗ handoff: "handed-off" was declared with no --brief; write one from docs/brief.md and open it with --open-brief <draft.md>',
      '  what fired: niyam handoff --detect --base origin/main',
      '  then declare: niyam handoff --record --base origin/main --disposition <own-work|handed-off|carrying|dismissed> --reason "..."',
    ]);
    const refused = logged(sys).at(-1) as Entry;
    assert.deepEqual({ ...refused, ts: '' }, { ts: '', callSite: 'pre-push-hook', branch: 'feature/a', baseRef: 'origin/main', baseSha: BASE, headSha: HEAD, triggers: ['plumbing-edit'], disposition: 'gate-refused', reason: err[0]?.slice('✗ handoff: '.length), briefs: [], spawned: 'n/a' });
  });

  it('refuses a blocking brief closed by a commit this branch does not have', async () => {
    const sys = repo(['.github/workflows/ci.yml'], { plumbing: ['.github/workflows/'] });
    const body = briefToIssue(draft({ blocking: 'yes' }), 'T').body;
    sys.files.set(`${ROOT}/${RUN_LOG}`, `${JSON.stringify(entry({ disposition: 'handed-off', briefs: ['#9'] }))}\n`);
    sys
      .route('GET', `${REPO}/issues/9`, { status: 200, json: { number: 9, state: 'closed', state_reason: 'completed', type: { name: 'Brief' }, body } })
      .route('GET', `${REPO}/issues/9/timeline?per_page=100&page=1`, {
        status: 200,
        json: [{ event: 'cross-referenced', source: { issue: { number: 10, repository_url: `https://api.github.com${REPO}`, pull_request: { merged_at: '2026-11-14' } } } }],
      })
      .route('GET', REPO, { status: 200, json: { owner: { login: 'example-org', type: 'Organization' }, default_branch: 'main' } })
      .route('GET', `${REPO}/pulls/10`, { status: 200, json: { body: 'Fixes #9', merged_at: '2026-11-14', merge_commit_sha: 'd'.repeat(40), base: { ref: 'main' } } });
    const { io, err } = capture();
    assert.equal(await handoff(sys, io, ['--assert-fresh']), 1);
    assert.match(err[0] ?? '', /#9 was closed by ddddddd, which is not in this branch's history/);
  });

  it("lints a resolved brief's missing path as removed when a commit in this history removed it", async () => {
    const sys = repo(['src/a.ts']);
    sys.files.set(`${ROOT}/b.md`, draft({ status: 'resolved', 'resolved-by': FIX, 'blamed-paths': '\n  - gone.sh' }));
    const { io, err } = capture();
    assert.equal(await brief(sys, io, ['--lint', 'b.md']), 1);
    assert.deepEqual(err, ['✗ a new brief is `status: open`']);
  });

  it('lints a draft with no frontmatter naming the template, and every problem of one that does not lint', async () => {
    const sys = repo(['.github/workflows/ci.yml']);
    sys.files.set(`${ROOT}/b.md`, '# no frontmatter\n');
    const { io, err } = capture();
    assert.equal(await brief(sys, io, ['--lint', 'b.md']), 1);
    assert.deepEqual(err, ['✗ no YAML frontmatter; start the file from docs/brief.md']);
    err.length = 0;
    assert.equal(await handoff(sys, io, ['--record', '--disposition', 'handed-off', '--reason', 'r', '--open-brief', 'b.md']), 1);
    assert.deepEqual(err, ['✗ b.md: no YAML frontmatter; start the file from docs/brief.md', 'no issue was opened']);
    err.length = 0;
    sys.files.set(`${ROOT}/b.md`, draft({ slug: '', blocking: 'maybe' }));
    assert.equal(await brief(sys, io, ['b.md']), 1);
    assert.deepEqual(err, ['✗ b.md: frontmatter `slug` is empty; frontmatter `blocking` must be yes or no (got "maybe"): an unreadable value would quietly downgrade a blocker', 'no issue was opened']);
  });

  it('adds a brief to no board when the project named is not text', async () => {
    const sys = repo(['.github/workflows/ci.yml'], { plumbing: ['.github/workflows/'] }, { project: 5 });
    sys.files.set(`${ROOT}/b.md`, draft());
    sys.route('POST', `${REPO}/issues`, { status: 201, json: { number: 9, id: 900, html_url: 'u' } });
    const { io, out } = capture();
    assert.equal(await brief(sys, io, ['b.md']), 0);
    assert.deepEqual([out, sys.requests.map((one) => one.method)], [['✓ opened #9: u'], ['POST']]);
  });

  it('opens a carried brief that blames a file the branch changed, and no handed-off one', async () => {
    const changed = ['.github/workflows/ci.yml', 'tools/lint.sh'];
    const carried = repo(changed);
    carried.files.set(`${ROOT}/b.md`, draft({}, '## What I verified\nx\n## Why I did not hand off\ny'));
    carried.route('POST', `${REPO}/issues`, { status: 201, json: { number: 9, id: 900, html_url: 'u' } });
    assert.equal(await handoff(carried, capture().io, ['--record', '--disposition', 'carrying', '--reason', 'r', '--open-brief', 'b.md']), 0);
    assert.deepEqual(logged(carried).map((one) => [one.disposition, one.briefs]), [['carrying', ['#9']]]);
    for (const args of [['handoff', '--record', '--disposition', 'handed-off', '--reason', 'r', '--open-brief', 'b.md'], ['brief', 'b.md']]) {
      const sys = repo(changed);
      sys.files.set(`${ROOT}/b.md`, draft());
      const { io, err } = capture();
      assert.equal(await (args[0] === 'brief' ? brief(sys, io, args.slice(1)) : handoff(sys, io, args.slice(1))), 1);
      assert.match(err[0] ?? '', /blamed path is in this branch's own diff: tools\/lint.sh/);
      assert.deepEqual(sys.requests, []);
    }
  });
});

describe('brief', () => {
  it('lints a draft for this branch', async () => {
    const sys = repo(['src/a.ts']);
    sys.files.set(`${ROOT}/b.md`, draft());
    const { io, out, err } = capture();
    assert.equal(await brief(sys, io, ['--lint', 'b.md']), 0);
    assert.deepEqual(out, ['✓ b.md is a brief this branch can open']);
    sys.files.set(`${ROOT}/b.md`, draft({ 'blamed-paths': ' src/a.ts' }));
    assert.equal(await brief(sys, io, ['--lint', 'b.md']), 1);
    assert.deepEqual(err, ["✗ blamed path does not exist in this tree: src/a.ts", "✗ blamed path is in this branch's own diff: src/a.ts; a file you changed cannot be handed off: revert the edit, or record --disposition carrying"]);
    assert.equal(await brief(sys, io, ['--lint', '../b.md']), 1);
    assert.equal(await brief(sys, io, ['--lint', 'gone.md']), 1);
    assert.match(err.at(-1) ?? '', /no brief draft in the repository at gone.md/);
  });

  it('lints no file for a draft outside the repository, even one named like its absence', async () => {
    const sys = repo(['src/a.ts']);
    sys.files.set(`${ROOT}/null`, draft());
    const { io, err } = capture();
    assert.equal(await brief(sys, io, ['--lint', '../b.md']), 1);
    assert.deepEqual(err, ['✗ no brief draft in the repository at ../b.md']);
  });
});

describe('handoff behind a link', () => {
  it('refuses to record or gate where .tmp/push, .tmp or the log leads out of the toplevel, and writes nothing outside', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'niyam-handoff-link-')));
    try {
      const work = join(dir, 'work');
      const away = join(dir, 'away');
      mkdirSync(join(work, '.github'), { recursive: true });
      mkdirSync(away);
      // The fake answers git, as on a branch of example-app; the files are real, so a link is followed.
      const fake = repo(['.github/workflows/ci.yml']);
      writeFileSync(join(work, '.github/niyam.json'), fake.read(`${ROOT}/.github/niyam.json`));
      const sys: Sys = {
        ...realSys(),
        cwd: work,
        env: {},
        exec: (command, args, options) =>
          command === 'git' && args.join(' ') === 'rev-parse --show-toplevel' ? { code: 0, stdout: `${work}\n`, stderr: '' } : fake.exec(command, args, options),
      };
      const record = ['--record', '--disposition', 'own-work', '--reason', 'the workflow is this slice'];
      const links: [string, string, string][] = [
        ['.tmp/push', away, `${join(work, RUN_LOG)}: it leads to ${away}`],
        ['.tmp', away, `${join(work, RUN_LOG)}: it leads to ${away}`],
        [RUN_LOG, join(away, 'log'), `${join(work, RUN_LOG)}: ${join(work, RUN_LOG)} is a link that cannot be followed (ENOENT)`],
      ];
      for (const [at, to, said] of links) {
        rmSync(join(work, '.tmp'), { recursive: true, force: true });
        mkdirSync(join(work, '.tmp/push'), { recursive: true });
        rmSync(join(work, at), { recursive: true, force: true });
        symlinkSync(to, join(work, at));
        for (const args of [record, ['--assert-fresh']]) {
          await assert.rejects(handoff(sys, capture().io, args), { message: new RegExp(`^refused to write ${escape(said)}`) }, `${at} ${args[0]}`);
        }
      }
      // From the command line, as the pre-push hook runs it: the reason is shown and the push refused.
      const seen = capture();
      assert.equal(await cli(['handoff', '--assert-fresh'], seen.io, () => sys), 1);
      assert.match(seen.err.join('\n'), new RegExp(`refused to write ${escape(join(work, RUN_LOG))}`));
      assert.deepEqual(readdirSync(away), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
