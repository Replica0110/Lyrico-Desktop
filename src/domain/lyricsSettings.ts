import type { LyricLineTrack } from "../app/types";

export type { LyricLineTrack };

export const DEFAULT_LYRIC_LINE_ORDER: LyricLineTrack[] = [
  "original",
  "romanization",
  "translation",
];

export function normalizeLyricLineOrder(
  order: readonly LyricLineTrack[] | undefined,
): LyricLineTrack[] {
  const result: LyricLineTrack[] = [];
  for (const item of [...(order ?? []), ...DEFAULT_LYRIC_LINE_ORDER]) {
    if (!result.includes(item)) result.push(item);
  }
  return result;
}

export function normalizeCleanupKeywords(
  keywords: readonly string[] | undefined,
): string[] {
  return [...new Set((keywords ?? []).map((keyword) => keyword.trim()).filter(Boolean))];
}
