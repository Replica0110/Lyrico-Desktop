import { describe, expect, it } from "vitest";
import { isPathInHiddenFolder } from "./libraryVisibility";

describe("library visibility", () => {
  it("hides files below a configured folder but not similarly prefixed paths", () => {
    expect(isPathInHiddenFolder("D:\\Music\\Hidden\\song.flac", ["D:\\Music\\Hidden"])).toBe(true);
    expect(isPathInHiddenFolder("D:\\Music\\Hidden 2\\song.flac", ["D:\\Music\\Hidden"])).toBe(false);
  });
});
