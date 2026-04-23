use base64::{engine::general_purpose, Engine as _};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

const SECURE_FILE_NAME: &str = "secure-secrets.vault";

#[derive(Serialize, Deserialize, Default)]
struct SecretVault {
  secrets: BTreeMap<String, String>,
}

fn vault_path(app: &AppHandle) -> Result<PathBuf, String> {
  let dir = app
    .path()
    .app_data_dir()
    .map_err(|err| format!("failed to resolve app data dir: {err}"))?;
  fs::create_dir_all(&dir).map_err(|err| format!("failed to create app data dir: {err}"))?;
  Ok(dir.join(SECURE_FILE_NAME))
}

fn read_vault(app: &AppHandle) -> Result<SecretVault, String> {
  let path = vault_path(app)?;
  if !path.exists() {
    return Ok(SecretVault::default());
  }
  let raw = fs::read_to_string(&path)
    .map_err(|err| format!("failed to read secure vault {}: {err}", path.display()))?;
  serde_json::from_str(&raw).map_err(|err| format!("failed to parse secure vault: {err}"))
}

fn write_vault(app: &AppHandle, vault: &SecretVault) -> Result<(), String> {
  let path = vault_path(app)?;
  let raw = serde_json::to_string_pretty(vault).map_err(|err| format!("failed to encode vault: {err}"))?;
  fs::write(&path, raw).map_err(|err| format!("failed to write secure vault {}: {err}", path.display()))
}

#[cfg(windows)]
fn protect(plain: &str) -> Result<String, String> {
  use std::ptr::{null, null_mut};
  use windows_sys::Win32::Foundation::LocalFree;
  use windows_sys::Win32::Security::Cryptography::{CryptProtectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB};

  let input = CRYPT_INTEGER_BLOB {
    cbData: plain.as_bytes().len() as u32,
    pbData: plain.as_ptr() as *mut u8,
  };
  let mut output = CRYPT_INTEGER_BLOB { cbData: 0, pbData: null_mut() };
  let ok = unsafe {
    CryptProtectData(
      &input,
      null(),
      null(),
      null(),
      null(),
      CRYPTPROTECT_UI_FORBIDDEN,
      &mut output,
    )
  };
  if ok == 0 {
    return Err("Windows DPAPI failed to protect secret".to_string());
  }
  let bytes = unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
  unsafe {
    LocalFree(output.pbData as *mut core::ffi::c_void);
  }
  Ok(general_purpose::STANDARD.encode(bytes))
}

#[cfg(windows)]
fn unprotect(cipher: &str) -> Result<String, String> {
  use std::ptr::{null, null_mut};
  use windows_sys::Win32::Foundation::LocalFree;
  use windows_sys::Win32::Security::Cryptography::{CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB};

  let mut bytes = general_purpose::STANDARD
    .decode(cipher)
    .map_err(|err| format!("invalid protected secret payload: {err}"))?;
  let input = CRYPT_INTEGER_BLOB {
    cbData: bytes.len() as u32,
    pbData: bytes.as_mut_ptr(),
  };
  let mut output = CRYPT_INTEGER_BLOB { cbData: 0, pbData: null_mut() };
  let ok = unsafe {
    CryptUnprotectData(
      &input,
      null_mut(),
      null(),
      null(),
      null(),
      CRYPTPROTECT_UI_FORBIDDEN,
      &mut output,
    )
  };
  if ok == 0 {
    return Err("Windows DPAPI failed to unprotect secret".to_string());
  }
  let out = unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
  unsafe {
    LocalFree(output.pbData as *mut core::ffi::c_void);
  }
  String::from_utf8(out).map_err(|err| format!("protected secret is not utf-8: {err}"))
}

#[cfg(not(windows))]
fn protect(plain: &str) -> Result<String, String> {
  Ok(general_purpose::STANDARD.encode(plain.as_bytes()))
}

#[cfg(not(windows))]
fn unprotect(cipher: &str) -> Result<String, String> {
  let bytes = general_purpose::STANDARD
    .decode(cipher)
    .map_err(|err| format!("invalid protected secret payload: {err}"))?;
  String::from_utf8(bytes).map_err(|err| format!("protected secret is not utf-8: {err}"))
}

#[tauri::command]
pub fn secure_store_set(app: AppHandle, key: String, value: String) -> Result<(), String> {
  if key.trim().is_empty() {
    return Err("secret key cannot be empty".to_string());
  }
  let mut vault = read_vault(&app)?;
  vault.secrets.insert(key, protect(&value)?);
  write_vault(&app, &vault)
}

#[tauri::command]
pub fn secure_store_get(app: AppHandle, key: String) -> Result<Option<String>, String> {
  let vault = read_vault(&app)?;
  match vault.secrets.get(&key) {
    Some(value) => Ok(Some(unprotect(value)?)),
    None => Ok(None),
  }
}

#[tauri::command]
pub fn secure_store_delete(app: AppHandle, key: String) -> Result<(), String> {
  let mut vault = read_vault(&app)?;
  vault.secrets.remove(&key);
  write_vault(&app, &vault)
}
