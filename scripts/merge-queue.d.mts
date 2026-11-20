// Types for scripts/merge-queue.mjs, which src/identity.ts imports.

export interface MergifyPull {
  title?: string | null | undefined;
  body?: string | null | undefined;
  user?: { login?: string | undefined; type?: string | undefined } | null | undefined;
  head?: { ref?: string | undefined; repo?: { full_name?: string | undefined } | null | undefined } | undefined;
}

export interface MergifyCommit {
  sha: string;
  parents?: unknown[] | undefined;
  author?: { login?: string | undefined } | null | undefined;
  committer?: { login?: string | undefined } | null | undefined;
  commit?: { message?: string | undefined; verification?: { verified?: boolean | undefined } | undefined } | undefined;
}

export declare const MERGE_QUEUE_BOT: string;
export declare const MERGE_QUEUE_BRANCH: string;
export declare const MERGE_QUEUE_SIGNER: string;
export declare function isMergifyDraft(pull: MergifyPull, repo: string): boolean;
export declare function mergifyTests(pull: MergifyPull, repo: string, pr: number): number[] | undefined;
export declare function isMergifyMerge(commit: MergifyCommit, tested: number[]): boolean;
export declare function strayCommits(commits: MergifyCommit[], theirs: Map<number, string[]>): string[];
