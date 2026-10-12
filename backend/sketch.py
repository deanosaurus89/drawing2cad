"""2D-Skizzen-Grundlagen: Primitive (Linie, Kreisbogen, Kreis, Spline), Kantengraph, Konturverfolgung,
Umwandlung in OpenCASCADE-Drähte."""
import math
import numpy as np
import cadquery as cq

TOL = 0.08  # mm (Blattkoordinaten)


class ReconError(Exception):
    pass


def cross2(a, b):
    return float(a[0] * b[1] - a[1] * b[0])


class Prim:
    """kind: 'line' (pts=[p0,p1]), 'arc' (center,r,sweep,pts=[p0,p1]), 'circle' (center,r),
    'spline' (beziers=[[p0,p1,p2,p3],...] oder pts=[...] als Polylinie über 'poly')."""
    def __init__(self, kind, **kw):
        self.kind = kind; self.__dict__.update(kw)

    def copy(self):
        q = Prim(self.kind)
        for k, v in self.__dict__.items():
            if k == "kind": continue
            if k == "pts": v = [tuple(p) for p in v]
            elif k == "beziers": v = [[tuple(p) for p in b] for b in v]
            elif k == "poly": v = [tuple(p) for p in v]
            setattr(q, k, v)
        return q

    @property
    def p0(self):
        if self.kind == "spline": return self.beziers[0][0] if hasattr(self, "beziers") else self.poly[0]
        return self.pts[0]

    @property
    def p1(self):
        if self.kind == "spline": return self.beziers[-1][3] if hasattr(self, "beziers") else self.poly[-1]
        return self.pts[1]

    def sample(self, n=24):
        if self.kind == "line":
            return [np.array(self.pts[0], float), np.array(self.pts[1], float)]
        if self.kind in ("arc", "circle"):
            c = np.array(self.center, float)
            if self.kind == "circle":
                a0, sw = 0.0, 2 * math.pi
            else:
                a0 = math.atan2(self.pts[0][1] - c[1], self.pts[0][0] - c[0]); sw = self.sweep
            m = max(8, int(abs(sw) / (2 * math.pi) * 64))
            out = [c + self.r * np.array([math.cos(a0 + sw * i / m), math.sin(a0 + sw * i / m)]) for i in range(m + 1)]
            if self.kind == "arc":
                out[0] = np.array(self.pts[0], float); out[-1] = np.array(self.pts[1], float)
            return out
        if hasattr(self, "poly"):
            return [np.array(p, float) for p in self.poly]
        out = []
        for b in self.beziers:
            B = [np.array(p, float) for p in b]
            for i in range(0 if not out else 1, n + 1):
                t = i / n
                out.append((1 - t) ** 3 * B[0] + 3 * (1 - t) ** 2 * t * B[1] + 3 * (1 - t) * t ** 2 * B[2] + t ** 3 * B[3])
        return out

    def points(self):
        """Alle definierenden Punkte (für Transformationen)."""
        out = []
        if hasattr(self, "pts"): out += list(self.pts)
        if hasattr(self, "center"): out.append(self.center)
        if hasattr(self, "beziers"): out += [p for b in self.beziers for p in b]
        if hasattr(self, "poly"): out += list(self.poly)
        return out

    def transform(self, f):
        q = self.copy()
        if hasattr(q, "pts"): q.pts = [tuple(f(p)) for p in q.pts]
        if hasattr(q, "center"): q.center = tuple(f(q.center))
        if hasattr(q, "beziers"): q.beziers = [[tuple(f(p)) for p in b] for b in q.beziers]
        if hasattr(q, "poly"): q.poly = [tuple(f(p)) for p in q.poly]
        return q

    def bbox(self):
        s = np.array(self.sample(8)); return s.min(0), s.max(0)

    def length(self):
        s = self.sample(16); return float(sum(np.linalg.norm(b - a) for a, b in zip(s[:-1], s[1:])))


def arc_from_3pts(p0, pm, p1):
    """Kreisbogen-Primitive durch drei Punkte."""
    a, b, c = (np.array(p, float) for p in (p0, pm, p1))
    d = 2 * cross2(b - a, c - a)
    if abs(d) < 1e-9: return None
    A = np.array([[b[0] - a[0], b[1] - a[1]], [c[0] - a[0], c[1] - a[1]]]) * 2
    rhs = np.array([b @ b - a @ a, c @ c - a @ a])
    try:
        cen = np.linalg.solve(A, rhs)
    except np.linalg.LinAlgError:
        return None
    r = float(np.linalg.norm(a - cen))
    a0 = math.atan2(*(a - cen)[::-1]); am = math.atan2(*(b - cen)[::-1]); a1 = math.atan2(*(c - cen)[::-1])
    ccw = d > 0
    sw = (a1 - a0) % (2 * math.pi)
    if not ccw: sw = sw - 2 * math.pi
    return Prim("arc", center=tuple(cen), r=r, sweep=sw, pts=[tuple(a), tuple(c)])


def bezier_as_arc(b, rel=0.004):
    p0, p1, p2, p3 = [np.array(p, float) for p in b]
    t0, t3 = p1 - p0, p3 - p2
    if np.linalg.norm(t0) < 1e-9 or np.linalg.norm(t3) < 1e-9:
        return None
    n0, n3 = np.array([-t0[1], t0[0]]), np.array([-t3[1], t3[0]])
    A = np.array([n0, -n3]).T
    if abs(np.linalg.det(A)) < 1e-9:
        return None
    s = np.linalg.solve(A, p3 - p0); c = p0 + s[0] * n0
    r0, r3 = np.linalg.norm(p0 - c), np.linalg.norm(p3 - c)
    mid = 0.125 * (p0 + 3 * p1 + 3 * p2 + p3)
    rm = np.linalg.norm(mid - c)
    if r0 < 1e-6 or abs(r0 - r3) > rel * r0 + 0.01 or abs(rm - r0) > rel * r0 + 0.01 or r0 > 5000:
        return None
    a0 = math.atan2(*(p0 - c)[::-1]); a3 = math.atan2(*(p3 - c)[::-1])
    cross = (p0 - c)[0] * t0[1] - (p0 - c)[1] * t0[0]
    sw = a3 - a0
    if cross > 0:
        while sw <= 0: sw += 2 * math.pi
    else:
        while sw >= 0: sw -= 2 * math.pi
    return c, (r0 + r3) / 2, sw


# ----------------------------------------------------------------------------- Kantengraph
class Graph:
    def __init__(self, prims, tol=TOL):
        self.V = []; self.E = []; self.tol = tol
        lines = [p for p in prims if p.kind != "circle"]
        ends = [np.array(q.p0, float) for q in lines] + [np.array(q.p1, float) for q in lines]
        split = []
        for p in lines:
            if p.kind != "line": split.append(p); continue
            a, b = np.array(p.pts[0], float), np.array(p.pts[1], float); d = b - a; L = np.linalg.norm(d)
            if L < 1e-9: continue
            ts = []
            for e in ends:
                t = np.dot(e - a, d) / L ** 2
                if tol / L < t < 1 - tol / L and abs(cross2(d, e - a)) / L < tol:
                    ts.append(t)
            ts = sorted(set(round(t, 6) for t in ts))
            pts = [a] + [a + t * d for t in ts] + [b]
            for u, v in zip(pts[:-1], pts[1:]):
                if np.linalg.norm(v - u) > tol:
                    split.append(Prim("line", pts=[tuple(u), tuple(v)]))
        seen = []
        for p in split:
            u, v = self.vid(p.p0), self.vid(p.p1)
            smp = p.sample(4); mid = smp[len(smp) // 2]
            if u == v: continue
            if any({uu, vv} == {u, v} and np.linalg.norm(mm - mid) < tol * 2 for uu, vv, mm in seen): continue
            seen.append((u, v, mid))
            self.E.append(dict(u=u, v=v, prim=p, poly=p.sample(), V=self.V))
        self.prune()

    def vid(self, p):
        p = np.array(p, float)
        for i, q in enumerate(self.V):
            if np.linalg.norm(q - p) < self.tol: return i
        self.V.append(p); return len(self.V) - 1

    def prune(self):
        while True:
            deg = {}
            for e in self.E:
                deg[e["u"]] = deg.get(e["u"], 0) + 1; deg[e["v"]] = deg.get(e["v"], 0) + 1
            bad = {i for i, e in enumerate(self.E) if deg[e["u"]] < 2 or deg[e["v"]] < 2}
            if not bad: return
            self.E = [e for i, e in enumerate(self.E) if i not in bad]

    def components(self):
        adj = {}
        for i, e in enumerate(self.E):
            adj.setdefault(e["u"], []).append(i); adj.setdefault(e["v"], []).append(i)
        seen, comps = set(), []
        for start in adj:
            if start in seen: continue
            stack, ce = [start], set(); seen.add(start)
            while stack:
                v = stack.pop()
                for ei in adj[v]:
                    ce.add(ei); e = self.E[ei]; w = e["v"] if e["u"] == v else e["u"]
                    if w not in seen: seen.add(w); stack.append(w)
            comps.append(sorted(ce))
        return comps

    @staticmethod
    def _dir(poly):
        p0 = poly[0]; total = sum(np.linalg.norm(b - a) for a, b in zip(poly[:-1], poly[1:]))
        need = min(1.0, total / 3); acc = 0
        for a, b in zip(poly[:-1], poly[1:]):
            acc += np.linalg.norm(b - a)
            if acc >= need:
                d = b - p0; return math.atan2(d[1], d[0])
        d = poly[-1] - p0; return math.atan2(d[1], d[0])

    def outer_walk(self, comp):
        verts = set()
        for ei in comp: verts |= {self.E[ei]["u"], self.E[ei]["v"]}
        start = min(verts, key=lambda i: (round(self.V[i][1], 3), self.V[i][0]))
        out_dirs = {}
        for ei in comp:
            e = self.E[ei]
            out_dirs.setdefault(e["u"], []).append((ei, False, self._dir(e["poly"])))
            out_dirs.setdefault(e["v"], []).append((ei, True, self._dir(e["poly"][::-1])))
        cur, back, path, first = start, -math.pi / 2, [], None
        for _ in range(4 * len(comp) + 10):
            best = None
            for ei, rev, a in out_dirs[cur]:
                d = (a - back) % (2 * math.pi)
                if d < 1e-6: d = 2 * math.pi
                if path and ei == path[-1][0] and len(out_dirs[cur]) > 1: continue
                if best is None or d < best[0]: best = (d, ei, rev)
            _, ei, rev = best
            if first is not None and (ei, rev) == first and cur == start:
                return [(self.E[i], r) for i, r in path]
            if first is None: first = (ei, rev)
            path.append((ei, rev))
            e = self.E[ei]; poly = e["poly"][::-1] if rev else e["poly"]
            cur = e["u"] if rev else e["v"]
            back = self._dir(poly[::-1])
        raise ReconError("Die Außenkontur einer Ansicht konnte nicht geschlossen verfolgt werden (offene oder überlappende Linien).")


def loop_bbox(loop):
    pts = np.array([q for e, r in loop for q in e["poly"]]); return pts.min(0), pts.max(0)


def loop_area(loop):
    pts = np.array([q for e, r in loop for q in (e["poly"][::-1] if r else e["poly"])])
    x, y = pts[:, 0], pts[:, 1]
    return 0.5 * abs(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1)))


def loop_to_wire(loop, f):
    """loop: [(edge, reversed)] -> cq.Wire. f: Blatt-2D -> Modell-3D (Tupel)."""
    items = []
    for e, rev in loop:
        p = e["prim"]
        poly = [np.array(q) for q in (e["poly"][::-1] if rev else e["poly"])]
        poly[0] = e["V"][e["v"] if rev else e["u"]]; poly[-1] = e["V"][e["u"] if rev else e["v"]]
        if p.kind == "line":
            a, b = poly[0], poly[-1]
            if items and items[-1][0] == "line":
                pa, pb = items[-1][1]; d1, d2 = pb - pa, b - a
                if abs(cross2(d1, d2)) < 1e-6 * np.linalg.norm(d1) * np.linalg.norm(d2) and np.dot(d1, d2) > 0:
                    items[-1] = ("line", [pa, b]); continue
            items.append(("line", [a, b]))
        elif p.kind == "arc":
            items.append(("arc", [poly[0], poly[len(poly) // 2], poly[-1]]))
        else:
            if items and items[-1][0] == "spline":
                items[-1] = ("spline", items[-1][1] + list(poly[1:]))
            else:
                items.append(("spline", list(poly)))
    edges = []
    for k, pts in items:
        P = [cq.Vector(*map(float, f(q))) for q in pts]
        if k == "line":
            edges.append(cq.Edge.makeLine(P[0], P[1]))
        elif k == "arc":
            edges.append(cq.Edge.makeThreePointArc(P[0], P[1], P[2]))
        else:
            idx = np.linspace(0, len(P) - 1, min(len(P), 25)).round().astype(int)
            edges.append(cq.Edge.makeSpline([P[i] for i in sorted(set(idx))]))
    w = cq.Wire.assembleEdges(edges)
    if not w.IsClosed():
        raise ReconError("Kontur ist nicht geschlossen.")
    return w, [k for k, _ in items]
