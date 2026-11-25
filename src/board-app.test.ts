import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import sodium from 'libsodium-wrappers';

import { BOARD_APP_PERMISSIONS, BOARD_APP_WAIT_MS, BOARD_SECRETS, boardAppManifest, boardAppName, boardAppSteps, setUpBoardApp, startPage } from './board-app.ts';
import { REPO_ID, repoJson } from './fake-board.test.ts';
import type { Pair } from './fake-secrets.test.ts';
import { FakeSys, capture } from './fake.test.ts';
import type { ServeAnswer } from './types.ts';

const SLUG = 'example-org/example-app';
const OWNER = 'gho_owner';
const ORG_SECRETS = '/orgs/example-org/actions/secrets';
const INSTALLATIONS = '/orgs/example-org/installations?per_page=100&page=1';
const CODE = 'code-1';
const APP = { id: 9, slug: 'niyam-board-example-org', client_id: 'Iv23liExample', pem: '-----BEGIN RSA PRIVATE KEY-----\nMIIexample\n-----END RSA PRIVATE KEY-----\n' };
const BY_HAND =
  'Once for example-org: make a GitHub App with organization Projects read and write and repository Issues read at https://github.com/organizations/example-org/settings/apps/new, ' +
  'install it on example-org/example-app, and set its client id as NIYAM_BOARD_APP_ID and its private key as NIYAM_BOARD_APP_KEY, Actions secrets of the organization or of https://github.com/example-org/example-app/settings/secrets/actions. ' +
  'Until then a slice moves to In Progress on the board only from a desktop push.';
/** The longest a run waits, in sleeps: ten minutes for Create at 500 ms, then ten for Install at 3 s. */
const MOST_SLEEPS = 1200 + 200;
const TEXT = { 'content-type': 'text/plain; charset=utf-8' };

/** The value in an HTML attribute, as a browser reads it. */
function unescape(text: string): string {
  return text.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

interface Browser {
  start?: ServeAnswer;
  made?: ServeAnswer;
  state?: string;
  manifest?: Record<string, unknown>;
  action?: string;
}

/**
 * An organisation with no board app, the repository found, and a browser
 * that loads the start page and, as the owner clicks Create, comes back to
 * `/made` with GitHub's code and the state the page carried (or `state`).
 */
async function noApp(click: 'create' | 'none' = 'create', state?: string): Promise<{ sys: FakeSys; browser: Browser; pair: Pair }> {
  await sodium.ready;
  const pair = sodium.crypto_box_keypair();
  const sys = new FakeSys();
  // Each wait lets the test's own browser act, as time passing would; a wait past the longest a run can take fails.
  sys.sleep = (ms) => {
    sys.slept.push(ms);
    if (sys.slept.length > MOST_SLEEPS) return Promise.reject(new Error('slept past every wait'));
    return new Promise((resolve) => setImmediate(resolve));
  };
  sys.route('GET', `/repos/${SLUG}`, { status: 200, json: repoJson() });
  sys.route('GET', `${ORG_SECRETS}?per_page=100&page=1`, { status: 200, json: { secrets: [{ name: 'FIGMA_TOKEN' }] } });
  sys.route('GET', `${ORG_SECRETS}/public-key`, { status: 200, json: { key_id: 'org-key', key: Buffer.from(pair.publicKey).toString('base64') } });
  for (const name of BOARD_SECRETS) sys.route('PUT', `${ORG_SECRETS}/${name}`, { status: 201, json: null });
  sys.route('POST', `/app-manifests/${CODE}/conversions`, { status: 201, json: APP });
  // GitHub lists the installation from the second look on: the owner clicks Install a moment after.
  let looks = 0;
  sys.route('GET', INSTALLATIONS, () => ({ status: 200, json: { installations: looks++ === 0 ? [] : [{ id: 91, app_slug: APP.slug, repository_selection: 'selected' }] } }));
  sys.route('PUT', `/user/installations/91/repositories/${REPO_ID}`, { status: 204, json: null });
  const browser: Browser = {};
  sys.browse = (url) => {
    if (!url.endsWith('/start')) return;
    (async () => {
      browser.start = await sys.visit(url);
      const body = browser.start.body ?? '';
      browser.action = unescape(/action="([^"]*)"/.exec(body)?.[1] ?? '');
      browser.state = new URL(browser.action).searchParams.get('state') ?? '';
      browser.manifest = JSON.parse(unescape(/name="manifest" value="([^"]*)"/.exec(body)?.[1] ?? '{}')) as Record<string, unknown>;
      if (click === 'create') browser.made = await sys.visit(`http://127.0.0.1:${FakeSys.PORT}/made?code=${CODE}&state=${state ?? browser.state}`);
    })().catch((error: unknown) => {
      // A browser that failed shows as a missing page, which each test's assertions name.
      browser.made = { status: -1, body: String(error) };
    });
  };
  return { sys, browser, pair };
}

/** The org secret PUT for `name`, its value opened with `pair`. */
function orgSecret(sys: FakeSys, pair: Pair, name: string): { value: string; body: Record<string, unknown>; token: string | undefined } {
  const put = sys.requests.find((r) => r.method === 'PUT' && r.url.endsWith(`${ORG_SECRETS}/${name}`));
  const body = put?.body as Record<string, unknown> & { encrypted_value: string };
  const value = new TextDecoder().decode(sodium.crypto_box_seal_open(Buffer.from(body.encrypted_value, 'base64'), pair.publicKey, pair.privateKey));
  return { value, body, token: put?.token };
}

describe('the board app', () => {
  it('is named for its organization, within the 34 characters GitHub takes', () => {
    assert.equal(boardAppName('example-org'), 'niyam board example-org');
    assert.equal(boardAppName('an-organization-with-a-long-name-x'), 'niyam board an-organization-with-a');
    assert.equal(boardAppName('an-organization-with-a-long-name-x').length, 34);
    // A cut that ends in a space drops it.
    assert.equal(boardAppName(`${'x'.repeat(21)} tail`), `niyam board ${'x'.repeat(21)}`);
  });

  it('says what the owner does by hand, naming the secrets missing, and the ones that may be set already', () => {
    assert.equal(boardAppSteps(SLUG, BOARD_SECRETS), BY_HAND);
    assert.equal(
      boardAppSteps(SLUG, ['NIYAM_BOARD_APP_KEY'], true),
      'Unless example-org/example-app has the Actions secrets NIYAM_BOARD_APP_ID and NIYAM_BOARD_APP_KEY already, once for example-org: make a GitHub App with organization Projects read and write and repository Issues read at https://github.com/organizations/example-org/settings/apps/new, ' +
        'install it on example-org/example-app, and set its private key as NIYAM_BOARD_APP_KEY, Actions secrets of the organization or of https://github.com/example-org/example-app/settings/secrets/actions. ' +
        'Until then a slice moves to In Progress on the board only from a desktop push.',
    );
  });

  it("asks for organization Projects write and Issues read alone, with no webhook, and sends the owner back to onboard's page", () => {
    assert.deepEqual(boardAppManifest('example-org', 'http://127.0.0.1:47001/made'), {
      name: 'niyam board example-org',
      url: 'https://github.com/veda-hq/niyam',
      description: 'Moves a slice to In Progress on the board when its pull request opens. Made by niyam onboard.',
      hook_attributes: { url: 'https://github.com/veda-hq/niyam', active: false },
      redirect_url: 'http://127.0.0.1:47001/made',
      public: false,
      default_permissions: { organization_projects: 'write', issues: 'read' },
      default_events: [],
    });
  });

  it("posts the manifest from its page, escaped, to the organization's new-app page with the run's state", () => {
    assert.equal(
      startPage('example-org', { name: 'a "quoted" <name> & more' }, 'abc'),
      [
        '<!doctype html><meta charset="utf-8"><title>niyam: the board app</title>',
        '<form id="make" method="post" action="https://github.com/organizations/example-org/settings/apps/new?state=abc">',
        '<input type="hidden" name="manifest" value="{&quot;name&quot;:&quot;a \\&quot;quoted\\&quot; &lt;name&gt; &amp; more&quot;}">',
        '<p>Taking you to GitHub to make the board app. <button>Go on</button></p>',
        '</form>',
        '<script>document.getElementById("make").submit()</script>',
      ].join('\n'),
    );
  });

  describe('made from the manifest', () => {
    it('sets its client id and key as organization secrets for the repository alone, sends the browser to install it, and adds the repository to it', async () => {
      const { sys, browser, pair } = await noApp();
      // Everything written to disk, kept though a file is removed after.
      const written: string[] = [];
      for (const method of ['write', 'append', 'replace'] as const) {
        const original = sys[method].bind(sys);
        sys[method] = (path: string, data: string, mode?: number) => {
          written.push(path, data);
          original(path, data, mode);
        };
      }
      const { io, out } = capture();
      assert.deepEqual(await setUpBoardApp(sys, io, SLUG, OWNER), []);
      assert.deepEqual(sys.opened, [`http://127.0.0.1:${FakeSys.PORT}/start`]);
      assert.deepEqual([browser.start?.status, browser.start?.headers], [200, { 'content-type': 'text/html; charset=utf-8' }]);
      assert.match(browser.state ?? '', /^[0-9a-f]{32}$/);
      assert.equal(browser.action, `https://github.com/organizations/example-org/settings/apps/new?state=${browser.state}`);
      assert.deepEqual(browser.manifest, {
        name: 'niyam board example-org',
        url: 'https://github.com/veda-hq/niyam',
        description: 'Moves a slice to In Progress on the board when its pull request opens. Made by niyam onboard.',
        hook_attributes: { url: 'https://github.com/veda-hq/niyam', active: false },
        redirect_url: `http://127.0.0.1:${FakeSys.PORT}/made`,
        public: false,
        default_permissions: { organization_projects: 'write', issues: 'read' },
        default_events: [],
      });
      // It stops waiting for Create once GitHub came back, and for Install once GitHub lists it: one wait, on the first look.
      assert.deepEqual(sys.slept.filter((ms) => ms === 500), [500]);
      assert.deepEqual(sys.slept.filter((ms) => ms === 3000), [3000]);
      assert.ok(
        sys.requests.filter((r) => r.url.includes(`/repos/${SLUG}`) || r.url.includes('/installations?')).every((r) => r.token === OWNER),
        'GitHub is asked as the owner',
      );
      assert.deepEqual(browser.made, { status: 302, headers: { location: `https://github.com/apps/${APP.slug}/installations/new` } });
      assert.equal(sys.servedClosed, 1, 'nothing is served once GitHub came back');
      const id = orgSecret(sys, pair, 'NIYAM_BOARD_APP_ID');
      const key = orgSecret(sys, pair, 'NIYAM_BOARD_APP_KEY');
      assert.deepEqual([id.value, key.value], [APP.client_id, APP.pem]);
      assert.deepEqual([id.body.visibility, id.body.selected_repository_ids, id.body.key_id, id.token], ['selected', [REPO_ID], 'org-key', OWNER]);
      assert.ok(!JSON.stringify(sys.requests.map((r) => r.body)).includes('MIIexample'), 'the key never goes out in the clear');
      assert.ok(!out.join('\n').includes('MIIexample'), 'nor is it printed');
      assert.ok(![...sys.files.values(), ...written].some((text) => text.includes('MIIexample')), 'nor written to disk, even to a file removed after');
      assert.ok(sys.requests.some((r) => r.method === 'PUT' && r.url.endsWith(`/user/installations/91/repositories/${REPO_ID}`)));
      assert.deepEqual(out, [`✓ made the board app ${APP.slug} and set NIYAM_BOARD_APP_ID and NIYAM_BOARD_APP_KEY, shared with ${SLUG}`, `✓ installed the board app on ${SLUG}`]);
    });

    it('looks again after each wait until GitHub lists the install, and takes only the app it made', async () => {
      const { sys } = await noApp();
      let looks = 0;
      const installations = [{ id: 5, app_slug: 'someone-else', repository_selection: 'selected' }, { id: 91, app_slug: APP.slug, repository_selection: 'selected' }];
      sys.route('GET', INSTALLATIONS, () => ({ status: 200, json: { installations: looks++ < 2 ? [] : installations } }));
      assert.deepEqual(await setUpBoardApp(sys, capture().io, SLUG, OWNER), []);
      assert.deepEqual(sys.slept.filter((ms) => ms === 3000), [3000, 3000]);
      assert.deepEqual(sys.requests.filter((r) => r.url.includes('/user/installations/')).map((r) => r.url), [`https://api.github.com/user/installations/91/repositories/${REPO_ID}`]);
    });

    it('leaves an installation on all repositories as it is', async () => {
      const { sys } = await noApp();
      sys.route('GET', INSTALLATIONS, { status: 200, json: { installations: [{ id: 91, app_slug: APP.slug, repository_selection: 'all' }] } });
      assert.deepEqual(await setUpBoardApp(sys, capture().io, SLUG, OWNER), []);
      assert.ok(!sys.requests.some((r) => r.url.includes('/user/installations/')));
    });

    it("refuses a redirect without the run's state, and a second one with it", async () => {
      const { sys, browser } = await noApp('create', 'not-the-state');
      const left = await setUpBoardApp(sys, capture().io, SLUG, OWNER);
      assert.deepEqual(browser.made, { status: 400, headers: TEXT, body: "This is not GitHub's answer to this run of niyam onboard.\n" });
      assert.ok(!sys.requests.some((r) => r.url.includes('/app-manifests/')), 'no code is turned into an app');
      assert.deepEqual(left, [`${BY_HAND} onboard opened GitHub's page for it, but no app was made within 10 minutes.`]);
      assert.equal(sys.slept.reduce((sum, ms) => sum + ms, 0), BOARD_APP_WAIT_MS, 'it waited the ten minutes');

      // The browser loads the start page alone; the test comes back twice, the second time before the first is answered.
      const replay = await noApp('none');
      const run = setUpBoardApp(replay.sys, capture().io, SLUG, OWNER);
      await new Promise((resolve) => setImmediate(resolve));
      const state = replay.browser.state ?? '';
      const first = replay.sys.visit(`http://127.0.0.1:${FakeSys.PORT}/made?code=${CODE}&state=${state}`);
      const again = await replay.sys.visit(`http://127.0.0.1:${FakeSys.PORT}/made?code=${CODE}&state=${state}`);
      assert.equal((await first).status, 302);
      assert.deepEqual(again, { status: 409, headers: TEXT, body: 'niyam onboard has this answer already; go back to the terminal.\n' });
      assert.deepEqual(await run, []);
      assert.equal(replay.sys.requests.filter((r) => r.url.includes('/app-manifests/')).length, 1);
    });

    it('answers 404 for any other page, and 400 for a redirect with no code', async () => {
      const { sys, browser } = await noApp('none');
      const run = setUpBoardApp(sys, capture().io, SLUG, OWNER);
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(await sys.visit(`http://127.0.0.1:${FakeSys.PORT}/favicon.ico`), { status: 404, headers: TEXT, body: 'Not found.\n' });
      assert.equal((await sys.visit(`http://127.0.0.1:${FakeSys.PORT}/made?state=${browser.state}`)).status, 400);
      await run;
    });

    it('leaves the steps by hand when the owner does not click Create in time', async () => {
      const { sys } = await noApp('none');
      assert.deepEqual(await setUpBoardApp(sys, capture().io, SLUG, OWNER), [`${BY_HAND} onboard opened GitHub's page for it, but no app was made within 10 minutes.`]);
      assert.equal(sys.servedClosed, 1);
    });

    it('says to delete the app and run again when GitHub will not give it, or will not take its secrets', async () => {
      const refused = await noApp();
      refused.sys.route('POST', `/app-manifests/${CODE}/conversions`, { status: 404, json: { message: 'Not Found' } });
      assert.deepEqual(await setUpBoardApp(refused.sys, capture().io, SLUG, OWNER), [
        'Once for example-org: GitHub did not give the app it made (HTTP 404). At https://github.com/organizations/example-org/settings/apps, delete the board app if it was made, then run niyam onboard again.',
      ]);
      assert.deepEqual(refused.browser.made, {
        status: 502,
        headers: TEXT,
        body: 'niyam onboard could not get the app: GitHub did not give the app it made (HTTP 404). The terminal says what is left.\n',
      });

      // Each part of the app GitHub gives is needed, and a 201 for it.
      for (const [status, json] of [
        [200, APP],
        [201, { ...APP, slug: 5 }],
        [201, { ...APP, client_id: undefined }],
        [201, { ...APP, pem: null }],
      ] as const) {
        const partial = await noApp();
        partial.sys.route('POST', `/app-manifests/${CODE}/conversions`, { status, json });
        assert.deepEqual(await setUpBoardApp(partial.sys, capture().io, SLUG, OWNER), [
          `Once for example-org: GitHub did not give the app it made (HTTP ${status}). At https://github.com/organizations/example-org/settings/apps, delete the board app if it was made, then run niyam onboard again.`,
        ], JSON.stringify(json));
      }

      const unset = await noApp();
      unset.sys.route('PUT', `${ORG_SECRETS}/NIYAM_BOARD_APP_KEY`, { status: 403, json: { message: 'Must have admin rights' } });
      assert.deepEqual(await setUpBoardApp(unset.sys, capture().io, SLUG, OWNER), [
        `Once for example-org: GitHub made the app ${APP.slug} but GitHub did not set the NIYAM_BOARD_APP_KEY secret (HTTP 403: Must have admin rights). At https://github.com/organizations/example-org/settings/apps, delete the board app if it was made, then run niyam onboard again.`,
      ]);
      assert.match(unset.browser.made?.body ?? '', /could not set its secrets/);
    });

    it('says to look for the app, not to make one, when a request fails once GitHub has the code', async () => {
      const { sys, browser } = await noApp();
      sys.route('POST', `/app-manifests/${CODE}/conversions`, () => {
        throw new Error('POST api.github.com/app-manifests: no answer');
      });
      assert.deepEqual(await setUpBoardApp(sys, capture().io, SLUG, OWNER), [
        'Once for example-org: a request to GitHub failed once it had the code (POST api.github.com/app-manifests: no answer). At https://github.com/organizations/example-org/settings/apps, delete the board app if it was made, then run niyam onboard again.',
      ]);
      assert.deepEqual(browser.made, {
        status: 502,
        headers: TEXT,
        body: 'niyam onboard could not finish: a request to GitHub failed once it had the code (POST api.github.com/app-manifests: no answer). The terminal says what is left.\n',
      });
      assert.ok(sys.slept.length < 10, 'no ten-minute wait');
    });

    it('leaves only the install when a request fails after the secrets are set', async () => {
      const { sys } = await noApp();
      sys.route('GET', INSTALLATIONS, () => {
        throw new Error('GET api.github.com/orgs/example-org/installations: no answer');
      });
      assert.deepEqual(await setUpBoardApp(sys, capture().io, SLUG, OWNER), [
        `Once for example-org: install the board app on ${SLUG} at https://github.com/apps/${APP.slug}/installations/new, if it is not there yet: onboard could not tell (GET api.github.com/orgs/example-org/installations: no answer).`,
      ]);
    });

    it('says where to install it when the owner does not click Install in time, or to add the repository when GitHub will not', async () => {
      const never = await noApp();
      never.sys.route('GET', INSTALLATIONS, { status: 200, json: { installations: [] } });
      assert.deepEqual(await setUpBoardApp(never.sys, capture().io, SLUG, OWNER), [`Once for example-org: install the board app on ${SLUG} at https://github.com/apps/${APP.slug}/installations/new.`]);
      // Ten minutes, a look every 3 s.
      assert.equal(never.sys.requests.filter((r) => r.url.endsWith(INSTALLATIONS)).length, 200);

      const refused = await noApp();
      refused.sys.route('PUT', `/user/installations/91/repositories/${REPO_ID}`, { status: 403, json: null });
      assert.deepEqual(await setUpBoardApp(refused.sys, capture().io, SLUG, OWNER), [
        `Once for ${SLUG}: add it to the board app's installation at https://github.com/organizations/example-org/settings/installations/91, since GitHub would not (HTTP 403).`,
      ]);
    });
  });

  describe('that the organization has', () => {
    it('shares its secrets and its installation with the repository, with no browser', async () => {
      const sys = new FakeSys();
      sys.route('GET', `/repos/${SLUG}`, { status: 200, json: repoJson() });
      sys.route('GET', INSTALLATIONS, { status: 200, json: { installations: [{ id: 5, app_slug: 'someone-else', repository_selection: 'selected' }, { id: 77, app_slug: 'niyam-board-example-org', repository_selection: 'selected' }] } });
      sys.route('PUT', `/user/installations/77/repositories/${REPO_ID}`, { status: 204, json: null });
      const { io, out } = capture();
      assert.deepEqual(await setUpBoardApp(sys, io, SLUG, OWNER), []);
      assert.deepEqual(sys.opened, []);
      assert.deepEqual(
        sys.requests.filter((r) => r.method === 'PUT').map((r) => r.url.replace('https://api.github.com', '')),
        [`${ORG_SECRETS}/NIYAM_BOARD_APP_ID/repositories/${REPO_ID}`, `${ORG_SECRETS}/NIYAM_BOARD_APP_KEY/repositories/${REPO_ID}`, `/user/installations/77/repositories/${REPO_ID}`],
      );
      assert.deepEqual(out, [`✓ example-org's board app secrets shared with ${SLUG}`, `✓ example-org's board app installed on ${SLUG}`]);
    });

    it('says what is left when a secret is not for selected repositories, or there is no installation', async () => {
      const sys = new FakeSys();
      sys.route('GET', `/repos/${SLUG}`, { status: 200, json: repoJson() });
      sys.route('PUT', `${ORG_SECRETS}/NIYAM_BOARD_APP_KEY/repositories/${REPO_ID}`, { status: 409, json: null });
      sys.route('PUT', `${ORG_SECRETS}/NIYAM_BOARD_APP_ID/repositories/${REPO_ID}`, { status: 500, json: null });
      sys.route('GET', INSTALLATIONS, { status: 200, json: { installations: [] } });
      const { io, out } = capture();
      assert.deepEqual(await setUpBoardApp(sys, io, SLUG, OWNER), [
        `Once for ${SLUG}: share example-org's NIYAM_BOARD_APP_ID secret with it at https://github.com/organizations/example-org/settings/secrets/actions/NIYAM_BOARD_APP_ID, since GitHub did not share example-org's NIYAM_BOARD_APP_ID secret with the repository (HTTP 500).`,
        `Once for ${SLUG}: share example-org's NIYAM_BOARD_APP_KEY secret with it at https://github.com/organizations/example-org/settings/secrets/actions/NIYAM_BOARD_APP_KEY, since example-org's NIYAM_BOARD_APP_KEY secret is visible by type of repository, not to selected ones, so GitHub will not add one to it.`,
        `Once for ${SLUG}: install example-org's board app on it at https://github.com/organizations/example-org/settings/installations.`,
      ]);
      assert.deepEqual(out, [], 'nothing is said to be shared or installed');
    });

    it('says to add the repository when GitHub will not put it on the installation', async () => {
      const sys = new FakeSys();
      sys.route('GET', `/repos/${SLUG}`, { status: 200, json: repoJson() });
      sys.route('GET', INSTALLATIONS, { status: 200, json: { installations: [{ id: 77, app_slug: 'niyam-board-example-org', repository_selection: 'selected' }] } });
      sys.route('PUT', `/user/installations/77/repositories/${REPO_ID}`, { status: 403, json: null });
      const { io, out } = capture();
      assert.deepEqual(await setUpBoardApp(sys, io, SLUG, OWNER), [
        `Once for ${SLUG}: add it to the board app's installation at https://github.com/organizations/example-org/settings/installations/77, since GitHub would not (HTTP 403).`,
      ]);
      assert.deepEqual(out, [`✓ example-org's board app secrets shared with ${SLUG}`]);
    });

    it('says to install it when GitHub will not list the installations, or lists them on one page without it', async () => {
      const install = `Once for ${SLUG}: install example-org's board app on it at https://github.com/organizations/example-org/settings/installations.`;
      const board = { id: 77, app_slug: 'niyam-board-example-org', repository_selection: 'all' };
      for (const [name, answer] of [
        ['a refusal that lists it', { status: 500, json: { installations: [board] } }],
        ['an answer of null', { status: 200, json: null }],
        ['installations that are no list', { status: 200, json: { installations: 'x' } }],
        // A page of fewer than 100 is the last: a second one is not asked for.
        ['one short page', { status: 200, json: { installations: [{ id: 5, app_slug: 'someone-else', repository_selection: 'all' }] } }],
      ] as const) {
        const sys = new FakeSys();
        sys.route('GET', `/repos/${SLUG}`, { status: 200, json: repoJson() });
        sys.route('GET', INSTALLATIONS, answer);
        sys.route('GET', '/orgs/example-org/installations?per_page=100&page=2', { status: 200, json: { installations: [board] } });
        assert.deepEqual(await setUpBoardApp(sys, capture().io, SLUG, OWNER), [install], name);
      }
    });

    it('passes over installations GitHub lists without a slug', async () => {
      const sys = new FakeSys();
      sys.route('GET', `/repos/${SLUG}`, { status: 200, json: repoJson() });
      sys.route('GET', INSTALLATIONS, { status: 200, json: { installations: [null, { id: 6 }, { id: 77, app_slug: 'niyam-board-example-org', repository_selection: 'all' }] } });
      const { io, out } = capture();
      assert.deepEqual(await setUpBoardApp(sys, io, SLUG, OWNER), []);
      assert.equal(out.at(-1), `✓ example-org's board app installed on ${SLUG}`);
    });

    it('reads every page of installations', async () => {
      const sys = new FakeSys();
      sys.route('GET', `/repos/${SLUG}`, { status: 200, json: repoJson() });
      const others = Array.from({ length: 100 }, (_, index) => ({ id: index, app_slug: `other-${index}`, repository_selection: 'all' }));
      sys.route('GET', INSTALLATIONS, { status: 200, json: { installations: others } });
      sys.route('GET', '/orgs/example-org/installations?per_page=100&page=2', { status: 200, json: { installations: [{ id: 300, app_slug: 'niyam-board-example-org', repository_selection: 'all' }] } });
      assert.deepEqual(await setUpBoardApp(sys, capture().io, SLUG, OWNER), []);
    });
  });

  it("makes no app where the repository's own secret would hide the organization's, or the organization has one of the two", async () => {
    const shadowed = await noApp();
    shadowed.sys.route('GET', `/repos/${SLUG}/actions/secrets?per_page=100&page=1`, { status: 200, json: { secrets: [{ name: 'FIGMA_TOKEN' }, { name: 'NIYAM_BOARD_APP_KEY' }] } });
    assert.deepEqual(await setUpBoardApp(shadowed.sys, capture().io, SLUG, OWNER), [
      `Once for ${SLUG}: delete its own NIYAM_BOARD_APP_KEY at https://github.com/${SLUG}/settings/secrets/actions, which would hide the organization's board app secrets, then run niyam onboard again at your own terminal.`,
    ]);
    const both = await noApp();
    both.sys.route('GET', `/repos/${SLUG}/actions/secrets?per_page=100&page=1`, { status: 200, json: { secrets: [{ name: 'NIYAM_BOARD_APP_ID' }, { name: 'NIYAM_BOARD_APP_KEY' }] } });
    assert.deepEqual(await setUpBoardApp(both.sys, capture().io, SLUG, OWNER), [
      `Once for ${SLUG}: delete its own NIYAM_BOARD_APP_ID and NIYAM_BOARD_APP_KEY at https://github.com/${SLUG}/settings/secrets/actions, which would hide the organization's board app secrets, then run niyam onboard again at your own terminal.`,
    ]);
    const half = await noApp();
    half.sys.route('GET', `${ORG_SECRETS}?per_page=100&page=1`, { status: 200, json: { secrets: [{ name: 'NIYAM_BOARD_APP_ID' }] } });
    assert.deepEqual(await setUpBoardApp(half.sys, capture().io, SLUG, OWNER), [
      "Once for example-org: it has the secret NIYAM_BOARD_APP_ID but not NIYAM_BOARD_APP_KEY. Set the board app's other one at https://github.com/organizations/example-org/settings/secrets/actions, or delete it and its app, then run niyam onboard again at your own terminal.",
    ]);
    const otherHalf = await noApp();
    otherHalf.sys.route('GET', `${ORG_SECRETS}?per_page=100&page=1`, { status: 200, json: { secrets: [{ name: 'NIYAM_BOARD_APP_KEY' }] } });
    assert.deepEqual(await setUpBoardApp(otherHalf.sys, capture().io, SLUG, OWNER), [
      "Once for example-org: it has the secret NIYAM_BOARD_APP_KEY but not NIYAM_BOARD_APP_ID. Set the board app's other one at https://github.com/organizations/example-org/settings/secrets/actions, or delete it and its app, then run niyam onboard again at your own terminal.",
    ]);
    for (const { sys } of [shadowed, both, half, otherHalf]) {
      assert.deepEqual(sys.opened, [], 'no browser');
      assert.ok(!sys.requests.some((r) => r.method === 'PUT'), 'no secret changed');
      assert.ok(!sys.requests.some((r) => r.method === 'POST'), 'no app made');
    }
  });

  it('leaves it all by hand when GitHub will not give the repository or list the secrets, or a request fails', async () => {
    const lost = new FakeSys();
    lost.route('GET', `/repos/${SLUG}`, { status: 404, json: null });
    assert.deepEqual(await setUpBoardApp(lost, capture().io, SLUG, OWNER), [`${BY_HAND} onboard did not: GitHub did not give ${SLUG}'s id (HTTP 404).`]);
    for (const [status, json] of [
      [500, repoJson()],
      [200, {}],
    ] as const) {
      const unknown = new FakeSys();
      unknown.route('GET', `/repos/${SLUG}`, { status, json });
      assert.deepEqual(await setUpBoardApp(unknown, capture().io, SLUG, OWNER), [`${BY_HAND} onboard did not: GitHub did not give ${SLUG}'s id (HTTP ${status}).`]);
    }

    const ownUnlisted = new FakeSys();
    ownUnlisted.route('GET', `/repos/${SLUG}`, { status: 200, json: repoJson() });
    ownUnlisted.route('GET', `/repos/${SLUG}/actions/secrets?per_page=100&page=1`, { status: 403, json: null });
    assert.deepEqual(await setUpBoardApp(ownUnlisted, capture().io, SLUG, OWNER), [`${BY_HAND} onboard did not: GitHub would not list ${SLUG}'s own Actions secrets.`]);

    const unlisted = new FakeSys();
    unlisted.route('GET', `/repos/${SLUG}`, { status: 200, json: repoJson() });
    unlisted.route('GET', `${ORG_SECRETS}?per_page=100&page=1`, { status: 403, json: null });
    assert.deepEqual(await setUpBoardApp(unlisted, capture().io, SLUG, OWNER), [`${BY_HAND} onboard did not: GitHub would not list example-org's Actions secrets.`]);

    const thrown = new FakeSys();
    thrown.route('GET', `/repos/${SLUG}`, () => {
      throw new Error('GET api.github.com/repos/example-org/example-app: no answer');
    });
    assert.deepEqual(await setUpBoardApp(thrown, capture().io, SLUG, OWNER), [`${BY_HAND} onboard did not: GET api.github.com/repos/example-org/example-app: no answer.`]);
  });

  it('asks for what the Slice started job asks for', () => {
    assert.deepEqual(BOARD_APP_PERMISSIONS, { organization_projects: 'write', issues: 'read' });
  });
});
