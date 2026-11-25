import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { realSys } from './sys.ts';

describe('realSys', () => {
  const sys = realSys();
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
    assert.equal(sys.exists(join(dir, 'g')), true);
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
    const served = await sys.serve((request) => {
      seen.push(request);
      if (request.path === '/broken') return Promise.reject(new Error('broken'));
      return Promise.resolve({ status: 302, headers: { location: 'https://example.com/next' }, body: 'moved' });
    });
    const base = `http://127.0.0.1:${served.port}`;
    try {
      const moved = await fetch(`${base}/made?code=c1&state=s1`, { redirect: 'manual' });
      assert.deepEqual([moved.status, moved.headers.get('location'), moved.headers.get('cache-control'), await moved.text()], [302, 'https://example.com/next', 'no-store', 'moved']);
      assert.deepEqual(seen, [{ path: '/made', query: { code: 'c1', state: 's1' } }]);
      const posted = await fetch(`${base}/made`, { method: 'POST' });
      assert.deepEqual([posted.status, posted.headers.get('allow')], [405, 'GET'], 'a GET alone');
      assert.equal(seen.length, 1, 'a POST never reaches the handler');
      assert.equal((await fetch(`${base}/broken`)).status, 500, 'a handler that fails answers 500');
    } finally {
      served.close();
    }
    await assert.rejects(fetch(`${base}/made`), 'nothing serves there once closed');
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
    assert.deepEqual(sys.exec('sh', ['-c', 'exit 0'], { interactive: true }), { code: 0, stdout: '', stderr: '' });
  });

  it("hands a conversing command's lines from both streams to the caller, with its exit code", async () => {
    const lines: string[] = [];
    const code = await sys.converse('sh', ['-c', 'test "$SEEN" = x || exit 4; echo one; echo two >&2; printf three; exit 3'], { env: { PATH: '/usr/bin:/bin', SEEN: 'x' } }, (line) => lines.push(line));
    assert.equal(code, 3);
    assert.deepEqual([...lines].sort(), ['one', 'three', 'two']);
    assert.equal(await sys.converse('/no/such/command', [], {}, () => {}), 127);
    assert.equal(await sys.converse('sh', ['-c', 'kill -TERM $$'], {}, () => {}), 128 + 15);
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

  it('knows home, cwd, env and the time', () => {
    assert.equal(sys.cwd, process.cwd());
    assert.ok(sys.home.length > 0);
    assert.equal(sys.env, process.env);
    assert.ok(sys.now() instanceof Date);
  });

  it('calls a JSON API with a token and body', async () => {
    const seen: { auth?: string; body: string; method?: string }[] = [];
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => (body += chunk.toString()));
      req.on('end', () => {
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
      await assert.rejects(sys.http(`${server.base}/x`, { timeoutMs: 200 }), { name: 'TimeoutError' });
      assert.ok(Date.now() - started < 900, 'the repeat waits no longer than what is left of the deadline');
      assert.equal(server.seen(), 1);
    } finally {
      server.close();
    }
  });

  it('keeps a timeout as a TimeoutError, tried once', async () => {
    const server = await flaky(0, true);
    try {
      await assert.rejects(sys.http(`${server.base}/x`, { timeoutMs: 50 }), { name: 'TimeoutError' });
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
