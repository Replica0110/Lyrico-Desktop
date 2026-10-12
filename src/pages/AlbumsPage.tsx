import { SearchOutlined } from "@ant-design/icons";
import { Input, Typography } from "antd";
import { memo, useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { AudioTrack } from "../app/types";
import { LibraryTable } from "../components/LibraryTable";
import { LibraryRefreshButton } from "../components/LibraryRefreshButton";
import { PageHeader } from "../components/PageHeader";
import { SortSelect } from "../components/SortSelect";
import { SubPageBar } from "../components/SubPageBar";
import { TrackArtwork } from "../components/TrackArtwork";
import type { AlbumGroup } from "../domain/library";
import { albumSortFields, sortAlbumsBy, type AlbumSortField, type SortState } from "../domain/sort";
import { formatDuration } from "../utils/format";
import { useGoUpOnMouseBack } from "../hooks/useGoUpOnMouseBack";
import { IncrementalGridFooter } from "../components/IncrementalGridFooter";
import { useIncrementalGrid } from "../hooks/useIncrementalGrid";

const { Text } = Typography;

export const AlbumsPage = memo(function AlbumsPage({
  albums,
  query,
  selectedAlbumId,
  detailsOpen,
  loading,
  onRefreshLibrary,
  canRefreshLibrary,
  onChangeQuery,
  onSelectAlbum,
  onOpenTrack,
  onOpenDetails,
  onCloseDetails,
  selectedPaths,
  sort,
  onChangeSelectedPaths,
  onSortChange,
}: {
  albums: AlbumGroup[];
  query: string;
  selectedAlbumId?: string;
  detailsOpen: boolean;
  loading: boolean;
  onRefreshLibrary: () => void;
  canRefreshLibrary: boolean;
  onChangeQuery: (query: string) => void;
  onSelectAlbum: (albumId?: string) => void;
  onOpenTrack: (path: string) => void;
  onOpenDetails: () => void;
  onCloseDetails: () => void;
  selectedPaths: string[];
  sort?: SortState<AlbumSortField>;
  onChangeSelectedPaths: (paths: string[]) => void;
  onSortChange: (sort?: SortState<AlbumSortField>) => void;
}) {
  const { t } = useTranslation();
  const sortedAlbums = useMemo(() => (sort ? sortAlbumsBy(albums, sort.key, sort.direction) : albums), [albums, sort]);
  const { visibleCount, sentinelRef, hasMore, loadingMore } = useIncrementalGrid(sortedAlbums.length);
  const selectedAlbum = albums.find((album) => album.id === selectedAlbumId);
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
            onChange={onSortChange}
            fields={albumSortFields.map((key) => ({ key, label: t(`sort.field.${key}`) }))}
          />
          <LibraryRefreshButton disabled={!canRefreshLibrary || loading} onRefresh={onRefreshLibrary} />
        </>}
      />
      <div className="page-body">
        <div className="album-grid" aria-busy={loading}>
          {sortedAlbums.slice(0, visibleCount).map(album => <button type="button" className="collection-tile album-tile" key={album.id}
            onClick={() => { onSelectAlbum(album.id); onOpenDetails(); }}>
            <span className="collection-artwork-wrap"><TrackArtwork track={{ coverDataUrl: album.coverDataUrl, path: album.coverPath, hasCover: Boolean(album.coverPath) }} size={180} /></span>
            <Text strong ellipsis={{ tooltip: album.title }}>{album.title}</Text>
            <Text type="secondary" ellipsis={{ tooltip: album.artist }}>{album.artist}</Text>
            <Text className="collection-meta" type="secondary"><span>{t("common.trackCount", { count: album.trackCount })}</span><span>{formatDuration(album.durationSeconds)}</span></Text>
          </button>)}
        </div>
        <IncrementalGridFooter sentinelRef={sentinelRef} hasMore={hasMore} loadingMore={loadingMore} />
      </div>
    </div>
  );
});
