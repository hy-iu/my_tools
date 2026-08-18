# GPU 环境与运行记录

本文件是 `douyin-video-rename` 在此 Windows 主机上的可复现环境说明和
实际运行记录。每次调整 CUDA、TorchCodec、FFmpeg 或并发参数后都要更新本文件。

## 范围与规则

- 当前验证目录为 `F:\Downloads`，仅生成 JSON 匹配报告，不会重命名或删除视频。
- GPU 解码器是 CUDA/NVDEC-only：CUDA 或 NVDEC 不可用时直接报错，绝不回退 CPU。
- FFmpeg 只使用独立安装的 Gyan shared build，不能使用任何第三方软件附带版本。
- 当前只验证 `神待福瑞*` 视频与下载时间窗口中的有意义标题候选视频；不会扫描其他目录。

## 主机环境（2026-08-18）

| 项目 | 实测值 |
| --- | --- |
| 操作系统环境 | Windows 主机 Python；本阶段没有使用 WSL |
| GPU | NVIDIA GeForce RTX 5060 Ti，16,311 MiB |
| NVIDIA 驱动 | 610.47（驱动报告 CUDA 13.3） |
| GPU 匹配环境 | `.venv-torchcodec\\Scripts\\python.exe` |
| Python | 3.12 |
| PyTorch | `2.13.0+cu130`（运行时 CUDA 13.0） |
| TorchCodec | `0.16.0+cu130` |
| NumPy | `2.5.2` |
| 独立 FFmpeg | Gyan FFmpeg `9.0.1` shared build（winget） |

系统 `PATH` 的第一个 `ffmpeg.exe` 是 LAMMPS 附带版本，不能直接使用。
`match_videos_torchcodec.py` 导入 TorchCodec 前会通过 `common.media_tool()` 找到
`C:\Users\hy-wu.DESKTOP-G355NC5\AppData\Local\Microsoft\WinGet\Packages\Gyan.FFmpeg.Shared_Microsoft.Winget.Source_8wekyb3d8bbwe\ffmpeg-9.0.1-full_build-shared\bin`
并将其置于本进程 `PATH` 最前，同时调用 `os.add_dll_directory()`，因此不会加载
LAMMPS 的 DLL。

## 安装与检查

```powershell
winget install --id Gyan.FFmpeg.Shared --exact --source winget
py -3.12 -m venv .venv-torchcodec
.\.venv-torchcodec\Scripts\python.exe -m pip install numpy==2.5.2
.\.venv-torchcodec\Scripts\python.exe -c "import torch, torchcodec; print(torch.__version__, torch.version.cuda, torchcodec.__version__)"
nvidia-smi --query-gpu=name,driver_version,memory.total --format=csv,noheader
```

The PyTorch and TorchCodec CUDA wheels must be installed as a compatible pair;
the current pair is listed above. Do not add `torchvision` to this environment:
the NVDEC matcher does not depend on it.

The current environment's direct CUDA dependencies are:

```text
numpy==2.5.2
torch==2.13.0+cu130
torchcodec==0.16.0+cu130
```

## Benchmark log

Tests use the largest `神待福瑞*` files in `F:\Downloads`, decode eight uniformly
spaced frames per video, and calculate dHash on CUDA. `torch_peak_mib` is only
PyTorch allocator memory; it does not include TorchCodec/NVDEC native allocations.
The production matcher now records driver-level peaks through `nvidia-smi` in every
result JSON.

| Test | Parallel NVDEC tasks | Result | Throughput |
| --- | ---: | --- | ---: |
| 1 x 2160x3840 HEVC, 8 frames | 1 | 1.831 s, 950 MiB PyTorch peak | 0.55 video/s |
| 8 videos | 8 | 0 failures, driver peak 4,183 MiB | 3.713 video/s |
| 12 videos | 12 | 0 failures | 4.361 video/s |
| 14 videos | 14 | 0 failures | 5.908 video/s |
| 16 videos | 16 | 0 failures | 6.114 video/s |
| Full 172-video window | 16 | 0 failures; 8,187 MiB driver peak | 8.29 video/s |
| Full 172-video window | 24 | 0 failures; 9,015 MiB driver peak | 10.78 video/s |
| Full 172-video window | 32 | 0 failures; 9,719 MiB driver peak | 11.02 video/s |
| Full 172-video window | 48 | 0 failures; 11,995 MiB driver peak | 10.94 video/s |

32 workers is the current validated performance default. It intentionally drives multiple
full-resolution decode surfaces concurrently, but it does not attempt to reserve
all 16 GB of VRAM: full occupancy can reduce throughput or disrupt the desktop
without increasing NVDEC throughput. 48 workers is a reproducible VRAM pressure
profile, but it was slower than 32 workers. Use the recorded driver peak and
videos/s to justify any further increase, not memory percentage alone.

## Current command

```powershell
Set-Location C:\Users\hy-wu.DESKTOP-G355NC5\Projects\my_tools\douyin-video-rename
..\.venv-torchcodec\Scripts\python.exe .\match_videos_torchcodec.py `
  F:\Downloads F:\Downloads\douyin-torchcodec-matches-window10-2026-08-18.json `
  --time-window-minutes 10 --workers 32 --nvdec-cache 128
```

The 32-worker report matched the CPU report exactly: 9 candidate pairs, with no
TorchCodec-only or CPU-only pair. The 48-worker pressure report also matched all
9 pairs. Reports created during this run are
`F:\Downloads\douyin-torchcodec-matches-window10-2026-08-18.json`,
`F:\Downloads\douyin-torchcodec-matches-window10-workers32-2026-08-18.json`, and
`F:\Downloads\douyin-torchcodec-matches-window10-workers48-2026-08-18.json`.

No files or logs were deleted while preparing this environment.
