export const DEFAULT_EDIT_FIELD_ORDER = [
  "basic",
  "track",
  "credits",
  "customTags",
  "replaygain",
  "lyrics",
  "cover",
] as const;

export function normalizeEditFieldOrder(order: readonly string[] | undefined) {
  const result: string[] = [];
  for (const value of [...(order ?? []), ...DEFAULT_EDIT_FIELD_ORDER]) {
    if (DEFAULT_EDIT_FIELD_ORDER.includes(value as (typeof DEFAULT_EDIT_FIELD_ORDER)[number]) && !result.includes(value)) {
      result.push(value);
    }
  }
  return result;
}
