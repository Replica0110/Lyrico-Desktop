export type LibrarySelectionClick = {
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
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
    selectedPaths: [],
    anchorIndex: index,
  };
}
