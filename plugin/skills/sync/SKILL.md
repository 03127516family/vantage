---
name: sync
description: 手动同步一次用量数据：立即扫描 Claude Code / Codex 的本地会话并上报到公司内网（平时后台自动进行，本命令用于「现在就要看到最新数据」或排查数据没到的情况）。
disable-model-invocation: false
---

# Sync（手动同步）

用户想立刻把本机的用量数据同步上去（例如周会前想让数据即时到位，或怀疑自动采集没跑）。

流程：

1. 先检查是否已初始化：用 Bash 读 `~/.vantage/config.json`。若文件不存在或其中 `email` 为空，
   告知用户「还没登记过信息，先做一次初始化」，转而按 setup 技能的流程引导（或提示运行
   `/vantage:setup`），**不要在未登记身份的情况下继续同步**。

2. 已初始化则直接运行（前台执行，等待完成）：

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/agent/reconcile.cjs"
   ```

   该脚本会全量扫描 Claude Code 与 Codex 两边的近期会话，补采未上报的，并触发上传（含之前
   断网滞留的记录）。脚本静默运行、始终 exit 0。

3. 运行后用 Bash 查看结果并向用户汇报，**用通俗的一两句话**，不要贴原始日志：

   ```bash
   tail -5 ~/.vantage/agent.log
   ```

   - 日志中 `reconcile: found N files, spooled M unsynced` → 告知「扫描了 N 个会话，本次新采集 M 条」；
   - 稍等片刻（sleep 2）后 `flush: ok=X retry=Y dead=Z` → ok>0 告知「已上报 X 条」；
     retry>0 说明网络/服务端暂时不通，告知「有 Y 条暂时没传上去，之后会自动重试，无需操作」；
   - spooled 0 且 ok=0 → 告知「本地数据都已是最新，没有需要补传的」。

要求：不要向用户展示内部路径、token、服务器地址等细节；遇到报错只说结论（会自动重试/请联系管理员），
不要引导用户自己改配置文件。
