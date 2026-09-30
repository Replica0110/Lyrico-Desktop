import { invoke } from "@tauri-apps/api/core";

export type LyricFormat = "plainLrc" | "verbatimLrc" | "enhancedLrc" | "ttml";
export type { LyricLineTrack } from "../app/types";
import type { LyricLineTrack } from "../app/types";
export type LyricsConversionMode = "none" | "traditionalToSimplified" | "simplifiedToTraditional";

export type LyricsOptions = {
  showTranslation?: boolean;
  showRomanization?: boolean;
  onlyTranslationIfAvailable?: boolean;
  lineOrder?: LyricLineTrack[];
  normalizeWhitespace?: boolean;
  removeEmptyLines?: boolean;
  removeTagLineKeywords?: string[];
  offsetMs?: number;
  conversionMode?: LyricsConversionMode;
  forceRewrite?: boolean;
  sourceFormat?: LyricFormat;
  targetFormat?: LyricFormat;
};

export type LyricsPipelineResult = {
  text: string;
  warnings: string[];
  sourceFormat?: LyricFormat;
  targetFormat: LyricFormat;
};

const RAW_KEYS: Record<LyricFormat, string> = {
  plainLrc: "rawPlainLrc",
  verbatimLrc: "rawVerbatimLrc",
  enhancedLrc: "rawEnhancedLrc",
  ttml: "rawTtml",
};

export const LYRIC_FORMATS: LyricFormat[] = ["plainLrc", "verbatimLrc", "enhancedLrc", "ttml"];

export function preferredPluginLyricFormat(result: unknown): LyricFormat | undefined {
  if (!result || typeof result !== "object" || Array.isArray(result)) return undefined;
  const value = result as Record<string, unknown>;
  if (Array.isArray(value.original)) return "verbatimLrc";
  return LYRIC_FORMATS.find((format) => typeof value[RAW_KEYS[format]] === "string" && Boolean(value[RAW_KEYS[format]]));
}

export type PluginLyricsCandidate = {
  key: string;
  payload: unknown;
  title: string;
  artist: string;
  album: string;
  date: string;
};

const CONTAINER_KEYS = ["items", "results", "candidates"];

function candidateFrom(value: unknown): unknown | undefined {
  if (typeof value === "string") return value.trim() ? value : undefined;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const object = value as Record<string, unknown>;
    if (object.notFound === true) return undefined;
    return object;
  }
  return undefined;
}

function defined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

/** Mirrors the Rust `lyrics_candidates` normalizer. */
export function normalizeLyricsCandidates(result: unknown): unknown[] {
  if (Array.isArray(result)) return result.map(candidateFrom).filter(defined);
  if (result && typeof result === "object") {
    const object = result as Record<string, unknown>;
    for (const key of CONTAINER_KEYS) {
      if (Array.isArray(object[key])) return (object[key] as unknown[]).map(candidateFrom).filter(defined);
    }
  }
  return [candidateFrom(result)].filter(defined);
}

/** Reads `tags.ti/ar/al/date` lowercased and trimmed, like the Rust side. */
export function candidateTags(candidate: unknown): Record<string, string> {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return {};
  const tags = (candidate as Record<string, unknown>).tags;
  if (!tags || typeof tags !== "object" || Array.isArray(tags)) return {};
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(tags as Record<string, unknown>)) {
    if (typeof value === "string") normalized[key] = value.trim().toLowerCase();
  }
  return normalized;
}

function candidateText(candidate: unknown, ...keys: string[]) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return "";
  const object = candidate as Record<string, unknown>;
  for (const key of keys) {
    const value = object[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

/** Mirrors the Rust `ordered_lyrics_candidates` ranking. */
export function orderLyricsCandidates(candidates: unknown[], track: { title?: string; artist?: string; album?: string }): unknown[] {
  const title = (track.title ?? "").trim().toLowerCase();
  const artist = (track.artist ?? "").trim().toLowerCase();
  const album = (track.album ?? "").trim().toLowerCase();
  return candidates
    .map((candidate, index) => ({ candidate, index, score: candidateScore(candidate, title, artist, album) }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map((entry) => entry.candidate);
}

function candidateScore(candidate: unknown, title: string, artist: string, album: string) {
  const tags = candidateTags(candidate);
  let score = 0;
  if (title && tags.ti === title) score += 4;
  if (artist && tags.ar === artist) score += 3;
  if (album && tags.al === album) score += 2;
  if (tags.date) score += 1;
  return score;
}

export function lyricsCandidateLabel(candidate: unknown, index: number) {
  const tags = candidateTags(candidate);
  const parts = [tags.ti, tags.ar, tags.al, tags.date].filter(Boolean);
  if (!parts.length) {
    const title = candidateText(candidate, "title", "name", "songName");
    const artist = candidateText(candidate, "artist", "artists", "singer");
    if (title || artist) return [title, artist].filter(Boolean).join(" · ");
  }
  return parts.length ? parts.join(" · ") : `#${index + 1}`;
}

/** Mirrors the Rust `lyrics_payload` conversion into a pipeline-readable object. */
export async function lyricsCandidatePayload(candidate: unknown): Promise<unknown> {
  if (typeof candidate === "string") return stringPayload(candidate);
  if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
    const object = candidate as Record<string, unknown>;
    const hasPayload = Array.isArray(object.original)
      || LYRIC_FORMATS.some((format) => typeof object[RAW_KEYS[format]] === "string" && Boolean((object[RAW_KEYS[format]] as string).trim()));
    if (hasPayload) return object;
    if (typeof object.text === "string") return stringPayload(object.text);
    return object;
  }
  return candidate;
}

async function stringPayload(text: string) {
  const format = await detectLyricsFormat(text);
  return { [RAW_KEYS[format]]: text };
}

/** Builds the selectable candidate list for a `getLyrics` response. */
export async function buildLyricsCandidates(result: unknown, track: { title?: string; artist?: string; album?: string }): Promise<PluginLyricsCandidate[]> {
  const ordered = orderLyricsCandidates(normalizeLyricsCandidates(result), track);
  const candidates: PluginLyricsCandidate[] = [];
  for (const [index, candidate] of ordered.entries()) {
    const tags = candidateTags(candidate);
    candidates.push({
      key: `${index}:${tags.ti ?? ""}:${tags.ar ?? ""}:${tags.al ?? ""}:${tags.date ?? ""}`,
      payload: await lyricsCandidatePayload(candidate),
      title: tags.ti || candidateText(candidate, "title", "name", "songName"),
      artist: tags.ar || candidateText(candidate, "artist", "artists", "singer"),
      album: tags.al || candidateText(candidate, "album", "albumName"),
      date: tags.date || candidateText(candidate, "date", "year"),
    });
  }
  return candidates;
}

export function processLyricsText(raw: string, options: LyricsOptions = {}) {
  return invoke<LyricsPipelineResult>("process_lyrics_text", { raw, options });
}

export function renderPluginLyrics(result: unknown, targetFormat: LyricFormat, options: LyricsOptions = {}) {
  return invoke<LyricsPipelineResult>("render_plugin_lyrics", { result, targetFormat, options });
}

export function extractPlainLyricsText(raw: string) {
  return invoke<string>("extract_plain_lyrics_text", { raw });
}

export function detectLyricsFormat(raw: string) {
  return invoke<LyricFormat>("detect_lyrics_format", { raw });
}
