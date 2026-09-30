export function artistPosterBaseNames(artist: string) {
  const value = artist.trim();
  const safe = value.replace(/[\\/:*?"<>|]/g, "／");
  const dash = value.replace(/[\\/:*?"<>|]/g, "-");
  const underscore = value.replace(/[\\/:*?"<>|]/g, "_");
  const compact = value.replace(/[\\/:*?"<>|]/g, "");
  return [...new Set([value, safe, dash, underscore, compact].filter(Boolean))];
}
