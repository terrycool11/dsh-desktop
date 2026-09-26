# -*- coding: utf-8 -*-
# 一键把本仓库发布到 GitHub（本机没有 git/gh，走 REST API）
#
# 凭据来源：Windows 凭据管理器里 Git Credential Manager 存的 GitHub token
#          （target = git:https://<用户名>@github.com）
# token 只在内存里传给 node 子进程，不写盘、不打印。
#
# 用法:
#   powershell -ExecutionPolicy Bypass -File tools/publish-github.ps1
#   powershell -ExecutionPolicy Bypass -File tools/publish-github.ps1 -Repo someone/other-repo

param(
  [string]$Repo = 'terrycool11/dsh-desktop',
  [string]$CredTarget = 'git:https://terrycool11@github.com'
)

$ErrorActionPreference = 'Stop'

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class CredRead2 {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct CREDENTIAL {
    public int Flags; public int Type;
    public string TargetName; public string Comment;
    public long LastWritten;
    public int CredentialBlobSize; public IntPtr CredentialBlob;
    public int Persist; public int AttributeCount; public IntPtr Attributes;
    public string TargetAlias; public string UserName;
  }
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool CredRead(string target, int type, int flags, out IntPtr credential);
  [DllImport("advapi32.dll")] public static extern void CredFree(IntPtr cred);
}
"@

$ptr = [IntPtr]::Zero
if (-not [CredRead2]::CredRead($CredTarget, 1, 0, [ref]$ptr)) {
  throw "读不到凭据: $CredTarget（请先用 git 或 VS 登录过 GitHub）"
}
try {
  $c = [System.Runtime.InteropServices.Marshal]::PtrToStructure($ptr, [type][CredRead2+CREDENTIAL])
  $bytes = New-Object byte[] $c.CredentialBlobSize
  [System.Runtime.InteropServices.Marshal]::Copy($c.CredentialBlob, $bytes, 0, $c.CredentialBlobSize)
  # Windows 凭据的 blob 一般是 UTF-16LE
  $utf16 = [System.Text.Encoding]::Unicode.GetString($bytes)
  $token = if ($utf16 -match '^[\x20-\x7E]+$') { $utf16 } else { [System.Text.Encoding]::UTF8.GetString($bytes).Trim([char]0) }
} finally {
  [CredRead2]::CredFree($ptr)
}

if (-not $token) { throw '凭据内容为空' }
Write-Host "已从凭据管理器读取 token（长度 $($token.Length)，不显示内容）"

$env:GH_PUBLISH_TOKEN = $token
try {
  & node (Join-Path $PSScriptRoot 'publish-github.js') $Repo
} finally {
  Remove-Item Env:\GH_PUBLISH_TOKEN -ErrorAction SilentlyContinue
}
