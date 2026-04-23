import { sha256Hex, stableJson } from "./hash.js";
import { MANIFEST_FILE, SYNC_FILE_NAMES, SYNC_SCHEMA_VERSION } from "./types.js";

const TEXT_ENCODER = new TextEncoder();

function byteSize(text) {
  return TEXT_ENCODER.encode(String(text || "")).length;
}

function asIso(value, fallback) {
  const millis = Date.parse(String(value || ""));
  return Number.isFinite(millis) ? new Date(millis).toISOString() : fallback;
}

export function splitState(state) {
  return {
    "profile.json": {
      attendance: state?.attendance || {},
      timeBlocks: state?.timeBlocks || {},
      focus: state?.focus || { active: null, sessions: [] },
      reimb: state?.reimb || { pending: [], done: [] },
    },
    "tasks.json": { tasks: state?.tasks || [] },
    "projects.json": { projects: state?.projects || [] },
    "thesis.json": { thesis: state?.thesis || {} },
    "submissions.json": { submissions: state?.submissions || [] },
    "health.json": {
      habits: state?.habits || {},
      foods: state?.foods || [],
      weights: state?.weights || [],
      mood: state?.mood || {},
    },
    "care.json": { care: state?.care || {} },
    "mentor.json": { mentor: state?.mentor || {} },
    "review.json": {
      reviewDaily: state?.reviewDaily || {},
      reflections: state?.reflections || {},
    },
  };
}

export function manifestMap(manifest) {
  return new Map((manifest?.files || []).map((item) => [item.name, item]));
}

export function createEmptyManifest() {
  return {
    schemaVersion: SYNC_SCHEMA_VERSION,
    revision: 0,
    updatedAt: "1970-01-01T00:00:00.000Z",
    updatedByDevice: "bootstrap",
    files: SYNC_FILE_NAMES.map((name) => ({
      name,
      hash: "",
      size: 0,
      updatedAt: "1970-01-01T00:00:00.000Z",
    })),
  };
}

export async function exportSyncFilesFromState(
  state,
  { deviceId = "", previousManifest = null, revision = null, updatedAt = null } = {},
) {
  const now = asIso(updatedAt, new Date().toISOString());
  const files = {};
  const prevMap = manifestMap(previousManifest);
  const manifestFiles = [];
  const split = splitState(state || {});

  for (const name of SYNC_FILE_NAMES) {
    const content = stableJson(split[name] || {});
    const hash = await sha256Hex(content);
    const prev = prevMap.get(name);
    files[name] = content;
    manifestFiles.push({
      name,
      hash,
      size: byteSize(content),
      updatedAt: prev?.hash === hash ? asIso(prev.updatedAt, now) : now,
    });
  }

  const baseRevision = Number(previousManifest?.revision) || 0;
  const nextRevision = Number.isFinite(Number(revision)) ? Math.max(0, Number(revision)) : baseRevision;
  const manifest = {
    schemaVersion: SYNC_SCHEMA_VERSION,
    revision: nextRevision,
    updatedAt: now,
    updatedByDevice: String(deviceId || previousManifest?.updatedByDevice || ""),
    files: manifestFiles,
  };
  files[MANIFEST_FILE] = stableJson(manifest);
  return { manifest, files };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value ?? null));
}

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function stableItemId(item, prefix, index) {
  if (item?.id) return String(item.id);
  const body = JSON.stringify(item || {});
  let hash = 0;
  for (let i = 0; i < body.length; i += 1) hash = ((hash << 5) - hash + body.charCodeAt(i)) | 0;
  return `${prefix}_${index}_${Math.abs(hash)}`;
}

function valueScore(value) {
  if (value == null || value === "") return 0;
  if (Array.isArray(value)) return value.length ? 2 : 0;
  if (isPlainObject(value)) return Object.keys(value).length ? 2 : 0;
  return 1;
}

function recordScore(item) {
  if (!isPlainObject(item)) return valueScore(item);
  return Object.values(item).reduce((sum, value) => sum + valueScore(value), 0)
    + (item.end ? 8 : 0)
    + (item.updatedAt || item.doneAt || item.completedAt || item.at ? 2 : 0);
}

function mergeRecord(localItem = {}, remoteItem = {}, ctx, label) {
  const local = isPlainObject(localItem) ? localItem : {};
  const remote = isPlainObject(remoteItem) ? remoteItem : {};
  const out = { ...remote, ...local };
  const keys = new Set([...Object.keys(remote), ...Object.keys(local)]);

  for (const key of keys) {
    if (!(key in local)) {
      out[key] = remote[key];
      continue;
    }
    if (!(key in remote)) {
      out[key] = local[key];
      continue;
    }
    const left = local[key];
    const right = remote[key];
    if (JSON.stringify(left) === JSON.stringify(right)) {
      out[key] = left;
      continue;
    }
    if (valueScore(left) === 0 && valueScore(right) > 0) {
      out[key] = right;
      continue;
    }
    if (valueScore(right) === 0 && valueScore(left) > 0) {
      out[key] = left;
      continue;
    }
    if (isPlainObject(left) && isPlainObject(right)) {
      out[key] = mergeRecord(left, right, ctx, `${label}.${key}`);
      continue;
    }
    if (Array.isArray(left) && Array.isArray(right)) {
      out[key] = mergeArrayById(left, right, ctx, `${label}.${key}`);
      continue;
    }
    out[key] = left;
    ctx.conflicts.push({
      file: ctx.file,
      item: label,
      field: key,
      local: left,
      remote: right,
      resolution: "kept-local",
    });
  }
  return out;
}

function chooseRecord(localItem, remoteItem, ctx, label) {
  if (!isPlainObject(localItem) || !isPlainObject(remoteItem)) return localItem ?? remoteItem;
  if (recordScore(remoteItem) > recordScore(localItem)) return mergeRecord(remoteItem, localItem, ctx, label);
  return mergeRecord(localItem, remoteItem, ctx, label);
}

function mergeArrayById(localItems = [], remoteItems = [], ctx, label) {
  const out = [];
  const seen = new Set();
  const localMap = new Map((Array.isArray(localItems) ? localItems : []).map((item, index) => [stableItemId(item, label, index), item]));
  const remoteMap = new Map((Array.isArray(remoteItems) ? remoteItems : []).map((item, index) => [stableItemId(item, label, index), item]));
  const ids = [...new Set([...localMap.keys(), ...remoteMap.keys()])];

  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const localItem = localMap.get(id);
    const remoteItem = remoteMap.get(id);
    if (localItem && remoteItem) {
      const merged = chooseRecord(localItem, remoteItem, ctx, `${label}:${id}`);
      out.push(isPlainObject(merged) ? { id, ...merged } : merged);
    } else {
      out.push(clone(localItem || remoteItem));
    }
  }
  return out;
}

function mergeDatedArrays(localMap = {}, remoteMap = {}, ctx, label) {
  const out = {};
  const dates = new Set([...Object.keys(remoteMap || {}), ...Object.keys(localMap || {})]);
  for (const date of dates) {
    out[date] = mergeArrayById(localMap?.[date] || [], remoteMap?.[date] || [], ctx, `${label}.${date}`);
  }
  return out;
}

function mergeAttendanceDay(localDay = {}, remoteDay = {}, ctx, date) {
  const local = isPlainObject(localDay) ? localDay : {};
  const remote = isPlainObject(remoteDay) ? remoteDay : {};
  return {
    ...remote,
    ...local,
    wake: local.wake || remote.wake || null,
    sleep: local.sleep || remote.sleep || null,
    logs: mergeArrayById(local.logs || [], remote.logs || [], ctx, `attendance.${date}.logs`),
    leaves: mergeArrayById(local.leaves || [], remote.leaves || [], ctx, `attendance.${date}.leaves`),
  };
}

function mergeAttendance(localAttendance = {}, remoteAttendance = {}, ctx) {
  const out = {};
  const dates = new Set([...Object.keys(remoteAttendance || {}), ...Object.keys(localAttendance || {})]);
  for (const date of dates) out[date] = mergeAttendanceDay(localAttendance?.[date], remoteAttendance?.[date], ctx, date);
  return out;
}

function mergeFocus(localFocus = {}, remoteFocus = {}, ctx) {
  return {
    ...remoteFocus,
    ...localFocus,
    active: localFocus?.active || remoteFocus?.active || null,
    sessions: mergeArrayById(localFocus?.sessions || [], remoteFocus?.sessions || [], ctx, "focus.sessions"),
  };
}

function mergeReimb(localReimb = {}, remoteReimb = {}, ctx) {
  return {
    pending: mergeArrayById(localReimb?.pending || [], remoteReimb?.pending || [], ctx, "reimb.pending"),
    done: mergeArrayById(localReimb?.done || [], remoteReimb?.done || [], ctx, "reimb.done"),
  };
}

function mergeProfile(next, value, ctx) {
  if ("attendance" in value) next.attendance = mergeAttendance(next.attendance || {}, value.attendance || {}, ctx);
  if ("timeBlocks" in value) next.timeBlocks = mergeDatedArrays(next.timeBlocks || {}, value.timeBlocks || {}, ctx, "timeBlocks");
  if ("focus" in value) next.focus = mergeFocus(next.focus || { active: null, sessions: [] }, value.focus || {}, ctx);
  if ("reimb" in value) next.reimb = mergeReimb(next.reimb || { pending: [], done: [] }, value.reimb || {}, ctx);
}

function mergeGenericArrayState(next, key, value, ctx) {
  if (key in value) next[key] = mergeArrayById(next[key] || [], value[key] || [], ctx, key);
}

export function mergeSyncFilesToState(currentState, changedFiles, { smartMergeFiles = null } = {}) {
  const next = JSON.parse(JSON.stringify(currentState || {}));
  const mergeConflicts = [];
  const replaceMap = {
    "profile.json": (value) => {
      if ("attendance" in value) next.attendance = value.attendance || {};
      if ("timeBlocks" in value) next.timeBlocks = value.timeBlocks || {};
      if ("focus" in value) next.focus = value.focus || { active: null, sessions: [] };
      if ("reimb" in value) next.reimb = value.reimb || { pending: [], done: [] };
    },
    "tasks.json": (value) => {
      if ("tasks" in value) next.tasks = value.tasks || [];
    },
    "projects.json": (value) => {
      if ("projects" in value) next.projects = value.projects || [];
    },
    "thesis.json": (value) => {
      if ("thesis" in value) next.thesis = value.thesis || {};
    },
    "submissions.json": (value) => {
      if ("submissions" in value) next.submissions = value.submissions || [];
    },
    "health.json": (value) => {
      if ("habits" in value) next.habits = value.habits || {};
      if ("foods" in value) next.foods = value.foods || [];
      if ("weights" in value) next.weights = value.weights || [];
      if ("mood" in value) next.mood = value.mood || {};
    },
    "care.json": (value) => {
      if ("care" in value) next.care = value.care || {};
    },
    "mentor.json": (value) => {
      if ("mentor" in value) next.mentor = value.mentor || {};
    },
    "review.json": (value) => {
      if ("reviewDaily" in value) next.reviewDaily = value.reviewDaily || {};
      if ("reflections" in value) next.reflections = value.reflections || {};
    },
  };
  const mergeMap = {
    "profile.json": (value) => {
      mergeProfile(next, value, { file: "profile.json", conflicts: mergeConflicts });
    },
    "tasks.json": (value) => {
      mergeGenericArrayState(next, "tasks", value, { file: "tasks.json", conflicts: mergeConflicts });
    },
    "projects.json": (value) => {
      mergeGenericArrayState(next, "projects", value, { file: "projects.json", conflicts: mergeConflicts });
    },
    "thesis.json": (value) => {
      if ("thesis" in value) next.thesis = mergeRecord(next.thesis || {}, value.thesis || {}, { file: "thesis.json", conflicts: mergeConflicts }, "thesis");
    },
    "submissions.json": (value) => {
      mergeGenericArrayState(next, "submissions", value, { file: "submissions.json", conflicts: mergeConflicts });
    },
    "health.json": (value) => {
      if ("habits" in value) next.habits = mergeRecord(next.habits || {}, value.habits || {}, { file: "health.json", conflicts: mergeConflicts }, "habits");
      if ("foods" in value) next.foods = mergeArrayById(next.foods || [], value.foods || [], { file: "health.json", conflicts: mergeConflicts }, "foods");
      if ("weights" in value) next.weights = mergeArrayById(next.weights || [], value.weights || [], { file: "health.json", conflicts: mergeConflicts }, "weights");
      if ("mood" in value) next.mood = mergeRecord(next.mood || {}, value.mood || {}, { file: "health.json", conflicts: mergeConflicts }, "mood");
    },
    "care.json": (value) => {
      if ("care" in value) next.care = mergeRecord(next.care || {}, value.care || {}, { file: "care.json", conflicts: mergeConflicts }, "care");
    },
    "mentor.json": (value) => {
      if ("mentor" in value) next.mentor = mergeRecord(next.mentor || {}, value.mentor || {}, { file: "mentor.json", conflicts: mergeConflicts }, "mentor");
    },
    "review.json": (value) => {
      if ("reviewDaily" in value) next.reviewDaily = mergeRecord(next.reviewDaily || {}, value.reviewDaily || {}, { file: "review.json", conflicts: mergeConflicts }, "reviewDaily");
      if ("reflections" in value) next.reflections = mergeRecord(next.reflections || {}, value.reflections || {}, { file: "review.json", conflicts: mergeConflicts }, "reflections");
    },
  };

  for (const name of SYNC_FILE_NAMES) {
    if (!(name in (changedFiles || {}))) continue;
    const raw = changedFiles[name];
    if (typeof raw !== "string" || !raw.trim()) continue;
    let parsed = {};
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(`同步文件解析失败: ${name} (${err?.message || err})`);
    }
    const shouldMerge = smartMergeFiles instanceof Set ? smartMergeFiles.has(name) : Array.isArray(smartMergeFiles) ? smartMergeFiles.includes(name) : !!smartMergeFiles;
    if (shouldMerge) mergeMap[name]?.(parsed || {});
    else replaceMap[name]?.(parsed || {});
  }
  return { state: next, conflicts: mergeConflicts };
}

export function applySyncFilesToState(currentState, changedFiles) {
  return mergeSyncFilesToState(currentState, changedFiles).state;
}
