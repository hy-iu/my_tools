#!/usr/bin/env python3
"""按 match_videos.py 的结果重命名: 无意义标题 -> 「有意义标题_宽x高.mp4」,
完整记录追加到 抖音视频重命名记录.txt。默认 dry-run, 加 --go 才真正执行。

用法: python3 rename_videos.py matches.json [--go] [视频目录]
"""
import datetime
import json
import os
import sys

from common import probe_duration

DL = sys.argv[3] if len(sys.argv) > 3 and not sys.argv[3].startswith('--') else '/Users/bjergsen/Downloads'
GO = '--go' in sys.argv
MATCHES = sys.argv[1] if len(sys.argv) > 1 and not sys.argv[1].startswith('--') else 'matches.json'
RECORD = os.path.join(DL, '抖音视频重命名记录.txt')


def main():
    data = json.load(open(MATCHES))
    plan = []
    for m, cands in data['matches'].items():
        if not cands:
            continue
        n, _, _ = cands[0]
        wh = data['meta'][m]['wh']
        if not wh:
            continue
        w, h = wh
        new = f'{n[:-4]}_{w}x{h}.mp4'
        plan.append((m, new, w, h, data['meta'][m]['dur']))

    print(f'共 {len(plan)} 个文件待重命名')
    for old, new, w, h, d in plan:
        print(f'  {old}  ->  {new}')

    if not GO:
        print('\n(dry-run 模式, 未执行。确认无误后加 --go 运行)')
        return

    errors = []
    for old, new, *_ in plan:
        if not os.path.exists(os.path.join(DL, old)):
            errors.append(f'源文件不存在: {old}')
        if os.path.exists(os.path.join(DL, new)):
            errors.append(f'目标已存在: {new}')
    if len({n for _, n, *_ in plan}) != len(plan):
        errors.append('目标重名冲突')
    if errors:
        print('中止:')
        for e in errors:
            print(' ', e)
        return

    with open(RECORD, 'a', encoding='utf-8') as fh:
        fh.write('\n' + '=' * 40 + '\n')
        fh.write(f'重命名时间: {datetime.datetime.now().isoformat(timespec="seconds")}\n')
        fh.write(f'匹配方式: 8 帧均匀采样感知哈希 + 时长一致\n')
        fh.write(f'数量: {len(plan)} 个文件\n\n')
        fh.write('序号\t原文件名\t新文件名\t分辨率\t时长(秒)\n')
        for i, (old, new, w, h, d) in enumerate(plan, 1):
            fh.write(f'{i}\t{old}\t{new}\t{w}x{h}\t{d:.1f}\n')

    for old, new, *_ in plan:
        os.rename(os.path.join(DL, old), os.path.join(DL, new))
        print(f'renamed: {old} -> {new}')

    print(f'\n记录已追加: {RECORD}')


if __name__ == '__main__':
    main()
