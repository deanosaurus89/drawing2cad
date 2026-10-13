"""Browser-Test der client-seitigen Web-App (Playwright, Headless Chrome).
Aufruf:  python tests/test_web.py [URL] [--nur desktop|mobil] [--beispiele a,b]
Prüft: alle Beispiele bauen, Volumen vs. Python-Referenz, STEP-Reimport (cadquery), ViewCube, Konsolenfehler, Screenshots.
"""
import sys, os, json, time, argparse, subprocess, pathlib
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
SHOTS = ROOT / 'screenshots'; SHOTS.mkdir(exist_ok=True)
OUT = pathlib.Path('/tmp/d2c_web'); OUT.mkdir(exist_ok=True)
# Python-Referenzvolumen (Backend, mm³); Raster: Python-Rasterpfad
REF = {'01_flansch.pdf': 257834.1, '02_welle.pdf': 188686.4, '03_halteplatte.pdf': 144027.0, '04_winkel.pdf': 116703.8, '05_stufenblock.pdf': 364051.9,
       'r01_flansch_scan.png': 259851, 'r02_welle_scan.tif': 188686.4, 'r03_halteplatte_scan.pdf': 144144, 'r04_winkel_scan.jpg': 116571, 'r05_stufenblock_scan.tif': 365693,
       # Schnitt/Einzelheit: analytische Sollwerte (examples/sollwerte_schnitt.json)
       '06_buchse.pdf': 75953.1, '07_lagerplatte_schnitt.pdf': 166856.3, 'r06_buchse_scan.tif': 75953.1, 'r07_lagerplatte_schnitt_scan.pdf': 166856.3,
       # reale Zeichnung: handmodelliertes Referenzmodell (tests/ref_real.py), siehe README
       'real/xometry_lathe_sample.webp': 19812.2,
       'real/drehteil_rillen_4zu1.jpg': 243.16, 'real/platte_schraege_1zu2.jpg': 202937.7}
TOLP = {'r06_buchse_scan.tif': 5, 'r07_lagerplatte_schnitt_scan.pdf': 5, 'real/xometry_lathe_sample.webp': 3,
        'real/drehteil_rillen_4zu1.jpg': 5, 'real/platte_schraege_1zu2.jpg': 15}
ALL = list(REF)
ap = argparse.ArgumentParser(); ap.add_argument('url', nargs='?', default='http://localhost:8777/')
ap.add_argument('--nur', default=''); ap.add_argument('--beispiele', default='')
a = ap.parse_args()
names = a.beispiele.split(',') if a.beispiele else ALL
VENV_PY = str(ROOT / '.venv/bin/python')

def step_check(path):
    code = ("import cadquery as cq,sys\ns=cq.importers.importStep(sys.argv[1]).val()\n"
            "print(round(s.Volume(),1), s.isValid(), len(s.Faces()))")
    r = subprocess.run([VENV_PY, '-c', code, path], capture_output=True, text=True, timeout=300)
    v, ok, nf = r.stdout.split()
    return float(v), ok == 'True', int(nf)

results = []; errors_all = []
def run(profile):
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist'])
        if profile == 'mobil':
            ctx = b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=3, is_mobile=True, has_touch=True,
                                user_agent='Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
                                accept_downloads=True)
        else:
            ctx = b.new_context(viewport={'width': 1500, 'height': 900}, accept_downloads=True)
        pg = ctx.new_page(); errs = []
        pg.on('console', lambda m: m.type == 'error' and errs.append(m.text))
        pg.on('pageerror', lambda e: errs.append('pageerror: ' + str(e)))
        t = time.time(); pg.goto(a.url, wait_until='load')
        pg.wait_for_function('window.__ready === true || window.__ready === "fehler"', timeout=240000)
        print(f'[{profile}] Start + WASM + Flansch: {time.time()-t:.1f}s', flush=True)
        # ViewCube: Fläche, Kante, Ecke
        if profile == 'mobil': pg.click('#tabs button[data-tab="3d"]')
        vc = []
        for label, d in [('Fläche Vorne', [0, -1, 0]), ('Fläche Oben', [0, 0, 1]), ('Kante Vorne/Rechts', [1, -1, 0]), ('Kante Oben/Vorne', [0, -1, 1]), ('Ecke', [1, -1, 1]), ('Fläche Rechts', [1, 0, 0])]:
            pg.evaluate('window.__ansicht([1.3,-1,0.8])'); pg.wait_for_timeout(700)
            x, y = pg.evaluate(f'window.__cubePunkt({d})')
            if profile == 'mobil': pg.touchscreen.tap(x, y)
            else: pg.mouse.click(x, y)
            pg.wait_for_timeout(800)
            after = pg.evaluate('window.__kamera().dir')
            n = sum(v*v for v in d) ** .5; exp = [v / n for v in d]
            err = sum((u - v)**2 for u, v in zip(after, exp)) ** .5
            vc.append((label, [round(v, 2) for v in after], round(err, 3)))
        pg.screenshot(path=str(SHOTS / f'web_{profile}_viewcube.png'))
        print(f'[{profile}] ViewCube:', vc, flush=True)
        vc_ok = all(e < 0.02 for _, _, e in vc)
        results.append({'profil': profile, 'test': 'viewcube', 'ok': vc_ok, 'details': vc})
        # Picking im 3D-Fenster (Mitte)
        pg.evaluate('window.__ansicht([1,-1.2,0.9])'); pg.wait_for_timeout(700)
        vb = pg.locator('#ansicht').bounding_box()
        if profile == 'mobil': pg.touchscreen.tap(vb['x']+vb['width']/2, vb['y']+vb['height']/2)
        else: pg.mouse.click(vb['x']+vb['width']/2, vb['y']+vb['height']/2)
        pg.wait_for_timeout(400)
        pick = pg.locator('#auswahl').inner_text() if pg.locator('#auswahl').is_visible() else ''
        results.append({'profil': profile, 'test': 'picking', 'ok': bool(pick), 'details': pick[:120]})
        pg.screenshot(path=str(SHOTS / f'web_{profile}_auswahl.png'))
        for n in names:
            t = time.time(); pg.evaluate('window.__ready = false')
            pg.evaluate(f'window.ladeBeispiel({json.dumps(n)})')
            pg.wait_for_function('window.__ready === true || window.__ready === "fehler"', timeout=300000)
            st = pg.evaluate('window.__ready'); dt = time.time() - t
            if st != True:
                msg = pg.locator('#meldungen').inner_text()
                print(f'[{profile}] {n}: FEHLER {msg[:200]}', flush=True)
                results.append({'profil': profile, 'test': n, 'ok': False, 'details': msg[:300]}); continue
            info = pg.evaluate('window.__letztes')
            if profile == 'mobil': pg.click('#tabs button[data-tab="3d"]'); pg.wait_for_timeout(300)
            pg.wait_for_timeout(500)
            pg.screenshot(path=str(SHOTS / f'web_{profile}_{n.split(".")[0].replace("/", "_")}.png'))
            # STEP-Export
            if profile == 'mobil': pg.click('#tabs button[data-tab="masse"]')
            with pg.expect_download(timeout=120000) as d:
                pg.click('#x-step')
            fp = OUT / f'{profile}_{n.replace("/", "_")}.step'; d.value.save_as(str(fp))
            head = fp.read_text(errors='ignore')[:2000]
            schema = 'AP214' if 'AUTOMOTIVE_DESIGN' in head else ('AP242' if 'AP242' in head else ('AP203' if 'CONFIG_CONTROL' in head else '?'))
            sv, sok, snf = step_check(str(fp))
            ref = REF[n]; dev = (info['volumen'] - ref) / ref * 100
            ok = abs(dev) < TOLP.get(n, 2) and sok and abs(sv - info['volumen']) / info['volumen'] < 1e-3 and info['gueltig']
            print(f'[{profile}] {n}: {dt:.1f}s V={info["volumen"]:.1f} ref={ref} ({dev:+.2f}%) Flächen={info["flaechen"]} PMI={info["pmi"]} STEP {schema} reimport V={sv} gültig={sok}', flush=True)
            results.append({'profil': profile, 'test': n, 'ok': ok, 'zeit_s': round(dt, 1), 'volumen': info['volumen'], 'ref': ref, 'abw_proz': round(dev, 2), 'step_schema': schema, 'step_volumen': sv, 'step_gueltig': sok, 'pmi': info['pmi']})
            if profile == 'mobil': pg.click('#tabs button[data-tab="3d"]')
        # Schema-Varianten + Maßänderung am letzten Vektor-Beispiel
        if not a.beispiele:
            pg.evaluate('window.ladeBeispiel("05_stufenblock.pdf")'); pg.wait_for_function('window.__ready === true', timeout=120000)
            if profile == 'mobil': pg.click('#tabs button[data-tab="masse"]')
            for sch in ['AP203', 'AP242DIS']:
                pg.select_option('#schema', sch)
                with pg.expect_download() as d: pg.click('#x-step')
                fp = OUT / f'{profile}_schema_{sch}.step'; d.value.save_as(str(fp)); h = fp.read_text(errors='ignore')[:3000]
                sv, sok, _ = step_check(str(fp))
                results.append({'profil': profile, 'test': 'schema ' + sch, 'ok': sok and ('CONFIG_CONTROL' in h if sch == 'AP203' else 'AP242' in h), 'step_volumen': sv})
            pg.select_option('#schema', 'AP214IS')
            pg.evaluate('window.__ready=false'); pg.evaluate('window.__aendere({M2: 75, M12: 24})')
            pg.wait_for_function('window.__ready === true', timeout=120000)
            v = pg.evaluate('window.__letztes.volumen')
            results.append({'profil': profile, 'test': 'Maßänderung Stufenblock M2=75,M12=24', 'ok': abs(v - 419025.3) < 5, 'volumen': v})
            print(f'[{profile}] Maßänderung -> {v}', flush=True)
            for tabn in (['zeichnung', 'masse', 'info', '3d'] if profile == 'mobil' else []):
                pg.click(f'#tabs button[data-tab="{tabn}"]'); pg.wait_for_timeout(300); pg.screenshot(path=str(SHOTS / f'web_{profile}_tab_{tabn}.png'))
            if profile == 'desktop': pg.screenshot(path=str(SHOTS / 'web_desktop_gesamt.png'))
        real = [e for e in errs if 'favicon' not in e]
        results.append({'profil': profile, 'test': 'konsole', 'ok': not real, 'details': real[:10]})
        print(f'[{profile}] Konsolenfehler: {real[:10]}', flush=True)
        b.close()

for prof in (['desktop', 'mobil'] if not a.nur else [a.nur]): run(prof)
(OUT / 'ergebnis.json').write_text(json.dumps(results, indent=1, ensure_ascii=False))
bad = [r for r in results if not r['ok']]
print(f'\n{len(results)-len(bad)}/{len(results)} OK'); [print('  FAIL', r) for r in bad]
sys.exit(1 if bad else 0)
