// Lists every source file of every lane in agnipariksha.json, for slice
// #602's inventory. A file is judged when a suite owns it, by agnipariksha's
// own ownerOf; any other lane file is listed as not measured.
//
//   node .github/mutant-inventory/plan.mjs <smoke|full>
//
// prints {"judged":[{lane,file,id}],"unmeasured":[{lane,file,why}]}.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { ownerOf } from '@veda-hq/agnipariksha/dist/suite-owner.js';

/** A matrix id GitHub accepts in an artifact name. */
export const idOf = (file) => file.replace(/[^A-Za-z0-9._-]/g, '-');

export function plan(config, tracked, scope, exists = existsSync) {
  if (scope !== 'smoke' && scope !== 'full') throw new Error(`scope must be smoke or full, not ${scope}`);
  const ignore = (config.ignore ?? []).map((pattern) => new RegExp(pattern));
  const judged = [];
  const unmeasured = [];
  for (const { name: lane, include, extensions } of config.lanes) {
    const patterns = include.map((pattern) => new RegExp(pattern));
    for (const file of tracked) {
      if (!patterns.some((pattern) => pattern.test(file)) || !extensions.some((extension) => file.endsWith(extension))) continue;
      if (ignore.some((pattern) => pattern.test(file))) continue;
      if (ownerOf(file, exists)) judged.push({ lane, file, id: idOf(file) });
      else unmeasured.push({ lane, file, why: 'no suite owns it, so agnipariksha does not judge it' });
    }
  }
  if (scope === 'smoke') return { judged: judged.filter(({ file }) => file === 'src/release-tag.ts'), unmeasured: [] };
  return { judged, unmeasured };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = JSON.parse(readFileSync('agnipariksha.json', 'utf8'));
  const tracked = execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean);
  process.stdout.write(`${JSON.stringify(plan(config, tracked, process.argv[2]))}\n`);
}
