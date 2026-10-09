/**
 * Comparison key for artist names.
 * Mobile parity: `String.normalizedArtistKey()` — trim, collapse whitespace runs, lowercase.
 * Lives in its own module so both `library.ts` and `artistSplitRules.ts` share one definition.
 */
export function normalizedArtistKey(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}
