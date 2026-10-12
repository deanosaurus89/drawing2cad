"""Vektor-PDF einlesen -> Zeichnungs-Zwischenformat."""
import math, re
import numpy as np
import pymupdf
from sketch import Prim, bezier_as_arc, ReconError

PT = 25.4 / 72

SCALE_RE = re.compile(r"(?:Maßstab|Massstab|MaBstab|Scale|M)\s*:?\s*(\d+(?:[.,]\d+)?)\s*:\s*(\d+(?:[.,]\d+)?)")


def is_dashed(d):
    ds = d.get("dashes")
    if not ds: return False
    m = re.match(r"\[(.*)\]", ds.strip())
    return bool(m and m.group(1).strip())


def pdf_is_raster(path):
    doc = pymupdf.open(path); page = doc[0]
    n = len([d for d in page.get_drawings() if d.get("type") in ("s", "fs")])
    return n < 10 and len(page.get_images()) > 0


def read_pdf(path):
    doc = pymupdf.open(path)
    if len(doc) == 0: raise ReconError("Die PDF-Datei enthält keine Seiten.")
    page = doc[0]
    Hpt = page.rect.height
    conv = lambda p: (p.x * PT, (Hpt - p.y) * PT)
    drawings = page.get_drawings()
    stroked = [d for d in drawings if d.get("type") in ("s", "fs") and d.get("width") is not None]
    if not stroked:
        raise ReconError("Keine Vektorgeometrie gefunden.")
    widths = [d["width"] * PT for d in stroked if not is_dashed(d)]
    wmax = max(widths) if widths else 0
    thr = max(0.55, 0.8 * wmax) if wmax >= 0.55 else 0.8 * wmax
    msgs = []
    if wmax < 0.55:
        msgs.append("Hinweis: Keine breiten Linien (≥0,5 mm) gefunden – Linienarten werden nur relativ unterschieden.")
    pw, ph = page.rect.width * PT, page.rect.height * PT
    thick, thin, hidden, center = [], [], [], []
    for d in stroked:
        prims = []
        for it in d["items"]:
            op = it[0]
            if op == "l":
                prims.append(Prim("line", pts=[conv(it[1]), conv(it[2])]))
            elif op in ("re", "qu"):
                q = it[1] if op == "qu" else pymupdf.Quad(it[1])
                c = [conv(q.ul), conv(q.ur), conv(q.lr), conv(q.ll)]
                prims += [Prim("line", pts=[c[i], c[(i + 1) % 4]]) for i in range(4)]
            elif op == "c":
                b = [conv(p) for p in it[1:5]]
                a = bezier_as_arc(b)
                last = prims[-1] if prims else None
                if a:
                    c, r, sw = a
                    if (last is not None and last.kind == "arc" and np.linalg.norm(np.array(last.center) - c) < 0.05
                            and abs(last.r - r) < 0.05 and np.linalg.norm(np.array(last.pts[1]) - b[0]) < 0.05
                            and np.sign(last.sweep) == np.sign(sw)):
                        last.sweep += sw; last.pts[1] = b[3]
                    else:
                        prims.append(Prim("arc", center=tuple(c), r=r, sweep=sw, pts=[b[0], b[3]]))
                else:
                    if last is not None and last.kind == "spline" and np.linalg.norm(np.array(last.beziers[-1][3]) - b[0]) < 0.05:
                        last.beziers.append(b)
                    else:
                        prims.append(Prim("spline", beziers=[b]))
        out = []
        for p in prims:
            if p.kind == "arc" and abs(abs(p.sweep) - 2 * math.pi) < 0.01:
                p = Prim("circle", center=p.center, r=p.r)
            if p.kind == "line" and np.linalg.norm(np.subtract(p.pts[0], p.pts[1])) < 1e-3:
                continue
            out.append(p)
        dashed = is_dashed(d)
        # Strichpunktlinie (Mittellinie) vs. Strichlinie (verdeckt): langes Strichmuster
        long_dash = False
        if dashed:
            nums = [float(x) for x in re.findall(r"[\d.]+", d["dashes"].split("]")[0])]
            long_dash = len(nums) >= 4 or (nums and max(nums) * PT > 6)
        for p in out:
            lo, hi = p.bbox()
            if (hi[0] - lo[0]) > 0.8 * pw or (hi[1] - lo[1]) > 0.8 * ph:
                continue
            if dashed:
                (center if long_dash else hidden).append(p)
            elif d["width"] * PT >= thr - 1e-6:
                thick.append(p)
            else:
                thin.append(p)
    # Maßpfeile (gefüllte Dreiecke)
    arrows = []
    for d in drawings:
        if d.get("type") != "f": continue
        pts = []
        for it in d["items"]:
            if it[0] == "l": pts += [conv(it[1]), conv(it[2])]
        uniq = []
        for p in pts:
            if not any(np.hypot(p[0] - q[0], p[1] - q[1]) < 0.05 for q in uniq): uniq.append(p)
        if len(uniq) != 3: continue
        P = [np.array(p) for p in uniq]
        angs = []
        for i in range(3):
            a, b = P[(i + 1) % 3] - P[i], P[(i + 2) % 3] - P[i]
            angs.append(math.acos(np.clip(a @ b / np.linalg.norm(a) / np.linalg.norm(b), -1, 1)))
        i = int(np.argmin(angs)); tip = P[i]; base = (P[(i + 1) % 3] + P[(i + 2) % 3]) / 2
        if np.linalg.norm(tip - base) > 6: continue
        dvec = tip - base; arrows.append(dict(tip=tuple(tip), dir=tuple(dvec / np.linalg.norm(dvec))))
    # Texte zeilenweise
    phrases = []
    for b in page.get_text("dict")["blocks"]:
        for ln in b.get("lines", []):
            t = "".join(s["text"] for s in ln["spans"]).strip()
            if not t: continue
            x0, y0, x1, y1 = ln["bbox"]
            phrases.append(dict(text=t, lo=(x0 * PT, (Hpt - y1) * PT), hi=(x1 * PT, (Hpt - y0) * PT),
                                x=(x0 + x1) / 2 * PT, y=(Hpt - (y0 + y1) / 2) * PT, vertikal=abs(ln["dir"][0]) < 0.5))
    full = page.get_text()
    scale, src = 1.0, "Annahme 1:1"
    m = SCALE_RE.search(full)
    if m:
        scale = float(m.group(1).replace(",", ".")) / float(m.group(2).replace(",", ".")); src = "Schriftfeld"
    else:
        msgs.append("Kein Maßstab im Schriftfeld gefunden – nehme 1:1 an.")
    return dict(kind="vektor", thick=thick, thin=thin, hidden=hidden, center=center, arrows=arrows, phrases=phrases,
                scale=scale, scale_src=src, msgs=msgs, page_w=pw, page_h=ph)
