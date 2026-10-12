// 3D-Ansicht: three.js, OrbitControls (Maus + Touch), ViewCube, Flächen/Kanten-Auswahl, PMI-Beschriftungen.
import * as THREE from '../vendor/three.module.js';
import { OrbitControls } from '../vendor/OrbitControls.js';

export const TYPE_COLORS = { plane: 0xaab4c3, cylinder: 0x4f8fd6, cone: 0xe9a23b, torus: 0x5cb85c, sphere: 0xd65db1, bspline: 0x9b6fd6, extrusion: 0x8a7bd8, revolution: 0x60b0a8, other: 0x999999 };
export const TYPE_NAMES = { plane: 'Ebene', cylinder: 'Zylinder', cone: 'Kegel', torus: 'Torus', sphere: 'Kugel', bspline: 'B-Spline', extrusion: 'Extrusionsfl.', revolution: 'Rotationsfl.', other: 'sonstige' };

// Blickrichtungen: Vektor zeigt von Ziel zur Kamera. Modell: Z oben, Vorderansicht von -Y.
const FACE_LABELS = [['Rechts', [1, 0, 0]], ['Links', [-1, 0, 0]], ['Hinten', [0, 1, 0]], ['Vorne', [0, -1, 0]], ['Oben', [0, 0, 1]], ['Unten', [0, 0, -1]]];

export class Viewer {
  constructor(el, cubeEl, labelEl) {
    this.el = el; this.labelEl = labelEl;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.setClearColor(0xe9edf2);
    el.prepend(this.renderer.domElement);
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(35, 1, 0.1, 1e5); this.camera.up.set(0, 0, 1);
    this.camera.position.set(200, -300, 200);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x8a96a8, 1.9));
    const d1 = new THREE.DirectionalLight(0xffffff, 1.4); d1.position.set(1, -1.5, 2); this.camera.add(d1); this.scene.add(this.camera);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true; this.controls.dampingFactor = 0.12; this.controls.screenSpacePanning = true;
    this.controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
    this.controls.addEventListener('change', () => this.dirty = true);
    this.group = new THREE.Group(); this.scene.add(this.group);
    this.pmiGroup = new THREE.Group(); this.scene.add(this.pmiGroup);
    this.selGroup = new THREE.Group(); this.scene.add(this.selGroup);
    this.ray = new THREE.Raycaster();
    this.opts = { colors: true, edges: true, pmi: true };
    this.onPick = () => {}; this.onPmiClick = () => {};
    this.anim = null; this.dirty = true;
    this.initCube(cubeEl);
    this.initPointer();
    new ResizeObserver(() => this.resize()).observe(el);
    this.resize();
    const loop = t => { requestAnimationFrame(loop); this.tick(t); };
    requestAnimationFrame(loop);
  }
  resize() {
    const w = this.el.clientWidth, h = this.el.clientHeight; if (!w || !h) return;
    this.renderer.setSize(w, h); this.camera.aspect = w / h; this.camera.updateProjectionMatrix(); this.dirty = true;
  }

  // ---------------------------------------------------------- Modell
  setModel(mesh, edgeLines, edgeGroups, result) {
    this.clear();
    this.result = result;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(mesh.vertices, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(mesh.normals, 3));
    g.setIndex(new THREE.BufferAttribute(mesh.triangles, 1));
    this.faceMats = []; this.groups = mesh.groups;
    mesh.groups.forEach((gr, i) => {
      const f = result.flaechen[i];
      const mat = new THREE.MeshStandardMaterial({ color: this.faceColor(f), metalness: 0.15, roughness: 0.55, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
      this.faceMats.push(mat); g.addGroup(gr.start, gr.count, i);
    });
    this.mesh = new THREE.Mesh(g, this.faceMats); this.group.add(this.mesh);
    // Kanten
    const eg = new THREE.BufferGeometry(); eg.setAttribute('position', new THREE.BufferAttribute(edgeLines, 3));
    this.edgeObj = new THREE.LineSegments(eg, new THREE.LineBasicMaterial({ color: 0x1b2633 }));
    this.edgeObj.visible = this.opts.edges; this.group.add(this.edgeObj);
    // Pick-Linien je Kante (aus Analyse-Polylinien)
    this.edgePick = [];
    result.kanten.forEach((k, i) => {
      const pts = []; for (let j = 0; j + 5 < k.p.length + 3; j += 3) if (j + 3 < k.p.length) pts.push(k.p[j], k.p[j + 1], k.p[j + 2], k.p[j + 3], k.p[j + 4], k.p[j + 5]);
      const gg = new THREE.BufferGeometry(); gg.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
      const l = new THREE.LineSegments(gg, new THREE.LineBasicMaterial({ visible: false })); l.userData.edge = i; this.edgePick.push(l); this.group.add(l);
    });
    g.computeBoundingSphere(); this.bs = g.boundingSphere.clone();
    this.sidIndex = new Map(result.flaechen.map((f, i) => [f.sid, i]));
    this.buildPmi(result.pmi || []);
    this.fitAll(false);
  }
  faceColor(f) { return this.opts.colors ? (TYPE_COLORS[f.typ_en] ?? TYPE_COLORS.other) : 0xb8c2cf; }
  clear() {
    for (const grp of [this.group, this.pmiGroup, this.selGroup]) while (grp.children.length) { const o = grp.children.pop(); o.geometry && o.geometry.dispose(); const m = o.material; (Array.isArray(m) ? m : [m]).forEach(x => x && x.dispose && x.dispose()); }
    this.labelEl.innerHTML = ''; this.labels = []; this.mesh = null; this.sel = null;
  }
  setOption(k, v) {
    this.opts[k] = v;
    if (k === 'edges' && this.edgeObj) this.edgeObj.visible = v;
    if (k === 'colors' && this.faceMats) this.restyle();
    if (k === 'pmi') { this.pmiGroup.visible = v; this.labelEl.style.display = v ? '' : 'none'; }
    this.dirty = true;
  }
  restyle(highlight = new Set()) {
    if (!this.faceMats) return;
    this.faceMats.forEach((m, i) => {
      const f = this.result.flaechen[i];
      if (highlight.has(i)) { m.color.setHex(0xff3b30); m.emissive.setHex(0x551010); }
      else { m.color.setHex(this.faceColor(f)); m.emissive.setHex(0x000000); }
    });
    this.dirty = true;
  }

  // ---------------------------------------------------------- Kamera
  fitAll(animate = true) {
    if (!this.bs) return;
    const dir = this.camera.position.clone().sub(this.controls.target); if (dir.lengthSq() < 1e-9) dir.set(1, -1.4, 1);
    this.flyTo(dir.normalize(), animate);
  }
  flyTo(dir, animate = true) {
    if (!this.bs) return;
    const d = dir.clone().normalize();
    if (Math.abs(d.z) > 0.999) { d.y -= 0.002; d.normalize(); } // Draufsicht: Pol vermeiden
    const r = this.bs.radius; const fov = this.camera.fov * Math.PI / 180;
    const dist = r / Math.sin(Math.min(fov, fov * this.camera.aspect) / 2) * 1.08;
    const target = this.bs.center.clone(); const pos = target.clone().add(d.multiplyScalar(dist));
    this.camera.near = dist / 100; this.camera.far = dist * 100; this.camera.updateProjectionMatrix();
    if (!animate) { this.controls.target.copy(target); this.camera.position.copy(pos); this.controls.update(); this.dirty = true; return; }
    const p0 = this.camera.position.clone(), t0 = this.controls.target.clone();
    const s0 = p0.clone().sub(t0); const s1 = pos.clone().sub(target);
    this.anim = { t: performance.now(), dur: 450, p0, t0, target, l0: s0.length(), l1: s1.length(), d0: s0.normalize(), d1: s1.normalize() };
  }
  viewDir() { return this.camera.position.clone().sub(this.controls.target).normalize(); }

  // ---------------------------------------------------------- ViewCube
  initCube(cv) {
    this.cubeCanvas = cv;
    this.cubeR = new THREE.WebGLRenderer({ canvas: cv, antialias: true, alpha: true });
    this.cubeR.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.cubeScene = new THREE.Scene(); this.cubeCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10); this.cubeCam.up.set(0, 0, 1);
    const mats = FACE_LABELS.map(([txt]) => {
      const c = document.createElement('canvas'); c.width = c.height = 128; const x = c.getContext('2d');
      x.fillStyle = '#f4f7fb'; x.fillRect(0, 0, 128, 128); x.strokeStyle = '#7d8da3'; x.lineWidth = 6; x.strokeRect(3, 3, 122, 122);
      x.fillStyle = '#1f3a5f'; x.font = 'bold 26px system-ui, sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText(txt, 64, 64);
      const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return new THREE.MeshBasicMaterial({ map: t });
    });
    // BoxGeometry-Reihenfolge: +x, -x, +y, -y, +z, -z  (passt zu FACE_LABELS)
    this.cube = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mats); this.cubeScene.add(this.cube);
    // Beschriftung „Hinten“/„Links“ etc. sollen von außen lesbar sein: Texturen auf ±y-Flächen korrekt ausrichten
    this.cubeScene.add(new THREE.LineSegments(new THREE.EdgesGeometry(this.cube.geometry), new THREE.LineBasicMaterial({ color: 0x51627a })));
    this.hover = new THREE.Mesh(new THREE.SphereGeometry(0.11, 16, 12), new THREE.MeshBasicMaterial({ color: 0xff7a00 })); this.hover.visible = false; this.cubeScene.add(this.hover);
    const axes = new THREE.AxesHelper(0.9); axes.position.set(-0.5, -0.5, -0.5); this.cubeScene.add(axes);
    const pick = ev => {
      const r = cv.getBoundingClientRect(); const p = ev.touches ? ev.changedTouches[0] : ev;
      const v = new THREE.Vector2(((p.clientX - r.left) / r.width) * 2 - 1, -((p.clientY - r.top) / r.height) * 2 + 1);
      this.ray.setFromCamera(v, this.cubeCam); const h = this.ray.intersectObject(this.cube)[0]; if (!h) return null;
      const q = h.point; const d = new THREE.Vector3(Math.abs(q.x) > 0.3 ? Math.sign(q.x) : 0, Math.abs(q.y) > 0.3 ? Math.sign(q.y) : 0, Math.abs(q.z) > 0.3 ? Math.sign(q.z) : 0);
      return d.lengthSq() ? d : null;
    };
    cv.addEventListener('pointermove', ev => { const d = pick(ev); this.hover.visible = !!d; if (d) this.hover.position.copy(d.clone().multiplyScalar(0.5)); this.cubeDirty = true; });
    cv.addEventListener('pointerleave', () => { this.hover.visible = false; this.cubeDirty = true; });
    cv.addEventListener('click', ev => { const d = pick(ev); if (d) { this.lastCubeDir = d.toArray(); this.flyTo(d); } });
  }
  /** Bildschirmposition eines Würfelpunkts (für Tests): d in [-1,1]^3, z. B. [1,-1,0] = Kante */
  cubeScreen(d) {
    this.renderCube(); const v = new THREE.Vector3(...d).multiplyScalar(0.45).project(this.cubeCam); const r = this.cubeCanvas.getBoundingClientRect();
    return [r.left + (v.x + 1) / 2 * r.width, r.top + (1 - v.y) / 2 * r.height];
  }
  renderCube() {
    const d = this.viewDir(); this.cubeCam.position.copy(d.multiplyScalar(3)); this.cubeCam.up.copy(this.camera.up); this.cubeCam.lookAt(0, 0, 0);
    // Kamera-Rollwinkel übernehmen
    this.cubeCam.quaternion.copy(this.camera.quaternion); this.cubeCam.position.copy(this.viewDir().multiplyScalar(3));
    const w = this.cubeCanvas.clientWidth, h = this.cubeCanvas.clientHeight;
    if (this.cubeCanvas.width !== Math.round(w * this.cubeR.getPixelRatio())) this.cubeR.setSize(w, h, false);
    const s = 0.95; this.cubeCam.left = -s; this.cubeCam.right = s; this.cubeCam.top = s; this.cubeCam.bottom = -s; this.cubeCam.updateProjectionMatrix();
    this.cubeR.render(this.cubeScene, this.cubeCam);
  }

  // ---------------------------------------------------------- Auswahl
  initPointer() {
    const el = this.renderer.domElement; let down = null;
    el.addEventListener('pointerdown', ev => { down = [ev.clientX, ev.clientY, performance.now()]; });
    el.addEventListener('pointerup', ev => {
      if (!down) return; const moved = Math.hypot(ev.clientX - down[0], ev.clientY - down[1]); const dt = performance.now() - down[2]; down = null;
      if (moved > 6 || dt > 600) return; this.pickAt(ev.clientX, ev.clientY);
    });
  }
  pickAt(cx, cy) {
    if (!this.mesh) return;
    const r = this.renderer.domElement.getBoundingClientRect();
    const v = new THREE.Vector2(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
    this.ray.setFromCamera(v, this.camera);
    const dist = this.camera.position.distanceTo(this.controls.target);
    this.ray.params.Line.threshold = dist * 0.012 * (matchMedia('(pointer: coarse)').matches ? 2 : 1);
    const hf = this.ray.intersectObject(this.mesh)[0];
    const he = this.opts.edges ? this.ray.intersectObjects(this.edgePick).filter(h => !hf || h.distance < hf.distance + dist * 0.01)[0] : null;
    if (he) return this.select({ kind: 'kante', index: he.object.userData.edge, point: he.point });
    if (hf) { const gi = this.groups.findIndex(g => hf.faceIndex * 3 >= g.start && hf.faceIndex * 3 < g.start + g.count); return this.select({ kind: 'flaeche', index: gi, point: hf.point }); }
    this.select(null);
  }
  select(s) {
    while (this.selGroup.children.length) { const o = this.selGroup.children.pop(); o.geometry.dispose(); o.material.dispose(); }
    this.sel = s; let hl = new Set();
    if (s && s.kind === 'flaeche') hl = new Set([s.index]);
    if (s && s.kind === 'kante') {
      const k = this.result.kanten[s.index]; const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(k.p, 3));
      const l = new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0xff3b30, depthTest: false })); l.renderOrder = 10; this.selGroup.add(l);
    }
    if (s && s.kind === 'pmi') hl = new Set(s.faces);
    this.restyle(hl); this.highlightLabel(s && s.kind === 'pmi' ? s.id : null);
    this.onPick(s);
  }
  selectSids(sids, id) { this.select({ kind: 'pmi', id, faces: sids.map(x => this.sidIndex.get(x)).filter(x => x != null) }); }

  // ---------------------------------------------------------- PMI
  buildPmi(items) {
    this.labels = [];
    const pos = []; const mat = new THREE.LineBasicMaterial({ color: 0xb8860b });
    for (const it of items) {
      pos.push(...it.anker_3d, ...it.label_3d);
      const div = document.createElement('div'); div.className = 'pmilabel'; div.dataset.id = it.id;
      const tol = it.passung ? ` ${it.passung}` : (it.tol_oben != null && it.tol_unten != null ? (Math.abs(it.tol_oben + it.tol_unten) < 1e-9 ? ` ±${fmt(it.tol_oben)}` : ` ${sgn(it.tol_oben)}/${sgn(it.tol_unten)}`) : '');
      const pre = it.typ === 'Durchmesser' || it.typ.startsWith('Teilkreis') ? 'Ø' : it.typ === 'Radius' ? 'R' : it.typ === 'Fase' ? '⦣' : '';
      div.textContent = `${pre}${fmt(it.nennmass)}${tol}${it.einheit === '°' ? '°' : ''}`;
      div.title = `${it.id} · ${it.typ} · ${it.text}`;
      div.addEventListener('click', e => { e.stopPropagation(); this.onPmiClick(it); });
      this.labelEl.appendChild(div);
      this.labels.push({ it, div, p: new THREE.Vector3(...it.label_3d) });
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    this.pmiGroup.add(new THREE.LineSegments(g, mat));
  }
  highlightLabel(id) { for (const l of this.labels || []) l.div.classList.toggle('aktiv', l.it.id === id); }
  placeLabels() {
    if (!this.labels || !this.opts.pmi) return;
    const w = this.el.clientWidth, h = this.el.clientHeight; const v = new THREE.Vector3();
    for (const l of this.labels) {
      v.copy(l.p).project(this.camera);
      const vis = v.z < 1 && Math.abs(v.x) < 1.2 && Math.abs(v.y) < 1.2;
      l.div.style.display = vis ? '' : 'none';
      if (vis) l.div.style.transform = `translate(${((v.x + 1) / 2 * w).toFixed(1)}px, ${((1 - v.y) / 2 * h).toFixed(1)}px) translate(-50%, -50%)`;
    }
  }

  // ---------------------------------------------------------- Rendern
  tick(t) {
    if (this.anim) {
      const a = this.anim; let k = Math.min(1, (t - a.t) / a.dur); const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
      const tgt = a.t0.clone().lerp(a.target, e);
      const dir = a.d0.clone().lerp(a.d1, e); if (dir.lengthSq() < 1e-6) dir.copy(a.d1); dir.normalize();
      this.controls.target.copy(tgt); this.camera.position.copy(tgt.clone().add(dir.multiplyScalar(a.l0 + (a.l1 - a.l0) * e)));
      this.camera.lookAt(tgt); this.dirty = true; if (k >= 1) { this.anim = null; this.controls.update(); }
    }
    const changed = this.controls.update();
    if (changed || this.dirty) {
      this.renderer.render(this.scene, this.camera); this.placeLabels(); this.renderCube(); this.dirty = false; this.cubeDirty = false;
    } else if (this.cubeDirty) { this.renderCube(); this.cubeDirty = false; }
  }
  snapshot() { return this.renderer.domElement.toDataURL('image/png'); }
}
const fmt = x => (Math.round(x * 1000) / 1000).toString().replace('.', ',');
const sgn = x => (x >= 0 ? '+' : '') + fmt(x);
