#!/usr/bin/env python3
"""抖音视频重命名与动图匹配的共享工具函数。"""
import os
import subprocess

VIDEO_EXTS = ('.mp4', '.mov', '.mkv', '.flv', '.webm')
IMAGE_EXTS = ('.jpg', '.jpeg', '.png', '.webp', '.gif')


def hamming(a, b):
    return bin(a ^ b).count('1')


def dhash(raw: bytes, blocks: int = 8) -> int:
    """difference hash: raw 32x32 grayscale -> blocks*blocks bit int."""
    w = 32
    bits = 0
    for y in range(blocks):
        for x in range(blocks):
            stride = w // blocks
            l = raw[y*w*stride + x*stride : y*w*stride + x*stride + stride]
            r = raw[y*w*stride + (x+1)*stride : y*w*stride + (x+1)*stride + stride]
            bits = (bits << 1) | (1 if sum(l) < sum(r) else 0)
    return bits


def small_gray(src: str, out: str, w: int = 32, h: int = 32) -> str | None:
    """Extract one frame (first frame) scaled to grayscale rawvideo."""
    r = subprocess.run(
        ['ffmpeg', '-v', 'error', '-i', src, '-frames:v', '1',
         '-vf', f'scale={w}:{h}', '-f', 'rawvideo', '-pix_fmt', 'gray', '-y', out],
        capture_output=True)
    if r.returncode == 0 and os.path.getsize(out) >= w * h:
        return out
    return None


def probe_wh(path: str) -> tuple[int, int] | None:
    r = subprocess.run(
        ['ffprobe', '-v', 'error', '-select_streams', 'v:0',
         '-show_entries', 'stream=width,height', '-of', 'csv=p=0', path],
        capture_output=True, text=True)
    lines = r.stdout.strip().split('\n')
    wh = lines[0].split(',') if lines and lines[0] else []
    return (int(wh[0]), int(wh[1])) if len(wh) == 2 else None


def probe_duration(path: str) -> float | None:
    r = subprocess.run(
        ['ffprobe', '-v', 'error', '-show_entries', 'format=duration',
         '-of', 'csv=p=0', path],
        capture_output=True, text=True)
    try:
        return float(r.stdout.strip().split('\n')[0])
    except (ValueError, IndexError):
        return None


def aspect_ratio(wh: tuple[int, int] | None) -> float | None:
    if not wh or wh[1] == 0:
        return None
    return wh[0] / wh[1]
