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

/**
 * ReplayGain values are one measurement, not five independent fields, so they always stay
 * adjacent: they render as one group and reorder as one block. Mirrors the mobile app's
 * `component:ReplayGain` block (lyrico `EditFieldBlock.kt`).
 */
export const REPLAY_GAIN_FIELDS = [
  "replayGainTrackGain",
  "replayGainTrackPeak",
  "replayGainAlbumGain",
  "replayGainAlbumPeak",
  "replayGainReferenceLoudness",
] as const;

export const REPLAY_GAIN_BLOCK_KEY = "replayGain";

export type EditFieldBlock = {
  key: string;
  fields: string[];
  composite: boolean;
};

const legacyGroups: Record<string, string[]> = {
  basic: ["title", "artist", "albumArtist", "album", "year", "language", "genre"],
  track: ["trackNumber", "discNumber"], credits: ["composer", "lyricist", "copyright", "comment"],
  replaygain: [...REPLAY_GAIN_FIELDS],
  cover: ["rating"],
};

function isReplayGainField(key: string): boolean {
  return (REPLAY_GAIN_FIELDS as readonly string[]).includes(key);
}

/** Collapse an ordered field list into renderable/reorderable blocks. */
export function toEditFieldBlocks(order: readonly string[]): EditFieldBlock[] {
  const blocks: EditFieldBlock[] = [];
  let replayGainEmitted = false;
  for (const key of order) {
    if (isReplayGainField(key)) {
      if (replayGainEmitted) continue;
      replayGainEmitted = true;
      const members = order.filter(isReplayGainField);
      blocks.push({ key: REPLAY_GAIN_BLOCK_KEY, fields: members, composite: true });
      continue;
    }
    blocks.push({ key, fields: [key], composite: false });
  }
  return blocks;
}

export function flattenEditFieldBlocks(blocks: readonly EditFieldBlock[]): string[] {
  return blocks.flatMap((block) => block.fields);
}

/**
 * Reorder the members of one composite block in place, keeping the block where it is.
 * Unknown codes are ignored and any member missing from `members` keeps its relative position at the end.
 * Mirrors the mobile app's `EditFieldConfig.withComponentOrder`.
 */
export function withEditFieldBlockMembers(
  order: readonly string[] | undefined,
  blockKey: string,
  members: readonly string[],
): string[] {
  const blocks = toEditFieldBlocks(normalizeEditFieldOrder(order));
  return flattenEditFieldBlocks(blocks.map((block) => {
    if (block.key !== blockKey || !block.composite) return block;
    const reordered = members.filter((key) => block.fields.includes(key));
    const missing = block.fields.filter((key) => !reordered.includes(key));
    return { ...block, fields: [...reordered, ...missing] };
  }));
}

export function normalizeEditFieldOrder(order: readonly string[] | undefined) {
  const expanded = (order ?? []).flatMap(key => legacyGroups[key] ?? [key]);
  const unique = [...new Set([...expanded, ...DEFAULT_EDIT_FIELD_ORDER])].filter(key => DEFAULT_EDIT_FIELD_ORDER.includes(key));
  return flattenEditFieldBlocks(toEditFieldBlocks(unique));
}
