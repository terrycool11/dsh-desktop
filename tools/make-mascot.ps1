# -*- coding: utf-8 -*-
# 从原图生成 Q 版形象（Q 版头像 / 半身贴纸）
#
# 说明：没有图像生成模型，只能用原图裁切 + 圆形遮罩 + 描边做成"Q版头像贴纸"。
# 源图 920×1136，脸部实测：眼睛 y≈400-440、嘴 y≈520、脸中线 x≈465。
#
# 产出:
#   assets/mascot.png        256×256 圆形贴纸（侧栏头像用）
#   assets/mascot-64.png     64×64
#   assets/mascot-chibi.png  256×300 "大头+小肩" 的 Q 版半身
#   assets/generated/mascot-preview.png  放大预览
#
# 用法: powershell -ExecutionPolicy Bypass -File tools/make-mascot.ps1

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$Assets = Join-Path $Root 'assets'
$Gen = Join-Path $Assets 'generated'
New-Item -ItemType Directory -Force -Path $Gen | Out-Null

$src = Join-Path $Assets 'icon-source.jpg'
if (-not (Test-Path $src)) { throw "找不到原图: $src" }
$img = [System.Drawing.Image]::FromFile($src)

function New-RoundedPath([int]$w, [int]$h, [int]$r) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $r * 2
  $p.AddArc(0, 0, $d, $d, 180, 90)
  $p.AddArc($w - $d - 1, 0, $d, $d, 270, 90)
  $p.AddArc($w - $d - 1, $h - $d - 1, $d, $d, 0, 90)
  $p.AddArc(0, $h - $d - 1, $d, $d, 90, 90)
  $p.CloseFigure()
  return $p
}

# ---------- 1. 圆形 Q 版头像贴纸 ----------
# 头部取景：以脸为中心的正方形（含刘海、蝴蝶结、发梢）
$headSide = 560
$headCx = 465
$headCy = 358
$headX = [int]($headCx - $headSide / 2)
$headY = [int]($headCy - $headSide / 2)
if ($headX -lt 0) { $headX = 0 }
if ($headY -lt 0) { $headY = 0 }
if ($headX + $headSide -gt $img.Width) { $headX = $img.Width - $headSide }
if ($headY + $headSide -gt $img.Height) { $headY = $img.Height - $headSide }
$headBox = New-Object System.Drawing.Rectangle($headX, $headY, $headSide, $headSide)
Write-Host "头像取景: ${headSide}px @($headX,$headY)"

function New-HeadSticker([int]$size) {
  $bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  try {
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality

    # 圆形遮罩里画头像（稍微放大 + 略微压扁，接近 Q 版的大头比例）
    $inset = [int]($size * 0.045)          # 留出描边空间
    $inner = $size - $inset * 2
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $path.AddEllipse($inset, $inset, $inner, $inner)
    $g.SetClip($path)
    $g.TranslateTransform($size / 2, $size / 2)
    $g.ScaleTransform(1.06, 0.98)          # 轻微压扁 → Q 版感
    $g.TranslateTransform(-$size / 2, -$size / 2)
    $g.DrawImage($img, (New-Object System.Drawing.Rectangle(0, 0, $size, $size)), $headBox, [System.Drawing.GraphicsUnit]::Pixel)
    $g.ResetTransform()
    $g.ResetClip()

    # 白色描边 + 内圈淡蓝
    $penW = [Math]::Max(2, [int]($size * 0.032))
    $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::White, $penW)
    $g.DrawEllipse($pen, $inset, $inset, $inner, $inner)
    $pen.Dispose()
    $pen2 = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(120, 120, 170, 230), [Math]::Max(1, [int]($size * 0.012)))
    $off = $inset + $penW / 2
    $g.DrawEllipse($pen2, $off, $off, $size - $off * 2, $size - $off * 2)
    $pen2.Dispose()
  } finally { $g.Dispose() }
  return $bmp
}

foreach ($s in @(64, 128, 256)) {
  $b = New-HeadSticker $s
  $name = switch ($s) { 256 { 'mascot.png' } 128 { 'mascot-128.png' } default { 'mascot-64.png' } }
  $b.Save((Join-Path $Assets $name), [System.Drawing.Imaging.ImageFormat]::Png)
  if ($s -eq 256) { $b.Save((Join-Path $Gen 'mascot-256.png'), [System.Drawing.Imaging.ImageFormat]::Png) }
  $b.Dispose()
  Write-Host "  已生成 $name (${s}×${s})"
}

# ---------- 2. Q 版半身：大头 + 缩小的肩膀 ----------
# 把头部放大后叠在缩小的人体上，做出"大头小身"的比例
$chibiW = 256; $chibiH = 300
$chibi = New-Object System.Drawing.Bitmap($chibiW, $chibiH, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$cg = [System.Drawing.Graphics]::FromImage($chibi)
try {
  $cg.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $cg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $cg.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality

  # 身体：原图肩部/胸口，压小后放在头部下方（先画身体，再画头压住脖子）
  $bodyBox = New-Object System.Drawing.Rectangle(255, 640, 470, 350)
  $bodyDst = New-Object System.Drawing.Rectangle(56, 168, 144, 116)
  $bodyPath = New-RoundedPath $bodyDst.X $bodyDst.Y $bodyDst.Width $bodyDst.Height 30
  $cg.SetClip($bodyPath)
  $cg.DrawImage($img, $bodyDst, $bodyBox, [System.Drawing.GraphicsUnit]::Pixel)
  $cg.ResetClip()

  # 头：放大成 190px 的圆，叠在身体上方
  $headDst = New-Object System.Drawing.Rectangle(33, 4, 190, 190)
  $headPath = New-Object System.Drawing.Drawing2D.GraphicsPath
  $headPath.AddEllipse($headDst)
  $cg.SetClip($headPath)
  $cg.DrawImage($img, $headDst, $headBox, [System.Drawing.GraphicsUnit]::Pixel)
  $cg.ResetClip()
  $penH = New-Object System.Drawing.Pen([System.Drawing.Color]::White, 5)
  $cg.DrawEllipse($penH, $headDst)
  $penH.Dispose()
} finally { $cg.Dispose() }
$chibi.Save((Join-Path $Assets 'mascot-chibi.png'), [System.Drawing.Imaging.ImageFormat]::Png)
$chibi.Dispose()
Write-Host "  已生成 mascot-chibi.png (${chibiW}×${chibiH})"

# ---------- 3. 预览图 ----------
$head256 = [System.Drawing.Image]::FromFile((Join-Path $Assets 'mascot.png'))
$chibiImg = [System.Drawing.Image]::FromFile((Join-Path $Assets 'mascot-chibi.png'))
$sheet = New-Object System.Drawing.Bitmap(640, 340)
$sg = [System.Drawing.Graphics]::FromImage($sheet)
$sg.Clear([System.Drawing.Color]::FromArgb(255, 18, 22, 32))
$sg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$sg.DrawImage($head256, 20, 42, 256, 256)
$sg.DrawImage($chibiImg, 320, 20, 256, 300)
$font = New-Object System.Drawing.Font('Segoe UI', 11)
$sg.DrawString('mascot.png (圆形贴纸)', $font, [System.Drawing.Brushes]::White, 20, 14)
$sg.DrawString('mascot-chibi.png (大头小身)', $font, [System.Drawing.Brushes]::White, 320, 0)
$sg.Dispose()
$sheet.Save((Join-Path $Gen 'mascot-preview.png'), [System.Drawing.Imaging.ImageFormat]::Png)
$sheet.Dispose(); $head256.Dispose(); $chibiImg.Dispose(); $img.Dispose()

Write-Host "`n预览: assets\generated\mascot-preview.png"
