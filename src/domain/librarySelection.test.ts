import { describe, expect, it } from "vitest";
import { selectLibraryRow } from "./librarySelection";

const paths = ["first", "second", "third", "fourth", "fifth"];

describe("library row selection", () => {
  it("does not turn a normal row click into a batch selection", () => {
    expect(selectLibraryRow(paths, [], null, 1, { shiftKey: false, ctrlKey: false, metaKey: false })).toEqual({
      selectedPaths: [],
      anchorIndex: 1,
    });
  });

  it("toggles one row for Ctrl/Cmd selection", () => {
    expect(selectLibraryRow(paths, ["first"], 0, 2, { shiftKey: false, ctrlKey: true, metaKey: false })).toEqual({
      selectedPaths: ["first", "third"],
      anchorIndex: 2,
    });

    expect(selectLibraryRow(paths, ["first", "third"], 2, 2, { shiftKey: false, ctrlKey: false, metaKey: true })).toEqual({
      selectedPaths: ["first"],
      anchorIndex: 2,
    });
  });

  it("selects the range from the last normal row click", () => {
    expect(selectLibraryRow(paths, [], 1, 4, { shiftKey: true, ctrlKey: false, metaKey: false })).toEqual({
      selectedPaths: ["second", "third", "fourth", "fifth"],
      anchorIndex: 1,
    });
  });
});
