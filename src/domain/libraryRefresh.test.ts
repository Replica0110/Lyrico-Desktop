import { describe, expect, it } from "vitest";
import type { AudioTrack, BatchTaskItem } from "../app/types";
import { applyBatchLibraryUpdate, libraryPathsToRefresh } from "./libraryRefresh";

const tracks = [
  track("C:\\Music\\one.flac", "One"),
  track("C:\\Music\\two.flac", "Two"),
];

describe("batch library refresh", () => {
  it("reloads only succeeded editable songs", () => {
    expect(libraryPathsToRefresh("editTags", [item("C:\\Music\\one.flac", "succeeded"), item("C:\\Music\\two.flac", "failed")])).toEqual(["C:\\Music\\one.flac"]);
    expect(libraryPathsToRefresh("exportLyrics", [item("C:\\Music\\one.flac", "succeeded")])).toEqual([]);
  });

  it("replaces refreshed songs without dropping the rest of the library", () => {
    const refreshed = track("C:\\Music\\one.flac", "Updated");
    const next = applyBatchLibraryUpdate(tracks, "editTags", [item("C:\\Music\\one.flac", "succeeded")], [refreshed]);
    expect(next.map((entry) => entry.title)).toEqual(["Updated", "Two"]);
  });

  it("removes deleted songs and follows renamed paths", () => {
    expect(applyBatchLibraryUpdate(tracks, "deleteFiles", [item("C:\\Music\\two.flac", "succeeded")], []).map((entry) => entry.path)).toEqual(["C:\\Music\\one.flac"]);
    const renamed = track("C:\\Music\\one-renamed.flac", "One");
    const next = applyBatchLibraryUpdate(
      tracks,
      "renameFiles",
      [item("C:\\Music\\one.flac", "succeeded", JSON.stringify({ originalPath: "C:\\Music\\one.flac", newPath: renamed.path }))],
      [renamed],
    );
    expect(next.map((entry) => entry.path)).toEqual([renamed.path, "C:\\Music\\two.flac"]);
    expect(libraryPathsToRefresh("renameFiles", [item("C:\\Music\\one.flac", "succeeded", JSON.stringify({ newPath: renamed.path }))])).toEqual([renamed.path]);
  });
});

function track(path: string, title: string): AudioTrack {
  return {
    id: path,
    path,
    fileName: path.split("\\").pop() ?? path,
    title,
    artist: "",
    album: "",
    albumArtist: "",
    genre: "",
    language: "",
    composer: "",
    lyricist: "",
    copyright: "",
    comment: "",
    lyrics: "",
    year: "",
    durationSeconds: 1,
    format: "FLAC",
    hasLyrics: false,
    hasCover: false,
    replayGainTrackGain: "",
    replayGainTrackPeak: "",
    replayGainAlbumGain: "",
    replayGainAlbumPeak: "",
    replayGainReferenceLoudness: "",
  };
}

function item(songPath: string, status: BatchTaskItem["status"], resultJson?: string): BatchTaskItem {
  return {
    itemId: songPath,
    taskId: "batch-1",
    songPath,
    fileName: songPath,
    status,
    createdAt: "",
    updatedAt: "",
    resultJson,
  };
}
