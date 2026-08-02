"""Generate the BrightCode app icon and the chat-agent avatar mascot.

Two outputs:

  App icon (red-orange bg, kept as-is):
    src-tauri/icons/icon.png           1024x1024 (master)
    src-tauri/icons/32x32.png          32x32
    src-tauri/icons/128x128.png        128x128
    src-tauri/icons/128x128@2x.png     256x256
    src-tauri/icons/icon.ico           multi-size 16/32/48/64/128/256
    public/favicon.png                 64x64 (favicon-friendly)

  Agent avatar (3.png = orange robot on orange glow):
    public/agent-avatar.png            128x128 transparent, with a
                                        soft glow ring so it pops on
                                        any sidebar background.
"""

from PIL import Image, ImageDraw, ImageFilter
import os

ROOT = r"D:\projetos pessoais\BrightCode"
ICON_SRC = os.path.join(ROOT, "ICON-BRIGHT.png")
AVATAR_SRC = os.path.join(ROOT, "3.png")
ICONS = os.path.join(ROOT, "src-tauri", "icons")
PUBLIC_DIR = os.path.join(ROOT, "public")

TAURI_SIZES = {
    "32x32.png": (32, 32),
    "128x128.png": (128, 128),
    "128x128@2x.png": (256, 256),
    "icon.png": (1024, 1024),
}
ICO_SIZES = [(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
FAVICON_SIZE = (64, 64)
AVATAR_SIZE = (128, 128)


def remove_orange_bg(img: Image.Image) -> Image.Image:
    """3.png is a darker-orange robot drawn on top of a brighter
    orange radial glow. A red-channel-dominance rule is wrong here
    because the robot itself is orange. Instead we keep pixels whose
    *luminance* is well below the glow's peak: the glow saturates
    around lum ≈ 250, the robot's solid body sits around 100–160,
    and the boundary blends. We do a soft alpha ramp so the antialias
    edge of the robot doesn't leave a visible orange fringe."""
    img = img.convert("RGBA")
    w, h = img.size
    pixels = img.load()

    for y in range(h):
        for x in range(w):
            r, g, b, a = pixels[x, y]
            lum = 0.2126 * r + 0.7152 * g + 0.0722 * b
            # Anything brighter than 200 is the radial glow — drop it.
            # Anything darker than 140 is the solid robot — keep opaque.
            # In between: soft alpha so the antialias edge blends.
            if lum >= 200:
                pixels[x, y] = (r, g, b, 0)
            elif lum >= 140:
                alpha = int(255 * (200 - lum) / 60)
                pixels[x, y] = (r, g, b, max(0, min(255, alpha)))

    return img


def add_glow(img: Image.Image, glow_color=(255, 130, 50, 110), radius=22) -> Image.Image:
    """Composite a soft outer glow behind the avatar so it pops on
    any background. The glow is a Gaussian-blurred copy of the
    alpha channel tinted with the brand orange."""
    w, h = img.size
    base = Image.new("RGBA", (w + radius * 4, h + radius * 4), (0, 0, 0, 0))

    # Build a glow mask from the avatar's alpha.
    alpha = img.split()[3]
    glow_mask = Image.new("L", (w + radius * 4, h + radius * 4), 0)
    glow_mask.paste(alpha, (radius * 2, radius * 2))
    glow_mask = glow_mask.filter(ImageFilter.GaussianBlur(radius))

    # Tint it.
    tint = Image.new("RGBA", glow_mask.size, glow_color)
    tint.putalpha(glow_mask)
    base.alpha_composite(tint)

    # Drop the avatar on top, centered.
    base.alpha_composite(img, (radius * 2, radius * 2))
    return base


def main():
    os.makedirs(ICONS, exist_ok=True)
    os.makedirs(PUBLIC_DIR, exist_ok=True)

    # 1. App icon — ICON-BRIGHT.png (keep red-orange background)
    print(f"[icon] source: {ICON_SRC}")
    icon = Image.open(ICON_SRC).convert("RGBA")
    print(f"[icon] size: {icon.size}")

    for name, (w, h) in TAURI_SIZES.items():
        path = os.path.join(ICONS, name)
        icon.resize((w, h), Image.NEAREST).save(path, "PNG")
        print(f"[icon] wrote {path}")

    ico_path = os.path.join(ICONS, "icon.ico")
    frames = [icon.resize(size, Image.LANCZOS) for size in ICO_SIZES]
    frames[0].save(
        ico_path, format="ICO", sizes=ICO_SIZES, append_images=frames[1:]
    )
    print(f"[icon] wrote {ico_path}")

    favicon_path = os.path.join(PUBLIC_DIR, "favicon.png")
    icon.resize(FAVICON_SIZE, Image.LANCZOS).save(favicon_path, "PNG")
    print(f"[icon] wrote {favicon_path}")

    # 2. Agent avatar — 3.png (orange robot, transparent bg, soft glow)
    print(f"\n[avatar] source: {AVATAR_SRC}")
    avatar_src = Image.open(AVATAR_SRC).convert("RGBA")
    print(f"[avatar] size: {avatar_src.size}")

    transparent = remove_orange_bg(avatar_src)
    cropped = trim_transparent(transparent, pad=8)
    resized = cropped.resize(AVATAR_SIZE, Image.LANCZOS)
    glowed = add_glow(resized, glow_color=(255, 130, 50, 130), radius=18)

    avatar_path = os.path.join(PUBLIC_DIR, "agent-avatar.png")
    glowed.save(avatar_path, "PNG")
    print(f"[avatar] wrote {avatar_path}")


def trim_transparent(img: Image.Image, pad: int = 0) -> Image.Image:
    """Crop to the bounding box of the non-transparent pixels, with an
    optional uniform padding. Keeps the avatar centered on its own
    transparency halo instead of offset inside a 1254x1254 frame."""
    alpha = img.split()[3]
    bbox = alpha.getbbox()
    if not bbox:
        return img
    l, t, r, b = bbox
    l = max(0, l - pad)
    t = max(0, t - pad)
    r = min(img.width, r + pad)
    b = min(img.height, b + pad)
    return img.crop((l, t, r, b))


if __name__ == "__main__":
    main()
