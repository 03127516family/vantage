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
const TIMEOUT_MS = 8000;

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
 * 成功返回 { plan_type, used_percent, limit_reached, reset_at, observed_at }；
 * 任何失败（无凭证 / 网络 / 非200 / 解析错 / 无 used_percent）返回 null，绝不抛。
 * reset_at 由 wham 的 Unix 秒转 ISO；observed_at 为本次测量时刻。
 * 绝不返回 email / user_id / account_id。
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
          const pw = d.rate_limit && d.rate_limit.primary_window;
          const used = pw && pw.used_percent != null ? Number(pw.used_percent) : null;
          if (used == null || Number.isNaN(used)) {
            core.log("quota: wham 响应无 used_percent");
            resolve(null);
            return;
          }
          resolve({
            plan_type: d.plan_type || null,
            used_percent: used,
            limit_reached: !!(d.rate_limit && d.rate_limit.limit_reached),
            reset_at: pw && pw.reset_at ? new Date(pw.reset_at * 1000).toISOString() : null,
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
