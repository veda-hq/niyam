import assert from 'node:assert/strict';
import { type SpawnSyncReturns, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { authorVars, configVars, keyBody, noreplyEmail, pathsFor, signingConfig } from './agent.ts';
import { SSH_SIGN, signerScript } from './ssh-sign.ts';
import { newKey, privateKeyText, publicLine, signMessage } from './sshsig.ts';
import { realSys } from './sys.ts';
import type { ExecResult, HttpResult, Sys } from './types.ts';
import { CLOUD_DIR, CLOUD_NODE, CLOUD_NODE_SHA256, FROM_SETUP, INSTALL_FAILED as FAILED, PROXY_TOKEN, SIGNING_KEY_VAR, cloudLogin, cloudRepoScript, cloudSigning, cloudScriptVersion, cloudSetup, cloudSetupHelp, cloudSetupSnippet, cloudToken, fileFromSetup, ranFromSetup, releaseSha256, releaseTarball, repoReleases } from './cloud.ts';
import { tarballName } from './names.ts';
import { CLOUD_SETUP_068 } from './older-texts.test.ts';
import { workflow } from './onboard.ts';
import { AGENT, AGENT_ID, FakeSys, HOME, capture } from './fake.test.ts';
import { CLOUD_SETUP_PATH, LEFTOVER_CLOUD_SETUP_PATH, WORKFLOW_PATH } from './onboard-pull.ts';

const SHA = 'ab'.repeat(32);

describe('cloudToken', () => {
  it("takes a token the environment set, else the proxy's placeholder, never the lock's; 0.6.9's lock token is one GitHub refuses (P-57)", () => {
    const sys = new FakeSys();
    assert.equal(PROXY_TOKEN, 'proxy-injected', "the placeholder Claude Code's cloud environments docs name");
    for (const [token, used] of [[undefined, PROXY_TOKEN], ['', PROXY_TOKEN], ['niyam-no-agent-token', PROXY_TOKEN], ['process-rules-no-agent-token', 'process-rules-no-agent-token'], ['ghp_set', 'ghp_set']] as const) {
      sys.env = { GH_TOKEN: token };
      assert.equal(cloudToken(sys), used, String(token));
    }
  });
});

describe('cloudLogin', () => {
  /** What cloudLogin says when GitHub's `/user` answers `answer`, and the requests it made. */
  async function asked(answer: HttpResult | (() => HttpResult), env: Record<string, string | undefined> = {}) {
    const sys = new FakeSys();
    sys.env = env;
    sys.route('GET', '/user', answer);
    return { result: await cloudLogin(sys), requests: sys.requests };
  }

  it("asks GitHub's /user once, with the session's token, and names the login with a valid id", async () => {
    const { result, requests } = await asked({ status: 200, json: { login: AGENT, id: AGENT_ID } });
    assert.deepEqual(result, { login: AGENT, id: AGENT_ID });
    assert.deepEqual(requests, [{ url: 'https://api.github.com/user', method: 'GET', token: PROXY_TOKEN }]);
    assert.deepEqual((await asked({ status: 200, json: { login: AGENT, id: 1 } }, { GH_TOKEN: 'ghp_set' })).requests, [{ url: 'https://api.github.com/user', method: 'GET', token: 'ghp_set' }]);
    assert.deepEqual((await asked({ status: 200, json: { login: AGENT, id: 1 } })).result, { login: AGENT, id: 1 }, 'the smallest id is one');
  });

  it('names the login alone when the id is not a positive safe integer', async () => {
    for (const id of [undefined, 0, -1, 1.5, '42', Number.MAX_SAFE_INTEGER + 1, null]) {
      assert.deepEqual((await asked({ status: 200, json: { login: AGENT, id } })).result, { login: AGENT }, String(id));
    }
  });

  it('says what GitHub answered when it names no login', async () => {
    for (const [status, json] of [[401, null], [200, null], [200, { id: 42 }], [200, { login: 7, id: 42 }], [500, { login: AGENT, id: 42 }], [201, { login: AGENT, id: 42 }]] as const) {
      assert.deepEqual((await asked({ status, json })).result, { problem: `GitHub answered HTTP ${status} when asked who this session is` }, `${status} ${JSON.stringify(json)}`);
    }
  });

  it('says why GitHub could not be asked', async () => {
    const thrown = (error: unknown) => () => {
      throw error;
    };
    assert.deepEqual((await asked(thrown(new Error('timed out')))).result, { problem: 'GitHub could not be asked who this session is (timed out)' });
    assert.deepEqual((await asked(thrown('offline'))).result, { problem: 'GitHub could not be asked who this session is (offline)' });
  });
});

describe('releaseSha256', () => {
  const TAG = 'https://api.github.com/repos/veda-hq/niyam/releases/tags/v9.8.7';
  const NAME = tarballName('9.8.7');
  /** What releaseSha256 says when GitHub answers `answer` for v9.8.7, and the requests it made. */
  async function released(answer: HttpResult | (() => HttpResult)) {
    const sys = new FakeSys();
    sys.route('GET', TAG, answer);
    return { result: await releaseSha256(sys, '9.8.7', 'ghp_owner'), requests: sys.requests };
  }
  const noSha = { problem: `the v9.8.7 release names no sha256 for ${NAME}` };

  it("reads the sha256 GitHub records for the release's archive, asking with the token given", async () => {
    const { result, requests } = await released({ status: 200, json: { assets: [{ name: 'other.tgz', digest: `sha256:${'cd'.repeat(32)}` }, { name: NAME, digest: `sha256:${SHA}` }] } });
    assert.deepEqual(result, { sha256: SHA });
    assert.deepEqual(requests, [{ url: TAG, method: 'GET', token: 'ghp_owner' }]);
  });

  it('names no sha256 for an archive the release lacks, or a digest that is not one', async () => {
    for (const json of [
      null,
      {},
      { assets: [] },
      { assets: [{ name: 'other.tgz', digest: `sha256:${SHA}` }] },
      { assets: [{ name: NAME }] },
      { assets: [{ name: NAME, digest: 42 }] },
      { assets: [{ name: NAME, digest: [`sha256:${SHA}`] }] },
      { assets: [{ name: NAME, digest: SHA }] },
      { assets: [{ name: NAME, digest: `sha512:${SHA}` }] },
      { assets: [{ name: NAME, digest: `xsha256:${SHA}` }] },
      { assets: [{ name: NAME, digest: `sha256:${SHA}0` }] },
      { assets: [{ name: NAME, digest: `sha256:${SHA.slice(1)}` }] },
      { assets: [{ name: NAME, digest: `sha256:${SHA.toUpperCase()}` }] },
      { assets: [{ name: NAME, digest: `sha256:${'g'.repeat(64)}` }] },
    ]) {
      assert.deepEqual((await released({ status: 200, json })).result, noSha, JSON.stringify(json));
    }
  });

  it('says what GitHub answered for a release it does not serve, and why it could not be asked', async () => {
    assert.deepEqual((await released({ status: 404, json: { assets: [{ name: NAME, digest: `sha256:${SHA}` }] } })).result, { problem: 'GitHub answered HTTP 404 for the v9.8.7 release' });
    const thrown = (error: unknown) => () => {
      throw error;
    };
    assert.deepEqual((await released(thrown(new Error('timed out')))).result, { problem: 'GitHub could not be asked for the v9.8.7 release (timed out)' });
    assert.deepEqual((await released(thrown('offline'))).result, { problem: 'GitHub could not be asked for the v9.8.7 release (offline)' });
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
    const unreadable = new FakeSys();
    unreadable.files.set(FROM_SETUP, `/home/u/example-app/${CLOUD_SETUP_PATH}\n`);
    unreadable.read = () => {
      throw new Error('EACCES');
    };
    assert.equal(fileFromSetup(unreadable), undefined, 'a mark that cannot be read names none');
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
    const two = workflow('main', '0.7.0', false).replace('checks.yml@v0.7.0', 'checks.yml@v0.7.1');
    assert.notEqual(two, workflow('main', '0.7.0', false));
    assert.deepEqual(at({ [WORKFLOW_PATH]: two, [CLOUD_SETUP_PATH]: cloudRepoScript('0.7.0', SHA) }), { ...none, scripted: '0.7.0' }, 'a workflow that pins two releases pins none');
    assert.deepEqual(at({ [WORKFLOW_PATH]: 'name: niyam\n', [CLOUD_SETUP_PATH]: '#!/bin/bash\n' }), none, 'nor one that pins no release, beside a setup file onboard did not write');
  });

  it('reads nothing from a workflow or setup file that is there but cannot be read', () => {
    const sys = new FakeSys();
    sys.files.set(`/repo/${WORKFLOW_PATH}`, workflow('main', '0.7.0', false));
    sys.files.set(`/repo/${CLOUD_SETUP_PATH}`, cloudRepoScript('0.7.0', SHA));
    sys.read = () => {
      throw new Error('EACCES');
    };
    assert.deepEqual(repoReleases(sys, '/repo'), { pinned: undefined, scripted: undefined, workflow: WORKFLOW_PATH, script: CLOUD_SETUP_PATH });
  });
});

describe('cloudScriptVersion', () => {
  it('reads the release the cloud setup file installs, and nothing from another file', () => {
    assert.equal(cloudScriptVersion(cloudRepoScript('9.8.7', SHA)), '9.8.7');
    assert.equal(cloudScriptVersion('#!/bin/bash\necho hi\n'), undefined);
    assert.equal(cloudScriptVersion(cloudRepoScript('10.20.30', SHA)), '10.20.30', 'each part of the version any number of digits');
    assert.equal(cloudScriptVersion('#!/bin/bash\necho "# niyam 1.2.3 for Claude cloud sessions"\n'), undefined, 'only a line of its own that opens with the comment');
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

  it('is, word for word, the script onboard writes', () => {
    assert.equal(
      script,
      [
        '#!/bin/bash',
        '# niyam 9.8.7 for Claude cloud sessions: Node 24.21.0 and the CLI, as niyam on PATH.',
        '# niyam onboard writes this file at the version .github/workflows/niyam.yml pins, and writes it again on every run.',
        '# The SessionStart hook runs it when a session has no niyam, session-start when it has another release,',
        '# and the Setup script when it holds what niyam cloud-setup prints. Change it by running onboard, not by hand.',
        'set -euo pipefail',
        'dir=/opt/niyam',
        'node=24.21.0',
        'case "$(uname -m)" in x86_64) arch=x64 sum=fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6 ;; aarch64 | arm64) arch=arm64 sum=6ad1325edbdb5649c379b75a237147a666c95d4f9ae8d340fef2d1575d289ad2 ;; *) echo "niyam: no Node for $(uname -m)" >&2; exit 1 ;; esac',
        'bin="$dir/node-v$node-linux-$arch/bin/node"',
        'mkdir -p "$dir"',
        'if [ "$("$bin" --version 2>/dev/null)" != "v$node" ]; then',
        '  curl -fsSL --connect-timeout 10 --max-time 120 -o "$dir/node.tar.xz" "https://nodejs.org/dist/v$node/node-v$node-linux-$arch.tar.xz"',
        '  echo "$sum  $dir/node.tar.xz" | sha256sum -c --quiet -',
        '  tar -xJ -f "$dir/node.tar.xz" -C "$dir"',
        '  rm "$dir/node.tar.xz"',
        'fi',
        'curl -fsSL --connect-timeout 10 --max-time 120 -o "$dir/niyam.tgz" https://github.com/veda-hq/niyam/releases/download/v9.8.7/veda-hq-niyam-9.8.7.tgz',
        `echo "${'ab'.repeat(32)}  $dir/niyam.tgz" | sha256sum -c --quiet -`,
        'cli="$dir/cli-9.8.7"',
        'rm -rf "$cli"',
        'mkdir -p "$cli"',
        'tar -xz -f "$dir/niyam.tgz" -C "$cli"',
        'rm "$dir/niyam.tgz"',
        'rm -f /usr/local/bin/niyam /usr/local/bin/process-rules',
        String.raw`printf '#!/bin/sh\nexec %s %s "$@"\n' "$bin" "$cli/package/dist/cli.js" > /usr/local/bin/niyam`,
        'chmod 755 /usr/local/bin/niyam',
        'if [ -n "${NIYAM_SETUP:-}" ]; then printf \'%s\\n\' "$0" > /opt/niyam/from-setup; fi',
        'niyam version </dev/null',
        '',
      ].join('\n'),
    );
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

  it('is, word for word, the snippet cloud-setup prints', () => {
    assert.equal(
      snippet,
      [
        '#!/bin/bash',
        "# niyam for Claude cloud sessions: runs the clone's .github/niyam/cloud-setup.sh, which niyam onboard keeps at the version the repo pins. Paste once; put the repo's own setup after it.",
        `bash <<'NIYAM' || echo "niyam: the install failed, so sessions start without niyam; the rest of the Setup script still runs." >&2`,
        'file=.github/niyam/cloud-setup.sh',
        'for script in "$PWD/$file" "$PWD"/*/"$file" /home/*/*/"$file" /root/*/"$file"; do',
        '  if [ -f "$script" ]; then NIYAM_SETUP=1 exec bash "$script" </dev/null; fi',
        'done',
        'echo "niyam: no .github/niyam/cloud-setup.sh in the clone under $PWD; run niyam onboard, which writes it" >&2',
        'exit 1',
        'NIYAM',
        '',
      ].join('\n'),
    );
  });

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
  it("signs a real commit as the agent's key with no ssh-keygen, over the platform's signing, with the agent as author and committer, asking GitHub nothing, and gives nothing for a key the settings do not pin, none pinned, or no key", async () => {
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
    const ran = spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL' });
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
  const sysWith = (key = readFileSync(`${dir}/agent`).toString('base64')): Sys => ({
    ...realSys(),
    home: `${dir}/home`,
    env: { ...cloudEnv, [SIGNING_KEY_VAR]: key },
    runtime: { node: process.execPath, cli: fileURLToPath(new URL('./cli.ts', import.meta.url)) },
    // The proxy refuses the users/… paths (#447): the settings' pin stands in for GitHub's list, so nothing is asked.
    http: () => Promise.reject(new Error('cloudSigning asked GitHub')),
  });

  const signing = cloudSigning(sysWith(), `${dir}/repo`, AGENT, AGENT_ID, ['ssh-ed25519 AAAAother', keyBody(agentPub)]);
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

  const repo = `${dir}/repo`;
  const other = keyBody(readFileSync(`${dir}/platform.pub`, 'utf8'));
  assert.deepEqual(cloudSigning(sysWith(), repo, AGENT, AGENT_ID, [other]), {
    problem: `NIYAM_SIGNING_KEY's public half is not one of the cloud signing keys .github/niyam.json's "cloudSigningKeys" pins for ExampleBot; niyam onboard on the owner's Mac pins the ones GitHub lists`,
  });
  assert.deepEqual(cloudSigning(sysWith(), repo, AGENT, AGENT_ID, []), {
    problem: `.github/niyam.json's "cloudSigningKeys" pins no cloud signing key for ExampleBot, and this session cannot ask GitHub for ExampleBot's signing keys; niyam onboard on the owner's Mac pins the ones GitHub lists`,
  });
  assert.match(JSON.stringify(cloudSigning(sysWith('bm90IGEga2V5'), repo, AGENT, AGENT_ID, [keyBody(agentPub)])), /NIYAM_SIGNING_KEY is not an OpenSSH private key/);
  const platformKey = readFileSync(`${dir}/platform`).toString('base64');
  assert.match(JSON.stringify(cloudSigning(sysWith(platformKey), repo, AGENT, AGENT_ID, [keyBody(agentPub)])), /NIYAM_SIGNING_KEY's public half is not one of the cloud signing keys/, 'another key than the one pinned');
}

describe('cloudSigning, in-process, with git stood in for', () => {
  const ROOT = '/repo';
  const key = newKey();
  const pem = privateKeyText(key, 'agent').trim();
  const body = publicLine(key);
  const { dir, key: keyPath } = pathsFor(HOME, AGENT);
  const signer = `${dir}/${SSH_SIGN}`;
  const HEADERS = `tree tree1\nauthor ${AGENT} <a> 1 +0000\ncommitter ${AGENT} <a> 1 +0000`;
  const MESSAGE = '\n\nniyam: a probe\n';
  /** A raw commit object signed by `by`, as `git cat-file commit` prints one. */
  const signedCommit = (by = key): string => {
    const armored = signMessage(by, Buffer.from(`${HEADERS}${MESSAGE}`, 'utf8'), 'git');
    return `${HEADERS}\ngpgsig ${armored.trimEnd().split('\n').join('\n ')}${MESSAGE}`;
  };
  const ok = (stdout: string): ExecResult => ({ code: 0, stdout, stderr: '' });
  const failed = (stderr: string): ExecResult => ({ code: 3, stdout: '', stderr });

  /** A FakeSys whose environment holds `given` as the key (null: none), and whose git answers each probe step as `git` says. */
  function signingSys(given: string | null = Buffer.from(`${pem}\n`).toString('base64'), git: Record<string, ExecResult> = {}) {
    const sys = new FakeSys();
    sys.env = { PATH: '/bin', OTHER: 'kept', GH_TOKEN: 'niyam-no-agent-token', GIT_TERMINAL_PROMPT: '0', ...(given === null ? {} : { [SIGNING_KEY_VAR]: given }) };
    const steps: Record<string, ExecResult> = { mktree: ok('tree1\n'), 'commit-tree': ok('c0ffee\n'), 'cat-file': ok(signedCommit()), ...git };
    sys.execOverride = (call) => (call.command === 'git' ? steps[call.args[0] ?? ''] : undefined);
    return sys;
  }
  const sign = (sys: FakeSys, pinned: readonly string[] = ['ssh-ed25519 AAAAother', body], id: number | null = AGENT_ID) => cloudSigning(sys, ROOT, AGENT, id ?? undefined, pinned);
  const VARS = [...authorVars(AGENT, AGENT_ID), ...configVars([['gpg.ssh.program', signer], ...signingConfig(`${keyPath}.pub`)])];

  it("writes the key, its public half and niyam's signer, and gives the agent's variables once a probe commit verifies", () => {
    const sys = signingSys();
    assert.deepEqual(sign(sys), { vars: VARS });
    assert.deepEqual(sys.dirs, [dir, `${HOME}/.ssh`]);
    assert.equal(sys.files.get(keyPath), `${pem}\n`);
    assert.equal(sys.modes.get(keyPath), 0o600);
    assert.equal(sys.files.get(`${keyPath}.pub`), `${body} ${AGENT} cloud signing\n`);
    assert.equal(sys.modes.get(`${keyPath}.pub`), 0o644);
    assert.equal(sys.files.get(signer), signerScript(sys.runtime.node, sys.runtime.cli));
    assert.equal(sys.modes.get(signer), 0o755);
    // The probe runs in the clone, as the session's commands do: the lock and the key's variable unset, the rest kept.
    const env = { PATH: '/bin', OTHER: 'kept', ...Object.fromEntries(VARS) };
    assert.deepEqual(sys.calls, [
      { command: 'git', args: ['mktree'], cwd: ROOT, env },
      { command: 'git', args: ['commit-tree', '-S', 'tree1', '-m', "niyam: a probe of the agent's signing, never on a branch"], cwd: ROOT, env },
      { command: 'git', args: ['cat-file', 'commit', 'c0ffee'], cwd: ROOT, env },
    ]);
  });

  it('takes the key base64 on one line, or as is with its line breaks real or written as \\n, around any space', () => {
    for (const given of [Buffer.from(pem).toString('base64'), `  ${pem}\n`, pem.replaceAll('\n', '\\n'), ` ${pem.replaceAll('\n', '\\n')}\\n `]) {
      const sys = signingSys(given);
      assert.deepEqual(sign(sys), { vars: VARS }, given);
      assert.equal(sys.files.get(keyPath), `${pem}\n`, given);
    }
  });

  it('says what is missing before it writes anything: the key, or the account id', () => {
    const none = `the cloud environment's variables have no NIYAM_SIGNING_KEY, ${AGENT}'s cloud signing key (niyam's README, "Claude cloud sessions", says how to add one)`;
    for (const given of [null, '', ' \n ']) {
      const sys = signingSys(given);
      assert.deepEqual(sign(sys), { problem: none }, JSON.stringify(given));
      assert.deepEqual([sys.dirs, sys.calls], [[], []]);
    }
    const sys = signingSys();
    assert.deepEqual(sign(sys, [body], null), { problem: `GitHub named no account id for ${AGENT}` });
    assert.deepEqual([sys.dirs, sys.calls], [[], []]);
  });

  it('refuses what is not an OpenSSH private key, or one it cannot read', () => {
    const notKey = { problem: 'NIYAM_SIGNING_KEY is not an OpenSSH private key, base64 on one line or as is' };
    const [begin, ...rest] = pem.split('\n');
    const end = rest.at(-1) ?? '';
    for (const text of ['not a key', `${begin}\n${rest.slice(0, -1).join('\n')}`, `${rest.slice(0, -1).join('\n')}\n${end}`, `${begin}${rest.join('\n')}`, `${begin}\n${rest.slice(0, -1).join('\n')}${end}`, `x${pem}`, `${pem}x`]) {
      assert.deepEqual(sign(signingSys(Buffer.from(text).toString('base64'))), notKey, text);
    }
    const unreadable = sign(signingSys(`${begin}\nAAAA\n${end}`));
    assert.ok('problem' in unreadable && unreadable.problem.startsWith('NIYAM_SIGNING_KEY cannot be used: '), JSON.stringify(unreadable));
  });

  it('gives nothing for a key the settings do not pin, or when they pin none, writing nothing', () => {
    const pin = `.github/niyam.json's "cloudSigningKeys"`;
    const repin = `niyam onboard on the owner's Mac pins the ones GitHub lists`;
    const sys = signingSys();
    assert.deepEqual(sign(sys, []), { problem: `${pin} pins no cloud signing key for ${AGENT}, and this session cannot ask GitHub for ${AGENT}'s signing keys; ${repin}` });
    assert.deepEqual(sign(sys, ['ssh-ed25519 AAAAother']), { problem: `NIYAM_SIGNING_KEY's public half is not one of the cloud signing keys ${pin} pins for ${AGENT}; ${repin}` });
    assert.deepEqual([sys.dirs, sys.calls], [[], []]);
  });

  it('says why the key could not be written, and probes nothing', () => {
    for (const [thrown, why] of [[new Error('read-only'), 'read-only'], ['disk full', 'disk full']] as const) {
      const sys = signingSys();
      sys.write = () => {
        throw thrown;
      };
      assert.deepEqual(sign(sys), { problem: `writing NIYAM_SIGNING_KEY to ${keyPath} failed (${why})` });
      assert.deepEqual(sys.calls, []);
    }
  });

  it("names the probe's step that failed, by the last line it printed or its exit code", () => {
    const probe = (why: string) => ({ problem: `a probe commit signed with NIYAM_SIGNING_KEY did not verify as that key (${why})` });
    for (const step of ['mktree', 'commit-tree', 'cat-file']) {
      assert.deepEqual(sign(signingSys(undefined, { [step]: failed('warning: one\nfatal: two\n\n') })), probe(`git ${step}: fatal: two`), step);
      assert.deepEqual(sign(signingSys(undefined, { [step]: failed(' \n') })), probe(`git ${step}: exit 3`), step);
      assert.deepEqual(sign(signingSys(undefined, { [step]: failed('only') })), probe(`git ${step}: only`), step);
    }
    assert.deepEqual(sign(signingSys(undefined, { 'cat-file': ok(`${HEADERS}${MESSAGE}`) })), probe('the probe commit has no signature'));
    assert.deepEqual(sign(signingSys(undefined, { 'cat-file': ok(signedCommit(newKey())) })), probe('its signature: another key made it'));
  });

  it('takes the tree and commit git names, trimmed, into the next step', () => {
    const sys = signingSys(undefined, { mktree: ok('  tree1 \n'), 'commit-tree': ok(' c0ffee\n') });
    assert.ok('vars' in sign(sys));
    assert.deepEqual(sys.calls.map((call) => call.args), [['mktree'], ['commit-tree', '-S', 'tree1', '-m', "niyam: a probe of the agent's signing, never on a branch"], ['cat-file', 'commit', 'c0ffee']]);
  });
});

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
