"""Generate simple placeholder PNG icons for the Chrome extension."""
import struct
import zlib
import os

def create_png(width, height, pixels):
    """Create a PNG file from raw RGBA pixel data."""
    def chunk(chunk_type, data):
        c = chunk_type + data
        crc = struct.pack('>I', zlib.crc32(c) & 0xffffffff)
        return struct.pack('>I', len(data)) + c + crc

    # PNG signature
    sig = b'\x89PNG\r\n\x1a\n'

    # IHDR
    ihdr_data = struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0)  # 8-bit RGBA
    ihdr = chunk(b'IHDR', ihdr_data)

    # IDAT - pixel data
    raw = b''
    for y in range(height):
        raw += b'\x00'  # filter: none
        for x in range(width):
            idx = (y * width + x) * 4
            raw += bytes(pixels[idx:idx+4])

    compressed = zlib.compress(raw)
    idat = chunk(b'IDAT', compressed)

    # IEND
    iend = chunk(b'IEND', b'')

    return sig + ihdr + idat + iend


def lerp(a, b, t):
    return int(a + (b - a) * t)


def create_icon(size):
    """Create a purple gradient icon with 'PA' text."""
    pixels = [0] * (size * size * 4)

    for y in range(size):
        for x in range(size):
            idx = (y * size + x) * 4
            t = (x + y) / (2 * size)

            # Purple gradient: #6366f1 to #8b5cf6
            r = lerp(99, 139, t)
            g = lerp(102, 92, t)
            b = lerp(241, 246, t)
            a = 255

            # Round corners
            cx, cy = size / 2, size / 2
            corner_r = size * 0.2
            # Check if in rounded rect
            in_rect = True
            for (corner_x, corner_y) in [(corner_r, corner_r), (size - corner_r, corner_r),
                                          (corner_r, size - corner_r), (size - corner_r, size - corner_r)]:
                if ((x < corner_r or x > size - corner_r) and
                    (y < corner_r or y > size - corner_r)):
                    dx = x - corner_x
                    dy = y - corner_y
                    if dx * dx + dy * dy > corner_r * corner_r:
                        in_rect = False
                        break

            if not in_rect:
                r, g, b, a = 0, 0, 0, 0

            pixels[idx] = r
            pixels[idx + 1] = g
            pixels[idx + 2] = b
            pixels[idx + 3] = a

    # Draw simple "P" and "A" letters for larger icons
    if size >= 48:
        letter_color = (255, 255, 255, 255)
        scale = size / 128.0

        # Simple block letter drawing
        def draw_rect(x1, y1, x2, y2):
            for yy in range(max(0, int(y1)), min(size, int(y2))):
                for xx in range(max(0, int(x1)), min(size, int(x2))):
                    idx = (yy * size + xx) * 4
                    pixels[idx] = letter_color[0]
                    pixels[idx + 1] = letter_color[1]
                    pixels[idx + 2] = letter_color[2]
                    pixels[idx + 3] = letter_color[3]

        # "P" letter
        px = 20 * scale
        py = 30 * scale
        pw = 8 * scale  # stroke width
        ph = 68 * scale  # height

        # P vertical stroke
        draw_rect(px, py, px + pw, py + ph)
        # P top horizontal
        draw_rect(px, py, px + 30 * scale, py + pw)
        # P middle horizontal
        draw_rect(px, py + 30 * scale, px + 30 * scale, py + 30 * scale + pw)
        # P right vertical (top half)
        draw_rect(px + 25 * scale, py, px + 30 * scale + pw, py + 30 * scale + pw)

        # "A" letter
        ax = 65 * scale
        ay = 30 * scale
        ah = 68 * scale

        # A left stroke
        draw_rect(ax, ay, ax + pw, ay + ah)
        # A right stroke
        draw_rect(ax + 30 * scale, ay, ax + 30 * scale + pw, ay + ah)
        # A top horizontal
        draw_rect(ax, ay, ax + 30 * scale + pw, ay + pw)
        # A middle horizontal
        draw_rect(ax, ay + 30 * scale, ax + 30 * scale + pw, ay + 30 * scale + pw)

    return pixels


def main():
    icons_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'public', 'icons')
    os.makedirs(icons_dir, exist_ok=True)

    for size in [16, 48, 128]:
        pixels = create_icon(size)
        png_data = create_png(size, size, pixels)
        path = os.path.join(icons_dir, f'icon{size}.png')
        with open(path, 'wb') as f:
            f.write(png_data)
        print(f'Created {path} ({size}x{size})')


if __name__ == '__main__':
    main()
