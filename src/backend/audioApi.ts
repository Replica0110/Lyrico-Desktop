import { invoke } from "@tauri-apps/api/core";
import i18n from "../i18n";
import type { ArtistSplitConfig, AudioTrack, BatchTask, BatchTaskItem, CharacterMappingRule, CustomTag, DesktopSettings, LibraryFolder, PluginInstallResult, RenamePreview, ReplayGainAnalysis, PluginSourceKind, SourcePlugin, StorageInfo, TagForm } from "../app/types";

export async function scanFolder(folderPath: string) {
  return invoke<AudioTrack[]>("scan_folder", { folderPath });
}

export type PickFilter = { name: string; extensions: string[] };

export type PickOptions = {
  title?: string;
  filters?: PickFilter[];
  multiple?: boolean;
  directory?: boolean;
  defaultPath?: string;
};

export async function pickPaths(options: PickOptions) {
  return invoke<string[]>("pick_paths", { options });
}

export async function pickSavePath(options: PickOptions) {
  return invoke<string | null>("pick_save_path", { options });
}

export async function readAudioFile(path: string) {
  return invoke<AudioTrack>("read_audio_file", { path });
}

export async function loadCustomTags(path: string) {
  return invoke<CustomTag[]>("load_custom_tags", { path });
}

export async function readImageFile(path: string) {
  return invoke<string>("read_image_file", { path });
}

export async function readTextFile(path: string) {
  return invoke<string>("read_text_file", { path });
}

export async function writeTextFile(path: string, contents: string) {
  return invoke<void>("write_text_file", { path, contents });
}

export async function writeImageFile(path: string, dataUrl: string) {
  return invoke<void>("write_image_file", { path, dataUrl });
}

export async function saveAudioTags(path: string, values: TagForm) {
  return invoke<AudioTrack>("save_audio_tags", {
    update: {
      path,
      ...values,
    },
  });
}

export async function loadLibraryFolders() {
  return invoke<LibraryFolder[]>("load_library_folders");
}

export async function loadLibraryTracks() {
  return invoke<AudioTrack[]>("load_library_tracks");
}

export async function loadLibraryTracksByPaths(paths: string[]) {
  return invoke<AudioTrack[]>("load_library_tracks_by_paths", { paths });
}

export async function loadLibraryTrack(path: string) {
  return invoke<AudioTrack>("load_library_track", { path });
}

export type TrackCover = {
  path: string;
  coverDataUrl: string;
};

export async function loadTrackCovers(paths: string[], artwork = false) {
  return invoke<TrackCover[]>("load_track_covers", { paths, artwork });
}

export async function loadArtistSplitConfig() {
  return invoke<ArtistSplitConfig>("load_artist_split_config");
}

export async function saveArtistSplitConfig(config: ArtistSplitConfig) {
  return invoke<void>("save_artist_split_config", { config });
}

export async function loadDesktopSettings() {
  return invoke<DesktopSettings>("load_desktop_settings");
}

export async function saveDesktopSettings(settings: DesktopSettings) {
  return invoke<void>("save_desktop_settings", { settings });
}

export type ThemeMode = "system" | "light" | "dark";

export async function exportConfig(destination: string) {
  return invoke<void>("export_config", { destination });
}

export async function importConfig(source: string) {
  return invoke<DesktopSettings>("import_config", { source });
}

export type LyricLineMatch = {
  path: string;
  title: string;
  artist: string;
  matchedLine: string;
};

export async function searchLyricsLines(query: string, limit = 50) {
  return invoke<LyricLineMatch[]>("search_lyrics_lines", { query, limit });
}

export async function openLogsDirectory() {
  return invoke<void>("open_logs_directory");
}

export async function upsertLibraryFolder(folder: LibraryFolder) {
  return invoke<void>("upsert_library_folder", { folder });
}

export async function removeLibraryFolder(path: string) {
  return invoke<void>("remove_library_folder", { path });
}

export async function getStorageInfo() {
  return invoke<StorageInfo>("get_storage_info");
}

export async function analyzeReplayGain(path: string, jobId: string, targetLoudnessLufs: number, peakMode: DesktopSettings["replayGainPeakMode"]) {
  return invoke<ReplayGainAnalysis>("analyze_replay_gain", { path, jobId, targetLoudnessLufs, peakMode });
}

export async function cancelReplayGain(jobId: string) {
  return invoke<boolean>("cancel_replay_gain", { jobId });
}

export async function createBatchTask(taskType: string, songPaths: string[], configJson?: string) {
  return invoke<BatchTask>("create_batch_task", { taskType, songPaths, configJson });
}

export async function loadBatchTasks() {
  return invoke<BatchTask[]>("load_batch_tasks");
}

export async function deleteBatchTasks(taskIds: string[]) {
  return invoke<void>("delete_batch_tasks", { taskIds });
}

export async function loadBatchTaskItems(taskId: string) {
  return invoke<BatchTaskItem[]>("load_batch_task_items", { taskId });
}

export async function previewBatchRename(paths: string[], renameFormat: string, characterMappingRules: CharacterMappingRule[]) {
  return invoke<RenamePreview[]>("preview_batch_rename", { paths, renameFormat, characterMappingRules });
}

export async function startBatchTask(taskId: string) {
  return invoke<BatchTask>("start_batch_task", { taskId });
}

export async function cancelBatchTask(taskId: string) {
  return invoke<BatchTask>("cancel_batch_task", { taskId });
}

export async function cancelBatchTaskItem(taskId: string, itemId: string) {
  return invoke<BatchTask>("cancel_batch_task_item", { taskId, itemId });
}

export async function retryFailedBatchItems(taskId: string, itemIds?: string[]) {
  return invoke<BatchTask>("retry_failed_batch_items", { taskId, itemIds });
}

export async function loadSourcePlugins() {
  return invoke<SourcePlugin[]>("load_source_plugins", { locale: i18n.resolvedLanguage });
}

export async function installSourcePluginArchive(archivePath: string, allowDowngrade = false) {
  return invoke<PluginInstallResult>("install_source_plugin_archive", { archivePath, allowDowngrade, locale: i18n.resolvedLanguage });
}

export async function setSourcePluginEnabled(pluginId: string, enabled: boolean) {
  return invoke<SourcePlugin[]>("set_source_plugin_enabled", { pluginId, enabled, locale: i18n.resolvedLanguage });
}

export async function setSourcePluginOrder(pluginIds: string[]) {
  return invoke<SourcePlugin[]>("set_source_plugin_order", { pluginIds, locale: i18n.resolvedLanguage });
}

export async function saveSourcePluginSettings(pluginId: string, config: Record<string, string>) {
  return invoke<SourcePlugin[]>("save_source_plugin_settings", { pluginId, config, locale: i18n.resolvedLanguage });
}

export async function uninstallSourcePlugin(pluginId: string) {
  return invoke<SourcePlugin[]>("uninstall_source_plugin", { pluginId, locale: i18n.resolvedLanguage });
}

export async function invokeSourcePlugin<T>(pluginId: string, functionName: "searchSongs" | "getLyrics" | "searchCovers", request: unknown) {
  return invoke<T>("invoke_source_plugin", { pluginId, functionName, request, locale: i18n.resolvedLanguage });
}

export async function fetchRemoteImage(url: string, maxSize?: number) {
  return invoke<string>("fetch_remote_image", { url, maxSize });
}

export async function reorderPluginSources(sourceKind: PluginSourceKind, pluginIds: string[]) {
  return invoke<SourcePlugin[]>("reorder_plugin_sources", { sourceKind, pluginIds, locale: i18n.resolvedLanguage });
}

export async function setPluginSourceEnabled(pluginId: string, sourceKind: PluginSourceKind, enabled: boolean) {
  return invoke<SourcePlugin[]>("set_plugin_source_enabled", { pluginId, sourceKind, enabled, locale: i18n.resolvedLanguage });
}
