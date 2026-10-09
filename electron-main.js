const { app, BrowserWindow, Menu, systemPreferences } = require('electron');
const path = require('path');

let mainWindow;
let serverProcess;

// Point this to your DEPLOYED backend URL (Render/Railway/VPS).
// If you want the desktop app to run the backend itself locally, leave as localhost
// and the embedded server below will start automatically.
const REMOTE_SERVER_URL = process.env.PULSE_SERVER_URL || 'http://localhost:3000';
const RUN_EMBEDDED_SERVER = !process.env.PULSE_SERVER_URL; // if no remote URL set, run locally

function startEmbeddedServer() {
  // Starts app.js in-process so the desktop app is fully self-contained
  process.env.PORT = process.env.PORT || '3000';
  require('./app.js');
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    title: 'Pulse Messenger',
    backgroundColor: '#0a0b0f',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      // REQUIRED: allows mic/camera access prompts to work properly in Electron
      permissions: ['microphone', 'camera', 'notifications'],
    },
  });

  Menu.setApplicationMenu(null);

  const url = RUN_EMBEDDED_SERVER ? 'http://localhost:3000' : REMOTE_SERVER_URL;
  mainWindow.loadURL(url);

  mainWindow.on('closed', () => { mainWindow = null; });
}

// ── CRITICAL: grant mic/camera permission requests from the page ──
app.whenReady().then(() => {
  const { session } = require('electron');

  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    const allowed = ['media', 'microphone', 'camera', 'notifications', 'audioCapture', 'videoCapture'];
    if (allowed.includes(permission)) {
      callback(true); // auto-grant mic/camera/notification requests
    } else {
      callback(false);
    }
  });

  // macOS: also request OS-level mic/camera permission
  if (process.platform === 'darwin') {
    systemPreferences.askForMediaAccess('microphone');
    systemPreferences.askForMediaAccess('camera');
  }

  if (RUN_EMBEDDED_SERVER) {
    startEmbeddedServer();
    setTimeout(createWindow, 800); // give server a moment to bind the port
  } else {
    createWindow();
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
