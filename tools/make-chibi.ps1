# -*- coding: utf-8 -*-
# 用抠好的人物拼一个完整 Q 版，并拆成可动画的部件
#
#   assets/chibi-upper.png   原图上半身（头+发+躯干+手，透明底）300×355
#   assets/chibi-lower.png   画的裙摆+腿+鞋（透明底）360×230
#   assets/chibi-arm.png     画的可挥手手臂（透明底，枢轴在顶端）100×190
#   assets/generated/chibi-preview.png  合成预览（也是 CSS 布局参考）
#
# 几何依据（实测轮廓）：y=1090 处人物（主要是头发）铺满约 919px 宽，
# 所以裙摆顶部做成与躯干同宽、再向外张开，接缝就不会出现台阶。
#
# 用法: powershell -ExecutionPolicy Bypass -File tools/make-chibi.ps1

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$Assets = Join-Path $Root 'assets'
$Gen = Join-Path $Assets 'generated'
New-Item -ItemType Directory -Force -Path $Gen | Out-Null

$cut = Join-Path $Gen 'cutout.png'
if (-not (Test-Path $cut)) { throw "先跑 tools/cutout.ps1 生成 $cut" }
$src = [System.Drawing.Image]::FromFile($cut)

# 配色（取自原图）
$navy      = [System.Drawing.Color]::FromArgb(255, 40, 52, 98)
$navyLight = [System.Drawing.Color]::FromArgb(255, 56, 72, 130)
$navyDark  = [System.Drawing.Color]::FromArgb(255, 30, 39, 74)
$white     = [System.Drawing.Color]::FromArgb(255, 255, 255, 255)
$whiteSoft = [System.Drawing.Color]::FromArgb(255, 243, 246, 255)
$blue      = [System.Drawing.Color]::FromArgb(255, 74, 123, 247)
$skin      = [System.Drawing.Color]::FromArgb(255, 248, 220, 203)
$shoe      = [System.Drawing.Color]::FromArgb(255, 28, 35, 66)

function New-RoundedPath([single]$x, [single]$y, [single]$w, [single]$h, [single]$r) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = [single]($r * 2)
  if ($d -gt $w) { $d = $w }
  if ($d -gt $h) { $d = $h }
  $p.AddArc($x, $y, $d, $d, 180, 90)
  $p.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
  $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
  $p.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
  $p.CloseFigure()
  return $p
}
function Fill-Rounded($g, $brush, $x, $y, $w, $h, $r) {
  $p = New-RoundedPath $x $y $w $h $r
  $g.FillPath($brush, $p)
  $p.Dispose()
}

# ---------- 1. 上半身 ----------
$UP_W = 300
$upSrc = New-Object System.Drawing.Rectangle(0, 0, 920, 1090)
$UP_H = [int]($upSrc.Height * $UP_W / $upSrc.Width)     # 355
$upper = New-Object System.Drawing.Bitmap($UP_W, $UP_H, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$ug = [System.Drawing.Graphics]::FromImage($upper)
$ug.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$ug.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$ug.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
$ug.DrawImage($src, (New-Object System.Drawing.Rectangle(0, 0, $UP_W, $UP_H)), $upSrc, [System.Drawing.GraphicsUnit]::Pixel)
$ug.Dispose()

# 底部 90px alpha 渐隐：原图在胯部被裁断，发梢是条硬边，
# 渐隐之后再叠裙摆，接缝就不是一条直线了。
$fadeH = 90
for ($y = $UP_H - $fadeH; $y -lt $UP_H; $y++) {
  $k = ($UP_H - $y) / $fadeH          # 0(最底) → 1(渐隐起点)
  for ($x = 0; $x -lt $UP_W; $x++) {
    $c = $upper.GetPixel($x, $y)
    if ($c.A -gt 0) {
      $upper.SetPixel($x, $y, [System.Drawing.Color]::FromArgb([int]($c.A * $k), $c.R, $c.G, $c.B))
    }
  }
}

$upper.Save((Join-Path $Assets 'chibi-upper.png'), [System.Drawing.Imaging.ImageFormat]::Png)
Write-Host "chibi-upper.png  ${UP_W}×${UP_H}（底部 ${fadeH}px 渐隐）"

# ---------- 2. 下半身：裙摆 + 围裙 + 腿 + 鞋 ----------
$LOW_W = 300; $LOW_H = 200
$lower = New-Object System.Drawing.Bitmap($LOW_W, $LOW_H, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$lg = [System.Drawing.Graphics]::FromImage($lower)
$lg.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias

$navyBrush   = New-Object System.Drawing.SolidBrush($navy)
$navyLBrush  = New-Object System.Drawing.SolidBrush($navyLight)
$navyDBrush  = New-Object System.Drawing.SolidBrush($navyDark)
$whiteBrush  = New-Object System.Drawing.SolidBrush($white)
$whiteSBrush = New-Object System.Drawing.SolidBrush($whiteSoft)
$blueBrush   = New-Object System.Drawing.SolidBrush($blue)
$shoeBrush   = New-Object System.Drawing.SolidBrush($shoe)

# A 字裙：顶部按腰宽（约 120），向下张到 220
$skirt = New-Object System.Drawing.Drawing2D.GraphicsPath
$skirt.AddLine(90, 0)
$skirt.AddBezier(90, 40, 62, 78, 50, 104, 42, 128)
$skirt.AddLine(42, 128, 258, 128)
$skirt.AddBezier(258, 128, 250, 104, 238, 78, 210, 40)
$skirt.AddLine(210, 40, 210, 0)
$skirt.CloseFigure()
$lg.FillPath($navyBrush, $skirt)
$skirt.Dispose()

# 裙摆下缘暗色收边（体积感）
$hem = New-Object System.Drawing.Drawing2D.GraphicsPath
$hem.AddBezier(42, 112, 100, 140, 200, 140, 258, 112)
$hem.AddLine(258, 132, 42, 132)
$hem.CloseFigure()
$lg.FillPath($navyDBrush, $hem)
$hem.Dispose()

# 白色围裙
Fill-Rounded $lg $whiteSBrush 112 0 76 118 15
Fill-Rounded $lg $whiteBrush  112 0 76 14 7
# 蓝色腰带 + 扣子
Fill-Rounded $lg $blueBrush 100 0 100 14 7
Fill-Rounded $lg $blueBrush 142 18 16 10 5

# 腿（白丝袜）
Fill-Rounded $lg $whiteBrush 124 122 24 40 12
Fill-Rounded $lg $whiteBrush 152 122 24 40 12
# 鞋
Fill-Rounded $lg $shoeBrush 118 154 34 20 10
Fill-Rounded $lg $shoeBrush 148 154 34 20 10

$lg.Dispose()
$lower.Save((Join-Path $Assets 'chibi-lower.png'), [System.Drawing.Imaging.ImageFormat]::Png)
$navyBrush.Dispose(); $navyLBrush.Dispose(); $navyDBrush.Dispose(); $whiteBrush.Dispose()
$whiteSBrush.Dispose(); $blueBrush.Dispose(); $shoeBrush.Dispose()
Write-Host "chibi-lower.png  ${LOW_W}×${LOW_H}"

# ---------- 3. 可挥手的手臂（枢轴 = 图像顶端中央） ----------
$ARM_W = 100; $ARM_H = 190
$arm = New-Object System.Drawing.Bitmap($ARM_W, $ARM_H, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$ag = [System.Drawing.Graphics]::FromImage($arm)
$ag.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$navyBrush2 = New-Object System.Drawing.SolidBrush($navy)
$navyLBrush2 = New-Object System.Drawing.SolidBrush($navyLight)
$whiteBrush2 = New-Object System.Drawing.SolidBrush($white)
$skinBrush2 = New-Object System.Drawing.SolidBrush($skin)

Fill-Rounded $ag $navyBrush2 18 6 64 118 30        # 泡泡袖
Fill-Rounded $ag $navyLBrush2 24 14 22 60 11       # 袖子高光
Fill-Rounded $ag $whiteBrush2 22 116 56 20 10      # 白色袖口
Fill-Rounded $ag $skinBrush2 28 130 44 46 21       # 手

$ag.Dispose()
$arm.Save((Join-Path $Assets 'chibi-arm.png'), [System.Drawing.Imaging.ImageFormat]::Png)
$navyBrush2.Dispose(); $navyLBrush2.Dispose(); $whiteBrush2.Dispose(); $skinBrush2.Dispose()
Write-Host "chibi-arm.png    ${ARM_W}×${ARM_H}"

# ---------- 4. 合成预览（= CSS 里的层叠顺序与相对位置） ----------
$PW = 420; $PH = 620
$sheet = New-Object System.Drawing.Bitmap($PW, $PH)
$sg = [System.Drawing.Graphics]::FromImage($sheet)
$sg.Clear([System.Drawing.Color]::FromArgb(255, 245, 247, 253))
$sg.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$sg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic

$lowerImg = [System.Drawing.Image]::FromFile((Join-Path $Assets 'chibi-lower.png'))
$upperImg = [System.Drawing.Image]::FromFile((Join-Path $Assets 'chibi-upper.png'))
$armImg   = [System.Drawing.Image]::FromFile((Join-Path $Assets 'chibi-arm.png'))

# 落地阴影
$shadowBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(34, 40, 60, 110))
$sg.FillEllipse($shadowBrush, 156, 494, 108, 20)
$shadowBrush.Dispose()

$sc = 1.05
$uw = [int]($UP_W * $sc); $uh = [int]($UP_H * $sc)      # 315 × 373
$lw = [int]($LOW_W * $sc); $lh = [int]($LOW_H * $sc)    # 315 × 210
$ux = [int](($PW - $uw) / 2)
$lx = [int](($PW - $lw) / 2)
$topY = 20
$ov = 96                                                # 裙摆与躯干的重叠量（盖住渐隐区）
$ly = $topY + $uh - $ov

# 手臂先画（在身体后面）：枢轴放在右肩外侧，向上举起，这样不会被头发盖住
$aw = [int]($ARM_W * $sc); $ah = [int]($ARM_H * $sc)
$save = $sg.Save()
$sg.TranslateTransform($ux + 292, $topY + 150)
$sg.RotateTransform(-34)
$sg.DrawImage($armImg, -18, 0, $aw, $ah)
$sg.Restore($save)

$sg.DrawImage($lowerImg, $lx, $ly, $lw, $lh)
$sg.DrawImage($upperImg, $ux, $topY, $uw, $uh)

$font = New-Object System.Drawing.Font('Segoe UI', 10)
$sg.DrawString('chibi: lower -> arm -> upper', $font, [System.Drawing.Brushes]::DimGray, 12, 8)
$sg.Dispose()
$sheet.Save((Join-Path $Gen 'chibi-preview.png'), [System.Drawing.Imaging.ImageFormat]::Png)
$sheet.Dispose(); $lowerImg.Dispose(); $upperImg.Dispose(); $armImg.Dispose(); $src.Dispose()

Write-Host "`n预览: assets\generated\chibi-preview.png"
