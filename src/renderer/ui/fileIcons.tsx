/**
 * File-type icons for the explorer, the tabs and the search bar, in the spirit of VS Code's
 * Seti / Material icon themes: one recognisable glyph and colour per kind of file, so .jbeam files
 * stand out without everything being orange.
 */
import { Share2, Braces, SlidersHorizontal, Moon, Image as ImageIcon, Box, Palette, Info, FileText, File as FileIcon, Folder, FolderOpen, Music, Map as MapIcon } from 'lucide-react';

const C = {
  jbeam: '#e37933',
  json: '#cbcb41',
  pc: '#6d9fd6',
  lua: '#5b7fd6',
  image: '#4fae7b',
  mesh: '#a074c4',
  material: '#d16d9e',
  info: '#519aba',
  md: '#519aba',
  sound: '#d4a24a',
  text: 'var(--text-faint)',
  folder: '#8f9aa8',
};

export function fileIconFor(name: string, size = 14): React.ReactNode {
  const n = name.toLowerCase();
  const ext = n.slice(n.lastIndexOf('.') + 1);
  const ic = (El: typeof FileIcon, color: string) => <El size={size} style={{ color, flex: 'none' }} />;
  if (ext === 'jbeam') return ic(Share2, C.jbeam);
  if (ext === 'pc') return ic(SlidersHorizontal, C.pc);
  if (n.endsWith('materials.json') || n.endsWith('.cs') && n.includes('material')) return ic(Palette, C.material);
  if (/^info.*\.json$/.test(n)) return ic(Info, C.info);
  if (ext === 'json') return ic(Braces, C.json);
  if (ext === 'lua') return ic(Moon, C.lua);
  if (/^(png|jpe?g|dds|tga|bmp|gif|webp|hdr|exr)$/.test(ext)) return ic(ImageIcon, C.image);
  if (/^(dae|cdae|obj|fbx|blend)$/.test(ext)) return ic(Box, C.mesh);
  if (/^(ogg|wav|mp3|sbeam)$/.test(ext)) return ic(Music, C.sound);
  if (ext === 'md') return ic(FileText, C.md);
  if (/^(ter|mis|prefab|decals)$/.test(ext)) return ic(MapIcon, C.info);
  if (/^(txt|ini|csv|cs|log)$/.test(ext)) return ic(FileText, C.text);
  return ic(FileIcon, C.text);
}

export function folderIcon(open: boolean, size = 14): React.ReactNode {
  const El = open ? FolderOpen : Folder;
  return <El size={size} style={{ color: C.folder, flex: 'none' }} />;
}
