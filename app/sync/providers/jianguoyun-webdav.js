import { httpRequest, secrets } from "../state.js";
import { MANIFEST_FILE, SYNC_ROOT_DIR } from "../types.js";

function trimSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

function auth(username, password) {
  return `Basic ${btoa(unescape(encodeURIComponent(`${username}:${password}`)))}`;
}

function encodePath(path = "") {
  return String(path || "")
    .split("/")
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join("/");
}

function decodePath(path = "") {
  return String(path || "")
    .split("/")
    .filter(Boolean)
    .map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return part;
      }
    })
    .join("/");
}

function textBetween(text, regex, fallback = "") {
  const match = String(text || "").match(regex);
  return match?.[1] || fallback;
}

function statusMessage(status, action, path = "") {
  const label = path ? `${action} ${path}` : action;
  if (status === 401) return `坚果云鉴权失败（401）：${label}`;
  if (status === 404) return `坚果云路径不存在（404）：${label}`;
  if (status === 409) return `坚果云目录冲突（409）：${label}`;
  if (status === 423) return `坚果云资源被锁定（423）：${label}`;
  return `坚果云请求失败（${status}）：${label}`;
}

function parsePropfindEntries(xml = "") {
  const entries = [];
  const blocks = String(xml || "").match(/<(?:d|D):response>[\s\S]*?<\/(?:d|D):response>/g) || [];
  for (const block of blocks) {
    const hrefRaw = textBetween(block, /<(?:d|D):href>([\s\S]*?)<\/(?:d|D):href>/i, "");
    const href = decodePath(hrefRaw).replace(/^https?:\/\/[^/]+/i, "");
    const normalized = href.split("?")[0].replace(/\/+$/, "");
    const name = normalized.split("/").pop() || "";
    const etag = textBetween(block, /<(?:d|D):getetag>([\s\S]*?)<\/(?:d|D):getetag>/i, "");
    const lastModified = textBetween(block, /<(?:d|D):getlastmodified>([\s\S]*?)<\/(?:d|D):getlastmodified>/i, "");
    const sizeRaw = textBetween(block, /<(?:d|D):getcontentlength>([\s\S]*?)<\/(?:d|D):getcontentlength>/i, "");
    const size = Math.max(0, Number(sizeRaw) || 0);
    const isDir = /<(?:d|D):collection\s*\/>/i.test(block) || /<resourcetype>\s*<collection\/?>/i.test(block);
    entries.push({ href: normalized.replace(/^\/+/, ""), name, etag, lastModified, size, isDir });
  }
  return entries;
}

export class JianguoyunWebDavProvider {
  constructor(config) {
    this.config = config;
    this.name = "jianguoyun";
  }

  async credentials() {
    const password = await secrets.get("jianguoyun.password");
    if (!this.config.jianguoyunUsername || !password) throw new Error("坚果云账号或应用密码未配置");
    return { username: this.config.jianguoyunUsername, password };
  }

  baseUrl() {
    return `${trimSlash(this.config.jianguoyunServerUrl || "https://dav.jianguoyun.com/dav")}/${SYNC_ROOT_DIR}`;
  }

  url(path = "") {
    const encoded = encodePath(path);
    return encoded ? `${this.baseUrl()}/${encoded}` : this.baseUrl();
  }

  async request(method, path = "", { body, headers = {}, depth = null } = {}) {
    const { username, password } = await this.credentials();
    const finalHeaders = {
      Authorization: auth(username, password),
      ...headers,
    };
    if (depth !== null) finalHeaders.Depth = String(depth);
    if (typeof body === "string" && !("Content-Type" in finalHeaders) && !("content-type" in finalHeaders)) {
      finalHeaders["Content-Type"] = "application/json; charset=utf-8";
    }
    return await httpRequest(method, this.url(path), { headers: finalHeaders, body });
  }

  async ensureDir() {
    const probe = await this.request("PROPFIND", "", { depth: 0 });
    if ([200, 207].includes(probe.status)) return true;
    if (![404, 409].includes(probe.status) && probe.status >= 400) throw new Error(statusMessage(probe.status, "访问目录"));
    const mkcol = await this.request("MKCOL");
    if ([200, 201, 204, 405].includes(mkcol.status)) return true;
    throw new Error(`${statusMessage(mkcol.status, "创建目录")} ${mkcol.body || ""}`.trim());
  }

  async testConnection() {
    await this.ensureDir();
    await this.readText(MANIFEST_FILE, { noCache: true }).catch((err) => {
      const message = String(err?.message || err || "");
      if (!message.includes("404")) throw err;
      return null;
    });
    return true;
  }

  async readText(path, { noCache = false } = {}) {
    const headers = noCache
      ? {
        "Cache-Control": "no-cache, no-store, must-revalidate",
        Pragma: "no-cache",
        Expires: "0",
      }
      : {};
    const res = await this.request("GET", path, { headers });
    if (res.status === 404) return null;
    if (res.status < 200 || res.status >= 300) throw new Error(statusMessage(res.status, "读取文件", path));
    return res.body || "";
  }

  async writeText(path, text) {
    const res = await this.request("PUT", path, {
      body: String(text || ""),
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
    if (res.status < 200 || res.status >= 300) throw new Error(`${statusMessage(res.status, "写入文件", path)} ${res.body || ""}`.trim());
  }

  async deleteFile(path) {
    const res = await this.request("DELETE", path);
    if ([200, 202, 204, 404].includes(res.status)) return;
    throw new Error(statusMessage(res.status, "删除文件", path));
  }

  async list(path = "") {
    const res = await this.request("PROPFIND", path, {
      depth: 1,
      body: `<?xml version="1.0" encoding="utf-8" ?><d:propfind xmlns:d="DAV:"><d:prop><d:getetag/><d:getlastmodified/><d:getcontentlength/><d:resourcetype/></d:prop></d:propfind>`,
      headers: { "Content-Type": "application/xml; charset=utf-8" },
    });
    if (![200, 207].includes(res.status)) throw new Error(statusMessage(res.status, "列出目录", path || "/"));
    const entries = parsePropfindEntries(res.body);
    return entries.filter((item) => item.name && !item.isDir);
  }

  async stat(path) {
    const res = await this.request("PROPFIND", path, {
      depth: 0,
      body: `<?xml version="1.0" encoding="utf-8" ?><d:propfind xmlns:d="DAV:"><d:prop><d:getetag/><d:getlastmodified/><d:getcontentlength/></d:prop></d:propfind>`,
      headers: { "Content-Type": "application/xml; charset=utf-8" },
    });
    if (res.status === 404) return null;
    if (![200, 207].includes(res.status)) throw new Error(statusMessage(res.status, "读取文件元数据", path));
    const entry = parsePropfindEntries(res.body).find((item) => item.name === path.split("/").pop()) || parsePropfindEntries(res.body)[0];
    if (!entry) {
      return {
        etag: res.etag || "",
        lastModified: res.lastModified || "",
        size: Number(res.size) || 0,
      };
    }
    return {
      etag: entry.etag || res.etag || "",
      lastModified: entry.lastModified || res.lastModified || "",
      size: Number(entry.size) || Number(res.size) || 0,
    };
  }
}
