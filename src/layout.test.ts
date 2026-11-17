import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FakeSys, capture } from './fake.test.ts';
import { byHandLines, painter, runStep, tilde, wrap } from './layout.ts';

describe('runStep', () => {
  it('shows a step that throws as failed, with what it said, then lets the error go on', async () => {
    const sys = new FakeSys();
    const { io, out, err } = capture();
    await assert.rejects(
      runStep(sys, io, painter(sys), 'board', async (step) => {
        step.out('made the Project');
        step.err('board: GitHub refused');
        throw new Error('down');
      }),
      /down/,
    );
    assert.deepEqual({ out, err, spinning: sys.spinning }, { out: ['■  board', '│  made the Project'], err: ['board: GitHub refused'], spinning: 0 });
  });
});

describe('byHandLines', () => {
  it('numbers each step behind the bar, wrapped to 80 columns, with a link longer than a line on one of its own', () => {
    const sys = new FakeSys();
    const link = `https://github.com/${'a'.repeat(80)}`;
    const lines = byHandLines(painter(sys), ['Short.', `Once for example-org: open ${link} and click the button there, then come back.`]);
    assert.deepEqual(lines, [
      '│',
      '◇  By hand',
      '│    1. Short.',
      '│',
      '│    2. Once for example-org: open',
      `│       ${link}`,
      '│       and click the button there, then come back.',
      '│',
    ]);
    assert.deepEqual(byHandLines(painter(sys), []), [], 'nothing when nothing is left');
  });

  it('indents the lines of a tenth step under its text', () => {
    const steps = Array.from({ length: 10 }, (_, index) => (index === 9 ? `${'word '.repeat(20)}end` : 'x'));
    const lines = byHandLines(painter(new FakeSys()), steps);
    assert.ok(lines.includes(`│    10. ${'word '.repeat(14).trimEnd()}`), lines.join('\n'));
    assert.ok(lines.includes(`│        ${'word '.repeat(6)}end`), lines.join('\n'));
    for (const line of lines) assert.ok(line.length <= 79, line);
  });
});

describe('wrap', () => {
  it('breaks at spaces, and keeps a word longer than a line whole', () => {
    assert.deepEqual(wrap('a bb  ccc\ndddd', 6), ['a bb', 'ccc', 'dddd']);
    assert.deepEqual(wrap('xxxxxxxx y', 4), ['xxxxxxxx', 'y']);
    assert.deepEqual(wrap('   ', 4), []);
  });
});

describe('tilde', () => {
  it('writes the home folder as ~, and leaves other paths alone', () => {
    assert.deepEqual([tilde('/h', '/h'), tilde('/h', '/h/.ssh/k'), tilde('/h', '/hx/k'), tilde('/h', '/etc')], ['~', '~/.ssh/k', '/hx/k', '/etc']);
  });
});
