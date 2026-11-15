# Requires: HF access approved for facebook/sam3 + a token
# Usage:
#   $env:HF_TOKEN = "hf_xxx"
#   powershell -ExecutionPolicy Bypass -File .\scripts\download-sam3-weights.ps1

$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $ProjectRoot 'handoff.config.ps1')
$Py = $ProjectPython
$DestDir = $Sam3Root

if (-not $env:HF_TOKEN -and -not $env:HUGGING_FACE_HUB_TOKEN) {
  Write-Host "请先设置环境变量 HF_TOKEN（Hugging Face Access Token）。" -ForegroundColor Yellow
  Write-Host "1) 打开并申请权限: https://huggingface.co/facebook/sam3"
  Write-Host "2) 创建 Token: https://huggingface.co/settings/tokens"
  Write-Host "3) `$env:HF_TOKEN='hf_xxx'; 再运行本脚本"
  exit 2
}

$env:HF_ENDPOINT = if ($env:HF_ENDPOINT) { $env:HF_ENDPOINT } else { 'https://hf-mirror.com' }
Write-Host "Using HF endpoint: $($env:HF_ENDPOINT)" -ForegroundColor Cyan

& $Py -c @"
from huggingface_hub import hf_hub_download
import hashlib, os
path = hf_hub_download(
    repo_id='facebook/sam3',
    filename='sam3.pt',
    local_dir=r'$DestDir',
    local_dir_use_symlinks=False,
)
print('downloaded', path)
print('size_mb', round(os.path.getsize(path)/1024/1024, 2))
h = hashlib.sha256()
with open(path, 'rb') as f:
    for chunk in iter(lambda: f.read(1024*1024), b''):
        h.update(chunk)
print('sha256', h.hexdigest())
"@
