use super::manifest::{
    PluginInstallFailure, PluginInstallPreview, PluginInstallPreviewCandidate, PluginInstallResult,
    PluginManifest, PluginSourceState, SourcePlugin, HOST_API_VERSION, MIN_HOST_API_VERSION,
    MIN_PLUGIN_API_VERSION, PLUGIN_API_VERSION,
};
use crate::database::{Database, PluginRecord};
use serde_json::{Map, Value};
use std::collections::BTreeMap;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use zip::ZipArchive;

const MAX_ARCHIVE_BYTES: u64 = 30 * 1024 * 1024;
const MAX_PLUGIN_BYTES: u64 = 5 * 1024 * 1024;
const MAX_MANIFEST_BYTES: u64 = 128 * 1024;
const MAX_ENTRY_BYTES: u64 = 1024 * 1024;
const MAX_PLUGIN_COUNT: usize = 20;
const MAX_FILE_COUNT: usize = 1000;
const MAX_DEPTH: usize = 16;

struct Candidate {
    manifest: PluginManifest,
    manifest_json: String,
    root: PathBuf,
    relative_root: String,
}

pub(crate) async fn load_plugins(
    database: &Database,
    plugins_root: &Path,
    locale: Option<&str>,
) -> Result<Vec<SourcePlugin>, String> {
    let records = database.load_plugin_records().await?;
    records
        .into_iter()
        .map(|record| source_from_record(record, plugins_root, locale))
        .collect()
}

pub(crate) async fn install_archive(
    database: &Database,
    plugins_root: &Path,
    archive_path: &Path,
    allow_downgrade: bool,
    selected_roots: Option<Vec<String>>,
    locale: Option<&str>,
) -> Result<PluginInstallResult, String> {
    validate_archive_path(archive_path)?;
    fs::create_dir_all(plugins_root).map_err(|error| error.to_string())?;
    let import_root = plugins_root.join(format!(".import-{}", unique_suffix()));
    fs::create_dir_all(&import_root).map_err(|error| error.to_string())?;
    let result = async {
        extract_archive(archive_path, &import_root)?;
        let (candidates, mut failed) = discover_candidates(&import_root)?;
        let duplicate_ids = duplicate_ids(&candidates);
        let existing = database
            .load_plugin_records()
            .await?
            .into_iter()
            .map(|record| (record.id.clone(), record))
            .collect::<HashMap<_, _>>();
        let candidate_roots = candidates
            .iter()
            .map(|candidate| candidate.root.clone())
            .collect::<Vec<_>>();
        let selected_roots = selected_roots.map(|roots| roots.into_iter().collect::<HashSet<_>>());
        let mut installed = Vec::new();

        for candidate in candidates {
            if selected_roots
                .as_ref()
                .is_some_and(|roots| !roots.contains(&candidate.relative_root))
            {
                continue;
            }
            if duplicate_ids.contains(&candidate.manifest.id) {
                failed.push(failure(&candidate, "Duplicate plugin id in archive"));
                continue;
            }
            if let Some(record) = existing.get(&candidate.manifest.id) {
                let old_manifest: PluginManifest = serde_json::from_str(&record.manifest_json)
                    .map_err(|error| format!("Installed plugin manifest is invalid: {error}"))?;
                if candidate.manifest.version_code < old_manifest.version_code && !allow_downgrade {
                    failed.push(failure(
                        &candidate,
                        "Import version is lower than installed version",
                    ));
                    continue;
                }
            }
            match install_candidate(database, plugins_root, &candidate, &candidate_roots, locale)
                .await
            {
                Ok(plugin) => installed.push(plugin),
                Err(reason) => failed.push(failure(&candidate, &reason)),
            }
        }
        Ok(PluginInstallResult { installed, failed })
    }
    .await;
    let _ = fs::remove_dir_all(&import_root);
    result
}

pub(crate) async fn preview_archive(
    database: &Database,
    plugins_root: &Path,
    archive_path: &Path,
) -> Result<PluginInstallPreview, String> {
    validate_archive_path(archive_path)?;
    fs::create_dir_all(plugins_root).map_err(|error| error.to_string())?;
    let import_root = plugins_root.join(format!(".preview-{}", unique_suffix()));
    fs::create_dir_all(&import_root).map_err(|error| error.to_string())?;
    let result = async {
        extract_archive(archive_path, &import_root)?;
        let (candidates, mut failed) = discover_candidates(&import_root)?;
        let duplicate_ids = duplicate_ids(&candidates);
        let existing = database
            .load_plugin_records()
            .await?
            .into_iter()
            .map(|record| (record.id.clone(), record))
            .collect::<HashMap<_, _>>();
        let mut preview = Vec::new();
        for candidate in candidates {
            if duplicate_ids.contains(&candidate.manifest.id) {
                failed.push(failure(&candidate, "Duplicate plugin id in archive"));
                continue;
            }
            let installed_manifest = existing
                .get(&candidate.manifest.id)
                .map(|record| {
                    serde_json::from_str::<PluginManifest>(&record.manifest_json)
                        .map_err(|error| format!("Installed plugin manifest is invalid: {error}"))
                })
                .transpose()?;
            let conflict = match installed_manifest.as_ref() {
                None => "new",
                Some(installed) if candidate.manifest.version_code > installed.version_code => {
                    "update"
                }
                Some(installed) if candidate.manifest.version_code < installed.version_code => {
                    "downgrade"
                }
                Some(_) => "overwrite",
            };
            let icon_data_url = candidate.manifest.icon.as_ref().and_then(|icon| {
                crate::audio::read_image_data_url(&candidate.root.join(icon)).ok()
            });
            preview.push(PluginInstallPreviewCandidate {
                manifest: candidate.manifest,
                relative_root: candidate.relative_root,
                conflict: conflict.to_string(),
                existing_version_name: installed_manifest.map(|manifest| manifest.version_name),
                icon_data_url,
            });
        }
        Ok(PluginInstallPreview {
            candidates: preview,
            failed,
        })
    }
    .await;
    let _ = fs::remove_dir_all(&import_root);
    result
}

fn validate_archive_path(archive_path: &Path) -> Result<(), String> {
    if archive_path
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("zip"))
    {
        Ok(())
    } else {
        Err("Plugin package must be a .zip archive".to_string())
    }
}

pub(crate) async fn set_enabled(
    database: &Database,
    plugins_root: &Path,
    plugin_id: &str,
    enabled: bool,
    locale: Option<&str>,
) -> Result<Vec<SourcePlugin>, String> {
    validate_plugin_id(plugin_id)?;
    if enabled && !plugins_root.join(plugin_id).is_dir() {
        return Err("Installed plugin directory is missing".to_string());
    }
    database.set_plugin_enabled(plugin_id, enabled).await?;
    load_plugins(database, plugins_root, locale).await
}

pub(crate) async fn set_source_enabled(
    database: &Database,
    plugins_root: &Path,
    plugin_id: &str,
    source_kind: &str,
    enabled: bool,
    locale: Option<&str>,
) -> Result<Vec<SourcePlugin>, String> {
    validate_plugin_id(plugin_id)?;
    database
        .set_plugin_source_enabled(plugin_id, source_kind, enabled)
        .await?;
    load_plugins(database, plugins_root, locale).await
}

pub(crate) async fn reorder_sources(
    database: &Database,
    plugins_root: &Path,
    source_kind: &str,
    plugin_ids: Vec<String>,
    locale: Option<&str>,
) -> Result<Vec<SourcePlugin>, String> {
    database
        .reorder_plugin_sources(source_kind, &plugin_ids)
        .await?;
    load_plugins(database, plugins_root, locale).await
}

pub(crate) async fn save_settings(
    database: &Database,
    plugins_root: &Path,
    plugin_id: &str,
    config: Value,
    locale: Option<&str>,
) -> Result<Vec<SourcePlugin>, String> {
    validate_plugin_id(plugin_id)?;
    if !config.is_object() {
        return Err("Plugin settings must be a JSON object".to_string());
    }
    database
        .save_plugin_settings(plugin_id, &config.to_string())
        .await?;
    load_plugins(database, plugins_root, locale).await
}

pub(crate) async fn uninstall(
    database: &Database,
    plugins_root: &Path,
    plugin_id: &str,
    locale: Option<&str>,
) -> Result<Vec<SourcePlugin>, String> {
    validate_plugin_id(plugin_id)?;
    let target = plugins_root.join(plugin_id);
    if target.exists() {
        fs::remove_dir_all(&target).map_err(|error| error.to_string())?;
    }
    database.delete_plugin_record(plugin_id).await?;
    load_plugins(database, plugins_root, locale).await
}

async fn install_candidate(
    database: &Database,
    plugins_root: &Path,
    candidate: &Candidate,
    candidate_roots: &[PathBuf],
    locale: Option<&str>,
) -> Result<SourcePlugin, String> {
    let suffix = unique_suffix();
    let staging = plugins_root.join(format!(".staging-{}-{suffix}", candidate.manifest.id));
    let backup = plugins_root.join(format!(".backup-{}-{suffix}", candidate.manifest.id));
    let target = plugins_root.join(&candidate.manifest.id);
    let _ = fs::remove_dir_all(&staging);
    let _ = fs::remove_dir_all(&backup);
    fs::create_dir_all(&staging).map_err(|error| error.to_string())?;
    copy_plugin_root(&candidate.root, &staging, candidate_roots)?;
    validate_plugin_size(&staging)?;

    if target.exists() {
        fs::rename(&target, &backup).map_err(|error| error.to_string())?;
    }
    if let Err(error) = fs::rename(&staging, &target) {
        if backup.exists() {
            let _ = fs::rename(&backup, &target);
        }
        return Err(error.to_string());
    }

    let defaults = default_settings(&candidate.manifest);
    let record = match database
        .upsert_plugin_record(
            &candidate.manifest.id,
            &candidate.manifest_json,
            &Value::Object(defaults).to_string(),
        )
        .await
    {
        Ok(record) => record,
        Err(error) => {
            let _ = fs::remove_dir_all(&target);
            if backup.exists() {
                let _ = fs::rename(&backup, &target);
            }
            return Err(error);
        }
    };
    let _ = fs::remove_dir_all(&backup);
    source_from_record(record, plugins_root, locale)
}

fn extract_archive(archive_path: &Path, target: &Path) -> Result<(), String> {
    let file = fs::File::open(archive_path).map_err(|error| error.to_string())?;
    let mut archive = ZipArchive::new(file).map_err(|error| error.to_string())?;
    if archive.len() > MAX_FILE_COUNT {
        return Err("Archive contains too many files".to_string());
    }
    let mut total_bytes = 0_u64;
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(|error| error.to_string())?;
        let entry_name = entry.name().to_string();
        validate_zip_name(&entry_name)?;
        if let Some(mode) = entry.unix_mode() {
            if mode & 0o170000 == 0o120000 {
                return Err(format!("Symbolic links are not allowed: {entry_name}"));
            }
        }
        let relative = entry
            .enclosed_name()
            .ok_or_else(|| format!("Unsafe zip entry: {entry_name}"))?;
        if relative.components().count() > MAX_DEPTH {
            return Err(format!("Zip entry is too deep: {entry_name}"));
        }
        let output = target.join(relative);
        if entry.is_dir() {
            fs::create_dir_all(&output).map_err(|error| error.to_string())?;
            continue;
        }
        if let Some(parent) = output.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let remaining = MAX_ARCHIVE_BYTES.saturating_sub(total_bytes);
        let mut output_file = fs::File::create(&output).map_err(|error| error.to_string())?;
        let copied = std::io::copy(&mut (&mut entry).take(remaining + 1), &mut output_file)
            .map_err(|error| error.to_string())?;
        output_file.flush().map_err(|error| error.to_string())?;
        total_bytes += copied;
        if total_bytes > MAX_ARCHIVE_BYTES {
            return Err("Archive is too large after extraction".to_string());
        }
    }
    Ok(())
}

fn discover_candidates(root: &Path) -> Result<(Vec<Candidate>, Vec<PluginInstallFailure>), String> {
    let mut manifests = Vec::new();
    collect_manifest_files(root, &mut manifests)?;
    if manifests.is_empty() {
        return Err("Plugin manifest not found".to_string());
    }
    if manifests.len() > MAX_PLUGIN_COUNT {
        return Err("Archive contains too many plugins".to_string());
    }
    let mut candidates = Vec::new();
    let mut failed = Vec::new();
    for manifest_path in manifests {
        let relative_root = manifest_path
            .parent()
            .and_then(|parent| parent.strip_prefix(root).ok())
            .map(|path| path.to_string_lossy().replace('\\', "/"))
            .unwrap_or_else(|| ".".to_string());
        match build_candidate(root, &manifest_path, relative_root.clone()) {
            Ok(candidate) => candidates.push(candidate),
            Err(reason) => failed.push(PluginInstallFailure {
                root_path: relative_root,
                reason,
                plugin_id: None,
            }),
        }
    }
    Ok((candidates, failed))
}

fn build_candidate(
    package_root: &Path,
    manifest_path: &Path,
    relative_root: String,
) -> Result<Candidate, String> {
    let metadata = fs::metadata(manifest_path).map_err(|error| error.to_string())?;
    if metadata.len() > MAX_MANIFEST_BYTES {
        return Err("Plugin manifest is too large".to_string());
    }
    let manifest_json = fs::read_to_string(manifest_path).map_err(|error| error.to_string())?;
    let manifest: PluginManifest = serde_json::from_str(&manifest_json)
        .map_err(|error| format!("Plugin manifest parse failed: {error}"))?;
    validate_manifest(&manifest)?;
    let root = manifest_path
        .parent()
        .ok_or_else(|| "Manifest has no parent directory".to_string())?
        .to_path_buf();
    let canonical_package = package_root
        .canonicalize()
        .map_err(|error| error.to_string())?;
    let canonical_root = root.canonicalize().map_err(|error| error.to_string())?;
    if !canonical_root.starts_with(&canonical_package) {
        return Err("Plugin root escapes the archive".to_string());
    }
    validate_file(&root, &manifest.entry, Some("js"), MAX_ENTRY_BYTES, "entry")?;
    for include_dir in &manifest.include_dirs {
        let path = safe_join(&root, include_dir)?;
        if !path.is_dir() {
            return Err(format!("includeDir not found: {include_dir}"));
        }
    }
    if let Some(icon) = manifest.icon.as_deref() {
        let extension = Path::new(icon)
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        if !["png", "jpg", "jpeg", "webp"].contains(&extension.as_str()) {
            return Err(format!("Unsupported icon type: {icon}"));
        }
        validate_file(&root, icon, None, MAX_PLUGIN_BYTES, "icon")?;
    }
    super::i18n::validate(&root, &manifest)?;
    Ok(Candidate {
        manifest,
        manifest_json,
        root,
        relative_root,
    })
}

fn validate_manifest(manifest: &PluginManifest) -> Result<(), String> {
    validate_plugin_id(&manifest.id)?;
    if manifest.name.trim().is_empty() {
        return Err("Plugin name is required".to_string());
    }
    if manifest.version_code < 1 {
        return Err("Plugin versionCode must be >= 1".to_string());
    }
    if manifest.api_version < MIN_PLUGIN_API_VERSION || manifest.api_version > PLUGIN_API_VERSION {
        return Err(format!(
            "Unsupported plugin apiVersion: {} (supported: {}..={})",
            manifest.api_version, MIN_PLUGIN_API_VERSION, PLUGIN_API_VERSION
        ));
    }
    if manifest.min_host_api_version < MIN_HOST_API_VERSION
        || manifest.min_host_api_version > HOST_API_VERSION
    {
        return Err(format!(
            "Unsupported minHostApiVersion: {} (host: {}..={})",
            manifest.min_host_api_version, MIN_HOST_API_VERSION, HOST_API_VERSION
        ));
    }
    if !manifest.capabilities.is_empty()
        && !manifest
            .capabilities
            .iter()
            .any(|value| matches!(value.as_str(), "searchSongs" | "getLyrics" | "searchCovers"))
    {
        return Err("A source plugin must support searchSongs".to_string());
    }
    for capability in &manifest.capabilities {
        if !["searchSongs", "getLyrics", "searchCovers"].contains(&capability.as_str()) {
            return Err(format!("Unsupported plugin capability: {capability}"));
        }
    }
    for field in &manifest.config_fields {
        if field.key.trim().is_empty() || field.title.trim().is_empty() {
            return Err("Plugin config field key and title are required".to_string());
        }
        if ![
            "text", "password", "number", "switch", "dropdown", "textarea", "markdown",
        ]
        .contains(&field.field_type.as_str())
        {
            return Err(format!(
                "Unsupported config field type: {}",
                field.field_type
            ));
        }
    }
    Ok(())
}

fn validate_plugin_id(plugin_id: &str) -> Result<(), String> {
    let parts = plugin_id.split('.').collect::<Vec<_>>();
    if parts.len() < 2
        || parts.iter().any(|part| {
            let mut chars = part.chars();
            !chars
                .next()
                .is_some_and(|value| value.is_ascii_alphabetic())
                || chars.any(|value| !value.is_ascii_alphanumeric() && value != '_')
        })
    {
        return Err("Plugin id must use reverse-domain format".to_string());
    }
    Ok(())
}

fn validate_file(
    root: &Path,
    relative: &str,
    extension: Option<&str>,
    max_bytes: u64,
    label: &str,
) -> Result<(), String> {
    let path = safe_join(root, relative)?;
    if !path.is_file() {
        return Err(format!("Plugin {label} not found: {relative}"));
    }
    if extension.is_some_and(|expected| {
        !path
            .extension()
            .and_then(|value| value.to_str())
            .is_some_and(|value| value.eq_ignore_ascii_case(expected))
    }) {
        return Err(format!(
            "Plugin {label} must be a .{} file",
            extension.unwrap_or_default()
        ));
    }
    if fs::metadata(&path)
        .map_err(|error| error.to_string())?
        .len()
        > max_bytes
    {
        return Err(format!("Plugin {label} is too large"));
    }
    Ok(())
}

fn safe_join(root: &Path, relative: &str) -> Result<PathBuf, String> {
    if relative.is_empty() || relative.contains('\\') || relative.contains('\0') {
        return Err(format!("Unsafe plugin path: {relative}"));
    }
    let path = Path::new(relative);
    if path.is_absolute()
        || path
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err(format!("Unsafe plugin path: {relative}"));
    }
    Ok(root.join(path))
}

fn validate_zip_name(name: &str) -> Result<(), String> {
    if name.is_empty() || name.contains('\0') || name.contains('\\') || name.starts_with('/') {
        return Err(format!("Unsafe zip entry: {name}"));
    }
    if name.split('/').any(|part| part == "..") {
        return Err(format!("Unsafe zip entry: {name}"));
    }
    Ok(())
}

fn collect_manifest_files(root: &Path, output: &mut Vec<PathBuf>) -> Result<(), String> {
    for entry in fs::read_dir(root).map_err(|error| error.to_string())? {
        let path = entry.map_err(|error| error.to_string())?.path();
        if path.is_dir() {
            collect_manifest_files(&path, output)?;
        } else if path.file_name().and_then(|value| value.to_str()) == Some("manifest.json") {
            output.push(path);
        }
    }
    Ok(())
}

fn copy_plugin_root(
    source: &Path,
    target: &Path,
    candidate_roots: &[PathBuf],
) -> Result<(), String> {
    let other_roots = candidate_roots
        .iter()
        .filter(|root| root.as_path() != source && root.starts_with(source))
        .cloned()
        .collect::<Vec<_>>();
    copy_tree(source, source, target, &other_roots)
}

fn copy_tree(
    root: &Path,
    current: &Path,
    target: &Path,
    excluded: &[PathBuf],
) -> Result<(), String> {
    if excluded.iter().any(|path| path == current) {
        return Ok(());
    }
    for entry in fs::read_dir(current).map_err(|error| error.to_string())? {
        let path = entry.map_err(|error| error.to_string())?.path();
        if excluded
            .iter()
            .any(|excluded| path == *excluded || path.starts_with(excluded))
        {
            continue;
        }
        let relative = path.strip_prefix(root).map_err(|error| error.to_string())?;
        let destination = target.join(relative);
        if path.is_dir() {
            fs::create_dir_all(&destination).map_err(|error| error.to_string())?;
            copy_tree(root, &path, target, excluded)?;
        } else {
            if let Some(parent) = destination.parent() {
                fs::create_dir_all(parent).map_err(|error| error.to_string())?;
            }
            fs::copy(&path, &destination).map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

fn validate_plugin_size(plugin_dir: &Path) -> Result<(), String> {
    let mut total = 0_u64;
    accumulate_size(plugin_dir, &mut total)?;
    if total > MAX_PLUGIN_BYTES {
        Err("Plugin is too large".to_string())
    } else {
        Ok(())
    }
}

fn accumulate_size(path: &Path, total: &mut u64) -> Result<(), String> {
    for entry in fs::read_dir(path).map_err(|error| error.to_string())? {
        let path = entry.map_err(|error| error.to_string())?.path();
        if path.is_dir() {
            accumulate_size(&path, total)?;
        } else {
            *total += fs::metadata(path).map_err(|error| error.to_string())?.len();
        }
    }
    Ok(())
}

fn default_settings(manifest: &PluginManifest) -> Map<String, Value> {
    manifest
        .config_fields
        .iter()
        .filter(|field| field.field_type != "markdown")
        .map(|field| {
            (
                field.key.clone(),
                Value::String(field.default_value.clone()),
            )
        })
        .collect()
}

fn source_from_record(
    record: PluginRecord,
    plugins_root: &Path,
    locale: Option<&str>,
) -> Result<SourcePlugin, String> {
    let mut manifest: PluginManifest = serde_json::from_str(&record.manifest_json)
        .map_err(|error| format!("Stored plugin manifest is invalid: {error}"))?;
    let config = serde_json::from_str(&record.settings_json)
        .map_err(|error| format!("Stored plugin settings are invalid: {error}"))?;
    let plugin_dir = plugins_root.join(&manifest.id);
    if manifest.capabilities.is_empty() {
        manifest.capabilities = vec!["searchSongs".to_string()];
    }
    if let Some(locale) = locale {
        let preferred = [locale.to_string()];
        if let Ok(localized) = super::i18n::localize_manifest(&manifest, &plugin_dir, &preferred) {
            manifest = localized;
        }
    }
    let icon_path = manifest
        .icon
        .as_ref()
        .map(|icon| plugin_dir.join(icon).to_string_lossy().to_string());
    let icon_data_url = manifest
        .icon
        .as_ref()
        .and_then(|icon| crate::audio::read_image_data_url(&plugin_dir.join(icon)).ok());
    let capabilities = if manifest.capabilities.is_empty() {
        vec!["searchSongs"]
    } else {
        manifest.capabilities.iter().map(String::as_str).collect()
    };
    let supports = |capability: &str| capabilities.contains(&capability);
    let source_enabled = |flag: bool| record.enabled && flag;
    let mut source_states = BTreeMap::new();
    if ["searchSongs", "getLyrics", "searchCovers"]
        .iter()
        .all(|capability| supports(capability))
    {
        source_states.insert(
            "aggregated".to_string(),
            PluginSourceState {
                enabled: record.enabled
                    && record.metadata_enabled
                    && record.lyrics_enabled
                    && record.cover_enabled,
                priority: record.sort_order,
            },
        );
    }
    if supports("searchSongs") {
        source_states.insert(
            "metadata".to_string(),
            PluginSourceState {
                enabled: source_enabled(record.metadata_enabled),
                priority: record.metadata_sort_order,
            },
        );
    }
    if supports("getLyrics") {
        source_states.insert(
            "lyrics".to_string(),
            PluginSourceState {
                enabled: source_enabled(record.lyrics_enabled),
                priority: record.lyrics_sort_order,
            },
        );
    }
    if supports("searchCovers") {
        source_states.insert(
            "covers".to_string(),
            PluginSourceState {
                enabled: source_enabled(record.cover_enabled),
                priority: record.cover_sort_order,
            },
        );
    }
    Ok(SourcePlugin {
        manifest,
        plugin_dir: plugin_dir.to_string_lossy().to_string(),
        icon_path,
        icon_data_url,
        enabled: record.enabled,
        sort_order: record.sort_order,
        source_states,
        installed_at: record.installed_at,
        updated_at: record.updated_at,
        config,
    })
}

fn duplicate_ids(candidates: &[Candidate]) -> HashSet<String> {
    let mut seen = HashSet::new();
    let mut duplicates = HashSet::new();
    for candidate in candidates {
        if !seen.insert(candidate.manifest.id.clone()) {
            duplicates.insert(candidate.manifest.id.clone());
        }
    }
    duplicates
}

fn failure(candidate: &Candidate, reason: &str) -> PluginInstallFailure {
    PluginInstallFailure {
        root_path: candidate.relative_root.clone(),
        reason: reason.to_string(),
        plugin_id: Some(candidate.manifest.id.clone()),
    }
}

fn unique_suffix() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}
