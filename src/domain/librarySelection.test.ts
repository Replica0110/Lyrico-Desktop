import { describe, expect, it } from "vitest";
import { selectLibraryByKey, selectLibraryRow } from "./librarySelection";

const paths = ["first", "second", "third", "fourth", "fifth"];

describe("library row selection", () => {
  it("selects a single row for a normal click", () => {
    expect(selectLibraryRow(paths, [], null, 1, { shiftKey: false, ctrlKey: false, metaKey: false })).toEqual({
      selectedPaths: ["second"],
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

const plain = { shiftKey: false, ctrlKey: false, metaKey: false };

describe("library keyboard selection", () => {
  it("selects the first or last row when nothing is focused", () => {
    expect(selectLibraryByKey(paths, [], null, null, { ...plain, key: "ArrowDown" })).toEqual({
      selectedPaths: ["first"],
      anchorIndex: 0,
      cursorIndex: 0,
    });
    expect(selectLibraryByKey(paths, [], null, null, { ...plain, key: "ArrowUp" })).toEqual({
      selectedPaths: ["fifth"],
      anchorIndex: 4,
      cursorIndex: 4,
    });
  });

  it("replaces the selection when moving with the arrow keys", () => {
    expect(selectLibraryByKey(paths, ["first"], 0, 0, { ...plain, key: "ArrowDown" })).toEqual({
      selectedPaths: ["second"],
      anchorIndex: 1,
      cursorIndex: 1,
    });
  });

  it("extends and shrinks the range while Shift is held", () => {
    const extended = selectLibraryByKey(paths, ["second"], 1, 1, { ...plain, shiftKey: true, key: "ArrowDown" });
    expect(extended).toEqual({
      selectedPaths: ["second", "third"],
      anchorIndex: 1,
      cursorIndex: 2,
    });
    expect(selectLibraryByKey(paths, extended!.selectedPaths, extended!.anchorIndex, extended!.cursorIndex, {
      ...plain,
      shiftKey: true,
      key: "ArrowDown",
    })).toEqual({
      selectedPaths: ["second", "third", "fourth"],
      anchorIndex: 1,
      cursorIndex: 3,
    });
    expect(selectLibraryByKey(paths, ["second", "third", "fourth"], 1, 3, { ...plain, shiftKey: true, key: "ArrowUp" })).toEqual({
      selectedPaths: ["second", "third"],
      anchorIndex: 1,
      cursorIndex: 2,
    });
  });

  it("keeps the selection when an arrow cannot move", () => {
    expect(selectLibraryByKey(paths, ["first", "second"], 0, 0, { ...plain, key: "ArrowUp" })).toBeNull();
  });

  it("moves the cursor without changing the selection when Ctrl is held", () => {
    expect(selectLibraryByKey(paths, ["second"], 1, 1, { ...plain, ctrlKey: true, key: "ArrowDown" })).toEqual({
      selectedPaths: ["second"],
      anchorIndex: 1,
      cursorIndex: 2,
    });
    expect(selectLibraryByKey(paths, ["second"], 1, 2, { ...plain, shiftKey: true, key: "ArrowDown" })).toEqual({
      selectedPaths: ["second", "third", "fourth"],
      anchorIndex: 1,
      cursorIndex: 3,
    });
  });

  it("jumps to the ends, including a Shift range", () => {
    expect(selectLibraryByKey(paths, ["third"], 2, 2, { ...plain, key: "End" })).toEqual({
      selectedPaths: ["fifth"],
      anchorIndex: 4,
      cursorIndex: 4,
    });
    expect(selectLibraryByKey(paths, ["third"], 2, 2, { ...plain, shiftKey: true, key: "Home" })).toEqual({
      selectedPaths: ["first", "second", "third"],
      anchorIndex: 2,
      cursorIndex: 0,
    });
  });

  it("selects every row with Ctrl+A and ignores a plain A", () => {
    expect(selectLibraryByKey(paths, ["second"], 1, 1, { ...plain, ctrlKey: true, key: "a" })).toEqual({
      selectedPaths: paths,
      anchorIndex: 1,
      cursorIndex: 1,
    });
    expect(selectLibraryByKey(paths, ["first", "second", "extra"], 0, 0, { ...plain, ctrlKey: true, key: "a" })?.selectedPaths).toEqual(paths);
    expect(selectLibraryByKey(paths, ["second"], 1, 1, { ...plain, key: "a" })).toBeNull();
    expect(selectLibraryByKey([], [], null, null, { ...plain, key: "ArrowDown" })).toBeNull();
  });
});
