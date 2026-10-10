//! Audio metadata service. TagLib is the only tag engine; all callers use this facade.
use crate::models::{AudioTrack, CustomTag, TagUpdate};
use crate::taglib_bridge::{Cover, File, Properties};
use base64::{engine::general_purpose, Engine as _};
use image::codecs::jpeg::JpegEncoder;
use std::collections::{BTreeMap, HashSet};
use std::path::Path;

// Raw ADTS AAC has no TagLib metadata writer. MP4/AAC remains supported as m4a/mp4.
pub(crate) const AUDIO_EXTENSIONS: &[&str] = &[
    "mp3", "flac", "m4a", "mp4", "ogg", "opus", "wav", "aiff", "aif",
];
#[derive(Clone, Copy)]
pub(crate) enum ArtworkMode {
    None,
    Full,
}

pub(crate) fn read_track(
    path: &Path,
    artist_separator: &str,
    artwork_mode: ArtworkMode,
) -> Result<AudioTrack, String> {
    let file = File::open(path, true)?;
    track_from_file(&file, path, artist_separator, artwork_mode)
}
fn track_from_file(
    file: &File,
    path: &Path,
    artist_separator: &str,
    artwork_mode: ArtworkMode,
) -> Result<AudioTrack, String> {
    let tags = file.properties()?;
    let properties = file.audio_properties()?;
    let metadata = std::fs::metadata(path).ok();
    let lyrics = text(&tags, "LYRICS");
    let cover = match artwork_mode {
        ArtworkMode::None => None,
        ArtworkMode::Full => file.cover()?,
    };
    let title = text(&tags, "TITLE");
    Ok(AudioTrack {
        id: path.to_string_lossy().into_owned(),
        path: path.to_string_lossy().into_owned(),
        file_name: path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned(),
        title: if title.trim().is_empty() {
            path.file_stem()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned()
        } else {
            title
        },
        artist: joined(&tags, "ARTIST", artist_separator),
        album: text(&tags, "ALBUM"),
        album_artist: joined(&tags, "ALBUMARTIST", artist_separator),
        genre: joined(&tags, "GENRE", "; "),
        language: text(&tags, "LANGUAGE"),
        composer: text(&tags, "COMPOSER"),
        lyricist: text(&tags, "LYRICIST"),
        copyright: text(&tags, "COPYRIGHT"),
        rating: rating(&tags),
        comment: text(&tags, "COMMENT"),
        has_lyrics: !lyrics.trim().is_empty(),
        lyrics,
        track_number: number(&tags, "TRACKNUMBER"),
        disc_number: number(&tags, "DISCNUMBER"),
        year: text(&tags, "DATE"),
        duration_seconds: u64::try_from(properties.duration_ms).unwrap_or_default() / 1000,
        format: path
            .extension()
            .unwrap_or_default()
            .to_string_lossy()
            .to_uppercase(),
        bitrate: positive(properties.bitrate),
        sample_rate: positive(properties.sample_rate),
        channels: u8::try_from(properties.channels)
            .ok()
            .filter(|channels| *channels > 0),
        has_cover: properties.has_cover != 0,
        cover_data_url: cover.as_ref().map(cover_data_url),
        replay_gain_track_gain: text(&tags, "REPLAYGAIN_TRACK_GAIN"),
        replay_gain_track_peak: text(&tags, "REPLAYGAIN_TRACK_PEAK"),
        replay_gain_album_gain: text(&tags, "REPLAYGAIN_ALBUM_GAIN"),
        replay_gain_album_peak: text(&tags, "REPLAYGAIN_ALBUM_PEAK"),
        replay_gain_reference_loudness: text(&tags, "REPLAYGAIN_REFERENCE_LOUDNESS"),
        modified_at: system_time_secs(metadata.as_ref().and_then(|meta| meta.modified().ok())),
        created_at: system_time_secs(metadata.as_ref().and_then(|meta| meta.created().ok())),
        added_at: None,
    })
}
// Rating normalization is a business rule; the native bridge only transports properties.
fn rating(tags: &Properties) -> Option<u8> {
    let raw = tags
        .get("RATING")
        .or_else(|| tags.get("RATE"))?
        .first()?
        .parse::<u8>()
        .ok()?;
    let stars = if raw <= 5 { raw } else { raw / 20 };
    (1..=5).contains(&stars).then_some(stars)
}
fn system_time_secs(time: Option<std::time::SystemTime>) -> Option<u64> {
    time.and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs())
}
fn positive(value: i32) -> Option<u32> {
    u32::try_from(value).ok().filter(|value| *value > 0)
}
fn text(tags: &Properties, key: &str) -> String {
    tags.get(key)
        .and_then(|values| values.first())
        .cloned()
        .unwrap_or_default()
}
fn joined(tags: &Properties, key: &str, separator: &str) -> String {
    tags.get(key)
        .map(|values| {
            values
                .iter()
                .map(|value| value.trim())
                .filter(|value| !value.is_empty())
                .collect::<Vec<_>>()
                .join(separator)
        })
        .unwrap_or_default()
}
fn number(tags: &Properties, key: &str) -> Option<u32> {
    text(tags, key)
        .split('/')
        .next()?
        .trim()
        .parse()
        .ok()
        .filter(|value| *value > 0)
}
fn set_text(file: &mut File, key: &str, value: &str) -> Result<(), String> {
    let value = value.trim();
    file.set_property(
        key,
        &if value.is_empty() {
            vec![]
        } else {
            vec![value.to_string()]
        },
    )
}
fn set_number(
    file: &mut File,
    tags: &Properties,
    key: &str,
    number: Option<u32>,
) -> Result<(), String> {
    let total = text(tags, key)
        .split_once('/')
        .map(|(_, total)| total.to_string());
    let value = number
        .filter(|number| *number > 0)
        .map(|number| match total {
            Some(total) if !total.is_empty() => format!("{number}/{total}"),
            _ => number.to_string(),
        })
        .unwrap_or_default();
    set_text(file, key, &value)
}
fn mutate(
    path: &Path,
    artist_separator: &str,
    artwork: ArtworkMode,
    edit: impl FnOnce(&mut File) -> Result<(), String>,
) -> Result<AudioTrack, String> {
    crate::file_mutation::write_copy(path, |temporary| {
        let mut file = File::open_writable(temporary)?;
        edit(&mut file)?;
        file.save()?;
        drop(file);
        // Validate while still staged. The visible identity always remains the original path.
        let file = File::open(temporary, true)?;
        track_from_file(&file, path, artist_separator, artwork)
    })
    .map(|mut track| {
        let metadata = std::fs::metadata(path).ok();
        track.modified_at =
            system_time_secs(metadata.as_ref().and_then(|meta| meta.modified().ok()));
        track.created_at = system_time_secs(metadata.and_then(|meta| meta.created().ok()));
        track
    })
}
pub(crate) fn save_tags(update: TagUpdate, artist_separator: &str) -> Result<AudioTrack, String> {
    save_update(update, artist_separator, None)
}
/// Batch operations patch only their explicitly selected fields, preserving concurrent edits.
pub(crate) fn save_tag_fields(
    update: TagUpdate,
    artist_separator: &str,
    fields: &[String],
) -> Result<AudioTrack, String> {
    save_update(update, artist_separator, Some(fields))
}
fn field_key(value: &str) -> String {
    let key = value
        .chars()
        .filter(|character| *character != '_')
        .flat_map(char::to_lowercase)
        .collect::<String>();
    match key.as_str() {
        "date" => "year".into(),
        "lyricsoffset" => "lyrics".into(),
        "coverurl" => "cover".into(),
        _ => key,
    }
}
fn save_update(
    update: TagUpdate,
    artist_separator: &str,
    fields: Option<&[String]>,
) -> Result<AudioTrack, String> {
    let selected = fields.map(|fields| {
        fields
            .iter()
            .map(|field| field_key(field))
            .collect::<HashSet<_>>()
    });
    let should_write = |key: &str| {
        selected
            .as_ref()
            .is_none_or(|fields| fields.contains(&field_key(key)))
    };
    // Validate every requested custom key before beginning any mutation.
    let custom = update
        .custom_tags
        .as_deref()
        .map(normalize_custom_tags)
        .transpose()?;
    let cover = update
        .cover_data_url
        .as_deref()
        .map(picture_from_data_url)
        .transpose()?;
    mutate(
        Path::new(&update.path),
        artist_separator,
        ArtworkMode::Full,
        |file| {
            let existing = file.properties()?;
            for (key, value) in [
                ("TITLE", &update.title),
                ("ARTIST", &update.artist),
                ("ALBUM", &update.album),
                ("ALBUMARTIST", &update.album_artist),
                ("LANGUAGE", &update.language),
                ("COMPOSER", &update.composer),
                ("LYRICIST", &update.lyricist),
                ("COPYRIGHT", &update.copyright),
                ("COMMENT", &update.comment),
                ("LYRICS", &update.lyrics),
                ("DATE", &update.year),
                ("REPLAYGAIN_TRACK_GAIN", &update.replay_gain_track_gain),
                ("REPLAYGAIN_TRACK_PEAK", &update.replay_gain_track_peak),
                ("REPLAYGAIN_ALBUM_GAIN", &update.replay_gain_album_gain),
                ("REPLAYGAIN_ALBUM_PEAK", &update.replay_gain_album_peak),
                (
                    "REPLAYGAIN_REFERENCE_LOUDNESS",
                    &update.replay_gain_reference_loudness,
                ),
            ] {
                if should_write(key) {
                    set_text(file, key, value)?;
                }
            }
            let mut seen = HashSet::new();
            let genres = update
                .genre
                .iter()
                .map(|value| value.trim())
                .filter(|value| !value.is_empty() && seen.insert(value.to_lowercase()))
                .map(str::to_owned)
                .collect::<Vec<_>>();
            if should_write("genre") {
                file.set_property("GENRE", &genres)?;
            }
            if should_write("trackNumber") {
                set_number(file, &existing, "TRACKNUMBER", update.track_number)?;
            }
            if should_write("discNumber") {
                set_number(file, &existing, "DISCNUMBER", update.disc_number)?;
            }
            if should_write("rating") {
                let value = update
                    .rating
                    .filter(|rating| (1..=5).contains(rating))
                    .map(|rating| (rating * 20).to_string())
                    .unwrap_or_default();
                set_text(file, "RATING", &value)?;
            }
            if should_write("cover") {
                if update.remove_cover {
                    file.set_cover(None)?;
                } else if let Some(cover) = &cover {
                    file.set_cover(Some(cover))?;
                }
            }
            if let Some(custom) = &custom {
                for key in existing
                    .keys()
                    .filter(|key| !is_standard_property(key) && !custom.contains_key(*key))
                {
                    file.set_property(key, &[])?;
                }
                for (key, values) in custom {
                    file.set_property(key, values)?;
                }
            }
            Ok(())
        },
    )
}
pub(crate) fn write_lyrics_tag(
    path: &Path,
    artist_separator: &str,
    lyrics: String,
) -> Result<AudioTrack, String> {
    mutate(path, artist_separator, ArtworkMode::None, |file| {
        set_text(file, "LYRICS", &lyrics)
    })
}
pub(crate) fn write_replay_gain_tags(
    path: &Path,
    artist_separator: &str,
    track_gain: String,
    track_peak: String,
    reference_loudness: String,
) -> Result<AudioTrack, String> {
    mutate(path, artist_separator, ArtworkMode::None, |file| {
        set_text(file, "REPLAYGAIN_TRACK_GAIN", &track_gain)?;
        set_text(file, "REPLAYGAIN_TRACK_PEAK", &track_peak)?;
        set_text(file, "REPLAYGAIN_REFERENCE_LOUDNESS", &reference_loudness)
    })
}
pub(crate) fn read_custom_tags(path: &Path) -> Result<Vec<CustomTag>, String> {
    Ok(File::open(path, false)?
        .properties()?
        .into_iter()
        .filter(|(key, _)| !is_standard_property(key))
        .map(|(key, values)| CustomTag { key, values })
        .collect())
}
fn normalize_custom_tags(tags: &[CustomTag]) -> Result<Properties, String> {
    let mut result = BTreeMap::new();
    for tag in tags {
        let key = tag.key.trim().to_ascii_uppercase();
        if key.is_empty()
            || key.chars().any(|character| character.is_control())
            || is_standard_property(&key)
        {
            return Err(format!("Invalid or reserved custom tag key: {key}"));
        }
        if result.insert(key.clone(), tag.values.clone()).is_some() {
            return Err(format!("Duplicate custom tag key: {key}"));
        }
    }
    Ok(result)
}
fn is_standard_property(key: &str) -> bool {
    matches!(
        key.to_ascii_uppercase().as_str(),
        "TITLE"
            | "ARTIST"
            | "ALBUM"
            | "ALBUMARTIST"
            | "GENRE"
            | "DATE"
            | "YEAR"
            | "TRACKNUMBER"
            | "DISCNUMBER"
            | "COMPOSER"
            | "LYRICIST"
            | "COPYRIGHT"
            | "COMMENT"
            | "LANGUAGE"
            | "LYRICS"
            | "UNSYNCEDLYRICS"
            | "RATING"
            | "RATE"
            | "FMPS_RATING"
            | "REPLAYGAIN_TRACK_GAIN"
            | "REPLAYGAIN_TRACK_PEAK"
            | "REPLAYGAIN_ALBUM_GAIN"
            | "REPLAYGAIN_ALBUM_PEAK"
            | "REPLAYGAIN_REFERENCE_LOUDNESS"
            | "PICTURE"
            | "METADATA_BLOCK_PICTURE"
            | "COVERART"
            | "COVERARTMIME"
    )
}
pub(crate) fn read_embedded_cover(path: &Path) -> Result<Option<Vec<u8>>, String> {
    Ok(File::open(path, false)?.cover()?.map(|cover| cover.data))
}
pub(crate) fn read_cover_thumbnail(path: &Path) -> Option<String> {
    cover_preview(path, 128, 82)
}
pub(crate) fn read_cover_artwork(path: &Path) -> Option<String> {
    cover_preview(path, 384, 88)
}
fn cover_preview(path: &Path, max_size: u32, quality: u8) -> Option<String> {
    let cover = File::open(path, false).ok()?.cover().ok()??;
    let image = image::load_from_memory(&cover.data).ok()?;
    let thumbnail = image.thumbnail(max_size, max_size).to_rgb8();
    let mut encoded = Vec::new();
    JpegEncoder::new_with_quality(&mut encoded, quality)
        .encode_image(&thumbnail)
        .ok()?;
    Some(format!(
        "data:image/jpeg;base64,{}",
        general_purpose::STANDARD.encode(encoded)
    ))
}
pub(crate) fn read_image_data_url(path: &Path) -> Result<String, String> {
    let bytes = std::fs::read(path).map_err(|error| error.to_string())?;
    Ok(cover_data_url(&validated_picture(bytes)?))
}
pub(crate) fn write_image_data_url(path: &Path, data_url: &str) -> Result<(), String> {
    let cover = picture_from_data_url(data_url)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    std::fs::write(path, cover.data).map_err(|error| error.to_string())
}
fn cover_data_url(cover: &Cover) -> String {
    format!(
        "data:{};base64,{}",
        cover.mime,
        general_purpose::STANDARD.encode(&cover.data)
    )
}
fn validated_picture(bytes: Vec<u8>) -> Result<Cover, String> {
    if bytes.len() > 25 * 1024 * 1024 {
        return Err("Cover image must be smaller than 25 MB".into());
    }
    let format = image::guess_format(&bytes).map_err(|_| "Not a supported image")?;
    image::load_from_memory(&bytes).map_err(|_| "Not a valid image")?;
    let mime = match format {
        image::ImageFormat::Jpeg => "image/jpeg",
        image::ImageFormat::Png => "image/png",
        image::ImageFormat::Gif => "image/gif",
        image::ImageFormat::WebP => "image/webp",
        _ => return Err("Unsupported cover image format".into()),
    };
    Ok(Cover {
        mime: mime.into(),
        data: bytes,
    })
}
fn picture_from_data_url(url: &str) -> Result<Cover, String> {
    let (header, encoded) = url.split_once(',').ok_or("Invalid cover data URL")?;
    if !header.starts_with("data:image/") || !header.ends_with(";base64") {
        return Err("Cover must be a base64 image data URL".into());
    }
    validated_picture(
        general_purpose::STANDARD
            .decode(encoded)
            .map_err(|error| error.to_string())?,
    )
}
pub(crate) fn is_audio_path(path: &Path) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .is_some_and(|extension| {
            AUDIO_EXTENSIONS
                .iter()
                .any(|value| value.eq_ignore_ascii_case(extension))
        })
}
