import { PageAgent } from 'page-agent';

let agentActive = false;
let agentInstance: PageAgent | null = null;

// Custom fetch that intercepts OpenAI-compatible API calls and routes to local model
function createLocalFetch(): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

    // Intercept chat completions requests
    if (url.includes('/chat/completions')) {
      const body = JSON.parse((init?.body as string) || '{}');

      return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(
          { type: 'CHAT_COMPLETION', payload: body, requestId: Date.now().toString() },
          (response) => {
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
              return;
            }
            if (response?.success) {
              resolve(
                new Response(JSON.stringify(response.data), {
                  status: 200,
                  headers: { 'Content-Type': 'application/json' },
                }),
              );
            } else {
              reject(new Error(response?.error || 'LLM request failed'));
            }
          },
        );
      });
    }

    // Pass through all other requests
    return fetch(input, init);
  };
}

async function activateAgent() {
  if (agentActive && agentInstance) {
    return;
  }

  try {
    agentInstance = new PageAgent({
      model: 'smollm2-135m-instruct-local',
      baseURL: 'http://local-llm-proxy', // Doesn't matter, customFetch intercepts everything
      apiKey: 'local',
      language: 'en-US',
      customFetch: createLocalFetch(),
      maxSteps: 15,
    });

    agentActive = true;
  } catch (err) {
    console.error('[Page Agent] Failed to activate:', err);
  }
}

// Listen for activation message
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'ACTIVATE_AGENT') {
    activateAgent()
      .then(() => sendResponse({ success: true }))
      .catch((err: Error) => sendResponse({ success: false, error: err.message }));
    return true;
  }
});
