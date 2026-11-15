import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FakeSys, TAG_SHA } from './fake.test.ts';
import { tagOnMain } from './release-tag.ts';

const COMPARE = '/repos/veda-hq/niyam/compare/refs/tags/v0.6.9...refs/heads/main?per_page=1';
const OFF_MAIN = '7c'.repeat(20);

describe('tagOnMain (P-61)', () => {
  it("gives the tag's commit when main is ahead of it or at it, asking with no token", async () => {
    for (const status of ['ahead', 'identical']) {
      const sys = new FakeSys().route('GET', COMPARE, { status: 200, json: { status, base_commit: { sha: TAG_SHA } } });
      assert.deepEqual(await tagOnMain(sys, '0.6.9'), { sha: TAG_SHA }, status);
      const [asked] = sys.requests.filter((request) => request.url.includes('/compare/'));
      assert.equal(asked?.url, `https://api.github.com${COMPARE}`);
      assert.equal(asked?.token, undefined, 'with no token: the repository is public');
      assert.equal(asked?.timeoutMs, 15_000);
    }
  });

  it('refuses a tag whose commit is not on main, naming the tag and the commit', async () => {
    for (const status of ['diverged', 'behind']) {
      const sys = new FakeSys().route('GET', COMPARE, { status: 200, json: { status, base_commit: { sha: OFF_MAIN } } });
      assert.deepEqual(await tagOnMain(sys, '0.6.9'), {
        problem: `the v0.6.9 tag is on commit ${OFF_MAIN.slice(0, 12)}, which is not on veda-hq/niyam's main (GitHub's comparison: "${status}"); a release comes only from main, so this tag is not one`,
      });
    }
    const sys = new FakeSys().route('GET', COMPARE, { status: 200, json: { base_commit: { sha: OFF_MAIN } } });
    assert.match((await tagOnMain(sys, '0.6.9') as { problem: string }).problem, /GitHub's comparison: null\)/);
  });

  it('refuses a tag GitHub does not have', async () => {
    const sys = new FakeSys().route('GET', COMPARE, { status: 404, json: { message: 'Not Found' } });
    assert.deepEqual(await tagOnMain(sys, '0.6.9'), { problem: 'veda-hq/niyam has no v0.6.9 tag that GitHub can compare with main' });
  });

  it('refuses when GitHub cannot be reached, or answers something else', async () => {
    const sys = new FakeSys().route('GET', COMPARE, () => {
      throw new Error('GET api.github.com/repos could not be made: ENOTFOUND');
    });
    assert.deepEqual(await tagOnMain(sys, '0.6.9'), {
      problem: 'GitHub could not be asked whether the v0.6.9 tag is on main (GET api.github.com/repos could not be made: ENOTFOUND)',
    });
    sys.route('GET', COMPARE, () => {
      throw 'socket hang up';
    });
    assert.deepEqual(await tagOnMain(sys, '0.6.9'), { problem: 'GitHub could not be asked whether the v0.6.9 tag is on main (socket hang up)' });
    sys.route('GET', COMPARE, { status: 403, json: { message: 'API rate limit exceeded' } });
    assert.deepEqual(await tagOnMain(sys, '0.6.9'), { problem: 'GitHub answered HTTP 403 when asked whether the v0.6.9 tag is on main' });
    for (const json of [null, { status: 'ahead' }, { status: 'ahead', base_commit: { sha: 'main' } }]) {
      sys.route('GET', COMPARE, { status: 200, json });
      assert.deepEqual(await tagOnMain(sys, '0.6.9'), { problem: "GitHub's comparison of the v0.6.9 tag with main names no commit for the tag" }, JSON.stringify(json));
    }
  });
});
