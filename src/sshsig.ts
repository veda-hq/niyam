import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';

import { errorDetail } from './error-detail.ts';

/**
 * SSH signing in Node, for the hosted Claude cloud image, which has no
 * ssh-keygen (#425): the unencrypted ed25519 key an OpenSSH private key file
 * holds, and SSHSIG signatures over it, as `ssh-keygen -Y sign` makes them
 * and `ssh-keygen -Y verify` and GitHub check them (OpenSSH's PROTOCOL.sshsig
 * and PROTOCOL.key).
 */

const PEM_BEGIN = '-----BEGIN OPENSSH PRIVATE KEY-----';
const PEM_END = '-----END OPENSSH PRIVATE KEY-----';
const SIG_BEGIN = '-----BEGIN SSH SIGNATURE-----';
const SIG_END = '-----END SSH SIGNATURE-----';
const KEY_MAGIC = 'openssh-key-v1\0';
const SIG_MAGIC = 'SSHSIG';
const ED25519 = 'ssh-ed25519';
const HASH = 'sha512';

/** An ed25519 key pair: the 32-byte seed and public key. */
export interface Ed25519Key {
  seed: Buffer;
  publicKey: Buffer;
}

/** Reads SSH wire-format fields from a buffer, throwing on a field that runs past its end. */
class Reader {
  private at = 0;
  private readonly data: Buffer;
  constructor(data: Buffer) {
    this.data = data;
  }
  uint32(): number {
    if (this.at + 4 > this.data.length) throw new Error('it ends early');
    const value = this.data.readUInt32BE(this.at);
    this.at += 4;
    return value;
  }
  bytes(length: number): Buffer {
    if (this.at + length > this.data.length) throw new Error('it ends early');
    const value = this.data.subarray(this.at, this.at + length);
    this.at += length;
    return value;
  }
  string(): Buffer {
    return this.bytes(this.uint32());
  }
  text(): string {
    return this.string().toString('latin1');
  }
  get done(): boolean {
    return this.at === this.data.length;
  }
}

function field(value: Buffer | string): Buffer {
  const bytes = typeof value === 'string' ? Buffer.from(value, 'latin1') : value;
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  return Buffer.concat([length, bytes]);
}

/** The key's public blob, as SSH writes it: its type, then the 32 bytes. */
function publicBlob(publicKey: Buffer): Buffer {
  return Buffer.concat([field(ED25519), field(publicKey)]);
}

/**
 * The ed25519 key in an OpenSSH private key file's text, or why it cannot be
 * used: niyam signs with an unencrypted ed25519 key alone, which is what
 * `niyam cloud-key` makes.
 */
export function readPrivateKey(text: string): Ed25519Key | { problem: string } {
  const trimmed = text.trim();
  if (!trimmed.startsWith(PEM_BEGIN) || !trimmed.endsWith(PEM_END)) return { problem: 'it is not an OpenSSH private key' };
  const data = Buffer.from(trimmed.slice(PEM_BEGIN.length, -PEM_END.length).replace(/\s+/g, ''), 'base64');
  try {
    if (data.subarray(0, KEY_MAGIC.length).toString('latin1') !== KEY_MAGIC) return { problem: 'it is not an OpenSSH private key' };
    const reader = new Reader(data.subarray(KEY_MAGIC.length));
    const cipher = reader.text();
    const kdf = reader.text();
    reader.string();
    if (cipher !== 'none' || kdf !== 'none') return { problem: 'it has a passphrase, and niyam signs with a key that has none' };
    if (reader.uint32() !== 1) return { problem: 'it holds more than one key' };
    reader.string();
    const secret = new Reader(reader.string());
    if (secret.uint32() !== secret.uint32()) return { problem: 'its check numbers differ' };
    const type = secret.text();
    if (type !== ED25519) return { problem: `it is a ${type} key, and niyam signs with ed25519 alone` };
    const publicKey = secret.string();
    const both = secret.string();
    if (publicKey.length !== 32 || both.length !== 64 || !both.subarray(32).equals(publicKey)) return { problem: 'its ed25519 halves do not match' };
    return { seed: Buffer.from(both.subarray(0, 32)), publicKey: Buffer.from(publicKey) };
  } catch (error) {
    // fail-open: a key niyam cannot read is a problem the caller reports, never a crash.
    return { problem: `it cannot be read (${errorDetail(error)})` };
  }
}

/** The key's public half as a line of an authorized_keys file, with no comment. */
export function publicLine(key: Pick<Ed25519Key, 'publicKey'>): string {
  return `${ED25519} ${publicBlob(key.publicKey).toString('base64')}`;
}

function base64url(bytes: Buffer): string {
  return bytes.toString('base64url');
}

/** What SSHSIG signs: its preamble, the namespace, and the message's sha512. */
function signedData(message: Buffer, namespace: string): Buffer {
  return Buffer.concat([Buffer.from(SIG_MAGIC, 'latin1'), field(namespace), field(''), field(HASH), field(createHash(HASH).update(message).digest())]);
}

/** An armored SSHSIG signature of `message` by `key`, in `namespace`, as `ssh-keygen -Y sign` writes it. */
export function signMessage(key: Ed25519Key, message: Buffer, namespace: string): string {
  const privateKey = createPrivateKey({ key: { kty: 'OKP', crv: 'Ed25519', d: base64url(key.seed), x: base64url(key.publicKey) }, format: 'jwk' });
  const signature = sign(null, signedData(message, namespace), privateKey);
  const version = Buffer.alloc(4);
  version.writeUInt32BE(1);
  const blob = Buffer.concat([
    Buffer.from(SIG_MAGIC, 'latin1'),
    version,
    field(publicBlob(key.publicKey)),
    field(namespace),
    field(''),
    field(HASH),
    field(Buffer.concat([field(ED25519), field(signature)])),
  ]).toString('base64');
  return `${SIG_BEGIN}\n${blob.match(/.{1,70}/g)?.join('\n') ?? ''}\n${SIG_END}\n`;
}

/**
 * Whether `armored` is an SSHSIG signature of `message` in `namespace` by the
 * key whose public line is `publicKeyLine`; undefined when it is, else why not.
 */
export function signatureProblem(armored: string, message: Buffer, namespace: string, publicKeyLine: string): string | undefined {
  const trimmed = armored.trim();
  if (!trimmed.startsWith(SIG_BEGIN) || !trimmed.endsWith(SIG_END)) return 'it is not an SSH signature';
  try {
    const data = Buffer.from(trimmed.slice(SIG_BEGIN.length, -SIG_END.length).replace(/\s+/g, ''), 'base64');
    if (data.subarray(0, SIG_MAGIC.length).toString('latin1') !== SIG_MAGIC) return 'it is not an SSH signature';
    const reader = new Reader(data.subarray(SIG_MAGIC.length));
    if (reader.uint32() !== 1) return 'its version is not 1';
    const signer = reader.string();
    const signedNamespace = reader.text();
    reader.string();
    const hash = reader.text();
    const signature = new Reader(reader.string());
    if (!reader.done) return 'it has bytes after the signature';
    if (signedNamespace !== namespace) return `it is for the namespace "${signedNamespace}", not "${namespace}"`;
    if (hash !== HASH) return `it hashes with ${hash}, not ${HASH}`;
    if (`${ED25519} ${signer.toString('base64')}` !== publicKeyLine.trim().split(/\s+/).slice(0, 2).join(' ')) return 'another key made it';
    if (signature.text() !== ED25519) return 'it is not an ed25519 signature';
    const bytes = signature.string();
    const keyBytes = new Reader(signer);
    keyBytes.string();
    const publicKey = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: base64url(keyBytes.string()) }, format: 'jwk' });
    return verify(null, signedData(message, namespace), publicKey, bytes) ? undefined : 'the signature does not match';
  } catch (error) {
    // fail-open: a signature niyam cannot read is one that does not verify.
    return `it cannot be read (${errorDetail(error)})`;
  }
}

/**
 * A raw commit object split into what its SSH signature signs, the object
 * without its gpgsig header, and that signature; none when it has no gpgsig.
 */
export function commitSignature(raw: string): { payload: Buffer; signature: string } | undefined {
  const end = raw.indexOf('\n\n');
  const headers = (end === -1 ? raw : raw.slice(0, end)).split('\n');
  const rest = end === -1 ? '' : raw.slice(end);
  const kept: string[] = [];
  const signature: string[] = [];
  let inSignature = false;
  for (const line of headers) {
    if (line.startsWith('gpgsig ')) {
      inSignature = true;
      signature.push(line.slice('gpgsig '.length));
    } else if (inSignature && line.startsWith(' ')) {
      signature.push(line.slice(1));
    } else {
      inSignature = false;
      kept.push(line);
    }
  }
  if (signature.length === 0) return undefined;
  return { payload: Buffer.from(`${kept.join('\n')}${rest}`, 'utf8'), signature: `${signature.join('\n')}\n` };
}
