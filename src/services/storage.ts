import {
  ChatSession,
  AppSettings,
  ChatMessage,
  LocalProviderConfig,
  DeepSeekProviderConfig,
  ApiProvider,
  TtfProviderConfig,
  MferenceProviderConfig,
  MapleProviderConfig,
  QwenQaProviderConfig,
  CustomProviderConfig,
} from '../types/chat';

const SETTINGS_KEY = 'tff_chat_settings_v1';
const DEEPSEEK_API_KEY_KEY = 'tff_deepseek_api_key_v1';

// Cross-window BroadcastChannel for instant real-time sync of settings between Main and Spotlight windows
export const syncChannel =
  typeof BroadcastChannel !== 'undefined'
    ? new BroadcastChannel('tff_session_sync')
    : null;

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

/** Maple MLX 默认配置（与 mlx_lm.server 默认参数一致） */
export const DEFAULT_MAPLE_CONFIG: MapleProviderConfig = {
  apiPort: 1242,
  apiBaseUrl: '',
  modelId: 'default_model',
  maxContext: 16384,
  maxTokens: 8192, // 恒为 maxContext 的 50%（与 TTF / Mference 同一规则），见 normalize
  // 官方/社区推荐采样参数（2026-11；DRY 采样 mlx_lm 运行时不支持，未采用）
  temperature: 1.0,
  topP: 0.95,
  topK: 40,
  minP: 0.05,
  presencePenalty: 0,
  repetitionPenalty: 1.15,
  seed: undefined,
  stopStrings: [],
  systemPrompt: '',
};

/**
 * Qwen 3.5 9B 问答引擎（mlx_lm.server，默认端口 1243）。
 *
 * 与 Maple 的差别只在「思考默认关」与采样默认值：这是通用问答引擎，不追求推理链，
 * 所以 maxTokens 不需要为隐藏思考预留（4096 就是可见答案）。
 */
export const DEFAULT_QWEN_QA_CONFIG: QwenQaProviderConfig = {
  apiPort: 1243,
  apiBaseUrl: '',
  // mlx_lm.server 的 /v1/models 只回权重目录路径，且**不校验**请求里的 model 字段，
  // 所以这里直接用可读名字：它只是给界面看的标签，不会影响推理。
  modelId: 'Qwen 3.5 9B',
  maxContext: 16384,
  maxTokens: 4096,
  // 官方 README「Instruct / 非思考模式 · 通用任务」推荐值（2026-11 核实）：
  // temperature=0.7, top_p=0.8, top_k=20, min_p=0.0, presence_penalty=1.5, repetition_penalty=1.0
  temperature: 0.7,
  topP: 0.8,
  topK: 20,
  minP: 0,
  presencePenalty: 1.5,
  repetitionPenalty: 1.0,
  seed: undefined,
  stopStrings: [],
  systemPrompt: '',
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
  maxTokens: 65536, // Linked: half of maxContext (131072 / 2)
  temperature: 1.0, // 官网默认值 1.0（思考建议 0.6 / 代码 0.0 / 翻译 1.3 / 创意 1.5）
  topP: 1.0, // 官网默认值 1.0（思考模式有效范围 0.95 - 1.0）
  reasoningEffort: 'high', // 深度思考推荐默认 high
  seed: undefined,
  stopStrings: [],
  systemPrompt: '', // 官方推荐零样本直接提问，默认空提示词
};

/**
 * 快捷翻译 → 原生悬浮窗的唯一配置投影。
 *
 * 快捷翻译的模型选择、密钥、提示词、采样参数全部收归「服务控制面板 → 快速翻译服务」
 * （服务端 translate_config.json），前端不再持有任何翻译模型配置。
 * 这里只把原生侧固定指向本机网关：由网关按 mode 决定走字幕翻译小模型还是 DeepSeek / 基础模型。
 */
export const TRANSLATOR_GATEWAY_ENDPOINT = 'http://127.0.0.1:31235/api/translate/v1';

export function buildTranslatorGatewayPayload() {
  return {
    baseLang: 'zh',
    activeProvider: 'gateway',
    apiProvider: 'gateway',
    activeEndpoint: TRANSLATOR_GATEWAY_ENDPOINT,
    activeModel: 'simpleui-translate',
    activeApiKey: '',
    activeTemperature: 0.2,
    activeReasoningEffort: 'none',
  };
}

export const DEFAULT_SETTINGS: AppSettings = {
  apiProvider: 'ttf',
  ttfConfig: { ...DEFAULT_TTF_CONFIG },
  mferenceConfig: { ...DEFAULT_MFERENCE_CONFIG },
  mapleConfig: { ...DEFAULT_MAPLE_CONFIG },
  qwenQaConfig: { ...DEFAULT_QWEN_QA_CONFIG },
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

let memoryCachedSettings: AppSettings | null = null;

function clearLegacyWebKitSettings(): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.removeItem(SETTINGS_KEY);
    localStorage.removeItem(DEEPSEEK_API_KEY_KEY);
  } catch {
    /* ignore */
  }
}

export function normalizeSettingsObject(parsed: any, fallbackApiKey: string = ''): AppSettings {
  if (!parsed || typeof parsed !== 'object') {
    return { ...DEFAULT_SETTINGS };
  }

  // 确定 provider
  let provider: ApiProvider = parsed?.apiProvider || 'ttf';
  if (provider === 'local') provider = 'ttf';
  if (!['ttf', 'mference', 'maple', 'qwen-qa', 'custom', 'deepseek'].includes(provider)) {
    provider = 'ttf';
  }

  // 历史事故自愈（2026-11）：第 4 引擎刚上线时 saveSettings 的白名单漏了 'qwen-qa'，
  // 「选了 Qwen 3.5 9B」会被降级成 ttf，并把它的 1243 端口与 default_model 一起写进 TTF 配置。
  // 1243 是 Qwen 独占端口、TTF 永远是 1235 —— 据此识别，把配置原地纠正回来。
  const repairedFromQwen = provider === 'ttf' && Number(parsed?.ttfConfig?.apiPort) === 1243;
  if (repairedFromQwen) provider = 'qwen-qa';

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
    // 顶层 apiPort 只在「当前确实是 TTF」时作为兜底来源：
    // 否则把别的引擎端口（如 Maple 的 1242）带进 TTF 配置，切回 TTF 就打错端口。
    apiPort:
      rawTtf.apiPort ||
      (provider === 'ttf' && parsed.apiPort ? parsed.apiPort : DEFAULT_TTF_CONFIG.apiPort),
    apiBaseUrl: rawTtf.apiBaseUrl ?? DEFAULT_TTF_CONFIG.apiBaseUrl,
    modelId:
      rawTtf.modelId ||
      (provider === 'ttf' ? parsed.modelId : undefined) ||
      DEFAULT_TTF_CONFIG.modelId,
    maxContext: ttfMaxContext,
    maxTokens: Math.floor(ttfMaxContext / 2),
    temperature:
      rawTtf.temperature !== undefined ? Number(rawTtf.temperature) : DEFAULT_TTF_CONFIG.temperature,
    topP: rawTtf.topP !== undefined ? Number(rawTtf.topP) : DEFAULT_TTF_CONFIG.topP,
    topK: rawTtf.topK !== undefined ? Number(rawTtf.topK) : DEFAULT_TTF_CONFIG.topK,
    repetitionPenalty:
      rawTtf.repetitionPenalty !== undefined
        ? Number(rawTtf.repetitionPenalty)
        : DEFAULT_TTF_CONFIG.repetitionPenalty,
    reasoningEffort: rawTtf.reasoningEffort || 'default',
    seed: rawTtf.seed !== undefined ? Number(rawTtf.seed) : undefined,
    stopStrings: Array.isArray(rawTtf.stopStrings) ? rawTtf.stopStrings : [],
    systemPrompt:
      rawTtf.systemPrompt !== undefined ? rawTtf.systemPrompt : DEFAULT_TTF_CONFIG.systemPrompt,
  };

  // 上面识别出的污染：把 TTF 的端口/模型名恢复默认，避免切回 TTF 时打到 Qwen 的 1243
  if (repairedFromQwen) {
    ttfConfig.apiPort = DEFAULT_TTF_CONFIG.apiPort;
    if (!ttfConfig.modelId || ttfConfig.modelId === 'default_model' || ttfConfig.modelId.startsWith('/')) {
      ttfConfig.modelId = DEFAULT_TTF_CONFIG.modelId;
    }
  }

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
    apiPort:
      rawMference.apiPort ||
      (parsed.apiPort === 1241 ? 1241 : DEFAULT_MFERENCE_CONFIG.apiPort),
    apiBaseUrl: rawMference.apiBaseUrl ?? DEFAULT_MFERENCE_CONFIG.apiBaseUrl,
    modelId:
      rawMference.modelId ||
      (provider === 'mference' ? parsed.modelId : undefined) ||
      DEFAULT_MFERENCE_CONFIG.modelId,
    maxContext: mferenceMaxContext,
    maxTokens: Math.floor(mferenceMaxContext / 2),
    temperature:
      rawMference.temperature !== undefined
        ? Number(rawMference.temperature)
        : DEFAULT_MFERENCE_CONFIG.temperature,
    topP: rawMference.topP !== undefined ? Number(rawMference.topP) : DEFAULT_MFERENCE_CONFIG.topP,
    topK: rawMference.topK !== undefined ? Number(rawMference.topK) : DEFAULT_MFERENCE_CONFIG.topK,
    minP: rawMference.minP !== undefined ? Number(rawMference.minP) : DEFAULT_MFERENCE_CONFIG.minP,
    presencePenalty:
      rawMference.presencePenalty !== undefined
        ? Number(rawMference.presencePenalty)
        : DEFAULT_MFERENCE_CONFIG.presencePenalty,
    repetitionPenalty:
      rawMference.repetitionPenalty !== undefined
        ? Number(rawMference.repetitionPenalty)
        : DEFAULT_MFERENCE_CONFIG.repetitionPenalty,
    reasoningEffort: rawMference.reasoningEffort || 'low',
    seed: rawMference.seed !== undefined ? Number(rawMference.seed) : undefined,
    stopStrings: Array.isArray(rawMference.stopStrings) ? rawMference.stopStrings : [],
    systemPrompt:
      rawMference.systemPrompt !== undefined
        ? rawMference.systemPrompt
        : DEFAULT_MFERENCE_CONFIG.systemPrompt,
  };

  // 2.5 Maple MLX 配置
  const rawMaple = parsed?.mapleConfig || {};
  const mapleMaxContext = Number(
    rawMaple.maxContext ||
      (provider === 'maple' ? parsed.maxContext : undefined) ||
      DEFAULT_MAPLE_CONFIG.maxContext
  );
  const mapleConfig: MapleProviderConfig = {
    ...DEFAULT_MAPLE_CONFIG,
    ...rawMaple,
    apiPort:
      rawMaple.apiPort ||
      (parsed.apiPort === 1242 ? 1242 : DEFAULT_MAPLE_CONFIG.apiPort),
    apiBaseUrl: rawMaple.apiBaseUrl ?? DEFAULT_MAPLE_CONFIG.apiBaseUrl,
    modelId:
      rawMaple.modelId ||
      (provider === 'maple' ? parsed.modelId : undefined) ||
      DEFAULT_MAPLE_CONFIG.modelId,
    maxContext: mapleMaxContext,
    // 与 TTF / Mference 一致：maxTokens 锁定为 maxContext 的 50%，不单独存
    maxTokens: Math.floor(mapleMaxContext / 2),
    temperature:
      rawMaple.temperature !== undefined
        ? Number(rawMaple.temperature)
        : DEFAULT_MAPLE_CONFIG.temperature,
    topP: rawMaple.topP !== undefined ? Number(rawMaple.topP) : DEFAULT_MAPLE_CONFIG.topP,
    topK: rawMaple.topK !== undefined ? Number(rawMaple.topK) : DEFAULT_MAPLE_CONFIG.topK,
    minP: rawMaple.minP !== undefined ? Number(rawMaple.minP) : DEFAULT_MAPLE_CONFIG.minP,
    presencePenalty:
      rawMaple.presencePenalty !== undefined
        ? Number(rawMaple.presencePenalty)
        : DEFAULT_MAPLE_CONFIG.presencePenalty,
    repetitionPenalty:
      rawMaple.repetitionPenalty !== undefined
        ? Number(rawMaple.repetitionPenalty)
        : DEFAULT_MAPLE_CONFIG.repetitionPenalty,
    seed: rawMaple.seed !== undefined ? Number(rawMaple.seed) : undefined,
    stopStrings: Array.isArray(rawMaple.stopStrings) ? rawMaple.stopStrings : [],
    systemPrompt:
      rawMaple.systemPrompt !== undefined
        ? rawMaple.systemPrompt
        : DEFAULT_MAPLE_CONFIG.systemPrompt,
  };

  // 2.5 Qwen 3.5 9B（问答引擎，运行时复用 Maple）
  const rawQwen = parsed?.qwenQaConfig || {};
  const qwenMaxContext = Number(
    rawQwen.maxContext ||
      (provider === 'qwen-qa' ? parsed.maxContext : undefined) ||
      DEFAULT_QWEN_QA_CONFIG.maxContext
  );
  // 旧版本/自动探测可能把 'default_model' 或权重目录写进 modelId —— 一律归一回可读名字，
  // 否则模型选择器里会显示一长串绝对路径。目录形式只对 mlx_lm 来说是「model id」。
  const qwenModelId = (() => {
    const raw = String(
      rawQwen.modelId || (provider === 'qwen-qa' ? parsed.modelId : '') || ''
    ).trim();
    if (!raw || raw === 'default_model' || raw.startsWith('/')) return DEFAULT_QWEN_QA_CONFIG.modelId;
    return raw;
  })();
  const qwenQaConfig: QwenQaProviderConfig = {
    ...DEFAULT_QWEN_QA_CONFIG,
    ...rawQwen,
    apiPort:
      rawQwen.apiPort ||
      (provider === 'qwen-qa' && parsed.apiPort ? parsed.apiPort : DEFAULT_QWEN_QA_CONFIG.apiPort),
    apiBaseUrl: rawQwen.apiBaseUrl ?? DEFAULT_QWEN_QA_CONFIG.apiBaseUrl,
    modelId: qwenModelId,
    maxContext: qwenMaxContext,
    // 与其它引擎一致：maxTokens 恒为上下文的 50%
    maxTokens: Math.floor(qwenMaxContext / 2),
    temperature:
      rawQwen.temperature !== undefined
        ? Number(rawQwen.temperature)
        : DEFAULT_QWEN_QA_CONFIG.temperature,
    topP: rawQwen.topP !== undefined ? Number(rawQwen.topP) : DEFAULT_QWEN_QA_CONFIG.topP,
    topK: rawQwen.topK !== undefined ? Number(rawQwen.topK) : DEFAULT_QWEN_QA_CONFIG.topK,
    minP: rawQwen.minP !== undefined ? Number(rawQwen.minP) : DEFAULT_QWEN_QA_CONFIG.minP,
    presencePenalty:
      rawQwen.presencePenalty !== undefined
        ? Number(rawQwen.presencePenalty)
        : DEFAULT_QWEN_QA_CONFIG.presencePenalty,
    repetitionPenalty:
      rawQwen.repetitionPenalty !== undefined
        ? Number(rawQwen.repetitionPenalty)
        : DEFAULT_QWEN_QA_CONFIG.repetitionPenalty,
    seed: rawQwen.seed !== undefined ? Number(rawQwen.seed) : undefined,
    stopStrings: Array.isArray(rawQwen.stopStrings) ? rawQwen.stopStrings : [],
    systemPrompt:
      rawQwen.systemPrompt !== undefined
        ? rawQwen.systemPrompt
        : DEFAULT_QWEN_QA_CONFIG.systemPrompt,
  };

  // 3. Custom 配置
  const rawCustom = parsed?.customConfig || {};
  const customConfig: CustomProviderConfig = {
    ...DEFAULT_CUSTOM_CONFIG,
    ...rawCustom,
    apiPort:
      rawCustom.apiPort ||
      (provider === 'custom' && parsed.apiPort ? parsed.apiPort : DEFAULT_CUSTOM_CONFIG.apiPort),
    apiBaseUrl:
      rawCustom.apiBaseUrl ??
      (provider === 'custom' ? parsed.apiBaseUrl : DEFAULT_CUSTOM_CONFIG.apiBaseUrl),
    modelId:
      rawCustom.modelId ||
      (provider === 'custom' ? parsed.modelId : undefined) ||
      DEFAULT_CUSTOM_CONFIG.modelId,
    maxContext: Number(
      rawCustom.maxContext ||
        (provider === 'custom' ? parsed.maxContext : undefined) ||
        DEFAULT_CUSTOM_CONFIG.maxContext
    ),
    maxTokens: Number(
      rawCustom.maxTokens ||
        (provider === 'custom' ? parsed.maxTokens : undefined) ||
        DEFAULT_CUSTOM_CONFIG.maxTokens
    ),
    temperature:
      rawCustom.temperature !== undefined
        ? Number(rawCustom.temperature)
        : DEFAULT_CUSTOM_CONFIG.temperature,
    systemPrompt:
      rawCustom.systemPrompt !== undefined
        ? rawCustom.systemPrompt
        : DEFAULT_CUSTOM_CONFIG.systemPrompt,
  };

  // 4. DeepSeek 配置
  const rawDs = parsed?.deepseekConfig || {};
  const dsMaxContext = Number(
    rawDs.maxContext ||
      (provider === 'deepseek' ? parsed.maxContext : undefined) ||
      DEFAULT_DEEPSEEK_CONFIG.maxContext
  );
  const resolvedApiKey = (
    rawDs.apiKey ||
    parsed.deepseekApiKey ||
    fallbackApiKey ||
    DEFAULT_DEEPSEEK_CONFIG.apiKey
  ).trim();

  const deepseekConfig: DeepSeekProviderConfig = {
    ...DEFAULT_DEEPSEEK_CONFIG,
    ...rawDs,
    apiKey: resolvedApiKey,
    baseUrl: rawDs.baseUrl || parsed.deepseekBaseUrl || DEFAULT_DEEPSEEK_CONFIG.baseUrl,
    modelId:
      rawDs.modelId ||
      (provider === 'deepseek' ? parsed.deepseekModelId || parsed.modelId : undefined) ||
      DEFAULT_DEEPSEEK_CONFIG.modelId,
    maxContext: dsMaxContext,
    maxTokens: Math.floor(dsMaxContext / 2),
    temperature:
      rawDs.temperature !== undefined ? Number(rawDs.temperature) : DEFAULT_DEEPSEEK_CONFIG.temperature,
    topP: rawDs.topP !== undefined ? Number(rawDs.topP) : DEFAULT_DEEPSEEK_CONFIG.topP,
    reasoningEffort:
      rawDs.reasoningEffort ||
      (provider === 'deepseek' ? parsed.reasoningEffort : undefined) ||
      DEFAULT_DEEPSEEK_CONFIG.reasoningEffort,
    seed: rawDs.seed !== undefined ? Number(rawDs.seed) : undefined,
    stopStrings: Array.isArray(rawDs.stopStrings) ? rawDs.stopStrings : [],
    systemPrompt:
      rawDs.systemPrompt !== undefined ? rawDs.systemPrompt : DEFAULT_DEEPSEEK_CONFIG.systemPrompt,
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
  } else if (provider === 'maple') {
    activePort = mapleConfig.apiPort;
    activeBaseUrl = mapleConfig.apiBaseUrl || '';
    activeModel = mapleConfig.modelId;
    activeMaxContext = mapleConfig.maxContext;
    activeMaxTokens = mapleConfig.maxTokens;
    activeTemp = mapleConfig.temperature;
    activeTopP = mapleConfig.topP;
    activeTopK = mapleConfig.topK;
    activeMinP = mapleConfig.minP;
    activePresencePenalty = mapleConfig.presencePenalty;
    activeRepPenalty = mapleConfig.repetitionPenalty;
    // Maple 没有 reasoning_effort（传了会被拒），保持 'default' 让请求层不发该字段
    activeReasoning = 'default';
    activeSeed = mapleConfig.seed;
    activeStopStrings = mapleConfig.stopStrings || [];
    activeSystemPrompt = mapleConfig.systemPrompt;
  } else if (provider === 'qwen-qa') {
    activePort = qwenQaConfig.apiPort;
    activeBaseUrl = qwenQaConfig.apiBaseUrl || '';
    activeModel = qwenQaConfig.modelId;
    activeMaxContext = qwenQaConfig.maxContext;
    activeMaxTokens = qwenQaConfig.maxTokens;
    activeTemp = qwenQaConfig.temperature;
    activeTopP = qwenQaConfig.topP;
    activeTopK = qwenQaConfig.topK;
    activeMinP = qwenQaConfig.minP;
    activePresencePenalty = qwenQaConfig.presencePenalty;
    activeRepPenalty = qwenQaConfig.repetitionPenalty;
    // 与 Maple 同理：mlx_lm.server 不接受 reasoning_effort
    activeReasoning = 'default';
    activeSeed = qwenQaConfig.seed;
    activeStopStrings = qwenQaConfig.stopStrings || [];
    activeSystemPrompt = qwenQaConfig.systemPrompt;
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
    mapleConfig,
    qwenQaConfig,
    customConfig,
    deepseekConfig,
    localConfig: ttfConfig as any,

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
    spotlightResetMinutes:
      parsed?.spotlightResetMinutes !== undefined ? Number(parsed.spotlightResetMinutes) : 15,
  };
}

export function applyServerSettings(rawSettings: any): AppSettings {
  const normalized = normalizeSettingsObject(
    rawSettings,
    memoryCachedSettings?.deepseekApiKey || ''
  );
  memoryCachedSettings = normalized;
  clearLegacyWebKitSettings();
  return normalized;
}

export async function syncSettingsFromServer(
  onLoaded?: (settings: AppSettings) => void
): Promise<AppSettings> {
  try {
    const res = await fetch('/api/sessions/settings');
    if (res.ok) {
      const data = await res.json();
      if (data && data.settings && typeof data.settings === 'object') {
        const applied = applyServerSettings(data.settings);
        onLoaded?.(applied);
        return applied;
      } else {
        // Server does not have settings.json yet — seed it from current memory/legacy settings
        const initial = loadSettings();
        memoryCachedSettings = initial;
        await fetch('/api/sessions/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ settings: initial }),
        }).catch(() => {});
        clearLegacyWebKitSettings();
        onLoaded?.(initial);
        return initial;
      }
    }
  } catch (e) {
    console.warn('Failed to sync settings from server:', e);
  }
  const fallback = loadSettings();
  onLoaded?.(fallback);
  return fallback;
}

export function loadSettings(): AppSettings {
  if (memoryCachedSettings) {
    return memoryCachedSettings;
  }
  try {
    // One-time bootstrap check from legacy localStorage before syncSettingsFromServer finishes
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(SETTINGS_KEY) : null;
    const storedApiKey =
      typeof localStorage !== 'undefined' ? localStorage.getItem(DEEPSEEK_API_KEY_KEY) || '' : '';
    if (!raw && !storedApiKey) {
      memoryCachedSettings = { ...DEFAULT_SETTINGS };
      return memoryCachedSettings;
    }
    const parsed = raw ? JSON.parse(raw) : {};
    memoryCachedSettings = normalizeSettingsObject(parsed, storedApiKey);
    return memoryCachedSettings;
  } catch (e) {
    console.error('Failed to bootstrap settings:', e);
    memoryCachedSettings = { ...DEFAULT_SETTINGS };
    return memoryCachedSettings;
  }
}

export function saveSettings(settings: AppSettings): void {
  try {
    let provider: ApiProvider = settings.apiProvider || 'ttf';
    if (provider === 'local') provider = 'ttf';
    // 这份白名单必须与 normalizeSettingsObject 里的保持一致：
    // 少一个 'maple' 就会出现「Chat Model 选了 Maple，保存后被打回 ttf，
    // 同时把 Maple 的端口/模型写进 TTF 配置」——之前那串污染就是这个原因。
    if (!['ttf', 'mference', 'maple', 'qwen-qa', 'custom', 'deepseek'].includes(provider)) {
      provider = 'ttf';
    }

    // 1. 读取内存中的当前配置作为基准，完全独立于 WebKit localStorage
    const existing: Partial<AppSettings> = memoryCachedSettings || {};
    const existingTtf = existing.ttfConfig || existing.localConfig || {};
    const existingMference = existing.mferenceConfig || {};
    const existingCustom = existing.customConfig || {};
    const existingDs = existing.deepseekConfig || {};

    const incomingKey =
      settings.deepseekConfig?.apiKey?.trim() || settings.deepseekApiKey?.trim() || '';

    const effectiveApiKey = (
      incomingKey ||
      (existingDs as any).apiKey ||
      existing.deepseekApiKey ||
      ''
    ).trim();

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

    const existingMaple = existing.mapleConfig || {};

    const mapleConfig: MapleProviderConfig = {
      ...DEFAULT_MAPLE_CONFIG,
      ...existingMaple,
      ...(settings.mapleConfig || {}),
    };

    const existingQwen = existing.qwenQaConfig || {};
    const qwenQaConfig: QwenQaProviderConfig = {
      ...DEFAULT_QWEN_QA_CONFIG,
      ...existingQwen,
      ...(settings.qwenQaConfig || {}),
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
    } else if (provider === 'maple') {
      if (settings.apiPort !== undefined) mapleConfig.apiPort = settings.apiPort;
      if (settings.apiBaseUrl !== undefined) mapleConfig.apiBaseUrl = settings.apiBaseUrl;
      if (settings.modelId !== undefined) mapleConfig.modelId = settings.modelId;
      if (settings.maxContext !== undefined) {
        mapleConfig.maxContext = settings.maxContext;
        mapleConfig.maxTokens = Math.floor(settings.maxContext / 2);
      }
      if (settings.temperature !== undefined) mapleConfig.temperature = settings.temperature;
      if (settings.topP !== undefined) mapleConfig.topP = settings.topP;
      if (settings.topK !== undefined) mapleConfig.topK = settings.topK;
      if (settings.minP !== undefined) mapleConfig.minP = settings.minP;
      if (settings.presencePenalty !== undefined) mapleConfig.presencePenalty = settings.presencePenalty;
      if (settings.repetitionPenalty !== undefined) mapleConfig.repetitionPenalty = settings.repetitionPenalty;
      if (settings.seed !== undefined) mapleConfig.seed = settings.seed;
      if (Array.isArray(settings.stopStrings)) mapleConfig.stopStrings = settings.stopStrings;
      if (settings.systemPrompt !== undefined) mapleConfig.systemPrompt = settings.systemPrompt;
    } else if (provider === 'qwen-qa') {
      if (settings.apiPort !== undefined) qwenQaConfig.apiPort = settings.apiPort;
      if (settings.apiBaseUrl !== undefined) qwenQaConfig.apiBaseUrl = settings.apiBaseUrl;
      if (settings.modelId !== undefined) qwenQaConfig.modelId = settings.modelId;
      if (settings.maxContext !== undefined) {
        qwenQaConfig.maxContext = settings.maxContext;
        qwenQaConfig.maxTokens = Math.floor(settings.maxContext / 2);
      }
      if (settings.temperature !== undefined) qwenQaConfig.temperature = settings.temperature;
      if (settings.topP !== undefined) qwenQaConfig.topP = settings.topP;
      if (settings.topK !== undefined) qwenQaConfig.topK = settings.topK;
      if (settings.minP !== undefined) qwenQaConfig.minP = settings.minP;
      if (settings.presencePenalty !== undefined) qwenQaConfig.presencePenalty = settings.presencePenalty;
      if (settings.repetitionPenalty !== undefined) qwenQaConfig.repetitionPenalty = settings.repetitionPenalty;
      if (settings.seed !== undefined) qwenQaConfig.seed = settings.seed;
      if (Array.isArray(settings.stopStrings)) qwenQaConfig.stopStrings = settings.stopStrings;
      if (settings.systemPrompt !== undefined) qwenQaConfig.systemPrompt = settings.systemPrompt;
    } else if (provider === 'custom') {
      if (settings.apiPort !== undefined) customConfig.apiPort = settings.apiPort;
      if (settings.apiBaseUrl !== undefined) customConfig.apiBaseUrl = settings.apiBaseUrl;
      if (settings.modelId !== undefined) customConfig.modelId = settings.modelId;
      if (settings.maxContext !== undefined) customConfig.maxContext = settings.maxContext;
      if (settings.maxTokens !== undefined) customConfig.maxTokens = settings.maxTokens;
      if (settings.temperature !== undefined) customConfig.temperature = settings.temperature;
      if (settings.systemPrompt !== undefined) customConfig.systemPrompt = settings.systemPrompt;
    } else if (provider === 'deepseek') {
      if (settings.maxContext !== undefined) {
        deepseekConfig.maxContext = settings.maxContext;
        deepseekConfig.maxTokens = Math.floor(settings.maxContext / 2);
      }
      if (settings.temperature !== undefined) deepseekConfig.temperature = settings.temperature;
      if (settings.topP !== undefined) deepseekConfig.topP = settings.topP;
      if (settings.reasoningEffort !== undefined) deepseekConfig.reasoningEffort = settings.reasoningEffort as any;
      if (settings.seed !== undefined) deepseekConfig.seed = settings.seed;
      if (Array.isArray(settings.stopStrings)) deepseekConfig.stopStrings = settings.stopStrings;
      if (settings.systemPrompt !== undefined) deepseekConfig.systemPrompt = settings.systemPrompt;
    }

    const mergedRaw = {
      ...DEFAULT_SETTINGS,
      ...existing,
      ...settings,
      apiProvider: provider,
      ttfConfig,
      mferenceConfig,
      mapleConfig,
      qwenQaConfig,
      customConfig,
      deepseekConfig,
      deepseekApiKey: effectiveApiKey,
      deepseekModelId: deepseekConfig.modelId,
      deepseekBaseUrl: deepseekConfig.baseUrl,
    };

    const sanitized = normalizeSettingsObject(mergedRaw, effectiveApiKey);
    memoryCachedSettings = sanitized;
    clearLegacyWebKitSettings();

    fetch('/api/sessions/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings: sanitized }),
    }).catch((err) => {
      console.error('Failed to persist settings to disk:', err);
    });

    notifySettingsUpdate();
  } catch (e) {
    console.error('Failed to save settings:', e);
  }
}

export function createNewSession(title?: string): ChatSession {
  let defaultTitle = '新对话';
  try {
    const s = memoryCachedSettings || loadSettings();
    if (s?.language === 'en') {
      defaultTitle = 'New Chat';
    } else if (s?.language === 'system') {
      if (
        typeof navigator !== 'undefined' &&
        navigator.language &&
        !navigator.language.toLowerCase().startsWith('zh')
      ) {
        defaultTitle = 'New Chat';
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


