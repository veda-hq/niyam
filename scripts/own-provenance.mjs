#!/usr/bin/env node
// What stands in for pnpm's release age on niyam's own packages.
//
// pnpm-workspace.yaml exempts @veda-hq/* from minimumReleaseAge (Alok,
// 2026-11-14): the day's wait is a bet that someone else catches a hijacked
// release, and nobody else watches these. Instead, every @veda-hq package the
// lockfile resolves must carry npm provenance saying veda-hq/veda's release
// workflow built it from the tag of its own version, for the very tarball the
// lockfile installs. A release published any other way (a stolen token, a fork,
// another workflow) fails here before anything runs it. Ported from veda's
// scripts/own-provenance.mjs (veda-hq/veda#60, veda-hq/veda#64).
//
// The statement's workflow fields are written by whoever ran npm publish, so
// they alone prove nothing. What binds them is the Sigstore bundle around the
// statement. This verifies it offline with @sigstore/verify:
// - the signature over the statement;
// - the signing certificate's chain to Sigstore's public-good Fulcio;
// - its signed certificate timestamp, and the Rekor entry that times it;
// - the certificate's identity. Its SAN must name veda-hq/veda's release
//   workflow at the version's tag, and its issuer must be GitHub Actions.
//
// The trust anchors are sigstore-trusted-root.json beside this script: the
// public-good trusted_root.json, whose sha256 matched Sigstore's TUF targets
// (tuf-repo-cdn.sigstore.dev, targets v14) on 2026-11-14. When Sigstore rotates
// a key, new releases fail here until the file is refreshed: take
// targets/trusted_root.json from sigstore/root-signing, and check its sha256
// against the trusted_root.json entry of the latest targets.json on the TUF CDN.
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { bundleFromJSON } from '@sigstore/bundle';
import { TrustedRoot } from '@sigstore/protobuf-specs';
import { toSignedEntity, toTrustMaterial, Verifier } from '@sigstore/verify';

export const SCOPE = '@veda-hq/';
export const REPOSITORY = 'https://github.com/veda-hq/veda';
export const WORKFLOW = '.github/workflows/release.yml';
export const SLSA = 'https://slsa.dev/provenance/v1';
/** The OIDC issuer Fulcio records for a GitHub Actions run. */
export const ISSUER = 'https://token.actions.githubusercontent.com';
export const TRUSTED_ROOT = fileURLToPath(new URL('sigstore-trusted-root.json', import.meta.url));

/**
 * Who must have signed the provenance of `version`: veda's release workflow at its tag.
 * @param {string} version
 */
export const signingPolicy = version => ({
  subjectAlternativeName: `${REPOSITORY}/${WORKFLOW}@refs/tags/v${version}`,
  extensions: { issuer: ISSUER },
});

/** How many Rekor entries, certificate timestamps and timestamps a bundle must carry: one of each. */
export const THRESHOLDS = Object.freeze({ tlogThreshold: 1, ctlogThreshold: 1, timestampThreshold: 1 });

/**
 * A function that verifies a Sigstore bundle against a policy and throws when
 * it does not verify, trusting only the trusted root in `rootText`.
 * @param {string} rootText a trusted_root.json
 * @returns {(bundle: unknown, policy: ReturnType<typeof signingPolicy>) => void}
 */
export function bundleVerifier(rootText) {
  const verifier = new Verifier(toTrustMaterial(TrustedRoot.fromJSON(JSON.parse(rootText))), THRESHOLDS);
  return (bundle, policy) => {
    verifier.verify(toSignedEntity(bundleFromJSON(bundle)), policy);
  };
}

/**
 * The @veda-hq packages a pnpm lockfile resolves, and every @veda-hq key it
 * names that is not one of them: a prerelease, a tarball resolution, a shape
 * this does not read. Those fail, so nothing own goes unchecked.
 * @param {string} lockText
 * @returns {{ packages: { name: string, version: string, integrity: string }[], unread: string[] }}
 */
export function ownPackages(lockText) {
  const packages = [];
  const entry = /^ {2}'?(@veda-hq\/[a-z0-9-]+)@([0-9]+\.[0-9]+\.[0-9]+)'?:\n {4}resolution: \{integrity: (sha512-[A-Za-z0-9+/]+=*)\}$/gm;
  for (const match of lockText.matchAll(entry)) packages.push({ name: match[1], version: match[2], integrity: match[3] });
  const read = new Set(packages.map(p => `${p.name}@${p.version}`));
  const keys = new Set();
  for (const match of lockText.matchAll(/^ {2}'?(@veda-hq\/[^@'\s]+@[^'\s(]+)/gm)) keys.add(match[1].replace(/:$/, ''));
  return { packages, unread: [...keys].filter(key => !read.has(key)) };
}

/** Where the registry serves a version's attestations. @param {string} name @param {string} version */
export const attestationsUrl = (name, version) =>
  `https://registry.npmjs.org/-/npm/v1/attestations/${name.replace('/', '%2f')}@${version}`;

/**
 * The SLSA bundle among a version's attestations and the statement it carries,
 * or a reason there is none.
 * @param {unknown} document
 * @returns {string | { bundle: unknown, statement: any }}
 */
function provenanceOf(document) {
  const list = /** @type {{ attestations?: unknown }} */ (document ?? {}).attestations;
  if (!Array.isArray(list)) return 'the registry served no attestations';
  const bundle = list.find(a => a?.predicateType === SLSA)?.bundle;
  const payload = bundle?.dsseEnvelope?.payload;
  if (typeof payload !== 'string') return 'it has no SLSA provenance';
  try {
    return { bundle, statement: JSON.parse(Buffer.from(payload, 'base64').toString('utf8')) };
  } catch {
    // fail-open: the reason returned is a failure, so the check still fails
    return 'its SLSA provenance is not JSON';
  }
}

/**
 * Why a package's provenance does not show veda's release built it; empty when it does.
 * @param {{ name: string, version: string, integrity: string }} pkg
 * @param {unknown} document the registry's attestations response
 * @param {ReturnType<typeof bundleVerifier>} verifyBundle
 * @returns {string[]}
 */
export function provenanceFailures(pkg, document, verifyBundle) {
  const at = `${pkg.name}@${pkg.version}`;
  const provenance = provenanceOf(document);
  if (typeof provenance === 'string') return [`${at}: ${provenance}`];
  const { bundle, statement } = provenance;
  const failures = [];
  try {
    verifyBundle(bundle, signingPolicy(pkg.version));
  } catch (error) {
    // fail-open: the error is recorded as a failure, so the check still fails
    failures.push(`${at}: its provenance is not signed by veda's release of v${pkg.version} (${/** @type {Error} */ (error).message})`);
  }
  const workflow = statement?.predicate?.buildDefinition?.externalParameters?.workflow ?? {};
  const expected = { repository: REPOSITORY, path: WORKFLOW, ref: `refs/tags/v${pkg.version}` };
  for (const [key, value] of Object.entries(expected)) {
    if (workflow[key] !== value) failures.push(`${at}: built with workflow ${key} ${JSON.stringify(workflow[key] ?? null)}, not ${JSON.stringify(value)}`);
  }
  const digest = Buffer.from(pkg.integrity.slice('sha512-'.length), 'base64').toString('hex');
  const attested = Array.isArray(statement?.subject) && statement.subject.some(s => s?.digest?.sha512 === digest);
  if (!attested) failures.push(`${at}: the attested tarball is not the one the lockfile installs`);
  return failures;
}

/**
 * Every own package's failures. @param {string} lockText
 * @param {(url: string) => Promise<unknown>} fetchJson
 * @param {ReturnType<typeof bundleVerifier>} verifyBundle
 */
export async function check(lockText, fetchJson, verifyBundle) {
  const { packages, unread } = ownPackages(lockText);
  const failures = unread.map(key => `${key}: the lockfile names it in a shape this check does not read, so it is not checked`);
  // niyam pins pariksha, so a lockfile with no own package is one this did not read.
  if (packages.length === 0) failures.push(`the lockfile resolves no ${SCOPE} package, so nothing was checked`);
  for (const pkg of packages) {
    let document;
    try {
      document = await fetchJson(attestationsUrl(pkg.name, pkg.version));
    } catch (error) {
      // fail-open: the error is recorded as a failure, so the check still fails
      failures.push(`${pkg.name}@${pkg.version}: its attestations could not be read (${/** @type {Error} */ (error).message})`);
      continue;
    }
    failures.push(...provenanceFailures(pkg, document, verifyBundle));
  }
  return { packages, failures };
}

/**
 * The JSON `doFetch` answers for `url`, or a failure naming the status.
 * @param {string} url @param {(url: string) => Promise<{ ok: boolean, status: number, json: () => Promise<unknown> }>} doFetch
 */
export async function fetchJson(url, doFetch) {
  const response = await doFetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

/**
 * @typedef {{ readText: (path: string) => string, getJson: (url: string) => Promise<unknown>, log: (line: string) => void, error: (line: string) => void }} Io
 */

/** The machine's own: files read as text, the registry over fetch, and the console. @type {Io} */
export const IO = {
  readText: path => readFileSync(path, 'utf8'),
  getJson: url => fetchJson(url, fetch),
  log: line => console.log(line),
  error: line => console.error(line),
};

/**
 * Checks the lockfile in the working directory: 0 when every own package is veda's release, else 1, each failure said.
 * @param {Io} io
 * @returns {Promise<number>}
 */
export async function main(io) {
  const { packages, failures } = await check(io.readText('pnpm-lock.yaml'), io.getJson, bundleVerifier(io.readText(TRUSTED_ROOT)));
  for (const failure of failures) io.error(`own-provenance: ${failure}`);
  if (failures.length > 0) {
    io.error(`own-provenance: ${SCOPE}* skips the release age only when veda's release built it.`);
    return 1;
  }
  io.log(passed(packages));
  return 0;
}

/**
 * What a pass says: each package checked, and who built and signed it.
 * @param {{ name: string, version: string }[]} packages
 */
export const passed = packages => `own-provenance: ${packages.map(p => `${p.name}@${p.version}`).join(', ')} built and signed by ${REPOSITORY} ${WORKFLOW}`;

/**
 * Exits with main's code where `argv` runs the file at `url`; does nothing where something imported it.
 * @param {string[]} argv @param {string} url @param {Io} io @param {(code: number) => void} exit
 */
export async function entry(argv, url, io, exit) {
  if (!argv[1] || url !== pathToFileURL(argv[1]).href) return;
  exit(await main(io));
}

/** The code the process exits with once the run ends. @param {number} code */
export function setExitCode(code) {
  process.exitCode = code;
}

await entry(process.argv, import.meta.url, IO, setExitCode);
