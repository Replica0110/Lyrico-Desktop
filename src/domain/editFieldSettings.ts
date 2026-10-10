import type { CustomTag, DesktopSettings } from "../app/types";

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
  ["rating", "details.rating"],
  ["lyrics", "details.lyrics"],
  ["replayGainTrackGain", "tasks.trackGain"],
  ["replayGainTrackPeak", "tasks.trackPeak"],
  ["replayGainAlbumGain", "tasks.albumGain"],
  ["replayGainAlbumPeak", "tasks.albumPeak"],
  ["replayGainReferenceLoudness", "details.referenceLoudness"],
];

export const DEFAULT_EDIT_FIELD_ORDER = EDIT_FIELD_LABEL_KEYS.map(([key]) => key);

export function normalizeCustomTagKey(input: string): string | undefined {
  const key = input.trim();
  return key && key.length <= 64 && !/[\r\n]/.test(key) ? key.toUpperCase() : undefined;
}

/** Hidden or removed fields keep the original file values, including unsaved drafts. */
export function filterHiddenCustomTagEdits(draft: readonly CustomTag[], original: readonly CustomTag[], settings: DesktopSettings): CustomTag[] {
  const visible = new Set(normalizeEditFieldOrder(settings.editFieldOrder, settings.editCustomTags).filter(code => customTagKeyOf(code) && settings.editFieldVisibility[code] !== false).map(customTagKeyOf));
  return [...draft.filter(tag => visible.has(normalizeCustomTagKey(tag.key))), ...original.filter(tag => !visible.has(normalizeCustomTagKey(tag.key)))];
}

export function normalizeCustomTagKeys(keys: readonly string[] = []): string[] {
  return [...new Set(keys.flatMap(key => typeof key === "string" ? normalizeCustomTagKey(key) ?? [] : []))];
}

export function customTagKeyOf(code: string): string | undefined {
  return code.startsWith("tag:") ? code.slice(4) : undefined;
}

export function withAddedCustomTag<T extends { editCustomTags: string[]; editFieldOrder: string[]; editFieldVisibility: Record<string, boolean> }>(settings: T, key: string): T {
  const normalized = normalizeCustomTagKey(key);
  if (!normalized || settings.editCustomTags.includes(normalized)) return settings;
  const code = `tag:${normalized}`;
  return { ...settings, editCustomTags: [...settings.editCustomTags, normalized], editFieldOrder: [...normalizeEditFieldOrder(settings.editFieldOrder, settings.editCustomTags), code], editFieldVisibility: { ...settings.editFieldVisibility, [code]: true } };
}

export function withRemovedCustomTag<T extends { editCustomTags: string[]; editFieldOrder: string[]; editFieldVisibility: Record<string, boolean> }>(settings: T, key: string): T {
  const code = `tag:${key}`;
  const visibility = { ...settings.editFieldVisibility };
  delete visibility[code];
  return { ...settings, editCustomTags: settings.editCustomTags.filter(item => item !== key), editFieldOrder: normalizeEditFieldOrder(settings.editFieldOrder, settings.editCustomTags).filter(item => item !== code), editFieldVisibility: visibility };
}

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
  customTags: readonly string[] = [],
): string[] {
  const blocks = toEditFieldBlocks(normalizeEditFieldOrder(order, customTags));
  return flattenEditFieldBlocks(blocks.map((block) => {
    if (block.key !== blockKey || !block.composite) return block;
    const reordered = members.filter((key) => block.fields.includes(key));
    const missing = block.fields.filter((key) => !reordered.includes(key));
    return { ...block, fields: [...reordered, ...missing] };
  }));
}

export function normalizeEditFieldOrder(order: readonly string[] | undefined, customTags: readonly string[] = []) {
  const known = [...DEFAULT_EDIT_FIELD_ORDER, ...normalizeCustomTagKeys(customTags).map(key => `tag:${key}`)];
  const expanded = (order ?? []).flatMap(key => legacyGroups[key] ?? [customTagKeyOf(key) ? `tag:${normalizeCustomTagKey(customTagKeyOf(key)!) ?? customTagKeyOf(key)}` : key]);
  const unique = [...new Set([...expanded, ...known])].filter(key => known.includes(key));
  return flattenEditFieldBlocks(toEditFieldBlocks(unique));
}
