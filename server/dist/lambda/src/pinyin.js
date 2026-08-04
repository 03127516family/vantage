// 把姓名转成 S3 key 安全的拼音串(无空格、无中文、小写)。
// 与 plugin/agent/core.cjs 的 redact() 一样,是"两端各自实现"的工具函数:
// 服务端不能 require 插件代码,所以这里独立实现一份。
import { pinyin } from "pinyin-pro";

export function toPinyin(name) {
  if (!name) return "unknown";
  // 纯 ASCII(英文/数字/空格/连字符): 直接拼接,避免 pinyin-pro 把英文误判为拼音
  // (pinyin("John") 会返回 "ohn",因为 "J" 被剥掉)
  if (/^[A-Za-z0-9\s_-]+$/.test(name)) {
    return name.toLowerCase().replace(/[^a-z0-9]/g, "") || "unknown";
  }
  try {
    return pinyin(name, { toneType: "none", type: "array" }).join("").replace(/[^a-z0-9]/g, "") || "unknown";
  } catch {
    return name.replace(/[^A-Za-z0-9_-]/g, "") || "unknown";
  }
}
