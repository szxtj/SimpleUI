export type MessageRole = 'system' | 'user' | 'assistant';

export interface TurnMetrics {
  ttftMs: number;              // Time-to-first-token in ms (Prefill)
  decodeDurationMs: number;    // Generation duration in ms (Decode)
  tokensPerSecond: number;     // tok/s
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens?: number;
  contextUsed: number;         // Cumulative tokens used in session
  maxContext: number;          // Max context (e.g. 16384 or 32768)
  contextRemaining: number;    // Remaining tokens
  contextPercent: number;      // 0 - 100
}

export interface ChatMessage {
  id: string;
  role: MessageRole;
  content: string;
  images?: string[];            // Base64 Data URLs (data:image/jpeg;base64,... or png)
  reasoningContent?: string;    // Streamed reasoning process
  isThinking?: boolean;         // Currently thinking
  thinkingDuration?: number;    // Time spent thinking in seconds
  metrics?: TurnMetrics;
  timestamp: number;
  error?: string;
}

export interface ChatSession {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
  contextUsed: number;
}

export interface AppSettings {
  apiPort: number;              // Local server port, default 1235 (Ollama: 11434, vLLM: 8000, llama.cpp: 8080)
  apiBaseUrl?: string;          // Optional custom base URL if needed
  modelId: string;              // e.g. "gemma-4-26b-a4b-it"
  maxContext: number;           // e.g. 32768 or 16384
  enableThinking: boolean;      // Thinking switch (🧠)
  reasoningEffort: 'none' | 'low' | 'medium' | 'high' | 'default';
  temperature: number;          // 0.0 - 2.0 (default 0.2)
  topP: number;                 // 0.01 - 1.0 (default 0.95)
  topK: number;                 // 1 - 256 (default 64)
  repetitionPenalty: number;    // > 0 (default 1.0)
  maxTokens: number;            // 128 - 32768 (default 4096)
  seed?: number;                // UInt64 seed
  stopStrings: string[];        // Stop sequence array
  systemPrompt: string;         // System instructions
}

export interface ServerHealthInfo {
  status: string;
  vision: 'ready' | 'missing' | 'unsupported';
  modelId?: string;
  online: boolean;
}
