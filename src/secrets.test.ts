import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import sodium from 'libsodium-wrappers';

import { actionsKey, sealedValue } from './fake-secrets.test.ts';
import { FakeSys } from './fake.test.ts';
import { orgSecretNames, repoSecretNames, secretNames, setOrgSecret, setSecret, shareOrgSecret } from './secrets.ts';

const REPO = '/repos/example-org/example-app/actions/secrets';
const VALUE = 'LibKey0123abc';

describe('setSecret', () => {
  it("seals the value with the repository's Actions public key and stores it", async () => {
    const sys = new FakeSys();
    const pair = await actionsKey(sys);
    assert.equal(await setSecret(sys, 'example-org/example-app', 'gho_owner', 'FIGMA_LIBRARY', VALUE), undefined);
    const sent = sealedValue(sys, pair);
    assert.deepEqual([sent.value, sent.keyId, sent.token], [VALUE, 'key-1', 'gho_owner']);
    assert.ok(!sent.encrypted.includes(VALUE));
    assert.ok(!JSON.stringify(sys.requests).includes(VALUE), 'the value never leaves in the clear');
  });

  it('takes a replaced secret too', async () => {
    const sys = new FakeSys();
    const pair = await actionsKey(sys, { status: 204, json: null });
    assert.equal(await setSecret(sys, 'example-org/example-app', 'gho_owner', 'FIGMA_LIBRARY', VALUE), undefined);
    assert.equal(sealedValue(sys, pair).value, VALUE, 'the existing secret is replaced with the sealed value');
  });

  it('says why when GitHub gives no public key, or one that is not a key', async () => {
    const sys = new FakeSys();
    assert.equal(
      await setSecret(sys, 'example-org/example-app', 'gho_owner', 'FIGMA_LIBRARY', VALUE),
      "GitHub did not give example-org/example-app's Actions public key (HTTP 404), so the FIGMA_LIBRARY secret is not set",
    );
    sys.route('GET', `${REPO}/public-key`, { status: 200, json: { key_id: 'key-1', key: 'c2hvcnQ=' } });
    assert.equal(
      await setSecret(sys, 'example-org/example-app', 'gho_owner', 'FIGMA_LIBRARY', VALUE),
      "example-org/example-app's Actions public key is not one a secret can be sealed with, so the FIGMA_LIBRARY secret is not set",
    );
    assert.ok(!sys.requests.some((r) => r.method === 'PUT'));
  });

  it('says why GitHub refused the secret, never naming the value', async () => {
    for (const [json, said] of [
      [{ message: 'Must have admin rights to Repository.' }, 'GitHub did not set the FIGMA_LIBRARY secret (HTTP 403: Must have admin rights to Repository.)'],
      [null, 'GitHub did not set the FIGMA_LIBRARY secret (HTTP 403)'],
    ] as const) {
      const sys = new FakeSys();
      await actionsKey(sys, { status: 403, json });
      assert.equal(await setSecret(sys, 'example-org/example-app', 'gho_owner', 'FIGMA_LIBRARY', VALUE), said);
    }
    const sys = new FakeSys();
    await actionsKey(sys, { status: 422, json: { message: 7 } });
    assert.equal(await setSecret(sys, 'example-org/example-app', 'gho_owner', 'FIGMA_LIBRARY', VALUE), 'GitHub did not set the FIGMA_LIBRARY secret (HTTP 422)');
    await actionsKey(sys, { status: 200, json: null });
    assert.equal(await setSecret(sys, 'example-org/example-app', 'gho_owner', 'FIGMA_LIBRARY', VALUE), 'GitHub did not set the FIGMA_LIBRARY secret (HTTP 200)');
  });

  it('takes no public key GitHub gives without its id, as text, or with another status', async () => {
    const refused = "GitHub did not give example-org/example-app's Actions public key";
    for (const [status, json] of [
      [200, null],
      [200, { key: 'c2hvcnQ=' }],
      [200, { key_id: 1, key: 'c2hvcnQ=' }],
      [200, { key_id: 'key-1' }],
      [200, { key_id: 'key-1', key: 7 }],
      [201, { key_id: 'key-1', key: 'c2hvcnQ=' }],
    ] as const) {
      const sys = new FakeSys();
      sys.route('GET', `${REPO}/public-key`, { status, json });
      assert.equal(
        await setSecret(sys, 'example-org/example-app', 'gho_owner', 'FIGMA_LIBRARY', VALUE),
        `${refused} (HTTP ${status}), so the FIGMA_LIBRARY secret is not set`,
        JSON.stringify(json),
      );
      assert.deepEqual(
        sys.requests.map((r) => [r.method, r.url, r.token]),
        [['GET', `https://api.github.com${REPO}/public-key`, 'gho_owner']],
      );
    }
  });
});

const ORG = '/orgs/example-org/actions/secrets';

describe('setOrgSecret', () => {
  it("seals the value with the organization's Actions public key and shares it with the selected repositories alone", async () => {
    await sodium.ready;
    const pair = sodium.crypto_box_keypair();
    const sys = new FakeSys();
    sys.route('GET', `${ORG}/public-key`, { status: 200, json: { key_id: 'org-key', key: Buffer.from(pair.publicKey).toString('base64') } });
    sys.route('PUT', `${ORG}/NIYAM_BOARD_APP_KEY`, { status: 201, json: null });
    assert.equal(await setOrgSecret(sys, 'example-org', 'gho_owner', 'NIYAM_BOARD_APP_KEY', VALUE, [41, 42]), undefined);
    assert.deepEqual(
      sys.requests.map((r) => [r.method, r.url, r.token]),
      [
        ['GET', `https://api.github.com${ORG}/public-key`, 'gho_owner'],
        ['PUT', `https://api.github.com${ORG}/NIYAM_BOARD_APP_KEY`, 'gho_owner'],
      ],
    );
    const { encrypted_value: encrypted, ...rest } = sys.requests[1]?.body as { encrypted_value: string };
    assert.deepEqual(rest, { key_id: 'org-key', visibility: 'selected', selected_repository_ids: [41, 42] });
    assert.equal(new TextDecoder().decode(sodium.crypto_box_seal_open(Buffer.from(encrypted, 'base64'), pair.publicKey, pair.privateKey)), VALUE);
  });

  it('says why, naming the organization, when GitHub gives no key or refuses the secret', async () => {
    const sys = new FakeSys();
    assert.equal(
      await setOrgSecret(sys, 'example-org', 'gho_owner', 'NIYAM_BOARD_APP_KEY', VALUE, [41]),
      "GitHub did not give example-org's Actions public key (HTTP 404), so the NIYAM_BOARD_APP_KEY secret is not set",
    );
    assert.ok(!sys.requests.some((r) => r.method === 'PUT'));
    sys.route('GET', `${ORG}/public-key`, { status: 200, json: { key_id: 'org-key', key: 'c2hvcnQ=' } });
    assert.equal(
      await setOrgSecret(sys, 'example-org', 'gho_owner', 'NIYAM_BOARD_APP_KEY', VALUE, [41]),
      "example-org's Actions public key is not one a secret can be sealed with, so the NIYAM_BOARD_APP_KEY secret is not set",
    );
    await sodium.ready;
    sys.route('GET', `${ORG}/public-key`, { status: 200, json: { key_id: 'org-key', key: Buffer.from(sodium.crypto_box_keypair().publicKey).toString('base64') } });
    sys.route('PUT', `${ORG}/NIYAM_BOARD_APP_KEY`, { status: 204, json: null });
    assert.equal(await setOrgSecret(sys, 'example-org', 'gho_owner', 'NIYAM_BOARD_APP_KEY', VALUE, [41]), undefined);
    sys.route('PUT', `${ORG}/NIYAM_BOARD_APP_KEY`, { status: 403, json: { message: 'Resource not accessible by integration' } });
    assert.equal(
      await setOrgSecret(sys, 'example-org', 'gho_owner', 'NIYAM_BOARD_APP_KEY', VALUE, [41]),
      'GitHub did not set the NIYAM_BOARD_APP_KEY secret (HTTP 403: Resource not accessible by integration)',
    );
  });
});

describe('shareOrgSecret', () => {
  const SHARE = `${ORG}/NIYAM_BOARD_APP_ID/repositories/41`;

  it('adds the repository to the secret, as the token', async () => {
    const sys = new FakeSys();
    sys.route('PUT', SHARE, { status: 204, json: null });
    assert.equal(await shareOrgSecret(sys, 'example-org', 'gho_owner', 'NIYAM_BOARD_APP_ID', 41), undefined);
    assert.deepEqual(sys.requests, [{ url: `https://api.github.com${SHARE}`, method: 'PUT', token: 'gho_owner' }]);
  });

  it('says why GitHub would not add it', async () => {
    for (const [status, said] of [
      [409, "example-org's NIYAM_BOARD_APP_ID secret is visible by type of repository, not to selected ones, so GitHub will not add one to it"],
      [200, "GitHub did not share example-org's NIYAM_BOARD_APP_ID secret with the repository (HTTP 200)"],
      [403, "GitHub did not share example-org's NIYAM_BOARD_APP_ID secret with the repository (HTTP 403)"],
    ] as const) {
      const sys = new FakeSys();
      sys.route('PUT', SHARE, { status, json: null });
      assert.equal(await shareOrgSecret(sys, 'example-org', 'gho_owner', 'NIYAM_BOARD_APP_ID', 41), said);
    }
  });
});

describe('the names of the secrets', () => {
  const page = (path: string, n: number) => `${path}?per_page=100&page=${n}`;
  const named = (count: number, prefix: string) => Array.from({ length: count }, (_, i) => ({ name: `${prefix}${i}` }));

  it("lists the repository's own, then the organization's shared with it, page by page", async () => {
    const sys = new FakeSys();
    const own = REPO;
    const shared = '/repos/example-org/example-app/actions/organization-secrets';
    sys.route('GET', page(own, 1), { status: 200, json: { secrets: named(100, 'A') } });
    sys.route('GET', page(own, 2), { status: 200, json: { secrets: [{ name: 'LAST' }] } });
    sys.route('GET', page(shared, 1), { status: 200, json: { secrets: [{ name: 'ORG_ONE' }] } });
    const names = await secretNames(sys, 'example-org/example-app', 'gho_owner');
    assert.deepEqual(names, [...named(100, 'A').map((one) => one.name), 'LAST', 'ORG_ONE']);
    assert.deepEqual(
      sys.requests.map((r) => [r.url, r.token]),
      [
        [`https://api.github.com${page(own, 1)}`, 'gho_owner'],
        [`https://api.github.com${page(own, 2)}`, 'gho_owner'],
        [`https://api.github.com${page(shared, 1)}`, 'gho_owner'],
      ],
    );
  });

  it('reads the next page after a full one, even when it is empty', async () => {
    const sys = new FakeSys();
    sys.route('GET', page(REPO, 1), { status: 200, json: { secrets: named(100, 'A') } });
    sys.route('GET', page(REPO, 2), { status: 200, json: { secrets: [] } });
    assert.equal((await repoSecretNames(sys, 'example-org/example-app', 'gho_owner'))?.length, 100);
    assert.equal(sys.requests.length, 2);
  });

  it('keeps only the names that are text', async () => {
    const sys = new FakeSys();
    sys.route('GET', page(ORG, 1), { status: 200, json: { secrets: [null, { name: 7 }, {}, { name: 'KEPT' }, 'BARE'] } });
    assert.deepEqual(await orgSecretNames(sys, 'example-org', 'gho_owner'), ['KEPT']);
    assert.deepEqual(sys.requests.map((r) => [r.url, r.token]), [[`https://api.github.com${page(ORG, 1)}`, 'gho_owner']]);
  });

  it('cannot tell when GitHub will not list them, on any page or in either place', async () => {
    for (const [status, json] of [
      [403, { secrets: [] }],
      [200, null],
      [200, {}],
      [200, { secrets: 'none' }],
    ] as const) {
      const sys = new FakeSys();
      sys.route('GET', page(ORG, 1), { status, json });
      assert.equal(await orgSecretNames(sys, 'example-org', 'gho_owner'), undefined, JSON.stringify([status, json]));
    }
    const later = new FakeSys();
    later.route('GET', page(REPO, 1), { status: 200, json: { secrets: named(100, 'A') } });
    later.route('GET', page(REPO, 2), { status: 502, json: null });
    assert.equal(await repoSecretNames(later, 'example-org/example-app', 'gho_owner'), undefined);
    const own = new FakeSys();
    own.route('GET', page(REPO, 1), { status: 403, json: null });
    assert.equal(await secretNames(own, 'example-org/example-app', 'gho_owner'), undefined);
    assert.equal(own.requests.length, 1, 'the organization is not asked');
    const shared = new FakeSys();
    assert.equal(await secretNames(shared, 'example-org/example-app', 'gho_owner'), undefined, 'the organization-secrets list is not routed: 404');
  });
});
