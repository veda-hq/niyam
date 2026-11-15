# Agents in niyam (formerly process-rules)

## Merging

Right after `gh pr create`, turn on auto-merge for every pull request,
`.github/` changes included: `gh pr merge --auto --squash` (in the Claude app,
the pull request tools' auto-merge does the same). The `main` ruleset holds the
merge until every required check passes, Guard, Cubic's review, PR identity
and Work rules included, and every review thread is resolved. CODEOWNERS
holds a change to the guard itself for Alok. Nothing else waits for a person.

Leave auto-merge off only for a pull request that needs Alok's yes for a
reason no check sees: a new dependency, vendored third-party code, or a major
release. Say why in it. Merging a version bump releases it; no other merge
publishes anything.
