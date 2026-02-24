/*
  ╔══════════════════════════════════════════════════════════════════╗
  ║  CHARON — Catalog Harvester & Automated Ripper for Organized    ║
  ║           Navidrome                                             ║
  ╠══════════════════════════════════════════════════════════════════╣
  ║  Main Process — Electron shell, Python bridge, IPC, queue       ║
  ║                                                                  ║
  ║  The ferryman that carries music from Tidal to your AETHER.     ║
  ╚══════════════════════════════════════════════════════════════════╝
*/

const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, dialog, shell } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');

let mainWindow = null;
let tray = null;
let pythonBridge = null;
let pendingRequests = new Map(); // request_id → { resolve, reject, timeout }

// ============ WINDOW ============
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    frame: false,
    backgroundColor: '#0a0a12',
    show: false,
    icon: path.join(__dirname, 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.loadFile('ripper.html');
  mainWindow.once('ready-to-show', () => mainWindow.show());

  mainWindow.on('close', (e) => {
    // Minimize to tray instead of closing
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}

// ============ SYSTEM TRAY ============
function createTray() {
  try {
    const iconPath = path.join(__dirname, 'icon.ico');
    if (fs.existsSync(iconPath)) {
      tray = new Tray(iconPath);
    } else {
      tray = new Tray(nativeImage.createEmpty());
    }
    const contextMenu = Menu.buildFromTemplate([
      { label: 'Show CHARON', click: () => { mainWindow.show(); mainWindow.focus(); } },
      { type: 'separator' },
      { label: 'Quit', click: () => { app.isQuitting = true; app.quit(); } }
    ]);
    tray.setToolTip('CHARON — Tidal Ripper');
    tray.setContextMenu(contextMenu);
    tray.on('double-click', () => { mainWindow.show(); mainWindow.focus(); });
  } catch (e) {
    console.error('Tray creation failed:', e);
  }
}

// ============ PYTHON BRIDGE ============
function startPythonBridge() {
  const bridgePath = path.join(__dirname, 'python', 'charon_bridge.py');
  if (!fs.existsSync(bridgePath)) {
    console.warn('Python bridge not found at', bridgePath);
    return;
  }

  // Find Python
  const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';

  pythonBridge = spawn(pythonCmd, [bridgePath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, PYTHONUNBUFFERED: '1' }
  });

  let stdoutBuffer = '';

  pythonBridge.stdout.on('data', (data) => {
    stdoutBuffer += data.toString();
    // Process complete JSON lines
    const lines = stdoutBuffer.split('\n');
    stdoutBuffer = lines.pop(); // Keep incomplete line in buffer

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const response = JSON.parse(line);
        const reqId = response.request_id;

        // Route progress events to renderer
        if (response.status === 'progress') {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('download-progress', response);
          }
          continue;
        }

        // Resolve pending request
        if (reqId && pendingRequests.has(reqId)) {
          const { resolve, timeout } = pendingRequests.get(reqId);
          clearTimeout(timeout);
          pendingRequests.delete(reqId);
          resolve(response);
        }
      } catch (e) {
        console.error('Bridge JSON parse error:', e.message, 'line:', line.substring(0, 200));
      }
    }
  });

  pythonBridge.stderr.on('data', (data) => {
    console.error('Bridge stderr:', data.toString());
  });

  pythonBridge.on('close', (code) => {
    console.log('Python bridge exited with code', code);
    pythonBridge = null;
    // Reject all pending requests
    for (const [id, { reject, timeout }] of pendingRequests) {
      clearTimeout(timeout);
      reject(new Error('Bridge process exited'));
    }
    pendingRequests.clear();
  });

  console.log('Python bridge started, PID:', pythonBridge.pid);
}

function sendBridgeCommand(action, params = {}, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    if (!pythonBridge || pythonBridge.killed) {
      reject(new Error('Python bridge not running'));
      return;
    }

    const requestId = crypto.randomUUID();
    const command = JSON.stringify({
      action,
      params,
      request_id: requestId
    }) + '\n';

    const timeout = setTimeout(() => {
      pendingRequests.delete(requestId);
      reject(new Error(`Bridge command "${action}" timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    pendingRequests.set(requestId, { resolve, reject, timeout });

    try {
      pythonBridge.stdin.write(command);
    } catch (e) {
      pendingRequests.delete(requestId);
      clearTimeout(timeout);
      reject(new Error('Failed to write to bridge: ' + e.message));
    }
  });
}

// ============ DOWNLOAD QUEUE ============
let downloadQueue = [];    // QueueItem[]
let activeDownloads = 0;
let maxConcurrent = 3;
let downloadHistory = [];  // completed items

function processQueue() {
  while (activeDownloads < maxConcurrent && downloadQueue.length > 0) {
    const nextIdx = downloadQueue.findIndex(item => item.status === 'queued');
    if (nextIdx === -1) break;

    const item = downloadQueue[nextIdx];
    item.status = 'downloading';
    activeDownloads++;

    notifyRenderer('queue-update', { queue: downloadQueue, history: downloadHistory });

    // Start download via bridge
    sendBridgeCommand('download', {
      url: item.tidalUrl,
      quality: item.quality || 'MAX',
      item_id: item.id
    }, 600000) // 10 min timeout for downloads
      .then(result => {
        item.status = 'completed';
        item.completedAt = Date.now();
        if (result.data) {
          item.filePath = result.data.file_path;
          item.fileSize = result.data.file_size;
        }
        downloadHistory.unshift(item);
        downloadQueue = downloadQueue.filter(q => q.id !== item.id);
        activeDownloads--;
        notifyRenderer('queue-update', { queue: downloadQueue, history: downloadHistory });
        notifyRenderer('download-complete', item);

        // Auto Navidrome scan
        const autoScan = true; // TODO: read from settings
        if (autoScan) triggerNavidromeScan();

        processQueue(); // process next
      })
      .catch(err => {
        item.status = 'error';
        item.error = err.message;
        activeDownloads--;
        notifyRenderer('queue-update', { queue: downloadQueue, history: downloadHistory });
        processQueue();
      });
  }
}

function notifyRenderer(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data);
  }
}

// ============ NAVIDROME ============
async function triggerNavidromeScan() {
  // Read settings from renderer via saved config or use defaults
  const url = 'http://localhost:4533';
  const user = 'phantom';
  const pass = 'phantom';

  const salt = crypto.randomBytes(6).toString('hex');
  // MD5 hash
  const md5 = crypto.createHash('md5').update(pass + salt).digest('hex');

  try {
    const fetch = (await import('node-fetch')).default;
    await fetch(`${url}/rest/startScan?u=${user}&t=${md5}&s=${salt}&v=1.16.1&c=Charon&f=json`);
    notifyRenderer('navidrome-scan-result', { success: true });
  } catch (e) {
    console.error('Navidrome scan failed:', e);
    notifyRenderer('navidrome-scan-result', { success: false, error: e.message });
  }
}

// ============ IPC HANDLERS ============
// Window controls
ipcMain.on('window-minimize', () => mainWindow?.minimize());
ipcMain.on('window-maximize', () => {
  if (mainWindow?.isMaximized()) mainWindow.unmaximize();
  else mainWindow?.maximize();
});
ipcMain.on('window-close', () => mainWindow?.close());

// Python bridge commands
ipcMain.handle('bridge-command', async (event, action, params) => {
  try {
    return await sendBridgeCommand(action, params);
  } catch (e) {
    return { status: 'error', error: e.message };
  }
});

// Queue management
ipcMain.handle('queue-add', (event, item) => {
  item.id = item.id || crypto.randomUUID();
  item.status = 'queued';
  item.addedAt = Date.now();
  downloadQueue.push(item);
  notifyRenderer('queue-update', { queue: downloadQueue, history: downloadHistory });
  processQueue();
  return { success: true, id: item.id };
});

ipcMain.handle('queue-remove', (event, itemId) => {
  downloadQueue = downloadQueue.filter(q => q.id !== itemId);
  notifyRenderer('queue-update', { queue: downloadQueue, history: downloadHistory });
  return { success: true };
});

ipcMain.handle('queue-get', () => {
  return { queue: downloadQueue, history: downloadHistory };
});

ipcMain.handle('queue-clear-completed', () => {
  downloadHistory = [];
  notifyRenderer('queue-update', { queue: downloadQueue, history: downloadHistory });
  return { success: true };
});

// Navidrome scan
ipcMain.handle('navidrome-scan', async () => {
  await triggerNavidromeScan();
  return { success: true };
});

// Open folder
ipcMain.handle('open-folder', (event, folderPath) => {
  shell.showItemInFolder(folderPath);
});

ipcMain.handle('open-url', (event, url) => {
  shell.openExternal(url);
});

// Settings persistence
const settingsPath = path.join(app.getPath('userData'), 'charon-settings.json');

ipcMain.handle('settings-get', () => {
  try {
    if (fs.existsSync(settingsPath)) {
      return JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    }
  } catch (e) {}
  return {};
});

ipcMain.handle('settings-set', (event, settings) => {
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  return { success: true };
});

// Check if Python + tiddl are available
ipcMain.handle('check-dependencies', async () => {
  const result = { python: false, tiddl: false, ffmpeg: false, tidalapi: false };

  try {
    const pythonCheck = spawn('python', ['--version']);
    await new Promise((resolve) => pythonCheck.on('close', (code) => {
      result.python = code === 0;
      resolve();
    }));
  } catch (e) {}

  try {
    const tiddlCheck = spawn('tiddl', ['--version']);
    await new Promise((resolve) => tiddlCheck.on('close', (code) => {
      result.tiddl = code === 0;
      resolve();
    }));
  } catch (e) {}

  try {
    const ffmpegCheck = spawn('ffmpeg', ['-version']);
    await new Promise((resolve) => ffmpegCheck.on('close', (code) => {
      result.ffmpeg = code === 0;
      resolve();
    }));
  } catch (e) {}

  return result;
});

// ============ APP LIFECYCLE ============
app.whenReady().then(() => {
  createWindow();
  createTray();
  startPythonBridge();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  // Don't quit on window close (tray keeps running)
});

app.on('before-quit', () => {
  app.isQuitting = true;
  // Kill Python bridge
  if (pythonBridge && !pythonBridge.killed) {
    pythonBridge.kill();
  }
});

// F12 DevTools toggle
app.on('browser-window-created', (_, win) => {
  win.webContents.on('before-input-event', (event, input) => {
    if (input.key === 'F12') {
      win.webContents.toggleDevTools();
      event.preventDefault();
    }
  });
});
