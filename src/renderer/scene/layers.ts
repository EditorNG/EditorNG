/**
 * Flexbody / prop meshes, light props and triggers2 boxes for the 3D view.
 */
import * as THREE from 'three';
import type { Vehicle, Row } from '@core/jbeam/types';
import type { Settings } from '../state/settings';
import type { Hover, SelIdx } from '../state/selection';
import { meshes } from './meshes';
import { bulbDirection } from '@core/jbeam/generators';
import { placeTriggers } from '@core/jbeam/triggers';
import { partColor, type Viewport } from './viewport';

const DEG = Math.PI / 180;

function v3(o: any, d = 0): THREE.Vector3 {
  return o && typeof o === 'object' ? new THREE.Vector3(num(o.x, d), num(o.y, d), num(o.z, d)) : new THREE.Vector3(d, d, d);
}
function num(x: any, d: number): number {
  return typeof x === 'number' && Number.isFinite(x) ? x : d;
}

/** Orthonormal prop frame from 3 nodes: X = ref->idX, Y = cross(ref->idY, X), Z = X x Y. */
export function nodeFrame(ref: THREE.Vector3, px: THREE.Vector3, py: THREE.Vector3) {
  const X = px.clone().sub(ref).normalize();
  const Zr = py.clone().sub(ref);
  const Y = new THREE.Vector3().crossVectors(Zr, X).normalize();
  const Z = new THREE.Vector3().crossVectors(X, Y).normalize();
  return { X, Y, Z };
}

export interface TriggerShape {
  idx: number;
  row: Row;
  name: string;
  type: string;
  /** box: corner + axes * size; sphere: centre + radius */
  corner: THREE.Vector3;
  center: THREE.Vector3;
  axes: { X: THREE.Vector3; Y: THREE.Vector3; Z: THREE.Vector3 };
  size: THREE.Vector3;
  radius: number;
  usesGlobal: boolean;
}

/** Trigger boxes/spheres placed exactly like the game does (see core/jbeam/triggers.ts). */
export function triggerShapes(v: Vehicle, pos: Float32Array): TriggerShape[] {
  const V = (a: number[]) => new THREE.Vector3(a[0], a[1], a[2]);
  return placeTriggers(v, pos).map((t) => ({
    idx: t.idx,
    row: t.row,
    name: t.name,
    type: t.type,
    corner: V(t.origin),
    center: V(t.center),
    axes: { X: V(t.frame.X), Y: V(t.frame.Y), Z: V(t.frame.Z) },
    size: V(t.size),
    radius: t.radius,
    usesGlobal: t.usesGlobal,
  }));
}

export interface PropPlacement {
  idx: number;
  origin: THREE.Vector3;
  axes: { X: THREE.Vector3; Y: THREE.Vector3; Z: THREE.Vector3 };
  offset: THREE.Vector3;
  isLight: boolean;
}

export function propPlacements(v: Vehicle, pos: Float32Array): PropPlacement[] {
  const out: PropPlacement[] = [];
  v.props.forEach((p, idx) => {
    if (p.idRef < 0 || p.idX < 0 || p.idY < 0) return;
    const P = (i: number) => new THREE.Vector3(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
    const ref = P(p.idRef);
    const axes = nodeFrame(ref, P(p.idX), P(p.idY));
    const r = p.row.v;
    const bt = v3(r.baseTranslation);
    const isLight = p.mesh === 'SPOTLIGHT' || p.mesh === 'POINTLIGHT';
    let offset: THREE.Vector3;
    if (r.baseTranslationGlobal && typeof r.baseTranslationGlobal === 'object') {
      offset = v3(r.baseTranslationGlobal);
      out.push({ idx, origin: offset, axes, offset: new THREE.Vector3(), isLight });
      return;
    }
    offset = new THREE.Vector3().addScaledVector(axes.X, bt.x).addScaledVector(axes.Y, bt.y).addScaledVector(axes.Z, bt.z);
    out.push({ idx, origin: isLight ? ref.clone().add(offset) : offset, axes, offset, isLight });
  });
  return out;
}

export class Layers {
  private flexGroup = new THREE.Group();
  private propGroup = new THREE.Group();
  private trigGroup = new THREE.Group();
  private bulbGroup = new THREE.Group();
  private flexMats = new Map<string, THREE.MeshLambertMaterial>();
  private selMat: THREE.MeshLambertMaterial;
  private hlMat: THREE.MeshLambertMaterial;
  private wireMat: THREE.LineBasicMaterial;
  private flexObjs: THREE.Object3D[] = [];
  private propObjs: THREE.Object3D[] = [];
  private trigObjs: THREE.Object3D[] = [];
  private loadToken = 0;
  vehicle: Vehicle | null = null;
  shapes: TriggerShape[] = [];
  private scope: Set<string> | null = null;

  private inScope(part: string) {
    return !this.scope || this.scope.has(part);
  }

  setScope(scope: Set<string> | null) {
    this.scope = scope;
    this.buildMeshes();
    this.rebuildTriggers();
  }

  constructor(private vp: Viewport, private s: Settings) {
    vp.meshRoot.add(this.flexGroup, this.propGroup);
    vp.extraRoot.add(this.trigGroup, this.bulbGroup);
    this.selMat = new THREE.MeshLambertMaterial({ color: s.colorSelect, transparent: true, opacity: 0.75, side: THREE.DoubleSide, depthWrite: false });
    this.hlMat = new THREE.MeshLambertMaterial({ color: s.colorHighlight, transparent: true, opacity: 0.7, side: THREE.DoubleSide, depthWrite: false });
    this.wireMat = new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.12 });
  }

  applySettings(s: Settings) {
    this.s = s;
    for (const m of this.flexMats.values()) {
      m.opacity = s.meshOpacity;
      m.transparent = s.meshOpacity < 0.999;
      m.depthWrite = s.meshOpacity >= 0.999;
      m.wireframe = false;
      m.needsUpdate = true;
    }
    this.selMat.color.set(s.colorSelect);
    this.hlMat.color.set(s.colorHighlight);
    this.propGroup.visible = s.showProps;
    this.trigGroup.visible = s.showTriggers;
    this.bulbGroup.visible = s.showProps;
    for (const o of this.flexObjs) {
      const w = o.getObjectByName('wire');
      if (w) w.visible = s.meshWireframe;
    }
    this.vp.requestRender();
  }

  setColors(light: boolean) {
    this.wireMat.color.set(light ? 0x000000 : 0xffffff);
    this.wireMat.opacity = light ? 0.12 : 0.08;
  }

  private mat(key: string, color: THREE.ColorRepresentation): THREE.MeshLambertMaterial {
    let m = this.flexMats.get(key);
    if (!m) {
      const s = this.s;
      m = new THREE.MeshLambertMaterial({
        color,
        transparent: s.meshOpacity < 0.999,
        opacity: s.meshOpacity,
        depthWrite: s.meshOpacity >= 0.999,
        side: THREE.DoubleSide,
      });
      this.flexMats.set(key, m);
    }
    return m;
  }

  private clear(group: THREE.Group, list: THREE.Object3D[]) {
    for (const o of list) group.remove(o);
    list.length = 0;
  }

  /** Rebuilds everything for a new assembly. Meshes load asynchronously. */
  async setVehicle(v: Vehicle | null) {
    this.vehicle = v;
    const token = ++this.loadToken;
    this.rebuildTriggers();
    if (!v) {
      this.clear(this.flexGroup, this.flexObjs);
      this.clear(this.propGroup, this.propObjs);
      this.vp.requestRender();
      return;
    }
    const names = [...v.flexbodies.map((f) => f.mesh), ...v.props.filter((p) => p.mesh !== 'SPOTLIGHT' && p.mesh !== 'POINTLIGHT').map((p) => p.mesh)];
    // build immediately with what is cached, then again once loaded
    this.buildMeshes();
    if (this.s.showMeshes) {
      await meshes.load(names);
      if (token !== this.loadToken) return;
      this.buildMeshes();
    }
  }

  buildMeshes() {
    const v = this.vehicle;
    this.clear(this.flexGroup, this.flexObjs);
    this.clear(this.propGroup, this.propObjs);
    if (!v) return;
    const s = this.s;
    const grey = new THREE.Color(0x9aa1ab);
    v.flexbodies.forEach((f, i) => {
      const g = meshes.get(f.mesh);
      if (!g || !this.inScope(f.row.part.def.name)) {
        this.flexObjs.push(new THREE.Object3D());
        return;
      }
      const key = s.meshColorByPart ? 'p:' + f.row.part.def.name : 'grey';
      const color = s.meshColorByPart ? new THREE.Color(...partColor(f.row.part.def.name)) : grey;
      const mesh = new THREE.Mesh(g, this.mat(key, color));
      mesh.userData = { kind: 'flex', idx: i };
      const holder = new THREE.Group();
      holder.add(mesh);
      if (s.meshWireframe) {
        const w = new THREE.LineSegments(new THREE.WireframeGeometry(g), this.wireMat);
        w.name = 'wire';
        holder.add(w);
      }
      if (f.pos) holder.position.set(f.pos[0], f.pos[1], f.pos[2]);
      if (f.rot) holder.rotation.set(f.rot[0] * DEG, f.rot[1] * DEG, f.rot[2] * DEG, 'ZXY');
      if (f.scale) holder.scale.set(f.scale[0] || 1, f.scale[1] || 1, f.scale[2] || 1);
      holder.userData = { kind: 'flex', idx: i };
      holder.renderOrder = 0;
      this.flexGroup.add(holder);
      this.flexObjs.push(holder);
    });
    const places = propPlacements(v, this.vp.pos);
    const byIdx = new Map(places.map((p) => [p.idx, p]));
    v.props.forEach((p, i) => {
      const pl = byIdx.get(i);
      if (!pl || !this.inScope(p.row.part.def.name)) {
        this.propObjs.push(new THREE.Object3D());
        return;
      }
      let obj: THREE.Object3D;
      if (pl.isLight) {
        obj = lightGizmo(p.mesh === 'SPOTLIGHT', p.row.v);
        obj.position.copy(pl.origin);
        const m = new THREE.Matrix4().makeBasis(pl.axes.X, pl.axes.Y, pl.axes.Z);
        obj.quaternion.setFromRotationMatrix(m);
        const br = p.row.v.baseRotation;
        if (br && typeof br === 'object') {
          obj.quaternion.multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(-num(br.x, 0) * DEG, -num(br.z, 0) * DEG, -num(br.y, 0) * DEG, 'XZY')));
        }
      } else {
        const g = meshes.get(p.mesh);
        if (!g) {
          this.propObjs.push(new THREE.Object3D());
          return;
        }
        obj = new THREE.Mesh(g, this.mat('prop', new THREE.Color(0xb8a98f)));
        obj.position.copy(pl.offset);
      }
      obj.userData = { kind: 'prop', idx: i };
      obj.traverse((o) => (o.userData = { kind: 'prop', idx: i }));
      this.propGroup.add(obj);
      this.propObjs.push(obj);
    });
    this.applySelection(null, null, null);
    this.vp.requestRender();
  }

  /** Modular light bulbs (slots2 with $posX/$rotZ variables) as markers with a direction arrow. */
  rebuildBulbs() {
    for (const c of [...this.bulbGroup.children]) this.bulbGroup.remove(c);
    const v = this.vehicle;
    if (!v) return;
    for (const p of v.parts) {
      for (const sn of p.slots) {
        const vars = sn.part?.scope ?? {};
        const get = (k: string) => {
          const x = vars[k];
          return typeof x === 'number' ? x : typeof x === 'object' && x && typeof x.val === 'number' ? x.val : undefined;
        };
        const px = get('$posX'), py = get('$posY'), pz = get('$posZ');
        if (px === undefined || py === undefined || pz === undefined || !sn.part) continue;
        if (!/bulb|light|lamp/i.test(sn.id + ' ' + sn.chosen)) continue;
        if (!this.inScope(p.def.name) && !this.inScope(sn.chosen)) continue;
        const rx = get('$rotX') ?? 0, rz = get('$rotZ') ?? 0;
        const d = bulbDirection(rx, rz);
        const color = /red/i.test(sn.chosen) ? 0xff4040 : /amber/i.test(sn.chosen) ? 0xffa520 : 0xfff2b0;
        const g = new THREE.Group();
        g.position.set(px, py, pz);
        g.add(new THREE.Mesh(new THREE.SphereGeometry(0.012, 10, 8), new THREE.MeshBasicMaterial({ color })));
        const arrow = new THREE.ArrowHelper(new THREE.Vector3(d.x, d.y, d.z), new THREE.Vector3(), 0.12, color, 0.03, 0.015);
        g.add(arrow);
        g.userData = { kind: 'bulb', slot: sn.id };
        this.bulbGroup.add(g);
      }
    }
    this.vp.requestRender();
  }

  rebuildTriggers() {
    this.rebuildBulbs();
    this.clear(this.trigGroup, this.trigObjs);
    const v = this.vehicle;
    this.vp.triggerLabels = [];
    if (!v) return;
    this.shapes = triggerShapes(v, this.vp.pos);
    this.vp.triggerLabels = this.s.showTriggers
      ? this.shapes.filter((sh) => this.inScope(sh.row.part.def.name) && sh.name).map((sh) => ({ x: sh.center.x, y: sh.center.y, z: sh.center.z, text: sh.name, color: '#ff9a3c' }))
      : [];
    for (const sh of this.shapes) {
      if (!this.inScope(sh.row.part.def.name)) {
        this.trigObjs.push(new THREE.Object3D());
        continue;
      }
      const color = new THREE.Color(1, 0.5, 0);
      const c = sh.row.v.color;
      if (Array.isArray(c) && c.length >= 3) color.setRGB(num(c[0], 1), num(c[1], 0.5), num(c[2], 0));
      let obj: THREE.Object3D;
      if (sh.type === 'sphere') {
        const g = new THREE.SphereGeometry(Math.max(0.002, sh.radius), 16, 10);
        obj = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.35, depthWrite: false }));
        obj.position.copy(sh.corner);
        const e = new THREE.LineSegments(new THREE.EdgesGeometry(g), new THREE.LineBasicMaterial({ color }));
        obj.add(e);
      } else {
        const g = new THREE.BoxGeometry(1, 1, 1);
        g.translate(0.5, 0.5, 0.5);
        const box = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.25, depthWrite: false, side: THREE.DoubleSide }));
        const edges = new THREE.LineSegments(new THREE.EdgesGeometry(g), new THREE.LineBasicMaterial({ color }));
        obj = new THREE.Group();
        obj.add(box, edges);
        const m = new THREE.Matrix4().makeBasis(sh.axes.X.clone().multiplyScalar(sh.size.x || 0.01), sh.axes.Y.clone().multiplyScalar(sh.size.y || 0.01), sh.axes.Z.clone().multiplyScalar(sh.size.z || 0.01));
        m.setPosition(sh.corner);
        obj.matrixAutoUpdate = false;
        obj.matrix.copy(m);
      }
      obj.userData = { kind: 'trigger', idx: sh.idx };
      obj.traverse((o) => (o.userData = { kind: 'trigger', idx: sh.idx }));
      this.trigGroup.add(obj);
      this.trigObjs.push(obj);
    }
    this.vp.requestRender();
  }

  applySelection(sel: SelIdx | null, hl: SelIdx | null, hover: Hover | null) {
    this.flexObjs.forEach((o, i) => {
      const mesh = o.children[0] as THREE.Mesh | undefined;
      if (!mesh || !(mesh instanceof THREE.Mesh)) return;
      const key = this.s.meshColorByPart ? 'p:' + this.vehicle?.flexbodies[i]?.row.part.def.name : 'grey';
      if (sel?.flex.has(i) || (hover?.kind === 'flex' && hover.idx === i)) mesh.material = this.selMat;
      else if (hl?.flex.has(i)) mesh.material = this.hlMat;
      else mesh.material = this.flexMats.get(key) ?? mesh.material;
    });
    this.propObjs.forEach((o, i) => {
      if (!(o instanceof THREE.Mesh)) return;
      if (sel?.props.has(i) || (hover?.kind === 'prop' && hover.idx === i)) o.material = this.selMat;
      else if (hl?.props.has(i)) o.material = this.hlMat;
      else o.material = this.flexMats.get('prop') ?? o.material;
    });
    this.trigObjs.forEach((o, i) => {
      const on = sel?.triggers.has(this.shapes[i]?.idx) || hl?.triggers.has(this.shapes[i]?.idx) || (hover?.kind === 'trigger' && hover.idx === this.shapes[i]?.idx);
      o.traverse((c) => {
        const m = (c as THREE.Mesh).material as THREE.MeshBasicMaterial | undefined;
        if (m && 'opacity' in m && c instanceof THREE.Mesh) m.opacity = on ? 0.6 : 0.25;
      });
    });
    this.vp.requestRender();
  }

  /** Ray pick against meshes, props and triggers. */
  pick(px: number, py: number): Hover | null {
    const rc = new THREE.Raycaster();
    rc.ray.copy(this.vp.ray(px, py));
    const targets: THREE.Object3D[] = [];
    if (this.s.showTriggers) targets.push(this.trigGroup);
    if (this.s.showMeshes) {
      if (this.s.showProps) targets.push(this.propGroup);
      targets.push(this.flexGroup);
    }
    const hits = rc.intersectObjects(targets, true);
    for (const h of hits) {
      const ud = h.object.userData;
      if (ud && (ud.kind === 'flex' || ud.kind === 'prop' || ud.kind === 'trigger')) return { kind: ud.kind, idx: ud.idx };
    }
    return null;
  }

  flexBox(i: number): THREE.Box3 | null {
    const o = this.flexObjs[i];
    if (!o || !o.children.length) return null;
    return new THREE.Box3().setFromObject(o);
  }
}

function lightGizmo(spot: boolean, r: Record<string, any>): THREE.Object3D {
  const g = new THREE.Group();
  const color = new THREE.Color(1, 0.95, 0.6);
  const lc = r.lightColor;
  if (lc && typeof lc === 'object' && 'r' in lc) color.setRGB(num(lc.r, 255) / 255, num(lc.g, 255) / 255, num(lc.b, 255) / 255);
  const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.015, 10, 8), new THREE.MeshBasicMaterial({ color }));
  g.add(bulb);
  if (spot) {
    const outer = num(r.lightOuterAngle, 45) * DEG;
    const len = 0.25;
    const rad = Math.tan(Math.min(outer, 80 * DEG) / 2) * len;
    const pts: THREE.Vector3[] = [];
    const N = 16;
    for (let i = 0; i < N; i++) {
      const a0 = (i / N) * Math.PI * 2, a1 = ((i + 1) / N) * Math.PI * 2;
      pts.push(new THREE.Vector3(Math.cos(a0) * rad, len, Math.sin(a0) * rad), new THREE.Vector3(Math.cos(a1) * rad, len, Math.sin(a1) * rad));
      if (i % 4 === 0) pts.push(new THREE.Vector3(), new THREE.Vector3(Math.cos(a0) * rad, len, Math.sin(a0) * rad));
    }
    g.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.7 })));
  }
  return g;
}
