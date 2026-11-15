import { lockScript } from './agent.ts';
import { LOCKED } from './as-agent.ts';
import { localIdentity } from './session-start.ts';
import type { Output, Sys } from './types.ts';

/** The arguments of `env`: none, or `-- <command> [args...]` to run under its lines. */
export function envArgs(args: readonly string[]): { command?: string; args: string[] } {
  if (args.length === 0) return { args: [] };
  const [dashes, command, ...rest] = args;
  if (dashes !== '--') throw new Error(`env takes no options; to run a command under it, put -- before the command, not "${dashes}"`);
  if (!command) throw new Error('env needs a command after --');
  return { command, args: rest };
}

/**
 * Runs the lines in $1, then the command after them, in their place.
 * The lines only export and unset variables, and their token command runs
 * here, in the shell, so the token never passes through niyam's output.
 */
export const RUN_UNDER = 'eval "$1" && shift && exec "$@"';

/**
 * For agents run from any tool on a Mac, not only Claude Code
 * (docs/decisions.md, P-68). The shell lines session-start gives a Claude
 * Code session: the GitHub lock, then, when this Mac has the session file
 * `machine` wrote for the repo's agent exactly as it writes it, that file,
 * which replaces the lock with the agent's identity (`localIdentity`). With
 * no command it prints them, for `eval "$(niyam env)"`; with `-- <command>`
 * it runs the command under them through /bin/sh, so a runner started that
 * way never starts without niyam. Either way one line on standard error
 * says which account the shell works as, or why GitHub stays locked out,
 * and the owner's login is never a fallback. The token is never in the
 * output: the session file holds the token store's read command, which the
 * shell runs itself. Printing exits 0 as the agent and LOCKED otherwise;
 * running exits with the command's code, locked or not.
 */
export function env(sys: Sys, io: Output, parsed: ReturnType<typeof envArgs>): number {
  const local = localIdentity(sys);
  const lines = local.script === undefined ? lockScript(sys.home) : `${lockScript(sys.home)}\n${local.script}`;
  if ('reason' in local) {
    io.err(`niyam: GitHub is locked out of this shell: ${local.reason}. Do not work around the lock; ${local.fix}.`);
  } else {
    io.err(`niyam: this shell works as ${local.agent} on GitHub.`);
  }
  if (parsed.command === undefined) {
    io.out(forEval(lines));
    return 'reason' in local ? LOCKED : 0;
  }
  const result = sys.exec('/bin/sh', ['-c', RUN_UNDER, 'niyam env', lines, parsed.command, ...parsed.args], { interactive: true });
  // With standard error passed through, what is left is why the shell could not start.
  if (result.stderr) io.err(`niyam env: ${parsed.command}: ${result.stderr.trim()}`);
  return result.code;
}

/**
 * The lines as `env` prints them: without comments or blank lines, each
 * ended by `;`, so an unquoted `eval $(niyam env)`, whose newlines the shell
 * turns into spaces, runs every one rather than one comment swallowing the
 * rest. Unquoted, a value holding two spaces in a row or a glob character
 * would still change, so the README quotes it; niyam's own values hold none.
 */
export function forEval(lines: string): string {
  return lines
    .split('\n')
    .filter((line) => line.trim() !== '' && !line.startsWith('#'))
    .map((line) => `${line};`)
    .join('\n');
}

/** What `env` prints when its own check fails: the lock alone, so `eval` still locks the shell. */
export function envFailed(home: string, io: Output, parsed: ReturnType<typeof envArgs>, error: unknown): number {
  const why = error instanceof Error ? error.message : String(error);
  if (parsed.command !== undefined) {
    io.err(`niyam env: ran nothing, because the check failed: ${why}`);
    return LOCKED;
  }
  io.err(`niyam: GitHub is locked out of this shell, because the check failed: ${why}`);
  io.out(forEval(lockScript(home)));
  return LOCKED;
}
