import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { UNKNOWN, commands } from './shell.ts';

const FILES = new Map([
  ['body.md', 'from a file\n'],
  ['two.md', 'two lines end it\n\n'],
]);
const read = (path: string): string | undefined => FILES.get(path);

/** Each command's words as text, unknown parts shown as ?. */
function words(line: string): string[][] {
  return commands(line, read).map((simple) => simple.words.map((word) => word.text.replaceAll(UNKNOWN, '?')));
}

const stdin = (line: string, at = 0) => commands(line, read)[at]?.stdin;

describe('commands', () => {
  it('splits words and commands as a shell does', () => {
    assert.deepEqual(words('gh pr list; git push && echo "a b" || x | y & z'), [['gh', 'pr', 'list'], ['git', 'push'], ['echo', 'a b'], ['x'], ['y'], ['z']]);
    assert.deepEqual(words('(cd x) # a comment\nnext   one\t two'), [['cd', 'x'], ['next', 'one', 'two']]);
    assert.deepEqual(words('a#b'), [['a#b']]);
    assert.deepEqual(words('a # a last comment'), [['a']]);
  });

  it('reads a line of characters outside the basic plane whole', () => {
    assert.deepEqual(words('x "🎉🎉🎉🎉" 🎉🎉'), [['x', '🎉🎉🎉🎉', '🎉🎉']]);
  });

  it('works out quotes and escapes', () => {
    assert.deepEqual(words(`say 'it''s' "a \\"q\\" \\$x \\\\ \\z" b\\ c d\\\ne`), [['say', 'its', 'a "q" $x \\ \\z', 'b c', 'de']]);
    assert.deepEqual(words(`x $'a\\nb\\tc\\'d' $'e'`), [['x', 'a\nb\tc\'d', 'e']]);
    assert.deepEqual(words(`x "" ''`), [['x', '', '']]);
    assert.deepEqual(words(`x 'open`), [['x', 'open']]);
    assert.deepEqual(words('x a\\'), [['x', 'a']]);
    assert.deepEqual(words(`x $'tail\\`), [['x', 'tail\\']]);
    assert.deepEqual(words(`x 'a b' "open`), [['x', 'a b', 'open']]);
    assert.deepEqual(words('x "a\n\\$b\\\nc"'), [['x', 'a\n$bc']], 'a backslash and a line break inside double quotes are dropped');
    assert.deepEqual(words(`x "$'a'"`), [['x', "$'a'"]], "double quotes keep $'…' as written");
  });

  it('marks what only the running shell knows', () => {
    assert.deepEqual(words('echo $HOME ${X:-y} $1 $? $((1+2)) `date` "$(date)" "`id`" $ a$'), [['echo', '?', '?', '?', '?', '?', '?', '?', '?', '$', 'a$'], ['date'], ['date'], ['id']]);
    const [simple] = commands('echo "$X tail" "head $Y"', read);
    assert.deepEqual(
      simple?.words.map(({ known, opensUnknown }) => ({ known, opensUnknown })),
      [
        { known: true, opensUnknown: false },
        { known: false, opensUnknown: true },
        { known: false, opensUnknown: false },
      ],
    );
    assert.deepEqual(words('echo ${a{b}c} `a\\`b` ${open'), [['echo', '?', '?', '?'], ['a?'], ['b']], 'an escaped backquote nests a substitution, as in bash');
    assert.deepEqual(words('x $1abc $((1+2) y'), [['x', '?abc', '?']], 'a digit parameter is one character; an open $(( runs to the end');
    assert.deepEqual(words('x `a)b`'), [['x', '?'], ['a'], ['b']], 'a backquoted command ends nothing at a )');
    assert.deepEqual(words('x `` y'), [['x', '?', 'y']], 'an empty backquoted command runs nothing');
    assert.deepEqual(words('x $a(b) $HOME'), [['x', '?'], ['b'], ['?']], 'only $(( opens arithmetic, and a name may end the line');
  });

  it("reads cat's heredoc or file in a command substitution", () => {
    assert.deepEqual(words("gh x --body \"$(cat <<'EOF'\nline one\n  line (two)\nEOF\n)\" --after"), [['gh', 'x', '--body', 'line one\n  line (two)', '--after'], ['cat']]);
    assert.deepEqual(words('x "$(cat body.md)" $(cat missing) $(cat a b) $(ls) $(cat "$F") $(a; b)')[0], ['x', 'from a file', '?', '?', '?', '?', '?']);
    assert.deepEqual(words('echo $(gh issue comment 1 -b hi) `gh pr comment 2 -b yo`').slice(1), [['gh', 'issue', 'comment', '1', '-b', 'hi'], ['gh', 'pr', 'comment', '2', '-b', 'yo']], 'the commands a substitution runs are read too');
    assert.deepEqual(words('x $(cat)'), [['x', '?'], ['cat']]);
    assert.deepEqual(words('x $() $(cat body.md; cat body.md) $(head body.md) $(cat body.md body.md) $(cat two.md)')[0], ['x', '?', '?', '?', '?', 'two lines end it']);
    const anything = (): string => 'any file';
    assert.deepEqual(commands('x "$(cat $F)"', anything)[0]?.words[1]?.text, UNKNOWN, 'a file named in part by the running shell is not read');
  });

  it('feeds heredocs, here-strings and < files to their command', () => {
    assert.deepEqual(stdin("cmd <<'EOF'\nbody $X\nEOF\nafter"), { text: 'body $X\n', known: true, opensUnknown: false });
    assert.deepEqual(stdin('cmd <<EOF\nplain\nEOF'), { text: 'plain\n', known: true, opensUnknown: false });
    assert.deepEqual(stdin('cmd <<EOF\n$X then\nEOF'), { text: '$X then\n', known: false, opensUnknown: true });
    assert.deepEqual(stdin('cmd <<"EOF"\n`x`\nEOF'), { text: '`x`\n', known: true, opensUnknown: false });
    assert.deepEqual(stdin('cmd <<-\\EOF\n\tindented\n\tEOF'), { text: 'indented\n', known: true, opensUnknown: false });
    assert.deepEqual(stdin('cmd <<EOF\nunterminated'), { text: 'unterminated\n', known: true, opensUnknown: false });
    assert.deepEqual(stdin('cmd <<EOF\nunterminated\n'), { text: 'unterminated\n', known: true, opensUnknown: false });
    assert.deepEqual(stdin('cmd <<-EOF\n\t\tin\tner\nin\tner\n\tEOF'), { text: 'in\tner\nin\tner\n', known: true, opensUnknown: false }, '<<- strips only the tabs a line opens with');
    assert.deepEqual(stdin('cmd <<EOF\n  $X\nEOF'), { text: '  $X\n', known: false, opensUnknown: true });
    assert.deepEqual(stdin('cmd <<EOF\nhead $X\nEOF'), { text: 'head $X\n', known: false, opensUnknown: false });
    // The shell takes a delimiter as written, quotes off, never expanded.
    assert.deepEqual(words('cmd <<$D\nbody\n$D\ngh after'), [['cmd'], ['gh', 'after']]);
    assert.equal(stdin("cmd <<'$D'\nbody\n$D")?.text, 'body\n');
    assert.deepEqual(stdin('cmd <<< "a string"'), { text: 'a string\n', known: true, opensUnknown: false });
    assert.deepEqual(stdin('cmd <<<'), { text: '\n', known: true, opensUnknown: false });
    assert.deepEqual(stdin('cmd <<< "a\\"b" c'), { text: 'a"b\n', known: true, opensUnknown: false });
    assert.deepEqual(words('cmd <<< "a\\"b" c'), [['cmd', 'c']]);
    assert.deepEqual(stdin("cmd <<< 'a\\' b"), { text: 'a\\\n', known: true, opensUnknown: false });
    assert.deepEqual(words("cmd <<< 'a\\' b"), [['cmd', 'b']], 'a backslash escapes nothing in single quotes');
    assert.deepEqual(stdin("cmd <<< 'a b' c"), { text: 'a b\n', known: true, opensUnknown: false });
    assert.deepEqual(words("cmd <<< 'a b' c"), [['cmd', 'c']]);
    assert.deepEqual(stdin('cmd < body.md'), { text: 'from a file\n', known: true, opensUnknown: false });
    assert.deepEqual(stdin('cmd <\tbody.md'), { text: 'from a file\n', known: true, opensUnknown: false });
    assert.deepEqual(stdin('cmd < missing'), { text: '', known: false, opensUnknown: true });
    assert.deepEqual(stdin('cmd < "$F"'), { text: '', known: false, opensUnknown: true });
    assert.deepEqual(words("a <<'X' && b <<'Y'\none\nX\ntwo\nY\nc"), [['a'], ['b'], ['c']]);
    assert.equal(stdin("a <<'X' && b <<'Y'\none\nX\ntwo\nY", 1)?.text, 'two\n');
  });

  it('skips output redirections and their file descriptors', () => {
    assert.deepEqual(words('cmd arg 2>&1 >out.txt >> "log" 3<&0 x2>y'), [['cmd', 'arg', 'x2']]);
    assert.equal(stdin('cmd 2>&1'), undefined);
    assert.equal(stdin('cmd > body.md'), undefined, 'an output file feeds nothing');
    assert.equal(stdin('cmd <&0'), undefined, 'nor does a duplicated descriptor');
    assert.deepEqual(words('cmd 2x>y 10>log'), [['cmd', '2x']], 'only a word of digits is a descriptor');
    assert.deepEqual(words('cmd > a\\ b c'), [['cmd', 'c']], 'an escaped blank is part of the file name');
    assert.deepEqual(words('cmd a>b\rc'), [['cmd', 'a', '\rc']], 'a redirection ends the word before it');
    assert.deepEqual(words('cmd > 🎉x y `🎉` z'), [['cmd', 'y', '?', 'z'], ['🎉']], 'characters outside the basic plane count whole');
  });

  it('reads the script of sh -c, bash -c and the like', () => {
    assert.deepEqual(words(`bash -c 'gh pr comment 1 --body "hi"'`), [['bash', '-c', 'gh pr comment 1 --body "hi"'], ['gh', 'pr', 'comment', '1', '--body', 'hi']]);
    assert.deepEqual(words('/bin/sh -lc x'), [['/bin/sh', '-lc', 'x'], ['x']]);
    assert.deepEqual(words('bash --rcfile x'), [['bash', '--rcfile', 'x']]);
    assert.deepEqual(words('zsh -c "$X"'), [['zsh', '-c', '?']]);
    assert.deepEqual(words('sh -c'), [['sh', '-c']]);
    assert.deepEqual(words(`bash -ce 'gh x'`), [['bash', '-ce', 'gh x'], ['gh', 'x']]);
    assert.deepEqual(words(`fish -c 'gh x'`), [['fish', '-c', 'gh x']], 'fish is not a shell read here');
    for (const line of ['shell -c x', 'git -c a=b status', 'x -c sh y', 'bash -c1 x']) assert.deepEqual(words(line), [line.split(' ')], `${line} runs no script`);
  });
});
