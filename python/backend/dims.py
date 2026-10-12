"""Maßeintragungen: Texte parsen (Längen, Ø, R, Fasen, Winkel, Tiefen, Teilkreis, Toleranzen/Passungen),
Zuordnung zu Maßlinien/Hinweislinien bzw. per Wertabgleich zur Geometrie, und parametrische Änderungen."""
import math, re
import numpy as np
from sketch import Prim

N = r"\d+(?:[.,]\d+)?"
f2 = lambda s: float(s.replace(",", "."))
SKIP = re.compile(r"Benennung|Zeichnungsnr|Werkstoff|Maßstab|MaBstab|Massstab|Projektion|Allgemeintol|ISO|Maße|DN\d|D2C|EN AW|S235|S355|C45", re.I)

# ISO-286-Grenzabmaße (µm) für häufige Passungen: (bis Nennmaß, oberes, unteres)
FITS = {
    "H7": [(3, 10, 0), (6, 12, 0), (10, 15, 0), (18, 18, 0), (30, 21, 0), (50, 25, 0), (80, 30, 0), (120, 35, 0), (180, 40, 0)],
    "H8": [(3, 14, 0), (6, 18, 0), (10, 22, 0), (18, 27, 0), (30, 33, 0), (50, 39, 0), (80, 46, 0), (120, 54, 0), (180, 63, 0)],
    "h6": [(3, 0, -6), (6, 0, -8), (10, 0, -9), (18, 0, -11), (30, 0, -13), (50, 0, -16), (80, 0, -19), (120, 0, -22), (180, 0, -25)],
    "h7": [(3, 0, -10), (6, 0, -12), (10, 0, -15), (18, 0, -18), (30, 0, -21), (50, 0, -25), (80, 0, -30), (120, 0, -35), (180, 0, -40)],
    "g6": [(3, -2, -8), (6, -4, -12), (10, -5, -14), (18, -6, -17), (30, -7, -20), (50, -9, -25), (80, -10, -29), (120, -12, -34), (180, -14, -39)],
    "k6": [(3, 6, 0), (6, 9, 1), (10, 10, 1), (18, 12, 1), (30, 15, 2), (50, 18, 2), (80, 21, 2), (120, 25, 3), (180, 28, 3)],
}


def fit_limits(code, nominal):
    for upto, es, ei in FITS.get(code, []):
        if nominal <= upto: return es / 1000, ei / 1000
    return None


def parse_tol(rest, nominal):
    rest = rest.strip()
    out = {}
    m = re.match(rf"^±\s*({N})", rest)
    if m: v = f2(m.group(1)); return dict(tol_o=v, tol_u=-v)
    m = re.match(rf"^([+-]\s*{N})\s*/?\s*([+-]\s*{N})", rest)
    if m: a, b = f2(m.group(1).replace(" ", "")), f2(m.group(2).replace(" ", "")); return dict(tol_o=max(a, b), tol_u=min(a, b))
    m = re.match(rf"^\+\s*({N})$", rest)
    if m: v = f2(m.group(1)); return dict(tol_o=v, tol_u=-v, hinweis="„+“ als „±“ gelesen (OCR)")
    m = re.match(r"^([A-Za-z]{1,2}\d{1,2})\b", rest)
    if m:
        code = m.group(1); out = dict(passung=code)
        lim = fit_limits(code, nominal)
        if lim: out.update(tol_o=lim[0], tol_u=lim[1])
        return out
    return out


def parse_phrase(text):
    """-> Liste von Maßangaben {typ, wert, ...}."""
    t = text.strip()
    if not t or SKIP.search(t): return []
    out = []
    used = []
    def add(m, **d):
        used.append(m.span()); d["text"] = t; out.append(d)
    cnt = re.search(r"(\d+)\s*[x×]\s*(?=[ØR])", t); n = int(cnt.group(1)) if cnt else 1
    for m in re.finditer(rf"(Langloch|Tasche|Nut)\s*({N})\s*[x×]\s*({N})", t):
        add(m, typ="tasche", wert=f2(m.group(2)), wert2=f2(m.group(3)), name=m.group(1))
    for m in re.finditer(rf"({N})\s*[x×]\s*(\d+)\s*°", t):
        add(m, typ="fase", wert=f2(m.group(1)), winkel=f2(m.group(2)))
    for m in re.finditer(rf"TK\s*Ø?\s*({N})", t):
        add(m, typ="teilkreis", wert=f2(m.group(1)))
    for m in re.finditer(rf"(?<!TK )(?<!TK)Ø\s*({N})(\s*[A-Za-z]{{1,2}}\d{{1,2}}|\s*±\s*{N}|\s*[+-]\s*{N}(?:\s*/?\s*[+-]\s*{N})?)?", t):
        if any(a <= m.start() < b for a, b in used): continue
        v = f2(m.group(1)); d = dict(typ="durchmesser", wert=v, anzahl=n); d.update(parse_tol(m.group(2) or "", v)); add(m, **d)
    for m in re.finditer(rf"(?<![A-Za-z])R\s*({N})", t):
        add(m, typ="radius", wert=f2(m.group(1)), anzahl=n)
    for m in re.finditer(rf"(?<![A-Za-z])T\s*({N})", t):
        if any(a <= m.start() < b for a, b in used): pass
        add(m, typ="tiefe", wert=f2(m.group(1)))
    for m in re.finditer(rf"({N})\s*°", t):
        if any(a <= m.start() < b for a, b in used): continue
        add(m, typ="winkel", wert=f2(m.group(1)))
    if not out:
        m = re.match(rf"^[|\s]*({N})\s*(.*)$", t)
        if m and len(m.group(2)) < 14:
            v = f2(m.group(1)); d = dict(typ="laenge", wert=v); d.update(parse_tol(m.group(2), v))
            if v > 0: d["text"] = t; out.append(d)
    return out


def seg_dist(p, a, b):
    p, a, b = (np.array(x, float) for x in (p, a, b)); d = b - a
    t = np.clip((p - a) @ d / max(d @ d, 1e-12), 0, 1); return float(np.linalg.norm(p - (a + t * d)))


def rect_dist(p, lo, hi):
    dx = max(lo[0] - p[0], 0, p[0] - hi[0]); dy = max(lo[1] - p[1], 0, p[1] - hi[1]); return math.hypot(dx, dy)


def find_annotations(dr):
    """Vektor: Maßlinien (Pfeile an beiden Enden) und Hinweislinien (Pfeil an einem Ende)."""
    tips = [np.array(a["tip"]) for a in dr["arrows"]]
    near_tip = lambda p: any(np.linalg.norm(np.array(p) - t) < 0.4 for t in tips)
    dimlines, leaders = [], []
    for p in dr["thin"]:
        if p.kind != "line": continue
        a, b = p.pts
        ta, tb = near_tip(a), near_tip(b)
        if ta and tb: dimlines.append(p)
        elif ta or tb:
            tip, q = (a, b) if ta else (b, a)
            # Knick/Schulter der Hinweislinie
            sh = [s for s in dr["thin"] if s.kind == "line" and s is not p and np.linalg.norm(np.array(s.pts[0]) - q) < 0.1]
            leaders.append(dict(tip=tip, q=q, shoulder=sh[0] if sh else None))
    return dimlines, leaders


class Ctx:
    """Ansichten + Abbildung Blatt->Modell (je Ansicht und Blattachse: Modellachse, Ursprung, Richtung)."""
    def __init__(self, views, layout, s):
        self.views, self.layout, self.s = views, layout, s

    def amap(self, vi, ax):
        return self.layout["maps"].get(vi, {}).get(ax)

    def to_model(self, vi, ax, c):
        m = self.amap(vi, ax)
        if not m: return None
        A, o, d = m; return A, (c - o) * d / self.s

    def to_page(self, vj, ax, A, val):
        m = self.amap(vj, ax)
        if not m or m[0] != A: return None
        return m[1] + m[2] * val * self.s


def view_of_dimline(views, a, b):
    horiz = abs(a[1] - b[1]) < 0.05
    best = None
    for i, v in enumerate(views):
        if horiz:
            lo, hi = min(a[0], b[0]), max(a[0], b[0])
            if lo < v["lo"][0] - 0.5 or hi > v["hi"][0] + 0.5: continue
            d = max(v["lo"][1] - a[1], a[1] - v["hi"][1], 0)
        else:
            lo, hi = min(a[1], b[1]), max(a[1], b[1])
            if lo < v["lo"][1] - 0.5 or hi > v["hi"][1] + 0.5: continue
            d = max(v["lo"][0] - a[0], a[0] - v["hi"][0], 0)
        if best is None or d < best[0]: best = (d, i)
    return best[1] if best and best[0] < 40 else None


def coord_kind(view, ax, c, tol=0.12):
    """Ist Koordinate c (Blattachse ax) eine Kante/Ecke oder ein Bohrungsmittelpunkt?"""
    k = 0 if ax == "x" else 1
    edge = any(abs(q[k] - c) < tol for p in view["prims"] if p.kind in ("line", "arc") for q in p.pts)
    center = any(abs(p.center[k] - c) < tol for p in view["prims"] if p.kind == "circle")
    return edge, center


def anchor_lin(ctx, vi, ax, a0, a1):
    v = ctx.views[vi]
    lo, hi = sorted((a0, a1))
    e0, c0 = coord_kind(v, ax, lo); e1, c1 = coord_kind(v, ax, hi)
    m0, m1 = ctx.to_model(vi, ax, lo), ctx.to_model(vi, ax, hi)
    if not m0: return None
    A = m0[0]; x0, x1 = sorted((m0[1], m1[1]))
    anc = dict(art="linear", achse=A, m0=x0, m1=x1, ansicht=vi)
    if c1 and not e1 or c0 and not e0:
        # Lagemaß einer Bohrung -> Element verschieben
        mov_lo = c0 and not e0 and not (c1 and not e1)
        mc = m0[1] if mov_lo else m1[1]
        anc.update(modus="verschieben", fest=(m1[1] if mov_lo else m0[1]), bewegt=mc)
    else:
        anc.update(modus="strecken")
    return anc


def anchor_by_value(ctx, d, raster):
    s = ctx.s; v = d["wert"]; tol = (0.015 * v + 0.06) if raster else 0.03
    views = ctx.views; L = ctx.layout
    if d["typ"] == "durchmesser":
        for vi, w in enumerate(views):
            cs = [p for p in w["prims"] if p.kind == "circle" and abs(2 * p.r / s - v) < tol]
            if cs and not (L["typ"] == "dreh" and vi == L.get("kreis") and any(np.linalg.norm(np.array(c.center) - w["c"]) < 0.5 for c in cs)
                           and L.get("profil_radien") and any(abs(r - v / 2) < tol for r in L["profil_radien"])):
                return dict(art="kreis", ansicht=vi, r=v / 2)
        if L["typ"] == "dreh" and any(abs(r - v / 2) < tol for r in L.get("profil_radien", [])):
            r = min(L["profil_radien"], key=lambda r: abs(r - v / 2)); return dict(art="radial", r=r)
        for vi, w in enumerate(views):
            cs = [p for p in w["prims"] if p.kind == "circle" and abs(2 * p.r / s - v) < tol]
            if cs: return dict(art="kreis", ansicht=vi, r=v / 2)
    if d["typ"] == "radius":
        for vi, w in enumerate(views):
            if any(p.kind == "arc" and abs(p.r / s - v) < tol for p in w["prims"]):
                return dict(art="bogen", ansicht=vi, r=v)
    if d["typ"] == "fase":
        for vi, w in enumerate(views):
            for p in w["prims"]:
                if p.kind == "line":
                    dd = np.subtract(p.pts[1], p.pts[0]) / s
                    if abs(abs(dd[0]) - v) < tol and abs(abs(dd[1]) - v) < tol: return dict(art="fase", c=v)
    if d["typ"] == "laenge":
        cands = []
        for vi, w in enumerate(views):
            for ax, k in (("x", 0), ("y", 1)):
                if not ctx.amap(vi, ax): continue
                cs = sorted(set(round(q[k], 2) for p in w["prims"] if p.kind == "line" for q in p.pts) |
                            set(round(p.center[k], 2) for p in w["prims"] if p.kind == "circle"))
                base = w["lo"][k]
                for i, c0 in enumerate(cs):
                    for c1 in cs[i + 1:]:
                        if abs((c1 - c0) / s - v) < tol:
                            pri = (0 if abs(c0 - base) < 0.2 else 1, 0 if L["typ"] != "dreh" or ax == "x" else 1)
                            cands.append((pri, vi, ax, c0, c1))
        if cands:
            cands.sort(key=lambda c: c[0]); _, vi, ax, c0, c1 = cands[0]
            return anchor_lin(ctx, vi, ax, c0, c1)
    if d["typ"] == "teilkreis" and L["typ"] == "dreh" and L.get("kreis") is not None:
        w = views[L["kreis"]]
        if any(p.kind == "circle" and abs(2 * np.linalg.norm(np.array(p.center) - w["c"]) / s - v) < tol for p in w["prims"]):
            return dict(art="teilkreis", r=v / 2)
    if d["typ"] in ("tiefe", "tasche", "winkel"):
        return dict(art="info")
    return None


def associate(dr, ctx):
    phrases = dr["phrases"]
    specs = []  # (phrase_index, spec)
    for i, ph in enumerate(phrases):
        for sp in parse_phrase(ph["text"]):
            specs.append((i, sp))
    dims = []
    used = set()
    raster = dr["kind"] == "raster"
    s = ctx.s
    if not raster:
        dimlines, leaders = find_annotations(dr)
        for dl in dimlines:
            a, b = dl.pts
            horiz = abs(a[1] - b[1]) < 0.05; vert = abs(a[0] - b[0]) < 0.05
            if not (horiz or vert): continue
            best = None
            for k, (pi, sp) in enumerate(specs):
                if k in used or sp["typ"] not in ("laenge", "durchmesser"): continue
                ph = phrases[pi]
                if ph["vertikal"] != vert: continue
                dist = seg_dist((ph["x"], ph["y"]), a, b)
                if dist < 5 and (best is None or dist < best[0]): best = (dist, k)
            if not best: continue
            used.add(best[1]); pi, sp = specs[best[1]]
            vi = view_of_dimline(ctx.views, a, b)
            if vi is None: continue
            ax = "x" if horiz else "y"; k = 0 if horiz else 1
            anc = None
            if sp["typ"] == "durchmesser" and ctx.layout["typ"] == "dreh" and vi == ctx.layout.get("profil") and vert:
                anc = dict(art="radial", r=abs(a[1] - b[1]) / 2 / s)
            else:
                anc = anchor_lin(ctx, vi, ax, a[k], b[k])
            meas = abs(a[k] - b[k]) / s
            dims.append(dict(sp, quelle="Maßlinie", anker=anc, gemessen=round(meas, 3), linie=[a, b]))
        for ld in leaders:
            q = ld["q"]; lo_q = np.array(q)
            best = None
            for k, (pi, sp) in enumerate(specs):
                if k in used: continue
                ph = phrases[pi]
                dist = rect_dist(q, ph["lo"], ph["hi"])
                if ld["shoulder"] is not None:
                    dist = min(dist, rect_dist(ld["shoulder"].pts[1], ph["lo"], ph["hi"]))
                if dist < 4 and (best is None or dist < best[0] - 1e-9): best = (dist, pi)
            if not best: continue
            pi = best[1]
            tip = np.array(ld["tip"])
            # nächstes Geometrieelement an der Pfeilspitze
            near = None
            for vi, w in enumerate(ctx.views):
                for p in w["prims"]:
                    if p.kind in ("circle", "arc"):
                        dd = abs(np.linalg.norm(tip - np.array(p.center)) - p.r)
                    else:
                        dd = min(seg_dist(tip, a, b) for a, b in zip(p.sample()[:-1], p.sample()[1:]))
                    if dd < 2.5 and (near is None or dd < near[0]): near = (dd, vi, p)
            for k, (pj, sp) in enumerate(specs):
                if pj != pi or k in used: continue
                used.add(k)
                anc = None
                if near:
                    _, vi, p = near
                    if sp["typ"] == "durchmesser" and p.kind == "circle":
                        anc = dict(art="kreis", ansicht=vi, r=p.r / s)
                        meas = 2 * p.r / s
                    elif sp["typ"] == "radius" and p.kind == "arc":
                        anc = dict(art="bogen", ansicht=vi, r=p.r / s); meas = p.r / s
                    elif sp["typ"] == "teilkreis":
                        anc = anchor_by_value(ctx, sp, raster); meas = None
                    else:
                        anc = anchor_by_value(ctx, sp, raster) or dict(art="info"); meas = None
                else:
                    anc = anchor_by_value(ctx, sp, raster); meas = None
                dims.append(dict(sp, quelle="Hinweislinie", anker=anc, gemessen=None if meas is None else round(meas, 3), spitze=tuple(tip)))
    for k, (pi, sp) in enumerate(specs):
        if k in used: continue
        anc = anchor_by_value(ctx, sp, raster)
        if raster and anc is None and re.match(r"^8\d{2,}", phrases[pi]["text"]):
            sp2 = dict(sp, typ="durchmesser", wert=f2(phrases[pi]["text"][1:].split()[0]) if re.match(rf"^8({N})", phrases[pi]["text"]) else sp["wert"])
            sp2["wert"] = f2(re.match(rf"^8({N})", phrases[pi]["text"]).group(1))
            a2 = anchor_by_value(ctx, sp2, raster)
            if a2: sp, anc = dict(sp2, hinweis="„8“ als „Ø“ gelesen (OCR)"), a2
        dims.append(dict(sp, quelle="OCR-Text" if raster else "Freitext", anker=anc, gemessen=None))
    # Messwert & Status
    for i, d in enumerate(dims):
        d["id"] = f"M{i + 1}"
        a = d["anker"]
        if d["gemessen"] is None and a:
            if a["art"] == "linear": d["gemessen"] = round(a["m1"] - a["m0"], 3)
            elif a["art"] in ("kreis", "radial", "teilkreis"): d["gemessen"] = round(2 * a["r"], 3)
            elif a["art"] == "bogen": d["gemessen"] = round(a["r"], 3)
            elif a["art"] == "fase": d["gemessen"] = a["c"]
        if a is None: d["status"] = "nicht zugeordnet"
        elif a["art"] == "info": d["status"] = "Hinweis"
        elif d["gemessen"] is not None and abs(d["gemessen"] - d["wert"]) < max(0.05, 0.01 * d["wert"]): d["status"] = "geprüft"
        elif d["gemessen"] is not None: d["status"] = f"Abweichung (Geometrie {d['gemessen']})"
        else: d["status"] = "zugeordnet"
        d["editierbar"] = bool(a) and a["art"] in ("linear", "kreis", "radial", "bogen", "teilkreis", "fase")
        if a and a["art"] == "linear" and a.get("modus") == "verschieben" and d["typ"] != "laenge": d["editierbar"] = False
    return dims


# ----------------------------------------------------------------------------- parametrische Änderungen
def _shift_prim(p, fpt):
    """Punktweise Abbildung mit Sonderbehandlung: Bogen/Kreis werden verschoben, wenn beide Enden gleich verschoben werden."""
    if p.kind == "circle":
        q = p.copy(); q.center = tuple(fpt(p.center)); return q
    if p.kind == "arc":
        n0, n1 = np.array(fpt(p.pts[0])), np.array(fpt(p.pts[1]))
        d0, d1 = n0 - p.pts[0], n1 - p.pts[1]
        q = p.copy(); q.pts = [tuple(n0), tuple(n1)]
        if np.linalg.norm(d0 - d1) < 1e-9: q.center = tuple(np.array(p.center) + d0)
        else:
            from sketch import arc_from_3pts
            sm = p.sample(); mid = np.array(sm[len(sm) // 2]) + (d0 + d1) / 2
            a = arc_from_3pts(n0, mid, n1)
            if a: return a
        return q
    return p.transform(fpt)


def stretch(ctx, A, thr, delta):
    s = ctx.s
    for vi, w in enumerate(ctx.views):
        for ax, k in (("x", 0), ("y", 1)):
            m = ctx.amap(vi, ax)
            if not m or m[0] != A: continue
            pt = m[1] + m[2] * thr * s
            dirn = m[2]
            moving = lambda q: dirn * (q[k] - pt) >= -0.05
            # kurze Bögen (Rundungen), die mit einem Ende im bewegten Bereich liegen, ganz mitnehmen
            extra = []
            for p in w["prims"]:
                if p.kind == "arc" and p.length() < 12 * s and moving(p.pts[0]) != moving(p.pts[1]):
                    extra.append(p.pts[0] if not moving(p.pts[0]) else p.pts[1])
            def f(q, k=k, moving=moving, extra=extra, dirn=dirn):
                q = list(q)
                if moving(q) or any(abs(q[0] - e[0]) < 0.08 and abs(q[1] - e[1]) < 0.08 for e in extra): q[k] += dirn * delta * s
                return tuple(q)
            w["prims"] = [_shift_prim(p, f) for p in w["prims"]]
            w["hidden"] = [_shift_prim(p, f) for p in w["hidden"]]


def move_feature(ctx, A, c, delta, r_guess=None):
    s = ctx.s
    for vi, w in enumerate(ctx.views):
        for ax, k in (("x", 0), ("y", 1)):
            m = ctx.amap(vi, ax)
            if not m or m[0] != A: continue
            pc = m[1] + m[2] * c * s; dp = m[2] * delta * s
            rr = [p.r for p in w["prims"] if p.kind == "circle" and abs(p.center[k] - pc) < 0.12]
            R = max(rr) if rr else (r_guess or 0) * s
            def mv(p):
                q = p.copy()
                if p.kind == "circle":
                    if abs(p.center[k] - pc) < 0.12:
                        c2 = list(p.center); c2[k] += dp; q.center = tuple(c2)
                    return q
                return p
            w["prims"] = [mv(p) for p in w["prims"]]
            nh = []
            for p in w["hidden"]:
                cs = [q[k] for q in p.points()]
                if R and all(pc - R - 0.12 <= x <= pc + R + 0.12 for x in cs) and p.kind == "line" and abs(p.pts[0][k] - p.pts[1][k]) < 0.05:
                    p = p.transform(lambda q: tuple(q[i] + (dp if i == k else 0) for i in (0, 1)))
                nh.append(p)
            w["hidden"] = nh


def hidden_follow(ctx, src_vi, center, r_old, r_new):
    """Verdeckte Kanten einer Bohrung in anderen Ansichten an neuen Radius anpassen."""
    s = ctx.s
    for ax, k in (("x", 0), ("y", 1)):
        m = ctx.amap(src_vi, ax)
        if not m: continue
        A = m[0]; cm = (center[k] - m[1]) * m[2] / s
        for vj, w in enumerate(ctx.views):
            if vj == src_vi: continue
            for ax2, k2 in (("x", 0), ("y", 1)):
                m2 = ctx.amap(vj, ax2)
                if not m2 or m2[0] != A: continue
                for sgn in (-1, 1):
                    old = m2[1] + m2[2] * (cm + sgn * r_old) * s; new = m2[1] + m2[2] * (cm + sgn * r_new) * s
                    nh = []
                    for p in w["hidden"]:
                        if p.kind == "line" and all(abs(q[k2] - old) < 0.12 for q in p.pts):
                            p = p.transform(lambda q, k2=k2, new=new: tuple(new if i == k2 else q[i] for i in (0, 1)))
                        nh.append(p)
                    w["hidden"] = nh


def corner_scale(view, sel, factor):
    """Ausrundungen/Fasen (sel(p)->bool) um den Eckpunkt der Nachbargeraden skalieren."""
    prims = view["prims"]
    moves = {}
    for p in prims:
        if not sel(p): continue
        a, b = np.array(p.pts[0]), np.array(p.pts[1])
        def neigh(pt):
            for q in prims:
                if q is p or q.kind != "line": continue
                for i in (0, 1):
                    if np.linalg.norm(np.array(q.pts[i]) - pt) < 0.08: return np.array(q.pts[1 - i]), np.array(q.pts[i])
            return None
        na, nb = neigh(a), neigh(b)
        if not na or not nb: continue
        da, db = na[1] - na[0], nb[1] - nb[0]
        M = np.array([da, -db]).T
        if abs(np.linalg.det(M)) < 1e-9: continue
        t = np.linalg.solve(M, nb[0] - na[0]); K = na[0] + t[0] * da
        moves[tuple(np.round(a, 4))] = K + (a - K) * factor
        moves[tuple(np.round(b, 4))] = K + (b - K) * factor
        if p.kind == "arc": p.center = tuple(K + (np.array(p.center) - K) * factor); p.r *= factor
    def f(q):
        for k, v in moves.items():
            if np.linalg.norm(np.array(q) - k) < 0.08: return tuple(v)
        return tuple(q)
    out = []
    for p in prims:
        if p.kind in ("line", "arc"):
            q = p.copy(); q.pts = [f(x) for x in p.pts]
            if p.kind == "arc" and sel(p): q.center, q.r = p.center, p.r
            out.append(q)
        else:
            out.append(p)
    view["prims"] = out
    return len(moves) // 2


def radial_edit(ctx, r_old, r_new):
    """Drehteil: Profilradius ändern (inkl. anschließender Fasen/Rundungen) + Kreise der Stirnansicht."""
    L = ctx.layout; s = ctx.s
    P = ctx.views[L["profil"]]; ay = L["achse_y"]
    dr = (r_new - r_old) * s
    moved = set()
    pts = [q for p in P["prims"] if p.kind in ("line", "arc") for q in p.pts]
    for q in pts:
        if abs(abs(q[1] - ay) - r_old * s) < 0.1: moved.add((round(q[0], 3), round(q[1], 3)))
    # kurze Fasen/Rundungen, die an einem verschobenen Punkt hängen, mitnehmen
    for p in P["prims"]:
        if p.kind in ("line", "arc") and p.length() < 4.5:
            k = [(round(q[0], 3), round(q[1], 3)) for q in p.pts]
            if (k[0] in moved) != (k[1] in moved):
                d0 = abs(p.pts[0][1] - ay); d1 = abs(p.pts[1][1] - ay)
                if min(d0, d1) > 0.1 and abs(d0 - d1) < 4.5: moved |= set(k)
    def f(q):
        if (round(q[0], 3), round(q[1], 3)) in moved or any(abs(q[0] - m[0]) < 0.08 and abs(q[1] - m[1]) < 0.08 for m in moved):
            return (q[0], q[1] + (dr if q[1] > ay else -dr))
        return tuple(q)
    old_r = sorted(set(round(abs(m[1] - ay), 3) for m in moved))
    P["prims"] = [_shift_prim(p, f) for p in P["prims"]]
    if L.get("kreis") is not None:
        C = ctx.views[L["kreis"]]
        for p in C["prims"]:
            if p.kind == "circle" and np.linalg.norm(np.array(p.center) - C["c"]) < 0.5 and any(abs(p.r - r) < 0.1 for r in old_r):
                p.r += dr
    L["profil_radien"] = [r + (r_new - r_old) if abs(r - r_old) < 0.02 else r for r in L.get("profil_radien", [])]


def apply_edits(ctx, dims, edits):
    """edits: {dim_id: neuer_wert}. Verändert ctx.views; aktualisiert Anker anderer Maße."""
    log = []
    s = ctx.s
    for d in dims:
        if d["id"] not in edits: continue
        new = float(edits[d["id"]]); old = d["wert"]
        if abs(new - old) < 1e-9: continue
        a = d["anker"]
        if not d.get("editierbar") or not a:
            log.append(f"{d['id']} ({d['text']}): nicht parametrisch änderbar – ignoriert."); continue
        art = a["art"]
        if art == "linear" and a.get("modus") == "strecken":
            delta = new - (a["m1"] - a["m0"])
            thr = a["m1"]; rigid = []
            for e in dims:
                b = e["anker"]
                if e is not d and b and b["art"] == "linear" and b.get("modus") == "strecken" and b["achse"] == a["achse"] \
                        and abs(b["m1"] - a["m1"]) < 0.01 and b["m0"] > a["m0"] + 0.01:
                    thr = min(thr, b["m0"]); rigid.append(e["id"])
            stretch(ctx, a["achse"], thr, delta)
            for e in dims:
                b = e["anker"]
                if b and b["art"] == "linear" and b["achse"] == a["achse"]:
                    for key in ("m0", "m1", "fest", "bewegt"):
                        if key in b and b[key] >= thr - 1e-6 and not (e is d and key == "m0"): b[key] += delta
            log.append(f"{d['id']}: {old} → {new} (Geometrie ab {thr:.2f} mm entlang {a['achse']} verschoben/gestreckt"
                       + (f", {', '.join(rigid)} bleibt erhalten" if rigid else "") + ")")
        elif art == "linear":
            sign = 1 if a["bewegt"] > a["fest"] else -1
            delta = sign * new - (a["bewegt"] - a["fest"])
            move_feature(ctx, a["achse"], a["bewegt"], delta)
            for e in dims:
                b = e["anker"]
                if b and b["art"] == "linear" and b["achse"] == a["achse"]:
                    for key in ("m0", "m1", "bewegt"):
                        if key in b and abs(b[key] - a["bewegt"]) < 1e-6: b[key] += delta
            a["m0"], a["m1"] = sorted((a["fest"], a["bewegt"]))
            log.append(f"{d['id']}: {old} → {new} (Bohrung verschoben)")
        elif art == "kreis":
            w = ctx.views[a["ansicht"]]; r_old = a["r"]; r_new = new / 2
            for p in w["prims"]:
                if p.kind == "circle" and abs(p.r / s - r_old) < 0.05:
                    hidden_follow(ctx, a["ansicht"], p.center, r_old, r_new); p.r = r_new * s
            a["r"] = r_new; log.append(f"{d['id']}: Ø{old} → Ø{new}")
        elif art == "radial":
            radial_edit(ctx, a["r"], new / 2); a["r"] = new / 2; log.append(f"{d['id']}: Ø{old} → Ø{new} (Drehprofil)")
        elif art == "bogen":
            w = ctx.views[a["ansicht"]]; r_old = a["r"]
            n = corner_scale(w, lambda p: p.kind == "arc" and abs(p.r / s - r_old) < 0.05, new / r_old)
            a["r"] = new; log.append(f"{d['id']}: R{old} → R{new} ({n} Rundung(en))")
        elif art == "fase":
            c_old = a["c"]; n = 0
            for w in ctx.views:
                n += corner_scale(w, lambda p: p.kind == "line" and abs(abs(p.pts[1][0] - p.pts[0][0]) / s - c_old) < 0.05
                                  and abs(abs(p.pts[1][1] - p.pts[0][1]) / s - c_old) < 0.05, new / c_old)
            if ctx.layout["typ"] == "dreh" and ctx.layout.get("kreis") is not None:
                pass
            a["c"] = new; log.append(f"{d['id']}: Fase {old} → {new} ({n} Fase(n))")
        elif art == "teilkreis":
            C = ctx.views[ctx.layout["kreis"]]; P = ctx.views[ctx.layout["profil"]]; ay = ctx.layout["achse_y"]
            r_old, r_new = a["r"], new / 2; f = r_new / r_old
            for p in C["prims"]:
                c = np.array(p.center) if p.kind == "circle" else None
                if c is not None and abs(np.linalg.norm(c - C["c"]) / s - r_old) < 0.05:
                    p.center = tuple(C["c"] + (c - C["c"]) * f)
            nh = []
            for p in P["hidden"]:
                if p.kind == "line" and abs(p.pts[0][1] - p.pts[1][1]) < 0.05:
                    dy = p.pts[0][1] - ay
                    hr = [pp.r for pp in C["prims"] if pp.kind == "circle"]
                    if abs(abs(dy) - r_old * s) < max(hr + [0]) + 0.2:
                        sh = (r_new - r_old) * s * (1 if dy > 0 else -1)
                        p = p.transform(lambda q, sh=sh: (q[0], q[1] + sh))
                nh.append(p)
            P["hidden"] = nh
            a["r"] = r_new; log.append(f"{d['id']}: Teilkreis Ø{old} → Ø{new}")
        d["wert_alt"] = old; d["wert"] = new
        d["gemessen"] = new; d["status"] = "geändert"
    return log
