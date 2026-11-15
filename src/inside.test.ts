import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { Outside, landInside } from './inside.ts';
import { realSys } from './sys.ts';

describe('landInside, on real folders', () => {
  const sys = realSys();
  // Not resolved on purpose: on macOS the temporary folder is itself behind a link, as a repository's path can be.
  const base = mkdtempSync(join(tmpdir(), 'niyam-inside-'));
  after(() => rmSync(base, { recursive: true, force: true }));
  let count = 0;
  /** A fresh repository folder and a folder outside it. */
  const world = (): { root: string; outside: string } => {
    count += 1;
    const root = join(base, `repo-${count}`);
    const outside = join(base, `outside-${count}`);
    mkdirSync(root);
    mkdirSync(outside);
    return { root, outside };
  };
  const refuses = (root: string, target: string, why: RegExp): void => {
    assert.throws(
      () => landInside(sys, root, target),
      (error: unknown) => error instanceof Outside && why.test(error.message) && error.message.endsWith('nothing was written'),
    );
  };

  it('lets a write in where nothing on the way exists yet, or all of it does', () => {
    const { root } = world();
    landInside(sys, root, join(root, '.tmp/push/handoff-log.jsonl'));
    mkdirSync(join(root, '.tmp/push'), { recursive: true });
    writeFileSync(join(root, '.tmp/push/handoff-log.jsonl'), '');
    landInside(sys, root, join(root, '.tmp/push/handoff-log.jsonl'));
  });

  it('lets in a folder whose name only starts with two dots', () => {
    const { root } = world();
    landInside(sys, root, join(root, '..cache/x.json'));
  });

  it('refuses a target that is a link, to outside, to nothing, or to a file inside', () => {
    const { root, outside } = world();
    mkdirSync(join(root, 'a'));
    writeFileSync(join(outside, 'f'), '');
    writeFileSync(join(root, 'inside.json'), '');
    symlinkSync(join(outside, 'f'), join(root, 'a/out.json'));
    symlinkSync(join(outside, 'missing'), join(root, 'a/dangling.json'));
    symlinkSync(join(root, 'inside.json'), join(root, 'a/in.json'));
    for (const name of ['out.json', 'dangling.json', 'in.json']) refuses(root, join(root, 'a', name), /: it is a symbolic link;/);
  });

  it('refuses a parent folder or a grandparent that leads outside', () => {
    const { root, outside } = world();
    mkdirSync(join(outside, 'push'));
    mkdirSync(join(root, '.tmp'));
    symlinkSync(join(outside, 'push'), join(root, '.tmp/push'));
    refuses(root, join(root, '.tmp/push/handoff-log.jsonl'), /: it leads to .*outside-\d+\/push\/handoff-log\.jsonl, outside the repository at /);
    const other = world();
    symlinkSync(other.outside, join(other.root, '.tmp'));
    refuses(other.root, join(other.root, '.tmp/keep-going/stop-note.json'), /: it leads to .*outside-\d+\/keep-going\/stop-note\.json, outside/);
  });

  it('refuses a parent link that leads nowhere', () => {
    const { root, outside } = world();
    mkdirSync(join(root, '.tmp'));
    symlinkSync(join(outside, 'gone'), join(root, '.tmp/push'));
    refuses(root, join(root, '.tmp/push/handoff-log.jsonl'), /: .*\.tmp\/push is a symbolic link that leads nowhere;/);
  });

  it('lets a parent link through that stays inside the repository', () => {
    const { root } = world();
    mkdirSync(join(root, 'real-tmp'));
    symlinkSync(join(root, 'real-tmp'), join(root, '.tmp'));
    landInside(sys, root, join(root, '.tmp/push/handoff-log.jsonl'));
  });
});
