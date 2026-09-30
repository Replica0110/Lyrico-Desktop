mod lrc;
mod model;
mod pipeline;
mod processors;
mod ttml;

pub(crate) use model::{LineTrack, LyricFormat, LyricsOptions, LyricsPipelineResult};
pub(crate) use pipeline::{detect_format, extract_plain_text, process_plugin_result, process_text};
