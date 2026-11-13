/// <reference lib="webworker" />
import { readDae, scanDaeNames, type DaeFile } from '@core/dae';

const parsed = new Map<string, DaeFile>();
const order: string[] = [];

function getParsed(key: string, text?: string): DaeFile | null {
  let f = parsed.get(key);
  if (f) return f;
  if (text === undefined) return null;
  f = readDae(text);
  parsed.set(key, f);
  order.push(key);
  while (order.length > 3) parsed.delete(order.shift()!);
  return f;
}

self.onmessage = (ev: MessageEvent) => {
  const m = ev.data;
  try {
    if (m.type === 'scan') {
      const text = new TextDecoder().decode(m.buf);
      (self as any).postMessage({ id: m.id, names: scanDaeNames(text) });
    } else if (m.type === 'build') {
      const text = m.buf ? new TextDecoder().decode(m.buf) : undefined;
      const f = getParsed(m.key, text);
      if (!f) {
        (self as any).postMessage({ id: m.id, needText: true });
        return;
      }
      const meshes = [];
      const transfer: ArrayBuffer[] = [];
      for (const name of m.names as string[]) {
        const mesh = f.build(name, !!m.local);
        if (mesh) {
          meshes.push(mesh);
          transfer.push(mesh.pos.buffer as ArrayBuffer, mesh.nrm.buffer as ArrayBuffer);
          if (mesh.uv) transfer.push(mesh.uv.buffer as ArrayBuffer);
        }
      }
      (self as any).postMessage({ id: m.id, meshes }, transfer);
    }
  } catch (e: any) {
    (self as any).postMessage({ id: m.id, error: String(e?.message ?? e) });
  }
};
