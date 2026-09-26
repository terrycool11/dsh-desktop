# -*- coding: utf-8 -*-
# 在桌面创建「DSH Desktop」快捷方式（可重复运行，会覆盖旧的）
# 用法: powershell -ExecutionPolicy Bypass -File tools/create-shortcut.ps1

param(
  [string]$Name = 'DSH Desktop',
  [string]$Target,          # 默认自动定位打包后的 exe
  [switch]$AllUsers,        # 装到「公共桌面」而不是当前用户桌面
  [switch]$Uninstall        # 删除快捷方式
)

$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

function Find-Target {
  $dist = Join-Path $Root 'dist'
  if (Test-Path $dist) {
    # 两种布局都要认：
    #   dist\DSH Desktop.exe                    （更新器换上来的布局）
    #   dist\DSH Desktop-win32-x64\DSH Desktop.exe（electron-packager 原始布局）
    $flat = Join-Path $dist "$Name.exe"
    if (Test-Path $flat) { return $flat }
    $nested = Get-ChildItem $dist -Directory -ErrorAction SilentlyContinue |
      ForEach-Object { Join-Path $_.FullName "$Name.exe" } |
      Where-Object { Test-Path $_ } | Select-Object -First 1
    if ($nested) { return $nested }
  }

  # 回退到开发模式的 electron.exe
  $dev = Join-Path $Root 'node_modules\electron\dist\electron.exe'
  if (Test-Path $dev) { return $dev }
  return $null
}

if ($AllUsers) {
  $desktop = [Environment]::GetFolderPath('CommonDesktopDirectory')
} else {
  $desktop = [Environment]::GetFolderPath('Desktop')
}
if (-not $desktop -or -not (Test-Path $desktop)) { throw "找不到桌面目录: $desktop" }

$lnk = Join-Path $desktop "$Name.lnk"

if ($Uninstall) {
  if (Test-Path $lnk) { Remove-Item $lnk -Force; Write-Host "已删除快捷方式: $lnk" }
  else { Write-Host "快捷方式不存在: $lnk" }
  return
}

if (-not $Target) { $Target = Find-Target }
if (-not $Target) { throw "找不到可执行文件。请先运行 npm run package 生成 dist 目录。" }
if (-not (Test-Path $Target)) { throw "目标不存在: $Target" }

# 打包产物是独立 exe；开发模式回退时需要把项目目录作为参数传给 electron
$arguments = ''
$workingDir = Split-Path $Target -Parent
if ((Split-Path $Target -Leaf) -eq 'electron.exe') {
  $arguments = '"' + $Root + '"'
  $workingDir = $Root
}

# 图标优先取自 exe 自身：exe 每次打包都会被替换（大小/时间戳变化），
# Windows 图标缓存不会按旧键命中；指向外部 .ico 反而容易显示缓存里的旧图。
$icon = $null
if ((Split-Path $Target -Leaf) -eq 'electron.exe') {
  $exeIcon = Join-Path $Root 'assets\icon.ico'
  if (Test-Path $exeIcon) { $icon = "$exeIcon,0" }
} else {
  $icon = "$Target,0"
}
if (-not $icon) { $icon = "$Target,0" }

$shell = New-Object -ComObject WScript.Shell
$sc = $shell.CreateShortcut($lnk)
$sc.TargetPath = $Target
$sc.Arguments = $arguments
$sc.WorkingDirectory = $workingDir
$sc.IconLocation = $icon
$sc.Description = 'DeepSeek Harness 桌面客户端'
$sc.WindowStyle = 1
$sc.Save()

# 释放 COM
[System.Runtime.InteropServices.Marshal]::ReleaseComObject($sc) | Out-Null
[System.Runtime.InteropServices.Marshal]::ReleaseComObject($shell) | Out-Null

Write-Host "已创建快捷方式"
Write-Host "  位置: $lnk"
Write-Host "  目标: $Target $arguments"
Write-Host "  图标: $icon"
Write-Host "  工作目录: $workingDir"
