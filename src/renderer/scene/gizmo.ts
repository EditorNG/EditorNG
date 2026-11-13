/**
 * Transform gizmo (move / rotate / scale handles) on a proxy object placed at the selection.
 * The panel reads the proxy's delta while dragging and previews/commits through the same
 * paths as the G/R/S modal.
 */
import * as THREE from 'three';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import type { Viewport } from './viewport';

export type GizmoMode = 'none' | 'translate' | 'rotate' | 'scale';

export interface GizmoDelta {
  /** world translation */
  d: THREE.Vector3;
  /** world rotation about the pivot */
  q: THREE.Quaternion;
  /** scale factors along the gizmo axes (world axes, or the trigger's local axes) */
  f: [number, number, number];
  pivot: THREE.Vector3;
  /** gizmo axes in world space at drag start */
  basis: THREE.Quaternion;
}

export class Gizmo {
  readonly tc: TransformControls;
  readonly proxy = new THREE.Object3D();
  private startPos = new THREE.Vector3();
  private startQuat = new THREE.Quaternion();
  private startScale = new THREE.Vector3(1, 1, 1);
  onDrag: ((d: GizmoDelta) => void) | null = null;
  onStart: (() => void) | null = null;
  onEnd: (() => void) | null = null;

  constructor(private vp: Viewport) {
    this.tc = new TransformControls(vp.camera, vp.renderer.domElement);
    this.tc.setSize(0.85);
    const helper = this.tc.getHelper();
    helper.renderOrder = 20;
    vp.scene.add(this.proxy, helper);
    this.tc.addEventListener('change', () => vp.requestRender());
    vp.controls.addEventListener('change', () => {
      if (this.tc.camera !== vp.camera) this.tc.camera = vp.camera;
    });
    this.tc.addEventListener('mouseDown', () => {
      this.startPos.copy(this.proxy.position);
      this.startQuat.copy(this.proxy.quaternion);
      this.startScale.copy(this.proxy.scale);
      this.onStart?.();
    });
    this.tc.addEventListener('objectChange', () => {
      if (!this.tc.dragging) return;
      this.onDrag?.({
        d: this.proxy.position.clone().sub(this.startPos),
        q: this.proxy.quaternion.clone().multiply(this.startQuat.clone().invert()),
        f: [this.proxy.scale.x / this.startScale.x, this.proxy.scale.y / this.startScale.y, this.proxy.scale.z / this.startScale.z],
        pivot: this.startPos.clone(),
        basis: this.startQuat.clone(),
      });
    });
    this.tc.addEventListener('mouseUp', () => this.onEnd?.());
    this.hide();
  }

  get dragging(): boolean {
    return this.tc.dragging;
  }

  /** true when the pointer is over a handle (the panel must not start a box select) */
  get hot(): boolean {
    return this.tc.dragging || this.tc.axis !== null;
  }

  show(mode: Exclude<GizmoMode, 'none'>, at: THREE.Vector3, orient: THREE.Quaternion | null) {
    if (this.tc.dragging) return;
    this.proxy.position.copy(at);
    this.proxy.quaternion.copy(orient ?? new THREE.Quaternion());
    this.proxy.scale.set(1, 1, 1);
    this.proxy.updateMatrixWorld();
    this.tc.setMode(mode);
    this.tc.setSpace(orient ? 'local' : 'world');
    if (this.tc.object !== this.proxy) this.tc.attach(this.proxy);
    this.tc.enabled = true;
    this.tc.getHelper().visible = true;
    this.vp.requestRender();
  }

  hide() {
    if (this.tc.dragging) return;
    if (this.tc.object) this.tc.detach();
    this.tc.getHelper().visible = false;
    this.vp.requestRender();
  }

  setSnap(on: boolean, grid: number) {
    this.tc.translationSnap = on && grid > 0 ? grid : null;
    this.tc.rotationSnap = on ? THREE.MathUtils.degToRad(5) : null;
    this.tc.scaleSnap = on ? 0.1 : null;
  }
}
