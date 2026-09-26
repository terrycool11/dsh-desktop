Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class ShellIcon {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Auto)]
  public struct SHFILEINFO { public IntPtr hIcon; public int iIcon; public uint dwAttributes;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=260)] public string szDisplayName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=80)] public string szTypeName; }
  [DllImport("shell32.dll", CharSet=CharSet.Auto)]
  public static extern IntPtr SHGetFileInfo(string pszPath, uint dwFileAttributes, ref SHFILEINFO psfi, uint cbFileInfo, uint uFlags);
  [DllImport("user32.dll")] public static extern bool DestroyIcon(IntPtr hIcon);
}
"@

$lnk = Join-Path ([Environment]::GetFolderPath('Desktop')) 'DSH Desktop.lnk'
Write-Host "快捷方式: $lnk"

$sh = New-Object -ComObject WScript.Shell
$sc = $sh.CreateShortcut($lnk)
Write-Host "  IconLocation: $($sc.IconLocation)"
Write-Host "  目标: $($sc.TargetPath)"
[System.Runtime.InteropServices.Marshal]::ReleaseComObject($sc) | Out-Null
[System.Runtime.InteropServices.Marshal]::ReleaseComObject($sh) | Out-Null

$outDir = Join-Path (Split-Path $PSScriptRoot -Parent) '.preview'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$SHGFI_ICON = 0x100

$cases = @(
  @{ name = 'shellicon-large'; flags = 0x100 },
  @{ name = 'shellicon-small'; flags = 0x101 }
)

foreach ($c in $cases) {
  $fi = New-Object ShellIcon+SHFILEINFO
  $size = [System.Runtime.InteropServices.Marshal]::SizeOf($fi)
  $r = [ShellIcon]::SHGetFileInfo($lnk, 0, [ref]$fi, [uint32]$size, [uint32]$c.flags)
  if ($fi.hIcon -ne [IntPtr]::Zero) {
    $ico = [System.Drawing.Icon]::FromHandle($fi.hIcon)
    $bmp = $ico.ToBitmap()
    $scale = New-Object System.Drawing.Bitmap(192, 192)
    $g = [System.Drawing.Graphics]::FromImage($scale)
    $g.InterpolationMode = 'NearestNeighbor'
    $g.DrawImage($bmp, 0, 0, 192, 192)
    $g.Dispose()
    $out = Join-Path $outDir ($c.name + '.png')
    $scale.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
    Write-Host "  $($c.name): 实际 $($bmp.Width)x$($bmp.Height) -> $out"
    $scale.Dispose(); $bmp.Dispose(); $ico.Dispose()
    [void][ShellIcon]::DestroyIcon($fi.hIcon)
  } else {
    Write-Host "  $($c.name): 取图标失败"
  }
}

Write-Host ""
$icoPath = Join-Path (Split-Path $PSScriptRoot -Parent) 'assets\icon.ico'
if (Test-Path $icoPath) {
  Get-Item $icoPath | ForEach-Object {
    Write-Host ("  icon.ico  {0:N1} KB  {1}" -f ($_.Length / 1KB), $_.LastWriteTime)
  }
}
