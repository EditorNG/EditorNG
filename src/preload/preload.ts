import { contextBridge, ipcRenderer, webUtils } from 'electron';

const invokeNames = [
  'env', 'settingsLoad', 'settingsSave', 'stateLoad', 'stateSave', 'configureRoots', 'listVehicles', 'listTree',
  'readTexts', 'readBinary', 'findFile', 'readTextFile', 'readBinaryFile', 'writeTextFile', 'writeBinaryFile', 'stat', 'listDir',
  'walkDir', 'mkdirp', 'copyFromVfs', 'pickFolder', 'pickFile', 'saveDialog', 'reveal', 'openExternal', 'cacheRead',
  'cacheWrite', 'cacheClear', 'blenderFind', 'blenderExtract', 'installBlenderAddon', 'watch', 'blenderLinkPort',
  'windowAction', 'setTitleBarColors', 'gameSend', 'gameBridgeStatus', 'gameBridgeInstall', 'gameLogRead',
  'findAllFiles', 'vfsRescan', 'vehicleCatalog', 'listBackups', 'scanMod', 'modCopyDds', 'packMod', 'updateCheck', 'updateDownload', 'updateInstall', 'updateWhatsNew', 'gameRunning', 'gameLaunch', 'gameFocus',
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
api.onUpdateProgress = on('update:progress');
api.confirmClose = (ok: boolean) => ipcRenderer.send('confirmClose', ok);
/** real path of a file dropped on the window */
api.pathForFile = (f: File) => webUtils.getPathForFile(f);

contextBridge.exposeInMainWorld('api', api);
