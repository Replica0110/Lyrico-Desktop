import { describe, expect, it } from "vitest";
import { normalizeEditFieldOrder } from "./editFieldSettings";

describe("edit field order", () => {
  it("keeps configured groups unique and appends missing groups", () => {
    expect(normalizeEditFieldOrder(["lyrics", "lyrics"])).toEqual([
      "lyrics",
      "basic",
      "track",
      "credits",
      "customTags",
      "replaygain",
      "cover",
    ]);
  });
});
