export function fileUrlForShare(path: string) {
  const normalized = path.replace(/\\/g, "/");
  return encodeURI(normalized.startsWith("/") ? `file://${normalized}` : `file:///${normalized}`);
}
