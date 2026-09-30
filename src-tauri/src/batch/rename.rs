use super::processor::{BatchProcessor, ProcessContext, ProcessError, ProcessOutcome};
use crate::audio::{read_track, ArtworkMode};
use crate::models::AudioTrack;
use regex::{Captures, Regex};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub(crate) struct CharacterMappingRule {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) char_mappings: HashMap<String, Option<String>>,
    pub(crate) description: String,
    pub(crate) is_built_in: bool,
    pub(crate) is_enabled: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RenamePreview {
    pub(crate) original_path: String,
    pub(crate) new_path: String,
    pub(crate) conflict: bool,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct RenameFilesConfig {
    planned_paths: HashMap<String, String>,
}

pub(super) struct RenameFilesProcessor;

impl BatchProcessor for RenameFilesProcessor {
    fn process(
        &self,
        context: ProcessContext<'_>,
        on_progress: &mut dyn FnMut(f64),
    ) -> Result<ProcessOutcome, ProcessError> {
        if context.cancelled.load(Ordering::Relaxed) {
            return Err(ProcessError::Cancelled("Batch item cancelled".to_string()));
        }
        let config = parse_config(context.task.config_json.as_deref())?;
        let original_path = PathBuf::from(&context.item.song_path);
        let planned_path = config
            .planned_paths
            .iter()
            .find(|(path, _)| same_path(Path::new(path), &original_path))
            .map(|(_, path)| PathBuf::from(path))
            .ok_or_else(|| {
                ProcessError::Failed("Rename preview is missing for this file".to_string())
            })?;
        if same_path(&original_path, &planned_path) {
            return Err(ProcessError::Skipped("Same file name".to_string()));
        }
        on_progress(0.5);
        if context.cancelled.load(Ordering::Relaxed) {
            return Err(ProcessError::Cancelled("Batch item cancelled".to_string()));
        }
        let updated = execute_rename(&original_path, &planned_path, context.artist_separator)
            .map_err(ProcessError::Failed)?;
        Ok(ProcessOutcome {
            result_json: Some(
                json!({
                    "originalPath": original_path,
                    "newPath": planned_path,
                })
                .to_string(),
            ),
            updated_track: Some(updated),
            previous_track_path: Some(context.item.song_path.clone()),
        })
    }
}

fn execute_rename(
    original_path: &Path,
    planned_path: &Path,
    artist_separator: &str,
) -> Result<AudioTrack, String> {
    crate::file_mutation::with_file_lock(original_path, || {
        validate_planned_path(original_path, planned_path)?;
        if planned_path.exists() {
            return Err(format!(
                "Rename target already exists: {}",
                planned_path.display()
            ));
        }
        std::fs::rename(original_path, planned_path).map_err(|error| {
            format!(
                "Failed to rename {} to {}: {error}",
                original_path.display(),
                planned_path.display()
            )
        })?;
        match read_track(planned_path, artist_separator, ArtworkMode::None) {
            Ok(track) => Ok(track),
            Err(error) => {
                let _ = std::fs::rename(planned_path, original_path);
                Err(format!(
                    "Renamed file could not be read and was rolled back: {error}"
                ))
            }
        }
    })
}

pub(crate) fn generate_previews(
    paths: &[String],
    rename_format: &str,
    rules: &[CharacterMappingRule],
    artist_separator: &str,
) -> Result<Vec<RenamePreview>, String> {
    let mut reserved = HashSet::new();
    let mut previews = Vec::with_capacity(paths.len());
    for path in paths {
        let original_path = PathBuf::from(path);
        let track = read_track(&original_path, artist_separator, ArtworkMode::None)
            .map_err(|error| format!("Failed to read {}: {error}", original_path.display()))?;
        let desired_path = build_target_path(&original_path, &track, rename_format, rules)?;
        let (new_path, conflict) = reserve_available_path(&original_path, &desired_path, &reserved);
        reserved.insert(path_key(&new_path));
        previews.push(RenamePreview {
            original_path: path.clone(),
            new_path: new_path.to_string_lossy().into_owned(),
            conflict,
        });
    }
    Ok(previews)
}

fn parse_config(config_json: Option<&str>) -> Result<RenameFilesConfig, ProcessError> {
    let raw = config_json.ok_or_else(|| ProcessError::Skipped("No config".to_string()))?;
    let config: RenameFilesConfig = serde_json::from_str(raw)
        .map_err(|error| ProcessError::Failed(format!("Invalid rename config: {error}")))?;
    if config.planned_paths.is_empty() {
        return Err(ProcessError::Failed(
            "Rename config does not contain a preview plan".to_string(),
        ));
    }
    Ok(config)
}

fn build_target_path(
    original_path: &Path,
    track: &AudioTrack,
    rename_format: &str,
    rules: &[CharacterMappingRule],
) -> Result<PathBuf, String> {
    let placeholder = Regex::new(r"@(\d+)").map_err(|error| error.to_string())?;
    let generated = placeholder.replace_all(rename_format, |captures: &Captures<'_>| {
        placeholder_value(captures.get(1).map(|value| value.as_str()), track).unwrap_or_else(|| {
            captures
                .get(0)
                .map_or("", |value| value.as_str())
                .to_string()
        })
    });
    let mut file_stem = sanitize_file_name(&generated, rules);
    if file_stem.is_empty() {
        file_stem = original_path
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_string();
    }
    if file_stem.is_empty() {
        return Err("Rename format produced an empty file name".to_string());
    }
    let mut file_name = file_stem;
    if let Some(extension) = original_path.extension().and_then(|value| value.to_str()) {
        if !extension.is_empty() {
            file_name.push('.');
            file_name.push_str(extension);
        }
    }
    Ok(original_path.parent().map_or_else(
        || PathBuf::from(&file_name),
        |parent| parent.join(&file_name),
    ))
}

fn placeholder_value(index: Option<&str>, track: &AudioTrack) -> Option<String> {
    Some(match index? {
        "1" => track.title.clone(),
        "2" => track.artist.clone(),
        "3" => track.album_artist.clone(),
        "4" => track.album.clone(),
        "5" => track
            .track_number
            .map(|value| value.to_string())
            .unwrap_or_default(),
        "6" => track
            .disc_number
            .map(|value| value.to_string())
            .unwrap_or_default(),
        "7" => track.year.clone(),
        "8" => track.genre.clone(),
        _ => return None,
    })
}

fn sanitize_file_name(file_name: &str, rules: &[CharacterMappingRule]) -> String {
    let mut result = file_name.to_string();
    for rule in rules.iter().filter(|rule| rule.is_enabled) {
        result = apply_mapping_rule(&result, &rule.char_mappings);
    }
    result.trim().to_string()
}

fn apply_mapping_rule(input: &str, mappings: &HashMap<String, Option<String>>) -> String {
    let characters = input.chars().collect::<Vec<_>>();
    let mut output = String::new();
    let mut index = 0;
    while index < characters.len() {
        let key = characters[index].to_string();
        let Some(replacement) = mappings.get(&key) else {
            output.push(characters[index]);
            index += 1;
            continue;
        };
        let replacement = replacement.as_deref().unwrap_or_default();
        output.push_str(replacement);
        index += 1;
        while index < characters.len() {
            let next_key = characters[index].to_string();
            let next_replacement = mappings
                .get(&next_key)
                .map(|value| value.as_deref().unwrap_or_default());
            if next_replacement != Some(replacement) {
                break;
            }
            index += 1;
        }
    }
    output
}

fn reserve_available_path(
    original_path: &Path,
    desired_path: &Path,
    reserved: &HashSet<String>,
) -> (PathBuf, bool) {
    if path_available(original_path, desired_path, reserved) {
        return (desired_path.to_path_buf(), false);
    }
    for counter in 1.. {
        let candidate = add_conflict_suffix(desired_path, counter);
        if path_available(original_path, &candidate, reserved) {
            return (candidate, true);
        }
    }
    unreachable!()
}

fn path_available(original_path: &Path, candidate: &Path, reserved: &HashSet<String>) -> bool {
    !reserved.contains(&path_key(candidate))
        && (!candidate.exists() || same_path(original_path, candidate))
}

fn add_conflict_suffix(path: &Path, counter: usize) -> PathBuf {
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    let extension = path.extension().and_then(|value| value.to_str());
    let name = extension.map_or_else(
        || format!("{stem} ({counter})"),
        |extension| format!("{stem} ({counter}).{extension}"),
    );
    match path.parent() {
        Some(parent) => parent.join(name),
        None => PathBuf::from(name),
    }
}

fn validate_planned_path(original_path: &Path, planned_path: &Path) -> Result<(), String> {
    if original_path.parent() != planned_path.parent() {
        return Err("Rename plan cannot move a file to another directory".to_string());
    }
    if original_path.extension() != planned_path.extension() {
        return Err("Rename plan must preserve the original extension".to_string());
    }
    if planned_path.file_name().is_none() {
        return Err("Rename target is invalid".to_string());
    }
    Ok(())
}

fn same_path(left: &Path, right: &Path) -> bool {
    path_key(left) == path_key(right)
}

fn path_key(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/").to_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn placeholders_match_mobile_fields_and_invalid_tokens_stay_literal() {
        let track = sample_track("song.flac");
        let target = build_target_path(
            Path::new("C:\\Music\\song.flac"),
            &track,
            "@5 - @1 - @2 - @3 - @4 - @6 - @7 - @8 - @9",
            &[],
        )
        .unwrap();
        assert_eq!(
            target.file_name().and_then(|value| value.to_str()),
            Some("3 - 标题 - 艺术家 - 专辑艺术家 - 专辑 - 1 - 2026 - Pop - @9.flac")
        );
    }

    #[test]
    fn sanitizer_applies_mobile_default_full_width_mapping_and_collapses_runs() {
        let rule = default_mapping_rule();
        assert_eq!(sanitize_file_name(" A//B:*? ", &[rule]), "A／B：＊？");
    }

    #[test]
    fn conflicts_receive_stable_numbered_suffixes() {
        let original = Path::new("C:\\Music\\first.flac");
        let desired = Path::new("C:\\Music\\same.flac");
        let reserved = HashSet::from([
            path_key(desired),
            path_key(Path::new("C:\\Music\\same (1).flac")),
        ]);
        assert_eq!(
            reserve_available_path(original, desired, &reserved),
            (PathBuf::from("C:\\Music\\same (2).flac"), true)
        );
    }

    #[test]
    fn empty_generated_name_falls_back_to_original_stem() {
        let mut track = sample_track("original.flac");
        track.title.clear();
        let target = build_target_path(Path::new("original.flac"), &track, "@1", &[]).unwrap();
        assert_eq!(target, PathBuf::from("original.flac"));
    }

    #[test]
    fn configured_audio_fixture_is_renamed_and_read_back() {
        let Ok(source) = std::env::var("LYRICO_REPLAY_GAIN_FIXTURE") else {
            return;
        };
        let root = std::env::temp_dir().join(format!(
            "lyrico-rename-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).expect("temporary folder should be created");
        let extension = Path::new(&source)
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("flac");
        let original = root.join(format!("before.{extension}"));
        std::fs::copy(&source, &original).expect("fixture should copy");
        let preview = generate_previews(
            &[original.to_string_lossy().into_owned()],
            "@2 - @1",
            &[default_mapping_rule()],
            "/",
        )
        .expect("preview should be generated")
        .remove(0);
        let planned = PathBuf::from(preview.new_path);
        let updated = execute_rename(&original, &planned, "/").expect("rename should succeed");
        assert!(!original.exists());
        assert!(planned.exists());
        assert_eq!(Path::new(&updated.path), planned);
        assert_eq!(updated.title, "Rename Title");
        assert_eq!(updated.artist, "Rename Artist");
        std::fs::remove_dir_all(root).expect("temporary folder should be removed");
    }

    fn default_mapping_rule() -> CharacterMappingRule {
        CharacterMappingRule {
            is_enabled: true,
            char_mappings: [
                ("\\", "＼"),
                ("/", "／"),
                (":", "："),
                ("*", "＊"),
                ("?", "？"),
                ("\"", "＂"),
                ("<", "＜"),
                (">", "＞"),
                ("|", "｜"),
            ]
            .into_iter()
            .map(|(key, value)| (key.to_string(), Some(value.to_string())))
            .collect(),
            ..CharacterMappingRule::default()
        }
    }

    fn sample_track(path: &str) -> AudioTrack {
        AudioTrack {
            id: path.to_string(),
            path: path.to_string(),
            file_name: path.to_string(),
            title: "标题".to_string(),
            artist: "艺术家".to_string(),
            album: "专辑".to_string(),
            album_artist: "专辑艺术家".to_string(),
            genre: "Pop".to_string(),
            language: String::new(),
            composer: String::new(),
            lyricist: String::new(),
            copyright: String::new(),
            rating: None,
            comment: String::new(),
            lyrics: String::new(),
            track_number: Some(3),
            disc_number: Some(1),
            year: "2026".to_string(),
            duration_seconds: 0,
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
}
