import { CheckOutlined, CheckSquareOutlined, CloseOutlined, SearchOutlined } from "@ant-design/icons";
import { Button, Input, Typography } from "antd";
import { memo, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { LibraryTable } from "../components/LibraryTable";
import { PageHeader } from "../components/PageHeader";
import { SortSelect } from "../components/SortSelect";
import { SubPageBar } from "../components/SubPageBar";
import { TrackArtwork } from "../components/TrackArtwork";
import type { ArtistGroup } from "../domain/library";
import { artistSortFields, sortArtistsBy, type ArtistSortField, type SortState } from "../domain/sort";
import { formatDuration } from "../utils/format";
import { useGoUpOnMouseBack } from "../hooks/useGoUpOnMouseBack";
import { useIncrementalGrid } from "../hooks/useIncrementalGrid";

const { Text } = Typography;

export const ArtistsPage = memo(function ArtistsPage({
  artists,
  query,
  selectedArtistId,
  detailsOpen,
  loading,
  onChangeQuery,
  onSelectArtist,
  onOpenTrack,
  onOpenDetails,
  onCloseDetails,
  selectedPaths,
  selectedCollectionKeys,
  onToggleCollection,
  selectionMode,
  onChangeSelectedPaths,
  onChangeSelectionMode,
  artistPosters,
}: {
  artists: ArtistGroup[];
  query: string;
  selectedArtistId?: string;
  detailsOpen: boolean;
  loading: boolean;
  onChangeQuery: (query: string) => void;
  onSelectArtist: (artistId?: string) => void;
  onOpenTrack: (path: string) => void;
  onOpenDetails: () => void;
  onCloseDetails: () => void;
  selectedPaths: string[];
  selectedCollectionKeys: string[];
  onToggleCollection: (key: string, paths: string[]) => void;
  selectionMode: boolean;
  onChangeSelectedPaths: (paths: string[]) => void;
  onChangeSelectionMode: (enabled: boolean) => void;
  artistPosters: Record<string, string>;
}) {
  const { t } = useTranslation();
  const [sort, setSort] = useState<SortState<ArtistSortField>>();
  const sortedArtists = useMemo(() => (sort ? sortArtistsBy(artists, sort.key, sort.direction) : artists), [artists, sort]);
  const selectedArtist = artists.find((artist) => artist.id === selectedArtistId);
  const { visibleCount, sentinelRef, hasMore } = useIncrementalGrid(sortedArtists.length);
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
            <TrackArtwork track={{ coverDataUrl: artistPosters[selectedArtist.id] ?? selectedArtist.coverDataUrl, path: selectedArtist.coverPath, hasCover: Boolean(selectedArtist.coverPath || artistPosters[selectedArtist.id]) }} size={56} />
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
            onChange={setSort}
            fields={artistSortFields.map((key) => ({ key, label: t(`sort.field.${key}`) }))}
          />
          {selectionMode
            ? <Button icon={<CloseOutlined />} onClick={() => onChangeSelectionMode(false)}>{t("selection.exit")}</Button>
            : <Button icon={<CheckSquareOutlined />} onClick={() => onChangeSelectionMode(true)}>{t("selection.selectArtists")}</Button>}
        </>}
      />
      <div className="page-body">
        <div className="artist-grid" aria-busy={loading}>
          {sortedArtists.slice(0, visibleCount).map((artist) => {
            const selected = selectedCollectionKeys.includes(`artist:${artist.id}`);
            return <button className="collection-tile artist-tile" key={artist.id} aria-pressed={selectionMode ? selected : undefined} onClick={() => {
              if (selectionMode) onToggleCollection(`artist:${artist.id}`, artist.tracks.map((track) => track.path));
              else { onSelectArtist(artist.id); onOpenDetails(); }
            }}>
              <div className="collection-artwork-wrap">
                <TrackArtwork track={{ coverDataUrl: artistPosters[artist.id] ?? artist.coverDataUrl, path: artist.coverPath, hasCover: Boolean(artist.coverPath || artistPosters[artist.id]) }} size={156} />
                {selectionMode ? <span className={`collection-select-indicator${selected ? " is-selected" : ""}`}><CheckOutlined /></span> : null}
              </div>
              <Text strong ellipsis={{ tooltip: artist.name }}>{artist.name}</Text>
              <Text className="collection-meta" type="secondary"><span>{t("common.albumCount", { count: artist.albumCount })}</span><span>{t("common.songCount", { count: artist.trackCount })}</span></Text>
            </button>;
          })}
        </div>
        {hasMore ? <div ref={sentinelRef} className="collection-grid-sentinel" aria-hidden="true" /> : null}
      </div>
    </div>
  );
});
