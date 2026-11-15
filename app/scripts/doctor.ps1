[CmdletBinding()]
param()

$ErrorActionPreference = 'SilentlyContinue'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$ConfigPath = Join-Path $ProjectRoot 'handoff.config.ps1'
$ProjectPython = 'python.exe'
$Sam3Root = ''
$Sam3Checkpoint = ''
if (Test-Path -LiteralPath $ConfigPath) { . $ConfigPath }

$failures = 0
function Show-Ok([string]$Text) { Write-Host "[通过] $Text" -ForegroundColor Green }
function Show-Warn([string]$Text) { Write-Host "[可选] $Text" -ForegroundColor Yellow }
function Show-Fail([string]$Text) { $script:failures += 1; Write-Host "[失败] $Text" -ForegroundColor Red }

Write-Host "绣纹元谱 · 接收环境检查`n" -ForegroundColor Cyan

if ($IsWindows -or $env:OS -eq 'Windows_NT') { Show-Ok 'Windows 环境' } else { Show-Fail '本交接版按 Windows 验证' }

$node = Get-Command node.exe
if ($node) {
    $version = (& node.exe --version) -replace '^v',''
    $major = [int]($version.Split('.')[0])
    $minor = [int]($version.Split('.')[1])
    if ($major -gt 22 -or ($major -eq 22 -and $minor -ge 12)) { Show-Ok "Node.js $version" } else { Show-Fail "Node.js $version；需要 22.12 或更高版本" }
} else { Show-Fail '未找到 Node.js' }

if (Get-Command npm.cmd) { Show-Ok 'npm.cmd 可用' } else { Show-Fail '未找到 npm.cmd' }

$DataRoot = Join-Path $ProjectRoot '纹样库\侗族\_标注成果'
$PatternJson = Join-Path $DataRoot '03_标注数据\patterns.json'
$ElementJson = Join-Path $DataRoot '03_标注数据\elements.json'
if ((Test-Path $PatternJson) -and (Test-Path $ElementJson)) {
    $patterns = Get-Content -Raw -Encoding UTF8 -LiteralPath $PatternJson | ConvertFrom-Json
    $elements = Get-Content -Raw -Encoding UTF8 -LiteralPath $ElementJson | ConvertFrom-Json
    if ($patterns.Count -eq 80 -and $elements.Count -eq 15) { Show-Ok '侗族数据基线：80件纹样、15个纹样元' } else { Show-Fail "数据数量异常：$($patterns.Count)件纹样、$($elements.Count)个纹样元" }
} else { Show-Fail '缺少侗族 JSON 标注数据' }

$pythonCommand = Get-Command $ProjectPython
if ($pythonCommand) { Show-Ok "Python：$ProjectPython" } else { Show-Warn "未找到配置的 Python：$ProjectPython；不影响前端运行" }

if (Get-Command nvidia-smi.exe) { Show-Ok '检测到 NVIDIA 驱动工具' } else { Show-Warn '未检测到 nvidia-smi；SAM3 需要 NVIDIA CUDA GPU' }

$samConfigured = -not [string]::IsNullOrWhiteSpace($Sam3Root) -and -not [string]::IsNullOrWhiteSpace($Sam3Checkpoint)
if ($samConfigured) {
    if ((Test-Path (Join-Path $Sam3Root 'sam3')) -and (Test-Path $Sam3Checkpoint)) { Show-Ok 'SAM3 源码与权重路径有效' } else { Show-Warn '已填写 SAM3 路径，但源码或权重不存在' }
} else { Show-Warn 'SAM3 尚未配置；网站与数据库功能仍可运行' }

if ($failures -gt 0) { Write-Host "`n核心检查失败 $failures 项。" -ForegroundColor Red; exit 1 }
Write-Host "`n核心环境检查通过。" -ForegroundColor Green
exit 0
