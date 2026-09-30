pub(crate) mod installer;
pub(crate) mod i18n;
pub(crate) mod manifest;
pub(crate) mod runtime;
mod xml;

use serde_json::{Map, Value};
use std::collections::BTreeMap;

const LYRICS_CONTAINER_KEYS: &[&str] = &["items", "results", "candidates"];
const API4_TAG_KEYS: &[&str] = &["ti", "ar", "al", "date"];
const RAW_KEYS: &[&str] = &["rawPlainLrc", "rawVerbatimLrc", "rawEnhancedLrc", "rawTtml"];


/// Normalizes a `getLyrics` payload into the API v4 candidate list.
///
/// Accepts an array, an `items`/`results`/`candidates` container object, a
/// single candidate object, or a bare lyric string.
pub(crate) fn lyrics_candidates(value: &Value) -> Vec<Value> {
    match value {
        Value::Null => Vec::new(),
        Value::Array(items) => items.iter().filter_map(candidate_from_value).collect(),
        Value::Object(_) => {
            let container = LYRICS_CONTAINER_KEYS
                .iter()
                .find_map(|key| value.get(key))
                .and_then(Value::as_array);
            match container {
                Some(items) => items.iter().filter_map(candidate_from_value).collect(),
                None => candidate_from_value(value).into_iter().collect(),
            }
        }
        other => candidate_from_value(other).into_iter().collect(),
    }
}

fn candidate_from_value(value: &Value) -> Option<Value> {
    match value {
        Value::String(text) => (!text.trim().is_empty()).then(|| value.clone()),
        Value::Object(map) => {
            if map.get("notFound").and_then(Value::as_bool) == Some(true) {
                return None;
            }
            Some(Value::Object(map.clone()))
        }
        _ => None,
    }
}

/// API v4 requires every candidate to carry `tags.ti` / `ar` / `al` / `date`.
pub(crate) fn filter_api4_candidates(candidates: Vec<Value>) -> Vec<Value> {
    candidates
        .into_iter()
        .filter(|candidate| {
            let tags = candidate_tags(candidate);
            API4_TAG_KEYS
                .iter()
                .all(|key| tags.get(*key).is_some_and(|value| !value.is_empty()))
        })
        .collect()
}

/// Extracts `tags.ti` / `tags.ar` / `tags.al` / `tags.date` from a candidate.
pub(crate) fn candidate_tags(candidate: &Value) -> BTreeMap<String, String> {
    candidate
        .get("tags")
        .and_then(Value::as_object)
        .map(|tags| {
            tags.iter()
                .filter_map(|(key, value)| {
                    value
                        .as_str()
                        .map(|value| (key.clone(), value.trim().to_lowercase()))
                })
                .collect()
        })
        .unwrap_or_default()
}

fn candidate_score(candidate: &Value, title: &str, artist: &str, album: &str) -> i32 {
    let tags = candidate_tags(candidate);
    let mut score = 0_i32;
    let matches = |key: &str, expected: &str| {
        !expected.is_empty() && tags.get(key).is_some_and(|value| value == expected)
    };
    if matches("ti", &title.trim().to_lowercase()) {
        score += 4;
    }
    if matches("ar", &artist.trim().to_lowercase()) {
        score += 3;
    }
    if matches("al", &album.trim().to_lowercase()) {
        score += 2;
    }
    if candidate
        .get("tags")
        .and_then(|tags| tags.get("date"))
        .is_some_and(|value| value.as_str().is_some_and(|value| !value.trim().is_empty()))
    {
        score += 1;
    }
    score
}

/// Sorts candidates by how well their tags match the local track metadata.
pub(crate) fn ordered_lyrics_candidates(
    candidates: Vec<Value>,
    title: &str,
    artist: &str,
    album: &str,
) -> Vec<Value> {
    let mut ranked = candidates
        .into_iter()
        .enumerate()
        .map(|(index, candidate)| (index, candidate_score(&candidate, title, artist, album), candidate))
        .collect::<Vec<_>>();
    ranked.sort_by(|left, right| right.1.cmp(&left.1).then(left.0.cmp(&right.0)));
    ranked
        .into_iter()
        .map(|(_, _, candidate)| candidate)
        .collect()
}

/// Converts a candidate into the object shape the lyrics pipeline understands.
pub(crate) fn lyrics_payload(candidate: &Value) -> Value {
    match candidate {
        Value::String(text) => string_payload(text),
        Value::Object(_) => {
            let object = candidate.as_object().unwrap();
            let has_payload = object.get("original").is_some_and(Value::is_array)
                || RAW_KEYS.iter().any(|key| {
                    object
                        .get(*key)
                        .is_some_and(|value| value.as_str().is_some_and(|text| !text.trim().is_empty()))
                });
            if has_payload {
                candidate.clone()
            } else if let Some(text) = object.get("text").and_then(Value::as_str) {
                string_payload(text)
            } else {
                candidate.clone()
            }
        }
        other => other.clone(),
    }
}

fn string_payload(text: &str) -> Value {
    let key = match crate::lyrics::detect_format(text) {
        crate::lyrics::LyricFormat::Ttml => "rawTtml",
        crate::lyrics::LyricFormat::EnhancedLrc => "rawEnhancedLrc",
        crate::lyrics::LyricFormat::VerbatimLrc => "rawVerbatimLrc",
        crate::lyrics::LyricFormat::PlainLrc => "rawPlainLrc",
    };
    let mut object = Map::new();
    object.insert(key.to_string(), Value::String(text.to_string()));
    Value::Object(object)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn normalizes_api_v4_lyrics_payloads() {
        let candidates = lyrics_candidates(&json!([
            {"type": "rawPlainLrc", "rawPlainLrc": "[00:01.00]line", "tags": {"ti": "Song"}},
            "[00:02.00]plain line",
            {"notFound": true},
            7
        ]));
        assert_eq!(candidates.len(), 2);
        assert_eq!(candidates[1], json!("[00:02.00]plain line"));

        let container = lyrics_candidates(&json!({
            "items": [{"type": "rawPlainLrc", "rawPlainLrc": "line"}]
        }));
        assert_eq!(container.len(), 1);

        let single = lyrics_candidates(&json!({"type": "rawPlainLrc", "rawPlainLrc": "line"}));
        assert_eq!(single.len(), 1);

        assert!(lyrics_candidates(&json!(null)).is_empty());
        assert!(lyrics_candidates(&json!("   ")).is_empty());
    }

    #[test]
    fn enforces_api4_candidate_tags() {
        let candidates = vec![
            json!({"type": "rawPlainLrc", "rawPlainLrc": "a", "tags": {"ti": "Song", "ar": "Artist", "al": "Album", "date": "2024"}}),
            json!({"type": "rawPlainLrc", "rawPlainLrc": "b", "tags": {"ti": "Song"}}),
        ];
        let filtered = filter_api4_candidates(candidates);
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0]["rawPlainLrc"], json!("a"));
    }

    #[test]
    fn orders_candidates_by_tag_similarity() {
        let candidates = lyrics_candidates(&json!([
            {"type": "rawPlainLrc", "rawPlainLrc": "a", "tags": {"ti": "Other"}},
            {"type": "rawPlainLrc", "rawPlainLrc": "b", "tags": {"ti": "Song", "ar": "Artist"}},
            {"type": "rawPlainLrc", "rawPlainLrc": "c", "tags": {"ti": "Other"}}
        ]));
        let ordered = ordered_lyrics_candidates(candidates, "Song", "Artist", "Album");
        assert_eq!(ordered[0]["rawPlainLrc"], json!("b"));

        assert_eq!(
            candidate_tags(&ordered[0]),
            BTreeMap::from([
                ("ti".to_string(), "song".to_string()),
                ("ar".to_string(), "artist".to_string())
            ])
        );
        assert!(ordered_lyrics_candidates(Vec::new(), "a", "b", "c").is_empty());
    }

    #[test]
    fn converts_candidates_into_pipeline_payloads() {
        let structured = json!({"type": "structured", "original": [[1000, 2000, [[1000, 2000, "line"]]]]});
        assert_eq!(lyrics_payload(&structured), structured);

        let lrc = lyrics_payload(&json!("[00:01.00]line"));
        assert_eq!(lrc["rawPlainLrc"], json!("[00:01.00]line"));

        let ttml = lyrics_payload(&json!({"text": "<tt></tt>"}));
        assert!(ttml.get("rawTtml").is_some());

        let raw_only = json!({"type": "rawPlainLrc"});
        assert_eq!(lyrics_payload(&raw_only), raw_only);
    }
}
