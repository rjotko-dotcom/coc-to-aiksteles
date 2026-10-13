# X-Trail iš oficialios pilkos nuotraukos (jau be fono): dažų kaukė pilkiems dažams.
# Pilki dažai neatskiriami pagal atspalvį, todėl stiklai, ratai, grotelės, žibintai ir
# buferis pažymėti ranka (960 px pločio koordinatės).
# Naudojimas: python cars_xtrail.py <katalogas su cut/xt2_960.png; rezultatai – out/>
import json, sys, numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage as ndi
S=sys.argv[1]
im=Image.open(f"{S}/cut/xt2_960.png").convert("RGBA"); W,H=im.size
a=np.array(im).astype(np.float32)
rgb=a[...,:3]; alpha=a[...,3]/255
lum=0.299*rgb[...,0]+0.587*rgb[...,1]+0.114*rgb[...,2]
mx=rgb.max(-1); mn=rgb.min(-1); sat=np.where(mx>1,(mx-mn)/np.maximum(mx,1),0)
def sm(x,lo,hi):
    t=np.clip((x-lo)/(hi-lo),0,1); return t*t*(3-2*t)
ex=Image.new("L",(W,H),0); d=ImageDraw.Draw(ex)
polys=[
 [(262,182),(300,140),(392,96),(672,92),(862,108),(884,192),(760,212),(700,202),(655,212),(600,206),(420,204),(330,200)], # stiklai
 [(85,282),(348,284),(300,388),(108,392)], # grotelės
 [(112,392),(248,392),(248,428),(112,428)], # lentelė
 [(22,316),(82,326),(82,360),(24,352)], [(346,298),(362,284),(470,262),(540,252),(548,262),(470,282),(420,300)], [(352,346),(410,338),(466,334),(472,366),(362,372)], # žibintai
 [(25,440),(430,445),(440,520),(25,520)], # apatinis buferis
 [(640,400),(845,380),(845,412),(650,445)], # slenkstis
 [(905,195),(960,195),(960,245),(905,245)], # galinis žibintas
]
for p in polys: d.polygon(p, fill=255)
for (cx,cy,rx,ry) in [(588,470,74,92),(885,418,58,88),(130,505,78,42)]: d.ellipse([cx-rx,cy-ry,cx+rx,cy+ry], fill=255)
ex=np.array(ex.filter(__import__("PIL.ImageFilter",fromlist=["x"]).GaussianBlur(2)))/255
w=sm(lum,30,50)*(1-sm(lum,228,245))*(1-sm(sat,0.14,0.24))*alpha*(1-ex)
w=ndi.gaussian_filter(w,0.7)
lmed=float(np.median(lum[w>0.8])); print("lmed",lmed)
Image.fromarray(np.clip(w*255,0,255).astype(np.uint8),"L").save(f"{S}/out/x-trail-mask.webp",quality=90)
im.save(f"{S}/out/x-trail.webp",quality=88)
json.dump({"lmed":round(lmed,1),"w":W,"h":H},open(f"{S}/out/xt_meta.json","w"))
def tint(c,light=False,dark=False):
    c=np.array(c,np.float32); k=lum/lmed
    if light: k=np.minimum(1.06,0.7+0.3*k)
    span=255/lmed-1
    up=np.clip((k-1)/span,0,1)*(0.8 if dark else 1)
    return np.where((k<=1)[...,None], c*np.minimum(k,1)[...,None], c+(255-c)*up[...,None])
cols=[("pilka",None),("balta",(232,232,228)),("juoda",(20,20,22)),("melyna",(26,62,140)),("raudona",(158,14,26)),("zalia",(38,84,58))]
tiles=[]
for n,c in cols:
    o=a.copy()
    if c:
        l=0.299*c[0]+0.587*c[1]+0.114*c[2]
        o[...,:3]=rgb*(1-w[...,None])+tint(c,l>150,l<40)*w[...,None]
    t=Image.fromarray(np.clip(o,0,255).astype(np.uint8)); bg=Image.new("RGB",t.size,(30,30,34)); bg.paste(t,(0,0),t); tiles.append(bg.resize((480,300)))
sheet=Image.new("RGB",(960,900)); [sheet.paste(t,((i%2)*480,(i//2)*300)) for i,t in enumerate(tiles)]; sheet.save(f"{S}/xt_sheet.jpg",quality=90)
m=Image.fromarray(np.clip(w*255,0,255).astype(np.uint8)); m.save(f"{S}/xt_mask_preview.png")
