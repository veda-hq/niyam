import { AGENT_VAR, CLI, CONFIG_DIR, PRODUCT } from './names.ts';
import {
  API,
  BASE_ENV,
  CLOUD_SIGNING_KEYS,
  SETTINGS_PATH,
  account,
  agentHere,
  agentIn,
  agentsSetUp,
  anyLogin,
  checkToken,
  either,
  isLogin,
  keyPairProblem,
  loadSettings,
  pathsFor,
  readToken,
  repoAt,
  sameLogin,
  sessionEnv,
  settingsIn,
  tokenInfo,
} from './agent.ts';
import { setUpBoard } from './board.ts';
import { BOARD_SECRETS, boardAppSteps, setUpBoardApp } from './board-app.ts';
import { agentSession } from './push-identity.ts';
import { type TypesPlan, typesDetail, typesLines, typesPlan } from './issue-types.ts';
import { type OwnerToken, asOwner, isOrganisation, ownerScopes, signInOnce } from './owner-login.ts';
import { appendToArray, removeElements, replaceValues, setMember } from './jsonedit.ts';
import { HOURLY } from './asks.ts';
import { routineTrace } from './reviews.ts';
import { DEFAULT_SCHEDULE, type Feature, FEATURES, FIGMA_FILE_KEY, NEEDS_ISSUE_TYPES, featuresIn, parseFeatures, renamedLines, scheduleIn } from './features.ts';
import {
  type Change,
  CLOUD_SETUP_PATH,
  HOOKS_PATH,
  LEFTOVER_CLOUD_SETUP_PATH,
  ONBOARD_BRANCH,
  SARATHI_PATH,
  WORKFLOW_PATH,
  autoMerge,
  mergeQueue,
  openPull,
  remoteFile,
} from './onboard-pull.ts';
import { SIGNING_KEY_VAR, cloudRepoScript, cloudScriptVersion, releaseSha256 } from './cloud.ts';
import { GUARD_CALLER_PATH, callerAt, callerIsOnboards, callerPins, callerDetail, callerUpdate, callerWhat, policySteps } from './guard-caller.ts';
import { CLOUD_KEY_TITLE, cloudKeyRefusal, listedKeys, makeCloudKey, pasteLines } from './cloud-key.ts';
import { newKey, publicLine } from './sshsig.ts';
import { detail } from './doc-numbers.ts';
import { tagOnMain } from './release-tag.ts';
import { secretNames, setSecret } from './secrets.ts';
import { UPGRADE } from './upgrade.ts';
import { isNewer, packageVersion } from './version.ts';
import type { Output, Sys } from './types.ts';
import { GITHUB_WEB } from './host.ts';
import { type Item, type Paint, byHandLines, closing, heading, painter, planLines, runStep } from './layout.ts';

/** Where claude.ai connects the GitHub account its cloud sessions and routines work as. */
export const CLAUDE_CODE_WEB = 'https://claude.ai/code';
/** Where claude.ai changes that connection. */
export const CLAUDE_CONNECTORS = 'https://claude.ai/customize/connectors';

/** Where `cloud-setup`'s script goes in a Setup field the repo's own setup shares. */
export const SETUP_FIRST = "If the repo has its own Setup script, put this first, then the repo's own: a repo's script may end with exit, and nothing after that runs.";

/** This product's repository: clients call its shared workflow. */
export { PRODUCT } from './names.ts';
export { HOOKS_PATH, SARATHI_PATH, WORKFLOW_PATH } from './onboard-pull.ts';
/** The launcher `machine` writes, as a hook's shell spells it. */
const HOOK_LAUNCHER = `$HOME/${CONFIG_DIR}/bin/${CLI}`;

/**
 * The pre-push git hook: before a local agent session pushes, that it
 * reaches GitHub as the agent, then the work rules. It needs no Claude Code
 * hook to have run: any shell Claude Code runs sets CLAUDECODE, in a Claude
 * cloud session too.
 */
export const PRE_PUSH_HOOK = [
  '#!/bin/sh',
  '# Written by niyam onboard: before an agent session pushes, that it pushes as the agent, then the work rules.',
  '# Anyone else\'s push goes ahead. Without the CLI nothing can check an agent session\'s push, so it is refused.',
  `[ -z "$${AGENT_VAR}" ] && [ "$CLAUDECODE" != 1 ] && exit 0`,
  `cli="${HOOK_LAUNCHER}"`,
  `[ -x "$cli" ] || cli=${CLI}`,
  'if ! command -v "$cli" >/dev/null 2>&1; then',
  '  echo "niyam: the CLI is not installed, so this agent push cannot be checked" >&2',
  '  exit 1',
  'fi',
  'exec "$cli" pre-push "$@"',
  '',
].join('\n');

/** The pre-push hooks older releases wrote, which onboard replaces with this release's. */
export const OLDER_PRE_PUSH_HOOKS = [
  // 0.6.10's, before P-57: the agent by either variable, the launcher in the new folder, else the old one.
  [
    '#!/bin/sh',
    '# Written by niyam onboard: before an agent session pushes, that it pushes as the agent, then the work rules.',
    '# Anyone else\'s push goes ahead. Without the CLI nothing can check an agent session\'s push, so it is refused.',
    '[ -z "$NIYAM_AGENT" ] && [ -z "$PROCESS_RULES_AGENT" ] && [ "$CLAUDECODE" != 1 ] && exit 0',
    'cli="$HOME/.config/niyam/bin/niyam"',
    '[ -x "$cli" ] || cli="$HOME/.config/process-rules/bin/process-rules"',
    '[ -x "$cli" ] || cli=niyam',
    'if ! command -v "$cli" >/dev/null 2>&1; then',
    '  echo "niyam: the CLI is not installed, so this agent push cannot be checked" >&2',
    '  exit 1',
    'fi',
    'exec "$cli" pre-push "$@"',
    '',
  ].join('\n'),
  // 0.6.8 and 0.6.9's, before P-55: the agent by its old variable alone, the launcher in the old folder alone.
  [
    '#!/bin/sh',
    '# Written by niyam onboard: before an agent session pushes, that it pushes as the agent, then the work rules.',
    '# Anyone else\'s push goes ahead. Without the CLI nothing can check an agent session\'s push, so it is refused.',
    '[ -z "$PROCESS_RULES_AGENT" ] && [ "$CLAUDECODE" != 1 ] && exit 0',
    'cli="$HOME/.config/process-rules/bin/process-rules"',
    '[ -x "$cli" ] || cli=niyam',
    'if ! command -v "$cli" >/dev/null 2>&1; then',
    '  echo "niyam: the CLI is not installed, so this agent push cannot be checked" >&2',
    '  exit 1',
    'fi',
    'exec "$cli" pre-push "$@"',
    '',
  ].join('\n'),
  [
    '#!/bin/sh',
    '# Written by process-rules onboard: before an agent session pushes, that it pushes as the agent, then the work rules.',
    '# Anyone else\'s push goes ahead. Without the CLI nothing can check an agent session\'s push, so it is refused.',
    '[ -z "$PROCESS_RULES_AGENT" ] && [ "$CLAUDECODE" != 1 ] && exit 0',
    'cli="$HOME/.config/process-rules/bin/process-rules"',
    '[ -x "$cli" ] || cli=process-rules',
    'if ! command -v "$cli" >/dev/null 2>&1; then',
    '  echo "process-rules: the CLI is not installed, so this agent push cannot be checked" >&2',
    '  exit 1',
    'fi',
    'exec "$cli" pre-push "$@"',
    '',
  ].join('\n'),
  [
    '#!/bin/sh',
    '# Written by process-rules onboard: before an agent session pushes, that it pushes as the agent, then the work rules.',
    '# Anyone else\'s push goes ahead. Without the CLI nothing can check an agent session\'s push, so it is refused.',
    '[ "$CLAUDE_CODE_REMOTE" = true ] && exit 0',
    '[ -z "$PROCESS_RULES_AGENT" ] && [ "$CLAUDECODE" != 1 ] && exit 0',
    'cli="$HOME/.config/process-rules/bin/process-rules"',
    '[ -x "$cli" ] || cli=process-rules',
    'if ! command -v "$cli" >/dev/null 2>&1; then',
    '  echo "process-rules: the CLI is not installed, so this agent push cannot be checked" >&2',
    '  exit 1',
    'fi',
    'exec "$cli" pre-push "$@"',
    '',
  ].join('\n'),
  [
    '#!/bin/sh',
    '# Written by process-rules onboard: the work rules before an agent session pushes.',
    '# Without the CLI nothing can check an agent session\'s push, so it is refused; anyone else\'s goes ahead.',
    'if ! command -v process-rules >/dev/null 2>&1; then',
    '  [ -z "$PROCESS_RULES_AGENT" ] && exit 0',
    '  echo "process-rules: the CLI is not installed, so this agent push cannot be checked against the work rules" >&2',
    '  exit 1',
    'fi',
    'exec process-rules pre-push "$@"',
    '',
  ].join('\n'),
];

/**
 * The pre-push git hook git runs in the repository at `root`, and how it
 * stands: outside the repository (a shared hooks folder, the owner's to
 * change), missing, one an older release wrote, this release's or one that
 * runs the CLI, or the client's own.
 */
export function prePushHook(sys: Sys, root: string): { path: string; file: string; state: 'outside' | 'missing' | 'older' | 'ours' | 'own' } {
  const path = sys.exec('git', ['rev-parse', '--git-path', 'hooks/pre-push'], { cwd: root }).stdout.trim();
  const file = path.startsWith('/') ? path : `${root}/${path}`;
  const gitDir = sys.exec('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root }).stdout.trim();
  if (!file.startsWith(`${root}/`) && !file.startsWith(`${gitDir}/`)) return { path, file, state: 'outside' };
  if (!sys.exists(file)) return { path, file, state: 'missing' };
  const text = sys.read(file);
  if (OLDER_PRE_PUSH_HOOKS.includes(text)) return { path, file, state: 'older' };
  return { path, file, state: /^\s*(?:exec\s+)?(?:"\$cli"|niyam)\s+pre-push\b/m.test(text) ? 'ours' : 'own' };
}

/** How a hook finds the CLI: the launcher `machine` writes, else niyam on PATH. */
const FIND_CLI = `cli="${HOOK_LAUNCHER}"; [ -x "$cli" ] || cli=${CLI}; `;
/** How hooks from P-55 to P-57 (0.6.10) found it: the launcher, else the one in the folder before P-55, else niyam on PATH. */
const P55_FIND_CLI = 'cli="$HOME/.config/niyam/bin/niyam"; [ -x "$cli" ] || cli="$HOME/.config/process-rules/bin/process-rules"; [ -x "$cli" ] || cli=niyam; ';
/** How hooks from P-53 to P-55 found it: the launcher in the old folder, else niyam on PATH. */
const P53_FIND_CLI = 'cli="$HOME/.config/process-rules/bin/process-rules"; [ -x "$cli" ] || cli=niyam; ';
/** How hooks before P-53 found it: the launcher, else process-rules on PATH. */
const OLD_FIND_CLI = 'cli="$HOME/.config/process-rules/bin/process-rules"; [ -x "$cli" ] || cli=process-rules; ';

/** The SessionStart hook after it has found the CLI. */
const HOOK_RUN =
  'if said=$("$cli" session-start 2>&1); then printf \'%s\\n\' "$said"; ' +
  'else printf \'%s\\n\' "niyam: STOP. niyam session-start did not run here ($said), so this session cannot be given the agent identity and GitHub is locked out of it. Do not push, fetch, or run gh in this session; tell the owner."; fi';

/**
 * In a Claude cloud session with no CLI, the SessionStart hook installs it
 * from the clone's cloud setup file, which onboard keeps at the pin, so no
 * Setup script needs pasting: Claude Code has no API for one. The install's
 * own output is dropped; a failure says its last line and the user it ran
 * as, since it writes under /opt and /usr/local, before the STOP that
 * follows when session-start still cannot run. On a Mac, or with a CLI
 * found, it does nothing.
 */
const CLOUD_INSTALL =
  `if [ "\${CLAUDE_CODE_REMOTE:-}" = true ] && ! command -v "$cli" >/dev/null 2>&1; then ` +
  `setup="\${CLAUDE_PROJECT_DIR:-.}/${CLOUD_SETUP_PATH}"; ` +
  'if [ ! -f "$setup" ]; then printf \'%s\\n\' "niyam: this cloud session has no niyam, and the clone has no ' + CLOUD_SETUP_PATH + ' to install it from; run niyam onboard, which writes it."; ' +
  'elif failed=$(bash "$setup" </dev/null 2>&1 >/dev/null); then printf \'%s\\n\' "niyam: this cloud session had no niyam, so the SessionStart hook installed it from ' + CLOUD_SETUP_PATH + '."; ' +
  'else printf \'%s\\n\' "niyam: this cloud session has no niyam, and installing it from ' + CLOUD_SETUP_PATH + ' as $(id -un) (uid $(id -u)) failed: $(printf \'%s\\n\' "$failed" | tail -n 1)"; fi; fi; ';

/**
 * What the client's SessionStart hook runs, on a Mac and in a Claude cloud
 * session alike. When the CLI is missing or fails, what it printed reaches
 * the session inside a line telling it to stop; the settings' `env` has
 * already locked GitHub out. A cloud session with no CLI installs it first
 * (CLOUD_INSTALL).
 */
export const HOOK_COMMAND = FIND_CLI + CLOUD_INSTALL + HOOK_RUN;

/** The PreToolUse hook before it finds the CLI: a command naming neither gh nor git goes ahead. */
const GUARD_SKIP =
  'input=$(cat); ' +
  // The command alone, not the rest of the input, such as its description and paths.
  'cmd=$(printf \'%s\' "$input" | sed -nE \'s/.*"command"[[:space:]]*:[[:space:]]*"(([^"\\\\]|\\\\.)*)".*/\\1/p\'); ' +
  'printf \'%s\' "$cmd" | grep -Eq \'(^|[^[:alnum:]_-])(gh|git)([^[:alnum:]_-]|$)\' || exit 0; ';
/** The PreToolUse hook after it has found the CLI. */
const GUARD_RUN =
  'printf \'%s\' "$input" | "$cli" guard && exit 0; [ $? -eq 2 ] && exit 2; ' +
  'echo "niyam: refused, because the niyam CLI did not run here to check this command. Do not work around it; tell the owner." >&2; exit 2';

/**
 * What the client's PreToolUse hook runs before each Bash command: `guard`
 * refuses gh and git's remote commands outside the agent identity. A command
 * not naming either as a word goes ahead without starting the CLI. When the CLI cannot
 * run, every command naming either is refused, so a broken CLI fails closed.
 */
export const GUARD_COMMAND = GUARD_SKIP + FIND_CLI + GUARD_RUN;

/**
 * The permission rule that lets agent sessions answer review threads on
 * their own pull requests without a prompt: only the CLI command that does
 * that and checks it, not `gh api`, whose rules cannot hold its arguments.
 */
export const REVIEW_THREAD_RULE = 'Bash(niyam review-thread *)';
/** The rule before P-53, under the old command, which onboard replaces. */
export const OLDER_REVIEW_THREAD_RULE = 'Bash(process-rules review-thread *)';

/**
 * The permission rules that let agent sessions turn the desktop app's
 * Auto-fix on for the pull requests they open, as session-start's AUTO_FIX
 * tells them to: bind the pull request, read its status, and set its
 * monitor. Without them the auto-mode classifier refuses the calls. They
 * reach the app only, not GitHub.
 */
export const AUTO_FIX_RULES = ['mcp__ccd_pr__bind_pr', 'mcp__ccd_pr__get_status', 'mcp__ccd_pr__set_monitor'] as const;

/** The rules that allow every tool of the app's pull request server, AUTO_FIX_RULES among them. */
const PR_SERVER_RULES = ['mcp__ccd_pr', 'mcp__ccd_pr__*'];

/**
 * The permission rules that let agent sessions publish the claude.ai page
 * every ask to the owner links (`Needs you:`, `Proposal:`, `niyam propose
 * --page`): a new page, one from files, and a change to one. Without them
 * the auto-mode classifier refuses the calls as communication. A new page
 * is private to its owner, but a republish (`publish_version` or
 * `edit_version` with a slug) to a page already shared with an organisation
 * or the public changes what its readers see, with no prompt: a cost the
 * owner accepted on veda-hq/niyam#432. Claude Code skips an `mcp__` allow
 * rule with arguments, so no rule here can limit them to private pages.
 */
export const ARTIFACT_RULES = ['mcp__claude-artifacts__publish_version', 'mcp__claude-artifacts__publish_files', 'mcp__claude-artifacts__edit_version'] as const;

/** The rules that allow every tool of the artifacts server, ARTIFACT_RULES among them. */
const ARTIFACT_SERVER_RULES = ['mcp__claude-artifacts', 'mcp__claude-artifacts__*'];

/** A group of `rules` a settings file needs: those its `permissions.allow` lacks, and those its `permissions.deny` overrides. */
export interface RuleNeeds {
  /** Lacking and not denied, in their order: what onboard adds. */
  missing: string[];
  /** Overridden by a deny rule, in their order, as the file's owner chose. */
  denied: string[];
  /** Those of `denied` onboard would add but for the deny: what it leaves out. */
  leftOut: string[];
  /** The file's deny rules that override them, in the file's order. */
  deniedBy: string[];
  /** Those of `deniedBy` that override a rule in `leftOut`, in the file's order. */
  leftOutBy: string[];
}

/**
 * Whether deny rule `by` matches MCP tool `tool` of the server named `bare`
 * (`mcp__<server>`), as Claude Code's permissions page says rules match: the
 * tool's own name, the bare server, `*` and `mcp__*` (every tool, every MCP
 * tool), and a glob in the tool name after a literal `mcp__<server>__`, such
 * as `mcp__<server>__*` or `mcp__<server>__publish_*`. A glob in the server's
 * own name the page does not describe, so it matches nothing here.
 */
function deniesTool(by: string, tool: string, bare: string): boolean {
  if (by === tool || by === bare || by === '*' || by === 'mcp__*') return true;
  const prefix = `${bare}__`;
  if (!by.startsWith(prefix) || !by.includes('*') || !tool.startsWith(prefix)) return false;
  const glob = by.slice(prefix.length).split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${glob}$`).test(tool.slice(prefix.length));
}

/**
 * Which of `rules` a settings file lacks, in their order: none lacks when
 * its `permissions.allow` allows the whole server, by one of `server`. Claude
 * Code applies deny before allow, so a rule that `permissions.deny` overrides
 * (`deniesTool`) is denied, not missing: an allow rule for it would do
 * nothing. A deny or allow that is not an array names nothing.
 */
function ruleNeeds(settings: unknown, rules: readonly string[], server: string[]): RuleNeeds {
  const permissions = (settings as { permissions?: { allow?: unknown; deny?: unknown } } | null)?.permissions;
  const listed = (value: unknown): string[] => (Array.isArray(value) ? value.filter((rule): rule is string => typeof rule === 'string') : []);
  const allow = listed(permissions?.allow);
  const deny = listed(permissions?.deny);
  const bare = server[0]!;
  const deniedBy = deny.filter((by) => rules.some((rule) => deniesTool(by, rule, bare)));
  const denied = rules.filter((rule) => deny.some((by) => deniesTool(by, rule, bare)));
  if (allow.some((rule) => server.includes(rule))) return { missing: [], denied, leftOut: [], deniedBy, leftOutBy: [] };
  const lacking = rules.filter((rule) => !allow.includes(rule));
  const leftOut = lacking.filter((rule) => denied.includes(rule));
  const leftOutBy = deniedBy.filter((by) => leftOut.some((rule) => deniesTool(by, rule, bare)));
  return { missing: lacking.filter((rule) => !denied.includes(rule)), denied, leftOut, deniedBy, leftOutBy };
}

/** Which of AUTO_FIX_RULES a settings file lacks, and which its deny rules override. */
export function autoFixRuleNeeds(settings: unknown): RuleNeeds {
  return ruleNeeds(settings, AUTO_FIX_RULES, PR_SERVER_RULES);
}

/** Which of ARTIFACT_RULES a settings file lacks, and which its deny rules override. */
export function artifactRuleNeeds(settings: unknown): RuleNeeds {
  return ruleNeeds(settings, ARTIFACT_RULES, ARTIFACT_SERVER_RULES);
}

/**
 * What a group's left-out rules come to, in a line for onboard's plan: the
 * group's name when the deny leaves all of it out, else the rules it does.
 * A denied rule the file allows already is not left out, and goes unsaid.
 */
function deniedLines(needs: RuleNeeds, rules: readonly string[], group: string): string[] {
  if (needs.leftOut.length === 0) return [];
  return [`${needs.leftOut.length === rules.length ? group : needs.leftOut.join(', ')} left out: ${HOOKS_PATH} denies ${needs.leftOutBy.join(', ')}`];
}

/** The hook commands older releases wrote, which onboard replaces with this release's. */
export const OLDER_HOOK_COMMANDS = [
  // 0.6.11 to 0.6.16's, before P-60: a cloud session with no CLI stopped.
  FIND_CLI + HOOK_RUN,
  // 0.6.10's, before P-57.
  P55_FIND_CLI + HOOK_RUN,
  // 0.6.8 and 0.6.9's, before P-55: the launcher in the old folder alone.
  P53_FIND_CLI + HOOK_RUN,
  OLD_FIND_CLI +
    'if said=$("$cli" session-start 2>&1); then printf \'%s\\n\' "$said"; ' +
    'else printf \'%s\\n\' "process-rules: STOP. process-rules session-start did not run here ($said), so this session cannot be given the agent identity and GitHub is locked out of it. Do not push, fetch, or run gh in this session; tell the owner."; fi',
  `if [ "$CLAUDE_CODE_REMOTE" = true ]; then [ -z "$CLAUDE_ENV_FILE" ] || echo 'unset ${Object.keys(BASE_ENV).join(' ')}' >> "$CLAUDE_ENV_FILE"; else ` +
    OLD_FIND_CLI +
    'if said=$("$cli" session-start 2>&1); then printf \'%s\\n\' "$said"; ' +
    'else printf \'%s\\n\' "process-rules: STOP. process-rules session-start did not run here ($said), so this session cannot be given the agent identity and GitHub is locked out of it. Do not push, fetch, or run gh in this session; tell the owner."; fi; fi',
  'command -v process-rules >/dev/null 2>&1 && process-rules session-start || ' +
    'echo "process-rules: STOP. The process-rules CLI is not installed here, so this session cannot be given the agent identity and gh and git would act as the owner. Do not push, fetch, or run gh in this session; tell the owner."',
  'if [ "$CLAUDE_CODE_REMOTE" = true ]; then :; ' +
    'elif command -v process-rules >/dev/null 2>&1 && process-rules session-start; then :; ' +
    'else echo "process-rules: STOP. The process-rules CLI is missing or did not run here, so this session cannot be given the agent identity and gh and git would act as the owner. Do not push, fetch, or run gh in this session; tell the owner."; fi',
];

/** The guard commands older releases wrote, which onboard replaces with this release's. */
export const OLDER_GUARD_COMMANDS = [
  // 0.6.10's, before P-57.
  GUARD_SKIP + P55_FIND_CLI + GUARD_RUN,
  // 0.6.8 and 0.6.9's, before P-55.
  GUARD_SKIP + P53_FIND_CLI + GUARD_RUN,
  'input=$(cat); ' +
    'cmd=$(printf \'%s\' "$input" | sed -nE \'s/.*"command"[[:space:]]*:[[:space:]]*"(([^"\\\\]|\\\\.)*)".*/\\1/p\'); ' +
    'printf \'%s\' "$cmd" | grep -Eq \'(^|[^[:alnum:]_-])(gh|git)([^[:alnum:]_-]|$)\' || exit 0; ' +
    OLD_FIND_CLI +
    'printf \'%s\' "$input" | "$cli" guard && exit 0; [ $? -eq 2 ] && exit 2; ' +
    'echo "process-rules: refused, because the process-rules CLI did not run here to check this command. Do not work around it; tell the owner." >&2; exit 2',
  '[ "$CLAUDE_CODE_REMOTE" = true ] && exit 0; input=$(cat); ' +
    // The command alone, not the rest of the input, such as its description and paths.
    'cmd=$(printf \'%s\' "$input" | sed -nE \'s/.*"command"[[:space:]]*:[[:space:]]*"(([^"\\\\]|\\\\.)*)".*/\\1/p\'); ' +
    'printf \'%s\' "$cmd" | grep -Eq \'(^|[^[:alnum:]_-])(gh|git)([^[:alnum:]_-]|$)\' || exit 0; ' +
    OLD_FIND_CLI +
    'printf \'%s\' "$input" | "$cli" guard && exit 0; [ $? -eq 2 ] && exit 2; ' +
    'echo "process-rules: refused, because the process-rules CLI did not run here to check this command. Do not work around it; tell the owner." >&2; exit 2',
];

/** The comment above the workflow's schedule, naming when the decisions job runs. */
function scheduleComment(schedule: string, settings: string = SETTINGS_PATH): string {
  return schedule === DEFAULT_SCHEDULE
    ? '  # The weekly decisions job: Mondays, 06:17 UTC.'
    : `  # The decisions job: cron ${schedule}, UTC, as "schedule" in ${settings} sets it.`;
}

/** The pull request events the workflow runs on, with why: since P-46, closed too. */
const TRIGGER_TYPES = [
  '    # edited: a changed "Slice: #N" line is checked again; closed: a merged pull request closes its slice.',
  '    types: [opened, synchronize, reopened, edited, closed]',
];
/** The pull request events before P-46. */
const OLDER_TRIGGER_TYPES = ['    # edited: a changed "Slice: #N" line is checked again.', '    types: [opened, synchronize, reopened, edited]'];
/** The read-only job's condition: a closed pull request runs the merged job alone. */
const READ_ONLY_IF = "    if: (github.event_name == 'pull_request' && github.event.action != 'closed') || github.event_name == 'push'";
const SPLIT_COMMENT = '# The weekly, merged and needs-owner jobs are split out so pull request and push runs stay read-only.';
/** The comment before the needs-owner job. */
const MERGED_SPLIT_COMMENT = '# The weekly and merged jobs are split out so pull request and push runs stay read-only.';

/** The issue events: the owner's approved label, and since 0.6.4 an issue opened or reopened, which gets a type if it has none. */
const ISSUE_TRIGGER = ['  # opened, reopened: an issue with no type gets the work model\'s.', '  issues:', '    types: [labeled, opened, reopened]'];
/** The issue events before 0.6.4: the label alone. */
const OLDER_ISSUE_TRIGGER = ['  issues:', '    types: [labeled]'];
/** The asks job's clause for the approved label, after which 0.6.4 adds the opened and reopened one. */
const ASKS_LABEL_IF = "      (github.event_name == 'issues' && github.event.label.name == 'approved') ||";
const ASKS_TYPE_IF = "      (github.event_name == 'issues' && (github.event.action == 'opened' || github.event.action == 'reopened')) ||";

const ASKS_COMMENT = "  # An ask labels its issue needs-owner, which the board's Needs you view lists; the owner's answer takes it off.";
const ASKS_TYPE_COMMENT = "  # An issue opened or reopened with no type gets the work model's.";

/** The events an ask and the owner's answer to it raise: since 0156 S-2, a comment and a label. */
const ASK_TRIGGERS = [
  "  # A comment that asks the owner labels its issue needs-owner; the owner's approved label or Decision: comment takes it off.",
  '  issue_comment:',
  '    types: [created]',
  '  pull_request_review_comment:',
  '    types: [created]',
  ...ISSUE_TRIGGER,
];
/** The second cron, after the decisions job's: the hourly needs-owner sweep. */
const HOURLY_CRON = ["    # Hourly: the owner's 👍 on an ask takes its needs-owner label off.", `    - cron: '${HOURLY}'`];
/** The weekly job's condition: the decisions job's cron, not the hourly one, or a run by hand. */
const WEEKLY_IF = `    if: (github.event_name == 'schedule' && github.event.schedule != '${HOURLY}') || github.event_name == 'workflow_dispatch'`;
/** The weekly job's condition before the hourly sweep. */
const OLDER_WEEKLY_IF = "    if: github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'";
/** The asks job's comment clause: a comment by the owner, a member or a collaborator that may ask or decide. */
const ASKS_COMMENT_IF = [
  "      ((github.event_name == 'issue_comment' || github.event_name == 'pull_request_review_comment') &&",
  `      contains(fromJSON('["OWNER", "MEMBER", "COLLABORATOR"]'), github.event.comment.author_association) &&`,
  "      (contains(github.event.comment.body, 'Needs you:') || contains(github.event.comment.body, 'Proposal:') ||",
  "      contains(github.event.comment.body, 'Decision:'))) ||",
];
/** The clause 0.5.28 wrote, which any commenter's comment met; onboard adds the author check. */
const OLDER_ASKS_COMMENT_IF = ASKS_COMMENT_IF.filter((_, at) => at !== 1);

/**
 * The job that labels an issue where the agent asks the owner, and takes the
 * label off at the owner's answer: only comments that may ask or decide, the
 * owner's approved label and the hourly sweep start it, so other comments run
 * nothing. A comment starts it only from the owner, a member or a collaborator,
 * so no outsider's comment runs a job that may write; needs-owner itself acts
 * only on the agent's ask and the owner's answer.
 */
function asksJob(version: string, secrets: string[]): string[] {
  return [
    ASKS_COMMENT,
    ASKS_TYPE_COMMENT,
    `  ${CLI}-asks:`,
    jobName(`${CLI}-asks`),
    '    if: >-',
    ...ASKS_COMMENT_IF,
    ASKS_LABEL_IF,
    ASKS_TYPE_IF,
    `      (github.event_name == 'schedule' && github.event.schedule == '${HOURLY}')`,
    '    permissions:',
    '      contents: read',
    '      issues: write',
    '      pull-requests: write',
    ...callChecks(version, secrets),
    '',
  ];
}

/** The job that closes the slice a merged pull request names, which alone of a pull request's runs writes to issues. */
function mergedJob(version: string, secrets: string[]): string[] {
  return [
    '  # A merged pull request closes the slice it names, which moves it to Done on the board.',
    `  ${CLI}-merged:`,
    jobName(`${CLI}-merged`),
    // Into the default branch alone, and from this repository: a fork's run gets a read-only token.
    '    if: >-',
    "      github.event_name == 'pull_request' && github.event.action == 'closed' && github.event.pull_request.merged &&",
    '      github.event.pull_request.base.ref == github.event.repository.default_branch &&',
    '      github.event.pull_request.head.repo.full_name == github.repository',
    '    permissions:',
    '      contents: read',
    '      issues: write',
    '      pull-requests: read',
    ...callChecks(version, secrets),
    '',
  ];
}

/**
 * The lines a workflow from before the merged job has where this release's
 * differs, each with what this release writes there; the comment is
 * optional, the others mark the template.
 */
const BEFORE_MERGED: { was: string; now: string; optional?: true }[] = [
  { was: '# The weekly job is split out so pull request and push runs stay read-only.', now: MERGED_SPLIT_COMMENT, optional: true },
  { was: OLDER_TRIGGER_TYPES.join('\n'), now: TRIGGER_TYPES.join('\n') },
  { was: "    if: github.event_name == 'pull_request' || github.event_name == 'push'", now: READ_ONLY_IF },
];

/**
 * A two-job workflow from before the merged job, as `before`, with the
 * merged job added at the version it pins and the pull request runs made to
 * leave it alone; undefined when its lines are not the template's.
 */
function addMergedJob(before: string, version: string, figma: boolean): string | undefined {
  let text = before;
  for (const { was, now, optional } of BEFORE_MERGED) {
    if (text.split(was).length !== 2) {
      if (optional) continue;
      return undefined;
    }
    text = text.replace(was, now);
  }
  return `${text.replace(/\n*$/, '\n')}\n${mergedJob(version, figma ? FIGMA_SECRETS : []).join('\n')}`;
}

/**
 * A three-job workflow from before the needs-owner job, as `before`, with
 * that job added at the version it pins: the comment and label triggers
 * before the schedule, the hourly cron after the decisions job's one, and the
 * weekly job made to leave the hourly runs alone. Undefined when its lines
 * are not the template's.
 */
function addAsksJob(before: string, version: string, figma: boolean): string | undefined {
  if (before.split(OLDER_WEEKLY_IF).length !== 2 || !SCHEDULE.test(before)) return undefined;
  const text = before
    .replace(MERGED_SPLIT_COMMENT, SPLIT_COMMENT)
    .replace(OLDER_WEEKLY_IF, WEEKLY_IF)
    .replace(SCHEDULE, (lines: string) => `${ASK_TRIGGERS.join('\n')}\n${lines}\n${HOURLY_CRON.join('\n')}`);
  return `${text.replace(/\n*$/, '\n')}\n${asksJob(version, figma ? FIGMA_SECRETS : []).join('\n')}`;
}

/** The workflow's first line, naming the release it pins. */
const headerLine = (version: string): string => `# Written by ${CLI} onboard: the shared ${CLI} checks at v${version}.`;

/**
 * Each job's `name:`, which GitHub puts before the shared checks' own in a
 * check's name, as in `niyam / Work rules`; the ids say niyam too (P-56).
 */
export const JOB_NAMES: Record<string, string> = {
  [CLI]: CLI,
  [`${CLI}-weekly`]: `${CLI}-weekly`,
  [`${CLI}-merged`]: `${CLI}-merged`,
  [`${CLI}-asks`]: `${CLI}-asks`,
};
const jobName = (id: string): string => `    name: ${JOB_NAMES[id]}`;

/** The input naming the release each job pins. */
export const REF_INPUT = `${CLI}-ref`;

/** The workflow's head, down to its jobs, which every template shares; `asks` adds the needs-owner job's triggers. */
function workflowHead(branch: string, version: string, comments: string[], schedule = DEFAULT_SCHEDULE, types = TRIGGER_TYPES, asks = true, settings: string = SETTINGS_PATH): string[] {
  return [
    headerLine(version),
    ...comments,
    `name: ${CLI}`,
    '',
    'on:',
    '  pull_request:',
    ...types,
    '  push:',
    `    branches: [${JSON.stringify(branch)}]`,
    ...(asks ? ASK_TRIGGERS : []),
    scheduleComment(schedule, settings),
    '  schedule:',
    `    - cron: '${schedule}'`,
    ...(asks ? HOURLY_CRON : []),
    '  workflow_dispatch:',
    '',
    'permissions:',
    '  contents: read',
    '  issues: read',
    '  pull-requests: read',
    '',
    'jobs:',
  ];
}

/** The Figma secrets a job passes the shared checks, when the figma feature is on. */
const FIGMA_SECRETS = ['    secrets:', '      FIGMA_TOKEN: ${{ secrets.FIGMA_TOKEN }}', '      FIGMA_LIBRARY: ${{ secrets.FIGMA_LIBRARY }}'];
/** The secrets every job passed before P-23, whether figma was on or not. */
const OLDER_SECRETS = ['    secrets:', '      FIGMA_TOKEN: ${{ secrets.FIGMA_TOKEN }}'];
/** The board GitHub App's secrets, which the Slice started job makes its board token from (P-70). */
const BOARD_SECRET_LINES = BOARD_SECRETS.map((name) => `      ${name}: \${{ secrets.${name} }}`);
export { BOARD_SECRETS, boardAppSteps };

/** What the jobs pass the shared checks: the Figma secrets with figma on, and the board app's with board on. */
export interface Passed {
  figma: boolean;
  board: boolean;
}

/**
 * The secrets block job `id` passes the shared checks: the Figma secrets on
 * every job, and the board app's on the pull request job alone, since only
 * its Slice started job uses them.
 */
function secretsOf(id: string, { figma, board }: Passed): string[] {
  const lines = [...(figma ? FIGMA_SECRETS.slice(1) : []), ...(board && id === CLI ? BOARD_SECRET_LINES : [])];
  return lines.length > 0 ? ['    secrets:', ...lines] : [];
}

/** A secret onboard writes, by name, as a line of a job's block. */
const OWN_SECRET = String.raw`(?:FIGMA_(?:TOKEN|LIBRARY)|NIYAM_BOARD_APP_(?:ID|KEY))`;
/**
 * A job's `niyam-ref` line and the block of onboard's secrets after it, as
 * any release writes it, or the line alone when no secrets follow: a block
 * with secrets of the client's own, or `secrets: inherit`, is left as it is.
 */
const SECRETS_AFTER_REF = new RegExp(String.raw`^( {6}niyam-ref:[^\n]*\n)(?: {4}secrets:\n(?: {6}${OWN_SECRET}: \$\{\{ secrets\.${OWN_SECRET} \}\}\n)+(?! {6})|(?! {4}secrets:))`, 'gm');

/** The id of the job whose lines run through `offset` in workflow `text`: the last two-space key before it. */
function jobAt(text: string, offset: number): string | undefined {
  return [...text.slice(0, offset).matchAll(/^ {2}([\w-]+):[ \t]*$/gm)].at(-1)?.[1];
}

/**
 * The jobs of a workflow that call the shared checks without passing them
 * FIGMA_LIBRARY, by name: each job's own block is read, so one job missing it
 * is found though another passes it.
 */
export function jobsWithoutLibrary(text: string): string[] {
  const jobs = text.slice(Math.max(0, text.search(/^jobs:\s*$/m)));
  return [...jobs.matchAll(/^ {2}([\w-]+):\s*\n((?:(?: {3,}.*)?\n|(?: {3,}.*)$)*)/gm)].flatMap(([, name, body = '']) =>
    /checks\.yml@/.test(body) && !/secrets\.FIGMA_LIBRARY\b|^ {4}secrets:\s*inherit\s*$/m.test(body) ? [name as string] : [],
  );
}

/** One job's call of the shared checks at `version`, passing `secrets`. */
function callChecks(version: string, secrets: string[]): string[] {
  return [
    `    uses: ${PRODUCT}/.github/workflows/checks.yml@v${version}`,
    '    with:',
    `      ${REF_INPUT}: v${version}`,
    ...secrets,
  ];
}

/**
 * The client's workflow: the shared checks on every pull request, on pushes
 * to the default branch and weekly, at the niyam release `version`.
 * Pull request and push runs are read-only; the weekly job alone writes to
 * issues. Upgrading is changing that version, which each job names twice.
 * The Figma secrets are passed only when the figma feature is on, and the
 * board app's, by the pull request job alone, only when `board` is; the
 * weekly job runs on the settings' `schedule`.
 */
export function workflow(branch: string, version: string, figma: boolean, schedule = DEFAULT_SCHEDULE, settings: string = SETTINGS_PATH, board = false): string {
  const secrets = figma ? FIGMA_SECRETS : [];
  return [
    ...workflowHead(
      branch,
      version,
      [
        '# To upgrade, change the version on every line that names it (two per job).',
        SPLIT_COMMENT,
      ],
      schedule,
      TRIGGER_TYPES,
      true,
      settings,
    ),
    '  # Pull request and push runs: read-only.',
    `  ${CLI}:`,
    jobName(CLI),
    READ_ONLY_IF,
    ...callChecks(version, secretsOf(CLI, { figma, board })),
    '',
    '  # The weekly run alone writes to issues: it comments and opens undo issues.',
    `  ${CLI}-weekly:`,
    jobName(`${CLI}-weekly`),
    WEEKLY_IF,
    '    permissions:',
    '      contents: read',
    '      issues: write',
    '      pull-requests: read',
    ...callChecks(version, secrets),
    '',
    ...mergedJob(version, secrets),
    ...asksJob(version, secrets),
  ].join('\n');
}

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** A call of the shared workflow, and its version. */
const CHECKS_PIN = new RegExp(`(${escape(PRODUCT)}/\\.github/workflows/checks\\.yml@v)([^\\s'"#]+)`, 'g');
const REF_PIN = /^(\s+niyam-ref:\s*['"]?v)([^\s'"#]+)/gm;
const HEADER_PIN = /^(# Written by niyam onboard: the shared niyam checks at v)(\S+?)(\.?)$/m;

/** The versions a workflow pins: each `checks.yml@v…`, then each `niyam-ref: v…`. */
export function workflowPins(text: string): string[] {
  return [...text.matchAll(CHECKS_PIN), ...text.matchAll(REF_PIN)].map((match) => match[2] as string);
}

/** The one branch a workflow's `push:` trigger names, as `onboard` writes it, quoted or not. */
const PUSH_BRANCH = /^( {2}push:\n {4}branches: \[\s*)(['"]?)([^,'"\]\s]+)\2(\s*\])$/m;

/**
 * The one cron a workflow's `schedule:` trigger names, as `onboard` writes it,
 * quoted or not, with the comment `onboard` writes above it when it is there:
 * no other item follows it, past blank and comment lines, but the hourly needs-owner sweep's.
 */
const SCHEDULE = new RegExp(String.raw`^( {2}# The (?:weekly )?decisions job:[^\n]*\n)?( {2}schedule:\n {4}- cron: )(['"]?)([^'"#\n]+?)\3([ \t]*)$(?!(?:\n[ \t]*(?:#[^\n]*)?)*\n {4}- (?!cron: '${HOURLY.replaceAll('*', '\\*')}'[ \t]*$))`, 'm');

/**
 * `value` as a YAML flow scalar in the `quote` style the line already uses:
 * single quotes double themselves; double quotes, and a bare value YAML would
 * not read as that string (a number, a date, true or null), are written as
 * JSON, which YAML reads alike.
 */
function flowScalar(value: string, quote: string): string {
  if (quote === "'") return `'${value.replaceAll("'", "''")}'`;
  // Bare only when YAML reads it as a string: starting with a letter rules out numbers and dates.
  if (quote === '' && /^[A-Za-z][\w./-]*$/.test(value) && !/^(?:true|false|yes|no|on|off|y|n|null)$/i.test(value)) return value;
  return JSON.stringify(value);
}

/** What `workflowUpdate` does with a workflow. */
export type WorkflowUpdate =
  | { kind: 'same' }
  | { kind: 'write' | 'replace'; text: string; from?: string }
  | { kind: 'repin'; text: string; from?: string; branch?: string; schedule?: string; secrets?: true; board?: true; merged?: true; asks?: true; authors?: true; types?: true };

/**
 * What onboard does with the client's workflow: write it, or, in a workflow
 * already split into a read-only `niyam` job and a `niyam-weekly` job, move
 * the version pins, the one branch pushes run on when the default branch has
 * changed, the one cron the weekly job runs on when the settings' schedule
 * has changed, and each job's Figma secrets to what the figma feature needs
 * and the pull request job's board app secrets to what `board` needs,
 * leaving the rest as the client has it; any other workflow is replaced.
 */
export function workflowUpdate(
  before: string | undefined,
  branch: string,
  version: string,
  figma: boolean,
  schedule = DEFAULT_SCHEDULE,
  settings: string = SETTINGS_PATH,
  board = false,
): WorkflowUpdate {
  if (before === undefined) return { kind: 'write', text: workflow(branch, version, figma, schedule, settings, board) };
  return repinned(before, branch, version, figma, schedule, settings, board);
}

/** The secrets of onboard's own a block of a job names, by what they are for. */
function ownSecrets(block: string): { figma: string; board: string } {
  const names = [...block.matchAll(/^ {6}([\w-]+):/gm)].map((match) => match[1] as string);
  return { figma: names.filter((name) => name.startsWith('FIGMA_')).join(','), board: names.filter((name) => name.startsWith('NIYAM_BOARD_')).join(',') };
}

/** workflowUpdate on a workflow that is there. */
function repinned(before: string, branch: string, version: string, figma: boolean, schedule: string, settings: string, board: boolean): WorkflowUpdate {
  const wanted = workflow(branch, version, figma, schedule, settings, board);
  if (before === wanted) return { kind: 'same' };
  const pins = workflowPins(before);
  const from = pins[0];
  const pushed = PUSH_BRANCH.exec(before)?.[3];
  const job = (id: string): boolean => new RegExp(String.raw`^ {2}${id}:\s*$`, 'm').test(before);
  const split = job(CLI) && job(`${CLI}-weekly`);
  const merged = job(`${CLI}-merged`);
  const added = split && !merged && pins.length === 4 && from !== undefined ? addMergedJob(before, from, figma) : undefined;
  if (added !== undefined) {
    const update = repinned(added, branch, version, figma, schedule, settings, board);
    return { ...(update.kind === 'repin' ? update : { text: added }), kind: 'repin', merged: true };
  }
  const asks = job(`${CLI}-asks`);
  const withAsks = split && merged && !asks && pins.length === 6 && from !== undefined ? addAsksJob(before, from, figma) : undefined;
  if (withAsks !== undefined) {
    const update = repinned(withAsks, branch, version, figma, schedule, settings, board);
    // The asks job it adds also types each new issue, so the plan says so.
    return { ...(update.kind === 'repin' ? update : { text: withAsks }), kind: 'repin', asks: true, types: true };
  }
  if (split && merged && asks && pins.length === 8) {
    const moved = pushed !== undefined && pushed !== branch;
    const cron = SCHEDULE.exec(before)?.[4]?.trim();
    const rescheduled = cron !== undefined && cron.split(/\s+/).join(' ') !== schedule;
    const authors = before.includes(OLDER_ASKS_COMMENT_IF.join('\n'));
    // Before 0.6.4 the asks job ran on the approved label alone; both its trigger and its condition gain opened and reopened.
    const olderTrigger = `\n${OLDER_ISSUE_TRIGGER.join('\n')}\n`;
    const olderLabelIf = `\n${ASKS_LABEL_IF}\n`;
    const types = before.split(olderTrigger).length === 2 && before.split(olderLabelIf).length === 2 && !before.includes(ASKS_TYPE_IF);
    const typed = types
      ? before
          .replace(olderTrigger, `\n${ISSUE_TRIGGER.join('\n')}\n`)
          .replace(olderLabelIf, `\n${ASKS_LABEL_IF}\n${ASKS_TYPE_IF}\n`)
          .replace(`${ASKS_COMMENT}\n  ${CLI}-asks:`, `${ASKS_COMMENT}\n${ASKS_TYPE_COMMENT}\n  ${CLI}-asks:`)
      : before;
    const pinned = typed
      .replace(OLDER_ASKS_COMMENT_IF.join('\n'), ASKS_COMMENT_IF.join('\n'))
      .replace(CHECKS_PIN, () => `${PRODUCT}/.github/workflows/checks.yml@v${version}`)
      .replace(REF_PIN, (_, head: string) => `${head}${version}`)
      .replace(HEADER_PIN, (_, _head: string, _old: string, dot: string) => `# Written by ${CLI} onboard: the shared ${CLI} checks at v${version}${dot}`)
      .replace(PUSH_BRANCH, (line: string, head: string, quote: string, _old: string, tail: string) =>
        moved ? `${head}${flowScalar(branch, quote)}${tail}` : line,
      )
      .replace(SCHEDULE, (line: string, comment: string | undefined, head: string, quote: string, _old: string, tail: string) =>
        rescheduled ? `${comment === undefined ? '' : `${scheduleComment(schedule, settings)}\n`}${head}${quote || "'"}${schedule}${quote || "'"}${tail}` : line,
      );
    // Each job's block as that job passes it; which part changed, Figma's or the board app's, is said apart.
    const changed = { figma: false, board: false };
    const text = pinned.replace(SECRETS_AFTER_REF, (block: string, ref: string, offset: number, whole: string) => {
      const lines = secretsOf(jobAt(whole, offset) ?? '', { figma, board });
      const now = `${ref}${lines.map((line) => `${line}\n`).join('')}`;
      const had = ownSecrets(block);
      const has = ownSecrets(now);
      changed.figma ||= had.figma !== has.figma;
      changed.board ||= had.board !== has.board;
      return now;
    });
    if (text === before) return { kind: 'same' };
    const stale = pins.find((pin) => pin !== version);
    return {
      kind: 'repin',
      text,
      ...(stale ? { from: stale } : {}),
      ...(moved ? { branch } : {}),
      ...(rescheduled ? { schedule } : {}),
      ...(changed.figma ? { secrets: true as const } : {}),
      ...(changed.board ? { board: true as const } : {}),
      ...(authors ? { authors: true as const } : {}),
      ...(types ? { types: true as const } : {}),
    };
  }
  return { kind: 'replace', text: wanted };
}

/** A niyam release a repository pins, and where. */
interface Pin {
  version: string;
  where: string;
}

/** The newest of `pins` that is newer than `version`, if any. */
function newest(pins: Pin[], version: string): Pin | undefined {
  return pins.filter((pin) => isNewer(pin.version, version)).reduce<Pin | undefined>((best, pin) => (best === undefined || isNewer(pin.version, best.version) ? pin : best), undefined);
}

/**
 * A release newer than `version` that the checkout pins already, in its
 * workflow, the shared Guard's caller or its cloud setup file. An older CLI
 * onboarding over it would move the pins back and drop what the newer
 * release added.
 */
function newerPinHere(fileAt: (path: string) => string | undefined, version: string): Pin | undefined {
  return newest(
    [
      ...workflowPins(fileAt(WORKFLOW_PATH) ?? '').map((pin) => ({ version: pin, where: `${WORKFLOW_PATH} in this checkout` })),
      ...callerPins(fileAt(GUARD_CALLER_PATH) ?? '').map((pin) => ({ version: pin, where: `${GUARD_CALLER_PATH} in this checkout` })),
      ...[cloudScriptVersion(fileAt(CLOUD_SETUP_PATH) ?? '')].filter((pin) => pin !== undefined).map((pin) => ({ version: pin, where: `${CLOUD_SETUP_PATH} in this checkout` })),
    ],
    version,
  );
}

/**
 * A release newer than `version` that the repository pins on GitHub: on the
 * default branch, which a checkout may be behind, or on onboard's branch
 * when its pull request is open, which a newer release may have pushed and
 * this run would push over. A problem when GitHub does not say, so a run
 * never moves a pin back for want of an answer.
 */
async function newerPinOnGitHub(sys: Sys, slug: string, token: string, branch: string | undefined, version: string): Promise<Pin | { problem: string } | undefined> {
  const refs = branch === undefined ? [] : [branch];
  const pulls = await sys.http(`${API}/repos/${slug}/pulls?state=open&head=${slug.split('/')[0]}:${ONBOARD_BRANCH}`, { token }).catch(() => ({ status: 0, json: undefined }));
  if (pulls.status !== 200 || !Array.isArray(pulls.json)) return { problem: `GitHub did not say whether an onboard pull request is open (${pulls.status === 0 ? 'no answer' : `HTTP ${pulls.status}`})` };
  if (pulls.json.length > 0) refs.push(ONBOARD_BRANCH);
  const pins: Pin[] = [];
  for (const ref of refs) {
    const read = await remoteFile(sys, slug, WORKFLOW_PATH, ref, token);
    if ('problem' in read) return read;
    pins.push(...workflowPins(read.text ?? '').map((pin) => ({ version: pin, where: `${WORKFLOW_PATH} on ${ref}` })));
    const caller = await remoteFile(sys, slug, GUARD_CALLER_PATH, ref, token);
    if ('problem' in caller) return caller;
    pins.push(...callerPins(caller.text ?? '').map((pin) => ({ version: pin, where: `${GUARD_CALLER_PATH} on ${ref}` })));
  }
  return newest(pins, version);
}

/** onboard's refusal of a repository that pins a newer release than this one. */
function refuseOlder(io: Output, slug: string, pin: Pin, version: string): number {
  io.err(`onboard: ${slug} already pins niyam v${pin.version} (${pin.where}), and this is v${version}; onboard never moves the pin back`);
  io.err(`  Update this Mac's niyam first: ${UPGRADE}`);
  return 1;
}

/** What GitHub says about the agent's access to a repository. */
type Access =
  /** `public` when GitHub says the repository is public, as the shared Guard's caller needs a policy there. */
  | { kind: 'push'; branch: string; public?: true }
  | { kind: 'read'; branch?: string }
  | { kind: 'none' }
  | { kind: 'refused'; reason: string };

async function access(sys: Sys, slug: string, token: string): Promise<Access> {
  const { status, json, headers = {} } = await sys.http(`${API}/repos/${slug}`, { token });
  const repo = json as { default_branch?: unknown; permissions?: { push?: unknown }; private?: unknown; visibility?: unknown; message?: unknown } | null;
  if (status === 200) {
    // Public only when GitHub says so: a repository it does not say of asks for no policy.
    const open = repo?.private === false || repo?.visibility === 'public';
    return repo?.permissions?.push === true && typeof repo.default_branch === 'string'
      ? { kind: 'push', branch: repo.default_branch, ...(open ? { public: true as const } : {}) }
      : { kind: 'read', ...(typeof repo?.default_branch === 'string' ? { branch: repo.default_branch } : {}) };
  }
  if (status === 404) return { kind: 'none' };
  const sso = /url=(\S+)/.exec(headers['x-github-sso'] ?? '')?.[1];
  if (sso) {
    return { kind: 'refused', reason: `the organisation requires SAML single sign-on; authorise the token for it at ${sso}` };
  }
  const message = typeof repo?.message === 'string' ? repo.message : '';
  if (/personal access tokens? \(classic\)/i.test(message)) {
    return {
      kind: 'refused',
      reason: `the organisation does not allow classic tokens ("${message}"); an organisation owner can allow them under Settings → Personal access tokens`,
    };
  }
  return { kind: 'refused', reason: `GitHub refused (HTTP ${status}${message ? `: ${message}` : ''})` };
}

/** The agent's pending invitation to `slug`, if any, looking through every page GitHub lists. */
async function invitation(sys: Sys, slug: string, token: string): Promise<number | undefined> {
  for (let page = 1; ; page++) {
    const { status, json } = await sys.http(`${API}/user/repository_invitations?per_page=100&page=${page}`, { token });
    if (status !== 200 || !Array.isArray(json)) return undefined;
    const found = json.find((entry: unknown) => {
      const name = (entry as { repository?: { full_name?: unknown } } | null)?.repository?.full_name;
      return typeof name === 'string' && sameLogin(name, slug);
    }) as { id?: unknown } | undefined;
    if (typeof found?.id === 'number') return found.id;
    if (json.length < 100) return undefined;
  }
}

/** The command entries under one hook event, as written in the settings object. */
function hooksOf(settings: object, event: string): { command?: unknown }[] {
  const groups = (settings as { hooks?: Record<string, unknown> }).hooks?.[event];
  if (!Array.isArray(groups)) return [];
  return groups.flatMap((group: unknown) => {
    const hooks = (group as { hooks?: unknown } | null)?.hooks;
    return Array.isArray(hooks) ? hooks.filter((hook): hook is { command?: unknown } => typeof hook === 'object' && hook !== null) : [];
  });
}

/** A sarathi handler, as `.claude/sarathi.json` lists it under an event. */
interface Handler {
  matcher?: string;
  command: string;
  timeout?: number;
  failClosed?: boolean;
}

/** How long sarathi gives a handler with no `timeout` of its own, in seconds. */
const SARATHI_DEFAULT_TIMEOUT = 60;

/**
 * niyam's hooks as sarathi handlers (P-66). session-start's installs, the
 * drift install and a cloud session's, need the 600 s Claude Code gives a
 * hook in the settings, not sarathi's 60 s. The guard only reads local state,
 * so sarathi's default does; it fails closed, as its own exits already do.
 */
export const SARATHI_HANDLERS: Readonly<Record<'SessionStart' | 'PreToolUse', Handler>> = {
  SessionStart: { command: HOOK_COMMAND, timeout: 600 },
  PreToolUse: { matcher: 'Bash', command: GUARD_COMMAND, failClosed: true },
};

/** A matcher's plain form, as Claude Code and sarathi read it: names, or `A|B`. Anything else is a regular expression. */
const PLAIN_MATCHER = /^[\w|-]+$/;

/** Whether a hook with `matcher` fires for `target`, by Claude Code's rules: absent, empty and `*` match all. */
function matcherTakes(matcher: string | undefined, target: string): boolean {
  if (matcher === undefined || matcher === '' || matcher === '*') return true;
  if (PLAIN_MATCHER.test(matcher)) return matcher.split('|').includes(target);
  try {
    return new RegExp(matcher).test(target);
  } catch {
    return false;
  }
}

/** Whether a settings entry with `runner`'s matcher lets a handler with `handler`'s fire whenever it would. */
function matcherCovers(runner: string | undefined, handler: string | undefined): boolean {
  if (runner === undefined || runner === '' || runner === '*') return true;
  if (handler === undefined || handler === '' || handler === '*' || !PLAIN_MATCHER.test(handler)) return false;
  return handler.split('|').every((name) => matcherTakes(runner, name));
}

/**
 * Whether a settings command runs sarathi for `event`, as `sarathi check`
 * reads it: it names sarathi, the program or a launcher named after it,
 * and passes the event as a word of its own (`sarathi hook PreToolUse`,
 * `"$CLAUDE_PROJECT_DIR"/.claude/hooks/sarathi.sh PreToolUse`).
 */
export function runsSarathiFor(command: string, event: string): boolean {
  return /\bsarathi\b/.test(command) && new RegExp(`(?:^|[\\s"'])${event}(?:$|[\\s"'])`).test(command);
}

/** The settings entry that runs sarathi for `event`, where it stands, with its matcher and timeout. */
interface Runner {
  group: number;
  hook: number;
  matcher?: string;
  timeout?: number;
}

/** The first settings entry that runs sarathi for `event`, or undefined. */
export function sarathiRunner(settings: unknown, event: string): Runner | undefined {
  const groups = (settings as { hooks?: Record<string, unknown> } | null)?.hooks?.[event];
  if (!Array.isArray(groups)) return undefined;
  for (const [group, entry] of groups.entries()) {
    const { matcher, hooks } = (entry ?? {}) as { matcher?: unknown; hooks?: unknown };
    for (const [hook, item] of (Array.isArray(hooks) ? hooks : []).entries()) {
      const { command, timeout } = (item ?? {}) as { command?: unknown; timeout?: unknown };
      if (typeof command !== 'string' || !runsSarathiFor(command, event)) continue;
      return { group, hook, ...(typeof matcher === 'string' ? { matcher } : {}), ...(typeof timeout === 'number' ? { timeout } : {}) };
    }
  }
  return undefined;
}

/** The handlers `.claude/sarathi.json` lists under `event`. */
function handlersOf(sarathi: object, event: string): { command?: unknown; timeout?: unknown }[] {
  const list = (sarathi as { hooks?: Record<string, unknown> }).hooks?.[event];
  return Array.isArray(list) ? list.filter((entry): entry is { command?: unknown; timeout?: unknown } => typeof entry === 'object' && entry !== null) : [];
}

/** The edits onboard makes to `.claude/sarathi.json`, said as for settings.json. */
export interface SarathiEdit {
  text: string;
  changes: string[];
  labels: string[];
}

/**
 * The client's Claude Code settings with this release's hooks and lock: each
 * entry an older release wrote swapped where it stands, a missing one added,
 * the lock's variables set in `env`, and REVIEW_THREAD_RULE, AUTO_FIX_RULES and ARTIFACT_RULES allowed. Every edit is made in the text, so
 * the rest of the file keeps its layout. Says what changed, for the question.
 * A rule the file's `permissions.deny` overrides is not allowed, since the
 * allow would do nothing; `denied` says which, for the plan, only when any is.
 *
 * Where the project keeps `.claude/sarathi.json` (`sarathiBefore`) and the
 * settings run sarathi for an event, with a matcher that lets niyam's hook
 * fire, that hook goes into sarathi.json as a handler instead (P-66): an
 * older one swapped in place, a missing one added, and niyam's hooks taken
 * out of the settings, so sarathi's is the event's one entry there. sarathi's
 * own entry gets at least the handler's timeout, as `sarathi check` asks.
 * `sarathi` is said only when that file changes.
 */
export function claudeSettings(
  before: string | undefined,
  sarathiBefore?: string,
): { text: string; changes: string[]; labels: string[]; denied?: string[]; sarathi?: SarathiEdit } {
  let text = before ?? '{}\n';
  const changes: string[] = [];
  // The same, in a word or two each, for the plan.
  let hooksChanged: 'added' | 'updated' | undefined;
  let moved = false;
  let timed = false;
  const labels: string[] = [];
  const denied: string[] = [];
  const parsed = (): object => JSON.parse(text) as object;
  const first: unknown = parsed();
  if (typeof first !== 'object' || first === null || Array.isArray(first)) throw new Error(`${HOOKS_PATH} is not a JSON object`);
  let sarathi: SarathiEdit | undefined;
  if (sarathiBefore !== undefined) {
    let list: unknown;
    try {
      list = JSON.parse(sarathiBefore);
    } catch (error) {
      throw new Error(`${SARATHI_PATH} is not JSON (${(error as Error).message})`);
    }
    if (typeof list !== 'object' || list === null || Array.isArray(list)) throw new Error(`${SARATHI_PATH} is not a JSON object`);
    sarathi = { text: sarathiBefore, changes: [], labels: [] };
  }
  let handlersChanged: 'added' | 'updated' | undefined;
  let handlersTimed = false;
  const hooks: ['SessionStart' | 'PreToolUse', string, readonly string[], string, Record<string, unknown>][] = [
    ['SessionStart', HOOK_COMMAND, OLDER_HOOK_COMMANDS, 'the SessionStart hook that runs niyam session-start', {}],
    ['PreToolUse', GUARD_COMMAND, OLDER_GUARD_COMMANDS, "the PreToolUse hook that refuses gh and git's remote commands outside the agent identity", { matcher: 'Bash' }],
  ];
  for (const [event, command, older, name, extra] of hooks) {
    const handler = SARATHI_HANDLERS[event];
    const runner = sarathi === undefined ? undefined : sarathiRunner(first, event);
    if (sarathi !== undefined && runner !== undefined && matcherCovers(runner.matcher, handler.matcher)) {
      const edit = sarathi;
      try {
        const swapped = replaceValues(edit.text, ['hooks', event, '*', 'command'], (value) => (typeof value === 'string' && older.includes(value) ? command : undefined));
        if (swapped.replaced > 0) {
          edit.text = swapped.text;
          edit.changes.push(`replace the older ${name.replace(/^the /, '')} with this release's`);
          handlersChanged = 'updated';
        } else if (!handlersOf(JSON.parse(edit.text) as object, event).some((entry) => entry.command === command)) {
          edit.text = appendToArray(edit.text, ['hooks'], event, handler);
          edit.changes.push(`add ${name}, as a handler sarathi runs`);
          handlersChanged ??= 'added';
        }
        // A handler moved there by hand may have sarathi's 60 s, too short for session-start's installs.
        const wanted = handler.timeout;
        for (const [at, entry] of handlersOf(JSON.parse(edit.text) as object, event).entries()) {
          if (wanted === undefined || entry.command !== command || (typeof entry.timeout === 'number' && entry.timeout >= wanted)) continue;
          edit.text = setMember(edit.text, ['hooks', event, String(at)], 'timeout', wanted);
          edit.changes.push(`give ${name} ${wanted} s, as long as Claude Code gives it in the settings`);
          handlersTimed = true;
        }
      } catch (error) {
        throw new Error(`${SARATHI_PATH}: ${(error as Error).message}`);
      }
      try {
        const own = (value: unknown): boolean => {
          const found = (value as { command?: unknown } | null)?.command;
          return typeof found === 'string' && (found === command || older.includes(found));
        };
        // A group of niyam's hooks alone goes whole; niyam's hook in a group beside others goes alone.
        const groups = removeElements(text, ['hooks', event], (group) => {
          const inner = (group as { hooks?: unknown } | null)?.hooks;
          return Array.isArray(inner) && inner.length > 0 && inner.every(own);
        });
        const single = removeElements(groups.text, ['hooks', event, '*', 'hooks'], own);
        if (groups.removed + single.removed > 0) {
          text = single.text;
          changes.push(`take out ${name}, which ${SARATHI_PATH} now runs under sarathi`);
          moved = true;
        }
        // Found again: taking niyam's groups out moves sarathi's.
        const now = sarathiRunner(parsed(), event) as Runner;
        const needed = handler.timeout ?? SARATHI_DEFAULT_TIMEOUT;
        if (now.timeout === undefined || now.timeout < needed) {
          text = setMember(text, ['hooks', event, String(now.group), 'hooks', String(now.hook)], 'timeout', needed);
          changes.push(`give sarathi's ${event} hook ${needed} s, so niyam's handler under it has its time`);
          timed = true;
        }
      } catch (error) {
        throw new Error(`${HOOKS_PATH}: ${(error as Error).message}`);
      }
      continue;
    }
    try {
      const swapped = replaceValues(text, ['hooks', event, '*', 'hooks', '*', 'command'], (value) =>
        typeof value === 'string' && older.includes(value) ? command : undefined,
      );
      if (swapped.replaced > 0) {
        text = swapped.text;
        changes.push(`replace the older ${name.replace(/^the /, '')} with this release's`);
        hooksChanged = 'updated';
      } else if (!hooksOf(parsed(), event).some((hook) => hook.command === command)) {
        text = appendToArray(text, ['hooks'], event, { ...extra, hooks: [{ type: 'command', command }] });
        changes.push(`add ${name}`);
        hooksChanged ??= 'added';
      }
    } catch (error) {
      throw new Error(`${HOOKS_PATH}: ${(error as Error).message}`);
    }
  }
  try {
    const env = (parsed() as { env?: unknown }).env;
    const current = typeof env === 'object' && env !== null ? (env as Record<string, unknown>) : {};
    const missing = Object.entries(BASE_ENV).filter(([name, value]) => current[name] !== value);
    for (const [name, value] of missing) text = setMember(text, ['env'], name, value);
    // A variable an older release set, such as its placeholder token or SSH refusal, is updated; one not there is set.
    const updated = missing.filter(([name]) => typeof current[name] === 'string').map(([name]) => name);
    const added = missing.filter(([name]) => typeof current[name] !== 'string').map(([name]) => name);
    const named = (names: string[]): string => (names.length <= 3 ? names.join(', ') : `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`);
    if (hooksChanged) labels.push(`hooks ${hooksChanged}`);
    if (moved) labels.push('hooks moved to sarathi.json');
    if (timed) labels.push('sarathi timeout');
    if (added.length > 0) changes.push(`set ${named(added)} in env, so GitHub is locked out until session-start gives the agent identity`);
    if (updated.length > 0) changes.push(`update ${named(updated)} in env to this release's lock`);
    if (missing.length > 0) labels.push(added.length > 0 ? 'lock' : 'lock updated');
    // The rule under the old command becomes niyam's, in its place, unless niyam's is there already.
    const allow = (parsed() as { permissions?: { allow?: unknown } }).permissions?.allow;
    const has = Array.isArray(allow) && allow.includes(REVIEW_THREAD_RULE);
    const renamed = has ? { text, replaced: 0 } : replaceValues(text, ['permissions', 'allow', '*'], (value) => (value === OLDER_REVIEW_THREAD_RULE ? REVIEW_THREAD_RULE : undefined));
    const review = !has && renamed.replaced === 0;
    if (renamed.replaced > 0) {
      text = renamed.text;
      changes.push(`replace ${OLDER_REVIEW_THREAD_RULE} with ${REVIEW_THREAD_RULE}, the CLI's own name`);
    } else if (review) {
      text = appendToArray(text, ['permissions'], 'allow', REVIEW_THREAD_RULE);
      changes.push('allow niyam review-thread without a prompt, so agent sessions answer review threads on their own pull requests');
    }
    const autoFix = autoFixRuleNeeds(parsed());
    const lacking = autoFix.missing;
    for (const rule of lacking) text = appendToArray(text, ['permissions'], 'allow', rule);
    if (lacking.length > 0) {
      changes.push(`allow ${lacking.join(', ')} without a prompt, so agent sessions turn Auto-fix on for their own pull requests`);
    }
    const artifacts = artifactRuleNeeds(parsed());
    const unpublished = artifacts.missing;
    for (const rule of unpublished) text = appendToArray(text, ['permissions'], 'allow', rule);
    if (unpublished.length > 0) {
      changes.push(`allow ${unpublished.join(', ')} without a prompt, so agent sessions publish the page an ask to the owner links`);
    }
    // A rule the file denies is the owner's choice: an allow rule for it would do nothing, so the plan says so instead.
    denied.push(...deniedLines(autoFix, AUTO_FIX_RULES, 'Auto-fix rules'), ...deniedLines(artifacts, ARTIFACT_RULES, 'artifact rules'));
    // One group's own word, or one word for several, so the plan's line stays short.
    const groups = [review || renamed.replaced > 0 ? 'review rule' : '', lacking.length > 0 ? 'Auto-fix rules' : '', unpublished.length > 0 ? 'artifact rules' : ''].filter(Boolean);
    if (groups.length > 0) labels.push(groups.length === 1 ? groups[0]! : 'allow rules');
  } catch (error) {
    throw new Error(`${HOOKS_PATH}: ${(error as Error).message}`);
  }
  const said = denied.length > 0 ? { denied } : {};
  if (sarathi !== undefined && sarathi.changes.length > 0) {
    if (handlersChanged) sarathi.labels.push(`hooks ${handlersChanged}`);
    if (handlersTimed) sarathi.labels.push('timeout');
    return { text, changes, labels, ...said, sarathi };
  }
  return { text, changes, labels, ...said };
}

/** Who the run's sign-in is, the owner's likely login; undefined when it failed. */
async function signedInLogin(signIn: () => Promise<OwnerToken | { problem: string }>): Promise<string | undefined> {
  const signed = await signIn().catch(() => undefined);
  return signed && 'login' in signed ? signed.login : undefined;
}

/**
 * Asks for an account, offering what this Mac suggests: Enter takes the
 * first suggestion. Undefined when there is none and nothing is typed.
 */
async function choose(sys: Sys, io: Output, role: string, suggestions: (string | undefined)[]): Promise<string | undefined> {
  const offered = suggestions.filter((login): login is string => !!login);
  if (offered.length > 1) io.out(`Accounts set up here for the ${role.split(',')[0]}: ${offered.join(', ')}`);
  const typed = (await sys.ask(`The ${role}${offered[0] ? ` [${offered[0]}]` : ''}: `)).trim();
  return typed || offered[0];
}

/** onboard's arguments: up to two logins, then `--features a,b` (first time) or `--add <feature>`, `--yes` and `--dry-run`. */
export function onboardArgs(args: readonly string[]): { named: string[]; features?: Feature[]; add?: Feature; yes?: true; dryRun?: true } {
  const named: string[] = [];
  let features: Feature[] | undefined;
  let add: Feature | undefined;
  let yes = false;
  let dryRun = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    const value = args[i + 1];
    if (arg === '--yes') yes = true;
    else if (arg === '--dry-run') dryRun = true;
    else if (arg === '--features' || arg === '--add') {
      if (value === undefined) throw new Error(`${arg} needs a value`);
      if (arg === '--features') features = parseFeatures(value);
      else {
        const [, feature] = parseFeatures(value);
        if (!feature || value.includes(',')) throw new Error('--add takes one feature other than identity');
        add = feature;
      }
      i++;
    } else if (arg.startsWith('--')) {
      throw new Error(`unknown option ${arg}`);
    } else if (named.length < 2) {
      named.push(arg);
    } else {
      throw new Error(`unexpected argument "${arg}"`);
    }
  }
  return { named, ...(features ? { features } : {}), ...(add ? { add } : {}), ...(yes ? { yes: true as const } : {}), ...(dryRun ? { dryRun: true as const } : {}) };
}

/** A step the run takes after the yes, in order; `owner` when it acts as the owner, so the sign-in comes before its spinner. */
interface Step {
  label: string;
  owner?: true;
  run(io: Output, ownerToken: string | undefined): Promise<boolean>;
}

/** What a workflow update changes, in a few words for the plan. */
function workflowDetail(update: Exclude<WorkflowUpdate, { kind: 'same' }>, version: string, { figma, board }: Passed): string {
  if (update.kind !== 'repin') return { write: 'new', replace: 'replaced' }[update.kind];
  return (
    [
      ...(update.from ? [`pins → v${version}`] : []),
      ...(update.branch ? [`branch → ${update.branch}`] : []),
      ...(update.schedule ? [`schedule → ${update.schedule}`] : []),
      ...(update.secrets ? [figma ? 'Figma secrets' : 'no Figma secrets'] : []),
      ...(update.board ? [board ? 'board app secrets' : 'no board app secrets'] : []),
      ...(update.merged ? ['merged job'] : []),
      ...(update.asks ? ['needs-owner job'] : []),
      ...(update.authors ? ['needs-owner job only for owners, members and collaborators'] : []),
      ...(update.types ? ['issue types for new issues'] : []),
    ].join(', ') || `header → v${version}`
  );
}

/** What a workflow update changes, in full for the pull request's description. */
function workflowWhat(update: Exclude<WorkflowUpdate, { kind: 'same' }>, version: string, { figma, board }: Passed, schedulePath: string, file: string = WORKFLOW_PATH): string {
  if (update.kind !== 'repin') {
    return {
      write: `write ${WORKFLOW_PATH}, which runs the shared niyam checks`,
      replace: `replace ${file}, which runs the shared niyam checks`,
    }[update.kind];
  }
  const parts = [
    ...(update.from ? [`move the version pins from v${update.from} to v${version}`] : []),
    ...(update.branch ? [`run pushes on the default branch, ${update.branch}`] : []),
    ...(update.schedule ? [`run the weekly decisions job on the schedule ${schedulePath} sets, cron ${update.schedule} UTC`] : []),
    ...(update.secrets ? [figma ? 'pass the FIGMA_TOKEN and FIGMA_LIBRARY secrets' : 'stop passing Figma secrets, with figma off'] : []),
    ...(update.board
      ? [board ? `pass the pull request job's checks the board app's ${BOARD_SECRETS.join(' and ')} secrets, which move a slice to In Progress when its pull request opens` : 'stop passing the board app secrets, with board off']
      : []),
    ...(update.merged ? ['add a job that closes the slice a merged pull request names, the one pull request run that writes to issues'] : []),
    ...(update.asks ? ["add a job that labels an issue needs-owner where the agent asks the owner, and takes it off at the owner's approved label, Decision: comment or (hourly) 👍"] : []),
    ...(update.authors ? ['start the needs-owner job only on a comment by the owner, a member or a collaborator'] : []),
    ...(update.types ? ["start the needs-owner job when an issue is opened or reopened too, which gives one with no type the work model's"] : []),
  ];
  return `in ${file}, ${parts.join(' and ') || `set the version in its header comment to v${version}`}, leaving the rest as it is`;
}

/** The plan's head: the release onboard moves the repository to, then who is who, and any warnings. */
function planHead(paint: Paint, head: { from?: string | undefined; version: string; slug: string; owner: string; agent: string; warnings: string[] }): string[] {
  const bar = paint.dim('│');
  return [
    heading(paint, 'onboard', `${head.from && head.from !== head.version ? `v${head.from} → ` : ''}v${head.version}`),
    `${bar}  ${head.slug} · owner ${head.owner} · agent ${head.agent}`,
    ...head.warnings.map((warning) => `${bar}  ! ${warning}`),
  ];
}

/**
 * Sets up the client repository the working directory is in, run by its
 * owner on a Mac `machine` has set up for the agent. It first works out
 * everything it would change, changing nothing: the settings file, the
 * Claude Code settings, the workflow, the shared Guard's caller (with work
 * rules on) and the cloud setup file, opened as the agent's pull request
 * so the owner's checkout is never modified; the agent's push access; the
 * work board (issue types, labels, Project, fields and views); the pre-push
 * hook; and one signed test commit GitHub must show as Verified by the
 * agent. It prints that as one plan and asks once (`--yes` skips the
 * question, `--dry-run` stops at the plan); a no changes nothing. After the
 * yes, one browser sign-in as the owner serves every step that acts as the
 * owner, and each step shows as one line. Last, once the pull request is
 * open, it makes the agent's cloud signing key when the agent has none
 * (#417), a failure there only warning.
 */
export async function onboard(sys: Sys, io: Output, args: readonly string[] = []): Promise<number> {
  const { named, features: chosen, add, yes, dryRun } = onboardArgs(args);
  if (agentIn(sys.env)) {
    io.err('onboard: run it in your own terminal, not in an agent session');
    return 1;
  }
  if (!sys.tty && !yes && !dryRun) {
    io.err('onboard: no terminal to ask in; pass --yes to go ahead without asking, or --dry-run to see the plan');
    return 1;
  }
  const { root, slug } = repoAt(sys);
  const paint = painter(sys);
  const bar = paint.dim('│');
  const say = (line: string): void => io.out(`${bar}  ${line}`);
  const version = packageVersion();
  // Whether an organisation owns the repository, asked of GitHub once in this run.
  let organisation: Promise<boolean> | undefined;
  const byOrganisation = (): Promise<boolean> => (organisation ??= isOrganisation(sys, slug.split('/')[0] as string));
  const personal = `${slug} is owned by a personal account, and GitHub has issue types for organisations only`;
  // The repository's files are changed only through the agent's pull request at the end: until then each
  // change is held here, and read back from here, so the owner's checkout is never modified.
  const changes = new Map<string, Change>();
  const fileAt = (path: string): string | undefined => {
    const held = changes.get(path);
    if (held !== undefined) return held.text;
    return sys.exists(`${root}/${path}`) ? sys.read(`${root}/${path}`) : undefined;
  };
  const change = (path: string, text: string, what: string): void => {
    const held = changes.get(path);
    const before = held ? held.before : fileAt(path);
    changes.set(path, { path, before, text, what: held ? `${held.what}; ${what}` : what });
  };
  // A file under its name before P-56, deleted where the pull request leaves the new one (MOVED_FILES).
  const remove = (path: string, what: string): void => {
    if (fileAt(path) === undefined) return;
    const held = changes.get(path);
    changes.set(path, { path, before: held ? held.before : fileAt(path), text: undefined, what });
  };
  // The plan's one line for the settings file, each change a part of it.
  const settingsLabel = SETTINGS_PATH.slice('.github/'.length);
  const settingsItem = (detail: string): void => {
    const item = pull.find((one) => one.label === settingsLabel);
    if (item) item.detail = `${item.detail}, ${detail}`;
    else pull.push({ label: settingsLabel, detail });
  };
  // Before anything is asked or planned: a checkout a newer release onboarded is never moved back.
  const aheadHere = newerPinHere(fileAt, version);
  if (aheadHere !== undefined) return refuseOlder(io, slug, aheadHere, version);
  // The workflow and cloud-setup.sh pin this release: a tag off main is not one (P-61).
  const onMain = await tagOnMain(sys, version);
  if ('problem' in onMain) {
    io.err(`onboard: ${onMain.problem}; nothing changed`);
    return 1;
  }
  // The plan, by group, and the steps that carry it out after the yes.
  const pull: Item[] = [];
  const github: Item[] = [];
  const mac: Item[] = [];
  const cloud: Item[] = [];
  const steps: Step[] = [];
  const warnings: string[] = [];
  const byHand: string[] = [];
  // For the pull request's description: what was done outside it, and why, and in full what is left to do by hand.
  const notes: string[] = [];
  const later: string[] = [];
  // The owner's sign-in for this run: one browser approval at the first step that needs it, never stored.
  let scopes: string[] = [];
  let signedIn: Promise<OwnerToken | { problem: string }> | undefined;
  // `as` is who may sign in: the owner, the settings' owners while the run has not chosen one, or none yet known.
  const signIn = (as: readonly string[] = []): Promise<OwnerToken | { problem: string }> =>
    (signedIn ??= (async () => {
      // The features the run ends with: the sign-in can come before --add's feature is turned on.
      scopes = ownerScopes(add ? [...features, add] : features, await byOrganisation());
      // Which access the approval grants: gh's own repo scope, and what the run's features add.
      io.out(`${paint.done('◇')}  Sign in to GitHub as ${as.length === 0 ? 'the owner' : either(as)}, for this run only: ${['repo', ...scopes].join(', ')}`);
      const signed = await signInOnce(sys, scopes, say);
      if ('login' in signed) io.out(`${paint.done('◇')}  Signed in as ${signed.login}`);
      return signed;
    })());
  const ownerToken = async (): Promise<string | undefined> => {
    const token = asOwner(await signIn([owner]), owner, scopes);
    if (typeof token === 'string') return token;
    io.err(`onboard: ${token.problem}`);
    return undefined;
  };

  let owner: string;
  let agent: string;
  let features: Feature[];
  let schedule = DEFAULT_SCHEDULE;
  if (fileAt(SETTINGS_PATH) !== undefined) {
    const settings = loadSettings(sys, root);
    if (chosen) {
      io.err(`onboard: ${SETTINGS_PATH} already lists its features; turn one more on with --add <feature>`);
      return 1;
    }
    const [namedOwner, namedAgent] = named;
    if ((namedOwner && !anyLogin(settings.owners, namedOwner)) || (namedAgent && !anyLogin(settings.agents, namedAgent))) {
      io.err(`onboard: ${SETTINGS_PATH} already names owner ${either(settings.owners)} and agent ${either(settings.agents)}; edit or delete it to change them`);
      return 1;
    }
    // With several agents, the one named, else the one set up here.
    const here = namedAgent ? { agent: namedAgent } : agentHere(sys, settings.agents);
    if ('problem' in here) {
      io.err(`onboard: ${here.problem}; name the owner and the agent: niyam onboard <owner> <agent>`);
      return 1;
    }
    let raw = JSON.parse(fileAt(SETTINGS_PATH) as string) as Record<string, unknown>;
    features = featuresIn(raw);
    schedule = scheduleIn(raw);
    // With several owners, the one named, else the one the run's sign-in is, which must be listed: after the
    // features are read, which the sign-in's scopes depend on. Only the sign-in can tell, so it comes before the plan.
    let chosenOwner = namedOwner ?? (settings.owners.length === 1 ? settings.owners[0] : undefined);
    if (!chosenOwner) {
      if (dryRun) {
        io.err(`onboard: ${SETTINGS_PATH} names the owners ${either(settings.owners)}; name yours for a dry run, which signs in to nothing: niyam onboard <owner> --dry-run`);
        return 1;
      }
      const signed = await signIn(settings.owners);
      if ('problem' in signed) {
        io.err(`onboard: ${signed.problem}; name the owner: niyam onboard <owner>`);
        return 1;
      }
      if (!anyLogin(settings.owners, signed.login)) {
        io.err(`onboard: the browser signed in to GitHub as ${signed.login}, but ${SETTINGS_PATH} names the owners ${either(settings.owners)}; sign in there as one of them and run it again`);
        return 1;
      }
      chosenOwner = signed.login;
      notes.push(`- onboard signed in before showing its plan: ${SETTINGS_PATH} names several owners, and only the sign-in tells which one ran it.`);
    }
    // GitHub's spelling, which the keychain, the session file and commits use.
    owner = (await account(sys, chosenOwner)).login;
    agent = (await account(sys, here.agent)).login;
    // Before any change, so a refused --add leaves the settings as they were.
    if (add && !features.includes(add) && NEEDS_ISSUE_TYPES.includes(add) && !(await byOrganisation())) {
      io.err(`onboard: ${personal}, so ${add} cannot run here`);
      return 1;
    }
    // Settings an older release wrote: a feature by its older name, or the Figma library key, which belongs in a secret.
    const renamed = renamedLines(raw).length > 0;
    if (renamed || raw.figma !== undefined) {
      const library = (raw.figma as { library?: unknown } | null)?.library;
      // Set as the secret only when it is a file key, so nothing else is stored as one.
      const fileKey = typeof library === 'string' && FIGMA_FILE_KEY.test(library) ? library : undefined;
      const updates = [
        ...(renamed ? ['rename the design feature to figma'] : []),
        ...(raw.figma === undefined
          ? []
          : [fileKey ? 'take out "figma" and set its library key as the FIGMA_LIBRARY Actions secret' : 'take out "figma", since the library key belongs in the FIGMA_LIBRARY Actions secret']),
      ];
      settingsItem([...(renamed ? ['design → figma'] : []), ...(raw.figma === undefined ? [] : ['figma key out'])].join(', '));
      const { figma: _figma, ...rest } = raw;
      raw = { ...rest, ...(rest.features === undefined ? {} : { features }) };
      change(SETTINGS_PATH, `${JSON.stringify(raw, null, 2)}\n`, updates.join(' and '));
      if (fileKey) {
        github.push({ label: 'FIGMA_LIBRARY secret' });
        steps.push({
          label: 'FIGMA_LIBRARY secret',
          owner: true,
          async run(out, mine) {
            const problem = await setSecret(sys, slug, mine as string, 'FIGMA_LIBRARY', fileKey);
            if (problem) out.err(`onboard: ${problem}`);
            else out.out('set the FIGMA_LIBRARY Actions secret to the library key taken out of the settings');
            return !problem;
          },
        });
      } else if (library !== undefined) {
        byHand.push(`Once for ${slug}: add the Actions secret FIGMA_LIBRARY, the design library's Figma file key, at ${GITHUB_WEB}/${slug}/settings/secrets/actions.`);
        later.push(`The "figma.library" taken out was not a Figma file key; set the FIGMA_LIBRARY Actions secret to the design library's file key under ${slug} → Settings → Secrets and variables → Actions.`);
      }
    }
    const typed = features.filter((feature) => NEEDS_ISSUE_TYPES.includes(feature));
    if (typed.length > 0 && !(await byOrganisation())) {
      warnings.push(`${typed.join(', ')}: organisations only; take ${typed.length === 1 ? 'it' : 'them'} out of features`);
    }
    if (add && !features.includes(add)) {
      features = FEATURES.filter((feature) => features.includes(feature) || feature === add);
      settingsItem(`turn ${add} on`);
      // The pull request opens only once every step has finished, so settings never claim a half-set-up feature.
      change(SETTINGS_PATH, `${JSON.stringify({ ...raw, features }, null, 2)}\n`, `turn ${add} on`);
    }
  } else {
    if (add) {
      io.err(`onboard: there is no ${SETTINGS_PATH} to add to; run niyam onboard <owner> <agent> first`);
      return 1;
    }
    features = chosen ?? [...FEATURES];
    if ((!named[0] || !named[1]) && !sys.tty) {
      io.err('onboard: name the owner and the agent account: niyam onboard <owner> <agent>');
      return 1;
    }
    // The sign-in suggests the owner, so it comes before the plan; a dry run signs in to nothing.
    const suggested = named[0] || dryRun ? undefined : await signedInLogin(signIn);
    if (suggested) notes.push('- onboard signed in before showing its plan, to suggest the owner by the account the browser signed in as.');
    const namedOwner = named[0] ?? (await choose(sys, io, 'owner, who approves', [suggested]));
    const namedAgent = named[1] ?? (await choose(sys, io, 'agent, which builds', agentsSetUp(sys)));
    if (!namedOwner || !namedAgent) {
      io.err('onboard: name the owner and the agent account: niyam onboard <owner> <agent>');
      return 1;
    }
    for (const login of [namedOwner, namedAgent]) {
      if (!isLogin(login)) throw new Error(`"${login}" is not a GitHub login`);
    }
    owner = (await account(sys, namedOwner)).login;
    agent = (await account(sys, namedAgent)).login;
    if (sameLogin(owner, agent)) {
      io.err('onboard: the owner and the agent must be different accounts');
      return 1;
    }
    const typed = features.filter((feature) => NEEDS_ISSUE_TYPES.includes(feature));
    const refused = typed.length > 0 && !(await byOrganisation());
    if (refused) {
      if (chosen) {
        io.err(`onboard: ${personal}, so ${typed.join(', ')} cannot run here; leave ${typed.length === 1 ? 'it' : 'them'} out of --features`);
        return 1;
      }
      warnings.push(`personal account: ${typed.join(', ')} left off`);
      features = features.filter((feature) => !typed.includes(feature));
    }
    settingsItem(`new, ${features.length} feature${features.length === 1 ? '' : 's'} on`);
    change(SETTINGS_PATH, `${JSON.stringify({ owner, agent, features }, null, 2)}\n`, `owner ${owner} approves, agent ${agent} builds, with ${features.join(', ')} on`);
  }
  const on = (feature: Feature): boolean => features.includes(feature);
  const workflowNeeded = on('pr-identity') || on('board') || on('work-rules') || on('figma') || on('decisions') || on('review');
  // The shared Guard's caller (#470), in every repository whatever its features (#485). onboard's own, edited by
  // hand or not, is written again; a file of that name onboard did not write is the repository's own: refused
  // before any plan, so nothing changes.
  const callerBefore = fileAt(GUARD_CALLER_PATH);
  const callerHad = callerBefore === undefined ? undefined : await callerAt(callerBefore);
  if (callerBefore !== undefined && !(await callerIsOnboards(callerBefore))) {
    io.err(`onboard: ${GUARD_CALLER_PATH} is not the shared Guard's caller as onboard writes it, and onboard does not overwrite a workflow of the repository's own; nothing changed. Rename or delete it, then run onboard again.`);
    return 1;
  }

  const existing = fileAt(HOOKS_PATH);
  // Worked out before the plan, so a file onboard cannot edit is refused before any question.
  const claude = claudeSettings(existing, fileAt(SARATHI_PATH));
  warnings.push(...(claude.denied ?? []));
  if (claude.changes.length > 0) {
    pull.push({ label: 'settings.json', detail: existing === undefined ? 'new' : claude.labels.join(', ') });
    change(HOOKS_PATH, claude.text, claude.changes.join('; '));
  }
  if (claude.sarathi) {
    pull.push({ label: 'sarathi.json', detail: claude.sarathi.labels.join(', ') });
    change(SARATHI_PATH, claude.sarathi.text, claude.sarathi.changes.join('; '));
  }

  const paths = pathsFor(sys.home, agent);
  const token = readToken(sys, agent);
  const ready = token && checkToken(token, await tokenInfo(sys, token), agent, sys.now());
  const keyProblem = keyPairProblem(sys, paths.key);
  if (!token || !ready || ready.problem !== undefined || keyProblem) {
    // machine is the owner's to run, apart from onboard: it asks for the agent's token, hidden, and makes and
    // registers the agent's signing key, and a --yes or a run with no terminal can do neither (docs/decisions.md).
    const why = !token || !ready ? `no token stored for ${agent}` : (ready.problem ?? keyProblem);
    io.err(`onboard: this Mac is not set up for ${agent} (${why}); run niyam machine ${agent}, then onboard again`);
    return 1;
  }
  const { id } = await account(sys, agent);

  let reach = await access(sys, slug, token);
  if (reach.kind === 'refused') {
    io.err(`onboard: ${reach.reason}`);
    return 1;
  }
  // An agent that cannot see the repository has no pull request open on it, and the checkout was checked above.
  if (reach.kind !== 'none') {
    const ahead = await newerPinOnGitHub(sys, slug, token, reach.branch, version);
    if (ahead !== undefined && 'problem' in ahead) {
      io.err(`onboard: ${ahead.problem}; run it again`);
      return 1;
    }
    if (ahead !== undefined) return refuseOlder(io, slug, ahead, version);
  }
  // The default branch, which the workflow's pushes run on, is GitHub's to say once the agent can push; until then
  // the workflow is worked out again once it can, and the plan says only what it can know without it.
  const planned = reach.kind === 'push' ? reach.branch : undefined;
  // A public repository, or an organisation's base permission, lets the agent read without pushing.
  if (reach.kind === 'none' || reach.kind === 'read') {
    const sees = reach.kind === 'none' ? 'cannot see' : 'can read but not push to';
    let invite = await invitation(sys, slug, token);
    github.push({ label: invite === undefined ? `${agent} write access` : `${agent} accepts its invitation` });
    steps.push({
      label: `${agent} can push`,
      ...(invite === undefined ? { owner: true as const } : {}),
      async run(out, mine) {
        if (invite === undefined) {
          const added = await sys.http(`${API}/repos/${slug}/collaborators/${agent}`, { method: 'PUT', token: mine as string, body: { permission: 'push' } });
          if (added.status !== 201 && added.status !== 204) {
            const why = (added.json as { message?: unknown } | null)?.message;
            out.err(`onboard: GitHub did not add ${agent} (HTTP ${added.status}${typeof why === 'string' ? `: ${why}` : ''})`);
            out.err(`  Add it yourself: ${slug} → Settings → Collaborators → Add people → ${agent}, role Write.`);
            return false;
          }
          out.out(`gave ${agent}, which ${sees} ${slug}, write access, as ${owner}`);
          // An organisation member gets access at once; anyone else gets an invitation.
          reach = await access(sys, slug, token);
          invite = reach.kind === 'push' ? undefined : await invitation(sys, slug, token);
        }
        if (invite !== undefined) {
          const accepted = await sys.http(`${API}/user/repository_invitations/${invite}`, { method: 'PATCH', token });
          if (accepted.status !== 204) {
            out.err(`onboard: GitHub did not accept the invitation (HTTP ${accepted.status})`);
            return false;
          }
          out.out(`accepted ${agent}'s invitation to ${slug}, as ${agent}`);
          reach = await access(sys, slug, token);
        }
        if (reach.kind === 'push') return true;
        const why = {
          none: `${agent} still cannot see ${slug}; check the invitation reached ${agent}`,
          read: `${agent} can read ${slug} but still not push; check the invitation reached ${agent}, or give it the Write role`,
          refused: reach.kind === 'refused' ? reach.reason : '',
        };
        out.err(`onboard: ${why[reach.kind]}`);
        return false;
      },
    });
  }

  // The shared checks run only for features that need them.
  const workflowFrom = workflowPins(fileAt(WORKFLOW_PATH) ?? '')[0];
  const passed: Passed = { figma: on('figma'), board: on('board') };
  const workflowFor = (branch: string): void => {
    const update = workflowUpdate(fileAt(WORKFLOW_PATH), branch, version, passed.figma, schedule, SETTINGS_PATH, passed.board);
    if (update.kind !== 'same') change(WORKFLOW_PATH, update.text, workflowWhat(update, version, passed, SETTINGS_PATH));
  };
  // The Slice started job's board token comes from the board app's secrets, which only the owner can make (P-70).
  // A personal repository's checks skip the work rules, so it needs none.
  if (workflowNeeded && passed.board && (await byOrganisation())) {
    const names = await secretNames(sys, slug, token);
    const missing = BOARD_SECRETS.filter((name) => !names?.includes(name));
    // The app is made from a manifest in the owner's browser (P-72): a run with no one at the terminal, or an agent's
    // or a cloud session, leaves it by hand.
    const browser = sys.tty && !agentSession(sys) && sys.env.CLAUDE_CODE_REMOTE !== 'true';
    if (missing.length > 0 && browser) {
      // An organisation's app already made is shared with the repository with no click.
      github.push({ label: 'board app', detail: 'two clicks in the browser, if it is new' });
      steps.push({
        label: 'board app',
        owner: true,
        async run(out, mine) {
          const left = await setUpBoardApp(sys, out, slug, mine as string);
          byHand.push(...left);
          later.push(...left);
          // fail-open: what GitHub refused, or a click that did not come, is left by hand; the run goes on.
          return true;
        },
      });
    } else if (missing.length > 0) {
      const steps = boardAppSteps(slug, missing, names === undefined);
      byHand.push(steps);
      later.push(steps);
    }
  }
  if (workflowNeeded) {
    const update = planned === undefined ? undefined : workflowUpdate(fileAt(WORKFLOW_PATH), planned, version, passed.figma, schedule, SETTINGS_PATH, passed.board);
    const detail = update === undefined ? (fileAt(WORKFLOW_PATH) === undefined ? 'new' : 'write or update') : update.kind === 'same' ? undefined : workflowDetail(update, version, passed);
    if (detail !== undefined) pull.push({ label: 'workflow', detail });
  }
  // The caller runs on pull requests to the default branch, which only GitHub can say: as the workflow, worked out
  // again in the pull request's step.
  const callerFor = (branch: string): void => {
    const update = callerUpdate(callerBefore, callerHad, branch, version);
    if (update.kind !== 'same') change(GUARD_CALLER_PATH, update.text, callerWhat(update, version, branch));
  };
  const callerUpdated = planned === undefined ? undefined : callerUpdate(callerBefore, callerHad, planned, version);
  const callerPlan = callerUpdated === undefined ? (callerBefore === undefined ? `new, the shared Guard at v${version}` : 'write or update') : callerUpdated.kind === 'same' ? undefined : callerDetail(callerUpdated, version);
  if (callerPlan !== undefined) pull.push({ label: 'guard caller', detail: callerPlan });

  if (on('board')) {
    github.push({ label: 'board', detail: 'set up or check' });
    let approved: TypesPlan | undefined;
    if (await byOrganisation()) {
      const org = slug.split('/')[0] as string;
      // The agent reads the organisation's types but only the repositories it can see. Where a type outside the
      // work model exists, or an open issue with no type, the owner, who sees every repository, signs in before the
      // plan, so the plan shows what the yes approves; the run changes nothing beyond it. A dry run signs in to
      // nothing: it shows the agent's view.
      approved = await typesPlan(sys, token, org).catch(() => undefined);
      if (!dryRun && (approved === undefined || approved.others.length > 0 || approved.retype.length > 0)) {
        const mine = await ownerToken();
        if (!mine) return 1;
        approved = await typesPlan(sys, mine, org);
        notes.push('- onboard signed in before showing its plan: the organisation has issue types outside the work model or open issues with no type, and only the owner sees every repository that holds them.');
      }
      if (approved) github.push({ label: 'issue types', detail: typesDetail(approved) }, ...typesLines(approved));
      else github.push({ label: 'issue types', detail: 'org-wide, read once signed in' });
    }
    const projectTitle = (JSON.parse(fileAt(SETTINGS_PATH) as string) as { project?: unknown }).project;
    steps.push({
      label: 'board',
      owner: true,
      async run(out, mine) {
        // The plan's one yes covers each step of the board but replacing a Project made before the template, which
        // moves its items and closes it: that is left to the owner, with what the template would have set.
        const board = await setUpBoard(sys, out, (_, step) => Promise.resolve(step !== 'replace'), slug, owner, mine as string, typeof projectTitle === 'string' ? projectTitle : undefined, approved);
        byHand.unshift(...(board?.byHand ?? []));
        later.unshift(...(board?.byHand ?? []));
        return board !== undefined;
      },
    });
  }

  // Every adopter: the identity guard holds where the Claude Code hooks did not run.
  const hook = prePushHook(sys, root);
  const hookLine = `${CLI} pre-push "$@"`;
  if (hook.state === 'missing' || hook.state === 'older') {
    mac.push({ label: 'pre-push hook', detail: hook.state === 'older' ? 'older one replaced' : 'new' });
    steps.push({
      label: 'pre-push hook',
      async run(out) {
        sys.write(hook.file, PRE_PUSH_HOOK, 0o755);
        out.out(`${hook.state === 'older' ? 'replaced the older' : 'wrote the'} pre-push git hook ${hook.path}, which checks an agent session pushes to GitHub as the agent, and the work rules`);
        return true;
      },
    });
  } else if (hook.state === 'outside' || hook.state === 'own') {
    // A hooks folder shared by other repositories (a global core.hooksPath), or the client's own hook, is the owner's to change.
    const addLine = `Add the line \`${hookLine}\` to the pre-push git hook ${hook.path}, which ${hook.state === 'own' ? 'is your own' : 'git runs from outside this repository'}.`;
    byHand.push(`Once on this Mac: ${addLine.charAt(0).toLowerCase()}${addLine.slice(1)}`);
    later.push(addLine);
  }

  steps.push({
    label: `test commit Verified as ${agent}`,
    async run(out) {
      return (await testCommit(sys, out, { agent, id, token, slug })) === 0;
    },
  });
  // Claude's routines API answers only a Claude Code session's own sign-in, and a routine works as claude.ai's GitHub
  // connection, so onboard cannot create one or check it; it sees one runs by the agent's verdicts on the repository.
  if (on('review')) {
    const routine = `${GITHUB_WEB}/${PRODUCT}/blob/v${version}/routines/review.md`;
    const seen = await routineTrace(sys, slug, agent, token).catch(() => {
      // fail-open: comments GitHub does not give leave the routine by hand, which the owner skips if done.
      return undefined;
    });
    if (seen) notes.push(`- review routine: ${agent} gave a verdict on #${seen.number} on ${seen.date}, so it runs`);
    else {
      byHand.push(`Once for ${slug}: in Claude Code, run /schedule and create a weekly routine on it, with claude.ai's GitHub connected as ${agent} and the prompt below the line in ${routine}; skip it if done.`);
      later.push(
        `The review routine: create a weekly Claude routine on ${slug} (claude.ai/code/routines, or /schedule in Claude Code), with claude.ai's GitHub connected as ${agent}, and give it the prompt below the line in ${routine}. Until it gives its verdicts, the weekly job labels needs-owner each decision over a week past its review date.`,
      );
    }
  }
  // Claude cloud sessions. Claude Code has no API for a cloud environment's Setup script, so the version lives in a
  // file the repo owns, written at the pin on every run, and the SessionStart hook runs it when a session has no CLI.
  const cloudBefore = fileAt(CLOUD_SETUP_PATH);
  const released = await releaseSha256(sys, version, token);
  if ('problem' in released) warnings.push(`${CLOUD_SETUP_PATH} left as it is: ${released.problem}`);
  else {
    const text = cloudRepoScript(version, released.sha256);
    if (text !== cloudBefore) {
      const from = cloudBefore === undefined ? undefined : cloudScriptVersion(cloudBefore);
      pull.push({ label: 'cloud-setup.sh', detail: cloudBefore === undefined ? `new, installs v${version}` : from && from !== version ? `v${from} → v${version}` : 'written again' });
      change(CLOUD_SETUP_PATH, text, `installs niyam ${version} in Claude cloud sessions, its download checked against its sha256`);
    }
    if (cloudBefore === undefined) {
      cloud.push({ label: "claude.ai's GitHub", detail: `as ${agent}` });
      byHand.push(`Once per claude.ai account: sign in at ${CLAUDE_CODE_WEB} and connect GitHub as ${agent} (or change it at ${CLAUDE_CONNECTORS}); skip it if done.`);
      later.push(
        `Claude cloud sessions, once per claude.ai account: connect claude.ai's GitHub as ${agent}. Each session with no niyam installs it from ${CLOUD_SETUP_PATH}, which onboard keeps at the pin, so there is nothing to paste; what niyam cloud-setup prints, put in the cloud environment's Setup script, makes sessions start faster, since Claude caches what a Setup script installs.`,
      );
    }
  }
  // The file under its name before P-56, which no release writes or runs since P-57, goes where the new one is left.
  if (fileAt(LEFTOVER_CLOUD_SETUP_PATH) !== undefined && fileAt(CLOUD_SETUP_PATH) !== undefined) {
    remove(LEFTOVER_CLOUD_SETUP_PATH, `moved to ${CLOUD_SETUP_PATH}, which the Setup snippet since 0.6.10 runs`);
    const item = pull.find((one) => one.label === 'cloud-setup.sh');
    const deleted = `${LEFTOVER_CLOUD_SETUP_PATH.slice('.github/'.length)} deleted`;
    if (item) item.detail = `${item.detail}, ${deleted}`;
    else pull.push({ label: 'cloud-setup.sh', detail: deleted });
    if (cloudBefore !== undefined) {
      later.push(
        `Claude cloud sessions: a Setup script pasted before niyam 0.6.10 runs ${LEFTOVER_CLOUD_SETUP_PATH}, which this pull request deletes; if yours is one, delete niyam's part of it, since sessions now install niyam themselves, or paste what niyam cloud-setup prints over it. ${SETUP_FIRST}`,
      );
    }
  }
  // The agent's cloud signing key (#417) is the agent's, not the repository's: one line serves every cloud
  // environment it works in, so onboard makes one only when the agent's own list holds none, and the second repo
  // onboarded leaves it alone. Where cloud-key would refuse, the owner runs it instead.
  const keyByHand = `Once for ${agent}: in your own terminal on your Mac, run niyam cloud-key ${agent}, paste the line it puts on the clipboard into each Claude cloud environment's variables, then run niyam onboard here again, which pins the key in ${SETTINGS_PATH}.`;
  const cloudKeys = await listedKeys(sys, agent, token).catch((error: unknown) => {
    // fail-open: a list GitHub does not give is warned about below and makes no key.
    return { problem: detail(error) };
  });
  let makeKey = false;
  // A list GitHub does not give makes no key, which could be a second one: the warning says how to check.
  if ('problem' in cloudKeys) warnings.push(`cloud signing key not checked (${cloudKeys.problem}); niyam cloud-key ${agent} makes one`);
  else if (!cloudKeys.keys.some((one) => one.title === CLOUD_KEY_TITLE)) {
    if (dryRun || cloudKeyRefusal(sys) !== undefined) byHand.push(keyByHand);
    else {
      cloud.push({ label: 'signing key', detail: `for ${agent}, on the clipboard` });
      makeKey = true;
    }
  }
  // A cloud session's proxy cannot read the agent's signing keys (#447), so the settings pin its cloud signing keys
  // as GitHub lists them now, with the one this run makes: made here, so the pull request pins it, and registered
  // last, as before. One that then fails to register reaches no clipboard, so no environment holds it; a later run
  // drops it once GitHub does not list it. A list GitHub does not give leaves the pin as it is.
  const fresh = makeKey ? newKey() : undefined;
  if (!('problem' in cloudKeys)) {
    const keys = [...cloudKeys.keys.filter((one) => one.title === CLOUD_KEY_TITLE && one.key !== '').map((one) => one.key), ...(fresh ? [publicLine(fresh)] : [])];
    const text = fileAt(SETTINGS_PATH);
    let pins: Record<string, string[]> | undefined;
    try {
      pins = text === undefined ? undefined : { ...settingsIn(text).cloudSigningKeys };
    } catch (error) {
      // fail-open: the pin stays as it is, and the plan says why.
      warnings.push(`cloud signing keys not pinned (${detail(error)})`);
    }
    if (text !== undefined && pins !== undefined) {
      const name = Object.keys(pins).find((login) => sameLogin(login, agent)) ?? agent;
      if (keys.join('\n') !== (pins[name] ?? []).join('\n')) {
        if (keys.length > 0) pins[name] = keys;
        else delete pins[name];
        const what = keys.length > 0 ? `pin ${agent}'s cloud signing ${keys.length === 1 ? 'key' : 'keys'}, which cloud sessions check theirs against` : `drop ${agent}'s cloud signing keys, which GitHub no longer lists`;
        // Written where it stands, the rest of the file as it is.
        change(SETTINGS_PATH, setMember(text, [], CLOUD_SIGNING_KEYS, pins), what);
        settingsItem(what);
      }
    }
  }
  let pullUrl: string | undefined;
  // Whether the pull request merges itself once its checks pass.
  let merging = false;
  // A Mergify merge queue that takes pull requests by itself merges it, so GitHub's auto-merge is neither turned on
  // nor asked for. Read from the default branch; where the agent cannot push yet, worked out again once it can.
  let queue = planned === undefined ? undefined : await mergeQueue(sys, slug, planned, token);
  steps.push({
    label: 'pull request',
    async run(out) {
      if (reach.kind !== 'push') return false;
      if (workflowNeeded) workflowFor(reach.branch);
      callerFor(reach.branch);
      // From 2026-12-02 GitHub runs pull_request_target in a public repository only where a policy allows it.
      if (reach.public) {
        const policy = policySteps(slug);
        byHand.push(policy.byHand);
        later.push(policy.later);
      }
      // From the workflow the pull request leaves, worked out only now that GitHub has said the branch.
      const text = fileAt(WORKFLOW_PATH);
      const unpassed = workflowNeeded && on('figma') && text !== undefined ? jobsWithoutLibrary(text) : [];
      if (unpassed.length > 0) {
        byHand.unshift(`Once for ${slug}: in ${WORKFLOW_PATH}, add FIGMA_LIBRARY: \${{ secrets.FIGMA_LIBRARY }} under the secrets of ${unpassed.join(', ')}, so the design check runs there.`);
        later.unshift(`In ${WORKFLOW_PATH}, ${unpassed.join(', ')} pass the shared checks no FIGMA_LIBRARY secret, so the design check stays off there; add \`FIGMA_LIBRARY: \${{ secrets.FIGMA_LIBRARY }}\` under their secrets.`);
      }
      // A change that puts a file back as it was is no change.
      const changed = [...changes.values()].filter((one) => one.text !== one.before);
      if (changed.length === 0) return true;
      const described = [
        ...(notes.length > 0 ? ['Done at the terminal, outside this pull request:', '', ...notes, ''] : []),
        ...(later.length > 0 ? ['Left to do by hand:', '', ...later.map((line) => `- ${line}`)] : []),
      ];
      const opened = await openPull(sys, out, { agent, id, token, slug, branch: reach.branch, version }, changed, described);
      if (opened === 1) return false;
      pullUrl = opened.url;
      if (planned === undefined) queue = await mergeQueue(sys, slug, reach.branch, token);
      if (queue !== undefined) {
        merging = true;
        return true;
      }
      // Not turning it on fails nothing: the owner merges it instead.
      // A request that gets no answer is a refusal like any other: the pull request is open either way.
      const refused = await autoMerge(sys, slug, token, opened.id).catch((error: unknown) => ({
        problem: error instanceof Error ? error.message : String(error),
        notAllowed: undefined,
      }));
      merging = refused === undefined;
      if (refused?.notAllowed) byHand.unshift(`Now: turn on Allow auto-merge at ${GITHUB_WEB}/${slug}/settings, or merge ${opened.url} yourself once its checks pass.`);
      else if (refused) byHand.unshift(`Now: merge ${opened.url} yourself once its checks pass, since GitHub refused auto-merge (${refused.problem}).`);
      return true;
    },
  });

  const signedAs = signedIn && (await signedIn);
  const asOwnerItems = steps.some((step) => step.owner);
  const groups = [
    // It merges itself, through the repository's merge queue, or as the agent turns auto-merge on, unless the repository does not allow it.
    {
      title: 'Pull request',
      items:
        pull.length > 0
          ? [
              ...pull,
              queue !== undefined
                ? { label: 'merge queue', detail: 'Mergify, when checks pass' }
                : // Until the agent can push, whether a merge queue takes it is not known.
                  { label: planned === undefined ? 'auto-merge or merge queue' : 'auto-merge', detail: 'when checks pass' },
            ]
          : [],
    },
    { title: asOwnerItems ? (signedAs && 'login' in signedAs ? `GitHub — signed in as ${signedAs.login}` : `GitHub — one sign-in as ${owner}`) : 'GitHub', items: github },
    { title: 'This Mac', items: mac },
    { title: 'Claude cloud — by hand, once per claude.ai account', items: cloud },
    { title: 'Check', items: [{ label: `one signed test commit by ${agent}, deleted after` }] },
  ];
  for (const line of planLines(paint, planHead(paint, { from: workflowNeeded ? workflowFrom : undefined, version, slug, owner, agent, warnings }), groups)) io.out(line);
  if (dryRun) {
    io.out(closing(paint, 'Dry run: nothing changed.'));
    return 0;
  }
  if (yes) io.out(`${paint.done('◇')}  Go ahead? Yes (--yes)`);
  else if (!(await sys.choose('Go ahead?'))) {
    io.out(closing(paint, 'Nothing changed, and no pull request was opened.'));
    return 1;
  }

  for (const step of steps) {
    const mine = step.owner ? await ownerToken() : undefined;
    const { ok, log } = await runStep(sys, io, paint, step.label, !step.owner || mine ? (out) => step.run(out, mine) : undefined);
    if (!ok) {
      io.err(`onboard: stopped at "${step.label}"; nothing after it was changed, and no pull request was opened`);
      return 1;
    }
    if (log.length > 0) notes.push(`- ${step.label}:`, ...log.map((line) => `  - ${line.trim().replace(/^[✓-] /, '')}`));
  }
  // Last, once the pull request is open: a key that fails only warns, and nothing before it is undone.
  // A Ctrl-C that stops the key ends the run as one does.
  let exitCode = 0;
  if (makeKey) {
    let made = false;
    try {
      ({ ok: made } = await runStep(sys, io, paint, `cloud signing key for ${agent}`, async (out) => {
        const code = await makeCloudKey(sys, out, agent, token, fresh ? { key: fresh } : {});
        if (code === 130) exitCode = 130;
        return code === 0;
      }));
    } catch (error) {
      // fail-open: the pull request is open and every step before stands; the key's failure is said and left by hand below.
      io.err(`onboard: ${detail(error)}`);
    }
    if (made) byHand.unshift(`Now: ${SIGNING_KEY_VAR}=… is on the clipboard. ${pasteLines(agent, "each Claude cloud environment's").join(' ')}`);
    else {
      io.err(`onboard: ${agent} has no cloud signing key yet; everything before it is done, and no environment holds the key the pull request pins`);
      byHand.push(keyByHand);
    }
  }
  for (const line of byHandLines(paint, byHand)) io.out(line);
  io.out(closing(paint, `${!pullUrl ? 'Done; no file changes, so no pull request.' : merging ? `${pullUrl}  ${queue !== undefined ? 'the merge queue merges it' : 'merges itself'} when checks pass` : `Merge ${pullUrl}`}`));
  return exitCode;
}

/** How many times onboard asks GitHub about the test commit, waiting a little longer each time. */
export const COMMIT_ATTEMPTS = 5;

/**
 * GitHub's answer about a commit just pushed. A dropped connection or an
 * error from GitHub is asked again, since a commit can take a moment to
 * show and the network can fail for a moment; the last failure otherwise.
 */
async function commitInfo(sys: Sys, slug: string, sha: string, token: string): Promise<unknown> {
  let failure = new Error('not asked');
  for (let attempt = 1; attempt <= COMMIT_ATTEMPTS; attempt++) {
    try {
      const { status, json } = await sys.http(`${API}/repos/${slug}/commits/${sha}`, { token });
      if (status === 200) return json;
      failure = new Error(`HTTP ${status}`);
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error));
    }
    if (attempt < COMMIT_ATTEMPTS) await sys.sleep(attempt * 2000);
  }
  return failure;
}

interface Target {
  agent: string;
  id: number;
  token: string;
  slug: string;
}

/** Signs an empty commit on the repo's tip as the agent, pushes it, and asks GitHub whether it is Verified. */
async function testCommit(sys: Sys, io: Output, target: Target): Promise<number> {
  const { agent, id, token, slug } = target;
  const paths = pathsFor(sys.home, agent);
  const dir = sys.exec('mktemp', ['-d']).stdout.trim();
  const env = sessionEnv(sys.env, agent, id, token, paths);
  const git = (...args: string[]) => sys.exec('git', args, { cwd: dir, env });
  const url = `${GITHUB_WEB}/${slug}.git`;
  const branch = `${CLI}/verify-${agent.toLowerCase()}-${sys.now().getTime()}`;
  let pushed = false;
  try {
    const head = git('ls-remote', url, 'HEAD');
    if (head.code === 0 && !head.stdout.trim()) {
      // A first push would make the throwaway branch the default one.
      io.err(`onboard: ${slug} has no commits yet; push a first commit to it, then onboard again`);
      return 1;
    }
    for (const args of [
      ['init', '-q'],
      ['fetch', '-q', '--depth=1', '--filter=blob:none', url, 'HEAD'],
    ]) {
      const step = git(...args);
      if (step.code !== 0) {
        io.err(`onboard: git ${args[0]} failed: ${step.stderr.trim()}`);
        return 1;
      }
    }
    const made = git('commit-tree', '-S', 'FETCH_HEAD^{tree}', '-p', 'FETCH_HEAD', '-m', `niyam: signing check for ${agent}`);
    const sha = made.stdout.trim();
    if (made.code !== 0 || !sha) {
      io.err(`onboard: signing the test commit failed: ${made.stderr.trim()}`);
      return 1;
    }
    const push = git('push', '-q', url, `${sha}:refs/heads/${branch}`);
    if (push.code !== 0) {
      io.err(`onboard: pushing as ${agent} failed: ${push.stderr.trim()}`);
      return 1;
    }
    pushed = true;
    io.out(`Test commit ${GITHUB_WEB}/${slug}/commit/${sha}`);
    const asked = await commitInfo(sys, slug, sha, token);
    if (asked instanceof Error) {
      io.err(`onboard: cannot ask GitHub whether the test commit is Verified (${asked.message}); open the link above to see`);
      return 1;
    }
    const commit = asked as {
      committer?: { login?: string } | null;
      commit?: { verification?: { verified?: boolean; reason?: string } };
    } | null;
    const verification = commit?.commit?.verification;
    const committer = commit?.committer?.login;
    io.out(`  committer: ${committer ?? 'none'}; verified: ${String(verification?.verified)} (${verification?.reason ?? 'no reason'})`);
    if (verification?.verified !== true || !sameLogin(committer, agent)) {
      io.err(`onboard: GitHub does not show the commit Verified by ${agent}`);
      return 1;
    }
    io.out(`✓ GitHub shows the test commit Verified by ${agent}`);
    return 0;
  } finally {
    // Runs on every path after the push, the API failing included; says so when the branch stays.
    if (pushed) {
      const removed = git('push', '-q', url, `:refs/heads/${branch}`);
      if (removed.code === 0) io.out(`Deleted the throwaway branch ${branch}.`);
      else io.err(`onboard: could not delete ${branch}; delete it on GitHub: ${removed.stderr.trim()}`);
    }
    sys.exec('rm', ['-rf', dir]);
  }
}
