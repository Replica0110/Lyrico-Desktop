import type { AudioTrack, LibraryFolder } from "../app/types";
import { parseTimeValue } from "../utils/format";
import type { AlbumGroup, ArtistGroup } from "./library";

export type SortDirection = "asc" | "desc";

export type SortState<K extends string = string> = {
  key: K;
  direction: SortDirection;
};

type Comparator<T> = (left: T, right: T, direction: SortDirection) => number;

const descendingDefaults = new Set<string>([
  "modifiedAt",
  "createdAt",
  "duration",
  "trackCount",
  "albumCount",
  "lastScan",
]);

export function defaultSortDirection(field: string): SortDirection {
  return descendingDefaults.has(field) ? "desc" : "asc";
}

export function nextSort<K extends string>(current: SortState<K> | undefined, key: K): SortState<K> {
  if (!current || current.key !== key) {
    return { key, direction: defaultSortDirection(key) };
  }
  return { key, direction: current.direction === "asc" ? "desc" : "asc" };
}

function applyDirection(result: number, direction: SortDirection) {
  return direction === "asc" ? result : -result;
}

function compareText(left: string, right: string, direction: SortDirection) {
  return applyDirection(left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" }), direction);
}

function compareNumber(left: number, right: number, direction: SortDirection) {
  return applyDirection(left - right, direction);
}

function compareOptionalNumber(left: number | undefined, right: number | undefined, direction: SortDirection) {
  const hasLeft = Boolean(left);
  const hasRight = Boolean(right);
  if (!hasLeft && !hasRight) return 0;
  if (!hasLeft) return 1;
  if (!hasRight) return -1;
  return applyDirection((left ?? 0) - (right ?? 0), direction);
}

export const trackSortFields = ["title", "artist", "album", "format", "duration", "modifiedAt", "createdAt"] as const;
export type TrackSortField = (typeof trackSortFields)[number];

const trackComparators: Record<TrackSortField, Comparator<AudioTrack>> = {
  title: (left, right, direction) => compareText(left.title || left.fileName, right.title || right.fileName, direction),
  artist: (left, right, direction) => compareText(left.artist || left.albumArtist, right.artist || right.albumArtist, direction),
  album: (left, right, direction) => compareText(left.album, right.album, direction),
  format: (left, right, direction) => compareText(left.format, right.format, direction),
  duration: (left, right, direction) => compareNumber(left.durationSeconds ?? 0, right.durationSeconds ?? 0, direction),
  modifiedAt: (left, right, direction) => compareOptionalNumber(left.modifiedAt, right.modifiedAt, direction),
  createdAt: (left, right, direction) => compareOptionalNumber(left.createdAt, right.createdAt, direction),
};

export function sortTracksBy(tracks: AudioTrack[], field: TrackSortField, direction: SortDirection): AudioTrack[] {
  const compare = trackComparators[field];
  return [...tracks].sort((left, right) => compare(left, right, direction));
}

export const albumSortFields = ["title", "artist", "trackCount", "duration", "modifiedAt", "createdAt"] as const;
export type AlbumSortField = (typeof albumSortFields)[number];

export const artistSortFields = ["name", "albumCount", "trackCount", "duration", "modifiedAt", "createdAt"] as const;
export type ArtistSortField = (typeof artistSortFields)[number];

function groupedTime(tracks: AudioTrack[], field: "createdAt" | "modifiedAt") {
  let best: number | undefined;
  for (const track of tracks) {
    const value = track[field];
    if (!value) continue;
    if (!best) {
      best = value;
      continue;
    }
    best = field === "createdAt" ? Math.min(best, value) : Math.max(best, value);
  }
  return best;
}

const albumComparators: Record<AlbumSortField, Comparator<AlbumGroup>> = {
  title: (left, right, direction) => compareText(left.title, right.title, direction),
  artist: (left, right, direction) => compareText(left.artist, right.artist, direction),
  trackCount: (left, right, direction) => compareNumber(left.trackCount, right.trackCount, direction),
  duration: (left, right, direction) => compareNumber(left.durationSeconds, right.durationSeconds, direction),
  modifiedAt: (left, right, direction) => compareOptionalNumber(groupedTime(left.tracks, "modifiedAt"), groupedTime(right.tracks, "modifiedAt"), direction),
  createdAt: (left, right, direction) => compareOptionalNumber(groupedTime(left.tracks, "createdAt"), groupedTime(right.tracks, "createdAt"), direction),
};

export function sortAlbumsBy(albums: AlbumGroup[], field: AlbumSortField, direction: SortDirection): AlbumGroup[] {
  const compare = albumComparators[field];
  return [...albums].sort((left, right) => compare(left, right, direction));
}

const artistComparators: Record<ArtistSortField, Comparator<ArtistGroup>> = {
  name: (left, right, direction) => compareText(left.name, right.name, direction),
  albumCount: (left, right, direction) => compareNumber(left.albumCount, right.albumCount, direction),
  trackCount: (left, right, direction) => compareNumber(left.trackCount, right.trackCount, direction),
  duration: (left, right, direction) => compareNumber(left.durationSeconds, right.durationSeconds, direction),
  modifiedAt: (left, right, direction) => compareOptionalNumber(groupedTime(left.tracks, "modifiedAt"), groupedTime(right.tracks, "modifiedAt"), direction),
  createdAt: (left, right, direction) => compareOptionalNumber(groupedTime(left.tracks, "createdAt"), groupedTime(right.tracks, "createdAt"), direction),
};

export function sortArtistsBy(artists: ArtistGroup[], field: ArtistSortField, direction: SortDirection): ArtistGroup[] {
  const compare = artistComparators[field];
  return [...artists].sort((left, right) => compare(left, right, direction));
}

export const folderSortFields = ["name", "trackCount", "lastScan"] as const;
export type FolderSortField = (typeof folderSortFields)[number];

export function folderName(folder: LibraryFolder) {
  const parts = folder.path.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] ?? folder.path;
}

const folderComparators: Record<FolderSortField, Comparator<LibraryFolder>> = {
  name: (left, right, direction) => compareText(folderName(left), folderName(right), direction),
  trackCount: (left, right, direction) => compareNumber(left.trackCount, right.trackCount, direction),
  lastScan: (left, right, direction) => compareOptionalNumber(parseTimeValue(left.lastScannedAt) || undefined, parseTimeValue(right.lastScannedAt) || undefined, direction),
};

export function sortFoldersBy(folders: LibraryFolder[], field: FolderSortField, direction: SortDirection): LibraryFolder[] {
  const compare = folderComparators[field];
  return [...folders].sort((left, right) => compare(left, right, direction));
}
