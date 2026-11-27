#!/usr/bin/env node
// Run by `pnpm install` (the prepare script): points git at the tracked hooks
// in .githooks, which run dvara's gates and niyam's pre-push.
//
// git's core.hooksPath is one setting for every worktree of a clone, so only
// the main checkout's install sets it; a worktree's install leaves it alone,
// and the hooks stay dormant until the main checkout installs. CI sets
// nothing. A hooksPath someone else set is theirs: it is left as it is, with
// a note saying what to add.
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const HOOKS = '.githooks';

/**
 * @typedef {(args: string[]) => string | undefined} Git runs git in the
 * checkout, giving its trimmed output, or undefined when git fails.
 */

/**
 * What to do about core.hooksPath here, and why.
 * @param {Git} git
 * @param {Record<string, string | undefined>} env
 * @returns {{ set: boolean, say: string }}
 */
export function decide(git, env) {
  if (env.CI) return { set: false, say: '' };
  const gitDir = git(['rev-parse', '--path-format=absolute', '--git-dir']);
  const commonDir = git(['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (gitDir === undefined || commonDir === undefined) return { set: false, say: '' };
  if (resolve(gitDir) !== resolve(commonDir)) return { set: false, say: '' };
  const current = git(['config', '--local', '--get', 'core.hooksPath']);
  if (current === HOOKS) return { set: false, say: '' };
  if (current !== undefined && current !== '') {
    return {
      set: false,
      say: `hooks-path: core.hooksPath is ${current}, so git does not run ${HOOKS}/; point it at ${HOOKS} to run dvara's gates and niyam's pre-push`,
    };
  }
  return { set: true, say: `hooks-path: git now runs the hooks in ${HOOKS}/ (dvara's gates, then niyam's pre-push)` };
}

/**
 * Git's stdout, trimmed, or undefined when it fails, cannot start or runs
 * past 10 s; its stderr is read and dropped, as `pnpm install` should not
 * print git's complaints about a checkout that is no git repository.
 * @type {Git}
 */
export function realGit(args) {
  const run = spawnSync('git', args, { encoding: 'utf8', timeout: 10_000 });
  return run.status === 0 ? run.stdout.trim() : undefined;
}

/**
 * @param {Git} git
 * @param {Record<string, string | undefined>} env
 * @param {(line: string) => void} say
 * @returns {number}
 */
export function main(git, env, say) {
  const plan = decide(git, env);
  if (plan.set && git(['config', '--local', 'core.hooksPath', HOOKS]) === undefined) {
    say(`hooks-path: git config refused to set core.hooksPath to ${HOOKS}`);
    return 1;
  }
  if (plan.say !== '') say(plan.say);
  return 0;
}

/** @param {string} line */
export function toStderr(line) {
  console.error(line);
}

/**
 * main's exit code where `argv` runs the file at `url`, as `pnpm install`
 * does; undefined where something imported it.
 * @param {string[]} argv @param {string} url @param {Git} git
 * @param {Record<string, string | undefined>} env @param {(line: string) => void} say
 * @returns {number | undefined}
 */
export function entry(argv, url, git, env, say) {
  return argv[1] && url === pathToFileURL(argv[1]).href ? main(git, env, say) : undefined;
}

// Imported, entry gives undefined, and the importer's exit code stands.
process.exitCode = entry(process.argv, import.meta.url, realGit, process.env, toStderr) ?? process.exitCode;
