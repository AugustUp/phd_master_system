export const SYNC_SCHEMA_VERSION = 1;
export const SYNC_ROOT_DIR = "phd-workspace-sync";
export const MANIFEST_FILE = "manifest.json";
export const SYNC_LOCK_TTL_MS = 60 * 1000;

export const FIRST_SYNC_MODE = Object.freeze({
  DOWNLOAD_REMOTE: "DOWNLOAD_REMOTE",
  UPLOAD_LOCAL: "UPLOAD_LOCAL",
  MERGE_BIDIRECTIONAL: "MERGE_BIDIRECTIONAL",
  INIT_EMPTY: "INIT_EMPTY",
});

export const SYNC_FILE_NAMES = [
  "profile.json",
  "tasks.json",
  "projects.json",
  "thesis.json",
  "submissions.json",
  "health.json",
  "care.json",
  "mentor.json",
  "review.json",
];

export const DEFAULT_SYNC_CONFIG = {
  provider: "jianguoyun",
  autoSync: false,
  lastSyncAt: "",
  lastSyncResult: "尚未同步",
  lastSyncMode: "",
  jianguoyunServerUrl: "https://dav.jianguoyun.com/dav/",
  jianguoyunUsername: "",
};
