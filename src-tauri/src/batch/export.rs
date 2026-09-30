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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio::write_lyrics_tag;

    fn temporary_directory(name: &str) -> PathBuf {
        let directory = std::env::temp_dir().join(format!(
            "lyrico-export-{name}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = fs::remove_dir_all(&directory);
        fs::create_dir_all(&directory).expect("temporary export directory should be created");
        directory
    }

    #[test]
    fn config_matches_mobile_concurrency_bounds_and_requires_a_directory() {
        let directory = temporary_directory("config");
        let raw = json!({
            "destinationDirectory": directory,
            "concurrency": 9,
        })
        .to_string();
        let config = parse_config(Some(&raw)).expect("valid export config");
        assert_eq!(config.concurrency, 5);
        assert!(parse_config(Some(r#"{"destinationDirectory":"relative"}"#)).is_err());
        fs::remove_dir_all(directory).expect("temporary directory should be removed");
    }

    #[test]
    fn export_writes_bytes_and_numbers_conflicts_without_overwriting() {
        let directory = temporary_directory("conflict");
        let first = write_with_conflict_suffix(&directory, "song", "lrc", b"first")
            .expect("first export should succeed");
        let second = write_with_conflict_suffix(&directory, "song", "lrc", b"second")
            .expect("conflicting export should succeed");
        assert_eq!(
            first.file_name().and_then(|value| value.to_str()),
            Some("song.lrc")
        );
        assert_eq!(
            second.file_name().and_then(|value| value.to_str()),
            Some("song (1).lrc")
        );
        assert_eq!(fs::read(first).unwrap(), b"first");
        assert_eq!(fs::read(second).unwrap(), b"second");
        fs::remove_dir_all(directory).expect("temporary directory should be removed");
    }

    #[test]
    fn shared_lyrics_detector_preserves_mobile_export_extensions() {
        let ttml =
            "<?xml version=\"1.0\"?><tt><body><p begin=\"1s\" end=\"2s\">line</p></body></tt>";
        assert_eq!(lyrics::detect_format(ttml), LyricFormat::Ttml);
        assert_ne!(lyrics::detect_format("[00:01.000]line"), LyricFormat::Ttml);
    }

    #[test]
    fn configured_audio_fixture_exports_embedded_lyrics_and_cover() {
        let Ok(source) = std::env::var("LYRICO_REPLAY_GAIN_FIXTURE") else {
            return;
        };
        let source = PathBuf::from(source);
        let extension = source
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("flac");
        let target = std::env::temp_dir().join(format!(
            "lyrico-export-source-{}.{}",
            std::process::id(),
            extension
        ));
        fs::copy(&source, &target).expect("fixture should copy");
        let lyrics =
            "<?xml version=\"1.0\"?><tt><body><p begin=\"1s\" end=\"2s\">导出测试</p></body></tt>";
        write_lyrics_tag(&target, "/", lyrics.to_string()).expect("lyrics should write");

        let cover_bytes = b"test-cover-bytes".to_vec();
        crate::file_mutation::write_copy(&target, |temporary| {
            let mut file = crate::taglib_bridge::File::open(temporary, false)?;
            file.set_cover(Some(&crate::taglib_bridge::Cover {
                mime: "image/jpeg".into(),
                data: cover_bytes.clone(),
            }))?;
            file.save()
        })
        .expect("cover should write");

        let (lyrics_extension, exported_lyrics) =
            load_export_contents("exportLyrics", &target, "/").expect("lyrics should export");
        let (cover_extension, exported_cover) =
            load_export_contents("exportCover", &target, "/").expect("cover should export");
        assert_eq!(lyrics_extension, "ttml");
        assert_eq!(exported_lyrics, lyrics.as_bytes());
        assert_eq!(cover_extension, "jpg");
        assert_eq!(exported_cover, cover_bytes);
        fs::remove_file(target).expect("temporary audio file should be removed");
    }
}
