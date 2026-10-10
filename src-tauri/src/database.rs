use crate::models::{AudioTrack, BatchTask, BatchTaskItem, LibraryFolder, LyricLineMatch};
use rusqlite::{params, Connection, OptionalExtension, Row, ToSql, Transaction};
use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

const DATABASE_SCHEMA_VERSION: u32 = 9;
static NEXT_BATCH_ID: AtomicU64 = AtomicU64::new(1);
const BATCH_TASK_TYPES: &[&str] = &[
    "matchMetadata",
    "editTags",
    "renameFiles",
    "formatLyrics",
    "exportLyrics",
    "exportCover",
    "replayGain",
    "deleteFiles",
];

#[derive(Clone)]
pub(crate) struct Database {
    connection: Arc<Mutex<Connection>>,
}

#[derive(Clone)]
pub(crate) struct IndexedTrack {
    pub(crate) track: AudioTrack,
    pub(crate) file_size: u64,
    pub(crate) modified_at: u64,
}

#[derive(Debug, Clone)]
pub(crate) struct PluginRecord {
    pub(crate) id: String,
    pub(crate) manifest_json: String,
    pub(crate) enabled: bool,
    pub(crate) metadata_enabled: bool,
    pub(crate) lyrics_enabled: bool,
    pub(crate) cover_enabled: bool,
    pub(crate) sort_order: i32,
    pub(crate) metadata_sort_order: i32,
    pub(crate) lyrics_sort_order: i32,
    pub(crate) cover_sort_order: i32,
    pub(crate) installed_at: String,
    pub(crate) updated_at: String,
    pub(crate) settings_json: String,
}

impl Database {
    pub(crate) async fn open(path: &Path) -> Result<Self, String> {
        let operation = crate::logging::Operation::new(
            "database",
            "open",
            serde_json::json!({"schemaVersion":DATABASE_SCHEMA_VERSION}),
            log::Level::Info,
        );
        let result = (|| {
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).map_err(|error| error.to_string())?;
            }
            let connection = Connection::open(path).map_err(|error| error.to_string())?;
            configure_connection(&connection)?;
            migrate_schema(&connection)?;
            Ok(Self {
                connection: Arc::new(Mutex::new(connection)),
            })
        })();
        operation.finish(&result);
        result
    }

    /// Export old diagnostic rows before dropping the retired table. A failed export
    /// leaves the table intact; fresh databases never create it.
    pub(crate) async fn migrate_legacy_logs(&self, directory: &Path) -> Result<(), String> {
        let connection = self.lock()?;
        let exists: bool = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='app_logs')",
                [],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        if !exists {
            return Ok(());
        }
        fs::create_dir_all(directory).map_err(|error| error.to_string())?;
        let archive = directory.join(format!(
            "legacy-database-{}-{}.log",
            now(),
            std::process::id()
        ));
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&archive)
            .map_err(|error| error.to_string())?;
        let result: Result<(), String> = (|| {
            let mut statement = connection.prepare("SELECT created_at,level,type,tag,message,detail,related_id FROM app_logs ORDER BY id").map_err(|error|error.to_string())?;
            let entries = statement.query_map([], |row| Ok(serde_json::json!({
                "legacyTime":row.get::<_,String>(0)?,"level":row.get::<_,String>(1)?,"module":row.get::<_,String>(2)?,
                "tag":row.get::<_,String>(3)?,"message":row.get::<_,String>(4)?,"detail":row.get::<_,Option<String>>(5)?,"relatedId":row.get::<_,Option<String>>(6)?
            }))).map_err(|error|error.to_string())?;
            for entry in entries {
                crate::logging::write_legacy(&mut file, entry.map_err(|error| error.to_string())?)
                    .map_err(|error| error.to_string())?;
            }
            file.sync_all().map_err(|error| error.to_string())?;
            connection
                .execute_batch("DROP TABLE app_logs;")
                .map_err(|error| error.to_string())?;
            Ok(())
        })();
        if result.is_err() {
            // Keep a partial archive for diagnosis and the complete source table for retry.
            return result;
        }
        crate::logging::event(
            log::Level::Info,
            "database",
            "legacy_logs.archived",
            serde_json::json!({"archive":archive.file_name().and_then(|name|name.to_str())}),
        );
        Ok(())
    }

    #[cfg(test)]
    async fn in_memory() -> Result<Self, String> {
        let connection = Connection::open_in_memory().map_err(|error| error.to_string())?;
        configure_connection(&connection)?;
        migrate_schema(&connection)?;
        Ok(Self {
            connection: Arc::new(Mutex::new(connection)),
        })
    }

    pub(crate) async fn load_folders(&self) -> Result<Vec<LibraryFolder>, String> {
        let connection = self.lock()?;
        let mut statement = connection
            .prepare(
                "SELECT path, track_count, last_scanned_at, status, error
                 FROM library_folders ORDER BY path COLLATE NOCASE",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| {
                Ok(LibraryFolder {
                    path: row.get(0)?,
                    track_count: row.get(1)?,
                    last_scanned_at: row.get(2)?,
                    status: row.get(3)?,
                    error: row.get(4)?,
                })
            })
            .map_err(|error| error.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())
    }

    pub(crate) async fn load_plugin_records(&self) -> Result<Vec<PluginRecord>, String> {
        let connection = self.lock()?;
        let mut statement = connection
            .prepare(
                "SELECT p.id, p.manifest_json, p.enabled, p.metadata_enabled, p.lyrics_enabled, p.cover_enabled,
                        p.sort_order, p.metadata_sort_order, p.lyrics_sort_order, p.cover_sort_order, p.installed_at, p.updated_at,
                        COALESCE(s.values_json, '{}')
                 FROM source_plugins p
                 LEFT JOIN plugin_settings s ON s.plugin_id = p.id
                 ORDER BY p.sort_order, p.installed_at, p.id",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| {
                Ok(PluginRecord {
                    id: row.get(0)?,
                    manifest_json: row.get(1)?,
                    enabled: row.get::<_, i64>(2)? != 0,
                    metadata_enabled: row.get::<_, i64>(3)? != 0,
                    lyrics_enabled: row.get::<_, i64>(4)? != 0,
                    cover_enabled: row.get::<_, i64>(5)? != 0,
                    sort_order: row.get(6)?,
                    metadata_sort_order: row.get(7)?,
                    lyrics_sort_order: row.get(8)?,
                    cover_sort_order: row.get(9)?,
                    installed_at: row.get(10)?,
                    updated_at: row.get(11)?,
                    settings_json: row.get(12)?,
                })
            })
            .map_err(|error| error.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())
    }

    pub(crate) async fn load_plugin_record(
        &self,
        plugin_id: &str,
    ) -> Result<Option<PluginRecord>, String> {
        let connection = self.lock()?;
        connection
            .query_row(
                "SELECT p.id, p.manifest_json, p.enabled, p.metadata_enabled, p.lyrics_enabled, p.cover_enabled,
                        p.sort_order, p.metadata_sort_order, p.lyrics_sort_order, p.cover_sort_order, p.installed_at, p.updated_at,
                        COALESCE(s.values_json, '{}')
                 FROM source_plugins p
                 LEFT JOIN plugin_settings s ON s.plugin_id = p.id
                 WHERE p.id = ?1",
                params![plugin_id],
                |row| {
                    Ok(PluginRecord {
                        id: row.get(0)?,
                        manifest_json: row.get(1)?,
                        enabled: row.get::<_, i64>(2)? != 0,
                        metadata_enabled: row.get::<_, i64>(3)? != 0,
                        lyrics_enabled: row.get::<_, i64>(4)? != 0,
                        cover_enabled: row.get::<_, i64>(5)? != 0,
                        sort_order: row.get(6)?,
                        metadata_sort_order: row.get(7)?,
                        lyrics_sort_order: row.get(8)?,
                        cover_sort_order: row.get(9)?,
                        installed_at: row.get(10)?,
                        updated_at: row.get(11)?,
                        settings_json: row.get(12)?,
                    })
                },
            )
            .optional()
            .map_err(|error| error.to_string())
    }

    pub(crate) async fn upsert_plugin_record(
        &self,
        plugin_id: &str,
        manifest_json: &str,
        default_settings_json: &str,
    ) -> Result<PluginRecord, String> {
        {
            let mut connection = self.lock()?;
            let transaction = connection
                .transaction()
                .map_err(|error| error.to_string())?;
            let timestamp = now().to_string();
            let next_sort_order: i32 = transaction
                .query_row(
                    "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM source_plugins",
                    [],
                    |row| row.get(0),
                )
                .map_err(|error| error.to_string())?;
            transaction
                .execute(
                    "INSERT INTO source_plugins (
                        id, manifest_json, enabled, metadata_enabled, lyrics_enabled, cover_enabled,
                        sort_order, metadata_sort_order, lyrics_sort_order, cover_sort_order, installed_at, updated_at
                     ) VALUES (?1, ?2, 0, 0, 0, 0, ?3, ?3, ?3, ?3, ?4, ?4)
                     ON CONFLICT(id) DO UPDATE SET manifest_json = excluded.manifest_json, updated_at = excluded.updated_at",
                    params![plugin_id, manifest_json, next_sort_order, timestamp],
                )
                .map_err(|error| error.to_string())?;
            transaction
                .execute(
                    "INSERT INTO plugin_settings (plugin_id, values_json, updated_at)
                     VALUES (?1, ?2, ?3)
                     ON CONFLICT(plugin_id) DO NOTHING",
                    params![plugin_id, default_settings_json, timestamp],
                )
                .map_err(|error| error.to_string())?;
            transaction.commit().map_err(|error| error.to_string())?;
        }
        self.load_plugin_record(plugin_id)
            .await?
            .ok_or_else(|| "Installed plugin record was not found".to_string())
    }

    pub(crate) async fn set_plugin_source_enabled(
        &self,
        plugin_id: &str,
        source_kind: &str,
        enabled: bool,
    ) -> Result<(), String> {
        let column = plugin_source_column(source_kind, false)?;
        let connection = self.lock()?;
        // Aggregated is a shortcut for every capability. Categories otherwise
        // remain independent; the master flag only gates whether any can run.
        let sql = if source_kind == "aggregated" {
            "UPDATE source_plugins SET enabled = ?2, metadata_enabled = ?2, lyrics_enabled = ?2, cover_enabled = ?2, updated_at = ?3 WHERE id = ?1".to_string()
        } else {
            format!("UPDATE source_plugins SET {column} = ?2, enabled = CASE WHEN ?2 = 1 THEN 1 ELSE enabled END, updated_at = ?3 WHERE id = ?1")
        };
        let changed = connection
            .execute(
                &sql,
                params![plugin_id, i64::from(enabled), now().to_string()],
            )
            .map_err(|error| error.to_string())?;
        if changed == 1 {
            Ok(())
        } else {
            Err("Plugin was not found".to_string())
        }
    }

    pub(crate) async fn reorder_plugin_sources(
        &self,
        source_kind: &str,
        plugin_ids: &[String],
    ) -> Result<(), String> {
        let column = plugin_source_column(source_kind, true)?;
        let mut connection = self.lock()?;
        let transaction = connection
            .transaction()
            .map_err(|error| error.to_string())?;
        let unique = plugin_ids.iter().collect::<std::collections::HashSet<_>>();
        if unique.len() != plugin_ids.len() {
            return Err("Plugin priority contains duplicate ids".to_string());
        }
        for (order, plugin_id) in plugin_ids.iter().enumerate() {
            let changed = transaction
                .execute(
                    &format!(
                        "UPDATE source_plugins SET {column} = ?2, updated_at = ?3 WHERE id = ?1"
                    ),
                    params![plugin_id, order as i32, now().to_string()],
                )
                .map_err(|error| error.to_string())?;
            if changed != 1 {
                return Err(format!("Plugin was not found: {plugin_id}"));
            }
        }
        transaction.commit().map_err(|error| error.to_string())
    }

    pub(crate) async fn set_plugin_order(&self, plugin_ids: &[String]) -> Result<(), String> {
        let mut connection = self.lock()?;
        let transaction = connection
            .transaction()
            .map_err(|error| error.to_string())?;
        for (sort_order, plugin_id) in plugin_ids.iter().enumerate() {
            let changed = transaction
                .execute(
                    "UPDATE source_plugins SET sort_order = ?2, updated_at = ?3 WHERE id = ?1",
                    params![plugin_id, sort_order as i32, now().to_string()],
                )
                .map_err(|error| error.to_string())?;
            if changed != 1 {
                return Err(format!("Plugin was not found: {plugin_id}"));
            }
        }
        transaction.commit().map_err(|error| error.to_string())
    }

    pub(crate) async fn set_plugin_enabled(
        &self,
        plugin_id: &str,
        enabled: bool,
    ) -> Result<(), String> {
        let connection = self.lock()?;
        let changed = connection
            .execute(
                "UPDATE source_plugins SET enabled = ?2, metadata_enabled = ?2, lyrics_enabled = ?2, cover_enabled = ?2, updated_at = ?3 WHERE id = ?1",
                params![plugin_id, i64::from(enabled), now().to_string()],
            )
            .map_err(|error| error.to_string())?;
        if changed == 1 {
            Ok(())
        } else {
            Err("Plugin was not found".to_string())
        }
    }

    pub(crate) async fn save_plugin_settings(
        &self,
        plugin_id: &str,
        values_json: &str,
    ) -> Result<(), String> {
        serde_json::from_str::<serde_json::Value>(values_json)
            .map_err(|error| format!("Invalid plugin settings: {error}"))?;
        let connection = self.lock()?;
        connection
            .execute(
                "INSERT INTO plugin_settings (plugin_id, values_json, updated_at)
                 VALUES (?1, ?2, ?3)
                 ON CONFLICT(plugin_id) DO UPDATE SET values_json = excluded.values_json, updated_at = excluded.updated_at",
                params![plugin_id, values_json, now().to_string()],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    pub(crate) async fn delete_plugin_record(&self, plugin_id: &str) -> Result<(), String> {
        let connection = self.lock()?;
        connection
            .execute(
                "DELETE FROM source_plugins WHERE id = ?1",
                params![plugin_id],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    pub(crate) fn load_tracks_blocking(&self) -> Result<Vec<AudioTrack>, String> {
        let connection = self.lock()?;
        let mut statement = connection
            .prepare(
                "SELECT path, file_name, title, artist, album, album_artist, genre,
                        track_number, disc_number, year, duration_seconds, format, bitrate,
                        sample_rate, channels, has_lyrics, has_cover,
                        replay_gain_track_gain, replay_gain_track_peak,
                        replay_gain_album_gain, replay_gain_album_peak,
                        modified_at, added_at, created_at
                 FROM songs
                 ORDER BY album COLLATE NOCASE, disc_number, track_number, title COLLATE NOCASE",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], map_audio_track)
            .map_err(|error| error.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())
    }

    pub(crate) fn load_cover_previews(
        &self,
        paths: &[String],
        artwork: bool,
    ) -> Result<HashMap<String, String>, String> {
        if paths.is_empty() {
            return Ok(HashMap::new());
        }
        let connection = self.lock()?;
        let placeholders = paths.iter().map(|_| "?").collect::<Vec<_>>().join(",");
        let column = if artwork {
            "cover_artwork_data_url"
        } else {
            "cover_thumbnail_data_url"
        };
        let query = format!("SELECT path, {column} FROM songs WHERE path IN ({placeholders}) AND {column} IS NOT NULL");
        let mut statement = connection
            .prepare(&query)
            .map_err(|error| error.to_string())?;
        let mut rows = statement
            .query(rusqlite::params_from_iter(paths))
            .map_err(|error| error.to_string())?;
        let mut thumbnails = HashMap::with_capacity(paths.len());
        while let Some(row) = rows.next().map_err(|error| error.to_string())? {
            let data_url = row
                .get::<_, Option<String>>(1)
                .map_err(|error| error.to_string())?;
            if let Some(data_url) = data_url {
                thumbnails.insert(
                    row.get::<_, String>(0).map_err(|error| error.to_string())?,
                    data_url,
                );
            }
        }
        Ok(thumbnails)
    }

    pub(crate) fn save_cover_previews(
        &self,
        thumbnails: &[(String, String)],
        artwork: bool,
    ) -> Result<(), String> {
        if thumbnails.is_empty() {
            return Ok(());
        }
        let connection = self.lock()?;
        let column = if artwork {
            "cover_artwork_data_url"
        } else {
            "cover_thumbnail_data_url"
        };
        for (path, data_url) in thumbnails {
            connection
                .execute(
                    &format!("UPDATE songs SET {column} = ?2, updated_at = ?3 WHERE path = ?1"),
                    params![path, data_url, as_i64(now())],
                )
                .map_err(|error| error.to_string())?;
        }
        Ok(())
    }

    pub(crate) async fn load_tracks_by_paths(
        &self,
        paths: &[String],
    ) -> Result<Vec<AudioTrack>, String> {
        if paths.is_empty() {
            return Ok(Vec::new());
        }
        let connection = self.lock()?;
        let mut tracks = Vec::with_capacity(paths.len());
        for chunk in paths.chunks(400) {
            let placeholders = (1..=chunk.len())
                .map(|index| format!("?{index}"))
                .collect::<Vec<_>>()
                .join(", ");
            let sql = format!(
                "SELECT path, file_name, title, artist, album, album_artist, genre,
                        track_number, disc_number, year, duration_seconds, format, bitrate,
                        sample_rate, channels, has_lyrics, has_cover,
                        replay_gain_track_gain, replay_gain_track_peak,
                        replay_gain_album_gain, replay_gain_album_peak,
                        modified_at, added_at, created_at
                 FROM songs WHERE path IN ({placeholders})"
            );
            let parameters = chunk
                .iter()
                .map(|path| path as &dyn ToSql)
                .collect::<Vec<_>>();
            let mut statement = connection
                .prepare(&sql)
                .map_err(|error| error.to_string())?;
            let rows = statement
                .query_map(parameters.as_slice(), map_audio_track)
                .map_err(|error| error.to_string())?;
            for row in rows {
                tracks.push(row.map_err(|error| error.to_string())?);
            }
        }
        Ok(tracks)
    }

    pub(crate) async fn load_folder_index(
        &self,
        folder_path: &str,
        scan_signature: &str,
    ) -> Result<HashMap<String, IndexedTrack>, String> {
        let connection = self.lock()?;
        let folder_path = resolve_folder_path(&connection, folder_path)?;
        let stored_signature = connection
            .query_row(
                "SELECT scan_signature FROM library_folders WHERE path = ?1",
                params![folder_path],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        if stored_signature.as_deref() != Some(scan_signature) {
            return Ok(HashMap::new());
        }
        let mut statement = connection
            .prepare(
                "SELECT path, file_name, title, artist, album, album_artist, genre,
                        track_number, disc_number, year, duration_seconds, format, bitrate,
                        sample_rate, channels, has_lyrics, has_cover,
                        replay_gain_track_gain, replay_gain_track_peak,
                        replay_gain_album_gain, replay_gain_album_peak,
                        modified_at, added_at, created_at, file_size, modified_at
                 FROM songs WHERE folder_path = ?1",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map(params![folder_path], |row| {
                let track = map_audio_track(row)?;
                let file_size = row
                    .get::<_, i64>(24)
                    .map(|value| u64::try_from(value).unwrap_or_default())?;
                let modified_at = row
                    .get::<_, i64>(25)
                    .map(|value| u64::try_from(value).unwrap_or_default())?;
                Ok(IndexedTrack {
                    track,
                    file_size,
                    modified_at,
                })
            })
            .map_err(|error| error.to_string())?;
        let mut index = HashMap::new();
        for row in rows {
            let indexed = row.map_err(|error| error.to_string())?;
            index.insert(indexed.track.path.clone(), indexed);
        }
        Ok(index)
    }

    pub(crate) async fn persist_folder_scan(
        &self,
        folder_path: &str,
        scan_signature: &str,
        tracks: &[AudioTrack],
    ) -> Result<(), String> {
        let mut connection = self.lock()?;
        let transaction = connection
            .transaction()
            .map_err(|error| error.to_string())?;
        let folder_path = resolve_folder_path(&transaction, folder_path)?;
        let previous_signature = transaction
            .query_row(
                "SELECT scan_signature FROM library_folders WHERE path = ?1",
                params![folder_path],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        let scanned_at = now().to_string();
        transaction
            .execute(
                "INSERT INTO library_folders (path, track_count, last_scanned_at, status, error, scan_signature)
                 VALUES (?1, ?2, ?3, 'ready', NULL, ?4)
                 ON CONFLICT(path) DO UPDATE SET
                   track_count = excluded.track_count,
                   last_scanned_at = excluded.last_scanned_at,
                   status = 'ready', error = NULL,
                   scan_signature = excluded.scan_signature",
                params![folder_path, tracks.len() as u32, scanned_at, scan_signature],
            )
            .map_err(|error| error.to_string())?;
        let existing = load_folder_song_fingerprints(&transaction, &folder_path)?;
        let mut seen = std::collections::HashSet::with_capacity(tracks.len());
        for track in tracks {
            seen.insert(track.path.clone());
            if previous_signature.as_deref() == Some(scan_signature) {
                if let Some((file_size, modified_at)) = existing.get(&track.path) {
                    let metadata = fs::metadata(&track.path).ok();
                    let current_size = metadata.as_ref().map_or(0, fs::Metadata::len);
                    let current_modified = metadata
                        .and_then(|metadata| metadata.modified().ok())
                        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
                        .map_or(0, |duration| duration.as_secs());
                    if *file_size == current_size && *modified_at == current_modified {
                        continue;
                    }
                }
            }
            upsert_track(&transaction, &folder_path, track)?;
        }
        for path in existing.keys().filter(|path| !seen.contains(path.as_str())) {
            transaction
                .execute("DELETE FROM songs WHERE path = ?1", params![path])
                .map_err(|error| error.to_string())?;
        }
        transaction.commit().map_err(|error| error.to_string())
    }

    pub(crate) async fn update_track_summary(&self, track: &AudioTrack) -> Result<(), String> {
        let mut connection = self.lock()?;
        let transaction = connection
            .transaction()
            .map_err(|error| error.to_string())?;
        let folder_path = transaction
            .query_row(
                "SELECT folder_path FROM songs WHERE path = ?1",
                params![track.path],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        if let Some(folder_path) = folder_path {
            upsert_track(&transaction, &folder_path, track)?;
        }
        transaction.commit().map_err(|error| error.to_string())
    }

    pub(crate) async fn update_renamed_track_summary(
        &self,
        previous_path: &str,
        track: &AudioTrack,
    ) -> Result<(), String> {
        let mut connection = self.lock()?;
        let transaction = connection
            .transaction()
            .map_err(|error| error.to_string())?;
        let (folder_path, previous_added_at) = transaction
            .query_row(
                "SELECT folder_path, added_at FROM songs WHERE path = ?1",
                params![previous_path],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
            )
            .optional()
            .map_err(|error| error.to_string())?
            .ok_or_else(|| format!("Renamed library track was not found: {previous_path}"))?;
        transaction
            .execute("DELETE FROM songs WHERE path = ?1", params![previous_path])
            .map_err(|error| error.to_string())?;
        upsert_track(&transaction, &folder_path, track)?;
        if previous_added_at > 0 {
            transaction
                .execute(
                    "UPDATE songs SET added_at = ?2 WHERE path = ?1",
                    params![track.path, previous_added_at],
                )
                .map_err(|error| error.to_string())?;
        }
        transaction.commit().map_err(|error| error.to_string())
    }

    pub(crate) async fn load_track_timestamps(
        &self,
        path: &str,
    ) -> Result<(Option<u64>, Option<u64>), String> {
        let connection = self.lock()?;
        connection
            .query_row(
                "SELECT modified_at, added_at FROM songs WHERE path = ?1",
                params![path],
                |row| {
                    let modified_at: i64 = row.get(0)?;
                    let added_at: i64 = row.get(1)?;
                    Ok((stored_time(modified_at), stored_time(added_at)))
                },
            )
            .optional()
            .map_err(|error| error.to_string())
            .map(|value| value.unwrap_or((None, None)))
    }

    pub(crate) async fn load_track_times_by_paths(
        &self,
        paths: &[String],
    ) -> Result<HashMap<String, (Option<u64>, Option<u64>)>, String> {
        if paths.is_empty() {
            return Ok(HashMap::new());
        }
        let connection = self.lock()?;
        let placeholders = paths.iter().map(|_| "?").collect::<Vec<_>>().join(",");
        let mut statement = connection
            .prepare(&format!(
                "SELECT path, added_at, modified_at FROM songs WHERE path IN ({placeholders})"
            ))
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map(rusqlite::params_from_iter(paths.iter()), |row| {
                let path: String = row.get(0)?;
                let added_at: i64 = row.get(1)?;
                let modified_at: i64 = row.get(2)?;
                Ok((path, stored_time(added_at), stored_time(modified_at)))
            })
            .map_err(|error| error.to_string())?;
        let mut result = HashMap::new();
        for row in rows {
            let (path, added_at, modified_at) = row.map_err(|error| error.to_string())?;
            result.insert(path, (added_at, modified_at));
        }
        Ok(result)
    }

    pub(crate) async fn create_batch_task(
        &self,
        task_type: &str,
        song_paths: &[String],
        config_json: Option<String>,
    ) -> Result<BatchTask, String> {
        if !BATCH_TASK_TYPES.contains(&task_type) {
            return Err("Unsupported batch task type".to_string());
        }
        if let Some(config) = config_json
            .as_deref()
            .filter(|value| !value.trim().is_empty())
        {
            serde_json::from_str::<serde_json::Value>(config)
                .map_err(|error| format!("Invalid batch task configuration: {error}"))?;
        }
        let unique_paths = deduplicate_song_paths(song_paths);
        if unique_paths.is_empty() {
            return Err("At least one song is required".to_string());
        }

        let timestamp = now().to_string();
        let task_id = format!(
            "batch-{}-{}",
            now_millis(),
            NEXT_BATCH_ID.fetch_add(1, Ordering::Relaxed)
        );
        let task = BatchTask {
            progress: 0.0,
            task_id: task_id.clone(),
            task_type: task_type.to_string(),
            status: "queued".to_string(),
            total: unique_paths.len() as u32,
            current: 0,
            success_count: 0,
            failure_count: 0,
            skipped_count: 0,
            config_json,
            started_at: None,
            finished_at: None,
            created_at: timestamp.clone(),
            updated_at: timestamp.clone(),
            error_message: None,
        };

        let mut connection = self.lock()?;
        let transaction = connection
            .transaction()
            .map_err(|error| error.to_string())?;
        transaction
            .execute(
                "INSERT INTO batch_tasks (
                    task_id, type, status, total, current, success_count, failure_count,
                    skipped_count, config_json, started_at, finished_at, created_at, updated_at, error_message
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
                params![
                    task.task_id,
                    task.task_type,
                    task.status,
                    task.total,
                    task.current,
                    task.success_count,
                    task.failure_count,
                    task.skipped_count,
                    task.config_json,
                    task.started_at,
                    task.finished_at,
                    task.created_at,
                    task.updated_at,
                    task.error_message,
                ],
            )
            .map_err(|error| error.to_string())?;
        for (index, path) in unique_paths.iter().enumerate() {
            let file_name = Path::new(path)
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or(path)
                .to_string();
            transaction
                .execute(
                    "INSERT INTO batch_task_items (
                        item_id, task_id, song_path, file_name, status, progress,
                        result_json, error_message, created_at, updated_at
                     ) VALUES (?1, ?2, ?3, ?4, 'queued', 0, NULL, NULL, ?5, ?5)",
                    params![
                        format!("{}-{index}", task.task_id),
                        task.task_id,
                        path,
                        file_name,
                        timestamp
                    ],
                )
                .map_err(|error| error.to_string())?;
        }
        transaction.commit().map_err(|error| error.to_string())?;
        Ok(task)
    }

    pub(crate) async fn load_batch_tasks(&self) -> Result<Vec<BatchTask>, String> {
        let connection = self.lock()?;
        let mut statement = connection
            .prepare(
                "SELECT task_id, type, status, total, current, success_count, failure_count,
                        skipped_count, config_json, started_at, finished_at, created_at,
                        updated_at, error_message,
                        (SELECT COALESCE(AVG(CASE WHEN status IN ('succeeded','failed','skipped','cancelled') THEN 1.0 ELSE COALESCE(progress,0.0) END),0.0) FROM batch_task_items WHERE task_id = batch_tasks.task_id)
                 FROM batch_tasks ORDER BY created_at DESC, task_id DESC",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], map_batch_task)
            .map_err(|error| error.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())
    }

    pub(crate) async fn remove_library_track(&self, path: &str) -> Result<(), String> {
        let mut connection = self.lock()?;
        let transaction = connection
            .transaction()
            .map_err(|error| error.to_string())?;
        let folder: Option<String> = transaction
            .query_row(
                "SELECT folder_path FROM songs WHERE path = ?1",
                params![path],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        transaction
            .execute("DELETE FROM songs WHERE path = ?1", params![path])
            .map_err(|error| error.to_string())?;
        if let Some(folder) = folder {
            transaction.execute("UPDATE library_folders SET track_count = (SELECT COUNT(*) FROM songs WHERE folder_path = ?1) WHERE path = ?1", params![folder])
                .map_err(|error| error.to_string())?;
        }
        transaction.commit().map_err(|error| error.to_string())
    }

    pub(crate) async fn delete_batch_tasks(&self, task_ids: &[String]) -> Result<(), String> {
        if task_ids.is_empty() {
            return Ok(());
        }
        let mut connection = self.lock()?;
        let transaction = connection
            .transaction()
            .map_err(|error| error.to_string())?;
        for task_id in task_ids {
            transaction
                .execute(
                    "DELETE FROM batch_tasks
                     WHERE task_id = ?1 AND status NOT IN ('queued', 'running')",
                    params![task_id],
                )
                .map_err(|error| error.to_string())?;
        }
        transaction.commit().map_err(|error| error.to_string())
    }

    pub(crate) async fn load_batch_task(&self, task_id: &str) -> Result<BatchTask, String> {
        let connection = self.lock()?;
        load_batch_task(&connection, task_id)
    }

    pub(crate) async fn recover_interrupted_batch_tasks(&self) -> Result<Vec<String>, String> {
        let mut connection = self.lock()?;
        let transaction = connection
            .transaction()
            .map_err(|error| error.to_string())?;
        let timestamp = now().to_string();
        transaction
            .execute(
                "UPDATE batch_task_items SET status = 'queued', progress = 0,
                    error_message = 'Recovered after application restart', updated_at = ?1
             WHERE status = 'running'",
                params![timestamp],
            )
            .map_err(|error| error.to_string())?;
        transaction
            .execute(
                "UPDATE batch_tasks SET status = 'queued', started_at = NULL, finished_at = NULL,
                    error_message = 'Recovered after application restart', updated_at = ?1
             WHERE status = 'running'",
                params![timestamp],
            )
            .map_err(|error| error.to_string())?;
        let task_ids = {
            let mut statement = transaction.prepare(
                "SELECT task_id FROM batch_tasks WHERE status = 'queued' ORDER BY created_at, task_id",
            ).map_err(|error| error.to_string())?;
            let rows = statement
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(|error| error.to_string())?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|error| error.to_string())?
        };
        transaction.commit().map_err(|error| error.to_string())?;
        Ok(task_ids)
    }

    pub(crate) async fn load_batch_task_items(
        &self,
        task_id: &str,
    ) -> Result<Vec<BatchTaskItem>, String> {
        let connection = self.lock()?;
        let mut statement = connection
            .prepare(
                "SELECT item_id, task_id, song_path, file_name, status, progress,
                        result_json, error_message, created_at, updated_at
                 FROM batch_task_items WHERE task_id = ?1 ORDER BY created_at, item_id",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map(params![task_id], map_batch_task_item)
            .map_err(|error| error.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())
    }

    pub(crate) async fn start_batch_task(&self, task_id: &str) -> Result<BatchTask, String> {
        let connection = self.lock()?;
        let timestamp = now().to_string();
        let changed = connection
            .execute(
                "UPDATE batch_tasks SET status = 'running', started_at = ?2, updated_at = ?2
                 WHERE task_id = ?1 AND status = 'queued'",
                params![task_id, timestamp],
            )
            .map_err(|error| error.to_string())?;
        if changed != 1 {
            return Err("Batch task is missing or no longer queued".to_string());
        }
        load_batch_task(&connection, task_id)
    }

    #[cfg(test)]
    pub(crate) async fn update_batch_task_item(
        &self,
        task_id: &str,
        item_id: &str,
        status: &str,
        progress: f64,
        error_message: Option<String>,
    ) -> Result<BatchTask, String> {
        if !["running", "succeeded", "failed", "skipped", "cancelled"].contains(&status) {
            return Err("Unsupported batch item status".to_string());
        }
        let mut connection = self.lock()?;
        let transaction = connection
            .transaction()
            .map_err(|error| error.to_string())?;
        let timestamp = now().to_string();
        let changed = transaction
            .execute(
                "UPDATE batch_task_items
                 SET status = ?3, progress = ?4, error_message = ?5, updated_at = ?6
                 WHERE task_id = ?1 AND item_id = ?2",
                params![
                    task_id,
                    item_id,
                    status,
                    progress.clamp(0.0, 1.0),
                    error_message,
                    timestamp
                ],
            )
            .map_err(|error| error.to_string())?;
        if changed != 1 {
            return Err("Batch task item was not found".to_string());
        }
        transaction
            .execute(
                "UPDATE batch_tasks SET
                    current = (SELECT count(*) FROM batch_task_items WHERE task_id = ?1 AND status IN ('succeeded','failed','skipped','cancelled')),
                    success_count = (SELECT count(*) FROM batch_task_items WHERE task_id = ?1 AND status = 'succeeded'),
                    failure_count = (SELECT count(*) FROM batch_task_items WHERE task_id = ?1 AND status = 'failed'),
                    skipped_count = (SELECT count(*) FROM batch_task_items WHERE task_id = ?1 AND status = 'skipped'),
                    updated_at = ?2
                 WHERE task_id = ?1 AND status = 'running'",
                params![task_id, timestamp],
            )
            .map_err(|error| error.to_string())?;
        transaction.commit().map_err(|error| error.to_string())?;
        load_batch_task(&connection, task_id)
    }

    pub(crate) async fn update_batch_task_item_result(
        &self,
        task_id: &str,
        item_id: &str,
        status: &str,
        progress: f64,
        result_json: Option<String>,
        error_message: Option<String>,
    ) -> Result<BatchTask, String> {
        if ![
            "queued",
            "running",
            "succeeded",
            "failed",
            "skipped",
            "cancelled",
        ]
        .contains(&status)
        {
            return Err("Unsupported batch item status".to_string());
        }
        let connection = self.lock()?;
        let timestamp = now().to_string();
        let changed = connection
            .execute(
                "UPDATE batch_task_items SET status = ?3, progress = ?4, result_json = ?5,
                    error_message = ?6, updated_at = ?7 WHERE task_id = ?1 AND item_id = ?2",
                params![
                    task_id,
                    item_id,
                    status,
                    progress.clamp(0.0, 1.0),
                    result_json,
                    error_message,
                    timestamp
                ],
            )
            .map_err(|error| error.to_string())?;
        if changed != 1 {
            return Err("Batch task item was not found".to_string());
        }
        connection.execute(
            "UPDATE batch_tasks SET
                current = (SELECT count(*) FROM batch_task_items WHERE task_id = ?1 AND status IN ('succeeded','failed','skipped','cancelled')),
                success_count = (SELECT count(*) FROM batch_task_items WHERE task_id = ?1 AND status = 'succeeded'),
                failure_count = (SELECT count(*) FROM batch_task_items WHERE task_id = ?1 AND status = 'failed'),
                skipped_count = (SELECT count(*) FROM batch_task_items WHERE task_id = ?1 AND status = 'skipped'),
                updated_at = ?2 WHERE task_id = ?1 AND status = 'running'",
            params![task_id, timestamp],
        ).map_err(|error| error.to_string())?;
        load_batch_task(&connection, task_id)
    }

    pub(crate) async fn cancel_pending_batch_items(
        &self,
        task_id: &str,
        reason: &str,
    ) -> Result<BatchTask, String> {
        let connection = self.lock()?;
        let timestamp = now().to_string();
        connection.execute(
            "UPDATE batch_task_items SET status = 'cancelled', error_message = ?2, updated_at = ?3
             WHERE task_id = ?1 AND status IN ('queued', 'running')",
            params![task_id, reason, timestamp],
        ).map_err(|error| error.to_string())?;
        connection.execute(
            "UPDATE batch_tasks SET current = total,
                success_count = (SELECT count(*) FROM batch_task_items WHERE task_id = ?1 AND status = 'succeeded'),
                failure_count = (SELECT count(*) FROM batch_task_items WHERE task_id = ?1 AND status = 'failed'),
                skipped_count = (SELECT count(*) FROM batch_task_items WHERE task_id = ?1 AND status = 'skipped'),
                updated_at = ?2 WHERE task_id = ?1 AND status = 'running'",
            params![task_id, timestamp],
        ).map_err(|error| error.to_string())?;
        load_batch_task(&connection, task_id)
    }

    pub(crate) async fn search_lyrics_lines(
        &self,
        query: &str,
        limit: u32,
    ) -> Result<Vec<LyricLineMatch>, String> {
        let tokens: Vec<String> = query
            .split_whitespace()
            .map(|token| token.to_lowercase())
            .filter(|token| !token.is_empty())
            .take(8)
            .collect();
        if tokens.is_empty() {
            return Ok(Vec::new());
        }
        let connection = self.lock()?;
        let mut bindings: Vec<Box<dyn ToSql>> = Vec::new();
        let mut conditions = Vec::new();
        for token in &tokens {
            conditions.push(format!("lyrics LIKE ?{} ESCAPE '\\'", bindings.len() + 1));
            bindings.push(Box::new(format!("%{}%", escape_like_pattern(token))));
        }
        let sql = format!(
            "SELECT path, title, artist, lyrics FROM songs
             WHERE has_lyrics = 1 AND {}
             ORDER BY album COLLATE NOCASE, disc_number, track_number, title COLLATE NOCASE
             LIMIT ?{}",
            conditions.join(" AND "),
            bindings.len() + 1
        );
        bindings.push(Box::new(limit.clamp(1, 200)));
        let parameters: Vec<&dyn ToSql> = bindings.iter().map(Box::as_ref).collect();
        let mut statement = connection
            .prepare(&sql)
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map(parameters.as_slice(), |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            })
            .map_err(|error| error.to_string())?;
        let mut matches = Vec::new();
        for row in rows {
            let (path, title, artist, lyrics) = row.map_err(|error| error.to_string())?;
            if let Some(matched_line) = first_matching_lyric_line(&lyrics, &tokens) {
                matches.push(LyricLineMatch {
                    path,
                    title,
                    artist,
                    matched_line,
                });
            }
        }
        Ok(matches)
    }

    pub(crate) async fn finish_batch_task(
        &self,
        task_id: &str,
        status: &str,
        error_message: Option<String>,
    ) -> Result<BatchTask, String> {
        if !["succeeded", "failed", "cancelled"].contains(&status) {
            return Err("Unsupported terminal batch task status".to_string());
        }
        let connection = self.lock()?;
        let timestamp = now().to_string();
        let changed = connection
            .execute(
                "UPDATE batch_tasks
                 SET status = ?2, finished_at = ?3, updated_at = ?3, error_message = ?4
                 WHERE task_id = ?1 AND status = 'running'",
                params![task_id, status, timestamp, error_message],
            )
            .map_err(|error| error.to_string())?;
        if changed != 1 {
            return Err("Batch task is missing or no longer running".to_string());
        }
        load_batch_task(&connection, task_id)
    }

    pub(crate) async fn upsert_folder(&self, folder: LibraryFolder) -> Result<(), String> {
        let connection = self.lock()?;
        let folder_path = resolve_folder_path(&connection, &folder.path)?;
        connection
            .execute(
                "INSERT INTO library_folders (path, track_count, last_scanned_at, status, error)
                 VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(path) DO UPDATE SET
                   track_count = excluded.track_count,
                   last_scanned_at = excluded.last_scanned_at,
                   status = excluded.status,
                   error = excluded.error",
                params![
                    folder_path,
                    folder.track_count,
                    folder.last_scanned_at,
                    folder.status,
                    folder.error
                ],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    pub(crate) async fn remove_folder(&self, path: &str) -> Result<(), String> {
        let mut connection = self.lock()?;
        let transaction = connection
            .transaction()
            .map_err(|error| error.to_string())?;
        let path = resolve_folder_path(&transaction, path)?;
        transaction
            .execute("DELETE FROM songs WHERE folder_path = ?1", params![path])
            .map_err(|error| error.to_string())?;
        transaction
            .execute("DELETE FROM library_folders WHERE path = ?1", params![path])
            .map_err(|error| error.to_string())?;
        transaction.commit().map_err(|error| error.to_string())
    }

    pub(crate) async fn load_legacy_setting(&self, key: &str) -> Result<Option<String>, String> {
        let connection = self.lock()?;
        connection
            .query_row(
                "SELECT value FROM settings WHERE key = ?1",
                params![key],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| error.to_string())
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, Connection>, String> {
        self.connection
            .lock()
            .map_err(|_| "Database lock was poisoned".to_string())
    }
}

fn configure_connection(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            "PRAGMA foreign_keys = ON;
             PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             PRAGMA busy_timeout = 5000;
             PRAGMA temp_store = MEMORY;",
        )
        .map_err(|error| error.to_string())
}

fn deduplicate_song_paths(song_paths: &[String]) -> Vec<String> {
    let mut unique_paths = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for path in song_paths
        .iter()
        .map(|path| path.trim())
        .filter(|path| !path.is_empty())
    {
        if seen.insert(batch_path_key(path)) {
            unique_paths.push(path.to_string());
        }
    }
    unique_paths
}

fn batch_path_key(path: &str) -> String {
    let normalized = path.replace('\\', "/");
    if cfg!(windows) {
        normalized.to_lowercase()
    } else {
        normalized.to_string()
    }
}

pub(crate) fn folder_path_key(path: &str) -> String {
    batch_path_key(path.trim_end_matches(['/', '\\']))
}

/// Keep the first stored spelling while matching directory aliases under one lock.
fn resolve_folder_path(connection: &Connection, path: &str) -> Result<String, String> {
    let key = folder_path_key(path);
    let mut statement = connection
        .prepare("SELECT path FROM library_folders ORDER BY path")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?;
    for row in rows {
        let stored = row.map_err(|error| error.to_string())?;
        if folder_path_key(&stored) == key {
            return Ok(stored);
        }
    }
    Ok(path.to_string())
}

/// Move songs before deleting legacy duplicate parents, so FK cascade loses no songs.
fn merge_legacy_folder_aliases(connection: &Connection) -> Result<(), String> {
    let transaction = connection
        .unchecked_transaction()
        .map_err(|error| error.to_string())?;
    let folders = {
        let mut statement = transaction
            .prepare("SELECT path FROM library_folders ORDER BY COALESCE(last_scanned_at, '') DESC, path")
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|error| error.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?
    };
    let mut canonical = HashMap::<String, String>::new();
    let mut merged = std::collections::HashSet::<String>::new();
    for path in folders {
        let key = folder_path_key(&path);
        if let Some(stored) = canonical.get(&key) {
            transaction
                .execute(
                    "UPDATE songs SET folder_path = ?1 WHERE folder_path = ?2",
                    params![stored, path],
                )
                .map_err(|error| error.to_string())?;
            transaction
                .execute("DELETE FROM library_folders WHERE path = ?1", params![path])
                .map_err(|error| error.to_string())?;
            merged.insert(stored.clone());
        } else {
            canonical.insert(key, path);
        }
    }
    for folder in merged {
        let songs = {
            let mut statement = transaction.prepare(
                "SELECT path FROM songs WHERE folder_path = ?1 ORDER BY CAST(updated_at AS INTEGER) DESC, path"
            ).map_err(|error| error.to_string())?;
            let rows = statement
                .query_map(params![folder], |row| row.get::<_, String>(0))
                .map_err(|error| error.to_string())?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|error| error.to_string())?
        };
        let mut unique = HashMap::<String, String>::new();
        for path in songs {
            if let Some(kept) = unique.get(&batch_path_key(&path)) {
                transaction.execute(
                    "UPDATE songs SET added_at = CASE WHEN added_at = 0 THEN (SELECT added_at FROM songs WHERE path = ?2)
                     WHEN (SELECT added_at FROM songs WHERE path = ?2) > 0 THEN MIN(added_at, (SELECT added_at FROM songs WHERE path = ?2))
                     ELSE added_at END WHERE path = ?1", params![kept, path]
                ).map_err(|error| error.to_string())?;
                transaction
                    .execute("DELETE FROM songs WHERE path = ?1", params![path])
                    .map_err(|error| error.to_string())?;
            } else {
                unique.insert(batch_path_key(&path), path);
            }
        }
        transaction.execute(
            "UPDATE library_folders SET track_count = (SELECT COUNT(*) FROM songs WHERE folder_path = ?1), scan_signature = '' WHERE path = ?1", params![folder]
        ).map_err(|error| error.to_string())?;
    }
    transaction.commit().map_err(|error| error.to_string())
}

fn map_batch_task(row: &Row<'_>) -> rusqlite::Result<BatchTask> {
    Ok(BatchTask {
        progress: row.get(14)?,
        task_id: row.get(0)?,
        task_type: row.get(1)?,
        status: row.get(2)?,
        total: row.get(3)?,
        current: row.get(4)?,
        success_count: row.get(5)?,
        failure_count: row.get(6)?,
        skipped_count: row.get(7)?,
        config_json: row.get(8)?,
        started_at: row.get(9)?,
        finished_at: row.get(10)?,
        created_at: row.get(11)?,
        updated_at: row.get(12)?,
        error_message: row.get(13)?,
    })
}

fn load_batch_task(connection: &Connection, task_id: &str) -> Result<BatchTask, String> {
    connection
        .query_row(
            "SELECT task_id, type, status, total, current, success_count, failure_count,
                    skipped_count, config_json, started_at, finished_at, created_at,
                    updated_at, error_message,
                    (SELECT COALESCE(AVG(CASE WHEN status IN ('succeeded','failed','skipped','cancelled') THEN 1.0 ELSE COALESCE(progress,0.0) END),0.0) FROM batch_task_items WHERE task_id = batch_tasks.task_id)
             FROM batch_tasks WHERE task_id = ?1",
            params![task_id],
            map_batch_task,
        )
        .map_err(|error| error.to_string())
}

fn map_batch_task_item(row: &Row<'_>) -> rusqlite::Result<BatchTaskItem> {
    Ok(BatchTaskItem {
        item_id: row.get(0)?,
        task_id: row.get(1)?,
        song_path: row.get(2)?,
        file_name: row.get(3)?,
        status: row.get(4)?,
        progress: row.get(5)?,
        result_json: row.get(6)?,
        error_message: row.get(7)?,
        created_at: row.get(8)?,
        updated_at: row.get(9)?,
    })
}

fn migrate_schema(connection: &Connection) -> Result<(), String> {
    let previous_version = connection
        .pragma_query_value(None, "user_version", |row| row.get::<_, u32>(0))
        .map_err(|error| error.to_string())?;
    connection
        .execute_batch(SCHEMA)
        .map_err(|error| error.to_string())?;
    add_column_if_missing(
        connection,
        "songs",
        "file_size",
        "INTEGER NOT NULL DEFAULT 0",
    )?;
    let source_columns = [
        ("metadata_enabled", "INTEGER NOT NULL DEFAULT 0"),
        ("lyrics_enabled", "INTEGER NOT NULL DEFAULT 0"),
        ("cover_enabled", "INTEGER NOT NULL DEFAULT 0"),
        ("metadata_sort_order", "INTEGER NOT NULL DEFAULT 0"),
        ("lyrics_sort_order", "INTEGER NOT NULL DEFAULT 0"),
        ("cover_sort_order", "INTEGER NOT NULL DEFAULT 0"),
    ];
    let had_source_categories = column_exists(connection, "source_plugins", "metadata_enabled")?;
    for (column, definition) in source_columns {
        add_column_if_missing(connection, "source_plugins", column, definition)?;
    }
    if !had_source_categories {
        connection
            .execute_batch(
                "UPDATE source_plugins SET
                    metadata_enabled = enabled,
                    lyrics_enabled = enabled,
                    cover_enabled = enabled,
                    metadata_sort_order = sort_order,
                    lyrics_sort_order = sort_order,
                    cover_sort_order = sort_order;",
            )
            .map_err(|error| error.to_string())?;
    }
    add_column_if_missing(
        connection,
        "songs",
        "modified_at",
        "INTEGER NOT NULL DEFAULT 0",
    )?;
    if !column_exists(connection, "songs", "added_at")? {
        connection
            .execute_batch(
                "ALTER TABLE songs ADD COLUMN added_at INTEGER NOT NULL DEFAULT 0;
                 UPDATE songs SET added_at = CAST(updated_at AS INTEGER) WHERE added_at = 0;",
            )
            .map_err(|error| error.to_string())?;
    }
    if !column_exists(connection, "songs", "created_at")? {
        connection
            .execute_batch("ALTER TABLE songs ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0;")
            .map_err(|error| error.to_string())?;
        backfill_created_at(connection)?;
    }
    add_column_if_missing(connection, "songs", "cover_artwork_data_url", "TEXT")?;
    add_column_if_missing(
        connection,
        "library_folders",
        "scan_signature",
        "TEXT NOT NULL DEFAULT ''",
    )?;
    if previous_version > 0 && previous_version < 5 {
        connection
            .execute("UPDATE songs SET cover_thumbnail_data_url = NULL", [])
            .map_err(|error| error.to_string())?;
    }
    if previous_version > 0 && previous_version < 7 {
        // Older scans never cached embedded lyrics. Invalidate fingerprints once.
        connection
            .execute("UPDATE library_folders SET scan_signature = ''", [])
            .map_err(|error| error.to_string())?;
    }
    if previous_version < 8 {
        merge_legacy_folder_aliases(connection)?;
    }
    connection
        .pragma_update(None, "user_version", DATABASE_SCHEMA_VERSION)
        .map_err(|error| error.to_string())
}

fn column_exists(connection: &Connection, table: &str, column: &str) -> Result<bool, String> {
    let mut statement = connection
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(|error| error.to_string())?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(columns.iter().any(|candidate| candidate == column))
}

fn add_column_if_missing(
    connection: &Connection,
    table: &str,
    column: &str,
    definition: &str,
) -> Result<(), String> {
    if !column_exists(connection, table, column)? {
        connection
            .execute_batch(&format!(
                "ALTER TABLE {table} ADD COLUMN {column} {definition}"
            ))
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn backfill_created_at(connection: &Connection) -> Result<(), String> {
    let mut statement = connection
        .prepare("SELECT path FROM songs WHERE created_at = 0")
        .map_err(|error| error.to_string())?;
    let paths = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    for path in paths {
        let created_at = fs::metadata(&path)
            .ok()
            .and_then(|metadata| metadata.created().ok())
            .and_then(|created| created.duration_since(UNIX_EPOCH).ok())
            .map_or(0, |duration| duration.as_secs());
        if created_at == 0 {
            continue;
        }
        connection
            .execute(
                "UPDATE songs SET created_at = ?2 WHERE path = ?1",
                params![path, as_i64(created_at)],
            )
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn upsert_track(
    transaction: &Transaction<'_>,
    folder_path: &str,
    track: &AudioTrack,
) -> Result<(), String> {
    let metadata = fs::metadata(&track.path).ok();
    let file_size = metadata.as_ref().map_or(0, fs::Metadata::len);
    let modified_at = metadata
        .as_ref()
        .and_then(|metadata| metadata.modified().ok())
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |duration| duration.as_secs());
    let created_at = metadata
        .and_then(|metadata| metadata.created().ok())
        .and_then(|created| created.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |duration| duration.as_secs());
    let added_at = track
        .added_at
        .filter(|value| *value > 0)
        .unwrap_or_else(now);
    transaction
        .execute(
            "INSERT INTO songs (
                id, path, folder_path, file_name, title, artist, album, album_artist, genre,
                track_number, disc_number, year, duration_seconds, format, bitrate, sample_rate,
                channels, has_lyrics, has_cover, replay_gain_track_gain, replay_gain_track_peak,
                replay_gain_album_gain, replay_gain_album_peak, file_size, modified_at, added_at,
                created_at, updated_at, lyrics
             ) VALUES (
                ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13,
                ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?28, ?29
             ) ON CONFLICT(path) DO UPDATE SET
                folder_path = excluded.folder_path, file_name = excluded.file_name,
                title = excluded.title, artist = excluded.artist, album = excluded.album,
                album_artist = excluded.album_artist, genre = excluded.genre,
                track_number = excluded.track_number, disc_number = excluded.disc_number,
                year = excluded.year, duration_seconds = excluded.duration_seconds,
                format = excluded.format, bitrate = excluded.bitrate,
                sample_rate = excluded.sample_rate, channels = excluded.channels,
                has_lyrics = excluded.has_lyrics, has_cover = excluded.has_cover, lyrics = excluded.lyrics,
                replay_gain_track_gain = excluded.replay_gain_track_gain,
                replay_gain_track_peak = excluded.replay_gain_track_peak,
                replay_gain_album_gain = excluded.replay_gain_album_gain,
                replay_gain_album_peak = excluded.replay_gain_album_peak,
                cover_thumbnail_data_url = NULL, cover_artwork_data_url = NULL,
                file_size = excluded.file_size, modified_at = excluded.modified_at,
                added_at = CASE WHEN added_at = 0 THEN excluded.added_at ELSE added_at END,
                created_at = CASE WHEN excluded.created_at > 0 THEN excluded.created_at ELSE created_at END,
                updated_at = excluded.updated_at",
            params![
                track.path,
                track.path,
                folder_path,
                track.file_name,
                track.title,
                track.artist,
                track.album,
                track.album_artist,
                track.genre,
                track.track_number,
                track.disc_number,
                track.year,
                as_i64(track.duration_seconds),
                track.format,
                track.bitrate,
                track.sample_rate,
                track.channels,
                track.has_lyrics,
                track.has_cover,
                track.replay_gain_track_gain,
                track.replay_gain_track_peak,
                track.replay_gain_album_gain,
                track.replay_gain_album_peak,
                as_i64(file_size),
                as_i64(modified_at),
                as_i64(added_at),
                as_i64(created_at),
                as_i64(now()),
                track.lyrics
            ],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn load_folder_song_fingerprints(
    transaction: &Transaction<'_>,
    folder_path: &str,
) -> Result<HashMap<String, (u64, u64)>, String> {
    let mut statement = transaction
        .prepare("SELECT path, file_size, modified_at FROM songs WHERE folder_path = ?1")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![folder_path], |row| {
            Ok((
                row.get::<_, String>(0)?,
                u64::try_from(row.get::<_, i64>(1)?).unwrap_or_default(),
                u64::try_from(row.get::<_, i64>(2)?).unwrap_or_default(),
            ))
        })
        .map_err(|error| error.to_string())?;
    let mut fingerprints = HashMap::new();
    for row in rows {
        let (path, file_size, modified_at) = row.map_err(|error| error.to_string())?;
        fingerprints.insert(path, (file_size, modified_at));
    }
    Ok(fingerprints)
}

fn map_audio_track(row: &Row<'_>) -> rusqlite::Result<AudioTrack> {
    let path: String = row.get(0)?;
    Ok(AudioTrack {
        id: path.clone(),
        path,
        file_name: row.get(1)?,
        title: row.get(2)?,
        artist: row.get(3)?,
        album: row.get(4)?,
        album_artist: row.get(5)?,
        genre: row.get(6)?,
        language: String::new(),
        composer: String::new(),
        lyricist: String::new(),
        copyright: String::new(),
        rating: None,
        comment: String::new(),
        lyrics: String::new(),
        track_number: row.get(7)?,
        disc_number: row.get(8)?,
        year: row.get(9)?,
        duration_seconds: row
            .get::<_, i64>(10)
            .map(|value| u64::try_from(value).unwrap_or_default())?,
        format: row.get(11)?,
        bitrate: row.get(12)?,
        sample_rate: row.get(13)?,
        channels: row.get(14)?,
        cover_data_url: None,
        has_lyrics: row.get(15)?,
        has_cover: row.get(16)?,
        replay_gain_track_gain: row.get(17)?,
        replay_gain_track_peak: row.get(18)?,
        replay_gain_album_gain: row.get(19)?,
        replay_gain_album_peak: row.get(20)?,
        replay_gain_reference_loudness: String::new(),
        modified_at: stored_time(row.get(21)?),
        added_at: stored_time(row.get(22)?),
        created_at: stored_time(row.get(23)?),
    })
}

fn stored_time(value: i64) -> Option<u64> {
    (value > 0).then(|| u64::try_from(value).unwrap_or_default())
}

fn escape_like_pattern(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

fn first_matching_lyric_line(lyrics: &str, tokens: &[String]) -> Option<String> {
    for line in lyrics.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let haystack = trimmed.to_lowercase();
        if tokens.iter().all(|token| haystack.contains(token.as_str())) {
            return Some(trimmed.to_string());
        }
    }
    None
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| duration.as_secs())
}

fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn plugin_source_column(source_kind: &str, sort_order: bool) -> Result<&'static str, String> {
    match (source_kind, sort_order) {
        ("aggregated", false) => Ok("enabled"),
        ("metadata", false) => Ok("metadata_enabled"),
        ("lyrics", false) => Ok("lyrics_enabled"),
        ("covers", false) => Ok("cover_enabled"),
        ("aggregated", true) => Ok("sort_order"),
        ("metadata", true) => Ok("metadata_sort_order"),
        ("lyrics", true) => Ok("lyrics_sort_order"),
        ("covers", true) => Ok("cover_sort_order"),
        _ => Err(format!("Unsupported plugin source kind: {source_kind}")),
    }
}

fn as_i64(value: u64) -> i64 {
    i64::try_from(value).unwrap_or(i64::MAX)
}

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS library_folders (
    path TEXT PRIMARY KEY NOT NULL,
    track_count INTEGER NOT NULL DEFAULT 0,
    last_scanned_at TEXT,
    status TEXT NOT NULL DEFAULT 'ready' CHECK(status IN ('ready','scanning','error')),
    error TEXT,
    scan_signature TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS songs (
    id TEXT NOT NULL,
    path TEXT PRIMARY KEY NOT NULL,
    folder_path TEXT NOT NULL,
    file_name TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '', artist TEXT NOT NULL DEFAULT '',
    album TEXT NOT NULL DEFAULT '', album_artist TEXT NOT NULL DEFAULT '',
    genre TEXT NOT NULL DEFAULT '', comment TEXT NOT NULL DEFAULT '', lyrics TEXT NOT NULL DEFAULT '',
    track_number INTEGER, disc_number INTEGER, year TEXT NOT NULL DEFAULT '',
    duration_seconds INTEGER NOT NULL DEFAULT 0, format TEXT NOT NULL DEFAULT '',
    bitrate INTEGER, sample_rate INTEGER, channels INTEGER,
    cover_data_url TEXT, cover_thumbnail_data_url TEXT, cover_artwork_data_url TEXT,
    has_lyrics INTEGER NOT NULL DEFAULT 0, has_cover INTEGER NOT NULL DEFAULT 0,
    replay_gain_track_gain TEXT NOT NULL DEFAULT '', replay_gain_track_peak TEXT NOT NULL DEFAULT '',
    replay_gain_album_gain TEXT NOT NULL DEFAULT '', replay_gain_album_peak TEXT NOT NULL DEFAULT '',
    file_size INTEGER NOT NULL DEFAULT 0, modified_at INTEGER NOT NULL DEFAULT 0,
    added_at INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT '',
    FOREIGN KEY(folder_path) REFERENCES library_folders(path) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_songs_folder_path ON songs(folder_path);
CREATE INDEX IF NOT EXISTS idx_songs_fingerprint ON songs(path, file_size, modified_at);
CREATE INDEX IF NOT EXISTS idx_songs_album_order ON songs(album COLLATE NOCASE, disc_number, track_number, title COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_songs_artist_order ON songs(artist COLLATE NOCASE, album COLLATE NOCASE);
CREATE TABLE IF NOT EXISTS artists (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
    normalized_name TEXT NOT NULL UNIQUE, song_count INTEGER NOT NULL DEFAULT 0,
    album_count INTEGER NOT NULL DEFAULT 0, cover_song_path TEXT, updated_at TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS artist_song (
    artist_id INTEGER NOT NULL, song_path TEXT NOT NULL,
    PRIMARY KEY(artist_id, song_path),
    FOREIGN KEY(artist_id) REFERENCES artists(id) ON DELETE CASCADE,
    FOREIGN KEY(song_path) REFERENCES songs(path) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS albums (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
    album_artist TEXT NOT NULL DEFAULT '', normalized_key TEXT NOT NULL UNIQUE,
    song_count INTEGER NOT NULL DEFAULT 0, year TEXT, cover_song_path TEXT,
    updated_at TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS album_song (
    album_id INTEGER NOT NULL, song_path TEXT NOT NULL,
    PRIMARY KEY(album_id, song_path),
    FOREIGN KEY(album_id) REFERENCES albums(id) ON DELETE CASCADE,
    FOREIGN KEY(song_path) REFERENCES songs(path) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS source_plugins (
    id TEXT PRIMARY KEY, manifest_json TEXT NOT NULL DEFAULT '{}', enabled INTEGER NOT NULL DEFAULT 0,
    metadata_enabled INTEGER NOT NULL DEFAULT 0, lyrics_enabled INTEGER NOT NULL DEFAULT 0,
    cover_enabled INTEGER NOT NULL DEFAULT 0, sort_order INTEGER NOT NULL DEFAULT 0,
    metadata_sort_order INTEGER NOT NULL DEFAULT 0, lyrics_sort_order INTEGER NOT NULL DEFAULT 0,
    cover_sort_order INTEGER NOT NULL DEFAULT 0, installed_at TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS plugin_settings (
    plugin_id TEXT PRIMARY KEY, values_json TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL DEFAULT '',
    FOREIGN KEY(plugin_id) REFERENCES source_plugins(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS plugin_cache (
    plugin_id TEXT NOT NULL, cache_key TEXT NOT NULL, value TEXT NOT NULL,
    expires_at INTEGER, PRIMARY KEY(plugin_id, cache_key),
    FOREIGN KEY(plugin_id) REFERENCES source_plugins(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS batch_tasks (
    task_id TEXT PRIMARY KEY, type TEXT NOT NULL, status TEXT NOT NULL,
    total INTEGER NOT NULL DEFAULT 0, current INTEGER NOT NULL DEFAULT 0,
    success_count INTEGER NOT NULL DEFAULT 0, failure_count INTEGER NOT NULL DEFAULT 0,
    skipped_count INTEGER NOT NULL DEFAULT 0, config_json TEXT,
    started_at TEXT, finished_at TEXT, created_at TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT '', error_message TEXT
);
CREATE INDEX IF NOT EXISTS idx_batch_tasks_status ON batch_tasks(status, created_at);
CREATE TABLE IF NOT EXISTS batch_task_items (
    item_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, song_path TEXT NOT NULL,
    file_name TEXT NOT NULL, status TEXT NOT NULL, progress REAL,
    result_json TEXT, error_message TEXT, created_at TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT '',
    FOREIGN KEY(task_id) REFERENCES batch_tasks(task_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_batch_task_items_task ON batch_task_items(task_id, status);
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT ''
);
"#;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_logs_are_archived_before_table_removal_and_failed_export_keeps_rows() {
        tauri::async_runtime::block_on(async {
            let database = Database::in_memory().await.unwrap();
            database.lock().unwrap().execute_batch("CREATE TABLE app_logs(id INTEGER PRIMARY KEY,created_at TEXT,level TEXT,type TEXT,tag TEXT,message TEXT,detail TEXT,related_id TEXT); INSERT INTO app_logs VALUES(1,'1791580000','info','batch','BatchManager','Batch task finished','{\"configJson\":\"secret\"}','task-1');").unwrap();
            let directory = std::env::temp_dir().join(format!(
                "lyrico-legacy-log-test-{}-{}",
                std::process::id(),
                NEXT_BATCH_ID.fetch_add(1, Ordering::Relaxed)
            ));
            fs::write(&directory, "not a directory").unwrap();
            assert!(database.migrate_legacy_logs(&directory).await.is_err());
            let count: i64 = database
                .lock()
                .unwrap()
                .query_row("SELECT count(*) FROM app_logs", [], |row| row.get(0))
                .unwrap();
            assert_eq!(count, 1);
            fs::remove_file(&directory).unwrap();
            database.migrate_legacy_logs(&directory).await.unwrap();
            assert!(database
                .lock()
                .unwrap()
                .prepare("SELECT * FROM app_logs")
                .is_err());
            let archive = fs::read_dir(&directory)
                .unwrap()
                .next()
                .unwrap()
                .unwrap()
                .path();
            let text = fs::read_to_string(archive).unwrap();
            assert!(text.contains("relatedId=task-1"));
            assert!(!text.starts_with('{'));
            assert!(!text.contains("secret"));
            database.migrate_legacy_logs(&directory).await.unwrap();
            assert_eq!(fs::read_dir(&directory).unwrap().count(), 1);
            fs::remove_dir_all(directory).unwrap();
        });
    }

    #[test]
    fn batch_song_paths_are_deduplicated_by_normalized_key() {
        let paths = vec![
            "C:\\Music\\Song.mp3".to_string(),
            "c:\\music\\SONG.MP3".to_string(),
            "C:/Music/Song.mp3".to_string(),
            "  C:\\Music\\Song.mp3  ".to_string(),
            String::new(),
            "   ".to_string(),
            "D:\\Music\\Other.mp3".to_string(),
        ];

        let unique = deduplicate_song_paths(&paths);

        let expected_count = if cfg!(windows) { 2 } else { 3 };
        assert_eq!(unique.len(), expected_count);
        assert_eq!(unique[0], "C:\\Music\\Song.mp3");
        assert_eq!(unique[unique.len() - 1], "D:\\Music\\Other.mp3");
        assert!(unique.iter().all(|path| !path.trim().is_empty()));
    }

    #[test]
    fn folder_aliases_share_storage_scan_and_removal() {
        tauri::async_runtime::block_on(async {
            let database = Database::in_memory().await.unwrap();
            database
                .upsert_folder(LibraryFolder {
                    path: "C:\\Music".into(),
                    track_count: 0,
                    last_scanned_at: None,
                    status: "ready".into(),
                    error: None,
                })
                .await
                .unwrap();
            let track = sample_track("C:\\Music\\one.flac", "one.flac");
            database
                .persist_folder_scan("C:/Music/", "test", &[track])
                .await
                .unwrap();
            let folders = database.load_folders().await.unwrap();
            assert_eq!(folders.len(), 1);
            assert_eq!(folders[0].path, "C:\\Music");
            assert_eq!(folders[0].track_count, 1);
            assert_eq!(
                database
                    .load_folder_index("C:/Music/", "test")
                    .await
                    .unwrap()
                    .len(),
                1
            );
            database.remove_folder("C:/Music/").await.unwrap();
            assert!(database.load_folders().await.unwrap().is_empty());
            assert_eq!(
                database
                    .lock()
                    .unwrap()
                    .query_row("SELECT COUNT(*) FROM songs", [], |row| row.get::<_, i64>(0))
                    .unwrap(),
                0
            );
        });
    }

    #[test]
    fn migration_merges_folder_aliases_without_losing_unique_songs() {
        tauri::async_runtime::block_on(async {
            let database = Database::in_memory().await.unwrap();
            let connection = database.lock().unwrap();
            connection.execute_batch(
                r"INSERT INTO library_folders (path, last_scanned_at, track_count) VALUES ('C:\Music', '1', 2), ('C:/Music/', '2', 2);
                 INSERT INTO songs (id, path, folder_path, file_name, added_at, updated_at) VALUES
                   ('old', 'C:\Music\same.flac', 'C:\Music', 'same.flac', 10, '1'),
                   ('new', 'C:/Music/same.flac', 'C:/Music/', 'same.flac', 20, '2'),
                   ('unique', 'C:\Music\unique.flac', 'C:\Music', 'unique.flac', 15, '1');
                 PRAGMA user_version = 7;"
            ).unwrap();
            migrate_schema(&connection).unwrap();
            assert_eq!(
                connection
                    .query_row("SELECT COUNT(*) FROM library_folders", [], |row| row
                        .get::<_, i64>(0))
                    .unwrap(),
                1
            );
            assert_eq!(
                connection
                    .query_row("SELECT track_count FROM library_folders", [], |row| row
                        .get::<_, i64>(0))
                    .unwrap(),
                2
            );
            assert_eq!(
                connection
                    .query_row("SELECT COUNT(*) FROM songs", [], |row| row.get::<_, i64>(0))
                    .unwrap(),
                2
            );
            assert_eq!(
                connection
                    .query_row("SELECT added_at FROM songs WHERE id = 'new'", [], |row| row
                        .get::<_, i64>(0))
                    .unwrap(),
                10
            );
            assert_eq!(
                connection
                    .query_row(
                        "SELECT COUNT(*) FROM songs WHERE folder_path = 'C:/Music/'",
                        [],
                        |row| row.get::<_, i64>(0)
                    )
                    .unwrap(),
                2
            );
            migrate_schema(&connection).unwrap();
            assert_eq!(
                connection
                    .query_row("SELECT COUNT(*) FROM songs", [], |row| row.get::<_, i64>(0))
                    .unwrap(),
                2
            );
        });
    }

    #[test]
    fn schema_and_basic_repository_round_trip() {
        tauri::async_runtime::block_on(async {
            let database = Database::in_memory()
                .await
                .expect("database should initialize");
            database
                .upsert_folder(LibraryFolder {
                    path: "C:\\Music".to_string(),
                    track_count: 0,
                    last_scanned_at: None,
                    status: "ready".to_string(),
                    error: None,
                })
                .await
                .expect("folder should be saved");
            let folders = database.load_folders().await.expect("folders should load");
            assert_eq!(folders.len(), 1);
            assert_eq!(folders[0].path, "C:\\Music");
        });
    }

    #[test]
    fn plugin_source_switches_and_priorities_are_independent() {
        tauri::async_runtime::block_on(async {
            let database = Database::in_memory().await.unwrap();
            database
                .upsert_plugin_record("com.example.one", "{}", "{}")
                .await
                .unwrap();
            database
                .upsert_plugin_record("com.example.two", "{}", "{}")
                .await
                .unwrap();
            database
                .set_plugin_source_enabled("com.example.one", "lyrics", true)
                .await
                .unwrap();
            database
                .reorder_plugin_sources(
                    "lyrics",
                    &["com.example.two".into(), "com.example.one".into()],
                )
                .await
                .unwrap();

            let records = database.load_plugin_records().await.unwrap();
            let one = records
                .iter()
                .find(|record| record.id == "com.example.one")
                .unwrap();
            let two = records
                .iter()
                .find(|record| record.id == "com.example.two")
                .unwrap();
            assert!(one.enabled);
            assert!(one.lyrics_enabled);
            assert!(!one.metadata_enabled);
            assert_eq!(two.lyrics_sort_order, 0);
            assert_eq!(one.lyrics_sort_order, 1);
            assert_eq!(one.metadata_sort_order, 0);
            database
                .set_plugin_source_enabled("com.example.one", "lyrics", false)
                .await
                .unwrap();
            let one = database
                .load_plugin_record("com.example.one")
                .await
                .unwrap()
                .unwrap();
            assert!(!one.lyrics_enabled);
            assert!(!one.metadata_enabled);
            assert!(!one.cover_enabled);
        });
    }

    #[test]
    fn plugin_source_migration_preserves_legacy_enabled_state_and_order() {
        let connection = Connection::open_in_memory().unwrap();
        configure_connection(&connection).unwrap();
        connection.execute_batch(
            "CREATE TABLE source_plugins (
                id TEXT PRIMARY KEY, manifest_json TEXT NOT NULL DEFAULT '{}',
                enabled INTEGER NOT NULL DEFAULT 0, sort_order INTEGER NOT NULL DEFAULT 0,
                installed_at TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT ''
             );
             INSERT INTO source_plugins (id, enabled, sort_order) VALUES ('com.example.legacy', 1, 7);"
        ).unwrap();

        migrate_schema(&connection).unwrap();

        let values: (i64, i64, i64, i32, i32, i32) = connection
            .query_row(
                "SELECT metadata_enabled, lyrics_enabled, cover_enabled,
                    metadata_sort_order, lyrics_sort_order, cover_sort_order
             FROM source_plugins WHERE id = 'com.example.legacy'",
                [],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!(values, (1, 1, 1, 7, 7, 7));
    }

    #[test]
    fn added_at_backfills_from_updated_at_for_legacy_songs() {
        let connection = Connection::open_in_memory().unwrap();
        configure_connection(&connection).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE songs (
                    id TEXT NOT NULL, path TEXT PRIMARY KEY NOT NULL,
                    folder_path TEXT NOT NULL, file_name TEXT NOT NULL,
                    title TEXT NOT NULL DEFAULT '', artist TEXT NOT NULL DEFAULT '',
                    album TEXT NOT NULL DEFAULT '', track_number INTEGER,
                    disc_number INTEGER, file_size INTEGER NOT NULL DEFAULT 0,
                    modified_at INTEGER NOT NULL DEFAULT 0,
                    updated_at TEXT NOT NULL DEFAULT ''
                 );
                 INSERT INTO songs (id, path, folder_path, file_name, updated_at)
                 VALUES ('a', 'C:\\Music\\a.flac', 'C:\\Music', 'a.flac', '1700000000');
                 INSERT INTO songs (id, path, folder_path, file_name, updated_at)
                 VALUES ('b', 'C:\\Music\\b.flac', 'C:\\Music', 'b.flac', '');",
            )
            .unwrap();

        migrate_schema(&connection).unwrap();

        let added_times: Vec<(String, i64)> = connection
            .prepare("SELECT path, added_at FROM songs ORDER BY path")
            .unwrap()
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        assert_eq!(
            added_times,
            vec![
                ("C:\\Music\\a.flac".to_string(), 1_700_000_000),
                ("C:\\Music\\b.flac".to_string(), 0),
            ]
        );

        migrate_schema(&connection).unwrap();
        let version: u32 = connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, DATABASE_SCHEMA_VERSION);
    }

    #[test]
    fn created_at_backfills_from_filesystem_for_legacy_songs() {
        let connection = Connection::open_in_memory().unwrap();
        configure_connection(&connection).unwrap();
        let file_path = std::env::temp_dir().join("lyrico_created_at_backfill.flac");
        std::fs::write(&file_path, b"placeholder").expect("temporary file should be written");
        let expected = file_path
            .metadata()
            .expect("temporary metadata should exist")
            .created()
            .expect("created time should exist")
            .duration_since(std::time::UNIX_EPOCH)
            .expect("created time should be valid")
            .as_secs();
        let path_text = file_path.to_string_lossy().to_string();
        connection
            .execute_batch(&format!(
                "CREATE TABLE songs (
                    id TEXT NOT NULL, path TEXT PRIMARY KEY NOT NULL,
                    folder_path TEXT NOT NULL, file_name TEXT NOT NULL,
                    title TEXT NOT NULL DEFAULT '', artist TEXT NOT NULL DEFAULT '',
                    album TEXT NOT NULL DEFAULT '', track_number INTEGER,
                    disc_number INTEGER, file_size INTEGER NOT NULL DEFAULT 0,
                    modified_at INTEGER NOT NULL DEFAULT 0,
                    updated_at TEXT NOT NULL DEFAULT ''
                 );
                 INSERT INTO songs (id, path, folder_path, file_name, updated_at)
                 VALUES ('a', '{path_text}', 'C:\\\\Music', 'a.flac', '1700000000');"
            ))
            .unwrap();

        migrate_schema(&connection).unwrap();

        let created_at: i64 = connection
            .query_row("SELECT created_at FROM songs", [], |row| row.get(0))
            .unwrap();
        assert_eq!(created_at as u64, expected);

        let column: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('songs') WHERE name = 'created_at'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(column, 1);

        let _ = std::fs::remove_file(file_path);
    }

    #[test]
    fn added_at_survives_rescans_and_summary_updates() {
        tauri::async_runtime::block_on(async {
            let database = Database::in_memory().await.expect("database should open");
            let track = sample_track("C:\\Music\\kept.flac", "kept.flac");
            database
                .persist_folder_scan("C:\\Music", "test", std::slice::from_ref(&track))
                .await
                .expect("initial scan should persist");
            let (_, added_at) = database
                .load_track_timestamps(&track.path)
                .await
                .expect("timestamps should load");
            assert!(added_at.is_some());

            let mut rescan = track.clone();
            rescan.added_at = None;
            database
                .persist_folder_scan("C:\\Music", "test", std::slice::from_ref(&rescan))
                .await
                .expect("rescan should persist");

            let mut edited = track.clone();
            edited.added_at = None;
            edited.title = "Edited title".to_string();
            database
                .update_track_summary(&edited)
                .await
                .expect("summary should update");

            let (modified_at, added_after) = database
                .load_track_timestamps(&track.path)
                .await
                .expect("timestamps should reload");
            assert_eq!(added_after, added_at);
            assert_eq!(modified_at, None);

            let tracks = database.load_tracks_blocking().expect("tracks should load");
            let stored = tracks
                .iter()
                .find(|item| item.path == track.path)
                .expect("track should exist");
            assert_eq!(stored.added_at, added_at);
            assert_eq!(stored.title, "Edited title");
        });
    }

    #[test]
    fn database_uses_wal_and_foreign_keys() {
        tauri::async_runtime::block_on(async {
            let database = Database::in_memory()
                .await
                .expect("database should initialize");
            let connection = database.lock().expect("database should lock");
            let foreign_keys: i64 = connection
                .pragma_query_value(None, "foreign_keys", |row| row.get(0))
                .expect("foreign key pragma should be readable");
            assert_eq!(foreign_keys, 1);
            let version: u32 = connection
                .pragma_query_value(None, "user_version", |row| row.get(0))
                .expect("schema version should be readable");
            assert_eq!(version, DATABASE_SCHEMA_VERSION);
        });
    }

    #[test]
    fn cover_cache_is_invalidated_when_thumbnail_resolution_changes() {
        let connection = Connection::open_in_memory().unwrap();
        configure_connection(&connection).unwrap();
        migrate_schema(&connection).unwrap();
        connection
            .execute(
                "INSERT INTO library_folders (path) VALUES (?1)",
                ["C:\\Music"],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO songs (id, path, folder_path, file_name, cover_thumbnail_data_url) VALUES (?1, ?2, ?3, ?4, ?5)",
                params!["cover", "C:\\Music\\cover.flac", "C:\\Music", "cover.flac", "data:image/jpeg;base64,legacy"],
            )
            .unwrap();
        connection.pragma_update(None, "user_version", 3).unwrap();

        migrate_schema(&connection).unwrap();

        let cached: Option<String> = connection
            .query_row(
                "SELECT cover_thumbnail_data_url FROM songs WHERE path = ?1",
                ["C:\\Music\\cover.flac"],
                |row| row.get(0),
            )
            .unwrap();
        assert!(cached.is_none());
    }

    #[test]
    fn batch_task_repository_creates_deduplicated_item_snapshot() {
        tauri::async_runtime::block_on(async {
            let database = Database::in_memory()
                .await
                .expect("database should initialize");
            let task = database
                .create_batch_task(
                    "exportLyrics",
                    &[
                        "C:\\Music\\first.flac".to_string(),
                        "C:\\Music\\first.flac".to_string(),
                        "C:\\Music\\second.mp3".to_string(),
                    ],
                    Some(r#"{"destination":"C:\\Lyrics"}"#.to_string()),
                )
                .await
                .expect("batch task should be created");
            assert_eq!(task.status, "queued");
            assert_eq!(task.total, 2);

            let tasks = database
                .load_batch_tasks()
                .await
                .expect("tasks should load");
            assert_eq!(tasks.len(), 1);
            assert_eq!(tasks[0].task_id, task.task_id);

            let items = database
                .load_batch_task_items(&task.task_id)
                .await
                .expect("task items should load");
            assert_eq!(items.len(), 2);
            assert!(items.iter().all(|item| item.status == "queued"));
            assert_eq!(items[0].file_name, "first.flac");
            assert_eq!(items[1].file_name, "second.mp3");

            let running = database
                .start_batch_task(&task.task_id)
                .await
                .expect("task should start");
            assert_eq!(running.status, "running");
            let partial = database
                .update_batch_task_item_result(
                    &task.task_id,
                    &items[0].item_id,
                    "running",
                    0.5,
                    None,
                    None,
                )
                .await
                .unwrap();
            assert_eq!(partial.current, 0);
            assert_eq!(partial.progress, 0.25);
            let after_success = database
                .update_batch_task_item(&task.task_id, &items[0].item_id, "succeeded", 1.0, None)
                .await
                .expect("first item should finish");
            assert_eq!(after_success.current, 1);
            assert_eq!(after_success.success_count, 1);
            assert_eq!(after_success.progress, 0.5);
            let after_skip = database
                .update_batch_task_item(
                    &task.task_id,
                    &items[1].item_id,
                    "skipped",
                    1.0,
                    Some("ReplayGain already exists".to_string()),
                )
                .await
                .expect("second item should skip");
            assert_eq!(after_skip.current, 2);
            assert_eq!(after_skip.skipped_count, 1);
            let finished = database
                .finish_batch_task(&task.task_id, "succeeded", None)
                .await
                .expect("task should finish");
            assert_eq!(finished.status, "succeeded");
            assert!(finished.finished_at.is_some());
        });
    }

    #[test]
    fn batch_task_repository_rejects_invalid_type_and_config() {
        tauri::async_runtime::block_on(async {
            let database = Database::in_memory()
                .await
                .expect("database should initialize");
            assert!(database
                .create_batch_task("unknown", &["song.flac".to_string()], None)
                .await
                .is_err());
            assert!(database
                .create_batch_task(
                    "replayGain",
                    &["song.flac".to_string()],
                    Some("not-json".to_string()),
                )
                .await
                .is_err());
        });
    }

    #[test]
    fn plugin_order_can_be_reordered_and_is_persisted() {
        tauri::async_runtime::block_on(async {
            let database = Database::in_memory().await.expect("database should open");
            database
                .upsert_plugin_record("plugin.a", "{}", "{}")
                .await
                .expect("first plugin should save");
            database
                .upsert_plugin_record("plugin.b", "{}", "{}")
                .await
                .expect("second plugin should save");

            database
                .set_plugin_order(&["plugin.b".to_string(), "plugin.a".to_string()])
                .await
                .expect("plugin order should save");

            let records = database
                .load_plugin_records()
                .await
                .expect("plugin records should load");
            assert_eq!(records[0].id, "plugin.b");
            assert_eq!(records[1].id, "plugin.a");
        });
    }

    #[test]
    fn batch_task_repository_deletes_finished_tasks_but_keeps_active_tasks() {
        tauri::async_runtime::block_on(async {
            let database = Database::in_memory().await.expect("database should open");
            let active = database
                .create_batch_task("replayGain", &["active.flac".to_string()], None)
                .await
                .expect("active task should be created");
            let finished = database
                .create_batch_task("replayGain", &["finished.flac".to_string()], None)
                .await
                .expect("finished task should be created");
            database
                .start_batch_task(&finished.task_id)
                .await
                .expect("finished task should start");
            database
                .finish_batch_task(&finished.task_id, "succeeded", None)
                .await
                .expect("finished task should finish");

            database
                .delete_batch_tasks(&[active.task_id.clone(), finished.task_id.clone()])
                .await
                .expect("finished task deletion should succeed");

            let tasks = database
                .load_batch_tasks()
                .await
                .expect("tasks should load");
            assert_eq!(tasks.len(), 1);
            assert_eq!(tasks[0].task_id, active.task_id);
        });
    }

    #[test]
    fn interrupted_batch_tasks_are_requeued_for_safe_recovery() {
        tauri::async_runtime::block_on(async {
            let database = Database::in_memory().await.expect("database should open");
            let task = database
                .create_batch_task(
                    "replayGain",
                    &["song.flac".to_string()],
                    Some(r#"{"concurrency":3}"#.to_string()),
                )
                .await
                .expect("task should be created");
            database
                .start_batch_task(&task.task_id)
                .await
                .expect("task should start");
            let item = database
                .load_batch_task_items(&task.task_id)
                .await
                .expect("items should load")
                .remove(0);
            database
                .update_batch_task_item(&task.task_id, &item.item_id, "running", 0.4, None)
                .await
                .expect("item should run");

            let recovered = database
                .recover_interrupted_batch_tasks()
                .await
                .expect("recovery should succeed");
            assert_eq!(recovered, vec![task.task_id.clone()]);
            let recovered_task = database
                .load_batch_task(&task.task_id)
                .await
                .expect("task should load");
            let recovered_item = database
                .load_batch_task_items(&task.task_id)
                .await
                .expect("items should load")
                .remove(0);
            assert_eq!(recovered_task.status, "queued");
            assert_eq!(recovered_item.status, "queued");
            assert_eq!(recovered_item.progress, Some(0.0));
            assert_eq!(
                recovered_item.error_message.as_deref(),
                Some("Recovered after application restart")
            );
        });
    }

    #[test]
    fn track_summary_updates_do_not_rebuild_unrelated_collection_rows() {
        tauri::async_runtime::block_on(async {
            let database = Database::in_memory().await.expect("database should open");
            let first = sample_track("C:\\Music\\first.flac", "first.flac");
            let second = sample_track("C:\\Music\\second.flac", "second.flac");
            database
                .persist_folder_scan("C:\\Music", "test", &[first.clone(), second])
                .await
                .expect("folder scan should persist");
            let artist_before =
                collection_ids(&database, "SELECT id FROM artists ORDER BY id").await;
            let album_before = collection_ids(&database, "SELECT id FROM albums ORDER BY id").await;

            let mut updated = first.clone();
            updated.title = "Updated title".to_string();
            database
                .update_track_summary(&updated)
                .await
                .expect("track summary should update");

            assert_eq!(
                collection_ids(&database, "SELECT id FROM artists ORDER BY id").await,
                artist_before
            );
            assert_eq!(
                collection_ids(&database, "SELECT id FROM albums ORDER BY id").await,
                album_before
            );
            let tracks = database.load_tracks_blocking().expect("tracks should load");
            assert_eq!(
                tracks
                    .iter()
                    .find(|track| track.path == first.path)
                    .unwrap()
                    .title,
                "Updated title"
            );
        });
    }

    #[test]
    fn repeated_folder_scan_keeps_unchanged_song_rows() {
        tauri::async_runtime::block_on(async {
            let database = Database::in_memory().await.expect("database should open");
            let kept = sample_track("C:\\Music\\kept.flac", "kept.flac");
            let removed = sample_track("C:\\Music\\removed.flac", "removed.flac");
            database
                .persist_folder_scan("C:\\Music", "test", &[kept.clone(), removed])
                .await
                .expect("initial scan should persist");
            let updated_before = song_updated_at(&database, &kept.path).await;
            std::thread::sleep(std::time::Duration::from_secs(1));

            database
                .persist_folder_scan("C:\\Music", "test", std::slice::from_ref(&kept))
                .await
                .expect("repeat scan should persist");

            assert_eq!(song_updated_at(&database, &kept.path).await, updated_before);
            assert!(song_updated_at(&database, "C:\\Music\\removed.flac")
                .await
                .is_none());
            let tracks = database.load_tracks_blocking().expect("tracks should load");
            assert_eq!(tracks.len(), 1);
        });
    }

    #[test]
    fn changed_scan_signature_rewrites_files_with_unchanged_fingerprints() {
        tauri::async_runtime::block_on(async {
            let database = Database::in_memory().await.expect("database should open");
            let track = sample_track("C:\\Music\\kept.flac", "kept.flac");
            database
                .persist_folder_scan("C:\\Music", "separator=/", std::slice::from_ref(&track))
                .await
                .expect("initial scan should persist");
            let mut retagged = track.clone();
            retagged.artist = "Split Artist".to_string();
            database
                .persist_folder_scan("C:\\Music", "separator=;", std::slice::from_ref(&retagged))
                .await
                .expect("signature change should persist");

            let tracks = database.load_tracks_blocking().expect("tracks should load");
            assert_eq!(tracks[0].artist, "Split Artist");
        });
    }

    async fn collection_ids(database: &Database, sql: &str) -> Vec<i64> {
        let connection = database.lock().expect("database lock should be available");
        let mut statement = connection.prepare(sql).expect("query should prepare");
        statement
            .query_map([], |row| row.get(0))
            .expect("query should run")
            .collect::<Result<Vec<_>, _>>()
            .expect("ids should read")
    }

    async fn song_updated_at(database: &Database, path: &str) -> Option<String> {
        let connection = database.lock().expect("database lock should be available");
        connection
            .query_row(
                "SELECT updated_at FROM songs WHERE path = ?1",
                params![path],
                |row| row.get(0),
            )
            .optional()
            .expect("song timestamp should query")
    }

    #[test]
    fn renamed_track_replaces_old_library_path_transactionally() {
        tauri::async_runtime::block_on(async {
            let database = Database::in_memory().await.expect("database should open");
            let old_path = "C:\\Music\\before.flac";
            let new_path = "C:\\Music\\after.flac";
            let old_track = sample_track(old_path, "before.flac");
            database
                .persist_folder_scan("C:\\Music", "test", std::slice::from_ref(&old_track))
                .await
                .expect("folder scan should persist");
            let mut renamed_track = old_track.clone();
            renamed_track.id = new_path.to_string();
            renamed_track.path = new_path.to_string();
            renamed_track.file_name = "after.flac".to_string();
            database
                .update_renamed_track_summary(old_path, &renamed_track)
                .await
                .expect("renamed path should be migrated");

            let tracks = database.load_tracks_blocking().expect("tracks should load");
            assert_eq!(tracks.len(), 1);
            assert_eq!(tracks[0].path, new_path);
            assert_eq!(tracks[0].file_name, "after.flac");
            assert!(database
                .update_renamed_track_summary(old_path, &renamed_track)
                .await
                .is_err());
        });
    }

    fn sample_track(path: &str, file_name: &str) -> AudioTrack {
        AudioTrack {
            id: path.to_string(),
            path: path.to_string(),
            file_name: file_name.to_string(),
            title: "Title".to_string(),
            artist: "Artist".to_string(),
            album: "Album".to_string(),
            album_artist: "Album Artist".to_string(),
            genre: "Pop".to_string(),
            language: String::new(),
            composer: String::new(),
            lyricist: String::new(),
            copyright: String::new(),
            rating: None,
            comment: String::new(),
            lyrics: String::new(),
            track_number: Some(1),
            disc_number: Some(1),
            year: "2026".to_string(),
            duration_seconds: 1,
            format: "FLAC".to_string(),
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

    #[test]
    fn lyric_line_matching_requires_every_token() {
        let lyrics = "[00:01.00] Hello World\n\n  Take on me  \n100% pure love";
        let tokens: Vec<String> = ["hello", "world"]
            .iter()
            .map(|token| token.to_string())
            .collect();
        assert_eq!(
            first_matching_lyric_line(lyrics, &tokens).as_deref(),
            Some("[00:01.00] Hello World")
        );

        let tokens: Vec<String> = ["take", "me"]
            .iter()
            .map(|token| token.to_string())
            .collect();
        assert_eq!(
            first_matching_lyric_line(lyrics, &tokens).as_deref(),
            Some("Take on me")
        );

        let tokens: Vec<String> = ["take", "zzz"]
            .iter()
            .map(|token| token.to_string())
            .collect();
        assert_eq!(first_matching_lyric_line(lyrics, &tokens), None);
        assert_eq!(escape_like_pattern("100%_a\\b"), "100\\%\\_a\\\\b");
    }
}
