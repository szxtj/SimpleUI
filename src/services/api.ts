import { AppSettings, ChatMessage, ServerHealthInfo, TurnMetrics, WikiCitation, WikiStatusInfo } from '../types/chat';
import { estimateHistoryTokens } from '../utils/token';

export interface RagContextResponse {
  needsWiki: boolean;
  citations: WikiCitation[];
  promptContext: string;
  metadata?: {
    fromCache?: boolean;
    planner?: string;
    latencyMs?: number;
    plan?: any;
    articleCount?: number;
  };
  error?: string;
}

export interface StreamCallbacks {
  onFirstToken?: () => void;
  onThought?: (delta: string) => void;
  onContent?: (delta: string) => void;
  onTokenProgress?: (liveTokens: number) => void;
  onDone?: (metrics: TurnMetrics) => void;
  onError?: (error: Error) => void;
}

export class TurboFieldfareAPI {
  public static getBaseUrl(settings: AppSettings): string {
    if (settings.apiBaseUrl?.trim() && settings.apiBaseUrl.startsWith('http')) {
      return settings.apiBaseUrl.trim().replace(/\/+$/, '');
    }
    return ''; // Relative path, hits local node proxy on same origin
  }

  private static getHeaders(settings: AppSettings, extra?: Record<string, string>): Record<string, string> {
    const port = settings.apiPort || 1235;
    return {
      'Accept': 'application/json',
      'x-target-port': String(port),
      ...(extra || {}),
    };
  }

  static async checkHealth(settings: AppSettings): Promise<ServerHealthInfo> {
    const baseUrl = this.getBaseUrl(settings);
    try {
      // 1. Try /health (TurboFieldfare or compatible health check)
      const res = await fetch(`${baseUrl}/health`, {
        method: 'GET',
        headers: this.getHeaders(settings),
      }).catch(() => null);

      if (res && res.ok) {
        const data = await res.json().catch(() => ({}));
        return {
          status: data.status || 'ok',
          vision: data.vision || 'missing',
          modelId: data.model || undefined,
          online: true,
        };
      }

      // 2. Standard OpenAI health check: /v1/models (compatible with Ollama, vLLM, llama.cpp, LM Studio, etc.)
      const modelsRes = await fetch(`${baseUrl}/v1/models`, {
        method: 'GET',
        headers: this.getHeaders(settings),
      }).catch(() => null);

      if (modelsRes && modelsRes.ok) {
        const data = await modelsRes.json().catch(() => ({}));
        const modelId = Array.isArray(data.data) && data.data[0]?.id ? data.data[0].id : undefined;
        return {
          status: 'ok',
          vision: 'missing',
          modelId,
          online: true,
        };
      }

      return { status: 'offline', vision: 'missing', online: false };
    } catch {
      return { status: 'offline', vision: 'missing', online: false };
    }
  }

  static async fetchModels(settings: AppSettings): Promise<string[]> {
    const baseUrl = this.getBaseUrl(settings);
    try {
      const res = await fetch(`${baseUrl}/v1/models`, {
        method: 'GET',
        headers: this.getHeaders(settings),
      });
      if (!res.ok) return [settings.modelId || 'gemma-4-26b-a4b-it'];
      const data = await res.json();
      if (Array.isArray(data.data) && data.data.length > 0) {
        return data.data.map((m: { id: string }) => m.id);
      }
      return [settings.modelId || 'gemma-4-26b-a4b-it'];
    } catch {
      return [settings.modelId || 'gemma-4-26b-a4b-it'];
    }
  }

  static async streamChat(
    messages: ChatMessage[],
    settings: AppSettings,
    callbacks: StreamCallbacks,
    signal?: AbortSignal
  ): Promise<void> {
    const baseUrl = this.getBaseUrl(settings);
    const endpoint = `${baseUrl}/v1/chat/completions`;

    // 1. Build strictly compliant message array
    const wireMessages: Array<{
      role: 'system' | 'user' | 'assistant';
      content: string | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string; detail?: string } }>;
    }> = [];

    // System prompt must precede conversation if present
    if (settings.systemPrompt?.trim()) {
      wireMessages.push({
        role: 'system',
        content: settings.systemPrompt.trim(),
      });
    }

    for (const msg of messages) {
      if (msg.role === 'user') {
        if (msg.images && msg.images.length > 0) {
          const parts: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string; detail?: string } }> = [];
          if (msg.content) {
            parts.push({ type: 'text', text: msg.content });
          }
          for (const imgUrl of msg.images) {
            parts.push({
              type: 'image_url',
              image_url: { url: imgUrl, detail: 'auto' },
            });
          }
          wireMessages.push({
            role: 'user',
            content: parts,
          });
        } else {
          wireMessages.push({
            role: 'user',
            content: msg.content || '',
          });
        }
      } else if (msg.role === 'assistant') {
        wireMessages.push({
          role: 'assistant',
          content: msg.content || '',
        });
      }
    }

    // 2. Build strictly sanitized payload
    // TurboFieldfareServer's OpenAIModels strictly rejects unrecognized fields!
    const payload: Record<string, unknown> = {
      model: settings.modelId || 'gemma-4-26b-a4b-it',
      messages: wireMessages,
      stream: true,
      stream_options: { include_usage: true },
      temperature: settings.temperature,
      top_p: settings.topP,
      top_k: settings.topK,
      repetition_penalty: settings.repetitionPenalty,
      max_tokens: settings.maxTokens,
    };

    // Thinking controls
    if (settings.enableThinking) {
      payload.chat_template_kwargs = { enable_thinking: true };
      payload.reasoning_effort = settings.reasoningEffort || 'high';
    } else {
      payload.chat_template_kwargs = { enable_thinking: false };
      payload.reasoning_effort = 'none';
    }

    if (settings.seed !== undefined && settings.seed !== null && !isNaN(settings.seed)) {
      payload.seed = settings.seed;
    }

    if (settings.stopStrings && settings.stopStrings.length > 0) {
      payload.stop = settings.stopStrings;
    }

    const initialPromptTokens = estimateHistoryTokens(messages, settings.systemPrompt);
    let lastReportedMilestone = 0;

    const startTime = performance.now();
    let firstTokenTime: number | null = null;
    let generatedTokensCount = 0;
    let finalUsage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; cached_tokens?: number } | null = null;

    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: this.getHeaders(settings, {
          'Content-Type': 'application/json',
          'Accept': 'text/event-stream',
        }),
        body: JSON.stringify(payload),
        signal,
      });
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      callbacks.onError?.(err as Error);
      return;
    }

    if (!response.ok) {
      let errorMsg = `Server error ${response.status} ${response.statusText}`;
      try {
        const errJson = await response.json();
        if (errJson?.error?.message) {
          errorMsg = errJson.error.message;
        }
      } catch {
        // use fallback message
      }
      callbacks.onError?.(new Error(errorMsg));
      return;
    }

    const reader = response.body?.getReader();
    if (!reader) {
      callbacks.onError?.(new Error('ReadableStream not supported by response'));
      return;
    }

    const abortHandler = () => {
      reader.cancel().catch(() => {});
    };
    if (signal) {
      if (signal.aborted) {
        abortHandler();
      } else {
        signal.addEventListener('abort', abortHandler, { once: true });
      }
    }

    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    callbacks.onTokenProgress?.(initialPromptTokens);

    try {
      while (true) {
        if (signal?.aborted) break;
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          // SSE heartbeat ping line from TurboFieldfareServer (e.g. ": ping")
          if (trimmed.startsWith(':')) {
            continue;
          }

          if (trimmed.startsWith('data:')) {
            const dataStr = trimmed.slice(5).trim();
            if (dataStr === '[DONE]') {
              continue;
            }

            try {
              const parsed = JSON.parse(dataStr);

              // Capture usage chunk if present
              if (parsed.usage) {
                finalUsage = parsed.usage;
              }

              const choice = parsed.choices?.[0];
              if (!choice) continue;

              const delta = choice.delta;
              if (!delta) continue;

              // Mark first token time (TTFT) and notify initial prompt load
              if (!firstTokenTime && (delta.content || delta.reasoning_content)) {
                firstTokenTime = performance.now();
                callbacks.onFirstToken?.();
                callbacks.onTokenProgress?.(initialPromptTokens);
              }

              if (delta.reasoning_content) {
                generatedTokensCount++;
                callbacks.onThought?.(delta.reasoning_content);
                if (generatedTokensCount - lastReportedMilestone >= 20) {
                  lastReportedMilestone = generatedTokensCount;
                  const livePrompt = finalUsage?.prompt_tokens ?? initialPromptTokens;
                  callbacks.onTokenProgress?.(livePrompt + generatedTokensCount);
                }
              }

              if (delta.content) {
                generatedTokensCount++;
                callbacks.onContent?.(delta.content);
                if (generatedTokensCount - lastReportedMilestone >= 20) {
                  lastReportedMilestone = generatedTokensCount;
                  const livePrompt = finalUsage?.prompt_tokens ?? initialPromptTokens;
                  callbacks.onTokenProgress?.(livePrompt + generatedTokensCount);
                }
              }
            } catch (jsonErr) {
              console.warn('Failed to parse SSE JSON chunk:', dataStr, jsonErr);
            }
          }
        }
      }
    } catch (streamErr) {
      if ((streamErr as Error).name === 'AbortError' || signal?.aborted) {
        // User stopped generation, finalize with current timings
      } else {
        callbacks.onError?.(streamErr as Error);
        return;
      }
    } finally {
      if (signal) {
        signal.removeEventListener('abort', abortHandler);
      }
      try {
        await reader.cancel();
      } catch {
        // ignore if already closed or aborted
      }
      reader.releaseLock();
    }

    const endTime = performance.now();
    const ttftMs = firstTokenTime ? Math.round(firstTokenTime - startTime) : Math.round(endTime - startTime);
    const decodeDurationMs = firstTokenTime ? Math.max(1, Math.round(endTime - firstTokenTime)) : 1;
    const completionTokens = finalUsage?.completion_tokens ?? generatedTokensCount;
    const tokensPerSecond = Number(((completionTokens / (decodeDurationMs / 1000))).toFixed(1));
    const promptTokens = finalUsage?.prompt_tokens ?? initialPromptTokens;
    const totalTokens = finalUsage?.total_tokens ?? (promptTokens + completionTokens);
    const maxContext = settings.maxContext || 32768;
    const contextRemaining = Math.max(0, maxContext - totalTokens);
    const contextPercent = Math.min(100, Number(((totalTokens / maxContext) * 100).toFixed(1)));

    const metrics: TurnMetrics = {
      ttftMs,
      decodeDurationMs,
      tokensPerSecond,
      promptTokens,
      completionTokens,
      totalTokens,
      cachedTokens: finalUsage?.cached_tokens,
      contextUsed: totalTokens,
      maxContext,
      contextRemaining,
      contextPercent,
    };

    callbacks.onTokenProgress?.(totalTokens);
    callbacks.onDone?.(metrics);
  }
}

export class WikiAPI {
  static async getStatus(): Promise<WikiStatusInfo> {
    try {
      const res = await fetch('/api/wiki/status');
      if (res.ok) {
        return await res.json();
      }
    } catch (e) {
      // ignore
    }
    return {
      connected: false,
      port: 31236,
      zimPath: null,
      contentId: null,
      bookTitle: 'Knowledge Base',
      articleCount: 0,
      mediaCount: 0,
    };
  }

  static async search(query: string): Promise<Array<{ title: string; path: string; url: string }>> {
    try {
      const res = await fetch(`/api/wiki/search?q=${encodeURIComponent(query)}`);
      if (res.ok) {
        const data = await res.json();
        return data.results || [];
      }
    } catch (e) {
      console.error('Wiki search failed:', e);
    }
    return [];
  }

  static async getSummary(
    title: string,
    userQuery?: string
  ): Promise<{ title: string; summary: string; url: string } | null> {
    try {
      let url = `/api/wiki/summary?title=${encodeURIComponent(title)}`;
      if (userQuery) {
        url += `&query=${encodeURIComponent(userQuery)}`;
      }
      const res = await fetch(url);
      if (res.ok) {
        return await res.json();
      }
    } catch (e) {
      console.error('Wiki getSummary failed:', e);
    }
    return null;
  }

  static async updateConfig(zimPath: string): Promise<WikiStatusInfo> {
    try {
      const res = await fetch('/api/wiki/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ zimPath }),
      });
      if (res.ok) {
        return await res.json();
      }
    } catch (e) {
      console.error('Wiki updateConfig failed:', e);
    }
    return await this.getStatus();
  }

  static async getRagContext(query: string): Promise<RagContextResponse> {
    try {
      const res = await fetch('/api/wiki/rag-context', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query }),
      });
      if (res.ok) {
        return await res.json();
      }
    } catch (e) {
      console.error('Wiki getRagContext failed:', e);
    }
    return {
      needsWiki: false,
      citations: [],
      promptContext: '',
    };
  }
}
