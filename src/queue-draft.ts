import { MERGE_QUEUE_BOT, MERGE_QUEUE_BRANCH } from '../scripts/merge-queue.mjs';

/**
 * The expression, as GitHub Actions reads it, that holds for an edit of
 * Mergify's merge-queue draft the caller jobs onboard writes skip
 * (veda-hq/niyam#685): `edited` with no title or base change, so the draft's
 * head and the pull requests it tests are as its last judged run saw them.
 * The draft is known as `mergifyTests` and shared-guard.yml's concurrency
 * group know it: author mergify[bot] with type Bot, head on Mergify's queue
 * branch, head repository the repository itself. A deep stack's title,
 * `stacked on N pull requests ahead`, is left out: its tested pull requests
 * come from the draft's body. Lines of an `if: >-` block, which YAML folds
 * into one.
 */
export const QUEUE_DRAFT_EDIT = [
  "github.event.action == 'edited' && !github.event.changes.title && !github.event.changes.base &&",
  `github.event.pull_request.user.login == '${MERGE_QUEUE_BOT}' && github.event.pull_request.user.type == 'Bot' &&`,
  `startsWith(github.event.pull_request.head.ref, '${MERGE_QUEUE_BRANCH}') &&`,
  'github.event.pull_request.head.repo.full_name == github.repository &&',
  "!contains(github.event.pull_request.title, ' pull requests ahead')",
];

/** Why a caller job skips the edit, for the comment above its `if:`. */
export const QUEUE_DRAFT_COMMENT = "    # Not on an edit of Mergify's queue draft that changes no title or base: its head's runs stand (veda-hq/niyam#685).";

/**
 * A caller job's `if:`, which holds where `QUEUE_DRAFT_EDIT` does not: the
 * comment, then `if: >-` and the expression's lines with `head` before the
 * first and `tail` after the last.
 */
export function skipQueueDraftEdit(head: string, tail: string): string[] {
  const last = QUEUE_DRAFT_EDIT.length - 1;
  const lines = QUEUE_DRAFT_EDIT.map((line, at) => `${at === 0 ? `${head}!(` : ''}${line}${at === last ? `)${tail}` : ''}`);
  return [QUEUE_DRAFT_COMMENT, '    if: >-', ...lines.map((line) => `      ${line}`)];
}
