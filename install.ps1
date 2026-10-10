# dsh-snapshot-manager 安装脚本
#
#   -DevFromWorkspace （开发模式）：不复制文件，profile 补丁入口指向工作区里的
#        lib/bootstrap.js；bootstrap 按内容哈希动态 import host.js，改完即生效。
#   -Release          （发布模式）：把插件完整复制到 $DSH_HOME\plugins\dsh-snapshot-manager，
#        入口指向那份拷贝的 lib/host.js（自包含，不依赖工作区），并补上 dsh.client。
#
# 用法：
#   pwsh -File install.ps1 -DevFromWorkspace
#   pwsh -File install.ps1 -Release
#   pwsh -File install.ps1 -Release -SkipPatch   # 只复制文件

[CmdletBinding(DefaultParameterSetName = 'Dev')]
param(
    [Parameter(ParameterSetName = 'Dev')][switch]$DevFromWorkspace,
    [Parameter(ParameterSetName = 'Release')][switch]$Release,
    [switch]$SkipPatch,
    [string]$DevChannelDir = 'D:/javaProject/yf/.dsh-probe/plugin-dev'
)

$ErrorActionPreference = 'Stop'

$Source     = $PSScriptRoot
$DshHome    = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$PluginDest = Join-Path $DshHome 'plugins\dsh-snapshot-manager'
$ProfileDir = Join-Path $DshHome 'profiles\desktop'
$PatchFile  = Join-Path $ProfileDir 'cordis.patch.yml'

$Begin = '# >>> dsh-snapshot-manager (managed by install.ps1) >>>'
$End   = '# <<< dsh-snapshot-manager <<<'

if ($Release) {
    Write-Host '模式：发布（自包含安装到 DSH home）'
    # 若此前用目录联接做开发调试，先摘掉联接（只删链接，不删目标）。
    if (Test-Path $PluginDest) {
        $item = Get-Item $PluginDest -Force
        if ($item.LinkType -ne $null -and $item.LinkType -ne '') { Remove-Item $PluginDest -Force }
        else { Remove-Item $PluginDest -Recurse -Force }
    }
    New-Item -ItemType Directory -Force -Path $PluginDest | Out-Null
    Copy-Item -Path (Join-Path $Source 'lib') -Destination $PluginDest -Recurse -Force
    if (Test-Path (Join-Path $Source 'README.md')) {
        Copy-Item -Path (Join-Path $Source 'README.md') -Destination (Join-Path $PluginDest 'README.md') -Force
    }

    # 关键：Host 半边用「内容哈希」命名的文件名。
    # 运行中的进程会按 URL 缓存 ES 模块，入口路径不变时改内容不会生效（要重启应用）；
    # 换一个文件名就换了一个 URL，新代码会立刻被加载，无需重启。
    $hash = (Get-FileHash -Path (Join-Path $PluginDest 'lib\host.js') -Algorithm SHA256).Hash.Substring(0, 12).ToLower()
    $hostFile = "host.$hash.js"
    Move-Item (Join-Path $PluginDest 'lib\host.js') (Join-Path $PluginDest "lib\$hostFile") -Force
    # 清掉旧版本的 host.*.js，只保留当前这一份
    Get-ChildItem (Join-Path $PluginDest 'lib') -Filter 'host.*.js' |
        Where-Object { $_.Name -ne $hostFile } |
        ForEach-Object { Remove-Item $_.FullName -Force }
    # 开发期外壳与启动标记不进发布副本
    Remove-Item (Join-Path $PluginDest 'lib\bootstrap.js') -Force -ErrorAction SilentlyContinue
    Remove-Item (Join-Path $PluginDest 'lib\boot.json') -Force -ErrorAction SilentlyContinue
    Remove-Item (Join-Path $PluginDest 'lib\host.js') -Force -ErrorAction SilentlyContinue

    # 组装发布用 package.json：入口指向版本化文件，并声明 dsh.client。
    $pkg = Get-Content (Join-Path $Source 'package.json') -Raw | ConvertFrom-Json
    $pkg.main = "lib/$hostFile"
    $pkg.exports = [pscustomobject]@{
        '.'              = "./lib/$hostFile"
        './client'       = './lib/client.js'
        './package.json' = './package.json'
    }
    $pkg | Add-Member -NotePropertyName dsh -NotePropertyValue ([pscustomobject]@{
        client = [pscustomobject]@{ platform = 'web'; inject = @() }
    }) -Force
    Set-Content -Path (Join-Path $PluginDest 'package.json') -Value ($pkg | ConvertTo-Json -Depth 8) -Encoding utf8

    $Entry  = (Join-Path $PluginDest "lib\$hostFile") -replace '\\', '/'
    Write-Host "Host 文件名 : $hostFile（按内容哈希，改内容即换 URL，无需重启）"
    # 发布副本不带开发通道。
    $DevChannelDir = ''
} else {
    Write-Host '模式：开发（入口指向工作区，改完即生效）'
    $Entry  = (Join-Path $Source 'lib\bootstrap.js') -replace '\\', '/'
}

Write-Host "入口路径    : $Entry"
Write-Host "profile 补丁: $PatchFile"
Write-Host ''

if ($SkipPatch) { Write-Host '按要求跳过补丁更新。'; exit 0 }
if (-not (Test-Path $PatchFile)) { throw "找不到 profile 补丁文件：$PatchFile" }
if (-not (Test-Path "$PatchFile.bak-snapshot-manager")) {
    Copy-Item $PatchFile "$PatchFile.bak-snapshot-manager" -Force
    Write-Host "已备份原始补丁 -> $PatchFile.bak-snapshot-manager"
}

# 清掉本脚本历史上写入过的所有受管块（含早期带 " hmr" 后缀的那一段）。
$kept = New-Object System.Collections.Generic.List[string]
$inside = $false
foreach ($line in (Get-Content -Path $PatchFile)) {
    $t = $line.Trim()
    if ($t -like "$Begin*") { $inside = $true; continue }
    if ($t -like "$End*")   { $inside = $false; continue }
    if ($inside) { continue }
    if ($t -match '^- insert: \[\{ id: snapshot-manager') { continue }
    if ($t -match '^# dsh-snapshot-manager：') { continue }
    $kept.Add($line)
}
while ($kept.Count -gt 0 -and $kept[$kept.Count - 1].Trim() -eq '') { $kept.RemoveAt($kept.Count - 1) }

$entryLines = New-Object System.Collections.Generic.List[string]
$entryLines.Add('- insert:')
$entryLines.Add('    - id: snapshot-manager')
$entryLines.Add("      name: '$Entry'")
if ($DevChannelDir -ne '') {
    # 只有开发模式才写入开发通道目录；发布副本保持纯净。
    $entryLines.Add('      config:')
    $entryLines.Add("        devChannelDir: '$DevChannelDir'")
}

$block = New-Object System.Collections.Generic.List[string]
$block.Add('')
$block.Add($Begin)
foreach ($line in $entryLines) { $block.Add($line) }
$block.Add($End)
Set-Content -Path $PatchFile -Value ((($kept + $block) -join "`n") + "`n") -NoNewline -Encoding utf8

Write-Host '补丁已更新。'
Write-Host ''
Write-Host '--- 补丁文件末尾 ---'
Get-Content $PatchFile -Tail 10 | ForEach-Object { "  $_" }
