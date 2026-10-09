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
import { Badge, Button, Flex, Input, Layout, Popover, Tooltip, Typography } from "antd";
import { memo, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { AudioTrack, LibraryFolder, ReplayGainProgress, ScanProgress, ViewKey } from "../app/types";
import { EmptyState } from "./EmptyState";
import { ProgressBar } from "./ProgressBar";
import { PageHeader } from "./PageHeader";
import { TrackArtwork } from "./TrackArtwork";
import { filterTracks } from "../domain/library";
import { formatDuration } from "../utils/format";
import { useReplayGainProgress } from "../hooks/useReplayGainProgress";
import { listen } from "@tauri-apps/api/event";
import { loadBatchTasks } from "../backend/audioApi";
import type { BatchTask } from "../app/types";
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
}) {
  const { t } = useTranslation();
  const replayGainProgress = useReplayGainProgress();
  const [activityOpen, setActivityOpen] = useState(false);
  const [batchTasks, setBatchTasks] = useState<BatchTask[]>([]);
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const changed = new Set<string>();
    const active = (task: BatchTask) => task.status === "running" || task.status === "queued";
    void listen<BatchTask>("batch-task-updated", ({ payload }) => {
      if (disposed) return;
      changed.add(payload.taskId);
      setBatchTasks(current => active(payload)
        ? current.some(task => task.taskId === payload.taskId) ? current.map(task => task.taskId === payload.taskId ? payload : task) : [...current, payload]
        : current.filter(task => task.taskId !== payload.taskId));
    }).then(dispose => { if (disposed) dispose(); else unlisten = dispose; }).catch(() => undefined);
    void loadBatchTasks().then(tasks => {
      if (!disposed) setBatchTasks(current => [...current, ...tasks.filter(task => active(task) && !changed.has(task.taskId))]);
    }).catch(() => undefined);
    return () => { disposed = true; unlisten?.(); };
  }, []);
  const batchTotal = batchTasks.reduce((sum, task) => sum + task.total, 0);
  const batchCurrent = batchTasks.reduce((sum, task) => sum + task.current, 0);
  const batchPercent = batchTotal ? batchTasks.reduce((sum, task) => sum + (task.progress ?? (task.total ? task.current / task.total : 0)) * task.total, 0) / batchTotal * 100 : 0;
  const operationKeys: Record<string, string> = { replayGain: "replaygain", editTags: "edit", formatLyrics: "lyrics", matchMetadata: "metadata", renameFiles: "rename", deleteFiles: "delete", matchLyrics: "matchLyrics", matchCover: "matchCover", exportLyrics: "exportLyrics", exportCover: "exportCover" };
  const [collapsed, setCollapsed] = useState(false);
  const [selectionPageOpen, setSelectionPageOpen] = useState(false);
  const handleChangeView = useCallback((view: ViewKey) => {
    setSelectionPageOpen(false);
    setActivityOpen(false);
    onChangeView(view);
  }, [onChangeView]);
  useEffect(() => {
    setSelectionPageOpen(false);
    setActivityOpen(false);
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
                <button className={`side-nav-item${!selectionPageOpen && activeView === item.key ? " is-active" : ""}`} type="button" aria-label={item.label} aria-current={!selectionPageOpen && activeView === item.key ? "page" : undefined} onClick={() => handleChangeView(item.key as ViewKey)}>
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
              className={`side-action-button side-settings-button${!selectionPageOpen && activeView === "settings" ? " is-active" : ""}`}
              aria-current={!selectionPageOpen && activeView === "settings" ? "page" : undefined}
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
              className={`side-action-button side-selection-button${selectionPageOpen ? " is-active" : ""}`}
              aria-current={selectionPageOpen ? "page" : undefined}
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
        <Content className="app-content">
        <div className={`shell-content-layer${selectionPageOpen ? " is-hidden" : ""}`}>{children}</div>
        {selectionPageOpen ? <div className="shell-content-layer selection-content-layer"><SelectionPage
          tracks={selectedTracks}
          onRemove={onRemoveSelectedTrack}
          onClear={onClearSelectedTracks}
          onBrowse={() => handleChangeView("songs")}
        /></div> : null}
        </Content>
        <footer className="app-statusbar">
          <Text type="secondary" ellipsis>{t("nav.librarySummary", { tracks: trackCount, folders: folders.length })}</Text>
          <div className="statusbar-activities">
            {batchTasks.length > 0 && <Popover open={activityOpen} onOpenChange={setActivityOpen} trigger="click" placement="top" content={<div className="global-scan-progress"><div className="activity-task-list">
              {batchTasks.map(task => <div key={task.taskId} className="activity-task">
                <Text strong>{t(`tasks.operations.${operationKeys[task.taskType] ?? task.taskType}`, { defaultValue: task.taskType })}</Text>
                <Text>{t("tasks.taskSummary", { current: task.current, total: task.total, success: task.successCount, skipped: task.skippedCount, failed: task.failureCount })}</Text>
                <ProgressBar percent={(task.progress ?? (task.total ? task.current / task.total : 0)) * 100} />
              </div>)}</div>
              <Button size="small" onClick={() => handleChangeView("tasks")}>{t("feedback.viewTasks")}</Button>
            </div>}>
              <button type="button" className="statusbar-activity" aria-label={t("feedback.progressDetails")}><span>{t("tasks.title")}</span><ProgressBar percent={batchPercent} /><span>{batchCurrent}/{batchTotal}</span></button>
            </Popover>}
            {scanProgress?.status === "running" && <Popover trigger="click" placement="top" content={<GlobalScanProgress progress={scanProgress} />}>
              <button type="button" className="statusbar-activity" aria-label={t("feedback.progressDetails")}>
                <span>{t(`scanProgress.phase.${scanProgress.phase}`)}</span>
                <ProgressBar percent={scanProgress.total ? scanProgress.current / scanProgress.total * 100 : 0} indeterminate={!scanProgress.total} />
                <span>{scanProgress.current}/{scanProgress.total || "—"}</span>
              </button>
            </Popover>}
            {replayGainProgress?.status === "running" && !batchTasks.some(task => replayGainProgress.jobId.startsWith(`${task.taskId}:`)) && <Popover trigger="click" placement="top" content={<GlobalReplayGainProgress progress={replayGainProgress} onCancel={onCancelReplayGain} />}>
              <button type="button" className="statusbar-activity" aria-label={t("feedback.progressDetails")}>
                <span>{t("replayGain.analyzing")}</span>
                <ProgressBar percent={replayGainProgress.percent} />
                <span>{replayGainProgress.percent}%</span>
              </button>
            </Popover>}
          </div>
        </footer>
      </Layout>
    </Layout>
  );
});

function SelectionPage({ tracks, onRemove, onClear, onBrowse }: { tracks: AudioTrack[]; onRemove: (path: string) => void; onClear: () => void; onBrowse: () => void }) {
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
      <PageHeader
        title={t("selection.selectedSongs")}
        meta={t("common.songCount", { count: tracks.length })}
        actions={<>
          <Input allowClear prefix={<SearchOutlined />} className="selection-search" aria-label={t("selection.search")} placeholder={t("selection.search")} value={query} onChange={event => setQuery(event.target.value)} />
          <Button disabled={tracks.length === 0} onClick={onClear}>{t("selection.clear")}</Button>
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
        indeterminate={progress.status === "running" && progress.total === 0}
        status={progress.status === "failed" ? "exception" : progress.status === "completed" ? "success" : "active"}
        className="side-progress"
      />
    </div>
  );
}
