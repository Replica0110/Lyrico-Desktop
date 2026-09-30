//! Allow-listing of every path that arrives from the webview.
//!
//! The renderer is untrusted, so a path that crosses the IPC boundary is only
//! accepted when it sits under a root the backend owns (library folders and the
//! artist poster folder) or under a path the user confirmed through one of the
//! dialogs issued here. Grants can therefore never be minted by an arbitrary
//! `invoke` call: they only come out of [`pick_paths`] / [`pick_save_path`],
//! which wrap the native picker.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Deserialize;
use tauri::{AppHandle, Manager, State, Window};
use tauri_plugin_dialog::DialogExt as _;

use crate::config as app_config;
use crate::AppState;

/// Paths handed back by a confirmed native dialog.
#[derive(Default)]
pub(crate) struct PathGrants(Mutex<HashSet<PathBuf>>);

impl PathGrants {
    fn grant(&self, path: &Path) {
        if let Ok(mut grants) = self.0.lock() {
            let raw = path.to_path_buf();
            let resolved = resolve(path);
            grants.insert(raw.clone());
            grants.insert(resolved);
        }
    }

    fn snapshot(&self) -> HashSet<PathBuf> {
        self.0
            .lock()
            .map(|grants| grants.clone())
            .unwrap_or_default()
    }
}

/// Stable identity for a path, used to key per-file state such as write locks.
pub(crate) fn path_key(path: &Path) -> PathBuf {
    resolve(path)
}

/// Resolve `path` to a canonical form, falling back to resolving the parent
/// directory when the path itself does not exist yet (fresh save targets).
fn resolve(path: &Path) -> PathBuf {
    // Resolve the nearest existing ancestor, including symlinks, then normalize
    // the remaining components. Fresh nested save targets must not retain `..`.
    for ancestor in path.ancestors() {
        if let Ok(canonical) = std::fs::canonicalize(ancestor) {
            let mut resolved = strip_extended_prefix(&canonical);
            if let Ok(suffix) = path.strip_prefix(ancestor) {
                for component in suffix.components() {
                    match component {
                        std::path::Component::ParentDir => {
                            resolved.pop();
                        }
                        std::path::Component::Normal(name) => resolved.push(name),
                        _ => {}
                    }
                }
            }
            return resolved;
        }
    }
    path.to_path_buf()
}

/// `\\?\C:\a` and `\\?\UNC\server\share\a` are what `canonicalize` returns on
/// Windows; they would never compare equal to the plain paths we store.
fn strip_extended_prefix(path: &Path) -> PathBuf {
    let text = path.to_string_lossy();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        let rest = rest.to_owned();
        return PathBuf::from(format!(r"\\{rest}"));
    }
    if let Some(rest) = text.strip_prefix(r"\\?\") {
        return PathBuf::from(rest.to_owned());
    }
    path.to_path_buf()
}

/// Directories and files the backend owns by itself, independent of any dialog.
async fn allowed_roots(
    app: &AppHandle,
    state: &State<'_, AppState>,
) -> Result<Vec<PathBuf>, String> {
    let mut roots = Vec::new();
    for folder in state.database.load_folders().await? {
        push_root(&mut roots, &folder.path);
    }
    let poster_folder = app_config::load_desktop_settings(app)?.artist_poster_folder;
    push_root(&mut roots, &poster_folder);
    Ok(roots)
}

fn push_root(roots: &mut Vec<PathBuf>, raw: &str) {
    let raw = raw.trim();
    if raw.is_empty() {
        return;
    }
    let path = PathBuf::from(raw);
    roots.push(path.clone());
    let resolved = resolve(&path);
    if resolved != path {
        roots.push(resolved);
    }
}

fn is_allowed(path: &Path, roots: &[PathBuf], grants: &HashSet<PathBuf>) -> bool {
    let resolved = resolve(path);
    roots
        .iter()
        .chain(grants)
        .any(|root| resolved.starts_with(resolve(root)))
}

pub(crate) async fn ensure_allowed(
    app: &AppHandle,
    state: &State<'_, AppState>,
    path: &Path,
) -> Result<(), String> {
    let roots = allowed_roots(app, state).await?;
    let grants = state.path_grants.snapshot();
    if is_allowed(path, &roots, &grants) {
        Ok(())
    } else {
        Err(denied(path))
    }
}

pub(crate) async fn ensure_all_allowed(
    app: &AppHandle,
    state: &State<'_, AppState>,
    paths: &[String],
) -> Result<(), String> {
    let roots = allowed_roots(app, state).await?;
    let grants = state.path_grants.snapshot();
    for raw in paths {
        if !is_allowed(Path::new(raw), &roots, &grants) {
            return Err(denied(Path::new(raw)));
        }
    }
    Ok(())
}

fn denied(path: &Path) -> String {
    format!("Path is not allowed: {}", path.display())
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PickOptions {
    title: Option<String>,
    #[serde(default)]
    filters: Vec<PickFilter>,
    #[serde(default)]
    multiple: bool,
    #[serde(default)]
    directory: bool,
    default_path: Option<PathBuf>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PickFilter {
    name: String,
    extensions: Vec<String>,
}

fn build_dialog<R: tauri::Runtime>(
    window: &Window<R>,
    options: PickOptions,
) -> tauri_plugin_dialog::FileDialogBuilder<R> {
    let mut builder = window.app_handle().dialog().file();
    #[cfg(desktop)]
    {
        builder = builder.set_parent(window);
    }
    if let Some(title) = options.title {
        builder = builder.set_title(title);
    }
    if let Some(default_path) = options.default_path {
        builder = set_default_path(builder, default_path);
    }
    for filter in options.filters {
        let extensions: Vec<&str> = filter.extensions.iter().map(String::as_str).collect();
        builder = builder.add_filter(filter.name, &extensions);
    }
    builder
}

fn set_default_path<R: tauri::Runtime>(
    mut builder: tauri_plugin_dialog::FileDialogBuilder<R>,
    default_path: PathBuf,
) -> tauri_plugin_dialog::FileDialogBuilder<R> {
    let default_path: PathBuf = default_path.components().collect();
    if default_path.is_file() || !default_path.exists() {
        if let (Some(parent), Some(file_name)) = (default_path.parent(), default_path.file_name()) {
            if parent.components().count() > 0 {
                builder = builder.set_directory(parent);
            }
            builder = builder.set_file_name(file_name.to_string_lossy().to_string());
        }
    } else {
        builder = builder.set_directory(default_path);
    }
    builder
}

fn path_to_string(path: PathBuf) -> String {
    path.to_string_lossy().to_string()
}

#[tauri::command]
pub(crate) async fn pick_paths(
    window: Window,
    state: State<'_, AppState>,
    options: PickOptions,
) -> Result<Vec<String>, String> {
    let directory = options.directory;
    let multiple = options.multiple;
    let builder = build_dialog(&window, options);

    let picked: Vec<PathBuf> = if directory {
        if multiple {
            builder
                .blocking_pick_folders()
                .unwrap_or_default()
                .into_iter()
                .filter_map(|folder| folder.into_path().ok())
                .collect()
        } else {
            builder
                .blocking_pick_folder()
                .and_then(|folder| folder.into_path().ok())
                .into_iter()
                .collect()
        }
    } else if multiple {
        builder
            .blocking_pick_files()
            .unwrap_or_default()
            .into_iter()
            .filter_map(|file| file.into_path().ok())
            .collect()
    } else {
        builder
            .blocking_pick_file()
            .and_then(|file| file.into_path().ok())
            .into_iter()
            .collect()
    };

    for path in &picked {
        state.path_grants.grant(path);
    }
    Ok(picked.into_iter().map(path_to_string).collect())
}

#[tauri::command]
pub(crate) async fn pick_save_path(
    window: Window,
    state: State<'_, AppState>,
    options: PickOptions,
) -> Result<Option<String>, String> {
    let builder = build_dialog(&window, options);
    let picked = builder
        .blocking_save_file()
        .and_then(|file| file.into_path().ok());
    if let Some(path) = &picked {
        state.path_grants.grant(path);
    }
    Ok(picked.map(path_to_string))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn allowed(path: &Path, roots: &[PathBuf], grants: &[PathBuf]) -> bool {
        is_allowed(path, roots, &grants.iter().cloned().collect())
    }

    #[test]
    fn library_roots_cover_nested_tracks() {
        let roots = [PathBuf::from(r"D:\Music")];
        assert!(allowed(Path::new(r"D:\Music\a.mp3"), &roots, &[]));
        assert!(allowed(Path::new(r"D:\Music\album\a.mp3"), &roots, &[]));
        assert!(!allowed(Path::new(r"D:\Other\a.mp3"), &roots, &[]));
    }

    #[test]
    fn grant_covers_the_file_itself_and_nothing_else() {
        let grants = [PathBuf::from(r"D:\Temp\cover.jpg")];
        assert!(allowed(Path::new(r"D:\Temp\cover.jpg"), &[], &grants));
        assert!(!allowed(Path::new(r"D:\Temp\other.jpg"), &[], &grants));
    }

    #[test]
    fn directory_grant_covers_its_children() {
        let grants = [PathBuf::from(r"D:\Exports")];
        assert!(allowed(Path::new(r"D:\Exports\song.lrc"), &[], &grants));
        assert!(!allowed(Path::new(r"D:\Exported\song.lrc"), &[], &grants));
    }

    #[test]
    fn parent_directories_are_not_granted_by_a_file_grant() {
        let grants = [PathBuf::from(r"D:\Temp\cover.jpg")];
        assert!(!allowed(Path::new(r"D:\Temp"), &[], &grants));
        assert!(!allowed(Path::new(r"D:\Temp\secret.txt"), &[], &grants));
    }

    #[test]
    fn resolve_falls_back_to_the_existing_parent() {
        let existing_parent = std::env::temp_dir();
        let target = existing_parent.join("lyrico-path-access-missing.bin");
        let resolved = resolve(&target);
        assert_eq!(resolved.file_name(), target.file_name());
        assert!(resolved.is_absolute());
    }

    #[test]
    fn path_key_unifies_case_variants_of_the_same_file() {
        let file = std::env::temp_dir().join("LyricoPathKeyProbe.mp3");
        std::fs::write(&file, b"probe").expect("temp probe file should be writable");
        let upper = PathBuf::from(file.to_string_lossy().to_uppercase());
        assert_eq!(path_key(&file), path_key(&upper));
        let _ = std::fs::remove_file(&file);
    }

    #[test]
    fn strip_extended_prefix_handles_canonical_forms() {
        assert_eq!(
            strip_extended_prefix(Path::new(r"\\?\C:\a")),
            PathBuf::from(r"C:\a")
        );
        assert_eq!(
            strip_extended_prefix(Path::new(r"\\?\UNC\server\share\a")),
            PathBuf::from(r"\\server\share\a")
        );
        assert_eq!(
            strip_extended_prefix(Path::new(r"C:\a")),
            PathBuf::from(r"C:\a")
        );
    }
}
