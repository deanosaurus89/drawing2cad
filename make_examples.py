"""Erzeugt drei Beispiel-Zeichnungen (A3 quer, Maßstab 1:1, Projektionsmethode 1 / ISO 5456-2).
Linienarten nach ISO 128: breite Volllinie 0,7 mm (sichtbare Kanten), schmale Volllinie 0,25 mm
(Maß-/Hilfslinien), Strichlinie (verdeckt), Strichpunktlinie (Mittellinien)."""
import math, pymupdf

MM = 72 / 25.4
W, H = 420, 297

class Drawing:
    def __init__(self, title, number, material):
        self.doc = pymupdf.open()
        self.page = self.doc.new_page(width=W * MM, height=H * MM)
        self.title, self.number, self.material = title, number, material

    def P(self, x, y):
        return pymupdf.Point(x * MM, (H - y) * MM)

    def _finish(self, sh, kind, fill=None):
        style = {
            "thick": dict(width=0.7, dashes=None),
            "thin": dict(width=0.25, dashes=None),
            "frame": dict(width=0.5, dashes=None),
            "hidden": dict(width=0.35, dashes="[%g %g] 0" % (3 * MM, 1.5 * MM)),
            "center": dict(width=0.25, dashes="[%g %g %g %g] 0" % (12 * MM, 1.5 * MM, 1 * MM, 1.5 * MM)),
        }[kind]
        sh.finish(width=style["width"] * MM, color=(0, 0, 0), fill=fill, dashes=style["dashes"], closePath=False)
        sh.commit()

    def line(self, pts, kind="thick"):
        sh = self.page.new_shape()
        for a, b in zip(pts[:-1], pts[1:]):
            sh.draw_line(self.P(*a), self.P(*b))
        self._finish(sh, kind)

    def arc(self, c, r, a0, a1, kind="thick"):
        """Kreisbogen CCW von a0 nach a1 (Grad), als kubische Bezier-Segmente <= 90°."""
        sh = self.page.new_shape()
        n = max(1, math.ceil(abs(a1 - a0) / 90 - 1e-9))
        d = math.radians(a1 - a0) / n
        k = 4 / 3 * math.tan(d / 4)
        for i in range(n):
            t0 = math.radians(a0) + i * d; t1 = t0 + d
            p0 = (c[0] + r * math.cos(t0), c[1] + r * math.sin(t0))
            p3 = (c[0] + r * math.cos(t1), c[1] + r * math.sin(t1))
            p1 = (p0[0] - k * r * math.sin(t0), p0[1] + k * r * math.cos(t0))
            p2 = (p3[0] + k * r * math.sin(t1), p3[1] - k * r * math.cos(t1))
            sh.draw_bezier(self.P(*p0), self.P(*p1), self.P(*p2), self.P(*p3))
        self._finish(sh, kind)

    def circle(self, c, r, kind="thick"):
        self.arc(c, r, 0, 360, kind)

    def bezier(self, p0, p1, p2, p3, kind="thick"):
        sh = self.page.new_shape()
        sh.draw_bezier(self.P(*p0), self.P(*p1), self.P(*p2), self.P(*p3))
        self._finish(sh, kind)

    def text(self, x, y, s, size=3.5, rot=0):
        self.page.insert_text(self.P(x, y), s, fontsize=size * MM * 1.35, fontname="helv", rotate=rot)

    def arrow(self, tip, direction):
        dx, dy = direction; L = math.hypot(dx, dy); dx, dy = dx / L, dy / L
        a, w = 3.0, 0.9
        b = (tip[0] - a * dx, tip[1] - a * dy)
        p1 = (b[0] - w * dy, b[1] + w * dx); p2 = (b[0] + w * dy, b[1] - w * dx)
        sh = self.page.new_shape()
        sh.draw_polyline([self.P(*tip), self.P(*p1), self.P(*p2), self.P(*tip)])
        sh.finish(color=None, fill=(0, 0, 0), width=0, closePath=True); sh.commit()

    def dim_h(self, x0, x1, y_ref0, y_ref1, y, s):
        """Horizontales Maß zwischen x0 und x1, Maßlinie auf Höhe y."""
        for x, yr in ((x0, y_ref0), (x1, y_ref1)):
            self.line([(x, yr + (1.5 if y > yr else -1.5)), (x, y + (2 if y > yr else -2))], "thin")
        self.line([(x0, y), (x1, y)], "thin")
        self.arrow((x0, y), (-1, 0)); self.arrow((x1, y), (1, 0))
        self.text((x0 + x1) / 2 - len(s) * 1.2, y + 1.2, s)

    def dim_v(self, y0, y1, x_ref0, x_ref1, x, s):
        for yy, xr in ((y0, x_ref0), (y1, x_ref1)):
            self.line([(xr + (1.5 if x > xr else -1.5), yy), (x + (2 if x > xr else -2), yy)], "thin")
        self.line([(x, y0), (x, y1)], "thin")
        self.arrow((x, y0), (0, -1)); self.arrow((x, y1), (0, 1))
        self.text(x - 1.2, (y0 + y1) / 2 - len(s) * 1.2, s, rot=90)

    def leader(self, p, q, s):
        self.line([p, q, (q[0] + 4 + len(s) * 2.3, q[1])], "thin")
        d = (p[0] - q[0], p[1] - q[1]); self.arrow(p, d)
        self.text(q[0] + 2, q[1] + 1.2, s)

    def frame_and_title(self, scale="1:1"):
        self.line([(20, 10), (410, 10), (410, 287), (20, 287), (20, 10)], "frame")
        x0, y0 = 230, 10
        self.line([(x0, y0), (x0, y0 + 40), (410, y0 + 40)], "frame")
        for yy in (y0 + 10, y0 + 20, y0 + 30):
            self.line([(x0, yy), (410, yy)], "thin")
        self.line([(320, y0), (320, y0 + 30)], "thin")
        self.text(x0 + 2, y0 + 33, "Benennung: " + self.title, 5)
        self.text(x0 + 2, y0 + 23, "Zeichnungsnr.: " + self.number)
        self.text(322, y0 + 23, "Werkstoff: " + self.material)
        self.text(x0 + 2, y0 + 13, "Maßstab " + scale)
        self.text(322, y0 + 13, "Maße in mm")
        self.text(x0 + 2, y0 + 3, "Projektionsmethode 1")
        self.text(322, y0 + 3, "Allgemeintol. ISO 2768-m")
        # Symbol Projektionsmethode 1 (Kegelstumpf)
        cx, cy = 300, y0 + 5
        self.line([(cx - 9, cy - 2.5), (cx - 9, cy + 2.5), (cx - 1, cy + 4), (cx - 1, cy - 4), (cx - 9, cy - 2.5)], "thin")
        self.circle((cx + 6, cy), 4, "thin"); self.circle((cx + 6, cy), 2.5, "thin")

    def save(self, path):
        self.doc.save(path); print("geschrieben:", path)


def rev_outline(d, x0, yc, prof):
    """Zeichnet Umriss eines Drehteils: prof = Liste von ('L',(x,r)) / ('A',center,r,a0,a1) Elementen der
    oberen Hälfte (relativ). Spiegelt an der Achse. Zusätzlich senkrechte Kantenlinien."""
    for el in prof:
        if el[0] == "L":
            (xa, ra), (xb, rb) = el[1], el[2]
            d.line([(x0 + xa, yc + ra), (x0 + xb, yc + rb)])
            d.line([(x0 + xa, yc - ra), (x0 + xb, yc - rb)])
        else:
            _, (cx, cr), r, a0, a1 = el
            d.arc((x0 + cx, yc + cr), r, a0, a1)
            d.arc((x0 + cx, yc - cr), r, -a1, -a0)


def flange():
    d = Drawing("Flansch DN32", "D2C-001", "S235JR")
    d.frame_and_title()
    # Profil (x axial, r radial): Scheibe 0..16 R70, Fase 2x45°, Nabe 16..36 R30 mit Fase 1,5, Ausrundung R4
    x0, yc = 70, 180
    prof = [
        ("L", (0, 0), (0, 68)), ("L", (0, 68), (2, 70)), ("L", (2, 70), (14, 70)), ("L", (14, 70), (16, 68)),
        ("L", (16, 68), (16, 34)), ("A", (20, 34), 4, 180, 270), ("L", (20, 30), (34.5, 30)),
        ("L", (34.5, 30), (36, 28.5)), ("L", (36, 28.5), (36, 0)),
    ]
    rev_outline(d, x0, yc, prof)
    # Kantenlinien der Fasen (sichtbare Körperkanten)
    for x, r in ((2, 70), (14, 70), (34.5, 30)):
        d.line([(x0 + x, yc - r), (x0 + x, yc + r)])
    # verdeckte Kanten: Bohrung Ø32 und Lochkreis-Bohrungen Ø14 auf Ø110
    for r in (16, -16):
        d.line([(x0, yc + r), (x0 + 36, yc + r)], "hidden")
    for c in (55, -55):
        for r in (7, -7):
            d.line([(x0, yc + c + r), (x0 + 16, yc + c + r)], "hidden")
        d.line([(x0 - 4, yc + c), (x0 + 20, yc + c)], "center")
    d.line([(x0 - 8, yc), (x0 + 44, yc)], "center")
    # Seitenansicht (Projektionsmethode 1: Ansicht von links steht rechts)
    sx = 230
    d.circle((sx, yc), 70); d.circle((sx, yc), 68); d.circle((sx, yc), 30); d.circle((sx, yc), 28.5)
    d.circle((sx, yc), 16)
    for i in range(6):
        a = math.radians(90 + 60 * i)
        d.circle((sx + 55 * math.cos(a), yc + 55 * math.sin(a)), 7)
    d.arc((sx, yc), 55, 0, 360, "center")
    d.line([(sx - 78, yc), (sx + 78, yc)], "center"); d.line([(sx, yc - 78), (sx, yc + 78)], "center")
    # Bemaßung
    d.dim_h(x0, x0 + 16, yc - 70, yc - 68, yc - 85, "16±0,1")
    d.dim_h(x0, x0 + 36, yc - 70, yc - 28.5, yc - 97, "36")
    d.dim_v(yc - 70, yc + 70, x0, x0, x0 - 20, "Ø140")
    d.dim_v(yc - 30, yc + 30, x0 + 36, x0 + 36, x0 + 50, "Ø60")
    d.leader((sx + 16 * math.cos(math.radians(-30)), yc + 16 * math.sin(math.radians(-30))), (sx + 30, yc - 40), "Ø32H7")
    d.leader((sx + 55 * math.cos(math.radians(-30)) + 5, yc + 55 * math.sin(math.radians(-30)) - 3), (sx + 70, yc - 70), "6x Ø14 auf TK Ø110")
    d.leader((x0 + 16.5, yc + 32.5), (x0 + 30, yc + 50), "R4")
    d.text(x0 + 2, yc + 82, "Fase 2x45° / 1,5x45°")
    d.save("examples/01_flansch.pdf")


def shaft():
    d = Drawing("Abtriebswelle", "D2C-002", "C45E")
    d.frame_and_title()
    x0, yc = 60, 190
    # Absätze: Ø30 L40 (Fase 1,5) | Ø40 L60 | Bund Ø50 L15 | Ø35 L35 | Kegel Ø35->Ø25 L30 (Fase 1)
    prof = [
        ("L", (0, 0), (0, 13.5)), ("L", (0, 13.5), (1.5, 15)), ("L", (1.5, 15), (40, 15)), ("L", (40, 15), (40, 20)),
        ("L", (40, 20), (98, 20)), ("A", (98, 22), 2, 270, 360), ("L", (100, 22), (100, 25)),
        ("L", (100, 25), (115, 25)), ("L", (115, 25), (115, 19.5)), ("A", (117, 19.5), 2, 180, 270),
        ("L", (117, 17.5), (150, 17.5)), ("L", (150, 17.5), (180, 12.5)), ("L", (180, 12.5), (180, 11.5)),
        ("L", (180, 11.5), (181, 10.5)), ("L", (181, 10.5), (181, 0)),
    ]
    rev_outline(d, x0, yc, prof)
    for x, r in ((1.5, 15), (40, 20), (100, 25), (115, 25), (150, 17.5), (180, 12.5)):
        d.line([(x0 + x, yc - r), (x0 + x, yc + r)])
    d.line([(x0 - 8, yc), (x0 + 189, yc)], "center")
    # Seitenansicht von links -> rechts
    sx = 320
    for r in (25, 20, 17.5, 15, 13.5):
        d.circle((sx, yc), r)
    d.line([(sx - 32, yc), (sx + 32, yc)], "center"); d.line([(sx, yc - 32), (sx, yc + 32)], "center")
    # Bemaßung
    d.dim_h(x0, x0 + 40, yc - 15, yc - 20, yc - 40, "40")
    d.dim_h(x0 + 40, x0 + 100, yc - 20, yc - 25, yc - 40, "60")
    d.dim_h(x0 + 100, x0 + 115, yc - 25, yc - 25, yc - 40, "15")
    d.dim_h(x0 + 115, x0 + 150, yc - 17.5, yc - 17.5, yc - 40, "35")
    d.dim_h(x0 + 150, x0 + 181, yc - 17.5, yc - 10.5, yc - 40, "31")
    d.dim_h(x0, x0 + 181, yc - 15, yc - 10.5, yc - 55, "181")
    d.dim_v(yc - 15, yc + 15, x0, x0, x0 - 12, "Ø30")
    d.text(x0 + 15, yc + 42, "Ø40")
    d.text(x0 + 102, yc + 42, "Ø50")
    d.text(x0 + 125, yc + 42, "Ø35")
    d.text(x0 + 160, yc + 42, "Ø25")
    d.leader((x0 + 99, yc + 21), (x0 + 85, yc + 60), "R2")
    d.leader((x0 + 116, yc + 18.5), (x0 + 130, yc + 60), "R2")
    d.text(x0, yc + 75, "Fasen 1,5x45° / 1x45°, Kegel 1:6")
    d.save("examples/02_welle.pdf")


def bracket():
    d = Drawing("Halteplatte mit Freiformkontur", "D2C-003", "AlMg3")
    d.frame_and_title()
    # Draufsicht (Projektionsmethode 1: unter der Vorderansicht), Ursprung links unten
    ox, oy = 60, 60
    T = 12
    pts = lambda *ps: [(ox + x, oy + y) for x, y in ps]
    d.line(pts((10, 0), (130, 0)))
    d.arc((ox + 130, oy + 10), 10, 270, 360)
    d.line(pts((140, 10), (140, 45)))
    # Freiformkontur (kubische Bezier = B-Spline) von (140,45) nach (40,100)
    d.bezier(*pts((140, 45), (140, 85), (90, 65), (60, 100)))
    d.bezier(*pts((60, 100), (55, 106), (48, 110), (40, 110)))
    d.line(pts((40, 110), (10, 110)))
    d.arc((ox + 10, oy + 100), 10, 90, 180)
    d.line(pts((0, 100), (0, 10)))
    d.arc((ox + 10, oy + 10), 10, 180, 270)
    # Bohrungen und Langloch
    holes = [(20, 20), (120, 20), (20, 90)]
    for hx, hy in holes:
        d.circle((ox + hx, oy + hy), 5)
        d.line([(ox + hx - 8, oy + hy), (ox + hx + 8, oy + hy)], "center")
        d.line([(ox + hx, oy + hy - 8), (ox + hx, oy + hy + 8)], "center")
    # Langloch 40x12 (Mitte 50..80, y=45)
    d.line(pts((50, 39), (80, 39))); d.line(pts((80, 51), (50, 51)))
    d.arc((ox + 80, oy + 45), 6, 270, 450); d.arc((ox + 50, oy + 45), 6, 90, 270)
    d.line([(ox + 40, oy + 45), (ox + 90, oy + 45)], "center")
    # Vorderansicht (oberhalb)
    fy = 200
    d.line([(ox, fy), (ox + 140, fy), (ox + 140, fy + T), (ox, fy + T), (ox, fy)])
    for hx, _ in holes:
        d.line([(ox + hx - 5, fy), (ox + hx - 5, fy + T)], "hidden")
        d.line([(ox + hx + 5, fy), (ox + hx + 5, fy + T)], "hidden")
    for x in (44, 86):
        d.line([(ox + x, fy), (ox + x, fy + T)], "hidden")
    # Seitenansicht von links -> rechts neben Vorderansicht (Tiefe 110)
    sx = 260
    d.line([(sx, fy), (sx + 110, fy), (sx + 110, fy + T), (sx, fy + T), (sx, fy)])
    for hy in (20, 90):
        d.line([(sx + 110 - hy - 5, fy), (sx + 110 - hy - 5, fy + T)], "hidden")
        d.line([(sx + 110 - hy + 5, fy), (sx + 110 - hy + 5, fy + T)], "hidden")
    # Bemaßung
    d.dim_h(ox, ox + 140, oy, oy + 10, oy - 18, "140")
    d.dim_v(oy, oy + 110, ox, ox + 10, ox - 15, "110")
    d.dim_v(fy, fy + T, ox, ox, ox - 12, "12")
    d.dim_h(ox, ox + 20, oy + 20, oy + 20, oy - 8, "20")
    d.leader((ox + 123.5, oy + 23.5), (ox + 150, oy + 30), "3x Ø10")
    d.leader((ox + 85, oy + 49), (ox + 110, oy + 75), "Langloch 42x12")
    d.leader((ox + 3, oy + 3), (ox - 25, oy - 30), "R10")
    d.text(ox + 70, oy + 112, "Freiformkontur (Spline)")
    d.save("examples/03_halteplatte.pdf")


def angle_bracket():
    d = Drawing("Winkel", "D2C-004", "S355J2")
    d.frame_and_title()
    fx, fy = 60, 170
    # Vorderansicht (X nach rechts, Z nach oben)
    d.line([(fx, fy), (fx + 100, fy), (fx + 100, fy + 70), (fx, fy + 70), (fx, fy)])
    d.line([(fx, fy + 10), (fx + 100, fy + 10)])
    for x in (25, 75):
        d.circle((fx + x, fy + 45), 6)
        d.line([(fx + x - 9, fy + 45), (fx + x + 9, fy + 45)], "center"); d.line([(fx + x, fy + 36), (fx + x, fy + 54)], "center")
    for x in (20, 80):
        d.line([(fx + x - 5, fy), (fx + x - 5, fy + 10)], "hidden"); d.line([(fx + x + 5, fy), (fx + x + 5, fy + 10)], "hidden")
    # Draufsicht (unter der Vorderansicht; oben = hinten)
    tx, ty = 60, 60
    d.line([(tx, ty), (tx + 100, ty), (tx + 100, ty + 60), (tx, ty + 60), (tx, ty)])
    d.line([(tx, ty + 45), (tx + 100, ty + 45)]); d.line([(tx, ty + 50), (tx + 100, ty + 50)])
    for x in (20, 80):
        d.circle((tx + x, ty + 25), 5)
        d.line([(tx + x - 8, ty + 25), (tx + x + 8, ty + 25)], "center"); d.line([(tx + x, ty + 17), (tx + x, ty + 33)], "center")
    for x in (25, 75):
        d.line([(tx + x - 6, ty + 50), (tx + x - 6, ty + 60)], "hidden"); d.line([(tx + x + 6, ty + 50), (tx + x + 6, ty + 60)], "hidden")
    # Seitenansicht von links (rechts daneben): Seiten-x = sx + (60 - Y)
    sx = 230
    P = lambda Y, Z: (sx + 60 - Y, fy + Z)
    d.line([P(50, 70), P(60, 70), P(60, 0), P(0, 0), P(0, 10), P(45, 10)])
    d.arc((sx + 60 - 45, fy + 15), 5, 180, 270)
    d.line([P(50, 15), P(50, 70)])
    for Z in (39, 51):
        d.line([P(50, Z), P(60, Z)], "hidden")
    for Y in (20, 30):
        d.line([P(Y, 0), P(Y, 10)], "hidden")
    # Bemaßung
    d.dim_v(fy, fy + 70, fx, fx, fx - 12, "70")
    d.dim_h(fx, fx + 25, fy + 45, fy + 45, fy + 80, "25")
    d.dim_v(fy, fy + 45, fx + 100, fx + 100, fx + 110, "45")
    d.dim_h(tx, tx + 100, ty, ty, ty - 15, "100")
    d.dim_v(ty, ty + 60, tx, tx, tx - 12, "60")
    d.dim_v(ty, ty + 25, tx + 100, tx + 100, tx + 110, "25")
    d.dim_h(tx, tx + 20, ty, ty, ty - 6, "20")
    d.dim_h(sx, sx + 10, fy + 70, fy + 70, fy + 80, "10")
    d.dim_v(fy, fy + 10, sx + 60, sx + 60, sx + 70, "10")
    d.leader((tx + 80 + 3.6, ty + 25 + 3.6), (tx + 110, ty + 45), "2x Ø10")
    d.leader((fx + 75 + 4.3, fy + 45 + 4.3), (fx + 110, fy + 65), "2x Ø12")
    d.leader((sx + 60 - 45 - 3.5 + 0.0, fy + 15 - 3.5 + 0.0), (sx + 30, fy + 40), "R5")
    d.save("examples/04_winkel.pdf")


def stepped_block():
    d = Drawing("Stufenblock mit Tasche", "D2C-005", "EN AW-6082")
    d.frame_and_title()
    fx, fy = 50, 175
    d.line([(fx, fy), (fx + 120, fy), (fx + 120, fy + 30), (fx + 60, fy + 30), (fx + 60, fy + 50), (fx, fy + 50), (fx, fy)])
    d.line([(fx + 10, fy + 40), (fx + 50, fy + 40)], "hidden")
    d.line([(fx + 10, fy + 40), (fx + 10, fy + 50)], "hidden"); d.line([(fx + 50, fy + 40), (fx + 50, fy + 50)], "hidden")
    d.line([(fx + 25, fy), (fx + 25, fy + 50)], "hidden"); d.line([(fx + 35, fy), (fx + 35, fy + 50)], "hidden")
    d.line([(fx + 82, fy + 10), (fx + 82, fy + 30)], "hidden"); d.line([(fx + 98, fy + 10), (fx + 98, fy + 30)], "hidden")
    d.line([(fx + 82, fy + 10), (fx + 98, fy + 10)], "hidden")
    d.line([(fx + 30, fy - 4), (fx + 30, fy + 54)], "center"); d.line([(fx + 90, fy + 6), (fx + 90, fy + 34)], "center")
    tx, ty = 50, 55
    d.line([(tx, ty), (tx + 120, ty), (tx + 120, ty + 80), (tx, ty + 80), (tx, ty)])
    d.line([(tx + 60, ty), (tx + 60, ty + 80)])
    d.line([(tx + 10, ty + 45), (tx + 50, ty + 45), (tx + 50, ty + 75), (tx + 10, ty + 75), (tx + 10, ty + 45)])
    d.circle((tx + 30, ty + 20), 5); d.circle((tx + 90, ty + 40), 8)
    for (x, y, r) in ((30, 20, 5), (90, 40, 8)):
        d.line([(tx + x - r - 3, ty + y), (tx + x + r + 3, ty + y)], "center"); d.line([(tx + x, ty + y - r - 3), (tx + x, ty + y + r + 3)], "center")
    sx = 230
    d.line([(sx, fy), (sx + 80, fy), (sx + 80, fy + 50), (sx, fy + 50), (sx, fy)])
    Q = lambda Y: sx + 80 - Y
    d.line([(Q(45), fy + 40), (Q(75), fy + 40)], "hidden")
    d.line([(Q(45), fy + 40), (Q(45), fy + 50)], "hidden"); d.line([(Q(75), fy + 40), (Q(75), fy + 50)], "hidden")
    d.line([(Q(15), fy), (Q(15), fy + 50)], "hidden"); d.line([(Q(25), fy), (Q(25), fy + 50)], "hidden")
    d.line([(Q(32), fy + 10), (Q(32), fy + 30)], "hidden"); d.line([(Q(48), fy + 10), (Q(48), fy + 30)], "hidden")
    # Bemaßung
    d.dim_h(fx, fx + 120, fy + 50, fy + 30, fy + 70, "120")
    d.dim_h(fx, fx + 60, fy + 50, fy + 50, fy + 60, "60")
    d.dim_v(fy, fy + 50, fx, fx, fx - 12, "50")
    d.dim_v(fy, fy + 30, fx + 120, fx + 120, fx + 132, "30")
    d.dim_v(fy + 40, fy + 50, sx + 80, sx + 80, sx + 92, "10")
    d.dim_v(ty, ty + 80, tx, tx, tx - 12, "80")
    d.dim_h(tx, tx + 30, ty, ty, ty - 8, "30")
    d.dim_h(tx, tx + 90, ty, ty, ty - 18, "90")
    d.dim_v(ty, ty + 40, tx + 120, tx + 120, tx + 132, "40")
    d.dim_v(ty, ty + 20, tx + 120, tx + 120, tx + 145, "20")
    d.leader((tx + 30 + 3.5, ty + 20 + 3.5), (tx + 45, ty + 33), "Ø10")
    d.leader((tx + 90 + 5.7, ty + 40 + 5.7), (tx + 98, ty + 90), "Ø16 T20")
    d.leader((tx + 50, ty + 75), (tx + 70, ty + 92), "Tasche 40x30 T10")
    d.save("examples/05_stufenblock.pdf")


def raster_versions():
    """Gerasterte, leicht verrauschte Fassungen (300 dpi) zum Test der Bild-Pipeline."""
    import numpy as np, cv2
    from PIL import Image
    os.makedirs("examples/raster", exist_ok=True)
    rng = np.random.default_rng(1)
    jobs = [("01_flansch", "png"), ("02_welle", "tif"), ("03_halteplatte", "pdf"), ("04_winkel", "png"), ("05_stufenblock", "tif")]
    for name, fmt in jobs:
        pix = pymupdf.open(f"examples/{name}.pdf")[0].get_pixmap(dpi=300, colorspace=pymupdf.csGRAY)
        img = np.frombuffer(pix.samples, np.uint8).reshape(pix.height, pix.width).astype(np.float32)
        img = cv2.GaussianBlur(img, (3, 3), 0.8) * 0.92 + 12
        img += rng.normal(0, 10, img.shape)
        m = rng.random(img.shape); img[m < 0.0008] = 30; img[m > 0.9995] = 255
        img = np.clip(img, 0, 255).astype(np.uint8)
        out = f"examples/raster/{name}_scan.{fmt}"
        if fmt == "png":
            cv2.imwrite(out, img)                       # ohne DPI-Angabe -> Maßstab muss aus Maßzahlen kommen
        elif fmt == "tif":
            Image.fromarray(img).save(out, dpi=(300, 300), compression="tiff_lzw")
        else:
            png = cv2.imencode(".png", img)[1].tobytes()
            doc = pymupdf.open(); pg = doc.new_page(width=W * MM, height=H * MM)
            pg.insert_image(pg.rect, stream=png); doc.save(out)
        print("geschrieben:", out)


if __name__ == "__main__":
    import os
    flange(); shaft(); bracket(); angle_bracket(); stepped_block(); raster_versions()
