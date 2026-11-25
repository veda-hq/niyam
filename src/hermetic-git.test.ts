import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync } from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { hermeticGitEnv, maskProcessGitEnv, removeFixtureRoot } from './hermetic-git.ts';

describe('hermeticGitEnv', () => {
  it('drops every GIT_ variable and turns off the global and system config', () => {
    assert.deepEqual(hermeticGitEnv({ PATH: '/bin', GIT_DIR: '/hook/.git', GIT_INDEX_FILE: 'i' }), { PATH: '/bin', GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' });
    assert.equal(hermeticGitEnv().GIT_CONFIG_NOSYSTEM, '1');
  });
});

describe('maskProcessGitEnv', () => {
  it('does the same to an environment in place', () => {
    const env: NodeJS.ProcessEnv = { HOME: '/h', GIT_WORK_TREE: '/w' };
    maskProcessGitEnv(env);
    assert.deepEqual(env, { HOME: '/h', GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' });
  });
});

describe('removeFixtureRoot', () => {
  it('removes a folder inside the temporary folder, and nothing there is fine', () => {
    const made = mkdtempSync(join(tmpdir(), 'niyam-fixture-'));
    mkdirSync(join(made, 'a'));
    removeFixtureRoot(made);
    assert.equal(existsSync(made), false);
    removeFixtureRoot(made);
  });

  // Only folders this test made are handed over to be refused, so a broken check removes nothing else.
  it('refuses its root itself, a folder beside it, and one whose name only starts like it', () => {
    const base = mkdtempSync(join(tmpdir(), 'niyam-refuse-'));
    const root = join(base, 'root');
    const beside = join(base, 'beside');
    const lookalike = join(base, 'rootlike');
    for (const folder of [root, beside, lookalike]) mkdirSync(folder);
    try {
      for (const folder of [root, beside, lookalike]) {
        assert.throws(() => removeFixtureRoot(folder, root), { message: `refusing to remove ${folder}: it is not inside ${root}` });
        assert.equal(existsSync(folder), true);
      }
    } finally {
      removeFixtureRoot(base);
    }
  });

  it('follows links before it judges', () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'niyam-links-')));
    const root = join(base, 'root');
    const outside = join(base, 'outside');
    mkdirSync(root);
    mkdirSync(outside);
    const link = join(root, 'link');
    symlinkSync(outside, link);
    try {
      assert.throws(() => removeFixtureRoot(link, root), /is not inside/);
      assert.equal(existsSync(outside), true);
    } finally {
      removeFixtureRoot(base);
    }
  });
});
