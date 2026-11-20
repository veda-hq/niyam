// Mergify's merge-queue draft, as the shared Guard (scripts/guard.mjs, #507)
// and PR identity (src/identity.ts, #524) both read it. A guard file
// (niyam's "guard": ["scripts/*.mjs"]), held for the owner in CODEOWNERS.
//
// Imports nothing on purpose: PR identity runs niyam's src/ with no install,
// so this cannot bring in a package, and Guard imports nothing from src/.

/** The account Mergify's merge queue opens its drafts as, and the branches it opens them on (`queue_branch_prefix`'s default). */
export const MERGE_QUEUE_BOT = 'mergify[bot]';
export const MERGE_QUEUE_BRANCH = 'mergify/merge-queue/';
/** The account GitHub verifies Mergify's own merge commits as (commit-signer@mergify.com), as on athya_mono#3822. */
export const MERGE_QUEUE_SIGNER = 'mergify-commit-signer';

/**
 * A merge-queue draft's title: `merge queue: checking #A on main (sha)`, a
 * batch's `#A + #B together on main (sha)`, then `, stacked on #B, #C and #D`
 * or, from four ahead, `, stacked on N pull requests ahead`. The groups are
 * the tested pull requests, those the title names ahead, and the count ahead.
 */
const MERGE_QUEUE_TITLE =
  /^merge queue: checking (#\d+(?: \+ #\d+)*)(?: together)? on \S+ \([0-9a-f]+\)(?:, stacked on (?:(#\d+(?:(?:,\s*|\s+and\s+)#\d+)*)|(\d+) pull requests ahead))?$/;
/** The body's list of the pull requests queued ahead, which a deep stack's title only counts. */
const QUEUED_AHEAD = /^### Queued ahead of this batch\n([\s\S]*?)(?=^#{1,3} |^<details>|(?![\s\S]))/m;
/** Mergify's merge of a tested pull request into its draft. */
const MERGE_OF = /^Merge of PR #?(\d+)$/;

const numbers = (text) => [...text.matchAll(/#(\d+)\b/g)].map((match) => Number(match[1]));

/**
 * Whether `pull` is shaped as Mergify's draft: GitHub names its author
 * mergify[bot], a Bot, its head branch is on Mergify's queue prefix, and its
 * head is the repository itself.
 * @param {any} pull @param {string} repo @returns {boolean}
 */
export function isMergifyDraft(pull, repo) {
  if (pull.user?.login !== MERGE_QUEUE_BOT || pull.user?.type !== 'Bot') return false;
  return Boolean(pull.head?.ref?.startsWith(MERGE_QUEUE_BRANCH)) && pull.head?.repo?.full_name === repo;
}

/**
 * The pull requests Mergify's merge-queue draft `pull` tests, from its title
 * (and, for a deep stack, its body's list of those ahead, which must name as
 * many as the title counts), or undefined when it is no such draft. A title
 * that names none leaves it judged as itself.
 * @param {any} pull @param {string} repo @param {number} pr @returns {number[] | undefined}
 */
export function mergifyTests(pull, repo, pr) {
  if (!isMergifyDraft(pull, repo)) return undefined;
  const title = MERGE_QUEUE_TITLE.exec(pull.title ?? '');
  if (!title) return undefined;
  const [, batch = '', stacked = '', ahead] = title;
  const named = [...numbers(batch), ...numbers(stacked)];
  if (ahead !== undefined) {
    const queued = [...new Set(numbers(QUEUED_AHEAD.exec(pull.body ?? '')?.[1] ?? ''))];
    if (queued.length !== Number(ahead)) return undefined;
    named.push(...queued);
  }
  const tested = [...new Set(named)].filter((number) => number !== pr);
  return tested.length > 0 ? tested : undefined;
}

/**
 * Whether `commit` is Mergify's own merge of a pull request in `tested` into
 * its draft: two parents, the message `Merge of PR N`, by mergify[bot], and
 * Verified as committed by Mergify's signer, which only Mergify can sign as.
 * @param {any} commit @param {number[]} tested @returns {boolean}
 */
export function isMergifyMerge(commit, tested) {
  const number = MERGE_OF.exec(commit.commit?.message?.split('\n')[0] ?? '')?.[1];
  return (
    number !== undefined &&
    tested.includes(Number(number)) &&
    commit.parents?.length === 2 &&
    commit.author?.login === MERGE_QUEUE_BOT &&
    commit.committer?.login === MERGE_QUEUE_SIGNER &&
    commit.commit?.verification?.verified === true
  );
}

/**
 * The commits of Mergify's draft that are neither a commit of a pull request
 * it tests, as GitHub lists that pull request's commits (`theirs`, by
 * number), nor Mergify's own merge of one. None means the draft carries only
 * what the tested pull requests already do.
 * @param {any[]} commits @param {Map<number, string[]>} theirs @returns {string[]}
 */
export function strayCommits(commits, theirs) {
  const tested = [...theirs.keys()];
  const known = new Set([...theirs.values()].flat());
  return commits.filter((commit) => !known.has(commit.sha) && !isMergifyMerge(commit, tested)).map((commit) => commit.sha);
}
