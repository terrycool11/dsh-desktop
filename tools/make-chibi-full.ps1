# -*- coding: utf-8 -*-
# 用用户提供的全身 Q 版原图生成侧栏角色素材
#
#   1. 裁掉右下角的水印（按原图比例裁到 2390 高）
#   2. 洪水填充抠掉浅色背景（C# 编译执行，比 PowerShell 逐像素快得多）
#   3. 缩放到素材尺寸
#
# 产出: assets/chibi-full.png（透明底全身）
# 用法: powershell -ExecutionPolicy Bypass -File tools/make-chibi-full.ps1

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

public class BgCut {
  // 从四边向内洪水填充：与边缘连通、且接近背景色的像素 → 透明。
  // 基准色只取左上角小块（边缘可能压着人物）。
  public static int Run(string srcPath, string dstPath, int tolerance) {
    using (var src = new Bitmap(srcPath)) {
      int w = src.Width, h = src.Height;
      using (var bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb)) {
        using (var g = Graphics.FromImage(bmp)) {
          g.DrawImage(src, new Rectangle(0, 0, w, h));
        }
        var data = bmp.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.ReadWrite, PixelFormat.Format32bppArgb);
        int stride = data.Stride;
        byte[] buf = new byte[stride * h];
        Marshal.Copy(data.Scan0, buf, 0, buf.Length);

        int sr = 0, sg = 0, sb = 0, n = 0;
        for (int y = 0; y < 10 && y < h; y++) {
          for (int x = 0; x < 10 && x < w; x++) {
            int o = y * stride + x * 4;
            sb += buf[o]; sg += buf[o + 1]; sr += buf[o + 2]; n++;
          }
        }
        sr /= n; sg /= n; sb /= n;
        int tol2 = tolerance * tolerance * 3;

        bool[] seen = new bool[w * h];
        var q = new Queue<int>();
        // 只把匹配背景色的边缘像素作为种子
        for (int x = 0; x < w; x++) {
          int oTop = x * 4, oBot = (h - 1) * stride + x * 4;
          int dT = (buf[oTop + 2] - sr) * (buf[oTop + 2] - sr) + (buf[oTop + 1] - sg) * (buf[oTop + 1] - sg) + (buf[oTop] - sb) * (buf[oTop] - sb);
          if (dT <= tol2) q.Enqueue(x);
          int dB = (buf[oBot + 2] - sr) * (buf[oBot + 2] - sr) + (buf[oBot + 1] - sg) * (buf[oBot + 1] - sg) + (buf[oBot] - sb) * (buf[oBot] - sb);
          if (dB <= tol2) q.Enqueue((h - 1) * w + x);
        }
        for (int y = 0; y < h; y++) {
          int oL = y * stride, oR = y * stride + (w - 1) * 4;
          int dL = (buf[oL + 2] - sr) * (buf[oL + 2] - sr) + (buf[oL + 1] - sg) * (buf[oL + 1] - sg) + (buf[oL] - sb) * (buf[oL] - sb);
          if (dL <= tol2) q.Enqueue(y * w);
          int dR = (buf[oR + 2] - sr) * (buf[oR + 2] - sr) + (buf[oR + 1] - sg) * (buf[oR + 1] - sg) + (buf[oR] - sb) * (buf[oR] - sb);
          if (dR <= tol2) q.Enqueue(y * w + w - 1);
        }

        int cleared = 0;
        while (q.Count > 0) {
          int idx = q.Dequeue();
          if (seen[idx]) continue;
          seen[idx] = true;
          int x = idx % w, y = idx / w;
          int o = y * stride + x * 4;
          int dr = buf[o + 2] - sr, dg = buf[o + 1] - sg, db = buf[o] - sb;
          if (dr * dr + dg * dg + db * db > tol2) continue;
          buf[o + 3] = 0;
          cleared++;
          if (x > 0) q.Enqueue(idx - 1);
          if (x < w - 1) q.Enqueue(idx + 1);
          if (y > 0) q.Enqueue(idx - w);
          if (y < h - 1) q.Enqueue(idx + w);
        }

        Marshal.Copy(buf, 0, data.Scan0, buf.Length);
        bmp.UnlockBits(data);
        bmp.Save(dstPath, ImageFormat.Png);
        return cleared;
      }
    }
  }
}
"@ -ReferencedAssemblies System.Drawing

$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$Assets = Join-Path $Root 'assets'
$Gen = Join-Path $Assets 'generated'
New-Item -ItemType Directory -Force -Path $Gen | Out-Null

$source = Join-Path $Assets 'chibi-source.jpg'
if (-not (Test-Path $source)) { throw "找不到原图: $source" }

$img = [System.Drawing.Image]::FromFile($source)
Write-Host "原图: $($img.Width) x $($img.Height)"

# 1) 裁掉水印：原图 2496 高，水印在最底部；裁到 2390 保留鞋子
$cropH = [Math]::Min(2390, $img.Height)
$crop = New-Object System.Drawing.Rectangle(0, 0, $img.Width, $cropH)
$stage = New-Object System.Drawing.Bitmap($img.Width, $cropH, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$sg = [System.Drawing.Graphics]::FromImage($stage)
$sg.DrawImage($img, (New-Object System.Drawing.Rectangle(0, 0, $img.Width, $cropH)), $crop, [System.Drawing.GraphicsUnit]::Pixel)
$sg.Dispose(); $img.Dispose()
$stagePath = Join-Path $Gen 'chibi-stage.png'
$stage.Save($stagePath, [System.Drawing.Imaging.ImageFormat]::Png)
$stage.Dispose()
Write-Host "去水印裁切 → $($crop.Width) x $($crop.Height)"

# 2) 抠背景
$cutPath = Join-Path $Gen 'chibi-cut.png'
$cleared = [BgCut]::Run($stagePath, $cutPath, 34)
Write-Host "抠背景：清除 $cleared 像素"

# 3) 缩放到素材尺寸（2 倍图，显示时 1/2）
$TARGET_W = 300
$cut = [System.Drawing.Image]::FromFile($cutPath)
$targetH = [int]($cut.Height * $TARGET_W / $cut.Width)
$out = New-Object System.Drawing.Bitmap($TARGET_W, $targetH, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$og = [System.Drawing.Graphics]::FromImage($out)
$og.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$og.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$og.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
$og.DrawImage($cut, (New-Object System.Drawing.Rectangle(0, 0, $TARGET_W, $targetH)))
$og.Dispose()
$out.Save((Join-Path $Assets 'chibi-full.png'), [System.Drawing.Imaging.ImageFormat]::Png)
Write-Host "chibi-full.png  ${TARGET_W}×${targetH}  ($([math]::Round((Get-Item (Join-Path $Assets 'chibi-full.png')).Length/1KB)) KB)"

# 4) 预览：深色棋盘底，检查边缘与水印
$check = New-Object System.Drawing.Bitmap(($TARGET_W + 40), ($targetH + 40))
$cg = [System.Drawing.Graphics]::FromImage($check)
$cg.Clear([System.Drawing.Color]::FromArgb(255, 32, 36, 48))
$b1 = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 46, 52, 68))
for ($y = 0; $y -lt $check.Height; $y += 20) {
  for ($x = 0; $x -lt $check.Width; $x += 20) {
    if ((($x / 20) + ($y / 20)) % 2 -eq 0) { $cg.FillRectangle($b1, $x, $y, 20, 20) }
  }
}
$b1.Dispose()
$cg.DrawImage($out, 20, 20, $TARGET_W, $targetH)
$cg.Dispose()
$check.Save((Join-Path $Gen 'chibi-full-check.png'), [System.Drawing.Imaging.ImageFormat]::Png)
$check.Dispose(); $cut.Dispose(); $out.Dispose()

Write-Host "`n预览: assets\generated\chibi-full-check.png"
