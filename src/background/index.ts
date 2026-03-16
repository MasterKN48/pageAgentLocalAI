let offscreenCreated = false;

async function ensureOffscreen(): Promise<void> {
  if (offscreenCreated) return;

  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
  });

  if (existingContexts.length > 0) {
    offscreenCreated = true;
    return;
  }

  await chrome.offscreen.createDocument({
    url: 'offscreen/offscreen.html',
    reasons: [chrome.offscreen.Reason.WORKERS],
    justification: 'Running SmolLM2-135M LLM via Transformers.js with WebGPU',
  });

  offscreenCreated = true;
}

// Open side panel on extension icon click
chrome.action.onClicked.addListener((tab) => {
  if (tab.id) {
    chrome.sidePanel.open({ tabId: tab.id });
  }
});

// Allow side panel to open on all URLs
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

// Handle messages
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'LOAD_MODEL') {
    ensureOffscreen().then(() => {
      chrome.runtime.sendMessage(message, sendResponse);
    }).catch((err) => {
      sendResponse({ success: false, error: err.message });
    });
    return true;
  }

  if (message.type === 'CHAT_COMPLETION') {
    ensureOffscreen().then(() => {
      chrome.runtime.sendMessage(message, sendResponse);
    }).catch((err) => {
      sendResponse({ success: false, error: err.message });
    });
    return true;
  }

  if (message.type === 'GET_MODEL_STATUS') {
    ensureOffscreen().then(() => {
      chrome.runtime.sendMessage(message, sendResponse);
    }).catch((err) => {
      sendResponse({
        loaded: false,
        loading: false,
        progress: 0,
        error: err.message,
        message: err.message,
      });
    });
    return true;
  }

  if (message.type === 'INJECT_AGENT') {
    const tabId = message.tabId || sender.tab?.id;
    if (tabId) {
      chrome.tabs.sendMessage(tabId, { type: 'ACTIVATE_AGENT' }, sendResponse);
    } else {
      sendResponse({ success: false, error: 'No tab ID' });
    }
    return true;
  }

  // Forward model status updates to all listeners (side panel)
  if (message.type === 'MODEL_STATUS_UPDATE') {
    // Broadcast to all extension pages — ignore errors from no listeners
    chrome.runtime.sendMessage(message).catch(() => {});
  }
});
