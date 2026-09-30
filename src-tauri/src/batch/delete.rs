use super::processor::{BatchProcessor, ProcessContext, ProcessError, ProcessOutcome};
use std::path::Path;
use std::sync::atomic::Ordering;

pub(super) struct DeleteFilesProcessor;

impl BatchProcessor for DeleteFilesProcessor {
    fn process(
        &self,
        context: ProcessContext<'_>,
        on_progress: &mut dyn FnMut(f64),
    ) -> Result<ProcessOutcome, ProcessError> {
        if context.cancelled.load(Ordering::Relaxed) {
            return Err(ProcessError::Cancelled("Batch item cancelled".to_string()));
        }
        let path = Path::new(&context.item.song_path);
        tauri::async_runtime::block_on(context.database.remove_library_track(&context.item.song_path))
            .map_err(ProcessError::Failed)?;
        on_progress(0.5);
        std::fs::remove_file(path)
            .map_err(|error| ProcessError::Failed(error.to_string()))?;
        on_progress(1.0);
        Ok(ProcessOutcome {
            result_json: None,
            updated_track: None,
            previous_track_path: None,
        })
    }
}
