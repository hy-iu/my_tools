#Requires -Version 5.1
<#
.SYNOPSIS
  列出 PATH 中被覆盖的同名可执行文件，自动忽略指向同一文件的软链/硬链重映射。

.DESCRIPTION
  扫描 PATH 各目录，按文件名分组找出重复；再按"真实路径 / 硬链接组"去重，
  指向同一文件的符号链接（含 WindowsApps 的 AppExeCLink 别名）与硬链接不会误报。

.PARAMETER All
  默认只报告 PATHEXT（.exe/.cmd/.bat...）中的可执行文件；
  指定 -All 时报告目录下所有文件（含 .dll 等库）。

.EXAMPLE
  .\Path-Shadows.ps1
  .\Path-Shadows.ps1 -All
#>
[CmdletBinding()]
param(
    [switch]$All
)

$ErrorActionPreference = 'SilentlyContinue'

# Windows 从 PATH 启动只认 PATHEXT 中的扩展名
$pathext = @($env:PATHEXT -split ';' | Where-Object { $_ } | ForEach-Object { $_.ToLowerInvariant() })
if (-not $pathext) { $pathext = '.com', '.exe', '.bat', '.cmd' }

$dirs = $env:PATH -split ';' | Where-Object { $_ }

# 1. 收集所有文件名 -> 路径列表
$entries = @{}
foreach ($d in $dirs) {
    if (-not (Test-Path -LiteralPath $d -PathType Container)) { continue }
    foreach ($f in [System.IO.Directory]::EnumerateFiles($d)) {
        $name = [System.IO.Path]::GetFileName($f)
        if (-not $All) {
            $ext = [System.IO.Path]::GetExtension($name).ToLowerInvariant()
            if ($ext -and $pathext -notcontains $ext) { continue }
        }
        if (-not $entries.ContainsKey($name)) { $entries[$name] = [System.Collections.Generic.List[string]]::new() }
        $entries[$name].Add($f)
    }
}

# 2. 逐个重名命令核对
$found = 0
foreach ($name in $entries.Keys) {
    $files = $entries[$name]
    if ($files.Count -lt 2) { continue }

    # 按真实路径 / 硬链接组去重（软链解析到同一目标、硬链接共享 inode，均视为同一文件）
    $seenReal  = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    $seenHlKey = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    $uniqFiles = [System.Collections.Generic.List[string]]::new()
    $uniqReals = [System.Collections.Generic.List[string]]::new()

    foreach ($f in $files) {
        $real = $f
        $hlKey = $null
        $item = Get-Item -LiteralPath $f
        if ($item) {
            # PS 5.1 中 Target 可能是集合而非数组，须强转后再取第一个；
            # 返回的路径可能是 8.3 短名（HY-WU~1），须规范成长路径才能比较
            $targets = @($item.Target) | Where-Object { $_ } | ForEach-Object {
                $gi = Get-Item -LiteralPath $_
                if ($gi) { $gi.FullName } else { $_ }
            }
            if ($item.LinkType -eq 'SymbolicLink' -and $targets) {
                # 符号链接 / AppExeCLink 别名：解析到真实目标
                $real = $targets[0]
            }
            elseif ($item.LinkType -eq 'HardLink' -and $targets) {
                # 硬链接：同组全部路径（含自身）排序后整组作键；Target 可能不含自身，须补上
                $group = @($targets) + @($item.FullName)
                $hlKey = ($group | ForEach-Object { $_.ToLowerInvariant() } | Sort-Object -Unique) -join '|'
                # 展示时用组内首条非自身路径，说明它们实为同一文件
                $other = $group | Where-Object { $_ -ine $item.FullName } | Select-Object -First 1
                if ($other) { $real = $other }
            }
        }

        if ($seenReal.Contains($real)) { continue }
        if ($hlKey -and $seenHlKey.Contains($hlKey)) { continue }

        [void]$seenReal.Add($real)
        if ($hlKey) { [void]$seenHlKey.Add($hlKey) }
        # 展示路径用 FullName，避免沿用 PATH 中的 8.3 短名（HY-WU~1）
        $uniqFiles.Add($(if ($item) { $item.FullName } else { $f }))
        $uniqReals.Add($real)
    }

    if ($uniqFiles.Count -lt 2) { continue }

    $found++
    Write-Output "=== $name ==="
    for ($i = 0; $i -lt $uniqFiles.Count; $i++) {
        Write-Output ("  {0} -> {1}" -f $uniqFiles[$i], $uniqReals[$i])
    }
    $effective = @(where.exe $name 2>$null)
    if ($effective) { Write-Output ("  * 生效: {0}" -f $effective[0]) }
    Write-Output ''
}

if ($found -eq 0) { Write-Output 'PATH 中没有发现被覆盖的命令。' }
