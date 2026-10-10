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
