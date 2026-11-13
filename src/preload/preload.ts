import { contextBridge, ipcRenderer } from 'electron';

const invokeNames = [
  'env', 'settingsLoad', 'settingsSave', 'stateLoad', 'stateSave', 'configureRoots', 'listVehicles', 'listTree',
  'readTexts', 'readBinary', 'findFile', 'readTextFile', 'readBinaryFile', 'writeTextFile', 'writeBinaryFile', 'stat', 'listDir',
  'walkDir', 'mkdirp', 'copyFromVfs', 'pickFolder', 'pickFile', 'saveDialog', 'reveal', 'openExternal', 'cacheRead',
  'cacheWrite', 'cacheClear', 'blenderFind', 'blenderExtract', 'installBlenderAddon', 'watch', 'blenderLinkPort',
  'windowAction', 'setTitleBarColors', 'gameSend', 'gameBridgeStatus', 'gameBridgeInstall', 'gameLogRead',
  'findAllFiles', 'listBackups', 'scanMod', 'packMod',
];

const api: Record<string, unknown> = {};
for (const name of invokeNames) {
  api[name] = (...args: unknown[]) => ipcRenderer.invoke(name, ...args);
}

function on(channel: string) {
  return (cb: (...a: any[]) => void) => {
    const fn = (_e: unknown, ...a: any[]) => cb(...a);
    ipcRenderer.on(channel, fn);
    return () => ipcRenderer.removeListener(channel, fn);
  };
}
api.onFsChange = on('fs:change');
api.onMenu = on('menu');
api.onBlenderLink = on('blender:link');
api.onCloseRequest = on('close-request');
api.confirmClose = (ok: boolean) => ipcRenderer.send('confirmClose', ok);

contextBridge.exposeInMainWorld('api', api);
