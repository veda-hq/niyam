import { API, anyLogin, either, loadSettings } from './agent.ts';
import { PERSONAL_REPO, isOn, isPersonal, notAdoptedLine, offLine } from './features.ts';
import { instant } from './instant.ts';
import type { Output, Sys } from './types.ts';

/**
 * The line a Work item's spec carries once every slice it needs is filed
 * (#655): until it is there, a Work item whose filed slices are all closed
 * may still have slices to file, so nothing closes it.
 */
export const ALL_FILED = /^\s*\*\*Slices:\*\*\s*all filed\.?\s*$/im;

/** How the comment niyam leaves before it closes a Work item opens, so a second run posts no second one. */
const CLOSING = 'All of its sub-issues are closed';

/** An issue as GitHub's REST API answers it, as far as a Work item's close reads it. */
export interface DoneIssue {
  number: number;
  /** Its address in GitHub's REST API, `…/repos/owner/name/issues/N`: which repository it is in. */
  url: string;
  body?: string | null;
  type?: { name: string } | null;
  state?: string;
  state_reason?: string | null;
  closed_at?: string | null;
  labels?: { name?: string }[];
  sub_issues_summary?: { total?: number } | null;
  pull_request?: unknown;
}

type Event = { event: string; created_at: string; actor?: { login: string } | null; label?: { name: string } };

/** A Work item's verdict: done, with the sub-issues that say so, or why it stays open. */
export type Verdict = { done: true; item: DoneIssue; subIssues: DoneIssue[] } | { done: false; why: string };

/** The repository `owner/name` an issue's REST address, `…/repos/owner/name/issues/N`, is in. */
const repoOf = (url: string): string => url.slice(`${API}/repos/`.length).split('/').slice(0, 2).join('/');

/** How a line names `issue` from repository `here`: `#N` there, `owner/name#N` elsewhere. */
const nameIn = (issue: DoneIssue, here: string): string => {
  const repo = repoOf(issue.url);
  return repo.toLowerCase() === here.toLowerCase() ? `#${issue.number}` : `${repo}#${issue.number}`;
};

/** `url`'s JSON, or throws naming what could not be read. */
async function read(sys: Sys, token: string, url: string, what: string): Promise<unknown> {
  const { status, json } = await sys.http(url, { token });
  if (status !== 200) throw new Error(`cannot read ${what}: ${(json as { message?: string } | null)?.message ?? `HTTP ${status}`} (${url.replace(API, '')})`);
  return json;
}

/**
 * Every item of the REST list at `url`, 100 a page, from page `page` on. It
 * recurses rather than loops, so a list that never ends stops at a page
 * GitHub does not answer.
 */
async function list<T>(sys: Sys, token: string, url: string, what: string, page = 1): Promise<T[]> {
  const json = await read(sys, token, `${url}${url.includes('?') ? '&' : '?'}per_page=100&page=${page}`, what);
  if (!Array.isArray(json)) throw new Error(`cannot read ${what}: GitHub did not answer a list (${url.replace(API, '')})`);
  return json.length === 100 ? [...(json as T[]), ...(await list<T>(sys, token, url, what, page + 1))] : (json as T[]);
}

/** The latest of `times` as an instant, or -Infinity when none reads as one, so it is later than nothing. */
const latest = (times: (string | null | undefined)[]): number => Math.max(-Infinity, ...times.map((time) => instant(time ?? undefined) ?? -Infinity));

/** Whether an issue carries label `name`. */
const labelled = (issue: DoneIssue, name: string): boolean => issue.labels?.some((label) => label.name === name) ?? false;

/**
 * Whether Work item `number` of `slug` is done, so niyam closes it (#655):
 * it is open, an owner's `approved` label is on it, its body says
 * `**Slices:** all filed`, no ask waits on it, every sub-issue and every
 * State under its Slices is closed, at least one Slice closed as completed,
 * and it was not reopened after the last of them closed. Else why it stays
 * open. The line is read first, so a Work item without it costs one read.
 */
export async function workItemDone(sys: Sys, token: string, slug: string, number: number, owners: readonly string[]): Promise<Verdict> {
  const url = `${API}/repos/${slug}/issues/${number}`;
  const item = (await read(sys, token, url, `#${number}`)) as DoneIssue;
  if (item.pull_request || item.type?.name !== 'Work item') return { done: false, why: 'it is not a Work item' };
  if (item.state === 'closed') return { done: false, why: 'it is closed already' };
  // A body GitHub holds as null reads as "null", which names no line.
  if (!ALL_FILED.test(String(item.body))) return { done: false, why: 'its body has no "**Slices:** all filed" line, so it may have slices still to file' };
  if (labelled(item, 'needs-owner')) return { done: false, why: 'an ask waits on it (it is labelled needs-owner)' };
  const events = await list<Event>(sys, token, `${url}/timeline`, `#${number}'s timeline`);
  // Only a labeled or unlabeled event carries a label.
  const approval = events.filter((event) => event.label?.name === 'approved').at(-1);
  if (approval?.event !== 'labeled' || !anyLogin(owners, approval.actor?.login ?? undefined)) {
    return { done: false, why: `${either(owners)} has not approved it (no approved label of theirs is on it)` };
  }
  const subIssues = await list<DoneIssue>(sys, token, `${url}/sub_issues`, `#${number}'s sub-issues`);
  if (subIssues.length === 0) return { done: false, why: 'it has no sub-issues' };
  const total = item.sub_issues_summary?.total ?? subIssues.length;
  if (total > subIssues.length) {
    return { done: false, why: `GitHub lists ${subIssues.length} of its ${total} sub-issues; the rest cannot be read with this token, so it cannot tell they are closed` };
  }
  const open = subIssues.filter((one) => one.state !== 'closed');
  if (open.length > 0) return { done: false, why: `${open.map((one) => nameIn(one, slug)).join(', ')} ${open.length === 1 ? 'is' : 'are'} still open` };
  const slices = subIssues.filter((one) => one.type?.name === 'Slice');
  // A State is a fix a closed slice still owes; one in another repository is listed by its own slice.
  const states: DoneIssue[] = [];
  for (const slice of slices) states.push(...(await list<DoneIssue>(sys, token, `${slice.url}/sub_issues`, `${nameIn(slice, slug)}'s States`)));
  const owed = states.filter((one) => one.state !== 'closed');
  if (owed.length > 0) return { done: false, why: `${owed.map((one) => nameIn(one, slug)).join(', ')} under its slices ${owed.length === 1 ? 'is' : 'are'} still open` };
  if (!slices.some((slice) => slice.state_reason === 'completed')) {
    return { done: false, why: 'none of its slices closed as completed, so it built nothing, and closing it is the owner\'s' };
  }
  const lastClosed = latest([...subIssues, ...states].map((one) => one.closed_at));
  const reopened = latest(events.filter((event) => event.event === 'reopened').map((event) => event.created_at));
  if (reopened > lastClosed) return { done: false, why: 'it was reopened after the last of its sub-issues closed' };
  return { done: true, item, subIssues };
}

/** Why GitHub refused a write, with how to fix a workflow that grants no issues: write. */
function refusedWrite(result: { status: number; json: unknown }, what: string): never {
  const why = (result.json as { message?: string } | null)?.message ?? `HTTP ${result.status}`;
  const hint = /not accessible/i.test(why) ? '; the client workflow needs issues: write here, so run niyam onboard to update it' : '';
  throw new Error(`cannot ${what}: ${why}${hint}`);
}

/**
 * Judges Work item `number` of `slug` and closes it as completed when it is
 * done, after a comment naming its sub-issues and, when given, what closed
 * the last of them; a comment there already is not posted again. Says on
 * `io` what it did, or why the Work item stays open.
 */
export async function closeIfDone(sys: Sys, io: Output, token: string, slug: string, number: number, owners: readonly string[], last?: string): Promise<boolean> {
  const verdict = await workItemDone(sys, token, slug, number, owners);
  if (!verdict.done) {
    io.out(`- #${number} stays open: ${verdict.why}`);
    return false;
  }
  const url = `${API}/repos/${slug}/issues/${number}`;
  const comments = await list<{ body?: string | null }>(sys, token, `${url}/comments`, `#${number}'s comments`);
  const names = verdict.subIssues.map((one) => nameIn(one, slug)).join(', ');
  if (!comments.some((one) => String(one.body).startsWith(CLOSING))) {
    const body = `${CLOSING} (${names})${last ? `, the last by ${last}` : ''}, and its spec says its slices are all filed: closing this Work item.`;
    const posted = await sys.http(`${url}/comments`, { method: 'POST', token, body: { body } });
    if (posted.status !== 201) refusedWrite(posted, `comment on #${number}`);
  }
  const closed = await sys.http(url, { method: 'PATCH', token, body: { state: 'closed', state_reason: 'completed' } });
  if (closed.status !== 200) refusedWrite(closed, `close #${number}`);
  io.out(`✓ #${number}: closed, since all ${verdict.subIssues.length} of its sub-issues are closed (${names})`);
  return true;
}

/**
 * The hourly sweep, `niyam work-done` (#657): closes each open Work item of
 * the repository that is done, as Slice done would at a merge. It catches a
 * last slice closed by hand, dropped as not planned, or closed by a pull
 * request in another repository, which no Slice done run here sees: a close
 * made with a workflow's GITHUB_TOKEN starts no workflow run, so no
 * `issues: closed` event would. Only a Work item whose body says
 * `**Slices:** all filed` is read past the list.
 */
export async function workDone(sys: Sys, io: Output): Promise<number> {
  const { GITHUB_REPOSITORY: slug, GH_TOKEN: token } = sys.env;
  if (!slug || !token) throw new Error('work-done runs in GitHub Actions: GITHUB_REPOSITORY and GH_TOKEN must be set');
  const notAdopted = notAdoptedLine(sys, sys.cwd, 'work-done');
  if (notAdopted) {
    io.out(notAdopted);
    return 0;
  }
  if (!isOn(sys, sys.cwd, 'work-rules')) {
    io.out(offLine('work-done', 'work-rules'));
    return 0;
  }
  if (await isPersonal(sys, slug, token)) {
    io.out(offLine('work-done', 'work-rules', PERSONAL_REPO));
    return 0;
  }
  const open = await list<DoneIssue>(sys, token, `${API}/repos/${slug}/issues?state=open&type=Work%20item`, `${slug}'s open Work items`);
  const filed = open.filter((item) => !item.pull_request && ALL_FILED.test(String(item.body)));
  if (filed.length === 0) {
    io.out(`work-done: ${open.length} open Work item${open.length === 1 ? '' : 's'}, none saying its slices are all filed; nothing to close`);
    return 0;
  }
  const { owners } = loadSettings(sys, sys.cwd);
  for (const item of filed) await closeIfDone(sys, io, token, slug, item.number, owners);
  return 0;
}
