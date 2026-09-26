# -*- coding: utf-8 -*-
# 启动（或复用）一个「独立的」网页版 dsh 服务，并在桌面放置入口。
#
# 关键点：用 WMI 创建进程，父进程是 WmiPrvSE 而不是本脚本，
# 所以这个服务不属于 DSH Desktop 的进程树 —— 桌面应用关闭/重启都不会影响它。
# 会话数据存在 ~/.dsh，网页版与桌面版看到的是同一批会话，无需导入导出。
#
# 用法:
#   powershell -ExecutionPolicy Bypass -File tools/start-web.ps1 [-Port 3081] [-Restart]

param(
  [int]$Port = 3081,
  [switch]$Restart
)

$ErrorActionPreference = 'Stop'

# node：优先环境变量，其次 PATH，最后尝试常见安装位置
$Node = $env:DSH_NODE
if (-not $Node) {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { $Node = $cmd.Source }
}
if (-not $Node) { $Node = 'node.exe' }
$Bin = Join-Path $env:APPDATA 'npm\node_modules\@deepseek-ai\dsh\lib\bin.js'
if (-not (Test-Path $Bin)) { throw "找不到 dsh 入口: $Bin（请先 npm i -g @deepseek-ai/dsh）" }

$Log = Join-Path $env:TEMP "dsh-web-$Port.log"
$Workspace = if ($env:DSH_WORKSPACE) { $env:DSH_WORKSPACE } else { $env:USERPROFILE }

function Get-RunningServer {
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match 'bin\.js' -and $_.CommandLine -match "--port $Port" } |
    Select-Object -First 1
}

function Get-UrlFromLog {
  if (-not (Test-Path $Log)) { return $null }
  $t = Get-Content $Log -Raw -Encoding UTF8 -ErrorAction SilentlyContinue
  if (-not $t) { return $null }
  $m = [regex]::Match($t, 'dsh web:\s*(http://\S+)')
  if ($m.Success) { return $m.Groups[1].Value }
  return $null
}

$existing = Get-RunningServer
if ($existing -and $Restart) {
  Write-Host "结束已有服务 pid=$($existing.ProcessId)"
  Stop-Process -Id $existing.ProcessId -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
  $existing = $null
}

if ($existing) {
  Write-Host "复用已在运行的服务 pid=$($existing.ProcessId)"
  $url = Get-UrlFromLog
  if (-not $url) { Write-Host "  日志里没有地址，重启该服务…"; Stop-Process -Id $existing.ProcessId -Force; Start-Sleep -Seconds 2; $existing = $null }
}

if (-not $existing) {
  Remove-Item $Log -Force -ErrorAction SilentlyContinue
  # stdin 接 NUL：WMI 创建的进程没有控制台，若不接上 stdin，服务可能因读到 EOF 而自行退出
  $cmdLine = 'cmd.exe /c ""' + $Node + '" "' + $Bin + '" web --no-open --port ' + $Port + ' < NUL > "' + $Log + '" 2>&1"'
  Write-Host "启动独立服务（WMI，不挂在当前进程树下）…"
  $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
    CommandLine = $cmdLine
    CurrentDirectory = $Workspace
  }
  if ($r.ReturnValue -ne 0) { throw "进程创建失败，ReturnValue=$($r.ReturnValue)" }
  Write-Host "  pid=$($r.ProcessId)，等待输出访问地址…"
  for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Seconds 2
    $url = Get-UrlFromLog
    if ($url) { break }
  }
}

if (-not $url) { throw "没有从日志里拿到访问地址，请查看 $Log" }

Write-Host ""
Write-Host "网页版地址:" -ForegroundColor Green
Write-Host "  $url" -ForegroundColor White

# 存一份地址，方便随时查看
$store = Join-Path $env:APPDATA 'DSH Desktop'
New-Item -ItemType Directory -Force -Path $store | Out-Null
Set-Content -Path (Join-Path $store 'web-url.txt') -Value $url -Encoding UTF8

# 桌面入口（.url 会用默认浏览器打开）
$desktop = [Environment]::GetFolderPath('Desktop')
$urlFile = Join-Path $desktop 'DSH 网页版.url'
$icon = Join-Path (Split-Path $PSScriptRoot -Parent) 'assets\icon.ico'
@(
  '[InternetShortcut]'
  "URL=$url"
  "IconFile=$icon"
  'IconIndex=0'
) | Set-Content -Path $urlFile -Encoding ASCII

Write-Host ""
Write-Host "桌面入口已就绪: $urlFile" -ForegroundColor Green
Write-Host "（token 会随服务重启变化，重启后重新运行本脚本即可刷新入口）" -ForegroundColor DarkGray
