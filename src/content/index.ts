import { PageAgent } from "page-agent";

console.log("[Page Agent] Content script loaded");

let agentActive = false;
let agentInstance: PageAgent | null = null;

// Custom fetch that intercepts OpenAI-compatible API calls and routes to local model
function createLocalFetch(): typeof fetch {
  return async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;

    // Intercept chat completions requests
    if (url.includes("/chat/completions")) {
      const body = JSON.parse((init?.body as string) || "{}");

      return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(
          {
            type: "CHAT_COMPLETION",
            payload: body,
            requestId: Date.now().toString(),
          },
          (response) => {
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
              return;
            }
            if (response?.success) {
              resolve(
                new Response(JSON.stringify(response.data), {
                  status: 200,
                  headers: { "Content-Type": "application/json" },
                }),
              );
            } else {
              reject(new Error(response?.error || "LLM request failed"));
            }
          },
        );
      });
    }

    // Pass through all other requests
    return fetch(input, init);
  };
}

const SHORTER_SYSTEM_PROMPT = `You are an AI browser automation agent. Achieve the <user_request> directly in the FEWEST steps.
<input>
1. <agent_history>: Your past steps and their results.
2. <agent_state>: Current <user_request>.
3. <browser_state>: URL and Interactive Elements ([index]<type>text</type>).
</input>
<rules>
- NEVER linger. If the goal is met or impossible, execute 'done' automatically.
- Check the <browser_state> and match with <user_request>.
- Only interact with available numeric [index] elements.
- Use 'ask_user' if you need info not on screen.
- You must perform EXACTLY ONE action per turn. "action" must be an OBJECT, not an array.
- OUTPUT RAW JSON ONLY. NO CONVERSATIONAL TEXT.
</rules>
<output>
You MUST ALWAYS respond with this EXACT JSON format. Example:
{
  "evaluation_previous_goal": "Success.",
  "memory": "Searched for meta title.",
  "next_goal": "Returning the result to the user.",
  "action": {
    "done": {
      "text": "The Meta Title of the page is: ...",
      "success": true
    }
  }
}
</output>`;

let domCache: any = null;
let cacheValid = false;
let domObserver: MutationObserver | null = null;

async function activateAgent() {
  if (agentActive && agentInstance) {
    return;
  }

  try {
    agentInstance = new PageAgent({
      model: "LFM2-350M-ONNX",
      baseURL: "http://local-llm-proxy",
      apiKey: "local",
      language: "en-US",
      customFetch: createLocalFetch(),
      maxSteps: 15,
      maxRetries: 1,
      customSystemPrompt: SHORTER_SYSTEM_PROMPT,
      experimentalScriptExecutionTool: true,
    });

    if (!domObserver) {
      domObserver = new MutationObserver(() => { cacheValid = false; });
      domObserver.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
    }

    const originalGetBrowserState = agentInstance.pageController.getBrowserState.bind(agentInstance.pageController);
    agentInstance.pageController.getBrowserState = async () => {
      // Invalidate cache if URL changed silently (for SPAs)
      if (domCache && domCache.url !== window.location.href) {
        cacheValid = false;
      }

      if (cacheValid && domCache) {
        console.log("[Page Agent] Using cached browser HTML state");
        return domCache;
      }
      
      console.log("[Page Agent] Iterating and re-parsing HTML state");
      const state = await originalGetBrowserState();
      domCache = state;
      cacheValid = true;
      return state;
    };

    agentActive = true;
    agentInstance.panel.show();
  } catch (err) {
    console.error("[Page Agent] Failed to activate:", err);
  }
}

// Listen for activation message
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "ACTIVATE_AGENT") {
    activateAgent()
      .then(() => sendResponse({ success: true }))
      .catch((err: Error) =>
        sendResponse({ success: false, error: err.message }),
      );
    return true;
  }
});
