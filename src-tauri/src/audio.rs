use crate::models::{AudioTrack, TagUpdate};
use base64::{engine::general_purpose, Engine as _};
use image::codecs::jpeg::JpegEncoder;
use lofty::config::WriteOptions;
use lofty::file::{AudioFile, TaggedFile, TaggedFileExt};
use lofty::picture::{MimeType, Picture, PictureType};
use lofty::tag::items::popularimeter::{Popularimeter, StarRating};
use lofty::tag::{Accessor, ItemKey, ItemValue, Tag, TagExt, TagItem, TagType};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

pub(crate) const AUDIO_EXTENSIONS: &[&str] = &[
    "mp3", "flac", "m4a", "mp4", "aac", "ogg", "opus", "wav", "aiff", "aif",
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
) -> Result<AudioTrack, lofty::error::FileParseError> {
    let tagged_file = lofty::read_from_path(path)?;
    let properties = tagged_file.properties();
    let tag = tagged_file
        .primary_tag()
        .or_else(|| tagged_file.first_tag());
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default()
        .to_string();
    let fallback_title = path
        .file_stem()
        .and_then(|name| name.to_str())
        .unwrap_or_default()
        .to_string();
    let title = tag
        .and_then(|tag| tag.title().map(|value| value.into_owned()))
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(fallback_title);
    let artist = tag
        .and_then(|tag| joined_tag_values(tag, ItemKey::TrackArtist, artist_separator))
        .unwrap_or_default();
    let album = tag
        .and_then(|tag| tag.album().map(|value| value.into_owned()))
        .unwrap_or_default();
    let genre = tag
        .and_then(|tag| joined_tag_values(tag, ItemKey::Genre, "; "))
        .unwrap_or_default();
    let language = read_text(tag, ItemKey::Language);
    let composer = read_text(tag, ItemKey::Composer);
    let lyricist = read_text(tag, ItemKey::Lyricist);
    let copyright = read_text(tag, ItemKey::CopyrightMessage);
    let rating = tag
        .and_then(|tag| tag.ratings().next())
        .map(|popularimeter| popularimeter.rating() as u8);
    let comment = tag
        .and_then(|tag| tag.comment().map(|value| value.into_owned()))
        .unwrap_or_default();
    let album_artist = tag
        .and_then(|tag| joined_tag_values(tag, ItemKey::AlbumArtist, artist_separator))
        .unwrap_or_default();
    let lyrics = tag
        .and_then(|tag| {
            tag.get_string(ItemKey::Lyrics)
                .or_else(|| tag.get_string(ItemKey::UnsyncLyrics))
                .map(ToOwned::to_owned)
        })
        .unwrap_or_default();
    let year = tag
        .and_then(|tag| {
            tag.get_string(ItemKey::RecordingDate)
                .or_else(|| tag.get_string(ItemKey::Year))
                .map(ToOwned::to_owned)
        })
        .unwrap_or_default();
    let replay_gain_track_gain = tag
        .and_then(|tag| {
            tag.get_string(ItemKey::ReplayGainTrackGain)
                .map(ToOwned::to_owned)
        })
        .unwrap_or_default();
    let replay_gain_track_peak = tag
        .and_then(|tag| {
            tag.get_string(ItemKey::ReplayGainTrackPeak)
                .map(ToOwned::to_owned)
        })
        .unwrap_or_default();
    let replay_gain_album_gain = tag
        .and_then(|tag| {
            tag.get_string(ItemKey::ReplayGainAlbumGain)
                .map(ToOwned::to_owned)
        })
        .unwrap_or_default();
    let replay_gain_album_peak = tag
        .and_then(|tag| {
            tag.get_string(ItemKey::ReplayGainAlbumPeak)
                .map(ToOwned::to_owned)
        })
        .unwrap_or_default();
    let has_cover = tag.is_some_and(|tag| !tag.pictures().is_empty());
    let cover_data_url = match artwork_mode {
        ArtworkMode::None => None,
        ArtworkMode::Full => tag.and_then(cover_data_url),
    };
    let metadata = std::fs::metadata(path).ok();
    let modified_at = system_time_secs(metadata.as_ref().and_then(|meta| meta.modified().ok()));
    let created_at = system_time_secs(metadata.as_ref().and_then(|meta| meta.created().ok()));

    Ok(AudioTrack {
        id: path.to_string_lossy().to_string(),
        path: path.to_string_lossy().to_string(),
        file_name,
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
        lyrics: lyrics.clone(),
        track_number: tag.and_then(Accessor::track),
        disc_number: tag.and_then(Accessor::disk),
        year,
        duration_seconds: properties.duration().as_secs(),
        format: path
            .extension()
            .and_then(|extension| extension.to_str())
            .unwrap_or_default()
            .to_uppercase(),
        bitrate: properties.audio_bitrate(),
        sample_rate: properties.sample_rate(),
        channels: properties.channels(),
        has_lyrics: !lyrics.trim().is_empty(),
        has_cover,
        replay_gain_track_gain,
        replay_gain_track_peak,
        replay_gain_album_gain,
        replay_gain_album_peak,
        replay_gain_reference_loudness: String::new(),
        cover_data_url,
        modified_at,
        added_at: None,
        created_at,
    })
}

fn system_time_secs(value: Option<std::time::SystemTime>) -> Option<u64> {
    value
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs())
}

/// One lock per file, so a manual save and a batch task can never interleave
/// their read-modify-write cycles on the same tag.
fn path_write_slot(path: &Path) -> Arc<Mutex<()>> {
    static SLOTS: OnceLock<Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>> = OnceLock::new();
    let slots = SLOTS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut map = slots.lock().unwrap_or_else(|error| error.into_inner());
    map.entry(crate::path_access::path_key(path))
        .or_default()
        .clone()
}

pub(crate) fn save_tags(update: TagUpdate, artist_separator: &str) -> Result<AudioTrack, String> {
    let slot = path_write_slot(Path::new(&update.path));
    let _guard = slot.lock().unwrap_or_else(|error| error.into_inner());
    write_tags_update(update, artist_separator)
}

fn write_tags_update(update: TagUpdate, artist_separator: &str) -> Result<AudioTrack, String> {
    let path = std::path::PathBuf::from(&update.path);
    let mut tagged_file = lofty::read_from_path(&path).map_err(|error| error.to_string())?;
    let stale_tags = ensure_primary_tag(&mut tagged_file);
    let tag = tagged_file
        .primary_tag_mut()
        .ok_or_else(|| "This audio format does not support writable primary tags".to_string())?;
    if update.remove_cover {
        tag.remove_picture_type(PictureType::CoverFront);
    } else if let Some(cover_data_url) = update.cover_data_url.as_deref() {
        let picture = picture_from_data_url(cover_data_url)?;
        tag.remove_picture_type(PictureType::CoverFront);
        tag.push_picture(picture);
    }
    set_string(
        tag,
        update.title,
        |tag, value| tag.set_title(value),
        |tag| tag.remove_title(),
    );
    set_string(
        tag,
        update.artist,
        |tag, value| tag.set_artist(value),
        |tag| tag.remove_artist(),
    );
    set_string(
        tag,
        update.album,
        |tag, value| tag.set_album(value),
        |tag| tag.remove_album(),
    );
    set_text_items(tag, ItemKey::Genre, update.genre);
    set_text_item(tag, ItemKey::Language, update.language);
    set_text_item(tag, ItemKey::Composer, update.composer);
    set_text_item(tag, ItemKey::Lyricist, update.lyricist);
    set_text_item(tag, ItemKey::CopyrightMessage, update.copyright);
    set_rating(tag, update.rating);
    set_string(
        tag,
        update.comment,
        |tag, value| tag.set_comment(value),
        |tag| tag.remove_comment(),
    );
    set_text_item(tag, ItemKey::AlbumArtist, update.album_artist);
    set_lyrics(tag, update.lyrics);
    set_text_item(tag, ItemKey::RecordingDate, update.year.clone());
    set_text_item(tag, ItemKey::Year, update.year);
    set_text_item(
        tag,
        ItemKey::ReplayGainTrackGain,
        update.replay_gain_track_gain,
    );
    set_text_item(
        tag,
        ItemKey::ReplayGainTrackPeak,
        update.replay_gain_track_peak,
    );
    set_text_item(
        tag,
        ItemKey::ReplayGainAlbumGain,
        update.replay_gain_album_gain,
    );
    set_text_item(
        tag,
        ItemKey::ReplayGainAlbumPeak,
        update.replay_gain_album_peak,
    );
    let _reference_loudness = update.replay_gain_reference_loudness;
    set_u32(
        tag,
        update.track_number,
        |tag, value| tag.set_track(value),
        |tag| tag.remove_track(),
    );
    set_u32(
        tag,
        update.disc_number,
        |tag, value| tag.set_disk(value),
        |tag| tag.remove_disk(),
    );
    save_tag(tag, &path).map_err(|error| error.to_string())?;
    remove_stale_tags(&path, &stale_tags)?;
    read_track(&path, artist_separator, ArtworkMode::Full).map_err(|error| error.to_string())
}

pub(crate) fn write_replay_gain_tags(
    path: &Path,
    artist_separator: &str,
    track_gain: String,
    track_peak: String,
) -> Result<AudioTrack, String> {
    let slot = path_write_slot(path);
    let _guard = slot.lock().unwrap_or_else(|error| error.into_inner());
    write_replay_gain_tags_locked(path, artist_separator, track_gain, track_peak)
}

fn write_replay_gain_tags_locked(
    path: &Path,
    artist_separator: &str,
    track_gain: String,
    track_peak: String,
) -> Result<AudioTrack, String> {
    let mut tagged_file = lofty::read_from_path(path).map_err(|error| error.to_string())?;
    let stale_tags = ensure_primary_tag(&mut tagged_file);
    let tag = tagged_file
        .primary_tag_mut()
        .ok_or_else(|| "This audio format does not support writable primary tags".to_string())?;
    set_text_item(tag, ItemKey::ReplayGainTrackGain, track_gain);
    set_text_item(tag, ItemKey::ReplayGainTrackPeak, track_peak);
    save_tag(tag, path).map_err(|error| error.to_string())?;
    remove_stale_tags(path, &stale_tags)?;
    read_track(path, artist_separator, ArtworkMode::None).map_err(|error| error.to_string())
}

pub(crate) fn write_lyrics_tag(
    path: &Path,
    artist_separator: &str,
    lyrics: String,
) -> Result<AudioTrack, String> {
    let slot = path_write_slot(path);
    let _guard = slot.lock().unwrap_or_else(|error| error.into_inner());
    write_lyrics_tag_locked(path, artist_separator, lyrics)
}

fn write_lyrics_tag_locked(
    path: &Path,
    artist_separator: &str,
    lyrics: String,
) -> Result<AudioTrack, String> {
    let mut tagged_file = lofty::read_from_path(path).map_err(|error| error.to_string())?;
    let stale_tags = ensure_primary_tag(&mut tagged_file);
    let tag = tagged_file
        .primary_tag_mut()
        .ok_or_else(|| "This audio format does not support writable primary tags".to_string())?;
    set_lyrics(tag, lyrics);
    save_tag(tag, path).map_err(|error| error.to_string())?;
    remove_stale_tags(path, &stale_tags)?;
    read_track(path, artist_separator, ArtworkMode::None).map_err(|error| error.to_string())
}

pub(crate) fn read_cover_thumbnail(path: &Path) -> Option<String> {
    let tagged_file = lofty::read_from_path(path).ok()?;
    let tag = tagged_file
        .primary_tag()
        .or_else(|| tagged_file.first_tag())?;
    cover_preview_data_url_from_bytes(tag.pictures().first()?.data(), 128, 82)
}

pub(crate) fn read_cover_artwork(path: &Path) -> Option<String> {
    let tagged_file = lofty::read_from_path(path).ok()?;
    let tag = tagged_file
        .primary_tag()
        .or_else(|| tagged_file.first_tag())?;
    cover_preview_data_url_from_bytes(tag.pictures().first()?.data(), 384, 88)
}

pub(crate) fn read_embedded_cover(path: &Path) -> Result<Option<Vec<u8>>, String> {
    let tagged_file = lofty::read_from_path(path).map_err(|error| error.to_string())?;
    let tag = tagged_file
        .primary_tag()
        .or_else(|| tagged_file.first_tag());
    let picture = tag.and_then(|tag| {
        tag.pictures()
            .iter()
            .find(|picture| picture.pic_type() == PictureType::CoverFront)
            .or_else(|| tag.pictures().first())
    });
    Ok(picture.map(|picture| picture.data().to_vec()))
}

pub(crate) fn read_image_data_url(path: &Path) -> Result<String, String> {
    let bytes = std::fs::read(path).map_err(|error| error.to_string())?;
    if bytes.len() > 25 * 1024 * 1024 {
        return Err("Cover image must be smaller than 25 MB".to_string());
    }
    image::load_from_memory(&bytes)
        .map_err(|_| "Selected file is not a valid image".to_string())?;
    let picture = Picture::unchecked(bytes).build();
    Ok(format!(
        "data:{};base64,{}",
        picture_mime(&picture),
        general_purpose::STANDARD.encode(picture.data())
    ))
}

pub(crate) fn write_image_data_url(path: &Path, data_url: &str) -> Result<(), String> {
    let picture = picture_from_data_url(data_url)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    std::fs::write(path, picture.data()).map_err(|error| error.to_string())
}

pub(crate) fn is_audio_path(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            AUDIO_EXTENSIONS
                .iter()
                .any(|candidate| candidate.eq_ignore_ascii_case(extension))
        })
}

fn set_string(
    tag: &mut Tag,
    value: String,
    set: impl FnOnce(&mut Tag, String),
    remove: impl FnOnce(&mut Tag),
) {
    let value = value.trim().to_string();
    if value.is_empty() {
        remove(tag);
    } else {
        set(tag, value);
    }
}

fn set_text_item(tag: &mut Tag, key: ItemKey, value: String) {
    let value = value.trim().to_string();
    if value.is_empty() {
        tag.remove_key(key);
    } else {
        tag.insert_text(key, value);
    }
}

fn set_lyrics(tag: &mut Tag, value: String) {
    let value = value.trim().to_string();
    tag.remove_key(ItemKey::Lyrics);
    tag.remove_key(ItemKey::UnsyncLyrics);
    if value.is_empty() {
        return;
    }
    // ID3v2 has no `ItemKey::Lyrics` mapping (only USLT), so the insert silently fails there.
    if !tag.insert_text(ItemKey::Lyrics, value.clone()) {
        tag.insert_text(ItemKey::UnsyncLyrics, value);
    }
}

// The MP3 writers create the primary tag when the file has none, because that is where
// lofty stores MP3 metadata. A file holding only an ID3v1 tag keeps its old values in that
// tag, so the callers get the types they must drop once the new tag is on disk — otherwise
// the file ends up with two conflicting tags and ID3v1-only readers show the previous data.
fn ensure_primary_tag(tagged_file: &mut TaggedFile) -> Vec<TagType> {
    if tagged_file.primary_tag().is_some() {
        return Vec::new();
    }
    let stale = tagged_file
        .tags()
        .iter()
        .map(|tag| tag.tag_type())
        .collect::<Vec<_>>();
    let tag_type = tagged_file.primary_tag_type();
    tagged_file.insert_tag(Tag::new(tag_type));
    stale
}

// Runs only after the primary tag was written: until then the stale tag may be the sole
// tag in the file, and a failed save must not have thrown it away.
fn remove_stale_tags(path: &Path, stale: &[TagType]) -> Result<(), String> {
    for tag_type in stale {
        // lofty's remove_from_path probes the file with a read-only handle (Probe::open)
        // and then writes through it, which fails with AccessDenied on Windows.
        let mut file = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(path)
            .map_err(|error| error.to_string())?;
        tag_type
            .remove_from(&mut file, WriteOptions::new())
            .map_err(|error| {
                let mut message = error.to_string();
                let mut source = std::error::Error::source(&error);
                while let Some(inner) = source {
                    message.push_str(&format!(": {inner}"));
                    source = std::error::Error::source(inner);
                }
                message
            })?;
    }
    Ok(())
}

fn save_tag(tag: &mut Tag, path: &Path) -> Result<(), lofty::error::FileEncodingError> {
    sanitize_frame_languages(tag);
    clear_readonly(path);
    match tag.save_to_path(path, WriteOptions::new()) {
        Err(error) if is_invalid_frame_language(&error) => {
            // The bad language survived on a format-specific frame lofty keeps beside
            // the item list. Rebuild from the sanitized items and write that instead.
            rebuild_without_companion(tag);
            sanitize_frame_languages(tag);
            clear_readonly(path);
            tag.save_to_path(path, WriteOptions::new())
        }
        other => other,
    }
}

fn is_invalid_frame_language(error: &lofty::error::FileEncodingError) -> bool {
    error.to_string().contains("Invalid frame language")
}

// lofty opens the file with `.write(true)`, so the Windows read-only attribute makes every
// save fail with PermissionDenied. Clear it first; if the volume itself is read-only the
// set_permissions call fails and the real save error still surfaces.
fn clear_readonly(path: &Path) {
    let Ok(metadata) = std::fs::metadata(path) else {
        return;
    };
    let mut permissions = metadata.permissions();
    if !permissions.readonly() {
        return;
    }
    #[allow(clippy::permissions_set_readonly_false)]
    permissions.set_readonly(false);
    let _ = std::fs::set_permissions(path, permissions);
}

// lofty parses ID3v2 COMM/USLT language fields without validating them, but rejects them
// on write. A tag read from disk can therefore carry e.g. b"   " and block every save.
fn sanitize_frame_languages(tag: &mut Tag) {
    let items = tag.items().cloned().collect::<Vec<_>>();
    let mut changed = false;
    let items = items
        .into_iter()
        .map(|mut item| {
            if item.lang().iter().any(|byte| !byte.is_ascii_alphabetic()) {
                item.set_lang(*b"XXX");
                changed = true;
            }
            item
        })
        .collect::<Vec<_>>();
    if !changed && !tag.has_format_specific_items() {
        return;
    }
    if tag.has_format_specific_items() {
        rebuild_without_companion(tag);
        for item in items {
            tag.push_unchecked(item);
        }
        return;
    }
    tag.retain(|_| false);
    for item in items {
        tag.push_unchecked(item);
    }
}

fn rebuild_without_companion(tag: &mut Tag) {
    let tag_type = tag.tag_type();
    let pictures = tag.pictures().to_vec();
    *tag = Tag::new(tag_type);
    for picture in pictures {
        tag.push_picture(picture);
    }
}

fn set_text_items(tag: &mut Tag, key: ItemKey, values: Vec<String>) {
    tag.remove_key(key);
    let mut seen = HashSet::new();
    for value in values
        .into_iter()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    {
        if !seen.insert(value.to_lowercase()) {
            continue;
        }
        tag.push(TagItem::new(key, ItemValue::Text(value)));
    }
}

fn set_rating(tag: &mut Tag, rating: Option<u8>) {
    tag.remove_key(ItemKey::Popularimeter);
    let rating = match rating {
        Some(1) => StarRating::One,
        Some(2) => StarRating::Two,
        Some(3) => StarRating::Three,
        Some(4) => StarRating::Four,
        Some(5) => StarRating::Five,
        _ => return,
    };
    tag.insert_text(
        ItemKey::Popularimeter,
        Popularimeter::musicbee(rating, 0).to_string(),
    );
}

fn read_text(tag: Option<&Tag>, key: ItemKey) -> String {
    tag.and_then(|tag| tag.get_string(key).map(ToOwned::to_owned))
        .unwrap_or_default()
}

fn set_u32(
    tag: &mut Tag,
    value: Option<u32>,
    set: impl FnOnce(&mut Tag, u32),
    remove: impl FnOnce(&mut Tag),
) {
    match value {
        Some(value) if value > 0 => set(tag, value),
        _ => remove(tag),
    }
}

fn joined_tag_values(tag: &Tag, key: ItemKey, separator: &str) -> Option<String> {
    let values = tag
        .get_strings(key)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>();
    (!values.is_empty()).then(|| values.join(separator))
}

fn cover_data_url(tag: &Tag) -> Option<String> {
    let picture = tag.pictures().first()?;
    let mime = picture_mime(picture);
    let encoded = general_purpose::STANDARD.encode(picture.data());
    Some(format!("data:{mime};base64,{encoded}"))
}

fn cover_preview_data_url_from_bytes(bytes: &[u8], max_size: u32, quality: u8) -> Option<String> {
    let image = image::load_from_memory(bytes).ok()?;
    let thumbnail = image.thumbnail(max_size, max_size).to_rgb8();
    let mut encoded_thumbnail = Vec::new();
    JpegEncoder::new_with_quality(&mut encoded_thumbnail, quality)
        .encode_image(&thumbnail)
        .ok()?;
    Some(format!(
        "data:image/jpeg;base64,{}",
        general_purpose::STANDARD.encode(encoded_thumbnail)
    ))
}

fn picture_mime(picture: &Picture) -> &'static str {
    let data = picture.data();
    if data.starts_with(&[0xFF, 0xD8, 0xFF]) {
        "image/jpeg"
    } else if data.starts_with(b"\x89PNG\r\n\x1A\n") {
        "image/png"
    } else if data.starts_with(b"GIF87a") || data.starts_with(b"GIF89a") {
        "image/gif"
    } else if data.len() > 12 && &data[0..4] == b"RIFF" && &data[8..12] == b"WEBP" {
        "image/webp"
    } else {
        "application/octet-stream"
    }
}

fn picture_from_data_url(data_url: &str) -> Result<Picture, String> {
    let (header, encoded) = data_url
        .split_once(',')
        .ok_or_else(|| "Invalid cover data URL".to_string())?;
    if !header.starts_with("data:image/") || !header.ends_with(";base64") {
        return Err("Cover must be a base64 image data URL".to_string());
    }
    let mime = header
        .trim_start_matches("data:")
        .trim_end_matches(";base64");
    let bytes = general_purpose::STANDARD
        .decode(encoded)
        .map_err(|error| error.to_string())?;
    image::load_from_memory(&bytes)
        .map_err(|_| "Selected cover is not a valid image".to_string())?;
    Ok(Picture::unchecked(bytes)
        .pic_type(PictureType::CoverFront)
        .mime_type(MimeType::from_str(mime))
        .build())
}

#[cfg(test)]
mod tests {
    use super::*;
    use lofty::tag::TagType;

    #[test]
    fn path_write_slot_is_shared_for_the_same_file() {
        let first = Path::new(r"D:\Music\a.mp3");
        let other = Path::new(r"D:\Music\b.mp3");
        assert!(Arc::ptr_eq(&path_write_slot(first), &path_write_slot(first)));
        assert!(!Arc::ptr_eq(&path_write_slot(first), &path_write_slot(other)));
    }

    #[test]
    fn multi_value_genres_are_trimmed_and_deduplicated() {
        let mut tag = Tag::new(TagType::VorbisComments);
        set_text_items(
            &mut tag,
            ItemKey::Genre,
            vec![" Rock ".into(), "Pop".into(), "rock".into(), "".into()],
        );

        assert_eq!(
            tag.get_strings(ItemKey::Genre).collect::<Vec<_>>(),
            vec!["Rock", "Pop"]
        );
    }

    #[test]
    fn rating_uses_a_portable_popularimeter_value() {
        let mut tag = Tag::new(TagType::Id3v2);
        set_rating(&mut tag, Some(4));

        assert_eq!(
            tag.ratings().next().map(|rating| rating.rating() as u8),
            Some(4)
        );
        set_rating(&mut tag, None);
        assert!(tag.ratings().next().is_none());
    }

    #[test]
    fn cover_data_url_is_validated_and_mapped_to_front_cover() {
        let mut bytes = Vec::new();
        image::DynamicImage::new_rgba8(1, 1)
            .write_to(
                &mut std::io::Cursor::new(&mut bytes),
                image::ImageFormat::Png,
            )
            .unwrap();
        let data_url = format!(
            "data:image/png;base64,{}",
            general_purpose::STANDARD.encode(bytes)
        );
        let picture = picture_from_data_url(&data_url).expect("valid PNG cover");
        assert_eq!(picture.pic_type(), PictureType::CoverFront);
        assert_eq!(picture.mime_type(), Some(&MimeType::Png));
        assert!(picture_from_data_url("data:text/plain;base64,SGVsbG8=").is_err());
    }

    #[test]
    fn replay_gain_writer_changes_only_supported_replay_gain_fields() {
        let Ok(source) = std::env::var("LYRICO_REPLAY_GAIN_FIXTURE") else {
            return;
        };
        let source = std::path::PathBuf::from(source);
        let extension = source
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("flac");
        let target = std::env::temp_dir().join(format!(
            "lyrico-replay-gain-write-{}.{extension}",
            std::process::id()
        ));
        std::fs::copy(&source, &target).expect("fixture should copy");
        let before = read_track(&target, "/", ArtworkMode::None).expect("fixture should read");
        let after =
            write_replay_gain_tags(&target, "/", "-8.50 dB".to_string(), "0.987654".to_string())
                .expect("ReplayGain tags should write");
        assert_eq!(after.replay_gain_track_gain, "-8.50 dB");
        assert_eq!(after.replay_gain_track_peak, "0.987654");
        assert_eq!(after.title, before.title);
        assert_eq!(after.artist, before.artist);
        assert_eq!(after.album, before.album);
        let _ = std::fs::remove_file(target);
    }

    #[test]
    fn lyrics_writer_changes_only_the_lyrics_field() {
        let Ok(source) = std::env::var("LYRICO_REPLAY_GAIN_FIXTURE") else {
            return;
        };
        let source = std::path::PathBuf::from(source);
        let extension = source
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("flac");
        let target = std::env::temp_dir().join(format!(
            "lyrico-lyrics-write-{}.{extension}",
            std::process::id()
        ));
        std::fs::copy(&source, &target).expect("fixture should copy");
        let before = read_track(&target, "/", ArtworkMode::None).expect("fixture should read");
        let lyrics = "[00:01.000]歌词格式化测试".to_string();
        let after = write_lyrics_tag(&target, "/", lyrics.clone())
            .expect("lyrics should write and read back");
        assert_eq!(after.lyrics, lyrics);
        assert_eq!(after.title, before.title);
        assert_eq!(after.artist, before.artist);
        assert_eq!(after.album, before.album);
        assert_eq!(after.replay_gain_track_gain, before.replay_gain_track_gain);
        assert_eq!(after.replay_gain_track_peak, before.replay_gain_track_peak);
        let _ = std::fs::remove_file(target);
    }

    fn craft_id3v2_mp3(frame_id: [u8; 4], language: [u8; 3]) -> Vec<u8> {
        let mut payload = vec![0x00u8];
        payload.extend_from_slice(&language);
        payload.push(0x00);
        payload.extend_from_slice(b"fixture body");

        let mut frames = Vec::new();
        frames.extend_from_slice(&frame_id);
        frames.extend_from_slice(&(payload.len() as u32).to_be_bytes());
        frames.extend_from_slice(&[0x00, 0x00]);
        frames.extend_from_slice(&payload);

        let size = frames.len() as u32;
        let mut file = vec![b'I', b'D', b'3', 0x04, 0x00, 0x00];
        file.extend_from_slice(&[
            (size >> 21) as u8,
            (size >> 14) as u8,
            (size >> 7) as u8,
            size as u8,
        ]);
        file.extend_from_slice(&frames);

        // lofty needs at least two consecutive matching frames to accept the stream.
        for _ in 0..8 {
            file.extend_from_slice(&[0xFF, 0xFB, 0x90, 0x00]);
            file.extend(std::iter::repeat_n(0u8, 413));
        }
        file
    }

    #[test]
    fn blank_id3v2_languages_do_not_block_saves() {
        for frame_id in [*b"COMM", *b"USLT"] {
            let path = std::env::temp_dir().join(format!(
                "lyrico-blank-lang-{}-{}.mp3",
                std::process::id(),
                String::from_utf8_lossy(&frame_id)
            ));
            std::fs::write(&path, craft_id3v2_mp3(frame_id, *b"   "))
                .expect("fixture should write");

            let mut tagged_file = lofty::read_from_path(&path).expect("fixture should read");
            let tag = tagged_file
                .primary_tag_mut()
                .expect("fixture should have a primary tag");
            tag.set_title("renamed".to_string());
            save_tag(tag, &path).expect("a blank language must not block the save");

            let saved = lofty::read_from_path(&path).expect("saved file should read");
            let tag = saved.primary_tag().expect("primary tag");
            assert_eq!(tag.title().as_deref(), Some("renamed"));
            let _ = std::fs::remove_file(&path);
        }
    }

    #[test]
    fn sanitize_frame_languages_rewrites_invalid_codes() {
        let mut tag = Tag::new(TagType::Id3v2);
        let mut item = TagItem::new(ItemKey::Comment, ItemValue::Text("c".to_string()));
        item.set_lang(*b"   ");
        tag.push_unchecked(item);

        sanitize_frame_languages(&mut tag);

        assert_eq!(tag.items().next().map(TagItem::lang), Some(b"XXX"));
    }

    #[test]
    fn lyrics_write_falls_back_to_a_key_the_tag_type_supports() {
        let mut mp3 = Tag::new(TagType::Id3v2);
        set_lyrics(&mut mp3, "  [00:01.000]hi  ".to_string());
        assert_eq!(
            mp3.get_string(ItemKey::UnsyncLyrics),
            Some("[00:01.000]hi")
        );
        assert!(!mp3.contains(ItemKey::Lyrics));

        let mut flac = Tag::new(TagType::VorbisComments);
        set_lyrics(&mut flac, "hi".to_string());
        assert_eq!(flac.get_string(ItemKey::Lyrics), Some("hi"));
        assert!(!flac.contains(ItemKey::UnsyncLyrics));

        set_lyrics(&mut flac, " ".to_string());
        assert!(flac.is_empty());
    }

    #[test]
    fn save_tags_repairs_blank_id3v2_languages_and_keeps_content() {
        let path = std::env::temp_dir().join(format!(
            "lyrico-save-tags-blank-lang-{}.mp3",
            std::process::id()
        ));
        std::fs::write(&path, craft_id3v2_mp3(*b"COMM", *b"   "))
            .expect("fixture should write");

        let update = TagUpdate {
            path: path.to_string_lossy().into_owned(),
            title: "renamed".to_string(),
            artist: "artist".to_string(),
            album: String::new(),
            album_artist: String::new(),
            genre: Vec::new(),
            language: String::new(),
            composer: String::new(),
            lyricist: String::new(),
            copyright: String::new(),
            rating: None,
            comment: "kept comment".to_string(),
            lyrics: "[00:01.000]line".to_string(),
            track_number: None,
            disc_number: None,
            year: String::new(),
            replay_gain_track_gain: String::new(),
            replay_gain_track_peak: String::new(),
            replay_gain_album_gain: String::new(),
            replay_gain_album_peak: String::new(),
            replay_gain_reference_loudness: String::new(),
            cover_data_url: None,
            remove_cover: false,
        };

        save_tags(update, "/").expect("a blank frame language must not block save_tags");

        let after = read_track(&path, "/", ArtworkMode::None).expect("saved file should read");
        assert_eq!(after.title, "renamed");
        assert_eq!(after.comment, "kept comment");
        assert_eq!(after.lyrics, "[00:01.000]line");

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn save_tag_works_on_a_read_only_file() {
        let path = std::env::temp_dir().join(format!(
            "lyrico-readonly-{}.mp3",
            std::process::id()
        ));
        std::fs::write(&path, craft_id3v2_mp3(*b"COMM", *b"eng"))
            .expect("fixture should write");

        let tagged_file = lofty::read_from_path(&path).expect("fixture should read");
        let mut tag = tagged_file
            .primary_tag()
            .expect("fixture should have a primary tag")
            .clone();
        tag.set_title("before".to_string());
        tag.save_to_path(&path, WriteOptions::new())
            .expect("baseline save should work");

        let mut permissions = std::fs::metadata(&path)
            .expect("fixture metadata")
            .permissions();
        permissions.set_readonly(true);
        std::fs::set_permissions(&path, permissions).expect("fixture should become read-only");

        tag.set_title("after".to_string());
        if tag.save_to_path(&path, WriteOptions::new()).is_ok() {
            // This platform does not enforce the read-only attribute, so there is nothing
            // for clear_readonly to rescue here.
            let _ = std::fs::remove_file(&path);
            return;
        }

        save_tag(&mut tag, &path).expect("a read-only file must not block the save");

        let saved = lofty::read_from_path(&path).expect("saved file should read");
        assert_eq!(
            saved.primary_tag().expect("primary tag").title().as_deref(),
            Some("after")
        );
        assert!(
            !std::fs::metadata(&path)
                .expect("saved metadata")
                .permissions()
                .readonly()
        );

        let _ = std::fs::remove_file(&path);
    }

    fn craft_id3v1_mp3() -> Vec<u8> {
        let mut file = Vec::new();
        for _ in 0..8 {
            file.extend_from_slice(&[0xFF, 0xFB, 0x90, 0x00]);
            file.extend(std::iter::repeat_n(0u8, 413));
        }
        let mut v1 = vec![0u8; 128];
        v1[0..3].copy_from_slice(b"TAG");
        for (start, text) in [
            (3usize, b"old title".as_slice()),
            (33, b"old artist"),
            (63, b"old album"),
        ] {
            v1[start..start + text.len()].copy_from_slice(text);
        }
        file.extend(v1);
        file
    }

    fn id3v1_title_update(path: &Path) -> TagUpdate {
        TagUpdate {
            path: path.to_string_lossy().into_owned(),
            title: "new title".to_string(),
            artist: "new artist".to_string(),
            album: String::new(),
            album_artist: String::new(),
            genre: Vec::new(),
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
            replay_gain_track_gain: String::new(),
            replay_gain_track_peak: String::new(),
            replay_gain_album_gain: String::new(),
            replay_gain_album_peak: String::new(),
            replay_gain_reference_loudness: String::new(),
            cover_data_url: None,
            remove_cover: false,
        }
    }

    #[test]
    fn save_tags_replaces_a_lone_id3v1_tag() {
        let path =
            std::env::temp_dir().join(format!("lyrico-probe-v1-{}.mp3", std::process::id()));
        std::fs::write(&path, craft_id3v1_mp3()).expect("fixture should write");

        let before = lofty::read_from_path(&path).expect("fixture should read");
        assert_eq!(
            before
                .tags()
                .iter()
                .map(|tag| tag.tag_type())
                .collect::<Vec<_>>(),
            vec![TagType::Id3v1]
        );
        assert!(before.primary_tag().is_none());
        assert_eq!(
            before
                .first_tag()
                .and_then(|tag| tag.title().map(|value| value.into_owned())),
            Some("old title".to_string())
        );

        save_tags(id3v1_title_update(&path), "/").expect("save_tags should write");

        let after = lofty::read_from_path(&path).expect("saved file should read");
        assert_eq!(
            after
                .tags()
                .iter()
                .map(|tag| tag.tag_type())
                .collect::<Vec<_>>(),
            vec![TagType::Id3v2],
            "the superseded ID3v1 tag must not be left behind"
        );
        assert_eq!(
            after
                .primary_tag()
                .and_then(|tag| tag.title().map(|value| value.into_owned())),
            Some("new title".to_string())
        );

        let _ = std::fs::remove_file(&path);
    }
}
