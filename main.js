/*
  ╔══════════════════════════════════════════════════════════════════╗
  ║  CHARON — Catalog Harvester & Automated Ripper for Organized    ║
  ║           Navidrome                                             ║
  ╠══════════════════════════════════════════════════════════════════╣
  ║  Main Process — Electron shell, Python bridge, IPC, queue       ║
  ║                                                                  ║
  ║  The ferryman that carries music from Tidal to your AETHER.     ║
  ║                                                                  ║
  ║  Mirrors AETHER's Electron patterns:                             ║
  ║  - Frameless OLED-black window                                   ║
  ║  - CSP override for API calls                                    ║
  ║  - webSecurity disabled for localhost fetch                      ║
  ║  - Background throttling OFF                                     ║
  ║  - System tray with minimize-to-tray                             ║
  ║  - F12 DevTools toggle                                           ║
  ╚══════════════════════════════════════════════════════════════════╝
*/

const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, shell, screen, session } = require('electron');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');

let mainWindow = null;
let tray = null;
let pythonBridge = null;
let pendingRequests = new Map(); // request_id → { resolve, reject, timeout }
let globalSettings = {};         // in-memory settings cache

// ============ SETTINGS PERSISTENCE ============
const settingsPath = path.join(app.getPath('userData'), 'charon-settings.json');
const queuePath = path.join(app.getPath('userData'), 'charon-queue.json');

function loadSettings() {
  try {
    if (fs.existsSync(settingsPath)) {
      globalSettings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    }
  } catch (e) {
    console.error('Failed to load settings:', e);
  }
}

function loadQueue() {
  try {
    if (fs.existsSync(queuePath)) {
      const data = JSON.parse(fs.readFileSync(queuePath, 'utf-8'));
      downloadQueue = data.queue || [];
      downloadHistory = data.history || [];
      // Reset any stale 'downloading' items to 'queued'
      downloadQueue.forEach(item => {
        if (item.status === 'downloading') item.status = 'queued';
      });
    }
  } catch (e) {
    console.error('Failed to load queue:', e);
  }
}

function saveQueue() {
  try {
    fs.writeFileSync(queuePath, JSON.stringify({
      queue: downloadQueue,
      history: downloadHistory.slice(0, 200) // Cap history at 200
    }, null, 2));
  } catch (e) {
    console.error('Failed to save queue:', e);
  }
}

// ============ WINDOW ============
function createWindow() {
  const { width: screenW, height: screenH } = screen.getPrimaryDisplay().workAreaSize;

  mainWindow = new BrowserWindow({
    width: Math.min(1400, screenW),
    height: Math.min(900, screenH),
    minWidth: 900,
    minHeight: 600,
    frame: false,
    titleBarStyle: 'hidden',
    backgroundColor: '#000000',
    show: false,
    icon: path.join(__dirname, 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false,           // Allow fetch to localhost Navidrome
      webgl: true,
      backgroundThrottling: false,  // Keep downloads smooth when minimized
    }
  });

  // Remove CSP headers that block API calls (matches AETHER)
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': ["default-src * 'unsafe-inline' 'unsafe-eval' data: blob:"]
      }
    });
  });

  mainWindow.loadFile('ripper.html');
  mainWindow.once('ready-to-show', () => mainWindow.show());

  // Window state events → renderer
  mainWindow.on('maximize', () => {
    mainWindow.webContents.send('window-state', 'maximized');
  });
  mainWindow.on('unmaximize', () => {
    mainWindow.webContents.send('window-state', 'normal');
  });

  mainWindow.on('close', (e) => {
    // Minimize to tray instead of closing
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ============ SYSTEM TRAY ============
function createTray() {
  try {
    const iconPath = path.join(__dirname, 'icon.ico');
    if (fs.existsSync(iconPath)) {
      tray = new Tray(iconPath);
    } else {
      // Programmatic tray icon (cyan square — distinguishes from AETHER's purple)
      const size = 16;
      const canvas = Buffer.alloc(size * size * 4);
      for (let i = 0; i < size * size; i++) {
        const offset = i * 4;
        const x = i % size, y = Math.floor(i / size);
        if (x >= 2 && x <= 13 && y >= 2 && y <= 13) {
          canvas[offset] = 6; canvas[offset + 1] = 182; canvas[offset + 2] = 212; canvas[offset + 3] = 200;
        }
      }
      tray = new Tray(nativeImage.createFromBuffer(canvas, { width: size, height: size }));
    }
    const contextMenu = Menu.buildFromTemplate([
      { label: 'Show CHARON', click: () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } } },
      { type: 'separator' },
      { label: 'Quit', click: () => {
        if (activeDownloads > 0) {
          const { dialog } = require('electron');
          dialog.showMessageBox({
            type: 'question',
            buttons: ['Keep Running', 'Quit Anyway'],
            defaultId: 0,
            title: 'Downloads Active',
            message: `${activeDownloads} download(s) still running. Quit anyway?`
          }).then(result => {
            if (result.response === 1) { app.isQuitting = true; app.quit(); }
          });
        } else {
          app.isQuitting = true; app.quit();
        }
      }}
    ]);
    tray.setToolTip('CHARON — Tidal Ripper');
    tray.setContextMenu(contextMenu);
    tray.on('double-click', () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } });
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

  const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';

  pythonBridge = spawn(pythonCmd, [bridgePath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PYTHONUNBUFFERED: '1',
      PYTHONIOENCODING: 'utf-8',  // Fix Windows Unicode issues with tiddl
    }
  });

  let stdoutBuffer = '';

  pythonBridge.stdout.on('data', (data) => {
    stdoutBuffer += data.toString('utf-8');
    const lines = stdoutBuffer.split('\n');
    stdoutBuffer = lines.pop();

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
      reject(new Error('Python bridge not running. Check that Python and tidalapi are installed.'));
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
let downloadQueue = [];
let activeDownloads = 0;
let maxConcurrent = 3;
let downloadHistory = [];

function processQueue() {
  // Read concurrency from settings
  maxConcurrent = parseInt(globalSettings.concurrent) || 3;

  while (activeDownloads < maxConcurrent && downloadQueue.length > 0) {
    const nextIdx = downloadQueue.findIndex(item => item.status === 'queued');
    if (nextIdx === -1) break;

    const item = downloadQueue[nextIdx];
    item.status = 'downloading';
    activeDownloads++;

    notifyRenderer('queue-update', { queue: downloadQueue, history: downloadHistory });
    saveQueue();

    // Pass download dir from settings
    const downloadDir = globalSettings.downloadDir || path.join(os.homedir(), 'Music', 'CHARON');

    sendBridgeCommand('download', {
      url: item.tidalUrl,
      quality: item.quality || globalSettings.quality || 'master',
      item_id: item.id,
      download_dir: downloadDir,
      threads: parseInt(globalSettings.downloadThreads) || 4
    }, 600000) // 10 min timeout
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
        saveQueue();

        // Auto Navidrome scan (read from settings)
        if (globalSettings.autoScan !== false) triggerNavidromeScan();

        processQueue();
      })
      .catch(err => {
        item.status = 'error';
        item.error = err.message;
        activeDownloads--;
        notifyRenderer('queue-update', { queue: downloadQueue, history: downloadHistory });
        saveQueue();
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
  const url = globalSettings.navidromeUrl || 'http://localhost:4533';
  const user = globalSettings.navidromeUser || '';
  const pass = globalSettings.navidromePass || '';

  if (!user || !pass) {
    console.warn('Navidrome credentials not configured');
    return;
  }

  const salt = crypto.randomBytes(6).toString('hex');
  const md5 = crypto.createHash('md5').update(pass + salt).digest('hex');

  try {
    // Use native fetch (Node 18+ / Electron 33+)
    await fetch(`${url}/rest/startScan?u=${encodeURIComponent(user)}&t=${md5}&s=${salt}&v=1.16.1&c=Charon&f=json`);
    notifyRenderer('navidrome-scan-result', { success: true });
  } catch (e) {
    console.error('Navidrome scan failed:', e);
    notifyRenderer('navidrome-scan-result', { success: false, error: e.message });
  }
}

// ============ NAVIDROME SERVER MANAGEMENT ============
let navidromeProcess = null;

function findNavidromeBinary() {
  const candidates = [
    globalSettings.navidromePath,
    path.join(os.homedir(), 'Navidrome', 'navidrome.exe'),
    path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Navidrome', 'navidrome.exe'),
    path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Navidrome', 'navidrome.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Navidrome', 'navidrome.exe'),
    path.join(app.getPath('userData'), 'navidrome', 'navidrome.exe'),
  ].filter(Boolean);

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

async function checkNavidromeHealth() {
  const url = globalSettings.navidromeUrl || 'http://localhost:4533';
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const response = await fetch(`${url}/api/health`, { signal: controller.signal });
    clearTimeout(timer);
    if (response.ok) {
      const data = await response.json();
      return { running: true, version: data.version || 'unknown' };
    }
  } catch (e) {}
  return { running: false };
}

function parseNavidromeConfig(content) {
  const config = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^(\w+)\s*=\s*'([^']*)'$/) || trimmed.match(/^(\w+)\s*=\s*"([^"]*)"$/) || trimmed.match(/^(\w+)\s*=\s*(\S+)$/);
    if (match) config[match[1]] = match[2];
  }
  return config;
}

function buildNavidromeConfig(config) {
  return `# Navidrome Configuration — Managed by CHARON
MusicFolder = '${(config.MusicFolder || '').replace(/\\/g, '/')}'
DataFolder = '${(config.DataFolder || '').replace(/\\/g, '/')}'
Address = '${config.Address || '0.0.0.0'}'
Port = ${config.Port || 4533}
ScanSchedule = '${config.ScanSchedule || '@every 1m'}'
TranscodingCacheSize = '${config.TranscodingCacheSize || '150MiB'}'
ImageCacheSize = '${config.ImageCacheSize || '100MiB'}'
AutoImportPlaylists = ${config.AutoImportPlaylists || 'false'}
`;
}

// ============ IPC HANDLERS ============
// Window controls
ipcMain.on('window-minimize', () => mainWindow?.minimize());
ipcMain.on('window-maximize', () => {
  if (mainWindow?.isMaximized()) mainWindow.unmaximize();
  else mainWindow?.maximize();
});
ipcMain.on('window-close', () => mainWindow?.close());
ipcMain.handle('window-is-maximized', () => mainWindow ? mainWindow.isMaximized() : false);

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
  saveQueue();
  processQueue();
  return { success: true, id: item.id };
});

ipcMain.handle('queue-remove', (event, itemId) => {
  downloadQueue = downloadQueue.filter(q => q.id !== itemId);
  notifyRenderer('queue-update', { queue: downloadQueue, history: downloadHistory });
  saveQueue();
  return { success: true };
});

ipcMain.handle('queue-get', () => {
  return { queue: downloadQueue, history: downloadHistory };
});

ipcMain.handle('queue-clear-completed', () => {
  downloadHistory = [];
  notifyRenderer('queue-update', { queue: downloadQueue, history: downloadHistory });
  saveQueue();
  return { success: true };
});

// Navidrome scan
ipcMain.handle('navidrome-scan', async () => {
  await triggerNavidromeScan();
  return { success: true };
});

// Open folder / URL — return values to prevent renderer hang
ipcMain.handle('open-folder', (event, folderPath) => {
  try {
    shell.showItemInFolder(folderPath);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('open-url', (event, url) => {
  try {
    shell.openExternal(url);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// Settings
ipcMain.handle('settings-get', () => {
  return globalSettings;
});

ipcMain.handle('settings-set', (event, settings) => {
  globalSettings = settings;
  try {
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  } catch (e) {
    return { success: false, error: e.message };
  }
  return { success: true };
});

// Check if Python + tiddl are available
ipcMain.handle('check-dependencies', async () => {
  const result = { python: false, tiddl: false, ffmpeg: false, tidalapi: false };

  const checkCmd = (cmd, args) => new Promise(resolve => {
    let resolved = false;
    const done = (val) => { if (!resolved) { resolved = true; resolve(val); } };
    try {
      const proc = spawn(cmd, args, {
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
      });
      proc.on('close', (code) => done(code === 0));
      proc.on('error', () => done(false));
      setTimeout(() => { try { proc.kill(); } catch (e) {} done(false); }, 5000);
    } catch (e) { done(false); }
  });

  result.python = await checkCmd('python', ['--version']);
  result.tiddl = await checkCmd('python', ['-c', 'import tiddl; print("ok")']);
  result.ffmpeg = await checkCmd('ffmpeg', ['-version']);
  result.tidalapi = await checkCmd('python', ['-c', 'import tidalapi; print("ok")']);

  return result;
});

// ── Navidrome Server Management ──
ipcMain.handle('navidrome-server-status', async () => {
  const binaryPath = findNavidromeBinary();
  const health = await checkNavidromeHealth();
  let configPath = null;
  let config = null;

  if (binaryPath) {
    const cfgPath = path.join(path.dirname(binaryPath), 'navidrome.toml');
    if (fs.existsSync(cfgPath)) {
      configPath = cfgPath;
      try {
        config = parseNavidromeConfig(fs.readFileSync(cfgPath, 'utf-8'));
      } catch (e) {}
    }
  }

  return {
    installed: !!binaryPath,
    binaryPath: binaryPath || null,
    configPath,
    config,
    running: health.running,
    version: health.version || null,
    managedByCharon: navidromeProcess !== null && !navidromeProcess.killed,
    url: globalSettings.navidromeUrl || 'http://localhost:4533',
  };
});

ipcMain.handle('navidrome-server-start', async () => {
  const binaryPath = findNavidromeBinary();
  if (!binaryPath) return { success: false, error: 'Navidrome binary not found. Install it first.' };

  const health = await checkNavidromeHealth();
  if (health.running) return { success: true, message: 'Already running', version: health.version };

  const configDir = path.dirname(binaryPath);
  const configPath = path.join(configDir, 'navidrome.toml');

  try {
    const args = [];
    if (fs.existsSync(configPath)) {
      args.push('--configfile', configPath);
    }

    navidromeProcess = spawn(binaryPath, args, {
      cwd: configDir,
      detached: true,
      stdio: 'ignore',
    });
    navidromeProcess.unref();

    navidromeProcess.on('close', () => { navidromeProcess = null; });

    // Wait for startup
    await new Promise(r => setTimeout(r, 2500));
    const check = await checkNavidromeHealth();
    return { success: check.running, version: check.version };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('navidrome-server-stop', async () => {
  if (navidromeProcess && !navidromeProcess.killed) {
    try {
      process.kill(navidromeProcess.pid);
      navidromeProcess = null;
      return { success: true };
    } catch (e) {}
  }

  // Fallback: taskkill
  try {
    const { execSync } = require('child_process');
    execSync('taskkill /F /IM navidrome.exe', { stdio: 'ignore' });
    navidromeProcess = null;
    return { success: true };
  } catch (e) {
    return { success: false, error: 'Could not stop Navidrome process' };
  }
});

ipcMain.handle('navidrome-server-restart', async () => {
  // Stop
  if (navidromeProcess && !navidromeProcess.killed) {
    try { process.kill(navidromeProcess.pid); } catch (e) {}
    navidromeProcess = null;
  } else {
    try {
      const { execSync } = require('child_process');
      execSync('taskkill /F /IM navidrome.exe', { stdio: 'ignore' });
    } catch (e) {}
  }
  await new Promise(r => setTimeout(r, 1000));

  // Start
  const binaryPath = findNavidromeBinary();
  if (!binaryPath) return { success: false, error: 'Navidrome binary not found' };

  const configDir = path.dirname(binaryPath);
  const configPath = path.join(configDir, 'navidrome.toml');
  const args = fs.existsSync(configPath) ? ['--configfile', configPath] : [];

  try {
    navidromeProcess = spawn(binaryPath, args, { cwd: configDir, detached: true, stdio: 'ignore' });
    navidromeProcess.unref();
    navidromeProcess.on('close', () => { navidromeProcess = null; });

    await new Promise(r => setTimeout(r, 2500));
    const check = await checkNavidromeHealth();
    return { success: check.running, version: check.version };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('navidrome-server-install', async (event, installPath, musicPath) => {
  try {
    notifyRenderer('navidrome-install-progress', { step: 'fetching', message: 'Fetching latest release info...' });

    const releaseRes = await fetch('https://api.github.com/repos/navidrome/navidrome/releases/latest');
    if (!releaseRes.ok) throw new Error('Failed to fetch release info from GitHub');
    const release = await releaseRes.json();
    const version = release.tag_name || 'unknown';

    const asset = release.assets.find(a =>
      a.name.includes('windows') && a.name.includes('amd64') && a.name.endsWith('.zip')
    );
    if (!asset) throw new Error('No Windows AMD64 build found in latest release');

    installPath = installPath || path.join(os.homedir(), 'Navidrome');
    fs.mkdirSync(installPath, { recursive: true });

    // Download
    notifyRenderer('navidrome-install-progress', { step: 'downloading', message: `Downloading Navidrome ${version} (${(asset.size / 1024 / 1024).toFixed(1)} MB)...` });
    const downloadRes = await fetch(asset.browser_download_url);
    if (!downloadRes.ok) throw new Error('Download failed');
    const buffer = Buffer.from(await downloadRes.arrayBuffer());
    const zipPath = path.join(installPath, 'navidrome.zip');
    fs.writeFileSync(zipPath, buffer);

    // Extract
    notifyRenderer('navidrome-install-progress', { step: 'extracting', message: 'Extracting files...' });
    const { execSync } = require('child_process');
    execSync(`powershell -Command "Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${installPath.replace(/'/g, "''")}' -Force"`, { timeout: 60000 });

    try { fs.unlinkSync(zipPath); } catch (e) {}

    // Create directories
    musicPath = musicPath || path.join(os.homedir(), 'Music', 'CHARON');
    fs.mkdirSync(musicPath, { recursive: true });
    const dataPath = path.join(installPath, 'data');
    fs.mkdirSync(dataPath, { recursive: true });

    // Generate config
    const config = buildNavidromeConfig({
      MusicFolder: musicPath,
      DataFolder: dataPath,
      Port: 4533,
    });
    fs.writeFileSync(path.join(installPath, 'navidrome.toml'), config);

    // Save binary path to settings
    globalSettings.navidromePath = path.join(installPath, 'navidrome.exe');
    if (!globalSettings.navidromeUrl) globalSettings.navidromeUrl = 'http://localhost:4533';
    fs.writeFileSync(settingsPath, JSON.stringify(globalSettings, null, 2));

    notifyRenderer('navidrome-install-progress', { step: 'done', message: `Navidrome ${version} installed successfully!` });

    return { success: true, version, installPath, binaryPath: path.join(installPath, 'navidrome.exe') };
  } catch (e) {
    notifyRenderer('navidrome-install-progress', { step: 'error', message: e.message });
    return { success: false, error: e.message };
  }
});

ipcMain.handle('navidrome-server-config', async (event, action, configPath, newContent) => {
  if (action === 'read') {
    const binaryPath = findNavidromeBinary();
    const cfgPath = configPath || (binaryPath ? path.join(path.dirname(binaryPath), 'navidrome.toml') : null);
    if (!cfgPath || !fs.existsSync(cfgPath)) return { success: false, error: 'Config file not found' };
    try {
      const content = fs.readFileSync(cfgPath, 'utf-8');
      return { success: true, content, config: parseNavidromeConfig(content), path: cfgPath };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }
  if (action === 'write') {
    if (!configPath) return { success: false, error: 'No config path specified' };
    try {
      fs.writeFileSync(configPath, newContent);
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }
  return { success: false, error: 'Unknown action' };
});

ipcMain.handle('navidrome-server-stats', async () => {
  const url = globalSettings.navidromeUrl || 'http://localhost:4533';
  const user = globalSettings.navidromeUser || '';
  const pass = globalSettings.navidromePass || '';

  if (!user || !pass) return { success: false, error: 'Navidrome credentials not configured in Settings' };

  const salt = crypto.randomBytes(6).toString('hex');
  const md5 = crypto.createHash('md5').update(pass + salt).digest('hex');
  const auth = `u=${encodeURIComponent(user)}&t=${md5}&s=${salt}&v=1.16.1&c=Charon&f=json`;

  try {
    const [scanRes, statsRes] = await Promise.all([
      fetch(`${url}/rest/getScanStatus?${auth}`).then(r => r.json()).catch(() => null),
      fetch(`${url}/rest/getArtists?${auth}`).then(r => r.json()).catch(() => null),
    ]);

    const scanStatus = scanRes?.['subsonic-response']?.scanStatus;
    const indexes = statsRes?.['subsonic-response']?.artists?.index || [];
    let artistCount = 0;
    for (const idx of indexes) artistCount += (idx.artist || []).length;

    return {
      success: true,
      scanning: scanStatus?.scanning || false,
      scanCount: scanStatus?.count || 0,
      artistCount,
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// ============ APP LIFECYCLE ============
// Catch crashes
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT:', err);
});

app.whenReady().then(() => {
  loadSettings();
  loadQueue();
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

app.on('before-quit', (e) => {
  // If downloads are active, warn and minimize to tray instead
  if (activeDownloads > 0 && !app.isQuitting) {
    e.preventDefault();
    if (mainWindow) mainWindow.hide();
    return;
  }
  app.isQuitting = true;
  saveQueue();
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
