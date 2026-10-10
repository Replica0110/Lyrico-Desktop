import { describe, expect, it } from "vitest";
import type { AudioTrack, BatchTaskItem } from "../app/types";
import { batchFieldValue, batchItemMap, batchResultData, hasBatchField, taskOperationKey } from "./batchPresentation";

describe("batch information and result presentation", () => {
  it("uses the indexed lyrics/cover flags and resolves native field names", () => {
    const track = { hasLyrics: true, hasCover: false, lyrics: "", albumArtist: "Artist", year: "2026", trackNumber: 0, replayGainTrackGain: " -8 dB ", comment: "  " } as AudioTrack;
    expect(hasBatchField(track, "lyrics")).toBe(true);
    expect(hasBatchField(track, "cover_url")).toBe(false);
    expect(hasBatchField(track, "album_artist")).toBe(true);
    expect(batchFieldValue(track, "album_artist")).toBe("Artist");
    expect(hasBatchField(track, "replaygain_track_gain")).toBe(true);
    expect(hasBatchField(track, "track_number")).toBe(false);
    expect(hasBatchField(track, "comment")).toBe(false);
  });

  it("distinguishes match modes while tolerating legacy task configs", () => {
    expect(taskOperationKey({ taskType: "matchMetadata", configJson: '{"matchMode":"lyrics"}' })).toBe("matchLyrics");
    expect(taskOperationKey({ taskType: "matchMetadata", configJson: '{"matchMode":"cover"}' })).toBe("matchCover");
    expect(taskOperationKey({ taskType: "matchMetadata", configJson: "null" })).toBe("metadata");
    expect(taskOperationKey({ taskType: "matchMetadata", configJson: "invalid" })).toBe("metadata");
    expect(taskOperationKey({ taskType: "legacy" })).toBeUndefined();
  });

  it("keeps renamed results addressable by both paths and accepts broken legacy results", () => {
    const item = { songPath: "C:/a.flac", resultJson: '{"newPath":"C:/b.flac"}' } as BatchTaskItem;
    expect(batchItemMap([item]).get("C:/a.flac")).toBe(item);
    expect(batchItemMap([item]).get("C:/b.flac")).toBe(item);
    for (const raw of ["invalid", "null", "[]", '"text"']) expect(batchResultData({ ...item, resultJson: raw })).toEqual({});
  });
});
