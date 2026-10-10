use super::processor::{BatchProcessor, ProcessContext, ProcessError, ProcessOutcome};
use crate::audio::{read_image_data_url, read_track, save_tag_fields, ArtworkMode};
use crate::lyrics::{self, LyricsOptions};
use crate::models::{AudioTrack, TagUpdate};
use serde::Deserialize;
use serde_json::json;
use std::path::Path;
use std::sync::atomic::Ordering;

#[derive(Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct EditTagsConfig {
    title: Option<String>,
    artist: Option<String>,
    album_artist: Option<String>,
    album: Option<String>,
    year: Option<String>,
    language: Option<String>,
    genre: Option<String>,
    track_number: Option<String>,
    disc_number: Option<String>,
    composer: Option<String>,
    lyricist: Option<String>,
    copyright: Option<String>,
    comment: Option<String>,
    lyrics: Option<String>,
    rating: Option<u8>,
    rating_modified: bool,
    cover_path: Option<String>,
    remove_cover: bool,
    lyrics_offset_ms: i64,
    replay_gain_track_gain: Option<String>,
    replay_gain_track_peak: Option<String>,
    replay_gain_album_gain: Option<String>,
    replay_gain_album_peak: Option<String>,
    replay_gain_reference_loudness: Option<String>,
}

pub(super) struct EditTagsProcessor;

impl BatchProcessor for EditTagsProcessor {
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
        let current = read_track(path, context.artist_separator, ArtworkMode::None)
            .map_err(|error| ProcessError::Failed(error.to_string()))?;
        let cover_data_url = config
            .cover_path
            .as_deref()
            .map(Path::new)
            .map(read_image_data_url)
            .transpose()
            .map_err(ProcessError::Failed)?;
        let (update, changed_fields) = build_update(&current, &config, cover_data_url)?;
        if changed_fields.is_empty() {
            return Err(ProcessError::Skipped("No changes".to_string()));
        }
        on_progress(0.75);
        if context.cancelled.load(Ordering::Relaxed) {
            return Err(ProcessError::Cancelled("Batch item cancelled".to_string()));
        }
        let updated = save_tag_fields(update, context.artist_separator, &changed_fields)
            .map_err(ProcessError::Failed)?;
        Ok(ProcessOutcome {
            result_json: Some(json!({ "changedFields": changed_fields }).to_string()),
            updated_track: Some(updated),
            previous_track_path: None,
        })
    }
}

fn parse_config(config_json: Option<&str>) -> Result<EditTagsConfig, ProcessError> {
    let raw = config_json.ok_or_else(|| ProcessError::Skipped("No config".to_string()))?;
    let config: EditTagsConfig = serde_json::from_str(raw)
        .map_err(|error| ProcessError::Failed(format!("Invalid edit tags config: {error}")))?;
    if config.cover_path.is_some() && config.remove_cover {
        return Err(ProcessError::Failed(
            "Cover replacement and removal cannot be enabled together".to_string(),
        ));
    }
    if config.rating.is_some_and(|rating| rating > 5) {
        return Err(ProcessError::Failed(
            "Rating must be between 0 and 5".to_string(),
        ));
    }
    if !has_operation(&config) {
        return Err(ProcessError::Skipped(
            "No tag edit operation selected".to_string(),
        ));
    }
    Ok(config)
}

fn has_operation(config: &EditTagsConfig) -> bool {
    config.title.is_some()
        || config.artist.is_some()
        || config.album_artist.is_some()
        || config.album.is_some()
        || config.year.is_some()
        || config.language.is_some()
        || config.genre.is_some()
        || config.track_number.is_some()
        || config.disc_number.is_some()
        || config.composer.is_some()
        || config.lyricist.is_some()
        || config.copyright.is_some()
        || config.comment.is_some()
        || config.lyrics.is_some()
        || config.rating_modified
        || config.cover_path.is_some()
        || config.remove_cover
        || config.lyrics_offset_ms != 0
        || config.replay_gain_track_gain.is_some()
        || config.replay_gain_track_peak.is_some()
        || config.replay_gain_album_gain.is_some()
        || config.replay_gain_album_peak.is_some()
        || config.replay_gain_reference_loudness.is_some()
}

fn build_update(
    current: &AudioTrack,
    config: &EditTagsConfig,
    cover_data_url: Option<String>,
) -> Result<(TagUpdate, Vec<String>), ProcessError> {
    let mut changed = Vec::new();
    let title = edit_string(&current.title, &config.title, "title", &mut changed);
    let artist = edit_string(&current.artist, &config.artist, "artist", &mut changed);
    let album_artist = edit_string(
        &current.album_artist,
        &config.album_artist,
        "albumArtist",
        &mut changed,
    );
    let album = edit_string(&current.album, &config.album, "album", &mut changed);
    let year = edit_string(&current.year, &config.year, "year", &mut changed);
    let language = edit_string(
        &current.language,
        &config.language,
        "language",
        &mut changed,
    );
    let composer = edit_string(
        &current.composer,
        &config.composer,
        "composer",
        &mut changed,
    );
    let lyricist = edit_string(
        &current.lyricist,
        &config.lyricist,
        "lyricist",
        &mut changed,
    );
    let copyright = edit_string(
        &current.copyright,
        &config.copyright,
        "copyright",
        &mut changed,
    );
    let comment = edit_string(&current.comment, &config.comment, "comment", &mut changed);
    let mut lyrics = edit_string(&current.lyrics, &config.lyrics, "lyrics", &mut changed);
    let replay_gain_track_gain = edit_string(
        &current.replay_gain_track_gain,
        &config.replay_gain_track_gain,
        "replayGainTrackGain",
        &mut changed,
    );
    let replay_gain_track_peak = edit_string(
        &current.replay_gain_track_peak,
        &config.replay_gain_track_peak,
        "replayGainTrackPeak",
        &mut changed,
    );
    let replay_gain_album_gain = edit_string(
        &current.replay_gain_album_gain,
        &config.replay_gain_album_gain,
        "replayGainAlbumGain",
        &mut changed,
    );
    let replay_gain_album_peak = edit_string(
        &current.replay_gain_album_peak,
        &config.replay_gain_album_peak,
        "replayGainAlbumPeak",
        &mut changed,
    );
    let replay_gain_reference_loudness = edit_string(
        &current.replay_gain_reference_loudness,
        &config.replay_gain_reference_loudness,
        "replayGainReferenceLoudness",
        &mut changed,
    );
    let current_genre = split_genre(&current.genre);
    let genre = config
        .genre
        .as_deref()
        .map(split_genre)
        .unwrap_or_else(|| current_genre.clone());
    if config.genre.is_some() && genre != current_genre {
        changed.push("genre".to_string());
    }
    let track_number = edit_number(
        current.track_number,
        &config.track_number,
        "trackNumber",
        &mut changed,
    )?;
    let disc_number = edit_number(
        current.disc_number,
        &config.disc_number,
        "discNumber",
        &mut changed,
    )?;
    let rating = if config.rating_modified {
        let next = config.rating.filter(|value| (1..=5).contains(value));
        if next != current.rating {
            changed.push("rating".to_string());
        }
        next
    } else {
        current.rating
    };
    if config.lyrics_offset_ms != 0 && !lyrics.trim().is_empty() {
        let shifted = lyrics::process_text(
            &lyrics,
            &LyricsOptions {
                offset_ms: config.lyrics_offset_ms,
                ..LyricsOptions::default()
            },
        )
        .map_err(ProcessError::Failed)?
        .text;
        if shifted != lyrics {
            lyrics = shifted;
            changed.push("lyricsOffset".to_string());
        }
    }
    let remove_cover = config.remove_cover && current.has_cover;
    if remove_cover {
        changed.push("cover".to_string());
    } else if cover_data_url.is_some() {
        changed.push("cover".to_string());
    }

    Ok((
        TagUpdate {
            custom_tags: None,
            path: current.path.clone(),
            title,
            artist,
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
            remove_cover,
        },
        changed,
    ))
}

fn edit_string(
    current: &str,
    configured: &Option<String>,
    field: &str,
    changed: &mut Vec<String>,
) -> String {
    let Some(value) = configured else {
        return current.to_string();
    };
    if value != current {
        changed.push(field.to_string());
    }
    value.clone()
}

fn edit_number(
    current: Option<u32>,
    configured: &Option<String>,
    field: &str,
    changed: &mut Vec<String>,
) -> Result<Option<u32>, ProcessError> {
    let Some(value) = configured else {
        return Ok(current);
    };
    let value = value.trim();
    let next = if value.is_empty() {
        None
    } else {
        Some(value.parse::<u32>().map_err(|_| {
            ProcessError::Failed(format!("Invalid numeric value for {field}: {value}"))
        })?)
    };
    if next != current {
        changed.push(field.to_string());
    }
    Ok(next)
}

fn split_genre(value: &str) -> Vec<String> {
    value
        .split([';', ',', '/'])
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_distinguishes_keep_clear_and_invalid_empty_operation() {
        assert!(matches!(
            parse_config(Some(r#"{"concurrency":3}"#)),
            Err(ProcessError::Skipped(_))
        ));
        let config = parse_config(Some(
            r#"{"title":"","trackNumber":"","ratingModified":true,"rating":0}"#,
        ))
        .expect("clear operations should be valid");
        assert_eq!(config.title.as_deref(), Some(""));
        assert_eq!(config.track_number.as_deref(), Some(""));
        assert!(config.rating_modified);
    }

    #[test]
    fn merge_only_changes_selected_fields_and_uses_shared_lyrics_offset() {
        let current = sample_track();
        let config: EditTagsConfig =
            serde_json::from_str(r#"{"artist":"新艺术家","comment":"","lyricsOffsetMs":500}"#)
                .unwrap();
        let (update, changed) = build_update(&current, &config, None).unwrap();
        assert_eq!(update.title, current.title);
        assert_eq!(update.artist, "新艺术家");
        assert_eq!(update.comment, "");
        assert_eq!(update.lyrics, "[00:01.500]line");
        assert_eq!(changed, ["artist", "comment", "lyricsOffset"]);
    }

    #[test]
    fn reference_loudness_can_be_changed_and_cleared_without_changing_other_gain_tags() {
        let mut current = sample_track();
        current.replay_gain_reference_loudness = "-18 LUFS".to_string();
        for value in ["-16 LUFS", ""] {
            let config = parse_config(Some(
                &json!({ "replayGainReferenceLoudness": value }).to_string(),
            ))
            .unwrap();
            let (update, changed) = build_update(&current, &config, None).unwrap();
            assert_eq!(update.replay_gain_reference_loudness, value);
            assert_eq!(
                update.replay_gain_track_gain,
                current.replay_gain_track_gain
            );
            assert_eq!(changed, ["replayGainReferenceLoudness"]);
        }
    }

    #[test]
    fn configured_audio_fixture_is_written_and_read_back() {
        let Ok(source) = std::env::var("LYRICO_REPLAY_GAIN_FIXTURE") else {
            return;
        };
        let source = std::path::PathBuf::from(source);
        let extension = source
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("flac");
        let target = std::env::temp_dir().join(format!(
            "lyrico-batch-edit-write-{}.{extension}",
            std::process::id()
        ));
        std::fs::copy(&source, &target).expect("fixture should copy");
        let before = read_track(&target, "/", ArtworkMode::None).expect("fixture should read");
        let config: EditTagsConfig = serde_json::from_str(
            r#"{"title":"批量编辑写后重读","comment":"","lyrics":"[00:01.000]批量编辑测试"}"#,
        )
        .unwrap();
        let (mut update, changed) = build_update(&before, &config, None).unwrap();
        update.path = target.to_string_lossy().into_owned();
        assert!(changed.iter().any(|field| field == "title"));
        assert!(changed.iter().any(|field| field == "lyrics"));
        crate::audio::save_tags(update, "/").expect("batch edit tags should write");
        let after = read_track(&target, "/", ArtworkMode::None)
            .expect("batch edit tags should read back from disk");
        assert_eq!(after.title, "批量编辑写后重读");
        assert_eq!(after.comment, "");
        assert_eq!(after.lyrics, "[00:01.000]批量编辑测试");
        assert_eq!(after.artist, before.artist);
        assert_eq!(after.album, before.album);
        let _ = std::fs::remove_file(target);
    }

    fn sample_track() -> AudioTrack {
        AudioTrack {
            id: "song".to_string(),
            path: "song.flac".to_string(),
            file_name: "song.flac".to_string(),
            title: "标题".to_string(),
            artist: "艺术家".to_string(),
            album: "专辑".to_string(),
            album_artist: "专辑艺术家".to_string(),
            genre: "Pop".to_string(),
            language: "zho".to_string(),
            composer: "作曲".to_string(),
            lyricist: "作词".to_string(),
            copyright: "版权".to_string(),
            rating: Some(4),
            comment: "注释".to_string(),
            lyrics: "[00:01.000]line".to_string(),
            track_number: Some(1),
            disc_number: Some(1),
            year: "2026".to_string(),
            duration_seconds: 60,
            format: "FLAC".to_string(),
            bitrate: None,
            sample_rate: None,
            channels: None,
            cover_data_url: None,
            has_lyrics: true,
            has_cover: false,
            replay_gain_track_gain: "-8.00 dB".to_string(),
            replay_gain_track_peak: "0.9".to_string(),
            replay_gain_album_gain: "".to_string(),
            replay_gain_album_peak: "".to_string(),
            replay_gain_reference_loudness: "".to_string(),
            modified_at: None,
            added_at: None,
            created_at: None,
        }
    }
}
