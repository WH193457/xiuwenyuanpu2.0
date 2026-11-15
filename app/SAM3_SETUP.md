# SAM3外置部署说明

## 为什么不在交接包内

SAM3源码和约3.29 GB权重不随本包分发。接收者需要自行接受模型许可、申请Hugging Face访问并下载与本项目匹配的资源。项目仅保留调用接口和环境参考。

## 环境基线

- Windows 10/11。
- NVIDIA GPU；当前实现没有CPU推理路径。
- Python 3.12。
- PyTorch 2.7.0与CUDA 12.6构建。
- 其余参考依赖见`requirements-sam3.txt`。

## 获取与安装

1. 访问SAM3官方源码：<https://github.com/facebookresearch/sam3>。
2. 访问权重页面并申请权限：<https://huggingface.co/facebook/sam3>。
3. 在独立目录克隆源码，不要放入Git交接仓库。
4. 创建独立Python虚拟环境，安装匹配显卡驱动的PyTorch，再安装SAM3及`requirements-sam3.txt`中的服务依赖。
5. 将下载的权重保存为`sam3.pt`。
6. 复制`handoff.config.ps1.example`为`handoff.config.ps1`，填写Python、源码和权重的绝对路径。
7. 运行`scripts/doctor.ps1`，再通过`一键启动网站.cmd`启动。

示例配置：

```powershell
$ProjectPython = "C:\path\to\python.exe"
$Sam3Root = "C:\path\to\sam3"
$Sam3Checkpoint = "C:\path\to\sam3\sam3.pt"
```

当前已验证权重的SHA-256为：

```text
9999e2341ceef5e136daa386eecb55cb414446a00ac2b55eb2dfd2f7c3cf8c9e
```

可使用以下命令校验：

```powershell
Get-FileHash -Algorithm SHA256 C:\path\to\sam3.pt
```

如果来源发布了新版权重，哈希可能不同，应记录具体源码版本与权重来源后再验证功能。使用或再分发SAM3材料时必须遵守其仓库中的`LICENSE`；研究发表应按许可要求确认致谢方式。
