use super::manager::{build_pool, ActiveBatchTask};
use super::processor::{processor_for, ProcessContext, ProcessError};
use crate::config;
use crate::database::Database;
use crate::models::{BatchTask, BatchTaskItem};
use rayon::prelude::*;
use serde_json::Value;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use tauri::{AppHandle, Emitter};

pub(super) async fn run_task(
    app: AppHandle,
    database: Database,
    task_id: String,
    active: Arc<ActiveBatchTask>,
) {
    let result = run_task_inner(
        app.clone(),
        database.clone(),
        task_id.clone(),
        active.clone(),
    )
    .await;
    if let Err(error) = result {
        let _ = database
            .cancel_pending_batch_items(&task_id, "Batch task stopped after runner error")
            .await;
        if let Ok(task) = database
            .finish_batch_task(&task_id, "failed", Some(error.clone()))
            .await
        {
            let _ = app.emit("batch-task-updated", task);
        }
        crate::logging::event(
            log::Level::Error,
            "batch",
            "task.failed",
            serde_json::json!({"taskId":task_id,"error":error}),
        );
    }
}

async fn run_task_inner(
    app: AppHandle,
    database: Database,
    task_id: String,
    active: Arc<ActiveBatchTask>,
) -> Result<(), String> {
    let task = database.load_batch_task(&task_id).await?;
    let items = database.load_batch_task_items(&task_id).await?;
    let concurrency = parse_concurrency(task.config_json.as_deref());
    let operation = crate::logging::Operation::new(
        "batch",
        "run",
        serde_json::json!({"taskId":task.task_id,"taskType":task.task_type,"total":items.len(),"concurrency":concurrency}),
        log::Level::Debug,
    );
    let artist_separator = config::load_artist_split_config(&app)?.artist_separator;
    let pool = build_pool(concurrency)?;
    let processor: Arc<dyn super::processor::BatchProcessor> =
        Arc::from(processor_for(&task.task_type)?);
    let app_for_worker = app.clone();
    let database_for_worker = database.clone();
    let task_for_worker = task.clone();
    let active_for_worker = active.clone();

    tauri::async_runtime::spawn_blocking(move || {
        pool.install(|| {
            items.par_iter().for_each(|item| {
                process_item(
                    &app_for_worker,
                    &database_for_worker,
                    &task_for_worker,
                    item,
                    &artist_separator,
                    &active_for_worker,
                    processor.as_ref(),
                );
            });
        });
    })
    .await
    .map_err(|error| error.to_string())?;

    let terminal = if active.is_cancelled() {
        "cancelled"
    } else {
        "succeeded"
    };
    if active.is_cancelled() {
        database
            .cancel_pending_batch_items(&task_id, "Batch task cancelled")
            .await?;
    }
    let task = database
        .finish_batch_task(
            &task_id,
            terminal,
            (terminal == "cancelled").then(|| "Batch task cancelled".to_string()),
        )
        .await?;
    crate::logging::event(
        if task.failure_count > 0 {
            log::Level::Warn
        } else {
            log::Level::Info
        },
        "batch",
        "task.finished",
        serde_json::json!({"taskId":task.task_id,"taskType":task.task_type,"status":task.status,"total":task.total,"succeeded":task.success_count,"failed":task.failure_count,"skipped":task.skipped_count}),
    );
    let _ = app.emit("batch-task-updated", task);
    operation.finish(&Ok::<(), String>(()));
    Ok(())
}

fn process_item(
    app: &AppHandle,
    database: &Database,
    task: &BatchTask,
    item: &BatchTaskItem,
    artist_separator: &str,
    active: &ActiveBatchTask,
    processor: &dyn super::processor::BatchProcessor,
) {
    let cancellation = active.item_cancellation(&item.item_id);
    if active.is_cancelled() {
        cancellation.store(true, Ordering::Relaxed);
    }
    if cancellation.load(Ordering::Relaxed) {
        update_item(
            app,
            database,
            task,
            item,
            "cancelled",
            0.0,
            None,
            Some("Batch item cancelled".to_string()),
        );
        return;
    }
    update_item(app, database, task, item, "running", 0.0, None, None);
    let app_for_progress = app.clone();
    let database_for_progress = database.clone();
    let task_id = task.task_id.clone();
    let item_id = item.item_id.clone();
    let mut on_progress = move |progress: f64| {
        if let Ok(snapshot) = tauri::async_runtime::block_on(
            database_for_progress
                .update_batch_task_item_result(&task_id, &item_id, "running", progress, None, None),
        ) {
            let _ = app_for_progress.emit("batch-task-updated", snapshot);
        }
    };
    let result = processor.process(
        ProcessContext {
            app,
            database,
            task,
            item,
            artist_separator,
            cancelled: cancellation.as_ref(),
        },
        &mut on_progress,
    );
    match result {
        Ok(outcome) => {
            let database_result = outcome.updated_track.as_ref().map(|track| {
                if let Some(previous_path) = outcome.previous_track_path.as_deref() {
                    tauri::async_runtime::block_on(
                        database.update_renamed_track_summary(previous_path, track),
                    )
                } else {
                    tauri::async_runtime::block_on(database.update_track_summary(track))
                }
            });
            if let Some(Err(reason)) = database_result {
                let failure = match (
                    outcome.previous_track_path.as_deref(),
                    outcome.updated_track.as_ref(),
                ) {
                    (Some(previous_path), Some(track)) => {
                        match std::fs::rename(&track.path, previous_path) {
                            Ok(()) => format!(
                                "Library index update failed and the file rename was rolled back: {reason}"
                            ),
                            Err(rollback_error) => format!(
                                "File was renamed but the library index update failed: {reason}; rollback also failed: {rollback_error}"
                            ),
                        }
                    }
                    _ => format!("File updated but library index update failed: {reason}"),
                };
                update_item(
                    app,
                    database,
                    task,
                    item,
                    "failed",
                    1.0,
                    None,
                    Some(failure),
                );
                return;
            }
            update_item(
                app,
                database,
                task,
                item,
                "succeeded",
                1.0,
                outcome.result_json,
                None,
            );
        }
        Err(ProcessError::Skipped(reason)) => update_item(
            app,
            database,
            task,
            item,
            "skipped",
            1.0,
            None,
            Some(reason),
        ),
        Err(ProcessError::Cancelled(reason)) => {
            emit_replay_terminal(app, task, item, "cancelled", Some(reason.clone()));
            update_item(
                app,
                database,
                task,
                item,
                "cancelled",
                0.0,
                None,
                Some(reason),
            );
        }
        Err(ProcessError::Failed(reason)) => {
            emit_replay_terminal(app, task, item, "failed", Some(reason.clone()));
            update_item(app, database, task, item, "failed", 1.0, None, Some(reason));
        }
    }
}

fn emit_replay_terminal(
    app: &AppHandle,
    task: &BatchTask,
    item: &BatchTaskItem,
    status: &str,
    message: Option<String>,
) {
    if task.task_type != "replayGain" {
        return;
    }
    let _ = app.emit(
        "replay-gain-progress",
        crate::models::ReplayGainProgress {
            job_id: format!("{}:{}", task.task_id, item.item_id),
            path: item.song_path.clone(),
            percent: 0,
            status: status.to_string(),
            message,
        },
    );
}

fn update_item(
    app: &AppHandle,
    database: &Database,
    task: &BatchTask,
    item: &BatchTaskItem,
    status: &str,
    progress: f64,
    result_json: Option<String>,
    error_message: Option<String>,
) {
    let result = tauri::async_runtime::block_on(database.update_batch_task_item_result(
        &task.task_id,
        &item.item_id,
        status,
        progress,
        result_json,
        error_message.clone(),
    ));
    match result {
        Ok(snapshot) => {
            let _ = app.emit("batch-task-updated", snapshot);
        }
        Err(error) => crate::logging::event(
            log::Level::Error,
            "database",
            "batch_item.persist_failed",
            serde_json::json!({"taskId":task.task_id,"itemId":item.item_id,"error":error}),
        ),
    }
    // Progress updates are events for the UI, not diagnostic log entries.
    // Successful per-file completion is DEBUG; failures retain enough context at WARN/ERROR.
    if status != "running" {
        crate::logging::event(
            if status == "failed" {
                log::Level::Error
            } else if status == "skipped" {
                log::Level::Warn
            } else {
                log::Level::Debug
            },
            "batch",
            "item.finished",
            serde_json::json!({"taskId":task.task_id,"taskType":task.task_type,"itemId":item.item_id,"songPath":item.song_path,"status":status,"error":error_message}),
        );
    }
}

fn parse_concurrency(config_json: Option<&str>) -> usize {
    config_json
        .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
        .and_then(|value| value.get("concurrency")?.as_u64())
        .and_then(|value| usize::try_from(value).ok())
        .unwrap_or(3)
        .clamp(1, 5)
}
