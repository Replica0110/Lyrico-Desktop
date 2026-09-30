import {
  ArrowLeftOutlined,
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
import { Badge, Button, Empty, Flex, Layout, Tooltip, Typography } from "antd";
import { memo, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { AudioTrack, LibraryFolder, ReplayGainProgress, ScanProgress, ViewKey } from "../app/types";
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
        width={244}
        collapsedWidth={76}
        collapsed={collapsed}
        breakpoint="lg"
        trigger={null}
        onBreakpoint={setCollapsed}
      >
        <nav className="side-navigation" aria-label={t("nav.primary")}>
          {navigationGroups.map((group) => <section className="side-nav-group" key={group.label}>
            {!collapsed ? <Text className="side-nav-label" type="secondary">{group.label}</Text> : null}
            <div className="side-nav-items">
              {group.items.map((item) => <Tooltip key={item.key} title={collapsed ? item.label : undefined} placement="right">
                <button className={`side-nav-item${activeView === item.key ? " is-active" : ""}`} type="button" onClick={() => handleChangeView(item.key as ViewKey)}>
                  <span className="side-nav-icon">{item.icon}</span>
                  {!collapsed ? <span>{item.label}</span> : null}
                </button>
              </Tooltip>)}
            </div>
          </section>)}
        </nav>

        <div className="side-footer">
          {!collapsed && (
            <div className="side-library-summary">
              <Text type="secondary">{t("nav.librarySummary", { tracks: trackCount, folders: folders.length })}</Text>
            </div>
          )}
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
                <Badge count={selectedTracks.length} size="small" overflowCount={99} color="#1677ff" offset={[5, -3]}>
                  <UnorderedListOutlined />
                </Badge>
              }
              onClick={() => setSelectionPageOpen(true)}
            >
              {!collapsed && (
                <span className="side-action-label">
                  <span className="side-action-text">{t("selection.selectedSongs")}</span>
                  <Badge count={selectedTracks.length} showZero overflowCount={99} color="#1677ff" />
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
        /></div> : null}
        </Content>
      </Layout>
    </Layout>
  );
});

function SelectionPage({ tracks, onClose, onRemove, onClear, onOpenBatch }: { tracks: AudioTrack[]; onClose: () => void; onRemove: (path: string) => void; onClear: () => void; onOpenBatch: () => void }) {
  const { t } = useTranslation();
  const {
    rowsRef,
    startIndex,
    endIndex,
    topSpacerHeight,
    bottomSpacerHeight,
  } = useVirtualizedRows(tracks.length, 58, 6);
  const visibleTracks = tracks.slice(startIndex, endIndex);
  return (
    <div className="workspace page-stack detail-subpage selection-page">
      <header className="subpage-toolbar">
        <Button type="text" icon={<ArrowLeftOutlined />} onClick={onClose}>{t("common.back")}</Button>
        <Text strong>{t("selection.drawerTitle", { count: tracks.length })}</Text>
      </header>
      {tracks.length ? <div className="selection-dialog-list">
        <div ref={rowsRef} className="selection-dialog-list-content">
          {topSpacerHeight > 0 ? <div style={{ height: topSpacerHeight }} aria-hidden="true" /> : null}
          {visibleTracks.map((track) => <div className="selection-dialog-row" key={track.path}>
            <div className="track-title-cell"><Text strong ellipsis={{ tooltip: track.title || track.fileName }}>{track.title || track.fileName}</Text><Text type="secondary" ellipsis={{ tooltip: track.artist }}>{track.artist || t("common.unknownArtist")}</Text></div>
            <Tooltip title={t("common.remove")}><Button type="text" danger aria-label={t("common.remove")} icon={<DeleteOutlined />} onClick={() => onRemove(track.path)} /></Tooltip>
          </div>)}
          {bottomSpacerHeight > 0 ? <div style={{ height: bottomSpacerHeight }} aria-hidden="true" /> : null}
        </div>
      </div> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("selection.empty")} />}
      <footer className="selection-page-footer"><Flex justify="space-between" gap={12}><Button disabled={tracks.length === 0} onClick={onClear}>{t("selection.clear")}</Button><Button type="primary" disabled={tracks.length === 0} onClick={onOpenBatch}>{t("selection.batch")}</Button></Flex></footer>
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
      <SideProgress percent={progress.percent} status="active" />
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
      <SideProgress
        percent={percent}
        status={progress.status === "failed" ? "exception" : progress.status === "completed" ? "success" : "active"}
      />
    </div>
  );
}

function SideProgress({ percent, status }: { percent: number; status: "active" | "success" | "exception" }) {
  const value = Math.max(0, Math.min(100, percent));
  return (
    <div className={`side-progress is-${status}`} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(value)}>
      <span className="side-progress-fill" style={{ width: `${value}%` }} />
    </div>
  );
}
