//! All audio mutations share a canonical file lock. Tag writes use a sibling copy,
//! so a native save/validation failure cannot partially change the original.
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock, Weak};

pub(crate) fn with_file_lock<T>(
    path: &Path,
    operation: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    static LOCKS: OnceLock<Mutex<HashMap<PathBuf, Weak<Mutex<()>>>>> = OnceLock::new();
    let registry = LOCKS.get_or_init(Default::default);
    let slot = {
        let mut locks = registry
            .lock()
            .map_err(|_| "File lock registry was poisoned")?;
        locks.retain(|_, lock| lock.strong_count() > 0);
        let key = crate::path_access::path_key(path);
        let slot = locks
            .get(&key)
            .and_then(Weak::upgrade)
            .unwrap_or_else(|| Arc::new(Mutex::new(())));
        locks.insert(key, Arc::downgrade(&slot));
        slot
    };
    let _guard = slot.lock().map_err(|_| "Audio file lock was poisoned")?;
    operation()
}

pub(crate) fn write_copy<T>(
    path: &Path,
    operation: impl FnOnce(&Path) -> Result<T, String>,
) -> Result<T, String> {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    with_file_lock(path, || {
        let metadata = std::fs::metadata(path).map_err(|error| error.to_string())?;
        if metadata.permissions().readonly() {
            return Err("Audio file is read-only".into());
        }
        let canonical = std::fs::canonicalize(path).map_err(|error| error.to_string())?;
        let extension = canonical
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default();
        let temp = canonical.with_file_name(format!(
            ".lyrico-{}-{}.{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed),
            extension
        ));
        let mut destination = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)
            .map_err(|error| error.to_string())?;
        let _cleanup = TemporaryFile(temp.clone());
        let mut source = std::fs::File::open(&canonical).map_err(|error| error.to_string())?;
        std::io::copy(&mut source, &mut destination).map_err(|error| error.to_string())?;
        drop(source);
        drop(destination);
        let result = operation(&temp)?;
        let current = std::fs::metadata(&canonical).map_err(|error| error.to_string())?;
        if current.len() != metadata.len() || current.modified().ok() != metadata.modified().ok() {
            return Err(
                "Audio file changed externally while tags were being written; reload and retry"
                    .into(),
            );
        }
        std::fs::set_permissions(&temp, metadata.permissions())
            .map_err(|error| error.to_string())?;
        std::fs::OpenOptions::new()
            .write(true)
            .open(&temp)
            .and_then(|file| file.sync_all())
            .map_err(|error| error.to_string())?;
        std::fs::rename(&temp, &canonical)
            .map_err(|error| format!("Could not replace audio file: {error}"))?;
        Ok(result)
    })
}
struct TemporaryFile(PathBuf);
impl Drop for TemporaryFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}
