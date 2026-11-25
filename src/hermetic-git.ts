import { existsSync, realpathSync, rmSync } from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import { sep } from 'node:path';

/**
 * Removes a test's fixture folder and all in it, once links are followed; refuses any path that is not strictly
 * inside `root`, the system's temporary folder unless a test names its own, so a cleanup can never reach a real
 * checkout. Nothing there is fine.
 */
export function removeFixtureRoot(path: string, root: string = tmpdir()): void {
  if (!existsSync(path)) return;
  const base = realpathSync(root);
  // A filesystem root already ends in the separator.
  const inside = base.endsWith(sep) ? base : base + sep;
  if (!realpathSync(path).startsWith(inside)) throw new Error(`refusing to remove ${path}: it is not inside ${root}`);
  rmSync(path, { recursive: true });
}

/**
 * git without the caller's repository or configuration, for tests that build git fixtures: under a git hook the
 * environment carries GIT_DIR and GIT_INDEX_FILE, so a child that inherited them would read and write the hook's
 * repository instead of the fixture, and the machine's global config (hooks, trace targets) would reach it.
 */
const HERMETIC = { GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' } as const;

/** `env` (the process's own by default) without any GIT_ variable, and with no global or system config. */
export function hermeticGitEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith('GIT_'))), ...HERMETIC };
}

/** The same for this process itself, whose git children (the code under test) inherit its environment. */
export function maskProcessGitEnv(env: NodeJS.ProcessEnv = process.env): void {
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) Reflect.deleteProperty(env, key);
  Object.assign(env, HERMETIC);
}
