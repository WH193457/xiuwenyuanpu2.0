[CmdletBinding()]
param([string]$Destination)

$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($Destination)) { $Destination = Join-Path (Split-Path -Parent $ProjectRoot) '交接压缩包' }
New-Item -ItemType Directory -Path $Destination -Force | Out-Null

Write-Host '压缩包会额外占用磁盘空间，仅在确定需要上传时运行本脚本。' -ForegroundColor Yellow
$core = Join-Path $Destination '01_项目代码与交接文档.zip'
$data = Join-Path $Destination '02_侗族纹样数据库.zip'
$research = Join-Path $Destination '03_研究材料.zip'
foreach ($path in @($core,$data,$research)) { if (Test-Path $path) { throw "目标已存在，为避免覆盖已停止：$path" } }

$coreItems = Get-ChildItem -LiteralPath $ProjectRoot -Force | Where-Object { $_.Name -notin @('.git','纹样库','研究材料','website') -and $_.Extension -ne '.zip' }
Compress-Archive -LiteralPath $coreItems.FullName -DestinationPath $core -CompressionLevel Optimal

$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('xiuwen-pack-' + [guid]::NewGuid().ToString('N'))
try {
    New-Item -ItemType Directory -Path (Join-Path $tempRoot 'website') | Out-Null
    Get-ChildItem -LiteralPath (Join-Path $ProjectRoot 'website') -Force | Where-Object { $_.Name -notin @('node_modules','dist','public','test-results','playwright-report') } | Copy-Item -Destination (Join-Path $tempRoot 'website') -Recurse
    Compress-Archive -LiteralPath (Join-Path $tempRoot 'website') -DestinationPath $core -Update -CompressionLevel Optimal
} finally {
    if (Test-Path $tempRoot) { Remove-Item -LiteralPath $tempRoot -Recurse -Force }
}

Compress-Archive -LiteralPath (Join-Path $ProjectRoot '纹样库') -DestinationPath $data -CompressionLevel Optimal
Compress-Archive -LiteralPath (Join-Path $ProjectRoot '研究材料') -DestinationPath $research -CompressionLevel Optimal
Write-Host "已生成三份压缩包：$Destination" -ForegroundColor Green
