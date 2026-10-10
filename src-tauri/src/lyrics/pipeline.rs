use super::lrc;
use super::model::{
    LyricFormat, LyricsDocument, LyricsLine, LyricsMetadata, LyricsOptions, LyricsPipelineResult,
    LyricsTrack, LyricsWord, TrackType,
};
use super::{processors, ttml};
use regex::Regex;
use serde_json::{Map, Value};
use std::collections::HashSet;
use std::sync::OnceLock;

pub(crate) fn process_text(
    raw: &str,
    options: &LyricsOptions,
) -> Result<LyricsPipelineResult, String> {
    if raw.trim().is_empty() {
        let target_format = options
            .target_format
            .or(options.source_format)
            .unwrap_or(LyricFormat::PlainLrc);
        return Ok(LyricsPipelineResult {
            text: raw.to_string(),
            warnings: Vec::new(),
            source_format: options.source_format,
            target_format,
        });
    }
    let source_format = options.source_format.unwrap_or_else(|| detect_format(raw));
    let target_format = options.target_format.unwrap_or(source_format);
    let mut result = Map::new();
    result.insert(
        raw_key(source_format).to_string(),
        Value::String(raw.to_string()),
    );
    let processed = process_plugin_result(&Value::Object(result), target_format, options)?;
    if !processed.text.is_empty()
        || source_format == LyricFormat::Ttml
        || !options.remove_empty_lines
    {
        return Ok(processed);
    }
    Ok(LyricsPipelineResult {
        text: raw
            .lines()
            .filter(|line| !line.trim().is_empty())
            .collect::<Vec<_>>()
            .join("\n"),
        ..processed
    })
}

pub(crate) fn process_plugin_result(
    result: &Value,
    target_format: LyricFormat,
    options: &LyricsOptions,
) -> Result<LyricsPipelineResult, String> {
    let Some(object) = result.as_object() else {
        return Ok(empty_result(target_format));
    };
    let target_raw = object.get(raw_key(target_format)).and_then(Value::as_str);
    if target_raw.is_some_and(|raw| !raw.trim().is_empty())
        && options.show_translation
        && options.show_romanization
        && !options.only_translation_if_available
        && !options.has_document_transforms()
    {
        return Ok(LyricsPipelineResult {
            text: target_raw.unwrap().to_string(),
            warnings: Vec::new(),
            source_format: Some(target_format),
            target_format,
        });
    }

    let document = if is_structured(object) {
        Some(document_from_structured(object)?)
    } else {
        parse_best_raw_document(object, target_format, options)
    };
    let Some(document) = document else {
        return Ok(empty_result(target_format));
    };
    let source_format = document.source_format;
    let processed = processors::process(document, options);
    let text = match target_format {
        LyricFormat::Ttml => ttml::write(&processed),
        _ => lrc::write(&processed, target_format, options),
    };
    Ok(LyricsPipelineResult {
        text,
        warnings: collect_warnings(object, source_format, target_format),
        source_format,
        target_format,
    })
}

fn empty_result(target_format: LyricFormat) -> LyricsPipelineResult {
    LyricsPipelineResult {
        text: String::new(),
        warnings: Vec::new(),
        source_format: None,
        target_format,
    }
}

fn parse_best_raw_document(
    object: &Map<String, Value>,
    target_format: LyricFormat,
    options: &LyricsOptions,
) -> Option<LyricsDocument> {
    let mut order = Vec::new();
    push_unique(&mut order, target_format);
    if options.show_translation
        || options.show_romanization
        || options.only_translation_if_available
    {
        push_unique(&mut order, LyricFormat::Ttml);
    }
    push_unique(&mut order, LyricFormat::EnhancedLrc);
    push_unique(&mut order, LyricFormat::VerbatimLrc);
    push_unique(&mut order, LyricFormat::PlainLrc);
    push_unique(&mut order, LyricFormat::Ttml);
    for source_format in order {
        let Some(raw) = object.get(raw_key(source_format)).and_then(Value::as_str) else {
            continue;
        };
        if raw.trim().is_empty() {
            continue;
        }
        let parsed = parse_document(raw, source_format);
        if parsed.tracks.iter().any(|track| !track.lines.is_empty()) {
            return Some(parsed);
        }
    }
    None
}

fn push_unique(order: &mut Vec<LyricFormat>, format: LyricFormat) {
    if !order.contains(&format) {
        order.push(format);
    }
}

fn parse_document(raw: &str, format: LyricFormat) -> LyricsDocument {
    if format == LyricFormat::Ttml {
        ttml::parse(raw)
    } else {
        lrc::parse(raw, format)
    }
}

fn document_from_structured(object: &Map<String, Value>) -> Result<LyricsDocument, String> {
    let original = compact_lines(object.get("original"), TrackType::Original)?;
    let mut tracks = vec![LyricsTrack::new(TrackType::Original, original)];
    let translated = compact_lines(object.get("translated"), TrackType::Translation)?;
    if !translated.is_empty() {
        tracks.push(LyricsTrack::new(TrackType::Translation, translated));
    }
    let romanization = compact_lines(object.get("romanization"), TrackType::Romanization)?;
    if !romanization.is_empty() {
        tracks.push(LyricsTrack::new(TrackType::Romanization, romanization));
    }
    let tags = object
        .get("tags")
        .and_then(Value::as_object)
        .map(|tags| {
            tags.iter()
                .filter_map(|(key, value)| {
                    if value.is_null() {
                        return None;
                    }
                    let value = value
                        .as_str()
                        .map(str::to_string)
                        .unwrap_or_else(|| value.to_string());
                    (!value.trim().is_empty()).then(|| (key.clone(), value))
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(LyricsDocument {
        metadata: LyricsMetadata::from_lrc_tags(tags),
        agents: Vec::new(),
        tracks,
        source_format: None,
    })
}

fn compact_lines(value: Option<&Value>, kind: TrackType) -> Result<Vec<LyricsLine>, String> {
    let Some(lines) = value.and_then(Value::as_array) else {
        return Ok(Vec::new());
    };
    lines
        .iter()
        .enumerate()
        .map(|(index, line)| compact_line(line, index, kind))
        .collect()
}

fn compact_line(value: &Value, index: usize, kind: TrackType) -> Result<LyricsLine, String> {
    let items = value
        .as_array()
        .ok_or_else(|| "Structured lyric line must be an array".to_string())?;
    if items.len() < 3 {
        return Err("Structured lyric line must have start, end and text".to_string());
    }
    let start_ms = number_to_i64(&items[0]);
    let end_ms = number_to_i64(&items[1]);
    let mut words = Vec::new();
    let text = if let Some(compact_words) = items[2].as_array() {
        for compact in compact_words {
            let word = compact
                .as_array()
                .ok_or_else(|| "Structured lyric word must be an array".to_string())?;
            if word.len() < 3 {
                return Err("Structured lyric word must have start, end and text".to_string());
            }
            words.push(LyricsWord {
                start_ms: number_to_i64(&word[0]),
                end_ms: number_to_i64(&word[1]),
                text: value_to_text(&word[2]),
            });
        }
        words.iter().map(|word| word.text.as_str()).collect()
    } else {
        value_to_text(&items[2])
    };
    if kind != TrackType::Original {
        words.clear();
    }
    Ok(LyricsLine {
        start_ms,
        end_ms,
        text,
        words,
        link_key: Some(format!("L{}", index + 1)),
        agent_id: None,
    })
}

fn number_to_i64(value: &Value) -> Option<i64> {
    value
        .as_i64()
        .or_else(|| value.as_f64().map(|value| value.round() as i64))
}

fn value_to_text(value: &Value) -> String {
    value
        .as_str()
        .map(str::to_string)
        .unwrap_or_else(|| value.to_string())
}

fn is_structured(object: &Map<String, Value>) -> bool {
    object.get("original").is_some_and(Value::is_array)
}

fn raw_key(format: LyricFormat) -> &'static str {
    match format {
        LyricFormat::PlainLrc => "rawPlainLrc",
        LyricFormat::VerbatimLrc => "rawVerbatimLrc",
        LyricFormat::EnhancedLrc => "rawEnhancedLrc",
        LyricFormat::Ttml => "rawTtml",
    }
}

pub(crate) fn detect_format(raw: &str) -> LyricFormat {
    static TTML: OnceLock<Regex> = OnceLock::new();
    static ENHANCED: OnceLock<Regex> = OnceLock::new();
    static VERBATIM: OnceLock<Regex> = OnceLock::new();
    if TTML
        .get_or_init(|| {
            Regex::new(r"(?i)<(?:\w+:)?tt(?:\s|>)|<(?:\w+:)?p\b[^>]*(?:begin|end)=")
                .expect("valid TTML detection regex")
        })
        .is_match(raw)
    {
        return LyricFormat::Ttml;
    }
    if ENHANCED
        .get_or_init(|| {
            Regex::new(r"<\d{1,3}:\d{2}(?:[.:]\d{1,3})?>")
                .expect("valid enhanced LRC detection regex")
        })
        .is_match(raw)
    {
        return LyricFormat::EnhancedLrc;
    }
    if VERBATIM
        .get_or_init(|| {
            Regex::new(r"(?m)^\s*(?:\[\d{1,3}:\d{2}(?:[.:]\d{1,3})?\].*){2,}")
                .expect("valid verbatim LRC detection regex")
        })
        .is_match(raw)
    {
        return LyricFormat::VerbatimLrc;
    }
    LyricFormat::PlainLrc
}

pub(crate) fn extract_plain_text(raw: &str) -> String {
    if raw.trim().is_empty() {
        return String::new();
    }
    let format = detect_format(raw);
    let document = parse_document(raw, format);
    let lines: Vec<_> = document
        .tracks
        .iter()
        .find(|track| track.kind == TrackType::Original)
        .map(|track| {
            track
                .lines
                .iter()
                .map(LyricsLine::visible_text)
                .filter(|line| !line.is_empty())
                .collect()
        })
        .unwrap_or_default();
    if !lines.is_empty() {
        return lines.join("\n");
    }
    raw.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

fn collect_warnings(
    object: &Map<String, Value>,
    source_format: Option<LyricFormat>,
    target_format: LyricFormat,
) -> Vec<String> {
    if source_format != Some(LyricFormat::Ttml) || target_format == LyricFormat::Ttml {
        return Vec::new();
    }
    let Some(raw) = object.get("rawTtml").and_then(Value::as_str) else {
        return Vec::new();
    };
    let known: HashSet<_> = [
        "http://www.w3.org/ns/ttml",
        "http://www.w3.org/ns/ttml#metadata",
        "http://music.apple.com/lyric-ttml-internal",
    ]
    .into_iter()
    .collect();
    let pattern =
        Regex::new(r#"xmlns(?::[\w-]+)?=["']([^"']+)["']"#).expect("valid namespace regex");
    let mut unknown = Vec::new();
    for namespace in pattern
        .captures_iter(raw)
        .filter_map(|capture| capture.get(1).map(|value| value.as_str()))
    {
        if !known.contains(namespace) && !unknown.contains(&namespace) {
            unknown.push(namespace);
        }
    }
    unknown
        .into_iter()
        .map(|namespace| {
            format!(
                "TTML extension cannot be represented in {}: {namespace}",
                target_format.as_str()
            )
        })
        .collect()
}
