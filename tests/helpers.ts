import { Vfs, decodeText, detectBeamNG } from '../src/main/vfs';
import { parseJbeamFile } from '../src/core/jbeam/parts';
import { PartLibrary, assembleVehicle } from '../src/core/jbeam/assemble';
import { parseConfig } from '../src/core/jbeam/config';
import type { JFile, Vehicle, VehicleConfig } from '../src/core/jbeam/types';

let vfsP: Promise<Vfs> | null = null;
export function getVfs(): Promise<Vfs> {
  if (!vfsP) {
    vfsP = (async () => {
      const det = await detectBeamNG();
      const vfs = new Vfs({ gameDir: det.gameDir, userDir: det.userDir });
      await vfs.init();
      return vfs;
    })();
  }
  return vfsP;
}

const dirCache = new Map<string, Promise<JFile[]>>();
export function loadJbeamDir(vdir: string): Promise<JFile[]> {
  let p = dirCache.get(vdir);
  if (!p) {
    p = (async () => {
      const vfs = await getVfs();
      const files = (await vfs.listTree(vdir)).filter((f) => f.vpath.toLowerCase().endsWith('.jbeam'));
      const bufs = await vfs.readMany(files);
      return files.map((f, i) => parseJbeamFile(f.vpath, decodeText(bufs[i])));
    })();
    dirCache.set(vdir, p);
  }
  return p;
}

export async function loadConfig(vpath: string): Promise<VehicleConfig> {
  const vfs = await getVfs();
  const f = await vfs.find(vpath);
  if (!f) throw new Error('config not found: ' + vpath);
  return parseConfig(decodeText(await vfs.read(f)));
}

export async function loadVehicle(model: string, pc?: string): Promise<{ veh: Vehicle | null; lib: PartLibrary; files: JFile[] }> {
  const [own, common] = await Promise.all([loadJbeamDir('vehicles/' + model), loadJbeamDir('vehicles/common')]);
  const lib = new PartLibrary([own, common]);
  const config = pc ? await loadConfig(`vehicles/${model}/${pc}`) : {};
  return { veh: assembleVehicle(lib, config), lib, files: own };
}

export function summarize(veh: Vehicle): string {
  const by: Record<string, number> = {};
  for (const i of veh.issues) by[`${i.sev}:${i.code}`] = (by[`${i.sev}:${i.code}`] ?? 0) + 1;
  return `parts=${veh.parts.length} nodes=${veh.nodes.length} beams=${veh.beams.length} tris=${veh.tris.length} wheels=${veh.wheels.length} flex=${veh.flexbodies.length} props=${veh.props.length} vars=${veh.variables.length} issues=${JSON.stringify(by)}`;
}
