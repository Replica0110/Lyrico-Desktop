import { describe, it, expect } from "vitest";
import { emptyCollectionSelection, reconcileSelection, selectionPaths, toggleCollection } from "./collectionSelection";
describe("collection selection provenance", () => {
  it("does not select a collaborator merely because a shared song is selected", () => {
    const state = toggleCollection(emptyCollectionSelection(), "artist:benxi", ["solo", "duet"]);
    expect(Object.keys(state.groups)).toEqual(["artist:benxi"]);
    expect(selectionPaths(state)).toEqual(["solo", "duet"]);
  });
  it("preserves songs owned by another explicit selection when removing a group", () => {
    let state = toggleCollection({paths:["manual"],groups:{}}, "artist:a", ["solo", "duet"]);
    state = toggleCollection(state, "artist:b", ["duet"]);
    state = toggleCollection(state, "artist:a", []);
    expect(selectionPaths(state)).toEqual(["manual", "duet"]);
  });
  it("invalidates incomplete groups after individual removal without inferring new groups", () => {
    const state = toggleCollection(emptyCollectionSelection(), "artist:a", ["solo", "duet"]);
    expect(reconcileSelection(state, ["duet"])).toEqual({paths:["duet"],groups:{}});
  });
});
