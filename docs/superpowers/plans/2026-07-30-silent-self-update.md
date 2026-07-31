# 无感自更新实施计划

> **执行要求：** 必须使用 `superpowers:executing-plans` 逐项实施，并用复选框记录进度。

**目标：** 让 Vantage 在后台完成 marketplace 刷新、插件下载、生效缓存校验、稳定 Agent 原子同步和任务修复，整个过程无窗口、无提示、失败可回滚。

**架构：** 新增独立的 `self-update.cjs`，集中负责已安装插件解析、完整目录哈希、事务同步、CLI 超时和更新锁。`reconcile.cjs` 只负责按来源节流并静默启动稳定更新器；`win-verify.cjs` 负责证明更新链路每一层真实一致。

**技术栈：** Node.js CommonJS、内置 `fs/path/os/crypto/child_process`、Windows WScript/VBScript、现有单文件测试框架。

---

### 任务一：新增可测试的插件激活与目录同步模块

**文件：**

- 新建：`plugin/agent/self-update.cjs`
- 修改：`tests/agent.test.cjs`

- [x] **步骤 1：先写失败测试**

在 `tests/agent.test.cjs` 中创建临时 HOME、两个缓存版本和
`installed_plugins.json`，要求以下接口存在并满足行为：

```js
const updater = require(path.join(AGENT, "self-update.cjs"));
const active = updater.resolveInstalledPlugin(home, "vantage@dgcrane");
ok(active.version === "1.4.14", "按安装记录选择生效版本");
ok(active.installPath === activeDir, "不按缓存目录最大版本猜测");

const before = updater.treeDigest(oldAgent);
const source = updater.treeDigest(newAgent);
ok(before !== source, "同修改时间、不同内容得到不同摘要");

const result = updater.activateInstalledAgent({
  home,
  pluginId: "vantage@dgcrane",
});
ok(result.changed === true, "内容不同时激活新 Agent");
ok(updater.treeDigest(stableAgent) === source, "稳定副本与生效缓存摘要一致");
```

同时覆盖清单版本不一致、必要文件缺失、内容一致不替换以及人为制造激活失败后旧目录仍完整。

- [x] **步骤 2：运行测试并确认正确失败**

运行：

```bash
node tests/agent.test.cjs
```

预期：失败原因为 `self-update.cjs` 或目标导出函数不存在。

- [x] **步骤 3：实现最小同步模块**

`plugin/agent/self-update.cjs` 导出：

```js
module.exports = {
  treeDigest,
  resolveInstalledPlugin,
  activateAgentTree,
  activateInstalledAgent,
  acquireUpdateLock,
  releaseUpdateLock,
};
```

实现要求：

- 摘要包含所有相对文件名和文件内容；
- 以安装记录和插件清单双重校验版本；
- 临时目录复制后先验哈希；
- `stable -> backup`、`stage -> stable`；
- 任何失败恢复 backup；
- 锁通过 `fs.openSync(lockPath, "wx")` 获取。

- [x] **步骤 4：运行测试并确认通过**

```bash
node tests/agent.test.cjs
```

预期：新增同步测试全部通过，既有测试不回退。

- [x] **步骤 5：提交**

```bash
git add -f plugin/agent/self-update.cjs tests/agent.test.cjs
git commit -m "feat(plugin): add transactional agent activation"
```

### 任务二：实现带超时的静默官方 CLI 更新器

**文件：**

- 修改：`plugin/agent/self-update.cjs`
- 修改：`plugin/agent/core.cjs`
- 修改：`tests/agent.test.cjs`

- [x] **步骤 1：先写失败测试**

测试期望更新器严格执行：

```js
const calls = [];
const result = updater.runOfficialUpdate({
  marketplace: "dgcrane",
  pluginId: "vantage@dgcrane",
  runCli(command, args, options) {
    calls.push({ command, args, options });
    return { status: 0, stdout: "ok", stderr: "" };
  },
});
ok(calls[0].args.includes("marketplace") && calls[0].args.includes("update"), "先刷新 marketplace");
ok(calls[1].args.includes("plugin") && calls[1].args.includes("update"), "再更新插件");
ok(calls.every((c) => c.options.windowsHide === true), "所有 CLI 子进程隐藏");
ok(calls.every((c) => c.options.timeout > 0), "所有 CLI 子进程有超时");
ok(calls.every((c) => c.options.env.GIT_TERMINAL_PROMPT === "0"), "禁止 Git 交互");
```

再测试第一条失败时不执行第二条、第二条失败时不激活、输出日志只保留有限尾部。

- [x] **步骤 2：确认测试失败**

```bash
node tests/agent.test.cjs
```

预期：失败原因为 `runOfficialUpdate` 尚未实现。

- [x] **步骤 3：实现 CLI 执行和隐藏启动**

`self-update.cjs` 增加：

```js
function runOfficialUpdate(options) {
  // marketplace update 成功后才运行 plugin update；
  // 每条命令使用 windowsHide、ignore stdin、捕获输出和有限 timeout。
}

function runUpdateAndActivate(options) {
  // 获取锁 -> 官方更新 -> 解析生效记录 -> 事务激活 -> 修复触发器 -> 记日志。
}
```

`core.cjs` 增加一个只负责静默启动稳定 Node 脚本的助手。Windows 使用
UTF-16LE VBS 和窗口样式 `0`；其他平台使用 `spawn(process.execPath, ...)`，
均为 detached、`stdio: "ignore"`、`windowsHide: true`。

- [x] **步骤 4：确认全部测试通过**

```bash
node tests/agent.test.cjs
node --check plugin/agent/self-update.cjs
node --check plugin/agent/core.cjs
```

- [x] **步骤 5：提交**

```bash
git add -f plugin/agent/self-update.cjs plugin/agent/core.cjs tests/agent.test.cjs
git commit -m "feat(plugin): run official updates silently with timeout"
```

### 任务三：接入 SessionStart 与每日计划任务兜底

**文件：**

- 修改：`plugin/agent/reconcile.cjs`
- 修改：`tests/agent.test.cjs`

- [x] **步骤 1：先写失败测试**

将触发决策抽成纯函数并测试：

```js
ok(shouldCheckForUpdate({
  source: "plugin",
  elapsedMs: 2 * 3600 * 1000,
}), "插件路径两小时检查");

ok(shouldCheckForUpdate({
  source: "stable",
  trigger: "scheduled",
  elapsedMs: 24 * 3600 * 1000,
}), "稳定计划任务每天兜底");

ok(!shouldCheckForUpdate({
  source: "stable",
  trigger: "event",
  elapsedMs: 48 * 3600 * 1000,
}), "文件事件不触发更新");
```

测试必须证明触发函数只静默派生
`~/.vantage/agent/self-update.cjs --check`，不等待更新完成。

- [x] **步骤 2：确认测试失败**

```bash
node tests/agent.test.cjs
```

- [x] **步骤 3：实现双触发与哈希同步**

在 `reconcile.cjs` 中：

- 使用 `self-update.cjs` 的事务同步替换 mtime 判断；
- 插件入口采用两小时节流；
- 稳定副本仅在 `--trigger scheduled` 时采用 24 小时节流；
- 两者共用 `__last_self_update__`；
- 写入时间戳后静默启动稳定更新器；
- `event` 触发器和普通稳定运行不检查更新。

- [x] **步骤 4：运行回归测试**

```bash
node tests/agent.test.cjs
```

- [x] **步骤 5：提交**

```bash
git add -f plugin/agent/reconcile.cjs tests/agent.test.cjs
git commit -m "feat(plugin): add silent daily update fallback"
```

### 任务四：升级 Windows 端到端验证脚本

**文件：**

- 修改：`plugin/win-verify.cjs`
- 修改：`tests/agent.test.cjs`

- [x] **步骤 1：先写失败测试**

静态测试要求 `win-verify.cjs`：

```js
ok(verifySource.includes("plugin update"), "实机验证真实执行 plugin update");
ok(verifySource.includes("installed_plugins.json"), "更新后重新读取安装记录");
ok(verifySource.includes("treeDigest"), "比较完整 Agent 摘要");
ok(verifySource.includes("activateInstalledAgent"), "使用生产激活逻辑");
ok(verifySource.includes("Get-ScheduledTask") || verifySource.includes("schtasks"), "检查计划任务");
```

- [x] **步骤 2：确认测试失败**

```bash
node tests/agent.test.cjs
```

- [x] **步骤 3：实现分层实机验证**

更新 `win-verify.cjs`，分别输出：

- marketplace 更新结果；
- plugin update 结果；
- 更新后生效安装记录和清单版本；
- 生效缓存 Agent 摘要；
- 激活后稳定 Agent 摘要；
- 两个 VBS 的词法、真实执行和标记文件；
- 计划任务运行状态；
- `agent.log` 尾部。

脚本自身通过 `spawnSync` 执行 CLI 时必须包含有限超时和
`windowsHide: true`。最终只在所有层通过时输出成功。

- [x] **步骤 4：运行测试与语法检查**

```bash
node tests/agent.test.cjs
node --check plugin/win-verify.cjs
```

- [x] **步骤 5：提交**

```bash
git add -f plugin/win-verify.cjs tests/agent.test.cjs
git commit -m "test(plugin): verify complete Windows self-update chain"
```

### 任务五：发布版本与最终验证

**文件：**

- 修改：`plugin/.claude-plugin/plugin.json`

- [x] **步骤 1：更新版本**

将插件版本从 `1.4.13` 更新为 `1.4.14`，让已安装的 `1.4.12` 能真实下载新缓存。

- [x] **步骤 2：执行全量验证**

```bash
node tests/agent.test.cjs
node --check plugin/agent/self-update.cjs
node --check plugin/agent/reconcile.cjs
node --check plugin/agent/core.cjs
node --check plugin/win-verify.cjs
git diff --check
```

预期：全部测试通过、所有语法检查退出码为零、`git diff --check` 无输出。

- [x] **步骤 3：提交版本**

```bash
git add -f plugin/.claude-plugin/plugin.json
git commit -m "chore(plugin): release silent self-update as 1.4.14"
```

- [x] **步骤 4：生成 Windows 用户验收命令**

命令必须是一整块 PowerShell，可自动：

- 等待 `installed_plugins.json` 指向 `1.4.14`；
- 校验缓存清单；
- 比较缓存和稳定副本所有 SHA-256；
- 运行新版 `win-verify.cjs`；
- 输出计划任务和日志尾部。
