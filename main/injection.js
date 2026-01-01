const robot = require('robotjs');
const { clipboard } = require('electron');
const { exec } = require('child_process');

/**
 * Restores focus to a window by its title (Windows only)
 */
function restoreFocus(windowTitle) {
  if (process.platform !== 'win32' || !windowTitle) return;
  // Use PowerShell to activate the window by title
  // We use a regex match to be more flexible with window titles
  const script = `
        $wshell = New-Object -ComObject WScript.Shell;
        $wshell.AppActivate("${windowTitle.replace(/"/g, '`"')}");
    `;
  exec(`powershell -Command "${script.replace(/\n/g, ' ')}"`, (err) => {
    if (err) console.error('Focus restoration failed:', err);
  });
}

/**
 * Injects text into the target application.
 * 
 * @param {string} text - The text to inject
 * @param {object} targetApp - The active-win metadata of the target app
 * @returns {Promise<void>}
 */
async function injectText(text, targetApp = null) {
  if (!text || typeof text !== 'string') {
    return;
  }

  // Focus preservation: Ensure we are back in the target app
  if (targetApp && targetApp.title) {
    console.log('Restoring focus to:', targetApp.title);
    restoreFocus(targetApp.title);
    await sleep(150); // Wait for focus to shift
  }

  const previousClipboard = clipboard.readText();

  try {
    await sleep(50);
    clipboard.writeText(text);
    await sleep(50);

    if (process.platform === 'darwin') {
      robot.keyTap('v', 'command');
    } else {
      robot.keyTap('v', 'control');
    }

    console.log('Text injected successfully');
    await sleep(100);
  } catch (error) {
    console.error('Failed to inject text:', error);
    throw error;
  } finally {
    clipboard.writeText(previousClipboard);
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = {
  injectText
};
