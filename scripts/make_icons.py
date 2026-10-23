"""Generate the extension icons (a briefcase with a notification dot)."""
from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "icons"
BLUE = (37, 99, 235, 255)
WHITE = (255, 255, 255, 255)
GREEN = (34, 197, 94, 255)


def draw(size: int) -> Image.Image:
    scale = 8  # supersample, then downscale for smooth edges
    s = size * scale
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, s - 1, s - 1], radius=s * 0.22, fill=BLUE)
    # handle
    d.rounded_rectangle([s * 0.36, s * 0.2, s * 0.64, s * 0.38], radius=s * 0.05, outline=WHITE, width=round(s * 0.06))
    # case
    d.rounded_rectangle([s * 0.18, s * 0.32, s * 0.82, s * 0.78], radius=s * 0.07, fill=WHITE)
    d.rectangle([s * 0.18, s * 0.5, s * 0.82, s * 0.53], fill=BLUE)
    # "new" dot
    r = s * 0.15
    cx, cy = s * 0.8, s * 0.22
    d.ellipse([cx - r - s * 0.03, cy - r - s * 0.03, cx + r + s * 0.03, cy + r + s * 0.03], fill=BLUE)
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=GREEN)
    return img.resize((size, size), Image.LANCZOS)


if __name__ == "__main__":
    OUT.mkdir(exist_ok=True)
    for size in (16, 32, 48, 128):
        draw(size).save(OUT / f"icon{size}.png")
    print(f"Wrote icons to {OUT}")
