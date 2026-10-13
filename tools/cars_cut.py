# Fono pašalinimas (rembg, isnet-general-use): python cars_cut.py <nuotrauka.jpg> <iškirpta.png>
import sys
from PIL import Image
from rembg import remove, new_session
session = new_session("isnet-general-use")
src, dst = sys.argv[1], sys.argv[2]
im = Image.open(src).convert("RGB")
out = remove(im, session=session, alpha_matting=True, alpha_matting_foreground_threshold=240, alpha_matting_background_threshold=15, alpha_matting_erode_size=8)
bbox = out.getbbox(); out = out.crop(bbox)
out.save(dst)
print(dst, out.size)
