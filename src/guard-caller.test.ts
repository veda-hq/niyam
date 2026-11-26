import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CALLER_CHECK, CALLER_JOB, GUARD_CALLER_PATH, SHARED_GUARD, callerAt, callerDetail, callerIsOnboards, callerPins, callerUpdate, callerWhat, guardCaller, policySteps, pushBranch } from './guard-caller.ts';
import { CALLER_0720 } from './older-texts.test.ts';

/** The caller as this release writes it, every byte, at v1.2.3 for main. */
const CALLER_123 =
  "# Written by niyam onboard: the shared Guard's caller. onboard writes it again on every run, its pin\n# moving with .github/workflows/niyam.yml's; change it by running onboard, not by hand. It holds nothing a pull\n# request could weaken: pull_request_target runs the default branch's copy of it, and the Guard it\n# calls runs from the niyam release it pins. Its check is niyam-guard / judge.\non:\n  pull_request_target:\n    types: [opened, edited, synchronize, reopened]\n    branches: [\"main\"]\n\npermissions:\n  contents: read\n  pull-requests: read\n  issues: read\n\njobs:\n  niyam-guard:\n    name: niyam-guard\n" +
  "    # Not on an edit of Mergify's queue draft that changes no title or base: its head's runs stand (veda-hq/niyam#685).\n    if: >-\n" +
  "      ${{ !(github.event.action == 'edited' && !github.event.changes.title && !github.event.changes.base &&\n" +
  "      github.event.pull_request.user.login == 'mergify[bot]' && github.event.pull_request.user.type == 'Bot' &&\n" +
  "      startsWith(github.event.pull_request.head.ref, 'mergify/merge-queue/') &&\n" +
  '      github.event.pull_request.head.repo.full_name == github.repository &&\n' +
  "      !contains(github.event.pull_request.title, ' pull requests ahead')) }}\n" +
  '    permissions:\n      contents: read\n      pull-requests: read\n      issues: read\n    uses: veda-hq/niyam/.github/workflows/shared-guard.yml@v1.2.3\n';

describe('guardCaller', () => {
  it('writes the caller, its job skipping an edit of Mergify’s queue draft (#685)', () => {
    assert.equal(guardCaller('main', '1.2.3'), CALLER_123);
    assert.equal(guardCaller('main', '1.2.3', false), CALLER_123);
    assert.equal(SHARED_GUARD, 'veda-hq/niyam/.github/workflows/shared-guard.yml');
    assert.equal(CALLER_JOB, 'niyam-guard');
    assert.equal(CALLER_CHECK, 'niyam-guard / judge');
    assert.equal(GUARD_CALLER_PATH, '.github/workflows/niyam-guard.yml');
  });

  it('writes, with older, the caller 0.7.20 wrote, which judges every edit', () => {
    assert.equal(guardCaller('main', '0.7.20', true), CALLER_0720);
  });

  it('quotes the branch as JSON, which YAML reads alike', () => {
    assert.match(guardCaller("it's", '1.2.3'), /^ {4}branches: \["it's"\]$/m);
    assert.match(guardCaller('true', '1.2.3'), /^ {4}branches: \["true"\]$/m);
  });
});

describe('callerAt', () => {
  it('reads the release and branch of a caller as this release or one before writes it', async () => {
    assert.deepEqual(await callerAt(CALLER_123), { version: '1.2.3', branch: 'main' });
    assert.deepEqual(await callerAt(guardCaller('release/1.0', '1.2.3')), { version: '1.2.3', branch: 'release/1.0' });
    assert.deepEqual(await callerAt(guardCaller('main', '10.20.30')), { version: '10.20.30', branch: 'main' }, 'each part of a release may have several digits');
    assert.deepEqual(await callerAt(CALLER_0720), { version: '0.7.20', branch: 'main', older: true });
    assert.deepEqual(await callerAt(`# Our note.\n${CALLER_0720.replaceAll('\n\n', '\n')}`), { version: '0.7.20', branch: 'main', older: true }, 'comments and layout do not count');
  });

  it('reads nothing from any other file', async () => {
    for (const text of [
      'on: [',
      '',
      'null',
      'on: push\n',
      'jobs: {}\n',
      'on:\n  pull_request_target: {}\njobs:\n  niyam-guard: {}\n',
      'on:\n  pull_request_target:\n    types: [opened]\n',
      CALLER_123.replace('@v1.2.3', '@vx1.2.3'),
      CALLER_123.replace('@v1.2.3', '@main'),
      CALLER_123.replace('@v1.2.3', '@v1.2'),
      CALLER_123.replace('uses: veda-hq', 'uses: other/veda-hq'),
      CALLER_123.replace('shared-guard.yml@v1.2.3', 'shared-guard.yml@v1.2.3x'),
      CALLER_123.replace('branches: ["main"]', 'branches: ["main", "next"]'),
      CALLER_123.replace('branches: ["main"]', 'branches: []'),
      CALLER_123.replace('branches: ["main"]', 'branches: [1]'),
      CALLER_123.replace('branches: ["main"]', 'branches: main'),
      CALLER_123.replace('types: [opened, edited, synchronize, reopened]', 'types: [opened]'),
      CALLER_123.replace("'edited'", "'opened'"),
      CALLER_123.replace('  niyam-guard:', '  guard:'),
      CALLER_0720.replace('    permissions:\n      contents', '    if: true\n    permissions:\n      contents'),
    ]) {
      assert.equal(await callerAt(text), undefined, text);
    }
  });

  it("takes a file onboard's whose header is onboard's, or that is the caller whatever its header", async () => {
    assert.equal(await callerIsOnboards(CALLER_123), true);
    assert.equal(await callerIsOnboards(`${CALLER_123.split('\n').slice(0, 1).join('\n')}\non: push\n`), true);
    assert.equal(await callerIsOnboards(CALLER_123.split('\n').filter((line) => !line.startsWith('#')).join('\n')), true);
    assert.equal(await callerIsOnboards(`# Ours.\n${CALLER_123.replace('@v1.2.3', '@main')}`), false);
  });
});

describe('callerPins', () => {
  it('reads each line that calls the shared Guard at a release, quoted or with a comment', () => {
    assert.deepEqual(callerPins(CALLER_123), ['1.2.3']);
    assert.deepEqual(callerPins(`    uses: "${SHARED_GUARD}@v2.0.0" # pinned\n  uses: '${SHARED_GUARD}@v3.1.4'\nuses: ${SHARED_GUARD}@main\n`), ['2.0.0', '3.1.4']);
    assert.deepEqual(callerPins(`    uses: x${SHARED_GUARD}@v2.0.0\n`), []);
  });
});

describe('pushBranch', () => {
  it('reads the one branch pushes run on, else nothing', async () => {
    assert.equal(await pushBranch('on:\n  push:\n    branches: [trunk]\n'), 'trunk');
    for (const text of ['on:\n  push:\n    branches: [a, b]\n', 'on:\n  push:\n    branches: []\n', 'on:\n  push:\n    branches: [1]\n', 'on:\n  push:\n    branches: a\n', 'on: push\n', 'null', '', 'on: [', 'jobs: {}\n', 'on:\n  pull_request: {}\n']) {
      assert.equal(await pushBranch(text), undefined, text);
    }
  });
});

describe('callerUpdate, callerDetail and callerWhat', () => {
  const holds = (branch: string) => `on each pull request to ${branch} it runs veda-hq/niyam's Guard at v1.2.3, the release .github/workflows/niyam.yml pins, as the check niyam-guard / judge, and does nothing else`;

  it('writes a missing caller, and leaves one as it is', () => {
    const write = callerUpdate(undefined, undefined, 'main', '1.2.3');
    assert.deepEqual(write, { kind: 'write', text: CALLER_123 });
    assert.equal(write.kind !== 'same' && callerDetail(write, '1.2.3'), 'new, the shared Guard at v1.2.3');
    assert.equal(write.kind !== 'same' && callerWhat(write, '1.2.3', 'main'), `write ${GUARD_CALLER_PATH}, the shared Guard's caller: ${holds('main')}`);
    assert.deepEqual(callerUpdate(CALLER_123, { version: '1.2.3', branch: 'main' }, 'main', '1.2.3'), { kind: 'same' });
  });

  it('writes again one only its layout or a hand changed, or one it cannot place', () => {
    for (const [before, at] of [
      [`# Ours.\n${guardCaller('trunk', '1.2.3')}`, { version: '1.2.3', branch: 'trunk' }],
      ['on: push\n', undefined],
    ] as const) {
      const update = callerUpdate(before, at, 'trunk', '1.2.3');
      assert.deepEqual(update, { kind: 'rewrite', text: guardCaller('trunk', '1.2.3') });
      assert.equal(update.kind !== 'same' && callerDetail(update, '1.2.3'), 'written again');
      assert.equal(update.kind !== 'same' && callerWhat(update, '1.2.3', 'trunk'), `write ${GUARD_CALLER_PATH}, the shared Guard's caller, again as onboard writes it: ${holds('trunk')}`);
    }
  });

  it('moves the pin, the branch, and adds the queue-draft skip, each said in the plan and the pull request', () => {
    const all = callerUpdate(CALLER_0720, { version: '0.7.20', branch: 'main', older: true }, 'trunk', '1.2.3');
    assert.deepEqual(all, { kind: 'repin', text: guardCaller('trunk', '1.2.3'), from: '0.7.20', branch: 'trunk', drafts: true });
    assert.equal(all.kind !== 'same' && callerDetail(all, '1.2.3'), "pin → v1.2.3, branch → trunk, skips Mergify's queue-draft edits");
    assert.equal(
      all.kind !== 'same' && callerWhat(all, '1.2.3', 'trunk'),
      `in ${GUARD_CALLER_PATH}, the shared Guard's caller, move its pin from v0.7.20 to v1.2.3 and run it on pull requests to the default branch, trunk and skip an edit of Mergify's queue draft that changes no title or base, so the draft's last niyam-guard / judge at its head stands`,
    );
    const pin = callerUpdate(guardCaller('main', '1.0.0'), { version: '1.0.0', branch: 'main' }, 'main', '1.2.3');
    assert.deepEqual(pin, { kind: 'repin', text: CALLER_123, from: '1.0.0' });
    assert.equal(pin.kind !== 'same' && callerDetail(pin, '1.2.3'), 'pin → v1.2.3');
    assert.equal(pin.kind !== 'same' && callerWhat(pin, '1.2.3', 'main'), `in ${GUARD_CALLER_PATH}, the shared Guard's caller, move its pin from v1.0.0 to v1.2.3`);
    const moved = callerUpdate(guardCaller('main', '1.2.3'), { version: '1.2.3', branch: 'main' }, 'trunk', '1.2.3');
    assert.deepEqual(moved, { kind: 'repin', text: guardCaller('trunk', '1.2.3'), branch: 'trunk' });
    assert.equal(moved.kind !== 'same' && callerDetail(moved, '1.2.3'), 'branch → trunk');
    assert.equal(moved.kind !== 'same' && callerWhat(moved, '1.2.3', 'trunk'), `in ${GUARD_CALLER_PATH}, the shared Guard's caller, run it on pull requests to the default branch, trunk`);
    const drafts = callerUpdate(guardCaller('main', '1.2.3', true), { version: '1.2.3', branch: 'main', older: true }, 'main', '1.2.3');
    assert.deepEqual(drafts, { kind: 'repin', text: CALLER_123, drafts: true });
    assert.equal(drafts.kind !== 'same' && callerDetail(drafts, '1.2.3'), "skips Mergify's queue-draft edits");
    assert.equal(
      drafts.kind !== 'same' && callerWhat(drafts, '1.2.3', 'main'),
      `in ${GUARD_CALLER_PATH}, the shared Guard's caller, skip an edit of Mergify's queue draft that changes no title or base, so the draft's last niyam-guard / judge at its head stands`,
    );
  });
});

describe('policySteps', () => {
  it('names the policy a public repository needs for the caller, with its settings page', () => {
    assert.deepEqual(policySteps('o/r'), {
      byHand: `Once for o/r: allow pull_request_target for ${GUARD_CALLER_PATH} in a new policy under Settings → Actions → Policies, at https://github.com/o/r/settings/actions, since from 2026-12-02 GitHub blocks it in public repositories without one; skip it if done.`,
      later: `Allow pull_request_target for \`${GUARD_CALLER_PATH}\` in a new policy under o/r → Settings → Actions → Policies (https://github.com/o/r/settings/actions): from 2026-12-02 GitHub blocks the event in public repositories without one, and the shared Guard's caller runs on it alone.`,
    });
  });
});
