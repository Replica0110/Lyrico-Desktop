export type LibrarySelectionClick = {
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
};

export type LibrarySelectionKey =
  | "ArrowUp"
  | "ArrowDown"
  | "Home"
  | "End"
  | "a";

export type LibrarySelectionKeyMove = LibrarySelectionClick & {
  key: LibrarySelectionKey;
};

export function selectLibraryRow(
  paths: string[],
  selectedPaths: string[],
  anchorIndex: number | null,
  index: number,
  event: LibrarySelectionClick,
) {
  const path = paths[index];
  if (!path) {
    return { selectedPaths, anchorIndex };
  }

  if (event.shiftKey && anchorIndex !== null) {
    const start = Math.min(anchorIndex, index);
    const end = Math.max(anchorIndex, index);
    return {
      selectedPaths: paths.slice(start, end + 1),
      anchorIndex,
    };
  }

  if (event.ctrlKey || event.metaKey) {
    const next = new Set(selectedPaths);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    return {
      selectedPaths: [...next],
      anchorIndex: index,
    };
  }

  return {
    selectedPaths: [path],
    anchorIndex: index,
  };
}

export function selectLibraryByKey(
  paths: string[],
  selectedPaths: string[],
  anchorIndex: number | null,
  cursorIndex: number | null,
  move: LibrarySelectionKeyMove,
) {
  if (paths.length === 0) return null;
  const command = move.ctrlKey || move.metaKey;

  if (move.key === "a") {
    if (!command || move.shiftKey) return null;
    const cursor = clampIndex(cursorIndex, paths.length) ?? clampIndex(anchorIndex, paths.length) ?? 0;
    return {
      selectedPaths: selectedPaths.length === paths.length && paths.every((path, index) => selectedPaths[index] === path)
        ? selectedPaths
        : [...paths],
      anchorIndex: clampIndex(anchorIndex, paths.length) ?? cursor,
      cursorIndex: cursor,
    };
  }

  const origin = clampIndex(cursorIndex, paths.length) ?? clampIndex(anchorIndex, paths.length);
  const target = resolveTarget(paths.length, origin, move.key);
  if (target === null) return null;
  if ((move.key === "ArrowUp" || move.key === "ArrowDown") && origin !== null && target === origin) {
    return null;
  }

  if (command && !move.shiftKey) {
    return { selectedPaths, anchorIndex, cursorIndex: target };
  }

  if (move.shiftKey) {
    const anchor = clampIndex(anchorIndex, paths.length) ?? clampIndex(cursorIndex, paths.length) ?? target;
    const start = Math.min(anchor, target);
    const end = Math.max(anchor, target);
    return {
      selectedPaths: paths.slice(start, end + 1),
      anchorIndex: anchor,
      cursorIndex: target,
    };
  }

  return {
    selectedPaths: [paths[target]],
    anchorIndex: target,
    cursorIndex: target,
  };
}

function resolveTarget(count: number, origin: number | null, key: Exclude<LibrarySelectionKey, "a">) {
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  if (origin === null) return key === "ArrowUp" ? count - 1 : 0;
  const next = origin + (key === "ArrowUp" ? -1 : 1);
  if (next < 0 || next >= count) return origin;
  return next;
}

function clampIndex(index: number | null, count: number) {
  if (index === null || count <= 0) return null;
  return Math.min(count - 1, Math.max(0, index));
}
