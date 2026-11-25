import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { chmodSync, closeSync, fsyncSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { type AddressInfo, connect } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { exitCode, isTimeout, loadPrompts, nearestPresent, notMade, readHidden, realPath, realSys, RETRY_MS, useProxy } from './sys.ts';

/** `promise`, or a failure after `ms`: a broken wait fails the test at once instead of hanging the run. */
function within<T>(ms: number, promise: Promise<T>): Promise<T> {
  // Held until the race settles, so a wait with nothing else keeping the process alive still fails by its deadline.
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, fail) => {
    timer = setTimeout(() => fail(new Error(`no answer within ${ms} ms`)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

describe('realSys', () => {
  const sys = realSys();

  it('sets up the proxy from its environment as it starts', () => {
    const seen: unknown[] = [];
    realSys({ proxy: (env) => seen.push(env) });
    assert.deepEqual(seen, [process.env]);
    assert.equal(seen[0], process.env);
  });
  const dir = mkdtempSync(join(tmpdir(), 'process-rules-sys-'));
  after(() => rmSync(dir, { recursive: true, force: true }));

  it('runs a command with its own env, cwd and stdin', () => {
    assert.deepEqual(
      sys.exec('sh', ['-c', 'printf "%s %s " "$X" "$(pwd -P)"; cat'], {
        cwd: dir,
        env: { PATH: process.env.PATH, X: 'x' },
        input: 'in',
      }),
      { code: 0, stdout: `x ${realpathSync(dir)} in`, stderr: '' },
    );
  });

  it('reports a failing or missing command', () => {
    assert.equal(sys.exec('sh', ['-c', 'echo e >&2; exit 3']).code, 3);
    const missing = sys.exec('/no/such/command', []);
    assert.equal(missing.code, 127);
    assert.match(missing.stderr, /ENOENT/);
  });

  it('gives an interactive command the terminal and its exit code, as a shell would', () => {
    assert.deepEqual(sys.exec('sh', ['-c', 'exit 5'], { interactive: true }), { code: 5, stdout: '', stderr: '' });
    assert.equal(sys.exec('sh', ['-c', 'kill -TERM $$'], { interactive: true }).code, 143);
    assert.equal(sys.exec('/no/such/command', [], { interactive: true }).code, 127);
  });

  it('reads and writes files, private when asked', () => {
    const nested = join(dir, 'a', 'b');
    sys.mkdir(nested);
    const path = join(nested, 'f');
    assert.equal(sys.exists(path), false);
    sys.write(path, 'data', 0o600);
    assert.equal(sys.read(path), 'data');
    assert.equal(statSync(path).mode & 0o777, 0o600);
    sys.append(path, '+more');
    assert.equal(sys.read(path), 'data+more');
    sys.write(join(dir, 'g'), 'plain');
    assert.equal(sys.read(join(dir, 'g')), 'plain');
    // A file already there gets the mode too, which opening it alone would not give.
    const shared = join(dir, 'shared');
    writeFileSync(shared, 'old', { mode: 0o644 });
    chmodSync(shared, 0o644);
    sys.write(shared, 'secret', 0o600);
    assert.deepEqual([sys.read(shared), statSync(shared).mode & 0o777], ['secret', 0o600]);
  });

  it('closes each file it opens to write, replace or log to', () => {
    const opened: number[] = [];
    const closed: number[] = [];
    const calls: string[] = [];
    const child = { on: (event: string) => calls.push(`on ${event}`), unref: () => calls.push('unref') };
    const spawned: Record<string, unknown>[] = [];
    const seen = realSys({
      openSync: ((...args: Parameters<typeof openSync>) => {
        const fd = openSync(...args);
        opened.push(fd);
        calls.push('open');
        return fd;
      }) as typeof openSync,
      closeSync: (fd) => {
        closed.push(fd);
        calls.push('close');
        closeSync(fd);
      },
      writeFileSync: ((...args: Parameters<typeof writeFileSync>) => {
        calls.push('write');
        writeFileSync(...args);
      }) as typeof writeFileSync,
      fsyncSync: (fd) => {
        calls.push('fsync');
        fsyncSync(fd);
      },
      renameSync: (from, to) => {
        calls.push('rename');
        renameSync(from, to);
      },
      spawn: ((...args: unknown[]) => {
        calls.push(`spawn ${JSON.stringify(args.slice(0, 2))}`);
        spawned.push(args[2] as Record<string, unknown>);
        return child;
      }) as unknown as typeof import('node:child_process').spawn,
    });
    seen.write(join(dir, 'w'), 'w');
    assert.deepEqual(calls.splice(0), ['open', 'write', 'close']);
    seen.replace(join(dir, 'r'), 'r');
    assert.deepEqual(calls.splice(0), ['open', 'write', 'fsync', 'close', 'rename'], 'synced before it is closed and put in place');
    assert.equal(seen.read(join(dir, 'r')), 'r');
    seen.detach('cmd', ['a'], { cwd: dir, log: join(dir, 'd.log'), env: { X: 'x' } });
    seen.detach('cmd', ['a'], { cwd: dir, log: join(dir, 'd.log') });
    assert.deepEqual(calls.splice(0), ['open', 'spawn ["cmd",["a"]]', 'on error', 'unref', 'close', 'open', 'spawn ["cmd",["a"]]', 'on error', 'unref', 'close']);
    const log = opened.at(-1);
    assert.deepEqual(spawned[0], { cwd: dir, env: { X: 'x' }, detached: true, stdio: ['ignore', opened.at(-2), opened.at(-2)] });
    assert.equal(spawned[1]?.env, process.env);
    assert.deepEqual((spawned[1]?.stdio as unknown[])[1], log);
    assert.deepEqual(closed, opened);
  });

  it('lists a folder, and nothing for one that is not there', () => {
    sys.mkdir(join(dir, 'listed'));
    writeFileSync(join(dir, 'listed', 'one'), '');
    assert.deepEqual(sys.list(join(dir, 'listed')), ['one']);
    assert.deepEqual(sys.list(join(dir, 'not-there')), []);
  });

  it('claims a file only once, says when it changed, and replaces one whole', () => {
    const lock = join(dir, 'lock');
    assert.equal(sys.claim(lock), true);
    assert.equal(sys.claim(lock), false);
    assert.throws(() => sys.claim(join(dir, 'no', 'such', 'lock')), /ENOENT/);
    assert.ok((sys.modified(lock)?.getTime() ?? 0) > Date.now() - 60_000);
    assert.equal(sys.modified(join(dir, 'none')), undefined);
    const record = join(dir, 'record');
    sys.replace(record, 'one\n');
    sys.replace(record, 'two\n');
    assert.equal(sys.read(record), 'two\n');
    assert.throws(() => sys.replace(join(dir, 'no', 'record'), 'x'), /ENOENT/);
    sys.mkdir(join(dir, 'taken'));
    assert.throws(() => sys.replace(join(dir, 'taken'), 'x'));
  });

  it('starts a command that outlives it, its output in the log', async () => {
    const log = join(dir, 'detached.log');
    sys.write(log, 'before\n');
    sys.detach('sh', ['-c', 'echo "out $(pwd -P)"; echo err >&2'], { cwd: dir, log });
    for (let tries = 0; tries < 100 && !/err/.test(sys.read(log)); tries++) await new Promise((done) => setTimeout(done, 20));
    assert.equal(sys.read(log).split('\n').filter(Boolean).sort().join('|'), ['before', 'err', `out ${realpathSync(dir)}`].sort().join('|'));
    assert.throws(() => sys.detach('sh', [], { cwd: dir, log: join(dir, 'no', 'log') }), /ENOENT/);
  });

  it('makes a private temporary folder and removes it with what is in it', () => {
    const temp = sys.tempDir();
    assert.equal(dirname(temp), tmpdir());
    assert.match(basename(temp), /^niyam-\w{6}$/);
    assert.equal(statSync(temp).mode & 0o777, 0o700);
    sys.write(join(temp, 'hosts.yml'), 'token');
    sys.remove(temp);
    assert.equal(sys.exists(temp), false);
    sys.remove(temp);
    const named = sys.tempDir(join(dir, 'niyam-owner-step-'));
    assert.match(named, /\/niyam-owner-step-\w+$/);
    assert.equal(statSync(named).mode & 0o777, 0o700);
  });

  it('serves GETs on 127.0.0.1 alone as the handler answers, until closed', async () => {
    const seen: unknown[] = [];
    const served = await within(2000, sys.serve((request) => {
      seen.push(request);
      if (request.path === '/broken') return Promise.reject(new Error('broken'));
      return Promise.resolve({ status: 302, headers: { location: 'https://example.com/next' }, body: 'moved' });
    }));
    const base = `http://127.0.0.1:${served.port}`;
    try {
      const moved = await within(2000, fetch(`${base}/made?code=c1&state=s1`, { redirect: 'manual' }));
      assert.deepEqual([moved.status, moved.headers.get('location'), moved.headers.get('cache-control'), await moved.text()], [302, 'https://example.com/next', 'no-store', 'moved']);
      assert.deepEqual(seen, [{ path: '/made', query: { code: 'c1', state: 's1' } }]);
      const posted = await within(2000, fetch(`${base}/made`, { method: 'POST' }));
      assert.deepEqual([posted.status, posted.headers.get('allow'), await posted.text()], [405, 'GET', ''], 'a GET alone');
      assert.equal(seen.length, 1, 'a POST never reaches the handler');
      assert.equal((await within(2000, fetch(`${base}/broken`))).status, 500, 'a handler that fails answers 500');
    } finally {
      served.close();
    }
    // A fresh connection, not fetch's pool, whose old socket close() cut anyway: nothing listens there once closed.
    const refused = await within(
      2000,
      new Promise<string>((done) => {
        const socket = connect(served.port, '127.0.0.1');
        socket.once('connect', () => (socket.destroy(), done('connected')));
        socket.once('error', (error: NodeJS.ErrnoException) => done(error.code ?? 'error'));
      }),
    );
    assert.equal(refused, 'ECONNREFUSED', 'nothing serves there once closed');
  });

  it('ends a request still open when it closes', async () => {
    let asked = false;
    const served = await within(
      2000,
      sys.serve(() => {
        asked = true;
        return new Promise(() => {});
      }),
    );
    let pending: Promise<Response> | undefined;
    try {
      // Its own deadline, so a request close() leaves open fails as a timeout rather than hanging.
      pending = fetch(`http://127.0.0.1:${served.port}/hang`, { signal: AbortSignal.timeout(2000) });
      for (let waited = 0; !asked; waited += 5) {
        assert.ok(waited < 2000, 'the handler was asked');
        await new Promise((done) => setTimeout(done, 5));
      }
    } finally {
      served.close();
    }
    await assert.rejects(pending, (error: Error) => error.name !== 'TimeoutError');
  });

  it('fails to serve when the server cannot start, and takes in an error after it has', async () => {
    const failing = Object.assign(new EventEmitter(), { listen: () => failing.emit('error', new Error('EADDRINUSE')) });
    await assert.rejects(within(2000, realSys({ createServer: (() => failing) as unknown as typeof createServer }).serve(() => Promise.reject(new Error('unused')))), /^Error: EADDRINUSE$/);
    const started = Object.assign(new EventEmitter(), {
      listen: (_port: number, _host: string, done: () => void) => done(),
      address: () => ({ port: 4321 }),
      closeAllConnections: () => {},
      close: () => {},
    });
    const served = await within(2000, realSys({ createServer: (() => started) as unknown as typeof createServer }).serve(() => Promise.reject(new Error('unused'))));
    try {
      assert.equal(served.port, 4321);
      assert.doesNotThrow(() => started.emit('error', new Error('later')), 'a later error does not end the process');
    } finally {
      served.close();
    }
  });

  it('leaves a file it could not write as it was, mode and all', () => {
    const kept = join(dir, 'kept');
    writeFileSync(kept, 'old', { mode: 0o644 });
    chmodSync(kept, 0o644);
    const failing = realSys({
      writeFileSync: (() => {
        throw new Error('ENOSPC');
      }) as unknown as typeof writeFileSync,
    });
    assert.throws(() => failing.write(kept, 'new', 0o666), /ENOSPC/);
    assert.equal(statSync(kept).mode & 0o777, 0o644);
  });

  it('calls a Ctrl-C handler instead of ending, until it is taken off', () => {
    const seen: string[] = [];
    const before = process.listeners('SIGINT');
    const off = sys.onInterrupt(() => seen.push('interrupted'));
    // Only the listener onInterrupt added is called: emitting SIGINT would reach every other listener in this
    // process too, such as a test runner's, which may end the process.
    const added = process.listeners('SIGINT').filter((listener) => !before.includes(listener));
    assert.equal(added.length, 1);
    (added[0] as (signal: NodeJS.Signals) => void)('SIGINT');
    assert.deepEqual(seen, ['interrupted']);
    off();
    assert.deepEqual(process.listeners('SIGINT'), before);
  });

  it('leaves an interactive command the terminal, capturing nothing', () => {
    // Written to standard error, which the test runner leaves alone, and not captured.
    assert.deepEqual(sys.exec('sh', ['-c', 'echo shown >&2'], { interactive: true }), { code: 0, stdout: '', stderr: '' });
    assert.match(sys.exec('/no/such/command', [], { interactive: true }).stderr, /ENOENT/);
  });

  it("hands a conversing command's lines from both streams to the caller, with its exit code", async () => {
    const lines: string[] = [];
    const code = await within(
      2000,
      sys.converse('sh', ['-c', 'test "$SEEN" = x || exit 4; echo one; echo two >&2; printf three; exit 3'], { env: { PATH: '/usr/bin:/bin', SEEN: 'x' } }, (line) => lines.push(line)),
    );
    assert.equal(code, 3);
    assert.deepEqual([...lines].sort(), ['one', 'three', 'two']);
    assert.equal(await within(2000, sys.converse('/no/such/command', [], {}, () => {})), 127);
    assert.equal(await within(2000, sys.converse('sh', ['-c', 'kill -TERM $$'], {}, () => {})), 128 + 15);
  });

  it('shows no spinner without a terminal', () => {
    const module = new URL('./sys.ts', import.meta.url).href;
    const shown = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', `const { realSys } = await import(${JSON.stringify(module)}); const one = realSys().spin('working'); await new Promise((r) => setTimeout(r, 300)); one.stop(); one.stop();`],
      { encoding: 'utf8' },
    );
    assert.deepEqual([shown.status, shown.stdout], [0, '']);
  });

  it('knows home, cwd, env, the time and where its node and CLI are', async () => {
    assert.equal(sys.cwd, process.cwd());
    assert.ok(sys.home.length > 0);
    assert.equal(sys.env, process.env);
    assert.ok(sys.now() instanceof Date);
    assert.deepEqual(sys.runtime, { node: realpathSync(process.execPath), cli: realpathSync(process.argv[1] as string) });
    const started = Date.now();
    await within(2000, sys.sleep(30));
    assert.ok(Date.now() - started >= 25);
  });

  it('calls a JSON API with a token and body', async () => {
    const seen: { auth?: string; body: string; method?: string }[] = [];
    const headers: Record<string, string | string[] | undefined>[] = [];
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => (body += chunk.toString()));
      req.on('end', () => {
        headers.push({ accept: req.headers.accept, version: req.headers['x-github-api-version'], type: req.headers['content-type'] });
        seen.push({ ...(req.headers.authorization ? { auth: req.headers.authorization } : {}), body, ...(req.method ? { method: req.method } : {}) });
        res.statusCode = req.url === '/empty' ? 204 : req.url === '/log' ? 200 : 201;
        res.setHeader('X-OAuth-Scopes', 'repo, workflow');
        res.end(req.url === '/empty' ? '' : req.url === '/log' ? 'step 1\nerror: no' : '{"ok":true}');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const posted = await sys.http(`${base}/x`, { method: 'POST', token: 't', body: { a: 1 } });
      assert.deepEqual([posted.status, posted.json, posted.headers?.['x-oauth-scopes']], [201, { ok: true }, 'repo, workflow']);
      const empty = await sys.http(`${base}/empty`);
      assert.deepEqual([empty.status, empty.json], [204, null]);
      const log = await sys.http(`${base}/log`, { token: 't', text: true });
      assert.deepEqual([log.status, log.json, log.text], [200, null, 'step 1\nerror: no']);
      assert.equal((await sys.http(`${base}/x`)).text, undefined);
      assert.deepEqual(seen, [
        { auth: 'Bearer t', body: '{"a":1}', method: 'POST' },
        { body: '', method: 'GET' },
        { auth: 'Bearer t', body: '', method: 'GET' },
        { body: '', method: 'GET' },
      ]);
      const github = { accept: 'application/vnd.github+json', version: '2022-11-28' };
      assert.deepEqual(headers, [{ ...github, type: 'application/json' }, { ...github, type: undefined }, { ...github, type: undefined }, { ...github, type: undefined }], 'a JSON body alone says it is JSON');
    } finally {
      server.close();
    }
  });

  /** A local server that cuts the connection for the first `drops` requests, then answers; and how many it saw. */
  async function flaky(drops: number, hang = false): Promise<{ base: string; seen: () => number; close: () => void }> {
    let count = 0;
    const server = createServer((req, res) => {
      count++;
      if (hang) return;
      if (count <= drops) {
        req.socket.destroy();
        return;
      }
      res.end('{"ok":true}');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return {
      base,
      seen: () => count,
      close: () => {
        server.closeAllConnections();
        server.close();
      },
    };
  }

  it('tries a GET, PUT or DELETE once more after a network failure', async () => {
    for (const method of ['GET', 'PUT', 'DELETE']) {
      const server = await flaky(1);
      try {
        const got = await sys.http(`${server.base}/x`, { method, ...(method === 'PUT' ? { body: { a: 1 } } : {}) });
        assert.deepEqual([got.status, got.json, server.seen()], [200, { ok: true }, 2], method);
      } finally {
        server.close();
      }
    }
  });

  it('says which request got no answer and why, never just "fetch failed" and never its query', async () => {
    const server = await flaky(2);
    try {
      await assert.rejects(sys.http(`${server.base}/repos/x/y/actions/secrets/public-key?token=hidden`, { token: 't' }), (error: Error) => {
        assert.match(error.message, /^GET 127\.0\.0\.1:\d+\/repos\/x\/y\/actions\/secrets\/public-key could not be made: \S/);
        assert.ok(!error.message.includes('hidden') && !error.message.includes('fetch failed'), error.message);
        return true;
      });
      assert.equal(server.seen(), 2);
    } finally {
      server.close();
    }
  });

  it('never repeats a POST or PATCH', async () => {
    for (const method of ['POST', 'PATCH']) {
      const server = await flaky(1);
      try {
        await assert.rejects(sys.http(`${server.base}/x`, { method, body: { a: 1 } }), new RegExp(`^Error: ${method} 127\\.0\\.0\\.1:\\d+/x could not be made: `));
        assert.equal(server.seen(), 1, method);
      } finally {
        server.close();
      }
    }
  });

  it('names a refused connection by its code', async () => {
    const server = await flaky(0);
    const { base } = server;
    server.close();
    await assert.rejects(sys.http(`${base}/x`, { method: 'POST' }), /^Error: POST 127\.0\.0\.1:\d+\/x could not be made: .*ECONNREFUSED/);
  });

  it('names a URL it cannot read by nothing more', async () => {
    await assert.rejects(sys.http('not a url?token=hidden', { method: 'POST' }), /^Error: POST a request could not be made: (?!.*hidden)/);
  });

  it('keeps one deadline for both tries', async () => {
    const server = await flaky(1);
    try {
      const started = Date.now();
      await assert.rejects(within(2000, sys.http(`${server.base}/x`, { timeoutMs: 200 })), { name: 'TimeoutError' });
      assert.ok(Date.now() - started < 900, 'the repeat waits no longer than what is left of the deadline');
      assert.equal(server.seen(), 1);
    } finally {
      server.close();
    }
  });

  it('keeps a timeout as a TimeoutError, tried once', async () => {
    const server = await flaky(0, true);
    try {
      const started = Date.now();
      await assert.rejects(within(2000, sys.http(`${server.base}/x`, { timeoutMs: 50 })), { name: 'TimeoutError' });
      assert.ok(Date.now() - started < RETRY_MS, 'never waits to try again');
      assert.equal(server.seen(), 1);
    } finally {
      server.close();
    }
  });

  it('refuses a hidden prompt without a terminal', async () => {
    if (process.stdin.isTTY) return;
    await assert.rejects(sys.askSecret('token: '), /needs a terminal/);
  });

  it('asks a question on the terminal', () => {
    const module = fileURLToPath(new URL('./sys.ts', import.meta.url));
    const result = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', `const { realSys } = await import(${JSON.stringify(module)}); console.log('got', await realSys().ask('q? '));`],
      { input: 'yes\n', encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'q? got yes\n');
  });
});

describe('realSys at a terminal, as a test hands it one', () => {
  /** A prompts library that records what it was asked, and answers `answer`. */
  function prompts(answer: unknown = true) {
    const seen: unknown[] = [];
    const spinners: { options: unknown; started?: string; cleared: number }[] = [];
    return {
      seen,
      spinners,
      load: () =>
        Promise.resolve({
          confirm: (options: unknown) => (seen.push(options), Promise.resolve(answer)),
          spinner: (options: unknown) => {
            const one = { options, cleared: 0 } as (typeof spinners)[number];
            spinners.push(one);
            return { start: (label: string) => void (one.started = label), clear: () => void (one.cleared += 1) };
          },
        }) as unknown as ReturnType<typeof loadPrompts>,
    };
  }
  const tick = () => new Promise((done) => setImmediate(done));

  it('is at a terminal only when standard input and output both are one', () => {
    assert.equal(realSys({ isatty: () => true }).tty, true);
    assert.equal(realSys({ isatty: (fd) => fd === 0 }).tty, false);
    assert.equal(realSys({ isatty: (fd) => fd === 1 }).tty, false);
  });

  it('reads standard input whole unless it is the terminal', () => {
    const asked: unknown[] = [];
    const read = ((...args: unknown[]) => (asked.push(args), 'piped')) as unknown as typeof readFileSync;
    assert.equal(realSys({ isatty: () => true, readFileSync: read }).readStdin(), '');
    assert.equal(realSys({ isatty: () => false, readFileSync: read }).readStdin(), 'piped');
    assert.deepEqual(asked, [[0, 'utf8']]);
  });

  it('asks Yes or No, Yes first, and takes only a Yes as yes', async () => {
    const yes = prompts(true);
    assert.equal(await realSys({ prompts: yes.load }).choose('go on?'), true);
    assert.deepEqual(yes.seen, [{ message: 'go on?', active: 'Yes', inactive: 'No', initialValue: true }]);
    assert.equal(await realSys({ prompts: prompts(false).load }).choose('go on?'), false);
    assert.equal(await realSys({ prompts: prompts(Symbol('cancel')).load }).choose('go on?'), false);
  });

  it('shows a spinner at a terminal until stopped, and none before it loads or without one', async () => {
    const shown = prompts();
    const one = realSys({ isatty: () => true, prompts: shown.load }).spin('working');
    try {
      await tick();
      assert.deepEqual(shown.spinners, [{ options: { indicator: 'dots' }, started: 'working', cleared: 0 }]);
    } finally {
      one.stop();
    }
    assert.equal(shown.spinners[0]?.cleared, 1);
    const early = prompts();
    realSys({ isatty: () => true, prompts: early.load }).spin('working').stop();
    await tick();
    assert.deepEqual(early.spinners, [], 'stopped before the library loaded, so never shown');
    const none = prompts();
    realSys({ isatty: () => false, prompts: none.load }).spin('working').stop();
    await tick();
    assert.deepEqual(none.spinners, []);
  });

  it('loads the real prompts library', async () => {
    const loaded = await loadPrompts();
    assert.equal(typeof loaded.confirm, 'function');
    assert.equal(typeof loaded.spinner, 'function');
  });

  it('asks a question on the streams it is given, and lets go of them', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let written = '';
    output.on('data', (chunk: Buffer) => (written += chunk.toString()));
    const answer = realSys({ stdin: input as unknown as NodeJS.ReadStream, stdout: output as unknown as NodeJS.WriteStream }).ask('q? ');
    input.write('yes\n');
    assert.equal(await within(2000, answer), 'yes');
    assert.equal(written, 'q? ');
    assert.equal(input.listenerCount('data'), 0);
  });

  /** A terminal's standard input that records what was done to it, fed by `type`. */
  function terminal(isTTY = true) {
    const done: string[] = [];
    let listener: ((chunk: string) => void) | undefined;
    const stdin = {
      isTTY,
      setRawMode: (on: boolean) => done.push(`raw ${on}`),
      resume: () => done.push('resume'),
      pause: () => done.push('pause'),
      setEncoding: (encoding: string) => done.push(`encoding ${encoding}`),
      on: (event: string, handler: (chunk: string) => void) => (done.push(`on ${event}`), (listener = handler)),
      off: (event: string, handler: unknown) => done.push(`off ${event} ${handler === listener}`),
    };
    let written = '';
    const stdout = { write: (text: string) => ((written += text), true) };
    return { stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream, done, type: (chunk: string) => listener?.(chunk), written: () => written };
  }

  it('reads a hidden line, a backspace taking off the last letter, and gives the terminal back', async () => {
    const at = terminal();
    const secret = realSys({ stdin: at.stdin, stdout: at.stdout }).askSecret('token: ');
    at.type('abcd\u007f');
    at.type('e\rignored');
    assert.equal(await within(2000, secret), 'abce');
    assert.equal(at.written(), 'token: \n');
    assert.deepEqual(at.done, ['raw true', 'resume', 'encoding utf8', 'on data', 'raw false', 'pause', 'off data true']);
  });

  it('ends a hidden line at a newline too, and a Ctrl-C cancels it', async () => {
    const line = terminal();
    const secret = readHidden('t: ', line.stdin, line.stdout);
    line.type('xy\n');
    assert.equal(await within(2000, secret), 'xy');
    const cancelled = terminal();
    const stopped = readHidden('t: ', cancelled.stdin, cancelled.stdout);
    cancelled.type('x\u0003');
    await assert.rejects(within(2000, stopped), /^Error: cancelled$/);
    assert.equal(cancelled.written(), 't: \n');
    assert.deepEqual(cancelled.done.slice(-3), ['raw false', 'pause', 'off data true']);
  });

  it('refuses a hidden prompt without a terminal, touching nothing', async () => {
    const none = terminal(false);
    await assert.rejects(readHidden('t: ', none.stdin, none.stdout), /^Error: a hidden prompt needs a terminal$/);
    assert.deepEqual([none.done, none.written()], [[], '']);
  });

  it('opens a link with the system opener', () => {
    const ran: unknown[] = [];
    realSys({ spawnSync: ((...args: unknown[]) => ran.push(args)) as unknown as typeof spawnSync }).open('https://example.com/x');
    assert.deepEqual(ran, [['open', ['https://example.com/x']]]);
  });

  it("gives a conversing command the terminal's input and pipes its output", async () => {
    const given: unknown[] = [];
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
    const sys = realSys({ spawn: ((...args: unknown[]) => (given.push(args[2]), child)) as unknown as typeof spawn });
    const code = sys.converse('cmd', [], { cwd: '/w' }, () => {});
    child.emit('close', 0, null);
    assert.equal(await within(2000, code), 0);
    assert.deepEqual(given, [{ cwd: '/w', env: process.env, stdio: ['inherit', 'pipe', 'pipe'] }]);
  });

  it('says 126 for a conversing command that cannot be run', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'niyam-converse-'));
    try {
      const script = join(dir, 'not-executable');
      writeFileSync(script, '#!/bin/sh\n', { mode: 0o644 });
      assert.equal(await within(2000, realSys().converse(script, [], {}, () => {})), 126);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the machine helpers', () => {
  it('turns the proxy on only when one is set, and on a Node that has the call', () => {
    let calls = 0;
    const net = { setGlobalProxyFromEnv: () => void (calls += 1) };
    useProxy({ HTTPS_PROXY: 'http://proxy' }, net);
    useProxy({ https_proxy: 'http://proxy' }, net);
    useProxy({}, net);
    assert.equal(calls, 2);
    useProxy({ HTTPS_PROXY: 'http://proxy' }, {});
  });

  it('knows a timeout by its name alone', () => {
    assert.equal(isTimeout(Object.assign(new Error('late'), { name: 'TimeoutError' })), true);
    assert.equal(isTimeout(new Error('late')), false);
    assert.equal(isTimeout(null), false);
    assert.equal(isTimeout(undefined), false);
  });

  it("gives the innermost cause's code and message, or what there is of them", () => {
    const why = (error: unknown) => notMade('GET', 'https://api.github.com/x?token=t', error).message.replace('GET api.github.com/x could not be made: ', '');
    const deep = new Error('fetch failed', { cause: new Error('outer', { cause: Object.assign(new Error('other side closed'), { code: 'ECONNRESET' }) }) });
    assert.equal(why(deep), 'ECONNRESET (other side closed)');
    assert.equal(why({ code: 'E1', message: 'E1: already said' }), 'E1: already said');
    assert.equal(why({ code: 'E1' }), 'E1');
    assert.equal(why({ message: 'only this' }), 'only this');
    assert.equal(why({ code: 5, message: 'a number is no code' }), 'a number is no code');
    assert.equal(why({ code: 'E2', message: 5 }), 'E2');
    assert.equal(why(Object.assign(new Error('top'), { cause: 'a string cause' })), 'top');
    assert.equal(why(Object.assign(new Error('top'), { cause: null })), 'top');
    assert.equal(why({}), '[object Object]');
    assert.equal(why(null), 'null');
    assert.equal(why('plain'), 'plain');
    const error = new Error('x');
    assert.equal(notMade('GET', 'https://h/p', error).cause, error);
  });

  it('exits as a shell would for a command that did not exit itself', () => {
    assert.equal(exitCode({ signal: 'SIGTERM' }), 143);
    assert.equal(exitCode({ signal: 'SIGNOTREAL' as NodeJS.Signals }), 128);
    assert.equal(exitCode({ signal: null, error: Object.assign(new Error('e'), { code: 'ENOENT' }) }), 127);
    assert.equal(exitCode({ signal: null, error: Object.assign(new Error('e'), { code: 'EACCES' }) }), 126);
    assert.equal(exitCode({ signal: null, error: Object.assign(new Error('e'), { code: 'EPERM' }) }), 1);
    assert.equal(exitCode({ signal: null }), 1);
  });

  it('resolves links in a path, keeps one it cannot, and has none for none', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'niyam-realpath-')));
    try {
      symlinkSync(dir, join(dir, 'link'));
      assert.equal(realPath(join(dir, 'link')), dir);
      assert.equal(realPath(join(dir, 'none')), join(dir, 'none'));
      assert.equal(realPath(), '');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('finds the nearest part of a path that is there, stopping at the root', () => {
    assert.equal(nearestPresent('/a/b/c', (path) => path === '/a'), '/a');
    assert.equal(nearestPresent('/a/b/c', (path) => path === '/a/b/c'), '/a/b/c');
    // A search that never stopped at the root would ask forever; this one gives up after a few.
    let asked = 0;
    assert.equal(
      nearestPresent('/a/b/c', () => {
        asked += 1;
        if (asked > 10) throw new Error('asked past the root');
        return false;
      }),
      '/',
    );
  });
});

describe('realSys confine', () => {
  const sys = realSys();
  // tmpdir() is itself a link on macOS (/var to /private/var): the toplevel is named through it, as a caller may.
  const dir = mkdtempSync(join(tmpdir(), 'niyam-confine-'));
  const real = realpathSync(dir);
  const top = join(dir, 'repo');
  const away = join(dir, 'away');
  mkdirSync(join(top, 'inner'), { recursive: true });
  mkdirSync(away);
  after(() => rmSync(dir, { recursive: true, force: true }));

  it('passes a path under the toplevel, there or not yet, and a link that stays inside', () => {
    sys.confine(top, join(top, 'inner'));
    sys.confine(top, join(top, '.tmp/push/handoff-log.jsonl'));
    sys.confine(top, top);
    symlinkSync(join(top, 'inner'), join(top, 'to-inner'));
    sys.confine(top, join(top, 'to-inner/new/file'));
  });

  it('refuses a linked file, a linked folder above it, and a folder that only starts with the toplevel\'s name', () => {
    writeFileSync(join(away, 'ledger'), 'outside\n');
    symlinkSync(join(away, 'ledger'), join(top, 'linked-file'));
    symlinkSync(away, join(top, 'linked-dir'));
    mkdirSync(join(dir, 'repo-evil'));
    symlinkSync(join(dir, 'repo-evil'), join(top, 'sibling'));
    assert.throws(() => sys.confine(top, join(top, 'linked-file')), {
      message: `refused to write ${join(top, 'linked-file')}: it leads to ${join(real, 'away/ledger')}, outside the git toplevel ${join(real, 'repo')}`,
    });
    assert.throws(() => sys.confine(top, join(top, 'linked-dir/new/file')), { message: new RegExp(`it leads to ${join(real, 'away')}, outside the git toplevel ${join(real, 'repo')}$`) });
    assert.throws(() => sys.confine(top, join(top, 'sibling/file')), { message: new RegExp(`it leads to ${join(real, 'repo-evil')}, outside`) });
    assert.throws(() => sys.confine(top, join(dir, 'elsewhere/file')), { message: /outside the git toplevel/ });
  });

  it('refuses a link that leads nowhere, which a write would create outside', () => {
    symlinkSync(join(away, 'not-yet'), join(top, 'dangling'));
    assert.throws(() => sys.confine(top, join(top, 'dangling')), {
      message: `refused to write ${join(top, 'dangling')}: ${join(top, 'dangling')} is a link that cannot be followed (ENOENT), so it may lead outside ${join(real, 'repo')}`,
    });
    assert.deepEqual(readdirSync(away).sort(), ['ledger']);
  });
});
