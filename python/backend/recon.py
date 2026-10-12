"""Zeichnung (Vektor-PDF oder Rasterbild) -> 3D-B-Rep mit Formelementen und PMI.
Ablauf: Einlesen -> Ansichten -> Maßstab -> Anordnung (Drehteil / prismatisch, Vorder-/Drauf-/Seitenansicht)
-> Maße zuordnen -> optionale Maßänderungen -> Rekonstruktion -> B-Rep-Analyse, PMI, Export."""
import math, os, json, hashlib, copy
import numpy as np
import cv2
import pymupdf
import cadquery as cq
from OCP.BRepAdaptor import BRepAdaptor_Surface, BRepAdaptor_Curve
from OCP.GeomAbs import (GeomAbs_Plane, GeomAbs_Cylinder, GeomAbs_Cone, GeomAbs_Sphere, GeomAbs_Torus,
                         GeomAbs_BSplineSurface, GeomAbs_BezierSurface, GeomAbs_SurfaceOfExtrusion,
                         GeomAbs_SurfaceOfRevolution, GeomAbs_Line, GeomAbs_Circle, GeomAbs_Ellipse,
                         GeomAbs_BSplineCurve, GeomAbs_BezierCurve)
from sketch import Prim, Graph, ReconError, loop_to_wire, loop_bbox, loop_area, TOL
import vector_in, raster_in, dims as D
import pmi_step


# ----------------------------------------------------------------------------- Einlesen
def load(path):
    ext = os.path.splitext(path)[1].lower()
    if ext == ".pdf":
        if not vector_in.pdf_is_raster(path):
            return vector_in.read_pdf(path)
        page = pymupdf.open(path)[0]
        pix = page.get_pixmap(dpi=300, colorspace=pymupdf.csGRAY)
        gray = np.frombuffer(pix.samples, np.uint8).reshape(pix.height, pix.width).copy()
        dr = raster_in.read_image(gray, 300 * page.rect.width / 72 * 72 / page.rect.width)
        dr["dpi_known"] = True
        dr["msgs"].insert(0, "PDF enthält nur ein Rasterbild (Scan) – Bildverarbeitung + OCR verwendet.")
        dr["msgs"] = [m for m in dr["msgs"] if "ohne DPI" not in m]
        return dr
    from PIL import Image
    im = Image.open(path)
    dpi = im.info.get("dpi")
    dpi = float(dpi[0]) if dpi and dpi[0] and dpi[0] > 30 else None
    gray = np.array(im.convert("L"))
    return raster_in.read_image(gray, dpi)


def cluster_views(prims, gap=3.0, min_size=4.0):
    boxes = [p.bbox() for p in prims]
    parent = list(range(len(prims)))
    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]; i = parent[i]
        return i
    for i in range(len(prims)):
        for j in range(i + 1, len(prims)):
            (a0, a1), (b0, b1) = boxes[i], boxes[j]
            if a0[0] - gap <= b1[0] and b0[0] - gap <= a1[0] and a0[1] - gap <= b1[1] and b0[1] - gap <= a1[1]:
                parent[find(i)] = find(j)
    groups = {}
    for i in range(len(prims)): groups.setdefault(find(i), []).append(i)
    views = []
    for g in groups.values():
        lo = np.min([boxes[i][0] for i in g], 0); hi = np.max([boxes[i][1] for i in g], 0)
        if max(hi - lo) < min_size: continue
        views.append(dict(prims=[prims[i] for i in g], lo=lo, hi=hi))
    changed = True
    while changed:
        changed = False
        for a in views:
            for b in views:
                if a is not b and np.all(a["lo"] >= b["lo"] - 0.01) and np.all(a["hi"] <= b["hi"] + 0.01):
                    b["prims"] += a["prims"]; views.remove(a); changed = True; break
            if changed: break
    for v in views: refresh(v)
    views.sort(key=lambda v: (-v["c"][1], v["c"][0]))
    return views


def refresh(v):
    bb = [p.bbox() for p in v["prims"]]
    v["lo"] = np.min([b[0] for b in bb], 0); v["hi"] = np.max([b[1] for b in bb], 0)
    v["c"] = (v["lo"] + v["hi"]) / 2; v["size"] = v["hi"] - v["lo"]


def assign_hidden(views, hidden):
    for v in views: v["hidden"] = []
    for p in hidden:
        lo, hi = p.bbox()
        for v in views:
            if np.all(lo >= v["lo"] - 1) and np.all(hi <= v["hi"] + 1):
                v["hidden"].append(p); break


# ----------------------------------------------------------------------------- Anordnung
def find_circle_view(views):
    best = None
    for i, v in enumerate(views):
        circles = [p for p in v["prims"] if p.kind == "circle"]
        if len(circles) < 2: continue
        conc = [c for c in circles if np.linalg.norm(np.array(c.center) - v["c"]) < 0.6]
        if len(conc) < 2: continue
        rmax = max(c.r for c in conc)
        if abs(2 * rmax - v["size"][0]) < 1.2 and abs(2 * rmax - v["size"][1]) < 1.2:
            if best is None or len(circles) > best[1]: best = (i, len(circles))
    return best[0] if best else None


def neighbors(views, i, tol=2.0):
    v = views[i]; out = []
    for j, w in enumerate(views):
        if j == i: continue
        row = abs(w["c"][1] - v["c"][1]) < tol or (abs(w["lo"][1] - v["lo"][1]) < tol and abs(w["hi"][1] - v["hi"][1]) < tol) \
            or abs(w["lo"][1] - v["lo"][1]) < tol
        col = abs(w["c"][0] - v["c"][0]) < tol or (abs(w["lo"][0] - v["lo"][0]) < tol and abs(w["hi"][0] - v["hi"][0]) < tol) \
            or abs(w["lo"][0] - v["lo"][0]) < tol
        if row or col: out.append((float(np.linalg.norm(w["c"] - v["c"])), "zeile" if row else "spalte", j))
    return sorted(out)


def detect_layout(views, s):
    ci = find_circle_view(views)
    if ci is not None:
        nb = neighbors(views, ci)
        if not nb: raise ReconError("Drehteil erkannt (konzentrische Kreise), aber keine zugeordnete Profilansicht gefunden.")
        _, rel, pi = nb[0]
        C, P = views[ci], views[pi]
        if rel != "zeile":
            raise ReconError("Drehteil mit senkrechter Achse wird in diesem Prototyp nicht unterstützt (Profil- und Kreisansicht müssen nebeneinander liegen).")
        ay = C["c"][1]
        maps = {pi: {"x": ("X", P["lo"][0], 1), "y": ("R", ay, 1)}, ci: {"x": ("Q", C["c"][0], 1), "y": ("R", ay, 1)}}
        return dict(typ="dreh", profil=pi, kreis=ci, achse_y=ay, maps=maps)
    if len(views) == 1:
        return dict(typ="prisma", F=None, T=0, S=None, maps={0: {"x": ("X", views[0]["lo"][0], 1), "y": ("Y", views[0]["lo"][1], 1)}})
    # Vorderansicht: hat Nachbarn unten (Draufsicht, Projektionsmethode 1) und rechts/links (Seitenansicht)
    best = None
    for i, v in enumerate(views):
        nb = neighbors(views, i)
        below = [j for _, r, j in nb if r == "spalte" and views[j]["c"][1] < v["c"][1]]
        side = [j for _, r, j in nb if r == "zeile"]
        score = (1 if below else 0) + (1 if side else 0) + (0.1 if v["c"][1] > np.mean([w["c"][1] for w in views]) else 0)
        if best is None or score > best[0]: best = (score, i, below, side)
    _, F, below, side = best
    T = below[0] if below else None
    S = side[0] if side else None
    if T is None and S is None:
        # keine ausgerichteten Ansichten -> Ansicht mit den meisten Konturen extrudieren
        k = max(range(len(views)), key=lambda i: sum(p.kind != "line" for p in views[i]["prims"]))
        return dict(typ="prisma", F=None, T=k, S=None, maps={k: {"x": ("X", views[k]["lo"][0], 1), "y": ("Y", views[k]["lo"][1], 1)}})
    Fv = views[F]
    X0 = min(views[i]["lo"][0] for i in (F, T) if i is not None)
    Z0 = min(views[i]["lo"][1] for i in (F, S) if i is not None)
    maps = {F: {"x": ("X", X0, 1), "y": ("Z", Z0, 1)}}
    if T is not None: maps[T] = {"x": ("X", X0, 1), "y": ("Y", views[T]["lo"][1], 1)}
    if S is not None:
        Sv = views[S]
        maps[S] = {"x": ("Y", Sv["hi"][0], -1) if Sv["c"][0] > Fv["c"][0] else ("Y", Sv["lo"][0], 1), "y": ("Z", Z0, 1)}
    return dict(typ="prisma", F=F, T=T, S=S, maps=maps)


# ----------------------------------------------------------------------------- Rekonstruktion
def view_loops(view, tol):
    """Außenkontur + innere Konturen (Schleifen) + Kreise einer Ansicht."""
    g = Graph(view["prims"], tol)
    comps = g.components()
    loops = []
    for c in comps:
        try:
            lp = g.outer_walk(c)
        except ReconError:
            continue
        lo, hi = loop_bbox(lp)
        loops.append(dict(loop=lp, lo=lo, hi=hi, area=loop_area(lp)))
    loops.sort(key=lambda l: -l["area"])
    circles = [p for p in view["prims"] if p.kind == "circle"]
    if not loops and not circles: raise ReconError("Keine geschlossene Kontur in einer Ansicht gefunden.")
    return loops, circles


def pmap(ctx, vi):
    """Blattpunkt -> Modellkoordinaten-Dict der Ansicht."""
    mx, my = ctx.amap(vi, "x"), ctx.amap(vi, "y")
    return lambda p: {mx[0]: (p[0] - mx[1]) * mx[2] / ctx.s, my[0]: (p[1] - my[1]) * my[2] / ctx.s}


def reconstruct_revolve(ctx, msgs):
    L = ctx.layout; s = ctx.s
    P, C = ctx.views[L["profil"]], ctx.views[L["kreis"]]
    ay = L["achse_y"]
    up = clip_upper(P["prims"], ay, ctx.tol)
    xs = [q[0] for p in up for q in (p.p0, p.p1)]
    if not xs: raise ReconError("Profilkontur des Drehteils nicht gefunden.")
    up.append(Prim("line", pts=[(min(xs), ay), (max(xs), ay)]))
    g = Graph(up, ctx.tol)
    comps = g.components()
    if not comps: raise ReconError("Profilkontur des Drehteils nicht geschlossen.")
    loop = g.outer_walk(max(comps, key=len))
    x0 = P["lo"][0]
    f = lambda p: ((p[0] - x0) / s, (p[1] - ay) / s, 0.0)
    wire, kinds = loop_to_wire(loop, f)
    hf = cq.Face.makeFromWires(wire)
    Lx = (P["hi"][0] - x0) / s; R = (P["hi"][1] - ay) / s
    solid = cq.Solid.revolve(hf, 360, cq.Vector(0, 0, 0), cq.Vector(1, 0, 0))
    rv = [abs(v.Y) for v in hf.Vertices() if abs(v.Y) > 0.05]
    rmin = min(rv) if rv else 0
    L["profil_radien"] = sorted(set(round(r, 3) for r in rv))
    feats = [dict(typ="Drehung", text=f"Rotationsprofil aus {len(kinds)} Konturelementen ({kinds.count('line')} Geraden, {kinds.count('arc')} Bögen, {kinds.count('spline')} Splines), Länge {Lx:.2f} mm, Ø max {2*R:.2f} mm")]
    conc = [c for c in C["prims"] if c.kind == "circle" and np.linalg.norm(np.array(c.center) - C["c"]) < 0.6]
    inner = [c for c in conc if c.r / s < rmin - 0.05]
    if inner:
        rb = max(c.r for c in inner) / s
        solid = solid.cut(cq.Solid.makeCylinder(rb, Lx + 2, cq.Vector(-1, 0, 0), cq.Vector(1, 0, 0)))
        feats.append(dict(typ="Bohrung", text=f"Zentrische Durchgangsbohrung Ø{2*rb:.2f} mm"))
    off = [c for c in C["prims"] if c.kind == "circle" and np.linalg.norm(np.array(c.center) - C["c"]) >= 0.6]
    for c in off:
        du, dv = (c.center[0] - C["c"][0]) / s, (c.center[1] - C["c"][1]) / s
        # Tiefe aus verdeckten Kanten der Profilansicht (Linien parallel zur Achse bei Radius dv±r)
        rng = None
        for h in P["hidden"]:
            if h.kind == "line" and abs(h.pts[0][1] - h.pts[1][1]) < 0.05:
                y = (h.pts[0][1] - ay) / s
                if abs(abs(y) - (abs(dv) + c.r / s)) < 0.1 or abs(abs(y) - (abs(dv) - c.r / s)) < 0.1:
                    xs = sorted((h.pts[0][0] - x0) / s for _ in [0] for _ in [0]) if False else sorted([(h.pts[0][0] - x0) / s, (h.pts[1][0] - x0) / s])
                    rng = xs if rng is None else [min(rng[0], xs[0]), max(rng[1], xs[1])]
        a, b = (-1, Lx + 1) if rng is None else (rng[0] - (1 if rng[0] < 0.1 else 0), rng[1] + (1 if rng[1] > Lx - 0.1 else 0))
        solid = solid.cut(cq.Solid.makeCylinder(c.r / s, b - a, cq.Vector(a, du, dv), cq.Vector(1, 0, 0)))
    if off:
        rs = sorted(set(round(2 * c.r / s, 2) for c in off))
        pcd = sorted(set(round(2 * np.linalg.norm(np.array(c.center) - C["c"]) / s, 2) for c in off))
        feats.append(dict(typ="Bohrungsmuster", text=f"{len(off)} achsparallele Bohrungen Ø{'/'.join(map(str, rs))} mm auf Teilkreis Ø{'/'.join(map(str, pcd))} mm"))
    return solid, feats


def clip_upper(prims, yaxis, tol):
    out = []
    for p in prims:
        if p.kind == "line":
            (x0, y0), (x1, y1) = p.pts
            if y0 < yaxis - tol and y1 < yaxis - tol: continue
            if abs(y0 - yaxis) < tol and abs(y1 - yaxis) < tol: continue
            if (y0 - yaxis) * (y1 - yaxis) < 0:
                t = (yaxis - y0) / (y1 - y0); xm = x0 + t * (x1 - x0)
                p = Prim("line", pts=[(xm, yaxis), (x1, y1)] if y1 > yaxis else [(x0, y0), (xm, yaxis)])
            elif abs(y0 - yaxis) < tol: p = Prim("line", pts=[(x0, yaxis), (x1, y1)])
            elif abs(y1 - yaxis) < tol: p = Prim("line", pts=[(x0, y0), (x1, yaxis)])
            out.append(p)
        elif p.kind == "circle":
            continue
        else:
            sm = np.array(p.sample(8))
            if sm[:, 1].min() >= yaxis - tol: out.append(p)
    return out


def depth_range(ctx, vi, lo, hi, dir_axis, sil_range):
    """Tiefenbereich eines Innen-Elements aus verdeckten Kanten der Nachbaransichten."""
    s = ctx.s
    m_view = ctx.layout["maps"][vi]
    shared = {m[0]: (ax, lo_hi) for ax, lo_hi in (("x", (lo[0], hi[0])), ("y", (lo[1], hi[1]))) for m in [m_view[ax]]}
    rng = None
    for vj, mp in ctx.layout["maps"].items():
        if vj == vi: continue
        axes = {mp[a][0]: a for a in ("x", "y")}
        if dir_axis not in axes: continue
        dax = axes[dir_axis]; dk = 0 if dax == "x" else 1
        other = [A for A in axes if A != dir_axis][0]
        if other not in shared: continue
        sax, (plo, phi) = shared[other]
        mlo = (plo - m_view[sax][1]) * m_view[sax][2] / s; mhi = (phi - m_view[sax][1]) * m_view[sax][2] / s
        oax = axes[other]; ok = 0 if oax == "x" else 1
        tgt = sorted(mp[oax][1] + mp[oax][2] * m * s for m in (mlo, mhi))
        for h in ctx.views[vj]["hidden"]:
            if h.kind != "line": continue
            if abs(h.pts[0][ok] - h.pts[1][ok]) > 0.1: continue
            c = h.pts[0][ok]
            if min(abs(c - t) for t in tgt) > 0.3: continue
            vals = sorted((q[dk] - mp[dax][1]) * mp[dax][2] / s for q in h.pts)
            rng = vals if rng is None else [min(rng[0], vals[0]), max(rng[1], vals[1])]
    if rng is None: return None
    a, b = rng
    if ctx.raster:
        # auf Kantenkoordinaten der Nachbaransichten einrasten
        cs = []
        for vj, mp in ctx.layout["maps"].items():
            for ax2, k2 in (("x", 0), ("y", 1)):
                if mp[ax2][0] != dir_axis: continue
                cs += [(q[k2] - mp[ax2][1]) * mp[ax2][2] / s for p in ctx.views[vj]["prims"] if p.kind == "line" for q in p.pts]
        lo_c = [c for c in cs if a - 3.5 <= c <= a + 0.3]; hi_c = [c for c in cs if b - 0.3 <= c <= b + 3.5]
        if lo_c: a = max(lo_c)
        if hi_c: b = min(hi_c)
    if a <= sil_range[0] + 0.2: a = sil_range[0] - 1
    if b >= sil_range[1] - 0.2: b = sil_range[1] + 1
    return a, b


def reconstruct_prism(ctx, msgs):
    L = ctx.layout; s = ctx.s
    roles = [(r, L[r]) for r in ("F", "T", "S") if L.get(r) is not None]
    # Modellausdehnung
    ext = {}
    for r, vi in roles:
        v = ctx.views[vi]; f = pmap(ctx, vi)
        for p in (v["lo"], v["hi"]):
            for A, val in f(p).items():
                lo, hi = ext.get(A, (1e9, -1e9)); ext[A] = (min(lo, val), max(hi, val))
    if len(roles) == 1:
        t = 10.0
        for d in ctx.dims:
            pass
        ext["Z"] = (0.0, t)
        msgs.append(f"WARNUNG: Nur eine Ansicht – Dicke {t} mm angenommen (bitte im Maß-Tabelle prüfen).")
    dirs = {"F": "Y", "T": "Z", "S": "X"}
    feats = []
    solid = None
    info = {}
    for r, vi in roles:
        v = ctx.views[vi]
        loops, circles = view_loops(v, ctx.tol)
        info[r] = (loops, circles)
        if not loops: continue
        dA = dirs[r]; a, b = ext[dA][0] - 1, ext[dA][1] + 1
        f = pmap(ctx, vi)
        def to3(p, val, f=f, dA=dA):
            m = f(p); m[dA] = val; return (m["X"], m["Y"], m["Z"])
        w, kinds = loop_to_wire(loops[0]["loop"], lambda p: to3(p, a))
        dv = {"X": (b - a, 0, 0), "Y": (0, b - a, 0), "Z": (0, 0, b - a)}[dA]
        pr = cq.Solid.extrudeLinear(cq.Face.makeFromWires(w), cq.Vector(*dv))
        solid = pr if solid is None else solid.intersect(pr)
        name = {"F": "Vorderansicht", "T": "Draufsicht", "S": "Seitenansicht"}[r]
        feats.append(dict(typ="Silhouette", text=f"{name}: Umriss mit {len(kinds)} Elementen ({kinds.count('line')} Geraden, {kinds.count('arc')} Bögen, {kinds.count('spline')} Splines) entlang {dA} extrudiert"))
    if solid is None: raise ReconError("Keine Außenkontur gefunden.")
    if len(roles) > 1: feats.insert(0, dict(typ="Verschneidung", text=f"Körper als Schnitt der {len(roles)} extrudierten Ansichts-Umrisse"))
    solid = cq.Solid(solid.Solids()[0].wrapped) if len(solid.Solids()) == 1 else solid
    # Innenelemente
    for r, vi in roles:
        loops, circles = info[r]
        if not loops: continue
        outer = loops[0]; v = ctx.views[vi]; f = pmap(ctx, vi); dA = dirs[r]
        items = [("schleife", l) for l in loops[1:] if np.all(l["lo"] >= outer["lo"] - TOL) and np.all(l["hi"] <= outer["hi"] + TOL)]
        items += [("kreis", c) for c in circles if np.all(np.array(c.center) > outer["lo"]) and np.all(np.array(c.center) < outer["hi"])]
        for kind, it in items:
            if kind == "kreis":
                lo = np.array(it.center) - it.r; hi = np.array(it.center) + it.r
            else:
                lo, hi = it["lo"], it["hi"]
            rng = depth_range(ctx, vi, lo, hi, dA, ext[dA])
            durch = rng is None or (rng[0] < ext[dA][0] and rng[1] > ext[dA][1])
            a, b = (ext[dA][0] - 1, ext[dA][1] + 1) if rng is None else rng
            dv = {"X": cq.Vector(1, 0, 0), "Y": cq.Vector(0, 1, 0), "Z": cq.Vector(0, 0, 1)}[dA]
            if kind == "kreis":
                m = f(it.center); m[dA] = a
                tool = cq.Solid.makeCylinder(it.r / s, b - a, cq.Vector(m["X"], m["Y"], m["Z"]), dv)
                desc = f"Bohrung Ø{2*it.r/s:.2f} mm"
            else:
                def to3(p, val=a, f=f, dA=dA):
                    m = f(p); m[dA] = val; return (m["X"], m["Y"], m["Z"])
                w, k = loop_to_wire(it["loop"], to3)
                tool = cq.Solid.extrudeLinear(cq.Face.makeFromWires(w), dv * (b - a))
                bb = (hi - lo) / s
                desc = ("Langloch" if k.count("arc") >= 2 and k.count("line") <= 2 else "Tasche/Durchbruch") + f" {bb[0]:.1f}×{bb[1]:.1f} mm"
            before = solid.Volume()
            solid = solid.cut(tool)
            if before - solid.Volume() < 1e-3: continue
            tiefe = "durchgehend" if durch else f"Tiefe {b - a - (1 if a < ext[dA][0] else 0) - (1 if b > ext[dA][1] else 0):.2f} mm (aus verdeckten Kanten)"
            feats.append(dict(typ="Ausschnitt", text=f"{desc} in Richtung {dA}, {tiefe}"))
    return solid, feats


# ----------------------------------------------------------------------------- B-Rep-Analyse
def r3(v): return [round(float(x), 3) for x in v]


def face_info(face):
    a = BRepAdaptor_Surface(face.wrapped); t = a.GetType(); d = {}
    if t == GeomAbs_Plane:
        pl = a.Plane(); d = dict(typ="Ebene", typ_en="plane", punkt=r3(pl.Location().Coord()), normale=r3(pl.Axis().Direction().Coord()))
    elif t == GeomAbs_Cylinder:
        c = a.Cylinder(); d = dict(typ="Zylinder", typ_en="cylinder", radius=round(c.Radius(), 3), achse=r3(c.Axis().Direction().Coord()), punkt=r3(c.Location().Coord()))
    elif t == GeomAbs_Cone:
        c = a.Cone(); d = dict(typ="Kegel", typ_en="cone", ref_radius=round(c.RefRadius(), 3), halbwinkel_grad=round(math.degrees(c.SemiAngle()), 3), achse=r3(c.Axis().Direction().Coord()), spitze=r3(c.Apex().Coord()))
    elif t == GeomAbs_Torus:
        c = a.Torus(); d = dict(typ="Torus", typ_en="torus", R=round(c.MajorRadius(), 3), r=round(c.MinorRadius(), 3), achse=r3(c.Axis().Direction().Coord()), zentrum=r3(c.Location().Coord()))
    elif t == GeomAbs_Sphere:
        c = a.Sphere(); d = dict(typ="Kugel", typ_en="sphere", radius=round(c.Radius(), 3))
    elif t in (GeomAbs_BSplineSurface, GeomAbs_BezierSurface):
        b = a.BSpline(); d = dict(typ="B-Spline-Fläche", typ_en="bspline", grad_u=b.UDegree(), grad_v=b.VDegree(), pole=f"{b.NbUPoles()}x{b.NbVPoles()}")
    elif t == GeomAbs_SurfaceOfExtrusion:
        bc = a.BasisCurve(); ct = bc.GetType()
        d = dict(typ="Extrusionsfläche (B-Spline)" if ct == GeomAbs_BSplineCurve else "Extrusionsfläche", typ_en="extrusion", richtung=r3(a.Direction().Coord()))
        if ct == GeomAbs_BSplineCurve:
            b = bc.BSpline(); d.update(grad=b.Degree(), pole=b.NbPoles())
    elif t == GeomAbs_SurfaceOfRevolution:
        d = dict(typ="Rotationsfläche", typ_en="revolution")
    else:
        d = dict(typ="sonstige", typ_en="other")
    d["flaeche_mm2"] = round(face.Area(), 2)
    c = face.Center(); d["zentrum_flaeche"] = r3(c.toTuple())
    return d


def edge_info(edge):
    a = BRepAdaptor_Curve(edge.wrapped); t = a.GetType()
    if t == GeomAbs_Line:
        d = dict(typ="Gerade", typ_en="line")
    elif t == GeomAbs_Circle:
        c = a.Circle(); d = dict(typ="Kreis" if edge.IsClosed() else "Kreisbogen", typ_en="circle", radius=round(c.Radius(), 3), zentrum=r3(c.Location().Coord()), achse=r3(c.Axis().Direction().Coord()))
    elif t == GeomAbs_Ellipse:
        c = a.Ellipse(); d = dict(typ="Ellipse", typ_en="ellipse", a=round(c.MajorRadius(), 3), b=round(c.MinorRadius(), 3))
    elif t in (GeomAbs_BSplineCurve, GeomAbs_BezierCurve):
        b = a.BSpline(); d = dict(typ="B-Spline-Kurve", typ_en="bspline", grad=b.Degree(), pole=b.NbPoles())
    else:
        d = dict(typ="sonstige", typ_en="other")
    d["laenge_mm"] = round(edge.Length(), 3)
    return d


def stable_id(prefix, info, extra=""):
    keys = sorted(k for k in info if k not in ("flaeche_mm2", "laenge_mm"))
    sig = prefix + "|" + "|".join(f"{k}={info[k]}" for k in keys) + extra
    return prefix + hashlib.sha1(sig.encode()).hexdigest()[:8]


def analyse(solid):
    faces, edges = [], []
    seen = set()
    for i, f in enumerate(solid.Faces()):
        info = face_info(f)
        vs, tris = f.tessellate(0.05, 0.2)
        sid = stable_id("F", info)
        while sid in seen: sid += "b"
        seen.add(sid)
        faces.append(dict(id=i, sid=sid, v=[round(c, 4) for p in vs for c in p.toTuple()], t=[k for tri in tris for k in tri], **info))
    for i, e in enumerate(solid.Edges()):
        info = edge_info(e)
        n = 2 if info["typ_en"] == "line" else 48
        pts = [e.positionAt(t).toTuple() for t in np.linspace(0, 1, n)]
        mid = e.positionAt(0.5).toTuple()
        sid = stable_id("K", info, extra=str(r3(mid)))
        while sid in seen: sid += "b"
        seen.add(sid)
        edges.append(dict(id=i, sid=sid, p=[round(c, 4) for p in pts for c in p], mitte=r3(mid), **info))
    return faces, edges


# ----------------------------------------------------------------------------- PMI
AX = {"X": 0, "Y": 1, "Z": 2}


def pmi_items(dims, faces, layout, bbox_c, diag):
    items = []
    def planes_at(A, val):
        k = AX[A]
        return [f for f in faces if f["typ_en"] == "plane" and abs(abs(f["normale"][k]) - 1) < 1e-3 and abs(f["punkt"][k] - val) < 0.05]
    def cyl_axis_at(A, val):
        k = AX[A]
        return [f for f in faces if f["typ_en"] == "cylinder" and abs(f["achse"][k]) < 1e-3 and abs(f["punkt"][k] - val) < 0.05]
    for d in dims:
        a = d["anker"]
        if not a or a["art"] == "info" and d["typ"] not in ("tiefe", "tasche", "winkel"): continue
        refs, typ, note = [], None, ""
        if a["art"] == "linear":
            A = a["achse"] if a["achse"] in AX else ("X" if a["achse"] == "X" else None)
            if A is None: continue
            for val in (a["m0"], a["m1"]):
                ps = planes_at(A, val)
                if ps: refs.append([p["sid"] for p in ps])
                else:
                    cs = cyl_axis_at(A, val)
                    if cs: refs.append([c["sid"] for c in cs]); note = "Bezug auf Bohrungsachse"
            typ = "Abstand"
        elif a["art"] in ("kreis", "radial"):
            cs = [f for f in faces if f["typ_en"] == "cylinder" and abs(f["radius"] - d["wert"] / 2) < 0.05]
            refs = [[c["sid"] for c in cs]] if cs else []; typ = "Durchmesser"
        elif a["art"] == "bogen":
            cs = [f for f in faces if (f["typ_en"] == "torus" and abs(f["r"] - d["wert"]) < 0.05) or (f["typ_en"] == "cylinder" and abs(f["radius"] - d["wert"]) < 0.05)]
            refs = [[c["sid"] for c in cs]] if cs else []; typ = "Radius"
        elif a["art"] == "teilkreis":
            cs = [f for f in faces if f["typ_en"] == "cylinder" and abs(math.hypot(f["punkt"][1], f["punkt"][2]) - d["wert"] / 2) < 0.05]
            refs = [[c["sid"] for c in cs]] if cs else []; typ = "Teilkreis (Lagemaß)"
        elif a["art"] == "fase":
            cs = [f for f in faces if f["typ_en"] == "cone" and abs(f["halbwinkel_grad"] - 45) < 0.5]
            refs = [[c["sid"] for c in cs]] if cs else []; typ = "Fase"
        elif d["typ"] == "tiefe":
            refs = []; typ = "Tiefe"
            for f in faces:
                if f["typ_en"] == "plane":
                    for g in faces:
                        if g["typ_en"] == "cylinder" and abs(math.pi * g["radius"] ** 2 - f["flaeche_mm2"]) < 0.02 * f["flaeche_mm2"]:
                            refs = [[g["sid"]], [f["sid"]]]; break
                if refs: break
        elif d["typ"] == "tasche":
            ps = [f for f in faces if f["typ_en"] == "plane" and abs(f["flaeche_mm2"] - d["wert"] * d.get("wert2", 0)) < 0.02 * d["wert"] * d.get("wert2", 1)]
            refs = [[p["sid"] for p in ps]] if ps else []; typ = "Tasche (Größe)"
        elif d["typ"] == "winkel":
            cs = [f for f in faces if f["typ_en"] == "cone" and (abs(f["halbwinkel_grad"] - d["wert"]) < 0.5 or abs(2 * f["halbwinkel_grad"] - d["wert"]) < 0.5)]
            refs = [[c["sid"] for c in cs]] if cs else []; typ = "Winkel"
        else:
            continue
        ids = [x for grp in refs for x in grp]
        if not ids: continue
        cents = np.array([f["zentrum_flaeche"] for f in faces if f["sid"] in ids])
        m = cents.mean(0); dvec = m - bbox_c
        if np.linalg.norm(dvec) < 1e-6: dvec = np.array([0, 0, 1.0])
        label = m + dvec / np.linalg.norm(dvec) * 0.28 * diag + np.array([0, 0, 0.04 * diag])
        items.append(dict(id="PMI-" + d["id"], masz=d["id"], typ=typ, nennmass=d["wert"], einheit="mm" if typ != "Winkel" else "°",
                          tol_oben=d.get("tol_o"), tol_unten=d.get("tol_u"), passung=d.get("passung"), text=d["text"],
                          bezuege=[dict(rolle=f"Element {i + 1}", flaechen=g) for i, g in enumerate(refs)],
                          hinweis=note, anker_3d=r3(m), label_3d=r3(label)))
    return items


# ----------------------------------------------------------------------------- Exporte
def export_step_ap214(solid, path):
    from OCP.STEPControl import STEPControl_Writer, STEPControl_AsIs
    from OCP.Interface import Interface_Static
    Interface_Static.SetCVal_s("write.step.schema", "AP214IS")
    Interface_Static.SetCVal_s("write.step.unit", "MM")
    w = STEPControl_Writer(); w.Transfer(solid.wrapped, STEPControl_AsIs)
    if w.Write(path) != 1: raise RuntimeError("STEP-Schreiben fehlgeschlagen")
    head = open(path, errors="ignore").read(3000)
    import re
    m = re.search(r"FILE_SCHEMA\s*\(\s*\(\s*'([^']+)'", head)
    return m.group(1) if m else "?"


# ----------------------------------------------------------------------------- Hauptfunktion
def process(path, out_dir, edits=None):
    os.makedirs(out_dir, exist_ok=True)
    dr = load(path)
    msgs = list(dr["msgs"])
    raster = dr["kind"] == "raster"
    if not dr["thick"]:
        raise ReconError("Keine sichtbaren Körperkanten (breite Volllinien) gefunden.")
    views = cluster_views(dr["thick"], gap=3.0 if not raster else 2.0, min_size=4.0 if not raster else 8.0)
    if not views: raise ReconError("Keine Ansichten erkannt.")
    assign_hidden(views, dr["hidden"])
    # Maßstab
    if raster:
        vals = [sp["wert"] for ph in dr["phrases"] for sp in D.parse_phrase(ph["text"]) if sp["typ"] in ("laenge", "durchmesser")]
        s, src = raster_in.vote_scale(dr, views, vals)
        raster_in.snap_geometry(views, s, vals)
        for v in views: refresh(v)
        msgs.append(f"Maßstab: {src}")
        tol = 0.15
    else:
        s, tol = dr["scale"], TOL
        msgs.append(f"Maßstab {raster_in.fmt_scale(s)} ({dr['scale_src']})")
    layout = detect_layout(views, s)
    ctx = D.Ctx(views, layout, s); ctx.tol = tol; ctx.dims = []; ctx.raster = raster
    if layout["typ"] == "dreh":
        # Profilradien vorab (für Wertzuordnung)
        P = views[layout["profil"]]
        layout["profil_radien"] = sorted(set(round(abs(q[1] - layout["achse_y"]) / s, 3) for p in P["prims"] if p.kind in ("line", "arc") for q in p.pts if abs(q[1] - layout["achse_y"]) > 0.05))
    rollen = {}
    if layout["typ"] == "dreh":
        rollen = {layout["profil"]: "Profilansicht", layout["kreis"]: "Stirnansicht (Kreise)"}
    else:
        for r, n in (("F", "Vorderansicht"), ("T", "Draufsicht"), ("S", "Seitenansicht")):
            if layout.get(r) is not None: rollen[layout[r]] = n
    msgs.append(f"{len(views)} Ansicht(en): " + ", ".join(rollen.values()))
    dims = D.associate(dr, ctx); ctx.dims = dims
    log = []
    if edits:
        log = D.apply_edits(ctx, dims, edits)
        for v in views: refresh(v)
    if layout["typ"] == "dreh":
        solid, feats = reconstruct_revolve(ctx, msgs); strategy = "Drehteil (Rotation des Profils)"
    else:
        solid, feats = reconstruct_prism(ctx, msgs)
        strategy = "Prismatisches Teil (" + ("Verschneidung mehrerer Ansichten" if sum(layout.get(r) is not None for r in "FTS") > 1 else "Extrusion") + ")"
    if not solid.isValid():
        try:
            solid = solid.fix()
        except Exception:
            pass
    if not solid.isValid():
        msgs.append("WARNUNG: Das B-Rep ist laut OpenCASCADE nicht gültig.")
    solid = solid.clean() if hasattr(solid, "clean") else solid
    faces, edges = analyse(solid)
    from OCP.Bnd import Bnd_Box
    from OCP.BRepBndLib import BRepBndLib
    box = Bnd_Box(); BRepBndLib.AddOptimal_s(solid.wrapped, box, False, False)
    x0, y0, z0, x1, y1, z1 = box.Get()
    bbc = np.array([(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2]); diag = math.dist((x0, y0, z0), (x1, y1, z1))
    pmi = pmi_items(dims, faces, layout, bbc, diag)
    # Exporte
    files = {}
    schema = export_step_ap214(solid, os.path.join(out_dir, "modell_ap214.step")); files["step"] = "modell_ap214.step"
    cq.exporters.export(cq.Workplane().add(solid), os.path.join(out_dir, "modell.stl"), tolerance=0.02, angularTolerance=0.1); files["stl"] = "modell.stl"
    try:
        assy = cq.Assembly(); assy.add(solid, name="teil", color=cq.Color(0.7, 0.75, 0.82)); assy.save(os.path.join(out_dir, "modell.glb")); files["glb"] = "modell.glb"
    except Exception as ex:
        msgs.append(f"GLB-Export nicht möglich: {ex}")
    pmi_doc = dict(format="drawing2cad-pmi/0.1", einheit="mm", modell="modell_ap214.step",
                   hinweis="Bezüge über stabile Flächen-IDs (Hash aus Flächentyp, Parametern und Schwerpunkt); flaechen[] listet Typ & Parameter.",
                   pmi=pmi, flaechen=[{k: f[k] for k in f if k not in ("v", "t")} for f in faces])
    with open(os.path.join(out_dir, "pmi.json"), "w") as fh: json.dump(pmi_doc, fh, indent=1, ensure_ascii=False)
    files["pmi"] = "pmi.json"
    ap242 = None
    try:
        ap242 = pmi_step.write_ap242(solid, faces, pmi, os.path.join(out_dir, "modell_ap242_pmi.step"))
        files["ap242"] = "modell_ap242_pmi.step"
    except Exception as ex:
        msgs.append(f"AP242-PMI-Export nicht möglich: {type(ex).__name__}: {ex}")
    stats, estats = {}, {}
    for f in faces: stats[f["typ"]] = stats.get(f["typ"], 0) + 1
    for e in edges: estats[e["typ"]] = estats.get(e["typ"], 0) + 1
    view_boxes = [dict(lo=r3(v["lo"]), hi=r3(v["hi"]), rolle=rollen.get(i, "")) for i, v in enumerate(views)]
    for d in dims:
        d.pop("linie", None); d.pop("spitze", None)
        if d["anker"]:
            d["anker"] = {k: (round(float(v), 3) if isinstance(v, (float, np.floating)) else v) for k, v in d["anker"].items()}
    return dict(ok=True, quelle=dr["kind"], strategie=strategy, meldungen=msgs, aenderungen=log, merkmale=feats, massstab=s,
                volumen_mm3=round(solid.Volume(), 1), bbox=r3([x1 - x0, y1 - y0, z1 - z0]), gueltig=bool(solid.isValid()),
                ansichten=view_boxes, page_w=dr["page_w"], page_h=dr["page_h"], masse=dims, pmi=pmi,
                step_schema=schema, ap242=ap242, flaechen=faces, kanten=edges,
                flaechen_statistik=stats, kanten_statistik=estats, dateien=files)
