// The Stryker config of the `scripts` lane in agnipariksha.json (slice #581):
// scripts/*.mjs, each judged by the .test.mjs beside it. Its sandbox is the
// src lane's (githooks.test.mjs copies .githooks/, merge-queue.test.mjs reads
// package.json and .github/), less pnpm-lock.yaml, as veda's scripts lane
// leaves it out: a mutant that forces own-provenance.mjs's entry condition
// true runs its real check on import, and with no lockfile it dies on ENOENT
// before any request leaves the machine. No suite reads the real lockfile;
// those that need one write their own.
import { lane } from './lane.mjs';

export default {
  ...lane(),
  ignorePatterns: ['/coverage/', '/.tmp/', '/.dvara/', '/.claude/worktrees/', '/.local', '/pnpm-lock.yaml'],
};
