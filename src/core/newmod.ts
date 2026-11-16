/**
 * Files for a new mod: a new vehicle / prop, or new parts for an existing vehicle. Pure functions;
 * the text follows the formatting of the game's own files (woodcrate for props, etk800 for the
 * info / config files), so a new mod reads like a vanilla one.
 */
import type { PartDef } from './jbeam/types';
import { objGet, type AObj } from './sjson';

export type VehicleType = 'Car' | 'Truck' | 'Trailer' | 'Prop';

/** one file of the new mod, relative to the mod folder ("vehicles/x/x.jbeam") */
export interface NewFile {
  path: string;
  text: string;
}

// ---------------------------------------------------------------------------------------------
// names
// ---------------------------------------------------------------------------------------------

/** "My Rally Box!" -> "my_rally_box" (letters, digits, _; starts with a letter) */
export function slug(s: string): string {
  const out = s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return /^[0-9]/.test(out) ? 'v' + out : out;
}

/** "rally_bumper" -> "Rally Bumper" */
export function titleOf(id: string): string {
  return id
    .split(/[_\-\s]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');
}

/** Why a mod folder name can't be used (same rules as Pack mod), or null. */
export function modNameError(name: string): string | null {
  if (!name) return 'Give the mod a name';
  if (!/^[A-Za-z0-9_-]+$/.test(name)) return 'Only letters, digits, - and _ (no spaces)';
  if (/(^|[_-])v\d+([_-]\d+)*$/i.test(name)) return 'Leave the version out of the name, so updates replace the old zip';
  if (name.length > 60) return 'Keep it under 60 characters';
  return null;
}

/** Why a vehicle id can't be used, or null. */
export function vehicleIdError(id: string): string | null {
  if (!id) return 'Give the vehicle a name';
  if (!/^[a-z][a-z0-9_]*$/.test(id)) return 'Lowercase letters, digits and _, starting with a letter';
  if (id === 'common') return '"common" is the game\'s shared folder';
  return null;
}

/** Why a part name can't be used (format only; clashes are checked against the vehicle), or null. */
export function partNameError(name: string): string | null {
  if (!name) return 'Give the part a name';
  if (!/^[A-Za-z0-9_-]+$/.test(name)) return 'Letters, digits, _ and - only';
  return null;
}

/**
 * Part name for a slot: the mod name in place of the vehicle prefix.
 * ("rally", "etk800_bumper_F", "etk800") -> "rally_bumper_F"
 */
export function partNameFor(mod: string, slotType: string, model: string): string {
  const m = mod.replace(/-/g, '_');
  const lower = slotType.toLowerCase();
  const pre = model.toLowerCase() + '_';
  const rest = lower.startsWith(pre) ? slotType.slice(pre.length) : slotType;
  if (rest.toLowerCase().startsWith(m.toLowerCase())) return rest;
  // words at the end of the mod name that start the slot ("rally_bumper" + "bumper_F") are said once
  const a = m.split('_'), b = rest.split('_');
  for (let k = Math.min(a.length, b.length - 1); k > 0; k--) {
    if (a.slice(-k).join('_').toLowerCase() === b.slice(0, k).join('_').toLowerCase()) return [...a, ...b.slice(k)].join('_');
  }
  return `${m}_${rest}`;
}

/** Display name: the mod's words that the slot name doesn't already have, then the slot name. */
export function partTitleFor(mod: string, slotDescription: string): string {
  const desc = slotDescription.trim() || 'Part';
  const have = new Set(desc.toLowerCase().split(/\s+/));
  const extra = titleOf(mod).split(' ').filter((w) => !have.has(w.toLowerCase()));
  return [...extra, desc].join(' ');
}

const q = (s: string) => JSON.stringify(s);

// ---------------------------------------------------------------------------------------------
// new vehicle / prop
// ---------------------------------------------------------------------------------------------

export interface NewVehicleOptions {
  id: string;
  name: string;
  brand: string;
  type: VehicleType;
  author: string;
  template: 'box' | 'empty';
}

/** name of the default configuration of a new vehicle */
export const BASE_CONFIG = 'base';

// a 1 m cube, bottom on the ground. +X is the vehicle's left, -Y its front (BeamNG axes);
// the l / r suffixes match, so X symmetry works on it
const BOX_NODES: Array<[string, number, number, number]> = [
  ['b1r', -0.5, -0.5, 0.0],
  ['b1l', 0.5, -0.5, 0.0],
  ['b2r', -0.5, -0.5, 1.0],
  ['b2l', 0.5, -0.5, 1.0],
  ['b3r', -0.5, 0.5, 0.0],
  ['b3l', 0.5, 0.5, 0.0],
  ['b4r', -0.5, 0.5, 1.0],
  ['b4l', 0.5, 0.5, 1.0],
];

// faces as quads (corner order does not matter, winding is fixed below)
const BOX_FACES: Array<[string, string[]]> = [
  ['front', ['b1r', 'b1l', 'b2l', 'b2r']],
  ['rear', ['b3r', 'b3l', 'b4l', 'b4r']],
  ['right', ['b1r', 'b3r', 'b4r', 'b2r']],
  ['left', ['b1l', 'b3l', 'b4l', 'b2l']],
  ['top', ['b2r', 'b2l', 'b4l', 'b4r']],
  ['bottom', ['b1r', 'b1l', 'b3l', 'b3r']],
];

const P = (n: string) => {
  const r = BOX_NODES.find((x) => x[0] === n)!;
  return [r[1], r[2], r[3]];
};
const sub = (a: number[], b: number[]) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const CENTER = [0, 0, 0.5];

/** Two triangles per face, wound so (b - a) x (c - a) points out of the box (the game's convention). */
export function boxTriangles(): Array<[string, string, string]> {
  const out: Array<[string, string, string]> = [];
  for (const [, [a, b, c, d]] of BOX_FACES) {
    for (const t of [[a, b, c], [a, c, d]] as Array<[string, string, string]>) {
      const n = cross(sub(P(t[1]), P(t[0])), sub(P(t[2]), P(t[0])));
      out.push(dot(n, sub(P(t[0]), CENTER)) > 0 ? t : [t[0], t[2], t[1]]);
    }
  }
  return out;
}

/** Edges, face diagonals and the four space diagonals: a box that holds its shape. */
function boxBeams(): { edges: Array<[string, string]>; faces: Array<[string, string]>; cross: Array<[string, string]> } {
  const edges: Array<[string, string]> = [];
  const faces: Array<[string, string]> = [];
  for (const [, [a, b, c, d]] of BOX_FACES) {
    for (const e of [[a, b], [b, c], [c, d], [d, a]] as Array<[string, string]>) {
      if (!edges.some((x) => (x[0] === e[0] && x[1] === e[1]) || (x[0] === e[1] && x[1] === e[0]))) edges.push(e);
    }
    faces.push([a, c], [b, d]);
  }
  return { edges, faces, cross: [['b1r', 'b4l'], ['b1l', 'b4r'], ['b3r', 'b2l'], ['b3l', 'b2r']] };
}

const num = (x: number) => x.toFixed(2);

function boxBody(o: NewVehicleOptions, body: string): string {
  const b = boxBeams();
  const beamRows = (l: Array<[string, string]>) => l.map(([a, c]) => `        [${q(a)}, ${q(c)}],`).join('\n');
  return `    "refNodes":[
        ["ref:", "back:", "left:", "up:"],
        ["b1r", "b3r", "b1l", "b2r"],
    ],
    "cameraExternal":{
        "distance":5,
        "distanceMin":2,
        "offset":{"x":0, "y":0.0, "z":0.5},
        "fov":65,
    },
    "flexbodies": [
        ["mesh", "[group]:"],
        [${q(o.id + '_box')}, [${q(body)}]],
    ],
    "nodes": [
        ["id", "posX", "posY", "posZ"],
        {"frictionCoef":0.7},
        {"nodeMaterial":"|NM_METAL"},
        {"nodeWeight":12.5},
        {"collision":true},
        {"selfCollision":false},
        {"group":${q(body)}},
${BOX_NODES.map(([n, x, y, z]) => `        [${q(n)}, ${num(x)}, ${num(y)}, ${num(z)}],`).join('\n')}
        {"group":""},
    ],
    "beams": [
        ["id1:", "id2:"],
        {"beamPrecompression":1, "beamType":"|NORMAL", "beamLongBound":1, "beamShortBound":1},
        {"beamSpring":2001000,"beamDamp":150},
        {"beamDeform":40000,"beamStrength":"FLT_MAX"},
        //edges
${beamRows(b.edges)}
        //faces
${beamRows(b.faces)}
        //diagonals
${beamRows(b.cross)}
    ],
    "triangles": [
        ["id1:","id2:","id3:"],
        {"dragCoef":20},
        {"groundModel":"metal"},
${boxTriangles().map(([a, c, d]) => `        [${q(a)},${q(c)},${q(d)}],`).join('\n')}
        {"groundModel":""},
    ],
`;
}

function emptyBody(): string {
  return `    "flexbodies": [
        ["mesh", "[group]:"],
    ],
    "nodes": [
        ["id", "posX", "posY", "posZ"],
    ],
    "beams": [
        ["id1:", "id2:"],
    ],
    "triangles": [
        ["id1:","id2:","id3:"],
    ],
`;
}

/** The main .jbeam: a main part with one core slot, and the body part in it (like the game's props). */
export function vehicleJbeam(o: NewVehicleOptions): string {
  const body = `${o.id}_body`;
  return `{
${q(o.id)}: {
    "information":{
        "authors":${q(o.author)},
        "name":${q(o.name)},
    },
    "slotType" : "main",
    "slots2": [
        ["name", "allowTypes", "denyTypes", "default", "description"],
        [${q(body)}, [${q(body)}], [], ${q(body)}, "Body", {"coreSlot":true}],
    ],
},
${q(body)}: {
    "information":{
        "authors":${q(o.author)},
        "name":${q(o.name + ' Body')},
        "value":1000,
    },
    "slotType" : ${q(body)},
${o.template === 'box' ? boxBody(o, body) : emptyBody()}},
}
`;
}

/** info.json, ordered and spaced like the game's cars */
export function vehicleInfo(o: NewVehicleOptions): string {
  const j: Array<[string, string]> = [['Author', o.author]];
  if (o.brand.trim()) j.push(['Brand', o.brand.trim()]);
  j.push(['Name', o.name], ['Type', o.type], ['default_pc', BASE_CONFIG]);
  return `{\n${j.map(([k, v]) => `  ${q(k)}: ${q(v)}`).join(',\n')}\n}\n`;
}

/** info_<config>.json, spaced like the game's config info files */
export function configInfo(name: string, value: number, type = 'Factory'): string {
  return `{\n  "Config Type":${q(type)},\n  "Configuration":${q(name)},\n  "Value":${value}\n}\n`;
}

/** a .pc (format 2), spaced like the game's */
export function pcText(model: string, mainPart: string, parts: Record<string, string>, vars: Record<string, number> = {}): string {
  const entries = Object.entries(parts);
  const v = Object.entries(vars);
  return `{
  "format":2,
  "mainPartName":${q(mainPart)},
  "model":${q(model)},
  "parts":{
${entries.map(([k, p]) => `    ${q(k)}:${q(p)}`).join(',\n')}
  },
  "vars":{${v.length ? '\n' + v.map(([k, x]) => `    ${q(k)}:${x}`).join(',\n') + '\n  ' : ''}}
}
`;
}

/** main.materials.json with the box's plain material */
export function boxMaterials(id: string): string {
  const name = `${id}_box`;
  return `{
  ${q(name)}: {
    "name": ${q(name)},
    "mapTo": ${q(name)},
    "class": "Material",
    "Stages": [
      {
        "baseColorFactor": [0.8, 0.45, 0.1, 1],
        "metallicFactor": 0,
        "roughnessFactor": 0.55
      },
      {},
      {},
      {}
    ],
    "dynamicCubemap": true,
    "materialTag0": "beamng",
    "materialTag1": "vehicle",
    "version": 1.5
  }
}
`;
}

/** The box mesh: a Collada file like a Blender export (Z up, metres), one object named <id>_box. */
export function boxDae(id: string): string {
  const name = `${id}_box`;
  const pos: number[] = [];
  const nrm: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  let v = 0;
  for (const [, quad] of BOX_FACES) {
    const pts = quad.map(P);
    let n = cross(sub(pts[1], pts[0]), sub(pts[2], pts[0]));
    const order = dot(n, sub(pts[0], CENTER)) > 0 ? [0, 1, 2, 3] : [0, 3, 2, 1];
    if (order[1] === 3) n = n.map((x) => -x);
    const len = Math.hypot(n[0], n[1], n[2]);
    nrm.push(n[0] / len, n[1] / len, n[2] / len);
    const f = nrm.length / 3 - 1;
    order.forEach((k, i) => {
      pos.push(...pts[k]);
      uv.push(i === 0 || i === 3 ? 0 : 1, i < 2 ? 0 : 1);
    });
    for (const t of [[0, 1, 2], [0, 2, 3]]) for (const i of t) idx.push(v + i, f, v + i);
    v += 4;
  }
  const arr = (a: number[]) => a.map((x) => +x.toFixed(6)).join(' ');
  return `<?xml version="1.0" encoding="utf-8"?>
<COLLADA xmlns="http://www.collada.org/2005/11/COLLADASchema" version="1.4.1" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <asset>
    <contributor>
      <author>${xml(name)}</author>
      <authoring_tool>EditorNG</authoring_tool>
    </contributor>
    <unit name="meter" meter="1"/>
    <up_axis>Z_UP</up_axis>
  </asset>
  <library_effects>
    <effect id="${name}-effect">
      <profile_COMMON>
        <technique sid="common">
          <lambert>
            <diffuse>
              <color sid="diffuse">0.8 0.45 0.1 1</color>
            </diffuse>
          </lambert>
        </technique>
      </profile_COMMON>
    </effect>
  </library_effects>
  <library_materials>
    <material id="${name}-material" name="${name}">
      <instance_effect url="#${name}-effect"/>
    </material>
  </library_materials>
  <library_geometries>
    <geometry id="${name}-mesh" name="${name}">
      <mesh>
        <source id="${name}-mesh-positions">
          <float_array id="${name}-mesh-positions-array" count="${pos.length}">${arr(pos)}</float_array>
          <technique_common>
            <accessor source="#${name}-mesh-positions-array" count="${pos.length / 3}" stride="3">
              <param name="X" type="float"/>
              <param name="Y" type="float"/>
              <param name="Z" type="float"/>
            </accessor>
          </technique_common>
        </source>
        <source id="${name}-mesh-normals">
          <float_array id="${name}-mesh-normals-array" count="${nrm.length}">${arr(nrm)}</float_array>
          <technique_common>
            <accessor source="#${name}-mesh-normals-array" count="${nrm.length / 3}" stride="3">
              <param name="X" type="float"/>
              <param name="Y" type="float"/>
              <param name="Z" type="float"/>
            </accessor>
          </technique_common>
        </source>
        <source id="${name}-mesh-map-0">
          <float_array id="${name}-mesh-map-0-array" count="${uv.length}">${arr(uv)}</float_array>
          <technique_common>
            <accessor source="#${name}-mesh-map-0-array" count="${uv.length / 2}" stride="2">
              <param name="S" type="float"/>
              <param name="T" type="float"/>
            </accessor>
          </technique_common>
        </source>
        <vertices id="${name}-mesh-vertices">
          <input semantic="POSITION" source="#${name}-mesh-positions"/>
        </vertices>
        <triangles material="${name}-material" count="${idx.length / 9}">
          <input semantic="VERTEX" source="#${name}-mesh-vertices" offset="0"/>
          <input semantic="NORMAL" source="#${name}-mesh-normals" offset="1"/>
          <input semantic="TEXCOORD" source="#${name}-mesh-map-0" offset="2" set="0"/>
          <p>${idx.join(' ')}</p>
        </triangles>
      </mesh>
    </geometry>
  </library_geometries>
  <library_visual_scenes>
    <visual_scene id="Scene" name="Scene">
      <node id="${name}" name="${name}" type="NODE">
        <matrix sid="transform">1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1</matrix>
        <instance_geometry url="#${name}-mesh" name="${name}">
          <bind_material>
            <technique_common>
              <instance_material symbol="${name}-material" target="#${name}-material">
                <bind_vertex_input semantic="UVMap" input_semantic="TEXCOORD" input_set="0"/>
              </instance_material>
            </technique_common>
          </bind_material>
        </instance_geometry>
      </node>
    </visual_scene>
  </library_visual_scenes>
  <scene>
    <instance_visual_scene url="#Scene"/>
  </scene>
</COLLADA>
`;
}

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Every text file of a new vehicle (thumbnails are rendered afterwards). */
export function newVehicleFiles(o: NewVehicleOptions): NewFile[] {
  const dir = `vehicles/${o.id}`;
  const files: NewFile[] = [
    { path: `${dir}/${o.id}.jbeam`, text: vehicleJbeam(o) },
    { path: `${dir}/info.json`, text: vehicleInfo(o) },
    { path: `${dir}/${BASE_CONFIG}.pc`, text: pcText(o.id, o.id, { [`${o.id}_body`]: `${o.id}_body` }) },
    { path: `${dir}/info_${BASE_CONFIG}.json`, text: configInfo(titleOf(BASE_CONFIG), 1000) },
  ];
  if (o.template === 'box') {
    files.push({ path: `${dir}/${o.id}.dae`, text: boxDae(o.id) }, { path: `${dir}/main.materials.json`, text: boxMaterials(o.id) });
  }
  return files;
}

// ---------------------------------------------------------------------------------------------
// parts for an existing vehicle
// ---------------------------------------------------------------------------------------------

export interface NewPartOptions {
  name: string;
  title: string;
  author: string;
  slotType: string;
}

/** An empty part for a slot, formatted like the game's parts. */
export function emptyPartText(o: NewPartOptions): string {
  return `{
${q(o.name)}: {
    "information":{
        "authors":${q(o.author)},
        "name":${q(o.title)},
        "value":500,
    },
    "slotType" : ${q(o.slotType)},
    "flexbodies": [
         ["mesh", "[group]:"],
    ],
    "nodes": [
         ["id", "posX", "posY", "posZ"],
    ],
    "beams": [
          ["id1:", "id2:"],
    ],
    "triangles": [
          ["id1:","id2:","id3:"],
    ],
},
}
`;
}

/**
 * A copy of an existing part under a new name: the part's own text, untouched but for its key,
 * information.name and information.authors.
 */
export function copyPartText(fileText: string, def: PartDef, o: NewPartOptions): string {
  const s = def.key.s;
  const e = def.node.e;
  const edits: Array<{ s: number; e: number; text: string }> = [{ s: def.key.s, e: def.key.e, text: q(o.name) }];
  const info = objGet(def.node, 'information');
  if (info && info.k === 'obj') {
    const nm = objGet(info as AObj, 'name');
    if (nm && nm.k === 'str') edits.push({ s: nm.s, e: nm.e, text: q(o.title) });
    const au = objGet(info as AObj, 'authors');
    if (au && au.k === 'str') edits.push({ s: au.s, e: au.e, text: q(o.author) });
  }
  let body = fileText.slice(s, e);
  for (const ed of edits.sort((a, b) => b.s - a.s)) body = body.slice(0, ed.s - s) + ed.text + body.slice(ed.e - s);
  const eol = /\r\n/.test(fileText) ? '\r\n' : '\n';
  return `{${eol}${body},${eol}}${eol}`;
}
