import {
  ChatSession,
  AppSettings,
  ChatMessage,
  LocalProviderConfig,
  DeepSeekProviderConfig,
  ApiProvider,
  TtfProviderConfig,
  MferenceProviderConfig,
  CustomProviderConfig,
} from '../types/chat';
import { saveImageToDB, getImagesFromDB } from './imageStore';
import { uploadDataUrl } from '../utils/image';

const SESSIONS_KEY = 'tff_chat_sessions_v1';
const CURRENT_ID_KEY = 'tff_chat_current_id_v1';
const SETTINGS_KEY = 'tff_chat_settings_v1';
const DEEPSEEK_API_KEY_KEY = 'tff_deepseek_api_key_v1';

// Cross-window BroadcastChannel for instant real-time sync between Main and Spotlight windows
export const syncChannel =
  typeof BroadcastChannel !== 'undefined'
    ? new BroadcastChannel('tff_session_sync')
    : null;

export function notifySessionUpdate(sessionId?: string, source: string = 'UNKNOWN'): void {
  try {
    syncChannel?.postMessage({ type: 'SESSIONS_CHANGED', sessionId, source });
  } catch (e) {
    console.error('BroadcastChannel postMessage error:', e);
  }
}

export function notifySettingsUpdate(): void {
  try {
    syncChannel?.postMessage({ type: 'SETTINGS_CHANGED' });
  } catch (e) {
    console.error('BroadcastChannel postMessage error:', e);
  }
}

/** TTF (TurboFieldfare / Gemma 4) 专属默认独立配置 */
export const DEFAULT_TTF_CONFIG: TtfProviderConfig = {
  apiPort: 1235,
  apiBaseUrl: '',
  modelId: 'gemma-4-26b-a4b-it',
  maxContext: 16384, // 16K default
  maxTokens: 8192, // Linked: half of maxContext (16384 / 2)
  temperature: 1.0, // Gemma 4 26B-A4B official recommended default
  topP: 0.95,
  topK: 64,
  repetitionPenalty: 1.0,
  reasoningEffort: 'default',
  seed: undefined,
  stopStrings: [],
  systemPrompt: 'You are a helpful assistant.',
};

/** Mference (Qwen 3.6 35B-A3B) 专属默认独立配置（依照官方推荐参数） */
export const DEFAULT_MFERENCE_CONFIG: MferenceProviderConfig = {
  apiPort: 1241,
  apiBaseUrl: '',
  modelId: 'qwen3.6-35b-a3b',
  maxContext: 16384, // 16K default
  maxTokens: 8192, // Linked: half of maxContext
  temperature: 1.0, // 官方推荐 1.0
  topP: 0.95, // 官方推荐 0.95
  topK: 20, // 官方推荐 20
  minP: 0.0, // 官方推荐 0.0
  presencePenalty: 1.5, // 官方推荐 1.5
  repetitionPenalty: 1.0, // 官方推荐 1.0
  reasoningEffort: 'low', // 本地运行默认 low，兼顾质量与生成耗时
  seed: undefined,
  stopStrings: [],
  systemPrompt: '', // 官方推荐置空
};

/** 自定义 (Custom / OpenAI 兼容) 极简默认独立配置 */
export const DEFAULT_CUSTOM_CONFIG: CustomProviderConfig = {
  apiPort: 11434, // Ollama 默认
  apiBaseUrl: '',
  modelId: 'llama3',
  maxContext: 8192,
  maxTokens: 4096,
  temperature: 0.7,
  systemPrompt: 'You are a helpful assistant.',
};

/** 本地引擎默认独立配置 (向后兼容保留) */
export const DEFAULT_LOCAL_CONFIG: LocalProviderConfig = {
  apiPort: 1235,
  apiBaseUrl: '',
  modelId: 'gemma-4-26b-a4b-it',
  maxContext: 16384,
  maxTokens: 8192,
  temperature: 1.0,
  topP: 0.95,
  topK: 64,
  repetitionPenalty: 1.0,
  seed: undefined,
  stopStrings: [],
  systemPrompt: 'You are a helpful assistant.',
};

/** DeepSeek 官方 API 默认独立配置（依照官网推荐参数） */
export const DEFAULT_DEEPSEEK_CONFIG: DeepSeekProviderConfig = {
  apiKey: '',
  baseUrl: 'https://api.deepseek.com',
  modelId: 'deepseek-flash', // 最新主力推荐模型
  maxContext: 131072, // 128K 推荐上下文
  maxTokens: 8192, // DeepSeek 官方单次补全上限/推荐默认 8K
  temperature: 1.0, // 官网默认值 1.0（思考建议 0.6 / 代码 0.0 / 翻译 1.3 / 创意 1.5）
  topP: 1.0, // 官网默认值 1.0（思考模式有效范围 0.95 - 1.0）
  reasoningEffort: 'high', // 深度思考推荐默认 high
  seed: undefined,
  stopStrings: [],
  systemPrompt: '', // 官方推荐零样本直接提问，默认空提示词
};

export const DEFAULT_SETTINGS: AppSettings = {
  apiProvider: 'ttf',
  ttfConfig: { ...DEFAULT_TTF_CONFIG },
  mferenceConfig: { ...DEFAULT_MFERENCE_CONFIG },
  customConfig: { ...DEFAULT_CUSTOM_CONFIG },
  localConfig: { ...DEFAULT_LOCAL_CONFIG },
  deepseekConfig: { ...DEFAULT_DEEPSEEK_CONFIG },

  // 活跃状态扁平字段（默认与 TTF 引擎一致）
  apiPort: DEFAULT_TTF_CONFIG.apiPort,
  apiBaseUrl: DEFAULT_TTF_CONFIG.apiBaseUrl,
  modelId: DEFAULT_TTF_CONFIG.modelId,
  deepseekApiKey: DEFAULT_DEEPSEEK_CONFIG.apiKey,
  deepseekModelId: DEFAULT_DEEPSEEK_CONFIG.modelId,
  deepseekBaseUrl: DEFAULT_DEEPSEEK_CONFIG.baseUrl,
  maxContext: DEFAULT_TTF_CONFIG.maxContext,
  enableThinking: false, // Default OFF
  reasoningEffort: 'high',
  temperature: DEFAULT_TTF_CONFIG.temperature,
  topP: DEFAULT_TTF_CONFIG.topP,
  topK: DEFAULT_TTF_CONFIG.topK,
  repetitionPenalty: DEFAULT_TTF_CONFIG.repetitionPenalty,
  maxTokens: DEFAULT_TTF_CONFIG.maxTokens,
  seed: undefined,
  stopStrings: [],
  systemPrompt: DEFAULT_TTF_CONFIG.systemPrompt,
  language: 'system',
  theme: 'system',
  enableWikiSearch: false, // Default OFF
  customWikiDir: '',
  spotlightResetMinutes: 15, // Default 15 minutes
};

export function loadSettings(): AppSettings {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(SETTINGS_KEY) : null;
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw);

    // 确定 provider
    let provider: ApiProvider = parsed?.apiProvider || 'ttf';
    if (provider === 'local') provider = 'ttf';
    if (!['ttf', 'mference', 'custom', 'deepseek'].includes(provider)) {
      provider = 'ttf';
    }

    // 1. TTF 配置 (优先读取 ttfConfig，平滑兼容旧 localConfig)
    const rawTtf = parsed?.ttfConfig || parsed?.localConfig || {};
    const ttfMaxContext = Number(
      rawTtf.maxContext ||
      (provider === 'ttf' ? parsed.maxContext : undefined) ||
      DEFAULT_TTF_CONFIG.maxContext
    );
    const ttfConfig: TtfProviderConfig = {
      ...DEFAULT_TTF_CONFIG,
      ...rawTtf,
      apiPort: rawTtf.apiPort || (parsed.apiPort && parsed.apiPort !== 1241 ? parsed.apiPort : DEFAULT_TTF_CONFIG.apiPort),
      apiBaseUrl: rawTtf.apiBaseUrl ?? DEFAULT_TTF_CONFIG.apiBaseUrl,
      modelId: rawTtf.modelId || (provider === 'ttf' ? parsed.modelId : undefined) || DEFAULT_TTF_CONFIG.modelId,
      maxContext: ttfMaxContext,
      maxTokens: Math.floor(ttfMaxContext / 2),
      temperature: rawTtf.temperature !== undefined ? Number(rawTtf.temperature) : DEFAULT_TTF_CONFIG.temperature,
      topP: rawTtf.topP !== undefined ? Number(rawTtf.topP) : DEFAULT_TTF_CONFIG.topP,
      topK: rawTtf.topK !== undefined ? Number(rawTtf.topK) : DEFAULT_TTF_CONFIG.topK,
      repetitionPenalty: rawTtf.repetitionPenalty !== undefined ? Number(rawTtf.repetitionPenalty) : DEFAULT_TTF_CONFIG.repetitionPenalty,
      reasoningEffort: rawTtf.reasoningEffort || 'default',
      seed: rawTtf.seed !== undefined ? Number(rawTtf.seed) : undefined,
      stopStrings: Array.isArray(rawTtf.stopStrings) ? rawTtf.stopStrings : [],
      systemPrompt: rawTtf.systemPrompt !== undefined ? rawTtf.systemPrompt : DEFAULT_TTF_CONFIG.systemPrompt,
    };

    // 2. Mference 配置
    const rawMference = parsed?.mferenceConfig || {};
    const mferenceMaxContext = Number(
      rawMference.maxContext ||
      (provider === 'mference' ? parsed.maxContext : undefined) ||
      DEFAULT_MFERENCE_CONFIG.maxContext
    );
    const mferenceConfig: MferenceProviderConfig = {
      ...DEFAULT_MFERENCE_CONFIG,
      ...rawMference,
      apiPort: rawMference.apiPort || (parsed.apiPort === 1241 ? 1241 : DEFAULT_MFERENCE_CONFIG.apiPort),
      apiBaseUrl: rawMference.apiBaseUrl ?? DEFAULT_MFERENCE_CONFIG.apiBaseUrl,
      modelId: rawMference.modelId || (provider === 'mference' ? parsed.modelId : undefined) || DEFAULT_MFERENCE_CONFIG.modelId,
      maxContext: mferenceMaxContext,
      maxTokens: Math.floor(mferenceMaxContext / 2),
      temperature: rawMference.temperature !== undefined ? Number(rawMference.temperature) : DEFAULT_MFERENCE_CONFIG.temperature,
      topP: rawMference.topP !== undefined ? Number(rawMference.topP) : DEFAULT_MFERENCE_CONFIG.topP,
      topK: rawMference.topK !== undefined ? Number(rawMference.topK) : DEFAULT_MFERENCE_CONFIG.topK,
      minP: rawMference.minP !== undefined ? Number(rawMference.minP) : DEFAULT_MFERENCE_CONFIG.minP,
      presencePenalty: rawMference.presencePenalty !== undefined ? Number(rawMference.presencePenalty) : DEFAULT_MFERENCE_CONFIG.presencePenalty,
      repetitionPenalty: rawMference.repetitionPenalty !== undefined ? Number(rawMference.repetitionPenalty) : DEFAULT_MFERENCE_CONFIG.repetitionPenalty,
      reasoningEffort: rawMference.reasoningEffort || 'low',
      seed: rawMference.seed !== undefined ? Number(rawMference.seed) : undefined,
      stopStrings: Array.isArray(rawMference.stopStrings) ? rawMference.stopStrings : [],
      systemPrompt: rawMference.systemPrompt !== undefined ? rawMference.systemPrompt : DEFAULT_MFERENCE_CONFIG.systemPrompt,
    };

    // 3. Custom 配置
    const rawCustom = parsed?.customConfig || {};
    const customConfig: CustomProviderConfig = {
      ...DEFAULT_CUSTOM_CONFIG,
      ...rawCustom,
      apiPort: rawCustom.apiPort || (provider === 'custom' && parsed.apiPort ? parsed.apiPort : DEFAULT_CUSTOM_CONFIG.apiPort),
      apiBaseUrl: rawCustom.apiBaseUrl ?? (provider === 'custom' ? parsed.apiBaseUrl : DEFAULT_CUSTOM_CONFIG.apiBaseUrl),
      modelId: rawCustom.modelId || (provider === 'custom' ? parsed.modelId : undefined) || DEFAULT_CUSTOM_CONFIG.modelId,
      maxContext: Number(rawCustom.maxContext || (provider === 'custom' ? parsed.maxContext : undefined) || DEFAULT_CUSTOM_CONFIG.maxContext),
      maxTokens: Number(rawCustom.maxTokens || (provider === 'custom' ? parsed.maxTokens : undefined) || DEFAULT_CUSTOM_CONFIG.maxTokens),
      temperature: rawCustom.temperature !== undefined ? Number(rawCustom.temperature) : DEFAULT_CUSTOM_CONFIG.temperature,
      systemPrompt: rawCustom.systemPrompt !== undefined ? rawCustom.systemPrompt : DEFAULT_CUSTOM_CONFIG.systemPrompt,
    };

    // 4. DeepSeek 配置
    const rawDs = parsed?.deepseekConfig || {};
    const dsMaxContext = Number(
      rawDs.maxContext ||
      (provider === 'deepseek' ? parsed.maxContext : undefined) ||
      DEFAULT_DEEPSEEK_CONFIG.maxContext
    );
    const storedApiKey = typeof localStorage !== 'undefined' ? localStorage.getItem(DEEPSEEK_API_KEY_KEY) : null;
    const resolvedApiKey = (
      rawDs.apiKey ||
      parsed.deepseekApiKey ||
      storedApiKey ||
      DEFAULT_DEEPSEEK_CONFIG.apiKey
    ).trim();

    if (resolvedApiKey && typeof localStorage !== 'undefined') {
      try {
        localStorage.setItem(DEEPSEEK_API_KEY_KEY, resolvedApiKey);
      } catch {
        /* ignore */
      }
    }

    const deepseekConfig: DeepSeekProviderConfig = {
      ...DEFAULT_DEEPSEEK_CONFIG,
      ...rawDs,
      apiKey: resolvedApiKey,
      baseUrl: rawDs.baseUrl || parsed.deepseekBaseUrl || DEFAULT_DEEPSEEK_CONFIG.baseUrl,
      modelId: rawDs.modelId || (provider === 'deepseek' ? parsed.deepseekModelId || parsed.modelId : undefined) || DEFAULT_DEEPSEEK_CONFIG.modelId,
      maxContext: dsMaxContext,
      maxTokens: rawDs.maxTokens || DEFAULT_DEEPSEEK_CONFIG.maxTokens,
      temperature: rawDs.temperature !== undefined ? Number(rawDs.temperature) : DEFAULT_DEEPSEEK_CONFIG.temperature,
      topP: rawDs.topP !== undefined ? Number(rawDs.topP) : DEFAULT_DEEPSEEK_CONFIG.topP,
      reasoningEffort: rawDs.reasoningEffort || (provider === 'deepseek' ? parsed.reasoningEffort : undefined) || DEFAULT_DEEPSEEK_CONFIG.reasoningEffort,
      seed: rawDs.seed !== undefined ? Number(rawDs.seed) : undefined,
      stopStrings: Array.isArray(rawDs.stopStrings) ? rawDs.stopStrings : [],
      systemPrompt: rawDs.systemPrompt !== undefined ? rawDs.systemPrompt : DEFAULT_DEEPSEEK_CONFIG.systemPrompt,
    };

    // 5. 投影活跃配置到扁平字段
    let activePort = ttfConfig.apiPort;
    let activeBaseUrl = ttfConfig.apiBaseUrl || '';
    let activeModel = ttfConfig.modelId;
    let activeMaxContext = ttfConfig.maxContext;
    let activeMaxTokens = ttfConfig.maxTokens;
    let activeTemp = ttfConfig.temperature;
    let activeTopP = ttfConfig.topP;
    let activeTopK: number | undefined = ttfConfig.topK;
    let activeMinP: number | undefined = undefined;
    let activePresencePenalty: number | undefined = undefined;
    let activeRepPenalty: number | undefined = ttfConfig.repetitionPenalty;
    let activeReasoning = ttfConfig.reasoningEffort || 'default';
    let activeSeed: number | undefined = ttfConfig.seed;
    let activeStopStrings = ttfConfig.stopStrings;
    let activeSystemPrompt = ttfConfig.systemPrompt;

    if (provider === 'mference') {
      activePort = mferenceConfig.apiPort;
      activeBaseUrl = mferenceConfig.apiBaseUrl || '';
      activeModel = mferenceConfig.modelId;
      activeMaxContext = mferenceConfig.maxContext;
      activeMaxTokens = mferenceConfig.maxTokens;
      activeTemp = mferenceConfig.temperature;
      activeTopP = mferenceConfig.topP;
      activeTopK = mferenceConfig.topK;
      activeMinP = mferenceConfig.minP;
      activePresencePenalty = mferenceConfig.presencePenalty;
      activeRepPenalty = mferenceConfig.repetitionPenalty;
      activeReasoning = mferenceConfig.reasoningEffort || 'low';
      activeSeed = mferenceConfig.seed;
      activeStopStrings = mferenceConfig.stopStrings || [];
      activeSystemPrompt = mferenceConfig.systemPrompt;
    } else if (provider === 'custom') {
      activePort = customConfig.apiPort;
      activeBaseUrl = customConfig.apiBaseUrl || '';
      activeModel = customConfig.modelId;
      activeMaxContext = customConfig.maxContext;
      activeMaxTokens = customConfig.maxTokens;
      activeTemp = customConfig.temperature;
      activeTopP = 1.0;
      activeReasoning = 'high';
      activeSystemPrompt = customConfig.systemPrompt;
      activeTopK = undefined;
      activeRepPenalty = undefined;
      activeSeed = undefined;
      activeStopStrings = [];
    } else if (provider === 'deepseek') {
      activeBaseUrl = deepseekConfig.baseUrl;
      activeModel = deepseekConfig.modelId;
      activeMaxContext = deepseekConfig.maxContext;
      activeMaxTokens = deepseekConfig.maxTokens;
      activeTemp = deepseekConfig.temperature;
      activeTopP = deepseekConfig.topP;
      activeReasoning = deepseekConfig.reasoningEffort;
      activeSeed = deepseekConfig.seed;
      activeStopStrings = deepseekConfig.stopStrings;
      activeSystemPrompt = deepseekConfig.systemPrompt;
      activeTopK = undefined;
      activeRepPenalty = undefined;
    }

    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      apiProvider: provider,
      ttfConfig,
      mferenceConfig,
      customConfig,
      deepseekConfig,
      localConfig: ttfConfig as any, // 兼容旧代码

      // 投影活跃配置
      apiPort: activePort,
      apiBaseUrl: activeBaseUrl,
      deepseekApiKey: resolvedApiKey,
      deepseekModelId: deepseekConfig.modelId,
      deepseekBaseUrl: deepseekConfig.baseUrl,

      modelId: activeModel,
      maxContext: activeMaxContext,
      maxTokens: activeMaxTokens,
      temperature: activeTemp,
      topP: activeTopP,
      topK: activeTopK,
      minP: activeMinP,
      presencePenalty: activePresencePenalty,
      repetitionPenalty: activeRepPenalty,
      reasoningEffort: activeReasoning,
      seed: activeSeed,
      stopStrings: activeStopStrings,
      systemPrompt: activeSystemPrompt,

      language: parsed?.language || 'system',
      theme: parsed?.theme || 'system',
      enableThinking: parsed?.enableThinking !== undefined ? parsed.enableThinking : false,
      enableWikiSearch: parsed?.enableWikiSearch !== undefined ? parsed.enableWikiSearch : false,
      customWikiDir: parsed?.customWikiDir || '',
      spotlightResetMinutes: parsed?.spotlightResetMinutes !== undefined ? Number(parsed.spotlightResetMinutes) : 15,
    };
  } catch (e) {
    console.error('Failed to load settings from localStorage:', e);
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(settings: AppSettings): void {
  try {
    let provider: ApiProvider = settings.apiProvider || 'ttf';
    if (provider === 'local') provider = 'ttf';
    if (!['ttf', 'mference', 'custom', 'deepseek'].includes(provider)) {
      provider = 'ttf';
    }

    // 1. 读取已有存储，确保无论当前是哪个 provider，各套配置与 API Key 永不丢失
    const rawExisting = typeof localStorage !== 'undefined' ? localStorage.getItem(SETTINGS_KEY) : null;
    const existing = rawExisting ? JSON.parse(rawExisting) : {};
    const existingTtf = existing.ttfConfig || existing.localConfig || {};
    const existingMference = existing.mferenceConfig || {};
    const existingCustom = existing.customConfig || {};
    const existingDs = existing.deepseekConfig || {};
    const storedApiKey = typeof localStorage !== 'undefined' ? localStorage.getItem(DEEPSEEK_API_KEY_KEY) : null;

    const incomingKey = (
      settings.deepseekConfig?.apiKey?.trim() ||
      settings.deepseekApiKey?.trim() ||
      ''
    );

    const effectiveApiKey = (
      incomingKey ||
      existingDs.apiKey ||
      existing.deepseekApiKey ||
      storedApiKey ||
      ''
    ).trim();

    if (effectiveApiKey && typeof localStorage !== 'undefined') {
      try {
        localStorage.setItem(DEEPSEEK_API_KEY_KEY, effectiveApiKey);
      } catch {
        /* ignore */
      }
    }

    // 2. 组装各套独立配置
    const ttfConfig: TtfProviderConfig = {
      ...DEFAULT_TTF_CONFIG,
      ...existingTtf,
      ...(settings.ttfConfig || {}),
    };

    const mferenceConfig: MferenceProviderConfig = {
      ...DEFAULT_MFERENCE_CONFIG,
      ...existingMference,
      ...(settings.mferenceConfig || {}),
    };

    const customConfig: CustomProviderConfig = {
      ...DEFAULT_CUSTOM_CONFIG,
      ...existingCustom,
      ...(settings.customConfig || {}),
    };

    const deepseekConfig: DeepSeekProviderConfig = {
      ...DEFAULT_DEEPSEEK_CONFIG,
      ...existingDs,
      ...(settings.deepseekConfig || {}),
      apiKey: effectiveApiKey,
    };
    if (settings.deepseekBaseUrl !== undefined) deepseekConfig.baseUrl = settings.deepseekBaseUrl;
    if (settings.deepseekModelId !== undefined) deepseekConfig.modelId = settings.deepseekModelId;

    // 3. 活跃提供商的扁平值回写
    if (provider === 'ttf') {
      if (settings.apiPort !== undefined) ttfConfig.apiPort = settings.apiPort;
      if (settings.apiBaseUrl !== undefined) ttfConfig.apiBaseUrl = settings.apiBaseUrl;
      if (settings.modelId !== undefined) ttfConfig.modelId = settings.modelId;
      if (settings.maxContext !== undefined) {
        ttfConfig.maxContext = settings.maxContext;
        ttfConfig.maxTokens = Math.floor(settings.maxContext / 2);
      }
      if (settings.temperature !== undefined) ttfConfig.temperature = settings.temperature;
      if (settings.topP !== undefined) ttfConfig.topP = settings.topP;
      if (settings.topK !== undefined) ttfConfig.topK = settings.topK;
      if (settings.repetitionPenalty !== undefined) ttfConfig.repetitionPenalty = settings.repetitionPenalty;
      if (settings.reasoningEffort !== undefined) ttfConfig.reasoningEffort = settings.reasoningEffort as any;
      if (settings.seed !== undefined) ttfConfig.seed = settings.seed;
      if (Array.isArray(settings.stopStrings)) ttfConfig.stopStrings = settings.stopStrings;
      if (settings.systemPrompt !== undefined) ttfConfig.systemPrompt = settings.systemPrompt;
    } else if (provider === 'mference') {
      if (settings.apiPort !== undefined) mferenceConfig.apiPort = settings.apiPort;
      if (settings.apiBaseUrl !== undefined) mferenceConfig.apiBaseUrl = settings.apiBaseUrl;
      if (settings.modelId !== undefined) mferenceConfig.modelId = settings.modelId;
      if (settings.maxContext !== undefined) {
        mferenceConfig.maxContext = settings.maxContext;
        mferenceConfig.maxTokens = Math.floor(settings.maxContext / 2);
      }
      if (settings.temperature !== undefined) mferenceConfig.temperature = settings.temperature;
      if (settings.topP !== undefined) mferenceConfig.topP = settings.topP;
      if (settings.topK !== undefined) mferenceConfig.topK = settings.topK;
      if (settings.minP !== undefined) mferenceConfig.minP = settings.minP;
      if (settings.presencePenalty !== undefined) mferenceConfig.presencePenalty = settings.presencePenalty;
      if (settings.repetitionPenalty !== undefined) mferenceConfig.repetitionPenalty = settings.repetitionPenalty;
      if (settings.reasoningEffort !== undefined) mferenceConfig.reasoningEffort = settings.reasoningEffort as any;
      if (settings.seed !== undefined) mferenceConfig.seed = settings.seed;
      if (Array.isArray(settings.stopStrings)) mferenceConfig.stopStrings = settings.stopStrings;
      if (settings.systemPrompt !== undefined) mferenceConfig.systemPrompt = settings.systemPrompt;
    } else if (provider === 'custom') {
      if (settings.apiPort !== undefined) customConfig.apiPort = settings.apiPort;
      if (settings.apiBaseUrl !== undefined) customConfig.apiBaseUrl = settings.apiBaseUrl;
      if (settings.modelId !== undefined) customConfig.modelId = settings.modelId;
      if (settings.maxContext !== undefined) customConfig.maxContext = settings.maxContext;
      if (settings.maxTokens !== undefined) customConfig.maxTokens = settings.maxTokens;
      if (settings.temperature !== undefined) customConfig.temperature = settings.temperature;
      if (settings.systemPrompt !== undefined) customConfig.systemPrompt = settings.systemPrompt;
    } else if (provider === 'deepseek') {
      if (settings.maxContext !== undefined) deepseekConfig.maxContext = settings.maxContext;
      if (settings.maxTokens !== undefined) deepseekConfig.maxTokens = settings.maxTokens;
      if (settings.temperature !== undefined) deepseekConfig.temperature = settings.temperature;
      if (settings.topP !== undefined) deepseekConfig.topP = settings.topP;
      if (settings.reasoningEffort !== undefined) deepseekConfig.reasoningEffort = settings.reasoningEffort as any;
      if (settings.seed !== undefined) deepseekConfig.seed = settings.seed;
      if (Array.isArray(settings.stopStrings)) deepseekConfig.stopStrings = settings.stopStrings;
      if (settings.systemPrompt !== undefined) deepseekConfig.systemPrompt = settings.systemPrompt;
    }

    // 4. 计算当前活跃扁平值
    let activePort = ttfConfig.apiPort;
    let activeBaseUrl = ttfConfig.apiBaseUrl || '';
    let activeModel = ttfConfig.modelId;
    let activeMaxContext = ttfConfig.maxContext;
    let activeMaxTokens = ttfConfig.maxTokens;
    let activeTemp = ttfConfig.temperature;
    let activeTopP = ttfConfig.topP;
    let activeTopK: number | undefined = ttfConfig.topK;
    let activeMinP: number | undefined = undefined;
    let activePresencePenalty: number | undefined = undefined;
    let activeRepPenalty: number | undefined = ttfConfig.repetitionPenalty;
    let activeReasoning = ttfConfig.reasoningEffort || 'default';
    let activeSeed: number | undefined = ttfConfig.seed;
    let activeStopStrings: string[] = ttfConfig.stopStrings;
    let activeSystemPrompt = ttfConfig.systemPrompt;

    if (provider === 'mference') {
      activePort = mferenceConfig.apiPort;
      activeBaseUrl = mferenceConfig.apiBaseUrl || '';
      activeModel = mferenceConfig.modelId;
      activeMaxContext = mferenceConfig.maxContext;
      activeMaxTokens = mferenceConfig.maxTokens;
      activeTemp = mferenceConfig.temperature;
      activeTopP = mferenceConfig.topP;
      activeTopK = mferenceConfig.topK;
      activeMinP = mferenceConfig.minP;
      activePresencePenalty = mferenceConfig.presencePenalty;
      activeRepPenalty = mferenceConfig.repetitionPenalty;
      activeReasoning = mferenceConfig.reasoningEffort || 'low';
      activeSeed = mferenceConfig.seed;
      activeStopStrings = mferenceConfig.stopStrings || [];
      activeSystemPrompt = mferenceConfig.systemPrompt;
    } else if (provider === 'custom') {
      activePort = customConfig.apiPort;
      activeBaseUrl = customConfig.apiBaseUrl || '';
      activeModel = customConfig.modelId;
      activeMaxContext = customConfig.maxContext;
      activeMaxTokens = customConfig.maxTokens;
      activeTemp = customConfig.temperature;
      activeTopP = 1.0;
      activeReasoning = 'high';
      activeSystemPrompt = customConfig.systemPrompt;
      activeTopK = undefined;
      activeRepPenalty = undefined;
      activeSeed = undefined;
      activeStopStrings = [];
    } else if (provider === 'deepseek') {
      activeBaseUrl = deepseekConfig.baseUrl;
      activeModel = deepseekConfig.modelId;
      activeMaxContext = deepseekConfig.maxContext;
      activeMaxTokens = deepseekConfig.maxTokens;
      activeTemp = deepseekConfig.temperature;
      activeTopP = deepseekConfig.topP;
      activeReasoning = deepseekConfig.reasoningEffort;
      activeSeed = deepseekConfig.seed;
      activeStopStrings = deepseekConfig.stopStrings;
      activeSystemPrompt = deepseekConfig.systemPrompt;
      activeTopK = undefined;
      activeRepPenalty = undefined;
    }

    const sanitized: AppSettings = {
      ...DEFAULT_SETTINGS,
      ...settings,
      apiProvider: provider,
      ttfConfig,
      mferenceConfig,
      customConfig,
      deepseekConfig,
      localConfig: ttfConfig as any,

      // 投影活跃配置
      apiPort: activePort,
      apiBaseUrl: activeBaseUrl,
      deepseekApiKey: effectiveApiKey,
      deepseekModelId: deepseekConfig.modelId,
      deepseekBaseUrl: deepseekConfig.baseUrl,

      modelId: activeModel,
      maxContext: activeMaxContext,
      maxTokens: activeMaxTokens,
      temperature: activeTemp,
      topP: activeTopP,
      topK: activeTopK,
      minP: activeMinP,
      presencePenalty: activePresencePenalty,
      repetitionPenalty: activeRepPenalty,
      reasoningEffort: activeReasoning,
      seed: activeSeed,
      stopStrings: activeStopStrings,
      systemPrompt: activeSystemPrompt,

      language: settings?.language || 'system',
      theme: settings?.theme || 'system',
      enableThinking: settings?.enableThinking !== undefined ? settings.enableThinking : false,
      enableWikiSearch: settings?.enableWikiSearch !== undefined ? settings.enableWikiSearch : false,
      customWikiDir: settings?.customWikiDir || '',
      spotlightResetMinutes: settings?.spotlightResetMinutes !== undefined ? Number(settings.spotlightResetMinutes) : 15,
    };

    localStorage.setItem(SETTINGS_KEY, JSON.stringify(sanitized));
    notifySettingsUpdate();
  } catch (e) {
    console.error('Failed to save settings:', e);
  }
}

export function loadSessions(): ChatSession[] {
  try {
    const raw = localStorage.getItem(SESSIONS_KEY);
    if (!raw) {
      const initial = createNewSession();
      saveSessions([initial]);
      saveCurrentSessionId(initial.id);
      return [initial];
    }
    const list = JSON.parse(raw);
    if (!Array.isArray(list) || list.length === 0) {
      const initial = createNewSession();
      saveSessions([initial]);
      saveCurrentSessionId(initial.id);
      return [initial];
    }
    // Guarantee loaded history messages never remain in an active thinking/spinning state
    const mapped = list.map((session) => {
      let title = session?.title;
      if (
        (!title || title === '新对话' || title === 'New Chat') &&
        Array.isArray(session?.messages) &&
        session.messages.length > 0
      ) {
        title = deriveSessionTitleFromMessages(session.messages, title || '新对话');
      }
      return {
        ...session,
        title: title || '新对话',
        enableThinking: session?.enableThinking ?? false,
        enableWikiSearch: session?.enableWikiSearch ?? false,
        messages: Array.isArray(session?.messages)
          ? session.messages.map((m: any) => ({
              ...m,
              isThinking: false,
            }))
          : [],
      };
    });

    const hasLegacyImages = mapped.some((s) =>
      s.messages?.some((m: ChatMessage) => m.images?.some((img: string) => img.startsWith('data:')))
    );
    if (hasLegacyImages) {
      scheduleLegacyImageMigration(mapped);
    }

    return mapped;
  } catch (e) {
    console.error('Failed to load sessions:', e);
    const initial = createNewSession();
    saveSessions([initial]);
    saveCurrentSessionId(initial.id);
    return [initial];
  }
}

/**
 * Asynchronously migrates legacy inline Data URLs to the local media store
 */
let migrationScheduled = false;
export function scheduleLegacyImageMigration(sessions: ChatSession[]): void {
  if (migrationScheduled) return;
  migrationScheduled = true;
  setTimeout(async () => {
    let hasChanges = false;
    for (const session of sessions) {
      if (!session.messages) continue;
      for (const msg of session.messages) {
        if (!msg.images || msg.images.length === 0) continue;
        for (let i = 0; i < msg.images.length; i++) {
          const img = msg.images[i];
          if (img.startsWith('data:')) {
            try {
              const url = await uploadDataUrl(img);
              if (url && url !== img) {
                msg.images[i] = url;
                hasChanges = true;
              }
            } catch (err) {
              // ignore
            }
          }
        }
      }
    }
    if (hasChanges) {
      console.log('[storage] Migrated legacy data URLs to local media store');
      saveSessions(sessions);
    }
    migrationScheduled = false;
  }, 1000);
}

/**
 * Asynchronously persist all image Data URLs to IndexedDB for permanent durability
 */
function persistImagesToIndexedDB(sessions: ChatSession[]): void {
  for (const session of sessions) {
    if (!session.messages) continue;
    for (const msg of session.messages) {
      if (!msg.images || msg.images.length === 0) continue;
      msg.images.forEach((imgUrl, idx) => {
        if (imgUrl.startsWith('data:')) {
          const key = `img_${session.id}_${msg.id}_${idx}`;
          saveImageToDB(key, imgUrl).catch(() => {});
        }
      });
    }
  }
}

function offloadOlderImagesForStorage(sessions: ChatSession[], updatedSessionId?: string): ChatSession[] {
  return sessions.map((session) => {
    const isTarget = updatedSessionId ? session.id === updatedSessionId : false;
    return {
      ...session,
      messages: session.messages.map((m, msgIdx) => {
        if (!m.images || m.images.length === 0) return m;
        // Keep actual images for the most recent message in the active session
        if (isTarget && msgIdx >= session.messages.length - 2) {
          return m;
        }
        return {
          ...m,
          images: m.images.map((img, idx) =>
            img.startsWith('data:') ? `__idb__:img_${session.id}_${m.id}_${idx}` : img
          ),
        };
      }),
    };
  });
}

function stripAllImagesForStorage(sessions: ChatSession[]): ChatSession[] {
  return sessions.map((session) => ({
    ...session,
    messages: session.messages.map((m) => {
      if (!m.images || m.images.length === 0) return m;
      return {
        ...m,
        images: m.images.map((img, idx) =>
          img.startsWith('data:') ? `__idb__:img_${session.id}_${m.id}_${idx}` : img
        ),
      };
    }),
  }));
}

export async function hydrateSessionImages(session: ChatSession): Promise<boolean> {
  let changed = false;
  if (!session.messages) return false;
  const keysToFetch: { msgIdx: number; imgIdx: number; key: string }[] = [];
  session.messages.forEach((m, msgIdx) => {
    if (!m.images) return;
    m.images.forEach((img, imgIdx) => {
      if (img.startsWith('__idb__:')) {
        keysToFetch.push({ msgIdx, imgIdx, key: img.slice(8) });
      }
    });
  });
  if (keysToFetch.length === 0) return false;
  const dbImages = await getImagesFromDB(keysToFetch.map((k) => k.key));
  for (const item of keysToFetch) {
    const dataUrl = dbImages[item.key];
    if (dataUrl && session.messages[item.msgIdx]?.images) {
      session.messages[item.msgIdx].images![item.imgIdx] = dataUrl;
      changed = true;
    }
  }
  return changed;
}

export function saveSessions(sessions: ChatSession[], updatedSessionId?: string, source: string = 'UNKNOWN'): void {
  const safeSessions = sessions.length > 0 ? sessions : [createNewSession()];

  // 1. Durably backup all images in IndexedDB asynchronously
  persistImagesToIndexedDB(safeSessions);

  // 2. Direct save attempt to localStorage
  try {
    localStorage.setItem(SESSIONS_KEY, JSON.stringify(safeSessions));
    notifySessionUpdate(updatedSessionId, source);
    return;
  } catch (e) {
    console.warn('[storage] Direct localStorage save failed (quota exceeded), offloading older images...', e);
  }

  // 3. Fallback: offload older images to IndexedDB keys, preserving recent messages
  try {
    const stripped = offloadOlderImagesForStorage(safeSessions, updatedSessionId);
    localStorage.setItem(SESSIONS_KEY, JSON.stringify(stripped));
    notifySessionUpdate(updatedSessionId, source);
    return;
  } catch (e2) {
    console.warn('[storage] Secondary save failed, stripping all images from localStorage payload...', e2);
  }

  // 4. Ultimate fallback: strip all images to guarantee text sessions and titles are never lost
  try {
    const textOnly = stripAllImagesForStorage(safeSessions);
    localStorage.setItem(SESSIONS_KEY, JSON.stringify(textOnly));
    notifySessionUpdate(updatedSessionId, source);
  } catch (e3) {
    console.error('[storage] Fatal localStorage write error:', e3);
  }
}

/**
 * 跨窗口「请求中止本轮生成」。
 *
 * 为什么要走 localStorage 而不是 BroadcastChannel：主窗口与浮窗是**两个独立 WKWebView**，
 * BroadcastChannel 不一定跨实例投递（实测镜像能看到内容靠的是落盘 + storage 事件，
 * 不是 BroadcastChannel）。storage 事件在同源的其他浏览上下文里必定触发，因此用它传播中止请求。
 * 发起方与接收方是不同窗口，`storage` 事件不会在写入方自己触发，正好。
 */
const ABORT_KEY = 'tff_abort_request_v1';

export function requestAbort(sessionId: string): void {
  try {
    localStorage.setItem(ABORT_KEY, JSON.stringify({ sessionId, at: Date.now() }));
  } catch {
    // 写失败不影响
  }
}

export function readAbortRequest(): { sessionId: string; at: number } | null {
  try {
    const raw = localStorage.getItem(ABORT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed.sessionId === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * 清理「被中断的回合」残留的 pending 标记。
 *
 * 场景：生成中被退出 App / 强杀进程，`pending: true` 会随消息落盘；下次打开时
 * 没有任何窗口在生成，若不清掉，阶段阶梯会一直停在"展开 + 转圈"的假进行中状态。
 * 只在**App 启动时**（主窗口首次装载会话）调用一次 —— 生成中的会话不能清
 * （浮窗会在回合进行中反复 loadSessions 做持久化，那里清掉会把真实进行中的状态抹掉）。
 *
 * @returns 是否发生了修改（发生了就应回写 + 广播）
 */
export function clearStalePending(sessions: ChatSession[]): boolean {
  let changed = false;
  for (const s of sessions) {
    for (const m of s.messages) {
      if (m.pending || m.isThinking || m.stage) {
        m.pending = false;
        m.isThinking = false;
        delete m.stage;
        changed = true;
      }
    }
  }
  return changed;
}

export function loadCurrentSessionId(): string | null {
  return localStorage.getItem(CURRENT_ID_KEY);
}

export function saveCurrentSessionId(id: string | null): void {
  try {
    if (id) {
      localStorage.setItem(CURRENT_ID_KEY, id);
    } else {
      localStorage.removeItem(CURRENT_ID_KEY);
    }
    notifySessionUpdate(id || undefined);
  } catch (e) {
    console.error('Failed to save current session ID:', e);
  }
}

export function createNewSession(title?: string): ChatSession {
  let defaultTitle = '新对话';
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) {
      const s = JSON.parse(raw);
      if (s?.language === 'en') {
        defaultTitle = 'New Chat';
      } else if (s?.language === 'system') {
        if (typeof navigator !== 'undefined' && navigator.language && !navigator.language.toLowerCase().startsWith('zh')) {
          defaultTitle = 'New Chat';
        }
      }
    }
  } catch (e) {}

  return {
    id: 'session-' + Date.now() + '-' + Math.random().toString(36).substring(2, 7),
    title: title || defaultTitle,
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    contextUsed: 0,
    enableThinking: false,   // Default OFF
    enableWikiSearch: false, // Default OFF
  };
}

/**
 * 查找已存在的空会话，若无则新建一个空白会话。
 * 主窗口（新建对话）与 Spotlight 浮窗（初始化/刷新/点击新建）完全复用该逻辑：
 * 如果已经有空会话就不新建，直接切换过去。
 */
export function getOrCreateEmptySession(
  title?: string,
  source: string = 'UNKNOWN'
): { session: ChatSession; isNew: boolean; allSessions: ChatSession[] } {
  const allSessions = loadSessions();
  const existingEmpty = allSessions.find((s) => !s.messages || s.messages.length === 0);
  if (existingEmpty) {
    saveCurrentSessionId(existingEmpty.id);
    return { session: existingEmpty, isNew: false, allSessions };
  }
  const newSession = createNewSession(title);
  const nextSessions = [newSession, ...allSessions];
  saveSessions(nextSessions, newSession.id, source);
  saveCurrentSessionId(newSession.id);
  notifySessionUpdate(newSession.id, source);
  return { session: newSession, isNew: true, allSessions: nextSessions };
}

/**
 * 根据发送消息的文本与图片生成会话标题。
 * 规则：
 * 1. 取文字部分（换行转空格，截取前 24 字符）；
 * 2. 如果只有图片（文字为空但图片数量 > 0），标题为 '[picture]'；
 * 3. 否则回退为默认标题（如 '新对话' 或 'New Chat'）。
 */
export function generateSessionTitle(
  text: string,
  hasImages: boolean = false,
  fallbackTitle: string = '新对话'
): string {
  const singleLineText = (text || '').replace(/\r?\n/g, ' ').trim();
  if (singleLineText) {
    return singleLineText.slice(0, 24);
  }
  if (hasImages) {
    return '[picture]';
  }
  return fallbackTitle;
}

/**
 * 从消息列表中提取首条用户消息并生成会话标题。
 */
export function deriveSessionTitleFromMessages(
  messages: ChatMessage[],
  fallbackTitle: string = '新对话'
): string {
  if (!Array.isArray(messages)) return fallbackTitle;
  const firstUser = messages.find((m) => m.role === 'user');
  if (!firstUser) return fallbackTitle;
  const hasImages = Array.isArray(firstUser.images) && firstUser.images.length > 0;
  return generateSessionTitle(firstUser.content, hasImages, fallbackTitle);
}


