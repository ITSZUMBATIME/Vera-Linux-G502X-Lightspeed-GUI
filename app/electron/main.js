const { app, BrowserWindow } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');

const BACKEND_DIR = path.join(__dirname, '..', 'backend');
const PORT = process.env.PORT || '5000';
const URL = `http://127.0.0.1:${PORT}`;

let backendProcess = null;
let mainWindow = null;

function pickPython() {
  const venvPython = path.join(BACKEND_DIR, '.venv', 'bin', 'python');
  if (fs.existsSync(venvPython)) return venvPython;
  return process.platform === 'win32' ? 'python' : 'python3';
}

function startBackend() {
  const python = pickPython();
  backendProcess = spawn(python, ['app.py'], {
    cwd: BACKEND_DIR,
    env: { ...process.env, PORT },
    stdio: 'inherit',
  });
  backendProcess.on('exit', (code) => {
    console.log(`Backend exited with code ${code}`);
    backendProcess = null;
  });
}

function waitForBackend(retries = 40) {
  return new Promise((resolve, reject) => {
    const attempt = (remaining) => {
      http
        .get(`${URL}/api/status`, (res) => {
          res.resume();
          resolve();
        })
        .on('error', () => {
          if (remaining <= 0) return reject(new Error('Backend did not start in time'));
          setTimeout(() => attempt(remaining - 1), 250);
        });
    };
    attempt(retries);
  });
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    backgroundColor: '#08090b',
    icon: path.join(__dirname, '..', 'frontend', 'assets', 'vera-icon-512.png'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  try {
    await waitForBackend();
  } catch (e) {
    console.error(e);
  }

  mainWindow.loadURL(URL);
}

app.whenReady().then(() => {
  startBackend();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (backendProcess) backendProcess.kill();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (backendProcess) backendProcess.kill();
});
