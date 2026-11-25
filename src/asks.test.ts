import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { readFileSync } from 'node:fs';

import { ASK_LIMIT, HOURLY, PAGE_LINK, askProblem, askRefusal, askedBy, commentBodies, commentProblem, needsOwner, opensAsk, opensDecision, ownersAround } from './asks.ts';
import { AGENT, FakeSys, ROOT, capture } from './fake.test.ts';
import { UNKNOWN } from './shell.ts';

const OWNER = 'example-owner';
const PAGE = 'https://claude.ai/artifact/WrvVo6T7V8fe9pQvYEyvJW';
const known = (text: string) => ({ text, known: true, opensUnknown: false });

describe('the ask rule', () => {
  it('reads how a comment opens', () => {
    assert.equal(opensAsk('Needs you: approve?'), 'Needs you');
    assert.equal(opensAsk('  **Proposal:** add P-9'), 'Proposal');
    assert.equal(opensAsk('> ## Needs you: x'), 'Needs you');
    assert.equal(opensAsk('Note: Needs you: x'), undefined);
    assert.equal(opensAsk('needs you: x'), undefined);
    assert.equal(opensAsk('no colon here'), undefined);
    assert.equal(opensDecision('Decision: go'), true);
    assert.equal(opensDecision('_Decision:_ go'), true);
    assert.equal(opensDecision('Proposal: go'), false);
    // Only from the very start: a list number is no opening mark.
    assert.equal(opensAsk('1. Needs you: x'), undefined);
    assert.equal(opensDecision('no colon here'), false);
    // A comment with no body opens with nothing.
    assert.equal(opensAsk(null), undefined);
    assert.equal(opensAsk(undefined), undefined);
    assert.equal(opensDecision(null), false);
  });

  it('reads a published page link whole', () => {
    assert.equal(PAGE_LINK.exec(`see ${PAGE}.`)?.[0], PAGE);
    assert.equal(PAGE_LINK.exec('see https://claude.ai/code/artifact/abc-1 now')?.[0], 'https://claude.ai/code/artifact/abc-1');
  });

  it('counts a comment that names the owner as asking them, with or without an @', () => {
    assert.equal(askedBy('cc @Example-Owner, see above', [OWNER]), 'it names the owner, example-owner');
    assert.equal(askedBy('example-owner said so', [OWNER]), 'it names the owner, example-owner');
    assert.equal(askedBy('example-owners and @example-owner-2 differ', [OWNER]), undefined);
    assert.equal(askedBy('Proposal: x', []), 'it opens with "Proposal:"');
  });

  it('lets through a short ask that links a page, and any comment that does not ask', () => {
    assert.equal(askProblem(known(`Needs you: approve the plan?\nPage: ${PAGE}\nAnswer: label approved.`), [OWNER]), undefined);
    assert.equal(askProblem(known('Proposal: see https://claude.ai/code/artifact/abc-1'), [OWNER]), undefined);
    assert.equal(askProblem(known('Evidence: the run passed.'.repeat(40)), [OWNER]), undefined);
    assert.equal(askProblem({ text: `Evidence for ${UNKNOWN}`, known: false, opensUnknown: false }, [OWNER]), undefined);
  });

  it('refuses an ask with no page link, or over the limit, saying which', () => {
    assert.equal(askProblem(known('Needs you: approve?'), [OWNER]), 'this comment asks the owner (it opens with "Needs you:"), and it links no published page (https://claude.ai/artifact/… or https://claude.ai/code/artifact/…)');
    const long = `Proposal: ${PAGE} ${'x'.repeat(ASK_LIMIT)}`;
    assert.equal(askProblem(known(long), [OWNER]), `this comment asks the owner (it opens with "Proposal:"), and it runs ${[...long].length} characters, over ${ASK_LIMIT}`);
    assert.match(askProblem(known(`@example-owner ${'y'.repeat(ASK_LIMIT)}`), [OWNER]) ?? '', /names the owner, example-owner\), and it links no published page .* and runs 515 characters, over 500$/);
    assert.equal(askProblem(known(`Needs you: ${PAGE} ${'é'.repeat(ASK_LIMIT - 11 - PAGE.length - 1)}`), [OWNER]), undefined, 'characters, not bytes');
    const full = `Needs you: ${PAGE} ${'x'.repeat(ASK_LIMIT - 11 - PAGE.length - 1)}`;
    assert.equal(askProblem(known(`\n${full}\n\n`), [OWNER]), undefined, 'the limit counts the text, not the blank lines around it');
  });

  it('reads a part only the shell knows as a space between words', () => {
    // `example-owner$S` names the owner whatever $S holds, unless it holds more of the name.
    assert.match(askProblem({ text: `cc example-owner${UNKNOWN}s`, known: false, opensUnknown: false }, [OWNER]) ?? '', /names the owner, example-owner\), and the guard cannot measure it/);
  });

  it('refuses a body it cannot measure only where it asks the owner or hides its opening', () => {
    assert.match(askProblem({ text: `Needs you: ${UNKNOWN}`, known: false, opensUnknown: false }, [OWNER]) ?? '', /asks the owner \(it opens with "Needs you:"\), and the guard cannot measure it/);
    assert.match(askProblem({ text: `${UNKNOWN} rest`, known: false, opensUnknown: true }, [OWNER]) ?? '', /cannot see how this comment opens/);
  });

  it('says the rule and the fix when it refuses', () => {
    const line = askRefusal('this comment asks the owner (x), and it links no published page');
    assert.equal(
      line,
      'niyam: refused, because this comment asks the owner (x), and it links no published page. ' +
        'The rule: anything the owner must read, approve or choose arrives as a published page; the comment carries only the question, the page link and how to answer, in 500 characters or fewer. ' +
        "Fix: publish the page first, then post a comment of at most 500 characters that links it, written out in the command (quoted text, a quoted heredoc <<'EOF', or --body-file <file>) so the guard can read it.",
    );
  });
});

const FILES = new Map([
  ['/repo/ask.md', 'Needs you: long\n'],
  ['/repo/input.json', JSON.stringify({ body: 'Proposal: from input' })],
  ['/repo/vars.json', JSON.stringify({ query: 'mutation', variables: { body: 'Needs you: in variables' } })],
  ['/repo/none.json', JSON.stringify({ title: 'x' })],
  ['/repo/bad.json', '{'],
  ['/repo/null.json', 'null'],
]);
const read = (path: string): string | undefined => FILES.get(path.startsWith('/') ? path : `/repo/${path}`);
const texts = (line: string): string[] => commentBodies(line, read).map((body) => (body.known ? body.text : `?${body.text.replaceAll(UNKNOWN, '?')}`));

describe('commentBodies', () => {
  it('reads the body of gh issue comment and gh pr comment, inline or from a file', () => {
    assert.deepEqual(texts('gh issue comment 12 --body "Needs you: a"'), ['Needs you: a']);
    assert.deepEqual(texts("gh pr comment 3 -b 'b' --repo x/y"), ['b']);
    assert.deepEqual(texts('gh issue comment 1 --body=c'), ['c']);
    assert.deepEqual(texts('gh issue comment 1 -bd'), ['d']);
    assert.deepEqual(texts('gh issue comment 1 --body-file ask.md'), ['Needs you: long\n']);
    assert.deepEqual(texts('gh issue comment 1 -F /repo/ask.md'), ['Needs you: long\n']);
    assert.deepEqual(texts('gh issue comment 1 --body-file=missing.md'), ['?']);
    assert.deepEqual(texts('gh issue comment 1 --body-file "$F"'), ['?']);
    assert.deepEqual(texts("gh issue comment 1 --body-file - <<'EOF'\nProposal: x\nEOF"), ['Proposal: x\n']);
    assert.deepEqual(texts('gh issue comment 1 --body-file -'), ['?']);
    assert.deepEqual(texts('gh pr comment 1 --body'), ['?']);
    assert.deepEqual(texts("cd /repo && /opt/bin/gh pr comment 9 --body \"$(cat <<'EOF'\nNeeds you: heredoc\nEOF\n)\""), ['Needs you: heredoc']);
    assert.deepEqual(texts('gh pr comment -R o/r 9 --body "from -R"'), ['from -R']);
    assert.deepEqual(texts('gh issue comment 1 --body="$X rest"'), ['?? rest'], 'a joined value that opens with a variable');
    assert.equal(commentBodies('gh issue comment 1 -b"$X"', read)[0]?.opensUnknown, true);
    // With no body in the command, gh takes it from an editor, a prompt or the browser.
    assert.deepEqual(texts('gh issue comment 1 --web; gh pr comment 2 --editor; gh issue comment 3 --edit-last'), ['?', '?', '?']);
  });

  it('leaves alone gh commands that post no comment', () => {
    assert.deepEqual(texts('gh issue comment 1 --delete-last --yes'), []);
    assert.deepEqual(texts('gh issue view 1 --comments; gh pr create --body "Needs you: x"; git push'), []);
    assert.deepEqual(texts('gh api repos/o/r/issues/1/comments --paginate --jq .[].body'), []);
    assert.deepEqual(texts('gh api -X POST repos/o/r/issues/1/labels -f labels[]=x'), []);
    assert.deepEqual(texts('gh api graphql -f query="query { viewer { login } }"'), []);
    assert.deepEqual(texts('gh'), []);
    assert.deepEqual(texts('gh issue'), []);
  });

  it('reads the body gh api posts to a comments endpoint', () => {
    assert.deepEqual(texts('gh api repos/o/r/issues/1/comments -f body="Needs you: a"'), ['Needs you: a']);
    assert.deepEqual(texts('gh api -X PATCH repos/o/r/issues/comments/55 --raw-field body=b'), ['b']);
    assert.deepEqual(texts('gh api repos/o/r/pulls/2/comments/7/replies -F body=@ask.md'), ['Needs you: long\n']);
    assert.deepEqual(texts('gh api --method POST /repos/o/r/issues/1/comments --field=body=c'), ['c']);
    assert.deepEqual(texts('gh api repos/o/r/issues/1/comments -Fbody=d -H "Accept: x"'), ['d']);
    assert.deepEqual(texts('gh api repos/o/r/issues/1/comments -F body=@-  <<< "Proposal: e"'), ['Proposal: e\n']);
    assert.deepEqual(texts('gh api repos/o/r/issues/1/comments -f body="$B"'), ['??']);
    assert.deepEqual(texts('gh api repos/o/r/issues/1/comments -f flag -f body=x'), ['x']);
    assert.deepEqual(texts('gh api repos/o/r/issues/1/comments --input input.json'), ['Proposal: from input']);
    assert.deepEqual(texts('gh api repos/o/r/issues/1/comments --input none.json'), []);
    assert.deepEqual(texts('gh api repos/o/r/issues/1/comments --input bad.json'), ['?']);
    assert.deepEqual(texts('gh api repos/o/r/issues/1/comments --input "$I"'), ['?']);
  });

  it('reads a GraphQL comment mutation: its body variable, its input, or else its query', () => {
    assert.deepEqual(texts('gh api graphql -f query="mutation(\\$b: String!) { addComment(input: {subjectId: \\"I\\", body: \\$b}) { clientMutationId } }" -f b="Needs you: v"'), ['Needs you: v']);
    assert.deepEqual(texts('gh api graphql -F query=@q.graphql -f body="Proposal: w"'), []);
    assert.deepEqual(texts('gh api graphql -f query="mutation(\\$body: String!) { addComment(input: {body: \\$body}) { x } }" -f body="Proposal: w"'), ['Proposal: w']);
    assert.deepEqual(texts('gh api graphql -f query=\'mutation { addComment(input: {subjectId: "I", body: "Proposal: inline\\nline two"}) { clientMutationId } }\''), ['Proposal: inline\nline two']);
    assert.deepEqual(texts('gh api graphql -f query=\'mutation { addComment(input: {subjectId: "I", body: "bad \\q"}) { x } }\''), ['?']);
    assert.deepEqual(texts('gh api graphql -f query="mutation { addComment(input: {body: \\"$B\\"}) { x } }"'), ['?']);
    assert.deepEqual(texts('gh api graphql -f query=\'mutation { addComment(input: {subjectId: "I"}) { x } }\''), ['mutation { addComment(input: {subjectId: "I"}) { x } }']);
    assert.deepEqual(texts('gh api graphql -f query=\'mutation { updateIssueComment(input: {}) { x } }\' --input vars.json'), ['Needs you: in variables']);
    // `body :` and `body:"…"`, spaced or not, and a `body` variable the query does not name.
    assert.deepEqual(texts('gh api graphql -f query=\'mutation { addComment(input: {body :"Proposal: spaced"}) { x } }\''), ['Proposal: spaced']);
    assert.deepEqual(texts('gh api graphql -f query="mutation(\\$b: String!) { addComment(input: {body :\\$b}) { x } }" -f b="Needs you: tight"'), ['Needs you: tight']);
    assert.deepEqual(texts('gh api graphql -f query=\'mutation { addComment(input: {subjectId: "I"}) { x } }\' -f body="Proposal: z"'), ['Proposal: z']);
    // A mutation with no query field, or no endpoint at all, posts nothing the guard reads.
    assert.deepEqual(texts('gh api graphql -f body="Proposal: w"'), []);
    assert.deepEqual(texts('gh api -f body="Proposal: w"'), []);
  });

  it('says which bodies it can read whole, and which open with a part only the shell knows', () => {
    const full = (line: string, readFile = read) => commentBodies(line, readFile).map((body) => ({ ...body, text: body.text.replaceAll(UNKNOWN, '?') }));
    const unreadable = { text: '', known: false, opensUnknown: true };
    assert.deepEqual(full('gh pr comment 1 --body'), [unreadable]);
    assert.deepEqual(full('gh issue comment 1 --body="x $X"'), [{ text: 'x ?', known: false, opensUnknown: false }]);
    assert.deepEqual(full('gh api repos/o/r/issues/1/comments -f body="$B"'), [{ text: '?', known: false, opensUnknown: true }]);
    assert.deepEqual(full('gh api repos/o/r/issues/1/comments -f body="x$B"'), [{ text: 'x?', known: false, opensUnknown: false }]);
    assert.deepEqual(full('gh api repos/o/r/issues/1/comments --input input.json'), [{ text: 'Proposal: from input', known: true, opensUnknown: false }]);
    assert.deepEqual(full('gh api graphql -f query=\'mutation { addComment(input: {body: "Proposal: x"}) { x } }\''), [{ text: 'Proposal: x', known: true, opensUnknown: false }]);
    // A query with a part only the shell knows outside its body: the body is spelled out, the query is not.
    assert.deepEqual(full('gh api graphql -f query="mutation { addComment(input: {subjectId: \\"$S\\", body: \\"Proposal: x\\"}) { x } }"'), [{ text: 'Proposal: x', known: false, opensUnknown: false }]);
    // A body file whose name only the shell knows is not read, whatever is there.
    assert.deepEqual(full('gh issue comment 1 --body-file "$F"', () => 'Needs you: read anyway'), [unreadable]);
    // Standard input only the shell knows is passed on as it is.
    assert.deepEqual(full('gh api repos/o/r/issues/1/comments --input - <<< "$X"'), [{ text: '?\n', known: false, opensUnknown: true }]);
  });

  it('skips the value of each gh flag that takes one, wherever it stands', () => {
    const valued = ['-R', '--repo', '-b', '--body', '-F', '--body-file', '-f', '--raw-field', '--field', '--input', '-X', '--method', '-H', '--header', '-q', '--jq', '-t', '--template', '--hostname', '--cache', '-p', '--preview'];
    for (const flag of valued) assert.deepEqual(texts(`gh ${flag} v issue comment 1 --body x`), ['x'], flag);
    assert.deepEqual(texts('gh --verbose issue comment 1 --body x'), ['x'], 'a flag that takes no value');
    assert.deepEqual(texts('gh -R o/r api repos/o/r/issues/1/comments -f body=x'), ['x']);
  });

  it('reads each flag as gh does: a value that looks like a flag, an empty joined one, the last of several', () => {
    assert.deepEqual(texts('gh issue comment 1 --body -F ask.md'), ['-F']);
    assert.deepEqual(texts('gh issue comment 1 --body='), ['?']);
    assert.deepEqual(texts('gh issue comment 1 --body-file'), ['?']);
    assert.deepEqual(texts('gh issue comment 1 -b one --body-file ask.md'), ['Needs you: long\n']);
    // A field is `key=value`, its value past the first `=`; one with no `=` is no field, and only -F reads @file.
    assert.deepEqual(texts('gh api repos/o/r/issues/1/comments -f bodyx'), []);
    assert.deepEqual(texts('gh api repos/o/r/issues/1/comments -f body'), []);
    assert.deepEqual(texts('gh api repos/o/r/issues/1/comments -f body=a=b'), ['a=b']);
    assert.deepEqual(texts('gh api repos/o/r/issues/1/comments -f body=@ask.md'), ['@ask.md']);
    // The endpoint is the first word that is not a flag.
    assert.deepEqual(texts('gh api repos/o/r/issues/1/comments extra -f body=x'), ['x']);
    assert.deepEqual(texts('gh api repos/o/r/issues/1/comments --input null.json'), []);
  });

  it('reads gh alone, wherever it is in the command, and only its comment commands', () => {
    assert.deepEqual(texts('command gh issue comment 1 --body x'), ['x']);
    for (const line of ['ghost issue comment 1 --body x', 'sigh issue comment 1 --body x', 'pr comment 1 --body x', 'gh gist comment 1 --body x', 'gh repos/o/r/issues/1/comments -f body=x']) {
      assert.deepEqual(texts(line), [], line);
    }
  });
});

describe('ownersAround', () => {
  it('reads the owners from the nearest settings up from the folder, none outside a client', () => {
    const sys = new FakeSys();
    assert.deepEqual(ownersAround(sys, `${ROOT}/src/deep`), [OWNER]);
    assert.deepEqual(ownersAround(sys, '/elsewhere/x'), []);
    assert.deepEqual(ownersAround(sys, 'relative'), []);
    // The nearest settings decide, even ones that cannot be read.
    sys.files.set(`${ROOT}/sub/.github/niyam.json`, '{"owner": 5}');
    assert.deepEqual(ownersAround(sys, `${ROOT}/sub/deep`), []);
    sys.files.set(`${ROOT}/.github/niyam.json`, '{"owner": 5}');
    assert.deepEqual(ownersAround(sys, ROOT), []);
  });
});

describe('commentProblem', () => {
  it('reads body files where the command runs, and from the home folder', () => {
    const sys = new FakeSys();
    sys.files.set(`${ROOT}/sub/ask.md`, 'Needs you: no page');
    sys.files.set(`${sys.home}/ask.md`, `Needs you: ${PAGE}`);
    assert.match(commentProblem(sys, 'gh issue comment 1 --body-file ask.md', `${ROOT}/sub`) ?? '', /links no published page/);
    assert.equal(commentProblem(sys, 'gh issue comment 1 --body-file ~/ask.md', ROOT), undefined);
    assert.equal(commentProblem(sys, `gh issue comment 1 --body-file ${sys.home}/ask.md`, ROOT), undefined);
    assert.equal(commentProblem(sys, 'gh pr list', ROOT), undefined);
    assert.match(commentProblem(sys, 'gh pr comment 1 -b "fine"; gh pr comment 2 -b "cc example-owner"', ROOT) ?? '', /names the owner/);
  });
});

const EVENT = '/run/event.json';
const SLUG = 'example-org/example-app';
const API = 'https://api.github.com';
const LABELS = `${API}/repos/${SLUG}/issues/7/labels`;

function job(name: string, event: unknown, settings?: unknown): FakeSys {
  const sys = new FakeSys();
  sys.env = { GITHUB_EVENT_NAME: name, GITHUB_EVENT_PATH: EVENT, GITHUB_REPOSITORY: SLUG, GH_TOKEN: 'ghs_run' };
  sys.files.set(EVENT, JSON.stringify(event));
  if (settings) sys.files.set(`${ROOT}/.github/niyam.json`, JSON.stringify(settings));
  sys.route('POST', LABELS, { status: 200, json: [] });
  sys.route('DELETE', `${LABELS}/needs-owner`, { status: 200, json: [] });
  return sys;
}

async function runJob(sys: FakeSys): Promise<{ code: number; out: string[] }> {
  const { io, out, err } = capture();
  const code = await needsOwner(sys, io);
  assert.deepEqual(err, []);
  return { code, out };
}

const calls = (sys: FakeSys) => sys.requests.filter((request) => request.method !== 'GET').map((request) => `${request.method} ${request.url.replace(API, '')}`);
const comment = (login: string, body: string, labels: string[] = []) => ({ action: 'created', comment: { body, user: { login } }, issue: { number: 7, labels: labels.map((name) => ({ name })) } });

describe('needsOwner', () => {
  it('labels an issue where the agent asks the owner, once', async () => {
    const sys = job('issue_comment', comment(AGENT, `Needs you: approve? ${PAGE}`));
    assert.deepEqual(await runJob(sys), { code: 0, out: ['needs-owner: #7 asks the owner (Needs you:) at https://github.com/example-org/example-app/issues/7; labelled needs-owner'] });
    assert.deepEqual(calls(sys), [`POST /repos/${SLUG}/issues/7/labels`]);
    assert.deepEqual(sys.requests[0]?.body, { labels: ['needs-owner'] });
    // The ask's own address, where GitHub gives it, so whoever reads the line passes on the very comment (#557).
    const own = comment(AGENT, `Needs you: approve? ${PAGE}`);
    const linked = job('issue_comment', { ...own, comment: { ...own.comment, html_url: `https://github.com/${SLUG}/issues/7#issuecomment-41` } });
    assert.deepEqual((await runJob(linked)).out, [`needs-owner: #7 asks the owner (Needs you:) at https://github.com/${SLUG}/issues/7#issuecomment-41; labelled needs-owner`]);
    const again = job('issue_comment', comment(AGENT, 'Proposal: x', ['needs-owner']));
    await runJob(again);
    assert.deepEqual(calls(again), []);
  });

  describe("an ask whose run ends after the owner answered it (#355, seen on #303)", () => {
    const ASKED = '2026-11-15T09:59:27Z';
    const events = `${API}/repos/${SLUG}/issues/7/events?per_page=100&page=1`;
    const since = `${API}/repos/${SLUG}/issues/7/comments?since=${encodeURIComponent(ASKED)}&per_page=100&page=1`;
    const thumbs = `${API}/repos/${SLUG}/issues/comments/70/reactions?content=%2B1&per_page=100&page=1`;
    const asked = () => ({ action: 'created', comment: { id: 70, body: `Needs you: approve? ${PAGE}`, user: { login: AGENT }, created_at: ASKED }, issue: { number: 7, labels: [] } });
    const label = (event: string, login: string, created_at: string, name = 'approved') => ({ event, created_at, actor: { login }, label: { name } });
    // #303's own events: the owner took approved off and put it back after the ask.
    const relabelled = [label('labeled', OWNER, '2026-11-14T08:00:00Z'), label('unlabeled', OWNER, '2026-11-15T09:59:36Z'), label('labeled', OWNER, '2026-11-15T09:59:38Z')];
    const quiet = (sys: FakeSys) => {
      sys.route('GET', since, { status: 200, json: [] });
      sys.route('GET', thumbs, { status: 200, json: [] });
    };

    it("does not label the issue when the owner put approved on it after the ask, as on #303", async () => {
      const sys = job('issue_comment', asked());
      sys.route('GET', events, { status: 200, json: relabelled });
      assert.deepEqual((await runJob(sys)).out, ['needs-owner: #7 asks the owner (Needs you:), and the owner already answered with their approved label; not labelled needs-owner']);
      assert.deepEqual(calls(sys), []);
    });

    it('does not label it when the owner decided or 👍d the ask after it; a Decision: someone else edited, or an older answer, counts for nothing', async () => {
      const decided = job('issue_comment', asked());
      decided.route('GET', events, { status: 200, json: [] });
      decided.route('GET', since, { status: 200, json: [{ id: 71, body: 'Decision: yes', user: { login: OWNER }, created_at: '2026-11-15T09:59:40Z' }] });
      assert.deepEqual((await runJob(decided)).out, ['needs-owner: #7 asks the owner (Needs you:), and the owner already answered with a Decision: comment; not labelled needs-owner']);
      assert.deepEqual(calls(decided), []);

      const liked = job('issue_comment', asked());
      liked.route('GET', events, { status: 200, json: [label('labeled', OWNER, '2026-11-15T09:59:40Z', 'bug'), label('labeled', AGENT, '2026-11-15T09:59:40Z')] });
      liked.route('GET', since, { status: 200, json: [{ id: 72, body: 'Decision: no', user: { login: AGENT }, created_at: '2026-11-15T09:59:40Z' }] });
      liked.route('GET', thumbs, { status: 200, json: [{ user: { login: OWNER }, created_at: '2026-11-15T09:59:41Z' }] });
      assert.deepEqual((await runJob(liked)).out, ['needs-owner: #7 asks the owner (Needs you:), and the owner already answered with a 👍 on the ask; not labelled needs-owner']);
      assert.deepEqual(calls(liked), []);

      const edited = job('issue_comment', asked());
      edited.route('GET', events, { status: 200, json: [label('labeled', OWNER, '2026-11-14T08:00:00Z'), { event: 'labeled', created_at: '2026-11-15T09:59:40Z', actor: null, label: null }, { event: 'closed' }] });
      edited.route('GET', since, {
        status: 200,
        json: [
          { id: 60, body: 'Decision: old', user: { login: OWNER }, created_at: '2026-11-14T08:00:00Z', updated_at: '2026-11-15T09:59:40Z' },
          { id: 73, node_id: 'IC_73', body: 'Decision: yes', user: { login: OWNER }, created_at: '2026-11-15T09:59:40Z', updated_at: '2026-11-15T09:59:45Z' },
          { id: 74, body: null, user: null, created_at: '2026-11-15T09:59:41Z' },
        ],
      });
      edited.route('GET', thumbs, { status: 200, json: [{ user: { login: 'someone' }, created_at: '2026-11-15T09:59:41Z' }, { user: null, created_at: '2026-11-15T09:59:41Z' }, { user: { login: OWNER }, created_at: ASKED }] });
      edited.route('POST', `${API}/graphql`, { status: 200, json: { data: { nodes: [{ id: 'IC_73', userContentEdits: { totalCount: 1, nodes: [{ editor: { login: AGENT } }] } }] } } });
      assert.deepEqual((await runJob(edited)).out, ['needs-owner: #7 asks the owner (Needs you:) at https://github.com/example-org/example-app/issues/7; labelled needs-owner']);
      // Read before and again after labelling: the GraphQL reads are the edits of the one Decision: after the ask.
      assert.deepEqual(calls(edited), ['POST /graphql', `POST /repos/${SLUG}/issues/7/labels`, 'POST /graphql']);
    });

    it('takes the label off when the owner approved between the read and the label', async () => {
      const sys = job('issue_comment', asked());
      let reads = 0;
      sys.route('GET', events, () => ({ status: 200, json: reads++ === 0 ? relabelled.slice(0, 1) : relabelled }));
      quiet(sys);
      assert.deepEqual((await runJob(sys)).out, ['needs-owner: #7 asks the owner (Needs you:), and the owner answered with their approved label as it was labelled; needs-owner taken off']);
      assert.deepEqual(calls(sys), [`POST /repos/${SLUG}/issues/7/labels`, `DELETE /repos/${SLUG}/issues/7/labels/needs-owner`]);
    });

    it('labels it where nothing the owner did is newer than the ask, and reads nothing where the event gives no id or time, or the label is on', async () => {
      const sys = job('issue_comment', asked());
      sys.route('GET', events, { status: 200, json: relabelled.slice(0, 1) });
      quiet(sys);
      assert.deepEqual((await runJob(sys)).out, ['needs-owner: #7 asks the owner (Needs you:) at https://github.com/example-org/example-app/issues/7; labelled needs-owner']);
      assert.deepEqual(calls(sys), [`POST /repos/${SLUG}/issues/7/labels`]);
      const on = job('issue_comment', { ...asked(), issue: { number: 7, labels: [{ name: 'needs-owner' }] } });
      assert.deepEqual((await runJob(on)).out, ['needs-owner: #7 asks the owner (Needs you:) at https://github.com/example-org/example-app/issues/7; labelled needs-owner']);
      assert.deepEqual(on.requests, []);
    });

    it('labels it where the only answer is no answer: a label taken off or by no one, the ask’s own instant, or no time', async () => {
      for (const [name, json, decisions] of [
        ['approved taken off', [label('unlabeled', OWNER, '2026-11-15T09:59:40Z')], []],
        ['approved by no one', [{ event: 'labeled', created_at: '2026-11-15T09:59:40Z', actor: null, label: { name: 'approved' } }], []],
        ['approved as the ask was made', [label('labeled', OWNER, ASKED)], []],
        ['approved at no time', [{ event: 'labeled', actor: { login: OWNER }, label: { name: 'approved' } }], []],
        ['decided as the ask was made', [], [{ id: 71, body: 'Decision: yes', user: { login: OWNER }, created_at: ASKED }]],
      ] as const) {
        const sys = job('issue_comment', asked());
        sys.route('GET', events, { status: 200, json });
        sys.route('GET', since, { status: 200, json: decisions });
        sys.route('GET', thumbs, { status: 200, json: [] });
        assert.deepEqual((await runJob(sys)).out, ['needs-owner: #7 asks the owner (Needs you:) at https://github.com/example-org/example-app/issues/7; labelled needs-owner'], name);
        // With no Approvals issue in the settings, none is read.
        assert.ok(!sys.requests.some((request) => request.url.includes('/issues/undefined/')), name);
      }
    });

    it('reads no answer for a comment the event gives no id, or a review comment', async () => {
      const noId = { ...asked(), comment: { ...asked().comment, id: undefined } };
      const review = { ...asked(), issue: undefined, pull_request: { number: 7, labels: [] } };
      for (const [name, event] of [['issue_comment', noId], ['pull_request_review_comment', review]] as const) {
        const sys = job(name, event);
        assert.match((await runJob(sys)).out[0] ?? '', /labelled needs-owner$/);
        assert.deepEqual(sys.requests.map((request) => request.method), ['POST'], name);
      }
    });

    it('fails when GitHub refuses the read', async () => {
      const sys = job('issue_comment', asked());
      sys.route('GET', events, { status: 403, json: null });
      await assert.rejects(needsOwner(sys, capture().io), /cannot read \/repos\/example-org\/example-app\/issues\/7\/events \(HTTP 403\)/);
    });

    describe("the owner's batch answer on the Approvals issue (#357)", () => {
      /** Settings naming #9 as the Approvals issue. */
      const ON_9 = { owner: OWNER, agent: AGENT, approvals: 9 };
      const batch = `${API}/repos/${SLUG}/issues/9/comments?since=${encodeURIComponent(ASKED)}&per_page=100&page=1`;
      const says = (login: string, id: number, body: string, created_at = '2026-11-15T09:59:40Z', more: Record<string, unknown> = {}) => ({ id, body, user: { login }, created_at, ...more });
      const run = (list: unknown[] | (() => unknown[]), event: unknown = asked()) => {
        const sys = job('issue_comment', event, ON_9);
        sys.route('GET', events, { status: 200, json: [] });
        quiet(sys);
        sys.route('GET', batch, typeof list === 'function' ? () => ({ status: 200, json: list() }) : { status: 200, json: list });
        return sys;
      };
      const ANSWERED = 'needs-owner: #7 asks the owner (Needs you:), and the owner already answered with a "Decision: approve" on #9, the Approvals issue; not labelled needs-owner';

      it("does not label the issue when the owner's batch answer after the ask names it", async () => {
        const sys = run([says(OWNER, 90, 'Decision: approve #7 #12\nReasons.')]);
        assert.deepEqual((await runJob(sys)).out, [ANSWERED]);
        assert.deepEqual(calls(sys), []);
      });

      it('takes the label off when the batch answer lands between the read and the label', async () => {
        let reads = 0;
        const sys = run(() => (reads++ === 0 ? [] : [says(OWNER, 90, 'Decision: approve #7')]));
        assert.deepEqual((await runJob(sys)).out, [
          'needs-owner: #7 asks the owner (Needs you:), and the owner answered with a "Decision: approve" on #9, the Approvals issue as it was labelled; needs-owner taken off',
        ]);
        assert.deepEqual(calls(sys), [`POST /repos/${SLUG}/issues/7/labels`, `DELETE /repos/${SLUG}/issues/7/labels/needs-owner`]);
      });

      it("counts a proposal's answer by the issue its first line names, as the sweep does", async () => {
        const proposal = { ...asked(), comment: { ...asked().comment, body: `Proposal: add slice #12 to #7.\nPage: ${PAGE}` } };
        const named = run([says(OWNER, 90, 'Decision: approve #12')], proposal);
        assert.match((await runJob(named)).out[0] ?? '', /already answered with a "Decision: approve" on #9/);
        assert.deepEqual(calls(named), []);
        const other = run([says(OWNER, 90, 'Decision: approve #7')], proposal);
        assert.deepEqual((await runJob(other)).out, ['needs-owner: #7 asks the owner (Proposal:) at https://github.com/example-org/example-app/issues/7; labelled needs-owner']);
        // A Needs you: is answered for its own issue, whatever its first line names.
        const needs = { ...asked(), comment: { ...asked().comment, body: `Needs you: see #12 first.\nPage: ${PAGE}` } };
        assert.deepEqual((await runJob(run([says(OWNER, 90, 'Decision: approve #7')], needs))).out, [ANSWERED]);
      });

      it("labels it where the batch answer is someone else's, older than the ask, names other issues only, or was edited by someone else", async () => {
        const sys = run([
          says(AGENT, 91, 'Decision: approve #7'),
          says(OWNER, 92, 'Decision: approve #7', '2026-11-14T08:00:00Z', { updated_at: '2026-11-15T09:59:40Z' }),
          says(OWNER, 93, 'Decision: approve #8\nNot #7 yet.'),
          says(OWNER, 94, 'Decision: approve #7', '2026-11-15T09:59:40Z', { node_id: 'IC_94', updated_at: '2026-11-15T09:59:45Z' }),
        ]);
        sys.route('POST', `${API}/graphql`, { status: 200, json: { data: { nodes: [{ id: 'IC_94', userContentEdits: { totalCount: 1, nodes: [{ editor: { login: AGENT } }] } }] } } });
        assert.deepEqual((await runJob(sys)).out, ['needs-owner: #7 asks the owner (Needs you:) at https://github.com/example-org/example-app/issues/7; labelled needs-owner']);
        assert.deepEqual(calls(sys), ['POST /graphql', `POST /repos/${SLUG}/issues/7/labels`, 'POST /graphql']);
      });

      it('labels it where GitHub cannot find the Approvals issue, and reads it only when the issue itself has no answer', async () => {
        const missing = job('issue_comment', asked(), ON_9);
        missing.route('GET', events, { status: 200, json: [] });
        quiet(missing);
        missing.route('GET', batch, { status: 404, json: null });
        assert.deepEqual((await runJob(missing)).out, ['needs-owner: #7 asks the owner (Needs you:) at https://github.com/example-org/example-app/issues/7; labelled needs-owner']);
        const approved = job('issue_comment', asked(), ON_9);
        approved.route('GET', events, { status: 200, json: relabelled });
        await runJob(approved);
        assert.ok(!approved.requests.some((request) => request.url.includes('/issues/9/')));
      });
    });
  });

  it("takes the label off at the owner's Decision: comment, and at their approved label", async () => {
    const decided = job('issue_comment', comment(OWNER, 'Decision: go', ['needs-owner']));
    assert.deepEqual((await runJob(decided)).out, ['needs-owner: the owner decided on #7; needs-owner taken off']);
    assert.deepEqual(calls(decided), [`DELETE /repos/${SLUG}/issues/7/labels/needs-owner`]);
    const unlabelled = job('issue_comment', comment(OWNER, 'Decision: go'));
    assert.deepEqual((await runJob(unlabelled)).out, ['needs-owner: the owner decided on #7']);
    assert.deepEqual(calls(unlabelled), []);

    const approved = job('issues', { action: 'labeled', label: { name: 'approved' }, sender: { login: OWNER }, issue: { number: 7, labels: [{ name: 'needs-owner' }, { name: 'approved' }] } });
    assert.deepEqual((await runJob(approved)).out, ['needs-owner: the owner approved #7; needs-owner taken off']);
    assert.deepEqual(calls(approved), [`DELETE /repos/${SLUG}/issues/7/labels/needs-owner`]);
    const bare = job('issues', { action: 'labeled', label: { name: 'approved' }, sender: { login: OWNER }, issue: { number: 7 } });
    assert.deepEqual((await runJob(bare)).out, ['needs-owner: the owner approved #7']);
    assert.deepEqual(calls(bare), []);
  });

  describe('a batch answer on the Approvals issue', () => {
    /** Settings naming #7, where the comments of these tests are made, as the Approvals issue. */
    const ON_7 = { owner: OWNER, agent: AGENT, approvals: 7 };
    const NOV_8 = 'Decision: approve #2925 #2924 #2923 #2922 #2742 #2740 #2739 #2814\nNot #2748 yet: I want W-36 to land first.';
    const off = (number: number) => `${API}/repos/${SLUG}/issues/${number}/labels/needs-owner`;

    const hour = (h: number) => `2026-11-08T${String(h).padStart(2, '0')}:00:00Z`;
    const LABELLED = `${API}/repos/${SLUG}/issues?state=open&labels=needs-owner&per_page=100&page=1`;
    const onIssue = (number: number) => `${API}/repos/${SLUG}/issues/${number}/comments?per_page=100&page=1`;
    const thumbs = (id: number) => `${API}/repos/${SLUG}/issues/comments/${id}/reactions?content=%2B1&per_page=100&page=1`;
    /** The owner's batch answer as the comment event brings it: made on #7, the Approvals issue, at 05:00. */
    const answer = (body: string, made: Record<string, unknown> = {}) => ({
      action: 'created',
      comment: { id: 700, node_id: 'IC_700', body, user: { login: OWNER }, created_at: hour(5), updated_at: hour(5), ...made },
      issue: { number: 7, labels: [] },
    });
    type Said = { id: number; body: string; user: { login: string }; created_at: string };
    const says = (login: string, id: number, body: string, h: number): Said => ({ id, body, user: { login }, created_at: hour(h) });
    /** Routes issue `number`'s comments, and each one's 👍s: the owner's at `liked[id]`, none elsewhere. */
    const comments = (sys: FakeSys, number: number, list: Said[], liked: Record<number, string> = {}) => {
      sys.route('GET', onIssue(number), { status: 200, json: list });
      for (const { id } of list) sys.route('GET', thumbs(id), { status: 200, json: liked[id] ? [{ user: { login: OWNER }, created_at: liked[id] }] : [] });
    };

    it('judges each labelled issue at once, this answer counted, though the Approvals issue does not list it yet', async () => {
      const sys = job('issue_comment', answer(NOV_8), ON_7);
      sys.route('GET', LABELLED, { status: 200, json: [2925, 2748, 2924, 5].map((number) => ({ number })) });
      // #2925 asked before the answer, which names it; #2748, named only below the first line; #2924 and #5, where no agent asked.
      comments(sys, 2925, [says(AGENT, 1, `Needs you: approve? ${PAGE}`, 1)]);
      comments(sys, 2748, [says(AGENT, 2, `Proposal: add #2748 ${PAGE}`, 1)]);
      comments(sys, 2924, []);
      comments(sys, 5, []);
      comments(sys, 7, []);
      for (const number of [2925, 2924]) sys.route('DELETE', off(number), { status: 200, json: null });
      assert.deepEqual((await runJob(sys)).out, [
        'needs-owner: the owner approved #2925, #2924, #2923, #2922, #2742, #2740, #2739, #2814 on #7, the Approvals issue; judging each issue labelled needs-owner',
        '#2925: the owner answered with a "Decision: approve" on #7, the Approvals issue; needs-owner taken off',
        '#2748: waits on the owner (the proposal for #2748, https://github.com/example-org/example-app/issues/2748)',
        "#2924: no agent asked there, and the owner's batch answer names it; needs-owner taken off",
        '#5: no agent asked there; left as it is',
        'needs-owner: 4 labelled needs-owner, 2 cleared',
      ]);
      assert.deepEqual(calls(sys), [`DELETE /repos/${SLUG}/issues/2925/labels/needs-owner`, `DELETE /repos/${SLUG}/issues/2924/labels/needs-owner`]);
      assert.equal(sys.requests.filter((request) => request.url === onIssue(7)).length, 1, 'the Approvals issue is read once');
    });

    it('counts the answer once where the Approvals issue lists it, and only from that list when the event names no id', async () => {
      for (const [made, listed, line] of [
        [{ node_id: undefined, updated_at: undefined }, true, '#12: the owner answered with a "Decision: approve" on #7, the Approvals issue; needs-owner taken off'],
        [{ id: undefined }, false, '#12: waits on the owner (the Needs you: ask, https://github.com/example-org/example-app/issues/12)'],
      ] as const) {
        const sys = job('issue_comment', answer('Decision: approve #12', made), ON_7);
        sys.route('GET', LABELLED, { status: 200, json: [{ number: 12 }] });
        comments(sys, 12, [says(AGENT, 1, `Needs you: go? ${PAGE}`, 1)]);
        comments(sys, 7, listed ? [says(OWNER, 700, 'Decision: approve #12', 5)] : []);
        sys.route('DELETE', off(12), { status: 200, json: null });
        assert.equal((await runJob(sys)).out[1], line);
      }
    });

    describe('one proposal at a time (#203)', () => {
      const ADD = `Proposal: add #12 (Late slice) to work item #5, after its approval. ${PAGE}`;
      const DROP = `Proposal: drop state #30 (Dropped state), closed as not planned after work item #5's approval. ${PAGE}`;
      const add = (h: number) => says(AGENT, 120, ADD, h);
      const drop = (h: number) => says(AGENT, 121, DROP, h);

      /** What the sweep, then the comment event on Approvals, say of slice #12 with these comments and the owner's batch answer `batch`, made at 05:00. */
      const both = async (list: Said[], batch: string, liked: Record<number, string> = {}, timeline?: unknown[]): Promise<string[]> => {
        const lines: string[] = [];
        for (const name of ['schedule', 'issue_comment']) {
          const sys = job(name, name === 'schedule' ? {} : answer(batch), ON_7);
          sys.route('GET', LABELLED, { status: 200, json: [{ number: 12 }] });
          comments(sys, 12, list, liked);
          if (timeline) sys.route('GET', `${API}/repos/${SLUG}/issues/12/timeline?per_page=100&page=1`, { status: 200, json: timeline });
          comments(sys, 7, name === 'schedule' ? [says(OWNER, 700, batch, 5)] : []);
          sys.route('DELETE', off(12), { status: 200, json: null });
          lines.push(...(await runJob(sys)).out.filter((line) => line.startsWith('#12: ')));
        }
        return lines;
      };
      const twice = (line: string) => [line, line];
      const BATCHED = '#12: the owner answered with a "Decision: approve" on #7, the Approvals issue; needs-owner taken off';

      it("1. clears a slice owing only a State's drop when the batch names the State, and not when it names the slice", async () => {
        assert.deepEqual(await both([drop(1)], 'Decision: approve #30'), twice(BATCHED));
        assert.deepEqual(await both([drop(1)], 'Decision: approve #12'), twice('#12: waits on the owner (the proposal for #30, https://github.com/example-org/example-app/issues/12)'));
      });

      it('2. keeps a slice whose other proposal waits when the batch names one, and clears it when it names both', async () => {
        assert.deepEqual(await both([add(1), drop(2)], 'Decision: approve #12'), twice('#12: waits on the owner (the proposal for #30, https://github.com/example-org/example-app/issues/12)'));
        assert.deepEqual(await both([add(1), drop(2)], 'Decision: approve #30'), twice('#12: waits on the owner (the proposal for #12, https://github.com/example-org/example-app/issues/12)'));
        assert.deepEqual(await both([add(1), drop(2)], 'Decision: approve #12 #30'), twice(BATCHED));
      });

      it('3. keeps a slice where the owner 👍d the latest proposal and an earlier one waits, and clears it when each is answered', async () => {
        assert.deepEqual(await both([add(1), drop(2)], 'Decision: approve #99', { 121: hour(3) }), twice('#12: waits on the owner (the proposal for #12, https://github.com/example-org/example-app/issues/12)'));
        assert.deepEqual(await both([add(1), drop(2)], 'Decision: approve #99', { 120: hour(3), 121: hour(3) }), twice('#12: the owner answered with a 👍 on the ask; needs-owner taken off'));
        assert.deepEqual(
          await both([add(1), drop(2)], 'Decision: approve #12', { 121: hour(3) }),
          twice('#12: the owner answered with a 👍 on the ask and a "Decision: approve" on #7, the Approvals issue; needs-owner taken off'),
        );
      });

      it('counts a Decision: on the slice only for the proposals before it', async () => {
        assert.deepEqual(await both([add(1), says(OWNER, 122, 'Decision: yes', 2), drop(3)], 'Decision: approve #99'), twice('#12: waits on the owner (the proposal for #30, https://github.com/example-org/example-app/issues/12)'));
        assert.deepEqual(await both([add(1), drop(2), says(OWNER, 122, 'Decision: yes', 3)], 'Decision: approve #99'), twice('#12: the owner answered with a Decision: comment; needs-owner taken off'));
      });

      it('judges a Needs you: ask as before: the latest ask, when it is one', async () => {
        const ask = (h: number) => says(AGENT, 123, `Needs you: go? ${PAGE}`, h);
        // A Needs you: before a later proposal is not owed; the latest one is, for the slice itself.
        assert.deepEqual(await both([ask(1), drop(2)], 'Decision: approve #30'), twice(BATCHED));
        assert.deepEqual(await both([drop(1), ask(2)], 'Decision: approve #30'), twice('#12: waits on the owner (the Needs you: ask, https://github.com/example-org/example-app/issues/12)'));
        assert.deepEqual(await both([drop(1), ask(2)], 'Decision: approve #30 #12'), twice(BATCHED));
      });

      it("counts an answer to a slice's addition only after the slice was last added (#207)", async () => {
        const readded = (h: number) => [{ event: 'parent_issue_added', created_at: hour(0) }, { event: 'commented' }, { event: 'parent_issue_added', created_at: hour(h) }];
        // Taken out and added again at 04:00, after the proposal at 01:00: a 👍 or a Decision: before that answers nothing.
        assert.deepEqual(await both([add(1)], 'Decision: approve #99', { 120: hour(3) }, readded(4)), twice('#12: waits on the owner (the proposal for #12, https://github.com/example-org/example-app/issues/12)'));
        assert.deepEqual(await both([add(1)], 'Decision: approve #99', { 120: hour(6) }, readded(4)), twice('#12: the owner answered with a 👍 on the ask; needs-owner taken off'));
        assert.deepEqual(await both([add(1), says(OWNER, 122, 'Decision: yes', 3)], 'Decision: approve #99', {}, readded(4)), twice('#12: waits on the owner (the proposal for #12, https://github.com/example-org/example-app/issues/12)'));
        assert.deepEqual(await both([add(1), says(OWNER, 122, 'Decision: yes', 6)], 'Decision: approve #99', {}, readded(4)), twice('#12: the owner answered with a Decision: comment; needs-owner taken off'));
        // The batch answer at 05:00 counts after an addition at 04:00, not after one at 06:00.
        assert.deepEqual(await both([add(1)], 'Decision: approve #12', {}, readded(4)), twice(BATCHED));
        assert.deepEqual(await both([add(1)], 'Decision: approve #12', {}, readded(6)), twice('#12: waits on the owner (the proposal for #12, https://github.com/example-org/example-app/issues/12)'));
        // A State's drop is not the slice's addition, and an addition before the proposal changes nothing.
        assert.deepEqual(
          await both([add(1), drop(2)], 'Decision: approve #12', { 121: hour(3) }, readded(4)),
          twice('#12: the owner answered with a 👍 on the ask and a "Decision: approve" on #7, the Approvals issue; needs-owner taken off'),
        );
        assert.deepEqual(await both([add(1)], 'Decision: approve #99', { 120: hour(3) }, [{ event: 'parent_issue_added', created_at: hour(0) }]), twice('#12: the owner answered with a 👍 on the ask; needs-owner taken off'));
      });

      it("reads the slice's latest addition however the timeline orders it, and only additions", async () => {
        const added = (...hours: number[]) => hours.map((h) => ({ event: 'parent_issue_added', created_at: hour(h) }));
        assert.deepEqual(await both([add(1)], 'Decision: approve #99', { 120: hour(3) }, added(4, 0, 2)), twice('#12: waits on the owner (the proposal for #12, https://github.com/example-org/example-app/issues/12)'));
        assert.deepEqual(await both([add(1)], 'Decision: approve #99', { 120: hour(3) }, [...added(0), { event: 'commented', created_at: hour(4) }]), twice('#12: the owner answered with a 👍 on the ask; needs-owner taken off'));
        // An addition before a later proposal leaves that proposal's own time.
        assert.deepEqual(await both([add(6)], 'Decision: approve #12', {}, added(0)), twice('#12: waits on the owner (the proposal for #12, https://github.com/example-org/example-app/issues/12)'));
      });

      it("moves only the slice's own addition past a later addition, not a State's drop or a Needs you:", async () => {
        const readded = [{ event: 'parent_issue_added', created_at: hour(4) }];
        assert.deepEqual(await both([add(1), drop(2)], 'Decision: approve #99', { 120: hour(3), 121: hour(3) }, readded), twice('#12: waits on the owner (the proposal for #12, https://github.com/example-org/example-app/issues/12)'));
        const ask = says(AGENT, 123, `Needs you: go? ${PAGE}`, 2);
        assert.deepEqual(await both([add(1), ask], 'Decision: approve #99', { 120: hour(5), 123: hour(3) }, readded), twice('#12: the owner answered with a 👍 on the ask; needs-owner taken off'));
      });

      it("reads the slice's timeline only for a proposal for the slice itself", async () => {
        for (const list of [[says(AGENT, 123, `Needs you: go? ${PAGE}`, 1)], [drop(1)]]) {
          const sys = job('schedule', {}, ON_7);
          sys.route('GET', LABELLED, { status: 200, json: [{ number: 12 }] });
          comments(sys, 12, list);
          comments(sys, 7, []);
          await runJob(sys);
          assert.ok(!sys.requests.some((request) => request.url.includes('/timeline')));
        }
      });

      it('counts an answer only after the ask it answers, and only from an owner', async () => {
        // A Decision: made with the later proposal answers only the earlier one.
        assert.deepEqual(await both([add(1), drop(2), says(OWNER, 122, 'Decision: yes', 2)], 'Decision: approve #99'), twice('#12: waits on the owner (the proposal for #30, https://github.com/example-org/example-app/issues/12)'));
        // A 👍 made with the ask, and an agent's Decision: or a comment from no one after it, answer nothing.
        assert.deepEqual(await both([drop(1)], 'Decision: approve #99', { 121: hour(1) }), twice('#12: waits on the owner (the proposal for #30, https://github.com/example-org/example-app/issues/12)'));
        const nobody = { id: 125, body: 'Decision: yes', user: null, created_at: hour(2) } as unknown as Said;
        assert.deepEqual(await both([drop(1), says(AGENT, 124, 'Decision: yes', 2), nobody], 'Decision: approve #99'), twice('#12: waits on the owner (the proposal for #30, https://github.com/example-org/example-app/issues/12)'));
      });
    });

    it("sweeps: reads the edits only of owners' decisions after the earliest ask, and reads no 👍 from no one", async () => {
      const sys = job('schedule', {});
      sys.route('GET', LABELLED, { status: 200, json: [{ number: 12 }] });
      sys.route('GET', onIssue(12), {
        status: 200,
        json: [says(AGENT, 1, `Needs you: go? ${PAGE}`, 1), { ...says(OWNER, 2, 'Decision: old', 1), node_id: 'IC_2', updated_at: hour(2) }],
      });
      sys.route('GET', thumbs(1), { status: 200, json: [{ user: null, created_at: hour(3) }] });
      assert.deepEqual((await runJob(sys)).out, ['#12: waits on the owner (the Needs you: ask, https://github.com/example-org/example-app/issues/12)', 'needs-owner: 1 labelled needs-owner, 0 cleared']);
      assert.deepEqual(calls(sys), []);
      assert.ok(!sys.requests.some((request) => request.url.includes('/issues/undefined/')));
    });

    it("counts the event's own answer, as it was posted, only where the Approvals issue does not list it", async () => {
      const edits = (sys: FakeSys, editor: string) =>
        sys.route('POST', `${API}/graphql`, { status: 200, json: { data: { nodes: [{ id: 'IC_700', userContentEdits: { totalCount: 1, nodes: [{ editor: { login: editor } }] } }] } } });
      const WAITS = '#12: waits on the owner (the Needs you: ask, https://github.com/example-org/example-app/issues/12)';
      const CLEARED = '#12: the owner answered with a "Decision: approve" on #7, the Approvals issue; needs-owner taken off';
      for (const [name, made, listed, editor, line] of [
        ['listed as the agent edited it', {}, [{ ...says(OWNER, 700, 'Decision: approve #12', 5), node_id: 'IC_700', updated_at: hour(6) }], AGENT, WAITS],
        ['beside another comment', {}, [says(OWNER, 701, 'Decision: later', 1)], undefined, CLEARED],
        ['edited by the agent before the event', { updated_at: hour(6) }, [], AGENT, WAITS],
        ['edited by the owner alone', { updated_at: hour(6) }, [], OWNER, CLEARED],
        // On an Approvals issue GitHub cannot list, the event's answer still counts.
        ['on an Approvals issue GitHub cannot find', {}, null, undefined, CLEARED],
      ] as const) {
        const sys = job('issue_comment', answer('Decision: approve #12', made), ON_7);
        sys.route('GET', LABELLED, { status: 200, json: [{ number: 12 }] });
        comments(sys, 12, [says(AGENT, 1, `Needs you: go? ${PAGE}`, 1)]);
        sys.route('GET', onIssue(7), listed ? { status: 200, json: listed } : { status: 404, json: { message: 'Not Found' } });
        if (editor) edits(sys, editor);
        sys.route('DELETE', off(12), { status: 200, json: null });
        assert.equal((await runJob(sys)).out[1], line, name);
      }
      // A listed answer and the event's own answer the slice's two proposals between them.
      const sys = job('issue_comment', answer('Decision: approve #12'), ON_7);
      sys.route('GET', LABELLED, { status: 200, json: [{ number: 12 }] });
      comments(sys, 12, [says(AGENT, 1, `Proposal: add #12 to #5. ${PAGE}`, 1), says(AGENT, 2, `Proposal: drop state #30. ${PAGE}`, 2)]);
      sys.route('GET', onIssue(7), { status: 200, json: [says(OWNER, 701, 'Decision: approve #30', 4)] });
      sys.route('DELETE', off(12), { status: 200, json: null });
      assert.equal((await runJob(sys)).out[1], CLEARED);
    });

    it('is an ordinary decision on any other issue, from anyone but an owner, or without "approve"', async () => {
      const elsewhere = job('issue_comment', comment(OWNER, NOV_8, ['needs-owner']));
      assert.deepEqual((await runJob(elsewhere)).out, ['needs-owner: the owner decided on #7; needs-owner taken off']);
      assert.deepEqual(calls(elsewhere), [`DELETE /repos/${SLUG}/issues/7/labels/needs-owner`]);
      const plain = job('issue_comment', comment(OWNER, 'Decision: go', ['needs-owner']), ON_7);
      assert.deepEqual((await runJob(plain)).out, ['needs-owner: the owner decided on #7; needs-owner taken off']);
      for (const event of [comment(AGENT, NOV_8), { ...comment(OWNER, NOV_8), action: 'edited' }]) {
        const sys = job('issue_comment', event, ON_7);
        assert.deepEqual((await runJob(sys)).out, ['needs-owner: the comment on #7 neither asks the owner nor is their decision; nothing to do']);
        assert.deepEqual(calls(sys), []);
      }
    });

    it("sweeps: off where an owner's batch answer after the latest ask names it on the first line; read once", async () => {
      const sys = job('schedule', {}, { owner: OWNER, agent: AGENT, approvals: 70 });
      const at = (hour: number) => `2026-11-08T${String(hour).padStart(2, '0')}:00:00Z`;
      sys.route('GET', `${API}/repos/${SLUG}/issues?state=open&labels=needs-owner&per_page=100&page=1`, { status: 200, json: [1, 2, 3, 4].map((number) => ({ number })) });
      for (const number of [1, 2, 3, 4]) {
        sys.route('GET', `${API}/repos/${SLUG}/issues/${number}/comments?per_page=100&page=1`, { status: 200, json: [{ id: number * 10, body: `Proposal: ${number}`, user: { login: AGENT }, created_at: at(1) }] });
        sys.route('GET', `${API}/repos/${SLUG}/issues/comments/${number * 10}/reactions?content=%2B1&per_page=100&page=1`, { status: 200, json: [] });
      }
      const approvals = `${API}/repos/${SLUG}/issues/70/comments?per_page=100&page=1`;
      sys.route('GET', approvals, {
        status: 200,
        json: [
          // #1 approved after its ask; #3 named only below the first line.
          { id: 700, body: 'Decision: approve #1\nNot #3 yet.', user: { login: OWNER }, created_at: at(3) },
          // #2 approved before its latest ask.
          { id: 701, body: 'Decision: approve #2', user: { login: OWNER }, created_at: at(0) },
          // #4 approved in a comment the agent edited.
          { id: 702, node_id: 'IC_702', body: 'Decision: approve #4', user: { login: OWNER }, created_at: at(3), updated_at: at(4) },
        ],
      });
      sys.route('POST', `${API}/graphql`, { status: 200, json: { data: { nodes: [{ id: 'IC_702', userContentEdits: { totalCount: 2, nodes: [{ editor: { login: AGENT } }, { editor: { login: OWNER } }] } }] } } });
      sys.route('DELETE', `${API}/repos/${SLUG}/issues/1/labels/needs-owner`, { status: 200, json: null });
      assert.deepEqual((await runJob(sys)).out, [
        '#1: the owner answered with a "Decision: approve" on #70, the Approvals issue; needs-owner taken off',
        '#2: waits on the owner (the proposal for #2, https://github.com/example-org/example-app/issues/2)',
        '#3: waits on the owner (the proposal for #3, https://github.com/example-org/example-app/issues/3)',
        '#4: waits on the owner (the proposal for #4, https://github.com/example-org/example-app/issues/4)',
        'needs-owner: 4 labelled needs-owner, 1 cleared',
      ]);
      assert.deepEqual(calls(sys), [`DELETE /repos/${SLUG}/issues/1/labels/needs-owner`, 'POST /graphql']);
      assert.equal(sys.requests.filter((request) => request.url === approvals).length, 1);
    });

    it("sweeps: an owner's 👍 on the ask clears it without reading the Approvals issue", async () => {
      const sys = job('schedule', {}, { owner: OWNER, agent: AGENT, approvals: 70 });
      sys.route('GET', `${API}/repos/${SLUG}/issues?state=open&labels=needs-owner&per_page=100&page=1`, { status: 200, json: [{ number: 1 }] });
      sys.route('GET', `${API}/repos/${SLUG}/issues/1/comments?per_page=100&page=1`, { status: 200, json: [{ id: 10, body: 'Proposal: 1', user: { login: AGENT }, created_at: '2026-11-08T01:00:00Z' }] });
      sys.route('GET', `${API}/repos/${SLUG}/issues/comments/10/reactions?content=%2B1&per_page=100&page=1`, { status: 200, json: [{ user: { login: OWNER }, created_at: '2026-11-08T02:00:00Z' }] });
      sys.route('DELETE', `${API}/repos/${SLUG}/issues/1/labels/needs-owner`, { status: 200, json: null });
      assert.deepEqual((await runJob(sys)).out, ['#1: the owner answered with a 👍 on the ask; needs-owner taken off', 'needs-owner: 1 labelled needs-owner, 1 cleared']);
      assert.equal(sys.requests.some((request) => request.url.includes('/issues/70/')), false);
    });

    it('sweeps on where GitHub cannot find the Approvals issue', async () => {
      const sys = job('schedule', {}, { owner: OWNER, agent: AGENT, approvals: 71 });
      sys.route('GET', `${API}/repos/${SLUG}/issues?state=open&labels=needs-owner&per_page=100&page=1`, { status: 200, json: [{ number: 1 }] });
      sys.route('GET', `${API}/repos/${SLUG}/issues/1/comments?per_page=100&page=1`, { status: 200, json: [{ id: 10, body: 'Proposal: 1', user: { login: AGENT }, created_at: '2026-11-08T01:00:00Z' }] });
      sys.route('GET', `${API}/repos/${SLUG}/issues/comments/10/reactions?content=%2B1&per_page=100&page=1`, { status: 200, json: [] });
      sys.route('GET', `${API}/repos/${SLUG}/issues/71/comments?per_page=100&page=1`, { status: 404, json: { message: 'Not Found' } });
      assert.deepEqual((await runJob(sys)).out, ['#1: waits on the owner (the proposal for #1, https://github.com/example-org/example-app/issues/1)', 'needs-owner: 1 labelled needs-owner, 0 cleared']);
    });

    it("sweeps: names each waiting ask by the comment's own address where GitHub gives it (#557)", async () => {
      const sys = job('schedule', {}, { owner: OWNER, agent: AGENT });
      const at = (id: number): string => `https://github.com/${SLUG}/issues/1#issuecomment-${id}`;
      sys.route('GET', `${API}/repos/${SLUG}/issues?state=open&labels=needs-owner&per_page=100&page=1`, { status: 200, json: [{ number: 1 }] });
      sys.route('GET', `${API}/repos/${SLUG}/issues/1/comments?per_page=100&page=1`, {
        status: 200,
        json: [
          { id: 10, body: 'Proposal: add #1', user: { login: AGENT }, created_at: '2026-11-08T01:00:00Z', html_url: at(10) },
          { id: 11, body: 'Proposal: drop state #30', user: { login: AGENT }, created_at: '2026-11-08T02:00:00Z', html_url: at(11) },
        ],
      });
      sys.route('GET', `${API}/repos/${SLUG}/issues/1/timeline?per_page=100&page=1`, { status: 200, json: [] });
      for (const id of [10, 11]) sys.route('GET', `${API}/repos/${SLUG}/issues/comments/${id}/reactions?content=%2B1&per_page=100&page=1`, { status: 200, json: [] });
      assert.deepEqual((await runJob(sys)).out, [`#1: waits on the owner (the proposal for #1, ${at(10)}; the proposal for #30, ${at(11)})`, 'needs-owner: 1 labelled needs-owner, 0 cleared']);
      assert.equal(sys.requests.find((request) => request.url.includes('/timeline'))?.token, 'ghs_run');
    });
  });

  it('labels a pull request where the agent asks in a review comment, and clears it at a decision there', async () => {
    const asked = job('pull_request_review_comment', { action: 'created', comment: { body: `Proposal: x ${PAGE}`, user: { login: AGENT } }, pull_request: { number: 7, labels: [] } });
    assert.deepEqual((await runJob(asked)).out, ['needs-owner: #7 asks the owner (Proposal:) at https://github.com/example-org/example-app/issues/7; labelled needs-owner']);
    assert.deepEqual(calls(asked), [`POST /repos/${SLUG}/issues/7/labels`]);
    const decided = job('pull_request_review_comment', { action: 'created', comment: { body: 'Decision: yes', user: { login: OWNER } }, pull_request: { number: 7, labels: [{ name: 'needs-owner' }] } });
    await runJob(decided);
    assert.deepEqual(calls(decided), [`DELETE /repos/${SLUG}/issues/7/labels/needs-owner`]);
    assert.deepEqual((await runJob(job('pull_request', { action: 'opened', pull_request: { number: 7 } }))).out, ['needs-owner: nothing to do on a pull_request event']);
  });

  it('names the hourly cron in the shared workflow as the code does', () => {
    const checks = readFileSync(new URL('../.github/workflows/checks.yml', import.meta.url), 'utf8');
    assert.equal(checks.split(`github.event.schedule != '${HOURLY}'`).length, 2, 'the decisions job skips it');
    assert.equal(checks.split(`github.event.schedule == '${HOURLY}'`).length, 3, 'the needs-owner and issue-type jobs run on it');
    assert.match(checks, /pull_request_review_comment/);
  });

  it('leaves the label where someone else answers, or the comment is not an ask', async () => {
    for (const event of [
      comment(AGENT, 'Decision: mine'),
      comment(OWNER, 'Needs you: myself'),
      comment('someone', 'Proposal: x'),
      { ...comment(AGENT, 'Proposal: x'), action: 'edited' },
      { ...comment(OWNER, 'Decision: x'), action: 'deleted' },
      { action: 'created', issue: { number: 7 } },
    ]) {
      const sys = job('issue_comment', event);
      assert.deepEqual((await runJob(sys)).out, ['needs-owner: the comment on #7 neither asks the owner nor is their decision; nothing to do']);
      assert.deepEqual(calls(sys), []);
    }
    for (const event of [
      { action: 'labeled', label: { name: 'approved' }, sender: { login: AGENT }, issue: { number: 7 } },
      { action: 'labeled', label: { name: 'bug' }, sender: { login: OWNER }, issue: { number: 7 } },
      { action: 'unlabeled', label: { name: 'approved' }, sender: { login: OWNER }, issue: { number: 7 } },
      { action: 'labeled', issue: { number: 7 } },
    ]) {
      const sys = job('issues', event);
      assert.deepEqual((await runJob(sys)).out, ['needs-owner: #7 was not approved by the owner; nothing to do']);
      assert.deepEqual(calls(sys), []);
    }
    assert.deepEqual((await runJob(job('push', {}))).out, ['needs-owner: nothing to do on a push event']);
    assert.deepEqual((await runJob(job('issues', {}))).out, ['needs-owner: nothing to do on a issues event']);
  });

  it('reads an event by its name: a pull request only for a review comment, an issue only for a comment or an issue event', async () => {
    for (const [name, event] of [
      ['issue_comment', { action: 'created', comment: { body: `Needs you: x ${PAGE}`, user: { login: AGENT } }, pull_request: { number: 7, labels: [] } }],
      ['issue_comment', { action: 'created', comment: { body: `Needs you: x ${PAGE}`, user: { login: AGENT } } }],
      ['push', { issue: { number: 7 }, label: { name: 'approved' }, action: 'labeled', sender: { login: OWNER } }],
    ] as const) {
      const sys = job(name, event);
      assert.deepEqual((await runJob(sys)).out, [`needs-owner: nothing to do on a ${name} event`]);
      assert.deepEqual(sys.requests, []);
    }
  });

  it('reads a comment with no author, a label event with no sender, and a body with no text as no one’s', async () => {
    const noUser = job('issue_comment', { action: 'created', comment: { body: 'Proposal: x', user: null }, issue: { number: 7 } });
    assert.deepEqual((await runJob(noUser)).out, ['needs-owner: the comment on #7 neither asks the owner nor is their decision; nothing to do']);
    const noSender = job('issues', { action: 'labeled', label: { name: 'approved' }, issue: { number: 7, labels: [{ name: 'needs-owner' }] } });
    assert.deepEqual((await runJob(noSender)).out, ['needs-owner: #7 was not approved by the owner; nothing to do']);
    assert.deepEqual(calls(noSender), []);
    const empty = job('issue_comment', { action: 'created', comment: { body: null, user: { login: OWNER } }, issue: { number: 7 } }, { owner: OWNER, agent: AGENT, approvals: 7 });
    assert.deepEqual((await runJob(empty)).out, ['needs-owner: the comment on #7 neither asks the owner nor is their decision; nothing to do']);
  });

  it("counts only the needs-owner label as the issue's, and the ask's own address only where it is a web address", async () => {
    const sys = job('issue_comment', comment(AGENT, `Needs you: approve? ${PAGE}`, ['bug']));
    await runJob(sys);
    assert.deepEqual(calls(sys), [`POST /repos/${SLUG}/issues/7/labels`]);
    const own = comment(AGENT, `Needs you: approve? ${PAGE}`);
    const odd = job('issue_comment', { ...own, comment: { ...own.comment, html_url: `http://github.com/${SLUG}/issues/7#issuecomment-41` } });
    assert.deepEqual((await runJob(odd)).out, ['needs-owner: #7 asks the owner (Needs you:) at https://github.com/example-org/example-app/issues/7; labelled needs-owner']);
  });

  it('sweeps: off where the owner 👍d the latest ask after its last edit or decided after it; on elsewhere', async () => {
    const sys = job('schedule', {});
    const issues = (number: number) => `${API}/repos/${SLUG}/issues/${number}/comments?per_page=100&page=1`;
    const reactions = (id: number) => `${API}/repos/${SLUG}/issues/comments/${id}/reactions?content=%2B1&per_page=100&page=1`;
    sys.route('GET', `${API}/repos/${SLUG}/issues?state=open&labels=needs-owner&per_page=100&page=1`, { status: 200, json: [1, 2, 3, 4, 5, 6].map((number) => ({ number })) });
    const at = (hour: number) => `2026-11-07T${String(hour).padStart(2, '0')}:00:00Z`;
    const ask = (id: number, hour: number, edited?: number) => ({ id, body: `Needs you: ${id}`, user: { login: AGENT }, created_at: at(hour), updated_at: at(edited ?? hour) });
    // #1: 👍 on the latest ask.
    sys.route('GET', issues(1), { status: 200, json: [ask(10, 1), ask(11, 2)] });
    sys.route('GET', reactions(11), { status: 200, json: [{ user: { login: OWNER }, created_at: at(3) }] });
    // #2: 👍 only on an older ask, and by someone else on the latest.
    sys.route('GET', issues(2), { status: 200, json: [ask(20, 1), ask(21, 4)] });
    sys.route('GET', reactions(21), { status: 200, json: [{ user: { login: 'someone' }, created_at: at(5) }] });
    // #3: the ask was edited after the 👍.
    sys.route('GET', issues(3), { status: 200, json: [ask(30, 1, 6)] });
    sys.route('GET', reactions(30), { status: 200, json: [{ user: { login: OWNER }, created_at: at(2) }] });
    // #4: the owner decided after the ask.
    sys.route('GET', issues(4), { status: 200, json: [ask(40, 1), { id: 41, body: 'Decision: no', user: { login: OWNER }, created_at: at(2) }] });
    // #5: no agent asked there, as on an undo issue.
    sys.route('GET', issues(5), { status: 200, json: [{ id: 50, body: 'Proposal: by hand', user: { login: OWNER }, created_at: at(1) }, { id: 51, body: null, user: null, created_at: at(2) }] });
    // #6: a decision before the latest ask does not answer it.
    sys.route('GET', issues(6), { status: 200, json: [{ id: 60, body: 'Decision: old', user: { login: OWNER }, created_at: at(1) }, { ...ask(61, 2), updated_at: undefined }] });
    sys.route('GET', reactions(61), { status: 200, json: [] });
    for (const number of [1, 4]) sys.route('DELETE', `${API}/repos/${SLUG}/issues/${number}/labels/needs-owner`, { status: 404, json: null });
    assert.deepEqual((await runJob(sys)).out, [
      '#1: the owner answered with a 👍 on the ask; needs-owner taken off',
      '#2: waits on the owner (the Needs you: ask, https://github.com/example-org/example-app/issues/2)',
      '#3: waits on the owner (the Needs you: ask, https://github.com/example-org/example-app/issues/3)',
      '#4: the owner answered with a Decision: comment; needs-owner taken off',
      '#5: no agent asked there; left as it is',
      '#6: waits on the owner (the Needs you: ask, https://github.com/example-org/example-app/issues/6)',
      'needs-owner: 6 labelled needs-owner, 2 cleared',
    ]);
    assert.deepEqual(calls(sys), [`DELETE /repos/${SLUG}/issues/1/labels/needs-owner`, `DELETE /repos/${SLUG}/issues/4/labels/needs-owner`]);
  });

  it('sweeps: a Decision: someone other than an owner edited answers nothing; one owners alone edited does', async () => {
    const sys = job('schedule', {});
    const issues = (number: number) => `${API}/repos/${SLUG}/issues/${number}/comments?per_page=100&page=1`;
    sys.route('GET', `${API}/repos/${SLUG}/issues?state=open&labels=needs-owner&per_page=100&page=1`, { status: 200, json: [1, 2].map((number) => ({ number })) });
    const ask = (id: number) => ({ id, body: `Needs you: ${id}`, user: { login: AGENT }, created_at: '2026-11-07T01:00:00Z' });
    const decision = (id: number) => ({ id, node_id: `IC_${id}`, body: 'Decision: yes', user: { login: OWNER }, created_at: '2026-11-07T02:00:00Z', updated_at: '2026-11-07T03:00:00Z' });
    // #1: the agent edited the owner's decision; #2: only the owner did.
    sys.route('GET', issues(1), { status: 200, json: [ask(10), decision(11)] });
    sys.route('GET', `${API}/repos/${SLUG}/issues/comments/10/reactions?content=%2B1&per_page=100&page=1`, { status: 200, json: [] });
    sys.route('GET', issues(2), { status: 200, json: [ask(20), decision(21)] });
    const edits: Record<string, string[]> = { IC_11: [AGENT, OWNER], IC_21: [OWNER, OWNER] };
    sys.route('POST', `${API}/graphql`, () => {
      const { ids } = (sys.requests.at(-1)?.body as { variables: { ids: string[] } }).variables;
      const nodes = ids.map((id) => ({ id, userContentEdits: { totalCount: 2, nodes: (edits[id] ?? []).map((login) => ({ editor: { login } })) } }));
      return { status: 200, json: { data: { nodes } } };
    });
    sys.route('DELETE', `${API}/repos/${SLUG}/issues/2/labels/needs-owner`, { status: 200, json: null });
    assert.deepEqual((await runJob(sys)).out, [
      '#1: waits on the owner (the Needs you: ask, https://github.com/example-org/example-app/issues/1)',
      '#2: the owner answered with a Decision: comment; needs-owner taken off',
      'needs-owner: 2 labelled needs-owner, 1 cleared',
    ]);
    // One edit read for each issue's edited decision; the label comes off #2 alone.
    assert.deepEqual(calls(sys), ['POST /graphql', 'POST /graphql', `DELETE /repos/${SLUG}/issues/2/labels/needs-owner`]);
  });

  it('sweeps on a run by hand too, reading every page', async () => {
    const sys = job('workflow_dispatch', {});
    const list = `${API}/repos/${SLUG}/issues?state=open&labels=needs-owner&per_page=100`;
    sys.route('GET', `${list}&page=1`, { status: 200, json: Array.from({ length: 100 }, () => ({ number: 9 })) });
    sys.route('GET', `${list}&page=2`, { status: 200, json: [{ number: 9 }] });
    sys.route('GET', `${API}/repos/${SLUG}/issues/9/comments?per_page=100&page=1`, { status: 200, json: [] });
    assert.equal((await runJob(sys)).out.at(-1), 'needs-owner: 101 labelled needs-owner, 0 cleared');
    // Every read carries the run's token.
    assert.deepEqual([...new Set(sys.requests.map((request) => request.token))], ['ghs_run']);
  });

  it('fails where GitHub lists no array, refuses, or cannot find the labelled issues', async () => {
    const open = `${API}/repos/${SLUG}/issues?state=open&labels=needs-owner&per_page=100&page=1`;
    for (const result of [{ status: 200, json: {} }, { status: 500, json: [] }, { status: 404, json: [] }]) {
      const sys = job('schedule', {});
      sys.route('GET', open, result);
      await assert.rejects(needsOwner(sys, capture().io), { message: `cannot read /repos/example-org/example-app/issues?state=open&labels=needs-owner (HTTP ${result.status})` });
    }
  });

  it('sweeps: takes needs-owner off every closed issue and pull request, answered or not (#639)', async () => {
    const sys = job('schedule', {});
    sys.route('GET', `${API}/repos/${SLUG}/issues?state=open&labels=needs-owner&per_page=100&page=1`, { status: 200, json: [] });
    const closed = `${API}/repos/${SLUG}/issues?state=closed&labels=needs-owner&per_page=100&page=1`;
    sys.route('GET', closed, { status: 200, json: [{ number: 604 }, { number: 611, pull_request: {} }] });
    sys.route('DELETE', `${API}/repos/${SLUG}/issues/604/labels/needs-owner`, { status: 200, json: null });
    // Gone already, as when the owner took it off by hand meanwhile.
    sys.route('DELETE', `${API}/repos/${SLUG}/issues/611/labels/needs-owner`, { status: 404, json: null });
    assert.deepEqual((await runJob(sys)).out, [
      '#604: closed; needs-owner taken off',
      '#611: closed; needs-owner taken off',
      'needs-owner: 0 labelled needs-owner, 0 cleared; 2 closed, cleared',
    ]);
    // Closed issues are not judged by their asks: no comment is read.
    assert.deepEqual(
      sys.requests.map((request) => `${request.method} ${request.url.replace(API, '')}`),
      [
        `GET /repos/${SLUG}/issues?state=open&labels=needs-owner&per_page=100&page=1`,
        `GET /repos/${SLUG}/issues?state=closed&labels=needs-owner&per_page=100&page=1`,
        `DELETE /repos/${SLUG}/issues/604/labels/needs-owner`,
        `DELETE /repos/${SLUG}/issues/611/labels/needs-owner`,
      ],
    );
    const refused = job('schedule', {});
    refused.route('GET', `${API}/repos/${SLUG}/issues?state=open&labels=needs-owner&per_page=100&page=1`, { status: 200, json: [] });
    refused.route('GET', closed, { status: 403, json: null });
    await assert.rejects(needsOwner(refused, capture().io), /cannot read \/repos\/example-org\/example-app\/issues\?state=closed&labels=needs-owner \(HTTP 403\)/);
  });

  describe('a reopened issue (#639)', () => {
    const at = (hour: number) => `2026-11-25T${String(hour).padStart(2, '0')}:00:00Z`;
    const reopen = (labels: string[] = []) => job('issues', { action: 'reopened', sender: { login: OWNER }, issue: { number: 7, labels: labels.map((name) => ({ name })) } });
    const ask = { id: 70, body: `Needs you: ship? ${PAGE}`, user: { login: AGENT }, created_at: at(1), updated_at: at(1) };
    /** Routes #7's comments, the owner's 👍 on the ask at `liked`, and #7's events. */
    const on7 = (sys: FakeSys, comments: unknown[], liked?: string, events: unknown[] = []) => {
      sys.route('GET', `${API}/repos/${SLUG}/issues/7/comments?per_page=100&page=1`, { status: 200, json: comments });
      sys.route('GET', `${API}/repos/${SLUG}/issues/comments/70/reactions?content=%2B1&per_page=100&page=1`, { status: 200, json: liked ? [{ user: { login: OWNER }, created_at: liked }] : [] });
      sys.route('GET', `${API}/repos/${SLUG}/issues/7/events?per_page=100&page=1`, { status: 200, json: events });
    };

    it('is labelled again where an ask on it still waits', async () => {
      const sys = reopen();
      on7(sys, [ask]);
      assert.deepEqual((await runJob(sys)).out, [
        'needs-owner: #7 was reopened and waits on the owner (the Needs you: ask, https://github.com/example-org/example-app/issues/7); labelled needs-owner',
      ]);
      assert.deepEqual(calls(sys), [`POST /repos/${SLUG}/issues/7/labels`]);
    });

    it('is left unlabelled where the owner answered, approved it after the ask, or no agent asked', async () => {
      const liked = reopen();
      on7(liked, [ask], at(2));
      assert.deepEqual((await runJob(liked)).out, ['needs-owner: #7 was reopened, and nothing on it waits on the owner; not labelled needs-owner']);
      assert.deepEqual(calls(liked), []);

      const approved = reopen();
      on7(approved, [ask], undefined, [
        { event: 'labeled', label: { name: 'approved' }, actor: { login: AGENT }, created_at: at(2) },
        { event: 'labeled', label: { name: 'approved' }, actor: { login: OWNER }, created_at: at(3) },
      ]);
      assert.deepEqual((await runJob(approved)).out, ['needs-owner: #7 was reopened, and the owner approved it after its asks; not labelled needs-owner']);
      assert.deepEqual(calls(approved), []);

      // An approval before the ask answers nothing, so the ask still waits.
      const early = reopen();
      on7(early, [ask], undefined, [{ event: 'labeled', label: { name: 'approved' }, actor: { login: OWNER }, created_at: '2026-11-24T23:00:00Z' }]);
      assert.match((await runJob(early)).out[0] ?? '', /was reopened and waits on the owner/);
      assert.deepEqual(calls(early), [`POST /repos/${SLUG}/issues/7/labels`]);

      // A label whose time cannot be read, or that is put at noon at +12:00 (00:00 UTC, before the ask), answers nothing.
      const unread = reopen();
      on7(unread, [ask], undefined, [
        { event: 'labeled', label: { name: 'approved' }, actor: { login: OWNER } },
        { event: 'labeled', label: { name: 'approved' }, actor: { login: OWNER }, created_at: '2026-11-25T12:00:00+12:00' },
      ]);
      assert.match((await runJob(unread)).out[0] ?? '', /was reopened and waits on the owner/);
      assert.deepEqual(calls(unread), [`POST /repos/${SLUG}/issues/7/labels`]);

      const unasked = reopen();
      on7(unasked, [{ id: 71, body: 'a plain comment', user: { login: AGENT }, created_at: at(1) }]);
      assert.deepEqual((await runJob(unasked)).out, ['needs-owner: #7 was reopened, and nothing on it waits on the owner; not labelled needs-owner']);
      assert.deepEqual(calls(unasked), []);
    });

    it('is labelled again where no approval of the owner comes after every waiting ask', async () => {
      const approved = (created_at: string, name: string | null = 'approved', login: string | null = OWNER) => ({ event: 'labeled', created_at, label: name === null ? null : { name }, actor: login === null ? null : { login } });
      const later = { id: 72, body: `Needs you: and this? ${PAGE}`, user: { login: AGENT }, created_at: at(3), updated_at: at(3) };
      for (const [name, comments, events] of [
        ['approved between two asks', [{ ...ask, body: `Proposal: ship ${PAGE}` }, later], [approved(at(2))]],
        ['approval taken off after the ask', [ask], [{ ...approved(at(2)), event: 'unlabeled' }]],
        ['another label after the ask', [ask], [approved(at(2), 'bug')]],
        ['a label GitHub names no label', [ask], [approved(at(2), null)]],
        ['approved by no one', [ask], [approved(at(2), 'approved', null)]],
        ['approved as the ask was made', [ask], [approved(at(1))]],
      ] as const) {
        const sys = reopen();
        on7(sys, [...comments], undefined, [...events]);
        sys.route('GET', `${API}/repos/${SLUG}/issues/comments/72/reactions?content=%2B1&per_page=100&page=1`, { status: 200, json: [] });
        assert.match((await runJob(sys)).out[0] ?? '', /was reopened and waits on the owner/, name);
        assert.deepEqual(calls(sys), [`POST /repos/${SLUG}/issues/7/labels`], name);
        assert.ok(!sys.requests.some((request) => request.url.includes('/issues/undefined/')), name);
      }
    });

    it("reads the Approvals issue for an ask the issue itself has not answered, and labels it where GitHub cannot find it", async () => {
      const settings = { owner: OWNER, agent: AGENT, approvals: 9 };
      const batch = (json: unknown, status = 200) => {
        const sys = job('issues', { action: 'reopened', sender: { login: OWNER }, issue: { number: 7, labels: [] } }, settings);
        on7(sys, [ask]);
        sys.route('GET', `${API}/repos/${SLUG}/issues/9/comments?per_page=100&page=1`, { status, json });
        return sys;
      };
      const answered = batch([{ id: 90, body: 'Decision: approve #7', user: { login: OWNER }, created_at: at(2) }]);
      assert.deepEqual((await runJob(answered)).out, ['needs-owner: #7 was reopened, and nothing on it waits on the owner; not labelled needs-owner']);
      const missing = batch(null, 404);
      assert.match((await runJob(missing)).out[0] ?? '', /was reopened and waits on the owner/);
    });

    it('is left as it is where it still has the label', async () => {
      const sys = reopen(['needs-owner']);
      assert.deepEqual((await runJob(sys)).out, ['needs-owner: #7 was reopened, already labelled needs-owner']);
      assert.deepEqual(sys.requests, []);
    });
  });

  it('fails when GitHub refuses a read or a label', async () => {
    const list = job('schedule', {});
    list.route('GET', `${API}/repos/${SLUG}/issues?state=open&labels=needs-owner&per_page=100&page=1`, { status: 403, json: null });
    await assert.rejects(needsOwner(list, capture().io), /cannot read \/repos\/example-org\/example-app\/issues\?state=open&labels=needs-owner \(HTTP 403\)/);
    const add = job('issue_comment', comment(AGENT, 'Proposal: x'));
    add.route('POST', LABELS, { status: 403, json: null });
    await assert.rejects(needsOwner(add, capture().io), /cannot label #7 needs-owner \(HTTP 403\)/);
    const remove = job('issue_comment', comment(OWNER, 'Decision: x', ['needs-owner']));
    remove.route('DELETE', `${LABELS}/needs-owner`, { status: 500, json: null });
    await assert.rejects(needsOwner(remove, capture().io), /cannot take needs-owner off #7 \(HTTP 500\)/);
  });

  it('runs only in Actions, in an adopted repository with the board on', async () => {
    const sys = job('schedule', {});
    sys.env = {};
    await assert.rejects(needsOwner(sys, capture().io), /needs-owner runs in GitHub Actions/);
    for (const name of ['GITHUB_EVENT_NAME', 'GITHUB_EVENT_PATH', 'GITHUB_REPOSITORY', 'GH_TOKEN'] as const) {
      const one = job('schedule', {});
      delete one.env[name];
      await assert.rejects(needsOwner(one, capture().io), { message: 'needs-owner runs in GitHub Actions: GITHUB_EVENT_NAME, GITHUB_EVENT_PATH, GITHUB_REPOSITORY and GH_TOKEN must be set' }, name);
    }
    const bare = job('schedule', {});
    bare.files.delete(`${ROOT}/.github/niyam.json`);
    assert.deepEqual((await runJob(bare)).out, ['needs-owner: the base branch has no .github/niyam.json, so the repo is not adopted on its base yet; nothing to check']);
    const off = job('schedule', {}, { owner: OWNER, agent: AGENT, features: ['identity', 'work-rules'] });
    assert.deepEqual((await runJob(off)).out, ['needs-owner: board is off in .github/niyam.json; nothing to check']);
  });
});
