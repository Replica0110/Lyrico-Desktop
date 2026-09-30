import type { ArtistSplitConfig, AudioTrack, BatchCandidate, LibraryFolder } from "../app/types";

const searchTextCache = new WeakMap<AudioTrack, string>();

export type AlbumGroup = {
  id: string;
  title: string;
  artist: string;
  trackCount: number;
  durationSeconds: number;
  coverDataUrl?: string;
  coverPath?: string;
  tracks: AudioTrack[];
};

export type ArtistGroup = {
  id: string;
  name: string;
  trackCount: number;
  albumCount: number;
  durationSeconds: number;
  coverDataUrl?: string;
  coverPath?: string;
  tracks: AudioTrack[];
};

export type LibraryFolderNode = {
  key: string;
  path: string;
  name: string;
  rootPath: string;
  parentKey?: string;
  directTrackCount: number;
  totalTrackCount: number;
  children: LibraryFolderNode[];
};

export function filterTracks(tracks: AudioTrack[], query: string) {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) {
    return tracks;
  }

  return tracks.filter((track) => {
    let searchText = searchTextCache.get(track);
    if (!searchText) {
      searchText = [track.title, track.artist, track.album, track.albumArtist, track.fileName, track.path]
        .join(" ")
        .toLocaleLowerCase();
      searchTextCache.set(track, searchText);
    }
    return searchText.includes(normalizedQuery);
  });
}

export function groupAlbums(tracks: AudioTrack[]): AlbumGroup[] {
  const groups = new Map<string, AudioTrack[]>();
  for (const track of tracks) {
    const key = `${track.album || "Unknown Album"}\u0000${track.albumArtist || track.artist || "Unknown Artist"}`;
    groups.set(key, [...(groups.get(key) ?? []), track]);
  }

  return [...groups.entries()]
    .map(([key, groupTracks]) => {
      const [title, artist] = key.split("\u0000");
      const coverTrack = groupTracks.find((track) => track.hasCover || track.coverDataUrl);
      return {
        id: key,
        title,
        artist,
        trackCount: groupTracks.length,
        durationSeconds: sumDuration(groupTracks),
        coverDataUrl: coverTrack?.coverDataUrl,
        coverPath: coverTrack?.path,
        tracks: sortTracks(groupTracks),
      };
    })
    .sort((left, right) => left.title.localeCompare(right.title));
}

export const builtinArtistSeparators = [
  { id: "slash", value: "/", defaultEnabled: true, displayName: "/" },
  { id: "fullwidth_slash", value: "／", defaultEnabled: true, displayName: "／" },
  { id: "semicolon", value: ";", defaultEnabled: true, displayName: ";" },
  { id: "fullwidth_semicolon", value: "；", defaultEnabled: true, displayName: "；" },
  { id: "comma", value: ",", defaultEnabled: true, displayName: "," },
  { id: "fullwidth_comma", value: "，", defaultEnabled: true, displayName: "，" },
  { id: "ideographic_comma", value: "、", defaultEnabled: true, displayName: "、" },
  { id: "ampersand", value: "&", defaultEnabled: false, displayName: "&" },
  { id: "feat_dot", value: " feat. ", defaultEnabled: false, displayName: "feat." },
  { id: "ft_dot", value: " ft. ", defaultEnabled: false, displayName: "ft." },
  { id: "featuring", value: " featuring ", defaultEnabled: false, displayName: "featuring" },
] as const;

export const builtinNoSplitArtists = [
  { id: "simon_and_garfunkel", name: "Simon & Garfunkel", defaultEnabled: true },
  { id: "earth_wind_and_fire", name: "Earth, Wind & Fire", defaultEnabled: true },
  { id: "bump_of_chicken", name: "BUMP OF CHICKEN", defaultEnabled: true },
] as const;

export const defaultArtistSplitConfig: ArtistSplitConfig = {
  enabled: true,
  artistSeparator: "/",
  builtinSeparatorOverrides: {},
  hiddenBuiltinSeparatorIds: [],
  customSeparators: [],
  builtinNoSplitArtistOverrides: {},
  customNoSplitArtists: [],
};

export function groupArtists(tracks: AudioTrack[], config: ArtistSplitConfig = defaultArtistSplitConfig): ArtistGroup[] {
  const groups = new Map<string, AudioTrack[]>();
  for (const track of tracks) {
    const rawArtist = track.artist || track.albumArtist || "Unknown Artist";
    for (const artist of splitArtists(rawArtist, config)) {
      groups.set(artist, [...(groups.get(artist) ?? []), track]);
    }
  }

  return [...groups.entries()]
    .map(([name, groupTracks]) => {
      const coverTrack = groupTracks.find((track) => track.hasCover || track.coverDataUrl);
      return {
        id: name,
        name,
        trackCount: groupTracks.length,
        albumCount: new Set(groupTracks.map((track) => track.album || "Unknown Album")).size,
        durationSeconds: sumDuration(groupTracks),
        coverDataUrl: coverTrack?.coverDataUrl,
        coverPath: coverTrack?.path,
        tracks: sortTracks(groupTracks),
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function splitArtists(rawArtist: string | undefined, config: ArtistSplitConfig) {
  const raw = rawArtist?.trim() ?? "";
  if (!raw) return [];
  if (!config.enabled) return [raw];

  const noSplitArtists = effectiveNoSplitArtists(config);
  if (noSplitArtists.some((artist) => normalizedArtistKey(artist) === normalizedArtistKey(raw))) return [raw];

  const separators = effectiveArtistSeparators(config).sort((left, right) => right.length - left.length);
  if (separators.length === 0) return [raw];
  const protectedArtists = noSplitArtists
    .filter((artist) => separators.some((separator) => includesIgnoreCase(artist, separator)))
    .sort((left, right) => right.length - left.length);

  const artists: string[] = [];
  let current = "";
  let index = 0;
  while (index < raw.length) {
    const protectedArtist = protectedArtists.find((artist) => startsWithIgnoreCase(raw, artist, index));
    if (protectedArtist) {
      current += raw.slice(index, index + protectedArtist.length);
      index += protectedArtist.length;
      continue;
    }
    const separator = separators.find((value) => startsWithIgnoreCase(raw, value, index));
    if (separator) {
      pushDistinctArtist(artists, current);
      current = "";
      index += separator.length;
      continue;
    }
    current += raw[index];
    index += 1;
  }
  pushDistinctArtist(artists, current);
  return artists;
}

export function effectiveArtistSeparators(config: ArtistSplitConfig) {
  const hidden = new Set(config.hiddenBuiltinSeparatorIds);
  const builtin = builtinArtistSeparators
    .filter((item) => !hidden.has(item.id))
    .filter((item) => config.builtinSeparatorOverrides[item.id] ?? item.defaultEnabled)
    .map((item) => item.value);
  const custom = config.customSeparators.filter((item) => item.enabled).map((item) => item.value);
  return [...builtin, ...custom].filter((value) => value.trim()).filter((value, index, all) => all.findIndex((candidate) => candidate.trim() === value.trim()) === index);
}

export function effectiveNoSplitArtists(config: ArtistSplitConfig) {
  const builtin = builtinNoSplitArtists
    .filter((item) => config.builtinNoSplitArtistOverrides[item.id] ?? item.defaultEnabled)
    .map((item) => item.name);
  const custom = config.customNoSplitArtists.filter((item) => item.enabled).map((item) => item.name);
  return [...builtin, ...custom].filter((value) => value.trim()).filter((value, index, all) => all.findIndex((candidate) => normalizedArtistKey(candidate) === normalizedArtistKey(value)) === index);
}

function normalizedArtistKey(value: string) {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function startsWithIgnoreCase(input: string, value: string, index: number) {
  return input.slice(index, index + value.length).toLocaleLowerCase() === value.toLocaleLowerCase();
}

function includesIgnoreCase(input: string, value: string) {
  return input.toLocaleLowerCase().includes(value.toLocaleLowerCase());
}

function pushDistinctArtist(artists: string[], value: string) {
  const artist = value.trim();
  if (artist && !artists.some((candidate) => normalizedArtistKey(candidate) === normalizedArtistKey(artist))) artists.push(artist);
}

export function tracksInFolder(tracks: AudioTrack[], folder: LibraryFolder) {
  const normalizedFolder = normalizePath(folder.path);
  return tracks.filter((track) => normalizePath(track.path).startsWith(normalizedFolder));
}

export function buildLibraryFolderTree(folders: LibraryFolder[], tracks: AudioTrack[]) {
  return folders.map((folder) => buildFolderRoot(folder, tracks));
}

export function tracksInDirectory(tracks: AudioTrack[], directoryPath: string, includeSubfolders: boolean) {
  const directory = normalizeFileSystemPath(directoryPath);
  const directoryKey = directory.toLocaleLowerCase();
  const directoryPrefix = directoryKey.endsWith("/") ? directoryKey : `${directoryKey}/`;
  return tracks.filter((track) => {
    const trackPath = normalizeFileSystemPath(track.path);
    if (includeSubfolders) return trackPath.toLocaleLowerCase().startsWith(directoryPrefix);
    return parentDirectory(trackPath).toLocaleLowerCase() === directoryKey;
  });
}

export function buildBatchCandidates(tracks: AudioTrack[], sourceNames: string[]): BatchCandidate[] {
  const status: BatchCandidate["status"] = sourceNames.length === 0 ? "sourceMissing" : "ready";
  return tracks.slice(0, 200).map((track) => ({
    track,
    sources: sourceNames,
    status,
  }));
}

export function sortTracks(tracks: AudioTrack[]) {
  return [...tracks].sort((left, right) =>
    (left.album || "").localeCompare(right.album || "") ||
    (left.discNumber ?? 0) - (right.discNumber ?? 0) ||
    (left.trackNumber ?? 0) - (right.trackNumber ?? 0) ||
    left.title.localeCompare(right.title),
  );
}

function sumDuration(tracks: AudioTrack[]) {
  return tracks.reduce((sum, track) => sum + track.durationSeconds, 0);
}

function normalizePath(path: string) {
  const normalized = path.replace(/\\/g, "/").toLocaleLowerCase();
  return normalized.endsWith("/") ? normalized : `${normalized}/`;
}

function buildFolderRoot(folder: LibraryFolder, tracks: AudioTrack[]): LibraryFolderNode {
  const rootPath = normalizeFileSystemPath(folder.path);
  const root = createFolderNode(rootPath, rootPath, undefined);
  const nodes = new Map<string, LibraryFolderNode>([[root.key, root]]);
  const rootPrefix = root.key.endsWith("/") ? root.key : `${root.key}/`;

  for (const track of tracks) {
    const trackPath = normalizeFileSystemPath(track.path);
    if (!trackPath.toLocaleLowerCase().startsWith(rootPrefix)) continue;
    const directory = parentDirectory(trackPath);
    const relativeDirectory = directory.slice(rootPath.length).replace(/^\/+/, "");
    let parent = root;
    let currentPath = rootPath;
    for (const segment of relativeDirectory.split("/").filter(Boolean)) {
      currentPath = `${currentPath}/${segment}`;
      const key = currentPath.toLocaleLowerCase();
      let node = nodes.get(key);
      if (!node) {
        node = createFolderNode(currentPath, rootPath, parent.key);
        nodes.set(key, node);
        parent.children.push(node);
      }
      parent = node;
    }
    parent.directTrackCount += 1;
  }

  finalizeFolderNode(root);
  return root;
}

function createFolderNode(path: string, rootPath: string, parentKey: string | undefined): LibraryFolderNode {
  const parts = path.split("/").filter(Boolean);
  return {
    key: path.toLocaleLowerCase(),
    path,
    name: parts[parts.length - 1] ?? path,
    rootPath,
    parentKey,
    directTrackCount: 0,
    totalTrackCount: 0,
    children: [],
  };
}

function finalizeFolderNode(node: LibraryFolderNode): number {
  node.children.sort((left, right) => left.name.localeCompare(right.name));
  node.totalTrackCount = node.directTrackCount + node.children.reduce((sum, child) => sum + finalizeFolderNode(child), 0);
  return node.totalTrackCount;
}

function normalizeFileSystemPath(path: string) {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized || "/";
}

function parentDirectory(path: string) {
  const separator = path.lastIndexOf("/");
  return separator > 0 ? path.slice(0, separator) : path;
}
