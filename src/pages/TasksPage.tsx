import { enabledPluginSources } from "../data/pluginSources";
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
  UndoOutlined,
  CloseOutlined,
  SwapOutlined,
} from "@ant-design/icons";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { App, Button, Checkbox, Flex, Input, InputNumber, Modal, Rate, Select, Space, Table, Tag, Segmented, Switch, Tooltip, Typography, type TableColumnsType } from "antd";
import { createContext, useContext, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { useTranslation } from "react-i18next";
import type { AudioTrack, BatchTask, BatchTaskItem, CharacterMappingRule, DesktopSettings, RenamePreview, SourcePlugin } from "../app/types";
import { cancelBatchTask, createBatchTask, deleteBatchTasks, loadBatchTasks, loadBatchTaskItems, pickPaths, previewBatchRename, readImageFile, retryFailedBatchItems, startBatchTask } from "../backend/audioApi";
import { TrackArtwork } from "../components/TrackArtwork";
import { EmptyState } from "../components/EmptyState";
import { PageHeader } from "../components/PageHeader";
import { BatchTable, BatchTrackTable, BatchItemResult, BatchResultDetails, BatchRetryContext, useBatchItems } from "../components/BatchTable";
import { ProgressBar } from "../components/ProgressBar";
import { LYRIC_FORMATS, type LyricFormat } from "../backend/lyricsApi";
import { clearFinishedTask, currentActiveTask, isActiveTask, mergeBatchTaskSnapshot } from "../domain/batchTasks";
import { hasBatchField, batchFieldValue, taskOperationKey } from "../domain/batchPresentation";
import { buildMatchTargetModes, type BatchMatchMode } from "../domain/batchMatch";
import { formatTimeValue, parseTimeValue } from "../utils/format";
import { normalizeEditFieldOrder } from "../domain/editFieldSettings";

const { Text } = Typography;
const SelectionMismatchContext = createContext(false);

/** Text-only empty rows, matching the shared EmptyState instead of the antd illustration. */
function NoSelectedSongs() {
  const { t } = useTranslation();
  return <EmptyState description={t("tasks.noSelection")} />;
}

function NoPendingChanges() {
  const { t } = useTranslation();
  return <EmptyState description={t("tasks.noChanges")} />;
}

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
  ["replayGainReferenceLoudness", "details.referenceLoudness", "text"],
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

/** Toolbar order, grouped by what the operation does. Groups never split across lines. */
const operationGroups: BatchOperation[][] = [
  ["metadata", "matchLyrics", "matchCover"],
  ["edit", "rename"],
  ["lyrics", "exportLyrics", "exportCover"],
  ["replaygain", "delete"],
];

export function TasksPage({ tracks, plugins, selectedPaths, settings, artistSeparator, onChangeSettings, onChooseSongs }: { tracks: AudioTrack[]; plugins: SourcePlugin[]; selectedPaths: string[]; settings: DesktopSettings; artistSeparator: string; onChooseSongs: () => void; onChangeSettings: (settings: DesktopSettings) => void }) {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const [section, setSection] = useState("work");
  const [operation, setOperation] = useState<BatchOperation>("replaygain");
  const [activeReplayGainTask, setActiveReplayGainTask] = useState<BatchTask>();
  const [activeEditTask, setActiveEditTask] = useState<BatchTask>();
  const [activeLyricsTask, setActiveLyricsTask] = useState<BatchTask>();
  const [activeMetadataTask, setActiveMetadataTask] = useState<BatchTask>();
  const [activeRenameTask, setActiveRenameTask] = useState<BatchTask>();
  const [activeExportLyricsTask, setActiveExportLyricsTask] = useState<BatchTask>();
  const [activeExportCoverTask, setActiveExportCoverTask] = useState<BatchTask>();
  const [activeDeleteTask, setActiveDeleteTask] = useState<BatchTask>();
  const [taskInputs, setTaskInputs] = useState<Record<string, AudioTrack[]>>({});
  const tracksRef = useRef(tracks);
  const retryInFlight = useRef(false);
  tracksRef.current = tracks;
  const [taskHistory, setTaskHistory] = useState<BatchTask[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const selectedSet = useMemo(() => new Set(selectedPaths), [selectedPaths]);
  const selectedTracks = useMemo(() => tracks.filter((track) => selectedSet.has(track.path)), [selectedSet, tracks]);
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
        for (const task of tasks.filter(isActiveTask)) {
          void loadBatchTaskItems(task.taskId).then(items => {
            if (disposed) return;
            const paths = new Set(items.map(item => item.songPath));
            const inputs = tracksRef.current.filter(track => paths.has(track.path));
            setTaskInputs(current => current[task.taskId] ? current : { ...current, [task.taskId]: inputs });
          }).catch(error => { if (!disposed) message.error(String(error)); });
        }
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
    setTaskInputs(current => current[snapshot.taskId] ? current : { ...current, [snapshot.taskId]: selectedTracks });
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

  async function performRetry(taskId: string, itemIds?: string[]) {
    if (retryInFlight.current) throw new Error(t("tasks.retryBusy"));
    retryInFlight.current = true;
    try {
      const latest = await loadBatchTasks();
      const original = latest.find(task => task.taskId === taskId);
      if (!original || latest.some(task => task.taskType === original.taskType && isActiveTask(task))) throw new Error(t("tasks.retryBusy"));
      const failed = (await loadBatchTaskItems(taskId)).filter(item => item.status === "failed" && (!itemIds || itemIds.includes(item.itemId)));
      const paths = new Set(failed.map(item => item.songPath));
      const candidates = [...tracksRef.current, ...(taskInputs[taskId] ?? [])];
      const inputs = [...new Map(candidates.filter(track => paths.has(track.path)).map(track => [track.path, track])).values()];
      const started = await retryFailedBatchItems(taskId, itemIds);
      setTaskInputs(current => ({ ...current, [started.taskId]: inputs }));
      const setters: Record<string, Dispatch<SetStateAction<BatchTask | undefined>>> = {
        replayGain: setActiveReplayGainTask, editTags: setActiveEditTask, formatLyrics: setActiveLyricsTask,
        matchMetadata: setActiveMetadataTask, renameFiles: setActiveRenameTask, exportLyrics: setActiveExportLyricsTask,
        exportCover: setActiveExportCoverTask, deleteFiles: setActiveDeleteTask,
      };
      setters[started.taskType]?.(current => current?.taskId === started.taskId ? mergeBatchTaskSnapshot(current, started) : started);
      setTaskHistory(current => [started, ...current.filter(task => task.taskId !== started.taskId)]);
      message.success(t("tasks.historyRetryStarted"));
    } finally { retryInFlight.current = false; }
  }

  async function retryTask(task: BatchTask) {
    try { await performRetry(task.taskId); }
    catch (error) { message.error(String(error)); }
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

  function tracksForTask(task?: BatchTask) {
    const inputs = task ? taskInputs[task.taskId] : undefined;
    if (!inputs) return selectedTracks;
    const latest = new Map(tracks.map(track => [track.id, track]));
    return inputs.map(track => ({ ...(latest.get(track.id) ?? track), path: track.path }));
  }

  const operationTasks: Partial<Record<BatchOperation, BatchTask>> = { replaygain: activeReplayGainTask, edit: activeEditTask, rename: activeRenameTask, lyrics: activeLyricsTask, exportLyrics: activeExportLyricsTask, exportCover: activeExportCoverTask, delete: activeDeleteTask };
  const visibleTask = ["metadata", "matchLyrics", "matchCover"].includes(operation)
    ? activeMetadataTask && taskOperationKey(activeMetadataTask) === operation ? activeMetadataTask : undefined
    : operationTasks[operation];
  const inputIds = visibleTask ? taskInputs[visibleTask.taskId]?.map(track => track.id).sort().join("|") : undefined;
  const selectionMismatch = inputIds !== undefined && inputIds !== selectedTracks.map(track => track.id).sort().join("|");

  return (
    <div className="page-shell tasks-view">
      <PageHeader
        title={t("tasks.title")}
        meta={t("selection.count", { count: selectedTracks.length })}
        actions={<Button type={selectedTracks.length === 0 ? "primary" : "default"} onClick={() => { clearFinishedSnapshots(); onChooseSongs(); }}>{t("selection.enter")}</Button>}
      />

      <BatchRetryContext.Provider value={{ retry: (taskId, itemId) => performRetry(taskId, [itemId]), canRetry: taskId => {
        const original = taskHistory.find(task => task.taskId === taskId);
        return Boolean(original && !taskHistory.some(task => task.taskType === original.taskType && isActiveTask(task)));
      } }}>
      <div className="page-body tasks-body">
        <div className="batch-navigation">
          <Segmented aria-label={t("tasks.section")} value={section} onChange={setSection} options={[
            { value: "work", label: t("tasks.workspace") },
            { value: "history", label: t("tasks.historyTitle") },
          ]} />
          {section === "work" && <Select virtual={false} className="batch-operation-select" aria-label={t("tasks.chooseOperation")} value={operation} onChange={changeOperation}
            options={operationGroups.map((group, index) => ({ label: t(`tasks.operationGroups.${index}`), options: group.map(key => ({ value: key, label: t(`tasks.operations.${key}`), disabled: !availableOperations.has(key) })) }))} />}
        </div>
        {section === "work" && metadataIsActive && taskOperationKey(activeMetadataTask!) !== operation && ["metadata", "matchLyrics", "matchCover"].includes(operation) && <div className="batch-busy-note"><span>{t("tasks.matchBusy")}</span><Button onClick={() => changeOperation(taskOperationKey(activeMetadataTask!) as BatchOperation)}>{t("tasks.viewRunning")}</Button></div>}
        {section === "work" && selectionMismatch && <div className="batch-busy-note"><span>{t("tasks.taskSelectionSnapshot")}</span>{!isActiveTask(visibleTask) && <Button onClick={clearFinishedSnapshots}>{t("tasks.useCurrentSelection")}</Button>}</div>}
        <SelectionMismatchContext.Provider value={selectionMismatch}>
        <div className={`batch-workspace${section !== "work" ? " is-hidden" : ""}`}>
      {operation === "metadata" || operation === "matchLyrics" || operation === "matchCover" ? (
        <MetadataMatchPanel
          key={operation}
          tracks={tracksForTask(activeMetadataTask && taskOperationKey(activeMetadataTask) === operation ? activeMetadataTask : undefined)}
          plugins={plugins}
          matchMode={operation === "metadata" ? "metadata" : operation === "matchLyrics" ? "lyrics" : "cover"}
          task={activeMetadataTask && taskOperationKey(activeMetadataTask) === operation ? activeMetadataTask : undefined}
          submitting={submitting}
          blocked={metadataIsActive && taskOperationKey(activeMetadataTask!) !== operation}
          onRun={runMetadataMatch}
          onCancel={cancelMetadataMatch}
        />
      ) : operation === "edit" ? (
        <EditTagsPanel
          settings={settings}
          tracks={tracksForTask(activeEditTask)}
          task={activeEditTask}
          submitting={submitting}
          onRun={runBatchEdit}
          onCancel={cancelBatchEdit}
        />
      ) : operation === "rename" ? (
        <RenameFilesPanel
          tracks={tracksForTask(activeRenameTask)}
          task={activeRenameTask}
          submitting={submitting}
          onRun={runRenameFiles}
          onCancel={cancelRenameFiles}
          characterMappings={settings.renameCharacterMappings}
          onChangeCharacterMappings={(renameCharacterMappings) => onChangeSettings({ ...settings, renameCharacterMappings })}
        />
      ) : operation === "lyrics" ? (
        <LyricsFormatPanel
          tracks={tracksForTask(activeLyricsTask)}
          task={activeLyricsTask}
          submitting={submitting}
          onRun={runLyricsFormat}
          onCancel={cancelLyricsFormat}
        />
      ) : operation === "exportLyrics" ? (
        <ExportPanel
          exportType="exportLyrics"
          tracks={tracksForTask(activeExportLyricsTask)}
          task={activeExportLyricsTask}
          submitting={submitting}
          onRun={(destinationDirectory, concurrency) => runBatchExport("exportLyrics", destinationDirectory, concurrency)}
          onCancel={() => cancelBatchExport("exportLyrics")}
        />
      ) : operation === "exportCover" ? (
        <ExportPanel
          exportType="exportCover"
          tracks={tracksForTask(activeExportCoverTask)}
          task={activeExportCoverTask}
          submitting={submitting}
          onRun={(destinationDirectory, concurrency) => runBatchExport("exportCover", destinationDirectory, concurrency)}
          onCancel={() => cancelBatchExport("exportCover")}
        />
      ) : operation === "delete" ? (
        <DeleteFilesPanel
          tracks={tracksForTask(activeDeleteTask)}
          task={activeDeleteTask}
          submitting={submitting}
          onRun={runDelete}
          onCancel={cancelDelete}
        />
      ) : (
        <ReplayGainTagsPanel
          tracks={tracksForTask(activeReplayGainTask)}
          task={activeReplayGainTask}
          submitting={submitting}
          onRun={runReplayGain}
          onCancel={cancelReplayGain}
        />
      )}
        </div>
        </SelectionMismatchContext.Provider>
        {section === "history" && <TaskHistory
          tasks={taskHistory}
          onRefresh={() => void refreshTaskHistory()}
          onRetry={(task) => void retryTask(task)}
          onDelete={(task) => void deleteTask(task)}
        />}
      </div>
      </BatchRetryContext.Provider>
    </div>
  );
}

function TaskHistory({ tasks, onRefresh, onRetry, onDelete }: {
  tasks: BatchTask[]; onRefresh: () => void; onRetry: (task: BatchTask) => void; onDelete: (task: BatchTask) => void;
}) {
  const { t, i18n } = useTranslation();
  const { modal } = App.useApp();
  const [detailId, setDetailId] = useState<string>();
  const [status, setStatus] = useState("all");
  const detail = tasks.find(task => task.taskId === detailId);
  const columns: TableColumnsType<BatchTask> = [
    { title: t("tasks.historyType"), width: 230, sorter: (a, b) => parseTimeValue(a.createdAt) - parseTimeValue(b.createdAt), render: (_, task) => <div className="batch-history-name">
      <strong>{t(taskOperationKey(task) ? `tasks.operations.${taskOperationKey(task)}` : "tasks.unknownTask")}</strong>
      <time className="batch-secondary">{formatTimeValue(task.createdAt, i18n.language)}</time>
    </div> },
    { title: t("tasks.historyProgress"), width: 260, render: (_, task) => <BatchTaskProgress task={task} /> },
    { title: t("tasks.historyActions"), width: 180, render: (_, task) => <Space wrap size={4}>
      <Button size="small" onClick={() => setDetailId(task.taskId)}>{t("tasks.details")}</Button>
      {task.failureCount > 0 && !isActiveTask(task) && <Button size="small" onClick={() => onRetry(task)}>{t("tasks.historyRetry")}</Button>}
      {!isActiveTask(task) && <Button size="small" danger onClick={() => modal.confirm({ centered: true, zIndex: 2200, title: t("tasks.historyDeleteConfirm"), okText: t("common.delete"), cancelText: t("common.cancel"), okButtonProps: { danger: true }, onOk: () => onDelete(task) })}>{t("common.delete")}</Button>}
    </Space> },
  ];
  return <section className="batch-panel task-history">
    <div className="batch-history-toolbar">
      <Select aria-label={t("tasks.resultFilter")} value={status} onChange={setStatus} options={["all", "running", "queued", "succeeded", "failed", "cancelled"].map(value => ({ value, label: t(value === "all" ? "tasks.allTasks" : `tasks.status.${value}`) }))} />
      <Button onClick={onRefresh}>{t("tasks.historyRefresh")}</Button>
    </div>
    <BatchTable rowKey="taskId" columns={columns} dataSource={[...tasks].filter(task => status === "all" || task.status === status).sort((a, b) => parseTimeValue(b.createdAt) - parseTimeValue(a.createdAt))} locale={{ emptyText: <EmptyState description={t("tasks.historyEmpty")} /> }} />
    {detail && <TaskDetails task={detail} onClose={() => setDetailId(undefined)} onRetry={() => onRetry(detail)} />}
  </section>;
}

function TaskDetails({ task, onClose, onRetry }: { task: BatchTask; onClose: () => void; onRetry: () => void }) {
  const { t } = useTranslation();
  const { items, error, retry } = useBatchItems(task);
  const [filter, setFilter] = useState("all");
  const columns: TableColumnsType<BatchTaskItem> = [
    { title: t("tasks.fileName"), width: 240, render: (_, item) => <div className="batch-history-name"><strong>{item.fileName}</strong><span className="batch-secondary batch-result-path" title={item.songPath}>{item.songPath}</span></div> },
    { title: t("tasks.itemResult"), width: 180, render: (_, item) => <BatchItemResult item={item} /> },
    { title: t("tasks.details"), width: 280, render: (_, item) => <BatchResultDetails item={item} /> },
  ];
  return <Modal centered zIndex={2200} open title={t("tasks.details")} width={820} onCancel={onClose} footer={<Space>
    {task.failureCount > 0 && !isActiveTask(task) && <Button onClick={onRetry}>{t("tasks.historyRetry")}</Button>}
    <Button onClick={onClose}>{t("common.close")}</Button>
  </Space>} className="batch-details-modal">
    <BatchTaskProgress task={task} />
    {task.errorMessage && <Text type="danger">{task.errorMessage}</Text>}
    <div className="batch-result-filter">
      <Select aria-label={t("tasks.resultFilter")} value={filter} onChange={setFilter} options={["all", "succeeded", "failed", "skipped", "running", "queued", "cancelled"].map(value => ({ value, label: t(value === "all" ? "tasks.allResults" : `tasks.status.${value}`) }))} />
      <Button onClick={retry}>{t("tasks.historyRefresh")}</Button>
    </div>
    {error && <Text type="danger">{t("tasks.itemsLoadFailed")}: {error}</Text>}
    <div className="batch-details-list"><BatchTable rowKey="itemId" columns={columns} dataSource={items.filter(item => filter === "all" || item.status === filter)} locale={{ emptyText: <EmptyState description={t("tasks.noResults")} /> }} /></div>
  </Modal>;
}

function FieldPresence({ track, fields }: { track: AudioTrack; fields: { field: string; label: string }[] }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const present = fields.filter(({ field }) => hasBatchField(track, field)).length;
  return <>
    {fields.length ? <Button type="text" className="batch-presence-button" onClick={() => setOpen(true)}>{t("tasks.presentCount", { count: present, total: fields.length })}</Button> : <span className="batch-secondary">{t("tasks.noFields")}</span>}
    <Modal centered zIndex={2200} title={t("tasks.fieldPresence")} open={open} onCancel={() => setOpen(false)} footer={<Button onClick={() => setOpen(false)}>{t("common.close")}</Button>}>
      <div className="batch-field-details">{fields.map(({ field, label }) => <div key={field}><span>{t(label)}</span><span className="batch-field-value">{hasBatchField(track, field) && field !== "lyrics" && field !== "cover_url" && field !== "cover" ? String(batchFieldValue(track, field) ?? "") : ""}</span><Tag color={hasBatchField(track, field) ? "success" : "default"}>{t(hasBatchField(track, field) ? "tasks.status.present" : "tasks.status.missing")}</Tag></div>)}</div>
    </Modal>
  </>;
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
  const selectionMismatch = useContext(SelectionMismatchContext);
  const { modal } = App.useApp();
  const columns: TableColumnsType<AudioTrack> = [
    {
      title: t("table.song"),
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
      <BatchTrackTable task={task} className="batch-table" rowKey="path" columns={columns} dataSource={tracks} size="middle" pagination={false} scroll={{ x: 720 }} locale={{ emptyText: <NoSelectedSongs /> }} />
      <footer className="batch-panel-footer">
        <div className="batch-delete-summary">{task ? <BatchTaskProgress task={task} /> : <Text type="danger">{t("tasks.deleteWarning")}</Text>}</div>
        {isActiveTask(task) ? (
          <Button danger onClick={onCancel}>{t("common.cancel")}</Button>
        ) : (
          <Button danger type="primary" icon={<DeleteOutlined />} loading={submitting} disabled={selectionMismatch || tracks.length === 0} onClick={() => modal.confirm({
            centered: true, zIndex: 2200, title: t("tasks.deleteConfirm"), content: t("tasks.deleteWarning"),
            okText: t("tasks.startDelete"), cancelText: t("common.cancel"),
            okButtonProps: { danger: true }, onOk: onRun,
          })}>{t("tasks.startDelete")}</Button>
        )}
      </footer>
    </section>
  );
}

function MetadataMatchPanel({ tracks, plugins, matchMode, task, submitting, blocked, onRun, onCancel }: { tracks: AudioTrack[]; plugins: SourcePlugin[]; matchMode: BatchMatchMode; task?: BatchTask; submitting: boolean; blocked: boolean; onRun: (config: MetadataMatchConfig) => void; onCancel: () => void }) {
  const { t } = useTranslation();
  const selectionMismatch = useContext(SelectionMismatchContext);
  const availableSources = useMemo(() => enabledPluginSources(plugins, matchMode === "lyrics" ? "lyrics" : matchMode === "cover" ? "covers" : "metadata").filter(plugin => plugin.capabilities.includes("searchSongs")), [plugins, matchMode]);
  const [enabledSources, setEnabledSources] = useState<string[]>(availableSources.map((plugin) => plugin.id));
  const [targetModes, setTargetModes] = useState<Record<string, MetadataWriteMode>>(() => buildMatchTargetModes(matchMode));
  const [preferFileName, setPreferFileName] = useState(false);
  const [concurrency, setConcurrency] = useState(3);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const singleTarget = matchMode === "lyrics" ? "lyrics" : matchMode === "cover" ? "cover_url" : undefined;

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
      title: t("table.song"),
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
      title: t("tasks.fieldPresence"), key: "presence", width: 280,
      render: (_, track) => singleTarget ? <Tag color={(matchMode === "lyrics" ? track.hasLyrics : track.hasCover) ? "success" : "default"}>{t(matchMode === "lyrics" ? track.hasLyrics ? "tasks.lyricsPresent" : "tasks.lyricsMissing" : track.hasCover ? "tasks.coverPresent" : "tasks.coverMissing")}</Tag> : <FieldPresence track={track} fields={metadataTargets.filter(([field]) => targetModes[field] !== "disabled").map(([field, label]) => ({ field, label }))} />,
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
          {singleTarget ? <label className="batch-overwrite-control"><span>{t(matchMode === "lyrics" ? "tasks.overwriteLyrics" : "tasks.overwriteCover")}</span><Switch aria-label={t(matchMode === "lyrics" ? "tasks.overwriteLyrics" : "tasks.overwriteCover")} checked={targetModes[singleTarget] === "overwrite"} disabled={isActiveTask(task) || blocked} onChange={checked => setTargetModes(current => ({ ...current, [singleTarget]: checked ? "overwrite" : "supplement" }))} /></label> : <Button onClick={() => setSettingsOpen(true)}>{t("tasks.matchFields")}</Button>}
        </Space>
      </div>
      <BatchTrackTable task={task}
        className="batch-table"
        rowKey="path"
        columns={columns}
        dataSource={tracks}
        size="middle"
        pagination={false}
        scroll={{ x: 720 }}
        locale={{ emptyText: <NoSelectedSongs /> }}
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
            disabled={selectionMismatch || blocked || tracks.length === 0 || enabledSources.length === 0 || Object.values(targetModes).every((mode) => mode === "disabled")}
            onClick={() => onRun({ matchMode, targetModes, enabledSourceOrderIds: enabledSources, preferFileName, concurrency })}
          >
            {t(matchMode === "lyrics" ? "tasks.startLyricsMatch" : matchMode === "cover" ? "tasks.startCoverMatch" : "tasks.startMetadataMatch")}
          </Button>
        )}
      </footer>
      {!singleTarget && <Modal centered zIndex={2200} title={t("tasks.matchFields")} open={settingsOpen} onCancel={() => setSettingsOpen(false)} onOk={() => setSettingsOpen(false)} destroyOnHidden>
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
      </Modal>}
    </section>
  );
}

function EditTagsPanel({ tracks, settings, task, submitting, onRun, onCancel }: { tracks: AudioTrack[]; settings: DesktopSettings; task?: BatchTask; submitting: boolean; onRun: (config: BatchEditConfig) => void; onCancel: () => void }) {
  const { t } = useTranslation();
  const selectionMismatch = useContext(SelectionMismatchContext);
  const { message } = App.useApp();
  const [editView, setEditView] = useState("config");
  const [enabledFields, setEnabledFields] = useState<BatchEditField[]>([]);
  const [values, setValues] = useState<Record<BatchEditField, string>>(() => Object.fromEntries(batchEditFields.map(([key]) => [key, ""])) as Record<BatchEditField, string>);
  const [ratingModified, setRatingModified] = useState(false);
  const [rating, setRating] = useState(0);
  const [coverPath, setCoverPath] = useState<string>();
  const [coverPreview, setCoverPreview] = useState<string>();
  const [removeCover, setRemoveCover] = useState(false);
  const [lyricsOffsetMs, setLyricsOffsetMs] = useState(0);
  const [concurrency, setConcurrency] = useState(3);
  const [selectedValueField, setSelectedValueField] = useState<BatchEditField>();
  const visibleFields = normalizeEditFieldOrder(settings.editFieldOrder).flatMap(key => {
    const definition = batchEditFields.find(([field]) => field === key);
    return definition && settings.editFieldVisibility[key] !== false ? [definition] : [];
  });
  const visibleEnabledFields = enabledFields.filter(field => visibleFields.some(([key]) => key === field));
  useEffect(() => { if (isActiveTask(task)) setEditView("preview"); }, [task?.taskId, task?.status]);
  const enabledSet = useMemo(() => new Set(enabledFields), [enabledFields]);
  const hasOperation = visibleEnabledFields.length > 0 || (settings.editFieldVisibility.rating !== false && ratingModified) || Boolean(coverPath) || removeCover || lyricsOffsetMs !== 0;

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
      rating: settings.editFieldVisibility.rating !== false && ratingModified && rating > 0 ? rating : undefined,
      ratingModified: settings.editFieldVisibility.rating !== false && ratingModified,
      coverPath,
      removeCover,
      lyricsOffsetMs,
      concurrency,
    };
    for (const field of visibleEnabledFields) config[field] = values[field];
    onRun(config);
  }

  function toggleField(field: BatchEditField, enabled: boolean) {
    setEnabledFields((current) => enabled ? [...new Set([...current, field])] : current.filter((candidate) => candidate !== field));
  }

  function changeField(field: BatchEditField, value: string) {
    toggleField(field, value !== "<keep>");
    setValues(current => ({ ...current, [field]: value }));
  }

  const selectedValues = selectedValueField ? [...new Set(tracks.map(track => String(batchFieldValue(track, selectedValueField) ?? "")).filter(value => value.trim()))] : [];

  const columns: TableColumnsType<AudioTrack> = [
    {
      title: t("table.song"),
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
    { title: t("tasks.fieldPresence"), key: "presence", width: 240, render: (_, track) => <FieldPresence track={track} fields={[...visibleEnabledFields.map(field => ({ field, label: batchEditFields.find(([key]) => key === field)![1] })), ...(ratingModified ? [{ field: "rating", label: "details.rating" }] : []), ...(coverPath || removeCover ? [{ field: "cover", label: "details.cover" }] : []), ...(lyricsOffsetMs && !visibleEnabledFields.includes("lyrics") ? [{ field: "lyrics", label: "details.lyrics" }] : [])]} /> },
    {
      title: t("tasks.editPreview"),
      width: 300,
      render: (_, track) => {
        const previews = visibleEnabledFields.map((field) => {
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
          <Segmented aria-label={t("tasks.editView")} value={editView} onChange={setEditView} options={[{ value: "config", label: t("tasks.editConfig") }, { value: "preview", label: t("tasks.editPreview") }]} />
          <Select value={concurrency} onChange={setConcurrency} style={{ width: 130 }} options={[1, 2, 3, 4, 5].map((value) => ({ value, label: t("tasks.concurrency", { count: value }) }))} />
          <Tag color={hasOperation ? "processing" : "default"}>{t("tasks.changeCount", { count: visibleEnabledFields.length + Number(ratingModified) + Number(Boolean(coverPath) || removeCover) + Number(lyricsOffsetMs !== 0) })}</Tag>
        </Space>
      </div>
      <div className={`batch-edit-config${editView !== "config" ? " is-hidden" : ""}`}>
        <fieldset disabled={isActiveTask(task)} className="batch-edit-form">
        <Space orientation="vertical" size={12} className="full-width batch-edit-fields">
          <Text type="secondary">{t("tasks.editEmptyHint")}</Text>
          {visibleFields.map(([field, label, inputType]) => (
            <div className="batch-edit-field" key={field}>
              <label htmlFor={`batch-edit-${field}`} className={enabledSet.has(field) ? "batch-field-modified" : undefined}>{t(label)}{enabledSet.has(field) ? t(values[field] === "" ? "tasks.fieldWillClear" : "tasks.fieldModified") : ""}</label>
              <div className="batch-edit-input">
              {inputType === "multiline" ? (
                <Input.TextArea id={`batch-edit-${field}`} value={enabledSet.has(field) ? values[field] : "<keep>"} autoSize={{ minRows: 3 }} onChange={(event) => changeField(field, event.target.value)} />
              ) : (
                <Input id={`batch-edit-${field}`} inputMode={inputType === "number" ? "numeric" : undefined} value={enabledSet.has(field) ? values[field] : "<keep>"} onChange={(event) => changeField(field, event.target.value)} />
              )}
                <Tooltip title={t(enabledSet.has(field) ? "tasks.keepField" : "tasks.clearField")}><Button type="text" icon={enabledSet.has(field) ? <UndoOutlined /> : <CloseOutlined />} aria-label={t(enabledSet.has(field) ? "tasks.restoreField" : "tasks.clearNamedField", { name: t(label) })} onClick={() => { toggleField(field, !enabledSet.has(field)); setValues(current => ({ ...current, [field]: "" })); }} /></Tooltip>
                <Tooltip title={t("tasks.selectExistingValue")}><Button type="text" icon={<SwapOutlined />} aria-label={t("tasks.selectNamedValue", { name: t(label) })} onClick={() => setSelectedValueField(field)} /></Tooltip>
              </div>
            </div>
          ))}
          {settings.editFieldVisibility.rating !== false && <div className="batch-edit-field">
            <Text className={ratingModified ? "batch-field-modified" : undefined}>{t("details.rating")}{ratingModified ? t(rating === 0 ? "tasks.fieldWillClear" : "tasks.fieldModified") : ""}</Text>
            <Space><Rate disabled={isActiveTask(task)} allowClear value={ratingModified ? rating : 0} onChange={value => { setRatingModified(true); setRating(value); }} />{ratingModified ? <Button type="text" icon={<UndoOutlined />} onClick={() => { setRatingModified(false); setRating(0); }}>{t("cover.revert")}</Button> : <Tag>{"<keep>"}</Tag>}</Space>
          </div>}
          <div className="batch-edit-field">
            <label htmlFor="batch-lyrics-offset">{t("tasks.lyricsOffset")}</label>
            <Flex className="full-width" gap={8} align="center">
              <InputNumber id="batch-lyrics-offset" value={lyricsOffsetMs} step={100} onChange={(value) => setLyricsOffsetMs(Number(value ?? 0))} />
              <Text type="secondary">ms</Text>
            </Flex>
          </div>
          <div className="batch-edit-field">
            <Text className={coverPath || removeCover ? "batch-field-modified" : undefined}>{t("details.cover")}{coverPath || removeCover ? t(removeCover ? "tasks.fieldWillClear" : "tasks.fieldModified") : ""}</Text>
            <Space wrap>
              {coverPreview ? <TrackArtwork track={{ coverDataUrl: coverPreview }} size={64} showDimensions /> : null}
              <Button onClick={() => void chooseBatchCover()}>{t("cover.choose")}</Button>
              <Button danger type={removeCover ? "primary" : "default"} onClick={() => { setRemoveCover(true); setCoverPath(undefined); setCoverPreview(undefined); }}>{t("cover.remove")}</Button>
              <Button onClick={() => { setRemoveCover(false); setCoverPath(undefined); setCoverPreview(undefined); }}>{t("cover.revert")}</Button>
            </Space>
          </div>
        </Space>
        </fieldset>
      </div>
      <Modal open={Boolean(selectedValueField)} zIndex={2200} title={t("tasks.selectExistingValue")} onCancel={() => setSelectedValueField(undefined)} footer={null} className="batch-value-modal">
        <div className="batch-value-options">
          {selectedValues.length ? selectedValues.map(value => <Button key={value} block onClick={() => { if (selectedValueField) changeField(selectedValueField, value); setSelectedValueField(undefined); }}>{value}</Button>) : <EmptyState description={t("tasks.noExistingValues")} />}
        </div>
      </Modal>
      <div className={`batch-edit-preview${editView !== "preview" ? " is-hidden" : ""}`}><BatchTrackTable task={task} className="batch-table" rowKey="path" columns={columns} dataSource={tracks} size="middle" pagination={false} scroll={{ x: 900 }} locale={{ emptyText: <NoSelectedSongs /> }} /></div>
      <footer className="batch-panel-footer">
        {task && <BatchTaskProgress task={task} />}
        {isActiveTask(task) ? (
          <Button danger onClick={onCancel}>{t("common.cancel")}</Button>
        ) : (
          <Button type="primary" icon={<EditOutlined />} loading={submitting} disabled={selectionMismatch || tracks.length === 0 || !hasOperation} onClick={run}>{t("tasks.startEditTags")}</Button>
        )}
      </footer>

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
  const selectionMismatch = useContext(SelectionMismatchContext);
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
      <BatchTrackTable task={task} className="batch-table" rowKey="originalPath" columns={columns} dataSource={previews} loading={previewLoading} size="middle" pagination={false} scroll={{ x: 760 }} locale={{ emptyText: <NoPendingChanges /> }} />
      <footer className="batch-panel-footer">
        {task && <BatchTaskProgress task={task} />}
        {taskIsActive ? (
          <Button danger onClick={onCancel}>{t("common.cancel")}</Button>
        ) : (
          <Button type="primary" icon={<FormOutlined />} loading={submitting} disabled={selectionMismatch || !canRun} onClick={run}>{t("tasks.startRename")}</Button>
        )}
      </footer>
      <Modal centered zIndex={2200} title={t("tasks.characterMappings")} open={settingsOpen} onCancel={() => setSettingsOpen(false)} onOk={() => setSettingsOpen(false)} destroyOnHidden>
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
  const selectionMismatch = useContext(SelectionMismatchContext);
  const [targetFormat, setTargetFormat] = useState<LyricFormat>();
  const [formatLineOrder, setFormatLineOrder] = useState(true);
  const [removeTagLines, setRemoveTagLines] = useState(false);
  const [removeEmptyLines, setRemoveEmptyLines] = useState(false);
  const columns: TableColumnsType<AudioTrack> = [
    {
      title: t("table.song"),
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
      <BatchTrackTable task={task} className="batch-table" rowKey="path" columns={columns} dataSource={tracks} size="middle" pagination={false} scroll={{ x: 720 }} locale={{ emptyText: <NoSelectedSongs /> }} />
      <footer className="batch-panel-footer">
        {task && <BatchTaskProgress task={task} />}
        {isActiveTask(task) ? (
          <Button danger onClick={onCancel}>{t("common.cancel")}</Button>
        ) : (
          <Button
            type="primary"
            icon={<FileTextOutlined />}
            loading={submitting}
            disabled={selectionMismatch || tracks.length === 0 || !hasOperation}
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
  const selectionMismatch = useContext(SelectionMismatchContext);
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
      title: t("table.song"),
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
      <BatchTrackTable task={task} className="batch-table" rowKey="path" columns={columns} dataSource={tracks} size="middle" pagination={false} scroll={{ x: 760 }} locale={{ emptyText: <NoSelectedSongs /> }} />
      <footer className="batch-panel-footer">
        {task && <BatchTaskProgress task={task} />}
        {isActiveTask(task) ? (
          <Button danger onClick={onCancel}>{t("common.cancel")}</Button>
        ) : (
          <Button
            type="primary"
            icon={<ExportOutlined />}
            loading={submitting}
            disabled={selectionMismatch || tracks.length === 0 || !destinationDirectory}
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
  const selectionMismatch = useContext(SelectionMismatchContext);
  const columns: TableColumnsType<AudioTrack> = [
    { title: t("table.song"), width: 240, render: (_, track) => <div className="track-title-cell"><Text strong ellipsis={{ tooltip: track.title || track.fileName }}>{track.title || track.fileName}</Text><Text type="secondary" ellipsis>{track.artist || t("common.unknownArtist")}</Text></div> },
    { title: t("tasks.fieldPresence"), width: 180, render: (_, track) => <div className="batch-gain-summary">
      <FieldPresence track={track} fields={[
        { field: "replayGainTrackGain", label: "tasks.trackGain" }, { field: "replayGainTrackPeak", label: "tasks.trackPeak" },
        { field: "replayGainAlbumGain", label: "tasks.albumGain" }, { field: "replayGainAlbumPeak", label: "tasks.albumPeak" },
        { field: "replayGainReferenceLoudness", label: "details.referenceLoudness" },
      ]} />
      <span className="batch-secondary">{t("tasks.trackGain")}: {track.replayGainTrackGain || "—"}</span>
    </div> },
  ];

  const taskIsActive = task?.status === "queued" || task?.status === "running";

  return (
    <section className="batch-panel">
      <BatchTrackTable task={task}
        className="batch-table"
        rowKey="path"
        columns={columns}
        dataSource={tracks}
        size="middle"
        pagination={false}
        scroll={{ x: 920 }}
        locale={{ emptyText: <NoSelectedSongs /> }}
      />
      <footer className="batch-panel-footer">
        {task && <BatchTaskProgress task={task} />}
        {taskIsActive ? (
          <Button danger onClick={onCancel}>{t("common.cancel")}</Button>
        ) : (
          <Button type="primary" icon={<CalculatorOutlined />} loading={submitting} disabled={selectionMismatch || tracks.length === 0} onClick={onRun}>{t("tasks.startReplayGain")}</Button>
        )}
      </footer>
    </section>
  );
}

function BatchTaskProgress({ task }: { task: BatchTask }) {
  const { t } = useTranslation();
  return (
    <div className="batch-task-progress">
      <div className="batch-progress-heading"><span>{t(`tasks.status.${task.status}`)}</span><span>{task.current}/{task.total}</span></div>
      <ProgressBar percent={(task.progress ?? (task.total ? task.current / task.total : 0)) * 100} indeterminate={isActiveTask(task) && !task.progress && !task.current} status={task.status === "failed" ? "exception" : task.status === "succeeded" ? "success" : "active"} />
      <Text type="secondary">
        {t("tasks.resultSummary", { success: task.successCount, skipped: task.skippedCount, failed: task.failureCount })}
      </Text>
    </div>
  );
}
