import { Checkbox, ConfigProvider, Table, Tag, Typography, theme } from "antd";
import type { TableColumnsType, TableProps } from "antd";
import {
  memo,
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

const CHECKBOX_COLUMN_WIDTH = 44;
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
    return CHECKBOX_COLUMN_WIDTH + SONG_COLUMN_MIN_WIDTH + fixedWidth <= tableWidth;
  }) ?? COLUMN_PRESETS[COLUMN_PRESETS.length - 1];
  const fixedWidth = fixedKeys.reduce((total, key) => total + OPTIONAL_COLUMN_WIDTHS[key], 0);
  const songWidth = Math.max(SONG_COLUMN_MIN_WIDTH, tableWidth - CHECKBOX_COLUMN_WIDTH - fixedWidth);
  return { fixedKeys, songWidth, totalWidth: CHECKBOX_COLUMN_WIDTH + fixedWidth + songWidth };
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

/**
 * The one song table. A plain row click opens the editor; selection is data on the
 * always-present first-column checkbox (Ctrl/⌘ toggles, Shift extends). See docs/ui-layout.md section 7.
 */
export const LibraryTable = memo(function LibraryTable({ tracks, loading, selectedPaths = [], onOpenTrack, onChangeSelectedPaths, sort, onSortChange }: {
  tracks: AudioTrack[];
  loading?: boolean;
  selectedPaths?: string[];
  onOpenTrack: (track: AudioTrack) => void;
  onChangeSelectedPaths?: (paths: string[]) => void;
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

    return () => {
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
      observer?.disconnect();
    };
  }, [sortedTracks.length, loading, selectedPaths.length]);

  const selectedSet = useMemo(() => new Set(selectedPaths), [selectedPaths]);
  const trackPaths = useMemo(() => sortedTracks.map((track) => track.path), [sortedTracks]);
  const anchorRef = useRef<number | null>(null);
  const selectedPathsRef = useRef(selectedPaths);
  const sortedTracksRef = useRef(sortedTracks);
  const onChangeSelectedPathsRef = useRef(onChangeSelectedPaths);
  const onOpenTrackRef = useRef(onOpenTrack);
  selectedPathsRef.current = selectedPaths;
  sortedTracksRef.current = sortedTracks;
  onChangeSelectedPathsRef.current = onChangeSelectedPaths;
  onOpenTrackRef.current = onOpenTrack;

  const changeSelection = useCallback((next: string[], anchor: number | null) => {
    anchorRef.current = anchor;
    onChangeSelectedPathsRef.current?.(next);
  }, []);

  const toggleTrack = useCallback((track: AudioTrack, index: number) => {
    const current = selectedPathsRef.current;
    changeSelection(
      current.includes(track.path) ? current.filter((path) => path !== track.path) : [...current, track.path],
      index,
    );
  }, [changeSelection]);

  const selectRow = useCallback((event: ReactMouseEvent<HTMLElement>, track: AudioTrack, index: number) => {
    if (!onChangeSelectedPathsRef.current) {
      onOpenTrackRef.current(track);
      return;
    }
    const result = selectLibraryRow(
      sortedTracksRef.current.map((item) => item.path),
      selectedPathsRef.current,
      anchorRef.current,
      index,
      event,
    );
    changeSelection(result.selectedPaths, result.anchorIndex);
  }, [changeSelection]);

  const onRow = useCallback((track: AudioTrack, index = 0): HTMLAttributes<HTMLElement> => ({
    tabIndex: 0,
    onClick: (event) => {
      if (event.shiftKey || event.ctrlKey || event.metaKey) selectRow(event, track, index);
      else onOpenTrackRef.current(track);
    },
    onKeyDown: (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        onOpenTrackRef.current(track);
      }
    },
  }), [selectRow]);

  const allSelected = sortedTracks.length > 0 && sortedTracks.every((track) => selectedSet.has(track.path));
  const someSelected = !allSelected && sortedTracks.some((track) => selectedSet.has(track.path));

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
        key: "selection",
        title: (
          <Checkbox
            aria-label={t("selection.selectAll")}
            checked={allSelected}
            indeterminate={someSelected}
            disabled={sortedTracks.length === 0}
            onChange={() => changeSelection(allSelected ? [] : trackPaths, null)}
          />
        ),
        width: CHECKBOX_COLUMN_WIDTH,
        align: "center",
        render: (_value, track, index) => (
          <Checkbox
            aria-label={t("selection.selectRow", { name: track.title || track.fileName })}
            checked={selectedSet.has(track.path)}
            onClick={(event) => event.stopPropagation()}
            onChange={() => toggleTrack(track, index)}
          />
        ),
      },
      {
        key: "title",
        dataIndex: "title",
        title: t("table.song"),
        width: layout.songWidth,
        ...sortable("title"),
        render: (_value, track) => (
          <div className="library-song-cell">
            <TrackArtwork track={track} size={32} />
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
        render: (_value, track) => (track.format ? <Tag variant="filled" className="library-format-tag">{track.format}</Tag> : "—"),
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
  }, [t, activeSort, layout, selectedSet, toggleTrack, changeSelection, allSelected, someSelected, trackPaths, sortedTracks.length]);

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
    (track: AudioTrack) => (selectedSet.has(track.path) ? "is-selected" : ""),
    [selectedSet],
  );

  const syncedPaddingSM = rowHeight === null
    ? token.paddingSM
    : (rowHeight - Math.floor(token.fontSize * token.lineHeight) - token.lineWidth) / 2;

  return (
    <div className="library-track-list" aria-busy={loading}>
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
