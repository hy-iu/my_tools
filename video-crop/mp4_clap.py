#!/usr/bin/env python3
"""Insert a clean aperture ('clap') atom into the video track of an MP4 without re-encoding.
Usage: mp4_clap.py input.mp4 output.mp4 width height [h_off v_off]"""
import struct, sys

def parse_boxes(data, start, end):
    """Yield (box_type, header_len, box_start, box_end) for children of [start, end)."""
    pos = start
    while pos + 8 <= end:
        size = struct.unpack(">I", data[pos:pos+4])[0]
        hdr = 8
        if size == 1:
            size = struct.unpack(">Q", data[pos+8:pos+16])[0]
            btype = data[pos+8:pos+12]
            hdr = 16
        elif size == 0:
            size = end - pos
            btype = data[pos+4:pos+8]
        else:
            btype = data[pos+4:pos+8]
        if pos + size > end or size < hdr:
            break
        yield btype, hdr, pos, pos + size
        pos += size

def patch(data, width, height, h_off=0, v_off=0):
    b = bytearray(data)
    # locate moov
    moov = None
    for btype, hdr, start, end in parse_boxes(b, 0, len(b)):
        if btype == b"moov":
            moov = (hdr, start, end)
            break
    if not moov:
        raise ValueError("no moov")
    mhdr, mstart, mend = moov

    # find video trak (contains hdlr 'vide')
    video_trak = None
    for btype, hdr, start, end in parse_boxes(b, mstart + mhdr, mend):
        if btype != b"trak":
            continue
        is_video = False
        for bt2, h2, s2, e2 in parse_boxes(b, start + hdr, end):
            if bt2 == b"mdia":
                for bt3, h3, s3, e3 in parse_boxes(b, s2 + h2, e2):
                    if bt3 == b"hdlr":
                        hdlr = b[s3+h3:s3+h3+16]
                        if len(hdlr) >= 12 and hdlr[8:12] == b"vide":
                            is_video = True
                        break
                break
        if is_video:
            video_trak = (hdr, start, end)
            break
    if not video_trak:
        raise ValueError("no video trak")
    thdr, tstart, tend = video_trak

    clap = struct.pack(">IIIIIIII", width, 1, height, 1, h_off, 1, v_off, 1)
    clap_box = struct.pack(">I4s", 8 + len(clap), b"clap") + clap

    # insert clap right after tkhd (first child of trak)
    for btype, hdr, start, end in parse_boxes(b, tstart + thdr, tend):
        if btype == b"tkhd":
            insert_at = end
            break
    else:
        insert_at = tstart + thdr

    b[insert_at:insert_at] = clap_box
    # fix sizes of trak and moov (both grown by len(clap_box))
    def bump_size(box_start, delta):
        size_field = struct.unpack(">I", b[box_start:box_start+4])[0]
        if size_field == 1:
            old = struct.unpack(">Q", b[box_start+8:box_start+16])[0]
            b[box_start+8:box_start+16] = struct.pack(">Q", old + delta)
        else:
            b[box_start:box_start+4] = struct.pack(">I", size_field + delta)
    bump_size(tstart, len(clap_box))
    bump_size(mstart, len(clap_box))

    # if moov precedes mdat, all chunk offsets in stco/co64 must be shifted
    mdat_pos = None
    for btype, hdr, start, end in parse_boxes(b, 0, len(b)):
        if btype == b"mdat":
            mdat_pos = start
            break
    if mdat_pos is not None and mstart < mdat_pos:
        delta = len(clap_box)
        # walk the whole tree for stco/co64
        def walk(start, end):
            for btype, hdr, s, e in parse_boxes(b, start, end):
                if btype == b"stco":
                    cnt = struct.unpack(">I", b[s+hdr+4:s+hdr+8])[0]
                    off = s + hdr + 8
                    for i in range(cnt):
                        v = struct.unpack(">I", b[off+4*i:off+4*i+4])[0]
                        b[off+4*i:off+4*i+4] = struct.pack(">I", v + delta)
                elif btype == b"co64":
                    cnt = struct.unpack(">I", b[s+hdr+4:s+hdr+8])[0]
                    off = s + hdr + 8
                    for i in range(cnt):
                        v = struct.unpack(">Q", b[off+8*i:off+8*i+8])[0]
                        b[off+8*i:off+8*i+8] = struct.pack(">Q", v + delta)
                elif btype in (b"moov", b"trak", b"mdia", b"minf", b"stbl", b"edts", b"udta", b"meta"):
                    walk(s + hdr, e)
        walk(0, len(b))
    return bytes(b)

if __name__ == "__main__":
    src, dst = sys.argv[1], sys.argv[2]
    w, h = int(sys.argv[3]), int(sys.argv[4])
    ho = int(sys.argv[5]) if len(sys.argv) > 5 else 0
    vo = int(sys.argv[6]) if len(sys.argv) > 6 else 0
    open(dst, "wb").write(patch(open(src, "rb").read(), w, h, ho, vo))
    print(f"patched clap: {w}x{h} off=({ho},{vo}) -> {dst}")
