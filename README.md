# Vantage

> 团队 AI 编程助手使用情况的制高点视野 — by dgcrane

Vantage 员工端插件，自动采集 **Claude Code** 与 **Codex** 的使用情况（用量 + 内容摘要），上报到公司看板，帮助管理者一览「谁在用、用得多不多、够不够用」。

服务端仓库：[x-dream-works/vantage](https://github.com/x-dream-works/vantage)

---

## 员工安装（Claude Code 内执行）

```text
/plugin marketplace add x-dream-works/vantage
/plugin install vantage@dgcrane
/reload-plugins
/vantage:setup
```

- 按 `/vantage:setup` 提示输入姓名（部门按公司通讯录自动填）
- 安装完成后**无需任何操作**，插件会在后台自动采集

### Windows 用户注意

如果电脑有 Windows 安全中心 / 360 / 火绒 / 腾讯管家等安全软件，setup 完成后请以**管理员身份**运行白名单脚本：

```powershell
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\.claude\plugins\marketplaces\x-dream-works-vantage\plugin\vantage-whitelist.ps1"
```

该脚本会把 Vantage 路径加入 Windows Defender 排除项。如果使用 360 等第三方杀软，请手动把以下路径加入信任区：
- `C:\Users\<用户名>\.vantage`
- `C:\Users\<用户名>\.claude\plugins`
- `C:\Users\<用户名>\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup\vantage-codex.vbs`

---

## 采集范围

| 类别 | 字段 |
|---|---|
| 身份 | 姓名、部门、主机名（不登记邮箱） |
| 会话 | 工具、session_id、项目路径、开始/结束时间、时长 |
| 用量 | 消息数、输入/输出/合计 token、分模型明细、使用的模型 |
| 额度 | Codex 当前额度使用率、套餐类型 |
| 内容 | 摘要、首句提问（均脱敏+截断） |

**隐私**：不存完整对话；邮箱/密钥/JWT/URL 凭据/长 token 串会脱敏。

---

## 触发机制

| 工具 | 触发方式 |
|------|----------|
| Claude Code | `SessionEnd` / `SessionStart` 插件钩子 |
| Codex | OS 登录触发器（macOS LaunchAgent / Linux systemd / Windows Task Scheduler） |

---

## 管理员预置

编辑 `plugin/vantage.defaults.json`，填入后端地址与上传密钥：

```json
{
  "server_url": "https://vantage.dgcrane.com",
  "token": "<专属密钥>"
}
```

员工 setup 时无需手动填写。

---

## 卸载

```text
/vantage:uninstall
```

然后 `/exit` 重新打开 Claude Code 让卸载彻底生效。

---

## 配置项

`~/.vantage/config.json`（setup 以 0600 权限生成）：

```json
{
  "name": "张三",
  "department": "外贸部",
  "server_url": "https://vantage.dgcrane.com",
  "token": "<密钥>"
}
```

**环境变量（调优）**

| 变量 | 默认 | 说明 |
|---|---|---|
| `VANTAGE_RECENT_DAYS` | 7 | 对账只回看最近 N 天 |
| `VANTAGE_SKIP_TRIGGER` | 0 | setup 时跳过 Codex 触发器（测试用） |
| `VANTAGE_SELF_UPDATE_INTERVAL_H` | 2 | 插件自更新检查间隔（小时） |
| `VANTAGE_DISABLE_SELF_UPDATE` | 空 | 置非空则关闭插件自更新 |

---

## 运维

- **看积压**：`~/.vantage/spool/` 空 = 都传上去了
- **日志**：`~/.vantage/agent.log`
- **死信**：`~/.vantage/dead/`

---

## 发版注意

每次发版务必 bump `plugin/.claude-plugin/plugin.json` 里的 `version`，否则员工端不会自动更新。

插件会在每次 `SessionStart` 时后台检查 marketplace 新版本，2 小时节流，自动更新。
