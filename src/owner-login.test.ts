import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { OWNER_TOKEN } from './fake-board.test.ts';
import { FakeSys, HOME } from './fake.test.ts';
import { asOwner, isOrganisation, ownerScopes, signInLines, signInOnce } from './owner-login.ts';

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

  it('asks gh for no extra scopes when the run needs none, and for each it needs, comma-separated', async () => {
    const sys = approving();
    await signInOnce(sys, []);
    assert.deepEqual(sys.calls[0]?.args, ['auth', 'login', '--web', '-h', 'github.com', '-p', 'ssh', '--skip-ssh-key', '--insecure-storage']);
    const both = approving();
    await signInOnce(both, ['project', 'admin:org']);
    assert.deepEqual(both.calls[0]?.args.slice(-2), ['-s', 'project,admin:org']);
  });

  it("shows the one-time code and the link from gh's sign-in, opens the link, and drops gh's notes on its setup", async () => {
    const sys = approving();
    const shown: string[] = [];
    await signInOnce(sys, ['project'], (line) => shown.push(line));
    assert.deepEqual(shown, ['one-time code 1881-F156 (copied)', 'approve it at https://github.com/login/device']);
    assert.deepEqual(sys.opened, ['https://github.com/login/device']);
  });

  it('takes a sign-in GitHub names no scopes for as having none', async () => {
    const sys = approving();
    sys.http = () => Promise.resolve({ status: 200, json: { login: 'example-owner' } });
    assert.deepEqual(await signInOnce(sys, []), { login: 'example-owner', token: OWNER_TOKEN, scopes: [] });
    sys.http = () => Promise.resolve({ status: 200, json: { login: 'example-owner' }, headers: { 'x-oauth-scopes': '' } });
    assert.deepEqual(await signInOnce(sys, []), { login: 'example-owner', token: OWNER_TOKEN, scopes: [] });
  });

  for (const [name, change, problem] of [
    [
      'gh failing as it prints a token',
      (sys: FakeSys) => (sys.execOverride = (call) => (call.args[1] === 'token' ? { code: 1, stdout: 'gho_half\n', stderr: '' } : undefined)),
      'gh did not hand over the token from the sign-in',
    ],
    [
      'GitHub refusing the token with a login',
      (sys: FakeSys) => (sys.http = () => Promise.resolve({ status: 403, json: { login: 'example-owner' } })),
      'GitHub did not accept the token from the sign-in (HTTP 403)',
    ],
    ['GitHub naming no login', (sys: FakeSys) => (sys.http = () => Promise.resolve({ status: 200, json: {} })), 'GitHub did not accept the token from the sign-in (HTTP 200)'],
  ] as const) {
    it(`says why after ${name}`, async () => {
      const sys = approving();
      change(sys);
      assert.deepEqual(await signInOnce(sys, []), { problem });
      assert.deepEqual(sys.removed, sys.temps);
    });
  }

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

describe('signInLines', () => {
  /** What the owner is shown of `lines`, and the links opened. */
  function shownOf(lines: string[]): { shown: string[]; opened: string[] } {
    const sys = new FakeSys();
    const shown: string[] = [];
    const line = signInLines(sys, (text) => shown.push(text));
    for (const raw of lines) line(raw);
    return { shown, opened: sys.opened };
  }

  it('shows the one-time code, saying when gh copied it', () => {
    assert.deepEqual(shownOf(['  ! One-time code (1881-F156) copied to clipboard  ', 'First copy your one-time code: AB12-CD34']).shown, [
      'one-time code 1881-F156 (copied)',
      'one-time code AB12-CD34',
    ]);
  });

  it('shows and opens a link gh asks to open in the browser', () => {
    assert.deepEqual(shownOf(['Open this URL to continue in your web browser: https://github.com/login/device ']), {
      shown: ['approve it at https://github.com/login/device'],
      opened: ['https://github.com/login/device'],
    });
  });

  it('shows any other line as gh wrote it, trimmed: a link not for the browser, a browser with no link, an error', () => {
    assert.deepEqual(shownOf(['See https://docs.github.com/x for more', ' Press Enter to open your browser', 'error: no network ', 'saved a tip', 'so did you know']), {
      shown: ['See https://docs.github.com/x for more', 'Press Enter to open your browser', 'error: no network', 'saved a tip', 'so did you know'],
      opened: [],
    });
  });

  it("drops empty lines, and gh's tips and notes on its own setup", () => {
    const sys = new FakeSys();
    assert.deepEqual(
      shownOf(['', '   ', ...sys.ghSignedInLines, ' Tip: gh help', 'Did you know? gh browse opens the repository']).shown,
      [],
    );
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
    assert.deepEqual(asOwner(signed, 'example-owner', ['admin:org', 'workflow']), { problem: 'the GitHub sign-in did not grant admin:org, workflow' });
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

  it('refuses to guess from a refusal that names a type, or an answer that names none', async () => {
    const sys = new FakeSys();
    sys.route('GET', '/users/refused', { status: 403, json: { type: 'User' } });
    sys.route('GET', '/users/untyped', { status: 200, json: { login: 'untyped' } });
    await assert.rejects(isOrganisation(sys, 'refused', 'ghp_agent'), { message: 'cannot tell whether refused is an organisation (HTTP 403)' });
    await assert.rejects(isOrganisation(sys, 'untyped', 'ghp_agent'), { message: 'cannot tell whether untyped is an organisation (HTTP 200)' });
  });

  it('keeps the bare status for a 403 that is not the rate limit', async () => {
    const sys = new FakeSys();
    sys.route('GET', '/users/veda-hq', { status: 403, json: null, headers: { 'x-ratelimit-remaining': '12' } });
    await assert.rejects(isOrganisation(sys, 'veda-hq', undefined), { message: 'cannot tell whether veda-hq is an organisation (HTTP 403)' });
  });
});
