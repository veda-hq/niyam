# Lessons

Traps found while building niyam, kept so a session working here does not have to learn them
again. Decisions live in [decisions.md](decisions.md); this file holds the how.

## Commands the product ships

Use pnpm in every command and doc niyam ships, including what the owner is told to run; never
npm. The CLI installs from the release's attached package with
`pnpm add -g <release package URL>`; nothing is built on the machine.

## PR identity flakes

The PR identity check can fail because GitHub refuses the agent-account lookup
(`GET /users/<agent>`). Since 0.6.14 it retries three times (after 1, 2 and 4 seconds) before
failing. A watcher may re-run a failed PR identity job only when the log matches:

```text
pr-identity: GitHub (has no account|did not answer who account) "[^"]+"( is)? \(HTTP (403|429|5[0-9][0-9])\)
```

A 404 (the account really is missing) or a 401 is not a flake and must not be re-run.

## Guards for an onboard change

Guard exempts an onboard pull request only when every line it changes moves a version, or the
release tarball's sha256. When a slice makes onboard write anything else into a client's files,
such as new lines in `.github/workflows/niyam.yml`, the exemption is gone for the whole pull
request. Then every guard file in it must be in the slice's **Guards:**, as it stood at approval.
That includes `.github/niyam/cloud-setup.sh`, whose version and sha256 move on every onboard.

So such a slice names both `.github/workflows/niyam.yml` and `.github/niyam/cloud-setup.sh`
before the Work item is approved. niyam's own onboard pull request after the release then names
`Slice: #N` and a State under it.

#397 named the workflow alone, so Guard refused #414. The owner had to amend the slice's
**Guards:** and put `approved` back on #399.

## Renames

A rename's migration release must keep reading every old file a running session depends on,
session records above all, until `machine` has moved it to the new place. Deleting the old folder
first strands live sessions. Names kept on purpose after a rename (frozen older hook texts that are
compared against, leftover names read only to delete or report, data marks, history) are listed in
[decisions.md](decisions.md) and must not be "fixed".
