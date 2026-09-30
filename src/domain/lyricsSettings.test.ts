import { describe, expect, it } from "vitest";
import { normalizeCleanupKeywords, normalizeLyricLineOrder } from "./lyricsSettings";

describe("lyrics settings", () => {
  it("keeps a unique configured order and appends missing lyric tracks", () => {
    expect(normalizeLyricLineOrder(["translation", "translation"])).toEqual([
      "translation",
      "original",
      "romanization",
    ]);
  });

  it("trims, removes blanks, and de-duplicates cleanup keywords", () => {
    expect(normalizeCleanupKeywords([" 作词 : ", "", "作词 :", "来源"])).toEqual([
      "作词 :",
      "来源",
    ]);
  });
});
