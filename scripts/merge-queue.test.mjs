import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import { MERGE_QUEUE_BOT, MERGE_QUEUE_BRANCH, MERGE_QUEUE_SIGNER, isMergifyDraft, isMergifyMerge, mergifyTests, strayCommits } from './merge-queue.mjs';

const REPO = 'o/r';
/** Draft 1, as Mergify opened athya_mono#3822 to test #3821, here testing `title`'s pull requests. */
const draft = (title = 'merge queue: checking #2 on main (634865a)', extra = {}) => ({
  title,
  body: '',
  user: { login: 'mergify[bot]', type: 'Bot' },
  head: { ref: 'mergify/merge-queue/1ad5372850', repo: { full_name: REPO } },
  ...extra,
});
/** Mergify's merge of #`pr`, as athya_mono#3822's 302cc9d, with `change` applied. */
const merge = (sha, pr, change = {}) => ({
  sha,
  parents: [{ sha: 'p1' }, { sha: 'p2' }],
  author: { login: 'mergify[bot]' },
  committer: { login: 'mergify-commit-signer' },
  commit: { message: `Merge of PR ${pr}\n\nqueued by Mergify`, verification: { verified: true } },
  ...change,
});
const AHEAD = (list) => `### What this draft tests\n\n#77 is named here, not ahead.\n\n### Queued ahead of this batch\n\nThese entered the queue first.\n\n${list}\n\n<details>\n#99\n</details>`;

describe("Mergify's merge-queue draft", () => {
  test('names Mergify as GitHub does', () => {
    assert.deepEqual([MERGE_QUEUE_BOT, MERGE_QUEUE_BRANCH, MERGE_QUEUE_SIGNER], ['mergify[bot]', 'mergify/merge-queue/', 'mergify-commit-signer']);
  });

  test('a draft is Mergify’s by its Bot author, its queue branch and its own repository', () => {
    assert.equal(isMergifyDraft(draft(), REPO), true);
    for (const pull of [
      draft(undefined, { user: { login: 'mergify[bot]', type: 'User' } }),
      draft(undefined, { user: null }),
      draft(undefined, { head: { ref: 'mergify/bp/main/pr-2', repo: { full_name: REPO } } }),
      draft(undefined, { head: { ref: 'mergify/merge-queue/x', repo: null } }),
      draft(undefined, { head: undefined }),
    ]) {
      assert.equal(isMergifyDraft(pull, REPO), false);
    }
  });

  test('mergifyTests reads a batch, a stack and a deep stack from the title', () => {
    assert.deepEqual(mergifyTests(draft('merge queue: checking #2 + #3 + #4 together on main (7514101)'), REPO, 1), [2, 3, 4]);
    assert.deepEqual(mergifyTests(draft('merge queue: checking #2 + #3 together on main (7514101), stacked on #5 and #6'), REPO, 1), [2, 3, 5, 6]);
    assert.deepEqual(mergifyTests(draft('merge queue: checking #2 on release/1 (7514101), stacked on #5, #6 and #7'), REPO, 1), [2, 5, 6, 7]);
  });

  test('a deep stack counts only when the body names exactly as many ahead', () => {
    const title = 'merge queue: checking #2 on main (bbead47), stacked on 4 pull requests ahead';
    const four = AHEAD('- [#4](/o/r/pull/4) + [#5](/o/r/pull/5)\n- [#6](/o/r/pull/6)\n- [#8](/o/r/pull/8)');
    assert.deepEqual(mergifyTests(draft(title, { body: four }), REPO, 1), [2, 4, 5, 6, 8]);
    // The list may be the body's last section.
    assert.deepEqual(mergifyTests(draft(title, { body: '### Queued ahead of this batch\n- [#4](x)\n- [#5](x)\n- [#6](x)\n- [#8](x)' }), REPO, 1), [2, 4, 5, 6, 8]);
    for (const body of [AHEAD('- [#4](/o/r/pull/4)\n- [#6](/o/r/pull/6)'), AHEAD('- [#4](x)\n- [#4](x)\n- [#6](x)\n- [#8](x)'), 'no list', null]) {
      assert.equal(mergifyTests(draft(title, { body }), REPO, 1), undefined, String(body));
    }
  });

  test('reads no other title', () => {
    for (const title of ['merge queue: checking #2 on main (634865a), stacked on some pull requests', 'merge queue: checking #2 + on main (634865a)', 'merge queue: checking #2 on main', undefined]) {
      assert.equal(mergifyTests(draft(title ?? null), REPO, 1), undefined, String(title));
    }
  });

  test('a merge is Mergify’s only signed by its signer, by mergify[bot], with two parents, merging a tested pull request', () => {
    assert.equal(isMergifyMerge(merge('m', 2), [2, 3]), true);
    assert.equal(isMergifyMerge(merge('m', '#3'), [2, 3]), true);
    for (const [why, commit] of [
      ['an untested pull request', merge('m', 4)],
      ['not Verified', merge('m', 2, { commit: { message: 'Merge of PR 2', verification: { verified: false } } })],
      ['no verification', merge('m', 2, { commit: { message: 'Merge of PR 2' } })],
      ['another committer', merge('m', 2, { committer: { login: 'AthyaBot' } })],
      ['no committer', merge('m', 2, { committer: null })],
      ['another author', merge('m', 2, { author: { login: 'AthyaBot' } })],
      ['one parent', merge('m', 2, { parents: [{ sha: 'p1' }] })],
      ['no parents', merge('m', 2, { parents: undefined })],
      ['another message', merge('m', 2, { commit: { message: 'Merge branch main', verification: { verified: true } } })],
      ['no message', merge('m', 2, { commit: undefined })],
    ]) {
      assert.equal(isMergifyMerge(commit, [2, 3]), false, why);
    }
  });

  test('strayCommits names what is neither a tested pull request’s commit nor Mergify’s merge', () => {
    const theirs = new Map([[2, ['a1', 'a2']], [3, ['b1']]]);
    assert.deepEqual(strayCommits([{ sha: 'a1' }, { sha: 'a2' }, { sha: 'b1' }, merge('m2', 2), merge('m3', 3)], theirs), []);
    assert.deepEqual(strayCommits([{ sha: 'a1' }, { sha: 'f1' }, merge('m4', 4), merge('m2', 2, { committer: { login: 'x' } })], theirs), ['f1', 'm4', 'm2']);
  });

  test('imports nothing, so PR identity can load it with no install', () => {
    const source = readFileSync(new URL('./merge-queue.mjs', import.meta.url), 'utf8');
    assert.ok(!/^\s*import\b/m.test(source));
    assert.ok(!/\bimport\(/.test(source));
  });

  test('ships beside dist, where dist/identity.js imports it, and Guard checks it out', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    assert.ok(pkg.files.includes('scripts/merge-queue.mjs'));
    const workflow = readFileSync(new URL('../.github/workflows/shared-guard.yml', import.meta.url), 'utf8');
    assert.match(workflow, /^\s+\/scripts\/merge-queue\.mjs$/m);
  });
});
