/** Where the CLI writes; tests pass their own. */
export interface Output {
  out(line: string): void;
  err(line: string): void;
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface HttpResult {
  status: number;
  json: unknown;
  /** The body as text, when the request asked for text (`text: true`); json is then null. */
  text?: string;
  /** Response headers, names lowercased. */
  headers?: Record<string, string>;
}

/** Everything a command touches outside its own memory; tests pass a fake. */
export interface Sys {
  env: Readonly<Record<string, string | undefined>>;
  home: string;
  cwd: string;
  /** The node running the CLI and the CLI's script, both by their real paths. */
  runtime: { node: string; cli: string };
  /** Node's name for the operating system, such as darwin. */
  platform: string;
  exec(
    command: string,
    args: readonly string[],
    options?: {
      cwd?: string;
      env?: Record<string, string | undefined>;
      input?: string;
      timeoutMs?: number;
      /** The command talks to the person at the terminal; its output is not captured. */
      interactive?: boolean;
    },
  ): ExecResult;
  exists(path: string): boolean;
  read(path: string): string;
  write(path: string, data: string, mode?: number): void;
  append(path: string, data: string): void;
  mkdir(path: string): void;
  /**
   * Throws unless `path` stays under the folder `root` once links are followed: the nearest part of `path` that is
   * there, a link included, must have its real path under `root`'s. A link that leads nowhere is refused too. The
   * error names `path`, where it leads and `root`'s real path. Call it before writing, appending or making a folder
   * at `path`.
   */
  confine(root: string, path: string): void;
  /** The names in a folder, or none when it does not exist. */
  list(path: string): string[];
  /**
   * A new empty folder only this user can read, for the caller to remove:
   * `prefix` and some random letters, a path; without one, in the system's
   * temporary folder.
   */
  tempDir(prefix?: string): string;
  /** Deletes a file or folder and all in it; nothing there is fine. */
  remove(path: string): void;
  /** Creates an empty file only when nothing is at `path`: true when this call made it, false when it was there. */
  claim(path: string): boolean;
  /** When the file at `path` last changed; undefined when there is none. */
  modified(path: string): Date | undefined;
  /** Writes `path` whole or not at all: a crash leaves the old contents or the new ones. */
  replace(path: string, data: string): void;
  /**
   * Starts a command that outlives this process, in its own session, with no
   * standard input and its output appended to the file `log`.
   */
  detach(command: string, args: readonly string[], options: { cwd: string; log: string; env?: Record<string, string | undefined> }): void;
  /**
   * With timeoutMs, rejects with an error named TimeoutError once that long has passed. A request that gets no
   * answer rejects with an error naming its method, host and path and why; GET, PUT and DELETE are tried once
   * more first.
   */
  http(
    url: string,
    options?: { method?: string; token?: string; body?: unknown; headers?: Record<string, string>; timeoutMs?: number; text?: boolean },
  ): Promise<HttpResult>;
  /** Everything on standard input, as a git hook receives it. */
  readStdin(): string;
  ask(question: string): Promise<string>;
  askSecret(question: string): Promise<string>;
  /** Whether a person is at the terminal: standard input and output are both one. */
  tty: boolean;
  /** Asks yes or no at the terminal as a choice, Yes first; false for No, or for a cancel. */
  choose(question: string): Promise<boolean>;
  /** Shows a spinner by `label` on the terminal until stop() takes it off; nothing without a terminal. */
  spin(label: string): { stop(): void };
  /**
   * Runs a command that reads the person at the terminal through standard
   * input, handing each line it prints, from standard output or error, to
   * `line` instead of printing it. Resolves with its exit code.
   */
  converse(
    command: string,
    args: readonly string[],
    options: { cwd?: string; env?: Record<string, string | undefined> },
    line: (text: string) => void,
  ): Promise<number>;
  open(url: string): void;
  /**
   * Calls `handler` at each Ctrl-C (SIGINT) instead of the CLI ending there,
   * until the returned function takes it off.
   */
  onInterrupt(handler: () => void): () => void;
  now(): Date;
  sleep(ms: number): Promise<void>;
}
