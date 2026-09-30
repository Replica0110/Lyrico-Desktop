import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { App as AntApp, ConfigProvider, Form, Spin, theme } from "antd";
import enUS from "antd/locale/en_US";
import zhCN from "antd/locale/zh_CN";
import { lazy, Suspense, useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  loadLibraryFolders,
  loadArtistSplitConfig,
  loadLibraryTrack,
  loadCustomTags,
  loadLibraryTracks,
  loadLibraryTracksByPaths,
  loadBatchTaskItems,
  readAudioFile,
  readImageFile,
  readTextFile,
  removeLibraryFolder,
  saveAudioTags,
  saveCustomTags,
  saveArtistSplitConfig,
  analyzeReplayGain,
  cancelBatchTask,
  cancelReplayGain,
  scanFolder,
  upsertLibraryFolder,
  writeTextFile,
  writeImageFile,
  loadSourcePlugins,
  loadDesktopSettings,
  installSourcePluginArchive,
  saveSourcePluginSettings,
  saveDesktopSettings,
  setSourcePluginEnabled,
  setSourcePluginOrder,
  searchLyricsLines,
  pickPaths,
  pickSavePath,
  uninstallSourcePlugin,
} from "../backend/audioApi";
import { Shell } from "../components/Shell";
import { TitleBar } from "../components/TitleBar";
import { AppContextMenu } from "../components/AppContextMenu";
import { SongDetails } from "../components/SongDetails";
import { AlbumsPage } from "../pages/AlbumsPage";
import { ArtistsPage } from "../pages/ArtistsPage";
import { FoldersPage } from "../pages/FoldersPage";
import { SongsPage } from "../pages/SongsPage";
import { defaultArtistSplitConfig, filterTracks, groupAlbums, groupArtists } from "../domain/library";
import { completeTagForm, splitGenreValues } from "../domain/tagForm";
import { detectLyricsFormat } from "../backend/lyricsApi";
import { invalidateCachedCovers, updateCachedCover } from "../hooks/useTrackCovers";
import { applyBatchLibraryUpdate, libraryPathsToRefresh } from "../domain/libraryRefresh";
import {
  getLanguagePreference,
  resolveLanguage,
  setLanguagePreference as persistLanguagePreference,
  type LanguagePreference,
} from "../i18n";
import type { ArtistSplitConfig, AudioTrack, BatchTask, BatchTaskItem, CustomTag, DesktopSettings, LibraryFolder, ScanProgress, SourcePlugin, TagForm, ViewKey } from "./types";

const PluginsPage = lazy(() => import("../pages/PluginsPage").then((m) => ({ default: m.PluginsPage })));
const SettingsPage = lazy(() => import("../pages/SettingsPage").then((m) => ({ default: m.SettingsPage })));
const TasksPage = lazy(() => import("../pages/TasksPage").then((m) => ({ default: m.TasksPage })));
import { getReplayGainProgress, publishReplayGainProgress } from "../hooks/useReplayGainProgress";
import { getThemeMode, prefersDark, setThemeMode, subscribeTheme } from "./theme";
import type { ThemeMode } from "../backend/audioApi";
import { isPathInHiddenFolder } from "../domain/libraryVisibility";
import { artistPosterBaseNames } from "../domain/artistPoster";
import { shareFile } from "@sosweetham/tauri-plugin-sharehub-api";
import { fileUrlForShare } from "../domain/share";
import "../App.css";

const defaultDesktopSettings: DesktopSettings = {
  searchPageSize: 10,
  replayGainTargetLoudness: -18,
  lyricFormat: "verbatimLrc",
  lyricsConversionMode: "none",
  showTranslation: true,
  showRomanization: true,
  onlyTranslationIfAvailable: false,
  removeEmptyLyricLines: true,
  lyricLineOrder: ["original", "romanization", "translation"],
  removeTagLineKeywords: [],
  ignoreShortAudio: false,
  lyricIndexEnabled: true,
  hiddenFolderPaths: [],
  artistPosterFolder: "",
  themeMode: "system",
  editFieldVisibility: {},
  editFieldOrder: ["basic", "track", "credits", "customTags", "replaygain", "lyrics", "cover"],
  renameCharacterMappings: {
    "\\": "＼", "/": "／", ":": "：", "*": "＊", "?": "？", "\"": "＂", "<": "＜", ">": "＞", "|": "｜",
  },
};

export default function App() {
  const { i18n } = useTranslation();
  const antLocale = i18n.resolvedLanguage?.startsWith("zh") ? zhCN : enUS;
  const [themeMode, setThemeModeState] = useState<ThemeMode>(getThemeMode);
  const [systemDark, setSystemDark] = useState(prefersDark);

  useEffect(() => subscribeTheme(setThemeModeState), []);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = (event: MediaQueryListEvent) => setSystemDark(event.matches);
    media.addEventListener("change", handleChange);
    return () => media.removeEventListener("change", handleChange);
  }, []);

  useEffect(() => {
    document.documentElement.lang = i18n.resolvedLanguage ?? "en-US";
  }, [i18n.resolvedLanguage]);

  const darkTheme = themeMode === "dark" || (themeMode === "system" && systemDark);

  useEffect(() => {
    document.documentElement.dataset.theme = darkTheme ? "dark" : "light";
  }, [darkTheme]);

  return (
    <ConfigProvider
      locale={antLocale}
      theme={{
        cssVar: {},
        algorithm: darkTheme ? theme.darkAlgorithm : theme.defaultAlgorithm,
        token: {
          colorPrimary: "#1677ff",
          borderRadius: 8,
          fontFamily:
            "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
        },
      }}
    >
      <AntApp>
        <LyricoDesktop />
      </AntApp>
    </ConfigProvider>
  );
}

function PageFallback() {
  return <div className="page-route-loading"><Spin /></div>;
}

const viewScrollPositions = new Map<string, number>();

function PageViewport({ scrollKey, hidden, children }: { scrollKey: string; hidden: boolean; children: ReactNode }) {
  const viewportRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    viewport.scrollTop = viewScrollPositions.get(scrollKey) ?? 0;
    return () => {
      viewScrollPositions.set(scrollKey, viewport.scrollTop);
    };
  }, [scrollKey]);
  return <div ref={viewportRef} className={`page-viewport${hidden ? " is-hidden" : ""}`} aria-hidden={hidden}>{children}</div>;
}

function LyricoDesktop() {
  const { message } = AntApp.useApp();
  const { t, i18n } = useTranslation();
  const [activeView, setActiveView] = useState<ViewKey>("songs");
  const [tracks, setTracks] = useState<AudioTrack[]>([]);
  const [folders, setFolders] = useState<LibraryFolder[]>([]);
  const [selectedPath, setSelectedPath] = useState<string>();
  const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedFolderPath, setSelectedFolderPath] = useState<string>();
  const [selectedAlbumId, setSelectedAlbumId] = useState<string>();
  const [selectedArtistId, setSelectedArtistId] = useState<string>();
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [detailTrack, setDetailTrack] = useState<AudioTrack>();
  const [detailCustomTags, setDetailCustomTags] = useState<CustomTag[]>([]);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [albumDetailsOpen, setAlbumDetailsOpen] = useState(false);
  const [artistDetailsOpen, setArtistDetailsOpen] = useState(false);
  const [plugins, setPlugins] = useState<SourcePlugin[]>([]);
  const [artistSplitConfig, setArtistSplitConfig] = useState<ArtistSplitConfig>(defaultArtistSplitConfig);
  const [desktopSettings, setDesktopSettings] = useState<DesktopSettings>(defaultDesktopSettings);
  const [languagePreference, setLanguagePreference] = useState<LanguagePreference>(getLanguagePreference);
  const [scanProgress, setScanProgress] = useState<ScanProgress>();
  const [form] = Form.useForm<TagForm>();
  const detailRequest = useRef(0);
  const editingPathRef = useRef<string | undefined>(undefined);
  const artistSplitSaveQueue = useRef<Promise<void>>(Promise.resolve());
  const settingsSaveQueue = useRef<Promise<void>>(Promise.resolve());
  useEffect(() => {
    editingPathRef.current = detailTrack?.path;
  }, [detailTrack]);
  const deferredQuery = useDeferredValue(query);
  const isSearchView = activeView === "songs" || activeView === "albums" || activeView === "artists";
  const [lyricMatchPaths, setLyricMatchPaths] = useState<Set<string>>(() => new Set());
  const filteredTracks = useMemo(() => {
    if (!isSearchView) return tracks;
    const visibleTracks = tracks.filter((track) => !isPathInHiddenFolder(track.path, desktopSettings.hiddenFolderPaths));
    const matched = filterTracks(visibleTracks, deferredQuery);
    if (lyricMatchPaths.size === 0) return matched;
    const matchedPaths = new Set(matched.map((track) => track.path));
    const lyricExtras = visibleTracks.filter(
      (track) => lyricMatchPaths.has(track.path) && !matchedPaths.has(track.path),
    );
    return lyricExtras.length ? [...matched, ...lyricExtras] : matched;
  }, [tracks, deferredQuery, isSearchView, lyricMatchPaths, desktopSettings.hiddenFolderPaths]);
  const albums = useMemo(() => (activeView === "albums" ? groupAlbums(filteredTracks) : []), [activeView, filteredTracks]);
  const artists = useMemo(
    () => (activeView === "artists" ? groupArtists(filteredTracks, artistSplitConfig) : []),
    [activeView, filteredTracks, artistSplitConfig],
  );
  const [artistPosters, setArtistPosters] = useState<Record<string, string>>({});
  const trackByPath = useMemo(() => {
    const map = new Map<string, AudioTrack>();
    for (const track of tracks) map.set(track.path, track);
    return map;
  }, [tracks]);
  const selectedTrackSummary = useMemo(() => (selectedPath ? trackByPath.get(selectedPath) : undefined), [trackByPath, selectedPath]);
  const selectedTrack = detailTrack?.path === selectedPath ? detailTrack : selectedTrackSummary;
  const selectedTracks = useMemo(() => {
    return selectedPaths.flatMap((path) => {
      const track = trackByPath.get(path);
      return track ? [track] : [];
    });
  }, [selectedPaths, trackByPath]);

  useEffect(() => {
    const timer = globalThis.setTimeout(() => {
      void Promise.all([import("../pages/PluginsPage"), import("../pages/SettingsPage"), import("../pages/TasksPage")]);
    }, 250);
    return () => globalThis.clearTimeout(timer);
  }, []);

  useEffect(() => {
    setThemeMode(desktopSettings.themeMode ?? "system");
  }, [desktopSettings.themeMode]);

  useEffect(() => {
    const normalizedQuery = deferredQuery.trim();
    if (!isSearchView || !normalizedQuery || !desktopSettings.lyricIndexEnabled) {
      setLyricMatchPaths(new Set());
      return;
    }
    let disposed = false;
    const timer = window.setTimeout(() => {
      searchLyricsLines(normalizedQuery, 100)
        .then((matches) => {
          if (disposed) return;
          setLyricMatchPaths(new Set(matches.map((match) => match.path)));
        })
        .catch(() => {
          if (!disposed) setLyricMatchPaths(new Set());
        });
    }, 250);
    return () => {
      disposed = true;
      window.clearTimeout(timer);
    };
  }, [deferredQuery, isSearchView, desktopSettings.lyricIndexEnabled]);

  useEffect(() => {
    const folder = desktopSettings.artistPosterFolder.trim();
    if (!folder || artists.length === 0) {
      setArtistPosters({});
      return;
    }
    let disposed = false;
    void Promise.all(
      artists.map(async (artist) => {
        for (const base of artistPosterBaseNames(artist.name)) {
          for (const extension of ["jpg", "jpeg", "png", "webp"]) {
            try {
              const dataUrl = await readImageFile(`${folder}\\${base}.${extension}`);
              return [artist.id, dataUrl] as const;
            } catch {
              // Try the next supported filename variant.
            }
          }
        }
        return undefined;
      }),
    ).then((entries) => {
      if (disposed) return;
      setArtistPosters(Object.fromEntries(entries.filter((entry): entry is readonly [string, string] => Boolean(entry))));
    });
    return () => {
      disposed = true;
    };
  }, [artists, desktopSettings.artistPosterFolder]);

  useEffect(() => {
    Promise.all([loadLibraryFolders(), loadLibraryTracks(), loadArtistSplitConfig(), loadSourcePlugins(), loadDesktopSettings()])
      .then(([storedFolders, storedTracks, storedArtistSplitConfig, storedPlugins, storedSettings]) => {
        setFolders(storedFolders);
        setTracks(storedTracks);
        setSelectedFolderPath(storedFolders[0]?.path);
        setSelectedPath(storedTracks[0]?.path);
        setSelectedPaths([]);
        setArtistSplitConfig(storedArtistSplitConfig);
        setPlugins(storedPlugins);
        setDesktopSettings(storedSettings);
      })
      .catch(() => {
        setFolders([]);
        setTracks([]);
        setPlugins([]);
        setDesktopSettings(defaultDesktopSettings);
      });
  }, []);

  useEffect(() => {
    let disposed = false;
    let unlisten: UnlistenFn | undefined;
    void listen<BatchTask>("batch-task-updated", ({ payload }) => {
      if (!disposed && ["succeeded", "failed", "cancelled"].includes(payload.status)) {
        void loadBatchTaskItems(payload.taskId).then(async (items) => {
          const refreshPaths = libraryPathsToRefresh(payload.taskType, items);
          const refreshed = refreshPaths.length ? await loadLibraryTracksByPaths(refreshPaths) : [];
          if (disposed) return;
          if (payload.taskType !== "exportLyrics" && payload.taskType !== "exportCover") {
            invalidateCachedCovers([
              ...items.filter((item) => item.status === "succeeded").map((item) => item.songPath),
              ...refreshPaths,
            ]);
          }
          setTracks((current) => applyBatchLibraryUpdate(current, payload.taskType, items, refreshed));
          const renamedPaths = renamePathMap(items);
          if (payload.taskType === "deleteFiles") {
            const deletedPaths = new Set(
              items
                .filter((item) => item.status === "succeeded")
                .map((item) => normalizePath(item.songPath)),
            );
            setSelectedPath((current) => current && deletedPaths.has(normalizePath(current)) ? undefined : current);
            setSelectedPaths((current) => current.filter((path) => !deletedPaths.has(normalizePath(path))));
            setDetailTrack((current) => current && deletedPaths.has(normalizePath(current.path)) ? undefined : current);
          }
          if (renamedPaths.size === 0) return;
          setSelectedPath((current) => current ? renamedPaths.get(normalizePath(current)) ?? current : current);
          setSelectedPaths((current) => current.map((path) => renamedPaths.get(normalizePath(path)) ?? path));
          setDetailTrack((current) => current && renamedPaths.has(normalizePath(current.path)) ? undefined : current);
        }).catch(() => undefined);
      }
    }).then((dispose) => {
      if (disposed) dispose();
      else unlisten = dispose;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    let unlisten: UnlistenFn | undefined;
    void listen<ScanProgress>("library-scan-progress", ({ payload }) => {
      setScanProgress(payload);
    }).then((dispose) => {
      if (disposed) dispose();
      else unlisten = dispose;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (!scanProgress || scanProgress.status === "running") return;
    const timeout = window.setTimeout(() => setScanProgress(undefined), 4000);
    return () => window.clearTimeout(timeout);
  }, [scanProgress]);

  useEffect(() => {
    if (languagePreference !== "system") return;
    const handleLanguageChange = () => void i18n.changeLanguage(resolveLanguage("system"));
    window.addEventListener("languagechange", handleLanguageChange);
    return () => window.removeEventListener("languagechange", handleLanguageChange);
  }, [i18n, languagePreference]);

  useEffect(() => {
    if (!selectedTrack) {
      form.resetFields();
      return;
    }
    form.resetFields();
    form.setFieldsValue({
      title: selectedTrack.title,
      artist: selectedTrack.artist,
      album: selectedTrack.album,
      albumArtist: selectedTrack.albumArtist,
      trackNumber: selectedTrack.trackNumber,
      discNumber: selectedTrack.discNumber,
      year: selectedTrack.year,
      genre: splitGenreValues(selectedTrack.genre),
      language: selectedTrack.language,
      composer: selectedTrack.composer,
      lyricist: selectedTrack.lyricist,
      copyright: selectedTrack.copyright,
      rating: selectedTrack.rating,
      comment: selectedTrack.comment,
      lyrics: selectedTrack.lyrics,
      replayGainTrackGain: selectedTrack.replayGainTrackGain,
      replayGainTrackPeak: selectedTrack.replayGainTrackPeak,
      replayGainAlbumGain: selectedTrack.replayGainAlbumGain,
      replayGainAlbumPeak: selectedTrack.replayGainAlbumPeak,
      replayGainReferenceLoudness: selectedTrack.replayGainReferenceLoudness,
      coverDataUrl: undefined,
      removeCover: false,
      customTags: detailCustomTags,
    });
  }, [detailCustomTags, form, selectedTrack]);

  async function addFolders() {
    const selectedPaths = await pickPaths({ directory: true, multiple: true, title: t("folders.add") });
    const newPaths = selectedPaths.filter((path) => !folders.some((folder) => samePath(folder.path, path)));
    if (newPaths.length === 0) return;
    for (const path of newPaths) await scanAndMergeFolder(path);
  }

  async function scanAndMergeFolder(path: string) {
    setLoading(true);
    setFolders((current) => upsertFolder(current, { path, trackCount: 0, status: "scanning" }));
    try {
      const folderTracks = await scanFolder(path);
      const scannedAt = new Date().toISOString();
      setTracks((current) => mergeFolderTracks(current, folderTracks, path));
      setFolders((current) =>
        upsertFolder(current, { path, trackCount: folderTracks.length, status: "ready", lastScannedAt: scannedAt }),
      );
      setSelectedFolderPath(path);
      setSelectedPath((current) => current ?? folderTracks[0]?.path);
      message.success(t("messages.scanned", { count: folderTracks.length }));
    } catch (error) {
      const failedFolder = { path, trackCount: 0, status: "error" as const, error: String(error) };
      setFolders((current) => upsertFolder(current, failedFolder));
      await upsertLibraryFolder(failedFolder).catch(() => undefined);
      message.error(String(error));
    } finally {
      setLoading(false);
    }
  }

  const selectTrack = useCallback(function selectTrack(path?: string) {
    setSelectedPath(path);
    if (detailTrack?.path !== path) {
      setDetailTrack(undefined);
      setDetailCustomTags([]);
    }
  }, [detailTrack]);

  const openTrackDetails = useCallback(async function openTrackDetails(path = selectedPath) {
    if (!path) return;
    setSelectedPath(path);
    setDetailsOpen(true);
    if (detailTrack?.path === path) return;

    const requestId = ++detailRequest.current;
    setDetailTrack(undefined);
    setDetailsLoading(true);
    try {
      const [fullTrack, customTags] = await Promise.all([
        loadLibraryTrack(path),
        loadCustomTags(path).catch(() => []),
      ]);
      if (requestId === detailRequest.current) {
        setDetailTrack(fullTrack);
        setDetailCustomTags(customTags);
      }
    } catch (error) {
      if (requestId === detailRequest.current) message.error(String(error));
    } finally {
      if (requestId === detailRequest.current) setDetailsLoading(false);
    }
  }, [selectedPath, detailTrack, message]);

  const refreshSelected = useCallback(async function refreshSelected() {
    if (!selectedTrack) return;
    const requestedPath = selectedTrack.path;
    setLoading(true);
    try {
      const [refreshed, customTags] = await Promise.all([
        readAudioFile(requestedPath),
        loadCustomTags(requestedPath).catch(() => []),
      ]);
      replaceTrack(refreshed);
      if (editingPathRef.current !== requestedPath) return;
      setDetailTrack(refreshed);
      setDetailCustomTags(customTags);
      message.success(t("messages.reloaded"));
    } catch (error) {
      message.error(String(error));
    } finally {
      setLoading(false);
    }
  }, [selectedTrack, t, message]);

  async function saveSelected() {
    if (!selectedTrack) {
      message.warning(t("messages.selectSong"));
      return;
    }
    const requestedPath = selectedTrack.path;
    setSaving(true);
    try {
      await form.validateFields();
      const values = completeTagForm(form.getFieldsValue(true), selectedTrack);
      const saved = await saveAudioTags(requestedPath, values);
      await saveCustomTags(requestedPath, values.customTags);
      replaceTrack(saved);
      setSelectedPath(saved.path);
      if (editingPathRef.current === requestedPath) {
        setDetailTrack(saved);
        setDetailCustomTags(values.customTags);
      }
      message.success(t("messages.saved"));
    } catch (error) {
      message.error(String(error));
    } finally {
      setSaving(false);
    }
  }

  const openBatchForSelection = useCallback(function openBatchForSelection() {
    if (selectedPaths.length === 0) {
      message.warning(t("messages.selectSongs"));
      return;
    }
    setDetailsOpen(false);
    setAlbumDetailsOpen(false);
    setArtistDetailsOpen(false);
    setSelectionMode(false);
    setActiveView("tasks");
  }, [selectedPaths.length, t, message]);

  const changeSelectionMode = useCallback(function changeSelectionMode(enabled: boolean) {
    setSelectedPaths([]);
    setSelectionMode(enabled);
  }, []);

  const onChangeQuery = useCallback(setQuery, []);
  const onChangeSelectedPaths = useCallback(setSelectedPaths, []);

  const onSelectAlbum = useCallback((albumId?: string) => {
    if (albumId) setSelectedAlbumId(albumId);
    setAlbumDetailsOpen(true);
  }, []);

  const onAlbumOpenTrack = useCallback((path: string) => {
    void openTrackDetails(path);
  }, [openTrackDetails]);

  const onAlbumOpenDetails = useCallback(() => setAlbumDetailsOpen(true), []);
  const onAlbumCloseDetails = useCallback(() => setAlbumDetailsOpen(false), []);

  const onSelectArtist = useCallback((artistId?: string) => {
    if (artistId) setSelectedArtistId(artistId);
    setArtistDetailsOpen(true);
  }, []);

  const onArtistOpenTrack = useCallback((path: string) => {
    void openTrackDetails(path);
  }, [openTrackDetails]);

  const onArtistOpenDetails = useCallback(() => setArtistDetailsOpen(true), []);
  const onArtistCloseDetails = useCallback(() => setArtistDetailsOpen(false), []);

  const onRemoveSelectedTrack = useCallback((path: string) => setSelectedPaths((current) => current.filter((candidate) => candidate !== path)), []);
  const onClearSelectedTracks = useCallback(() => setSelectedPaths([]), []);

  async function calculateSelectedReplayGain() {
    if (!selectedTrack || getReplayGainProgress()?.status === "running") return;
    const requestedPath = selectedTrack.path;
    const jobId = crypto.randomUUID();
    publishReplayGainProgress({ jobId, path: requestedPath, percent: 0, status: "running" });
    try {
      const result = await analyzeReplayGain(requestedPath, jobId);
      if (editingPathRef.current !== requestedPath) return;
      form.setFieldsValue({
        replayGainTrackGain: result.trackGain,
        replayGainTrackPeak: result.trackPeak,
        replayGainReferenceLoudness: result.referenceLoudness,
      });
      message.success(t("messages.replayGainCalculated"));
    } catch (error) {
      if (editingPathRef.current !== requestedPath) return;
      if (!String(error).toLocaleLowerCase().includes("cancelled")) message.error(String(error));
    }
  }

  async function cancelActiveReplayGain() {
    const progress = getReplayGainProgress();
    if (progress?.status !== "running") return;
    const batchTaskId = progress.jobId.includes(":") ? progress.jobId.split(":", 1)[0] : undefined;
    const request = batchTaskId?.startsWith("batch-") ? cancelBatchTask(batchTaskId) : cancelReplayGain(progress.jobId);
    await request.catch((error) => message.error(String(error)));
  }

  async function chooseLocalCover() {
    const [selected] = await pickPaths({
      multiple: false,
      title: t("cover.choose"),
      filters: [{ name: t("cover.images"), extensions: ["jpg", "jpeg", "png", "webp", "gif"] }],
    });
    if (!selected) return;
    try {
      const coverDataUrl = await readImageFile(selected);
      form.setFieldsValue({ coverDataUrl, removeCover: false });
    } catch (error) {
      message.error(String(error));
    }
  }

  async function useSameAlbumCover() {
    if (!selectedTrack?.album) return;
    const candidate = tracks.find((track) =>
      track.path !== selectedTrack.path && track.hasCover && track.album === selectedTrack.album,
    );
    if (!candidate) {
      message.warning(t("cover.noAlbumCover"));
      return;
    }
    try {
      const source = await loadLibraryTrack(candidate.path);
      if (!source.coverDataUrl) throw new Error(t("cover.noAlbumCover"));
      form.setFieldsValue({ coverDataUrl: source.coverDataUrl, removeCover: false });
    } catch (error) {
      message.error(String(error));
    }
  }

  function removeSelectedCover() {
    form.setFieldsValue({ coverDataUrl: undefined, removeCover: true });
  }

  function revertSelectedCover() {
    form.setFieldsValue({ coverDataUrl: undefined, removeCover: false });
  }

  async function exportSelectedCover() {
    if (!selectedTrack || form.getFieldValue("removeCover")) {
      message.warning(t("cover.empty"));
      return;
    }
    const dataUrl = String(form.getFieldValue("coverDataUrl") ?? selectedTrack.coverDataUrl ?? "");
    if (!dataUrl) {
      message.warning(t("cover.empty"));
      return;
    }
    const extension = dataUrl.startsWith("data:image/png") ? "png" : dataUrl.startsWith("data:image/webp") ? "webp" : dataUrl.startsWith("data:image/gif") ? "gif" : "jpg";
    const baseName = selectedTrack.fileName.replace(/\.[^.]+$/, "");
    const destination = await pickSavePath({
      title: t("cover.export"),
      defaultPath: `${baseName}-cover.${extension}`,
      filters: [{ name: t("cover.images"), extensions: [extension] }],
    });
    if (!destination) return;
    try {
      await writeImageFile(destination, dataUrl);
      message.success(t("messages.coverExported"));
    } catch (error) {
      message.error(String(error));
    }
  }

  async function importLyricsFile() {
    const [selected] = await pickPaths({
      multiple: false,
      title: t("lyrics.import"),
      filters: [{ name: t("lyrics.files"), extensions: ["lrc", "ttml", "txt"] }],
    });
    if (!selected) return;
    try {
      form.setFieldValue("lyrics", await readTextFile(selected));
      message.success(t("messages.lyricsImported"));
    } catch (error) {
      message.error(String(error));
    }
  }

  async function exportLyricsFile() {
    const lyrics = String(form.getFieldValue("lyrics") ?? "");
    if (!lyrics.trim() || !selectedTrack) {
      message.warning(t("lyrics.empty"));
      return;
    }
    try {
      const extension = await detectLyricsFormat(lyrics) === "ttml" ? "ttml" : "lrc";
      const baseName = selectedTrack.fileName.replace(/\.[^.]+$/, "");
      const destination = await pickSavePath({
        title: t("lyrics.export"),
        defaultPath: `${baseName}.${extension}`,
        filters: [{ name: extension.toUpperCase(), extensions: [extension] }],
      });
      if (!destination) return;
      await writeTextFile(destination, lyrics);
      message.success(t("messages.lyricsExported"));
    } catch (error) {
      message.error(String(error));
    }
  }

  async function removeFolder(path: string) {
    setFolders((current) => current.filter((folder) => !samePath(folder.path, path)));
    setTracks((current) => current.filter((track) => !isTrackUnderFolder(track.path, path)));
    setSelectedPaths((current) => current.filter((trackPath) => !isTrackUnderFolder(trackPath, path)));
    if (samePath(selectedFolderPath ?? "", path)) setSelectedFolderPath(undefined);
    if (selectedPath && isTrackUnderFolder(selectedPath, path)) selectTrack(undefined);
    await removeLibraryFolder(path).catch((error) => message.error(String(error)));
  }

  function replaceTrack(nextTrack: AudioTrack) {
    setTracks((current) => current.map((track) => (samePath(track.path, nextTrack.path) ? nextTrack : track)));
    updateCachedCover(nextTrack.path, nextTrack.coverDataUrl);
  }

  async function installPlugin() {
    const [archivePath] = await pickPaths({
      title: t("sources.install"),
      multiple: false,
      directory: false,
      filters: [{ name: "Lyrico plugin", extensions: ["zip"] }],
    });
    if (!archivePath) return;
    try {
      const result = await installSourcePluginArchive(archivePath);
      setPlugins(await loadSourcePlugins());
      if (result.installed.length) message.success(t("sources.installSuccess", { count: result.installed.length }));
      if (result.failed.length) {
        message.error(result.failed.map((failure) => failure.reason).join("; "));
      }
    } catch (error) {
      message.error(String(error));
      throw error;
    }
  }

  async function changePluginEnabled(pluginId: string, enabled: boolean) {
    try {
      setPlugins(await setSourcePluginEnabled(pluginId, enabled));
    } catch (error) {
      message.error(String(error));
      throw error;
    }
  }

  async function savePluginConfig(pluginId: string, config: Record<string, string>) {
    try {
      setPlugins(await saveSourcePluginSettings(pluginId, config));
      message.success(t("sources.configSaved"));
    } catch (error) {
      message.error(String(error));
      throw error;
    }
  }

  async function shareSelected() {
    if (!selectedTrack) return;
    try {
      await shareFile(fileUrlForShare(selectedTrack.path), {
        mimeType: mimeTypeForTrack(selectedTrack),
        title: selectedTrack.fileName,
      });
      message.success(t("messages.shared"));
    } catch (error) {
      message.error(String(error));
    }
  }

  async function movePluginOrder(pluginId: string, direction: "up" | "down") {
    const index = plugins.findIndex((plugin) => plugin.id === pluginId);
    const nextIndex = direction === "up" ? index - 1 : index + 1;
    if (index < 0 || nextIndex < 0 || nextIndex >= plugins.length) return;
    const ordered = plugins.slice();
    [ordered[index], ordered[nextIndex]] = [ordered[nextIndex], ordered[index]];
    try {
      setPlugins(await setSourcePluginOrder(ordered.map((plugin) => plugin.id)));
    } catch (error) {
      message.error(String(error));
      throw error;
    }
  }

  async function uninstallPlugin(pluginId: string) {
    try {
      setPlugins(await uninstallSourcePlugin(pluginId));
      message.success(t("sources.uninstallSuccess"));
    } catch (error) {
      message.error(String(error));
      throw error;
    }
  }

  function changeLanguage(preference: LanguagePreference) {
    setLanguagePreference(preference);
    void persistLanguagePreference(preference);
  }

  function changeArtistSplitConfig(config: ArtistSplitConfig) {
    setArtistSplitConfig(config);
    artistSplitSaveQueue.current = artistSplitSaveQueue.current
      .then(() => saveArtistSplitConfig(config))
      .catch((error) => {
        message.error(String(error));
      });
  }

  function changeDesktopSettings(settings: DesktopSettings) {
    setDesktopSettings(settings);
    settingsSaveQueue.current = settingsSaveQueue.current
      .then(() => saveDesktopSettings(settings))
      .catch((error) => {
        message.error(String(error));
      });
  }

  function toggleFolderHidden(path: string) {
    const hidden = desktopSettings.hiddenFolderPaths.some((folder) => samePath(folder, path));
    const nextPaths = hidden
      ? desktopSettings.hiddenFolderPaths.filter((folder) => !samePath(folder, path))
      : [...desktopSettings.hiddenFolderPaths, path];
    changeDesktopSettings({ ...desktopSettings, hiddenFolderPaths: nextPaths });
    if (!hidden) {
      const hiddenTrackPaths = new Set(tracks.filter((track) => isTrackUnderFolder(track.path, path)).map((track) => track.path));
      setSelectedPaths((current) => current.filter((candidate) => !hiddenTrackPaths.has(candidate)));
      if (selectedPath && hiddenTrackPaths.has(selectedPath)) selectTrack(undefined);
    }
  }

  function reloadConfig() {
    Promise.all([loadArtistSplitConfig(), loadDesktopSettings()])
      .then(([split, settings]) => {
        setArtistSplitConfig(split);
        setDesktopSettings(settings);
      })
      .catch(() => undefined);
  }

  const changeView = useCallback((view: ViewKey) => {
    setDetailsOpen(false);
    setAlbumDetailsOpen(false);
    setArtistDetailsOpen(false);
    setSelectionMode(false);
    setActiveView(view);
  }, []);

  function renderActivePage() {
    switch (activeView) {
      case "albums":
        return (
          <AlbumsPage
            albums={albums}
            query={query}
            selectedAlbumId={selectedAlbumId}
            detailsOpen={albumDetailsOpen}
            loading={loading}
            onChangeQuery={onChangeQuery}
            onSelectAlbum={onSelectAlbum}
            onSelectTrack={selectTrack}
            onOpenTrack={onAlbumOpenTrack}
            onOpenDetails={onAlbumOpenDetails}
            onCloseDetails={onAlbumCloseDetails}
            selectedPaths={selectedPaths}
            selectionMode={selectionMode}
            onChangeSelectedPaths={onChangeSelectedPaths}
            onChangeSelectionMode={changeSelectionMode}
            onOpenBatch={openBatchForSelection}
          />
        );
      case "artists":
        return (
          <ArtistsPage
            artists={artists}
            query={query}
            selectedArtistId={selectedArtistId}
            detailsOpen={artistDetailsOpen}
            loading={loading}
            onChangeQuery={onChangeQuery}
            onSelectArtist={onSelectArtist}
            onSelectTrack={selectTrack}
            onOpenTrack={onArtistOpenTrack}
            onOpenDetails={onArtistOpenDetails}
            onCloseDetails={onArtistCloseDetails}
            selectedPaths={selectedPaths}
            selectionMode={selectionMode}
            onChangeSelectedPaths={onChangeSelectedPaths}
            onChangeSelectionMode={changeSelectionMode}
            onOpenBatch={openBatchForSelection}
            artistPosters={artistPosters}
          />
        );
      case "folders":
        return (
          <FoldersPage
            folders={folders}
            tracks={tracks}
            selectedFolderPath={selectedFolderPath}
            loading={loading}
            onAddFolders={addFolders}
            onRescanFolder={scanAndMergeFolder}
            onRemoveFolder={removeFolder}
            hiddenFolderPaths={desktopSettings.hiddenFolderPaths}
            onToggleFolderHidden={toggleFolderHidden}
            onSelectFolder={setSelectedFolderPath}
            onSelectTrack={selectTrack}
            onOpenTrack={openTrackDetails}
            selectedPaths={selectedPaths}
            selectionMode={selectionMode}
            onChangeSelectedPaths={onChangeSelectedPaths}
            onChangeSelectionMode={changeSelectionMode}
            onOpenBatch={openBatchForSelection}
          />
        );
      case "sources":
        return (
          <PluginsPage
            plugins={plugins}
            onInstall={installPlugin}
            onChangeEnabled={changePluginEnabled}
            onSaveConfig={savePluginConfig}
            onUninstall={uninstallPlugin}
            onMoveOrder={movePluginOrder}
          />
        );
      case "tasks":
        return (
          <TasksPage
            tracks={tracks}
            plugins={plugins}
            selectedPaths={selectedPaths}
            settings={desktopSettings}
            artistSeparator={artistSplitConfig.artistSeparator}
            onChangeSettings={changeDesktopSettings}
          />
        );
      case "settings":
        return (
          <SettingsPage
            languagePreference={languagePreference}
            artistSplitConfig={artistSplitConfig}
            settings={desktopSettings}
            onChangeLanguage={changeLanguage}
            onChangeArtistSplitConfig={changeArtistSplitConfig}
            onChangeSettings={changeDesktopSettings}
            onReloadConfig={reloadConfig}
          />
        );
      case "songs":
      default:
        return (
          <SongsPage
            tracks={filteredTracks}
            query={query}
            selectedTrack={selectedTrack}
            selectedPaths={selectedPaths}
            loading={loading}
            onChangeQuery={onChangeQuery}
            onSelectTrack={selectTrack}
            onChangeSelectedPaths={onChangeSelectedPaths}
            selectionMode={selectionMode}
            onChangeSelectionMode={changeSelectionMode}
            onOpenBatch={openBatchForSelection}
            onReloadTrack={refreshSelected}
            onOpenDetails={openTrackDetails}
          />
        );
    }
  }

  const activeScrollKey = activeView === "albums" && albumDetailsOpen
    ? `albums:${selectedAlbumId ?? "detail"}`
    : activeView === "artists" && artistDetailsOpen
      ? `artists:${selectedArtistId ?? "detail"}`
      : `${activeView}:root`;

  return (
    <>
    <TitleBar />
    {!detailsOpen ? <Form form={form} component={false} /> : null}
      <Shell
      activeView={activeView}
      folders={folders}
      trackCount={tracks.length}
      scanProgress={scanProgress}
      selectedTracks={selectedTracks}
      onChangeView={changeView}
      onCancelReplayGain={cancelActiveReplayGain}
      onRemoveSelectedTrack={onRemoveSelectedTrack}
      onClearSelectedTracks={onClearSelectedTracks}
      onOpenSelectedBatch={openBatchForSelection}
    >
      <Suspense fallback={<PageFallback />}>
      <PageViewport key={activeView} scrollKey={activeScrollKey} hidden={false}>
        {renderActivePage()}
      </PageViewport>
      {detailsOpen ? <SongDetails
        open={detailsOpen}
        loading={detailsLoading}
        track={selectedTrack}
        plugins={plugins}
        settings={desktopSettings}
        form={form}
        saving={saving}
        onSave={saveSelected}
        onReload={refreshSelected}
        onShare={shareSelected}
        onCalculateReplayGain={calculateSelectedReplayGain}
        onCancelReplayGain={cancelActiveReplayGain}
        onChooseCover={chooseLocalCover}
        onUseSameAlbumCover={useSameAlbumCover}
        onRemoveCover={removeSelectedCover}
        onRevertCover={revertSelectedCover}
        onExportCover={exportSelectedCover}
        onImportLyrics={importLyricsFile}
        onExportLyrics={exportLyricsFile}
        onClose={() => setDetailsOpen(false)}
      /> : null}
      </Suspense>
    </Shell>
    <AppContextMenu onNavigate={changeView} />
    </>
  );
}

function mimeTypeForTrack(track: AudioTrack) {
  const extension = track.fileName.split(".").pop()?.toLowerCase();
  const known: Record<string, string> = {
    mp3: "audio/mpeg",
    flac: "audio/flac",
    m4a: "audio/mp4",
    mp4: "audio/mp4",
    aac: "audio/aac",
    ogg: "audio/ogg",
    opus: "audio/opus",
    wav: "audio/wav",
    aiff: "audio/aiff",
    aif: "audio/aiff",
  };
  return known[extension ?? ""] ?? "application/octet-stream";
}

function upsertFolder(folders: LibraryFolder[], folder: LibraryFolder) {
  const rest = folders.filter((candidate) => !samePath(candidate.path, folder.path));
  return [...rest, folder].sort((left, right) => left.path.localeCompare(right.path));
}

function renamePathMap(items: BatchTaskItem[]) {
  const paths = new Map<string, string>();
  for (const item of items) {
    if (item.status !== "succeeded" || !item.resultJson) continue;
    try {
      const result = JSON.parse(item.resultJson) as { originalPath?: string; newPath?: string };
      if (result.originalPath && result.newPath) paths.set(normalizePath(result.originalPath), result.newPath);
    } catch {
      // Ignore malformed historical task results and keep the current selection unchanged.
    }
  }
  return paths;
}

function mergeFolderTracks(current: AudioTrack[], folderTracks: AudioTrack[], folderPath: string) {
  const remaining = current.filter((track) => !isTrackUnderFolder(track.path, folderPath));
  const seen = new Set<string>();
  return [...remaining, ...folderTracks].filter((track) => {
    const key = normalizePath(track.path);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isTrackUnderFolder(trackPath: string, folderPath: string) {
  return normalizePath(trackPath).startsWith(normalizeFolderPath(folderPath));
}

function samePath(left: string, right: string) {
  return normalizePath(left) === normalizePath(right);
}

function normalizeFolderPath(path: string) {
  const normalized = normalizePath(path);
  return normalized.endsWith("/") ? normalized : `${normalized}/`;
}

function normalizePath(path: string) {
  return path.replace(/\\/g, "/").toLocaleLowerCase();
}
