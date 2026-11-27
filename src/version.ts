import { readFileSync } from 'node:fs';

/** The version in this package's package.json, from src/ or dist/ alike. */
export function packageVersion(): string {
  return versionOf(readPackage());
}

function readPackage(): unknown {
  return JSON.parse(readFileSync(new URL('../package.json', import.meta.url)).toString());
}

/** The string `version` of a parsed package.json; throws without one. */
export function versionOf(raw: unknown): string {
  const version = (raw as { version?: unknown } | null | undefined)?.version;
  if (typeof version === 'string') return version;
  throw new Error('package.json has no string "version"');
}

/** The major part of release `v` (major.minor.patch), or undefined when `v` is not one. */
export function majorOf(v: string): number | undefined {
  return /^\d+\.\d+\.\d+$/.test(v) ? Number(v.split('.')[0]) : undefined;
}

/** Whether release `a` comes after release `b`, each major.minor.patch; false when either is not one. */
export function isNewer(a: string, b: string): boolean {
  const parse = (v: string) => (/^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : undefined);
  const [x, y] = [parse(a), parse(b)];
  if (!x || !y) return false;
  // The first part that differs decides; none does when they are the same release.
  const first = x.map((part, i) => part - (y[i] as number)).find((diff) => diff !== 0);
  return (first ?? 0) > 0;
}
