import { ReloadOutlined, SearchOutlined } from "@ant-design/icons";
import { Button, Empty, Flex, Input, Space, Tooltip, Typography } from "antd";
import { memo, useCallback, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import type { AudioTrack } from "../app/types";
import { LibraryTable } from "../components/LibraryTable";
import { SortSelect } from "../components/SortSelect";
import { trackSortFields, type SortState, type TrackSortField } from "../domain/sort";
import { useStickyOffset } from "../hooks/useStickyOffset";

const { Title, Text } = Typography;

export const SongsPage = memo(function SongsPage({
  tracks,
  query,
  selectedTrack,
  selectedPaths,
  loading,
  onChangeQuery,
  onSelectTrack,
  onChangeSelectedPaths,
  onReloadTrack,
  onOpenDetails,
  selectionMode,
  onChangeSelectionMode,
  onOpenBatch,
}: {
  tracks: AudioTrack[];
  query: string;
  selectedTrack?: AudioTrack;
  selectedPaths: string[];
  loading: boolean;
  onChangeQuery: (query: string) => void;
  onSelectTrack: (path?: string) => void;
  onChangeSelectedPaths: (paths: string[]) => void;
  onReloadTrack: () => void;
  onOpenDetails: (path?: string) => void;
  selectionMode: boolean;
  onChangeSelectionMode: (enabled: boolean) => void;
  onOpenBatch: () => void;
}) {
  const { t } = useTranslation();
  const handleOpenTrack = useCallback((track: AudioTrack) => onOpenDetails(track.path), [onOpenDetails]);
  const headerRef = useRef<HTMLDivElement>(null);
  const stickyOffset = useStickyOffset(headerRef);
  const [sort, setSort] = useState<SortState<TrackSortField>>();
  return (
    <div className="workspace page-stack library-view" style={{ "--sticky-offset": `${stickyOffset}px` } as CSSProperties}>
      <Flex ref={headerRef} className="library-page-header compact-library-header" justify="space-between" align="center" gap={24}>
        <div className="library-page-header-copy">
          <Title level={2}>{t("songs.title")}</Title>
          <Text type="secondary">{t("common.songCount", { count: tracks.length })}</Text>
        </div>
        <Space className="library-page-actions" wrap>
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
          <Tooltip title={t("songs.reloadHint")}>
            <Button
              aria-label={t("songs.reloadAria")}
              icon={<ReloadOutlined />}
              disabled={!selectedTrack}
              loading={loading}
              onClick={onReloadTrack}
            />
          </Tooltip>
        </Space>
      </Flex>

      <section className="library-list-section">
        {tracks.length === 0 && !loading ? (
          <Empty className="page-empty" image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("songs.empty")} />
        ) : (
          <LibraryTable
            tracks={tracks}
            loading={loading}
            selectedPaths={selectedPaths}
            onSelectTrack={onSelectTrack}
            onOpenTrack={handleOpenTrack}
            onChangeSelectedPaths={onChangeSelectedPaths}
            selectionMode={selectionMode}
            onChangeSelectionMode={onChangeSelectionMode}
            onOpenBatch={onOpenBatch}
            sort={sort}
            onSortChange={setSort}
          />
        )}
      </section>
    </div>
  );
});
