const loadBtn = document.getElementById('load-btn') as HTMLButtonElement;
const injectBtn = document.getElementById('inject-btn') as HTMLButtonElement;
const statusDot = document.getElementById('status-dot') as HTMLDivElement;
const statusText = document.getElementById('status-text') as HTMLSpanElement;
const progressContainer = document.getElementById('progress-container') as HTMLDivElement;
const progressFill = document.getElementById('progress-fill') as HTMLDivElement;
const progressText = document.getElementById('progress-text') as HTMLSpanElement;

let modelReady = false;

function updateStatus(status: {
  loading?: boolean;
  loaded?: boolean;
  error?: string | null;
  message?: string;
  progress?: number;
}) {
  if (status.loading) {
    statusDot.className = 'status-indicator loading';
    statusText.textContent = status.message || 'Loading...';
    progressContainer.style.display = 'block';
    progressFill.style.width = `${status.progress || 0}%`;
    progressText.textContent = `${status.progress || 0}%`;
    loadBtn.disabled = true;
    loadBtn.textContent = 'Loading...';
  } else if (status.loaded) {
    statusDot.className = 'status-indicator ready';
    statusText.textContent = 'Model ready';
    progressContainer.style.display = 'none';
    loadBtn.disabled = true;
    loadBtn.textContent = 'Model Loaded';
    injectBtn.disabled = false;
    modelReady = true;
  } else if (status.error) {
    statusDot.className = 'status-indicator error';
    statusText.textContent = status.error;
    progressContainer.style.display = 'none';
    loadBtn.disabled = false;
    loadBtn.textContent = 'Retry';
  }
}

// Listen for model status updates
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'MODEL_STATUS_UPDATE') {
    updateStatus(message.payload);
  }
});

loadBtn.addEventListener('click', () => {
  loadBtn.disabled = true;
  loadBtn.textContent = 'Initializing...';
  chrome.runtime.sendMessage({ type: 'LOAD_MODEL' });
});

injectBtn.addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) {
    chrome.runtime.sendMessage({ type: 'INJECT_AGENT', tabId: tab.id });
    injectBtn.textContent = 'Agent Activated';
    setTimeout(() => {
      injectBtn.textContent = 'Activate on Current Page';
    }, 2000);
  }
});

// Check initial status
chrome.runtime.sendMessage({ type: 'GET_MODEL_STATUS' }, (response) => {
  if (response) updateStatus(response);
});
