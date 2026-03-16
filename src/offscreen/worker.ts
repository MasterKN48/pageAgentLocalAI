import {
  AutoTokenizer,
  AutoModelForCausalLM,
  TextStreamer,
  env,
} from "@huggingface/transformers";

// Use local copies of WASM and JS backends to comply with Content Security Policy
if (env.backends?.onnx?.wasm) {
  env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL("wasm/");
}

import type {
  ModelStatus,
  OpenAIChatRequest,
  OpenAITool,
  ToolCall,
} from "../types";

const MODEL_ID = "onnx-community/functiongemma-270m-it-ONNX";

let tokenizer: any = null;
let model: any = null;
let isLoading = false;
let requestCounter = 0;

// ─── Logging Helpers ───────────────────────────────────────────────────────
const LOG_PREFIX = "[LLM Worker]";

function log(...args: any[]) {
  console.log(LOG_PREFIX, ...args);
}

function logGroup(label: string) {
  console.group(`${LOG_PREFIX} ${label}`);
}

function logGroupEnd() {
  console.groupEnd();
}

function sendStatus(status: ModelStatus) {
  chrome.runtime.sendMessage({ type: "MODEL_STATUS_UPDATE", payload: status });
}

// ─── Model Loading ─────────────────────────────────────────────────────────

async function loadModel() {
  if (model || isLoading) return;
  isLoading = true;

  sendStatus({
    loaded: false,
    loading: true,
    progress: 0,
    error: null,
    message: "Loading tokenizer...",
  });

  try {
    tokenizer = await AutoTokenizer.from_pretrained(MODEL_ID, {
      progress_callback: (p: any) => {
        if (p.status === "progress") {
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

    log("Tokenizer loaded. Detecting WebGPU fp16 support...");

    // ── Choose dtype + device ──
    // q4f16 causes "createBuffer size out of range" on some GPUs.
    // fp16 is safest for WebGPU; fall back to wasm + q4 if no WebGPU/fp16.
    let dtype: any = "q4";
    let device: any = "wasm";

    try {
      const adapter = await (navigator as any).gpu?.requestAdapter();
      if (adapter) {
        const hasFp16 = adapter.features.has("shader-f16");
        log(`WebGPU adapter found. shader-f16: ${hasFp16}`);
        if (hasFp16) {
          dtype = "fp16";
          device = "webgpu";
        } else {
          // No fp16 shader support — use q4 on WASM
          dtype = "q4";
          device = "wasm";
          log("No fp16 shader support, falling back to wasm + q4");
        }
      } else {
        dtype = "q4";
        device = "wasm";
        log("No WebGPU adapter, falling back to wasm + q4");
      }
    } catch (e) {
      dtype = "q4";
      device = "wasm";
      log("WebGPU detection failed, falling back to wasm + q4:", e);
    }

    const sizeLabel = dtype === "fp16" ? "~544MB fp16" : "~764MB Q4";
    sendStatus({
      loaded: false,
      loading: true,
      progress: 10,
      error: null,
      message: `Loading model (${sizeLabel}, ${device})...`,
    });

    log(`Loading model with dtype=${dtype}, device=${device}`);

    model = await AutoModelForCausalLM.from_pretrained(MODEL_ID, {
      dtype,
      device,
      progress_callback: (p: any) => {
        if (p.status === "progress") {
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
    log(`Model loaded successfully (${dtype} on ${device})`);
    sendStatus({
      loaded: true,
      loading: false,
      progress: 100,
      error: null,
      message: `Model ready! (${dtype} on ${device})`,
    });
  } catch (err: any) {
    isLoading = false;
    log("Model load error:", err);
    sendStatus({
      loaded: false,
      loading: false,
      progress: 0,
      error: err.message,
      message: `Error: ${err.message}`,
    });
  }
}

// ─── Tool Call Parsing ─────────────────────────────────────────────────────

/**
 * Parse tool calls from FunctionGemma output.
 *
 * FunctionGemma outputs:
 *   <start_function_call>call:func_name{key:<escape>value<escape>}<end_function_call>
 *
 * We keep special tokens visible (skip_special_tokens: false) to parse them.
 * JSON fallbacks are included for robustness.
 */
function parseToolCalls(
  rawText: string,
  tools: OpenAITool[] | undefined,
): { content: string | null; toolCalls: ToolCall[] | null; strategy: string } {
  const text = rawText.trim();

  // ── Strategy 1: FunctionGemma special-token format ──
  const fgMatch = text.match(
    /<start_function_call>\s*call:(\w+)\{([\s\S]*?)\}\s*<end_function_call>/,
  );
  if (fgMatch) {
    const name = fgMatch[1];
    const rawParams = fgMatch[2];
    const args = parseFGParams(rawParams);
    return {
      content: null,
      toolCalls: [makeToolCall(name, args)],
      strategy: "FG-special-tokens",
    };
  }

  // ── Strategy 2: FunctionGemma without special tokens ──
  const fgPlainMatch = text.match(/call:(\w+)\{([\s\S]*?)\}/);
  if (fgPlainMatch) {
    const name = fgPlainMatch[1];
    const rawParams = fgPlainMatch[2];
    const args = parseFGParams(rawParams);
    return {
      content: null,
      toolCalls: [makeToolCall(name, args)],
      strategy: "FG-plain",
    };
  }

  // ── Strategy 3: Direct JSON {"name": ..., "arguments": ...} ──
  try {
    const parsed = JSON.parse(text);
    if (parsed.name && parsed.arguments !== undefined) {
      return {
        content: null,
        toolCalls: [makeToolCall(parsed.name, parsed.arguments)],
        strategy: "JSON-direct",
      };
    }
    if (parsed.tool_call?.name) {
      return {
        content: null,
        toolCalls: [
          makeToolCall(parsed.tool_call.name, parsed.tool_call.arguments),
        ],
        strategy: "JSON-tool_call",
      };
    }
  } catch (_) {}

  // ── Strategy 4: JSON inside code block ──
  const codeBlockMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (codeBlockMatch) {
    try {
      const parsed = JSON.parse(codeBlockMatch[1]);
      if (parsed.name) {
        return {
          content: null,
          toolCalls: [makeToolCall(parsed.name, parsed.arguments)],
          strategy: "JSON-codeblock",
        };
      }
      if (parsed.tool_call?.name) {
        return {
          content: null,
          toolCalls: [
            makeToolCall(parsed.tool_call.name, parsed.tool_call.arguments),
          ],
          strategy: "JSON-codeblock-tool_call",
        };
      }
    } catch (_) {}
  }

  // ── Strategy 5: JSON with "name" + "arguments" anywhere ──
  const jsonMatch = text.match(
    /\{[^{}]*"name"\s*:\s*"[^"]+?"[^{}]*"arguments"\s*:\s*\{[^}]*\}[^{}]*\}/,
  );
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      if (parsed.name) {
        return {
          content: null,
          toolCalls: [makeToolCall(parsed.name, parsed.arguments)],
          strategy: "JSON-embedded",
        };
      }
    } catch (_) {}
  }

  // ── Strategy 6: Any JSON with "name" ──
  const anyJsonMatch = text.match(/\{[\s\S]*?"name"\s*:\s*"([^"]+)"[\s\S]*?\}/);
  if (anyJsonMatch) {
    try {
      const parsed = JSON.parse(anyJsonMatch[0]);
      if (parsed.name) {
        return {
          content: null,
          toolCalls: [makeToolCall(parsed.name, parsed.arguments || {})],
          strategy: "JSON-any-name",
        };
      }
    } catch (_) {}
  }

  // ── Strategy 7: Tool name in plain text ──
  if (tools && tools.length > 0) {
    for (const t of tools) {
      if (text.toLowerCase().includes(t.function.name.toLowerCase())) {
        return {
          content: null,
          toolCalls: [makeToolCall(t.function.name, {})],
          strategy: "text-match",
        };
      }
    }
  }

  return { content: text, toolCalls: null, strategy: "none" };
}

/** Parse FunctionGemma's key:<escape>value<escape> parameter format */
function parseFGParams(rawParams: string): Record<string, any> {
  const args: Record<string, any> = {};

  // Try <escape> delimited params
  const escapeRegex = /(\w+):<escape>([\s\S]*?)<escape>/g;
  let m;
  let found = false;
  while ((m = escapeRegex.exec(rawParams)) !== null) {
    found = true;
    const val = m[2].trim();
    try {
      args[m[1]] = JSON.parse(val);
    } catch {
      args[m[1]] = val;
    }
  }

  // Fallback: simple key:value
  if (!found) {
    const simpleRegex = /(\w+)\s*:\s*(?:"([^"]*?)"|'([^']*?)'|([^,}]+))/g;
    while ((m = simpleRegex.exec(rawParams)) !== null) {
      const val = (m[2] ?? m[3] ?? m[4] ?? "").trim();
      try {
        args[m[1]] = JSON.parse(val);
      } catch {
        args[m[1]] = val;
      }
    }
  }

  return args;
}

function makeToolCall(name: string, args: any): ToolCall {
  return {
    id: `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    type: "function" as const,
    function: {
      name,
      arguments: typeof args === "string" ? args : JSON.stringify(args || {}),
    },
  };
}

function buildFallbackToolCall(text: string, tools: OpenAITool[]): ToolCall {
  const agentOutputTool = tools.find((t) => t.function.name === "AgentOutput");

  if (agentOutputTool) {
    return makeToolCall("AgentOutput", {
      action: {
        type: "done",
        text:
          text.trim() ||
          "I was unable to determine the next action. Please try rephrasing your command.",
      },
    });
  }

  if (tools.length > 0) {
    return makeToolCall(tools[0].function.name, {});
  }

  return makeToolCall("done", { text: text.trim() || "Task completed." });
}

// ─── Schema Sanitization ───────────────────────────────────────────────────

/**
 * Sanitize tool schemas so FunctionGemma's Jinja template doesn't crash.
 * The template does `value['type'] | upper` — if `type` is missing, it throws.
 */
function sanitizeSchema(schema: any): any {
  if (!schema || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) return schema.map(sanitizeSchema);

  const result: any = { ...schema };

  // Fix missing type
  if (result.type === undefined || result.type === null) {
    if (result.anyOf || result.oneOf) {
      const variants = result.anyOf || result.oneOf;
      const nonNull = variants.find((v: any) => v.type && v.type !== "null");
      result.type = nonNull?.type || "string";
      if (nonNull?.properties) result.properties = nonNull.properties;
      if (nonNull?.required) result.required = nonNull.required;
      if (nonNull?.items) result.items = nonNull.items;
      delete result.anyOf;
      delete result.oneOf;
    } else if (result.properties) {
      result.type = "object";
    } else {
      result.type = "string";
    }
  }

  // Array type → pick first non-null
  if (Array.isArray(result.type)) {
    result.type = result.type.find((t: string) => t !== "null") || "string";
  }

  // Recurse into properties
  if (result.properties && typeof result.properties === "object") {
    const sanitized: any = {};
    for (const [key, val] of Object.entries(result.properties)) {
      sanitized[key] = sanitizeSchema(val);
    }
    result.properties = sanitized;
  }

  // Recurse into array items
  if (result.items) result.items = sanitizeSchema(result.items);

  // Ensure description exists
  if (result.type && !result.description) result.description = "";

  // Remove unsupported JSON Schema keywords
  delete result.$ref;
  delete result.$defs;
  delete result.definitions;

  return result;
}

function sanitizeTools(tools: OpenAITool[]): OpenAITool[] {
  return tools.map((tool) => ({
    ...tool,
    function: {
      ...tool.function,
      parameters: sanitizeSchema(tool.function.parameters),
    },
  }));
}

// ─── Chat Completion Handler ───────────────────────────────────────────────

async function handleChatCompletion(request: OpenAIChatRequest): Promise<any> {
  if (!model || !tokenizer) {
    throw new Error("Model not loaded");
  }

  const reqId = ++requestCounter;
  const {
    messages,
    tools: rawTools,
    temperature = 0.7,
    max_tokens = 1024,
  } = request;

  // ════════════════════════════════════════════════════════════════
  //  REQUEST LOG
  // ════════════════════════════════════════════════════════════════
  logGroup(`═══ Request #${reqId} ═══`);

  log("📥 INCOMING REQUEST from Page Agent:");
  log("  tool_choice:", request.tool_choice);
  log("  temperature:", temperature);
  log("  max_tokens:", max_tokens);
  log("  messages count:", messages.length);

  // Log each message
  messages.forEach((msg, i) => {
    const preview =
      typeof msg.content === "string"
        ? msg.content.slice(0, 200) + (msg.content.length > 200 ? "..." : "")
        : JSON.stringify(msg.content)?.slice(0, 200);
    log(
      `  msg[${i}] role=${msg.role}${msg.tool_call_id ? ` tool_call_id=${msg.tool_call_id}` : ""}:`,
    );
    log(`    content: ${preview}`);
    if (msg.tool_calls) {
      msg.tool_calls.forEach((tc, j) => {
        log(
          `    tool_calls[${j}]: ${tc.function.name}(${tc.function.arguments.slice(0, 150)})`,
        );
      });
    }
  });

  // Log raw tools from Page Agent
  if (rawTools) {
    log("  tools count:", rawTools.length);
    rawTools.forEach((t, i) => {
      log(
        `  tool[${i}]: ${t.function.name} — ${t.function.description?.slice(0, 100)}`,
      );
    });
  }

  // Sanitize tools
  const tools = rawTools ? sanitizeTools(rawTools) : undefined;

  if (tools) {
    log("🔧 SANITIZED TOOLS:");
    log(JSON.stringify(tools, null, 2));
  }

  // ── Preprocess messages ──
  const processedMessages = messages.map((msg) => {
    if (msg.role === "system") {
      return { role: "developer" as const, content: msg.content || "" };
    }
    if (msg.role === "tool") {
      return {
        role: "user" as const,
        content: `[Tool Result for ${msg.tool_call_id || "unknown"}]: ${msg.content}`,
      };
    }
    if (msg.role === "assistant" && msg.tool_calls) {
      const callDesc = msg.tool_calls
        .map(
          (tc) => `Called tool: ${tc.function.name}(${tc.function.arguments})`,
        )
        .join("\n");
      return { role: "assistant" as const, content: callDesc };
    }
    return msg;
  });

  if (!processedMessages.find((m) => m.role === "developer")) {
    processedMessages.unshift({
      role: "developer" as const,
      content:
        "You are a model that can do function calling with the following functions",
    });
  }

  const chatMessages = processedMessages.map((m) => ({
    role: m.role === "tool" ? "user" : m.role,
    content: typeof m.content === "string" ? m.content : m.content || "",
  }));

  log("📝 PROCESSED MESSAGES for tokenizer:");
  chatMessages.forEach((m, i) => {
    log(
      `  [${i}] ${m.role}: ${m.content.slice(0, 200)}${m.content.length > 200 ? "..." : ""}`,
    );
  });

  // ── apply_chat_template ──
  const promptText = tokenizer.apply_chat_template(chatMessages, {
    tools: tools || [],
    add_generation_prompt: true,
    tokenize: false,
  });

  log("📜 FULL PROMPT (first 1000 chars):");
  log(promptText.slice(0, 1000));
  if (promptText.length > 1000) {
    log(`  ... (${promptText.length} total chars)`);
  }

  const inputs = tokenizer(promptText, {
    return_tensors: "pt",
    padding: true,
  });

  log("🔢 Input token count:", inputs.input_ids?.dims?.[1] || "unknown");

  // ── Generate ──
  let generatedText = "";
  const genStart = performance.now();

  log("⏳ Generating...");

  await model.generate({
    ...inputs,
    max_new_tokens: max_tokens || 1024,
    do_sample: temperature > 0,
    temperature: temperature > 0 ? Math.max(temperature, 0.1) : undefined,
    top_p: 0.9,
    repetition_penalty: 1.2,
    streamer: new TextStreamer(tokenizer, {
      skip_prompt: true,
      skip_special_tokens: false,
      callback_function: (token: string) => {
        generatedText += token;
      },
    }),
  });

  const genTime = ((performance.now() - genStart) / 1000).toFixed(2);

  // ════════════════════════════════════════════════════════════════
  //  MODEL OUTPUT LOG
  // ════════════════════════════════════════════════════════════════
  log(`🤖 RAW MODEL OUTPUT (${genTime}s):`);
  log(generatedText);

  // ── Parse tool calls ──
  const parsed = parseToolCalls(generatedText, tools);

  log(`🔍 PARSE RESULT: strategy=${parsed.strategy}`);
  if (parsed.toolCalls) {
    parsed.toolCalls.forEach((tc, i) => {
      log(`  toolCall[${i}]: ${tc.function.name}(${tc.function.arguments})`);
    });
  } else {
    log(`  content: ${parsed.content?.slice(0, 300)}`);
  }

  // Fallback if tool_choice requires a tool call
  let usedFallback = false;
  if (!parsed.toolCalls && request.tool_choice) {
    log("⚠️ No tool call found but tool_choice is set — using FALLBACK");
    const fallback = buildFallbackToolCall(generatedText, tools || []);
    parsed.toolCalls = [fallback];
    parsed.content = null;
    usedFallback = true;
  }

  // ── Build response ──
  const response: any = {
    id: `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: "functiongemma-270m-it-local",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: parsed.content,
          ...(parsed.toolCalls ? { tool_calls: parsed.toolCalls } : {}),
        },
        finish_reason: parsed.toolCalls ? "tool_calls" : "stop",
      },
    ],
    usage: {
      prompt_tokens: inputs.input_ids?.dims?.[1] || 0,
      completion_tokens: generatedText.length,
      total_tokens: (inputs.input_ids?.dims?.[1] || 0) + generatedText.length,
    },
  };

  // ════════════════════════════════════════════════════════════════
  //  RESPONSE LOG
  // ════════════════════════════════════════════════════════════════
  log("📤 RESPONSE to Page Agent:");
  log("  finish_reason:", response.choices[0].finish_reason);
  log("  strategy:", parsed.strategy + (usedFallback ? " → FALLBACK" : ""));
  if (response.choices[0].message.tool_calls) {
    response.choices[0].message.tool_calls.forEach((tc: any, i: number) => {
      log(`  tool_calls[${i}]: ${tc.function.name}`);
      log(`    arguments: ${tc.function.arguments}`);
    });
  } else {
    log(`  content: ${response.choices[0].message.content?.slice(0, 300)}`);
  }
  log(
    `  tokens: prompt=${response.usage.prompt_tokens}, completion=${response.usage.completion_tokens}`,
  );
  log(`  generation time: ${genTime}s`);

  logGroupEnd(); // End request group

  return response;
}

// ─── Message Listener ──────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "LOAD_MODEL") {
    loadModel()
      .then(() => sendResponse({ success: true }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.type === "CHAT_COMPLETION") {
    handleChatCompletion(message.payload)
      .then((result) => {
        log("✅ Sending success response back to service worker");
        sendResponse({ success: true, data: result });
      })
      .catch((err) => {
        log("❌ Error in handleChatCompletion:", err.message, err.stack);
        sendResponse({ success: false, error: err.message });
      });
    return true;
  }

  if (message.type === "GET_MODEL_STATUS") {
    sendResponse({
      loaded: !!model,
      loading: isLoading,
      progress: 0,
      error: null,
      message: model ? "Model ready!" : isLoading ? "Loading..." : "Not loaded",
    });
    return true;
  }
});
