import { homedir } from 'node:os';

import { LOCKED, asAgent, asAgentArgs } from './as-agent.ts';
import { auditArgs, boardAudit } from './board-audit.ts';
import { cloudSetup } from './cloud.ts';
import { cloudKey, cloudKeyArgs } from './cloud-key.ts';
import { needsOwner } from './asks.ts';
import { decisionsWeekly } from './decisions.ts';
import { prDesign } from './design.ts';
import { doctor } from './doctor.ts';
import { env, envArgs, envFailed } from './env.ts';
import { guard } from './guard.ts';
import { issueType } from './issue-types.ts';
import { prIdentity } from './identity.ts';
import { machine, machineArgs } from './machine.ts';
import { brief, briefArgs, handoff, handoffArgs } from './handoff.ts';
import { cubicDismiss, dismissArgs } from './cubic-dismiss.ts';
import { docNumber, docNumberArgs } from './doc-numbers.ts';
import { renumberArgs, renumberDoc } from './renumber-doc.ts';
import { workItemArgs, workItemNumber } from './work-item-number.ts';
import { keepGoing } from './keep-going.ts';
import { prAutocreate } from './pr-autocreate.ts';
import { prSignals, signalArgs } from './pr-signals.ts';
import { reviewsDue } from './reviews.ts';
import { reviewArgs, reviewThread } from './review-thread.ts';
import { onboard, onboardArgs } from './onboard.ts';
import { ownerStep, ownerStepArgs } from './owner-step.ts';
import { sessionStart } from './session-start.ts';
import { SSH_SIGN, sshSign } from './ssh-sign.ts';
import { upgrade } from './upgrade.ts';
import { prMerged, prStarted, prePush, prWorkRules, propose } from './work.ts';
import type { Output, Sys } from './types.ts';

import { CLI } from './names.ts';
import { packageVersion } from './version.ts';

export type { Output } from './types.ts';
export { packageVersion, versionOf } from './version.ts';

export const USAGE = `Usage: niyam <command>

Commands:
  machine [agent] [--yes] [--dry-run]
                   Set up this machine so agent sessions work as the agent account
  doctor [agent]   Check agent sessions here can work as the agent account
  onboard [owner agent] [--features a,b] [--add feature] [--yes] [--dry-run]
                   Set up the client repo here, for the features it turns on
  upgrade          Install the newest release with pnpm, and check PATH runs it alone
  owner-step <step> [args]
                   In your own terminal: one GitHub step only the owner's account can do, through a
                   throwaway gh sign-in. Steps: issue-types <org>;
                   label <owner/repo> <number> <add|remove> <approved|do-not-merge>;
                   required-checks <owner/repo> <ruleset id or name> [--check <name>]…
  cloud-setup      Print an optional Setup snippet that makes Claude cloud sessions start faster
  cloud-key [agent] [--yes]
                   In your own terminal: a new signing key for the agent's Claude cloud sessions, registered
                   as the agent, and NIYAM_SIGNING_KEY=… on the clipboard for the cloud environment's variables
  env [-- <command> [args...]]
                   For agents run from any tool: the GitHub lock, then the agent identity where this Mac
                   has it, as shell lines for eval "$(niyam env)", or with -- the command run under them
  session-start    Run by a client's SessionStart hook: the agent identity, or GitHub locked out
  ssh-sign -Y sign -n <namespace> -f <key> <file>...
                   Run by git in a Claude cloud session, as gpg.ssh.program: signs as ssh-keygen does
  guard            Run by a client's PreToolUse hook: gh and git's remote commands only as the agent
  as-agent --session <session_id> -- <command> [args...]
                   For a client's hook: run one command as the session's agent, or nothing (exit ${LOCKED})
  pr-identity      Run by the shared workflow: agent commits Verified and pushed by the agent
  pr-work-rules    Run by the shared workflow: an agent pull request builds one slice it may build
  pr-merged        Run by the shared workflow: a merged pull request closes the slice and States it names
  pr-started       Run by the shared workflow: an opened pull request moves its slice to In Progress on the board
  pr-design        Run by the shared workflow: each state of the slice links a frame from the design library
  decisions-weekly Run by the shared workflow weekly: decision checks, undo issues, expiring labels
  needs-owner      Run by the shared workflow: an ask labels its issue needs-owner; the owner's answer takes it off
  issue-type       Run by the shared workflow: an issue opened with no type gets the work model's
  reviews-due      For the review routine: open decisions whose review date has come, as JSON lines
  pre-push         Run by the pre-push git hook: the same rules before an agent session pushes
  propose <issue>... [--page <url>]
                   As the agent: ask the owner to approve, with a 👍, a slice added late or a dropped state,
                   in a short comment linking the published page that argues it (--page is needed
                   whenever a proposal is still to be posted; a rerun that only links needs none);
                   with an Approvals issue, it prints the first line of one comment there answering them all
  review-thread <thread-id> [--reply <text> | --body-file <path>] [--resolve | --no-resolve]
                [--reaction <+1|-1> --comment-id <id>]
                   As the agent: answer a review thread on one of its own pull requests here; a reply
                   from --body-file resolves it unless --no-resolve, and a reply already there is not posted again
  review-thread --batch <file>
                   The same for each thread a JSON list in the file names, in order, with the token checked
                   once; it stops at the first refusal and says which threads were done
  pr-signals <pr> [--ci-only]
                   A pull request's open review threads, failing checks (error lines only) and local
                   review findings, as one JSON list without duplicates; exit 3 merged, 4 closed
  handoff --detect | --record --disposition <own-work|handed-off|carrying|dismissed> --reason <text>
          [--brief #N,...] [--open-brief <draft.md>] | --assert-fresh [--call-site <site>] [--base <ref>]
                   The hand-off gate, where .github/niyam.json names "handoff": a push that edits shared
                   plumbing, or keeps failing at one stage, needs a declaration first; --assert-fresh
                   is the gate, run by the pre-push hook
  brief [--lint] <draft.md>
                   Open a hand-off brief draft as a Brief issue, or only check it
  cubic-dismiss (--evidence <proof> | --decision <where the owner chose>)
                ((--title <exact> --reason <why>)... | --from <file.json>) [--context <id>]
                   Record a Cubic finding as dismissed, committing the dismiss file alone with its basis
  pr-autocreate claude-hook | spawn-watchers --root <repo> --remote <name>
                | watch --root <repo> --branch <branch> --sha <commit>
                   A pushed branch gets its pull request: Claude Code's PostToolUse(Bash) and Stop
                   hook, the pre-push hook (git's ref lines on stdin) and the watcher it starts;
                   NIYAM_PR_AUTOCREATE=0 on a push opens none. Its own errors exit 0
  keep-going [--stop <why>]
                   Claude Code's Stop hook: sends a session back while its branch has commits the base
                   lacks and its pull request has not merged, saying what is left ("1 of 5"); --stop
                   records why started work stops at this commit. The hook always exits 0
  doc-number <kind> [--reserve] [--json] [--offline]
                   The next free number of a numbered document kind (adr), against main, this tree, every
                   ref, open pull requests and Work item titles; --reserve claims it for good, and refuses
                   when GitHub could not be read. The kinds are .github/niyam.json's "docNumbers"
  renumber-doc <kind> <from> <to> [--apply]
                   Move a numbered document to a free number with every citation, path and relationship
                   that names it; a dry run unless --apply
  work-item-number [--issue <N>] [--apply]
                   Run by a client's workflow on issue events: a Work item whose number something else
                   holds is renumbered, with a comment; --apply writes
  board-audit [owner/repo] [--project <title>]
                   Read only: the open issues not on the work board, items whose Status disagrees with
                   their issue, and whether the auto-add workflows are on; exit 3 when something is to fix.
                   Reads with GH_TOKEN, else the agent's token from this Mac's keychain; cannot run in
                   a Claude cloud session, whose proxy refuses Projects
  help            Show this text
  version          Print the installed version

as-agent's command gets the session's agent identity, stdin, stdout and stderr, and its
exit code is as-agent's; exit ${LOCKED} means the session does not work as the agent, and nothing ran.
Without [agent], machine and doctor use the agent account .github/niyam.json names
in the repo around the working directory.
onboard suggests the owner and agent the first time (or name them); after that it reads them from that file.
Features: identity (always on), pr-identity, board, work-rules, figma, decisions, review.
--features lists them the first time (all when left out); --add turns one more on.
machine and onboard print one plan and ask once; --yes goes ahead without asking, --dry-run stops at the plan.`;

/**
 * propose's issue numbers, one or several, and the page its comments link
 * (`--page <url>` or `--page=<url>`, once); throws on anything else, naming
 * the first argument that is not an issue number.
 */
export function proposeArgs(args: readonly string[]): { numbers: number[]; page?: string } {
  const issues: string[] = [];
  let page: string | undefined;
  for (let at = 0; at < args.length; at++) {
    const arg = args[at] as string;
    const inline = arg.startsWith('--page=') ? arg.slice('--page='.length) : undefined;
    if (arg !== '--page' && inline === undefined) {
      issues.push(arg);
      continue;
    }
    if (page !== undefined) throw new Error('propose takes one --page: one page argues every proposal of the run');
    const value = inline ?? args[++at];
    if (!value || value.startsWith('-')) throw new Error("propose --page needs the published page's link");
    page = value;
  }
  const notIssue = issues.length === 0 ? '' : issues.find((arg) => !/^#?0*[1-9]\d*$/.test(arg));
  if (notIssue !== undefined) throw new Error(`propose needs an issue number${notIssue === '' ? '' : `, not "${notIssue}"`}`);
  return { numbers: issues.map((arg) => Number(arg.replace('#', ''))), ...(page === undefined ? {} : { page }) };
}

/** Runs one command and returns its exit code: 0 done, 1 failed, 2 bad usage. */
export async function run(args: readonly string[], io: Output, sys: () => Sys | Promise<Sys>): Promise<number> {
  const [command, ...rest] = args;
  const allowed = command === 'onboard' || command === 'machine' || command === 'cloud-key' || command === 'review-thread' || command === 'as-agent' || command === 'env' || command === 'propose' || command === 'owner-step' || command === 'handoff' || command === 'brief' || command === 'cubic-dismiss' || command === 'pr-autocreate' || command === 'keep-going' || command === 'doc-number' || command === 'renumber-doc' || command === 'work-item-number' || command === 'board-audit' || command === SSH_SIGN ? Infinity : command === 'pre-push' || command === 'pr-signals' ? 2 : command === 'doctor' ? 1 : 0;
  const extra = rest[allowed];
  if (extra !== undefined) {
    io.err(`niyam: unexpected argument "${extra}"`);
    io.err(USAGE);
    return 2;
  }
  if (command === 'onboard' || command === 'machine' || command === 'cloud-key' || command === 'review-thread' || command === 'as-agent' || command === 'env' || command === 'propose' || command === 'owner-step' || command === 'pr-signals' || command === 'handoff' || command === 'brief' || command === 'cubic-dismiss' || command === 'doc-number' || command === 'renumber-doc' || command === 'work-item-number' || command === 'board-audit') {
    // Their options are checked here, so a bad one is bad usage (exit 2).
    try {
      (command === 'board-audit' ? auditArgs : command === 'cloud-key' ? cloudKeyArgs : command === 'doc-number' ? docNumberArgs : command === 'renumber-doc' ? renumberArgs : command === 'work-item-number' ? workItemArgs : command === 'onboard' ? onboardArgs : command === 'machine' ? machineArgs : command === 'as-agent' ? asAgentArgs : command === 'env' ? envArgs : command === 'propose' ? proposeArgs : command === 'owner-step' ? ownerStepArgs : command === 'pr-signals' ? signalArgs : command === 'handoff' ? handoffArgs : command === 'brief' ? briefArgs : command === 'cubic-dismiss' ? dismissArgs : reviewArgs)(rest);
    } catch (error) {
      io.err(`niyam: ${error instanceof Error ? error.message : String(error)}`);
      io.err(USAGE);
      return 2;
    }
  }
  switch (command) {
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      io.out(USAGE);
      return 0;
    case 'version':
    case '--version':
    case '-v':
      io.out(packageVersion());
      return 0;
    case 'cloud-setup':
      return cloudSetup(io);
    case SSH_SIGN:
      return sshSign(io, rest);
    case 'session-start':
      return sessionStart(await sys(), io);
    case 'guard':
      // Any failure refuses: Claude Code runs the command when a PreToolUse hook exits 1.
      try {
        const real = await sys();
        return guard(real, io, real.readStdin());
      } catch (error) {
        io.err(`niyam guard: refused, because the check failed: ${error instanceof Error ? error.message : String(error)}`);
        return 2;
      }
    case 'pr-autocreate':
      // Its own errors never fail a push or hold a session: it says so and exits 0.
      try {
        return await prAutocreate(await sys(), io, rest);
      } catch (error) {
        io.err(`pr-autocreate: unexpected error (${error instanceof Error ? error.message : String(error)}); nothing done`);
        return 0;
      }
    case 'keep-going':
      // The hook never holds a session on its own error; only --stop can fail.
      try {
        return await keepGoing(await sys(), io, rest);
      } catch (error) {
        io.err(`niyam keep-going: ${error instanceof Error ? error.message : String(error)}`);
        return rest[0] === '--stop' ? 1 : 0;
      }
    case 'as-agent':
      // Any failure runs nothing and says so with the locked code, never the command's own.
      try {
        return asAgent(await sys(), io, asAgentArgs(rest));
      } catch (error) {
        io.err(`niyam as-agent: ran nothing, because the check failed: ${error instanceof Error ? error.message : String(error)}`);
        return LOCKED;
      }
    case 'env': {
      // Any failure of its own check still locks: it prints the lock alone, or runs nothing.
      const parsed = envArgs(rest);
      let home = homedir();
      try {
        const real = await sys();
        home = real.home;
        return env(real, io, parsed);
      } catch (error) {
        // fail-open: only in that env carries on, printing the lock alone or running nothing, so the shell stays locked.
        return envFailed(home, io, parsed, error);
      }
    }
    case 'machine':
    case 'cloud-key':
    case 'doctor':
    case 'onboard':
    case 'pr-identity':
    case 'pr-work-rules':
    case 'pr-merged':
    case 'pr-started':
    case 'pr-design':
    case 'decisions-weekly':
    case 'needs-owner':
    case 'issue-type':
    case 'reviews-due':
    case 'pre-push':
    case 'propose':
    case 'review-thread':
    case 'pr-signals':
    case 'handoff':
    case 'brief':
    case 'cubic-dismiss':
    case 'upgrade':
    case 'owner-step':
    case 'doc-number':
    case 'renumber-doc':
    case 'work-item-number':
    case 'board-audit':
      try {
        if (command === 'board-audit') return await boardAudit(await sys(), io, rest);
        if (command === 'doc-number') return docNumber(await sys(), io, rest);
        if (command === 'renumber-doc') return renumberDoc(await sys(), io, rest);
        if (command === 'work-item-number') return workItemNumber(await sys(), io, rest);
        if (command === 'upgrade') return await upgrade(await sys(), io);
        if (command === 'pr-signals') return await prSignals(await sys(), io, rest);
        if (command === 'handoff') return await handoff(await sys(), io, rest);
        if (command === 'brief') return await brief(await sys(), io, rest);
        if (command === 'cubic-dismiss') return cubicDismiss(await sys(), io, rest);
        if (command === 'owner-step') return await ownerStep(await sys(), io, rest);
        if (command === 'review-thread') return await reviewThread(await sys(), io, rest);
        if (command === 'propose') {
          const { numbers, page } = proposeArgs(rest);
          return await propose(await sys(), io, numbers, page);
        }
        if (command === 'reviews-due') return await reviewsDue(await sys(), io);
        if (command === 'decisions-weekly') return await decisionsWeekly(await sys(), io);
        if (command === 'needs-owner') return await needsOwner(await sys(), io);
        if (command === 'issue-type') return await issueType(await sys(), io);
        if (command === 'pr-design') return await prDesign(await sys(), io);
        if (command === 'pr-identity') return await prIdentity(await sys(), io);
        if (command === 'pr-work-rules') return await prWorkRules(await sys(), io);
        if (command === 'pr-merged') return await prMerged(await sys(), io);
        if (command === 'pr-started') return await prStarted(await sys(), io);
        if (command === 'pre-push') {
          const real = await sys();
          // git runs the hook with the remote's name, then its URL.
          return await prePush(real, io, real.readStdin(), rest[1] ?? '', rest[0] ?? '');
        }
        if (command === 'onboard') return await onboard(await sys(), io, rest);
        if (command === 'machine') return await machine(await sys(), io, rest);
        if (command === 'cloud-key') return await cloudKey(await sys(), io, rest);
        return await doctor(await sys(), io, rest[0]);
      } catch (error) {
        io.err(`niyam ${command}: ${error instanceof Error ? error.message : String(error)}`);
        return 1;
      }
    default:
      io.err(`niyam: unknown command "${command}"`);
      io.err(USAGE);
      return 2;
  }
}
