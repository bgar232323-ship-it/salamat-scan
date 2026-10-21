"""Generate placeholder PWA icons for Salamat Scan.

Pure-stdlib PNG writer (no PIL): draws a deep-green rounded square with
white barcode bars, which is enough for a placeholder app icon.
"""

import struct
import zlib
import os

GREEN = (0x1B, 0x7F, 0x4B, 255)
WHITE = (0xFF, 0xFF, 0xFF, 255)


def rounded_rect_mask(size, radius):
    """Return a 2D list of booleans: True where the pixel is inside the shape."""
    r = radius
    r2 = r * r
    inside = [[False] * size for _ in range(size)]
    for y in range(size):
        for x in range(size):
            # distance to nearest corner centre when in a corner region
            cx = r if x < r else (size - 1 - r if x >= size - r else None)
            cy = r if y < r else (size - 1 - r if y >= size - r else None)
            if cx is None or cy is None:
                ok = True
            else:
                dx = x - cx
                dy = y - cy
                ok = dx * dx + dy * dy <= r2
            inside[y][x] = ok
    return inside


def barcode_bars(size):
    """Return a predicate for the white barcode bars region."""
    # bar pattern: (width, gap) pairs in relative units
    pattern = [(1, 1), (3, 1), (1, 2), (2, 1), (1, 1), (3, 2), (1, 1), (2, 2), (1, 1), (3, 1)]
    left = int(size * 0.24)
    right = int(size * 0.76)
    top = int(size * 0.34)
    bottom = int(size * 0.66)
    unit = (right - left) / sum(w + g for w, g in pattern)
    bars = []
    cursor = left
    for w, g in pattern:
        bars.append((cursor, cursor + w * unit))
        cursor += w * unit + g * unit
    return bars, top, bottom


def make_icon(size):
    radius = int(size * 0.22)
    mask = rounded_rect_mask(size, radius)
    bars, top, bottom = barcode_bars(size)
    rows = []
    for y in range(size):
        row = bytearray()
        row.append(0)  # filter type 0 (None)
        for x in range(size):
            if not mask[y][x]:
                row += bytes((0, 0, 0, 0))
                continue
            if top <= y <= bottom and any(b0 <= x <= b1 for b0, b1 in bars):
                row += bytes(WHITE)
            else:
                row += bytes(GREEN)
        rows.append(bytes(row))
    raw = b"".join(rows)

    def chunk(tag, data):
        payload = tag + data
        return struct.pack(">I", len(data)) + payload + struct.pack(">I", zlib.crc32(payload) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")
    return png


if __name__ == "__main__":
    out = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "icons")
    os.makedirs(out, exist_ok=True)
    # 180px is the size iOS uses for apple-touch-icon.
    for size in (180, 192, 512):
        path = os.path.join(out, f"icon-{size}.png")
        with open(path, "wb") as fh:
            fh.write(make_icon(size))
        print("wrote", path, os.path.getsize(path))
