// POST /install: 登记员工安装。极简 schema { name, installed_at }。
// 重复安装保留较小 installed_at (首次安装时刻优先)。失败 502 让插件下轮重试。
import { toPinyin } from "../src/pinyin.js";

export async function install(body, deps) {
  const name = (body?.name ?? "").trim();
  if (!name) return { code: 400, body: { ok: false, error: "name required" } };
  // 防御:姓名长度上限(中文 ≤ 32 字,英文 ≤ 64 字符)。防注入/异常输入撑爆 S3 key。
  if (name.length > 64) return { code: 400, body: { ok: false, error: "name too long" } };

  const key = `${deps.prefix}installs/${toPinyin(name)}.json`;
  const now = new Date().toISOString();

  // 读现有记录: 有则取较小 installed_at
  let installedAt = now;
  try {
    const r = await deps.get(key);
    if (r.status === 200) {
      const prev = JSON.parse(r.body);
      if (prev.installed_at && prev.installed_at < now) installedAt = prev.installed_at;
    }
  } catch {
    /* 读失败当作首次安装 */
  }

  const put = await deps.put(key, JSON.stringify({ name, installed_at: installedAt }));
  if (put.status < 200 || put.status >= 300) {
    return { code: 502, body: { ok: false, error: "s3 put failed" } };
  }
  return { code: 200, body: { ok: true, installed_at: installedAt } };
}
