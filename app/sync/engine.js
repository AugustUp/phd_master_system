import { createEmptyManifest, exportSyncFilesFromState, manifestMap, mergeSyncFilesToState } from "./file-layout.js";
import {
  FIRST_SYNC_MODE,
  MANIFEST_FILE,
  SYNC_FILE_NAMES,
  SYNC_SCHEMA_VERSION,
} from "./types.js";
import {
  acquireSyncLock,
  getDeviceId,
  getSyncMeta,
  readLocalManifestCache,
  releaseSyncLock,
  saveConflictBackup,
  setSyncMeta,
  writeLocalManifestCache,
} from "./state.js";
import { stableJson } from "./hash.js";

function iso(value, fallback = "1970-01-01T00:00:00.000Z") {
  const millis = Date.parse(String(value || ""));
  return Number.isFinite(millis) ? new Date(millis).toISOString() : fallback;
}

function asNumber(value, fallback = 0) {
  const next = Number(value);
  return Number.isFinite(next) ? next : fallback;
}

function ensureManifestShape(manifest) {
  if (!manifest || typeof manifest !== "object") return null;
  const byName = manifestMap(manifest);
  const files = SYNC_FILE_NAMES.map((name) => {
    const entry = byName.get(name) || {};
    return {
      name,
      hash: String(entry.hash || ""),
      size: Math.max(0, asNumber(entry.size, 0)),
      updatedAt: iso(entry.updatedAt),
    };
  });
  return {
    schemaVersion: asNumber(manifest.schemaVersion, SYNC_SCHEMA_VERSION),
    revision: Math.max(0, asNumber(manifest.revision, 0)),
    updatedAt: iso(manifest.updatedAt),
    updatedByDevice: String(manifest.updatedByDevice || ""),
    files,
  };
}

function sameFile(left, right) {
  return String(left?.hash || "") === String(right?.hash || "");
}

function hasAnyData(manifest, emptyManifest) {
  const current = manifestMap(ensureManifestShape(manifest));
  const baseline = manifestMap(emptyManifest);
  return SYNC_FILE_NAMES.some((name) => !sameFile(current.get(name), baseline.get(name)));
}

function compareManifests(left, right) {
  const leftMap = manifestMap(ensureManifestShape(left));
  const rightMap = manifestMap(ensureManifestShape(right));
  return SYNC_FILE_NAMES.every((name) => sameFile(leftMap.get(name), rightMap.get(name)));
}

export class SyncEngine {
  constructor({ provider, getState, normalizeState, applyState, exportNormalizedState, replaceStateFromSync }) {
    this.provider = provider;
    this.getState = getState;
    this.normalizeState = normalizeState;
    this.applyState = applyState;
    this.exportNormalizedState = exportNormalizedState || (() => this.normalizeState(this.getState()));
    this.replaceStateFromSync = replaceStateFromSync || ((nextState, meta) => this.applyState(nextState, meta));
    this.emptyManifest = null;
  }

  async buildEmptyManifest(deviceId = "bootstrap") {
    if (this.emptyManifest) return this.emptyManifest;
    const empty = await exportSyncFilesFromState({}, {
      deviceId,
      previousManifest: createEmptyManifest(),
      revision: 0,
      updatedAt: "1970-01-01T00:00:00.000Z",
    });
    this.emptyManifest = ensureManifestShape(empty.manifest);
    return this.emptyManifest;
  }

  async readRemoteManifest() {
    const text = await this.provider.readText(MANIFEST_FILE, { noCache: true });
    if (!text) return null;
    try {
      const parsed = JSON.parse(text);
      return ensureManifestShape(parsed);
    } catch (err) {
      throw new Error(`云端 manifest 解析失败: ${err?.message || err}`);
    }
  }

  async writeRemoteManifest(manifest) {
    const finalManifest = ensureManifestShape(manifest);
    await this.provider.writeText(MANIFEST_FILE, stableJson(finalManifest));
    const echoed = await this.readRemoteManifest();
    if (!echoed) throw new Error("manifest 回读校验失败: 云端未返回 manifest");
    if (asNumber(echoed.revision) !== asNumber(finalManifest.revision)) {
      throw new Error(`manifest 回读校验失败: revision 不一致 ${echoed.revision} != ${finalManifest.revision}`);
    }
    if (!compareManifests(echoed, finalManifest)) {
      throw new Error("manifest 回读校验失败: 文件 hash 不一致");
    }
    return echoed;
  }

  decideFirstSyncMode(localManifest, remoteManifest, emptyManifest) {
    const localHas = hasAnyData(localManifest, emptyManifest);
    const remoteHas = remoteManifest ? hasAnyData(remoteManifest, emptyManifest) : false;
    if (!localHas && remoteHas) return FIRST_SYNC_MODE.DOWNLOAD_REMOTE;
    if (localHas && !remoteHas) return FIRST_SYNC_MODE.UPLOAD_LOCAL;
    if (localHas && remoteHas) return FIRST_SYNC_MODE.MERGE_BIDIRECTIONAL;
    return FIRST_SYNC_MODE.INIT_EMPTY;
  }

  async createLocalSnapshot({ deviceId, previousManifest, revision = null } = {}) {
    return await exportSyncFilesFromState(this.exportNormalizedState(), {
      deviceId,
      previousManifest: ensureManifestShape(previousManifest),
      revision,
      updatedAt: new Date().toISOString(),
    });
  }

  async fullUpload() {
    const lock = await acquireSyncLock("sync-full-upload");
    if (!lock) throw new Error("同步进行中，请稍后再试");
    try {
      await this.provider.ensureDir();
      const deviceId = await getDeviceId();
      const remoteManifest = await this.readRemoteManifest();
      const baseline = ensureManifestShape(remoteManifest) || ensureManifestShape(await readLocalManifestCache()) || ensureManifestShape(createEmptyManifest());
      const local = await this.createLocalSnapshot({
        deviceId,
        previousManifest: baseline,
        revision: Math.max(0, asNumber(remoteManifest?.revision, 0)) + 1,
      });
      for (const name of SYNC_FILE_NAMES) await this.provider.writeText(name, local.files[name]);
      const echoed = await this.writeRemoteManifest(local.manifest);
      await writeLocalManifestCache(echoed);
      const meta = await getSyncMeta();
      await setSyncMeta({
        ...meta,
        lastSyncAt: new Date().toISOString(),
        lastResult: "全量上传完成",
        lastMode: "FORCED_UPLOAD",
      });
      return { message: "全量上传完成", conflicts: [], firstSyncMode: FIRST_SYNC_MODE.UPLOAD_LOCAL };
    } finally {
      await releaseSyncLock(lock.token);
    }
  }

  async fullDownload() {
    const lock = await acquireSyncLock("sync-full-download");
    if (!lock) throw new Error("同步进行中，请稍后再试");
    try {
      await this.provider.ensureDir();
      const remoteManifest = await this.readRemoteManifest();
      if (!remoteManifest) throw new Error("云端没有 manifest.json，无法下载");
      const changedFiles = {};
      for (const item of remoteManifest.files) {
        const text = await this.provider.readText(item.name);
        if (typeof text === "string") changedFiles[item.name] = text;
      }
      const mergeResult = mergeSyncFilesToState(this.exportNormalizedState(), changedFiles);
      const merged = mergeResult.state;
      const normalized = this.normalizeState(merged);
      await this.replaceStateFromSync(normalized, {
        source: "sync-full-download",
        changedFiles: Object.keys(changedFiles),
      });
      await writeLocalManifestCache(remoteManifest);
      const meta = await getSyncMeta();
      await setSyncMeta({
        ...meta,
        lastSyncAt: new Date().toISOString(),
        lastResult: "云端下载恢复完成",
        lastMode: "FORCED_DOWNLOAD",
      });
      return { message: "云端下载恢复完成", conflicts: [], firstSyncMode: FIRST_SYNC_MODE.DOWNLOAD_REMOTE };
    } finally {
      await releaseSyncLock(lock.token);
    }
  }

  async syncNow() {
    const lock = await acquireSyncLock("sync-now");
    if (!lock) throw new Error("同步进行中，请稍后再试");
    try {
      await this.provider.ensureDir();
      const deviceId = await getDeviceId();
      const emptyManifest = await this.buildEmptyManifest(deviceId);
      const cachedManifest = ensureManifestShape(await readLocalManifestCache());
      const remoteManifest = ensureManifestShape(await this.readRemoteManifest());
      const localSnapshot = await this.createLocalSnapshot({
        deviceId,
        previousManifest: cachedManifest || remoteManifest || emptyManifest,
        revision: cachedManifest?.revision || remoteManifest?.revision || 0,
      });

      const firstSyncMode = this.decideFirstSyncMode(localSnapshot.manifest, remoteManifest, emptyManifest);
      const baseManifest = cachedManifest || emptyManifest;
      const remoteBase = remoteManifest || emptyManifest;
      const localMap = manifestMap(localSnapshot.manifest);
      const remoteMap = manifestMap(remoteBase);
      const baseMap = manifestMap(baseManifest);
      const downloadNames = new Set();
      const downloadedFiles = {};
      const smartMergeNames = new Set();
      const conflicts = [];

      for (const name of SYNC_FILE_NAMES) {
        const localEntry = localMap.get(name);
        const remoteEntry = remoteMap.get(name);
        const baseEntry = baseMap.get(name);

        const localChanged = !sameFile(localEntry, baseEntry);
        const remoteChanged = !sameFile(remoteEntry, baseEntry);

        if (!localChanged && remoteChanged) {
          downloadNames.add(name);
          continue;
        }
        if (localChanged && !remoteChanged) continue;
        if (!localChanged && !remoteChanged) continue;
        if (sameFile(localEntry, remoteEntry)) continue;

        const remoteText = await this.provider.readText(name);
        if (typeof remoteText === "string") {
          const localBackupPath = await saveConflictBackup(`local-${name}`, localSnapshot.files[name], {
            reason: "双端冲突，智能合并前保留本地版本",
            localUpdatedAt: localEntry?.updatedAt || "",
            remoteUpdatedAt: remoteEntry?.updatedAt || "",
          });
          const remoteBackupPath = await saveConflictBackup(`remote-${name}`, remoteText, {
            reason: "双端冲突，智能合并前保留云端版本",
            localUpdatedAt: localEntry?.updatedAt || "",
            remoteUpdatedAt: remoteEntry?.updatedAt || "",
          });
          downloadedFiles[name] = remoteText;
          smartMergeNames.add(name);
          conflicts.push({
            name,
            strategy: "smart-merge",
            localPath: localBackupPath,
            remotePath: remoteBackupPath,
          });
        }
      }

      for (const name of downloadNames) {
        const text = await this.provider.readText(name);
        if (typeof text === "string") downloadedFiles[name] = text;
      }
      if (Object.keys(downloadedFiles).length) {
        const mergeResult = mergeSyncFilesToState(this.exportNormalizedState(), downloadedFiles, { smartMergeFiles: smartMergeNames });
        mergeResult.conflicts.forEach((item) => conflicts.push({
          name: item.file,
          strategy: "kept-local-field",
          item: item.item,
          field: item.field,
          local: item.local,
          remote: item.remote,
        }));
        const merged = mergeResult.state;
        const normalized = this.normalizeState(merged);
        await this.replaceStateFromSync(normalized, {
          source: "sync-download",
          changedFiles: Object.keys(downloadedFiles),
          firstSyncMode,
        });
      }

      const postDownload = await this.createLocalSnapshot({
        deviceId,
        previousManifest: remoteBase,
        revision: Math.max(asNumber(remoteBase.revision, 0), asNumber(baseManifest.revision, 0)),
      });
      const postMap = manifestMap(postDownload.manifest);
      const uploadNames = [];
      for (const name of SYNC_FILE_NAMES) {
        if (!sameFile(postMap.get(name), remoteMap.get(name))) uploadNames.push(name);
      }

      for (const name of uploadNames) {
        await this.provider.writeText(name, postDownload.files[name]);
      }

      const remoteRevision = asNumber(remoteBase.revision, 0);
      const baseRevision = asNumber(baseManifest.revision, 0);
      const changed = uploadNames.length > 0 || Object.keys(downloadedFiles).length > 0 || !remoteManifest;
      const finalManifest = ensureManifestShape({
        ...postDownload.manifest,
        revision: changed ? Math.max(remoteRevision, baseRevision) + 1 : remoteRevision,
        updatedAt: changed ? new Date().toISOString() : remoteBase.updatedAt,
        updatedByDevice: changed ? deviceId : (remoteBase.updatedByDevice || deviceId),
      });

      const verifiedManifest = await this.writeRemoteManifest(finalManifest);
      await writeLocalManifestCache(verifiedManifest);
      const meta = await getSyncMeta();
      await setSyncMeta({
        ...meta,
        lastSyncAt: new Date().toISOString(),
        lastResult: conflicts.length ? `同步完成，发现 ${conflicts.length} 个冲突` : "同步完成",
        lastMode: firstSyncMode,
      });

      const suffix = conflicts.length ? `，已生成 ${conflicts.length} 个冲突备份` : "";
      return {
        message: `同步完成（${firstSyncMode}）${suffix}`,
        conflicts,
        firstSyncMode,
        downloaded: Object.keys(downloadedFiles),
        uploaded: uploadNames,
      };
    } finally {
      await releaseSyncLock(lock.token);
    }
  }
}
