"use strict";
// Vantage —— Codex 账户额度采集（wham/usage）。只读、只取额度数值，绝不传 PII。
// 被 reconcile 每轮调用一次（1h 节流，见 reconcile.cjs），结果贴到当轮所有 Codex 记录的 quota 字段。
// wham 是非公开接口：低频调用 + 任何失败返回 null（靠服务端粘性合并沿用上次值，不阻塞采集）。
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const https = require("node:https");
const core = require("./core.cjs");

const AUTH_PATH = path.join(os.homedir(), ".codex", "auth.json");
const ENDPOINT = "https://chatgpt.com/backend-api/wham/usage";
const TIMEOUT_MS = 30000;

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

    const req = https.request(ENDPOINT, { method: "GET", headers, timeout: TIMEOUT_MS }, (res) => {
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
          resolve({
            ...d,
            observed_at: new Date().toISOString(),
          });
        } catch (e) {
          core.log("quota: wham 解析失败 " + String(e));
          resolve(null);
        }
      });
    });
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
  });
}

module.exports = { fetchCodexQuota };
