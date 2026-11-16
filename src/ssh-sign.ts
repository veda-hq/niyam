import { readFileSync, writeFileSync } from 'node:fs';

import { quote } from './agent.ts';
import { errorDetail } from './error-detail.ts';
import { readPrivateKey, signMessage } from './sshsig.ts';
import type { Output } from './types.ts';

/** The command git runs as `gpg.ssh.program` in a cloud session niyam signs for (#425). */
export const SSH_SIGN = 'ssh-sign';

/**
 * The script git runs as `gpg.ssh.program`: niyam's own signer, with the
 * Node and CLI that wrote it, since git runs the program as a path alone.
 */
export function signerScript(node: string, cli: string): string {
  return ['#!/bin/sh', `# Written by niyam session-start: git's SSH signer for this cloud session, which has no ssh-keygen.`, `exec ${quote(node)} ${quote(cli)} ${SSH_SIGN} "$@"`, ''].join('\n');
}

/**
 * Signs as `ssh-keygen -Y sign -n <namespace> -f <key> <file>…` does, for
 * git's SSH signing where there is no ssh-keygen: each file's signature goes
 * to `<file>.sig`. The key is `-f`'s file, or, when that is a `.pub`, the
 * private key beside it, as git names `user.signingkey`. Only an unencrypted
 * ed25519 key, and only `-Y sign`: anything else fails, naming it.
 */
export function sshSign(io: Output, args: readonly string[]): number {
  const fail = (why: string): number => {
    io.err(`niyam ${SSH_SIGN}: ${why}`);
    return 1;
  };
  if (args[0] !== '-Y' || args[1] !== 'sign') return fail(`signs only, as ssh-keygen -Y sign does; asked for ${args.slice(0, 2).join(' ') || 'nothing'}`);
  let namespace: string | undefined;
  let keyFile: string | undefined;
  const files: string[] = [];
  for (let i = 2; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (arg === '-n' || arg === '-f') {
      const value = args[i + 1];
      if (value === undefined) return fail(`${arg} needs a value`);
      if (arg === '-n') namespace = value;
      else keyFile = value;
      i += 1;
    } else if (arg === '-U') {
      return fail('cannot sign with a key in an agent (-U); user.signingkey must name the key file');
    } else if (arg === '-q') {
      // Quiet already: it prints nothing on success.
    } else if (arg.startsWith('-')) {
      return fail(`unknown option ${arg}`);
    } else {
      files.push(arg);
    }
  }
  if (!namespace) return fail('no namespace (-n)');
  if (!keyFile) return fail('no key (-f)');
  if (files.length === 0) return fail('no file to sign');
  const privateFile = keyFile.endsWith('.pub') ? keyFile.slice(0, -'.pub'.length) : keyFile;
  let text: string;
  try {
    text = readFileSync(privateFile, 'utf8');
  } catch (error) {
    // fail-open: git reports the signing failure, with this line.
    return fail(`cannot read the key ${privateFile} (${errorDetail(error)})`);
  }
  const key = readPrivateKey(text);
  if ('problem' in key) return fail(`the key ${privateFile}: ${key.problem}`);
  for (const file of files) {
    try {
      writeFileSync(`${file}.sig`, signMessage(key, readFileSync(file), namespace), { mode: 0o644 });
    } catch (error) {
      // fail-open: git reports the signing failure, with this line.
      return fail(`cannot sign ${file} (${errorDetail(error)})`);
    }
  }
  return 0;
}
