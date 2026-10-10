import { ApiOutlined, AudioOutlined, EditOutlined, FileTextOutlined, FolderOpenOutlined, GlobalOutlined, InfoCircleOutlined, ImportOutlined, ExportOutlined, ScissorOutlined, SoundOutlined } from "@ant-design/icons";
import { App as AntApp, Avatar, Button, Flex, Input, InputNumber, Modal, Select, Space, Switch, Tabs, Typography } from "antd";
import { openUrl } from "@tauri-apps/plugin-opener";
import { getVersion } from "@tauri-apps/api/app";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { ArtistSplitConfig, DesktopSettings, LyricLineTrack } from "../app/types";
import type { LanguagePreference } from "../i18n";
import { SortableList } from "../components/SortableList";
import appIcon from "../assets/app-icon.png";
import { ArtistSplitSettings } from "../components/ArtistSplitSettings";
import { PageHeader } from "../components/PageHeader";
import { exportConfig, importConfig, openLogsDirectory, pickPaths, pickSavePath, type ThemeMode } from "../backend/audioApi";
import { normalizeCleanupKeywords, normalizeLyricLineOrder } from "../domain/lyricsSettings";
import { normalizeEditFieldOrder, EDIT_FIELD_LABEL_KEYS, REPLAY_GAIN_BLOCK_KEY, toEditFieldBlocks, withEditFieldBlockMembers } from "../domain/editFieldSettings";
import { CONTRIBUTORS } from "../data/contributors";

const { Text } = Typography;

function LyricLineOrderEditor({ value, onChange }: { value: LyricLineTrack[]; onChange: (value: LyricLineTrack[]) => void }) {
  const { t } = useTranslation();
  const labels: Record<LyricLineTrack, string> = {
    original: t("settings.lyricOriginal"),
    romanization: t("settings.lyricRomanization"),
    translation: t("settings.lyricTranslation"),
  };
  return <SortableList items={value} label={t("settings.lyricLineOrder")} labelFor={key => labels[key as LyricLineTrack]}
    onChange={next => onChange(next as LyricLineTrack[])} renderItem={key => <Text>{labels[key as LyricLineTrack]}</Text>} />;

}

export function SettingsPage({
  languagePreference,
  artistSplitConfig,
  settings,
  onChangeLanguage,
  onChangeArtistSplitConfig,
  onChangeSettings,
  onReloadConfig,
}: {
  languagePreference: LanguagePreference;
  artistSplitConfig: ArtistSplitConfig;
  settings: DesktopSettings;
  onChangeLanguage: (language: LanguagePreference) => void;
  onChangeArtistSplitConfig: (config: ArtistSplitConfig) => void;
  onChangeSettings: (settings: DesktopSettings) => void;
  onReloadConfig: () => void;
}) {
  const { t } = useTranslation();
  const update = <K extends keyof DesktopSettings>(key: K, value: DesktopSettings[K]) => onChangeSettings({ ...settings, [key]: value });

  return (
    <div className="page-shell settings-view">
      <PageHeader title={t("settings.title")} />

      <div className="page-body settings-body">
        <Tabs
          className="settings-tabs"
          tabPlacement="start"
          items={[
            {
              key: "interface",
              label: t("settings.interface"),
              icon: <GlobalOutlined />,
              children: (
                <SettingsSection title={t("settings.interface")}>
                  <SettingRow title={t("settings.language")} description={t("settings.languageHint")}>
                    <Select<LanguagePreference>
                      value={languagePreference}
                      onChange={onChangeLanguage}
                      options={[
                        { value: "system", label: t("settings.systemLanguage") },
                        { value: "en-US", label: t("settings.english") },
                        { value: "zh-CN", label: t("settings.chinese") },
                      ]}
                    />
                  </SettingRow>
                  <SettingRow title={t("settings.themeMode")} description={t("settings.themeModeHint")}>
                    <Select<ThemeMode>
                      value={settings.themeMode ?? "system"}
                      onChange={(value) => update("themeMode", value)}
                      options={[
                        { value: "system", label: t("settings.themeSystem") },
                        { value: "light", label: t("settings.themeLight") },
                        { value: "dark", label: t("settings.themeDark") },
                      ]}
                    />
                  </SettingRow>
                </SettingsSection>
              ),
            },
            {
              key: "online",
              label: t("settings.onlineSearch"),
              icon: <ApiOutlined />,
              children: (
                <SettingsSection title={t("settings.onlineSearch")}>
                  <SettingRow title={t("settings.searchPageSize")} description={t("settings.searchPageSizeHint")}>
                    <InputNumber min={5} max={50} precision={0} value={settings.searchPageSize} onChange={(value) => update("searchPageSize", value ?? 10)} />
                  </SettingRow>
                </SettingsSection>
              ),
            },
            {
              key: "lyrics",
              label: t("settings.lyricsSettings"),
              icon: <SoundOutlined />,
              children: (
                <SettingsSection title={t("settings.lyricsSettings")}>
                  <SettingRow title={t("settings.defaultLyricFormat")} description={t("settings.defaultLyricFormatHint")}>
                    <Select value={settings.lyricFormat} onChange={(value) => update("lyricFormat", value)} options={[
                      { value: "plainLrc", label: t("lyrics.formats.plainLrc") },
                      { value: "verbatimLrc", label: t("lyrics.formats.verbatimLrc") },
                      { value: "enhancedLrc", label: t("lyrics.formats.enhancedLrc") },
                      { value: "ttml", label: t("lyrics.formats.ttml") },
                    ]} />
                  </SettingRow>
                  <SettingRow title={t("settings.lyricsConversionMode")} description={t("settings.lyricsConversionModeHint")}>
                    <Select value={settings.lyricsConversionMode} onChange={(value) => update("lyricsConversionMode", value)} options={[
                      { value: "none", label: t("settings.conversionNone") },
                      { value: "traditionalToSimplified", label: t("settings.conversionTraditionalToSimplified") },
                      { value: "simplifiedToTraditional", label: t("settings.conversionSimplifiedToTraditional") },
                    ]} />
                  </SettingRow>
                  <SettingRow title={t("settings.includeTranslation")} description={t("settings.includeTranslationHint")}><Switch checked={settings.showTranslation} onChange={(value) => onChangeSettings({ ...settings, showTranslation: value, onlyTranslationIfAvailable: value ? settings.onlyTranslationIfAvailable : false })} /></SettingRow>
                  <SettingRow title={t("settings.onlyTranslation")} description={t("settings.onlyTranslationHint")}><Switch disabled={!settings.showTranslation} checked={settings.onlyTranslationIfAvailable} onChange={(value) => update("onlyTranslationIfAvailable", value)} /></SettingRow>
                  <SettingRow title={t("settings.includeRomanization")} description={t("settings.includeRomanizationHint")}><Switch checked={settings.showRomanization} onChange={(value) => update("showRomanization", value)} /></SettingRow>
                  <SettingRow title={t("settings.removeEmptyLyricLines")} description={t("settings.removeEmptyLyricLinesHint")}><Switch checked={settings.removeEmptyLyricLines} onChange={(value) => update("removeEmptyLyricLines", value)} /></SettingRow>
                  <SettingRow title={t("settings.lyricLineOrder")} description={t("settings.lyricLineOrderHint")}>
                    <LyricLineOrderEditor
                      value={normalizeLyricLineOrder(settings.lyricLineOrder)}
                      onChange={(value) => update("lyricLineOrder", value)}
                    />
                  </SettingRow>
                  <SettingRow title={t("settings.cleanupKeywords")} description={t("settings.cleanupKeywordsHint")}>
                    <CleanupKeywordsEditor
                      keywords={settings.removeTagLineKeywords}
                      onChange={(value) => update("removeTagLineKeywords", value)}
                    />
                  </SettingRow>
                </SettingsSection>
              ),
            },
            {
              key: "library",
              label: t("settings.library"),
              icon: <ScissorOutlined />,
              children: (
                <SettingsSection title={t("settings.library")}>
                  <SettingRow title={t("settings.artistPosterFolder")} description={t("settings.artistPosterFolderHint")}>
                    <Space wrap className="settings-path-control">
                      <Text type="secondary" ellipsis={{ tooltip: settings.artistPosterFolder }} style={{ maxWidth: 260 }}>{settings.artistPosterFolder || t("settings.artistPosterFolderNone")}</Text>
                      <Button
                        icon={<FolderOpenOutlined />}
                        onClick={async () => {
                          const [selected] = await pickPaths({ directory: true, multiple: false, title: t("settings.artistPosterFolder") });
                          if (selected) update("artistPosterFolder", selected);
                        }}
                      >
                        {t("settings.chooseFolder")}
                      </Button>
                    </Space>
                  </SettingRow>
                  <SettingRow title={t("settings.ignoreShortAudio")} description={t("settings.ignoreShortAudioHint")}>
                    <Switch checked={settings.ignoreShortAudio} onChange={(value) => update("ignoreShortAudio", value)} />
                  </SettingRow>
                  <SettingRow title={t("settings.lyricIndex")} description={t("settings.lyricIndexHint")}>
                    <Switch checked={settings.lyricIndexEnabled} onChange={(value) => update("lyricIndexEnabled", value)} />
                  </SettingRow>
                  <ArtistSplitSettings config={artistSplitConfig} onChange={onChangeArtistSplitConfig} />
                </SettingsSection>
              ),
            },
            {
              key: "editFields",
              label: t("settings.editFields"),
              icon: <EditOutlined />,
              children: (
                  <SettingsSection title={t("settings.editFields")}>
                    <EditFieldOrderEditor settings={settings} onChange={onChangeSettings} />
                  </SettingsSection>
              ),
            },
            {
              key: "audio",
              label: t("settings.audio"),
              icon: <AudioOutlined />,
              children: (
                <SettingsSection title={t("settings.replayGain")}>
                  <SettingRow title={t("settings.replayGainTarget")} description={t("settings.replayGainTargetHint")}>
                    <Flex gap={8} align="center">
                      <InputNumber
                        min={-30}
                        max={0}
                        step={0.5}
                        precision={1}
                        value={settings.replayGainTargetLoudness ?? -18}
                        onChange={(value) => update("replayGainTargetLoudness", value ?? -18)}
                      />
                      <Text type="secondary">LUFS</Text>
                    </Flex>
                  </SettingRow>
                  <SettingRow title={t("settings.replayGainPeakMode")} description={t("settings.replayGainPeakHint")}>
                    <Select value={settings.replayGainPeakMode ?? "samplePeak"} onChange={value => update("replayGainPeakMode", value)} options={[
                      { value: "samplePeak", label: t("settings.replayGainSamplePeak") },
                      { value: "truePeak", label: t("settings.replayGainTruePeak") },
                    ]} />
                  </SettingRow>
                </SettingsSection>
              ),
            },
            {
              key: "backup",
              label: t("settings.backup"),
              icon: <ExportOutlined />,
              children: (
                <SettingsSection title={t("settings.backup")}>
                  <SettingRow title={t("settings.exportConfig")} description={t("settings.exportConfigHint")}>
                    <BackupExportButton />
                  </SettingRow>
                  <SettingRow title={t("settings.importConfig")} description={t("settings.importConfigHint")}>
                    <BackupImportButton onImported={onReloadConfig} />
                  </SettingRow>
                </SettingsSection>
              ),
            },
            {
              key: "logs",
              label: t("settings.logs"),
              icon: <FileTextOutlined />,
              children: (
                <AppLogsSection />
              ),
            },
            {
              key: "about",
              label: t("settings.about"),
              icon: <InfoCircleOutlined />,
              children: <AboutSection />,
            },
          ]}
        />
      </div>
    </div>
  );
}

function SettingsSection({ title, children }: { title: string; children: ReactNode }) {
  return <section className="settings-section"><Typography.Title level={4}>{title}</Typography.Title>{children}</section>;
}

/**
 * Field order editor. Ordering works on blocks, not raw fields: the ReplayGain values are one
 * measurement and always move as one adjacent group. A composite row opens a dialog to reorder
 * and toggle its members, mirroring the mobile app's component sheet. See docs/ui-layout.md §9.6.
 */
function EditFieldOrderEditor({ settings, onChange }: { settings: DesktopSettings; onChange: (settings: DesktopSettings) => void }) {
  const { t } = useTranslation();
  const [openBlock, setOpenBlock] = useState<string>();
  const blocks = useMemo(() => toEditFieldBlocks(normalizeEditFieldOrder(settings.editFieldOrder)), [settings.editFieldOrder]);
  const labelOf = (key: string) => t(EDIT_FIELD_LABEL_KEYS.find(([field]) => field === key)?.[1] ?? key);
  const shown = (key: string) => settings.editFieldVisibility?.[key] !== false;
  const setShown = (key: string, checked: boolean) =>
    onChange({ ...settings, editFieldVisibility: { ...settings.editFieldVisibility, [key]: checked } });
  const setMembersShown = (members: readonly string[], checked: boolean) =>
    onChange({ ...settings, editFieldVisibility: { ...settings.editFieldVisibility, ...Object.fromEntries(members.map((key) => [key, checked])) } });

  const composite = blocks.find((block) => block.key === openBlock && block.composite);

  return (
    <>
      <SortableList
        items={blocks.map((block) => block.key)}
        label={t("settings.editFields")}
        labelFor={(key) => (key === REPLAY_GAIN_BLOCK_KEY ? t("settings.replayGain") : labelOf(key))}
        onChange={(keys) => {
          const byKey = new Map(blocks.map((block) => [block.key, block]));
          onChange({ ...settings, editFieldOrder: keys.flatMap((key) => byKey.get(key)?.fields ?? []) });
        }}
        renderItem={(key) => {
          const block = blocks.find((candidate) => candidate.key === key);
          if (!block?.composite) {
            return <>
              <Text>{labelOf(key)}</Text>
              <Switch
                size="small"
                aria-label={t("settings.showField", { name: labelOf(key) })}
                checked={shown(key)}
                onChange={(checked) => setShown(key, checked)}
              />
            </>;
          }
          const allShown = block.fields.every(shown);
          return <>
            <button type="button" className="edit-field-group-open" onClick={() => setOpenBlock(block.key)}>
              <Text>{t("settings.replayGain")}</Text>
              <span className="edit-field-tag">{t("settings.fieldGroupTag")}</span>
            </button>
            <Switch
              size="small"
              aria-label={t("settings.showField", { name: t("settings.replayGain") })}
              checked={allShown}
              onChange={(checked) => setMembersShown(block.fields, checked)}
            />
          </>;
        }}
      />

      <Modal centered
        open={Boolean(composite)}
        title={t("settings.replayGain")}
        footer={null}
        width={420}
        onCancel={() => setOpenBlock(undefined)}
      >
        <Text type="secondary" className="edit-field-group-hint">{t("settings.groupMembersHint")}</Text>
        {composite ? (
          <SortableList
            items={composite.fields}
            label={t("settings.replayGain")}
            labelFor={labelOf}
            onChange={(members) => onChange({
              ...settings,
              editFieldOrder: withEditFieldBlockMembers(settings.editFieldOrder, composite.key, members),
            })}
            renderItem={(field) => <>
              <Text>{labelOf(field)}</Text>
              <Switch
                size="small"
                aria-label={t("settings.showField", { name: labelOf(field) })}
                checked={shown(field)}
                onChange={(checked) => setShown(field, checked)}
              />
            </>}
          />
        ) : null}
      </Modal>
    </>
  );
}

function SettingRow({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <div className="setting-row">
      <div className="setting-row-copy"><Text strong>{title}</Text>{description ? <Text type="secondary">{description}</Text> : null}</div>
      <div className="setting-row-control">{children}</div>
    </div>
  );
}

function CleanupKeywordsEditor({ keywords, onChange }: { keywords: string[] | undefined; onChange: (value: string[]) => void }) {
  const [draft, setDraft] = useState(() => (keywords ?? []).join("\n"));
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    if (!editing) setDraft((keywords ?? []).join("\n"));
  }, [keywords, editing]);

  function commit() {
    const next = normalizeCleanupKeywords(draft.split(/\r?\n/));
    setDraft(next.join("\n"));
    onChange(next);
    setEditing(false);
  }

  return (
    <Input.TextArea
      value={draft}
      autoSize={{ minRows: 2, maxRows: 6 }}
      onChange={(event) => setDraft(event.target.value)}
      onFocus={() => setEditing(true)}
      onBlur={commit}
    />
  );
}

function BackupExportButton() {
  const { t } = useTranslation();
  const { message } = AntApp.useApp();
  const [busy, setBusy] = useState(false);

  async function handleExport() {
    let destination: string | null = null;
    try {
      destination = await pickSavePath({
        title: t("settings.exportConfig"),
        defaultPath: "lyrico-config-backup.json",
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
    } catch {
      destination = null;
    }
    if (!destination) return;
    setBusy(true);
    try {
      await exportConfig(destination);
      message.success(t("settings.exported"));
    } catch (error) {
      message.error(String(error));
    } finally {
      setBusy(false);
    }
  }

  return <Button icon={<ExportOutlined />} loading={busy} onClick={() => void handleExport()}>{t("settings.exportConfig")}</Button>;
}

function BackupImportButton({ onImported }: { onImported: () => void }) {
  const { t } = useTranslation();
  const { message } = AntApp.useApp();
  const [busy, setBusy] = useState(false);

  async function handleImport() {
    let source: string | string[] | null = null;
    try {
      source = (await pickPaths({
        title: t("settings.importConfig"),
        multiple: false,
        directory: false,
        filters: [{ name: "JSON", extensions: ["json"] }],
      }))[0] ?? null;
    } catch {
      source = null;
    }
    if (typeof source !== "string") return;
    setBusy(true);
    try {
      await importConfig(source);
      onImported();
      message.success(t("settings.imported"));
    } catch (error) {
      message.error(String(error));
    } finally {
      setBusy(false);
    }
  }

  return <Button icon={<ImportOutlined />} loading={busy} onClick={() => void handleImport()}>{t("settings.importConfig")}</Button>;
}

function AppLogsSection() {
  const { t } = useTranslation();
  const { message } = AntApp.useApp();
  const [opening, setOpening] = useState(false);
  async function openDirectory() {
    setOpening(true);
    try { await openLogsDirectory(); }
    catch (error) { void message.error(String(error)); }
    finally { setOpening(false); }
  }
  return <SettingsSection title={t("settings.logs")}>
    <SettingRow title={t("settings.logsDirectory")} description={t("settings.logsFileHint")}>
      <Button icon={<FolderOpenOutlined />} loading={opening} onClick={() => void openDirectory()}>{t("settings.logsOpenDirectory")}</Button>
    </SettingRow>
  </SettingsSection>;
}

const OPEN_SOURCE_DEPENDENCIES = [
  { name: "Tauri", license: "Apache-2.0 OR MIT" },
  { name: "React / React DOM", license: "MIT" },
  { name: "Ant Design", license: "MIT" },
  { name: "i18next / react-i18next", license: "MIT" },
  { name: "rusqlite", license: "MIT" },
  { name: "symphonia", license: "MPL-2.0" },
  { name: "ebur128", license: "MIT" },
  { name: "TagLib", license: "LGPL-2.1 OR MPL-1.1" },
  { name: "rquickjs", license: "MIT" },
  { name: "reqwest", license: "MIT OR Apache-2.0" },
  { name: "image", license: "MIT OR Apache-2.0" },
  { name: "rayon", license: "MIT OR Apache-2.0" },
];

function AboutSection() {
  const { t } = useTranslation();
  const [version, setVersion] = useState("");

  useEffect(() => {
    getVersion()
      .then((value) => setVersion(value))
      .catch(() => setVersion(""));
  }, []);

  return (
    <section className="about-page">
      <img className="about-app-icon" src={appIcon} alt="" />
      <Typography.Title level={2}>Lyrico</Typography.Title>
      <Text type="secondary">{t("settings.version")} {version || "—"}</Text>
      <Typography.Paragraph>{t("settings.aboutDescription")}</Typography.Paragraph>
      <div className="about-links">
        <Button type="link" onClick={() => void openUrl("https://github.com/Replica0110/Lyrico-Desktop")}>{t("settings.projectHomepage")}</Button>
        <Button type="link" onClick={() => void openUrl("https://github.com/Replica0110/Lyrico-Desktop/issues")}>{t("settings.reportIssue")}</Button>
      </div>
      <section className="about-section">
        <Typography.Title level={3}>{t("settings.contributors")}</Typography.Title>
        <ContributorsSection />
      </section>
      <section className="about-section">
        <Typography.Title level={3}>{t("settings.openSourceLicenses")}</Typography.Title>
        <ul className="about-license-list">{OPEN_SOURCE_DEPENDENCIES.map(dependency => <li key={dependency.name}><Text>{dependency.name}</Text><Text type="secondary">{dependency.license}</Text></li>)}</ul>
      </section>
    </section>
  );
}

function ContributorsSection() {
  return <div className="contributor-list">{CONTRIBUTORS.map(contributor => <button key={contributor.name} type="button" className="contributor-row" onClick={() => void openUrl(contributor.url)}>
    <Avatar src={contributor.avatar} size={36}>{contributor.name[0]}</Avatar>
    <Text>{contributor.name}</Text>
  </button>)}</div>;
}
