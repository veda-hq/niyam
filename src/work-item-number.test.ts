import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before as beforeAll, describe, it } from 'node:test';

import { type Allocation, type DocKind, type RunGh, type WorkItems, docSettings } from './doc-numbers.ts';
import { capture } from './fake.test.ts';
import { hermeticGitEnv, maskProcessGitEnv, removeFixtureRoot } from './hermetic-git.ts';
import { realSys } from './sys.ts';
import type { Sys } from './types.ts';
import { type CheckOptions, checkWorkItemNumbers, planMoves, renumberComment, renumberMarker, unlabelledWorkItems, workItemArgs, workItemNumber } from './work-item-number.ts';

const RESERVATIONS = 'refs/example/{kind}-reservations/';
const KINDS = { adr: { dir: 'docs/adr', citation: 'ADR' }, rfc: { dir: 'docs/rfcs', citation: 'RFC' } };
const LAST_MOVED = 100;
const RAW = {
  reservations: RESERVATIONS,
  kinds: KINDS,
  workItems: { kind: 'rfc', issueType: 'Work item', label: 'work-item', lastMovedIssue: LAST_MOVED, frozen: { dir: 'docs/work', entries: ['0142-old-folder', '0145-another-folder'] } },
};
/** Work items with no label, no moved issues and no frozen folders. */
const BARE = { reservations: RESERVATIONS, kinds: KINDS, workItems: { kind: 'rfc', issueType: 'Work item' } };
const SETTINGS = docSettings(RAW);
const WORK: WorkItems = SETTINGS.workItems ?? assert.fail('no workItems');
const RFC: DocKind = SETTINGS.kinds.rfc ?? assert.fail('no rfc kind');

/** Every fixture of this file is under it, removed whole at the end. */
let SCRATCH = '';
/** A repository with no numbered documents, shared by the tests that need nothing more. */
let PLAIN = '';
beforeAll(() => {
  maskProcessGitEnv();
  SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'niyam-work-item-')));
  PLAIN = fixture();
});
after(() => removeFixtureRoot(SCRATCH));

/** A repository whose origin/main holds `rfcs` under docs/rfcs and `docNumbers` in its .github/niyam.json. */
function fixture(rfcs: readonly string[] = [], docNumbers: unknown = RAW): string {
  const dir = mkdtempSync(join(SCRATCH, 'repo-'));
  const git = (...args: string[]): void => {
    const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8', env: hermeticGitEnv(), timeout: 30_000 });
    assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  };
  mkdirSync(join(dir, 'docs/rfcs'), { recursive: true });
  mkdirSync(join(dir, '.github'));
  writeFileSync(join(dir, 'docs/rfcs/README.md'), '# fixture\n');
  for (const name of rfcs) writeFileSync(join(dir, 'docs/rfcs', name), '# fixture\n');
  writeFileSync(join(dir, '.github/niyam.json'), JSON.stringify({ docNumbers }));
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.invalid');
  git('config', 'user.name', 'T');
  git('config', 'commit.gpgsign', 'false');
  git('add', '-A');
  git('commit', '-q', '-m', 'fixture');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  git('remote', 'add', 'origin', 'https://github.com/example-org/example-app.git');
  return dir;
}

interface Item {
  readonly number: number;
  readonly title: string;
}

const LIST = 'api --paginate repos/{owner}/{repo}/issues?state=all&type=Work%20item&per_page=100 --jq .[] | select(.type.name == "Work item") | {number, title}';
const UNLABELLED = 'api --paginate repos/{owner}/{repo}/issues?state=all&type=Work%20item&per_page=100 --jq .[] | select(.type.name == "Work item") | select(any(.labels[]; .name == "work-item") | not) | .number';
const PRS = 'pr list --state open --limit 100 --json number,files';
const event = (issue: number): string => `api repos/{owner}/{repo}/issues/${String(issue)} --jq {number, title, type: .type.name}`;
const titleRead = (issue: number): string => `api repos/{owner}/{repo}/issues/${String(issue)} --jq .title`;
const commentList = (issue: number): string => `api --paginate repos/{owner}/{repo}/issues/${String(issue)}/comments --jq .[].body`;
const commentCall = (issue: number, body: string): string => `issue comment ${String(issue)} --body ${body}`;
const editCall = (issue: number, title: string): string => `issue edit ${String(issue)} --title ${title}`;
const labelCall = (issue: number): string => `issue edit ${String(issue)} --add-label work-item`;

/** Something thrown that is not an Error. */
function refuse(): never {
  const reason: unknown = 'refused';
  throw reason;
}

/** GitHub as plain data: the Work item list, issues by number, open pulls, comments; every call is logged. */
class GitHub {
  readonly titles = new Map<number, string>();
  readonly types = new Map<number, string | null>();
  readonly listed: number[] = [];
  readonly comments = new Map<number, string[]>();
  readonly calls: string[] = [];
  pulls: unknown = [];
  unlabelled = '';
  /** The call, counted from 1, that fails; 0 for none. */
  failAt = 0;
  private readonly queued = new Map<string, (() => string)[]>();

  constructor(items: readonly Item[], others: readonly (Item & { type: string | null })[] = []) {
    for (const item of items) {
      this.titles.set(item.number, item.title);
      this.types.set(item.number, 'Work item');
      this.listed.push(item.number);
    }
    for (const other of others) {
      this.titles.set(other.number, other.title);
      this.types.set(other.number, other.type);
    }
  }

  /** Answers `call` with these, in turn, before the world does. */
  queue(call: string, ...answers: (() => string)[]): this {
    this.queued.set(call, [...(this.queued.get(call) ?? []), ...answers]);
    return this;
  }

  listing(): string {
    return this.listed.map((number) => `${JSON.stringify({ number, title: this.titles.get(number) })}\n`).join('');
  }

  writes(): string[] {
    return this.calls.filter((call) => call.startsWith('issue '));
  }

  readonly gh: RunGh = (args) => {
    const call = args.join(' ');
    this.calls.push(call);
    if (this.calls.length === this.failAt) throw new Error('injected');
    const queued = this.queued.get(call)?.shift();
    if (queued !== undefined) return queued();
    if (call === LIST) return this.listing();
    if (call === UNLABELLED) return this.unlabelled;
    if (call === PRS) return JSON.stringify(this.pulls);
    const [verb, sub, at] = args;
    const issue = Number(at);
    if (verb === 'issue' && sub === 'comment') {
      this.comments.set(issue, [...(this.comments.get(issue) ?? []), args[4] ?? '']);
      return '';
    }
    if (verb === 'issue' && sub === 'edit' && args[3] === '--title') {
      this.titles.set(issue, args[4] ?? '');
      return '';
    }
    if (verb === 'issue' && sub === 'edit' && args[3] === '--add-label') return '';
    const read = /^api repos\/\{owner\}\/\{repo\}\/issues\/(\d+) --jq (.*)$/.exec(call);
    const title = this.titles.get(Number(read?.[1]));
    if (read !== null && title !== undefined) {
      if (read[2] === '.title') return `${title}\n`;
      return JSON.stringify({ number: Number(read[1]), title, type: this.types.get(Number(read[1])) });
    }
    const list = /^api --paginate repos\/\{owner\}\/\{repo\}\/issues\/(\d+)\/comments --jq \.\[\]\.body$/.exec(call);
    if (list !== null) return (this.comments.get(Number(list[1])) ?? []).join('\n');
    throw new Error(`unexpected gh call: ${call}`);
  };
}

/** The real machine in `dir`, its git hermetic; gh, when `github` is given, answers from it. */
function sysFor(dir: string, github?: GitHub, env: Record<string, string> = {}): Sys {
  const real = realSys();
  return {
    ...real,
    cwd: dir,
    env,
    exec: (command, args, options) => {
      if (command !== 'gh') return real.exec(command, args, { ...options, env: hermeticGitEnv() });
      if (github === undefined) return assert.fail(`gh ran through sys: ${args.join(' ')}`);
      assert.equal(options?.cwd, dir);
      try {
        return { code: 0, stdout: github.gh(args), stderr: '' };
      } catch (error) {
        return { code: 1, stdout: '', stderr: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}

const check = (dir: string, github: GitHub, options: CheckOptions = {}) => checkWorkItemNumbers(sysFor(dir), dir, SETTINGS, github.gh, options);

function cli(dir: string, github: GitHub, args: readonly string[], env: Record<string, string> = {}): { code: number; out: string[]; err: string[] } {
  const { out, err, io } = capture();
  const code = workItemNumber(sysFor(dir, github, env), io, args);
  return { code, out, err };
}

const FIRST = { number: 201, title: '0153 — the first holder' };
const SECOND = { number: 202, title: '0154 — the second item' };
const LATE = { number: 203, title: '0153 — filed by hand' };
const ITEMS = [LATE, SECOND, FIRST];
const RENAMED = '0155 — filed by hand';
const HOLDER = `#201 (${FIRST.title})`;
const COMMENT = renumberComment(WORK, '0153', '0155', HOLDER);
const MOVE = { issue: 203, from: '0153', to: '0155', holder: HOLDER, title: RENAMED };
const LABELLED = '✓ every Work item carries work-item';

const answer = (next: string): (() => Allocation) => () => ({ ok: true, next, sources: { main: 0, local: 0, pullRequests: 0, workItems: 0, frozen: 0 }, warnings: [] });

describe('checkWorkItemNumbers: the event issue', () => {
  it('renumbers an issue filed with a taken number: comment, then retitle', () => {
    const dir = fixture(['0140-old.md']);
    const github = new GitHub(ITEMS);
    assert.deepEqual(check(dir, github, { apply: true, issue: 203 }), { ok: true, note: null, renumbers: [MOVE], applied: true });
    assert.deepEqual(github.calls, [event(203), LIST, PRS, PRS, LIST, titleRead(203), commentList(203), commentCall(203, COMMENT), titleRead(203), editCall(203, RENAMED)]);
    assert.equal(github.titles.get(203), RENAMED);
  });

  it('only says what it would do without apply', () => {
    const github = new GitHub(ITEMS);
    assert.deepEqual(check(PLAIN, github, { issue: 203 }), { ok: true, note: null, renumbers: [MOVE], applied: false });
    assert.deepEqual(github.writes(), []);
  });

  it('yields even to a newer issue when a retitle took the number', () => {
    const github = new GitHub(ITEMS);
    const result = check(PLAIN, github, { issue: 201, previousTitle: '0150 — the first holder' });
    assert.deepEqual(result, { ok: true, note: null, renumbers: [{ issue: 201, from: '0153', to: '0155', holder: `#203 (${LATE.title})`, title: '0155 — the first holder' }], applied: false });
  });

  it('leaves the holder alone when a retitle keeps its number', () => {
    const github = new GitHub([FIRST, SECOND]);
    assert.deepEqual(check(PLAIN, github, { apply: true, issue: 201, previousTitle: '0153 — older wording' }), { ok: true, note: '#201 kept its number 0153', renumbers: [], applied: true });
    assert.deepEqual(github.writes(), []);
  });

  it('notes an issue that is not a Work item, untyped, or unnumbered', () => {
    for (const type of ['Slice', null]) {
      const github = new GitHub([SECOND], [{ number: 300, title: 'S-1 — a slice', type }]);
      assert.deepEqual(check(PLAIN, github, { issue: 300 }), { ok: true, note: '#300 is not a Work item', renumbers: [], applied: false });
    }
    const github = new GitHub([SECOND], [{ number: 301, title: 'Flash sales', type: 'Work item' }]);
    assert.deepEqual(check(PLAIN, github, { issue: 301 }), { ok: true, note: "#301's title carries no number", renumbers: [], applied: false });
  });

  it('refuses when the issue cannot be read, or reads wrongly', () => {
    const answering = (reply: () => string) => check(PLAIN, new GitHub([SECOND]).queue(event(203), reply), { issue: 203 });
    assert.deepEqual(
      answering(() => {
        throw new Error('HTTP 404');
      }),
      { ok: false, error: 'could not read #203: HTTP 404' },
    );
    assert.deepEqual(answering(refuse), { ok: false, error: 'could not read #203: refused' });
    const garbled = answering(() => 'nope');
    assert.equal(garbled.ok, false);
    assert.match(garbled.ok ? '' : garbled.error, /^could not read #203: .*JSON/);
    const shape = { ok: false, error: 'could not read #203: #203 came back in an unexpected shape' };
    assert.deepEqual(
      answering(() => 'null'),
      shape,
    );
    assert.deepEqual(
      answering(() => '{"number":203}'),
      shape,
    );
    assert.deepEqual(
      answering(() => '{"number":203,"title":"0153 — x","type":5}'),
      shape,
    );
  });
});

describe('checkWorkItemNumbers: the sweep', () => {
  it('finds a clash a dropped run missed: the earlier-filed keeps it', () => {
    const items = [
      { number: 400, title: '0160 — first' },
      { number: 410, title: '0160 — filed while a run was pending' },
      { number: 420, title: '0161 — the event of the run that did happen' },
    ];
    assert.deepEqual(check(PLAIN, new GitHub(items), { issue: 420 }), {
      ok: true,
      note: null,
      renumbers: [{ issue: 410, from: '0160', to: '0162', holder: '#400 (0160 — first)', title: '0162 — filed while a run was pending' }],
      applied: false,
    });
  });

  it('sweeps with no event issue, numbering each move in turn', () => {
    const dir = fixture(['0170-on-main.md']);
    const items = [
      { number: 400, title: '0160 — first' },
      { number: 410, title: '0160 — second' },
      { number: 411, title: '0160 — third' },
      { number: 500, title: '0170 — clashes with main' },
    ];
    const result = check(dir, new GitHub(items));
    assert.ok(result.ok);
    assert.equal(result.note, null);
    assert.deepEqual(
      result.renumbers.map((move) => `${String(move.issue)}→${move.to}`),
      ['410→0171', '411→0172', '500→0173'],
    );
  });

  it('says so when nothing clashes', () => {
    const github = new GitHub([SECOND, FIRST]);
    assert.deepEqual(check(PLAIN, github, { apply: true, issue: 202 }), { ok: true, note: null, renumbers: [], applied: true });
    assert.deepEqual(github.calls, [event(202), LIST, PRS]);
  });

  it('names an RFC on main, an open PR and a frozen folder as holders', () => {
    const dir = fixture(['0156-on-main.md']);
    const github = new GitHub([
      { number: 501, title: '0156 — clashes with main' },
      { number: 502, title: '0157 — clashes with a PR' },
      { number: 503, title: '0145 — clashes with a frozen folder' },
    ]);
    github.pulls = [{ number: 9, files: [{ path: 'docs/rfcs/0157-in-a-pr.md' }, { path: 'docs/rfcs/0156-on-main.md' }] }];
    const result = check(dir, github);
    assert.ok(result.ok);
    assert.deepEqual(
      result.renumbers.map((move) => [move.holder, move.to]),
      [
        ['`docs/rfcs/0156-on-main.md` on main', '0158'],
        ["an open pull request's new RFC-0157", '0159'],
        ['the frozen work folder `docs/work/0145-another-folder`', '0160'],
      ],
    );
  });

  it('yields to a frozen folder only after lastMovedIssue, and to main always', () => {
    const moved = { number: LAST_MOVED, title: '0142 — moved off its own folder' };
    assert.deepEqual(check(PLAIN, new GitHub([moved]), { issue: LAST_MOVED }), { ok: true, note: null, renumbers: [], applied: false });
    const later = { number: LAST_MOVED + 1, title: '0142 — after the move' };
    const result = check(PLAIN, new GitHub([later]), { issue: LAST_MOVED + 1 });
    assert.ok(result.ok);
    assert.deepEqual(
      result.renumbers.map((move) => move.holder),
      ['the frozen work folder `docs/work/0142-old-folder`'],
    );
    const dir = fixture(['0142-on-main.md']);
    const onMain = check(dir, new GitHub([moved]));
    assert.ok(onMain.ok);
    assert.deepEqual(
      onMain.renumbers.map((move) => move.holder),
      ['`docs/rfcs/0142-on-main.md` on main'],
    );
  });
});

describe('planMoves', () => {
  const sources = (items: readonly { number: number; title: string; workNumber: string | null }[]) => ({ items, mainNames: [], prNumbers: new Set<string>() });

  it('moves nothing for an unnumbered item, or with no frozen folders configured', () => {
    const bare = docSettings(BARE);
    const kind = bare.kinds.rfc ?? assert.fail('no rfc kind');
    const items = [
      { number: 5, title: 'no number', workNumber: null },
      { number: 600, title: '0145 — x', workNumber: '0145' },
    ];
    assert.deepEqual([...planMoves(bare, kind, sources(items), null)], []);
    assert.deepEqual([...planMoves(SETTINGS, RFC, sources(items), null).keys()], [600]);
  });

  it('leaves an event issue nothing holds, and moves one something does', () => {
    const item = { number: 600, title: '0160 — x', workNumber: '0160' };
    assert.equal(planMoves(SETTINGS, RFC, sources([item]), { item, work: '0160' }).size, 0);
    const frozen = { number: 601, title: '0145 — y', workNumber: '0145' };
    assert.deepEqual(planMoves(SETTINGS, RFC, sources([frozen]), { item: frozen, work: '0145' }).get(601), { item: frozen, work: '0145', holder: 'the frozen work folder `docs/work/0145-another-folder`' });
  });
});

describe('checkWorkItemNumbers: incomplete sources', () => {
  it('refuses when main cannot be read', () => {
    assert.deepEqual(check(PLAIN, new GitHub(ITEMS), { ref: 'origin/gone' }), { ok: false, error: 'could not read `origin/gone` — fetch it first' });
  });

  it('names every source that failed, not just the first', () => {
    const github = new GitHub(ITEMS)
      .queue(LIST, () => {
        throw new Error('HTTP 502');
      })
      .queue(PRS, () => 'nope');
    assert.deepEqual(check(PLAIN, github, { apply: true }), {
      ok: false,
      error:
        'sources incomplete: could not read Work item issues via `gh` (not installed, not authenticated, or offline) — numbers in their titles were NOT considered; ' +
        'could not read open PRs via `gh` (not installed, not authenticated, offline, or not JSON) — numbers claimed by unmerged PRs were NOT considered',
    });
    assert.deepEqual(github.writes(), []);
  });

  it("passes the allocator's own refusal through", () => {
    const items = [
      { number: 600, title: '9999 — the top' },
      { number: 601, title: '9999 — and again' },
    ];
    assert.deepEqual(check(PLAIN, new GitHub(items)), { ok: false, error: 'could not reserve a RFC number: RFC number space exhausted' });
    assert.deepEqual(check(PLAIN, new GitHub(ITEMS), { allocate: () => ({ ok: false, error: 'stubbed refusal' }) }), { ok: false, error: 'stubbed refusal' });
  });

  it('refuses moves that would run past 9999, or an answer that is no number', () => {
    const items = [
      { number: 600, title: '0160 — one' },
      { number: 601, title: '0160 — two' },
      { number: 602, title: '0160 — three' },
    ];
    const at = (next: string) => check(PLAIN, new GitHub(items), { allocate: answer(next) });
    const top = at('9998');
    assert.ok(top.ok);
    assert.deepEqual(
      top.renumbers.map((move) => move.title),
      ['9998 — two', '9999 — three'],
    );
    for (const next of ['9999', 'abc', '0160.5', '0000']) assert.deepEqual(at(next), { ok: false, error: `no room for 2 number(s) from ${next}` });
  });

  it('names every source the allocator could not read', () => {
    const github = new GitHub(ITEMS);
    github
      .queue(
        LIST,
        () => github.listing(),
        () => {
          throw new Error('HTTP 502');
        },
      )
      .queue(
        PRS,
        () => '[]',
        () => 'nope',
      );
    assert.deepEqual(check(PLAIN, github, { apply: true }), {
      ok: false,
      error:
        'allocator incomplete: could not read open PRs via `gh` (not installed, not authenticated, offline, or not JSON) — numbers claimed by unmerged PRs were NOT considered; ' +
        'could not read Work item issues via `gh` (not installed, not authenticated, or offline) — numbers in their titles were NOT considered',
    });
    assert.deepEqual(github.writes(), []);
  });
});

describe('checkWorkItemNumbers: the writes', () => {
  it('stops, writing nothing, when the title changed since it was listed', () => {
    const github = new GitHub(ITEMS).queue(titleRead(203), () => '0153 — retitled meanwhile\n');
    assert.deepEqual(check(PLAIN, github, { apply: true }), {
      ok: false,
      error: 'could not renumber #203: its title changed during the run, to "0153 — retitled meanwhile"; that edit\'s own run checks it again',
    });
    assert.deepEqual(github.writes(), []);
  });

  it('reads the title again right before the retitle, and stops if it changed', () => {
    const github = new GitHub(ITEMS).queue(
      titleRead(203),
      () => `${LATE.title}\n`,
      () => '0153 — retitled while the comment went up\n',
    );
    assert.deepEqual(check(PLAIN, github, { apply: true }), {
      ok: false,
      error: 'could not renumber #203: its title changed during the run, to "0153 — retitled while the comment went up"; that edit\'s own run checks it again',
    });
    assert.deepEqual(github.writes(), [commentCall(203, COMMENT)]);
  });

  it('comments before it retitles, so a refused comment leaves the title for a rerun', () => {
    const failed = new GitHub(ITEMS).queue(commentCall(203, COMMENT), () => {
      throw new Error('HTTP 403');
    });
    assert.deepEqual(check(PLAIN, failed, { apply: true }), { ok: false, error: 'could not renumber #203: HTTP 403' });
    assert.deepEqual(failed.writes(), [commentCall(203, COMMENT)]);
    assert.equal(failed.titles.get(203), LATE.title);
    const refused = new GitHub(ITEMS).queue(commentCall(203, COMMENT), refuse);
    assert.deepEqual(check(PLAIN, refused, { apply: true }), { ok: false, error: 'could not renumber #203: refused' });
  });

  it('does not comment twice when a rerun finds its own explanation', () => {
    const github = new GitHub(ITEMS);
    github.comments.set(203, [`Renumbered from 0153 to 0155 …\n${renumberMarker('0153', '0155')}`]);
    assert.deepEqual(check(PLAIN, github, { apply: true }), { ok: true, note: null, renumbers: [MOVE], applied: true });
    assert.deepEqual(github.writes(), [editCall(203, RENAMED)]);
  });

  it('comments again when the only marker names another target number', () => {
    const github = new GitHub(ITEMS);
    github.comments.set(203, [renumberMarker('0153', '0154')]);
    assert.ok(check(PLAIN, github, { apply: true }).ok);
    assert.deepEqual(github.writes(), [commentCall(203, COMMENT), editCall(203, RENAMED)]);
  });
});

describe('renumberComment', () => {
  it('names both numbers, the holder and the reserve command, and carries the marker', () => {
    assert.equal(
      renumberComment(WORK, '0153', '0155', '#201 (x)'),
      'Renumbered from 0153 to 0155: 0153 is already held by #201 (x). Numbers are identity and never reused.\n\n' +
        'A Work item takes its number from `niyam doc-number rfc --reserve` before `gh issue create`. ' +
        'This one was filed without it, so the `work-item-number` check took the next free number from the same allocator.\n' +
        '<!-- work-item-number: renumbered from 0153 to 0155 -->',
    );
  });

  it('names the configured reserve command instead', () => {
    assert.match(renumberComment({ ...WORK, reserveCommand: 'pnpm reserve rfc' }, '0153', '0155', 'x'), /takes its number from `pnpm reserve rfc` before/);
  });
});

describe('unlabelledWorkItems', () => {
  const work = { ...WORK, label: 'work-item' };

  it('lists the issue numbers, skipping blank lines', () => {
    assert.deepEqual(
      unlabelledWorkItems(work, () => '5\n\n7\n'),
      { ok: true, issues: [5, 7] },
    );
  });

  it('refuses a line that is no issue number, or a failed read', () => {
    for (const line of ['nope', '3.5', '0'])
      assert.deepEqual(
        unlabelledWorkItems(work, () => `5\n${line}\n`),
        { ok: false, error: `could not list unlabelled Work items: unexpected issue number "${line}"` },
      );
    assert.deepEqual(unlabelledWorkItems(work, refuse), { ok: false, error: 'could not list unlabelled Work items: refused' });
  });
});

describe('workItemArgs', () => {
  it('reads --issue N, --issue=N and --apply', () => {
    assert.deepEqual(workItemArgs([]), { apply: false });
    assert.deepEqual(workItemArgs(['--apply', '--issue', '5']), { issue: 5, apply: true });
    assert.deepEqual(workItemArgs(['--issue=7']), { issue: 7, apply: false });
  });

  it('throws on a missing, malformed or repeated --issue, or anything else', () => {
    for (const args of [['--issue'], ['--issue', '#3'], ['--issue=0'], ['--issue=']]) assert.throws(() => workItemArgs(args), /^Error: work-item-number --issue needs an issue number$/);
    assert.throws(() => workItemArgs(['--issue', '1', '--issue=2']), /^Error: work-item-number takes one --issue$/);
    assert.throws(() => workItemArgs(['--dry']), /^Error: work-item-number: unexpected argument "--dry"$/);
  });
});

describe('workItemNumber', () => {
  const line = `#203 from 0153 to 0155 (0153 is held by ${HOLDER})`;

  it('throws on bad usage before it reads anything', () => {
    const github = new GitHub(ITEMS);
    assert.throws(() => cli(PLAIN, github, ['--issue', '#3']), /needs an issue number/);
    assert.deepEqual(github.calls, []);
  });

  it('previews, then renumbers under --apply', () => {
    assert.deepEqual(cli(PLAIN, new GitHub(ITEMS), ['--issue', '203']), { code: 0, out: [`→ would renumber ${line}`, LABELLED], err: [] });
    const github = new GitHub(ITEMS);
    assert.deepEqual(cli(PLAIN, github, ['--apply', '--issue', '203']), { code: 0, out: [`✓ renumbered ${line}`, LABELLED], err: [] });
    assert.deepEqual(github.writes(), [commentCall(203, COMMENT), editCall(203, RENAMED)]);
  });

  it('labels every Work item without the label: previewed, then applied', () => {
    const preview = new GitHub([FIRST, SECOND]);
    preview.unlabelled = '201\n202\n';
    assert.deepEqual(cli(PLAIN, preview, []), { code: 0, out: ['✓ no Work item shares a number', '→ would label #201 work-item', '→ would label #202 work-item'], err: [] });
    assert.deepEqual(preview.writes(), []);
    const github = new GitHub([FIRST, SECOND]);
    github.unlabelled = '201\n202\n';
    assert.deepEqual(cli(PLAIN, github, ['--apply']).out, ['✓ no Work item shares a number', '✓ labelled #201 work-item', '✓ labelled #202 work-item']);
    assert.deepEqual(github.writes(), [labelCall(201), labelCall(202)]);
  });

  it('labels even when the number check fails, and exits 1 for it', () => {
    const github = new GitHub([]).queue(event(203), () => {
      throw new Error('HTTP 404');
    });
    github.unlabelled = '203\n';
    assert.deepEqual(cli(PLAIN, github, ['--issue', '203', '--apply']), { code: 1, out: ['✓ labelled #203 work-item'], err: ['❌ could not read #203: HTTP 404'] });
    assert.deepEqual(github.calls, [UNLABELLED, event(203), labelCall(203)]);
  });

  it('exits 1 when a label cannot be written', () => {
    const github = new GitHub([FIRST, SECOND]).queue(labelCall(201), () => {
      throw new Error('HTTP 403');
    });
    github.unlabelled = '201\n202\n';
    assert.deepEqual(cli(PLAIN, github, ['--apply']), { code: 1, out: ['✓ no Work item shares a number'], err: ['❌ could not label #201: HTTP 403'] });
    assert.deepEqual(github.writes(), [labelCall(201)]);
  });

  it('stops before any write when the unlabelled list cannot be read', () => {
    const failed = new GitHub(ITEMS).queue(UNLABELLED, () => {
      throw new Error('HTTP 502');
    });
    assert.deepEqual(cli(PLAIN, failed, ['--issue', '203', '--apply']), { code: 1, out: [], err: ['❌ could not list unlabelled Work items: HTTP 502'] });
    assert.deepEqual(failed.calls, [UNLABELLED]);
    const garbled = new GitHub(ITEMS);
    garbled.unlabelled = '201\nnope\n';
    assert.deepEqual(cli(PLAIN, garbled, ['--issue', '203', '--apply']), { code: 1, out: [], err: ['❌ could not list unlabelled Work items: unexpected issue number "nope"'] });
    assert.deepEqual(garbled.calls, [UNLABELLED]);
  });

  it('prints the note for the event issue, from WORK_ITEM_PREVIOUS_TITLE', () => {
    assert.deepEqual(cli(PLAIN, new GitHub([FIRST, SECOND]), []), { code: 0, out: ['✓ no Work item shares a number', LABELLED], err: [] });
    assert.deepEqual(cli(PLAIN, new GitHub([FIRST, SECOND]), ['--issue', '201'], { WORK_ITEM_PREVIOUS_TITLE: '0153 — old wording' }).out, ['✓ #201 kept its number 0153', '✓ no Work item shares a number', LABELLED]);
  });

  it('reads an empty WORK_ITEM_PREVIOUS_TITLE as a filed issue', () => {
    assert.deepEqual(cli(PLAIN, new GitHub(ITEMS), ['--issue', '201'], { WORK_ITEM_PREVIOUS_TITLE: '' }).out, [`→ would renumber #201 from 0153 to 0155 (0153 is held by #203 (${LATE.title}))`, LABELLED]);
  });

  it('reads no labels when none is configured', () => {
    const dir = fixture([], BARE);
    const github = new GitHub([FIRST, SECOND]);
    assert.deepEqual(cli(dir, github, []), { code: 0, out: ['✓ no Work item shares a number'], err: [] });
    assert.deepEqual(github.calls, [LIST, PRS]);
    const failing = new GitHub([]).queue(event(203), () => {
      throw new Error('HTTP 404');
    });
    assert.deepEqual(cli(dir, failing, ['--issue', '203']), { code: 1, out: [], err: ['❌ could not read #203: HTTP 404'] });
  });

  it('exits 2 when the settings name no Work items', () => {
    const dir = fixture([], { reservations: RESERVATIONS, kinds: KINDS });
    const github = new GitHub(ITEMS);
    assert.deepEqual(cli(dir, github, []), { code: 2, out: [], err: ['niyam work-item-number: .github/niyam.json\'s "docNumbers" names no "workItems"'] });
    assert.deepEqual(github.calls, []);
  });
});

describe('workItemNumber under fault injection', () => {
  const ARGS = ['--issue', '203', '--apply'];
  const marked = (github: GitHub) => (github.comments.get(203) ?? []).filter((body) => body.includes(renumberMarker('0153', '0155'))).length;

  it('makes eleven gh calls on a clean run, and nothing more on a rerun', () => {
    const github = new GitHub(ITEMS);
    assert.equal(cli(PLAIN, github, ARGS).code, 0);
    assert.equal(github.calls.length, 11);
    assert.equal(github.titles.get(203), RENAMED);
    assert.equal(cli(PLAIN, github, ARGS).code, 0);
    assert.equal(marked(github), 1);
    assert.equal(github.titles.get(203), RENAMED);
  });

  it('never exits 0 on a failed gh call, never half-writes, and a rerun converges on one comment and the new title', () => {
    for (let failAt = 1; failAt <= 11; failAt++) {
      const github = new GitHub(ITEMS);
      github.failAt = failAt;
      const failed = cli(PLAIN, github, ARGS);
      assert.equal(failed.code, 1, `call ${String(failAt)}: exit ${String(failed.code)}`);
      assert.ok([LATE.title, RENAMED].includes(github.titles.get(203) ?? ''), `call ${String(failAt)}: the title is half-written`);
      assert.ok(marked(github) <= 1, `call ${String(failAt)}: more than one comment`);
      github.failAt = 0;
      github.calls.length = 0;
      const rerun = cli(PLAIN, github, ARGS);
      assert.equal(rerun.code, 0, `call ${String(failAt)}: the rerun: ${rerun.err.join('\n')}`);
      assert.equal(github.titles.get(203), RENAMED, `call ${String(failAt)}: the rerun's title`);
      assert.equal(marked(github), 1, `call ${String(failAt)}: one comment`);
    }
  });
});
