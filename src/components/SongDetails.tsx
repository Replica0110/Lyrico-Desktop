import { DeleteOutlined, PlusOutlined, ReloadOutlined, SaveOutlined, SearchOutlined, ShareAltOutlined } from "@ant-design/icons";
import { Alert, Avatar, Button, Checkbox, Descriptions, Drawer, Empty, Flex, Form, Input, InputNumber, List, Modal, Rate, Segmented, Select, Space, Spin, Tabs, Typography } from "antd";
import type { FormInstance } from "antd";
import type { TFunction } from "i18next";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AudioTrack, CustomTag, DesktopSettings, PluginSongResult, ReplayGainProgress, SourcePlugin, TagForm } from "../app/types";
import { fetchRemoteImage, invokeSourcePlugin } from "../backend/audioApi";
import { buildLyricsCandidates, extractPlainLyricsText, LYRIC_FORMATS, lyricsCandidateLabel, preferredPluginLyricFormat, processLyricsText, renderPluginLyrics, type LyricFormat, type PluginLyricsCandidate } from "../backend/lyricsApi";
import { formatDuration } from "../utils/format";
import { useImageDimensions } from "../hooks/useImageDimensions";
import { CoverCropModal } from "./CoverCropModal";
import { ProgressBar } from "./ProgressBar";
import { TrackArtwork } from "./TrackArtwork";
import { RemoteArtwork } from "./RemoteArtwork";
import { useRemoteImage } from "../hooks/useRemoteImage";
import { useReplayGainProgress } from "../hooks/useReplayGainProgress";
import { defaultOnlineSearchKeyword } from "../domain/search";
import { normalizeEditFieldOrder, EDIT_FIELD_LABEL_KEYS, toEditFieldBlocks } from "../domain/editFieldSettings";

const { Text } = Typography;

export function SongDetails({
  open,
  loading,
  track,
  plugins,
  settings,
  form,
  saving,
  onSave,
  onReload,
  onShare,
  onCalculateReplayGain,
  onCancelReplayGain,
  onChooseCover,
  onUseSameAlbumCover,
  onRemoveCover,
  onRevertCover,
  onExportCover,
  onImportLyrics,
  onExportLyrics,
  onClose,
}: {
  open: boolean;
  loading: boolean;
  track?: AudioTrack;
  plugins: SourcePlugin[];
  settings: DesktopSettings;
  form: FormInstance<TagForm>;
  saving: boolean;
  onSave: () => void;
  onReload: () => void;
  onShare: () => void;
  onCalculateReplayGain: () => void;
  onCancelReplayGain: () => void;
  onChooseCover: () => void;
  onUseSameAlbumCover: () => void;
  onRemoveCover: () => void;
  onRevertCover: () => void;
  onExportCover: () => void;
  onImportLyrics: () => void;
  onExportLyrics: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const activeReplayGainProgress = useReplayGainProgress();
  const replayGainProgress = activeReplayGainProgress?.path === track?.path ? activeReplayGainProgress : undefined;
  const [activeTab, setActiveTab] = useState("local");
  const [coverCropOpen, setCoverCropOpen] = useState(false);
  const coverDataUrl = Form.useWatch("coverDataUrl", { form, preserve: true });
  const removeCover = Form.useWatch("removeCover", { form, preserve: true });
  const activeCoverDataUrl = removeCover ? undefined : coverDataUrl ?? track?.coverDataUrl;
  const coverTrack = track ? { ...track, coverDataUrl: removeCover ? undefined : coverDataUrl ?? track.coverDataUrl, hasCover: removeCover ? false : Boolean(coverDataUrl || track.hasCover) } : undefined;

  useEffect(() => {
    setActiveTab("local");
    setCoverCropOpen(false);
  }, [track?.path]);

  return (
    <Drawer
      title={t("details.title")}
      placement="right"
      size={720}
      open={open}
      forceRender
      onClose={onClose}
      extra={
        <Space>
          <Button icon={<ReloadOutlined />} disabled={!track} onClick={onReload}>{t("common.reload")}</Button>
          <Button icon={<ShareAltOutlined />} disabled={!track} onClick={onShare}>{t("details.share")}</Button>
          <Button type="primary" icon={<SaveOutlined />} disabled={!track} loading={saving} onClick={onSave}>{t("common.save")}</Button>
        </Space>
      }
    >
      {loading ? (
        <div className="drawer-loading"><Spin description={t("details.loading")} /></div>
      ) : !track ? (
        <Form form={form} component={false} />
      ) : (
        <div className="editor-layout">
          <header className="editor-media-summary">
            <TrackArtwork track={coverTrack ?? track} size={112} showDimensions />
            <Flex vertical gap={8} className="editor-cover-actions">
              <Space wrap>
                <Button onClick={onChooseCover}>{t("cover.replace")}</Button>
                <Button onClick={onUseSameAlbumCover}>{t("cover.sameAlbum")}</Button>
              </Space>
              <Space wrap>
                <Button disabled={!coverTrack?.hasCover} onClick={onExportCover}>{t("cover.export")}</Button>
                <Button disabled={!activeCoverDataUrl} onClick={() => setCoverCropOpen(true)}>{t("cover.crop")}</Button>
                <Button danger disabled={!coverTrack?.hasCover} onClick={onRemoveCover}>{t("cover.remove")}</Button>
                <Button onClick={onRevertCover}>{t("cover.revert")}</Button>
              </Space>
            </Flex>
          </header>

          <Tabs
            className="editor-tabs"
            activeKey={activeTab}
            onChange={setActiveTab}
            items={[
              { key: "local", label: t("details.localTags"), children: <LocalTagEditor form={form} settings={settings} replayGainProgress={replayGainProgress} onCalculateReplayGain={onCalculateReplayGain} onCancelReplayGain={onCancelReplayGain} onImportLyrics={onImportLyrics} onExportLyrics={onExportLyrics} /> },
              { key: "online", label: t("details.onlineMatch"), children: <OnlineMatch track={track} plugins={plugins} settings={settings} form={form} onApplied={() => setActiveTab("local")} /> },
              { key: "file", label: t("details.fileInfo"), children: <FileInformation track={track} /> },
            ]}
          />
          <CoverCropModal
            open={coverCropOpen}
            source={activeCoverDataUrl}
            onCancel={() => setCoverCropOpen(false)}
            onConfirm={(dataUrl) => form.setFieldsValue({ coverDataUrl: dataUrl, removeCover: false })}
          />
        </div>
      )}
    </Drawer>
  );
}

function FileInformation({ track }: { track: AudioTrack }) {
  const { t } = useTranslation();
  return (
    <Descriptions
      bordered
      size="small"
      column={2}
      items={[
        { key: "name", label: t("details.fileName"), children: track.fileName },
        { key: "format", label: t("table.format"), children: track.format },
        { key: "duration", label: t("table.duration"), children: formatDuration(track.durationSeconds) },
        { key: "bitrate", label: t("details.bitrate"), children: track.bitrate ? `${track.bitrate} kbps` : "—" },
        { key: "sampleRate", label: t("details.sampleRate"), children: track.sampleRate ? `${(track.sampleRate / 1000).toFixed(1)} kHz` : "—" },
        { key: "channels", label: t("details.channels"), children: track.channels ? `${track.channels} ch` : "—" },
        { key: "title", label: t("details.titleField"), children: track.title || "—" },
        { key: "artist", label: t("details.artist"), children: track.artist || "—" },
        { key: "album", label: t("details.album"), span: 2, children: track.album || "—" },
        { key: "path", label: t("details.file"), span: 2, children: <Text type="secondary" copyable={{ text: track.path }} className="file-path">{track.path}</Text> },
      ]}
    />
  );
}

type MatchEntry = { kind: "match"; pluginId: string; result: PluginSongResult };
type LyricsEntry = { kind: "lyrics"; pluginId: string; song: PluginSongResult; candidates: PluginLyricsCandidate[] };
type CoverEntry = { kind: "cover"; pluginId: string; result: PluginSongResult };
type OnlineEntry = MatchEntry | LyricsEntry | CoverEntry;
type OnlineMode = "match" | "lyrics" | "cover";
type MatchMode = "overwrite" | "supplement";

function OnlineMatch({ track, plugins, settings, form, onApplied }: { track: AudioTrack; plugins: SourcePlugin[]; settings: DesktopSettings; form: FormInstance<TagForm>; onApplied: () => void }) {
  const { t } = useTranslation();
  const matchPlugins = plugins.filter((plugin) => plugin.enabled && plugin.capabilities.includes("searchSongs"));
  const lyricsPlugins = plugins.filter((plugin) => plugin.enabled && plugin.capabilities.includes("getLyrics"));
  const coverPlugins = plugins.filter((plugin) => plugin.enabled && plugin.capabilities.includes("searchCovers"));
  const hasAnyPlugin = Boolean(matchPlugins.length || lyricsPlugins.length || coverPlugins.length);
  const [mode, setMode] = useState<OnlineMode>("match");
  const activePlugins = mode === "match" ? matchPlugins : mode === "lyrics" ? lyricsPlugins : coverPlugins;
  const [keyword, setKeyword] = useState(`${track.title} ${track.artist}`.trim());
  const [results, setResults] = useState<OnlineEntry[]>([]);
  const [resultTab, setResultTab] = useState("all");
  const [searching, setSearching] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [page, setPage] = useState(1);
  const [error, setError] = useState<string>();
  const [reviewForm] = Form.useForm<TagForm>();
  const [reviewResult, setReviewResult] = useState<PluginSongResult>();
  const [reviewKeys, setReviewKeys] = useState<Array<keyof TagForm>>([]);
  const [reviewSelectedKeys, setReviewSelectedKeys] = useState<Array<keyof TagForm>>([]);
  const [reviewModes, setReviewModes] = useState<Partial<Record<keyof TagForm, MatchMode>>>({});
  const [bulkReviewMode, setBulkReviewMode] = useState<MatchMode>("overwrite");
  const [reviewPluginId, setReviewPluginId] = useState<string>();
  const [confirming, setConfirming] = useState(false);
  const [coverReviewUrl, setCoverReviewUrl] = useState<string>();
  const [coverSize, setCoverSize] = useState<number>();
  const [coverConfirming, setCoverConfirming] = useState(false);
  const coverPreview = useRemoteImage(coverReviewUrl);
  const coverReviewDimensions = useImageDimensions(coverPreview.dataUrl);
  const [lyricsReview, setLyricsReview] = useState<string>();
  const [lyricsPayload, setLyricsPayload] = useState<unknown>();
  const [lyricsFormat, setLyricsFormat] = useState<LyricFormat>("verbatimLrc");
  const [lyricsFormatting, setLyricsFormatting] = useState(false);
  const [lyricsCandidates, setLyricsCandidates] = useState<PluginLyricsCandidate[]>([]);
  const [lyricsCandidateKey, setLyricsCandidateKey] = useState<string>();
  const lyricsFormatRequest = useRef(0);
  const searchRequest = useRef(0);
  const [busyResult, setBusyResult] = useState<string>();
  const visibleResults = useMemo(() => resultTab === "all" ? results : results.filter((entry) => entry.pluginId === resultTab), [resultTab, results]);

  useEffect(() => {
    lyricsFormatRequest.current += 1;
    invalidateSearch();
    setKeyword(defaultOnlineSearchKeyword(track));
    setResults([]);
    setResultTab("all");
    setError(undefined);
    setBusyResult(undefined);
    clearLyricsReview();
    setReviewResult(undefined);
    setReviewPluginId(undefined);
    setPage(1);
  }, [track.path, track.title, track.artist, track.fileName]);

  function clearLyricsReview() {
    setLyricsReview(undefined);
    setLyricsPayload(undefined);
    setLyricsCandidates([]);
    setLyricsCandidateKey(undefined);
    setLyricsFormatting(false);
  }

  function invalidateSearch() {
    searchRequest.current += 1;
    setSearching(false);
    setLoadingMore(false);
  }

  function changeMode(next: OnlineMode) {
    lyricsFormatRequest.current += 1;
    invalidateSearch();
    setMode(next);
    setResults([]);
    setResultTab("all");
    setPage(1);
    setError(undefined);
    setBusyResult(undefined);
    clearLyricsReview();
  }

  async function search() {
    if (!activePlugins.length || !keyword.trim()) return;
    const request = searchRequest.current + 1;
    searchRequest.current = request;
    setSearching(true);
    setError(undefined);
    try {
      const responses = await Promise.allSettled(activePlugins.map((plugin) => searchPlugin(plugin, 1)));
      if (request !== searchRequest.current) return;
      setResults(responses.flatMap((response) => response.status === "fulfilled" ? response.value : []));
      setPage(1);
      const failures = responses.flatMap((response, index) => response.status === "rejected" ? [`${activePlugins[index].name}: ${String(response.reason)}`] : []);
      setError(failures.length ? failures.join("\n") : undefined);
      setResultTab("all");
    } catch (nextError) {
      if (request !== searchRequest.current) return;
      setError(String(nextError));
    } finally {
      if (request === searchRequest.current) setSearching(false);
    }
  }

  function searchPlugin(plugin: SourcePlugin, pageNumber: number): Promise<OnlineEntry[]> {
    if (mode === "lyrics") return searchLyrics(plugin, pageNumber);
    if (mode === "cover") return searchCover(plugin, pageNumber);
    return searchMatch(plugin, pageNumber);
  }

  async function searchMatch(plugin: SourcePlugin, pageNumber: number): Promise<OnlineEntry[]> {
    const response = await invokeSourcePlugin<unknown>(plugin.id, "searchSongs", {
      keyword: keyword.trim(), page: pageNumber, pageSize: settings.searchPageSize, separator: "/", config: plugin.config,
    });
    return normalizeSearchResults(response).map((result) => ({ kind: "match" as const, pluginId: plugin.id, result }));
  }

  async function searchCover(plugin: SourcePlugin, pageNumber: number): Promise<OnlineEntry[]> {
    const response = await invokeSourcePlugin<unknown>(plugin.id, "searchCovers", {
      keyword: keyword.trim(), page: pageNumber, pageSize: settings.searchPageSize, separator: "/", config: plugin.config,
    });
    return normalizeSearchResults(response)
      .filter((result) => resultCoverUrl(result))
      .map((result) => ({ kind: "cover" as const, pluginId: plugin.id, result }));
  }

  async function searchLyrics(plugin: SourcePlugin, pageNumber: number): Promise<OnlineEntry[]> {
    const songs = plugin.capabilities.includes("searchSongs")
      ? normalizeSearchResults(await invokeSourcePlugin<unknown>(plugin.id, "searchSongs", {
        keyword: keyword.trim(), page: pageNumber, pageSize: settings.searchPageSize, separator: "/", config: plugin.config,
      })).slice(0, 3)
      : [{ title: keyword.trim() } satisfies PluginSongResult];
    const entries: LyricsEntry[] = [];
    for (const song of songs) {
      const payload = await invokeSourcePlugin<unknown>(plugin.id, "getLyrics", {
        song: { ...song, sourceId: plugin.id, pluginId: plugin.id },
        config: plugin.config, page: 1, pageSize: 10,
      });
      const candidates = await buildLyricsCandidates(payload, {
        title: song.title ?? song.name ?? song.songName,
        artist: typeof song.artist === "string" ? song.artist : Array.isArray(song.artist) ? song.artist.join("/") : song.singer,
        album: song.album ?? song.albumName,
      });
      if (candidates.length) entries.push({ kind: "lyrics", pluginId: plugin.id, song, candidates });
    }
    return entries;
  }

  async function loadMore() {
    if (!activePlugins.length || searching || loadingMore || !keyword.trim()) return;
    const request = searchRequest.current;
    const nextPage = page + 1;
    setLoadingMore(true);
    try {
      const responses = await Promise.allSettled(activePlugins.map((plugin) => searchPlugin(plugin, nextPage)));
      if (request !== searchRequest.current) return;
      const nextResults = responses.flatMap((response) => response.status === "fulfilled" ? response.value : []);
      setResults((current) => [...current, ...nextResults]);
      setPage(nextPage);
      const failures = responses.flatMap((response, index) => response.status === "rejected" ? [`${activePlugins[index].name}: ${String(response.reason)}`] : []);
      if (failures.length) setError(failures.join("\n"));
    } finally {
      setLoadingMore(false);
    }
  }

  function openReview(entry: MatchEntry) {
    const { result } = entry;
    const patch = resultToTagPatch(result);
    setError(undefined);
    reviewForm.resetFields();
    reviewForm.setFieldsValue(patch);
    const keys = Object.keys(patch) as Array<keyof TagForm>;
    setReviewKeys(keys);
    setReviewSelectedKeys(keys);
    setReviewModes(Object.fromEntries(keys.map((key) => [key, "overwrite"] as const)));
    setBulkReviewMode("overwrite");
    setReviewPluginId(entry.pluginId);
    setReviewResult(result);
  }

  async function confirmReview() {
    if (!reviewResult) return;
    setConfirming(true);
    setError(undefined);
    try {
      const values = await reviewForm.validateFields();
      const confirmed: Partial<TagForm> = {};
      const target = confirmed as Record<string, unknown>;
      const source = values as unknown as Record<string, unknown>;
      const current = form.getFieldsValue(true) as unknown as Record<string, unknown>;
      reviewSelectedKeys.forEach((key) => {
        if ((reviewModes[key] ?? "overwrite") === "overwrite" || isEmptyTagValue(current[key])) target[key] = source[key];
      });

      form.setFieldsValue(confirmed);
      setReviewResult(undefined);
      onApplied();
    } catch (nextError) {
      setError(String(nextError));
    } finally {
      setConfirming(false);
    }
  }

  function openCoverReview(entry: MatchEntry) {
    const url = resultCoverUrl(entry.result);
    if (!url) return;
    setError(undefined);
    setCoverReviewUrl(url);
    setCoverSize(undefined);
  }

  async function confirmCoverReview() {
    if (!coverReviewUrl) return;
    setCoverConfirming(true);
    setError(undefined);
    try {
      form.setFieldsValue({ coverDataUrl: await fetchRemoteImage(coverReviewUrl, coverSize), removeCover: false });
      setCoverReviewUrl(undefined);
      onApplied();
    } catch (nextError) {
      setError(String(nextError));
    } finally {
      setCoverConfirming(false);
    }
  }

  async function openLyricsReview(entry: MatchEntry) {
    const { result } = entry;
    const plugin = plugins.find((candidate) => candidate.id === entry.pluginId);
    if (!plugin?.capabilities.includes("getLyrics")) return;
    const request = ++lyricsFormatRequest.current;
    setBusyResult(`lyrics:${entry.pluginId}:${resultId(result)}`);
    setError(undefined);
    try {
      const lyrics = await invokeSourcePlugin<unknown>(plugin.id, "getLyrics", {
        song: { ...result, sourceId: plugin.id, pluginId: plugin.id },
        config: plugin.config, page: 1, pageSize: 10,
      });
      if (request !== lyricsFormatRequest.current) return;
      const candidates = await buildLyricsCandidates(lyrics, {
        title: result.title ?? result.name ?? result.songName,
        artist: typeof result.artist === "string" ? result.artist : Array.isArray(result.artist) ? result.artist.join("/") : result.singer,
        album: result.album ?? result.albumName,
      });
      if (request !== lyricsFormatRequest.current) return;
      if (!candidates.length) throw new Error(t("details.lyricsNotFound"));
      setLyricsCandidates(candidates);
      setLyricsReview("");
      setBusyResult(undefined);
      await previewLyricsCandidate(candidates[0]);
    } catch (nextError) {
      if (request === lyricsFormatRequest.current) {
        setError(String(nextError));
        setBusyResult(undefined);
      }
    }
  }

  function openLyricsEntry(entry: LyricsEntry) {
    if (!entry.candidates.length) return;
    setError(undefined);
    setLyricsCandidates(entry.candidates);
    setLyricsReview("");
    void previewLyricsCandidate(entry.candidates[0]);
  }

  async function previewLyricsCandidate(candidate: PluginLyricsCandidate) {
    const request = ++lyricsFormatRequest.current;
    setLyricsCandidateKey(candidate.key);
    setLyricsFormatting(true);
    setError(undefined);
    try {
      const format = settings.lyricFormat ?? preferredPluginLyricFormat(candidate.payload);
      const text = format ? await formatPluginLyrics(candidate.payload, format, settings) : "";
      if (request !== lyricsFormatRequest.current) return;
      if (!text) throw new Error(t("details.lyricsNotFound"));
      setLyricsPayload(candidate.payload);
      if (format) setLyricsFormat(format);
      setLyricsReview(text);
    } catch (nextError) {
      if (request === lyricsFormatRequest.current) setError(String(nextError));
    } finally {
      if (request === lyricsFormatRequest.current) setLyricsFormatting(false);
    }
  }

  function confirmLyricsReview() {
    if (lyricsReview == null || lyricsFormatting) return;
    form.setFieldValue("lyrics", lyricsReview);
    clearLyricsReview();
    onApplied();
  }

  async function updateLyricsReviewFormat(format: LyricFormat) {
    const request = ++lyricsFormatRequest.current;
    setLyricsFormat(format);
    setLyricsFormatting(true);
    setError(undefined);
    try {
      const text = await formatPluginLyrics(lyricsPayload, format, settings);
      if (!text) throw new Error(t("details.lyricsNotFound"));
      if (request === lyricsFormatRequest.current) setLyricsReview(text);
    } catch (nextError) {
      if (request === lyricsFormatRequest.current) setError(String(nextError));
    } finally {
      if (request === lyricsFormatRequest.current) setLyricsFormatting(false);
    }
  }

  if (!hasAnyPlugin) {
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("details.noOnlinePlugins")} />;
  }

  return (
    <Space orientation="vertical" size={16} className="full-width">
      <Flex gap={8} wrap align="center">
        <Segmented
          value={mode}
          onChange={(value) => changeMode(value as OnlineMode)}
          options={[
            { value: "match", label: t("details.modeMatch") },
            { value: "lyrics", label: t("details.modeLyrics") },
            { value: "cover", label: t("details.modeCover") },
          ]}
        />
        <Input.Search value={keyword} prefix={<SearchOutlined />} enterButton={t("details.searchOnline")} loading={searching} onChange={(event) => setKeyword(event.target.value)} onSearch={() => void search()} style={{ flex: 1, minWidth: 260 }} />
      </Flex>
      {error ? <Alert type="error" showIcon message={error} closable onClose={() => setError(undefined)} /> : null}
      <Tabs
        activeKey={resultTab}
        onChange={setResultTab}
        items={[
          { key: "all", label: `${t("common.all")} (${results.length})` },
          ...activePlugins.map((plugin) => ({
            key: plugin.id,
            label: `${plugin.name} (${results.filter((entry) => entry.pluginId === plugin.id).length})`,
          })),
        ]}
      />
      <List
        loading={searching}
        dataSource={visibleResults}
        rowKey={(entry) => `${entry.kind}:${entry.pluginId}:${entry.kind === "lyrics" ? resultId(entry.song) : resultId(entry.result)}`}
        locale={{
          emptyText: mode === "lyrics" ? t("details.noLyricsResults")
            : mode === "cover" ? t("details.noCoverResults")
              : t("details.noOnlineResults"),
        }}
        renderItem={(entry) => {
          const plugin = plugins.find((candidate) => candidate.id === entry.pluginId);
          if (entry.kind === "lyrics") {
            const { song } = entry;
            const title = song.title ?? song.name ?? song.songName ?? t("common.unknownTitle");
            const artist = song.artist ?? song.artists ?? song.singer ?? "";
            return (
              <List.Item actions={[
                <Button key="lyrics" type="link" onClick={() => openLyricsEntry(entry)}>{t("details.fetchLyrics")}</Button>,
              ]}>
                <List.Item.Meta
                  avatar={<RemoteArtwork size={48} url={resultCoverUrl(song)} />}
                  title={title}
                  description={<Space size={6} wrap>
                    <Text type="secondary">{Array.isArray(artist) ? artist.join("/") : artist}</Text>
                    <Text type="secondary">{t("details.lyricsCandidateCount", { total: entry.candidates.length })}</Text>
                    {resultTab === "all" ? <Text type="secondary">{plugin?.name}</Text> : null}
                  </Space>}
                />
              </List.Item>
            );
          }
          if (entry.kind === "cover") {
            const { result } = entry;
            const url = resultCoverUrl(result);
            const title = result.title ?? result.name ?? result.songName ?? t("common.unknownTitle");
            const artist = result.artist ?? result.artists ?? result.singer ?? "";
            return (
              <List.Item actions={[
                url ? <Button key="cover" type="link" onClick={() => { setError(undefined); setCoverReviewUrl(url); setCoverSize(undefined); }}>{t("details.useOnlineCover")}</Button> : null,
              ].filter(Boolean)}>
                <List.Item.Meta
                  avatar={<RemoteArtwork size={48} url={url} />}
                  title={title}
                  description={<Space size={6} wrap>
                    <Text type="secondary">{Array.isArray(artist) ? artist.join("/") : artist}</Text>
                    {result.album || result.albumName ? <Text type="secondary">{result.album ?? result.albumName}</Text> : null}
                    {resultTab === "all" ? <Text type="secondary">{plugin?.name}</Text> : null}
                  </Space>}
                />
              </List.Item>
            );
          }
          const { result } = entry;
          const title = result.title ?? result.name ?? result.songName ?? t("common.unknownTitle");
          const artist = result.artist ?? result.artists ?? result.singer ?? "";
          const cover = resultCoverUrl(result);
          const canFetchLyrics = plugin?.capabilities.includes("getLyrics");
          return (
            <List.Item actions={[
              <Button key="review" type="link" onClick={() => openReview(entry)}>{t("details.reviewTags")}</Button>,
              cover ? <Button key="cover" type="link" onClick={() => openCoverReview(entry)}>{t("details.reviewCover")}</Button> : null,
              canFetchLyrics ? <Button key="lyrics" type="link" loading={busyResult === `lyrics:${entry.pluginId}:${resultId(result)}`} onClick={() => void openLyricsReview(entry)}>{t("details.reviewLyrics")}</Button> : null,
            ].filter(Boolean)}>
              <List.Item.Meta avatar={<RemoteArtwork size={48} url={cover} />} title={title} description={<Space size={6} wrap><Text type="secondary">{`${Array.isArray(artist) ? artist.join("/") : artist}${result.album || result.albumName ? `, ${result.album ?? result.albumName}` : ""}`}</Text>{resultTab === "all" ? <Text type="secondary">{plugin?.name}</Text> : null}</Space>} />
            </List.Item>
          );
        }}
      />
      {visibleResults.length > 0 ? (
        <Flex justify="center">
          <Button loading={loadingMore} disabled={searching} onClick={() => void loadMore()}>
            {t("details.loadMore")}
          </Button>
        </Flex>
      ) : null}
      <Modal
        title={t("details.matchDialogTitle")}
        open={Boolean(reviewResult)}
        width={680}
        okText={t("details.confirmApply")}
        confirmLoading={confirming}
        onOk={() => void confirmReview()}
        onCancel={() => { setReviewResult(undefined); setError(undefined); }}
      >
        {reviewResult ? (
          <Space orientation="vertical" size={16} className="full-width">
            {error ? <Alert type="error" showIcon message={error} /> : null}
            <Descriptions
              size="small"
              column={2}
              items={[
                { key: "id", label: t("details.sourceId"), children: `${plugins.find((plugin) => plugin.id === reviewPluginId)?.name ?? ""}, ${resultId(reviewResult)}` },
                { key: "duration", label: t("table.duration"), children: resultDuration(reviewResult) },
              ]}
            />
            <Flex align="center" justify="space-between" gap={12} wrap className="match-review-toolbar">
              <Checkbox
                checked={reviewKeys.length > 0 && reviewSelectedKeys.length === reviewKeys.length}
                indeterminate={reviewSelectedKeys.length > 0 && reviewSelectedKeys.length < reviewKeys.length}
                onChange={(event) => setReviewSelectedKeys(event.target.checked ? reviewKeys : [])}
              >{t("details.selectAllFields")}</Checkbox>
              <Segmented
                value={bulkReviewMode}
                options={[
                  { value: "overwrite", label: t("details.overwrite") },
                  { value: "supplement", label: t("details.supplement") },
                ]}
                onChange={(value) => {
                  const mode = value as MatchMode;
                  setBulkReviewMode(mode);
                  setReviewModes((current) => ({ ...current, ...Object.fromEntries(reviewKeys.map((key) => [key, mode])) }));
                }}
              />
            </Flex>
            <MatchReviewFields
              form={reviewForm}
              keys={reviewKeys}
              selectedKeys={reviewSelectedKeys}
              modes={reviewModes}
              onToggle={(key, enabled) => setReviewSelectedKeys((current) => enabled ? [...new Set([...current, key])] : current.filter((candidate) => candidate !== key))}
              onModeChange={(key, mode) => setReviewModes((current) => ({ ...current, [key]: mode }))}
            />
          </Space>
        ) : null}
      </Modal>
      <Modal
        title={t("details.coverDialogTitle")}
        open={Boolean(coverReviewUrl)}
        okText={t("details.confirmCover")}
        confirmLoading={coverConfirming}
        onOk={() => void confirmCoverReview()}
        onCancel={() => { setCoverReviewUrl(undefined); setError(undefined); }}
      >
        <Space orientation="vertical" size={16} className="full-width">
          {error ? <Alert type="error" showIcon message={error} /> : null}
          {coverPreview.error ? <Alert type="error" showIcon message={coverPreview.error} /> : null}
          <div className="online-cover-preview">
            <span className="artwork-frame">
              <Avatar shape="square" size={220} src={coverPreview.dataUrl} />
              {coverReviewDimensions ? <span className="cover-dimensions">{coverReviewDimensions.width} × {coverReviewDimensions.height}</span> : null}
            </span>
          </div>
          <Select
            value={coverSize ?? "original"}
            className="full-width"
            options={[
              { value: "original", label: t("details.coverOriginalSize") },
              ...[300, 500, 800, 1200].map((size) => ({ value: size, label: `${size} × ${size}` })),
            ]}
            onChange={(value) => setCoverSize(value === "original" ? undefined : Number(value))}
          />
          <Text type="secondary">{t("details.coverSizeHint")}</Text>
        </Space>
      </Modal>
      <Modal
        title={t("details.lyricsDialogTitle")}
        open={lyricsReview != null}
        width={720}
        okText={t("details.confirmLyrics")}
        okButtonProps={{ disabled: lyricsFormatting || Boolean(error) }}
        onOk={confirmLyricsReview}
        onCancel={() => { lyricsFormatRequest.current += 1; setError(undefined); clearLyricsReview(); }}
      >
        <Space orientation="vertical" size={12} className="full-width">
          {error ? <Alert type="error" showIcon closable message={error} onClose={() => setError(undefined)} /> : null}
          {lyricsCandidates.length > 1 ? (
            <Select
              value={lyricsCandidateKey}
              loading={lyricsFormatting}
              className="full-width"
              placeholder={t("details.lyricsCandidates")}
              options={lyricsCandidates.map((candidate, index) => ({ value: candidate.key, label: lyricsCandidateLabel(candidate.payload, index) }))}
              onChange={(key: string) => {
                const candidate = lyricsCandidates.find((item) => item.key === key);
                if (candidate) void previewLyricsCandidate(candidate);
              }}
            />
          ) : null}
          <Flex gap={8} align="center" wrap>
            <Select
              value={lyricsFormat}
              loading={lyricsFormatting}
              style={{ minWidth: 180 }}
              options={LYRIC_FORMATS.map((format) => ({ value: format, label: t(`lyrics.formats.${format}`) }))}
              onChange={(format: LyricFormat) => void updateLyricsReviewFormat(format)}
            />
            <Text type="secondary">{t("details.lyricsCandidateCount", { total: lyricsCandidates.length })}</Text>
          </Flex>
          <Input.TextArea disabled={lyricsFormatting} value={lyricsReview} onChange={(event) => { setLyricsReview(event.target.value); setError(undefined); }} autoSize={{ minRows: 14, maxRows: 24 }} />
        </Space>
      </Modal>
    </Space>
  );
}

function MatchReviewFields({ form, keys, selectedKeys, modes, onToggle, onModeChange }: {
  form: FormInstance<TagForm>;
  keys: Array<keyof TagForm>;
  selectedKeys: Array<keyof TagForm>;
  modes: Partial<Record<keyof TagForm, MatchMode>>;
  onToggle: (key: keyof TagForm, enabled: boolean) => void;
  onModeChange: (key: keyof TagForm, mode: MatchMode) => void;
}) {
  const { t } = useTranslation();
  if (!keys.length) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("details.noApplicableFields")} />;
  const control = (key: keyof TagForm, disabled: boolean) => {
    if (key === "genre") return <Select mode="tags" open={false} tokenSeparators={[";", "/", ","]} disabled={disabled} />;
    if (key === "trackNumber" || key === "discNumber") return <InputNumber min={1} precision={0} className="full-width" disabled={disabled} />;
    if (key === "rating") return <Rate disabled={disabled} />;
    if (key === "lyrics") return <Input.TextArea autoSize={{ minRows: 4, maxRows: 10 }} disabled={disabled} />;
    return <Input disabled={disabled} />;
  };
  return (
    <Form form={form} layout="vertical" requiredMark={false} className="match-review-form">
      {keys.map((key) => {
        const selected = selectedKeys.includes(key);
        return (
          <div className={`match-field-row${selected ? "" : " is-disabled"}`} key={key}>
            <Flex align="center" justify="space-between" gap={12} wrap className="match-field-policy">
              <Checkbox checked={selected} onChange={(event) => onToggle(key, event.target.checked)}>{tagFieldLabel(key, t)}</Checkbox>
              <Segmented
                size="small"
                disabled={!selected}
                value={modes[key] ?? "overwrite"}
                options={[
                  { value: "overwrite", label: t("details.overwriteShort") },
                  { value: "supplement", label: t("details.supplementShort") },
                ]}
                onChange={(value) => onModeChange(key, value as MatchMode)}
              />
            </Flex>
            <Form.Item name={key} noStyle>{control(key, !selected)}</Form.Item>
          </div>
        );
      })}
    </Form>
  );
}

function normalizeSearchResults(response: unknown): PluginSongResult[] {
  if (Array.isArray(response)) return response as PluginSongResult[];
  if (!response || typeof response !== "object") return [];
  const value = response as Record<string, unknown>;
  for (const key of ["items", "results", "songs", "data"]) {
    if (Array.isArray(value[key])) return value[key] as PluginSongResult[];
  }
  return [];
}

function resultToTagPatch(result: PluginSongResult) {
  const fields = result.fields ?? {};
  const value = (key: string, fallback?: unknown) => fields[key] ?? fallback;
  const artists = value("artist", result.artist ?? result.artists ?? result.singer);
  const genres = value("genre");
  const patch: Partial<TagForm> = {};
  assignPresent(patch, "title", value("title", result.title ?? result.name ?? result.songName), stringValue);
  assignPresent(patch, "artist", artists, (item) => Array.isArray(item) ? item.join("/") : stringValue(item));
  assignPresent(patch, "album", value("album", result.album ?? result.albumName), stringValue);
  assignPresent(patch, "albumArtist", value("album_artist"), stringValue);
  assignPresent(patch, "genre", genres, (item) => Array.isArray(item) ? item.map(String) : stringValue(item).split(/[;,/]/).map((part) => part.trim()).filter(Boolean));
  assignPresent(patch, "year", value("date", result.date ?? result.releaseDate), stringValue);
  assignPresent(patch, "trackNumber", value("track_number", result.trackNumber), numberValue);
  assignPresent(patch, "discNumber", value("disc_number"), numberValue);
  assignPresent(patch, "composer", value("composer"), stringValue);
  assignPresent(patch, "lyricist", value("lyricist"), stringValue);
  assignPresent(patch, "comment", value("comment"), stringValue);
  assignPresent(patch, "lyrics", value("lyrics"), stringValue);
  assignPresent(patch, "language", value("language"), stringValue);
  assignPresent(patch, "copyright", value("copyright"), stringValue);
  assignPresent(patch, "rating", value("rating"), numberValue);
  assignPresent(patch, "replayGainTrackGain", value("replaygain_track_gain"), stringValue);
  assignPresent(patch, "replayGainTrackPeak", value("replaygain_track_peak"), stringValue);
  assignPresent(patch, "replayGainAlbumGain", value("replaygain_album_gain"), stringValue);
  assignPresent(patch, "replayGainAlbumPeak", value("replaygain_album_peak"), stringValue);
  assignPresent(patch, "replayGainReferenceLoudness", value("replaygain_reference_loudness"), stringValue);
  return patch;
}

function resultCoverUrl(result: PluginSongResult) {
  const value = result.fields?.cover_url ?? result.picUrl ?? result.coverUrl ?? result.artworkUrl;
  return typeof value === "string" ? value : undefined;
}

function resultDuration(result: PluginSongResult) {
  const duration = result.duration ?? result.durationMs;
  return typeof duration === "number" ? formatDuration(duration > 10_000 ? duration / 1000 : duration) : "—";
}

function stringValue(value: unknown) {
  return value == null ? "" : String(value);
}

function numberValue(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function assignPresent<K extends keyof TagForm>(target: Partial<TagForm>, key: K, value: unknown, transform: (value: unknown) => TagForm[K]) {
  if (value === undefined || value === null) return;
  target[key] = transform(value);
}

function resultId(result: PluginSongResult) {
  return result.id ?? result.songId ?? result.trackId ?? result.title ?? result.name ?? "result";
}

function isEmptyTagValue(value: unknown) {
  return value == null || (typeof value === "string" && !value.trim()) || (Array.isArray(value) && value.length === 0);
}

async function formatPluginLyrics(result: unknown, format: LyricFormat, settings: DesktopSettings) {
  const rendered = await renderPluginLyrics(result, format, {
    showTranslation: settings.showTranslation,
    showRomanization: settings.showRomanization,
    onlyTranslationIfAvailable: settings.onlyTranslationIfAvailable,
    lineOrder: settings.lyricLineOrder,
    removeTagLineKeywords: settings.removeTagLineKeywords,
    removeEmptyLines: settings.removeEmptyLyricLines,
    conversionMode: settings.lyricsConversionMode,
  });
  return rendered.text;
}

function tagFieldLabel(key: keyof TagForm, t: TFunction) {
  const labels: Partial<Record<keyof TagForm, string>> = {
    title: "details.titleField", artist: "details.artist", album: "details.album", albumArtist: "details.albumArtist",
    genre: "details.genre", year: "details.year", trackNumber: "details.track", discNumber: "details.disc",
    composer: "details.composer", lyricist: "details.lyricist", comment: "details.comment", lyrics: "details.lyrics",
    language: "details.language", copyright: "details.copyright", rating: "details.rating",
    replayGainTrackGain: "tasks.trackGain", replayGainTrackPeak: "tasks.trackPeak",
    replayGainAlbumGain: "tasks.albumGain", replayGainAlbumPeak: "tasks.albumPeak",
    replayGainReferenceLoudness: "details.referenceLoudness",
  };
  return t(labels[key] ?? String(key));
}

function LocalTagEditor({ form, settings, replayGainProgress, onCalculateReplayGain, onCancelReplayGain, onImportLyrics, onExportLyrics }: { form: FormInstance<TagForm>; settings: DesktopSettings; replayGainProgress?: ReplayGainProgress; onCalculateReplayGain: () => void; onCancelReplayGain: () => void; onImportLyrics: () => void; onExportLyrics: () => void }) {
  const { t } = useTranslation();
  const showField = (key: string) => settings.editFieldVisibility?.[key] !== false;
  const [plainLyricsOpen, setPlainLyricsOpen] = useState(false);
  const [plainLyrics, setPlainLyrics] = useState("");
  const [lyricsProcessingAction, setLyricsProcessingAction] = useState<number | "removeEmpty" | "plain">();
  const [lyricsError, setLyricsError] = useState<string>();
  const lyricsProcessRequest = useRef(0);
  const currentLyrics = Form.useWatch("lyrics", form) ?? "";
  const lyricsProcessing = lyricsProcessingAction != null;

  useEffect(() => {
    lyricsProcessRequest.current += 1;
    setLyricsProcessingAction(undefined);
  }, [currentLyrics]);

  async function transformLyrics(options: { offsetMs?: number; removeEmptyLines?: boolean }, action: number | "removeEmpty") {
    const request = ++lyricsProcessRequest.current;
    setLyricsProcessingAction(action);
    setLyricsError(undefined);
    try {
      const result = await processLyricsText(currentLyrics, options);
      if (request === lyricsProcessRequest.current) form.setFieldValue("lyrics", result.text);
    } catch (error) {
      if (request === lyricsProcessRequest.current) setLyricsError(String(error));
    } finally {
      if (request === lyricsProcessRequest.current) setLyricsProcessingAction(undefined);
    }
  }

  async function openPlainLyrics() {
    const request = ++lyricsProcessRequest.current;
    setLyricsProcessingAction("plain");
    setLyricsError(undefined);
    try {
      const text = await extractPlainLyricsText(currentLyrics);
      if (request === lyricsProcessRequest.current) {
        setPlainLyrics(text);
        setPlainLyricsOpen(true);
      }
    } catch (error) {
      if (request === lyricsProcessRequest.current) setLyricsError(String(error));
    } finally {
      if (request === lyricsProcessRequest.current) setLyricsProcessingAction(undefined);
    }
  }
  const lyricsEditor =
    <section className="field-group">
      <header className="field-group-header">
        <Text strong>{t("details.lyrics")}</Text>
        <Space size={8} wrap>
          <Space.Compact>
            <Button size="small" disabled={lyricsProcessing} onClick={onImportLyrics}>{t("lyrics.import")}</Button>
            <Button size="small" disabled={!currentLyrics.trim() || lyricsProcessing} onClick={onExportLyrics}>{t("lyrics.export")}</Button>
          </Space.Compact>
          <Space size={4} align="center">
            <Space.Compact>
              {[-500, -100, 100, 500].map((offset) => (
                <Button key={offset} size="small" loading={lyricsProcessingAction === offset} disabled={!currentLyrics.trim() || lyricsProcessing} onClick={() => void transformLyrics({ offsetMs: offset }, offset)}>
                  {offset > 0 ? `+${offset}` : `${offset}`}
                </Button>
              ))}
            </Space.Compact>
            <Text type="secondary">ms</Text>
          </Space>
          <Space.Compact>
            <Button size="small" loading={lyricsProcessingAction === "removeEmpty"} disabled={!currentLyrics.trim() || lyricsProcessing} onClick={() => void transformLyrics({ removeEmptyLines: true }, "removeEmpty")}>{t("lyrics.removeEmpty")}</Button>
            <Button size="small" loading={lyricsProcessingAction === "plain"} disabled={!currentLyrics.trim() || lyricsProcessing} onClick={() => void openPlainLyrics()}>{t("lyrics.plainText")}</Button>
          </Space.Compact>
        </Space>
      </header>
      {lyricsError ? <Alert type="error" showIcon closable message={lyricsError} onClose={() => setLyricsError(undefined)} /> : null}
      <Form.Item name="lyrics">
        <Input.TextArea aria-label={t("details.lyrics")} autoSize={{ minRows: 8, maxRows: 18 }} />
      </Form.Item>
    </section>;
  const blocks = toEditFieldBlocks(normalizeEditFieldOrder(settings.editFieldOrder));
  const labels = Object.fromEntries(EDIT_FIELD_LABEL_KEYS);
  function renderField(key: string) {
    if (key === "lyrics") return lyricsEditor;
    if (key === "customTags") return <Form.Item name="customTags" label={t(labels[key])}><CustomTagsEditor /></Form.Item>;
    if (key === "rating") return <Form.Item name="rating" label={t(labels[key])}><Rate /></Form.Item>;
    if (key === "genre") return <Form.Item name="genre" label={t(labels[key])}><Select mode="tags" tokenSeparators={[";", "/", ","]} open={false} /></Form.Item>;
    return <Form.Item name={key} label={t(labels[key])}>
      {key === "trackNumber" || key === "discNumber" ? <InputNumber min={1} precision={0} className="full-width" /> : <Input readOnly={key === "replayGainReferenceLoudness"} />}
    </Form.Item>;
  }
  return (
    <>
    <Form form={form} layout="vertical" requiredMark={false} className="tag-form">
      <div className="tag-field-grid">
        {blocks.map(block => {
          if (!block.composite) {
            const key = block.key;
            if (!showField(key)) return null;
            return <div key={key} className={`tag-field${["lyrics", "customTags"].includes(key) ? " is-wide" : ""}`}>{renderField(key)}</div>;
          }
          // ReplayGain is one measurement: render the members together, actions in the group header.
          const members = block.fields.filter(showField);
          if (!members.length) return null;
          return <div key={block.key} className="tag-field is-wide">
            <section className="field-group">
              <header className="field-group-header">
                <Text strong>{t("settings.replayGain")}</Text>
                {replayGainProgress?.status === "running"
                  ? <div className="field-group-progress">
                    <Button size="small" danger onClick={onCancelReplayGain}>{t("common.cancel")}</Button>
                    <ProgressBar percent={replayGainProgress.percent} indeterminate={replayGainProgress.percent <= 0} className="replay-gain-progress" />
                    <Text type="secondary" className="replay-gain-percent">{replayGainProgress.percent}%</Text>
                  </div>
                  : <Button size="small" onClick={onCalculateReplayGain}>{t("replayGain.calculate")}</Button>}
              </header>
              <div className="tag-field-grid field-group-grid">
                {members.map(key => <div className="tag-field" key={key}>{renderField(key)}</div>)}
              </div>
            </section>
          </div>;
        })}
      </div>
    </Form>
    <Modal title={t("lyrics.plainText")} open={plainLyricsOpen} footer={null} onCancel={() => setPlainLyricsOpen(false)}>
      <Input.TextArea value={plainLyrics} readOnly autoSize={{ minRows: 10, maxRows: 20 }} />
    </Modal>
    </>
  );
}

function CustomTagsEditor({
  value = [],
  onChange,
}: {
  value?: CustomTag[];
  onChange?: (value: CustomTag[]) => void;
}) {
  const { t } = useTranslation();
  const tags = Array.isArray(value) ? value : [];
  const update = (index: number, patch: Partial<CustomTag>) => {
    const next = tags.map((tag, tagIndex) => tagIndex === index ? { ...tag, ...patch } : tag);
    onChange?.(next);
  };
  return (
    <Space orientation="vertical" size={10} style={{ width: "100%" }}>
      {tags.map((tag, index) => (
        <Flex key={index} gap={8} align="start">
          <Input
            value={tag.key}
            placeholder={t("details.customTagKey")}
            onChange={(event) => update(index, { key: event.target.value })}
          />
          <Input.TextArea
            value={tag.values.join("\n")}
            placeholder={t("details.customTagValue")}
            autoSize={{ minRows: 1, maxRows: 4 }}
            onChange={(event) => update(index, { values: event.target.value.split(/\r?\n/) })}
          />
          <Button
            danger
            type="text"
            icon={<DeleteOutlined />}
            aria-label={t("common.remove")}
            onClick={() => onChange?.(tags.filter((_, tagIndex) => tagIndex !== index))}
          />
        </Flex>
      ))}
      <Button
        type="dashed"
        icon={<PlusOutlined />}
        onClick={() => onChange?.([...tags, { key: "", values: [""] }])}
      >
        {t("details.addCustomTag")}
      </Button>
    </Space>
  );
}
