# Bilibili Offline Cache Extractor & Cataloger

这是一个用于从已连接的安卓手机中读取、提取、解码并合成哔哩哔哩（Bilibili）离线缓存视频的工具集（适用于 macOS 系统）。

## 工具组成

1. **`extractor.py`**：视频提取与合并脚本。支持从手机自动拉取音频轨和视频轨，剥离 B 站特有的 9 字节加密文件头，并使用 FFmpeg 无损合并为标准的 `.mp4` 格式。内置安全磁盘空间检查，防止填满电脑磁盘。
2. **`backup_metadata.py`**：元数据备份与目录手册生成脚本。能够将所有离线缓存的视频信息（作者、分辨率、原网页链接、时长等）备份到本地，并自动生成一个精美的网页/Markdown 格式视频索引手册。

---

## 环境依赖

在运行脚本前，请确保您的 Mac 上已安装以下工具：

1. **Python 3**
2. **ADB (Android Debug Bridge)**：
   ```bash
   brew install --cask android-platform-tools
   ```
3. **FFmpeg**：
   ```bash
   brew install ffmpeg
   ```

---

## 手机端准备工作

1. **开启开发者模式**：打开手机的 **设置 -> 关于手机**，连续快速点击 **版本号** 7 次，输入锁屏密码后提示“已处于开发者模式”。
2. **启用 USB 调试**：进入 **设置 -> 系统和更新 -> 开发人员选项**，开启 **USB 调试** 和 **仅充电模式下允许 ADB 调试**。
3. **MTP 传输模式**：将手机用数据线连上 Mac，并将 USB 连接模式切换为 **“传输文件” (MTP)**。
4. **电脑授权**：手机上弹出 **“是否允许 USB 调试？”**，勾选“始终允许这台计算机调试”并点击确定。

---

## 使用说明

请在包含脚本的终端路径下运行以下命令：

### 1. 视频提取工具 (`extractor.py`)

* **首次扫描手机并列出前 10 个视频**：
  ```bash
  python3 extractor.py
  ```
  *(首次运行会自动在本地生成 `videos_list.json` 元数据索引缓存)*

* **列出手机里所有的缓存视频与提取状态**：
  ```bash
  python3 extractor.py --list
  ```
  *(会显示 `[已提取]` 或 `[未提取]` 状态)*

* **安全批量提取（自动检测磁盘空间，预留至少 5GB 空闲空间）**：
  ```bash
  python3 extractor.py --extract-safe
  ```
  *(推荐使用！当磁盘空间不足时会自动安全停机，保护系统不卡死)*

* **根据视频序号（Index）单独提取某一个视频**：
  ```bash
  python3 extractor.py --index 152
  ```

* **根据关键词检索视频**：
  ```bash
  python3 extractor.py --search "关键词"
  ```

* **强制重新扫描手机缓存**（如果手机里下载了新视频）：
  ```bash
  python3 extractor.py --scan --list
  ```

### 2. 信息备份工具 (`backup_metadata.py`)

运行此脚本将拉取全部视频的详细属性并生成索引手册：
```bash
python3 backup_metadata.py
```
运行完成后，会生成：
* **`metadata/` 文件夹**：存放了 200 个缓存的原始 JSON 文件。
* **`video_catalog.md`**：自动生成的排版精美的 Markdown 视频列表，包含 UP主姓名、分辨率、时长，以及**可以直接点击跳转到 B 站原网页**的跳转链接。
* **`metadata_summary.json`**：所有视频属性的完整结构化 JSON 汇总。

---

## 技术原理解析

Bilibili 安卓离线缓存采用的是音视频分离（Dash）格式，主要有以下两个技术障碍，本工具已自动处理：
1. **画面与声音分离**：视频流存储在 `video.m4s` 中（无声音），音频流存储在 `audio.m4s` 中（无画面）。本工具使用 `ffmpeg -codec copy` 进行无损极速合并。
2. **9 字节文件头加密**：B 站对部分 `.m4s` 头部写入了 9 字节的干扰垃圾字符，使常规播放器报错损坏。本工具在复制时会自动检测 `ftyp` 偏移，**切除干扰的前 9 字节**，将其还原为标准的 MP4 音视频流。
