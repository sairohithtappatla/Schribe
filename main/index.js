const { app, BrowserWindow, Tray, Menu, ipcMain, screen, dialog, shell } = require('electron');
const { autoUpdater } = require('electron-updater');
const log = require('electron-log');
const fs = require('fs');
const path = require('path');
const { spawn, execSync, exec } = require('child_process');
const { uIOhook } = require('uiohook-napi');
const { StateMachine, States } = require('./state');
const { injectText } = require('./injection');
const { cleanupText } = require('./processor');
const { logEvent, checkAccessibility, openAccessibilitySettings } = require('./utils');
const speechBridge = require('./speechBridge');
const AutoLaunch = require('auto-launch');

/**
 * Gets the active window title using PowerShell (Zero native dependencies)
 */
function getActiveWindowTitle() {
  return new Promise((resolve) => {
    const script = `
            try {
                Add-Type -TypeDefinition '
                using System;
                using System.Runtime.InteropServices;
                public class Win32 {
                    [DllImport("user32.dll")]
                    public static extern IntPtr GetForegroundWindow();
                    [DllImport("user32.dll", CharSet = CharSet.Auto)]
                    public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder lpString, int nMaxCount);
                }';
                $hWnd = [Win32]::GetForegroundWindow();
                $title = New-Object System.Text.StringBuilder 256;
                [Win32]::GetWindowText($hWnd, $title, 256) | Out-Null;
                $title.ToString();
            } catch { "" }
        `;
    exec(`powershell -Command "${script.replace(/\n/g, ' ')}"`, (err, stdout) => {
      if (err) resolve(null);
      resolve(stdout.trim());
    });
  });
}

// Configure logging for updater
autoUpdater.logger = log;
autoUpdater.autoDownload = false; // We want manual consent
log.info('App starting...');

// Global error handlers
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
});

// Stay running even if windows are hidden/closed (Tray app)
app.on('window-all-closed', (e) => {
  e.preventDefault();
});

let dictatorAutoLauncher;
let mainWindow;
let settingsWindow;
let chromeProcess = null;
let tray;
let injected = false;
let dictationEnabled = true;
let speechServiceReady = false;
let processingTimeout = null;
let lastActiveApp = null;
let hasShownReadyTooltip = false;
let isRelaunchingChrome = false;

const stateMachine = new StateMachine();

function setupAutoLaunch() {
  dictatorAutoLauncher = new AutoLaunch({
    name: 'Schirbe',
    path: app.getPath('exe'),
  });

  dictatorAutoLauncher.enable().catch(err => {
    console.error('Failed to enable auto-launch:', err);
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 250,
    height: 60,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    show: false,
    focusable: false,
    icon: path.join(__dirname, '../assets/short.png'),
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  mainWindow.loadFile('renderer/index.html');
  mainWindow.setIgnoreMouseEvents(true);
}

function createSettingsWindow() {
  settingsWindow = new BrowserWindow({
    width: 250,
    height: 290,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    resizable: false,
    icon: path.join(__dirname, '../assets/short.png'),
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  settingsWindow.loadFile('renderer/settings.html');

  // Hide when clicking away
  settingsWindow.on('blur', () => {
    settingsWindow.hide();
  });
}

function showSettingsNearTray() {
  if (!settingsWindow) return;

  const trayBounds = tray.getBounds();
  const screenBounds = screen.getDisplayMatching(trayBounds).workArea;

  const x = Math.min(
    Math.max(trayBounds.x - 125 + (trayBounds.width / 2), screenBounds.x),
    screenBounds.x + screenBounds.width - 250
  );

  const y = trayBounds.y > screenBounds.height / 2
    ? trayBounds.y - 290 - 10 // Above tray
    : trayBounds.y + trayBounds.height + 10; // Below tray

  settingsWindow.setPosition(Math.round(x), Math.round(y));
  settingsWindow.webContents.send('sync-state', { enabled: dictationEnabled });
  settingsWindow.show();
  settingsWindow.focus();
}

function findChromePath() {
  const paths = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe')
  ];
  for (const p of paths) {
    if (fs.existsSync(p)) return p;
  }
  try {
    const pathFromWhere = execSync('where chrome.exe').toString().split('\r\n')[0].trim();
    if (pathFromWhere) return pathFromWhere;
  } catch (e) { }
  return 'chrome.exe';
}

function launchChromeWorker() {
  if (chromeProcess) {
    try {
      chromeProcess.kill();
    } catch (e) { }
  }

  const url = speechBridge.getSpeechServiceUrl();
  const chromeExecutable = findChromePath();
  const userDataDir = path.join(process.env.LOCALAPPDATA || '', 'SchirbeChrome');

  const args = [
    `--app=${url}`,
    `--user-data-dir=${userDataDir}`,
    '--use-fake-ui-for-media-stream',
    '--disable-infobars',
    '--disable-session-crashed-bubble',
    '--autoplay-policy=no-user-gesture-required',
    '--window-position=-10000,-10000',
    '--window-size=10,10',
    '--no-first-run',
    '--no-default-browser-check',
    '--silent-launch',
    '--background'
  ];

  console.log(`🚀 Launching Chrome worker for Schirbe: ${chromeExecutable}`);
  chromeProcess = spawn(chromeExecutable, args, { stdio: 'ignore' });

  chromeProcess.on('error', (err) => {
    console.error('❌ Failed to launch Chrome worker:', err);
  });

  chromeProcess.on('exit', (code) => {
    console.log(`[WORKER] Chrome process exited with code ${code}`);
    chromeProcess = null;
    speechServiceReady = false;

    // Auto-relaunch with delay to prevent flapping
    if (!isRelaunchingChrome) {
      isRelaunchingChrome = true;
      console.log('🔄 Scheduling Chrome relaunch in 2s...');
      setTimeout(() => {
        isRelaunchingChrome = false;
        launchChromeWorker();
      }, 2000);
    }
  });
}

function updateTrayIcon() {
  if (!tray) return;
  const iconPath = path.join(__dirname, '../assets/short.png');
  if (fs.existsSync(iconPath)) {
    tray.setImage(iconPath);
  }
  tray.setToolTip(`Schirbe (${dictationEnabled ? 'Enabled' : 'Disabled'})`);
}

function setupTray() {
  const iconPath = path.join(__dirname, '../assets/short.png');
  tray = new Tray(fs.existsSync(iconPath) ? iconPath : path.join(__dirname, '../assets/short.png'));

  tray.on('click', () => {
    if (settingsWindow && settingsWindow.isVisible()) {
      settingsWindow.hide();
    } else {
      showSettingsNearTray();
    }
  });

  updateTrayIcon();
}

function setupKeyListeners() {
  uIOhook.on('keydown', (event) => {
    stateMachine.handleKeyDown(event.keycode);
  });

  uIOhook.on('keyup', (event) => {
    stateMachine.handleKeyUp(event.keycode);
  });

  uIOhook.start();
}

function setupSpeechBridge() {
  speechBridge.onTranscript(async (text) => {
    // Only process transcripts if we are waiting for them
    if (stateMachine.currentState !== States.FINALIZING) {
      console.log('Ignored transcript (not in FINALIZING state)');
      return;
    }

    if (injected) {
      console.log('Already processing, ignoring duplicate');
      return;
    }

    if (processingTimeout) {
      clearTimeout(processingTimeout);
      processingTimeout = null;
    }

    injected = true;

    if (!text || !text.trim()) {
      logEvent('Empty transcript received');
      if (mainWindow) {
        mainWindow.webContents.send('show-transcript', '(No speech detected)');
      }
      setTimeout(() => {
        stateMachine.reset();
        injected = false;
      }, 800);
      return;
    }

    logEvent('FINAL_RESULT received', { length: text.length });
    const clean = cleanupText(text);

    if (clean) {
      try {
        await injectText(clean, lastActiveApp);
      } catch (error) {
        console.error('Text injection failed:', error);
      }
    }

    // Return to IDLE immediately after injection
    setTimeout(() => {
      stateMachine.reset();
      injected = false;
    }, 50);
  });

  speechBridge.onReady(() => {
    speechServiceReady = true;
    logEvent('Speech service connected');

    // Show one-time ready notification
    if (!hasShownReadyTooltip && tray) {
      tray.displayBalloon({
        title: 'Schirbe',
        content: "Rohith'Speech engine is ready !",
        iconType: 'info'
      });
      hasShownReadyTooltip = true;
    }
  });

  speechBridge.onError((error) => {
    logEvent('Speech service error', { error });

    // ✅ Show error in UI
    if (mainWindow) {
      mainWindow.webContents.send('show-transcript', `Error: ${error}`);
    }

    setTimeout(() => stateMachine.reset(), 2000);
  });

  // Debug monitor
  setInterval(() => {
    console.log('Status:', {
      state: stateMachine.currentState,
      wsConnected: speechBridge.isConnected(),
      workerAlive: !!chromeProcess,
      injected: injected
    });
  }, 10000);

  // Settings IPC handlers
  ipcMain.on('toggle-dictation', (event, enabled) => {
    dictationEnabled = enabled;
    updateTrayIcon();
    logEvent('Dictation toggled', { enabled });
  });

  ipcMain.on('restart-engine', () => {
    launchChromeWorker();
    logEvent('Engine restart requested via UI');
  });

  ipcMain.on('open-browser', () => {
    shell.openExternal(speechBridge.getSpeechServiceUrl());
  });

  ipcMain.on('quit-app', () => {
    app.quit();
  });

  // Auto-updater handlers
  autoUpdater.on('update-available', (info) => {
    log.info('Update available:', info.version);
    if (settingsWindow) {
      settingsWindow.webContents.send('update-available', info.version);
    }
    if (tray) {
      tray.displayBalloon({
        title: 'Update Available',
        content: `Schirbe v${info.version} is ready for download.`,
        iconType: 'info'
      });
    }
  });

  autoUpdater.on('update-downloaded', (info) => {
    log.info('Update downloaded');
    if (settingsWindow) {
      settingsWindow.webContents.send('update-downloaded');
    }
  });

  ipcMain.on('download-update', () => {
    autoUpdater.downloadUpdate();
    log.info('User requested update download');
  });

  ipcMain.on('install-update', () => {
    autoUpdater.quitAndInstall();
  });

  // Check for updates every hour
  setInterval(() => {
    autoUpdater.checkForUpdatesAndNotify();
  }, 60 * 60 * 1000);

  // Initial check
  setTimeout(() => {
    autoUpdater.checkForUpdatesAndNotify();
  }, 5000);
}

app.whenReady().then(async () => {
  if (process.platform === 'darwin' && !checkAccessibility()) {
    const response = await dialog.showMessageBox({
      type: 'warning',
      title: 'Accessibility Permission Required',
      message: 'Enable Accessibility to allow typing into other apps.',
      detail: 'Schirbe needs Accessibility permission to inject text into applications.',
      buttons: ['Open Settings', 'Quit']
    });

    if (response.response === 0) {
      openAccessibilitySettings();
    }
    app.quit();
    return;
  }

  await speechBridge.startServers();
  setupSpeechBridge();

  createWindow();
  createSettingsWindow();
  launchChromeWorker();
  setupTray();
  setupKeyListeners();
  setupAutoLaunch();

  console.log('✅ Schirbe ready');

  stateMachine.on('stateChanged', async (state) => {
    logEvent('State Changed', { state });
    if (mainWindow) {
      mainWindow.webContents.send('state-update', state);

      if (state === States.IDLE) {
        mainWindow.hide(); // Hide instantly when idle
      } else if (state === States.RECORDING || state === States.FINALIZING) {
        const primaryDisplay = screen.getPrimaryDisplay();
        const { width, height } = primaryDisplay.workAreaSize;
        const windowBounds = mainWindow.getBounds();
        const x = Math.round((width - windowBounds.width) / 2);
        const y = height - windowBounds.height - 20; // 20px from taskbar
        mainWindow.setPosition(x, y);
        mainWindow.showInactive(); // Show without stealing focus
      } else if (state === States.ARMED) {
        // Capture active application but don't show UI yet
        try {
          const title = await getActiveWindowTitle();
          lastActiveApp = { title };
          console.log('Target app captured:', title || 'Unknown');
        } catch (e) {
          console.error('Failed to capture active app:', e);
        }
      }
    }
  });

  stateMachine.on('startRecording', () => {
    logEvent('Dictation started');

    if (!chromeProcess || !speechBridge.isConnected()) {
      logEvent('Speech engine not ready');
      if (mainWindow) {
        mainWindow.webContents.send('show-transcript', 'Initializing speech engine...');
      }

      // If chrome is missing completely, launch it
      if (!chromeProcess) launchChromeWorker();

      // Reset state machine to prevent recording
      setTimeout(() => stateMachine.reset(), 1000);
      return;
    }

    speechBridge.startRecording();
  });

  stateMachine.on('stopRecording', () => {
    logEvent('Ctrl released - waiting for transcript');

    if (speechBridge.isConnected()) {
      speechBridge.stopRecording();

      if (processingTimeout) clearTimeout(processingTimeout);
      processingTimeout = setTimeout(() => {
        if (stateMachine.currentState === States.FINALIZING) {
          logEvent('Processing timed out');

          if (mainWindow) {
            mainWindow.webContents.send('show-transcript', '(Timeout - try again)');
          }

          setTimeout(() => {
            stateMachine.reset();
            injected = false;
          }, 800);
        }
      }, 8000);
    } else {
      logEvent('Stop ignored - not connected');
      stateMachine.reset();
    }
  });
});


app.on('will-quit', () => {
  if (chromeProcess) {
    try { chromeProcess.kill(); } catch (e) { }
  }
  speechBridge.stopServers();
  uIOhook.stop();
});
