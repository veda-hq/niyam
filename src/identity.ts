import { MERGE_QUEUE_BOT, mergifyTests, strayCommits } from '../scripts/merge-queue.mjs';
import { API, account, anyLogin, either, loadSettings, noreplyEmail, sameLogin } from './agent.ts';
import { isOn, notAdoptedLine, offLine } from './features.ts';
import type { Output, Sys } from './types.ts';

export interface Commit {
  sha: string;
  parents?: { sha: string }[];
  author?: { login?: string } | null;
  committer?: { login?: string } | null;
  commit?: { message?: string; author?: { email?: string }; verification?: { verified?: boolean; reason?: string } };
}

/** GitHub lists at most 250 commits for a pull request. */
export const MOST_COMMITS = 250;

/** Pull request `number`'s commits, as many as GitHub lists: MOST_COMMITS or more means some went unseen. */
export async function commitsOf(sys: Sys, token: string, slug: string, number: number): Promise<Commit[]> {
  const commits: Commit[] = [];
  for (let page = 1; ; page++) {
    const { status, json } = await sys.http(`${API}/repos/${slug}/pulls/${number}/commits?per_page=100&page=${page}`, { token });
    if (status !== 200 || !Array.isArray(json)) throw new Error(`cannot list the commits of #${number} (HTTP ${status})`);
    commits.push(...(json as Commit[]));
    if (json.length < 100 || commits.length >= MOST_COMMITS) return commits;
  }
}

/**
 * Why Mergify's draft, testing `tested`, does not carry only what they do, or
 * undefined when every commit is a tested pull request's own or Mergify's
 * signed merge of one (#524).
 */
async function strayFrom(sys: Sys, token: string, slug: string, commits: Commit[], tested: number[]): Promise<string | undefined> {
  const theirs = new Map<number, string[]>();
  for (const number of tested) {
    const list = await commitsOf(sys, token, slug, number);
    if (list.length >= MOST_COMMITS) return `#${number} has ${MOST_COMMITS} or more commits, more than GitHub lists`;
    theirs.set(number, list.map((commit) => commit.sha));
  }
  const stray = strayCommits(commits, theirs);
  if (stray.length === 0) return undefined;
  return `${stray.map((sha) => sha.slice(0, 7)).join(', ')} ${stray.length === 1 ? 'is' : 'are'} in no pull request it tests and not ${MERGE_QUEUE_BOT}'s signed merge`;
}

/** GitHub may record a push a moment after the run starts: the record is read this many times, this far apart. */
export const RECORD_READS = 6;
export const RECORD_WAIT_MS = 10_000;

/**
 * The PR identity check, run by the shared workflow on a pull request. Every
 * commit that claims an agent (its login or its no-reply address) must be
 * Verified as that agent, and pushed by an agent. Who pushed comes from GitHub's
 * record of the branch's pushes alone, never from whoever started the run,
 * so an edit, a label or a re-run gives the result the push itself gave.
 * Reads the event and repository from the Actions environment and asks
 * GitHub with GH_TOKEN.
 */
export async function prIdentity(sys: Sys, io: Output): Promise<number> {
  const { GITHUB_EVENT_PATH: eventPath, GITHUB_EVENT_NAME: eventName, GITHUB_REPOSITORY: slug, GH_TOKEN: token } = sys.env;
  if (!eventPath || !slug || !token) {
    throw new Error('pr-identity runs in GitHub Actions: GITHUB_EVENT_PATH, GITHUB_REPOSITORY and GH_TOKEN must be set');
  }
  if (eventName === 'merge_group') {
    io.out('pr-identity: a merge queue run; each queued pull request passed this check on its own');
    return 0;
  }
  const event = JSON.parse(sys.read(eventPath)) as {
    pull_request?: {
      number?: number;
      title?: string | null;
      body?: string | null;
      user?: { login?: string; type?: string } | null;
      base?: { sha: string };
      head?: { ref: string; repo: { full_name: string } | null };
    };
  };
  const pull = event.pull_request;
  const number = pull?.number;
  if (typeof number !== 'number' || !pull?.base || !pull.head) {
    io.out('pr-identity: not a pull request; nothing to check');
    return 0;
  }
  const notAdopted = notAdoptedLine(sys, sys.cwd, 'pr-identity');
  if (notAdopted) {
    io.out(notAdopted);
    return 0;
  }
  const { agents } = loadSettings(sys, sys.cwd);
  if (!isOn(sys, sys.cwd, 'pr-identity')) {
    io.out(offLine('pr-identity', 'pr-identity'));
    return 0;
  }
  // GitHub's spelling of each agent, and the no-reply address its commits carry.
  const accounts = await Promise.all(agents.map(async (agent) => {
    // With the run's token: without one, GitHub limits the runner's shared address and refuses with a 403.
    const { id, login } = await account(sys, agent, token);
    return { login, email: noreplyEmail(id, login).toLowerCase() };
  }));
  const logins = accounts.map((one) => one.login);
  const login = either(logins);

  const commits = await commitsOf(sys, token, slug, number);
  if (commits.length >= MOST_COMMITS) {
    // Commits past GitHub's limit cannot be seen, so they cannot pass.
    io.err(`✗ #${number} has ${MOST_COMMITS} or more commits, more than GitHub lists; split it so every commit can be checked`);
    io.err(`pr-identity: #${number} fails the identity check`);
    return 1;
  }

  // Mergify's merge queue tests queued pull requests together in a draft of its own, which it opens and pushes,
  // so their agent commits read as pushed by mergify[bot]. Each passed this check on its own, so the draft
  // passes when it carries only their commits and Mergify's signed merges of them (#524). Any other draft,
  // and a draft shaped as Mergify's that carries anything else, is checked as any pull request.
  const tested = mergifyTests(pull, slug, number);
  if (tested) {
    const names = tested.map((one) => `#${one}`).join(', ');
    const stray = await strayFrom(sys, token, slug, commits, tested);
    if (stray === undefined) {
      io.out(`pr-identity: #${number} is ${MERGE_QUEUE_BOT}'s merge queue draft testing ${names}, each checked on its own, and carries only their commits and ${MERGE_QUEUE_BOT}'s signed merges; nothing to check`);
      return 0;
    }
    io.out(`pr-identity: #${number} is shaped as ${MERGE_QUEUE_BOT}'s merge queue draft testing ${names}, but ${stray}; checked as any pull request`);
  }

  /** The agent a commit claims, by its author's login or its no-reply address, or undefined. */
  const claimed = (commit: Commit): string | undefined =>
    accounts.find((one) => sameLogin(commit.author?.login ?? undefined, one.login) || commit.commit?.author?.email?.toLowerCase() === one.email)?.login;
  const claimsAgent = (commit: Commit): boolean => claimed(commit) !== undefined;
  const problems: string[] = [];
  for (const commit of commits.filter(claimsAgent)) {
    const verification = commit.commit?.verification;
    const agent = claimed(commit) as string;
    if (verification?.verified !== true || !sameLogin(commit.committer?.login ?? undefined, agent)) {
      problems.push(
        `${commit.sha.slice(0, 7)} claims ${agent} but is not Verified as ${agent} (committer ${commit.committer?.login ?? 'none'}, ${verification?.reason ?? 'no verification'})`,
      );
    }
  }
  // Only commits that claim the agent need their pusher; an owner-only pull request asks GitHub nothing more.
  const agentCommits = commits.filter(claimsAgent);
  const shas = (list: Commit[]): string => list.map((commit) => commit.sha.slice(0, 7)).join(', ');
  const claim = (list: Commit[]): string => `claim${list.length === 1 ? 's' : ''} ${either([...new Set(list.map((commit) => claimed(commit) as string))])}`;
  const head = pull.head.repo?.full_name;
  if (agentCommits.length > 0 && !head) {
    // A deleted fork takes its push record with it.
    problems.push(`#${number}'s head repository is gone, so no record says who pushed ${shas(agentCommits)}, which ${claim(agentCommits)}`);
  } else if (head) {
    const branch = { repo: head, ref: pull.head.ref, base: pull.base.sha, commits: commits.map((commit) => commit.sha) };
    let pushers = new Map<string, string | null>();
    for (let read = 1; agentCommits.length > 0; read++) {
      pushers = await whoPushed(sys, token, branch);
      if (read === RECORD_READS || agentCommits.every((commit) => pushers.has(commit.sha))) break;
      await sys.sleep(RECORD_WAIT_MS);
    }
    const byPusher = new Map<string, Commit[]>();
    const unrecorded: Commit[] = [];
    for (const commit of agentCommits) {
      const pusher = pushers.get(commit.sha);
      if (pusher === undefined) unrecorded.push(commit);
      else if (!pusher || !anyLogin(logins, pusher)) {
        const key = pusher ?? 'an account GitHub no longer names';
        byPusher.set(key, [...(byPusher.get(key) ?? []), commit]);
      }
    }
    for (const [pusher, list] of byPusher) {
      problems.push(`${pusher} pushed ${shas(list)}, which ${claim(list)}; agent work must be pushed by ${login}`);
    }
    if (unrecorded.length > 0) {
      problems.push(`no push GitHub has recorded to ${pull.head.ref} brought ${shas(unrecorded)}, which ${claim(unrecorded)}; re-run once GitHub records the push`);
    }
  }

  for (const problem of problems) io.err(`✗ ${problem}`);
  if (problems.length > 0) {
    io.err(`pr-identity: #${number} fails the identity check`);
    return 1;
  }
  const count = commits.filter(claimsAgent).length;
  io.out(`✓ pr-identity: ${count} commit${count === 1 ? '' : 's'} by ${login}, each Verified and pushed by ${login}`);
  return 0;
}

const ZERO = /^0+$/;

/**
 * Who pushed each of a pull request's commits, from GitHub's record of the
 * pushes to its branch, oldest first: each push is credited with the
 * commits it brought that the pull request still has. A push GitHub records
 * with no actor, such as one by a deleted account, is credited to null.
 */
export async function whoPushed(
  sys: Sys,
  token: string,
  branch: { repo: string; ref: string; base: string; commits: string[] },
): Promise<Map<string, string | null>> {
  const pushes: { before: string; after: string; activity_type: string; actor: { login: string } | null }[] = [];
  // The activity list pages by cursor: each reply's Link header names the next page.
  const ref = encodeURIComponent(`refs/heads/${branch.ref}`);
  for (let url: string | undefined = `${API}/repos/${branch.repo}/activity?ref=${ref}&per_page=100`; url; ) {
    const { status, json, headers = {} } = await sys.http(url, { token });
    if (status !== 200 || !Array.isArray(json)) throw new Error(`cannot read the pushes to ${branch.ref} (HTTP ${status})`);
    pushes.push(...(json as typeof pushes));
    url = /<([^>]+)>;\s*rel="next"/.exec(headers.link ?? '')?.[1];
  }
  const wanted = new Set(branch.commits);
  const pushers = new Map<string, string | null>();
  for (const push of pushes.reverse()) {
    if (ZERO.test(push.after)) continue;
    const from = push.activity_type === 'push' && !ZERO.test(push.before) ? push.before : branch.base;
    // Every page of what the push brought, so no commit is left for the fallback.
    for (let page = 1; ; page++) {
      const { status, json } = await sys.http(`${API}/repos/${branch.repo}/compare/${from}...${push.after}?per_page=100&page=${page}`, { token });
      if (status !== 200) throw new Error(`cannot compare ${from.slice(0, 7)}...${push.after.slice(0, 7)} (HTTP ${status})`);
      const brought = (json as { commits?: { sha: string }[] } | null)?.commits ?? [];
      for (const { sha } of brought) {
        if (wanted.has(sha) && !pushers.has(sha)) pushers.set(sha, push.actor?.login ?? null);
      }
      if (brought.length < 100) break;
    }
  }
  return pushers;
}
