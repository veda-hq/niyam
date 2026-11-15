import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { describe, it } from 'node:test';

import { lockScript, pathsFor, sessionScript } from './agent.ts';
import { LOCKED } from './as-agent.ts';
import { RUN_UNDER, env, envArgs, envFailed, forEval } from './env.ts';
import { AGENT, AGENT_ID, FakeSys, HOME, TOKEN, capture, type Call } from './fake.test.ts';
import { run } from './run.ts';

const SESSION = pathsFor(HOME, AGENT).session;
const SCRIPT = sessionScript(AGENT, AGENT_ID, pathsFor(HOME, AGENT));
const LOCK = forEval(lockScript(HOME));
const BOTH = forEval(`${lockScript(HOME)}\n${SCRIPT}`);
const FIX = 'ask example-owner to run niyam machine ExampleBot (niyam doctor ExampleBot names what is missing)';

/** A Mac `machine` has set up, with a shell outside Claude Code: no CLAUDE_ENV_FILE, no CLAUDECODE. */
function ready(): FakeSys {
  const sys = new FakeSys().ready();
  sys.env = { PATH: '/usr/bin:/bin' };
  sys.files.set(SESSION, SCRIPT);
  sys.execOverride = (call) => (call.interactive ? { code: 3, stdout: '', stderr: '' } : undefined);
  return sys;
}

function envIn(sys: FakeSys, args: string[] = []): { code: number; out: string[]; err: string[]; ran: Call[] } {
  const { io, out, err } = capture();
  const before = sys.calls.length;
  const code = env(sys, io, envArgs(args));
  noToken({ out, err });
  return { code, out, err, ran: sys.calls.slice(before).filter((call) => call.interactive) };
}

/** No path through `env` puts the token in what it prints or says. */
function noToken(result: { out: string[]; err: string[] }): void {
  for (const line of [...result.out, ...result.err]) assert.ok(!line.includes(TOKEN), line);
}

describe('env', () => {
  it('prints the lock, then the session file machine wrote, and says the shell works as the agent', () => {
    const result = envIn(ready());
    assert.equal(result.code, 0);
    assert.deepEqual(result.out, [BOTH]);
    assert.deepEqual(result.err, ['niyam: this shell works as ExampleBot on GitHub.']);
    noToken(result);
  });

  it('prints the lock alone, exits locked and says why, when the session file is missing or not machine\'s', () => {
    for (const script of [undefined, `${SCRIPT}echo hi\n`]) {
      const sys = ready();
      if (script === undefined) sys.files.delete(SESSION);
      else sys.files.set(SESSION, script);
      const result = envIn(sys);
      assert.equal(result.code, LOCKED);
      assert.deepEqual(result.out, [LOCK]);
      const why = script === undefined ? `${SESSION} is missing` : `${SESSION} is out of date, or not the file niyam machine writes, for ExampleBot`;
      assert.deepEqual(result.err, [`niyam: GitHub is locked out of this shell: ${why}. Do not work around the lock; ${FIX}.`]);
      noToken(result);
    }
  });

  it('still gives the session file, and exits locked, when the token store has no token', () => {
    const sys = ready();
    sys.keychain.clear();
    const result = envIn(sys);
    assert.equal(result.code, LOCKED);
    assert.deepEqual(result.out, [BOTH]);
    assert.match(result.err[0] ?? '', /has no ExampleBot token, so GitHub refuses gh and git/);
  });

  it('prints the lock alone outside a repo with settings, or on a platform with no token store', () => {
    const outside = ready();
    outside.inRepo = false;
    const linux = ready();
    linux.platform = 'linux';
    for (const sys of [outside, linux]) {
      const result = envIn(sys);
      assert.equal(result.code, LOCKED);
      assert.deepEqual(result.out, [LOCK]);
      assert.match(result.err[0] ?? '', /^niyam: GitHub is locked out of this shell: .*; tell (example-owner|the owner)\.$/);
    }
  });

  it('runs a command under the lines through /bin/sh, passing its exit code through', () => {
    const result = envIn(ready(), ['--', 'codex', '--full-auto']);
    assert.equal(result.code, 3);
    assert.deepEqual(result.out, []);
    assert.deepEqual(result.err, ['niyam: this shell works as ExampleBot on GitHub.']);
    assert.deepEqual(result.ran.map((call) => [call.command, call.args]), [
      ['/bin/sh', ['-c', RUN_UNDER, 'niyam env', `${lockScript(HOME)}\n${SCRIPT}`, 'codex', '--full-auto']],
    ]);
    assert.equal(result.ran[0]?.env, undefined, 'the token is read by the shell, not passed in');
    noToken(result);
  });

  it('runs the command locked when the shell cannot work as the agent, and says why', () => {
    const sys = ready();
    sys.files.delete(SESSION);
    const result = envIn(sys, ['--', 'aider']);
    assert.equal(result.code, 3);
    assert.deepEqual(result.ran.map((call) => call.args[3]), [lockScript(HOME)]);
    assert.match(result.err[0] ?? '', /^niyam: GitHub is locked out of this shell: /);
  });

  it('says why the shell could not start the command', () => {
    const sys = ready();
    sys.execOverride = (call) => (call.interactive ? { code: 127, stdout: '', stderr: 'spawn /bin/sh ENOENT' } : undefined);
    const result = envIn(sys, ['--', 'codex']);
    assert.equal(result.code, 127);
    assert.equal(result.err.at(-1), 'niyam env: codex: spawn /bin/sh ENOENT');
  });

  it('takes nothing, or a command after --', () => {
    assert.deepEqual(envArgs([]), { args: [] });
    assert.deepEqual(envArgs(['--', 'codex', 'a']), { command: 'codex', args: ['a'] });
    assert.throws(() => envArgs(['--shell']), /put -- before the command, not "--shell"/);
    assert.throws(() => envArgs(['--']), /needs a command after --/);
  });

  it('prints the lock alone when its own check fails, or runs nothing', () => {
    const printed = capture();
    assert.equal(envFailed(HOME, printed.io, envArgs([]), new Error('boom')), LOCKED);
    assert.deepEqual(printed.out, [LOCK]);
    assert.deepEqual(printed.err, ['niyam: GitHub is locked out of this shell, because the check failed: boom']);
    const ran = capture();
    assert.equal(envFailed(HOME, ran.io, envArgs(['--', 'codex']), 'boom'), LOCKED);
    assert.deepEqual(ran.out, []);
    assert.deepEqual(ran.err, ['niyam env: ran nothing, because the check failed: boom']);
  });

  it('is run by the CLI, whose own failures still lock', async () => {
    const { io, out, err } = capture();
    assert.equal(await run(['env', 'extra'], io, () => ready()), 2);
    assert.match(err[0] ?? '', /put -- before the command/);
    assert.equal(await run(['env'], io, () => ready()), 0);
    assert.equal(out.at(-1), BOTH);
    assert.equal(await run(['env', '--', 'codex'], io, () => ready()), 3);
    assert.equal(await run(['env'], io, () => { throw new Error('boom'); }), LOCKED);
    assert.equal(out.at(-1), forEval(lockScript(homedir())));
    const broken = ready();
    broken.read = () => {
      throw new Error('disk gone');
    };
    assert.equal(await run(['env'], io, () => broken), LOCKED);
    assert.equal(out.at(-1), LOCK);
  });
});

describe('env, run by a real shell', () => {
  const vars = 'printf "%s|%s|%s|%s" "$NIYAM_AGENT" "$GIT_CONFIG_VALUE_5" "$GIT_SSH_COMMAND" "${GITHUB_TOKEN-unset}"';

  it('gives the same variables whether its output is evaluated quoted or not, with no comment swallowing the rest', () => {
    const printed = forEval(`${lockScript(HOME)}\n${SCRIPT}`);
    assert.ok(!printed.includes('#'), printed);
    const seen = ['eval "$1"', 'eval $1'].map((evaluate) => {
      const ran = spawnSync('/bin/sh', ['-c', `${evaluate}; ${vars}`, 'sh', printed], { encoding: 'utf8', timeout: 10_000, env: { PATH: '/usr/bin:/bin', GITHUB_TOKEN: 'inherited' } });
      assert.equal(ran.status, 0, ran.stderr);
      return ran.stdout;
    });
    assert.equal(seen[1], seen[0]);
    assert.match(seen[0] ?? '', /^ExampleBot\|!f\(\) \{ test "\$1" = get && printf 'username=%s\\npassword=%s\\n' ExampleBot "\$GH_TOKEN"; \}; f\|echo 'niyam: SSH is off/);
    assert.match(seen[0] ?? '', /\|unset$/);
  });

  it('runs the lines, then the command in their place, with its arguments', () => {
    const ran = spawnSync('/bin/sh', ['-c', RUN_UNDER, 'niyam env', "export NIYAM_AGENT='ExampleBot'\nunset OTHER\n", 'sh', '-c', 'printf "%s %s %s" "$NIYAM_AGENT" "${OTHER-unset}" "$0"', 'arg zero'], {
      encoding: 'utf8',
      timeout: 10_000,
      env: { PATH: '/usr/bin:/bin', OTHER: 'x' },
    });
    assert.equal(ran.status, 0);
    assert.equal(ran.stdout, 'ExampleBot unset arg zero');
  });

  it('runs nothing when the lines fail', () => {
    const ran = spawnSync('/bin/sh', ['-c', RUN_UNDER, 'niyam env', 'false', 'echo', 'ran'], { encoding: 'utf8', timeout: 10_000 });
    assert.notEqual(ran.status, 0);
    assert.equal(ran.stdout, '');
  });
});
