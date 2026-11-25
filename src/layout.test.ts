import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FakeSys, capture } from './fake.test.ts';
import { byHandLines, closing, findingLine, findingLines, heading, painter, planLines, runStep, spinning, tilde, wrap } from './layout.ts';

/** A FakeSys at a terminal with colours, unless `env` says otherwise. */
function terminal(env: Record<string, string | undefined> = { TERM: 'xterm-256color' }, tty = true): FakeSys {
  const sys = new FakeSys();
  sys.env = env;
  sys.tty = tty;
  return sys;
}

/** `text` in the colour of SGR `code`, as the painter writes it. */
const sgr = (code: number, text: string): string => `\u001b[${code}m${text}\u001b[0m`;

describe('painter', () => {
  it('paints each mark in its own colour at a terminal with colours', () => {
    const paint = painter(terminal());
    assert.deepEqual(
      [paint.dim('a'), paint.accent('b'), paint.done('c'), paint.failed('d'), paint.warn('e')],
      [sgr(2, 'a'), sgr(36, 'b'), sgr(32, 'c'), sgr(31, 'd'), sgr(33, 'e')],
    );
  });

  for (const [why, sys] of [
    ['no person at the terminal', terminal({ TERM: 'xterm' }, false)],
    ['NO_COLOR set', terminal({ TERM: 'xterm', NO_COLOR: '1' })],
    ['no TERM', terminal({})],
    ['an empty TERM', terminal({ TERM: '' })],
    ['a dumb terminal', terminal({ TERM: 'dumb' })],
  ] as const) {
    it(`paints nothing with ${why}`, () => {
      const paint = painter(sys);
      assert.deepEqual([paint.dim('a'), paint.accent('b'), paint.done('c'), paint.failed('d'), paint.warn('e')], ['a', 'b', 'c', 'd', 'e']);
    });
  }

  it('still paints with an empty NO_COLOR, which sets nothing', () => {
    assert.equal(painter(terminal({ TERM: 'xterm', NO_COLOR: '' })).done('c'), sgr(32, 'c'));
  });
});

describe('heading and closing', () => {
  it('opens with ◆ and the command, and closes with └', () => {
    const paint = painter(terminal());
    assert.equal(heading(paint, 'doctor', 'this Mac'), `${sgr(36, '◆')}  niyam doctor   this Mac`);
    assert.equal(closing(paint, 'Done.'), `${sgr(2, '└')}  Done.`);
  });
});

describe('planLines', () => {
  it('lists each group that has items, lines up the labels that have details, then closes with a bar', () => {
    const paint = painter(new FakeSys());
    assert.deepEqual(
      planLines(paint, ['◆  head'], [
        { title: 'Files', items: [{ label: 'a', detail: 'made' }, { label: 'longer', detail: 'changed' }, { label: 'a-label-with-no-detail' }] },
        { title: 'Empty', items: [] },
        { title: 'Bare', items: [{ label: 'x' }] },
      ]),
      ['◆  head', '│', '◇  Files', '│    a       made', '│    longer  changed', '│    a-label-with-no-detail', '│', '◇  Bare', '│    x', '│'],
    );
    assert.deepEqual(planLines(paint, [], []), ['│']);
  });

  it('paints the bar dim and the group mark done', () => {
    const paint = painter(terminal());
    assert.deepEqual(planLines(paint, [], [{ title: 'T', items: [{ label: 'x' }] }]), [sgr(2, '│'), `${sgr(32, '◇')}  T`, `${sgr(2, '│')}    x`, sgr(2, '│')]);
  });
});

describe('findingLine and findingLines', () => {
  it('paints each mark in its colour, with → before a fix', () => {
    const paint = painter(terminal());
    assert.deepEqual(
      [
        findingLine(paint, { mark: '✓', text: 'fine' }),
        findingLine(paint, { mark: '▲', text: 'worth it', fix: 'niyam upgrade' }),
        findingLine(paint, { mark: '✗', text: 'broken', fix: '' }),
      ],
      [`${sgr(32, '✓')}  fine`, `${sgr(33, '▲')}  worth it ${sgr(2, '→')} niyam upgrade`, `${sgr(31, '✗')}  broken`],
    );
  });

  it('groups findings after a bar, and gives nothing for none', () => {
    const paint = painter(new FakeSys());
    assert.deepEqual(findingLines(paint, 'This Mac', [{ mark: '✓', text: 'a' }, { mark: '✗', text: 'b', fix: 'c' }]), ['│', '◇  This Mac', '✓  a', '✗  b → c']);
    assert.deepEqual(findingLines(paint, 'This Mac', []), []);
  });
});

describe('spinning', () => {
  it('shows the spinner by its label while the work runs, and takes it off after', async () => {
    const sys = new FakeSys();
    const turning: number[] = [];
    assert.equal(
      await spinning(sys, 'Asking', () => {
        turning.push(sys.spinning);
        return Promise.resolve(7);
      }),
      7,
    );
    assert.deepEqual({ turning, spun: sys.spun, spinning: sys.spinning }, { turning: [1], spun: ['Asking'], spinning: 0 });
  });
});

describe('runStep', () => {
  it('shows a step that worked as ◇ alone, keeps what it said, and passes its errors on', async () => {
    const sys = new FakeSys();
    const { io, out, err } = capture();
    const result = await runStep(sys, io, painter(sys), 'board', async (step) => {
      step.out('  made the Project ');
      step.err('board: a note');
      return true;
    });
    assert.deepEqual({ result, out, err, spun: sys.spun, spinning: sys.spinning }, {
      result: { ok: true, log: ['  made the Project '] },
      out: ['◇  board'],
      err: ['board: a note'],
      spun: ['board'],
      spinning: 0,
    });
  });

  it('shows a step that failed as ■, with what it said, trimmed', async () => {
    const sys = new FakeSys();
    const { io, out } = capture();
    const result = await runStep(sys, io, painter(terminal()), 'board', async (step) => {
      step.out('  made the Project ');
      return false;
    });
    assert.deepEqual({ result, out }, { result: { ok: false, log: ['  made the Project '] }, out: [`${sgr(31, '■')}  board`, `${sgr(2, '│')}  made the Project`] });
  });

  it('fails a step with nothing to run, without a spinner', async () => {
    const sys = new FakeSys();
    const { io, out, err } = capture();
    assert.deepEqual(await runStep(sys, io, painter(terminal()), 'board'), { ok: false, log: [] });
    assert.deepEqual({ out, err, spun: sys.spun }, { out: [`${sgr(31, '■')}  board`], err: [], spun: [] });
  });

  it('paints a step that worked done', async () => {
    const sys = new FakeSys();
    const { io, out } = capture();
    await runStep(sys, io, painter(terminal()), 'board', () => Promise.resolve(true));
    assert.deepEqual(out, [`${sgr(32, '◇')}  board`]);
  });

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

  it('numbers a blank step with nothing after it', () => {
    assert.deepEqual(byHandLines(painter(new FakeSys()), ['  ']), ['│', '◇  By hand', '│    1. ', '│']);
  });

  it('wraps a step to 80 columns less the bar, number and a column', () => {
    const word = 'x'.repeat(71);
    assert.deepEqual(byHandLines(painter(new FakeSys()), [`${word} y`]), ['│', '◇  By hand', `│    1. ${word}`, '│       y', '│']);
  });
});

describe('wrap', () => {
  it('breaks at spaces, and keeps a word longer than a line whole', () => {
    assert.deepEqual(wrap('a bb  ccc\ndddd', 6), ['a bb', 'ccc', 'dddd']);
    assert.deepEqual(wrap('xxxxxxxx y', 4), ['xxxxxxxx', 'y']);
    assert.deepEqual(wrap('   ', 4), []);
  });

  it('fills a line to exactly its width, and drops the spaces at either end', () => {
    assert.deepEqual(wrap('ab cd ef', 5), ['ab cd', 'ef']);
    assert.deepEqual(wrap(' a b ', 10), ['a b']);
  });
});

describe('tilde', () => {
  it('writes the home folder as ~, and leaves other paths alone', () => {
    assert.deepEqual([tilde('/h', '/h'), tilde('/h', '/h/.ssh/k'), tilde('/h', '/hx/k'), tilde('/h', '/etc')], ['~', '~/.ssh/k', '/hx/k', '/etc']);
  });
});
