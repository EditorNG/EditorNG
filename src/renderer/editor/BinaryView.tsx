/**
 * Tab content for files that are not text: images are shown (PNG/JPG… directly, DDS decoded on
 * the GPU), everything else gets a short description and "open with the default app".
 */
import { useEffect, useState } from 'react';
import * as THREE from 'three';
import { ExternalLink, FolderOpen } from 'lucide-react';
import type { Doc } from '../project/workspace';
import { api } from '../lib/api';
import { parseDds } from '../scene/dds';

export const IMAGE_EXT = /\.(png|jpe?g|gif|bmp|webp|dds)$/i;

async function bytesOf(d: Doc): Promise<ArrayBuffer> {
  const b = d.ref.real ? await api.readBinaryFile(d.ref.real) : await api.readBinary(d.ref);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}

/** Decodes a DDS (BC1-7, BGRA) by drawing it once with WebGL; returns a PNG data URL. */
function ddsToUrl(buf: ArrayBuffer): { url: string; w: number; h: number; fmt: string } | null {
  const h32 = new Int32Array(buf, 0, 32);
  const W = h32[4], H = h32[3];
  const scale = Math.min(1, 2048 / Math.max(W, H));
  const w = Math.max(1, Math.round(W * scale)), h = Math.max(1, Math.round(H * scale));
  const r = new THREE.WebGLRenderer({ preserveDrawingBuffer: true, alpha: true });
  try {
    r.setSize(w, h, false);
    r.outputColorSpace = THREE.LinearSRGBColorSpace;
    const t = parseDds(buf, r, false);
    if (!t) return null;
    t.colorSpace = THREE.NoColorSpace;
    const scene = new THREE.Scene();
    const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    // DDS rows are stored top first and uploaded unflipped: flip the quad
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, -2), new THREE.MeshBasicMaterial({ map: t, side: THREE.DoubleSide, transparent: true }));
    scene.add(quad);
    r.render(scene, cam);
    const url = r.domElement.toDataURL('image/png');
    quad.geometry.dispose();
    (quad.material as THREE.Material).dispose();
    t.dispose();
    const four = String.fromCharCode(...new Uint8Array(buf, 84, 4));
    return { url, w: W, h: H, fmt: four === 'DX10' ? `DXGI ${new Int32Array(buf, 128, 1)[0]}` : four.replace(/\0/g, '') || 'RGBA' };
  } finally {
    r.dispose();
    r.forceContextLoss();
  }
}

export function BinaryView({ doc }: { doc: Doc }) {
  const [img, setImg] = useState<{ url: string; w: number; h: number; info: string } | null>(null);
  const [err, setErr] = useState('');
  const [zoom, setZoom] = useState<'fit' | 1>('fit');
  const isImage = IMAGE_EXT.test(doc.name);
  useEffect(() => {
    setImg(null);
    setErr('');
    if (!isImage) return;
    let url = '';
    let dead = false;
    bytesOf(doc)
      .then((buf) => {
        if (dead) return;
        if (/\.dds$/i.test(doc.name)) {
          const r = ddsToUrl(buf);
          if (!r) throw new Error('unsupported DDS format');
          setImg({ url: r.url, w: r.w, h: r.h, info: r.fmt });
          return;
        }
        url = URL.createObjectURL(new Blob([buf]));
        const im = new Image();
        im.onload = () => !dead && setImg({ url, w: im.naturalWidth, h: im.naturalHeight, info: doc.name.split('.').pop()!.toUpperCase() });
        im.onerror = () => !dead && setErr('This image could not be decoded');
        im.src = url;
      })
      .catch((e) => !dead && setErr(String(e?.message ?? e)));
    return () => {
      dead = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [doc.key]);
  const kb = doc.size >= 1048576 ? `${(doc.size / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(doc.size / 1024))} KB`;
  const actions = isImage ? (
    <div className="row" style={{ gap: 2 }}>
      <button className="icon-btn small" disabled={!doc.ref.real} data-tip="Open with the default app" data-tip-pos="bottom-left" onClick={() => doc.ref.real && api.openExternal(doc.ref.real)} aria-label="Open with the default app"><ExternalLink size={13} /></button>
      <button className="icon-btn small" disabled={!doc.ref.real} data-tip="Reveal in Explorer" data-tip-pos="bottom-left" onClick={() => doc.ref.real && api.reveal(doc.ref.real)} aria-label="Reveal in Explorer"><FolderOpen size={13} /></button>
    </div>
  ) : (
    <div className="row" style={{ gap: 6 }}>
      <button className="btn small" disabled={!doc.ref.real} onClick={() => doc.ref.real && api.openExternal(doc.ref.real)}><ExternalLink size={12} /> Open with default app</button>
      <button className="btn small" disabled={!doc.ref.real} onClick={() => doc.ref.real && api.reveal(doc.ref.real)}><FolderOpen size={12} /> Reveal in Explorer</button>
    </div>
  );
  return (
    <div className="binary-view">
      {isImage ? (
        <>
          <div className="binary-bar">
            <span className="mono">{doc.name}</span>
            <span className="faint">{img ? `${img.w} × ${img.h} · ${img.info} · ${kb}` : kb}</span>
            <div className="grow" />
            <div className="segmented small">
              <button className={'seg' + (zoom === 'fit' ? ' active' : '')} onClick={() => setZoom('fit')}>Fit</button>
              <button className={'seg' + (zoom === 1 ? ' active' : '')} onClick={() => setZoom(1)}>100%</button>
            </div>
            {actions}
          </div>
          <div className={'binary-canvas' + (zoom === 'fit' ? ' fit' : '')}>
            {img && <img src={img.url} alt={doc.name} draggable={false} />}
            {!img && !err && <span className="faint">Loading…</span>}
            {err && <span className="warn-text">{err}</span>}
          </div>
        </>
      ) : (
        <div className="binary-other">
          <div className="mono strong">{doc.name}</div>
          <div className="faint">{kb} · not a text file, EditorNG does not edit it</div>
          {actions}
        </div>
      )}
    </div>
  );
}
