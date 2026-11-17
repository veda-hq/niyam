import assert from 'node:assert/strict';
import { type SpawnSyncReturns, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { noreplyEmail, pathsFor } from './agent.ts';
import { realSys } from './sys.ts';
import type { Sys } from './types.ts';
import { CLOUD_DIR, CLOUD_NODE, CLOUD_NODE_SHA256, FROM_SETUP, INSTALL_FAILED as FAILED, PROXY_TOKEN, SIGNING_KEY_VAR, cloudRepoScript, cloudSigning, cloudScriptVersion, cloudSetup, cloudSetupHelp, cloudSetupSnippet, cloudToken, fileFromSetup, ranFromSetup, releaseTarball, repoReleases } from './cloud.ts';
import { CLOUD_SETUP_068 } from './older-texts.test.ts';
import { workflow } from './onboard.ts';
import { AGENT, AGENT_ID, FakeSys, capture } from './fake.test.ts';
import { CLOUD_SETUP_PATH, LEFTOVER_CLOUD_SETUP_PATH, WORKFLOW_PATH } from './onboard-pull.ts';

const SHA = 'ab'.repeat(32);

describe('cloudToken', () => {
  it("takes a token the environment set, else the proxy's placeholder, never the lock's; 0.6.9's lock token is one GitHub refuses (P-57)", () => {
    const sys = new FakeSys();
    for (const [token, used] of [[undefined, PROXY_TOKEN], ['', PROXY_TOKEN], ['niyam-no-agent-token', PROXY_TOKEN], ['process-rules-no-agent-token', 'process-rules-no-agent-token'], ['ghp_set', 'ghp_set']] as const) {
      sys.env = { GH_TOKEN: token };
      assert.equal(cloudToken(sys), used, String(token));
    }
  });
});

describe('the cloud files under their names since P-56, the ones before not read (P-57)', () => {
  it('installs under /opt/niyam, and takes the Setup mark there alone', () => {
    assert.equal(CLOUD_DIR, '/opt/niyam');
    assert.equal(FROM_SETUP, '/opt/niyam/from-setup');
    for (const [marks, ran] of [[[], false], [[FROM_SETUP], true], [['/opt/process-rules/from-setup'], false]] as const) {
      const sys = new FakeSys();
      for (const mark of marks) sys.files.set(mark, '');
      assert.equal(ranFromSetup(sys), ran, marks.join(', '));
    }
  });

  it('names the file the Setup snippet ran, from the path its mark holds, when that is the cloud setup file', () => {
    for (const [marks, file] of [
      [{}, undefined],
      [{ [FROM_SETUP]: `/home/u/example-app/${CLOUD_SETUP_PATH}\n` }, CLOUD_SETUP_PATH],
      [{ [FROM_SETUP]: `/home/u/example-app/${LEFTOVER_CLOUD_SETUP_PATH}\n` }, undefined],
      [{ '/opt/process-rules/from-setup': '' }, undefined],
      [{ [FROM_SETUP]: '' }, undefined],
    ] as const) {
      const sys = new FakeSys();
      for (const [path, text] of Object.entries(marks)) sys.files.set(path, text);
      assert.equal(fileFromSetup(sys), file, JSON.stringify(marks));
    }
  });

  it("reads the repo's workflow and cloud setup file under their names alone", () => {
    const root = '/repo';
    const at = (files: Record<string, string>) => {
      const sys = new FakeSys();
      for (const [path, text] of Object.entries(files)) sys.files.set(`${root}/${path}`, text);
      return repoReleases(sys, root);
    };
    const none = { pinned: undefined, scripted: undefined, workflow: WORKFLOW_PATH, script: CLOUD_SETUP_PATH };
    assert.deepEqual(at({}), none);
    assert.deepEqual(at({ '.github/workflows/process-rules.yml': workflow('main', '0.6.8', false), [LEFTOVER_CLOUD_SETUP_PATH]: CLOUD_SETUP_068 }), none);
    assert.deepEqual(at({ [WORKFLOW_PATH]: workflow('main', '0.7.0', false), [CLOUD_SETUP_PATH]: cloudRepoScript('0.7.0', SHA) }), { ...none, pinned: '0.7.0', scripted: '0.7.0' });
  });
});

describe('cloudScriptVersion', () => {
  it('reads the release the cloud setup file installs, and nothing from another file', () => {
    assert.equal(cloudScriptVersion(cloudRepoScript('9.8.7', SHA)), '9.8.7');
    assert.equal(cloudScriptVersion('#!/bin/bash\necho hi\n'), undefined);
  });
});

describe('cloudRepoScript', () => {
  const script = cloudRepoScript('9.8.7', SHA);

  it('installs Node and that release of the CLI, each checked, and puts niyam on PATH', () => {
    assert.match(script, /^#!\/bin\/bash\n# niyam 9\.8\.7 for Claude cloud sessions/);
    assert.ok(script.includes(`node=${CLOUD_NODE}\n`));
    assert.ok(script.includes('https://nodejs.org/dist/v$node/node-v$node-linux-$arch.tar.xz'));
    assert.ok(script.includes(`-o "$dir/niyam.tgz" ${releaseTarball('9.8.7')}\n`));
    assert.equal(releaseTarball('9.8.7'), 'https://github.com/veda-hq/niyam/releases/download/v9.8.7/veda-hq-niyam-9.8.7.tgz');
    assert.equal(releaseTarball('0.6.1'), 'https://github.com/veda-hq/niyam/releases/download/v0.6.1/veda-hq-niyam-0.6.1.tgz', 'niyam\'s archive alone: onboard pins only its own release (P-57)');
    assert.ok(script.includes('rm -f /usr/local/bin/niyam /usr/local/bin/process-rules\n'), 'the command before niyam removed as a leftover');
    assert.deepEqual(script.match(/process-rules|PROCESS_RULES/g), ['process-rules'], 'named only in that removal (P-57)');
    assert.equal(cloudScriptVersion(script), '9.8.7');
    assert.equal(cloudScriptVersion('# process-rules 0.6.6 for Claude cloud sessions: Node'), undefined, 'a file a release before P-53 wrote');
    assert.ok(script.includes(`echo "${SHA}  $dir/niyam.tgz" | sha256sum -c --quiet -\n`));
    assert.ok(script.includes(`at the version ${WORKFLOW_PATH} pins`));
    assert.equal(spawnSync('bash', ['-n', '-c', script]).status, 0, 'bash reads it');
  });

  describe('run by a real shell, with the downloads stood in for', () => {
    const dir = mkdtempSync(join(tmpdir(), 'niyam-cloud-'));
    after(() => rmSync(dir, { recursive: true, force: true }));

    /**
     * Runs the script in a folder of its own, with curl, tar, uname and sha256sum stood in: sha256sum exits
     * `checked`, and `node`, when given, is a Node already unpacked that answers its version so.
     */
    function setup(name: string, checked: number, options: { node?: string; env?: Record<string, string>; before?: (local: string) => void; file?: string } = {}) {
      const root = join(dir, name);
      const bin = join(root, 'bin');
      const local = join(root, 'local');
      const opt = join(root, 'opt');
      mkdirSync(bin, { recursive: true });
      mkdirSync(local);
      options.before?.(local);
      const log = join(root, 'fetched');
      writeFileSync(join(bin, 'curl'), '#!/bin/sh\nwhile [ $# -gt 0 ]; do case "$1" in -o) out=$2; shift ;; https*) url=$1 ;; esac; shift; done\necho "$url" > "$out"\n', { mode: 0o755 });
      writeFileSync(join(bin, 'tar'), `#!/bin/sh\ncat "$3" >> "${log}"\necho "$5" >> "${log}"\n`, { mode: 0o755 });
      writeFileSync(join(bin, 'uname'), '#!/bin/sh\necho aarch64\n', { mode: 0o755 });
      writeFileSync(join(bin, 'sha256sum'), `#!/bin/sh\ncat >> "${root}/checked"\nexit ${checked}\n`, { mode: 0o755 });
      if (options.node) {
        const nodeBin = join(opt, `node-v${CLOUD_NODE}-linux-arm64`, 'bin');
        mkdirSync(nodeBin, { recursive: true });
        writeFileSync(join(nodeBin, 'node'), `#!/bin/sh\necho ${options.node}\n`, { mode: 0o755 });
      }
      // /opt and /usr/local/bin become folders under `root`.
      const runnable = cloudRepoScript('9.8.7', SHA)
        .replaceAll(CLOUD_DIR, opt)
        .replaceAll('/usr/local/bin/process-rules', join(local, 'process-rules'))
        .replaceAll('/usr/local/bin/niyam', join(local, 'niyam'))
        .replace('niyam version', 'true');
      // Run as the snippet runs it, from the repo's file, when one is named.
      let args = ['-c', runnable];
      if (options.file) {
        const file = join(root, 'example-app', options.file);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, runnable);
        args = [file];
      }
      const result = spawnSync('bash', args, { encoding: 'utf8', env: { PATH: `${bin}:/usr/bin:/bin`, ...options.env } });
      const read = (path: string): string => (existsSync(path) ? readFileSync(path, 'utf8') : '');
      return { result, opt, local, fetched: read(log), checked: read(join(root, 'checked')) };
    }

    it('writes a niyam that runs the CLI with that Node, once each matches its sha256', () => {
      const { result, opt, local, fetched, checked } = setup('good', 0);
      assert.deepEqual({ status: result.status, stdout: result.stdout, stderr: result.stderr }, { status: 0, stdout: '', stderr: '' });
      assert.equal(checked, `${CLOUD_NODE_SHA256.arm64}  ${opt}/node.tar.xz\n${SHA}  ${opt}/niyam.tgz\n`);
      assert.equal(
        readFileSync(join(local, 'niyam'), 'utf8'),
        `#!/bin/sh\nexec ${opt}/node-v${CLOUD_NODE}-linux-arm64/bin/node ${opt}/cli-9.8.7/package/dist/cli.js "$@"\n`,
      );
      assert.equal(fetched, `https://nodejs.org/dist/v${CLOUD_NODE}/node-v${CLOUD_NODE}-linux-arm64.tar.xz\n${opt}\n${releaseTarball('9.8.7')}\n${opt}/cli-9.8.7\n`);
      assert.equal(existsSync(join(opt, 'from-setup')), false, 'not run by the Setup snippet');
    });

    it("replaces a release's before P-53, where niyam linked to process-rules, and removes that leftover", () => {
      const { result, local } = setup('older', 0, {
        before: (dir) => {
          writeFileSync(join(dir, 'process-rules'), '#!/bin/sh\nexec old\n', { mode: 0o755 });
          symlinkSync(join(dir, 'process-rules'), join(dir, 'niyam'));
        },
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(lstatSync(join(local, 'niyam')).isSymbolicLink(), false, 'niyam is a file of its own now');
      assert.match(readFileSync(join(local, 'niyam'), 'utf8'), /cli-9\.8\.7\/package\/dist\/cli\.js/);
      assert.equal(existsSync(join(local, 'process-rules')), false, 'the command before niyam is gone');
    });

    it('keeps a Node already unpacked at its version, fetching the CLI alone', () => {
      const { result, opt, fetched, checked } = setup('kept', 0, { node: `v${CLOUD_NODE}` });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(checked, `${SHA}  ${opt}/niyam.tgz\n`);
      assert.equal(fetched, `${releaseTarball('9.8.7')}\n${opt}/cli-9.8.7\n`);
      const other = setup('other', 0, { node: 'v22.0.0' });
      assert.match(other.fetched, /^https:\/\/nodejs\.org\//, 'another Node is fetched again');
    });

    it('leaves a mark naming the file it ran from when the Setup snippet ran it, by NIYAM_SETUP alone (P-57)', () => {
      const { result, opt } = setup('marked', 0, { env: { NIYAM_SETUP: '1' }, file: CLOUD_SETUP_PATH });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(readFileSync(join(opt, 'from-setup'), 'utf8'), `${join(dir, 'marked', 'example-app', CLOUD_SETUP_PATH)}\n`);
      const old = setup('old-mark', 0, { env: { PROCESS_RULES_SETUP: '1' }, file: CLOUD_SETUP_PATH });
      assert.equal(old.result.status, 0, old.result.stderr);
      assert.equal(existsSync(join(old.opt, 'from-setup')), false, 'the snippet pasted before P-56 sets the old name alone');
    });

    it('stops, unpacking nothing and writing no niyam, when a download does not match its sha256', () => {
      const { result, local, fetched } = setup('bad', 1);
      assert.equal(result.status, 1);
      assert.equal(fetched, '');
      assert.equal(existsSync(join(local, 'niyam')), false);
      const cli = setup('bad-cli', 1, { node: `v${CLOUD_NODE}` });
      assert.equal(cli.result.status, 1);
      assert.equal(cli.fetched, '');
    });

    it('stops on a machine with no Node build', () => {
      const bin = join(dir, 'odd');
      mkdirSync(bin, { recursive: true });
      writeFileSync(join(bin, 'uname'), '#!/bin/sh\necho riscv64\n', { mode: 0o755 });
      const result = spawnSync('bash', ['-c', cloudRepoScript('9.8.7', SHA)], { encoding: 'utf8', env: { PATH: `${bin}:/usr/bin:/bin` } });
      assert.deepEqual({ status: result.status, stderr: result.stderr }, { status: 1, stderr: 'niyam: no Node for riscv64\n' });
    });
  });
});

describe('cloudSetupSnippet', () => {
  const snippet = cloudSetupSnippet();

  it('names no version, so a new release needs no new paste', () => {
    assert.doesNotMatch(snippet, /\d+\.\d+\.\d+/);
    assert.ok(snippet.includes(CLOUD_SETUP_PATH));
    assert.equal(spawnSync('bash', ['-n', '-c', snippet]).status, 0, 'bash reads it');
  });

  it('runs in a shell of its own, so it can go first in a Setup script', () => {
    const lines = snippet.trimEnd().split('\n');
    assert.match(lines[2] ?? '', /^bash <<'NIYAM' \|\| echo ".*" >&2$/);
    assert.equal(lines.at(-1), 'NIYAM');
    assert.equal(lines.filter((line) => line === 'NIYAM').length, 1);
    assert.equal(lines.slice(0, 3).some((line) => /^set /.test(line)), false, "the repo's own setup after it keeps its shell options");
  });

  describe('run by a real shell', () => {
    const dir = mkdtempSync(join(tmpdir(), 'niyam-snippet-'));
    after(() => rmSync(dir, { recursive: true, force: true }));
    const then = 'echo "repo setup ran"\nexit 0\n';

    /** The homes the snippet searches, beside the folder it runs from. */
    const HOMES = ' /home/*/*/"$file" /root/*/"$file"';
    /**
     * Runs the snippet, then the repo's own setup, from `cwd`, as the Setup script runs from the folder holding the
     * clone. Its homes are under `machine`, a folder the test made, so it never finds a real clone, such as a cloud
     * session's own at /home/user/<repo>, whose install would replace this machine's niyam (#428).
     */
    function setup(cwd: string, machine = join(dir, 'no-homes')) {
      const hermetic = snippet.replace(HOMES, ` ${machine}/home/*/*/"$file" ${machine}/root/*/"$file"`);
      assert.notEqual(hermetic, snippet, 'the snippet searches the homes the test moves');
      const result = spawnSync('bash', ['-c', `${hermetic}${then}`], { cwd, encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
      return { status: result.status, stdout: result.stdout, stderr: result.stderr };
    }

    /** A clone at `clone` whose cloud setup file, at `file`, says which it is, how it ran, and exits `code`. */
    function clone(at: string, code = 0, file: string = CLOUD_SETUP_PATH): void {
      mkdirSync(join(at, dirname(file)), { recursive: true });
      writeFileSync(join(at, file), `echo "ran ${file} mark=$NIYAM_SETUP,\${PROCESS_RULES_SETUP-unset} stdin=$(cat)"\nexit ${code}\n`);
    }
    const RAN = `ran ${CLOUD_SETUP_PATH} mark=1,unset stdin=\nrepo setup ran\n`;

    it("runs the clone's cloud setup file from the folder that holds the clone, then the repo's own setup", () => {
      const home = join(dir, 'home');
      clone(join(home, 'example-app'));
      assert.deepEqual(setup(home), { status: 0, stdout: RAN, stderr: '' });
    });

    it("runs it from a clone in a user's home or root's, as a cloud session's, wherever the Setup script starts", () => {
      for (const home of ['home/user', 'root']) {
        const machine = join(dir, `machine-${home.replace('/', '-')}`);
        clone(join(machine, home, 'example-app'));
        const elsewhere = join(machine, 'elsewhere');
        mkdirSync(elsewhere);
        assert.deepEqual(setup(elsewhere, machine), { status: 0, stdout: RAN, stderr: '' }, home);
      }
    });

    it('runs it from the clone itself', () => {
      const app = join(dir, 'app');
      clone(app);
      assert.deepEqual(setup(app), { status: 0, stdout: RAN, stderr: '' });
    });

    it('runs no file under its name before P-56 (P-57)', () => {
      assert.doesNotMatch(snippet, /process-rules|PROCESS_RULES/);
      const old = join(dir, 'old');
      clone(join(old, 'example-app'), 0, LEFTOVER_CLOUD_SETUP_PATH);
      assert.equal(setup(old).stdout, 'repo setup ran\n');
      const both = join(dir, 'both');
      clone(join(both, 'example-app'), 0, LEFTOVER_CLOUD_SETUP_PATH);
      clone(join(both, 'example-app'));
      assert.deepEqual(setup(both), { status: 0, stdout: RAN, stderr: '' });
    });

    it("says so when the install fails, and runs the repo's own setup", () => {
      const home = join(dir, 'failing');
      clone(join(home, 'example-app'), 1);
      assert.deepEqual(setup(home), { status: 0, stdout: RAN, stderr: `${FAILED}\n` });
    });

    it('names the missing file and its fix, and goes on', () => {
      const empty = join(dir, 'empty');
      mkdirSync(empty);
      assert.deepEqual(setup(empty), {
        status: 0,
        stdout: 'repo setup ran\n',
        stderr: `niyam: no ${CLOUD_SETUP_PATH} in the clone under ${realpathSync(empty)}; run niyam onboard, which writes it\n${FAILED}\n`,
      });
    });
  });
});

describe('cloudSigning, with real git, and real ssh-keygen only to check it', () => {
  it("signs a real commit as the agent's key with no ssh-keygen, over the platform's signing, with the agent as author and committer, and gives nothing for a key GitHub does not list or no key", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'niyam-cloud-signing-'));
    try {
      await signsInClone(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** The real-git test of `cloudSigning` in the folder `dir`, which the test removes. */
async function signsInClone(dir: string): Promise<void> {
  // No config of the machine running the tests, and no housekeeping that could race the cleanup.
  const gitEnv: Record<string, string> = { PATH: process.env.PATH ?? '', HOME: `${dir}/home`, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const run = (command: string, args: string[], env: Record<string, string> = gitEnv, cwd = `${dir}/repo`): SpawnSyncReturns<string> => {
    const ran = spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: 30_000 });
    assert.equal(ran.status, 0, `${command} ${args.join(' ')}: ${ran.stderr}`);
    return ran;
  };
  {
    mkdirSync(`${dir}/home`);
    mkdirSync(`${dir}/repo`);
    for (const name of ['agent', 'platform']) run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', name, '-f', `${dir}/${name}`], gitEnv, dir);
    run('git', ['init', '-q']);
    // The platform signs through a program of its own, which the agent's signing must not reach.
    writeFileSync(`${dir}/shim`, '#!/bin/sh\necho "the platform shim ran" >&2\nexit 1\n', { mode: 0o755 });
    // The platform's own identity and signing, in the clone's config, as a cloud image sets it up with its own key.
    for (const [key, value] of [
      ['gpg.ssh.program', `${dir}/shim`],
      ['maintenance.auto', 'false'],
      ['gc.auto', '0'],
      ['user.name', 'Claude'],
      ['user.email', 'noreply@anthropic.com'],
      ['gpg.format', 'ssh'],
      ['user.signingkey', `${dir}/platform.pub`],
      ['commit.gpgsign', 'true'],
    ] as const) run('git', ['config', key, value]);
  }
  const agentPub = readFileSync(`${dir}/agent.pub`, 'utf8');
  // The hosted image has no ssh-keygen (#425): one that says it ran and fails stands first on PATH while niyam signs.
  mkdirSync(`${dir}/no-keygen`);
  writeFileSync(`${dir}/no-keygen/ssh-keygen`, `#!/bin/sh\necho "$@" >> "${dir}/keygen-ran"\nexit 127\n`, { mode: 0o755 });
  const cloudEnv = { ...gitEnv, PATH: `${dir}/no-keygen:${gitEnv.PATH}` };
  const sysWith = (listed: string, key = readFileSync(`${dir}/agent`).toString('base64')): Sys => ({
    ...realSys(),
    home: `${dir}/home`,
    env: { ...cloudEnv, [SIGNING_KEY_VAR]: key },
    runtime: { node: process.execPath, cli: fileURLToPath(new URL('./cli.ts', import.meta.url)) },
    http: () => Promise.resolve({ status: 200, json: [{ key: listed }], headers: {} }),
  });

  const signing = await cloudSigning(sysWith(agentPub), `${dir}/repo`, AGENT, AGENT_ID);
  assert.ok('vars' in signing, JSON.stringify(signing));
  const env = { ...cloudEnv, ...Object.fromEntries(signing.vars) };
  run('git', ['commit', '-q', '--allow-empty', '-m', 'work'], env);
  const commit = run('git', ['cat-file', 'commit', 'HEAD'], env).stdout;
  assert.match(commit, /^author ExampleBot <42\+ExampleBot@users\.noreply\.github\.com> /m);
  assert.match(commit, /^committer ExampleBot <42\+ExampleBot@users\.noreply\.github\.com> /m);
  assert.equal(existsSync(`${dir}/keygen-ran`), false, 'no ssh-keygen ran to sign or check the probe');
  // Real ssh-keygen, as GitHub checks it, verifies what niyam's signer made.
  writeFileSync(`${dir}/agent-signers`, `${noreplyEmail(AGENT_ID, AGENT)} ${agentPub}`);
  run('git', ['-c', 'gpg.ssh.program=ssh-keygen', '-c', `gpg.ssh.allowedSignersFile=${dir}/agent-signers`, 'verify-commit', 'HEAD']);
  assert.equal(lstatSync(pathsFor(`${dir}/home`, AGENT).key).mode & 0o777, 0o600, 'the key is private');

  const other = readFileSync(`${dir}/platform.pub`, 'utf8');
  assert.match(JSON.stringify(await cloudSigning(sysWith(other), `${dir}/repo`, AGENT, AGENT_ID)), /GitHub does not list NIYAM_SIGNING_KEY's public half as one of ExampleBot's signing keys/);
  assert.match(JSON.stringify(await cloudSigning(sysWith(agentPub, 'bm90IGEga2V5'), `${dir}/repo`, AGENT, AGENT_ID)), /NIYAM_SIGNING_KEY is not an OpenSSH private key/);
  const platformKey = readFileSync(`${dir}/platform`).toString('base64');
  const platformSigning = await cloudSigning(sysWith(agentPub, platformKey), `${dir}/repo`, AGENT, AGENT_ID);
  assert.match(JSON.stringify(platformSigning), /GitHub does not list NIYAM_SIGNING_KEY's public half/, 'another key than the one GitHub lists');
}

describe('cloudSetup', () => {
  it('prints the Setup snippet with its instructions as comment lines on standard output, and nothing on standard error (#333)', () => {
    const { io, out, err } = capture();
    assert.equal(cloudSetup(io), 0);
    assert.deepEqual(err, [], 'nothing hidden behind a pipe');
    assert.equal(out.length, 1);
    const lines = (out[0] as string).split('\n');
    const snippet = cloudSetupSnippet().trimEnd().split('\n');
    assert.deepEqual(lines, [snippet[0], ...cloudSetupHelp(), ...snippet.slice(1)], 'the shebang first, then the instructions, then the snippet');
    assert.ok(cloudSetupHelp().every((line) => line.startsWith('# ')), 'each instruction a comment, so the pasted script runs as before');
    const help = cloudSetupHelp().join('\n');
    assert.match(help, /Paste all of this at the top of the Claude cloud environment's Setup script, once \(https:\/\/claude\.ai\/code/);
    assert.match(help, /runs the clone's \.github\/niyam\/cloud-setup\.sh, which niyam onboard keeps at the version the repo pins/);
    assert.match(help, /its own Setup script, put this first, then the repo's own: a repo's script may end with exit/);
    assert.match(help, /claude\.ai's GitHub connected as the agent the repo's settings name/);
  });
});
