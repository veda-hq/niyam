import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parse } from 'yaml';

import { guardCaller } from './guard-caller.ts';
import { workflow } from './onboard.ts';
import { QUEUE_DRAFT_EDIT, skipQueueDraftEdit } from './queue-draft.ts';

/**
 * Evaluates `expression` in `context` as GitHub Actions does, for the part of
 * its expression language the caller jobs' `if:` use: context paths, 'strings',
 * !, ==, !=, && and || (each giving an operand, as GitHub's do), parentheses,
 * startsWith() and contains(). GitHub compares strings ignoring case, a missing
 * property is null, and an object is truthy. A whole `${{ … }}` is read as the
 * expression inside it.
 * https://docs.github.com/en/actions/reference/workflows-and-actions/expressions, read 2026-11-26.
 */
function evaluate(expression: string, context: unknown): unknown {
  const inner = /^\$\{\{([\s\S]*)\}\}$/.exec(expression.trim())?.[1] ?? expression;
  const tokens = inner.match(/'(?:[^']|'')*'|&&|\|\||==|!=|!|[(),]|[\w.[\]-]+/g) ?? [];
  let at = 0;
  const truthy = (value: unknown): boolean => value !== null && value !== undefined && value !== false && value !== '' && value !== 0;
  const same = (a: unknown, b: unknown): boolean => (typeof a === 'string' && typeof b === 'string' ? a.toLowerCase() === b.toLowerCase() : (a ?? null) === (b ?? null));
  const call = (name: string): unknown => {
    at++;
    const subject = or();
    assert.equal(tokens[at++], ',');
    const part = or();
    assert.equal(tokens[at++], ')');
    const [whole, piece] = [String(subject ?? '').toLowerCase(), String(part).toLowerCase()];
    if (name === 'startsWith') return whole.startsWith(piece);
    assert.equal(name, 'contains', `${name}() is not in this evaluator`);
    return whole.includes(piece);
  };
  const primary = (): unknown => {
    const token = tokens[at++] as string;
    if (token === '!') return !truthy(primary());
    if (token === '(') {
      const value = or();
      assert.equal(tokens[at++], ')');
      return value;
    }
    if (token.startsWith("'")) return token.slice(1, -1).replaceAll("''", "'");
    if (tokens[at] === '(') return call(token);
    return token.split('.').reduce<unknown>((value, key) => (value === null || value === undefined ? undefined : (value as Record<string, unknown>)[key]), context);
  };
  const equals = (): unknown => {
    let value = primary();
    while (tokens[at] === '==' || tokens[at] === '!=') {
      const op = tokens[at++];
      const right = primary();
      value = op === '==' ? same(value, right) : !same(value, right);
    }
    return value;
  };
  const and = (): unknown => {
    let value = equals();
    while (tokens[at] === '&&') {
      at++;
      const right = equals();
      value = truthy(value) ? right : value;
    }
    return value;
  };
  const or = (): unknown => {
    let value = and();
    while (tokens[at] === '||') {
      at++;
      const right = and();
      value = truthy(value) ? value : right;
    }
    return value;
  };
  const value = or();
  assert.equal(at, tokens.length, `${inner} is not wholly read`);
  return truthy(value);
}

const REPO = 'o/r';
/** Mergify's draft as athya_mono#3945 was: its author, branch, repository and title. */
const DRAFT = {
  number: 3945,
  title: 'merge queue: checking #3942 on main (2a77f88)',
  user: { login: 'mergify[bot]', type: 'Bot' },
  head: { ref: 'mergify/merge-queue/011d162902', repo: { full_name: REPO } },
};
/** An agent's pull request. */
const ORDINARY = { number: 3942, title: '✨ feat(x): y', user: { login: 'AthyaBot', type: 'User' }, head: { ref: 'claude/x', repo: { full_name: REPO } } };

/** The GitHub context of a pull request event: `name` is pull_request for niyam.yml, pull_request_target for the caller. */
function event(name: string, action: string, pull: object, changes: object = { body: { from: 'before' } }) {
  return { github: { event_name: name, repository: REPO, event: { action, pull_request: pull, ...(action === 'edited' ? { changes } : {}) } } };
}

type Jobs = { jobs: Record<string, { if?: string }> };
const niyamIf = (parse(workflow('main', '0.7.22', false)) as Jobs).jobs.niyam?.if as string;
const callerIf = (parse(guardCaller('main', '0.7.22')) as Jobs).jobs['niyam-guard']?.if as string;
const runs = {
  niyam: (action: string, pull: object, changes?: object) => evaluate(niyamIf, event('pull_request', action, pull, changes)),
  caller: (action: string, pull: object, changes?: object) => evaluate(callerIf, event('pull_request_target', action, pull, changes)),
};

describe("the caller jobs' skip of an edit of Mergify's queue draft (#685)", () => {
  it('skips an edit of the draft that changes its body alone, or nothing GitHub names', () => {
    for (const [job, ran] of Object.entries(runs)) {
      assert.equal(ran('edited', DRAFT), false, job);
      assert.equal(ran('edited', DRAFT, {}), false, `${job}: changes naming nothing`);
      assert.equal(ran('edited', { ...DRAFT, user: { login: 'Mergify[bot]', type: 'bot' } }), false, `${job}: GitHub compares strings ignoring case`);
    }
  });

  it('judges every head of the draft: opened, synchronize and reopened', () => {
    for (const [job, ran] of Object.entries(runs)) {
      for (const action of ['opened', 'synchronize', 'reopened']) assert.equal(ran(action, DRAFT), true, `${job} ${action}`);
    }
  });

  it('judges each edit of an ordinary pull request, whose body can change its Slice: line', () => {
    for (const [job, ran] of Object.entries(runs)) assert.equal(ran('edited', ORDINARY), true, job);
  });

  it('judges the edit when any one thing that makes the draft Mergify’s, or leaves its head as judged, fails alone', () => {
    const one: [string, object, object?][] = [
      ['another author', { ...DRAFT, user: { login: 'someone', type: 'Bot' } }],
      ['a user named so', { ...DRAFT, user: { login: 'mergify[bot]', type: 'User' } }],
      ['another branch', { ...DRAFT, head: { ...DRAFT.head, ref: 'feature/mergify/merge-queue/x' } }],
      ['a fork', { ...DRAFT, head: { ...DRAFT.head, repo: { full_name: 'fork/r' } } }],
      ['no head repository', { ...DRAFT, head: { ref: DRAFT.head.ref, repo: null } }],
      ['a title change', DRAFT, { title: { from: 'merge queue: checking #3942 on main (1111111)' } }],
      ['merged #A', { ...DRAFT, title: 'merge queue: merged #3942: ✨ feat(x): y' }, { title: { from: DRAFT.title } }],
      ['a base change', DRAFT, { base: { ref: { from: 'main' } } }],
      ['a deep stack, whose tested pull requests come from its body', { ...DRAFT, title: `${DRAFT.title}, stacked on 4 pull requests ahead` }],
    ];
    for (const [job, ran] of Object.entries(runs)) {
      for (const [why, pull, changes] of one) assert.equal(ran('edited', pull, changes), true, `${job}: ${why}`);
    }
  });

  it("leaves niyam.yml's pull request job as it was otherwise: never on closed, always on a push", () => {
    assert.equal(runs.niyam('closed', ORDINARY), false);
    assert.equal(runs.niyam('closed', DRAFT), false);
    assert.equal(evaluate(niyamIf, { github: { event_name: 'push', repository: REPO, event: {} } }), true);
    assert.equal(evaluate(niyamIf, { github: { event_name: 'schedule', repository: REPO, event: {} } }), false);
  });

  it('writes the expression once, as lines YAML folds into it, with the comment above it', () => {
    assert.deepEqual(skipQueueDraftEdit('A ', ' B'), [
      "    # Not on an edit of Mergify's queue draft that changes no title or base: its head's runs stand (veda-hq/niyam#685).",
      '    if: >-',
      `      A !(${QUEUE_DRAFT_EDIT[0]}`,
      ...QUEUE_DRAFT_EDIT.slice(1, -1).map((line) => `      ${line}`),
      `      ${QUEUE_DRAFT_EDIT.at(-1)}) B`,
    ]);
    assert.equal(niyamIf, `(github.event_name == 'pull_request' && github.event.action != 'closed' && !(${QUEUE_DRAFT_EDIT.join(' ')})) || github.event_name == 'push'`);
    assert.equal(callerIf, `\${{ !(${QUEUE_DRAFT_EDIT.join(' ')}) }}`);
  });
});
