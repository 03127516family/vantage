---
name: uninstall
description: 卸载 Vantage：清除 OS 触发器、本地数据(~/.vantage)、插件缓存与插件本体。运行前必须与用户二次确认。
disable-model-invocation: false
---

# Uninstall

引导员工彻底卸载 Vantage。面向不熟悉命令的同事，**先说清会删什么，等用户明确确认后再执行**。

流程：

1. 开场说明将删除以下内容（**不可恢复**）：
   - OS 触发器（mac LaunchAgent / linux systemd / windows 启动文件夹 + 计划任务）
   - 本地数据目录 `~/.vantage/`（配置、采集脚本、spool/dead 队列、状态、日志）
   - 插件缓存与插件本体（`vantage@dgcrane`）
   - 说明**不会删**：Codex/Claude 工具自身的会话数据（`~/.codex/sessions`、`~/.claude/projects`）

2. 问：**确定要卸载吗？**（等用户明确回答"确定/是"才继续。回答模糊或拒绝就停下不动）

3. 用户确认后，用 Bash 运行：

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/uninstall.cjs"
   ```

4. 脚本会自动清理触发器、`~/.vantage`、缓存，并在 2 秒后后台卸载插件本体。
   告诉用户：

   > ✅ 已卸载。请重启 Claude 会话（`/exit` 后重开，或 `/reload-plugins`）让卸载彻底生效。

要求：必须等到用户明确确认才运行脚本；删除是不可恢复的，宁可多问一句也不要误删。
