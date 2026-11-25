import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { instant } from './instant.ts';

describe('instant', () => {
  it("reads GitHub's timestamps, to the second, in UTC", () => {
    assert.equal(instant('2026-11-25T11:59:29Z'), Date.UTC(2026, 10, 25, 11, 59, 29));
    assert.equal(instant('1970-01-01T00:00:00Z'), 0);
  });

  it('reads a fraction to the millisecond, and drops what is finer', () => {
    assert.equal(instant('2026-11-25T11:59:29.5Z'), Date.UTC(2026, 10, 25, 11, 59, 29, 500));
    assert.equal(instant('2026-11-25T11:59:29.123456Z'), Date.UTC(2026, 10, 25, 11, 59, 29, 123));
  });

  it('reads an offset east and west of UTC', () => {
    assert.equal(instant('2026-11-25T17:29:29+05:30'), Date.UTC(2026, 10, 25, 11, 59, 29));
    assert.equal(instant('2026-11-25T03:59:29-08:00'), Date.UTC(2026, 10, 25, 11, 59, 29));
    assert.equal(instant('2026-11-25T11:59:29+00:00'), instant('2026-11-25T11:59:29Z'));
  });

  it('orders times that text orders wrongly', () => {
    const later = instant('2026-11-25T11:30:00Z');
    const earlier = instant('2026-11-25T12:00:00+01:00');
    assert.ok(later !== undefined && earlier !== undefined && later > earlier, 'noon at +01:00 is 11:00 UTC');
  });

  it('reads a leap day in a leap year', () => {
    assert.equal(instant('2028-02-29T00:00:00Z'), Date.UTC(2028, 1, 29));
  });

  it('reads years 0 to 99 as written, not as 1900 to 1999', () => {
    const early = (year: number, month: number, day: number) => new Date(Date.UTC(2000, 0, 1)).setUTCFullYear(year, month, day);
    assert.equal(instant('0099-11-25T00:00:00Z'), early(99, 10, 25));
    assert.equal(instant('0000-02-29T00:00:00Z'), early(0, 1, 29), 'year 0 is a leap year');
    assert.equal(instant('0099-02-29T00:00:00Z'), undefined, '99 is not');
  });

  it('is undefined for text with no offset, or that is not a date and time', () => {
    for (const text of [undefined, '', '2026-11-25', '2026-11-25T11:59:29', '2026-11-25 11:59:29Z', ' 2026-11-25T11:59:29Z', '2026-11-25T11:59:29Zx', '2026-11-25T11:59Z']) {
      assert.equal(instant(text), undefined, String(text));
    }
  });

  it('is undefined for a time that does not exist', () => {
    for (const text of [
      '2026-02-29T00:00:00Z',
      '2026-04-31T00:00:00Z',
      '2026-13-01T00:00:00Z',
      '2026-00-10T00:00:00Z',
      '2026-11-00T00:00:00Z',
      '2026-11-25T24:00:00Z',
      '2026-11-25T11:60:00Z',
      '2026-11-25T11:59:60Z',
      '2026-11-25T11:59:29+24:00',
      '2026-11-25T11:59:29+05:60',
    ]) {
      assert.equal(instant(text), undefined, text);
    }
  });
});
