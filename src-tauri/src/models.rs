use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AudioTrack {
    pub(crate) id: String,
    pub(crate) path: String,
    pub(crate) file_name: String,
    pub(crate) title: String,
    pub(crate) artist: String,
    pub(crate) album: String,
    pub(crate) album_artist: String,
    pub(crate) genre: String,
    pub(crate) language: String,
    pub(crate) composer: String,
    pub(crate) lyricist: String,
    pub(crate) copyright: String,
    pub(crate) rating: Option<u8>,
    pub(crate) comment: String,
    pub(crate) lyrics: String,
    pub(crate) track_number: Option<u32>,
    pub(crate) disc_number: Option<u32>,
    pub(crate) year: String,
    pub(crate) duration_seconds: u64,
    pub(crate) format: String,
    pub(crate) bitrate: Option<u32>,
    pub(crate) sample_rate: Option<u32>,
    pub(crate) channels: Option<u8>,
    pub(crate) cover_data_url: Option<String>,
    pub(crate) has_lyrics: bool,
    pub(crate) has_cover: bool,
    pub(crate) replay_gain_track_gain: String,
    pub(crate) replay_gain_track_peak: String,
    pub(crate) replay_gain_album_gain: String,
    pub(crate) replay_gain_album_peak: String,
    pub(crate) replay_gain_reference_loudness: String,
    #[serde(default)]
    pub(crate) modified_at: Option<u64>,
    #[serde(default)]
    pub(crate) added_at: Option<u64>,
    #[serde(default)]
    pub(crate) created_at: Option<u64>,
}

impl AudioTrack {
    pub(crate) fn into_summary(mut self) -> Self {
        self.comment.clear();
        self.lyrics.clear();
        self.cover_data_url = None;
        self
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CustomTag {
    pub(crate) key: String,
    pub(crate) values: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TrackCover {
    pub(crate) path: String,
    pub(crate) cover_data_url: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReplayGainAnalysis {
    pub(crate) job_id: String,
    pub(crate) path: String,
    pub(crate) loudness_lufs: f64,
    pub(crate) sample_count: u64,
    pub(crate) peak: f64,
    pub(crate) track_gain: String,
    pub(crate) track_peak: String,
    pub(crate) reference_loudness: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReplayGainProgress {
    pub(crate) job_id: String,
    pub(crate) path: String,
    pub(crate) percent: u8,
    pub(crate) status: String,
    pub(crate) message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ScanProgress {
    pub(crate) job_id: String,
    pub(crate) folder_path: String,
    pub(crate) phase: String,
    pub(crate) current: usize,
    pub(crate) total: usize,
    pub(crate) errors: usize,
    pub(crate) status: String,
    pub(crate) message: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StorageInfo {
    pub(crate) data_path: String,
    pub(crate) database_path: String,
    pub(crate) config_path: String,
    pub(crate) location: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BatchTask {
    pub(crate) task_id: String,
    pub(crate) task_type: String,
    pub(crate) status: String,
    pub(crate) total: u32,
    pub(crate) current: u32,
    pub(crate) success_count: u32,
    pub(crate) failure_count: u32,
    pub(crate) skipped_count: u32,
    pub(crate) config_json: Option<String>,
    pub(crate) started_at: Option<String>,
    pub(crate) finished_at: Option<String>,
    pub(crate) created_at: String,
    pub(crate) updated_at: String,
    pub(crate) error_message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BatchTaskItem {
    pub(crate) item_id: String,
    pub(crate) task_id: String,
    pub(crate) song_path: String,
    pub(crate) file_name: String,
    pub(crate) status: String,
    pub(crate) progress: Option<f64>,
    pub(crate) result_json: Option<String>,
    pub(crate) error_message: Option<String>,
    pub(crate) created_at: String,
    pub(crate) updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct ArtistSplitConfig {
    pub(crate) enabled: bool,
    #[serde(default = "default_artist_separator")]
    pub(crate) artist_separator: String,
    pub(crate) builtin_separator_overrides: HashMap<String, bool>,
    pub(crate) hidden_builtin_separator_ids: HashSet<String>,
    pub(crate) custom_separators: Vec<CustomArtistSeparator>,
    pub(crate) builtin_no_split_artist_overrides: HashMap<String, bool>,
    pub(crate) custom_no_split_artists: Vec<CustomNoSplitArtist>,
}

impl Default for ArtistSplitConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            artist_separator: default_artist_separator(),
            builtin_separator_overrides: HashMap::new(),
            hidden_builtin_separator_ids: HashSet::new(),
            custom_separators: Vec::new(),
            builtin_no_split_artist_overrides: HashMap::new(),
            custom_no_split_artists: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CustomArtistSeparator {
    pub(crate) id: String,
    pub(crate) value: String,
    #[serde(default = "default_true")]
    pub(crate) enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CustomNoSplitArtist {
    pub(crate) id: String,
    pub(crate) name: String,
    #[serde(default = "default_true")]
    pub(crate) enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LibraryFolder {
    pub(crate) path: String,
    pub(crate) track_count: u32,
    pub(crate) last_scanned_at: Option<String>,
    pub(crate) status: String,
    pub(crate) error: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TagUpdate {
    pub(crate) path: String,
    pub(crate) title: String,
    pub(crate) artist: String,
    pub(crate) album: String,
    pub(crate) album_artist: String,
    pub(crate) genre: Vec<String>,
    pub(crate) language: String,
    pub(crate) composer: String,
    pub(crate) lyricist: String,
    pub(crate) copyright: String,
    pub(crate) rating: Option<u8>,
    pub(crate) comment: String,
    pub(crate) lyrics: String,
    pub(crate) track_number: Option<u32>,
    pub(crate) disc_number: Option<u32>,
    pub(crate) year: String,
    pub(crate) replay_gain_track_gain: String,
    pub(crate) replay_gain_track_peak: String,
    pub(crate) replay_gain_album_gain: String,
    pub(crate) replay_gain_album_peak: String,
    pub(crate) replay_gain_reference_loudness: String,
    pub(crate) cover_data_url: Option<String>,
    pub(crate) remove_cover: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LyricLineMatch {
    pub(crate) path: String,
    pub(crate) title: String,
    pub(crate) artist: String,
    pub(crate) matched_line: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AppLogEntry {
    pub(crate) id: i64,
    pub(crate) created_at: String,
    pub(crate) level: String,
    #[serde(rename = "type")]
    pub(crate) log_type: String,
    pub(crate) tag: String,
    pub(crate) message: String,
    pub(crate) detail: Option<String>,
    pub(crate) related_id: Option<String>,
}

fn default_true() -> bool {
    true
}

fn default_artist_separator() -> String {
    "/".to_string()
}

#[cfg(test)]
mod tests {
    use super::TagUpdate;
    use serde_json::json;

    fn complete_update() -> serde_json::Value {
        json!({
            "path": "song.flac", "title": "", "artist": "", "album": "",
            "albumArtist": "", "genre": [], "language": "", "composer": "",
            "lyricist": "", "copyright": "", "rating": null, "comment": "",
            "lyrics": "", "trackNumber": null, "discNumber": null, "year": "",
            "replayGainTrackGain": "", "replayGainTrackPeak": "",
            "replayGainAlbumGain": "", "replayGainAlbumPeak": "",
            "replayGainReferenceLoudness": "", "coverDataUrl": null,
            "removeCover": false
        })
    }

    #[test]
    fn tag_update_accepts_explicit_empty_fields() {
        assert!(serde_json::from_value::<TagUpdate>(complete_update()).is_ok());
    }

    #[test]
    fn tag_update_rejects_missing_required_fields_instead_of_guessing() {
        let mut value = complete_update();
        value.as_object_mut().unwrap().remove("composer");
        assert!(serde_json::from_value::<TagUpdate>(value).is_err());
    }
}
