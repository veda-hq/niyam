import { API, publicRead, rateLimited } from './agent.ts';
import { PRODUCT } from './names.ts';
import type { HttpResult, Sys } from './types.ts';

/** How long GitHub gets to compare a release tag with main. */
const COMPARE_MS = 15_000;

/** The branch every release is cut from (P-61). */
export const RELEASE_BRANCH = 'main';

/**
 * Whether release `version`'s tag names a commit on main, asked of GitHub's
 * compare API with no token, as `upgrade` asks for the newest release: the
 * repository is public. Since P-61 only main's Release workflow makes a
 * `v*` tag, but GitHub lets anyone with write access push one, on any
 * commit, so `upgrade` and `onboard` ask before they install or pin a
 * release. Comparing the tag with main gives the tag's commit as the base,
 * and says main is `ahead` of it, or `identical`, exactly when that commit
 * is on main. Both refs are written in full, so a branch named like the
 * tag, or a tag named main, is never the one compared. Anything else is a
 * refusal: a tag off main, no such tag, or no answer, each with its own
 * words, so nothing is installed for want of one. `onboard` asks with the
 * agent's token, so the compare does not share the 60 an hour this address
 * has with no token (#546); a rate limit run out is named as one.
 */
export async function tagOnMain(sys: Sys, version: string, token?: string): Promise<{ sha: string } | { problem: string }> {
  const tag = `v${version}`;
  let read: { answer: HttpResult; token: string | undefined };
  try {
    read = await publicRead(sys, `${API}/repos/${PRODUCT}/compare/refs/tags/${tag}...refs/heads/${RELEASE_BRANCH}?per_page=1`, token, { timeoutMs: COMPARE_MS });
  } catch (error) {
    return { problem: `GitHub could not be asked whether the ${tag} tag is on ${RELEASE_BRANCH} (${error instanceof Error ? error.message : String(error)})` };
  }
  const { answer } = read;
  if (answer.status === 404) return { problem: `${PRODUCT} has no ${tag} tag that GitHub can compare with ${RELEASE_BRANCH}` };
  const limited = rateLimited(answer, read.token);
  if (limited) return { problem: `GitHub could not say whether the ${tag} tag is on ${RELEASE_BRANCH}: ${limited}` };
  if (answer.status !== 200) return { problem: `GitHub answered HTTP ${answer.status} when asked whether the ${tag} tag is on ${RELEASE_BRANCH}` };
  const json = answer.json as { status?: unknown; base_commit?: { sha?: unknown } } | null;
  const sha = typeof json?.base_commit?.sha === 'string' && /^[0-9a-f]{40}$/.test(json.base_commit.sha) ? json.base_commit.sha : undefined;
  if (sha === undefined) return { problem: `GitHub's comparison of the ${tag} tag with ${RELEASE_BRANCH} names no commit for the tag` };
  if (json?.status === 'ahead' || json?.status === 'identical') return { sha };
  return { problem: `the ${tag} tag is on commit ${sha.slice(0, 12)}, which is not on ${PRODUCT}'s ${RELEASE_BRANCH} (GitHub's comparison: ${JSON.stringify(json?.status ?? null)}); a release comes only from ${RELEASE_BRANCH}, so this tag is not one` };
}
