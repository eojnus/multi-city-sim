import { contextBridge, ipcRenderer } from 'electron';

const api = {
  platform: process.platform,
  saves: {
    list: () => ipcRenderer.invoke('saves:list'),
    read: (slot: string) => ipcRenderer.invoke('saves:read', slot),
    write: (slot: string, text: string) => ipcRenderer.invoke('saves:write', slot, text),
    remove: (slot: string) => ipcRenderer.invoke('saves:remove', slot),
  },
  app: {
    info: () => ipcRenderer.invoke('app:info'),
    quit: () => ipcRenderer.send('app:quit'),
  },
  onMenuAction: (callback: (action: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, action: string) => callback(action);
    ipcRenderer.on('menu:action', listener);
    return () => ipcRenderer.removeListener('menu:action', listener);
  },
};

contextBridge.exposeInMainWorld('desktopSim', api);

export type DesktopSimApi = typeof api;
