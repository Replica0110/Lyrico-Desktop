use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum LyricFormat {
    PlainLrc,
    VerbatimLrc,
    EnhancedLrc,
    Ttml,
}

impl LyricFormat {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::PlainLrc => "plainLrc",
            Self::VerbatimLrc => "verbatimLrc",
            Self::EnhancedLrc => "enhancedLrc",
            Self::Ttml => "ttml",
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum TrackType {
    Original,
    Translation,
    Romanization,
    Background,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct LyricsMetadata {
    pub(crate) title: Option<String>,
    pub(crate) artist: Option<String>,
    pub(crate) album: Option<String>,
    pub(crate) language: Option<String>,
    pub(crate) offset_ms: Option<i64>,
    pub(crate) extra: Vec<(String, String)>,
}

impl LyricsMetadata {
    pub(crate) fn from_lrc_tags(tags: Vec<(String, String)>) -> Self {
        let mut metadata = Self::default();
        for (key, value) in tags {
            match key.as_str() {
                "ti" => metadata.title = Some(value),
                "ar" => metadata.artist = Some(value),
                "al" => metadata.album = Some(value),
                "offset" => metadata.offset_ms = value.parse().ok(),
                _ => metadata.extra.push((key, value)),
            }
        }
        metadata
    }

    pub(crate) fn lrc_tags(&self) -> Vec<(String, String)> {
        let mut tags = Vec::new();
        if let Some(value) = &self.title {
            tags.push(("ti".to_string(), value.clone()));
        }
        if let Some(value) = &self.artist {
            tags.push(("ar".to_string(), value.clone()));
        }
        if let Some(value) = &self.album {
            tags.push(("al".to_string(), value.clone()));
        }
        if let Some(value) = self.offset_ms {
            tags.push(("offset".to_string(), value.to_string()));
        }
        tags.extend(self.extra.clone());
        tags
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct LyricsAgent {
    pub(crate) id: String,
    pub(crate) kind: Option<String>,
    pub(crate) name: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct LyricsWord {
    pub(crate) start_ms: Option<i64>,
    pub(crate) end_ms: Option<i64>,
    pub(crate) text: String,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct LyricsLine {
    pub(crate) start_ms: Option<i64>,
    pub(crate) end_ms: Option<i64>,
    pub(crate) text: String,
    pub(crate) words: Vec<LyricsWord>,
    pub(crate) link_key: Option<String>,
    pub(crate) agent_id: Option<String>,
}

impl LyricsLine {
    pub(crate) fn visible_text(&self) -> String {
        if !self.text.is_empty() {
            self.text.clone()
        } else {
            self.words.iter().map(|word| word.text.as_str()).collect()
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct LyricsTrack {
    pub(crate) kind: TrackType,
    pub(crate) language: Option<String>,
    pub(crate) lines: Vec<LyricsLine>,
}

impl LyricsTrack {
    pub(crate) fn new(kind: TrackType, lines: Vec<LyricsLine>) -> Self {
        Self {
            kind,
            language: None,
            lines,
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct LyricsDocument {
    pub(crate) metadata: LyricsMetadata,
    pub(crate) agents: Vec<LyricsAgent>,
    pub(crate) tracks: Vec<LyricsTrack>,
    pub(crate) source_format: Option<LyricFormat>,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ConversionMode {
    #[default]
    None,
    TraditionalToSimplified,
    SimplifiedToTraditional,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum LineTrack {
    Original,
    Translation,
    Romanization,
}

pub(crate) const DEFAULT_LINE_ORDER: [LineTrack; 3] = [
    LineTrack::Original,
    LineTrack::Romanization,
    LineTrack::Translation,
];

#[derive(Clone, Debug, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub(crate) struct LyricsOptions {
    pub(crate) show_translation: bool,
    pub(crate) show_romanization: bool,
    pub(crate) only_translation_if_available: bool,
    pub(crate) line_order: Vec<LineTrack>,
    pub(crate) normalize_whitespace: bool,
    pub(crate) remove_empty_lines: bool,
    pub(crate) remove_tag_line_keywords: Vec<String>,
    pub(crate) offset_ms: i64,
    pub(crate) conversion_mode: ConversionMode,
    pub(crate) force_rewrite: bool,
    pub(crate) source_format: Option<LyricFormat>,
    pub(crate) target_format: Option<LyricFormat>,
}

impl Default for LyricsOptions {
    fn default() -> Self {
        Self {
            show_translation: true,
            show_romanization: true,
            only_translation_if_available: false,
            line_order: DEFAULT_LINE_ORDER.to_vec(),
            normalize_whitespace: false,
            remove_empty_lines: false,
            remove_tag_line_keywords: Vec::new(),
            offset_ms: 0,
            conversion_mode: ConversionMode::None,
            force_rewrite: false,
            source_format: None,
            target_format: None,
        }
    }
}

impl LyricsOptions {
    pub(crate) fn normalized_line_order(&self) -> Vec<LineTrack> {
        let mut order = Vec::new();
        for item in self.line_order.iter().chain(DEFAULT_LINE_ORDER.iter()) {
            if !order.contains(item) {
                order.push(*item);
            }
        }
        order
    }

    pub(crate) fn has_document_transforms(&self) -> bool {
        self.normalize_whitespace
            || self.remove_empty_lines
            || !self.remove_tag_line_keywords.is_empty()
            || self.offset_ms != 0
            || self.conversion_mode != ConversionMode::None
            || self.force_rewrite
            || self.normalized_line_order() != DEFAULT_LINE_ORDER
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LyricsPipelineResult {
    pub(crate) text: String,
    pub(crate) warnings: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) source_format: Option<LyricFormat>,
    pub(crate) target_format: LyricFormat,
}
