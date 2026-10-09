import { useCallback, useMemo, useState, type SetStateAction } from "react";
import { emptyCollectionSelection, reconcileSelection, selectionPaths, toggleCollection } from "../domain/collectionSelection";
export function useLibrarySelection() {
  const [selection, setSelection] = useState(emptyCollectionSelection);
  const selectedPaths = useMemo(() => selectionPaths(selection), [selection]);
  const setSelectedPaths = useCallback((next: SetStateAction<string[]>) => {
    setSelection(current => reconcileSelection(current, typeof next === "function" ? next(selectionPaths(current)) : next));
  }, []);
  const onToggleCollection = useCallback((key: string, paths: string[]) => {
    setSelection(current => toggleCollection(current, key, paths));
  }, []);
  return { selectedPaths, setSelectedPaths, selectedCollectionKeys: Object.keys(selection.groups), onToggleCollection };
}
