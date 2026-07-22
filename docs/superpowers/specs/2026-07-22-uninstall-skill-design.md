# Vantage 卸载 Skill 设计 (2026-07-22)

## 背景

目前 vantage 无卸载手段。员工想卸载时需手动清三处,且各不相同:
- OS 触发器(mac LaunchAgent / linux systemd --user / windows 启动文件夹 + schtasks)
- `~/.vantage/`(config、agent 脚本、spool、dead、state、log)
- Claude 插件本体(`vantage@dgcrane` + marketplace `dgcrane` + 缓存)

命令繁杂、易漏,且 `claude plugin uninstall` 若由 AI 代跑有**自卸载竞态**:卸载 skill 本身属于 vantage 插件,卸载时 skill 脚本正在执行,删插件会中断自己。

## 目标

一键卸载 skill `/vantage:uninstall`,自动清理 vantage 全部痕迹(触发器 + 数据 + 缓存 + 插件本体),用户只需最后重启一次会话。不删 Codex/Claude 工具自身的会话数据。

## 形态(A 方案)

独立 skill + 独立脚本,与 `/vantage:setup` 对称:

| 文件 | 职责 |
|---|---|
| `plugin/skills/uninstall/SKILL.md` | 引导:说明删什么 → 二次确认 → 调脚本 |
| `plugin/uninstall.cjs` | 执行:清触发器 → 删数据 → 删缓存 → detached 卸插件 |

三平台触发器卸载逻辑**自包含在 uninstall.cjs**(不复用 trigger.cjs/setup.cjs 内部),因为卸载是独立的一次性操作,自包含更清晰、易测、不耦合装的实现。

## 执行顺序(绕自卸载竞态)

```
① 卸 OS 触发器(三平台,见下)
② 删 ~/.vantage/(config + agent + spool + dead + state + log,全部)
③ 删插件缓存(~/.claude/plugins/cache/dgcrane、marketplaces/dgcrane)
④ spawnDetached: sleep 2 && claude plugin uninstall vantage@dgcrane && claude plugin marketplace remove dgcrane
⑤ 脚本立即退出,打印「✓ 已卸载,请重启 Claude 会话生效」
```

**第 4 步原理**:fork 一个独立后台进程(detached),skill 主体立即返回退出;2 秒后该独立进程执行 `claude plugin uninstall`,此时 skill 已不在运行,竞态消失。复用 `reconcile.cjs` 的 `core.spawnDetached` 模式(插件自更新已用此机制并验证可行)。detached 进程调 claude CLI 处理卸载,不依赖插件目录文件存活。

## 三平台触发器卸载

| 平台 | 卸载动作 |
|---|---|
| mac | `launchctl bootout gui/<uid>/com.dgcrane.vantage.codex` + 删 `~/Library/LaunchAgents/com.dgcrane.vantage.codex.plist` |
| linux | `systemctl --user disable --now vantage-codex.service` + 删 `~/.config/systemd/user/vantage-codex.{service,timer}` + `systemctl --user daemon-reload` |
| windows | 删启动文件夹 `vantage-codex.vbs` + `schtasks /Delete /TN VantageCodexDaily /F` + 删 `~/.vantage/run-reconcile.vbs` |

各步失败不中断(try/catch),触发器已不存在等幂等情况忽略。

## 不删

- `~/.codex/sessions`(Codex 自身会话数据)
- `~/.claude/projects`(Claude Code 自身 transcript)
- 这些是工具自己的数据,不是 vantage 的。

## 引导与确认

SKILL.md 面向不熟命令的同事,通俗说明将删除「触发器、~/.vantage 全部数据、插件本体(不可恢复)」,**二次确认**(用户点头)后才调 `uninstall.cjs`。卸载破坏性,必须确认。

## 代价(已知边界)

当前会话内存仍加载着插件,文件层卸载完成后,需 `/reload-plugins` 或**重启会话**才彻底生效。这是 AI 无法替用户做的最后一步(重启会话只能用户自己来)。

## 测试

E2E(`tests/run-tests.sh`)新增卸载测试:
- `VANTAGE_TRIGGER_DRYRUN=1` 验证生成的卸载命令正确(不真删系统调度器)
- 验证 `~/.vantage` 删除、插件缓存删除
- 验证 detached 卸载命令生成正确(sleep 2 && claude plugin uninstall ...)
- 三平台触发器卸载命令断言(mac/linux/win 分支)

## 版本

bump `plugin/.claude-plugin/plugin.json` 至 **1.3.5**(自更新按版本串判定,bump 后员工端收到卸载 skill)。
