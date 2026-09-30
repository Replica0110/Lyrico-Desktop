use std::ffi::CString;
use std::path::Path;
use std::collections::HashSet;

use crate::models::CustomTag;

#[cfg(target_os = "windows")]
unsafe extern "C" {
    fn lyrico_taglib_list_properties(path: *const i8, output: *mut i8, capacity: usize) -> i32;
    fn lyrico_taglib_read_property(
        path: *const i8,
        key: *const i8,
        output: *mut i8,
        capacity: usize,
    ) -> i32;
    fn lyrico_taglib_write_property(
        path: *const i8,
        key: *const i8,
        values: *const i8,
    ) -> i32;
}

#[cfg(target_os = "windows")]
pub(crate) fn list_properties(path: &Path) -> Result<Vec<String>, String> {
    let path = CString::new(path.to_string_lossy().as_bytes()).map_err(|error| error.to_string())?;
    let mut buffer = vec![0_i8; 1024 * 1024];
    let ok = unsafe {
        lyrico_taglib_list_properties(path.as_ptr(), buffer.as_mut_ptr(), buffer.len())
    };
    if ok == 0 {
        return Err("TagLib could not read this audio file".to_string());
    }
    let bytes = unsafe {
        std::slice::from_raw_parts(buffer.as_ptr().cast::<u8>(), buffer.len())
    };
    let text = std::ffi::CStr::from_bytes_until_nul(bytes)
        .map_err(|error| error.to_string())?
        .to_string_lossy();
    Ok(text.lines().map(str::to_string).collect())
}

#[cfg(target_os = "windows")]
pub(crate) fn read_property(path: &Path, key: &str) -> Result<Vec<String>, String> {
    let path = CString::new(path.to_string_lossy().as_bytes()).map_err(|error| error.to_string())?;
    let key = CString::new(key).map_err(|error| error.to_string())?;
    let mut buffer = vec![0_i8; 1024 * 1024];
    let ok = unsafe {
        lyrico_taglib_read_property(path.as_ptr(), key.as_ptr(), buffer.as_mut_ptr(), buffer.len())
    };
    if ok == 0 {
        return Err("TagLib could not read this property".to_string());
    }
    let bytes = unsafe {
        std::slice::from_raw_parts(buffer.as_ptr().cast::<u8>(), buffer.len())
    };
    let text = std::ffi::CStr::from_bytes_until_nul(bytes)
        .map_err(|error| error.to_string())?
        .to_string_lossy();
    Ok(text.lines().map(str::to_string).collect())
}

#[cfg(target_os = "windows")]
pub(crate) fn write_property(path: &Path, key: &str, values: &[String]) -> Result<(), String> {
    let path = CString::new(path.to_string_lossy().as_bytes()).map_err(|error| error.to_string())?;
    let key = CString::new(key).map_err(|error| error.to_string())?;
    let values = CString::new(values.join("\n")).map_err(|error| error.to_string())?;
    let ok = unsafe {
        lyrico_taglib_write_property(path.as_ptr(), key.as_ptr(), values.as_ptr())
    };
    if ok == 0 {
        return Err("TagLib could not write this property".to_string());
    }
    Ok(())
}

#[cfg(target_os = "windows")]
pub(crate) fn read_custom_tags(path: &Path) -> Result<Vec<CustomTag>, String> {
    let keys = list_properties(path)?;
    let mut tags = Vec::new();
    for key in keys.into_iter().filter(|key| !is_standard_property(key)) {
        let values = read_property(path, &key)?;
        if !values.is_empty() {
            tags.push(CustomTag { key, values });
        }
    }
    tags.sort_by(|left, right| left.key.to_ascii_lowercase().cmp(&right.key.to_ascii_lowercase()));
    Ok(tags)
}

#[cfg(target_os = "windows")]
pub(crate) fn write_custom_tags(path: &Path, tags: &[CustomTag]) -> Result<(), String> {
    let existing = read_custom_tags(path)?;
    let desired = tags
        .iter()
        .map(|tag| tag.key.to_ascii_uppercase())
        .collect::<HashSet<_>>();
    for tag in existing {
        if !desired.contains(&tag.key.to_ascii_uppercase()) {
            write_property(path, &tag.key, &[])?;
        }
    }
    for tag in tags {
        let key = tag.key.trim();
        if key.is_empty() || key.chars().any(|character| character == '\r' || character == '\n') {
            return Err(format!("Invalid custom tag key: {key}"));
        }
        write_property(path, key, &tag.values)?;
    }
    Ok(())
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

#[cfg(not(target_os = "windows"))]
pub(crate) fn list_properties(_path: &Path) -> Result<Vec<String>, String> {
    Err("Custom tag support is currently available on Windows only".to_string())
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn read_property(_path: &Path, _key: &str) -> Result<Vec<String>, String> {
    Err("Custom tag support is currently available on Windows only".to_string())
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn write_property(_path: &Path, _key: &str, _values: &[String]) -> Result<(), String> {
    Err("Custom tag support is currently available on Windows only".to_string())
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn read_custom_tags(_path: &Path) -> Result<Vec<CustomTag>, String> {
    Err("Custom tag support is currently available on Windows only".to_string())
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn write_custom_tags(_path: &Path, _tags: &[CustomTag]) -> Result<(), String> {
    Err("Custom tag support is currently available on Windows only".to_string())
}

#[cfg(test)]
mod tests {
    use super::{is_standard_property, read_custom_tags, write_custom_tags};
    use crate::models::CustomTag;
    use std::path::PathBuf;

    #[test]
    fn standard_properties_are_not_exposed_as_custom_tags() {
        assert!(is_standard_property("TITLE"));
        assert!(is_standard_property("replaygain_track_gain"));
        assert!(!is_standard_property("SOURCE"));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn custom_property_round_trips_through_taglib() {
        let source = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("native")
            .join("taglib")
            .join("taglib")
            .join("tests")
            .join("data")
            .join("no-tags.flac");
        let target = std::env::temp_dir().join(format!(
            "lyrico-custom-tag-{}.flac",
            std::process::id()
        ));
        std::fs::copy(&source, &target).expect("TagLib fixture should copy");
        write_custom_tags(
            &target,
            &[CustomTag {
                key: "SOURCE".to_string(),
                values: vec!["Lyrico test".to_string()],
            }],
        )
        .expect("custom tag should write");
        let tags = read_custom_tags(&target).expect("custom tag should read");
        assert_eq!(tags[0].key, "SOURCE");
        assert_eq!(tags[0].values, vec!["Lyrico test".to_string()]);
        let _ = std::fs::remove_file(target);
    }
}
