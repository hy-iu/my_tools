// zstd helpers for dsh session files.
// dsh writes MULTI-FRAME zstd (one frame per flush); Node's zstd API only
// decodes the first frame of a buffer. Node exposes neither a streaming
// multi-frame decoder nor consumed-input counts, so we scan for frame magic
// numbers and decode each candidate slice — frames are self-delimiting, so a
// decode at a true frame start returns exactly that frame and ignores the
// tail; false magics inside compressed data simply fail to decode. Verified
// against real dsh sessions (21k events, <1s per 6MB file).
import zlib from 'node:zlib';

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

export function zstdDecompressAll(buf: Buffer): Buffer {
  // fast path: single-frame files (most small sessions)
  try {
    const single = zlib.zstdDecompressSync(buf);
    // if the whole buffer was one frame, there is nothing after it — we
    // can't tell cheaply, so continue with the scan only when the decode
    // looks truncated is impossible; the scan below is still needed for
    // multi-frame files, but for single-frame files it costs one extra
    // magic search. Acceptable for local-tool scale.
    if (buf.indexOf(MAGIC, 4) < 0) return single;
  } catch {
    /* fall through to the scan */
  }
  const parts: Buffer[] = [];
  let i = buf.indexOf(MAGIC);
  while (i >= 0 && i <= buf.length - 4) {
    try {
      const decoded = zlib.zstdDecompressSync(buf.subarray(i));
      if (decoded.length > 0) parts.push(decoded);
    } catch {
      /* false magic inside another frame's payload */
    }
    i = buf.indexOf(MAGIC, i + 4);
  }
  return Buffer.concat(parts);
}
