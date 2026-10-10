use super::processor::{BatchProcessor, ProcessContext, ProcessError, ProcessOutcome};
use crate::audio::{read_embedded_cover, read_track, ArtworkMode};
use crate::lyrics::{self, LyricFormat};
use serde::Deserialize;
use serde_json::json;
use std::fs::{self, OpenOptions};
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExportConfig {
    destination_directory: String,
    #[serde(default = "default_concurrency")]
    concurrency: usize,
}

pub(super) struct ExportProcessor;

impl BatchProcessor for ExportProcessor {
    fn process(
        &self,
        context: ProcessContext<'_>,
        on_progress: &mut dyn FnMut(f64),
    ) -> Result<ProcessOutcome, ProcessError> {
        if context.cancelled.load(Ordering::Relaxed) {
            return Err(ProcessError::Cancelled("Batch item cancelled".to_string()));
        }
        let config = parse_config(context.task.config_json.as_deref())?;
        let source_path = Path::new(&context.item.song_path);
        let file_stem = source_path
            .file_stem()
            .and_then(|value| value.to_str())
            .filter(|value| !value.trim().is_empty())
            .or_else(|| {
                Path::new(&context.item.file_name)
                    .file_stem()
                    .and_then(|value| value.to_str())
                    .filter(|value| !value.trim().is_empty())
            })
            .ok_or_else(|| ProcessError::Failed("Audio file name is invalid".to_string()))?;

        let (extension, contents) = load_export_contents(
            context.task.task_type.as_str(),
            source_path,
            context.artist_separator,
        )?;

        on_progress(0.5);
        if context.cancelled.load(Ordering::Relaxed) {
            return Err(ProcessError::Cancelled("Batch item cancelled".to_string()));
        }
        let output_path = write_with_conflict_suffix(
            Path::new(&config.destination_directory),
            file_stem,
            extension,
            &contents,
        )
        .map_err(ProcessError::Failed)?;
        if context.cancelled.load(Ordering::Relaxed) {
            let _ = fs::remove_file(&output_path);
            return Err(ProcessError::Cancelled("Batch item cancelled".to_string()));
        }
        let output_file_name = output_path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_string();
        Ok(ProcessOutcome {
            result_json: Some(
                json!({
                    "outputPath": output_path.to_string_lossy(),
                    "outputFileName": output_file_name,
                    "exportType": context.task.task_type,
                })
                .to_string(),
            ),
            updated_track: None,
            previous_track_path: None,
        })
    }
}

fn default_concurrency() -> usize {
    3
}

fn load_export_contents(
    task_type: &str,
    source_path: &Path,
    artist_separator: &str,
) -> Result<(&'static str, Vec<u8>), ProcessError> {
    match task_type {
        "exportLyrics" => {
            let track = read_track(source_path, artist_separator, ArtworkMode::None)
                .map_err(|error| ProcessError::Failed(error.to_string()))?;
            if track.lyrics.trim().is_empty() {
                return Err(ProcessError::Skipped("No lyrics".to_string()));
            }
            let extension = if lyrics::detect_format(&track.lyrics) == LyricFormat::Ttml {
                "ttml"
            } else {
                "lrc"
            };
            Ok((extension, track.lyrics.into_bytes()))
        }
        "exportCover" => {
            let contents = read_embedded_cover(source_path)
                .map_err(ProcessError::Failed)?
                .ok_or_else(|| ProcessError::Skipped("No cover".to_string()))?;
            Ok(("jpg", contents))
        }
        other => Err(ProcessError::Failed(format!(
            "Unsupported export task type: {other}"
        ))),
    }
}

fn parse_config(config_json: Option<&str>) -> Result<ExportConfig, ProcessError> {
    let raw = config_json.ok_or_else(|| ProcessError::Skipped("No config".to_string()))?;
    let mut config: ExportConfig = serde_json::from_str(raw)
        .map_err(|error| ProcessError::Failed(format!("Invalid export config: {error}")))?;
    config.concurrency = config.concurrency.clamp(1, 5);
    let destination = Path::new(config.destination_directory.trim());
    if !destination.is_absolute() {
        return Err(ProcessError::Failed(
            "Export destination must be an absolute path".to_string(),
        ));
    }
    if !destination.is_dir() {
        return Err(ProcessError::Failed(
            "Export destination is unavailable".to_string(),
        ));
    }
    config.destination_directory = destination.to_string_lossy().to_string();
    Ok(config)
}

fn write_with_conflict_suffix(
    destination: &Path,
    file_stem: &str,
    extension: &str,
    contents: &[u8],
) -> Result<PathBuf, String> {
    for counter in 0usize.. {
        let file_name = if counter == 0 {
            format!("{file_stem}.{extension}")
        } else {
            format!("{file_stem} ({counter}).{extension}")
        };
        let output_path = destination.join(file_name);
        let mut file = match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&output_path)
        {
            Ok(file) => file,
            Err(error) if error.kind() == ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("Failed to create export file: {error}")),
        };
        if let Err(error) = file.write_all(contents).and_then(|_| file.flush()) {
            drop(file);
            let _ = fs::remove_file(&output_path);
            return Err(format!("Failed to write export file: {error}"));
        }
        return Ok(output_path);
    }
    unreachable!()
}
