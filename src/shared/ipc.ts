import type { VFile, VehicleInfo } from '../main/vfs';

export type { VFile, VehicleInfo };

export interface EnvInfo {
  /** started by the test scripts: skip session restore */
  automation?: boolean;
  gameDir?: string;
  userDir?: string;
  gameVersion?: string;
  appVersion: string;
  userData: string;
  platform: string;
  /** Vehicle / file requested on the command line, if any. */
  argv: string[];
  isPackaged: boolean;
  /** started by the updater after a successful update, from this version */
  updatedFrom?: string;
  /** started by the updater after a failed update: busy | backup | copy */
  updateFailed?: string;
  /** last lines of the updater log, when it failed */
  updateLog?: string;
}

export type FileRef = Pick<VFile, 'vpath' | 'mount' | 'real'>;

export interface DirEntry {
  name: string;
  path: string;
  dir: boolean;
  size: number;
}

export interface BlenderMeshObject {
  name: string;
  /** flat xyz, already in world space (metres, Z up) */
  verts: number[];
  edges: number[];
  /** triangulated faces, flat index triples */
  tris: number[];
  /** indices of edges that are not part of any face */
  looseEdges: number[];
  vertexGroups: string[];
  /** per-vertex group index (-1 none), highest weight */
  vertGroup: number[];
  collection: string;
}

export interface BlenderExtract {
  ok: boolean;
  error?: string;
  blenderVersion?: string;
  objects: BlenderMeshObject[];
}

export interface Api {
  env(): Promise<EnvInfo>;
  settingsLoad(): Promise<Record<string, any>>;
  settingsSave(values: Record<string, any>): Promise<void>;
  stateLoad(): Promise<Record<string, any>>;
  stateSave(values: Record<string, any>): Promise<void>;

  configureRoots(roots: { gameDir?: string; userDir?: string; extraRoots?: string[] }): Promise<{ gameDir?: string; userDir?: string }>;
  listVehicles(): Promise<VehicleInfo[]>;
  listTree(vdir: string): Promise<VFile[]>;
  readTexts(files: FileRef[]): Promise<string[]>;
  readBinary(file: FileRef): Promise<Uint8Array>;
  findFile(vpath: string): Promise<VFile | null>;
  /** every provider of a path, highest priority first */
  findAllFiles(vpath: string): Promise<VFile[]>;
  listBackups(real: string, backupDir?: string): Promise<Array<{ path: string; time: number }>>;
  scanMod(modDir: string): Promise<{ name: string; files: string[]; total: number; issues: Array<{ sev: 'error' | 'warning' | 'info'; msg: string; file?: string }> }>;
  packMod(modDir: string, outZip: string): Promise<{ files: number; size: number }>;

  readTextFile(real: string): Promise<string>;
  readBinaryFile(real: string): Promise<Uint8Array>;
  writeTextFile(real: string, text: string, opts?: { backup?: boolean; backupDir?: string; keepBackups?: number }): Promise<{ mtime: number }>;
  writeBinaryFile(real: string, data: Uint8Array): Promise<void>;
  stat(real: string): Promise<{ mtime: number; size: number; dir: boolean } | null>;
  listDir(real: string): Promise<DirEntry[]>;
  walkDir(real: string): Promise<DirEntry[]>;
  mkdirp(real: string): Promise<void>;
  copyFromVfs(file: FileRef, destReal: string): Promise<void>;

  pickFolder(title?: string, defaultPath?: string): Promise<string | null>;
  pickFile(opts: { title?: string; defaultPath?: string; filters?: Array<{ name: string; extensions: string[] }> }): Promise<string | null>;
  saveDialog(opts: { title?: string; defaultPath?: string; filters?: Array<{ name: string; extensions: string[] }> }): Promise<string | null>;
  reveal(real: string): Promise<void>;
  openExternal(target: string): Promise<void>;

  cacheRead(key: string): Promise<Uint8Array | null>;
  cacheWrite(key: string, data: Uint8Array): Promise<void>;
  cacheClear(): Promise<void>;

  blenderFind(): Promise<string[]>;
  blenderExtract(blenderExe: string, blendFile: string): Promise<BlenderExtract>;
  installBlenderAddon(blenderExe: string): Promise<{ ok: boolean; message: string }>;

  watch(dirs: string[]): Promise<void>;
  onFsChange(cb: (paths: string[]) => void): () => void;
  onMenu(cb: (cmd: string) => void): () => void;
  onBlenderLink(cb: (data: BlenderExtract) => void): () => void;

  blenderLinkPort(port: number): Promise<void>;
  /** sends a command to the EditorNG bridge mod in the running game; null when nobody answers */
  gameSend(cmd: Record<string, unknown>, timeoutMs?: number): Promise<null | { ok: boolean; error?: string; action?: string; vehicle?: { model: string; config?: string } | null }>;
  gameBridgeStatus(): Promise<{ installed: boolean; dir: string | null; files: string[] }>;
  gameBridgeInstall(): Promise<{ dir: string; files: string[] }>;
  /** new text of <userDir>/beamng.log since offset (reset = the file was rotated / restarted) */
  gameLogRead(offset: number): Promise<{ text: string; size: number; path: string | null; reset: boolean }>;
  windowAction(action: 'minimize' | 'maximize' | 'close' | 'devtools' | 'reload' | 'fullscreen'): Promise<void>;
  setTitleBarColors(colors: { color: string; symbolColor: string }): Promise<void>;
  confirmClose(ok: boolean): void;
  onCloseRequest(cb: () => void): () => void;
  updateCheck(): Promise<import('../main/updater').UpdateCheck>;
  updateDownload(version: string): Promise<{ ok: boolean; staged?: string; error?: string }>;
  updateInstall(version: string, staged: string, notes: unknown): Promise<{ ok: boolean; error?: string }>;
  updateWhatsNew(): Promise<unknown>;
  gameRunning(): Promise<boolean>;
  gameLaunch(o: { level: string; model: string; config?: string }): Promise<{ exe: string; args: string[] }>;
  onUpdateProgress(cb: (p: import('../main/updater').UpdateProgress) => void): () => void;
}
