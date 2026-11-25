import { API, type Settings, anyLogin, hasSettings, loadSettings } from './agent.ts';
import { ownersAlone } from './edits.ts';
import { approvedIn, batchAnswers, firstIssue } from './approvals.ts';
import { isOn, notAdoptedLine, offLine } from './features.ts';
import { instant } from './instant.ts';
import { type ReadFile, type Simple, type Text, UNKNOWN, commands } from './shell.ts';
import type { HttpResult, Output, Sys } from './types.ts';
import { GITHUB_WEB } from './host.ts';

/** The label an ask puts on its issue, which the board's "Needs you" view lists. */
export const NEEDS_OWNER = 'needs-owner';
/** The longest comment that may ask the owner, in characters: the question, the page link and how to answer. */
export const ASK_LIMIT = 500;
/** A published page: a claude.ai artifact, as a session publishes it. */
export const PAGE_LINK = /https:\/\/claude\.ai\/(?:code\/)?artifact\/[\w-]+/;
/** The hourly sweep's cron, which the client's workflow and the shared one both name. */
export { HOURLY } from './features.ts';

/** A comment's opening word, past any spaces and Markdown emphasis, heading or quote marks before it. */
const OPENING = /^[\s*_#>]*([A-Za-z][A-Za-z ]*?):/;

/** The ask a comment opens with, `Needs you` or `Proposal`, or undefined; a comment with no body opens with none. */
export function opensAsk(body: string | null | undefined): 'Needs you' | 'Proposal' | undefined {
  const word = body?.match(OPENING)?.[1];
  return word === 'Needs you' || word === 'Proposal' ? word : undefined;
}

/** Whether a comment opens with `Decision:`, the owner's word. */
export function opensDecision(body: string | null | undefined): boolean {
  return body?.match(OPENING)?.[1] === 'Decision';
}

/** The first of `owners` a comment names, with or without an @, or undefined. */
function namedOwner(body: string, owners: readonly string[]): string | undefined {
  return owners.find((owner) => new RegExp(`(?<![\\w-])@?${owner}(?![\\w-])`, 'i').test(body));
}

/** Why a comment counts as asking the owner, or undefined when it does not. */
export function askedBy(body: string, owners: readonly string[]): string | undefined {
  const ask = opensAsk(body);
  if (ask) return `it opens with "${ask}:"`;
  const owner = namedOwner(body, owners);
  return owner ? `it names the owner, ${owner}` : undefined;
}

/**
 * Why a comment body may not be posted, or undefined when it may: one that
 * asks the owner links a published page and fits ASK_LIMIT characters. A
 * body with parts only the running shell knows is judged on the parts it
 * spells out; where those ask the owner, or it opens with an unknown part,
 * the guard cannot measure it, so it is refused with how to write it.
 */
export function askProblem(body: Text, owners: readonly string[]): string | undefined {
  if (body.opensUnknown) {
    return 'the guard cannot see how this comment opens, since it starts with a part only the shell knows (a variable or a command substitution) or comes from an editor, a prompt or the browser, so it cannot tell whether it asks the owner';
  }
  const why = askedBy(body.text.replaceAll(UNKNOWN, ' '), owners);
  if (!why) return undefined;
  if (!body.known) {
    return `this comment asks the owner (${why}), and the guard cannot measure it, since part of it only the shell knows (a variable or a command substitution)`;
  }
  const length = [...body.text.trim()].length;
  const missing = PAGE_LINK.test(body.text) ? [] : ['links no published page (https://claude.ai/artifact/… or https://claude.ai/code/artifact/…)'];
  const long = length > ASK_LIMIT ? [`runs ${length} characters, over ${ASK_LIMIT}`] : [];
  const problems = [...missing, ...long];
  return problems.length === 0 ? undefined : `this comment asks the owner (${why}), and it ${problems.join(' and ')}`;
}

/** The refusal the guard prints for an ask that breaks the rule. */
export function askRefusal(problem: string): string {
  return (
    `niyam: refused, because ${problem}. ` +
    'The rule: anything the owner must read, approve or choose arrives as a published page; the comment carries only the question, the page link and how to answer, ' +
    `in ${ASK_LIMIT} characters or fewer. ` +
    `Fix: publish the page first, then post a comment of at most ${ASK_LIMIT} characters that links it, ` +
    "written out in the command (quoted text, a quoted heredoc <<'EOF', or --body-file <file>) so the guard can read it."
  );
}

/** A gh command's flags that take a value, so the word after them is not an argument. */
const GH_VALUED = new Set(['-R', '--repo', '-b', '--body', '-F', '--body-file', '-f', '--raw-field', '--field', '--input', '-X', '--method', '-H', '--header', '-q', '--jq', '-t', '--template', '--hostname', '--cache', '-p', '--preview']);
/** gh api endpoints that create or edit a comment: an issue's or pull request's, a review comment's, or a reply to one. */
const COMMENT_ENDPOINT = /\/comments(?:\/\d+)?(?:\/replies)?\/?(?:\?|$)/;
/** GraphQL mutations that post or edit a comment. */
const COMMENT_MUTATION = /\b(?:addComment|updateIssueComment|addPullRequestReviewComment|addPullRequestReviewThreadReply|updatePullRequestReviewComment)\b/;

/** One flag's value, as `--flag value`, `--flag=value` or `-fvalue`, where `at` names the flag; undefined when it is not one. */
function flagValue(words: Text[], at: number, names: readonly string[]): { value: Text | undefined; next: number } | undefined {
  const word = words[at] as Text;
  for (const name of names) {
    if (word.text === name) return { value: words[at + 1], next: at + 2 };
    const joined = name.startsWith('--') ? `${name}=` : name;
    if (word.text.startsWith(joined) && word.text.length > joined.length) {
      const text = word.text.slice(joined.length);
      return { value: { ...word, text, opensUnknown: text.startsWith(UNKNOWN) }, next: at + 1 };
    }
  }
  return undefined;
}

const UNREADABLE = (what: string): Text => ({ text: what, known: false, opensUnknown: true });

/** A body read from a file a flag names: `-` is the command's standard input. */
function fromFile(path: Text | undefined, simple: Simple, read: ReadFile): Text {
  if (!path?.known) return UNREADABLE('');
  if (path.text === '-') return simple.stdin ?? UNREADABLE('');
  const text = read(path.text);
  return text === undefined ? UNREADABLE('') : { text, known: true, opensUnknown: false };
}

/**
 * The body a `gh issue comment` or `gh pr comment` posts; undefined only for
 * `--delete-last`, which posts none. With no body in the command, gh takes
 * it from an editor, a prompt or the browser, which the guard cannot read.
 */
function commentBody(args: Text[], simple: Simple, read: ReadFile): Text | undefined {
  // The last body flag from `at` on wins, as gh reads them.
  const from = (at: number, body: Text | undefined): Text | undefined => {
    if (at >= args.length) return body;
    const inline = flagValue(args, at, ['--body', '-b']);
    if (inline) return from(inline.next, inline.value ?? UNREADABLE(''));
    const file = flagValue(args, at, ['--body-file', '-F']);
    if (file) return from(file.next, fromFile(file.value, simple, read));
    return from(at + 1, body);
  };
  const body = from(0, undefined);
  if (body) return body;
  return args.some((word) => word.text === '--delete-last') ? undefined : UNREADABLE('');
}

/** A body written into a GraphQL query as `body: "…"`, read as GraphQL reads the string, or undefined. */
function queryBody(query: Text): Text | undefined {
  const written = /\bbody\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(query.text)?.[1];
  if (written === undefined) return undefined;
  // A part only the shell knows is a NUL in the query, which no JSON string holds, so a body read here is spelled out.
  try {
    return { text: JSON.parse(`"${written}"`) as string, known: query.known, opensUnknown: false };
  } catch {
    return UNREADABLE('');
  }
}

/** The first word of a gh command from `at` on that is not a flag or a flag's value, and where the next word stands; undefined past the end. */
function positional(args: Text[], at: number): { word: string; next: number } | undefined {
  if (at >= args.length) return undefined;
  const word = (args[at] as Text).text;
  if (!word.startsWith('-')) return { word, next: at + 1 };
  return positional(args, GH_VALUED.has(word) ? at + 2 : at + 1);
}

/** A `key=value` field of gh api, its value read as -F reads it (`@file`) when `typed`. */
function field(value: Text, typed: boolean, simple: Simple, read: ReadFile): { key: string; value: Text } | undefined {
  const [key, ...rest] = value.text.split('=');
  if (rest.length === 0) return undefined;
  const text = rest.join('=');
  const raw: Text = { ...value, text, opensUnknown: text.startsWith(UNKNOWN) };
  if (typed && raw.known && text.startsWith('@')) return { key: key as string, value: fromFile({ ...raw, text: text.slice(1) }, simple, read) };
  return { key: key as string, value: raw };
}

/** The body `--input` gives gh api: its `body`, or its GraphQL variables' `body`, or undefined when it has none. */
function inputBody(input: Text): Text | undefined {
  if (!input.known) return input;
  try {
    const parsed = JSON.parse(input.text) as { body?: unknown; variables?: { body?: unknown } } | null;
    const text = parsed?.body ?? parsed?.variables?.body;
    return typeof text === 'string' ? { text, known: true, opensUnknown: false } : undefined;
  } catch {
    return UNREADABLE('');
  }
}

/** The body a `gh api` call posts to a comment endpoint or in a comment mutation, or undefined when it posts none. */
function apiBody(args: Text[], simple: Simple, read: ReadFile): Text | undefined {
  let endpoint = '';
  const fields = new Map<string, Text>();
  let input: Text | undefined;
  // Each word from `at` on: a field, the input file, or the endpoint, the first word that is none of them.
  const scan = (at: number): void => {
    if (at >= args.length) return;
    const word = args[at] as Text;
    const raw = flagValue(args, at, ['--raw-field', '-f']);
    const typed = flagValue(args, at, ['--field', '-F']);
    const given = flagValue(args, at, ['--input']);
    const value = (raw ?? typed)?.value;
    if (value) {
      const parsed = field(value, typed !== undefined, simple, read);
      if (parsed) fields.set(parsed.key, parsed.value);
    } else if (given) {
      input = fromFile(given.value, simple, read);
    } else if (!word.text.startsWith('-')) {
      endpoint ||= word.text;
    }
    scan(GH_VALUED.has(word.text) ? at + 2 : at + 1);
  };
  scan(0);
  if (endpoint === 'graphql') {
    const query = fields.get('query');
    if (!query || !COMMENT_MUTATION.test(query.text)) return undefined;
    // A mutation names its body's variable as `body: $name`; gh passes each variable as a field of that name.
    const variable = /\bbody\s*:\s*\$(\w+)/.exec(query.text)?.[1];
    // Else its input's body, or else the body written into the query: that string, or else the whole query.
    return fields.get(variable ?? 'body') ?? (input ? inputBody(input) : (queryBody(query) ?? query));
  }
  if (!COMMENT_ENDPOINT.test(endpoint)) return undefined;
  return fields.get('body') ?? (input ? inputBody(input) : undefined);
}

/** The comment bodies a command line posts or edits through gh, each as the command spells it. */
export function commentBodies(line: string, read: ReadFile): Text[] {
  const bodies: Text[] = [];
  for (const simple of commands(line, read)) {
    const at = simple.words.findIndex((word) => word.known && /^(?:.*\/)?gh$/.test(word.text));
    if (at < 0) continue;
    const args = simple.words.slice(at + 1);
    const first = positional(args, 0);
    const group = first?.word;
    const action = first && positional(args, first.next)?.word;
    const body =
      (group === 'issue' || group === 'pr') && action === 'comment'
        ? commentBody(args, simple, read)
        : group === 'api'
          ? apiBody(args.slice(args.findIndex((word) => word.text === 'api') + 1), simple, read)
          : undefined;
    if (body) bodies.push(body);
  }
  return bodies;
}

/** The repository settings' owners for a command run in `cwd`: the nearest folder up that has them; none outside a client. */
export function ownersAround(sys: Sys, cwd: string): string[] {
  if (hasSettings(sys, cwd)) {
    try {
      return loadSettings(sys, cwd).owners;
    } catch {
      return [];
    }
  }
  return cwd.includes('/') ? ownersAround(sys, cwd.slice(0, cwd.lastIndexOf('/'))) : [];
}

/**
 * The guard's comment check: the first problem with a comment the command
 * would post through gh, or undefined. Files the command names are read
 * relative to `cwd`, where it runs.
 */
export function commentProblem(sys: Sys, line: string, cwd: string): string | undefined {
  const read: ReadFile = (path) => {
    const full = path.startsWith('/') ? path : path.startsWith('~/') ? `${sys.home}${path.slice(1)}` : `${cwd}/${path}`;
    return sys.exists(full) ? sys.read(full) : undefined;
  };
  // The settings are read only for a command that posts a comment, and once.
  let owners: string[] | undefined;
  for (const body of commentBodies(line, read)) {
    owners ??= ownersAround(sys, cwd);
    const problem = askProblem(body, owners);
    if (problem) return problem;
  }
  return undefined;
}

interface Comment {
  id: number;
  /** Its GraphQL id, from which its edits are read. */
  node_id?: string;
  body?: string | null;
  user?: { login?: string } | null;
  created_at: string;
  updated_at?: string;
  /** Its own address on GitHub, `…/issues/N#issuecomment-ID`: where the owner answers it. */
  html_url?: string;
}

interface Reaction {
  user?: { login?: string } | null;
  created_at: string;
}

/** Page `page` of a list GitHub returns, 100 a page. */
const listPage = (url: string, page: number): string => `${url}${url.includes('?') ? '&' : '?'}per_page=100&page=${page}`;

/** Every page of a list GitHub returns, from page `page` on, that page's reply `read` when it is already read. */
async function every<T>(sys: Sys, token: string, url: string, page = 1, read?: HttpResult): Promise<T[]> {
  const { status, json } = read ?? (await sys.http(listPage(url, page), { token }));
  if (status !== 200 || !Array.isArray(json)) throw new Error(`cannot read ${url.replace(API, '')} (HTTP ${status})`);
  return json.length < 100 ? (json as T[]) : [...(json as T[]), ...(await every<T>(sys, token, url, page + 1))];
}

/** Every page of a list GitHub returns, or undefined where it cannot find the list. */
async function everyFound<T>(sys: Sys, token: string, url: string): Promise<T[] | undefined> {
  const first = await sys.http(listPage(url, 1), { token });
  return first.status === 404 ? undefined : every<T>(sys, token, url, 1, first);
}

/** The later of two ISO 8601 times. */
const later = (a: string, b: string): string => [a, b].sort().reverse()[0] as string;

async function addLabel(sys: Sys, token: string, slug: string, number: number): Promise<void> {
  const added = await sys.http(`${API}/repos/${slug}/issues/${number}/labels`, { method: 'POST', token, body: { labels: [NEEDS_OWNER] } });
  if (added.status !== 200) throw new Error(`cannot label #${number} ${NEEDS_OWNER} (HTTP ${added.status})`);
}

/** Takes the label off; one already gone is fine. */
async function removeLabel(sys: Sys, token: string, slug: string, number: number): Promise<void> {
  const removed = await sys.http(`${API}/repos/${slug}/issues/${number}/labels/${NEEDS_OWNER}`, { method: 'DELETE', token });
  if (removed.status !== 200 && removed.status !== 404) throw new Error(`cannot take ${NEEDS_OWNER} off #${number} (HTTP ${removed.status})`);
}

/** An ask the owner owes an answer on an issue, and the issue a batch answer names to answer it. */
interface Owed {
  ask: Comment;
  number: number;
  kind: 'Needs you' | 'Proposal';
  /** The owner's answer counts only after this: the ask, or for a slice's addition its latest addition, if later. */
  since: string;
}

/**
 * The asks the owner owes on issue `number`, from its comments: each agent
 * `Proposal:`, for the issue its first line names first (this repository's
 * `#N`, as a batch answer names it: a slice for its addition, a State for
 * its drop; the issue itself when it names none), and the latest agent ask
 * when it is a `Needs you:`, for the issue itself.
 */
function owedOn(comments: Comment[], agents: string[], number: number): Owed[] {
  const asks = comments.flatMap((ask) => {
    const kind = anyLogin(agents, ask.user?.login ?? undefined) ? opensAsk(ask.body) : undefined;
    return kind ? [{ ask, kind, body: ask.body as string }] : [];
  });
  return asks.flatMap(({ ask, kind, body }, at): Owed[] => {
    if (kind === 'Proposal') return [{ ask, number: firstIssue(body.split(/\r?\n/, 1)[0] as string) ?? number, kind, since: ask.created_at }];
    return at === asks.length - 1 ? [{ ask, number, kind, since: ask.created_at }] : [];
  });
}

/** How the owner stands on an issue's asks: every ask answered (and with what), or the asks still waiting; undefined where no agent asked. */
type Standing = { answer: string } | { waiting: Owed[] } | undefined;

/**
 * Whether the owner has answered every ask on issue `number` (see `owedOn`),
 * from its comments, each ask on its own: a `Decision:` comment after it
 * that no one but owners edited, a 👍 after its last edit, or a batch answer
 * after it on the Approvals issue (`batch` reads its comments) whose first
 * line names the ask's issue, that no one but owners edited. A proposal for
 * the issue itself, a slice's addition, counts only answers after the issue
 * was last added to a parent, as the work rules count them, so a slice taken
 * out and added again waits on the owner's say again.
 * No agent asked there leaves the label to whoever put it on, such as the
 * weekly job's undo issues.
 */
async function answered(sys: Sys, token: string, slug: string, number: number, { owners, agents, approvals }: Settings, batch: () => Promise<Comment[] | undefined>): Promise<Standing> {
  const comments = await every<Comment>(sys, token, `${API}/repos/${slug}/issues/${number}/comments`);
  const owed = owedOn(comments, agents, number);
  if (owed.length === 0) return undefined;
  // The issue's own timeline says when it was last added to a parent: read only for a proposal for the issue itself,
  // and none where GitHub cannot find it.
  const additions = owed.filter((one) => one.kind === 'Proposal' && one.number === number);
  if (additions.length > 0) {
    const timeline = await everyFound<{ event?: string; created_at?: string }>(sys, token, `${API}/repos/${slug}/issues/${number}/timeline`);
    const added = timeline?.flatMap((event) => (event.event === 'parent_issue_added' && event.created_at ? [event.created_at] : [])).sort().at(-1);
    if (added) for (const one of additions) one.since = later(one.since, added);
  }
  const earliest = owed.map(({ ask }) => ask.created_at).sort()[0] as string;
  const decisions = comments.filter((comment) => comment.created_at > earliest && anyLogin(owners, comment.user?.login ?? undefined) && opensDecision(comment.body));
  // A Decision: someone other than an owner edited answers nothing.
  const decided = (await ownersAlone(sys, token, decisions, owners)).kept;
  const how = new Map<Owed, string>();
  for (const one of owed) {
    const { ask } = one;
    if (decided.some((decision) => decision.created_at > one.since)) {
      how.set(one, 'a Decision: comment');
      continue;
    }
    // A 👍 counts after the ask's last edit.
    const since = later(one.since, ask.updated_at ?? one.since);
    const reactions = await every<Reaction>(sys, token, `${API}/repos/${slug}/issues/comments/${ask.id}/reactions?content=%2B1`);
    if (reactions.some((reaction) => anyLogin(owners, reaction.user?.login ?? undefined) && reaction.created_at > since)) how.set(one, 'a 👍 on the ask');
  }
  // The Approvals issue is read last, only for asks the issue itself has not answered, and only where the settings name one.
  const open = owed.filter((one) => !how.has(one));
  const answers = open.length > 0 && approvals !== undefined ? await batch() : undefined;
  if (answers) {
    const named = open.map((one) => ({ one, batched: batchAnswers(answers, owners, one.number, one.since) }));
    const all = [...new Set(named.flatMap(({ batched }) => batched))];
    const counted = (await ownersAlone(sys, token, all, owners)).kept;
    for (const { one, batched } of named) {
      if (batched.some((answer) => counted.includes(answer))) how.set(one, `a "Decision: approve" on #${approvals}, the Approvals issue`);
    }
  }
  const waiting = owed.filter((one) => !how.has(one));
  return waiting.length > 0 ? { waiting } : { answer: [...new Set(how.values())].join(' and ') };
}

interface IssueEvent {
  event?: string;
  created_at?: string;
  actor?: { login?: string } | null;
  label?: { name?: string } | null;
}

/**
 * How the owner has answered issue `number` since the ask `ask`, the ask's
 * own run reading it, or undefined: their `approved` label, a `Decision:`
 * comment no one but owners edited, a 👍 on the ask, or a batch answer on
 * the Approvals issue whose first line names `ask.names` (the issue a
 * proposal's first line names, as the sweep reads it) that no one but owners
 * edited, each newer than the ask. The owner's approval and batch answer run
 * their own jobs, which take off only a label already on, so an ask whose run
 * labels the issue after that answer reads it here (#355, #357).
 */
async function answeredSince(
  sys: Sys,
  token: string,
  slug: string,
  number: number,
  ask: { id: number; created_at: string; names: number },
  { owners, approvals }: Settings,
): Promise<string | undefined> {
  const owner = (login: string | undefined) => anyLogin(owners, login);
  const events = await every<IssueEvent>(sys, token, `${API}/repos/${slug}/issues/${number}/events`);
  const approved = events.some((one) => one.event === 'labeled' && one.label?.name === 'approved' && owner(one.actor?.login ?? undefined) && (one.created_at ?? '') > ask.created_at);
  if (approved) return 'their approved label';
  const comments = await every<Comment>(sys, token, `${API}/repos/${slug}/issues/${number}/comments?since=${encodeURIComponent(ask.created_at)}`);
  const decisions = comments.filter((comment) => comment.created_at > ask.created_at && owner(comment.user?.login ?? undefined) && opensDecision(comment.body));
  if ((await ownersAlone(sys, token, decisions, owners)).kept.length > 0) return 'a Decision: comment';
  const reactions = await every<Reaction>(sys, token, `${API}/repos/${slug}/issues/comments/${ask.id}/reactions?content=%2B1`);
  if (reactions.some((reaction) => owner(reaction.user?.login ?? undefined) && reaction.created_at > ask.created_at)) return 'a 👍 on the ask';
  // The Approvals issue is read last, only when the issue itself has no answer, and none where GitHub cannot find it.
  if (approvals === undefined) return undefined;
  const listed = await everyFound<Comment>(sys, token, `${API}/repos/${slug}/issues/${approvals}/comments?since=${encodeURIComponent(ask.created_at)}`);
  if (!listed) return undefined;
  const answers = batchAnswers(listed, owners, ask.names, ask.created_at);
  return (await ownersAlone(sys, token, answers, owners)).kept.length > 0 ? `a "Decision: approve" on #${approvals}, the Approvals issue` : undefined;
}

/** Where the owner answers an ask on issue `number`: the comment's own address, `url`, else the issue's. */
function askUrl(slug: string, number: number, url: string | undefined): string {
  return url?.startsWith('https://') ? url : `${GITHUB_WEB}/${slug}/issues/${number}`;
}

/** The asks still waiting on issue `issue`, as the sweep names them, each by the address the owner answers it at. */
function waitingOn(slug: string, issue: number, waiting: Owed[]): string {
  return waiting.map(({ kind, number, ask }) => `${kind === 'Proposal' ? `the proposal for #${number}` : 'the Needs you: ask'}, ${askUrl(slug, issue, ask.html_url)}`).join('; ');
}

/**
 * Judges each open issue labelled `needs-owner` by its asks, and takes the
 * label off where every one is answered. `posted`, the batch answer an
 * event brings, counts though the Approvals issue's list may not show it
 * yet; an issue no agent asked on comes off only when `named`, which that
 * answer names. Then takes it off every closed issue and pull request: a
 * closed one waits on no one, and the owner's 👍 sends no event, so a slice
 * 👍'd and closed by its merge before a sweep would keep it (#639).
 */
async function sweep(sys: Sys, token: string, slug: string, settings: Settings, io: Output, posted?: Comment, named?: readonly number[]): Promise<void> {
  const waiting = await every<{ number: number }>(sys, token, `${API}/repos/${slug}/issues?state=open&labels=${NEEDS_OWNER}`);
  // The Approvals issue's comments, read once a sweep and only when an issue's own comments have not answered it,
  // with the event's answer where they do not list it yet, as where GitHub cannot find the issue.
  let approvals: Promise<Comment[] | undefined> | undefined;
  const batch = (): Promise<Comment[] | undefined> => {
    approvals ??= everyFound<Comment>(sys, token, `${API}/repos/${slug}/issues/${settings.approvals}/comments`).then((listed) => {
      if (!posted || listed?.some((comment) => comment.id === posted.id)) return listed;
      return listed ? [...listed, posted] : [posted];
    });
    return approvals;
  };
  let cleared = 0;
  for (const { number } of waiting) {
    const standing = await answered(sys, token, slug, number, settings, batch);
    if (standing && 'waiting' in standing) {
      io.out(`#${number}: waits on the owner (${waitingOn(slug, number, standing.waiting)})`);
    } else if (standing) {
      await removeLabel(sys, token, slug, number);
      cleared++;
      io.out(`#${number}: the owner answered with ${standing.answer}; ${NEEDS_OWNER} taken off`);
    } else if (named?.includes(number)) {
      await removeLabel(sys, token, slug, number);
      cleared++;
      io.out(`#${number}: no agent asked there, and the owner's batch answer names it; ${NEEDS_OWNER} taken off`);
    } else {
      io.out(`#${number}: no agent asked there; left as it is`);
    }
  }
  const closed = await every<{ number: number }>(sys, token, `${API}/repos/${slug}/issues?state=closed&labels=${NEEDS_OWNER}`);
  for (const { number } of closed) {
    await removeLabel(sys, token, slug, number);
    io.out(`#${number}: closed; ${NEEDS_OWNER} taken off`);
  }
  io.out(`needs-owner: ${waiting.length} labelled ${NEEDS_OWNER}, ${cleared} cleared${closed.length > 0 ? `; ${closed.length} closed, cleared` : ''}`);
}

/**
 * A reopened issue, which the sweep left unlabelled when it closed, waits on
 * the owner again where an ask on it is unanswered: no answer `answered`
 * counts, and no `approved` label of theirs since the latest waiting ask.
 */
async function reopened(sys: Sys, token: string, slug: string, issue: number, settings: Settings, io: Output): Promise<void> {
  const standing = await answered(sys, token, slug, issue, settings, () => everyFound<Comment>(sys, token, `${API}/repos/${slug}/issues/${settings.approvals}/comments`));
  if (!standing || !('waiting' in standing)) {
    io.out(`needs-owner: #${issue} was reopened, and nothing on it waits on the owner; not labelled ${NEEDS_OWNER}`);
    return;
  }
  // An ask or a label whose time cannot be read counts against the approval, so the issue is labelled.
  const latest = Math.max(...standing.waiting.map(({ since }) => instant(since) ?? Infinity));
  const events = await every<IssueEvent>(sys, token, `${API}/repos/${slug}/issues/${issue}/events`);
  if (events.some((one) => one.event === 'labeled' && one.label?.name === 'approved' && anyLogin(settings.owners, one.actor?.login ?? undefined) && (instant(one.created_at ?? undefined) ?? -Infinity) > latest)) {
    io.out(`needs-owner: #${issue} was reopened, and the owner approved it after its asks; not labelled ${NEEDS_OWNER}`);
    return;
  }
  await addLabel(sys, token, slug, issue);
  io.out(`needs-owner: #${issue} was reopened and waits on the owner (${waitingOn(slug, issue, standing.waiting)}); labelled ${NEEDS_OWNER}`);
}

interface Event {
  action?: string;
  comment?: { id?: number; node_id?: string; body?: string | null; user?: { login?: string } | null; created_at?: string; updated_at?: string; html_url?: string };
  issue?: { number: number; labels?: { name: string }[] };
  pull_request?: { number: number; labels?: { name: string }[] };
  label?: { name?: string };
  sender?: { login?: string };
}

/**
 * The needs-owner job, run by the shared workflow. An agent's comment that
 * opens with `Needs you:` or `Proposal:` labels its issue `needs-owner`; the
 * owner's `approved` label or `Decision:` comment takes it off at once; the
 * hourly sweep (and a run by hand) takes it off each open issue whose every
 * ask the owner has answered (see `answered`), and off every closed one, and
 * so does the owner's comment on the Approvals issue whose first line opens
 * `Decision: approve`, at once, counting itself. A reopened issue is labelled
 * again where an ask on it still waits (see `reopened`).
 */
export async function needsOwner(sys: Sys, io: Output): Promise<number> {
  const { GITHUB_EVENT_NAME: name, GITHUB_EVENT_PATH: eventPath, GITHUB_REPOSITORY: slug, GH_TOKEN: token } = sys.env;
  if (!name || !eventPath || !slug || !token) {
    throw new Error('needs-owner runs in GitHub Actions: GITHUB_EVENT_NAME, GITHUB_EVENT_PATH, GITHUB_REPOSITORY and GH_TOKEN must be set');
  }
  const notAdopted = notAdoptedLine(sys, sys.cwd, 'needs-owner');
  if (notAdopted) {
    io.out(notAdopted);
    return 0;
  }
  const settings = loadSettings(sys, sys.cwd);
  if (!isOn(sys, sys.cwd, 'board')) {
    io.out(offLine('needs-owner', 'board'));
    return 0;
  }
  const event = JSON.parse(sys.read(eventPath)) as Event;
  // A review comment's event names its pull request rather than an issue; GitHub labels both alike.
  const target = event.issue ?? (name === 'pull_request_review_comment' ? event.pull_request : undefined);
  const issue = target?.number;
  const labelled = target?.labels?.some((label) => label.name === NEEDS_OWNER) === true;
  if ((name === 'issue_comment' || name === 'pull_request_review_comment') && issue !== undefined) {
    const author = event.comment?.user?.login ?? undefined;
    const body = event.comment?.body;
    const kind = opensAsk(body);
    if (event.action === 'created' && anyLogin(settings.agents, author) && kind) {
      // The owner may answer while this run is still going: read their answer before labelling, and again after,
      // since their approval's run takes off only a label its event shows. An issue's comment alone is read, by its id and time.
      const { id, created_at, html_url } = event.comment ?? {};
      const names = kind === 'Proposal' ? (firstIssue((body as string).split(/\r?\n/, 1)[0] as string) ?? issue) : issue;
      const ask = !labelled && name === 'issue_comment' && id !== undefined && created_at ? { id, created_at, names } : undefined;
      const before = ask ? await answeredSince(sys, token, slug, issue, ask, settings) : undefined;
      if (before) {
        io.out(`needs-owner: #${issue} asks the owner (${kind}:), and the owner already answered with ${before}; not labelled ${NEEDS_OWNER}`);
        return 0;
      }
      if (!labelled) await addLabel(sys, token, slug, issue);
      const after = ask ? await answeredSince(sys, token, slug, issue, ask, settings) : undefined;
      if (after) {
        await removeLabel(sys, token, slug, issue);
        io.out(`needs-owner: #${issue} asks the owner (${kind}:), and the owner answered with ${after} as it was labelled; ${NEEDS_OWNER} taken off`);
        return 0;
      }
      io.out(`needs-owner: #${issue} asks the owner (${kind}:) at ${askUrl(slug, issue, html_url)}; labelled ${NEEDS_OWNER}`);
      return 0;
    }
    // The owner's batch answer on the Approvals issue names a proposal's own issue, such as a dropped State, not
    // always the issue it waits on, so each labelled issue is judged by its asks, this answer counted.
    const batch = issue === settings.approvals && event.action === 'created' && anyLogin(settings.owners, author) && body ? approvedIn(body) : [];
    if (batch.length > 0) {
      const { id, node_id, user, created_at, updated_at } = event.comment ?? {};
      // A batch answer has a body, which names the issues it approves.
      const posted = id !== undefined && created_at ? { id, created_at, body: body as string, user: user ?? null, ...(node_id ? { node_id } : {}), ...(updated_at ? { updated_at } : {}) } : undefined;
      io.out(`needs-owner: the owner approved ${batch.map((number) => `#${number}`).join(', ')} on #${issue}, the Approvals issue; judging each issue labelled ${NEEDS_OWNER}`);
      await sweep(sys, token, slug, settings, io, posted, batch);
      return 0;
    }
    if (event.action === 'created' && anyLogin(settings.owners, author) && opensDecision(body)) {
      if (labelled) await removeLabel(sys, token, slug, issue);
      io.out(`needs-owner: the owner decided on #${issue}${labelled ? `; ${NEEDS_OWNER} taken off` : ''}`);
      return 0;
    }
    io.out(`needs-owner: the comment on #${issue} neither asks the owner nor is their decision; nothing to do`);
    return 0;
  }
  if (name === 'issues' && issue !== undefined) {
    if (event.action === 'labeled' && event.label?.name === 'approved' && anyLogin(settings.owners, event.sender?.login)) {
      if (labelled) await removeLabel(sys, token, slug, issue);
      io.out(`needs-owner: the owner approved #${issue}${labelled ? `; ${NEEDS_OWNER} taken off` : ''}`);
      return 0;
    }
    if (event.action === 'reopened') {
      if (labelled) io.out(`needs-owner: #${issue} was reopened, already labelled ${NEEDS_OWNER}`);
      else await reopened(sys, token, slug, issue, settings, io);
      return 0;
    }
    io.out(`needs-owner: #${issue} was not approved by the owner; nothing to do`);
    return 0;
  }
  if (name === 'schedule' || name === 'workflow_dispatch') {
    await sweep(sys, token, slug, settings, io);
    return 0;
  }
  io.out(`needs-owner: nothing to do on a ${name} event`);
  return 0;
}
