import type { LibraryFolder } from "../app/types";

/** Windows directory identity, independent of picker path formatting. */
export function folderPathKey(path: string) {
  return path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

export function deduplicateFolders(folders: LibraryFolder[]) {
  const unique = new Map<string, LibraryFolder>();
  for (const folder of folders) {
    const key = folderPathKey(folder.path);
    const previous = unique.get(key);
    if (!previous || (folder.lastScannedAt ?? "") > (previous.lastScannedAt ?? "")) unique.set(key, folder);
  }
  return [...unique.values()];
}

export function upsertFolder(folders: LibraryFolder[], folder: LibraryFolder) {
  const key = folderPathKey(folder.path);
  const rest = folders.filter((candidate) => folderPathKey(candidate.path) !== key);
  return [...deduplicateFolders(rest), folder].sort((left, right) => left.path.localeCompare(right.path));
}
