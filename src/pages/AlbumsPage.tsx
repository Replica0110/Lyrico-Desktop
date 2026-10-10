import { CheckOutlined, CheckSquareOutlined, CloseOutlined, SearchOutlined } from "@ant-design/icons";
import { Button, Input, Typography } from "antd";
import { memo, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AudioTrack } from "../app/types";
import { LibraryTable } from "../components/LibraryTable";
import { PageHeader } from "../components/PageHeader";
import { SortSelect } from "../components/SortSelect";
import { SubPageBar } from "../components/SubPageBar";
import { TrackArtwork } from "../components/TrackArtwork";
import type { AlbumGroup } from "../domain/library";
import { albumSortFields, sortAlbumsBy, type AlbumSortField, type SortState } from "../domain/sort";
import { formatDuration } from "../utils/format";
import { useGoUpOnMouseBack } from "../hooks/useGoUpOnMouseBack";
import { useIncrementalGrid } from "../hooks/useIncrementalGrid";

const { Text } = Typography;

export const AlbumsPage = memo(function AlbumsPage({
  albums,
  query,
  selectedAlbumId,
  detailsOpen,
  loading,
  onChangeQuery,
  onSelectAlbum,
  onOpenTrack,
  onOpenDetails,
  onCloseDetails,
  selectedPaths,
  selectedCollectionKeys,
  onToggleCollection,
  selectionMode,
  onChangeSelectedPaths,
  onChangeSelectionMode,
}: {
  albums: AlbumGroup[];
  query: string;
  selectedAlbumId?: string;
  detailsOpen: boolean;
  loading: boolean;
  onChangeQuery: (query: string) => void;
  onSelectAlbum: (albumId?: string) => void;
  onOpenTrack: (path: string) => void;
  onOpenDetails: () => void;
  onCloseDetails: () => void;
  selectedPaths: string[];
  selectedCollectionKeys: string[];
  onToggleCollection: (key: string, paths: string[]) => void;
  selectionMode: boolean;
  onChangeSelectedPaths: (paths: string[]) => void;
  onChangeSelectionMode: (enabled: boolean) => void;
}) {
  const { t } = useTranslation();
  const [sort, setSort] = useState<SortState<AlbumSortField>>();
  const sortedAlbums = useMemo(() => (sort ? sortAlbumsBy(albums, sort.key, sort.direction) : albums), [albums, sort]);
  const selectedAlbum = albums.find((album) => album.id === selectedAlbumId);
  const { visibleCount, sentinelRef, hasMore } = useIncrementalGrid(sortedAlbums.length);
  useGoUpOnMouseBack(detailsOpen && selectedAlbum !== undefined, onCloseDetails);

  if (detailsOpen && selectedAlbum) {
    return (
      <div className="page-shell">
        <SubPageBar
          backLabel={t("albums.title")}
          onBack={onCloseDetails}
          items={[
            { key: "albums", label: t("albums.title"), onClick: onCloseDetails },
            { key: selectedAlbum.id, label: selectedAlbum.title },
          ]}
        />
        <div className="page-body">
          <section className="detail-heading">
            <TrackArtwork track={{ coverDataUrl: selectedAlbum.coverDataUrl, path: selectedAlbum.coverPath, hasCover: Boolean(selectedAlbum.coverPath) }} size={56} />
            <div className="detail-heading-text">
              <span className="detail-heading-title">{selectedAlbum.title}</span>
              <span className="detail-heading-meta">{selectedAlbum.artist}</span>
              <span className="detail-heading-meta detail-heading-facts">
                <span>{t("common.trackCount", { count: selectedAlbum.trackCount })}</span>
                <span>{formatDuration(selectedAlbum.durationSeconds)}</span>
              </span>
            </div>
          </section>
          <LibraryTable
            tracks={selectedAlbum.tracks as AudioTrack[]}
            loading={loading}
            selectedPaths={selectedPaths}
            onOpenTrack={(track) => onOpenTrack(track.path)}
            onChangeSelectedPaths={onChangeSelectedPaths}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="page-shell">
      <PageHeader
        title={t("albums.title")}
        meta={t("common.albumCount", { count: albums.length })}
        actions={<>
          <Input allowClear className="page-search" prefix={<SearchOutlined />} placeholder={t("search.placeholder", { scope: t("search.albums") })} value={query} onChange={(event) => onChangeQuery(event.target.value)} />
          <SortSelect
            value={sort}
            onChange={setSort}
            fields={albumSortFields.map((key) => ({ key, label: t(`sort.field.${key}`) }))}
          />
          {selectionMode
            ? <Button icon={<CloseOutlined />} onClick={() => onChangeSelectionMode(false)}>{t("selection.exit")}</Button>
            : <Button icon={<CheckSquareOutlined />} onClick={() => onChangeSelectionMode(true)}>{t("selection.selectAlbums")}</Button>}
        </>}
      />
      <div className="page-body">
        <div className="album-grid" aria-busy={loading}>
          {sortedAlbums.slice(0, visibleCount).map((album) => {
            const selected = selectedCollectionKeys.includes(`album:${album.id}`);
            return <button className="collection-tile album-tile" key={album.id} aria-pressed={selectionMode ? selected : undefined} onClick={() => {
              if (selectionMode) onToggleCollection(`album:${album.id}`, album.tracks.map((track) => track.path));
              else { onSelectAlbum(album.id); onOpenDetails(); }
            }}>
              <div className="collection-artwork-wrap">
                <TrackArtwork track={{ coverDataUrl: album.coverDataUrl, path: album.coverPath, hasCover: Boolean(album.coverPath) }} size={180} />
                {selectionMode ? <span className={`collection-select-indicator${selected ? " is-selected" : ""}`}><CheckOutlined /></span> : null}
              </div>
              <Text strong ellipsis={{ tooltip: album.title }}>{album.title}</Text>
              <Text type="secondary" ellipsis={{ tooltip: album.artist }}>{album.artist}</Text>
              <Text className="collection-meta" type="secondary"><span>{t("common.trackCount", { count: album.trackCount })}</span><span>{formatDuration(album.durationSeconds)}</span></Text>
            </button>;
          })}
        </div>
        {hasMore ? <div ref={sentinelRef} className="collection-grid-sentinel" aria-hidden="true" /> : null}
      </div>
    </div>
  );
});
