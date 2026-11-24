// The Stryker config of the `src` lane in agnipariksha.json (slice #581):
// src/*.ts, each judged by the .test.ts beside it.
//
// src's suites read files across the checkout (package.json, dist/, docs/,
// routines/, .github/, .githooks/), so the sandbox takes the tree, less what
// no suite reads: coverage output, run history, agent scratch, and in the
// main checkout every worktree under .claude/worktrees/. Stryker links
// node_modules itself.
import { lane } from './lane.mjs';

export default {
  ...lane(),
  ignorePatterns: ['/coverage/', '/.tmp/', '/.dvara/', '/.claude/worktrees/', '/.local'],
};
