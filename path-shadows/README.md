# path-shadows

检测 PATH 中被覆盖（重复安装或同名）的命令：同一命令名出现在多个 PATH 目录时，
报告所有副本及当前实际生效的是哪一个。指向同一文件的软链/硬链重映射会被自动忽略，
不会误报（例如 WindowsApps 的执行别名、nvm/mamba 的 shim 重映射等场景）。

## 输出示例

```
=== rg.exe ===
  C:\...\WinGet\Packages\BurntSushi.ripgrep...\rg.exe -> （同上）
  C:\Program Files\ZCode\resources\tools\ripgrep\rg.exe -> （同上）
  * 生效: C:\...\WinGet\Packages\BurntSushi.ripgrep...\rg.exe
```

## 各环境版本

| 环境 | 文件 | 说明 |
|------|------|------|
| zsh（macOS / Linux） | `zsh/path-shadows` | 无依赖，直接运行 |
| bash 3.2+（macOS / Linux / Git Bash） | `bash/path-shadows` | 无依赖，兼容 macOS 自带的老 bash |
| Windows PowerShell 5.1+ / pwsh | `powershell/Path-Shadows.ps1` | 按 PATHEXT 判定可执行；符号链接与硬链接自动去重 |

## 用法

```sh
# zsh / bash
./zsh/path-shadows            # 报告可执行文件
./zsh/path-shadows --all      # 同时报告 .dll/.so/.dylib 等库文件（默认跳过，避免噪音）

# PowerShell
.\powershell\Path-Shadows.ps1
.\powershell\Path-Shadows.ps1 -All
```

建议通过 alias 使用，例如 zsh：

```sh
alias path-shadows='/path/to/my_tools/path-shadows/zsh/path-shadows'
```

## 去重规则

同名文件按两种键合并，命中任一即视为同一文件的映射而不重复报告：

- **真实路径**：符号链接（含 Windows reparse point / AppExeCLink 别名）解析后的目标；
- **inode / 硬链接组**：硬链接各路径不同但共享 inode，按 inode（Linux/macOS）
  或硬链接组（Windows `fsutil hardlink list` 语义，经 `LinkType.Target` 获取）合并。

## 已测试场景

- 真重复（不同目录下各自独立安装的同名命令）→ 正确报告全部副本；
- 软链重映射 → 合并为一条，不误报；
- 硬链（NTFS `mklink /H`、Linux `ln`）→ 合并为一条，不误报；
- 文件名含空格 / `[ ]` 等 glob 元字符 → 不漏报、不误报（遍历用 glob 展开目录，
  但对命令名回查时改用逐目录存在性测试，避免命令名被当作模式）；
- PATH 中同一目录出现多次 → 不误报；
- macOS 兼容：bash 版不使用关联数组；stat 调用 GNU 语法优先、失败回落 BSD `stat -f`。

## 已知限制

- Windows 上 `EnumerateFiles` 不区分扩展名大小写的场景由 PATHEXT 匹配保证；
- Git Bash（MSYS）中 `ln -s` 默认复制为独立文件，软链去重不适用于该场景
  （WSL / 原生 Linux / macOS 中正常）；
- 扫描含 `/mnt/c` 等 Windows 挂载目录时较慢（跨文件系统 stat 开销）。
