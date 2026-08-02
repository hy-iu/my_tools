#!/usr/bin/env python3
"""Insert PixelCrop elements into an MKV file without re-encoding.
Usage: mkv_crop.py input.mkv output.mkv top bottom [left right]"""
import sys

ID_SEGMENT = bytes.fromhex("18538067")
ID_TRACKS = bytes.fromhex("1654AE6B")
ID_TRACKENTRY = bytes.fromhex("AE")
ID_VIDEO = bytes.fromhex("E0")
CROPS = {
    "top": bytes.fromhex("54BB"),
    "bottom": bytes.fromhex("54AA"),
    "left": bytes.fromhex("54CC"),
    "right": bytes.fromhex("54DD"),
}

def id_len(data, pos):
    b = data[pos]
    w = 1
    while w < 9 and not (b & (0x80 >> (w - 1))):
        w += 1
    return w

def size_vint_bytes(n):
    w = 1
    while n > (1 << (7 * w)) - 1:
        w += 1
    marker = 0x80 >> (w - 1)
    out = bytearray()
    for i in range(w):
        shift = 8 * (w - 1 - i)
        part = (n >> shift) & 0xFF
        out.append((marker >> i) | part if i == 0 else part)
    return bytes(out)

def parse_element(data, pos):
    iw = id_len(data, pos)
    id_bytes = data[pos:pos + iw]
    first = data[pos + iw]
    sw = 1
    while sw < 9 and not (first & (0x80 >> (sw - 1))):
        sw += 1
    if sw == 9:
        return id_bytes, None, None, None
    val = first & ((0x80 >> (sw - 1)) - 1)
    for j in range(1, sw):
        val = (val << 8) | data[pos + iw + j]
    pstart = pos + iw + sw
    return id_bytes, pstart, pstart + val, pstart + val

def children(payload):
    """Yield (id_bytes, payload_bytes) of direct children."""
    i = 0
    out = []
    while i < len(payload):
        idb, ps, pe, nx = parse_element(payload, i)
        if ps is None:
            break
        out.append((idb, payload[ps:pe]))
        i = nx
    return out

def rebuild(children_list):
    return b"".join(cid + size_vint_bytes(len(cp)) + cp for cid, cp in children_list)

def patch(data, crops):
    seg_idx = data.find(ID_SEGMENT)
    if seg_idx < 0:
        raise ValueError("no Segment")
    idb, ps, pe, nx = parse_element(data, seg_idx)
    seg_payload = data[ps:pe] if pe is not None else data[ps:]
    header = data[:seg_idx]

    seg_children = children(seg_payload)
    new_seg_children = []
    found_track = False
    for cid, cp in seg_children:
        if cid == ID_TRACKS and not found_track:
            found_track = True
            tracks_children = children(cp)
            new_tracks = []
            for tid, tcp in tracks_children:
                if tid != ID_TRACKENTRY:
                    new_tracks.append((tid, tcp))
                    continue
                te_children = children(tcp)
                new_te = []
                patched_video = False
                for vid, vcp in te_children:
                    if vid == ID_VIDEO and not patched_video:
                        patched_video = True
                        add = bytearray()
                        for name, val in crops:
                            if val > 0:
                                payload = val.to_bytes(max(1, (val.bit_length() + 7) // 8), "big")
                                add += CROPS[name]
                                add += size_vint_bytes(len(payload))
                                add += payload
                        vcp = vcp + bytes(add)
                    new_te.append((vid, vcp))
                new_tracks.append((tid, rebuild(new_te)))
            cp = rebuild(new_tracks)
        new_seg_children.append((cid, cp))

    if not found_track:
        raise ValueError("no Tracks")
    new_seg = ID_SEGMENT + size_vint_bytes(len(rebuild(new_seg_children))) + rebuild(new_seg_children)
    return header + new_seg

def dump_video_elements(path):
    data = open(path, "rb").read()
    seg_idx = data.find(ID_SEGMENT)
    _, ps, pe, _ = parse_element(data, seg_idx)
    seg_payload = data[ps:pe] if pe is not None else data[ps:]
    for cid, cp in children(seg_payload):
        if cid == ID_TRACKS:
            for tid, tcp in children(cp):
                if tid == ID_TRACKENTRY:
                    for vid, vcp in children(tcp):
                        if vid == ID_VIDEO:
                            for eid, ep in children(vcp):
                                val = int.from_bytes(ep, "big")
                                print(f"  Video child {eid.hex()}: {val}")

if __name__ == "__main__":
    src, dst = sys.argv[1], sys.argv[2]
    crops = [("top", int(sys.argv[3])), ("bottom", int(sys.argv[4]))]
    if len(sys.argv) > 5:
        crops.append(("left", int(sys.argv[5])))
    if len(sys.argv) > 6:
        crops.append(("right", int(sys.argv[6])))
    out = patch(open(src, "rb").read(), crops)
    open(dst, "wb").write(out)
    print(f"patched {src} -> {dst}: {dict(crops)}")
