use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone)]
pub(crate) struct DataPaths {
    pub(crate) root: PathBuf,
    pub(crate) database: PathBuf,
    pub(crate) settings: PathBuf,
    pub(crate) plugins: PathBuf,
    pub(crate) logs: PathBuf,
    pub(crate) location: String,
}

pub(crate) fn resolve_data_paths(app: &AppHandle) -> Result<DataPaths, String> {
    let root = app
        .path()
        .app_local_data_dir()
        .map_err(|error| error.to_string())?;
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;

    let database = root.join("database").join("lyrico.sqlite3");
    let settings = root.join("config").join("settings.json");
    let logs = root.join("logs");
    let plugins = root.join("plugins").join("sources");
    if let Some(parent) = database.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    if let Some(parent) = settings.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::create_dir_all(&plugins).map_err(|error| error.to_string())?;
    Ok(DataPaths {
        root,
        database,
        settings,
        plugins,
        logs,
        location: "appLocalData".to_string(),
    })
}
