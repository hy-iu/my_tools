#!/usr/bin/env python3
"""Crop black bars from HEVC resolution-suffixed videos. Re-encode with libx265 at
source bitrate; audio copied. Detection: decoder gray + row means (ground truth)."""
import subprocess, os, re, json, glob

TH, RUN = 30, 5
OUTDIR = sys.argv[1] if len(sys.argv) > 1 else "."

def run(cmd, **kw):
    return subprocess.run(cmd, capture_output=True, **kw)

def probe(video):
    out = json.loads(run(["ffprobe", "-v", "error", "-select_streams", "v:0",
                          "-show_entries", "stream=width,height,codec_name,bit_rate,pix_fmt",
                          "-of", "json", video], text=True).stdout)["streams"][0]
    fmt = json.loads(run(["ffprobe", "-v", "error", "-show_entries", "format=duration,size",
                          "-of", "json", video], text=True).stdout)["format"]
    br = out.get("bit_rate")
    return (int(out["width"]), int(out["height"]), out["codec_name"],
            float(br) if br not in (None, "N/A") else None,
            float(fmt["duration"]), int(fmt["size"]), out.get("pix_fmt", ""))

def detect_bars(video, W, H, fps_out=2):
    p = run(["ffmpeg", "-v", "error", "-i", video, "-vf", f"fps={fps_out}",
             "-f", "rawvideo", "-pix_fmt", "gray", "-"])
    d = p.stdout
    n = len(d) // (W * H)
    if n == 0:
        return None, None, 0
    tops, bots = [], []
    for i in range(n):
        f = d[i*W*H:(i+1)*W*H]
        row = [sum(f[y*W:(y+1)*W]) / W for y in range(H)]
        top = H
        for y in range(H - RUN + 1):
            if all(b >= TH for b in row[y:y+RUN]):
                top = y
                break
        bot = H
        for y in range(H - RUN, -1, -1):
            if all(b >= TH for b in row[y:y+RUN]):
                bot = H - (y + RUN)
                break
        tops.append(top)
        bots.append(bot)
    return min(tops), min(bots), n

def encode(src, dst, w, h, top, bot, br_kbps):
    y = top if top % 2 == 0 else top - 1
    hh = h - y - bot
    if hh % 2:
        hh -= 1
    r = run(["ffmpeg", "-y", "-v", "error", "-i", src,
             "-vf", f"crop={w}:{hh}:0:{y}",
             "-c:v", "libx265", "-b:v", f"{br_kbps}k",
             "-maxrate", f"{int(br_kbps*1.2)}k", "-bufsize", f"{int(br_kbps*2)}k",
             "-preset", "medium", "-pix_fmt", "yuv420p", "-tag:v", "hvc1",
             "-c:a", "copy", "-movflags", "+faststart", dst, "-progress", "pipe:1"],
            text=True)
    return r.returncode, y, hh

files = sorted(glob.glob(os.path.join(OUTDIR, "*_*x*.mp4")))
targets = [f for f in files if re.search(r"_\d{3,4}x\d{3,4}\.mp4$", os.path.basename(f))
           and "_裁黑边" not in os.path.basename(f)]
print(f"共 {len(targets)} 个分辨率后缀视频")
report = []
for src in targets:
    name = os.path.basename(src)
    try:
        w, h, codec, br, dur, fsize, pix = probe(src)
    except Exception as e:
        report.append(f"SKIP(probe) {name}: {e}")
        continue
    if br is None:
        br = fsize * 8 / dur
    top, bot, n = detect_bars(src, w, h)
    if top is None:
        report.append(f"SKIP(no data) {name}")
        continue
    if top < 8 and bot < 8:
        report.append(f"SKIP(no bars) {name} ({w}x{h})")
        continue
    dst = src.replace(".mp4", "_裁黑边.mp4")
    rc, y, hh = encode(src, dst, w, h, top, bot, round(br / 1000))
    if rc != 0:
        report.append(f"FAIL {name}")
        continue
    newsize = os.path.getsize(dst)
    report.append(
        f"OK {name}\n"
        f"  {w}x{h}({codec}) -> {w}x{hh} (y={y}, top={top}, bottom={bot}) | "
        f"src {br/1000:.0f}k {fsize/1e6:.2f}MB -> {newsize/1e6:.2f}MB ({newsize/fsize*100:.0f}%)")
print("\n".join(report))
