import * as THREE from "three";
import { Timer } from "three/addons/misc/Timer.js";
import cityJson from "./city.json";
import { createAvatar, poseAvatar, type AvatarId } from "./avatar";
import { DeferredPipeline, type SmokeVolume } from "./gfx/deferred";

type Ring = { x: number; z: number }[];

type Building = { p: number[]; h: number; k: string; name?: string };
type Road = { p: number[]; w: number; k: string; name?: string | null };
type Line = { p: number[]; w?: number; name?: string | null };
type Area = { p: number[]; name?: string | null };
type Patch = Area & { k: string };
type Poi = { x: number; z: number; name: string; kind: string };

type City = {
  spawn: { x: number; z: number; name: string };
  buildings: Building[];
  roads: Road[];
  water: Line[];
  lakes: Area[];
  greens: Patch[];
  rails: Line[];
  pois: Poi[];
};

export type Landmark = { id: string; name: string; kind: string };

type Bus = {
  current: {
    onProgress: (t: number, label: string) => void;
    onReady: (landmarks: Landmark[]) => void;
    onStreet: (street: string) => void;
    onDiscover: (id: string) => void;
    onNear: (place: { name: string; kind: string } | null) => void;
    onFail: (message: string) => void;
  };
};

export type GameHandle = {
  dispose: () => void;
  setAvatar: (id: AvatarId) => void;
  startWalk: () => void;
  backToSelect: () => void;
  returnToSquare: () => void;
  setKeys: (codes: string[]) => void;
  setTouch: (steer: number, throttle: number) => void;
  setRun: (on: boolean) => void;
  toggleSound: () => boolean;
  getYaw: () => number;
  getSpeed: () => number;
  cycleGfx: () => string;
  gfxLabel: () => string;
};

type Seg = { ax: number; az: number; bx: number; bz: number; rad: number; name: string | null; kind: string };
type Poly = { x: number[]; z: number[]; bb: [number, number, number, number] };

const city = cityJson as unknown as City;

declare global {
  interface Window {
    __controlsTest?: {
      getYaw: () => number;
      getSpeed: () => number;
      setSteer?: (v: number) => void;
      setKeys?: (codes: string[]) => void;
    };
  }
}

const sleep = () => new Promise((r) => setTimeout(r, 0));

class Grid<T> {
  private cell: number;
  private map = new Map<number, T[]>();
  constructor(cell: number) {
    this.cell = cell;
  }
  add(x0: number, z0: number, x1: number, z1: number, item: T) {
    const c = this.cell;
    const ix0 = Math.floor(Math.min(x0, x1) / c);
    const ix1 = Math.floor(Math.max(x0, x1) / c);
    const iz0 = Math.floor(Math.min(z0, z1) / c);
    const iz1 = Math.floor(Math.max(z0, z1) / c);
    for (let ix = ix0; ix <= ix1; ix++) {
      for (let iz = iz0; iz <= iz1; iz++) {
        const k = (ix * 73856093) ^ (iz * 19349663);
        let bucket = this.map.get(k);
        if (!bucket) {
          bucket = [];
          this.map.set(k, bucket);
        }
        bucket.push(item);
      }
    }
  }
  query(x: number, z: number, r: number, out: T[], seen: Set<T>) {
    out.length = 0;
    seen.clear();
    const c = this.cell;
    const ix0 = Math.floor((x - r) / c);
    const ix1 = Math.floor((x + r) / c);
    const iz0 = Math.floor((z - r) / c);
    const iz1 = Math.floor((z + r) / c);
    for (let ix = ix0; ix <= ix1; ix++) {
      for (let iz = iz0; iz <= iz1; iz++) {
        const bucket = this.map.get((ix * 73856093) ^ (iz * 19349663));
        if (!bucket) continue;
        for (const item of bucket) {
          if (seen.has(item)) continue;
          seen.add(item);
          out.push(item);
        }
      }
    }
  }
}

class Builder {
  pos: number[] = [];
  nrm: number[] = [];
  uv: number[] = [];
  col: number[] = [];
  idx: number[] = [];
  private n = 0;
  vert(x: number, y: number, z: number, nx: number, ny: number, nz: number, u: number, v: number, r: number, g: number, b: number) {
    this.pos.push(x, y, z);
    this.nrm.push(nx, ny, nz);
    this.uv.push(u, v);
    this.col.push(r, g, b);
    return this.n++;
  }
  geometry() {
    if (!this.n) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute("normal", new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute("uv", new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute("color", new THREE.Float32BufferAttribute(this.col, 3));
    g.setIndex(this.idx);
    return g;
  }
}

const color = new THREE.Color();
function rgb(hex: number): [number, number, number] {
  color.setHex(hex);
  return [color.r, color.g, color.b];
}

function pairs(flat: number[]): Ring {
  const out: Ring = [];
  for (let i = 0; i < flat.length; i += 2) out.push({ x: flat[i], z: flat[i + 1] });
  return out;
}

function areaOf(pts: Ring) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    a += pts[i].x * pts[j].z - pts[j].x * pts[i].z;
  }
  return a * 0.5;
}

function centroid(pts: Ring) {
  let a = 0;
  let cx = 0;
  let cz = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    const c = pts[i].x * pts[j].z - pts[j].x * pts[i].z;
    a += c;
    cx += (pts[i].x + pts[j].x) * c;
    cz += (pts[i].z + pts[j].z) * c;
  }
  if (Math.abs(a) < 1e-4) {
    let sx = 0;
    let sz = 0;
    for (const p of pts) {
      sx += p.x;
      sz += p.z;
    }
    return { x: sx / pts.length, z: sz / pts.length };
  }
  return { x: cx / (3 * a), z: cz / (3 * a) };
}

function distToSeg(x: number, z: number, s: Seg) {
  const dx = s.bx - s.ax;
  const dz = s.bz - s.az;
  const l2 = dx * dx + dz * dz;
  let t = l2 < 1e-6 ? 0 : ((x - s.ax) * dx + (z - s.az) * dz) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(x - (s.ax + t * dx), z - (s.az + t * dz));
}

function pointIn(x: number, z: number, xs: number[], zs: number[]) {
  let inside = false;
  for (let i = 0, j = xs.length - 1; i < xs.length; j = i++) {
    const xi = xs[i];
    const zi = zs[i];
    const xj = xs[j];
    const zj = zs[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

function hitsPoly(x: number, z: number, r: number, p: Poly) {
  if (x < p.bb[0] - r || x > p.bb[1] + r || z < p.bb[2] - r || z > p.bb[3] + r) return false;
  const n = p.x.length;
  let inside = false;
  const r2 = r * r;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = p.x[i];
    const zi = p.z[i];
    const xj = p.x[j];
    const zj = p.z[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
    const dx = xj - xi;
    const dz = zj - zi;
    const l2 = dx * dx + dz * dz;
    let t = l2 < 1e-8 ? 0 : ((x - xi) * dx + (z - zi) * dz) / l2;
    t = Math.max(0, Math.min(1, t));
    const ex = x - (xi + t * dx);
    const ez = z - (zi + t * dz);
    if (ex * ex + ez * ez < r2) return true;
  }
  return inside;
}

function facadeTexture() {
  const c = document.createElement("canvas");
  c.width = 128;
  c.height = 128;
  const g = c.getContext("2d");
  if (!g) return null;
  g.fillStyle = "#ffffff";
  g.fillRect(0, 0, 128, 128);
  for (let i = 0; i < 500; i++) {
    const a = Math.random() * 0.045;
    g.fillStyle = `rgba(40,30,20,${a})`;
    g.fillRect(Math.random() * 128, Math.random() * 128, 2, 2);
  }
  g.fillStyle = "#1b2833";
  g.fillRect(34, 26, 22, 38);
  g.fillRect(72, 26, 22, 38);
  g.fillStyle = "#9ec0d0";
  g.fillRect(36, 28, 8, 16);
  g.fillRect(74, 28, 8, 16);
  g.fillStyle = "#d9d0c2";
  g.fillRect(32, 64, 26, 4);
  g.fillRect(70, 64, 26, 4);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

function groundTexture() {
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 256;
  const g = c.getContext("2d");
  if (!g) return null;
  g.fillStyle = "#73825c";
  g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 1800; i++) {
    const shade = 90 + Math.floor(Math.random() * 50);
    g.fillStyle = `rgba(${shade - 20},${shade},${shade - 40},0.18)`;
    g.fillRect(Math.random() * 256, Math.random() * 256, 2, 2);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  // A finer, seamless field texture keeps broad OSM greens from reading as a flat plane.
  tex.repeat.set(420, 420);
  tex.anisotropy = 4;
  return tex;
}

function surfaceTexture(kind: "asphalt" | "concrete") {
  const c = document.createElement("canvas");
  c.width = 128;
  c.height = 128;
  const g = c.getContext("2d");
  if (!g) return null;
  g.fillStyle = kind === "asphalt" ? "#e5e3dd" : "#f4f1e9";
  g.fillRect(0, 0, 128, 128);
  let seed = kind === "asphalt" ? 0x53a1c7 : 0x1142b9;
  const rand = () => {
    seed = (Math.imul(seed ^ (seed >>> 15), 1 | seed) + 0x6d2b79f5) | 0;
    return ((seed ^ (seed >>> 14)) >>> 0) / 4294967296;
  };
  const flecks = kind === "asphalt" ? 1500 : 420;
  for (let i = 0; i < flecks; i++) {
    g.fillStyle = `rgba(35,32,28,${(0.018 + rand() * 0.06).toFixed(3)})`;
    g.fillRect(rand() * 128, rand() * 128, kind === "asphalt" ? 1 + rand() * 2 : 1, 1);
    if (kind === "asphalt" && i % 13 === 0) {
      g.fillStyle = `rgba(255,255,255,${(rand() * 0.06).toFixed(3)})`;
      g.fillRect(rand() * 128, rand() * 128, 2 + rand() * 7, 1);
    }
  }
  if (kind === "concrete") {
    g.strokeStyle = "rgba(70,62,50,0.12)";
    g.lineWidth = 1;
    for (let y = 0; y <= 128; y += 32) {
      g.beginPath(); g.moveTo(0, y + 0.5); g.lineTo(128, y + 0.5); g.stroke();
    }
    for (let row = 0; row < 4; row++) {
      const offset = row % 2 ? 16 : 0;
      for (let x = offset; x <= 128; x += 32) {
        g.beginPath(); g.moveTo(x + 0.5, row * 32); g.lineTo(x + 0.5, (row + 1) * 32); g.stroke();
      }
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

const WALLS: Record<string, number[]> = {
  house: [0xf4ecdf, 0xe6d3ae, 0xf7f1e6, 0xe7d4c6, 0xddd4c6],
  bata: [0xf7f4ee],
  block: [0xd4cfc4],
  industrial: [0xc8c4bb],
  civic: [0xf3ecdf],
  shop: [0xf8f1e4],
  church: [0xfbf7f0],
  shed: [0xb7ad9e],
};
const ROOFS: Record<string, number[]> = {
  house: [0x8e3a32, 0x6d4032, 0xa15a3e, 0x5c564e, 0x7c2f2e],
  bata: [0x9c342c],
  block: [0x6a6e73],
  industrial: [0x4a5156],
  civic: [0x6e3430],
  shop: [0x8a4034],
  church: [0x5a302c],
  shed: [0x6e675e],
};

function isLandmark(p: Poi) {
  const n = p.name.toLowerCase();
  if (["church", "monument", "memorial", "cinema", "station"].includes(p.kind)) return true;
  return /urząd miejski|miejski ośrodek|biblioteka|poczta|osp |fundacja|krasnal|młyńsk|galar|stawy|dworzec|kościół|kaplica|grunwald|faszyzm|aussen|plebania/.test(
    n,
  );
}

function addRibbon(b: Builder, pts: Ring, width: number, y: number, hex: number) {
  if (pts.length < 2) return;
  const [r, g, bl] = rgb(hex);
  const dirs: Ring = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const dx = pts[i + 1].x - pts[i].x;
    const dz = pts[i + 1].z - pts[i].z;
    const len = Math.hypot(dx, dz) || 1;
    dirs.push({ x: dx / len, z: dz / len });
  }
  const left: Ring = [];
  const right: Ring = [];
  let travelled = 0;
  const acc: number[] = [0];
  for (let i = 0; i < pts.length; i++) {
    let nx: number;
    let nz: number;
    if (i === 0) {
      nx = -dirs[0].z;
      nz = dirs[0].x;
    } else if (i === pts.length - 1) {
      const d = dirs[dirs.length - 1];
      nx = -d.z;
      nz = d.x;
    } else {
      const d0 = dirs[i - 1];
      const d1 = dirs[i];
      nx = -d0.z - d1.z;
      nz = d0.x + d1.x;
      const l = Math.hypot(nx, nz) || 1;
      nx /= l;
      nz /= l;
      const dot = nx * -d0.z + nz * d0.x;
      const scale = Math.min(2.1, 1 / Math.max(0.4, dot));
      nx *= scale;
      nz *= scale;
    }
    const h = width * 0.5;
    left.push({ x: pts[i].x + nx * h, z: pts[i].z + nz * h });
    right.push({ x: pts[i].x - nx * h, z: pts[i].z - nz * h });
    if (i > 0) {
      travelled += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
      acc.push(travelled);
    }
  }
  for (let i = 0; i < pts.length - 1; i++) {
    const u0 = acc[i] / 4;
    const u1 = acc[i + 1] / 4;
    const a = b.vert(left[i].x, y, left[i].z, 0, 1, 0, u0, 0, r, g, bl);
    const c = b.vert(right[i].x, y, right[i].z, 0, 1, 0, u0, 1, r, g, bl);
    const d = b.vert(right[i + 1].x, y, right[i + 1].z, 0, 1, 0, u1, 1, r, g, bl);
    const e = b.vert(left[i + 1].x, y, left[i + 1].z, 0, 1, 0, u1, 0, r, g, bl);
    b.idx.push(a, c, d, a, d, e);
  }
}

function addDashedRibbon(b: Builder, pts: Ring, width: number, y: number, hex: number, dash = 2.4, gap = 3.6) {
  const period = dash + gap;
  let travelled = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const c = pts[i + 1];
    const dx = c.x - a.x;
    const dz = c.z - a.z;
    const len = Math.hypot(dx, dz);
    if (len < 0.01) continue;
    let along = 0;
    while (along < len - 0.01) {
      const phase = (travelled + along) % period;
      const on = phase < dash;
      const advance = Math.min(len - along, on ? dash - phase : period - phase);
      if (on && advance > 0.12) {
        const t0 = along / len;
        const t1 = (along + advance) / len;
        addRibbon(
          b,
          [
            { x: a.x + dx * t0, z: a.z + dz * t0 },
            { x: a.x + dx * t1, z: a.z + dz * t1 },
          ],
          width,
          y,
          hex,
        );
      }
      along += Math.max(advance, 0.01);
    }
    travelled += len;
  }
}

function addBox(b: Builder, cx: number, cy: number, cz: number, sx: number, sy: number, sz: number, hex: number) {
  const [r, g, bl] = rgb(hex);
  const x0 = cx - sx / 2;
  const x1 = cx + sx / 2;
  const y0 = cy - sy / 2;
  const y1 = cy + sy / 2;
  const z0 = cz - sz / 2;
  const z1 = cz + sz / 2;
  const faces: [number, number, number, number, number, number, number, number, number, number, number, number, number, number, number][] = [
    [x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1, 0, 0, 1],
    [x1, y0, z0, x0, y0, z0, x0, y1, z0, x1, y1, z0, 0, 0, -1],
    [x0, y0, z0, x0, y0, z1, x0, y1, z1, x0, y1, z0, -1, 0, 0],
    [x1, y0, z1, x1, y0, z0, x1, y1, z0, x1, y1, z1, 1, 0, 0],
    [x0, y1, z1, x1, y1, z1, x1, y1, z0, x0, y1, z0, 0, 1, 0],
    [x0, y0, z0, x1, y0, z0, x1, y0, z1, x0, y0, z1, 0, -1, 0],
  ];
  for (const f of faces) {
    const a = b.vert(f[0], f[1], f[2], f[12], f[13], f[14], 0, 0, r, g, bl);
    const c = b.vert(f[3], f[4], f[5], f[12], f[13], f[14], 1, 0, r, g, bl);
    const d = b.vert(f[6], f[7], f[8], f[12], f[13], f[14], 1, 1, r, g, bl);
    const e = b.vert(f[9], f[10], f[11], f[12], f[13], f[14], 0, 1, r, g, bl);
    b.idx.push(a, c, d, a, d, e);
  }
}

export async function mountGame(opts: {
  view: HTMLCanvasElement;
  mini: HTMLCanvasElement;
  bus: Bus;
}): Promise<GameHandle> {
  const { view, mini, bus } = opts;
  const graphicsModes = ["Auto", "Płynnie", "Detale"] as const;
  let graphicsMode = 0;
  const mobileDevice = window.matchMedia("(pointer: coarse)").matches;
  const pixelRatioCap = (width: number) => {
    const compact = mobileDevice || width < 760;
    if (graphicsMode === 1) return compact ? 0.82 : 0.95;
    if (graphicsMode === 2) return compact ? 1.25 : 1.5;
    return compact ? 1.0 : 1.25;
  };
  const renderer = new THREE.WebGLRenderer({
    canvas: view,
    antialias: true,
    powerPreference: "high-performance",
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, pixelRatioCap(view.clientWidth || window.innerWidth)));
  renderer.setSize(view.clientWidth || window.innerWidth, view.clientHeight || window.innerHeight, false);
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  renderer.shadowMap.enabled = false;
  renderer.autoClear = false;
  const pipeline = new DeferredPipeline(renderer);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xd7c3a4);
  const camera = new THREE.PerspectiveCamera(48, 1, 0.15, 7000);
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(4200, 28, 16),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        top: { value: new THREE.Color(0x7eafd4) },
        horizon: { value: new THREE.Color(0xd7c3a4) },
        bottom: { value: new THREE.Color(0xc9b48f) },
      },
      vertexShader: `varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `varying vec3 vP; uniform vec3 top; uniform vec3 horizon; uniform vec3 bottom;
        void main(){
          vec3 n = normalize(vP);
          float h = n.y;
          vec3 col = mix(horizon, top, smoothstep(0.02, 0.62, h));
          col = mix(bottom, col, smoothstep(-0.2, 0.08, h));
          float sun = pow(max(dot(n, normalize(vec3(0.55, 0.32, 0.28))), 0.0), 160.0);
          col += vec3(1.0, 0.78, 0.5) * sun;
          gl_FragColor = vec4(col, 1.0);
        }`,
      glslVersion: THREE.GLSL1,
    }),
  );
  scene.add(sky);

  const hemi = new THREE.HemisphereLight(0xbfd4ea, 0x8d7a58, 0.78);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xffd7ae, 3.15);
  sun.castShadow = false;
  scene.add(sun);
  scene.add(sun.target);

  const gtex = groundTexture();
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(9000, 9000),
    new THREE.MeshStandardMaterial({ map: gtex ?? undefined, color: 0x73825c, roughness: 1 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  bus.current.onProgress(0.08, "Czytam ulice Chełmka…");
  await sleep();

  const polys: Poly[] = [];
  const polyGrid = new Grid<Poly>(14);
  for (const b of city.buildings) {
    const ring = pairs(b.p);
    if (ring.length < 3) continue;
    const xs = ring.map((p) => p.x);
    const zs = ring.map((p) => p.z);
    const poly: Poly = {
      x: xs,
      z: zs,
      bb: [Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)],
    };
    polys.push(poly);
    polyGrid.add(poly.bb[0], poly.bb[2], poly.bb[1], poly.bb[3], poly);
  }

  const roadSegs: Seg[] = [];
  const roadGrid = new Grid<Seg>(18);
  for (const road of city.roads) {
    const pts = pairs(road.p);
    for (let i = 0; i < pts.length - 1; i++) {
      const seg: Seg = {
        ax: pts[i].x,
        az: pts[i].z,
        bx: pts[i + 1].x,
        bz: pts[i + 1].z,
        rad: road.w * 0.5,
        name: road.name ?? null,
        kind: road.k,
      };
      roadSegs.push(seg);
      roadGrid.add(seg.ax, seg.az, seg.bx, seg.bz, seg);
    }
  }

  const waterSegs: Seg[] = [];
  const waterGrid = new Grid<Seg>(24);
  for (const w of city.water) {
    const pts = pairs(w.p);
    const rad = (w.w ?? 8) * 0.5;
    for (let i = 0; i < pts.length - 1; i++) {
      const seg: Seg = {
        ax: pts[i].x,
        az: pts[i].z,
        bx: pts[i + 1].x,
        bz: pts[i + 1].z,
        rad,
        name: w.name ?? null,
        kind: "water",
      };
      waterSegs.push(seg);
      waterGrid.add(seg.ax, seg.az, seg.bx, seg.bz, seg);
    }
  }

  const polyBuf: Poly[] = [];
  const polySeen = new Set<Poly>();
  const roadBuf: Seg[] = [];
  const roadSeen = new Set<Seg>();
  const waterBuf: Seg[] = [];
  const waterSeen = new Set<Seg>();

  function onRoad(x: number, z: number) {
    roadGrid.query(x, z, 16, roadBuf, roadSeen);
    for (const s of roadBuf) {
      if (s.kind === "path") continue;
      if (distToSeg(x, z, s) < s.rad + 1.4) return true;
    }
    return false;
  }

  function blocked(x: number, z: number) {
    if (x < -2050 || x > 2350 || z < -1950 || z > 1950) return true;
    polyGrid.query(x, z, 1.2, polyBuf, polySeen);
    for (const poly of polyBuf) if (hitsPoly(x, z, 0.42, poly)) return true;
    waterGrid.query(x, z, 22, waterBuf, waterSeen);
    for (const w of waterBuf) {
      if (distToSeg(x, z, w) < w.rad + 0.3 && !onRoad(x, z)) return true;
    }
    return false;
  }

  function freeSpot(x: number, z: number) {
    if (!blocked(x, z)) return { x, z };
    for (let rad = 1; rad < 28; rad += 0.9) {
      for (let a = 0; a < Math.PI * 2; a += 0.55) {
        const xx = x + Math.cos(a) * rad;
        const zz = z + Math.sin(a) * rad;
        if (!blocked(xx, zz)) return { x: xx, z: zz };
      }
    }
    return { x, z };
  }

  const wallChunks = new Map<string, Builder>();
  const roofChunks = new Map<string, Builder>();
  const crosses = new Builder();
  const chunkOf = (x: number, z: number, map: Map<string, Builder>) => {
    const key = `${Math.floor(x / 230)},${Math.floor(z / 230)}`;
    let b = map.get(key);
    if (!b) {
      b = new Builder();
      map.set(key, b);
    }
    return b;
  };

  function addBuilding(b: Building) {
    let pts = pairs(b.p);
    if (pts.length < 3) return;
    if (areaOf(pts) < 0) pts = pts.slice().reverse();
    const c = centroid(pts);
    const kind = WALLS[b.k] ? b.k : "house";
    const variant = Math.abs(Math.floor(pts[0].x * 13.1 + pts[0].z * 7.7)) % (WALLS[kind].length);
    const wallHex = WALLS[kind][variant] ?? WALLS[kind][0];
    const roofHex = ROOFS[kind][variant] ?? ROOFS[kind][0];
    const [wr, wg, wb] = rgb(wallHex);
    const [rr, rg, rb] = rgb(roofHex);
    const h = Math.max(2.4, b.h);
    const uv = kind === "industrial" ? 8.2 : kind === "shed" ? 6.5 : kind === "block" ? 3.15 : 3.35;
    const walls = chunkOf(c.x, c.z, wallChunks);
    const roofs = chunkOf(c.x, c.z, roofChunks);
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const d = pts[(i + 1) % pts.length];
      const dx = d.x - a.x;
      const dz = d.z - a.z;
      const len = Math.hypot(dx, dz);
      if (len < 0.15) continue;
      const mx = (a.x + d.x) / 2;
      const mz = (a.z + d.z) / 2;
      let nx = dz / len;
      let nz = -dx / len;
      if (nx * (c.x - mx) + nz * (c.z - mz) > 0) {
        nx = -nx;
        nz = -nz;
      }
      const u1 = len / uv;
      const v1 = h / uv;
      const i0 = walls.vert(a.x, 0, a.z, nx, 0, nz, 0, 0, wr, wg, wb);
      const i1 = walls.vert(d.x, 0, d.z, nx, 0, nz, u1, 0, wr, wg, wb);
      const i2 = walls.vert(d.x, h, d.z, nx, 0, nz, u1, v1, wr, wg, wb);
      const i3 = walls.vert(a.x, h, a.z, nx, 0, nz, 0, v1, wr, wg, wb);
      const fnx = -dz / len;
      const fnz = dx / len;
      if (fnx * nx + fnz * nz >= 0) walls.idx.push(i0, i1, i2, i0, i2, i3);
      else walls.idx.push(i0, i2, i1, i0, i3, i2);
    }
    const contour = pts.map((p) => new THREE.Vector2(p.x, p.z));
    let faces: number[][] = [];
    try {
      faces = THREE.ShapeUtils.triangulateShape(contour, []);
    } catch {
      faces = [];
    }
    const pushRoof = (ia: number, ib: number, ic: number) => {
      const pa = pts[ia];
      const pb = pts[ib];
      const pc = pts[ic];
      if (!pa || !pb || !pc) return;
      const abx = pb.x - pa.x;
      const abz = pb.z - pa.z;
      const acx = pc.x - pa.x;
      const acz = pc.z - pa.z;
      const ny = abz * acx - abx * acz;
      const y = h + 0.04;
      const a = roofs.vert(pa.x, y, pa.z, 0, 1, 0, pa.x / 6, pa.z / 6, rr, rg, rb);
      const b0 = roofs.vert(pb.x, y, pb.z, 0, 1, 0, pb.x / 6, pb.z / 6, rr, rg, rb);
      const c0 = roofs.vert(pc.x, y, pc.z, 0, 1, 0, pc.x / 6, pc.z / 6, rr, rg, rb);
      if (ny > 0) roofs.idx.push(a, b0, c0);
      else roofs.idx.push(a, c0, b0);
    };
    if (faces.length) {
      for (const f of faces) pushRoof(f[0], f[1], f[2]);
    } else {
      for (let i = 1; i < pts.length - 1; i++) pushRoof(0, i, i + 1);
    }
    if (kind === "church") {
      const side = Math.min(5.5, Math.max(2.4, Math.sqrt(Math.abs(areaOf(pts))) * 0.22));
      const th = h + side * 2.4;
      for (let i = 0; i < 4; i++) {
        const a0 = (i / 4) * Math.PI * 2 + Math.PI / 4;
        const a1 = ((i + 1) / 4) * Math.PI * 2 + Math.PI / 4;
        const x0 = c.x + Math.cos(a0) * side;
        const z0 = c.z + Math.sin(a0) * side;
        const x1 = c.x + Math.cos(a1) * side;
        const z1 = c.z + Math.sin(a1) * side;
        const nx = Math.cos((a0 + a1) / 2);
        const nz = Math.sin((a0 + a1) / 2);
        const i0 = walls.vert(x0, h, z0, nx, 0, nz, 0, 0, wr, wg, wb);
        const i1 = walls.vert(x1, h, z1, nx, 0, nz, 1, 0, wr, wg, wb);
        const i2 = walls.vert(x1, th, z1, nx, 0, nz, 1, 2, wr, wg, wb);
        const i3 = walls.vert(x0, th, z0, nx, 0, nz, 0, 2, wr, wg, wb);
        const tdx = x1 - x0;
        const tdz = z1 - z0;
        const tlen = Math.hypot(tdx, tdz) || 1;
        const fnx = -tdz / tlen;
        const fnz = tdx / tlen;
        if (fnx * nx + fnz * nz >= 0) walls.idx.push(i0, i1, i2, i0, i2, i3);
        else walls.idx.push(i0, i2, i1, i0, i3, i2);
      }
      const tip = th + side * 1.35;
      for (let i = 0; i < 4; i++) {
        const a0 = (i / 4) * Math.PI * 2 + Math.PI / 4;
        const a1 = ((i + 1) / 4) * Math.PI * 2 + Math.PI / 4;
        const x0 = c.x + Math.cos(a0) * side;
        const z0 = c.z + Math.sin(a0) * side;
        const x1 = c.x + Math.cos(a1) * side;
        const z1 = c.z + Math.sin(a1) * side;
        const a = roofs.vert(x0, th, z0, 0, 1, 0, 0, 0, rr, rg, rb);
        const b0 = roofs.vert(x1, th, z1, 0, 1, 0, 1, 0, rr, rg, rb);
        const c0 = roofs.vert(c.x, tip, c.z, 0, 1, 0, 0.5, 1, rr, rg, rb);
        roofs.idx.push(a, b0, c0);
      }
      addBox(crosses, c.x, tip + 1.5, c.z, 0.16, 2.1, 0.16, 0xb8893d);
      addBox(crosses, c.x, tip + 2.15, c.z, 1.15, 0.16, 0.16, 0xb8893d);
    }
  }

  for (let i = 0; i < city.buildings.length; i++) {
    addBuilding(city.buildings[i]);
    if (i > 0 && i % 450 === 0) {
      bus.current.onProgress(0.12 + (0.4 * i) / city.buildings.length, "Stawiam domy i dachy…");
      await sleep();
    }
  }

  const ftex = facadeTexture();
  const wallMat = new THREE.MeshStandardMaterial({
    map: ftex ?? undefined,
    vertexColors: true,
    roughness: 0.9,
    metalness: 0,
  });
  const roofMat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.94,
    metalness: 0,
    side: THREE.DoubleSide,
  });
  const addChunks = (map: Map<string, Builder>, material: THREE.Material) => {
    for (const b of map.values()) {
      const g = b.geometry();
      if (!g) continue;
      const mesh = new THREE.Mesh(g, material);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      scene.add(mesh);
    }
  };
  addChunks(wallChunks, wallMat);
  addChunks(roofChunks, roofMat);
  const crossGeo = crosses.geometry();
  if (crossGeo) {
    const mesh = new THREE.Mesh(
      crossGeo,
      new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.45, metalness: 0.25 }),
    );
    mesh.castShadow = true;
    scene.add(mesh);
  }

  bus.current.onProgress(0.58, "Kładę asfalt i Przemszę…");
  await sleep();

  const asphalt = new Builder();
  const sidewalk = new Builder();
  const paths = new Builder();
  const marks = new Builder();
  for (const road of city.roads) {
    const pts = pairs(road.p);
    if (road.k === "path") addRibbon(paths, pts, road.w, 0.035, 0x8d846f);
    else {
      if (road.k === "main" || road.k === "street") addRibbon(sidewalk, pts, road.w + 2.3, 0.03, 0xc4bbaa);
      addRibbon(asphalt, pts, road.w, 0.055, road.k === "service" ? 0x4a4e52 : 0x3a3e42);
      if (road.k === "main") addDashedRibbon(marks, pts, 0.13, 0.075, 0xe3d8b5);
    }
  }
  const railBed = new Builder();
  const railSteel = new Builder();
  for (const rail of city.rails) {
    const pts = pairs(rail.p);
    addRibbon(railBed, pts, 4.2, 0.03, 0x5c564e);
    const left: Ring = [];
    const right: Ring = [];
    for (let i = 0; i < pts.length; i++) {
      const prev = pts[Math.max(0, i - 1)];
      const next = pts[Math.min(pts.length - 1, i + 1)];
      const dx = next.x - prev.x;
      const dz = next.z - prev.z;
      const len = Math.hypot(dx, dz) || 1;
      const nx = -dz / len;
      const nz = dx / len;
      left.push({ x: pts[i].x + nx * 0.75, z: pts[i].z + nz * 0.75 });
      right.push({ x: pts[i].x - nx * 0.75, z: pts[i].z - nz * 0.75 });
    }
    addRibbon(railSteel, left, 0.16, 0.08, 0x9aa1a6);
    addRibbon(railSteel, right, 0.16, 0.08, 0x9aa1a6);
  }
  const asphaltTex = surfaceTexture("asphalt");
  const concreteTex = surfaceTexture("concrete");
  const flatMat = (rough: number, map?: THREE.Texture | null) =>
    new THREE.MeshStandardMaterial({ vertexColors: true, roughness: rough, metalness: 0, map: map ?? undefined });
  for (const [b, rough, shadow, map] of [
    [asphalt, 0.92, true, asphaltTex],
    [sidewalk, 0.96, true, concreteTex],
    [paths, 1, false, null],
    [marks, 0.7, false, null],
    [railBed, 1, false, null],
    [railSteel, 0.4, false, null],
  ] as [Builder, number, boolean, THREE.Texture | null][]) {
    const g = b.geometry();
    if (!g) continue;
    const mesh = new THREE.Mesh(g, flatMat(rough, map));
    mesh.receiveShadow = true;
    mesh.castShadow = shadow;
    scene.add(mesh);
  }

  const waterMeshB = new Builder();
  const sandB = new Builder();
  for (const w of city.water) {
    const pts = pairs(w.p);
    const width = w.w ?? 8;
    addRibbon(sandB, pts, width + 7, 0.01, 0xc6b48a);
    addRibbon(waterMeshB, pts, width, -0.18, 0x2f636e);
  }
  for (const lake of city.lakes) {
    const pts = pairs(lake.p);
    if (pts.length < 3) continue;
    const xs = pts.map((p) => p.x);
    const zs = pts.map((p) => p.z);
    if (Math.max(...xs) - Math.min(...xs) > 420 || Math.max(...zs) - Math.min(...zs) > 420) continue;
    const contour = pts.map((p) => new THREE.Vector2(p.x, p.z));
    if (areaOf(pts) < 0) contour.reverse();
    try {
      const faces = THREE.ShapeUtils.triangulateShape(contour, []);
      const [r, g, bl] = rgb(0x2f636e);
      const ring = contour.map((v) => ({ x: v.x, z: v.y }));
      for (const f of faces) {
        const tri = f.map((i) => ring[i]);
        if (tri.length < 3 || tri.some((p) => !p)) continue;
        const a = waterMeshB.vert(tri[0].x, -0.18, tri[0].z, 0, 1, 0, 0, 0, r, g, bl);
        const b = waterMeshB.vert(tri[1].x, -0.18, tri[1].z, 0, 1, 0, 1, 0, r, g, bl);
        const c = waterMeshB.vert(tri[2].x, -0.18, tri[2].z, 0, 1, 0, 0, 1, r, g, bl);
        waterMeshB.idx.push(a, b, c);
      }
    } catch {
      /* skip broken lake */
    }
  }
  for (const [b, hexRough] of [
    [sandB, 1],
    [waterMeshB, 0.28],
  ] as [Builder, number][]) {
    const g = b.geometry();
    if (!g) continue;
    const mesh = new THREE.Mesh(g, flatMat(hexRough));
    mesh.receiveShadow = true;
    scene.add(mesh);
  }

  const greenMat: Record<string, THREE.MeshStandardMaterial> = {
    forest: new THREE.MeshStandardMaterial({ color: 0x24382c, roughness: 1 }),
    park: new THREE.MeshStandardMaterial({ color: 0x3d6a46, roughness: 1 }),
    grass: new THREE.MeshStandardMaterial({ color: 0x5b7849, roughness: 1 }),
    pitch: new THREE.MeshStandardMaterial({ color: 0x2f6a40, roughness: 1 }),
  };
  for (const patch of city.greens) {
    const pts = pairs(patch.p);
    if (pts.length < 3) continue;
    let x0 = Infinity;
    let x1 = -Infinity;
    let z0 = Infinity;
    let z1 = -Infinity;
    for (const p of pts) {
      x0 = Math.min(x0, p.x);
      x1 = Math.max(x1, p.x);
      z0 = Math.min(z0, p.z);
      z1 = Math.max(z1, p.z);
    }
    if (x1 - x0 > 2400 || z1 - z0 > 2400) continue;
    const shape = new THREE.Shape(pts.map((p) => new THREE.Vector2(p.x, p.z)));
    try {
      const geo = new THREE.ShapeGeometry(shape);
      geo.rotateX(Math.PI / 2);
      geo.translate(0, patch.k === "pitch" ? 0.028 : patch.k === "park" ? 0.018 : 0.012, 0);
      const mesh = new THREE.Mesh(geo, greenMat[patch.k] ?? greenMat.grass);
      mesh.receiveShadow = true;
      scene.add(mesh);
    } catch {
      /* skip a broken patch */
    }
  }

  bus.current.onProgress(0.78, "Sadzę sosny wzdłuż ulic…");
  await sleep();

  const pines: { x: number; z: number; s: number; rot: number }[] = [];
  const leaves: { x: number; z: number; s: number; rot: number }[] = [];
  const pushTree = (x: number, z: number, pine: boolean, s: number) => {
    if (blocked(x, z)) return;
    (pine ? pines : leaves).push({ x, z, s, rot: Math.random() * Math.PI });
  };
  for (const road of city.roads) {
    if (road.k === "service" || road.k === "path") continue;
    if (leaves.length > 700) break;
    const pts = pairs(road.p);
    for (let i = 0; i < pts.length - 1; i++) {
      const dx = pts[i + 1].x - pts[i].x;
      const dz = pts[i + 1].z - pts[i].z;
      const len = Math.hypot(dx, dz);
      if (len < 8) continue;
      const nx = -dz / len;
      const nz = dx / len;
      const step = 18;
      for (let d = 6; d < len; d += step) {
        const t = d / len;
        const x = pts[i].x + dx * t;
        const z = pts[i].z + dz * t;
        const off = road.w * 0.5 + 2.1;
        if ((Math.floor(x + z) & 1) === 0) pushTree(x + nx * off, z + nz * off, false, 0.85 + (Math.abs(Math.sin(x)) * 0.4));
        else pushTree(x - nx * off, z - nz * off, false, 0.8 + Math.abs(Math.cos(z)) * 0.45);
      }
    }
  }
  for (const patch of city.greens) {
    if (patch.k !== "forest" && patch.k !== "park") continue;
    if (pines.length > 1400) break;
    const pts = pairs(patch.p);
    const xs = pts.map((p) => p.x);
    const zs = pts.map((p) => p.z);
    const x0 = Math.min(...xs);
    const x1 = Math.max(...xs);
    const z0 = Math.min(...zs);
    const z1 = Math.max(...zs);
    if (x1 - x0 > 1800 || z1 - z0 > 1800) continue;
    const step = patch.k === "forest" ? 12 : 16;
    let placed = 0;
    const cap = patch.k === "forest" ? 70 : 24;
    for (let x = x0 + step * 0.5; x < x1 && placed < cap; x += step) {
      for (let z = z0 + step * 0.5; z < z1 && placed < cap; z += step) {
        const jx = x + Math.sin(x * 0.17 + z) * 2.5;
        const jz = z + Math.cos(z * 0.13) * 2.5;
        if (!pointIn(jx, jz, xs, zs)) continue;
        pushTree(jx, jz, patch.k === "forest", patch.k === "forest" ? 1.15 : 0.95);
        placed++;
      }
    }
  }

  const dummy = new THREE.Object3D();
  if (pines.length + leaves.length > 0) {
    const trunkGeo = new THREE.CylinderGeometry(0.11, 0.16, 1, 5);
    trunkGeo.translate(0, 0.5, 0);
    const trunks = new THREE.InstancedMesh(
      trunkGeo,
      new THREE.MeshStandardMaterial({ color: 0x6b5344, roughness: 0.9 }),
      pines.length + leaves.length,
    );
    let ti = 0;
    const placeTrunk = (t: { x: number; z: number; s: number; rot: number }, h: number) => {
      dummy.position.set(t.x, 0, t.z);
      dummy.rotation.set(0, t.rot, 0);
      dummy.scale.set(t.s, h, t.s);
      dummy.updateMatrix();
      trunks.setMatrixAt(ti++, dummy.matrix);
    };
    for (const t of pines) placeTrunk(t, 1.05);
    for (const t of leaves) placeTrunk(t, 0.85);
    trunks.instanceMatrix.needsUpdate = true;
    trunks.castShadow = true;
    trunks.receiveShadow = true;
    scene.add(trunks);
  }

  if (pines.length) {
    const cone = new THREE.ConeGeometry(1, 1, 7);
    cone.translate(0, 0.5, 0);
    const mesh = new THREE.InstancedMesh(
      cone,
      new THREE.MeshStandardMaterial({ color: 0x2c4c36, roughness: 0.92 }),
      pines.length,
    );
    pines.forEach((t, i) => {
      dummy.position.set(t.x, 0.85 * t.s, t.z);
      dummy.rotation.set(0, t.rot, 0);
      dummy.scale.set(1.15 * t.s, 3.5 * t.s, 1.15 * t.s);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    });
    mesh.castShadow = true;
    mesh.instanceMatrix.needsUpdate = true;
    scene.add(mesh);
  }
  if (leaves.length) {
    const mesh = new THREE.InstancedMesh(
      new THREE.SphereGeometry(1, 8, 6),
      new THREE.MeshStandardMaterial({ color: 0x4c7844, roughness: 0.9 }),
      leaves.length,
    );
    leaves.forEach((t, i) => {
      dummy.position.set(t.x, 1.7 * t.s, t.z);
      dummy.rotation.set(0, t.rot, 0);
      dummy.scale.set(1.25 * t.s, 1.05 * t.s, 1.25 * t.s);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    });
    mesh.castShadow = true;
    mesh.instanceMatrix.needsUpdate = true;
    scene.add(mesh);
  }

  const cars: { x: number; z: number; rot: number; color: number }[] = [];
  const carColors = [0xf4f1ea, 0x9c3b2e, 0x243f34, 0x3a4250, 0xc9843a];
  for (const road of city.roads) {
    if (road.k !== "street" && road.k !== "main") continue;
    if (cars.length > 180) break;
    const pts = pairs(road.p);
    for (let i = 0; i < pts.length - 1; i++) {
      const dx = pts[i + 1].x - pts[i].x;
      const dz = pts[i + 1].z - pts[i].z;
      const len = Math.hypot(dx, dz);
      if (len < 16) continue;
      const nx = -dz / len;
      const nz = dx / len;
      for (let d = 8; d < len; d += 26) {
        if (Math.abs(Math.sin(pts[i].x * 0.2 + d)) < 0.35) continue;
        const t = d / len;
        const side = Math.sin(pts[i].z + d) > 0 ? 1 : -1;
        const x = pts[i].x + dx * t + nx * side * (road.w * 0.32);
        const z = pts[i].z + dz * t + nz * side * (road.w * 0.32);
        if (blocked(x, z)) continue;
        cars.push({
          x,
          z,
          rot: Math.atan2(dx * side, dz * side),
          color: carColors[cars.length % carColors.length],
        });
        if (cars.length > 180) break;
      }
    }
  }
  if (cars.length) {
    const body = new THREE.BoxGeometry(1.7, 0.55, 4.05);
    const cabin = new THREE.BoxGeometry(1.45, 0.48, 2.1);
    for (const hex of carColors) {
      const group = cars.filter((c) => c.color === hex);
      if (!group.length) continue;
      const bodyMesh = new THREE.InstancedMesh(
        body,
        new THREE.MeshStandardMaterial({ color: hex, roughness: 0.45, metalness: 0.2 }),
        group.length,
      );
      const glassMesh = new THREE.InstancedMesh(
        cabin,
        new THREE.MeshStandardMaterial({ color: 0x24343e, roughness: 0.25, metalness: 0.1 }),
        group.length,
      );
      group.forEach((c, i) => {
        dummy.position.set(c.x, 0.45, c.z);
        dummy.rotation.set(0, c.rot, 0);
        dummy.scale.set(1, 1, 1);
        dummy.updateMatrix();
        bodyMesh.setMatrixAt(i, dummy.matrix);
        dummy.position.set(c.x, 0.9, c.z);
        dummy.updateMatrix();
        glassMesh.setMatrixAt(i, dummy.matrix);
      });
      bodyMesh.castShadow = true;
      glassMesh.castShadow = true;
      bodyMesh.instanceMatrix.needsUpdate = true;
      glassMesh.instanceMatrix.needsUpdate = true;
      scene.add(bodyMesh, glassMesh);
    }
  }

  const pois: Poi[] = city.pois.map((p) => ({ ...p }));
  let riverPoint: { x: number; z: number } | null = null;
  let riverBest = Infinity;
  for (const w of city.water) {
    if (!w.name || !w.name.toLowerCase().includes("przem")) continue;
    const pts = pairs(w.p);
    for (const p of pts) {
      const d = (p.x - city.spawn.x) ** 2 + (p.z - city.spawn.z) ** 2;
      if (d < riverBest && d > 80 * 80) {
        riverBest = d;
        riverPoint = p;
      }
    }
  }
  if (riverPoint) pois.push({ x: riverPoint.x, z: riverPoint.z, name: "Przemsza", kind: "river" });

  const seenNames = new Set<string>();
  const landmarks: (Landmark & { x: number; z: number })[] = [];
  for (const p of pois) {
    if (!isLandmark(p) && p.kind !== "river") continue;
    const key = p.name.trim().toLowerCase();
    if (seenNames.has(key)) continue;
    seenNames.add(key);
    landmarks.push({
      id: key.replace(/\s+/g, "-"),
      name: p.name,
      kind: p.kind,
      x: p.x,
      z: p.z,
    });
  }
  const found = new Set<string>();

  const spawn = freeSpot(city.spawn.x, city.spawn.z);
  const ids: AvatarId[] = ["maja", "olek", "rysiek"];
  const roster = ids.map((id, i) => {
    const group = createAvatar(id);
    const spot = freeSpot(spawn.x + (i - 1) * 1.8, spawn.z);
    const home = new THREE.Vector3(spot.x, 0, spot.z);
    group.position.copy(home);
    scene.add(group);
    return { id, group, home, phase: i };
  });

  let selected: AvatarId = "maja";
  let playing = false;
  let px = roster[0].home.x;
  let pz = roster[0].home.z;
  let yaw = 0;
  let speed = 0;
  let touchSteer = 0;
  let touchThrottle = 0;
  let touchRun = false;
  let steerOverride: number | null = null;
  const keys = new Set<string>();
  let street = city.spawn.name;
  let nearKey = "";
  let clockAcc = 0;
  let soundOn = false;
  let audio: AudioContext | null = null;
  let wind: GainNode | null = null;

  const desired = new THREE.Vector3();
  const look = new THREE.Vector3();
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();

  function resize() {
    const w = view.clientWidth || window.innerWidth;
    const h = view.clientHeight || window.innerHeight;
    camera.aspect = w / Math.max(1, h);
    camera.updateProjectionMatrix();
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, pixelRatioCap(w)));
    renderer.setSize(w, h, false);
    pipeline.setSize(Math.floor(w * renderer.getPixelRatio()), Math.floor(h * renderer.getPixelRatio()));
  }
  resize();

  function paintDisc() {
    for (const r of roster) {
      const disc = r.group.userData.disc as THREE.Mesh;
      const m = disc.material as THREE.MeshBasicMaterial;
      const on = r.id === selected;
      m.color.setHex(on ? 0x9c3b2e : 0xe2d6c4);
      disc.scale.setScalar(on ? 1.2 : 0.82);
    }
  }
  paintDisc();

  const miniCtx = mini.getContext("2d");
  function drawMini() {
    if (!miniCtx) return;
    const w = mini.clientWidth || 148;
    const h = mini.clientHeight || 148;
    const dpr = 2;
    if (mini.width !== Math.floor(w * dpr)) {
      mini.width = Math.floor(w * dpr);
      mini.height = Math.floor(h * dpr);
    }
    const ctx = miniCtx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "#243f34";
    ctx.fillRect(0, 0, w, h);
    const cx = w / 2;
    const cy = h / 2;
    const ppm = (w * 0.46) / 120;
    const focusX = playing ? px : spawn.x;
    const focusZ = playing ? pz : spawn.z;
    const toS = (x: number, z: number) => [cx + (x - focusX) * ppm, cy + (z - focusZ) * ppm];
    ctx.lineCap = "round";
    ctx.strokeStyle = "rgba(198,180,138,0.9)";
    ctx.lineWidth = 3;
    ctx.beginPath();
    for (const s of waterSegs) {
      if (Math.hypot(s.ax - focusX, s.az - focusZ) > 150 && Math.hypot(s.bx - focusX, s.bz - focusZ) > 150) continue;
      const [x0, y0] = toS(s.ax, s.az);
      const [x1, y1] = toS(s.bx, s.bz);
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
    }
    ctx.stroke();
    ctx.strokeStyle = "rgba(246,241,231,0.85)";
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    for (const s of roadSegs) {
      if (s.kind === "path" || s.kind === "service") continue;
      if (Math.hypot((s.ax + s.bx) / 2 - focusX, (s.az + s.bz) / 2 - focusZ) > 145) continue;
      const [x0, y0] = toS(s.ax, s.az);
      const [x1, y1] = toS(s.bx, s.bz);
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
    }
    ctx.stroke();
    for (const mark of landmarks) {
      const [x, y] = toS(mark.x, mark.z);
      if (x < 6 || y < 6 || x > w - 6 || y > h - 6) continue;
      ctx.fillStyle = found.has(mark.id) ? "#b8893d" : "#f6f1e7";
      ctx.beginPath();
      ctx.arc(x, y, 2.4, 0, Math.PI * 2);
      ctx.fill();
    }
    const [hx, hy] = toS(focusX, focusZ);
    ctx.save();
    ctx.translate(hx, hy);
    const face = playing ? yaw : Math.PI;
    ctx.rotate(face);
    ctx.fillStyle = "#9c3b2e";
    ctx.beginPath();
    ctx.moveTo(0, -7);
    ctx.lineTo(5, 6);
    ctx.lineTo(-5, 6);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    ctx.fillStyle = "#f6f1e7";
    ctx.font = "600 11px Outfit, sans-serif";
    ctx.fillText("N", cx - 4, 16);
  }

  function toggleSound() {
    soundOn = !soundOn;
    if (soundOn) {
      if (!audio) {
        audio = new AudioContext();
        const buffer = audio.createBuffer(1, audio.sampleRate * 2, audio.sampleRate);
        const data = buffer.getChannelData(0);
        for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
        const src = audio.createBufferSource();
        src.buffer = buffer;
        src.loop = true;
        const filter = audio.createBiquadFilter();
        filter.type = "lowpass";
        filter.frequency.value = 420;
        wind = audio.createGain();
        wind.gain.value = 0.018;
        src.connect(filter);
        filter.connect(wind);
        wind.connect(audio.destination);
        src.start();
      }
      void audio.resume();
      if (wind) wind.gain.value = 0.018;
    } else if (wind) wind.gain.value = 0;
    return soundOn;
  }

  const onKeyDown = (e: KeyboardEvent) => {
    if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space"].includes(e.code)) e.preventDefault();
    keys.add(e.code);
  };
  const onKeyUp = (e: KeyboardEvent) => keys.delete(e.code);
  const clearKeys = () => keys.clear();
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", clearKeys);
  window.addEventListener("resize", resize);
  const onPointer = (e: PointerEvent) => {
    if (playing) return;
    const rect = view.getBoundingClientRect();
    ndc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    ndc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(ndc, camera);
    const hits = raycaster.intersectObjects(
      roster.map((r) => r.group),
      true,
    );
    let obj: THREE.Object3D | null = hits[0]?.object ?? null;
    while (obj) {
      if (obj.userData.avatarId) {
        selected = obj.userData.avatarId as AvatarId;
        paintDisc();
        bus.current.onStreet(street);
        break;
      }
      obj = obj.parent;
    }
  };
  view.addEventListener("pointerdown", onPointer);

  const timer = new Timer();
  let elapsed = 0;
  const tmpSun = new THREE.Vector3();
  const sunDir = new THREE.Vector3();
  const smoke: SmokeVolume[] = [
    { x: spawn.x + 7, y: 0.35, z: spawn.z - 5, r: 12, density: 0.28 },
    { x: spawn.x - 18, y: 0.4, z: spawn.z + 11, r: 9, density: 0.2 },
    { x: spawn.x + 20, y: 1.4, z: spawn.z + 2, r: 3.4, density: 0.9, rise: true },
    {
      x: riverPoint?.x ?? spawn.x + 36,
      y: 0.2,
      z: riverPoint?.z ?? spawn.z + 28,
      r: 28,
      density: 0.16,
    },
  ];
  pipeline.setSmoke(smoke);

  renderer.setAnimationLoop((stamp) => {
    timer.update(stamp);
    const dt = Math.min(timer.getDelta(), 0.05);
    elapsed += dt;
    if (playing) {
      let steer = 0;
      if (keys.has("KeyA") || keys.has("ArrowLeft")) steer += 1;
      if (keys.has("KeyD") || keys.has("ArrowRight")) steer -= 1;
      steer = Math.max(-1, Math.min(1, steer + touchSteer));
      if (steerOverride !== null) steer = steerOverride;
      let throttle = 0;
      if (keys.has("KeyW") || keys.has("ArrowUp")) throttle += 1;
      if (keys.has("KeyS") || keys.has("ArrowDown")) throttle -= 1;
      throttle = Math.max(-1, Math.min(1, throttle + touchThrottle));
      const run = touchRun || keys.has("ShiftLeft") || keys.has("ShiftRight");
      const target = throttle > 0 ? (run ? 8.4 : 4.05) : throttle < 0 ? -2.4 : 0;
      speed += (target - speed) * (1 - Math.exp(-7 * dt));
      if (Math.abs(speed) < 0.02 && throttle === 0) speed = 0;
      yaw += steer * 2.45 * dt;
      const fx = -Math.sin(yaw);
      const fz = -Math.cos(yaw);
      const nx = px + fx * speed * dt;
      const nz = pz + fz * speed * dt;
      if (!blocked(nx, nz)) {
        px = nx;
        pz = nz;
      } else if (!blocked(nx, pz)) px = nx;
      else if (!blocked(px, nz)) pz = nz;
      else speed *= 0.4;
    } else speed = 0;

    for (const r of roster) {
      const active = playing && r.id === selected;
      if (active) {
        r.group.position.set(px, 0, pz);
        r.group.rotation.y = yaw + Math.PI;
        r.phase += dt * (1.6 + Math.min(1, Math.abs(speed) / 3) * 8);
        poseAvatar(r.group, speed, r.phase, reduce);
      } else {
        r.group.position.copy(r.home);
        r.group.rotation.y = 0;
        r.phase += dt * 1.3;
        poseAvatar(r.group, 0, r.phase, reduce);
      }
    }

    const narrow = (view.clientWidth || window.innerWidth) < 760;
    if (!playing) {
      const ang = reduce ? 0.6 : elapsed * 0.18;
      const dist = narrow ? 12.5 : 16.5;
      desired.set(spawn.x + Math.sin(ang) * dist, narrow ? 6.8 : 8.4, spawn.z + Math.cos(ang) * dist);
      look.set(spawn.x, 1.25, spawn.z + (narrow ? -1.2 : 0));
    } else {
      const fx = -Math.sin(yaw);
      const fz = -Math.cos(yaw);
      const dist = narrow ? 6.4 : 7.6;
      const height = narrow ? 3.15 : 3.45;
      desired.set(px - fx * dist, height, pz - fz * dist);
      look.set(px, 1.25, pz);
    }
    const blend = 1 - Math.exp(-(playing ? 4.2 : 2.4) * Math.max(dt, 0.001));
    camera.position.lerp(desired, reduce ? 1 : blend);
    camera.lookAt(look);

    tmpSun.set(Math.round(px / 6) * 6, 0, Math.round(pz / 6) * 6);
    sun.position.set(tmpSun.x + 68, 112, tmpSun.z + 46);
    sun.target.position.copy(tmpSun);
    sunDir.copy(sun.position).sub(sun.target.position);
    pipeline.render(scene, camera, sunDir, camera.position.distanceTo(look), elapsed);

    clockAcc += dt;
    if (clockAcc > 0.25) {
      clockAcc = 0;
      if (playing) {
        roadGrid.query(px, pz, 26, roadBuf, roadSeen);
        let best = 28;
        let name: string | null = null;
        for (const s of roadBuf) {
          if (!s.name) continue;
          const d = distToSeg(px, pz, s);
          if (d < best) {
            best = d;
            name = s.name;
          }
        }
        if (name && name !== street) {
          street = name;
          bus.current.onStreet(name);
        }
        let near: Poi | null = null;
        let nearD = 32;
        for (const p of pois) {
          const d = Math.hypot(p.x - px, p.z - pz);
          if (d < nearD) {
            nearD = d;
            near = p;
          }
        }
        const key = near ? near.name : "";
        if (key !== nearKey) {
          nearKey = key;
          bus.current.onNear(near ? { name: near.name, kind: near.kind } : null);
        }
        for (const mark of landmarks) {
          if (found.has(mark.id)) continue;
          if (Math.hypot(mark.x - px, mark.z - pz) < 24) {
            found.add(mark.id);
            bus.current.onDiscover(mark.id);
          }
        }
      }
      drawMini();
    }
  });

  window.__controlsTest = {
    getYaw: () => yaw,
    getSpeed: () => speed,
    setKeys: (codes: string[]) => {
      keys.clear();
      for (const code of codes) keys.add(code);
    },
    setSteer: (v: number) => {
      steerOverride = v;
    },
  };

  bus.current.onProgress(1, "Plac Jana Kilińskiego");
  bus.current.onReady(landmarks.map(({ id, name, kind }) => ({ id, name, kind })));
  bus.current.onStreet(street);
  drawMini();

  return {
    dispose: () => {
      renderer.setAnimationLoop(null);
      timer.dispose();
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", clearKeys);
      window.removeEventListener("resize", resize);
      view.removeEventListener("pointerdown", onPointer);
      if (audio) void audio.close();
      pipeline.dispose();
      const disposed = new Set<THREE.BufferGeometry>();
      scene.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (!mesh.isMesh || !mesh.geometry || disposed.has(mesh.geometry)) return;
        disposed.add(mesh.geometry);
        mesh.geometry.dispose();
      });
      wallMat.dispose();
      roofMat.dispose();
      ftex?.dispose();
      gtex?.dispose();
      asphaltTex?.dispose();
      concreteTex?.dispose();
      renderer.dispose();
      delete window.__controlsTest;
    },
    setAvatar: (id) => {
      selected = id;
      paintDisc();
      if (!playing) {
        const home = roster.find((r) => r.id === id)?.home;
        if (home) {
          px = home.x;
          pz = home.z;
        }
      }
    },
    startWalk: () => {
      const home = roster.find((r) => r.id === selected)?.home ?? roster[0].home;
      px = home.x;
      pz = home.z;
      yaw = 0;
      speed = 0;
      playing = true;
      keys.clear();
    },
    backToSelect: () => {
      playing = false;
      speed = 0;
      keys.clear();
      touchSteer = 0;
      touchThrottle = 0;
    },
    returnToSquare: () => {
      const home = roster.find((r) => r.id === selected)?.home ?? roster[0].home;
      px = home.x;
      pz = home.z;
      yaw = 0;
      speed = 0;
    },
    setKeys: (codes) => {
      keys.clear();
      for (const code of codes) keys.add(code);
    },
    setTouch: (steer, throttle) => {
      touchSteer = Math.max(-1, Math.min(1, steer));
      touchThrottle = Math.max(-1, Math.min(1, throttle));
    },
    setRun: (on) => {
      touchRun = on;
    },
    toggleSound,
    getYaw: () => yaw,
    getSpeed: () => speed,
    cycleGfx: () => {
      graphicsMode = (graphicsMode + 1) % graphicsModes.length;
      resize();
      return graphicsModes[graphicsMode];
    },
    gfxLabel: () => graphicsModes[graphicsMode],
  };
}
