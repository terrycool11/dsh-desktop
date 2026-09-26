# -*- coding: utf-8 -*-
# 在桌面创建「更新 DSH Desktop」快捷方式（双击即可把新版本换上并重启应用）
# 用法: powershell -ExecutionPolicy Bypass -File tools/create-update-shortcut.ps1 [-Uninstall]

param(
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$Name = '更新 DSH Desktop'

$desktop = [Environment]::GetFolderPath('Desktop')
if (-not $desktop -or -not (Test-Path $desktop)) { throw "找不到桌面目录: $desktop" }
$lnk = Join-Path $desktop "$Name.lnk"

if ($Uninstall) {
  if (Test-Path $lnk) { Remove-Item $lnk -Force; Write-Host "已删除: $lnk" }
  else { Write-Host "不存在: $lnk" }
  return
}

$script = Join-Path $PSScriptRoot 'update-app.ps1'
if (-not (Test-Path $script)) { throw "找不到更新脚本: $script" }

$ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
if (-not (Test-Path $ps)) { $ps = 'powershell.exe' }

$icon = Join-Path $Root 'assets\icon.ico'
if (-not (Test-Path $icon)) { $icon = $ps }

$shell = New-Object -ComObject WScript.Shell
$sc = $shell.CreateShortcut($lnk)
$sc.TargetPath = $ps
$sc.Arguments = '-NoProfile -ExecutionPolicy Bypass -File "' + $script + '"'
$sc.WorkingDirectory = $Root
$sc.IconLocation = "$icon,0"
$sc.Description = '把 DSH Desktop 更新到新版本并重新启动'
$sc.WindowStyle = 1
$sc.Save()

$savedArgs = $sc.Arguments
[System.Runtime.InteropServices.Marshal]::ReleaseComObject($sc) | Out-Null
[System.Runtime.InteropServices.Marshal]::ReleaseComObject($shell) | Out-Null

Write-Host "已创建快捷方式"
Write-Host "  位置: $lnk"
Write-Host "  命令: $ps $savedArgs"

# 提示是否有待安装的新版本
$pending = Join-Path $Root 'dist-new'
if (Test-Path $pending) {
  Write-Host "`n检测到待安装的新版本: $pending" -ForegroundColor Green
  Write-Host "双击桌面上的「$Name」即可完成更新。" -ForegroundColor Green
} else {
  Write-Host "`n当前没有待安装的新版本（dist-new 不存在）。" -ForegroundColor Yellow
}
