import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { appendToArray, removeElements, replaceValues, setMember } from './jsonedit.ts';

const entry = { hooks: [{ type: 'command', command: 'run "it"' }] };

describe('appendToArray', () => {
  it('adds to an existing array, keeping the rest of the text as it was', () => {
    const text = '{\n  "env": { "A": "1" },\n  "hooks": {\n    "SessionStart": [\n      { "hooks": [] }\n    ],\n    "Stop": []\n  }\n}\n';
    const out = appendToArray(text, ['hooks'], 'SessionStart', entry);
    assert.equal(
      out,
      '{\n  "env": { "A": "1" },\n  "hooks": {\n    "SessionStart": [\n      { "hooks": [] },\n      {\n        "hooks": [\n          {\n            "type": "command",\n            "command": "run \\"it\\""\n          }\n        ]\n      }\n    ],\n    "Stop": []\n  }\n}\n',
    );
    assert.deepEqual(JSON.parse(out).hooks.SessionStart[1], entry);
  });

  it('fills an empty array', () => {
    const out = appendToArray('{\n  "hooks": {\n    "SessionStart": []\n  }\n}\n', ['hooks'], 'SessionStart', 1);
    assert.equal(out, '{\n  "hooks": {\n    "SessionStart": [\n      1\n    ]\n  }\n}\n');
  });

  it('adds a missing array, and a missing object on the way', () => {
    const noKey = appendToArray('{\n  "hooks": {\n    "Stop": [ "x, y" ]\n  }\n}\n', ['hooks'], 'SessionStart', 1);
    assert.deepEqual(JSON.parse(noKey), { hooks: { Stop: ['x, y'], SessionStart: [1] } });
    assert.match(noKey, /"Stop": \[ "x, y" \],\n {4}"SessionStart": \[\n {6}1\n {4}\]\n {2}\}/);
    const noObject = appendToArray('{\n  "env": {},\n  "n": -1.5e3, "t": true, "z": null\n}\n', ['hooks'], 'SessionStart', 1);
    assert.deepEqual(JSON.parse(noObject), { env: {}, n: -1500, t: true, z: null, hooks: { SessionStart: [1] } });
    assert.deepEqual(JSON.parse(appendToArray('{}', ['hooks'], 'SessionStart', 1)), { hooks: { SessionStart: [1] } });
  });

  it('skips nested values and escaped quotes while it reads', () => {
    const text = '{ "a\\"b": { "hooks": ["}"] }, "hooks": { "SessionStart": [ { "k": "]" } ] } }';
    assert.deepEqual(JSON.parse(appendToArray(text, ['hooks'], 'SessionStart', 2)).hooks.SessionStart, [{ k: ']' }, 2]);
  });

  it("writes in the file's own indentation and line endings", () => {
    const four = appendToArray('{\n    "hooks": { "SessionStart": [] }\n}\n', ['hooks'], 'SessionStart', { a: 1 });
    assert.equal(four, '{\n    "hooks": { "SessionStart": [\n        {\n            "a": 1\n        }\n    ] }\n}\n');
    const tabs = appendToArray('{\n\t"env": {}\n}\n', ['hooks'], 'SessionStart', 1);
    assert.equal(tabs, '{\n\t"env": {},\n\t"hooks": {\n\t\t"SessionStart": [\n\t\t\t1\n\t\t]\n\t}\n}\n');
    const crlf = appendToArray('{\r\n  "hooks": {\r\n    "SessionStart": [\r\n      0\r\n    ]\r\n  }\r\n}\r\n', ['hooks'], 'SessionStart', [1]);
    assert.equal(crlf, '{\r\n  "hooks": {\r\n    "SessionStart": [\r\n      0,\r\n      [\r\n        1\r\n      ]\r\n    ]\r\n  }\r\n}\r\n');
    assert.equal(appendToArray('{}\r\n', [], 'k', 1), '{\r\n  "k": [\r\n    1\r\n  ]\r\n}\r\n');
  });

  it('refuses a value of the wrong shape, and reads a repeated key as JSON.parse does', () => {
    assert.throws(() => appendToArray('{ "hooks": "x" }', ['hooks'], 'SessionStart', 1), /^Error: hooks is not an object$/);
    assert.throws(() => appendToArray('{ "hooks": { "SessionStart": {} } }', ['hooks'], 'SessionStart', 1), /^Error: hooks\.SessionStart is not an array$/);
    const repeated = appendToArray('{ "hooks": "x", "hooks": { "SessionStart": [] } }', ['hooks'], 'SessionStart', 1);
    assert.deepEqual(JSON.parse(repeated), { hooks: { SessionStart: [1] } });
    assert.throws(() => appendToArray('{ "a": "x" }', ['a', 'b'], 'k', 1), /^Error: a is not an object$/, 'names the path up to the value, no further');
    assert.throws(() => appendToArray('{ "a": { "b": 1 } }', ['a', 'b', 'c'], 'k', 1), /^Error: a\.b is not an object$/);
  });

  it('reads every kind of value on the way, with or without space around it', () => {
    const text = '{"s":"a\\\\","q":"\\"{[","n":-1.5e3,"t":true,"f":false,"z":null,"o":{"x":[1,{"y":"]}"}]},"e":{},"l":[],"k":[0]}';
    assert.equal(appendToArray(text, [], 'k', 1), text.replace('"k":[0]', '"k":[0,\n  1]'));
    const spaced = '{ \t\r\n"o" : { "x" : [ 1 , 2 ] } ,\n "k" :\t[ 0 ] \n}';
    assert.equal(appendToArray(spaced, [], 'k', 1), '{ \t\r\n"o" : { "x" : [ 1 , 2 ] } ,\n "k" :\t[ 0,\r\n  1 ] \n}');
    assert.equal(appendToArray(spaced, ['o'], 'x', 3), '{ \t\r\n"o" : { "x" : [ 1 , 2,\r\n 3 ] } ,\n "k" :\t[ 0 ] \n}');
  });

  it('fills an array of spaces alone as an empty one', () => {
    assert.equal(appendToArray('{\n  "k": [ \n ]\n}', [], 'k', 1), '{\n  "k": [\n   1\n ]\n}');
    assert.equal(appendToArray('{ \n }', [], 'k', 1), '{\n  "k": [\n   1\n  ]\n }');
  });
});

describe('replaceValues', () => {
  const path = ['hooks', 'SessionStart', '*', 'hooks', '*', 'command'];
  const swap = (value: unknown) => (value === 'old' ? 'new' : undefined);

  it('swaps only the values at the path, where they stand', () => {
    const text = '{\n    "env": { "command": "old" },\n    "hooks": {\n        "Stop": [ { "hooks": [ { "command": "old" } ] } ],\n        "SessionStart": [ { "hooks": [ { "command": "o\\u006cd" }, { "command": "other" }, "old" ] }, null, { "hooks": "old" } ]\n    }\n}\n';
    const { text: out, replaced } = replaceValues(text, path, swap);
    assert.equal(replaced, 1);
    assert.equal(out, text.replace('"o\\u006cd"', '"new"'));
  });

  it('swaps every match, and nothing when the shape is not there', () => {
    const text = '{"hooks":{"SessionStart":[{"hooks":[{"command":"old"}]},{"hooks":[{"command":"old"},{"command":"old"}]}]}}';
    const { text: out, replaced } = replaceValues(text, path, swap);
    assert.equal(replaced, 3);
    assert.equal(out, text.replaceAll('"old"', '"new"'));
    assert.deepEqual(replaceValues('{ "hooks": [] }', path, swap), { text: '{ "hooks": [] }', replaced: 0 });
    assert.deepEqual(replaceValues('[1]', ['*'], () => 2), { text: '[2]', replaced: 1 });
  });

  it('walks into one element by its index', () => {
    const text = '{"hooks":{"Stop":[{"timeout":1},{"timeout":1}]}}';
    assert.deepEqual(replaceValues(text, ['hooks', 'Stop', '1', 'timeout'], () => 9), { text: '{"hooks":{"Stop":[{"timeout":1},{"timeout":9}]}}', replaced: 1 });
    assert.deepEqual(replaceValues(text, ['hooks', 'Stop', '2', 'timeout'], () => 9), { text, replaced: 0 }, 'past the end');
    assert.deepEqual(replaceValues(text, ['hooks', '0'], () => 9), { text, replaced: 0 }, 'an index into an object');
    assert.deepEqual(replaceValues('{"a":"xy"}', ['a', '0'], () => 9), { text: '{"a":"xy"}', replaced: 0 }, 'an index into a string');
    assert.deepEqual(replaceValues('{"a":1}', ['a', '*'], () => 9), { text: '{"a":1}', replaced: 0 }, 'every element of a number');
  });

  it('takes only digits as an index', () => {
    const text = '[5,6]';
    for (const name of ['', '1e0', '0x1', ' 1', 'a1', '1a']) assert.deepEqual(replaceValues(text, [name], () => 9), { text, replaced: 0 }, JSON.stringify(name));
    assert.deepEqual(replaceValues(text, ['1'], () => 9), { text: '[5,9]', replaced: 1 });
    const eleven = JSON.stringify(Array.from({ length: 11 }, (_, i) => i));
    assert.deepEqual(replaceValues(eleven, ['10'], () => 99), { text: eleven.replace('10]', '99]'), replaced: 1 }, 'an index of two digits');
  });

  it('reads past a string that holds spaces, commas and brackets', () => {
    assert.deepEqual(replaceValues('[" a, b] ", 1]', ['1'], () => 2), { text: '[" a, b] ", 2]', replaced: 1 });
    assert.deepEqual(replaceValues('{"a":"x y","b":1}', ['b'], () => 2), { text: '{"a":"x y","b":2}', replaced: 1 });
  });

  it('swaps values of another length, each where it stood', () => {
    assert.deepEqual(replaceValues('[1, 2,3]', ['*'], (value) => (value as number) * 100), { text: '[100, 200,300]', replaced: 3 });
  });
});

describe('removeElements', () => {
  const own = (value: unknown) => (value as { command?: unknown } | null)?.command === 'niyam';

  it('drops the elements taken, keeping the rest and its layout', () => {
    const text = '{\n  "hooks": {\n    "Stop": [\n      { "command": "a" },\n      { "command": "niyam" },\n      { "command": "b" }\n    ]\n  }\n}\n';
    const { text: out, removed } = removeElements(text, ['hooks', 'Stop'], own);
    assert.equal(removed, 1);
    assert.equal(out, '{\n  "hooks": {\n    "Stop": [\n      { "command": "a" },\n      { "command": "b" }\n    ]\n  }\n}\n');
  });

  it('drops the first and the last element alike, and every array the path reaches', () => {
    const text = '{"hooks":[{"hooks":[{"command":"niyam"},{"command":"a"}]},{"hooks":[{"command":"a"},{"command":"niyam"}]},{"hooks":[{"command":"niyam"}]}]}';
    const { text: out, removed } = removeElements(text, ['hooks', '*', 'hooks'], own);
    assert.equal(removed, 3);
    assert.equal(out, '{"hooks":[{"hooks":[{"command":"a"}]},{"hooks":[{"command":"a"}]},{"hooks":[]}]}');
  });

  it('leaves a text with nothing to drop, or no array at the path, as it is', () => {
    const text = '{ "hooks": { "Stop": [ { "command": "a" } ], "x": { "command": "niyam" } } }';
    assert.deepEqual(removeElements(text, ['hooks', 'Stop'], own), { text, removed: 0 });
    assert.deepEqual(removeElements(text, ['hooks', 'x'], own), { text, removed: 0 });
    assert.deepEqual(removeElements(text, ['nothing'], own), { text, removed: 0 });
    const uneven = '{ "a": [1, 2,3], "e": [ ] }';
    assert.deepEqual(removeElements(uneven, ['a'], () => false), { text: uneven, removed: 0 }, 'separators as written');
    assert.deepEqual(removeElements(uneven, ['e'], () => true), { text: uneven, removed: 0 }, 'an empty array as written');
    const other = '{ "a": { "b": 1 }, "s": "xy" }';
    for (const name of ['a', 's']) assert.deepEqual(removeElements(other, [name], () => true), { text: other, removed: 0 }, `${name} is no array`);
  });

  it('empties an array whose every element goes, space and all', () => {
    assert.deepEqual(removeElements('{ "a": [ 1, 2 ] }', ['a'], () => true), { text: '{ "a": [] }', removed: 2 });
    assert.deepEqual(removeElements('{ "a": [ 1 ] }', ['a'], () => true), { text: '{ "a": [] }', removed: 1 });
  });

  it('keeps one element as written, and joins those kept with the first separator', () => {
    assert.deepEqual(removeElements('[ 1 , 2 ]', [], (value) => value === 2), { text: '[ 1 ]', removed: 1 });
    assert.deepEqual(removeElements('[1, 2,  3]', [], (value) => value === 2), { text: '[1, 3]', removed: 1 });
  });
});

describe('setMember', () => {
  it('swaps a value where it stands, keeping the layout', () => {
    const text = '{\r\n    "env": { "A": "1", "B": "2" }\r\n}\r\n';
    assert.equal(setMember(text, ['env'], 'A', 'x'), '{\r\n    "env": { "A": "x", "B": "2" }\r\n}\r\n');
  });

  it('adds a missing key last, in the file\'s layout', () => {
    assert.equal(setMember('{\n    "env": {\n        "A": "1"\n    }\n}\n', ['env'], 'B', '2'), '{\n    "env": {\n        "A": "1",\n        "B": "2"\n    }\n}\n');
  });

  it('creates the objects on the way', () => {
    assert.deepEqual(JSON.parse(setMember('{}', ['env'], 'A', '1')), { env: { A: '1' } });
    assert.deepEqual(JSON.parse(setMember('{ "x": 1 }', ['a', 'b'], 'c', 2)), { x: 1, a: { b: { c: 2 } } });
  });

  it('walks into an array element by its index, which must be there', () => {
    const text = '{\n  "hooks": [\n    { "command": "a" },\n    { "command": "b", "timeout": 1 }\n  ]\n}\n';
    assert.equal(setMember(text, ['hooks', '1'], 'timeout', 9), text.replace('"timeout": 1', '"timeout": 9'));
    assert.deepEqual(JSON.parse(setMember(text, ['hooks', '0'], 'timeout', 9)).hooks, [{ command: 'a', timeout: 9 }, { command: 'b', timeout: 1 }]);
    assert.throws(() => setMember(text, ['hooks', '2'], 'timeout', 9), /^Error: hooks\.2 is not there$/);
    assert.throws(() => setMember(text, ['hooks'], 'timeout', 9), /^Error: hooks is not an object$/);
    assert.throws(() => setMember(text, ['hooks', '2', 'x'], 'k', 9), /^Error: hooks\.2 is not there$/, 'names the path up to the missing element, no further');
    assert.throws(() => setMember(text, ['hooks', '10'], 'k', 9), /^Error: hooks\.10 is not there$/, 'an index of two digits');
    for (const name of ['x1', '1x']) assert.throws(() => setMember(text, ['hooks', name], 'k', 9), /^Error: hooks is not an object$/, name);
    assert.throws(() => setMember('{ "env": "x" }', ['env', '0'], 'k', 9), /^Error: env is not an object$/, 'only an array is walked into by an index');
  });

  it('refuses a value on the way that is not an object, and undefined', () => {
    assert.throws(() => setMember('{ "env": [] }', ['env'], 'A', '1'), /^Error: env is not an object$/);
    assert.throws(() => setMember('{}', ['env'], 'A', undefined), /^Error: env\.A cannot be set to undefined$/);
    assert.throws(() => setMember('{ "a": { "b": "s" } }', ['a', 'b', 'c'], 'k', 1), /^Error: a\.b is not an object$/);
  });

  it('swaps in an object in the file\'s layout', () => {
    assert.equal(setMember('{\n    "a": {\n        "b": 1\n    }\n}\n', ['a'], 'b', { c: 2 }), '{\n    "a": {\n        "b": {\n            "c": 2\n        }\n    }\n}\n');
  });
});
