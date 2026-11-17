import { API, SETTINGS_PATH, account, agentFrom, checkToken, keyBody, signingKeys, tokenInfo } from './agent.ts';
import { SIGNING_KEY_VAR } from './cloud.ts';
import { CLAUDE_CODE_WEB } from './onboard.ts';
import { agentSession } from './push-identity.ts';
import { tokenStore, unsupported } from './token-store.ts';
import type { Output, Sys } from './types.ts';
import { GITHUB_WEB } from './host.ts';
import { type Ed25519Key, newKey, privateKeyText, publicLine } from './sshsig.ts';

/** The title the cloud signing keys have on GitHub, so the agent's can be told apart from a Mac's. */
export const CLOUD_KEY_TITLE = 'niyam cloud signing';

/** Where the agent's signing keys are deleted, signed in as the agent. */
const KEYS_PAGE = `${GITHUB_WEB}/settings/keys`;

/** cloud-key's arguments: the agent, then `--yes`. */
export function cloudKeyArgs(args: readonly string[]): { named?: string; yes?: true } {
  let named: string | undefined;
  let yes = false;
  for (const arg of args) {
    if (arg === '--yes') yes = true;
    else if (arg.startsWith('--')) throw new Error(`unknown option ${arg}`);
    else if (named === undefined) named = arg;
    else throw new Error(`unexpected argument "${arg}"`);
  }
  return { ...(named === undefined ? {} : { named }), ...(yes ? { yes: true as const } : {}) };
}

/** A signing key GitHub lists for the agent, as its own list gives it. */
export interface Listed {
  id: number;
  title: string;
  created: string;
  /** Its public half, "type body", as onboard pins it. */
  key: string;
}

/**
 * Sets up the agent's cloud signing key from the owner's Mac (#405): a new
 * ed25519 key, made in memory and never written to disk (#437), registered as
 * the agent's signing key with the token `machine` stored, titled
 * CLOUD_KEY_TITLE; once GitHub lists it, `NIYAM_SIGNING_KEY=<the private key,
 * base64>` goes on the clipboard, for the cloud environment's variables. The
 * key is never printed. When the clipboard
 * does not take it, the key just registered is deleted again, since no one
 * holds it. It names the agent's other cloud signing keys, for the owner to
 * delete one no environment uses; it deletes none itself. Refuses in an agent
 * session or a cloud session, where the token is not the owner's to use, and
 * asks once before it changes anything (`--yes` skips the question).
 */
export async function cloudKey(sys: Sys, io: Output, args: readonly string[] = []): Promise<number> {
  const { named, yes } = cloudKeyArgs(args);
  const refusal = cloudKeyRefusal(sys);
  const store = tokenStore(sys);
  if (refusal !== undefined || !store) {
    io.err(`cloud-key: ${refusal ?? unsupported(sys)}`);
    return 1;
  }
  const { login: agent } = await account(sys, agentFrom(sys, named));
  const token = store.read(sys, agent);
  if (!token) {
    io.err(`cloud-key: ${store.where} has no ${agent} token; run niyam machine ${agent} first`);
    return 1;
  }
  const check = checkToken(token, await tokenInfo(sys, token), agent, sys.now());
  if (check.problem !== undefined) {
    io.err(`cloud-key: the stored ${agent} token cannot be used: ${check.problem}; run niyam machine ${agent}`);
    return 1;
  }
  const before = await listedKeys(sys, agent, token);
  if ('problem' in before) {
    io.err(`cloud-key: ${before.problem}`);
    return 1;
  }
  io.out(`cloud-key: a new signing key for ${agent}'s Claude cloud sessions, registered on GitHub as ${agent} ("${CLOUD_KEY_TITLE}"),`);
  io.out(`  its private key put on the clipboard as ${SIGNING_KEY_VAR}=…, for a cloud environment's variables. Nothing is printed.`);
  const others = before.keys.filter((one) => one.title === CLOUD_KEY_TITLE);
  if (!yes) {
    if (!sys.tty) {
      io.err('cloud-key: no terminal to ask in; pass --yes to go ahead without asking');
      return 1;
    }
    if (!(await sys.choose('Go ahead?'))) {
      io.out('Nothing changed.');
      return 1;
    }
  }
  const made = await makeCloudKey(sys, io, agent, token, { others, paste: true });
  if (made === 0) io.out(`  ${repinLine(agent)}`);
  return made;
}

/**
 * What a key made outside onboard still needs: a cloud session checks the key
 * against the ones the repo's settings pin, since its proxy cannot read the
 * agent's list on GitHub (#447), and onboard writes the pin.
 */
export function repinLine(agent: string): string {
  return `Then run niyam onboard in each repository ${agent} works in: it pins the key in ${SETTINGS_PATH}, which cloud sessions check it against.`;
}

/**
 * Why cloud-key cannot run here, or undefined: in an agent session or a cloud
 * session the token is not the owner's to use, and a machine with no token
 * store holds no token to register the key with.
 */
export function cloudKeyRefusal(sys: Sys): string | undefined {
  if (agentSession(sys) || sys.env.CLAUDE_CODE_REMOTE === 'true') return 'run it in your own terminal on your Mac, not in an agent session; it registers a key as the agent';
  return tokenStore(sys) ? undefined : unsupported(sys);
}

/** What the owner does with the line on the clipboard: paste it into `where`'s variables, and what it does then. */
export function pasteLines(agent: string, where = "the cloud environment's"): string[] {
  return [
    `Paste it as one line into ${where} variables: ${CLAUDE_CODE_WEB} → the environment's settings.`,
    `A new session there makes ${agent}'s commits its own; its first niyam line says so.`,
  ];
}

/**
 * Makes the agent's cloud signing key in memory with niyam's own code (#437),
 * never on disk, registers it, and puts its line on the clipboard; each step
 * one line, the key never printed. A Ctrl-C once it is registered deletes it
 * from GitHub again. `others` are the agent's cloud signing keys GitHub
 * already lists, named for the owner to delete once unused; `paste` says what
 * to do with the line, for a caller that does not say it itself. `key` is
 * one made already, as onboard makes it to pin it in the pull request before
 * it is registered (#447). 0 once the line is on the clipboard.
 */
export async function makeCloudKey(
  sys: Sys,
  io: Output,
  agent: string,
  token: string,
  { others = [], paste = false, key = newKey() }: { others?: readonly Listed[]; paste?: boolean; key?: Ed25519Key } = {},
): Promise<number> {
  let interrupted = false;
  const off = sys.onInterrupt(() => {
    interrupted = true;
  });
  try {
    return await makeAndRegister(sys, io, { agent, token, others, paste, key }, () => interrupted);
  } finally {
    off();
  }
}

/** Makes the key, registers it, and puts it on the clipboard; each step one line. */
async function makeAndRegister(
  sys: Sys,
  io: Output,
  { agent, token, others, paste, key }: { agent: string; token: string; others: readonly Listed[]; paste: boolean; key: Ed25519Key },
  interrupted: () => boolean,
): Promise<number> {
  const comment = `${agent} cloud signing`;
  const publicKey = `${publicLine(key)} ${comment}`;
  const line = `${SIGNING_KEY_VAR}=${Buffer.from(privateKeyText(key, comment)).toString('base64')}`;
  const posted = await sys.http(`${API}/user/ssh_signing_keys`, { method: 'POST', token, body: { title: CLOUD_KEY_TITLE, key: publicKey } });
  const id = (posted.json as { id?: unknown } | null)?.id;
  if (posted.status !== 201 || typeof id !== 'number') {
    io.out(`✗ GitHub did not register the key as ${agent}'s signing key (HTTP ${posted.status}); nothing is on the clipboard`);
    return 1;
  }
  let listed = false;
  try {
    listed = (await signingKeys(sys, agent, token)).includes(keyBody(publicKey));
  } catch {
    // fail-open: a list GitHub does not give counts as not listing it, and the key is deleted again.
  }
  if (interrupted()) {
    await unregister(sys, io, token, id, 'stopped by Ctrl-C');
    return 130;
  }
  if (!listed) {
    await unregister(sys, io, token, id, 'GitHub does not list it');
    return 1;
  }
  io.out(`✓ registered as ${agent}'s signing key "${CLOUD_KEY_TITLE}" (id ${id})`);
  const copied = sys.exec('/usr/bin/pbcopy', [], { input: line });
  if (copied.code !== 0) {
    await unregister(sys, io, token, id, `the clipboard did not take the key (${copied.stderr.trim() || `exit ${copied.code}`})`);
    return 1;
  }
  io.out(`✓ ${SIGNING_KEY_VAR}=… is on the clipboard`);
  if (paste) for (const line of pasteLines(agent)) io.out(`  ${line}`);
  for (const other of others) {
    io.out(`▲ ${agent} has another cloud signing key, added ${other.created.slice(0, 10)} (id ${other.id}); delete it once no environment uses it → ${KEYS_PAGE}, signed in as ${agent}`);
  }
  return 0;
}

/** Deletes the key just registered, which no one holds, and says why. */
async function unregister(sys: Sys, io: Output, token: string, id: number, why: string): Promise<void> {
  let status = 0;
  try {
    ({ status } = await sys.http(`${API}/user/ssh_signing_keys/${id}`, { method: 'DELETE', token }));
  } catch {
    // fail-open: said below, with where to delete the key by hand.
  }
  io.out(
    status === 204
      ? `✗ ${why}, so the key was deleted from GitHub again; nothing is on the clipboard`
      : `✗ ${why}, and deleting the key from GitHub again failed (HTTP ${status}) → delete signing key ${id} at ${KEYS_PAGE}`,
  );
}

/** The agent's signing keys as its own list gives them, with their titles, or why they cannot be had. */
export async function listedKeys(sys: Sys, agent: string, token: string): Promise<{ keys: Listed[] } | { problem: string }> {
  const { status, json } = await sys.http(`${API}/user/ssh_signing_keys?per_page=100`, { token });
  if (status !== 200 || !Array.isArray(json)) return { problem: `GitHub answered HTTP ${status} when asked for ${agent}'s signing keys` };
  return {
    keys: json.flatMap((entry: unknown) => {
      const { id, title, created_at: created, key } = (entry ?? {}) as { id?: unknown; title?: unknown; created_at?: unknown; key?: unknown };
      return typeof id === 'number'
        ? [{ id, title: typeof title === 'string' ? title : '', created: typeof created === 'string' ? created : '', key: typeof key === 'string' ? keyBody(key) : '' }]
        : [];
    }),
  };
}
