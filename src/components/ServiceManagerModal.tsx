import React, { useState, useEffect, useMemo, useRef } from 'react';
import { AppSettings, WikiStatusInfo, AsrServiceConfig, AsrServiceStatus, VoicePermissionStatus } from '../types/chat';
import { WikiAPI, ModelServiceAPI, ModelServiceStatus, ModelServiceConfig, ASRServiceAPI } from '../services/api';
import { resolveLanguage, formatArticleCount, translations, Language, TranslationKeys } from '../i18n';
import {
  SERVICE_STATE_CARD_DOT_CLASS,
  SERVICE_STATE_CARD_TEXT_CLASS,
  SERVICE_STATE_LABEL_KEY,
  toServiceState,
} from '../utils/serviceState';
import { X, RotateCcw, BookOpen, Server, ChevronDown, Mic, ShieldCheck, ExternalLink } from 'lucide-react';

interface ServiceManagerModalProps {
  isOpen: boolean;
  onClose: () => void;
  settings: AppSettings;
  /** 基础模型监听端口变更后回传，供上层同步「模型设置」卡片里的请求端口 */
  onApiPortChange?: (port: number) => void;
}

// 知识库卡片默认值（ZIM 路径默认值与后端 findZimFile 的兜底路径一致）
const KB_DEFAULT_ZIM_PATH = '/Volumes/JustinSSD/wikipedia/wikipedia_zh_all_maxi_2026-08.zim';
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

// 语音识别服务卡片默认值（与后端 asr_service.js DEFAULT_ASR_CONFIG 保持一致）
const ASR_CARD_DEFAULTS: Partial<AsrServiceConfig> = {
  port: 1236,
  backend: 'metal',
  threads: 4,
  language: 'auto',
  enableItn: true,
  audioChunkMode: 'none',
  audioChunkDurationSec: 30,
  keepTags: false,
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
 * 服务管理界面：三项受管服务（基础模型 / 知识库 / 语音识别）的全部启停与参数配置。
 *
 * 从 SettingsModal 里独立出来——设置界面只留「应用设置」与「模型设置」两张卡片。
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
  const [kbPort, setKbPort] = useState('31236');
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

  // ---- 语音识别服务（SenseVoice / audio.cpp）----
  const [asrStatus, setAsrStatus] = useState<AsrServiceStatus | null>(null);
  const [asrForm, setAsrForm] = useState<Partial<AsrServiceConfig>>({});
  const [asrBusy, setAsrBusy] = useState<string | null>(null);
  const [asrMsg, setAsrMsg] = useState<{ text: string; isError: boolean } | null>(null);
  const [asrLogsOpen, setAsrLogsOpen] = useState(false);
  const [asrLogLines, setAsrLogLines] = useState<string[] | null>(null);
  const asrLogsOpenRef = useRef(asrLogsOpen);
  asrLogsOpenRef.current = asrLogsOpen;
  /** 原生侧回推的三件套权限快照（浏览器调试模式下为 null） */
  const [voicePerm, setVoicePerm] = useState<VoicePermissionStatus | null>(null);

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

  // 打开时拉取三个服务的状态与配置，之后 3s 轮询（弹窗打开期间）
  useEffect(() => {
    if (isOpen) {
      setPathMessage(null);

      WikiAPI.getStatus().then((status) => {
        setWikiStatus(status);
        if (status?.zimPath) {
          setCustomZimPath(status.zimPath);
        } else if (settings.customWikiDir) {
          setCustomZimPath(settings.customWikiDir);
        }
        setKbPort(String(status?.port ?? 31236));
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

      refreshAsrStatus();
      ASRServiceAPI.getConfig().then((cfg) => {
        if (cfg) {
          setAsrForm(cfg);
        }
      });

      // 原生权限快照（三件套）
      requestVoicePermissions();

      pollTimerRef.current = setInterval(() => {
        refreshSvcStatus();
        refreshAsrStatus();
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
      setSvcMsg(null);
      setAsrLogsOpen(false);
      asrLogsOpenRef.current = false;
      setAsrLogLines(null);
      setAsrMsg(null);
    }
    return () => {
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
        setSvcMsg({ text: t('modelServicePathApplied'), isError: false });
      } else {
        setSvcMsg({ text: t('modelServiceActionFailed'), isError: true });
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
        setSvcMsg({
          text: r.restarted ? t('modelServiceApplyDone') : t('modelServiceApplySaved'),
          isError: false,
        });
      } else {
        setSvcMsg({ text: t('modelServiceActionFailed'), isError: true });
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
  const handleAsrToggle = async (next: boolean) => {
    setAsrBusy('toggle');
    try {
      await ASRServiceAPI.updateConfig({ enabled: next });
      await ASRServiceAPI.control(next ? 'start' : 'stop');
      await refreshAsrStatus();
    } finally {
      setAsrBusy(null);
    }
  };

  /** 路径 + 参数一并落盘；运行中则热重启（生成新的 audiocpp server.json） */
  const handleAsrApply = async () => {
    setAsrBusy('apply');
    setAsrMsg(null);
    try {
      const r = await ASRServiceAPI.updateConfig(
        {
          ...asrForm,
        },
        true
      );
      if (r.success) {
        setAsrMsg({ text: r.restarted ? t('asrApplyDone') : t('asrApplySaved'), isError: false });
      } else {
        setAsrMsg({ text: t('asrActionFailed'), isError: true });
      }
      await refreshAsrStatus();
    } finally {
      setAsrBusy(null);
    }
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
  const cardResetButton = (onClick: () => void) => (
    <div className="mt-3 flex">
      <button
        type="button"
        onClick={onClick}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs text-zinc-500 dark:text-[#8c929f] hover:text-zinc-900 dark:hover:text-white hover:bg-black/5 dark:hover:bg-[#2b2d35] transition-colors cursor-pointer"
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
    setAsrForm((prev) => ({ ...prev, ...ASR_CARD_DEFAULTS }));
    setAsrMsg(null);
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
        setPathMessage({ text: t('modelServicePathApplied'), isError: false });
      } else {
        setPathMessage({ text: t('kbPathFileNotFound'), isError: true });
      }
    } catch {
      setPathMessage({ text: t('kbPathFileNotFound'), isError: true });
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
        { zimPath: customZimPath.trim(), port: Number(kbPort) || 31236 },
        { restartIfRunning: true }
      );
      if (res.success !== false) {
        setWikiStatus(res);
        setPathMessage({
          text: res.restarted ? t('modelServiceApplyDone') : t('modelServiceApplySaved'),
          isError: false,
        });
      } else {
        setPathMessage({ text: t('kbPathFileNotFound'), isError: true });
      }
    } catch {
      setPathMessage({ text: t('kbPathFileNotFound'), isError: true });
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
  const currentEnginePort = currentEngineStatus?.port ?? (isMference ? (svcForm.mferencePort ?? 1241) : (svcForm.port ?? 1235));
  const isCurrentEngineActive =
    currentEngineStatus?.status === 'running' ||
    currentEngineStatus?.status === 'loading' ||
    currentEngineStatus?.status === 'starting' ||
    currentEngineStatus?.status === 'restart';

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm select-none">
      <div
        onClick={(e) => e.stopPropagation()}
        className="relative w-full max-w-lg rounded-2xl bg-white dark:bg-[#202227] border border-black/10 dark:border-[#353842] shadow-2xl overflow-hidden flex flex-col max-h-[90vh] text-[#1f2328] dark:text-[#cfd3dc]"
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
            <div className="flex items-center justify-between mb-2.5">
              <div className="flex items-center gap-2">
                <BookOpen className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
                <span className="font-semibold text-xs text-[#1f2328] dark:text-[#f1f3f7]">
                  {t('wikiKnowledgeBase')}
                </span>
              </div>
              {/* 状态加载后始终显示：断开（无论总开关关闭还是 ZIM 缺失）都是红点 + 红字「离线」，
                  区别仅在是否带原因后缀（开关关闭 = 用户自己关的，无需原因） */}
              {wikiStatus && (
                <div className="flex items-center gap-1.5 text-[11px]">
                  <span
                    className={`w-2 h-2 rounded-full ${
                      SERVICE_STATE_CARD_DOT_CLASS[toServiceState(wikiStatus.status)]
                    }`}
                  />
                  <span className={SERVICE_STATE_CARD_TEXT_CLASS[toServiceState(wikiStatus.status)]}>
                    {/* 与左下角、状态栏菜单同一套三态：就绪（带端口与词条数）/ 启动中 / 离线。
                        离线保留原因后缀：总开关开着却没连上 = 未找到 ZIM 文件；
                        总开关关闭 = 用户自己关的，不再给原因。 */}
                    {toServiceState(wikiStatus.status) === 'online'
                      ? `${t('wikiStatusConnected')}${wikiStatus.port ?? 31236}${
                          wikiStatus.articleCount > 0
                            ? ` (${formatArticleCount(wikiStatus.articleCount, activeLang)})`
                            : ''
                        }`
                      : toServiceState(wikiStatus.status) === 'starting'
                      ? t('statusStarting')
                      : wikiStatus.enabled
                      ? t('wikiStatusDisconnected')
                      : t('wikiStatusOffline')}
                  </span>
                </div>
              )}
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
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <Server className="w-4 h-4 text-amber-600 dark:text-amber-400" />
                <span className="font-semibold text-xs text-[#1f2328] dark:text-[#f1f3f7]">
                  {t('modelServiceTitle')}
                </span>
              </div>
              <div className="flex items-center gap-1.5 text-[11px]">
                <span
                  className={`w-2 h-2 rounded-full ${
                    SERVICE_STATE_CARD_DOT_CLASS[toServiceState(currentEngineStatus?.status)]
                  }`}
                />
                <span className={SERVICE_STATE_CARD_TEXT_CLASS[toServiceState(currentEngineStatus?.status)]}>
                  {toServiceState(currentEngineStatus?.status) === 'online'
                    ? `${t('modelServiceStatusRunning')}${currentEnginePort}`
                    : t(SERVICE_STATE_LABEL_KEY[toServiceState(currentEngineStatus?.status)])}
                </span>
              </div>
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
                  className={`py-1.5 px-2.5 rounded-lg text-xs font-medium transition-all flex items-center justify-between cursor-pointer ${
                    selectedEngine === 'turbo-fieldfare'
                      ? 'bg-white dark:bg-[#202127] text-amber-700 dark:text-amber-400 shadow-sm font-semibold'
                      : 'text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-white'
                  }`}
                >
                  <div className="flex items-center gap-1.5">
                    <span
                      className={`w-1.5 h-1.5 rounded-full ${
                        SERVICE_STATE_CARD_DOT_CLASS[toServiceState(svcStatus?.ttf?.status)]
                      }`}
                    />
                    <span>{t('modelEngineTTF')}</span>
                  </div>
                  <span className="text-[10px] font-mono opacity-60">
                    :{svcStatus?.ttf?.port ?? 1235}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => handleSwitchEngine('mference')}
                  className={`py-1.5 px-2.5 rounded-lg text-xs font-medium transition-all flex items-center justify-between cursor-pointer ${
                    selectedEngine === 'mference'
                      ? 'bg-white dark:bg-[#202127] text-amber-700 dark:text-amber-400 shadow-sm font-semibold'
                      : 'text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-white'
                  }`}
                >
                  <div className="flex items-center gap-1.5">
                    <span
                      className={`w-1.5 h-1.5 rounded-full ${
                        SERVICE_STATE_CARD_DOT_CLASS[toServiceState(svcStatus?.mference?.status)]
                      }`}
                    />
                    <span>{t('modelEngineMference')}</span>
                  </div>
                  <span className="text-[10px] font-mono opacity-60">
                    :{svcStatus?.mference?.port ?? 1241}
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

          {/* 语音识别服务卡片（SenseVoice / audio.cpp）——与基础模型服务同构，
              紧随其下：SimpleUI 同为 audiocpp_server 的唯一管理方 */}
          <div className="p-3.5 rounded-xl border border-black/10 dark:border-[#343740] bg-[#f8f9fb] dark:bg-[#18191c]">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <Mic className="w-4 h-4 text-violet-600 dark:text-violet-400" />
                <span className="font-semibold text-xs text-[#1f2328] dark:text-[#f1f3f7]">
                  {t('asrServiceTitle')}
                </span>
              </div>
              <div className="flex items-center gap-1.5 text-[11px]">
                <span
                  className={`w-2 h-2 rounded-full ${
                    SERVICE_STATE_CARD_DOT_CLASS[toServiceState(asrStatus?.status)]
                  }`}
                />
                <span className={SERVICE_STATE_CARD_TEXT_CLASS[toServiceState(asrStatus?.status)]}>
                  {/* 与左下角、状态栏菜单同一套三态：就绪（带端口）/ 启动中 / 离线 */}
                  {toServiceState(asrStatus?.status) === 'online'
                    ? `${t('asrServiceStatusRunning')}${asrStatus?.port}`
                    : t(SERVICE_STATE_LABEL_KEY[toServiceState(asrStatus?.status)])}
                </span>
              </div>
            </div>

            {/* 服务总开关 */}
            <div className="flex items-center justify-between gap-3 pb-3 mb-3 border-b border-black/5 dark:border-white/5">
              <button
                type="button"
                onClick={() => handleAsrToggle(!(asrStatus?.enabled ?? true))}
                disabled={asrBusy !== null}
                className="flex-1 min-w-0 text-left cursor-pointer disabled:cursor-not-allowed"
              >
                <div className="font-medium text-zinc-700 dark:text-zinc-200">{t('asrServiceToggle')}</div>
                <div className="text-[10px] text-zinc-500 dark:text-zinc-400">{t('asrServiceToggleDesc')}</div>
              </button>
              <button
                type="button"
                role="switch"
                aria-checked={asrStatus?.enabled ?? true}
                disabled={asrBusy !== null}
                onClick={() => handleAsrToggle(!(asrStatus?.enabled ?? true))}
                className={`relative w-10 h-[22px] rounded-full transition-colors flex-shrink-0 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none ${
                  asrStatus?.enabled ?? true ? 'bg-violet-600' : 'bg-zinc-300 dark:bg-zinc-600'
                }`}
              >
                <span
                  className={`absolute top-[2px] left-[2px] w-[18px] h-[18px] rounded-full bg-white shadow transition-transform duration-200 ${
                    asrStatus?.enabled ?? true ? 'translate-x-[18px]' : 'translate-x-0'
                  }`}
                />
              </button>
            </div>

            {/* 快捷键说明（长按右侧 Command） */}
            <div className="flex items-center justify-between gap-2 mb-3 px-2.5 py-2 rounded-lg bg-violet-500/5 dark:bg-violet-500/10 border border-violet-500/20">
              <div className="min-w-0">
                <div className="text-[11px] font-medium text-zinc-700 dark:text-zinc-200">
                  {t('asrHotkeyLabel')}
                </div>
                <div className="text-[10px] text-zinc-500 dark:text-zinc-400 leading-snug">
                  {t('asrHotkeyDesc')}
                </div>
              </div>
              <kbd className="flex-shrink-0 px-2 py-1 rounded-md border border-black/10 dark:border-white/15 bg-white dark:bg-[#202127] text-[10px] font-mono text-zinc-700 dark:text-zinc-200 whitespace-nowrap">
                {t('asrHotkeyValue')}
              </kbd>
            </div>

            {/* 前置检查提示 */}
            {asrStatus && !asrStatus.checks.binary && (
              <div className="text-[10px] text-zinc-500 dark:text-zinc-400 mb-0.5">{t('asrCheckBinary')}</div>
            )}
            {asrStatus && !asrStatus.checks.model && (
              <div className="text-[10px] text-zinc-500 dark:text-zinc-400 mb-0.5">{t('asrCheckModel')}</div>
            )}
            {/* 服务已启用但未运行，且后端留下了失败原因（如 GGUF 读取失败）时直接摊开 */}
            {asrStatus && asrStatus.enabled && asrStatus.status === 'stopped' && asrStatus.lastActionLog && (
              <pre className="mt-1 max-h-24 overflow-y-auto bg-red-500/5 dark:bg-red-500/10 border border-red-500/20 rounded-lg p-2 text-[10px] leading-relaxed font-mono text-red-600 dark:text-red-400 whitespace-pre-wrap break-all">
                {asrStatus.lastActionLog}
              </pre>
            )}
            {asrMsg && (
              <div
                className={`mt-1 text-[11px] ${
                  asrMsg.isError ? 'text-red-500' : 'text-emerald-600 dark:text-emerald-400 font-medium'
                }`}
              >
                {asrMsg.text}
              </div>
            )}

            {/* 识别参数 */}
            <div className="mt-3">
              <div className="text-[11px] font-medium text-zinc-600 dark:text-zinc-400 mb-1.5">
                {t('asrParamsTitle')}
              </div>
              <div className="grid grid-cols-2 gap-2.5">
                <div>
                  <label className="block text-[10px] text-zinc-500 dark:text-zinc-400 mb-1">{t('asrPortLabel')}</label>
                  <input
                    type="number"
                    min={1024}
                    max={65535}
                    value={asrForm.port ?? 1236}
                    onChange={(e) => setAsrForm({ ...asrForm, port: Number(e.target.value) || 1236 })}
                    className="w-full bg-[#f6f8fa] dark:bg-[#18191c] border border-black/10 dark:border-[#343740] rounded-lg px-2 py-1.5 text-xs text-[#1f2328] dark:text-[#e2e5eb] font-mono focus:border-violet-500 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-[10px] text-zinc-500 dark:text-zinc-400 mb-1">{t('asrBackendLabel')}</label>
                  <select
                    value={asrForm.backend ?? 'metal'}
                    onChange={(e) => setAsrForm({ ...asrForm, backend: e.target.value as AsrServiceConfig['backend'] })}
                    className="w-full bg-[#f6f8fa] dark:bg-[#18191c] border border-black/10 dark:border-[#343740] rounded-lg px-2 py-1.5 text-xs text-[#1f2328] dark:text-[#e2e5eb] focus:border-violet-500 focus:outline-none"
                  >
                    <option value="cpu">cpu</option>
                    <option value="metal">metal</option>
                    <option value="best">best</option>
                  </select>
                </div>
                <div>
                  <label className="block text-[10px] text-zinc-500 dark:text-zinc-400 mb-1">{t('asrLanguageLabel')}</label>
                  <select
                    value={asrForm.language ?? 'auto'}
                    onChange={(e) => setAsrForm({ ...asrForm, language: e.target.value as AsrServiceConfig['language'] })}
                    className="w-full bg-[#f6f8fa] dark:bg-[#18191c] border border-black/10 dark:border-[#343740] rounded-lg px-2 py-1.5 text-xs text-[#1f2328] dark:text-[#e2e5eb] focus:border-violet-500 focus:outline-none"
                  >
                    <option value="auto">{t('asrLanguageAuto')}</option>
                    <option value="zh">{t('asrLanguageZh')}</option>
                    <option value="en">{t('asrLanguageEn')}</option>
                    <option value="yue">{t('asrLanguageYue')}</option>
                    <option value="ja">{t('asrLanguageJa')}</option>
                    <option value="ko">{t('asrLanguageKo')}</option>
                  </select>
                </div>
                <div>
                  <label className="block text-[10px] text-zinc-500 dark:text-zinc-400 mb-1">{t('asrThreadsLabel')}</label>
                  <input
                    type="number"
                    min={1}
                    max={64}
                    value={asrForm.threads ?? 4}
                    onChange={(e) => setAsrForm({ ...asrForm, threads: Number(e.target.value) || 4 })}
                    className="w-full bg-[#f6f8fa] dark:bg-[#18191c] border border-black/10 dark:border-[#343740] rounded-lg px-2 py-1.5 text-xs text-[#1f2328] dark:text-[#e2e5eb] font-mono focus:border-violet-500 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-[10px] text-zinc-500 dark:text-zinc-400 mb-1">{t('asrChunkModeLabel')}</label>
                  <select
                    value={asrForm.audioChunkMode ?? 'none'}
                    onChange={(e) =>
                      setAsrForm({ ...asrForm, audioChunkMode: e.target.value as AsrServiceConfig['audioChunkMode'] })
                    }
                    className="w-full bg-[#f6f8fa] dark:bg-[#18191c] border border-black/10 dark:border-[#343740] rounded-lg px-2 py-1.5 text-xs text-[#1f2328] dark:text-[#e2e5eb] focus:border-violet-500 focus:outline-none"
                  >
                    <option value="none">{t('asrChunkNone')}</option>
                    <option value="auto">{t('asrChunkAuto')}</option>
                    <option value="fixed">{t('asrChunkFixed')}</option>
                  </select>
                </div>
                <div>
                  <label className="block text-[10px] text-zinc-500 dark:text-zinc-400 mb-1">{t('asrChunkDurationLabel')}</label>
                  <input
                    type="number"
                    min={1}
                    max={300}
                    value={asrForm.audioChunkDurationSec ?? 30}
                    onChange={(e) =>
                      setAsrForm({ ...asrForm, audioChunkDurationSec: Number(e.target.value) || 30 })
                    }
                    className="w-full bg-[#f6f8fa] dark:bg-[#18191c] border border-black/10 dark:border-[#343740] rounded-lg px-2 py-1.5 text-xs text-[#1f2328] dark:text-[#e2e5eb] font-mono focus:border-violet-500 focus:outline-none"
                  />
                </div>
              </div>

              <label className="mt-2.5 flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={asrForm.enableItn ?? true}
                  onChange={(e) => setAsrForm({ ...asrForm, enableItn: e.target.checked })}
                  className="w-3.5 h-3.5 accent-violet-600 cursor-pointer"
                />
                <span className="text-[11px] text-zinc-600 dark:text-zinc-300">{t('asrItnLabel')}</span>
              </label>
              <label className="mt-1.5 flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={asrForm.keepTags ?? false}
                  onChange={(e) => setAsrForm({ ...asrForm, keepTags: e.target.checked })}
                  className="w-3.5 h-3.5 accent-violet-600 cursor-pointer"
                />
                <span className="text-[11px] text-zinc-600 dark:text-zinc-300">{t('asrKeepTagsLabel')}</span>
              </label>

              <button
                type="button"
                onClick={handleAsrApply}
                disabled={asrBusy !== null}
                className="mt-2.5 w-full px-2 py-1.5 rounded-lg bg-violet-600 hover:bg-violet-700 active:scale-[0.98] disabled:opacity-50 text-white text-xs font-medium transition-all"
              >
                {asrBusy === 'apply' ? t('asrApplying') : t('asrApplyRestart')}
              </button>
            </div>

            {/* 权限（麦克风 / 辅助功能 / 输入监控） */}
            <div className="mt-3 pt-3 border-t border-black/5 dark:border-white/5">
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
