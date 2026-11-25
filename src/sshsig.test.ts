import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { capture, openSshKey } from './fake.test.ts';
import { run } from './run.ts';
import { signerScript, sshSign } from './ssh-sign.ts';
import { commitSignature, newKey, privateKeyText, publicLine, readPrivateKey, signMessage, signatureProblem } from './sshsig.ts';

/** Runs real ssh-keygen in `dir`, failing the test on a non-zero exit unless `fails`. */
function keygen(dir: string, args: string[], input?: Buffer | string, fails = false): { stdout: string; stderr: string } {
  const ran = spawnSync('ssh-keygen', args, { cwd: dir, input, encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL' });
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

  it('writes a key, made in memory, that ssh-keygen reads with its comment and signs with (#437)', () => {
    inTemp((dir) => {
      const key = newKey();
      const text = privateKeyText(key, 'ExampleBot cloud signing');
      assert.match(text, /^-----BEGIN OPENSSH PRIVATE KEY-----\n(?:.{70}\n)*.{1,70}\n-----END OPENSSH PRIVATE KEY-----\n$/);
      writeFileSync(join(dir, 'made'), text, { mode: 0o600 });
      assert.match(keygen(dir, ['-l', '-f', 'made']).stdout, /^256 SHA256:\S+ ExampleBot cloud signing \(ED25519\)\n$/);
      assert.equal(keygen(dir, ['-y', '-f', 'made']).stdout.trim().split(' ').slice(0, 2).join(' '), publicLine(key));
      const message = Buffer.from('payload\n');
      writeFileSync(join(dir, 'message'), message);
      keygen(dir, ['-Y', 'sign', '-n', 'git', '-f', 'made', 'message']);
      assert.equal(signatureProblem(readFileSync(join(dir, 'message.sig'), 'utf8'), message, 'git', publicLine(key)), undefined);
      assert.deepEqual(readPrivateKey(text), key);
      assert.notDeepEqual(newKey().seed, key.seed, 'a new key each time');
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

describe('sshsig, byte by byte (#628)', () => {
  const u32 = (value: number): Buffer => {
    const bytes = Buffer.alloc(4);
    bytes.writeUInt32BE(value);
    return bytes;
  };
  const f = (value: Buffer | string): Buffer => {
    const bytes = typeof value === 'string' ? Buffer.from(value, 'latin1') : value;
    return Buffer.concat([u32(bytes.length), bytes]);
  };
  const PEM = ['-----BEGIN OPENSSH PRIVATE KEY-----', '-----END OPENSSH PRIVATE KEY-----'] as const;
  const SIG = ['-----BEGIN SSH SIGNATURE-----', '-----END SSH SIGNATURE-----'] as const;
  const armored = ([begin, end]: readonly [string, string], bytes: Buffer): string => `${begin}\n${bytes.toString('base64')}\n${end}\n`;
  const unarmored = (text: string): Buffer => Buffer.from(text.split('\n').slice(1, -2).join(''), 'base64');
  const key = newKey();
  const blob = Buffer.concat([f('ssh-ed25519'), f(key.publicKey)]);

  interface KeyParts { magic?: string; cipher?: string; kdf?: string; count?: number; checks?: readonly [number, number]; type?: string; pub?: Buffer; secretTail?: Buffer }
  const keyText = (parts: KeyParts = {}): string => {
    const pub = parts.pub ?? key.publicKey;
    const [one, two] = parts.checks ?? [7, 7];
    const secret = Buffer.concat([u32(one), u32(two), f(parts.type ?? 'ssh-ed25519'), f(pub), parts.secretTail ?? Buffer.concat([f(Buffer.concat([key.seed, pub])), f('comment')])]);
    return armored(PEM, Buffer.concat([Buffer.from(parts.magic ?? 'openssh-key-v1\0', 'latin1'), f(parts.cipher ?? 'none'), f(parts.kdf ?? 'none'), f(''), u32(parts.count ?? 1), f(blob), f(secret)]));
  };

  it('reads each field of a key file, and names each way one is wrong', () => {
    assert.deepEqual(readPrivateKey(keyText()), key);
    const other = Buffer.alloc(32, 9);
    for (const [parts, problem] of [
      [{ magic: 'openssh-key-v2\0' }, 'it is not an OpenSSH private key'],
      [{ cipher: 'aes256-ctr' }, 'it has a passphrase, and niyam signs with a key that has none'],
      [{ kdf: 'bcrypt' }, 'it has a passphrase, and niyam signs with a key that has none'],
      [{ count: 2 }, 'it holds more than one key'],
      [{ checks: [1, 2] }, 'its check numbers differ'],
      [{ pub: key.publicKey.subarray(0, 31) }, 'its ed25519 halves do not match'],
      [{ secretTail: Buffer.concat([f(Buffer.concat([key.seed.subarray(0, 31), key.publicKey])), f('c')]) }, 'its ed25519 halves do not match'],
      [{ secretTail: Buffer.concat([f(Buffer.concat([key.seed, other])), f('c')]) }, 'its ed25519 halves do not match'],
      // A last field that ends exactly at the end is read; one that runs past it is not.
      [{ secretTail: f(Buffer.alloc(0)) }, 'its ed25519 halves do not match'],
      [{ secretTail: Buffer.concat([u32(64), key.seed.subarray(0, 20)]) }, 'it cannot be read (it ends early)'],
    ] as const) {
      assert.deepEqual(readPrivateKey(keyText(parts)), { problem }, JSON.stringify(parts));
    }
    for (const [from, to] of [[PEM[0], '-'.repeat(PEM[0].length)], [PEM[1], '-'.repeat(PEM[1].length)]] as const) {
      assert.deepEqual(readPrivateKey(keyText().replace(from, to)), { problem: 'it is not an OpenSSH private key' }, to);
    }
  });

  it('writes a key file field by field, its comment in UTF-8, padded as OpenSSH pads it', () => {
    const data = unarmored(privateKeyText(key, 'büro'));
    const head = Buffer.concat([Buffer.from('openssh-key-v1\0', 'latin1'), f('none'), f('none'), f(''), u32(1), f(blob)]);
    assert.deepEqual(data.subarray(0, head.length), head);
    const secret = data.subarray(head.length + 4);
    assert.equal(data.readUInt32BE(head.length), secret.length);
    assert.deepEqual(secret.subarray(0, 4), secret.subarray(4, 8));
    const fields = Buffer.concat([f('ssh-ed25519'), f(key.publicKey), f(Buffer.concat([key.seed, key.publicKey])), f(Buffer.from('büro', 'utf8'))]);
    const padding = Buffer.from(Array.from({ length: (8 - ((8 + fields.length) % 8)) % 8 }, (_, i) => i + 1));
    assert.deepEqual(secret.subarray(8), Buffer.concat([fields, padding]));
  });

  it('writes a signature field by field, in lines of 70, for any latin1 namespace', () => {
    const message = Buffer.from('payload\n');
    const text = signMessage(key, message, 'gït');
    assert.match(text, /^-----BEGIN SSH SIGNATURE-----\n(?:.{70}\n)*.{1,70}\n-----END SSH SIGNATURE-----\n$/);
    const data = unarmored(text);
    const head = Buffer.concat([Buffer.from('SSHSIG'), u32(1), f(blob), f('gït'), f(''), f('sha512'), u32(4 + 11 + 4 + 64), f('ssh-ed25519'), u32(64)]);
    assert.deepEqual(data.subarray(0, head.length), head);
    assert.equal(data.length, head.length + 64);
    assert.equal(signatureProblem(text, message, 'gït', publicLine(key)), undefined);
  });

  interface SigParts { magic?: string; version?: number; namespace?: string; hash?: string; type?: string; tail?: Buffer }
  const sigText = (parts: SigParts = {}): string =>
    armored(SIG, Buffer.concat([Buffer.from(parts.magic ?? 'SSHSIG'), u32(parts.version ?? 1), f(blob), f(parts.namespace ?? 'git'), f(''), f(parts.hash ?? 'sha512'), f(Buffer.concat([f(parts.type ?? 'ssh-ed25519'), f(Buffer.alloc(64))])), parts.tail ?? Buffer.alloc(0)]));

  it('reads each field of a signature, and names each way one is wrong', () => {
    const message = Buffer.from('payload\n');
    const check = (text: string, line = publicLine(key)): string | undefined => signatureProblem(text, message, 'git', line);
    assert.equal(check(sigText()), 'the signature does not match');
    for (const [parts, problem] of [
      [{ magic: 'SSHSIX' }, 'it is not an SSH signature'],
      [{ version: 2 }, 'its version is not 1'],
      [{ tail: Buffer.from([0]) }, 'it has bytes after the signature'],
      [{ hash: 'sha256' }, 'it hashes with sha256, not sha512'],
      [{ type: 'ssh-rsa' }, 'it is not an ed25519 signature'],
    ] as const) {
      assert.equal(check(sigText(parts)), problem, JSON.stringify(parts));
    }
    for (const [from, to] of [[SIG[0], '-'.repeat(SIG[0].length)], [SIG[1], '-'.repeat(SIG[1].length)]] as const) {
      assert.equal(check(sigText().replace(from, to)), 'it is not an SSH signature', to);
    }
    assert.equal(check(armored(SIG, Buffer.from('SSHSIG'))), 'it cannot be read (it ends early)');
    // The key's line is read for its type and body alone, past spaces and a comment.
    const [type, body] = publicLine(key).split(' ');
    for (const line of [`  ${type} ${body}  agent's key \n`, `${type}  ${body}`]) assert.equal(check(sigText(), line), 'the signature does not match', line);
  });
});

describe('commitSignature', () => {
  it('reads a commit with no message, and a signature among other headers, continued or not', () => {
    assert.deepEqual(commitSignature('tree abc\ngpgsig -----BEGIN\n END'), { payload: Buffer.from('tree abc'), signature: '-----BEGIN\nEND\n' });
    assert.deepEqual(commitSignature(' odd\ngpgsig S\n\nm'), { payload: Buffer.from(' odd\n\nm'), signature: 'S\n' });
    assert.deepEqual(commitSignature('tree a\n cont\ngpgsig S\n more\nmergetag x\n mcont\n\nm'), {
      payload: Buffer.from('tree a\n cont\nmergetag x\n mcont\n\nm'),
      signature: 'S\nmore\n',
    });
  });

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
