import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { LOCKED } from './as-agent.ts';
import { AGENT, FakeSys, TOKEN } from './fake.test.ts';
import { USAGE, packageVersion, proposeArgs, run, stateArgs, versionOf } from './run.ts';

const manifest: unknown = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
);
const expectedVersion =
  typeof manifest === 'object' && manifest !== null && 'version' in manifest
    ? manifest.version
    : undefined;

const noSys = (): never => {
  throw new Error('this command must not touch the machine');
};

async function capture(
  args: readonly string[],
  sys: () => FakeSys = noSys,
): Promise<{
  code: number;
  out: string[];
  err: string[];
}> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(
    args,
    {
      out: (line) => out.push(line),
      err: (line) => err.push(line),
    },
    sys,
  );
  return { code, out, err };
}

describe('run', () => {
  for (const args of [[], ['help'], ['--help'], ['-h']]) {
    it(`prints usage for ${JSON.stringify(args)}`, async () => {
      assert.deepEqual(await capture(args), { code: 0, out: [USAGE], err: [] });
    });
  }

  for (const flag of ['version', '--version', '-v']) {
    it(`prints the package version for ${flag}`, async () => {
      assert.deepEqual(await capture([flag]), {
        code: 0,
        out: [expectedVersion],
        err: [],
      });
    });
  }

  it('prints the Setup snippet for cloud-setup, which names no version', async () => {
    const { code, out } = await capture(['cloud-setup']);
    assert.equal(code, 0);
    assert.match(out[0] ?? '', /^#!\/bin\/bash\n# Optional: cloud sessions install niyam themselves when they have none\. This makes them start faster/);
    assert.ok(!(out[0] ?? '').includes(String(expectedVersion)));
  });

  it('refuses an unknown command with usage on stderr', async () => {
    assert.deepEqual(await capture(['deploy']), {
      code: 2,
      out: [],
      err: ['niyam: unknown command "deploy"', USAGE],
    });
  });

  for (const command of ['machine', 'doctor']) {
    it(`reports a ${command} failure with exit 1`, async () => {
      const sys = new FakeSys();
      sys.inRepo = false;
      assert.deepEqual(await capture([command], () => sys), {
        code: 1,
        out: [],
        err: [
          `niyam ${command}: name the agent account after the command, or run it in a repo whose .github/niyam.json names one`,
        ],
      });
    });
  }

  it('runs doctor', async () => {
    const { code, out } = await capture(['doctor'], () => new FakeSys());
    assert.equal(code, 1);
    assert.equal(out[0], '◆  niyam doctor   ExampleBot');
    // A machine never set up, in a repository with no shared Guard caller yet (#485).
    assert.equal(out.at(-1), '└  6 to fix');
  });

  it('runs session-start, which always exits 0', async () => {
    const { code, out } = await capture(['session-start'], () => new FakeSys());
    assert.equal(code, 0);
    assert.match(out[0] ?? '', /CLAUDE_ENV_FILE is unset.*runs only as the SessionStart hook, so a run by hand says nothing about this session/);
  });

  it('passes the named agent on', async () => {
    const { out } = await capture(['doctor', 'OtherBot'], () => new FakeSys());
    assert.equal(out[0], '◆  niyam doctor   OtherBot');
  });

  it('passes machine its agent and flags, and treats a bad one as bad usage', async () => {
    const { code, out } = await capture(['machine', 'examplebot', '--dry-run'], () => new FakeSys());
    assert.equal(code, 0);
    assert.equal(out[0], '◆  niyam machine   ExampleBot');
    assert.equal(out.at(-1), '└  Dry run: nothing changed.');
    for (const args of [['machine', '--force'], ['machine', 'a', 'b']]) {
      const { code: bad, err } = await capture(args);
      assert.equal(bad, 2, args.join(' '));
      assert.match(err[0] ?? '', /^niyam: (unknown option --force|unexpected argument "b")$/);
    }
  });

  it('runs pr-work-rules and pre-push, which takes git\'s two arguments and no third', async () => {
    assert.match((await capture(['pr-work-rules'], () => new FakeSys())).err[0] ?? '', /pr-work-rules runs in GitHub Actions/);
    assert.match((await capture(['pr-merged'], () => new FakeSys())).err[0] ?? '', /pr-merged runs in GitHub Actions/);
    assert.match((await capture(['pr-started'], () => new FakeSys())).err[0] ?? '', /pr-started runs in GitHub Actions/);
    const agent = new FakeSys();
    agent.env = { NIYAM_AGENT: 'ExampleBot' };
    agent.stdin = `refs/heads/work ${'a'.repeat(40)} refs/heads/work ${'b'.repeat(40)}\n`;
    const refused = await capture(['pre-push', 'origin', 'https://github.com/a/b.git'], () => agent);
    assert.equal(refused.code, 1);
    assert.match(refused.err[0] ?? '', /git has no credentials for github.com here/, 'git\'s URL reaches the identity guard');
    assert.equal((await capture(['pre-push', 'origin', 'url', 'extra'])).code, 2);
  });

  it('runs propose, which takes one issue number or several', async () => {
    const refused = await capture(['propose', '#12'], () => new FakeSys());
    assert.equal(refused.code, 1);
    assert.match(refused.err[0] ?? '', /this session has no token/);
    const several = await capture(['propose', '12', '#13'], () => new FakeSys());
    assert.equal(several.code, 1);
    assert.match(several.err[0] ?? '', /this session has no token/);
    assert.deepEqual(await capture(['propose']), { code: 2, out: [], err: ['niyam: propose needs an issue number', USAGE] });
    assert.deepEqual(await capture(['propose', 'twelve']), { code: 2, out: [], err: ['niyam: propose needs an issue number, not "twelve"', USAGE] });
    assert.deepEqual(await capture(['propose', '12', 'x', 'y']), { code: 2, out: [], err: ['niyam: propose needs an issue number, not "x"', USAGE] });
    assert.deepEqual(await capture(['propose', '#0']), { code: 2, out: [], err: ['niyam: propose needs an issue number, not "#0"', USAGE] });
  });

  it("takes propose's page once, before or after the numbers, with its value", async () => {
    const PAGE = 'https://claude.ai/artifact/W48-page';
    assert.deepEqual(proposeArgs(['12', '--page', PAGE]), { numbers: [12], page: PAGE });
    assert.deepEqual(proposeArgs([`--page=${PAGE}`, '#12', '30']), { numbers: [12, 30], page: PAGE });
    assert.deepEqual(proposeArgs(['12']), { numbers: [12] });
    const paged = await capture(['propose', '12', '--page', PAGE], () => new FakeSys());
    assert.equal(paged.code, 1);
    assert.match(paged.err[0] ?? '', /this session has no token/);
    const bad: Array<[string[], string]> = [
      [['12', '--page'], "propose --page needs the published page's link"],
      [['12', '--page', '--other'], "propose --page needs the published page's link"],
      [['12', '--page='], "propose --page needs the published page's link"],
      [['12', '--page', PAGE, '--page', PAGE], 'propose takes one --page: one page argues every proposal of the run'],
      [['--page', PAGE], 'propose needs an issue number'],
      [['12', PAGE], `propose needs an issue number, not "${PAGE}"`],
    ];
    for (const [args, message] of bad) {
      assert.deepEqual(await capture(['propose', ...args]), { code: 2, out: [], err: [`niyam: ${message}`, USAGE] }, args.join(' '));
    }
  });

  it('runs state, which takes one slice, as 12 or #12, and a title', async () => {
    assert.deepEqual(stateArgs(['#12', '--title', 'Fix: narrow pages']), { slice: 12, title: 'Fix: narrow pages' });
    assert.deepEqual(stateArgs(['--title=Fix: narrow pages ', '12']), { slice: 12, title: 'Fix: narrow pages' });
    const refused = await capture(['state', '12', '--title', 'Fix'], () => new FakeSys());
    assert.deepEqual(refused, { code: 1, out: [], err: ['✗ this session has no token; run niyam doctor'] });
    const bad: Array<[string[], string]> = [
      // What bash leaves of `niyam state #12 --title x`: the rest is a comment.
      [[], "state needs the slice's number, as 12 or '#12' (quoted: in bash an unquoted # starts a comment)"],
      [['--title', 'Fix'], "state needs the slice's number, as 12 or '#12' (quoted: in bash an unquoted # starts a comment)"],
      [['twelve', '--title', 'Fix'], 'state needs the slice\'s number, not "twelve"'],
      [['#0', '--title', 'Fix'], 'state needs the slice\'s number, not "#0"'],
      [['99999999999999999999', '--title', 'Fix'], 'state needs the slice\'s number, not "99999999999999999999"'],
      [['12', '13', '--title', 'Fix'], 'state takes one slice, not 2 (12 13)'],
      [['12'], 'state needs --title "<what the State builds>"'],
      [['12', '--title'], 'state --title needs what the State builds, as text'],
      [['12', '--title', ' '], 'state --title needs what the State builds, as text'],
      [['12', '--title=', 'x'], 'state --title needs what the State builds, as text'],
      [['12', '--title', '--foo'], 'state --title needs what the State builds, as text'],
      [['12', '--title=--foo'], 'state --title needs what the State builds, as text'],
      [['12', '--title', 'a', '--title', 'b'], 'state takes one --title'],
    ];
    for (const [args, message] of bad) {
      assert.deepEqual(await capture(['state', ...args]), { code: 2, out: [], err: [`niyam: ${message}`, USAGE] }, args.join(' '));
    }
  });

  it('runs review-thread, whose arguments are checked first', async () => {
    const refused = await capture(['review-thread', 'PRRT_x', '--resolve'], () => new FakeSys());
    assert.deepEqual(refused, { code: 1, out: [], err: ['✗ this session has no token; run niyam doctor', 'review-thread: refused'] });
    assert.deepEqual(await capture(['review-thread', 'PRRT_x']), {
      code: 2,
      out: [],
      err: ['niyam: review-thread needs --reply <text>, --body-file <path>, --resolve, or --reaction', USAGE],
    });
    assert.equal((await capture(['review-thread', 'PRRT_x', '--resolve', 'more'])).code, 2);
    assert.deepEqual(await capture(['review-thread', '--batch']), { code: 2, out: [], err: ['niyam: --batch needs the path of a JSON file listing the threads', USAGE] });
    const batch = await capture(['review-thread', '--batch', '.tmp/batch.json'], () => new FakeSys());
    assert.deepEqual(batch, { code: 1, out: [], err: ['✗ .tmp/batch.json is not there', 'review-thread: refused'] });
  });

  it('runs pr-signals, whose arguments are checked first', async () => {
    const refused = await capture(['pr-signals', '7'], () => new FakeSys());
    assert.deepEqual(refused, { code: 1, out: [], err: ['✗ this session has no token; run niyam doctor'] });
    assert.deepEqual(await capture(['pr-signals']), { code: 2, out: [], err: ['niyam: pr-signals needs a pull request number', USAGE] });
    assert.deepEqual(await capture(['pr-signals', '7', '--all']), { code: 2, out: [], err: ['niyam: unexpected argument "--all"', USAGE] });
    assert.equal((await capture(['pr-signals', '7', '--ci-only', 'more'])).code, 2);
  });

  it('runs handoff and brief, whose arguments are checked first', async () => {
    // A repository that names no "handoff" has the gate off: the pre-push hook's call passes.
    assert.deepEqual(await capture(['handoff', '--assert-fresh'], () => new FakeSys()), { code: 0, out: [], err: [] });
    assert.deepEqual(await capture(['handoff', '--detect'], () => new FakeSys()), {
      code: 1,
      out: [],
      err: ['niyam handoff: .github/niyam.json names no "handoff": the gate is off in this repository'],
    });
    assert.deepEqual(await capture(['handoff']), { code: 2, out: [], err: ['niyam: handoff takes one of --detect, --record or --assert-fresh', USAGE] });
    assert.equal((await capture(['brief', '--lint'])).code, 2);
    assert.equal((await capture(['brief', 'b.md'], () => new FakeSys())).code, 1);
  });

  it('runs cubic-dismiss, whose arguments are checked first', async () => {
    assert.deepEqual(await capture(['cubic-dismiss', '--title']), { code: 2, out: [], err: ['niyam: --title needs a value', USAGE] });
    assert.equal((await capture(['cubic-dismiss', '--title', 'T', '--reason', 'r'])).code, 2);
    // Outside a repository git cannot say where the checkout is.
    const outside = new FakeSys();
    outside.inRepo = false;
    const failed = await capture(['cubic-dismiss', '--decision', '#1', '--title', 'T', '--reason', 'r'], () => outside);
    assert.equal(failed.code, 1);
    assert.match(failed.err[0] ?? '', /^niyam cubic-dismiss: git rev-parse failed/);
  });

  it('runs guard, refusing when the check itself fails', async () => {
    const sys = new FakeSys();
    sys.stdin = JSON.stringify({ session_id: 's', tool_input: { command: 'ls' } });
    assert.equal((await capture(['guard'], () => sys)).code, 0);
    const failed = await capture(['guard']);
    assert.deepEqual(failed, { code: 2, out: [], err: ['niyam guard: refused, because the check failed: this command must not touch the machine'] });
    const thrown = await capture(['guard'], () => {
      throw 'odd';
    });
    assert.equal(thrown.err[0], 'niyam guard: refused, because the check failed: odd');
  });

  it('treats a bad onboard option as bad usage', async () => {
    for (const args of [['onboard', 'a', 'b', 'c'], ['onboard', '--add', 'boards'], ['onboard', '--force']]) {
      const { code, err } = await capture(args);
      assert.equal(code, 2, args.join(' '));
      assert.equal(err.at(-1), USAGE);
    }
  });

  it('refuses a second argument after the agent', async () => {
    assert.deepEqual(await capture(['machine', 'OtherBot', 'now']), {
      code: 2,
      out: [],
      err: ['niyam: unexpected argument "now"', USAGE],
    });
  });

  it('reports a thrown non-error', async () => {
    const sys = new FakeSys();
    sys.exec = () => {
      throw 'odd';
    };
    assert.deepEqual(await capture(['machine'], () => sys), {
      code: 1,
      out: [],
      err: ['niyam machine: odd'],
    });
  });

  it('refuses an extra argument', async () => {
    assert.deepEqual(await capture(['version', 'now']), {
      code: 2,
      out: [],
      err: ['niyam: unexpected argument "now"', USAGE],
    });
  });
});

describe('each command reaches its own code (#628)', () => {
  const first = ({ out, err }: { out: string[]; err: string[] }): string => [...out, ...err][0] ?? '';

  it('starts its usage with the command line and the commands', () => {
    assert.match(USAGE, /^Usage: niyam <command>\n\nCommands:\n {2}machine /);
  });

  for (const [args, code, line] of [
    [['onboard', '--dry-run'], 1, /^niyam onboard: GitHub has no account "example-owner"/],
    [['machine', '--dry-run'], 0, /^◆ {2}niyam machine {3}ExampleBot$/],
    [['cloud-key', '--yes'], 1, /^cloud-key: this Mac's keychain has no ExampleBot token/],
    [['review-thread', 'PRRT_x', '--resolve'], 1, /^✗ this session has no token; run niyam doctor$/],
    [['as-agent', '--session', 's', '--', 'ls'], LOCKED, /^niyam: refused, because this session does not work as the agent on GitHub/],
    [['env', '--', 'ls'], 1, /^niyam: GitHub is locked out of this shell: /],
    [['propose', '12'], 1, /^✗ this session has no token; run niyam doctor$/],
    [['state', '12', '--title', 'x'], 1, /^✗ this session has no token; run niyam doctor$/],
    [['owner-step', 'issue-types', 'example-org'], 1, /^owner-step issue-types: the work model's issue types in example-org$/],
    [['handoff', '--detect'], 1, /^niyam handoff: \.github\/niyam\.json names no "handoff"/],
    [['brief', 'b.md'], 1, /^niyam brief: \.github\/niyam\.json names no "handoff"/],
    [['cubic-dismiss', '--decision', '#1', '--title', 'T', '--reason', 'r'], 1, /^niyam cubic-dismiss: git status failed/],
    [['pr-autocreate', 'claude-hook'], 0, /^pr-autocreate: hook input is not a JSON object; nothing done$/],
    [['keep-going', '--stop', 'x'], 1, /^Not on a branch of a git checkout\.$/],
    [['doc-number', 'adr'], 1, /^niyam doc-number: \.github\/niyam\.json has no "docNumbers"/],
    [['renumber-doc', 'adr', '0001', '0002'], 1, /^niyam renumber-doc: \.github\/niyam\.json has no "docNumbers"/],
    [['work-item-number', '--issue', '5'], 1, /^niyam work-item-number: \.github\/niyam\.json has no "docNumbers"/],
    [['board-audit', 'example-org/example-app'], 1, /^niyam board-audit: board-audit needs GH_TOKEN/],
    [['ssh-sign', '-Y', 'find-principals'], 1, /^niyam ssh-sign: signs only, as ssh-keygen -Y sign does; asked for -Y find-principals$/],
    [['pr-signals', '7'], 1, /^✗ this session has no token; run niyam doctor$/],
    [['upgrade'], 0, /^upgrade: niyam \S+ is the newest release$/],
    [['reviews-due'], 1, /^niyam reviews-due: reviews-due needs GH_TOKEN/],
    [['decisions-weekly'], 1, /^niyam decisions-weekly: decisions-weekly runs in GitHub Actions/],
    [['needs-owner'], 1, /^niyam needs-owner: needs-owner runs in GitHub Actions/],
    [['issue-type'], 1, /^niyam issue-type: issue-type runs in GitHub Actions/],
    [['pr-design'], 1, /^niyam pr-design: pr-design runs in GitHub Actions/],
    [['pr-identity'], 1, /^niyam pr-identity: pr-identity runs in GitHub Actions/],
  ] as const) {
    it(`runs ${args.join(' ')} as that command`, async () => {
      const got = await capture(args, () => new FakeSys());
      assert.equal(got.code, code);
      assert.match(first(got), line);
    });
  }

  it('lets keep-going through with nothing said when it has nothing to say', async () => {
    assert.deepEqual(await capture(['keep-going'], () => new FakeSys()), { code: 0, out: [], err: [] });
  });

  it("keeps each command's own answer when the machine cannot be read", async () => {
    const lost = 'this command must not touch the machine';
    assert.deepEqual(await capture(['pr-autocreate', 'claude-hook']), { code: 0, out: [], err: [`pr-autocreate: unexpected error (${lost}); nothing done`] });
    assert.deepEqual(await capture(['keep-going', '--stop', 'x']), { code: 1, out: [], err: [`niyam keep-going: ${lost}`] });
    assert.deepEqual(await capture(['keep-going']), { code: 0, out: [], err: [`niyam keep-going: ${lost}`] });
    assert.deepEqual(await capture(['as-agent', '--session', 's', '--', 'ls']), { code: LOCKED, out: [], err: [`niyam as-agent: ran nothing, because the check failed: ${lost}`] });
    assert.deepEqual(await capture(['env', '--', 'ls']), { code: LOCKED, out: [], err: [`niyam env: ran nothing, because the check failed: ${lost}`] });
    const locked = await capture(['env']);
    assert.equal(locked.code, LOCKED);
    assert.deepEqual(locked.err, [`niyam: GitHub is locked out of this shell, because the check failed: ${lost}`]);
    assert.match(locked.out[0] ?? '', /^export GH_TOKEN=niyam-no-agent-token;/);
  });

  for (const [args, message] of [
    [['onboard', '--force'], 'unknown option --force'],
    [['machine', '--force'], 'unknown option --force'],
    [['cloud-key', '--nope'], 'unknown option --nope'],
    [['review-thread', 'PRRT_x'], 'review-thread needs --reply <text>, --body-file <path>, --resolve, or --reaction'],
    [['as-agent'], 'as-agent needs --session <session_id> first'],
    [['env', 'x'], 'env takes no options; to run a command under it, put -- before the command, not "x"'],
    [['propose', 'twelve'], 'propose needs an issue number, not "twelve"'],
    [['state', '12'], 'state needs --title "<what the State builds>"'],
    [['pr-signals'], 'pr-signals needs a pull request number'],
    [['handoff'], 'handoff takes one of --detect, --record or --assert-fresh'],
    [['brief', '--lint'], 'brief takes one draft file: niyam brief [--lint] <draft.md>'],
    [['cubic-dismiss', '--title'], '--title needs a value'],
    [['doc-number'], 'doc-number needs one document kind, such as adr'],
    [['renumber-doc'], 'renumber-doc needs a document kind and two four-digit numbers: renumber-doc <kind> <from> <to> [--apply]'],
    [['work-item-number', '--nope'], 'work-item-number: unexpected argument "--nope"'],
    [['board-audit', '--nope'], 'board-audit takes [owner/repo] [--project <title>], not "--nope"'],
  ] as const) {
    it(`refuses ${args.join(' ')} as bad usage before touching the machine`, async () => {
      assert.deepEqual(await capture(args), { code: 2, out: [], err: [`niyam: ${message}`, USAGE] });
    });
  }

  it('refuses owner-step with no such step as bad usage', async () => {
    const got = await capture(['owner-step', 'nope']);
    assert.equal(got.code, 2);
    assert.match(got.err[0] ?? '', /^niyam: owner-step has no step "nope"/);
  });

  it("hands pre-push git's remote and URL: an agent's push of a branch a merged pull request retired is refused", async () => {
    const pushing = (): FakeSys => {
      const sys = new FakeSys().acceptToken(TOKEN, AGENT);
      sys.env = { NIYAM_AGENT: AGENT, GH_TOKEN: TOKEN };
      sys.stdin = `refs/heads/work ${'a'.repeat(40)} refs/heads/work ${'b'.repeat(40)}\n`;
      sys.route('GET', '/repos/example-org/example-app/pulls?head=example-org%3Awork&state=all&per_page=20', {
        status: 200,
        json: [{ number: 9, html_url: 'https://github.com/example-org/example-app/pull/9', state: 'closed', merged_at: '2026-11-01T00:00:00Z', head: { ref: 'work' } }],
      });
      return sys;
    };
    const retired = await capture(['pre-push', 'origin', 'https://github.com/example-org/example-app.git'], pushing);
    assert.equal(retired.code, 1);
    assert.equal(retired.err.at(-1), 'pre-push: refused; a merged pull request retired this branch');
    const bare = await capture(['pre-push'], pushing);
    assert.equal(bare.code, 1);
    assert.equal(bare.err[0], '✗ git gave the pre-push hook no remote URL, so this push cannot be checked');
  });

  it('takes an issue number of any length, and nothing around it', () => {
    assert.deepEqual(proposeArgs(['123']), { numbers: [123] });
    assert.deepEqual(stateArgs(['123', '--title', 'x']), { slice: 123, title: 'x' });
    // '#' anywhere but first would be dropped as the first one is: '1#2' would read as 12.
    for (const bad of ['12x', 'x12', '1#2', '12#3']) {
      assert.throws(() => proposeArgs([bad]), { message: `propose needs an issue number, not "${bad}"` });
      assert.throws(() => stateArgs([bad, '--title', 'x']), { message: `state needs the slice's number, not "${bad}"` });
    }
  });
});

describe('packageVersion', () => {
  it('reads the version from package.json', () => {
    assert.equal(packageVersion(), expectedVersion);
  });
});

describe('versionOf', () => {
  for (const raw of [null, 'x', {}, { version: 1 }]) {
    it(`throws for ${JSON.stringify(raw)}`, () => {
      assert.throws(() => versionOf(raw), /no string "version"/);
    });
  }
});

describe('cli entry', () => {
  const cli = fileURLToPath(new URL('./cli.ts', import.meta.url));

  it('prints the version and exits 0', () => {
    assert.equal(
      execFileSync(process.execPath, [cli, '--version'], { encoding: 'utf8' }),
      `${String(expectedVersion)}\n`,
    );
  });

  it('exits 2 on an unknown command', () => {
    const result = spawnSync(process.execPath, [cli, 'nope'], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /unknown command "nope"/);
  });

  it('ships no process-rules bin, and names no old name to the owner (P-57)', () => {
    assert.equal(existsSync(fileURLToPath(new URL('./old-cli.ts', import.meta.url))), false);
    const help = spawnSync(process.execPath, [cli, 'help'], { encoding: 'utf8' });
    assert.equal(help.stderr, '');
    assert.doesNotMatch(help.stdout, /process-rules/);
  });
});

