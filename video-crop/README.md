# video-crop 视频裁剪工具集

批量去掉视频上下黑边的工具集：真裁剪（重编码，兼容所有播放器）、无损元数据裁剪（不重编码，兼容性有限）、文件名 emoji 清理。

## 文件清单

| 脚本 | 用途 |
|---|---|
| `batch_crop.py` | 批量真裁剪（保持原编码 h264，按源码率重编码，音频复制） |
| `batch_crop_hevc.py` | 批量真裁剪 HEVC 视频（libx265 按源码率重编码） |
| `mkv_crop.py` | 无损注入 MKV `PixelCrop` 裁剪元数据（不重编码） |
| `mp4_clap.py` | 无损注入 MP4 `clap`（clean aperture）裁剪元数据（不重编码） |
| `rename_no_emoji.py` | 删除文件名中的 emoji 图标字符（便于网盘上传） |

## batch_crop.py / batch_crop_hevc.py

按每集单独检测上下黑边，输出 `原文件名_裁黑边.mp4`。

```bash
# 用法
python3 batch_crop.py [目录] < 文件列表.txt     # 从 stdin 读文件名，每行一个
python3 batch_crop_hevc.py [目录]              # 自动扫描目录下 *_NxM.mp4 后缀文件

# 示例
ls /Users/bjergsen/Downloads/*.mp4 | grep -v 裁黑边 > list.txt
python3 batch_crop.py /Users/bjergsen/Downloads < list.txt
python3 batch_crop_hevc.py /Users/bjergsen/Downloads
```

参数与行为：

- **黑边检测**：解码器直出灰度（`fps=6` 子采样后 `rawvideo gray`），逐行求均值，行均值 ≥30 且连续 5 行为内容边界；取**全片最小值**作为裁剪边（保证不切到任何一帧的内容）。
  - 注意：不要用 `scale=1:W` 管道检测，本机 ffmpeg 的 scale 存在有限/全范围转换，会把暗字幕误判为黑边。
- **裁剪**：`crop=W:H:0:y`，y 向下取偶（yuv420p 要求 x/y/w/h 全偶），底部余数做一像素舍入。
- **编码**：保持源编码（`batch_crop.py` 用 libx264，`batch_crop_hevc.py` 用 libx265），目标码率=源视频码率（`-maxrate 1.2x -bufsize 2x`），`preset medium`，`yuv420p`，音频 `-c:a copy`，`+faststart`。
- **体积**：与源基本一致（约 91%~102%），画质不会比源差（源是瓶颈）。
- **无黑边**（上下边 <8px）自动跳过。

已知限制：多段拼接视频（各段落黑边宽度不同，如部分抖音合拍视频）无法用单一裁剪同时满足"去干净黑边"和"不切内容"，脚本按最保守（不切内容）处理，部分段落会残留黑边，需人工分段处理。

## 无损（不重编码）裁剪

原理：在编码流/容器中写入"只显示中间区域"的元数据，黑边像素仍在文件里（体积不变），但播放器按元数据裁剪显示。**兼容性取决于播放器**，实测：

| 元数据 | 支持的播放器 | 不支持的播放器 |
|---|---|---|
| h264 SPS `frame_cropping` | Windows 播放器、VLC、mpv、手机播放器 | PotPlayer（只显示上半部分）、哔哩哔哩、Mac 预览 |
| MP4 `clap` | QuickTime / Mac | 多数其他播放器 |
| MKV `PixelCrop` | mpv、VLC、Kodi | 部分播放器忽略 |

故：追求全兼容请用真裁剪（batch_crop.py）；只给特定播放器用可走无损。

```bash
# 方式一：直接改 SPS 元数据（h264 / hevc 均支持），ffmpeg 自带，无需脚本
ffmpeg -i in.mp4 -c:v copy -bsf:v h264_metadata=crop_top=420:crop_bottom=420 -c:a copy out.mp4
ffmpeg -i in.mp4 -c:v copy -bsf:v hevc_metadata=crop_top=840:crop_bottom=840 -c:a copy out.mp4
# 注意：4:2:0 下裁剪值必须为偶数；容器尺寸与实际解码帧一致时最稳

# 方式二：MKV PixelCrop（容器级，适合 MKV）
python3 mkv_crop.py in.mkv out.mkv 420 420          # 上 420 下 420
python3 mkv_crop.py in.mkv out.mkv 420 420 0 0      # 上 下 左 右

# 方式三：MP4 clap（QuickTime 原生支持）
python3 mp4_clap.py in.mp4 out.mp4 1080 1080        # 显示区域 1080x1080（居中）
python3 mp4_clap.py in.mp4 out.mp4 1920 1080 0 0    # 1920x1080
```

`mkv_crop.py` 说明：解析 EBML，向视频轨 `Video` 元素写入 `PixelCropTop(0x54BB)` / `PixelCropBottom(0x54AA)`，并重建所有上级长度字段，不改动任何媒体数据。

`mp4_clap.py` 说明：向视频 `trak` 写入 `clap` 原子（8 个 int32：宽 N/D、高 N/D、水平偏移 N/D、垂直偏移 N/D），并同步修正 `moov`/`trak` 尺寸与所有 `stco`/`co64` 块偏移（moov 在 mdat 之前时必需）。

## rename_no_emoji.py

删除文件名中的 emoji（含变体选择符、ZWJ、旗帜区域符），合并多余空格，用于网盘上传（部分网盘客户端对 emoji 文件名支持差）。

```bash
python3 rename_no_emoji.py /Users/bjergsen/Downloads "*_2160x3840.mp4"
python3 rename_no_emoji.py /Users/bjergsen/Downloads "*_裁黑边*.mp4"
```

同名冲突自动跳过，不改动目录名。
