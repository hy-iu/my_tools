#!/usr/bin/env python3
"""找出下载目录里仍为无意义标题("神待福瑞的抖音*")且内容与有意义标题视频
相同的文件。输出匹配结果到 matches.json。

方法: 每段视频单次 ffmpeg 调用均匀提取 8 帧 32x32 灰度图, 计算 64 位感知
哈希; 与有意义标题视频逐帧比较, 要求时长差 <=2s 且至少 6/8 帧距离 <=8。

用法: python3 match_videos.py [视频目录] [匹配输出json]
"""
import datetime
import json
import os
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed

from common import hamming, media_tool, probe_duration, probe_wh

DL = sys.argv[1] if len(sys.argv) > 1 else '/Users/bjergsen/Downloads'
OUT = sys.argv[2] if len(sys.argv) > 2 else 'matches.json'
# 只处理当前仍为无意义标题的文件(已重命名的不会匹配前缀)
PREFIX = '神待福瑞'
FRAMES = 8
DUR_TOL = 2.0
DIST_THRESH = 8
CLOSE_MIN = 6
WORKERS = 8


def extract_8(path: str, dur: float) -> list[bytes] | None:
    """Seek to eight positions and return 32×32 grayscale frames in memory."""
    frames = []
    for k in range(FRAMES):
        ts = dur * (k + 0.5) / FRAMES
        r = subprocess.run(
            [media_tool('ffmpeg'), '-v', 'error', '-ss', str(ts), '-i', path, '-frames:v', '1',
             '-vf', 'scale=32:32', '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1'],
            capture_output=True)
        if r.returncode != 0 or len(r.stdout) < 1024:
            return None
        frames.append(r.stdout[:1024])
    return frames


def process_video(f: str):
    """提取一个视频的 8 帧哈希 + 元数据。"""
    from common import dhash
    p = os.path.join(DL, f)
    dur = probe_duration(p)
    if not dur:
        return f, None, None
    raw_frames = extract_8(p, dur)
    if raw_frames is None:
        return f, None, None
    hashes = [dhash(raw) for raw in raw_frames]
    return f, {'wh': probe_wh(p), 'dur': dur}, hashes


def main():
    from common import dhash
    vids = sorted(f for f in os.listdir(DL) if f.lower().endswith(('.mp4', '.mov', '.mkv', '.flv', '.webm', '.avi', '.m4v')))
    meaningless = [f for f in vids if f.startswith(PREFIX)]
    meaningful = [f for f in vids if not f.startswith(PREFIX)]

    meta, hashes = {}, {}
    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        futures = {pool.submit(process_video, f): f for f in vids}
        for future in as_completed(futures):
            f = futures[future]
            try:
                _, m, hs = future.result()
            except Exception as exc:
                print(f'采集失败 {f}: {exc}', flush=True)
                continue
            if m is not None:
                meta[f] = m
                hashes[f] = hs
            print(f'采集 {f}', flush=True)

    results = {}
    for m in meaningless:
        if m not in hashes:
            continue
        cands = []
        for n in meaningful:
            if n not in hashes:
                continue
            if abs(meta[m]['dur'] - meta[n]['dur']) > DUR_TOL:
                continue
            ds = [hamming(a, b) for a, b in zip(hashes[m], hashes[n])]
            close = sum(1 for d in ds if d <= DIST_THRESH)
            if close >= CLOSE_MIN:
                cands.append((n, ds, close))
        cands.sort(key=lambda c: (-c[2], sum(c[1])))
        results[m] = cands

    for m, cands in results.items():
        if not cands:
            print(f'无匹配: {m} [{meta[m]["wh"]} {meta[m]["dur"]:.1f}s]')
        else:
            n, ds, close = cands[0]
            print(f'{m} [{meta[m]["wh"]} {meta[m]["dur"]:.1f}s]')
            print(f'  -> {n} [{meta[n]["wh"]} {meta[n]["dur"]:.1f}s] close={close}/{FRAMES} min={min(ds)}')

    json.dump({'meta': meta, 'matches': results},
              open(OUT, 'w'), ensure_ascii=False, indent=1)
    print(f'已保存: {OUT}')


if __name__ == '__main__':
    main()
