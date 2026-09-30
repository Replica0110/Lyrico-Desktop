import type { AudioTrack, BatchTaskItem } from "../app/types";

const unchangedTaskTypes = new Set(["exportLyrics", "exportCover"]);

export function libraryPathsToRefresh(taskType: string, items: BatchTaskItem[]) {
  if (unchangedTaskTypes.has(taskType) || taskType === "deleteFiles") return [];
  return succeededItems(items).flatMap((item) => {
    if (taskType !== "renameFiles") return [item.songPath];
    const renamedPath = renamedPathFromItem(item);
    return renamedPath ? [renamedPath] : [];
  });
}

export function applyBatchLibraryUpdate(
  current: AudioTrack[],
  taskType: string,
  items: BatchTaskItem[],
  refreshed: AudioTrack[],
) {
  const succeeded = succeededItems(items);
  if (taskType === "deleteFiles") {
    const deleted = new Set(succeeded.map((item) => normalizePath(item.songPath)));
    return current.filter((track) => !deleted.has(normalizePath(track.path)));
  }
  if (unchangedTaskTypes.has(taskType) || succeeded.length === 0) return current;

  const refreshedByPath = new Map(refreshed.map((track) => [normalizePath(track.path), track]));
  if (taskType === "renameFiles") {
    const renamed = new Map(
      succeeded.flatMap((item) => {
        const nextPath = renamedPathFromItem(item);
        return nextPath ? [[normalizePath(item.songPath), nextPath] as const] : [];
      }),
    );
    return current.flatMap((track) => {
      const nextPath = renamed.get(normalizePath(track.path));
      if (!nextPath) return [track];
      const refreshedTrack = refreshedByPath.get(normalizePath(nextPath));
      return refreshedTrack ? [refreshedTrack] : [];
    });
  }

  return current.map((track) => refreshedByPath.get(normalizePath(track.path)) ?? track);
}

function succeededItems(items: BatchTaskItem[]) {
  return items.filter((item) => item.status === "succeeded");
}

function renamedPathFromItem(item: BatchTaskItem) {
  if (!item.resultJson) return undefined;
  try {
    const result = JSON.parse(item.resultJson) as { newPath?: string };
    return result.newPath || undefined;
  } catch {
    return undefined;
  }
}

function normalizePath(path: string) {
  return path.replace(/\\/g, "/").toLocaleLowerCase();
}
