import { SyncEngine } from "./engine.js";
import { JianguoyunWebDavProvider } from "./providers/jianguoyun-webdav.js";
import { FIRST_SYNC_MODE } from "./types.js";
import { readSyncConfig, secrets, writeSyncConfig } from "./state.js";

let config = null;
let syncing = false;
let autoTimer = null;
const HEALTHY_SYNC_DELAY_MS = 5000;
const MIN_RETRY_DELAY_MS = 10000;
const MAX_RETRY_DELAY_MS = 10 * 60 * 1000;
let backoffMs = HEALTHY_SYNC_DELAY_MS;

const $ = (id) => document.getElementById(id);

function adapter() {
  return window.PhdWorkbenchSyncAdapter;
}

function setText(id, value) {
  const el = $(id);
  if (el) el.textContent = value || "";
}

function firstModeLabel(mode = "") {
  if (mode === FIRST_SYNC_MODE.DOWNLOAD_REMOTE) return "首次模式：下载云端";
  if (mode === FIRST_SYNC_MODE.UPLOAD_LOCAL) return "首次模式：上传本地";
  if (mode === FIRST_SYNC_MODE.MERGE_BIDIRECTIONAL) return "首次模式：双向合并";
  if (mode === FIRST_SYNC_MODE.INIT_EMPTY) return "首次模式：初始化空仓";
  return mode ? `首次模式：${mode}` : "首次模式：未判定";
}

function setStatus(value) {
  setText("cloudSyncStatus", value);
  if (adapter()?.setStorageSyncState) adapter().setStorageSyncState(value);
}

function provider() {
  return new JianguoyunWebDavProvider(config);
}

function engine() {
  const a = adapter();
  return new SyncEngine({
    provider: provider(),
    getState: a.getState,
    normalizeState: a.normalizeState,
    applyState: a.applyState,
    exportNormalizedState: a.exportNormalizedState,
    replaceStateFromSync: a.replaceStateFromSync,
  });
}

async function saveConfig(patch = {}) {
  config = { ...config, ...patch, provider: "jianguoyun" };
  await writeSyncConfig(config);
  render();
}

async function runSync(label, fn) {
  if (syncing) return;
  const syncStartedAt = Date.now();
  syncing = true;
  setStatus(`${label}中...`);
  try {
    const result = await fn();
    const a = adapter();
    if (a && (a._dirtyAt || 0) <= syncStartedAt) a._syncDirty = false;
    backoffMs = HEALTHY_SYNC_DELAY_MS;
    await saveConfig({
      provider: "jianguoyun",
      lastSyncAt: new Date().toLocaleString(),
      lastSyncResult: result.message || "成功",
      lastSyncMode: result.firstSyncMode || config.lastSyncMode || "",
    });
    setStatus(config.lastSyncResult);
    setText("cloudFirstSyncMode", firstModeLabel(result.firstSyncMode || config.lastSyncMode));
    const conflictLines = result.conflicts?.length
      ? result.conflicts.map((item) => {
        if (item.strategy === "smart-merge") return `${item.name}: 已智能合并（本地备份 ${item.localPath}；云端备份 ${item.remotePath}）`;
        if (item.strategy === "kept-local-field") return `${item.name}: ${item.item}.${item.field} 字段冲突，已暂保留本地值`;
        return `${item.name}: ${item.path || item.localPath || item.remotePath || "已记录冲突"}`;
      }).join("\n")
      : "暂无冲突。";
    setText("cloudConflictLog", conflictLines);
    setText("cloudConflictHint", result.conflicts?.length ? `发现 ${result.conflicts.length} 项冲突/合并记录` : "无冲突备份");
    setText("cloudMergeSummary", result.conflicts?.length ? "智能合并已运行；无法自动判断的字段暂保留本地值。" : "本次无需智能合并。");
    if ($("cloudConflictActions")) $("cloudConflictActions").classList.toggle("hidden", !result.conflicts?.length);
  } catch (err) {
    console.error(err);
    const message = err?.message || String(err);
    await saveConfig({ lastSyncResult: `失败：${message}` });
    setStatus(config.lastSyncResult);
    setText("cloudConflictHint", "最近同步失败，请查看日志");
    setText("cloudMergeSummary", "同步失败，暂未执行智能合并。");
    backoffMs = Math.min(Math.max(backoffMs * 2, MIN_RETRY_DELAY_MS), MAX_RETRY_DELAY_MS);
  } finally {
    syncing = false;
    if (adapter()?._syncDirty && config?.autoSync) debounceAutoSync();
  }
}

function debounceAutoSync() {
  if (!config?.autoSync || syncing) return;
  clearTimeout(autoTimer);
  autoTimer = setTimeout(() => runSync("自动同步", () => engine().syncNow()), backoffMs);
}

function render() {
  if (!config) return;
  if ($("syncAutoEnabled")) $("syncAutoEnabled").checked = !!config.autoSync;
  if ($("jianguoyunServerUrl")) $("jianguoyunServerUrl").value = config.jianguoyunServerUrl;
  if ($("jianguoyunUsername")) $("jianguoyunUsername").value = config.jianguoyunUsername;
  setText("syncPolicyHint", `修改后约 ${Math.round(HEALTHY_SYNC_DELAY_MS / 1000)} 秒同步，失败时自动降频。`);
  setText("cloudLastSyncAt", config.lastSyncAt || "尚未同步");
  setText("cloudLastSyncResult", config.lastSyncResult || "尚未同步");
  setText("cloudFirstSyncMode", firstModeLabel(config.lastSyncMode));
  if (!$("cloudConflictLog")?.textContent?.trim()) setText("cloudConflictLog", "暂无冲突。");
  if (!$("cloudMergeSummary")?.textContent?.trim()) setText("cloudMergeSummary", "尚未执行智能合并。");
}

async function bind() {
  if (!$("btnCloudSyncNow")) return;
  config = await readSyncConfig();
  config.provider = "jianguoyun";
  render();
  $("syncAutoEnabled").onchange = (e) => saveConfig({ autoSync: e.target.checked });
  $("btnJianguoyunTest").onclick = async () => {
    await secrets.set("jianguoyun.password", $("jianguoyunPassword").value);
    await saveConfig({
      provider: "jianguoyun",
      jianguoyunServerUrl: $("jianguoyunServerUrl").value.trim() || "https://dav.jianguoyun.com/dav/",
      jianguoyunUsername: $("jianguoyunUsername").value.trim(),
    });
    await runSync("坚果云验证", async () => {
      await provider().testConnection();
      return { message: "坚果云连接验证通过", firstSyncMode: config.lastSyncMode || "" };
    });
  };
  $("btnJianguoyunSave").onclick = async () => {
    if ($("jianguoyunPassword").value) await secrets.set("jianguoyun.password", $("jianguoyunPassword").value);
    await saveConfig({
      provider: "jianguoyun",
      jianguoyunServerUrl: $("jianguoyunServerUrl").value.trim() || "https://dav.jianguoyun.com/dav/",
      jianguoyunUsername: $("jianguoyunUsername").value.trim(),
      lastSyncResult: "坚果云配置已保存",
    });
  };
  $("btnJianguoyunDisconnect").onclick = async () => {
    await secrets.delete("jianguoyun.password");
    await saveConfig({ jianguoyunUsername: "", lastSyncResult: "坚果云已断开" });
  };
  $("btnCloudSyncNow").onclick = () => runSync("同步", () => engine().syncNow());
  $("btnCloudUpload").onclick = () => runSync("上传", () => engine().fullUpload());
  $("btnCloudDownload").onclick = () => runSync("下载", () => engine().fullDownload());
  if ($("btnCloudKeepLocal")) $("btnCloudKeepLocal").onclick = () => runSync("保留本地", () => engine().fullUpload());
  if ($("btnCloudUseRemote")) $("btnCloudUseRemote").onclick = () => runSync("使用云端", () => engine().fullDownload());
  if ($("btnCloudRetryMerge")) $("btnCloudRetryMerge").onclick = () => runSync("重新智能合并", () => engine().syncNow());
  $("btnCloudShowLog").onclick = () => $("cloudLogPanel")?.classList.toggle("hidden");
  adapter()?.onLocalChange?.(debounceAutoSync);
  if (config.autoSync) setTimeout(() => runSync("启动同步", () => engine().syncNow()), 1200);
}

document.addEventListener("DOMContentLoaded", bind);
