mod audio;
mod batch;
mod commands;
mod config;
mod database;
mod file_mutation;
mod logging;
mod lyrics;
mod lyrics_commands;
mod models;
mod path_access;
mod paths;
mod plugins;
mod remote_image;
mod replay_gain;
mod taglib_bridge;

use batch::BatchManager;
use commands::{
    analyze_replay_gain, cancel_batch_task, cancel_batch_task_item, cancel_replay_gain,
    create_batch_task, delete_batch_tasks, export_config, fetch_remote_image, get_storage_info,
    import_config, install_source_plugin_archive, invoke_source_plugin, load_artist_split_config,
    load_batch_task_items, load_batch_tasks, load_custom_tags, load_desktop_settings,
    load_library_folders, load_library_track, load_library_tracks, load_library_tracks_by_paths,
    load_source_plugins, load_track_covers, open_logs_directory, preview_batch_rename,
    preview_source_plugin_archive, read_audio_file, read_image_file, read_text_file,
    remove_library_folder, reorder_plugin_sources, report_frontend_error, retry_failed_batch_items,
    save_artist_split_config, save_audio_tags, save_desktop_settings, save_source_plugin_settings,
    scan_folder, search_lyrics_lines, set_plugin_source_enabled, set_source_plugin_enabled,
    set_source_plugin_order, start_batch_task, uninstall_source_plugin, upsert_library_folder,
    write_image_file, write_text_file,
};
use database::Database;
use lyrics_commands::{
    detect_lyrics_format, extract_plain_lyrics_text, process_lyrics_text, render_plugin_lyrics,
};
use path_access::{pick_paths, pick_save_path, PathGrants};
use paths::resolve_data_paths;
use std::collections::{HashMap, HashSet};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use tauri::Manager;

pub(crate) struct AppState {
    pub(crate) database: Database,
    pub(crate) active_scans: Mutex<HashSet<String>>,
    pub(crate) active_replay_gain: Mutex<HashMap<String, Arc<AtomicBool>>>,
    pub(crate) batch_manager: BatchManager,
    pub(crate) path_grants: PathGrants,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_sharehub::init())
        .setup(|app| {
            replay_gain::configure_resources(app.path().resource_dir()?);
            let paths = resolve_data_paths(&app.handle()).map_err(std::io::Error::other)?;
            if let Err(error) = logging::init(&paths.logs) {
                eprintln!("Could not initialize file logging: {}", logging::redact(&error));
            }
            let startup = logging::Operation::new("app", "startup", serde_json::json!({"version":env!("CARGO_PKG_VERSION"),"os":std::env::consts::OS,"arch":std::env::consts::ARCH}), log::Level::Info);
            let database = tauri::async_runtime::block_on(Database::open(&paths.database))
                .map_err(std::io::Error::other)?;
            if let Err(error) = tauri::async_runtime::block_on(database.migrate_legacy_logs(&paths.logs)) {
                logging::event(log::Level::Warn,"database","legacy_logs.archive_failed",serde_json::json!({"error":error}));
            }
            let legacy_artist_split =
                tauri::async_runtime::block_on(database.load_legacy_setting("artist_split_config"))
                    .map_err(std::io::Error::other)?;
            config::migrate_legacy_artist_split_config(&app.handle(), legacy_artist_split)
                .map_err(|error| {
                    logging::event(log::Level::Error,"config","startup.failed",serde_json::json!({"error":error}));
                    std::io::Error::other(error)
                })?;
            app.manage(AppState {
                database: database.clone(),
                active_scans: Mutex::new(HashSet::new()),
                active_replay_gain: Mutex::new(HashMap::new()),
                batch_manager: BatchManager::new(database),
                path_grants: PathGrants::default(),
            });
            app.state::<AppState>()
                .batch_manager
                .recover(app.handle().clone());
            startup.finish(&Ok::<(),String>(()));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            scan_folder,
            pick_paths,
            pick_save_path,
            read_audio_file,
            load_custom_tags,
            read_image_file,
            read_text_file,
            write_text_file,
            write_image_file,
            save_audio_tags,
            load_library_folders,
            load_library_tracks,
            load_library_tracks_by_paths,
            load_library_track,
            load_track_covers,
            load_artist_split_config,
            save_artist_split_config,
            load_desktop_settings,
            save_desktop_settings,
            upsert_library_folder,
            remove_library_folder,
            get_storage_info,
            analyze_replay_gain,
            cancel_replay_gain,
            create_batch_task,
            load_batch_tasks,
            delete_batch_tasks,
            load_batch_task_items,
            preview_batch_rename,
            start_batch_task,
            cancel_batch_task,
            cancel_batch_task_item,
            retry_failed_batch_items,
            load_source_plugins,
            preview_source_plugin_archive,
            install_source_plugin_archive,
            set_plugin_source_enabled,
            reorder_plugin_sources,
            set_source_plugin_enabled,
            set_source_plugin_order,
            save_source_plugin_settings,
            uninstall_source_plugin,
            invoke_source_plugin,
            fetch_remote_image,
            export_config,
            import_config,
            search_lyrics_lines,
            open_logs_directory,
            report_frontend_error,
            process_lyrics_text,
            render_plugin_lyrics,
            extract_plain_lyrics_text,
            detect_lyrics_format
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_, event| {
            if let tauri::RunEvent::Exit = event {
                logging::event(log::Level::Info,"app","shutdown",serde_json::json!({}));
                logging::flush();
            }
        });
}
