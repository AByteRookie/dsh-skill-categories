<#
  install.ps1 — 一键安装 / 更新 dsh-skill-categories

  做什么：
    1. 找 DSH 安装位置（运行中进程 → 常见路径 → 注册表）
    2. 找 Node（PATH → DSH 自带 runtime）
    3. 跑 setup.mjs 生成并挂进 desktop profile
    4. 可选：重启 DSH 让宿主半生效

  用法：
    powershell -ExecutionPolicy Bypass -File install.ps1
    powershell -ExecutionPolicy Bypass -File install.ps1 -NoRestart
#>

[CmdletBinding()]
param(
    [switch]$NoRestart,
    [string]$Profile = 'desktop'
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8

function Say($text, $color = 'Gray') {
    Write-Host "  $text" -ForegroundColor $color
}

Write-Host ''
Write-Host '  dsh-skill-categories 安装器' -ForegroundColor Cyan
Write-Host '  ────────────────────────────' -ForegroundColor DarkGray

# ── 1. 找 DSH ────────────────────────────────────────────────
$exe = $null
$proc = Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue | Select-Object -First 1
if ($proc -and $proc.Path) { $exe = $proc.Path }

if (-not $exe) {
    $candidates = @(
        'D:\DSH桌面\DeepSeek Harness.exe',
        "$env:LOCALAPPDATA\Programs\DeepSeek Harness\DeepSeek Harness.exe",
        "$env:ProgramFiles\DeepSeek Harness\DeepSeek Harness.exe"
    )
    foreach ($c in $candidates) {
        if (Test-Path $c) { $exe = $c; break }
    }
}

if (-not $exe) {
    Say '找不到 DeepSeek Harness.exe' Red
    Say '请先启动一次 DSH，或把 DSH 装在标准位置后重试。' Yellow
    exit 1
}
Say "DSH: $exe" Green

$resources = Join-Path (Split-Path $exe -Parent) 'resources'

# ── 2. 找 Node ───────────────────────────────────────────────
$node = $null
$cmd = Get-Command node -ErrorAction SilentlyContinue
if ($cmd) { $node = $cmd.Source }

if (-not $node) {
    $bundled = Join-Path $resources 'runtime\primary-runtime\dependencies\node\bin\node.exe'
    if (Test-Path $bundled) { $node = $bundled }
}
if (-not $node) {
    $found = Get-ChildItem $resources -Recurse -Filter 'node.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($found) { $node = $found.FullName }
}
if (-not $node) {
    Say '找不到 Node 运行时' Red
    Say '安装 Node 18+ 后重试，或确认 DSH 目录完整。' Yellow
    exit 1
}
Say "Node: $node" Green

# ── 3. 生成并挂载 ────────────────────────────────────────────
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Write-Host ''
Say '生成分类数据并挂进 profile …' Cyan

Push-Location $root
try {
    & $node 'setup.mjs' '--profile' $Profile
    if ($LASTEXITCODE -ne 0) {
        Say "setup.mjs 失败（exit $LASTEXITCODE）" Red
        exit 1
    }
}
finally {
    Pop-Location
}

# ── 4. 重启 ──────────────────────────────────────────────────
if ($NoRestart) {
    Write-Host ''
    Say '已安装。重启 DSH 后生效（本参数下未自动重启）。' Yellow
    exit 0
}

Write-Host ''
Say '重启 DSH 让宿主半生效 …' Cyan
$running = Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue
if ($running) {
    $running | Stop-Process -Force -ErrorAction SilentlyContinue
    $deadline = (Get-Date).AddSeconds(20)
    while ((Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 200
    }
    Say '已结束旧进程' Green
}

Start-Process -FilePath $exe
$deadline = (Get-Date).AddSeconds(30)
while ((Get-Date) -lt $deadline) {
    if (Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue) { break }
    Start-Sleep -Milliseconds 300
}
Start-Sleep -Seconds 2

if (Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue) {
    Say 'DSH 已重启，分类功能已生效。' Green
    Say '打开 / 就能看到分类菜单。' Gray
} else {
    Say '重启未成功，请手动启动 DSH。' Yellow
}
