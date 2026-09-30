import { describe, expect, it } from "vitest";
import { buildMatchTargetModes } from "./batchMatch";

describe("batch match modes", () => {
  it("restricts lyric matching to the lyrics field", () => {
    const modes = buildMatchTargetModes("lyrics");
    expect(modes.lyrics).toBe("supplement");
    expect(modes.cover_url).toBe("disabled");
    expect(modes.title).toBe("disabled");
  });

  it("restricts cover matching to the cover field", () => {
    const modes = buildMatchTargetModes("cover");
    expect(modes.cover_url).toBe("supplement");
    expect(modes.lyrics).toBe("disabled");
    expect(modes.title).toBe("disabled");
  });
});
