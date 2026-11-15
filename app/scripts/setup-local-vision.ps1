# Install the local vision runtime separately from the LoRA environment.
$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$AigcRoot = Split-Path -Parent $ProjectRoot
$Python = Join-Path $AigcRoot 'lora-scripts-main\venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $Python)) { throw '未找到项目的LoRA Python环境。' }
$RuntimeRoot = Join-Path $ProjectRoot '.model-runtime\vision'
$env:XIUWEN_VISION_MODEL = Join-Path $ProjectRoot '.model-cache\Qwen2-VL-2B-Instruct'
$env:HF_HOME = Join-Path $ProjectRoot '.model-cache\hf'
$env:HF_HUB_OFFLINE = '0'
$env:HF_HUB_DISABLE_XET = '1'
$env:HF_HUB_DOWNLOAD_TIMEOUT = '60'
& $Python -m pip install --index-url https://pypi.org/simple --target $RuntimeRoot --no-deps --upgrade transformers==4.45.2 tokenizers==0.20.3
if ($LASTEXITCODE -ne 0) { throw '本地图像分析运行组件安装失败。' }
& $Python -X utf8 -c "import os; from huggingface_hub import snapshot_download; print(snapshot_download('Qwen/Qwen2-VL-2B-Instruct', revision='895c3a49bc3fa70a340399125c650a463535e71c', local_dir=os.environ['XIUWEN_VISION_MODEL'], allow_patterns=['*.json','*.txt','*.safetensors','README.md','LICENSE'], ignore_patterns=['model-00001-of-00002.safetensors'], max_workers=3))"
if ($LASTEXITCODE -ne 0) { throw '本地图像分析模型下载未完成，可重新运行本脚本续传。' }
& $Python -u -X utf8 (Join-Path $PSScriptRoot 'download-vision-weight.py')
if ($LASTEXITCODE -ne 0) { throw '本地图像分析模型权重下载或校验未完成，可重新运行本脚本续传。' }
Write-Host '本地图像分析模型已准备，可通过创生页面上传参考图并分析。'
