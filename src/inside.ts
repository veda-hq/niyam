import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';

import type { Sys } from './types.ts';

/** A write niyam refused: its target leads out of the repository it writes in. */
export class Outside extends Error {
  override name = 'Outside';
}

/**
 * Refuses, by throwing Outside, a write at `target` that would land outside
 * `root`, the git toplevel: `target` is a symbolic link itself (one that leads
 * nowhere included), or the nearest part of it that exists resolves, links
 * followed, outside `root`'s real path. Run before the first mkdir, write or
 * append; what is not there yet is made by that call, inside. Accepted limit:
 * a link planted between this check and the write is not seen.
 */
export function landInside(sys: Sys, root: string, target: string): void {
  const top = sys.realPath(root) ?? root;
  if (sys.isLink(target)) {
    const leads = sys.realPath(target);
    throw new Outside(`refused to write ${target}: it is a symbolic link, to ${leads ?? 'nothing'}; nothing was written`);
  }
  const rest: string[] = [];
  let at = target;
  while (!sys.exists(at) && !sys.isLink(at) && dirname(at) !== at) {
    rest.unshift(basename(at));
    at = dirname(at);
  }
  const real = sys.realPath(at);
  if (real === undefined) throw new Outside(`refused to write ${target}: ${at} is a symbolic link that leads nowhere; nothing was written`);
  const lands = join(real, ...rest);
  const inside = relative(top, lands);
  if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    throw new Outside(`refused to write ${target}: it leads to ${lands}, outside the repository at ${top}; nothing was written`);
  }
}
