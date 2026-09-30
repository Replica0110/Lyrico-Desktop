export type BatchMatchMode = "metadata" | "lyrics" | "cover";
export type BatchMatchWriteMode = "disabled" | "supplement" | "overwrite";

const MATCH_FIELDS = [
  "title",
  "artist",
  "album_artist",
  "album",
  "genre",
  "date",
  "track_number",
  "disc_number",
  "composer",
  "lyricist",
  "comment",
  "lyrics",
  "cover_url",
  "language",
  "copyright",
  "rating",
  "replaygain_track_gain",
  "replaygain_track_peak",
  "replaygain_album_gain",
  "replaygain_album_peak",
] as const;

export function buildMatchTargetModes(
  mode: BatchMatchMode,
): Record<string, BatchMatchWriteMode> {
  const targetModes: Record<string, BatchMatchWriteMode> = Object.fromEntries(
    MATCH_FIELDS.map((field) => [field, "disabled" as const]),
  ) as Record<string, BatchMatchWriteMode>;
  if (mode === "lyrics") targetModes.lyrics = "supplement";
  else if (mode === "cover") targetModes.cover_url = "supplement";
  else {
    for (const field of ["title", "artist", "album", "genre", "date", "track_number", "lyrics", "cover_url"]) {
      targetModes[field] = "supplement";
    }
  }
  return targetModes;
}
