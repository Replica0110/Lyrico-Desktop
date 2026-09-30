import { describe, expect, it } from "vitest";
import { defaultOnlineSearchKeyword } from "./search";

describe("online search keyword", () => {
  it("falls back to the file name when tags are empty", () => {
    expect(defaultOnlineSearchKeyword({ title: "", artist: "", fileName: "01 - Song.flac" })).toBe("01 - Song");
  });

  it("prefers title and artist when either tag is available", () => {
    expect(defaultOnlineSearchKeyword({ title: "Song", artist: "Artist", fileName: "other.mp3" })).toBe("Song Artist");
  });
});
