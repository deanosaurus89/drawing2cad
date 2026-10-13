"""Handmodell platte_schraege_1zu2.jpg. Bemaßte Werte aus der Zeichnung, mit * markierte Werte aus Pixeln erschlossen.
Achsen: x nach rechts, y nach oben (Hauptansicht), Dicke t entlang z."""
import cadquery as cq, math, sys
t = 16.51
hx, hy = 106.2, 98.4           # * Nabe aus Pixeln (Maß 97,51 weicht ~0,9 mm ab, siehe Bericht); rechte Kante = hx + 41,6
xr = hx + 41.6
ytop = 104.8                   # * Oberkante links (Pixel)
R1, R2 = 32.5, 45.5            # R32,5 (Hohlkehle) tangential an R45,5 um Nabe
# R32,5: tangential an y=ytop, Mittelpunkt (cx, ytop+R1), Abstand zur Nabe = R1+R2
dy = ytop + R1 - hy; cx = hx - math.sqrt((R1 + R2) ** 2 - dy ** 2); c1 = (cx, ytop + R1)
k = R1 / (R1 + R2); tp = (c1[0] + (hx - c1[0]) * k, c1[1] + (hy - c1[1]) * k)   # Tangentenpunkt
yR = hy + math.sqrt(R2 ** 2 - (xr - hx) ** 2)                                      # R45,5 trifft rechte Kante (oben)
yR2 = hy - math.sqrt(R2 ** 2 - (xr - hx) ** 2)                                     # R45,5 (unten) trifft rechte Kante
xi = hx + 6.73                 # innere senkrechte Kante (6,73 ab Nabenachse)
rf = 12.0                      # * Hohlkehle zwischen R45,5 (unten) und innerer Kante (Pixel-Fit)
cf = (xi + rf, hy - math.sqrt((R2 + rf) ** 2 - (xi + rf - hx) ** 2)); tf = (hx + (cf[0] - hx) * R2 / (R2 + rf), hy + (cf[1] - hy) * R2 / (R2 + rf))
xbot = 18.4; rb = 14.0; rc = 4.0  # * linke Schräge trifft Unterkante bei x=18,4, Eckradius R14, Ecke unten rechts R4 (Pixel)
def arcmid(c, r, a0, a1): a = (a0 + a1) / 2; return (c[0] + r * math.cos(a), c[1] + r * math.sin(a))
a_t = math.atan2(tp[1] - c1[1], tp[0] - c1[0])
# Eckradius links unten: Tangentenpunkte an Schräge (0,ytop)-(xbot,0) und Unterkante
ang = math.atan2(ytop, -xbot)                      # Richtung Ecke -> (0,ytop)
phi = ang                                          # Innenwinkel zwischen Unterkante (+x) und Schräge
dT = rb / math.tan(phi / 2)
pb = (xbot + dT, 0); ps = (xbot + dT * math.cos(ang), dT * math.sin(ang))
cb = (pb[0], rb); _v = (ps[0] + pb[0] - 2 * cb[0], ps[1] + pb[1] - 2 * cb[1]); _l = math.hypot(*_v); mb = (cb[0] + rb * _v[0] / _l, cb[1] + rb * _v[1] / _l)
w = (cq.Workplane('XY').moveTo(0, ytop).lineTo(cx, ytop)
     .threePointArc(arcmid(c1, R1, -math.pi / 2, a_t), tp))
b0 = math.atan2(tp[1] - hy, tp[0] - hx); b1 = math.atan2(yR - hy, xr - hx)
w = w.threePointArc(arcmid((hx, hy), R2, b0, b1), (xr, yR)).lineTo(xr, yR2)
w = w.threePointArc(arcmid((hx, hy), R2, math.atan2(yR2 - hy, xr - hx), math.atan2(tf[1] - hy, tf[0] - hx)), tf)
w = w.threePointArc(arcmid(cf, rf, math.atan2(tf[1] - cf[1], tf[0] - cf[0]), math.pi), (xi, cf[1])).lineTo(xi, rc)
w = w.threePointArc((xi - rc + rc * math.cos(-math.pi / 4), rc + rc * math.sin(-math.pi / 4)), (xi - rc, 0)).lineTo(pb[0], 0)
w = w.threePointArc(mb, ps).close()
plate = w.extrude(t)
def hole(x, y, d): return cq.Workplane('XY').center(x, y).circle(d / 2).extrude(t)
xc = 64.9                      # * Kegelloch x (Pixel)
xl = xc - 24.13; xu = xl - 9.17
for (x, y) in [(xl, 26.0), (xu, 26.0 + 52.01)]: plate = plate.cut(hole(x, y, 16.51))
# Kegelloch 60°: Ø33,02 auf einer Seite -> Ø(33,02 - 2 t tan30) auf der anderen
r0 = 33.02 / 2; r1 = r0 - t * math.tan(math.radians(30))
cone = cq.Solid.makeCone(r0, r1, t, cq.Vector(xc, 52.0, 0), cq.Vector(0, 0, 1)); plate = plate.cut(cq.Workplane().add(cone))
# Nabe: Durchgangsbohrung Ø8,25*, Senkung Ø33,02 Tiefe 12,1*
plate = plate.cut(hole(hx, hy, 8.25)).cut(cq.Workplane('XY').center(hx, hy).circle(33.02 / 2).extrude(12.1))
for i in range(5): a = math.radians(72 * i); plate = plate.cut(hole(hx + 29.25 * math.cos(a), hy + 29.25 * math.sin(a), 8.0))  # * 5x Ø8 auf Ø58,5
# Langloch Breite 8,25, Mitten 6,51 und 6,51+13
plate = plate.cut(cq.Workplane('XY').center(hx, 6.51 + 6.5).slot2D(13 + 8.25, 8.25, 90).extrude(t))
V = plate.val().Volume()
# * Schräge 120° entlang R32,5 + R45,5: Breite 4,3, Tiefe 4,3*tan60
wch = 4.3; dch = wch * math.tan(math.radians(60)); Lch = R1 * abs(a_t + math.pi / 2) + R2 * abs(b1 - b0)
Vch = 0.5 * wch * dch * Lch
bb = plate.val().BoundingBox()
print('Vref_B', round(V - Vch, 1), '(ohne Schräge', round(V, 1), ', Schräge ~', round(Vch, 1), ') bbox', [round(x, 2) for x in (bb.xlen, bb.ylen, bb.zlen)])
cq.exporters.export(plate, sys.argv[1] if len(sys.argv) > 1 else '/tmp/ref_b.step')
