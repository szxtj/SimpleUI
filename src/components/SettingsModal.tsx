import React, { useState, useEffect, useMemo, useRef } from 'react';
import { AppSettings, WikiStatusInfo } from '../types/chat';
import { DEFAULT_SETTINGS, saveSettings } from '../services/storage';
import { WikiAPI, ModelServiceAPI, ModelServiceStatus, ModelServiceConfig } from '../services/api';
import { resolveLanguage, formatArticleCount, translations, Language, TranslationKeys } from '../i18n';
import { X, RotateCcw, Check, BookOpen, AppWindow, SlidersHorizontal, Server, ChevronDown } from 'lucide-react';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  settings: AppSettings;
  onSave: (settings: AppSettings) => void;
}

// 知识库卡片默认值（ZIM 路径默认值与后端 findZimFile 的兜底路径一致）
const KB_DEFAULT_ZIM_PATH = '/Volumes/JustinSSD/wikipedia/wikipedia_zh_all_maxi_2026-08.zim';
const KB_DEFAULT_PORT = 31236;
// 基础模型服务卡片默认值（与后端 ttf_service.js DEFAULT_MODEL_CONFIG 保持一致）
const SVC_DEFAULT_PROJECT_DIR = '~/turbo-fieldfare';
const SVC_CARD_DEFAULTS: Partial<ModelServiceConfig> = {
  port: 1235,
  // 上下文容量与专家缓存槽位按用户实际运行配置（16K / 32 槽）作为默认
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

export const SettingsModal: React.FC<SettingsModalProps> = ({
  isOpen,
  onClose,
  settings,
  onSave,
}) => {
  const getSafeSettings = (s?: AppSettings): AppSettings => ({
    ...DEFAULT_SETTINGS,
    ...(s || {}),
    stopStrings: Array.isArray(s?.stopStrings) ? s.stopStrings : [],
  });

  const [formData, setFormData] = useState<AppSettings>(() => getSafeSettings(settings));

  const activeLang: Language = useMemo(() => {
    return resolveLanguage(formData.language || 'system');
  }, [formData.language]);

  const t = useMemo(() => {
    return (key: TranslationKeys) => {
      const dict = translations[activeLang] || translations.zh;
      return dict[key] || translations.zh[key] || key;
    };
  }, [activeLang]);
  const [stopInput, setStopInput] = useState<string>(() =>
    (settings?.stopStrings || []).join(', ')
  );
  const [wikiStatus, setWikiStatus] = useState<WikiStatusInfo | null>(null);
  const [isTogglingService, setIsTogglingService] = useState(false);
  const [customZimPath, setCustomZimPath] = useState('');
  const [kbPort, setKbPort] = useState('31236');
  const [isApplyingPath, setIsApplyingPath] = useState(false);
  const [pathMessage, setPathMessage] = useState<{ text: string; isError: boolean } | null>(null);

  // ---- 模型服务管理（SimpleUI 作为 TTF 服务唯一管理方）----
  const [svcStatus, setSvcStatus] = useState<ModelServiceStatus | null>(null);
  const [svcForm, setSvcForm] = useState<Partial<ModelServiceConfig>>({});
  const [svcProjectDir, setSvcProjectDir] = useState('');
  const [svcBusy, setSvcBusy] = useState<string | null>(null);
  const [svcMsg, setSvcMsg] = useState<{ text: string; isError: boolean } | null>(null);
  const [logsOpen, setLogsOpen] = useState(false);
  const [logLines, setLogLines] = useState<string[] | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refreshSvcStatus = async () => {
    const s = await ModelServiceAPI.getStatus();
    setSvcStatus(s);
    return s;
  };

  // Sync state whenever modal is opened
  useEffect(() => {
    if (isOpen) {
      const safe = getSafeSettings(settings);
      setFormData(safe);
      setStopInput((safe.stopStrings || []).join(', '));
      setPathMessage(null);

      WikiAPI.getStatus().then((status) => {
        setWikiStatus(status);
        if (status?.zimPath) {
          setCustomZimPath(status.zimPath);
        } else if (safe.customWikiDir) {
          setCustomZimPath(safe.customWikiDir);
        }
        setKbPort(String(status?.port ?? 31236));
      });

      // 模型服务：状态 + 配置各拉一次，之后 3s 轮询状态（弹窗打开期间）
      refreshSvcStatus();
      ModelServiceAPI.getConfig().then((cfg) => {
        if (cfg) {
          setSvcForm(cfg);
          setSvcProjectDir(cfg.projectDir || '');
        }
      });
      pollTimerRef.current = setInterval(() => {
        refreshSvcStatus();
        if (logsOpen) {
          ModelServiceAPI.getLogs(200).then((d) => setLogLines(d?.lines ?? null));
        }
      }, 3000);
    } else {
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
      setLogsOpen(false);
      setLogLines(null);
      setSvcMsg(null);
    }
    return () => {
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, settings, logsOpen]);

  // 开关即总控（与知识库服务开关同逻辑）：开 = 立即启动并随 App 自动启停；关 = 立即停止且不再自启
  const handleSvcToggle = async (next: boolean) => {
    setSvcBusy('toggle');
    try {
      await ModelServiceAPI.updateConfig({ enabled: next });
      // 后端 init()/watchdog 均以 enabled 为准，这里立即执行启停给出即时反馈
      await ModelServiceAPI.control(next ? 'start' : 'stop');
      await refreshSvcStatus();
    } finally {
      setSvcBusy(null);
    }
  };

  const handleSvcPathApply = async () => {
    if (!svcProjectDir.trim()) return;
    setSvcBusy('path');
    setSvcMsg(null);
    try {
      // 路径变更需重启服务才能生效：运行中则热重启（对齐知识库「保存并连接」的行为）
      const r = await ModelServiceAPI.updateConfig({ projectDir: svcProjectDir.trim() }, true);
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
      // 端口以本卡片「服务监听端口」输入为准；应用成功后同步模型设置卡片的请求端口，
      // 保证改端口后对话请求（x-target-port）仍可达
      const newPort = Number(svcForm.port) || 1235;
      const r = await ModelServiceAPI.updateConfig({ ...svcForm, port: newPort }, true);
      if (r.success) {
        setFormData((prev) => ({ ...prev, apiPort: newPort }));
        // 立即持久化请求端口：用户若不点「保存配置」直接关弹窗，路由也不会失联
        saveSettings({ ...settings, apiPort: newPort });
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
      const d = await ModelServiceAPI.getLogs(200);
      setLogLines(d?.lines ?? null);
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

  const handleAppCardReset = () => {
    setFormData((prev) => ({
      ...prev,
      theme: DEFAULT_SETTINGS.theme,
      language: DEFAULT_SETTINGS.language,
      spotlightResetMinutes: DEFAULT_SETTINGS.spotlightResetMinutes,
    }));
  };

  const handleKbCardReset = () => {
    setCustomZimPath(KB_DEFAULT_ZIM_PATH);
    setKbPort(String(KB_DEFAULT_PORT));
    setPathMessage(null);
  };

  const handleSvcCardReset = () => {
    setSvcForm((prev) => ({ ...prev, ...SVC_CARD_DEFAULTS }));
    setSvcProjectDir(SVC_DEFAULT_PROJECT_DIR);
    setSvcMsg(null);
  };

  const handleModelCardReset = () => {
    setFormData((prev) => ({
      ...prev,
      apiPort: DEFAULT_SETTINGS.apiPort,
      modelId: DEFAULT_SETTINGS.modelId,
      maxContext: DEFAULT_SETTINGS.maxContext,
      maxTokens: Math.floor(DEFAULT_SETTINGS.maxContext / 2),
      temperature: DEFAULT_SETTINGS.temperature,
      topP: DEFAULT_SETTINGS.topP,
      topK: DEFAULT_SETTINGS.topK,
      repetitionPenalty: DEFAULT_SETTINGS.repetitionPenalty,
      seed: undefined,
      stopStrings: [...DEFAULT_SETTINGS.stopStrings],
      systemPrompt: DEFAULT_SETTINGS.systemPrompt,
    }));
    setStopInput(DEFAULT_SETTINGS.stopStrings.join(', '));
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

  if (!isOpen) return null;

  const handleReset = () => {
    setFormData({ ...DEFAULT_SETTINGS });
    setStopInput(DEFAULT_SETTINGS.stopStrings.join(', '));
  };

  const handleSave = () => {
    const stops = stopInput
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    onSave({
      ...formData,
      stopStrings: stops,
    });
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm select-none"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="relative w-full max-w-lg rounded-2xl bg-white dark:bg-[#202227] border border-black/10 dark:border-[#353842] shadow-2xl overflow-hidden flex flex-col max-h-[90vh] text-[#1f2328] dark:text-[#cfd3dc]"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-black/5 dark:border-[#2d3038]">
          <h2 className="text-sm font-semibold text-[#1f2328] dark:text-[#f1f3f7]">
            {t('settingsTitle')}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded-lg text-zinc-500 hover:text-zinc-900 hover:bg-black/5 dark:text-[#888e9b] dark:hover:text-white dark:hover:bg-[#2d3038] transition-colors cursor-pointer"
            title={t('closeSettings')}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Form Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-4 text-xs">
          {/* 应用设置卡片（外观主题 / 显示语言 / Spotlight 空闲重置）——与知识库卡片同风格 */}
          <div className="p-3.5 rounded-xl border border-black/10 dark:border-[#343740] bg-[#f8f9fb] dark:bg-[#18191c]">
            <div className="flex items-center gap-2 mb-3">
              <AppWindow className="w-4 h-4 text-blue-600 dark:text-blue-400" />
              <span className="font-semibold text-xs text-[#1f2328] dark:text-[#f1f3f7]">
                {t('settingsAppCard')}
              </span>
            </div>
          {/* Appearance Theme & Display Language */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block font-medium mb-1 text-zinc-600 dark:text-[#9aa0ac]">
                {t('themeLabel')}
              </label>
              <select
                value={formData.theme || 'system'}
                onChange={(e) =>
                  setFormData({
                    ...formData,
                    theme: e.target.value as 'system' | 'light' | 'dark',
                  })
                }
                className="w-full bg-[#f6f8fa] dark:bg-[#18191c] border border-black/10 dark:border-[#343740] rounded-lg px-3 py-2 text-[#1f2328] dark:text-[#e2e5eb] focus:border-blue-500 focus:outline-none"
              >
                <option value="system">{t('themeSystem')}</option>
                <option value="light">{t('themeLight')}</option>
                <option value="dark">{t('themeDark')}</option>
              </select>
            </div>

            <div>
              <label className="block font-medium mb-1 text-zinc-600 dark:text-[#9aa0ac]">
                {t('languageLabel')}
              </label>
              <select
                value={formData.language || 'system'}
                onChange={(e) =>
                  setFormData({
                    ...formData,
                    language: e.target.value as 'system' | 'zh' | 'en',
                  })
                }
                className="w-full bg-[#f6f8fa] dark:bg-[#18191c] border border-black/10 dark:border-[#343740] rounded-lg px-3 py-2 text-[#1f2328] dark:text-[#e2e5eb] focus:border-blue-500 focus:outline-none"
              >
                <option value="system">{t('langSystem')}</option>
                <option value="zh">{t('langZh')}</option>
                <option value="en">{t('langEn')}</option>
              </select>
            </div>
          </div>

          {/* Spotlight Idle Auto-Reset Setting */}
          <div>
            <label className="block font-medium mb-1 text-zinc-600 dark:text-[#9aa0ac]">
              {t('spotlightResetLabel')}
            </label>
            <select
              value={formData.spotlightResetMinutes ?? 15}
              onChange={(e) =>
                setFormData({
                  ...formData,
                  spotlightResetMinutes: Number(e.target.value),
                })
              }
              className="w-full bg-[#f6f8fa] dark:bg-[#18191c] border border-black/10 dark:border-[#343740] rounded-lg px-3 py-2 text-[#1f2328] dark:text-[#e2e5eb] focus:border-blue-500 focus:outline-none"
            >
              <option value={5}>{t('spotlightReset5m')}</option>
              <option value={15}>{t('spotlightReset15m')}</option>
              <option value={30}>{t('spotlightReset30m')}</option>
              <option value={60}>{t('spotlightReset60m')}</option>
              <option value={0}>{t('spotlightResetNever')}</option>
            </select>
            <p className="mt-1 text-[11px] text-zinc-500 dark:text-zinc-400">
              {t('spotlightResetTip')}
            </p>

            {cardResetButton(handleAppCardReset)}
          </div>
          </div>

          {/* Knowledge Base Configuration Card */}
          <div className="p-3.5 rounded-xl border border-black/10 dark:border-[#343740] bg-[#f8f9fb] dark:bg-[#18191c]">
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
                      wikiStatus.connected
                        ? 'bg-emerald-500 shadow-[0_0_6px_rgba(16,185,129,0.8)]'
                        : 'bg-red-500'
                    }`}
                  />
                  <span
                    className={
                      wikiStatus.connected
                        ? 'text-emerald-600 dark:text-emerald-400 font-medium'
                        : 'text-red-500 font-medium'
                    }
                  >
                    {/* 就绪：zh『就绪于31236 (355万词条)』/ en『Ready on 31236 (…)』
                        ——词条数保持原样缀在端口后；离线：红点 + 全红字 */}
                    {wikiStatus.connected
                      ? `${t('wikiStatusConnected')}${wikiStatus.port ?? 31236}${
                          wikiStatus.articleCount > 0
                            ? ` (${formatArticleCount(wikiStatus.articleCount, activeLang)})`
                            : ''
                        }`
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

          {/* 模型服务卡片（SimpleUI 作为 TTF 服务唯一管理方：随 App 自动启动、退出一并终止）
              ——独立于下方「模型设置」卡片，置于其上方 */}
          <div className="p-3.5 rounded-xl border border-black/10 dark:border-[#343740] bg-[#f8f9fb] dark:bg-[#18191c]">
            {/* 头部：标题 + 状态灯/端口（与知识库卡片头部同布局） */}
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <Server className="w-4 h-4 text-violet-600 dark:text-violet-400" />
                <span className="font-semibold text-xs text-[#1f2328] dark:text-[#f1f3f7]">
                  {t('modelServiceTitle')}
                </span>
              </div>
              <div className="flex items-center gap-1.5 text-[11px]">
                <span
                  className={`w-2 h-2 rounded-full ${
                    svcStatus?.status === 'running'
                      ? 'bg-emerald-500 shadow-[0_0_6px_rgba(16,185,129,0.8)]'
                      : svcStatus?.status === 'stopped' || !svcStatus
                      ? 'bg-red-500'
                      : 'bg-amber-500 animate-pulse'
                  }`}
                />
                <span
                  className={
                    svcStatus?.status === 'running'
                      ? 'text-emerald-600 dark:text-emerald-400 font-medium'
                      : svcStatus?.status === 'stopped' || !svcStatus
                      ? 'text-red-500 font-medium'
                      : 'text-amber-600 dark:text-amber-400 font-medium'
                  }
                >
                  {/* zh『就绪于』/ en『Ready on 』（键值自带空格）直接接端口；
                      过渡态保持『… on 端口』；离线只显示『离线』（红点 + 全红字） */}
                  {svcStatus?.status === 'running'
                    ? t('modelServiceStatusRunning')
                    : svcStatus?.status === 'loading'
                    ? t('modelServiceStatusLoading')
                    : svcStatus?.status === 'starting'
                    ? t('modelServiceStatusStarting')
                    : svcStatus?.status === 'stopping'
                    ? t('modelServiceStatusStopping')
                    : svcStatus?.status === 'restart'
                    ? t('modelServiceStatusRestarting')
                    : t('modelServiceStatusStopped')}
                  {svcStatus?.status === 'running'
                    ? svcStatus.port
                    : svcStatus && svcStatus.status !== 'stopped'
                    ? ` on ${svcStatus.port}`
                    : ''}
                </span>
              </div>
            </div>

            {/* 服务总开关（与知识库服务开关同逻辑）：开 = 立即启动 + 随 App 自动启停；关 = 立即停止 + 不再自启 */}
            <div className="flex items-center justify-between gap-3 pb-3 mb-3 border-b border-black/5 dark:border-white/5">
              <button
                type="button"
                onClick={() => handleSvcToggle(!(svcStatus?.enabled ?? true))}
                disabled={svcBusy !== null}
                className="flex-1 min-w-0 text-left cursor-pointer disabled:cursor-not-allowed"
              >
                <div className="font-medium text-zinc-700 dark:text-zinc-200">
                  {t('modelServiceAutoStart')}
                </div>
                <div className="text-[10px] text-zinc-500 dark:text-zinc-400">
                  {t('modelServiceAutoStartDesc')}
                </div>
              </button>
              <button
                type="button"
                role="switch"
                aria-checked={svcStatus?.enabled ?? true}
                disabled={svcBusy !== null}
                onClick={() => handleSvcToggle(!(svcStatus?.enabled ?? true))}
                className={`relative w-10 h-[22px] rounded-full transition-colors flex-shrink-0 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none ${
                  svcStatus?.enabled ?? true
                    ? 'bg-violet-600'
                    : 'bg-zinc-300 dark:bg-zinc-600'
                }`}
              >
                <span
                  className={`absolute top-[2px] left-[2px] w-[18px] h-[18px] rounded-full bg-white shadow transition-transform duration-200 ${
                    svcStatus?.enabled ?? true ? 'translate-x-[18px]' : 'translate-x-0'
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
                value={svcProjectDir}
                onChange={(e) => setSvcProjectDir(e.target.value)}
                placeholder="/Users/xxx/turbo-fieldfare"
                className="flex-1 bg-white dark:bg-[#202127] border border-black/10 dark:border-white/10 rounded-lg px-2.5 py-1.5 text-xs text-[#1f2328] dark:text-[#f1f3f7] font-mono focus:outline-none focus:border-violet-500"
              />
              <button
                type="button"
                onClick={handleSvcPathApply}
                disabled={svcBusy !== null || !svcProjectDir.trim()}
                className="px-3 py-1.5 rounded-lg bg-violet-600 hover:bg-violet-700 active:scale-95 disabled:opacity-50 text-white text-xs font-medium transition-all flex-shrink-0"
              >
                {svcBusy === 'path' ? t('modelServicePathApplying') : t('modelServicePathApply')}
              </button>
            </div>

            {/* 服务监听端口（默认 1235；「保存并应用」后生效，并自动同步下方模型设置的请求端口） */}
            <div className="mb-1.5">
              <label className="block text-[11px] font-medium text-zinc-600 dark:text-zinc-400 mb-1">
                {t('svcPortLabel')}
              </label>
              <input
                type="number"
                min={1024}
                max={65535}
                value={svcForm.port ?? 1235}
                onChange={(e) => setSvcForm({ ...svcForm, port: Number(e.target.value) || 1235 })}
                className="w-full bg-white dark:bg-[#202127] border border-black/10 dark:border-white/10 rounded-lg px-2.5 py-1.5 text-xs text-[#1f2328] dark:text-[#f1f3f7] font-mono focus:outline-none focus:border-violet-500"
              />
            </div>

            {/* 启动前置检查提示（仓库/二进制/权重缺失时给出预期行为说明） */}
            {svcStatus && !svcStatus.checks.repo && (
              <div className="text-[10px] text-amber-600 dark:text-amber-400 mb-0.5">{t('modelServiceCheckRepo')}</div>
            )}
            {svcStatus && svcStatus.checks.repo && !svcStatus.checks.binary && (
              <div className="text-[10px] text-amber-600 dark:text-amber-400 mb-0.5">{t('modelServiceCheckBinary')}</div>
            )}
            {svcStatus && !svcStatus.checks.model && (
              <div className="text-[10px] text-amber-600 dark:text-amber-400 mb-0.5">{t('modelServiceCheckModel')}</div>
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

            {/* 运行参数（保存时若服务在运行则自动热重启；端口复用下方「模型设置」卡片的服务端口输入） */}
            <div className="mt-3">
              <div className="text-[11px] font-medium text-zinc-600 dark:text-zinc-400 mb-1.5">
                {t('modelServiceParamsTitle')}
              </div>
              <div className="grid grid-cols-2 gap-2.5">
                <div>
                  <label className="block text-[10px] text-zinc-500 dark:text-zinc-400 mb-1">{t('svcMaxContextLabel')}</label>
                  <select
                    value={svcForm.maxContext ?? 16384}
                    onChange={(e) => setSvcForm({ ...svcForm, maxContext: Number(e.target.value) })}
                    className="w-full bg-[#f6f8fa] dark:bg-[#18191c] border border-black/10 dark:border-[#343740] rounded-lg px-2 py-1.5 text-xs text-[#1f2328] dark:text-[#e2e5eb] focus:border-violet-500 focus:outline-none"
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
                    className="w-full bg-[#f6f8fa] dark:bg-[#18191c] border border-black/10 dark:border-[#343740] rounded-lg px-2 py-1.5 text-xs text-[#1f2328] dark:text-[#e2e5eb] focus:border-violet-500 focus:outline-none"
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
                    className="w-full bg-[#f6f8fa] dark:bg-[#18191c] border border-black/10 dark:border-[#343740] rounded-lg px-2 py-1.5 text-xs text-[#1f2328] dark:text-[#e2e5eb] focus:border-violet-500 focus:outline-none"
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
                    className="w-full bg-[#f6f8fa] dark:bg-[#18191c] border border-black/10 dark:border-[#343740] rounded-lg px-2 py-1.5 text-xs text-[#1f2328] dark:text-[#e2e5eb] focus:border-violet-500 focus:outline-none"
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
                    className="w-full bg-[#f6f8fa] dark:bg-[#18191c] border border-black/10 dark:border-[#343740] rounded-lg px-2 py-1.5 text-xs text-[#1f2328] dark:text-[#e2e5eb] focus:border-violet-500 focus:outline-none"
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
                    className="w-full bg-[#f6f8fa] dark:bg-[#18191c] border border-black/10 dark:border-[#343740] rounded-lg px-2 py-1.5 text-xs text-[#1f2328] dark:text-[#e2e5eb] focus:border-violet-500 focus:outline-none"
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
                    className="w-full bg-[#f6f8fa] dark:bg-[#18191c] border border-black/10 dark:border-[#343740] rounded-lg px-2 py-1.5 text-xs text-[#1f2328] dark:text-[#e2e5eb] focus:border-violet-500 focus:outline-none"
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
                    className="w-full bg-[#f6f8fa] dark:bg-[#18191c] border border-black/10 dark:border-[#343740] rounded-lg px-2 py-1.5 text-xs text-[#1f2328] dark:text-[#e2e5eb] focus:border-violet-500 focus:outline-none"
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
                    className="w-full bg-[#f6f8fa] dark:bg-[#18191c] border border-black/10 dark:border-[#343740] rounded-lg px-2 py-1.5 text-xs text-[#1f2328] dark:text-[#e2e5eb] focus:border-violet-500 focus:outline-none"
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
                    className="w-full bg-[#f6f8fa] dark:bg-[#18191c] border border-black/10 dark:border-[#343740] rounded-lg px-2 py-1.5 text-xs text-[#1f2328] dark:text-[#e2e5eb] focus:border-violet-500 focus:outline-none"
                  >
                    <option value={0}>{t('svcIdleResetDisabled')}</option>
                    {[5, 10, 15, 30, 60, 120].map((v) => (
                      <option key={v} value={v}>{v} {t('svcMinutesUnit')}</option>
                    ))}
                  </select>
                </div>
              </div>

              {/* 显存预算保护（与 manager 同款 checkbox：允许超出物理显存预算强制启动 128K/256K） */}
              <label className="mt-2.5 flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={svcForm.allowUnbackedContext ?? false}
                  onChange={(e) => setSvcForm({ ...svcForm, allowUnbackedContext: e.target.checked })}
                  className="w-3.5 h-3.5 accent-violet-600 cursor-pointer"
                />
                <span className="text-[11px] text-zinc-600 dark:text-zinc-300">{t('svcAllowUnbackedLabel')}</span>
              </label>
              <button
                type="button"
                onClick={handleSvcApplyParams}
                disabled={svcBusy !== null}
                className="mt-2.5 w-full px-2 py-1.5 rounded-lg bg-violet-600 hover:bg-violet-700 active:scale-[0.98] disabled:opacity-50 text-white text-xs font-medium transition-all"
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

          {/* 模型设置卡片（端口 / 模型 / 采样参数 / 停止序列 / 系统提示词）——与知识库卡片同风格 */}
          <div className="p-3.5 rounded-xl border border-black/10 dark:border-[#343740] bg-[#f8f9fb] dark:bg-[#18191c]">
            <div className="flex items-center gap-2 mb-3">
              <SlidersHorizontal className="w-4 h-4 text-amber-600 dark:text-amber-400" />
              <span className="font-semibold text-xs text-[#1f2328] dark:text-[#f1f3f7]">
                {t('settingsModelCard')}
              </span>
            </div>

          {/* Local Service Port Selection */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block font-medium mb-1 text-zinc-600 dark:text-[#9aa0ac]">
                {t('servicePortLabel')}
              </label>
              <select
                value={[1235, 11434, 8000, 8080, 1234, 5000].includes(formData.apiPort) ? formData.apiPort : 'custom'}
                onChange={(e) => {
                  const val = e.target.value;
                  if (val !== 'custom') {
                    setFormData({ ...formData, apiPort: Number(val) });
                  }
                }}
                className="w-full bg-[#f6f8fa] dark:bg-[#18191c] border border-black/10 dark:border-[#343740] rounded-lg px-3 py-2 text-[#1f2328] dark:text-[#e2e5eb] focus:border-amber-500 focus:outline-none"
              >
                <option value={1235}>{t('portOptionTTF')}</option>
                <option value={11434}>{t('portOptionOllama')}</option>
                <option value={8000}>{t('portOptionVLLM')}</option>
                <option value={8080}>{t('portOptionLlamaCpp')}</option>
                <option value={1234}>{t('portOptionLMStudio')}</option>
                <option value={5000}>{t('portOptionTextGen')}</option>
                <option value="custom">{t('portOptionCustom')}</option>
              </select>
            </div>

            <div>
              <label className="block font-medium mb-1 text-zinc-600 dark:text-[#9aa0ac]">
                {t('portValueLabel')}
              </label>
              <input
                type="number"
                min="1"
                max="65535"
                value={formData.apiPort ?? 1235}
                onChange={(e) => setFormData({ ...formData, apiPort: Number(e.target.value) || 1235 })}
                placeholder="1235"
                className="w-full bg-[#f6f8fa] dark:bg-[#18191c] border border-black/10 dark:border-[#343740] rounded-lg px-3 py-2 text-[#1f2328] dark:text-[#e2e5eb] focus:border-amber-500 focus:outline-none font-mono"
              />
            </div>
          </div>

          {/* Model ID & Max Context */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block font-medium mb-1 text-zinc-600 dark:text-[#9aa0ac]">
                {t('modelLabel')}
              </label>
              <input
                type="text"
                value={formData.modelId ?? 'gemma-4-26b-a4b-it'}
                onChange={(e) => setFormData({ ...formData, modelId: e.target.value })}
                className="w-full bg-[#f6f8fa] dark:bg-[#18191c] border border-black/10 dark:border-[#343740] rounded-lg px-3 py-2 text-[#1f2328] dark:text-[#e2e5eb] focus:border-amber-500 focus:outline-none font-mono"
              />
            </div>

            <div>
              <label className="block font-medium mb-1 text-zinc-600 dark:text-[#9aa0ac]">
                {t('maxContextLabel')}
              </label>
              <select
                value={formData.maxContext ?? 16384}
                onChange={(e) => {
                  const val = Number(e.target.value);
                  setFormData({
                    ...formData,
                    maxContext: val,
                    maxTokens: Math.floor(val / 2),
                  });
                }}
                className="w-full bg-[#f6f8fa] dark:bg-[#18191c] border border-black/10 dark:border-[#343740] rounded-lg px-3 py-2 text-[#1f2328] dark:text-[#e2e5eb] focus:border-amber-500 focus:outline-none"
              >
                <option value={8192}>8,192 (8K)</option>
                <option value={16384}>16,384 (16K)</option>
                <option value={32768}>32,768 (32K)</option>
                <option value={65536}>65,536 (64K)</option>
                <option value={131072}>131,072 (128K)</option>
                <option value={262144}>262,144 (256K)</option>
              </select>
            </div>
          </div>

          {/* Temperature & Top-P */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className="flex justify-between font-medium mb-1 text-zinc-600 dark:text-[#9aa0ac]">
                <span>{t('temperatureLabel')}</span>
                <span className="font-mono text-amber-500 dark:text-amber-400">{formData.temperature ?? 1.0}</span>
              </div>
              <input
                type="range"
                min="0"
                max="2"
                step="0.05"
                value={formData.temperature ?? 1.0}
                onChange={(e) => setFormData({ ...formData, temperature: Number(e.target.value) })}
                className="w-full accent-amber-500"
              />
              <span className="text-[10px] text-zinc-500 dark:text-[#6f7582]">{t('temperatureTip')}</span>
            </div>

            <div>
              <div className="flex justify-between font-medium mb-1 text-zinc-600 dark:text-[#9aa0ac]">
                <span>{t('topPLabel')}</span>
                <span className="font-mono text-amber-500 dark:text-amber-400">{formData.topP ?? 0.95}</span>
              </div>
              <input
                type="range"
                min="0.01"
                max="1.0"
                step="0.01"
                value={formData.topP ?? 0.95}
                onChange={(e) => setFormData({ ...formData, topP: Number(e.target.value) })}
                className="w-full accent-amber-500"
              />
              <span className="text-[10px] text-zinc-500 dark:text-[#6f7582]">{t('topPTip')}</span>
            </div>
          </div>

          {/* Top-K & Repetition Penalty */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className="flex justify-between font-medium mb-1 text-zinc-600 dark:text-[#9aa0ac]">
                <span>{t('topKLabel')}</span>
                <span className="font-mono text-amber-500 dark:text-amber-400">{formData.topK ?? 64}</span>
              </div>
              <input
                type="range"
                min="1"
                max="256"
                step="1"
                value={formData.topK ?? 64}
                onChange={(e) => setFormData({ ...formData, topK: Number(e.target.value) })}
                className="w-full accent-amber-500"
              />
              <span className="text-[10px] text-zinc-500 dark:text-[#6f7582]">{t('topKTip')}</span>
            </div>

            <div>
              <div className="flex justify-between font-medium mb-1 text-zinc-600 dark:text-[#9aa0ac]">
                <span>{t('repetitionPenaltyLabel')}</span>
                <span className="font-mono text-amber-500 dark:text-amber-400">{formData.repetitionPenalty ?? 1.0}</span>
              </div>
              <input
                type="range"
                min="0.5"
                max="2.0"
                step="0.05"
                value={formData.repetitionPenalty ?? 1.0}
                onChange={(e) => setFormData({ ...formData, repetitionPenalty: Number(e.target.value) })}
                className="w-full accent-amber-500"
              />
              <span className="text-[10px] text-zinc-500 dark:text-[#6f7582]">{t('repetitionPenaltyTip')}</span>
            </div>
          </div>

          {/* Max Completion Tokens & Seed */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="font-medium text-zinc-600 dark:text-[#9aa0ac]">
                  {t('maxTokensLabel')}
                </label>
                <span className="text-[10px] text-amber-600 dark:text-amber-400 font-medium bg-amber-500/10 px-1.5 py-0.5 rounded">
                  {t('linkedHalf')}
                </span>
              </div>
              <input
                type="text"
                readOnly
                value={`${formData.maxTokens || Math.floor((formData.maxContext || 16384) / 2)} tokens (${Math.round((formData.maxTokens || Math.floor((formData.maxContext || 16384) / 2)) / 1024)}K)`}
                className="w-full bg-zinc-100 dark:bg-[#151619] border border-black/10 dark:border-[#2d3038] rounded-lg px-3 py-2 text-zinc-600 dark:text-[#abb0bc] cursor-not-allowed font-mono select-none"
              />
              <span className="text-[10px] text-zinc-500 dark:text-[#6f7582] mt-1 block">{t('maxTokensTip')}</span>
            </div>

            <div>
              <label className="block font-medium mb-1 text-zinc-600 dark:text-[#9aa0ac]">
                {t('seedLabel')}
              </label>
              <input
                type="number"
                value={formData.seed ?? ''}
                onChange={(e) =>
                  setFormData({
                    ...formData,
                    seed: e.target.value ? Number(e.target.value) : undefined,
                  })
                }
                placeholder={t('seedPlaceholder')}
                className="w-full bg-[#f6f8fa] dark:bg-[#18191c] border border-black/10 dark:border-[#343740] rounded-lg px-3 py-2 text-[#1f2328] dark:text-[#e2e5eb] focus:border-amber-500 focus:outline-none font-mono"
              />
            </div>
          </div>

          {/* Stop Sequences */}
          <div>
            <label className="block font-medium mb-1 text-zinc-600 dark:text-[#9aa0ac]">
              {t('stopLabel')}
            </label>
            <input
              type="text"
              value={stopInput}
              onChange={(e) => setStopInput(e.target.value)}
              placeholder={t('stopPlaceholder')}
              className="w-full bg-[#f6f8fa] dark:bg-[#18191c] border border-black/10 dark:border-[#343740] rounded-lg px-3 py-2 text-[#1f2328] dark:text-[#e2e5eb] focus:border-amber-500 focus:outline-none font-mono"
            />
          </div>

          {/* System Prompt */}
          <div>
            <label className="block font-medium mb-1 text-zinc-600 dark:text-[#9aa0ac]">
              {t('systemPromptLabel')}
            </label>
            <textarea
              rows={3}
              value={formData.systemPrompt ?? ''}
              onChange={(e) => setFormData({ ...formData, systemPrompt: e.target.value })}
              className="w-full bg-[#f6f8fa] dark:bg-[#18191c] border border-black/10 dark:border-[#343740] rounded-lg px-3 py-2 text-[#1f2328] dark:text-[#e2e5eb] focus:border-amber-500 focus:outline-none resize-none leading-relaxed"
            />
          </div>

          {cardResetButton(handleModelCardReset)}
          </div>
        </div>

        {/* Footer actions */}
        <div className="flex items-center justify-between px-5 py-3 border-t border-black/5 dark:border-[#2d3038] bg-[#f8f9fb] dark:bg-[#1a1b1e]">
          <button
            type="button"
            onClick={handleReset}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs text-zinc-500 dark:text-[#8c929f] hover:text-zinc-900 dark:hover:text-white hover:bg-black/5 dark:hover:bg-[#2b2d35] transition-colors"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>{t('restoreDefaults')}</span>
          </button>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3.5 py-1.5 rounded-lg text-xs text-zinc-600 dark:text-[#a2a8b5] hover:bg-black/5 dark:hover:bg-[#2b2d35] transition-colors"
            >
              {t('cancel')}
            </button>
            <button
              type="button"
              onClick={handleSave}
              className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-xs bg-blue-600 hover:bg-blue-500 text-white font-medium shadow transition-colors"
            >
              <Check className="w-3.5 h-3.5" />
              <span>{t('saveSettings')}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
