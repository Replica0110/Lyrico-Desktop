import { FolderAddOutlined, SearchOutlined } from "@ant-design/icons";
import { Button, Input } from "antd";
import { memo, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { AudioTrack } from "../app/types";
import { EmptyState } from "../components/EmptyState";
import { LibraryTable } from "../components/LibraryTable";
import { LibraryRefreshButton } from "../components/LibraryRefreshButton";
import { PageHeader } from "../components/PageHeader";
import { SortSelect } from "../components/SortSelect";
import { trackSortFields, type SortState, type TrackSortField } from "../domain/sort";

export const SongsPage = memo(function SongsPage({
  tracks,
  query,
  selectedPaths,
  loading,
  sort,
  onChangeQuery,
  onChangeSelectedPaths,
  onSortChange,
  onOpenDetails,
  onAddFolders,
  onRefreshLibrary,
  canRefreshLibrary,
}: {
  tracks: AudioTrack[];
  query: string;
  selectedPaths: string[];
  loading: boolean;
  sort?: SortState<TrackSortField>;
  onChangeQuery: (query: string) => void;
  onChangeSelectedPaths: (paths: string[]) => void;
  onSortChange: (sort?: SortState<TrackSortField>) => void;
  onOpenDetails: (path?: string) => void;
  onAddFolders: () => void;
  onRefreshLibrary: () => void;
  canRefreshLibrary: boolean;
}) {
  const { t } = useTranslation();
  const handleOpenTrack = useCallback((track: AudioTrack) => onOpenDetails(track.path), [onOpenDetails]);
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
            onChange={onSortChange}
            fields={trackSortFields.map((key) => ({ key, label: t(`sort.field.${key}`) }))}
          />
          <LibraryRefreshButton disabled={!canRefreshLibrary || loading} onRefresh={onRefreshLibrary} />
          {/* The empty state already offers this action; showing it twice on one screen is noise. */}
          {empty && !searching ? null : addFolderAction}
        </>}
      />

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
            onSortChange={onSortChange}
          />
        )}
      </div>
    </div>
  );
});
