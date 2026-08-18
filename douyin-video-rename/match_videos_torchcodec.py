#!/usr/bin/env python3
"""CUDA-only Douyin video matching with TorchCodec NVDEC.

Run this script with the dedicated host-Python environment created for
TorchCodec.  Frames are decoded directly to CUDA, reduced to perceptual hashes
on the GPU, then released immediately.  There is deliberately no CPU decoding
or inference fallback.
"""
import argparse
import json
import os
import subprocess
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path
from threading import Event, Thread


def configure_ffmpeg_dlls():
    """Expose the independent shared FFmpeg install before TorchCodec imports."""
    from common import media_tool

    ffmpeg_bin = str(Path(media_tool('ffmpeg')).parent)
    os.environ['PATH'] = ffmpeg_bin + os.pathsep + os.environ.get('PATH', '')
    if os.name == 'nt' and hasattr(os, 'add_dll_directory'):
        return os.add_dll_directory(ffmpeg_bin)
    return None


_FFMPEG_DLL_DIRECTORY = configure_ffmpeg_dlls()

import torch
import torch.nn.functional as functional
from torchcodec.decoders import VideoDecoder, set_nvdec_cache_capacity

from common import hamming

PREFIX = '神待福瑞'
SAMPLES = 8
VIDEO_EXTENSIONS = ('.mp4', '.mov', '.mkv', '.flv', '.webm', '.avi', '.m4v')


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory', nargs='?', default=os.path.expanduser('~/Downloads'))
    parser.add_argument('output', nargs='?', default='torchcodec-matches.json')
    parser.add_argument('--time-window-minutes', type=float,
                        help='只保留与无意义标题视频下载时间相距不超过此值的有意义标题候选')
    parser.add_argument('--workers', type=int, default=32,
                        help='并行 NVDEC 解码任务数（默认 32）')
    parser.add_argument('--nvdec-cache', type=int, default=128,
                        help='NVDEC 缓存容量（默认 128）')
    parser.add_argument('--telemetry-interval', type=float, default=0.25,
                        help='nvidia-smi 采样间隔秒数；设为 0 可关闭（默认 0.25）')
    args = parser.parse_args()
    if args.time_window_minutes is not None and args.time_window_minutes <= 0:
        parser.error('--time-window-minutes 必须大于 0')
    if args.workers < 1 or args.nvdec_cache < 1:
        parser.error('--workers 与 --nvdec-cache 必须至少为 1')
    if args.telemetry_interval < 0:
        parser.error('--telemetry-interval 不能小于 0')
    return args


def gpu_snapshot() -> dict[str, int] | None:
    """Read driver-level usage, including native NVDEC allocations."""
    try:
        result = subprocess.run(
            ['nvidia-smi', '--query-gpu=memory.used,utilization.gpu,utilization.memory',
             '--format=csv,noheader,nounits'],
            capture_output=True, text=True, timeout=2, check=False)
    except (OSError, subprocess.SubprocessError):
        return None
    if result.returncode != 0:
        return None
    fields = [field.strip() for field in result.stdout.strip().split(',')]
    if len(fields) != 3:
        return None
    try:
        return {
            'memory_used_mib': int(fields[0]),
            'gpu_utilization_percent': int(fields[1]),
            'memory_utilization_percent': int(fields[2]),
        }
    except ValueError:
        return None


class GpuTelemetry:
    """Sample outside PyTorch so TorchCodec's native allocations are included."""

    def __init__(self, interval: float):
        self.interval = interval
        self._stop = Event()
        self._thread = None
        self.samples: list[dict[str, int]] = []
        self.started_at = None

    def start(self):
        self.started_at = datetime.now(timezone.utc).isoformat()
        if self.interval <= 0:
            return
        self._thread = Thread(target=self._run, name='gpu-telemetry', daemon=True)
        self._thread.start()

    def _run(self):
        while not self._stop.is_set():
            sample = gpu_snapshot()
            if sample is not None:
                self.samples.append(sample)
            self._stop.wait(self.interval)

    def stop(self) -> dict:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=3)
        if not self.samples:
            return {'enabled': self.interval > 0, 'samples': 0}
        peak = {
            key: max(sample[key] for sample in self.samples)
            for key in self.samples[0]
        }
        return {
            'enabled': True,
            'interval_seconds': self.interval,
            'started_at_utc': self.started_at,
            'samples': len(self.samples),
            'baseline': self.samples[0],
            'peak': peak,
            'peak_delta_memory_mib': peak['memory_used_mib'] - self.samples[0]['memory_used_mib'],
        }


def select_videos(directory: str, time_window_minutes: float | None):
    all_videos = sorted(
        name for name in os.listdir(directory)
        if name.lower().endswith(VIDEO_EXTENSIONS))
    unnamed = [name for name in all_videos if name.startswith(PREFIX)]
    named = [name for name in all_videos if not name.startswith(PREFIX)]
    if time_window_minutes is None:
        return all_videos, unnamed, named

    limit = time_window_minutes * 60
    source_times = [os.path.getmtime(os.path.join(directory, name)) for name in unnamed]
    selected_named = []
    for name in named:
        file_time = os.path.getmtime(os.path.join(directory, name))
        if any(abs(file_time - timestamp) <= limit for timestamp in source_times):
            selected_named.append(name)
    return sorted(unnamed + selected_named), unnamed, selected_named


def frame_hashes(frames: torch.Tensor) -> list[int]:
    """Generate standard 64-bit dHash values from CUDA uint8 RGB frames."""
    # Resize before converting to float so high-resolution frames are not kept.
    small = functional.interpolate(frames.float(), size=(8, 9), mode='bilinear', align_corners=False)
    grayscale = small[:, 0] * 0.299 + small[:, 1] * 0.587 + small[:, 2] * 0.114
    bits = (grayscale[:, :, :-1] < grayscale[:, :, 1:]).reshape(frames.shape[0], 64)
    values = bits.cpu().tolist()
    hashes = []
    for row in values:
        value = 0
        for bit in row:
            value = (value << 1) | int(bit)
        hashes.append(value)
    return hashes


def decode_video(name: str, directory: str):
    path = os.path.join(directory, name)
    decoder = VideoDecoder(path, device='cuda')
    metadata = decoder.metadata
    duration = metadata.duration_seconds
    if not duration:
        return name, None, None
    times = [duration * (index + 0.5) / SAMPLES for index in range(SAMPLES)]
    frames = decoder.get_frames_played_at(seconds=times).data
    hashes = frame_hashes(frames)
    return name, {
        'wh': [metadata.width, metadata.height],
        'dur': duration,
    }, hashes


def main():
    if not torch.cuda.is_available():
        raise SystemExit('此程序只支持 CUDA/NVDEC，当前未检测到可用 CUDA。')
    args = parse_args()
    directory = os.path.abspath(args.directory)
    if not os.path.isdir(directory):
        raise SystemExit(f'视频目录不存在: {directory}')

    set_nvdec_cache_capacity(args.nvdec_cache)
    names, unnamed, named = select_videos(directory, args.time_window_minutes)
    print(f'GPU: {torch.cuda.get_device_name(0)}')
    print(f'NVDEC 并发: {args.workers}; 缓存: {args.nvdec_cache}; 视频: {len(names)}', flush=True)

    metadata, hashes = {}, {}
    telemetry = GpuTelemetry(args.telemetry_interval)
    telemetry.start()
    started = time.perf_counter()
    try:
        with ThreadPoolExecutor(max_workers=args.workers) as pool:
            futures = {pool.submit(decode_video, name, directory): name for name in names}
            for completed, future in enumerate(as_completed(futures), 1):
                name = futures[future]
                try:
                    _, meta, values = future.result()
                except Exception as exc:
                    print(f'跳过（NVDEC 异常） {name}: {exc}', flush=True)
                    continue
                if meta is not None:
                    metadata[name] = meta
                    hashes[name] = values
                print(f'解码 {completed}/{len(names)}: {name}', flush=True)
    finally:
        try:
            torch.cuda.synchronize()
        finally:
            elapsed = time.perf_counter() - started
            telemetry_summary = telemetry.stop()

    matches = {}
    for source in unnamed:
        if source not in hashes:
            continue
        candidates = []
        for target in named:
            if target not in hashes:
                continue
            if abs(metadata[source]['dur'] - metadata[target]['dur']) > 2.0:
                continue
            source_ratio = metadata[source]['wh'][0] / metadata[source]['wh'][1]
            target_ratio = metadata[target]['wh'][0] / metadata[target]['wh'][1]
            if abs(source_ratio / target_ratio - 1) > 0.25:
                continue
            distances = [hamming(left, right) for left, right in zip(hashes[source], hashes[target])]
            close = sum(distance <= 8 for distance in distances)
            if close >= 6:
                candidates.append([target, distances, close])
        candidates.sort(key=lambda candidate: (-candidate[2], sum(candidate[1])))
        matches[source] = candidates

    result = {
        'runtime': {
            'decoder': 'TorchCodec NVDEC',
            'device': torch.cuda.get_device_name(0),
            'workers': args.workers,
            'nvdec_cache': args.nvdec_cache,
            'cpu_decode_fallback': False,
            'decode_elapsed_seconds': round(elapsed, 3),
            'decoded_videos_per_second': round(len(hashes) / elapsed, 3) if elapsed else None,
            'gpu_telemetry': telemetry_summary,
        },
        'meta': metadata,
        'matches': matches,
    }
    with open(args.output, 'w', encoding='utf-8') as output:
        json.dump(result, output, ensure_ascii=False, indent=1)
    confirmed = sum(bool(candidates) and candidates[0][2] == SAMPLES for candidates in matches.values())
    peak = telemetry_summary.get('peak')
    if peak:
        print(f"GPU 采样峰值: {peak['memory_used_mib']} MiB; "
              f"GPU {peak['gpu_utilization_percent']}%; "
              f"显存控制器 {peak['memory_utilization_percent']}%", flush=True)
    print(f'待匹配 {len(unnamed)} 个；8/8 候选 {confirmed} 个；结果: {args.output}')


if __name__ == '__main__':
    main()
