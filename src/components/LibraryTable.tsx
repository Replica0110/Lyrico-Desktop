import { CheckSquareOutlined, CloseOutlined, CloudSyncOutlined } from "@ant-design/icons";
import { Button, Checkbox, ConfigProvider, Flex, Space, Table, Tag, Typography, theme } from "antd";
import type { TableColumnsType, TableProps } from "antd";
import {
  memo,
  startTransition,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type HTMLAttributes,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { useTranslation } from "react-i18next";
import type { AudioTrack } from "../app/types";
import { selectLibraryRow } from "../domain/librarySelection";
import { sortTracksBy, type SortState, type TrackSortField } from "../domain/sort";
import { formatDuration, formatTimestamp } from "../utils/format";
import { TrackArtwork } from "./TrackArtwork";

const { Text } = Typography;

const INDEX_COLUMN_WIDTH = 56;
const SONG_COLUMN_MIN_WIDTH = 300;
const MIN_BODY_HEIGHT = 240;
const FALLBACK_BODY_HEIGHT = 480;
const FALLBACK_HEADER_HEIGHT = 47;
const FALLBACK_TABLE_WIDTH = 1280;

const OPTIONAL_COLUMN_WIDTHS = {
  album: 240,
  format: 96,
  duration: 88,
  modifiedAt: 152,
  createdAt: 152,
} as const;

type OptionalColumnKey = keyof typeof OPTIONAL_COLUMN_WIDTHS;

const COLUMN_PRESETS: readonly OptionalColumnKey[][] = [
  ["album", "format", "duration", "modifiedAt", "createdAt"],
  ["album", "format", "duration", "modifiedAt"],
  ["album", "format", "duration"],
  ["album", "duration"],
  ["duration"],
];

function resolveColumnLayout(tableWidth: number) {
  const fixedKeys = COLUMN_PRESETS.find((preset) => {
    const fixedWidth = preset.reduce((total, key) => total + OPTIONAL_COLUMN_WIDTHS[key], 0);
    return INDEX_COLUMN_WIDTH + SONG_COLUMN_MIN_WIDTH + fixedWidth <= tableWidth;
  }) ?? COLUMN_PRESETS[COLUMN_PRESETS.length - 1];
  const fixedWidth = fixedKeys.reduce((total, key) => total + OPTIONAL_COLUMN_WIDTHS[key], 0);
  const songWidth = Math.max(SONG_COLUMN_MIN_WIDTH, tableWidth - INDEX_COLUMN_WIDTH - fixedWidth);
  return { fixedKeys, songWidth, totalWidth: INDEX_COLUMN_WIDTH + fixedWidth + songWidth };
}

function findScrollParent(element: HTMLElement) {
  let parent = element.parentElement;
  while (parent) {
    const { overflow, overflowY } = window.getComputedStyle(parent);
    if (/auto|scroll|overlay/.test(`${overflow}${overflowY}`)) return parent;
    parent = parent.parentElement;
  }
  return undefined;
}

export const LibraryTable = memo(function LibraryTable({ tracks, loading, selectedPaths = [], onSelectTrack, onOpenTrack, onChangeSelectedPaths, selectionMode = false, onChangeSelectionMode, onOpenBatch, showSelectionToolbar = true, sort, onSortChange }: {
  tracks: AudioTrack[];
  loading?: boolean;
  selectedPaths?: string[];
  onSelectTrack: (path?: string) => void;
  onOpenTrack?: (track: AudioTrack) => void;
  onChangeSelectedPaths?: (paths: string[]) => void;
  selectionMode?: boolean;
  onChangeSelectionMode?: (enabled: boolean) => void;
  onOpenBatch?: () => void;
  showSelectionToolbar?: boolean;
  sort?: SortState<TrackSortField>;
  onSortChange?: (next?: SortState<TrackSortField>) => void;
}) {
  const { t } = useTranslation();
  const [internalSort, setInternalSort] = useState<SortState<TrackSortField>>();
  const activeSort = sort ?? internalSort;
  const applySort = useCallback((next?: SortState<TrackSortField>) => {
    if (sort === undefined || next === undefined) setInternalSort(next);
    onSortChange?.(next);
  }, [sort, onSortChange]);
  const sortedTracks = useMemo(
    () => (activeSort ? sortTracksBy(tracks, activeSort.key, activeSort.direction) : tracks),
    [tracks, activeSort],
  );

  const [metrics, setMetrics] = useState({ bodyHeight: FALLBACK_BODY_HEIGHT, tableWidth: FALLBACK_TABLE_WIDTH });
  const { token } = theme.useToken();
  const [rowHeight, setRowHeight] = useState<number | null>(null);
  const layout = useMemo(() => resolveColumnLayout(metrics.tableWidth), [metrics.tableWidth]);
  const hostRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);

  const showActions = showSelectionToolbar && Boolean(onChangeSelectionMode);
  const showBatchToolbar = selectionMode && showSelectionToolbar && Boolean(onChangeSelectedPaths);
  const showToolbar = showActions || showBatchToolbar;

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let frame: number | undefined;
    const measure = () => {
      frame = undefined;
      const tableWidth = Math.round(host.clientWidth);
      const rect = host.getBoundingClientRect();
      const scroller = findScrollParent(host);
      const scrollerRect = scroller?.getBoundingClientRect();
      const bottom = scrollerRect ? scrollerRect.bottom : window.innerHeight;
      let gap = 0;
      let node: HTMLElement | null = host.parentElement;
      while (node) {
        const style = window.getComputedStyle(node);
        gap += parseFloat(style.paddingBottom) || 0;
        if (node === scroller || node === document.body || node === document.documentElement) break;
        gap += parseFloat(style.marginBottom) || 0;
        node = node.parentElement;
      }
      const header = host.querySelector<HTMLElement>(".ant-table-header");
      const headerHeight = header ? header.offsetHeight : FALLBACK_HEADER_HEIGHT;
      const bodyHeight = Math.max(MIN_BODY_HEIGHT, Math.floor(bottom - rect.top - gap - headerHeight));
      setMetrics((current) => (
        current.bodyHeight === bodyHeight && current.tableWidth === tableWidth
          ? current
          : { bodyHeight, tableWidth }
      ));
      const row = host.querySelector<HTMLElement>(".ant-table-tbody-virtual-holder-inner > div");
      const nextRowHeight = row?.getBoundingClientRect().height ?? 0;
      if (nextRowHeight > 0) {
        setRowHeight((current) => (
          current === null || Math.abs(current - nextRowHeight) > 0.01 ? nextRowHeight : current
        ));
      }
    };

    const schedule = () => {
      if (frame !== undefined) return;
      frame = window.requestAnimationFrame(measure);
    };

    measure();
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(schedule);
    observer?.observe(host);
    const toolbar = toolbarRef.current;
    if (observer && toolbar) observer.observe(toolbar);

    return () => {
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
      observer?.disconnect();
    };
  }, [showToolbar, selectionMode, sortedTracks.length, loading]);

  const selectedSet = useMemo(() => new Set(selectedPaths), [selectedPaths]);
  const trackPaths = useMemo(() => sortedTracks.map((track) => track.path), [sortedTracks]);
  const anchorRef = useRef<number | null>(null);
  const selectedPathsRef = useRef(selectedPaths);
  const sortedTracksRef = useRef(sortedTracks);
  const selectionModeRef = useRef(selectionMode);
  const onSelectTrackRef = useRef(onSelectTrack);
  const onChangeSelectedPathsRef = useRef(onChangeSelectedPaths);
  const onOpenTrackRef = useRef(onOpenTrack);
  selectedPathsRef.current = selectedPaths;
  sortedTracksRef.current = sortedTracks;
  selectionModeRef.current = selectionMode;
  onSelectTrackRef.current = onSelectTrack;
  onChangeSelectedPathsRef.current = onChangeSelectedPaths;
  onOpenTrackRef.current = onOpenTrack;

  const toggleTrack = useCallback((track: AudioTrack, index: number) => {
    anchorRef.current = index;
    const changeSelectedPaths = onChangeSelectedPathsRef.current;
    if (!changeSelectedPaths) return;
    const current = selectedPathsRef.current;
    changeSelectedPaths(current.includes(track.path)
      ? current.filter((path) => path !== track.path)
      : [...current, track.path]);
  }, []);

  const selectRow = useCallback((event: ReactMouseEvent<HTMLElement>, track: AudioTrack, index: number) => {
    const extendSelection = selectionModeRef.current || event.shiftKey || event.ctrlKey || event.metaKey;
    if (!extendSelection) {
      onSelectTrackRef.current(track.path);
      onOpenTrackRef.current?.(track);
      return;
    }
    onSelectTrackRef.current(track.path);
    const changeSelectedPaths = onChangeSelectedPathsRef.current;
    if (!changeSelectedPaths) return;
    const result = selectLibraryRow(
      sortedTracksRef.current.map((item) => item.path),
      selectedPathsRef.current,
      anchorRef.current,
      index,
      selectionModeRef.current && !event.shiftKey && !event.ctrlKey && !event.metaKey
        ? { ...event, ctrlKey: true }
        : event,
    );
    anchorRef.current = result.anchorIndex;
    changeSelectedPaths(result.selectedPaths);
  }, []);

  const onRow = useCallback((track: AudioTrack, index = 0): HTMLAttributes<HTMLElement> => ({
    tabIndex: 0,
    onClick: (event) => selectRow(event, track, index),
    onDoubleClick: () => {
      if (selectionModeRef.current) onOpenTrackRef.current?.(track);
    },
    onKeyDown: (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        onOpenTrackRef.current?.(track);
      }
    },
  }), [selectRow]);

  const selectAll = useCallback(() => {
    const changeSelectedPaths = onChangeSelectedPathsRef.current;
    if (!changeSelectedPaths) return;
    startTransition(() => changeSelectedPaths(trackPaths));
  }, [trackPaths]);

  const columns = useMemo<TableColumnsType<AudioTrack>>(() => {
    const unknownArtist = t("common.unknownArtist");
    const unknownAlbum = t("common.unknownAlbum");
    const sortOrder = (key: TrackSortField): "ascend" | "descend" | null => (
      activeSort?.key === key
        ? (activeSort.direction === "asc" ? "ascend" : "descend")
        : null
    );
    const sortable = (key: TrackSortField) => ({
      sorter: true as const,
      sortOrder: sortOrder(key),
    });

    const list: TableColumnsType<AudioTrack> = [
      {
        key: "index",
        title: "#",
        width: INDEX_COLUMN_WIDTH,
        align: "center",
        render: (_value, track, index) => (selectionMode
          ? <Checkbox
              checked={selectedSet.has(track.path)}
              onClick={(event) => event.stopPropagation()}
              onChange={() => toggleTrack(track, index)}
            />
          : <Text type="secondary">{index + 1}</Text>),
      },
      {
        key: "title",
        dataIndex: "title",
        title: t("table.song"),
        width: layout.songWidth,
        ...sortable("title"),
        render: (_value, track) => (
          <div className="library-song-cell">
            <TrackArtwork track={track} size={42} />
            <div className="track-title-cell">
              <Text strong ellipsis={{ tooltip: track.title || track.fileName }}>{track.title || track.fileName}</Text>
              <Text type="secondary" ellipsis={{ tooltip: track.artist }}>{track.artist || unknownArtist}</Text>
            </div>
          </div>
        ),
      },
    ];

    if (layout.fixedKeys.includes("album")) {
      list.push({
        key: "album",
        dataIndex: "album",
        title: t("table.album"),
        width: OPTIONAL_COLUMN_WIDTHS.album,
        ellipsis: true,
        ...sortable("album"),
        render: (_value, track) => track.album || unknownAlbum,
      });
    }

    if (layout.fixedKeys.includes("format")) {
      list.push({
        key: "format",
        dataIndex: "format",
        title: t("table.format"),
        width: OPTIONAL_COLUMN_WIDTHS.format,
        align: "center",
        ...sortable("format"),
        render: (_value, track) => (track.format ? <Tag bordered={false} className="library-format-tag">{track.format}</Tag> : "—"),
      });
    }

    list.push({
      key: "duration",
      title: t("table.duration"),
      width: OPTIONAL_COLUMN_WIDTHS.duration,
      align: "right",
      ...sortable("duration"),
      render: (_value, track) => <span className="library-number-cell">{formatDuration(track.durationSeconds)}</span>,
    });

    if (layout.fixedKeys.includes("modifiedAt")) {
      list.push({
        key: "modifiedAt",
        title: t("table.modifiedAt"),
        width: OPTIONAL_COLUMN_WIDTHS.modifiedAt,
        align: "right",
        ...sortable("modifiedAt"),
        render: (_value, track) => <span className="library-number-cell">{formatTimestamp(track.modifiedAt)}</span>,
      });
    }

    if (layout.fixedKeys.includes("createdAt")) {
      list.push({
        key: "createdAt",
        title: t("table.createdAt"),
        width: OPTIONAL_COLUMN_WIDTHS.createdAt,
        align: "right",
        ...sortable("createdAt"),
        render: (_value, track) => <span className="library-number-cell">{formatTimestamp(track.createdAt)}</span>,
      });
    }

    return list;
  }, [t, activeSort, layout, selectionMode, selectedSet, toggleTrack]);

  const handleTableChange = useCallback<NonNullable<TableProps<AudioTrack>["onChange"]>>(
    (_pagination, _filters, sorter) => {
      const result = Array.isArray(sorter) ? sorter[0] : sorter;
      if (!result || !("order" in result)) return;
      if (!result.order) {
        applySort(undefined);
        return;
      }
      if (!result.columnKey) return;
      const key = result.columnKey as TrackSortField;
      applySort({ key, direction: result.order === "ascend" ? "asc" : "desc" });
    },
    [applySort],
  );

  const rowClassName = useCallback(
    (track: AudioTrack) => (selectionMode && selectedSet.has(track.path) ? "is-selected" : ""),
    [selectionMode, selectedSet],
  );

  const syncedPaddingSM = rowHeight === null
    ? token.paddingSM
    : (rowHeight - Math.floor(token.fontSize * token.lineHeight) - token.lineWidth) / 2;

  return (
    <div className="library-track-list" aria-busy={loading}>
      {showToolbar ? (
        <div className="library-sticky-bar" ref={toolbarRef}>
          {showActions ? (
            <Flex className="library-list-actions" justify="flex-end">
              {selectionMode
                ? <Button icon={<CloseOutlined />} onClick={() => onChangeSelectionMode?.(false)}>{t("selection.exit")}</Button>
                : <Button icon={<CheckSquareOutlined />} disabled={sortedTracks.length === 0} onClick={() => onChangeSelectionMode?.(true)}>{t("selection.enter")}</Button>}
            </Flex>
          ) : null}
          {showBatchToolbar ? (
            <Flex className="selection-toolbar" align="center" justify="space-between" gap={12} wrap>
              <Space>
                <Button icon={<CheckSquareOutlined />} disabled={sortedTracks.length === 0} onClick={selectAll}>{t("selection.selectAll")}</Button>
                <Button icon={<CloseOutlined />} disabled={selectedPaths.length === 0} onClick={() => onChangeSelectedPaths?.([])}>{t("selection.clear")}</Button>
                <Text type="secondary">{t("selection.hint")}</Text>
              </Space>
              <Space>
                <Text>{t("selection.count", { count: selectedPaths.length })}</Text>
                <Button type="primary" icon={<CloudSyncOutlined />} disabled={selectedPaths.length === 0} onClick={onOpenBatch}>{t("selection.batch")}</Button>
              </Space>
            </Flex>
          ) : null}
        </div>
      ) : null}

      <div className="library-table-host" ref={hostRef}>
        <ConfigProvider
          theme={{
            token: { paddingSM: syncedPaddingSM },
            components: { Table: { cellPaddingBlockMD: token.paddingSM } },
          }}
        >
          <Table
            virtual
            size="middle"
            rowKey="path"
            columns={columns}
            dataSource={sortedTracks}
            pagination={false}
            loading={loading}
            scroll={{ x: layout.totalWidth, y: metrics.bodyHeight }}
            onChange={handleTableChange}
            onRow={onRow}
            rowClassName={rowClassName}
          />
        </ConfigProvider>
      </div>
    </div>
  );
});
