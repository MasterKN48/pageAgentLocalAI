import {
  AutoTokenizer,
  AutoModelForCausalLM,
  TextStreamer,
} from '@huggingface/transformers';

import type { ModelStatus, OpenAIChatRequest, OpenAITool, ToolCall } from '../types';

const MODEL_ID = 'HuggingFaceTB/SmolLM2-135M-Instruct';

let tokenizer: any = null;
let model: any = null;
let isLoading = false;

function sendStatus(status: ModelStatus) {
  chrome.runtime.sendMessage({ type: 'MODEL_STATUS_UPDATE', payload: status });
}

async function loadModel() {
  if (model || isLoading) return;
  isLoading = true;

  sendStatus({ loaded: false, loading: true, progress: 0, error: null, message: 'Loading tokenizer...' });

  try {
    tokenizer = await AutoTokenizer.from_pretrained(MODEL_ID, {
      progress_callback: (p: any) => {
        if (p.status === 'progress') {
          sendStatus({
            loaded: false,
            loading: true,
            progress: Math.round((p.progress || 0) * 0.1),
            error: null,
            message: `Loading tokenizer: ${Math.round(p.progress || 0)}%`,
          });
        }
      },
    });

    sendStatus({ loaded: false, loading: true, progress: 10, error: null, message: 'Loading model (~100MB Q4)...' });

    model = await AutoModelForCausalLM.from_pretrained(MODEL_ID, {
      dtype: 'q4',
      device: 'webgpu',
      progress_callback: (p: any) => {
        if (p.status === 'progress') {
          const prog = 10 + Math.round((p.progress || 0) * 0.9);
          sendStatus({
            loaded: false,
            loading: true,
            progress: prog,
            error: null,
            message: `Loading model: ${Math.round(p.progress || 0)}%`,
          });
        }
      },
    });

    isLoading = false;
    sendStatus({ loaded: true, loading: false, progress: 100, error: null, message: 'Model ready!' });
  } catch (err: any) {
    isLoading = false;
    sendStatus({ loaded: false, loading: false, progress: 0, error: err.message, message: `Error: ${err.message}` });
  }
}

function buildToolPrompt(tools: OpenAITool[] | undefined): string {
  if (!tools || tools.length === 0) return '';

  const toolDescs = tools
    .map((t) => {
      const fn = t.function;
      return `- ${fn.name}: ${fn.description}\n  Parameters: ${JSON.stringify(fn.parameters)}`;
    })
    .join('\n');

  return `\n\nYou have access to the following tools:\n${toolDescs}\n\nWhen you need to use a tool, respond with EXACTLY this JSON format and nothing else:\n\`\`\`json\n{"tool_call": {"name": "TOOL_NAME", "arguments": {ARGS_OBJECT}}}\n\`\`\`\n\nWhen you want to provide a final text response (not a tool call), just respond with plain text.\nIMPORTANT: You MUST use a tool call in every response unless you are providing a final answer. Always respond with a tool call JSON block when you need to perform an action.`;
}

function parseToolCalls(text: string): { content: string | null; toolCalls: ToolCall[] | null } {
  // Try to extract JSON tool call from the response
  const jsonPatterns = [
    /```json\s*\n?\s*(\{[\s\S]*?"tool_call"[\s\S]*?\})\s*\n?\s*```/,
    /(\{[\s\S]*?"tool_call"[\s\S]*?"arguments"[\s\S]*?\})\s*$/,
    /(\{"tool_call"\s*:\s*\{[\s\S]*?\}\s*\})/,
  ];

  for (const pattern of jsonPatterns) {
    const match = text.match(pattern);
    if (match) {
      try {
        const parsed = JSON.parse(match[1]);
        if (parsed.tool_call && parsed.tool_call.name) {
          return {
            content: null,
            toolCalls: [
              {
                id: `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                type: 'function' as const,
                function: {
                  name: parsed.tool_call.name,
                  arguments:
                    typeof parsed.tool_call.arguments === 'string'
                      ? parsed.tool_call.arguments
                      : JSON.stringify(parsed.tool_call.arguments),
                },
              },
            ],
          };
        }
      } catch (_e) {
        // JSON parse failed, continue trying other patterns
      }
    }
  }

  // No tool call found, return as plain text
  return { content: text.trim(), toolCalls: null };
}

async function handleChatCompletion(request: OpenAIChatRequest): Promise<any> {
  if (!model || !tokenizer) {
    throw new Error('Model not loaded');
  }

  const { messages, tools, temperature = 0.7, max_tokens = 1024 } = request;

  // Build messages with tool instructions injected into system prompt
  const toolPrompt = buildToolPrompt(tools);

  const processedMessages = messages.map((msg, i) => {
    if (msg.role === 'system' && i === 0) {
      return { ...msg, content: (msg.content || '') + toolPrompt };
    }
    // Convert tool role messages to user messages with context
    if (msg.role === 'tool') {
      return { role: 'user' as const, content: `[Tool Result for ${msg.tool_call_id || 'unknown'}]: ${msg.content}` };
    }
    // Convert assistant messages with tool_calls to show what was called
    if (msg.role === 'assistant' && msg.tool_calls) {
      const callDesc = msg.tool_calls
        .map((tc) => `Called tool: ${tc.function.name}(${tc.function.arguments})`)
        .join('\n');
      return { role: 'assistant' as const, content: callDesc };
    }
    return msg;
  });

  // If no system message exists, prepend one with tool instructions
  if (toolPrompt && !processedMessages.find((m) => m.role === 'system')) {
    processedMessages.unshift({ role: 'system' as const, content: toolPrompt.trim() });
  }

  // Apply chat template using tokenizer (SmolLM2 is text-only, no processor needed)
  const chatMessages = processedMessages.map((m) => ({
    role: m.role === 'tool' ? 'user' : m.role,
    content: typeof m.content === 'string' ? m.content : (m.content || ''),
  }));

  const text = tokenizer.apply_chat_template(chatMessages, {
    add_generation_prompt: true,
    tokenize: false,
  });

  // Tokenize
  const inputs = tokenizer(text, {
    return_tensors: 'pt',
    padding: true,
  });

  let generatedText = '';

  const outputs = await model.generate({
    ...inputs,
    max_new_tokens: max_tokens || 1024,
    do_sample: temperature > 0,
    temperature: temperature > 0 ? Math.max(temperature, 0.1) : undefined,
    top_p: 0.9,
    repetition_penalty: 1.2,
    streamer: new TextStreamer(tokenizer, {
      skip_prompt: true,
      skip_special_tokens: true,
      callback_function: (token: string) => {
        generatedText += token;
      },
    }),
  });

  // Parse for tool calls
  const parsed = parseToolCalls(generatedText);

  // Format as OpenAI-compatible response
  const response: any = {
    id: `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'smollm2-135m-instruct-local',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: parsed.content,
        },
        finish_reason: parsed.toolCalls ? 'tool_calls' : 'stop',
      },
    ],
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    },
  };

  if (parsed.toolCalls) {
    response.choices[0].message.tool_calls = parsed.toolCalls;
    response.choices[0].message.content = null;
  }

  return response;
}

// Listen for messages from service worker
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'LOAD_MODEL') {
    loadModel()
      .then(() => sendResponse({ success: true }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.type === 'CHAT_COMPLETION') {
    handleChatCompletion(message.payload)
      .then((result) => sendResponse({ success: true, data: result }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.type === 'GET_MODEL_STATUS') {
    sendResponse({
      loaded: !!model,
      loading: isLoading,
      progress: 0,
      error: null,
      message: model ? 'Model ready!' : isLoading ? 'Loading...' : 'Not loaded',
    });
    return true;
  }
});
