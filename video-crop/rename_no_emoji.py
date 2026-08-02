#!/usr/bin/env python3
"""Remove emoji (icon) characters from file names, e.g. for cloud-drive uploads.
Usage: python3 rename_no_emoji.py [目录] [glob模式]

Examples:
  python3 rename_no_emoji.py /Users/bjergsen/Downloads "*_2160x3840.mp4"
  python3 rename_no_emoji.py . "*_裁黑边*.mp4"
"""
import os, re, sys, glob

EMOJI = re.compile(
    "[\U0001F000-\U0001F02F"      # 麻将牌
    "\U0001F1E6-\U0001F1FF"      # 区域指示符（旗帜）
    "\U0001F300-\U0001FAFF"      # 表情符号/杂项符号
    "\U00002600-\U000027BF"      # 杂项符号/装饰符号
    "\U00002B00-\U00002BFF"      # 杂项符号和箭头
    "\U0000FE0E-\U0000FE0F"      # 变体选择符
    "\U0000200D"                 # ZWJ 零宽连接符
    "\U0000FFFC-\U0000FFFD"      # 对象替换符
    "]+"
)


def main():
    d = sys.argv[1] if len(sys.argv) > 1 else "."
    pattern = sys.argv[2] if len(sys.argv) > 2 else "*"
    files = sorted(glob.glob(os.path.join(d, pattern)))
    renamed = skipped = 0
    for f in files:
        base = os.path.basename(f)
        if os.path.isdir(f):
            continue
        new = EMOJI.sub("", base)
        new = re.sub(r" {2,}", " ", new).strip()
        if new == base:
            continue
        dst = os.path.join(d, new)
        if os.path.exists(dst):
            print(f"冲突跳过: {base}")
            skipped += 1
            continue
        os.rename(f, dst)
        renamed += 1
        print(f"→ {new}")
    print(f"共改名 {renamed} 个，冲突 {skipped} 个")


if __name__ == "__main__":
    main()
