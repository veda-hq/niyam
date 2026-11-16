import { API } from './agent.ts';
import type { Sys } from './types.ts';

/**
 * The names of the Actions secrets `slug`'s workflows can read, its own and
 * its organization's shared with it, as the account `token` sees them; never
 * a value, which GitHub does not list. Undefined when GitHub will not list
 * either, so a caller can tell "not set" from "cannot tell".
 */
export async function secretNames(sys: Sys, slug: string, token: string): Promise<string[] | undefined> {
  const names: string[] = [];
  for (const kind of ['secrets', 'organization-secrets']) {
    const listed = await listNames(sys, `${API}/repos/${slug}/actions/${kind}`, token);
    if (listed === undefined) return undefined;
    names.push(...listed);
  }
  return names;
}

/** The names of the organization `org`'s own Actions secrets, as `token` sees them; undefined when GitHub will not list them. */
export function orgSecretNames(sys: Sys, org: string, token: string): Promise<string[] | undefined> {
  return listNames(sys, `${API}/orgs/${org}/actions/secrets`, token);
}

/** The names of the secrets GitHub lists at `url`, page by page; undefined when it will not list them. */
async function listNames(sys: Sys, url: string, token: string): Promise<string[] | undefined> {
  const names: string[] = [];
  for (let page = 1; ; page++) {
    const listed = await sys.http(`${url}?per_page=100&page=${page}`, { token });
    const secrets = (listed.json as { secrets?: unknown } | null)?.secrets;
    if (listed.status !== 200 || !Array.isArray(secrets)) return undefined;
    names.push(...secrets.flatMap((secret) => (typeof (secret as { name?: unknown } | null)?.name === 'string' ? [(secret as { name: string }).name] : [])));
    if (secrets.length < 100) return names;
  }
}

/**
 * `value` sealed with the Actions public key GitHub gives at `keyUrl`, as a
 * libsodium sealed box, so the value never reaches GitHub, or any output, in
 * the clear; or why not, naming `where` and never the value.
 */
async function seal(sys: Sys, keyUrl: string, token: string, where: string, name: string, value: string): Promise<{ encrypted_value: string; key_id: string } | { problem: string }> {
  const asked = await sys.http(keyUrl, { token });
  const { key_id: id, key } = (asked.json ?? {}) as { key_id?: unknown; key?: unknown };
  if (asked.status !== 200 || typeof id !== 'string' || typeof key !== 'string') {
    return { problem: `GitHub did not give ${where}'s Actions public key (HTTP ${asked.status}), so the ${name} secret is not set` };
  }
  // Loaded here alone: the shared checks run the CLI from its source with no packages installed.
  const { default: sodium } = await import('libsodium-wrappers');
  await sodium.ready;
  try {
    return { encrypted_value: Buffer.from(sodium.crypto_box_seal(new TextEncoder().encode(value), Buffer.from(key, 'base64'))).toString('base64'), key_id: id };
  } catch {
    return { problem: `${where}'s Actions public key is not one a secret can be sealed with, so the ${name} secret is not set` };
  }
}

/** Why a PUT of the secret `name` failed; nothing when GitHub made (201) or replaced (204) it. */
function putProblem(name: string, put: { status: number; json: unknown }): string | undefined {
  if (put.status === 201 || put.status === 204) return undefined;
  const why = (put.json as { message?: unknown } | null)?.message;
  return `GitHub did not set the ${name} secret (HTTP ${put.status}${typeof why === 'string' ? `: ${why}` : ''})`;
}

/**
 * Sets the Actions secret `name` of `slug` to `value`, as the account `token`
 * is, sealed with the repository's Actions public key. Returns why it failed,
 * never naming the value.
 */
export async function setSecret(sys: Sys, slug: string, token: string, name: string, value: string): Promise<string | undefined> {
  const sealed = await seal(sys, `${API}/repos/${slug}/actions/secrets/public-key`, token, slug, name, value);
  if ('problem' in sealed) return sealed.problem;
  return putProblem(name, await sys.http(`${API}/repos/${slug}/actions/secrets/${name}`, { method: 'PUT', token, body: sealed }));
}

/**
 * Sets the organization `org`'s Actions secret `name` to `value`, shared
 * with the repositories `repositoryIds` alone, as the account `token` is,
 * sealed with the organization's Actions public key. Returns why it failed,
 * never naming the value.
 */
export async function setOrgSecret(sys: Sys, org: string, token: string, name: string, value: string, repositoryIds: number[]): Promise<string | undefined> {
  const sealed = await seal(sys, `${API}/orgs/${org}/actions/secrets/public-key`, token, org, name, value);
  if ('problem' in sealed) return sealed.problem;
  const body = { ...sealed, visibility: 'selected', selected_repository_ids: repositoryIds };
  return putProblem(name, await sys.http(`${API}/orgs/${org}/actions/secrets/${name}`, { method: 'PUT', token, body }));
}

/**
 * Shares the organization `org`'s Actions secret `name`, one with selected
 * repositories, with the repository `repositoryId` too. Returns why not.
 */
export async function shareOrgSecret(sys: Sys, org: string, token: string, name: string, repositoryId: number): Promise<string | undefined> {
  const put = await sys.http(`${API}/orgs/${org}/actions/secrets/${name}/repositories/${repositoryId}`, { method: 'PUT', token });
  if (put.status === 204) return undefined;
  // 409: the secret's visibility is all or private repositories, so GitHub decides by that which repositories see it.
  return put.status === 409
    ? `${org}'s ${name} secret is visible by type of repository, not to selected ones, so GitHub will not add one to it`
    : `GitHub did not share ${org}'s ${name} secret with the repository (HTTP ${put.status})`;
}
