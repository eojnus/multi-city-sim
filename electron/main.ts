import { app, BrowserWindow, ipcMain, Menu, shell } from 'electron';
import path from 'node:path';
import { registerSaveHandlers } from './saveIpc';

const isDev = Boolean(process.env.VITE_DEV_SERVER_URL);

let mainWindow: BrowserWindow | null = null;

function savesDirectory(): string {
  return path.join(app.getPath('userData'), 'saves');
}

function buildMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: '游戏',
      submenu: [
        { label: '保存进度', accelerator: 'CmdOrCtrl+S', click: () => mainWindow?.webContents.send('menu:action', 'save') },
        { label: '读取进度', accelerator: 'CmdOrCtrl+O', click: () => mainWindow?.webContents.send('menu:action', 'load') },
        { type: 'separator' },
        { label: '暂停 / 继续', accelerator: 'Space', click: () => mainWindow?.webContents.send('menu:action', 'toggle-pause') },
        { label: '推进一个月', accelerator: 'CmdOrCtrl+N', click: () => mainWindow?.webContents.send('menu:action', 'tick') },
        { type: 'separator' },
        { role: 'quit', label: '退出' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新加载' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '重置缩放' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { role: 'togglefullscreen', label: '全屏' },
      ],
    },
    {
      label: '帮助',
      submenu: [
        { label: '资源署名', click: () => mainWindow?.webContents.send('menu:action', 'credits') },
        { label: '演示参数与假设', click: () => mainWindow?.webContents.send('menu:action', 'assumptions') },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    backgroundColor: '#08111f',
    title: '岚湾区域 · 多城经济模拟',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webviewTag: false,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    const allowed = isDev
      ? url.startsWith(process.env.VITE_DEV_SERVER_URL ?? 'http://localhost:5173')
      : url.startsWith('file://');
    if (!allowed) event.preventDefault();
  });

  if (isDev) {
    await mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL as string);
  } else {
    await mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }
}

ipcMain.handle('app:info', async () => ({
  platform: process.platform,
  appVersion: app.getVersion(),
  electronVersion: process.versions.electron,
  saveDirectory: savesDirectory(),
}));

ipcMain.on('app:quit', () => {
  app.quit();
});

app.whenReady().then(async () => {
  registerSaveHandlers(savesDirectory);
  buildMenu();
  await createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
