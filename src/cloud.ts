import { API, BASE_ENV, CLOUD_SIGNING_KEYS, SETTINGS_PATH, authorVars, configVars, isNoToken, pathsFor, signingConfig } from './agent.ts';
import { SSH_SIGN, signerScript } from './ssh-sign.ts';
import { commitSignature, publicLine, readPrivateKey, signatureProblem } from './sshsig.ts';
import { CLAUDE_CODE_WEB, SETUP_FIRST, workflowPins } from './onboard.ts';
import { PRODUCT, tarballName } from './names.ts';
import type { Output, Sys } from './types.ts';
import { CLOUD_SETUP_PATH, WORKFLOW_PATH } from './onboard-pull.ts';
import { GITHUB_WEB } from './host.ts';

/**
 * What a cloud session's GH_TOKEN reads when its environment sets none; the
 * proxy swaps it for the connected account's token (Claude Code's cloud
 * environments docs, "GitHub proxy").
 */
export const PROXY_TOKEN = 'proxy-injected';

/** The token a cloud session reaches GitHub with: one its environment set, else the proxy's placeholder, never the lock's. */
export function cloudToken(sys: Sys): string {
  const token = sys.env.GH_TOKEN;
  return token && !isNoToken(token) ? token : PROXY_TOKEN;
}

/**
 * The account a cloud session reaches GitHub as, through its proxy, or why it
 * cannot be told; with the account's id from the same answer, when it names
 * a valid one, for the agent's no-reply address.
 */
export async function cloudLogin(sys: Sys): Promise<{ login: string; id?: number } | { problem: string }> {
  try {
    const { status, json } = await sys.http(`${API}/user`, { token: cloudToken(sys) });
    const { login, id } = (json as { login?: unknown; id?: unknown } | null) ?? {};
    if (status !== 200 || typeof login !== 'string') return { problem: `GitHub answered HTTP ${status} when asked who this session is` };
    return typeof id === 'number' && Number.isSafeInteger(id) && id > 0 ? { login, id } : { login };
  } catch (error) {
    return { problem: `GitHub could not be asked who this session is (${error instanceof Error ? error.message : String(error)})` };
  }
}

/**
 * The cloud environment's variable that holds the agent's cloud signing key:
 * an OpenSSH private key, base64 on one line or as is. A key of its own, not
 * a Mac's, registered as one of the agent's signing keys, so it is revoked
 * on its own.
 */
export const SIGNING_KEY_VAR = 'NIYAM_SIGNING_KEY';

/** The message of the probe commit `cloudSigning` signs. */
const PROBE_MESSAGE = 'niyam: a probe of the agent\'s signing, never on a branch';

/**
 * What makes a cloud session's commits the agent's: its author and committer
 * variables, with the address of the id GitHub gave with the login, and SSH
 * signing with the key in SIGNING_KEY_VAR, over the platform's own signing
 * (Claude's, through a program of its own: `gpg.ssh.program` becomes niyam's
 * own signer, `niyam ssh-sign`, in Node, since the hosted image has no
 * ssh-keygen, #425, and installing one costs every session time and needs the
 * network). All of them or none, since a commit that claims the agent
 * must be Verified as the agent (PR identity) and a signing setup that fails
 * breaks every commit: each is given only when the key is one of `pinned`,
 * the agent's cloud signing keys the repo's settings pin, and a probe commit
 * signed with exactly these settings, in the clone at `root`, verifies as
 * that key's. The pin stands in for GitHub's list of the agent's signing
 * keys, which `onboard` read on the owner's Mac: the session's proxy refuses
 * every `users/…` path (#447). The probe is an object on no branch, which
 * git's housekeeping drops. Otherwise why not, and the session keeps the
 * cloud image's identity.
 */
export function cloudSigning(sys: Sys, root: string, login: string, id: number | undefined, pinned: readonly string[]): { vars: [string, string][] } | { problem: string } {
  const given = sys.env[SIGNING_KEY_VAR]?.trim();
  if (!given) return { problem: `the cloud environment's variables have no ${SIGNING_KEY_VAR}, ${login}'s cloud signing key (niyam's README, "Claude cloud sessions", says how to add one)` };
  if (id === undefined) return { problem: `GitHub named no account id for ${login}` };
  const text = (given.includes(PEM_BEGIN) ? given.replaceAll('\\n', '\n') : Buffer.from(given, 'base64').toString('utf8')).trim();
  if (!text.startsWith(`${PEM_BEGIN}\n`) || !text.endsWith(`\n${PEM_END}`)) {
    return { problem: `${SIGNING_KEY_VAR} is not an OpenSSH private key, base64 on one line or as is` };
  }
  const parsed = readPrivateKey(text);
  if ('problem' in parsed) return { problem: `${SIGNING_KEY_VAR} cannot be used: ${parsed.problem}` };
  const body = publicLine(parsed);
  const pin = `${SETTINGS_PATH}'s "${CLOUD_SIGNING_KEYS}"`;
  const repin = `niyam onboard on the owner's Mac pins the ones GitHub lists`;
  if (pinned.length === 0) return { problem: `${pin} pins no cloud signing key for ${login}, and this session cannot ask GitHub for ${login}'s signing keys; ${repin}` };
  if (!pinned.includes(body)) return { problem: `${SIGNING_KEY_VAR}'s public half is not one of the cloud signing keys ${pin} pins for ${login}; ${repin}` };
  const { dir, key } = pathsFor(sys.home, login);
  const pub = `${key}.pub`;
  const signer = `${dir}/${SSH_SIGN}`;
  try {
    sys.mkdir(dir);
    sys.mkdir(key.slice(0, key.lastIndexOf('/')));
    sys.write(key, `${text}\n`, 0o600);
    sys.write(pub, `${body} ${login} cloud signing\n`, 0o644);
    sys.write(signer, signerScript(sys.runtime.node, sys.runtime.cli), 0o755);
  } catch (error) {
    // fail-open: the session keeps the image's identity, which PR identity passes, and says why.
    return { problem: `writing ${SIGNING_KEY_VAR} to ${key} failed (${messageOf(error)})` };
  }
  const vars: [string, string][] = [...authorVars(login, id), ...configVars([['gpg.ssh.program', signer], ...signingConfig(pub)])];
  const probe = probeSignature(sys, root, vars, body);
  return probe ? { problem: `a probe commit signed with ${SIGNING_KEY_VAR} did not verify as that key (${probe})` } : { vars };
}

const PEM_BEGIN = '-----BEGIN OPENSSH PRIVATE KEY-----';
const PEM_END = '-----END OPENSSH PRIVATE KEY-----';

/**
 * Makes a commit object on no branch with the environment `vars` give, and
 * checks its signature is the agent key's, `publicKey`, in git's namespace,
 * in Node, as there is no ssh-keygen: undefined when it is, else what failed.
 */
function probeSignature(sys: Sys, root: string, vars: [string, string][], publicKey: string): string | undefined {
  // The session's commands get the env file's lines, which unset the lock first: the probe does the same.
  const base = Object.fromEntries(Object.entries(sys.env).filter(([name]) => !(name in BASE_ENV) && name !== SIGNING_KEY_VAR));
  const env = { ...base, ...Object.fromEntries(vars) };
  const tree = sys.exec('git', ['mktree'], { cwd: root, env, input: '' });
  if (tree.code !== 0) return `git mktree: ${lastLine(tree.stderr) || `exit ${tree.code}`}`;
  // commit-tree reads no commit.gpgsign: -S signs as `git commit` would, with the key and program the settings name.
  const commit = sys.exec('git', ['commit-tree', '-S', tree.stdout.trim(), '-m', PROBE_MESSAGE], { cwd: root, env, input: '' });
  if (commit.code !== 0) return `git commit-tree: ${lastLine(commit.stderr) || `exit ${commit.code}`}`;
  const raw = sys.exec('git', ['cat-file', 'commit', commit.stdout.trim()], { cwd: root, env, input: '' });
  if (raw.code !== 0) return `git cat-file: ${lastLine(raw.stderr) || `exit ${raw.code}`}`;
  const signed = commitSignature(raw.stdout);
  if (!signed) return 'the probe commit has no signature';
  const problem = signatureProblem(signed.signature, signed.payload, 'git', publicKey);
  return problem ? `its signature: ${problem}` : undefined;
}

function lastLine(text: string): string {
  return text.trim().split('\n').at(-1) ?? '';
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The Node a Claude cloud session runs the CLI with: its image's own is older than the CLI needs. */
export const CLOUD_NODE = '24.21.0';
/** The sha256 of CLOUD_NODE's Linux builds, from nodejs.org's SHASUMS256.txt for that release. */
export const CLOUD_NODE_SHA256 = {
  x64: 'fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6',
  arm64: '6ad1325edbdb5649c379b75a237147a666c95d4f9ae8d340fef2d1575d289ad2',
};

/** What the Setup snippet says when the install fails: the commands after it in the Setup script still run. */
export const INSTALL_FAILED = 'niyam: the install failed, so sessions start without niyam; the rest of the Setup script still runs.';

/** Where the install puts Node and the CLI in a cloud session. */
export const CLOUD_DIR = '/opt/niyam';
/**
 * The file the install leaves in CLOUD_DIR when the Setup snippet ran it,
 * so a session can tell a Setup script that runs the repo's file from one
 * that installs a release of its own; it holds the path of the file that ran.
 */
export const FROM_SETUP = `${CLOUD_DIR}/from-setup`;

/** Whether the Setup snippet ran the repo's cloud setup file in this environment. */
export function ranFromSetup(sys: Sys): boolean {
  return sys.exists(FROM_SETUP);
}

/** The repo's cloud setup file the Setup snippet ran in this environment, as its mark records it; undefined when the mark names none, or none is there. */
export function fileFromSetup(sys: Sys): string | undefined {
  if (!sys.exists(FROM_SETUP)) return undefined;
  try {
    return sys.read(FROM_SETUP).trim().endsWith(`/${CLOUD_SETUP_PATH}`) ? CLOUD_SETUP_PATH : undefined;
  } catch {
    return undefined;
  }
}

/** The release `cloudRepoScript` installs, from its first comment; undefined when `text` is not one. */
export function cloudScriptVersion(text: string): string | undefined {
  return /^# niyam (\d+\.\d+\.\d+) for Claude cloud sessions/m.exec(text)?.[1];
}

/**
 * The releases a clone at `root` says a cloud session should run: the one
 * version its workflow pins, and the one its cloud setup file installs; each
 * undefined when the file is missing or unreadable, the workflow pins none or
 * several, or the setup file is not one onboard writes. `workflow` and
 * `script` name the two files.
 */
export function repoReleases(sys: Sys, root: string): { pinned: string | undefined; scripted: string | undefined; workflow: string; script: string } {
  const workflow = WORKFLOW_PATH;
  const script = CLOUD_SETUP_PATH;
  let pinned: string | undefined;
  try {
    const pins = new Set(workflowPins(sys.read(`${root}/${workflow}`)));
    if (pins.size === 1) [pinned] = pins;
  } catch {
    pinned = undefined;
  }
  const file = `${root}/${script}`;
  let scripted: string | undefined;
  try {
    scripted = sys.exists(file) ? cloudScriptVersion(sys.read(file)) : undefined;
  } catch {
    scripted = undefined;
  }
  return { pinned, scripted, workflow, script };
}

/** The release archive of `version`, as GitHub serves it. */
export function releaseTarball(version: string): string {
  return `${GITHUB_WEB}/${PRODUCT}/releases/download/v${version}/${tarballName(version)}`;
}

/**
 * The sha256 GitHub records for `version`'s release archive, or why it
 * cannot be had: onboard pins it in the repo's cloud setup file, so the
 * cloud install checks the CLI it unpacks as it checks Node.
 */
export async function releaseSha256(sys: Sys, version: string, token: string): Promise<{ sha256: string } | { problem: string }> {
  const name = tarballName(version);
  try {
    const { status, json } = await sys.http(`${API}/repos/${PRODUCT}/releases/tags/v${version}`, { token });
    if (status !== 200) return { problem: `GitHub answered HTTP ${status} for the v${version} release` };
    const assets = (json as { assets?: { name?: unknown; digest?: unknown }[] } | null)?.assets ?? [];
    const digest = assets.find((asset) => asset.name === name)?.digest;
    const sha256 = typeof digest === 'string' ? /^sha256:([0-9a-f]{64})$/.exec(digest)?.[1] : undefined;
    return sha256 ? { sha256 } : { problem: `the v${version} release names no sha256 for ${name}` };
  } catch (error) {
    return { problem: `GitHub could not be asked for the v${version} release (${error instanceof Error ? error.message : String(error)})` };
  }
}

/**
 * The repo's cloud setup file, CLOUD_SETUP_PATH, which onboard writes at
 * the version the workflow pins and rewrites on every run: Node and that
 * release of the CLI, unpacked under CLOUD_DIR as root, and a `niyam` on
 * PATH that runs one with the other, leaving the image's own Node alone. Each download is checked against the sha256 pinned here
 * before it is unpacked; a Node already unpacked at this version is kept,
 * so a session that runs it again fetches the CLI alone. The SessionStart
 * hook runs it when a session has no CLI (HOOK_COMMAND), session-start when
 * the environment's snapshot holds another release, and the Setup snippet,
 * where it is pasted, before a session starts.
 */
export function cloudRepoScript(version: string, sha256: string): string {
  return [
    '#!/bin/bash',
    `# niyam ${version} for Claude cloud sessions: Node ${CLOUD_NODE} and the CLI, as niyam on PATH.`,
    `# niyam onboard writes this file at the version ${WORKFLOW_PATH} pins, and writes it again on every run.`,
    "# The SessionStart hook runs it when a session has no niyam, session-start when it has another release,",
    "# and the Setup script when it holds what niyam cloud-setup prints. Change it by running onboard, not by hand.",
    'set -euo pipefail',
    `dir=${CLOUD_DIR}`,
    `node=${CLOUD_NODE}`,
    `case "$(uname -m)" in x86_64) arch=x64 sum=${CLOUD_NODE_SHA256.x64} ;; aarch64 | arm64) arch=arm64 sum=${CLOUD_NODE_SHA256.arm64} ;; *) echo "niyam: no Node for $(uname -m)" >&2; exit 1 ;; esac`,
    'bin="$dir/node-v$node-linux-$arch/bin/node"',
    'mkdir -p "$dir"',
    'if [ "$("$bin" --version 2>/dev/null)" != "v$node" ]; then',
    '  curl -fsSL --connect-timeout 10 --max-time 120 -o "$dir/node.tar.xz" "https://nodejs.org/dist/v$node/node-v$node-linux-$arch.tar.xz"',
    '  echo "$sum  $dir/node.tar.xz" | sha256sum -c --quiet -',
    '  tar -xJ -f "$dir/node.tar.xz" -C "$dir"',
    '  rm "$dir/node.tar.xz"',
    'fi',
    `curl -fsSL --connect-timeout 10 --max-time 120 -o "$dir/niyam.tgz" ${releaseTarball(version)}`,
    `echo "${sha256}  $dir/niyam.tgz" | sha256sum -c --quiet -`,
    // A folder per release: a session that installs another leaves the one it runs in place.
    `cli="$dir/cli-${version}"`,
    'rm -rf "$cli"',
    'mkdir -p "$cli"',
    'tar -xz -f "$dir/niyam.tgz" -C "$cli"',
    'rm "$dir/niyam.tgz"',
    // Gone first: an environment set up before P-53 has niyam as a link, which the write would follow. And the
    // command before niyam, a leftover nothing runs since P-54, named only to remove it, as the LEFTOVER_ names are.
    'rm -f /usr/local/bin/niyam /usr/local/bin/process-rules',
    'printf \'#!/bin/sh\\nexec %s %s "$@"\\n\' "$bin" "$cli/package/dist/cli.js" > /usr/local/bin/niyam',
    'chmod 755 /usr/local/bin/niyam',
    // The path it ran from, the Setup snippet's mark.
    `if [ -n "\${NIYAM_SETUP:-}" ]; then printf '%s\\n' "$0" > ${FROM_SETUP}; fi`,
    'niyam version </dev/null',
    '',
  ].join('\n');
}

/**
 * The Setup snippet for a Claude cloud environment, optional since P-60,
 * when the SessionStart hook installs niyam itself: Claude caches what a
 * Setup script installs, so sessions start faster. It names no version,
 * so a new release needs no new paste. It runs the clone's
 * CLOUD_SETUP_PATH, which onboard keeps at the workflow's pin, setting the
 * mark's variable. The Setup
 * script runs as root after the clone, from the folder that holds it (the
 * VM's home, the clone one folder down), so it looks there and in each
 * home. The environment's Setup field holds one script, so it runs in a
 * shell of its own: its failures stay there, and the repo's own setup can
 * follow it in the same field.
 */
export function cloudSetupSnippet(): string {
  return [
    '#!/bin/bash',
    `# niyam for Claude cloud sessions: runs the clone's ${CLOUD_SETUP_PATH}, which niyam onboard keeps at the version the repo pins. Paste once; put the repo's own setup after it.`,
    `bash <<'NIYAM' || echo "${INSTALL_FAILED}" >&2`,
    `file=${CLOUD_SETUP_PATH}`,
    'for script in "$PWD/$file" "$PWD"/*/"$file" /home/*/*/"$file" /root/*/"$file"; do',
    '  if [ -f "$script" ]; then NIYAM_SETUP=1 exec bash "$script" </dev/null; fi',
    'done',
    `echo "niyam: no ${CLOUD_SETUP_PATH} in the clone under $PWD; run niyam onboard, which writes it" >&2`,
    'exit 1',
    'NIYAM',
    '',
  ].join('\n');
}

/**
 * What `cloud-setup` says above the snippet, as comment lines of the script
 * itself: `niyam cloud-setup | pbcopy` copies them with it, and the Setup
 * field keeps them, so nothing is said on standard error behind a pipe.
 */
export function cloudSetupHelp(): string[] {
  return [
    "# Optional: cloud sessions install niyam themselves when they have none. This makes them start faster, since Claude caches what a Setup script installs.",
    `# Paste all of this at the top of the Claude cloud environment's Setup script, once (${CLAUDE_CODE_WEB} → the environment's settings).`,
    `# It runs the clone's ${CLOUD_SETUP_PATH}, which niyam onboard keeps at the version the repo pins, so a new release needs no new paste.`,
    `# ${SETUP_FIRST}`,
    `# Cloud sessions also need claude.ai's GitHub connected as the agent the repo's settings name: ${CLAUDE_CODE_WEB}.`,
  ];
}

/** Prints the Setup snippet for a Claude cloud environment, its instructions in comment lines at the top. */
export function cloudSetup(io: Output): number {
  const [shebang, ...rest] = cloudSetupSnippet().trimEnd().split('\n');
  io.out([shebang, ...cloudSetupHelp(), ...rest].join('\n'));
  return 0;
}
