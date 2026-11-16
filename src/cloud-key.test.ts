import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CLOUD_KEY_TITLE, cloudKey, cloudKeyArgs } from './cloud-key.ts';
import { AGENT, FakeSys, PRIVATE_KEY, PUBLIC_KEY, TOKEN, capture } from './fake.test.ts';
import { run } from './run.ts';
import type { ExecResult, HttpResult } from './types.ts';

const LIST = 'https://api.github.com/user/ssh_signing_keys?per_page=100';
const ADD = '/user/ssh_signing_keys';
/** The clipboard's line: the fake's private key, base64, as the cloud environment's variable. */
const LINE = `NIYAM_SIGNING_KEY=${Buffer.from(`${PRIVATE_KEY}\n`).toString('base64')}`;

/**
 * The owner's Mac, set up by `machine` for the agent, whose list on GitHub
 * holds the Mac key and `others`; GitHub registers the new key as id 99 and
 * lists it once added, and the clipboard takes what it is given.
 */
function mac(others: { id: number; title: string; created_at: string }[] = []): FakeSys & { clipboard: string[] } {
  const sys = Object.assign(new FakeSys().ready(), { clipboard: [] as string[] });
  sys.answers = ['yes'];
  let added = false;
  sys.route('GET', LIST, { status: 200, json: [{ id: 1, title: 'niyam signing', key: 'ssh-ed25519 AAAAmac', created_at: '2026-10-01T00:00:00Z' }, ...others] });
  // The fake's ssh-keygen writes PUBLIC_KEY, so the Mac key is another body and the new one shows only once added.
  sys.route('GET', ADD, () => ({ status: 200, json: added ? [{ key: 'ssh-ed25519 AAAAmac' }, { key: PUBLIC_KEY }] : [{ key: 'ssh-ed25519 AAAAmac' }] }));
  sys.route('POST', ADD, () => {
    added = true;
    return { status: 201, json: { id: 99, title: CLOUD_KEY_TITLE, key: PUBLIC_KEY } };
  });
  sys.route('DELETE', `${ADD}/99`, { status: 204, json: null });
  sys.execOverride = ({ command, input }): ExecResult | undefined => {
    if (command !== '/usr/bin/pbcopy') return undefined;
    sys.clipboard.push(input ?? '');
    return { code: 0, stdout: '', stderr: '' };
  };
  return sys;
}

async function key(sys: FakeSys, args: string[] = []): Promise<{ code: number; out: string[]; err: string[] }> {
  const { io, out, err } = capture();
  return { code: await cloudKey(sys, io, args), out, err };
}

describe('cloud-key', () => {
  it('registers a new key as the agent, puts it on the clipboard as the variable, and deletes the files', async () => {
    const sys = mac();
    const { code, out, err } = await key(sys);
    assert.equal(code, 0, err.join('\n'));
    assert.deepEqual(sys.chosen, ['Go ahead?']);
    const made = sys.calls.find((call) => call.command === 'ssh-keygen');
    assert.deepEqual(made?.args, ['-q', '-t', 'ed25519', '-C', 'ExampleBot cloud signing', '-N', '', '-f', '/tmp/niyam-1/key']);
    const posted = sys.requests.find((request) => request.method === 'POST');
    assert.deepEqual(posted?.body, { title: CLOUD_KEY_TITLE, key: PUBLIC_KEY });
    assert.equal(posted?.token, TOKEN, "the agent's stored token");
    assert.deepEqual(sys.clipboard, [LINE]);
    assert.ok(!out.join('\n').includes(Buffer.from(PRIVATE_KEY).toString('base64')) && !out.join('\n').includes(PRIVATE_KEY), 'the key is never printed');
    assert.ok(sys.removed.includes('/tmp/niyam-1'));
    assert.ok(![...sys.files.keys()].some((path) => path.startsWith('/tmp/niyam-1')), 'no key file left');
    assert.deepEqual(out.slice(2), [
      `✓ registered as ExampleBot's signing key "${CLOUD_KEY_TITLE}" (id 99)`,
      '✓ NIYAM_SIGNING_KEY=… is on the clipboard',
      "  Paste it as one line into the cloud environment's variables: https://claude.ai/code → the environment's settings.",
      "  A new session there makes ExampleBot's commits its own; its first niyam line says so.",
      '✓ deleted the key files',
    ]);
  });

  it("names the agent's other cloud signing keys to delete once unused, deleting none", async () => {
    const sys = mac([{ id: 5, title: CLOUD_KEY_TITLE, created_at: '2026-11-01T10:00:00Z' }, { id: 6, title: 'laptop', created_at: '2026-11-02T10:00:00Z' }]);
    const { code, out } = await key(sys);
    assert.equal(code, 0);
    assert.deepEqual(out.filter((line) => line.startsWith('▲')), [
      '▲ ExampleBot has another cloud signing key, added 2026-11-01 (id 5); delete it once no environment uses it → https://github.com/settings/keys, signed in as ExampleBot',
    ]);
    assert.ok(!sys.requests.some((request) => request.method === 'DELETE'));
  });

  it('changes nothing on a no, and asks nothing with --yes', async () => {
    const no = mac();
    no.answers = ['no'];
    assert.equal((await key(no)).code, 1);
    assert.ok(!no.calls.some((call) => call.command === 'ssh-keygen'));
    assert.ok(!no.requests.some((request) => request.method === 'POST'));
    const yes = mac();
    yes.answers = [];
    assert.equal((await key(yes, ['--yes'])).code, 0);
    assert.deepEqual(yes.chosen, []);
    const bare = mac();
    bare.tty = false;
    assert.deepEqual((await key(bare)).err, ['cloud-key: no terminal to ask in; pass --yes to go ahead without asking']);
  });

  it('refuses in an agent session or a cloud session, and without a usable token, before making anything', async () => {
    for (const env of [{ NIYAM_AGENT: AGENT }, { CLAUDECODE: '1' }, { CLAUDE_CODE_REMOTE: 'true' }]) {
      const sys = mac();
      sys.env = { ...sys.env, ...env };
      const { code, err } = await key(sys);
      assert.equal(code, 1);
      assert.deepEqual(err, ['cloud-key: run it in your own terminal on your Mac, not in an agent session; it registers a key as the agent']);
      assert.equal(sys.requests.length, 0);
    }
    const linux = mac();
    linux.platform = 'linux';
    assert.match((await key(linux)).err[0] ?? '', /^cloud-key: .*macOS/);
    const none = mac();
    none.keychain.clear();
    assert.deepEqual((await key(none)).err, ["cloud-key: this Mac's keychain has no ExampleBot token; run niyam machine ExampleBot first"]);
    const refused = mac();
    refused.acceptToken('another', AGENT);
    refused.route('GET', '/user', { status: 401, json: null });
    assert.match((await key(refused)).err[0] ?? '', /^cloud-key: the stored ExampleBot token cannot be used: .*; run niyam machine ExampleBot$/);
    const unlisted = mac();
    unlisted.route('GET', LIST, { status: 403, json: null });
    assert.deepEqual((await key(unlisted)).err, ["cloud-key: GitHub answered HTTP 403 when asked for ExampleBot's signing keys"]);
    for (const sys of [none, refused, unlisted]) assert.ok(!sys.calls.some((call) => call.command === 'ssh-keygen'));
  });

  it('deletes the key from GitHub again when it is not listed or the clipboard refuses it, since no one holds it', async () => {
    const unlisted = mac();
    unlisted.route('GET', ADD, { status: 200, json: [] });
    const notListed = await key(unlisted);
    assert.equal(notListed.code, 1);
    assert.ok(notListed.out.includes('✗ GitHub does not list it, so the key was deleted from GitHub again; nothing is on the clipboard'));
    assert.deepEqual(unlisted.clipboard, []);
    const full = mac();
    full.execOverride = ({ command }) => (command === '/usr/bin/pbcopy' ? { code: 1, stdout: '', stderr: 'pbcopy: no pasteboard' } : undefined);
    const refused = await key(full);
    assert.equal(refused.code, 1);
    assert.ok(refused.out.includes('✗ the clipboard did not take the key (pbcopy: no pasteboard), so the key was deleted from GitHub again; nothing is on the clipboard'));
    assert.ok(full.requests.some((request) => request.method === 'DELETE' && request.url.endsWith('/user/ssh_signing_keys/99')));
    const stuck = mac();
    stuck.route('GET', ADD, { status: 200, json: [] });
    stuck.route('DELETE', `${ADD}/99`, { status: 500, json: null });
    assert.ok((await key(stuck)).out.includes('✗ GitHub does not list it, and deleting the key from GitHub again failed (HTTP 500) → delete signing key 99 at https://github.com/settings/keys'));
    for (const sys of [unlisted, full, stuck]) assert.ok(sys.removed.includes('/tmp/niyam-1'), 'the files go whatever happened');
  });

  it('says what failed when ssh-keygen or the registration fails, with nothing on the clipboard', async () => {
    const broken = mac();
    broken.execOverride = ({ command }) => (command === 'ssh-keygen' ? { code: 1, stdout: '', stderr: 'no space' } : undefined);
    assert.ok((await key(broken)).out.includes('✗ ssh-keygen failed: no space'));
    const refused = mac();
    refused.route('POST', ADD, { status: 422, json: { message: 'key is already in use' } });
    const { code, out } = await key(refused);
    assert.equal(code, 1);
    assert.ok(out.includes("✗ GitHub did not register the key as ExampleBot's signing key (HTTP 422); nothing is on the clipboard"));
    assert.deepEqual(refused.clipboard, []);
  });

  it('removes the files at a Ctrl-C, deleting the key from GitHub again, and fails, naming the folder, when they cannot be removed', async () => {
    const sys = mac();
    const http = sys.http.bind(sys);
    sys.http = (url, options): Promise<HttpResult> => {
      if (options?.method === 'POST') sys.interrupt();
      return http(url, options);
    };
    const late = await key(sys);
    assert.equal(late.code, 130);
    assert.ok(sys.removed.includes('/tmp/niyam-1'), 'the Ctrl-C handler removed the folder');
    assert.ok(late.out.includes('✗ stopped by Ctrl-C, so the key was deleted from GitHub again; nothing is on the clipboard'));
    assert.deepEqual(sys.clipboard, []);
    const early = mac();
    early.execOverride = ({ command, args }) => {
      if (command !== 'ssh-keygen') return undefined;
      early.files.set(args.at(-1) ?? '', PRIVATE_KEY);
      early.files.set(`${args.at(-1) ?? ''}.pub`, PUBLIC_KEY);
      early.interrupt();
      return { code: 0, stdout: '', stderr: '' };
    };
    const first = await key(early);
    assert.equal(first.code, 130);
    assert.ok(first.out.includes('✗ stopped by Ctrl-C; nothing registered, and nothing on the clipboard'));
    assert.ok(!early.requests.some((request) => request.method === 'POST'));
    const stuck = mac();
    stuck.remove = (path) => {
      stuck.removed.push(path);
    };
    stuck.files.set('/tmp/niyam-1', '');
    const { code, out } = await key(stuck);
    assert.equal(code, 1);
    assert.equal(out.at(-1), '✗ could not delete /tmp/niyam-1, which holds the private key → rm -rf /tmp/niyam-1');
  });

  it('reads its arguments, and refuses others as bad usage', async () => {
    assert.deepEqual(cloudKeyArgs(['OtherBot', '--yes']), { named: 'OtherBot', yes: true });
    assert.deepEqual(cloudKeyArgs([]), {});
    assert.throws(() => cloudKeyArgs(['--dry-run']), /unknown option --dry-run/);
    assert.throws(() => cloudKeyArgs(['a', 'b']), /unexpected argument "b"/);
    const { io, err } = capture();
    assert.equal(await run(['cloud-key', '--nope'], io, () => mac()), 2);
    assert.equal(err[0], 'niyam: unknown option --nope');
    const ran = capture();
    assert.equal(await run(['cloud-key', '--yes'], ran.io, () => mac()), 0);
  });
});
