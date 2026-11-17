import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CLOUD_KEY_TITLE, cloudKey, cloudKeyArgs, cloudKeyRefusal, makeCloudKey } from './cloud-key.ts';
import { AGENT, FakeSys, TOKEN, capture, diskWrites, keyOnClipboard } from './fake.test.ts';
import { run } from './run.ts';
import type { ExecResult, HttpResult } from './types.ts';

const LIST = 'https://api.github.com/user/ssh_signing_keys?per_page=100';
const ADD = '/user/ssh_signing_keys';

/**
 * The owner's Mac, set up by `machine` for the agent, whose list on GitHub
 * holds the Mac key and `others`; GitHub registers the new key as id 99 and
 * lists it once added, and the clipboard takes what it is given.
 */
function mac(others: { id: number; title: string; created_at: string }[] = []): FakeSys & { clipboard: string[] } {
  const sys = Object.assign(new FakeSys().ready(), { clipboard: [] as string[] });
  sys.answers = ['yes'];
  let added: string | undefined;
  sys.route('GET', LIST, { status: 200, json: [{ id: 1, title: 'niyam signing', key: 'ssh-ed25519 AAAAmac', created_at: '2026-10-01T00:00:00Z' }, ...others] });
  // The new key shows in the list only once it is added.
  sys.route('GET', ADD, () => ({ status: 200, json: [{ key: 'ssh-ed25519 AAAAmac' }, ...(added ? [{ key: added }] : [])] }));
  sys.handlers.push((method, url, body) => {
    if (method !== 'POST' || url !== `https://api.github.com${ADD}`) return undefined;
    added = (body as { key: string }).key;
    return { status: 201, json: { id: 99, title: CLOUD_KEY_TITLE, key: added } };
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
  it('makes a new key in memory, registers it as the agent, and puts it on the clipboard as the variable, writing no file (#437)', async () => {
    const sys = mac();
    const writes = diskWrites(sys);
    const { code, out, err } = await key(sys);
    assert.equal(code, 0, err.join('\n'));
    assert.deepEqual(sys.chosen, ['Go ahead?']);
    assert.ok(!sys.calls.some((call) => call.command === 'ssh-keygen'), 'no ssh-keygen');
    assert.deepEqual(writes, [], 'nothing written to disk at any point, the key included, nor any folder made');
    const onClipboard = keyOnClipboard(sys.clipboard[0]);
    assert.ok(!('problem' in onClipboard), JSON.stringify(onClipboard));
    assert.equal(sys.clipboard.length, 1);
    const posted = sys.requests.find((request) => request.method === 'POST');
    assert.deepEqual(posted?.body, { title: CLOUD_KEY_TITLE, key: `${onClipboard.publicLine} ExampleBot cloud signing` }, "the clipboard's key is the one registered");
    assert.equal(posted?.token, TOKEN, "the agent's stored token");
    assert.ok(onClipboard.text.includes('OPENSSH PRIVATE KEY'));
    const printed = out.join('\n');
    assert.ok(!printed.includes(onClipboard.text.split('\n')[1] ?? '') && !printed.includes((sys.clipboard[0] ?? '').slice(20, 60)), 'the key is never printed');
    assert.deepEqual(out.slice(2), [
      `✓ registered as ExampleBot's signing key "${CLOUD_KEY_TITLE}" (id 99)`,
      '✓ NIYAM_SIGNING_KEY=… is on the clipboard',
      "  Paste it as one line into the cloud environment's variables: https://claude.ai/code → the environment's settings.",
      "  A new session there makes ExampleBot's commits its own; its first niyam line says so.",
    ]);
    const again = mac();
    assert.equal((await key(again)).code, 0);
    assert.equal(again.clipboard.length, 1);
    assert.ok(!('problem' in keyOnClipboard(again.clipboard[0])));
    assert.notEqual(again.clipboard[0], sys.clipboard[0], 'a new key each run');
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
  });

  it('says what failed when the registration fails, with nothing on the clipboard', async () => {
    const refused = mac();
    refused.route('POST', ADD, { status: 422, json: { message: 'key is already in use' } });
    const { code, out } = await key(refused);
    assert.equal(code, 1);
    assert.ok(out.includes("✗ GitHub did not register the key as ExampleBot's signing key (HTTP 422); nothing is on the clipboard"));
    assert.deepEqual(refused.clipboard, []);
  });

  it('deletes the key from GitHub again at a Ctrl-C once it is registered, with nothing on the clipboard', async () => {
    const sys = mac();
    const http = sys.http.bind(sys);
    sys.http = (url, options): Promise<HttpResult> => {
      if (options?.method === 'POST') sys.interrupt();
      return http(url, options);
    };
    const late = await key(sys);
    assert.equal(late.code, 130);
    assert.ok(late.out.includes('✗ stopped by Ctrl-C, so the key was deleted from GitHub again; nothing is on the clipboard'));
    assert.ok(sys.requests.some((request) => request.method === 'DELETE' && request.url.endsWith('/user/ssh_signing_keys/99')));
    assert.deepEqual(sys.clipboard, []);
    assert.deepEqual(sys.interrupts, [], 'its Ctrl-C handler is off again');
  });

  it("shares with onboard why it refuses, and its making of the key, which leaves the paste to onboard's own words (#417)", async () => {
    for (const env of [{ NIYAM_AGENT: AGENT }, { CLAUDECODE: '1' }, { CLAUDE_CODE_REMOTE: 'true' }]) {
      const sys = mac();
      sys.env = { ...sys.env, ...env };
      assert.equal(cloudKeyRefusal(sys), 'run it in your own terminal on your Mac, not in an agent session; it registers a key as the agent');
    }
    const linux = mac();
    linux.platform = 'linux';
    assert.match(cloudKeyRefusal(linux) ?? '', /macOS/);
    assert.equal(cloudKeyRefusal(mac()), undefined);
    const sys = mac();
    const { io, out } = capture();
    assert.equal(await makeCloudKey(sys, io, AGENT, TOKEN), 0);
    assert.ok(!('problem' in keyOnClipboard(sys.clipboard[0])));
    assert.deepEqual(sys.chosen, [], 'asks nothing');
    assert.deepEqual(out, [`✓ registered as ExampleBot's signing key "${CLOUD_KEY_TITLE}" (id 99)`, '✓ NIYAM_SIGNING_KEY=… is on the clipboard']);
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
