# Codex 定时扫描错过修复设计

## 背景

Vantage 采集端对 Codex 采用“后台定时扫描会话文件”的机制（Claude Code 则用 SessionEnd/SessionStart 钩子）。当前触发器每天 12:00 执行一次 `reconcile.cjs --only codex`。

问题：在 macOS 上，`launchd StartCalendarInterval` 定时器在电脑睡眠/关机时会直接跳过，**醒来后不补跑**。导致大量员工 12:00 电脑盒盖时，Codex 当天会话无法自动上传，必须等下次打开 Claude Code 时由全量 reconcile 顺带补采。

Windows 与 Linux 情况不同：
- Windows schtasks 默认会在错过计划后尽快补跑（需显式开启 `StartWhenAvailable`）。
- Linux systemd user timer 已启用 `Persistent=true`，错过会补跑。

因此本设计重点补齐 macOS 的可靠性，同时把每小时兜底扩展到三平台。

## 目标

1. Codex 会话在员工当天使用过程中，至少有一次可靠的上传机会，不因单次睡眠错过而延迟到次日。
2. 触发器全部保持**用户级**，不依赖管理员/sudo。
3. 增加平台级补跑或文件变化触发作为补充，减少纯定时扫描的盲区。
4. 避免后台空转：通过 reconcile 内部节流，即使每小时触发，也不会每次都全量扫目录。

## 非目标

1. 不改 Codex parser 逻辑（用量字段解析、空会话过滤等保持现状）。
2. 不引入常驻守护进程或系统级服务。
3. 不修改 Claude Code 的钩子路径。
4. 不改动服务端接收逻辑。

## 方案概述（方案 D：混合触发）

三平台统一升级为：

- **每小时定时扫描**：提高“电脑醒着”时的命中概率。
- **平台级补跑/事件触发**：
  - macOS：额外增加 `WatchPaths` 监听 `~/.codex/sessions` 目录，Codex 写入 rollout 文件时即时触发；配合 5 分钟节流防抖。
  - Windows：使用 `StartWhenAvailable`，依赖 schtasks 自身在睡眠醒来后补跑错过的每小时任务。
  - Linux：保留 `Persistent=true`，错过即补跑。
- **reconcile 内部节流**：区分定时触发与事件触发，避免空转和抖动。
- **setup + reconcile 自检自愈**：插件升级后自动刷新触发器定义，员工无需重跑 setup。

## 跨平台触发器设计

### macOS（LaunchAgent）

拆分为两个 job，避免 launchd 无法区分触发源的问题：

1. **定时 job**：`com.dgcrane.vantage.codex.scheduled`
   - `StartCalendarInterval`：每小时 0 分。
   - `ProgramArguments`：`node reconcile.cjs --only codex --trigger scheduled`

2. **事件 job**：`com.dgcrane.vantage.codex.watch`
   - `WatchPaths`：`~/.codex/sessions`
   - `ThrottleInterval`：300 秒（5 分钟），防止 Codex 连续写文件时抖动。
   - `ProgramArguments`：`node reconcile.cjs --only codex --trigger event`

两个 plist 均放在 `~/Library/LaunchAgents/`，**无需管理员**。

setup 与 reconcile 自检需要：
- 删除旧的单 job plist `com.dgcrane.vantage.codex.plist`。
- 安装/刷新上述两个 plist，并 `launchctl bootout` + `bootstrap`。

### Windows（schtasks）

单个任务：
- 触发器：`HOURLY`。
- 行动：`wscript.exe "<base>\run-reconcile.vbs" --only codex --trigger scheduled`
- 关键属性：显式开启 `StartWhenAvailable`，确保从睡眠醒来后尽快补跑错过的任务。
- 实现：用 XML 定义任务并 `schtasks /Create /XML ...`，同时更新 `run-reconcile.vbs` 模板，把 `--trigger scheduled` 写死进去。

任务为**用户级**，普通账号可创建。事件触发暂不加，因为 schtasks 事件触发器（`ONEVENT`）通常需要管理员权限或事件通道权限，违背“用户级”原则。

### Linux（systemd user timer）

- `vantage-codex.service`：执行 `node reconcile.cjs --only codex --trigger scheduled`。
- `vantage-codex.timer`：
  - `OnCalendar=*-*-* *:00:00`（每小时）。
  - `Persistent=true`（错过即补跑）。
- 通过 `systemctl --user` 管理，**无需 sudo**。

事件触发暂不加；Linux 桌面环境差异大，可靠地监听 `~/.codex/sessions` 变化需要 inotify 常驻服务，与“不引入常驻进程”的非目标冲突。

## reconcile 内部节流逻辑

### 新增状态字段

在 `~/.vantage/state.json` 中新增：

- `__last_codex_scheduled__`：上次定时触发全量扫描的时间戳。
- `__last_codex_event__`：上次事件触发全量扫描的时间戳。

`__last_reconcile__`（全量/SessionStart 节流）保持不变，`--only codex` 不更新它，避免单源扫描污染 Claude Code 的兜底扫描。

### `--only codex --trigger scheduled`

- 如果 `Date.now() - __last_codex_scheduled__ < 30 分钟`：
  - 只调用 `core.spawnDetached("flush.cjs")`。
  - 不扫描目录。
- 否则：
  - 全量扫描 `~/.codex/sessions`。
  - 写 spool、更新 `__last_codex_scheduled__`。
  - 触发 flush。

### `--only codex --trigger event`

- 如果 `Date.now() - __last_codex_event__ < 5 分钟`：
  - 只调用 flush（防抖）。
- 否则：
  - 全量扫描 `~/.codex/sessions`。
  - 写 spool、更新 `__last_codex_event__`。
  - 触发 flush。

事件触发不遵守 30 分钟定时节流，因为 Codex 写入 rollout 文件本身就是“有新数据”的信号，如果被 30 分钟挡住，事件触发失去意义。

### 无 `--trigger` 参数（兼容旧触发器/手动调用）

- 视为 `--trigger scheduled`，走 30 分钟节流。
- 保持向后兼容。

### 实现位置

修改 `plugin/agent/reconcile.cjs`：
- `parseArgs` 增加 `--trigger` 解析。
- `--only codex` 分支在扫描前插入节流判断。
- 新增 `__last_codex_scheduled__` 和 `__last_codex_event__` 的读写辅助函数（或复用 `readState/writeState`）。

## 升级与自愈

### setup.cjs

- 重写 `installLaunchd`：生成两个 plist，并清理旧 plist。
- 重写 `installSystemd`：改为每小时，保留 `Persistent=true`。
- 重写 `installSchtasks`：改为每小时 + `StartWhenAvailable`，用 XML 创建。

### reconcile.cjs 自检（trigger.cjs / 新增逻辑）

当前 `agent/trigger.cjs` 只处理 Windows。需要扩展：
- macOS：读取 `~/Library/LaunchAgents/com.dgcrane.vantage.codex.{scheduled,watch}.plist`，与期望内容比对；不符则重写并 `launchctl bootstrap`。
- Linux：读取 `~/.config/systemd/user/vantage-codex.timer`，与期望内容比对；不符则重写并 `systemctl --user daemon-reload`。
- Windows：在现有 `ensureWindowsCodexTrigger` 中把每小时 + `StartWhenAvailable` 纳入，并清理旧的 daily 任务。

自检在每次 reconcile 启动时执行（幂等），确保插件升级后触发器自动刷新。

## 测试计划

### macOS

1. 安装后检查两个 plist 存在且内容正确。
2. 手动让 Mac 睡眠跨过整点，唤醒后 1 小时内检查 `agent.log` 出现 `reconcile:` 日志。
3. 手动复制一个有效 rollout 文件到 `~/.codex/sessions/年/月/日/`，确认事件 job 触发（5 分钟内）。
4. 连续复制两个 rollout 文件，确认第二次被 5 分钟节流挡住，只 flush 不扫描。

### Windows

1. 安装后检查任务存在、触发器为每小时、`StartWhenAvailable` 开启。
2. 让电脑睡眠跨过整点，唤醒后检查 `agent.log` 出现 reconcile。
3. 检查旧的 daily 任务已被清理。

### Linux

1. 安装后检查 timer 为每小时且 `Persistent=true`。
2. 模拟错过：`systemctl --user stop vantage-codex.timer`，等待跨过整点，再 `systemctl --user start`，确认服务被补跑。

### 通用

1. 连续手动触发 5 次 `reconcile.cjs --only codex --trigger scheduled`，确认只有第一次扫描，其余只 flush。
2. 确认 `--only codex` 不更新 `__last_reconcile__`。

## 风险与回滚

1. **WatchPaths 误触发**：Codex 可能在目录里频繁写临时文件。通过 `ThrottleInterval` 5 分钟 + reconcile 内部 5 分钟节流控制。
2. **每小时任务增加后台进程次数**：空转路径只读 state + flush 锁检查，< 5ms，影响可忽略。
3. **两个 plist 升级时旧任务残留**：setup 和自检明确删除旧单 job plist。
4. **Windows XML 任务创建失败**：测试普通用户账号下 XML 创建是否成功；若权限不足，退回命令行创建 `/SC HOURLY` 并额外设置 `StartWhenAvailable`。
5. **回滚**：如果新触发器有问题，可以手动运行 setup 的旧版本，或删除对应 plist/timer/schtasks。

## 相关文件

- `plugin/setup.cjs`
- `plugin/agent/reconcile.cjs`
- `plugin/agent/core.cjs`（可能需要新增状态字段辅助函数）
- `plugin/agent/trigger.cjs`
- `plugin/agent/parsers/codex.cjs`（不修改，仅消费其输出）

## 决策记录

- **为什么不给 Windows/Linux 也加 WatchPaths/inotify？** 权限和常驻进程问题。Windows 事件触发器需要管理员；Linux inotify 需要常驻服务。两者都与“用户级、无守护进程”冲突。
- **为什么定时节流 30 分钟、事件节流 5 分钟？** 定时触发的目的是兜底，30 分钟足够覆盖每小时一次且避免空转；事件触发是“真有新数据”，5 分钟仅用于防抖。
- **为什么拆两个 macOS launchd job？** launchd 无法把触发源作为参数传给同一个 job，reconcile 必须知道是定时还是事件才能走不同节流策略。
