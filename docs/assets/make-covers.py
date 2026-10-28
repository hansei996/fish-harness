# -*- coding: utf-8 -*-
"""生成「第 38 层」封面图 —— 两个画幅。

为什么两个：各平台显示的图宽高比不同（小红书 3:4 竖图，微博/X/朋友圈偏横）。
上一版只做了 3:4，放进横向容器里被 cover 裁掉大半。
现在按场景比例分别构图，而不是把一张图硬塞进两个形状。

为什么用代码画而不是找图：本仓库明文约束第三方素材不得入库
（README「素材是占位的…上线前必须替换为原创或已授权形象」）。
"""
import math, random
from PIL import Image, ImageDraw, ImageFilter

def lerp(a, b, t):
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(3))

def make(W, H, seed, out):
    """在 W×H 里画一幕洞穴。所有元素坐标都按比例算，两种画幅共用同一套语汇。"""
    rnd = random.Random(seed)
    S = W / 240.0                      # 以 240 宽为基准的缩放
    img = Image.new('RGB', (W, H), (10, 12, 20))
    d = ImageDraw.Draw(img)

    # ---------- 1. 后墙 ----------
    for y in range(H):
        t = y / float(H)
        base = lerp((24, 27, 40), (40, 46, 64), t * 0.75)
        for x in range(W):
            n = rnd.randint(-6, 6)
            img.putpixel((x, y), (max(0, base[0]+n), max(0, base[1]+n), max(0, base[2]+n)))

    # ---------- 2. 水平层理 + 裂纹 ----------
    for y0 in range(int(26*S), H, int(30*S)):
        shade = lerp((20, 23, 34), (48, 54, 74), rnd.random())
        for x in range(0, W, max(2, int(3*S))):
            h = int(rnd.randint(2, 5) * S)
            d.rectangle([x, y0 + rnd.randint(-2, 2), x + int(rnd.randint(1,3)*S), y0 + h], fill=shade)
    for _ in range(int(7 * W / 240.0) + 2):
        x0 = rnd.randint(int(8*S), W - int(8*S)); y0 = rnd.randint(0, int(H*0.5))
        for k in range(rnd.randint(14, 30)):
            xx = x0 + int(math.sin(k * 0.4) * 2 * S); yy = y0 + k * int(2*S)
            if 0 <= xx < W and 0 <= yy < H:
                d.point((xx, yy), fill=(11, 13, 21))

    # ---------- 3. 斜坡台地（这一层的关键设定：地板是斜的）----------
    # 横画幅里斜坡放中间偏左，竖画幅里放中间
    if W > H:   # 宽
        l0, l1 = int(W*0.06), int(W*0.42)
        y_top0, y_top1 = int(H*0.52), int(H*0.40)
        r0, r1 = int(W*0.60), W
        ry0, ry1 = int(H*0.62), int(H*0.48)
    else:       # 竖
        l0, l1 = 0, int(W*0.40)
        y_top0, y_top1 = int(H*0.60), int(H*0.545)
        r0, r1 = int(W*0.62), W
        ry0, ry1 = int(H*0.74), int(H*0.66)
    d.polygon([(l0, y_top0), (l1, y_top1), (l1+int(8*S), y_top1+int(10*S)), (l0, y_top0+int(18*S))], fill=(62,70,94))
    d.polygon([(l0, y_top0+int(18*S)), (l1+int(8*S), y_top1+int(10*S)), (l1+int(16*S), y_top1+int(16*S)), (l0, y_top0+int(28*S))], fill=(48,55,76))
    d.line([(l0, y_top0), (l1, y_top1), (l1+int(8*S), y_top1+int(10*S))], fill=(104,116,148), width=max(1,int(S)))
    for _ in range(int(26*W/240.0)):
        tx = rnd.randint(l0, l1); ty = int(y_top0 + (tx-l0)/float(max(1,l1-l0))*(y_top1-y_top0) + rnd.randint(int(3*S), int(14*S)))
        if 0 <= ty < H: d.point((tx, ty), fill=(40,46,64))
    d.polygon([(r0, ry0), (r1, ry1), (r1, ry0+int(40*S))], fill=(62,70,94))
    d.polygon([(r0, ry0+int(8*S)), (r1, ry1+int(8*S)), (r1, ry0+int(48*S))], fill=(48,55,76))
    d.line([(r0, ry0), (r1, ry1)], fill=(104,116,148), width=max(1,int(S)))

    # ---------- 4. 前景岩块 ----------
    fh = int(H*0.86)
    pts = [(int(W*t), fh + rnd.randint(-int(6*S), int(6*S))) for t in (0, .22, .46, .70, 1.0)]
    d.polygon(pts + [(W, H), (0, H)], fill=(30,34,48))
    d.line(pts, fill=(64,72,94), width=max(1,int(S)))

    # ---------- 5. 目标水晶（冷色）----------
    gx, gy = (int(W*0.80), int(H*0.60)) if W > H else (int(W*0.74), int(H*0.615))
    gr = int(26*S)
    for r in range(gr, 0, -1):
        t = 1.0 - r/float(gr)
        d.ellipse([gx-r, gy-r, gx+r, gy+r], fill=lerp((22,34,40), (120,232,226), t**2.2))
    h = int(15*S); w2 = int(9*S)
    d.polygon([(gx, gy-h), (gx+w2, gy-int(3*S)), (gx+int(4*S), gy+int(14*S)), (gx-int(4*S), gy+int(14*S)), (gx-w2, gy-int(3*S))], fill=(186,250,246))
    d.polygon([(gx, gy-h), (gx+w2, gy-int(3*S)), (gx, gy+int(3*S))], fill=(240,255,254))
    d.polygon([(gx-w2, gy-int(3*S)), (gx-int(4*S), gy+int(14*S)), (gx, gy+int(3*S))], fill=(120,214,210))

    # ---------- 6. 火把（暖光）----------
    fx, fy = (int(W*0.24), int(H*0.47)) if W > H else (int(W*0.24), int(H*0.47))
    glow = Image.new('RGB', (W, H), (0,0,0)); gd = ImageDraw.Draw(glow)
    gr2 = int(96*S)
    for r in range(gr2, 0, -1):
        t = 1.0 - r/float(gr2)
        gd.ellipse([fx-r, fy-r, fx+r, fy+r], fill=(int(255*t**1.5), int(158*t**2.0), int(66*t**2.5)))
    glow = glow.filter(ImageFilter.GaussianBlur(3*S))
    px = img.load(); gp = glow.load()
    for y in range(H):
        for x in range(W):
            a = gp[x, y]
            if a != (0,0,0):
                b2 = px[x, y]
                px[x, y] = (min(255,b2[0]+a[0]), min(255,b2[1]+a[1]), min(255,b2[2]+a[2]))
    d = ImageDraw.Draw(img)
    d.ellipse([fx-int(6*S), fy-int(8*S), fx+int(6*S), fy+int(6*S)], fill=(255,190,88))
    d.ellipse([fx-int(3*S), fy-int(5*S), fx+int(3*S), fy+int(2*S)], fill=(255,248,220))

    # ---------- 7. 角色剪影（站在斜坡上）----------
    if W > H:
        cx = int(l1*0.74); cy = int(y_top1 + (y_top0-y_top1)*0.5) + int(6*S)
    else:
        cx = int(W*0.40); cy = int(H*0.575)
    d.ellipse([cx-int(4*S), cy-int(15*S), cx+int(4*S), cy-int(6*S)], fill=(16,19,29))
    d.rectangle([cx-int(5*S), cy-int(4*S), cx+int(5*S), cy+int(5*S)], fill=(16,19,29))
    d.rectangle([cx-int(4*S), cy+int(5*S), cx-int(2*S), cy+int(12*S)], fill=(16,19,29))
    d.rectangle([cx-int(2*S), cy+int(4*S), cx, cy+int(11*S)], fill=(20,24,35))
    d.line([(cx-int(4*S), cy-int(14*S)), (cx+int(3*S), cy-int(13*S))], fill=(198,150,86), width=max(1,int(S)))

    # ---------- 8. 尘埃 ----------
    for _ in range(int(46*W/240.0)):
        x = rnd.randint(0, W-1); y = rnd.randint(int(H*0.12), int(H*0.88))
        if math.hypot(x-fx, y-fy) < 70*S and rnd.random() < 0.7:
            b2 = px[x, y]; px[x, y] = (min(255,b2[0]+40), min(255,b2[1]+26), min(255,b2[2]+8))

    # ---------- 9. 暗角（轻）----------
    vig = Image.new('L', (W, H), 0); vd = ImageDraw.Draw(vig)
    R = int(max(W, H) * 0.78)
    for r in range(R, 0, -1):
        t = r / float(R)
        vd.ellipse([W/2-r, H/2-r*1.06, W/2+r, H/2+r*1.06], fill=int(255*min(1.0, (1-t)**0.5*1.3)))
    vig = vig.filter(ImageFilter.GaussianBlur(12*S))
    out_img = Image.composite(img, Image.new('RGB',(W,H),(14,16,24)), vig)
    out_img = out_img.resize((W*3, H*3), Image.NEAREST)
    out_img.save(out)
    print(out, out_img.size)

make(240, 320, 20261102, '/Users/junshengwu/fishHarness/docs/assets/cover-floor38.png')      # 3:4 竖（小红书）
make(320, 168, 20261103, '/Users/junshengwu/fishHarness/docs/assets/cover-floor38-wide.png') # 40:21 横（其余）
