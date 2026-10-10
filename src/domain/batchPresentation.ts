import type { AudioTrack, BatchTaskItem } from "../app/types";

const aliases: Record<string, keyof AudioTrack> = {
  album_artist: "albumArtist", date: "year", track_number: "trackNumber", disc_number: "discNumber",
  replaygain_track_gain: "replayGainTrackGain", replaygain_track_peak: "replayGainTrackPeak",
  replaygain_album_gain: "replayGainAlbumGain", replaygain_album_peak: "replayGainAlbumPeak",
};

export function hasBatchField(track: AudioTrack, field: string): boolean {
  if (field === "lyrics") return track.hasLyrics;
  if (field === "cover_url" || field === "cover") return track.hasCover;
  const value = track[(aliases[field] ?? field) as keyof AudioTrack];
  return typeof value === "string" ? value.trim().length > 0 : typeof value === "number" ? value > 0 : Boolean(value);
}

export function batchFieldValue(track: AudioTrack, field: string) {
  return track[(aliases[field] ?? field) as keyof AudioTrack];
}

export function batchItemMap(items: BatchTaskItem[]) {
  const map = new Map(items.map(item => [item.songPath, item]));
  for (const item of items) {
    const newPath = batchResultData(item).newPath;
    if (typeof newPath === "string") map.set(newPath, item);
  }
  return map;
}

export const taskOperationKeys: Record<string, string> = {
  replayGain: "replaygain", editTags: "edit", formatLyrics: "lyrics", matchMetadata: "metadata",
  renameFiles: "rename", exportLyrics: "exportLyrics", exportCover: "exportCover", deleteFiles: "delete",
};

export function taskOperationKey(task: { taskType: string; configJson?: string }) {
  if (task.taskType === "matchMetadata") {
    try {
      const mode = JSON.parse(task.configJson ?? "{}").matchMode;
      if (mode === "lyrics") return "matchLyrics";
      if (mode === "cover") return "matchCover";
    } catch { /* Legacy tasks may have no config. */ }
  }
  return taskOperationKeys[task.taskType];
}

/** Only known user-facing result fields; malformed or legacy payloads still show status. */
export function batchResultData(item: BatchTaskItem): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(item.resultJson ?? "{}");
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch { return {}; }
}
