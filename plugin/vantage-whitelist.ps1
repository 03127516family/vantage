# Vantage Windows 安装辅助脚本
# 功能:将 Vantage 相关路径加入 Windows Defender 排除项,降低触发器/脚本被误删的概率。
# 注意:此脚本只处理 Windows 安全中心(Windows Defender);360/火绒/腾讯管家等第三方杀软请手动加白名单。
# 运行方式:右键"以管理员身份运行 PowerShell",然后执行:
#   powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\.claude\plugins\marketplaces\x-dream-works-vantage\plugin\vantage-whitelist.ps1"

param()

# 1. 检查管理员权限
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
$isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin) {
    Write-Host "[错误] 需要管理员权限。请右键 PowerShell 选择'以管理员身份运行'后重试。" -ForegroundColor Red
    exit 1
}

# 2. 定义要排除的路径
$UserHome = $env:USERPROFILE
$Exclusions = @(
    "$UserHome\.vantage",
    "$UserHome\.claude\plugins",
    "$UserHome\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup\vantage-codex.vbs"
)

Write-Host "== Vantage Windows 白名单脚本 ==" -ForegroundColor Cyan
Write-Host "本脚本会把 Vantage 相关路径加入 Windows Defender 排除项。" -ForegroundColor Gray
Write-Host "如果你使用 360/火绒/腾讯管家等第三方杀软,请在对应软件中手动添加信任。" -ForegroundColor Yellow
Write-Host ""

# 3. 检查 Windows Defender 模块是否可用
try {
    Get-Command Add-MpPreference -ErrorAction Stop | Out-Null
} catch {
    Write-Host "[警告] 当前系统没有 Windows Defender PowerShell 模块(Add-MpPreference 不存在)。" -ForegroundColor Yellow
    Write-Host "       可能使用了第三方杀软。请手动把以下路径加入杀软信任区:" -ForegroundColor Yellow
    foreach ($p in $Exclusions) { Write-Host "       - $p" -ForegroundColor Yellow }
    exit 0
}

# 4. 添加排除项
$added = 0
foreach ($p in $Exclusions) {
    if (-not (Test-Path $p)) {
        # 路径不存在也尝试添加排除(未来生成时会生效)
        Write-Host "[路径暂不存在,但仍加入排除项] $p" -ForegroundColor DarkYellow
    } else {
        Write-Host "[添加排除项] $p" -ForegroundColor Green
    }
    try {
        Add-MpPreference -ExclusionPath $p -ErrorAction Stop
        $added++
    } catch {
        Write-Host "[失败] 无法添加排除项 $p : $_" -ForegroundColor Red
    }
}

# 5. 尝试还原被 Windows Defender 隔离的 vantage-codex.vbs(如果存在)
$StartupVbs = "$UserHome\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup\vantage-codex.vbs"
if (-not (Test-Path $StartupVbs)) {
    try {
        $Threats = Get-MpThreatDetection -ErrorAction SilentlyContinue | Where-Object {
            $_.Resources -match "vantage-codex\.vbs|run-reconcile\.vbs|VantageCodex"
        }
        if ($Threats) {
            Write-Host "[发现隔离记录] 尝试还原 vantage 相关文件..." -ForegroundColor Yellow
            foreach ($t in $Threats) {
                try {
                    Restore-MpThreat -ThreatID $t.ThreatID -ErrorAction Stop
                    Write-Host "[已还原] ThreatID $($t.ThreatID)" -ForegroundColor Green
                } catch {
                    Write-Host "[还原失败] ThreatID $($t.ThreatID) : $_" -ForegroundColor Red
                }
            }
        }
    } catch {
        # 忽略,可能无权查看隔离区
    }
}

Write-Host ""
if ($added -gt 0) {
    Write-Host "完成!已将 $added 个路径加入 Windows Defender 排除项。" -ForegroundColor Cyan
    Write-Host "建议重新运行 Claude Code 中的 /vantage:setup 以修复触发器。" -ForegroundColor Cyan
} else {
    Write-Host "未完成:没有成功添加排除项。" -ForegroundColor Red
}

Write-Host ""
Write-Host "第三方杀软用户(360/火绒/腾讯管家等):" -ForegroundColor Yellow
foreach ($p in $Exclusions) { Write-Host "  手动添加信任: $p" -ForegroundColor Yellow }
