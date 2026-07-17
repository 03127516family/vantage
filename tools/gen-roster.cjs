#!/usr/bin/env node
"use strict";
// Vantage —— 花名册生成器（零依赖纯 Node，同 agent 风格）。
// 拿行政发的《XX通讯录.xlsx》重新生成 plugin/roster.json（姓名→部门，setup 自动填部门用）。
// 用法: node tools/gen-roster.cjs <通讯录.xlsx> [输出路径=plugin/roster.json]
// 口径（与首次生成一致）：取「全员」表；序号列为数字的才算人；部门为空或「/」（高管）不入册。
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

// ---------- 最小 zip 读取（xlsx 就是个 zip，免装 unzip 依赖） ----------
function unzip(buf) {
  // 从尾部找 End of Central Directory（签名 0x06054b50）
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("不是有效的 xlsx/zip 文件");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16); // 中央目录起始偏移
  const files = {};
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("中央目录损坏");
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    // 本地文件头：跳过其自己的文件名/扩展区才是数据
    const ln = buf.readUInt16LE(localOff + 26);
    const le = buf.readUInt16LE(localOff + 28);
    const start = localOff + 30 + ln + le;
    const raw = buf.subarray(start, start + csize);
    files[name] = method === 0 ? raw : zlib.inflateRawSync(raw);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

// ---------- 最小 xlsx 解析（正则抠 XML，够用即可） ----------
function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function parseSharedStrings(xml) {
  const out = [];
  for (const m of xml.matchAll(/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g)) {
    let s = "";
    for (const t of m[1].matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) s += decodeEntities(t[1]);
    out.push(s);
  }
  return out;
}

// 在 workbook.xml 里找「全员」表对应的 sheetN.xml；找不到就退回第一个表
function findSheetPath(files, wanted) {
  const wb = files["xl/workbook.xml"].toString("utf8");
  const rels = files["xl/_rels/workbook.xml.rels"].toString("utf8");
  const relMap = {};
  for (const m of rels.matchAll(/<Relationship\s[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g))
    relMap[m[1]] = m[2];
  let first = null;
  for (const m of wb.matchAll(/<sheet\s[^>]*name="([^"]+)"[^>]*r:id="([^"]+)"/g)) {
    const p = "xl/" + relMap[m[2]].replace(/^\//, "");
    if (!first) first = p;
    if (decodeEntities(m[1]) === wanted) return p;
  }
  return first;
}

function parseRows(xml, strings) {
  const rows = [];
  for (const rm of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = {};
    for (const cm of rm[1].matchAll(/<c\s([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1];
      const ref = /r="([A-Z]+)\d+"/.exec(attrs);
      const v = cm[2] && /<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/.exec(cm[2]);
      if (!ref || !v) continue;
      cells[ref[1]] = /t="s"/.test(attrs) ? strings[Number(v[1])] : decodeEntities(v[1]);
    }
    rows.push(cells);
  }
  return rows;
}

// ---------- 主流程 ----------
const [src, dst = path.join(__dirname, "..", "plugin", "roster.json")] = process.argv.slice(2);
if (!src) {
  console.log("用法: node tools/gen-roster.cjs <通讯录.xlsx> [输出路径]");
  process.exit(1);
}

const files = unzip(fs.readFileSync(src));
const strings = files["xl/sharedStrings.xml"]
  ? parseSharedStrings(files["xl/sharedStrings.xml"].toString("utf8"))
  : [];
const sheetPath = findSheetPath(files, "全员");
const rows = parseRows(files[sheetPath].toString("utf8"), strings);

const people = [];
const skipped = [];
for (const r of rows) {
  if (!/^\d+$/.test((r.A || "").trim())) continue; // 序号列非数字：标题/表头/表尾杂项
  const name = (r.B || "").trim();
  const department = (r.C || "").trim();
  if (!name) continue;
  if (!department || department === "/") {
    skipped.push(name); // 高管「/」与无部门者不入册（按公司口径）
    continue;
  }
  people.push({ name, department });
}

const out = {
  _comment:
    "由公司通讯录生成(全员表);setup.cjs 用它做 姓名→部门 自动填充。人员变动时用 tools/gen-roster.cjs 重新生成。",
  company: "德工机械",
  source: path.basename(src),
  generated_at: new Date().toISOString().slice(0, 10),
  people,
};
fs.writeFileSync(dst, JSON.stringify(out, null, 2) + "\n");

const byDept = {};
for (const p of people) byDept[p.department] = (byDept[p.department] || 0) + 1;
console.log(`✓ 已生成 ${dst}`);
console.log(`  共 ${people.length} 人：${Object.entries(byDept).map(([d, n]) => `${d} ${n}`).join(" / ")}`);
if (skipped.length) console.log(`  不入册（部门为空或「/」）：${skipped.join("、")}`);
