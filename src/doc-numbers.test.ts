import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before as beforeAll, describe, it } from 'node:test';

import {
  type DocSettings,
  type RunGh,
  NiyamFileSchema,
  PullListSchema,
  WorkItemLineSchema,
  allocate,
  schema,
  detail,
  wholeNumber,
  basenamesOnRef,
  docNumber,
  docNumberArgs,
  docSettings,
  frozenEntries,
  frozenNumbers,
  ghIn,
  kindNamed,
  listWorkItems,
  loadDocSettings,
  localBasenames,
  numberFromEntry,
  numberFromFilename,
  numberFromName,
  numberFromWorkItemTitle,
  prClaimedNumbers,
  reserveDocNumber,
} from './doc-numbers.ts';
import { capture } from './fake.test.ts';
import { hermeticGitEnv, maskProcessGitEnv, removeFixtureRoot } from './hermetic-git.ts';
import { realSys } from './sys.ts';
import type { ExecResult, Sys } from './types.ts';

const RAW = {
  reservations: 'refs/example/{kind}-reservations/',
  kinds: {
    adr: { dir: 'docs/adr', citation: 'ADR', frontmatterKey: 'adr', relationships: { 'docs/adr': ['supersedes'] } },
    rfc: { dir: 'docs/rfcs', citation: 'RFC', relationships: { 'docs/rfcs': ['parent_rfc'] } },
  },
  workItems: { kind: 'rfc', issueType: 'Work item', label: 'work-item', lastMovedIssue: 20, frozen: { dir: 'docs/work', entries: ['0010-old', '0012-older', '0012-twin'] } },
  history: ['docs/work/', '!docs/work/README.md'],
};
const SETTINGS: DocSettings = docSettings(RAW);
const ADR = SETTINGS.kinds.adr as NonNullable<DocSettings['kinds']['adr']>;
const RFC = SETTINGS.kinds.rfc as NonNullable<DocSettings['kinds']['rfc']>;

/** Every fixture of this file, in one folder removed whole at the end. */
let SCRATCH = '';
beforeAll(() => {
  maskProcessGitEnv();
  SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'niyam-docs-')));
});
after(() => removeFixtureRoot(SCRATCH));

/** A git repository with an origin/main, and these files committed. */
function repo(files: Record<string, string> = {}): { dir: string; git: (...args: string[]) => string; sys: Sys } {
  const dir = mkdtempSync(join(SCRATCH, 'repo-'));
  const git = (...args: string[]): string => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: hermeticGitEnv(), timeout: 30_000 });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.invalid');
  git('config', 'user.name', 'T');
  git('config', 'commit.gpgsign', 'false');
  git('remote', 'add', 'origin', 'https://github.com/example-org/example-app.git');
  for (const [path, text] of Object.entries({ 'README.md': 'x\n', ...files })) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  return { dir, git, sys: { ...realSys(), cwd: dir } };
}

/** A gh that answers by the first words of its arguments; anything else throws. */
function fakeGh(answers: Record<string, string | Error>, calls: string[][] = []): RunGh {
  return (args) => {
    calls.push([...args]);
    const key = Object.keys(answers).find((prefix) => args.join(' ').startsWith(prefix));
    const answer = key === undefined ? new Error(`unexpected gh ${args.join(' ')}`) : answers[key];
    if (answer instanceof Error) throw answer;
    return answer as string;
  };
}

const PR_LIST = 'pr list --state open --limit 100 --json number,files';
const ISSUES = 'api --paginate repos/{owner}/{repo}/issues?state=all&type=Work%20item';
const item = (number: number, title: string) => JSON.stringify({ number, title });
const quietGh = fakeGh({ [PR_LIST]: '[]', [ISSUES]: `${item(30, '0005 — x')}\n` });

describe('docSettings', () => {
  it('reads every part, with defaults for the optional ones', () => {
    assert.equal(RFC.frontmatterKey, 'rfc');
    assert.deepEqual(ADR.relationships, { 'docs/adr': ['supersedes'] });
    assert.equal(SETTINGS.workItems?.lastMovedIssue, 20);
    const bare = docSettings({ reservations: 'refs/x/{kind}/', kinds: { adr: { dir: 'docs/adr', citation: 'ADR' } } });
    assert.deepEqual([bare.history, bare.workItems, bare.kinds.adr?.relationships], [[], undefined, {}]);
    const plain = docSettings({ ...RAW, workItems: { kind: 'rfc', issueType: 'Work item', reserveCommand: 'x reserve' } });
    assert.deepEqual(plain.workItems, { kind: 'rfc', issueType: 'Work item', reserveCommand: 'x reserve' });
  });

  for (const [change, message] of [
    [{ reservations: 'refs/x/' }, /reservations must be a ref prefix/],
    [{ reservations: 'x/{kind}/' }, /reservations must be a ref prefix/],
    [{ reservations: 3 }, /reservations must be one line/],
    [{ kinds: {} }, /must name at least one kind/],
    [{ kinds: [] }, /kinds must be an object/],
    [{ kinds: { ADR: RAW.kinds.adr } }, /"ADR" must be a lower-case word/],
    [{ kinds: { adr: { ...RAW.kinds.adr, dir: '../x' } } }, /dir must be a path in the repository/],
    [{ kinds: { adr: { ...RAW.kinds.adr, citation: 'adr' } } }, /citation must be one line/],
    [{ kinds: { adr: { ...RAW.kinds.adr, extra: 1 } } }, /unknown key "extra"/],
    [{ kinds: { adr: { ...RAW.kinds.adr, relationships: { 'docs/adr': 'supersedes' } } } }, /must be a list/],
    [{ kinds: { adr: { ...RAW.kinds.adr, relationships: { 'docs/adr': ['a-b'] } } } }, /must be one line/],
    [{ workItems: { ...RAW.workItems, kind: 'prd' } }, /names "prd", which "kinds" does not have/],
    [{ workItems: { ...RAW.workItems, lastMovedIssue: 0 } }, /lastMovedIssue must be an issue number/],
    [{ workItems: { ...RAW.workItems, frozen: { dir: 'docs/work', entries: ['old'] } } }, /entries\[0\] must be one line/],
    [{ workItems: { ...RAW.workItems, frozen: { dir: 'docs/work' } } }, /entries must be a list/],
    [{ workItems: { ...RAW.workItems, frozen: { dir: 'docs/work', entries: [], more: 1 } } }, /unknown key "more"/],
    [{ workItems: 'rfc' }, /workItems must be an object/],
    [{ history: ['/etc'] }, /history\[0\] must be one line/],
    [{ other: 1 }, /unknown key "other"/],
  ] as const) {
    it(`refuses ${JSON.stringify(change)}`, () => assert.throws(() => docSettings({ ...RAW, ...change }), message));
  }

  it('refuses settings that are not an object', () => assert.throws(() => docSettings(null), /"docNumbers" must be an object/));
});

describe('loadDocSettings', () => {
  it('reads the entry inline, or the file it names', () => {
    const inline = repo({ '.github/niyam.json': JSON.stringify({ docNumbers: RAW }) });
    assert.deepEqual(loadDocSettings(inline.sys, inline.dir), SETTINGS);
    const named = repo({ '.github/niyam.json': JSON.stringify({ docNumbers: 'config/docs.json' }), 'config/docs.json': JSON.stringify(RAW) });
    assert.deepEqual(loadDocSettings(named.sys, named.dir), SETTINGS);
  });

  it('refuses to guess: no settings file, no entry, or a named file that is not there', () => {
    const none = repo();
    assert.throws(() => loadDocSettings(none.sys, none.dir), /\.github\/niyam\.json not found/);
    const empty = repo({ '.github/niyam.json': '{}' });
    assert.throws(() => loadDocSettings(empty.sys, empty.dir), /has no "docNumbers"/);
    const missing = repo({ '.github/niyam.json': JSON.stringify({ docNumbers: 'node_modules/x/docs.json' }) });
    assert.throws(() => loadDocSettings(missing.sys, missing.dir), /names node_modules\/x\/docs\.json, which is not there \(run pnpm install\?\)/);
    const outside = repo({ '.github/niyam.json': JSON.stringify({ docNumbers: '../docs.json' }) });
    assert.throws(() => loadDocSettings(outside.sys, outside.dir), /must be a path in the repository/);
  });
});

describe('names and numbers', () => {
  it('finds a kind in any case, and nothing else', () => {
    assert.equal(kindNamed(SETTINGS, 'ADR'), ADR);
    assert.equal(kindNamed(SETTINGS, 'prd'), undefined);
    assert.equal(kindNamed(SETTINGS, undefined), undefined);
    assert.equal(kindNamed(SETTINGS, 'toString'), undefined);
  });

  it('reads a document file name, a numbered entry, and either by path', () => {
    assert.equal(numberFromFilename('0057-replay.md'), '0057');
    assert.equal(numberFromFilename('_TEMPLATE.adr.md'), null);
    assert.equal(numberFromFilename('0057-replay.txt'), null);
    assert.equal(numberFromEntry('0105-tooling-cleanup'), '0105');
    assert.equal(numberFromEntry('README.md'), null);
    assert.equal(numberFromName('docs/work/0110-y'), '0110');
    assert.equal(numberFromName('0110-y.md'), '0110');
  });

  it('reads the work number a Work item title opens with, never a date or a citation', () => {
    for (const [title, number] of [
      ['0150 — setup installs it', '0150'],
      ['  0150 — leading space', '0150'],
      ['0145-2026-plan', '0145'],
      ['0150-slug', '0150'],
      ['2026-11-05 a dated note', null],
      ['01500 five digits', null],
      ['0066 — RFC-0060 Phase 0', '0066'],
      ['Phase 0 of 0066', null],
      ['2026-11-055', '2026'],
    ] as const)
      assert.equal(numberFromWorkItemTitle(title), number, title);
  });

  it('gives the frozen folders, by path and by distinct number, to the Work items kind only', () => {
    assert.deepEqual(frozenEntries(SETTINGS, 'rfc'), ['docs/work/0010-old', 'docs/work/0012-older', 'docs/work/0012-twin']);
    assert.deepEqual(frozenNumbers(SETTINGS, 'rfc'), ['0010', '0012']);
    assert.deepEqual(frozenNumbers(SETTINGS, 'adr'), []);
    assert.deepEqual(frozenNumbers(docSettings({ ...RAW, workItems: { kind: 'rfc', issueType: 'Work item' } }), 'rfc'), []);
  });
});

describe('the trees', () => {
  it('lists numbered documents here and on a ref, and says when a ref cannot be read', () => {
    const { dir, sys } = repo({ 'docs/adr/0001-a.md': 'a', 'docs/adr/_TEMPLATE.adr.md': 't', 'docs/adr/notes.md': 'n' });
    writeFileSync(join(dir, 'docs/adr/0002-b.md'), 'b');
    assert.deepEqual(localBasenames(sys, ADR, dir), ['0001-a.md', '0002-b.md']);
    assert.deepEqual(basenamesOnRef(sys, ADR, 'origin/main', dir), ['0001-a.md']);
    assert.equal(basenamesOnRef(sys, ADR, 'origin/nothing', dir), null);
    assert.deepEqual(localBasenames(sys, RFC, dir), []);
  });
});

describe('detail and wholeNumber', () => {
  it('says what an error says, and survives one whose text cannot be read', () => {
    assert.equal(detail(new Error('boom')), 'boom');
    assert.equal(detail('plain'), 'plain');
    assert.equal(detail({ toString: () => { throw new Error('hostile'); } }), 'an error whose text could not be read');
  });
  it('reads whole numbers only', () => {
    assert.equal(wholeNumber('0042'), 42);
    assert.throws(() => wholeNumber(''), /"" is not a whole number/);
    assert.throws(() => wholeNumber('1e3'), /is not a whole number/);
  });
});

describe('the schemas', () => {
  it('validate the Standard Schema way: the value, or the issue', () => {
    assert.deepEqual(WorkItemLineSchema['~standard'].validate({ number: 7, title: 't' }), { value: { number: 7, title: 't' } });
    assert.deepEqual(WorkItemLineSchema['~standard'].validate({ number: 7.5, title: 't' }), { issues: [{ message: 'not {number, title}' }] });
    assert.deepEqual(PullListSchema['~standard'].validate({}), { issues: [{ message: '`gh pr list` returned an unexpected shape' }] });
    assert.equal(schema(Number)['~standard'].vendor, 'niyam');
  });
  it('read niyam.json only as an object', () => {
    assert.deepEqual(NiyamFileSchema.parse({ docNumbers: 'x.json', other: 1 }), { docNumbers: 'x.json' });
    assert.throws(() => NiyamFileSchema.parse([]), /must be an object/);
  });
  it('keep a pull request with odd entries, listing only real paths', () => {
    assert.deepEqual(PullListSchema.parse([null, { number: 3, files: [{ path: 'a' }, null, { path: 1 }] }]), [
      { number: undefined, paths: [], listed: 0 },
      { number: 3, paths: ['a'], listed: 3 },
    ]);
  });
});

describe('ghIn', () => {
  it("gives gh's output, from the repository, and throws with its error", () => {
    const calls: { args: readonly string[]; cwd: string | undefined }[] = [];
    const exec = (code: number, stderr: string): Sys => ({
      ...realSys(),
      exec: (_command: string, args: readonly string[], options?: { cwd?: string }): ExecResult => {
        calls.push({ args, cwd: options?.cwd });
        return { code, stdout: 'out\n', stderr };
      },
    });
    assert.equal(ghIn(exec(0, ''), '/repo')(['pr', 'list']), 'out\n');
    assert.deepEqual(calls[0], { args: ['pr', 'list'], cwd: '/repo' });
    assert.throws(() => ghIn(exec(1, 'no auth\n'), '/repo')(['x']), /^Error: no auth$/);
    assert.throws(() => ghIn(exec(4, ''), '/repo')(['x']), /gh exited 4/);
  });
});

describe('prClaimedNumbers', () => {
  const pr = (number: number, ...paths: string[]) => ({ number, files: paths.map((path) => ({ path })) });
  const claims = (pulls: unknown, main: string[] = [], more: Record<string, string | Error> = {}) => prClaimedNumbers(ADR, main, fakeGh({ [PR_LIST]: JSON.stringify(pulls), ...more }));

  it('counts a document a PR adds, not one it edits or anything outside the folder itself', () => {
    const got = claims([pr(1, 'docs/adr/0060-new.md', 'docs/adr/0001-old.md', 'docs/adr/sub/0061-x.md', 'docs/adrs/0062-x.md', 'docs/adr/notes.md', 'src/0063-x.md')], ['0001-old.md']);
    assert.deepEqual([[...got.numbers], got.warnings], [['0060'], []]);
  });

  it('warns rather than throws when gh fails, answers non-JSON, or answers another shape', () => {
    assert.match(prClaimedNumbers(ADR, [], fakeGh({})).warnings[0] ?? '', /could not read open PRs/);
    assert.match(prClaimedNumbers(ADR, [], fakeGh({ [PR_LIST]: 'nope' })).warnings[0] ?? '', /^`gh pr list` returned output that is not JSON/);
    assert.match(claims({ pulls: [] }).warnings[0] ?? '', /unexpected shape/);
  });

  it('tolerates malformed entries', () => {
    const got = claims([null, 3, { number: 2 }, { number: 3, files: [null, { path: 4 }, { path: 'docs/adr/0070-x.md' }] }]);
    assert.deepEqual([[...got.numbers], got.warnings], [['0070'], []]);
  });

  it('warns when the list fills the scan limit', () => {
    const got = claims(Array.from({ length: 100 }, (_, i) => pr(i)));
    assert.match(got.warnings[0] ?? '', /100 open PRs listed \(the scan limit\)/);
  });

  it('pages a PR at the page cap and finds a claim past it; a PR below the cap is not paged', () => {
    const big = pr(9, ...Array.from({ length: 100 }, (_, i) => `src/f${String(i)}.ts`));
    const calls: string[][] = [];
    const got = prClaimedNumbers(ADR, [], fakeGh({ [PR_LIST]: JSON.stringify([big, pr(8, 'a.ts')]), 'api repos/{owner}/{repo}/pulls/9/files': 'src/a.ts\ndocs/adr/0080-deep.md\n' }, calls));
    assert.deepEqual([[...got.numbers], got.warnings], [['0080'], []]);
    assert.deepEqual(calls.map((call) => call.join(' ')), [PR_LIST, 'api repos/{owner}/{repo}/pulls/9/files --paginate --jq .[].filename']);
  });

  it('keeps the listed page and warns when paging fails, or the API ceiling is reached', () => {
    const big = pr(9, 'docs/adr/0081-x.md', ...Array.from({ length: 99 }, (_, i) => `src/f${String(i)}.ts`));
    const failed = claims([big], [], { 'api repos': new Error('down') });
    assert.deepEqual([...failed.numbers], ['0081']);
    assert.match(failed.warnings[0] ?? '', /PR #9 has 100\+ files .* \(`gh api` failed\) — any claim past its first 100 listed files was NOT considered/);
    const ceiling = claims([big], [], { 'api repos': `${Array.from({ length: 3000 }, (_, i) => `f${String(i)}`).join('\n')}\n` });
    assert.match(ceiling.warnings[0] ?? '', /the API stops at 3000 files/);
    const short = claims([big], [], { 'api repos': `${Array.from({ length: 2999 }, (_, i) => `f${String(i)}`).join('\n')}\n` });
    assert.deepEqual(short.warnings, []);
    const nameless = claims([{ files: big.files }]);
    assert.match(nameless.warnings[0] ?? '', /\(no PR number\)/);
  });
});

describe('listWorkItems', () => {
  const work = SETTINGS.workItems as NonNullable<DocSettings['workItems']>;
  it('reads every Work item with one paged call, skipping blank lines', () => {
    const calls: string[][] = [];
    const got = listWorkItems(work, fakeGh({ [ISSUES]: `${item(31, '0150 — a')}\n\n${item(32, 'no number')}\n` }, calls));
    assert.deepEqual(got, { items: [{ number: 31, title: '0150 — a', workNumber: '0150' }, { number: 32, title: 'no number', workNumber: null }], warnings: [] });
    assert.deepEqual(calls, [['api', '--paginate', 'repos/{owner}/{repo}/issues?state=all&type=Work%20item&per_page=100', '--jq', '.[] | select(.type.name == "Work item") | {number, title}']]);
  });

  for (const [answer, message] of [
    [new Error('offline'), /could not read Work item issues/],
    ['{', /not JSON/],
    [`${JSON.stringify({ number: '1', title: 'x' })}\n`, /unexpected shape/],
    ['null\n', /unexpected shape/],
    ['\n', /came back empty/],
  ] as const) {
    it(`gives no items and a warning for ${String(answer).slice(0, 20)}`, () => {
      const got = listWorkItems(work, fakeGh({ [ISSUES]: answer }));
      assert.deepEqual(got.items, []);
      assert.match(got.warnings[0] ?? '', message);
    });
  }
});

describe('reserveDocNumber', () => {
  it('previews one past every number any ref, reservation or worktree holds, and alsoTaken', () => {
    const { dir, git, sys } = repo({ 'docs/rfcs/0007-a.md': 'a' });
    assert.equal(reserveDocNumber(sys, dir, SETTINGS, RFC, { dryRun: true }), '0008');
    git('switch', '-q', '-c', 'side');
    writeFileSync(join(dir, 'docs/rfcs/0011-side.md'), 's');
    git('add', '-A');
    git('commit', '-q', '-m', 'side');
    git('switch', '-q', 'main');
    assert.equal(reserveDocNumber(sys, dir, SETTINGS, RFC, { dryRun: true }), '0012');
    git('update-ref', 'refs/example/rfc-reservations/0020', 'HEAD');
    assert.equal(reserveDocNumber(sys, dir, SETTINGS, RFC, { dryRun: true }), '0021');
    const linked = join(dir, '..', `${dir.split('/').at(-1) as string}-linked`);
    git('worktree', 'add', '-q', linked);
    writeFileSync(join(linked, 'docs/rfcs/0030-draft.md'), 'd');
    assert.equal(reserveDocNumber(sys, dir, SETTINGS, RFC, { dryRun: true }), '0031');
    assert.equal(reserveDocNumber(sys, dir, SETTINGS, RFC, { dryRun: true, alsoTaken: [44] }), '0045');
    assert.equal(reserveDocNumber(sys, dir, SETTINGS, ADR, { dryRun: true }), '0001');
  });

  it('claims a number for good, so the next claim goes past it, and a preview claims nothing', () => {
    const { dir, git, sys } = repo({ 'docs/adr/0003-a.md': 'a' });
    assert.equal(reserveDocNumber(sys, dir, SETTINGS, ADR), '0004');
    assert.equal(reserveDocNumber(sys, dir, SETTINGS, ADR), '0005');
    assert.equal(reserveDocNumber(sys, dir, SETTINGS, ADR, { dryRun: true }), '0006');
    assert.equal(git('for-each-ref', '--format=%(refname)', 'refs/example/'), 'refs/example/adr-reservations/0004\nrefs/example/adr-reservations/0005\n');
  });

  it('previews in a repository with no commit, and reports git failing', () => {
    const dir = mkdtempSync(join(SCRATCH, 'bare-'));
    execFileSync('git', ['init', '-q'], { cwd: dir, env: hermeticGitEnv(), timeout: 30_000 });
    const sys = { ...realSys(), cwd: dir };
    assert.equal(reserveDocNumber(sys, dir, SETTINGS, ADR, { dryRun: true }), '0001');
    assert.throws(() => reserveDocNumber(sys, dir, SETTINGS, ADR), /git rev-parse HEAD/);
    assert.throws(() => reserveDocNumber(sys, join(dir, 'none'), SETTINGS, ADR, { dryRun: true }), /git log --all/);
  });

  it('passes a number a competitor took meanwhile, silently', () => {
    const { dir, sys } = repo();
    const real = realSys();
    const racing: Sys = {
      ...sys,
      exec: (command, args, options) => {
        // The competitor wins 0001 between the scan and the claim.
        if (args.includes('update-ref') && args.includes('refs/example/adr-reservations/0001')) real.exec('git', ['update-ref', 'refs/example/adr-reservations/0001', 'HEAD'], { cwd: dir });
        return real.exec(command, args, options);
      },
    };
    const warned: string[] = [];
    assert.equal(reserveDocNumber(racing, dir, SETTINGS, ADR, { warn: (line) => warned.push(line) }), '0002');
    assert.deepEqual(warned, []);
  });

  it('skips a candidate it cannot claim with a warning, and gives up with the first error after three', () => {
    const { dir, sys } = repo();
    const real = realSys();
    let refused = 0;
    const stuck = (limit: number): Sys => ({
      ...sys,
      exec: (command, args, options) => {
        if (args.includes('update-ref') && refused < limit) {
          refused += 1;
          return { code: 128, stdout: '', stderr: `fatal: cannot lock ref ${String(refused)}\n` };
        }
        return real.exec(command, args, options);
      },
    });
    const warned: string[] = [];
    assert.equal(reserveDocNumber(stuck(2), dir, SETTINGS, ADR, { warn: (line) => warned.push(line) }), '0003');
    assert.deepEqual(warned, ['ADR 0001 could not be claimed; skipping it.\nfatal: cannot lock ref 1', 'ADR 0002 could not be claimed; skipping it.\nfatal: cannot lock ref 2']);
    refused = 0;
    assert.throws(() => reserveDocNumber(stuck(4), dir, SETTINGS, ADR), /could not claim ADR 0004: fatal: cannot lock ref 1/);
  });

  it('says so when the number space is spent', () => {
    const { dir, sys } = repo({ 'docs/adr/9999-last.md': 'z' });
    assert.throws(() => reserveDocNumber(sys, dir, SETTINGS, ADR), /ADR number space exhausted/);
  });

  it('gives competing processes in linked worktrees distinct numbers', async () => {
    const { dir, git } = repo({ 'docs/rfcs/0007-a.md': 'a' });
    const linked = join(dir, '..', `${dir.split('/').at(-1) as string}-w2`);
    git('worktree', 'add', '-q', linked);
    const module = new URL('./doc-numbers.ts', import.meta.url).href;
    const sysModule = new URL('./sys.ts', import.meta.url).href;
    const one = (cwd: string) =>
      new Promise<string>((resolve, reject) => {
        const code = `import { reserveDocNumber, docSettings } from ${JSON.stringify(module)}; import { realSys } from ${JSON.stringify(sysModule)}; const s = docSettings(${JSON.stringify(RAW)}); process.stdout.write(reserveDocNumber({ ...realSys(), cwd: ${JSON.stringify(cwd)} }, ${JSON.stringify(cwd)}, s, s.kinds.rfc));`;
        const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'pipe'], env: hermeticGitEnv(), timeout: 30_000 });
        let out = '';
        let err = '';
        child.stdout.on('data', (data: Buffer) => (out += String(data)));
        child.stderr.on('data', (data: Buffer) => (err += String(data)));
        child.once('close', (exit) => (exit === 0 ? resolve(out) : reject(new Error(err))));
      });
    const got = await Promise.all([dir, linked, dir, linked, dir, linked].map(one));
    assert.equal(new Set(got).size, 6, got.join(','));
    assert.deepEqual([...got].sort(), ['0008', '0009', '0010', '0011', '0012', '0013']);
  });
});

describe('allocate', () => {
  it('refuses rather than guess when main cannot be read', () => {
    const { dir, sys } = repo();
    const got = allocate(sys, dir, SETTINGS, ADR, { gh: quietGh, ref: 'origin/none' });
    assert.deepEqual(got, { ok: false, error: 'could not read `origin/none` — fetch it first (`git fetch origin main`). Allocating without it would hand out a number main may already use.' });
  });

  it('allocates past main, this tree, open PRs, Work item titles and the frozen folders', () => {
    const { dir, sys } = repo({ 'docs/rfcs/0003-a.md': 'a', 'docs/adr/0002-a.md': 'a' });
    assert.deepEqual(allocate(sys, dir, SETTINGS, RFC, { gh: quietGh }), { ok: true, next: '0013', sources: { main: 1, local: 1, pullRequests: 0, workItems: 1, frozen: 2 }, warnings: [] });
    const busy = fakeGh({ [PR_LIST]: JSON.stringify([{ number: 4, files: [{ path: 'docs/rfcs/0040-pr.md' }] }]), [ISSUES]: `${item(31, '0050 — w')}\n${item(32, '0050 — twin')}\n` });
    assert.deepEqual(allocate(sys, dir, SETTINGS, RFC, { gh: busy }), { ok: true, next: '0051', sources: { main: 1, local: 1, pullRequests: 1, workItems: 1, frozen: 2 }, warnings: [] });
    // ADRs read no issues and have no frozen floor.
    const calls: string[][] = [];
    assert.deepEqual(allocate(sys, dir, SETTINGS, ADR, { gh: fakeGh({ [PR_LIST]: '[]' }, calls) }), { ok: true, next: '0003', sources: { main: 1, local: 1, pullRequests: 0, workItems: 0, frozen: 0 }, warnings: [] });
    assert.equal(calls.length, 1);
  });

  it('previews with warnings when GitHub cannot be read, and refuses to reserve then, naming every cause', () => {
    const { dir, git, sys } = repo({ 'docs/rfcs/0003-a.md': 'a' });
    const blind = allocate(sys, dir, SETTINGS, RFC, { gh: fakeGh({}) });
    assert.equal(blind.ok && blind.next, '0013');
    assert.equal(blind.ok && blind.warnings.length, 2);
    const refused = allocate(sys, dir, SETTINGS, RFC, { gh: fakeGh({}), reserve: true });
    assert.equal(refused.ok, false);
    assert.match(refused.ok ? '' : refused.error, /^refusing to RESERVE while the GitHub scan is incomplete .*could not read open PRs.*; could not read Work item issues/);
    const offline = allocate(sys, dir, SETTINGS, RFC, { gh: fakeGh({}), offline: true });
    assert.deepEqual(offline.ok && offline.warnings, ['--offline: numbers claimed by unmerged PRs were NOT considered', '--offline: numbers in Work item issue titles were NOT considered']);
    const adrOffline = allocate(sys, dir, SETTINGS, ADR, { gh: fakeGh({}), offline: true, reserve: true });
    assert.match(adrOffline.ok ? '' : adrOffline.error, /--offline: numbers claimed by unmerged PRs were NOT considered$/);
    assert.equal(git('for-each-ref', 'refs/example/'), '');
  });

  it('reserves when the scan is complete, and reports the reserver failing', () => {
    const { dir, git, sys } = repo({ 'docs/rfcs/0003-a.md': 'a' });
    const got = allocate(sys, dir, SETTINGS, RFC, { gh: quietGh, reserve: true });
    assert.equal(got.ok && got.next, '0013');
    assert.equal(git('for-each-ref', '--format=%(refname)', 'refs/example/'), 'refs/example/rfc-reservations/0013\n');
    const broken: Sys = { ...sys, exec: (command, args, options) => (args[0] === 'log' ? { code: 128, stdout: '', stderr: 'fatal: bad\n' } : sys.exec(command, args, options)) };
    const failed = allocate(broken, dir, SETTINGS, RFC, { gh: quietGh });
    assert.deepEqual(failed, { ok: false, error: 'could not reserve a RFC number: git log --all --format= --name-only -- docs/rfcs: fatal: bad' });
    const thrown: Sys = { ...sys, exec: (command, args, options) => {
      if (args[0] === 'log') throw 'odd';
      return sys.exec(command, args, options);
    } };
    assert.deepEqual(allocate(thrown, dir, SETTINGS, RFC, { gh: quietGh }), { ok: false, error: 'could not reserve a RFC number: odd' });
  });
});

describe('docNumberArgs', () => {
  it('takes one kind and the flags in any order', () => {
    assert.deepEqual(docNumberArgs(['--json', 'adr', '--reserve']), { kind: 'adr', json: true, offline: false, reserve: true });
    assert.deepEqual(docNumberArgs(['rfc', '--offline']), { kind: 'rfc', json: false, offline: true, reserve: false });
  });
  it('refuses no kind, two kinds, or an unknown option', () => {
    assert.throws(() => docNumberArgs([]), /needs one document kind/);
    assert.throws(() => docNumberArgs(['adr', 'rfc']), /needs one document kind/);
    assert.throws(() => docNumberArgs(['adr', '--dry']), /unknown option "--dry"/);
  });
});

describe('docNumber', () => {
  /** The repository, with settings, and gh answered by `answers`. */
  function cli(answers: Record<string, string>) {
    const made = repo({ '.github/niyam.json': JSON.stringify({ docNumbers: RAW }), 'docs/rfcs/0003-a.md': 'a' });
    const real = realSys();
    const sys: Sys = {
      ...made.sys,
      exec: (command, args, options) => {
        if (command !== 'gh') return real.exec(command, args, options);
        const key = Object.keys(answers).find((prefix) => args.join(' ').startsWith(prefix));
        return key === undefined ? { code: 1, stdout: '', stderr: 'offline' } : { code: 0, stdout: answers[key] as string, stderr: '' };
      },
    };
    return { ...made, sys };
  }

  it('prints the number alone on stdout and where it came from on stderr', () => {
    const { sys } = cli({ [PR_LIST]: '[]', [ISSUES]: `${item(30, '0005 — x')}\n` });
    const rfc = capture();
    assert.equal(docNumber(sys, rfc.io, ['rfc']), 0);
    assert.deepEqual(rfc.out, ['0013']);
    assert.deepEqual(rfc.err, ['→ next free RFC number, against 1 on origin/main, 1 local, 0 claimed by open PRs, 1 in Work item titles, 2 frozen work folder numbers (a preview; --reserve claims it):']);
    const adr = capture();
    assert.equal(docNumber(sys, adr.io, ['ADR', '--reserve']), 0);
    assert.deepEqual([adr.out, adr.err], [['0001'], ['→ next free ADR number, against 0 on origin/main, 0 local, 0 claimed by open PRs, reserved:']]);
  });

  it('gives JSON under --json, and its warnings first otherwise', () => {
    const { sys } = cli({ [PR_LIST]: '[]' });
    const json = capture();
    assert.equal(docNumber(sys, json.io, ['--json', 'adr']), 0);
    assert.deepEqual(JSON.parse(json.out.join('\n')), { kind: 'adr', ok: true, next: '0001', sources: { main: 0, local: 0, pullRequests: 0, workItems: 0, frozen: 0 }, warnings: [] });
    const warned = capture();
    assert.equal(docNumber(sys, warned.io, ['rfc']), 0);
    assert.match(warned.err[0] ?? '', /^⚠️ {2}could not read Work item issues/);
    assert.deepEqual(warned.out, ['0013']);
  });

  it('exits 1 with the allocation error, 2 for a kind the settings do not name', () => {
    const { sys } = cli({});
    const refused = capture();
    assert.equal(docNumber(sys, refused.io, ['rfc', '--reserve']), 1);
    assert.deepEqual(refused.out, []);
    assert.match(refused.err[0] ?? '', /^❌ refusing to RESERVE/);
    const unknown = capture();
    assert.equal(docNumber(sys, unknown.io, ['prd']), 2);
    assert.deepEqual(unknown.err, ['niyam doc-number: no document kind "prd"; .github/niyam.json names adr, rfc']);
  });
});
