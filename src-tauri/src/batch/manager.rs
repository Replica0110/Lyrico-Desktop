use super::worker;
use crate::database::Database;
use crate::models::BatchTask;
use rayon::ThreadPoolBuilder;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

pub(super) struct ActiveBatchTask {
    cancelled: Arc<AtomicBool>,
    item_cancellations: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl ActiveBatchTask {
    fn new() -> Self {
        Self {
            cancelled: Arc::new(AtomicBool::new(false)),
            item_cancellations: Mutex::new(HashMap::new()),
        }
    }

    pub(super) fn item_cancellation(&self, item_id: &str) -> Arc<AtomicBool> {
        let mut flags = self
            .item_cancellations
            .lock()
            .expect("batch item cancellation lock poisoned");
        flags
            .entry(item_id.to_string())
            .or_insert_with(|| Arc::new(AtomicBool::new(false)))
            .clone()
    }

    pub(super) fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Relaxed)
    }

    fn cancel(&self) {
        self.cancelled.store(true, Ordering::Relaxed);
        if let Ok(flags) = self.item_cancellations.lock() {
            for flag in flags.values() {
                flag.store(true, Ordering::Relaxed);
            }
        }
    }
}

#[derive(Clone)]
pub(crate) struct BatchManager {
    database: Database,
    active: Arc<Mutex<HashMap<String, Arc<ActiveBatchTask>>>>,
}

impl BatchManager {
    pub(crate) fn new(database: Database) -> Self {
        Self {
            database,
            active: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub(crate) async fn start_task(
        &self,
        app: AppHandle,
        task_id: String,
    ) -> Result<BatchTask, String> {
        if self
            .active
            .lock()
            .map_err(|_| "Batch manager lock poisoned".to_string())?
            .contains_key(&task_id)
        {
            return self.database.load_batch_task(&task_id).await;
        }
        let task = self.database.start_batch_task(&task_id).await?;
        let active_task = Arc::new(ActiveBatchTask::new());
        self.active
            .lock()
            .map_err(|_| "Batch manager lock poisoned".to_string())?
            .insert(task_id.clone(), active_task.clone());
        let _ = app.emit("batch-task-updated", task.clone());
        let manager = self.clone();
        tauri::async_runtime::spawn(async move {
            worker::run_task(app, manager.database.clone(), task_id.clone(), active_task).await;
            if let Ok(mut active) = manager.active.lock() {
                active.remove(&task_id);
            }
        });
        Ok(task)
    }

    pub(crate) async fn cancel_task(
        &self,
        app: &AppHandle,
        task_id: &str,
    ) -> Result<BatchTask, String> {
        let active = {
            self.active
                .lock()
                .map_err(|_| "Batch manager lock poisoned".to_string())?
                .get(task_id)
                .cloned()
        };
        if let Some(active) = active {
            active.cancel();
            return self.database.load_batch_task(task_id).await;
        }
        let task = self.database.load_batch_task(task_id).await?;
        if task.status == "queued" {
            self.database.start_batch_task(task_id).await?;
            self.database
                .cancel_pending_batch_items(task_id, "Batch task cancelled before start")
                .await?;
            let task = self
                .database
                .finish_batch_task(
                    task_id,
                    "cancelled",
                    Some("Batch task cancelled before start".to_string()),
                )
                .await?;
            let _ = app.emit("batch-task-updated", task.clone());
            return Ok(task);
        }
        Ok(task)
    }

    pub(crate) async fn cancel_item(
        &self,
        task_id: &str,
        item_id: &str,
    ) -> Result<BatchTask, String> {
        let active = {
            self.active
                .lock()
                .map_err(|_| "Batch manager lock poisoned".to_string())?
                .get(task_id)
                .cloned()
        };
        if let Some(active) = active {
            active
                .item_cancellation(item_id)
                .store(true, Ordering::Relaxed);
        }
        self.database.load_batch_task(task_id).await
    }

    pub(crate) fn recover(&self, app: AppHandle) {
        let manager = self.clone();
        tauri::async_runtime::spawn(async move {
            match manager.database.recover_interrupted_batch_tasks().await {
                Ok(task_ids) => {
                    crate::logging::event(
                        if task_ids.is_empty() {
                            log::Level::Debug
                        } else {
                            log::Level::Info
                        },
                        "batch",
                        "recovery.completed",
                        serde_json::json!({"resumed":task_ids.len()}),
                    );
                    for task_id in task_ids {
                        let result = manager.start_task(app.clone(), task_id.clone()).await;
                        if let Err(error) = result {
                            crate::logging::event(
                                log::Level::Error,
                                "batch",
                                "recovery.resume_failed",
                                serde_json::json!({"taskId":task_id,"error":error}),
                            );
                        }
                    }
                }
                Err(error) => {
                    crate::logging::event(
                        log::Level::Error,
                        "batch",
                        "recovery.failed",
                        serde_json::json!({"error":error}),
                    );
                }
            }
        });
    }
}

pub(super) fn build_pool(concurrency: usize) -> Result<rayon::ThreadPool, String> {
    ThreadPoolBuilder::new()
        .num_threads(concurrency.clamp(1, 5))
        .thread_name(|index| format!("lyrico-batch-{index}"))
        .build()
        .map_err(|error| error.to_string())
}
