// Judges one lane file with the pinned agnipariksha, for slice #602's
// inventory, and records what it found in inventory/<id>.json, with its
// output in inventory/<id>.log.
//
//   node .github/mutant-inventory/measure.mjs <lane> <file> <id>
//
// Exit 0 or 1 from agnipariksha is the result (1: a mutant survived or had
// no coverage), so this exits 0. Any other exit is a fault: it is recorded,
// and this exits with it.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

/** Lines as agnipariksha counts them: wc -l, plus a last line with no newline. */
export function linesOf(text) {
  const newlines = text.split('\n').length - 1;
  return newlines + (text.length > 0 && !text.endsWith('\n') ? 1 : 0);
}

/** Mutant statuses for one file in a Stryker JSON report. */
export function statusesIn(report, file) {
  const counts = {};
  for (const mutant of report?.files?.[file]?.mutants ?? []) counts[mutant.status] = (counts[mutant.status] ?? 0) + 1;
  return counts;
}

const strip = (text) => text.replace(/\u001b\[[0-9;]*m/g, '');

/** What agnipariksha's own output says: its lane verdict and each blocking mutant. */
export function verdictIn(output, lane) {
  const text = strip(output);
  const escaped = lane.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const line = new RegExp(`^${escaped}: (\\d+) killed of (\\d+) in (\\d+) file\\(s\\) \\((.*)\\) - (\\d+) blocking$`, 'm').exec(text);
  const blocking = [...text.matchAll(/^ {2}(Survived|NoCoverage) (\S+):(\d+) \(([^)]+)\)$/gm)].map(([, status, path, at, mutator]) => ({
    status,
    file: path,
    line: Number(at),
    mutator,
  }));
  if (!line) return { verdict: null, blocking };
  const retried = /(\d+) timeout\(s\) retried/.exec(line[4]);
  return {
    verdict: {
      killed: Number(line[1]),
      mutants: Number(line[2]),
      files: Number(line[3]),
      detail: line[4],
      retried: retried ? Number(retried[1]) : 0,
      blocking: Number(line[5]),
    },
    blocking,
  };
}

export function record({ lane, file, exit, seconds, output, report, source }) {
  const { verdict, blocking } = verdictIn(output, lane);
  return {
    lane,
    file,
    lines: linesOf(source),
    seconds,
    exit,
    verdict,
    statuses: statusesIn(report, file),
    survived: blocking.filter(({ status }) => status === 'Survived').length,
    noCoverage: blocking.filter(({ status }) => status === 'NoCoverage').length,
    blocking,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [lane, file, id] = process.argv.slice(2);
  const env = { ...process.env };
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  const started = Date.now();
  const run = spawnSync('node_modules/.bin/agnipariksha', ['--lane', lane, '--files', file, '--no-reuse'], {
    env,
    encoding: 'utf8',
    maxBuffer: 1 << 28,
  });
  const seconds = Math.round((Date.now() - started) / 1000);
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  process.stdout.write(output);
  const path = `reports/agnipariksha/${lane}.json`;
  const report = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
  const exit = run.status ?? 2;
  mkdirSync('inventory', { recursive: true });
  writeFileSync(`inventory/${id}.log`, output);
  const found = record({ lane, file, exit, seconds, output, report, source: readFileSync(file, 'utf8') });
  writeFileSync(`inventory/${id}.json`, `${JSON.stringify(found, null, 2)}\n`);
  process.stdout.write(`\n${file}: exit ${exit} after ${seconds} s, ${found.survived} survived, ${found.noCoverage} no coverage\n`);
  process.exit(exit === 0 || exit === 1 ? 0 : exit);
}
