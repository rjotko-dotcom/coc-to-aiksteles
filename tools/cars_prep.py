# Naudojimas: python cars_prep.py <iškirpti PNG (cars_cut.py)> <web/sandelis/cars>
# Paruošia automobilių paveikslus: iškirptas automobilis (RGBA WebP, dažų vietos be spalvos)
# + dažų kaukė (pilkų atspalvių). Naršyklė perdažo: out = lerp(base, tint(lum(base)), mask).
import json, sys
import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage as ndi

CUT, OUT = sys.argv[1], sys.argv[2]
# modelis: (failas, apversti, atspalvio centras °, leistinas nuokrypis °, min sodrumas)
SPEC = {
    "qashqai": ("q2", False, 356, 22, 0.30, None),
    "x-trail": ("x2", False, 16, 16, 0.35, None),
    "juke":    ("j1", False, 8, 18, 0.35, (604, 466, 826, 539)),
    "ariya":   ("a3", False, 27, 14, 0.16, (768, 381, 895, 430)),
    "leaf":    ("l2", False, 186, 18, 0.25, None),
    "micra":   ("m1", False, 201, 18, 0.25, (50, 334, 164, 394)),
}
# kapotai su dideliais atspindžiais – dažai visame plote
HOOD = {
    "qashqai": [(60, 240), (130, 195), (240, 180), (420, 195), (530, 205), (510, 235), (420, 255), (300, 275), (180, 290), (70, 270)],
    "x-trail": [(470, 150), (560, 160), (740, 160), (880, 190), (925, 225), (780, 235), (640, 205), (560, 195)],
    "juke": [(230, 200), (560, 190), (760, 195), (880, 230), (890, 265), (850, 300), (560, 320), (420, 300), (290, 270)],
}
WIDTH = 960
TINT = {"pilka": (110, 114, 118), "balta": (236, 236, 232), "juoda": (22, 22, 24), "melyna": (28, 66, 150), "raudona": (170, 18, 30), "zalia": (40, 90, 60)}


def hsv(rgb):
    r, g, b = [rgb[..., i] for i in range(3)]
    mx = rgb.max(-1); mn = rgb.min(-1); d = mx - mn
    h = np.zeros_like(mx)
    nz = d > 1e-6
    rm = nz & (mx == r); gm = nz & (mx == g) & ~rm; bm = nz & ~rm & ~gm
    h[rm] = ((g - b)[rm] / d[rm]) % 6
    h[gm] = (b - r)[gm] / d[gm] + 2
    h[bm] = (r - g)[bm] / d[bm] + 4
    s = np.where(mx > 1e-6, d / np.maximum(mx, 1e-6), 0)
    return h * 60, s, mx


def smooth(x, lo, hi):
    t = np.clip((x - lo) / (hi - lo), 0, 1)
    return t * t * (3 - 2 * t)


def tint(lum, lmed, colour):
    k = lum / lmed
    c = np.array(colour, dtype=np.float32)
    dark = c[None, None, :] * np.minimum(k, 1)[..., None]
    up = np.clip((k - 1) / (255 / lmed - 1), 0, 1)[..., None]
    light = c + (255 - c) * up
    return np.where((k <= 1)[..., None], dark, light)


meta = {}
sheet_tiles = []
for model, (name, flip, centre, tol, min_s, plate_box) in SPEC.items():
    im = Image.open(f"{CUT}/{name}.png").convert("RGBA")
    if flip:
        im = im.transpose(Image.FLIP_LEFT_RIGHT)
    im = im.crop(im.getbbox())
    im = im.resize((WIDTH, round(im.height * WIDTH / im.width)), Image.LANCZOS)
    a = np.array(im)
    if plate_box:
        x0, y0, x1, y1 = plate_box
        a[y0:y1, x0:x1, :3] = (226, 227, 229)
        a[y0:y1, x0:x0 + 2, :3] = a[y0:y1, x1 - 2:x1, :3] = (120, 120, 124)
        a[y0:y0 + 2, x0:x1, :3] = a[y1 - 2:y1, x0:x1, :3] = (120, 120, 124)
        a[y0:y1, x0:x1, 3] = 255
    hood_img = Image.new("L", (a.shape[1], a.shape[0]), 0)
    if model in HOOD:
        ImageDraw.Draw(hood_img).polygon(HOOD[model], fill=255)
    hood = np.array(hood_img) > 0
    plate_mask = np.zeros(a.shape[:2], bool)
    if plate_box:
        plate_mask[y0:y1, x0:x1] = True
    alpha = a[..., 3]
    # paliekame tik didžiausią sritį (be fono likučių)
    lab, n = ndi.label(alpha > 100)
    if n > 1:
        sizes = ndi.sum(np.ones_like(alpha), lab, range(1, n + 1))
        keep = ndi.binary_dilation(lab == (np.argmax(sizes) + 1), iterations=4)
        alpha = np.where(keep, alpha, 0)
    alpha = np.where(alpha < 90, 0, alpha)
    solid = ndi.binary_opening(alpha > 128, iterations=3)
    lab, n = ndi.label(solid)
    if n > 1:
        sizes = ndi.sum(np.ones_like(alpha), lab, range(1, n + 1))
        solid = lab == (np.argmax(sizes) + 1)
    alpha = np.where(ndi.binary_dilation(solid, iterations=2), alpha, 0)
    a[..., 3] = alpha
    a[..., 3] = alpha
    bbox = Image.fromarray(alpha).getbbox()
    a = a[bbox[1]:bbox[3], bbox[0]:bbox[2]]
    plate_mask = plate_mask[bbox[1]:bbox[3], bbox[0]:bbox[2]]
    hood = hood[bbox[1]:bbox[3], bbox[0]:bbox[2]]
    im = Image.fromarray(a)
    scale = WIDTH / im.width
    im = im.resize((WIDTH, round(im.height * scale)), Image.LANCZOS)
    a = np.array(im).astype(np.float32)
    plate_mask = np.array(Image.fromarray(plate_mask).resize(im.size)) > 0
    hood = ndi.gaussian_filter((np.array(Image.fromarray(hood).resize(im.size)) > 0).astype(np.float32), 3)
    rgb = a[..., :3] / 255
    h, s, v = hsv(rgb)
    dh = np.abs(((h - centre + 180) % 360) - 180)
    w = (1 - smooth(dh, tol * 0.6, tol * 1.4)) * smooth(s, min_s * 0.7, min_s * 1.3) * smooth(v, 0.08, 0.2)
    w *= a[..., 3] / 255
    w[plate_mask] = 0
    strong = w > 0.5
    # atspindžiai (mažai sodrūs, bet to paties atspalvio) šalia dažų
    near = ndi.binary_dilation(strong, iterations=18) & (a[..., 3] > 128)
    w2 = (1 - smooth(dh, 40, 60)) * smooth(s, 0.03, 0.10) * near
    w2[plate_mask] = 0
    # atspindžių atspalvis išimamas (bazėje jie tampa pilki)
    cast = np.maximum((1 - smooth(dh, 45, 70)) * near, 1 - smooth(s, 0.30, 0.45)) * (~plate_mask)
    cast = np.maximum(ndi.gaussian_filter(cast.astype(np.float32), 1.0), hood)
    w = np.maximum(np.maximum(w, w2), hood * 0.92 * (a[..., 3] / 255))
    region = ndi.binary_closing(strong, structure=np.ones((3, 3)), iterations=6) & (a[..., 3] > 128)
    region[plate_mask] = False
    region_soft = ndi.gaussian_filter(region.astype(np.float32), 1.2)
    # atspindžiai dažų srityje perdažomi kartu (be rausvų dėmių)
    w = np.maximum(w, region_soft * 0.9)
    w = ndi.gaussian_filter(w, 0.8) * (a[..., 3] / 255)
    lum = 0.299 * a[..., 0] + 0.587 * a[..., 1] + 0.114 * a[..., 2]
    lmed = float(np.median(lum[w > 0.85]))
    # bazė: dažų srityje be spalvos
    rs = np.maximum(np.maximum(region_soft, w), cast)[..., None]
    base = a.copy()
    base[..., :3] = a[..., :3] * (1 - rs) + lum[..., None] * rs
    out = Image.fromarray(np.clip(base, 0, 255).astype(np.uint8), "RGBA")
    out.save(f"{OUT}/{model}.webp", quality=84, method=6)
    Image.fromarray(np.clip(w * 255, 0, 255).astype(np.uint8), "L").save(f"{OUT}/{model}-mask.webp", quality=88, method=6)
    meta[model] = {"lmed": round(lmed, 1), "w": out.width, "h": out.height}
    print(model, out.size, "lmed", round(lmed, 1))
    for cname, colour in TINT.items():
        t = tint(lum, lmed, colour)
        o = base.copy()
        o[..., :3] = base[..., :3] * (1 - w[..., None]) + t * w[..., None]
        tile = Image.fromarray(np.clip(o, 0, 255).astype(np.uint8), "RGBA")
        tile.thumbnail((320, 200))
        sheet_tiles.append(tile)

cols = len(TINT)
sheet = Image.new("RGB", (320 * cols, 200 * len(SPEC)), (34, 36, 42))
for i, t in enumerate(sheet_tiles):
    sheet.paste(t, ((i % cols) * 320, (i // cols) * 200), t)
sheet.save(f"{OUT}/../sheet.jpg", quality=88)
json.dump(meta, open(f"{OUT}/meta.json", "w"), indent=1)
