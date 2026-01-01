const { ipcRenderer } = require('electron');

// UI Elements
const toast = document.getElementById('toast');
const statusText = document.getElementById('statusText');
const transcriptEl = document.getElementById('transcript');

// UI state updates with toast animations
ipcRenderer.on('state-update', (event, state) => {
  document.body.className = `state-${state.toLowerCase()}`;

  if (state === 'IDLE') {
    // Don't hide immediately if showing transcript
    if (!transcriptEl.classList.contains('show')) {
      toast.classList.remove('visible');
      toast.classList.add('hiding');
    }
    statusText.textContent = 'Done';
  } else {
    toast.classList.remove('hiding');
    toast.classList.add('visible');

    // Hide transcript when starting new recording
    transcriptEl.classList.remove('show', 'success');
    transcriptEl.textContent = '';

    switch (state) {
      case 'ARMED':
        statusText.textContent = 'Ready...';
        break;
      case 'RECORDING':
        statusText.textContent = 'Listening';
        break;
      case 'FINALIZING':
        statusText.textContent = 'Processing';
        break;
    }
  }
});

// Hide toast when transcript is processed (don't show the text)
ipcRenderer.on('show-transcript', (event, text) => {
  // Just hide the toast immediately - no need to display transcript
  toast.classList.remove('visible');
  toast.classList.add('hiding');
});
