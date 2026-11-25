import { API, type Settings, anyLogin, either, isNoToken, loadSettings, repoAt, sameLogin } from './agent.ts';
import { PERSONAL_REPO, isOn, isPersonal, notAdoptedLine, offLine, readRepo } from './features.ts';
import { agentSession, pushIdentityProblem } from './push-identity.ts';
import { MOST_COMMITS, RECORD_READS, RECORD_WAIT_MS, commitsOf, whoPushed } from './identity.ts';
import { cloudToken } from './cloud.ts';
import { MOVED_FILES, ONBOARD_BRANCH, ONBOARD_FILES } from './onboard-pull.ts';
import type { Output, Sys } from './types.ts';
import { GITHUB_HOST_RE, GITHUB_WEB } from './host.ts';
import { boardStarted } from './board.ts';
import { gate } from './handoff.ts';
import { ownersAlone, whyNotCounted } from './edits.ts';
import { batchAnswers } from './approvals.ts';
import { approvalsOf } from './issue-types.ts';
import { PAGE_LINK, askProblem } from './asks.ts';
import { Pulls, type PullsOf, RETIRED_REFUSAL, refuseRetired } from './pr-autocreate.ts';
import { errorDetail } from './error-detail.ts';

/** An issue a `Slice:` or `State:` line names: its repository, `owner/name`, and its number. */
export interface IssueRef {
  repo: string;
  number: number;
}

/**
 * How a line names an issue: `#N` in the repository it is in, or another
 * repository's issue as `owner/name#N` or by its full address.
 */
const REPO_NAMED = '[A-Za-z0-9-]+/[A-Za-z0-9._-]+';
const ISSUE_NAMED = `(?:#(\\d+)|(${REPO_NAMED})#(\\d+)|https://${GITHUB_HOST_RE}/(${REPO_NAMED})/issues/(\\d+))`;

/** How a pull request or a commit names the slice it builds. */
const SLICE_LINE = new RegExp(`^Slice:\\s*${ISSUE_NAMED}\\s*$`, 'gim');

/** How a pull request names a State of its slice that it delivers. */
const STATE_LINE = new RegExp(`^State:\\s*${ISSUE_NAMED}\\s*$`, 'gim');

/** Dependabot's account, the only one that opens pull requests from a DEPENDABOT_BRANCH branch. */
const DEPENDABOT = 'dependabot[bot]';

/** The prefix of every branch Dependabot opens a pull request from. */
const DEPENDABOT_BRANCH = 'dependabot/';

/** Whether `a` and `b` name one repository: GitHub reads owner and name in any case. */
const sameRepo = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** Whether `a` and `b` are one issue. */
export const sameIssue = (a: IssueRef, b: IssueRef): boolean => a.number === b.number && sameRepo(a.repo, b.repo);

/** How a message names `ref` from repository `here`: `#N` there, `owner/name#N` anywhere else. */
export function refName(ref: IssueRef, here: string): string {
  return sameRepo(ref.repo, here) ? `#${ref.number}` : `${ref.repo}#${ref.number}`;
}

/**
 * The issues `line` names in `text`, read from repository `here`, in order,
 * without repeats: a line naming `here` by name is one of its own issues.
 */
function named(line: RegExp, text: string, here: string): IssueRef[] {
  const refs: IssueRef[] = [];
  for (const match of text.matchAll(line)) {
    const repo = match[2] ?? match[4];
    const ref = { repo: repo === undefined || sameRepo(repo, here) ? here : repo, number: Number(match[1] ?? match[3] ?? match[5]) };
    if (!refs.some((one) => sameIssue(one, ref))) refs.push(ref);
  }
  return refs;
}

/** The slices `text` names, read from repository `here`, in order, without repeats. */
export function slicesNamed(text: string, here: string): IssueRef[] {
  return named(SLICE_LINE, text, here);
}

/** The States `text` names with a line `State: #N`, read from repository `here`, in order, without repeats. */
export function statesNamed(text: string, here: string): IssueRef[] {
  return named(STATE_LINE, text, here);
}

interface Comment {
  id: number | string;
  /** Its GraphQL id, from which its edits are read. */
  node_id?: string;
  user: { login: string } | null;
  body: string;
  created_at: string;
  updated_at: string;
  /** Its own address on GitHub, `…/issues/N#issuecomment-ID`: where the owner acts on it. */
  html_url: string;
}

interface Issue {
  number: number;
  title: string;
  body?: string | null;
  /** The issue's address in GitHub's REST API, from which its comments, sub-issues and timeline are read. */
  url: string;
  type: { name: string } | null;
  state?: string;
  state_reason: string | null;
  closed_at: string | null;
  pull_request?: unknown;
}

type TimelineEvent =
  | { event: 'labeled' | 'unlabeled'; created_at: string; actor: { login: string } | null; label: { name: string } }
  | { event: 'sub_issue_added'; created_at: string; sub_issue: { number: number } | null }
  | { event: 'parent_issue_added'; created_at: string }
  | ({ event: 'commented' } & Comment)
  | { event: 'other' };

interface Reaction {
  user: { login: string } | null;
  created_at: string;
}

/** The slice a read is for, as its errors name it: a number in this repository, another's `owner/name#N`. */
type Slice = number | string;

/** How an error names `slice`. */
const tagOf = (slice: Slice): string => (typeof slice === 'number' ? `#${slice}` : slice);

/**
 * Reads `url` from GitHub's REST API for slice `slice`'s work rules: its
 * JSON, or undefined on 404 when `missing` allows it. The work rules read
 * REST alone, so they run wherever GitHub's REST API answers, a Claude
 * cloud session's GitHub proxy included, which refuses GraphQL.
 */
async function rest(sys: Sys, token: string, slice: Slice, url: string, missing = false): Promise<unknown> {
  const { status, json } = await sys.http(url, { token });
  if (status === 404 && missing) return undefined;
  if (status !== 200) {
    const why = (json as { message?: string } | null)?.message ?? `HTTP ${status}`;
    // A client workflow from before the work rules grants no issues: read. Another repository's slice is read with
    // whatever the token reaches there, which onboard does not set.
    const hint = /not accessible/i.test(why)
      ? typeof slice === 'number'
        ? '; the client workflow needs issues: read, so run niyam onboard to update it'
        : `; this token cannot read ${slice.replace(/#\d+$/, '')}`
      : '';
    throw new Error(`cannot read ${tagOf(slice)}: ${why} (${url.replace(API, '')})${hint}`);
  }
  return json;
}

/** Every item of a REST list at `url`, 100 a page: GitHub's most. */
async function every<T>(sys: Sys, token: string, slice: Slice, url: string, missing = false): Promise<T[]> {
  const items: T[] = [];
  for (let page = 1; ; page++) {
    const json = await rest(sys, token, slice, `${url}${url.includes('?') ? '&' : '?'}per_page=100&page=${page}`, missing);
    if (json === undefined) return items;
    if (!Array.isArray(json)) throw new Error(`cannot read ${tagOf(slice)}: GitHub did not answer a list (${url.replace(API, '')})`);
    items.push(...(json as T[]));
    if (json.length < 100) return items;
  }
}

/** When a comment was last edited, or undefined: GitHub moves `updated_at` on an edit, not on a reaction. */
const editedAt = (comment: Comment): string | undefined => (comment.updated_at > comment.created_at ? comment.updated_at : undefined);

/** The owners' `Decision:` comments among `comments`, after `since` when given, mentioning `mention` when given. */
function decisionsIn(comments: Comment[], owners: string[], since?: string, mention?: string): Comment[] {
  return comments.filter(
    (comment) =>
      anyLogin(owners, comment.user?.login) &&
      /^\s*Decision:/i.test(comment.body) &&
      (!since || comment.created_at > since) &&
      (!mention || new RegExp(`${mention}\\b`).test(comment.body)),
  );
}

/**
 * Whether one of the owners' `decisions` counts: one no one edited does at
 * once, without GraphQL; an edited one only if owners made every edit. When
 * none counts and an edit is why, `note` says so.
 */
async function decided(sys: Sys, token: string, decisions: Comment[], owners: string[]): Promise<{ settled: boolean; note?: string }> {
  if (decisions.some((decision) => !editedAt(decision))) return { settled: true };
  const counted = await ownersAlone(sys, token, decisions, owners);
  const note = whyNotCounted(counted, '"Decision:" comment');
  return { settled: counted.kept.length > 0, ...(note ? { note } : {}) };
}

/** A proposal's first line, and the issue it names first: what the proposal is for. */
const PROPOSAL = /^\s*Proposal:[^#\n]*#(\d+)\b/i;

/** The agents' proposals among `comments` for issue `number`. */
function proposalsFor(comments: Comment[], agents: string[], number: number): Comment[] {
  return comments.filter((comment) => anyLogin(agents, comment.user?.login) && Number(PROPOSAL.exec(comment.body)?.[1]) === number);
}

/** A decision the owner owes a slice: its addition after the work item's approval, or a state dropped after it. */
interface Owed {
  kind: 'added' | 'dropped';
  /** The slice, when it was added; the state, when it was dropped. */
  number: number;
  title: string;
  /** The body of the slice, or of the state: what a proposal says for it. */
  body: string;
  /** The owner's say counts only after this, when given: the slice's latest addition. */
  since?: string;
  /** The agent's proposals for it, on the slice. */
  proposals: Comment[];
  /**
   * Whether the owner gave it: a `Decision:` comment, a request on the work
   * item the slice links, a batch answer on the Approvals issue naming it on
   * its first line, or 👍 on one of the proposals.
   */
  settled: boolean;
  /** Why an owner's edited `Decision:` comment did not settle it, when one was there. */
  note?: string;
}

/**
 * Whether an owner reacted 👍 to one of `proposals`, after `since` when
 * given and after the proposal's last edit, from the reactions read by id.
 */
function thumbsUp(proposals: Comment[], reactions: Map<Comment['id'], Reaction[]>, owners: string[], since?: string): boolean {
  return proposals.some((proposal) =>
    (reactions.get(proposal.id) ?? []).some((reaction) => {
      const edited = editedAt(proposal);
      return anyLogin(owners, reaction.user?.login) && (!since || reaction.created_at > since) && (!edited || reaction.created_at > edited);
    }),
  );
}

/**
 * Whether the slice's `body` links a comment an owner wrote on work item
 * `parent` before `since`, the slice's latest addition: a request on GitHub
 * is its own approval. GitHub, not the link, says who wrote the comment, on
 * which issue and when; one edited since it was written does not count,
 * since REST does not say who edited it.
 */
function requested(body: string, slug: string, parent: number, comments: Comment[], owners: string[], since: string): boolean {
  const link = new RegExp(`https://${GITHUB_HOST_RE}/${slug.replaceAll('.', '\\.')}/issues/${parent}#issuecomment-(\\d+)\\b`, 'gi');
  const linked = new Set([...body.matchAll(link)].map((match) => match[1]));
  return comments.some(
    (comment) => linked.has(String(comment.id)) && anyLogin(owners, comment.user?.login) && comment.created_at < since && !editedAt(comment),
  );
}

/** Issue `number` of `slug`, or undefined when there is none (a pull request is not one). */
async function readIssue(sys: Sys, token: string, slug: string, number: number): Promise<Issue | undefined> {
  const issue = (await rest(sys, token, number, `${API}/repos/${slug}/issues/${number}`, true)) as Issue | undefined;
  return issue && !issue.pull_request ? issue : undefined;
}

/**
 * The issue `issue` is a sub-issue of, none, or why it could not be read.
 * Read from the parent endpoint, not the issue's `parent_issue_url`: on a
 * private repository a workflow's GITHUB_TOKEN gets that field back as null.
 */
async function parentOf(sys: Sys, token: string, issue: Issue, nameOf = (number: number): string => `#${number}`): Promise<{ parent?: Issue; problem?: string }> {
  const { status, json } = await sys.http(`${issue.url}/parent`, { token });
  if (status === 200) return { parent: json as Issue };
  const message = (json as { message?: string } | null)?.message;
  // An issue with no parent reads as 404 "No parent issue found"; any other failure is a read that failed, not a missing parent.
  if (status === 404 && message && /no parent/i.test(message)) return {};
  return { problem: `could not read ${nameOf(issue.number)}'s parent (HTTP ${status}${message ? `: ${message}` : ''})` };
}

/**
 * Issue `ref` from another repository than `here`, or the problem that
 * refuses it: one the token cannot read there (GitHub answers 404 or 403
 * for a private repository it does not reach) or a pull request.
 */
async function foreignIssue(sys: Sys, token: string, here: string, ref: IssueRef): Promise<{ issue?: Issue; problem?: string }> {
  const name = refName(ref, here);
  const url = `${API}/repos/${ref.repo}/issues/${ref.number}`;
  const { status, json } = await sys.http(url, { token });
  const message = (json as { message?: string } | null)?.message;
  if (status === 404 || status === 403 || status === 401) {
    return {
      problem: `${name} cannot be read with this token (HTTP ${status}${message ? `: ${message}` : ''}): a slice in another repository counts only where the token reads that repository, and a workflow's GITHUB_TOKEN reads no private repository but ${here}`,
    };
  }
  if (status !== 200) throw new Error(`cannot read ${name}: ${message ?? `HTTP ${status}`} (${url.replace(API, '')})`);
  const issue = json as Issue;
  return issue.pull_request ? { problem: `${name} is a pull request, not an issue` } : { issue };
}

/**
 * Reads slice `ref` against the work rules' approvals: the problems that
 * stop it outright (not a Slice under a Work item an owner approved), else
 * the decisions it owes an owner and whether each was given. The slice may
 * be in another repository than `here`, the one being pushed or checked:
 * it is then read there, by the owners and agents `here`'s settings name,
 * and the Approvals issue is the one that repository's settings name.
 */
async function readSlice(
  sys: Sys,
  token: string,
  here: string,
  ref: IssueRef,
  settings: Settings,
): Promise<{ problems: string[]; parent?: number; owed: Owed[]; closed?: boolean; states?: Issue[]; approvals?: number }> {
  const { owners, agents } = settings;
  const { repo: slug, number: slice } = ref;
  const foreign = !sameRepo(slug, here);
  const nameOf = (number: number): string => refName({ repo: slug, number }, here);
  // How errors name the slice: a number here, `owner/name#N` from another repository.
  const tag: Slice = foreign ? nameOf(slice) : slice;
  let issue: Issue | undefined;
  if (foreign) {
    const read = await foreignIssue(sys, token, here, ref);
    if (read.problem) return { problems: [read.problem], owed: [] };
    issue = read.issue;
  } else {
    issue = await readIssue(sys, token, slug, slice);
  }
  if (!issue) return { problems: [`#${slice} is not an issue in ${slug}`], owed: [] };
  if (issue.type?.name !== 'Slice') return { problems: [`${nameOf(slice)} is not a Slice (its type is ${issue.type?.name ?? 'none'})`], owed: [] };
  const { parent, problem } = await parentOf(sys, token, issue, nameOf);
  if (problem) return { problems: [problem], owed: [] };
  if (parent?.type?.name !== 'Work item') return { problems: [`${nameOf(slice)} is not a sub-issue of a Work item`], owed: [] };
  // Another repository's batch answers are on its own Approvals issue.
  const approvals = foreign
    ? await approvalsOf(sys, token, slug).catch(() => {
        // fail-open: settings there that cannot be read name no Approvals issue, which only takes a way to pass away.
        return undefined;
      })
    : settings.approvals;

  const events = await every<TimelineEvent>(sys, token, tag, `${parent.url}/timeline`);
  const approval = events
    .filter((event): event is Extract<TimelineEvent, { event: 'labeled' | 'unlabeled' }> => (event.event === 'labeled' || event.event === 'unlabeled') && event.label.name === 'approved')
    .at(-1);
  if (approval?.event !== 'labeled') {
    return { problems: [`work item ${nameOf(parent.number)}, ${issueUrl(slug, parent.number)}, is not approved: ${either(owners)} adds the approved label before any slice starts`], owed: [] };
  }
  if (!anyLogin(owners, approval.actor?.login)) {
    return { problems: [`work item ${nameOf(parent.number)}, ${issueUrl(slug, parent.number)}, was labeled approved by ${approval.actor?.login ?? 'someone unknown'}, not ${either(owners)}`], owed: [] };
  }
  const approvedAt = approval.created_at;
  const parentComments = events.filter((event): event is { event: 'commented' } & Comment => event.event === 'commented');
  // Every comment on the slice, so a proposal or decision that later discussion pushed back still counts.
  const comments = await every<Comment>(sys, token, tag, `${issue.url}/comments`);
  // Every state, however many: one past the first page can be a dropped one.
  const states = await every<Issue>(sys, token, tag, `${issue.url}/sub_issues`);
  // The Approvals issue's comments, read once a check and only when a decision owed may need them; an
  // Approvals issue GitHub cannot find answers nothing. Only an owner's comment whose first line approves
  // `number`, made after `since`, counts there.
  let batch: Comment[] | undefined;
  const batchFor = async (number: number, since: string): Promise<Comment[]> => {
    if (approvals === undefined) return [];
    batch ??= await every<Comment>(sys, token, tag, `${API}/repos/${slug}/issues/${approvals}/comments`, true);
    return batchAnswers(batch, owners, number, since);
  };

  const owed: Owed[] = [];
  // When the slice was last added to its work item. A workflow's GITHUB_TOKEN on a private repository reads the
  // work item's sub_issue_added events with `sub_issue` null, so the slice's own parent_issue_added events say it.
  const joined = async (number: Slice, url: string): Promise<string[]> =>
    (await every<TimelineEvent>(sys, token, number, `${url}/timeline`))
      .filter((event) => event.event === 'parent_issue_added')
      .map((event) => (event as { created_at: string }).created_at);
  const mine = [
    ...(await joined(tag, issue.url)),
    ...events.flatMap((event) => (event.event === 'sub_issue_added' && event.sub_issue?.number === slice ? [event.created_at] : [])),
  ];
  // An addition after approval that names no issue may be this slice's. It is put down to another sub-issue of the
  // work item only when that one's own timeline records an addition at the same moment; any other counts as this
  // slice's, so it owes the owner's say rather than passing.
  let hidden = events.flatMap((event) =>
    event.event === 'sub_issue_added' && !event.sub_issue && event.created_at > approvedAt && !mine.includes(event.created_at) ? [event.created_at] : [],
  );
  if (hidden.length > 0) {
    for (const sibling of await every<Issue>(sys, token, tag, `${parent.url}/sub_issues`)) {
      if (sibling.number === slice || hidden.length === 0) continue;
      const theirs = await joined(tag, sibling.url);
      hidden = hidden.filter((at) => !theirs.includes(at));
    }
  }
  const added = [...mine, ...hidden].sort().at(-1);
  if (added && added > approvedAt) {
    const local = [...decisionsIn(parentComments, owners, added, `#${slice}`), ...decisionsIn(comments, owners, added)];
    // The Approvals issue is read only when no request and no unedited decision here settles it.
    const decision = requested(issue.body ?? '', slug, parent.number, parentComments, owners, added)
      ? { settled: true }
      : await decided(sys, token, local.some((one) => !editedAt(one)) ? local : [...local, ...(await batchFor(slice, added))], owners);
    owed.push({
      kind: 'added',
      number: slice,
      title: issue.title,
      body: issue.body ?? '',
      since: added,
      proposals: proposalsFor(comments, agents, slice),
      ...decision,
    });
  }
  for (const state of states) {
    if (state.type?.name !== 'State' || state.state_reason !== 'not_planned' || !state.closed_at || state.closed_at < approvedAt) continue;
    const onSlice = decisionsIn(comments, owners, undefined, `#${state.number}`);
    // The state's own comments, and the Approvals issue's after the state was dropped, are read only when no
    // unedited decision on the slice settles it.
    const decisions = onSlice.some((one) => !editedAt(one))
      ? onSlice
      : [...onSlice, ...decisionsIn(await every<Comment>(sys, token, tag, `${state.url}/comments`), owners), ...(await batchFor(state.number, state.closed_at))];
    owed.push({
      kind: 'dropped',
      number: state.number,
      title: state.title,
      body: state.body ?? '',
      proposals: proposalsFor(comments, agents, state.number),
      ...(await decided(sys, token, decisions, owners)),
    });
  }

  // Reactions are read only for the proposals that could still settle something; a deleted proposal has none.
  const reactions = new Map<Comment['id'], Reaction[]>();
  for (const proposal of owed.filter((one) => !one.settled).flatMap((one) => one.proposals)) {
    reactions.set(proposal.id, await every<Reaction>(sys, token, tag, `${API}/repos/${slug}/issues/comments/${proposal.id}/reactions?content=%2B1`, true));
  }
  for (const one of owed) one.settled ||= thumbsUp(one.proposals, reactions, owners, one.since);
  return { problems: [], parent: parent.number, owed, closed: issue.state === 'closed', states, ...(approvals === undefined ? {} : { approvals }) };
}

/**
 * What is wrong with the States a pull request for slice `slice` names with
 * `State: #N` lines, so the merged job can close them: each must be a State
 * under the slice, and a pull request for a slice closed already, a fix,
 * must name the open State it is filed as.
 */
function stateProblems(slice: IssueRef, here: string, closed: boolean, states: Issue[], names: IssueRef[]): string[] {
  const name = refName(slice, here);
  const problems = names.flatMap((ref) =>
    sameRepo(ref.repo, slice.repo) && states.some((state) => state.number === ref.number && state.type?.name === 'State')
      ? []
      : [`${refName(ref, here)} is not a State under slice ${name}; a "State: #N" line names a State sub-issue of the slice the pull request builds`],
  );
  if (closed && !namesOpenState(slice, states, names)) {
    problems.push(`${name} is closed, so this pull request is a fix: file it as a State under ${name} with ${stateCommand(slice, here)} and name it with a line "State: ${sameRepo(slice.repo, here) ? '#N' : `${slice.repo}#N`}"`);
  }
  return problems;
}

/** Whether `names` name an open State among `states`, slice `slice`'s sub-issues: a State is in the slice's repository. */
function namesOpenState(slice: IssueRef, states: Issue[], names: IssueRef[]): boolean {
  return states.some((state) => names.some((ref) => sameRepo(ref.repo, slice.repo) && ref.number === state.number) && state.type?.name === 'State' && state.state !== 'closed');
}

/**
 * The command that files a State under slice `slice`, run in a clone of its
 * repository when that is not `here`. The slice is a bare number: pasted
 * into bash, an unquoted `#12` would start a comment.
 */
function stateCommand(slice: IssueRef, here: string): string {
  return `${sameRepo(slice.repo, here) ? '' : `(in a clone of ${slice.repo}) `}niyam state ${slice.number} --title "…"`;
}

/**
 * Why `owed` stops slice `slice`, and how the owner settles it; a slice in
 * another repository than `here` is settled there, on its Approvals issue
 * `approvals`.
 */
function owedProblem(one: Owed, slice: IssueRef, here: string, parent: number | undefined, approvals: number | undefined, { owners, agents }: Settings): string {
  const owner = either(owners);
  // The agent proposes as itself; with several, any of them.
  const agent = either(agents);
  const at = (number: number | undefined): string => (number === undefined ? '#undefined' : refName({ repo: slice.repo, number }, here));
  const s = at(slice.number);
  const where = sameRepo(slice.repo, here) ? '' : ` in a clone of ${slice.repo}`;
  const ask = `${one.note ? ` (${one.note})` : ''}${one.proposals.length > 0 ? '' : `; ${agent} proposes it${where} with: ${proposeCommand(one.number)}`}`;
  // Each place the owner acts, by its full address, so an agent passes on a link, never a bare number.
  const issue = (number: number | undefined): string => issueUrl(slice.repo, number);
  // The comment the owner reacts to, where there is one; else the slice, where the proposal is to be posted.
  const on =
    one.proposals.length > 0
      ? `${agent}'s proposal${one.kind === 'added' ? '' : ' for it'}, ${newest(one.proposals).html_url}`
      : `${agent}'s proposal${one.kind === 'added' ? '' : ' for it'} on ${s}, ${issue(slice.number)}`;
  // Where the settings name an Approvals issue, one comment there answers this among a batch.
  const batch = approvals === undefined ? '' : `, or ${owner} comments on ${at(approvals)}, the Approvals issue, ${issue(approvals)}, with a first line "Decision: approve #${one.number}"`;
  return one.kind === 'added'
    ? `${s} was added to work item ${at(parent)}, ${issue(parent)}, after its approval; ${owner} reacts 👍 on ${on}, or adds a "Decision:" comment naming #${slice.number} on ${issue(slice.number)}, or ${s} links ${owner}'s request for it on ${at(parent)}${batch}${ask}`
    : `state ${at(one.number)}, ${issue(one.number)}, was closed as not planned after approval; ${owner} reacts 👍 on ${on}, or adds a "Decision:" comment to it${batch}${ask}`;
}

/** Issue `number`'s own address on GitHub, where the owner acts on it. */
export function issueUrl(slug: string, number: number | undefined): string {
  return `${GITHUB_WEB}/${slug}/issues/${number}`;
}

/** An open pull request, as GitHub's REST list gives it. */
interface OpenPull {
  number: number;
  body: string | null;
  html_url?: string;
  head: { ref: string; repo: { full_name: string } | null };
}

/** A pull request's own address on GitHub: GitHub's, else built from its number. */
export function pullUrl(slug: string, number: number, given?: unknown): string {
  return typeof given === 'string' && given.startsWith('https://') ? given : `${GITHUB_WEB}/${slug}/pull/${number}`;
}

/**
 * The command that deletes branch `ref` on origin, quoted where the shell
 * would read it otherwise. A branch starting `-` or `+` is named in full,
 * `refs/heads/…`, so git reads it neither as an option nor as a forced push.
 */
export function deleteBranchCommand(ref: string): string {
  const target = /^[-+]/.test(ref) ? `refs/heads/${ref}` : ref;
  return `git push origin --delete ${/^[\w./+-]+$/.test(target) ? target : `'${target.replaceAll("'", "'\\''")}'`}`;
}

/**
 * Why `pull` stops another pull request for slice `slice`, with its address
 * and, when it is superseded, what to do: close it and, for a branch in this
 * repository (`here`), delete its branch, as an agent does itself.
 */
function secondPull(slug: string, slice: IssueRef, pull: OpenPull, here: boolean): string {
  const remedy = here ? `close it and delete its branch: ${deleteBranchCommand(pull.head.ref)}` : 'close it';
  return `${refName(slice, slug)} already has pull request #${pull.number}, ${pullUrl(slug, pull.number, pull.html_url)}; one slice, one pull request. If #${pull.number} is superseded, ${remedy}`;
}

/**
 * The work rules for building one slice, as problems; none means it may be
 * built: the slice is a Slice under a Work item the owner approved; a slice
 * added after the approval, and an approved State closed as not planned, each
 * carry the owner's say, a `Decision:` comment or a 👍 on the agent's
 * proposal; no other open pull request builds the slice; and, for a pull
 * request, whose States are in `mine.states`, each is a State under the slice
 * and a closed slice's names an open one. For a push, `mine.warnings` gets
 * what does not stop it: a closed slice whose branch has no open pull request
 * naming an open State under it, since that pull request will be refused.
 */
export async function sliceProblems(
  sys: Sys,
  token: string,
  slug: string,
  which: number | IssueRef,
  accounts: Settings,
  mine: { pull?: number; branch?: string; states?: IssueRef[]; warnings?: string[] },
): Promise<string[]> {
  // A slice in this repository may be given by its number alone.
  const slice = typeof which === 'number' ? { repo: slug, number: which } : which;
  const read = await readSlice(sys, token, slug, slice, accounts);
  if (read.problems.length > 0) return read.problems;
  const problems = read.owed.filter((one) => !one.settled).map((one) => owedProblem(one, slice, slug, read.parent, read.approvals, accounts));
  if (mine.states) problems.push(...stateProblems(slice, slug, read.closed ?? false, read.states ?? [], mine.states));

  // The pull request being checked: by number, or by its branch in this repository (not a fork's of the same name).
  let own: OpenPull | undefined;
  for (let page = 1; ; page++) {
    const pulls = await sys.http(`${API}/repos/${slug}/pulls?state=open&per_page=100&page=${page}`, { token });
    if (pulls.status !== 200 || !Array.isArray(pulls.json)) throw new Error(`cannot list open pull requests (HTTP ${pulls.status})`);
    for (const pull of pulls.json as OpenPull[]) {
      const here = pull.head.repo?.full_name.toLowerCase() === slug.toLowerCase();
      if (pull.head.ref === mine.branch && here) own = pull;
      if (pull.number === mine.pull || (pull.head.ref === mine.branch && here)) continue;
      if (slicesNamed(pull.body ?? '', slug).some((one) => sameIssue(one, slice))) problems.push(secondPull(slug, slice, pull, here));
    }
    if (pulls.json.length < 100) break;
  }
  if (mine.warnings && !mine.states && read.closed && !namesOpenState(slice, read.states ?? [], statesNamed(own?.body ?? '', slug))) {
    mine.warnings.push(`${refName(slice, slug)} is closed, so its next pull request is a fix and needs a State: ${stateCommand(slice, slug)}`);
  }
  return problems;
}

function report(io: Output, where: string, problems: string[]): number {
  for (const problem of problems) io.err(`✗ ${problem}`);
  if (problems.length > 0) {
    io.err(`${where}: refused by the work rules`);
    return 1;
  }
  return 0;
}

/**
 * Why Dependabot's pull request `pull` carries more than Dependabot pushed, from
 * GitHub's record of the pushes to its branch, or undefined when it carries
 * only that. A commit the record does not yet credit is read again a moment
 * later, then fails closed, as PR identity does.
 */
async function notDependabots(
  sys: Sys,
  token: string,
  slug: string,
  pull: { number: number; base?: { sha: string }; head: { ref: string; repo?: { full_name: string } | null } },
): Promise<string | undefined> {
  const head = pull.head.repo?.full_name;
  if (!head || !pull.base) return `#${pull.number}'s branch has no record GitHub can read, so nothing shows that ${DEPENDABOT} pushed all of it`;
  const commits = await commitsOf(sys, token, slug, pull.number);
  if (commits.length >= MOST_COMMITS) return `#${pull.number} has ${MOST_COMMITS} or more commits, more than GitHub lists, so nothing shows that ${DEPENDABOT} pushed all of them`;
  const branch = { repo: head, ref: pull.head.ref, base: pull.base.sha, commits: commits.map((commit) => commit.sha) };
  let pushers = new Map<string, string | null>();
  for (let read = 1; ; read++) {
    pushers = await whoPushed(sys, token, branch);
    if (read === RECORD_READS || commits.every((commit) => pushers.has(commit.sha))) break;
    await sys.sleep(RECORD_WAIT_MS);
  }
  const stray = commits.filter((commit) => !sameLogin(pushers.get(commit.sha) ?? undefined, DEPENDABOT));
  if (stray.length === 0) return undefined;
  const named = stray.map((commit) => `${commit.sha.slice(0, 7)} (${pushers.has(commit.sha) ? `pushed by ${pushers.get(commit.sha) ?? 'an account GitHub no longer names'}` : 'no push recorded yet'})`).join(', ');
  return `#${pull.number} is ${DEPENDABOT}'s, which no work rule binds and a review may skip, but it carries ${named}; open a pull request of your own that carries the bump and the change, and close this one`;
}

/**
 * The work rules on a pull request, run by the shared workflow. A pull
 * request from a DEPENDABOT_BRANCH branch fails unless Dependabot opened it,
 * whoever did, and Dependabot's fails unless Dependabot pushed every commit
 * on it (#591). Otherwise the owner's pull requests pass; an agent's
 * must name exactly one slice, as a line
 * `Slice: #N`, that may be built, and name with lines `State: #N` only States
 * under it, at least one open one when the slice is closed already (a fix);
 * but for onboard's own: from ONBOARD_BRANCH alone in this repository,
 * changing only the files onboard writes and deleting none but the cloud
 * setup file under its name before P-56 (MOVED_FILES), only where the new
 * one is written or is on the base branch, which the owner confirmed at the
 * terminal and merges.
 */
export async function prWorkRules(sys: Sys, io: Output): Promise<number> {
  const { GITHUB_EVENT_PATH: eventPath, GITHUB_REPOSITORY: slug, GH_TOKEN: token } = sys.env;
  if (!eventPath || !slug || !token) {
    throw new Error('pr-work-rules runs in GitHub Actions: GITHUB_EVENT_PATH, GITHUB_REPOSITORY and GH_TOKEN must be set');
  }
  const event = JSON.parse(sys.read(eventPath)) as {
    pull_request?: { number: number; body: string | null; user: { login: string }; base?: { sha: string }; head: { ref: string; repo?: { full_name: string } | null } };
  };
  const pull = event.pull_request;
  if (!pull) {
    io.out('pr-work-rules: not a pull request; nothing to check');
    return 0;
  }
  const notAdopted = notAdoptedLine(sys, sys.cwd, 'pr-work-rules');
  if (notAdopted) {
    io.out(notAdopted);
    return 0;
  }
  const accounts = loadSettings(sys, sys.cwd);
  if (!isOn(sys, sys.cwd, 'work-rules')) {
    io.out(offLine('pr-work-rules', 'work-rules'));
    return 0;
  }
  if (await isPersonal(sys, slug, token)) {
    io.out(offLine('pr-work-rules', 'work-rules', PERSONAL_REPO));
    return 0;
  }
  // A review may skip dependabot/ branches as Dependabot's, matching the branch alone (niyam's cubic.yaml, #579), so
  // any other author's pull request from one is refused, an owner's or a fork's included (#591).
  if (pull.head.ref.startsWith(DEPENDABOT_BRANCH) && !sameLogin(pull.user.login, DEPENDABOT)) {
    return report(io, 'pr-work-rules', [
      `#${pull.number} is from the branch ${pull.head.ref}, but only ${DEPENDABOT} opens pull requests from ${DEPENDABOT_BRANCH} branches, which a review may skip as Dependabot's; push it to a branch of another name`,
    ]);
  }
  // Dependabot's pull request is held to none of the rules below, and a review may skip it, so it carries only what
  // Dependabot pushed: a fix lands through a pull request of its own that carries the bump (#591).
  if (sameLogin(pull.user.login, DEPENDABOT)) {
    const stray = await notDependabots(sys, token, slug, pull);
    if (stray) return report(io, 'pr-work-rules', [stray]);
  }
  if (!anyLogin(accounts.agents, pull.user.login)) {
    io.out(`pr-work-rules: #${pull.number} is by ${pull.user.login}, not an agent; the work rules bind agent pull requests`);
    return 0;
  }
  if (pull.head.ref === ONBOARD_BRANCH && pull.head.repo?.full_name.toLowerCase() === slug.toLowerCase()) {
    const files = await every<{ filename: string; status?: string; previous_filename?: string }>(sys, token, pull.number, `${API}/repos/${slug}/pulls/${pull.number}/files`);
    const names = files.flatMap((file) => [file.filename, ...(file.previous_filename ? [file.previous_filename] : [])]);
    // onboard writes its files and deletes none but the cloud setup file under its name before P-56, only into its
    // new name, written here or already on the base: any other deleted workflow or settings file would switch the checks off.
    const kept = (path: string): boolean => files.some((file) => file.filename === path && file.status !== 'removed') || sys.exists(`${sys.cwd}/${path}`);
    const moved = files.every((file) =>
      file.status === 'removed'
        ? MOVED_FILES[file.filename] !== undefined && kept(MOVED_FILES[file.filename] as string)
        : // A copy deletes nothing, as GitHub may show the cloud setup file written under both names.
          file.status === 'copied' || file.previous_filename === undefined || file.previous_filename === file.filename || MOVED_FILES[file.previous_filename] === file.filename,
    );
    if (names.every((name) => ONBOARD_FILES.includes(name)) && moved) {
      io.out(`✓ pr-work-rules: #${pull.number} is onboard's, changing only the files onboard writes, so it names no slice`);
      return 0;
    }
  }
  const slices = slicesNamed(pull.body ?? '', slug);
  if (slices.length !== 1) {
    return report(io, 'pr-work-rules', [
      slices.length === 0
        ? `#${pull.number} names no slice; add a line "Slice: #N" to its description`
        : `#${pull.number} names ${slices.length} slices (${slices.map((one) => refName(one, slug)).join(', ')}); an agent pull request builds exactly one`,
    ]);
  }
  const [slice] = slices as [IssueRef];
  const problems = await sliceProblems(sys, token, slug, slice, accounts, { pull: pull.number, states: statesNamed(pull.body ?? '', slug) });
  if (problems.length === 0) io.out(`✓ pr-work-rules: #${pull.number} builds slice ${refName(slice, slug)}, which may be built`);
  return report(io, 'pr-work-rules', problems);
}

const ZERO = /^0+$/;

/** The token an agent session reaches GitHub with: in a Claude cloud session, through its proxy. */
export function sessionToken(sys: Sys): string | undefined {
  if (sys.env.CLAUDE_CODE_REMOTE === 'true') return cloudToken(sys);
  const token = sys.env.GH_TOKEN;
  // A lock's placeholder, this release's or one an older release wrote, is no token.
  return token && !isNoToken(token) ? token : undefined;
}

function gitLog(sys: Sys, root: string, args: string[]): string {
  const log = sys.exec('git', ['log', ...args], { cwd: root });
  if (log.code !== 0) throw new Error(`git log failed: ${log.stderr.trim()}`);
  return log.stdout;
}

/**
 * When every commit in `range` is a merge, the messages of the commits its
 * tip reaches that the merges did not bring in: the branch's own, a merge's
 * first parent being the branch it was made on. Otherwise undefined.
 */
function branchBeyondMerges(sys: Sys, root: string, range: string[]): string | undefined {
  const parents = gitLog(sys, root, ['--format=%P', ...range]).split('\n').filter(Boolean).map((line) => line.split(' '));
  if (parents.some((commit) => commit.length < 2)) return undefined;
  return gitLog(sys, root, ['--no-merges', '--format=%B', range[0] as string, '--not', ...parents.flatMap((commit) => commit.slice(1))]);
}

/** A full commit id, as GitHub's API and `git rev-parse` give one. */
const COMMIT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/**
 * The remote's default branch, as GitHub names it, and the commits in this
 * clone where it is, every commit they reach being the default branch's, not
 * a push's own: its tip as GitHub names it, when the clone has that commit,
 * and its remote-tracking ref on origin, when there is one. Either may be
 * missing or behind in a clone, such as a single-branch clone that fetched
 * the default branch into FETCH_HEAD alone. No branch when GitHub names none.
 */
async function defaultBranch(sys: Sys, root: string, slug: string, token: string): Promise<{ branch?: string; tips: string[] }> {
  const branch = ((await readRepo(sys, slug, token)).json as { default_branch?: unknown } | null)?.default_branch;
  if (typeof branch !== 'string' || !branch) return { tips: [] };
  const ref = await sys.http(`${API}/repos/${slug}/git/ref/heads/${branch.split('/').map(encodeURIComponent).join('/')}`, { token });
  const sha = ref.status === 200 ? (ref.json as { object?: { sha?: unknown } } | null)?.object?.sha : undefined;
  const tips: string[] = [];
  for (const where of [...(typeof sha === 'string' && COMMIT_ID.test(sha) ? [sha] : []), `refs/remotes/origin/${branch}`]) {
    const found = sys.exec('git', ['rev-parse', '--verify', '--quiet', `${where}^{commit}`], { cwd: root });
    const commit = found.stdout.trim();
    if (found.code === 0 && COMMIT_ID.test(commit) && !tips.includes(commit)) tips.push(commit);
  }
  return { branch, tips };
}

/**
 * The commits that merges in `range` brought in, other than through their
 * first parent, that GitHub says are on its default branch `branch`: a merge
 * of the default branch fetched after the clone's tips for it, so that they
 * do not reach what it brought.
 */
async function mergedFromDefault(sys: Sys, root: string, slug: string, token: string, branch: string, range: string[]): Promise<string[]> {
  const merges = gitLog(sys, root, ['--merges', '--format=%P', ...range]).split('\n').filter(Boolean);
  const brought = new Set(merges.flatMap((line) => line.split(' ').slice(1)).filter((commit) => COMMIT_ID.test(commit)));
  const found: string[] = [];
  for (const parent of brought) {
    const compared = await sys.http(`${API}/repos/${slug}/compare/${branch.split('/').map(encodeURIComponent).join('/')}...${parent}?per_page=1`, { token });
    const status = compared.status === 200 ? (compared.json as { status?: unknown } | null)?.status : undefined;
    if (status === 'behind' || status === 'identical') found.push(parent);
  }
  return found;
}

/**
 * Before a push from an agent session, run by the client's pre-push git hook
 * with git's ref lines on stdin and the remote's URL and name: first that it
 * reaches GitHub as the agent, the pre-push identity guard, which holds even
 * in a session whose Claude Code hooks never ran. Then that no pushed branch
 * is one whose pull request merged with none open, as `niyam pr-autocreate
 * refuse-retired` judges it: such a push recreates a branch the merge
 * retired, and its commits land in no pull request; a branch GitHub cannot
 * answer for only warns. Then the work rules: all the commits one push
 * brings, across every ref, must name exactly one slice between them, as a
 * trailer `Slice: #N`, that may be built. Commits a remote already has, and
 * the commits on the remote's default branch that the clone can find, are not
 * the push's own, so a merge of the default branch brings none of its slices;
 * where the clone's tips for the default branch are behind, GitHub is asked
 * which of the commits the push's merges brought are on it. A push whose own
 * commits name no slice, such as a merge or a commit with no trailer, is
 * judged by the branch's own commits: those the default branch does not
 * reach or, where the clone cannot tell where the default branch is and the
 * push's commits are all merges, those the merges did not bring. Pushes
 * outside agent sessions pass; an agent session with no token is refused.
 */
export async function prePush(sys: Sys, io: Output, refLines: string, url: string, remote: string): Promise<number> {
  if (!agentSession(sys)) return 0;
  const { root, slug } = repoAt(sys);
  const accounts = loadSettings(sys, root);
  const identity = await pushIdentityProblem(sys, root, url, accounts.agents);
  if (identity) {
    io.err(`✗ ${identity}`);
    io.err(`pre-push: refused; an agent session pushes to GitHub only as ${either(accounts.agents)}`);
    return 1;
  }
  // refuse-retired's own check, on the hook's stderr. Whatever else it exits, a warning said so and the push goes on.
  const hook: Output = { out: (line) => io.err(line), err: (line) => io.err(line) };
  // Asked with the session's own token alone: never gh's signed-in account, which on this Mac is the owner's.
  const session = sessionToken(sys);
  const pullsOf: PullsOf = () => (session ? new Pulls(sys, slug, session, sys.env.CLAUDE_CODE_REMOTE === 'true') : { problem: 'this agent session has no token; run niyam doctor' });
  const retired = await refuseRetired(sys, hook, ['--root', root, '--remote', remote], refLines, pullsOf).catch((error: unknown) => {
    // fail-open: as refuse-retired's own crash does, this warns "not checked" and the work rules still run.
    io.err(`⚠️  Could not check whether a pushed branch's PR already merged (${errorDetail(error)}); not checked.`);
    return 0;
  });
  if (retired === RETIRED_REFUSAL) {
    io.err('pre-push: refused; a merged pull request retired this branch');
    return 1;
  }
  // The hand-off gate, where the repository names its plumbing: on its own setting, not a feature.
  if ((await gate(sys, io, undefined)) !== 0) return 1;
  if (!isOn(sys, root, 'work-rules')) {
    io.err(offLine('pre-push', 'work-rules'));
    return 0;
  }
  const token = sessionToken(sys);
  if (!token) {
    return report(io, 'pre-push', ['this agent session has no token, so the work rules cannot be checked; run niyam doctor']);
  }
  if (await isPersonal(sys, slug, token)) {
    io.err(offLine('pre-push', 'work-rules', PERSONAL_REPO));
    return 0;
  }
  const { branch, tips } = await defaultBranch(sys, root, slug, token);
  let messages = '';
  const branches: string[] = [];
  for (const line of refLines.split('\n').filter(Boolean)) {
    const [, local, remoteRef, remote] = line.split(' ');
    if (!local || !remoteRef || ZERO.test(local)) continue;
    let base = tips;
    const rangeOf = (not: string[]): string[] => [local, '--not', ...(remote && !ZERO.test(remote) ? [remote] : []), '--remotes', ...not];
    let log = gitLog(sys, root, ['--format=%B', ...rangeOf(base)]);
    if (!log.trim()) continue;
    // Asked of GitHub only when the push would be refused: what its merges brought from the default branch.
    if (branch && slicesNamed(log, slug).length !== 1) {
      const merged = await mergedFromDefault(sys, root, slug, token, branch, rangeOf(base));
      if (merged.length > 0) {
        base = [...base, ...merged];
        log = gitLog(sys, root, ['--format=%B', ...rangeOf(base)]);
      }
    }
    if (slicesNamed(log, slug).length === 0) {
      log = (base.length > 0 ? gitLog(sys, root, ['--format=%B', local, '--not', ...base]) : branchBeyondMerges(sys, root, rangeOf(base))) ?? log;
    }
    messages += `${log}\n`;
    branches.push(remoteRef.replace(/^refs\/heads\//, ''));
  }
  if (branches.length === 0) return 0;
  const slices = slicesNamed(messages, slug);
  const where = branches.join(', ');
  if (slices.length !== 1) {
    return report(io, 'pre-push', [
      slices.length === 0
        ? `the commits for ${where} name no slice; add a trailer "Slice: #N" to a commit message`
        : `the commits for ${where} name ${slices.length} slices (${slices.map((one) => refName(one, slug)).join(', ')}); one push builds one slice`,
    ]);
  }
  if (branches.length > 1) return report(io, 'pre-push', [`one push builds one slice on one branch; this one pushes ${where}`]);
  const [slice] = slices as [IssueRef];
  const warnings: string[] = [];
  const problems = await sliceProblems(sys, token, slug, slice, accounts, { branch: branches[0] as string, warnings });
  for (const warning of warnings) io.err(`⚠️  ${warning}`);
  if (problems.length === 0 && isOn(sys, root, 'board')) await moveBoard(sys, io, token, slug, slice);
  return report(io, 'pre-push', problems);
}

/** How a Claude cloud session's GitHub proxy refuses a path outside `repos/{owner}/{repo}/…`, such as an org's Projects. */
const CLOUD_PROXY_REFUSAL = /sessions are bound to their configured repositories/i;

/**
 * Moves the board on for slice `slice`, which a push is starting to build,
 * with the board feature on, through GitHub's REST API; a board it cannot
 * read, or a move GitHub refuses, is said and does not stop the push. A
 * Claude cloud session's proxy lets through only `repos/{owner}/{repo}/…`,
 * never an org's or a user's Projects, so there the push only says that the
 * shared workflow's Slice started job moves the slice when its pull request
 * opens.
 */
async function moveBoard(sys: Sys, io: Output, token: string, here: string, ref: IssueRef): Promise<void> {
  const slice = refName(ref, here);
  try {
    for (const line of await boardStarted(sys, token, ref.repo, ref.number)) io.err(line);
  } catch (error) {
    const message = (error as Error).message;
    io.err(
      CLOUD_PROXY_REFUSAL.test(message)
        ? `- board: this cloud session cannot reach the board; niyam's workflow moves ${slice} when its pull request opens`
        : `! board: could not read where ${slice} and its work item are on the board, so nothing moved (${message}); the push goes on`,
    );
  }
}

/** Throws for a write to an issue that GitHub refused, saying how to fix a workflow that grants no issues: write. */
function refused(result: { status: number; json: unknown }, what: string): never {
  const why = (result.json as { message?: string } | null)?.message ?? `HTTP ${result.status}`;
  // A client workflow from before this release grants this job no issues: write.
  const hint = /not accessible/i.test(why) ? '; the client workflow needs a job with issues: write for merged pull requests, so run niyam onboard to update it' : '';
  throw new Error(`cannot ${what}: ${why}${hint}`);
}

/**
 * Comments on `issue` that pull request `pull` built it, unless it says so
 * already, and closes it as completed unless it is closed: a slice or State
 * GitHub closed already, through a closing keyword beside its line, still
 * gets the comment.
 */
async function closeBuilt(sys: Sys, io: Output, token: string, issue: Issue, pull: { number: number; base: { ref: string } }): Promise<void> {
  const built = new RegExp(`\\bBuilt in #${pull.number}\\b`);
  const comments = await every<Comment>(sys, token, issue.number, `${issue.url}/comments`);
  const commented = comments.some((one) => built.test(one.body ?? ''));
  if (!commented) {
    const posted = await sys.http(`${issue.url}/comments`, { method: 'POST', token, body: { body: `Built in #${pull.number}, merged into ${pull.base.ref}.` } });
    if (posted.status !== 201) refused(posted, `${issue.state === 'closed' ? 'comment on' : 'close'} #${issue.number}`);
  }
  if (issue.state === 'closed') {
    io.out(
      commented
        ? `✓ #${issue.number} is closed already and says it was built in #${pull.number}`
        : `✓ #${issue.number} is closed already; commented that it was built in #${pull.number}`,
    );
    return;
  }
  const closed = await sys.http(issue.url, { method: 'PATCH', token, body: { state: 'closed', state_reason: 'completed' } });
  if (closed.status !== 200) refused(closed, `close #${issue.number}`);
  io.out(`✓ #${issue.number}: closed, built in #${pull.number}`);
}

/**
 * Closes the slices and States a merged pull request names, run by the
 * shared workflow when one merges into the default branch: each open Slice
 * it names with a line `Slice: #N`, and each open State under one of them it
 * names with a line `State: #N`, gets a comment linking the pull request and
 * is closed as completed, which the Project's Item closed workflow moves to
 * Done. Neither line is one of GitHub's closing keywords, so GitHub does not
 * close them. One that has the comment already gets no second one; a State
 * dropped as not planned, or under a slice the pull request does not name,
 * is left as it is.
 */
export async function prMerged(sys: Sys, io: Output): Promise<number> {
  const { GITHUB_EVENT_PATH: eventPath, GITHUB_REPOSITORY: slug, GH_TOKEN: token } = sys.env;
  if (!eventPath || !slug || !token) {
    throw new Error('pr-merged runs in GitHub Actions: GITHUB_EVENT_PATH, GITHUB_REPOSITORY and GH_TOKEN must be set');
  }
  const event = JSON.parse(sys.read(eventPath)) as {
    pull_request?: { number: number; body: string | null; merged?: boolean; base: { ref: string } };
    repository?: { default_branch?: string };
  };
  const pull = event.pull_request;
  if (!pull?.merged) {
    io.out('pr-merged: not a merged pull request; nothing to close');
    return 0;
  }
  const notAdopted = notAdoptedLine(sys, sys.cwd, 'pr-merged');
  if (notAdopted) {
    io.out(notAdopted);
    return 0;
  }
  if (!isOn(sys, sys.cwd, 'work-rules')) {
    io.out(offLine('pr-merged', 'work-rules'));
    return 0;
  }
  if (await isPersonal(sys, slug, token)) {
    io.out(offLine('pr-merged', 'work-rules', PERSONAL_REPO));
    return 0;
  }
  const branch = event.repository?.default_branch;
  if (branch && pull.base.ref !== branch) {
    io.out(`pr-merged: #${pull.number} merged into ${pull.base.ref}, not ${branch}; its slices stay open until their work reaches ${branch}`);
    return 0;
  }
  const slices = slicesNamed(pull.body ?? '', slug);
  if (slices.length === 0) io.out(`pr-merged: #${pull.number} names no slice; nothing to close`);
  // A slice or State in another repository is closed there, by whoever builds the rest of it: this workflow's
  // GITHUB_TOKEN writes only here, and never touches this repository's issue of the same number.
  const elsewhere = (ref: IssueRef): boolean => {
    if (sameRepo(ref.repo, slug)) return false;
    io.out(`- ${refName(ref, slug)} is in another repository; left as it is`);
    return true;
  };
  // The slices named that are Slices: a State is closed only under one of them.
  const built: number[] = [];
  for (const ref of slices) {
    if (elsewhere(ref)) continue;
    const slice = ref.number;
    const issue = await readIssue(sys, token, slug, slice);
    if (issue?.type?.name !== 'Slice') {
      io.out(`- #${slice} is not a Slice in ${slug}; left as it is`);
      continue;
    }
    built.push(slice);
    // GitHub closes a slice itself when the pull request also says "Closes #N"; the slice still gets its comment, once.
    await closeBuilt(sys, io, token, issue, pull);
  }
  for (const ref of statesNamed(pull.body ?? '', slug)) {
    if (elsewhere(ref)) continue;
    const { number } = ref;
    const issue = await readIssue(sys, token, slug, number);
    if (issue?.type?.name !== 'State') {
      io.out(`- #${number} is not a State in ${slug}; left as it is`);
      continue;
    }
    const { parent, problem } = await parentOf(sys, token, issue);
    if (problem) throw new Error(`cannot close #${number}: ${problem}`);
    if (!parent || !built.includes(parent.number)) {
      io.out(`- #${number} is not a State under a slice #${pull.number} names; left as it is`);
      continue;
    }
    if (issue.state_reason === 'not_planned') {
      io.out(`- #${number} was closed as not planned; left as it is`);
      continue;
    }
    await closeBuilt(sys, io, token, issue, pull);
  }
  return 0;
}

/**
 * Moves the board on for the slice a pull request names as it opens or
 * reopens, run by the shared workflow's Slice started job: the move a push
 * makes from the desktop, which a Claude cloud session's push cannot, since
 * its proxy never reaches an org's Projects. It moves nothing unless the
 * pull request names one slice, the board and work-rules features are on,
 * and the slice passes the work rules, which it reads with the workflow's
 * GH_TOKEN. A workflow's GITHUB_TOKEN cannot write a Project, so the board
 * moves with NIYAM_BOARD_TOKEN, minted from the board GitHub App. Without
 * that token, or when GitHub refuses, it says so and passes: the board never
 * fails a pull request.
 */
export async function prStarted(sys: Sys, io: Output): Promise<number> {
  const { GITHUB_EVENT_PATH: eventPath, GITHUB_REPOSITORY: slug, GH_TOKEN: token, NIYAM_BOARD_TOKEN: board } = sys.env;
  if (!eventPath || !slug || !token) {
    throw new Error('pr-started runs in GitHub Actions: GITHUB_EVENT_PATH, GITHUB_REPOSITORY and GH_TOKEN must be set');
  }
  const event = JSON.parse(sys.read(eventPath)) as { pull_request?: { number: number; body: string | null } };
  const pull = event.pull_request;
  if (!pull) {
    io.out('pr-started: not a pull request; nothing to move');
    return 0;
  }
  const notAdopted = notAdoptedLine(sys, sys.cwd, 'pr-started');
  if (notAdopted) {
    io.out(notAdopted);
    return 0;
  }
  for (const feature of ['work-rules', 'board'] as const) {
    if (!isOn(sys, sys.cwd, feature)) {
      io.out(offLine('pr-started', feature));
      return 0;
    }
  }
  if (await isPersonal(sys, slug, token)) {
    io.out(offLine('pr-started', 'work-rules', PERSONAL_REPO));
    return 0;
  }
  const slices = slicesNamed(pull.body ?? '', slug);
  if (slices.length !== 1) {
    io.out(`pr-started: #${pull.number} names ${slices.length === 0 ? 'no slice' : `${slices.length} slices`}; nothing moves on the board`);
    return 0;
  }
  const [ref] = slices as [IssueRef];
  const slice = refName(ref, slug);
  if (!board) {
    io.out(
      `pr-started: no board app token here (the NIYAM_BOARD_APP_ID and NIYAM_BOARD_APP_KEY secrets are not passed, or GitHub would not make the token), so ${slice} moves on the board only from a desktop push`,
    );
    return 0;
  }
  try {
    const problems = await sliceProblems(sys, token, slug, ref, loadSettings(sys, sys.cwd), { pull: pull.number, states: statesNamed(pull.body ?? '', slug) });
    if (problems.length > 0) {
      io.out(`pr-started: ${slice} may not be built yet (Work rules says why), so nothing moves on the board`);
      return 0;
    }
    const moved = await boardStarted(sys, board, ref.repo, ref.number);
    for (const line of moved) io.out(line);
    if (moved.length === 0) io.out(`pr-started: ${slice} and its work item are where they belong on the board already`);
  } catch (error) {
    // fail-open: the board never fails a pull request; Work rules judges the slice, and the line says what GitHub refused.
    io.out(`! board: nothing moved for ${slice} (${(error as Error).message}); the pull request's checks go on`);
  }
  return 0;
}

/** The newest of `comments`, which is not empty: GitHub lists comments oldest first. */
function newest(comments: Comment[]): Comment {
  return comments[comments.length - 1] as Comment;
}

/** The label that puts an issue in the owner's Needs you view. */
const NEEDS_OWNER = 'needs-owner';

/** The text of `body`'s section `**name:**`, up to the next line that starts a section, or undefined when it has none or it is empty. */
export function section(body: string, name: string): string | undefined {
  const lines = body.split(/\r?\n/);
  const head = new RegExp(`^\\s*\\*\\*${name}:\\*\\*`, 'i');
  const from = lines.findIndex((line) => head.test(line));
  if (from < 0) return undefined;
  const rest = lines.slice(from + 1);
  const to = rest.findIndex((line) => /^\s*\*\*[^*\n]+:\*\*/.test(line));
  const text = [(lines[from] as string).replace(head, ''), ...(to < 0 ? rest : rest.slice(0, to))].join('\n').trim();
  return text || undefined;
}

/** The sections a proposal for `one` takes from its body, by the name the body gives each. */
const NEEDED = { added: ['You will see', 'Why'], dropped: ['Why'] } as const;

/** What `one`'s body lacks for a proposal that stands alone, as a problem, or undefined. */
function proposalGap(one: Owed): string | undefined {
  const missing = NEEDED[one.kind].filter((name) => !section(one.body, name));
  if (missing.length === 0) return undefined;
  const what = one.kind === 'added' ? `#${one.number}` : `state #${one.number}`;
  return `${what}'s body has no ${missing.map((name) => `"**${name}:**"`).join(' or ')} section; write it there first, so the proposal says what changes and why`;
}

/** A `--page` value: the whole of it one published page, as the guard recognises one. */
const PAGE_ONLY = new RegExp(`^${PAGE_LINK.source}$`);

/** The command that proposes `number`, for a hint: the page comes first, then the pointer to it. */
function proposeCommand(number: number): string {
  return `niyam propose ${number} --page <page url>`;
}

/**
 * The `Proposal:` comment for `one`: a pointer, as every ask to the owner is
 * (the guard's rule): what is proposed in one line, the published page that
 * argues it, and how to answer. What changes, why and what it costs live on
 * the page, from the slice's sections.
 */
function proposalBody(slug: string, one: Owed, parent: number | undefined, page: string, { owners, approvals }: Settings): string {
  // The issue it is for comes first: that is how the work rules match a 👍 to it.
  const what = one.kind === 'added'
    ? `Proposal: add #${one.number} (${one.title}) to work item #${parent}.`
    : `Proposal: drop state #${one.number} (${one.title}), closed as not planned after work item #${parent}'s approval.`;
  // Where the settings name an Approvals issue, the owner may answer this there, among a batch.
  const batch = approvals === undefined ? '' : `, or answer the batch on Approvals, ${issueUrl(slug, approvals)}`;
  return `${what}\n\nPage: ${page}\n\n${either(owners.map((owner) => `@${owner}`))}: react 👍 to this comment to approve it, or comment "Decision:"${batch}.`;
}

/**
 * Proposes what each of `numbers` owes the owner, run by an agent session:
 * for a slice, one `Proposal:` comment on it, as the agent, for its addition
 * after the work item's approval and one for each state dropped after it,
 * labeling the slice `needs-owner`; for a State, that state alone. Run
 * again, it posts nothing twice, and once the owner has settled everything
 * it takes the label off. Where the settings name an Approvals issue, it
 * ends with the first line of the owner's batch answer there, naming every
 * proposal still waiting, ready to paste.
 *
 * Each comment is a pointer to `page`, the published page that argues the
 * proposals (one page for the run, a batch included), and is held to the
 * guard's rule for asks before it is posted. Without a page, a proposal yet
 * to be posted is refused with the command to run; a run that only links
 * proposals already posted needs none.
 */
export async function propose(sys: Sys, io: Output, numbers: readonly number[], page?: string): Promise<number> {
  const { root, slug } = repoAt(sys);
  const accounts = loadSettings(sys, root);
  if (!isOn(sys, root, 'work-rules')) {
    io.out(offLine('propose', 'work-rules'));
    return 0;
  }
  if (page !== undefined && !PAGE_ONLY.test(page)) {
    return report(io, 'propose', [`--page takes the link of a published page (https://claude.ai/artifact/… or https://claude.ai/code/artifact/…), not "${page}"`]);
  }
  const token = sessionToken(sys);
  if (!token) return report(io, 'propose', ['this session has no token; run niyam doctor']);
  if (await isPersonal(sys, slug, token)) {
    io.out(offLine('propose', 'work-rules', PERSONAL_REPO));
    return 0;
  }
  // Only the agent's proposals count, so one posted as anyone else would wait for nothing.
  const user = await sys.http(`${API}/user`, { token });
  const login = (user.json as { login?: string } | null)?.login;
  if (user.status !== 200 || !anyLogin(accounts.agents, login)) {
    return report(io, 'propose', [`propose posts as ${either(accounts.agents)}, but this session's token is ${login ?? 'refused'}`]);
  }

  let code = 0;
  // Each issue once, in the order given, though two of the numbers share a slice.
  const waiting = new Set<number>();
  for (const number of numbers) {
    const one = await proposeOne(sys, io, token, slug, accounts, number, page);
    code = Math.max(code, one.code);
    for (const each of one.waiting) waiting.add(each);
  }
  if (accounts.approvals !== undefined && waiting.size > 0) {
    // The agent hands the line over; only the owner's own comment approves anything.
    io.out(
      `${either(accounts.owners)} answers ${waiting.size === 1 ? 'it' : `all ${waiting.size}`} with one comment on ${GITHUB_WEB}/${slug}/issues/${accounts.approvals}, the Approvals issue, whose first line is this (deleting a number leaves that one waiting):`,
    );
    // The issues asked for come first, in the order given; what else waits on their slices follows.
    const ordered = new Set([...numbers.filter((number) => waiting.has(number)), ...waiting]);
    io.out(`Decision: approve ${[...ordered].map((number) => `#${number}`).join(' ')}`);
  }
  return code;
}

/**
 * `propose` for one issue: its exit code, and the issues whose proposals
 * still wait on the owner, each the number a batch answer names.
 */
async function proposeOne(
  sys: Sys,
  io: Output,
  token: string,
  slug: string,
  accounts: Settings,
  number: number,
  page: string | undefined,
): Promise<{ code: number; waiting: number[] }> {
  const issue = await readIssue(sys, token, slug, number);
  const { parent, problem } = issue?.type?.name === 'State' ? await parentOf(sys, token, issue) : {};
  if (problem) return { code: report(io, 'propose', [problem]), waiting: [] };
  const state = parent?.type?.name === 'Slice';
  const slice = state ? parent.number : number;
  const read = await readSlice(sys, token, slug, { repo: slug, number: slice }, accounts);
  if (read.problems.length > 0) return { code: report(io, 'propose', read.problems), waiting: [] };
  const owner = either(accounts.owners);
  const asked = read.owed.filter((one) => !state || one.number === number);
  if (asked.length === 0) {
    io.out(`propose: #${number} needs no decision from ${owner}`);
    return { code: 0, waiting: [] };
  }

  // A proposal says what it asks for, so one whose body cannot say it is not posted.
  const fresh = asked.filter((one) => !one.settled && one.proposals.length === 0);
  const gaps = fresh.map(proposalGap).filter((gap) => gap !== undefined);
  if (gaps.length > 0) return { code: report(io, 'propose', gaps), waiting: [] };
  const named = (one: Owed): string => (one.kind === 'added' ? `#${one.number}` : `state #${one.number}`);
  // A proposal is a pointer to the page that argues it, so with no page nothing is posted.
  if (fresh.length > 0 && page === undefined) {
    const which = fresh.map(named).join(' and ');
    return {
      code: report(io, 'propose', [
        `${which} ${fresh.length === 1 ? 'has' : 'have'} no proposal yet, and a proposal is a short pointer to the published page that argues it: publish the page, then run ${proposeCommand(number)}`,
      ]),
      waiting: [],
    };
  }
  // Each comment meets the guard's rule for asks (a page link, ASK_LIMIT characters) before any is posted.
  const bodies = new Map(page === undefined ? [] : fresh.map((one) => [one, proposalBody(slug, one, read.parent, page, accounts)] as const));
  const unfit = [...bodies].flatMap(([one, body]) => {
    const problem = askProblem({ text: body, known: true, opensUnknown: false }, accounts.owners);
    return problem ? [`${named(one)}'s proposal is not posted: ${problem}; shorten ${named(one)}'s title`] : [];
  });
  if (unfit.length > 0) return { code: report(io, 'propose', unfit), waiting: [] };

  const issues = `${API}/repos/${slug}/issues/${slice}`;
  // Each link opens the very comment the owner reacts 👍 to, never the slice's top or a label's list.
  const links = new Map<Owed, string | undefined>();
  for (const one of asked) {
    const what = one.kind === 'added' ? `#${slice}` : `state #${one.number}`;
    if (one.settled) {
      io.out(`✓ ${what}: ${owner} has decided`);
    } else if (one.proposals.length > 0) {
      links.set(one, newest(one.proposals).html_url);
      io.out(`${what}: proposed on #${slice}, waiting on ${owner}'s 👍: ${links.get(one)}`);
    } else {
      const posted = await sys.http(`${issues}/comments`, { method: 'POST', token, body: { body: bodies.get(one) } });
      if (posted.status !== 201) throw new Error(`cannot comment on #${slice} (HTTP ${posted.status})`);
      const url = (posted.json as { html_url?: string } | null)?.html_url;
      links.set(one, url);
      io.out(`✓ ${what}: proposed on #${slice}${url ? `: ${url}` : ''}`);
    }
  }
  const waiting = read.owed.filter((one) => !one.settled);
  if (waiting.length > 0) {
    const labeled = await sys.http(`${issues}/labels`, { method: 'POST', token, body: { labels: [NEEDS_OWNER] } });
    if (labeled.status !== 200) throw new Error(`cannot label #${slice} ${NEEDS_OWNER} (HTTP ${labeled.status})`);
    // A decision this run did not ask for still has its proposal's link, or the command that posts one.
    for (const one of waiting) if (!links.has(one) && one.proposals.length > 0) links.set(one, newest(one.proposals).html_url);
    const unproposed = waiting.filter((one) => !links.has(one)).map((one) => `; ${either(accounts.agents)} proposes #${one.number} with: ${proposeCommand(one.number)}`);
    const urls = [...links.values()].filter((url) => url !== undefined);
    const where = urls.length > 0 ? `, waiting on ${owner}'s 👍 on ${urls.join(' and ')}` : '';
    io.out(`#${slice} is labeled ${NEEDS_OWNER}${where}${unproposed.join('')}`);
    // Only what the owner can read a proposal for goes into a batch answer.
    return { code: 0, waiting: waiting.filter((one) => links.has(one)).map((one) => one.number) };
  }
  const removed = await sys.http(`${issues}/labels/${NEEDS_OWNER}`, { method: 'DELETE', token });
  // 404: the slice had no such label.
  if (removed.status !== 200 && removed.status !== 404) throw new Error(`cannot take ${NEEDS_OWNER} off #${slice} (HTTP ${removed.status})`);
  io.out(`✓ #${slice}: nothing waits on ${owner}`);
  return { code: 0, waiting: [] };
}

/** What GitHub said when it refused a write: its status and message. */
function whyRefused(result: { status: number; json: unknown }): string {
  const message = (result.json as { message?: unknown } | null)?.message;
  return `HTTP ${result.status}${typeof message === 'string' && message ? `: ${message}` : ''}`;
}

/**
 * Files a State under slice `slice`, run by an agent session: an issue of
 * type State titled `title`, attached under the slice through GitHub's
 * sub-issues API by its numeric id, which is not its number. Then it prints
 * the line, `State: #M`, that names it under the pull request's `Slice:`
 * line. It refuses an issue that is not a Slice. A pull request for an open
 * slice needs no State, so for one it says so; the State waits for the fix
 * after the slice closes. A State filed but not attached exits 1, with the
 * call that attaches it.
 */
export async function fileState(sys: Sys, io: Output, slice: number, title: string): Promise<number> {
  const { root, slug } = repoAt(sys);
  if (!isOn(sys, root, 'work-rules')) {
    io.out(offLine('state', 'work-rules'));
    return 0;
  }
  const failed = (problem: string): number => {
    io.err(`✗ ${problem}`);
    return 1;
  };
  const token = sessionToken(sys);
  if (!token) return failed('this session has no token; run niyam doctor');
  if (await isPersonal(sys, slug, token)) {
    io.out(offLine('state', 'work-rules', PERSONAL_REPO));
    return 0;
  }
  const issue = await readIssue(sys, token, slug, slice);
  if (!issue) return failed(`#${slice} is not an issue in ${slug}`);
  if (issue.type?.name !== 'Slice') return failed(`#${slice} is not a Slice (its type is ${issue.type?.name ?? 'none'}); a State is filed under the slice it is part of`);

  const filed = await sys.http(`${API}/repos/${slug}/issues`, { method: 'POST', token, body: { title, body: `Part of #${slice}.`, type: 'State' } });
  const state = filed.json as { id?: unknown; number?: unknown; html_url?: unknown } | null;
  if (filed.status !== 201 || typeof state?.id !== 'number' || typeof state.number !== 'number') return failed(`GitHub did not file the State (${whyRefused(filed)})`);
  const url = typeof state.html_url === 'string' && state.html_url.startsWith('https://') ? state.html_url : issueUrl(slug, state.number);
  const attached = await sys.http(`${API}/repos/${slug}/issues/${slice}/sub_issues`, { method: 'POST', token, body: { sub_issue_id: state.id } });
  if (attached.status !== 201) {
    return failed(
      `#${state.number}, ${url}, was filed but not attached under #${slice} (${whyRefused(attached)}); attach it with: gh api --method POST repos/${slug}/issues/${slice}/sub_issues -F sub_issue_id=${state.id}`,
    );
  }
  io.out(`✓ #${state.number}, ${url}: a State under #${slice}`);
  io.out(
    issue.state === 'closed'
      ? `Put this line under the pull request's "Slice: #${slice}" line:`
      : `#${slice} is open, so its pull request needs no State while it stays open; once it closes, the pull request that fixes it names this one under its "Slice: #${slice}" line:`,
  );
  io.out(`State: #${state.number}`);
  return 0;
}
