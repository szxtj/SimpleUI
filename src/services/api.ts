import { AppSettings, ChatMessage, ServerHealthInfo, TurnMetrics, WikiCitation, WikiStatusInfo, AsrServiceConfig, AsrServiceStatus, SubtitleServiceStatus, SubtitleDownloadState, TtsServiceStatus, TtsServiceConfig, TtsDownloadState, OcrServiceStatus, OcrDownloadState, OcrConfig, OcrRecognizeResult, Scene3dServiceStatus, Scene3dDownloadState, TranslateServiceStatus, TranslateServiceConfigPatch } from '../types/chat';
import { estimateHistoryTokens, setTokenCalibration, CalibrationProvider } from '../utils/token';

/** 服务端 usage 的实际形状（TTF 会给出 cached / reasoning 明细） */
interface UsagePayload {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  cached_tokens?: number;
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
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
    if (settings.apiProvider === 'deepseek') {
      const url = settings.deepseekBaseUrl?.trim();
      if (url && url.startsWith('http')) {
        return url.replace(/\/+$/, '');
      }
      return 'https://api.deepseek.com';
    }
    if (settings.apiBaseUrl?.trim() && settings.apiBaseUrl.startsWith('http')) {
      return settings.apiBaseUrl.trim().replace(/\/+$/, '');
    }
    return ''; // Relative path, hits local node proxy on same origin
  }

  private static getHeaders(settings: AppSettings, extra?: Record<string, string>): Record<string, string> {
    if (settings.apiProvider === 'deepseek') {
      const apiKey = settings.deepseekApiKey?.trim() || '';
      return {
        'Accept': 'application/json',
        ...(apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {}),
        ...(extra || {}),
      };
    }
    const port = settings.apiPort || 1235;
    return {
      'Accept': 'application/json',
      'x-target-port': String(port),
      ...(extra || {}),
    };
  }

  static async checkHealth(settings: AppSettings): Promise<ServerHealthInfo> {
    if (settings.apiProvider === 'deepseek') {
      const apiKey = settings.deepseekApiKey?.trim();
      if (!apiKey) {
        return {
          status: 'missing_key',
          vision: 'unsupported',
          online: false,
        };
      }
      const baseUrl = this.getBaseUrl(settings);
      try {
        const res = await fetch(`${baseUrl}/models`, {
          method: 'GET',
          headers: this.getHeaders(settings),
        }).catch(() => null);

        if (res && res.ok) {
          return {
            status: 'ok',
            vision: 'ready', // DeepSeek-Flash natively supports multimodal image understanding
            modelId: settings.deepseekModelId || 'deepseek-flash',
            online: true,
          };
        }
        if (res && res.status === 401) {
          return { status: 'auth_error', vision: 'unsupported', online: false };
        }
        return { status: 'offline', vision: 'unsupported', online: false };
      } catch {
        return { status: 'offline', vision: 'unsupported', online: false };
      }
    }

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
    if (settings.apiProvider === 'deepseek') {
      const defaultModels = ['deepseek-flash', 'deepseek-v4-pro'];
      const apiKey = settings.deepseekApiKey?.trim();
      if (!apiKey) return defaultModels;
      const baseUrl = this.getBaseUrl(settings);
      try {
        const res = await fetch(`${baseUrl}/models`, {
          method: 'GET',
          headers: this.getHeaders(settings),
        });
        if (!res.ok) return defaultModels;
        const data = await res.json();
        if (Array.isArray(data.data) && data.data.length > 0) {
          const ids: string[] = data.data.map((m: { id: string }) => m.id);
          // Prioritize deepseek-flash and deepseek-v4-pro
          ids.sort((a, b) => {
            if (a === 'deepseek-flash') return -1;
            if (b === 'deepseek-flash') return 1;
            if (a === 'deepseek-v4-pro') return -1;
            if (b === 'deepseek-v4-pro') return 1;
            return a.localeCompare(b);
          });
          return ids;
        }
        return defaultModels;
      } catch {
        return defaultModels;
      }
    }

    const baseUrl = this.getBaseUrl(settings);
    try {
      const res = await fetch(`${baseUrl}/v1/models`, {
        method: 'GET',
        headers: this.getHeaders(settings),
      });
      const fallbackDefault = settings.apiPort === 1241 ? 'qwen3.6-35b-a3b' : 'gemma-4-26b-a4b-it';
      if (!res.ok) return [settings.modelId || fallbackDefault];
      const data = await res.json();
      if (Array.isArray(data.data) && data.data.length > 0) {
        return data.data.map((m: { id: string }) => m.id);
      }
      return [settings.modelId || fallbackDefault];
    } catch {
      const fallbackDefault = settings.apiPort === 1241 ? 'qwen3.6-35b-a3b' : 'gemma-4-26b-a4b-it';
      return [settings.modelId || fallbackDefault];
    }
  }

  static async streamChat(
    messages: ChatMessage[],
    settings: AppSettings,
    callbacks: StreamCallbacks,
    signal?: AbortSignal
  ): Promise<void> {
    const isDeepSeek = settings.apiProvider === 'deepseek';
    if (isDeepSeek && !settings.deepseekApiKey?.trim()) {
      callbacks.onError?.(new Error('请在设置中配置 DeepSeek API Key'));
      return;
    }

    const baseUrl = this.getBaseUrl(settings);
    const cleanBase = baseUrl.replace(/\/chat\/completions\/?$/, '').replace(/\/+$/, '');
    const endpoint = isDeepSeek
      ? `${cleanBase}/chat/completions`
      : `${cleanBase}/v1/chat/completions`;

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

    const isExternalApi = isDeepSeek || Boolean(baseUrl && !baseUrl.includes('127.0.0.1:31235') && !baseUrl.includes('localhost:31235'));

    for (const msg of messages) {
      if (msg.role === 'user') {
        if (msg.images && msg.images.length > 0) {
          const parts: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string; detail?: string } }> = [];
          if (msg.content && msg.content.trim()) {
            parts.push({ type: 'text', text: msg.content.trim() });
          } else {
            // 只有发单图片无字符的时候，默认带上单个空格，避免注入主观提示词干扰模型意图
            parts.push({ type: 'text', text: ' ' });
          }
          for (const imgUrl of msg.images) {
            let finalUrl = imgUrl;
            // Convert /api/media/... or blob:... to Data URL for external API
            if (isExternalApi && (finalUrl.startsWith('/api/media/') || finalUrl.includes('/api/media/') || finalUrl.startsWith('blob:'))) {
              try {
                const resp = await fetch(finalUrl);
                if (resp.ok) {
                  const blob = await resp.blob();
                  finalUrl = await new Promise<string>((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onload = () => resolve(reader.result as string);
                    reader.onerror = reject;
                    reader.readAsDataURL(blob);
                  });
                }
              } catch (e) {
                console.warn('[api] Failed to resolve media URL for external endpoint:', e);
              }
            }
            parts.push({
              type: 'image_url',
              image_url: { url: finalUrl, detail: 'auto' },
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
    let payload: Record<string, unknown>;

    if (isDeepSeek) {
      payload = {
        model: settings.deepseekModelId || 'deepseek-flash',
        messages: wireMessages,
        stream: true,
        stream_options: { include_usage: true },
        max_tokens: settings.maxTokens,
      };

      if (settings.enableThinking) {
        payload.thinking = { type: 'enabled' };
        const effort = settings.reasoningEffort;
        payload.reasoning_effort = (effort === 'low' || effort === 'high' || effort === 'max') ? effort : 'high';
        if (settings.topP !== undefined) {
          payload.top_p = Math.max(0.95, settings.topP);
        }
      } else {
        payload.thinking = { type: 'disabled' };
        if (settings.temperature !== undefined) {
          payload.temperature = settings.temperature;
        }
        if (settings.topP !== undefined) {
          payload.top_p = settings.topP;
        }
      }

      if (settings.stopStrings && settings.stopStrings.length > 0) {
        payload.stop = settings.stopStrings;
      }
    } else {
      // mlx_lm.server（Maple / Qwen 3.5 9B）在收到「不是当前加载模型」的 model 串时，
      // 会把它当成 Hugging Face repo id 去解析：带空格或中文会直接
      // 400 "Repo id must use alphanumeric chars..." / 404。
      // 这两个引擎的 modelId 只是界面标签（单模型服务），请求统一发 default_model。
      const isMlxEngine =
        settings.apiProvider === 'maple' || settings.apiProvider === 'qwen-qa';
      payload = {
        model: isMlxEngine ? 'default_model' : settings.modelId || 'gemma-4-26b-a4b-it',
        messages: wireMessages,
        stream: true,
        stream_options: { include_usage: true },
        temperature: settings.temperature,
        top_p: settings.topP,
        top_k: settings.topK,
        repetition_penalty: settings.repetitionPenalty,
        max_tokens: settings.maxTokens,
      };

      // 判断是否连接 Mference（provider 为 mference，或端口 1241，或 modelId 包含 qwen）
      const isMference = (settings.apiProvider === 'mference') ||
        (settings.apiPort === 1241) ||
        (typeof settings.modelId === 'string' && settings.modelId.toLowerCase().includes('qwen'));

      // Thinking controls (针对 TTF、Mference 与自定义引擎做协议适配)
      if (settings.apiProvider === 'maple') {
        // Maple（mlx_lm.server）：chat template 恒开 <think>，不接受 reasoning_effort /
        // chat_template_kwargs；思考预算由 max_tokens 承担，这里什么都不加。
      } else if (settings.apiProvider === 'qwen-qa') {
        // Qwen 3.5 9B：思考开关在对话框上，直接映射到 chat template。
        // mlx_lm.server 会用请求里的 chat_template_kwargs 覆盖启动参数的默认值，
        // 所以这里必须**显式**下发，否则总是落到服务端默认（关）。
        payload.chat_template_kwargs = { enable_thinking: settings.enableThinking === true };
      } else if (settings.apiProvider === 'custom') {
        if (settings.enableThinking) {
          payload.chat_template_kwargs = { enable_thinking: true };
          if (settings.reasoningEffort && settings.reasoningEffort !== 'default') {
            payload.reasoning_effort = settings.reasoningEffort;
          }
        }
      } else if (settings.enableThinking) {
        payload.chat_template_kwargs = { enable_thinking: true };
        if (isMference) {
          // Mference 仅接受 xhigh, medium, low, none；将界面的 high/max 映射为 xhigh
          const effort = settings.reasoningEffort;
          payload.reasoning_effort = (effort === 'low' || effort === 'medium') ? effort : 'xhigh';
        } else {
          // TurboFieldfare 接受 high, medium, low, default, none
          payload.reasoning_effort = settings.reasoningEffort || 'high';
        }
      } else {
        payload.chat_template_kwargs = { enable_thinking: false };
        payload.reasoning_effort = 'none';
      }

      if (settings.seed !== undefined && settings.seed !== null && !isNaN(settings.seed)) {
        payload.seed = settings.seed;
      }

      if (settings.minP !== undefined && settings.minP !== null && !isNaN(settings.minP)) {
        payload.min_p = settings.minP;
      }

      if (settings.presencePenalty !== undefined && settings.presencePenalty !== null && !isNaN(settings.presencePenalty)) {
        payload.presence_penalty = settings.presencePenalty;
      }

      if (settings.stopStrings && settings.stopStrings.length > 0) {
        payload.stop = settings.stopStrings;
      }
    }

    const initialPromptTokens = estimateHistoryTokens(messages, settings.systemPrompt, settings.apiProvider);
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
              if (parsed.id && !probeStarted && !isDeepSeek) {
                probeStarted = true;
                probeRealPromptTokens(String(parsed.id));
              }

              const choice = parsed.choices?.[0];
              if (!choice) continue;

              const delta = choice.delta;
              if (!delta) continue;

              // 思考通道的字段名各引擎不同，这里做**唯一一次**归一化：
              //   - TTF / Mference：reasoning_content（OpenAI 习惯）
              //   - Maple（deepgrove 版 mlx_lm.server）：reasoning
              // 少认一个字段的后果就是「思考被整段丢弃、界面上没有思考过程」。
              const thoughtDelta =
                (delta as { reasoning?: string }).reasoning ??
                (delta as { reasoning_content?: string }).reasoning_content;

              // Mark first token time (TTFT) and notify initial prompt load
              if (!firstTokenTime && (delta.content || thoughtDelta)) {
                firstTokenTime = performance.now();
                callbacks.onFirstToken?.();
                // 若已从服务端日志拿到真实 prompt，用真实值；否则才回退估算值
                callbacks.onTokenProgress?.(realPromptTokens ?? initialPromptTokens);
              }

              if (thoughtDelta) {
                generatedTokensCount++;
                callbacks.onThought?.(thoughtDelta);
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
      const calibProvider: CalibrationProvider = isDeepSeek
        ? 'deepseek'
        : (settings.apiProvider as CalibrationProvider) || 'local';
      setTokenCalibration(finalUsage.prompt_tokens, initialPromptTokens, calibProvider);
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
      cachedTokens: finalUsage?.prompt_cache_hit_tokens ?? finalUsage?.prompt_tokens_details?.cached_tokens ?? finalUsage?.cached_tokens,
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

export type ModelEngine = 'turbo-fieldfare' | 'mference' | 'maple-mlx' | 'qwen-qa';

/** 下载/安装任务状态（与 asr/tts 下载器同名字段，便于复用同一套进度条 UI） */
export interface AssetTaskState {
  active: boolean;
  phase: string;
  step?: string;
  stepLabel?: string;
  progressPercent: number;
  downloadedBytes: number;
  totalBytes: number;
  speedBps: number;
  etaSeconds: number | null;
  error: string | null;
  errorCode: string | null;
  updatedAt: number;
}

/** Maple MLX 托管资源状态（运行时 venv / 权重） */
export interface MapleAssets {
  runtime: {
    ready: boolean;
    dir: string;
    presentBytes: number;
    totalBytes: number;
    installState: AssetTaskState;
  };
  model: {
    ready: boolean;
    dir: string;
    presentBytes: number;
    totalBytes: number;
    downloadState: AssetTaskState;
  };
}

/** Qwen 3.5 9B 托管资源状态（运行时复用 Maple，只有权重） */
export interface QwenQaAssets {
  runtime: {
    ready: boolean;
    dir: string;
    /** 与 Maple 共用同一份 Python 运行时 */
    shared: boolean;
  };
  model: {
    ready: boolean;
    dir: string;
    presentBytes: number;
    totalBytes: number;
    downloadState: AssetTaskState;
  };
}

export interface SingleEngineStatus {
  engine: ModelEngine;
  status: 'running' | 'loading' | 'stopped' | 'starting' | 'stopping' | 'restart';
  port: number;
  pid: number | null;
  enabled: boolean;
  checks: { repo: boolean; binary: boolean; model: boolean; vision?: boolean };
  projectDir: string;
  modelPath: string;
  projectUrl: string;
  /** Maple MLX / Qwen 3.5 9B：托管资源的下载进度（两者结构略有差异） */
  assets?: MapleAssets | QwenQaAssets;
}

/** 模型服务聚合状态：与后端 ttf_service.js getStatus 对应 */
export interface ModelServiceStatus {
  activeEngine?: ModelEngine;
  enabled: boolean;
  engine: ModelEngine;
  status: 'running' | 'loading' | 'stopped' | 'starting' | 'stopping' | 'restart';
  pid: number | null;
  port: number;
  projectDir: string;
  modelPath: string;
  /** 本体项目主页：安装交给用户按项目文档完成 */
  projectUrl: string;
  checks: { repo: boolean; binary: boolean; model: boolean; vision: boolean };
  lastActionAt?: number;
  lastActionLog?: string;
  config?: ModelServiceConfig;
  /** 独立的双引擎状态块 */
  ttf: SingleEngineStatus;
  mference: SingleEngineStatus;
  /** Maple MLX（运行时 + 权重按需下载） */
  maple?: SingleEngineStatus;
  /** Qwen 3.5 9B 问答引擎（运行时复用 Maple，只有权重按需下载） */
  qwenQa?: SingleEngineStatus;
}

/** 模型服务运行配置：与后端 model_config.json 对应 */
export interface ModelServiceConfig {
  enabled: boolean;
  engine?: ModelEngine;
  ttfEnabled?: boolean;
  mferenceEnabled?: boolean;

  // TurboFieldfare 运行参数
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

  // Mference 运行参数
  mferenceProjectDir?: string;
  mferencePort?: number;
  mferenceMaxContext?: number;
  mferencePromptCacheMode?: 'single-prefix' | 'off';
  mferenceShadowBudget?: number;
  mferenceVerify?: 'auto' | 'full-sha256' | 'trusted-receipt';
  mferenceQueueLimit?: number;
  mferencePrefillChunk?: string;

  // Maple MLX 运行参数（运行时与权重由 SimpleUI 托管）
  mapleEnabled?: boolean;
  maplePort?: number;
  maplePromptCacheSize?: number;
  maplePrefillStepSize?: number;
  mapleFlashHead?: boolean;

  // Qwen 3.5 9B（问答引擎：默认不推理，运行时复用 Maple 的 Python）
  qwenQaEnabled?: boolean;
  qwenQaPort?: number;
  qwenQaMaxTokens?: number;
  qwenQaPromptCacheSize?: number;
  qwenQaThinking?: boolean;

  // 极低负载闲置保护
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
    action: 'start' | 'stop' | 'restart',
    engine?: ModelEngine
  ): Promise<{ accepted: boolean; status?: string; reason?: string }> {
    try {
      const res = await fetch(`/api/model/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ engine }),
      });
      if (res.ok) return await res.json();
    } catch (e) {
      console.error(`ModelService ${action} failed:`, e);
    }
    return { accepted: false };
  }

  static async getLogs(
    lines = 200,
    engine?: ModelEngine
  ): Promise<{ found: boolean; lines: string[] } | null> {
    try {
      const qs = new URLSearchParams({ lines: String(lines) });
      if (engine) qs.set('engine', engine);
      const res = await fetch(`/api/model/logs?${qs.toString()}`);
      if (res.ok) return await res.json();
    } catch (e) {
      console.error('ModelService getLogs failed:', e);
    }
    return null;
  }

  // ------------------------- Maple MLX 托管资源 -------------------------

  /** 运行时 + 权重的就绪状态与下载进度 */
  static async getMapleState(): Promise<MapleAssets | null> {
    try {
      const res = await fetch('/api/model/maple/state');
      if (res.ok) return await res.json();
    } catch (e) {
      console.error('ModelService getMapleState failed:', e);
    }
    return null;
  }

  /** 安装/取消运行时（Python venv，约 311MB 依赖） */
  static async installMapleRuntime(): Promise<MapleAssets | null> {
    return this.postMaple('/api/model/maple/runtime/install');
  }

  static async cancelMapleRuntime(): Promise<MapleAssets | null> {
    return this.postMaple('/api/model/maple/runtime/cancel');
  }

  /** 下载/取消 Maple 权重（5.31GB） */
  static async downloadMapleModel(): Promise<MapleAssets | null> {
    return this.postMaple('/api/model/maple/download/start');
  }

  static async cancelMapleModel(): Promise<MapleAssets | null> {
    return this.postMaple('/api/model/maple/download/cancel');
  }

  private static async postMaple(url: string): Promise<MapleAssets | null> {
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
      if (res.ok) return await res.json();
    } catch (e) {
      console.error('ModelService maple action failed:', e);
    }
    return null;
  }

  // ------------------- Qwen 3.5 9B（问答引擎）托管资源 -------------------
  // 运行时与 Maple 共用，只托管权重；没有 runtime/install 端点。

  static async getQwenQaState(): Promise<QwenQaAssets | null> {
    try {
      const res = await fetch('/api/model/qwen-qa/state');
      if (res.ok) return await res.json();
    } catch (e) {
      console.error('ModelService getQwenQaState failed:', e);
    }
    return null;
  }

  /** 下载 / 取消 Qwen 3.5 9B 权重（约 5.95GB） */
  static async downloadQwenQaModel(): Promise<QwenQaAssets | null> {
    return this.postQwenQa('/api/model/qwen-qa/download/start');
  }

  static async cancelQwenQaModel(): Promise<QwenQaAssets | null> {
    return this.postQwenQa('/api/model/qwen-qa/download/cancel');
  }

  private static async postQwenQa(url: string): Promise<QwenQaAssets | null> {
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
      if (res.ok) return await res.json();
    } catch (e) {
      console.error('ModelService qwen-qa action failed:', e);
    }
    return null;
  }
}

/**
 * 语音识别服务（Confucius4-R2T2 / audio.cpp）。
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

  static async saveConfig(
    partial: Partial<AsrServiceConfig>
  ): Promise<{ success: boolean; restarted?: boolean; error?: string; config?: AsrServiceConfig }> {
    return this.updateConfig(partial, false);
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

  /** 下载当前引擎的模型；显式传 engine 时下载指定引擎的（默认交给服务端按当前引擎决定） */
  static async startDownload(
    engine?: 'qwen3' | 'r2t2'
  ): Promise<{ ok: boolean; downloadState?: SubtitleDownloadState }> {
    try {
      const qs = engine ? `?engine=${engine}` : '';
      const res = await fetch(`/api/asr/models/download${qs}`, { method: 'POST' });
      if (res.ok) return await res.json();
    } catch (e) {
      console.error('ASRService startDownload failed:', e);
    }
    return { ok: false };
  }

  static async cancelDownload(
    engine?: 'qwen3' | 'r2t2'
  ): Promise<{ ok: boolean; downloadState?: SubtitleDownloadState }> {
    try {
      const qs = engine ? `?engine=${engine}` : '';
      const res = await fetch(`/api/asr/models/cancel-download${qs}`, { method: 'POST' });
      if (res.ok) return await res.json();
    } catch (e) {
      console.error('ASRService cancelDownload failed:', e);
    }
    return { ok: false };
  }

  static async openModelsDir(): Promise<{ ok: boolean; path?: string }> {
    try {
      const res = await fetch('/api/asr/open-dir', { method: 'POST' });
      if (res.ok) return await res.json();
    } catch (e) {
      console.error('ASRService openModelsDir failed:', e);
    }
    return { ok: false };
  }
}

/**
 * 快速翻译服务（快速模式复用字幕翻译小模型 · 详解模式走 DeepSeek / 基础模型服务）。
 *
 * 模型下载与进度全部转发给实时字幕服务，二者共用同一份模型文件、运行时与下载器，
 * 因此这里不复制任何下载逻辑，只做状态读取与配置写入。
 */
export class TranslateServiceAPI {
  static async getStatus(): Promise<TranslateServiceStatus | null> {
    try {
      const res = await fetch('/api/translate/status', { cache: 'no-store' });
      if (res.ok) return await res.json();
    } catch (e) {
      console.error('TranslateService getStatus failed:', e);
    }
    return null;
  }

  static async updateConfig(
    patch: TranslateServiceConfigPatch
  ): Promise<{ ok: boolean; config?: TranslateServiceStatus }> {
    try {
      const res = await fetch('/api/translate/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (res.ok) return await res.json();
    } catch (e) {
      console.error('TranslateService updateConfig failed:', e);
    }
    return { ok: false };
  }

  /** 下载翻译小模型：与字幕服务共用同一套双源测速下载器 */
  static async startDownload(): Promise<{ ok: boolean; downloadState?: SubtitleDownloadState }> {
    try {
      const res = await fetch('/api/translate/download', { method: 'POST' });
      if (res.ok) return await res.json();
    } catch (e) {
      console.error('TranslateService startDownload failed:', e);
    }
    return { ok: false };
  }

  static async cancelDownload(): Promise<{ ok: boolean; downloadState?: SubtitleDownloadState }> {
    try {
      const res = await fetch('/api/translate/download/cancel', { method: 'POST' });
      if (res.ok) return await res.json();
    } catch (e) {
      console.error('TranslateService cancelDownload failed:', e);
    }
    return { ok: false };
  }

  static async openModelsDir(): Promise<{ ok: boolean; path?: string }> {
    try {
      const res = await fetch('/api/translate/open-dir', { method: 'POST' });
      if (res.ok) return await res.json();
    } catch (e) {
      console.error('TranslateService openModelsDir failed:', e);
    }
    return { ok: false };
  }

  /** 预热快速模式小模型（与字幕服务共用 1249） */
  static async warmup(): Promise<{ ok: boolean; error?: string }> {
    try {
      const res = await fetch('/api/translate/warmup', { method: 'POST' });
      return await res.json();
    } catch (e) {
      console.error('TranslateService warmup failed:', e);
    }
    return { ok: false };
  }

  /** 卸载快速模式小模型（字幕服务运行中时会被拒绝，避免打断字幕） */
  static async unload(): Promise<{ ok: boolean; reason?: string }> {
    try {
      const res = await fetch('/api/translate/unload', { method: 'POST' });
      return await res.json();
    } catch (e) {
      console.error('TranslateService unload failed:', e);
    }
    return { ok: false };
  }
}

/**
 * 实时双语字幕服务（Confucius4-R2T2 Metal + Index-Translate-2B）。
 *
 * 严格按需启停（随悬浮窗开启自动加载模型，随悬浮窗关闭立即卸载），
 * 服务管理面板负责展示整体状态、运行环境与两级模型完备状态，并提供双源自动测速一键下载与打开模型目录功能。
 */
export class SubtitleServiceAPI {
  static async getStatus(): Promise<SubtitleServiceStatus | null> {
    try {
      const res = await fetch('/api/subtitles/status');
      if (res.ok) return await res.json();
    } catch (e) {
      console.error('SubtitleService getStatus failed:', e);
    }
    return null;
  }

  static async startDownload(
    model: 'all' | 'asr' | 'translate' | 'segment' = 'all'
  ): Promise<{ ok: boolean; downloadState?: SubtitleDownloadState }> {
    try {
      const res = await fetch('/api/subtitles/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model }),
      });
      if (res.ok) return await res.json();
    } catch (e) {
      console.error('SubtitleService startDownload failed:', e);
    }
    return { ok: false };
  }

  static async cancelDownload(): Promise<{ ok: boolean; downloadState?: SubtitleDownloadState }> {
    try {
      const res = await fetch('/api/subtitles/download/cancel', {
        method: 'POST',
      });
      if (res.ok) return await res.json();
    } catch (e) {
      console.error('SubtitleService cancelDownload failed:', e);
    }
    return { ok: false };
  }

  static async openModelsDir(): Promise<{ ok: boolean; path?: string }> {
    try {
      const res = await fetch('/api/subtitles/open-dir', {
        method: 'POST',
      });
      if (res.ok) return await res.json();
    } catch (e) {
      console.error('SubtitleService openModelsDir failed:', e);
    }
    return { ok: false };
  }
}

/**
 * 文字转语音服务（Qwen3-TTS 1.7B CustomVoice · MLX 6bit）。
 *
 * 每次生成现场加载模型、结束即卸载；服务管理面板负责展示运行环境、模型完备状态、
 * 双源自动测速下载进度、打开模型目录，以及采样参数（temperature / top_p / top_k /
 * repetition_penalty / max_tokens）。
 */
export class TtsServiceAPI {
  static async getStatus(): Promise<TtsServiceStatus | null> {
    try {
      const res = await fetch('/api/tts/status', { cache: 'no-store' });
      if (res.ok) return await res.json();
    } catch (e) {
      console.error('TtsService getStatus failed:', e);
    }
    return null;
  }

  static async startDownload(): Promise<{ ok: boolean; downloadState?: TtsDownloadState }> {
    try {
      const res = await fetch('/api/tts/download', { method: 'POST' });
      if (res.ok) return await res.json();
    } catch (e) {
      console.error('TtsService startDownload failed:', e);
    }
    return { ok: false };
  }

  static async cancelDownload(): Promise<{ ok: boolean; downloadState?: TtsDownloadState }> {
    try {
      const res = await fetch('/api/tts/download/cancel', { method: 'POST' });
      if (res.ok) return await res.json();
    } catch (e) {
      console.error('TtsService cancelDownload failed:', e);
    }
    return { ok: false };
  }

  static async openModelsDir(): Promise<{ ok: boolean; path?: string }> {
    try {
      const res = await fetch('/api/tts/open-dir', { method: 'POST' });
      if (res.ok) return await res.json();
    } catch (e) {
      console.error('TtsService openModelsDir failed:', e);
    }
    return { ok: false };
  }

  static async updateConfig(partial: Partial<TtsServiceConfig>): Promise<{ ok: boolean }> {
    try {
      const res = await fetch('/api/tts/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(partial),
      });
      if (res.ok) return await res.json();
    } catch (e) {
      console.error('TtsService updateConfig failed:', e);
    }
    return { ok: false };
  }
}

/**
 * 视觉文档识别服务 API（PaddleOCR-VL 1.6 MLX 8bit · 按需生命周期）
 */
export class OcrServiceAPI {
  static async getStatus(): Promise<OcrServiceStatus | null> {
    try {
      const res = await fetch('/api/ocr/status', { cache: 'no-store' });
      if (res.ok) return await res.json();
    } catch (e) {
      console.error('OcrService getStatus failed:', e);
    }
    return null;
  }

  static async startDownload(): Promise<{ ok: boolean; downloadState?: OcrDownloadState }> {
    try {
      const res = await fetch('/api/ocr/download', { method: 'POST' });
      if (res.ok) return await res.json();
    } catch (e) {
      console.error('OcrService startDownload failed:', e);
    }
    return { ok: false };
  }

  static async cancelDownload(): Promise<{ ok: boolean; downloadState?: OcrDownloadState }> {
    try {
      const res = await fetch('/api/ocr/download/cancel', { method: 'POST' });
      if (res.ok) return await res.json();
    } catch (e) {
      console.error('OcrService cancelDownload failed:', e);
    }
    return { ok: false };
  }

  static async openModelsDir(): Promise<{ ok: boolean; path?: string }> {
    try {
      const res = await fetch('/api/ocr/open-dir', { method: 'POST' });
      if (res.ok) return await res.json();
    } catch (e) {
      console.error('OcrService openModelsDir failed:', e);
    }
    return { ok: false };
  }

  static async updateConfig(
    partial: Partial<OcrConfig>
  ): Promise<{ ok: boolean; config?: OcrConfig }> {
    try {
      const res = await fetch('/api/ocr/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(partial),
      });
      if (res.ok) return await res.json();
    } catch (e) {
      console.error('OcrService updateConfig failed:', e);
    }
    return { ok: false };
  }

  static async recognize(
    imagePath: string,
    options?: { task?: string; resolution?: string }
  ): Promise<OcrRecognizeResult> {
    try {
      const res = await fetch('/api/ocr/recognize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imagePath, ...options }),
      });
      return await res.json();
    } catch (e: any) {
      console.error('OcrService recognize failed:', e);
      return { ok: false, error: e?.message || 'REQUEST_FAILED' };
    }
  }
}

/**
 * 3D 场景构建服务 API（Qwen3.5-4B-3D-Coder · GGUF Q4_K_M · 独立 llama.cpp b12040 运行时）。
 *
 * 生命周期与 TTS/OCR 一致：3D 独立窗口打开时 ensure（后台拉起）、关闭时 release；
 * 服务管理面板负责展示模型完备状态、双源下载进度与启停。
 */
export class Scene3dServiceAPI {
  static async getStatus(): Promise<Scene3dServiceStatus | null> {
    try {
      const res = await fetch('/api/scene3d/status', { cache: 'no-store' });
      if (res.ok) return await res.json();
    } catch (e) {
      console.error('Scene3dService getStatus failed:', e);
    }
    return null;
  }

  /** 打开 3D 窗口时调用：模型不全则后台补下载，进程不在则后台拉起，立即返回当前状态 */
  static async ensure(): Promise<Scene3dServiceStatus | null> {
    try {
      const res = await fetch('/api/scene3d/ensure', { method: 'POST' });
      if (res.ok) return await res.json();
    } catch (e) {
      console.error('Scene3dService ensure failed:', e);
    }
    return null;
  }

  /** 关闭 3D 窗口时调用：终止进程、卸载模型 */
  static async release(): Promise<{ ok: boolean; status?: string }> {
    try {
      const res = await fetch('/api/scene3d/release', { method: 'POST' });
      if (res.ok) return await res.json();
    } catch (e) {
      console.error('Scene3dService release failed:', e);
    }
    return { ok: false };
  }

  static async start(): Promise<{ ok: boolean; error?: string; status?: string }> {
    try {
      const res = await fetch('/api/scene3d/start', { method: 'POST' });
      if (res.ok) return await res.json();
    } catch (e) {
      console.error('Scene3dService start failed:', e);
    }
    return { ok: false };
  }

  static async stop(): Promise<{ ok: boolean; status?: string }> {
    try {
      const res = await fetch('/api/scene3d/stop', { method: 'POST' });
      if (res.ok) return await res.json();
    } catch (e) {
      console.error('Scene3dService stop failed:', e);
    }
    return { ok: false };
  }

  static async startDownload(): Promise<{ ok: boolean; downloadState?: Scene3dDownloadState }> {
    try {
      const res = await fetch('/api/scene3d/download', { method: 'POST' });
      if (res.ok) return await res.json();
    } catch (e) {
      console.error('Scene3dService startDownload failed:', e);
    }
    return { ok: false };
  }

  static async cancelDownload(): Promise<{ ok: boolean; downloadState?: Scene3dDownloadState }> {
    try {
      const res = await fetch('/api/scene3d/download/cancel', { method: 'POST' });
      if (res.ok) return await res.json();
    } catch (e) {
      console.error('Scene3dService cancelDownload failed:', e);
    }
    return { ok: false };
  }

  static async openModelsDir(): Promise<{ ok: boolean; path?: string }> {
    try {
      const res = await fetch('/api/scene3d/open-dir', { method: 'POST' });
      if (res.ok) return await res.json();
    } catch (e) {
      console.error('Scene3dService openModelsDir failed:', e);
    }
    return { ok: false };
  }
}


/**
 * 文件夹快速检索服务 API（EmbeddingGemma-2 int8 · ONNX Runtime 随包内置）。
 *
 * 与 3D / TTS 同一套生命周期约定：没有常驻进程，模型按需下载、开窗加载、关窗卸载；
 * 未加载时状态是 standby，设置卡片与状态栏都按这个口径显示。
 */
export interface FolderSearchServiceStatus {
  dir: string;
  installed: 'none' | 'text' | 'full';
  installedBytes: number;
  loaded: boolean;
  downloading: boolean;
  progress: { file: string; received: number; total: number; index: number; count: number } | null;
  status: string;
  running: boolean;
  runtimeReady: boolean;
  model: { ready: boolean; partial: boolean; name: string; sizeDesc: string };
  download: {
    active: boolean;
    progressPercent: number;
    currentFile: string;
    downloadedBytes: number;
    totalBytes: number;
  };
}

export class FolderSearchServiceAPI {
  static async getStatus(): Promise<FolderSearchServiceStatus | null> {
    try {
      const res = await fetch('/api/folder_index/model', { cache: 'no-store' });
      if (res.ok) return await res.json();
    } catch (e) {
      console.error('FolderSearchService getStatus failed:', e);
    }
    return null;
  }

  /** 手动下载模型（文本 + 视觉两段权重），后台跑，前端轮询 getStatus 看进度 */
  static async prepare(): Promise<FolderSearchServiceStatus | null> {
    try {
      const res = await fetch('/api/folder_index/model/prepare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ needVision: true }),
      });
      if (res.ok) return await res.json();
    } catch (e) {
      console.error('FolderSearchService prepare failed:', e);
    }
    return null;
  }

  /** 预加载模型（开窗时调用；失败不抛，窗口自己会提示） */
  static async load(): Promise<boolean> {
    try {
      const res = await fetch('/api/folder_index/model/load', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ needVision: true }),
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}
