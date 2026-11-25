# Decisions

- **2026-10-30 — Record: an independent product.** The owner, in chat:
  "Please make sure that process-rules is an independent product and [the
  first client] is its first client about which the product shouldn't know.
  If you need to re-slice then re-slice." The product is built and released
  here and proven against a sandbox client; clients adopt a released version
  and track their own adoption. Code, tests and docs here name no client,
  this record included.
- **2026-10-30 — Record: machine setup is per agent account.** A first
  `machine` run asked for a token limited to one client repository and made
  its test commit there; the token then waited on an organisation owner's
  approval that the instructions only hinted at. Whether the agent can push,
  and the Verified test commit, depend on the client, so they move to
  `onboard`; `machine` sets up the agent account alone (P-02, P-04).
- **2026-10-30 — Record: the agent account uses one classic token.** The
  owner, in chat: "Yes, classic token". A fine-grained token waits on each
  organisation owner's approval, reaches no repository where the agent is
  only an outside collaborator, takes one token per organisation, and, when
  an organisation owns it, cannot register the agent's signing key. A
  classic token with `repo`, `workflow`, `read:org`, `project` and
  `write:ssh_signing_key` reaches every repository the agent is invited to.
  What a leak could reach is bounded by inviting the dedicated agent account
  to client repositories only, and by an expiry: `machine` refuses a token
  that never expires and recommends 90 days, and `doctor` warns 14 days
  before it ends. `machine` also refuses a fine-grained token or missing
  scopes; `onboard` names an organisation that requires SAML authorisation
  or blocks classic tokens (P-02, P-04).
- **2026-10-31 — Record: staged adoption, P-12.** The owner, in chat: "Yes,
  add P-12 first". The first client adopts one feature at a time, and
  `onboard` turned every feature on at once: its work rules would refuse
  every agent push and pull request before the client's work lives in
  issues. So a client's settings list the features it has turned on,
  `onboard` sets up only those and adds one more on request, the shared
  checks and the pre-push hook skip features that are off, and the
  Project's title is a setting. Settings that list no features keep every
  feature on, as before. Added to roadmap v1 as P-12, after P-11.
- **2026-10-31 — Record: P-13, onboard works out the accounts.** The owner,
  asked whether a third party should be able to run plain `process-rules
  onboard`: "Yes." `onboard` suggests the owner from the `gh` login and the
  agent from the accounts `machine` set up on the Mac, for the owner to
  confirm, and adds its hook to `.claude/settings.json` without rewriting the
  rest of the file.
- **2026-10-31 — Record: P-14, process-rules adopts itself.** The owner: "Yes,
  add P-14". The product's own work moves from these files to issues and a
  Project, and agent sessions on it work as the agent account, so the product
  is built under its own rules before its first client moves its work.
- **2026-10-31 — Record: the roadmap moves to issues, P-14.** The owner, on
  P-14: "Yes, add P-14". Onboarding process-rules with `work-rules` means an
  agent pull request here names a Slice issue under a Work item the owner
  approved, so the roadmap became the Work item #22 "process-rules roadmap
  v1", with one Slice sub-issue per row (#23 to #36), on the Project
  "process-rules work". The issues are the source of truth from then on;
  `docs/roadmap.md` keeps v1 as approved and links each row to its issue.
  The shipped slices were closed as completed, each citing its pull request.
- **2026-10-31 — Record: P-15, the adoption gaps closed.** The owner, on the
  Work item #22: "Decision: add #40 (P-15) to roadmap v1." process-rules hit
  three gaps adopting itself: `onboard` stopped when the agent could already
  read the repo instead of offering the grant; pre-push refused a push that
  brought only a merge of the default branch; and the pull request that first
  commits the settings failed its own PR checks. The slice #40 closes them.
- **2026-10-31 — Record: P-16, onboard makes the Project views.** The owner
  approved the slice, and on the Work item #22: "Decision: add #44 (P-16),
  #45 (P-17) and #46 (P-18) to roadmap v1." `onboard` printed that GitHub's API cannot make Project views;
  its GraphQL API now creates and updates them, with a layout, a filter and
  the visible fields. So `onboard` makes the five views, renaming the default
  one, and prints only what the API still cannot set: grouping, the Board's
  column field and the auto-archive workflow, which it can only read or
  delete.
- **2026-10-31 — Record: P-17, agent sessions fail closed.** The owner, on
  the Work item #22: "Decision: add #44 (P-16), #45 (P-17) and #46 (P-18) to
  roadmap v1." The first client
  found agent sessions reaching GitHub as the owner when session-start left
  no trace or its variables never reached the session's shells. Claude Code
  hooks other than SessionStart cannot see the variables it writes to
  `CLAUDE_ENV_FILE`, so nothing can check them before a command; three
  layers instead. The client's `.claude/settings.json` holds the lock in
  `env`, which Claude Code gives every session before any hook runs, so a
  session nothing set up reaches GitHub as nobody; a cloud session's
  SessionStart hook unsets it, as cloud sessions reach GitHub as the account
  connected to them. A PreToolUse guard refuses
  `gh` and git's remote commands unless session-start recorded, for that
  session id, that it gave the agent identity, repeating why it did not; a
  session whose shells lost the variables after it recorded success still
  has the lock. And the hooks run a launcher `machine` writes, naming node by
  its real path, since a version manager's per-shell node may be missing
  from the app's hook environment. The guard matches commands by their text,
  so it misses what a script runs; the lock and the pre-push hook cover that.
- **2026-10-31 — Record: P-18, the owner's SSH route.** The owner, on the
  Work item #22: "Decision: add #44 (P-16), #45 (P-17) and #46 (P-18) to
  roadmap v1." After `machine` signed `gh` out of the owner, git still
  reached GitHub as the owner over SSH, with the owner's key from the SSH
  agent. `machine` and `doctor` name the account SSH reaches GitHub as, but
  removing that route is out of scope: the key is the owner's own way to
  GitHub, used outside agent sessions, and an agent session runs as the same
  macOS user, so nothing on the Mac tells its `ssh` from the owner's. The
  route is covered where agents act instead. The lock, in every session's
  `env` since P-17, sends GitHub's SSH remotes over HTTPS and refuses SSH,
  and the pre-push hook, now written for every adopter, refuses an agent
  session's push over SSH, or over HTTPS as anyone but the agent. It knows an
  agent session by `CLAUDECODE`, which Claude Code sets in every shell it
  runs, so it holds where the hooks never ran. What remains is a session that
  works around the lock and the hook on purpose; only a separate macOS user
  for agent sessions would close that.
- **2026-10-31 — Record: P-19, onboard copies a template Project.** The
  owner, on the views P-16 could not finish through the API: "I need an
  onboarding process where the repo owner has to do absolute minimum which in
  my opinion is running a command and giving owner and agent account. Rest
  all should be taken care by product itself." And on the Work item #22:
  "Decision: add #66 (P-19) and #67 (P-20) to roadmap v1." GitHub's API
  cannot group a view or make a workflow, but it copies a Project with its
  views, grouping, fields and workflows. So the product keeps one public
  Project, set up once by its owner, and `onboard` copies it into each
  client; a Project made before it is offered a move to a copy. It is a
  plain public Project, not one marked as a template: marking it turned its
  workflows off, and copies kept them off.
- **2026-10-31 — Record: P-20, the owner approves with a reaction.** The
  owner, on the Work item #22: "Decision: add #66 (P-19) and #67 (P-20) to
  roadmap v1." Typing a `Decision:` comment was the only way to approve a
  slice added after its work item's approval, or a State dropped after it.
  Now the agent runs `process-rules propose <issue>`, which posts a
  `Proposal:` comment as the agent, mentioning the owner, and labels the
  slice `needs-owner`; the owner's 👍 on it counts as a `Decision:` does.
  The choices: proposals go on the slice, for a dropped State too, because
  the Needs you view shows open issues only and a dropped State is closed;
  a proposal approves the issue its first line names first (`#N`), so a 👍
  on a state's proposal cannot approve the slice's addition; GraphQL gives
  each reaction's user and time, so a 👍 counts only after the slice's latest
  addition, as a `Decision:` does, and only after the proposal's last edit,
  so the agent cannot change what was approved; and reactions are read only
  for proposals that could still settle something, so a check costs no more
  when nothing is owed. `propose` refuses to post unless the session's token
  is the agent's, since only the agent's proposals count, and takes
  `needs-owner` off once nothing waits. A reaction triggers no workflow, so
  the pull request's Work rules check sees a 👍 made after it ran only when
  it runs again.
- **2026-10-31 — Record: P-22, cloud sessions work as the agent.** The
  owner, in chat: cloud sessions are "needed": claude.ai's GitHub
  connection for agent sessions is the agent account, the environment's
  setup script installs the CLI, and session-start checks the account
  GitHub sees is the agent, printing STOP otherwise. This replaces the
  2026-10-31 rule above (P-17) that a cloud session's hook unsets the lock: now it
  lifts it only for the agent. Claude's GitHub proxy refuses GraphQL
  (whatever the credentials), so the owner chose the more robust of the
  ways through: the work rules read GitHub's REST API alone, on a Mac, in
  a cloud session and in Actions, rather than skipping them before a cloud
  push or refusing cloud pushes. REST names when a comment was last edited
  only as `updated_at`, which a reaction does not move, so a 👍 counts only
  after it. REST pages reactions too, so a proposal with more than 100 👍s
  is read in full. A cloud clone has no pre-push hook, so session-start
  writes it there before lifting the lock. The CLI reaches GitHub through
  `HTTPS_PROXY` when one is set, as gh and git do.
- **2026-11-01 — Record: pull request and push runs are read-only.** A
  review of a client's adoption flagged that the workflow `onboard` wrote
  gave every run `issues: write`, though only the weekly decisions run
  writes to issues; so did upgrading, since `onboard` replaced a client's own
  split with its one job. `onboard` now writes two jobs calling
  `checks.yml`: `process-rules` on pull requests and pushes, with the
  workflow's read-only permissions, and `process-rules-weekly` on the
  schedule and by hand, with `issues: write`. The pull request checks keep
  their names, `process-rules / …`, so required checks need no change.
  Splitting alone was not enough: GitHub refuses a whole run, before any
  job's `if:`, when a called job asks for more than its caller grants, and
  `checks.yml`'s weekly job asked for `issues: write` itself, so a split
  workflow at v0.5.2 or earlier fails to start on every pull request and
  push. From v0.5.4 `checks.yml` sets no workflow-wide permissions, its
  read-only jobs set their own, and its weekly job takes what the calling
  job grants. `onboard` replaces the older single-job template, moves only
  the version pins of a workflow already split (and its push branch, when the
  default branch has changed), and offers to replace any other workflow, as
  before. Released in v0.5.4, a patch release: v0.5.3 was never tagged.
- **2026-11-01 — Record: P-33, onboard warns about a CODEOWNERS naming the
  owner.** The owner, in chat, answered "OK." to: "process-rules release:
  onboard warns about such a CODEOWNERS file and offers the fix. This is the
  product's job, and every client would get it." Once the agent authors the
  pull requests, a CODEOWNERS rule naming the owner makes GitHub ask the
  owner to review every agent pull request, shown as coming from the agent,
  since GitHub never asks a pull request's author. `onboard` reads the file
  GitHub uses (the first of `.github/CODEOWNERS`, `CODEOWNERS` and
  `docs/CODEOWNERS`), says so, and offers to remove the owner's handle from
  those rules and drop a rule left with no owners, whose paths then fall to
  the rules before it; the default is no, and declining leaves the file,
  since a client may want the requests. It asks last, after the test
  commit, so a run stopped earlier and run again still names the file to
  commit. Only the owner's own handle counts: a team the owner belongs to
  is the client's to change, and GitHub's API does not say who a team's
  review would reach without more scopes. `doctor`, in an adopting repo,
  warns about the same rules and changes nothing.
  Reversed on 2026-11-05: onboard keeps CODEOWNERS (below).
- **2026-11-01 — Record: P-34, agent sessions answer review threads
  without asking.** The owner, in chat, when replying to and resolving a
  review thread waited on approval in auto mode: "This shouldn't be a
  question. My work shouldn't wait for this. Please ask the product to fix
  this." The issue asked for permission rules on the replies endpoint and
  the GraphQL review-thread mutations. Claude Code's permission docs call
  rules that constrain a command's arguments fragile, and a `*` in a Bash
  rule matches any text, spaces included, so a rule on `gh api
  repos/*/pulls/*/comments/*/replies *` would also allow a call to any other
  endpoint with that text in a field. So the rule allows one CLI command,
  `process-rules review-thread`, which builds the requests itself and
  refuses unless the session is the agent's and the thread is on a pull
  request the agent opened in the repository here. `onboard` adds the rule
  to `permissions.allow` for every client, as part of identity. Released as
  v0.5.5, a patch release.
- **2026-11-01 — Record: P-23, Figma settings out of the repo.** The
  owner's decision of 2026-10-31 on #53: the design library's key moves out
  of the committed settings into the client's Actions secrets, next to the
  token; `onboard` writes the Figma lines into the workflow only when the
  feature is on; and the feature is renamed `figma`, so another design tool
  would be a feature of its own. The key is a secret (`FIGMA_LIBRARY`), not
  an Actions variable, so a public repository's run logs mask it too, and the
  workflow passes it to the shared checks like `FIGMA_TOKEN`. Older settings
  keep working: `design` is read as `figma` and a committed
  `figma.library` is read when the secret is not set, each with a warning
  in the run; `onboard` renames the one and takes out the other, after
  asking, and prints the `gh secret set` command for the key. In a workflow
  already split into its two jobs, `onboard` sets each job's Figma secrets
  to what `figma` needs and leaves a secrets block holding the client's own
  secrets as it is, saying which job that leaves without FIGMA_LIBRARY.
  Released as v0.5.6, a patch release.
- **2026-11-01 — Record: P-37, onboard sets the FIGMA_LIBRARY secret
  itself.** Since P-23, `onboard` took the Figma library key out of older
  settings and printed `gh secret set FIGMA_LIBRARY …` for the owner to run,
  but the owner stays signed out of `gh` for good (P-35). Decided: `onboard`
  sets the secrets it needs itself, as the owner for one run. With the
  run's one browser approval it reads the repository's Actions public key,
  seals the key as a libsodium sealed box and PUTs the secret through the
  REST API; a value that is not a Figma file key is not stored, and the
  owner is told where in the repository's settings to set the right one.
  The key never appears in onboard's output or in a request in the clear.
  The sealing uses `libsodium-wrappers` (with its `libsodium`), the
  reference implementation of `crypto_box_seal` and the package GitHub's
  own documentation uses: `tweetnacl`, smaller, has no sealed box and no
  BLAKE2b for its nonce and has had no release since 2020, and the
  `@noble` packages would mean assembling the sealed box from primitives
  here. It is loaded only when a secret is set, since the shared checks run
  the CLI from its source with no packages installed. Approval: the
  owner's 👍 on #88. Released in the next 0.5.x patch release.
- **2026-11-01 — Record: P-36, onboard opens its changes as the agent's
  pull request.** `onboard` wrote `.github/process-rules.json`,
  `.claude/settings.json`, the workflow and CODEOWNERS into the owner's
  checkout and left them uncommitted: run on the default branch, as an
  owner naturally does, it blocked the next `git pull --ff-only`, and a run
  that stopped early never said the files needed committing. Decided: the
  owner's checkout is never modified. Each file change is held in memory
  until every step has run; then `onboard` makes a temporary repository
  holding the default branch's tip (its trees only, fetched as the agent
  with `--filter=blob:none`, so a large repository costs little), puts each
  changed file in its index, commits once, signed as the agent, pushes to
  `process-rules/onboard` as the agent (forced, so a run again updates the
  same branch) and opens the agent's pull request, or updates the open one;
  the temporary repository is deleted in a `finally`. A file the default
  branch has otherwise than the checkout is refused, so nothing merged
  since is undone. A run that stops, or changes no file, opens no pull
  request. Steps that are not files (the agent's access, the board) still
  act at once, as the owner for one run (P-35); the pre-push hook, which
  git does not track, is written in place. The work rules pass an agent
  pull request from `process-rules/onboard` in the repository itself that
  changes only the files `onboard` writes: the owner confirmed each change
  at the terminal and merges it. Approval: the owner's 👍 on #82. Released
  in the next 0.5.x patch release.
- **2026-11-01 — Record: P-35, owner commands sign in for one run only.**
  `machine` signs the owner out of `gh` so agent sessions cannot use the
  owner's account, but `onboard` read the owner's stored `gh` login (with
  `project` and `admin:org`) for the board and the agent's access, so the
  owner was told again and again to sign in and out of `gh`. Decided: the
  owner stays signed out of `gh` for good, and no process-rules command,
  message or doc tells the owner to sign in to or out of `gh`. A command
  that needs the owner's GitHub rights runs `gh auth login --web` with the
  scopes its features need into a fresh temporary `GH_CONFIG_DIR` (no
  `GH_TOKEN` or `GITHUB_TOKEN`, plain-text storage there, SSH as the
  protocol with no key so gh does not set up git), reads the token with
  `gh auth token` from that folder, refuses it unless its login is the
  owner's, and deletes the folder in a `finally`. One browser approval per
  run serves every step that acts as the owner; the token is held in
  memory only. GitHub keeps the gh app's authorisation on the owner's
  account, which the owner can revoke under Settings → Applications; no
  token is left on the Mac. Approval: the owner's 👍 on #83. Released as
  v0.5.7, a patch release.
- **2026-11-01 — Record: P-38, PR identity judges the pusher, not the
  run's actor.** In sandbox PR #8 on 2026-10-30, the run on `opened` failed
  the owner's push of an agent commit, and the run started ten seconds
  later by Cubic editing the description passed, "pushed by
  cubic-dev-ai[bot]". #11 moved the check to GitHub's push record
  (`GET /repos/{repo}/activity` on the head branch), but kept the run's
  actor as the pusher of commits not recorded yet on `opened` and
  `synchronize`, so the owner pushing and the agent opening the pull
  request at once still passed. Decided: who pushed comes from the push
  record alone and `GITHUB_ACTOR` is not read. A commit no recorded push
  brought is read again for about a minute, then fails closed until a
  re-run finds it; a push recorded with no actor, and a pull request whose
  head repository is gone, fail too. The record is the head repository's,
  so a fork's pull request reads the fork's; a private fork the run's token
  cannot read fails the check. Merge-queue pushes go to the queue's own
  branches, not the pull request's, so they never count. Approval: the
  owner's 👍 on #91. Released in the next 0.5.x patch release.
- **2026-11-01 — Record: P-27, a declined lockout stays declined.** The
  owner's decision of 2026-10-31 on #57: keep offering the lockout. On a
  team member's laptop or a shared machine, accepting it signs that person
  out of their own GitHub tooling, and declining left `doctor` warning on
  every run. So `machine` records what the owner declined, the `gh` logins
  it named and the saved git password, in the agent's folder beside the
  session file, and `doctor` reports those as a passing line. The record
  names each finding, so an account signed in after the owner declined is
  still a warning; each `machine` run offers again and rewrites the record
  from that run's answers, so accepting clears it. Keys with no passphrase
  and the SSH route are not offered, so they are not recorded. The docs
  present the lockout as optional hardening for a machine that runs agents,
  and a separate macOS user for the agent sessions as the stronger
  alternative.
- **2026-11-01 — Record: P-31, the classic token trade-off documented.**
  The owner's decision of 2026-10-31 on #52: "keep the one classic token
  for now (Athya's organisation allows it)". The README records the
  trade-off for outside adopters: the token's `repo` scope reaches every
  repository the agent account can access, and an organisation or
  enterprise that blocks classic tokens cannot adopt yet. A fine-grained
  token or a GitHub App waits for adoption outside Athya. Docs only; no
  release.
- **2026-11-01 — Record: P-29, the token store behind an interface.** The
  owner's decision of 2026-10-31 on #49: Athya's agents run on macOS
  laptops and in Claude cloud sessions, so keep the macOS keychain, but put
  the token store behind an interface so a Linux or Windows store can be
  added without rework. One `TokenStore` reads and stores the agent's token
  and gives the session file the shell command that reads it on each use;
  the keychain, through `/usr/bin/security`, is its only implementation,
  and `machine`, `doctor`, `session-start` and `onboard` reach the token
  through it. The session file is unchanged, so no machine needs `machine`
  run again. On a platform with no store, `machine` and `doctor` refuse,
  naming macOS, and `session-start` keeps GitHub locked out. The owner
  lockout's checks of the owner's own keychain items stay as they are: they
  are not the agent's token. Other platforms wait for adoption outside
  Athya; the README states macOS as the supported platform.
- **2026-11-01 — Record: P-28, org-wide issue types announced; schedule a
  setting.** The owner's decision of 2026-10-31 on #55. Issue types are an
  organisation-wide setting, so the ones `onboard` adds reach every
  repository in the organisation, not only the one being onboarded. Before
  adding any, `onboard`'s question now says so and names the types it
  would add; it says nothing when they all exist. The weekly decisions
  schedule, fixed at Mondays 06:17 UTC, becomes `"schedule"` in
  `.github/process-rules.json`: a five-field cron in UTC, checked before
  `onboard` changes anything, defaulting to `17 6 * * 1`. `onboard` writes
  it into the workflow's `schedule:`. When `onboard` repins a split
  workflow, it moves the one cron it wrote as it moves the push branch,
  asking first and leaving a schedule the client has made its own (more
  crons, or a comment on the line) alone. Renaming the types, labels, field
  options and markers waits for adoption outside Athya.
- **2026-11-01 — Record: P-24, personal repos refused what they cannot
  run.** The owner's decision of 2026-10-31 on #48: `onboard` and the
  checks refuse `work-rules`, `decisions` and `figma` on a repository a
  personal account owns, saying why: GitHub has issue types for
  organisations only. The work rules need a Slice under a Work item, the
  weekly job and `reviews-due` list issues by type, and the design check
  reads State sub-issues, so none can run there. `onboard` refuses them in
  `--features` and `--add`, and with no `--features` turns on the rest and
  names what it left off; it asks GitHub whether the owner is an
  organisation once per run. The checks that need issue types ask GitHub
  the repository's `owner.type` once per run and, on a personal account's
  repository, pass with the line a feature that is off prints, giving the
  reason, rather than failing every pull request; the weekly job leaves
  vetoes alone there too, since they sit on Decision issues. Labels as a
  substitute for issue types wait for adoption outside Athya.
- **2026-11-01 — Record: P-40, approvals ask only for what needs the
  owner.** The owner approved eight late-added slices on #22 in minutes
  each, none questioned, and asked: "How can we be sure of it so that we
  can use the mechanism properly?" In chat they agreed that a comment on the
  work item counts as approval ("This is OK"), kept chat requests filed with
  a quote and approved once ("But let's keep the following too"), and
  declined a daily batch of proposals ("not appropriate") and a weekly
  approval health check ("no need"). So:
  - **A request on GitHub is its own approval.** A slice added after its
    work item's approval is approved when its body links
    (`…/issues/<work item>#issuecomment-<id>`) a comment the owner wrote on
    that work item before the slice was last added. The work rules match the
    link to the work item's comments as GitHub returns them, so the author,
    the issue and the time are GitHub's, not the link's. A comment edited
    since it was written does not count: REST does not say who edited it,
    and the agent, with write access, can edit another's comment. The
    comment cannot name the slice, which it came before, so which comment
    asked for it is the agent's claim, in the slice's body for the owner
    to see; the owner accepted that check (author, work item, time).
  - **Fixes need no approval, and need no new rule.** A fix restores what
    the owner approved and changes nothing they would see beyond it. It is
    filed as a State under the slice it fixes, and its pull request names
    that slice (`Slice: #N`), closed or not; the slice's own approval
    rules still apply. A State added after approval
    already owes the owner nothing; only a slice added late, or a State
    dropped, does. Anything filed as its own slice, called a fix or not,
    keeps the 👍: whether a change goes beyond what was approved is a
    judgement about what the owner would see, which no code rule can make
    from an issue's text, so the gate is not loosened on a label or a word.
  - **Chat requests keep the 👍.** The agent files the slice quoting the
    owner's words and proposes it; the owner's 👍 approves it once.
  - **Every proposal stands alone.** `propose` writes what changes (the
    slice's "You will see"), why (its "Why"), what it costs (its "Cost",
    else one more slice of the work item for the owner to review) and what
    happens if the owner declines; for a dropped State, why from the
    state's own "Why". It refuses, posting nothing, while a body lacks
    those sections, naming them, so the agent writes them first. The first
    line still names the issue first (`#N`), which the 👍 matching relies
    on, so proposals posted before P-40 still count.
- **2026-11-01 — Record: one GitHub host constant, P-30.** The owner, in
  chat: route every github.com and api.github.com address through one host
  constant, so a host setting is easy to add later; the README documents
  github.com as the only supported host. `src/host.ts` names the host once
  and derives the API, web, SSH and no-reply forms from it; the API base,
  remotes and their HTTPS rewrites, the credential helper, the token and key
  pages, the release download, `gh -h` calls and push-identity's checks all
  use it. What clients already have stays byte for byte the same: the
  settings `env` that `onboard` writes, the session file session-start
  compares, the hook commands and the workflow template. A test fails when
  the host is written out in `src/` outside that module. The shared
  workflow `.github/workflows/checks.yml` names no host: its checkout of
  `athya-hq/process-rules` and the actions it uses (`actions/checkout`,
  `actions/setup-node`) come from whichever host runs the workflow. On
  another host all of them must exist there (for actions, GitHub Connect
  can sync them), or the checkout must name github.com; that is for the
  host setting, which, for GitHub
  Enterprise Server or GHE.com, is not built. GitHub Enterprise Server's
  API is `https://<host>/api/v3`, not `api.<host>`, so the setting also
  changes how the API base is derived.
- **2026-11-01 — Record: owners and agents as lists, P-26.** The owner, on
  #56 (31 Oct 2026, in chat): Athya keeps one owner and one agent for now,
  but the settings become generic: they accept lists of owners and agents,
  the single-string form still read, and every check accepts anyone in the
  list. `loadSettings` reads `"owner"` and `"agent"` as a login or a
  non-empty list of logins and returns lists; it refuses an empty list, a
  non-login, and any account named as both. A login listed twice, in any
  case, counts once. The work rules take a 👍, a `Decision:` comment, a
  request on the work item or the `approved` label from any owner, and
  proposals and pull requests from any agent; PR identity takes a commit
  claiming an agent only when it is Verified as that same agent, and
  pushed by any agent; pre-push, `review-thread`, `propose`, the design,
  decisions and `reviews-due` checks and the doctor's CODEOWNERS check take
  any of the list. The guard reads only what session-start recorded, so it
  needed no change. Where one account must be chosen:
  - **A Mac's sessions work as one agent.** With one agent listed, that
    one, as before. With several, session-start, `machine` and `doctor`
    (without a login named) take the one listed that `machine` set up on
    this Mac, found by its session file. With none of them set up, or more
    than one, session-start keeps GitHub locked out and says which, and
    `machine` and `doctor` ask for the login: two set up on one Mac would
    make the session's identity a guess. A cloud session works as whichever
    listed agent claude.ai's GitHub connection is.
  - **Who to tell is the first owner.** session-start's "tell" and "ask …
    to run machine" lines name the first owner; checks that list who may
    act name the whole list ("A or B"); a proposal mentions every owner.
  - **`onboard` keeps the one-login form.** It writes
    `{ "owner": "…", "agent": "…" }` as before, so existing settings do not
    change. On settings that list several, it works as the owner named,
    else the one the run's browser sign-in is, and the agent named, else
    the one set up here; it refuses a login the lists do not hold, a
    sign-in as anyone they do not hold included, and leaves the lists as
    they are. (At first it took the first owner, so only that owner could
    run plain `onboard`; the sign-in, which `onboard` needs anyway, says
    which owner is at the terminal.) Its CODEOWNERS offer removes every listed owner a rule names.
  Teams as approvers are out of scope.
- **2026-11-01 — Record: moving `gh` to the agent names the owner's two
  steps, P-42.** The owner asked for this in the P-30 session and had the
  coordinator file it. Sessions could not turn on Auto-fix for the agent's
  pull requests: the desktop app checks the PR's author against the account
  of the `gh` token it read, keeps that token until GitHub rejects it, and
  had read the owner's before the Mac's `gh` login moved to the agent. After
  a restart, Auto-fix turned on for an agent pull request with no per-PR
  step. `gh auth logout` also leaves the old token valid on GitHub, and only
  the owner can revoke it there. So when `machine`'s lockout signs an
  account out, it ends with both steps together and records when and which
  accounts beside the session file. `doctor` repeats them while the desktop
  app, as `ps` lists it, started before that time; it cannot see whether the
  token was revoked, so the revoke step goes with the restart step and both
  stop once the app has restarted: a revoke skipped then is not raised
  again. That is accepted, since the agent's token cannot list or check the
  owner's authorised OAuth apps, and asking the owner to confirm would add
  a step to every `doctor` run. A second move before a restart keeps the
  first move's accounts in the record.
- **2026-11-01 — Record: client hooks act on GitHub as the session's agent,
  P-43.** The owner, in chat: "New process-rules roadmap work: let a
  client's hooks act on GitHub as the session's agent." The first client saw
  a PreToolUse hook's `gh api graphql` get "HTTP 401: Bad credentials" while
  `gh` in the same session's shell worked as the agent. Claude Code's hooks
  docs (https://code.claude.com/docs/en/hooks, "Persist environment
  variables") give `CLAUDE_ENV_FILE` to SessionStart, Setup, CwdChanged and
  FileChanged hooks only, as P-17 says, so every other hook keeps the lock
  the settings' `env` gives. P-17 and P-18 stay as they are: the lock still
  reaches every hook, and nothing reaches GitHub as the owner. Instead a
  hook runs its GitHub command through `process-rules as-agent --session
  <session_id> -- <command>`, which runs it only when the session record the
  guard reads names one of the settings' agents. On a Mac the child gets
  `sessionEnv`, the session file's variables, over the hook's environment
  with the lock's removed, and only after the session file is checked as
  session-start checks it; the token is read from the token store as it
  starts and goes only into the child's environment. In a cloud session the
  child gets what session-start's `CLAUDE_ENV_FILE` lines give a shell
  there: the lock unset and the proxy's placeholder token. A cloud
  session's hooks see only the lock's token too: session-start's unset goes
  through `CLAUDE_ENV_FILE` as on a Mac, and the proxy swaps its own
  placeholder, not the lock's (read from the code and the docs; not seen in
  a live cloud session). The choices:
  - **Exit 77 means locked.** sysexits' `EX_NOPERM`. Not 0, 1 or 2, which
    are done, failed and bad usage here, and 2 blocks a tool call in
    Claude Code's hooks; not a code `gh` (1, 2, 4, 8) or git (1, 128, 129)
    exits with, nor the shell's 126, 127 or 128 plus a signal, which the
    child's own exit is reported as. A session id `sessionRecord` would not
    take, and any failure of the check itself, are locked too, since nothing
    ran; a missing `--` or command is bad usage, exit 2.
  - **Pass-through by inherited standard streams.** `Sys.exec`'s
    `interactive` option, already in the interface the fake implements,
    gives the child the hook's standard input, output and error;
    `as-agent` returns the child's code, which the real Sys now reports as
    a shell would for a signal or a command not found.
  - **`doctor` reports hooks that would hit the lock.** It was cheap: it
    reads the hooks in `.claude/settings.json` and
    `.claude/settings.local.json`, skips process-rules' own, and warns about
    each whose command, or the repo script its first word names, reaches
    GitHub by the guard's test outside a line running `as-agent`. Like the
    guard, it reads text, so a script another script runs is missed.
- **2026-11-01 — Record: P-25, the review routine watched.** The owner, on
  #60: "`onboard --add review` creates the scheduled routine itself (through
  Claude's API, if one is usable) and checks it runs as the agent; and the
  weekly job labels `needs-owner` any decision whose review is over a week
  overdue with no `Kept:`/`Settled:` from the agent". The watch is built:
  with `review` on, the weekly job labels and comments on each open decision
  the routine reviews (one an owner or agent wrote and last edited, not
  `veto` or already `needs-owner`) whose `Review:` date is more than seven
  days past with no `Kept:` or `Settled:` from an agent since that date; it
  takes off only a `needs-owner` it added itself (the issue's last such
  label event is the workflow's), once an agent's verdict comes after it,
  so the routine's holds and the owner's vetoes stay. Since `needs-owner`
  would hide the decision from the routine, `reviews-due` still lists one
  the job labeled until the agent comments on it, so a hold is not asked
  again. Only an agent's comments count as verdicts, wherever they are read;
  `reviews-due` read none before. Creating the routine is not built:
  Claude's routines (`/schedule`, the `RemoteTrigger` tool) call claude.ai's
  `/v1/code/triggers` with the Claude Code session's own sign-in, which a
  command such as `onboard` cannot reach, and a routine works as claude.ai's
  GitHub connection, which nothing reports and which the owner has not yet
  switched to the agent (P-22 is unproven in a cloud session). So `onboard`
  prints the steps and the prompt's link, and creating or checking the
  routine waits on P-22's proof.
- **2026-11-01 — Record: P-44, Claude Code is the only supported agent
  runner.** The owner decided on #50 on 2026-10-31: "Athya's agents run in
  Claude Code only. Deferred: the README names Claude Code as the only
  supported agent runner, and this stays open for adoption outside Athya."
  The README never said so; it now does, beside the supported host. The
  identity and the lock reach a session only through Claude Code's
  SessionStart hook and `CLAUDE_ENV_FILE`, so another tool's agent gets
  neither, and only PR identity catches its work after the push. #50 stays
  open.
- **2026-11-05 — Record: P-25, `reviews-due` reads only REST.** The
  routine's first run, in a Claude cloud session, stopped with "cannot read
  who edited the decisions (HTTP 403)": `reviews-due` asked GraphQL for each
  decision's last editor, and the cloud session's GitHub proxy refuses
  GraphQL. REST has no such field: an issue names its author, not who last
  edited its body, and a body edit leaves no event in the issue's events or
  timeline (a title edit leaves `renamed`). Fixed as State #140. The weekly
  job, whose token reads GraphQL, now vets: for each open decision with a
  `Review:` date that an owner or an agent wrote and last edited, it keeps
  one comment of its own naming the body's SHA-256, posted once and edited
  when the hash changes. It hashes the body GraphQL returns with the editor,
  so an edit landing between the job's listing and that read is not vetted
  under the earlier editor. `reviews-due` still checks the author, and lists
  a decision only when the workflow's latest such comment names the hash of
  the body it reads; REST and GraphQL return the same bytes for a body. A
  label the job adds, trusted while the issue's `updated_at` is not later,
  was weighed and dropped: every comment and label moves `updated_at`, the
  routine's own included, so it would wrongly hide decisions, and it cannot
  tell a body edit from a comment. The hash ties the vetting to the text
  itself: someone else's edit changes the hash, so the decision is left out
  until the job sees an owner's or the agent's edit; an edit that puts back
  the vetted text exactly leaves only vetted text. Only the workflow writes
  as `github-actions[bot]`, so a pasted mark counts for nothing; someone
  who can edit the workflow's comment can also change the workflow, so the
  vetting trusts no more than the job already did. A decision written or
  edited since the job's last run waits up to a week for its next one, and
  `reviews-due` names it.
- **2026-11-05 — Record: agent sessions turn Auto-fix on themselves, #142
  of P-42.** The owner saw Auto-fix off on the agent's pull requests and
  asked for it on. #137, #139 and #141 opened with it off although the
  desktop app's `gh` login was the agent's and the app had restarted since
  the login moved. The app turns Auto-fix on for a session's new pull
  request only once its renderer says the owner wants it for that session,
  and the renderer says so only while that session is open on screen; the
  slice sessions a coordinator starts in the background are not, and no
  Code tab setting changes that. So session-start's line for a local agent
  session tells it to turn Auto-fix on with `set_monitor` after each
  `gh pr create`, when the app's `ccd_pr` tools are there and `get_status`
  shows it off. `set_monitor` checks that
  the session opened the pull request and that the app's `gh` login wrote
  it, so a session can do this only for the agent's own pull requests. A
  cloud session has no such switch, and its line is unchanged.
- **2026-11-05 — Record: P-35, onboard names the owner to sign in as and
  why a request failed.** In the sandbox's onboard the sign-in line said
  only "as the owner", and the run then ended with "process-rules onboard:
  fetch failed": Node's message for a request that got no answer, whose
  reason fetch keeps in `cause`, which the CLI dropped. Minutes later the
  same requests answered, so it was most likely a passing network failure,
  but nothing told it apart from a blocked host. Fixed as State #145. The
  sign-in line names the owner, or each owner the settings list while the
  run has not chosen one, and says that `gh`'s lines about saving
  credentials mean the temporary folder deleted before onboard goes on.
  `http` names a request that got no answer by method, host and path, never
  its query, with the cause's code and message. GET, PUT and DELETE are
  tried once more a second later, since repeating one changes nothing more;
  POST and PATCH are not, since a request that reached GitHub before the
  connection broke could then be made twice. One deadline covers both
  tries, and a timeout keeps its own error and is not repeated, so a
  caller's time budget holds. A label's removal counts a 404 as done, since
  a repeated DELETE after one whose answer was lost finds it already off.
- **2026-11-05 — Record: onboard keeps CODEOWNERS, reversing P-33's
  offer.** The owner, in chat: "Don't remove the CODEOWNERS in the
  onboarding." This reverses the 2026-11-01 record for P-33. The owner
  prefers to be asked to review the agent's pull requests, and the repo's
  own rules (its branch protection or rulesets) decide whether that review
  is required, so `onboard` no longer offers to remove the owner from
  CODEOWNERS, `doctor` no longer warns about such a rule, and the
  CODEOWNERS files leave the list of files onboard writes: a pull request
  from onboard's branch that changes one is held to the work rules like any
  other. Fixed with State #153 of P-04.
- **2026-11-05 — Record: P-04, onboard asks once, from one plan.** The
  owner ran onboard in a client and found it too complex: about eight y/N
  questions, each a long sentence, with a browser sign-in in the middle, and
  output they did not read. Its pull request's title, "process-rules
  onboard at v0.5.19", failed that client's commitlint. The owner approved
  the layout this State (#153) builds. `onboard` now works out every change
  first, changing nothing, prints one plan grouped by where each change
  lands (the pull request you merge, GitHub as you, this Mac, the check),
  with short labels and only what changes, and asks once; the long
  explanations move into the pull request's description. `--yes` skips the
  question and `--dry-run` stops at the plan; with no terminal and no
  `--yes` it refuses rather than read an answer from a pipe. The browser
  sign-in comes after the yes, except where only it tells what the plan is
  (which of several owners ran it, or whom to suggest as the owner on a
  first run), which the pull request then says. What the board lacks is
  known only to the owner's token, so the plan says "set up or check", and
  the one yes covers every board step but replacing a Project made before
  the template, which moves its items and closes it: that is left as it is,
  with the template's grouping and auto-archive under "By hand:". `gh`'s
  output during the sign-in is read rather than shown: with it not a
  terminal, `gh` prints the one-time code and link instead of asking for
  Enter, so onboard shows the code and opens the link, drops `gh`'s tips
  and notes about its temporary folder, and shows any other line as `gh`
  wrote it, so an error still reaches the owner. The confirm and spinner
  come from `@clack/prompts`, loaded only by onboard, since the shared
  checks run the CLI from source with no packages installed; colour shows
  only on a terminal that has it, never with `NO_COLOR`. The title and the
  commit read `chore(process-rules): onboard at v<version>`, which
  Conventional Commits accepts. The owner, in chat, also chose that the pull
  request merge itself: "I prefer this for onboard step." So the agent,
  which can push, turns on GitHub's auto-merge for it through GraphQL's
  `enablePullRequestAutoMerge` (REST has no call for it), squashing where
  the repository allows it, else rebasing, else merging; onboard runs in
  the owner's terminal, where GraphQL is reachable. The plan names it in the
  pull request's group, "auto-merge when checks pass", and the run ends
  "<url> merges itself when checks pass". Not turning it on fails nothing:
  where the repository does not allow auto-merge, or GitHub refuses it, as
  it does for a pull request already clean to merge, the run ends "Merge
  <url>" and "By hand:" says why. A setting GitHub does not report is not
  taken as off, so GitHub's own refusal says why then.
- **2026-11-05 — Record: P-02, machine and doctor in onboard's layout.**
  The owner liked onboard's one plan and one question, then ran `machine`,
  which still asked a y/N question per change and ended with long ✓/!
  lines. They asked for `machine` and `doctor` to look the same ("Yes,
  both"). State #156 builds it. `machine` now works out every change first,
  changing nothing, shows one plan (This Mac, GitHub as the agent), and asks
  once, with `--yes` and `--dry-run` as in onboard. With nothing to change it
  asks nothing. The lockout's sign-outs are plan items like the rest, so the
  one yes covers them and a no leaves everything as it was. machine no
  longer declines them one at a time, so it no longer writes
  `lockout-declined.json`. `doctor` still honours a record an older release
  wrote, and `machine` removes it once it locks them away. A stored token
  near its end is replaced on the yes rather than asked about separately.
  The classic token's page and hidden paste stay steps after the yes, since
  only the owner can make the token. What is worth fixing after the run (a
  key with no passphrase, a sign-out that failed, the owner's steps after a
  `gh` move) becomes a `▲` line with its one-line fix; why a stored token is
  replaced shows as a `!` note in the plan's head, as onboard's warnings do. `doctor` stays read-only and asks nothing. It groups its
  checks, marks each ✓, ▲ or ✗ with a fix, and keeps its checks, exit codes
  and the 14-day warning. It now prints them all on standard output as one
  picture. The layout lives in `src/layout.ts`, which all three commands
  share.
- **2026-11-06 — Record: cloud setup shares the Setup field, and says when
  it drifts.** A client's cloud environment held only `cloud-setup`'s
  script in its Setup field, which holds one script, so the repo's own
  setup never ran and sessions came up on the image's Node without the
  repo's tools. The owner then pasted both, with process-rules' install
  wrapped in a shell of its own followed by the repo's own script, which
  ends with `exit 0`; it worked. The field had also installed an older
  release than the repo's workflow pinned, and nothing said so.
  `cloud-setup` now prints its install inside `bash <<'PROCESS_RULES' …
  PROCESS_RULES || echo … >&2`, so its `set -euo pipefail` and a failed
  download stay in that shell and the commands after it run; it, `onboard`
  and the README say to put it first, then the repo's own, because a repo's
  script may end with `exit`. The install's last command reads
  `/dev/null`, as the rest of its script is on standard input. In a cloud
  session `session-start` compares the installed CLI with the one version
  `.github/workflows/process-rules.yml` pins and, when they differ, says so
  in a second line naming the fix: print `cloud-setup` again from that
  version and paste it over the process-rules part. It only warns: the
  agent check, the record for the guard and the exit code are unchanged,
  and a missing or unreadable workflow, or one pinning no single version,
  says nothing, as `onboard` and `doctor` own the workflow itself.
- **2026-11-06 — Record: Figma frames are for Experience work only.** A
  client's design check refused a Process slice because one of its States, a
  step of process work with nothing to draw, linked no Figma frame. The
  client's Work items name their kind in a `**Kind:** <Kind>.` line
  (Experience, Process and others). The design check now reads the slice's
  parent Work item with its States, in the same GraphQL query, and a kind
  other than Experience passes the slice with one `✓` line and no Figma
  call. Experience work, a Work item that names no kind, a slice with no
  parent and one whose parent is not a Work item are checked as before, so
  the check fails closed where no kind is named. The line is read bold or
  plain and case-blind; the Decision parser in `src/decisions.ts` reads only
  the plain `Kind:` form and the whole line, so the design check keeps its
  own reader.
- **2026-11-06 — Record: onboard sets up cloud sessions, with one paste
  (State #165 of P-22).** The owner asked whether `onboard` should set up
  cloud sessions too: every release meant pasting `cloud-setup`'s output
  again, as it named a version, and a client's Setup field had stayed at
  0.5.19 while its workflow pinned 0.5.20. Claude Code has no API, CLI or
  repo file for a cloud environment's Setup script (its cloud environments
  docs: it is edited in claude.ai's environment dialog alone), so `onboard`
  cannot write the field. Instead the version moves into a file the repo
  owns: `onboard` writes `.github/process-rules/cloud-setup.sh` at the
  version the workflow pins, on every run, with the CLI's download checked
  against the sha256 GitHub records for the release archive, as Node's
  already is; and `cloud-setup` prints a snippet naming no version, which
  runs that file from the clone, so the field is pasted once. A client's
  own cloud work found the Setup script runs as root once the repo is
  cloned, from the VM's home, with the clone one folder down; the snippet
  looks there, in the clone and in each home. The docs say Claude keeps a
  snapshot of the environment and builds it again only when the Setup
  script changes or after about a week, so a stable paste alone would
  leave sessions on the old CLI after a pin bump: a cloud session's
  `session-start` runs the repo's file itself when its CLI is another
  release, and says so. Each release unpacks into a folder of its own, so
  the CLI that runs the install is not deleted under it. The snippet marks
  its run in `/opt/process-rules/from-setup`; without the mark, the field
  still holds an older paste, and the line asks for the one paste. Its
  warnings now say to run `onboard` again, not to paste again. The onboard
  pull request's work-rules pass, for the files onboard writes, covers the
  new file. Rejected: a SessionStart hook alone (the docs keep tool
  installs in the Setup script, which the snapshot caches), and a stamp
  that asks for a re-paste (what a client built for itself, which still
  needs the owner after each release).
- **2026-11-06 — Record: onboard keeps refusing a Mac `machine` has not
  set up.** Asked whether `onboard` should offer the `machine` step in its
  own plan instead. It should not: `machine` asks for the agent's classic
  token, pasted hidden, from a token page the owner opens signed in as the
  agent, then makes the agent's signing key and registers it, and asks its
  own questions about the owner's `gh` logins and git password; `onboard
  --yes`, or a run with no terminal, can answer none of these, and its one
  plan holds one yes. `machine` works once per Mac and agent account and
  needs no client repo (2026-10-30), while `onboard` is per repo. Both stay
  the owner's: `onboard` refuses in an agent session, and only the owner
  holds the token and the key. So `onboard` refuses as before, and now
  names what is missing (no token stored, the token's problem, or the
  key's), then the `machine` command to run.
- **2026-11-07 — Record: onboard's pull request fits gitmoji titles and a
  Mergify queue.** The owner ran `onboard` in a client whose pull request
  titles must lead with a gitmoji and which merges through Mergify. Its
  pull request, `chore(process-rules): onboard at v0.5.24`, failed that
  repo's title check and was renamed by hand, as earlier onboard pull
  requests there were; and the run told the owner to turn on GitHub's
  auto-merge, which the repo keeps off because Mergify's queue merges
  instead (it merged that pull request by itself). Now, before it commits,
  `onboard` reads the default branch's latest 20 commit subjects as the
  agent. Where most of them (merge commits aside) lead with an emoji or a
  gitmoji shortcode, the title and the commit do too: the one an earlier
  onboard commit had, else the one the repo puts most on `chore`, else
  `🔧` (`:wrench:` where shortcodes are the style). The rest of the title
  stays Conventional Commits. Where the default branch's Mergify
  configuration, read as the agent from GitHub (a checkout may be behind)
  and the first of `.mergify.yml`, `.mergify/config.yml` and
  `.github/mergify.yml` it has, as Mergify reads only that one, has a
  queue rule and queues pull requests by itself (a pull request rule whose
  actions hold `queue`, or merge protections' `auto_merge_conditions`,
  either asking for no label; the queue rules' `autoqueue`, which Mergify
  replaced with `auto_merge_conditions`, does not count), the plan says
  "merge queue Mergify, when checks pass", GitHub's auto-merge is neither
  turned on nor asked for (it could merge around the queue), and the run
  ends "<url> the merge queue merges it when checks pass". Rejected: a
  setting in `process-rules.json` for the title's emoji (the repo's history
  already says it, and a setting is one more thing to keep in step), and
  reading the repo's title-check workflow (each repo writes its own). The
  configuration is parsed with the `yaml` package, which onboard alone
  loads, as it does `@clack/prompts`; a line scan missed YAML's other
  forms.
- **2026-11-07 — Record: doctor checks a Claude cloud session (State #171
  of P-22).** A cloud session ran `process-rules doctor` to check its
  environment and got only "process-rules supports macOS only", exit 1,
  while every other cloud check passed; the owner asked for doctor to be
  useful there. Where `CLAUDE_CODE_REMOTE=true`, the test session-start and
  `as-agent` use, doctor now runs cloud checks before it looks for a token
  store, in the same grouped layout, fixes and exit codes: the release the
  cloud setup file's opening comment names against the workflow's pin
  (`✗`, run `onboard` again, as session-start's drift line says), the running CLI against that release
  (`▲`: session-start installs the repo's release itself when they differ,
  so a drifted CLI here means that install failed), the Setup snippet's
  `/opt/process-rules/from-setup` mark (`▲`, paste the snippet once), the
  account the proxy acts as among the settings' agents and the
  `PROCESS_RULES_AGENT` session-start exports when it lifts the lock, which
  must be that same account (`✗` each: GitHub is locked out or someone
  else's), and the repo's hooks as on
  a Mac. The pin and the file are read by one function session-start's
  drift check shares. Doctor installs nothing, as it only reads; the fix
  for a drifted CLI names `bash .github/process-rules/cloud-setup.sh`.
  Rejected: a Linux token store (a cloud session has no token of its own,
  only the proxy's), and lifting the refusal on every Linux (outside a cloud
  session nothing holds the agent's token, so the refusal stands).
- **2026-11-08 — Record: an ask reaches the owner as a page, and the Needs
  you list keeps itself (State #176 of P-40).** The owner approved athya_mono's
  0156 S-2 (athya_mono#3301, decision 3) to be built here: since 24 Oct, 41 of
  43 `Proposal:` comments there linked no page. The guard, which already sees
  every `gh` command, reads the comment bodies `gh` posts (inline, heredoc,
  `$(cat file)`, `--body-file`, `gh api` fields and `--input`) with a small
  shell reader, and refuses an ask over 500 characters or without a
  claude.ai artifact link. A body it cannot read in full is judged by what it
  spells out, so a variable in an ordinary comment still passes; only an ask,
  or a body that opens with the unknown part, is refused. `propose` is left
  alone: it posts through the API. The label job is a fourth client job,
  started only by comments that contain an opening word, the `approved`
  label and an hourly cron (`41 * * * *`), so other comments run nothing; the
  weekly job and the shared decisions job skip that cron. The sweep reads
  only 👍 and `Decision:` after the latest agent ask, leaving issues with no
  agent ask (undo issues) alone. Rejected: a separate client workflow file
  (onboard would track two files), and refusing every body with a variable
  (it would block routine comments).
- **2026-11-08 — Record: an edited `Decision:` counts only if owners made
  every edit (State #185 of P-40).** The owner approved this in a client's
  spec: a `Decision:` counts only if the owner made every edit. Repo writers,
  agents included, can edit anyone's comment, and the work rules and the
  Needs you sweep read only who wrote one. GitHub's GraphQL
  `userContentEdits` lists every revision, the comment as written included,
  each with its editor; public repositories show a bot's comment edited by
  two maintainers in turn, each named. So both read it, for an owner's edited
  `Decision:` alone: an unedited one settles as before, through REST, and the
  work rules ask GraphQL nothing when an unedited decision or a request
  settles the slice. An edit by a deleted account, an edit past the first
  100, or a comment GraphQL cannot find makes it not count. The work rules
  read REST, and GraphQL only for an edited `Decision:`, so a Claude cloud
  session's proxy, which refuses GraphQL, can still run them; there an
  edited `Decision:` does not count and the refusal says why, as an edited
  request already does not. Rejected: never counting
  an edited `Decision:` (the owner's own corrections would stop counting) and
  trusting the last editor alone (an agent's edit followed by the owner's
  would hide the agent's).
- **2026-11-08 — Record: one comment on the Approvals issue answers a batch
  (State #191 of P-40).** The owner approved this in a client's spec
  (decisions 1 to 3): after answering 18 asks across 11 Work items one at a
  time, one comment should answer them all. Settings may name a standing
  Approvals issue (`"approvals": N`); an owner's comment there whose first
  line opens `Decision: approve` approves each `#N` on that line, and
  nothing below it, so a reason such as `Not #44 yet` approves nothing. The
  work rules take it for a slice added after approval (made after the
  addition) and for a dropped State (made after the drop); the Needs you job
  takes `needs-owner` off each named issue at once, and its sweep counts it
  after an issue's latest ask. The edit rule of State #185 holds for it.
  Only the one issue counts, so the readers read one more list, once a
  check or sweep. Rejected: each batch's own ask issue (every proposal would
  have to name it, and the readers follow that link), counting a number
  anywhere in the comment (a reason naming an item would approve it), and
  teaching the Needs you job alone (the push check would still want one
  comment per Work item).
- **2026-11-08 — Record: the checks run their own commit's CLI (State #195
  of P-11).** Each client job pins the release twice, `checks.yml@vX` and
  `process-rules-ref: vX`, and Dependabot and Renovate move a reusable
  workflow's `uses:` line alone: Dependabot's #168 moved this repository's
  three `uses:` lines to v0.5.24 and left `process-rules-ref` at v0.5.19, so
  v0.5.24's checks would have run the v0.5.19 CLI, every check green. A
  called workflow can now read its own commit: GitHub's `job.workflow_sha`
  and `job.workflow_repository`, which GitHub's docs use to check out a
  reusable workflow's own source and its own `github/gh-aw` uses. So every
  job of `checks.yml` checks the CLI out there, falling back to
  `process-rules-ref` where GitHub gives no `job.workflow_sha`: GitHub
  Enterprise Server, which has neither, or, should it ever be empty there,
  github.com, where Settings then warns that it cannot compare the two;
  and Settings, which runs on every event, fails a run whose
  `process-rules-ref` names another release (by version, or by commit for a
  commit pin), naming the client's file and the fix. A bot's bump is still
  never a whole upgrade: it misses the cloud setup file's pin and any job a
  newer release adds (this repository's v0.5.19 file had no needs-owner job),
  so the upgrade stays `onboard`, its Dependabot here ignores
  `athya-hq/process-rules`, and the README tells clients to do the same.
  actionlint 1.7.12 does not know `job.workflow_*` yet
  (rhysd/actionlint#707), so `.github/actionlint.yaml` ignores that one
  error in `checks.yml`. Rejected: one pin per job, the `process-rules-ref`
  line dropped (every client file onboard repins counts two per job, so it
  is its own onboard change, once clients run a release with this check);
  passing a mismatch with a warning (no one reads a green run's warnings);
  and only `doctor`, whose cloud checks already show ▲ for a workflow that
  pins several versions but which runs in a session, not on the bot's pull
  request.
- **2026-11-08 — Record: P-46, `process-rules upgrade` updates the CLI in
  one step (#192).** The owner, in chat: "Shouldn't it be simple like
  `process-rules upgrade`?" Updating meant copying the README's `pnpm add -g`
  line for the right version; the owner's second Mac kept v0.5.20 for days,
  and an `onboard` run from it overwrote an athya_mono pull request's newer
  pin. Decided: `upgrade` reads GitHub's public `releases/latest` with no
  token (the repository is public, as the install line already relies on),
  installs a newer release with that same `pnpm add -g`, never an older one,
  and then walks `PATH` as `type -a` does, exiting 1 while another copy is
  there or the first is not the new release, since a stray older copy is how
  the old release kept running. `doctor` on a Mac gains the same two checks;
  `onboard`'s refusal of a newer pin names `upgrade`. It may run in an agent
  session on a Mac: it needs no credential, never signs in, only moves
  forward to a release the Release workflow published from `main`, and does
  what the owner would do by hand, so an agent finishing a release can
  update the Mac without an owner step; the guard still governs `gh` and git
  around it. It refuses in a Claude cloud session, where the CLI comes from
  the repo's `cloud-setup.sh` at the workflow's pin, not from pnpm. GitHub's
  "latest" is the newest release by date, which is the highest version while
  releases are tagged in order from `main`. Rejected: comparing against the
  repo's pin instead of the newest release (a Mac would stay behind until a
  repo moved), and warning about stray copies without failing (the owner
  would miss it, as before).
- **2026-11-09 — Record: Needs you judges each proposal on an issue (State
  #205 of P-40, from #203).** `propose` posts one `Proposal:` per decision a slice owes
  (its late addition, each dropped State), and the batch line names each by
  its own number, as the work rules read them; the Needs you job judged only
  an issue's latest ask, and its comment event took `needs-owner` off
  whatever numbers a batch named. So a batch naming a dropped State cleared
  nothing, and one naming the slice cleared it while the State's proposal
  still waited. The sweep, and now the comment event on Approvals, judge
  each agent `Proposal:` on its own, for the first `#N` of its first line
  (this repository's, HTML entities not counting, as `approvedIn` reads
  them; the issue itself when it names none): a `Decision:` after it, a 👍
  after its last edit, or a batch naming its number after it. The label
  comes off only when every one is answered. A `Needs you:` keeps the old
  rule: owed when it is the latest ask. The comment event cannot map a
  State's number to its slice from the batch alone, so it runs the sweep,
  counting the comment it brings though the list may not show it yet; an
  issue no agent asked on still comes off when the batch names it.
  Rejected: matching only the latest proposal's number (#202, reverted:
  it cleared a slice while another proposal there waited).
- **2026-11-09 — Record: Needs you counts a re-added slice's answers after
  its re-addition (State #207 of P-40).** The work rules count the owner's
  say on a slice's addition only after its latest addition; `propose` posts
  no new proposal when one exists, so a slice taken out and added again
  keeps its old one. The sweep counted a 👍 on it from before the
  re-addition and took `needs-owner` off while the work rules still owed
  the decision (Cubic, on #206). Now a proposal for the issue itself counts
  a `Decision:`, a 👍 or a batch answer only after the issue's latest
  `parent_issue_added` event in its own timeline, read only when such a
  proposal waits, none where GitHub cannot find it. A State's drop and a
  `Needs you:` keep their own times. The work rules also count the work
  item's `sub_issue_added` events that name no issue (a private
  repository's workflow token reads them so); the sweep reads only the
  slice's own events, which that token reads in full. Rejected: running the
  work rules' reader on each labelled slice (a dozen reads more a slice an
  hour, and its problems, such as an unapproved work item, are not the
  owner's answer).
- **2026-11-09 — Record: doctor names only hooks that really miss
  `as-agent` (State #211 of P-43).** After the owner rotated the agent's
  token, `doctor` in the first client passed every Mac and GitHub check but
  warned about two hooks that do not hit the lock on a Mac: one runs `gh`
  only through a Python helper whose `wrap` runs `as-agent` (doctor matched
  a variable named `gh` and messages naming `git push`), and one exits
  outside the cloud before it fetches. A warning that never goes away is
  skipped, so a real one would be too. `hooksHittingLock` now takes a script
  that imports a repo Python module running `as-agent` as routed, finding
  the module with `git ls-files` under any folder, since a hook sets its own
  `sys.path` (`from a import b` may be `a.py` or `a/b.py`), still judging
  the hook's own command; and, outside a cloud session, reads a script only
  up to a column-0 line that exits unless `CLAUDE_CODE_REMOTE` is `true`,
  when only lines that open no block (`set`, `export`, `.`, assignments, not
  continued) come before it. That cut is sound for bash: such a line always
  runs, nothing after a top-level exit runs, and a function must be defined
  before it is called. In a cloud session the whole script
  is judged, as before, since that is where it runs. Rejected: dropping
  string literals (a command handed to code as a string is still a call);
  a marker comment that silences a hook (it asserts instead of reading);
  following `in_cloud`-style functions into sourced files (the client moves
  the guard to the top instead).
- **2026-11-09 — Decision: release numbering.** The owner set it in chat:
  each release bumps the patch number up to 20 (0.6.0, 0.6.1, … 0.6.20),
  and the release after x.y.20 is x.(y+1).0, so 0.6.20 is followed by 0.7.0.
  The major number moves only when the owner says so. 0.6.0 starts the rule,
  with the code of 0.5.38. This replaces the rule of 2026-10-31, "0.5.x patch
  releases only", which came after sessions bumped the minor number four
  times in a day. Recording it here rather than only in agent memory means
  every session reads it with the code. Slice pull requests still never bump
  the version: one release pull request per batch does, and its tag must
  match `package.json`.
- **2026-11-09 — Record: `git remote` reaches GitHub only where it contacts
  the remote (State #219 of P-17).** `reachesGitHub`, shared by the guard and
  `doctor`, counted every `git remote` as reaching GitHub, so `doctor` named a
  hook running `git remote get-url origin`, which reads `.git/config` only,
  and the guard refused it in sessions not working as the agent. The owner
  asked for it fixed. Now only `update`, `prune`, `show`, `add -f`/`--fetch`
  and `set-head -a`/`--auto` count. P-17 is unchanged: every command that
  contacts a remote still runs only as the agent; what the guard now lets
  through contacts nothing. `show -n`, and `add` whose last fetch flag is
  `--no-fetch`, do not count either (review). Rejected: a doctor-only list
  (the guard and doctor would disagree on what reaches GitHub).
- **2026-11-10 — Record: a merged pull request closes the State it names
  (State #224 of P-07).** Five States stayed open after the pull requests
  that delivered them merged: #176 (#177), #171 (#172), #161 (#162), #198
  (#199) and #195 (#196), each shown in the owner's Needs you view until the
  coordinator closed it by hand. Each was a fix filed, as the README says, as
  a State under a slice closed already; each pull request named the slice
  with `Slice: #N` and the State only in prose ("Builds State #176 of
  P-40"), so the merged job commented on the closed slice and nothing named
  the State. Now a pull request names each State it delivers with a line
  `State: #N`, and the merged job closes each one under a slice it names as
  completed, with the slice's "Built in #PR" comment. The work rules refuse a
  `State:` line naming anything but a State under the slice, and an agent
  pull request for a closed slice that names no open State of it, so a fix
  cannot merge with its State unnamed. That is a new refusal on every
  adopting repository's agent pull requests for closed slices; the README
  already filed every fix as a State, so it asks for one line more. Only the
  pull request's description carries `State:` lines: pre-push reads commit
  trailers for the slice alone. Rejected: closing every open State of the
  named slice on merge (a slice often has States not built yet, filed ahead,
  and one pull request delivers one); reading States from prose (the five
  wrote it five ways); relying on "Closes #N" (nothing checks it is there,
  and it closes any issue, not only a State of the slice).
- **2026-11-10 — Record: process-rules becomes niyam (P-49).** The owner
  chose the name niyam (नियम, rule) on 2026-11-03 and said go on 2026-11-10;
  athya_mono's approved 0114 spec v5 holds it as W-39
  (athya-hq/athya_mono#3210): the repository moves to veda-hq/niyam and the
  package is `@veda-hq/niyam`. The owner approved the plan
  (https://claude.ai/artifact/HEQyFtZsxHKDLrt6GqQtEq) with a 👍 on #226, on
  #227 (P-50, which changes what P-17's lock reads) and on W-39. What people
  see is renamed: the package, the bin `niyam` with `process-rules` kept as a
  second bin (typed by the owner, it names `niyam`; hooks stay quiet), the
  messages, the README and the shared workflow's default repository. The
  workflow pin `onboard` writes is `veda-hq/niyam/.github/workflows/checks.yml`,
  and a pin of `athya-hq/process-rules` counts and is moved. What adopters'
  committed files and hooks name stays: the hook commands and launcher, the
  lock's text, `~/.config/process-rules`, `PROCESS_RULES_AGENT`,
  `.github/workflows/process-rules.yml` and its job ids (so the required
  checks keep their names and no ruleset changes), `process-rules-ref` and the
  cloud setup path (no new Setup paste). P-50: the keychain service is
  `niyam` and the settings file `.github/niyam.json`, each read first, the
  old one where it is missing; `machine` copies the token and leaves the old
  entry, `onboard` keeps a repo's existing settings file, and a session file
  an older release wrote, which reads the old entry, still counts (`doctor`
  marks it ▲). Releases attach the CLI twice: `veda-hq-niyam-<v>.tgz`, and the
  same build named `@athya-hq/process-rules` as `athya-hq-process-rules-<v>.tgz`,
  since 0.6.x's `upgrade` looks for that name and pnpm refuses a second global
  package with the bin `process-rules` (tried with pnpm 12.9.0). That bridge
  replaces the old package in place; `niyam upgrade` then removes it and adds
  `@veda-hq/niyam`, putting the old one back if the add fails. `upgrade`
  asks veda-hq/niyam for releases and athya-hq/process-rules on a 404, so it
  works before and after the transfer. Rejected: renaming the job ids, the
  workflow file, the cloud path and `~/.config` now (each needs every
  adopter re-onboarded, the job ids a ruleset edit in the same hour; a later
  slice); publishing to npm now (tarballs as before; its own slice).
- **2026-11-10 — Record: the lock reads niyam names, old ones too (P-50).**
  The owner approved #227 with a 👍 on its own, since the keychain service and
  the settings file are what P-17's lock reads. The agent's token is stored
  under the keychain service `niyam`; a token found only under
  `process-rules` is still read, and `machine` copies it to `niyam`, leaving
  the old entry for older CLIs on the Mac; while that entry is there, a token
  `machine` stores goes under both names, so an older CLI never reads one it
  replaced (review). The session file now reads
  `niyam`, then `process-rules`; one an older release wrote, which reads the
  old entry alone, still counts for session-start and as-agent, and `doctor`
  marks it ▲ until `machine` rewrites it, so no session locks out after the
  upgrade. The settings file is `.github/niyam.json`; session-start, the
  guard, as-agent, doctor, the work rules and the shared checks read
  `.github/process-rules.json` where it is missing, and name the file they
  read, and the workflow's schedule comment names the file in use. `onboard`
  writes `.github/niyam.json` in a repo that has neither and
  keeps an existing `.github/process-rules.json`, which an older CLI on
  another Mac still reads. Nothing else in P-17 or P-18 changes: the lock's
  placeholder token, the SSH refusal, `~/.config/process-rules` and
  `PROCESS_RULES_AGENT` stay. Rejected: moving the token (an older CLI would
  lose it); renaming an adopter's settings file now (an older CLI's
  session-start would lock out).
  cloud setup path (no new Setup paste). The keychain service and the settings
  file are P-50's, which the owner approves on its own. Releases attach the
  CLI twice: `veda-hq-niyam-<v>.tgz`, and the same build named
  `@athya-hq/process-rules` as `athya-hq-process-rules-<v>.tgz`, since 0.6.x's
  `upgrade` looks for that name and pnpm refuses a second global package with
  the bin `process-rules` (tried with pnpm 12.9.0). That bridge replaces the
  old package in place; `niyam upgrade` then removes it and adds
  `@veda-hq/niyam`, putting the old one back if the add fails. `upgrade` asks
  veda-hq/niyam for releases and athya-hq/process-rules on a 404, so it works
  before and after the transfer. Rejected: renaming the job ids, the workflow
  file, the cloud path and `~/.config` now (each needs every adopter
  re-onboarded, the job ids a ruleset edit in the same hour; a later slice);
  publishing to npm now (tarballs as before; its own slice).
- **2026-11-10 — Record: an organisation's enabled issue types are the work
  model's alone.** The agent filed an issue as Task, one of GitHub's default
  types, which `onboard` never touched, and it showed on the owner's Needs
  you view with a type outside the work model. The owner asked for a proper
  solution, not only turning the defaults off: issues holding another type
  must be handled, and `onboard` must see to it in every organisation. Now
  `onboard`'s issue types step adds or enables the work model's types, gives
  each issue holding any other type, in every repository of the
  organisation, a work model type (a sub-issue of a Work item a Slice, an
  issue with sub-issues a Work item, any other a Brief), and then disables
  the other types, all under the plan's one yes, as the owner. It disables
  (`PUT /orgs/{org}/issue-types/{id}` with `is_enabled: false`, sending the
  type's name, description and colour back, since the PUT takes them all)
  rather than deletes: GitHub's documentation says a disabled type is not
  shown and cannot be set, and shows again on its issues when enabled, but
  does not say what deleting one does to them. Retyping first leaves no
  issue holding a disabled type, which would hide it. It finds the issues by
  listing each repository's issues with `type=`, open and closed, not by
  search, which caps results at 1000 and lags its index; it keeps only rows
  GitHub shows holding the type, so a filter GitHub ignored retypes nothing.
  An issue in an archived repository, which GitHub keeps read-only, keeps
  its type, and that type stays enabled until the owner unarchives it and
  reruns. Where a type outside the work model exists, the owner signs in
  before the plan, since the agent sees only the repositories it can read,
  and the run changes nothing beyond the plan shown (review). `doctor` warns
  when an enabled type outside the work model, or a missing work model type,
  appears again. Rejected: deleting the types
  (unknown effect on issues, no way back); search (capped, lagging);
  retyping as the agent before the owner's run (the owner approves the
  organisation-wide change once, from one plan); typing the issues with no
  type at all (another question, for the owner).
- **2026-11-10 — Record: `propose` posts a pointer to a page (State #236 of
  P-40).** The owner approved it with a 👍 (page
  https://claude.ai/artifact/UKSecSCvue9yfwcbA9nHGP): on 10 Nov, all four
  proposals `propose` posted in the first client ran 716 to 2,134 characters
  and linked no page, which the guard refuses for any other ask, and one had
  to be cut by hand. A proposal is now three lines: what it proposes (the
  first `#N` still names the issue, which the 👍 matching relies on), `Page:
  <url>` from a required `--page`, and how to answer. The body is checked
  with the guard's own `askProblem` before anything is posted, so the two
  cannot drift apart. One page per run, a batch included: one page argues a
  batch, and every comment then carries its link. A run that only links
  proposals already posted needs no `--page`, so re-running to relabel or
  print the batch line still works. The slice must still have its "You will
  see" and "Why" sections, which the page is written from. Rejected: cutting
  the old body to 500 characters (it still argues in the comment and links
  no page); reading the page link from the slice body (a page link in a
  slice is evidence, not the ask's page).
- **2026-11-10 — Record: open issues with no type get one.** The record
  above left issues with no type at all as another question for the owner,
  who answered it: 38 open issues across athya-hq had none (sub-issues of a
  Work item, coordinator notes, chat approval records, the monthly secret
  rotation reminders athya_mono's own workflow files, old bugs), and the
  owner wants them typed as a proper solution, in the same run. Now
  `onboard`'s issue types step also lists each repository's open issues with
  `type=none` and types them by the same rule, under the plan's one yes, which
  gains one more fact: a sub-issue of a Slice is a State. Closed issues with
  no type are left as they are, as the plan says. A repository's Approvals
  issue, named by `"approvals"` in its settings on the default branch, keeps
  no type, as the plan says: a standing record, never closed, that no work
  model type fits, and one the work rules find by number. The plan now shows
  every issue it types, consecutive ones typed alike on one row, rather than
  the first ten. To keep them from coming back, the client workflow's
  `process-rules-asks` job, which already has `issues: write`, also starts
  on an issue opened or reopened (unless the client changed its `issues:`
  trigger, which `onboard` leaves as it is), and the shared workflow's new
  `Issue type` job runs `niyam issue-type`, which types an issue with no
  type by the same rule. GitHub starts no run for an issue a workflow's own
  `GITHUB_TOKEN` opens, as athya_mono's reminder workflow does, so the job
  also runs on the asks job's hourly cron and types every open issue there
  with none. The `needs-owner` job now runs on the `labeled` issue event
  alone. `onboard` now writes the workflow for `board` alone too, whose
  Needs you labels and issue types come from it.
  `issues: write` sets an issue's type: the weekly job's undo issues
  (process-rules-sandbox#15, athya_mono#2514) were opened as Briefs by that
  token. `doctor` warns of open issues with no type here. Rejected: a rule
  reading titles or labels (none that the CLI writes says Decision; #813's
  title says "decision" but carries no `Review:` field); typing the Approvals
  issue a Brief (it would read as a request a pull request closes); a fifth
  client job (the asks job already writes to issues, so one line each in its
  trigger and its condition upgrades a 0.6.3 workflow); editing athya_mono's
  `rotate-secrets.yml` (the job types what it files).
- **2026-11-10 — Record: a rerun of `onboard` goes through where the other
  issue types are disabled (State #245 of P-05).** A fix, so no approval was
  owed. `onboard` in veda-hq/niyam-sandbox disabled veda-hq's Task, Bug and
  Feature; the next `onboard`, in veda-hq/niyam, stopped at the board step,
  since GitHub answers `422 Validation Failed` (`field: type, code:
  invalid`) to `/repos/{r}/issues?type=Task` once Task is disabled, and the
  owner had to enable the three again to get past it. Now a 422 for a
  disabled type outside the work model is read as "GitHub will not list its
  issues": the type is asked of one repository, not every one, it stays
  disabled, and the plan and the run say `onboard` cannot tell whether an
  issue holds it, and that enabling it again lets `onboard` retype what
  does. Only a 422 whose errors all name the `type` field counts; another
  422 (GitHub's spam refusal, say), a 422 for an enabled type, and any
  other failure fail the read as before. The owner still signs in before
  the plan wherever a type outside the work model exists, disabled too:
  the sign-in is the run's one, which the board step needs anyway, and the
  agent cannot see every repository, so without it an open issue with no
  type in one it cannot see would be found only after the plan (review).
  Rejected: reading the
  422 as "none held" (GitHub keeps a disabled type, hidden, on its issues;
  saying none holds it would be a claim nobody checked); GraphQL's
  `filterBy: {type}` and search's `type:` (both give 0 for a disabled type
  and for one that does not exist alike, so they cannot list hidden
  holders); skipping disabled types unasked (if GitHub ever lists them, the
  rerun finds them again).
- **2026-11-10 — Record: `onboard` allows the pull request tools that turn
  Auto-fix on (P-52, #249).** session-start tells each local agent session
  to turn Auto-fix on with `set_monitor` after `gh pr create` (#142), but in
  auto mode the classifier refused the call on veda-hq/niyam#247: the repo
  did not allow it. athya_mono allowed it only because W-31 added the rules
  by hand. The owner asked, in chat, that niyam own them. `onboard` now adds
  `mcp__ccd_pr__bind_pr`, `mcp__ccd_pr__get_status` and
  `mcp__ccd_pr__set_monitor` to `permissions.allow` in `.claude/settings.json`
  beside the review-thread rule, in the text, adding only the ones missing
  (none where `mcp__ccd_pr` or `mcp__ccd_pr__*` allows the whole server,
  review) and leaving the rest of the file as it is; the plan says "Auto-fix rules",
  or "allow rules" when the review-thread rule is added too, to keep its
  line short. `doctor` warns (`▲`, not `✗`: the agent identity still works)
  under "This repo" about an onboarded repo whose file lacks any, naming
  them. The rules let a session bind a pull request, read its status and
  set its monitor without a prompt; they give no new access to GitHub, and
  the app still checks that the session opened the pull request as its own
  login.
- **2026-11-10 — Record: the owner's GitHub steps run as one command
  (P-51).** The owner approved #240 with a 👍. On 2026-11-10 the coordinator
  gave the owner a one-off shell script for veda-hq's issue types, and it
  stalled in gh's pager. The owner asked, in chat, that owner-only work
  become one tested command. `niyam owner-step <step> [args]` has three steps
  for now: `issue-types <org>`, `label <repo> <number> <add|remove> <label>`
  and `required-checks <repo> <ruleset>`. A new step is a slice the owner
  approves, never a script an agent writes.
  - It refuses where onboard does, and also where `CLAUDECODE=1` (the
    pre-push hook's test), so an agent session whose hooks never ran is
    refused too. It also refuses without a terminal, and it has no `--yes`.
  - It signs in to a throwaway gh: a new `niyam-owner-step-…` folder as
    `GH_CONFIG_DIR`, `GH_PAGER=cat`, the token variables unset, and
    `gh auth login -p https --skip-ssh-key -w -s <scope> --insecure-storage`,
    through a pipe so gh cannot prompt to set up git. Every call is `gh api`
    in that folder, and none runs unless the folder's `hosts.yml` holds a
    token. niyam reads that file only to check that a token is there; it
    never takes the token out of it or passes it to anything. gh's own lookup falls back to the
    keychain when the config has none (gh 2.103.3, `AuthConfig.ActiveToken`),
    and the owner's normal login must never be used.
  - It checks the login owns the organisation (an active admin) or the
    repository (the user, or an owner of its organisation). It reads the
    state and prints the exact changes, and asks the one yes only then: the
    sign-in and the reads change nothing, so the yes still comes before any
    change. Each change is read back and marked ✓ or ✗.
  - It does not run `gh auth logout`, though #240 says it signs out. In gh
    2.103.3, `AuthConfig.Logout` deletes the keychain entries `gh:github.com`
    for the login and for "" whatever `GH_CONFIG_DIR` says, so logout could
    delete a gh login the owner keeps in the keychain. The owner's rule is
    that the command never touches the keychain or the owner's own login,
    and the coordinator chose that over the logout. With `--insecure-storage`
    the token's only copy is in the folder, so deleting it signs out locally.
    The token stays valid on GitHub until revoked, as it would after a
    logout, and the closing line links where to revoke it.
  - Cleanup is synchronous and runs once, from `finally` and from a SIGINT
    handler `Sys.onInterrupt` adds. A gh call runs synchronously, so its
    Ctrl-C reaches the handler only once the event loop runs. Before each
    change, and after a failed one, the command waits a few milliseconds
    for that, so a Ctrl-C stops the changes not yet made and exits 130.
  - The folder sits in macOS's per-user temporary folder (`getconf
    DARWIN_USER_TEMP_DIR`), which is the same whatever TMPDIR a shell sets,
    so `doctor`, run from an agent session too, finds one a killed run left.
  - `issue-types` adds and enables the work model's types only. Disabling
    the others and retyping issues stays with `onboard`, whose plan explains
    them.
  - `label` takes `approved` and `do-not-merge` alone, and refuses a label
    the repository lacks, since adding an unknown name would create it.
  - `required-checks` follows the README's rule: it adds the checks of the
    features the repository's settings turn on and removes none. The
    settings come from the file `loadSettings` reads: `.github/niyam.json`,
    then `.github/process-rules.json`. On the coordinator's ask, a check is
    added only when the repository's workflow runs its job: a `process-rules`
    job calling shared checks that have a job of that name at the pinned
    version. A required check that never reports would hold every pull
    request, so the others are `✗` lines saying why. It sends
    back the ruleset's whole `rules` list as read, changing only the
    contexts, and checks that the other rules are unchanged afterwards.
  - Nothing in P-17 or P-18 changes. `signInOnce` (P-35) only shares its
    line handler.
  - Rejected: reading the token into the CLI to call the API (it would be in
    memory and in reach of a bug that prints it); a `--yes` flag;
    `gh auth logout` (above).
- **2026-11-10 — Record: the hooks and checks say niyam (P-53).** After the
  rename the owner asked, in chat, to fix the check still named
  `process-rules` and the `process-rules` command still installed. That
  reverses P-49's choice to keep both "now". The command cannot go first:
  every hook `onboard` wrote, and the launcher `machine` wrote, runs it, so
  dropping it would lock every agent session out of GitHub. So P-53 moves
  everything that runs it, and P-54, a release later, drops it.
  - The hooks and the pre-push hook fall back to `niyam` on PATH and say
    niyam; `onboard` replaces 0.6.7's texts, kept in its older lists. The
    allow rule is `Bash(niyam review-thread *)`, put in the old rule's
    place. The cloud setup writes `/usr/local/bin/niyam`, removing both names
    first (0.6.x's `niyam` was a link to `process-rules`, which the write
    would follow), and links `process-rules` to it until P-54. `machine`
    points the launcher at the package manager's `niyam`; `doctor` marks ▲
    one that runs `process-rules`. `niyam upgrade` points such a launcher at
    the `niyam` beside it, so upgrading to P-54, which installs no
    `process-rules`, cannot leave the hooks without a CLI.
  - Checks take a reusable workflow's caller job's `name:`, so each job gets
    one (`niyam`, `niyam-weekly`, `niyam-merged`, `niyam-asks`) and keeps its
    id. The ids, the workflow's file name and `process-rules-ref` stay:
    `onboard` and `owner-step` find the jobs by id, and renaming them would
    rewrite every adopter's workflow for no visible change.
  - A pull request reports only the names its own workflow gives, so the
    onboard pull request that adds the names cannot meet a ruleset that
    requires the old ones, and the old ones go missing from every pull
    request after it. `owner-step required-checks` requires each
    `process-rules / …` check as `niyam / …` in its place, but only once the
    workflow on the default branch or on `process-rules/onboard` names the
    job niyam, and adds no niyam check before. `onboard` reads the rulesets
    and lists that step by hand when one still requires an old name. The
    order is: the onboard pull request opens, the owner swaps, it merges.
    Pull requests opened before it report the old names until they merge
    main. Rejected: reporting both names for a release, by running the
    read-only job twice (twice the runs and pull request checks, and a
    second job to remove later); renaming the job ids (above).
  - Unchanged: the launcher's path, `~/.config/process-rules`,
    `PROCESS_RULES_AGENT`, the lock's text and placeholder token, the cloud
    setup path and the Setup paste, the settings and keychain fallbacks, and
    the bridge archive for 0.6.x's `upgrade`.
- **2026-11-10 — Record: the process-rules command goes (P-54).** The owner
  asked for it in chat with P-53, which moved every hook, the launcher and
  the cloud setup to `niyam`. The package's only bin is `niyam`; the cloud
  setup removes any `process-rules` from an older one and links none.
  `doctor` marks ✗ a launcher that still runs `process-rules`, naming
  `niyam upgrade`, which points it at `niyam` (P-53), or `niyam machine`.
  The bridge archive `athya-hq-process-rules-<v>.tgz` keeps the bin
  `process-rules`: a 0.6.x Mac's `process-rules upgrade` installs it, and its
  launcher runs that command until `niyam upgrade` moves it. Rejected:
  dropping the bridge's bin too (that Mac's hooks would lock out on the
  upgrade); dropping the bridge (0.6.x's `upgrade` would find no release).
- **2026-11-11 — Record: the lock and this Mac's files say niyam (P-55).**
  P-53 and P-54 left the names P-17's lock and P-18 read. The owner said in
  chat on 2026-11-11, "I want to fix everything", so these are a slice of
  their own, as P-50 was: the release writes the new names and still reads
  the old ones.
  - This Mac's files are under `~/.config/niyam`: the agent folders and
    their session files, the session records, the locked `gh` folder, and
    the launcher `~/.config/niyam/bin/niyam`. `machine` and session-start
    write only there. `machine` leaves `~/.config/process-rules` and its
    launcher in place, since older hooks and CLIs still use them. Every
    reader takes the new place, then the old: `agentsSetUp` (both folders,
    each agent once), session-start, as-agent and doctor for the session
    file, the guard and as-agent for the session record, the lockout's
    agent keys and records, doctor's launcher check, and `upgrade`, which
    points both launchers at `niyam`. A record is taken from the new
    folder whenever it is there, whatever it says, so an old record never
    unlocks a session the new session-start locked.
  - The hooks find the new launcher, then the old one, then `niyam` on
    PATH. `onboard` replaces 0.6.8 and 0.6.9's hooks and pre-push hook in
    place, and as-agent counts them as its own until then.
  - Agent sessions get `NIYAM_AGENT`, and `PROCESS_RULES_AGENT` is still
    set beside it, by the session file, as-agent and a cloud session's
    session-start: pre-push hooks, `owner-step` and adopters' scripts that
    read only the old name would otherwise take an agent session for the
    owner's. Every reader takes either (doctor, `onboard`'s and
    `owner-step`'s refusals, the pre-push hook, `sessionNames`). Missing one
    fails open, so each is tested with each name alone.
  - The lock's placeholder token is `niyam-no-agent-token`, and its SSH
    refusal says `niyam:`; `process-rules-no-agent-token` still counts as no
    token. `onboard` updates a repo's `.claude/settings.json` `env`, and its
    plan says "lock updated". The scripts `machine` and session-start write
    say "Written by niyam …".
  - A session file 0.6.9 wrote in the old folder (old header, placeholder,
    SSH refusal, gh folder, and `PROCESS_RULES_AGENT` alone) still counts,
    with either keychain read, as P-50's did. A session started under 0.6.9
    keeps its record there and keeps working after the upgrade, with no
    `machine` run. `doctor` marks ▲ a session file or launcher only in the
    old folder, and ✗ an old launcher, alone or beside the new one, that
    cannot run or runs `process-rules`: hooks 0.6.8 and 0.6.9 wrote run it
    whenever it is there. Beside the new one the fix is `niyam upgrade`,
    which points it at `niyam`, or removing one that cannot run, since those
    hooks then run `niyam` on PATH; `machine` does not touch it. Entries in
    either config folder that are not agents (`bin`, `sessions`, `locked`)
    no longer exempt an owner's SSH key of that name from the lockout check
    (review).
  - Until P-57 the old folder, its launcher, `PROCESS_RULES_AGENT` and the
    old placeholder are still read or set. P-57 removes them once every Mac
    has run `niyam machine`. The workflow, its job ids, `process-rules-ref`,
    the cloud setup path and the settings file are P-56's.
  - Rejected: moving the old folder's files (a running session's record and
    older hooks would lose them); setting `NIYAM_AGENT` alone (fail-open in
    every old reader); reading a record from the old folder when the new
    one names no agent (a stale record would unlock a locked session).
- **2026-11-11 — Record: what onboard writes says niyam (P-56).** P-55 moved
  this Mac's files. It left what `onboard` writes in an adopter's repository
  under the old names, because adopters' committed files name them. The owner
  said in chat on 2026-11-11, "I want to fix everything", so these move too.
  That reverses P-49's and P-53's choice to keep the workflow's name, its job
  ids, `process-rules-ref` and the cloud setup path, and P-50's to keep a
  repo's existing settings file. As in P-55, the release writes the new names
  and still reads the old ones.
  - The workflow is `.github/workflows/niyam.yml`. Its jobs are `niyam`,
    `niyam-weekly`, `niyam-merged` and `niyam-asks`, and the shared checks'
    input is `niyam-ref`. Each job keeps its `name:`, so the check names
    (`niyam / Work rules`, …) and every ruleset stay as they are.
    `workflowUpdate` first recognises an older single-job template and
    replaces it whole, as before. Any other workflow has its old ids and
    input renamed, and then goes through the same steps as before: adding
    the merged and needs-owner jobs, and moving pins, branch, schedule and
    secrets. The 0.6.8 and 0.6.9 workflow, copied from athya_mono, niyam and
    niyam-sandbox, moves with the client's own edits kept; a workflow in
    none of the shapes these steps know is replaced by this release's
    template, as before P-56, so edits of the client's own in it go (the
    plan says "replaced"). Wherever
    `onboard` writes the workflow (a feature on runs the shared checks), it
    deletes `.github/workflows/process-rules.yml` in the same pull request,
    also where a new one is already there, since both would run every check
    twice. With identity alone it writes no workflow and leaves an old one
    in place, saying so in the plan: deleting it with no new one would turn
    its checks off.
  - `checks.yml` declares `niyam-ref` and `process-rules-ref` and takes
    whichever is set, then `main`. GitHub refuses a caller that passes an
    undeclared input, which would leave every pull request of a repo not yet
    moved without checks. Settings names the input the caller set when a
    ref is not the release that runs. The CLI is checked out under `.niyam`.
    The decisions job's concurrency group keeps its old key,
    `process-rules-decisions-…`. A repo's runs at an older release use that
    key, and only one shared key serializes them, so two cannot both open an
    undo issue. P-57 renames it once no repo pins a release before this one.
  - The cloud setup file is `.github/niyam/cloud-setup.sh`, installing under
    `/opt/niyam` and leaving its mark there, holding the path it ran from,
    so `doctor` names the file the Setup script ran: a mark under
    `/opt/process-rules` is a file before P-56, and one that names neither
    path names none. `onboard` writes the same file
    at `.github/process-rules/cloud-setup.sh`, in a new repo too, since a
    cloud environment's Setup script serves every repo its sessions clone,
    and the snippet already pasted runs the old path with
    `PROCESS_RULES_SETUP` alone, which the file still honours. The new
    snippet runs the new file, else the old, setting `NIYAM_SETUP` and
    `PROCESS_RULES_SETUP` for a file written before. A repo with only the
    old file gets one by-hand line, to paste the new snippet once.
  - `onboard` moves `.github/process-rules.json` to `.github/niyam.json`
    byte for byte, but for any change the run makes, and deletes the old
    one. The work rules let onboard's own pull request delete exactly these
    two files, each only into its own new name, written in the pull request
    or already on its base. A rename GitHub shows counts the same, and a
    copy between onboard's files deletes nothing. Any other deletion or
    rename is held to the work rules, as before. The plan names each
    deletion, a delete-only one too.
  - onboard's branch is `niyam/onboard`. Its check for an onboard pull
    request a newer release opened reads both branches and both workflow
    names, as `owner-step required-checks` does, and the work rules take
    both branches. Where only `process-rules/onboard` has an open pull
    request, a run again pushes there and updates it, so no second one
    opens beside it. `owner-step` finds the read-only job by either id,
    with a workflow's CRLF line endings read as LF.
  - The decisions check's status mark is `niyam-check-exit=`, temporary
    folders start `niyam-`, the test commit's branch is `niyam/verify-…`,
    and a token or signing key `machine` makes from now on is titled
    `niyam agent` or `niyam signing`. Existing ones keep their titles. The
    board template, athya-hq's Project 4, is titled "niyam template".
    `onboard` finds it by number, so no release reads the title.
  - Still read until P-57: the old workflow and its ids,
    `process-rules-ref`, `.github/process-rules.json`, the old cloud setup
    file, which `onboard` still writes, `/opt/process-rules/from-setup`,
    `PROCESS_RULES_SETUP` and `process-rules/onboard`, besides P-55's
    names. The `process-rules vetted` marks are old data and stay readable.
  - Cost: one release, shared with P-55. Then `onboard` in each adopter, one
    paste of the new Setup snippet, and athya_mono's own scripts reading
    both names before its onboard (a State of W-39).
  - Rejected: renaming the job ids without `name:` (the checks' names would
    change, and every ruleset with them); declaring `niyam-ref` alone (each
    repo not yet moved would run no checks, holding every pull request);
    stopping writes to the old cloud setup file (the pasted snippet would
    find nothing until the owner pastes again).
- **2026-11-11 — Record: the old process-rules names go (P-57).** P-55 and
  P-56 wrote niyam's names and still read the old ones. The owner said in
  chat on 2026-11-11, "I want to fix everything", so once this Mac and every
  repository have moved, the operational reads and writes go too: no release
  reads settings, tokens, files or checks under a `process-rules` name, or
  writes one. The data and leftover names below stay.
  - This Mac and the lock: nothing reads `~/.config/process-rules/`, its
    launcher, session files or session records. `NIYAM_AGENT` alone names
    the agent, and nothing sets `PROCESS_RULES_AGENT`.
    `process-rules-no-agent-token` is a token like any other, which GitHub
    refuses. The keychain store reads and writes the service `niyam` alone.
    The hooks run `~/.config/niyam/bin/niyam`, else `niyam` on PATH, and the
    pre-push hook checks `NIYAM_AGENT` and `CLAUDECODE` alone. 0.6.10's
    hooks and pre-push hook join `onboard`'s older lists, so it replaces
    them in place.
  - Destructive steps, the two on this Mac each named in `machine`'s plan
    before its one yes:
    - `machine` removes `~/.config/process-rules/`, whole, the old
      launcher and any session file, record or lockout record still in it,
      once the new folder is written.
    - `machine` deletes the keychain entry under the service
      `process-rules`, but only after reading back that the `niyam` entry
      holds the same token, read again just before the delete. When they
      differ or a read fails, it leaves the entry and says why, under
      "Worth fixing", with the `security delete-generic-password` line to
      run once nothing needs it. `doctor` marks a leftover folder or entry
      ▲, fixed by `niyam machine`, or by that line where the tokens differ.
    - Releases stop attaching the bridge archive
      `athya-hq-process-rules-<v>.tgz`, and `src/old-cli.ts` is deleted.
      `upgrade` asks veda-hq/niyam alone and no longer handles
      `@athya-hq/process-rules`. A Mac still on it installs niyam with the
      README's `pnpm add -g` line, after `pnpm remove -g` of the old
      package. The `LAST_OLD_RELEASE` mapping goes too: `onboard` pins only
      the release that runs and `upgrade` installs only the newest, so
      nothing installs a release at or before 0.6.3.
  - The repository: nothing reads `.github/process-rules.json`,
    `.github/workflows/process-rules.yml` or its `process-rules…` ids,
    `process-rules-ref`, an `athya-hq/process-rules` pin,
    `/opt/process-rules/from-setup`, `PROCESS_RULES_SETUP`, the
    `process-rules/onboard` branch or a `chore(process-rules)` subject.
    `onboard` stops writing `.github/process-rules/cloud-setup.sh`, and
    deletes it in its own pull request wherever the new file is left. The
    work rules allow that deletion, as they did the moves of P-56. The
    Setup snippet runs `.github/niyam/cloud-setup.sh` alone and sets
    `NIYAM_SETUP` alone. `checks.yml` declares `niyam-ref` alone.
    `owner-step` finds the `niyam` job alone; `required-checks` takes each
    `process-rules / …` check out of the ruleset, since none reports, and
    requires the `niyam / …` one of the same job in its place where the
    workflow runs that job (review). `onboard` no longer reads rulesets for
    the old check names.
  - What stays, and why:
    - The reader for `<!-- process-rules vetted sha256:… -->` marks: they
      are data in decisions already vetted, and dropping it would un-vet
      them.
    - The `OLDER_` hook texts: data `onboard` compares against, which
      nothing runs.
    - 0.6.10's session file, which `sessionFileIs` still counts as older:
      without it, a session started between the upgrade and `machine`
      would lock out. session-start and as-agent use that file, which
      reads the keychain service `process-rules` where `niyam`'s is
      missing, until `machine` rewrites it (review).
    - The names `machine`, `doctor`, `onboard`, `owner-step` and the cloud
      setup file look for only to remove or report a leftover:
      `~/.config/process-rules/`, the keychain service, the old cloud setup
      file, `/usr/local/bin/process-rules`, a launcher that runs
      `process-rules` (doctor's ✗) and a required `process-rules / …`
      check; and `PROCESS_RULES_AGENT`, which `as-agent` keeps from the
      commands it runs (review).
    - The decisions job's concurrency key, `process-rules-decisions-<repo>`,
      for one more release (review): a `workflow_dispatch` can run that job
      from any branch, a branch pinning a release before P-57 uses that
      key, and only one key shared by every release serializes them, so
      two runs cannot both open an undo issue.
    - GitHub's redirect from athya-hq/process-rules, and the titles of
      tokens, signing keys and the Project made before.
    - The history in this file and docs/roadmap.md.
  - Cost: one release, only once every niyam worktree and athya_mono pull
    request branch carries P-55/P-56 hook text, this Mac has run
    `machine`, and the new Setup snippet is pasted. A checkout still on
    older hooks is locked out of GitHub until it merges main.
  - Rejected: keeping the bridge archive for one more release, since the
    release waits until every Mac has moved to `@veda-hq/niyam`; copying the old folder's
    lockout records into the new one before removing it, as of P-55
    `machine` writes them in the new folder alone, so at worst `doctor`
    warns again of a login the owner once chose to keep.
- **2026-11-12 — Record: the decisions job's concurrency key says niyam
  (State #276 of P-57).** P-57 kept `process-rules-decisions-<repo>` for one
  release, since a `workflow_dispatch` from a branch pinning an older
  release would use that key, and two keys would let two runs both open an
  undo issue. veda-hq/niyam, niyam-sandbox and athya-hq/athya_mono now pin
  0.6.12, so the key is `niyam-decisions-<repo>`. A dispatch from a branch
  still pinning a release before this one runs under the old key; the worst
  it can do is open an undo issue twice, which the next weekly run reports.
- **2026-11-14 — Record: `owner-step required-checks` also requires a named
  check (P-58, Work item #315, slice #314).** Alok asked why an agent sent
  him to the ruleset page for `veda-checks / Checks` when niyam has owner
  steps. `required-checks` added only the checks of niyam's features, so it
  could not. AthyaBot is not an admin of veda-hq/niyam, and cannot change a
  ruleset either.
  - `--check <name>`, repeatable, adds a check the owner names. The proof
    that a required check will not hold every pull request is that it
    reported `success` on the head commit of the last pull request merged
    into the default branch. It is required from the app that reported it
    there. A check required already, or one a feature turns on, needs no
    proof.
  - Refused, as a `✗` that makes the run exit 1: a check that never ran
    there, did not pass, or that more than one app reported. A ruleset
    requires one app's check, and a second app's check of the same name
    could stand in for it.
  - Cost: one merged pull request is the evidence. A check whose workflow
    runs only for some paths passes there and holds a later pull request
    that skips those paths. The plan says so for each named check, and the
    README does too.
  - Rejected: reading the workflow's `on:` triggers and path filters,
    because the check-run name a ruleset matches is not the workflow file's
    job id, and a reusable workflow's jobs are named by its caller. Also
    rejected: a check that passed on the default branch's head commit, which
    a check run only on `push` does, and which never reports on a pull
    request.
- **2026-11-14 — Record: a release also publishes the CLI package to npm
  (P-59, Work item #306, slice #307).** Alok chose npm so veda can pin
  `@veda-hq/niyam` as an exact registry version (veda-hq/veda#47): veda's
  `released-pins.mjs` and `sarathi.sh` accept only `x.y.z` registry pins.
  - The Release workflow publishes the tarball it attaches to the GitHub
    release, with provenance, before making the release. A version already on
    npm is skipped, so a rerun is safe. `niyam upgrade`, the README's
    `pnpm add -g` line and the cloud setup still take the GitHub release.
  - The job runs in the `npm` environment, which only `v*` tags may deploy
    to, and reads `NPM_TOKEN` from it. A repository secret, as veda has,
    could be read by a workflow pushed on any branch.
  - Cost: a `v*` tag on a commit off `main` still deploys to the environment
    with that commit's own workflow; #308 closes it by limiting the
    environment to `main`. The token is long-lived until trusted publishing
    replaces it, after the first publish.
  - The first publish is 0.6.16: 0.6.15 was cut first, for #314.
- **2026-11-14 — Record: `pr-signals`, and `review-thread` from a file and
  in the cloud (W-56.1, Work item #320, slice #321).** athya_mono kept its
  own pull request helpers (`collect-signals`, `sync-pr`, `pr-rest`,
  `graphql-paginate`), about 8,000 lines with their tests. They move here so
  every client gets them, and athya_mono deletes its copies.
  - `pr-signals <pr>` prints threads, failing checks and local findings as
    one list. The client's review bots and findings file come from
    `.github/niyam.json`'s `"signals"`, so the code names no client.
  - `review-thread` takes `--body-file`, which resolves unless
    `--no-resolve`, and `--reaction` with `--comment-id`. Its `--reply` and
    `--resolve` work as before, except that a `--reply` whose text starts
    with `--` is refused: it is far likelier a missing reply than one. A
    reply already on the thread is not posted again. The file must be in
    the repository: the allow rule `onboard` writes runs the command without
    a prompt, so it must not post a file from elsewhere.
  - In a Claude cloud session it uses the proxy's REST routes, the only ones
    the proxy answers, and is no longer refused there. The session is the
    agent when the proxy's `/user` is, the rule `pre-push` already holds a
    cloud push to.
  - Kept from athya_mono: a page that says more follow with no cursor
    stops the run; a merged or closed pull request is refused before any
    read and again before printing; a failed local review never reads as
    clean; an id in the other transport's form is refused before any
    request.
  - Changed: CI excerpts come from the failing check run's own job log (a
    GitHub Actions check run's id is its job's), not from matching run
    names to check names. Every failing run is kept, even beside a passing
    one of the same name, since two workflows can name a job alike; one
    failure reported twice has the same lines and is folded. A pull request
    whose state cannot be read stops the run instead of being read as open.
    The cloud is `CLAUDE_CODE_REMOTE`, as everywhere in niyam; athya_mono
    also checked the session's entrypoint. On a machine that sets it by
    mistake, the proxy's routes do not exist and the run fails loudly.
  - Left out: `sync-pr`'s five-file pipeline mode, whose skill athya_mono
    no longer has, and the `rocket` reaction.
- **2026-11-14 — Record: `handoff` and `brief`, the hand-off gate (W-56.2,
  Work item #320, slice #323).** athya_mono's `incidental-handoff`,
  `brief-issue` and `brief-contract` move here, about 7,300 lines with their
  tests, and athya_mono deletes its copies.
  - What the gate refuses is unchanged: no declaration, one the gate wrote,
    a stale head or base, a trigger that fired after the declaration, own
    work with no reason, an uncited dismissal, a hand-off with no Brief
    issue, a brief that does not lint, one found on another branch, and a
    blocking brief not yet landed.
  - What was athya_mono's is now settings: the plumbing list, the push
    history file, the stages it never counts, the template's path and the
    base ref, under `.github/niyam.json`'s `"handoff"`. A repository that
    names none has the gate off, and `--assert-fresh` passes there, so a
    hook can call it everywhere. The copy on the remote's default branch
    (or the `--base` asked for) decides when it names one, the file always
    counts as plumbing, and a base that is no remote-tracking branch, such
    as `HEAD`, is refused: athya_mono's list was its script under
    `.claude/`, plumbing itself, so a branch could not shorten it unseen,
    and neither can one here.
  - `niyam pre-push` runs the gate for an agent session, after the identity
    check and before the work rules, on its own setting rather than a
    feature. `--assert-fresh` stays a command for a client hook of its own.
  - Changed: briefs are read and opened over REST; athya_mono used `gh` and
    GraphQL. A cloud session's proxy refuses GraphQL, so REST is what can
    work there; it has not yet been run in a cloud session, which the
    release's cloud proof does. REST names no closer (a pull request's
    close leaves the `closed` event's `commit_id` null, seen on the
    sandbox), so the fix is the newest merged pull request of this
    repository, into its default branch, that the issue's timeline
    cross-references and whose text says `Fixes #N`; its merge commit must
    be in the branch's history, as before. The frontmatter
    is read with `yaml`, already a dependency, loaded only when a brief is.
    A repository with no `project` opens its briefs on no board, where
    athya_mono warned: without the `board` feature there is none.
- **2026-11-14 — Record: `cubic-dismiss` (W-56.3, Work item #320, slice
  #325).** athya_mono's `scripts/cubic-dismiss.ts` moves here, about 1,500
  lines with its tests, and athya_mono deletes its copy. What it refuses is
  unchanged: no basis or two, evidence that does not resolve, a deferral on
  evidence, an empty, comment-like, multi-line or already dismissed title,
  a reason missing, and a dismiss file that already differs from HEAD; a
  failed commit restores the file, one that landed is kept, and text it did
  not write is never reported as recorded.
  - What was athya_mono's is now settings, under `"cubicDismiss"`: the
    dismiss file, the commit subject and the trailer's word for the owner's
    decision (`alok` there, `owner` by default).
  - Changed: `--from` must be a file in the repository, since its titles
    are committed and pushed by a command an allow rule runs without a
    prompt. A repository with no dismiss file yet gets one from the first
    dismissal, and a failed first commit removes it again, since an empty
    file left behind is untracked and would refuse every rerun.
  - athya_mono's faults suite is a sweep here: each git call fails in turn,
    the run never exits 0 without the commit, the file is as it was or as a
    clean run leaves it, and a rerun converges on one commit.
- **2026-11-14 — Record: Claude cloud sessions install niyam themselves
  (P-60, Work item #331, slices #333 and #334).** Alok, after onboarding
  veda (veda-hq/veda#73): "people will not do 100 steps to get onboarded."
  onboard ended with a Setup-script paste and a GitHub connection for cloud
  sessions, plus the review routine. Claude Code has no API, CLI or repo
  file for a cloud environment's Setup script, but a repo's SessionStart
  hooks run in cloud sessions.
  - When `CLAUDE_CODE_REMOTE=true` and no CLI is found, the SessionStart
    hook runs the clone's `.github/niyam/cloud-setup.sh`, which onboard
    already keeps at the pin, then `session-start`. `session-start` already
    ran that file for a wrong release (#165, #166); this covers no CLI at
    all. The change is all inside `HOOK_COMMAND`, one shell string with no
    new settings field, so veda-hq/niyam#318 can move it into
    `.claude/sarathi.json` as it is.
  - onboard no longer asks for the paste. `niyam cloud-setup` stays, as an
    option: Claude caches what a Setup script installs, not what a hook
    does. `doctor` marks a Setup script that does not run the file `✓`.
  - "By hand:" keeps the claude.ai GitHub connection, once per claude.ai
    account (Alok's decision (a) on #331), and the review routine, once per
    repository (decision (b)). Each line says the whole step in one sentence
    on standard output, with its link.
  - Cost: a session in an environment without the paste downloads about
    50 MB at each start. Claude's hooks time out after 600 s. The install
    writes to `/opt/niyam` and `/usr/local/bin`, so it needs the hook to
    run as root, which the docs do not say, so the pull request waited on
    one real cloud session to prove it.
  - Rejected: installing `@veda-hq/niyam` from npm, published with
    provenance since 0.6.16 (P-59), as the install path, since the release
    tarball is pinned by sha256 already; it is the fallback if a hook cannot
    write there or reach the release. Also
    rejected: a claude-code-action weekly job in place of the routine,
    which would store the agent's token and an Anthropic credential as
    Actions secrets (decision (b)).
- **2026-11-15 — Record: the release publishes to npm by trusted publishing
  (State #342 of P-59).** 0.6.16 put `@veda-hq/niyam` on npm with the
  `npm` environment's token. Alok then set up trusted publishing for it on
  npmjs.com (veda-hq/niyam, `release.yml`, environment `npm`) and deleted the
  token, so the Release workflow publishes with GitHub's OIDC token alone, as
  veda's does. The `npm` environment stays: the trusted publisher names it,
  and only `v*` tags may deploy to it.
- **2026-11-15 — Record: `pr-autocreate` (W-56.4, Work item #320, slice
  #327).** athya_mono's `scripts/lib/pr-autocreate.py` becomes TypeScript
  here, and athya_mono deletes it; no Python is needed. What it leaves alone
  and when it speaks are unchanged. Its records in `.tmp/pr-autocreate/`
  keep their names and fields, so the desktop app's mods read them as
  before.
  - What was athya_mono's is now settings, under `"prAutocreate"`: the base,
    draft or ready, protected branches, skipped prefixes, the old opt-out
    variable (`ATHYA_PR_AUTOCREATE` there), how the session describes the
    pull request, the page on retired branches and a body footer.
    `NIYAM_PR_AUTOCREATE=0` always opts out.
  - Changed: pull requests are listed, opened and read through GitHub's REST
    API everywhere, not `gh pr` on a laptop and `gh api` in the cloud. A
    session's hook takes the agent's token from `as-agent`'s checks
    in-process, instead of running gh through the launcher; the watcher
    takes the push's GH_TOKEN, or gh's signed-in account.
    The token is looked up only when GitHub is asked, so a turn whose
    record and ack answer reads no session file or token store.
  - Changed: GitHub's "no commits between" answer, and a branch with nothing
    ahead of the base, give the watcher a note and no retry.
  - Changed defaults: `gh-readonly-queue/` (GitHub's merge queue) is skipped
    beside `mergify/`; the configured base is never given a pull request
    even when not in `protected`; the placeholder body has no footer unless
    the settings give one; a push command is read by the guard's shell
    reader, not Python's `shlex`.
  - A cloud session is told by `CLAUDE_CODE_REMOTE=true`, as everywhere in
    niyam, not by athya_mono's `cloud-check.sh` (spoofed flags on a laptop).
    A laptop that sets the flag gets the cloud's wording and a Stop that is
    never held, and the proxy's placeholder token, as `as-agent` gives it
    there, which GitHub refuses: no pull request opens.
  - The command exits 0 on its own errors, bad arguments included, so no
    hook holds a session or fails a push for them.
- **2026-11-15 — Record: `keep-going` (W-56.5, Work item #320, slice
  #329).** athya_mono's `scripts/lib/slice-keep-going.ts` moves here as
  `niyam keep-going`, and athya_mono deletes it. When it sends a session
  back, what it says is left, and when it lets one stop, are unchanged,
  including the cap of five at one commit and the stop note it then writes.
  - What was athya_mono's is now settings, under `"keepGoing"`: the base,
    other trunks (`prod` there), the old print-mode variable
    (`ATHYA_PRINT_MODE`), the owner's name in the messages and the tag that
    ends them. `NIYAM_PRINT_MODE=1` always means print mode.
  - Changed: the pull request is read over REST everywhere, as the session's
    agent with `as-agent`'s checks in-process, not through gh and the
    launcher. With no agent it reads as "GitHub cannot say", and the stop
    goes through, as a refused gh did, with the `niyam doctor` hint on
    standard error. Each page is bounded at 15 s, ten pages at most.
  - Changed: with no `base` set, the base is origin's default branch
    (`origin/HEAD`), else `main`. Its own records and pr-autocreate's are
    left out of "uncommitted work", for a client that does not ignore
    `.tmp/`.
  - Changed: its records move from `.tmp/slice-keep-going/` to
    `.tmp/keep-going/`. A stop note written by the old copy is not read; it
    voided at the next commit anyway.
  - A cloud session is held as on a laptop (athya_mono's W-44), and is told
    by `CLAUDE_CODE_REMOTE=true` without `cloud-check.sh`, which only chose
    gh's REST over GraphQL there.
- **2026-11-15 — Record: a niyam release comes only from main (P-61, Work
  item #303, slice #308).** A `v*` tag could be pushed on any commit, and
  the Release workflow's "tag is on main" test ran from the tagged commit's
  own file, so a tag off `main` skipped it. That tag's release could reach
  clients through `niyam upgrade`, and npm.
  - The Release workflow runs on a push to `main` whose `package.json`
    version has no tag yet. It runs `pnpm check`, makes the annotated tag
    (`niyam X.Y.Z`) on that commit through the API as github-actions[bot],
    publishes to npm and makes the GitHub release. A release is the merge of
    its version bump; agents push no release tags. A first job with no
    environment decides, so a push that bumps nothing never waits at the
    `npm` environment. Each step skips what is done, so a re-run finishes a
    release that stopped; a tag already on another commit fails it.
  - npm stays trusted publishing (OIDC) from `release.yml` in environment
    `npm`, with no token. Its provenance now records `refs/heads/main`, not
    `refs/tags/vX.Y.Z`. By hand, Alok: the `npm` environment's deployment
    rule moves from `v*` tags to `main`, before the next version bump merges,
    or that run fails at the gate (a re-run then finishes it).
  - `niyam upgrade`, before it installs, and `niyam onboard`, before it pins
    a release into the workflow and writes `.github/niyam/cloud-setup.sh` at
    it, ask `GET /repos/veda-hq/niyam/compare/refs/tags/vX.Y.Z...refs/heads/main`
    with no token, both refs in full so a branch named like the tag, or a
    tag named `main`, is never the one compared.
    The tag's commit is the comparison's base, and it is on `main` exactly
    when the status is `ahead` or `identical`. Otherwise each refuses,
    naming the tag and the commit; no such tag, and no answer from GitHub,
    are refusals too, with their own words, and nothing is installed or
    changed. The cloud session installs only the tarball whose sha256
    onboard pinned after that check, so it asks nothing itself. `doctor`
    does not ask.
  - The workflow's tag is annotated, not signed, unlike the tags AthyaBot
    pushed: what vouches for a release is that its commit is on `main`.
  - Tag creation stays open: not checked by hand, since AthyaBot is not an
    admin and changes no ruleset. The "release tags" ruleset holds `v*`
    against deletion, update and force-push, not creation; its bypass list
    reads as empty, which GitHub may only show admins. The rulesets REST API
    takes a bypass actor as a type and an id (an app, a role, a team,
    organisation admins, deploy keys), with no way to name one workflow or
    branch. GitHub Actions (app 15368) can be written as an
    `Integration` actor, but GitHub's docs never name it as a bypass, and
    reports from November 2026 say GitHub refuses it with a 422 on repos a
    user owns; on an organisation's repo, as this one is, it is unconfirmed.
    Even where it is taken, it lets every workflow with `contents: write`,
    on any branch, make a `v*` tag, not this workflow alone. The one way to
    name a single workflow is a GitHub App of our own as the only bypass,
    whose key only `release.yml` reads from the `npm` environment. That is
    a new secret and an owner step, left for a slice of its own. Until
    then the two points above hold: npm takes only `main`'s runs, and
    clients refuse a tag off `main`.
- **2026-11-15 — Record: the Guard check (P-62, Work item #303, slice
  #304).** Alok, 2026-11-14: "I believe in enforcing the checks and
  balances in automated fashion via tests, hooks, etc." A pull request ran
  its own copy of the checks that judge it, so turning `run: pnpm check`
  into `run: true` or emptying a test went green and auto-merged. The
  `guard` workflow runs on `pull_request_target`, from `main`'s copy, and
  its job `Guard` runs `scripts/guard.mjs`: a change to a guard file
  (`.github/`, `.githooks/`, `.dvara.json`, `.dvara/records-baseline.json`,
  `.gitleaks.toml`, `.trufflehog-exclude`, `package.json`'s `scripts`,
  `scripts/*.mjs`), or one that deletes a test file, leaves it fewer
  `test(`/`it(` calls or adds `.skip`, `.only` or `todo`, passes only when
  the slice names the file in a `**Guards:**` section.
  - The section counts as it stood when Alok last put `approved` on the
    Work item, read from the slice's GraphQL revisions, whose `diff` holds
    the whole body at each. A slice added after that counts from Alok's
    first unedited `Decision:` since, on the slice or on the Work item
    naming it. Revisions GitHub cuts short, or GraphQL not answering,
    refuse.
  - It reads the pull request from the API and checks out `main` alone, so
    the base repository's token never meets the pull request's code. Its
    permissions are `contents`, `pull-requests` and `issues: read`. It
    installs `main`'s lockfile with `--ignore-scripts` for `yaml`, since a
    line scan for job names is easy to evade.
  - Patches and `package.json` are compared with the merge base, not
    `main`'s tip, so a branch behind `main` is not refused for what `main`
    changed since.
  - It fails closed: a file list shorter than `changed_files`, any read
    that fails, a workflow that does not parse, or a `main` ruleset it
    cannot read.
  - It refuses any added job that reports a check `main`'s ruleset
    requires, or `Guard` itself, by its name, a matrix leg or a reusable
    workflow's job under it, or by a name that is an expression.
  - Two changes pass unnamed. Dependabot's (`dependabot[bot]`) when every
    changed line only moves a `uses:` to another full sha of the same
    action, with its version comment. Onboard's
    (`chore(niyam): onboard at vX.Y.Z`) when every changed line only moves
    older versions to that release (other versions on a line stay), and any
    sha256 with them, at least one version moves, and the tag `vX.Y.Z`,
    read as a tag and not a branch of that name, is a commit on `main`. The sha256 is not checked against the release:
    the tarball URL can only move to that release, and a wrong sha256 fails
    the install.
  - Guard first reports on the pull request after this one. Once it passes
    on the first one merged after it, Alok runs
    `niyam owner-step required-checks veda-hq/niyam main --check "Guard"`
    (or uses the ruleset page until #314 is released).
- **2026-11-15 — Record: CODEOWNERS holds a change to the guard itself for
  Alok (P-63, Work item #303, slice #309).** Guard (P-62) judges a change to
  niyam's checks against the slice's `**Guards:**` section, but it cannot
  tell whether a change to its own rules weakens them. That is the one
  change automation cannot judge, so it needs Alok's yes.
  - `.github/CODEOWNERS` names `@AlokBansal8` for the guard's files only:
    `/.github/workflows/guard.yml`, `/scripts/guard.mjs`,
    `/scripts/guard.test.mjs` and `/.github/CODEOWNERS`. Nothing else gets an
    owner, so every other pull request, including one under `.github/` that
    Guard passed, merges without a person.
  - The paths are anchored at the root, so no file of the same name
    elsewhere is caught. A file the guard comes to read later (a fixture, a
    helper module) needs its own line in the same pull request.
  - By hand, Alok: turn on "Require review from Code Owners" in the `main`
    ruleset's pull request rule (Settings, Rules, ruleset `main`). No
    `niyam owner-step` does this. Until then CODEOWNERS only requests his
    review; it does not hold the merge.
- **2026-11-15 — Record: only niyam's own GitHub App creates a release tag
  (P-64, Work item #303, slice #351).** P-61 left tag creation open: a
  ruleset cannot name one workflow as its bypass, and GitHub Actions as a
  bypass would let every workflow on any branch make a `v*` tag. So
  Dependabot or Renovate could still move a client's `checks.yml@` pin to a
  tag off `main`, which only `upgrade` and `onboard` refuse.
  - A GitHub App of veda-hq's, installed on this repository alone with
    Contents: write, is the one bypass of the "release tags" ruleset's
    `creation` rule. Its client id and private key are the `npm`
    environment's variable `RELEASE_APP_CLIENT_ID` and secret
    `RELEASE_APP_PRIVATE_KEY`, which only `main`'s Release run can read.
  - `release.yml` mints the app's token with
    `actions/create-github-app-token` (v3.3.0, by sha), scoped to
    `contents: write`, and makes the tag with it alone; npm and the GitHub
    release keep `GITHUB_TOKEN` and OIDC. With no id or key the release
    stops before the tag, naming which is missing: there is no fallback to
    `GITHUB_TOKEN`, which the ruleset refuses once the rule is on.
  - Alok, by hand, since AthyaBot is not an admin: the app, its install and
    the two values before this merges; the `creation` rule, with the app
    as its only bypass, after one release has tagged with the app's token,
    since a rule added first would stop that release at the tag. AthyaBot
    then reads the ruleset: `creation` in its rules, and
    `current_user_can_bypass: never` for itself.
  - Cost: a leaked key could make a `v*` tag. The environment keeps it from
    branch workflows, and P-61's compare check still refuses a tag off
    `main` in `upgrade` and `onboard`.
- **2026-11-15 — Record: an ask's run leaves needs-owner off where the
  owner already answered it (State #355 of P-40).** On #303 the owner took
  `approved` off and put it back nine and eleven seconds after an agent's
  `Needs you:`. The approval's run found no `needs-owner` in its event and
  took nothing off; the ask's run, still going, then labelled the issue, and
  the label stayed until it was taken off by hand. The hourly sweep does not
  count the `approved` label, so it never would have. Now the ask's run, for
  a comment on an issue whose event gives its id and time, reads the issue's
  events, its comments since the ask and the ask's 👍s before it labels the
  issue, and leaves the label off when the owner put `approved` on it, wrote
  a `Decision:` no one but owners edited, or 👍'd the ask after it. It reads
  them again after labelling and takes the label off when an answer landed
  between the read and the label, where the approval's run, whose event
  predates the label, could not. A review comment's ask, already labelled
  issue, or event with no id or time labels as before. Rejected: a
  concurrency group on the job (GitHub keeps one pending run a group and
  cancels the rest, so an event could be dropped), and the sweep counting the
  `approved` label (new behaviour the owner sees, not this fix).
- **2026-11-15 — Record: an ask's run counts the owner's batch answer too
  (State #357 of P-40).** #355 left one answer out of the ask's run: the
  owner's `Decision: approve #N` on the Approvals issue. Its own run sweeps
  only issues already labelled, so a batch answer landing while the ask's
  run was still going left `needs-owner` on until the hourly sweep. Now the
  ask's run, after the issue's own answers find nothing and where the
  settings name an Approvals issue, reads that issue's comments since the
  ask and counts an owner's batch answer made after it whose first line
  names the ask's issue (a `Proposal:`'s, the issue its first line names, as
  the sweep reads it) that no one but owners edited, before labelling and
  again after. An Approvals issue GitHub cannot find answers nothing.
- **2026-11-15 — Record: `owner-step --check` leaves out a cancelled run a
  later success replaced (State #358 of P-58).** Guard (P-62) runs with
  `cancel-in-progress`, so a pull request opened and edited within seconds
  has two latest Guard runs, each in its own check suite: the first
  `cancelled`, the second `success`. `--check` wanted every latest run to
  pass, so it refused Guard on #353, where it had passed. Now a `cancelled`
  run is left out when a run from the same app started after it and
  concluded `success`. A cancelled run nothing later replaced, any other
  conclusion, and a second app still refuse. Rejected: dropping
  `cancel-in-progress` from `guard.yml` (a guard file, and a stale run
  could then finish last and show an old verdict), and ignoring every
  cancelled run (one that nothing replaced proves nothing).
- **2026-11-15 — Record: agents turn auto-merge on for every pull request
  (P-65, Work item #303, slice #305).** Alok, 2026-11-14: "I'll not read the
  PRs which would come my way." With Guard (P-62) required on `main`, an
  agent holding a `.github/` change by hand only left it waiting, as #301
  waited.
  - `CLAUDE.md`'s Merging section: auto-merge goes on right after
    `gh pr create` for every pull request, `.github/` changes included.
    Guard and the other required checks decide whether it merges, and
    CODEOWNERS (P-63) holds a change to the guard itself for Alok.
  - An agent leaves auto-merge off, saying why in the pull request, only
    where Alok's yes is needed for a reason no check sees: a new dependency,
    vendored third-party code, or a major release.
  - The section no longer says a merge publishes nothing: since P-61,
    merging a version bump releases it.
- **2026-11-15 — Record: where sarathi runs the hooks, onboard writes
  niyam's into `.claude/sarathi.json` (P-66, Work item #368, slice #318).**
  Onboarding veda (veda-hq/veda#73) put niyam's SessionStart and Bash
  PreToolUse hooks beside sarathi's entries in `.claude/settings.json`,
  where veda's rule is one hook per event, sarathi, running the handlers
  `.claude/sarathi.json` lists; a move by hand came back at the next onboard.
  - sarathi runs an event where `.claude/sarathi.json` exists and the
    settings run `sarathi hook <Event>` or `.claude/hooks/sarathi.sh
    <Event>` for it, read as `sarathi check` reads it, with a matcher that
    lets niyam's hook fire. There, `claudeSettings` writes the hook as a
    handler, swaps an older command in place from the same older lists,
    takes niyam's hooks out of the settings, and raises sarathi's own
    entry's timeout to the handler's when shorter. The lock and the
    permission rules stay in the settings.
  - The SessionStart handler has `"timeout": 600`, the time Claude Code
    gives the hook in the settings: sarathi's 60 s default is short of
    session-start's 180 s drift install and a cloud session's install. The
    guard handler keeps 60 s, as it reads only local state, and has
    `failClosed`.
  - Checked first against sarathi 0.6.9, veda's pin: a handler gets
    `CLAUDE_ENV_FILE` (sarathi passes its environment on); a SessionStart
    handler's plain stdout reaches the session (or `additionalContext`);
    exit 2 with stderr is a refusal; and `timeout` has no cap.
  - `doctor` reads both files: its check for hooks reaching GitHub outside
    `as-agent` reads sarathi's handlers too, and it warns about a hook in
    both files for one event, which runs twice.
  - Rejected: adding a sarathi entry to the settings where none runs an
    event (that is the project's choice of hooks, not niyam's), and moving
    niyam's hook where sarathi's matcher would hide it (a SessionStart entry
    for `startup` alone would skip session-start on resume).
- **2026-11-15 — Record: niyam's writers refuse a symlink out of the git
  toplevel (P-67, Work item #366, slice #360).** kavach 0.6.9
  (veda-hq/veda#95) lets `cubic-dismiss`, `handoff --record` /
  `--assert-fresh` and `keep-going --stop` run from an owned worktree, on the
  audit's claim that niyam writes only under the git toplevel. A link broke
  that claim. Examples are a committed `.cubic-dismiss` link, a ledger under
  a linked folder, or `ln -s <outside> .tmp/push`, which kavach allows
  because the link itself is inside.
  - `Sys.confine(root, path)` finds the nearest part of `path` that is
    there, by `lstat`, so a link that leads nowhere counts. It follows its
    links and throws unless the real path is the toplevel's real path or
    lies under it, compared by whole segments. The error names the path,
    where it leads and the toplevel. A link that cannot be followed is
    refused, since a write through it would create its target wherever it
    points.
  - `cubic-dismiss` checks its ledger before reading or writing it and
    refuses with exit 1. `handoff` checks the run log before it judges a
    push or opens a `--open-brief` issue, and again at the append.
    `keep-going --stop` says no note was written. The Stop hook checks its
    counter and the stop note before either is read. It still fails open,
    but says why.
  - The check and the write are separate calls, so a link made between them
    is not seen. The gap it closes is a link made before niyam runs, as
    kavach allows; a process racing niyam inside the worktree is out of
    scope.
  - Rejected: checking after `mkdir` (a linked `.tmp` would already have a
    folder made outside), and `existsSync` to find the nearest part (it
    follows a link, so a dangling one would pass). `pr-autocreate` writes
    under `.tmp/pr-autocreate` the same way but is not a command kavach
    lists; it is left for its own slice.
- **2026-11-15 — Record: any agent runner gets the agent identity and the
  lock (P-68, Work item #367, slice #50).** On 2026-10-31 the owner kept
  Claude Code the only runner: "Athya's agents run in Claude Code only",
  open for adoption outside Athya. The `approved` label on #367 reopens it.
  The identity and the lock reached a session only through Claude Code's
  SessionStart hook and `CLAUDE_ENV_FILE`, so an agent run from Codex,
  Cursor, Copilot's agent, Aider or a script acted as the owner until PR
  identity caught it after the push.
  - `niyam env` prints the lines session-start gives a Claude Code session,
    from the same code (`localIdentity`): the lock, then the session file
    `machine` wrote, checked as session-start checks it. Claude Code's hook
    is one integration of it. The lines hold the keychain's read command,
    never the token, which the shell reads itself; a test checks a known
    token is in no output.
  - `niyam env -- <command>` runs the command under them through `/bin/sh`,
    so a runner started that way cannot start without niyam;
    `eval "$(niyam env)"` with niyam missing evaluates nothing, so the
    README leads with the wrapper. Printed, the lines carry no comments and
    each ends in `;`: unquoted, `eval $(niyam env)` had evaluated nothing
    after the lock's opening comment, which swallowed the rest once the
    shell turned newlines into spaces. Under `set -x` the eval form traces
    the token as it is exported; the wrapper's shell traces nothing. Every
    failure of env's own check still
    prints the lock, or runs nothing. Printing exits 0 as the agent and 77
    (P-43's locked code) otherwise; running exits with the command's code,
    and runs it locked when it cannot work as the agent, as a Claude Code
    session starts locked.
  - No hook changes: the session file sets `NIYAM_AGENT`, which the pre-push
    hook already reads. Other runners have no PreToolUse guard; the lock and
    the pre-push hook hold there, as for a script in Claude Code (P-17). A
    runner never started through `niyam env` still acts as the owner (P-18).
  - Rejected: a second command, `niyam run`, doing what `env --` does;
    printing the token itself, which would land in scrollback and runner
    logs; and per-runner integrations (Cursor rules, Codex config), many
    and changing, where one shell entry point covers them all.
- **2026-11-15 — Record: pr-autocreate refuses a symlink out of the git
  toplevel (P-69, Work item #366, slice #375).** The writers P-67 fixed run
  only when someone types the command. pr-autocreate runs from git's
  pre-push hook and Claude Code's PostToolUse and Stop hooks on every push.
  So after `ln -s <outside> .tmp/pr-autocreate`, which kavach allows, the
  next push wrote there. Its stale-lock cleanup could also delete a file
  outside.
  - `withLock` runs `Sys.confine` on the branch's lock, record and opt-out
    paths before it makes the folder or takes the lock. A link stops the
    decision before GitHub is asked, so no pull request opens. The Autofix
    ack and the watcher's `watch.log` are each checked before their folder
    is made.
  - The hooks keep their exits. The Claude hook says why on standard error
    and exits 0. `spawn-watchers` warns that it could not record the push
    and starts no watcher. An opted-out push it cannot record is still
    refused (exit 3), as with any other write failure there.
  - Rejected: checking only `.tmp/pr-autocreate` itself. A linked record
    file or lock inside a real folder would still pass that check.
- **2026-11-16 — Record: a slice moves to In Progress when its pull request
  opens (P-70, Work item #399, slice #395).** A Claude cloud session's GitHub
  proxy lets through only `repos/{owner}/{repo}/…`, so its push never reaches
  an organization's Projects (veda-hq/veda#102). Every slice built in the
  cloud skipped In Progress. The Done move needs no project token: the
  merged job closes the slice with `GITHUB_TOKEN`, and the Project's Item
  closed workflow moves it. A workflow's `GITHUB_TOKEN` cannot write an org
  Project, so on 2026-11-16 the owner chose a GitHub App for the started
  move.
  - The shared workflow's Slice started job runs `pr-started` on a pull
    request opened or reopened from the repository itself, read-only like
    the other pull request jobs. It moves the board as the pre-push move
    does (`boardStarted`), and only when the pull request names one slice,
    board and work-rules are on, and the slice passes the work rules, read
    with `GITHUB_TOKEN`.
  - The board is written with a token minted from the board app
    (`actions/create-github-app-token`, organization Projects write and
    Issues read). The app reaches the shared workflow as two optional
    secrets, `NIYAM_BOARD_APP_ID` and `NIYAM_BOARD_APP_KEY`, as
    `FIGMA_TOKEN` does. The token step runs only where the client id is
    passed. A token GitHub will not make, a missing secret or a board error
    is reported in one line, and the job passes: the board never fails a
    pull request. Until onboard passes the secrets (#397), the job reports
    that line.
  - The pre-push move stays the early path on the desktop. On the proxy's
    "sessions are bound to their configured repositories" 403, it prints a
    short note that the workflow moves the slice when its pull request
    opens.
  - Rejected: a fine-grained token of the agent's, which expires and belongs
    to a person; and the Project's own "Pull request linked to issue"
    workflow, which needs a closing keyword in each pull request and never
    moves the Work item's Step.
- **2026-11-16 — Record: onboard passes the board app's secrets (P-71, Work
  item #399, slice #397).** P-70's Slice started job gets its token only
  from secrets the client workflow passes, and the owner does not edit that
  workflow by hand.
  - With `board` on, onboard writes `NIYAM_BOARD_APP_ID` and
    `NIYAM_BOARD_APP_KEY` under the `niyam` job's secrets, after the Figma
    ones. Only the `niyam` job runs on a pull request opening, so the weekly,
    merged and asks jobs pass Figma's alone. An upgrade rewrites a block of
    onboard's own secrets and leaves one with a secret of the client's own,
    or `secrets: inherit`, as it is. The plan names a board change apart from
    a Figma one.
  - Every write of the two lines also moves the pins to onboard's own
    release. A caller that passes a secret its pinned `checks.yml` does not
    declare is refused by GitHub, and releases up to 0.6.22 declare neither.
  - Onboard lists the names of the repository's secrets and of the
    organization's secrets shared with it, never their values, as the agent.
    For each board secret missing there, its by-hand list and its pull request
    give the once-per-organization steps: make the app (organization Projects
    read and write, repository Issues read), install it, and set its client id
    and private key. Where GitHub will not list them, the steps say "unless set
    already". A personal repository gets none, since its checks skip the work
    rules.
  - `niyam doctor` marks a missing one ▲ in an organization's repository with
    board on, and a read that fails ▲ too. Neither changes the exit code: the
    desktop push still moves the board.
  - Rejected: onboard setting the secrets itself, since only the owner holds
    the app's private key; and `secrets: inherit`, which would hand the
    shared checks every secret of the repository.
- **2026-11-16 — Record: onboard makes the agent's cloud signing key (slice
  #417, Work item #22).** Alok asked why `onboard` does not do what
  `niyam cloud-key` does. Unlike `machine` (2026-11-06), `cloud-key` needs
  nothing pasted and no answer beyond one yes, so `onboard`'s one yes, and
  `--yes`, can cover it.
  - The key is the agent's: one `NIYAM_SIGNING_KEY` line serves every cloud
    environment. `onboard` reads the agent's own list of signing keys with
    the agent's token and plans a key only when none is titled
    `niyam cloud signing`; with one, it says nothing about it.
  - It is the last step, after the pull request opens, through
    `cloud-key`'s own code. A failure only warns and names
    `niyam cloud-key <agent>` under "By hand:"; nothing before it is undone.
  - Where `cloud-key` would refuse (a Claude Code or cloud session), and in
    a dry run, `onboard` plans no key and names the command instead. A Mac
    with no token store never gets that far: `onboard` refuses it first.
  - A list GitHub does not give makes no key, since there may be one
    already: the plan warns and names `niyam cloud-key <agent>`.
- **2026-11-16 — Record: onboard makes the board app from a manifest
  (P-72, Work item #430, slice #429).** Alok onboarded athya_mono and
  asked "Why is there so much by hand work. Ideally there should be no work
  by hand." P-71's by-hand board app step was a dozen fields and two
  pastes. GitHub's manifest flow makes an app from a JSON manifest with one
  click and redirects with a one-time code, which onboard exchanges with
  GitHub's API for the client id and private key: the key never reaches the
  browser. That turns P-71's rejected "onboard setting the secrets itself"
  into the way it works.
  - With the owner at their own terminal, the doctor's ▲ for a missing
    board secret now says to run onboard there.
  - A repository's own secret of either name hides the organization's, and
    an organization with one of the two holds an app made before. In both,
    onboard makes no app and says what to delete or set.
  - With board on in an organization's repository that cannot see both
    secrets, and the owner at the terminal (not an agent's or a cloud
    session), the plan names `board app`, an owner step. The owner's
    sign-in already has `admin:org`.
  - Where the organization has both secrets, onboard shares them with the
    repository (they are `selected` secrets) and adds it to the
    installation of the app whose slug starts `niyam-board`, with no
    browser.
  - Otherwise onboard serves two pages on 127.0.0.1 for the run alone. The
    first posts the manifest to the organization's new-app page with a
    random `state`. The manifest is named `niyam board <org>`, asks for
    organization Projects write and Issues read, and has no webhook. The
    second takes GitHub's redirect, refuses one without the run's `state`
    or a second one, and turns the code into the app
    (`POST /app-manifests/{code}/conversions`). It sets the client id and
    key as organization secrets visible to the repository alone, then sends
    the browser on to the install page. The key is never printed or
    written to disk. onboard waits for the installation and adds the
    repository to it when the owner chose selected repositories.
  - Every wait is ten minutes. A click that does not come, or a step GitHub
    refuses, leaves the rest by hand with the reason. The step still
    passes, so the run and its pull request go on. Where an app was made
    but its secrets could not be set, the key is gone, so the step left by
    hand is to delete the app and run onboard again.
  - "By hand:" became a `◇ By hand` group before the closing `└`: numbered
    steps, wrapped to 80 characters (a count of characters, not of a
    terminal's columns), a link longer than a line on one of its own.
  - Rejected: secrets of the repository, which a second repository of the
    organization could not get without the key again; and a `setup_url` to
    learn of the install, which would stay on the app pointing at a closed
    port.
- **2026-11-17 — Record: Slice started runs after Work rules, on every event
  it runs on (P-73, Work item #426, slice #459).** P-70's job ran only when a
  pull request opened or reopened. On 2026-11-16, 3 of 7 slice pull requests
  failed Work rules at that moment (veda-hq/niyam#421, veda-hq/veda#172,
  veda-hq/veda#173), printed "may not be built yet", and never moved once
  Work rules passed. Built in a Claude cloud session, such a slice skips In
  Progress.
  - The `started` job has `needs: work-rules` and the same events as Work
    rules: any pull request action but `closed`, from the repository itself.
    The client's workflow already passes opened, synchronize, reopened and
    edited, so onboard and the clients' files do not change.
  - `needs` skips the job while Work rules fails. GitHub re-runs a job's
    dependents when the job is re-run, so re-running a failed Work rules,
    as an agent does after the owner's 👍, runs Slice started too. A 👍
    alone re-runs no check, as for Work rules itself.
  - `pr-started` still reads the work rules itself before it moves anything,
    since Work rules passes pull requests it does not judge. Moving stays
    idempotent: a field already at its option is not written, so a later run
    says the slice and its work item are where they belong.
  - `boardStarted` says when no open Project of the owner holds the slice,
    unarchived, with a Status field, rather than let nothing moved read as
    "where they belong" (veda-hq/niyam#420, veda-hq/veda#168). The desktop
    push prints the same line. Adding the issue to the board stays #407's.
  - Where the caller passes the board app's secrets, each Slice started job
    mints a board app token and reads the owner's Projects through REST: a
    few calls a push, well inside the app's hourly limit.
  - Rejected: the explicit list opened, reopened, synchronize and edited,
    which would drift from Work rules' own events; running on the owner's
    👍 (`issue_comment` reactions start no workflow, and the hourly sweep
    has no pull request to judge); and moving the board from the Work rules
    job, which would put the board app's token, and its failures, into a
    required check.
- **2026-11-17 — Record: onboard sees the review routine by its verdicts
  (Work item #430, slice #458).** The review routine was the last by-hand
  step on athya_mono, and onboard printed it on every run after it ran.
  Alok asked that onboard stop listing it once it is set up. Claude's
  routines API answers only a Claude Code session's own sign-in, so onboard
  looks for the routine's trace on GitHub instead.
  - With the agent's token, onboard reads the repository's issue comments
    of the last 21 days (three weekly runs), newest first, at most ten
    pages of 100. A comment by the agent, in any case of its login, that
    starts `Kept:`, `Settled:` or `Held for ` (the verdicts in
    `routines/review.md`) is the trace. `since` is by last update, so a
    comment created before the cutoff does not count.
  - Seen: the routine is under neither "By hand" nor the pull request's
    "Left to do by hand". "Done at the terminal" names the issue and date.
  - Not seen, or GitHub refuses or fails: the step stays, its terminal line
    ending "skip it if done", as the claude.ai line does. Being wrong there
    costs one line the owner skips; a check that blocked would cost a run.
  - A routine with no decision due in three weeks leaves no trace and is
    listed again; the line says to skip it.
  - Rejected: widening the weekly job's verdict match to `Held for`, which
    would take off the `needs-owner` the routine's own hold puts on.
- **2026-11-19 — Record: the issue-type job waits for an issue's opener
  (Work item #466, slice #467).** On #453 an agent typed the issue Work item
  with `gh api` about ten seconds after `gh issue create`. In the same second,
  the `Issue type` job, started by the `opened` event, read the issue with no
  type and wrote Brief. Both writes saw an issue with no type, so a read
  just before the write alone would not have caught it.
  - On `opened` or `reopened`, an issue found with no type is read again
    after 30 seconds (`OPENER_WAIT_MS`). The job decides from that read:
    type, parent and sub-issues. An issue with a type exits at once.
  - Every write, the hourly sweep's too, reads the issue just before it and
    writes only to one still open with no type.
  - The sweep leaves an issue GitHub shows changed (`updated_at`) under 30
    seconds before, so it cannot beat that issue's own run to it. Not
    `created_at`, which a reopen leaves as the first opening. An issue
    edited in that time, or one no run started for, waits for the next
    hour.
  - GitHub's issue PATCH cannot be made conditional on the current type, so
    an opener whose type lands in the instant between the last read and the
    write can still lose it. A type written after the job's wins anyway.
  - Rejected: reading the timeline after the write and putting back another
    actor's type (timeline events lag the write, and a second write is one
    more to race); a shorter wait (#453's opener took ten seconds).
- **2026-11-19 — Record: one Guard, from a niyam release, for any repository
  (P-74, Work item #468, slice #469).** A client's pull request runs its own
  copy of the checks that judge it, and only niyam had Guard (P-62). Alok
  chose one Guard shipped from niyam, as `checks.yml` is, over a copy in
  each repository; org rulesets' required workflows cannot cross
  organisations, and veda-hq is on GitHub Free.
  - `.github/workflows/shared-guard.yml` (`workflow_call`, no inputs, no
    secrets) runs `scripts/guard.mjs` from niyam at `job.workflow_sha`, the
    commit GitHub resolved for the caller's `uses:`. It checks out nothing
    of the caller's and reads the pull request through the API with the
    caller's token. No `job.workflow_sha` refuses: unlike `checks.yml`, no
    fallback to an input, since the caller's file would then pick the code.
    Since 2025-12-08 GitHub runs a `pull_request_target` workflow from the
    default branch (changelog of 2025-11-07), so the pin is the default
    branch's.
  - The script refuses any event but `pull_request_target`, and reads the
    owners and the repository's own guard paths (`"guard"`) from the
    default branch's `.github/niyam.json` through the API, and the required
    checks from that branch's ruleset: the branch GitHub names as the
    repository's default, not `main`, since onboard takes any. The floor
    (`.github/`, `.githooks/`, `.husky/`, `lefthook.yml`, `package.json`'s
    scripts, the dvara, gitleaks and trufflehog settings) is fixed in the
    script; `scripts/*.mjs`, niyam's own, moved to niyam's settings, so
    niyam holds the same files before and after.
  - The onboard exemption's tag is read on `veda-hq/niyam`'s `main`, where
    the release is, whichever repository onboarded.
  - The check is `niyam-guard / judge`: GitHub names a reusable workflow's
    check `<caller job> / <called job>` (community discussion 29825; the
    docs say nothing, nor whether it takes the job's id or its name, so the
    caller's are the same). Neither job is `Guard`, which today's Guard
    refuses as an added job, and the caller is not `niyam`, `niyam.yml`'s
    job, which a pull request could point at a local workflow.
  - Only the caller as onboard writes it may report that check: a job that
    could report it must be in a workflow run by `pull_request_target`
    alone and only call `shared-guard.yml` at a release tag or a full sha,
    never a branch anyone with push to niyam could move. A ruleset can pin a
    check to an app, not an event, so a `pull_request` copy of the caller
    would report the same name from GitHub Actions; how GitHub weighs a
    failing and a passing run of one required name is not documented.
  - Its concurrency group, `niyam-guard-<number>`, is not `guard.yml`'s, so
    the two do not cancel each other while niyam runs both (slice #472).
  - Rejected: an input naming niyam's ref, as veda's `version-rule.yml`
    has (the caller would choose the code); a check posted by niyam's
    GitHub App (the later upgrade #468 names: it closes the same-name case
    for sure, but needs a service); per-repository copies of the guard.
- **2026-11-19 — Record: onboard writes the shared Guard's caller (Work item
  #468, slice #470).** Each client gets a thin caller,
  `.github/workflows/niyam-guard.yml`, which `niyam onboard` writes and moves
  with every other pin, and `niyam doctor` checks under "This repo".
  - It was written only with `work-rules` on (`callerWanted`), an
    assumption, not the owner's word. Superseded by the record below (slice
    #485): every onboarded repository gets it.
  - `branches:` names the repository's default branch, which onboard reads
    from GitHub as it does for `niyam.yml`'s pushes, not `main`: the shared
    Guard reads the settings and ruleset of the default branch, whatever its
    name, and a caller on `main` alone never runs where it is another.
    Doctor is offline, so it checks the caller's branch against the one
    `niyam.yml`'s pushes run on, which onboard keeps at the default branch;
    where those name several, which onboard leaves as they are, it checks
    the rest and not the branch.
  - Onboard and doctor share one renderer and one reader (`guardCaller`,
    `callerAt`): a caller is as onboard writes it when it parses, as YAML,
    equal to onboard's render at the release and branch it names, so
    comments and layout do not count, and any other trigger, type, branch,
    permission, job, `with:`, `secrets:`, step, or pin other than a release
    tag of `shared-guard.yml` does; doctor marks the rest ✗. A file is
    onboard's when it is so or starts with onboard's header
    (`callerIsOnboards`): onboard writes it again, edited by hand or not, so
    doctor's fix, run onboard, holds. Onboard refuses any other
    `niyam-guard.yml`, naming it, and changes nothing; doctor's fix for it is
    to rename or delete it first. Its header names no release, so a run
    that moves the pin changes the `uses:` line alone, which Guard's onboard
    exemption takes as a version move.
  - A public repository, as `GET /repos/{slug}`'s `private: false` or
    `visibility: public` says, which onboard already reads for access, gets
    one by-hand step: allow `pull_request_target` for the caller under
    Settings → Actions → Policies, since from 2026-12-02 GitHub blocks it
    there without a policy. One GitHub does not call public gets none.
  - Rejected: writing it with any feature that writes `niyam.yml`, which
    would add a guard file Guard then refuses to change in a repository with
    no Work items to name.
- **2026-11-19 — Record: owner-step required-checks requires the shared
  Guard once it has passed (Work item #468, slice #471).**
  `niyam owner-step required-checks` requires `niyam-guard / judge` when the
  default branch's caller is as onboard writes it (`callerAt`), at the
  release `niyam.yml` pins and on the default branch, and the check reported
  `success` on the head of the last pull request merged there.
  - Its proof is `--check`'s (`passedOnPull`) plus one rule: the one app is
    GitHub Actions, and the ruleset requires it from that app. A lone other
    app reporting the name passes `--check`, and that is the spoof the shared
    Guard exists to stop, so `--check niyam-guard / judge` takes this path
    and never `--check`'s. For the same reason a ruleset requiring it
    already from another app, or from any, is not taken as done: on the
    same proof the entry is bound to GitHub Actions, and without it the
    entry stays and the step says so as a ✗.
  - It is gated on the caller file, not on `work-rules`: a repository with
    no caller is told nothing, unless the owner named the check, so the step
    says nothing new to a client that has not onboarded at a release with
    the caller. Doctor already marks that.
  - The swap of `Guard` for it is for niyam's own ruleset alone (`PRODUCT`).
    `Guard` is a common name, and the step keeps every other check, so a
    client's `Guard` stays. Its new entry is from GitHub Actions, not the
    old entry's app.
  - The caller runs on pull requests into the default branch alone, so the
    step says that a ruleset also targeting other branches would hold
    theirs; it does not read the ruleset's conditions to refuse that.
- **2026-11-19 — Decision: every onboarded repository gets the shared Guard,
  and one without work rules gets its refusals alone (Work item #468, slice
  #485).** Alok: "Every onboarded repo should get the Guard, not just
  work-rules ones." Asked how Guard judges a repository without work rules,
  he chose "Refusals only".
  - `onboard` writes the caller, and `doctor` checks it, whatever the
    features; `callerWanted` is gone. Where there is no `niyam.yml` to pin a
    release or name a branch, doctor checks the caller's shape alone.
  - Guard reads `features` from the default branch's settings
    (`workRulesIn`). With `work-rules` off it judges no slice, since there
    are no Work items to name one, and logs each change it would have asked
    one to name. It keeps the refusals no slice passes: a job added under a
    required check's name, a job that could report `niyam-guard / judge`
    other than onboard's caller, and too many files to list. No `features`
    means every feature on, so it judges as before; a value it cannot read
    refuses.
  - Rejected: the full rules everywhere, which hold every `.github/` change
    in a repository that cannot name a slice. Also rejected: an owner's
    review in place of a slice, which needs new code to read reviews.
- **2026-11-19 — Record: niyam runs the shared Guard through the caller its
  clients run (Work item #468, slice #472).** In order, so every niyam pull
  request stayed held by a Guard from `main` or a release:
  - 0.7.5 released #485 (#487). Alok allowed `pull_request_target` for
    `guard.yml` and `niyam-guard.yml` alone in the Actions policy "Guard on
    pull_request_target", since from 2026-12-02 GitHub blocks it in public
    repositories without one
    (https://github.blog/changelog/2026-11-02-pull_request_target-blocked-by-default-december-2,
    read 2026-11-19).
  - `onboard` at v0.7.5 added the caller (#490), and CODEOWNERS named Alok
    for it. `niyam-guard / judge` passed from GitHub Actions on #492, the
    next pull request merged, and Alok's `owner-step required-checks`
    replaced `Guard` with it in `main`'s ruleset.
  - Then `guard.yml`, which ran `main`'s copy of `scripts/guard.mjs`, and its
    CODEOWNERS line went. niyam's Guard now runs from its last release: a
    fix to `scripts/guard.mjs` holds niyam's pull requests once released.
    Guard still refuses a job named `Guard` (`OWN_CHECK`), which no longer
    reports anything here; dropping it changes `scripts/guard.mjs`, a slice
    of its own.
- **2026-11-19 — Decision: Guard no longer refuses a job named `Guard`
  (Work item #468, slice #494).** Alok: "file the slice to drop OWN_CHECK",
  then `Decision: #494 as written.` With `guard.yml` gone nothing reports
  `Guard`, and the shared Guard refused a client's own job of that name.
  Guard now refuses a job by a check's name only when the default branch's
  ruleset requires it, besides `niyam-guard / judge`, which it always keeps
  for onboard's caller.
- **2026-11-20 — Decision: Guard takes the owner's batch answer on the
  Approvals issue (Work item #468, slice #501).** Alok: "file the slice to
  make Guard read the Approvals issue", then `Decision: #501 as written`.
  - On athya_mono, `Decision: approve #3789` on Approvals issue #3376 passed
    the work rules, but Guard failed on #3806 until Alok repeated the
    Decision on #3789 itself.
  - For a slice added after its Work item's approval, Guard now also counts
    an owner's unedited comment on the Approvals issue (`"approvals": N`),
    made after the slice joined, whose first line opens `Decision: approve`
    and names it. It reads that line with the patterns of
    `src/approvals.ts`, which a test holds it to.
  - The earliest answer of the three places sets when **Guards:** counts
    from. An Approvals issue GitHub cannot find (404) counts nothing; any
    other failure to read it fails closed, so a lost read cannot let a later
    Decision pin a newer **Guards:**.
  - Guard stays stricter than the work rules here: an edited batch answer
    does not count, even one edited by owners alone.
- **2026-11-20 — Decision: Guard judges Mergify's merge-queue draft as the
  pull requests it tests (Work item #468, slice #507).** Alok: "We need to
  fix the guard", then `Decision: #507 as written.`
  - athya_mono #3821, the onboard at v0.7.7, passed Guard itself. Mergify
    tested it in draft #3822, which Guard judged as a pull request of its
    own, with no onboard title and no `Slice:` line. Mergify then dropped
    #3821 from the queue, and it was merged directly at 13:01Z.
  - With work rules on, Guard now judges such a draft's own diff once as
    each pull request its title names. It keeps a refusal only where every
    one of them leads to it, file by file. With work rules off, no slice is
    judged, so the draft is judged as itself.
  - It identifies a Mergify draft as PR identity does (`src/identity.ts`):
    `mergify[bot]`, a Bot; a `mergify/merge-queue/` head branch; and a head
    in the repository itself.
  - Rejected: passing the draft outright. The caller does not run on
    `ready_for_review`, so a pass would survive a writer pushing to the draft
    and merging it. Mergify also queues a pull request without needing Guard
    first.
  - Not done here: PR identity still skips these drafts without checking
    their commits.
- **2026-11-20 — Decision: the Guard caller's pin only moves forward to a
  niyam release (Work item #468, slice #512).** Alok: "file the slice to
  narrow CODEOWNERS", then approved #512.
  - The caller's pin picks which Guard runs. `isCaller` took any `v` tag or
    any commit sha, so a pull request whose approved slice named the caller
    could pin an older Guard, or an unreleased commit, and pass.
  - Only niyam's CODEOWNERS caught that. veda and athya_mono own no caller.
  - Guard now refuses, whatever the slice names, a changed caller pinned at
    anything but a `vX.Y.Z` tag on niyam's `main`, or at a release older than
    the default branch's copy pins.
  - `onboard` writes only forward moves, so its pull requests pass. With
    this released and onboarded, #513 drops the caller from niyam's
    CODEOWNERS.
- **2026-11-20 — Decision: Guard takes the owner's 👍 on the agent's
  proposal (Work item #468, slice #515).** Alok asked why he writes in some
  places and reacts in others, then: "Yes, file it", and `Decision: #515 as
  written`.
  - The work rules took the 👍 from P-20 (2026-10-31). Guard (P-62) read
    only `Decision:` comments, and P-62 gave no reason, so on #512 and #513
    he wrote a Decision on top of his 👍.
  - For a slice added after the approval, Guard now also counts an owner's
    👍 on a `Proposal:` comment by an agent the settings name, whose first
    `#N` is the slice. The 👍 must be made after the slice joined and after
    the proposal's last edit, as `thumbsUp` in `src/work.ts` reads it. A
    test holds `PROPOSAL` to `src/work.ts`'s.
  - The earliest qualifying answer, a 👍 included, sets when **Guards:**
    counts from, as for the other answers. Reactions are read only on a
    proposal that could come before the earliest other answer.
  - Settings with no `"agent"` count no 👍, and the refusal then offers
    none. A malformed one fails closed, and so does an agent that is also an
    owner, as `src/agent.ts` refuses it. So does any failed read of
    reactions but a deleted proposal's.
- **2026-11-20 — Decision: niyam's CODEOWNERS no longer names the Guard
  caller (Work item #468, slice #513).** Alok: "file the slice to narrow
  CODEOWNERS", then `Decision: #513 as written.`
  - niyam#511 and #522, niyam's onboards at v0.7.8 and v0.7.9, waited for
    his review only because CODEOWNERS named `niyam-guard.yml`.
  - P-63 gives an owner only to what Guard cannot judge. Since 0.7.9 (#512),
    in niyam's caller from #522, Guard holds, whatever the slice names, the
    job that can report `niyam-guard / judge` to the caller's shape as
    onboard writes it, and its pin to forward moves to a release on niyam's
    `main`.
  - Guard does not hold the rest of the file: another job added to it,
    as to any workflow, passes only when an approved slice names the file.
    That is the rule every workflow in niyam but `shared-guard.yml` already
    has with no owner. Cubic's review of #523 found the first wording ("judges the
    caller whole") overstated this.
  - He still owns the Guard's own rules: `shared-guard.yml`,
    `scripts/guard.mjs`, its tests and CODEOWNERS.
- **2026-11-20 — Decision: Guard's runs on Mergify's merge-queue draft never
  cancel each other (Work item #468, slice #526).** Alok approved #526 with a
  👍 on its proposal (19:27Z).
  - athya_mono draft #3829, testing #3828, had its body edited 19 times in
    five minutes by `mergify` and `blacksmith-sh`. Each edit ran the judge,
    whose one group per pull request with `cancel-in-progress: true` left 14
    of 19 runs `cancelled`. The check is required, so Mergify dropped #3828
    ("checks interrupted").
  - On a draft by `mergify[bot]`, a Bot, on a `mergify/merge-queue/` branch
    of the repository (`mergifyTests`'s checks but the title, since Mergify
    drops the pull request any such draft tests on a cancelled check), each
    run now has a group of its own; every other pull request keeps one group, its newer run cancelling
    the older. The draft's body is not judged, so the verdicts agree.
  - Rejected (GitHub Docs, workflow syntax, read 2026-11-20):
    `cancel-in-progress: false`, which still cancels the pending run; a
    group on the head sha, which an edit keeps; `queue: max`, refused with
    `cancel-in-progress: true`; and an `if:` skip, which reports success
    and would pass a draft over an earlier refusal.
  - Cost: each edit's run finishes, about 25 seconds and 5 API reads (20 or
    more for a guard-file draft) against the caller's token.
- **2026-11-21 — Decision: Guard and PR identity read Mergify's merged draft
  as the pull request it merged (Work item #468, slice #532).** Alok approved
  #532 with a 👍 on its proposal (09:41Z).
  - After merging #A, Mergify retitles its closed draft `merge queue: merged
    #A: <A's title>`. `mergifyTests` read only `checking`, so the edit's
    runs judged the draft as itself: Guard refused its guard files and PR
    identity the agent commits Mergify pushed. In athya_mono, Guard was red
    on every merged draft changing a guard file since 0.7.8 (#3800, #3812,
    #3831, #3839, #3841), PR identity on both merged since 0.7.10. Nothing
    gated on it: the draft is closed unmerged and its head reaches no branch.
  - With work rules off (`.github/niyam.json`), Guard still judges such a
    draft as itself, as it judges every draft there; PR identity reads it as
    the pull request it merged.
  - `MERGED_TITLE` reads the number after `merged #` alone; the rest is #A's
    author's own title. Only the single form is read: 116 of athya_mono's 200
    latest closed drafts are `merged #N: …`, the rest `checking #N`, none a
    batch or stack.
  - Rejected: Guard passing a closed draft unjudged, a pass on its head sha
    weaker than the title read (which still needs a tested pull request's
    approved slice) that leaves PR identity red; and an `if:` skip, which
    passes a required check (#526).
- **2026-11-21 — Record: doctor takes a hook that sets its gh to `as-agent`
  and runs `"$@"` as routed (State #537 of P-43).** `doctor` 0.7.12 in
  athya_mono warned that `.claude/hooks/sarathi-install.sh` reaches GitHub
  outside `as-agent`. It does not on a Mac: it runs `set -- gh`, then, where
  niyam's launcher is, `set -- "$agent" as-agent --session "$session" -- gh`,
  then `"$@" api …`. `hooksHittingLock` dropped the `as-agent` form and kept
  `set -- gh`, the cloud's fallback. It now drops `set -- gh` when the same
  judged text has the `as-agent` form, looked for after the cloud-only cut,
  so on a Mac a form past that exit excuses nothing. Every other command is
  still judged, so a plain `gh` beside it is named, and so is `set -- gh`
  alone. Read as text, so which `"$@"` runs which is not followed, the same
  limit as #211's helper rule. Rejected: taking the whole script as routed,
  as `routedByHelper` does, which would pass a plain `gh` beside it.
- **2026-11-21 — Decision: onboard follows a pre-push hook's one `dvara run`
  hand-off to a body that runs niyam (Work item #430, slice #540).** Alok
  approved #540 with a 👍 on its proposal (18:12:41Z).
  - athya_mono's W-61 (athya-hq/athya_mono#3814) moved its pre-push body to
    athya-rules, run by `exec node_modules/.bin/dvara run "$B" "$@"`. The
    body runs `"$cli" pre-push`, but `prePushHook` read only the hook, so
    onboard 0.7.12 (athya-hq/athya_mono#3852) listed a By hand step already
    done. Before W-61 the same line sat in the hook and read as `ours`.
  - dvara 0.6.18's `run` spawns `bash <file> <args…>` with stdin inherited
    and skips nothing, so the body is what the push runs. The follow is as
    strong as today's `ours`: the same line test, on the file git reaches.
  - One hop, one hand-off, a literal or one variable assigned once, inside
    the repository and present; any miss stays `own`. A false "already
    wired" leaves an agent's push unchecked, worse than a needless step.
  - A cloud session reads `body` as unchecked: athya-rules' body skips niyam
    when `CLAUDE_CODE_REMOTE=true`.
  - Rejected: a marker comment (asserts, never verifies); following every
    `exec`, `.` or `source`, or more hops (no client needs them).
- **2026-11-22 — Record: board-audit reads as the agent when `GH_TOKEN` is
  unset (State #548 of #408).** On 2026-11-22 the owner ran
  `niyam board-audit` in their terminal, right after `niyam machine` had
  signed them out of `gh`. It refused, and told them to run it with
  `GH_TOKEN="$(gh auth token)"`, which needs that sign-in back. The audit
  only reads, and the agent's classic token has `project` and `read:org`, so
  without `GH_TOKEN` it now reads with the agent's token from the keychain.
  The agent is the one the clone's settings name that sessions here work as
  (`agentHere`), or outside a clone the one `machine` set up on this Mac.
  The keychain is read under the login as `machine` spelled it. A missing or
  ambiguous setup reads nothing, never a guess, and names its fix:
  - no agent set up, or none of the settings' agents: `niyam machine <agent>`;
  - no token stored for the agent: `niyam machine <agent>`;
  - several set up outside a clone: run it in a clone of the repository;
  - several named and set up: remove the other agents' folders, as
    `session-start` asks.
  A locked session's `GH_TOKEN`, the lock's placeholder, is no token. The
  audit reads nothing and never works around the lock with the keychain.
  Rejected: the owner's one-time browser sign-in, as `owner-step` uses,
  because it costs a device code for a read the agent can do.
- **2026-11-22 — Decision: agents delete their closed pull requests'
  branches, and every ask for the owner carries its link (slice #557 of
  #453).** On veda-hq/veda#383 an agent closed veda-hq/veda#382 as
  superseded and left its branch, which held a secret-shaped token, so
  every pull request's Secret scans failed. It then asked Alok to delete the
  branch and to 👍 "comment 7068450411 on #376", with no link. Alok asked
  for both corrections in code, not agent memory.
  - Work rules' "one slice, one pull request" refusal names the other pull
    request's full address and, for a branch in the repository, the delete
    command for when it is superseded; for a fork's, only to close it.
  - The keep-going Stop hook reads the agents' closed, unmerged pull
    requests from the repository for the slices the branch's own commits
    name (the latest hundred closed), and holds the session while one's
    branch is still there and builds no open pull request: before the
    merged and the desktop-ready releases, after the subagent, stop-note,
    running-push and GitHub-unknown ones. Relating them by slice, not
    author: every session works as the same agent. Anything GitHub or the
    settings cannot say gives none (fail open). Rejected: holding on
    every closed agent branch in the repository, which would hold one
    session on another's work.
  - `doctor` marks ✗ a repository whose `delete_branch_on_merge` is off,
    which a writer's token reads, naming the settings page. Rejected:
    onboard turning it on: a repository setting the owner turns on
    themselves.
  - Every Work rules, Guard, `propose` and needs-owner text that sends an
    agent to the owner names the full `https://github.com/…` address to
    act at: the proposal comment's own where there is one, else the
    issue's.
- **2026-11-22 — Decision: Guard reads a slice as of the owner's latest
  answer (slice #534 of #468).** Alok asked for the fix after
  veda-hq/veda#383, then approved #534's proposal with a 👍. This supersedes
  the "earliest answer" lines of #501 and #515 above.
  - On veda-hq/veda#376 his 👍 settled the slice. An agent then added a
    **Guards:** section and proposed again, and he 👍'd that. Guard still
    read the first 👍 and refused veda-hq/veda#383 until he re-added
    `approved` on veda-hq/veda#43. athya_mono#3814 and #3845 hit the same
    thing. Guard's own remedy, "approve the slice again", did nothing.
  - Guard now reads **Guards:** as the slice stood at the owner's latest
    answer since the later of the slice joining its Work item and the Work
    item's last `approved` label. For a slice already there, the label is
    an answer too, so later answers move it as well.
  - An agent's edit after that answer still counts for nothing, nor does a
    👍 on a proposal edited after it. Every proposal's reactions are read,
    since an old proposal's 👍 can be the latest, and a failed read fails
    closed.
  - The refusal says what works: a new `Proposal:` comment on the slice,
    which the owner 👍s, or a new `Decision:`. `niyam propose` posts
    nothing for a settled slice, so the refusal does not name it.
  - Cost, accepted: any later unedited owner `Decision:` on the slice, or
    on its Work item naming it, re-settles its body as it then stands,
    even one about something else.
- **2026-11-24 — Decision: Guard alone holds its own files, and CODEOWNERS
  goes, ending P-63's owner review (Work item #468, slice #578).** Alok,
  2026-11-23: "I see no value of my PR review in niyam, veda, and
  athya-rules."
  - On 2026-11-24 he turned off "Require review from Code Owners" in
    `main`'s ruleset (read back: `require_code_owner_review: false`, no
    approving reviews required), and `.github/CODEOWNERS` is deleted.
  - Guard alone now holds `.github/workflows/shared-guard.yml` (under
    `.github/`), `scripts/guard.mjs`, `scripts/guard.test.mjs`,
    `scripts/merge-queue.mjs` and `scripts/merge-queue.test.mjs`
    (`"guard": ["scripts/*.mjs"]`): a change to one passes
    `niyam-guard / judge` only when its approved slice names it under
    `**Guards:**`, unless Guard exempts it as a mechanical pin move
    (Dependabot's sha bumps, an onboard's version moves to a niyam
    release). Every path CODEOWNERS named was already a guard file.
  - The trade, taken knowingly: a pull request cannot weaken Guard for its
    own merge, since `main`'s caller runs the niyam release it pins, never
    the pull request's copy, but a weakening that does merge judges every
    later pull request once it is released and the caller's pin moves to
    it, and Guard's tests and Cubic are what catch it. Alok's yes on such a change moves from the diff to the
    slice, before the code exists.
  - This ends P-63, P-65's line that CODEOWNERS holds a change to the guard
    itself for Alok, and #513's "He still owns the Guard's own rules"
    (above).
  - Not changed: Cubic still reviews, and an open review thread still holds
    the merge. veda's side is veda-hq/veda#559.
- **2026-11-24 — Decision: `review-thread --batch` answers many threads
  from one run (slice #590 of #394, D3).** athya-rules' lesson
  `sync-many-threads-from-one-process` (read at `1d3ffa1`): each run took
  one thread, so 20 threads cost 20 process starts and 20 `/user` checks.
  - The file is a JSON list of `{ thread, reply | bodyFile, resolve,
    reaction, comment }`, each entry read by the rules one run's options
    are, so the batch adds no second meaning: a `bodyFile` reply resolves
    unless `"resolve": false`, an inline `reply` only with `"resolve":
    true`.
  - Every entry, id and reply file is checked before any request, then the
    token once; the threads are answered in order and the run stops at the
    first refusal, printing the threads done and not done. Rejected: going
    on past a refusal, which would leave a reader to sort out a mixed
    result; a rerun is safe instead, as a reply already there is not posted
    again and a resolved thread is left alone.
  - A list or reply file is read only after its links are followed and
    lead inside the git toplevel (`Sys.confine`), so a link in the
    repository cannot post a file from outside it.
  - The list must be in the repository, as `--body-file` must: the allow
    rule runs the command without a prompt.
  - One thread per run is as before, on a machine and in a Claude cloud
    session. Cost: one more input format to keep.
- **2026-11-24 — Decision: CODEOWNERS comes back as a record of ownership,
  and holds no merge (Work item #468, slice #604).** Alok, 2026-11-24: "I
  wanted to keep CODEOWNERS, just to highlight who is the codeowner but
  wanted it not to block anything for now."
  - `.github/CODEOWNERS` is restored with the paths #578 removed, each
    naming `@AlokBansal8`: `.github/workflows/shared-guard.yml`,
    `scripts/guard.mjs`, `scripts/guard.test.mjs`, `scripts/merge-queue.mjs`,
    `scripts/merge-queue.test.mjs` and the file itself. Its header says it
    records who owns them and holds no merge.
  - `main`'s ruleset stays as it is, with "Require review from Code
    Owners" off (read back 2026-11-24: `require_code_owner_review: false`,
    no approving reviews required), so GitHub only requests his review on a pull request that
    touches an owned path, and nothing waits for it. Guard still holds each
    path: the `.github/` floor and `"guard": ["scripts/*.mjs"]`.
  - Nothing in niyam reads review requests or review decisions, so the
    request changes no check.
  - #578's Decision (above) stands except that CODEOWNERS is back: Guard, not
    an owner's review, holds a change to the guard itself. veda's side is
    veda-hq/veda#572.
- **2026-11-25 — Decision: a closed issue never keeps `needs-owner`, and a
  reopened one is judged again (Work item #638, slice #639).** Alok,
  2026-11-25, on #604 keeping the label after it closed: "We should
  permanently fix it for both niyam and its consumers."
  - The cause: the owner's 👍 sends GitHub no event, so only the sweep reads
    it, and the sweep listed open issues alone. GitHub ran niyam's
    `41 * * * *` cron 6 to 10 hours apart on 2026-11-24, so most slices
    closed by their merge before a sweep saw the 👍. Closed issues still
    labelled on 2026-11-25: niyam 28, veda 65, athya_mono 27, athya-rules 1.
  - Each sweep now takes the label off every closed issue and pull request,
    answered or not: a closed one waits on no one. Its first run on the new
    release clears a repository's backlog.
  - A reopened issue is judged by its asks as the sweep judges an open one,
    and labelled again where one still waits: no answer the sweep counts,
    and no `approved` label of the owner's since the latest waiting ask.
    `checks.yml`'s `needs-owner` job runs on `issues: reopened`, which every
    caller already passes for the issue type, so no caller's workflow
    changes.
  - Rejected: an `issues: closed` trigger, taking the label off at once. It
    changes `onboard`'s template and every caller's workflow, and still needs
    the sweep for the backlog.
