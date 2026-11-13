/**
 * The 3D view. Z is up and -Y is the vehicle's front, exactly like BeamNG / Blender.
 *
 * Rendering strategy, chosen for speed on 5k+ beam vehicles:
 *  - nodes: one THREE.Points draw call with a round-sprite shader (pixel or world sized)
 *  - beams: one LineSegments2 (fat lines) draw call with per-vertex colours
 *  - collision triangles: one non-indexed mesh, front/back faces tinted differently
 * Picking is done on the CPU in screen space, which is exact for points and lines and cheap.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { collectRails, collectSlides, closestOnRail, pointAtS, railLength, railPoints, type VRail, type VSlide } from '@core/jbeam/rails';
import type { Vehicle } from '@core/jbeam/types';
import type { Settings } from '../state/settings';
import type { Hover, PickMode, SelIdx } from '../state/selection';

export interface ViewColors {
  bg: string;
  text: string;
  textBg: string;
}

const NODE_VS = /* glsl */ `
attribute float aSize;
attribute vec4 aColor;
uniform float uPx;
uniform float uWorld;
uniform float uHeight;
varying vec4 vColor;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  float s;
  if (uWorld > 0.5) {
    s = aSize * 0.006 * projectionMatrix[1][1] * uHeight * 0.5 / gl_Position.w;
    s = max(s, 2.0);
  } else {
    s = aSize * uPx;
  }
  gl_PointSize = s;
  vColor = aColor;
}
`;
const NODE_FS = /* glsl */ `
varying vec4 vColor;
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float r = dot(c, c);
  if (r > 1.0) discard;
  float rim = smoothstep(0.45, 0.8, r);
  vec3 col = mix(vColor.rgb, vColor.rgb * 0.25, rim * 0.85);
  gl_FragColor = vec4(col, vColor.a);
}
`;

const TRI_VS = /* glsl */ `
attribute vec4 aColor;
varying vec4 vColor;
void main() {
  vColor = aColor;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;
const TRI_FS = /* glsl */ `
uniform float uOpacity;
uniform vec3 uBack;
varying vec4 vColor;
void main() {
  vec3 col = gl_FrontFacing ? vColor.rgb : mix(vColor.rgb, uBack, 0.55);
  gl_FragColor = vec4(col, uOpacity * vColor.a);
}
`;

const tmpV = new THREE.Vector3();
const tmpV2 = new THREE.Vector3();

function hexToRgb(hex: string): [number, number, number] {
  const c = new THREE.Color(hex);
  return [c.r, c.g, c.b];
}

export interface ProjectedNode {
  x: number;
  y: number;
  z: number;
  visible: boolean;
}

export interface ViewportCallbacks {
  onCameraChange?: () => void;
}

export class Viewport {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  persp: THREE.PerspectiveCamera;
  ortho: THREE.OrthographicCamera;
  camera: THREE.PerspectiveCamera | THREE.OrthographicCamera;
  controls: OrbitControls;
  readonly root = new THREE.Group();
  readonly meshRoot = new THREE.Group();
  readonly extraRoot = new THREE.Group();
  readonly overlayRoot = new THREE.Group();

  private nodePoints: THREE.Points | null = null;
  private nodePos = new Float32Array(0);
  private nodeColor = new Float32Array(0);
  private nodeSizeAttr = new Float32Array(0);
  private beamLines: LineSegments2 | null = null;
  private beamMat: LineMaterial;
  private triMesh: THREE.Mesh | null = null;
  private triMat: THREE.ShaderMaterial;
  private nodeMat: THREE.ShaderMaterial;
  private triNormals: THREE.LineSegments | null = null;
  private wheelLines: THREE.LineSegments | null = null;
  private railLines: LineSegments2 | null = null;
  private railMat: LineMaterial;
  private slideLines: THREE.LineSegments | null = null;
  /** rails & slidenodes of the current vehicle (rebuilt with it) */
  rails: Map<string, VRail> = new Map();
  slides: VSlide[] = [];
  /** rail names drawn at their midpoint */
  railLabels: Array<{ x: number; y: number; z: number; text: string; color?: string }> = [];
  private grid: THREE.Group;
  private axes: THREE.Group;
  private ground: THREE.Mesh;
  private labelCanvas: HTMLCanvasElement;
  private labelCtx: CanvasRenderingContext2D;

  vehicle: Vehicle | null = null;
  /** current (possibly live-dragged) node positions */
  pos = new Float32Array(0);
  private sel: SelIdx | null = null;
  private highlight: SelIdx | null = null;
  private hover: Hover | null = null;
  /** visible parts (null = whole vehicle) */
  private scopeParts: Set<string> | null = null;
  /** hidden node indices (H) */
  private hidden = new Set<number>();
  /** beams / tris actually drawn (indices into vehicle arrays) */
  drawBeams: number[] = [];
  drawTris: number[] = [];
  /** per node: 0 hidden, 1 context (other part, attached to the scope), 2 in scope */
  nodeVis = new Uint8Array(0);
  private dirtyColors = true;
  private needsRender = true;
  private raf = 0;
  private s!: Settings;
  private colors: ViewColors = { bg: '#15171a', text: '#fff', textBg: 'rgba(0,0,0,.6)' };
  private width = 1;
  private height = 1;
  private disposed = false;
  private projCache: Float32Array | null = null;
  private projCacheValid = false;
  /** extra labels (e.g. inline naming preview) */
  extraLabels: Array<{ x: number; y: number; z: number; text: string; color?: string }> = [];
  /** trigger names (drawn at the box/sphere centre) */
  triggerLabels: Array<{ x: number; y: number; z: number; text: string; color?: string }> = [];
  cb: ViewportCallbacks = {};

  constructor(readonly container: HTMLElement, s: Settings) {
    this.s = s;
    this.renderer = new THREE.WebGLRenderer({ antialias: s.antialias, alpha: false, powerPreference: 'high-performance', preserveDrawingBuffer: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, s.pixelRatioCap));
    this.renderer.domElement.className = 'vp-canvas';
    container.appendChild(this.renderer.domElement);

    this.labelCanvas = document.createElement('canvas');
    this.labelCanvas.className = 'vp-labels';
    container.appendChild(this.labelCanvas);
    this.labelCtx = this.labelCanvas.getContext('2d')!;

    this.persp = new THREE.PerspectiveCamera(s.fov, 1, 0.01, 2000);
    this.persp.up.set(0, 0, 1);
    this.persp.position.set(-4.5, -5.5, 3);
    this.ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, -1000, 1000);
    this.ortho.up.set(0, 0, 1);
    this.camera = this.persp;

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = false;
    this.controls.screenSpacePanning = true;
    this.controls.target.set(0, 0, 0.6);
    this.controls.addEventListener('change', () => {
      this.projCacheValid = false;
      this.requestRender();
      this.cb.onCameraChange?.();
    });
    this.applyControlSettings();

    this.scene.add(this.root, this.meshRoot, this.extraRoot, this.overlayRoot);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x404850, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.4);
    sun.position.set(-3, -5, 8);
    this.scene.add(sun);

    this.grid = this.makeGrid();
    this.axes = this.makeAxes();
    this.scene.add(this.grid, this.axes);
    this.ground = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), new THREE.MeshBasicMaterial({ color: 0x808080, transparent: true, opacity: 0.08, depthWrite: false }));
    this.ground.renderOrder = -1;
    this.scene.add(this.ground);

    this.nodeMat = new THREE.ShaderMaterial({
      vertexShader: NODE_VS,
      fragmentShader: NODE_FS,
      uniforms: { uPx: { value: 1 }, uWorld: { value: 0 }, uHeight: { value: 1 } },
      transparent: true,
      depthWrite: true,
    });
    this.railMat = new LineMaterial({ color: 0xd04dff, linewidth: 3.5, worldUnits: false, transparent: true, opacity: 0.95, depthTest: false });
    this.beamMat = new LineMaterial({ linewidth: s.beamWidth, vertexColors: true, worldUnits: false, transparent: true, depthWrite: true });
    this.triMat = new THREE.ShaderMaterial({
      vertexShader: TRI_VS,
      fragmentShader: TRI_FS,
      uniforms: { uOpacity: { value: s.triOpacity }, uBack: { value: new THREE.Color(0xff3355) } },
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    });

    const ro = new ResizeObserver(() => this.resize());
    ro.observe(container);
    this.resize();
    const loop = () => {
      if (this.disposed) return;
      this.raf = requestAnimationFrame(loop);
      if (this.needsRender) {
        this.needsRender = false;
        this.render();
      }
    };
    loop();
    this.applySettings(s);
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.controls.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.labelCanvas.remove();
  }

  requestRender() {
    this.needsRender = true;
  }

  get canvas(): HTMLCanvasElement {
    return this.renderer.domElement;
  }

  // ---------------------------------------------------------------------------------------
  // setup helpers
  // ---------------------------------------------------------------------------------------

  private makeGrid(): THREE.Group {
    const g = new THREE.Group();
    const minor = new THREE.GridHelper(20, 200, 0x000000, 0x000000);
    minor.rotation.x = Math.PI / 2;
    (minor.material as THREE.Material).transparent = true;
    (minor.material as THREE.LineBasicMaterial).opacity = 0.05;
    const major = new THREE.GridHelper(20, 20, 0x000000, 0x000000);
    major.rotation.x = Math.PI / 2;
    (major.material as THREE.Material).transparent = true;
    (major.material as THREE.LineBasicMaterial).opacity = 0.14;
    g.add(minor, major);
    g.renderOrder = -2;
    return g;
  }

  private makeAxes(): THREE.Group {
    const g = new THREE.Group();
    const mk = (to: [number, number, number], color: number) => {
      const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(...to)]);
      const l = new THREE.Line(geo, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.75 }));
      g.add(l);
    };
    mk([1.5, 0, 0], 0xe5484d);
    mk([0, 1.5, 0], 0x46a758);
    mk([0, 0, 1.5], 0x3e8ef7);
    return g;
  }

  setColors(c: ViewColors) {
    this.colors = c;
    this.renderer.setClearColor(new THREE.Color(c.bg));
    const light = new THREE.Color(c.bg).getHSL({ h: 0, s: 0, l: 0 }).l > 0.5;
    this.grid.children.forEach((ch, i) => {
      const m = (ch as THREE.LineSegments).material as THREE.LineBasicMaterial;
      m.color.set(light ? 0x000000 : 0xffffff);
      m.opacity = light ? (i === 0 ? 0.035 : 0.09) : i === 0 ? 0.05 : 0.14;
    });
    (this.ground.material as THREE.MeshBasicMaterial).color.set(light ? 0x000000 : 0xffffff);
    this.dirtyColors = true;
    this.requestRender();
  }

  applyControlSettings() {
    const s = this.s;
    const c = this.controls;
    if (s.orbitButton === 'middle') {
      // Blender: MMB orbits, Shift+MMB pans (OrbitControls pans when Shift is held on the rotate button),
      // LMB is free for selection, RMB stays the context menu
      c.mouseButtons = { LEFT: null as any, MIDDLE: THREE.MOUSE.ROTATE, RIGHT: null as any };
    } else {
      c.mouseButtons = { LEFT: null as any, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE };
    }
    c.zoomSpeed = s.zoomSpeed * (s.invertZoom ? -1 : 1);
    c.rotateSpeed = s.orbitSpeed;
    (c as any).zoomToCursor = s.zoomToCursor;
  }

  applySettings(s: Settings) {
    const prev = this.s;
    this.s = s;
    this.applyControlSettings();
    this.persp.fov = s.fov;
    this.persp.updateProjectionMatrix();
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, s.pixelRatioCap));
    this.beamMat.linewidth = s.beamWidth;
    this.triMat.uniforms.uOpacity.value = s.triOpacity;
    this.nodeMat.uniforms.uWorld.value = s.nodeWorldScale ? 1 : 0;
    this.nodeMat.depthTest = !s.xray;
    this.beamMat.depthTest = !s.xray;
    this.grid.visible = s.showGrid;
    this.axes.visible = s.showAxes;
    this.ground.visible = s.showGround;
    if (this.nodePoints) this.nodePoints.visible = s.showNodes;
    if (this.beamLines) this.beamLines.visible = s.showBeams;
    if (this.triMesh) this.triMesh.visible = s.showTris;
    if (this.triNormals) this.triNormals.visible = s.showTris && s.showTriNormals;
    if (this.wheelLines) this.wheelLines.visible = s.showWheels;
    this.meshRoot.visible = s.showMeshes;
    this.railMat.depthTest = false;
    if (prev && prev.showRails !== s.showRails) this.buildRails();
    if (prev && (prev.showTriNormals !== s.showTriNormals) && this.vehicle) this.buildTriNormals();
    this.resize();
    this.dirtyColors = true;
    this.requestRender();
  }

  resize() {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.width = w;
    this.height = h;
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = w + 'px';
    this.renderer.domElement.style.height = h + 'px';
    const dpr = this.renderer.getPixelRatio();
    this.labelCanvas.width = Math.round(w * dpr);
    this.labelCanvas.height = Math.round(h * dpr);
    this.labelCanvas.style.width = w + 'px';
    this.labelCanvas.style.height = h + 'px';
    this.persp.aspect = w / h;
    this.persp.updateProjectionMatrix();
    this.updateOrthoFrustum();
    this.beamMat.resolution.set(w, h);
    this.railMat.resolution.set(w, h);
    this.nodeMat.uniforms.uPx.value = dpr;
    this.nodeMat.uniforms.uHeight.value = h * dpr;
    this.projCacheValid = false;
    this.requestRender();
  }

  private updateOrthoFrustum() {
    const dist = this.ortho.position.distanceTo(this.controls.target);
    const halfH = Math.max(0.05, dist * Math.tan(THREE.MathUtils.degToRad(this.persp.fov / 2)));
    const aspect = this.width / this.height;
    this.ortho.left = -halfH * aspect;
    this.ortho.right = halfH * aspect;
    this.ortho.top = halfH;
    this.ortho.bottom = -halfH;
    this.ortho.updateProjectionMatrix();
  }

  get isOrtho(): boolean {
    return this.camera === this.ortho;
  }

  setOrtho(on: boolean) {
    if (on === this.isOrtho) return;
    const from = this.camera;
    const to = on ? this.ortho : this.persp;
    to.position.copy(from.position);
    to.quaternion.copy(from.quaternion);
    if (on) {
      this.ortho.zoom = 1;
      this.updateOrthoFrustum();
    }
    this.camera = to;
    this.controls.object = to;
    this.controls.update();
    this.projCacheValid = false;
    this.requestRender();
  }

  // ---------------------------------------------------------------------------------------
  // camera
  // ---------------------------------------------------------------------------------------

  /** view: front/back/left/right/top/bottom; Blender numpad conventions with BeamNG's -Y front */
  setView(view: 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom', ortho = true) {
    const t = this.controls.target.clone();
    const dist = Math.max(1, this.camera.position.distanceTo(t));
    const dir: Record<string, [number, number, number]> = {
      front: [0, -1, 0],
      back: [0, 1, 0],
      left: [1, 0, 0],
      right: [-1, 0, 0],
      top: [0, 0, 1],
      bottom: [0, 0, -1],
    };
    const d = dir[view];
    const up = view === 'top' ? new THREE.Vector3(0, -1, 0) : view === 'bottom' ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);
    if (ortho) this.setOrtho(true);
    this.camera.up.copy(up);
    this.camera.position.set(t.x + d[0] * dist, t.y + d[1] * dist, t.z + d[2] * dist);
    this.camera.lookAt(t);
    this.controls.update();
    // restore Z-up for orbiting
    this.camera.up.set(0, 0, 1);
    this.persp.up.set(0, 0, 1);
    this.ortho.up.set(0, 0, 1);
    if (view === 'top' || view === 'bottom') {
      this.camera.position.x += 1e-4;
      this.controls.update();
    }
    this.projCacheValid = false;
    this.requestRender();
  }

  getCameraState(): { pos: number[]; target: number[]; ortho: boolean } {
    return { pos: this.camera.position.toArray(), target: this.controls.target.toArray(), ortho: this.isOrtho };
  }

  setCameraState(c: { pos: number[]; target: number[]; ortho: boolean }) {
    this.setOrtho(!!c.ortho);
    this.camera.position.fromArray(c.pos);
    this.controls.target.fromArray(c.target);
    if (this.isOrtho) this.updateOrthoFrustum();
    this.controls.update();
    this.projCacheValid = false;
    this.requestRender();
  }

  frameBox(box: THREE.Box3) {
    if (box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3()).length();
    const radius = Math.max(0.15, size * 0.5);
    const fov = THREE.MathUtils.degToRad(this.persp.fov);
    const dist = (radius / Math.sin(fov / 2)) * 1.45;
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    if (dir.lengthSq() < 0.5) dir.set(-0.5, -0.7, 0.45).normalize();
    this.controls.target.copy(center);
    this.camera.position.copy(center).addScaledVector(dir, dist);
    if (this.isOrtho) {
      this.ortho.zoom = 1;
      this.updateOrthoFrustum();
    }
    this.persp.near = Math.max(0.005, dist / 500);
    this.persp.far = Math.max(100, dist * 50);
    this.persp.updateProjectionMatrix();
    this.controls.update();
    this.projCacheValid = false;
    this.requestRender();
  }

  frameNodes(indices: Iterable<number> | null) {
    const box = new THREE.Box3();
    const p = this.pos;
    if (indices) {
      for (const i of indices) box.expandByPoint(tmpV.set(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]));
    } else {
      const vis = this.nodeVis;
      for (let i = 0; i < p.length / 3; i++) if (!vis.length || vis[i] === 2) box.expandByPoint(tmpV.set(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]));
      if (box.isEmpty()) for (let i = 0; i < p.length / 3; i++) if (vis[i]) box.expandByPoint(tmpV.set(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]));
      if (box.isEmpty()) box.setFromObject(this.meshRoot);
    }
    if (!box.isEmpty()) this.frameBox(box);
  }

  // ---------------------------------------------------------------------------------------
  // vehicle
  // ---------------------------------------------------------------------------------------

  setVehicle(v: Vehicle | null, frame = false) {
    const first = !this.vehicle && !!v;
    this.vehicle = v;
    this.disposeGeometry();
    if (!v) {
      this.requestRender();
      return;
    }
    const n = v.nodes.length;
    this.pos = new Float32Array(n * 3);
    v.nodes.forEach((nd, i) => {
      this.pos[i * 3] = nd.x;
      this.pos[i * 3 + 1] = nd.y;
      this.pos[i * 3 + 2] = nd.z;
    });
    this.nodePos = this.pos.slice();
    this.nodeColor = new Float32Array(n * 4);
    this.nodeSizeAttr = new Float32Array(n);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.nodePos, 3));
    g.setAttribute('aColor', new THREE.BufferAttribute(this.nodeColor, 4));
    g.setAttribute('aSize', new THREE.BufferAttribute(this.nodeSizeAttr, 1));
    g.computeBoundingSphere();
    this.nodePoints = new THREE.Points(g, this.nodeMat);
    this.nodePoints.renderOrder = 3;
    this.nodePoints.frustumCulled = false;
    this.nodePoints.visible = this.s.showNodes;
    this.root.add(this.nodePoints);
    this.rails = collectRails(v);
    this.slides = collectSlides(v);
    this.computeScope();
    this.buildBeamTriGeometry();
    this.updateGeometry();
    this.buildTriNormals();
    this.buildWheels();
    this.dirtyColors = true;
    this.projCacheValid = false;
    if (first || frame) this.frameNodes(null);
    this.requestRender();
  }

  /** Restricts the view to some parts (null = whole vehicle). */
  setScope(parts: Set<string> | null, frame = true) {
    this.scopeParts = parts;
    if (!this.vehicle) return;
    this.computeScope();
    this.buildBeamTriGeometry();
    this.updateGeometry();
    this.buildTriNormals();
    this.buildWheels();
    this.dirtyColors = true;
    if (frame) this.frameNodes(null);
    this.requestRender();
  }

  /** Hides nodes (and the beams / triangles using them) from view and picking. */
  setHidden(h: Set<number>) {
    if (h.size === this.hidden.size && [...h].every((i) => this.hidden.has(i))) return;
    this.hidden = h;
    if (!this.vehicle) return;
    this.computeScope();
    this.buildBeamTriGeometry();
    this.updateGeometry();
    this.buildTriNormals();
    this.dirtyColors = true;
    this.requestRender();
  }

  inScope(part: string): boolean {
    return !this.scopeParts || this.scopeParts.has(part);
  }

  private computeScope() {
    const v = this.vehicle!;
    const sp = this.scopeParts;
    this.nodeVis = new Uint8Array(v.nodes.length);
    if (!sp) {
      this.nodeVis.fill(2);
      this.drawBeams = v.beams.map((_, i) => i);
      this.drawTris = v.tris.map((_, i) => i);
      this.applyHidden();
      return;
    }
    v.nodes.forEach((n, i) => {
      if (sp.has(n.row.part.def.name)) this.nodeVis[i] = 2;
    });
    const ctx = (i: number) => {
      if (this.nodeVis[i] === 0) this.nodeVis[i] = 1;
    };
    this.drawBeams = [];
    v.beams.forEach((b, i) => {
      if (!sp.has(b.row.part.def.name)) return;
      this.drawBeams.push(i);
      ctx(b.a);
      ctx(b.b);
    });
    this.drawTris = [];
    v.tris.forEach((t, i) => {
      if (!sp.has(t.row.part.def.name)) return;
      this.drawTris.push(i);
      ctx(t.a);
      ctx(t.b);
      ctx(t.c);
    });
    for (const w of v.wheels) if (sp.has(w.row.part.def.name)) {
      ctx(w.n1);
      ctx(w.n2);
    }
    for (const pr of v.props) if (sp.has(pr.row.part.def.name)) for (const k of [pr.idRef, pr.idX, pr.idY]) if (k >= 0) ctx(k);
    this.applyHidden();
  }

  private applyHidden() {
    const h = this.hidden;
    const v = this.vehicle;
    if (!h.size || !v) return;
    for (const i of h) if (i < this.nodeVis.length) this.nodeVis[i] = 0;
    this.drawBeams = this.drawBeams.filter((i) => !h.has(v.beams[i].a) && !h.has(v.beams[i].b));
    this.drawTris = this.drawTris.filter((i) => !h.has(v.tris[i].a) && !h.has(v.tris[i].b) && !h.has(v.tris[i].c));
  }

  private buildBeamTriGeometry() {
    for (const o of [this.beamLines, this.triMesh]) {
      if (!o) continue;
      this.root.remove(o);
      o.geometry.dispose();
    }
    const nb = this.drawBeams.length;
    const bg = new LineSegmentsGeometry();
    bg.setPositions(new Float32Array(Math.max(1, nb) * 6));
    bg.setColors(new Float32Array(Math.max(1, nb) * 6));
    this.beamLines = new LineSegments2(bg, this.beamMat);
    this.beamLines.frustumCulled = false;
    this.beamLines.renderOrder = 2;
    this.beamLines.visible = this.s.showBeams && nb > 0;
    this.root.add(this.beamLines);
    const nt = this.drawTris.length;
    const tg = new THREE.BufferGeometry();
    tg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(nt * 9), 3));
    tg.setAttribute('aColor', new THREE.BufferAttribute(new Float32Array(nt * 12), 4));
    this.triMesh = new THREE.Mesh(tg, this.triMat);
    this.triMesh.frustumCulled = false;
    this.triMesh.renderOrder = 1;
    this.triMesh.visible = this.s.showTris;
    this.root.add(this.triMesh);
  }

  private disposeGeometry() {
    for (const o of [this.nodePoints, this.beamLines, this.triMesh, this.triNormals, this.wheelLines]) {
      if (!o) continue;
      this.root.remove(o);
      o.geometry.dispose();
    }
    this.nodePoints = null;
    this.beamLines = null;
    this.triMesh = null;
    this.triNormals = null;
    this.wheelLines = null;
  }

  /** Writes current node positions into all geometry buffers. */
  updateGeometry() {
    const v = this.vehicle;
    if (!v) return;
    const p = this.pos;
    if (this.nodePoints) {
      this.nodePos.set(p);
      (this.nodePoints.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
      this.nodePoints.geometry.computeBoundingSphere();
    }
    if (this.beamLines && this.drawBeams.length) {
      const attr = this.beamLines.geometry.getAttribute('instanceStart') as THREE.InterleavedBufferAttribute;
      const arr = attr.data.array as Float32Array;
      this.drawBeams.forEach((bi, k) => {
        const b = v.beams[bi];
        const o = k * 6;
        arr[o] = p[b.a * 3];
        arr[o + 1] = p[b.a * 3 + 1];
        arr[o + 2] = p[b.a * 3 + 2];
        arr[o + 3] = p[b.b * 3];
        arr[o + 4] = p[b.b * 3 + 1];
        arr[o + 5] = p[b.b * 3 + 2];
      });
      attr.data.needsUpdate = true;
      this.beamLines.geometry.computeBoundingSphere();
    }
    if (this.triMesh) {
      const attr = this.triMesh.geometry.getAttribute('position') as THREE.BufferAttribute;
      const arr = attr.array as Float32Array;
      this.drawTris.forEach((ti, k) => {
        const t = v.tris[ti];
        const o = k * 9;
        for (let j = 0; j < 3; j++) {
          const n = j === 0 ? t.a : j === 1 ? t.b : t.c;
          arr[o + j * 3] = p[n * 3];
          arr[o + j * 3 + 1] = p[n * 3 + 1];
          arr[o + j * 3 + 2] = p[n * 3 + 2];
        }
      });
      attr.needsUpdate = true;
      this.triMesh.geometry.computeBoundingSphere();
    }
    this.buildRails();
    this.projCacheValid = false;
    this.requestRender();
  }

  /** Rails as fat magenta polylines (scope-aware) plus slidenode → rail offset lines. */
  buildRails() {
    for (const o of [this.railLines, this.slideLines]) {
      if (!o) continue;
      this.overlayRoot.remove(o);
      o.geometry.dispose();
    }
    this.railLines = null;
    this.slideLines = null;
    this.railLabels = [];
    const v = this.vehicle;
    if (!v || !this.s.showRails || !this.rails.size) return;
    const p = this.pos;
    const vis = this.nodeVis;
    const segs: number[] = [];
    const shown = new Set<string>();
    for (const r of this.rails.values()) {
      const inScope = !this.scopeParts || this.scopeParts.has(r.part.def.name) || r.nodes.some((i) => vis[i] === 2);
      if (!inScope || r.nodes.length < 2) continue;
      shown.add(r.name);
      const pts = railPoints(r, p);
      for (let i = 0; i + 1 < pts.length; i++) segs.push(...pts[i], ...pts[i + 1]);
      if (r.looped && pts.length > 2) segs.push(...pts[pts.length - 1], ...pts[0]);
      const m = pointAtS(pts, r.looped, railLength(pts, r.looped) / 2);
      this.railLabels.push({ x: m[0], y: m[1], z: m[2], text: r.name, color: '#d04dff' });
    }
    if (segs.length) {
      const g = new LineSegmentsGeometry();
      g.setPositions(new Float32Array(segs));
      this.railLines = new LineSegments2(g, this.railMat);
      this.railLines.frustumCulled = false;
      this.railLines.renderOrder = 5;
      this.overlayRoot.add(this.railLines);
    }
    const off: number[] = [];
    for (const sl of this.slides) {
      const r = this.rails.get(sl.rail);
      if (!r || !shown.has(r.name)) continue;
      const q: [number, number, number] = [p[sl.node * 3], p[sl.node * 3 + 1], p[sl.node * 3 + 2]];
      const c = closestOnRail(railPoints(r, p), r.looped, q);
      if (c && c.dist > 0.0005) off.push(...q, ...c.point);
    }
    if (off.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(off), 3));
      this.slideLines = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0xffa040, depthTest: false, transparent: true }));
      this.slideLines.frustumCulled = false;
      this.slideLines.renderOrder = 6;
      this.overlayRoot.add(this.slideLines);
    }
  }

  /** Live preview of moved nodes (during a drag), without re-assembly. */
  previewPositions(changes: Map<number, [number, number, number]>) {
    for (const [i, xyz] of changes) {
      this.pos[i * 3] = xyz[0];
      this.pos[i * 3 + 1] = xyz[1];
      this.pos[i * 3 + 2] = xyz[2];
    }
    this.updateGeometry();
    if (changes.size) this.buildWheels();
  }

  resetPositions() {
    const v = this.vehicle;
    if (!v) return;
    v.nodes.forEach((nd, i) => {
      this.pos[i * 3] = nd.x;
      this.pos[i * 3 + 1] = nd.y;
      this.pos[i * 3 + 2] = nd.z;
    });
    this.updateGeometry();
    this.buildWheels();
  }

  private buildTriNormals() {
    if (this.triNormals) {
      this.root.remove(this.triNormals);
      this.triNormals.geometry.dispose();
      this.triNormals = null;
    }
    const v = this.vehicle;
    if (!v || !this.s.showTriNormals || !this.drawTris.length) return;
    const p = this.pos;
    const arr = new Float32Array(this.drawTris.length * 6);
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3();
    this.drawTris.forEach((ti, i) => {
      const t = v.tris[ti];
      a.fromArray(p, t.a * 3);
      b.fromArray(p, t.b * 3);
      c.fromArray(p, t.c * 3);
      n.subVectors(b, a).cross(tmpV.subVectors(c, a));
      const area = n.length();
      n.normalize().multiplyScalar(Math.min(0.08, Math.max(0.02, Math.sqrt(area) * 0.5)));
      const cx = (a.x + b.x + c.x) / 3, cy = (a.y + b.y + c.y) / 3, cz = (a.z + b.z + c.z) / 3;
      arr.set([cx, cy, cz, cx + n.x, cy + n.y, cz + n.z], i * 6);
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(arr, 3));
    this.triNormals = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0x3ec7a8 }));
    this.triNormals.frustumCulled = false;
    this.root.add(this.triNormals);
  }

  /** Draws pressure wheel / hub wheel outlines from their jbeam parameters. */
  buildWheels() {
    if (this.wheelLines) {
      this.root.remove(this.wheelLines);
      this.wheelLines.geometry.dispose();
      this.wheelLines = null;
    }
    const v = this.vehicle;
    if (!v || !v.wheels.length) return;
    const p = this.pos;
    const segs: number[] = [];
    const N = 40;
    const a = new THREE.Vector3(), b = new THREE.Vector3(), axis = new THREE.Vector3(), u = new THREE.Vector3(), w = new THREE.Vector3();
    const ring = (center: THREE.Vector3, r: number) => {
      for (let i = 0; i < N; i++) {
        const t0 = (i / N) * Math.PI * 2, t1 = ((i + 1) / N) * Math.PI * 2;
        segs.push(
          center.x + (u.x * Math.cos(t0) + w.x * Math.sin(t0)) * r, center.y + (u.y * Math.cos(t0) + w.y * Math.sin(t0)) * r, center.z + (u.z * Math.cos(t0) + w.z * Math.sin(t0)) * r,
          center.x + (u.x * Math.cos(t1) + w.x * Math.sin(t1)) * r, center.y + (u.y * Math.cos(t1) + w.y * Math.sin(t1)) * r, center.z + (u.z * Math.cos(t1) + w.z * Math.sin(t1)) * r,
        );
      }
    };
    for (const wh of v.wheels) {
      if (!this.inScope(wh.row.part.def.name)) continue;
      a.fromArray(p, wh.n1 * 3);
      b.fromArray(p, wh.n2 * 3);
      axis.subVectors(b, a);
      if (axis.lengthSq() < 1e-10) continue;
      axis.normalize();
      u.set(0, 0, 1);
      if (Math.abs(axis.dot(u)) > 0.9) u.set(0, 1, 0);
      u.sub(tmpV.copy(axis).multiplyScalar(axis.dot(u))).normalize();
      w.crossVectors(axis, u).normalize();
      const mid = tmpV2.addVectors(a, b).multiplyScalar(0.5).addScaledVector(axis, wh.wheelOffset);
      const c1 = mid.clone().addScaledVector(axis, -wh.tireWidth / 2);
      const c2 = mid.clone().addScaledVector(axis, wh.tireWidth / 2);
      if (wh.hasTire || wh.section === 'pressureWheels') {
        ring(c1, wh.radius);
        ring(c2, wh.radius);
        for (let i = 0; i < 8; i++) {
          const t = (i / 8) * Math.PI * 2;
          const d = u.clone().multiplyScalar(Math.cos(t)).addScaledVector(w, Math.sin(t)).multiplyScalar(wh.radius);
          segs.push(c1.x + d.x, c1.y + d.y, c1.z + d.z, c2.x + d.x, c2.y + d.y, c2.z + d.z);
        }
      }
      const h1 = mid.clone().addScaledVector(axis, -wh.hubWidth / 2);
      const h2 = mid.clone().addScaledVector(axis, wh.hubWidth / 2);
      ring(h1, wh.hubRadius);
      ring(h2, wh.hubRadius);
      segs.push(a.x, a.y, a.z, b.x, b.y, b.z);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(segs, 3));
    this.wheelLines = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0x9aa4b2, transparent: true, opacity: 0.55, depthWrite: false }));
    this.wheelLines.frustumCulled = false;
    this.wheelLines.visible = this.s.showWheels;
    this.root.add(this.wheelLines);
    this.requestRender();
  }

  // ---------------------------------------------------------------------------------------
  // colours / state
  // ---------------------------------------------------------------------------------------

  setSelection(sel: SelIdx | null) {
    this.sel = sel;
    this.dirtyColors = true;
    this.requestRender();
  }

  setHighlight(h: SelIdx | null) {
    this.highlight = h;
    this.dirtyColors = true;
    this.requestRender();
  }

  setHover(h: Hover | null) {
    if (this.hover?.kind === h?.kind && this.hover?.idx === h?.idx) return;
    this.hover = h;
    this.dirtyColors = true;
    this.requestRender();
  }

  private beamBaseColor(i: number, cache: Map<string, [number, number, number]>): [number, number, number] {
    const v = this.vehicle!;
    const b = v.beams[i];
    const s = this.s;
    const get = (hex: string) => {
      let c = cache.get(hex);
      if (!c) cache.set(hex, (c = hexToRgb(hex)));
      return c;
    };
    switch (s.beamColorMode) {
      case 'uniform':
        return get(s.colorBeam);
      case 'part':
        return partColor(b.row.part.def.name);
      case 'deformGroup': {
        const dg = b.row.v.deformGroup;
        return typeof dg === 'string' && dg ? partColor(dg) : get(s.colorBeam);
      }
      case 'stiffness': {
        const k = Number(b.row.v.beamSpring);
        if (!Number.isFinite(k) || k <= 0) return get(s.colorBeam);
        const t = Math.min(1, Math.max(0, (Math.log10(k) - 3) / 5)); // 1e3 .. 1e8
        return heat(t);
      }
      default:
        switch (b.type) {
          case 'ANISOTROPIC':
            return get(s.colorBeamAniso);
          case 'BOUNDED':
            return get(s.colorBeamBounded);
          case 'SUPPORT':
            return get(s.colorBeamSupport);
          case 'HYDRO':
            return get(s.colorBeamHydro);
          case 'PRESSURED':
            return get(s.colorBeamPressured);
          case 'LBEAM':
            return get(s.colorBeamLbeam);
          default:
            return get(s.colorBeam);
        }
    }
  }

  private updateColors() {
    const v = this.vehicle;
    if (!v) return;
    const s = this.s;
    const cache = new Map<string, [number, number, number]>();
    const sel = this.sel;
    const hl = this.highlight;
    const selC = hexToRgb(s.colorSelect);
    const hlC = hexToRgb(s.colorHighlight);
    const hover = this.hover;
    const vis = this.nodeVis;

    // nodes
    const nodeC = hexToRgb(s.colorNode);
    const fixedC = hexToRgb(s.colorNodeFixed);
    const ctxC: [number, number, number] = [0.55, 0.58, 0.62];
    const nc = this.nodeColor;
    const ns = this.nodeSizeAttr;
    for (let i = 0; i < v.nodes.length; i++) {
      const nd = v.nodes[i];
      let c = nd.row.v.fixed === true ? fixedC : nodeC;
      let size = s.nodeSize;
      let a = 1;
      const isSel = sel?.nodes.has(i);
      const isHl = hl?.nodes.has(i);
      if (vis[i] === 1) {
        c = ctxC;
        size *= 0.8;
        a = 0.6;
      }
      if (isHl) {
        c = hlC;
        size = s.nodeSize * 1.35;
        a = 1;
      }
      if (isSel) {
        c = selC;
        size = s.nodeSize * 1.35;
        a = 1;
      }
      if (hover?.kind === 'node' && hover.idx === i) size *= 1.6;
      if (vis[i] === 0 && !isSel && !isHl) {
        size = 0;
        a = 0;
      }
      nc[i * 4] = c[0];
      nc[i * 4 + 1] = c[1];
      nc[i * 4 + 2] = c[2];
      nc[i * 4 + 3] = a;
      ns[i] = size;
    }
    if (this.nodePoints) {
      (this.nodePoints.geometry.getAttribute('aColor') as THREE.BufferAttribute).needsUpdate = true;
      (this.nodePoints.geometry.getAttribute('aSize') as THREE.BufferAttribute).needsUpdate = true;
    }

    if (this.beamLines && this.drawBeams.length) {
      const attr = this.beamLines.geometry.getAttribute('instanceColorStart') as THREE.InterleavedBufferAttribute;
      const arr = attr.data.array as Float32Array;
      // beams attached to a (small) node selection get a softer accent, like the mockup's "attached to f3"
      const attach = sel && sel.nodes.size > 0 && sel.nodes.size <= 64 ? sel.nodes : null;
      this.drawBeams.forEach((i, k) => {
        let c = this.beamBaseColor(i, cache);
        if (attach) {
          const b = v.beams[i];
          if (attach.has(b.a) || attach.has(b.b)) c = [c[0] * 0.35 + selC[0] * 0.65, c[1] * 0.35 + selC[1] * 0.65, c[2] * 0.35 + selC[2] * 0.65];
        }
        if (hl?.beams.has(i)) c = hlC;
        if (sel?.beams.has(i)) c = selC;
        else if (hover?.kind === 'beam' && hover.idx === i) c = [Math.min(1, c[0] + 0.35), Math.min(1, c[1] + 0.35), Math.min(1, c[2] + 0.35)];
        const o = k * 6;
        arr[o] = arr[o + 3] = c[0];
        arr[o + 1] = arr[o + 4] = c[1];
        arr[o + 2] = arr[o + 5] = c[2];
      });
      attr.data.needsUpdate = true;
    }

    if (this.triMesh) {
      const attr = this.triMesh.geometry.getAttribute('aColor') as THREE.BufferAttribute;
      const arr = attr.array as Float32Array;
      const triC = hexToRgb(s.colorTri);
      this.drawTris.forEach((i, k) => {
        let c = triC;
        let a = 1;
        if (hl?.tris.has(i)) {
          c = hlC;
          a = 2.2;
        }
        if (sel?.tris.has(i)) {
          c = selC;
          a = 2.5;
        } else if (hover?.kind === 'tri' && hover.idx === i) a = 2;
        for (let j = 0; j < 3; j++) {
          const o = k * 12 + j * 4;
          arr[o] = c[0];
          arr[o + 1] = c[1];
          arr[o + 2] = c[2];
          arr[o + 3] = a;
        }
      });
      attr.needsUpdate = true;
    }
  }

  // ---------------------------------------------------------------------------------------
  // rendering
  // ---------------------------------------------------------------------------------------

  private render() {
    if (this.dirtyColors) {
      this.dirtyColors = false;
      this.updateColors();
    }
    if (this.isOrtho) this.updateOrthoFrustum();
    this.renderer.render(this.scene, this.camera);
    this.drawLabels();
  }

  /** Projects all nodes to CSS pixels. Cached until the camera or positions change. */
  projectAll(): Float32Array {
    const n = this.pos.length / 3;
    if (this.projCacheValid && this.projCache && this.projCache.length === n * 3) return this.projCache;
    const out = this.projCache && this.projCache.length === n * 3 ? this.projCache : new Float32Array(n * 3);
    this.camera.updateMatrixWorld();
    const m = new THREE.Matrix4().multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse).elements;
    const w2 = this.width / 2, h2 = this.height / 2;
    const p = this.pos;
    for (let i = 0; i < n; i++) {
      const x = p[i * 3], y = p[i * 3 + 1], z = p[i * 3 + 2];
      const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
      const cx = (m[0] * x + m[4] * y + m[8] * z + m[12]) / cw;
      const cy = (m[1] * x + m[5] * y + m[9] * z + m[13]) / cw;
      const cz = (m[2] * x + m[6] * y + m[10] * z + m[14]) / cw;
      out[i * 3] = (cx + 1) * w2;
      out[i * 3 + 1] = (1 - cy) * h2;
      out[i * 3 + 2] = cw > 0 && cz >= -1 && cz <= 1 ? cz : 99;
    }
    this.projCache = out;
    this.projCacheValid = true;
    return out;
  }

  project(x: number, y: number, z: number): { x: number; y: number; z: number } {
    tmpV.set(x, y, z).project(this.camera);
    return { x: (tmpV.x + 1) * this.width / 2, y: (1 - tmpV.y) * this.height / 2, z: tmpV.z };
  }

  /** Ray from CSS pixel coordinates. */
  ray(px: number, py: number): THREE.Ray {
    const ndc = new THREE.Vector2((px / this.width) * 2 - 1, -(py / this.height) * 2 + 1);
    const rc = new THREE.Raycaster();
    rc.setFromCamera(ndc, this.camera);
    return rc.ray;
  }

  /** World point under the cursor on the plane through `through` facing the camera. */
  pointOnViewPlane(px: number, py: number, through: THREE.Vector3): THREE.Vector3 {
    const normal = new THREE.Vector3();
    this.camera.getWorldDirection(normal);
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, through);
    const out = new THREE.Vector3();
    return this.ray(px, py).intersectPlane(plane, out) ?? through.clone();
  }

  viewDir(): THREE.Vector3 {
    const d = new THREE.Vector3();
    this.camera.getWorldDirection(d);
    return d;
  }

  get size(): { w: number; h: number } {
    return { w: this.width, h: this.height };
  }

  private drawLabels() {
    const ctx = this.labelCtx;
    const dpr = this.renderer.getPixelRatio();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);
    const v = this.vehicle;
    const s = this.s;
    const items: Array<{ x: number; y: number; text: string; color: string; strong: boolean }> = [];
    if (v && s.showNodes && s.showLabels !== 'off') {
      const proj = this.projectAll();
      const want = (i: number) => {
        if (s.showLabels === 'all') return true;
        if (this.sel?.nodes.has(i) || this.highlight?.nodes.has(i)) return true;
        return this.hover?.kind === 'node' && this.hover.idx === i;
      };
      const all = s.showLabels === 'all';
      for (let i = 0; i < v.nodes.length; i++) {
        if (!want(i)) continue;
        if (proj[i * 3 + 2] > 1) continue;
        if (this.nodeVis[i] === 0 && !this.sel?.nodes.has(i)) continue;
        if (all && this.nodeVis[i] === 1 && !this.sel?.nodes.has(i)) continue;
        const strong = !!(this.sel?.nodes.has(i) || (this.hover?.kind === 'node' && this.hover.idx === i));
        items.push({ x: proj[i * 3], y: proj[i * 3 + 1], text: v.nodes[i].name, color: strong ? s.colorSelect : this.colors.text, strong });
      }
    }
    for (const l of this.extraLabels) {
      const p = this.project(l.x, l.y, l.z);
      if (p.z > 1) continue;
      items.push({ x: p.x, y: p.y, text: l.text, color: l.color ?? s.colorSelect, strong: true });
    }
    if (s.showRails && s.showLabels !== 'off') {
      for (const l of this.railLabels) {
        const p = this.project(l.x, l.y, l.z);
        if (p.z > 1) continue;
        items.push({ x: p.x, y: p.y, text: l.text, color: l.color ?? s.colorSelect, strong: false });
      }
    }
    if (s.showTriggers && s.showLabels !== 'off') {
      for (const l of this.triggerLabels) {
        const p = this.project(l.x, l.y, l.z);
        if (p.z > 1) continue;
        items.push({ x: p.x, y: p.y, text: l.text, color: l.color ?? s.colorSelect, strong: false });
      }
    }
    if (!items.length) return;
    ctx.font = `${s.labelSize}px 'Inter','Segoe UI',sans-serif`;
    ctx.textBaseline = 'middle';
    // declutter: skip labels overlapping an already drawn one (strong ones first)
    items.sort((a, b) => Number(b.strong) - Number(a.strong));
    const placed: Array<[number, number, number, number]> = [];
    const h = s.labelSize + 4;
    const max = 2500;
    let drawn = 0;
    for (const it of items) {
      const w = ctx.measureText(it.text).width + 8;
      const x = it.x + 7, y = it.y - h / 2 - 5;
      if (!it.strong && items.length > 60) {
        let hit = false;
        for (const r of placed) {
          if (x < r[0] + r[2] && x + w > r[0] && y < r[1] + r[3] && y + h > r[1]) {
            hit = true;
            break;
          }
        }
        if (hit) continue;
      }
      placed.push([x, y, w, h]);
      ctx.fillStyle = this.colors.textBg;
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, 3);
      ctx.fill();
      ctx.fillStyle = it.color;
      ctx.fillText(it.text, x + 4, y + h / 2 + 0.5);
      if (++drawn > max) break;
    }
  }

  // ---------------------------------------------------------------------------------------
  // picking
  // ---------------------------------------------------------------------------------------

  pick(px: number, py: number, mode: PickMode, radius = this.s.pickRadius): Hover | null {
    const v = this.vehicle;
    if (!v) return null;
    const s = this.s;
    const proj = this.projectAll();
    const vis = this.nodeVis;
    if ((mode === 'nodes' || mode === 'all') && s.showNodes) {
      let best = -1;
      let bestD = radius * radius;
      let bestZ = 2;
      for (let i = 0; i < v.nodes.length; i++) {
        if (!vis[i]) continue;
        const z = proj[i * 3 + 2];
        if (z > 1) continue;
        const dx = proj[i * 3] - px, dy = proj[i * 3 + 1] - py;
        const d = dx * dx + dy * dy;
        if (d > radius * radius) continue;
        // in-scope nodes win over context nodes; then nearest; near-ties go to the closest to the camera
        const pref = vis[i] === 2 ? 0 : 30;
        if (best < 0 || d + pref < bestD - 9 || (d + pref < bestD + 9 && z < bestZ)) {
          best = i;
          bestD = d + pref;
          bestZ = z;
        }
      }
      if (best >= 0) return { kind: 'node', idx: best };
    }
    if ((mode === 'beams' || mode === 'all') && s.showBeams) {
      let best = -1;
      let bestD = (radius * 0.7) ** 2;
      let bestZ = 2;
      for (const i of this.drawBeams) {
        const b = v.beams[i];
        const za = proj[b.a * 3 + 2], zb = proj[b.b * 3 + 2];
        if (za > 1 || zb > 1) continue;
        const ax = proj[b.a * 3], ay = proj[b.a * 3 + 1], bx = proj[b.b * 3], by = proj[b.b * 3 + 1];
        const dx = bx - ax, dy = by - ay;
        const l2 = dx * dx + dy * dy;
        let t = l2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
        t = Math.max(0, Math.min(1, t));
        const qx = ax + t * dx - px, qy = ay + t * dy - py;
        const d = qx * qx + qy * qy;
        const z = za + (zb - za) * t;
        if (d < bestD - 1 || (Math.abs(d - bestD) <= 1 && z < bestZ)) {
          best = i;
          bestD = d;
          bestZ = z;
        }
      }
      if (best >= 0) return { kind: 'beam', idx: best };
    }
    if ((mode === 'tris' || mode === 'all') && s.showTris && this.triMesh && this.drawTris.length) {
      const r = this.ray(px, py);
      const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), hit = new THREE.Vector3();
      let best = -1;
      let bestT = Infinity;
      for (const i of this.drawTris) {
        const t = v.tris[i];
        a.fromArray(this.pos, t.a * 3);
        b.fromArray(this.pos, t.b * 3);
        c.fromArray(this.pos, t.c * 3);
        if (r.intersectTriangle(a, b, c, false, hit)) {
          const d = hit.distanceToSquared(r.origin);
          if (d < bestT) {
            bestT = d;
            best = i;
          }
        }
      }
      if (best >= 0) return { kind: 'tri', idx: best };
    }
    return null;
  }

  /** Element indices inside a screen rectangle (in-scope elements only). */
  boxSelect(x0: number, y0: number, x1: number, y1: number, mode: PickMode): { nodes: number[]; beams: number[]; tris: number[] } {
    const v = this.vehicle;
    const out = { nodes: [] as number[], beams: [] as number[], tris: [] as number[] };
    if (!v) return out;
    const minX = Math.min(x0, x1), maxX = Math.max(x0, x1), minY = Math.min(y0, y1), maxY = Math.max(y0, y1);
    const proj = this.projectAll();
    const inside = new Uint8Array(v.nodes.length);
    for (let i = 0; i < v.nodes.length; i++) {
      if (!this.nodeVis[i]) continue;
      if (proj[i * 3 + 2] > 1) continue;
      const x = proj[i * 3], y = proj[i * 3 + 1];
      if (x >= minX && x <= maxX && y >= minY && y <= maxY) inside[i] = 1;
    }
    if (mode === 'nodes' || mode === 'all') for (let i = 0; i < inside.length; i++) if (inside[i] && this.nodeVis[i] === 2) out.nodes.push(i);
    if (mode === 'beams') for (const i of this.drawBeams) if (inside[v.beams[i].a] && inside[v.beams[i].b]) out.beams.push(i);
    if (mode === 'tris') for (const i of this.drawTris) {
      const t = v.tris[i];
      if (inside[t.a] && inside[t.b] && inside[t.c]) out.tris.push(i);
    }
    return out;
  }

  /** Snapshot as PNG data URL. */
  screenshot(): string {
    this.render();
    return this.renderer.domElement.toDataURL('image/png');
  }
}

const partColorCache = new Map<string, [number, number, number]>();
export function partColor(name: string): [number, number, number] {
  let c = partColorCache.get(name);
  if (c) return c;
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 16777619);
  const hue = ((h >>> 0) % 360) / 360;
  const col = new THREE.Color().setHSL(hue, 0.65, 0.6);
  c = [col.r, col.g, col.b];
  partColorCache.set(name, c);
  return c;
}

function heat(t: number): [number, number, number] {
  // blue (soft) -> green -> yellow -> red (stiff)
  const c = new THREE.Color().setHSL((1 - t) * 0.66, 0.85, 0.55);
  return [c.r, c.g, c.b];
}
