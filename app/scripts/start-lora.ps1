# 启动侗族纹样 LoRA 生成服务（端口 8001）
$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$AigcRoot = Split-Path -Parent $ProjectRoot
$LoraScripts = Join-Path $AigcRoot 'lora-scripts-main'
$Python = Join-Path $LoraScripts 'venv\Scripts\python.exe'
$Service = Join-Path $ProjectRoot 'lora_service.py'
$Weights = Join-Path $LoraScripts 'output\dongzu_embroidery_v2.safetensors'
$Base = Join-Path $LoraScripts 'sd-models\v1-5-pruned-emaonly.safetensors'

if (-not (Test-Path -LiteralPath $Python)) { throw "未找到 LoRA Python：$Python" }
if (-not (Test-Path -LiteralPath $Service)) { throw "未找到服务脚本：$Service" }
if (-not (Test-Path -LiteralPath $Weights)) { throw "未找到 LoRA 权重：$Weights" }
if (-not (Test-Path -LiteralPath $Base)) { throw "未找到底模：$Base" }

$env:LORA_SCRIPTS_ROOT = $LoraScripts
$env:LORA_BASE_MODEL = $Base
$env:LORA_WEIGHTS = $Weights
$env:LORA_SERVICE_HOST = '127.0.0.1'
$env:LORA_SERVICE_PORT = '8001'
$env:HF_HOME = Join-Path $LoraScripts 'huggingface'
$env:XFORMERS_FORCE_DISABLE_TRITON = '1'
$env:PROTOCOL_BUFFERS_PYTHON_IMPLEMENTATION = 'python'

Write-Host '正在启动 LoRA 生成服务 http://127.0.0.1:8001 ...' -ForegroundColor Cyan
Write-Host '首次加载模型较慢，请等待控制台出现 listening。' -ForegroundColor Yellow
& $Python -B $Service