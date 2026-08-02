# Generate chat avatar from 31.svg render (31-raw2.png, 1024 white-bg)
# - white-key -> transparent RGBA
# - downscale 8x exact with NEAREST to keep pixel-art crisp (128px)
# - also emits a 128px glow variant for comparison
import math
from PIL import Image, ImageDraw, ImageFilter

SRC = r'scripts/screenshots/31-raw2.png'
OUT = r'public/agent-avatar.png'
OUT_GLOW = r'public/agent-avatar-glow.png'

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

SIZE = 128
robot128 = robot.resize((SIZE, SIZE), Image.NEAREST)
robot128.save(OUT)

# glow variant: soft radial halo behind, then robot
glow = Image.new('RGBA', robot.size, (0, 0, 0, 0))
gd = ImageDraw.Draw(glow)
cx, cy = W // 2, H // 2
max_r = int(W * 0.55)
for rr in range(max_r, 0, -2):
    t = rr / max_r
    a = int(90 * (1 - t) ** 2)
    gd.ellipse([cx - rr, cy - rr, cx + rr, cy + rr], fill=(255, 120, 40, a))
glow = glow.filter(ImageFilter.GaussianBlur(40)).resize((SIZE, SIZE), Image.NEAREST)
comp = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
comp.alpha_composite(glow)
comp.alpha_composite(robot128)
comp.save(OUT_GLOW)

print('ok')
