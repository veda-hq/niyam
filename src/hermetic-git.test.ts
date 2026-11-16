import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
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

  it('refuses the temporary folder itself and anything outside it', () => {
    assert.throws(() => removeFixtureRoot(tmpdir()), /is not inside/);
    assert.throws(() => removeFixtureRoot(realpathSync(process.cwd())), /is not inside/);
  });
});
