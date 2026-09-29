import { AppSettings, ChatMessage, ServerHealthInfo, TurnMetrics, WikiCitation, WikiStatusInfo, AsrServiceConfig, AsrServiceStatus } from '../types/chat';
import { estimateHistoryTokens, setTokenCalibration } from '../utils/token';

/** 服务端 usage 的实际形状（TTF 会给出 cached / reasoning 明细） */
interface UsagePayload {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  cached_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
}

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
    let finalUsage: UsagePayload | null = null;

    // TTF 专属增强：从服务端日志取**真实** prompt token 数。
    // 日志里的 `prepared prompt=N` 在生成开始前就已写好（实测发出后约 180ms 可读），
    // 所以圆环不必从估算值起步。非 TTF 引擎（Ollama / vLLM / llama.cpp）查不到记录 → 静默回退估算值。
    let realPromptTokens: number | null = null;
    let probeStarted = false;
    let streamClosed = false;
    const probeRealPromptTokens = (id: string) => {
      if (!id) return;
      let tries = 0;
      const tick = async () => {
        if (streamClosed || realPromptTokens !== null) return;
        tries++;
        try {
          const r = await fetch(`/api/ttf/request?id=${encodeURIComponent(id)}`);
          if (r.ok) {
            const j = (await r.json()) as { found?: boolean; promptTokens?: number };
            if (j && j.found && typeof j.promptTokens === 'number') {
              realPromptTokens = j.promptTokens;
              // 立刻用真实值刷新一次，不必等下一个 20-token 里程碑
              callbacks.onTokenProgress?.(realPromptTokens + generatedTokensCount);
              return;
            }
          }
        } catch {
          // 代理不可达 / 非 TTF：静默回退
        }
        if (tries < 15) setTimeout(tick, 200);
      };
      setTimeout(tick, 120);
    };

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
                finalUsage = parsed.usage as UsagePayload;
              }

              // 首个 chunk 携带 chatcmpl id：用它去服务端日志取真实 prompt token 数
              if (parsed.id && !probeStarted) {
                probeStarted = true;
                probeRealPromptTokens(String(parsed.id));
              }

              const choice = parsed.choices?.[0];
              if (!choice) continue;

              const delta = choice.delta;
              if (!delta) continue;

              // Mark first token time (TTFT) and notify initial prompt load
              if (!firstTokenTime && (delta.content || delta.reasoning_content)) {
                firstTokenTime = performance.now();
                callbacks.onFirstToken?.();
                // 若已从服务端日志拿到真实 prompt，用真实值；否则才回退估算值
                callbacks.onTokenProgress?.(realPromptTokens ?? initialPromptTokens);
              }

              if (delta.reasoning_content) {
                generatedTokensCount++;
                callbacks.onThought?.(delta.reasoning_content);
                if (generatedTokensCount - lastReportedMilestone >= 20) {
                  lastReportedMilestone = generatedTokensCount;
                  const livePrompt = finalUsage?.prompt_tokens ?? realPromptTokens ?? initialPromptTokens;
                  callbacks.onTokenProgress?.(livePrompt + generatedTokensCount);
                }
              }

              if (delta.content) {
                generatedTokensCount++;
                callbacks.onContent?.(delta.content);
                if (generatedTokensCount - lastReportedMilestone >= 20) {
                  lastReportedMilestone = generatedTokensCount;
                  const livePrompt = finalUsage?.prompt_tokens ?? realPromptTokens ?? initialPromptTokens;
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
      streamClosed = true; // 停止 TTF 日志轮询
      try {
        await reader.cancel();
      } catch {
        // ignore if already closed or aborted
      }
      reader.releaseLock();
    }

    // 用「真实 prompt_tokens ÷ 同一批消息的原始估算」校准展示层估算（见 utils/token.ts）
    if (finalUsage?.prompt_tokens) {
      setTokenCalibration(finalUsage.prompt_tokens, initialPromptTokens);
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
      cachedTokens: finalUsage?.prompt_tokens_details?.cached_tokens ?? finalUsage?.cached_tokens,
      reasoningTokens: finalUsage?.completion_tokens_details?.reasoning_tokens,
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
      enabled: true,
      connected: false,
      status: 'stopped',
      port: 31236,
      zimPath: null,
      contentId: null,
      bookTitle: 'Knowledge Base',
      articleCount: 0,
      mediaCount: 0,
    };
  }

  // 切换知识库服务总开关（后端为唯一事实来源，并负责拉起/杀掉 kiwix 进程）
  static async setEnabled(enabled: boolean): Promise<WikiStatusInfo> {
    try {
      const res = await fetch('/api/wiki/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      if (res.ok) {
        const data = await res.json();
        return {
          enabled: data.enabled !== false,
          connected: !!data.connected,
          status: data.status ?? (data.connected ? 'running' : 'stopped'),
          port: 31236,
          zimPath: data.zimPath ?? null,
          contentId: data.contentId ?? null,
          bookTitle: data.bookTitle || 'Knowledge Base',
          articleCount: data.articleCount ?? 0,
          mediaCount: data.mediaCount ?? 0,
        };
      }
    } catch (e) {
      console.error('Wiki setEnabled failed:', e);
    }
    return await this.getStatus();
  }

  static async search(query: string): Promise<Array<{ title: string; path: string; url: string; exact?: boolean }>> {
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

  /** 完整条目文本（Infobox + 完整引言 + 全部小节，供面板原生渲染） */
  static async getFullArticle(
    title: string
  ): Promise<{ title: string; url: string; context: string } | null> {
    try {
      const res = await fetch(`/api/wiki/article?title=${encodeURIComponent(title)}`);
      if (!res.ok) return null;
      return await res.json();
    } catch (e) {
      console.error('Wiki getFullArticle failed:', e);
      return null;
    }
  }

  static async getSummary(
    title: string,
    userQuery?: string
  ): Promise<{ title: string; url: string; context: string } | null> {
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

  /**
   * 知识库配置保存（ZIM 路径 / 端口）：
   *  - saveOnly: 仅落盘，不动运行中的服务（「保存路径」按钮）
   *  - restartIfRunning: 落盘后若服务在运行则重启使其生效（「保存并应用」按钮）
   */
  static async saveConfig(
    partial: { zimPath?: string; port?: number },
    opts: { saveOnly?: boolean; restartIfRunning?: boolean } = {}
  ): Promise<WikiStatusInfo & { success?: boolean; savedOnly?: boolean; restarted?: boolean; error?: string }> {
    try {
      const res = await fetch('/api/wiki/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...partial, saveOnly: opts.saveOnly, restartIfRunning: opts.restartIfRunning }),
      });
      if (res.ok) {
        return await res.json();
      }
    } catch (e) {
      console.error('Wiki saveConfig failed:', e);
    }
    return await this.getStatus();
  }

  static async getRagContext(query: string, signal?: AbortSignal): Promise<RagContextResponse> {
    try {
      const res = await fetch('/api/wiki/rag-context', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query }),
        // 用户点停止 → abort → 服务端经 req 'close' 中止检索与所有相关模型调用
        signal,
      });
      if (res.ok) {
        return await res.json();
      }
    } catch (e) {
      // 用户中止必须向上传播（吞成 needsWiki:false 会让流程带着中止信号继续发推理请求）
      if ((e as Error).name === 'AbortError') throw e;
      console.error('Wiki getRagContext failed:', e);
    }
    return {
      needsWiki: false,
      citations: [],
      promptContext: '',
    };
  }
}

/** 模型服务（TurboFieldfare）聚合状态：与后端 ttf_service.js getStatus 对应 */
export interface ModelServiceStatus {
  enabled: boolean;
  status: 'running' | 'loading' | 'stopped' | 'starting' | 'stopping' | 'restart';
  pid: number | null;
  port: number;
  projectDir: string;
  modelPath: string;
  /** 本体项目主页：安装（克隆本体 / 编译 / 准备模型权重）交给用户按项目文档完成 */
  projectUrl: string;
  checks: { repo: boolean; binary: boolean; model: boolean; vision: boolean };
  lastActionAt?: number;
  lastActionLog?: string;
}

/** 模型服务运行配置：与后端 model_config.json 对应 */
export interface ModelServiceConfig {
  enabled: boolean;
  projectDir: string;
  port: number;
  maxContext: number;
  expertCacheSlots: number;
  expertCachePolicy: 'lfu' | 'lru';
  prefill: 'on' | 'off';
  prefillChunkTokens: 'auto' | '32' | '64' | '128' | '256';
  visionResidency: 'on-demand' | 'keep-ready';
  promptCacheMode: 'single-prefix' | 'off';
  thinking: 'default' | 'on' | 'off';
  rdadvise: 'adaptive' | 'bounded' | 'default' | 'off';
  allowUnbackedContext: boolean;
  idleAutoResetMinutes: number;
}

export class ModelServiceAPI {
  static async getStatus(): Promise<ModelServiceStatus | null> {
    try {
      const res = await fetch('/api/model/status');
      if (res.ok) return await res.json();
    } catch (e) {
      console.error('ModelService getStatus failed:', e);
    }
    return null;
  }

  static async getConfig(): Promise<ModelServiceConfig | null> {
    try {
      const res = await fetch('/api/model/config');
      if (res.ok) return await res.json();
    } catch (e) {
      console.error('ModelService getConfig failed:', e);
    }
    return null;
  }

  /** 应用部分配置；restartIfRunning=true 时若服务在运行则自动热重启 */
  static async updateConfig(
    partial: Partial<ModelServiceConfig>,
    restartIfRunning = false
  ): Promise<{ success: boolean; restarted?: boolean; error?: string; config?: ModelServiceConfig }> {
    try {
      const res = await fetch('/api/model/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...partial, restartIfRunning }),
      });
      if (res.ok) return await res.json();
    } catch (e) {
      console.error('ModelService updateConfig failed:', e);
    }
    return { success: false, error: 'request_failed' };
  }

  static async control(
    action: 'start' | 'stop' | 'restart'
  ): Promise<{ accepted: boolean; status?: string; reason?: string }> {
    try {
      const res = await fetch(`/api/model/${action}`, { method: 'POST' });
      if (res.ok) return await res.json();
    } catch (e) {
      console.error(`ModelService ${action} failed:`, e);
    }
    return { accepted: false };
  }

  static async getLogs(lines = 200): Promise<{ found: boolean; lines: string[] } | null> {
    try {
      const res = await fetch(`/api/model/logs?lines=${lines}`);
      if (res.ok) return await res.json();
    } catch (e) {
      console.error('ModelService getLogs failed:', e);
    }
    return null;
  }
}

/**
 * 语音识别服务（SenseVoice / audio.cpp）。
 *
 * 与基础模型服务同构：SimpleUI 是 audiocpp_server 的唯一管理方，
 * 随 App 自动拉起、退出一并终止；配置持久化于 asr_config.json。
 */
export class ASRServiceAPI {
  static async getStatus(): Promise<AsrServiceStatus | null> {
    try {
      const res = await fetch('/api/asr/status');
      if (res.ok) return await res.json();
    } catch (e) {
      console.error('ASRService getStatus failed:', e);
    }
    return null;
  }

  static async getConfig(): Promise<AsrServiceConfig | null> {
    try {
      const res = await fetch('/api/asr/config');
      if (res.ok) return await res.json();
    } catch (e) {
      console.error('ASRService getConfig failed:', e);
    }
    return null;
  }

  /** 应用部分配置；restartIfRunning=true 时若服务在运行则自动热重启 */
  static async updateConfig(
    partial: Partial<AsrServiceConfig>,
    restartIfRunning = false
  ): Promise<{ success: boolean; restarted?: boolean; error?: string; config?: AsrServiceConfig }> {
    try {
      const res = await fetch('/api/asr/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...partial, restartIfRunning }),
      });
      if (res.ok) return await res.json();
    } catch (e) {
      console.error('ASRService updateConfig failed:', e);
    }
    return { success: false, error: 'request_failed' };
  }

  static async control(
    action: 'start' | 'stop' | 'restart'
  ): Promise<{ accepted: boolean; status?: string; reason?: string }> {
    try {
      const res = await fetch(`/api/asr/${action}`, { method: 'POST' });
      if (res.ok) return await res.json();
    } catch (e) {
      console.error(`ASRService ${action} failed:`, e);
    }
    return { accepted: false };
  }

  static async getLogs(lines = 200): Promise<{ found: boolean; lines: string[] } | null> {
    try {
      const res = await fetch(`/api/asr/logs?lines=${lines}`);
      if (res.ok) return await res.json();
    } catch (e) {
      console.error('ASRService getLogs failed:', e);
    }
    return null;
  }
}
