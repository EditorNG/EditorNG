/**
 * What New mod needs to know about a vehicle, read without touching the open workspace: its parts,
 * the slots of its default configuration and the parts that fit each one. Cached per vehicle.
 */
import { api } from '../lib/api';
import { parseJbeamFile } from '@core/jbeam/parts';
import { PartLibrary, resolveTree } from '@core/jbeam/assemble';
import { normalizeConfig } from '@core/jbeam/config';
import { parseSjson, toJs } from '@core/sjson';
import type { PartDef, SlotNode, VehicleConfig } from '@core/jbeam/types';
import { settings } from '../state/settings';

export interface SlotChoice {
  id: string;
  /** readable name ("Front Bumper") */
  description: string;
  /** part that fills it in the default configuration ('' = empty) */
  current: string;
  /** parts that fit, the current one first */
  candidates: PartDef[];
  /** slot type a new part must declare */
  slotType: string;
  /** depth in the slot tree (for indenting) */
  level: number;
}

export interface ModelInfo {
  model: string;
  lib: PartLibrary;
  mainPart: string;
  slots: SlotChoice[];
  /** default configuration, as slot -> part */
  defaultParts: Record<string, string>;
  defaultVars: Record<string, number>;
  /** value of the default configuration (its info_*.json), for a new config */
  defaultValue: number;
  /** text of each .jbeam, by vpath (lower case), to copy parts from */
  texts: Map<string, string>;
}

const cache = new Map<string, Promise<ModelInfo>>();

export function loadModel(model: string): Promise<ModelInfo> {
  const key = model.toLowerCase();
  let p = cache.get(key);
  if (!p) {
    p = load(model);
    cache.set(key, p);
    p.catch(() => cache.delete(key));
  }
  return p;
}

/** forget cached vehicles (after files were written) */
export function clearModelCache() {
  cache.clear();
}

async function load(model: string): Promise<ModelInfo> {
  const [own, common] = await Promise.all([
    api.listTree('vehicles/' + model),
    settings().loadCommonFolder ? api.listTree('vehicles/common') : Promise.resolve([]),
  ]);
  const ownJ = own.filter((f) => /\.jbeam$/i.test(f.vpath));
  const comJ = common.filter((f) => /\.jbeam$/i.test(f.vpath));
  const [ownT, comT] = await Promise.all([api.readTexts(ownJ), api.readTexts(comJ)]);
  const texts = new Map<string, string>();
  ownJ.forEach((f, i) => texts.set(f.vpath.toLowerCase(), ownT[i]));
  comJ.forEach((f, i) => texts.set(f.vpath.toLowerCase(), comT[i]));
  const lib = new PartLibrary([ownJ.map((f, i) => parseJbeamFile(f.vpath, ownT[i])), comJ.map((f, i) => parseJbeamFile(f.vpath, comT[i]))]);

  // default configuration (info.json → default_pc)
  const json = async (vpath: string) => {
    const f = own.find((x) => x.vpath.toLowerCase() === vpath.toLowerCase());
    if (!f) return null;
    try {
      return toJs(parseSjson((await api.readTexts([f]))[0]).root);
    } catch {
      return null;
    }
  };
  const info = await json(`vehicles/${model}/info.json`);
  const pcName = typeof info?.default_pc === 'string' ? info.default_pc : '';
  let cfg: VehicleConfig = {};
  let defaultValue = 0;
  if (pcName) {
    const pc = await json(`vehicles/${model}/${pcName}.pc`);
    if (pc) cfg = normalizeConfig(pc);
    const ci = await json(`vehicles/${model}/info_${pcName}.json`);
    if (typeof ci?.Value === 'number') defaultValue = ci.Value;
  }

  const res = resolveTree(lib, cfg);
  const slots: SlotChoice[] = [];
  const defaultParts: Record<string, string> = {};
  const walk = (list: SlotNode[], level: number) => {
    for (const sn of list) {
      defaultParts[sn.id] = sn.chosen;
      const fits = lib.compatible(sn.def);
      const cur = fits.find((p) => p.name === sn.chosen);
      slots.push({
        id: sn.id,
        description: sn.def.description || sn.id,
        current: sn.chosen,
        candidates: cur ? [cur, ...fits.filter((p) => p !== cur)] : fits,
        slotType: sn.def.allowTypes[0] ?? sn.def.type ?? sn.id,
        level,
      });
      if (sn.part) walk(sn.part.slots, level + 1);
    }
  };
  if (res.root) walk(res.root.slots, 0);
  return {
    model,
    lib,
    mainPart: res.root?.def.name ?? lib.mainPart ?? model,
    slots,
    defaultParts,
    defaultVars: { ...(cfg.vars ?? {}) },
    defaultValue,
    texts,
  };
}
