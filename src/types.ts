export interface Message {
  type: string;
  payload?: any;
  requestId?: string;
}

// Messages from content script / sidepanel to background
export type ExtMessage =
  | { type: 'CHAT_COMPLETION'; payload: OpenAIChatRequest; requestId: string }
  | { type: 'LOAD_MODEL'; requestId: string }
  | { type: 'GET_MODEL_STATUS' }
  | { type: 'INJECT_AGENT'; tabId?: number }
  | { type: 'MODEL_STATUS_UPDATE'; payload: ModelStatus };

export interface OpenAIChatRequest {
  model: string;
  messages: Array<{
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string | null;
    tool_calls?: ToolCall[];
    tool_call_id?: string;
  }>;
  tools?: OpenAITool[];
  tool_choice?: string | { type: string; function: { name: string } };
  temperature?: number;
  max_tokens?: number;
  parallel_tool_calls?: boolean;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface OpenAITool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, any>;
  };
}

export interface ModelStatus {
  loaded: boolean;
  loading: boolean;
  progress: number;
  error: string | null;
  message: string;
}
