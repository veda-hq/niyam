// The mutation lanes' suite command (stryker/lane.mjs) keeps the whole TAP
// stream when stdout is a slow pipe, as Stryker's is on Linux CI
// (nodejs/node#67149, seen on #644 and #645), and still ends a suite that
// leaves a handle open, which is why it passes --test-force-exit (#643).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { removeFixtureRoot } from './hermetic-git.ts';

interface Lane {
  tap: { nodeArgs: string[] };
}

const { lane } = (await import(new URL('../stryker/lane.mjs', import.meta.url).href)) as { lane: () => Lane };
// Where the tap runner's own hookFile is (tap-test-runner.js).
const hookFile = fileURLToPath(new URL('../node_modules/@stryker-mutator/tap-runner/dist/src/setup/hook.cjs', import.meta.url));

// The parent reads stdout only once the child writes a byte to fd 3, so stdout has backed up by then. A
// generated suite writes it once its tests have run (node:test's reporter waits on a full pipe, so the suite
// never reaches process.exit until it is read). A plain script gets it from this preload, loaded after the
// lane's own preloads so it wraps process.exit outermost: it writes the byte the moment the script calls
// process.exit, before drain-exit.cjs can hold the exit.
const EXIT_SIGNAL = `'use strict';
const { writeSync } = require('node:fs');
const exit = process.exit;
let told = false;
const tell = () => { if (!told) { told = true; writeSync(3, 'x'); } };
process.exit = function (...args) { tell(); return exit.apply(process, args); };
process.on('exit', tell);
`;

const roots: string[] = [];
let dir = '';
let exitSignal = '';
before(() => {
  const root = mkdtempSync(join(tmpdir(), 'niyam-stryker-lane-'));
  roots.push(root);
  dir = root;
  exitSignal = join(dir, 'exit-signal.cjs');
  writeFileSync(exitSignal, EXIT_SIGNAL);
});
after(() => {
  for (const root of roots.splice(0)) removeFixtureRoot(root);
});

/** `promise`, or a failure after `ms`: a broken wait fails the test at once instead of hanging the run. */
function within<T>(ms: number, promise: Promise<T>, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, fail) => {
    timer = setTimeout(() => fail(new Error(`${what} not within ${String(ms)} ms`)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

const TESTS = 300;

/**
 * Writes a suite of TESTS tests with long names, then `tail` (code run once the tests are declared). Once
 * every test has run, it writes the byte on fd 3 that lets runLike start reading.
 */
function suite(name: string, tail = ''): string {
  const file = join(dir, name);
  writeFileSync(file, `import { writeSync } from 'node:fs';\nimport { after, test } from 'node:test';\nafter(() => { writeSync(3, 'x'); });\nfor (let i = 0; i < ${String(TESTS)}; i++) test('test ' + i + ' ' + 'x'.repeat(1000), () => {});\n${tail}\n`);
  return file;
}

/**
 * Runs `file` as Stryker's tap runner does, with the lane's node arguments, reading its stdout only once it
 * writes on fd 3 (see EXIT_SIGNAL), so the pipe has backed up. A child of a node:test suite would
 * report to its parent's runner, not in TAP, unless NODE_TEST_CONTEXT is dropped.
 */
async function runLike(file: string): Promise<{ code: number | null; tap: string; ms: number; pid: number | undefined }> {
  const args = lane().tap.nodeArgs.flatMap((arg) => (arg === '{{hookFile}}' ? [hookFile] : arg === '{{testFile}}' ? ['-r', exitSignal, file] : [arg]));
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const started = Date.now();
  const child = spawn(process.execPath, args, { cwd: dir, env, stdio: ['ignore', 'pipe', 'ignore', 'pipe'] });
  const stdout = child.stdio[1] as Readable;
  const signal = child.stdio[3] as Readable;
  stdout.pause();
  try {
    await within(20_000, once(signal, 'data'), `${file}'s signal on fd 3`);
    let tap = '';
    stdout.setEncoding('utf8');
    stdout.on('data', (chunk: string) => (tap += chunk));
    stdout.resume();
    const [code] = (await within(20_000, once(child, 'close'), `${file}'s end`)) as [number | null];
    return { code, tap, ms: Date.now() - started, pid: child.pid };
  } finally {
    // A child the lane failed to end is killed, so a failed test leaves no process behind.
    if (child.exitCode === null && child.signalCode === null) {
      stdout.destroy();
      signal.destroy();
      child.kill('SIGKILL');
    }
  }
}

describe('the mutation lanes run a suite', () => {
  it('to the end of its TAP stream, though stdout is slow to empty', async () => {
    const { code, tap } = await runLike(suite('many.test.mjs'));
    assert.equal(code, 0);
    assert.equal(tap.match(/^ok \d+ /gmu)?.length, TESTS);
    assert.match(tap, new RegExp(`^1\\.\\.${String(TESTS)}$`, 'mu'));
    assert.match(tap, new RegExp(`^# pass ${String(TESTS)}$`, 'mu'));
    // The summary's last line, so nothing after it was lost either.
    assert.match(tap, /\n# duration_ms [\d.]+\n$/u);
  });

  it('ending one that leaves a timer running, with its whole stream', async () => {
    const { code, tap, ms } = await runLike(suite('open.test.mjs', 'setInterval(() => {}, 1000);'));
    assert.equal(code, 0);
    assert.equal(tap.match(/^ok \d+ /gmu)?.length, TESTS);
    assert.ok(ms < 30_000, `took ${String(ms)} ms`);
  });

  it("keeping a failing suite's exit code", async () => {
    const { code, tap } = await runLike(suite('fails.test.mjs', "test('fails', () => { throw new Error('no'); });"));
    assert.equal(code, 1);
    assert.match(tap, new RegExp(`^not ok ${String(TESTS + 1)} - fails$`, 'mu'));
    assert.match(tap, /^# fail 1$/mu);
  });

  it('keeping a code given to process.exit, once what was written before it is out', async () => {
    const file = join(dir, 'exits.mjs');
    // The exitCode set while stdout drains must not change the code process.exit was given.
    writeFileSync(file, "process.stdout.write('y'.repeat(1_000_000));\nprocess.exit(7);\nprocess.exitCode = 3;\n");
    const { code, tap } = await runLike(file);
    assert.equal(code, 7);
    assert.equal(tap, 'y'.repeat(1_000_000));
  });

  it("with Stryker's hook still writing its report as the suite exits", async () => {
    const { code, pid } = await runLike(suite('hooked.test.mjs', 'setInterval(() => {}, 1000);'));
    assert.equal(code, 0);
    assert.ok(existsSync(join(dir, `stryker-output-${String(pid)}.json`)));
  });
});
