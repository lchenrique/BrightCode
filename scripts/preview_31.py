# Preview 31.svg: white-key, dark bg + glow variants
import math
from PIL import Image, ImageDraw, ImageFilter

SRC = r'scripts/screenshots/31-raw2.png'
OUT_DIR = r'scripts/screenshots'

im = Image.open(SRC).convert('RGB')
px = im.load()
alpha = Image.new('L', im.size, 0)
apx = alpha.load()
W, H = im.size

for y in range(H):
    for x in range(W):
        r, g, b = px[x, y]
        # distance from white
        d = math.sqrt((255 - r) ** 2 + (255 - g) ** 2 + (255 - b) ** 2)
        if d >= 50:
            apx[x, y] = 255
        elif d >= 12:
            apx[x, y] = int(255 * (d - 12) / 38)
        else:
            apx[x, y] = 0

robot = im.convert('RGBA')
robot.putalpha(alpha)

# --- 1. dark chat background ---
DARK = (16, 16, 19)
dark = Image.new('RGBA', im.size, DARK + (255,))
dark.alpha_composite(robot)
dark = dark.convert('RGB')
dark.thumbnail((420, 420), Image.LANCZOS)
dark.save(f'{OUT_DIR}/31-dark.png')

# --- 2. glow variant: radial orange glow behind robot ---
glow = Image.new('RGBA', im.size, (0, 0, 0, 0))
gd = ImageDraw.Draw(glow)
cx, cy = W // 2, H // 2
max_r = int(W * 0.55)
# soft radial: several concentric orange rings with decreasing alpha
for rr in range(max_r, 0, -2):
    t = rr / max_r
    a = int(90 * (1 - t) ** 2)
    col = (255, 120, 40, a)
    gd.ellipse([cx - rr, cy - rr, cx + rr, cy + rr], fill=col)
glow = glow.filter(ImageFilter.GaussianBlur(40))

comp = Image.new('RGBA', im.size, DARK + (255,))
comp.alpha_composite(glow)
comp.alpha_composite(robot)
comp = comp.convert('RGB')
comp.thumbnail((420, 420), Image.LANCZOS)
comp.save(f'{OUT_DIR}/31-glow.png')

print('ok', dark.size, comp.size)
