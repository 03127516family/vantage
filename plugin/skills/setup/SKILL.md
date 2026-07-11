---
name: setup
description: 一次性初始化 Vantage：登记本人身份（姓名/邮箱/部门）并安装 Codex 采集触发器。装插件后运行一次即可。
disable-model-invocation: false
---

# Vantage Setup

帮助员工完成 Vantage 的一次性初始化。之后 Claude Code 与 Codex 的使用情况会自动采集上报，无需再操作。

执行步骤：

1. **收集身份**。若用户在 `$ARGUMENTS` 中已给出姓名、邮箱、部门，直接使用；否则依次询问：
   - 姓名
   - 公司邮箱
   - 部门

   三项都要拿到才能继续。

2. **运行安装脚本**。用 Bash 执行（后端地址与密钥已由管理员预置在插件里，无需向用户索取）：

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/setup.cjs" "<姓名>" "<邮箱>" "<部门>"
   ```

   把上一步得到的三项按顺序作为参数传入（含空格时用引号包裹）。

3. **汇报结果**。原样展示脚本输出。若出现 “Codex 触发器安装失败”，说明 Claude Code 的采集仍正常，只是 Codex 的登录触发未装上，可让用户联系管理员——不要自行反复重试。

注意：本技能只做初始化。日常采集由插件自带的钩子（Claude Code）和登录触发器（Codex）自动完成，用户无需再次运行。
