import { describe, expect, it } from "vitest";
import { resolveDropOrder } from "./SortableList";

describe("single-list drop resolution", () => {
  it("moves once from the unchanged drag baseline in either direction", () => {
    const baseline = ["a", "b", "c"];
    expect(resolveDropOrder(baseline, "a", "c")).toEqual(["b", "c", "a"]);
    expect(resolveDropOrder(baseline, "c", "a")).toEqual(["c", "a", "b"]);
    expect(baseline).toEqual(["a", "b", "c"]);
  });
  it("keeps the original order on a cancelled or invalid drop", () => {
    const baseline = ["a", "b"];
    expect(resolveDropOrder(baseline, "a", null)).toBe(baseline);
    expect(resolveDropOrder(baseline, "a", "a")).toBe(baseline);
    expect(resolveDropOrder(baseline, "a", "removed")).toBe(baseline);
  });
});
