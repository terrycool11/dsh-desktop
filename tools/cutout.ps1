# -*- coding: utf-8 -*-
# 从原图抠出人物（背景透明化），并切成可动画的部件
#
# 用 Add-Type 编译一段 C# 做洪水填充（PowerShell 逐像素太慢）。
# 产出：
#   assets/generated/cutout.png        整幅抠图（调试用）
#   assets/generated/cutout-head.png   头部区域抠图（调试用）
#
# 用法: powershell -ExecutionPolicy Bypass -File tools/cutout.ps1 [-Tolerance 30]

param([int]$Tolerance = 30)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

public class CutoutTool {
  // 从四边向内做洪水填充，把"与边缘连通的、接近背景色"的像素变透明。
  // 返回被清除的像素数。
  public static int Run(string srcPath, string dstPath, int tolerance, Rectangle? crop) {
    using (var src = new Bitmap(srcPath)) {
      Rectangle rect = crop.HasValue ? crop.Value : new Rectangle(0, 0, src.Width, src.Height);
      int w = rect.Width, h = rect.Height;
      using (var bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb)) {
        using (var g = Graphics.FromImage(bmp)) {
          g.DrawImage(src, new Rectangle(0, 0, w, h), rect, GraphicsUnit.Pixel);
        }

        var data = bmp.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.ReadWrite, PixelFormat.Format32bppArgb);
        int stride = data.Stride;
        byte[] buf = new byte[stride * h];
        Marshal.Copy(data.Scan0, buf, 0, buf.Length);

        // 背景基准色：只取左上角 8×8 小块（裁剪框的边缘可能压着人物，不能拿来平均）
        int sr = 0, sg = 0, sb = 0, n = 0;
        for (int y = 0; y < 8 && y < h; y++) {
          for (int x = 0; x < 8 && x < w; x++) {
            int o = y * stride + x * 4;
            sb += buf[o]; sg += buf[o + 1]; sr += buf[o + 2]; n++;
          }
        }
        sr /= n; sg /= n; sb /= n;
        int tol2 = tolerance * tolerance * 3;
        Func<int, bool> isBg = delegate(int o) {
          int dr = buf[o + 2] - sr, dg = buf[o + 1] - sg, db = buf[o] - sb;
          return dr * dr + dg * dg + db * db <= tol2;
        };

        bool[] seen = new bool[w * h];
        var q = new Queue<int>();
        // 只把"确实是背景色"的边缘像素当种子，否则会从人物边缘往里灌
        for (int x = 0; x < w; x++) {
          if (isBg(x * 4)) q.Enqueue(x);
          if (isBg((h - 1) * stride + x * 4)) q.Enqueue((h - 1) * w + x);
        }
        for (int y = 0; y < h; y++) {
          if (isBg(y * stride)) q.Enqueue(y * w);
          if (isBg(y * stride + (w - 1) * 4)) q.Enqueue(y * w + w - 1);
        }

        int cleared = 0;
        while (q.Count > 0) {
          int idx = q.Dequeue();
          if (seen[idx]) continue;
          seen[idx] = true;
          int x = idx % w, y = idx / w;
          int o = y * stride + x * 4;
          if (!isBg(o)) continue;              // 撞到人物轮廓就停
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
$src = Join-Path $Assets 'icon-source.jpg'

Write-Host "整幅抠图 (tolerance=$Tolerance)…"
$c1 = [CutoutTool]::Run($src, (Join-Path $Gen 'cutout.png'), $Tolerance, $null)
Write-Host "  清除背景像素: $c1"

Write-Host "头部区域抠图…"
$headRect = New-Object System.Drawing.Rectangle(180, 40, 570, 600)
$c2 = [CutoutTool]::Run($src, (Join-Path $Gen 'cutout-head.png'), $Tolerance, $headRect)
Write-Host "  清除背景像素: $c2"

Write-Host "`n预览: assets\generated\cutout.png / cutout-head.png"
