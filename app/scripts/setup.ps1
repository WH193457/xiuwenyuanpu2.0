[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$ConfigPath = Join-Path $ProjectRoot 'handoff.config.ps1'
if (-not (Test-Path -LiteralPath $ConfigPath)) {
    Copy-Item -LiteralPath (Join-Path $ProjectRoot 'handoff.config.ps1.example') -Destination $ConfigPath
    Write-Host '已生成 handoff.config.ps1；如需 SAM3，请按 SAM3_SETUP.md 填写路径。' -ForegroundColor Yellow
}

& (Join-Path $PSScriptRoot 'doctor.ps1')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$WebsiteRoot = Join-Path $ProjectRoot 'website'
$env:npm_config_cache = Join-Path $ProjectRoot '.cache\npm'
Push-Location $WebsiteRoot
try {
    Write-Host "`n[1/2] 使用 package-lock.json 安装网站依赖..." -ForegroundColor Cyan
    & cmd.exe /d /c "npm.cmd ci --no-audit --no-fund"
    if ($LASTEXITCODE -ne 0) { throw 'npm ci 执行失败。' }
    Write-Host "`n[2/2] 从侗族标注成果生成网站资源..." -ForegroundColor Cyan
    & cmd.exe /d /c "npm.cmd run sync:data"
    if ($LASTEXITCODE -ne 0) { throw '纹样资源同步失败。' }
} finally { Pop-Location }

Write-Host "`n初始化完成。双击“一键启动网站.cmd”或运行 scripts\start.ps1。" -ForegroundColor Green
