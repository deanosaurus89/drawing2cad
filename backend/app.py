import os, uuid, shutil, json, traceback, time
from fastapi import FastAPI, UploadFile, File, HTTPException, Body
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
import numpy as np
import pymupdf, cv2
import recon
from sketch import ReconError

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EX, JOBS, STATIC = (os.path.join(ROOT, d) for d in ("examples", "jobs", "static"))
EXAMPLES = [
    ("01_flansch", "01_flansch.pdf", "Flansch (Drehteil, Lochkreis, Passung)", "Vektor-PDF"),
    ("02_welle", "02_welle.pdf", "Abtriebswelle (Absätze, Kegel, Fasen)", "Vektor-PDF"),
    ("03_halteplatte", "03_halteplatte.pdf", "Halteplatte (Kontur, Bohrungen, Langloch)", "Vektor-PDF"),
    ("04_winkel", "04_winkel.pdf", "Winkel (L-Form, Ausrundung, Bohrungen)", "Vektor-PDF"),
    ("05_stufenblock", "05_stufenblock.pdf", "Stufenblock (Absatz, Tasche, Sackloch)", "Vektor-PDF"),
    ("r01_flansch", "raster/01_flansch_scan.png", "Flansch – Scan", "PNG (ohne DPI)"),
    ("r02_welle", "raster/02_welle_scan.tif", "Welle – Scan", "TIFF 300 dpi"),
    ("r03_halteplatte", "raster/03_halteplatte_scan.pdf", "Halteplatte – Scan", "Bild-PDF"),
    ("r04_winkel", "raster/04_winkel_scan.png", "Winkel – Scan", "PNG (ohne DPI)"),
    ("r05_stufenblock", "raster/05_stufenblock_scan.tif", "Stufenblock – Scan", "TIFF 300 dpi"),
]
EXD = {e[0]: e for e in EXAMPLES}
OK_EXT = {".pdf", ".png", ".jpg", ".jpeg", ".tif", ".tiff"}
app = FastAPI(title="Zeichnung → CAD")


def preview(src, out, views=None, page_h=None):
    ext = os.path.splitext(src)[1].lower()
    if ext == ".pdf":
        doc = pymupdf.open(src); page = doc[0]
        if views:
            k = 72 / 25.4
            for v in views:
                r = pymupdf.Rect(v["lo"][0] * k - 4, (page_h - v["hi"][1]) * k - 4, v["hi"][0] * k + 4, (page_h - v["lo"][1]) * k + 4)
                col = (0.85, 0.1, 0.1) if v["rolle"] else (0.6, 0.6, 0.6)
                page.draw_rect(r, color=col, width=1.2, dashes="[4 2] 0")
                page.insert_text((r.x0 + 2, r.y0 - 3), v["rolle"] or "Ansicht", fontsize=8, color=col)
        page.get_pixmap(dpi=110).save(out); return
    from PIL import Image
    img = cv2.cvtColor(np.array(Image.open(src).convert("L")), cv2.COLOR_GRAY2BGR)
    H, W = img.shape[:2]
    if views:
        pxmm = H / page_h
        for v in views:
            p0 = (int(v["lo"][0] * pxmm) - 12, int((page_h - v["hi"][1]) * pxmm) - 12)
            p1 = (int(v["hi"][0] * pxmm) + 12, int((page_h - v["lo"][1]) * pxmm) + 12)
            cv2.rectangle(img, p0, p1, (30, 30, 220), 4)
            cv2.putText(img, v["rolle"] or "Ansicht", (p0[0], p0[1] - 10), cv2.FONT_HERSHEY_SIMPLEX, 1.6, (30, 30, 220), 3)
    f = 1300 / W
    cv2.imwrite(out, cv2.resize(img, None, fx=f, fy=f, interpolation=cv2.INTER_AREA))


def run(jid, src, name, edits=None):
    d = os.path.join(JOBS, jid)
    try:
        res = recon.process(src, d, edits)
    except Exception as e:
        if not isinstance(e, ReconError): traceback.print_exc()
        try: preview(src, os.path.join(d, "vorschau.png"))
        except Exception: pass
        msg = str(e) if isinstance(e, ReconError) else f"Rekonstruktion fehlgeschlagen ({type(e).__name__}: {e}). Die Zeichnung liegt vermutlich außerhalb der unterstützten Teileklassen (Drehteile, einfache prismatische Teile)."
        return JSONResponse(dict(ok=False, fehler=msg, job=jid, name=name, vorschau=f"/jobs/{jid}/vorschau.png?{time.time()}"))
    preview(src, os.path.join(d, "vorschau.png"), res["ansichten"], res["page_h"])
    res.update(job=jid, name=name, vorschau=f"/jobs/{jid}/vorschau.png?{time.time()}", original=f"/jobs/{jid}/{os.path.basename(src)}",
               downloads={k: f"/jobs/{jid}/{v}" for k, v in res["dateien"].items()}, aenderungs_eingabe=edits or {})
    with open(os.path.join(d, "ergebnis.json"), "w") as f: json.dump(res, f, default=float)
    return JSONResponse(json.loads(json.dumps(res, default=float)))


def new_job(src_path, fname):
    jid = time.strftime("%Y%m%d-%H%M%S-") + uuid.uuid4().hex[:6]
    d = os.path.join(JOBS, jid); os.makedirs(d)
    dst = os.path.join(d, "eingabe" + os.path.splitext(fname)[1].lower())
    shutil.copy(src_path, dst)
    with open(os.path.join(d, "meta.json"), "w") as f: json.dump(dict(name=fname, src=dst), f)
    return jid, dst


@app.get("/api/beispiele")
def beispiele():
    return [dict(id=k, titel=t, art=a, datei=f"/examples/{p}") for k, p, t, a in EXAMPLES]


@app.post("/api/beispiele/{bid}")
def beispiel(bid: str):
    if bid not in EXD: raise HTTPException(404, "Unbekanntes Beispiel")
    _, p, t, a = EXD[bid]
    jid, src = new_job(os.path.join(EX, p), p)
    return run(jid, src, f"{t} ({a})")


@app.post("/api/upload")
async def upload(datei: UploadFile = File(...)):
    data = await datei.read()
    ext = os.path.splitext(datei.filename or "")[1].lower()
    if ext not in OK_EXT:
        return JSONResponse(dict(ok=False, fehler="Dateityp nicht unterstützt. Erlaubt: PDF, PNG, JPG, TIFF."))
    if len(data) > 40e6:
        return JSONResponse(dict(ok=False, fehler="Datei zu groß (max. 40 MB)."))
    tmp = os.path.join(JOBS, "upload-" + uuid.uuid4().hex + ext)
    with open(tmp, "wb") as f: f.write(data)
    try:
        jid, src = new_job(tmp, datei.filename)
    finally:
        os.remove(tmp)
    return run(jid, src, datei.filename)


@app.post("/api/jobs/{jid}/neu")
def neu(jid: str, edits: dict = Body(...)):
    d = os.path.join(JOBS, os.path.basename(jid))
    if not os.path.isfile(os.path.join(d, "meta.json")): raise HTTPException(404, "Auftrag nicht gefunden")
    meta = json.load(open(os.path.join(d, "meta.json")))
    jid2, src = new_job(meta["src"], meta["name"])
    clean = {k: float(v) for k, v in edits.items() if v not in (None, "")}
    return run(jid2, src, meta["name"], clean)


app.mount("/jobs", StaticFiles(directory=JOBS), name="jobs")
app.mount("/examples", StaticFiles(directory=EX), name="examples")
app.mount("/", StaticFiles(directory=STATIC, html=True), name="static")
