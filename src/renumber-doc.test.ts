import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before as beforeAll, describe, it } from 'node:test';

import { parse } from 'yaml';

import { type DocKind, type DocSettings, docSettings, kindNamed } from './doc-numbers.ts';
import { capture } from './fake.test.ts';
import { hermeticGitEnv, maskProcessGitEnv, removeFixtureRoot } from './hermetic-git.ts';
import {
  type Plan,
  applyPlan,
  filesContaining,
  isHistory,
  plan,
  relationshipKeysFor,
  renumberArgs,
  renumberDoc,
  residualBareRefs,
  rewriteFrontmatter,
  rewriteReferences,
  rewriteRelationships,
} from './renumber-doc.ts';
import { realSys } from './sys.ts';

/** Two kinds of numbered document, each naming the other in its own folders, as a repository with both would. */
const RAW_SETTINGS = {
  reservations: 'refs/example/{kind}-reservations/',
  kinds: {
    adr: {
      dir: 'docs/adr',
      citation: 'ADR',
      frontmatterKey: 'adr',
      relationships: { 'docs/adr': ['supersedes', 'superseded_by'], 'docs/rfcs': ['adr_refs'], 'docs/specs': ['adr_refs'] },
    },
    rfc: {
      dir: 'docs/rfcs',
      citation: 'RFC',
      frontmatterKey: 'rfc',
      relationships: { 'docs/rfcs': ['supersedes', 'superseded_by', 'parent_rfc', 'child_rfcs', 'related_rfcs'], 'docs/adr': ['related_rfc'], 'docs/specs': ['source_rfcs'] },
    },
  },
  history: ['docs/work/', 'docs/handoffs/', '!docs/work/README.md'],
};

const SETTINGS: DocSettings = docSettings(RAW_SETTINGS);

function kindOf(name: string): DocKind {
  const kind = kindNamed(SETTINGS, name);
  if (kind === undefined) throw new Error(`no kind ${name}`);
  return kind;
}

const ADR = kindOf('adr');
const RFC = kindOf('rfc');

/** Every fixture of this file, in one folder removed whole at the end. */
let SCRATCH = '';
beforeAll(() => {
  maskProcessGitEnv();
  SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'niyam-renumber-')));
});
after(() => removeFixtureRoot(SCRATCH));

const gitIn = (root: string, ...args: string[]): string => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: hermeticGitEnv(), timeout: 30_000 });

/**
 * A throwaway repository holding `files`, committed, with a GitHub `origin` and `origin/main` at that commit unless
 * `originMain` is false. `git: false` leaves a bare folder: enough for the refusals plan makes before it asks git.
 */
function fixture(files: Record<string, string>, { originMain = true, git = true }: { originMain?: boolean; git?: boolean } = {}): string {
  const root = mkdtempSync(join(SCRATCH, 'repo-'));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  if (!git) return root;
  const run = (...args: string[]): string => gitIn(root, ...args);
  run('init', '-q', '-b', 'main');
  run('config', 'user.email', 't@example.invalid');
  run('config', 'user.name', 'T');
  run('config', 'commit.gpgsign', 'false');
  run('remote', 'add', 'origin', 'https://github.com/example-org/example-app.git');
  run('add', '-A');
  run('commit', '-q', '-m', 'fixture');
  if (originMain) run('update-ref', 'refs/remotes/origin/main', 'HEAD');
  return root;
}

const read = (root: string, path: string): string => readFileSync(join(root, path), 'utf8');
const sysAt = (root: string) => ({ ...realSys(), cwd: root });

/** The plan, which must have been made. */
function planned(root: string, kind: DocKind, from: string, to: string): Plan {
  const result = plan(sysAt(root), root, SETTINGS, kind, from, to);
  if (!result.ok) throw new Error(result.error);
  return result.plan;
}

/** The refusal, which must have been made. */
function refused(root: string, kind: DocKind, from: string, to: string): string {
  const result = plan(sysAt(root), root, SETTINGS, kind, from, to);
  assert.equal(result.ok, false);
  return result.ok ? '' : result.error;
}

describe('rewriteRelationships', () => {
  const ADR_FILE = "---\nadr: '0041'\nsupersedes: '0040'\nrelated_rfc: '0040'\n---\n";

  it('does not let an RFC renumber touch an ADR-owned key', () => {
    // `supersedes:` in docs/adr names an ADR: a flat key list made an RFC renumber rewrite it.
    const after = rewriteRelationships(ADR_FILE, RFC, '0040', '0099', 'docs/adr/x.md');
    assert.ok(after.includes("supersedes: '0040'"));
    assert.ok(after.includes("related_rfc: '0099'"));
  });

  it('does not let an ADR renumber touch the RFC-owned key', () => {
    const after = rewriteRelationships(ADR_FILE, ADR, '0040', '0099', 'docs/adr/x.md');
    assert.ok(after.includes("supersedes: '0099'"));
    assert.ok(after.includes("related_rfc: '0040'"));
  });

  it('handles scalar, flow-list and block-list forms', () => {
    const text = ["supersedes: '0022'", 'superseded_by: ["0022", 0023]', 'child_rfcs:', "  - '0022'", '  - 0024'].join('\n');
    const after = rewriteRelationships(text, RFC, '0022', '0077', 'docs/rfcs/x.md');
    assert.ok(after.includes("supersedes: '0077'"));
    assert.ok(after.includes('superseded_by: ["0077", 0023]'));
    assert.ok(after.includes("  - '0077'"));
    assert.ok(after.includes('  - 0024'));
  });

  it('rewrites list and scalar entries that carry trailing description text', () => {
    const text = ['child_rfcs:', "  - '0007 (Identity Dedup — introduced DeduplicationService)'", "supersedes: '0007 (note)'"].join('\n');
    const after = rewriteRelationships(text, RFC, '0007', '0099', 'docs/rfcs/x.md');
    assert.ok(after.includes("- '0099 (Identity Dedup"));
    assert.ok(after.includes("supersedes: '0099 (note)'"));
  });

  it('rewrites a comma-separated scalar in every position', () => {
    const value = 'supersedes: "0005, 0006"\n';
    assert.ok(rewriteRelationships(value, RFC, '0006', '0099', 'docs/rfcs/x.md').includes('"0005, 0099"'));
    assert.ok(rewriteRelationships(value, RFC, '0005', '0099', 'docs/rfcs/x.md').includes('"0099, 0006"'));
  });

  it('tells a reference list apart from prose containing a comma', () => {
    // A value that is only comma-separated four-digit numbers is a list; anything else names its leading number.
    assert.ok(rewriteRelationships('supersedes: "0005, 0006"\n', RFC, '0006', '0099', 'docs/rfcs/x.md').includes('"0005, 0099"'));
    const prose = 'supersedes: "0005 (see, 0006 note)"\n';
    assert.equal(rewriteRelationships(prose, RFC, '0006', '0099', 'docs/rfcs/x.md'), prose);
    const arrayProse = "child_rfcs: ['0008 (Foo, 0007 bar)']\n";
    assert.equal(rewriteRelationships(arrayProse, RFC, '0007', '0099', 'docs/rfcs/x.md'), arrayProse);
  });

  it('honours both YAML escape forms when splitting elements', () => {
    // A backslash escape (double quotes only) must not close the string.
    const escaped = 'child_rfcs: ["a\\", 0007", "0008"]\n';
    assert.equal(rewriteRelationships(escaped, RFC, '0007', '0099', 'docs/rfcs/x.md'), escaped);
    // A doubled single quote is two toggles and needs no special handling.
    assert.ok(rewriteRelationships("child_rfcs: ['It''s, fine', '0007']\n", RFC, '0007', '0099', 'docs/rfcs/x.md').includes("'0099'"));
  });

  it('rewrites only the leading number of a flow-list element', () => {
    const after = rewriteRelationships("child_rfcs: ['0007', '0008 (supersedes 0007 in part)']\n", RFC, '0007', '0099', 'docs/rfcs/x.md');
    assert.ok(after.includes("['0099'"));
    assert.ok(after.includes("'0008 (supersedes 0007 in part)'"));
  });

  it('never moves a longer number that starts with the source', () => {
    const text = "supersedes: '00401'\nsuperseded_by: [00401, 0040]\n";
    assert.equal(rewriteRelationships(text, ADR, '0040', '0099', 'docs/adr/x.md'), "supersedes: '00401'\nsuperseded_by: [00401, 0099]\n");
  });

  it('leaves files that carry no relationships of this kind untouched', () => {
    const text = "supersedes: '0022'\n";
    assert.equal(rewriteRelationships(text, ADR, '0022', '0077', 'scripts/thing.ts'), text);
  });

  it('leaves values that do not open with a number, and block items that do not, as written', () => {
    const text = ['supersedes: none yet', 'superseded_by:', '  - see below', "  - '0040'", 'adr: 0040'].join('\n');
    assert.equal(rewriteRelationships(text, ADR, '0040', '0099', 'docs/adr/x.md'), ['supersedes: none yet', 'superseded_by:', '  - see below', "  - '0099'", 'adr: 0040'].join('\n'));
  });

  describe('trailing YAML comments', () => {
    const adr = (text: string): string => rewriteRelationships(text, ADR, '0040', '0099', 'docs/adr/x.md');

    it('moves a value followed by a comment, keeping the comment', () => {
      assert.equal(adr("supersedes: '0040' # note"), "supersedes: '0099' # note");
      assert.equal(adr('supersedes: "0040" # note'), 'supersedes: "0099" # note');
      // Whitespace before the `#` opens a comment, not whitespace after.
      assert.equal(adr("supersedes: '0040' #note"), "supersedes: '0099' #note");
    });

    it('treats a `#` inside either kind of quotes as text', () => {
      assert.equal(adr("supersedes: '0040 #1 note'"), "supersedes: '0099 #1 note'");
      assert.equal(adr('supersedes: "0040 #1 note"'), 'supersedes: "0099 #1 note"');
    });

    it('treats a `#` glued to the previous character as text', () => {
      assert.equal(adr('superseded_by: [0040#x, 0040]'), 'superseded_by: [0099#x, 0099]');
      assert.equal(adr('superseded_by: [0040# x, 0040]'), 'superseded_by: [0099# x, 0099]');
    });

    it('honours a backslash escape only inside double quotes', () => {
      // `\"` keeps the string open, so the ` #` after it is text and the list runs on to `"0040"`.
      assert.equal(adr('superseded_by: ["a\\" #", "0040"]'), 'superseded_by: ["a\\" #", "0099"]');
      // The escape covers one character; the comment after the list still splits off.
      assert.equal(adr('superseded_by: ["a\\"b", "0040"] # c'), 'superseded_by: ["a\\"b", "0099"] # c');
      // In single quotes a backslash is literal: `'a\'` is a whole string.
      assert.equal(adr("superseded_by: ['a\\', '0040'] # c"), "superseded_by: ['a\\', '0099'] # c");
    });

    it('keeps a trailing backslash inside an open double quote as text', () => {
      const text = 'supersedes: "0040\\';
      assert.equal(adr(text), text);
    });

    it('stays in a block list across comment and blank lines', () => {
      const before = ['superseded_by:', '# a comment line at column 0', '', "  - '0039'", "  - '0040' # tail", 'next: 0040'].join('\n');
      assert.equal(adr(before), ['superseded_by:', '# a comment line at column 0', '', "  - '0039'", "  - '0099' # tail", 'next: 0040'].join('\n'));
    });
  });

  it('moves the second of two quoted flow elements', () => {
    assert.equal(rewriteRelationships("child_rfcs: ['0007', '0008']", RFC, '0008', '0099', 'docs/rfcs/x.md'), "child_rfcs: ['0007', '0099']");
  });

  it('follows a flow list wrapped onto following lines', () => {
    const adr = (text: string): string => rewriteRelationships(text, ADR, '0040', '0099', 'docs/adr/x.md');
    // `key:` then an indented `[` that closes several lines later.
    assert.equal(adr("superseded_by:\n  [\n    '0040',\n    '0041',\n  ]\nsupersedes: '0040'"), "superseded_by:\n  [\n    '0099',\n    '0041',\n  ]\nsupersedes: '0099'");
    // `key: [` opened on the key line and closed on a later one.
    assert.equal(adr("superseded_by: ['0041',\n  '0040']\nsupersedes: '0040'"), "superseded_by: ['0041',\n  '0099']\nsupersedes: '0099'");
    // `key:` then an indented `[…]` that closes on the same line.
    assert.equal(adr("superseded_by:\n  ['0040']\nsupersedes: '0040'"), "superseded_by:\n  ['0099']\nsupersedes: '0099'");
  });

  it('rewrites CRLF frontmatter and keeps its line endings', () => {
    assert.equal(
      rewriteRelationships("supersedes: '0040'\r\nsuperseded_by:\r\n  - '0040' # x\r\n", ADR, '0040', '0099', 'docs/adr/x.md'),
      "supersedes: '0099'\r\nsuperseded_by:\r\n  - '0099' # x\r\n",
    );
  });

  it('keeps the indentation of a nested key', () => {
    assert.equal(rewriteRelationships("prd_impact:\n  adr_refs: ['0007']", ADR, '0007', '0099', 'docs/specs/area/x.prd.md'), "prd_impact:\n  adr_refs: ['0099']");
  });
});

describe('relationshipKeysFor', () => {
  it('names the keys a kind owns by the folder of the file, and none outside them', () => {
    assert.deepEqual(relationshipKeysFor(ADR, 'docs/rfcs/0001-x.md'), ['adr_refs']);
    assert.deepEqual(relationshipKeysFor(RFC, 'docs/adr/0001-x.md'), ['related_rfc']);
    assert.deepEqual(relationshipKeysFor(ADR, 'docs/adrs/0001-x.md'), []);
  });
});

describe('rewriteReferences', () => {
  it('moves prose citations and full-path references together', () => {
    const before = 'See ADR-0057 and docs/adr/0057-codex-policy.md for the rule.\n# ADR-0057: Title\n';
    const after = rewriteReferences(before, ADR, '0057', '0058', '0057-codex-policy.md', '0058-codex-policy.md', 'docs/adr/0060-elsewhere.md');
    assert.ok(after.includes('ADR-0058'));
    assert.ok(after.includes('docs/adr/0058-codex-policy.md'));
    assert.ok(!after.includes('0057'));
  });

  it('does not rewrite a longer number that merely starts with the source', () => {
    assert.equal(rewriteReferences('ADR-00571 stays put', ADR, '0057', '0058', '0057-x.md', '0058-x.md', 'docs/adr/0060-elsewhere.md'), 'ADR-00571 stays put');
  });

  it('leaves the other document family alone', () => {
    assert.equal(rewriteReferences('RFC-0057 is unrelated', ADR, '0057', '0058', '0057-x.md', '0058-x.md', 'docs/adr/0060-elsewhere.md'), 'RFC-0057 is unrelated');
  });

  it('rewrites a relative target that resolves to the renumbered document', () => {
    const fromAdr = rewriteReferences("related_rfc: '../rfcs/0030-phone.md'\nsee docs/rfcs/0030-phone.md", RFC, '0030', '0099', '0030-phone.md', '0099-phone.md', 'docs/adr/0012-some-decision.md');
    assert.ok(fromAdr.includes("'../rfcs/0099-phone.md'"));
    assert.ok(fromAdr.includes('docs/rfcs/0099-phone.md'));
    assert.ok(!fromAdr.includes('0030-phone.md'));
    const fromSpec = rewriteReferences('[RFC-0030](../../rfcs/0030-phone.md)', RFC, '0030', '0099', '0030-phone.md', '0099-phone.md', 'docs/specs/checkout/checkout.product.prd.md');
    assert.equal(fromSpec, '[RFC-0099](../../rfcs/0099-phone.md)');
  });

  it('leaves a relative target whose depth points somewhere else', () => {
    // From docs/adr, `../../rfcs/` resolves to a top-level rfcs/ that is not this folder.
    assert.equal(rewriteReferences('target: ../../rfcs/0030-phone.md', RFC, '0030', '0099', '0030-phone.md', '0099-phone.md', 'docs/adr/0012-some-decision.md'), 'target: ../../rfcs/0030-phone.md');
  });

  it('leaves a relative target that starts mid-segment', () => {
    const text = 'a: ../vendored-rfcs/0030-phone.md\nb: notes../rfcs/0030-phone.md';
    assert.equal(rewriteReferences(text, RFC, '0030', '0099', '0030-phone.md', '0099-phone.md', 'docs/adr/0012-some-decision.md'), text);
  });

  it('rewrites every relative target in the file, not just the first', () => {
    assert.equal(
      rewriteReferences('a: ../rfcs/0030-phone.md\nb: ../rfcs/0030-phone.md', RFC, '0030', '0099', '0030-phone.md', '0099-phone.md', 'docs/adr/0012-some-decision.md'),
      'a: ../rfcs/0099-phone.md\nb: ../rfcs/0099-phone.md',
    );
  });
});

describe('rewriteFrontmatter', () => {
  it('rewrites the quoted key', () => {
    assert.ok(rewriteFrontmatter("---\nadr: '0057'\ntitle: x\n---\n", ADR, '0057', '0058').includes("adr: '0058'"));
  });

  it('rewrites an unquoted key and the double-quoted form', () => {
    assert.ok(rewriteFrontmatter('---\nadr: 0057\n---\n', ADR, '0057', '0058').includes('adr: 0058'));
    assert.ok(rewriteFrontmatter('---\nrfc: "0047"\n---\n', RFC, '0047', '0049').includes('rfc: "0049"'));
  });

  it('reads the number literally, not as a pattern', () => {
    // `00.7` must not match `0057` because `.` is a regex wildcard.
    const text = "---\nadr: '0057'\n---\n\nSee ADR-0057.\n";
    assert.equal(rewriteFrontmatter(text, ADR, '00.7', '0058'), text);
    assert.equal(rewriteReferences(text, ADR, '00.7', '0058', 'x.md', 'y.md', 'a.md'), text);
    assert.deepEqual(residualBareRefs(SETTINGS, "---\nrelated: '0057'\n---\n", '00.7', 'a.md'), []);
  });

  it('does not touch a matching number elsewhere in the document', () => {
    const after = rewriteFrontmatter("---\nadr: '0057'\n---\n\nrelated: adr: '0057' in prose\n", ADR, '0057', '0058');
    assert.ok(after.includes("adr: '0058'"));
    assert.ok(after.includes("related: adr: '0057' in prose"));
  });
});

describe('residualBareRefs', () => {
  it('reports an unclassified key, so a partial rewrite is never silent', () => {
    const text = "---\nrelated:\n  - '0023 (Campaign Health Report)'\n---\n";
    assert.deepEqual(residualBareRefs(SETTINGS, text, '0023', 'docs/rfcs/x.md'), ["- '0023 (Campaign Health Report)'"]);
  });

  it("stays quiet about the identity key and about the other kind's keys", () => {
    assert.deepEqual(residualBareRefs(SETTINGS, "---\nadr: '0007'\n---\n", '0007', 'docs/adr/x.md'), []);
    assert.deepEqual(residualBareRefs(SETTINGS, "---\nadr_refs: ['0007']\n---\n", '0007', 'docs/rfcs/x.md'), []);
    assert.deepEqual(residualBareRefs(SETTINGS, "---\nrfc: '0007'\n---\n", '0007', 'docs/rfcs/x.md'), []);
  });

  it('classifies a key only in the folder that owns it', () => {
    assert.deepEqual(residualBareRefs(SETTINGS, "---\nchild_rfcs: '0007'\n---\n", '0007', 'docs/adr/x.md'), ["child_rfcs: '0007'"]);
  });

  it('lets block-list children inherit their key across blank lines', () => {
    const text = ['---', 'child_rfcs:', '', "  - '0023 (Campaign Health Report)'", '  continued prose naming 0023', '---', ''].join('\n');
    assert.deepEqual(residualBareRefs(SETTINGS, text, '0023', 'docs/rfcs/x.md'), ['continued prose naming 0023']);
  });

  it('reads CRLF frontmatter, and nothing from a file without any', () => {
    assert.deepEqual(residualBareRefs(SETTINGS, "---\r\nrelated: '0023'\r\n---\r\n", '0023', 'docs/rfcs/x.md'), ["related: '0023'"]);
    assert.deepEqual(residualBareRefs(SETTINGS, "related: '0023'\n", '0023', 'docs/rfcs/x.md'), []);
  });
});

describe('isHistory', () => {
  it('keeps the history folders as written, but the README the settings exempt', () => {
    assert.equal(isHistory(SETTINGS, 'docs/work/0145-coordinator-reports/frame.md'), true);
    assert.equal(isHistory(SETTINGS, 'docs/work/ORDER.md'), true);
    assert.equal(isHistory(SETTINGS, 'docs/handoffs/2026-09-24-work-number-scan.md'), true);
    assert.equal(isHistory(SETTINGS, 'docs/work/README.md'), false);
    assert.equal(isHistory(SETTINGS, 'docs/workflows/x.md'), false);
    assert.equal(isHistory(SETTINGS, 'docs/adr/0057-x.md'), false);
    assert.equal(isHistory(SETTINGS, 'scripts/docs/work/x.md'), false);
  });

  it('matches a file pattern only as that whole path, and keeps nothing without settings for it', () => {
    const settings = docSettings({ ...RAW_SETTINGS, history: ['CHANGELOG.md'] });
    assert.equal(isHistory(settings, 'CHANGELOG.md'), true);
    assert.equal(isHistory(settings, 'docs/CHANGELOG.md'), false);
    assert.equal(isHistory(docSettings({ ...RAW_SETTINGS, history: [] }), 'docs/work/x.md'), false);
  });
});

describe('plan (in a fixture repository)', () => {
  it('plans a move that keeps the slug', () => {
    const root = fixture({ 'docs/adr/0057-codex-policy.md': "---\nadr: '0057'\n---\n" });
    const p = planned(root, ADR, '0057', '9990');
    assert.equal(p.oldPath, 'docs/adr/0057-codex-policy.md');
    assert.equal(p.newPath, 'docs/adr/9990-codex-policy.md');
    assert.equal(p.oldName, '0057-codex-policy.md');
    assert.equal(p.newName, '9990-codex-policy.md');
    assert.equal(p.tracked, true);
    assert.deepEqual(p.referencing, []);
  });

  it('refuses when no document carries the source number', () => {
    const root = fixture({ 'docs/adr/0057-a.md': '' }, { git: false });
    assert.equal(refused(root, ADR, '9997', '9998'), 'no ADR numbered 9997 in docs/adr/');
  });

  it('refuses a source number two files claim, naming both', () => {
    const root = fixture({ 'docs/adr/0057-a.md': '', 'docs/adr/0057-b.md': '' }, { git: false });
    assert.equal(refused(root, ADR, '0057', '0058'), '2 files claim 0057 (0057-a.md, 0057-b.md) — resolve that collision first, one file at a time');
  });

  it('names every local file already using the target', () => {
    // Otherwise the renumber would only relocate the collision.
    const root = fixture({ 'docs/adr/0057-a.md': '', 'docs/adr/0058-b.md': '', 'docs/adr/0058-c.md': '' }, { git: false });
    assert.equal(refused(root, ADR, '0057', '0058'), '0058 is already used locally by 0058-b.md, 0058-c.md');
  });

  it('refuses when origin/main cannot be read', () => {
    const root = fixture({ 'docs/adr/0057-a.md': '' }, { originMain: false });
    assert.equal(refused(root, ADR, '0057', '0058'), 'could not read `origin/main` — run `git fetch origin main` first, or the new number may collide exactly as the old one did');
  });

  it('names every origin/main file already using the target, though the branch removed them', () => {
    // Free in the working tree, taken on main: a renumber that ignored main would land straight back in a clash.
    const root = fixture({ 'docs/adr/0056-mine.md': '', 'docs/adr/0057-x.md': '', 'docs/adr/0057-y.md': '' });
    gitIn(root, 'rm', '-q', 'docs/adr/0057-x.md', 'docs/adr/0057-y.md');
    assert.equal(refused(root, ADR, '0056', '0057'), '0057 is already used on origin/main by 0057-x.md, 0057-y.md');
  });

  it('leaves history as written, but the README the settings exempt', () => {
    const root = fixture({
      'docs/adr/0057-codex-policy.md': "---\nadr: '0057'\n---\n\n# ADR-0057\n",
      'docs/work/README.md': 'See ADR-0057.\n',
      'docs/work/0145-x/frame.md': 'See ADR-0057.\n',
      'docs/handoffs/2026-09-24-h.md': 'See docs/adr/0057-codex-policy.md.\n',
      'scripts/consumer.ts': '// ADR-0057\n',
    });
    const p = planned(root, ADR, '0057', '0058');
    assert.deepEqual(p.referencing, ['docs/work/README.md', 'scripts/consumer.ts']);
    applyPlan(sysAt(root), root, ADR, p);
    assert.equal(read(root, 'docs/work/0145-x/frame.md'), 'See ADR-0057.\n');
    assert.equal(read(root, 'docs/handoffs/2026-09-24-h.md'), 'See docs/adr/0057-codex-policy.md.\n');
    assert.equal(read(root, 'docs/work/README.md'), 'See ADR-0058.\n');
  });

  it('reports residual bare references only from document folders', () => {
    // notes/ comes in by its citation, but frontmatter outside the document folders is no relationship.
    const root = fixture({
      'docs/adr/0040-a.md': "---\nadr: '0040'\n---\n",
      'docs/adr/0041-b.md': "---\nadr: '0041'\nrelated: '0040'\n---\n",
      'notes/x.md': "---\nrelated: '0040'\n---\n\nSee ADR-0040.\n",
    });
    const p = planned(root, ADR, '0040', '0099');
    assert.deepEqual(p.referencing, ['notes/x.md']);
    assert.deepEqual(p.residual, [{ path: 'docs/adr/0041-b.md', line: "related: '0040'" }]);
  });

  it('finds bare relationship values in every folder the kind names, and keeps only files the rewrite changes', () => {
    // `git grep -F ADR-0057` also finds ADR-00571, and a bare 0057 in prose is no relationship.
    const root = fixture({
      'docs/adr/0057-a.md': "---\nadr: '0057'\n---\n",
      'docs/rfcs/0003-r.md': "---\nrfc: '0003'\nadr_refs: ['0057']\n---\n",
      'docs/specs/area/x.prd.md': "---\nprd_impact:\n  adr_refs: ['0057']\n---\n",
      'docs/specs/area/y.prd.md': 'Mentions 0057 in prose.\n',
      'scripts/near.ts': '// ADR-00571\n',
    });
    const p = planned(root, ADR, '0057', '0058');
    assert.deepEqual(p.referencing, ['docs/rfcs/0003-r.md', 'docs/specs/area/x.prd.md']);
    assert.deepEqual(p.residual, []);
  });
});

describe('filesContaining (in a fixture repository)', () => {
  it('searches the whole tree, or only the folder it is given', () => {
    const root = fixture({ 'docs/adr/0057-a.md': 'number 0057\n', 'scripts/x.ts': '// 0057\n' });
    const sys = sysAt(root);
    assert.deepEqual(filesContaining(sys, root, '0057'), ['docs/adr/0057-a.md', 'scripts/x.ts']);
    assert.deepEqual(filesContaining(sys, root, '0057', 'docs/adr'), ['docs/adr/0057-a.md']);
    assert.deepEqual(filesContaining(sys, root, 'absent-needle'), []);
  });
});

describe('applyPlan (in a fixture repository)', () => {
  it('moves the file with git mv and rewrites every reference shape', () => {
    const root = fixture({
      'docs/adr/0057-codex-policy.md': "---\nadr: '0057'\ntitle: 'x'\n---\n\n# ADR-0057: Codex policy\n",
      'scripts/consumer.ts': '// See ADR-0057\nconst x = 1;\n',
      'README.md': 'Read docs/adr/0057-codex-policy.md today.\n',
      // A near miss that must survive untouched.
      'scripts/other.ts': '// ADR-00571 and RFC-0057\n',
    });
    const p = planned(root, ADR, '0057', '0058');
    assert.deepEqual(p.referencing, ['README.md', 'scripts/consumer.ts']);
    assert.deepEqual(applyPlan(sysAt(root), root, ADR, p), ['docs/adr/0058-codex-policy.md', 'README.md', 'scripts/consumer.ts']);
    const moved = read(root, 'docs/adr/0058-codex-policy.md');
    assert.ok(moved.includes("adr: '0058'"));
    assert.ok(moved.includes('# ADR-0058: Codex policy'));
    assert.ok(read(root, 'scripts/consumer.ts').includes('ADR-0058'));
    assert.ok(read(root, 'README.md').includes('docs/adr/0058-codex-policy.md'));
    assert.equal(read(root, 'scripts/other.ts'), '// ADR-00571 and RFC-0057\n');
    // git mv staged the rename, so history follows the file.
    assert.match(gitIn(root, 'diff', '--cached', '--name-status', '-M'), /^R\d*\tdocs\/adr\/0057-codex-policy\.md\tdocs\/adr\/0058-codex-policy\.md$/m);
  });

  it('renumbers an uncommitted document, the common case', () => {
    // The clash is reported before the author commits, so the source is usually untracked, which git mv refuses.
    const root = fixture({ 'docs/adr/.keep': '' });
    writeFileSync(join(root, 'docs/adr/0059-brand-new.md'), "---\nadr: '0059'\n---\n\n# ADR-0059: New\n");
    const p = planned(root, ADR, '0059', '0060');
    assert.equal(p.tracked, false);
    assert.deepEqual(applyPlan(sysAt(root), root, ADR, p), ['docs/adr/0060-brand-new.md']);
    assert.equal(read(root, 'docs/adr/0060-brand-new.md'), "---\nadr: '0060'\n---\n\n# ADR-0060: New\n");
    assert.equal(existsSync(join(root, 'docs/adr/0059-brand-new.md')), false);
  });

  it('rewrites bare frontmatter relationship values, never a bare number in prose', () => {
    // `supersedes: '0040'` carries no ADR- prefix; left stale, it names whatever takes 0040 next.
    const root = fixture({
      'docs/adr/0040-old.md': "---\nadr: '0040'\n---\n\n# ADR-0040: Old\n",
      'docs/adr/0041-newer.md': "---\nadr: '0041'\nsupersedes: '0040'\n---\n\nBody mentioning 0040 in prose.\n",
    });
    const p = planned(root, ADR, '0040', '0099');
    assert.ok(p.referencing.includes('docs/adr/0041-newer.md'));
    applyPlan(sysAt(root), root, ADR, p);
    const newer = read(root, 'docs/adr/0041-newer.md');
    assert.ok(newer.includes("supersedes: '0099'"));
    assert.ok(newer.includes('mentioning 0040 in prose'));
  });

  it('rewrites a relative path in the moved document itself, resolved from its new place', () => {
    const root = fixture({ 'docs/adr/0057-a.md': "---\nadr: '0057'\n---\n\nSelf: ../adr/0057-a.md and ADR-0057.\n" });
    applyPlan(sysAt(root), root, ADR, planned(root, ADR, '0057', '0058'));
    assert.equal(read(root, 'docs/adr/0058-a.md'), "---\nadr: '0058'\n---\n\nSelf: ../adr/0058-a.md and ADR-0058.\n");
  });

  it('writes only the files the rewrite still changes', () => {
    const root = fixture({ 'docs/adr/0057-a.md': "---\nadr: '0057'\n---\n", 'README.md': 'See ADR-0057.\n' });
    const p = planned(root, ADR, '0057', '0058');
    writeFileSync(join(root, 'README.md'), 'Rewritten meanwhile.\n');
    assert.deepEqual(applyPlan(sysAt(root), root, ADR, p), ['docs/adr/0058-a.md']);
    assert.equal(read(root, 'README.md'), 'Rewritten meanwhile.\n');
  });

  it('throws when git mv refuses, leaving both files as they were', () => {
    // A file squatting on the target makes git mv fail: an error, never a half-done renumber.
    const root = fixture({ 'docs/adr/0057-a.md': "---\nadr: '0057'\n---\n" });
    const p = planned(root, ADR, '0057', '0058');
    writeFileSync(join(root, 'docs/adr/0058-a.md'), 'squatter\n');
    assert.throws(() => applyPlan(sysAt(root), root, ADR, p), /^Error: git mv docs\/adr\/0057-a\.md docs\/adr\/0058-a\.md: .+/);
    assert.equal(read(root, 'docs/adr/0057-a.md'), "---\nadr: '0057'\n---\n");
    assert.equal(read(root, 'docs/adr/0058-a.md'), 'squatter\n');
  });
});

describe('renumberArgs', () => {
  it('reads a kind, two numbers and --apply in any position', () => {
    assert.deepEqual(renumberArgs(['adr', '0057', '0058']), { kind: 'adr', from: '0057', to: '0058', apply: false });
    assert.deepEqual(renumberArgs(['--apply', 'adr', '0057', '0058']), { kind: 'adr', from: '0057', to: '0058', apply: true });
    assert.deepEqual(renumberArgs(['adr', '0057', '0058', '--apply']), { kind: 'adr', from: '0057', to: '0058', apply: true });
  });

  for (const args of [['adr', '58', '0059'], ['adr', '0058', '59'], ['adr', '0058'], ['adr'], [], ['adr', '0057', '0058', '0059'], ['adr', '00570', '0058']]) {
    it(`refuses ${JSON.stringify(args)} with the usage`, () => {
      assert.throws(() => renumberArgs(args), { message: 'renumber-doc needs a document kind and two four-digit numbers: renumber-doc <kind> <from> <to> [--apply]' });
    });
  }

  it('refuses an unknown option and a no-op renumber', () => {
    assert.throws(() => renumberArgs(['adr', '0057', '0058', '--force']), { message: 'renumber-doc: unknown option "--force"' });
    assert.throws(() => renumberArgs(['adr', '0057', '0057']), { message: 'renumber-doc: 0057 and 0057 are the same number' });
  });
});

describe('renumberDoc (in a fixture repository)', () => {
  const NIYAM = { '.github/niyam.json': `${JSON.stringify({ docNumbers: RAW_SETTINGS }, null, 2)}\n` };
  const DRY_RUN = '\nDry run — nothing changed. Review the list above (some prose narrates history rather than citing a live decision), then re-run with --apply.';
  const simple = (): string => fixture({ ...NIYAM, 'docs/adr/0057-a.md': "---\nadr: '0057'\n---\n\n# ADR-0057: A\n" });
  const referenced = (): string =>
    fixture({
      ...NIYAM,
      'docs/adr/0057-a.md': "---\nadr: '0057'\n---\n\n# ADR-0057: A\n",
      'docs/adr/0060-b.md': "---\nadr: '0060'\nrelated: '0057'\n---\n",
      'README.md': 'See ADR-0057.\n',
    });
  const run = (root: string, args: string[]) => {
    const seen = capture();
    return { code: renumberDoc(sysAt(root), seen.io, args), out: seen.out, err: seen.err };
  };

  it('refuses a kind the settings do not name', () => {
    assert.deepEqual(run(simple(), ['prd', '0058', '0059']), { code: 2, out: [], err: ['niyam renumber-doc: no document kind "prd"; .github/niyam.json names adr, rfc'] });
  });

  it("prints plan's refusal and exits 1", () => {
    assert.deepEqual(run(simple(), ['adr', '9997', '9998']), { code: 1, out: [], err: ['❌ no ADR numbered 9997 in docs/adr/'] });
  });

  it('throws on bad usage before it reads the repository', () => {
    assert.throws(() => run(simple(), ['adr', '0057', '0057']), { message: 'renumber-doc: 0057 and 0057 are the same number' });
  });

  it('dry-runs a document nothing references, changing nothing', () => {
    const root = simple();
    assert.deepEqual(run(root, ['adr', '0057', '0058']), { code: 0, out: ['docs/adr/0057-a.md\n  → docs/adr/0058-a.md\n', 'No other tracked file references it.', DRY_RUN], err: [] });
    assert.equal(existsSync(join(root, 'docs/adr/0057-a.md')), true);
    assert.equal(existsSync(join(root, 'docs/adr/0058-a.md')), false);
    assert.equal(gitIn(root, 'status', '--porcelain'), '');
  });

  const LISTED = [
    'docs/adr/0057-a.md\n  → docs/adr/0058-a.md\n',
    '1 referencing file(s):\n  - README.md',
    "\n⚠️  1 bare reference(s) to 0057 under keys this tool does not rewrite (ambiguous namespace) — review by hand:\n  - docs/adr/0060-b.md: related: '0057'",
  ];

  it('dry-runs with referencing files and ambiguous residuals listed', () => {
    const root = referenced();
    assert.deepEqual(run(root, ['adr', '0057', '0058']), { code: 0, out: [...LISTED, DRY_RUN], err: [] });
    assert.equal(read(root, 'README.md'), 'See ADR-0057.\n');
  });

  it('applies with --apply in any position, for a kind named in any case', () => {
    const root = referenced();
    assert.deepEqual(run(root, ['--apply', 'ADR', '0057', '0058']), {
      code: 0,
      out: [...LISTED, '\n✅ Renumbered 0057 → 0058; 2 file(s) written.\n   Review with `git diff` and `git status`, then commit.'],
      err: [],
    });
    assert.equal(read(root, 'README.md'), 'See ADR-0058.\n');
    assert.equal(read(root, 'docs/adr/0058-a.md'), "---\nadr: '0058'\n---\n\n# ADR-0058: A\n");
    assert.equal(existsSync(join(root, 'docs/adr/0057-a.md')), false);
  });
});

/**
 * The frontmatter rewrite against a YAML parser (failsafe schema). Model: a frontmatter block of relationship keys
 * this kind owns and keys it does not, each holding a reference (`0040`), a reference with a description (`0040 (Foo,
 * 0040 bar)`), a reference list (`0005, 0040`), or a list of those. Values are written plain where YAML allows,
 * single-quoted with `''`, double-quoted with `\"`, with trailing comments, as one-line or wrapped flow lists and as
 * block lists broken by blank and comment lines, each with LF and CRLF. The property: YAML reads the rewritten block as
 * the model with `from` renumbered to `to` in owned values only, and the text is the model's own rendering, byte for
 * byte. Out of model: anchors, block scalars and nested mappings. A seeded generator stands in for a property library.
 */
describe('rewriteRelationships as YAML reads it', () => {
  const PATH = 'docs/adr/0001-x.md';
  const OWNED: readonly string[] = ['supersedes', 'superseded_by'];
  const NOT_OWNED: readonly string[] = ['related', 'related_rfc'];
  const FROM = '0040';
  const TO = '0077';
  const RUNS = 300;
  const rewrite = (text: string): string => rewriteRelationships(text, ADR, FROM, TO, PATH);

  type Value = string | string[];
  interface Style {
    readonly style: number;
    readonly list: 'flow' | 'wrapped' | 'block';
    readonly comment: string;
    readonly gap: string;
  }
  interface Entry {
    readonly key: string;
    readonly data: Value;
    readonly style: Style;
  }

  /** mulberry32: a small seeded generator, so every run reads the same blocks. */
  function generator(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** What a renumber means for one value: the module's documented contract. */
  function renumbered(value: string): string {
    if (/^\s*\d{4}(\s*,\s*\d{4})*\s*$/.test(value)) return value.replace(/\d{4}/g, (n) => (n === FROM ? TO : n));
    return value.replace(/^(\s*)(\d{4})(?!\d)/, (whole, lead: string, n: string) => (n === FROM ? `${lead}${TO}` : whole));
  }

  /** Plain only where YAML reads the text back unchanged in that context. */
  function spell(text: string, style: number, inFlow: boolean): string {
    const plainSafe = /^[\w ().-]+$/.test(text) && !(inFlow && text.includes(','));
    if (style === 0 && plainSafe) return text;
    if (style === 2) return `"${text.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
    return `'${text.replaceAll("'", "''")}'`;
  }

  function render({ key, data, style }: Entry): string {
    if (typeof data === 'string') return `${key}: ${spell(data, style.style, false)}${style.comment}`;
    const items = data.map((item) => spell(item, style.style, style.list !== 'block'));
    if (style.list === 'flow') return `${key}: [${items.join(', ')}]${style.comment}`;
    if (style.list === 'wrapped') return [`${key}:`, '  [', ...items.map((item) => `    ${item},${style.comment}`), '  ]'].join('\n');
    return [`${key}:${style.comment}`, ...items.map((item) => `  - ${item}${style.gap}`)].join('\n');
  }

  function blocks(seed: number, runs: number): Entry[][] {
    const next = generator(seed);
    const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T;
    const number = () => pick([FROM, '0041', '0004']);
    const value = (): string => {
      const shape = pick([0, 1, 2, 3]);
      if (shape === 0) return number();
      if (shape === 1) return `${number()} ${pick(['(Foo)', '(Foo, 0040 bar)', "(it's)"])}`;
      if (shape === 2) return `${number()}, ${number()}`;
      return `${number()} ${pick(['(say "x")', '(a # b)', '(see [x])'])}`;
    };
    const data = (): Value => (next() < 0.5 ? value() : Array.from({ length: 1 + Math.floor(next() * 3) }, value));
    const style = (): Style => ({ style: pick([0, 1, 2]), list: pick(['flow', 'wrapped', 'block'] as const), comment: pick(['', ' # note', ' # 0040']), gap: pick(['', '\n', '\n  # 0040 note']) });
    return Array.from({ length: runs }, () => {
      const keys = [...OWNED, ...NOT_OWNED].sort(() => next() - 0.5).slice(0, 1 + Math.floor(next() * 4));
      return keys.map((key) => ({ key, data: data(), style: style() }));
    });
  }

  const model = (entries: readonly Entry[]): Record<string, Value> => Object.fromEntries(entries.map(({ key, data }) => [key, data]));
  const expected = (entries: readonly Entry[]): Entry[] =>
    entries.map((entry) => (OWNED.includes(entry.key) ? { ...entry, data: typeof entry.data === 'string' ? renumbered(entry.data) : entry.data.map(renumbered) } : entry));
  const text = (entries: readonly Entry[]): string => entries.map(render).join('\n');
  const yaml = (source: string): unknown => parse(source, { schema: 'failsafe' });
  const SET = blocks(20_089, RUNS);

  it('the generator writes YAML the parser reads as the model, and some of it names the source in owned keys', () => {
    for (const entries of SET) assert.deepEqual(yaml(text(entries)), model(entries), text(entries));
    const moving = SET.filter((entries) => text(expected(entries)) !== text(entries)).length;
    assert.ok(moving > RUNS / 4 && moving < RUNS, `${String(moving)} of ${String(RUNS)} blocks move`);
  });

  for (const [label, ending] of [
    ['LF', '\n'],
    ['CRLF', '\r\n'],
  ] as const) {
    it(`renumbers owned values and leaves the rest as written (${label})`, () => {
      for (const entries of SET) {
        const before = text(entries).replaceAll('\n', ending);
        const after = rewrite(before);
        assert.equal(after, text(expected(entries)).replaceAll('\n', ending), before);
        assert.deepEqual(yaml(after.replaceAll('\r\n', '\n')), model(expected(entries)), before);
        // Line endings survive the rewrite, one for one.
        assert.equal(after.split('\r').length, before.split('\r').length);
      }
    });
  }

  for (const [label, before, after] of [
    // Shapes an earlier rewrite left stale.
    ['a CRLF scalar', "supersedes: '0040'\r\n", "supersedes: '0077'\r\n"],
    ['a quoted value with a comment', "supersedes: '0040' # why\n", "supersedes: '0077' # why\n"],
    ['a wrapped flow list', "superseded_by:\n  [\n    '0040 (Foo)',\n    '0041',\n  ]\n", "superseded_by:\n  [\n    '0077 (Foo)',\n    '0041',\n  ]\n"],
    ['a bracket inside a quoted description', "supersedes: ['0040 (see [x])', '0041']\n", "supersedes: ['0077 (see [x])', '0041']\n"],
    ['a block list broken by a comment line', "supersedes:\n  - '0041'\n  # note\n  - '0040'\n", "supersedes:\n  - '0041'\n  # note\n  - '0077'\n"],
  ] as const) {
    it(label, () => {
      assert.equal(rewrite(before), after);
    });
  }
});
