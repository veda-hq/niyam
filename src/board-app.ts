import { randomBytes } from 'node:crypto';

import { API } from './agent.ts';
import { detail } from './doc-numbers.ts';
import { GITHUB_WEB } from './host.ts';
import { PRODUCT } from './names.ts';
import { orgSecretNames, repoSecretNames, setOrgSecret, shareOrgSecret } from './secrets.ts';
import type { Output, ServeAnswer, ServeRequest, Sys } from './types.ts';

/**
 * The board GitHub App (P-70, P-72): the Slice started job makes its board
 * token from these two Actions secrets, the app's client id and its private
 * key. onboard makes the app from a manifest, so the owner clicks Create and
 * Install and copies nothing.
 */
export const BOARD_SECRETS = ['NIYAM_BOARD_APP_ID', 'NIYAM_BOARD_APP_KEY'] as const;
export type BoardSecret = (typeof BOARD_SECRETS)[number];
/** What each board app secret holds. */
const HOLDS: Record<BoardSecret, string> = { NIYAM_BOARD_APP_ID: 'client id', NIYAM_BOARD_APP_KEY: 'private key' };
/** The permissions the app asks for, and no more: the Slice started job's token asks for the same. */
export const BOARD_APP_PERMISSIONS = { organization_projects: 'write', issues: 'read' } as const;
/** The start of every board app's slug onboard makes: `niyam board <org>`, as GitHub makes a slug of it. */
const SLUG_START = 'niyam-board';
/** How long onboard waits for the owner to click Create, then Install, in the browser, each. */
export const BOARD_APP_WAIT_MS = 10 * 60_000;
/** How often onboard looks for the owner's click: the redirect back as it waits for Create, GitHub's installations as it waits for Install. */
const CREATE_TICK_MS = 500;
const INSTALL_TICK_MS = 3000;

/**
 * The owner's steps, once per organization, to give `slug`'s Slice started
 * job the board app's token by hand: make the app, install it, and set the
 * secrets `missing`. `unknown` when GitHub would not list the secrets, so
 * they may be set already.
 */
export function boardAppSteps(slug: string, missing: readonly BoardSecret[], unknown = false): string {
  const org = slug.split('/')[0] as string;
  const set = missing.map((name) => `its ${HOLDS[name]} as ${name}`).join(' and ');
  return (
    `${unknown ? `Unless ${slug} has the Actions secrets ${BOARD_SECRETS.join(' and ')} already, once` : 'Once'} for ${org}: ` +
    `make a GitHub App with organization Projects read and write and repository Issues read at ${GITHUB_WEB}/organizations/${org}/settings/apps/new, ` +
    `install it on ${slug}, and set ${set}, Actions secrets of the organization or of ${GITHUB_WEB}/${slug}/settings/secrets/actions. ` +
    'Until then a slice moves to In Progress on the board only from a desktop push.'
  );
}

/** The board app's name for `org`: GitHub takes at most 34 characters. */
export function boardAppName(org: string): string {
  return `niyam board ${org}`.slice(0, 34).trimEnd();
}

/** The manifest GitHub makes the board app from, sending the owner back to `redirect`. It has no webhook. */
export function boardAppManifest(org: string, redirect: string): Record<string, unknown> {
  return {
    name: boardAppName(org),
    url: `${GITHUB_WEB}/${PRODUCT}`,
    description: 'Moves a slice to In Progress on the board when its pull request opens. Made by niyam onboard.',
    hook_attributes: { url: `${GITHUB_WEB}/${PRODUCT}`, active: false },
    redirect_url: redirect,
    public: false,
    default_permissions: BOARD_APP_PERMISSIONS,
    default_events: [],
  };
}

/** `text` safe inside an HTML attribute in double quotes. */
function attribute(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** The page that posts the manifest to GitHub's new-app page for `org` as it loads, carrying the run's `state`. */
export function startPage(org: string, manifest: Record<string, unknown>, state: string): string {
  const action = `${GITHUB_WEB}/organizations/${encodeURIComponent(org)}/settings/apps/new?state=${encodeURIComponent(state)}`;
  return [
    '<!doctype html><meta charset="utf-8"><title>niyam: the board app</title>',
    `<form id="make" method="post" action="${attribute(action)}">`,
    `<input type="hidden" name="manifest" value="${attribute(JSON.stringify(manifest))}">`,
    '<p>Taking you to GitHub to make the board app. <button>Go on</button></p>',
    '</form>',
    '<script>document.getElementById("make").submit()</script>',
  ].join('\n');
}

/** A plain page for the browser, saying `text`. */
function page(status: number, text: string): ServeAnswer {
  return { status, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: `${text}\n` };
}

/** The app GitHub made from the manifest: what the secrets and the install need. */
interface MadeApp {
  slug: string;
  clientId: string;
  pem: string;
}

/** The app GitHub made, from the code its redirect carried; or why not. */
async function convert(sys: Sys, code: string): Promise<MadeApp | { problem: string }> {
  const made = await sys.http(`${API}/app-manifests/${encodeURIComponent(code)}/conversions`, { method: 'POST' });
  const { slug, client_id: clientId, pem } = (made.json ?? {}) as { slug?: unknown; client_id?: unknown; pem?: unknown };
  if (made.status !== 201 || typeof slug !== 'string' || typeof clientId !== 'string' || typeof pem !== 'string') {
    return { problem: `GitHub did not give the app it made (HTTP ${made.status})` };
  }
  return { slug, clientId, pem };
}

/** An installation of a GitHub App on an organization, as GitHub lists it. */
interface Installation {
  id: number;
  app_slug: string;
  repository_selection: string;
}

/** The organization's installation of an app whose slug `is`, looking from page `page` on; undefined while there is none. */
async function installationOf(sys: Sys, org: string, token: string, is: (slug: string) => boolean, page = 1): Promise<Installation | undefined> {
  const listed = await sys.http(`${API}/orgs/${org}/installations?per_page=100&page=${page}`, { token });
  const all = (listed.json as { installations?: unknown } | null)?.installations;
  if (listed.status !== 200 || !Array.isArray(all)) return undefined;
  const found = (all as Installation[]).find((one) => typeof one?.app_slug === 'string' && is(one.app_slug));
  return found || all.length < 100 ? found : installationOf(sys, org, token, is, page + 1);
}

/** Puts repository `repositoryId` on `installation` when it holds selected repositories alone; why not, as a step left by hand. */
async function includeRepository(sys: Sys, org: string, slug: string, token: string, installation: Installation, repositoryId: number): Promise<string | undefined> {
  if (installation.repository_selection === 'all') return undefined;
  const put = await sys.http(`${API}/user/installations/${installation.id}/repositories/${repositoryId}`, { method: 'PUT', token });
  if (put.status === 204) return undefined;
  return `Once for ${slug}: add it to the board app's installation at ${GITHUB_WEB}/organizations/${org}/settings/installations/${installation.id}, since GitHub would not (HTTP ${put.status}).`;
}

/**
 * Sets up the board app for `slug`, as the owner `token` is, and returns
 * what is left by hand, if anything. Where the organization has the app's
 * secrets already, they and the app's installation are shared with the
 * repository too. Otherwise the browser opens on GitHub's new-app page with
 * the manifest filled in; the owner clicks Create, onboard sets the
 * secrets, and the browser goes on to the install page, where the owner
 * clicks Install. Never throws: a step GitHub refuses, or a click that does
 * not come, is a step left by hand.
 */
export async function setUpBoardApp(sys: Sys, out: Output, slug: string, token: string): Promise<string[]> {
  const org = slug.split('/')[0] as string;
  const byHand = (why: string): string[] => [`${boardAppSteps(slug, BOARD_SECRETS)} onboard did not: ${why}.`];
  try {
    const repo = await sys.http(`${API}/repos/${slug}`, { token });
    const repositoryId = (repo.json as { id?: unknown } | null)?.id;
    if (repo.status !== 200 || typeof repositoryId !== 'number') return byHand(`GitHub did not give ${slug}'s id (HTTP ${repo.status})`);
    // A repository's own secret hides the organization's of the same name, so one of its own is the owner's to remove.
    const own = await repoSecretNames(sys, slug, token);
    if (own === undefined) return byHand(`GitHub would not list ${slug}'s own Actions secrets`);
    const shadowing = BOARD_SECRETS.filter((name) => own.includes(name));
    if (shadowing.length > 0) {
      return [
        `Once for ${slug}: delete its own ${shadowing.join(' and ')} at ${GITHUB_WEB}/${slug}/settings/secrets/actions, which would hide the organization's board app secrets, then run niyam onboard again at your own terminal.`,
      ];
    }
    const names = await orgSecretNames(sys, org, token);
    if (names === undefined) return byHand(`GitHub would not list ${org}'s Actions secrets`);
    const has = BOARD_SECRETS.filter((name) => names.includes(name));
    if (has.length === BOARD_SECRETS.length) return await share(sys, out, { org, slug, token, repositoryId });
    // One of the two belongs to an app made before: a new app would overwrite it and leave that one installed.
    if (has.length > 0) {
      const settings = `${GITHUB_WEB}/organizations/${org}/settings/secrets/actions`;
      // Of the two, it has one and lacks the other.
      const [held] = has;
      const [lacking] = BOARD_SECRETS.filter((name) => !has.includes(name));
      return [
        `Once for ${org}: it has the secret ${held} but not ${lacking}. Set the board app's other one at ${settings}, or delete it and its app, then run niyam onboard again at your own terminal.`,
      ];
    }
    return await make(sys, out, { org, slug, token, repositoryId });
  } catch (error) {
    // fail-open: the board app is the owner's to finish; nothing else in the run waits on it.
    return byHand(detail(error));
  }
}

interface Where {
  org: string;
  slug: string;
  token: string;
  repositoryId: number;
}

/** The organization has the app already: share its secrets and its installation with the repository. */
async function share(sys: Sys, out: Output, { org, slug, token, repositoryId }: Where): Promise<string[]> {
  const left: string[] = [];
  for (const name of BOARD_SECRETS) {
    const problem = await shareOrgSecret(sys, org, token, name, repositoryId);
    if (problem) left.push(`Once for ${slug}: share ${org}'s ${name} secret with it at ${GITHUB_WEB}/organizations/${org}/settings/secrets/actions/${name}, since ${problem}.`);
  }
  if (left.length === 0) out.out(`✓ ${org}'s board app secrets shared with ${slug}`);
  const installation = await installationOf(sys, org, token, (one) => one.startsWith(SLUG_START));
  if (!installation) left.push(`Once for ${slug}: install ${org}'s board app on it at ${GITHUB_WEB}/organizations/${org}/settings/installations.`);
  else {
    const problem = await includeRepository(sys, org, slug, token, installation, repositoryId);
    if (problem) left.push(problem);
    else out.out(`✓ ${org}'s board app installed on ${slug}`);
  }
  return left;
}

/** The organization has no board app: make one from the manifest, set its secrets, and install it. */
async function make(sys: Sys, out: Output, { org, slug, token, repositoryId }: Where): Promise<string[]> {
  const state = randomBytes(16).toString('hex');
  let made: MadeApp | { problem: string } | undefined;
  let asked = false;
  const served = await sys.serve(async ({ path, query }: ServeRequest): Promise<ServeAnswer> => {
    if (path === '/start') return { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: startPage(org, boardAppManifest(org, redirect), state) };
    if (path !== '/made') return page(404, 'Not found.');
    // Only GitHub's redirect for this run's manifest carries its state.
    if (query.state !== state || !query.code) return page(400, "This is not GitHub's answer to this run of niyam onboard.");
    if (asked) return page(409, 'niyam onboard has this answer already; go back to the terminal.');
    asked = true;
    try {
      const app = await convert(sys, query.code);
      if ('problem' in app) {
        made = app;
        return page(502, `niyam onboard could not get the app: ${app.problem}. The terminal says what is left.`);
      }
      // The key is set before anything else, as GitHub gives it once.
      for (const [name, value] of [['NIYAM_BOARD_APP_ID', app.clientId], ['NIYAM_BOARD_APP_KEY', app.pem]] as const) {
        const problem = await setOrgSecret(sys, org, token, name, value, [repositoryId]);
        if (problem) {
          made = { problem: `GitHub made the app ${app.slug} but ${problem}` };
          return page(502, `The app is made, but niyam onboard could not set its secrets: ${problem}. The terminal says what is left.`);
        }
      }
      made = app;
      return { status: 302, headers: { location: `${GITHUB_WEB}/apps/${app.slug}/installations/new` } };
    } catch (error) {
      // fail-open: GitHub may have made the app before the request failed, so the owner is told to look, not to make another.
      made = { problem: `a request to GitHub failed once it had the code (${detail(error)})` };
      return page(502, `niyam onboard could not finish: ${made.problem}. The terminal says what is left.`);
    }
  });
  const redirect = `http://127.0.0.1:${served.port}/made`;
  try {
    sys.open(`http://127.0.0.1:${served.port}/start`);
    for (let waited = 0; made === undefined && waited < BOARD_APP_WAIT_MS; waited += CREATE_TICK_MS) await sys.sleep(CREATE_TICK_MS);
  } finally {
    // The browser has its redirect by the time `made` is set; nothing else is served.
    served.close();
  }
  if (made === undefined) return [`${boardAppSteps(slug, BOARD_SECRETS)} onboard opened GitHub's page for it, but no app was made within ${BOARD_APP_WAIT_MS / 60_000} minutes.`];
  if ('problem' in made) {
    const settings = `${GITHUB_WEB}/organizations/${org}/settings/apps`;
    return [`Once for ${org}: ${made.problem}. At ${settings}, delete the board app if it was made, then run niyam onboard again.`];
  }
  const app = made;
  out.out(`✓ made the board app ${app.slug} and set ${BOARD_SECRETS.join(' and ')}, shared with ${slug}`);
  // The browser is on the install page now; the owner clicks Install.
  const install = `Once for ${org}: install the board app on ${slug} at ${GITHUB_WEB}/apps/${app.slug}/installations/new`;
  try {
    let installation: Installation | undefined;
    for (let waited = 0; !installation && waited < BOARD_APP_WAIT_MS; waited += INSTALL_TICK_MS) {
      installation = await installationOf(sys, org, token, (one) => one === app.slug);
      if (!installation) await sys.sleep(INSTALL_TICK_MS);
    }
    if (!installation) return [`${install}.`];
    const problem = await includeRepository(sys, org, slug, token, installation, repositoryId);
    if (problem) return [problem];
  } catch (error) {
    // fail-open: the app and its secrets stand; only the install is left.
    return [`${install}, if it is not there yet: onboard could not tell (${detail(error)}).`];
  }
  out.out(`✓ installed the board app on ${slug}`);
  return [];
}
