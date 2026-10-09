import { describe, expect, it } from "vitest";
import type { ArtistSplitConfig } from "../app/types";
import { defaultArtistSplitConfig, splitArtists } from "./library";

function config(overrides: Partial<ArtistSplitConfig> = {}): ArtistSplitConfig {
  return { ...defaultArtistSplitConfig, ...overrides };
}

describe("splitArtists", () => {
  it("splits the mobile default slash separator", () => {
    expect(splitArtists("A / B", config())).toEqual(["A", "B"]);
  });

  it("keeps a disabled built-in separator intact", () => {
    expect(splitArtists("A / B", config({ builtinSeparatorOverrides: { slash: false } }))).toEqual(["A / B"]);
  });

  it("supports optional ampersand splitting and the no-split allowlist", () => {
    const splitConfig = config({ builtinSeparatorOverrides: { ampersand: true }, customNoSplitArtists: [{ id: "duo", name: "Simon & Garfunkel", enabled: true }] });
    expect(splitArtists("A & B", splitConfig)).toEqual(["A", "B"]);
    expect(splitArtists("Simon & Garfunkel", splitConfig)).toEqual(["Simon & Garfunkel"]);
  });

  it("does not inject a built-in artist allowlist", () => {
    expect(splitArtists("Simon & Garfunkel", config({ builtinSeparatorOverrides: { ampersand: true } }))).toEqual(["Simon", "Garfunkel"]);
  });

  it("supports custom separators", () => {
    expect(
      splitArtists(
        "A feat. B",
        config({ customSeparators: [{ id: "custom", value: " feat. ", enabled: true }] }),
      ),
    ).toEqual(["A", "B"]);
  });

  it("preserves a no-split artist inside a longer multi-artist value", () => {
    expect(
      splitArtists(
        "周杰伦/R!N/Gemie/陈奕迅",
        config({ customNoSplitArtists: [{ id: "rin", name: "R!N/Gemie", enabled: true }] }),
      ),
    ).toEqual(["周杰伦", "R!N/Gemie", "陈奕迅"]);
  });

  it("returns the complete value when splitting is disabled", () => {
    expect(splitArtists("A / B", config({ enabled: false }))).toEqual(["A / B"]);
  });
});
