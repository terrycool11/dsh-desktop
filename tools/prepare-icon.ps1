# -*- coding: utf-8 -*-
# 从原图生成应用图标素材（按尺寸自适应裁剪，保证小尺寸也认得出）：
#   assets/icon.png          256×256 PNG（窗口/启动页用）
#   assets/icon-32.png       32×32 PNG
#   assets/generated/icon-<n>.bgra   各尺寸原始 BGRA（交给 tools/make-icon.js 打成 ICO）
#   assets/generated/preview-<n>.png 各档裁剪效果预览
#
# 为什么分档裁剪：整张半身像缩到 16×16 只是一团色块，
# 所以小尺寸只取脸部特写，中大尺寸逐步放宽到大半身。
#
# 用法: powershell -ExecutionPolicy Bypass -File tools/prepare-icon.ps1 [-Source 路径] [-LargeSide 660] [-LargeX 130] [-LargeY 20]

param(
  [string]$Source = '',
  [int]$LargeSide = 660,
  [int]$LargeX = 130,
  [int]$LargeY = 20
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$Assets = Join-Path $Root 'assets'
$Gen = Join-Path $Assets 'generated'
New-Item -ItemType Directory -Force -Path $Gen | Out-Null

if (-not $Source) { $Source = Join-Path $Assets 'icon-source.jpg' }
if (-not (Test-Path $Source)) { throw "找不到原图: $Source" }

# 分档构图（原图 920×1136 坐标系）
# 参数是实测+网格对比挑出来的：眼睛在 y≈400-440、嘴 y≈520、脸中线 x≈465。
# 尺寸越小越贴脸，否则缩到 16px 就只剩一团色块。
function Get-Crop([int]$size) {
  if ($size -le 20) { return @{ Side = 280; Cx = 465; Cy = 420 } }   # 更紧的脸部特写
  if ($size -le 32) { return @{ Side = 320; Cx = 465; Cy = 430 } }
  if ($size -le 64) { return @{ Side = 430; Cx = 465; Cy = 450 } }   # 头肩
  return @{ Side = $LargeSide; X = $LargeX; Y = $LargeY }            # 大半身
}

$img = [System.Drawing.Image]::FromFile($Source)
try {
  Write-Host "原图: $($img.Width) x $($img.Height)"

  $Sizes = @(16, 20, 24, 32, 40, 48, 64, 128, 256)

  function Get-Bgra([System.Drawing.Bitmap]$bmp) {
    $w = $bmp.Width; $h = $bmp.Height
    $rect = New-Object System.Drawing.Rectangle(0, 0, $w, $h)
    $data = $bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly,
      [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    try {
      $out = New-Object byte[] ($w * $h * 4)
      $row = New-Object byte[] $data.Stride
      for ($y = 0; $y -lt $h; $y++) {
        $ptr = [IntPtr]::Add($data.Scan0, $y * $data.Stride)
        [System.Runtime.InteropServices.Marshal]::Copy($ptr, $row, 0, $data.Stride)
        [Array]::Copy($row, 0, $out, $y * $w * 4, $w * 4)
      }
      return $out
    } finally { $bmp.UnlockBits($data) }
  }

  foreach ($s in $Sizes) {
    $cropDef = Get-Crop $s
    $side = $cropDef.Side
    if ($cropDef.ContainsKey('Cx')) {
      $x = [int]($cropDef.Cx - $side / 2)
      $y = [int]($cropDef.Cy - $side / 2)
    } else {
      $x = $cropDef.X
      $y = $cropDef.Y
    }

    if ($side -gt $img.Width) { $side = $img.Width }
    if ($side -gt $img.Height) { $side = $img.Height }
    if ($x -lt 0) { $x = 0 }
    if ($y -lt 0) { $y = 0 }
    if ($x + $side -gt $img.Width) { $x = $img.Width - $side }
    if ($y + $side -gt $img.Height) { $y = $img.Height - $side }

    $crop = New-Object System.Drawing.Rectangle($x, $y, $side, $side)

    $bmp = New-Object System.Drawing.Bitmap($s, $s, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    try {
      $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
      $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
      $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
      $dst = New-Object System.Drawing.Rectangle(0, 0, $s, $s)
      $g.DrawImage($img, $dst, $crop, [System.Drawing.GraphicsUnit]::Pixel)
    } finally { $g.Dispose() }

    try {
      [System.IO.File]::WriteAllBytes((Join-Path $Gen "icon-$s.bgra"), (Get-Bgra $bmp))
      if ($s -eq 256) { $bmp.Save((Join-Path $Assets 'icon.png'), [System.Drawing.Imaging.ImageFormat]::Png) }
      if ($s -eq 32)  { $bmp.Save((Join-Path $Assets 'icon-32.png'), [System.Drawing.Imaging.ImageFormat]::Png) }
      if (@(16, 32, 64, 256) -contains $s) {
        $pv = New-Object System.Drawing.Bitmap(256, 256)
        $pg = [System.Drawing.Graphics]::FromImage($pv)
        $pg.InterpolationMode = 'NearestNeighbor'
        $pg.DrawImage($bmp, 0, 0, 256, 256)
        $pg.Dispose()
        $pv.Save((Join-Path $Gen "preview-$s.png"), [System.Drawing.Imaging.ImageFormat]::Png)
        $pv.Dispose()
      }
    } finally { $bmp.Dispose() }

    $tag = if ($s -le 32) { '脸部特写' } elseif ($s -le 64) { '头肩' } else { '大半身' }
    Write-Host ("  {0,3}x{0,-3} 裁剪 {1}px @({2},{3})  [{4}]" -f $s, $side, $x, $y, $tag)
  }
} finally {
  $img.Dispose()
}

Write-Host "`n下一步: node tools/make-icon.js  （把 BGRA 打包成多尺寸 icon.ico）"
