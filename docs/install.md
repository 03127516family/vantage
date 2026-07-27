# Vantage 员工端安装与升级指南

这份文档面向**员工**和**管理员**，说明如何在 Claude Code 里安装、升级、卸载 Vantage 插件。

> 服务端部署见 [lambda-deploy.md](lambda-deploy.md) 与 [s3-setup.md](s3-setup.md)。

---

## 管理员先做的事（一次）

1. 确保 `plugin/vantage.defaults.json` 已填好公司后端地址与上传密钥：

   ```json
   {
     "server_url": "https://vantage.dgcrane.com",
     "token": "<专属密钥>"
   }
   ```

   这样员工 `/vantage:setup` 时无需手动填地址和密钥。

2. 把插件仓库推到内部 marketplace 地址（当前为 `x-dream-works/vantage`）。

3. 每次发版必须 bump `plugin/.claude-plugin/plugin.json` 里的 `version`，否则员工端不会自动更新。

---

## 员工安装（Claude Code 内执行）

打开 Claude Code，按顺序执行以下命令：

### 1. 添加内部 marketplace

```text
/plugin marketplace add x-dream-works/vantage
```

作用：让 Claude Code 知道公司内部插件源。每个员工只需执行一次。

### 2. 安装 Vantage 插件

```text
/plugin install vantage@dgcrane
```

作用：从 marketplace 下载插件到本地 `~/.claude/plugins/`。

### 3. 刷新斜杠命令

```text
/reload-plugins
```

作用：让 `/vantage:setup` 等插件技能出现在命令列表里。

> Claude Code v2.1.98+ 安装完即可用，老版本需要 `/exit` 退出重开一次。

### 4. 运行初始化

```text
/vantage:setup
```

按提示回答：

- 先阅读采集范围说明，确认同意
- 输入姓名（只需要姓名，部门按公司通讯录自动填）

setup 会完成：

- 写 `~/.vantage/config.json`
- 同步采集脚本到 `~/.vantage/agent/` 稳定副本
- 安装 Codex 登录/每小时触发器（macOS LaunchAgent / Linux systemd / Windows 计划任务）

安装完成后**无需任何操作**，插件会在后台自动采集。

---

## 验证安装

执行：

```text
/vantage:sync
```

或在终端跑：

```bash
cat ~/.vantage/config.json
ls ~/.vantage/agent/
```

应看到 `config.json`、`agent/reconcile.cjs`、以及对应平台的触发器文件（如 macOS 的 `~/Library/LaunchAgents/com.dgcrane.vantage.codex.*.plist`）。

---

## 升级流程

Vantage 插件默认会自动更新：

- 每次 `SessionStart` 时后台检查 marketplace 是否有新版本
- 2 小时节流，避免频繁检查
- 发现新版本后自动 `claude plugin update`，下次 Claude 会话生效

如果你想立即升级，可以手动执行：

```text
/plugin update
/reload-plugins
```

> 发版方必须 bump `plugin/.claude-plugin/plugin.json` 的 `version`，否则官方不会认为有更新。

---

## 卸载流程

```text
/vantage:uninstall
```

会删除：

- OS 触发器
- `~/.vantage/` 本地数据
- 插件缓存
- 2 秒后后台卸载插件本体

然后执行：

```text
/exit
```

重新打开 Claude Code 让卸载彻底生效。

---

## 常见问题

### Q: `/vantage:setup` 提示不在通讯录怎么办？
A: 先确认姓名是否输错。如果确认无误，让管理员把新员工加入 `plugin/roster.json`，或手动选择部门完成 setup。

### Q: 安装后没有 `/vantage:setup` 命令？
A: 执行 `/reload-plugins`，或 `/exit` 后重新打开 Claude Code。

### Q: 插件已经更新了，但本地还是旧版本？
A: 自动更新有 2 小时节流。可以手动 `/plugin update`，然后 `/reload-plugins`。

### Q: 卸载后插件还在？
A: detached 卸载可能因权限/进程问题未生效。手动执行 `/plugin uninstall vantage@dgcrane`，然后 `/exit` 重开。

---

## 命令速查

| 场景 | 命令 |
|------|------|
| 添加 marketplace | `/plugin marketplace add x-dream-works/vantage` |
| 安装插件 | `/plugin install vantage@dgcrane` |
| 刷新命令 | `/reload-plugins` |
| 初始化 | `/vantage:setup` |
| 立即同步 | `/vantage:sync` |
| 手动更新 | `/plugin update` |
| 卸载 | `/vantage:uninstall` |
| 退出 Claude | `/exit` |
