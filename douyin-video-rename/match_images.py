#!/usr/bin/env python3
"""任务二: 剩余无意义标题视频(动图) ↔ 新下载图片(~/Pictures/<帖子标题>/NN.jpg) 匹配。

方法:
  1. 提取每段视频首帧(动图首帧=静态原图)与每张图片的 32x32 灰度感知哈希
  2. 双信号验证:
     - 内容: 哈希距离(STRONG<=8, GOOD<=14) + 宽高比一致
     - 时间: 视频下载时间与图片文件夹修改时间差<3分钟(同一帖子)
  3. 分级输出: STRONG / GOOD / POST(仅帖子级) / NONE

用法: python3 match_images.py [视频目录] [图片根目录] [截止时间] > report.txt
"""
import datetime
import json
import os
import sys

from common import hamming, small_gray, probe_wh, aspect_ratio

DL = sys.argv[1] if len(sys.argv) > 1 else '/Users/bjergsen/Downloads'
PIC = sys.argv[2] if len(sys.argv) > 2 else '/Users/bjergsen/Pictures'
# 只处理 2026-08-02 19:00 之前下载的视频(用户当时仍在继续下载新文件)
CUTOFF = datetime.datetime(2026, 8, 2, 19, 0).timestamp()
IMG_MT_MIN = 1785542400  # 图片文件夹 2026-08-01 之后
TIME_GAP_MIN = 3.0       # 视频与文件夹下载时间差阈值(分钟)
AR_TOL = 0.25            # 宽高比相对差容差


def main():
    import tempfile
    tmp = tempfile.mkdtemp(prefix='dy_img_')

    vids = sorted(
        f for f in os.listdir(DL)
        if f.lower().endswith(('.mp4', '.mov', '.mkv', '.flv', '.webm'))
        and f.startswith('神待福瑞的抖音')
        and os.path.getmtime(os.path.join(DL, f)) < CUTOFF)

    folders = {}
    for d in os.listdir(PIC):
        p = os.path.join(PIC, d)
        if not os.path.isdir(p) or d.startswith('.') or d.startswith('Photos'):
            continue
        m = os.path.getmtime(p)
        if m < IMG_MT_MIN:
            continue
        imgs = sorted(f for f in os.listdir(p) if f.lower().endswith(('.jpg', '.jpeg', '.png', '.webp')))
        folders[d] = {'mtime': m, 'imgs': imgs}

    vh, vwh = {}, {}
    for i, v in enumerate(vids):
        src = os.path.join(DL, v)
        o = small_gray(src, os.path.join(tmp, f'v{i}.raw'))
        if o:
            vh[v] = open(o, 'rb').read(1024)
            vwh[v] = probe_wh(src)

    ih, iwh = {}, {}
    for i, (d, info) in enumerate(folders.items()):
        for im in info['imgs']:
            src = os.path.join(PIC, d, im)
            o = small_gray(src, os.path.join(tmp, f'i{i}_{im}.raw'))
            if o:
                ih[(d, im)] = open(o, 'rb').read(1024)
                iwh[(d, im)] = probe_wh(src)

    results = {}
    from common import dhash
    for v in vids:
        if v not in vh:
            results[v] = ('NONE', None, None, None)
            continue
        var = aspect_ratio(vwh[v])
        best = (99, None)
        for (d, im), raw in ih.items():
            iar = aspect_ratio(iwh[(d, im)])
            if var and iar and abs(var / iar - 1) > AR_TOL:
                continue
            dist = hamming(dhash(vh[v]), dhash(raw))
            if dist < best[0]:
                best = (dist, (d, im))
        dist, (d, im) = best
        gap = abs((os.path.getmtime(os.path.join(DL, v)) - folders[d]['mtime']) / 60) if d in folders else 999
        if dist <= 8:
            verdict = 'STRONG'
        elif dist <= 14 and gap < TIME_GAP_MIN:
            verdict = 'GOOD'
        elif gap < TIME_GAP_MIN:
            verdict = 'POST'
        else:
            verdict = 'NONE'
        results[v] = (verdict, d, im, dist)

    counts = {}
    for v in vids:
        counts[results[v][0]] = counts.get(results[v][0], 0) + 1
    print(f'总计 {len(vids)} 个视频: ' + ', '.join(f'{k}={v}' for k, v in sorted(counts.items())))
    print()
    for v in vids:
        verdict, d, im, dist = results[v]
        print(f'[{verdict:>6}] dh={dist if dist is not None else "-":>3}  {v}')
        if d:
            print(f'         -> {os.path.join(d, im)}')

    json.dump(results, open('/tmp/dongtu_results.json', 'w'), ensure_ascii=False, indent=1)

if __name__ == '__main__':
    main()
