import { describe, expect, it } from "vitest";
import {
  DEFAULT_EDIT_FIELD_ORDER,
  REPLAY_GAIN_FIELDS,
  flattenEditFieldBlocks,
  normalizeEditFieldOrder,
  toEditFieldBlocks,
} from "./editFieldSettings";

const isReplayGain = (key: string) => (REPLAY_GAIN_FIELDS as readonly string[]).includes(key);

const replayGainRun = (order: string[]) => {
  const start = order.findIndex(isReplayGain);
  return order.slice(start, start + REPLAY_GAIN_FIELDS.length);
};

describe("edit field order", () => {
  it("keeps individual field preferences and appends missing fields", () => {
    expect(normalizeEditFieldOrder(["lyrics", "lyrics", "unknown"])).toEqual(["lyrics", ...DEFAULT_EDIT_FIELD_ORDER.filter(key => key !== "lyrics")]);
  });

  it("migrates legacy group order to editable field rows", () => {
    const order = normalizeEditFieldOrder(["track", "credits", "basic"]);
    expect(order.slice(0, 6)).toEqual(["trackNumber", "discNumber", "composer", "lyricist", "copyright", "comment"]);
    expect(new Set(order).size).toBe(DEFAULT_EDIT_FIELD_ORDER.length);
    expect(order).not.toContain("basic");
  });

  it("collapses every ReplayGain field into one composite block", () => {
    const blocks = toEditFieldBlocks(normalizeEditFieldOrder(undefined));
    const composite = blocks.filter(block => block.composite);
    expect(composite).toHaveLength(1);
    expect(composite[0].fields).toEqual([...REPLAY_GAIN_FIELDS]);
    expect(blocks.flatMap(block => block.fields)).toEqual(DEFAULT_EDIT_FIELD_ORDER);
  });

  it("pulls scattered ReplayGain fields back together on the first one", () => {
    const scattered = ["replayGainAlbumPeak", "title", "replayGainTrackGain", "album", "replayGainReferenceLoudness"];
    const order = normalizeEditFieldOrder(scattered);
    // The block lands where its first member was, and keeps the stored internal order.
    expect(order.slice(0, 5)).toEqual([
      "replayGainAlbumPeak", "replayGainTrackGain", "replayGainReferenceLoudness", "replayGainTrackPeak", "replayGainAlbumGain",
    ]);
    expect(new Set(replayGainRun(order))).toEqual(new Set(REPLAY_GAIN_FIELDS));
    expect(order.filter(isReplayGain)).toHaveLength(REPLAY_GAIN_FIELDS.length);
    expect(order).toHaveLength(DEFAULT_EDIT_FIELD_ORDER.length);
  });

  it("keeps ReplayGain adjacent after a block-level reorder", () => {
    const blocks = toEditFieldBlocks(normalizeEditFieldOrder(undefined));
    const moved = [blocks[0], blocks[2], blocks[1], ...blocks.slice(3)];
    const order = flattenEditFieldBlocks(moved);
    expect(replayGainRun(order)).toEqual([...REPLAY_GAIN_FIELDS]);
    expect(new Set(order).size).toBe(DEFAULT_EDIT_FIELD_ORDER.length);
  });
});
