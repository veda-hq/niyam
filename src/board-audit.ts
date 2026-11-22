import { API, SETTINGS_PATH, agentHere, agentsSetUp, hasSettings, loadSettings, readToken, repoAt } from './agent.ts';
import { AUTO_ADD, AUTO_ADD_FILTER, graphql } from './board.ts';
import type { Output, Sys } from './types.ts';

/** What the audit found: the Project, and where it and the repository disagree. */
export interface Audit {
  project: { title: string; url: string };
  /** Open issues with no item on the Project. */
  missing: { number: number; title: string }[];
  /** Open issues whose only item there is archived: kept off the board on purpose, so said, not to fix. */
  archived: { number: number; title: string }[];
  /** Unarchived items whose Status disagrees with their issue: open but Done, or closed but not Done. */
  disagree: { number: number; title: string; state: 'open' | 'closed'; status: string | undefined }[];
  /** The auto-add workflows: on, off, or missing (not set up). */
  workflows: { name: string; on: boolean | undefined }[];
}

type Page<T> = { nodes: T[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };

/** board-audit's options: the repository, and the Project's title. */
export function auditArgs(args: readonly string[]): { slug?: string; project?: string } {
  const parsed: { slug?: string; project?: string } = {};
  for (let at = 0; at < args.length; at++) {
    const arg = args[at] as string;
    if (arg === '--project') {
      const value = args[++at];
      if (!value || value.startsWith('-')) throw new Error("board-audit --project needs the Project's title");
      parsed.project = value;
    } else if (parsed.slug === undefined && /^[\w.-]+\/[\w.-]+$/.test(arg)) {
      parsed.slug = arg;
    } else {
      throw new Error(`board-audit takes [owner/repo] [--project <title>], not "${arg}"`);
    }
  }
  return parsed;
}

/** The `project` the repository's settings name, from the clone here when it is that repository, else from GitHub; undefined when they name none. */
async function settingsTitle(sys: Sys, token: string, slug: string): Promise<string | undefined> {
  let text: string | undefined;
  try {
    const here = repoAt(sys);
    const path = `${here.root}/${SETTINGS_PATH}`;
    if (here.slug.toLowerCase() === slug.toLowerCase() && sys.exists(path)) text = sys.read(path);
  } catch {
    // fail-open: not in a clone, so the settings come from GitHub, read next.
  }
  if (text === undefined) {
    const { status, json } = await sys.http(`${API}/repos/${slug}/contents/${SETTINGS_PATH}`, { token });
    const content = (json as { content?: unknown } | null)?.content;
    if (status === 404) return undefined;
    if (status !== 200 || typeof content !== 'string') throw new Error(`cannot read ${slug}'s ${SETTINGS_PATH} (HTTP ${status})`);
    text = Buffer.from(content, 'base64').toString('utf8');
  }
  const raw: unknown = JSON.parse(text);
  const project = raw !== null && typeof raw === 'object' && 'project' in raw ? raw.project : undefined;
  return typeof project === 'string' && project.trim() ? project.trim() : undefined;
}

/**
 * Compares `slug`'s issues with its open Project titled `title`, reading only:
 * the open issues not on it, the items whose Status disagrees with their
 * issue, and whether the auto-add workflows are on. GitHub's API shows a
 * workflow's name and whether it is on, not the repository or filter it adds
 * from.
 */
export async function auditBoard(sys: Sys, token: string, slug: string, title: string): Promise<Audit> {
  const [owner, name] = slug.split('/') as [string, string];
  type Project = { id: string; title: string; url: string; closed: boolean };
  let project: Project | undefined;
  for (let after: string | null = null; ; ) {
    const read = (await graphql(
      sys,
      token,
      'query BoardAuditProject($login: String!, $title: String!, $after: String) { repositoryOwner(login: $login) { ... on ProjectV2Owner { projectsV2(first: 100, query: $title, after: $after) { nodes { id title url closed } pageInfo { hasNextPage endCursor } } } } }',
      { login: owner, title, after },
    )) as { repositoryOwner: { projectsV2?: Page<Project> } | null };
    const projects = read.repositoryOwner?.projectsV2;
    if (!projects) throw new Error(`GitHub shows no owner ${owner} with Projects`);
    project = projects.nodes.find((node) => node.title === title && !node.closed);
    if (project || !projects.pageInfo.hasNextPage) break;
    after = projects.pageInfo.endCursor;
  }
  if (!project) throw new Error(`${owner} has no open Project titled "${title}"; name it with --project`);

  type Issue = { number: number; title: string; projectItems: { nodes: { isArchived: boolean; project: { id: string } }[] } };
  const missing: Audit['missing'] = [];
  const archived: Audit['archived'] = [];
  for (let after: string | null = null; ; ) {
    const read = (await graphql(
      sys,
      token,
      'query BoardAuditIssues($owner: String!, $name: String!, $after: String) { repository(owner: $owner, name: $name) { issues(states: OPEN, first: 100, after: $after) { nodes { number title projectItems(first: 50, includeArchived: true) { nodes { isArchived project { id } } } } pageInfo { hasNextPage endCursor } } } }',
      { owner, name, after },
    )) as { repository: { issues: Page<Issue> } | null };
    if (!read.repository) throw new Error(`GitHub shows no repository ${slug}`);
    for (const issue of read.repository.issues.nodes) {
      const items = issue.projectItems.nodes.filter((item) => item.project.id === project.id);
      if (items.some((item) => !item.isArchived)) continue;
      (items.length > 0 ? archived : missing).push({ number: issue.number, title: issue.title });
    }
    if (!read.repository.issues.pageInfo.hasNextPage) break;
    after = read.repository.issues.pageInfo.endCursor;
  }

  type Item = {
    isArchived: boolean;
    status: { name?: string } | null;
    content: { __typename: string; number?: number; title?: string; state?: string; repository?: { nameWithOwner: string } } | null;
  };
  const disagree: Audit['disagree'] = [];
  let workflows: { name: string; enabled: boolean }[] = [];
  for (let after: string | null = null; ; ) {
    const read = (await graphql(
      sys,
      token,
      'query BoardAuditItems($id: ID!, $after: String) { node(id: $id) { ... on ProjectV2 { workflows(first: 50) { nodes { name enabled } } items(first: 100, after: $after) { nodes { isArchived status: fieldValueByName(name: "Status") { ... on ProjectV2ItemFieldSingleSelectValue { name } } content { __typename ... on Issue { number title state repository { nameWithOwner } } } } pageInfo { hasNextPage endCursor } } } } }',
      { id: project.id, after },
    )) as { node: { workflows: { nodes: { name: string; enabled: boolean }[] }; items: Page<Item> } };
    workflows = read.node.workflows.nodes;
    for (const item of read.node.items.nodes) {
      const issue = item.content;
      if (item.isArchived || issue?.__typename !== 'Issue' || issue.number === undefined || issue.repository?.nameWithOwner.toLowerCase() !== slug.toLowerCase()) continue;
      const status = item.status?.name;
      const done = status?.toLowerCase() === 'done';
      const open = issue.state === 'OPEN';
      if (open === done) disagree.push({ number: issue.number, title: issue.title ?? '', state: open ? 'open' : 'closed', status });
    }
    if (!read.node.items.pageInfo.hasNextPage) break;
    after = read.node.items.pageInfo.endCursor;
  }
  return {
    project: { title: project.title, url: project.url },
    missing: missing.sort((a, b) => a.number - b.number),
    archived: archived.sort((a, b) => a.number - b.number),
    disagree: disagree.sort((a, b) => a.number - b.number),
    workflows: AUTO_ADD.map((name) => ({ name, on: workflows.find((workflow) => workflow.name === name)?.enabled })),
  };
}

/** The audit as lines, ✓ or ✗ each, with what to do; and how many things are wrong. */
export function auditLines(audit: Audit, slug: string): { lines: string[]; wrong: number } {
  const { url } = audit.project;
  const lines = [`board-audit: ${slug} on "${audit.project.title}" (${url})`];
  let wrong = 0;
  for (const { name, on } of audit.workflows) {
    if (on) {
      lines.push(`✓ workflow ${name} is on`);
      continue;
    }
    wrong++;
    const what = name === 'Auto-add to project' ? `, for the repository ${slug} with the filter ${AUTO_ADD_FILTER}` : '';
    lines.push(on === false ? `✗ workflow ${name} is off: turn it on at ${url}/workflows${what}` : `✗ workflow ${name} is missing: add it at ${url}/workflows${what} (GitHub's API cannot)`);
  }
  lines.push(`  GitHub's API shows whether a workflow is on, not the repository or filter it adds from; Auto-add adds an issue only as it opens or changes, never one already open`);
  if (audit.missing.length === 0) lines.push('✓ every open issue is on the board');
  else {
    wrong += audit.missing.length;
    const one = audit.missing.length === 1;
    lines.push(`✗ ${audit.missing.length} open issue${one ? ' is' : 's are'} not on the board: add ${one ? 'it' : 'them'} at ${url} (+ Add item, then #N), or gh project item-add`);
    for (const issue of audit.missing) lines.push(`  #${issue.number} ${issue.title}`);
  }
  if (audit.archived.length > 0) {
    // Archived by someone, or by the auto-archive workflow before a reopen: the audit cannot tell, so it says them without counting them.
    const plural = audit.archived.length === 1 ? ' is' : 's are';
    lines.push(`- ${audit.archived.length} open issue${plural} archived on the board, so hidden there; restore any that belong on it: ${audit.archived.map((issue) => `#${issue.number}`).join(', ')}`);
  }
  if (audit.disagree.length === 0) lines.push("✓ every item's Status agrees with its issue");
  else {
    wrong += audit.disagree.length;
    lines.push(`✗ ${audit.disagree.length} item${audit.disagree.length === 1 ? "'s Status disagrees" : "s' Status disagree"} with the issue: set it at ${url}`);
    for (const issue of audit.disagree) lines.push(`  #${issue.number} is ${issue.state}, Status ${issue.status ?? 'empty'}: ${issue.title}`);
  }
  lines.push(wrong > 0 ? `board-audit: ${wrong} to fix` : audit.archived.length > 0 ? 'board-audit: nothing to fix but the archived issues above' : 'board-audit: the board matches the repository');
  return { lines, wrong };
}

/**
 * The token the audit reads with: `GH_TOKEN`, as an agent session has it,
 * else the agent's own, which `machine` keeps in this Mac's keychain. The
 * audit only reads, and the agent's token can read the board, so the owner
 * runs it in a terminal with no `gh` signed in. It never asks for the
 * owner's own token, which `machine` signs out of `gh` (veda-hq/niyam#548).
 */
export function auditToken(sys: Sys): string {
  if (sys.env.GH_TOKEN) return sys.env.GH_TOKEN;
  const agent = auditAgent(sys);
  if ('problem' in agent) throw new Error(`board-audit needs GH_TOKEN, as an agent session has it, or the agent's token from this Mac's keychain: ${agent.problem}`);
  const token = readToken(sys, agent.agent);
  if (!token) throw new Error(`board-audit needs GH_TOKEN, as an agent session has it, or ${agent.agent}'s token from this Mac's keychain, which holds none; run niyam machine ${agent.agent}`);
  return token;
}

/**
 * The agent whose token the audit reads with outside an agent session: in a
 * clone, the one its settings name that sessions here work as (`agentHere`);
 * elsewhere, the one `machine` set up on this Mac. Never a guess.
 */
function auditAgent(sys: Sys): { agent: string } | { problem: string } {
  const top = sys.exec('git', ['rev-parse', '--show-toplevel'], { cwd: sys.cwd });
  const root = top.stdout.trim();
  if (top.code === 0 && hasSettings(sys, root)) {
    const here = agentHere(sys, loadSettings(sys, root).agents);
    return 'problem' in here ? { problem: `${here.problem}; or run it in an agent session` } : here;
  }
  const setUp = agentsSetUp(sys);
  if (setUp.length === 1) return { agent: setUp[0] as string };
  return {
    problem: setUp.length === 0
      ? 'niyam machine has set up no agent on this Mac; run niyam machine <agent>, or run it in an agent session'
      : `niyam machine has set up ${setUp.join(' and ')} on this Mac, and no ${SETTINGS_PATH} here names one; run it in a clone of the repository, or in an agent session`,
  };
}

/**
 * `niyam board-audit [owner/repo] [--project <title>]`: lists where the
 * repository and its work board disagree, changing nothing. The repository
 * is the clone's here when none is named; the Project is the one the
 * settings' `project` names, or `<repo> work`. Exit 0 when they agree, 3
 * when something is to fix, 1 when it could not run. A Claude cloud
 * session's GitHub proxy refuses GraphQL and every path outside
 * `repos/{owner}/{repo}/…` (veda-hq/niyam#399), so the audit cannot run there.
 */
export async function boardAudit(sys: Sys, io: Output, args: readonly string[]): Promise<number> {
  if (sys.env.CLAUDE_CODE_REMOTE === 'true') {
    io.err("board-audit: cannot run in a Claude cloud session: its GitHub proxy refuses GraphQL and an organisation's Projects (veda-hq/niyam#399), so nothing was checked; run it on a Mac");
    return 1;
  }
  const parsed = auditArgs(args);
  const token = auditToken(sys);
  const slug = parsed.slug ?? repoAt(sys).slug;
  const title = parsed.project ?? (await settingsTitle(sys, token, slug)) ?? `${slug.split('/')[1] as string} work`;
  const { lines, wrong } = auditLines(await auditBoard(sys, token, slug, title), slug);
  for (const line of lines) io.out(line);
  return wrong === 0 ? 0 : 3;
}
