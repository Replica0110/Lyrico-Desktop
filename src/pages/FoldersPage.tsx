import { DeleteOutlined, EyeInvisibleOutlined, EyeOutlined, FolderAddOutlined, ReloadOutlined } from "@ant-design/icons";
import { Alert, Badge, Breadcrumb, Button, Empty, Flex, Input, Segmented, Space, Tooltip, Tree, Typography } from "antd";
import { memo, useEffect, useMemo, useState, type Key, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { AudioTrack, LibraryFolder } from "../app/types";
import { LibraryTable } from "../components/LibraryTable";
import { SortSelect } from "../components/SortSelect";
import { buildLibraryFolderTree, filterTracks, tracksInDirectory, type LibraryFolderNode } from "../domain/library";
import { folderSortFields, sortFoldersBy, type FolderSortField, type SortState } from "../domain/sort";
import { formatTimeValue } from "../utils/format";

const { DirectoryTree } = Tree;
const { Title, Text } = Typography;

export const FoldersPage = memo(function FoldersPage({
  folders,
  tracks,
  selectedFolderPath,
  loading,
  onAddFolders,
  onRescanFolder,
  onRemoveFolder,
  hiddenFolderPaths,
  onToggleFolderHidden,
  onSelectFolder,
  onSelectTrack,
  onOpenTrack,
  selectedPaths,
  selectionMode,
  onChangeSelectedPaths,
  onChangeSelectionMode,
  onOpenBatch,
}: {
  folders: LibraryFolder[];
  tracks: AudioTrack[];
  selectedFolderPath?: string;
  loading: boolean;
  onAddFolders: () => void;
  onRescanFolder: (path: string) => void;
  onRemoveFolder: (path: string) => void;
  hiddenFolderPaths: string[];
  onToggleFolderHidden: (path: string) => void;
  onSelectFolder: (path?: string) => void;
  onSelectTrack: (path?: string) => void;
  onOpenTrack: (path: string) => void;
  selectedPaths: string[];
  selectionMode: boolean;
  onChangeSelectedPaths: (paths: string[]) => void;
  onChangeSelectionMode: (enabled: boolean) => void;
  onOpenBatch: () => void;
}) {
  const { t } = useTranslation();
  const [folderSort, setFolderSort] = useState<SortState<FolderSortField>>();
  const sortedFolders = useMemo(() => (folderSort ? sortFoldersBy(folders, folderSort.key, folderSort.direction) : folders), [folders, folderSort]);
  const folderTree = useMemo(() => buildLibraryFolderTree(sortedFolders, tracks), [sortedFolders, tracks]);
  const nodeMap = useMemo(() => mapFolderNodes(folderTree), [folderTree]);
  const selectedRoot = folderTree.find((node) => samePath(node.rootPath, selectedFolderPath)) ?? folderTree[0];
  const [selectedDirectoryKey, setSelectedDirectoryKey] = useState<string>();
  const [expandedKeys, setExpandedKeys] = useState<Key[]>([]);
  const [scope, setScope] = useState<"recursive" | "direct">("recursive");
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (!selectedRoot) {
      setSelectedDirectoryKey(undefined);
      return;
    }
    const current = selectedDirectoryKey ? nodeMap.get(selectedDirectoryKey) : undefined;
    if (!current || !samePath(current.rootPath, selectedRoot.rootPath)) setSelectedDirectoryKey(selectedRoot.key);
  }, [nodeMap, selectedDirectoryKey, selectedRoot]);

  useEffect(() => {
    const rootKeys = folderTree.map((node) => node.key);
    setExpandedKeys((current) => {
      const missing = rootKeys.filter((key) => !current.includes(key));
      return missing.length ? [...current, ...missing] : current;
    });
  }, [folderTree]);

  const activeNode = (selectedDirectoryKey ? nodeMap.get(selectedDirectoryKey) : undefined) ?? selectedRoot;
  const activeRoot = activeNode ? folders.find((folder) => samePath(folder.path, activeNode.rootPath)) : undefined;
  const folderTracks = useMemo(() => activeNode ? tracksInDirectory(tracks, activeNode.path, scope === "recursive") : [], [activeNode, tracks, scope]);
  const visibleTracks = useMemo(() => filterTracks(folderTracks, query), [folderTracks, query]);
  const breadcrumbs = useMemo(() => activeNode ? folderAncestors(nodeMap, activeNode) : [], [activeNode, nodeMap]);
  const lastScanText = activeRoot ? formatTimeValue(activeRoot.lastScannedAt) : "-";
  const treeData = useMemo(() => folderTree.map((node) => toTreeData(node, folders)), [folderTree, folders]);

  function selectDirectory(node: LibraryFolderNode) {
    setSelectedDirectoryKey(node.key);
    setQuery("");
    const root = folders.find((folder) => samePath(folder.path, node.rootPath));
    if (root && !samePath(root.path, selectedFolderPath)) onSelectFolder(root.path);
  }

  return (
    <div className="workspace page-stack">
      <Flex className="folder-page-header" justify="space-between" align="center" gap={16} wrap>
        <Title level={2}>{t("folders.title")}</Title>
        <Button type="primary" icon={<FolderAddOutlined />} onClick={onAddFolders}>{t("folders.add")}</Button>
      </Flex>

      {folders.length === 0 && !loading ? (
        <section className="desktop-list-surface">
          <Empty className="page-empty" image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("folders.empty")}>
            <Button type="primary" icon={<FolderAddOutlined />} onClick={onAddFolders}>{t("folders.add")}</Button>
          </Empty>
        </section>
      ) : (
        <section className="folder-browser">
          <aside className="folder-sidebar">
            <Flex className="folder-pane-header" align="center" justify="space-between">
              <Text strong>{t("folders.libraryRoots")}</Text>
              <Text type="secondary">{folders.length}</Text>
            </Flex>
            <div className="folder-tree-scroll">
              <DirectoryTree
                blockNode
                showIcon
                treeData={treeData}
                selectedKeys={activeNode ? [activeNode.key] : []}
                expandedKeys={expandedKeys}
                onExpand={(keys) => setExpandedKeys(keys)}
                onSelect={(keys) => {
                  const node = keys[0] ? nodeMap.get(String(keys[0])) : undefined;
                  if (node) selectDirectory(node);
                }}
              />
            </div>
          </aside>

          <main className="folder-main-pane">
            {activeNode && activeRoot ? (
              <>
                <Flex className="folder-pane-header" align="center" justify="space-between" gap={12}>
                  <Space>
                    <Tooltip title={displayFolderPath(activeNode.path, activeRoot.path)}>
                      <Breadcrumb
                        className="folder-detail-breadcrumb"
                        items={breadcrumbs.map((node, index) => ({
                          title: index === breadcrumbs.length - 1 ? node.name : (
                            <Button type="link" size="small" className="folder-breadcrumb-button" onClick={() => selectDirectory(node)}>{node.name}</Button>
                          ),
                        }))}
                      />
                    </Tooltip>
                    {activeRoot && lastScanText !== "-" ? (
                      <Tooltip title={activeRoot.lastScannedAt}>
                        <Text className="folder-last-scan" type="secondary">{t("folders.lastScanValue", { value: lastScanText })}</Text>
                      </Tooltip>
                    ) : null}
                  </Space>
                  <Space>
                    <Tooltip title={t("folders.rescan")}>
                      <Button
                        type="text"
                        icon={<ReloadOutlined />}
                        aria-label={t("folders.rescan")}
                        loading={activeRoot.status === "scanning"}
                        disabled={loading || activeRoot.status === "scanning"}
                        onClick={() => onRescanFolder(activeRoot.path)}
                      />
                    </Tooltip>
                    {activeNode.parentKey == null ? (
                      <Tooltip title={hiddenFolderPaths.some((path) => samePath(path, activeRoot.path)) ? t("folders.show") : t("folders.hide")}>
                        <Button
                          type="text"
                          icon={hiddenFolderPaths.some((path) => samePath(path, activeRoot.path)) ? <EyeOutlined /> : <EyeInvisibleOutlined />}
                          aria-label={hiddenFolderPaths.some((path) => samePath(path, activeRoot.path)) ? t("folders.show") : t("folders.hide")}
                          onClick={() => onToggleFolderHidden(activeRoot.path)}
                        />
                      </Tooltip>
                    ) : null}
                    {activeNode.parentKey == null ? (
                      <Tooltip title={t("folders.remove")}>
                        <Button type="text" danger icon={<DeleteOutlined />} aria-label={t("folders.remove")} onClick={() => onRemoveFolder(activeRoot.path)} />
                      </Tooltip>
                    ) : null}
                  </Space>
                </Flex>
                {activeRoot.error ? <Alert className="folder-error-alert" type="error" showIcon message={activeRoot.error} /> : null}

                <Flex className="folder-content-toolbar" align="center" justify="space-between" gap={12} wrap>
                  <Segmented
                    value={scope}
                    options={[
                      { value: "recursive", label: t("folders.includeSubfolders") },
                      { value: "direct", label: t("folders.currentFolderOnly") },
                    ]}
                    onChange={(value) => setScope(value as "recursive" | "direct")}
                  />
                  <Input.Search
                    allowClear
                    className="folder-search"
                    value={query}
                    placeholder={t("folders.searchPlaceholder")}
                    onChange={(event) => setQuery(event.target.value)}
                  />
                  <SortSelect
                    value={folderSort}
                    onChange={setFolderSort}
                    fields={folderSortFields.map((key) => ({ key, label: t(`sort.field.${key}`) }))}
                  />
                </Flex>

                <LibraryTable
                  tracks={visibleTracks}
                  loading={loading}
                  onSelectTrack={onSelectTrack}
                  onOpenTrack={(track) => onOpenTrack(track.path)}
                  selectedPaths={selectedPaths}
                  onChangeSelectedPaths={onChangeSelectedPaths}
                  selectionMode={selectionMode}
                  onChangeSelectionMode={onChangeSelectionMode}
                  onOpenBatch={onOpenBatch}
                />
              </>
            ) : (
              <Empty className="folder-pane-empty" description={t("folders.empty")} />
            )}
          </main>
        </section>
      )}
    </div>
  );
});

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

function toTreeData(node: LibraryFolderNode, folders: LibraryFolder[]): { key: string; title: ReactNode; children: ReturnType<typeof toTreeData>[] } {
  const root = folders.find((folder) => samePath(folder.path, node.rootPath));
  return {
    key: node.key,
    title: (
      <Flex className="folder-tree-title" align="center" justify="space-between" gap={8}>
        <Text ellipsis={{ tooltip: displayFolderPath(node.path, root?.path ?? node.rootPath) }}>{node.name}</Text>
        <Space size={6}>
          {node.parentKey == null && root ? <Badge status={root.status === "error" ? "error" : root.status === "scanning" ? "processing" : "success"} /> : null}
          <Text type="secondary">{node.totalTrackCount}</Text>
        </Space>
      </Flex>
    ),
    children: node.children.map((child) => toTreeData(child, folders)),
  };
}

function samePath(left?: string, right?: string) {
  if (!left || !right) return false;
  return left.replace(/\\/g, "/").replace(/\/+$/, "").toLocaleLowerCase() === right.replace(/\\/g, "/").replace(/\/+$/, "").toLocaleLowerCase();
}

function displayFolderPath(path: string, rootPath: string) {
  return rootPath.includes("\\") ? path.replace(/\//g, "\\") : path;
}
