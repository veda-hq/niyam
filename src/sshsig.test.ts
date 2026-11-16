import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { capture, openSshKey } from './fake.test.ts';
import { run } from './run.ts';
import { signerScript, sshSign } from './ssh-sign.ts';
import { commitSignature, publicLine, readPrivateKey, signMessage, signatureProblem } from './sshsig.ts';

/** Runs real ssh-keygen in `dir`, failing the test on a non-zero exit unless `fails`. */
function keygen(dir: string, args: string[], input?: Buffer | string, fails = false): { stdout: string; stderr: string } {
  const ran = spawnSync('ssh-keygen', args, { cwd: dir, input, encoding: 'utf8', timeout: 30_000 });
  if (!fails) assert.equal(ran.status, 0, `ssh-keygen ${args.join(' ')}: ${ran.stderr}`);
  return { stdout: ran.stdout, stderr: ran.stderr };
}

function inTemp(test: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'niyam-sshsig-'));
  try {
    test(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('sshsig, against real ssh-keygen', () => {
  it("reads a key ssh-keygen made as ssh-keygen does, and ssh-keygen reads the test's keys", () => {
    inTemp((dir) => {
      keygen(dir, ['-q', '-t', 'ed25519', '-N', '', '-C', 'made', '-f', 'made']);
      const key = readPrivateKey(readFileSync(join(dir, 'made'), 'utf8'));
      assert.ok(!('problem' in key), JSON.stringify(key));
      assert.equal(publicLine(key), readFileSync(join(dir, 'made.pub'), 'utf8').trim().split(' ').slice(0, 2).join(' '));
      const ours = openSshKey();
      writeFileSync(join(dir, 'ours'), ours.pem, { mode: 0o600 });
      assert.equal(keygen(dir, ['-y', '-f', 'ours']).stdout.trim().split(' ').slice(0, 2).join(' '), ours.publicLine);
      const read = readPrivateKey(ours.pem);
      assert.ok(!('problem' in read));
      assert.equal(publicLine(read), ours.publicLine);
    });
  });

  it('signs so that ssh-keygen -Y verify accepts it, and verifies what ssh-keygen -Y sign made', () => {
    inTemp((dir) => {
      keygen(dir, ['-q', '-t', 'ed25519', '-N', '', '-C', 'agent', '-f', 'agent']);
      const key = readPrivateKey(readFileSync(join(dir, 'agent'), 'utf8'));
      assert.ok(!('problem' in key));
      const message = Buffer.from('tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904\nauthor A <a@b> 1 +0000\n\nwork ünïcode\n');
      writeFileSync(join(dir, 'signers'), `agent@example.com namespaces="git" ${publicLine(key)}\n`);
      writeFileSync(join(dir, 'ours.sig'), signMessage(key, message, 'git'));
      const verified = keygen(dir, ['-Y', 'verify', '-f', 'signers', '-I', 'agent@example.com', '-n', 'git', '-s', 'ours.sig'], message);
      assert.match(verified.stdout, /Good "git" signature for agent@example\.com/);
      keygen(dir, ['-Y', 'verify', '-f', 'signers', '-I', 'agent@example.com', '-n', 'file', '-s', 'ours.sig'], message, true);

      writeFileSync(join(dir, 'message'), message);
      keygen(dir, ['-Y', 'sign', '-n', 'git', '-f', 'agent', 'message']);
      const theirs = readFileSync(join(dir, 'message.sig'), 'utf8');
      assert.equal(signatureProblem(theirs, message, 'git', publicLine(key)), undefined);
      assert.equal(signatureProblem(theirs, Buffer.from('other'), 'git', publicLine(key)), 'the signature does not match');
      assert.equal(signatureProblem(theirs, message, 'file', publicLine(key)), 'it is for the namespace "git", not "file"');
      assert.equal(signatureProblem(theirs, message, 'git', openSshKey().publicLine), 'another key made it');
      assert.equal(signatureProblem('not one', message, 'git', publicLine(key)), 'it is not an SSH signature');
    });
  });

  it('refuses a key with a passphrase, one not ed25519, and text that is no key', () => {
    inTemp((dir) => {
      keygen(dir, ['-q', '-t', 'ed25519', '-N', 'secret phrase', '-f', 'locked']);
      assert.deepEqual(readPrivateKey(readFileSync(join(dir, 'locked'), 'utf8')), { problem: 'it has a passphrase, and niyam signs with a key that has none' });
      keygen(dir, ['-q', '-t', 'ecdsa', '-N', '', '-f', 'ecdsa']);
      assert.deepEqual(readPrivateKey(readFileSync(join(dir, 'ecdsa'), 'utf8')), { problem: 'it is a ecdsa-sha2-nistp256 key, and niyam signs with ed25519 alone' });
    });
    assert.deepEqual(readPrivateKey('nope'), { problem: 'it is not an OpenSSH private key' });
    assert.match(JSON.stringify(readPrivateKey('-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEA\n-----END OPENSSH PRIVATE KEY-----')), /it cannot be read \(it ends early\)/);
  });
});

describe('commitSignature', () => {
  it("splits a raw commit into the object without its gpgsig and that signature, as git signs it", () => {
    const raw = 'tree abc\nauthor A <a@b> 1 +0000\ncommitter A <a@b> 1 +0000\ngpgsig -----BEGIN SSH SIGNATURE-----\n U1NIU0lH\n -----END SSH SIGNATURE-----\n\nwork\n\nSlice: #1\n';
    assert.deepEqual(commitSignature(raw), {
      payload: Buffer.from('tree abc\nauthor A <a@b> 1 +0000\ncommitter A <a@b> 1 +0000\n\nwork\n\nSlice: #1\n'),
      signature: '-----BEGIN SSH SIGNATURE-----\nU1NIU0lH\n-----END SSH SIGNATURE-----\n',
    });
    assert.equal(commitSignature('tree abc\n\nwork\n'), undefined);
  });
});

describe('ssh-sign, the command git runs', () => {
  it('writes <file>.sig with the private key beside the .pub git names, as ssh-keygen -Y sign does', () => {
    inTemp((dir) => {
      const key = openSshKey();
      writeFileSync(join(dir, 'agent'), key.pem, { mode: 0o600 });
      writeFileSync(join(dir, 'agent.pub'), `${key.publicLine} agent\n`);
      writeFileSync(join(dir, 'buffer'), 'payload\n');
      const { io, err } = capture();
      assert.equal(sshSign(io, ['-Y', 'sign', '-n', 'git', '-f', join(dir, 'agent.pub'), join(dir, 'buffer')]), 0, err.join('\n'));
      assert.equal(signatureProblem(readFileSync(join(dir, 'buffer.sig'), 'utf8'), Buffer.from('payload\n'), 'git', key.publicLine), undefined);
    });
  });

  it('refuses what it does not do, naming it, and writes nothing', () => {
    inTemp((dir) => {
      const key = openSshKey();
      writeFileSync(join(dir, 'agent'), key.pem, { mode: 0o600 });
      writeFileSync(join(dir, 'buffer'), 'payload\n');
      const sign = (args: string[]): string[] => {
        const { io, err } = capture();
        assert.equal(sshSign(io, args), 1);
        return err;
      };
      const f = join(dir, 'agent');
      const b = join(dir, 'buffer');
      assert.deepEqual(sign(['-Y', 'verify', '-n', 'git']), ['niyam ssh-sign: signs only, as ssh-keygen -Y sign does; asked for -Y verify']);
      assert.deepEqual(sign(['-Y', 'sign', '-n', 'git', '-f', f, '-U', b]), ['niyam ssh-sign: cannot sign with a key in an agent (-U); user.signingkey must name the key file']);
      assert.deepEqual(sign(['-Y', 'sign', '-f', f, b]), ['niyam ssh-sign: no namespace (-n)']);
      assert.deepEqual(sign(['-Y', 'sign', '-n', 'git', b]), ['niyam ssh-sign: no key (-f)']);
      assert.deepEqual(sign(['-Y', 'sign', '-n', 'git', '-f', f]), ['niyam ssh-sign: no file to sign']);
      assert.deepEqual(sign(['-Y', 'sign', '-n', 'git', '-f', f, '-x', b]), ['niyam ssh-sign: unknown option -x']);
      assert.match(sign(['-Y', 'sign', '-n', 'git', '-f', join(dir, 'none'), b])[0] ?? '', /^niyam ssh-sign: cannot read the key .*none \(ENOENT/);
      assert.equal(existsSync(`${b}.sig`), false);
    });
  });

  it('runs from niyam as a command of its own, and its script names the Node and CLI quoted', async () => {
    const { io, err } = capture();
    assert.equal(await run(['ssh-sign', '-Y', 'find-principals'], io, () => assert.fail('needs no system')), 1);
    assert.deepEqual(err, ['niyam ssh-sign: signs only, as ssh-keygen -Y sign does; asked for -Y find-principals']);
    assert.equal(signerScript("/opt/node's/bin/node", '/opt/niyam/cli.js'), "#!/bin/sh\n# Written by niyam session-start: git's SSH signer for this cloud session, which has no ssh-keygen.\nexec '/opt/node'\\''s/bin/node' '/opt/niyam/cli.js' ssh-sign \"$@\"\n");
  });
});
