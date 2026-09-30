import { describe, expect, it } from "vitest";
import type { AudioTrack, LibraryFolder } from "../app/types";
import type { AlbumGroup, ArtistGroup } from "./library";
import {
  defaultSortDirection,
  folderName,
  nextSort,
  sortAlbumsBy,
  sortArtistsBy,
  sortFoldersBy,
  sortTracksBy,
} from "./sort";

function track(path: string, overrides: Partial<AudioTrack> = {}): AudioTrack {
  return {
    id: path,
    path,
    fileName: `${path}.flac`,
    title: path,
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
    ...overrides,
  };
}

function album(title: string, tracks: AudioTrack[]): AlbumGroup {
  return {
    id: title,
    title,
    artist: "Artist",
    trackCount: tracks.length,
    durationSeconds: tracks.reduce((sum, item) => sum + item.durationSeconds, 0),
    tracks,
  };
}

function artist(name: string, tracks: AudioTrack[], albumCount = 1): ArtistGroup {
  return {
    id: name,
    name,
    trackCount: tracks.length,
    albumCount,
    durationSeconds: tracks.reduce((sum, item) => sum + item.durationSeconds, 0),
    tracks,
  };
}

function folder(path: string, overrides: Partial<LibraryFolder> = {}): LibraryFolder {
  return { path, trackCount: 0, status: "ready", ...overrides };
}

describe("nextSort", () => {
  it("starts a new field with its default direction", () => {
    expect(nextSort(undefined, "title")).toEqual({ key: "title", direction: "asc" });
    expect(nextSort({ key: "title", direction: "asc" }, "createdAt")).toEqual({ key: "createdAt", direction: "desc" });
    expect(defaultSortDirection("modifiedAt")).toBe("desc");
    expect(defaultSortDirection("album")).toBe("asc");
  });

  it("toggles the direction when the same field is chosen again", () => {
    expect(nextSort({ key: "title", direction: "asc" }, "title")).toEqual({ key: "title", direction: "desc" });
    expect(nextSort({ key: "createdAt", direction: "desc" }, "createdAt")).toEqual({ key: "createdAt", direction: "asc" });
  });
});

describe("sortTracksBy", () => {
  const tracks = [
    track("c", { title: "Banana", artist: "B", album: "Zebra", durationSeconds: 30, createdAt: 100, modifiedAt: 300 }),
    track("a", { title: "apple", artist: "A", album: "Alpha", durationSeconds: 120, createdAt: 300, modifiedAt: 100 }),
    track("b", { title: "Cherry", artist: "C", album: "Alpha", durationSeconds: 60, createdAt: 200 }),
  ];

  it("sorts text fields case-insensitively in both directions", () => {
    expect(sortTracksBy(tracks, "title", "asc").map((item) => item.title)).toEqual(["apple", "Banana", "Cherry"]);
    expect(sortTracksBy(tracks, "title", "desc").map((item) => item.title)).toEqual(["Cherry", "Banana", "apple"]);
    expect(sortTracksBy(tracks, "album", "asc").map((item) => item.album)).toEqual(["Alpha", "Alpha", "Zebra"]);
  });

  it("sorts numeric fields", () => {
    expect(sortTracksBy(tracks, "duration", "desc").map((item) => item.durationSeconds)).toEqual([120, 60, 30]);
    expect(sortTracksBy(tracks, "duration", "asc").map((item) => item.durationSeconds)).toEqual([30, 60, 120]);
  });

  it("keeps rows without a timestamp last in both directions", () => {
    expect(sortTracksBy(tracks, "modifiedAt", "desc").map((item) => item.path)).toEqual(["c", "a", "b"]);
    expect(sortTracksBy(tracks, "modifiedAt", "asc").map((item) => item.path)).toEqual(["a", "c", "b"]);
    expect(sortTracksBy(tracks, "createdAt", "desc").map((item) => item.path)).toEqual(["a", "b", "c"]);
    expect(sortTracksBy(tracks, "createdAt", "asc").map((item) => item.path)).toEqual(["c", "b", "a"]);
  });

  it("does not mutate the input array", () => {
    const input = [...tracks];
    sortTracksBy(input, "title", "asc");
    expect(input.map((item) => item.path)).toEqual(["c", "a", "b"]);
  });
});

describe("collection sorting", () => {
  const older = track("old", { createdAt: 100, modifiedAt: 500 });
  const newer = track("new", { createdAt: 500, modifiedAt: 200 });

  it("sorts albums by aggregated time", () => {
    const albums = [album("Zulu", [older]), album("Alpha", [newer])];
    expect(sortAlbumsBy(albums, "title", "asc").map((item) => item.title)).toEqual(["Alpha", "Zulu"]);
    expect(sortAlbumsBy(albums, "createdAt", "desc").map((item) => item.title)).toEqual(["Alpha", "Zulu"]);
    expect(sortAlbumsBy(albums, "modifiedAt", "desc").map((item) => item.title)).toEqual(["Zulu", "Alpha"]);
  });

  it("sorts artists by counts", () => {
    const artists = [artist("Bee", [older, newer], 3), artist("Adele", [older], 1)];
    expect(sortArtistsBy(artists, "name", "asc").map((item) => item.name)).toEqual(["Adele", "Bee"]);
    expect(sortArtistsBy(artists, "trackCount", "asc").map((item) => item.name)).toEqual(["Adele", "Bee"]);
    expect(sortArtistsBy(artists, "albumCount", "desc").map((item) => item.name)).toEqual(["Bee", "Adele"]);
  });

  it("sorts folders by name, size and last scan", () => {
    const folders = [
      folder("C:\\Music\\Jazz", { trackCount: 5, lastScannedAt: "200" }),
      folder("C:\\Music\\Rock", { trackCount: 9, lastScannedAt: "100" }),
      folder("C:\\Music", { trackCount: 1, lastScannedAt: undefined }),
    ];
    expect(sortFoldersBy(folders, "name", "asc").map(folderName)).toEqual(["Jazz", "Music", "Rock"]);
    expect(sortFoldersBy(folders, "trackCount", "desc").map(folderName)).toEqual(["Rock", "Jazz", "Music"]);
    expect(sortFoldersBy(folders, "lastScan", "desc").map(folderName)).toEqual(["Jazz", "Rock", "Music"]);
  });
});
