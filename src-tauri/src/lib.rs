use serde::Serialize;
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

mod secure_store;
mod sync_fs;

const STATE_FILE_NAME: &str = "workspace-data.json";

#[derive(Serialize)]
struct ReadStateJsonResponse {
  path: String,
  exists: bool,
  content: Option<String>,
}

#[derive(Serialize)]
struct WriteStateJsonResponse {
  path: String,
}

fn state_file_path(app: &AppHandle) -> Result<PathBuf, String> {
  let dir = app
    .path()
    .app_data_dir()
    .map_err(|err| format!("failed to resolve app data dir: {err}"))?;
  fs::create_dir_all(&dir).map_err(|err| format!("failed to create app data dir: {err}"))?;
  Ok(dir.join(STATE_FILE_NAME))
}

#[tauri::command]
fn read_state_json(app: AppHandle) -> Result<ReadStateJsonResponse, String> {
  let path = state_file_path(&app)?;
  if !path.exists() {
    return Ok(ReadStateJsonResponse {
      path: path.to_string_lossy().to_string(),
      exists: false,
      content: None,
    });
  }

  let content = fs::read_to_string(&path)
    .map_err(|err| format!("failed to read state json {}: {err}", path.display()))?;

  Ok(ReadStateJsonResponse {
    path: path.to_string_lossy().to_string(),
    exists: true,
    content: Some(content),
  })
}

#[tauri::command]
fn write_state_json(app: AppHandle, payload: String) -> Result<WriteStateJsonResponse, String> {
  let _: serde_json::Value =
    serde_json::from_str(&payload).map_err(|err| format!("invalid json payload: {err}"))?;
  let path = state_file_path(&app)?;

  fs::write(&path, payload)
    .map_err(|err| format!("failed to write state json {}: {err}", path.display()))?;

  Ok(WriteStateJsonResponse {
    path: path.to_string_lossy().to_string(),
  })
}

#[tauri::command]
fn clear_state_json(app: AppHandle) -> Result<(), String> {
  let path = state_file_path(&app)?;
  if path.exists() {
    fs::remove_file(&path)
      .map_err(|err| format!("failed to remove state json {}: {err}", path.display()))?;
  }
  Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .invoke_handler(tauri::generate_handler![
      read_state_json,
      write_state_json,
      clear_state_json,
      secure_store::secure_store_set,
      secure_store::secure_store_get,
      secure_store::secure_store_delete,
      sync_fs::sync_app_info,
      sync_fs::get_device_id,
      sync_fs::read_app_file,
      sync_fs::write_app_file,
      sync_fs::sync_read_config,
      sync_fs::sync_write_config,
      sync_fs::read_sync_meta,
      sync_fs::write_sync_meta,
      sync_fs::sync_write_cache_file,
      sync_fs::sync_read_cache_file,
      sync_fs::save_conflict_backup,
      sync_fs::sync_write_conflict_file,
      sync_fs::sync_http_request
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
