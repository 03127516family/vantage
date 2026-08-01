"use strict";
// Vantage —— Codex 账户额度采集（wham/usage）。只读、只取额度数值，绝不传 PII。
// 被 reconcile 每轮调用一次（1h 节流，见 reconcile.cjs），结果贴到当轮所有 Codex 记录的 quota 字段。
// wham 是非公开接口：低频调用 + 任何失败返回 null（靠服务端粘性合并沿用上次值，不阻塞采集）。
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const https = require("node:https");
const http = require("node:http");
const net = require("node:net");
const tls = require("node:tls");
const { spawnSync } = require("node:child_process");
const core = require("./core.cjs");

const AUTH_PATH = path.join(os.homedir(), ".codex", "auth.json");
const ENDPOINT = "https://chatgpt.com/backend-api/wham/usage";
const ENDPOINT_HOST = "chatgpt.com";
const ENDPOINT_PATH = "/backend-api/wham/usage";
const TIMEOUT_MS = 30000;

/**
 * 从环境变量挑代理 URL。顺序：HTTPS_PROXY > HTTP_PROXY > ALL_PROXY（大小写都认）。
 * 纯函数，便于测试。
 */
function pickProxyFromEnv(env) {
  const e = env || {};
  return (
    e.HTTPS_PROXY || e.https_proxy ||
    e.HTTP_PROXY || e.http_proxy ||
    e.ALL_PROXY || e.all_proxy ||
    ""
  );
}

/**
 * 解析 Windows 注册表 Internet Settings 的系统代理。
 * enable=0 或 server 空 → ""。
 * server 可能是 "127.0.0.1:7890" 或 "http=h;https=s" 多协议格式 → 取 https（无则取首个）。
 * 结果归一成带 http:// scheme 的 URL。纯函数，便于测试。
 */
function parseWinRegistryProxy({ enable, server } = {}) {
  if (!enable || !server) return "";
  const parts = String(server).split(";").map((s) => s.trim()).filter(Boolean);
  let candidate = "";
  for (const p of parts) {
    const m = /^([a-z]+)=(.+)$/i.exec(p);
    if (m) {
      if (/^https$/i.test(m[1])) candidate = m[2]; // https 优先（wham 走 443）
      else if (!candidate) candidate = m[2];
    } else if (!candidate) {
      candidate = p;
    }
  }
  if (!candidate) return "";
  return /^https?:\/\//i.test(candidate) ? candidate : "http://" + candidate;
}

/**
 * 读 Windows 注册表里的系统代理（Clash/v2ray「设为系统代理」就写这里）。
 * 只在 win32 跑；reg query 隐藏执行、只读、5s 超时；任何失败返回 {}。
 * Codex(走系统代理)能连 chatgpt 时，这里就能拿到同一个代理。
 */
function readWinSystemProxy() {
  if (process.platform !== "win32") return {};
  try {
    const out = spawnSync(
      "reg",
      ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings"],
      { windowsHide: true, encoding: "utf8", timeout: 5000 }
    );
    const text = (out && out.stdout) || "";
    let enable = 0;
    let server = "";
    const em = /ProxyEnable\s+REG_\S+\s+(\S+)/i.exec(text);
    if (em) enable = parseInt(em[1], em[1].startsWith("0x") ? 16 : 10) || 0;
    const sm = /ProxyServer\s+REG_SZ\s+(.+)/i.exec(text);
    if (sm) server = sm[1].trim();
    return { enable, server };
  } catch {
    return {};
  }
}

/**
 * 选择 wham 请求该走的代理：env(HTTPS_PROXY/HTTP_PROXY/ALL_PROXY) 优先，
 * 否则 win32 读系统代理注册表。其余平台/无代理返回 ""。readRegistry 可注入便于测试。
 */
function readProxy(options = {}) {
  const fromEnv = pickProxyFromEnv(options.env || process.env);
  if (fromEnv) return fromEnv;
  if ((options.platform || process.platform) !== "win32") return "";
  const readRegistry = options.readRegistry || readWinSystemProxy;
  try {
    return parseWinRegistryProxy(readRegistry());
  } catch {
    return "";
  }
}

function readAuth() {
  try {
    const a = JSON.parse(fs.readFileSync(AUTH_PATH, "utf8"));
    const t = a.tokens || {};
    return { accessToken: t.access_token, accountId: t.account_id };
  } catch {
    return {};
  }
}

/**
 * 拉取 Codex 账户当前额度。
 * 成功返回 wham/usage 的完整响应 + observed_at；
 * 任何失败（无凭证 / 网络 / 非200 / 解析错 / 无 rate_limit）返回 null，绝不抛。
 * 服务端应从 rate_limit.primary_window 解析已用百分比。
 * 注意：完整响应包含 user_id / email，服务端必须在入库前脱敏或丢弃。
 * observed_at 为本次测量时刻。
 */
function fetchCodexQuota() {
  return new Promise((resolve) => {
    const { accessToken, accountId } = readAuth();
    if (!accessToken) {
      core.log("quota: 无 codex access_token，跳过");
      resolve(null);
      return;
    }
    const headers = {
      Authorization: "Bearer " + accessToken,
      Accept: "application/json",
      "User-Agent": "codex-cli/1.0",
    };
    if (accountId) headers["chatgpt-account-id"] = accountId;

    // 响应处理：直连和代理隧道共用（都是 IncomingMessage）。
    const onResponse = (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        if (res.statusCode !== 200) {
          core.log(`quota: wham 非200 status=${res.statusCode}`);
          resolve(null);
          return;
        }
        try {
          const d = JSON.parse(body);
          if (!d.rate_limit || d.rate_limit.primary_window == null) {
            core.log("quota: wham 响应无 rate_limit/primary_window");
            resolve(null);
            return;
          }
          resolve({ ...d, observed_at: new Date().toISOString() });
        } catch (e) {
          core.log("quota: wham 解析失败 " + String(e));
          resolve(null);
        }
      });
    };

    const proxy = readProxy();
    if (!proxy) {
      // 直连（无代理环境/系统代理）
      const req = https.request(ENDPOINT, { method: "GET", headers, timeout: TIMEOUT_MS }, onResponse);
      req.on("timeout", () => {
        req.destroy();
        core.log("quota: wham 超时");
        resolve(null);
      });
      req.on("error", (e) => {
        core.log("quota: wham 请求失败 " + String(e));
        resolve(null);
      });
      req.end();
      return;
    }
    // 走代理：CONNECT 隧道 → TLS → HTTP 请求（Codex 能通 chatgpt 时,这条也通）
    requestViaProxy(proxy, headers, onResponse, resolve);
  });
}

/**
 * 经 HTTP 代理 CONNECT 隧道发 wham 请求。纯 Node 实现，不依赖外部包。
 * 任何阶段失败（连代理 / CONNECT 被拒 / TLS / 超时 / 请求错）都 resolve(null) + 写日志，绝不抛。
 */
function requestViaProxy(proxyUrl, headers, onResponse, resolve) {
  const fail = (label, e) => {
    core.log(`quota: wham ${label} ${String((e && e.message) || e)}`);
    resolve(null);
  };
  let u;
  try {
    u = new URL(proxyUrl);
  } catch {
    fail("代理 URL 无效", new Error(proxyUrl));
    return;
  }
  const sock = net.connect(parseInt(u.port || "80", 10), u.hostname);
  sock.setTimeout(TIMEOUT_MS);
  sock.on("timeout", () => {
    sock.destroy();
    fail("代理超时", new Error("timeout"));
  });
  sock.on("error", (e) => fail("代理连接失败", e));
  sock.once("connect", () => {
    let line = `CONNECT ${ENDPOINT_HOST}:443 HTTP/1.1\r\nHost: ${ENDPOINT_HOST}:443\r\n`;
    if (u.username) {
      line +=
        "Proxy-Authorization: Basic " +
        Buffer.from(decodeURIComponent(u.username) + ":" + decodeURIComponent(u.password || "")).toString("base64") +
        "\r\n";
    }
    sock.write(line + "\r\n");
  });
  let buf = "";
  sock.on("data", function onData(d) {
    buf += d.toString();
    if (!buf.includes("\r\n\r\n")) return;
    sock.removeListener("data", onData);
    if (!/^HTTP\/1\.[01] 200/.test(buf)) {
      sock.destroy();
      fail("代理拒绝 CONNECT", new Error(buf.split("\r\n")[0]));
      return;
    }
    const tlsSock = tls.connect({ socket: sock, servername: ENDPOINT_HOST }, () => {
      const req = http.request(
        {
          host: ENDPOINT_HOST,
          path: ENDPOINT_PATH,
          method: "GET",
          headers,
          timeout: TIMEOUT_MS,
          createConnection: () => tlsSock,
        },
        onResponse
      );
      req.on("timeout", () => {
        req.destroy();
        fail("超时", new Error("timeout"));
      });
      req.on("error", (e) => fail("请求失败", e));
      req.end();
    });
    tlsSock.on("error", (e) => fail("TLS 失败", e));
  });
}

/**
 * 选择本轮真正贴到记录上的 quota：本轮拉到新值就用新值；
 * 否则在保质期内沿用上次缓存的值（网络抖动/节流跳过时，记录照样带 quota）；
 * 缓存过保质期或从无缓存时返回 null。纯函数，不产生任何子进程/窗口。
 */
function pickQuota(fetched, cached, maxAgeMs, now = Date.now()) {
  if (fetched) return fetched;
  if (
    cached &&
    cached.value &&
    Number.isFinite(Number(cached.at)) &&
    now - Number(cached.at) <= maxAgeMs
  ) {
    return cached.value;
  }
  return null;
}

module.exports = { fetchCodexQuota, pickQuota, pickProxyFromEnv, parseWinRegistryProxy, readProxy };
