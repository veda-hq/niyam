// The Stryker config both agnipariksha lanes in niyam use (agnipariksha.json,
// slice #581), after veda's stryker/lane.mjs. Each lane's config is
// `export default lane()`, with its own sandbox patterns.
//
// The runner is `tap`, on node:test as the suites are written: each owning
// suite runs as its own `node --test` process, Node stripping the types of
// a .ts suite itself, and coverage is per test file.
//
// agnipariksha passes the owning suites in AGNIPARIKSHA_SUITES, comma-joined
// and repo-relative (agnipariksha.json's `{suites}`). Both lanes run from the
// root, so the paths are used as they are. A hand run must name the suites
// too: without them the tap runner's default finds every suite in the
// checkout.

/** @param {NodeJS.ProcessEnv} [env] */
export function lane(env = process.env) {
  const suites = (env.AGNIPARIKSHA_SUITES ?? '').split(',').filter((suite) => suite !== '');
  return {
    testRunner: 'tap',
    plugins: ['@stryker-mutator/tap-runner'],
    tap: {
      ...(suites.length > 0 ? { testFiles: suites } : {}),
      // --test-force-exit ends a suite once its tests have run: a mutant that leaves a server or timer open
      // (sys.ts's serve without close) would otherwise keep the process alive to the timeout.
      nodeArgs: ['--test-reporter=tap', '--test-force-exit', '-r', '{{hookFile}}', '{{testFile}}'],
      forceBail: true,
    },
    coverageAnalysis: 'perTest',
    // A mutant's limit is timeoutFactor × the dry run's net time + timeoutMS.
    // Stryker's 5 s default flooded veda's spawn-heavy suites with Timeouts
    // that were not hangs (veda#461); niyam's suites spawn git as much.
    timeoutMS: 90_000,
    checkers: [],
    // Stryker rewrites a tsconfig.json for the sandbox by importing whatever
    // `typescript` the checkout hoists. niyam's root has TypeScript 7, which
    // lacks parseConfigFileTextToJson, and node:test never reads a tsconfig,
    // so point Stryker at a file that never exists and the rewrite is skipped.
    tsconfigFile: 'stryker-reads-no-tsconfig.json',
    // agnipariksha prints each blocking mutant itself.
    reporters: ['json'],
    // agnipariksha's wrapper config moves the report into reports/agnipariksha/.
    jsonReporter: { fileName: 'reports/mutation/mutation.json' },
    tempDirName: '.stryker-tmp',
    // `always` deletes this run's sandbox however the run ends (veda#437).
    cleanTempDir: 'always',
    incremental: false,
  };
}
