import {
  SearchOutlined,
  AppstoreOutlined,
  CloudSyncOutlined,
  CustomerServiceOutlined,
  FolderOutlined,
  DeleteOutlined,
  UnorderedListOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  SettingOutlined,
  TagsOutlined,
  TeamOutlined,
} from "@ant-design/icons";
import { Badge, Button, Flex, Input, Layout, Tooltip, Typography } from "antd";
import { memo, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { AudioTrack, LibraryFolder, ReplayGainProgress, ScanProgress, ViewKey } from "../app/types";
import { EmptyState } from "./EmptyState";
import { ProgressBar } from "./ProgressBar";
import { SubPageBar } from "./SubPageBar";
import { TrackArtwork } from "./TrackArtwork";
import { filterTracks } from "../domain/library";
import { formatDuration } from "../utils/format";
import { useReplayGainProgress } from "../hooks/useReplayGainProgress";
import { useVirtualizedRows } from "../hooks/useVirtualizedRows";

const { Sider, Content } = Layout;
const { Text } = Typography;

export const Shell = memo(function Shell({
  activeView,
  children,
  folders,
  trackCount,
  scanProgress,
  selectedTracks,
  onChangeView,
  onCancelReplayGain,
  onRemoveSelectedTrack,
  onClearSelectedTracks,
  onOpenSelectedBatch,
}: {
  activeView: ViewKey;
  children: ReactNode;
  folders: LibraryFolder[];
  trackCount: number;
  scanProgress?: ScanProgress;
  selectedTracks: AudioTrack[];
  onChangeView: (view: ViewKey) => void;
  onCancelReplayGain: () => void;
  onRemoveSelectedTrack: (path: string) => void;
  onClearSelectedTracks: () => void;
  onOpenSelectedBatch: () => void;
}) {
  const { t } = useTranslation();
  const replayGainProgress = useReplayGainProgress();
  const [collapsed, setCollapsed] = useState(false);
  const [selectionPageOpen, setSelectionPageOpen] = useState(false);
  const handleChangeView = useCallback((view: ViewKey) => {
    setSelectionPageOpen(false);
    onChangeView(view);
  }, [onChangeView]);
  useEffect(() => {
    setSelectionPageOpen(false);
  }, [activeView]);
  const navigationGroups = useMemo(() => [
    {
      label: t("nav.library"),
      items: [
        { key: "songs", icon: <CustomerServiceOutlined />, label: t("common.songs") },
        { key: "albums", icon: <AppstoreOutlined />, label: t("common.albums") },
        { key: "artists", icon: <TeamOutlined />, label: t("common.artists") },
        { key: "folders", icon: <FolderOutlined />, label: t("common.folders") },
      ],
    },
    {
      label: t("nav.tools"),
      items: [
        { key: "sources", icon: <TagsOutlined />, label: t("common.sources") },
        { key: "tasks", icon: <CloudSyncOutlined />, label: t("common.tasks") },
      ],
    },
  ], [t]);

  return (
    <Layout className="app-shell">
      <Sider
        className="side-panel"
        width="var(--nav-width)"
        collapsedWidth="var(--nav-collapsed-width)"
        collapsed={collapsed}
        trigger={null}
      >
        <nav className="side-navigation" aria-label={t("nav.primary")}>
          {navigationGroups.map((group) => <section className="side-nav-group" key={group.label}>
            {!collapsed ? <Text className="side-nav-label" type="secondary">{group.label}</Text> : null}
            <div className="side-nav-items">
              {group.items.map((item) => <Tooltip key={item.key} title={collapsed ? item.label : undefined} placement="right">
                <button className={`side-nav-item${activeView === item.key ? " is-active" : ""}`} type="button" aria-label={item.label} aria-current={!selectionPageOpen && activeView === item.key ? "page" : undefined} onClick={() => handleChangeView(item.key as ViewKey)}>
                  <span className="side-nav-icon">{item.icon}</span>
                  {!collapsed ? <span>{item.label}</span> : null}
                </button>
              </Tooltip>)}
            </div>
          </section>)}
        </nav>

        <div className="side-footer">
          <Tooltip title={collapsed ? t("common.settings") : undefined} placement="right">
            <Button
              type="text"
              aria-label={t("common.settings")}
              className={`side-action-button side-settings-button${activeView === "settings" ? " is-active" : ""}`}
              icon={<SettingOutlined />}
              onClick={() => handleChangeView("settings")}
            >
              {!collapsed && <span className="side-action-text">{t("common.settings")}</span>}
            </Button>
          </Tooltip>
          <Tooltip title={collapsed ? t("selection.showSelected") : undefined} placement="right">
            <Button
              type="text"
              aria-label={t("selection.showSelected")}
              className="side-action-button side-selection-button"
              icon={
                <Badge count={collapsed ? selectedTracks.length : 0} size="small" overflowCount={99} color="var(--ant-color-primary)" offset={[5, -3]}>
                  <UnorderedListOutlined />
                </Badge>
              }
              onClick={() => setSelectionPageOpen(true)}
            >
              {!collapsed && (
                <span className="side-action-label">
                  <span className="side-action-text">{t("selection.selectedSongs")}</span>
                  <Badge count={selectedTracks.length} showZero overflowCount={99} color="var(--ant-color-primary)" />
                </span>
              )}
            </Button>
          </Tooltip>
          <Tooltip title={collapsed ? t("nav.expand") : t("nav.collapse")} placement="right">
            <Button
              type="text"
              aria-label={collapsed ? t("nav.expand") : t("nav.collapse")}
              className="side-action-button side-collapse-button"
              icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
              onClick={() => setCollapsed((value) => !value)}
            >
              {!collapsed && <span className="side-action-text">{t("nav.collapse")}</span>}
            </Button>
          </Tooltip>
        </div>
      </Sider>

      <Layout className="app-main">
        {scanProgress && <GlobalScanProgress progress={scanProgress} />}
        {replayGainProgress?.status === "running" && <GlobalReplayGainProgress progress={replayGainProgress} onCancel={onCancelReplayGain} />}
        <Content className="app-content">
        <div className={`shell-content-layer${selectionPageOpen ? " is-hidden" : ""}`}>{children}</div>
        {selectionPageOpen ? <div className="shell-content-layer selection-content-layer"><SelectionPage
          tracks={selectedTracks}
          onClose={() => setSelectionPageOpen(false)}
          onRemove={onRemoveSelectedTrack}
          onClear={onClearSelectedTracks}
          onOpenBatch={() => {
            setSelectionPageOpen(false);
            onOpenSelectedBatch();
          }}
          onBrowse={() => handleChangeView("songs")}
        /></div> : null}
        </Content>
        <footer className="app-statusbar"><Text type="secondary">{t("nav.librarySummary", { tracks: trackCount, folders: folders.length })}</Text></footer>
      </Layout>
    </Layout>
  );
});

function SelectionPage({ tracks, onClose, onRemove, onClear, onOpenBatch, onBrowse }: { tracks: AudioTrack[]; onClose: () => void; onRemove: (path: string) => void; onClear: () => void; onOpenBatch: () => void; onBrowse: () => void }) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => filterTracks(tracks, query), [tracks, query]);
  const {
    rowsRef,
    startIndex,
    endIndex,
    topSpacerHeight,
    bottomSpacerHeight,
  } = useVirtualizedRows(filtered.length, 58, 6);
  const visibleTracks = filtered.slice(startIndex, endIndex);
  return (
    <div className="page-shell selection-page">
      <SubPageBar
        backLabel={t("common.back")}
        onBack={onClose}
        label={t("selection.showSelected")}
        items={[{ key: "selection", label: t("selection.drawerTitle", { count: tracks.length }) }]}
        actions={<>
          <Input allowClear prefix={<SearchOutlined />} className="selection-search" aria-label={t("selection.search")} placeholder={t("selection.search")} value={query} onChange={event => setQuery(event.target.value)} />
          <Button disabled={tracks.length === 0} onClick={onClear}>{t("selection.clear")}</Button>
          <Button type="primary" disabled={tracks.length === 0} onClick={onOpenBatch}>{t("selection.batch")}</Button>
        </>}
      />
      <div className="page-body selection-body">
        {filtered.length ? <div className="selection-list">
          <div ref={rowsRef} className="selection-list-content">
            {topSpacerHeight > 0 ? <div style={{ height: topSpacerHeight }} aria-hidden="true" /> : null}
            {visibleTracks.map((track) => <div className="row selection-row" key={track.path}>
              <TrackArtwork track={track} size={36} /><div className="track-title-cell"><Text strong ellipsis={{ tooltip: track.title || track.fileName }}>{track.title || track.fileName}</Text><Text type="secondary" ellipsis={{ tooltip: track.artist }}>{track.artist || t("common.unknownArtist")}</Text></div>
              <Text type="secondary" className="selection-duration">{formatDuration(track.durationSeconds)}</Text>
              <Tooltip title={track.path}><Text className="selection-album" type="secondary" ellipsis>{track.album}</Text></Tooltip>
              <div className="row-actions"><Tooltip title={t("common.remove")}><Button type="text" danger aria-label={t("common.remove")} icon={<DeleteOutlined />} onClick={() => onRemove(track.path)} /></Tooltip></div>
            </div>)}
            {bottomSpacerHeight > 0 ? <div style={{ height: bottomSpacerHeight }} aria-hidden="true" /> : null}
          </div>
        </div> : (
          <EmptyState
            description={t(tracks.length ? "songs.noResults" : "selection.empty")}
            action={tracks.length
              ? <Button onClick={() => setQuery("")}>{t("songs.clearSearch")}</Button>
              : <Button type="primary" onClick={onBrowse}>{t("selection.enter")}</Button>}
          />
        )}
      </div>
    </div>
  );
}

function GlobalReplayGainProgress({ progress, onCancel }: { progress: ReplayGainProgress; onCancel: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="global-scan-progress">
      <Flex justify="space-between" align="center" gap={12}>
        <Text strong>{t("replayGain.analyzing")}</Text>
        <Text type="secondary" ellipsis={{ tooltip: progress.path }}>{progress.path}</Text>
        <Text type="secondary">{progress.percent}%</Text>
        <Button size="small" danger onClick={onCancel}>{t("common.cancel")}</Button>
      </Flex>
      <ProgressBar percent={progress.percent} className="side-progress" />
    </div>
  );
}

function GlobalScanProgress({ progress }: { progress: ScanProgress }) {
  const { t } = useTranslation();
  const percent = progress.total
    ? Math.round((progress.current / progress.total) * 100)
    : progress.status === "completed"
      ? 100
      : 0;
  return (
    <div className="global-scan-progress">
      <Flex justify="space-between" align="center" gap={12}>
        <Text strong>{t(`scanProgress.phase.${progress.phase}`)}</Text>
        <Text type="secondary" ellipsis={{ tooltip: progress.folderPath }}>
          {progress.folderPath}
        </Text>
        {progress.total > 0 && <Text type="secondary">{progress.current}/{progress.total}</Text>}
      </Flex>
      <ProgressBar
        percent={percent}
        status={progress.status === "failed" ? "exception" : progress.status === "completed" ? "success" : "active"}
        className="side-progress"
      />
    </div>
  );
}
