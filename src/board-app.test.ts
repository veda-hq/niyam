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
const BY_HAND = boardAppSteps(SLUG, BOARD_SECRETS);

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
  // Each wait lets the test's own browser act, as time passing would.
  sys.sleep = (ms) => {
    sys.slept.push(ms);
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
  });

  it("asks for organization Projects write and Issues read alone, with no webhook, and sends the owner back to onboard's page", () => {
    const manifest = boardAppManifest('example-org', 'http://127.0.0.1:47001/made');
    assert.deepEqual(manifest.default_permissions, { organization_projects: 'write', issues: 'read' });
    assert.deepEqual(manifest.hook_attributes, { url: 'https://github.com/veda-hq/niyam', active: false });
    assert.deepEqual([manifest.redirect_url, manifest.public, manifest.default_events], ['http://127.0.0.1:47001/made', false, []]);
  });

  it("posts the manifest from its page, escaped, to the organization's new-app page with the run's state", () => {
    const page = startPage('example-org', { name: 'a "quoted" <name> & more' }, 'abc');
    assert.ok(page.includes('action="https://github.com/organizations/example-org/settings/apps/new?state=abc"'), page);
    assert.ok(page.includes('value="{&quot;name&quot;:&quot;a \\&quot;quoted\\&quot; &lt;name&gt; &amp; more&quot;}"'), page);
    assert.ok(page.includes('document.getElementById("make").submit()'));
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
      assert.equal(browser.start?.status, 200);
      assert.match(browser.state ?? '', /^[0-9a-f]{32}$/);
      assert.equal(browser.action, `https://github.com/organizations/example-org/settings/apps/new?state=${browser.state}`);
      assert.deepEqual(browser.manifest, boardAppManifest('example-org', `http://127.0.0.1:${FakeSys.PORT}/made`));
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

    it('leaves an installation on all repositories as it is', async () => {
      const { sys } = await noApp();
      sys.route('GET', INSTALLATIONS, { status: 200, json: { installations: [{ id: 91, app_slug: APP.slug, repository_selection: 'all' }] } });
      assert.deepEqual(await setUpBoardApp(sys, capture().io, SLUG, OWNER), []);
      assert.ok(!sys.requests.some((r) => r.url.includes('/user/installations/')));
    });

    it("refuses a redirect without the run's state, and a second one with it", async () => {
      const { sys, browser } = await noApp('create', 'not-the-state');
      const left = await setUpBoardApp(sys, capture().io, SLUG, OWNER);
      assert.equal(browser.made?.status, 400);
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
      assert.equal(again.status, 409);
      assert.deepEqual(await run, []);
      assert.equal(replay.sys.requests.filter((r) => r.url.includes('/app-manifests/')).length, 1);
    });

    it('answers 404 for any other page, and 400 for a redirect with no code', async () => {
      const { sys, browser } = await noApp('none');
      const run = setUpBoardApp(sys, capture().io, SLUG, OWNER);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal((await sys.visit(`http://127.0.0.1:${FakeSys.PORT}/favicon.ico`)).status, 404);
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
      assert.equal(refused.browser.made?.status, 502);

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
      assert.equal(browser.made?.status, 502);
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
      assert.deepEqual(await setUpBoardApp(sys, capture().io, SLUG, OWNER), [
        `Once for ${SLUG}: share example-org's NIYAM_BOARD_APP_ID secret with it at https://github.com/organizations/example-org/settings/secrets/actions/NIYAM_BOARD_APP_ID, since GitHub did not share example-org's NIYAM_BOARD_APP_ID secret with the repository (HTTP 500).`,
        `Once for ${SLUG}: share example-org's NIYAM_BOARD_APP_KEY secret with it at https://github.com/organizations/example-org/settings/secrets/actions/NIYAM_BOARD_APP_KEY, since example-org's NIYAM_BOARD_APP_KEY secret is visible by type of repository, not to selected ones, so GitHub will not add one to it.`,
        `Once for ${SLUG}: install example-org's board app on it at https://github.com/organizations/example-org/settings/installations.`,
      ]);
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
    const half = await noApp();
    half.sys.route('GET', `${ORG_SECRETS}?per_page=100&page=1`, { status: 200, json: { secrets: [{ name: 'NIYAM_BOARD_APP_ID' }] } });
    assert.deepEqual(await setUpBoardApp(half.sys, capture().io, SLUG, OWNER), [
      "Once for example-org: it has the secret NIYAM_BOARD_APP_ID but not NIYAM_BOARD_APP_KEY. Set the board app's other one at https://github.com/organizations/example-org/settings/secrets/actions, or delete it and its app, then run niyam onboard again at your own terminal.",
    ]);
    for (const { sys } of [shadowed, half]) {
      assert.deepEqual(sys.opened, [], 'no browser');
      assert.ok(!sys.requests.some((r) => r.method === 'PUT'), 'no secret changed');
      assert.ok(!sys.requests.some((r) => r.method === 'POST'), 'no app made');
    }
  });

  it('leaves it all by hand when GitHub will not give the repository or list the secrets, or a request fails', async () => {
    const lost = new FakeSys();
    lost.route('GET', `/repos/${SLUG}`, { status: 404, json: null });
    assert.deepEqual(await setUpBoardApp(lost, capture().io, SLUG, OWNER), [`${BY_HAND} onboard did not: GitHub did not give ${SLUG}'s id (HTTP 404).`]);

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
