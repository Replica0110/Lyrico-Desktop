import { describe, expect, it } from "vitest";
import type { AudioTrack, LibraryFolder } from "../app/types";
import { buildLibraryFolderTree, tracksInDirectory } from "./library";
import { deduplicateFolders, folderPathKey, upsertFolder } from "./libraryFolders";

describe("library folder view", () => {
  const folder: LibraryFolder = { path: "E:\\Music", trackCount: 3, status: "ready" };
  const tracks = [
    track("E:\\Music\\loose.flac"),
    track("E:\\Music\\Artist\\Album\\one.flac"),
    track("E:\\Music\\Artist\\Album\\two.flac"),
    track("E:\\Music Archive\\outside.flac"),
  ];

  it("builds a navigable tree with direct and recursive counts", () => {
    const [root] = buildLibraryFolderTree([folder], tracks);
    expect(root.name).toBe("Music");
    expect(root.directTrackCount).toBe(1);
    expect(root.totalTrackCount).toBe(3);
    expect(root.children[0].name).toBe("Artist");
    expect(root.children[0].children[0].name).toBe("Album");
    expect(root.children[0].children[0].directTrackCount).toBe(2);
  });

  it("switches between current-directory and recursive song scopes", () => {
    expect(tracksInDirectory(tracks, "E:\\Music", false).map((item) => item.fileName)).toEqual(["loose.flac"]);
    expect(tracksInDirectory(tracks, "E:\\Music", true)).toHaveLength(3);
    expect(tracksInDirectory(tracks, "E:\\Music\\Artist", false)).toHaveLength(0);
    expect(tracksInDirectory(tracks, "E:\\Music\\Artist", true)).toHaveLength(2);
  });
});

function track(path: string): AudioTrack {
  const parts = path.split("\\");
  return {
    id: path,
    path,
    fileName: parts[parts.length - 1] ?? path,
    title: "",
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
    durationSeconds: 0,
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

const folder = (path: string, lastScannedAt?: string): LibraryFolder => ({ path, lastScannedAt, trackCount: 1, status: "ready" });

describe("library folder identity", () => {
  it("matches picker slash, case, and trailing separator variants", () => {
    expect(folderPathKey("D:\\Music\\")).toBe(folderPathKey("d:/music/"));
    expect(folderPathKey("D:/MusicOther")).not.toBe(folderPathKey("D:/Music"));
  });

  it("keeps the latest scanned record while repairing a stored list", () => {
    const latest = folder("d:/Music/", "2026-10-09T12:00:00Z");
    expect(deduplicateFolders([folder("D:\\Music", "2026-10-08T12:00:00Z"), latest])).toEqual([latest]);
    expect(upsertFolder([folder("D:\\Music"), latest], folder("D:/Music", "2026-10-10"))).toHaveLength(1);
  });

  it("renders one root and counts a song once even for legacy IPC aliases", () => {
    const tracks = ["D:\\Music\\song.flac", "d:/music/song.flac"].map((path) => ({ path }) as AudioTrack);
    const roots = buildLibraryFolderTree([folder("D:\\Music"), folder("D:/Music/")], tracks);
    expect(roots).toHaveLength(1);
    expect(roots[0].directTrackCount).toBe(1);
    expect(roots[0].totalTrackCount).toBe(1);
  });
});
