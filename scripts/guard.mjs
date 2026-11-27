#!/usr/bin/env node
// The Guard check (slice #304 of Work item #303; for any repository, slice
// #469 of Work item #468). GitHub runs it on pull_request_target: niyam's
// guard.yml from main's copy, and every other repository's niyam-guard.yml
// caller from its default branch, through shared-guard.yml at the niyam
// release the caller pins, never the pull request's copy. It reads the pull
// request's changed files from GitHub's API as data and passes a change to a
// guard file (the checks, the hooks and their settings) only when the pull
// request's slice names that file in a **Guards:** section the slice already
// had when the owner approved it.
//
//   guard.mjs        GH_TOKEN, REPO (owner/name) and PR (its number) in the environment
//
// Self-contained on purpose: it imports nothing from src/, which is no guard
// file, so a pull request cannot change what the guard does without naming a
// guard file. Its one import of its own, merge-queue.mjs, is a guard file
// beside it, which PR identity shares (#524). The owner, and the
// repository's own guard paths, come from the default branch's
// .github/niyam.json, read through the API. Exit 0: it passes; 1: refused,
// each refusal naming the file and how to pass; 2: a usage error.
import { pathToFileURL } from 'node:url';

import { parse as parseYaml } from 'yaml';

import { mergifyTests } from './merge-queue.mjs';

export { mergifyTests };

/** The branch whose copy runs the guard and whose ruleset names the required checks. */
const MAIN = 'main';

/** The repository whose releases ship the guard, and whose main a release tag must be on. */
const NIYAM = 'veda-hq/niyam';

/** The shared Guard's check: the caller's job `niyam-guard` over shared-guard.yml's job `judge`. */
const SHARED_CHECK = 'niyam-guard / judge';

/** The one job that may report the shared check: the caller onboard writes calls this workflow, at a release. */
const SHARED_WORKFLOW = `${NIYAM}/.github/workflows/shared-guard.yml@`;
/** A ref the caller may pin: a release tag, or a full commit sha. */
const RELEASE_REF = /^(v\d+\.\d+\.\d+|[0-9a-f]{40})$/;
/** A niyam release tag, the only pin onboard writes for the caller (`src/guard-caller.ts`). */
const RELEASE_TAG = /^v\d+\.\d+\.\d+$/;

/** The settings file, read at the default branch's tip. */
const SETTINGS = '.github/niyam.json';
/** The features niyam knows, as src/features.ts lists them (a test keeps the two equal). */
export const FEATURES = ['identity', 'pr-identity', 'board', 'work-rules', 'figma', 'decisions', 'review'];
/** Older feature names settings may still list, as src/features.ts renames them. */
export const RENAMED_FEATURES = ['design'];

/** GitHub lists at most 3,000 of a pull request's files, 100 a page. */
const FILES_MOST = 3000;

/**
 * The floor of guard files every repository has: the checks, the hooks and
 * their settings. A repository adds its own paths as `"guard"` in its
 * settings; package.json counts only for its `scripts`, which judge compares.
 */
const GUARD_FILES = [/^\.github\//, /^\.githooks\//, /^\.husky\//, /^lefthook\.yml$/, /^\.dvara\.json$/, /^\.dvara\/records-baseline\.json$/, /^\.gitleaks\.toml$/, /^\.trufflehog-exclude$/];

/** A test file: `x.test.ts`, `x.spec.mjs` and the like. */
const TEST_FILE = /(?:^|\/)[^/]+\.(?:test|spec)\.[cm]?[jt]sx?$/;

/** A test: `test(`, `it(`, `t.test(`, `test.skip(`. */
const TEST_CALL = /\b(?:test|it)(?:\.\w+)?\s*\(/g;

/** A test skipped, run alone or left to do: `.skip(`, `test.only`, `{ todo: true }`, `t.todo(`. */
const SKIP_MARK = /\.(?:skip|only|todo)\b|\b(?:skip|only|todo)\s*:/g;

/** How a pull request names the slice it builds, as Work rules reads it. */
const SLICE_LINE = /^Slice:\s*(?:#(\d+)|([A-Za-z0-9-]+\/[A-Za-z0-9._-]+)#(\d+)|https:\/\/github\.com\/([A-Za-z0-9-]+\/[A-Za-z0-9._-]+)\/issues\/(\d+))\s*$/im;

/** An onboard pull request's title, gitmoji or not, and the release it moves to. */
const ONBOARD_TITLE = /^(?:\S+\s+)?chore\(niyam\): onboard at v(\d+\.\d+\.\d+)\b/;

/** A sha256, as onboard pins a release tarball. */
const SHA256 = /\b[0-9a-f]{64}\b/g;

/** A `uses:` line pinned to a full commit sha, with its version comment or not. */
const USES = /^(\s*(?:-\s*)?uses:\s*)([^@\s]+)@([0-9a-f]{40})(?:(\s+#\s*)(\S.*))?$/;

const DEPENDABOT = 'dependabot[bot]';

/** GitHub's web host, where the owner acts: every refusal that sends someone to the owner names a full address there. */
const WEB = 'https://github.com';

/** Issue `number` of `repo`'s own address, where the owner approves it. @param {string} repo @param {number} number */
export const issueUrl = (repo, number) => `${WEB}/${repo}/issues/${number}`;

/**
 * Whether `path` is a guard file: in the floor, or named by the repository's
 * own `paths`, in the **Guards:** syntax. package.json counts only for its
 * `scripts`, which the caller compares.
 * @param {string} path @param {string[]} paths
 */
export function isGuardFile(path, paths) {
  return path === 'package.json' || GUARD_FILES.some((pattern) => pattern.test(path)) || named(paths, path);
}

/** Whether `path` is a test file. */
export function isTestFile(path) {
  return TEST_FILE.test(path);
}

/**
 * The text of `body`'s section `**name:**`, up to the next line that starts
 * a section, or undefined when it has none or it is empty. The same reading
 * as Work rules' `section()`, kept here so the guard depends on no src/ file.
 * @param {string} body @param {string} name @returns {string | undefined}
 */
export function section(body, name) {
  const lines = body.split(/\r?\n/);
  const head = new RegExp(`^\\s*\\*\\*${name}:\\*\\*`, 'i');
  const from = lines.findIndex((line) => head.test(line));
  if (from < 0) return undefined;
  const rest = lines.slice(from + 1);
  const to = rest.findIndex((line) => /^\s*\*\*[^*\n]+:\*\*/.test(line));
  const text = [lines[from].replace(head, ''), ...(to < 0 ? rest : rest.slice(0, to))].join('\n').trim();
  return text || undefined;
}

/**
 * The paths and patterns a **Guards:** section names: each word with a `.`
 * or a `/` in it, backticks, list marks and commas aside. `dir/` names
 * everything under it; `*` matches within one folder and `**` across them.
 * @param {string | undefined} text @returns {string[]}
 */
export function guardsNamed(text) {
  if (!text) return [];
  return [
    ...new Set(
      text
        // One separator at a time: the empty words between two go with the prose.
        .split(/[\s,;`]/)
        .map((word) => word.replace(/^[-*(]+|[).:]+$/g, ''))
        .filter((word) => /[./]/.test(word)),
    ),
  ];
}

/** Whether one of `names` names `path`. @param {string[]} names @param {string} path */
export function named(names, path) {
  return names.some((name) => {
    if (name.endsWith('/')) return path.startsWith(name);
    // A name with no `*` reads as itself alone.
    const glob = name
      .split(/(\*\*\/?|\*)/)
      .map((part) => (part.startsWith('**') ? '.*' : part === '*' ? '[^/]*' : part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')))
      .join('');
    return new RegExp(`^${glob}$`).test(path);
  });
}

/**
 * The slice a pull request body names first, or undefined: `#N` in `repo`,
 * or another repository's as `owner/name#N` or its address, read there. A
 * line naming `repo` itself, in any case, is one of its own.
 * @param {string | undefined} body @param {string} repo @returns {{ repo: string, number: number } | undefined}
 */
export function sliceOf(body, repo) {
  // No body reads as the word undefined, which names no slice.
  const match = SLICE_LINE.exec(String(body));
  if (!match) return undefined;
  const there = match[2] ?? match[4];
  return { repo: there === undefined || there.toLowerCase() === repo.toLowerCase() ? repo : there, number: Number(match[1] ?? match[3] ?? match[5]) };
}

/**
 * The runs of a unified-diff patch: each removed block with the added block
 * right after it. A patch GitHub left out (too large, binary) is undefined.
 * @param {string | undefined} patch @returns {{ removed: string[], added: string[] }[] | undefined}
 */
export function changeRuns(patch) {
  if (patch === undefined) return undefined;
  const runs = [];
  let run;
  for (const line of patch.split('\n')) {
    if (line.startsWith('-')) {
      if (!run || run.added.length > 0) runs.push((run = { removed: [], added: [] }));
      run.removed.push(line.slice(1));
    } else if (line.startsWith('+')) {
      if (!run) runs.push((run = { removed: [], added: [] }));
      run.added.push(line.slice(1));
    } else {
      run = undefined;
    }
  }
  return runs;
}

/** How many times `pattern` matches across `lines`. */
const count = (lines, pattern) => lines.reduce((total, line) => total + (line.match(pattern)?.length ?? 0), 0);

/**
 * What a test file's change does to its tests, from its patch, which GitHub
 * diffs against the merge base: lines that did not change cancel out.
 * @param {{ removed: string[], added: string[] }[]} runs
 */
export function testChange(runs) {
  const removed = runs.flatMap((run) => run.removed);
  const added = runs.flatMap((run) => run.added);
  return { fewer: count(added, TEST_CALL) < count(removed, TEST_CALL), skipped: count(added, SKIP_MARK) > count(removed, SKIP_MARK) };
}

/** Whether release `a` is newer than `b`, both X.Y.Z. */
export function newer(a, b) {
  // Each part padded to one width, so the texts sort as the numbers do; no loop a mutant could make endless.
  const key = (version) => version.split('.').map((part) => part.padStart(16, '0')).join();
  return key(a) > key(b);
}

/**
 * Whether every run only moves `uses:` lines to another full commit sha of
 * the same action, each with its version comment: Dependabot's change.
 * @param {{ removed: string[], added: string[] }[]} runs
 */
export function onlyShaMoves(runs) {
  return runs.every(
    (run) =>
      run.removed.length === run.added.length &&
      run.removed.every((line, i) => {
        const before = USES.exec(line);
        const after = USES.exec(run.added[i]);
        return Boolean(before && after && after[5] && before[1] === after[1] && before[2] === after[2]);
      }),
  );
}

/**
 * How many versions the runs move to `to`, onboard's change, or -1 when a
 * line changes more. Each removed line and the added line paired with it
 * must match but for versions and sha256s: a version is the same in both,
 * or moves from an older one to `to`; a sha256 may be any other.
 * @param {{ removed: string[], added: string[] }[]} runs @param {string} to @returns {number}
 */
export function versionMoves(runs, to) {
  let moved = 0;
  for (const run of runs) {
    if (run.removed.length !== run.added.length) return -1;
    for (const [i, line] of run.removed.entries()) {
      const before = line.split(/(\d+\.\d+\.\d+)/);
      const after = run.added[i].split(/(\d+\.\d+\.\d+)/);
      if (before.length !== after.length) return -1;
      for (const [at, part] of before.entries()) {
        const other = after[at];
        if (at % 2 === 0) {
          if (part.replace(SHA256, 'H') !== other.replace(SHA256, 'H')) return -1;
        } else if (part !== other) {
          if (other !== to || !newer(to, part)) return -1;
          moved++;
        }
      }
    }
  }
  return moved;
}

/**
 * The names of the checks the jobs in workflow `text` report: a job's `name`,
 * else its id. Undefined when it does not parse as a workflow.
 * @param {string} text @returns {string[] | undefined}
 */
export function jobNames(text) {
  return workflowOf(text)?.jobs.map((job) => job.name);
}

/**
 * The refs workflow `text`'s jobs call the shared Guard at, the part of each
 * `uses:` after `shared-guard.yml@`; none where it calls it nowhere or does
 * not parse.
 * @param {string | undefined} text @returns {string[]}
 */
export function pinsIn(text) {
  // No file reads as the word undefined, which is no workflow; a job that is no mapping has no uses:.
  return [workflowOf(String(text))?.jobs]
    .filter(Array.isArray)
    .flat()
    .map(({ job }) => /** @type {{ uses?: unknown }} */ (Object(job)).uses)
    .filter((uses) => typeof uses === 'string' && uses.startsWith(SHARED_WORKFLOW))
    .map((uses) => /** @type {string} */ (uses).slice(SHARED_WORKFLOW.length));
}

/**
 * Workflow `text`'s events and jobs: each job's check name (its `name`, else
 * its id) and the job itself. Undefined when it does not parse as a workflow.
 * @param {string} text @returns {{ events: string[], jobs: { name: string, job: unknown }[] } | undefined}
 */
export function workflowOf(text) {
  let doc;
  try {
    doc = parseYaml(text);
  } catch {
    // Text that is not YAML leaves no document, which is no workflow below.
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return undefined;
  // A null jobs: reads as none.
  const jobs = doc.jobs ?? {};
  if (typeof jobs !== 'object' || Array.isArray(jobs)) return undefined;
  const on = doc.on;
  // An event list of another shape, null or a number, has no keys: no events.
  const events = typeof on === 'string' ? [on] : Array.isArray(on) ? on.map(String) : Object.keys(Object(on));
  // A job that is no mapping has no name: it reads as its id.
  return { events, jobs: Object.entries(jobs).map(([id, job]) => ({ name: job?.name !== undefined ? String(job.name) : id, job })) };
}

/**
 * Whether `job`, in a workflow run by `events`, is the shared Guard's caller
 * as onboard writes it: run by pull_request_target alone, so GitHub runs the
 * default branch's copy, and doing nothing but call shared-guard.yml at a
 * release tag or a full commit sha, never a branch. Only such a job may
 * report the shared check. Its shape alone: whether the pin is a release on
 * niyam's main, no older than the default branch's, is judge's (#512), which
 * refuses a commit sha there.
 * @param {string[]} events @param {unknown} job
 */
export function isCaller(events, job) {
  if (events.length !== 1 || events[0] !== 'pull_request_target') return false;
  // A job that is no mapping, null or a list, has no uses: and refuses below.
  const { uses, steps } = /** @type {{ uses?: unknown, steps?: unknown }} */ (Object(job));
  if (typeof uses !== 'string' || !uses.startsWith(SHARED_WORKFLOW) || steps !== undefined) return false;
  return RELEASE_REF.test(uses.slice(SHARED_WORKFLOW.length));
}

/** Whether a job named `name` could report the required check `check`: itself, a matrix leg of it, or a reusable workflow's job under it. */
export function reports(name, check) {
  return name.includes('${{') || check === name || check.startsWith(`${name} / `) || check.startsWith(`${name} (`);
}

/** A workflow file, whose jobs report checks. */
const isWorkflow = (path) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(path);

/** `logins`' first entry that is `login`, case aside. */
const sameLogin = (logins, login) => typeof login === 'string' && logins.some((one) => one.toLowerCase() === login.toLowerCase());

/** The owners main's `.github/niyam.json` names. @param {string} text */
export function ownersIn(text) {
  const owner = JSON.parse(text).owner;
  const list = Array.isArray(owner) ? owner : [owner];
  if (list.length === 0 || !list.every((one) => typeof one === 'string' && one !== '')) throw new Error(`${SETTINGS} names no owner`);
  return list;
}

/**
 * The agent accounts main's `.github/niyam.json` names, one or a list, whose
 * proposals an owner's 👍 settles (#515). None when it names no `"agent"`, so
 * no 👍 counts; anything but logins refuses, and so does an agent that is
 * also an owner, as the work rules refuse it (`src/agent.ts`): the owner's 👍
 * on their own proposal would approve it.
 * @param {string} text @returns {string[]}
 */
export function agentsIn(text) {
  const agent = JSON.parse(text).agent;
  if (agent === undefined) return [];
  const list = Array.isArray(agent) ? agent : [agent];
  if (list.length === 0 || !list.every((one) => typeof one === 'string' && one !== '')) throw new Error(`${SETTINGS}'s "agent" must be the agent account's login, or a list of them`);
  const both = ownersIn(text).find((owner) => sameLogin(list, owner));
  if (both) throw new Error(`${SETTINGS} names ${both} as both owner and agent; they must be different accounts`);
  return list;
}

/** A proposal's first line, and the issue it names first: what the proposal is for, as src/work.ts reads it. */
export const PROPOSAL = /^\s*Proposal:[^#\n]*#(\d+)\b/i;

/**
 * Whether main's `.github/niyam.json` turns work rules on, so the repository
 * has Work items whose slices name its guard files: yes when it lists no
 * `features` (every feature on) or lists `work-rules`; anything but a list of
 * names, or a name niyam does not know, refuses: a typo must not turn the
 * slice check off. Without work rules, Guard judges no slice (#485).
 * @param {string} text @returns {boolean}
 */
export function workRulesIn(text) {
  const features = JSON.parse(text).features;
  if (features === undefined) return true;
  if (!Array.isArray(features) || !features.every((one) => typeof one === 'string')) throw new Error(`${SETTINGS}'s "features" must be a list of feature names`);
  const unknown = features.filter((one) => !FEATURES.includes(one.trim()) && !RENAMED_FEATURES.includes(one.trim()));
  if (unknown.length > 0) throw new Error(`${SETTINGS} lists unknown feature ${unknown.map((one) => JSON.stringify(one)).join(', ')}; the features are ${FEATURES.join(', ')}`);
  return features.some((one) => one.trim() === 'work-rules');
}

/**
 * The repository's own guard paths, `"guard"` in main's `.github/niyam.json`:
 * paths, folders ending in `/` and patterns, as **Guards:** names them. They
 * only add to the floor. None when the key is not there; anything but a list
 * of such names refuses.
 * @param {string} text @returns {string[]}
 */
export function guardPathsIn(text) {
  const paths = JSON.parse(text).guard;
  if (paths === undefined) return [];
  // A name that reads as itself alone is one word: guardsNamed gives no second.
  if (!Array.isArray(paths) || !paths.every((one) => typeof one === 'string' && guardsNamed(one)[0] === one)) {
    throw new Error(`${SETTINGS}'s "guard" must be a list of paths, folders ending in / or patterns, such as ["scripts/*.mjs"]`);
  }
  return paths;
}

/**
 * The Approvals issue main's `.github/niyam.json` names as `"approvals": N`,
 * or undefined when it names none; anything but an issue number refuses, as
 * the work rules refuse it (`src/agent.ts`).
 * @param {string} text @returns {number | undefined}
 */
export function approvalsIn(text) {
  const value = JSON.parse(text).approvals;
  if (value === undefined) return undefined;
  // Only a number is a safe integer.
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${SETTINGS}'s "approvals" must be the number of the repository's Approvals issue, such as 42`);
  }
  return value;
}

/**
 * A batch answer's first line: `Decision: approve`, then the issues it
 * approves. Only that line approves; the lines under it are reasons. As
 * `src/approvals.ts` reads it, which a test holds this to.
 */
export const BATCH = /^\s*Decision:\s*approve\b(.*)$/i;
/** An issue of this repository as `#N`, not another's `owner/repo#N` nor an HTML entity such as `&#35;` or `&amp;#35;`. */
export const ISSUE = /(?<![\w/.&-])(?<!&\w*;)#(\d+)\b/g;

/** The issues a comment approves as a batch: every `#N` on its first line when that line opens `Decision: approve`; none otherwise. @param {string} body @returns {number[]} */
export function approvedIn(body) {
  const first = BATCH.exec(body.split(/\r?\n/, 1)[0]);
  return first ? [...new Set([...first[1].matchAll(ISSUE)].map((match) => Number(match[1])))] : [];
}

/**
 * The slice's body as it stood at `at`, from its GraphQL revisions, which
 * hold the whole text, newest first, the body as written last. Undefined
 * when the slice did not exist yet or its history cannot be read in full.
 */
export function bodyAt(issue, at) {
  if (issue.createdAt > at) return undefined;
  if (!issue.lastEditedAt || issue.lastEditedAt <= at) return issue.body;
  const edits = issue.userContentEdits;
  if (!edits || edits.totalCount > edits.nodes.length) return undefined;
  const then = edits.nodes.find((edit) => edit && edit.editedAt <= at);
  if (!then || then.deletedAt || typeof then.diff !== 'string') return undefined;
  return then.diff;
}

const ISSUE_QUERY =
  'query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { issue(number: $number) { body createdAt lastEditedAt userContentEdits(first: 100) { totalCount nodes { editedAt deletedAt diff } } } } }';

/**
 * A GitHub client over `fetch`: `get` and `post` give the status and the
 * JSON or text answered.
 * @param {string} token @param {string} [api]
 */
export function client(token, api = 'https://api.github.com', doFetch = fetch) {
  const call = async (path, { method = 'GET', body, raw = false } = {}) => {
    const response = await doFetch(`${api}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: raw ? 'application/vnd.github.raw' : 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'niyam-guard',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      // Text that is not JSON leaves json undefined.
    }
    return { status: response.status, json, text };
  };
  return { get: (path, options) => call(path, options), post: (path, body) => call(path, { method: 'POST', body }) };
}

/** A read that failed: the guard fails closed. */
class Unread extends Error {}

/** `path`'s JSON, or a failed read; with `missing`, undefined where GitHub answers 404. */
async function read(gh, path, missing = false) {
  const { status, json } = await gh.get(path);
  if (missing && status === 404) return undefined;
  if (status !== 200 || json === undefined) throw new Unread(`GitHub did not answer ${path.split('?')[0]} (HTTP ${status}${json?.message ? `: ${json.message}` : ''})`);
  return json;
}

/**
 * Every item of a REST list, 100 a page, up to `most`; with `missing`, none
 * where GitHub answers 404 for its first page. Any other failure still fails.
 */
async function every(gh, path, most = 3000, missing = false) {
  const items = [];
  for (let page = 1; items.length < most; page++) {
    const json = await read(gh, `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`, missing && page === 1);
    if (json === undefined) return items;
    if (!Array.isArray(json)) throw new Unread(`GitHub did not answer a list for ${path}`);
    items.push(...json);
    if (json.length < 100) break;
  }
  return items;
}

/** A file's text at commit `ref`, or undefined where it does not exist. */
async function textAt(gh, repo, path, ref) {
  const { status, text } = await gh.get(`/repos/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${ref}`, { raw: true });
  if (status === 404) return undefined;
  if (status !== 200) throw new Unread(`GitHub did not answer ${path} at ${ref.slice(0, 7)} (HTTP ${status})`);
  return text;
}

/** package.json's `scripts`, as one comparable string; a file that is not JSON compares as itself. */
function scriptsOf(text) {
  // No file compares as nothing else does.
  if (text === undefined) return undefined;
  try {
    return JSON.stringify(JSON.parse(text).scripts ?? null);
  } catch {
    return `unparsed:${text}`;
  }
}

/**
 * Whether tag `tag` names a commit on main: main itself or an ancestor. The
 * tag is read as a tag, an annotated one to its commit, so a branch of the
 * same name cannot stand in for it.
 */
async function tagOnMain(gh, repo, tag) {
  const ref = await gh.get(`/repos/${repo}/git/ref/tags/${encodeURIComponent(tag)}`);
  let object = ref.status === 200 ? ref.json?.object : undefined;
  if (object?.type === 'tag') {
    const annotated = await gh.get(`/repos/${repo}/git/tags/${object.sha}`);
    object = annotated.status === 200 ? annotated.json?.object : undefined;
  }
  if (object?.type !== 'commit' || !/^[0-9a-f]{40}$/.test(object.sha ?? '')) return false;
  const { status, json } = await gh.get(`/repos/${repo}/compare/${MAIN}...${object.sha}`);
  return status === 200 && (json?.status === 'behind' || json?.status === 'identical');
}

/**
 * The Approvals issue another repository's settings name on its default
 * branch, or undefined: where GitHub cannot find the repository or its
 * settings, or they name none or cannot be read. Any other failure fails.
 */
async function approvalsThere(gh, repo) {
  const branch = (await read(gh, `/repos/${repo}`, true))?.default_branch;
  if (typeof branch !== 'string' || branch === '') return undefined;
  const settings = await textAt(gh, repo, SETTINGS, encodeURIComponent(branch));
  try {
    return settings === undefined ? undefined : approvalsIn(settings);
  } catch {
    // Settings there that do not parse name no Approvals issue, as for the work rules.
    return undefined;
  }
}

/**
 * When the slice's **Guards:** counts from: the owner's latest answer since
 * the later of the slice joining its Work item and the Work item's last
 * approval (#534). That approval counts for a slice already there; so does,
 * since then, an unedited `Decision:` on the slice or on the Work item naming
 * it, a batch answer on the Approvals issue `approvals` whose first line
 * approves it (#501), or a 👍 on an agent's proposal for it (#515). An
 * Approvals issue GitHub cannot find answers nothing, as for the work rules.
 * With what it is, for the refusals, or why there is none.
 */
async function approvedAt(gh, repo, slice, owners, approvals, agents, name = (number) => `#${number}`) {
  const parent = await gh.get(`/repos/${repo}/issues/${slice}/parent`);
  const who = owners.join(' or ');
  // Each problem carries its own remedy: a new proposal settles none of them but the last (#534).
  if (parent.status !== 200) {
    return {
      problem: `slice ${name(slice)} is not a sub-issue of a Work item GitHub can read (HTTP ${parent.status})`,
      // Only a 404 says the slice has no parent; any other answer is GitHub not answering, which a re-run may fix.
      remedy:
        parent.status === 404
          ? `add slice ${name(slice)}, ${issueUrl(repo, slice)}, as a sub-issue of its Work item, and have ${who} approve it there`
          : `run Guard again once GitHub answers for slice ${name(slice)}'s Work item`,
    };
  }
  const item = parent.json.number;
  const events = await every(gh, `/repos/${repo}/issues/${item}/timeline`);
  const approval = events.filter((event) => (event.event === 'labeled' || event.event === 'unlabeled') && event.label?.name === 'approved').at(-1);
  if (approval?.event !== 'labeled' || !sameLogin(owners, approval.actor?.login)) {
    return {
      problem: `Work item ${name(item)}, ${issueUrl(repo, item)}, is not approved by ${who}, so slice ${name(slice)}'s **Guards:** names nothing yet`,
      remedy: `have ${who} put the \`approved\` label on Work item ${name(item)}, ${issueUrl(repo, item)}`,
    };
  }
  const joined = (await every(gh, `/repos/${repo}/issues/${slice}/timeline`)).filter((event) => event.event === 'parent_issue_added').map((event) => event.created_at).sort().at(-1);
  // A slice already there when the Work item was approved counts from that approval, and any answer since moves it.
  const there = !joined || joined <= approval.created_at;
  const from = there ? approval.created_at : joined;
  const since = (comment) => sameLogin(owners, comment.user?.login) && comment.created_at > from && comment.updated_at <= comment.created_at;
  const decision = (comment, mention) => since(comment) && /^\s*Decision:/i.test(comment.body ?? '') && (!mention || new RegExp(`#${slice}\\b`).test(comment.body));
  const settled = `${who}'s Decision: settled slice ${name(slice)}`;
  const batch = approvals === undefined ? [] : await every(gh, `/repos/${repo}/issues/${approvals}/comments`, 3000, true);
  const comments = await every(gh, `/repos/${repo}/issues/${slice}/comments`);
  const byTime = (a, b) => (a.at < b.at ? -1 : 1);
  const answers = [
    ...(there ? [{ at: approval.created_at, what: `Work item ${name(item)} got the approved label` }] : []),
    ...comments.filter((comment) => decision(comment, false)).map((comment) => ({ at: comment.created_at, what: settled })),
    ...events.filter((event) => event.event === 'commented' && decision(event, true)).map((event) => ({ at: event.created_at, what: settled })),
    ...batch
      .filter((comment) => since(comment) && approvedIn(comment.body ?? '').includes(slice))
      .map((comment) => ({ at: comment.created_at, what: `${who}'s batch answer on the Approvals issue, ${name(approvals)}, settled slice ${name(slice)}` })),
  ];
  // An owner's 👍 on an agent's proposal for the slice, after it joined and after the proposal's last edit, as the
  // work rules read it (src/work.ts, thumbsUp). A proposal GitHub no longer has answers nothing (#515). A 👍 on any
  // proposal, an old one included, can be the latest answer, so every proposal's reactions are read (#534).
  const proposals = comments.filter((comment) => sameLogin(agents, comment.user?.login) && Number(PROPOSAL.exec(comment.body ?? '')?.[1]) === slice);
  for (const proposal of proposals) {
    const edited = proposal.updated_at > proposal.created_at ? proposal.updated_at : undefined;
    for (const reaction of await every(gh, `/repos/${repo}/issues/comments/${proposal.id}/reactions?content=%2B1`, 3000, true)) {
      if (!sameLogin(owners, reaction.user?.login) || reaction.created_at <= from || (edited && reaction.created_at <= edited)) continue;
      answers.push({ at: reaction.created_at, what: `${who}'s 👍 on ${proposal.user.login}'s proposal settled slice ${name(slice)}` });
    }
  }
  // The latest answer settles the slice as it stood then: an edit after it counts for nothing (#534).
  const last = answers.sort(byTime).at(-1);
  if (!last) {
    const where = approvals === undefined ? '' : `, on the slice, on Work item ${name(item)} or in a batch answer on the Approvals issue, ${name(approvals)}, ${issueUrl(repo, approvals)}`;
    // The proposal the owner would 👍, by its own address, so the agent passes on that link.
    const newest = proposals.at(-1)?.html_url;
    const link = typeof newest === 'string' && newest.startsWith('https://') ? `, ${newest}` : '';
    const thumbs = agents.length > 0 ? `, nor reacted 👍 to an agent's proposal for it${link}` : '';
    const answer =
      agents.length === 0
        ? `write a \`Decision:\` on slice ${name(slice)}, ${issueUrl(repo, slice)}`
        : proposals.length > 0
          ? `react 👍 to the agent's proposal for slice ${name(slice)}${link || `, on ${issueUrl(repo, slice)}`}, or write a \`Decision:\` there`
          : `react 👍 to a \`Proposal:\` for slice ${name(slice)} that the agent posts on ${issueUrl(repo, slice)}, or write a \`Decision:\` there`;
    return {
      problem: `slice ${name(slice)}, ${issueUrl(repo, slice)}, joined Work item ${name(item)}, ${issueUrl(repo, item)}, after its approval, and ${who} has written no unedited Decision: settling it since${where}${thumbs}`,
      remedy: `have ${who} ${answer}`,
    };
  }
  return { ...last, item };
}

/**
 * Judges pull request `pr` of `repo`: the refusals, each naming its file and
 * how to pass, empty when it passes. `ownPaths` are the repository's own guard
 * paths, from its settings, beyond the floor; `branch` is its default branch,
 * whose ruleset names the required checks. `unjudged`, given for a repository
 * without work rules, takes each change a slice would have to name, which is
 * then no refusal: there is no Work item to name it (#485). `approvals` is
 * the Approvals issue the settings name, whose batch answers count too (#501).
 * `agents` are the settings' agent accounts, whose proposals an owner's 👍
 * settles (#515).
 * @param {{ get: Function, post: Function }} gh @param {string} repo @param {number} pr @param {string[]} owners @param {string[]} [ownPaths] @param {string} [branch]
 * @param {{ path: string, why: string }[]} [unjudged] @param {number} [approvals] @param {string[]} [agents]
 * @returns {Promise<{ file?: string, message: string }[]>}
 */
export async function judge(gh, repo, pr, owners, ownPaths = [], branch = MAIN, unjudged = undefined, approvals = undefined, agents = []) {
  const pull = await read(gh, `/repos/${repo}/pulls/${pr}`);
  // Without work rules no slice is judged, so a draft is judged as itself: no tested pull request changes that.
  const tested = unjudged ? undefined : mergifyTests(pull, repo, pr);
  if (!tested) return judgeAs(gh, repo, pr, pull, pull, owners, ownPaths, branch, unjudged, approvals, agents);
  // Mergify's merge-queue draft: its own diff, judged once as each pull request it tests (#507). Each REST read
  // is made once across the runs, so a stack costs a read per tested pull request and slice, not another of the diff.
  const reads = new Map();
  const once = {
    get: (path, options) => {
      const key = `${options?.raw ? 'raw' : 'json'} ${path}`;
      if (!reads.has(key)) reads.set(key, gh.get(path, options));
      return reads.get(key);
    },
    post: (path, body) => gh.post(path, body),
  };
  const runs = [];
  for (const number of tested) {
    const as = await read(once, `/repos/${repo}/pulls/${number}`);
    runs.push(await judgeAs(once, repo, pr, pull, as, owners, ownPaths, branch, unjudged, approvals, agents));
  }
  // A refusal stands only where every tested pull request leads to one, file by file.
  const key = (refusal) => refusal.file ?? refusal.message;
  const refused = runs.map((run) => new Set(run.map(key)));
  const names = tested.map((number) => `#${number}`).join(', ');
  return runs[0]
    .filter((refusal) => refused.every((set) => set.has(key(refusal))))
    .map((refusal) => ({ ...refusal, message: `This is Mergify's merge-queue draft testing ${names}, and none of them passes this. As #${tested[0]}: ${refusal.message}` }));
}

/**
 * Judges pull request `pull`'s diff as if it had `as`'s title, author and
 * body: `as` is `pull` itself, or a pull request a Mergify draft tests.
 */
async function judgeAs(gh, repo, pr, pull, as, owners, ownPaths, branch, unjudged, approvals, agents) {
  const files = await every(gh, `/repos/${repo}/pulls/${pr}/files`, FILES_MOST);
  if (files.length !== pull.changed_files) {
    return [{ message: `GitHub listed ${files.length} of this pull request's ${pull.changed_files} changed files, so the guard cannot see every change. Split it into pull requests of fewer files.` }];
  }
  const runsOf = new Map(files.map((file) => [file, changeRuns(file.patch)]));
  const mechanical = (test) => files.every((file) => file.status === 'modified' && runsOf.get(file) && test(runsOf.get(file)));
  const onboard = ONBOARD_TITLE.exec(as.title ?? '')?.[1];
  // Whether niyam's tag `ref` is on niyam's main, read once a run however many files name it.
  const tags = new Map();
  const released = (ref) => {
    if (!tags.has(ref)) tags.set(ref, tagOnMain(gh, NIYAM, ref));
    return tags.get(ref);
  };
  let exempt = false;
  if (as.user?.login === DEPENDABOT && mechanical(onlyShaMoves)) exempt = true;
  else if (onboard && mechanical((runs) => versionMoves(runs, onboard) >= 0)) {
    // The version must move somewhere, so a PR that only swaps sha256s is no onboard change.
    const moved = files.reduce((total, file) => total + versionMoves(runsOf.get(file), onboard), 0);
    // The release is niyam's, so its tag is read there, whichever repository onboarded.
    exempt = moved > 0 && (await released(`v${onboard}`));
  }

  /** Each file that needs naming, with why. */
  const needs = [];
  /** Refusals no **Guards:** line passes. */
  const refusals = [];
  let mergeBase;
  const base = async () => (mergeBase ??= (await read(gh, `/repos/${repo}/compare/${pull.base.sha}...${pull.head.sha}`)).merge_base_commit.sha);
  let required;
  const requiredChecks = async () => {
    if (required) return required;
    const rules = await read(gh, `/repos/${repo}/rules/branches/${branch.split('/').map(encodeURIComponent).join('/')}`);
    if (!Array.isArray(rules)) throw new Unread(`GitHub did not answer ${branch}'s rules as a list`);
    const contexts = rules.filter((rule) => rule.type === 'required_status_checks').flatMap((rule) => rule.parameters?.required_status_checks ?? []).map((check) => check.context);
    return (required = [...new Set([SHARED_CHECK, ...contexts])]);
  };

  for (const file of files) {
    const paths = [...new Set([file.previous_filename, file.filename].filter(Boolean))];
    // A guard file: package.json for its scripts alone.
    for (const path of paths) {
      if (!isGuardFile(path, ownPaths) || exempt) continue;
      if (path === 'package.json') {
        const after = file.status === 'removed' || path !== file.filename ? undefined : await textAt(gh, repo, path, pull.head.sha);
        if (scriptsOf(await textAt(gh, repo, path, await base())) === scriptsOf(after)) continue;
        needs.push({ path, why: 'changes the scripts of package.json, a guard file' });
      } else {
        needs.push({ path, why: 'changes a guard file' });
      }
    }
    // A test file: deleted, renamed away from a test, or with fewer tests or more skipped.
    const was = file.previous_filename ?? file.filename;
    if (isTestFile(was) || isTestFile(file.filename)) {
      const runs = runsOf.get(file);
      if (file.status === 'removed' || (isTestFile(was) && !isTestFile(file.filename))) needs.push({ path: was, why: 'deletes a test file' });
      else if (!runs) needs.push({ path: file.filename, why: 'changes a test file whose diff GitHub does not show, so the guard cannot count its tests' });
      else {
        const { fewer, skipped } = testChange(runs);
        if (fewer) needs.push({ path: file.filename, why: 'leaves a test file with fewer test( or it( calls than main' });
        if (skipped) needs.push({ path: file.filename, why: 'adds .skip, .only or todo to a test file' });
      }
    }
    // A workflow job named after a required check.
    if (isWorkflow(file.filename) && file.status !== 'removed') {
      const text = (await textAt(gh, repo, file.filename, pull.head.sha)) ?? '';
      const workflow = workflowOf(text);
      const before = isWorkflow(was) && file.status !== 'added' ? jobNames((await textAt(gh, repo, was, await base())) ?? '') ?? [] : [];
      if (!workflow) {
        refusals.push({ file: file.filename, message: `${file.filename} does not parse as a workflow, so the guard cannot tell which checks its jobs report. Make it valid YAML with a jobs: map.` });
        continue;
      }
      // Only the caller as onboard writes it may report the shared check: any other job could report it from the
      // pull request's own copy, and the ruleset cannot tell that run from the guard's, both GitHub Actions'.
      for (const { name, job } of workflow.jobs) {
        if (!reports(name, SHARED_CHECK) || isCaller(workflow.events, job)) continue;
        refusals.push({
          file: file.filename,
          message: `${file.filename} has the job "${name}", which could report "${SHARED_CHECK}", the shared Guard's check, but is not its caller as niyam onboard writes it (run by pull_request_target alone, calling ${SHARED_WORKFLOW}<release> and nothing else). Rename the job, or run niyam onboard to write the caller.`,
        });
      }
      // The caller's pin picks which Guard runs, so it names a niyam release on niyam's main, never one older than the
      // default branch's copy of the file holds (#512). No slice passes another: an older Guard would judge by older rules.
      const pins = pinsIn(text);
      if (pins.length > 0) {
        const held = pinsIn(await textAt(gh, repo, was, encodeURIComponent(branch)))
          .filter((ref) => RELEASE_TAG.test(ref))
          .map((ref) => ref.slice(1))
          .reduce((most, version) => (most === undefined || newer(version, most) ? version : most), undefined);
        for (const ref of new Set(pins)) {
          const why = !RELEASE_TAG.test(ref)
            ? 'which is not a niyam release tag (vX.Y.Z)'
            : held !== undefined && newer(held, ref.slice(1))
              ? `older than v${held}, which ${branch}'s copy pins`
              : (await released(ref))
                ? undefined
                : `a tag that is not on ${NIYAM}'s ${MAIN}`;
          if (why === undefined) continue;
          refusals.push({
            file: file.filename,
            message: `${file.filename} calls the shared Guard at ${ref}, ${why}. The caller's pin picks which Guard judges every pull request, so it only moves forward to a niyam release, as niyam onboard writes it. Run niyam onboard to write the caller.`,
          });
        }
      }
      const now = workflow.jobs.map((job) => job.name);
      const checks = (await requiredChecks()).filter((check) => check !== SHARED_CHECK);
      // A job is added when its name is there more times than before: a second job of a name counts.
      const left = [...before];
      const added = now.filter((one) => {
        const at = left.indexOf(one);
        if (at < 0) return true;
        left.splice(at, 1);
        return false;
      });
      for (const name of added) {
        const check = checks.find((one) => reports(name, one));
        if (check === undefined) continue;
        refusals.push({
          file: file.filename,
          message: name.includes('${{')
            ? `${file.filename} adds the job "${name}", whose name is an expression that could report a check ${branch}'s ruleset requires. Give it a fixed name.`
            : `${file.filename} adds the job "${name}", which reports "${check}", a check ${branch}'s ruleset requires: a pull request would report it from its own copy. Rename the job.`,
        });
      }
    }
  }
  if (needs.length === 0) return refusals;
  if (unjudged) {
    unjudged.push(...needs);
    return refusals;
  }

  const ref = sliceOf(as.body ?? '', repo);
  // A slice in another repository is read there, as Work rules reads it: its Work item, its Approvals issue, its body.
  const where = ref?.repo ?? repo;
  const foreign = where !== repo;
  const name = (number) => (foreign ? `${where}#${number}` : `#${number}`);
  // The slice's own address, where the owner approves it again, so the agent can pass on the link (#557). Guard
  // reads the section as of the owner's latest answer, so a 👍 on a new proposal approves it again (#534); `niyam
  // propose` posts nothing for a slice already settled, so the refusal does not send the agent to it.
  const who = owners.join(' or ');
  const it = ref === undefined ? 'the slice' : `slice ${name(ref.number)}`;
  const at = ref === undefined ? '' : `, ${issueUrl(where, ref.number)}`;
  const again =
    agents.length > 0
      ? `post a new \`Proposal:\` comment on ${it}${at}, whose first #N is ${ref === undefined ? 'the slice' : `#${ref.number}`}, and have ${who} react 👍 to it or write a \`Decision:\` there. Guard reads the section as it stood at ${who}'s latest answer, so a 👍 on the new proposal is enough`
      : `have ${who} write a \`Decision:\` on ${it}${at}. Guard reads the section as it stood at ${who}'s latest answer, so a new Decision is enough`;
  const whose = ref === undefined ? "the slice's" : `slice ${name(ref.number)}'s`;
  const how = (path) => `name \`${path}\` in ${whose} **Guards:** section, then ${again}; then edit or push this pull request so Guard runs again`;
  // Where the slice is not settled at all, a new proposal is no remedy: the problem's own remedy is.
  const settle = (path, what) => `name \`${path}\` in ${whose} **Guards:** section, and ${what}; then edit or push this pull request so Guard runs again`;
  if (ref === undefined) {
    return [...refusals, ...needs.map(({ path, why }) => ({ file: path, message: `This pull request ${why}, ${path}, and names no slice. Add a "Slice: #N" line to its body, ${settle(path, `have ${who} approve that slice`)}.` }))];
  }
  const { number: slice } = ref;
  const theirs = foreign ? await approvalsThere(gh, where) : approvals;
  const approval = await approvedAt(gh, where, slice, owners, theirs, agents, name);
  if (approval.problem) {
    return [...refusals, ...needs.map(({ path, why }) => ({ file: path, message: `This pull request ${why}, ${path}, but ${approval.problem}. To pass, ${settle(path, approval.remedy)}.` }))];
  }
  const [owner, repoName] = where.split('/');
  const answer = await gh.post('/graphql', { query: ISSUE_QUERY, variables: { owner, name: repoName, number: slice } });
  const issue = answer.status === 200 ? answer.json?.data?.repository?.issue : undefined;
  const then = issue ? bodyAt(issue, approval.at) : undefined;
  if (then === undefined) {
    const why = issue ? `GitHub does not show every revision of slice ${name(slice)}'s body back to when ${approval.what}` : `GitHub's GraphQL API did not give slice ${name(slice)}'s body revisions (HTTP ${answer.status})`;
    return [...refusals, ...needs.map(({ path, why: what }) => ({ file: path, message: `This pull request ${what}, ${path}, and ${why}, so the guard cannot read its **Guards:** section as approved. To pass, ${how(path)}.` }))];
  }
  const names = guardsNamed(section(then, 'Guards'));
  for (const { path, why } of needs) {
    if (named(names, path)) continue;
    refusals.push({
      file: path,
      message: `This pull request ${why}, ${path}, and slice ${name(slice)}'s **Guards:** section, as it stood when ${approval.what} (${approval.at}), ${who}'s latest answer, does not name it. To pass, ${how(path)}.`,
    });
  }
  return refusals;
}

/** Runs the guard from the environment GitHub Actions gives it. */
export async function main(env = process.env, out = console, gh = undefined) {
  const repo = env.REPO;
  const pr = Number(env.PR);
  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo) || !Number.isInteger(pr) || pr <= 0 || (!gh && !env.GH_TOKEN)) {
    out.error('usage: GH_TOKEN=… REPO=owner/name PR=<number> guard.mjs');
    return 2;
  }
  // Run by any other event, GitHub would have run the calling workflow from the pull request's own copy.
  if (env.GITHUB_EVENT_NAME !== 'pull_request_target') {
    out.error(`::error::Guard runs only on pull_request_target, so that GitHub runs its caller from the default branch, never the pull request; this run's event is ${env.GITHUB_EVENT_NAME || 'not given'}. Call it from a workflow run by pull_request_target alone, as niyam onboard writes it.`);
    return 1;
  }
  let refusals;
  /** Without work rules, the changes no slice was asked to name. */
  let unjudged;
  try {
    const github = gh ?? client(env.GH_TOKEN, env.GITHUB_API_URL || undefined);
    // The repository's own default branch, which a pull request cannot change.
    const branch = (await read(github, `/repos/${repo}`))?.default_branch;
    if (typeof branch !== 'string' || branch === '') throw new Unread(`GitHub named no default branch for ${repo}`);
    const settings = await textAt(github, repo, SETTINGS, encodeURIComponent(branch));
    if (settings === undefined) throw new Unread(`${branch} has no ${SETTINGS}; run niyam onboard`);
    unjudged = workRulesIn(settings) ? undefined : [];
    refusals = await judge(github, repo, pr, ownersIn(settings), guardPathsIn(settings), branch, unjudged, approvalsIn(settings), agentsIn(settings));
  } catch (error) {
    // Anything it could not read refuses: the guard fails closed.
    out.error(`::error::Guard could not judge this pull request: ${error.message}. Run Guard again once GitHub answers.`);
    return 1;
  }
  for (const { file, message } of refusals) out.error(`::error${file ? ` file=${file}` : ''}::${message}`);
  if (refusals.length > 0) return 1;
  if (unjudged) {
    for (const { path, why } of unjudged) out.log(`Guard: this pull request ${why}, ${path}; ${SETTINGS} turns work rules off, so no slice is asked to name it.`);
    out.log('Guard: work rules are off here, so only the refusals no slice can pass were judged, and none applies.');
    return 0;
  }
  out.log('Guard: no change to a guard file needs naming, or the approved slice names each.');
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exit(await main());
