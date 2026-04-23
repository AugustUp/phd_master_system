use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};
use uuid::Uuid;

const SYNC_DIR_NAME: &str = "sync";
const CONFLICT_DIR_NAME: &str = "conflicts";
const CONFIG_FILE_NAME: &str = "sync-config.json";
const DEVICE_FILE_NAME: &str = "device-id";
const SYNC_META_FILE_NAME: &str = "sync-meta.json";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppDataInfo {
  app_data_dir: String,
  sync_dir: String,
  device_id: String,
  now: String,
}

#[derive(Deserialize)]
pub struct HttpRequest {
  pub method: String,
  pub url: String,
  #[serde(default)]
  pub headers: BTreeMap<String, String>,
  pub body: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpResponse {
  pub status: u16,
  pub body: String,
  pub headers: BTreeMap<String, String>,
  pub etag: String,
  pub last_modified: String,
  pub size: u64,
}

fn app_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
  let dir = app
    .path()
    .app_data_dir()
    .map_err(|err| format!("failed to resolve app data dir: {err}"))?;
  fs::create_dir_all(&dir).map_err(|err| format!("failed to create app data dir: {err}"))?;
  Ok(dir)
}

fn sync_dir(app: &AppHandle) -> Result<PathBuf, String> {
  let dir = app_data_dir(app)?.join(SYNC_DIR_NAME);
  fs::create_dir_all(&dir).map_err(|err| format!("failed to create sync dir: {err}"))?;
  Ok(dir)
}

fn safe_join(base: &Path, name: &str) -> Result<PathBuf, String> {
  if name.contains("..") || name.contains('\\') || name.contains('/') || name.trim().is_empty() {
    return Err(format!("unsafe file name: {name}"));
  }
  Ok(base.join(name))
}

fn safe_relative_path(path: &str) -> Result<PathBuf, String> {
  let input = Path::new(path);
  if input.is_absolute() || path.trim().is_empty() {
    return Err(format!("unsafe relative path: {path}"));
  }
  let mut out = PathBuf::new();
  for component in input.components() {
    match component {
      std::path::Component::Normal(part) => out.push(part),
      std::path::Component::CurDir => {}
      _ => return Err(format!("unsafe relative path: {path}")),
    }
  }
  if out.as_os_str().is_empty() {
    return Err(format!("unsafe relative path: {path}"));
  }
  Ok(out)
}

fn resolve_app_file(app: &AppHandle, relative_path: &str) -> Result<PathBuf, String> {
  let base = app_data_dir(app)?;
  let rel = safe_relative_path(relative_path)?;
  Ok(base.join(rel))
}

fn sync_meta_path(app: &AppHandle) -> Result<PathBuf, String> {
  Ok(sync_dir(app)?.join(SYNC_META_FILE_NAME))
}

fn now_iso() -> String {
  let secs = SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .unwrap_or(Duration::from_secs(0))
    .as_secs();
  format!("{secs}")
}

fn device_id(app: &AppHandle) -> Result<String, String> {
  let path = app_data_dir(app)?.join(DEVICE_FILE_NAME);
  if path.exists() {
    return fs::read_to_string(&path)
      .map(|s| s.trim().to_string())
      .map_err(|err| format!("failed to read device id: {err}"));
  }
  let id = Uuid::new_v4().to_string();
  fs::write(&path, &id).map_err(|err| format!("failed to write device id: {err}"))?;
  Ok(id)
}

#[tauri::command]
pub fn sync_app_info(app: AppHandle) -> Result<AppDataInfo, String> {
  let app_dir = app_data_dir(&app)?;
  let dir = sync_dir(&app)?;
  Ok(AppDataInfo {
    app_data_dir: app_dir.to_string_lossy().to_string(),
    sync_dir: dir.to_string_lossy().to_string(),
    device_id: device_id(&app)?,
    now: now_iso(),
  })
}

#[tauri::command]
pub fn get_device_id(app: AppHandle) -> Result<String, String> {
  device_id(&app)
}

#[tauri::command]
pub fn read_app_file(app: AppHandle, path: String) -> Result<Option<String>, String> {
  let full = resolve_app_file(&app, &path)?;
  if !full.exists() {
    return Ok(None);
  }
  fs::read_to_string(&full)
    .map(Some)
    .map_err(|err| format!("failed to read app file {}: {err}", full.display()))
}

#[tauri::command]
pub fn write_app_file(app: AppHandle, path: String, content: String) -> Result<String, String> {
  let full = resolve_app_file(&app, &path)?;
  if let Some(parent) = full.parent() {
    fs::create_dir_all(parent).map_err(|err| format!("failed to prepare app file dir {}: {err}", parent.display()))?;
  }
  fs::write(&full, content).map_err(|err| format!("failed to write app file {}: {err}", full.display()))?;
  Ok(full.to_string_lossy().to_string())
}

#[tauri::command]
pub fn read_sync_meta(app: AppHandle) -> Result<serde_json::Value, String> {
  let path = sync_meta_path(&app)?;
  if !path.exists() {
    return Ok(json!({}));
  }
  let raw = fs::read_to_string(&path).map_err(|err| format!("failed to read sync meta {}: {err}", path.display()))?;
  serde_json::from_str(&raw).map_err(|err| format!("failed to parse sync meta {}: {err}", path.display()))
}

#[tauri::command]
pub fn write_sync_meta(app: AppHandle, meta: serde_json::Value) -> Result<(), String> {
  let path = sync_meta_path(&app)?;
  if let Some(parent) = path.parent() {
    fs::create_dir_all(parent).map_err(|err| format!("failed to prepare sync meta dir {}: {err}", parent.display()))?;
  }
  let raw = serde_json::to_string_pretty(&meta).map_err(|err| format!("failed to encode sync meta: {err}"))?;
  fs::write(&path, raw).map_err(|err| format!("failed to write sync meta {}: {err}", path.display()))
}

#[tauri::command]
pub fn sync_read_config(app: AppHandle) -> Result<serde_json::Value, String> {
  let path = app_data_dir(&app)?.join(CONFIG_FILE_NAME);
  if !path.exists() {
    return Ok(json!({}));
  }
  let raw = fs::read_to_string(&path).map_err(|err| format!("failed to read sync config: {err}"))?;
  serde_json::from_str(&raw).map_err(|err| format!("failed to parse sync config: {err}"))
}

#[tauri::command]
pub fn sync_write_config(app: AppHandle, config: serde_json::Value) -> Result<(), String> {
  let path = app_data_dir(&app)?.join(CONFIG_FILE_NAME);
  let raw = serde_json::to_string_pretty(&config).map_err(|err| format!("failed to encode sync config: {err}"))?;
  fs::write(&path, raw).map_err(|err| format!("failed to write sync config: {err}"))
}

#[tauri::command]
pub fn sync_write_cache_file(app: AppHandle, name: String, content: String) -> Result<String, String> {
  let safe_name = safe_join(Path::new("sync"), &name)?.to_string_lossy().replace('\\', "/");
  write_app_file(app, safe_name, content)
}

#[tauri::command]
pub fn sync_read_cache_file(app: AppHandle, name: String) -> Result<Option<String>, String> {
  let safe_name = safe_join(Path::new("sync"), &name)?.to_string_lossy().replace('\\', "/");
  read_app_file(app, safe_name)
}

#[tauri::command]
pub fn sync_write_conflict_file(app: AppHandle, name: String, content: String) -> Result<String, String> {
  save_conflict_backup(app, name, content, None)
}

#[tauri::command]
pub fn save_conflict_backup(
  app: AppHandle,
  name: String,
  content: String,
  meta: Option<serde_json::Value>,
) -> Result<String, String> {
  let dir = app_data_dir(&app)?.join(CONFLICT_DIR_NAME);
  fs::create_dir_all(&dir).map_err(|err| format!("failed to create conflict dir: {err}"))?;
  let stamp = SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .unwrap_or(Duration::from_secs(0))
    .as_secs();
  let path = safe_join(&dir, &format!("{stamp}-{name}"))?;
  fs::write(&path, content).map_err(|err| format!("failed to write conflict file: {err}"))?;
  if let Some(meta_value) = meta {
    let meta_path = safe_join(&dir, &format!("{stamp}-{name}.meta.json"))?;
    let raw = serde_json::to_string_pretty(&meta_value).map_err(|err| format!("failed to encode conflict meta: {err}"))?;
    fs::write(&meta_path, raw).map_err(|err| format!("failed to write conflict meta file: {err}"))?;
  }
  Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn sync_http_request(request: HttpRequest) -> Result<HttpResponse, String> {
  let client = reqwest::Client::builder()
    .timeout(Duration::from_secs(30))
    .build()
    .map_err(|err| format!("failed to build http client: {err}"))?;
  let method = request
    .method
    .parse::<reqwest::Method>()
    .map_err(|err| format!("invalid http method: {err}"))?;
  let mut builder = client.request(method, &request.url);
  for (key, value) in request.headers {
    builder = builder.header(key, value);
  }
  if let Some(body) = request.body {
    builder = builder.body(body);
  }
  let response = builder
    .send()
    .await
    .map_err(|err| format!("network request failed: {err}"))?;
  let status = response.status().as_u16();
  let mut headers = BTreeMap::new();
  for (key, value) in response.headers() {
    headers.insert(key.as_str().to_ascii_lowercase(), value.to_str().unwrap_or("").to_string());
  }
  let etag = headers.get("etag").cloned().unwrap_or_default();
  let last_modified = headers.get("last-modified").cloned().unwrap_or_default();
  let body = response.text().await.map_err(|err| format!("failed to read response body: {err}"))?;
  let size = headers
    .get("content-length")
    .and_then(|value| value.parse::<u64>().ok())
    .unwrap_or_else(|| body.as_bytes().len() as u64);
  Ok(HttpResponse {
    status,
    body,
    headers,
    etag,
    last_modified,
    size,
  })
}
