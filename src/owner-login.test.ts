import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { OWNER_TOKEN } from './fake-board.test.ts';
import { FakeSys, HOME } from './fake.test.ts';
import { asOwner, isOrganisation, ownerScopes, signInOnce } from './owner-login.ts';

/** The owner's own gh folder, holding a login the one-run sign-in must never read or change. */
const OWN_HOSTS = `${HOME}/.config/gh/hosts.yml`;
const OWN = 'github.com:\n    oauth_token: gho_owners_own\n';

/** A Mac where the owner's browser approval gives OWNER_TOKEN, and GitHub knows it as example-owner. */
function approving(): FakeSys {
  const sys = new FakeSys();
  sys.env = { GH_TOKEN: 'ghp_agent', GITHUB_TOKEN: 'ghp_agent', GH_CONFIG_DIR: `${HOME}/.config/gh`, PATH: '/usr/bin' };
  sys.files.set(OWN_HOSTS, OWN);
  sys.ghToken = OWNER_TOKEN;
  sys.acceptToken(OWNER_TOKEN, 'example-owner', { 'x-oauth-scopes': 'gist, project, read:org, repo' });
  return sys;
}

describe('signInOnce', () => {
  it('signs in through the browser into a temporary gh folder, reads the token there, and removes the folder', async () => {
    const sys = approving();
    const signed = await signInOnce(sys, ['project']);
    assert.deepEqual(signed, { login: 'example-owner', token: OWNER_TOKEN, scopes: ['gist', 'project', 'read:org', 'repo'] });
    const dir = sys.temps[0] as string;
    const gh = sys.calls.filter((c) => c.command === 'gh');
    assert.deepEqual(
      gh.map((c) => [c.args, c.interactive]),
      [
        [['auth', 'login', '--web', '-h', 'github.com', '-p', 'ssh', '--skip-ssh-key', '--insecure-storage', '-s', 'project'], true],
        [['auth', 'token', '-h', 'github.com'], undefined],
      ],
    );
    for (const call of gh) {
      assert.equal(call.env?.GH_CONFIG_DIR, dir);
      assert.equal(call.env?.GIT_CONFIG_GLOBAL, `${dir}/gitconfig`);
      assert.deepEqual([call.env?.GH_TOKEN, call.env?.GITHUB_TOKEN, call.env?.PATH], [undefined, undefined, '/usr/bin']);
    }
    assert.deepEqual(sys.removed, [dir]);
    assert.ok(![...sys.files.keys()].some((name) => name.startsWith(dir)), 'nothing of the sign-in is left');
    assert.equal(sys.files.get(OWN_HOSTS), OWN, "the owner's own gh login is untouched");
  });

  it('asks gh for no extra scopes when the run needs none', async () => {
    const sys = approving();
    await signInOnce(sys, []);
    assert.ok(!sys.calls.some((c) => c.args.includes('-s')));
  });

  for (const [name, change, problem] of [
    ['the owner turning the sign-in down', (sys: FakeSys) => (sys.ghToken = undefined), 'the GitHub sign-in in the browser did not finish'],
    [
      'gh handing over no token',
      (sys: FakeSys) => (sys.execOverride = (call) => (call.args[1] === 'token' ? { code: 0, stdout: '\n', stderr: '' } : undefined)),
      'gh did not hand over the token from the sign-in',
    ],
    ['GitHub refusing the token', (sys: FakeSys) => (sys.ghToken = 'gho_unknown'), 'GitHub did not accept the token from the sign-in (HTTP 401)'],
  ] as const) {
    it(`removes the folder and says why after ${name}`, async () => {
      const sys = approving();
      change(sys);
      assert.deepEqual(await signInOnce(sys, ['project']), { problem });
      assert.deepEqual(sys.removed, sys.temps);
      assert.equal(sys.files.get(OWN_HOSTS), OWN);
    });
  }

  it('removes the folder when GitHub cannot be reached', async () => {
    const sys = approving();
    sys.http = () => Promise.reject(new Error('offline'));
    await assert.rejects(signInOnce(sys, []), /offline/);
    assert.equal(sys.removed.length, 1);
    assert.deepEqual(sys.removed, sys.temps);
  });
});

describe('asOwner', () => {
  const signed = { login: 'Example-Owner', token: OWNER_TOKEN, scopes: ['repo', 'project'] };

  it("gives the token of the owner's sign-in, in any case", () => {
    assert.equal(asOwner(signed, 'example-owner', ['project']), OWNER_TOKEN);
  });

  it('refuses a sign-in as anyone else', () => {
    assert.deepEqual(asOwner({ ...signed, login: 'someone' }, 'example-owner', []), {
      problem: 'the browser signed in to GitHub as someone, not the owner example-owner; sign in to github.com there as example-owner and run it again',
    });
  });

  it('refuses a sign-in short of the scopes', () => {
    assert.deepEqual(asOwner(signed, 'example-owner', ['project', 'admin:org']), { problem: 'the GitHub sign-in did not grant admin:org' });
  });

  it('passes on a failed sign-in', () => {
    assert.deepEqual(asOwner({ problem: 'no' }, 'example-owner', []), { problem: 'no' });
  });
});

describe('ownerScopes', () => {
  it('asks for what the features turned on need', () => {
    assert.deepEqual(ownerScopes(['identity', 'pr-identity', 'work-rules'], true), []);
    assert.deepEqual(ownerScopes(['identity', 'board'], false), ['project']);
    assert.deepEqual(ownerScopes(['identity', 'board'], true), ['project', 'admin:org']);
  });
});

describe('isOrganisation', () => {
  it('reads the account type, and refuses to guess when GitHub will not say', async () => {
    const sys = new FakeSys();
    sys.route('GET', '/users/example-org', { status: 200, json: { login: 'example-org', type: 'Organization' } });
    sys.route('GET', '/users/someone', { status: 200, json: { login: 'someone', type: 'User' } });
    assert.equal(await isOrganisation(sys, 'example-org', undefined), true);
    assert.equal(await isOrganisation(sys, 'someone', undefined), false);
    await assert.rejects(isOrganisation(sys, 'nobody', undefined), /cannot tell whether nobody is an organisation \(HTTP 404\)/);
  });

  it('asks with the token it is given, so the read counts against the token and not this address (#546)', async () => {
    const sys = new FakeSys();
    sys.route('GET', '/users/example-org', { status: 200, json: { login: 'example-org', type: 'Organization' } });
    assert.equal(await isOrganisation(sys, 'example-org', 'ghp_agent'), true);
    assert.deepEqual(sys.requests.map((request) => request.token), ['ghp_agent']);
  });

  it('asks again with no token when GitHub refuses the token', async () => {
    const sys = new FakeSys();
    sys.route('GET', '/users/example-org', () =>
      sys.requests.at(-1)?.token ? { status: 401, json: { message: 'Bad credentials' } } : { status: 200, json: { login: 'example-org', type: 'Organization' } },
    );
    assert.equal(await isOrganisation(sys, 'example-org', 'ghp_expired'), true);
    assert.deepEqual(sys.requests.map((request) => request.token), ['ghp_expired', undefined]);
  });

  it('names the rate limit and when it resets, not a bare status, when GitHub refuses for it', async () => {
    const sys = new FakeSys();
    // The answer the owner's Mac had on 2026-11-22: no requests left of 60, resetting at 08:55:21Z.
    const limited = { 'x-ratelimit-limit': '60', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1795337721' };
    sys.route('GET', '/users/veda-hq', { status: 403, json: { message: 'API rate limit exceeded' }, headers: limited });
    await assert.rejects(
      isOrganisation(sys, 'veda-hq', undefined),
      { message: "cannot tell whether veda-hq is an organisation: GitHub's limit for requests with no token, 60 an hour from this address, has run out until 08:55 UTC (HTTP 403)" },
    );
    sys.route('GET', '/users/veda-hq', { status: 429, json: null, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1795337721' } });
    await assert.rejects(isOrganisation(sys, 'veda-hq', 'ghp_agent'), {
      message: "cannot tell whether veda-hq is an organisation: GitHub's rate limit for the token has run out until 08:55 UTC (HTTP 429)",
    });
  });

  it('keeps the bare status for a 403 that is not the rate limit', async () => {
    const sys = new FakeSys();
    sys.route('GET', '/users/veda-hq', { status: 403, json: null, headers: { 'x-ratelimit-remaining': '12' } });
    await assert.rejects(isOrganisation(sys, 'veda-hq', undefined), { message: 'cannot tell whether veda-hq is an organisation (HTTP 403)' });
  });
});
