import { DEFAULT_SYNC_CONFIG, SYNC_LOCK_TTL_MS } from "./types.js";

const STORAGE_PREFIX = "phd-workbench-sync.";
const CONFIG_KEY = `${STORAGE_PREFIX}config`;
const DEVICE_ID_KEY = `${STORAGE_PREFIX}deviceId`;
const SYNC_META_KEY = `${STORAGE_PREFIX}meta`;
const LAST_MANIFEST_KEY = `${STORAGE_PREFIX}lastManifest`;

const LAST_MANIFEST_PATH = "sync/last-manifest.json";
const SYNC_META_PATH = "sync/sync-meta.json";

function hasTauriRuntime() {
  return !!(window.__TAURI__?.core?.invoke || window.__TAURI_INTERNALS__?.invoke);
}

function hasCapacitorNativeHttp() {
  return !!(window.Capacitor?.isNativePlatform?.() && window.Capacitor?.nativePromise);
}

function needsWebDavNativeHttp(method) {
  return !["OPTIONS", "GET", "HEAD", "POST", "PUT", "DELETE", "TRACE", "PATCH"].includes(String(method || "GET").toUpperCase());
}

function storageGet(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Ignore quota/privacy errors so the core workbench can continue running.
  }
}

function storageDelete(key) {
  try {
    localStorage.removeItem(key);
  } catch {
    // Ignore quota/privacy errors so the core workbench can continue running.
  }
}

function sanitizeSyncConfig(raw = {}) {
  const config = {
    provider: String(raw?.provider || DEFAULT_SYNC_CONFIG.provider),
    autoSync: !!raw?.autoSync,
    lastSyncAt: String(raw?.lastSyncAt || ""),
    lastSyncResult: String(raw?.lastSyncResult || DEFAULT_SYNC_CONFIG.lastSyncResult),
    lastSyncMode: String(raw?.lastSyncMode || ""),
    jianguoyunServerUrl: String(raw?.jianguoyunServerUrl || DEFAULT_SYNC_CONFIG.jianguoyunServerUrl),
    jianguoyunUsername: String(raw?.jianguoyunUsername || ""),
  };
  if (config.provider !== "jianguoyun") config.provider = "jianguoyun";
  return config;
}

function normalizeHeaders(headersLike) {
  const headers = {};
  if (!headersLike) return headers;
  if (typeof headersLike.forEach === "function") {
    headersLike.forEach((value, key) => {
      headers[String(key || "").toLowerCase()] = String(value || "");
    });
    return headers;
  }
  for (const [key, value] of Object.entries(headersLike || {})) {
    headers[String(key || "").toLowerCase()] = String(value || "");
  }
  return headers;
}

function headerValue(headers, name) {
  return headers[String(name || "").toLowerCase()] || "";
}

function parseSize(value, body = "") {
  const fromHeader = Number(value);
  if (Number.isFinite(fromHeader) && fromHeader >= 0) return fromHeader;
  return new TextEncoder().encode(String(body || "")).length;
}

function normalizeHttpResult(input = {}) {
  const body = typeof input.body === "string"
    ? input.body
    : typeof input.data === "string"
      ? input.data
      : JSON.stringify(input.data ?? "");
  const headers = normalizeHeaders(input.headers);
  const etag = input.etag || headerValue(headers, "etag") || "";
  const lastModified = input.lastModified || headerValue(headers, "last-modified") || "";
  const size = parseSize(input.size ?? headerValue(headers, "content-length"), body);
  return {
    status: Number(input.status) || 0,
    body,
    headers,
    etag,
    lastModified,
    size,
  };
}

async function invokeTauriMaybe(command, args = {}) {
  const invoke = window.__TAURI__?.core?.invoke || window.__TAURI_INTERNALS__?.invoke;
  if (!invoke) throw new Error("Tauri runtime unavailable");
  return await invoke(command, args);
}

export async function invokeTauri(command, args = {}) {
  return await invokeTauriMaybe(command, args);
}

async function readAppFile(path) {
  try {
    return await invokeTauriMaybe("read_app_file", { path });
  } catch {
    return await invokeTauriMaybe("sync_read_cache_file", { name: path.split("/").pop() });
  }
}

async function writeAppFile(path, content) {
  try {
    return await invokeTauriMaybe("write_app_file", { path, content });
  } catch {
    return await invokeTauriMaybe("sync_write_cache_file", { name: path.split("/").pop(), content });
  }
}

export async function readSyncConfig() {
  try {
    if (hasTauriRuntime()) return sanitizeSyncConfig(await invokeTauriMaybe("sync_read_config"));
    const raw = storageGet(CONFIG_KEY);
    return sanitizeSyncConfig(raw ? JSON.parse(raw) : {});
  } catch {
    return sanitizeSyncConfig(DEFAULT_SYNC_CONFIG);
  }
}

export async function writeSyncConfig(config) {
  const safeConfig = sanitizeSyncConfig(config);
  if (hasTauriRuntime()) {
    await invokeTauriMaybe("sync_write_config", { config: safeConfig });
    return;
  }
  storageSet(CONFIG_KEY, JSON.stringify(safeConfig));
}

export async function getDeviceId() {
  if (hasTauriRuntime()) {
    try {
      return String(await invokeTauriMaybe("get_device_id"));
    } catch {
      const info = await invokeTauriMaybe("sync_app_info");
      return String(info?.deviceId || "");
    }
  }
  let deviceId = storageGet(DEVICE_ID_KEY);
  if (!deviceId) {
    deviceId = crypto.randomUUID ? crypto.randomUUID() : `web-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    storageSet(DEVICE_ID_KEY, deviceId);
  }
  return deviceId;
}

export async function getAppInfo() {
  if (hasTauriRuntime()) {
    try {
      return await invokeTauriMaybe("sync_app_info");
    } catch {
      return { deviceId: await getDeviceId(), platform: "tauri" };
    }
  }
  return { deviceId: await getDeviceId(), platform: "webview" };
}

export async function getSyncMeta() {
  if (hasTauriRuntime()) {
    try {
      const meta = await invokeTauriMaybe("read_sync_meta");
      return meta && typeof meta === "object" ? meta : {};
    } catch {
      const raw = await readAppFile(SYNC_META_PATH);
      return raw ? JSON.parse(raw) : {};
    }
  }
  const raw = storageGet(SYNC_META_KEY);
  return raw ? JSON.parse(raw) : {};
}

export async function setSyncMeta(meta) {
  const next = meta && typeof meta === "object" ? meta : {};
  if (hasTauriRuntime()) {
    try {
      await invokeTauriMaybe("write_sync_meta", { meta: next });
      return;
    } catch {
      await writeAppFile(SYNC_META_PATH, JSON.stringify(next, null, 2));
      return;
    }
  }
  storageSet(SYNC_META_KEY, JSON.stringify(next));
}

export async function readLocalManifestCache() {
  if (hasTauriRuntime()) {
    const raw = await readAppFile(LAST_MANIFEST_PATH);
    return raw ? JSON.parse(raw) : null;
  }
  const raw = storageGet(LAST_MANIFEST_KEY);
  return raw ? JSON.parse(raw) : null;
}

export async function writeLocalManifestCache(manifest) {
  if (!manifest) return;
  if (hasTauriRuntime()) {
    await writeAppFile(LAST_MANIFEST_PATH, JSON.stringify(manifest, null, 2));
    return;
  }
  storageSet(LAST_MANIFEST_KEY, JSON.stringify(manifest));
}

export async function saveConflictBackup(name, content, meta = {}) {
  if (!hasTauriRuntime()) {
    const key = `${STORAGE_PREFIX}conflict.${Date.now()}.${name}`;
    storageSet(key, content);
    if (meta && Object.keys(meta).length) storageSet(`${key}.meta`, JSON.stringify(meta));
    return key;
  }
  try {
    return await invokeTauriMaybe("save_conflict_backup", { name, content, meta });
  } catch {
    return await invokeTauriMaybe("sync_write_conflict_file", { name, content });
  }
}

export async function acquireSyncLock(owner = "sync-engine") {
  const now = Date.now();
  const lock = {
    token: `${owner}-${now}-${Math.random().toString(16).slice(2)}`,
    owner,
    acquiredAt: now,
    expiresAt: now + SYNC_LOCK_TTL_MS,
  };
  const meta = await getSyncMeta();
  const active = meta?.lock;
  if (active?.token && Number(active.expiresAt) > now) return null;
  await setSyncMeta({ ...meta, lock });
  const verify = await getSyncMeta();
  return verify?.lock?.token === lock.token ? lock : null;
}

export async function releaseSyncLock(token) {
  const meta = await getSyncMeta();
  const active = meta?.lock;
  if (!active?.token) return;
  if (!token || active.token === token) {
    const { lock, ...rest } = meta;
    await setSyncMeta(rest);
  }
}

export const secrets = {
  get: (key) => hasTauriRuntime() ? invokeTauriMaybe("secure_store_get", { key }) : Promise.resolve(storageGet(`${STORAGE_PREFIX}secret.${key}`)),
  set: (key, value) => {
    if (hasTauriRuntime()) return invokeTauriMaybe("secure_store_set", { key, value });
    storageSet(`${STORAGE_PREFIX}secret.${key}`, value);
    return Promise.resolve();
  },
  delete: (key) => {
    if (hasTauriRuntime()) return invokeTauriMaybe("secure_store_delete", { key });
    storageDelete(`${STORAGE_PREFIX}secret.${key}`);
    return Promise.resolve();
  },
};

export async function httpRequest(method, url, { headers = {}, body } = {}) {
  if (hasCapacitorNativeHttp()) {
    const plugin = needsWebDavNativeHttp(method) ? "WebDavHttp" : "CapacitorHttp";
    const res = await window.Capacitor.nativePromise(plugin, "request", {
      url,
      method,
      headers,
      data: body,
      responseType: "text",
      connectTimeout: 20000,
      readTimeout: 30000,
    });
    return normalizeHttpResult(res);
  }
  if (!hasTauriRuntime()) {
    const res = await fetch(url, { method, headers, body });
    return normalizeHttpResult({
      status: res.status,
      body: await res.text(),
      headers: res.headers,
    });
  }
  const res = await invokeTauriMaybe("sync_http_request", { request: { method, url, headers, body } });
  return normalizeHttpResult(res);
}

export async function readLastManifest() {
  return await readLocalManifestCache();
}

export async function writeLastManifest(manifest) {
  await writeLocalManifestCache(manifest);
}

export async function saveConflict(name, content, meta = {}) {
  return await saveConflictBackup(name, content, meta);
}
