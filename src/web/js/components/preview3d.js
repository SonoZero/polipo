// Anteprima 3D della stampa con Three.js: il piatto con le misure della stampante e il pezzo
// disegnato con i percorsi del G-code, che cresce seguendo la stampa in corso.
// Three.js si carica solo quando serve (è grande), dalla copia dentro l'app.

import { layerAt } from './gcode-data.js';

let threePromise = null;

export function loadThree() {
  if (!threePromise) {
    threePromise = Promise.all([
      import('../../vendor/three/three.module.js'),
      import('../../vendor/three/OrbitControls.js'),
    ]).then(([THREE, oc]) => {
      // colori usati così come sono (come nel CSS), senza conversioni di spazio colore
      THREE.ColorManagement.enabled = false;
      return { THREE, OrbitControls: oc.OrbitControls };
    });
  }
  return threePromise;
}

// --- modello: segmenti di estrusione in 3D, nell'ordine del file ---------------------------

const models = new WeakMap();

/** Geometria del pezzo, calcolata una volta per ogni file analizzato. */
function buildModel(THREE, data) {
  const cached = models.get(data);
  if (cached) return cached;
  const layers = data.layers;
  let n = 0;
  for (const l of layers) for (let i = 0; i < l.type.length; i++) if (l.type[i] === 1) n++;

  const pos = new Float32Array(n * 6);
  const col = new Float32Array(n * 6);
  const offs = new Uint32Array(n);
  const layerStart = new Uint32Array(layers.length + 1);
  const zMin = layers.length ? layers[0].z : 0;
  const zMax = layers.length ? layers[layers.length - 1].z : 1;
  const span = zMax - zMin || 1;
  // arancione del filamento: più scuro in basso, più chiaro in alto, layer alternati appena diversi
  const lo = [0.58, 0.2, 0.05];
  const hi = [1.0, 0.56, 0.26];
  // ingombro del pezzo senza il primo layer, dove stanno linea di spurgo e skirt
  const skip = layers.length > 2 ? 1 : 0;
  let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
  let k = 0;
  for (let li = 0; li < layers.length; li++) {
    const l = layers[li];
    layerStart[li] = k;
    const t = (l.z - zMin) / span;
    const shade = li % 2 ? 0.9 : 1;
    const r = (lo[0] + (hi[0] - lo[0]) * t) * shade;
    const g = (lo[1] + (hi[1] - lo[1]) * t) * shade;
    const b = (lo[2] + (hi[2] - lo[2]) * t) * shade;
    for (let i = 0; i < l.type.length; i++) {
      if (l.type[i] !== 1) continue;
      const p = k * 6;
      pos[p] = l.seg[i * 4]; pos[p + 1] = l.seg[i * 4 + 1]; pos[p + 2] = l.z;
      pos[p + 3] = l.seg[i * 4 + 2]; pos[p + 4] = l.seg[i * 4 + 3]; pos[p + 5] = l.z;
      col[p] = r; col[p + 1] = g; col[p + 2] = b; col[p + 3] = r; col[p + 4] = g; col[p + 5] = b;
      offs[k] = l.off[i];
      if (li >= skip) {
        const x = l.seg[i * 4 + 2], y = l.seg[i * 4 + 3];
        if (x < bx0) bx0 = x; if (x > bx1) bx1 = x;
        if (y < by0) by0 = y; if (y > by1) by1 = y;
      }
      k++;
    }
  }
  layerStart[layers.length] = k;
  const position = new THREE.BufferAttribute(pos, 3);
  const color = new THREE.BufferAttribute(col, 3);
  const b = isFinite(bx0) ? { minX: bx0, minY: by0, maxX: bx1, maxY: by1 } : (data.bounds || { minX: 0, minY: 0, maxX: 0, maxY: 0 });
  const model = {
    count: n, position, color, offs, layerStart, data,
    box: { minX: b.minX, minY: b.minY, maxX: b.maxX, maxY: b.maxY, minZ: 0, maxZ: zMax },
  };
  models.set(data, model);
  return model;
}

function upperBound(arr, v) {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] <= v) lo = mid + 1; else hi = mid; }
  return lo;
}

// --- colori del tema ---------------------------------------------------------------------------

function cssColor(name) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const m = /^rgba?\(([^)]+)\)$/.exec(v);
  if (m) {
    const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    return { rgb: [p[0] / 255, p[1] / 255, p[2] / 255], a: p.length > 3 ? p[3] : 1 };
  }
  const hex = v.replace('#', '');
  const full = hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex;
  const int = parseInt(full.slice(0, 6), 16) || 0;
  return { rgb: [((int >> 16) & 255) / 255, ((int >> 8) & 255) / 255, (int & 255) / 255], a: 1 };
}

// --- scena ---------------------------------------------------------------------------------------

export class PrintScene {
  constructor(THREE) {
    this.T = THREE;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(32, 1, 1, 20000);
    this.camera.up.set(0, 0, 1);
    this.plate = new THREE.Group();
    this.scene.add(this.plate);
    this.volume = null;
    this.originCenter = false;
    this.model = null;
    this.parts = null;
    this.shown = { done: 0, current: 0 };

    this.mats = {
      done: new THREE.LineBasicMaterial({ vertexColors: true }),
      // il resto del pezzo: scrive la profondità così le linee sovrapposte non si sommano fino al bianco
      ghost: new THREE.LineBasicMaterial({ transparent: true, depthWrite: true }),
      current: new THREE.LineBasicMaterial(),
    };
    const cone = new THREE.ConeGeometry(2.4, 7, 24);
    cone.rotateX(-Math.PI / 2);
    cone.translate(0, 0, 3.5);
    this.nozzle = new THREE.Mesh(cone, new THREE.MeshBasicMaterial());
    this.nozzle.visible = false;
    this.scene.add(this.nozzle);
    this.applyTheme();
  }

  applyTheme() {
    const light = document.documentElement.dataset.theme === 'light';
    const faint = cssColor('--text-faint');
    this.mats.ghost.color.setRGB(...faint.rgb);
    this.mats.ghost.opacity = light ? 0.16 : 0.14;
    // layer in stampa: più chiaro del pezzo sul fondo scuro, più scuro su quello chiaro
    if (light) this.mats.current.color.setRGB(0.76, 0.25, 0.05);
    else this.mats.current.color.setRGB(1, 0.86, 0.72);
    this.nozzle.material.color.setRGB(...cssColor('--text').rgb);
    if (this.volume) this._buildPlate();
  }

  setVolume(vol, originCenter) {
    const v = { x: vol.x || 220, y: vol.y || 220, z: vol.z || 250 };
    if (this.volume && v.x === this.volume.x && v.y === this.volume.y && v.z === this.volume.z && !!originCenter === this.originCenter) return false;
    this.volume = v;
    this.originCenter = !!originCenter;
    this._buildPlate();
    return true;
  }

  _buildPlate() {
    const T = this.T;
    for (const c of [...this.plate.children]) {
      this.plate.remove(c);
      c.geometry.dispose();
      c.material.dispose();
    }
    const { x: vx, y: vy, z: vz } = this.volume;
    const x0 = this.originCenter ? -vx / 2 : 0;
    const y0 = this.originCenter ? -vy / 2 : 0;
    this.plateBox = { minX: x0, minY: y0, maxX: x0 + vx, maxY: y0 + vy, minZ: 0, maxZ: vz };

    const surface = cssColor('--surface-2');
    const plateGeo = new T.BoxGeometry(vx, vy, 2);
    plateGeo.translate(x0 + vx / 2, y0 + vy / 2, -1.05);
    this.plate.add(new T.Mesh(plateGeo, new T.MeshBasicMaterial({ color: new T.Color().setRGB(...surface.rgb) })));

    // griglia ogni 10 mm, linee più marcate ogni 50
    const minor = [], major = [];
    for (let gx = 0; gx <= vx + 0.01; gx += 10) (gx % 50 === 0 ? major : minor).push(x0 + gx, y0, 0, x0 + gx, y0 + vy, 0);
    for (let gy = 0; gy <= vy + 0.01; gy += 10) (gy % 50 === 0 ? major : minor).push(x0, y0 + gy, 0, x0 + vx, y0 + gy, 0);
    const line = (arr, token, boost = 1) => {
      const c = cssColor(token);
      const g = new T.BufferGeometry();
      g.setAttribute('position', new T.Float32BufferAttribute(arr, 3));
      return new T.LineSegments(g, new T.LineBasicMaterial({ color: new T.Color().setRGB(...c.rgb), transparent: true, opacity: Math.min(1, c.a * boost) }));
    };
    this.plate.add(line(minor, '--border', 1.4));
    this.plate.add(line(major, '--border-strong', 1.6));

    // ingombro del volume di stampa
    const edges = new T.EdgesGeometry(new T.BoxGeometry(vx, vy, vz));
    edges.translate(x0 + vx / 2, y0 + vy / 2, vz / 2);
    const ec = cssColor('--border');
    this.plate.add(new T.LineSegments(edges, new T.LineBasicMaterial({ color: new T.Color().setRGB(...ec.rgb), transparent: true, opacity: Math.min(1, ec.a * 1.2) })));
  }

  setData(data) {
    const T = this.T;
    if (this.parts) {
      for (const o of Object.values(this.parts)) { this.scene.remove(o); o.geometry.dispose(); }
      this.parts = null;
    }
    this.model = data && data.layers.length ? buildModel(T, data) : null;
    if (!this.model) return;
    const geo = (withColor) => {
      const g = new T.BufferGeometry();
      g.setAttribute('position', this.model.position);
      if (withColor) g.setAttribute('color', this.model.color);
      g.boundingSphere = new T.Sphere(new T.Vector3(), 1e6); // evita di ricalcolarla: il pezzo non va mai tagliato
      return g;
    };
    this.parts = {
      ghost: new T.LineSegments(geo(false), this.mats.ghost),
      done: new T.LineSegments(geo(true), this.mats.done),
      current: new T.LineSegments(geo(false), this.mats.current),
    };
    this.parts.ghost.renderOrder = 1;
    for (const o of Object.values(this.parts)) this.scene.add(o);
    this.showAll();
  }

  get layerCount() { return this.model ? this.model.data.layers.length : 0; }

  /** Tutto il pezzo, senza evidenziare nulla. */
  showAll() {
    if (!this.model) return;
    this._show(this.model.count, this.model.count, null);
  }

  /** Pezzo fino al layer indicato (compreso), con l'ultimo layer in evidenza. */
  showUpToLayer(li) {
    if (!this.model) return;
    const ls = this.model.layerStart;
    const i = Math.max(0, Math.min(this.layerCount - 1, li));
    this._show(ls[i + 1], ls[i], null);
  }

  /** Stampa in corso: parte stampata, layer corrente, ugello e resto in trasparenza. */
  showProgress(filePos) {
    if (!this.model) return -1;
    const done = upperBound(this.model.offs, filePos);
    const li = layerAt(this.model.data, filePos);
    const start = Math.min(this.model.layerStart[li], done);
    this._show(done, start, done > 0 && done < this.model.count ? done - 1 : null);
    return li;
  }

  _show(done, currentStart, nozzleSeg) {
    const p = this.parts;
    const n = this.model.count;
    p.done.geometry.setDrawRange(0, currentStart * 2);
    p.current.geometry.setDrawRange(currentStart * 2, (done - currentStart) * 2);
    p.ghost.geometry.setDrawRange(done * 2, (n - done) * 2);
    this.shown = { done, current: currentStart };
    if (nozzleSeg === null) {
      this.nozzle.visible = false;
    } else {
      const a = this.model.position.array;
      this.nozzle.position.set(a[nozzleSeg * 6 + 3], a[nozzleSeg * 6 + 4], a[nozzleSeg * 6 + 5]);
      this.nozzle.visible = true;
    }
  }

  setGhost(visible) {
    if (this.parts) this.parts.ghost.visible = visible;
  }

  /** Inquadra tutto il piatto ('plate') o solo il pezzo ('model'). */
  frame(mode = 'plate', controls = null) {
    const T = this.T;
    const pb = this.plateBox || { minX: 0, minY: 0, maxX: 220, maxY: 220, minZ: 0, maxZ: 0 };
    const mb = this.model && this.model.box.maxX > this.model.box.minX ? this.model.box : null;
    let box;
    if (mode === 'model' && mb) box = { ...mb };
    else box = { minX: pb.minX, minY: pb.minY, maxX: pb.maxX, maxY: pb.maxY, minZ: 0, maxZ: mb ? mb.maxZ : 20 };
    const cx = (box.minX + box.maxX) / 2, cy = (box.minY + box.maxY) / 2, cz = (box.minZ + box.maxZ) / 2;
    const radius = Math.max(8, 0.5 * Math.hypot(box.maxX - box.minX, box.maxY - box.minY, box.maxZ - box.minZ));
    const dist = radius / Math.sin(T.MathUtils.degToRad(this.camera.fov / 2)) * (mode === 'model' ? 1.02 : 0.92);
    const dir = new T.Vector3(-0.42, -1, 0.78).normalize();
    this.camera.position.set(cx + dir.x * dist, cy + dir.y * dist, cz + dir.z * dist);
    this.camera.near = Math.max(0.5, dist / 100);
    this.camera.far = dist * 20;
    this.camera.lookAt(cx, cy, cz);
    this.camera.updateProjectionMatrix();
    if (controls) { controls.target.set(cx, cy, cz); controls.update(); }
  }

  render(renderer, w, h) {
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    renderer.render(this.scene, this.camera);
  }

  dispose() {
    if (this.parts) for (const o of Object.values(this.parts)) o.geometry.dispose();
    for (const c of this.plate.children) { c.geometry.dispose(); c.material.dispose(); }
    for (const m of Object.values(this.mats)) m.dispose();
    this.nozzle.geometry.dispose();
    this.nozzle.material.dispose();
  }
}

// --- vista interattiva (si gira col mouse) ------------------------------------------------------

export async function createInteractive3D(box) {
  const { THREE, OrbitControls } = await loadThree();
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  } catch (_) {
    throw new Error('L\'anteprima 3D non è disponibile su questo computer (WebGL non attivo).');
  }
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.domElement.className = 'p3d-canvas';
  box.appendChild(renderer.domElement);

  const ps = new PrintScene(THREE);
  const controls = new OrbitControls(ps.camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.12;
  controls.screenSpacePanning = true;
  controls.zoomToCursor = true;
  controls.maxPolarAngle = Math.PI * 0.495;

  let raf = 0;
  const draw = () => {
    raf = 0;
    const w = box.clientWidth, h = box.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    controls.update();
    ps.render(renderer, w, h);
  };
  const request = () => { if (!raf) raf = requestAnimationFrame(draw); };
  controls.addEventListener('change', request);
  controls.addEventListener('start', request);
  const ro = new ResizeObserver(request);
  ro.observe(box);
  const onTheme = () => { ps.applyTheme(); request(); };
  window.addEventListener('themechange', onTheme);

  return {
    scene: ps,
    request,
    reset(mode) { ps.frame(mode, controls); request(); },
    destroy() {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener('themechange', onTheme);
      controls.dispose();
      ps.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
    },
  };
}

// --- miniature (Panoramica): un solo contesto WebGL condiviso, copiato su canvas normali -------

let sharedRenderer = null;

export async function createMini3D(canvas) {
  const { THREE } = await loadThree();
  if (!sharedRenderer) {
    sharedRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    sharedRenderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  }
  const ps = new PrintScene(THREE);
  const ctx = canvas.getContext('2d');
  const onTheme = () => { ps.applyTheme(); draw(); };
  window.addEventListener('themechange', onTheme);

  function draw() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.round(canvas.clientWidth * dpr), h = Math.round(canvas.clientHeight * dpr);
    if (!w || !h) return;
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    sharedRenderer.setPixelRatio(1);
    sharedRenderer.setSize(w, h, false);
    ps.render(sharedRenderer, w, h);
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(sharedRenderer.domElement, 0, 0, w, h);
  }

  return {
    scene: ps,
    draw,
    destroy() {
      window.removeEventListener('themechange', onTheme);
      ps.dispose();
    },
  };
}
