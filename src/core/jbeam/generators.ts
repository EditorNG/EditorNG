/**
 * Row generators for the placement tools, following the 0.40-era conventions
 * (triggers2, modular bulb slots, occupant system, pressureWheels).
 * Multi-line rows use "\n" + "\t" for relative indentation (insertRows expands them).
 */
import { fmtNum, fmtValue } from './edit';

export type V3 = { x: number; y: number; z: number };

const n3 = (v: V3, d = 3) => `{"x":${fmtNum(v.x, d)}, "y":${fmtNum(v.y, d)}, "z":${fmtNum(v.z, d)}}`;

// ------------------------------------------------------------------------------------------
// triggers2
// ------------------------------------------------------------------------------------------

export interface TriggerSpec {
  id: string;
  idRef: string;
  idX: string;
  idY: string;
  type: 'box' | 'sphere';
  /** box: full extents (x = along ref->idX, y = height (Z x X), z = along ref->idY); sphere: radius in x */
  size: V3;
  /** corner (box) or centre (sphere) in vehicle coordinates */
  pos: V3;
  /** highlight a mesh instead of a coloured box */
  mesh?: string;
  color?: [number, number, number, number];
  /** action wiring */
  action?: string;
  action2?: string;
}

export function triggerRow(t: TriggerSpec): string {
  const size = t.type === 'sphere' ? fmtNum(t.size.x, 4) : n3(t.size, 4);
  const opts: string[] = [`"baseTranslationGlobal":${n3(t.pos, 4)}`];
  if (t.mesh) opts.push(`"mesh":${JSON.stringify(t.mesh)}`);
  else opts.push(`"color":${JSON.stringify(t.color ?? [1, 0.5, 0, 1])}`);
  const z = '{"x":0, "y":0, "z":0}';
  return `[${JSON.stringify(t.id)}, ${JSON.stringify(t.idRef)}, ${JSON.stringify(t.idX)}, ${JSON.stringify(t.idY)}, ${JSON.stringify(t.type)}, ${size}, ${z}, ${z}, ${z}, ${z}, {${opts.join(', ')}}]`;
}

export function triggerLinkRows(t: TriggerSpec): string[] {
  const out: string[] = [];
  if (t.action) out.push(`[${JSON.stringify(t.id)}, "action0", ${JSON.stringify(t.action)}]`);
  if (t.action2) out.push(`[${JSON.stringify(t.id)}, "action2", ${JSON.stringify(t.action2)}]`);
  return out;
}

/** Legacy "triggers" row: the label column after the id, otherwise like triggers2. */
export function legacyTriggerRow(t: TriggerSpec & { label: string }): string {
  const r = triggerRow(t);
  const head = `[${JSON.stringify(t.id)}, `;
  return head + `${JSON.stringify(t.label)}, ` + r.slice(head.length);
}

/** Legacy "triggerEventLinks" row: trigger -> event of the "events" section. */
export function legacyLinkRow(id: string, event: string): string {
  return `[${JSON.stringify(id)}, "action0", ${JSON.stringify(event)}]`;
}

/** Legacy "events" row: what the trigger runs (Lua on press). */
export function legacyEventRow(id: string, title: string, onDown: string): string {
  return `[${JSON.stringify(id)}, ${JSON.stringify(title)}, ${JSON.stringify(title)}, {"onDown":${JSON.stringify(onDown)}}]`;
}

/** Actions that need an actionsEnabled entry (everything except common: built-ins). */
export function needsActionsEnabled(action: string | undefined): boolean {
  return !!action && !action.startsWith('common:');
}

// ------------------------------------------------------------------------------------------
// bulbs
// ------------------------------------------------------------------------------------------

export interface BulbSpec {
  slotName: string;
  bulb: string;
  description: string;
  electric: string;
  nodeRef: string;
  nodeX: string;
  nodeY: string;
  deformGroup: string;
  pos: V3;
  rot: V3;
  shadow: boolean;
  extra?: Record<string, number | string>;
}

export function bulbSlotRow(b: BulbSpec): string {
  const extra = Object.entries(b.extra ?? {}).map(([k, v]) => `\n\t\t\t${JSON.stringify(k)}:${fmtValue(v, 4)},`).join('');
  return (
    `[${JSON.stringify(b.slotName)}, [${JSON.stringify(b.bulb)}], [], ${JSON.stringify(b.bulb)}, ${JSON.stringify(b.description)},` +
    `\n{` +
    `\n\t"coreSlot":true,` +
    `\n\t"variables":{` +
    `\n\t\t"$electric":${JSON.stringify(b.electric)},` +
    `\n\t\t"$nodeRef":${JSON.stringify(b.nodeRef)}, "$nodeX":${JSON.stringify(b.nodeX)}, "$nodeY":${JSON.stringify(b.nodeY)},` +
    `\n\t\t"$deformGroup":${JSON.stringify(b.deformGroup)},` +
    `\n\t\t"$posX":${fmtNum(b.pos.x, 4)}, "$posY":${fmtNum(b.pos.y, 4)}, "$posZ":${fmtNum(b.pos.z, 4)},` +
    `\n\t\t"$rotX":${fmtNum(b.rot.x, 2)}, "$rotY":${fmtNum(b.rot.y, 2)}, "$rotZ":${fmtNum(b.rot.z, 2)},` +
    `\n\t\t"$shadowEnable":${b.shadow ? 1 : 0},` +
    extra.replace(/\t\t\t/g, '\t\t') +
    `\n\t}` +
    `\n}]`
  );
}

/**
 * Light direction for bulb rotations (world frame): rotZ 0 = rearward (+Y), 180 = forward,
 * rotX 90 = down; rotZ is applied first, then rotX pitches in the plane of the world X axis.
 */
export function bulbDirection(rotX: number, rotZ: number): V3 {
  const z = (rotZ * Math.PI) / 180, x = (rotX * Math.PI) / 180;
  // heading
  const hx = Math.sin(z), hy = Math.cos(z);
  // pitch about world X
  return { x: hx, y: hy * Math.cos(x), z: -hy * Math.sin(x) };
}

export const BULB_ROT_PRESETS: Array<{ label: string; rot: V3 }> = [
  { label: 'Forward (headlight)', rot: { x: 0, y: 0, z: 180 } },
  { label: 'Rearward (tail/brake/reverse)', rot: { x: 0, y: 0, z: 0 } },
  { label: 'Down (dome / trunk / footwell)', rot: { x: 90, y: 0, z: 0 } },
  { label: 'Left side marker (+X)', rot: { x: 0, y: 0, z: -270 } },
  { label: 'Right side marker (−X)', rot: { x: 0, y: 0, z: -90 } },
  { label: 'Front corner left', rot: { x: 0, y: 0, z: 150 } },
  { label: 'Front corner right', rot: { x: 0, y: 0, z: 210 } },
  { label: 'Rear corner left', rot: { x: 0, y: 0, z: 20 } },
  { label: 'Rear corner right', rot: { x: 0, y: 0, z: 340 } },
  { label: 'Plate light above plate', rot: { x: 100, y: 0, z: 0 } },
  { label: 'Plate light below plate', rot: { x: -100, y: 0, z: 0 } },
];

// ------------------------------------------------------------------------------------------
// occupants
// ------------------------------------------------------------------------------------------

export interface OccupantSpec {
  slotName: string;
  description: string;
  seatID: string;
  highlightMesh: string;
  nodeMove: V3;
  recline: number; // degrees, negative tilts back
  attach: { FL: string; FR: string; RL: string; RR: string; TL: string; TR: string };
  rigidifier: string;
  dragCoef: number;
  noSelfCol: boolean;
}

export function occupantSlotRow(o: OccupantSpec): string {
  const a = o.attach;
  return (
    `[${JSON.stringify(o.slotName)}, ["seat_occupant"], [], "occupant_generic", ${JSON.stringify(o.description)}, {` +
    `\n\t"coreSlot":true,` +
    `\n\t"nodeMove":${n3(o.nodeMove, 3)},` +
    `\n\t"nodeRotate1":{"x":${fmtNum(o.recline, 2)}, "y":0, "z":0},` +
    `\n\t"variables": {` +
    `\n\t\t"$seatID": ${JSON.stringify(o.seatID)},` +
    (o.highlightMesh ? `\n\t\t"$TriggerHighlightMesh": ${JSON.stringify(o.highlightMesh)},` : '') +
    `\n\t\t"$occupant_camPitch": ${fmtNum(-o.recline, 2)},` +
    `\n\t\t"$occupantDragCoef": ${fmtNum(o.dragCoef, 2)},` +
    `\n\t\t"$seatAttachmentStrength": "FLT_MAX",` +
    `\n\t\t"$occupant_attachnodeFL": ${JSON.stringify(a.FL)},` +
    `\n\t\t"$occupant_attachnodeFR": ${JSON.stringify(a.FR)},` +
    `\n\t\t"$occupant_attachnodeRL": ${JSON.stringify(a.RL)},` +
    `\n\t\t"$occupant_attachnodeRR": ${JSON.stringify(a.RR)},` +
    `\n\t\t"$occupant_attachnodeTL": ${JSON.stringify(a.TL)},` +
    `\n\t\t"$occupant_attachnodeTR": ${JSON.stringify(a.TR)},` +
    `\n\t\t"$occupant_attachnodeRigifier": ${JSON.stringify(o.rigidifier)},` +
    (o.noSelfCol ? `\n\t\t"$occupant_Node2SelfCol": "$=false",` : '') +
    `\n\t}` +
    `\n}]`
  );
}

/** Rigidifier node: ~45 cm behind the backrest, at 3/4 backrest height, centred on the seat. */
export function rigidifierPosition(nodes: Record<'FL' | 'FR' | 'RL' | 'RR' | 'TL' | 'TR', V3>): V3 {
  const avg = (...p: V3[]) => ({ x: p.reduce((s, q) => s + q.x, 0) / p.length, y: p.reduce((s, q) => s + q.y, 0) / p.length, z: p.reduce((s, q) => s + q.z, 0) / p.length });
  const rear = avg(nodes.RL, nodes.RR);
  const top = avg(nodes.TL, nodes.TR);
  const front = avg(nodes.FL, nodes.FR);
  const p = { x: rear.x + (top.x - rear.x) * 0.75, y: rear.y + (top.y - rear.y) * 0.75, z: rear.z + (top.z - rear.z) * 0.75 };
  // "behind" = away from the cushion front, horizontally
  let dx = rear.x - front.x, dy = rear.y - front.y;
  const l = Math.hypot(dx, dy) || 1;
  dx /= l;
  dy /= l;
  return { x: p.x + dx * 0.45, y: p.y + dy * 0.45, z: p.z };
}

export function rigidifierBeams(rig: string, a: OccupantSpec['attach']): string[] {
  return [
    '{"beamPrecompression":1, "beamType":"|NORMAL", "beamLongBound":1.0, "beamShortBound":1.0}',
    '{"beamSpring":400000,"beamDamp":300}',
    '{"beamDeform":20000,"beamStrength":"FLT_MAX"}',
    '{"deformLimitExpansion":1.2}',
    `[${JSON.stringify(rig)}, ${JSON.stringify(a.RL)}]`,
    `[${JSON.stringify(rig)}, ${JSON.stringify(a.RR)}]`,
    `[${JSON.stringify(rig)}, ${JSON.stringify(a.TL)}]`,
    `[${JSON.stringify(rig)}, ${JSON.stringify(a.TR)}]`,
    '{"deformLimitExpansion":""}',
  ];
}

// ------------------------------------------------------------------------------------------
// pressure wheels
// ------------------------------------------------------------------------------------------

export interface WheelSpec {
  /** FR, FL, RR, RL ... */
  name: string;
  center: V3;
  /** axle node prefix, e.g. "fw1" -> fw1r (inner) / fw1rr (outer) */
  prefix: string;
  hubWidth: number;
  nodeArm: string;
  radius: number;
  hubRadius: number;
  tireWidth: number;
  numRays: number;
  pressurePSI: number;
  createNodes: boolean;
}

export function wheelSide(w: WheelSpec): 'l' | 'r' {
  return w.center.x >= 0 ? 'l' : 'r';
}

export function wheelNodes(w: WheelSpec): Array<{ name: string; x: number; y: number; z: number }> {
  const s = wheelSide(w);
  const sign = s === 'l' ? 1 : -1;
  const inner = Math.abs(w.center.x) - w.hubWidth / 2;
  const outer = Math.abs(w.center.x) + w.hubWidth / 2;
  return [
    { name: `${w.prefix}${s}`, x: sign * inner, y: w.center.y, z: w.center.z },
    { name: `${w.prefix}${s}${s}`, x: sign * outer, y: w.center.y, z: w.center.z },
  ];
}

/** Vanilla convention: node1 = outboard, node2 = inboard, wheelDir 1 on the right, -1 on the left. */
export function wheelRow(w: WheelSpec): string {
  const s = wheelSide(w);
  const [inner, outer] = wheelNodes(w);
  const dir = s === 'r' ? 1 : -1;
  return `[${JSON.stringify(w.name)}, "wheel_${w.name}", "tire_${w.name}", ${JSON.stringify(outer.name)}, ${JSON.stringify(inner.name)}, 9999, ${JSON.stringify(w.nodeArm || inner.name)}, ${dir}]`;
}

export function wheelModifierRows(w: WheelSpec): string[] {
  return [
    `{"radius":${fmtNum(w.radius, 3)}, "hubRadius":${fmtNum(w.hubRadius, 3)}, "tireWidth":${fmtNum(w.tireWidth, 3)}, "hubWidth":${fmtNum(w.hubWidth, 3)}, "numRays":${w.numRays}}`,
    `{"pressurePSI":${fmtNum(w.pressurePSI, 1)}, "hasTire":true, "enableTireLbeams":true, "enableTireSideReinfBeams":true, "enableTreadReinfBeams":true}`,
    '{"nodeWeight":0.25, "hubNodeWeight":0.7, "frictionCoef":1.0, "nodeMaterial":"|NM_RUBBER", "hubNodeMaterial":"|NM_METAL"}',
  ];
}
