export function defaultOnlineSearchKeyword(track: {
  title?: string;
  artist?: string;
  fileName: string;
}) {
  const tagged = [track.title, track.artist].map((value) => value?.trim()).filter(Boolean).join(" ");
  if (tagged) return tagged;
  return track.fileName.replace(/\.[^.]+$/, "").trim();
}
