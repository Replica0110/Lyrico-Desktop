//! Local diagnostic events. Business history stays in SQLite; diagnostics never do.
use flexi_logger::{
    writers::FileLogWriter,
    Cleanup, Criterion, DeferredNow, FileSpec, Logger, LoggerHandle, Naming, WriteMode,
};
use log::{Level, Record};
use serde_json::{json, Value};
use std::{
    hash::{Hash, Hasher},
    io::Write,
    path::Path,
    sync::{
        atomic::{AtomicU64, Ordering},
        OnceLock,
    },
    time::{Duration, Instant},
};

const MAX_FILE_BYTES: u64 = 5 * 1024 * 1024;
const RETAINED_FILES: usize = 5;
const MAX_TEXT_CHARS: usize = 4096;
static HANDLE: OnceLock<LoggerHandle> = OnceLock::new();
static NEXT_OPERATION: AtomicU64 = AtomicU64::new(1);
static SESSION: OnceLock<String> = OnceLock::new();

fn writer(directory: &Path, max_bytes: u64, retained: usize) -> Result<FileLogWriter, String> {
    FileLogWriter::builder(
        FileSpec::default()
            .directory(directory)
            .basename("")
            .suppress_timestamp(),
    )
    .format(format_record)
    .write_mode(WriteMode::BufferAndFlushWith(
        64 * 1024,
        Duration::from_millis(500),
    ))
    .rotate(
        Criterion::Size(max_bytes),
        Naming::TimestampsCustomFormat {
            current_infix: Some("latest"),
            format: "%Y-%m-%d_%H-%M-%S",
        },
        Cleanup::KeepLogFiles(retained),
    )
    .cleanup_in_background_thread(false)
    .try_build()
    .map_err(|error| error.to_string())
}

pub(crate) fn init(directory: &Path) -> Result<(), String> {
    let level = std::env::var("LYRICO_LOG_LEVEL")
        .unwrap_or_else(|_| "info".into())
        .to_lowercase();
    let level = match level.as_str() {
        "error" | "warn" | "info" | "debug" => level,
        _ => "info".into(),
    };
    let sink = writer(directory, MAX_FILE_BYTES, RETAINED_FILES)?;
    let handle = Logger::try_with_str(format!("off,lyrico={level}"))
        .map_err(|error| error.to_string())?
        .log_to_writer(Box::new(sink))
        .start()
        .map_err(|error| error.to_string())?;
    HANDLE
        .set(handle)
        .map_err(|_| "Logger is already initialized".to_string())?;
    let old_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        // Arbitrary panic payloads may contain plugin content or credentials.
        event(
            Level::Error,
            "app",
            "panic",
            json!({"location": info.location().map(|at| format!("{}:{}", at.file(), at.line()))}),
        );
        flush();
        old_hook(info);
    }));
    event(
        Level::Debug,
        "app",
        "logger.ready",
        json!({"level":level,"maxFileBytes":MAX_FILE_BYTES,"retainedFiles":RETAINED_FILES}),
    );
    Ok(())
}

pub(crate) fn flush() {
    if let Some(handle) = HANDLE.get() {
        handle.flush();
    }
}

fn session() -> &'static str {
    SESSION.get_or_init(|| {
        format!(
            "{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis()
        )
    })
}

fn format_record(
    output: &mut dyn Write,
    now: &mut DeferredNow,
    record: &Record<'_>,
) -> std::io::Result<()> {
    let entry: Value = serde_json::from_str(&record.args().to_string()).unwrap_or_else(|_| json!({"module":"app","event":"message","context":{"message":redact(&record.args().to_string())}}));
    let mut context = entry["context"].clone();
    let event = entry["event"].as_str().unwrap_or("message");
    let message = if event.starts_with("operation.") {
        let operation = context["operation"]
            .as_str()
            .unwrap_or("operation")
            .to_owned();
        if let Some(fields) = context.as_object_mut() {
            fields.remove("operation");
            fields.remove("operationId");
        }
        let action = operation_label(&operation);
        match event {
            "operation.started" => format!("Starting {action}"),
            "operation.completed" => format!("{action} completed"),
            "operation.failed" => format!("{action} failed"),
            "operation.cancelled" => format!("{action} cancelled"),
            _ => format!("{action} interrupted before completion"),
        }
    } else if event == "scan.summary" {
        let message = format!("Scan finished: {} audio files found, {} cached, {} parsed, {} short files skipped, {} failures", context["total"], context["cached"],context["parsed"],context["skippedShort"],context["failed"]);
        if let Some(fields) = context.as_object_mut() {
            for key in ["total", "cached", "parsed", "skippedShort", "failed"] {
                fields.remove(key);
            }
        }
        message
    } else {
        event_label(event).to_owned()
    };
    write!(
        output,
        "{} {:<5} [{}] {}{}",
        now.format("%Y-%m-%d %H:%M:%S%.3f"),
        record.level(),
        entry["module"].as_str().unwrap_or("app"),
        message,
        context_text(&context)
    )
}

fn operation_label(name: &str) -> String {
    let label = match name {
        "startup" => "Application startup",
        "open" => "Database initialization",
        "scan_folder" => "Library scan",
        "save_audio_tags" => "Save audio tags",
        "read_audio_file" => "Read audio metadata",
        "write_copy" => "Audio file transaction",
        "invoke" => "Plugin invocation",
        "artwork.fetch" => "Download artwork",
        "analyze_replay_gain" => "ReplayGain analysis",
        "process_lyrics_text" => "Process lyrics",
        "render_plugin_lyrics" => "Convert plugin lyrics",
        "upsert_library_folder" => "Add library folder",
        "remove_library_folder" => "Remove library folder",
        "run" => "Batch execution",
        _ => return name.replace('_', " "),
    };
    label.to_owned()
}
fn event_label(name: &str) -> &str {
    match name {
        "logger.ready" => "Logging initialized",
        "scan.summary" => "Scan finished",
        "entry.unreadable" => "Cannot enumerate directory entry",
        "audio.unreadable" => "Cannot read audio metadata",
        "parallel.fallback" => "Cannot start parallel scanner; using sequential scan",
        "audio.skipped_short" => "Skipped short audio",
        "recovery.completed" => "Recovered interrupted batch tasks",
        "recovery.failed" => "Cannot recover interrupted batch tasks",
        "recovery.resume_failed" => "Cannot resume batch task",
        "http.failed" => "HTTP request failed",
        "http.response" => "HTTP response received",
        "host.diagnostic" => "Plugin reported a diagnostic",
        "response.summary" => "Plugin returned results",
        "task.finished" => "Batch task finished",
        "task.failed" => "Batch task failed",
        "item.finished" => "Batch item finished",
        "shutdown" => "Application exiting",
        "panic" => "Application panicked",
        "legacy_logs.archived" => "Archived old database logs",
        "legacy_logs.archive_failed" => "Cannot archive old database logs; original table retained",
        "startup.failed" => "Application startup failed",
        "exception" => "Frontend exception",
        "backup.recovery" => "Loaded backup after primary configuration failed",
        "conversion.warning" => "Lyrics conversion completed with warnings",
        "source.fallback" => "Metadata source failed; trying the next source",
        "batch_item.persist_failed" => "Cannot persist batch item result",
        _ => name,
    }
}

fn context_text(value: &Value) -> String {
    fn flatten(prefix: &str, value: &Value, parts: &mut Vec<String>) {
        match value {
            Value::Object(fields) if fields.contains_key("fileName") => {
                flatten(prefix, &fields["fileName"], parts);
            }
            Value::Object(fields) => {
                for (key, value) in fields {
                    flatten(
                        &if prefix.is_empty() {
                            key.clone()
                        } else {
                            format!("{prefix}.{key}")
                        },
                        value,
                        parts,
                    );
                }
            }
            Value::Null => {}
            Value::String(value) => parts.push(format!(
                "{prefix}={}",
                value
                    .replace('\\', "\\\\")
                    .replace('\n', "\\n")
                    .replace('\r', "\\r")
            )),
            _ => parts.push(format!("{prefix}={value}")),
        }
    }
    let mut parts = Vec::new();
    flatten("", value, &mut parts);
    if parts.is_empty() {
        String::new()
    } else {
        format!(" {}", parts.join(" "))
    }
}

pub(crate) fn write_legacy(output: &mut dyn Write, entry: Value) -> std::io::Result<()> {
    let entry = sanitize_legacy(entry);
    writeln!(
        output,
        "{} {} [{}] legacy{}",
        entry["legacyTime"].as_str().unwrap_or("unknown"),
        entry["level"].as_str().unwrap_or("INFO"),
        entry["module"].as_str().unwrap_or("app"),
        context_text(&entry)
    )
}

pub(crate) fn event(level: Level, module: &str, name: &str, context: Value) {
    let entry = json!({"module":module,"event":name,"context":sanitize(context)});
    log::log!(target: "lyrico", level, "{entry}");
    if level == Level::Error {
        flush();
    }
}

pub(crate) fn file_context(path: &str) -> Value {
    let mut hash = std::collections::hash_map::DefaultHasher::new();
    path.replace('\\', "/").to_lowercase().hash(&mut hash);
    json!({"fileName":path.rsplit(['/', '\\']).next().unwrap_or_default(),"pathId":format!("{:016x}",hash.finish())})
}

fn sensitive_key(key: &str) -> bool {
    let key = key.to_ascii_lowercase().replace(['_', '-'], "");
    [
        "password",
        "passwd",
        "token",
        "secret",
        "cookie",
        "authorization",
        "credential",
        "apikey",
    ]
    .iter()
    .any(|word| key.contains(word))
}

fn sanitize(value: Value) -> Value {
    match value {
        Value::Object(fields) => Value::Object(
            fields
                .into_iter()
                .map(|(key, value)| {
                    let value = if sensitive_key(&key)
                        || [
                            "config",
                            "configJson",
                            "settings",
                            "body",
                            "lyrics",
                            "coverDataUrl",
                        ]
                        .contains(&key.as_str())
                    {
                        json!("[omitted]")
                    } else if ["path", "songPath", "folderPath", "directory"]
                        .contains(&key.as_str())
                    {
                        value.as_str().map(file_context).unwrap_or(Value::Null)
                    } else {
                        sanitize(value)
                    };
                    (key, value)
                })
                .collect(),
        ),
        Value::Array(items) => Value::Array(items.into_iter().take(20).map(sanitize).collect()),
        Value::String(text) => json!(redact(&text)),
        other => other,
    }
}

pub(crate) fn redact(text: &str) -> String {
    use regex::Regex;
    static URLS: OnceLock<Regex> = OnceLock::new();
    static CREDENTIALS: OnceLock<Regex> = OnceLock::new();
    static BEARER: OnceLock<Regex> = OnceLock::new();
    let text = URLS
        .get_or_init(|| Regex::new(r#"https?://[^\s<>\"']+"#).unwrap())
        .replace_all(text, |capture: &regex::Captures<'_>| {
            reqwest::Url::parse(&capture[0])
                .map(|url| format!("{}://{}", url.scheme(), url.host_str().unwrap_or("[host]")))
                .unwrap_or_else(|_| "[url]".into())
        });
    let text = CREDENTIALS.get_or_init(|| Regex::new(r#"(?i)(?:[\"']?(?:password|passwd|token|secret|api[_-]?key|authorization|cookie)[\"']?\s*[:=]\s*)(?:\"[^\"]*\"|'[^']*'|[^\s,;}]+)"#).unwrap()).replace_all(&text,"[credential omitted]");
    let text = BEARER
        .get_or_init(|| Regex::new(r"(?i)\bBearer\s+[^\s,;]+").unwrap())
        .replace_all(&text, "Bearer [omitted]");
    // Diagnostic errors can contain full local paths. Keep only a placeholder;
    // the event's fileName/pathId already identifies the affected file.
    static PATHS: OnceLock<Regex> = OnceLock::new();
    let text = PATHS
        .get_or_init(|| Regex::new(r#"(?i)(?:\b[a-z]:[\\/]|\\\\)[^\r\n\"<>]+"#).unwrap())
        .replace_all(&text, "[local path]");
    text.chars().take(MAX_TEXT_CHARS).collect()
}

pub(crate) struct Operation {
    module: &'static str,
    name: &'static str,
    context: Value,
    started: Instant,
    finished: bool,
    success_level: Level,
}
impl Operation {
    pub(crate) fn new(
        module: &'static str,
        name: &'static str,
        mut context: Value,
        success_level: Level,
    ) -> Self {
        context["operationId"] = json!(format!(
            "{}-{}",
            session(),
            NEXT_OPERATION.fetch_add(1, Ordering::Relaxed)
        ));
        context["operation"] = json!(name);
        event(
            if matches!(name, "startup" | "scan_folder" | "analyze_replay_gain") {
                success_level
            } else {
                Level::Debug
            },
            module,
            "operation.started",
            context.clone(),
        );
        Self {
            module,
            name,
            context,
            started: Instant::now(),
            finished: false,
            success_level,
        }
    }
    pub(crate) fn finish<T>(mut self, result: &Result<T, String>) {
        self.finished = true;
        self.context["elapsedMs"] = json!(self.started.elapsed().as_millis());
        let (level, name) = match result {
            Ok(_) => (
                if self.name == "scan_folder" {
                    Level::Debug
                } else {
                    self.success_level
                },
                "operation.completed",
            ),
            Err(error) if error.to_ascii_lowercase().contains("cancelled") => {
                (Level::Info, "operation.cancelled")
            }
            Err(error) => {
                self.context["error"] = json!(error);
                (Level::Error, "operation.failed")
            }
        };
        event(level, self.module, name, self.context.clone());
    }
}
impl Drop for Operation {
    fn drop(&mut self) {
        if !self.finished {
            event(Level::Warn, self.module, "operation.interrupted", {
                let mut context = self.context.clone();
                context["operation"] = json!(self.name);
                context["elapsedMs"] = json!(self.started.elapsed().as_millis());
                context
            });
        }
    }
}


/// Legacy diagnostics can contain serialized task configs. Preserve only the
/// known-safe identifiers and sanitize free text; discard arbitrary detail blobs.
pub(crate) fn sanitize_legacy(mut entry: Value) -> Value {
    entry["detail"] = json!("[legacy detail omitted]");
    sanitize(entry)
}
