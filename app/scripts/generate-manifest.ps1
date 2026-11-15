[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$files = Get-ChildItem -LiteralPath $ProjectRoot -Recurse -File | Where-Object {
    $_.FullName -notmatch '\\.git\\|\\node_modules\\|\\dist\\|\\public\\|\\test-results\\|\\outputs\\' -and
    $_.Name -notin @('manifest.sha256','交付清单.csv','交接验收报告.txt') -and $_.Extension -ne '.zip'
} | Sort-Object FullName

$records = foreach ($file in $files) {
    $relative = $file.FullName.Substring($ProjectRoot.Length + 1).Replace('\','/')
    $hash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    [pscustomobject]@{ Path = $relative; SizeBytes = $file.Length; SHA256 = $hash }
}
$records | Export-Csv -LiteralPath (Join-Path $ProjectRoot '交付清单.csv') -NoTypeInformation -Encoding UTF8
$records | ForEach-Object { "$($_.SHA256)  $($_.Path)" } | Set-Content -LiteralPath (Join-Path $ProjectRoot 'manifest.sha256') -Encoding UTF8
Write-Host "已生成 $($records.Count) 个文件的交付清单与 SHA-256。" -ForegroundColor Green
