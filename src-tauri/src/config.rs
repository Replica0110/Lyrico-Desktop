use crate::models::ArtistSplitConfig;
use crate::paths::resolve_data_paths;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;
use tauri::AppHandle;

const CONFIG_SCHEMA_VERSION: u32 = 5;
pub(crate) const REPLAY_GAIN_TARGET_MIN_LUFS: f64 = -30.0;
pub(crate) const REPLAY_GAIN_TARGET_MAX_LUFS: f64 = 0.0;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct DesktopSettings {
    pub(crate) search_page_size: u32,
    pub(crate) replay_gain_target_loudness: f64,
    pub(crate) replay_gain_peak_mode: crate::replay_gain::PeakMode,
    pub(crate) lyric_format: String,
    pub(crate) lyrics_conversion_mode: String,
    pub(crate) show_translation: bool,
    pub(crate) show_romanization: bool,
    pub(crate) only_translation_if_available: bool,
    pub(crate) remove_empty_lyric_lines: bool,
    pub(crate) lyric_line_order: Vec<String>,
    pub(crate) remove_tag_line_keywords: Vec<String>,
    pub(crate) ignore_short_audio: bool,
    pub(crate) lyric_index_enabled: bool,
    pub(crate) hidden_folder_paths: Vec<String>,
    pub(crate) artist_poster_folder: String,
    pub(crate) rename_character_mappings: BTreeMap<String, String>,
    #[serde(alias = "theme")]
    pub(crate) theme_mode: String,
    pub(crate) edit_field_visibility: BTreeMap<String, bool>,
    pub(crate) edit_field_order: Vec<String>,
}

pub(crate) const EDIT_FIELD_KEYS: &[&str] = &[
    "title",
    "artist",
    "albumArtist",
    "album",
    "year",
    "language",
    "genre",
    "trackNumber",
    "discNumber",
    "composer",
    "lyricist",
    "copyright",
    "comment",
    "customTags",
    "rating",
    "lyrics",
    "replayGainTrackGain",
    "replayGainTrackPeak",
    "replayGainAlbumGain",
    "replayGainAlbumPeak",
    "replayGainReferenceLoudness",
];

impl Default for DesktopSettings {
    fn default() -> Self {
        Self {
            search_page_size: 10,
            replay_gain_target_loudness: crate::replay_gain::DEFAULT_TARGET_LOUDNESS_LUFS,
            replay_gain_peak_mode: crate::replay_gain::PeakMode::default(),
            lyric_format: "verbatimLrc".to_string(),
            lyrics_conversion_mode: "none".to_string(),
            show_translation: true,
            show_romanization: true,
            only_translation_if_available: false,
            remove_empty_lyric_lines: true,
            lyric_line_order: default_lyric_line_order(),
            remove_tag_line_keywords: Vec::new(),
            ignore_short_audio: false,
            lyric_index_enabled: true,
            hidden_folder_paths: Vec::new(),
            artist_poster_folder: String::new(),
            rename_character_mappings: default_rename_character_mappings(),
            theme_mode: "system".to_string(),
            edit_field_visibility: BTreeMap::new(),
            edit_field_order: default_edit_field_order(),
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct AppConfig {
    schema_version: u32,
    artist_split: ArtistSplitConfig,
    settings: DesktopSettings,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            schema_version: CONFIG_SCHEMA_VERSION,
            artist_split: ArtistSplitConfig::default(),
            settings: DesktopSettings::default(),
        }
    }
}

pub(crate) fn load_desktop_settings(app: &AppHandle) -> Result<DesktopSettings, String> {
    Ok(normalize_settings(load_config(app)?.settings))
}

pub(crate) fn save_desktop_settings(
    app: &AppHandle,
    settings: DesktopSettings,
) -> Result<(), String> {
    let settings = normalize_settings(settings);
    let mut config = load_config(app)?;
    config.schema_version = CONFIG_SCHEMA_VERSION;
    config.settings = settings;
    write_json(&resolve_data_paths(app)?.settings, &config)
}

fn normalize_settings(mut settings: DesktopSettings) -> DesktopSettings {
    settings.search_page_size = settings.search_page_size.clamp(5, 50);
    if !matches!(
        settings.lyric_format.as_str(),
        "plainLrc" | "verbatimLrc" | "enhancedLrc" | "ttml"
    ) {
        settings.lyric_format = DesktopSettings::default().lyric_format;
    }
    if !matches!(
        settings.lyrics_conversion_mode.as_str(),
        "none" | "traditionalToSimplified" | "simplifiedToTraditional"
    ) {
        settings.lyrics_conversion_mode = DesktopSettings::default().lyrics_conversion_mode;
    }
    settings.rename_character_mappings = normalize_rename_character_mappings(std::mem::take(
        &mut settings.rename_character_mappings,
    ));
    settings.lyric_line_order =
        normalize_lyric_line_order(std::mem::take(&mut settings.lyric_line_order));
    settings.remove_tag_line_keywords =
        normalize_cleanup_keywords(std::mem::take(&mut settings.remove_tag_line_keywords));
    settings.hidden_folder_paths =
        normalize_folder_paths(std::mem::take(&mut settings.hidden_folder_paths));
    settings.artist_poster_folder = settings.artist_poster_folder.trim().to_string();
    settings.edit_field_order =
        normalize_edit_field_order(std::mem::take(&mut settings.edit_field_order));
    if !matches!(settings.theme_mode.as_str(), "system" | "light" | "dark") {
        settings.theme_mode = DesktopSettings::default().theme_mode;
    }
    if !settings.replay_gain_target_loudness.is_finite() {
        settings.replay_gain_target_loudness =
            DesktopSettings::default().replay_gain_target_loudness;
    }
    settings.replay_gain_target_loudness = settings
        .replay_gain_target_loudness
        .clamp(REPLAY_GAIN_TARGET_MIN_LUFS, REPLAY_GAIN_TARGET_MAX_LUFS);
    settings.edit_field_visibility = settings
        .edit_field_visibility
        .into_iter()
        .filter(|(key, _)| EDIT_FIELD_KEYS.contains(&key.as_str()))
        .collect();
    settings
}

fn default_rename_character_mappings() -> BTreeMap<String, String> {
    [
        ('\\', "＼"),
        ('/', "／"),
        (':', "："),
        ('*', "＊"),
        ('?', "？"),
        ('"', "＂"),
        ('<', "＜"),
        ('>', "＞"),
        ('|', "｜"),
    ]
    .into_iter()
    .map(|(character, replacement)| (character.to_string(), replacement.to_string()))
    .collect()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PluginBackup {
    pub(crate) id: String,
    pub(crate) enabled: bool,
    pub(crate) sort_order: i32,
    pub(crate) settings_json: String,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct ConfigBackup {
    schema_version: u32,
    artist_split: ArtistSplitConfig,
    settings: DesktopSettings,
    plugins: Vec<PluginBackup>,
}

fn default_lyric_line_order() -> Vec<String> {
    ["original", "romanization", "translation"]
        .into_iter()
        .map(str::to_string)
        .collect()
}

fn normalize_lyric_line_order(order: Vec<String>) -> Vec<String> {
    let mut normalized = Vec::new();
    for value in order.into_iter().chain(
        ["original", "romanization", "translation"]
            .into_iter()
            .map(str::to_string),
    ) {
        if matches!(value.as_str(), "original" | "translation" | "romanization")
            && !normalized.iter().any(|item| item == &value)
        {
            normalized.push(value);
        }
    }
    normalized
}

fn normalize_cleanup_keywords(keywords: Vec<String>) -> Vec<String> {
    let mut normalized = Vec::new();
    for keyword in keywords {
        let keyword = keyword.trim();
        if !keyword.is_empty() && !normalized.iter().any(|item| item == keyword) {
            normalized.push(keyword.to_string());
        }
    }
    normalized
}

fn normalize_folder_paths(paths: Vec<String>) -> Vec<String> {
    let mut normalized = Vec::new();
    for path in paths {
        let path = path.trim();
        if !path.is_empty()
            && !normalized
                .iter()
                .any(|item: &String| item.eq_ignore_ascii_case(path))
        {
            normalized.push(path.to_string());
        }
    }
    normalized
}

fn default_edit_field_order() -> Vec<String> {
    EDIT_FIELD_KEYS.iter().map(|key| key.to_string()).collect()
}

fn normalize_edit_field_order(order: Vec<String>) -> Vec<String> {
    let mut normalized = Vec::new();
    for value in order.into_iter().chain(default_edit_field_order()) {
        let expanded: Vec<&str> = match value.as_str() {
            "basic" => vec![
                "title",
                "artist",
                "albumArtist",
                "album",
                "year",
                "language",
                "genre",
            ],
            "track" => vec!["trackNumber", "discNumber"],
            "credits" => vec!["composer", "lyricist", "copyright", "comment"],
            "replaygain" => vec![
                "replayGainTrackGain",
                "replayGainTrackPeak",
                "replayGainAlbumGain",
                "replayGainAlbumPeak",
                "replayGainReferenceLoudness",
            ],
            "cover" => vec!["rating"],
            key => vec![key],
        };
        for key in expanded {
            if EDIT_FIELD_KEYS.contains(&key) && !normalized.iter().any(|item| item == key) {
                normalized.push(key.to_string());
            }
        }
    }
    normalized
}

fn normalize_rename_character_mappings(
    mappings: BTreeMap<String, String>,
) -> BTreeMap<String, String> {
    let mut normalized = default_rename_character_mappings();
    for (character, replacement) in mappings {
        if normalized.contains_key(&character) {
            normalized.insert(character, replacement);
        }
    }
    normalized
}

pub(crate) fn load_artist_split_config(app: &AppHandle) -> Result<ArtistSplitConfig, String> {
    Ok(load_config(app)?.artist_split)
}

pub(crate) fn save_artist_split_config(
    app: &AppHandle,
    artist_split: ArtistSplitConfig,
) -> Result<(), String> {
    let mut config = load_config(app)?;
    config.schema_version = CONFIG_SCHEMA_VERSION;
    config.artist_split = artist_split;
    let path = resolve_data_paths(app)?.settings;
    write_json(&path, &config)
}

pub(crate) fn export_config(
    app: &AppHandle,
    destination: &Path,
    plugins: Vec<PluginBackup>,
) -> Result<(), String> {
    let config = load_config(app)?;
    write_json(
        destination,
        &ConfigBackup {
            schema_version: CONFIG_SCHEMA_VERSION,
            artist_split: config.artist_split,
            settings: normalize_settings(config.settings),
            plugins,
        },
    )
}

pub(crate) fn import_config(
    app: &AppHandle,
    source: &Path,
) -> Result<(DesktopSettings, Vec<PluginBackup>), String> {
    let contents = fs::read_to_string(source).map_err(|error| error.to_string())?;
    let mut backup: ConfigBackup = serde_json::from_str(&contents).map_err(|error| {
        format!(
            "Failed to parse the configuration backup at {}: {error}",
            source.display()
        )
    })?;
    backup.schema_version = CONFIG_SCHEMA_VERSION;
    let mut config = AppConfig {
        schema_version: backup.schema_version,
        artist_split: backup.artist_split,
        settings: backup.settings,
    };
    config.settings = normalize_settings(config.settings);
    write_json(&resolve_data_paths(app)?.settings, &config)?;
    Ok((load_desktop_settings(app)?, backup.plugins))
}

pub(crate) fn migrate_legacy_artist_split_config(
    app: &AppHandle,
    legacy_value: Option<String>,
) -> Result<(), String> {
    let path = resolve_data_paths(app)?.settings;
    if path.exists() {
        return Ok(());
    }
    let Some(legacy_value) = legacy_value else {
        return Ok(());
    };
    let artist_split = serde_json::from_str(&legacy_value).map_err(|error| {
        format!("Failed to migrate the legacy artist split configuration: {error}")
    })?;
    write_json(
        &path,
        &AppConfig {
            schema_version: CONFIG_SCHEMA_VERSION,
            artist_split,
            settings: DesktopSettings::default(),
        },
    )
}

fn load_config(app: &AppHandle) -> Result<AppConfig, String> {
    load_config_from(&resolve_data_paths(app)?.settings)
}

fn load_config_from(path: &Path) -> Result<AppConfig, String> {
    let backup = path.with_extension("json.bak");
    if !path.exists() {
        if backup.exists() {
            crate::logging::event(
                log::Level::Warn,
                "config",
                "backup.recovery",
                serde_json::json!({"reason":"primary configuration missing"}),
            );
            return parse_config_file(&backup).map_err(|error| {
                format!(
                    "Application configuration at {} is missing and the backup at {} could not be read: {error}",
                    path.display(),
                    backup.display()
                )
            });
        }
        return Ok(AppConfig::default());
    }
    parse_config_file(path).or_else(|error| {
        if !backup.exists() {
            return Err(error);
        }
        crate::logging::event(
            log::Level::Warn,
            "config",
            "backup.recovery",
            serde_json::json!({"error":error}),
        );
        parse_config_file(&backup).map_err(|_| error)
    })
}

fn parse_config_file(path: &Path) -> Result<AppConfig, String> {
    let contents = fs::read_to_string(path).map_err(|error| error.to_string())?;
    serde_json::from_str(&contents).map_err(|error| {
        format!(
            "Failed to parse application configuration at {}: {error}",
            path.display()
        )
    })
}

fn write_json(path: &Path, value: &impl Serialize) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(value).map_err(|error| error.to_string())?;
    let temporary = path.with_extension("json.tmp");
    let backup = path.with_extension("json.bak");
    let mut file = OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(&temporary)
        .map_err(|error| error.to_string())?;
    file.write_all(&bytes).map_err(|error| error.to_string())?;
    file.sync_all().map_err(|error| error.to_string())?;
    if path.exists() {
        fs::copy(path, &backup).map_err(|error| error.to_string())?;
    }
    fs::rename(&temporary, path).map_err(|error| error.to_string())
}
