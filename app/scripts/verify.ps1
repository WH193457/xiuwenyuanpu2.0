[CmdletBinding()]
param([switch]$SkipBuild)

$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$DataRoot = Join-Path $ProjectRoot '纹样库\侗族\_标注成果'
$PatternJson = Join-Path $DataRoot '03_标注数据\patterns.json'
$ElementJson = Join-Path $DataRoot '03_标注数据\elements.json'
$errors = [System.Collections.Generic.List[string]]::new()

$patterns = Get-Content -Raw -Encoding UTF8 -LiteralPath $PatternJson | ConvertFrom-Json
$elements = Get-Content -Raw -Encoding UTF8 -LiteralPath $ElementJson | ConvertFrom-Json
if ($patterns.Count -ne 80) { $errors.Add("应有80件纹样，实际为$($patterns.Count)") }
if ($elements.Count -ne 15) { $errors.Add("应有15个纹样元，实际为$($elements.Count)") }
if (($patterns.id | Sort-Object -Unique).Count -ne $patterns.Count) { $errors.Add('纹样ID存在重复') }
if (($elements.id | Sort-Object -Unique).Count -ne $elements.Count) { $errors.Add('纹样元ID存在重复') }

$patternIds = [System.Collections.Generic.HashSet[string]]::new([string[]]$patterns.id)
$elementIds = [System.Collections.Generic.HashSet[string]]::new([string[]]$elements.id)
foreach ($pattern in $patterns) {
    if (-not (Test-Path (Join-Path $DataRoot $pattern.image))) { $errors.Add("缺少纹样图片：$($pattern.id)") }
    foreach ($elementId in $pattern.element_ids) { if (-not $elementIds.Contains($elementId)) { $errors.Add("$($pattern.id)引用不存在的纹样元$elementId") } }
}
foreach ($element in $elements) {
    if (-not $patternIds.Contains($element.pattern_id)) { $errors.Add("$($element.id)引用不存在的母纹$($element.pattern_id)") }
    if (-not (Test-Path (Join-Path $DataRoot $element.image))) { $errors.Add("缺少纹样元图片：$($element.id)") }
}

$dongFiles = Get-ChildItem -LiteralPath (Join-Path $ProjectRoot '纹样库\侗族') -Recurse -File
if ($dongFiles.Count -ne 183) { $errors.Add("侗族交接数据应为183个文件，实际为$($dongFiles.Count)") }
$otherDataDirs = Get-ChildItem -LiteralPath (Join-Path $ProjectRoot '纹样库') -Directory | Where-Object Name -ne '侗族'
if ($otherDataDirs) { $errors.Add('纹样库中存在侗族以外的目录') }

$scanFiles = Get-ChildItem -LiteralPath $ProjectRoot -Recurse -File | Where-Object {
    $_.FullName -notmatch '\\研究材料\\|\\.git\\|\\node_modules\\|\\dist\\|\\public\\|manifest\.sha256$|交付清单\.csv$' -and $_.Extension -in @('.md','.ps1','.cmd','.py','.ts','.tsx','.js','.mjs','.json')
}
$forbidden = $scanFiles | Select-String -Pattern '[A-Za-z]:[\\/]+Users[\\/]+[^\\/\r\n]+','D:\\Anaconda','D:\\codex-project'
if ($forbidden) { $errors.Add('代码或交接文档仍含原电脑绝对路径') }

if (-not $SkipBuild) {
    Push-Location (Join-Path $ProjectRoot 'website')
    try {
        & cmd.exe /d /c "npm.cmd run build"
        if ($LASTEXITCODE -ne 0) { $errors.Add('网站生产构建失败') }
    } finally { Pop-Location }
}

if ($errors.Count) {
    Write-Host '交接验收失败：' -ForegroundColor Red
    $errors | ForEach-Object { Write-Host "- $_" -ForegroundColor Red }
    exit 1
}
Write-Host "交接验收通过：183个侗族文件、80件纹样、15个纹样元，引用和图片完整。" -ForegroundColor Green
exit 0
