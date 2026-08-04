// GET /installs/view: 安装情况总览(已安装/未安装/已使用/安装率,按部门分组)。
// 数据来自三处 join:
//   - installs/<pinyin>.json (每人一条安装记录)
//   - roster.json (全员名册 + 部门)
//   - state/index.jsonl (有会话记录 = 已使用)
// 低频接口(管理员偶尔看),不做缓存,每次现算。
const GET_CONCURRENCY = 50;

export async function installsView(deps) {
  const p = deps.prefix;

  // 1. LIST 全部 installs 文件
  const list = await deps.list(`${p}installs/`);
  if (list.status !== 200) return { code: 502, body: { ok: false, error: "list installs failed" } };
  const installKeys = list.keys.filter((k) => k.endsWith(".json"));

  // 2. 并发 GET 每个 install 文件
  const installs = [];
  for (let i = 0; i < installKeys.length; i += GET_CONCURRENCY) {
    const batch = await Promise.all(installKeys.slice(i, i + GET_CONCURRENCY).map((k) => deps.get(k)));
    for (const r of batch) {
      if (r.status !== 200) continue;
      try {
        installs.push(JSON.parse(r.body));
      } catch { /* 跳过损坏 */ }
    }
  }

  // 3. GET roster
  const rosterRes = await deps.get(`${p}roster.json`);
  if (rosterRes.status !== 200) return { code: 503, body: { ok: false, error: "roster unavailable" } };
  let roster;
  try {
    roster = JSON.parse(rosterRes.body);
  } catch {
    return { code: 503, body: { ok: false, error: "roster invalid" } };
  }
  const people = roster.people ?? [];

  // 4. GET state/index.jsonl,收集"见过会话的 name 集合"
  const activeNames = new Set();
  const indexRes = await deps.get(`${p}state/index.jsonl`);
  if (indexRes.status === 200) {
    for (const line of indexRes.body.split("\n")) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line);
        if (rec.name) activeNames.add(rec.name);
      } catch { /* 跳过 */ }
    }
  }

  // 5. join: 按部门分组
  const installMap = new Map(); // name -> installed_at
  for (const inst of installs) {
    if (!inst.name) continue;
    const prev = installMap.get(inst.name);
    if (!prev || (inst.installed_at && inst.installed_at < prev)) {
      installMap.set(inst.name, inst.installed_at);
    }
  }

  const deptMap = new Map(); // department -> { total, installed, active, not_installed[] }
  const installedList = [];

  for (const person of people) {
    const dept = person.department || "未分组";
    if (!deptMap.has(dept)) {
      deptMap.set(dept, { department: dept, total: 0, installed: 0, active: 0, not_installed: [] });
    }
    const d = deptMap.get(dept);
    d.total += 1;

    const installedAt = installMap.get(person.name);
    if (installedAt) {
      d.installed += 1;
      const isActive = activeNames.has(person.name);
      if (isActive) d.active += 1;
      installedList.push({
        name: person.name,
        department: dept,
        installed_at: installedAt,
        active: isActive,
      });
    } else {
      d.not_installed.push(person.name);
    }
  }

  // 兜底: 有安装记录但不在 roster 的人(已离职/罕见)单独列出,department=null
  for (const [name, installedAt] of installMap) {
    if (people.some((p) => p.name === name)) continue;
    const isActive = activeNames.has(name);
    installedList.push({
      name,
      department: null, // 不在名册
      installed_at: installedAt,
      active: isActive,
    });
  }

  const totalRoster = people.length;
  const totalInstalled = installMap.size;
  const byDepartment = [...deptMap.values()].map((d) => ({
    ...d,
    install_rate: d.total > 0 ? d.installed / d.total : 0,
  }));

  return {
    code: 200,
    body: {
      total_roster: totalRoster,
      total_installed: totalInstalled,
      install_rate: totalRoster > 0 ? totalInstalled / totalRoster : 0,
      by_department: byDepartment,
      installed_list: installedList,
      generated_at: new Date().toISOString(),
    },
  };
}
