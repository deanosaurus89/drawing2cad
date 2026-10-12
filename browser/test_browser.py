"""Headless-Test der Browser-Seite: file:// und http://, CDN und lokal; STEP-Export aller Schemata; Re-Import mit CadQuery."""
import asyncio, json, subprocess, sys, os, time, pathlib
from playwright.async_api import async_playwright
import cadquery as cq

HIER = pathlib.Path(__file__).resolve().parent
AUS = HIER / "testausgabe"; AUS.mkdir(exist_ok=True)
SCHEMATA = ["standard", "AP203", "AP214IS", "AP242DIS"]

def pruefe_step(p):
    s = cq.importers.importStep(str(p)).val()
    return {"gueltig": s.isValid(), "typ": s.ShapeType(), "volumen": round(s.Volume(), 1), "flaechen": len(s.Faces())}

async def lauf(b, url, mit_export, shot=None):
    pg = await b.new_page(viewport={"width": 1400, "height": 900}, accept_downloads=True)
    fehler = []; pg.on("console", lambda m: fehler.append(m.text) if m.type == "error" else None)
    pg.on("pageerror", lambda e: fehler.append(str(e)))
    t = time.time(); await pg.goto(url)
    try:
        await pg.wait_for_function("window.__test && ['modell','fehler'].includes(window.__test.phase)", timeout=180000)
    except Exception as e:
        fehler.append("Timeout: " + str(e)[:100])
    r = await pg.evaluate("({...window.__test, stepText: undefined})"); r["wand_s"] = round(time.time() - t, 1)
    r["konsole"] = fehler[:3]
    if mit_export and r.get("phase") == "modell":
        r["exporte"] = {}
        for sch in SCHEMATA:
            await pg.select_option("#schema", sch)
            async with pg.expect_download() as dl:
                await pg.click("#step")
            d = await dl.value; ziel = AUS / d.suggested_filename; await d.save_as(ziel)
            info = await pg.evaluate("({fs: window.__test.fileSchema, erkannt: window.__test.erkannt})")
            info.update(pruefe_step(ziel)); r["exporte"][sch] = info
        if shot:
            await pg.select_option("#schema", "AP214IS"); await pg.click("#step"); await pg.wait_for_timeout(500)
            await pg.screenshot(path=shot)
    await pg.close(); return r

async def main():
    srv = subprocess.Popen([sys.executable, "-m", "http.server", "8431", "-d", str(HIER.parent)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(1)
    ergebnis = {}
    try:
        async with async_playwright() as p:
            b = await p.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"])
            datei = (HIER / "test-browser-cad.html").as_uri()
            http = "http://localhost:8431/browser/test-browser-cad.html"
            ergebnis["file_cdn"] = await lauf(b, datei, True)
            ergebnis["file_lokal"] = await lauf(b, datei + "?quelle=lokal", False)
            ergebnis["http_lokal"] = await lauf(b, http + "?quelle=lokal", True)
            ergebnis["http_cdn"] = await lauf(b, http, True, shot=str(HIER.parent / "screenshots" / "browser_test.png"))
            if len(sys.argv) > 1:
                ergebnis["pages"] = await lauf(b, sys.argv[1], True)
            await b.close()
    finally:
        srv.terminate()
    print(json.dumps(ergebnis, indent=1, ensure_ascii=False))

asyncio.run(main())
