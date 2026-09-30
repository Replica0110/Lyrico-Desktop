import {
  CalculatorOutlined,
  DeleteOutlined,
  EditOutlined,
  ExportOutlined,
  FileTextOutlined,
  FolderOpenOutlined,
  FormOutlined,
  SettingOutlined,
  TagsOutlined,
} from "@ant-design/icons";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { App, Button, Card, Checkbox, Input, InputNumber, Modal, Popconfirm, Progress, Rate, Select, Space, Table, Tag, Tooltip, Typography, type TableColumnsType } from "antd";
import { useEffect, useMemo, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { useTranslation } from "react-i18next";
import type { AudioTrack, BatchTask, CharacterMappingRule, DesktopSettings, RenamePreview, SourcePlugin } from "../app/types";
import { cancelBatchTask, createBatchTask, deleteBatchTasks, loadBatchTasks, pickPaths, previewBatchRename, readImageFile, retryFailedBatchItems, startBatchTask } from "../backend/audioApi";
import { TrackArtwork } from "../components/TrackArtwork";
import { LYRIC_FORMATS, type LyricFormat } from "../backend/lyricsApi";
import { clearFinishedTask, currentActiveTask, isActiveTask, mergeBatchTaskSnapshot } from "../domain/batchTasks";
import { buildMatchTargetModes, type BatchMatchMode } from "../domain/batchMatch";
import { parseTimeValue } from "../utils/format";

const { Title, Text } = Typography;

type GainRow = {
  path: string;
  title: string;
  album: string;
  trackGain: string;
  trackPeak: string;
  albumGain: string;
  albumPeak: string;
  status: "present" | "missing";
};

type BatchOperation = "metadata" | "matchLyrics" | "matchCover" | "edit" | "rename" | "lyrics" | "exportLyrics" | "exportCover" | "replaygain" | "delete";

type LyricsFormatConfig = {
  targetFormat?: LyricFormat;
  formatLineOrder: boolean;
  removeTagLines: boolean;
  removeEmptyLines: boolean;
};

type MetadataWriteMode = "disabled" | "supplement" | "overwrite";
type MetadataMatchConfig = {
  matchMode: BatchMatchMode;
  targetModes: Record<string, MetadataWriteMode>;
  enabledSourceOrderIds: string[];
  preferFileName: boolean;
  concurrency: number;
};

type RenameFilesConfig = {
  renameFormat: string;
  characterMappingRules: CharacterMappingRule[];
  plannedPaths: Record<string, string>;
  concurrency: number;
};

const batchEditFields = [
  ["title", "details.titleField", "text"], ["artist", "details.artist", "text"],
  ["albumArtist", "details.albumArtist", "text"], ["album", "details.album", "text"],
  ["year", "details.year", "text"], ["language", "details.language", "text"],
  ["genre", "details.genre", "text"], ["trackNumber", "details.track", "number"],
  ["discNumber", "details.disc", "number"], ["composer", "details.composer", "text"],
  ["lyricist", "details.lyricist", "text"], ["copyright", "details.copyright", "text"],
  ["comment", "details.comment", "text"], ["lyrics", "details.lyrics", "multiline"],
  ["replayGainTrackGain", "tasks.trackGain", "text"], ["replayGainTrackPeak", "tasks.trackPeak", "text"],
  ["replayGainAlbumGain", "tasks.albumGain", "text"], ["replayGainAlbumPeak", "tasks.albumPeak", "text"],
] as const;

type BatchEditField = typeof batchEditFields[number][0];
type BatchEditConfig = Partial<Record<BatchEditField, string>> & {
  rating?: number;
  ratingModified: boolean;
  coverPath?: string;
  removeCover: boolean;
  lyricsOffsetMs: number;
  concurrency: number;
};

const metadataTargets = [
  ["title", "details.titleField"], ["artist", "details.artist"], ["album", "details.album"],
  ["album_artist", "details.albumArtist"], ["genre", "details.genre"], ["date", "details.year"],
  ["track_number", "details.track"], ["disc_number", "details.disc"], ["composer", "details.composer"],
  ["lyricist", "details.lyricist"], ["comment", "details.comment"], ["lyrics", "details.lyrics"],
  ["cover_url", "details.cover"], ["language", "details.language"], ["copyright", "details.copyright"],
  ["rating", "details.rating"], ["replaygain_track_gain", "tasks.trackGain"],
  ["replaygain_track_peak", "tasks.trackPeak"], ["replaygain_album_gain", "tasks.albumGain"],
  ["replaygain_album_peak", "tasks.albumPeak"],
] as const;

const defaultTagLineKeywords = [
  "[by:", "[kana:", "[trans:", "[roma:",
  "作词：", "作词:", "作曲：", "作曲:", "编曲：", "编曲:",
  "制作人：", "制作人:", "监制：", "监制:", "混音：", "混音:",
  "录音：", "录音:", "母带：", "母带:", "和声：", "和声:",
  "配唱制作人：", "配唱制作人:", "OP：", "OP:", "SP：", "SP:",
  "出品：", "出品:", "发行：", "发行:",
];

const availableOperations = new Set<BatchOperation>(["metadata", "matchLyrics", "matchCover", "edit", "rename", "lyrics", "exportLyrics", "exportCover", "replaygain", "delete"]);

const operationIcons: Record<BatchOperation, ReactNode> = {
  metadata: <TagsOutlined />,
  matchLyrics: <FileTextOutlined />,
  matchCover: <FolderOpenOutlined />,
  edit: <EditOutlined />,
  rename: <FormOutlined />,
  lyrics: <FileTextOutlined />,
  exportLyrics: <ExportOutlined />,
  exportCover: <ExportOutlined />,
  replaygain: <CalculatorOutlined />,
  delete: <DeleteOutlined />,
};

export function TasksPage({ tracks, plugins, selectedPaths, settings, artistSeparator, onChangeSettings }: { tracks: AudioTrack[]; plugins: SourcePlugin[]; selectedPaths: string[]; settings: DesktopSettings; artistSeparator: string; onChangeSettings: (settings: DesktopSettings) => void }) {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const [operation, setOperation] = useState<BatchOperation>("replaygain");
  const [activeReplayGainTask, setActiveReplayGainTask] = useState<BatchTask>();
  const [activeEditTask, setActiveEditTask] = useState<BatchTask>();
  const [activeLyricsTask, setActiveLyricsTask] = useState<BatchTask>();
  const [activeMetadataTask, setActiveMetadataTask] = useState<BatchTask>();
  const [activeRenameTask, setActiveRenameTask] = useState<BatchTask>();
  const [activeExportLyricsTask, setActiveExportLyricsTask] = useState<BatchTask>();
  const [activeExportCoverTask, setActiveExportCoverTask] = useState<BatchTask>();
  const [activeDeleteTask, setActiveDeleteTask] = useState<BatchTask>();
  const [taskHistory, setTaskHistory] = useState<BatchTask[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const selectedSet = useMemo(() => new Set(selectedPaths), [selectedPaths]);
  const selectedTracks = useMemo(() => tracks.filter((track) => selectedSet.has(track.path)), [selectedSet, tracks]);
  const operations = ["metadata", "matchLyrics", "matchCover", "edit", "rename", "lyrics", "exportLyrics", "exportCover", "replaygain", "delete"] as BatchOperation[];
  const replayGainIsActive = isActiveTask(activeReplayGainTask);
  const editIsActive = isActiveTask(activeEditTask);
  const lyricsIsActive = isActiveTask(activeLyricsTask);
  const metadataIsActive = isActiveTask(activeMetadataTask);
  const renameIsActive = isActiveTask(activeRenameTask);
  const exportLyricsIsActive = isActiveTask(activeExportLyricsTask);
  const exportCoverIsActive = isActiveTask(activeExportCoverTask);
  const deleteIsActive = isActiveTask(activeDeleteTask);

  useEffect(() => {
    let disposed = false;
    void loadBatchTasks()
      .then((tasks) => {
        if (disposed) return;
        setTaskHistory(tasks);
        const replayGainTasks = tasks.filter((task) => task.taskType === "replayGain");
        const editTasks = tasks.filter((task) => task.taskType === "editTags");
        const lyricsTasks = tasks.filter((task) => task.taskType === "formatLyrics");
        const metadataTasks = tasks.filter((task) => task.taskType === "matchMetadata");
        const renameTasks = tasks.filter((task) => task.taskType === "renameFiles");
        const exportLyricsTasks = tasks.filter((task) => task.taskType === "exportLyrics");
        const exportCoverTasks = tasks.filter((task) => task.taskType === "exportCover");
        const deleteTasks = tasks.filter((task) => task.taskType === "deleteFiles");
        setActiveReplayGainTask(currentActiveTask(replayGainTasks));
        setActiveEditTask(currentActiveTask(editTasks));
        setActiveLyricsTask(currentActiveTask(lyricsTasks));
        setActiveMetadataTask(currentActiveTask(metadataTasks));
        setActiveRenameTask(currentActiveTask(renameTasks));
        setActiveExportLyricsTask(currentActiveTask(exportLyricsTasks));
        setActiveExportCoverTask(currentActiveTask(exportCoverTasks));
        setActiveDeleteTask(currentActiveTask(deleteTasks));
      })
      .catch((error) => message.error(String(error)));
    return () => {
      disposed = true;
    };
  }, [message]);

  useEffect(() => {
    let disposed = false;
    let unlisten: UnlistenFn | undefined;
    void listen<BatchTask>("batch-task-updated", ({ payload }) => {
      if (disposed) return;
      const updateTask = (setTask: Dispatch<SetStateAction<BatchTask | undefined>>) => {
        setTask((current) => mergeBatchTaskSnapshot(current, payload));
      };
      if (payload.taskType === "replayGain") {
        updateTask(setActiveReplayGainTask);
      } else if (payload.taskType === "editTags") {
        updateTask(setActiveEditTask);
      } else if (payload.taskType === "formatLyrics") {
        updateTask(setActiveLyricsTask);
      } else if (payload.taskType === "matchMetadata") {
        updateTask(setActiveMetadataTask);
      } else if (payload.taskType === "renameFiles") {
        updateTask(setActiveRenameTask);
      } else if (payload.taskType === "exportLyrics") {
        updateTask(setActiveExportLyricsTask);
      } else if (payload.taskType === "exportCover") {
        updateTask(setActiveExportCoverTask);
      } else if (payload.taskType === "deleteFiles") {
        updateTask(setActiveDeleteTask);
      }
      setTaskHistory((current) => {
        const index = current.findIndex((task) => task.taskId === payload.taskId);
        if (index < 0) return [payload, ...current];
        const next = current.slice();
        next[index] = mergeBatchTaskSnapshot(next[index], payload);
        return next;
      });
    }).then((dispose) => {
      if (disposed) dispose();
      else unlisten = dispose;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  function clearFinishedSnapshots() {
    const clear = (setTask: Dispatch<SetStateAction<BatchTask | undefined>>) => setTask(clearFinishedTask);
    clear(setActiveReplayGainTask);
    clear(setActiveEditTask);
    clear(setActiveLyricsTask);
    clear(setActiveMetadataTask);
    clear(setActiveRenameTask);
    clear(setActiveExportLyricsTask);
    clear(setActiveExportCoverTask);
    clear(setActiveDeleteTask);
  }

  function changeOperation(nextOperation: BatchOperation) {
    if (nextOperation === operation) return;
    clearFinishedSnapshots();
    setOperation(nextOperation);
  }

  function applyTaskSnapshot(setTask: Dispatch<SetStateAction<BatchTask | undefined>>, snapshot: BatchTask) {
    setTask((current) => mergeBatchTaskSnapshot(current, snapshot));
    setTaskHistory((current) => {
      const index = current.findIndex((task) => task.taskId === snapshot.taskId);
      if (index < 0) return [snapshot, ...current];
      const next = current.slice();
      next[index] = mergeBatchTaskSnapshot(next[index], snapshot);
      return next;
    });
  }

  async function refreshTaskHistory() {
    const tasks = await loadBatchTasks();
    setTaskHistory(tasks);
  }

  async function retryTask(task: BatchTask) {
    try {
      await retryFailedBatchItems(task.taskId);
      await refreshTaskHistory();
      message.success(t("tasks.historyRetryStarted"));
    } catch (error) {
      message.error(String(error));
    }
  }

  async function deleteTask(task: BatchTask) {
    try {
      await deleteBatchTasks([task.taskId]);
      setTaskHistory((current) => current.filter((item) => item.taskId !== task.taskId));
      message.success(t("tasks.historyDeleted"));
    } catch (error) {
      message.error(String(error));
    }
  }

  async function runReplayGain() {
    if (selectedTracks.length === 0 || replayGainIsActive) return;
    setSubmitting(true);
    try {
      const created = await createBatchTask(
        "replayGain",
        selectedTracks.map((track) => track.path),
        JSON.stringify({ concurrency: 3, mode: "track" }),
      );
      applyTaskSnapshot(setActiveReplayGainTask, created);
      const started = await startBatchTask(created.taskId);
      applyTaskSnapshot(setActiveReplayGainTask, started);
    } catch (error) {
      message.error(String(error));
    } finally {
      setSubmitting(false);
    }
  }

  async function cancelReplayGain() {
    if (!activeReplayGainTask || !replayGainIsActive) return;
    try {
      const cancelled = await cancelBatchTask(activeReplayGainTask.taskId);
      applyTaskSnapshot(setActiveReplayGainTask, cancelled);
      message.info(t("tasks.batchCancelled"));
    } catch (error) {
      message.error(String(error));
    }
  }

  async function runBatchEdit(config: BatchEditConfig) {
    if (selectedTracks.length === 0 || editIsActive) return;
    setSubmitting(true);
    try {
      const created = await createBatchTask(
        "editTags",
        selectedTracks.map((track) => track.path),
        JSON.stringify(config),
      );
      applyTaskSnapshot(setActiveEditTask, created);
      applyTaskSnapshot(setActiveEditTask, await startBatchTask(created.taskId));
    } catch (error) {
      message.error(String(error));
    } finally {
      setSubmitting(false);
    }
  }

  async function cancelBatchEdit() {
    if (!activeEditTask || !editIsActive) return;
    try {
      applyTaskSnapshot(setActiveEditTask, await cancelBatchTask(activeEditTask.taskId));
      message.info(t("tasks.batchCancelled"));
    } catch (error) {
      message.error(String(error));
    }
  }

  async function runLyricsFormat(config: LyricsFormatConfig) {
    if (selectedTracks.length === 0 || lyricsIsActive) return;
    setSubmitting(true);
    try {
      const created = await createBatchTask(
        "formatLyrics",
        selectedTracks.map((track) => track.path),
        JSON.stringify({
          ...config,
          targetFormat: config.targetFormat ?? null,
          tagLineKeywords: settings.removeTagLineKeywords.length
            ? settings.removeTagLineKeywords
            : defaultTagLineKeywords,
          concurrency: 3,
        }),
      );
      applyTaskSnapshot(setActiveLyricsTask, created);
      const started = await startBatchTask(created.taskId);
      applyTaskSnapshot(setActiveLyricsTask, started);
    } catch (error) {
      message.error(String(error));
    } finally {
      setSubmitting(false);
    }
  }

  async function cancelLyricsFormat() {
    if (!activeLyricsTask || !lyricsIsActive) return;
    try {
      const cancelled = await cancelBatchTask(activeLyricsTask.taskId);
      applyTaskSnapshot(setActiveLyricsTask, cancelled);
      message.info(t("tasks.batchCancelled"));
    } catch (error) {
      message.error(String(error));
    }
  }

  async function runMetadataMatch(config: MetadataMatchConfig) {
    if (selectedTracks.length === 0 || metadataIsActive) return;
    setSubmitting(true);
    try {
      const created = await createBatchTask(
        "matchMetadata",
        selectedTracks.map((track) => track.path),
        JSON.stringify({
          ...config,
          separator: artistSeparator,
          lyricFormat: settings.lyricFormat,
          showTranslation: settings.showTranslation,
          showRomanization: settings.showRomanization,
           onlyTranslationIfAvailable: settings.onlyTranslationIfAvailable,
           removeEmptyLyricLines: settings.removeEmptyLyricLines,
           lyricLineOrder: settings.lyricLineOrder,
           removeTagLineKeywords: settings.removeTagLineKeywords,
           lyricsConversionMode: settings.lyricsConversionMode,
        }),
      );
      applyTaskSnapshot(setActiveMetadataTask, created);
      applyTaskSnapshot(setActiveMetadataTask, await startBatchTask(created.taskId));
    } catch (error) {
      message.error(String(error));
    } finally {
      setSubmitting(false);
    }
  }

  async function cancelMetadataMatch() {
    if (!activeMetadataTask || !metadataIsActive) return;
    try {
      applyTaskSnapshot(setActiveMetadataTask, await cancelBatchTask(activeMetadataTask.taskId));
      message.info(t("tasks.batchCancelled"));
    } catch (error) {
      message.error(String(error));
    }
  }

  async function runRenameFiles(config: RenameFilesConfig) {
    if (selectedTracks.length === 0 || renameIsActive) return;
    setSubmitting(true);
    try {
      const created = await createBatchTask(
        "renameFiles",
        selectedTracks.map((track) => track.path),
        JSON.stringify(config),
      );
      applyTaskSnapshot(setActiveRenameTask, created);
      applyTaskSnapshot(setActiveRenameTask, await startBatchTask(created.taskId));
    } catch (error) {
      message.error(String(error));
    } finally {
      setSubmitting(false);
    }
  }

  async function cancelRenameFiles() {
    if (!activeRenameTask || !renameIsActive) return;
    try {
      applyTaskSnapshot(setActiveRenameTask, await cancelBatchTask(activeRenameTask.taskId));
      message.info(t("tasks.batchCancelled"));
    } catch (error) {
      message.error(String(error));
    }
  }

  async function runBatchExport(taskType: "exportLyrics" | "exportCover", destinationDirectory: string, concurrency: number) {
    const active = taskType === "exportLyrics" ? exportLyricsIsActive : exportCoverIsActive;
    if (selectedTracks.length === 0 || active || !destinationDirectory) return;
    setSubmitting(true);
    try {
      const created = await createBatchTask(
        taskType,
        selectedTracks.map((track) => track.path),
        JSON.stringify({ destinationDirectory, concurrency }),
      );
      if (taskType === "exportLyrics") applyTaskSnapshot(setActiveExportLyricsTask, created);
      else applyTaskSnapshot(setActiveExportCoverTask, created);
      const started = await startBatchTask(created.taskId);
      if (taskType === "exportLyrics") applyTaskSnapshot(setActiveExportLyricsTask, started);
      else applyTaskSnapshot(setActiveExportCoverTask, started);
    } catch (error) {
      message.error(String(error));
    } finally {
      setSubmitting(false);
    }
  }

  async function cancelBatchExport(taskType: "exportLyrics" | "exportCover") {
    const task = taskType === "exportLyrics" ? activeExportLyricsTask : activeExportCoverTask;
    if (!task || !isActiveTask(task)) return;
    try {
      const cancelled = await cancelBatchTask(task.taskId);
      if (taskType === "exportLyrics") applyTaskSnapshot(setActiveExportLyricsTask, cancelled);
      else applyTaskSnapshot(setActiveExportCoverTask, cancelled);
      message.info(t("tasks.batchCancelled"));
    } catch (error) {
      message.error(String(error));
    }
  }

  async function runDelete() {
    if (selectedTracks.length === 0 || deleteIsActive) return;
    setSubmitting(true);
    try {
      const created = await createBatchTask("deleteFiles", selectedTracks.map((track) => track.path));
      applyTaskSnapshot(setActiveDeleteTask, created);
      applyTaskSnapshot(setActiveDeleteTask, await startBatchTask(created.taskId));
    } catch (error) {
      message.error(String(error));
    } finally {
      setSubmitting(false);
    }
  }

  async function cancelDelete() {
    if (!activeDeleteTask || !deleteIsActive) return;
    try {
      applyTaskSnapshot(setActiveDeleteTask, await cancelBatchTask(activeDeleteTask.taskId));
      message.info(t("tasks.batchCancelled"));
    } catch (error) {
      message.error(String(error));
    }
  }

  return (
    <div className="workspace page-stack tasks-view">
      <header className="batch-page-header">
        <Title level={2}>{t("tasks.title")}</Title>
        <Text strong>{t("selection.count", { count: selectedTracks.length })}</Text>
      </header>

      <div className="batch-action-bar" role="toolbar" aria-label={t("tasks.chooseOperation")}>
        {operations.map((key) => {
          const available = availableOperations.has(key);
          const button = (
            <Button
              key={key}
              type={operation === key ? "primary" : "text"}
              icon={operationIcons[key]}
              disabled={!available}
              onClick={() => changeOperation(key)}
            >
              {t(`tasks.operations.${key}`)}
            </Button>
          );
          return available ? button : <Tooltip key={key} title={t("tasks.unavailable")}>{button}</Tooltip>;
        })}
      </div>

      {operation === "metadata" || operation === "matchLyrics" || operation === "matchCover" ? (
        <MetadataMatchPanel
          key={operation}
          tracks={selectedTracks}
          plugins={plugins}
          matchMode={operation === "metadata" ? "metadata" : operation === "matchLyrics" ? "lyrics" : "cover"}
          task={activeMetadataTask}
          submitting={submitting}
          onRun={runMetadataMatch}
          onCancel={cancelMetadataMatch}
        />
      ) : operation === "edit" ? (
        <EditTagsPanel
          tracks={selectedTracks}
          task={activeEditTask}
          submitting={submitting}
          onRun={runBatchEdit}
          onCancel={cancelBatchEdit}
        />
      ) : operation === "rename" ? (
        <RenameFilesPanel
          tracks={selectedTracks}
          task={activeRenameTask}
          submitting={submitting}
          onRun={runRenameFiles}
          onCancel={cancelRenameFiles}
          characterMappings={settings.renameCharacterMappings}
          onChangeCharacterMappings={(renameCharacterMappings) => onChangeSettings({ ...settings, renameCharacterMappings })}
        />
      ) : operation === "lyrics" ? (
        <LyricsFormatPanel
          tracks={selectedTracks}
          task={activeLyricsTask}
          submitting={submitting}
          onRun={runLyricsFormat}
          onCancel={cancelLyricsFormat}
        />
      ) : operation === "exportLyrics" ? (
        <ExportPanel
          exportType="exportLyrics"
          tracks={selectedTracks}
          task={activeExportLyricsTask}
          submitting={submitting}
          onRun={(destinationDirectory, concurrency) => runBatchExport("exportLyrics", destinationDirectory, concurrency)}
          onCancel={() => cancelBatchExport("exportLyrics")}
        />
      ) : operation === "exportCover" ? (
        <ExportPanel
          exportType="exportCover"
          tracks={selectedTracks}
          task={activeExportCoverTask}
          submitting={submitting}
          onRun={(destinationDirectory, concurrency) => runBatchExport("exportCover", destinationDirectory, concurrency)}
          onCancel={() => cancelBatchExport("exportCover")}
        />
      ) : operation === "delete" ? (
        <DeleteFilesPanel
          tracks={selectedTracks}
          task={activeDeleteTask}
          submitting={submitting}
          onRun={runDelete}
          onCancel={cancelDelete}
        />
      ) : (
        <ReplayGainTagsPanel
          tracks={selectedTracks}
          task={activeReplayGainTask}
          submitting={submitting}
          onRun={runReplayGain}
          onCancel={cancelReplayGain}
        />
      )}
      <TaskHistory
        tasks={taskHistory}
        onRefresh={() => void refreshTaskHistory()}
        onRetry={(task) => void retryTask(task)}
        onDelete={(task) => void deleteTask(task)}
      />
    </div>
  );
}

function TaskHistory({
  tasks,
  onRefresh,
  onRetry,
  onDelete,
}: {
  tasks: BatchTask[];
  onRefresh: () => void;
  onRetry: (task: BatchTask) => void;
  onDelete: (task: BatchTask) => void;
}) {
  const { t } = useTranslation();
  const columns: TableColumnsType<BatchTask> = [
    { title: t("tasks.historyType"), dataIndex: "taskType", width: 150 },
    {
      title: t("tasks.historyStatus"),
      dataIndex: "status",
      width: 110,
      sorter: (left, right) => left.status.localeCompare(right.status),
    },
    {
      title: t("tasks.historyProgress"),
      key: "progress",
      width: 220,
      render: (_, task) => t("tasks.taskSummary", {
        current: task.current,
        total: task.total,
        success: task.successCount,
        skipped: task.skippedCount,
        failed: task.failureCount,
      }),
    },
    {
      title: t("tasks.historyCreated"),
      dataIndex: "createdAt",
      width: 180,
      sorter: (left, right) => parseTimeValue(left.createdAt) - parseTimeValue(right.createdAt),
    },
    {
      title: t("tasks.historyActions"),
      key: "actions",
      width: 170,
      render: (_, task) => (
        <Space>
          {task.failureCount > 0 && !isActiveTask(task) ? (
            <Button size="small" onClick={() => onRetry(task)}>{t("tasks.historyRetry")}</Button>
          ) : null}
          {!isActiveTask(task) ? (
            <Popconfirm title={t("tasks.historyDeleteConfirm")} onConfirm={() => onDelete(task)}>
              <Button size="small" danger>{t("common.delete")}</Button>
            </Popconfirm>
          ) : null}
        </Space>
      ),
    },
  ];
  return (
    <Card
      className="content-card task-history-card"
      title={t("tasks.historyTitle")}
      extra={<Button size="small" onClick={onRefresh}>{t("tasks.historyRefresh")}</Button>}
      styles={{ body: { padding: 0 } }}
    >
      <Table
        rowKey="taskId"
        size="small"
        pagination={{ pageSize: 8, hideOnSinglePage: true }}
        columns={columns}
        dataSource={tasks}
        locale={{ emptyText: t("tasks.historyEmpty") }}
        scroll={{ x: 820 }}
      />
    </Card>
  );
}

function DeleteFilesPanel({
  tracks,
  task,
  submitting,
  onRun,
  onCancel,
}: {
  tracks: AudioTrack[];
  task?: BatchTask;
  submitting: boolean;
  onRun: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const columns: TableColumnsType<AudioTrack> = [
    {
      title: t("table.track"),
      dataIndex: "title",
      render: (_, track) => (
        <Space size={12}>
          <TrackArtwork track={track} size={38} />
          <div className="track-title-cell">
            <Text strong>{track.title || track.fileName}</Text>
            <Text type="secondary">{track.artist || t("common.unknownArtist")}</Text>
          </div>
        </Space>
      ),
    },
    { title: t("tasks.fileName"), dataIndex: "fileName", ellipsis: true },
  ];
  return (
    <section className="batch-panel">
      <Text type="danger">{t("tasks.deleteWarning")}</Text>
      <Table className="batch-table" rowKey="path" columns={columns} dataSource={tracks} size="middle" pagination={{ pageSize: 20, showSizeChanger: false, hideOnSinglePage: true }} scroll={{ x: 720 }} />
      <footer className="batch-panel-footer">
        {task && <BatchTaskProgress task={task} />}
        {isActiveTask(task) ? (
          <Button danger onClick={onCancel}>{t("common.cancel")}</Button>
        ) : (
          <Popconfirm title={t("tasks.deleteConfirm")} onConfirm={onRun} okButtonProps={{ danger: true }}>
            <Button danger type="primary" icon={<DeleteOutlined />} loading={submitting} disabled={tracks.length === 0}>
              {t("tasks.startDelete")}
            </Button>
          </Popconfirm>
        )}
      </footer>
    </section>
  );
}

function MetadataMatchPanel({ tracks, plugins, matchMode, task, submitting, onRun, onCancel }: { tracks: AudioTrack[]; plugins: SourcePlugin[]; matchMode: BatchMatchMode; task?: BatchTask; submitting: boolean; onRun: (config: MetadataMatchConfig) => void; onCancel: () => void }) {
  const { t } = useTranslation();
  const availableSources = useMemo(() => plugins.filter((plugin) => plugin.enabled && plugin.capabilities.includes("searchSongs")), [plugins]);
  const [enabledSources, setEnabledSources] = useState<string[]>(availableSources.map((plugin) => plugin.id));
  const [targetModes, setTargetModes] = useState<Record<string, MetadataWriteMode>>(() => buildMatchTargetModes(matchMode));
  const [preferFileName, setPreferFileName] = useState(false);
  const [concurrency, setConcurrency] = useState(3);
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    setTargetModes(buildMatchTargetModes(matchMode));
  }, [matchMode]);

  useEffect(() => {
    const sourceIds = availableSources.map((plugin) => plugin.id);
    setEnabledSources((current) => {
      const retained = current.filter((id) => sourceIds.includes(id));
      return retained.length > 0 || sourceIds.length === 0 ? retained : sourceIds;
    });
  }, [availableSources]);

  const columns: TableColumnsType<AudioTrack> = [
    {
      title: t("table.track"),
      dataIndex: "title",
      render: (_, track) => (
        <Space size={12}>
          <TrackArtwork track={track} size={38} />
          <div className="track-title-cell">
            <Text strong>{track.title || track.fileName}</Text>
            <Text type="secondary">{track.artist || t("common.unknownArtist")}</Text>
          </div>
        </Space>
      ),
    },
    {
      title: t("table.album"),
      dataIndex: "album",
      width: 260,
      render: (album: string) => album || t("common.unknownAlbum"),
    },
    {
      title: t("details.year"),
      dataIndex: "year",
      width: 100,
      render: (year: string) => year || "-",
    },
  ];

  return (
    <section className="batch-panel">
      <div className="batch-panel-toolbar">
        <Checkbox.Group value={enabledSources} onChange={(values) => setEnabledSources(values.map(String))}>
          <Space wrap>
            {availableSources.map((source) => (
              <Checkbox key={source.id} value={source.id}>{source.name}</Checkbox>
            ))}
          </Space>
        </Checkbox.Group>
        {availableSources.length === 0 && <Text type="secondary">{t("tasks.noSources")}</Text>}
        <Space wrap>
          <Checkbox checked={preferFileName} onChange={(event) => {
            const checked = event.target.checked;
            setPreferFileName(checked);
            if (checked) setTargetModes((current) => ({ ...current, title: current.title === "disabled" ? "disabled" : "overwrite", artist: current.artist === "disabled" ? "disabled" : "overwrite" }));
          }}>{t("tasks.preferFileName")}</Checkbox>
          <Select value={concurrency} onChange={setConcurrency} style={{ width: 130 }} options={[1, 2, 3, 4, 5].map((value) => ({ value, label: t("tasks.concurrency", { count: value }) }))} />
          <Button onClick={() => setSettingsOpen(true)}>{t("tasks.matchFields")}</Button>
        </Space>
      </div>
      <Table
        className="batch-table"
        rowKey="path"
        columns={columns}
        dataSource={tracks}
        size="middle"
        pagination={{ pageSize: 20, showSizeChanger: false, hideOnSinglePage: true }}
        scroll={{ x: 720 }}
      />
      <footer className="batch-panel-footer">
        {task && <BatchTaskProgress task={task} />}
        {isActiveTask(task) ? (
          <Button danger onClick={onCancel}>{t("common.cancel")}</Button>
        ) : (
          <Button
            type="primary"
            icon={<TagsOutlined />}
            loading={submitting}
            disabled={tracks.length === 0 || enabledSources.length === 0 || Object.values(targetModes).every((mode) => mode === "disabled")}
            onClick={() => onRun({ matchMode, targetModes, enabledSourceOrderIds: enabledSources, preferFileName, concurrency })}
          >
            {t(matchMode === "lyrics" ? "tasks.startLyricsMatch" : matchMode === "cover" ? "tasks.startCoverMatch" : "tasks.startMetadataMatch")}
          </Button>
        )}
      </footer>
      <Modal title={t("tasks.matchFields")} open={settingsOpen} onCancel={() => setSettingsOpen(false)} onOk={() => setSettingsOpen(false)} destroyOnHidden>
        <Table
          rowKey="key"
          size="small"
          pagination={false}
          scroll={{ y: 420 }}
          dataSource={metadataTargets.map(([key, label]) => ({ key, label: t(label) }))}
          columns={[
            { title: t("tasks.tag"), dataIndex: "label" },
            {
              title: t("tasks.writeMode"),
              width: 180,
              render: (_, row: { key: string }) => (
                <Select
                  value={targetModes[row.key] ?? "disabled"}
                  style={{ width: "100%" }}
                  onChange={(mode) => setTargetModes((current) => ({ ...current, [row.key]: mode }))}
                  options={[
                    { value: "disabled", label: t("common.disabled") },
                    { value: "supplement", label: t("details.supplement") },
                    { value: "overwrite", label: t("details.overwrite") },
                  ]}
                />
              ),
            },
          ]}
        />
      </Modal>
    </section>
  );
}

function EditTagsPanel({ tracks, task, submitting, onRun, onCancel }: { tracks: AudioTrack[]; task?: BatchTask; submitting: boolean; onRun: (config: BatchEditConfig) => void; onCancel: () => void }) {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [enabledFields, setEnabledFields] = useState<BatchEditField[]>([]);
  const [values, setValues] = useState<Record<BatchEditField, string>>(() => Object.fromEntries(batchEditFields.map(([key]) => [key, ""])) as Record<BatchEditField, string>);
  const [ratingModified, setRatingModified] = useState(false);
  const [rating, setRating] = useState(0);
  const [coverPath, setCoverPath] = useState<string>();
  const [coverPreview, setCoverPreview] = useState<string>();
  const [removeCover, setRemoveCover] = useState(false);
  const [lyricsOffsetMs, setLyricsOffsetMs] = useState(0);
  const [concurrency, setConcurrency] = useState(3);
  const enabledSet = useMemo(() => new Set(enabledFields), [enabledFields]);
  const hasOperation = enabledFields.length > 0 || ratingModified || Boolean(coverPath) || removeCover || lyricsOffsetMs !== 0;

  async function chooseBatchCover() {
    const [selected] = await pickPaths({
      multiple: false,
      title: t("cover.choose"),
      filters: [{ name: t("cover.images"), extensions: ["jpg", "jpeg", "png", "webp", "gif"] }],
    });
    if (!selected) return;
    try {
      setCoverPreview(await readImageFile(selected));
      setCoverPath(selected);
      setRemoveCover(false);
    } catch (error) {
      message.error(String(error));
    }
  }

  function run() {
    const config: BatchEditConfig = {
      rating: ratingModified && rating > 0 ? rating : undefined,
      ratingModified,
      coverPath,
      removeCover,
      lyricsOffsetMs,
      concurrency,
    };
    for (const field of enabledFields) config[field] = values[field];
    onRun(config);
  }

  function toggleField(field: BatchEditField, enabled: boolean) {
    setEnabledFields((current) => enabled ? [...new Set([...current, field])] : current.filter((candidate) => candidate !== field));
  }

  const columns: TableColumnsType<AudioTrack> = [
    {
      title: t("table.track"),
      dataIndex: "title",
      render: (_, track) => (
        <Space size={12}>
          <TrackArtwork track={track} size={38} />
          <div className="track-title-cell">
            <Text strong>{track.title || track.fileName}</Text>
            <Text type="secondary">{track.artist || t("common.unknownArtist")}</Text>
          </div>
        </Space>
      ),
    },
    { title: t("table.album"), dataIndex: "album", width: 220, render: (album: string) => album || t("common.unknownAlbum") },
    {
      title: t("tasks.editPreview"),
      width: 300,
      render: (_, track) => {
        const previews = enabledFields.map((field) => {
          const definition = batchEditFields.find(([key]) => key === field);
          const oldValue = previewTagValue(track[field]);
          return `${t(definition?.[1] ?? field)}: ${oldValue} → ${previewTagValue(values[field])}`;
        });
        if (ratingModified) previews.push(`${t("details.rating")}: ${track.rating ?? "∅"} → ${rating || "∅"}`);
        if (lyricsOffsetMs) previews.push(`${t("tasks.lyricsOffset")}: ${lyricsOffsetMs > 0 ? "+" : ""}${lyricsOffsetMs} ms`);
        if (coverPath || removeCover) previews.push(t(removeCover ? "tasks.removeCoverPreview" : "tasks.replaceCoverPreview"));
        return previews.length ? (
          <Space orientation="vertical" size={2}>
            {previews.slice(0, 4).map((preview, index) => <Text key={`${index}:${preview}`} type="secondary" ellipsis={{ tooltip: preview }}>{preview}</Text>)}
            {previews.length > 4 ? <Text type="secondary">{t("tasks.moreChanges", { count: previews.length - 4 })}</Text> : null}
          </Space>
        ) : <Text type="secondary">{t("tasks.noChanges")}</Text>;
      },
    },
  ];

  return (
    <section className="batch-panel">
      <div className="batch-panel-toolbar">
        <Space wrap>
          <Button onClick={() => setSettingsOpen(true)}>{t("tasks.editFields")}</Button>
          <Select value={concurrency} onChange={setConcurrency} style={{ width: 130 }} options={[1, 2, 3, 4, 5].map((value) => ({ value, label: t("tasks.concurrency", { count: value }) }))} />
          <Tag color={hasOperation ? "processing" : "default"}>{t("tasks.changeCount", { count: enabledFields.length + Number(ratingModified) + Number(Boolean(coverPath) || removeCover) + Number(lyricsOffsetMs !== 0) })}</Tag>
        </Space>
      </div>
      <Table className="batch-table" rowKey="path" columns={columns} dataSource={tracks} size="middle" pagination={{ pageSize: 20, showSizeChanger: false, hideOnSinglePage: true }} scroll={{ x: 900 }} />
      <footer className="batch-panel-footer">
        {task && <BatchTaskProgress task={task} />}
        {isActiveTask(task) ? (
          <Button danger onClick={onCancel}>{t("common.cancel")}</Button>
        ) : (
          <Button type="primary" icon={<EditOutlined />} loading={submitting} disabled={tracks.length === 0 || !hasOperation} onClick={run}>{t("tasks.startEditTags")}</Button>
        )}
      </footer>
      <Modal title={t("tasks.editFields")} open={settingsOpen} width={760} onCancel={() => setSettingsOpen(false)} onOk={() => setSettingsOpen(false)} destroyOnHidden>
        <Space orientation="vertical" size={12} className="full-width batch-edit-fields">
          <Text type="secondary">{t("tasks.editEmptyHint")}</Text>
          {batchEditFields.map(([field, label, inputType]) => (
            <div className="batch-edit-field" key={field}>
              <Checkbox checked={enabledSet.has(field)} onChange={(event) => toggleField(field, event.target.checked)}>{t(label)}</Checkbox>
              {inputType === "multiline" ? (
                <Input.TextArea disabled={!enabledSet.has(field)} value={values[field]} autoSize={{ minRows: 3, maxRows: 8 }} onChange={(event) => setValues((current) => ({ ...current, [field]: event.target.value }))} />
              ) : inputType === "number" ? (
                <Input type="number" min={1} step={1} disabled={!enabledSet.has(field)} value={values[field]} onChange={(event) => setValues((current) => ({ ...current, [field]: event.target.value }))} />
              ) : (
                <Input disabled={!enabledSet.has(field)} value={values[field]} onChange={(event) => setValues((current) => ({ ...current, [field]: event.target.value }))} />
              )}
            </div>
          ))}
          <div className="batch-edit-field">
            <Checkbox checked={ratingModified} onChange={(event) => setRatingModified(event.target.checked)}>{t("details.rating")}</Checkbox>
            <Rate disabled={!ratingModified} allowClear value={rating} onChange={setRating} />
          </div>
          <div className="batch-edit-field">
            <Text>{t("tasks.lyricsOffset")}</Text>
            <InputNumber className="full-width" value={lyricsOffsetMs} step={100} addonAfter="ms" onChange={(value) => setLyricsOffsetMs(Number(value ?? 0))} />
          </div>
          <div className="batch-edit-field">
            <Text>{t("details.cover")}</Text>
            <Space wrap>
              {coverPreview ? <TrackArtwork track={{ coverDataUrl: coverPreview }} size={64} showDimensions /> : null}
              <Button onClick={() => void chooseBatchCover()}>{t("cover.choose")}</Button>
              <Button danger type={removeCover ? "primary" : "default"} onClick={() => { setRemoveCover(true); setCoverPath(undefined); setCoverPreview(undefined); }}>{t("cover.remove")}</Button>
              <Button onClick={() => { setRemoveCover(false); setCoverPath(undefined); setCoverPreview(undefined); }}>{t("cover.revert")}</Button>
            </Space>
          </div>
        </Space>
      </Modal>
    </section>
  );
}

function previewTagValue(value: unknown) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text) return "∅";
  return text.length > 42 ? `${text.slice(0, 39)}…` : text;
}

const renamePresets = ["@1 - @2", "@2 - @1", "@5 - @1", "@4 - @1", "@2 - @4 - @5 - @1"];
const illegalFileCharacters = ["\\", "/", ":", "*", "?", "\"", "<", ">", "|"];
const defaultCharacterReplacements: Record<string, string> = {
  "\\": "＼", "/": "／", ":": "：", "*": "＊", "?": "？", "\"": "＂", "<": "＜", ">": "＞", "|": "｜",
};
const renameReplacementOptions = ["", "、", ",", "，", "＼", "／", "：", "＊", "？", "＂", "＜", "＞", "｜", "&"];

function defaultRenameRules(characterMappings: Record<string, string>): CharacterMappingRule[] {
  return [{
    id: "builtin-invalid-file-characters",
    name: "Invalid file characters",
    charMappings: { ...defaultCharacterReplacements, ...characterMappings },
    description: "Replace characters that are invalid in Windows file names",
    isBuiltIn: true,
    isEnabled: true,
  }];
}

function RenameFilesPanel({ tracks, task, submitting, onRun, onCancel, characterMappings, onChangeCharacterMappings }: { tracks: AudioTrack[]; task?: BatchTask; submitting: boolean; onRun: (config: RenameFilesConfig) => void; onCancel: () => void; characterMappings: Record<string, string>; onChangeCharacterMappings: (mappings: Record<string, string>) => void }) {
  const { t } = useTranslation();
  const [renameFormat, setRenameFormat] = useState("@1 - @2");
  const rules = useMemo(() => defaultRenameRules(characterMappings), [characterMappings]);
  const [previews, setPreviews] = useState<RenamePreview[]>([]);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const previewRequest = useRef(0);
  const paths = useMemo(() => tracks.map((track) => track.path), [tracks]);

  useEffect(() => {
    const requestId = ++previewRequest.current;
    if (paths.length === 0) {
      setPreviews([]);
      setPreviewError("");
      setPreviewLoading(false);
      return;
    }
    setPreviewLoading(true);
    const timer = window.setTimeout(() => {
      void previewBatchRename(paths, renameFormat, rules)
        .then((result) => {
          if (previewRequest.current !== requestId) return;
          setPreviews(result);
          setPreviewError("");
        })
        .catch((error) => {
          if (previewRequest.current !== requestId) return;
          setPreviews([]);
          setPreviewError(String(error));
        })
        .finally(() => {
          if (previewRequest.current === requestId) setPreviewLoading(false);
        });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [paths, renameFormat, rules]);

  const changedCount = previews.filter((preview) => !sameFilePath(preview.originalPath, preview.newPath)).length;
  const conflictCount = previews.filter((preview) => preview.conflict).length;
  const taskIsActive = isActiveTask(task);
  const canRun = tracks.length > 0 && previews.length === tracks.length && changedCount > 0 && !previewLoading && !previewError;

  function updateReplacement(character: string, replacement: string) {
    onChangeCharacterMappings({ ...characterMappings, [character]: replacement });
  }

  function run() {
    onRun({
      renameFormat,
      characterMappingRules: rules,
      plannedPaths: Object.fromEntries(previews.map((preview) => [preview.originalPath, preview.newPath])),
      concurrency: 3,
    });
  }

  const columns: TableColumnsType<RenamePreview> = [
    {
      title: t("tasks.originalFileName"),
      dataIndex: "originalPath",
      render: (path: string) => <Text ellipsis={{ tooltip: path }}>{fileNameFromPath(path)}</Text>,
    },
    {
      title: t("tasks.newFileName"),
      dataIndex: "newPath",
      render: (path: string, preview) => <Text strong={!sameFilePath(preview.originalPath, path)} ellipsis={{ tooltip: path }}>{fileNameFromPath(path)}</Text>,
    },
    {
      title: t("common.status"),
      width: 150,
      render: (_, preview) => preview.conflict
        ? <Tag color="warning">{t("tasks.renameConflictResolved")}</Tag>
        : sameFilePath(preview.originalPath, preview.newPath)
          ? <Tag>{t("tasks.renameUnchanged")}</Tag>
          : <Tag color="processing">{t("tasks.renameReady")}</Tag>,
    },
  ];

  return (
    <section className="batch-panel">
      <div className="batch-panel-toolbar rename-toolbar">
        <div className="rename-format-row">
          <Select
            value={renamePresets.includes(renameFormat) ? renameFormat : undefined}
            placeholder={t("tasks.renamePreset")}
            onChange={setRenameFormat}
            options={renamePresets.map((value) => ({ value, label: value }))}
          />
          <Input value={renameFormat} onChange={(event) => setRenameFormat(event.target.value)} placeholder="@1 - @2" />
          <Button icon={<SettingOutlined />} onClick={() => setSettingsOpen(true)}>{t("tasks.characterMappings")}</Button>
        </div>
        <Text type="secondary">{t("tasks.renamePlaceholderHint")}</Text>
        <Space wrap>
          <Tag color="processing">{t("tasks.renameChangeCount", { count: changedCount })}</Tag>
          {conflictCount > 0 ? <Tag color="warning">{t("tasks.renameConflictCount", { count: conflictCount })}</Tag> : null}
          {previewLoading ? <Text type="secondary">{t("tasks.generatingPreview")}</Text> : null}
          {previewError ? <Text type="danger">{previewError}</Text> : null}
        </Space>
      </div>
      <Table className="batch-table" rowKey="originalPath" columns={columns} dataSource={previews} loading={previewLoading} size="middle" pagination={previews.length > 12 ? { pageSize: 12, showSizeChanger: false } : false} scroll={{ x: 760 }} />
      <footer className="batch-panel-footer">
        {task && <BatchTaskProgress task={task} />}
        {taskIsActive ? (
          <Button danger onClick={onCancel}>{t("common.cancel")}</Button>
        ) : (
          <Button type="primary" icon={<FormOutlined />} loading={submitting} disabled={!canRun} onClick={run}>{t("tasks.startRename")}</Button>
        )}
      </footer>
      <Modal title={t("tasks.characterMappings")} open={settingsOpen} onCancel={() => setSettingsOpen(false)} onOk={() => setSettingsOpen(false)} destroyOnHidden>
        <Space orientation="vertical" size={12} className="full-width">
          <Text type="secondary">{t("tasks.characterMappingsHint")}</Text>
          <div className="rename-mapping-list">
            {illegalFileCharacters.map((character) => (
              <div className="rename-mapping-row" key={character}>
                <Text code>{character}</Text>
                <Text type="secondary">→</Text>
                <Select
                  value={rules[0]?.charMappings[character] ?? ""}
                  onChange={(value) => updateReplacement(character, value)}
                  options={renameReplacementOptions.map((value) => ({ value, label: value || t("tasks.removeCharacter") }))}
                />
              </div>
            ))}
          </div>
        </Space>
      </Modal>
    </section>
  );
}

function fileNameFromPath(path: string) {
  return path.split(/[\\/]/).pop() || path;
}

function sameFilePath(left: string, right: string) {
  return left.localeCompare(right, undefined, { sensitivity: "accent" }) === 0;
}

function LyricsFormatPanel({ tracks, task, submitting, onRun, onCancel }: { tracks: AudioTrack[]; task?: BatchTask; submitting: boolean; onRun: (config: LyricsFormatConfig) => void; onCancel: () => void }) {
  const { t } = useTranslation();
  const [targetFormat, setTargetFormat] = useState<LyricFormat>();
  const [formatLineOrder, setFormatLineOrder] = useState(true);
  const [removeTagLines, setRemoveTagLines] = useState(false);
  const [removeEmptyLines, setRemoveEmptyLines] = useState(false);
  const columns: TableColumnsType<AudioTrack> = [
    {
      title: t("table.track"),
      dataIndex: "title",
      render: (_, track) => (
        <Space size={12}>
          <TrackArtwork track={track} size={38} />
          <div className="track-title-cell">
            <Text strong>{track.title || track.fileName}</Text>
            <Text type="secondary">{track.artist || t("common.unknownArtist")}</Text>
          </div>
        </Space>
      ),
    },
    { title: t("table.album"), dataIndex: "album", width: 260, render: (album: string) => album || t("common.unknownAlbum") },
    {
      title: t("common.status"),
      width: 120,
      render: (_, track) => <Tag color={track.hasLyrics ? "success" : "default"}>{t(track.hasLyrics ? "tasks.lyricsPresent" : "tasks.lyricsMissing")}</Tag>,
    },
  ];
  const hasOperation = Boolean(targetFormat || formatLineOrder || removeTagLines || removeEmptyLines);

  return (
    <section className="batch-panel">
      <div className="batch-panel-toolbar">
        <Space wrap>
          <Select
            value={targetFormat ?? "keep"}
            style={{ width: 150 }}
            onChange={(value) => setTargetFormat(value === "keep" ? undefined : value as LyricFormat)}
            options={[
              { value: "keep", label: t("tasks.keepLyricsFormat") },
              ...LYRIC_FORMATS.map((format) => ({ value: format, label: t(`lyrics.formats.${format}`) })),
            ]}
          />
          <Checkbox checked={formatLineOrder} onChange={(event) => setFormatLineOrder(event.target.checked)}>{t("tasks.formatLineOrder")}</Checkbox>
          <Checkbox checked={removeTagLines} onChange={(event) => setRemoveTagLines(event.target.checked)}>{t("tasks.removeTagLines")}</Checkbox>
          <Checkbox checked={removeEmptyLines} onChange={(event) => setRemoveEmptyLines(event.target.checked)}>{t("lyrics.removeEmpty")}</Checkbox>
        </Space>
      </div>
      <Table className="batch-table" rowKey="path" columns={columns} dataSource={tracks} size="middle" pagination={{ pageSize: 20, showSizeChanger: false, hideOnSinglePage: true }} scroll={{ x: 720 }} />
      <footer className="batch-panel-footer">
        {task && <BatchTaskProgress task={task} />}
        {isActiveTask(task) ? (
          <Button danger onClick={onCancel}>{t("common.cancel")}</Button>
        ) : (
          <Button
            type="primary"
            icon={<FileTextOutlined />}
            loading={submitting}
            disabled={tracks.length === 0 || !hasOperation}
            onClick={() => onRun({ targetFormat, formatLineOrder, removeTagLines, removeEmptyLines })}
          >
            {t("tasks.startLyricsFormat")}
          </Button>
        )}
      </footer>
    </section>
  );
}

function ExportPanel({ exportType, tracks, task, submitting, onRun, onCancel }: {
  exportType: "exportLyrics" | "exportCover";
  tracks: AudioTrack[];
  task?: BatchTask;
  submitting: boolean;
  onRun: (destinationDirectory: string, concurrency: number) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const [destinationDirectory, setDestinationDirectory] = useState("");
  const [concurrency, setConcurrency] = useState(3);
  const exportsLyrics = exportType === "exportLyrics";

  async function chooseDestination() {
    try {
      const [selected] = await pickPaths({
        directory: true,
        multiple: false,
        title: t("tasks.chooseExportDestination"),
      });
      if (selected) setDestinationDirectory(selected);
    } catch (error) {
      message.error(String(error));
    }
  }

  const columns: TableColumnsType<AudioTrack> = [
    {
      title: t("table.track"),
      dataIndex: "title",
      render: (_, track) => (
        <Space size={12}>
          <TrackArtwork track={track} size={38} />
          <div className="track-title-cell">
            <Text strong>{track.title || track.fileName}</Text>
            <Text type="secondary">{track.artist || t("common.unknownArtist")}</Text>
          </div>
        </Space>
      ),
    },
    { title: t("tasks.fileName"), dataIndex: "fileName", width: 260, ellipsis: true },
    {
      title: t("common.status"),
      width: 120,
      render: (_, track) => {
        const present = exportsLyrics ? track.hasLyrics : track.hasCover;
        return <Tag color={present ? "success" : "default"}>{t(present ? (exportsLyrics ? "tasks.lyricsPresent" : "tasks.coverPresent") : (exportsLyrics ? "tasks.lyricsMissing" : "tasks.coverMissing"))}</Tag>;
      },
    },
  ];

  return (
    <section className="batch-panel">
      <div className="batch-panel-toolbar">
        <Space orientation="vertical" size={8} className="full-width">
          <Space.Compact className="full-width">
            <Input value={destinationDirectory} readOnly placeholder={t("tasks.exportDestinationPlaceholder")} />
            <Button icon={<FolderOpenOutlined />} onClick={chooseDestination}>{t("tasks.browse")}</Button>
          </Space.Compact>
          <Space wrap>
            <Select
              value={concurrency}
              style={{ width: 150 }}
              onChange={setConcurrency}
              options={[1, 2, 3, 4, 5].map((value) => ({ value, label: t("tasks.concurrency", { count: value }) }))}
            />
            <Text type="secondary">{t("tasks.exportConflictHint")}</Text>
          </Space>
        </Space>
      </div>
      <Table className="batch-table" rowKey="path" columns={columns} dataSource={tracks} size="middle" pagination={{ pageSize: 20, showSizeChanger: false, hideOnSinglePage: true }} scroll={{ x: 760 }} />
      <footer className="batch-panel-footer">
        {task && <BatchTaskProgress task={task} />}
        {isActiveTask(task) ? (
          <Button danger onClick={onCancel}>{t("common.cancel")}</Button>
        ) : (
          <Button
            type="primary"
            icon={<ExportOutlined />}
            loading={submitting}
            disabled={tracks.length === 0 || !destinationDirectory}
            onClick={() => onRun(destinationDirectory, concurrency)}
          >
            {t(exportsLyrics ? "tasks.startExportLyrics" : "tasks.startExportCover")}
          </Button>
        )}
      </footer>
    </section>
  );
}

function ReplayGainTagsPanel({ tracks, task, submitting, onRun, onCancel }: { tracks: AudioTrack[]; task?: BatchTask; submitting: boolean; onRun: () => void; onCancel: () => void }) {
  const { t } = useTranslation();
  const rows: GainRow[] = useMemo(() => tracks.map((track) => {
    const hasReplayGain = Boolean(
      track.replayGainTrackGain || track.replayGainTrackPeak || track.replayGainAlbumGain || track.replayGainAlbumPeak,
    );
    return {
      path: track.path,
      title: track.title || track.fileName,
      album: track.album || t("common.unknownAlbum"),
      trackGain: track.replayGainTrackGain || "-",
      trackPeak: track.replayGainTrackPeak || "-",
      albumGain: track.replayGainAlbumGain || "-",
      albumPeak: track.replayGainAlbumPeak || "-",
      status: hasReplayGain ? "present" : "missing",
    };
  }), [t, tracks]);

  const columns: TableColumnsType<GainRow> = useMemo(() => [
    { title: t("details.titleField"), dataIndex: "title" },
    { title: t("table.album"), dataIndex: "album" },
    { title: t("tasks.trackGain"), dataIndex: "trackGain", width: 130, align: "right" },
    { title: t("tasks.trackPeak"), dataIndex: "trackPeak", width: 130, align: "right" },
    { title: t("tasks.albumGain"), dataIndex: "albumGain", width: 130, align: "right" },
    { title: t("tasks.albumPeak"), dataIndex: "albumPeak", width: 130, align: "right" },
    {
      title: t("common.status"),
      dataIndex: "status",
      width: 100,
      render: (status: GainRow["status"]) => (
        <Tag color={status === "present" ? "success" : "default"}>{t(`tasks.status.${status}`)}</Tag>
      ),
    },
  ], [t]);

  const taskIsActive = task?.status === "queued" || task?.status === "running";

  return (
    <section className="batch-panel">
      <Table
        className="batch-table"
        rowKey="path"
        columns={columns}
        dataSource={rows}
        size="middle"
        pagination={{ pageSize: 20, showSizeChanger: false, hideOnSinglePage: true }}
        scroll={{ x: 920 }}
      />
      <footer className="batch-panel-footer">
        {task && <BatchTaskProgress task={task} />}
        {taskIsActive ? (
          <Button danger onClick={onCancel}>{t("common.cancel")}</Button>
        ) : (
          <Button type="primary" icon={<CalculatorOutlined />} loading={submitting} disabled={tracks.length === 0} onClick={onRun}>{t("tasks.startReplayGain")}</Button>
        )}
      </footer>
    </section>
  );
}

function BatchTaskProgress({ task }: { task: BatchTask }) {
  const { t } = useTranslation();
  return (
    <div className="batch-task-progress">
      <Progress percent={task.total ? Math.round((task.current / task.total) * 100) : 0} showInfo={false} size="small" status={task.status === "failed" ? "exception" : task.status === "succeeded" ? "success" : "active"} />
      <Text type="secondary">
        {t("tasks.taskSummary", { current: task.current, total: task.total, success: task.successCount, skipped: task.skippedCount, failed: task.failureCount })}
      </Text>
    </div>
  );
}
