import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { isNewer, packageVersion, versionOf } from './version.ts';

describe('packageVersion', () => {
  it("reads this package's package.json", () => {
    const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    assert.match(version, /^\d+\.\d+\.\d+/);
    assert.equal(packageVersion(), version);
  });
});

describe('versionOf', () => {
  it('gives the string version', () => {
    assert.equal(versionOf({ name: 'x', version: '1.2.3' }), '1.2.3');
    assert.equal(versionOf({ version: '' }), '');
  });

  it('throws for anything with no string version', () => {
    for (const raw of [null, undefined, 'version', 7, {}, { version: 1 }, { version: null }, ['1.2.3']]) {
      assert.throws(() => versionOf(raw), /^Error: package\.json has no string "version"$/, JSON.stringify(raw));
    }
  });
});

describe('isNewer', () => {
  it('orders releases by number, not as text', () => {
    assert.equal(isNewer('0.5.27', '0.5.20'), true);
    assert.equal(isNewer('0.5.10', '0.5.9'), true);
    assert.equal(isNewer('1.0.0', '0.99.99'), true);
    assert.equal(isNewer('10.0.0', '9.0.0'), true, 'a major of two digits');
    assert.equal(isNewer('0.6.0', '0.5.9'), true, 'the minor decides');
    assert.equal(isNewer('0.5.9', '0.6.0'), false);
    assert.equal(isNewer('0.5.20', '0.5.27'), false);
    assert.equal(isNewer('0.5.27', '0.5.27'), false, 'the same release is not newer');
  });

  it('is false for anything that is not a release number', () => {
    assert.equal(isNewer('main', '0.5.27'), false);
    assert.equal(isNewer('0.5', '0.4.0'), false);
    assert.equal(isNewer('1.1.2.3', '1.1.0'), false, 'four parts');
    assert.equal(isNewer('1.2.3.4', '1.2.2'), false, 'four parts, the last three newer');
    assert.equal(isNewer('2.0.0', '1.0.0-rc'), false);
    assert.equal(isNewer('v2.0.0', '1.0.0'), false);
  });
});
