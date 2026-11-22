import {
  EXPIRY_WARNING_DAYS,
  SETTINGS_PATH,
  account,
  agentFrom,
  agentIn,
  anyLogin,
  either,
  hasSettings,
  loadSettings,
  repoAt,
  sameLogin,
  checkToken,
  keyBody,
  keyPairProblem,
  launcherPath,
  pathsFor,
  sessionFileIs,
  signingKeys,
  tokenInfo,
} from './agent.ts';
import { LOCKED, clientHooks, hooksHittingLock } from './as-agent.ts';
import { FROM_SETUP, SIGNING_KEY_VAR, cloudLogin, fileFromSetup, ranFromSetup, repoReleases } from './cloud.ts';
import { GITHUB_NOREPLY } from './host.ts';
import { featuresIn } from './features.ts';
import { callerAt, callerIsOnboards, pushBranch } from './guard-caller.ts';
import { typesDrift } from './issue-types.ts';
import { type Finding, closing, findingLines, heading, painter, tilde } from './layout.ts';
import { exposure, exposureFindings, movedFindings, readDeclined, setAside } from './lockout.ts';
import { CLOUD_SETUP_PATH, GUARD_CALLER_PATH, HOOKS_PATH, SARATHI_PATH, WORKFLOW_PATH } from './onboard-pull.ts';
import { leftoverDir, leftoverToken } from './machine.ts';
import { BOARD_SECRETS, GUARD_COMMAND, HOOK_COMMAND, OLDER_GUARD_COMMANDS, OLDER_HOOK_COMMANDS, ARTIFACT_RULES, AUTO_FIX_RULES, type RuleNeeds, artifactRuleNeeds, autoFixRuleNeeds, sarathiRunner } from './onboard.ts';
import { secretNames } from './secrets.ts';
import { isOrganisation } from './owner-login.ts';
import { leftBehind } from './owner-step.ts';
import { repoRoot } from './session-start.ts';
import { type TokenStore, tokenStore, unsupported } from './token-store.ts';
import type { Output, Sys } from './types.ts';
import { installedFindings } from './upgrade.ts';
import { packageVersion } from './version.ts';

const MACHINE = 'niyam machine';

/** Runs a check that reads GitHub; a failed read is that check's ✗, fixed by asking again. */
async function remote(name: string, check: () => Promise<Finding>): Promise<Finding> {
  try {
    return await check();
  } catch (error) {
    return { mark: '✗', text: `${name}: cannot ask GitHub (${error instanceof Error ? error.message : String(error)})`, fix: 'niyam doctor again' };
  }
}

/**
 * Checks that agent sessions on this machine can work as an agent account,
 * reading only: on this Mac the signing key, the session file, the launcher,
 * and the owner's accounts and keys an agent session could reach; on GitHub the
 * classic token and the key registered; in the repository here, hooks that
 * reach GitHub outside `as-agent`. It shows them grouped, one line each, ✓
 * fine, ▲ worth fixing, ✗ broken, each problem with its fix. Exit 1 when
 * any is broken; a token near its end is worth fixing. A Claude cloud session
 * has no keychain, so it gets its own checks; see `cloudDoctor`.
 */
export async function doctor(sys: Sys, io: Output, named?: string): Promise<number> {
  // The same test session-start and as-agent use; on any other machine without a token store, the refusal stands.
  if (sys.env.CLAUDE_CODE_REMOTE === 'true') return cloudDoctor(sys, io, named);
  const store = tokenStore(sys);
  if (!store) {
    io.err(`doctor: ${unsupported(sys)}`);
    return 1;
  }
  const typed = agentFrom(sys, named);
  // GitHub's spelling of the login, as machine stored it; when GitHub cannot
  // be asked, the typed one, and the session file check says why.
  const found = await account(sys, typed).catch((error: unknown) =>
    error instanceof Error ? error : new Error(String(error)),
  );
  const agent = found instanceof Error ? typed : found.login;
  const paths = pathsFor(sys.home, agent);
  const home = (path: string): string => tilde(sys.home, path);

  const keyProblem = keyPairProblem(sys, paths.key);
  const mac: Finding[] = [
    keyProblem
      ? { mark: '✗', text: keyProblem.replaceAll(paths.key, home(paths.key)), fix: /missing$/.test(keyProblem) ? MACHINE : `move it aside, then ${MACHINE}` }
      : { mark: '✓', text: `signing key ${home(paths.key)}` },
    await remote('session file', async () => {
      if (!sys.exists(paths.session)) return { mark: '✗', text: 'session file missing', fix: MACHINE };
      if (found instanceof Error) throw found;
      const is = sessionFileIs(sys.read(paths.session), agent, found.id, paths, store);
      if (!is) return { mark: '✗', text: 'session file out of date', fix: MACHINE };
      return is === 'current'
        ? { mark: '✓', text: 'session file' }
        : { mark: '▲', text: 'session file from an older release; it still works', fix: MACHINE };
    }),
  ];

  mac.push(launcherFinding(sys), ...leftoverFindings(sys, store, agent), ...(await installedFindings(sys)));
  const { left, kept } = setAside(exposure(sys, agent), readDeclined(sys, agent));
  mac.push(...kept.map((text): Finding => ({ mark: '✓', text })), ...exposureFindings(left, sys.home), ...movedFindings(sys, agent), ...leftBehind(sys));

  const token = store.read(sys, agent);
  const github: Finding[] = [
    await remote('token', async () => {
      if (!token) return { mark: '✗', text: `no token in ${store.where}`, fix: MACHINE };
      const check = checkToken(token, await tokenInfo(sys, token), agent, sys.now());
      if (check.problem !== undefined) return { mark: '✗', text: `token: ${check.problem}`, fix: MACHINE };
      return check.days <= EXPIRY_WARNING_DAYS
        ? { mark: '▲', text: `token ends in ${check.days} days`, fix: MACHINE }
        : { mark: '✓', text: `token, ends in ${check.days} days` };
    }),
    await remote('signing key', async () => {
      const registered = !keyProblem && (await signingKeys(sys, agent)).includes(keyBody(sys.read(`${paths.key}.pub`)));
      return registered ? { mark: '✓', text: 'signing key registered' } : { mark: '✗', text: 'signing key not registered', fix: MACHINE };
    }),
    ...(await typesFindings(sys, token)),
    ...(await boardAppFindings(sys, token)),
  ];

  return report(sys, io, agent, [
    ['This Mac', mac],
    [`GitHub — as ${agent}`, github],
    ['This repo', await repoFindings(sys)],
  ]);
}

/**
 * A launcher that runs the package manager's command before niyam, which no
 * release installs since P-54: named only so doctor says so (P-57).
 */
const LEFTOVER_LAUNCHER = /^exec '[^'\n]*\/process-rules' "\$@"$/m;

/** The launcher the hooks run, which `machine` writes: ✓ when it runs, and runs niyam. */
function launcherFinding(sys: Sys): Finding {
  const launcher = launcherPath(sys.home);
  if (!sys.exists(launcher)) return { mark: '✗', text: 'launcher missing, so hooks need node on PATH', fix: MACHINE };
  const runs = sys.exec(launcher, ['--version'], { env: { ...sys.env, PATH: '/usr/bin:/bin' } });
  if (runs.code !== 0) return { mark: '✗', text: `launcher does not run (${runs.stderr.trim() || `exit ${runs.code}`}); its node removed?`, fix: MACHINE };
  return LEFTOVER_LAUNCHER.test(sys.read(launcher))
    ? { mark: '✗', text: "launcher runs process-rules, the command before niyam, which no release installs, so hooks may find no CLI", fix: MACHINE }
    : { mark: '✓', text: 'launcher' };
}

/**
 * What is left on this Mac from before niyam, which no release reads since
 * P-57: the folder before P-55, and the keychain's entry before niyam. Each
 * is ▲, as `machine` removes it; an entry holding another token than the
 * current one `machine` leaves, so its fix is the delete by hand.
 */
function leftoverFindings(sys: Sys, store: TokenStore, agent: string): Finding[] {
  const dir = leftoverDir(sys);
  const token = leftoverToken(sys, store, agent);
  const item = store.leftoverItem?.(agent) ?? 'the old keychain entry';
  return [
    ...(dir ? [{ mark: '▲' as const, text: `${tilde(sys.home, dir)}, niyam's folder before P-55, is still here; nothing reads it`, fix: MACHINE }] : []),
    ...(token === undefined
      ? []
      : [
          token.same
            ? { mark: '▲' as const, text: `${item}, from before niyam, is still in ${store.where}; nothing reads it`, fix: MACHINE }
            : { mark: '▲' as const, text: `${item}, from before niyam, is still in ${store.where}, and ${token.why}`, fix: `once nothing needs it, ${store.dropLeftoverCommand?.(agent) ?? 'delete it'}` },
        ]),
  ];
}

/**
 * The repository doctor runs in and its settings, parsed, where they turn
 * the board on and doctor has a token to ask GitHub with; else undefined.
 */
function boardRepo(sys: Sys, token: string | undefined): { slug: string; settings: unknown } | undefined {
  try {
    const found = repoAt(sys);
    const path = `${found.root}/${SETTINGS_PATH}`;
    if (!token || !sys.exists(path)) return undefined;
    const settings = JSON.parse(sys.read(path)) as unknown;
    return featuresIn(settings).includes('board') ? { slug: found.slug, settings } : undefined;
  } catch {
    // Outside a client's clone, or settings doctor cannot read: onboard says what is wrong with them.
    return undefined;
  }
}

/**
 * Whether the organisation's enabled issue types are the work model's, no
 * issue here holds another, and every open one here has one but the
 * Approvals issue: checked in a repository whose settings turn the board on,
 * in an organisation, since onboard keeps them so there.
 */
async function typesFindings(sys: Sys, token: string | undefined): Promise<Finding[]> {
  const here = boardRepo(sys, token);
  if (!here || !token) return [];
  const { slug, settings } = here;
  const named = (settings as { approvals?: unknown } | null)?.approvals;
  const approvals = typeof named === 'number' ? named : undefined;
  const org = slug.split('/')[0] as string;
  try {
    return (await isOrganisation(sys, org, token)) ? [await typesDrift(sys, token, org, slug, approvals)] : [];
  } catch (error) {
    return [{ mark: '✗', text: `issue types: cannot ask GitHub (${message(error)})`, fix: 'niyam doctor again' }];
  }
}

/**
 * Whether the repository has the board app's secrets, which the Slice started
 * job moves a slice to In Progress with when its pull request opens (P-70):
 * checked where the settings turn the board on, in an organisation. A missing
 * one is worth fixing, never broken, since the desktop push still moves the
 * board; secrets GitHub will not list say nothing.
 */
async function boardAppFindings(sys: Sys, token: string | undefined): Promise<Finding[]> {
  const here = boardRepo(sys, token);
  if (!here || !token) return [];
  const { slug } = here;
  try {
    if (!(await isOrganisation(sys, slug.split('/')[0] as string, token))) return [];
    const names = await secretNames(sys, slug, token);
    if (names === undefined) return [];
    const missing = BOARD_SECRETS.filter((name) => !names.includes(name));
    return missing.length === 0
      ? [{ mark: '✓', text: 'board app secrets' }]
      : [{ mark: '▲', text: `no ${missing.join(' or ')} secret, so a slice moves to In Progress only from a desktop push`, fix: `${ONBOARD} at your own terminal, which sets up the board app` }];
  } catch (error) {
    // fail-open: a read that failed is the one ▲ here, as a missing secret breaks nothing.
    return [{ mark: '▲', text: `board app secrets: cannot ask GitHub (${message(error)})`, fix: 'niyam doctor again' }];
  }
}

/**
 * Client hooks that reach GitHub outside `as-agent` where doctor runs, a Mac
 * or a cloud session, and the Auto-fix and artifact rules an onboarded repo's
 * Claude Code settings lack, and whether its shared Guard caller is pinned
 * with the rest.
 */
async function repoFindings(sys: Sys): Promise<Finding[]> {
  return [
    ...hooksHittingLock(sys).map(
      (hook): Finding => ({
        mark: '▲',
        text: `${hook} reaches GitHub outside as-agent, so gets 401`,
        fix: `run its gh or git via niyam as-agent --session <session_id> -- (exit ${LOCKED} when not the agent)`,
      }),
    ),
    ...allowFindings(sys),
    ...twiceFindings(sys),
    ...(await callerFindings(sys)),
  ];
}

/**
 * Whether the shared Guard's caller is as onboard writes it, pinned with the
 * rest: checked in every onboarded repo, since onboard writes it in every one
 * (#485). Offline, so the caller's branch is checked against the one
 * niyam.yml's pushes run on, which onboard keeps at the default branch; its
 * release against the one niyam.yml pins. A repo with no niyam.yml has
 * neither to check against, so only the caller's shape is checked there.
 */
async function callerFindings(sys: Sys): Promise<Finding[]> {
  let root: string;
  try {
    root = repoRoot(sys);
    if (!hasSettings(sys, root)) return [];
  } catch {
    // fail-open: outside a clone, or settings doctor cannot read, there is no caller to check; onboard says what is wrong with them.
    return [];
  }
  const file = `${root}/${GUARD_CALLER_PATH}`;
  if (!sys.exists(file)) return [{ mark: '✗', text: `${GUARD_CALLER_PATH} missing, so the shared Guard does not run here`, fix: ONBOARD }];
  const workflowFile = `${root}/${WORKFLOW_PATH}`;
  let workflow: string | undefined;
  let text: string;
  try {
    workflow = sys.exists(workflowFile) ? sys.read(workflowFile) : undefined;
    text = sys.read(file);
  } catch (error) {
    // fail-open: a file doctor cannot read is marked ✗, naming why, and the rest of the report still runs.
    return [{ mark: '✗', text: `${GUARD_CALLER_PATH} not checked: ${message(error)}`, fix: 'make the workflow and its caller readable' }];
  }
  const at = await callerAt(text);
  if (at === undefined) {
    // onboard writes its own file again, but leaves one it did not write to the repository.
    const fix = (await callerIsOnboards(text)) ? ONBOARD : `rename or delete it, then ${ONBOARD}`;
    return [{ mark: '✗', text: `${GUARD_CALLER_PATH} is not the caller onboard writes: another trigger, branch, permission, job, with:, secrets: or steps`, fix }];
  }
  if (workflow === undefined) return [{ mark: '✓', text: `${GUARD_CALLER_PATH} calls the shared Guard at v${at.version}, as onboard writes it` }];
  const { pinned } = repoReleases(sys, root);
  if (pinned === undefined) {
    return [{ mark: '▲', text: `${WORKFLOW_PATH} pins no one version, so ${GUARD_CALLER_PATH} is not checked against it`, fix: ONBOARD }];
  }
  const branch = await pushBranch(workflow);
  if (at.version !== pinned) return [{ mark: '✗', text: `${GUARD_CALLER_PATH} calls the shared Guard at v${at.version}, but ${WORKFLOW_PATH} pins v${pinned}`, fix: ONBOARD }];
  // A push trigger of several branches, which onboard leaves as the client has it, says no one branch: the rest is still checked.
  if (branch !== undefined && at.branch !== branch) return [{ mark: '✗', text: `${GUARD_CALLER_PATH} runs on pull requests to ${at.branch}, but ${WORKFLOW_PATH} runs pushes on ${branch}`, fix: ONBOARD }];
  return [{ mark: '✓', text: `${GUARD_CALLER_PATH} calls the shared Guard at v${pinned}, as ${WORKFLOW_PATH} pins` }];
}

/** niyam's own hook commands, this release's and older ones, by what they do. */
const NIYAM_HOOKS: [name: string, commands: readonly string[]][] = [
  ["niyam's SessionStart hook", [HOOK_COMMAND, ...OLDER_HOOK_COMMANDS]],
  ["niyam's guard hook", [GUARD_COMMAND, ...OLDER_GUARD_COMMANDS]],
];

/**
 * Hooks that run twice: a command in both `.claude/settings.json` and the
 * handlers `.claude/sarathi.json` lists for the same event, where the
 * settings run sarathi for it (P-66). onboard moves niyam's own; any other
 * is the repo's to take out of the settings.
 */
function twiceFindings(sys: Sys): Finding[] {
  let hooks: ReturnType<typeof clientHooks>;
  let settings: unknown;
  try {
    const root = repoRoot(sys);
    hooks = clientHooks(sys, root);
    settings = JSON.parse(sys.read(`${root}/${HOOKS_PATH}`)) as unknown;
  } catch {
    // Outside a clone, or settings doctor cannot read: no hook in them runs twice that it can tell.
    return [];
  }
  const handlers = new Set(hooks.filter((hook) => hook.file === SARATHI_PATH).map((hook) => `${hook.event}\n${hook.command}`));
  const seen = new Set<string>();
  const found: Finding[] = [];
  for (const { file, event, command } of hooks) {
    const key = `${event}\n${command}`;
    if (file !== HOOKS_PATH || !handlers.has(key) || seen.has(key) || !sarathiRunner(settings, event)) continue;
    seen.add(key);
    const own = NIYAM_HOOKS.find(([, commands]) => commands.includes(command))?.[0];
    const named = own ?? `the ${event} hook ${JSON.stringify(command.length > 60 ? `${command.slice(0, 57)}...` : command)}`;
    found.push({
      mark: '▲',
      text: `${named} is in both ${HOOKS_PATH} and ${SARATHI_PATH} for ${event}, so it runs twice`,
      fix: own ? ONBOARD : `take it out of ${HOOKS_PATH}; sarathi runs it`,
    });
  }
  return found;
}

/**
 * Which of onboard's Auto-fix and artifact rules the repo's
 * `.claude/settings.json` lacks, so the auto-mode classifier refuses an agent
 * session turning Auto-fix on, or publishing the page an ask to the owner
 * links: checked in an onboarded repo whose file doctor can read. A rule the
 * file's `permissions.deny` overrides is denied on purpose, not missing.
 */
function allowFindings(sys: Sys): Finding[] {
  let settings: unknown;
  try {
    // Where session-start looks, so a cloud session's CLI run from outside the clone still finds it.
    const root = repoRoot(sys);
    if (!hasSettings(sys, root) || !sys.exists(`${root}/${HOOKS_PATH}`)) return [];
    settings = JSON.parse(sys.read(`${root}/${HOOKS_PATH}`)) as unknown;
  } catch {
    // Outside a clone, or a file doctor cannot read: onboard says what is wrong with it.
    return [];
  }
  return [
    ...groupFindings(autoFixRuleNeeds(settings), AUTO_FIX_RULES, 'agent sessions cannot turn Auto-fix on', 'agent sessions do not turn Auto-fix on'),
    ...groupFindings(artifactRuleNeeds(settings), ARTIFACT_RULES, 'agent sessions cannot publish the page an ask to the owner links', 'agent sessions do not publish pages'),
  ];
}

/**
 * One group's findings: ▲ for the rules it lacks, and ✓ for those its deny
 * rules override, which the owner chose and onboard leaves out, so nothing
 * there is to fix. A whole group denied says what sessions then do not do;
 * a part of one names the tools denied, since the others still work.
 */
function groupFindings(needs: RuleNeeds, rules: readonly string[], cannot: string, chosen: string): Finding[] {
  const so = needs.denied.length === rules.length ? chosen : `agent sessions do not use ${needs.denied.join(', ')}`;
  return [
    ...(needs.missing.length === 0 ? [] : [{ mark: '▲' as const, text: `${HOOKS_PATH} does not allow ${needs.missing.join(', ')}, so ${cannot}`, fix: ONBOARD }]),
    ...(needs.denied.length === 0 ? [] : [{ mark: '✓' as const, text: `${HOOKS_PATH} denies ${needs.deniedBy.join(', ')} on purpose, so ${so}` }]),
  ];
}

/** Prints the findings, grouped, and closes; exit 1 when any is broken. */
function report(sys: Sys, io: Output, about: string, groups: [title: string, findings: Finding[]][]): number {
  const paint = painter(sys);
  io.out(heading(paint, 'doctor', about));
  for (const [title, findings] of groups) {
    for (const line of findingLines(paint, title, findings)) io.out(line);
  }
  io.out(paint.dim('│'));
  const all = groups.flatMap(([, findings]) => findings);
  const toFix = all.filter((finding) => finding.mark !== '✓').length;
  io.out(closing(paint, toFix === 0 ? 'All good' : `${toFix} to fix`));
  return all.some((finding) => finding.mark === '✗') ? 1 : 0;
}

const ONBOARD = 'niyam onboard again';

/**
 * A Claude cloud session's checks, reading only: no keychain, signing key,
 * session file or launcher here, and GitHub reached through the session's
 * proxy as the account connected to claude.ai. In the session: the release
 * the repo's cloud setup file installs against the one its workflow pins,
 * the CLI running against that, and the mark the Setup snippet leaves when
 * it ran the file (as session-start's `cloudDrift` reads them, without
 * installing anything). On GitHub: the account the proxy acts as is one of
 * the repo settings' agents, as session-start checks it, and session-start
 * gave this session that identity. In the repo, hooks as on a Mac.
 */
async function cloudDoctor(sys: Sys, io: Output, named?: string): Promise<number> {
  const session: Finding[] = [];
  const github: Finding[] = [];
  let root: string | undefined;
  // The cloud setup file the repo has: under its old name, until onboard moves it.
  let setupFile = CLOUD_SETUP_PATH;
  try {
    root = repoRoot(sys);
  } catch (error) {
    session.push({ mark: '✗', text: message(error), fix: "niyam doctor in the repo's clone" });
  }

  if (root !== undefined) {
    const { pinned, scripted, workflow, script } = repoReleases(sys, root);
    setupFile = script;
    if (scripted === undefined) {
      session.push({ mark: '✗', text: `${script} missing, or not the file onboard writes, so a session without niyam cannot install it`, fix: ONBOARD });
    } else if (pinned === undefined) {
      session.push({ mark: '▲', text: `${workflow} is missing or pins no one version, so ${script} is not checked against it`, fix: ONBOARD });
    } else if (pinned !== scripted) {
      session.push({ mark: '✗', text: `${script} installs ${scripted}, but ${workflow} pins v${pinned}`, fix: ONBOARD });
    } else {
      session.push({ mark: '✓', text: `${script} installs ${scripted}, as ${workflow} pins` });
    }
    const installed = packageVersion();
    const wanted = scripted ?? pinned;
    if (wanted === installed) {
      session.push({ mark: '✓', text: `niyam ${installed} runs here` });
    } else if (scripted !== undefined) {
      session.push({ mark: '▲', text: `this session runs niyam ${installed}, not the ${scripted} ${script} installs`, fix: `bash ${script}, or a new session` });
    } else if (pinned !== undefined) {
      session.push({ mark: '▲', text: `this session runs niyam ${installed}, not the v${pinned} ${workflow} pins`, fix: `${ONBOARD}, then a new session` });
    }
  }
  session.push(
    ranFromSetup(sys)
      ? { mark: '✓', text: `the Setup script runs ${fileFromSetup(sys) ?? "the repo's cloud setup file"}` }
      : // The SessionStart hook installs niyam where the Setup script does not (P-60): the paste only makes sessions start faster.
        { mark: '✓', text: `the SessionStart hook installs niyam from ${setupFile} when a session has none; the Setup script does not run it, which only makes sessions start slower` },
  );

  let agents: readonly string[] | undefined = named === undefined ? undefined : [named];
  if (agents === undefined && root !== undefined) {
    try {
      agents = loadSettings(sys, root).agents;
    } catch (error) {
      github.push({ mark: '✗', text: `${message(error)}, so the agents are not known`, fix: ONBOARD });
    }
  }
  const asked = await cloudLogin(sys);
  if ('problem' in asked) {
    github.push({ mark: '✗', text: asked.problem, fix: 'niyam doctor again' });
  } else if (agents !== undefined) {
    github.push(
      anyLogin(agents, asked.login)
        ? { mark: '✓', text: `the proxy acts as ${asked.login}, an agent the repo's settings name` }
        : { mark: '✗', text: `the proxy acts as ${asked.login}, not ${either(agents)}`, fix: `connect claude.ai's GitHub as ${either(agents)}` },
    );
  }
  // What session-start exported when it lifted the lock; without it, gh and git in this session reach GitHub as nobody.
  // It must be an agent, and the account the proxy acts as now: another means the connection changed since.
  const given = agentIn(sys.env);
  github.push(
    given && (agents === undefined || anyLogin(agents, given)) && (!('login' in asked) || sameLogin(given, asked.login))
      ? { mark: '✓', text: `session-start gave this session ${given}'s identity` }
      : {
          mark: '✗',
          text: 'session-start did not give this session the agent identity, so gh and git stay locked out',
          fix: 'a new session; its first niyam line says why',
        },
  );
  const agent = given ?? ('login' in asked ? asked.login : undefined);
  if (agent !== undefined) github.push(cloudCommits(sys, agent));

  const about ='login' in asked ? asked.login : agents !== undefined ? either(agents) : 'this cloud session';
  return report(sys, io, about, [
    ['This cloud session', session],
    [`GitHub — as ${about}`, github],
    ['This repo', await repoFindings(sys)],
  ]);
}

/**
 * Whose a cloud session's commits are: the agent's when session-start gave it
 * the agent's author and signing (the key in SIGNING_KEY_VAR), else Claude's,
 * which PR identity passes, so a warning only, with what makes them the
 * agent's.
 */
function cloudCommits(sys: Sys, agent: string): Finding {
  const name = sys.env.GIT_AUTHOR_NAME;
  const email = sys.env.GIT_AUTHOR_EMAIL?.toLowerCase() ?? '';
  if (name !== undefined && sameLogin(name, agent) && /^\d+\+/.test(email) && email.endsWith(`+${agent.toLowerCase()}@${GITHUB_NOREPLY}`)) {
    return { mark: '✓', text: `this session's commits are ${agent}'s, signed with ${SIGNING_KEY_VAR}` };
  }
  if (sys.env[SIGNING_KEY_VAR]) {
    return { mark: '▲', text: `${SIGNING_KEY_VAR} is set, but session-start could not use it, so this session's commits are Claude's`, fix: 'a new session; its first niyam line says why' };
  }
  return {
    mark: '▲',
    text: `this session's commits are Claude's: the cloud environment's variables have no ${SIGNING_KEY_VAR}`,
    fix: `niyam cloud-key ${agent} on your Mac, then paste it into the environment's variables`,
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
