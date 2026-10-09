import {
  DeleteOutlined,
  EyeInvisibleOutlined,
  EyeOutlined,
  FolderAddOutlined,
  FolderOutlined,
  ReloadOutlined,
  SearchOutlined,
} from "@ant-design/icons";
import { Alert, Button, Input, Popconfirm, Tooltip } from "antd";
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AudioTrack, LibraryFolder } from "../app/types";
import { EmptyState } from "../components/EmptyState";
import { LibrarySelectionToolbar } from "../components/LibrarySelectionToolbar";
import { LibraryTable } from "../components/LibraryTable";
import { PageHeader } from "../components/PageHeader";
import { SortSelect } from "../components/SortSelect";
import { SubPageBar } from "../components/SubPageBar";
import { buildLibraryFolderTree, filterTracks, tracksInDirectory, type LibraryFolderNode } from "../domain/library";
import { folderSortFields, sortFoldersBy, type FolderSortField, type SortState } from "../domain/sort";
import "./FoldersPage.css";

/**
 * Folders: the library root list, and the folder contents as a second-level page.
 * The root list is one row per folder (icon, name, real path, track count, hover actions).
 * Entering a folder replaces the whole page with SubPageBar + the shared song table.
 * See docs/ui-layout.md sections 3, 4, 5 and 9.2.
 */
export const FoldersPage = memo(function FoldersPage({
  folders,
  tracks,
  loading,
  onAddFolders,
  onRescanFolder,
  onRemoveFolder,
  hiddenFolderPaths,
  onToggleFolderHidden,
  onSelectFolder,
  onOpenTrack,
  selectedPaths,
  onChangeSelectedPaths,
  onOpenBatch,
}: {
  folders: LibraryFolder[];
  tracks: AudioTrack[];
  loading: boolean;
  onAddFolders: () => void;
  onRescanFolder: (path: string) => void;
  onRemoveFolder: (path: string) => void;
  hiddenFolderPaths: string[];
  onToggleFolderHidden: (path: string) => void;
  onSelectFolder: (path?: string) => void;
  onOpenTrack: (path: string) => void;
  selectedPaths: string[];
  onChangeSelectedPaths: (paths: string[]) => void;
  onOpenBatch: () => void;
}) {
  const { t } = useTranslation();
  const [folderSort, setFolderSort] = useState<SortState<FolderSortField>>();
  const [currentKey, setCurrentKey] = useState<string>();
  const [query, setQuery] = useState("");

  const sortedFolders = useMemo(
    () => (folderSort ? sortFoldersBy(folders, folderSort.key, folderSort.direction) : folders),
    [folders, folderSort],
  );
  const roots = useMemo(() => buildLibraryFolderTree(sortedFolders, tracks), [sortedFolders, tracks]);
  const nodes = useMemo(() => mapFolderNodes(roots), [roots]);
  const current = currentKey ? nodes.get(currentKey) : undefined;
  const searching = query.trim().length > 0;
  const visibleRoots = useMemo(
    () => (searching ? roots.filter((node) => matchesFolder(node, query)) : roots),
    [roots, searching, query],
  );
  const folderSongs = useMemo(
    () => (current ? tracksInDirectory(tracks, current.path, false) : []),
    [tracks, current],
  );
  const visibleSongs = useMemo(
    () => (searching ? filterTracks(folderSongs, query) : folderSongs),
    [folderSongs, searching, query],
  );
  const handleOpenTrack = useCallback((track: AudioTrack) => onOpenTrack(track.path), [onOpenTrack]);
  const clearQuery = useCallback(() => setQuery(""), []);

  // A removed or rescanned-away folder drops out of the tree: fall back to the root list.
  useEffect(() => {
    if (currentKey && !current) {
      setCurrentKey(undefined);
      setQuery("");
    }
  }, [currentKey, current]);

  function openFolder(node: LibraryFolderNode) {
    setCurrentKey(node.key);
    setQuery("");
    onSelectFolder(node.rootPath);
  }

  function openRoot() {
    setCurrentKey(undefined);
    setQuery("");
    onSelectFolder(undefined);
  }

  function folderActions(node: LibraryFolderNode) {
    const folder = folders.find((item) => samePath(item.path, node.rootPath));
    const hidden = hiddenFolderPaths.some((path) => samePath(path, node.rootPath));
    const rescanLabel = t("folders.rescan");
    const visibilityLabel = t(hidden ? "folders.show" : "folders.hide");
    const removeLabel = t("folders.remove");
    return (
      <>
        <Tooltip title={rescanLabel}>
          <Button
            type="text"
            className="folder-row-action"
            aria-label={rescanLabel}
            icon={<ReloadOutlined />}
            loading={folder?.status === "scanning"}
            disabled={loading}
            onClick={() => onRescanFolder(node.rootPath)}
          />
        </Tooltip>
        <Tooltip title={visibilityLabel}>
          <Button
            type="text"
            className="folder-row-action"
            aria-label={visibilityLabel}
            icon={hidden ? <EyeOutlined /> : <EyeInvisibleOutlined />}
            onClick={() => onToggleFolderHidden(node.rootPath)}
          />
        </Tooltip>
        <Popconfirm
          title={t("folders.removeConfirm", { name: node.name })}
          okText={t("common.remove")}
          cancelText={t("common.cancel")}
          okButtonProps={{ danger: true }}
          onConfirm={() => onRemoveFolder(node.rootPath)}
        >
          <Tooltip title={removeLabel}>
            <Button
              type="text"
              danger
              className="folder-row-action"
              aria-label={removeLabel}
              icon={<DeleteOutlined />}
            />
          </Tooltip>
        </Popconfirm>
      </>
    );
  }

  const addFolderButton = (
    <Button type="primary" icon={<FolderAddOutlined />} onClick={onAddFolders}>
      {t("folders.add")}
    </Button>
  );

  if (!current) {
    const noFolderMatch = roots.length > 0 && visibleRoots.length === 0;
    // Keep the empty state off screen while the library is still loading, unless a search is active.
    const showEmptyState = noFolderMatch || !loading;
    return (
      <div className="page-shell">
        <PageHeader
          title={t("folders.title")}
          meta={t("common.folderCount", { count: folders.length })}
          actions={
            <>
              <Input
                allowClear
                className="page-search"
                prefix={<SearchOutlined />}
                placeholder={t("folders.searchPlaceholder")}
                aria-label={t("folders.searchPlaceholder")}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              <SortSelect
                value={folderSort}
                onChange={setFolderSort}
                fields={folderSortFields.map((key) => ({ key, label: t(`sort.field.${key}`) }))}
              />
              {/* The empty state already offers this action; showing it twice on one screen is noise. */}
              {noFolderMatch || roots.length ? addFolderButton : null}
            </>
          }
        />
        <div className="page-body">
          {visibleRoots.length ? (
            <div className="folder-rows page-transition">
              {visibleRoots.map((node) => (
                <div className="row folder-row" key={node.key}>
                  <FolderRowButton node={node} onOpen={openFolder} />
                  <div className="row-actions">{folderActions(node)}</div>
                </div>
              ))}
            </div>
          ) : showEmptyState ? (
            <EmptyState
              description={noFolderMatch ? t("songs.noResults") : t("folders.empty")}
              action={
                noFolderMatch
                  ? <Button onClick={clearQuery}>{t("songs.clearSearch")}</Button>
                  : addFolderButton
              }
            />
          ) : null}
        </div>
      </div>
    );
  }

  const ancestors = folderAncestors(nodes, current);
  const currentFolder = folders.find((item) => samePath(item.path, current.rootPath));
  const currentHidden = hiddenFolderPaths.some((path) => samePath(path, current.rootPath));
  const rescanLabel = t("folders.rescan");
  const visibilityLabel = t(currentHidden ? "folders.show" : "folders.hide");
  const removeLabel = t("folders.remove");

  return (
    <div className="page-shell">
      <SubPageBar
        backLabel={t("common.back")}
        onBack={() => {
          const parent = current.parentKey ? nodes.get(current.parentKey) : undefined;
          if (parent) openFolder(parent);
          else openRoot();
        }}
        label={t("folders.title")}
        items={[
          { key: "root", label: t("folders.allFolders"), onClick: openRoot },
          ...ancestors.map((node, index) => ({
            key: node.key,
            label: node.name,
            onClick: index === ancestors.length - 1 ? undefined : () => openFolder(node),
          })),
        ]}
        actions={
          <>
            <Input
              allowClear
              className="folder-bar-search"
              prefix={<SearchOutlined />}
              placeholder={t("folders.searchSongs")}
              aria-label={t("folders.searchSongs")}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <div className="folder-bar-buttons">
              <Tooltip title={rescanLabel}>
                <Button
                  type="text"
                  className="folder-bar-action"
                  aria-label={rescanLabel}
                  icon={<ReloadOutlined />}
                  loading={currentFolder?.status === "scanning"}
                  disabled={loading}
                  onClick={() => onRescanFolder(current.rootPath)}
                />
              </Tooltip>
              <Tooltip title={visibilityLabel}>
                <Button
                  type="text"
                  className="folder-bar-action"
                  aria-label={visibilityLabel}
                  icon={currentHidden ? <EyeOutlined /> : <EyeInvisibleOutlined />}
                  onClick={() => onToggleFolderHidden(current.rootPath)}
                />
              </Tooltip>
              <Popconfirm
                title={t("folders.removeConfirm", { name: current.name })}
                okText={t("common.remove")}
                cancelText={t("common.cancel")}
                okButtonProps={{ danger: true }}
                onConfirm={() => onRemoveFolder(current.rootPath)}
              >
                <Tooltip title={removeLabel}>
                  <Button
                    type="text"
                    danger
                    className="folder-bar-action"
                    aria-label={removeLabel}
                    icon={<DeleteOutlined />}
                  />
                </Tooltip>
              </Popconfirm>
            </div>
          </>
        }
      >
        {selectedPaths.length > 0 ? (
          <LibrarySelectionToolbar
            selectedCount={selectedPaths.length}
            onOpenBatch={onOpenBatch}
            onClear={() => onChangeSelectedPaths([])}
            onSelectAll={() => onChangeSelectedPaths(visibleSongs.map((track) => track.path))}
          />
        ) : null}
      </SubPageBar>
      {currentFolder?.error ? (
        <div className="folder-alert">
          <Alert type="error" showIcon message={currentFolder.error} />
        </div>
      ) : null}
      <div className="page-body">
        <div key={current.key} className="page-transition">
          {current.children.length ? (
            <div className="folder-rows folder-subfolders">
              {current.children.map((node) => (
                <div className="row folder-row" key={node.key}>
                  <FolderRowButton node={node} onOpen={openFolder} />
                </div>
              ))}
            </div>
          ) : null}
          {visibleSongs.length || loading ? (
            <LibraryTable
              tracks={visibleSongs}
              loading={loading}
              selectedPaths={selectedPaths}
              onChangeSelectedPaths={onChangeSelectedPaths}
              onOpenTrack={handleOpenTrack}
            />
          ) : searching ? (
            <EmptyState
              description={t("songs.noResults")}
              action={<Button onClick={clearQuery}>{t("songs.clearSearch")}</Button>}
            />
          ) : current.children.length ? null : (
            <EmptyState
              description={t("folders.noContents")}
              action={
                <Button
                  icon={<ReloadOutlined />}
                  loading={currentFolder?.status === "scanning"}
                  disabled={loading}
                  onClick={() => onRescanFolder(current.rootPath)}
                >
                  {t("folders.rescan")}
                </Button>
              }
            />
          )}
        </div>
      </div>
    </div>
  );
});

/** One folder line: icon + name + real path + track count. Opens the folder. */
function FolderRowButton({ node, onOpen }: {
  node: LibraryFolderNode;
  onOpen: (node: LibraryFolderNode) => void;
}) {
  const { t } = useTranslation();
  return (
    <button type="button" className="folder-row-open" onClick={() => onOpen(node)}>
      <FolderOutlined className="folder-row-icon" aria-hidden="true" />
      <strong className="folder-row-name">{node.name}</strong>
      <Tooltip title={node.path}>
        <span className="folder-row-path">{node.path}</span>
      </Tooltip>
      <span className="folder-row-count">{t("common.songCount", { count: node.totalTrackCount })}</span>
    </button>
  );
}

function mapFolderNodes(roots: LibraryFolderNode[]) {
  const map = new Map<string, LibraryFolderNode>();
  const visit = (node: LibraryFolderNode) => {
    map.set(node.key, node);
    node.children.forEach(visit);
  };
  roots.forEach(visit);
  return map;
}

function folderAncestors(nodes: Map<string, LibraryFolderNode>, node: LibraryFolderNode) {
  const result: LibraryFolderNode[] = [];
  let current: LibraryFolderNode | undefined = node;
  while (current) {
    result.unshift(current);
    current = current.parentKey ? nodes.get(current.parentKey) : undefined;
  }
  return result;
}

function matchesFolder(node: LibraryFolderNode, query: string) {
  const needle = query.trim().toLocaleLowerCase();
  return node.name.toLocaleLowerCase().includes(needle) || node.path.toLocaleLowerCase().includes(needle);
}

function samePath(left: string, right: string) {
  return left.replace(/\\/g, "/").replace(/\/+$/, "").toLocaleLowerCase()
    === right.replace(/\\/g, "/").replace(/\/+$/, "").toLocaleLowerCase();
}
