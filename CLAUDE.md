# Agents in niyam (formerly process-rules)

@node_modules/@veda-hq/sarathi/skills/working-rules/SKILL.md

## Pages

`.claude/settings.json` denies the built-in `Artifact` tool, so sessions here
start without the claude-artifacts tools. Publish, read and answer the page
an ask to the owner links with `pnpm exec sarathi page` (its usage is in
`node_modules/@veda-hq/sarathi/README.md`, "Pages").

## Merging

Right after `gh pr create`, turn on auto-merge for every pull request,
`.github/` changes included: `gh pr merge --auto --squash` (in the Claude app,
the pull request tools' auto-merge does the same). The `main` ruleset holds the
merge until every required check passes, Guard, Cubic's review, PR identity
and Work rules included, and every review thread is resolved. A change to the
guard itself passes Guard only when its approved slice names the file under
`**Guards:**`, unless Guard exempts it as a mechanical pin move (#578).
`.github/CODEOWNERS` names Alok as the owner of the guard's files, and Guard
holds the change: the ruleset does not require code-owner review, so GitHub
only requests his (#604). Nothing waits for a person's review.

Leave auto-merge off only for a pull request that needs Alok's yes for a
reason no check sees: a new dependency, vendored third-party code, or a major
release. Say why in it. Merging a version bump releases it; no other merge
publishes anything.
