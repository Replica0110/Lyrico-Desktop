export function isPathInHiddenFolder(path: string, hiddenFolders: readonly string[]) {
  const normalizedPath = normalize(path);
  return hiddenFolders.some((folder) => {
    const normalizedFolder = normalize(folder).replace(/\/+$/, "");
    return normalizedPath === normalizedFolder || normalizedPath.startsWith(`${normalizedFolder}/`);
  });
}

function normalize(path: string) {
  return path.replace(/\\/g, "/").replace(/\/+$/, "").toLocaleLowerCase();
}
