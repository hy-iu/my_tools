#!/usr/bin/env python3
"""GPU-only semantic video matching for Douyin downloads.

This complements ``match_videos.py``: FFmpeg extracts four representative RGB
frames in memory and MobileNetV3-Small embeds them in CUDA batches.  It never
renames files.  CUDA is mandatory; this program intentionally has no CPU
inference fallback.

Usage: py -3.12 match_videos_gpu.py F:\\Downloads F:\\Downloads\\douyin-gpu-matches.json
"""
import argparse
import json
import os
import subprocess
import sys
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed

import numpy as np
import torch
import torch.nn.functional as functional
from torchvision.models import MobileNet_V3_Small_Weights, mobilenet_v3_small

from common import aspect_ratio, media_tool, probe_duration, probe_wh

for stream in (sys.stdout, sys.stderr):
    if hasattr(stream, 'reconfigure'):
        stream.reconfigure(encoding='utf-8', errors='backslashreplace')

PREFIX = '神待福瑞'
SAMPLES = 4
SIZE = 224
DURATION_TOLERANCE = 2.0
ASPECT_TOLERANCE = 0.25


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory', nargs='?', default=os.path.expanduser('~/Downloads'))
    parser.add_argument('output', nargs='?', default='gpu-matches.json')
    parser.add_argument('--batch-size', type=int, default=1024)
    parser.add_argument('--workers', type=int, default=min(8, os.cpu_count() or 1),
                        help='CPU 抽帧并发数（默认最多 8）')
    parser.add_argument('--time-window-minutes', type=float,
                        help='只保留与无意义标题视频下载时间相距不超过此值的有意义标题候选')
    args = parser.parse_args()
    if args.batch_size < 1:
        parser.error('--batch-size 必须至少为 1')
    if args.workers < 1:
        parser.error('--workers 必须至少为 1')
    if args.time_window_minutes is not None and args.time_window_minutes <= 0:
        parser.error('--time-window-minutes 必须大于 0')
    return args


def extract_frames(path: str, duration: float) -> np.ndarray | None:
    """Extract four uniform padded RGB frames with one FFmpeg process."""
    video_filter = (
        f'fps={SAMPLES / duration:.12f},'
        f'scale={SIZE}:{SIZE}:force_original_aspect_ratio=decrease,'
        f'pad={SIZE}:{SIZE}:(ow-iw)/2:(oh-ih):color=black,format=rgb24')
    result = subprocess.run(
        [media_tool('ffmpeg'), '-v', 'error', '-i', path, '-vf', video_filter,
         '-frames:v', str(SAMPLES), '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'],
        capture_output=True)
    frame_bytes = SIZE * SIZE * 3
    expected = SAMPLES * frame_bytes
    if result.returncode != 0 or len(result.stdout) < expected:
        return None
    return np.frombuffer(result.stdout[:expected], dtype=np.uint8).reshape(SAMPLES, SIZE, SIZE, 3)


def process_video(name: str, directory: str):
    path = os.path.join(directory, name)
    duration = probe_duration(path)
    if not duration:
        return name, None, None
    frames = extract_frames(path, duration)
    if frames is None:
        return name, None, None
    return name, {'wh': probe_wh(path), 'dur': duration}, frames


def load_model() -> torch.nn.Module:
    if not torch.cuda.is_available():
        raise SystemExit('此 GPU 匹配器需要 CUDA；请使用 match_videos.py 进行 CPU 感知哈希匹配。')
    model = mobilenet_v3_small(weights=MobileNet_V3_Small_Weights.DEFAULT).features
    return model.eval().cuda()


def embed_videos(frames_by_video: dict[str, np.ndarray], batch_size: int) -> dict[str, torch.Tensor]:
    """Embed every frame on CUDA, returning L2-normalized per-frame features."""
    model = load_model()
    names, flat_frames = [], []
    for name, frames in frames_by_video.items():
        for frame in frames:
            names.append(name)
            flat_frames.append(frame)

    embeddings = defaultdict(list)
    mean = torch.tensor([0.485, 0.456, 0.406], device='cuda').view(1, 3, 1, 1)
    std = torch.tensor([0.229, 0.224, 0.225], device='cuda').view(1, 3, 1, 1)
    with torch.inference_mode():
        for start in range(0, len(flat_frames), batch_size):
            array = np.stack(flat_frames[start:start + batch_size])
            batch = torch.from_numpy(array).permute(0, 3, 1, 2).cuda(non_blocking=True).float().div_(255)
            batch.sub_(mean).div_(std)
            features = functional.adaptive_avg_pool2d(model(batch), 1).flatten(1)
            features = functional.normalize(features, dim=1).cpu()
            for name, vector in zip(names[start:start + batch_size], features):
                embeddings[name].append(vector)
    return {name: torch.stack(vectors) for name, vectors in embeddings.items()}


def candidate_score(source: torch.Tensor, reference: torch.Tensor) -> tuple[float, float, float]:
    """Return aggregate, mean-frame and weakest corresponding-frame cosine scores."""
    frame_scores = (source * reference).sum(dim=1)
    video_score = functional.normalize(source.mean(dim=0), dim=0).dot(
        functional.normalize(reference.mean(dim=0), dim=0)).item()
    frame_mean = frame_scores.mean().item()
    return 0.5 * video_score + 0.5 * frame_mean, frame_mean, frame_scores.min().item()


def select_videos(directory: str, time_window_minutes: float | None):
    extensions = ('.mp4', '.mov', '.mkv', '.flv', '.webm', '.avi', '.m4v')
    all_videos = sorted(name for name in os.listdir(directory) if name.lower().endswith(extensions))
    unnamed = [name for name in all_videos if name.startswith(PREFIX)]
    named = [name for name in all_videos if not name.startswith(PREFIX)]
    if time_window_minutes is None:
        return all_videos
    limit = time_window_minutes * 60
    source_times = [os.path.getmtime(os.path.join(directory, name)) for name in unnamed]
    selected_named = []
    for name in named:
        file_time = os.path.getmtime(os.path.join(directory, name))
        if any(abs(file_time - timestamp) <= limit for timestamp in source_times):
            selected_named.append(name)
    selected = sorted(unnamed + selected_named)
    print(f'时间窗口: {time_window_minutes:g} 分钟；候选视频: {len(selected)}')
    return selected


def main():
    args = parse_args()
    directory = os.path.abspath(args.directory)
    if not os.path.isdir(directory):
        raise SystemExit(f'视频目录不存在: {directory}')

    device = torch.cuda.get_device_name(0)
    print(f'GPU: {device}')
    print('模型: MobileNetV3-Small ImageNet 预训练特征；GPU-only，无 CPU 推理回退')
    names = select_videos(directory, args.time_window_minutes)
    metadata, frames_by_video = {}, {}
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = {pool.submit(process_video, name, directory): name for name in names}
        for number, future in enumerate(as_completed(futures), 1):
            name = futures[future]
            try:
                _, meta, frames = future.result()
            except Exception as exc:
                print(f'跳过（抽帧异常） {name}: {exc}', flush=True)
                continue
            if meta is None:
                print(f'跳过（抽帧失败） {name}', flush=True)
                continue
            metadata[name] = meta
            frames_by_video[name] = frames
            print(f'抽帧 {number}/{len(names)}: {name}', flush=True)

    embeddings = embed_videos(frames_by_video, args.batch_size)
    unknown = [name for name in embeddings if name.startswith(PREFIX)]
    named = [name for name in embeddings if not name.startswith(PREFIX)]
    matches = {}
    for source_name in unknown:
        source_ratio = aspect_ratio(metadata[source_name]['wh'])
        candidates = []
        for reference_name in named:
            if abs(metadata[source_name]['dur'] - metadata[reference_name]['dur']) > DURATION_TOLERANCE:
                continue
            reference_ratio = aspect_ratio(metadata[reference_name]['wh'])
            if source_ratio and reference_ratio and abs(source_ratio / reference_ratio - 1) > ASPECT_TOLERANCE:
                continue
            score, frame_mean, frame_min = candidate_score(
                embeddings[source_name], embeddings[reference_name])
            verdict = 'STRONG' if score >= 0.980 and frame_min >= 0.940 else 'REVIEW'
            candidates.append({
                'file': reference_name,
                'verdict': verdict,
                'score': round(score, 6),
                'frame_mean': round(frame_mean, 6),
                'frame_min': round(frame_min, 6),
            })
        candidates.sort(key=lambda item: item['score'], reverse=True)
        matches[source_name] = candidates[:5]

    result = {
        'runtime': {
            'device': device,
            'model': 'MobileNetV3-Small ImageNet weights',
            'samples_per_video': SAMPLES,
            'input_size': SIZE,
            'cpu_inference_fallback': False,
        },
        'meta': metadata,
        'matches': matches,
    }
    with open(args.output, 'w', encoding='utf-8') as output:
        json.dump(result, output, ensure_ascii=False, indent=1)

    strong = sum(bool(candidates) and candidates[0]['verdict'] == 'STRONG'
                 for candidates in matches.values())
    print(f'待匹配 {len(unknown)} 个；高置信候选 {strong} 个；结果: {args.output}')
    print('该结果仅供复核；请先用 match_videos.py 的感知哈希交叉验证，再执行重命名。')


if __name__ == '__main__':
    main()
