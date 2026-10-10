export type ViewKey =
  | "songs"
  | "albums"
  | "artists"
  | "folders"
  | "sources"
  | "tasks"
  | "settings";

export type AudioTrack = {
  id: string;
  path: string;
  fileName: string;
  title: string;
  artist: string;
  album: string;
  albumArtist: string;
  genre: string;
  language: string;
  composer: string;
  lyricist: string;
  copyright: string;
  rating?: number;
  comment: string;
  lyrics: string;
  trackNumber?: number;
  discNumber?: number;
  year: string;
  durationSeconds: number;
  format: string;
  bitrate?: number;
  sampleRate?: number;
  channels?: number;
  coverDataUrl?: string;
  hasLyrics: boolean;
  hasCover: boolean;
  replayGainTrackGain: string;
  replayGainTrackPeak: string;
  replayGainAlbumGain: string;
  replayGainAlbumPeak: string;
  replayGainReferenceLoudness: string;
  modifiedAt?: number;
  createdAt?: number;
};

export type TagForm = {
  title: string;
  artist: string;
  album: string;
  albumArtist: string;
  trackNumber?: number;
  discNumber?: number;
  year: string;
  genre: string[];
  language: string;
  composer: string;
  lyricist: string;
  copyright: string;
  rating?: number;
  comment: string;
  lyrics: string;
  replayGainTrackGain: string;
  replayGainTrackPeak: string;
  replayGainAlbumGain: string;
  replayGainAlbumPeak: string;
  replayGainReferenceLoudness: string;
  coverDataUrl?: string;
  removeCover: boolean;
  customTags: CustomTag[];
};

export type CustomTag = {
  key: string;
  values: string[];
};

export type LibraryFolder = {
  path: string;
  trackCount: number;
  lastScannedAt?: string;
  status: "ready" | "scanning" | "error";
  error?: string;
};

export type ScanProgress = {
  jobId: string;
  folderPath: string;
  phase: "enumerating" | "reading" | "committing" | "completed" | "failed";
  current: number;
  total: number;
  errors: number;
  status: "running" | "completed" | "failed";
  message?: string;
};

export type ReplayGainAnalysis = {
  jobId: string;
  path: string;
  loudnessLufs: number;
  sampleCount: number;
  /** Frames the container declares, when it declares a length. */
  declaredSamples?: number | null;
  peak: number;
  trackGain: string;
  trackPeak: string;
  referenceLoudness: string;
  /** Set when decoder anomalies passed complete FLAC sample count and PCM MD5 verification. */
  warning?: string | null;
};

export type ReplayGainProgress = {
  jobId: string;
  path: string;
  percent: number;
  status: "running" | "completed" | "cancelled" | "failed";
  message?: string;
};

export type StorageInfo = {
  dataPath: string;
  databasePath: string;
  configPath: string;
  location: "installation" | "appData";
};

export type DesktopSettings = {
  searchPageSize: number;
  lyricFormat: "plainLrc" | "verbatimLrc" | "enhancedLrc" | "ttml";
  lyricsConversionMode: "none" | "traditionalToSimplified" | "simplifiedToTraditional";
  showTranslation: boolean;
  showRomanization: boolean;
  onlyTranslationIfAvailable: boolean;
  removeEmptyLyricLines: boolean;
  lyricLineOrder: LyricLineTrack[];
  removeTagLineKeywords: string[];
  ignoreShortAudio: boolean;
  lyricIndexEnabled: boolean;
  hiddenFolderPaths: string[];
  artistPosterFolder: string;
  renameCharacterMappings: Record<string, string>;
  themeMode: "system" | "light" | "dark";
  replayGainTargetLoudness: number;
  replayGainPeakMode: "samplePeak" | "truePeak";
  editFieldVisibility: Record<string, boolean>;
  editFieldOrder: string[];
};

export type LyricLineTrack = "original" | "translation" | "romanization";

export type PluginCapability = "searchSongs" | "getLyrics" | "searchCovers";

export type PluginConfigOption = {
  value: string;
  label: string;
  summary?: string;
};

export type PluginConfigField = {
  key: string;
  title: string;
  summary?: string;
  group?: string;
  type: "text" | "password" | "number" | "switch" | "dropdown" | "textarea" | "markdown";
  required?: boolean;
  defaultValue?: string;
  options?: PluginConfigOption[];
  dependency?: unknown;
};

export type PluginSourceKind = "aggregated" | "metadata" | "lyrics" | "covers";
export type PluginSourceState = { enabled: boolean; priority: number };

export type SourcePlugin = {
  sourceStates: Partial<Record<PluginSourceKind, PluginSourceState>>;
  id: string;
  name: string;
  versionCode: number;
  versionName: string;
  author: string;
  description: string;
  apiVersion: number;
  minHostApiVersion: number;
  entry: string;
  includeDirs: string[];
  icon?: string;
  enabled: boolean;
  capabilities: PluginCapability[];
  configFields: PluginConfigField[];
  pluginDir: string;
  iconPath?: string;
  iconDataUrl?: string;
  sortOrder: number;
  installedAt: string;
  updatedAt: string;
  config: Record<string, string>;
};

export type PluginInstallFailure = {
  rootPath: string;
  reason: string;
  pluginId?: string;
};

export type PluginInstallResult = {
  installed: SourcePlugin[];
  failed: PluginInstallFailure[];
};

export type PluginSongResult = {
  id?: string;
  songId?: string;
  trackId?: string;
  title?: string;
  name?: string;
  songName?: string;
  artist?: string | string[];
  artists?: string | string[];
  singer?: string;
  album?: string;
  albumName?: string;
  duration?: number;
  durationMs?: number;
  date?: string;
  releaseDate?: string;
  trackNumber?: string | number;
  picUrl?: string;
  coverUrl?: string;
  artworkUrl?: string;
  fields?: Record<string, unknown>;
  internal?: Record<string, unknown>;
};

export type BatchCandidate = {
  track: AudioTrack;
  sources: string[];
  status: "notRun" | "ready" | "sourceMissing";
};

export type BatchTaskStatus = "queued" | "running" | "succeeded" | "failed" | "skipped" | "cancelled";

export type BatchTask = {
  progress?: number;
  taskId: string;
  taskType: string;
  status: BatchTaskStatus;
  total: number;
  current: number;
  successCount: number;
  failureCount: number;
  skippedCount: number;
  configJson?: string;
  startedAt?: string;
  finishedAt?: string;
  createdAt: string;
  updatedAt: string;
  errorMessage?: string;
};

export type BatchTaskItem = {
  itemId: string;
  taskId: string;
  songPath: string;
  fileName: string;
  status: BatchTaskStatus;
  progress?: number;
  resultJson?: string;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
};

export type CharacterMappingRule = {
  id: string;
  name: string;
  charMappings: Record<string, string | null>;
  description: string;
  isBuiltIn: boolean;
  isEnabled: boolean;
};

export type RenamePreview = {
  originalPath: string;
  newPath: string;
  conflict: boolean;
};

export type CustomArtistSeparator = {
  id: string;
  value: string;
  enabled: boolean;
};

export type CustomNoSplitArtist = {
  id: string;
  name: string;
  enabled: boolean;
};

export type ArtistSplitConfig = {
  enabled: boolean;
  artistSeparator: string;
  builtinSeparatorOverrides: Record<string, boolean>;
  hiddenBuiltinSeparatorIds: string[];
  customSeparators: CustomArtistSeparator[];
  builtinNoSplitArtistOverrides: Record<string, boolean>;
  customNoSplitArtists: CustomNoSplitArtist[];
};
