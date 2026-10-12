"""Rasterbild (Scan/Foto/Bild-PDF) -> Zeichnungs-Zwischenformat.
OpenCV-Pipeline: Binarisieren, Entrauschen, OCR (Tesseract), Strichstärken-Klassifikation (Opening),
Maßpfeil-Entfernung, Ansichtssegmentierung (Zusammenhangskomponenten), Konturverfolgung + Ausgleich
durch Geraden/Kreisbögen/Kreise/Splines, Strichlinien-Erkennung (verdeckte Kanten), Maßstab per Maßzahl-Abgleich."""
import math, re
import numpy as np
import cv2
import pytesseract
from skimage.morphology import skeletonize
from sketch import Prim, arc_from_3pts, ReconError
from vector_in import SCALE_RE

NUMTOK = re.compile(r"(Ø)?\s*(\d+(?:[.,]\d+)?)")


def norm_ocr(t):
    t = t.strip()
    t = re.sub(r"^[@©®⌀Q¢]", "Ø", t)
    t = re.sub(r"(?<![\w])[@©®⌀¢](?=\d)", "Ø", t)
    t = re.sub(r"(?<![\w,.])[Oo](?=\d)", "Ø", t)
    t = re.sub(r"(?<![\w,.])0(?=[1-9]\d)", "Ø", t)
    t = t.replace("—", "-").replace("–", "-")
    return t


def ocr(gray, u, H, W):
    """Liefert Phrasen (Zeilen) in Blatt-mm (y nach oben) und Wort-Boxen (px) für die Textmaske."""
    phrases, boxes = [], []
    for rot in (0, -1):
        img = gray if rot == 0 else np.ascontiguousarray(np.rot90(gray, -1))
        d = pytesseract.image_to_data(img, lang="deu+eng", config="--psm 11", output_type=pytesseract.Output.DICT)
        groups = {}
        for i, t in enumerate(d["text"]):
            if not t.strip(): continue
            conf = float(d["conf"][i])
            x, y, w, h = d["left"][i], d["top"][i], d["width"][i], d["height"][i]
            if h > 0.03 * img.shape[0]: continue
            if rot == 0:
                bx = (x, y, x + w, y + h)
            else:  # gedrehtes Bild: (xr, yr) -> Original (x = yr, y = H-1-xr)
                bx = (y, H - 1 - (x + w), y + h, H - 1 - x)
            if conf > 50 and re.search(r"[A-Za-z0-9ØÄÖÜäöüß°±]", t): boxes.append(bx)
            if conf < (40 if rot == 0 else 40): continue
            if rot != 0 and not re.search(r"\d", t): continue
            key = (d["block_num"][i], d["par_num"][i], d["line_num"][i])
            groups.setdefault(key, []).append((x, t, bx))
        for g in groups.values():
            g.sort(key=lambda z: z[0])
            text = norm_ocr(" ".join(z[1] for z in g))
            x0 = min(z[2][0] for z in g); y0 = min(z[2][1] for z in g); x1 = max(z[2][2] for z in g); y1 = max(z[2][3] for z in g)
            if rot != 0 and not re.search(r"\d", text): continue
            ph = dict(text=text, lo=(x0 * u, (H - y1) * u), hi=(x1 * u, (H - y0) * u), x=(x0 + x1) / 2 * u,
                      y=(H - (y0 + y1) / 2) * u, vertikal=rot != 0)
            if rot != 0 and any(abs(p["x"] - ph["x"]) < 3 and abs(p["y"] - ph["y"]) < 3 for p in phrases): continue
            phrases.append(ph)
    return phrases, boxes


def disk(d):
    d = max(1, int(round(d))); return cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (d, d))


def fit_circle(P):
    x, y = P[:, 0], P[:, 1]
    A = np.c_[2 * x, 2 * y, np.ones(len(P))]
    sol = np.linalg.lstsq(A, x * x + y * y, rcond=None)[0]
    c = sol[:2]; r = math.sqrt(max(sol[2] + c @ c, 1e-12))
    rms = float(np.sqrt(np.mean((np.linalg.norm(P - c, axis=1) - r) ** 2)))
    return c, r, rms


def fit_contour(cnt, u, H, px_eps=0.8, short_mm=3.5):
    """Geschlossene Pixelkontur -> Liste geschlossener Primitive (Blatt-mm)."""
    C = cnt.reshape(-1, 2).astype(float)
    P = np.c_[C[:, 0] * u, (H - C[:, 1]) * u]
    n = len(P)
    if n < 8: return []
    c, r, rms = fit_circle(P)
    if rms < max(0.06, 0.012 * r) and r > 0.5:
        ang = np.unwrap(np.arctan2(P[:, 1] - c[1], P[:, 0] - c[0]))
        if abs(ang[-1] - ang[0]) > 1.9 * math.pi:
            return [Prim("circle", center=tuple(c), r=r)]
    ap = cv2.approxPolyDP(cnt, px_eps, True).reshape(-1, 2)
    lut = {(int(a), int(b)): i for i, (a, b) in reversed(list(enumerate(C.astype(int))))}
    idx = sorted(set(lut[(int(a), int(b))] for a, b in ap if (int(a), int(b)) in lut))
    if len(idx) < 3: return []
    segs = []
    for k in range(len(idx)):
        i0, i1 = idx[k], idx[(k + 1) % len(idx)]
        span = list(range(i0, i1 + 1)) if i1 > i0 else list(range(i0, n)) + list(range(0, i1 + 1))
        L = np.linalg.norm(P[span[-1]] - P[span[0]])
        segs.append(dict(span=span, L=L, short=L < short_mm))
    # bei einem langen Segment beginnen
    start = next((k for k, s in enumerate(segs) if not s["short"]), None)
    if start is None:
        return [Prim("spline", poly=[tuple(p) for p in P[::max(1, n // 60)]] + [tuple(P[0])])]
    segs = segs[start:] + segs[:start]
    # Läufe kurzer Segmente zusammenfassen
    els = []
    for s in segs:
        if s["short"] and els and els[-1]["typ"] == "run":
            els[-1]["span"] += s["span"][1:]; els[-1]["n"] += 1
        elif s["short"]:
            els.append(dict(typ="run", span=list(s["span"]), n=1))
        else:
            els.append(dict(typ="line", span=list(s["span"])))
    for e in els:
        if e["typ"] == "run":
            if e["n"] == 1:
                e["typ"] = "line"; continue
            Q = P[e["span"]]
            # erst Geradentest (Rauschen auf geraden Kanten)
            cen = Q.mean(0); _, sv, vt = np.linalg.svd(Q - cen)
            if sv[-1] / math.sqrt(len(Q)) < 0.05:
                e["typ"] = "line"; continue
            c, r, rms = fit_circle(Q)
            chord = np.linalg.norm(Q[-1] - Q[0])
            if rms < max(0.05, 0.03 * r) and r < 300 and chord < 2.05 * r:
                e.update(typ="arc", c=c, r=r)
            else:
                e["typ"] = "spline"
    # kollineare Nachbar-Geraden zusammenfassen
    def ldir(e):
        d = P[e["span"][-1]] - P[e["span"][0]]; return d / (np.linalg.norm(d) + 1e-12)
    merged = []
    for e in els:
        if merged and e["typ"] == "line" and merged[-1]["typ"] == "line" and abs(cross2_(ldir(merged[-1]), ldir(e))) < 0.035 and ldir(merged[-1]) @ ldir(e) > 0:
            merged[-1]["span"] += e["span"][1:]
        else:
            merged.append(e)
    if len(merged) > 1 and merged[0]["typ"] == "line" and merged[-1]["typ"] == "line" and abs(cross2_(ldir(merged[-1]), ldir(merged[0]))) < 0.035 and ldir(merged[-1]) @ ldir(merged[0]) > 0:
        merged[0]["span"] = merged[-1]["span"] + merged[0]["span"][1:]; merged.pop()
    els = merged
    # Mini-Bögen/-Splines an Ecken (Rasterrauschen) zwischen zwei Geraden -> scharfe Ecke
    m = len(els)
    keep = []
    for k, e in enumerate(els):
        prv, nxt = els[k - 1], els[(k + 1) % m]
        chord = np.linalg.norm(P[e["span"][-1]] - P[e["span"][0]])
        if e["typ"] in ("arc", "spline") and prv["typ"] == "line" and nxt["typ"] == "line" and (chord < 1.6 or (e["typ"] == "arc" and e["r"] < 0.9)):
            prv["span"] = prv["span"] + e["span"][1:]  # Ecke wird über Geradenschnitt bestimmt
            continue
        keep.append(e)
    els = keep
    # Geraden ausgleichen
    for e in els:
        if e["typ"] != "line": continue
        Q = P[e["span"]]
        m = max(1, len(Q) // 10)
        Qi = Q[m:-m] if len(Q) > 2 * m + 2 else Q
        vx, vy, x0, y0 = cv2.fitLine(Qi.astype(np.float32), cv2.DIST_L2, 0, 0.01, 0.01).ravel()
        d = np.array([vx, vy]); p0 = np.array([x0, y0])
        ang = math.degrees(math.atan2(d[1], d[0])) % 180
        if min(ang, 180 - ang) < 1.5: d = np.array([1.0, 0.0]); p0 = np.array([Qi[:, 0].mean(), Qi[:, 1].mean()])
        elif abs(ang - 90) < 1.5: d = np.array([0.0, 1.0]); p0 = np.array([Qi[:, 0].mean(), Qi[:, 1].mean()])
        e["d"], e["p"] = d, p0
    # Eckpunkte bestimmen
    m = len(els)
    verts = []
    for k in range(m):
        a, b = els[k], els[(k + 1) % m]
        raw = P[a["span"][-1]]
        if a["typ"] == "line" and b["typ"] == "line":
            A = np.array([a["d"], -b["d"]]).T
            if abs(np.linalg.det(A)) > 1e-3:
                t = np.linalg.solve(A, b["p"] - a["p"]); v = a["p"] + t[0] * a["d"]
                if np.linalg.norm(v - raw) > 1.5: v = raw
            else:
                v = raw
        elif a["typ"] == "line":
            v = a["p"] + ((raw - a["p"]) @ a["d"]) * a["d"]
        elif b["typ"] == "line":
            v = b["p"] + ((raw - b["p"]) @ b["d"]) * b["d"]
        else:
            v = raw
        verts.append(v)
    prims = []
    for k, e in enumerate(els):
        v0, v1 = verts[k - 1], verts[k]
        if np.linalg.norm(v1 - v0) < 1e-6: continue
        if e["typ"] == "line":
            prims.append(Prim("line", pts=[tuple(v0), tuple(v1)]))
        elif e["typ"] == "arc":
            q = P[e["span"][len(e["span"]) // 2]]
            q = e["c"] + (q - e["c"]) / np.linalg.norm(q - e["c"]) * e["r"]
            a = arc_from_3pts(v0, q, v1)
            prims.append(a if a else Prim("line", pts=[tuple(v0), tuple(v1)]))
        else:
            inner = P[e["span"][1:-1]][::3]
            prims.append(Prim("spline", poly=[tuple(v0)] + [tuple(p) for p in inner] + [tuple(v1)]))
    return prims


def cross2_(a, b):
    return float(a[0] * b[1] - a[1] * b[0])


def kmeans1d(x, it=30):
    c1, c2 = np.percentile(x, 20), np.percentile(x, 90)
    for _ in range(it):
        a = np.abs(x - c1) < np.abs(x - c2)
        if a.all() or (~a).all(): break
        c1, c2 = x[a].mean(), x[~a].mean()
    return c1, c2


def dash_lines(thin, u, H):
    """Strichlinien (verdeckte Kanten) aus kurzen, achsparallelen Strichen zusammensetzen."""
    n, lab, st, cen = cv2.connectedComponentsWithStats(thin, 8)
    dashes = []
    for i in range(1, n):
        x, y, w, h, a = st[i]
        Lw, Lh = w * u, h * u
        if 0.7 <= Lw <= 5 and Lh < 1.0: dashes.append(("h", (y + h / 2), x, x + w))
        elif 0.7 <= Lh <= 5 and Lw < 1.0: dashes.append(("v", (x + w / 2), y, y + h))
    lines = []
    for o in ("h", "v"):
        ds = sorted([d for d in dashes if d[0] == o], key=lambda d: (d[1], d[2]))
        used = [False] * len(ds)
        for i, d in enumerate(ds):
            if used[i]: continue
            chain = [d]; used[i] = True
            changed = True
            while changed:
                changed = False
                for j, e in enumerate(ds):
                    if used[j] or abs(e[1] - chain[0][1]) > 0.6 / u: continue
                    lo = min(c[2] for c in chain); hi = max(c[3] for c in chain)
                    if -2.6 / u < e[2] - hi < 2.6 / u or -2.6 / u < lo - e[3] < 2.6 / u:
                        chain.append(e); used[j] = True; changed = True
            if len(chain) < 2: continue
            k = np.mean([c[1] for c in chain]); lo = min(c[2] for c in chain); hi = max(c[3] for c in chain)
            if o == "h": lines.append(Prim("line", pts=[(lo * u, (H - k) * u), (hi * u, (H - k) * u)]))
            else: lines.append(Prim("line", pts=[(k * u, (H - lo) * u), (k * u, (H - hi) * u)]))
    return lines


def read_image(gray, dpi=None):
    msgs = []
    H, W = gray.shape
    dpi_known = bool(dpi)
    u = 25.4 / (dpi or 300)
    if not dpi_known:
        msgs.append("Bild ohne DPI-Angabe – vorläufig 300 dpi angenommen, Maßstab wird über Maßzahlen bestimmt.")
    g = cv2.GaussianBlur(gray, (3, 3), 0)
    _, ink = cv2.threshold(g, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    ink = cv2.morphologyEx(ink, cv2.MORPH_OPEN, np.ones((2, 2), np.uint8))
    n, lab, st, _ = cv2.connectedComponentsWithStats(ink, 8)
    for i in range(1, n):
        if st[i, 4] < 8: ink[lab == i] = 0
    # OCR auf "Nur-Text"-Bild (kleine Komponenten), damit Geometrie die Texterkennung nicht stört
    n, lab, st, _ = cv2.connectedComponentsWithStats(ink, 8)
    small = np.zeros(n, bool)
    for i in range(1, n):
        if max(st[i, 2], st[i, 3]) * u < 5.5 and st[i, 4] > 10: small[i] = True
    txt = np.where(small[lab], 0, 255).astype(np.uint8)
    try:
        phrases, boxes = ocr(txt, u, H, W)
    except pytesseract.TesseractNotFoundError:
        phrases, boxes = [], []; msgs.append("Tesseract-OCR nicht verfügbar – keine Maßtexte gelesen.")
    tmask = np.zeros_like(ink)
    for x0, y0, x1, y1 in boxes:
        cv2.rectangle(tmask, (int(x0) - 3, int(y0) - 3), (int(x1) + 3, int(y1) + 3), 255, -1)
    strong = cv2.dilate(cv2.morphologyEx(ink, cv2.MORPH_OPEN, disk(0.55 / u)), disk(3))
    geo = cv2.bitwise_and(ink, cv2.bitwise_not(cv2.bitwise_and(tmask, cv2.bitwise_not(strong))))
    # Rahmen/Schriftfeld entfernen
    n, lab, st, _ = cv2.connectedComponentsWithStats(geo, 8)
    for i in range(1, n):
        if st[i, 2] > 0.55 * W or st[i, 3] > 0.55 * H: geo[lab == i] = 0
    # Strichstärken
    dt = cv2.distanceTransform((geo > 0).astype(np.uint8), cv2.DIST_L2, 5)
    sk = skeletonize(geo > 0)
    widths = 2 * dt[sk] - 1
    widths = widths[widths > 0.5]
    if len(widths) < 50: raise ReconError("Im Bild wurde keine Liniengeometrie gefunden.")
    c1, c2 = kmeans1d(widths)
    if c2 / max(c1, 0.5) < 1.4:
        msgs.append("WARNUNG: Breite und schmale Linien sind kaum unterscheidbar – Erkennung unsicher.")
    thr = (c1 + c2) / 2
    msgs.append(f"Strichstärken: schmal ≈ {c1 * u:.2f} mm, breit ≈ {c2 * u:.2f} mm (Schwelle {thr * u:.2f} mm)")
    thick = cv2.morphologyEx(geo, cv2.MORPH_OPEN, disk(thr))
    # Maßpfeile / Vollflächen entfernen
    blobs = cv2.morphologyEx(geo, cv2.MORPH_OPEN, disk(1.15 / u))
    blobs_d = cv2.dilate(blobs, disk(0.7 / u))
    thick = cv2.morphologyEx(thick, cv2.MORPH_CLOSE, disk(2))
    # reine Pfeilspitzen-Komponenten entfernen
    n0, lab0, st0, _ = cv2.connectedComponentsWithStats(thick, 8)
    for i in range(1, n0):
        if max(st0[i, 2], st0[i, 3]) * u < 4.5: thick[lab0 == i] = 0
    wth = c2  # px
    thin = cv2.bitwise_and(geo, cv2.bitwise_not(cv2.dilate(thick, disk(wth * 0.8))))
    hidden = dash_lines(thin, u, H)
    # Komponenten -> Ansichten
    n, lab, st, _ = cv2.connectedComponentsWithStats(thick, 8)
    comps = [i for i in range(1, n) if max(st[i, 2], st[i, 3]) * u > 1.5]
    gap = 2.5 / u
    boxes_c = {i: (st[i, 0], st[i, 1], st[i, 0] + st[i, 2], st[i, 1] + st[i, 3]) for i in comps}
    parent = {i: i for i in comps}
    def find(i):
        while parent[i] != i: i = parent[i]
        return i
    for a in comps:
        for b in comps:
            if a < b:
                A, B = boxes_c[a], boxes_c[b]
                if A[0] - gap <= B[2] and B[0] - gap <= A[2] and A[1] - gap <= B[3] and B[1] - gap <= A[3]:
                    parent[find(a)] = find(b)
    groups = {}
    for i in comps: groups.setdefault(find(i), []).append(i)
    thick_prims = []
    for g in groups.values():
        x0 = min(boxes_c[i][0] for i in g); y0 = min(boxes_c[i][1] for i in g)
        x1 = max(boxes_c[i][2] for i in g); y1 = max(boxes_c[i][3] for i in g)
        if max(x1 - x0, y1 - y0) * u < 8: continue
        main = max(g, key=lambda i: st[i, 2] * st[i, 3])
        for i in g:
            bx, by, bw, bh = st[i, :4]; pad = int(wth) + 4
            crop = (lab[max(0, by - pad):by + bh + pad, max(0, bx - pad):bx + bw + pad] == i).astype(np.uint8) * 255
            ox, oy = max(0, bx - pad), max(0, by - pad)
            ff = crop.copy(); mask = np.zeros((ff.shape[0] + 2, ff.shape[1] + 2), np.uint8)
            cv2.floodFill(ff, mask, (0, 0), 128)
            filled = np.where(ff == 128, 0, 255).astype(np.uint8)
            if i == main:
                bd = blobs_d[oy:oy + filled.shape[0], ox:ox + filled.shape[1]]
                filled = cv2.bitwise_and(filled, cv2.bitwise_not(bd))
                region = cv2.erode(filled, disk(wth + 1))
                m3, l3, s3, _ = cv2.connectedComponentsWithStats(region, 4)
                if m3 > 2: region = ((l3 == 1 + int(np.argmax(s3[1:, 4]))) * 255).astype(np.uint8)
            else:
                enc = cv2.bitwise_and(filled, cv2.bitwise_not(crop))
                m2, l2, s2, _ = cv2.connectedComponentsWithStats(enc, 4)
                if m2 < 2: continue
                j = 1 + int(np.argmax(s2[1:, 4]))
                if s2[j, 4] * u * u < 0.5: continue
                region = cv2.dilate((l2 == j).astype(np.uint8) * 255, disk(wth + 1))
            cs, _ = cv2.findContours(region, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
            if not cs: continue
            cnt = max(cs, key=cv2.contourArea) + np.array([ox, oy])
            thick_prims += fit_contour(cnt.astype(np.int32), u, H)
    # Maßstab aus Schriftfeld (OCR)
    full = " ".join(p["text"] for p in phrases)
    m = SCALE_RE.search(full)
    s_txt = float(m.group(1).replace(",", ".")) / float(m.group(2).replace(",", ".")) if m else None
    return dict(kind="raster", thick=thick_prims, thin=[], hidden=hidden, center=[], arrows=[], phrases=phrases,
                scale=1.0, scale_txt=s_txt, dpi_known=dpi_known, scale_src="vorläufig", msgs=msgs,
                page_w=W * u, page_h=H * u, px_mm=u)


def vote_scale(dr, views, values):
    """Maßstab k (Blatt-mm je Modell-mm) per Abgleich geometrischer Längen mit gelesenen Maßzahlen."""
    L = []
    for v in views:
        L += [v["size"][0], v["size"][1]]
        for p in v["prims"]:
            if p.kind == "circle": L.append(2 * p.r)
            elif p.kind == "line":
                d = np.subtract(p.pts[1], p.pts[0])
                if min(abs(d[0]), abs(d[1])) < 0.05: L.append(float(np.linalg.norm(d)))
    L = [x for x in L if x > 3]
    vals = sorted(set(v for v in values if v >= 3))
    def support(k):
        return sum(1 for v in vals if any(abs(l / (v * k) - 1) < 0.012 for l in L))
    cands = [l / v for l in L for v in vals if 0.05 < l / v < 20]
    best, bs = None, -1
    for k in cands:
        s = support(k)
        if s > bs or (s == bs and best is not None and abs(k - 1) < abs(best - 1)): best, bs = k, s
    k0 = dr.get("scale_txt")
    if k0 and support(k0) >= max(2, bs - 1):
        how = "Schriftfeld + DPI" if dr.get("dpi_known") else "Schriftfeld + angenommene 300 dpi"
        return k0, f"{how} (Maßstab {fmt_scale(k0)}, bestätigt durch {support(k0)} Maßzahlen)"
    if best is None or bs < 2:
        k = k0 or 1.0
        return k, "WARNUNG: Maßstab nicht sicher bestimmbar (zu wenige passende Maßzahlen)"
    ratios = [l / v for v in vals for l in L if abs(l / (v * best) - 1) < 0.012]
    k = float(np.median(ratios))
    return k, f"aus {bs} Maßzahlen ermittelt (Faktor {k:.4f} Blatt-mm je mm)"


def fmt_scale(k):
    return f"{k:g}:1" if k >= 1 else f"1:{1 / k:g}"


def snap_geometry(views, k, values):
    k_s = k
    """Radien auf gelesene Ø/R-Werte und Koordinaten auf 0,05-mm-Raster (Modell) einrasten."""
    rv = [v / 2 for v in values] + list(values)
    for v in views:
        for p in v["prims"] + v.get("hidden", []):
            if p.kind == "circle":
                rm = p.r / k
                cand = [r for r in rv if abs(r - rm) < max(0.15, 0.03 * rm)]
                if cand: p.r = min(cand, key=lambda r: abs(r - rm)) * k
    # Koordinaten auf gelesene Längenmaße einrasten (bezogen auf den Ansichtsrand)
    lin = sorted(set(values))
    for v in views:
        for k in (0, 1):
            base = v["lo"][k]
            def snapc(c):
                d = (c - base) / k_s
                for val in lin:
                    if abs(d - val) < 0.6 and abs(d - val) > 1e-9: return base + val * k_s
                return c
            for p in v["prims"] + v.get("hidden", []):
                if p.kind in ("line", "arc"):
                    p.pts = [tuple(snapc(q[i]) if i == k else q[i] for i in (0, 1)) for q in p.pts]
                elif p.kind == "circle":
                    p.center = tuple(snapc(p.center[i]) if i == k else p.center[i] for i in (0, 1))
                elif p.kind == "spline" and hasattr(p, "poly"):
                    f = lambda q: tuple(snapc(q[i]) if i == k else q[i] for i in (0, 1))
                    p.poly = [f(p.poly[0])] + list(p.poly[1:-1]) + [f(p.poly[-1])]
    # Achsparallele Kanten über Ansichten hinweg ausrichten (x/y-Koordinaten clustern)
    for axis in (0, 1):
        def ends(p):
            if p.kind in ("line", "arc"): return list(p.pts)
            if p.kind == "spline" and hasattr(p, "poly"): return [p.poly[0], p.poly[-1]]
            return []
        coords = []
        for v in views:
            for p in v["prims"] + v.get("hidden", []):
                coords += [q[axis] for q in ends(p)]
        coords = sorted(coords)
        clusters = []
        for c in coords:
            if clusters and c - clusters[-1][-1] < 0.25 * k: clusters[-1].append(c)
            else: clusters.append([c])
        cmap = {}
        for cl in clusters:
            m = float(np.mean(cl))
            for c in cl: cmap[c] = m
        for v in views:
            for p in v["prims"] + v.get("hidden", []):
                f = lambda q: tuple(cmap.get(q[a], q[a]) if a == axis else q[a] for a in (0, 1))
                if p.kind in ("line", "arc"): p.pts = [f(q) for q in p.pts]
                elif p.kind == "spline" and hasattr(p, "poly"):
                    p.poly = [f(p.poly[0])] + list(p.poly[1:-1]) + [f(p.poly[-1])]
