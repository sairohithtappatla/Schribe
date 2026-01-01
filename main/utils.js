const { systemPreferences, shell } = require('electron');
const log = require('electron-log');
const path = require('path');

// Telemetry/Logging Setup
log.transports.file.resolvePathFn = () => path.join(process.env.APPDATA || (process.platform === 'darwin' ? process.env.HOME + '/Library/Logs' : process.env.HOME), 'voice-dictator', 'logs.log');

function logEvent(event, details = {}) {
  log.info(`[TELEMETRY] ${event}`, details);
}

function checkAccessibility() {
  if (process.platform !== 'darwin') return true;

  const trusted = systemPreferences.isTrustedAccessibilityClient(false);
  if (!trusted) {
    logEvent('Permission Missing', { type: 'Accessibility' });
  }
  return trusted;
}

function openAccessibilitySettings() {
  if (process.platform === 'darwin') {
    shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility');
  }
}

module.exports = {
  logEvent,
  checkAccessibility,
  openAccessibilitySettings
};
