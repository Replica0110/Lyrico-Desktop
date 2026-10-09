import { FolderAddOutlined, SearchOutlined } from "@ant-design/icons";
import { Button, Input } from "antd";
import { memo, useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AudioTrack } from "../app/types";
import { EmptyState } from "../components/EmptyState";
import { LibrarySelectionToolbar } from "../components/LibrarySelectionToolbar";
import { LibraryTable } from "../components/LibraryTable";
import { PageHeader } from "../components/PageHeader";
import { SortSelect } from "../components/SortSelect";
import { trackSortFields, type SortState, type TrackSortField } from "../domain/sort";

export const SongsPage = memo(function SongsPage({
  tracks,
  query,
  selectedPaths,
  loading,
  onChangeQuery,
  onChangeSelectedPaths,
  onOpenDetails,
  onOpenBatch,
  onAddFolders,
}: {
  tracks: AudioTrack[];
  query: string;
  selectedPaths: string[];
  loading: boolean;
  onChangeQuery: (query: string) => void;
  onChangeSelectedPaths: (paths: string[]) => void;
  onOpenDetails: (path?: string) => void;
  onOpenBatch: () => void;
  onAddFolders: () => void;
}) {
  const { t } = useTranslation();
  const [sort, setSort] = useState<SortState<TrackSortField>>();
  const handleOpenTrack = useCallback((track: AudioTrack) => onOpenDetails(track.path), [onOpenDetails]);
  const clearSelection = useCallback(() => onChangeSelectedPaths([]), [onChangeSelectedPaths]);
  const selectAll = useCallback(
    () => onChangeSelectedPaths(tracks.map((track) => track.path)),
    [onChangeSelectedPaths, tracks],
  );
  const searching = query.trim().length > 0;
  const empty = tracks.length === 0 && !loading;
  const addFolderAction = useMemo(
    () => <Button type="primary" icon={<FolderAddOutlined />} onClick={onAddFolders}>{t("folders.add")}</Button>,
    [onAddFolders, t],
  );

  return (
    <div className="page-shell">
      <PageHeader
        title={t("songs.title")}
        meta={t("common.songCount", { count: tracks.length })}
        actions={<>
          <Input
            allowClear
            className="page-search"
            prefix={<SearchOutlined />}
            placeholder={t("search.placeholder", { scope: t("search.songs") })}
            value={query}
            onChange={(event) => onChangeQuery(event.target.value)}
          />
          <SortSelect
            value={sort}
            onChange={setSort}
            fields={trackSortFields.map((key) => ({ key, label: t(`sort.field.${key}`) }))}
          />
          {/* The empty state already offers this action; showing it twice on one screen is noise. */}
          {empty && !searching ? null : addFolderAction}
        </>}
      >
        {selectedPaths.length > 0 ? (
          <LibrarySelectionToolbar
            selectedCount={selectedPaths.length}
            onOpenBatch={onOpenBatch}
            onClear={clearSelection}
            onSelectAll={selectAll}
          />
        ) : null}
      </PageHeader>

      <div className="page-body">
        {empty ? (
          <EmptyState
            description={searching ? t("songs.noResults") : t("songs.empty")}
            action={searching
              ? <Button onClick={() => onChangeQuery("")}>{t("songs.clearSearch")}</Button>
              : addFolderAction}
          />
        ) : (
          <LibraryTable
            tracks={tracks}
            loading={loading}
            selectedPaths={selectedPaths}
            onOpenTrack={handleOpenTrack}
            onChangeSelectedPaths={onChangeSelectedPaths}
            sort={sort}
            onSortChange={setSort}
          />
        )}
      </div>
    </div>
  );
});
