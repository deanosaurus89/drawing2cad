"""Handmodell drehteil_rillen_4zu1.jpg (Maße aus Zeichnung; mit * markierte Werte aus Pixeln der Zeichnung gemessen = erschlossen)."""
import cadquery as cq, math, sys
L = 12.19; Rs = 6.85/2; Rf = 11.5/2; Rb = 5/2; Rcb = 8.5/2
xf = L - 2.94                          # Flanschbeginn
ch = 0.73                              # * Fase links (axial), Schaftlänge 5,68 ab Fasenende
xs = ch + 5.68                         # Kegelbeginn
xin0, xin1, rin1 = 6.23, 9.54, 5.22    # * Innenkegel (Wandstärke 0,6 senkrecht)
xfl = 10.2                             # * Grund der Innenkontur am Flansch
xr0, rr = 11.59, 4.77                  # * Innenfase rechts
n, x0g, sag = 5, 0.45, 0.33            # * 5 Rillen, R0,6 (Sehne/Pfeilhöhe aus Bild)
w = (xin0 - x0g) / n
wp = cq.Workplane('XY').moveTo(0, Rb).lineTo(ch, Rs).lineTo(xs, Rs).lineTo(xf, Rf).lineTo(L, Rf).lineTo(L, rr).lineTo(xr0, Rcb)
wp = wp.lineTo(xfl + 0.8, Rcb).threePointArc((xfl + 0.8 - 0.8*math.sin(math.pi/4), Rcb + 0.8 - 0.8*math.cos(math.pi/4)), (xfl, Rcb + 0.8))
wp = wp.lineTo(xfl, rin1).lineTo(xin1, rin1).lineTo(xin0, Rb)
for i in range(n):
    a = xin0 - i*w; b = a - w
    wp = wp.threePointArc(((a+b)/2, Rb + sag), (b, Rb))
wp = wp.lineTo(0, Rb).close()
s = wp.revolve(360, (0, 0, 0), (1, 0, 0))
v = s.val().Volume(); print('Vref_A', round(v, 2), 'bbox', [round(x, 2) for x in (s.val().BoundingBox().xlen, s.val().BoundingBox().ylen)])
cq.exporters.export(s, sys.argv[1] if len(sys.argv) > 1 else '/tmp/ref_a.step')
