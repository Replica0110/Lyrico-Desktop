use super::lyrics::render_plugin_lyrics;
use super::processor::{BatchProcessor, ProcessContext, ProcessError, ProcessOutcome};
use crate::audio::{read_track, save_tags, ArtworkMode};
use crate::lyrics::LineTrack;
use crate::models::{AudioTrack, TagUpdate};
use crate::paths::resolve_data_paths;
use crate::plugins::manifest::SourcePlugin;
use crate::plugins::{installer, runtime};
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use regex::Regex;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::atomic::Ordering;
use std::sync::LazyLock;
use std::time::Duration;

static VERSION_NOISE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)[(\[（【《]?\s*(?:official\s*(?:video|audio|mv)|music\s*video|lyric[s]?\s*video|lyrics?|完整版|高清|无损|动态歌词|歌词版|instrumental|inst\.?|off\s*vocal|伴奏|纯音乐|live|现场版?|remix|remaster(?:ed)?|acoustic|cover|sped\s*up|slowed|nightcore|demo|edit|radio\s*edit|deluxe|bonus\s*track)\s*[)\]）】》]?"#).unwrap()
});
static CLEAN_PUNCTUATION: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"[【】\[\]（）()《》<>「」『』"'\-–—~·・]"#).unwrap());
static NORMALIZE_PUNCTUATION: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"[._/\\|,:;，。！？!?#&＆]+"#).unwrap());
static SEGMENT_SPLIT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)\s*[-–—－/、,，&＆+×|｜]\s*|\s+_\s+|_-_|\s+(?:x|and|feat\.?|ft\.?|featuring|with)\s+"#).unwrap()
});
static LEADING_TRACK_NUMBER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"^\d+[.\s\-_]+"#).unwrap());
static TRAILING_COPY_NUMBER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"\(\d+\)$"#).unwrap());

const DEFAULT_TARGETS: &[&str] = &[
    "title",
    "artist",
    "album",
    "genre",
    "date",
    "track_number",
    "lyrics",
    "cover_url",
];

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MatchConfig {
    #[serde(default)]
    target_modes: HashMap<String, String>,
    #[serde(default)]
    enabled_source_order_ids: Vec<String>,
    #[serde(default)]
    prefer_file_name: bool,
    #[serde(default = "default_separator")]
    separator: String,
    #[serde(default = "default_lyric_format")]
    lyric_format: String,
    #[serde(default = "default_true")]
    show_translation: bool,
    #[serde(default = "default_true")]
    show_romanization: bool,
    #[serde(default)]
    only_translation_if_available: bool,
    #[serde(default = "default_true")]
    remove_empty_lyric_lines: bool,
    #[serde(default)]
    lyric_line_order: Vec<LineTrack>,
    #[serde(default)]
    remove_tag_line_keywords: Vec<String>,
    #[serde(default = "default_conversion_mode")]
    lyrics_conversion_mode: String,
}

fn default_separator() -> String {
    "/".to_string()
}

fn default_lyric_format() -> String {
    "verbatimLrc".to_string()
}

fn default_conversion_mode() -> String {
    "none".to_string()
}

fn default_true() -> bool {
    true
}

pub(super) struct MatchMetadataProcessor;

impl BatchProcessor for MatchMetadataProcessor {
    fn process(
        &self,
        context: ProcessContext<'_>,
        on_progress: &mut dyn FnMut(f64),
    ) -> Result<ProcessOutcome, ProcessError> {
        if context.cancelled.load(Ordering::Relaxed) {
            return Err(ProcessError::Cancelled("Batch item cancelled".to_string()));
        }
        let config = parse_config(context.task.config_json.as_deref())?;
        if config.target_modes.values().all(|mode| mode == "disabled") {
            return Err(ProcessError::Skipped(
                "No fields need processing".to_string(),
            ));
        }
        let current = read_track(
            Path::new(&context.item.song_path),
            context.artist_separator,
            ArtworkMode::None,
        )
        .map_err(|error| ProcessError::Failed(error.to_string()))?;
        let paths = resolve_data_paths(context.app).map_err(ProcessError::Failed)?;
        let plugins = tauri::async_runtime::block_on(installer::load_plugins(
            context.database,
            &paths.plugins,
            None,
        ))
        .map_err(ProcessError::Failed)?;
        let plugins = ordered_search_plugins(plugins, &config.enabled_source_order_ids);
        if plugins.is_empty() {
            return Err(ProcessError::Skipped(
                "No enabled metadata source".to_string(),
            ));
        }

        let queries = build_search_queries(&current, config.prefer_file_name);
        if queries.is_empty() {
            return Err(ProcessError::Skipped("No usable search query".to_string()));
        }
        on_progress(0.05);
        let mut best: Option<MatchCandidate<'_>> = None;
        'search: for (query_index, query) in queries.iter().enumerate() {
            for (source_index, plugin) in plugins.iter().enumerate() {
                if context.cancelled.load(Ordering::Relaxed) {
                    return Err(ProcessError::Cancelled("Batch item cancelled".to_string()));
                }
                let response = runtime::invoke(
                    plugin,
                    "searchSongs",
                    json!({
                        "keyword": query,
                        "page": 1,
                        "pageSize": 2,
                        "separator": config.separator,
                        "config": plugin.config,
                    }),
                    None,
                );
                match response {
                    Ok(response) => {
                        for (rank, result) in normalize_results(&response).into_iter().enumerate() {
                            let score = calculate_match_score(
                                &current,
                                result,
                                config.prefer_file_name,
                                rank,
                            );
                            if best.as_ref().is_none_or(|candidate| {
                                score.final_score > candidate.score.final_score
                            }) {
                                best = Some(MatchCandidate {
                                    plugin,
                                    result: result.clone(),
                                    score,
                                });
                            }
                            if score.final_score >= 0.92 && score.text_score >= 0.86 {
                                break 'search;
                            }
                        }
                    }
                    Err(error) => log_source_warning(
                        &context,
                        plugin,
                        "Metadata source search failed",
                        &error,
                    ),
                }
                let steps = (queries.len() * plugins.len()).max(1);
                let current_step = query_index * plugins.len() + source_index + 1;
                on_progress(0.05 + 0.45 * current_step as f64 / steps as f64);
            }
        }
        let best = best.ok_or_else(|| ProcessError::Skipped("No match found".to_string()))?;
        if best.score.final_score < 0.76 || best.score.text_score < 0.72 {
            return Err(ProcessError::Skipped(format!(
                "Match score too low: final={:.3}, text={:.3}",
                best.score.final_score, best.score.text_score
            )));
        }
        on_progress(0.55);

        let mut fields = normalized_fields(&best.result);
        if should_write(&config, "lyrics", current.lyrics.trim().is_empty())
            && best
                .plugin
                .manifest
                .capabilities
                .iter()
                .any(|value| value == "getLyrics")
        {
            match fetch_and_render_lyrics(best.plugin, &best.result, &config) {
                Ok(lyrics) => {
                    if !lyrics.trim().is_empty() {
                        fields.insert("lyrics".to_string(), lyrics);
                    }
                }
                Err(error) => log_source_warning(
                    &context,
                    best.plugin,
                    "Metadata match lyrics fetch failed",
                    &error,
                ),
            }
        }
        on_progress(0.7);
        let cover_data_url = if should_write(&config, "cover_url", !current.has_cover) {
            fields
                .get("cover_url")
                .and_then(|url| match fetch_remote_image(url) {
                    Ok(image) => Some(image),
                    Err(error) => {
                        log_source_warning(
                            &context,
                            best.plugin,
                            "Metadata match cover fetch failed",
                            &error,
                        );
                        None
                    }
                })
        } else {
            None
        };
        on_progress(0.8);
        if context.cancelled.load(Ordering::Relaxed) {
            return Err(ProcessError::Cancelled("Batch item cancelled".to_string()));
        }
        let (update, changed_fields) = build_update(
            &current,
            &fields,
            cover_data_url,
            &config,
            context.artist_separator,
        );
        if changed_fields.is_empty() {
            return Err(ProcessError::Skipped("No fields to update".to_string()));
        }
        let updated = save_tags(update, context.artist_separator).map_err(ProcessError::Failed)?;
        on_progress(1.0);
        Ok(ProcessOutcome {
            result_json: Some(
                json!({
                    "pluginId": best.plugin.manifest.id,
                    "resultId": string_value(&best.result, &["id", "songId", "trackId"]),
                    "score": best.score.final_score,
                    "textScore": best.score.text_score,
                    "changedFields": changed_fields,
                })
                .to_string(),
            ),
            updated_track: Some(updated),
            previous_track_path: None,
        })
    }
}

fn log_source_warning(
    context: &ProcessContext<'_>,
    plugin: &SourcePlugin,
    message: &str,
    error: &str,
) {
    let detail = json!({
        "itemId": context.item.item_id,
        "songPath": context.item.song_path,
        "pluginId": plugin.manifest.id,
        "error": error,
    })
    .to_string();
    let _ = tauri::async_runtime::block_on(context.database.log_batch_event(
        "warning",
        message,
        Some(detail),
        &context.task.task_id,
    ));
}

fn parse_config(raw: Option<&str>) -> Result<MatchConfig, ProcessError> {
    let raw = raw.ok_or_else(|| ProcessError::Skipped("No config".to_string()))?;
    let mut config: MatchConfig = serde_json::from_str(raw)
        .map_err(|error| ProcessError::Failed(format!("Invalid metadata match config: {error}")))?;
    if config.target_modes.is_empty() {
        config.target_modes = DEFAULT_TARGETS
            .iter()
            .map(|target| ((*target).to_string(), "supplement".to_string()))
            .collect();
    }
    for mode in config.target_modes.values_mut() {
        if !matches!(mode.as_str(), "disabled" | "supplement" | "overwrite") {
            *mode = "disabled".to_string();
        }
    }
    if !matches!(
        config.lyric_format.as_str(),
        "plainLrc" | "verbatimLrc" | "enhancedLrc" | "ttml"
    ) {
        config.lyric_format = default_lyric_format();
    }
    if !matches!(
        config.lyrics_conversion_mode.as_str(),
        "none" | "traditionalToSimplified" | "simplifiedToTraditional"
    ) {
        config.lyrics_conversion_mode = default_conversion_mode();
    }
    Ok(config)
}

fn ordered_search_plugins(
    plugins: Vec<SourcePlugin>,
    enabled_order: &[String],
) -> Vec<SourcePlugin> {
    let mut plugins: Vec<_> = plugins
        .into_iter()
        .filter(|plugin| {
            plugin
                .source_state("metadata")
                .is_some_and(|state| state.enabled)
                && (enabled_order.is_empty()
                    || enabled_order.iter().any(|id| id == &plugin.manifest.id))
                && plugin
                    .manifest
                    .capabilities
                    .iter()
                    .any(|value| value == "searchSongs")
                && (enabled_order.is_empty() || enabled_order.contains(&plugin.manifest.id))
        })
        .collect();
    plugins.sort_by_key(|plugin| {
        let configured = enabled_order
            .iter()
            .position(|id| id == &plugin.manifest.id)
            .unwrap_or(usize::MAX);
        let priority = plugin
            .source_state("metadata")
            .map_or(i32::MAX, |state| state.priority);
        (configured, priority)
    });
    plugins
}

fn normalize_results(response: &Value) -> Vec<&Value> {
    if let Some(values) = response.as_array() {
        return values.iter().collect();
    }
    ["items", "results", "songs", "data"]
        .iter()
        .find_map(|key| response.get(key).and_then(Value::as_array))
        .map(|values| values.iter().collect())
        .unwrap_or_default()
}

struct MatchCandidate<'a> {
    plugin: &'a SourcePlugin,
    result: Value,
    score: MatchScore,
}

#[derive(Debug, Clone, Copy)]
struct MatchScore {
    final_score: f64,
    text_score: f64,
}

fn clean_noise(value: &str) -> String {
    let value = VERSION_NOISE.replace_all(value, " ");
    let value = CLEAN_PUNCTUATION.replace_all(&value, " ");
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn normalize_for_match(value: &str) -> String {
    let value = clean_noise(value).to_lowercase().replace('　', " ");
    let value = NORMALIZE_PUNCTUATION.replace_all(&value, " ");
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn split_to_segments(value: &str) -> Vec<String> {
    let mut seen = HashSet::new();
    SEGMENT_SPLIT
        .split(value)
        .map(clean_noise)
        .filter(|value| !value.is_empty() && seen.insert(value.clone()))
        .collect()
}

fn file_name_segments(file_name: &str) -> Vec<String> {
    let stem = file_name
        .rsplit_once('.')
        .map_or(file_name, |(stem, _)| stem);
    let value = TRAILING_COPY_NUMBER.replace(stem, "");
    let value = LEADING_TRACK_NUMBER.replace(&value, "");
    split_to_segments(value.trim())
}

fn local_segments(track: &AudioTrack, prefer_file_name: bool) -> Vec<String> {
    let file = file_name_segments(&track.file_name);
    let mut tags = Vec::new();
    if !track.title.trim().is_empty() && !track.title.to_lowercase().contains("未知") {
        tags.extend(split_to_segments(&track.title));
    }
    if !track.artist.trim().is_empty() && !track.artist.to_lowercase().contains("未知") {
        tags.extend(split_to_segments(&track.artist));
    }
    deduplicate(&mut tags);
    if prefer_file_name {
        if file.is_empty() {
            tags
        } else {
            file
        }
    } else if tags.is_empty() {
        file
    } else {
        tags
    }
}

fn build_search_queries(track: &AudioTrack, prefer_file_name: bool) -> Vec<String> {
    let segments = local_segments(track, prefer_file_name);
    let mut queries = Vec::new();
    if !segments.is_empty() {
        queries.push(segments.join(" "));
        if segments.len() > 1 {
            queries.extend(segments.iter().take(2).cloned());
        }
    }
    if !track.title.trim().is_empty() && !track.artist.trim().is_empty() {
        queries.push(format!(
            "{} {}",
            clean_noise(&track.title),
            clean_noise(&track.artist)
        ));
        queries.push(clean_noise(&track.title));
    } else if !track.title.trim().is_empty() {
        queries.push(clean_noise(&track.title));
    }
    deduplicate(&mut queries);
    queries
        .into_iter()
        .filter(|value| !value.is_empty())
        .take(5)
        .collect()
}

fn deduplicate(values: &mut Vec<String>) {
    let mut seen = HashSet::new();
    values.retain(|value| seen.insert(value.clone()));
}

fn calculate_match_score(
    track: &AudioTrack,
    result: &Value,
    prefer_file_name: bool,
    rank: usize,
) -> MatchScore {
    let local = local_segments(track, prefer_file_name);
    let title = string_value(result, &["title", "name", "songName"]);
    let artist = string_value(result, &["artist", "artists", "singer"]);
    if local.is_empty() {
        return MatchScore {
            final_score: 0.0,
            text_score: 0.0,
        };
    }
    let segment = segment_match_score(&local, &title, &artist);
    let whole = smart_similarity(
        &local.join(" "),
        &format!("{} {}", title, artist).trim().to_string(),
    );
    let text_score = segment * 0.75 + whole * 0.25;
    let duration = result
        .get("duration")
        .or_else(|| result.get("durationMs"))
        .and_then(Value::as_f64)
        .unwrap_or_default();
    let duration_score = duration_similarity(track.duration_seconds as f64 * 1000.0, duration);
    let combined = duration_score.map_or(text_score, |score| text_score * 0.88 + score * 0.12);
    let rank_bonus = if text_score >= 0.60 {
        0.06 / ((rank + 1) as f64).sqrt()
    } else {
        0.0
    };
    MatchScore {
        final_score: (combined + rank_bonus).clamp(0.0, 1.0),
        text_score,
    }
}

fn segment_match_score(local: &[String], result_title: &str, result_artist: &str) -> f64 {
    let mut remote = split_to_segments(result_title);
    remote.extend(split_to_segments(result_artist));
    deduplicate(&mut remote);
    if remote.is_empty() {
        return 0.0;
    }
    let local_scores: Vec<_> = local
        .iter()
        .map(|left| {
            remote
                .iter()
                .map(|right| smart_similarity(left, right))
                .fold(0.0, f64::max)
        })
        .collect();
    let remote_scores: Vec<_> = remote
        .iter()
        .map(|right| {
            local
                .iter()
                .map(|left| smart_similarity(left, right))
                .fold(0.0, f64::max)
        })
        .collect();
    let local_average = average(&local_scores);
    let remote_average = average(&remote_scores);
    let coverage = local_scores.iter().filter(|score| **score >= 0.75).count() as f64
        / local_scores.len() as f64;
    let score = local_average * 0.50 + remote_average * 0.25 + coverage * 0.25;
    if local_scores.iter().any(|score| *score >= 0.90) || coverage >= 0.75 {
        score.clamp(0.0, 1.0)
    } else {
        (score * 0.85).clamp(0.0, 1.0)
    }
}

fn average(values: &[f64]) -> f64 {
    values.iter().sum::<f64>() / values.len().max(1) as f64
}

fn smart_similarity(left: &str, right: &str) -> f64 {
    if left.trim().is_empty() && right.trim().is_empty() {
        return 1.0;
    }
    if left.trim().is_empty() || right.trim().is_empty() {
        return 0.0;
    }
    let normalized_left = normalize_for_match(left);
    let normalized_right = normalize_for_match(right);
    if normalized_left == normalized_right {
        return 1.0;
    }
    let compact_left = normalized_left.replace(' ', "");
    let compact_right = normalized_right.replace(' ', "");
    if compact_left == compact_right {
        return 1.0;
    }
    let contains = contains_similarity(&compact_left, &compact_right);
    let chars = char_remainder_similarity(&compact_left, &compact_right);
    let levenshtein = levenshtein_similarity(&compact_left, &compact_right);
    let dice = token_dice_similarity(&normalized_left, &normalized_right);
    let minimum = compact_left
        .chars()
        .count()
        .min(compact_right.chars().count());
    let blended = if minimum <= 3 {
        chars * 0.35 + levenshtein * 0.45 + dice * 0.20
    } else {
        chars * 0.50 + levenshtein * 0.30 + dice * 0.20
    };
    contains.max(blended).clamp(0.0, 1.0)
}

fn contains_similarity(left: &str, right: &str) -> f64 {
    if left.is_empty() || right.is_empty() {
        return 0.0;
    }
    let (shorter, longer) = if left.chars().count() <= right.chars().count() {
        (left, right)
    } else {
        (right, left)
    };
    if longer.contains(shorter) {
        0.80 + 0.20 * shorter.chars().count() as f64 / longer.chars().count() as f64
    } else {
        0.0
    }
}

fn char_remainder_similarity(left: &str, right: &str) -> f64 {
    let mut counts = HashMap::new();
    for value in left.chars() {
        *counts.entry(value).or_insert(0usize) += 1;
    }
    let mut common = 0usize;
    for value in right.chars() {
        if let Some(count) = counts.get_mut(&value) {
            if *count > 0 {
                common += 1;
                *count -= 1;
            }
        }
    }
    let total = left.chars().count() + right.chars().count();
    if total == 0 {
        1.0
    } else {
        2.0 * common as f64 / total as f64
    }
}

fn levenshtein_similarity(left: &str, right: &str) -> f64 {
    let left: Vec<_> = left.chars().collect();
    let right: Vec<_> = right.chars().collect();
    if left.is_empty() || right.is_empty() {
        return 0.0;
    }
    let mut previous: Vec<usize> = (0..=right.len()).collect();
    for (left_index, left_value) in left.iter().enumerate() {
        let mut current = vec![left_index + 1];
        for (right_index, right_value) in right.iter().enumerate() {
            current.push(if left_value == right_value {
                previous[right_index]
            } else {
                (previous[right_index].min(previous[right_index + 1])).min(current[right_index]) + 1
            });
        }
        previous = current;
    }
    1.0 - previous[right.len()] as f64 / left.len().max(right.len()) as f64
}

fn token_dice_similarity(left: &str, right: &str) -> f64 {
    let left: HashSet<_> = left.split_whitespace().collect();
    let right: HashSet<_> = right.split_whitespace().collect();
    if left.is_empty() || right.is_empty() {
        return 0.0;
    }
    2.0 * left.intersection(&right).count() as f64 / (left.len() + right.len()) as f64
}

fn duration_similarity(local: f64, remote: f64) -> Option<f64> {
    if local <= 0.0 || remote <= 0.0 {
        return None;
    }
    let difference = (local - remote).abs();
    Some(if difference <= 1500.0 {
        1.0
    } else if difference <= 3000.0 {
        0.85
    } else if difference <= 5000.0 {
        0.60
    } else if difference <= 8000.0 {
        0.30
    } else if difference <= 12000.0 {
        0.10
    } else {
        0.0
    })
}

fn normalized_fields(result: &Value) -> HashMap<String, String> {
    let mut fields: HashMap<String, String> = result
        .get("fields")
        .and_then(Value::as_object)
        .map(|values| {
            values
                .iter()
                .filter_map(|(key, value)| scalar_string(value).map(|value| (key.clone(), value)))
                .collect()
        })
        .unwrap_or_default();
    for (key, aliases) in [
        ("title", &["title", "name", "songName"][..]),
        ("artist", &["artist", "artists", "singer"][..]),
        ("album", &["album", "albumName"][..]),
        ("date", &["date", "releaseDate"][..]),
        ("track_number", &["trackNumber"][..]),
        ("cover_url", &["picUrl", "coverUrl", "artworkUrl"][..]),
    ] {
        let value = string_value(result, aliases);
        if !value.trim().is_empty() {
            fields.entry(key.to_string()).or_insert(value);
        }
    }
    fields.retain(|_, value| !value.trim().is_empty());
    fields
}

fn scalar_string(value: &Value) -> Option<String> {
    match value {
        Value::String(value) => Some(value.clone()),
        Value::Number(value) => Some(value.to_string()),
        Value::Bool(value) => Some(value.to_string()),
        Value::Array(values) => Some(
            values
                .iter()
                .filter_map(scalar_string)
                .collect::<Vec<_>>()
                .join("/"),
        ),
        _ => None,
    }
}

fn string_value(value: &Value, aliases: &[&str]) -> String {
    aliases
        .iter()
        .find_map(|key| value.get(key).and_then(scalar_string))
        .unwrap_or_default()
}

fn fetch_and_render_lyrics(
    plugin: &SourcePlugin,
    result: &Value,
    config: &MatchConfig,
) -> Result<String, String> {
    let mut song = result.as_object().cloned().unwrap_or_default();
    song.insert(
        "sourceId".to_string(),
        Value::String(plugin.manifest.id.clone()),
    );
    song.insert(
        "pluginId".to_string(),
        Value::String(plugin.manifest.id.clone()),
    );
    let lyrics_response = runtime::invoke(
        plugin,
        "getLyrics",
        json!({
            "song": song,
            "config": plugin.config,
            "page": 1,
            "pageSize": 10
        }),
        None,
    )?;
    let mut candidates = crate::plugins::lyrics_candidates(&lyrics_response);
    if plugin.manifest.api_version >= 4 {
        candidates = crate::plugins::filter_api4_candidates(candidates);
    }
    let title = string_value(result, &["title", "name", "songName"]);
    let artist = string_value(result, &["artist", "artists", "singer"]);
    let album = string_value(result, &["album", "albumName"]);
    let candidates = crate::plugins::ordered_lyrics_candidates(candidates, &title, &artist, &album);
    if candidates.is_empty() {
        return Err("Plugin returned no lyrics candidates".to_string());
    }
    let options = json!({
        "showTranslation": config.show_translation,
        "showRomanization": config.show_romanization,
        "onlyTranslationIfAvailable": config.only_translation_if_available,
        "lineOrder": config.lyric_line_order,
        "removeTagLineKeywords": config.remove_tag_line_keywords,
        "removeEmptyLines": config.remove_empty_lyric_lines,
        "conversionMode": config.lyrics_conversion_mode,
    });
    let mut last_error = String::new();
    for candidate in &candidates {
        let payload = crate::plugins::lyrics_payload(candidate);
        match render_plugin_lyrics(&payload, &config.lyric_format, options.clone()) {
            Ok(rendered) if !rendered.text.trim().is_empty() => return Ok(rendered.text),
            Ok(_) => {}
            Err(error) => last_error = error,
        }
    }
    Err(if last_error.is_empty() {
        "Plugin returned no usable lyrics".to_string()
    } else {
        last_error
    })
}

fn should_write(config: &MatchConfig, key: &str, current_empty: bool) -> bool {
    match config.target_modes.get(key).map(String::as_str) {
        Some("overwrite") => true,
        Some("supplement") => current_empty,
        _ => false,
    }
}

fn build_update(
    current: &AudioTrack,
    fields: &HashMap<String, String>,
    cover_data_url: Option<String>,
    config: &MatchConfig,
    artist_separator: &str,
) -> (TagUpdate, Vec<String>) {
    let mut changed = Vec::new();
    let mut string_field = |key: &str, current: &str| -> String {
        let Some(candidate) = fields.get(key).filter(|value| !value.trim().is_empty()) else {
            return current.to_string();
        };
        if should_write(config, key, current.trim().is_empty()) && candidate != current {
            changed.push(key.to_string());
            candidate.clone()
        } else {
            current.to_string()
        }
    };
    let title = string_field("title", &current.title);
    let artist = string_field("artist", &current.artist);
    let album = string_field("album", &current.album);
    let album_artist = string_field("album_artist", &current.album_artist);
    let language = string_field("language", &current.language);
    let composer = string_field("composer", &current.composer);
    let lyricist = string_field("lyricist", &current.lyricist);
    let copyright = string_field("copyright", &current.copyright);
    let comment = string_field("comment", &current.comment);
    let lyrics = string_field("lyrics", &current.lyrics);
    let year = string_field("date", &current.year);
    let replay_gain_track_gain =
        string_field("replaygain_track_gain", &current.replay_gain_track_gain);
    let replay_gain_track_peak =
        string_field("replaygain_track_peak", &current.replay_gain_track_peak);
    let replay_gain_album_gain =
        string_field("replaygain_album_gain", &current.replay_gain_album_gain);
    let replay_gain_album_peak =
        string_field("replaygain_album_peak", &current.replay_gain_album_peak);
    let replay_gain_reference_loudness = current.replay_gain_reference_loudness.clone();
    let genre_value = fields.get("genre").filter(|value| {
        should_write(config, "genre", current.genre.trim().is_empty()) && !value.trim().is_empty()
    });
    let genre = if let Some(value) = genre_value {
        let values = split_multi_value(value);
        if values.join("; ") != current.genre {
            changed.push("genre".to_string());
        }
        values
    } else {
        current
            .genre
            .split(';')
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned)
            .collect()
    };
    let track_number = numeric_field(
        "track_number",
        current.track_number,
        fields,
        config,
        &mut changed,
    );
    let disc_number = numeric_field(
        "disc_number",
        current.disc_number,
        fields,
        config,
        &mut changed,
    );
    let rating = fields
        .get("rating")
        .and_then(|value| value.parse::<u8>().ok())
        .filter(|_| should_write(config, "rating", current.rating.is_none()))
        .or(current.rating);
    if rating != current.rating {
        changed.push("rating".to_string());
    }
    let cover_data_url = cover_data_url.filter(|_| {
        changed.push("cover_url".to_string());
        true
    });
    (
        TagUpdate {
            path: current.path.clone(),
            title,
            artist: normalize_separator(&artist, artist_separator),
            album,
            album_artist,
            genre,
            language,
            composer,
            lyricist,
            copyright,
            rating,
            comment,
            lyrics,
            track_number,
            disc_number,
            year,
            replay_gain_track_gain,
            replay_gain_track_peak,
            replay_gain_album_gain,
            replay_gain_album_peak,
            replay_gain_reference_loudness,
            cover_data_url,
            remove_cover: false,
        },
        changed,
    )
}

fn split_multi_value(value: &str) -> Vec<String> {
    value
        .split([';', ',', '/'])
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .collect()
}

fn normalize_separator(value: &str, separator: &str) -> String {
    if separator.is_empty() {
        value.to_string()
    } else {
        split_multi_value(value).join(separator)
    }
}

fn numeric_field(
    key: &str,
    current: Option<u32>,
    fields: &HashMap<String, String>,
    config: &MatchConfig,
    changed: &mut Vec<String>,
) -> Option<u32> {
    let candidate = fields
        .get(key)
        .and_then(|value| value.split('/').next())
        .and_then(|value| value.trim().parse::<u32>().ok());
    if should_write(config, key, current.is_none()) && candidate.is_some() && candidate != current {
        changed.push(key.to_string());
        candidate
    } else {
        current
    }
}

fn fetch_remote_image(url: &str) -> Result<String, String> {
    let parsed = reqwest::Url::parse(url).map_err(|error| error.to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("Only HTTP and HTTPS image URLs are supported".to_string());
    }
    let response = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|error| error.to_string())?
        .get(parsed)
        .send()
        .and_then(reqwest::blocking::Response::error_for_status)
        .map_err(|error| error.to_string())?;
    let mime = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .unwrap_or("application/octet-stream")
        .to_string();
    if !mime.starts_with("image/") {
        return Err(format!("Remote resource is not an image: {mime}"));
    }
    if response
        .content_length()
        .is_some_and(|length| length > 20 * 1024 * 1024)
    {
        return Err("Remote image is larger than 20 MB".to_string());
    }
    let bytes = response.bytes().map_err(|error| error.to_string())?;
    if bytes.len() > 20 * 1024 * 1024 {
        return Err("Remote image is larger than 20 MB".to_string());
    }
    image::load_from_memory(&bytes).map_err(|error| error.to_string())?;
    Ok(format!("data:{mime};base64,{}", STANDARD.encode(bytes)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn track() -> AudioTrack {
        AudioTrack {
            id: "song".to_string(),
            path: "song.flac".to_string(),
            file_name: "01 周杰伦 - 晴天.flac".to_string(),
            title: "晴天".to_string(),
            artist: "周杰伦".to_string(),
            album: String::new(),
            album_artist: String::new(),
            genre: String::new(),
            language: String::new(),
            composer: String::new(),
            lyricist: String::new(),
            copyright: String::new(),
            rating: None,
            comment: String::new(),
            lyrics: String::new(),
            track_number: None,
            disc_number: None,
            year: String::new(),
            duration_seconds: 269,
            format: "FLAC".to_string(),
            bitrate: None,
            sample_rate: None,
            channels: None,
            cover_data_url: None,
            has_lyrics: false,
            has_cover: false,
            replay_gain_track_gain: String::new(),
            replay_gain_track_peak: String::new(),
            replay_gain_album_gain: String::new(),
            replay_gain_album_peak: String::new(),
            replay_gain_reference_loudness: String::new(),
            modified_at: None,
            added_at: None,
            created_at: None,
        }
    }

    #[test]
    fn queries_and_score_match_mobile_threshold_behavior() {
        let track = track();
        assert_eq!(build_search_queries(&track, false)[0], "晴天 周杰伦");
        let exact = calculate_match_score(
            &track,
            &json!({"title":"晴天","artist":"周杰伦","duration":269000}),
            false,
            0,
        );
        let wrong = calculate_match_score(
            &track,
            &json!({"title":"七里香","artist":"林俊杰","duration":180000}),
            false,
            0,
        );
        assert!(exact.final_score >= 0.92 && exact.text_score >= 0.86);
        assert!(wrong.final_score < 0.76 || wrong.text_score < 0.72);
    }

    #[test]
    fn supplement_preserves_existing_fields_and_overwrite_replaces_enabled_fields() {
        let current = track();
        let fields = HashMap::from([
            ("title".to_string(), "晴天 (Remastered)".to_string()),
            ("album".to_string(), "叶惠美".to_string()),
            ("track_number".to_string(), "3/12".to_string()),
        ]);
        let config = MatchConfig {
            target_modes: HashMap::from([
                ("title".to_string(), "supplement".to_string()),
                ("album".to_string(), "supplement".to_string()),
                ("track_number".to_string(), "overwrite".to_string()),
            ]),
            enabled_source_order_ids: Vec::new(),
            prefer_file_name: false,
            separator: "/".to_string(),
            lyric_format: default_lyric_format(),
            show_translation: true,
            show_romanization: true,
            only_translation_if_available: false,
            remove_empty_lyric_lines: true,
            lyric_line_order: Vec::new(),
            remove_tag_line_keywords: Vec::new(),
            lyrics_conversion_mode: default_conversion_mode(),
        };
        let (update, changed) = build_update(&current, &fields, None, &config, "/");
        assert_eq!(update.title, "晴天");
        assert_eq!(update.album, "叶惠美");
        assert_eq!(update.track_number, Some(3));
        assert_eq!(changed, vec!["album", "track_number"]);
    }
}
