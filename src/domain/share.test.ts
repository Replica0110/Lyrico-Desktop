import { describe, expect, it } from "vitest";
import { fileUrlForShare } from "./share";

describe("share file URL", () => {
  it("converts a Windows path to a file URL", () => {
    expect(fileUrlForShare("C:\\Music\\My Song.flac")).toBe("file:///C:/Music/My%20Song.flac");
  });
});
