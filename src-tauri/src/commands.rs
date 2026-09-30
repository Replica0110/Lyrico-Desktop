use crate::audio::{
    is_audio_path, read_cover_artwork, read_cover_thumbnail, read_image_data_url, read_track,
    save_tags, write_image_data_url, ArtworkMode,
};
use crate::batch::{generate_rename_previews, CharacterMappingRule, RenamePreview};
use crate::config as app_config;
use crate::config::{DesktopSettings, PluginBackup};
use crate::database::IndexedTrack;
use crate::models::{
    AppLogEntry, ArtistSplitConfig, AudioTrack, BatchTask, BatchTaskItem, CustomTag, LibraryFolder,
    LyricLineMatch, ReplayGainAnalysis, ReplayGainProgress, ScanProgress, StorageInfo, TagUpdate,
    TrackCover,
};
use crate::path_access;
use crate::paths::resolve_data_paths;
use crate::plugins::installer as plugin_installer;
use crate::plugins::manifest::{PluginInstallPreview, PluginInstallResult, SourcePlugin};
use crate::plugins::runtime as plugin_runtime;
use crate::replay_gain::analyze_track;
use crate::taglib_bridge;
use crate::AppState;
use rayon::prelude::*;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};
use walkdir::WalkDir;

const SCAN_PROGRESS_EVENT: &str = "library-scan-progress";
const REPLAY_GAIN_PROGRESS_EVENT: &str = "replay-gain-progress";
static NEXT_SCAN_ID: AtomicU64 = AtomicU64::new(1);

#[tauri::command]
pub(crate) async fn load_source_plugins(
    app: AppHandle,
    state: State<'_, AppState>,
    locale: Option<String>,
) -> Result<Vec<SourcePlugin>, String> {
    let paths = resolve_data_paths(&app)?;
    plugin_installer::load_plugins(&state.database, &paths.plugins, locale.as_deref()).await
}

#[tauri::command]
pub(crate) async fn install_source_plugin_archive(
    app: AppHandle,
    state: State<'_, AppState>,
    archive_path: String,
    allow_downgrade: bool,
    selected_roots: Option<Vec<String>>,
    locale: Option<String>,
) -> Result<PluginInstallResult, String> {
    path_access::ensure_allowed(&app, &state, Path::new(&archive_path)).await?;
    let paths = resolve_data_paths(&app)?;
    plugin_installer::install_archive(
        &state.database,
        &paths.plugins,
        Path::new(&archive_path),
        allow_downgrade,
        selected_roots,
        locale.as_deref(),
    )
    .await
}

#[tauri::command]
pub(crate) async fn preview_source_plugin_archive(
    app: AppHandle,
    state: State<'_, AppState>,
    archive_path: String,
) -> Result<PluginInstallPreview, String> {
    let paths = resolve_data_paths(&app)?;
    plugin_installer::preview_archive(&state.database, &paths.plugins, Path::new(&archive_path))
        .await
}

#[tauri::command]
pub(crate) async fn set_plugin_source_enabled(
    app: AppHandle,
    state: State<'_, AppState>,
    plugin_id: String,
    source_kind: String,
    enabled: bool,
    locale: Option<String>,
) -> Result<Vec<SourcePlugin>, String> {
    let paths = resolve_data_paths(&app)?;
    plugin_installer::set_source_enabled(
        &state.database,
        &paths.plugins,
        &plugin_id,
        &source_kind,
        enabled,
        locale.as_deref(),
    )
    .await
}

#[tauri::command]
pub(crate) async fn reorder_plugin_sources(
    app: AppHandle,
    state: State<'_, AppState>,
    source_kind: String,
    plugin_ids: Vec<String>,
    locale: Option<String>,
) -> Result<Vec<SourcePlugin>, String> {
    let paths = resolve_data_paths(&app)?;
    plugin_installer::reorder_sources(
        &state.database,
        &paths.plugins,
        &source_kind,
        plugin_ids,
        locale.as_deref(),
    )
    .await
}

#[tauri::command]
pub(crate) async fn set_source_plugin_enabled(
    app: AppHandle,
    state: State<'_, AppState>,
    plugin_id: String,
    enabled: bool,
    locale: Option<String>,
) -> Result<Vec<SourcePlugin>, String> {
    let paths = resolve_data_paths(&app)?;
    plugin_installer::set_enabled(&state.database, &paths.plugins, &plugin_id, enabled, locale.as_deref()).await
}

#[tauri::command]
pub(crate) async fn set_source_plugin_order(
    app: AppHandle,
    state: State<'_, AppState>,
    plugin_ids: Vec<String>,
    locale: Option<String>,
) -> Result<Vec<SourcePlugin>, String> {
    state.database.set_plugin_order(&plugin_ids).await?;
    let paths = resolve_data_paths(&app)?;
    plugin_installer::load_plugins(&state.database, &paths.plugins, locale.as_deref()).await
}

#[tauri::command]
pub(crate) async fn save_source_plugin_settings(
    app: AppHandle,
    state: State<'_, AppState>,
    plugin_id: String,
    config: serde_json::Value,
    locale: Option<String>,
) -> Result<Vec<SourcePlugin>, String> {
    let paths = resolve_data_paths(&app)?;
    plugin_installer::save_settings(&state.database, &paths.plugins, &plugin_id, config, locale.as_deref()).await
}

#[tauri::command]
pub(crate) async fn uninstall_source_plugin(
    app: AppHandle,
    state: State<'_, AppState>,
    plugin_id: String,
    locale: Option<String>,
) -> Result<Vec<SourcePlugin>, String> {
    let paths = resolve_data_paths(&app)?;
    plugin_installer::uninstall(&state.database, &paths.plugins, &plugin_id, locale.as_deref()).await
}

#[tauri::command]
pub(crate) async fn invoke_source_plugin(
    app: AppHandle,
    state: State<'_, AppState>,
    plugin_id: String,
    function_name: String,
    request: serde_json::Value,
    locale: Option<String>,
) -> Result<serde_json::Value, String> {
    let paths = resolve_data_paths(&app)?;
    let plugin = plugin_installer::load_plugins(&state.database, &paths.plugins, locale.as_deref())
        .await?
        .into_iter()
        .find(|plugin| plugin.manifest.id == plugin_id)
        .ok_or_else(|| "Plugin was not found".to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        plugin_runtime::invoke(&plugin, &function_name, request, locale.as_deref())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub(crate) async fn fetch_remote_image(
    url: String,
    max_size: Option<u32>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || fetch_remote_image_blocking(&url, max_size))
        .await
        .map_err(|error| error.to_string())?
}

const REMOTE_IMAGE_MAX_REDIRECTS: usize = 5;

fn fetch_remote_image_blocking(url: &str, max_size: Option<u32>) -> Result<String, String> {
    let mut current = reqwest::Url::parse(url).map_err(|error| error.to_string())?;
    for _ in 0..=REMOTE_IMAGE_MAX_REDIRECTS {
        if !matches!(current.scheme(), "http" | "https") {
            return Err("Only HTTP and HTTPS image URLs are supported".to_string());
        }
        let pinned = ensure_public_image_url(&current)?;
        let client = build_pinned_image_client(current.host_str(), pinned)?;
        let response = client
            .get(current.clone())
            .send()
            .map_err(|error| error.to_string())?;
        if !response.status().is_redirection() {
            let response = response.error_for_status().map_err(|error| error.to_string())?;
            return encode_image_response(response, max_size);
        }
        let location = response
            .headers()
            .get(reqwest::header::LOCATION)
            .and_then(|value| value.to_str().ok())
            .ok_or_else(|| "Image URL redirected without a Location header".to_string())?;
        current = current
            .join(location)
            .map_err(|error| format!("Image URL redirected to an invalid location: {error}"))?;
    }
    Err("Too many redirects while fetching the image".to_string())
}

fn build_pinned_image_client(
    host: Option<&str>,
    pinned: Option<std::net::SocketAddr>,
) -> Result<reqwest::blocking::Client, String> {
    let mut builder = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::none());
    if let (Some(domain), Some(address)) = (host, pinned) {
        let bare = domain
            .strip_prefix('[')
            .and_then(|rest| rest.strip_suffix(']'))
            .unwrap_or(domain);
        builder = builder.resolve(bare, address);
    }
    builder.build().map_err(|error| error.to_string())
}

fn encode_image_response(
    response: reqwest::blocking::Response,
    max_size: Option<u32>,
) -> Result<String, String> {
    let mime = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .unwrap_or("application/octet-stream")
        .to_string();
    if !mime.starts_with("image/") {
        return Err(format!("Remote resource is not an image: {mime}"));
    }
    if response
        .content_length()
        .is_some_and(|length| length > 20 * 1024 * 1024)
    {
        return Err("Remote image is larger than 20 MB".to_string());
    }
    let bytes = response.bytes().map_err(|error| error.to_string())?;
    if bytes.len() > 20 * 1024 * 1024 {
        return Err("Remote image is larger than 20 MB".to_string());
    }
    use base64::Engine;
    if let Some(max_size) = max_size {
        let max_size = max_size.clamp(64, 4096);
        let image = image::load_from_memory(&bytes).map_err(|error| error.to_string())?;
        let resized = image.thumbnail(max_size, max_size);
        let mut output = std::io::Cursor::new(Vec::new());
        resized
            .write_to(&mut output, image::ImageFormat::Png)
            .map_err(|error| error.to_string())?;
        return Ok(format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(output.into_inner())
        ));
    }
    Ok(format!(
        "data:{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}

fn ensure_public_image_url(url: &reqwest::Url) -> Result<Option<std::net::SocketAddr>, String> {
    use std::net::ToSocketAddrs;
    let host = url
        .host_str()
        .ok_or_else(|| "Image URL has no host".to_string())?;
    let bare = host
        .strip_prefix('[')
        .and_then(|rest| rest.strip_suffix(']'))
        .unwrap_or(host);
    if let Ok(address) = bare.parse::<std::net::IpAddr>() {
        ensure_public_image_ip(address)?;
        return Ok(None);
    }
    let port = url.port_or_known_default().unwrap_or(443);
    let mut pinned: Option<std::net::SocketAddr> = None;
    for address in (bare, port)
        .to_socket_addrs()
        .map_err(|error| format!("Failed to resolve image host {host}: {error}"))?
    {
        ensure_public_image_ip(address.ip())?;
        if pinned.is_none() {
            pinned = Some(address);
        }
    }
    match pinned {
        Some(address) => Ok(Some(address)),
        None => Err(format!("Image host {host} did not resolve to any address")),
    }
}

fn ensure_public_image_ip(address: std::net::IpAddr) -> Result<(), String> {
    let is_public = match address {
        std::net::IpAddr::V4(ip) => is_public_image_ipv4(ip),
        std::net::IpAddr::V6(ip) => is_public_image_ipv6(ip),
    };
    if is_public {
        Ok(())
    } else {
        Err(format!(
            "Refusing to fetch an image from a non-public address: {address}"
        ))
    }
}

fn is_public_image_ipv4(ip: std::net::Ipv4Addr) -> bool {
    let octets = ip.octets();
    !(ip.is_loopback()
        || ip.is_private()
        || ip.is_link_local()
        || ip.is_unspecified()
        || ip.is_broadcast()
        || ip.is_documentation()
        || octets[0] == 0
        || (octets[0] == 100 && (octets[1] & 0xc0) == 64)
        || (octets[0] == 192 && octets[1] == 0 && octets[2] == 0)
        || (octets[0] == 198 && (octets[1] == 18 || octets[1] == 19))
        || octets[0] >= 224)
}

fn is_public_image_ipv6(ip: std::net::Ipv6Addr) -> bool {
    if let Some(mapped) = ip.to_ipv4_mapped() {
        return is_public_image_ipv4(mapped);
    }
    let segments = ip.segments();
    !(ip.is_loopback()
        || ip.is_unspecified()
        || ip.is_multicast()
        || segments[0] == 0
        || (segments[0] & 0xfe00) == 0xfc00
        || (segments[0] & 0xffc0) == 0xfe80
        || (segments[0] == 0x2001 && segments[1] == 0xdb8)
        || (segments[0] == 0x0064 && segments[1] == 0xff9b))
}

#[tauri::command]
pub(crate) async fn create_batch_task(
    app: AppHandle,
    state: State<'_, AppState>,
    task_type: String,
    song_paths: Vec<String>,
    config_json: Option<String>,
) -> Result<BatchTask, String> {
    path_access::ensure_all_allowed(&app, &state, &song_paths).await?;
    if let Some(destination) = batch_export_destination(&config_json) {
        path_access::ensure_allowed(&app, &state, Path::new(&destination)).await?;
    }
    state
        .database
        .create_batch_task(&task_type, &song_paths, config_json)
        .await
}

fn batch_export_destination(config_json: &Option<String>) -> Option<String> {
    let raw = config_json.as_ref()?;
    let config: serde_json::Value = serde_json::from_str(raw).ok()?;
    let destination = config.get("destinationDirectory")?.as_str()?;
    let destination = destination.trim();
    if destination.is_empty() {
        None
    } else {
        Some(destination.to_string())
    }
}

#[tauri::command]
pub(crate) async fn load_batch_tasks(state: State<'_, AppState>) -> Result<Vec<BatchTask>, String> {
    state.database.load_batch_tasks().await
}

#[tauri::command]
pub(crate) async fn delete_batch_tasks(
    state: State<'_, AppState>,
    task_ids: Vec<String>,
) -> Result<(), String> {
    state.database.delete_batch_tasks(&task_ids).await
}

#[tauri::command]
pub(crate) async fn load_batch_task_items(
    state: State<'_, AppState>,
    task_id: String,
) -> Result<Vec<BatchTaskItem>, String> {
    state.database.load_batch_task_items(&task_id).await
}

#[tauri::command]
pub(crate) async fn preview_batch_rename(
    app: AppHandle,
    paths: Vec<String>,
    rename_format: String,
    character_mapping_rules: Vec<CharacterMappingRule>,
) -> Result<Vec<RenamePreview>, String> {
    let artist_separator = app_config::load_artist_split_config(&app)?.artist_separator;
    tauri::async_runtime::spawn_blocking(move || {
        generate_rename_previews(
            &paths,
            &rename_format,
            &character_mapping_rules,
            &artist_separator,
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub(crate) async fn start_batch_task(
    app: AppHandle,
    state: State<'_, AppState>,
    task_id: String,
) -> Result<BatchTask, String> {
    state.batch_manager.start_task(app, task_id).await
}

#[tauri::command]
pub(crate) async fn cancel_batch_task(
    app: AppHandle,
    state: State<'_, AppState>,
    task_id: String,
) -> Result<BatchTask, String> {
    state.batch_manager.cancel_task(&app, &task_id).await
}

#[tauri::command]
pub(crate) async fn cancel_batch_task_item(
    state: State<'_, AppState>,
    task_id: String,
    item_id: String,
) -> Result<BatchTask, String> {
    state.batch_manager.cancel_item(&task_id, &item_id).await
}

#[tauri::command]
pub(crate) async fn retry_failed_batch_items(
    app: AppHandle,
    state: State<'_, AppState>,
    task_id: String,
    item_ids: Option<Vec<String>>,
) -> Result<BatchTask, String> {
    let source_task = state.database.load_batch_task(&task_id).await?;
    let requested = item_ids.map(|ids| ids.into_iter().collect::<std::collections::HashSet<_>>());
    let paths = state
        .database
        .load_batch_task_items(&task_id)
        .await?
        .into_iter()
        .filter(|item| item.status == "failed")
        .filter(|item| {
            requested
                .as_ref()
                .is_none_or(|ids| ids.contains(&item.item_id))
        })
        .map(|item| item.song_path)
        .collect::<Vec<_>>();
    if paths.is_empty() {
        return Err("No failed batch items are available to retry".to_string());
    }
    let task = state
        .database
        .create_batch_task(&source_task.task_type, &paths, source_task.config_json)
        .await?;
    state.batch_manager.start_task(app, task.task_id).await
}

#[tauri::command]
pub(crate) async fn analyze_replay_gain(
    app: AppHandle,
    state: State<'_, AppState>,
    job_id: String,
    path: String,
    target_loudness_lufs: f64,
) -> Result<ReplayGainAnalysis, String> {
    if job_id.trim().is_empty() {
        return Err("ReplayGain job id is required".to_string());
    }
    path_access::ensure_allowed(&app, &state, Path::new(&path)).await?;
    let target_loudness = target_loudness_lufs;
    let cancelled = Arc::new(AtomicBool::new(false));
    {
        let mut active = state
            .active_replay_gain
            .lock()
            .map_err(|_| "ReplayGain registry lock was poisoned".to_string())?;
        if active.contains_key(&job_id) {
            return Err("ReplayGain job id is already active".to_string());
        }
        active.insert(job_id.clone(), cancelled.clone());
    }

    emit_replay_gain_progress(&app, &job_id, &path, 0, "running", None);
    let worker_app = app.clone();
    let worker_job_id = job_id.clone();
    let worker_path = path.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        analyze_track(
            worker_job_id.clone(),
            Path::new(&worker_path),
            target_loudness,
            &cancelled,
            |progress| {
                emit_replay_gain_progress(
                    &worker_app,
                    &worker_job_id,
                    &worker_path,
                    (progress.clamp(0.0, 1.0) * 100.0).round() as u8,
                    "running",
                    None,
                );
            },
        )
    })
    .await
    .map_err(|error| error.to_string())?;

    state
        .active_replay_gain
        .lock()
        .map_err(|_| "ReplayGain registry lock was poisoned".to_string())?
        .remove(&job_id);
    match &result {
        Ok(_) => emit_replay_gain_progress(&app, &job_id, &path, 100, "completed", None),
        Err(error) if error.contains("cancelled") => {
            emit_replay_gain_progress(&app, &job_id, &path, 0, "cancelled", Some(error.clone()))
        }
        Err(error) => {
            emit_replay_gain_progress(&app, &job_id, &path, 0, "failed", Some(error.clone()))
        }
    }
    result
}

#[tauri::command]
pub(crate) fn cancel_replay_gain(
    state: State<'_, AppState>,
    job_id: String,
) -> Result<bool, String> {
    let active = state
        .active_replay_gain
        .lock()
        .map_err(|_| "ReplayGain registry lock was poisoned".to_string())?;
    if let Some(cancelled) = active.get(&job_id) {
        cancelled.store(true, Ordering::Relaxed);
        Ok(true)
    } else {
        Ok(false)
    }
}

fn emit_replay_gain_progress(
    app: &AppHandle,
    job_id: &str,
    path: &str,
    percent: u8,
    status: &str,
    message: Option<String>,
) {
    let _ = app.emit(
        REPLAY_GAIN_PROGRESS_EVENT,
        ReplayGainProgress {
            job_id: job_id.to_string(),
            path: path.to_string(),
            percent,
            status: status.to_string(),
            message,
        },
    );
}

struct ScanResult {
    tracks: Vec<AudioTrack>,
    errors: usize,
}

#[tauri::command]
pub(crate) async fn scan_folder(
    app: AppHandle,
    state: State<'_, AppState>,
    folder_path: String,
) -> Result<Vec<AudioTrack>, String> {
    path_access::ensure_allowed(&app, &state, Path::new(&folder_path)).await?;
    let root = PathBuf::from(&folder_path);
    if !root.is_dir() {
        return Err("Selected path is not a folder".to_string());
    }
    let artist_separator = app_config::load_artist_split_config(&app)?.artist_separator;
    let ignore_short_audio = app_config::load_desktop_settings(&app)?.ignore_short_audio;
    let scan_key = normalize_path(&folder_path);
    {
        let mut active_scans = state
            .active_scans
            .lock()
            .map_err(|_| "Scan registry lock was poisoned".to_string())?;
        if !active_scans.insert(scan_key.clone()) {
            return Err("This folder is already being scanned".to_string());
        }
    }
    let job_id = format!("scan-{}", NEXT_SCAN_ID.fetch_add(1, Ordering::Relaxed));
    let scan_signature = format!("audio-summary-v1|artist-separator={artist_separator}");
    let existing_index = match state
        .database
        .load_folder_index(&folder_path, &scan_signature)
        .await
    {
        Ok(index) => index,
        Err(error) => {
            if let Ok(mut active_scans) = state.active_scans.lock() {
                active_scans.remove(&scan_key);
            }
            return Err(error);
        }
    };
    let result: Result<Vec<AudioTrack>, String> = async {
        emit_scan_progress(
            &app,
            &job_id,
            &folder_path,
            "enumerating",
            0,
            0,
            0,
            "running",
            None,
        );
        let scan_app = app.clone();
        let scan_job_id = job_id.clone();
        let scan_folder_path = folder_path.clone();
        let scan = tauri::async_runtime::spawn_blocking(move || {
            scan_tracks(
                root,
                &artist_separator,
                &scan_app,
                &scan_job_id,
                &scan_folder_path,
                &existing_index,
                ignore_short_audio,
            )
        })
        .await
        .map_err(|error| error.to_string())?;
        emit_scan_progress(
            &app,
            &job_id,
            &folder_path,
            "committing",
            scan.tracks.len(),
            scan.tracks.len(),
            scan.errors,
            "running",
            None,
        );
        state
            .database
            .persist_folder_scan(&folder_path, &scan_signature, &scan.tracks)
            .await?;
        let mut tracks = scan.tracks;
        let stored_paths = tracks
            .iter()
            .map(|track| track.path.clone())
            .collect::<Vec<_>>();
        let stored_times = state
            .database
            .load_track_times_by_paths(&stored_paths)
            .await?;
        for track in &mut tracks {
            if let Some((added_at, modified_at)) = stored_times.get(&track.path) {
                track.added_at = *added_at;
                track.modified_at = modified_at.or(track.modified_at);
            }
        }
        emit_scan_progress(
            &app,
            &job_id,
            &folder_path,
            "completed",
            tracks.len(),
            tracks.len(),
            scan.errors,
            "completed",
            None,
        );
        Ok(tracks)
    }
    .await;
    if let Err(error) = &result {
        emit_scan_progress(
            &app,
            &job_id,
            &folder_path,
            "failed",
            0,
            0,
            1,
            "failed",
            Some(error.clone()),
        );
    }
    if let Ok(mut active_scans) = state.active_scans.lock() {
        active_scans.remove(&scan_key);
    }
    result
}

#[tauri::command]
pub(crate) async fn read_audio_file(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> Result<AudioTrack, String> {
    path_access::ensure_allowed(&app, &state, Path::new(&path)).await?;
    let artist_separator = app_config::load_artist_split_config(&app)?.artist_separator;
    let mut track = tauri::async_runtime::spawn_blocking(move || {
        read_track(Path::new(&path), &artist_separator, ArtworkMode::Full)
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())??;
    let (_, added_at) = state.database.load_track_timestamps(&track.path).await?;
    track.added_at = added_at;
    Ok(track)
}

#[tauri::command]
pub(crate) async fn read_image_file(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> Result<String, String> {
    path_access::ensure_allowed(&app, &state, Path::new(&path)).await?;
    tauri::async_runtime::spawn_blocking(move || read_image_data_url(Path::new(&path)))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub(crate) async fn read_text_file(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> Result<String, String> {
    path_access::ensure_allowed(&app, &state, Path::new(&path)).await?;
    tauri::async_runtime::spawn_blocking(move || {
        let metadata = std::fs::metadata(&path).map_err(|error| error.to_string())?;
        if metadata.len() > 5 * 1024 * 1024 {
            return Err("Lyrics file must be smaller than 5 MB".to_string());
        }
        std::fs::read_to_string(path).map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub(crate) async fn write_text_file(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
    contents: String,
) -> Result<(), String> {
    path_access::ensure_allowed(&app, &state, Path::new(&path)).await?;
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(parent) = Path::new(&path).parent() {
            std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        std::fs::write(path, contents).map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub(crate) async fn write_image_file(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
    data_url: String,
) -> Result<(), String> {
    path_access::ensure_allowed(&app, &state, Path::new(&path)).await?;
    tauri::async_runtime::spawn_blocking(move || write_image_data_url(Path::new(&path), &data_url))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub(crate) async fn save_audio_tags(
    app: AppHandle,
    state: State<'_, AppState>,
    update: TagUpdate,
) -> Result<AudioTrack, String> {
    path_access::ensure_allowed(&app, &state, Path::new(&update.path)).await?;
    let artist_separator = app_config::load_artist_split_config(&app)?.artist_separator;
    let mut saved = tauri::async_runtime::spawn_blocking(move || save_tags(update, &artist_separator))
        .await
        .map_err(|error| error.to_string())??;
    state.database.update_track_summary(&saved).await?;
    let (_, added_at) = state.database.load_track_timestamps(&saved.path).await?;
    saved.added_at = added_at;
    Ok(saved)
}

#[tauri::command]
pub(crate) async fn load_library_folders(
    state: State<'_, AppState>,
) -> Result<Vec<LibraryFolder>, String> {
    state.database.load_folders().await
}

#[tauri::command]
pub(crate) async fn load_library_tracks(
    state: State<'_, AppState>,
) -> Result<Vec<AudioTrack>, String> {
    let database = state.database.clone();
    tauri::async_runtime::spawn_blocking(move || database.load_tracks_blocking())
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub(crate) async fn load_library_tracks_by_paths(
    state: State<'_, AppState>,
    paths: Vec<String>,
) -> Result<Vec<AudioTrack>, String> {
    state.database.load_tracks_by_paths(&paths).await
}

#[tauri::command]
pub(crate) async fn load_library_track(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> Result<AudioTrack, String> {
    read_audio_file(app, state, path).await
}

#[tauri::command]
pub(crate) async fn load_track_covers(
    state: State<'_, AppState>,
    paths: Vec<String>,
    artwork: bool,
) -> Result<Vec<TrackCover>, String> {
    let cached = state.database.load_cover_previews(&paths, artwork)?;
    let missing = paths
        .iter()
        .filter(|path| !cached.contains_key(*path))
        .cloned()
        .collect::<Vec<_>>();
    let fresh = tauri::async_runtime::spawn_blocking(move || {
        missing
            .into_iter()
            .filter_map(|path| {
                let cover_data_url = if artwork {
                    read_cover_artwork(Path::new(&path))
                } else {
                    read_cover_thumbnail(Path::new(&path))
                };
                cover_data_url.map(|cover_data_url| TrackCover {
                    path,
                    cover_data_url,
                })
            })
            .collect::<Vec<_>>()
    })
    .await
    .map_err(|error| error.to_string())?;
    if !fresh.is_empty() {
        let thumbnails = fresh
            .iter()
            .map(|cover| (cover.path.clone(), cover.cover_data_url.clone()))
            .collect::<Vec<_>>();
        state.database.save_cover_previews(&thumbnails, artwork)?;
    }
    let mut result = paths
        .into_iter()
        .filter_map(|path| {
            cached.get(&path).cloned().map(|cover_data_url| TrackCover {
                path,
                cover_data_url,
            })
        })
        .collect::<Vec<_>>();
    result.extend(fresh);
    Ok(result)
}

#[tauri::command]
pub(crate) fn load_artist_split_config(app: AppHandle) -> Result<ArtistSplitConfig, String> {
    app_config::load_artist_split_config(&app)
}

#[tauri::command]
pub(crate) fn save_artist_split_config(
    app: AppHandle,
    config: ArtistSplitConfig,
) -> Result<(), String> {
    app_config::save_artist_split_config(&app, config)
}

#[tauri::command]
pub(crate) fn load_desktop_settings(app: AppHandle) -> Result<DesktopSettings, String> {
    app_config::load_desktop_settings(&app)
}

#[tauri::command]
pub(crate) fn save_desktop_settings(
    app: AppHandle,
    settings: DesktopSettings,
) -> Result<(), String> {
    app_config::save_desktop_settings(&app, settings)
}

#[tauri::command]
pub(crate) async fn export_config(
    app: AppHandle,
    state: State<'_, AppState>,
    destination: String,
) -> Result<(), String> {
    path_access::ensure_allowed(&app, &state, Path::new(&destination)).await?;
    let destination = PathBuf::from(&destination);
    if let Some(parent) = destination.parent() {
        if !parent.as_os_str().is_empty() && !parent.exists() {
            std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
    }
    let plugins = state
        .database
        .load_plugin_records()
        .await?
        .into_iter()
        .map(|record| PluginBackup {
            id: record.id,
            enabled: record.enabled,
            sort_order: record.sort_order,
            settings_json: record.settings_json,
        })
        .collect();
    app_config::export_config(&app, &destination, plugins)
}

#[tauri::command]
pub(crate) async fn load_custom_tags(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> Result<Vec<CustomTag>, String> {
    path_access::ensure_allowed(&app, &state, Path::new(&path)).await?;
    tauri::async_runtime::spawn_blocking(move || taglib_bridge::read_custom_tags(Path::new(&path)))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub(crate) async fn save_custom_tags(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
    tags: Vec<CustomTag>,
) -> Result<(), String> {
    path_access::ensure_allowed(&app, &state, Path::new(&path)).await?;
    tauri::async_runtime::spawn_blocking(move || {
        taglib_bridge::write_custom_tags(Path::new(&path), &tags)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub(crate) async fn import_config(
    app: AppHandle,
    state: State<'_, AppState>,
    source: String,
) -> Result<DesktopSettings, String> {
    path_access::ensure_allowed(&app, &state, Path::new(&source)).await?;
    let (settings, plugins) = app_config::import_config(&app, Path::new(&source))?;
    let existing = state.database.load_plugin_records().await?;
    let existing_ids = existing
        .iter()
        .map(|record| record.id.clone())
        .collect::<HashSet<_>>();
    for plugin in &plugins {
        if existing_ids.contains(&plugin.id) {
            state
                .database
                .set_plugin_enabled(&plugin.id, plugin.enabled)
                .await?;
            state
                .database
                .save_plugin_settings(&plugin.id, &plugin.settings_json)
                .await?;
        }
    }
    let mut ordered_ids = plugins
        .iter()
        .filter(|plugin| existing_ids.contains(&plugin.id))
        .collect::<Vec<_>>();
    ordered_ids.sort_by_key(|plugin| plugin.sort_order);
    let mut order = ordered_ids
        .into_iter()
        .map(|plugin| plugin.id.clone())
        .collect::<Vec<_>>();
    let imported_ids = order.iter().cloned().collect::<HashSet<_>>();
    order.extend(
        existing
            .iter()
            .filter(|record| !imported_ids.contains(&record.id))
            .map(|record| record.id.clone()),
    );
    if !order.is_empty() {
        state.database.set_plugin_order(&order).await?;
    }
    Ok(settings)
}

#[tauri::command]
pub(crate) async fn search_lyrics_lines(
    state: State<'_, AppState>,
    query: String,
    limit: Option<u32>,
) -> Result<Vec<LyricLineMatch>, String> {
    state
        .database
        .search_lyrics_lines(&query, limit.unwrap_or(50))
        .await
}

#[tauri::command]
pub(crate) async fn load_app_logs(
    state: State<'_, AppState>,
    level: Option<String>,
    limit: Option<u32>,
) -> Result<Vec<AppLogEntry>, String> {
    state
        .database
        .load_app_logs(level, limit.unwrap_or(200))
        .await
}

#[tauri::command]
pub(crate) async fn upsert_library_folder(
    app: AppHandle,
    state: State<'_, AppState>,
    folder: LibraryFolder,
) -> Result<(), String> {
    path_access::ensure_allowed(&app, &state, Path::new(&folder.path)).await?;
    state.database.upsert_folder(folder).await
}

#[tauri::command]
pub(crate) async fn remove_library_folder(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> Result<(), String> {
    path_access::ensure_allowed(&app, &state, Path::new(&path)).await?;
    state.database.remove_folder(&path).await
}

#[tauri::command]
pub(crate) fn get_storage_info(app: AppHandle) -> Result<StorageInfo, String> {
    let paths = resolve_data_paths(&app)?;
    Ok(StorageInfo {
        data_path: paths.root.to_string_lossy().to_string(),
        database_path: paths.database.to_string_lossy().to_string(),
        config_path: paths.settings.to_string_lossy().to_string(),
        location: paths.location,
    })
}

fn scan_tracks(
    root: PathBuf,
    artist_separator: &str,
    app: &AppHandle,
    job_id: &str,
    folder_path: &str,
    existing_index: &HashMap<String, IndexedTrack>,
    ignore_short_audio: bool,
) -> ScanResult {
    let mut enumeration_errors = 0;
    let paths = WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_map(|entry| match entry {
            Ok(entry) => Some(entry),
            Err(_) => {
                enumeration_errors += 1;
                None
            }
        })
        .map(|entry| entry.into_path())
        .filter(|path| path.is_file() && is_audio_path(path))
        .collect::<Vec<_>>();
    let total = paths.len();
    emit_scan_progress(
        app,
        job_id,
        folder_path,
        "reading",
        0,
        total,
        enumeration_errors,
        "running",
        None,
    );
    let processed = AtomicUsize::new(0);
    let errors = AtomicUsize::new(enumeration_errors);
    let thread_count = std::thread::available_parallelism()
        .map_or(2, usize::from)
        .clamp(1, 4);
    let pool = rayon::ThreadPoolBuilder::new()
        .num_threads(thread_count)
        .thread_name(|index| format!("Lyrico-Scanner-{index}"))
        .build();
    let mut tracks = pool
        .map(|pool| {
            pool.install(|| {
                paths
                    .par_iter()
                    .filter_map(|path| {
                        let track = unchanged_track(path, existing_index).or_else(|| {
                            read_track(path, artist_separator, ArtworkMode::None)
                                .ok()
                                .map(AudioTrack::into_summary)
                        }).filter(|track| !should_skip_short_audio(track.duration_seconds, ignore_short_audio));
                        if track.is_none() {
                            errors.fetch_add(1, Ordering::Relaxed);
                        }
                        let current = processed.fetch_add(1, Ordering::Relaxed) + 1;
                        if current == total || current % 8 == 0 {
                            emit_scan_progress(
                                app,
                                job_id,
                                folder_path,
                                "reading",
                                current,
                                total,
                                errors.load(Ordering::Relaxed),
                                "running",
                                None,
                            );
                        }
                        track
                    })
                    .collect::<Vec<_>>()
            })
        })
        .unwrap_or_else(|_| {
            paths
                .iter()
                .filter_map(|path| {
                    unchanged_track(path, existing_index).or_else(|| {
                        read_track(path, artist_separator, ArtworkMode::None)
                            .ok()
                            .map(AudioTrack::into_summary)
                    }).filter(|track| !should_skip_short_audio(track.duration_seconds, ignore_short_audio))
                })
                .collect()
        });
    tracks.sort_by(|left, right| {
        left.album
            .cmp(&right.album)
            .then(left.disc_number.cmp(&right.disc_number))
            .then(left.track_number.cmp(&right.track_number))
            .then(left.title.cmp(&right.title))
    });
    ScanResult {
        tracks,
        errors: errors.load(Ordering::Relaxed),
    }
}

fn unchanged_track(
    path: &Path,
    existing_index: &HashMap<String, IndexedTrack>,
) -> Option<AudioTrack> {
    let path_text = path.to_string_lossy();
    let indexed = existing_index.get(path_text.as_ref())?;
    let metadata = path.metadata().ok()?;
    let modified_at = metadata
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_secs();
    (indexed.file_size == metadata.len() && indexed.modified_at == modified_at)
        .then(|| indexed.track.clone())
}

#[allow(clippy::too_many_arguments)]
fn emit_scan_progress(
    app: &AppHandle,
    job_id: &str,
    folder_path: &str,
    phase: &str,
    current: usize,
    total: usize,
    errors: usize,
    status: &str,
    message: Option<String>,
) {
    let _ = app.emit(
        SCAN_PROGRESS_EVENT,
        ScanProgress {
            job_id: job_id.to_string(),
            folder_path: folder_path.to_string(),
            phase: phase.to_string(),
            current,
            total,
            errors,
            status: status.to_string(),
            message,
        },
    );
}

fn normalize_path(path: &str) -> String {
    path.replace('\\', "/").to_lowercase()
}

fn should_skip_short_audio(duration_seconds: u64, enabled: bool) -> bool {
    enabled && duration_seconds <= 60
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_audio_filter_skips_audio_at_or_below_sixty_seconds() {
        assert!(should_skip_short_audio(60, true));
        assert!(should_skip_short_audio(1, true));
        assert!(!should_skip_short_audio(61, true));
        assert!(!should_skip_short_audio(1, false));
    }

    #[test]
    fn image_ip_filter_blocks_private_and_reserved_ipv4_ranges() {
        for address in [
            "0.0.0.0",
            "10.0.0.1",
            "100.64.0.1",
            "127.0.0.1",
            "169.254.169.254",
            "172.16.0.1",
            "172.31.255.254",
            "192.0.0.1",
            "192.0.2.1",
            "192.168.1.1",
            "198.18.0.1",
            "198.51.100.1",
            "203.0.113.1",
            "224.0.0.1",
            "255.255.255.255",
        ] {
            let ip: std::net::Ipv4Addr = address.parse().expect("valid test address");
            assert!(!is_public_image_ipv4(ip), "{address} must be blocked");
        }
        for address in ["1.1.1.1", "8.8.8.8", "93.184.216.34", "172.32.0.1"] {
            let ip: std::net::Ipv4Addr = address.parse().expect("valid test address");
            assert!(is_public_image_ipv4(ip), "{address} must be allowed");
        }
    }

    #[test]
    fn image_ip_filter_blocks_private_and_reserved_ipv6_ranges() {
        for address in [
            "::",
            "::1",
            "::ffff:192.168.1.1",
            "fc00::1",
            "fd12:3456::1",
            "fe80::1",
            "ff02::1",
            "2001:db8::1",
            "64:ff9b::1",
        ] {
            let ip: std::net::Ipv6Addr = address.parse().expect("valid test address");
            assert!(!is_public_image_ipv6(ip), "{address} must be blocked");
        }
        for address in ["2606:4700:4700::1111", "2001:4860:4860::8888"] {
            let ip: std::net::Ipv6Addr = address.parse().expect("valid test address");
            assert!(is_public_image_ipv6(ip), "{address} must be allowed");
        }
    }

    #[test]
    fn image_url_filter_blocks_literal_internal_hosts_without_resolving_dns() {
        for url in [
            "http://127.0.0.1/cover.jpg",
            "http://[::1]/cover.jpg",
            "http://10.1.2.3/cover.jpg",
            "http://169.254.169.254/latest/meta-data",
        ] {
            let parsed = reqwest::Url::parse(url).expect("valid test url");
            assert!(
                ensure_public_image_url(&parsed).is_err(),
                "{url} must be blocked"
            );
        }
        let parsed = reqwest::Url::parse("https://8.8.8.8/cover.jpg").expect("valid test url");
        assert!(
            ensure_public_image_url(&parsed).is_ok_and(|pinned| pinned.is_none()),
            "an IP literal host resolves locally and needs no DNS pinning"
        );
    }

    #[test]
    fn unchanged_files_reuse_the_stored_summary() {
        let path = std::env::temp_dir().join(format!(
            "lyrico-fingerprint-{}-{}.mp3",
            std::process::id(),
            NEXT_SCAN_ID.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::write(&path, b"fingerprint").expect("temporary file should be written");
        let metadata = path.metadata().expect("temporary metadata should exist");
        let modified_at = metadata
            .modified()
            .expect("modified time should exist")
            .duration_since(std::time::UNIX_EPOCH)
            .expect("modified time should be valid")
            .as_secs();
        let path_text = path.to_string_lossy().to_string();
        let track = sample_track(path_text.clone());
        let index = HashMap::from([(
            path_text,
            IndexedTrack {
                track: track.clone(),
                file_size: metadata.len(),
                modified_at,
            },
        )]);

        let reused = unchanged_track(&path, &index).expect("unchanged file should reuse the index");

        assert_eq!(reused.title, track.title);
        std::fs::remove_file(path).expect("temporary file should be removed");
    }

    fn sample_track(path: String) -> AudioTrack {
        AudioTrack {
            id: path.clone(),
            path,
            file_name: "sample.mp3".to_string(),
            title: "Stored title".to_string(),
            artist: String::new(),
            album: String::new(),
            album_artist: String::new(),
            genre: String::new(),
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
            duration_seconds: 0,
            format: "MP3".to_string(),
            bitrate: None,
            sample_rate: None,
            channels: None,
            cover_data_url: None,
            has_lyrics: false,
            has_cover: false,
            replay_gain_track_gain: String::new(),
            replay_gain_track_peak: String::new(),
            replay_gain_album_gain: String::new(),
            replay_gain_album_peak: String::new(),
            replay_gain_reference_loudness: String::new(),
            modified_at: None,
            added_at: None,
            created_at: None,
        }
    }
}
