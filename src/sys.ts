import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import {
  appendFileSync,
  closeSync,
  existsSync,
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  type Stats,
  writeFileSync,
} from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { constants, homedir, tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { createInterface as askFrom } from 'node:readline/promises';
import { createInterface } from 'node:readline';
import { isatty } from 'node:tty';

import { CLI } from './names.ts';
import type { Sys } from './types.ts';

/** The prompts library's parts the terminal methods use. */
type Prompts = Pick<typeof import('@clack/prompts'), 'confirm' | 'spinner'>;

/** Loads the prompts library, only when a prompt or spinner needs it: the shared checks run the CLI from its source with no packages installed. */
export function loadPrompts(): Promise<Prompts> {
  return import('@clack/prompts');
}

/** The machine's own calls realSys makes; a test hands in its own to see what it is given. */
interface Calls {
  spawn: typeof spawn;
  spawnSync: typeof spawnSync;
  isatty: (fd: number) => boolean;
  readFileSync: typeof readFileSync;
  openSync: typeof openSync;
  closeSync: typeof closeSync;
  writeFileSync: typeof writeFileSync;
  fchmodSync: typeof fchmodSync;
  fsyncSync: typeof fsyncSync;
  renameSync: typeof renameSync;
  prompts: () => Promise<Prompts>;
  proxy: (env: NodeJS.ProcessEnv) => void;
}

const CALLS: Calls = { spawn, spawnSync, isatty, readFileSync, openSync, closeSync, writeFileSync, fchmodSync, fsyncSync, renameSync, prompts: loadPrompts, proxy: useProxy };

/**
 * What realSys reaches the machine through: any of its calls, and the terminal's streams, which stay unopened
 * until a prompt needs them (process.stdin opens the stream, which could make a read of standard input fail).
 */
export type Machine = Partial<Calls> & { stdin?: NodeJS.ReadStream; stdout?: NodeJS.WriteStream };

/** The one address serve listens on and reads requests against. */
const LOOPBACK = '127.0.0.1';

/** The real machine: processes, files, the terminal and GitHub's REST API. */
export function realSys(machine: Machine = {}): Sys {
  const m: Calls = { ...CALLS, ...machine };
  const stdin = (): NodeJS.ReadStream => machine.stdin ?? process.stdin;
  const stdout = (): NodeJS.WriteStream => machine.stdout ?? process.stdout;
  m.proxy(process.env);
  return {
    env: process.env,
    home: homedir(),
    cwd: process.cwd(),
    runtime: { node: realPath(process.execPath), cli: realPath(process.argv[1]) },
    platform: process.platform,
    exec(command, args, options = {}) {
      const result = m.spawnSync(command, args, {
        encoding: 'utf8',
        cwd: options.cwd,
        env: options.env ?? process.env,
        input: options.input,
        timeout: options.timeoutMs,
        ...(options.interactive ? { stdio: 'inherit' as const } : {}),
      });
      return {
        code: result.status ?? exitCode(result),
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? (result.error ? String(result.error) : ''),
      };
    },
    exists: (path) => existsSync(path),
    read: (path) => readFileSync(path, 'utf8'),
    write(path, data, mode) {
      const fd = m.openSync(path, 'w', mode);
      try {
        // A file already there keeps its own mode when opened, so the mode is set on it as well.
        if (mode !== undefined) m.fchmodSync(fd, mode);
        m.writeFileSync(fd, data);
      } finally {
        m.closeSync(fd);
      }
    },
    append: (path, data) => appendFileSync(path, data),
    mkdir: (path) => mkdirSync(path, { recursive: true, mode: 0o700 }),
    confine: (root, path) => confine(root, path),
    list: (path) => (existsSync(path) ? readdirSync(path) : []),
    tempDir: (prefix) => mkdtempSync(prefix ?? join(tmpdir(), `${CLI}-`)),
    remove: (path) => rmSync(path, { recursive: true, force: true }),
    claim(path) {
      try {
        closeSync(openSync(path, 'wx'));
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
        throw error;
      }
    },
    modified(path) {
      let stats: Stats;
      try {
        stats = statSync(path);
      } catch {
        return undefined;
      }
      return stats.mtime;
    },
    replace(path, data) {
      const temp = `${path}.${process.pid}.tmp`;
      const fd = m.openSync(temp, 'w');
      try {
        m.writeFileSync(fd, data);
        m.fsyncSync(fd);
      } finally {
        m.closeSync(fd);
      }
      m.renameSync(temp, path);
    },
    detach(command, args, options) {
      const log = m.openSync(options.log, 'a');
      try {
        const child = m.spawn(command, args, { cwd: options.cwd, env: options.env ?? process.env, detached: true, stdio: ['ignore', log, log] });
        // A command that cannot start says so later, as an event; it must not end this process.
        child.on('error', () => undefined);
        child.unref();
      } finally {
        m.closeSync(log);
      }
    },
    async http(url, options = {}) {
      const method = (options.method ?? 'GET').toUpperCase();
      // One deadline for the call, a repeat included, so timeoutMs bounds all of it.
      const signal = options.timeoutMs !== undefined ? AbortSignal.timeout(options.timeoutMs) : undefined;
      const request = async (): Promise<{ response: Response; text: string }> => {
        const response = await fetch(url, {
          method,
          headers: {
            accept: 'application/vnd.github+json',
            'x-github-api-version': '2022-11-28',
            ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
            ...(options.body ? { 'content-type': 'application/json' } : {}),
            ...options.headers,
          },
          ...(options.body ? { body: JSON.stringify(options.body) } : {}),
          ...(signal ? { signal } : {}),
        });
        return { response, text: await response.text() };
      };
      let got: { response: Response; text: string };
      try {
        got = await request();
      } catch (error) {
        // A timeout keeps its own error, which callers name; a request that can be repeated safely is tried once more.
        if (isTimeout(error)) throw error;
        if (!REPEATABLE.has(method)) throw notMade(method, url, error);
        // The wait ends early when the deadline passes, and the repeat then stops with its TimeoutError.
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, RETRY_MS);
          signal?.addEventListener('abort', () => (clearTimeout(timer), resolve()));
        });
        try {
          got = await request();
        } catch (again) {
          throw isTimeout(again) ? again : notMade(method, url, again);
        }
      }
      const { response, text } = got;
      return {
        status: response.status,
        // A text read, such as a job's log, is not JSON.
        json: options.text || !text ? null : JSON.parse(text),
        ...(options.text ? { text } : {}),
        headers: Object.fromEntries(response.headers),
      };
    },
    // isatty(0), not process.stdin, which would open the stream and could make the read fail.
    readStdin: () => (m.isatty(0) ? '' : m.readFileSync(0, 'utf8')),
    async ask(question) {
      const rl = askFrom({ input: stdin(), output: stdout() });
      try {
        return await rl.question(question);
      } finally {
        rl.close();
      }
    },
    askSecret: (question) => readHidden(question, stdin(), stdout()),
    tty: m.isatty(0) && m.isatty(1),
    async choose(question) {
      const { confirm } = await m.prompts();
      return (await confirm({ message: question, active: 'Yes', inactive: 'No', initialValue: true })) === true;
    },
    spin(label) {
      if (!m.isatty(1)) return { stop() {} };
      let stopped = false;
      let shown: { clear(): void } | undefined;
      void m.prompts().then(({ spinner }) => {
        if (stopped) return;
        const one = spinner({ indicator: 'dots' });
        one.start(label);
        shown = one;
      });
      return {
        stop() {
          stopped = true;
          shown?.clear();
        },
      };
    },
    converse(command, args, options, line) {
      return new Promise((resolve) => {
        const child = m.spawn(command, args, { cwd: options.cwd, env: options.env ?? process.env, stdio: ['inherit', 'pipe', 'pipe'] });
        for (const stream of [child.stdout, child.stderr]) createInterface({ input: stream }).on('line', line);
        child.on('error', (error: NodeJS.ErrnoException) => resolve(error.code === 'ENOENT' ? 127 : 126));
        child.on('close', (code, signal) => resolve(code ?? 128 + (signal ? (constants.signals[signal] ?? 0) : 0)));
      });
    },
    open(url) {
      m.spawnSync('open', [url]);
    },
    async serve(handle) {
      const server = http.createServer((request, response) => {
        const answer = (status: number, headers: Record<string, string> = {}, body = ''): void => {
          response.writeHead(status, { 'cache-control': 'no-store', ...headers });
          response.end(body);
        };
        if (request.method !== 'GET') return answer(405, { allow: 'GET' });
        // A server's request always has its url.
        const url = new URL(String(request.url), `http://${LOOPBACK}`);
        handle({ path: url.pathname, query: Object.fromEntries(url.searchParams) }).then(
          ({ status, headers, body }) => answer(status, headers, body),
          () => answer(500),
        );
      });
      // once() rejects when the server reports an error instead.
      server.listen(0, LOOPBACK);
      await once(server, 'listening');
      const { port } = server.address() as AddressInfo;
      return {
        port,
        close() {
          server.closeAllConnections();
          server.close();
        },
      };
    },
    onInterrupt(handler) {
      process.on('SIGINT', handler);
      return () => {
        process.off('SIGINT', handler);
      };
    },
    now: () => new Date(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

/**
 * Behind a proxy, such as a Claude cloud session's GitHub proxy, GitHub is reached through it, as gh and git
 * reach it. Node's own types do not name the call yet, and a Node without it reaches GitHub directly.
 */
export function useProxy(env: NodeJS.ProcessEnv, net: { setGlobalProxyFromEnv?: () => void } = http as { setGlobalProxyFromEnv?: () => void }): void {
  if (env.HTTPS_PROXY || env.https_proxy) net.setGlobalProxyFromEnv?.();
}

/** Methods a request can be repeated with after a network failure, since repeating one changes nothing more. */
const REPEATABLE = new Set(['GET', 'PUT', 'DELETE']);

/** How long to wait before trying such a request again. */
export const RETRY_MS = 1000;

/** Whether fetch gave up at its deadline. */
export function isTimeout(error: unknown): boolean {
  return (error as { name?: unknown } | null)?.name === 'TimeoutError';
}

/**
 * Why a request got no answer, naming the request by method, host and path, never its query, and giving the
 * reason that fetch's own "fetch failed" holds in its cause, such as "ECONNRESET (other side closed)".
 */
export function notMade(method: string, url: string, error: unknown): Error {
  let where = 'a request';
  try {
    const parsed = new URL(url);
    where = `${parsed.host}${parsed.pathname}`;
  } catch {
    // A URL fetch could not read is named by nothing more.
  }
  return new Error(`${method} ${where} could not be made: ${reason(error)}`, { cause: error });
}

type Failure = { cause?: unknown; code?: unknown; message?: unknown } | null;

/**
 * The innermost cause of `error`: a cause that is not an object, such as a string, ends the walk, since only an
 * object holds a code and a message. Recursion, not a loop: a broken stop overflows the stack at once.
 */
function innermost(error: Failure): Failure {
  return error && error.cause && typeof error.cause === 'object' ? innermost(error.cause as Failure) : error;
}

/** The innermost cause's code and message, or what there is of them. */
function reason(error: unknown): string {
  const inner = innermost(error as Failure);
  const code = typeof inner?.code === 'string' ? inner.code : '';
  const message = typeof inner?.message === 'string' ? inner.message : '';
  if (code && message && !message.includes(code)) return `${code} (${message})`;
  return message || code || String(error);
}

/** Sys.confine on the real machine. */
export function confine(root: string, path: string): void {
  const top = realpathSync(root);
  const at = nearestPresent(resolve(path));
  let real: string;
  try {
    real = realpathSync(at);
  } catch (error) {
    throw new Error(`refused to write ${path}: ${at} is a link that cannot be followed (${(error as NodeJS.ErrnoException).code ?? String(error)}), so it may lead outside ${top}`);
  }
  if (real !== top && !real.startsWith(top.endsWith(sep) ? top : `${top}${sep}`)) {
    throw new Error(`refused to write ${path}: it leads to ${real}, outside the git toplevel ${top}`);
  }
}

/**
 * The nearest part of the absolute `path` that is there, itself included, by lstat: existsSync follows a link,
 * so one that leads nowhere would read as absent. The filesystem's root ends the search.
 */
export function nearestPresent(path: string, isPresent: (path: string) => boolean = present): string {
  if (isPresent(path)) return path;
  const up = dirname(path);
  // Recursion, not a loop: a broken stop overflows the stack at once instead of spinning.
  return up === path ? path : nearestPresent(up, isPresent);
}

function present(path: string): boolean {
  try {
    lstatSync(path);
  } catch {
    return false;
  }
  return true;
}

/** A path with its links resolved, or as given when it cannot be; none is the empty path, not the working folder realpathSync('') gives. */
export function realPath(path = ''): string {
  try {
    return path && realpathSync(path);
  } catch {
    return path;
  }
}

/** The terminal's streams, as a hidden prompt uses them. */
type Input = Pick<NodeJS.ReadStream, 'isTTY' | 'setRawMode' | 'resume' | 'pause' | 'setEncoding' | 'on' | 'off'>;
type Output = Pick<NodeJS.WriteStream, 'write'>;

/** Reads one line from the terminal `stdin` without echoing it, after writing `question` to `stdout`. */
export function readHidden(question: string, stdin: Input, stdout: Output): Promise<string> {
  if (!stdin.isTTY) {
    return Promise.reject(new Error('a hidden prompt needs a terminal'));
  }
  stdout.write(question);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  let value = '';
  return new Promise((resolve, reject) => {
    const done = (error?: Error): void => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off('data', onData);
      stdout.write('\n');
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk: string): void => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n') return done();
        if (char === '\u0003') return done(new Error('cancelled'));
        if (char === '\u007f') value = value.slice(0, -1);
        else value += char;
      }
    };
    stdin.on('data', onData);
  });
}

/**
 * What a shell would exit with for a command that did not exit itself: 128
 * plus the signal that ended it, 127 when it was not found, 126 when it
 * could not be run, and 1 otherwise.
 */
export function exitCode(result: { signal: NodeJS.Signals | null; error?: Error }): number {
  if (result.signal) return 128 + (constants.signals[result.signal] ?? 0);
  const code = (result.error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT' ? 127 : code === 'EACCES' ? 126 : 1;
}
