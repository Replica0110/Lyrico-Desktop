import { SearchOutlined } from "@ant-design/icons";
import { Input, Typography } from "antd";
import { memo, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { LibraryTable } from "../components/LibraryTable";
import { LibraryRefreshButton } from "../components/LibraryRefreshButton";
import { PageHeader } from "../components/PageHeader";
import { SortSelect } from "../components/SortSelect";
import { SubPageBar } from "../components/SubPageBar";
import { TrackArtwork } from "../components/TrackArtwork";
import type { ArtistGroup } from "../domain/library";
import { artistSortFields, sortArtistsBy, type ArtistSortField, type SortState } from "../domain/sort";
import { formatDuration } from "../utils/format";
import { useGoUpOnMouseBack } from "../hooks/useGoUpOnMouseBack";
import { IncrementalGridFooter } from "../components/IncrementalGridFooter";
import { useIncrementalGrid } from "../hooks/useIncrementalGrid";

const { Text } = Typography;

export const ArtistsPage = memo(function ArtistsPage({
  artists,
  query,
  selectedArtistId,
  detailsOpen,
  loading,
  onRefreshLibrary,
  canRefreshLibrary,
  onChangeQuery,
  onSelectArtist,
  onOpenTrack,
  onOpenDetails,
  onCloseDetails,
  selectedPaths,
  onChangeSelectedPaths,
  artistPosterFolder,
  sort,
  onSortChange,
}: {
  artists: ArtistGroup[];
  query: string;
  selectedArtistId?: string;
  detailsOpen: boolean;
  loading: boolean;
  onRefreshLibrary: () => void;
  canRefreshLibrary: boolean;
  onChangeQuery: (query: string) => void;
  onSelectArtist: (artistId?: string) => void;
  onOpenTrack: (path: string) => void;
  onOpenDetails: () => void;
  onCloseDetails: () => void;
  selectedPaths: string[];
  onChangeSelectedPaths: (paths: string[]) => void;
  artistPosterFolder: string;
  sort?: SortState<ArtistSortField>;
  onSortChange: (sort?: SortState<ArtistSortField>) => void;
}) {
  const { t } = useTranslation();
  const sortedArtists = useMemo(() => (sort ? sortArtistsBy(artists, sort.key, sort.direction) : artists), [artists, sort]);
  const { visibleCount, sentinelRef, hasMore, loadingMore } = useIncrementalGrid(sortedArtists.length);
  const selectedArtist = artists.find((artist) => artist.id === selectedArtistId);
  useGoUpOnMouseBack(detailsOpen && selectedArtist !== undefined, onCloseDetails);

  if (detailsOpen && selectedArtist) {
    return (
      <div className="page-shell">
        <SubPageBar
          backLabel={t("artists.title")}
          onBack={onCloseDetails}
          items={[
            { key: "artists", label: t("artists.title"), onClick: onCloseDetails },
            { key: selectedArtist.id, label: selectedArtist.name },
          ]}
        />
        <div className="page-body">
          <section className="detail-heading">
            <TrackArtwork track={{ coverDataUrl: selectedArtist.coverDataUrl, path: selectedArtist.coverPath, hasCover: Boolean(selectedArtist.coverPath) }} size={56} posterFolder={artistPosterFolder} artist={selectedArtist.name} />
            <div className="detail-heading-text">
              <span className="detail-heading-title">{selectedArtist.name}</span>
              <span className="detail-heading-meta">{t("common.albumCount", { count: selectedArtist.albumCount })}</span>
              <span className="detail-heading-meta detail-heading-facts">
                <span>{t("common.songCount", { count: selectedArtist.trackCount })}</span>
                <span>{formatDuration(selectedArtist.durationSeconds)}</span>
              </span>
            </div>
          </section>
          <LibraryTable
            tracks={selectedArtist.tracks}
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
        title={t("artists.title")}
        meta={t("common.artistCount", { count: artists.length })}
        actions={<>
          <Input allowClear className="page-search" prefix={<SearchOutlined />} placeholder={t("search.placeholder", { scope: t("search.artists") })} value={query} onChange={(event) => onChangeQuery(event.target.value)} />
          <SortSelect
            value={sort}
            onChange={onSortChange}
            fields={artistSortFields.map((key) => ({ key, label: t(`sort.field.${key}`) }))}
          />
          <LibraryRefreshButton disabled={!canRefreshLibrary || loading} onRefresh={onRefreshLibrary} />
        </>}
      />
      <div className="page-body">
        <div className="artist-grid" aria-busy={loading}>
          {sortedArtists.slice(0, visibleCount).map(artist => <button type="button" className="collection-tile artist-tile" key={artist.id}
            onClick={() => { onSelectArtist(artist.id); onOpenDetails(); }}>
            <span className="collection-artwork-wrap"><TrackArtwork track={{ coverDataUrl: artist.coverDataUrl, path: artist.coverPath, hasCover: Boolean(artist.coverPath) }} size={156} posterFolder={artistPosterFolder} artist={artist.name} /></span>
            <Text strong ellipsis={{ tooltip: artist.name }}>{artist.name}</Text>
            <Text className="collection-meta" type="secondary"><span>{t("common.albumCount", { count: artist.albumCount })}</span><span>{t("common.songCount", { count: artist.trackCount })}</span></Text>
          </button>)}
        </div>
        <IncrementalGridFooter sentinelRef={sentinelRef} hasMore={hasMore} loadingMore={loadingMore} />
      </div>
    </div>
  );
});
