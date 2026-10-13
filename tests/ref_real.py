import cadquery as cq, math
# profile half (x axial, r) with R19 concave flanks centered (29.9,21.5) & (35.1,21.5)
def arcpts(cx,cr,R,x0,x1,n=60):
    out=[]
    for i in range(n+1):
        x=x0+(x1-x0)*i/n; out.append((x,cr-math.sqrt(max(R*R-(x-cx)**2,0))))
    return out
xa=29.9-math.sqrt(19**2-14**2)  # r=7.5 -> cr-r=14
pts=[(0,0),(0,5),(8,5),(8,19),(9,20),(11,20)]
pts+=arcpts(29.9,21.5,19,11.0,xa)[1:]
xb=35.1+(35.1-xa)-35.1+35.1  # mirror about 32.5? use symmetric about (11+54)/2
m=(11+54)/2; xb=2*m-xa
pts+=[(xb,7.5)]+arcpts(35.1,21.5,19,xb,54.0)[1:]
pts+=[(56,20),(57,19),(57,5),(69,5),(69,4),(76,4),(76,0)]
prof=cq.Workplane('XY').polyline(pts).close().revolve(360,(0,0,0),(1,0,0))
s=prof
for k in range(4):
    a=math.radians(90*k); s=s.cut(cq.Workplane('YZ').workplane(offset=-1).center(15*math.cos(a),15*math.sin(a)).circle(1.5).extrude(80))
s=s.cut(cq.Workplane('YZ').circle(3.3/2).extrude(12)).cut(cq.Workplane('YZ').workplane(offset=64).circle(2).extrude(12))
print('Vref',round(s.val().Volume(),1),'solid only',round(prof.val().Volume(),1))
cq.exporters.export(s,'/tmp/ref_real.step')
