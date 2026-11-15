[CmdletBinding()]
param([switch]$NoOpen)

$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$ConfigPath = Join-Path $ProjectRoot 'handoff.config.ps1'
if (-not (Test-Path -LiteralPath $ConfigPath)) {
    & (Join-Path $PSScriptRoot 'setup.ps1')
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
. $ConfigPath

$WebsiteRoot = Join-Path $ProjectRoot 'website'
if (-not (Test-Path (Join-Path $WebsiteRoot 'node_modules\.bin\vite.cmd'))) {
    & (Join-Path $PSScriptRoot 'setup.ps1')
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

$env:XIUVEN_DATA_ROOT = Join-Path $ProjectRoot '纹样库\侗族\_标注成果'
$env:SAM3_ROOT = $Sam3Root
$env:SAM3_CHECKPOINT = $Sam3Checkpoint
$env:SAM3_SERVICE_HOST = $Sam3ServiceHost
$env:SAM3_SERVICE_PORT = [string]$Sam3ServicePort
$env:VITE_API_BASE_URL = $ApiBaseUrl
$env:VITE_LORA_API_BASE_URL = $LoraApiBaseUrl
$env:VITE_ENABLE_LORA = 'true'

$samProcess = $null
$loraProcess = $null
$samReady = -not [string]::IsNullOrWhiteSpace($Sam3Root) -and -not [string]::IsNullOrWhiteSpace($Sam3Checkpoint) -and (Test-Path (Join-Path $Sam3Root 'sam3')) -and (Test-Path $Sam3Checkpoint) -and (Test-Path $ProjectPython)
if ($samReady) {
    $OutputRoot = Join-Path $ProjectRoot 'outputs'
    New-Item -ItemType Directory -Path $OutputRoot -Force | Out-Null
    $samProcess = Start-Process -FilePath $ProjectPython -ArgumentList '-B',(Join-Path $ProjectRoot 'sam3_service.py') -WorkingDirectory $ProjectRoot -WindowStyle Hidden -PassThru
    Write-Host "SAM3 服务正在启动：http://${Sam3ServiceHost}:$Sam3ServicePort" -ForegroundColor Cyan
} else {
    Write-Host 'SAM3 未配置，本次以前端与数据库模式启动。' -ForegroundColor Yellow
}

$loraReady = (Test-Path $LoraPython) -and (Test-Path $LoraWeights) -and (Test-Path $LoraBaseModel)
if ($loraReady) {
    $env:LORA_SCRIPTS_ROOT = $LoraScriptsRoot
    $env:LORA_BASE_MODEL = $LoraBaseModel
    $env:LORA_WEIGHTS = $LoraWeights
    $env:LORA_SERVICE_HOST = $LoraServiceHost
    $env:LORA_SERVICE_PORT = [string]$LoraServicePort
    $env:HF_HOME = Join-Path $LoraScriptsRoot 'huggingface'
    $env:XFORMERS_FORCE_DISABLE_TRITON = '1'
    $env:PROTOCOL_BUFFERS_PYTHON_IMPLEMENTATION = 'python'
    $loraProcess = Start-Process -FilePath $LoraPython -ArgumentList '-B',(Join-Path $ProjectRoot 'lora_service.py') -WorkingDirectory $ProjectRoot -WindowStyle Hidden -PassThru
    Write-Host "LoRA 生成服务正在启动：http://${LoraServiceHost}:$LoraServicePort" -ForegroundColor Cyan
} else {
    Write-Host 'LoRA 未就绪（缺权重/底模/venv），创生页将无法真生成。' -ForegroundColor Yellow
}

Push-Location $WebsiteRoot
try {
    Write-Host "网站地址：http://${WebHost}:$WebPort" -ForegroundColor Green
    $openText = if ($NoOpen) { '' } else { ' --open' }
    & cmd.exe /d /c "npm.cmd run dev -- --host $WebHost --port $WebPort$openText"
} finally {
    Pop-Location
    if ($samProcess -and -not $samProcess.HasExited) { Stop-Process -Id $samProcess.Id -Force -ErrorAction SilentlyContinue }
    if ($loraProcess -and -not $loraProcess.HasExited) { Stop-Process -Id $loraProcess.Id -Force -ErrorAction SilentlyContinue }
}
