import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { AppSettings, WikiStatusInfo, AsrServiceStatus, VoicePermissionStatus, SubtitleServiceStatus, TtsServiceStatus, OcrServiceStatus, OcrConfig, TranslateServiceStatus } from '../types/chat';
import { WikiAPI, ModelServiceAPI, ModelServiceStatus, ModelServiceConfig, ASRServiceAPI, SubtitleServiceAPI, TtsServiceAPI, OcrServiceAPI, TranslateServiceAPI } from '../services/api';
import { resolveLanguage, formatArticleCount, translations, Language, TranslationKeys } from '../i18n';
import {
  SERVICE_STATE_CARD_DOT_CLASS,
  SERVICE_STATE_CARD_TEXT_CLASS,
  deriveServiceState,
  formatServiceStateText,
} from '../utils/serviceState';
import { X, RotateCcw, BookOpen, Server, ChevronDown, Mic, ShieldCheck, ExternalLink, FolderOpen, FileText, Check, Loader2, Volume2, ScanText, Download, Languages, Cpu, Eye, EyeOff, KeyRound } from 'lucide-react';

interface ServiceManagerModalProps {
  isOpen: boolean;
  onClose: () => void;
  settings: AppSettings;
  /** 基础模型监听端口变更后回传，供上层同步「模型设置」卡片里的请求端口 */
  onApiPortChange?: (port: number) => void;
}

// 知识库卡片默认值（默认指向标准内置文件夹 ~/Library/Application Support/SimpleUI/wiki）
const KB_DEFAULT_ZIM_PATH = '~/Library/Application Support/SimpleUI/wiki';
const KB_DEFAULT_PORT = 31236;
// 基础模型服务卡片默认值（与后端 ttf_service.js DEFAULT_MODEL_CONFIG 保持一致）
const SVC_DEFAULT_PROJECT_DIR = '~/turbo-fieldfare';
const SVC_DEFAULT_MFERENCE_DIR = '~/Mference';
const SVC_CARD_DEFAULTS_TTF: Partial<ModelServiceConfig> = {
  projectDir: SVC_DEFAULT_PROJECT_DIR,
  port: 1235,
  maxContext: 16384,
  expertCacheSlots: 32,
  expertCachePolicy: 'lfu',
  prefill: 'on',
  prefillChunkTokens: 'auto',
  visionResidency: 'on-demand',
  promptCacheMode: 'single-prefix',
  thinking: 'default',
  rdadvise: 'adaptive',
  allowUnbackedContext: false,
  idleAutoResetMinutes: 15,
};

const SVC_CARD_DEFAULTS_MFERENCE: Partial<ModelServiceConfig> = {
  mferenceProjectDir: SVC_DEFAULT_MFERENCE_DIR,
  mferencePort: 1241,
  mferenceMaxContext: 16384,
  mferencePromptCacheMode: 'single-prefix',
  mferenceShadowBudget: 4,
  mferenceVerify: 'auto',
  mferenceQueueLimit: 4,
  mferencePrefillChunk: '2048',
  idleAutoResetMinutes: 15,
};

// 语音合成服务卡片默认值（与后端 tts_service.js DEFAULT_CONFIG 保持一致）
const TTS_CARD_DEFAULTS = {
  voice: 'serena',
  temperature: 0.85,
  top_p: 0.95,
  top_k: 50,
  repetitionPenalty: 1.05,
  maxTokens: 1024,
};

type TtsFormShape = Partial<typeof TTS_CARD_DEFAULTS>;

/** 可调采样参数（顺序即界面顺序） */
type TtsParamKey = 'temperature' | 'top_p' | 'top_k' | 'repetitionPenalty' | 'maxTokens';

const TTS_PARAM_FIELDS: Array<{
  key: TtsParamKey;
  labelKey: 'ttsTemperature' | 'ttsTopP' | 'ttsTopK' | 'ttsRepPenalty' | 'ttsMaxTokens';
  min: number;
  max: number;
  step: number;
}> = [
  { key: 'temperature', labelKey: 'ttsTemperature', min: 0.1, max: 2, step: 0.05 },
  { key: 'top_p', labelKey: 'ttsTopP', min: 0.05, max: 1, step: 0.05 },
  { key: 'top_k', labelKey: 'ttsTopK', min: 1, max: 200, step: 1 },
  { key: 'repetitionPenalty', labelKey: 'ttsRepPenalty', min: 1, max: 1.5, step: 0.01 },
  { key: 'maxTokens', labelKey: 'ttsMaxTokens', min: 128, max: 4096, step: 64 },
];

// 语音识别服务卡片默认值
const ASR_CARD_DEFAULTS = {
  idleUnloadMin: 30,
};

// 视觉图文识别服务卡片默认值
const OCR_CARD_DEFAULTS: {
  task: OcrConfig['task'];
  resolution: OcrConfig['resolution'];
  idleUnloadMin: number;
} = {
  task: 'ocr',
  resolution: 'high',
  idleUnloadMin: 30,
};

// 快速翻译服务：详解模式的 DeepSeek 默认值（与服务端 DEFAULT_TRANSLATE_CONFIG 一致）
const TRANSLATE_DEFAULTS = {
  baseUrl: 'https://api.deepseek.com',
  modelId: 'deepseek-flash',
};

/**
 * WebKit 原生桥（语音输入权限相关）。
 * TS 的 DOM 类型未内置 `window.webkit`，故在此显式断言一次，
 * 避免在每个调用点重复 @ts-expect-error。
 */
function nativeVoiceBridge(): { postMessage: (msg: unknown) => void } | undefined {
  const w = window as unknown as {
    webkit?: { messageHandlers?: { voiceInput?: { postMessage: (m: unknown) => void } } };
  };
  return w.webkit?.messageHandlers?.voiceInput;
}

/**
 * 用系统默认浏览器打开外部链接。
 * 原生 App 里走 `openExternal` 桥 —— WKWebView 不会自己处理 `target="_blank"`；
 * 浏览器调试模式下退回 `window.open`。
 */
function openExternalUrl(url?: string | null) {
  if (!url) return;
  const w = window as unknown as {
    webkit?: { messageHandlers?: { openExternal?: { postMessage: (m: unknown) => void } } };
  };
  const bridge = w.webkit?.messageHandlers?.openExternal;
  if (bridge) {
    bridge.postMessage(url);
  } else {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}

/**
 * 格式化下载源名称（双语国际化）
 */
function formatSourceName(
  source: { id?: string; name?: string } | null | undefined,
  t: (k: TranslationKeys) => string
): string {
  if (!source) return '';
  if (source.id === 'mirror') return t('downloadSourceMirror');
  if (source.id === 'official') return t('downloadSourceOfficial');
  return source.name || '';
}

/**
 * 格式化下载错误信息（双语国际化）
 */
function formatDownloadError(
  err: string | null | undefined,
  t: (k: TranslationKeys) => string
): string | null {
  if (!err) return null;
  if (err.includes('ALL_SOURCES_UNREACHABLE') || err.includes('所有下载源均不可达')) {
    return t('downloadErrorAllSourcesUnreachable');
  }
  if (
    err.includes('FILE_SIZE_MISMATCH') ||
    err.includes('文件大小校验失败') ||
    err.includes('文件未完整下载')
  ) {
    return t('downloadErrorSizeMismatch');
  }
  if (err.includes('DOWNLOAD_FAILED') || (err.includes('下载') && err.includes('失败'))) {
    return t('downloadErrorGeneric');
  }
  return err;
}

/**
 * 获取字幕子模型阶段的国际化显示名称
 */
function getSubtitleModelDisplayName(
  key: string | null | undefined,
  fallback: string | undefined,
  t: (k: TranslationKeys) => string
): string {
  if (key === 'asr') return t('subtitleModelStage1');
  if (key === 'segment') return t('subtitleModelStage2');
  if (key === 'translate') return t('subtitleModelStage3');
  return fallback || '';
}

/**
 * 闲置内存释放时间选择器（支持预设档位与自由自定义分钟）
 */
const IdleTimeoutSelector: React.FC<{
  value?: number;
  onChange: (val: number) => void;
  disabled?: boolean;
  t: (k: TranslationKeys) => string;
}> = ({ value = 30, onChange, disabled, t }) => {
  const [isCustom, setIsCustom] = useState(() => ![0, 15, 30, 60, 120].includes(value));
  const [customVal, setCustomVal] = useState(() => value);

  useEffect(() => {
    if (![0, 15, 30, 60, 120].includes(value)) {
      setIsCustom(true);
      setCustomVal(value);
    } else {
      setIsCustom(false);
    }
  }, [value]);

  const handleSelect = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const v = e.target.value;
    if (v === 'custom') {
      setIsCustom(true);
    } else {
      setIsCustom(false);
      onChange(Number(v));
    }
  };

  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10px] text-zinc-500 dark:text-zinc-400 font-medium">
        {t('modelIdleTimeoutLabel')}
      </span>
      <div className="flex items-center gap-1.5">
        <select
          value={isCustom ? 'custom' : String(value)}
          onChange={handleSelect}
          disabled={disabled}
          className="flex-1 px-2 py-1.5 rounded-lg text-[11px] bg-white dark:bg-[#202127] border border-black/10 dark:border-white/10 text-zinc-700 dark:text-zinc-200 cursor-pointer focus:border-violet-500 focus:outline-none"
        >
          <option value="15">{t('modelIdleTimeout15m')}</option>
          <option value="30">{t('modelIdleTimeout30m')}</option>
          <option value="60">{t('modelIdleTimeout60m')}</option>
          <option value="120">{t('modelIdleTimeout120m')}</option>
          <option value="0">{t('modelIdleTimeoutNever')}</option>
          <option value="custom">{t('modelIdleTimeoutCustom')}</option>
        </select>
        {isCustom && (
          <div className="flex items-center gap-1 flex-shrink-0">
            <input
              type="number"
              min={1}
              max={1440}
              value={customVal}
              onChange={(e) => {
                const n = Math.max(1, Math.min(1440, Number(e.target.value) || 1));
                setCustomVal(n);
                onChange(n);
              }}
              disabled={disabled}
              className="w-14 px-1.5 py-1 rounded-lg text-[11px] font-mono bg-white dark:bg-[#202127] border border-black/10 dark:border-white/10 text-zinc-700 dark:text-zinc-200 focus:border-violet-500 focus:outline-none"
            />
            <span className="text-[10px] text-zinc-400">{t('modelIdleTimeoutMinUnit')}</span>
          </div>
        )}
      </div>
    </div>
  );
};

/**
 * 服务管理界面：全部受管服务（基础模型 / 知识库 / 语音识别 / 语音合成 / 实时字幕 /
 * 快速翻译 / 视觉识别）的启停、模型下载与参数配置。
 *
 * 从 SettingsModal 里独立出来——设置界面只留「应用设置」与「模型设置」两张卡片。
 * 快速翻译卡片是「快捷翻译」配置的唯一入口：快速模式复用实时字幕的翻译小模型
 * （同一份文件 / 运行时 / 下载器），详解模式只暴露 DeepSeek API 与基础模型服务的切换。
 * 视觉与交互（弹窗外壳、卡片样式、按钮样式、Esc 关闭）与设置界面完全一致。
 */
export const ServiceManagerModal: React.FC<ServiceManagerModalProps> = ({
  isOpen,
  onClose,
  settings,
  onApiPortChange,
}) => {
  // 语言取已保存的设置（本界面不提供语言切换）
  const activeLang: Language = useMemo(
    () => resolveLanguage(settings.language || 'system'),
    [settings.language]
  );

  const t = useMemo(() => {
    return (key: TranslationKeys) => {
      const dict = translations[activeLang] || translations.zh;
      return dict[key] || translations.zh[key] || key;
    };
  }, [activeLang]);

  // ---- 知识库服务 ----
  const [wikiStatus, setWikiStatus] = useState<WikiStatusInfo | null>(null);
  const [isTogglingService, setIsTogglingService] = useState(false);
  const [customZimPath, setCustomZimPath] = useState('');
  const [kbPort, setKbPort] = useState(String(KB_DEFAULT_PORT));
  const [isApplyingPath, setIsApplyingPath] = useState(false);
  const [pathMessage, setPathMessage] = useState<{ text: string; isError: boolean } | null>(null);

  // ---- 基础模型服务（支持 TurboFieldfare / Mference 双引擎切换）----
  const [svcStatus, setSvcStatus] = useState<ModelServiceStatus | null>(null);
  const [svcForm, setSvcForm] = useState<Partial<ModelServiceConfig>>({});
  const [selectedEngine, setSelectedEngine] = useState<'turbo-fieldfare' | 'mference'>('turbo-fieldfare');
  const [svcProjectDir, setSvcProjectDir] = useState('');
  const [svcMferenceProjectDir, setSvcMferenceProjectDir] = useState('');
  const [svcBusy, setSvcBusy] = useState<string | null>(null);
  const [svcMsg, setSvcMsg] = useState<{ text: string; isError: boolean } | null>(null);
  const [logsOpen, setLogsOpen] = useState(false);
  const [logLines, setLogLines] = useState<string[] | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // 轮询与后台引用的同步 Ref（避免将高频交互状态放入 useEffect 依赖导致意外重触发/覆写）
  const selectedEngineRef = useRef(selectedEngine);
  selectedEngineRef.current = selectedEngine;
  const logsOpenRef = useRef(logsOpen);
  logsOpenRef.current = logsOpen;

  // ---- 语音识别服务（Confucius4-R2T2 / audio.cpp）----
  const [asrStatus, setAsrStatus] = useState<AsrServiceStatus | null>(null);
  const [asrBusy, setAsrBusy] = useState<string | null>(null);
  const [asrLogsOpen, setAsrLogsOpen] = useState(false);
  const [asrLogLines, setAsrLogLines] = useState<string[] | null>(null);
  const asrLogsOpenRef = useRef(asrLogsOpen);
  asrLogsOpenRef.current = asrLogsOpen;
  /** 原生侧回推的三件套权限快照（浏览器调试模式下为 null） */
  const [voicePerm, setVoicePerm] = useState<VoicePermissionStatus | null>(null);

  // ---- 实时字幕服务（Confucius4-R2T2 Metal + Index-Translate-2B）----
  const [subtitleStatus, setSubtitleStatus] = useState<SubtitleServiceStatus | null>(null);
  const [subtitleBusy, setSubtitleBusy] = useState(false);

  // ---- 快速翻译服务（快速模式复用字幕翻译小模型 · 详解模式走 DeepSeek / 基础模型服务）----
  const [translateStatus, setTranslateStatus] = useState<TranslateServiceStatus | null>(null);
  const [translateBusy, setTranslateBusy] = useState(false);
  const [translateForm, setTranslateForm] = useState<{
    baseLang: 'zh' | 'en';
    detailProvider: 'deepseek' | 'base';
    apiKey: string;
    baseUrl: string;
    modelId: string;
  }>({
    baseLang: 'zh',
    detailProvider: 'deepseek',
    apiKey: '',
    baseUrl: TRANSLATE_DEFAULTS.baseUrl,
    modelId: TRANSLATE_DEFAULTS.modelId,
  });
  const [showTranslateKey, setShowTranslateKey] = useState(false);
  const [isApplyingTranslate, setIsApplyingTranslate] = useState(false);
  const [translateMsg, setTranslateMsg] = useState<{ text: string; isError: boolean } | null>(null);

  // 各卡片操作反馈提示（保存配置/路径应用）的定时器：展示 3.5 秒后自动消失，弹窗开关时彻底清空
  const msgTimersRef = useRef<{ [k: string]: ReturnType<typeof setTimeout> | null }>({});

  const showFeedback = useCallback(
    (
      key: string,
      setter: React.Dispatch<React.SetStateAction<{ text: string; isError: boolean } | null>>,
      msg: { text: string; isError: boolean }
    ) => {
      setter(msg);
      if (msgTimersRef.current[key]) {
        clearTimeout(msgTimersRef.current[key]!);
      }
      msgTimersRef.current[key] = setTimeout(() => {
        setter(null);
        msgTimersRef.current[key] = null;
      }, msg.isError ? 5000 : 3500);
    },
    []
  );

  const clearAllFeedback = useCallback(() => {
    Object.values(msgTimersRef.current).forEach((timer) => {
      if (timer) clearTimeout(timer);
    });
    msgTimersRef.current = {};
    setPathMessage(null);
    setSvcMsg(null);
    setAsrMsg(null);
    setTtsMsg(null);
    setTranslateMsg(null);
    setOcrMsg(null);
  }, []);

  const refreshSvcStatus = async () => {
    const s = await ModelServiceAPI.getStatus();
    setSvcStatus(s);
    return s;
  };

  const refreshAsrStatus = async () => {
    const s = await ASRServiceAPI.getStatus();
    setAsrStatus(s);
    return s;
  };

  const refreshSubtitleStatus = async () => {
    const s = await SubtitleServiceAPI.getStatus();
    if (s) setSubtitleStatus(s);
    return s;
  };

  const handleSubtitleDownload = async (model: 'all' | 'asr' | 'translate' | 'segment' = 'all') => {
    setSubtitleBusy(true);
    try {
      await SubtitleServiceAPI.startDownload(model);
      await refreshSubtitleStatus();
    } finally {
      setSubtitleBusy(false);
    }
  };

  const handleSubtitleCancelDownload = async () => {
    setSubtitleBusy(true);
    try {
      await SubtitleServiceAPI.cancelDownload();
      await refreshSubtitleStatus();
    } finally {
      setSubtitleBusy(false);
    }
  };

  // ---- 快速翻译服务 ----
  // 与字幕服务同一套「受管服务」形态：独立的进程与端口，只有模型文件与下载器是共用的。
  const refreshTranslateStatus = async (syncForm = false) => {
    const s = await TranslateServiceAPI.getStatus();
    if (s) {
      setTranslateStatus(s);
      // 只在打开面板时把服务端配置回填到表单，轮询不覆盖用户正在编辑的内容
      if (syncForm) {
        setTranslateForm({
          baseLang: s.baseLang,
          detailProvider: s.detailProvider,
          apiKey: '',
          baseUrl: s.deepseek?.baseUrl || TRANSLATE_DEFAULTS.baseUrl,
          modelId: s.deepseek?.modelId || TRANSLATE_DEFAULTS.modelId,
        });
      }
    }
    return s;
  };

  /** 保存配置：基准语言 + 详解后端 + DeepSeek 一起提交（与其他卡片的「应用」一致） */
  const handleTranslateApply = async () => {
    setIsApplyingTranslate(true);
    setTranslateMsg(null);
    try {
      const patch: Parameters<typeof TranslateServiceAPI.updateConfig>[0] = {
        baseLang: translateForm.baseLang,
        detailProvider: translateForm.detailProvider,
        deepseek: {
          baseUrl: translateForm.baseUrl,
          modelId: translateForm.modelId,
        },
      };
      // API Key 不回传明文：留空表示「保持已有 Key 不变」，只有真输了新 Key 才下发
      const typedKey = translateForm.apiKey.trim();
      if (typedKey && patch.deepseek) patch.deepseek.apiKey = typedKey;
      const res = await TranslateServiceAPI.updateConfig(patch);
      if (res.ok) {
        showFeedback('translate', setTranslateMsg, { text: t('translateConfigSaved'), isError: false });
        setTranslateForm((prev) => ({ ...prev, apiKey: '' }));
        await refreshTranslateStatus();
      } else {
        showFeedback('translate', setTranslateMsg, { text: t('translateActionFailed'), isError: true });
      }
    } catch {
      showFeedback('translate', setTranslateMsg, { text: t('translateActionFailed'), isError: true });
    } finally {
      setIsApplyingTranslate(false);
    }
  };

  const handleTranslateCardReset = () => {
    setTranslateForm({
      baseLang: 'zh',
      detailProvider: 'deepseek',
      apiKey: '',
      baseUrl: TRANSLATE_DEFAULTS.baseUrl,
      modelId: TRANSLATE_DEFAULTS.modelId,
    });
    setTranslateMsg(null);
  };

  const handleTranslateDownload = async () => {
    setTranslateBusy(true);
    try {
      await TranslateServiceAPI.startDownload();
      await Promise.all([refreshTranslateStatus(), refreshSubtitleStatus()]);
    } finally {
      setTranslateBusy(false);
    }
  };

  const handleTranslateCancelDownload = async () => {
    setTranslateBusy(true);
    try {
      await TranslateServiceAPI.cancelDownload();
      await Promise.all([refreshTranslateStatus(), refreshSubtitleStatus()]);
    } finally {
      setTranslateBusy(false);
    }
  };

  const handleTranslateOpenDir = async () => {
    await TranslateServiceAPI.openModelsDir();
  };

  // ---- 文字转语音服务（Qwen3-TTS 1.7B CustomVoice · MLX 6bit · 每次生成现场加载）----
  const [ttsStatus, setTtsStatus] = useState<TtsServiceStatus | null>(null);
  const [ttsBusy, setTtsBusy] = useState(false);
  const [ttsForm, setTtsForm] = useState<TtsFormShape>({});
  const [isApplyingTts, setIsApplyingTts] = useState(false);
  const [ttsMsg, setTtsMsg] = useState<{ text: string; isError: boolean } | null>(null);

  const refreshTtsStatus = async () => {
    const s = await TtsServiceAPI.getStatus();
    if (s) setTtsStatus(s);
    return s;
  };

  const handleTtsDownload = async () => {
    setTtsBusy(true);
    try {
      await TtsServiceAPI.startDownload();
      await refreshTtsStatus();
    } finally {
      setTtsBusy(false);
    }
  };

  const handleTtsCancelDownload = async () => {
    setTtsBusy(true);
    try {
      await TtsServiceAPI.cancelDownload();
      await refreshTtsStatus();
    } finally {
      setTtsBusy(false);
    }
  };

  const handleTtsOpenDir = async () => {
    await TtsServiceAPI.openModelsDir();
  };

  const handleTtsApply = async () => {
    setIsApplyingTts(true);
    setTtsMsg(null);
    try {
      const res = await TtsServiceAPI.updateConfig(ttsForm);
      if (res.ok) {
        showFeedback('tts', setTtsMsg, { text: t('ttsApplySaved'), isError: false });
        await refreshTtsStatus();
      } else {
        showFeedback('tts', setTtsMsg, { text: t('ttsActionFailed'), isError: true });
      }
    } catch {
      showFeedback('tts', setTtsMsg, { text: t('ttsActionFailed'), isError: true });
    } finally {
      setIsApplyingTts(false);
    }
  };

  const handleSubtitleOpenDir = async () => {
    await SubtitleServiceAPI.openModelsDir();
  };

  // ---- 视觉文档识别服务（PaddleOCR-VL 1.6 · MLX 8bit · 纯按需）----
  const [ocrStatus, setOcrStatus] = useState<OcrServiceStatus | null>(null);
  const [ocrBusy, setOcrBusy] = useState(false);
  const [ocrForm, setOcrForm] = useState<{
    task?: OcrConfig['task'];
    resolution?: OcrConfig['resolution'];
    idleUnloadMin?: number;
  }>({});
  const [isApplyingOcr, setIsApplyingOcr] = useState(false);
  const [ocrMsg, setOcrMsg] = useState<{ text: string; isError: boolean } | null>(null);

  const refreshOcrStatus = async () => {
    const s = await OcrServiceAPI.getStatus();
    if (s) setOcrStatus(s);
    return s;
  };

  const handleOcrDownload = async () => {
    setOcrBusy(true);
    try {
      await OcrServiceAPI.startDownload();
      await refreshOcrStatus();
    } finally {
      setOcrBusy(false);
    }
  };

  const handleOcrCancelDownload = async () => {
    setOcrBusy(true);
    try {
      await OcrServiceAPI.cancelDownload();
      await refreshOcrStatus();
    } finally {
      setOcrBusy(false);
    }
  };

  const handleOcrOpenDir = async () => {
    await OcrServiceAPI.openModelsDir();
  };

  const handleOcrApply = async () => {
    setIsApplyingOcr(true);
    setOcrMsg(null);
    try {
      const res = await OcrServiceAPI.updateConfig(ocrForm);
      if (res.ok) {
        showFeedback('ocr', setOcrMsg, { text: t('ocrApplySaved'), isError: false });
        await refreshOcrStatus();
      } else {
        showFeedback('ocr', setOcrMsg, { text: t('ocrActionFailed'), isError: true });
      }
    } catch {
      showFeedback('ocr', setOcrMsg, { text: t('ocrActionFailed'), isError: true });
    } finally {
      setIsApplyingOcr(false);
    }
  };

  /** 通过原生桥请求权限快照；无原生桥（浏览器）时置 null 并展示降级提示 */
  const requestVoicePermissions = () => {
    const bridge = nativeVoiceBridge();
    if (bridge) {
      bridge.postMessage({ action: 'getPermissions' });
    } else {
      setVoicePerm(null);
    }
  };

  const requestVoicePermission = (kind: 'microphone' | 'accessibility' | 'inputMonitoring') => {
    const bridge = nativeVoiceBridge();
    if (!bridge) return;
    if (kind === 'microphone') bridge.postMessage({ action: 'requestMicrophone' });
    if (kind === 'accessibility') bridge.postMessage({ action: 'requestAccessibility' });
    if (kind === 'inputMonitoring') bridge.postMessage({ action: 'requestInputMonitoring' });
    // 系统弹窗/跳转后权限状态会变化，稍后再取一次
    setTimeout(requestVoicePermissions, 800);
  };

  const openVoicePrivacyPane = (kind: 'microphone' | 'accessibility' | 'inputMonitoring') => {
    nativeVoiceBridge()?.postMessage({ action: 'openPrivacyPane', pane: kind });
  };

  // 原生权限变化推送入口（Swift 侧 evaluateJavaScript 调用）
  useEffect(() => {
    (window as unknown as { __onVoicePermissions?: (p: VoicePermissionStatus) => void }).__onVoicePermissions = (
      p: VoicePermissionStatus
    ) => setVoicePerm(p);
    return () => {
      (window as unknown as { __onVoicePermissions?: unknown }).__onVoicePermissions = undefined;
    };
  }, []);

  // 原生系统文件 / 文件夹选择器回调入口（Swift 侧 evaluateJavaScript 调用）
  useEffect(() => {
    (
      window as unknown as {
        __onDirectoryChosen?: (data: { path: string; key: string }) => void;
        __onFileChosen?: (data: { path: string; key: string }) => void;
      }
    ).__onDirectoryChosen = (data: { path: string; key: string }) => {
      if (!data?.path) return;
      const target = data.key || selectedEngineRef.current;
      if (target === 'zim' || target === 'wiki') {
        setCustomZimPath(data.path);
      } else if (target === 'mference') {
        setSvcMferenceProjectDir(data.path);
      } else {
        setSvcProjectDir(data.path);
      }
    };
    (
      window as unknown as {
        __onFileChosen?: (data: { path: string; key: string }) => void;
      }
    ).__onFileChosen = (data: { path: string; key: string }) => {
      if (!data?.path) return;
      if (data.key === 'zim' || data.key === 'wiki' || !data.key) {
        setCustomZimPath(data.path);
      }
    };
    return () => {
      (window as unknown as { __onDirectoryChosen?: unknown }).__onDirectoryChosen = undefined;
      (window as unknown as { __onFileChosen?: unknown }).__onFileChosen = undefined;
    };
  }, []);

  // 打开时拉取各服务的状态与配置，之后 3s 轮询 + SSE 实时监听字幕与下载进度（弹窗打开期间）
  useEffect(() => {
    let subtitleEs: EventSource | null = null;
    clearAllFeedback();
    if (isOpen) {
      WikiAPI.getStatus().then((status) => {
        setWikiStatus(status);
        if (status?.zimPath) {
          setCustomZimPath(status.zimPath);
        } else if (settings.customWikiDir) {
          setCustomZimPath(settings.customWikiDir);
        }
        setKbPort(String(status?.port ?? KB_DEFAULT_PORT));
      });

      refreshSvcStatus();
      ModelServiceAPI.getConfig().then((cfg) => {
        if (cfg) {
          setSvcForm(cfg);
          setSelectedEngine(cfg.engine || 'turbo-fieldfare');
          setSvcProjectDir(cfg.projectDir || SVC_DEFAULT_PROJECT_DIR);
          setSvcMferenceProjectDir(cfg.mferenceProjectDir || SVC_DEFAULT_MFERENCE_DIR);
        }
      });

      refreshAsrStatus().then((s) => {
        if (s) {
          setAsrForm({
            idleUnloadMin: s.idleUnloadMin ?? ASR_CARD_DEFAULTS.idleUnloadMin,
          });
        }
      });

      refreshSubtitleStatus();
      refreshTranslateStatus(true);
      refreshTtsStatus().then((s) => {
        if (s?.config) {
          setTtsForm({
            voice: s.config.voice || TTS_CARD_DEFAULTS.voice,
            temperature: s.config.temperature ?? TTS_CARD_DEFAULTS.temperature,
            top_p: s.config.top_p ?? TTS_CARD_DEFAULTS.top_p,
            top_k: s.config.top_k ?? TTS_CARD_DEFAULTS.top_k,
            repetitionPenalty: s.config.repetitionPenalty ?? TTS_CARD_DEFAULTS.repetitionPenalty,
            maxTokens: s.config.maxTokens ?? TTS_CARD_DEFAULTS.maxTokens,
          });
        }
      });
      refreshOcrStatus().then((s) => {
        if (s?.config) {
          setOcrForm({
            task: s.config.task || OCR_CARD_DEFAULTS.task,
            resolution: s.config.resolution || OCR_CARD_DEFAULTS.resolution,
            idleUnloadMin: s.config.idleUnloadMin ?? OCR_CARD_DEFAULTS.idleUnloadMin,
          });
        }
      });
      try {
        subtitleEs = new EventSource('/api/subtitles/stream');
        subtitleEs.addEventListener('status', (e: MessageEvent) => {
          try {
            const data = JSON.parse(e.data);
            if (data) setSubtitleStatus(data);
          } catch {}
        });
      } catch {}

      // 原生权限快照（三件套）
      requestVoicePermissions();

      pollTimerRef.current = setInterval(() => {
        refreshSvcStatus();
        refreshAsrStatus();
        refreshSubtitleStatus();
        refreshTranslateStatus();
        refreshTtsStatus();
        refreshOcrStatus();
        if (logsOpenRef.current) {
          ModelServiceAPI.getLogs(200, selectedEngineRef.current).then((d) => setLogLines(d?.lines ?? null));
        }
        if (asrLogsOpenRef.current) {
          ASRServiceAPI.getLogs(200).then((d) => setAsrLogLines(d?.lines ?? null));
        }
      }, 3000);
    } else {
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
      setLogsOpen(false);
      logsOpenRef.current = false;
      setLogLines(null);
      setAsrLogsOpen(false);
      asrLogsOpenRef.current = false;
      setAsrLogLines(null);
      clearAllFeedback();
    }
    return () => {
      clearAllFeedback();
      if (subtitleEs) {
        subtitleEs.close();
        subtitleEs = null;
      }
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, settings.customWikiDir]);

  // 切换基础模型引擎（TTF 与 Mference）：立即切换选项卡并异步持久化，无闪烁回退
  const handleSwitchEngine = (engine: 'turbo-fieldfare' | 'mference') => {
    if (selectedEngine === engine) return;
    setSelectedEngine(engine);
    selectedEngineRef.current = engine;
    setSvcForm((prev) => ({ ...prev, engine }));
    ModelServiceAPI.updateConfig({ engine }, false).catch((err) => {
      console.error('Failed to update engine selection:', err);
    });
    if (logsOpenRef.current) {
      ModelServiceAPI.getLogs(200, engine).then((d) => setLogLines(d?.lines ?? null));
    }
  };

  // 独立引擎启停开关：按当前选中的引擎分别控制，互相解耦
  const handleEngineToggle = async (engine: 'turbo-fieldfare' | 'mference', next: boolean) => {
    setSvcBusy(`toggle-${engine}`);
    try {
      if (engine === 'mference') {
        await ModelServiceAPI.updateConfig({ mferenceEnabled: next, engine: next ? 'mference' : selectedEngine }, false);
      } else {
        await ModelServiceAPI.updateConfig({ ttfEnabled: next, engine: next ? 'turbo-fieldfare' : selectedEngine }, false);
      }
      await ModelServiceAPI.control(next ? 'start' : 'stop', engine);
      await refreshSvcStatus();
    } finally {
      setSvcBusy(null);
    }
  };

  const handleBrowseDirectory = () => {
    const current = selectedEngine === 'mference' ? svcMferenceProjectDir : svcProjectDir;
    const w = window as unknown as {
      webkit?: {
        messageHandlers?: {
          chooseDirectory?: {
            postMessage: (m: unknown) => void;
          };
        };
      };
    };
    if (w.webkit?.messageHandlers?.chooseDirectory) {
      w.webkit.messageHandlers.chooseDirectory.postMessage({
        currentPath: current,
        callbackKey: selectedEngine,
      });
    }
  };

  const handleBrowseKbFile = () => {
    const w = window as unknown as {
      webkit?: {
        messageHandlers?: {
          chooseFile?: {
            postMessage: (m: unknown) => void;
          };
        };
      };
    };
    if (w.webkit?.messageHandlers?.chooseFile) {
      w.webkit.messageHandlers.chooseFile.postMessage({
        currentPath: customZimPath,
        callbackKey: 'zim',
        allowedExtensions: ['zim'],
      });
    }
  };

  const handleSvcPathApply = async () => {
    const isMference = selectedEngine === 'mference';
    const targetDir = isMference ? svcMferenceProjectDir.trim() : svcProjectDir.trim();
    if (!targetDir) return;
    setSvcBusy('path');
    setSvcMsg(null);
    try {
      const partial: Partial<ModelServiceConfig> = isMference
        ? { engine: selectedEngine, mferenceProjectDir: targetDir }
        : { engine: selectedEngine, projectDir: targetDir };
      const r = await ModelServiceAPI.updateConfig(partial, true);
      if (r.success) {
        showFeedback('svc', setSvcMsg, { text: t('modelServicePathApplied'), isError: false });
      } else {
        showFeedback('svc', setSvcMsg, { text: t('modelServiceActionFailed'), isError: true });
      }
      await refreshSvcStatus();
    } finally {
      setSvcBusy(null);
    }
  };

  const handleSvcApplyParams = async () => {
    setSvcBusy('apply');
    setSvcMsg(null);
    try {
      const isMference = selectedEngine === 'mference';
      const targetPort = isMference
        ? (Number(svcForm.mferencePort) || 1241)
        : (Number(svcForm.port) || 1235);

      const payload: Partial<ModelServiceConfig> = {
        ...svcForm,
        engine: selectedEngine,
        projectDir: svcProjectDir.trim() || SVC_DEFAULT_PROJECT_DIR,
        mferenceProjectDir: svcMferenceProjectDir.trim() || SVC_DEFAULT_MFERENCE_DIR,
        port: Number(svcForm.port) || 1235,
        mferencePort: Number(svcForm.mferencePort) || 1241,
      };

      const r = await ModelServiceAPI.updateConfig(payload, true);
      if (r.success) {
        onApiPortChange?.(targetPort);
        showFeedback('svc', setSvcMsg, {
          text: r.restarted ? t('modelServiceApplyDone') : t('modelServiceApplySaved'),
          isError: false,
        });
      } else {
        showFeedback('svc', setSvcMsg, { text: t('modelServiceActionFailed'), isError: true });
      }
      await refreshSvcStatus();
    } finally {
      setSvcBusy(null);
    }
  };

  const toggleLogs = async () => {
    const next = !logsOpen;
    setLogsOpen(next);
    if (next) {
      const d = await ModelServiceAPI.getLogs(200, selectedEngine);
      setLogLines(d?.lines ?? null);
    }
  };

  // ---- 语音识别服务动作 ----
  const [asrForm, setAsrForm] = useState<{ idleUnloadMin?: number }>({});
  const [isApplyingAsr, setIsApplyingAsr] = useState(false);
  const [asrMsg, setAsrMsg] = useState<{ text: string; isError: boolean } | null>(null);

  const handleAsrApply = async () => {
    setIsApplyingAsr(true);
    setAsrMsg(null);
    try {
      const res = await ASRServiceAPI.saveConfig({
        idleUnloadMin: asrForm.idleUnloadMin ?? asrStatus?.idleUnloadMin ?? 30,
      });
      if (res.success) {
        showFeedback('asr', setAsrMsg, { text: t('asrApplySaved'), isError: false });
        await refreshAsrStatus();
      } else {
        showFeedback('asr', setAsrMsg, { text: res.error || t('asrActionFailed'), isError: true });
      }
    } catch {
      showFeedback('asr', setAsrMsg, { text: t('asrActionFailed'), isError: true });
    } finally {
      setIsApplyingAsr(false);
    }
  };

  const handleAsrDownload = async () => {
    setAsrBusy('download');
    try {
      await ASRServiceAPI.startDownload();
      await Promise.all([refreshAsrStatus(), refreshSubtitleStatus()]);
    } finally {
      setAsrBusy(null);
    }
  };

  const handleAsrCancelDownload = async () => {
    setAsrBusy('cancel-download');
    try {
      await ASRServiceAPI.cancelDownload();
      await Promise.all([refreshAsrStatus(), refreshSubtitleStatus()]);
    } finally {
      setAsrBusy(null);
    }
  };

  const handleAsrOpenDir = async () => {
    await ASRServiceAPI.openModelsDir();
  };

  const toggleAsrLogs = async () => {
    const next = !asrLogsOpen;
    setAsrLogsOpen(next);
    if (next) {
      const d = await ASRServiceAPI.getLogs(200);
      setAsrLogLines(d?.lines ?? null);
    }
  };

  // ---- 各卡片独立的「恢复默认」：仅把该卡片表单恢复为默认值，需点保存/应用才会落盘 ----
  const cardResetButton = (onClick?: () => void, disabled?: boolean) => (
    <div className="mt-3 flex">
      <button
        type="button"
        disabled={disabled}
        onClick={disabled ? undefined : onClick}
        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs transition-colors ${
          disabled
            ? 'text-zinc-400 dark:text-zinc-600 opacity-40 cursor-not-allowed select-none'
            : 'text-zinc-500 dark:text-[#8c929f] hover:text-zinc-900 dark:hover:text-white hover:bg-black/5 dark:hover:bg-[#2b2d35] cursor-pointer'
        }`}
        title={disabled ? t('restoreDefaultsDisabledTip') : undefined}
      >
        <RotateCcw className="w-3.5 h-3.5" />
        <span>{t('restoreDefaults')}</span>
      </button>
    </div>
  );

  const handleKbCardReset = () => {
    setCustomZimPath(KB_DEFAULT_ZIM_PATH);
    setKbPort(String(KB_DEFAULT_PORT));
    setPathMessage(null);
  };

  const handleSvcCardReset = () => {
    if (selectedEngine === 'mference') {
      setSvcForm((prev) => ({
        ...prev,
        ...SVC_CARD_DEFAULTS_MFERENCE,
      }));
      setSvcMferenceProjectDir(SVC_DEFAULT_MFERENCE_DIR);
    } else {
      setSvcForm((prev) => ({
        ...prev,
        ...SVC_CARD_DEFAULTS_TTF,
      }));
      setSvcProjectDir(SVC_DEFAULT_PROJECT_DIR);
    }
    setSvcMsg(null);
  };

  const handleAsrCardReset = () => {
    setAsrForm({ ...ASR_CARD_DEFAULTS });
    setAsrMsg(null);
  };

  const handleTtsCardReset = () => {
    setTtsForm({ ...TTS_CARD_DEFAULTS });
    setTtsMsg(null);
  };

  const handleOcrCardReset = () => {
    setOcrForm({ ...OCR_CARD_DEFAULTS });
    setOcrMsg(null);
  };

  /** 三件套权限行（无原生桥时返回空数组，界面走降级提示） */
  const voicePermRows = (): Array<{
    key: 'microphone' | 'accessibility' | 'inputMonitoring';
    label: string;
    granted: boolean;
    pending: boolean;
  }> => {
    if (!voicePerm) return [];
    return [
      {
        key: 'microphone',
        label: t('asrPermMicrophone'),
        granted: voicePerm.microphone === 'granted',
        pending: voicePerm.microphone === 'undetermined',
      },
      { key: 'accessibility', label: t('asrPermAccessibility'), granted: voicePerm.accessibility, pending: false },
      { key: 'inputMonitoring', label: t('asrPermInputMonitoring'), granted: voicePerm.inputMonitoring, pending: false },
    ];
  };

  // 知识库服务总开关：关闭即停服（后端杀掉 kiwix 进程），开启即按 ZIM 路径拉起
  const handleToggleWikiService = async (next: boolean) => {
    setIsTogglingService(true);
    try {
      const res = await WikiAPI.setEnabled(next);
      setWikiStatus(res);
    } catch (e) {
      // ignore
    } finally {
      setIsTogglingService(false);
    }
  };

  // 知识库：仅把路径保存进配置，不动运行中的服务（由「保存并应用」负责生效）
  const handleKbPathSave = async () => {
    if (!customZimPath.trim()) return;
    setIsApplyingPath(true);
    setPathMessage(null);
    try {
      const res = await WikiAPI.saveConfig({ zimPath: customZimPath.trim() }, { saveOnly: true });
      if (res.success !== false) {
        setWikiStatus(res);
        showFeedback('kb', setPathMessage, { text: t('modelServicePathApplied'), isError: false });
      } else {
        showFeedback('kb', setPathMessage, { text: t('kbPathFileNotFound'), isError: true });
      }
    } catch {
      showFeedback('kb', setPathMessage, { text: t('kbPathFileNotFound'), isError: true });
    } finally {
      setIsApplyingPath(false);
    }
  };

  // 知识库：保存并应用（路径 + 端口；运行中则重启使其生效）
  const handleKbApply = async () => {
    if (!customZimPath.trim()) return;
    setIsApplyingPath(true);
    setPathMessage(null);
    try {
      const res = await WikiAPI.saveConfig(
        { zimPath: customZimPath.trim(), port: Number(kbPort) || KB_DEFAULT_PORT },
        { restartIfRunning: true }
      );
      if (res.success !== false) {
        setWikiStatus(res);
        showFeedback('kb', setPathMessage, {
          text: res.restarted ? t('modelServiceApplyDone') : t('modelServiceApplySaved'),
          isError: false,
        });
      } else {
        showFeedback('kb', setPathMessage, { text: t('kbPathFileNotFound'), isError: true });
      }
    } catch {
      showFeedback('kb', setPathMessage, { text: t('kbPathFileNotFound'), isError: true });
    } finally {
      setIsApplyingPath(false);
    }
  };

  // Close on Escape key
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  const isMference = selectedEngine === 'mference';
  const currentEngineStatus = svcStatus ? (isMference ? svcStatus.mference : svcStatus.ttf) : null;
  const isCurrentEngineActive =
    currentEngineStatus?.status === 'running' ||
    currentEngineStatus?.status === 'loading' ||
    currentEngineStatus?.status === 'starting' ||
    currentEngineStatus?.status === 'restart';

  // 快速翻译服务：下载进度直接引用字幕服务的 downloadState，
  // 但只有「正在下载翻译模型」才算本卡片的下载中，避免字幕 ASR / 断句模型的下载串台显示。
  const translateDl = translateStatus?.quick?.downloadState;
  const translateDlActive = Boolean(
    translateDl?.active &&
      (translateDl.targetModel === 'translate' || translateDl.currentModelKey === 'translate')
  );

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm select-none">
      <div
        onClick={(e) => e.stopPropagation()}
        className="relative w-full max-w-2xl rounded-2xl bg-white dark:bg-[#202227] border border-black/10 dark:border-[#353842] shadow-2xl overflow-hidden flex flex-col max-h-[90vh] text-[#1f2328] dark:text-[#cfd3dc]"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-black/5 dark:border-[#2d3038]">
          <h2 className="text-sm font-semibold text-[#1f2328] dark:text-[#f1f3f7]">
            {t('serviceManagerTitle')}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded-lg text-zinc-500 hover:text-zinc-900 hover:bg-black/5 dark:text-[#888e9b] dark:hover:text-white dark:hover:bg-[#2d3038] transition-colors cursor-pointer"
            title={t('closeServiceManager')}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* 卡片区：三张服务卡片与设置界面同款外壳（p-5 space-y-4 的滚动区） */}
        <div className="flex-1 overflow-y-auto p-5 space-y-4 text-xs">
          {/* Knowledge Base Configuration Card */}
          <div className="p-3.5 rounded-xl border border-black/10 dark:border-[#343740] bg-[#f8f9fb] dark:bg-[#18191c]">
            {settings.apiProvider === 'deepseek' && (
              <div className="mb-3 px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/20 text-amber-700 dark:text-amber-400 text-[11px] leading-relaxed">
                {t('wikiDisabledInDeepSeek')}
              </div>
            )}
            <div className="flex items-start justify-between mb-2.5">
              <div className="flex items-center gap-2 pt-0.5">
                <BookOpen className="w-4 h-4 text-emerald-600 dark:text-emerald-400 flex-shrink-0" />
                <span className="font-semibold text-xs text-[#1f2328] dark:text-[#f1f3f7]">
                  {t('wikiKnowledgeBase')}
                </span>
              </div>
              {wikiStatus && (() => {
                const cardState = deriveServiceState({ status: wikiStatus.status });
                return (
                  <div className="flex flex-col items-end gap-1">
                    <div className="flex items-center gap-1.5 text-[11px]">
                      <span
                        className={`w-2 h-2 rounded-full flex-shrink-0 ${
                          SERVICE_STATE_CARD_DOT_CLASS[cardState]
                        }`}
                      />
                      <span className={SERVICE_STATE_CARD_TEXT_CLASS[cardState]}>
                        {formatServiceStateText(cardState, t, wikiStatus.port)}
                      </span>
                    </div>
                    <span className="text-[10px] text-zinc-400 dark:text-zinc-500 text-right leading-tight select-none">
                      {cardState === 'online'
                        ? wikiStatus.articleCount > 0
                          ? `${t('wikiDetailIndexed')} ${formatArticleCount(wikiStatus.articleCount, activeLang)}`
                          : t('wikiDetailConnected')
                        : cardState === 'starting'
                        ? t('wikiDetailStarting')
                        : wikiStatus.enabled
                        ? t('wikiDetailNoZim')
                        : t('serviceDisabled')}
                    </span>
                  </div>
                );
              })()}
            </div>

            {/* Knowledge Base 服务开关（开关在上，路径在下；状态行保持在最顶上）
                服务关闭时整块隐藏路径设置——开不了服务，改路径没有意义，
                同时隐藏该块下方的分隔线（否则会留下一条下面没内容的横线）。 */}
            <div
              className={`flex items-center justify-between gap-3 ${
                wikiStatus?.enabled ?? true
                  ? 'pb-3 border-b border-black/5 dark:border-white/5'
                  : ''
              }`}
            >
              <button
                type="button"
                onClick={() => handleToggleWikiService(!(wikiStatus?.enabled ?? true))}
                disabled={isTogglingService}
                className="flex-1 min-w-0 text-left cursor-pointer disabled:cursor-not-allowed"
              >
                <div className="font-medium text-zinc-700 dark:text-zinc-200">
                  {t('wikiServiceToggle')}
                </div>
                <div className="text-[10px] text-zinc-500 dark:text-zinc-400">
                  {t('wikiServiceToggleDesc')}
                </div>
              </button>
              <button
                type="button"
                role="switch"
                aria-checked={wikiStatus?.enabled ?? true}
                disabled={isTogglingService}
                onClick={() => handleToggleWikiService(!(wikiStatus?.enabled ?? true))}
                className={`relative w-10 h-[22px] rounded-full transition-colors flex-shrink-0 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none ${
                  wikiStatus?.enabled ?? true
                    ? 'bg-emerald-600'
                    : 'bg-zinc-300 dark:bg-zinc-600'
                }`}
              >
                <span
                  className={`absolute top-[2px] left-[2px] w-[18px] h-[18px] rounded-full bg-white shadow transition-transform duration-200 ${
                    wikiStatus?.enabled ?? true ? 'translate-x-[18px]' : 'translate-x-0'
                  }`}
                />
              </button>
            </div>

            {/* Custom ZIM Path Input —— 仅在服务开启时显示 */}
            {(wikiStatus?.enabled ?? true) && (
              <div className="pt-3 mb-1">
                <label className="block text-[11px] font-medium text-zinc-600 dark:text-zinc-400 mb-1">
                  {t('kbPathLabel')}
                </label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={customZimPath}
                  onChange={(e) => setCustomZimPath(e.target.value)}
                  placeholder={t('kbPathPlaceholder')}
                  className="flex-1 bg-white dark:bg-[#202127] border border-black/10 dark:border-white/10 rounded-lg px-2.5 py-1.5 text-xs text-[#1f2328] dark:text-[#f1f3f7] font-mono focus:outline-none focus:border-blue-500"
                />
                <button
                  type="button"
                  onClick={handleBrowseKbFile}
                  disabled={isApplyingPath}
                  title={t('kbPathBrowse')}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-black/5 hover:bg-black/10 dark:bg-white/5 dark:hover:bg-white/10 text-zinc-700 dark:text-zinc-200 border border-black/10 dark:border-white/10 text-xs font-medium transition-all active:scale-95 disabled:opacity-50 cursor-pointer flex-shrink-0"
                >
                  <FileText className="w-3.5 h-3.5 text-zinc-500 dark:text-zinc-400" />
                  <span>{t('kbPathBrowse')}</span>
                </button>
                <button
                  type="button"
                  onClick={handleKbPathSave}
                  disabled={isApplyingPath || !customZimPath.trim()}
                  className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 active:scale-95 disabled:opacity-50 text-white text-xs font-medium transition-all flex items-center gap-1.5 flex-shrink-0"
                >
                  {isApplyingPath ? t('kbPathApplying') : t('kbPathApply')}
                </button>
              </div>

                {/* 服务监听端口（默认 31236；保存并应用后生效） */}
                <div className="mt-3">
                  <label className="block text-[11px] font-medium text-zinc-600 dark:text-zinc-400 mb-1">
                    {t('svcPortLabel')}
                  </label>
                  <input
                    type="number"
                    min={1024}
                    max={65535}
                    value={kbPort}
                    onChange={(e) => setKbPort(e.target.value)}
                    className="w-full bg-white dark:bg-[#202127] border border-black/10 dark:border-white/10 rounded-lg px-2.5 py-1.5 text-xs text-[#1f2328] dark:text-[#f1f3f7] font-mono focus:outline-none focus:border-blue-500"
                  />
                </div>

              {pathMessage && (
                <div
                  className={`mt-1 text-[11px] ${
                    pathMessage.isError ? 'text-red-500' : 'text-emerald-600 dark:text-emerald-400 font-medium'
                  }`}
                >
                  {pathMessage.text}
                </div>
              )}

                {/* 保存并应用：路径 + 端口一并落盘，运行中则重启生效 */}
                <button
                  type="button"
                  onClick={handleKbApply}
                  disabled={isApplyingPath || !customZimPath.trim()}
                  className="mt-2.5 w-full px-2 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 active:scale-[0.98] disabled:opacity-50 text-white text-xs font-medium transition-all"
                >
                  {isApplyingPath ? t('modelServiceApplying') : t('modelServiceApplyRestart')}
                </button>

              {cardResetButton(handleKbCardReset)}
            </div>
            )}
          </div>

          {/* 基础模型服务卡片（支持 TurboFieldfare 与 Mference 双引擎自由切换与管理） */}
          <div className="p-3.5 rounded-xl border border-black/10 dark:border-[#343740] bg-[#f8f9fb] dark:bg-[#18191c]">
            {/* 头部：标题 + 状态灯/端口（精确展示当前选中引擎的运行状态与端口） */}
            <div className="flex items-start justify-between mb-3">
              <div className="flex items-center gap-2 pt-0.5">
                <Server className="w-4 h-4 text-amber-600 dark:text-amber-400 flex-shrink-0" />
                <span className="font-semibold text-xs text-[#1f2328] dark:text-[#f1f3f7]">
                  {t('modelServiceTitle')}
                </span>
              </div>
              {(() => {
                const cardState = deriveServiceState({ status: svcStatus?.status });
                return (
                  <div className="flex flex-col items-end gap-1">
                    <div className="flex items-center gap-1.5 text-[11px]">
                      <span
                        className={`w-2 h-2 rounded-full flex-shrink-0 ${
                          SERVICE_STATE_CARD_DOT_CLASS[cardState]
                        }`}
                      />
                      <span className={SERVICE_STATE_CARD_TEXT_CLASS[cardState]}>
                        {formatServiceStateText(cardState, t, svcStatus?.port)}
                      </span>
                    </div>
                    <span className="text-[10px] text-zinc-400 dark:text-zinc-500 text-right leading-tight select-none">
                      {cardState === 'online'
                        ? `${t('modelDetailCurrentEngine')}: ${selectedEngine === 'mference' ? 'Mference' : 'TurboFieldfare'}`
                        : cardState === 'starting'
                        ? t('modelDetailLoading')
                        : t('modelDetailStopped')}
                    </span>
                  </div>
                );
              })()}
            </div>

            {/* Base Model 引擎切换选择器 (Segmented Control)：每个选项直观显示各自的状态灯与独立端口 */}
            <div className="mb-3">
              <label className="block text-[11px] font-medium text-zinc-600 dark:text-zinc-400 mb-1.5">
                {t('modelEngineLabel')}
              </label>
              <div className="grid grid-cols-2 gap-2 p-1 bg-black/5 dark:bg-white/5 rounded-xl border border-black/5 dark:border-white/5">
                <button
                  type="button"
                  onClick={() => handleSwitchEngine('turbo-fieldfare')}
                  className={`py-1.5 px-3 rounded-lg text-xs font-medium transition-all flex items-center justify-between cursor-pointer gap-2 ${
                    selectedEngine === 'turbo-fieldfare'
                      ? 'bg-white dark:bg-[#202127] text-amber-700 dark:text-amber-400 shadow-sm font-semibold'
                      : 'text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-white'
                  }`}
                >
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span
                      className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                        SERVICE_STATE_CARD_DOT_CLASS[deriveServiceState({ status: svcStatus?.ttf?.status })]
                      }`}
                    />
                    <span className="whitespace-nowrap">{t('modelEngineTTF')}</span>
                  </div>
                  <span className="text-[10px] font-mono opacity-60 flex-shrink-0 ml-1">
                    {svcStatus?.ttf?.port ? `:${svcStatus.ttf.port}` : ''}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => handleSwitchEngine('mference')}
                  className={`py-1.5 px-3 rounded-lg text-xs font-medium transition-all flex items-center justify-between cursor-pointer gap-2 ${
                    selectedEngine === 'mference'
                      ? 'bg-white dark:bg-[#202127] text-amber-700 dark:text-amber-400 shadow-sm font-semibold'
                      : 'text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-white'
                  }`}
                >
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span
                      className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                        SERVICE_STATE_CARD_DOT_CLASS[deriveServiceState({ status: svcStatus?.mference?.status })]
                      }`}
                    />
                    <span className="whitespace-nowrap">{t('modelEngineMference')}</span>
                  </div>
                  <span className="text-[10px] font-mono opacity-60 flex-shrink-0 ml-1">
                    {svcStatus?.mference?.port ? `:${svcStatus.mference.port}` : ''}
                  </span>
                </button>
              </div>
            </div>

            {/* 独立服务启停开关：解耦控制，各引擎拥有独立启停状态与文案 */}
            <div className="flex items-center justify-between gap-3 pb-3 mb-3 border-b border-black/5 dark:border-white/5">
              <button
                type="button"
                onClick={() => handleEngineToggle(selectedEngine, !isCurrentEngineActive)}
                disabled={svcBusy !== null}
                className="flex-1 min-w-0 text-left cursor-pointer disabled:cursor-not-allowed"
              >
                <div className="font-medium text-zinc-700 dark:text-zinc-200">
                  {isMference ? t('mferenceServiceAutoStart') : t('ttfServiceAutoStart')}
                </div>
                <div className="text-[10px] text-zinc-500 dark:text-zinc-400">
                  {isMference
                    ? t('mferenceServiceAutoStartDesc')
                    : t('ttfServiceAutoStartDesc')}
                </div>
              </button>
              <button
                type="button"
                role="switch"
                aria-checked={isCurrentEngineActive}
                disabled={svcBusy !== null}
                onClick={() => handleEngineToggle(selectedEngine, !isCurrentEngineActive)}
                className={`relative w-10 h-[22px] rounded-full transition-colors flex-shrink-0 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none ${
                  isCurrentEngineActive
                    ? 'bg-amber-600'
                    : 'bg-zinc-300 dark:bg-zinc-600'
                }`}
              >
                <span
                  className={`absolute top-[2px] left-[2px] w-[18px] h-[18px] rounded-full bg-white shadow transition-transform duration-200 ${
                    isCurrentEngineActive ? 'translate-x-[18px]' : 'translate-x-0'
                  }`}
                />
              </button>
            </div>

            {/* 本体项目目录 */}
            <label className="block text-[11px] font-medium text-zinc-600 dark:text-zinc-400 mb-1">
              {t('modelServicePathLabel')}
            </label>
            <div className="flex gap-2 mb-1.5">
              <input
                type="text"
                value={selectedEngine === 'mference' ? svcMferenceProjectDir : svcProjectDir}
                onChange={(e) => {
                  if (selectedEngine === 'mference') {
                    setSvcMferenceProjectDir(e.target.value);
                  } else {
                    setSvcProjectDir(e.target.value);
                  }
                }}
                placeholder={selectedEngine === 'mference' ? '~/Mference' : '~/turbo-fieldfare'}
                className="flex-1 bg-white dark:bg-[#202127] border border-black/10 dark:border-white/10 rounded-lg px-2.5 py-1.5 text-xs text-[#1f2328] dark:text-[#f1f3f7] font-mono focus:outline-none focus:border-amber-500"
              />
              <button
                type="button"
                onClick={handleBrowseDirectory}
                disabled={svcBusy !== null}
                title={t('modelServicePathBrowse')}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-black/5 hover:bg-black/10 dark:bg-white/5 dark:hover:bg-white/10 text-zinc-700 dark:text-zinc-200 border border-black/10 dark:border-white/10 text-xs font-medium transition-all active:scale-95 disabled:opacity-50 cursor-pointer flex-shrink-0"
              >
                <FolderOpen className="w-3.5 h-3.5 text-zinc-500 dark:text-zinc-400" />
                <span>{t('modelServicePathBrowse')}</span>
              </button>
              <button
                type="button"
                onClick={handleSvcPathApply}
                disabled={svcBusy !== null || !(selectedEngine === 'mference' ? svcMferenceProjectDir.trim() : svcProjectDir.trim())}
                className="px-3 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-700 active:scale-95 disabled:opacity-50 text-white text-xs font-medium transition-all flex-shrink-0"
              >
                {svcBusy === 'path' ? t('modelServicePathApplying') : t('modelServicePathApply')}
              </button>
            </div>

            {/* 服务监听端口 */}
            <div className="mb-1.5">
              <label className="block text-[11px] font-medium text-zinc-600 dark:text-zinc-400 mb-1">
                {t('svcPortLabel')}
              </label>
              <input
                type="number"
                min={1024}
                max={65535}
                value={selectedEngine === 'mference' ? (svcForm.mferencePort ?? 1241) : (svcForm.port ?? 1235)}
                onChange={(e) => {
                  const val = Number(e.target.value);
                  if (selectedEngine === 'mference') {
                    setSvcForm({ ...svcForm, mferencePort: val || 1241 });
                  } else {
                    setSvcForm({ ...svcForm, port: val || 1235 });
                  }
                }}
                className="w-full bg-white dark:bg-[#202127] border border-black/10 dark:border-white/10 rounded-lg px-2.5 py-1.5 text-xs text-[#1f2328] dark:text-[#f1f3f7] font-mono focus:outline-none focus:border-amber-500"
              />
            </div>

            {/* 前置条件检测引导 */}
            {currentEngineStatus && (!currentEngineStatus.checks.repo || !currentEngineStatus.checks.binary || !currentEngineStatus.checks.model) && (
              <div className="mt-1 rounded-lg border border-black/10 dark:border-white/10 bg-[#f6f8fa] dark:bg-[#18191c] px-2.5 py-2">
                <div className="text-[10px] text-zinc-500 dark:text-zinc-400 mb-1.5">
                  {!currentEngineStatus.checks.repo
                    ? t('modelServiceCheckRepo')
                    : !currentEngineStatus.checks.binary
                    ? t('modelServiceCheckBinary')
                    : t('modelServiceCheckModel')}
                </div>
                <button
                  type="button"
                  onClick={() => openExternalUrl(currentEngineStatus.projectUrl)}
                  className="flex items-center gap-1 text-[11px] text-amber-600 dark:text-amber-400 hover:underline cursor-pointer"
                >
                  <ExternalLink className="w-3 h-3" />
                  <span>{t('modelServiceOpenProjectPage')}</span>
                </button>
              </div>
            )}
            {svcMsg && (
              <div
                className={`mt-1 text-[11px] ${
                  svcMsg.isError ? 'text-red-500' : 'text-emerald-600 dark:text-emerald-400 font-medium'
                }`}
              >
                {svcMsg.text}
              </div>
            )}

            {/* 运行参数区 */}
            <div className="mt-3">
              <div className="text-[11px] font-medium text-zinc-600 dark:text-zinc-400 mb-1.5">
                {t('modelServiceParamsTitle')}
              </div>

              {selectedEngine === 'mference' ? (
                /* Mference 运行参数 */
                <div className="grid grid-cols-2 gap-2.5">
                  <div>
                    <label className="block text-[10px] text-zinc-500 dark:text-zinc-400 mb-1">{t('svcMaxContextLabel')}</label>
                    <select
                      value={svcForm.mferenceMaxContext ?? 16384}
                      onChange={(e) => setSvcForm({ ...svcForm, mferenceMaxContext: Number(e.target.value) })}
                      className="w-full bg-[#f6f8fa] dark:bg-[#18191c] border border-black/10 dark:border-[#343740] rounded-lg px-2 py-1.5 text-xs text-[#1f2328] dark:text-[#e2e5eb] focus:border-amber-500 focus:outline-none"
                    >
                      {[4096, 8192, 16384, 32768, 65536, 128000].map((v) => (
                        <option key={v} value={v}>
                          {v >= 1024 ? `${v / 1024}K` : v}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-[10px] text-zinc-500 dark:text-zinc-400 mb-1">{t('svcShadowBudgetLabel')}</label>
                    <select
                      value={svcForm.mferenceShadowBudget ?? 4}
                      onChange={(e) => setSvcForm({ ...svcForm, mferenceShadowBudget: Number(e.target.value) })}
                      className="w-full bg-[#f6f8fa] dark:bg-[#18191c] border border-black/10 dark:border-[#343740] rounded-lg px-2 py-1.5 text-xs text-[#1f2328] dark:text-[#e2e5eb] focus:border-amber-500 focus:outline-none"
                    >
                      <option value={0}>{t('svcShadowOff')}</option>
                      <option value={1}>1</option>
                      <option value={2}>2</option>
                      <option value={3}>3</option>
                      <option value={4}>{t('svcShadowRecommended')}</option>
                      <option value={6}>6</option>
                      <option value={8}>{t('svcShadowMax')}</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-[10px] text-zinc-500 dark:text-zinc-400 mb-1">{t('svcPromptCacheLabel')}</label>
                    <select
                      value={svcForm.mferencePromptCacheMode ?? 'single-prefix'}
                      onChange={(e) => setSvcForm({ ...svcForm, mferencePromptCacheMode: e.target.value as any })}
                      className="w-full bg-[#f6f8fa] dark:bg-[#18191c] border border-black/10 dark:border-[#343740] rounded-lg px-2 py-1.5 text-xs text-[#1f2328] dark:text-[#e2e5eb] focus:border-amber-500 focus:outline-none"
                    >
                      <option value="single-prefix">{t('svcPromptCacheSingle')}</option>
                      <option value="off">{t('svcPromptCacheOff')}</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-[10px] text-zinc-500 dark:text-zinc-400 mb-1">{t('svcVerifyLabel')}</label>
                    <select
                      value={svcForm.mferenceVerify ?? 'auto'}
                      onChange={(e) => setSvcForm({ ...svcForm, mferenceVerify: e.target.value as any })}
                      className="w-full bg-[#f6f8fa] dark:bg-[#18191c] border border-black/10 dark:border-[#343740] rounded-lg px-2 py-1.5 text-xs text-[#1f2328] dark:text-[#e2e5eb] focus:border-amber-500 focus:outline-none"
                    >
                      <option value="auto">{t('svcVerifyAuto')}</option>
                      <option value="full-sha256">{t('svcVerifyFull')}</option>
                      <option value="trusted-receipt">{t('svcVerifyTrusted')}</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-[10px] text-zinc-500 dark:text-zinc-400 mb-1">{t('svcPrefillChunkMferenceLabel')}</label>
                    <select
                      value={svcForm.mferencePrefillChunk ?? '2048'}
                      onChange={(e) => setSvcForm({ ...svcForm, mferencePrefillChunk: e.target.value })}
                      className="w-full bg-[#f6f8fa] dark:bg-[#18191c] border border-black/10 dark:border-[#343740] rounded-lg px-2 py-1.5 text-xs text-[#1f2328] dark:text-[#e2e5eb] focus:border-amber-500 focus:outline-none"
                    >
                      <option value="512">512</option>
                      <option value="1024">1024</option>
                      <option value="2048">{t('svcPrefillChunkRecommended')}</option>
                      <option value="4096">4096</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-[10px] text-zinc-500 dark:text-zinc-400 mb-1">{t('svcQueueLimitLabel')}</label>
                    <select
                      value={svcForm.mferenceQueueLimit ?? 4}
                      onChange={(e) => setSvcForm({ ...svcForm, mferenceQueueLimit: Number(e.target.value) })}
                      className="w-full bg-[#f6f8fa] dark:bg-[#18191c] border border-black/10 dark:border-[#343740] rounded-lg px-2 py-1.5 text-xs text-[#1f2328] dark:text-[#e2e5eb] focus:border-amber-500 focus:outline-none"
                    >
                      <option value={1}>{t('svcQueueSingle')}</option>
                      <option value={2}>2</option>
                      <option value={4}>{t('svcQueueDefault')}</option>
                      <option value={8}>8</option>
                      <option value={16}>16</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-[10px] text-zinc-500 dark:text-zinc-400 mb-1">{t('svcIdleResetLabel')}</label>
                    <select
                      value={svcForm.idleAutoResetMinutes ?? 15}
                      onChange={(e) => setSvcForm({ ...svcForm, idleAutoResetMinutes: Number(e.target.value) })}
                      className="w-full bg-[#f6f8fa] dark:bg-[#18191c] border border-black/10 dark:border-[#343740] rounded-lg px-2 py-1.5 text-xs text-[#1f2328] dark:text-[#e2e5eb] focus:border-amber-500 focus:outline-none"
                    >
                      <option value={0}>{t('svcIdleResetDisabled')}</option>
                      {[5, 10, 15, 30, 60, 120].map((v) => (
                        <option key={v} value={v}>{v} {t('svcMinutesUnit')}</option>
                      ))}
                    </select>
                  </div>
                </div>
              ) : (
                /* TurboFieldfare 运行参数 */
                <>
                  <div className="grid grid-cols-2 gap-2.5">
                    <div>
                      <label className="block text-[10px] text-zinc-500 dark:text-zinc-400 mb-1">{t('svcMaxContextLabel')}</label>
                      <select
                        value={svcForm.maxContext ?? 16384}
                        onChange={(e) => setSvcForm({ ...svcForm, maxContext: Number(e.target.value) })}
                        className="w-full bg-[#f6f8fa] dark:bg-[#18191c] border border-black/10 dark:border-[#343740] rounded-lg px-2 py-1.5 text-xs text-[#1f2328] dark:text-[#e2e5eb] focus:border-amber-500 focus:outline-none"
                      >
                        {[4096, 8192, 16384, 32768, 65536, 98304, 131072, 196608, 262144].map((v) => (
                          <option key={v} value={v}>
                            {v >= 1024 ? `${v / 1024}K` : v}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-[10px] text-zinc-500 dark:text-zinc-400 mb-1">{t('svcExpertSlotsLabel')}</label>
                      <select
                        value={svcForm.expertCacheSlots ?? 32}
                        onChange={(e) => setSvcForm({ ...svcForm, expertCacheSlots: Number(e.target.value) })}
                        className="w-full bg-[#f6f8fa] dark:bg-[#18191c] border border-black/10 dark:border-[#343740] rounded-lg px-2 py-1.5 text-xs text-[#1f2328] dark:text-[#e2e5eb] focus:border-amber-500 focus:outline-none"
                      >
                        {[8, 16, 24, 32].map((v) => (
                          <option key={v} value={v}>{v}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-[10px] text-zinc-500 dark:text-zinc-400 mb-1">{t('svcExpertPolicyLabel')}</label>
                      <select
                        value={svcForm.expertCachePolicy ?? 'lfu'}
                        onChange={(e) => setSvcForm({ ...svcForm, expertCachePolicy: e.target.value as 'lfu' | 'lru' })}
                        className="w-full bg-[#f6f8fa] dark:bg-[#18191c] border border-black/10 dark:border-[#343740] rounded-lg px-2 py-1.5 text-xs text-[#1f2328] dark:text-[#e2e5eb] focus:border-amber-500 focus:outline-none"
                      >
                        <option value="lfu">LFU</option>
                        <option value="lru">LRU</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-[10px] text-zinc-500 dark:text-zinc-400 mb-1">{t('svcPrefillLabel')}</label>
                      <select
                        value={svcForm.prefill ?? 'on'}
                        onChange={(e) => setSvcForm({ ...svcForm, prefill: e.target.value as ModelServiceConfig['prefill'] })}
                        className="w-full bg-[#f6f8fa] dark:bg-[#18191c] border border-black/10 dark:border-[#343740] rounded-lg px-2 py-1.5 text-xs text-[#1f2328] dark:text-[#e2e5eb] focus:border-amber-500 focus:outline-none"
                      >
                        <option value="on">{t('svcToggleOn')}</option>
                        <option value="off">{t('svcToggleOff')}</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-[10px] text-zinc-500 dark:text-zinc-400 mb-1">{t('svcPrefillChunkLabel')}</label>
                      <select
                        value={svcForm.prefillChunkTokens ?? 'auto'}
                        onChange={(e) => setSvcForm({ ...svcForm, prefillChunkTokens: e.target.value as ModelServiceConfig['prefillChunkTokens'] })}
                        className="w-full bg-[#f6f8fa] dark:bg-[#18191c] border border-black/10 dark:border-[#343740] rounded-lg px-2 py-1.5 text-xs text-[#1f2328] dark:text-[#e2e5eb] focus:border-amber-500 focus:outline-none"
                      >
                        <option value="auto">auto</option>
                        <option value="256">256</option>
                        <option value="128">128</option>
                        <option value="64">64</option>
                        <option value="32">32</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-[10px] text-zinc-500 dark:text-zinc-400 mb-1">{t('svcVisionLabel')}</label>
                      <select
                        value={svcForm.visionResidency ?? 'on-demand'}
                        onChange={(e) => setSvcForm({ ...svcForm, visionResidency: e.target.value as ModelServiceConfig['visionResidency'] })}
                        className="w-full bg-[#f6f8fa] dark:bg-[#18191c] border border-black/10 dark:border-[#343740] rounded-lg px-2 py-1.5 text-xs text-[#1f2328] dark:text-[#e2e5eb] focus:border-amber-500 focus:outline-none"
                      >
                        <option value="on-demand">on-demand</option>
                        <option value="keep-ready">keep-ready</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-[10px] text-zinc-500 dark:text-zinc-400 mb-1">{t('svcPromptCacheLabel')}</label>
                      <select
                        value={svcForm.promptCacheMode ?? 'single-prefix'}
                        onChange={(e) => setSvcForm({ ...svcForm, promptCacheMode: e.target.value as ModelServiceConfig['promptCacheMode'] })}
                        className="w-full bg-[#f6f8fa] dark:bg-[#18191c] border border-black/10 dark:border-[#343740] rounded-lg px-2 py-1.5 text-xs text-[#1f2328] dark:text-[#e2e5eb] focus:border-amber-500 focus:outline-none"
                      >
                        <option value="single-prefix">single-prefix</option>
                        <option value="off">off</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-[10px] text-zinc-500 dark:text-zinc-400 mb-1">{t('svcThinkingLabel')}</label>
                      <select
                        value={svcForm.thinking ?? 'default'}
                        onChange={(e) => setSvcForm({ ...svcForm, thinking: e.target.value as ModelServiceConfig['thinking'] })}
                        className="w-full bg-[#f6f8fa] dark:bg-[#18191c] border border-black/10 dark:border-[#343740] rounded-lg px-2 py-1.5 text-xs text-[#1f2328] dark:text-[#e2e5eb] focus:border-amber-500 focus:outline-none"
                      >
                        <option value="default">default</option>
                        <option value="on">on</option>
                        <option value="off">off</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-[10px] text-zinc-500 dark:text-zinc-400 mb-1">{t('svcRdadviseLabel')}</label>
                      <select
                        value={svcForm.rdadvise ?? 'adaptive'}
                        onChange={(e) => setSvcForm({ ...svcForm, rdadvise: e.target.value as ModelServiceConfig['rdadvise'] })}
                        className="w-full bg-[#f6f8fa] dark:bg-[#18191c] border border-black/10 dark:border-[#343740] rounded-lg px-2 py-1.5 text-xs text-[#1f2328] dark:text-[#e2e5eb] focus:border-amber-500 focus:outline-none"
                      >
                        <option value="adaptive">adaptive</option>
                        <option value="bounded">bounded</option>
                        <option value="default">default</option>
                        <option value="off">off</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-[10px] text-zinc-500 dark:text-zinc-400 mb-1">{t('svcIdleResetLabel')}</label>
                      <select
                        value={svcForm.idleAutoResetMinutes ?? 15}
                        onChange={(e) => setSvcForm({ ...svcForm, idleAutoResetMinutes: Number(e.target.value) })}
                        className="w-full bg-[#f6f8fa] dark:bg-[#18191c] border border-black/10 dark:border-[#343740] rounded-lg px-2 py-1.5 text-xs text-[#1f2328] dark:text-[#e2e5eb] focus:border-amber-500 focus:outline-none"
                      >
                        <option value={0}>{t('svcIdleResetDisabled')}</option>
                        {[5, 10, 15, 30, 60, 120].map((v) => (
                          <option key={v} value={v}>{v} {t('svcMinutesUnit')}</option>
                        ))}
                      </select>
                    </div>
                  </div>

                  {/* 显存预算保护（允许超出物理显存预算强制启动 128K/256K） */}
                  <label className="mt-2.5 flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={svcForm.allowUnbackedContext ?? false}
                      onChange={(e) => setSvcForm({ ...svcForm, allowUnbackedContext: e.target.checked })}
                      className="w-3.5 h-3.5 accent-amber-600 cursor-pointer"
                    />
                    <span className="text-[11px] text-zinc-600 dark:text-zinc-300">{t('svcAllowUnbackedLabel')}</span>
                  </label>
                </>
              )}

              <button
                type="button"
                onClick={handleSvcApplyParams}
                disabled={svcBusy !== null}
                className="mt-2.5 w-full px-2 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-700 active:scale-[0.98] disabled:opacity-50 text-white text-xs font-medium transition-all cursor-pointer"
              >
                {svcBusy === 'apply' ? t('modelServiceApplying') : t('modelServiceApplyRestart')}
              </button>
            </div>

            {/* 运行日志 */}
            <div className="mt-3">
              <button
                type="button"
                onClick={toggleLogs}
                className="flex items-center gap-1 text-[11px] font-medium text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-white transition-colors cursor-pointer"
              >
                <ChevronDown className={`w-3.5 h-3.5 transition-transform ${logsOpen ? 'rotate-180' : ''}`} />
                {t('modelServiceLogs')}
              </button>
              {logsOpen && (
                <pre className="mt-1.5 max-h-40 overflow-y-auto bg-zinc-100 dark:bg-[#151619] border border-black/10 dark:border-[#2d3038] rounded-lg p-2 text-[10px] leading-relaxed font-mono text-zinc-600 dark:text-[#abb0bc] whitespace-pre-wrap break-all">
                  {logLines && logLines.length > 0
                    ? logLines.join('\n')
                    : t('modelServiceLogEmpty')}
                </pre>
              )}
            </div>

            {cardResetButton(handleSvcCardReset)}
          </div>

          {/* 语音输入服务卡片（Confucius4-R2T2 / audio.cpp） */}
          <div className="p-3.5 rounded-xl border border-black/10 dark:border-[#343740] bg-[#f8f9fb] dark:bg-[#18191c]">
            {(() => {
              const asrDownload = asrStatus?.download?.active
                ? asrStatus.download
                : subtitleStatus?.downloadState?.active
                ? subtitleStatus.downloadState
                : asrStatus?.download || subtitleStatus?.downloadState;

              const isAsrDownloading = Boolean(
                asrDownload?.active &&
                (asrDownload.currentModelKey === 'asr' || asrDownload.targetModel === 'asr' || asrDownload.targetModel === 'all')
              );

              const isAsrModelReady = Boolean(
                asrStatus?.model?.ready ?? asrStatus?.checks?.model ?? subtitleStatus?.modelsStatus?.asr?.ready
              );

              const cardState = deriveServiceState({
                status: asrStatus?.status,
                running: asrStatus?.running,
                loaded: isAsrModelReady,
              });

              return (
                <>
                  {/* 头部：标题 + 引擎徽标 + 运行状态指示 */}
                  <div className="flex items-start justify-between mb-2.5">
                    <div className="flex items-center gap-2 pt-0.5">
                      <Mic className="w-4 h-4 text-violet-600 dark:text-violet-400 flex-shrink-0" />
                      <span className="font-semibold text-xs text-[#1f2328] dark:text-[#f1f3f7]">
                        {t('asrServiceTitle')}
                      </span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded-md font-mono bg-violet-500/10 text-violet-600 dark:text-violet-400 font-medium">
                        {t('asrEngineTag')}
                      </span>
                    </div>
                    <div className="flex flex-col items-end gap-1">
                      <div className="flex items-center gap-1.5 text-[11px]">
                        <span
                          className={`w-2 h-2 rounded-full flex-shrink-0 ${
                            SERVICE_STATE_CARD_DOT_CLASS[cardState]
                          }`}
                        />
                        <span className={SERVICE_STATE_CARD_TEXT_CLASS[cardState]}>
                          {formatServiceStateText(cardState, t, asrStatus?.port)}
                        </span>
                      </div>
                      <span className="text-[10px] text-zinc-400 dark:text-zinc-500 text-right leading-tight select-none">
                        {asrDownload?.active
                          ? `${t('asrDetailDownloading')} (${(asrDownload.progressPercent || 0).toFixed(1)}%)`
                          : asrStatus?.status === 'loading'
                          ? t('asrDetailLoading')
                          : asrStatus?.running
                          ? t('asrDetailActive')
                          : isAsrModelReady
                          ? t('asrDetailStandby')
                          : t('asrDetailMissing')}
                      </span>
                    </div>
                  </div>

                  {/* 功能定位与快捷键横幅 */}
                  <div className="flex items-center justify-between gap-2 mb-3 px-2.5 py-2 rounded-lg bg-violet-500/5 dark:bg-violet-500/10 border border-violet-500/20">
                    <div className="min-w-0">
                      <div className="text-[11px] font-medium text-zinc-700 dark:text-zinc-200">
                        {t('asrServiceLifecycleTitle')}
                      </div>
                      <div className="text-[10px] text-zinc-500 dark:text-zinc-400 leading-snug">
                        {t('asrServiceLifecycleHint')}
                      </div>
                    </div>
                    <kbd className="flex-shrink-0 px-2 py-1 rounded-md border border-black/10 dark:border-white/15 bg-white dark:bg-[#202127] text-[10px] font-mono text-zinc-700 dark:text-zinc-200 whitespace-nowrap shadow-sm">
                      {t('asrHotkeyTrigger')}
                    </kbd>
                  </div>

                  {/* 内置运行环境与模型状态 */}
                  <div className="space-y-2 mb-3">
                    {/* 内置运行环境 */}
                    <div className="flex items-center justify-between gap-2 px-2.5 py-2 rounded-lg bg-white dark:bg-[#202127] border border-black/5 dark:border-white/5">
                      <div className="flex items-center gap-2 min-w-0">
                        <span
                          className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                            asrStatus?.checks?.binary ? 'bg-emerald-500' : 'bg-red-500'
                          }`}
                        />
                        <div className="min-w-0">
                          <div className="text-[11px] font-medium text-zinc-700 dark:text-zinc-200 truncate">
                            {t('runtimeLabel')}
                          </div>
                          <div className="text-[10px] text-zinc-400 dark:text-zinc-500 truncate">
                            {t('asrRuntimeDesc')}
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 flex-shrink-0">
                        {asrStatus?.checks?.binary ? (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 text-[10px] font-medium">
                            <Check className="w-3 h-3" />
                            <span>{t('runtimeBundledReady')}</span>
                          </span>
                        ) : (
                          <span className="text-[10px] text-red-500 font-medium">
                            {t('runtimeMissing')}
                          </span>
                        )}
                      </div>
                    </div>

                    {/* ASR 模型状态 */}
                    <div className="flex items-center justify-between gap-2 px-2.5 py-2 rounded-lg bg-white dark:bg-[#202127] border border-black/5 dark:border-white/5">
                      <div className="flex items-center gap-2 min-w-0">
                        <span
                          className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                            isAsrModelReady
                              ? 'bg-emerald-500'
                              : isAsrDownloading
                              ? 'bg-violet-500 animate-pulse'
                              : 'bg-red-500'
                          }`}
                        />
                        <div className="min-w-0">
                          <div className="text-[11px] font-medium text-zinc-700 dark:text-zinc-200 truncate">
                            {t('asrModelLabel')}
                          </div>
                          <div className="text-[10px] text-zinc-400 dark:text-zinc-500 font-mono">
                            {isAsrModelReady
                              ? `${asrStatus?.model?.sizeDesc || '2.31 GB'} · ${t('runtimeBundledReady')}`
                              : t('asrModelDesc')}
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 flex-shrink-0">
                        {isAsrModelReady ? (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 text-[10px] font-medium">
                            <Check className="w-3 h-3" />
                            <span>{t('asrModelReady')}</span>
                          </span>
                        ) : isAsrDownloading ? (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-violet-500/10 text-violet-600 dark:text-violet-400 text-[10px] font-medium">
                            <Loader2 className="w-3 h-3 animate-spin" />
                            <span>{t('asrDownloading')}</span>
                          </span>
                        ) : (
                          <>
                            <span className="text-[10px] text-red-500 font-medium">
                              {t('asrModelMissing')}
                            </span>
                            <button
                              type="button"
                              disabled={asrBusy !== null}
                              onClick={handleAsrDownload}
                              className="px-2 py-1 rounded-md text-[11px] font-medium transition-all active:scale-95 disabled:opacity-50 text-white bg-violet-600 hover:bg-violet-500 cursor-pointer"
                            >
                              {t('asrDownloadBtn')}
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* 自动测速与实时下载进度面板 */}
                  {isAsrDownloading && asrDownload && (
                    <div className="mb-3 p-2.5 rounded-lg bg-violet-500/5 dark:bg-violet-500/10 border border-violet-500/20 space-y-2">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-1.5 min-w-0 text-[11px] font-medium text-violet-700 dark:text-violet-300">
                          <Loader2 className="w-3.5 h-3.5 animate-spin flex-shrink-0" />
                          <span className="truncate">
                            {asrDownload.phase === 'probing'
                              ? t('asrProbingSource')
                              : asrDownload.phase === 'cleaning'
                              ? t('asrCleaningCache')
                              : asrDownload.currentModelName || t('asrModelLabel')}
                          </span>
                        </div>
                        <button
                          type="button"
                          disabled={asrBusy !== null}
                          onClick={handleAsrCancelDownload}
                          className="px-2 py-0.5 rounded-md border border-red-500/30 bg-red-500/10 hover:bg-red-500/20 text-red-600 dark:text-red-400 text-[10px] font-medium transition-colors flex-shrink-0 cursor-pointer"
                        >
                          {t('asrCancelDownloadBtn')}
                        </button>
                      </div>

                      {asrDownload.selectedSource && (
                        <div className="text-[10px] text-zinc-500 dark:text-zinc-400 flex items-center justify-between">
                          <span>
                            {t('asrSelectedSourceLabel')}:{' '}
                            <strong className="font-medium text-zinc-700 dark:text-zinc-200">
                              {formatSourceName(asrDownload.selectedSource, t)}
                            </strong>{' '}
                            ({asrDownload.selectedSource.latencyMs}ms)
                          </span>
                          <span className="font-mono text-violet-600 dark:text-violet-400 font-semibold">
                            {(asrDownload.progressPercent || 0).toFixed(1)}%
                          </span>
                        </div>
                      )}

                      <div className="w-full h-1.5 rounded-full bg-black/10 dark:bg-white/10 overflow-hidden">
                        <div
                          className="h-full rounded-full bg-gradient-to-r from-violet-500 to-emerald-500 transition-all duration-200"
                          style={{
                            width: `${Math.max(
                              3,
                              Math.min(100, asrDownload.progressPercent || 0)
                            )}%`,
                          }}
                        />
                      </div>

                      {asrDownload.phase === 'downloading' && (
                        <div className="flex items-center justify-between text-[10px] font-mono text-zinc-500 dark:text-zinc-400">
                          <span>
                            {(asrDownload.downloadedBytes / (1024 * 1024)).toFixed(1)} MB /{' '}
                            {(asrDownload.totalBytes / (1024 * 1024)).toFixed(1)} MB
                          </span>
                          <span>
                            {(asrDownload.speedBps / (1024 * 1024)).toFixed(2)} MB/s
                            {asrDownload.etaSeconds !== null &&
                            asrDownload.etaSeconds > 0
                              ? ` · ETA ${Math.floor(asrDownload.etaSeconds / 60)}m${String(
                                  asrDownload.etaSeconds % 60
                                ).padStart(2, '0')}s`
                              : ''}
                          </span>
                        </div>
                      )}
                    </div>
                  )}

                  {/* 下载结果提示 */}
                  {!isAsrDownloading &&
                    asrDownload?.phase === 'completed' && (
                      <div className="mb-2.5 text-[11px] text-emerald-600 dark:text-emerald-400 font-medium">
                        {t('asrDownloadCompleted')}
                      </div>
                    )}
                  {!isAsrDownloading &&
                    asrDownload?.phase === 'cancelled' && (
                      <div className="mb-2.5 text-[11px] text-amber-600 dark:text-amber-400">
                        {t('asrDownloadCancelled')}
                      </div>
                    )}
                  {!isAsrDownloading &&
                    asrDownload?.phase === 'error' &&
                    asrDownload?.error && (
                      <div className="mb-2.5 text-[11px] text-red-500">
                        {formatDownloadError(asrDownload.error, t)}
                      </div>
                    )}

                  {/* 前置检查错误提示 */}
                  {asrStatus && !asrStatus.checks.binary && (
                    <div className="mb-2 text-[10px] text-red-500">{t('asrCheckBinary')}</div>
                  )}
                  {asrStatus && !asrStatus.checks.model && !isAsrDownloading && (
                    <div className="mb-2 text-[10px] text-red-500">{t('asrCheckModel')}</div>
                  )}

                  {/* 服务启动失败原因提示 */}
                  {asrStatus && asrStatus.status === 'stopped' && asrStatus.lastActionLog && (
                    <pre className="mb-2.5 max-h-24 overflow-y-auto bg-red-500/5 dark:bg-red-500/10 border border-red-500/20 rounded-lg p-2 text-[10px] leading-relaxed font-mono text-red-600 dark:text-red-400 whitespace-pre-wrap break-all">
                      {asrStatus.lastActionLog}
                    </pre>
                  )}

                  {/* 默认配置项：内存闲置释放 */}
                  <div className="mb-3">
                    <IdleTimeoutSelector
                      value={asrForm.idleUnloadMin ?? asrStatus?.idleUnloadMin ?? 30}
                      onChange={(min) => setAsrForm((prev) => ({ ...prev, idleUnloadMin: min }))}
                      disabled={asrBusy !== null || isApplyingAsr}
                      t={t}
                    />
                  </div>

                  {/* 保存配置按钮与反馈 */}
                  <div className="mb-3 flex items-center justify-between">
                    <button
                      type="button"
                      disabled={asrBusy !== null || isApplyingAsr}
                      onClick={handleAsrApply}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs bg-violet-600 hover:bg-violet-500 active:scale-[0.98] disabled:opacity-50 text-white font-medium shadow-sm transition-all cursor-pointer"
                    >
                      {isApplyingAsr && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                      <span>{isApplyingAsr ? t('asrApplying') : t('asrApplyBtn')}</span>
                    </button>
                    {asrMsg && (
                      <span
                        className={`text-xs ${
                          asrMsg.isError ? 'text-red-500' : 'text-emerald-600 dark:text-emerald-400'
                        }`}
                      >
                        {asrMsg.text}
                      </span>
                    )}
                  </div>

                  {/* 快捷动作按钮栏 */}
                  <div className="mt-3 flex items-center gap-2 mb-3">
                    {!isAsrModelReady && !isAsrDownloading && (
                      <button
                        type="button"
                        disabled={asrBusy !== null}
                        onClick={handleAsrDownload}
                        className="flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg bg-violet-600 hover:bg-violet-500 active:scale-95 text-white text-xs font-medium transition-all shadow-sm cursor-pointer disabled:opacity-50"
                      >
                        <Download className="w-3.5 h-3.5" />
                        <span>{t('asrDownloadBtn')}</span>
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={handleAsrOpenDir}
                      className="flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg bg-black/5 hover:bg-black/10 dark:bg-white/5 dark:hover:bg-white/10 text-zinc-700 dark:text-zinc-200 border border-black/10 dark:border-white/10 text-xs font-medium transition-all active:scale-95 cursor-pointer"
                    >
                      <FolderOpen className="w-3.5 h-3.5 text-zinc-500 dark:text-zinc-400" />
                      <span>{t('asrOpenModelsDirBtn')}</span>
                    </button>
                  </div>
                </>
              );
            })()}

            {/* 权限（麦克风 / 辅助功能 / 输入监控） */}
            <div className="pt-3 border-t border-black/5 dark:border-white/5">
              <div className="flex items-center gap-1.5 mb-1.5">
                <ShieldCheck className="w-3.5 h-3.5 text-zinc-500 dark:text-zinc-400" />
                <span className="text-[11px] font-medium text-zinc-600 dark:text-zinc-400">{t('asrPermTitle')}</span>
              </div>
              {!voicePerm ? (
                <div className="text-[10px] text-zinc-400 dark:text-zinc-500">{t('asrPermUnavailable')}</div>
              ) : (
                <div className="space-y-1.5">
                  {voicePermRows().map((row) => (
                    <div key={row.key} className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <span
                          className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                            row.granted ? 'bg-emerald-500' : row.pending ? 'bg-amber-500' : 'bg-red-500'
                          }`}
                        />
                        <span className="text-[11px] text-zinc-600 dark:text-zinc-300 truncate">{row.label}</span>
                        <span
                          className={`text-[10px] ${
                            row.granted
                              ? 'text-emerald-600 dark:text-emerald-400'
                              : row.pending
                              ? 'text-amber-600 dark:text-amber-400'
                              : 'text-red-500'
                          }`}
                        >
                          {row.granted
                            ? t('asrPermGranted')
                            : row.pending
                            ? t('asrPermUndetermined')
                            : t('asrPermDenied')}
                        </span>
                      </div>
                      {!row.granted && (
                        <div className="flex items-center gap-1 flex-shrink-0">
                          <button
                            type="button"
                            onClick={() => requestVoicePermission(row.key)}
                            className="px-2 py-0.5 rounded-md bg-violet-600 hover:bg-violet-700 text-white text-[10px] font-medium transition-colors"
                          >
                            {t('asrPermGrant')}
                          </button>
                          <button
                            type="button"
                            onClick={() => openVoicePrivacyPane(row.key)}
                            className="px-2 py-0.5 rounded-md border border-black/10 dark:border-white/15 text-zinc-600 dark:text-zinc-300 hover:bg-black/5 dark:hover:bg-white/5 text-[10px] transition-colors"
                          >
                            {t('asrPermOpen')}
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                  <div className="text-[10px] text-zinc-400 dark:text-zinc-500 leading-snug pt-0.5">
                    {t('asrPermTip')}
                  </div>
                </div>
              )}
            </div>

            {/* 运行日志 */}
            <div className="mt-3">
              <button
                type="button"
                onClick={toggleAsrLogs}
                className="flex items-center gap-1 text-[11px] font-medium text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-white transition-colors cursor-pointer"
              >
                <ChevronDown className={`w-3.5 h-3.5 transition-transform ${asrLogsOpen ? 'rotate-180' : ''}`} />
                {t('asrLogs')}
              </button>
              {asrLogsOpen && (
                <pre className="mt-1.5 max-h-40 overflow-y-auto bg-zinc-100 dark:bg-[#151619] border border-black/10 dark:border-[#2d3038] rounded-lg p-2 text-[10px] leading-relaxed font-mono text-zinc-600 dark:text-[#abb0bc] whitespace-pre-wrap break-all">
                  {asrLogLines && asrLogLines.length > 0 ? asrLogLines.join('\n') : t('asrLogEmpty')}
                </pre>
              )}
            </div>

            {cardResetButton(handleAsrCardReset)}
          </div>

          {/* 文字转语音服务卡片（Qwen3-TTS 1.7B CustomVoice · MLX 6bit · 每次生成现场加载） */}
          <div className="p-3.5 rounded-xl border border-black/10 dark:border-[#343740] bg-[#f8f9fb] dark:bg-[#18191c]">
            {/* 头部：标题 + 引擎徽标 + 运行状态指示 */}
            <div className="flex items-start justify-between mb-2.5">
              <div className="flex items-center gap-2 pt-0.5">
                <Volume2 className="w-4 h-4 text-sky-600 dark:text-sky-400 flex-shrink-0" />
                <span className="font-semibold text-xs text-[#1f2328] dark:text-[#f1f3f7]">
                  {t('ttsServiceTitle')}
                </span>
                <span className="text-[10px] px-1.5 py-0.5 rounded-md font-mono bg-sky-500/10 text-sky-600 dark:text-sky-400 font-medium">
                  {t('ttsEngineTag')}
                </span>
              </div>
              {ttsStatus && (() => {
                const ttsCardState = deriveServiceState({
                  status: ttsStatus.status,
                  running: ttsStatus.running,
                  loaded: ttsStatus.model?.ready,
                });
                return (
                  <div className="flex flex-col items-end gap-1">
                    <div className="flex items-center gap-1.5 text-[11px]">
                      <span
                        className={`w-2 h-2 rounded-full flex-shrink-0 ${
                          SERVICE_STATE_CARD_DOT_CLASS[ttsCardState]
                        }`}
                      />
                      <span className={SERVICE_STATE_CARD_TEXT_CLASS[ttsCardState]}>
                        {formatServiceStateText(ttsCardState, t, ttsStatus.port)}
                      </span>
                    </div>
                    <span className="text-[10px] text-zinc-400 dark:text-zinc-500 text-right leading-tight select-none">
                      {ttsStatus.download?.active
                        ? `${t('ttsDetailDownloading')} (${ttsStatus.download.progressPercent.toFixed(1)}%)`
                        : ttsStatus.status === 'loading'
                        ? t('ttsDetailLoading')
                        : ttsStatus.running
                        ? t('ttsDetailActive')
                        : ttsStatus.model?.ready
                        ? t('ttsDetailStandby')
                        : t('ttsDetailMissing')}
                    </span>
                  </div>
                );
              })()}
            </div>

            {/* 功能定位与触发横幅 */}
            <div className="flex items-center justify-between gap-2 mb-3 px-2.5 py-2 rounded-lg bg-sky-500/5 dark:bg-sky-500/10 border border-sky-500/20">
              <div className="min-w-0">
                <div className="text-[11px] font-medium text-zinc-700 dark:text-zinc-200">
                  {t('ttsServiceLifecycleTitle')}
                </div>
                <div className="text-[10px] text-zinc-500 dark:text-zinc-400 leading-snug">
                  {t('ttsServiceLifecycleHint')}
                </div>
              </div>
              <span className="flex-shrink-0 px-2 py-1 rounded-md border border-black/10 dark:border-white/15 bg-white dark:bg-[#202127] text-[10px] font-medium text-zinc-700 dark:text-zinc-200 whitespace-nowrap shadow-sm">
                {t('ttsHotkeyTrigger')}
              </span>
            </div>

            {/* 内置运行环境与模型状态 */}
            <div className="space-y-2 mb-3">
              {/* 内置运行环境 */}
              <div className="flex items-center justify-between gap-2 px-2.5 py-2 rounded-lg bg-white dark:bg-[#202127] border border-black/5 dark:border-white/5">
                <div className="flex items-center gap-2 min-w-0">
                  <span
                    className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                      ttsStatus?.runtimeReady !== false ? 'bg-emerald-500' : 'bg-red-500'
                    }`}
                  />
                  <div className="min-w-0">
                    <div className="text-[11px] font-medium text-zinc-700 dark:text-zinc-200 truncate">
                      {t('runtimeLabel')}
                    </div>
                    <div className="text-[10px] text-zinc-400 dark:text-zinc-500 truncate">
                      {t('ttsRuntimeDesc')}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  {ttsStatus?.runtimeReady !== false ? (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 text-[10px] font-medium">
                      <Check className="w-3 h-3" />
                      <span>{t('runtimeBundledReady')}</span>
                    </span>
                  ) : (
                    <span className="text-[10px] text-red-500 font-medium">
                      {t('runtimeMissing')}
                    </span>
                  )}
                </div>
              </div>

              {/* 模型状态 / 下载 */}
              <div className="flex items-center justify-between gap-2 px-2.5 py-2 rounded-lg bg-white dark:bg-[#202127] border border-black/5 dark:border-white/5">
                <div className="flex items-center gap-2 min-w-0">
                  <span
                    className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                      ttsStatus?.model?.ready
                        ? 'bg-emerald-500'
                        : ttsStatus?.download?.active
                        ? 'bg-sky-500 animate-pulse'
                        : 'bg-red-500'
                    }`}
                  />
                  <div className="min-w-0">
                    <div className="text-[11px] font-medium text-zinc-700 dark:text-zinc-200 truncate">
                      {t('ttsModelLabel')}
                    </div>
                    <div className="text-[10px] text-zinc-400 dark:text-zinc-500 font-mono">
                      {ttsStatus?.model?.ready
                        ? `${(ttsStatus.model.bytes / 1024 ** 3).toFixed(2)} GB`
                        : ttsStatus?.model?.sizeDesc || '1.6 GB'}
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-2 flex-shrink-0">
                  {ttsStatus?.model?.ready ? (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 text-[10px] font-medium">
                      <Check className="w-3 h-3" />
                      <span>{t('ttsModelReady')}</span>
                    </span>
                  ) : ttsStatus?.download?.active ? (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-sky-500/10 text-sky-600 dark:text-sky-400 text-[10px] font-medium">
                      <Loader2 className="w-3 h-3 animate-spin" />
                      <span>{t('ttsDownloading')}</span>
                    </span>
                  ) : (
                    <>
                      <span className="text-[10px] text-red-500 font-medium">
                        {t('ttsModelMissing')}
                      </span>
                      {ttsStatus && !ttsStatus.download?.active && (
                        <button
                          type="button"
                          disabled={ttsBusy}
                          onClick={handleTtsDownload}
                          className="px-2 py-0.5 rounded-md bg-sky-600 hover:bg-sky-700 disabled:opacity-50 text-white text-[10px] font-medium transition-colors cursor-pointer"
                        >
                          {t('ttsDownloadBtn')}
                        </button>
                      )}
                    </>
                  )}
                </div>
              </div>
            </div>

            {/* 自动测速与实时下载进度面板 */}
            {ttsStatus?.download?.active && (
              <div className="mt-3 p-2.5 rounded-lg bg-sky-500/5 dark:bg-sky-500/10 border border-sky-500/20 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5 min-w-0 text-[11px] font-medium text-sky-700 dark:text-sky-300">
                    <Loader2 className="w-3.5 h-3.5 animate-spin flex-shrink-0" />
                    <span className="truncate">
                      {ttsStatus.download.phase === 'probing'
                        ? t('ttsProbingSource')
                        : ttsStatus.download.phase === 'cleaning'
                        ? t('ttsCleaningCache')
                        : ttsStatus.download.currentFile ||
                          t('ttsModelLabel')}
                    </span>
                  </div>
                  <button
                    type="button"
                    disabled={ttsBusy}
                    onClick={handleTtsCancelDownload}
                    className="px-2 py-0.5 rounded-md border border-red-500/30 bg-red-500/10 hover:bg-red-500/20 text-red-600 dark:text-red-400 text-[10px] font-medium transition-colors flex-shrink-0 cursor-pointer"
                  >
                    {t('ttsCancelDownloadBtn')}
                  </button>
                </div>

                {ttsStatus.download.selectedSource && (
                  <div className="text-[10px] text-zinc-500 dark:text-zinc-400 flex items-center justify-between">
                    <span>
                      {t('ttsSelectedSourceLabel')}:{' '}
                      <strong className="font-medium text-zinc-700 dark:text-zinc-200">
                        {formatSourceName(ttsStatus.download.selectedSource, t)}
                      </strong>{' '}
                      ({ttsStatus.download.selectedSource.latencyMs}ms)
                    </span>
                    <span className="font-mono text-sky-600 dark:text-sky-400 font-semibold">
                      {ttsStatus.download.progressPercent.toFixed(1)}%
                    </span>
                  </div>
                )}

                <div className="w-full h-1.5 rounded-full bg-black/10 dark:bg-white/10 overflow-hidden">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-sky-500 to-emerald-500 transition-all duration-200"
                    style={{
                      width: `${Math.max(
                        3,
                        Math.min(100, ttsStatus.download.progressPercent || 0)
                      )}%`,
                    }}
                  />
                </div>

                {ttsStatus.download.phase === 'downloading' && (
                  <div className="flex items-center justify-between text-[10px] font-mono text-zinc-500 dark:text-zinc-400">
                    <span>
                      {(ttsStatus.download.downloadedBytes / (1024 * 1024)).toFixed(1)} MB /{' '}
                      {(ttsStatus.download.totalBytes / (1024 * 1024)).toFixed(1)} MB
                    </span>
                    <span>
                      {(ttsStatus.download.speedBps / (1024 * 1024)).toFixed(2)} MB/s
                      {ttsStatus.download.etaSeconds !== null &&
                      ttsStatus.download.etaSeconds > 0
                        ? ` · ETA ${Math.floor(ttsStatus.download.etaSeconds / 60)}m${String(
                            ttsStatus.download.etaSeconds % 60
                          ).padStart(2, '0')}s`
                        : ''}
                    </span>
                  </div>
                )}
              </div>
            )}

            {/* 下载结果提示 */}
            {!ttsStatus?.download?.active &&
              ttsStatus?.download?.phase === 'completed' && (
                <div className="mt-2.5 text-[11px] text-emerald-600 dark:text-emerald-400 font-medium">
                  {t('ttsDownloadCompleted')}
                </div>
              )}
            {!ttsStatus?.download?.active &&
              ttsStatus?.download?.phase === 'cancelled' && (
                <div className="mt-2.5 text-[11px] text-amber-600 dark:text-amber-400">
                  {t('ttsDownloadCancelled')}
                </div>
              )}
            {!ttsStatus?.download?.active &&
              ttsStatus?.download?.phase === 'error' &&
              ttsStatus?.download?.error && (
                <div className="mt-2.5 text-[11px] text-red-500">
                  {formatDownloadError(ttsStatus.download.error, t)}
                </div>
              )}

            {/* 默认配置项：音色 + 采样参数（每次生成现场加载，不再有闲置卸载设置） */}
            <div className="mt-3 grid grid-cols-2 gap-2.5">
              <div className="flex flex-col gap-1">
                <span className="text-[10px] text-zinc-500 dark:text-zinc-400 font-medium">{t('ttsVoiceLabel')}</span>
                <select
                  value={ttsForm.voice ?? ttsStatus?.config?.voice ?? 'serena'}
                  onChange={(e) => setTtsForm((prev) => ({ ...prev, voice: e.target.value }))}
                  disabled={ttsBusy || isApplyingTts}
                  className="px-2 py-1.5 rounded-lg text-[11px] bg-white dark:bg-[#202127] border border-black/10 dark:border-white/10 text-zinc-700 dark:text-zinc-200 cursor-pointer focus:border-sky-500 focus:outline-none"
                >
                  {(ttsStatus?.voices || ['serena']).map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex flex-col gap-1 justify-end">
                <span className="text-[10px] text-zinc-500 dark:text-zinc-400 font-medium">
                  {t('ttsSamplingTitle')}
                </span>
                <span className="text-[10px] text-zinc-400 dark:text-zinc-500 leading-snug">
                  {t('ttsSamplingHint')}
                </span>
              </div>
            </div>

            <div className="mt-2 grid grid-cols-3 gap-2">
              {TTS_PARAM_FIELDS.map((field) => {
                const current =
                  ttsForm[field.key] ?? ttsStatus?.config?.[field.key] ?? TTS_CARD_DEFAULTS[field.key];
                return (
                  <label key={field.key} className="flex flex-col gap-1">
                    <span className="text-[10px] text-zinc-500 dark:text-zinc-400 font-medium truncate" title={t(field.labelKey)}>
                      {t(field.labelKey)}
                    </span>
                    <input
                      type="number"
                      min={field.min}
                      max={field.max}
                      step={field.step}
                      value={current}
                      disabled={ttsBusy || isApplyingTts}
                      onChange={(e) => {
                        const raw = Number(e.target.value);
                        if (!Number.isFinite(raw)) return;
                        const clamped = Math.min(field.max, Math.max(field.min, raw));
                        setTtsForm((prev) => ({ ...prev, [field.key]: clamped }));
                      }}
                      className="w-full px-2 py-1.5 rounded-lg text-[11px] font-mono bg-white dark:bg-[#202127] border border-black/10 dark:border-white/10 text-zinc-700 dark:text-zinc-200 focus:border-sky-500 focus:outline-none"
                    />
                  </label>
                );
              })}
            </div>

            {/* 保存配置按钮与反馈 */}
            <div className="mt-3 flex items-center justify-between">
              <button
                type="button"
                disabled={ttsBusy || isApplyingTts}
                onClick={handleTtsApply}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs bg-sky-600 hover:bg-sky-500 active:scale-[0.98] disabled:opacity-50 text-white font-medium shadow-sm transition-all cursor-pointer"
              >
                {isApplyingTts && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                <span>{isApplyingTts ? t('ttsApplying') : t('ttsApplyBtn')}</span>
              </button>
              {ttsMsg && (
                <span
                  className={`text-xs ${
                    ttsMsg.isError ? 'text-red-500' : 'text-emerald-600 dark:text-emerald-400'
                  }`}
                >
                  {ttsMsg.text}
                </span>
              )}
            </div>

            {/* 底部操作栏：一键测速下载模型 + 打开模型目录 */}
            <div className="mt-3 flex items-center gap-2">
              {ttsStatus && !ttsStatus.model?.ready && !ttsStatus.download?.active && (
                <button
                  type="button"
                  disabled={ttsBusy}
                  onClick={handleTtsDownload}
                  className="flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg bg-sky-600 hover:bg-sky-500 active:scale-[0.98] disabled:opacity-50 text-white text-xs font-medium transition-all shadow-sm cursor-pointer"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>{t('ttsDownloadAllBtn')}</span>
                </button>
              )}
              <button
                type="button"
                onClick={handleTtsOpenDir}
                className="flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg bg-black/5 hover:bg-black/10 dark:bg-white/5 dark:hover:bg-white/10 text-zinc-700 dark:text-zinc-200 border border-black/10 dark:border-white/10 text-xs font-medium transition-all active:scale-95 cursor-pointer"
              >
                <FolderOpen className="w-3.5 h-3.5 text-zinc-500 dark:text-zinc-400" />
                <span>{t('ttsOpenModelsDirBtn')}</span>
              </button>
            </div>

            {cardResetButton(handleTtsCardReset)}
          </div>

          {/* 实时字幕服务卡片 */}
          <div className="p-3.5 rounded-xl border border-black/10 dark:border-[#343740] bg-[#f8f9fb] dark:bg-[#18191c]">
            {/* 头部：标题 + 引擎徽标 + 运行状态指示 */}
            <div className="flex items-start justify-between mb-2.5">
              <div className="flex items-center gap-2 pt-0.5">
                <FileText className="w-4 h-4 text-cyan-600 dark:text-cyan-400 flex-shrink-0" />
                <span className="font-semibold text-xs text-[#1f2328] dark:text-[#f1f3f7]">
                  {t('subtitleServiceTitle')}
                </span>
                <span className="text-[10px] px-1.5 py-0.5 rounded-md font-mono bg-cyan-500/10 text-cyan-600 dark:text-cyan-400 font-medium">
                  {t('subtitleEngineTag')}
                </span>
              </div>
              {subtitleStatus && (() => {
                const subtitleCardState = deriveServiceState({
                  running: subtitleStatus.running,
                  loading: subtitleStatus.loading,
                  loaded: subtitleStatus.allReady,
                  paused: subtitleStatus.paused,
                });
                // 双端口：ASR（切句/识别）与翻译各一个；缺哪个就只写另一个，不补默认值
                const subtitlePort =
                  subtitleStatus.asrPort && subtitleStatus.port
                    ? `${subtitleStatus.asrPort}/${subtitleStatus.port}`
                    : subtitleStatus.port ?? subtitleStatus.asrPort;
                return (
                  <div className="flex flex-col items-end gap-1">
                    <div className="flex items-center gap-1.5 text-[11px]">
                      <span
                        className={`w-2 h-2 rounded-full flex-shrink-0 ${
                          SERVICE_STATE_CARD_DOT_CLASS[subtitleCardState]
                        }`}
                      />
                      <span className={SERVICE_STATE_CARD_TEXT_CLASS[subtitleCardState]}>
                        {formatServiceStateText(subtitleCardState, t, subtitlePort)}
                      </span>
                    </div>
                    <span className="text-[10px] text-zinc-400 dark:text-zinc-500 text-right leading-tight select-none">
                      {subtitleStatus.downloadState?.active
                        ? `${t('subtitleDetailDownloading')} (${subtitleStatus.downloadState.progressPercent.toFixed(1)}%)`
                        : subtitleStatus.loading
                        ? `${t('subtitleDetailLoading')} (${Math.min(3, (subtitleStatus.loadingStage || 0) + 1)}/3)`
                        : subtitleStatus.running
                        ? t('subtitleDetailActive')
                        : subtitleStatus.paused
                        ? t('subtitleDetailPaused')
                        : subtitleStatus.allReady
                        ? t('subtitleDetailStandby')
                        : t('subtitleDetailMissing')}
                    </span>
                  </div>
                );
              })()}
            </div>

            {/* 功能定位与触发横幅 */}
            <div className="flex items-center justify-between gap-2 mb-3 px-2.5 py-2 rounded-lg bg-cyan-500/5 dark:bg-cyan-500/10 border border-cyan-500/20">
              <div className="min-w-0">
                <div className="text-[11px] font-medium text-zinc-700 dark:text-zinc-200">
                  {t('subtitleServiceLifecycleTitle')}
                </div>
                <div className="text-[10px] text-zinc-500 dark:text-zinc-400 leading-snug">
                  {t('subtitleServiceLifecycleHint')}
                </div>
              </div>
              <span className="flex-shrink-0 px-2 py-1 rounded-md border border-black/10 dark:border-white/15 bg-white dark:bg-[#202127] text-[10px] font-medium text-zinc-700 dark:text-zinc-200 whitespace-nowrap shadow-sm">
                {t('subtitleHotkeyTrigger')}
              </span>
            </div>

            {/* 内置运行环境 */}
            <div className="flex items-center justify-between gap-2 mb-3 px-2.5 py-2 rounded-lg bg-white dark:bg-[#202127] border border-black/5 dark:border-white/5">
              <div className="flex items-center gap-2 min-w-0">
                <span
                  className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                    subtitleStatus?.runtimeReady !== false ? 'bg-emerald-500' : 'bg-red-500'
                  }`}
                />
                <div className="min-w-0">
                  <div className="text-[11px] font-medium text-zinc-700 dark:text-zinc-200 truncate">
                    {t('runtimeLabel')}
                  </div>
                  <div className="text-[10px] text-zinc-400 dark:text-zinc-500 truncate">
                    {t('subtitleRuntimeDesc')}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                {subtitleStatus?.runtimeReady !== false ? (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 text-[10px] font-medium">
                    <Check className="w-3 h-3" />
                    <span>{t('runtimeBundledReady')}</span>
                  </span>
                ) : (
                  <span className="text-[10px] text-red-500 font-medium">
                    {t('runtimeMissing')}
                  </span>
                )}
              </div>
            </div>

            {/* 两级流式模型完备状态清单 */}
            <div>
              <div className="text-[11px] font-medium text-zinc-600 dark:text-zinc-400 mb-2">
                {t('subtitleModelsSectionTitle')}
              </div>
              <div className="space-y-1.5">
                {(
                  [
                    { key: 'asr' as const, label: t('subtitleModelStage1'), fallbackSize: '2.31 GB' },
                    { key: 'segment' as const, label: t('subtitleModelStage2'), fallbackSize: '250 MB' },
                    { key: 'translate' as const, label: t('subtitleModelStage3'), fallbackSize: '1.25 GB' },
                  ]
                ).map((item) => {
                  const m = subtitleStatus?.modelsStatus?.[item.key];
                  const isReady = Boolean(m?.ready);
                  const isDownloadingThis =
                    Boolean(subtitleStatus?.downloadState?.active) &&
                    subtitleStatus?.downloadState?.currentModelKey === item.key;

                  const formatDiskSize = (bytes?: number, desc?: string) => {
                    if (!bytes || bytes <= 0) return desc || item.fallbackSize;
                    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
                    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
                    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
                  };

                  return (
                    <div
                      key={item.key}
                      className="flex items-center justify-between gap-2 px-2.5 py-2 rounded-lg bg-white dark:bg-[#202127] border border-black/5 dark:border-white/5"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <span
                          className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                            isReady
                              ? 'bg-emerald-500'
                              : isDownloadingThis
                              ? 'bg-cyan-500 animate-pulse'
                              : 'bg-red-500'
                          }`}
                        />
                        <div className="min-w-0">
                          <div className="text-[11px] font-medium text-zinc-700 dark:text-zinc-200 truncate">
                            {item.label}
                          </div>
                          <div className="text-[10px] text-zinc-400 dark:text-zinc-500 font-mono">
                            {isReady
                              ? formatDiskSize(m?.sizeBytes, m?.sizeDesc)
                              : m?.sizeDesc || item.fallbackSize}
                          </div>
                        </div>
                      </div>

                      <div className="flex items-center gap-2 flex-shrink-0">
                        {isReady ? (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 text-[10px] font-medium">
                            <Check className="w-3 h-3" />
                            <span>{t('subtitleModelReady')}</span>
                          </span>
                        ) : isDownloadingThis ? (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-cyan-500/10 text-cyan-600 dark:text-cyan-400 text-[10px] font-medium">
                            <Loader2 className="w-3 h-3 animate-spin" />
                            <span>{t('subtitleStatusDownloading')}</span>
                          </span>
                        ) : (
                          <>
                            <span className="text-[10px] text-red-500 font-medium">
                              {t('subtitleModelMissing')}
                            </span>
                            {!subtitleStatus?.downloadState?.active && (
                              <button
                                type="button"
                                disabled={subtitleBusy}
                                onClick={() => handleSubtitleDownload(item.key)}
                                className="px-2 py-0.5 rounded-md bg-cyan-600 hover:bg-cyan-700 disabled:opacity-50 text-white text-[10px] font-medium transition-colors cursor-pointer"
                              >
                                {t('subtitleDownloadSingleBtn')}
                              </button>
                            )}
                          </>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* 自动测速与实时下载进度面板 */}
            {subtitleStatus?.downloadState?.active && (
              <div className="mt-3 p-2.5 rounded-lg bg-cyan-500/5 dark:bg-cyan-500/10 border border-cyan-500/20 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5 min-w-0 text-[11px] font-medium text-cyan-700 dark:text-cyan-300">
                    <Loader2 className="w-3.5 h-3.5 animate-spin flex-shrink-0" />
                    <span className="truncate">
                      {subtitleStatus.downloadState.phase === 'probing'
                        ? t('subtitleProbingSource')
                        : subtitleStatus.downloadState.phase === 'cleaning'
                        ? t('subtitleCleaningCache')
                        : subtitleStatus.downloadState.currentFile ||
                          getSubtitleModelDisplayName(
                            subtitleStatus.downloadState.currentModelKey,
                            subtitleStatus.downloadState.currentModelName,
                            t
                          )}
                    </span>
                  </div>
                  <button
                    type="button"
                    disabled={subtitleBusy}
                    onClick={handleSubtitleCancelDownload}
                    className="px-2 py-0.5 rounded-md border border-red-500/30 bg-red-500/10 hover:bg-red-500/20 text-red-600 dark:text-red-400 text-[10px] font-medium transition-colors flex-shrink-0 cursor-pointer"
                  >
                    {t('subtitleCancelDownloadBtn')}
                  </button>
                </div>

                {subtitleStatus.downloadState.selectedSource && (
                  <div className="text-[10px] text-zinc-500 dark:text-zinc-400 flex items-center justify-between">
                    <span>
                      {t('subtitleSelectedSourceLabel')}:{' '}
                      <strong className="font-medium text-zinc-700 dark:text-zinc-200">
                        {formatSourceName(subtitleStatus.downloadState.selectedSource, t)}
                      </strong>{' '}
                      ({subtitleStatus.downloadState.selectedSource.latencyMs}ms)
                    </span>
                    <span className="font-mono text-cyan-600 dark:text-cyan-400 font-semibold">
                      {subtitleStatus.downloadState.progressPercent.toFixed(1)}%
                    </span>
                  </div>
                )}

                <div className="w-full h-1.5 rounded-full bg-black/10 dark:bg-white/10 overflow-hidden">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-cyan-500 to-emerald-500 transition-all duration-200"
                    style={{
                      width: `${Math.max(
                        3,
                        Math.min(100, subtitleStatus.downloadState.progressPercent || 0)
                      )}%`,
                    }}
                  />
                </div>

                {subtitleStatus.downloadState.phase === 'downloading' && (
                  <div className="flex items-center justify-between text-[10px] font-mono text-zinc-500 dark:text-zinc-400">
                    <span>
                      {(subtitleStatus.downloadState.downloadedBytes / (1024 * 1024)).toFixed(1)} MB /{' '}
                      {(subtitleStatus.downloadState.totalBytes / (1024 * 1024)).toFixed(1)} MB
                    </span>
                    <span>
                      {(subtitleStatus.downloadState.speedBps / (1024 * 1024)).toFixed(2)} MB/s
                      {subtitleStatus.downloadState.etaSeconds !== null &&
                      subtitleStatus.downloadState.etaSeconds > 0
                        ? ` · ETA ${Math.floor(subtitleStatus.downloadState.etaSeconds / 60)}m${String(
                            subtitleStatus.downloadState.etaSeconds % 60
                          ).padStart(2, '0')}s`
                        : ''}
                    </span>
                  </div>
                )}
              </div>
            )}

            {/* 下载结果提示 */}
            {!subtitleStatus?.downloadState?.active &&
              subtitleStatus?.downloadState?.phase === 'completed' && (
                <div className="mt-2.5 text-[11px] text-emerald-600 dark:text-emerald-400 font-medium">
                  {t('translateDownloadCompleted')}
                </div>
              )}
            {!subtitleStatus?.downloadState?.active &&
              subtitleStatus?.downloadState?.phase === 'cancelled' && (
                <div className="mt-2.5 text-[11px] text-amber-600 dark:text-amber-400">
                  {t('subtitleDownloadCancelled')}
                </div>
              )}
            {!subtitleStatus?.downloadState?.active &&
              subtitleStatus?.downloadState?.phase === 'error' &&
              subtitleStatus?.downloadState?.error && (
                <div className="mt-2.5 text-[11px] text-red-500">
                  {formatDownloadError(subtitleStatus.downloadState.error, t)}
                </div>
              )}

            {/* 底部操作栏：一键自动测速下载缺失模型 + 打开模型目录 */}
            <div className="mt-3 flex items-center gap-2">
              {subtitleStatus && !subtitleStatus.modelsReady && !subtitleStatus.downloadState?.active && (
                <button
                  type="button"
                  disabled={subtitleBusy}
                  onClick={() => handleSubtitleDownload('all')}
                  className="flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg bg-cyan-600 hover:bg-cyan-500 active:scale-[0.98] disabled:opacity-50 text-white text-xs font-medium transition-all shadow-sm cursor-pointer"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>{t('subtitleDownloadAllBtn')}</span>
                </button>
              )}
              <button
                type="button"
                onClick={handleSubtitleOpenDir}
                className="flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg bg-black/5 hover:bg-black/10 dark:bg-white/5 dark:hover:bg-white/10 text-zinc-700 dark:text-zinc-200 border border-black/10 dark:border-white/10 text-xs font-medium transition-all active:scale-95 cursor-pointer"
              >
                <FolderOpen className="w-3.5 h-3.5 text-zinc-500 dark:text-zinc-400" />
                <span>{t('subtitleOpenModelsDirBtn')}</span>
              </button>
            </div>

            {cardResetButton(undefined, true)}
          </div>

          {/* 快速翻译服务卡片（快速模式：端侧翻译小模型 · 详解模式：DeepSeek / 基础模型服务） */}
          <div data-translate-card="1" className="p-3.5 rounded-xl border border-black/10 dark:border-[#343740] bg-[#f8f9fb] dark:bg-[#18191c]">
            {(() => {
              const quick = translateStatus?.quick;
              const isReady = Boolean(quick?.modelReady);
              const isDownloading = translateDlActive;
              // 与语音识别 / 语音合成一致：状态只由「进程存活 / 模型加载中 / 模型齐备」决定，
              // 下载进度走右上角第二行，不把状态灯染成启动中。
              const cardState = deriveServiceState({
                running: quick?.serverReady,
                loading: Boolean(quick?.starting),
                loaded: isReady,
              });

              return (
                <>
                  {/* 头部：标题 + 引擎徽标 + 运行状态指示 */}
                  <div className="flex items-start justify-between mb-2.5">
                    <div className="flex items-center gap-2 pt-0.5">
                      <Languages className="w-4 h-4 text-indigo-600 dark:text-indigo-400 flex-shrink-0" />
                      <span className="font-semibold text-xs text-[#1f2328] dark:text-[#f1f3f7]">
                        {t('translateServiceTitle')}
                      </span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded-md font-mono bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 font-medium">
                        {t('translateEngineTag')}
                      </span>
                    </div>
                    <div className="flex flex-col items-end gap-1">
                      <div className="flex items-center gap-1.5 text-[11px]">
                        <span
                          className={`w-2 h-2 rounded-full flex-shrink-0 ${
                            SERVICE_STATE_CARD_DOT_CLASS[cardState]
                          }`}
                        />
                        <span className={SERVICE_STATE_CARD_TEXT_CLASS[cardState]}>
                          {formatServiceStateText(cardState, t, quick?.port)}
                        </span>
                      </div>
                      <span className="text-[10px] text-zinc-400 dark:text-zinc-500 text-right leading-tight select-none">
                        {isDownloading
                          ? `${t('translateDetailDownloading')} (${(translateDl?.progressPercent || 0).toFixed(1)}%)`
                          : quick?.starting
                          ? t('translateDetailLoading')
                          : quick?.serverReady
                          ? t('translateDetailActive')
                          : isReady
                          ? t('translateDetailStandby')
                          : t('translateDetailMissing')}
                      </span>
                    </div>
                  </div>

                  {/* 功能定位与快捷键横幅 */}
                  <div className="flex items-center justify-between gap-2 mb-3 px-2.5 py-2 rounded-lg bg-indigo-500/5 dark:bg-indigo-500/10 border border-indigo-500/20">
                    <div className="min-w-0">
                      <div className="text-[11px] font-medium text-zinc-700 dark:text-zinc-200">
                        {t('translateLifecycleTitle')}
                      </div>
                      <div className="text-[10px] text-zinc-500 dark:text-zinc-400 leading-snug">
                        {t('translatorGlobalShortcutTip')}
                      </div>
                    </div>
                    <kbd className="flex-shrink-0 px-2 py-1 rounded-md border border-black/10 dark:border-white/15 bg-white dark:bg-[#202127] text-[10px] font-mono text-zinc-700 dark:text-zinc-200 whitespace-nowrap shadow-sm">
                      {t('translateHotkeyTrigger')}
                    </kbd>
                  </div>

                  {/* 内置运行环境与模型状态 */}
                  <div className="space-y-2 mb-3">
                    {/* 内置运行环境 */}
                    <div className="flex items-center justify-between gap-2 px-2.5 py-2 rounded-lg bg-white dark:bg-[#202127] border border-black/5 dark:border-white/5">
                      <div className="flex items-center gap-2 min-w-0">
                        <span
                          className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                            quick?.runtimeReady ? 'bg-emerald-500' : 'bg-red-500'
                          }`}
                        />
                        <div className="min-w-0">
                          <div className="text-[11px] font-medium text-zinc-700 dark:text-zinc-200 truncate">
                            {t('runtimeLabel')}
                          </div>
                          <div className="text-[10px] text-zinc-400 dark:text-zinc-500 truncate">
                            {t('translateRuntimeDesc')}
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 flex-shrink-0">
                        {quick?.runtimeReady ? (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 text-[10px] font-medium">
                            <Check className="w-3 h-3" />
                            <span>{t('runtimeBundledReady')}</span>
                          </span>
                        ) : (
                          <span className="text-[10px] text-red-500 font-medium">
                            {t('runtimeMissing')}
                          </span>
                        )}
                      </div>
                    </div>

                    {/* 翻译模型状态 */}
                    <div className="flex items-center justify-between gap-2 px-2.5 py-2 rounded-lg bg-white dark:bg-[#202127] border border-black/5 dark:border-white/5">
                      <div className="flex items-center gap-2 min-w-0">
                        <span
                          className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                            isReady
                              ? 'bg-emerald-500'
                              : isDownloading
                              ? 'bg-indigo-500 animate-pulse'
                              : 'bg-red-500'
                          }`}
                        />
                        <div className="min-w-0">
                          <div className="text-[11px] font-medium text-zinc-700 dark:text-zinc-200 truncate">
                            {t('translateQuickModelLabel')}
                          </div>
                          <div className="text-[10px] text-zinc-400 dark:text-zinc-500 font-mono truncate">
                            {isReady
                              ? `${quick?.sizeDesc || '1.25 GB'} · ${t('runtimeBundledReady')}`
                              : t('translateModelDesc')}
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 flex-shrink-0">
                        {isReady ? (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 text-[10px] font-medium">
                            <Check className="w-3 h-3" />
                            <span>{t('subtitleModelReady')}</span>
                          </span>
                        ) : isDownloading ? (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 text-[10px] font-medium">
                            <Loader2 className="w-3 h-3 animate-spin" />
                            <span>{t('translateDetailDownloading')}</span>
                          </span>
                        ) : (
                          <>
                            <span className="text-[10px] text-red-500 font-medium">
                              {t('subtitleModelMissing')}
                            </span>
                            <button
                              type="button"
                              disabled={translateBusy}
                              onClick={handleTranslateDownload}
                              className="px-2 py-1 rounded-md text-[11px] font-medium transition-all active:scale-95 disabled:opacity-50 text-white bg-indigo-600 hover:bg-indigo-500 cursor-pointer"
                            >
                              {t('translateQuickDownloadBtn')}
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* 自动测速与实时下载进度面板 */}
                  {isDownloading && translateDl && (
                    <div className="mb-3 p-2.5 rounded-lg bg-indigo-500/5 dark:bg-indigo-500/10 border border-indigo-500/20 space-y-2">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-1.5 min-w-0 text-[11px] font-medium text-indigo-700 dark:text-indigo-300">
                          <Loader2 className="w-3.5 h-3.5 animate-spin flex-shrink-0" />
                          <span className="truncate">
                            {translateDl.phase === 'probing'
                              ? t('subtitleProbingSource')
                              : translateDl.phase === 'cleaning'
                              ? t('subtitleCleaningCache')
                              : translateDl.currentModelName || t('translateQuickModelLabel')}
                          </span>
                        </div>
                        <button
                          type="button"
                          disabled={translateBusy}
                          onClick={handleTranslateCancelDownload}
                          className="px-2 py-0.5 rounded-md border border-red-500/30 bg-red-500/10 hover:bg-red-500/20 text-red-600 dark:text-red-400 text-[10px] font-medium transition-colors flex-shrink-0 cursor-pointer"
                        >
                          {t('subtitleCancelDownloadBtn')}
                        </button>
                      </div>

                      {translateDl.selectedSource && (
                        <div className="text-[10px] text-zinc-500 dark:text-zinc-400 flex items-center justify-between">
                          <span>
                            {t('subtitleSelectedSourceLabel')}:{' '}
                            <strong className="font-medium text-zinc-700 dark:text-zinc-200">
                              {formatSourceName(translateDl.selectedSource, t)}
                            </strong>{' '}
                            ({translateDl.selectedSource.latencyMs}ms)
                          </span>
                          <span className="font-mono text-indigo-600 dark:text-indigo-400 font-semibold">
                            {(translateDl.progressPercent || 0).toFixed(1)}%
                          </span>
                        </div>
                      )}

                      <div className="w-full h-1.5 rounded-full bg-black/10 dark:bg-white/10 overflow-hidden">
                        <div
                          className="h-full rounded-full bg-gradient-to-r from-indigo-500 to-emerald-500 transition-all duration-200"
                          style={{
                            width: `${Math.max(3, Math.min(100, translateDl.progressPercent || 0))}%`,
                          }}
                        />
                      </div>

                      {translateDl.phase === 'downloading' && (
                        <div className="flex items-center justify-between text-[10px] font-mono text-zinc-500 dark:text-zinc-400">
                          <span>
                            {(translateDl.downloadedBytes / (1024 * 1024)).toFixed(1)} MB /{' '}
                            {(translateDl.totalBytes / (1024 * 1024)).toFixed(1)} MB
                          </span>
                          <span>
                            {(translateDl.speedBps / (1024 * 1024)).toFixed(2)} MB/s
                            {translateDl.etaSeconds !== null && translateDl.etaSeconds > 0
                              ? ` · ETA ${Math.floor(translateDl.etaSeconds / 60)}m${String(
                                  translateDl.etaSeconds % 60
                                ).padStart(2, '0')}s`
                              : ''}
                          </span>
                        </div>
                      )}
                    </div>
                  )}

                  {/* 下载结果提示 */}
                  {!isDownloading && translateDl?.phase === 'completed' && (
                    <div className="mb-2.5 text-[11px] text-emerald-600 dark:text-emerald-400 font-medium">
                      {t('translateDownloadCompleted')}
                    </div>
                  )}
                  {!isDownloading && translateDl?.phase === 'cancelled' && (
                    <div className="mb-2.5 text-[11px] text-amber-600 dark:text-amber-400">
                      {t('subtitleDownloadCancelled')}
                    </div>
                  )}
                  {!isDownloading && translateDl?.phase === 'error' && translateDl?.error && (
                    <div className="mb-2.5 text-[11px] text-red-500">
                      {formatDownloadError(translateDl.error, t)}
                    </div>
                  )}

                  {/* 详解模式：后端选择与 DeepSeek 配置 */}
                  <div className="mb-3">
                    <div className="flex items-center justify-between mb-1.5">
                      <label className="text-[10px] text-zinc-500 dark:text-zinc-400 font-medium">
                        {t('translateDetailMode')}
                      </label>
                      <span className="text-[10px] text-zinc-400 dark:text-zinc-500">
                        {t('translateDetailLockedHint')}
                      </span>
                    </div>
                    <div className="grid grid-cols-2 gap-2 mb-2">
                      <button
                        type="button"
                        onClick={() =>
                          setTranslateForm((prev) => ({ ...prev, detailProvider: 'deepseek' }))
                        }
                        className={`flex items-center justify-center gap-1.5 py-1.5 px-2 rounded-lg border text-[11px] font-medium transition-all cursor-pointer ${
                          translateForm.detailProvider !== 'base'
                            ? 'bg-sky-500/10 border-sky-500/40 text-sky-700 dark:text-sky-300 font-semibold'
                            : 'bg-[#f6f8fa] dark:bg-[#18191c] border-black/10 dark:border-[#343740] text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-white'
                        }`}
                      >
                        <KeyRound className="w-3 h-3" />
                        <span>{t('translateDetailDeepseek')}</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => setTranslateForm((prev) => ({ ...prev, detailProvider: 'base' }))}
                        className={`flex items-center justify-center gap-1.5 py-1.5 px-2 rounded-lg border text-[11px] font-medium transition-all cursor-pointer ${
                          translateForm.detailProvider === 'base'
                            ? 'bg-emerald-500/10 border-emerald-500/40 text-emerald-700 dark:text-emerald-300 font-semibold'
                            : 'bg-[#f6f8fa] dark:bg-[#18191c] border-black/10 dark:border-[#343740] text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-white'
                        }`}
                      >
                        <Cpu className="w-3 h-3" />
                        <span>{t('translateDetailBaseService')}</span>
                      </button>
                    </div>

                    {translateForm.detailProvider === 'base' ? (
                      <div className="flex items-center justify-between gap-2 px-2.5 py-2 rounded-lg bg-white dark:bg-[#202127] border border-black/5 dark:border-white/5">
                        <div className="flex items-center gap-2 min-w-0">
                          <span
                            className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                              translateStatus?.base?.running ? 'bg-emerald-500' : 'bg-red-500'
                            }`}
                          />
                          <div className="min-w-0">
                            <div className="text-[11px] font-medium text-zinc-700 dark:text-zinc-200 truncate">
                              {translateStatus?.base?.engine === 'mference'
                                ? 'Mference · Qwen 3.6 35B-A3B'
                                : 'TurboFieldfare · Gemma 4 26B'}
                            </div>
                            <div className="text-[10px] text-zinc-400 dark:text-zinc-500 font-mono">
                              {translateStatus?.base?.running
                                ? t('translateBaseRunning')
                                : t('translateBaseStopped')}
                            </div>
                          </div>
                        </div>
                        <span className="text-[10px] text-zinc-400 dark:text-zinc-500 text-right leading-snug max-w-[48%]">
                          {t('translateBaseServiceHint')}
                        </span>
                      </div>
                    ) : (
                      <div className="space-y-2">
                        <div>
                          <label className="block text-[10px] text-zinc-500 dark:text-zinc-400 mb-1">
                            {t('translateDeepseekKeyLabel')}
                          </label>
                          <div className="relative">
                            <input
                              type={showTranslateKey ? 'text' : 'password'}
                              value={translateForm.apiKey}
                              onChange={(e) =>
                                setTranslateForm((prev) => ({ ...prev, apiKey: e.target.value }))
                              }
                              placeholder={
                                translateStatus?.deepseek?.configured
                                  ? translateStatus.deepseek.apiKeyMasked
                                  : t('translateDeepseekKeyPlaceholder')
                              }
                              className="w-full bg-[#f6f8fa] dark:bg-[#18191c] border border-black/10 dark:border-[#343740] rounded-lg pl-2.5 pr-8 py-1.5 text-[11px] text-[#1f2328] dark:text-[#e2e5eb] focus:border-indigo-500 focus:outline-none font-mono"
                            />
                            <button
                              type="button"
                              onClick={() => setShowTranslateKey((v) => !v)}
                              className="absolute right-1.5 top-1/2 -translate-y-1/2 p-1 rounded text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 cursor-pointer"
                              title={showTranslateKey ? t('hidePassword') : t('showPassword')}
                            >
                              {showTranslateKey ? (
                                <EyeOff className="w-3.5 h-3.5" />
                              ) : (
                                <Eye className="w-3.5 h-3.5" />
                              )}
                            </button>
                          </div>
                        </div>
                        <div className="grid grid-cols-2 gap-2">
                          <div>
                            <label className="block text-[10px] text-zinc-500 dark:text-zinc-400 mb-1">
                              {t('translateDeepseekBaseUrlLabel')}
                            </label>
                            <input
                              type="text"
                              value={translateForm.baseUrl}
                              onChange={(e) =>
                                setTranslateForm((prev) => ({ ...prev, baseUrl: e.target.value }))
                              }
                              placeholder={TRANSLATE_DEFAULTS.baseUrl}
                              className="w-full bg-[#f6f8fa] dark:bg-[#18191c] border border-black/10 dark:border-[#343740] rounded-lg px-2.5 py-1.5 text-[11px] text-[#1f2328] dark:text-[#e2e5eb] focus:border-indigo-500 focus:outline-none font-mono"
                            />
                          </div>
                          <div>
                            <label className="block text-[10px] text-zinc-500 dark:text-zinc-400 mb-1">
                              {t('translateDeepseekModelLabel')}
                            </label>
                            <input
                              type="text"
                              value={translateForm.modelId}
                              onChange={(e) =>
                                setTranslateForm((prev) => ({ ...prev, modelId: e.target.value }))
                              }
                              placeholder={TRANSLATE_DEFAULTS.modelId}
                              className="w-full bg-[#f6f8fa] dark:bg-[#18191c] border border-black/10 dark:border-[#343740] rounded-lg px-2.5 py-1.5 text-[11px] text-[#1f2328] dark:text-[#e2e5eb] focus:border-indigo-500 focus:outline-none font-mono"
                            />
                          </div>
                        </div>
                        <p className="text-[10px] text-zinc-400 dark:text-zinc-500 leading-snug">
                          {t('translateDeepseekIndependentHint')}
                        </p>
                      </div>
                    )}
                  </div>

                  {/* 基准语言 */}
                  <div className="mb-3">
                    <div className="flex items-center justify-between mb-1.5">
                      <label className="text-[10px] text-zinc-500 dark:text-zinc-400 font-medium">
                        {t('translatorBaseLang')}
                      </label>
                      <span className="text-[10px] text-zinc-400 dark:text-zinc-500">
                        {t('translatorBaseLangDefaultBadge')}
                      </span>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <button
                        type="button"
                        onClick={() => setTranslateForm((prev) => ({ ...prev, baseLang: 'zh' }))}
                        className={`py-1.5 px-2 rounded-lg border text-[11px] font-medium transition-all cursor-pointer ${
                          translateForm.baseLang !== 'en'
                            ? 'bg-indigo-600 text-white border-indigo-600 shadow-sm font-semibold'
                            : 'bg-[#f6f8fa] dark:bg-[#18191c] border-black/10 dark:border-[#343740] text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-white'
                        }`}
                      >
                        {t('translatorBaseLangZh')}
                      </button>
                      <button
                        type="button"
                        onClick={() => setTranslateForm((prev) => ({ ...prev, baseLang: 'en' }))}
                        className={`py-1.5 px-2 rounded-lg border text-[11px] font-medium transition-all cursor-pointer ${
                          translateForm.baseLang === 'en'
                            ? 'bg-indigo-600 text-white border-indigo-600 shadow-sm font-semibold'
                            : 'bg-[#f6f8fa] dark:bg-[#18191c] border-black/10 dark:border-[#343740] text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-white'
                        }`}
                      >
                        {t('translatorBaseLangEn')}
                      </button>
                    </div>
                    <p className="text-[10px] text-zinc-500 dark:text-zinc-400 mt-1.5 leading-relaxed">
                      {t('translatorBaseLangTip')}
                    </p>
                  </div>

                  {/* 保存配置按钮与反馈 */}
                  <div className="mb-3 flex items-center justify-between">
                    <button
                      type="button"
                      disabled={translateBusy || isApplyingTranslate}
                      onClick={handleTranslateApply}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs bg-indigo-600 hover:bg-indigo-500 active:scale-[0.98] disabled:opacity-50 text-white font-medium shadow-sm transition-all cursor-pointer"
                    >
                      {isApplyingTranslate && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                      <span>{isApplyingTranslate ? t('translateApplying') : t('translateApplyBtn')}</span>
                    </button>
                    {translateMsg && (
                      <span
                        className={`text-xs ${
                          translateMsg.isError ? 'text-red-500' : 'text-emerald-600 dark:text-emerald-400'
                        }`}
                      >
                        {translateMsg.text}
                      </span>
                    )}
                  </div>

                  {/* 快捷动作按钮栏 */}
                  <div className="mt-3 flex items-center gap-2 mb-3">
                    {!isReady && !isDownloading && (
                      <button
                        type="button"
                        disabled={translateBusy}
                        onClick={handleTranslateDownload}
                        className="flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 active:scale-95 text-white text-xs font-medium transition-all shadow-sm cursor-pointer disabled:opacity-50"
                      >
                        <Download className="w-3.5 h-3.5" />
                        <span>{t('translateQuickDownloadBtn')}</span>
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={handleTranslateOpenDir}
                      className="flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg bg-black/5 hover:bg-black/10 dark:bg-white/5 dark:hover:bg-white/10 text-zinc-700 dark:text-zinc-200 border border-black/10 dark:border-white/10 text-xs font-medium transition-all active:scale-95 cursor-pointer"
                    >
                      <FolderOpen className="w-3.5 h-3.5 text-zinc-500 dark:text-zinc-400" />
                      <span>{t('translateOpenModelsDirBtn')}</span>
                    </button>
                  </div>
                </>
              );
            })()}

            {cardResetButton(handleTranslateCardReset)}
          </div>

          {/* PaddleOCR 视觉文档识别服务卡片（纯按需 · 快捷键 ⌘⇧2） */}
          <div className="p-3.5 rounded-xl border border-black/10 dark:border-[#343740] bg-[#f8f9fb] dark:bg-[#18191c]">
            {/* 头部：标题 + 引擎徽标 + 运行状态指示 */}
            <div className="flex items-start justify-between mb-2.5">
              <div className="flex items-center gap-2 pt-0.5">
                <ScanText className="w-4 h-4 text-violet-600 dark:text-violet-400 flex-shrink-0" />
                <span className="font-semibold text-xs text-[#1f2328] dark:text-[#f1f3f7]">
                  {t('ocrServiceTitle')}
                </span>
                <span className="text-[10px] px-1.5 py-0.5 rounded-md font-mono bg-violet-500/10 text-violet-600 dark:text-violet-400 font-medium">
                  {t('ocrEngineTag')}
                </span>
              </div>
              {ocrStatus && (() => {
                const ocrCardState = deriveServiceState({
                  status: ocrStatus.status,
                  running: ocrStatus.running,
                  loaded: ocrStatus.model?.ready,
                });
                return (
                  <div className="flex flex-col items-end gap-1">
                    <div className="flex items-center gap-1.5 text-[11px]">
                      <span
                        className={`w-2 h-2 rounded-full flex-shrink-0 ${
                          SERVICE_STATE_CARD_DOT_CLASS[ocrCardState]
                        }`}
                      />
                      <span className={SERVICE_STATE_CARD_TEXT_CLASS[ocrCardState]}>
                        {formatServiceStateText(ocrCardState, t, ocrStatus.port)}
                      </span>
                    </div>
                    <span className="text-[10px] text-zinc-400 dark:text-zinc-500 text-right leading-tight select-none">
                      {ocrStatus.download?.active
                        ? `${t('ocrDetailDownloading')} (${ocrStatus.download.progressPercent.toFixed(1)}%)`
                        : ocrStatus.status === 'loading'
                        ? t('ocrDetailLoading')
                        : ocrStatus.running
                        ? t('ocrDetailActive')
                        : ocrStatus.model?.ready
                        ? t('ocrDetailStandby')
                        : t('ocrDetailMissing')}
                    </span>
                  </div>
                );
              })()}
            </div>

            {/* 功能定位与触发横幅 */}
            <div className="flex items-center justify-between gap-2 mb-3 px-2.5 py-2 rounded-lg bg-violet-500/5 dark:bg-violet-500/10 border border-violet-500/20">
              <div className="min-w-0">
                <div className="text-[11px] font-medium text-zinc-700 dark:text-zinc-200">
                  {t('ocrServiceLifecycleTitle')}
                </div>
                <div className="text-[10px] text-zinc-500 dark:text-zinc-400 leading-snug">
                  {t('ocrServiceLifecycleHint')}
                </div>
              </div>
              <kbd className="flex-shrink-0 px-2 py-1 rounded-md border border-black/10 dark:border-white/15 bg-white dark:bg-[#202127] text-[10px] font-mono text-zinc-700 dark:text-zinc-200 whitespace-nowrap shadow-sm">
                {t('ocrHotkeyTrigger')}
              </kbd>
            </div>

            {/* 内置运行环境与模型状态 */}
            <div className="space-y-2 mb-3">
              {/* 内置运行环境 */}
              <div className="flex items-center justify-between gap-2 px-2.5 py-2 rounded-lg bg-white dark:bg-[#202127] border border-black/5 dark:border-white/5">
                <div className="flex items-center gap-2 min-w-0">
                  <span
                    className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                      ocrStatus?.runtimeReady !== false ? 'bg-emerald-500' : 'bg-red-500'
                    }`}
                  />
                  <div className="min-w-0">
                    <div className="text-[11px] font-medium text-zinc-700 dark:text-zinc-200 truncate">
                      {t('runtimeLabel')}
                    </div>
                    <div className="text-[10px] text-zinc-400 dark:text-zinc-500 truncate">
                      {t('ocrRuntimeDesc')}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  {ocrStatus?.runtimeReady !== false ? (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 text-[10px] font-medium">
                      <Check className="w-3 h-3" />
                      <span>{t('runtimeBundledReady')}</span>
                    </span>
                  ) : (
                    <span className="text-[10px] text-red-500 font-medium">
                      {t('runtimeMissing')}
                    </span>
                  )}
                </div>
              </div>

              {/* 模型状态 / 下载 */}
              <div className="flex items-center justify-between gap-2 px-2.5 py-2 rounded-lg bg-white dark:bg-[#202127] border border-black/5 dark:border-white/5">
                <div className="flex items-center gap-2 min-w-0">
                  <span
                    className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                      ocrStatus?.model?.ready
                        ? 'bg-emerald-500'
                        : ocrStatus?.download?.active
                        ? 'bg-violet-500 animate-pulse'
                        : 'bg-red-500'
                    }`}
                  />
                  <div className="min-w-0">
                    <div className="text-[11px] font-medium text-zinc-800 dark:text-zinc-200 truncate">
                      {t('ocrModelLabel')}
                    </div>
                    <div className="text-[10px] text-zinc-400 dark:text-zinc-500 font-mono">
                      {ocrStatus?.model?.ready
                        ? `${(ocrStatus.model.bytes / 1024 ** 3).toFixed(2)} GB`
                        : ocrStatus?.model?.sizeDesc || '1.09 GB'}
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-2 flex-shrink-0">
                  {ocrStatus?.model?.ready ? (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 text-[10px] font-medium">
                      <Check className="w-3 h-3" />
                      <span>{t('ocrModelReady')}</span>
                    </span>
                  ) : ocrStatus?.download?.active ? (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-violet-500/10 text-violet-600 dark:text-violet-400 text-[10px] font-medium">
                      <Loader2 className="w-3 h-3 animate-spin" />
                      <span>{t('ocrDownloading')}</span>
                    </span>
                  ) : (
                    <>
                      <span className="text-[10px] text-red-500 font-medium">
                        {t('ocrModelMissing')}
                      </span>
                      {ocrStatus && !ocrStatus.download?.active && (
                        <button
                          type="button"
                          disabled={ocrBusy}
                          onClick={handleOcrDownload}
                          className="px-2 py-0.5 rounded-md bg-violet-600 hover:bg-violet-700 disabled:opacity-50 text-white text-[10px] font-medium transition-colors cursor-pointer"
                        >
                          {t('ocrDownloadBtn')}
                        </button>
                      )}
                    </>
                  )}
                </div>
              </div>
            </div>

            {/* 自动测速与实时下载进度面板 */}
            {ocrStatus?.download?.active && (
              <div className="mt-3 p-2.5 rounded-lg bg-violet-500/5 dark:bg-violet-500/10 border border-violet-500/20 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5 min-w-0 text-[11px] font-medium text-violet-700 dark:text-violet-300">
                    <Loader2 className="w-3.5 h-3.5 animate-spin flex-shrink-0" />
                    <span className="truncate">
                      {ocrStatus.download.phase === 'probing'
                        ? t('ocrProbingSource')
                        : ocrStatus.download.phase === 'cleaning'
                        ? t('ocrCleaningCache')
                        : ocrStatus.download.currentFile ||
                          t('ocrModelLabel')}
                    </span>
                  </div>
                  <button
                    type="button"
                    disabled={ocrBusy}
                    onClick={handleOcrCancelDownload}
                    className="px-2 py-0.5 rounded-md border border-red-500/30 bg-red-500/10 hover:bg-red-500/20 text-red-600 dark:text-red-400 text-[10px] font-medium transition-colors flex-shrink-0 cursor-pointer"
                  >
                    {t('ocrCancelDownloadBtn')}
                  </button>
                </div>

                {ocrStatus.download.selectedSource && (
                  <div className="text-[10px] text-zinc-500 dark:text-zinc-400 flex items-center justify-between">
                    <span>
                      {t('ocrSelectedSourceLabel')}:{' '}
                      <strong className="font-medium text-zinc-700 dark:text-zinc-200">
                        {formatSourceName(ocrStatus.download.selectedSource, t)}
                      </strong>{' '}
                      ({ocrStatus.download.selectedSource.latencyMs}ms)
                    </span>
                    <span className="font-mono text-violet-600 dark:text-violet-400 font-semibold">
                      {ocrStatus.download.progressPercent.toFixed(1)}%
                    </span>
                  </div>
                )}

                <div className="w-full h-1.5 rounded-full bg-black/10 dark:bg-white/10 overflow-hidden">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-violet-500 to-emerald-500 transition-all duration-200"
                    style={{
                      width: `${Math.max(
                        3,
                        Math.min(100, ocrStatus.download.progressPercent || 0)
                      )}%`,
                    }}
                  />
                </div>

                {ocrStatus.download.phase === 'downloading' && (
                  <div className="flex items-center justify-between text-[10px] font-mono text-zinc-500 dark:text-zinc-400">
                    <span>
                      {(ocrStatus.download.downloadedBytes / (1024 * 1024)).toFixed(1)} MB /{' '}
                      {(ocrStatus.download.totalBytes / (1024 * 1024)).toFixed(1)} MB
                    </span>
                    <span>
                      {(ocrStatus.download.speedBps / (1024 * 1024)).toFixed(2)} MB/s
                      {ocrStatus.download.etaSeconds !== null &&
                      ocrStatus.download.etaSeconds > 0
                        ? ` · ETA ${Math.floor(ocrStatus.download.etaSeconds / 60)}m${String(
                            ocrStatus.download.etaSeconds % 60
                          ).padStart(2, '0')}s`
                        : ''}
                    </span>
                  </div>
                )}
              </div>
            )}

            {/* 下载结果提示 */}
            {!ocrStatus?.download?.active &&
              ocrStatus?.download?.phase === 'completed' && (
                <div className="mt-2.5 text-[11px] text-emerald-600 dark:text-emerald-400 font-medium">
                  {t('ocrDownloadCompleted')}
                </div>
              )}
            {!ocrStatus?.download?.active &&
              ocrStatus?.download?.phase === 'cancelled' && (
                <div className="mt-2.5 text-[11px] text-amber-600 dark:text-amber-400">
                  {t('ocrDownloadCancelled')}
                </div>
              )}
            {!ocrStatus?.download?.active &&
              ocrStatus?.download?.phase === 'error' &&
              ocrStatus?.download?.error && (
                <div className="mt-2.5 text-[11px] text-red-500">
                  {formatDownloadError(ocrStatus.download.error, t)}
                </div>
              )}

            {/* 默认配置项：识别任务模式、分辨率预算、内存闲置释放 */}
            <div className="mt-3 grid grid-cols-1 sm:grid-cols-3 gap-2.5">
              <div className="flex flex-col gap-1">
                <span className="text-[10px] text-zinc-500 dark:text-zinc-400 font-medium">{t('ocrTaskLabel')}</span>
                <select
                  value={ocrForm.task ?? ocrStatus?.config?.task ?? 'ocr'}
                  onChange={(e) => setOcrForm((prev) => ({ ...prev, task: e.target.value as OcrConfig['task'] }))}
                  disabled={ocrBusy || isApplyingOcr}
                  className="px-2 py-1.5 rounded-lg text-[11px] bg-white dark:bg-[#202127] border border-black/10 dark:border-white/10 text-zinc-700 dark:text-zinc-200 cursor-pointer focus:border-violet-500 focus:outline-none"
                >
                  <option value="ocr">{t('ocrTaskDoc')}</option>
                  <option value="table">{t('ocrTaskTable')}</option>
                  <option value="formula">{t('ocrTaskFormula')}</option>
                  <option value="chart">{t('ocrTaskChart')}</option>
                </select>
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-[10px] text-zinc-500 dark:text-zinc-400 font-medium">{t('ocrResolutionLabel')}</span>
                <select
                  value={ocrForm.resolution ?? ocrStatus?.config?.resolution ?? 'high'}
                  onChange={(e) => setOcrForm((prev) => ({ ...prev, resolution: e.target.value as OcrConfig['resolution'] }))}
                  disabled={ocrBusy || isApplyingOcr}
                  className="px-2 py-1.5 rounded-lg text-[11px] bg-white dark:bg-[#202127] border border-black/10 dark:border-white/10 text-zinc-700 dark:text-zinc-200 cursor-pointer focus:border-violet-500 focus:outline-none"
                >
                  <option value="balanced">{t('ocrResBalanced')}</option>
                  <option value="high">{t('ocrResHigh')}</option>
                  <option value="max">{t('ocrResMax')}</option>
                </select>
              </div>
              <IdleTimeoutSelector
                value={ocrForm.idleUnloadMin ?? ocrStatus?.config?.idleUnloadMin ?? 30}
                onChange={(min) => setOcrForm((prev) => ({ ...prev, idleUnloadMin: min }))}
                disabled={ocrBusy || isApplyingOcr}
                t={t}
              />
            </div>

            {/* 保存配置按钮与反馈 */}
            <div className="mt-3 flex items-center justify-between">
              <button
                type="button"
                disabled={ocrBusy || isApplyingOcr}
                onClick={handleOcrApply}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs bg-violet-600 hover:bg-violet-500 active:scale-[0.98] disabled:opacity-50 text-white font-medium shadow-sm transition-all cursor-pointer"
              >
                {isApplyingOcr && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                <span>{isApplyingOcr ? t('ocrApplying') : t('ocrApplyBtn')}</span>
              </button>
              {ocrMsg && (
                <span
                  className={`text-xs ${
                    ocrMsg.isError ? 'text-red-500' : 'text-emerald-600 dark:text-emerald-400'
                  }`}
                >
                  {ocrMsg.text}
                </span>
              )}
            </div>

            {/* 底部操作栏：一键测速下载模型 + 打开模型目录 */}
            <div className="mt-3 flex items-center gap-2">
              {ocrStatus && !ocrStatus.model?.ready && !ocrStatus.download?.active && (
                <button
                  type="button"
                  disabled={ocrBusy}
                  onClick={handleOcrDownload}
                  className="flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg bg-violet-600 hover:bg-violet-500 active:scale-[0.98] disabled:opacity-50 text-white text-xs font-medium transition-all shadow-sm cursor-pointer"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>{t('ocrDownloadAllBtn')}</span>
                </button>
              )}
              <button
                type="button"
                onClick={handleOcrOpenDir}
                className="flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg bg-black/5 hover:bg-black/10 dark:bg-white/5 dark:hover:bg-white/10 text-zinc-700 dark:text-zinc-200 border border-black/10 dark:border-white/10 text-xs font-medium transition-all active:scale-95 cursor-pointer"
              >
                <FolderOpen className="w-3.5 h-3.5 text-zinc-500 dark:text-zinc-400" />
                <span>{t('ocrOpenModelsDirBtn')}</span>
              </button>
            </div>

            {cardResetButton(handleOcrCardReset)}
          </div>

        </div>

        {/* Footer actions：各卡片自带「恢复默认」与「应用」，这里只给一个关闭按钮 */}
        <div className="flex items-center justify-end px-5 py-3 border-t border-black/5 dark:border-[#2d3038] bg-[#f8f9fb] dark:bg-[#1a1b1e]">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-1.5 rounded-lg text-xs bg-blue-600 hover:bg-blue-500 text-white font-medium shadow transition-colors"
          >
            {t('serviceManagerDone')}
          </button>
        </div>
      </div>
    </div>
  );
};
