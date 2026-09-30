export function getLibraryWindow(
  itemCount: number,
  scrollTop: number,
  viewportHeight: number,
  rowHeight = 60,
  overscan = 8,
) {
  if (itemCount <= 0) return { startIndex: 0, endIndex: 0 };

  const safeViewportHeight = Math.max(0, viewportHeight);
  const maxScrollTop = Math.max(0, itemCount * rowHeight - safeViewportHeight);
  const safeScrollTop = Math.min(Math.max(0, scrollTop), maxScrollTop);
  const startIndex = Math.max(0, Math.floor(safeScrollTop / rowHeight) - overscan);
  const endIndex = Math.min(
    itemCount,
    Math.ceil((safeScrollTop + safeViewportHeight) / rowHeight) + overscan,
  );

  return {
    startIndex: Math.min(startIndex, itemCount - 1),
    endIndex: Math.max(startIndex + 1, endIndex),
  };
}
