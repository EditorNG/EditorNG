import { parseSjson, toJs } from '../sjson';
import type { VehicleConfig } from './types';

/**
 * Normalizes a .pc part configuration. Handles the current format
 * ({format:2, parts:{...}, vars:{...}}), the tree format (partsTree) and the legacy
 * flat format where the whole file is the slot -> part map.
 */
export function normalizeConfig(raw: any): VehicleConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  if (raw.parts || raw.partsTree || raw.format !== undefined) {
    const cfg: VehicleConfig = { ...raw };
    if (cfg.parts && typeof cfg.parts !== 'object') delete cfg.parts;
    if (!cfg.vars || typeof cfg.vars !== 'object') cfg.vars = {};
    return cfg;
  }
  const parts: Record<string, string> = {};
  for (const k in raw) if (typeof raw[k] === 'string') parts[k] = raw[k];
  return { parts, vars: {} };
}

export function parseConfig(text: string): VehicleConfig {
  return normalizeConfig(toJs(parseSjson(text).root));
}
