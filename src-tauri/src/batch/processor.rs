use crate::audio::write_replay_gain_tags;
use crate::database::Database;
use crate::models::{AudioTrack, BatchTask, BatchTaskItem, ReplayGainProgress};
use crate::replay_gain::analyze_track;
use serde_json::json;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter};

pub(super) struct ProcessContext<'a> {
    pub(super) app: &'a AppHandle,
    pub(super) database: &'a Database,
    pub(super) task: &'a BatchTask,
    pub(super) item: &'a BatchTaskItem,
    pub(super) artist_separator: &'a str,
    pub(super) cancelled: &'a AtomicBool,
}

pub(super) struct ProcessOutcome {
    pub(super) result_json: Option<String>,
    pub(super) updated_track: Option<AudioTrack>,
    pub(super) previous_track_path: Option<String>,
}

#[derive(Debug)]
pub(super) enum ProcessError {
    Skipped(String),
    Cancelled(String),
    Failed(String),
}

pub(super) trait BatchProcessor: Send + Sync {
    fn process(
        &self,
        context: ProcessContext<'_>,
        on_progress: &mut dyn FnMut(f64),
    ) -> Result<ProcessOutcome, ProcessError>;
}

pub(super) fn processor_for(task_type: &str) -> Result<Box<dyn BatchProcessor>, String> {
    match task_type {
        "editTags" => Ok(Box::new(super::edit::EditTagsProcessor)),
        "deleteFiles" => Ok(Box::new(super::delete::DeleteFilesProcessor)),
        "matchMetadata" => Ok(Box::new(super::metadata::MatchMetadataProcessor)),
        "formatLyrics" => Ok(Box::new(super::lyrics::LyricsFormatProcessor)),
        "renameFiles" => Ok(Box::new(super::rename::RenameFilesProcessor)),
        "exportLyrics" | "exportCover" => Ok(Box::new(super::export::ExportProcessor)),
        "replayGain" => Ok(Box::new(ReplayGainProcessor)),
        other => Err(format!("No Rust batch processor is registered for {other}")),
    }
}

struct ReplayGainProcessor;

impl BatchProcessor for ReplayGainProcessor {
    fn process(
        &self,
        context: ProcessContext<'_>,
        on_progress: &mut dyn FnMut(f64),
    ) -> Result<ProcessOutcome, ProcessError> {
        if context.cancelled.load(Ordering::Relaxed) {
            return Err(ProcessError::Cancelled("Batch item cancelled".to_string()));
        }
        let path = Path::new(&context.item.song_path);
        // Legacy tasks keep the documented default; execution never reads mutable settings.
        let target_loudness = context
            .task
            .config_json
            .as_deref()
            .and_then(|raw| serde_json::from_str::<serde_json::Value>(raw).ok())
            .and_then(|config| {
                config
                    .get("targetLoudness")
                    .and_then(serde_json::Value::as_f64)
            })
            .filter(|value| value.is_finite() && (-30.0..=0.0).contains(value))
            .unwrap_or(crate::replay_gain::DEFAULT_TARGET_LOUDNESS_LUFS);
        let peak_mode = context.task.config_json.as_deref()
            .and_then(|raw| serde_json::from_str::<serde_json::Value>(raw).ok())
            .and_then(|config| config.get("peakMode").cloned())
            .and_then(|mode| serde_json::from_value(mode).ok())
            .unwrap_or(crate::replay_gain::PeakMode::SamplePeak);
        let job_id = format!("{}:{}", context.task.task_id, context.item.item_id);
        let analysis = analyze_track(
            job_id.clone(),
            path,
            target_loudness,
            peak_mode,
            context.cancelled,
            |progress| {
                on_progress(f64::from(progress));
                let _ = context.app.emit(
                    "replay-gain-progress",
                    ReplayGainProgress {
                        job_id: job_id.clone(),
                        path: context.item.song_path.clone(),
                        percent: (progress * 100.0).round() as u8,
                        status: "running".to_string(),
                        message: None,
                    },
                );
            },
        )
        .map_err(|error| {
            if context.cancelled.load(Ordering::Relaxed)
                || error.to_lowercase().contains("cancelled")
            {
                ProcessError::Cancelled(error)
            } else {
                ProcessError::Failed(error)
            }
        })?;
        if context.cancelled.load(Ordering::Relaxed) {
            return Err(ProcessError::Cancelled("Batch item cancelled".to_string()));
        }
        // Verified decoder anomalies are surfaced; incomplete audio fails before tag writing.
        let warnings: Vec<String> = analysis.warning.clone().into_iter().collect();
        let updated = write_replay_gain_tags(
            path,
            context.artist_separator,
            analysis.track_gain.clone(),
            analysis.track_peak.clone(),
            analysis.reference_loudness.clone(),
        )
        .map_err(ProcessError::Failed)?;
        let _ = context.app.emit(
            "replay-gain-progress",
            ReplayGainProgress {
                job_id,
                path: context.item.song_path.clone(),
                percent: 100,
                status: "completed".to_string(),
                message: analysis.warning.clone(),
            },
        );
        Ok(ProcessOutcome {
            result_json: Some(
                json!({
                    "trackGain": analysis.track_gain,
                    "trackPeak": analysis.track_peak,
                    "referenceLoudness": analysis.reference_loudness,
                    "loudnessLufs": analysis.loudness_lufs,
                    "peak": analysis.peak,
                    "peakMode": peak_mode,
                    "decodedSamples": analysis.sample_count,
                    "declaredSamples": analysis.declared_samples,
                    "warnings": warnings,
                })
                .to_string(),
            ),
            updated_track: Some(updated),
            previous_track_path: None,
        })
    }
}
