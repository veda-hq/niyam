/** What a caught value says, never throwing itself: its message, else its text, else a stand-in. */
export function errorDetail(value: unknown): string {
  try {
    if (value instanceof Error && typeof value.message === 'string') return value.message;
    return String(value);
  } catch {
    // fail-open: a value with a hostile toString is described, not rethrown from the handler.
    return 'an error that cannot be described';
  }
}
