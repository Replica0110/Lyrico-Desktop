import { describe, expect, it } from "vitest";
import { getLibraryWindow } from "./libraryWindow";

describe("library window", () => {
  it("keeps the initial DOM limited to the viewport and overscan", () => {
    expect(getLibraryWindow(10_000, 0, 600, 60, 4)).toEqual({
      startIndex: 0,
      endIndex: 14,
    });
  });

  it("moves the rendered range with the scroll position", () => {
    expect(getLibraryWindow(10_000, 600, 600, 60, 4)).toEqual({
      startIndex: 6,
      endIndex: 24,
    });
  });

  it("clamps the range at the end of the collection", () => {
    expect(getLibraryWindow(5, 10_000, 600, 60, 4)).toEqual({
      startIndex: 0,
      endIndex: 5,
    });
  });
});
