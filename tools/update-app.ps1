# -*- coding: utf-8 -*-
# 一键更新 DSH Desktop：关闭旧实例 → 换上新版本 → 刷新快捷方式 → 重新启动
#
# 用法（双击桌面上的「更新 DSH Desktop」即可）:
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools/update-app.ps1
#
# 参数:
#   -Source <目录>   新版本目录，默认 <项目>\dist-new
#   -Target <目录>   安装目录，默认 <项目>\dist
#   -NoRestart       更新完不自动启动
#   -KeepBackup      保留旧版本目录（默认为节省空间会删除）
#   -SkipClose       跳过「关闭正在运行的实例」（测试用）
#   -SkipShortcut    跳过「刷新桌面快捷方式」（测试用）

param(
  [string]$Source,
  [string]$Target,
  [switch]$NoRestart,
  [switch]$KeepBackup,
  [switch]$SkipClose,
  [switch]$SkipShortcut
)

$ErrorActionPreference = 'Stop'

$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if (-not $Source) { $Source = Join-Path $Root 'dist-new' }
if (-not $Target) { $Target = Join-Path $Root 'dist' }

$AppName = 'DSH Desktop'
$ExeName = "$AppName.exe"

function Write-Step($text) { Write-Host "`n▸ $text" -ForegroundColor Cyan }
function Write-Ok($text)   { Write-Host "  ✓ $text" -ForegroundColor Green }
function Write-Warn2($text){ Write-Host "  ! $text" -ForegroundColor Yellow }
function Write-Err($text)  { Write-Host "  ✗ $text" -ForegroundColor Red }

Write-Host ""
Write-Host "  DSH Desktop 更新程序" -ForegroundColor White
Write-Host "  ────────────────────────────────" -ForegroundColor DarkGray
Write-Host "  新版本: $Source"
Write-Host "  安装位置: $Target"

# ---------- 0. 检查 ----------
Write-Step "检查新版本"
if (-not (Test-Path $Source)) {
  Write-Err "找不到新版本目录：$Source"
  Write-Host "`n  请先运行 npm run package 打包，或下载新版本后重试。" -ForegroundColor Yellow
  Read-Host "`n按回车键关闭"
  exit 1
}
$srcExe = Get-ChildItem $Source -Recurse -Filter $ExeName -File -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $srcExe) {
  Write-Err "新版本目录里没有 $ExeName"
  Read-Host "`n按回车键关闭"
  exit 1
}
$srcDir = $srcExe.Directory.FullName
Write-Ok "找到 $($srcExe.FullName)"

# ---------- 1. 关闭正在运行的实例 ----------
Write-Step "关闭正在运行的 $AppName"
if ($SkipClose) {
  Write-Warn2 "已跳过（-SkipClose）"
} else {
$running = Get-Process -Name ($AppName -replace '\.exe$','') -ErrorAction SilentlyContinue
if ($running) {
  Write-Host "  正在退出（$($running.Count) 个进程）…"
  # 先礼貌关闭（触发它自己的退出流程），不行再强杀
  $running | ForEach-Object { $null = $_.CloseMainWindow() }
  for ($i = 0; $i -lt 15; $i++) {
    Start-Sleep -Milliseconds 800
    if (-not (Get-Process -Name ($AppName -replace '\.exe$','') -ErrorAction SilentlyContinue)) { break }
  }
  Get-Process -Name ($AppName -replace '\.exe$','') -ErrorAction SilentlyContinue |
    Stop-Process -Force -ErrorAction SilentlyContinue
  for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Milliseconds 500
    if (-not (Get-Process -Name ($AppName -replace '\.exe$','') -ErrorAction SilentlyContinue)) { break }
  }
}
if (Get-Process -Name ($AppName -replace '\.exe$','') -ErrorAction SilentlyContinue) {
  Write-Err "仍有进程未退出，请手动结束后再试。"
  Read-Host "`n按回车键关闭"
  exit 1
}
Write-Ok "已关闭"
}

# 等后台 dsh web 服务让出文件锁（它可能还挂在旧目录上）
Start-Sleep -Seconds 2

# ---------- 2. 替换目录 ----------
Write-Step "替换程序文件"
$Backup = "$Target-old"
try {
  if (Test-Path $Backup) { Remove-Item $Backup -Recurse -Force }

  if (Test-Path $Target) {
    Move-Item $Target $Backup
    Write-Ok "旧版本已移至 $Backup"
  }
  New-Item -ItemType Directory -Force -Path (Split-Path $Target -Parent) | Out-Null
  Move-Item $srcDir $Target
  Write-Ok "新版本已就位"
} catch {
  Write-Err "替换失败：$($_.Exception.Message)"
  # 回滚
  if ((Test-Path $Backup) -and -not (Test-Path (Join-Path $Target $ExeName))) {
    if (Test-Path $Target) { Remove-Item $Target -Recurse -Force -ErrorAction SilentlyContinue }
    Move-Item $Backup $Target -ErrorAction SilentlyContinue
    Write-Warn2 "已回滚到旧版本"
  }
  Read-Host "`n按回车键关闭"
  exit 1
}

# 清掉空壳目录
if ((Test-Path $Source) -and -not (Get-ChildItem $Source -Force -ErrorAction SilentlyContinue)) {
  Remove-Item $Source -Recurse -Force -ErrorAction SilentlyContinue
}

$newExe = Join-Path $Target $ExeName
if (-not (Test-Path $newExe)) {
  Write-Err "新目录里没有 $ExeName"
  Read-Host "`n按回车键关闭"
  exit 1
}

# ---------- 3. 刷新快捷方式 ----------
Write-Step "刷新桌面快捷方式"
if ($SkipShortcut) {
  Write-Warn2 "已跳过（-SkipShortcut）"
} else {
try {
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'create-shortcut.ps1') -Target $newExe | Out-Null
  Start-Process -FilePath "$env:SystemRoot\System32\ie4uinit.exe" -ArgumentList '-show' -Wait -NoNewWindow -ErrorAction SilentlyContinue
  Write-Ok "快捷方式已更新，图标缓存已刷新"
} catch {
  Write-Warn2 "快捷方式刷新失败（不影响使用）：$($_.Exception.Message)"
}
}

# ---------- 4. 启动 ----------
if (-not $NoRestart) {
  Write-Step "启动新版本"
  Start-Process -FilePath 'explorer.exe' -ArgumentList "`"$newExe`""
  Start-Sleep -Seconds 3
  if (Get-Process -Name ($AppName -replace '\.exe$','') -ErrorAction SilentlyContinue) {
    Write-Ok "已启动"
  } else {
    Write-Warn2 "进程还没出现，稍等片刻或手动双击桌面图标"
  }
}

# ---------- 5. 清理备份 ----------
if ($KeepBackup) {
  Write-Warn2 "旧版本保留在 $Backup（可手动删除）"
} elseif (Test-Path $Backup) {
  Write-Step "清理旧版本"
  try { Remove-Item $Backup -Recurse -Force; Write-Ok "已删除 $Backup" }
  catch { Write-Warn2 "删除失败（可稍后手动删）：$($_.Exception.Message)" }
}

Write-Host ""
Write-Host "  ────────────────────────────────" -ForegroundColor DarkGray
Write-Host "  更新完成 ✔" -ForegroundColor Green
Write-Host ""
Write-Host "  说明：重启期间后台的 dsh web 服务会随之退出（它是应用的子进程），" -ForegroundColor Gray
Write-Host "  正在进行的会话会断开一下。会话数据保存在 ~/.dsh，不会丢；" -ForegroundColor Gray
Write-Host "  应用重新打开后，在左侧会话列表点一下即可继续。" -ForegroundColor Gray
Write-Host ""
Write-Host "  想在不重启应用的情况下继续用，可以打开桌面上的「DSH 网页版」" -ForegroundColor Gray
Write-Host "  （独立进程，不受应用退出影响，与桌面版共用同一批会话）。" -ForegroundColor Gray
Write-Host ""
Read-Host "按回车键关闭本窗口"
