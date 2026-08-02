# Avatar v2: crop robot to its bounding box, upscale to fill, glow variant
# Fixes: robot occupied ~1/6 of the 1024 canvas -> tiny at 20px display
import math
from PIL import Image, ImageDraw, ImageFilter

SRC = r'scripts/screenshots/31-raw2.png'
OUT = r'public/agent-avatar.png'
OUT_GLOW = r'public/agent-avatar-glow.png'
PREVIEW_DIR = r'scripts/screenshots'

im = Image.open(SRC).convert('RGB')
px = im.load()
alpha = Image.new('L', im.size, 0)
apx = alpha.load()
W, H = im.size

for y in range(H):
    for x in range(W):
        r, g, b = px[x, y]
        d = math.sqrt((255 - r) ** 2 + (255 - g) ** 2 + (255 - b) ** 2)
        if d >= 50:
            apx[x, y] = 255
        elif d >= 12:
            apx[x, y] = int(255 * (d - 12) / 38)
        else:
            apx[x, y] = 0

robot = im.convert('RGBA')
robot.putalpha(alpha)

# bounding box of non-transparent pixels
bbox = alpha.getbbox()  # (left, top, right, bottom)
l, t, r, b = bbox
bw, bh = r - l, b - t
print(f'bbox: {bbox} size {bw}x{bh}')

# pad ~10% of the larger side
pad = int(max(bw, bh) * 0.10)
l2 = max(0, l - pad)
t2 = max(0, t - pad)
r2 = min(W, r + pad)
b2 = min(H, b + pad)

robot_crop = robot.crop((l2, t2, r2, b2))
cw, ch = robot_crop.size

SIZE = 256
robot256 = robot_crop.resize((SIZE, SIZE), Image.LANCZOS)
robot256.save(OUT)

# glow: radial halo sized to the crop, then robot on top
glow = Image.new('RGBA', (cw, ch), (0, 0, 0, 0))
gd = ImageDraw.Draw(glow)
cx, cy = cw // 2, ch // 2
max_r = int(max(cw, ch) * 0.72)
for rr in range(max_r, 0, -2):
    t_ = rr / max_r
    a = int(110 * (1 - t_) ** 2)
    gd.ellipse([cx - rr, cy - rr, cx + rr, cy + rr], fill=(255, 120, 40, a))
glow = glow.filter(ImageFilter.GaussianBlur(int(max_r * 0.16)))
comp = Image.new('RGBA', (cw, ch), (0, 0, 0, 0))
comp.alpha_composite(glow)
comp.alpha_composite(robot_crop)
comp256 = comp.resize((SIZE, SIZE), Image.LANCZOS)
comp256.save(OUT_GLOW)

# previews on dark chat bg
DARK = (16, 16, 19)
for fname, src in [('avatar31-v2-dark.png', robot256), ('avatar31-v2-glow.png', comp256)]:
    base = Image.new('RGBA', src.size, DARK + (255,))
    base.alpha_composite(src)
    base.convert('RGB').thumbnail((360, 360), Image.LANCZOS)
    base.convert('RGB').save(f'{PREVIEW_DIR}/{fname}')

print('ok', robot256.size, '->', OUT, OUT_GLOW)
