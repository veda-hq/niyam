// niyam's sources under shuddhi's released rules (slice #298 of Work item
// #295): the error-handling, input-parsing and test-lint families, the
// type-aware strict-scalar-parse among them.
//
// The root's `pnpm lint` runs this from the repository's root, so the globs
// below are relative to it. Findings that predate the lint are held in
// eslint-suppressions.json beside this file (ESLint's bulk suppressions):
// new code is checked from the start, and the counts only fall.
import tsParser from '@typescript-eslint/parser';
import shuddhi from '@veda-hq/eslint-plugin-shuddhi';
import { errorHandlingBlocks } from '@veda-hq/eslint-plugin-shuddhi/error-handling/configs';
import { inputParsingConfigs } from '@veda-hq/eslint-plugin-shuddhi/input-parsing';
import { testLintBlocks } from '@veda-hq/eslint-plugin-shuddhi/test-lint/configs';

const ROOT = new URL('..', import.meta.url).pathname;
const SOURCES = ['src/**/*.ts'];
const TESTS = ['src/**/*.test.ts'];

export default [
  {
    files: SOURCES,
    languageOptions: {
      parser: tsParser,
      // Types for strict-scalar-parse, from the root tsconfig.json, which
      // TypeScript 5.9 reads as TypeScript 7 does.
      parserOptions: { projectService: true, tsconfigRootDir: ROOT },
    },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
  },
  // src/sys.ts is niyam's one process runner: the rest reach child processes through its Sys.
  ...errorHandlingBlocks(SOURCES, { plugin: shuddhi, runChildPath: 'src/sys.ts', root: ROOT }),
  // The input-parsing helper binds its own family's plugin, and flat config
  // refuses two objects under one namespace: bind the whole plugin instead.
  ...inputParsingConfigs({ files: SOURCES }).map((block) => (block.plugins ? { ...block, plugins: { shuddhi } } : block)),
  ...testLintBlocks({ tests: TESTS }, 'shuddhi', {}, shuddhi),
];
