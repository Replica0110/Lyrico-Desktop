export type CollectionSelection = { paths: string[]; groups: Record<string, string[]> };
export const emptyCollectionSelection = (): CollectionSelection => ({ paths: [], groups: {} });
export function selectionPaths(selection: CollectionSelection) {
  return [...new Set([...selection.paths, ...Object.values(selection.groups).flat()])];
}
export function toggleCollection(selection: CollectionSelection, key: string, paths: string[]) {
  const groups = { ...selection.groups };
  if (groups[key]) delete groups[key];
  else groups[key] = [...new Set(paths)];
  return { ...selection, groups };
}
export function reconcileSelection(selection: CollectionSelection, nextPaths: string[]): CollectionSelection {
  const next = new Set(nextPaths);
  const groups = Object.fromEntries(Object.entries(selection.groups).filter(([, paths]) => paths.length > 0 && paths.every(path => next.has(path))));
  const grouped = new Set(Object.values(groups).flat());
  return { paths: [...next].filter(path => !grouped.has(path)), groups };
}
