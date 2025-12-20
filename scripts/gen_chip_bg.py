import random
import struct

def generate_chip_bg(filename, width=1024, height=1024):
    # BMP Header
    # Signature 'BM'
    # FileSize (4 bytes)
    # Reserved (4 bytes)
    # DataOffset (4 bytes)

    # DIB Header (BITMAPINFOHEADER)
    # Size (4 bytes) = 40
    # Width (4 bytes)
    # Height (4 bytes)
    # Planes (2 bytes) = 1
    # BitCount (2 bytes) = 24
    # Compression (4 bytes) = 0
    # ImageSize (4 bytes)
    # XpixelsPerM (4 bytes)
    # YpixelsPerM (4 bytes)
    # ColorsUsed (4 bytes)
    # ColorsImportant (4 bytes)

    row_size = (width * 3 + 3) & ~3
    pixel_data_size = row_size * height
    file_size = 14 + 40 + pixel_data_size
    offset = 14 + 40

    with open(filename, 'wb') as f:
        # File Header
        f.write(b'BM')
        f.write(struct.pack('<I', file_size))
        f.write(struct.pack('<I', 0)) # Reserved
        f.write(struct.pack('<I', offset))

        # DIB Header
        f.write(struct.pack('<I', 40))
        f.write(struct.pack('<i', width))
        f.write(struct.pack('<i', height))
        f.write(struct.pack('<H', 1))
        f.write(struct.pack('<H', 24))
        f.write(struct.pack('<I', 0))
        f.write(struct.pack('<I', pixel_data_size))
        f.write(struct.pack('<i', 2835)) # 72 DPI
        f.write(struct.pack('<i', 2835))
        f.write(struct.pack('<I', 0))
        f.write(struct.pack('<I', 0))

        # Generate Data
        # We want a dark grey background with some structure
        # Let's create some blocks

        # Pre-generate some random blocks
        blocks = []
        for _ in range(50):
            bx = random.randint(0, width)
            by = random.randint(0, height)
            bw = random.randint(50, 200)
            bh = random.randint(50, 200)
            color_boost = random.randint(20, 60)
            blocks.append((bx, by, bw, bh, color_boost))

        # We will write row by row
        # BMP stores rows bottom to top usually, but we specified positive height?
        # Actually height > 0 means bottom-up.

        # Create a simple bytearray for one row to speed up?
        # No, let's just write byte by byte or construct rows.

        for y in range(height):
            row = bytearray(row_size)
            for x in range(width):
                # Base color (Dark Grey/Greenish)
                r = 20
                g = 30
                b = 25

                # Noise
                n = random.randint(0, 10)
                r += n
                g += n
                b += n

                # Blocks
                for (bx, by, bw, bh, boost) in blocks:
                    if bx <= x < bx + bw and by <= y < by + bh:
                        # Inside a block
                        r += boost // 2
                        g += boost
                        b += boost // 2

                        # Border of block
                        if x == bx or x == bx + bw - 1 or y == by or y == by + bh - 1:
                            g += 40

                # Grid lines
                if x % 128 == 0 or y % 128 == 0:
                    r += 30
                    g += 30
                    b += 30

                # Clamp
                r = min(255, r)
                g = min(255, g)
                b = min(255, b)

                # BGR
                idx = x * 3
                row[idx] = b
                row[idx+1] = g
                row[idx+2] = r

            f.write(row)

if __name__ == "__main__":
    print("Generating images/chip_bg.bmp...")
    generate_chip_bg("images/chip_bg.bmp")
    print("Done.")
