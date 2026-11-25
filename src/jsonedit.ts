/**
 * Small edits to JSON text that keep everything else as it was: the client's
 * own layout, spacing, line endings and key order. Only well-formed JSON
 * objects are read.
 */

interface Span {
  start: number;
  end: number;
}

/** How the file lays itself out: its indentation step and line ending. */
interface Layout {
  unit: string;
  eol: string;
}

// The text is read with sticky patterns and recursion, never a loop that waits for a position to move on.
const SPACE = /\s*/y;
const INDENT = /[ \t]*/y;
const STRING = /"(?:[^"\\]|\\.)*"/y;
/** A number, true, false or null: what runs to the next space, comma or closing bracket. */
const BARE = /[^\s,}\]]*/y;
/** What an object's or array's end is found by: a bracket, or a string, which may hold brackets. */
const NESTING = /"(?:[^"\\]|\\.)*"|[{}[\]]/g;

/** Where the sticky pattern `sticky` stops matching `text` from `at`. */
function past(sticky: RegExp, text: string, at: number): number {
  sticky.lastIndex = at;
  sticky.test(text);
  return sticky.lastIndex;
}

const skipSpace = (text: string, at: number): number => past(SPACE, text, at);

/** The file's indentation step, that of its first indented line (two spaces when none is), and its line ending. */
function layoutOf(text: string): Layout {
  return { unit: /\n([ \t]+)\S/.exec(text)?.[1] ?? '  ', eol: text.includes('\r\n') ? '\r\n' : '\n' };
}

/** The end of the JSON value starting at `at`. */
function valueEnd(text: string, at: number): number {
  const first = text[at];
  if (first === '"') return past(STRING, text, at);
  if (first === '{' || first === '[') return nestedEnd(text, at);
  return past(BARE, text, at);
}

/** The end of the object or array starting at `at`: past the bracket that brings the depth back to none. */
function nestedEnd(text: string, at: number): number {
  let depth = 0;
  for (const { 0: token, index } of text.slice(at).matchAll(NESTING)) {
    if (token === '{' || token === '[') depth++;
    else if ((token === '}' || token === ']') && --depth === 0) return at + index + 1;
  }
  return text.length;
}

/**
 * The span of `key`'s value in the object starting at `objectStart`, or
 * undefined. A repeated key gives its last value, as JSON.parse reads it.
 */
function memberSpan(text: string, objectStart: number, key: string): Span | undefined {
  let found: Span | undefined;
  let at = skipSpace(text, objectStart + 1);
  // Each member takes a character at least, so the walk never takes more steps than the text has.
  for (const _ of text) {
    if (text[at] !== '"') break;
    const keyEnd = past(STRING, text, at);
    const name = JSON.parse(text.slice(at, keyEnd)) as string;
    const start = skipSpace(text, skipSpace(text, keyEnd) + 1);
    const end = valueEnd(text, start);
    if (name === key) found = { start, end };
    // The separator is passed over, whatever it is: past the object's closing bracket comes no string in well-formed JSON.
    at = skipSpace(text, skipSpace(text, end) + 1);
  }
  return found;
}

/** The spans of the elements of the array starting at `arrayStart`. */
function elementSpans(text: string, arrayStart: number): Span[] {
  const spans: Span[] = [];
  let at = skipSpace(text, arrayStart + 1);
  if (text[at] === ']') return spans;
  // Each element takes a character at least, so the walk never takes more steps than the text has.
  for (const _ of text) {
    const end = valueEnd(text, at);
    spans.push({ start: at, end });
    const next = skipSpace(text, end);
    if (text[next] !== ',') break;
    at = skipSpace(text, next + 1);
  }
  return spans;
}

/** The indentation of the line `at` is on. */
function lineIndent(text: string, at: number): string {
  const lineStart = text.lastIndexOf('\n', at - 1) + 1;
  return text.slice(lineStart, past(INDENT, text, lineStart));
}

/** `value` as JSON in the file's layout, indented to sit at `indent`. */
function indented(value: unknown, indent: string, { unit, eol }: Layout): string {
  return JSON.stringify(value, null, unit).split('\n').join(`${eol}${indent}`);
}

/**
 * The text with `value` added to the array at `object.key`, creating the key
 * (and the objects on the way) when missing, written in the file's own
 * indentation and line endings. `path` names the objects to walk. Refuses,
 * changing nothing, when a value on the way is not an object or the target
 * is not an array.
 */
export function appendToArray(text: string, path: string[], key: string, value: unknown): string {
  const layout = layoutOf(text);
  let objectStart = skipSpace(text, 0);
  for (const [i, name] of path.entries()) {
    const span = memberSpan(text, objectStart, name);
    if (!span) return addMember(text, objectStart, name, nest([...path.slice(i + 1), key], [value]), layout);
    if (text[span.start] !== '{') throw new Error(`${path.slice(0, i + 1).join('.')} is not an object`);
    objectStart = span.start;
  }
  const array = memberSpan(text, objectStart, key);
  if (!array) return addMember(text, objectStart, key, [value], layout);
  if (text[array.start] !== '[') throw new Error(`${[...path, key].join('.')} is not an array`);
  const { eol } = layout;
  const close = array.end - 1;
  const last = text.slice(array.start + 1, close).trimEnd();
  const outer = lineIndent(text, close);
  const inner = `${outer}${layout.unit}`;
  if (!last) return `${text.slice(0, array.start)}[${eol}${inner}${indented(value, inner, layout)}${eol}${outer}]${text.slice(array.end)}`;
  const lastEnd = array.start + 1 + last.length;
  return `${text.slice(0, lastEnd)},${eol}${inner}${indented(value, inner, layout)}${text.slice(lastEnd)}`;
}

/** `{ a: { b: value } }` for the path `[a, b]`. */
function nest(path: string[], value: unknown): unknown {
  return path.reduceRight<unknown>((inner, name) => ({ [name]: inner }), value);
}

/** The text with `name: value` added last in the object starting at `objectStart`. */
function addMember(text: string, objectStart: number, name: string, value: unknown, layout: Layout): string {
  const { eol } = layout;
  const close = valueEnd(text, objectStart) - 1;
  const body = text.slice(objectStart + 1, close).trimEnd();
  const outer = lineIndent(text, close);
  const inner = `${outer}${layout.unit}`;
  const member = `${inner}${JSON.stringify(name)}: ${indented(value, inner, layout)}`;
  const at = objectStart + 1 + body.length;
  return body
    ? `${text.slice(0, at)},${eol}${member}${eol}${outer}}${text.slice(close + 1)}`
    : `${text.slice(0, objectStart)}{${eol}${member}${eol}${outer}}${text.slice(close + 1)}`;
}

/** An array index in a path: digits alone. */
const INDEX = /^\d+$/;

/** The span of `name` in the value starting at `start`: a member of an object, or an element of an array by its index. */
function childSpan(text: string, start: number, name: string): Span | undefined {
  if (text[start] === '{') return memberSpan(text, start, name);
  return text[start] === '[' && INDEX.test(name) ? elementSpans(text, start)[Number(name)] : undefined;
}

/**
 * The spans of the values at `path`: `*` stands for every element of an
 * array, digits for one element; a value of another shape on the way is
 * passed over.
 */
function spansAt(text: string, path: string[]): Span[] {
  let spans: Span[] = [{ start: skipSpace(text, 0), end: text.length }];
  for (const name of path) {
    spans = spans.flatMap(({ start }) => {
      if (name === '*') return text[start] === '[' ? elementSpans(text, start) : [];
      const span = childSpan(text, start, name);
      return span ? [span] : [];
    });
  }
  return spans;
}

/**
 * The text with each value at `path` that `replace` maps to something new
 * swapped for it where it stands, and how many were swapped. `*` in `path`
 * stands for every element of an array, digits for one element; a value of
 * another shape on the way is passed over.
 */
export function replaceValues(text: string, path: string[], replace: (value: unknown) => unknown): { text: string; replaced: number } {
  const spans = spansAt(text, path);
  let out = text;
  let replaced = 0;
  // Last first, so each swap leaves the spans before it where they were.
  for (const { start, end } of spans.reverse()) {
    const next = replace(JSON.parse(text.slice(start, end)));
    if (next === undefined) continue;
    out = `${out.slice(0, start)}${JSON.stringify(next)}${out.slice(end)}`;
    replaced++;
  }
  return { text: out, replaced };
}

/**
 * The text without the elements of each array at `path` that `drop` takes,
 * and how many went. The elements kept stay as written, with the array's
 * own separators between them; an array left with none becomes `[]`. `path`
 * reads as in replaceValues.
 */
export function removeElements(text: string, path: string[], drop: (value: unknown) => boolean): { text: string; removed: number } {
  let out = text;
  let removed = 0;
  // Last first, so each edit leaves the spans before it where they were.
  for (const array of spansAt(text, path).reverse()) {
    if (text[array.start] !== '[') continue;
    const elements = elementSpans(text, array.start);
    const kept = elements.filter((span) => !drop(JSON.parse(text.slice(span.start, span.end))));
    if (kept.length === elements.length) continue;
    removed += elements.length - kept.length;
    const first = elements[0] as Span;
    const last = elements.at(-1) as Span;
    // With one element there is none between: the slice runs backwards and is empty.
    const between = text.slice(first.end, (elements[1] ?? first).start);
    const inside =
      kept.length === 0
        ? '[]'
        : `${text.slice(array.start, first.start)}${kept.map((span) => text.slice(span.start, span.end)).join(between)}${text.slice(last.end, array.end)}`;
    out = `${out.slice(0, array.start)}${inside}${out.slice(array.end)}`;
  }
  return { text: out, removed };
}

/**
 * The text with `object.key` set to `value`: swapped where it stands when
 * the key is there, else added last, creating the objects on the way.
 * Digits in `path` walk into an array's element, which must be there.
 * Refuses, changing nothing, when a value on the way is not an object.
 */
export function setMember(text: string, path: string[], key: string, value: unknown): string {
  if (value === undefined) throw new Error(`${[...path, key].join('.')} cannot be set to undefined`);
  const layout = layoutOf(text);
  let objectStart = skipSpace(text, 0);
  for (const [i, name] of path.entries()) {
    const span = childSpan(text, objectStart, name);
    if (!span) {
      if (text[objectStart] !== '{') throw new Error(`${path.slice(0, i + 1).join('.')} is not there`);
      return addMember(text, objectStart, name, nest([...path.slice(i + 1), key], value), layout);
    }
    // An array is walked into only by an index.
    const into = text[span.start] === '[' && INDEX.test(String(path[i + 1]));
    if (text[span.start] !== '{' && !into) throw new Error(`${path.slice(0, i + 1).join('.')} is not an object`);
    objectStart = span.start;
  }
  const member = memberSpan(text, objectStart, key);
  if (!member) return addMember(text, objectStart, key, value, layout);
  return `${text.slice(0, member.start)}${indented(value, lineIndent(text, member.start), layout)}${text.slice(member.end)}`;
}
