import { Alert, App, Button, Modal, Select, Table, Tag, type TableProps } from "antd";
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { BatchTask, BatchTaskItem } from "../app/types";
import { loadBatchTaskItems } from "../backend/audioApi";
import { isActiveTask } from "../domain/batchTasks";
import { batchResultData, batchItemMap } from "../domain/batchPresentation";
import { EmptyState } from "./EmptyState";
import { ProgressBar } from "./ProgressBar";

export const BatchRetryContext = createContext<{ canRetry: (taskId: string) => boolean; retry: (taskId: string, itemId: string) => Promise<void> } | undefined>(undefined);

export function useBatchItems(task?: BatchTask) {
  const [snapshot, setSnapshot] = useState<{ taskId?: string; items: BatchTaskItem[]; error?: string }>({ items: [] });
  const [reload, setReload] = useState(0);
  const taskId = task?.taskId;
  const active = isActiveTask(task);
  // Retry can requeue items without changing the task id. Terminal updates must also reload.
  const revision = active ? "active" : task?.updatedAt;
  useEffect(() => {
    if (!taskId) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function refresh() {
      try {
        const items = await loadBatchTaskItems(taskId!);
        if (!disposed) setSnapshot({ taskId, items });
      } catch (error) {
        if (!disposed) setSnapshot(current => ({ taskId, items: current.taskId === taskId ? current.items : [], error: String(error) }));
      }
      if (!disposed && active) timer = setTimeout(() => void refresh(), 1000);
    }
    void refresh();
    return () => { disposed = true; clearTimeout(timer); };
  }, [taskId, active, revision, reload]);
  return {
    items: snapshot.taskId === taskId ? snapshot.items : [],
    error: snapshot.taskId === taskId ? snapshot.error : undefined,
    retry: () => setReload(value => value + 1),
  };
}

export function BatchItemResult({ item }: { item?: BatchTaskItem }) {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const retryItem = useContext(BatchRetryContext);
  const [open, setOpen] = useState(false);
  const [retrying, setRetrying] = useState(false);
  async function retry() {
    if (!item || !retryItem || retrying) return;
    setRetrying(true);
    try {
      await retryItem.retry(item.taskId, item.itemId);
      setOpen(false);
    } catch (error) { message.error(String(error)); }
    finally { setRetrying(false); }
  }
  if (!item) return <div className="batch-item-result"><span className="batch-secondary">{t("tasks.status.notRun")}</span></div>;
  const color = item.status === "failed" ? "error" : item.status === "succeeded" ? "success" : item.status === "running" ? "processing" : "default";
  return <div className="batch-item-result">
    <Button type="text" className="batch-result-button" onClick={() => setOpen(true)} aria-label={t("tasks.itemDetails", { name: item.fileName })}><Tag color={color}>{t(`tasks.status.${item.status}`)}</Tag></Button>
    {item.status === "running" && <ProgressBar percent={(item.progress ?? 0) * 100} indeterminate={!item.progress} />}
    <Modal centered zIndex={2300} open={open} title={item.fileName} onCancel={() => { if (!retrying) setOpen(false); }} footer={<>
      {item.status === "failed" && retryItem?.canRetry(item.taskId) && <Button type="primary" loading={retrying} onClick={() => void retry()}>{t("tasks.retryItem")}</Button>}
      <Button disabled={retrying} onClick={() => setOpen(false)}>{t("common.close")}</Button>
    </>}>
      <Tag color={color}>{t(`tasks.status.${item.status}`)}</Tag>
      <BatchResultDetails item={item} />
    </Modal>
  </div>;
}

export function BatchResultDetails({ item }: { item: BatchTaskItem }) {
  const { t, i18n } = useTranslation();
  const data = batchResultData(item);
  const fieldLabels: Record<string, string> = {
    title: "details.titleField", artist: "details.artist", album: "details.album", album_artist: "details.albumArtist", albumArtist: "details.albumArtist",
    genre: "details.genre", date: "details.year", year: "details.year", language: "details.language", copyright: "details.copyright",
    track_number: "details.track", trackNumber: "details.track", disc_number: "details.disc", discNumber: "details.disc",
    composer: "details.composer", lyricist: "details.lyricist", comment: "details.comment", lyrics: "details.lyrics", rating: "details.rating",
    cover: "details.cover", cover_url: "details.cover", lyricsOffset: "tasks.lyricsOffset",
    replayGainReferenceLoudness: "details.referenceLoudness",
    replayGainTrackGain: "tasks.trackGain", replaygain_track_gain: "tasks.trackGain", replayGainTrackPeak: "tasks.trackPeak", replaygain_track_peak: "tasks.trackPeak",
    replayGainAlbumGain: "tasks.albumGain", replaygain_album_gain: "tasks.albumGain", replayGainAlbumPeak: "tasks.albumPeak", replaygain_album_peak: "tasks.albumPeak",
  };
  const fields = Array.isArray(data.changedFields) ? data.changedFields.map(field => t(fieldLabels[String(field)] ?? "tasks.unknownField")).join(i18n.language.startsWith("zh") ? "、" : ", ") : undefined;
  const values: [string, unknown][] = [
    ["tasks.outputPath", data.outputPath ?? data.newPath], ["tasks.trackGain", data.trackGain], ["tasks.trackPeak", data.trackPeak],
    ["details.referenceLoudness", data.referenceLoudness], ["tasks.resultFields", fields], ["tasks.resultFormat", data.targetFormat],
  ];
  return <div className="batch-result-details">
    {item.errorMessage && <span>{item.errorMessage}</span>}
    {values.filter(([, value]) => value !== undefined && value !== null).map(([label, value]) => <span key={label}>{t(label)}: {String(value)}</span>)}
    {Array.isArray(data.warnings) && data.warnings.map((warning, index) => <span key={index}>{String(warning)}</span>)}
  </div>;
}

/** Same virtual, continuous table as the library; only the body owns scrolling. */
export function BatchTable<T extends object>(props: TableProps<T>) {
  const host = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 600, height: 200 });
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setSize({ width: element.clientWidth, height: element.clientHeight }));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const columns = useMemo(() => {
    const source = props.columns ?? [];
    const specified = source.reduce((sum, column) => sum + (typeof column.width === "number" ? column.width : 180), 0);
    // Shrink proportionally down to readable columns; larger datasets scroll horizontally.
    const factor = Math.min(1, size.width / Math.max(1, specified));
    return source.map((column, index) => ({ ...column, width: Math.max(index === 0 ? 150 : 110, (typeof column.width === "number" ? column.width : 180) * factor) }));
  }, [props.columns, size.width]);
  const width = columns.reduce((sum, column) => sum + column.width, 0);
  return <div className="batch-table-host" ref={host}>
    <Table<T> {...props} className="batch-table" columns={columns} virtual pagination={false} size="small" scroll={{ x: Math.max(size.width, width), y: Math.max(64, size.height - 40) }} />
  </div>;
}

export function BatchTrackTable<T extends { path?: string; originalPath?: string }>({ task, ...props }: TableProps<T> & { task?: BatchTask }) {
  const { t } = useTranslation();
  const { items, error, retry } = useBatchItems(task);
  const [filter, setFilter] = useState("all");
  const itemMap = useMemo(() => batchItemMap(items), [items]);
  useEffect(() => setFilter("all"), [task?.taskId]);
  const data = (props.dataSource ?? []).filter(row => filter === "all" || itemMap.get(row.path ?? row.originalPath ?? "")?.status === filter);
  return <>
    {task && <div className="batch-result-filter">
      <Select aria-label={t("tasks.resultFilter")} value={filter} onChange={setFilter} options={["all", "running", "queued", "succeeded", "skipped", "failed", "cancelled"].map(value => ({ value, label: t(value === "all" ? "tasks.allResults" : `tasks.status.${value}`) }))} />
      <span className="batch-secondary">{t("tasks.visibleCount", { count: data.length })}</span>
    </div>}
    {error && <Alert type="error" title={t("tasks.itemsLoadFailed")} description={error} action={<Button onClick={retry}>{t("tasks.historyRefresh")}</Button>} />}
    <BatchTable<T> {...props} dataSource={data} columns={[
      ...(props.columns ?? []),
      { title: t("tasks.itemResult"), key: "result", width: 150, render: (_, row) => <BatchItemResult item={itemMap.get(row.path ?? row.originalPath ?? "")} /> },
    ]} locale={{ emptyText: <EmptyState description={t(filter === "all" ? "tasks.noSelection" : "tasks.noResults")} /> }} />
  </>;
}
