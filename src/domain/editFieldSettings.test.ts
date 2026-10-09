import { describe, expect, it } from "vitest";
import { normalizeEditFieldOrder, DEFAULT_EDIT_FIELD_ORDER } from "./editFieldSettings";
describe("edit field order", () => {
  it("keeps individual field preferences and appends missing fields", () => {
    expect(normalizeEditFieldOrder(["lyrics", "lyrics", "unknown"])).toEqual(["lyrics", ...DEFAULT_EDIT_FIELD_ORDER.filter(key => key !== "lyrics")]);
  });
  it("migrates legacy group order to editable field rows", () => {
    const order = normalizeEditFieldOrder(["track", "credits", "basic"]);
    expect(order.slice(0, 6)).toEqual(["trackNumber", "discNumber", "composer", "lyricist", "copyright", "comment"]);
    expect(new Set(order).size).toBe(DEFAULT_EDIT_FIELD_ORDER.length);
    expect(order).not.toContain("basic");
  });
});
