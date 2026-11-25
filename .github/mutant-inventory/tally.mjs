// Adds up slice #602's inventory: every judged file's record from
// measure.mjs, against plan.mjs's list, into inventory/inventory.md and
// inventory/inventory.json (and the job summary, when there is one).
//
//   node .github/mutant-inventory/tally.mjs <plan.json> <records dir> <sha>
//
// Exits 1 on a fault in the measurement itself: a planned file with no
// record, a run agnipariksha refused or gave no verdict for, or a control that
// does not hold. Survivors are the result, never a failure.
import { appendFileSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** #593's run of src/release-tag.ts: 57 mutants, 52 killed, 5 survived. */
export const CONTROL = { file: 'src/release-tag.ts', mutants: 57, killed: 52, survived: 5, noCoverage: 0 };

const sum = (rows, key) => rows.reduce((total, row) => total + (row[key] ?? 0), 0);
const other = (statuses) =>
  Object.entries(statuses)
    .filter(([status]) => !['Killed', 'Survived', 'NoCoverage', 'Timeout', 'Ignored'].includes(status))
    .reduce((total, [, count]) => total + count, 0);

export function tally(plan, records, sha) {
  const byFile = new Map(records.map((found) => [found.file, found]));
  const faults = [];
  const unjudged = [];
  const rows = [];
  for (const { lane, file } of plan.judged) {
    const found = byFile.get(file);
    if (!found) {
      faults.push({ lane, file, why: 'no record: its job did not finish' });
      continue;
    }
    const refusals = found.refusals ?? [];
    if (!found.verdict || found.verdict.mutants === 0) {
      // Never counted as zero: the file's mutants were not judged.
      unjudged.push({ lane, file, why: refusals.length ? refusals.join('; ') : `agnipariksha exit ${found.exit} with no verdict line` });
      continue;
    }
    rows.push({
      lane,
      file,
      lines: found.lines,
      seconds: found.seconds,
      mutants: found.verdict.mutants,
      killed: found.verdict.killed,
      survived: found.survived,
      noCoverage: found.noCoverage,
      blocking: found.verdict.blocking,
      timeout: found.verdict.statuses.Timeout ?? 0,
      retried: found.verdict.retried,
      errors: other(found.verdict.statuses),
      partly: refusals,
    });
    const listed = found.blocking.length;
    if (found.verdict.outcome === 'blocking' && listed !== found.verdict.blocking) {
      faults.push({ lane, file, why: `${listed} blocking mutants listed, verdict says ${found.verdict.blocking}` });
    }
  }
  const control = rows.find(({ file }) => file === CONTROL.file);
  if (plan.judged.some(({ file }) => file === CONTROL.file) && control) {
    const held = ['mutants', 'killed', 'survived', 'noCoverage'].every((key) => control[key] === CONTROL[key]);
    if (!held) faults.push({ lane: control.lane, file: CONTROL.file, why: `control does not hold: ${JSON.stringify(control)}` });
  }
  rows.sort((a, b) => b.blocking - a.blocking || a.file.localeCompare(b.file));
  const lanes = [...new Set(plan.judged.map(({ lane }) => lane))].map((lane) => {
    const mine = rows.filter((row) => row.lane === lane);
    return {
      lane,
      files: mine.length,
      lines: sum(mine, 'lines'),
      seconds: sum(mine, 'seconds'),
      mutants: sum(mine, 'mutants'),
      survived: sum(mine, 'survived'),
      noCoverage: sum(mine, 'noCoverage'),
      blocking: sum(mine, 'blocking'),
    };
  });
  return { sha, lanes, rows, unjudged, unmeasured: plan.unmeasured, faults };
}

export function markdown({ sha, lanes, rows, unjudged, unmeasured, faults }) {
  const out = [`**Mutant inventory** of \`${sha}\`, one agnipariksha run per file (\`--files <file> --no-reuse\`).`, ''];
  out.push('| Lane | Files | Lines | Run time (s) | s/line | Mutants | Survived | NoCoverage | Blocking |', '|---|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const lane of lanes) {
    const rate = lane.lines ? (lane.seconds / lane.lines).toFixed(2) : '–';
    out.push(`| ${lane.lane} | ${lane.files} | ${lane.lines} | ${lane.seconds} | ${rate} | ${lane.mutants} | ${lane.survived} | ${lane.noCoverage} | ${lane.blocking} |`);
  }
  out.push('', '| File | Lines | s | Mutants | Killed | Survived | NoCoverage | Timeout (retried) | Errors |', '|---|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const row of rows) {
    const mark = row.partly.length ? ' ¹' : '';
    out.push(`| \`${row.file}\`${mark} | ${row.lines} | ${row.seconds} | ${row.mutants} | ${row.killed} | ${row.survived} | ${row.noCoverage} | ${row.timeout} (${row.retried}) | ${row.errors} |`);
  }
  const partly = rows.filter((row) => row.partly.length);
  if (partly.length) {
    out.push('', '¹ **Partly judged:** every mutant ran, but agnipariksha refused part of the timeout retry pass, so those timeouts are unsettled and may hide survivors:');
    for (const row of partly) out.push(`- \`${row.file}\`: ${row.partly.join('; ')}`);
  }
  if (unjudged.length) {
    out.push('', '**Could not judge** (never counted as zero; each needs its cause fixed first):');
    for (const { file, why } of unjudged) out.push(`- \`${file}\`: ${why}`);
  }
  if (unmeasured.length) {
    out.push('', '**Not measured:**');
    for (const { file, why } of unmeasured) out.push(`- \`${file}\`: ${why}`);
  }
  if (faults.length) {
    out.push('', '**Faults in the measurement:**');
    for (const { file, why } of faults) out.push(`- \`${file}\`: ${why}`);
  }
  return `${out.join('\n')}\n`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [planPath, dir, sha] = process.argv.slice(2);
  const plan = JSON.parse(readFileSync(planPath, 'utf8'));
  const records = readdirSync(dir)
    .filter((name) => name.endsWith('.json') && name !== 'inventory.json')
    .map((name) => JSON.parse(readFileSync(join(dir, name), 'utf8')));
  const result = tally(plan, records, sha);
  const text = markdown(result);
  writeFileSync(join(dir, 'inventory.json'), `${JSON.stringify(result, null, 2)}\n`);
  writeFileSync(join(dir, 'inventory.md'), text);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
  process.stdout.write(text);
  process.exit(result.faults.length ? 1 : 0);
}
