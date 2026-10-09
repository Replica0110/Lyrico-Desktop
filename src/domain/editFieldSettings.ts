export const EDIT_FIELD_LABEL_KEYS: Array<[string, string]> = [
  ["title", "details.titleField"],
  ["artist", "details.artist"],
  ["albumArtist", "details.albumArtist"],
  ["album", "details.album"],
  ["year", "details.year"],
  ["language", "details.language"],
  ["genre", "details.genre"],
  ["trackNumber", "details.track"],
  ["discNumber", "details.disc"],
  ["composer", "details.composer"],
  ["lyricist", "details.lyricist"],
  ["copyright", "details.copyright"],
  ["comment", "details.comment"],
  ["customTags", "details.groups.customTags"],
  ["rating", "details.rating"],
  ["lyrics", "details.lyrics"],
  ["replayGainTrackGain", "tasks.trackGain"],
  ["replayGainTrackPeak", "tasks.trackPeak"],
  ["replayGainAlbumGain", "tasks.albumGain"],
  ["replayGainAlbumPeak", "tasks.albumPeak"],
  ["replayGainReferenceLoudness", "details.referenceLoudness"],
];

export const DEFAULT_EDIT_FIELD_ORDER = EDIT_FIELD_LABEL_KEYS.map(([key]) => key);
const legacyGroups: Record<string, string[]> = {
  basic: ["title", "artist", "albumArtist", "album", "year", "language", "genre"],
  track: ["trackNumber", "discNumber"], credits: ["composer", "lyricist", "copyright", "comment"],
  replaygain: ["replayGainTrackGain", "replayGainTrackPeak", "replayGainAlbumGain", "replayGainAlbumPeak", "replayGainReferenceLoudness"],
  cover: ["rating"],
};
export function normalizeEditFieldOrder(order: readonly string[] | undefined) {
  const expanded = (order ?? []).flatMap(key => legacyGroups[key] ?? [key]);
  return [...new Set([...expanded, ...DEFAULT_EDIT_FIELD_ORDER])].filter(key => DEFAULT_EDIT_FIELD_ORDER.includes(key));
}
