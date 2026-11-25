/**
 * Strict instants from ISO 8601 text, such as GitHub's `created_at`, so that
 * two times compare as times rather than as text (#639). The asks and
 * issue-type jobs read times through this one parser.
 */

// Date and time to the second, an optional fraction, and `Z` or an offset: the offset is required.
const ISO = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(?:Z|([+-])(\d{2}):(\d{2}))$/;

// One group of the match as a whole number; a group the text left out is 0.
function whole(digits: string | undefined): number {
  const value = Number(digits ?? '0');
  return Number.isSafeInteger(value) ? value : 0;
}

/**
 * Milliseconds since the epoch at `text`, or undefined where `text` is not
 * an ISO 8601 date and time with `Z` or an offset, or names a time that does
 * not exist (`2026-02-29`, `24:00`, an offset past 23:59).
 */
export function instant(text: string | undefined): number | undefined {
  const match = ISO.exec(text ?? '');
  if (!match) return undefined;
  const [year, month, day, hour, minute, second] = [whole(match[1]), whole(match[2]), whole(match[3]), whole(match[4]), whole(match[5]), whole(match[6])];
  const [offsetHours, offsetMinutes] = [whole(match[9]), whole(match[10])];
  if (hour > 23 || minute > 59 || second > 59 || offsetHours > 23 || offsetMinutes > 59) return undefined;
  const milliseconds = whole((match[7] ?? '').slice(0, 3).padEnd(3, '0'));
  // Date.UTC reads years 0 to 99 as 1900 to 1999, so the year is set on its own, and rolls an impossible day into the
  // next month, which the round trip catches.
  const date = new Date(Date.UTC(2000, month - 1, day, hour, minute, second, milliseconds));
  date.setUTCFullYear(year, month - 1, day);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return undefined;
  const offset = (match[8] === '-' ? -1 : 1) * (offsetHours * 60 + offsetMinutes) * 60_000;
  return date.getTime() - offset;
}
