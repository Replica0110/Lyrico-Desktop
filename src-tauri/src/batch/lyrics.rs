use super::processor::{BatchProcessor, ProcessContext, ProcessError, ProcessOutcome};
use crate::audio::{read_track, write_lyrics_tag, ArtworkMode};
use crate::lyrics::{self, LyricFormat, LyricsOptions, LyricsPipelineResult};
use serde::{de::Error as _, Deserialize, Deserializer};
use serde_json::{json, Value};
use std::path::Path;
use std::sync::atomic::Ordering;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LyricsFormatConfig {
    #[serde(default, deserialize_with = "deserialize_optional_format")]
    target_format: Option<LyricFormat>,
    #[serde(default = "default_concurrency")]
    concurrency: usize,
    #[serde(default = "default_true")]
    format_line_order: bool,
    #[serde(default)]
    remove_tag_lines: bool,
    #[serde(default)]
    tag_line_keywords: Vec<String>,
    #[serde(default)]
    remove_empty_lines: bool,
}

pub(super) struct LyricsFormatProcessor;

impl BatchProcessor for LyricsFormatProcessor {
    fn process(
        &self,
        context: ProcessContext<'_>,
        on_progress: &mut dyn FnMut(f64),
    ) -> Result<ProcessOutcome, ProcessError> {
        if context.cancelled.load(Ordering::Relaxed) {
            return Err(ProcessError::Cancelled("Batch item cancelled".to_string()));
        }
        let config = parse_config(context.task.config_json.as_deref())?;
        let path = Path::new(&context.item.song_path);
        let existing = read_track(path, context.artist_separator, ArtworkMode::None)
            .map_err(|error| ProcessError::Failed(error.to_string()))?;
        if existing.lyrics.trim().is_empty() {
            return Err(ProcessError::Skipped("No lyrics".to_string()));
        }

        let result = process_lyrics(&existing.lyrics, &config).map_err(ProcessError::Failed)?;
        if result.text.trim().is_empty() {
            return Err(ProcessError::Failed(
                "Lyrics conversion produced an empty result".to_string(),
            ));
        }
        if result.text == existing.lyrics {
            return Err(ProcessError::Skipped(
                "Converted lyrics are unchanged".to_string(),
            ));
        }
        on_progress(0.75);
        if context.cancelled.load(Ordering::Relaxed) {
            return Err(ProcessError::Cancelled("Batch item cancelled".to_string()));
        }
        let updated = write_lyrics_tag(path, context.artist_separator, result.text)
            .map_err(ProcessError::Failed)?;
        Ok(ProcessOutcome {
            result_json: Some(
                json!({
                    "sourceFormat": result.source_format,
                    "targetFormat": result.target_format,
                    "warnings": result.warnings,
                })
                .to_string(),
            ),
            updated_track: Some(updated),
            previous_track_path: None,
        })
    }
}

fn default_concurrency() -> usize {
    3
}

fn default_true() -> bool {
    true
}

fn deserialize_optional_format<'de, D>(deserializer: D) -> Result<Option<LyricFormat>, D::Error>
where
    D: Deserializer<'de>,
{
    Option::<String>::deserialize(deserializer)?
        .as_deref()
        .map(normalize_format)
        .transpose()
        .map_err(D::Error::custom)
}

fn parse_config(config_json: Option<&str>) -> Result<LyricsFormatConfig, ProcessError> {
    let raw = config_json.ok_or_else(|| ProcessError::Skipped("No config".to_string()))?;
    let mut config: LyricsFormatConfig = serde_json::from_str(raw)
        .map_err(|error| ProcessError::Failed(format!("Invalid lyrics format config: {error}")))?;
    config.concurrency = config.concurrency.clamp(1, 5);
    config.tag_line_keywords = config
        .tag_line_keywords
        .into_iter()
        .map(|keyword| keyword.trim().to_string())
        .filter(|keyword| !keyword.is_empty())
        .collect();
    let removes_tag_lines = config.remove_tag_lines && !config.tag_line_keywords.is_empty();
    if config.target_format.is_none()
        && !config.format_line_order
        && !removes_tag_lines
        && !config.remove_empty_lines
    {
        return Err(ProcessError::Skipped(
            "No lyrics operation selected".to_string(),
        ));
    }
    Ok(config)
}

fn normalize_format(value: &str) -> Result<LyricFormat, String> {
    match value {
        "plainLrc" | "PLAIN_LRC" => Ok(LyricFormat::PlainLrc),
        "verbatimLrc" | "VERBATIM_LRC" => Ok(LyricFormat::VerbatimLrc),
        "enhancedLrc" | "ENHANCED_LRC" => Ok(LyricFormat::EnhancedLrc),
        "ttml" | "TTML" => Ok(LyricFormat::Ttml),
        other => Err(format!("Unsupported lyrics format: {other}")),
    }
}

fn process_lyrics(
    lyrics: &str,
    config: &LyricsFormatConfig,
) -> Result<LyricsPipelineResult, String> {
    lyrics::process_text(
        lyrics,
        &LyricsOptions {
            target_format: config.target_format,
            force_rewrite: config.format_line_order,
            remove_tag_line_keywords: if config.remove_tag_lines {
                config.tag_line_keywords.clone()
            } else {
                Vec::new()
            },
            remove_empty_lines: config.remove_empty_lines,
            ..LyricsOptions::default()
        },
    )
}

pub(super) fn render_plugin_lyrics(
    result: &Value,
    target_format: &str,
    options: Value,
) -> Result<LyricsPipelineResult, String> {
    let target_format = normalize_format(target_format)?;
    let options: LyricsOptions =
        serde_json::from_value(options).map_err(|error| error.to_string())?;
    lyrics::process_plugin_result(result, target_format, &options)
}
