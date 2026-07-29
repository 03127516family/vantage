---
name: setup
description: 初始化 dgcrane 研发工具：登记本人姓名（部门按公司通讯录自动填）。安装后运行一次即可。
disable-model-invocation: false
---

# Setup

引导员工完成一次性初始化。先简单说明工具功能，再问姓名、再运行脚本。

流程：

1. 开场一句话说明工具功能：

   > Vantage 是 dgcrane 内部 AI 工具用量统计工具，用于统计团队 Claude Code / Codex 的使用情况（工具、模型、token 用量、额度使用率），上报到公司看板。不采集完整对话内容。

2. 然后问：**你的姓名？**（只需要姓名——不问邮箱，部门由脚本按公司通讯录自动填）

3. 拿到姓名后，用 Bash 运行（含空格的值要用引号包裹）：

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/setup.cjs" "<姓名>"
   ```

4. 看脚本结果分三种情况：
   - **成功（退出码 0）**：脚本已按通讯录自动填好部门，进入第 5 步。
   - **不在通讯录（退出码 2）**：脚本会打印几个候选名（多为笔误）。把候选名列给用户，
     问「是不是其中一个？」；用户确认后用正确姓名重跑第 3 步。
   - **用户坚持姓名没写错**（比如新员工还没进通讯录）：读取插件目录下 `vantage.defaults.json`
     的 `departments` 数组，以**带序号的菜单**让用户选部门（回复序号或名称皆可）；
     若读取不到该文件，就用这组默认：外贸部 / 市场部 / 财务部 / 技术部 / 行政部 / 其他。
     然后运行：

     ```bash
     node "${CLAUDE_PLUGIN_ROOT}/setup.cjs" "<姓名>" "<部门>"
     ```

5. 脚本运行成功后，告知用户：

   > ✅ 安装完成。Vantage 将在后台自动采集 Claude Code / Codex 的使用用量并上报公司看板（采集范围如步骤 1 所述）。之后无需任何操作。

6. **Windows 用户额外步骤**（macOS/Linux 跳过）：
   如果检测到用户系统是 Windows，询问用户：

   > 检测到你是 Windows。为了防止安全软件误删 Codex 定时触发器，需要把 Vantage 加入 Windows 安全中心排除项。这需要管理员权限，请确认：是否现在执行？

   用户同意后，用 Bash 运行：

   ```bash
   powershell -ExecutionPolicy Bypass -File "${CLAUDE_PLUGIN_ROOT}/vantage-whitelist.ps1"
   ```

   根据结果分三种情况：
   - **成功**：告知用户已完成，Vantage 不会被 Windows 安全中心拦截。
   - **失败，提示权限不足**：告知用户"请以管理员身份重新打开 Claude Code，再运行一次 /vantage:setup"。
   - **失败，提示没有 Windows Defender**：说明用户可能使用 360/火绒/腾讯管家等第三方杀软。请员工在对应杀软中手动把以下路径加入信任区：
     - `C:\Users\<用户名>\.vantage`
     - `C:\Users\<用户名>\.claude\plugins`
     - `C:\Users\<用户名>\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup\vantage-codex.vbs`

要求：**先简单说明工具功能，再问姓名、再运行脚本**；姓名必须问到才运行；部门一律交给脚本定（在册以通讯录为准，用户口头说的部门不作数），只有脚本明确报「不在通讯录」且用户确认姓名无误时，才走手选部门的兜底路径。
