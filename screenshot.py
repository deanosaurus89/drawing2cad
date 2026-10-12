"""End-to-End-Test mit Headless-Chrome: alle Beispiele laden, Screenshots, ViewCube, PMI, Maßänderung."""
import asyncio, json
from playwright.async_api import async_playwright

import sys
BSP = [] if "--nur-extra" in sys.argv else ["01_flansch", "02_welle", "03_halteplatte", "04_winkel", "05_stufenblock",
       "r01_flansch", "r02_welle", "r03_halteplatte", "r04_winkel", "r05_stufenblock"]


async def warte(pg):
    await pg.wait_for_function("window.__ready !== undefined && window.__ready !== false", timeout=120000)
    await pg.wait_for_timeout(1200)
    return await pg.evaluate("window.__ready")


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"])
        pg = await b.new_page(viewport={"width": 1680, "height": 980})
        errs = []; pg.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)
        ergebnis = {}
        for bid in BSP:
            await pg.goto(f"http://localhost:8420/?beispiel={bid}")
            ok = await warte(pg)
            st = await pg.inner_text("#status")
            ergebnis[bid] = st; print(bid, ok, st)
            await pg.screenshot(path=f"screenshots/{bid}_app.png")
            await pg.locator("#viewer").screenshot(path=f"screenshots/{bid}_3d.png")
        # ViewCube: Vorderansicht, Draufsicht, Ecke
        await pg.goto("http://localhost:8420/?beispiel=04_winkel"); await warte(pg)
        for name, (x, y) in {"vorne": (60, 60), "oben_ecke": (95, 25)}.items():
            await pg.locator("#cube").click(position={"x": x, "y": y}); await pg.wait_for_timeout(900)
            await pg.locator("#viewer").screenshot(path=f"screenshots/viewcube_{name}_04_winkel.png")
        await pg.evaluate("window.__ansicht(0,1,0)"); await pg.wait_for_timeout(900)
        await pg.locator("#viewer").screenshot(path="screenshots/viewcube_oben_04_winkel.png")
        # PMI-Auswahl + Flächen-Picking
        await pg.goto("http://localhost:8420/?beispiel=01_flansch"); await warte(pg)
        await pg.click("button[data-tab=pmi]")
        await pg.locator(".pmilabel").nth(2).click(force=True); await pg.wait_for_timeout(500)
        await pg.screenshot(path="screenshots/pmi_auswahl_01_flansch.png")
        vb = await pg.locator("#viewer").bounding_box()
        await pg.mouse.click(vb["x"] + vb["width"] * 0.5, vb["y"] + vb["height"] * 0.5); await pg.wait_for_timeout(500)
        await pg.screenshot(path="screenshots/picking_01_flansch.png")
        print("Picking-Info:", (await pg.inner_text("#info"))[:200].replace("\n", " | "))
        # Maßänderung: Flansch Ø140 -> Ø160, Bohrung Ø32 -> Ø40
        await pg.click("button[data-tab=masse]")
        await pg.evaluate("window.__aendere({M3: 160, M5: 40})")
        await pg.wait_for_timeout(500); await warte(pg)
        print("nach Änderung:", await pg.inner_text("#status"), "|", await pg.inner_text("#aenderungen"))
        await pg.screenshot(path="screenshots/parametrisch_01_flansch_D160.png")
        await pg.goto("http://localhost:8420/?beispiel=05_stufenblock"); await warte(pg)
        await pg.evaluate("window.__aendere({M2: 75, M12: 24})"); await pg.wait_for_timeout(500); await warte(pg)
        print("nach Änderung:", await pg.inner_text("#status"), "|", await pg.inner_text("#aenderungen"))
        await pg.screenshot(path="screenshots/parametrisch_05_stufenblock.png")
        print("Konsolenfehler:", [e for e in errs if "favicon" not in e and "404" not in e])
        await b.close()

asyncio.run(main())
