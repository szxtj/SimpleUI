import React, { useState, useEffect, useMemo, useRef } from 'react';
import {
  AppSettings,
  DeepSeekProviderConfig,
  ApiProvider,
  TtfProviderConfig,
  MferenceProviderConfig,
  CustomProviderConfig,
} from '../../types/chat';
import {
  DEFAULT_SETTINGS,
  DEFAULT_DEEPSEEK_CONFIG,
  DEFAULT_TTF_CONFIG,
  DEFAULT_MFERENCE_CONFIG,
  DEFAULT_CUSTOM_CONFIG,
} from '../../services/storage';
import { resolveLanguage, translations, Language, TranslationKeys } from '../../i18n';
import {
  RotateCcw,
  Check,
  AppWindow,
  SlidersHorizontal,
  ChevronDown,
  Eye,
  EyeOff,
  Sparkles,
  Terminal,
  HardDrive,
  FolderOpen,
  Trash2,
} from 'lucide-react';
import { getMediaStats, openMediaDir, triggerMediaGC, MediaStorageStats } from '../../services/mediaCleanup';
import { SettingsTabId } from './types';

interface AppSettingsPanelProps {
  activeTab: SettingsTabId;
  settings: AppSettings;
  onSave: (settings: AppSettings) => void;
}

export const AppSettingsPanel: React.FC<AppSettingsPanelProps> = ({
  activeTab,
  settings,
  onSave,
}) => {
  // 1. 通用应用外观设置
  const [apiProvider, setApiProvider] = useState<ApiProvider>(() => {
    const p = settings?.apiProvider || 'ttf';
    return p === 'local' ? 'ttf' : p;
  });
  const [theme, setTheme] = useState<'system' | 'light' | 'dark'>(() => settings?.theme || 'system');
  const [language, setLanguage] = useState<'system' | 'zh' | 'en'>(() => settings?.language || 'system');
  const [spotlightResetMinutes, setSpotlightResetMinutes] = useState<number>(() => settings?.spotlightResetMinutes ?? 15);

  // 2. 四套独立模型配置
  const [ttfConfig, setTtfConfig] = useState<TtfProviderConfig>(() => ({
    ...DEFAULT_TTF_CONFIG,
    ...(settings?.ttfConfig || settings?.localConfig || {}),
  }));
  const [ttfStopInput, setTtfStopInput] = useState<string>(() =>
    (settings?.ttfConfig?.stopStrings || settings?.localConfig?.stopStrings || settings?.stopStrings || []).join(', ')
  );

  const [mferenceConfig, setMferenceConfig] = useState<MferenceProviderConfig>(() => ({
    ...DEFAULT_MFERENCE_CONFIG,
    ...(settings?.mferenceConfig || {}),
  }));
  const [mferenceStopInput, setMferenceStopInput] = useState<string>(() =>
    (settings?.mferenceConfig?.stopStrings || []).join(', ')
  );

  const [customConfig, setCustomConfig] = useState<CustomProviderConfig>(() => ({
    ...DEFAULT_CUSTOM_CONFIG,
    ...(settings?.customConfig || {}),
  }));

  const [deepseekConfig, setDeepseekConfig] = useState<DeepSeekProviderConfig>(() => ({
    ...DEFAULT_DEEPSEEK_CONFIG,
    ...(settings?.deepseekConfig || {}),
  }));
  const [deepseekStopInput, setDeepseekStopInput] = useState<string>(() =>
    (settings?.deepseekConfig?.stopStrings || []).join(', ')
  );

  const [showApiKey, setShowApiKey] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const activeLang: Language = useMemo(() => {
    return resolveLanguage(language);
  }, [language]);

  const t = useMemo(() => {
    return (key: TranslationKeys) => {
      const dict = translations[activeLang] || translations.zh;
      return dict[key] || translations.zh[key] || key;
    };
  }, [activeLang]);

  // 图片与媒体文件
  const [mediaStats, setMediaStats] = useState<MediaStorageStats | null>(null);
  const [mediaBusy, setMediaBusy] = useState<'clean' | null>(null);
  const [mediaConfirm, setMediaConfirm] = useState(false);
  const [mediaMsg, setMediaMsg] = useState<{ text: string; isError?: boolean } | null>(null);
  const mediaConfirmTimer = useRef<number | null>(null);

  const refreshMediaStats = React.useCallback(async () => {
    const stats = await getMediaStats();
    setMediaStats(stats);
    return stats;
  }, []);

  useEffect(() => {
    if (activeTab === 'storage') {
      refreshMediaStats();
    }
  }, [activeTab, refreshMediaStats]);

  const handleOpenMediaDir = async () => {
    await openMediaDir();
  };

  const handleCleanMedia = async () => {
    if (mediaBusy) return;
    if (!mediaConfirm) {
      setMediaConfirm(true);
      if (mediaConfirmTimer.current) window.clearTimeout(mediaConfirmTimer.current);
      mediaConfirmTimer.current = window.setTimeout(() => setMediaConfirm(false), 4000);
      return;
    }
    if (mediaConfirmTimer.current) window.clearTimeout(mediaConfirmTimer.current);
    setMediaConfirm(false);
    setMediaBusy('clean');
    setMediaMsg(null);
    try {
      const res = await triggerMediaGC(0);
      if (!res) {
        setMediaMsg({
          text: t('settingsCleanFailed'),
          isError: true,
        });
      } else if (res.deletedCount === 0) {
        setMediaMsg({ text: t('mediaCleanEmpty') });
      } else {
        setMediaMsg({
          text:
            activeLang === 'zh'
              ? `已清理 ${res.deletedCount} 个文件，释放 ${res.freedMB} MB`
              : `Removed ${res.deletedCount} file${res.deletedCount === 1 ? '' : 's'}, freed ${res.freedMB} MB`,
        });
      }
      await refreshMediaStats();
    } finally {
      setMediaBusy(null);
    }
  };

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
    setTheme(DEFAULT_SETTINGS.theme || 'system');
    setLanguage(DEFAULT_SETTINGS.language || 'system');
    setSpotlightResetMinutes(DEFAULT_SETTINGS.spotlightResetMinutes ?? 15);
  };

  const handleModelCardReset = () => {
    if (apiProvider === 'ttf' || apiProvider === 'local') {
      setTtfConfig({ ...DEFAULT_TTF_CONFIG });
      setTtfStopInput(DEFAULT_TTF_CONFIG.stopStrings.join(', '));
    } else if (apiProvider === 'mference') {
      setMferenceConfig({ ...DEFAULT_MFERENCE_CONFIG });
      setMferenceStopInput((DEFAULT_MFERENCE_CONFIG.stopStrings || []).join(', '));
    } else if (apiProvider === 'custom') {
      setCustomConfig({ ...DEFAULT_CUSTOM_CONFIG });
    } else if (apiProvider === 'deepseek') {
      const storedApiKey = typeof localStorage !== 'undefined' ? localStorage.getItem('tff_deepseek_api_key_v1') || '' : '';
      setDeepseekConfig((prev) => ({
        ...DEFAULT_DEEPSEEK_CONFIG,
        apiKey: prev.apiKey || storedApiKey,
      }));
      setDeepseekStopInput('');
    }
  };

  const handleSave = () => {
    const ttfStops = ttfStopInput
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const mferenceStops = mferenceStopInput
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const dsStops = deepseekStopInput
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    const storedApiKey = typeof localStorage !== 'undefined' ? localStorage.getItem('tff_deepseek_api_key_v1') || '' : '';
    const cleanApiKey = (deepseekConfig.apiKey.trim() || storedApiKey).trim();

    if (cleanApiKey && typeof localStorage !== 'undefined') {
      try {
        localStorage.setItem('tff_deepseek_api_key_v1', cleanApiKey);
      } catch {}
    }

    const finalTtf: TtfProviderConfig = {
      ...ttfConfig,
      stopStrings: ttfStops,
    };
    const finalMference: MferenceProviderConfig = {
      ...mferenceConfig,
      stopStrings: mferenceStops,
    };
    const finalCustom: CustomProviderConfig = {
      ...customConfig,
    };
    const dsMaxCtx = Number(deepseekConfig.maxContext || 131072);
    const finalDs: DeepSeekProviderConfig = {
      ...deepseekConfig,
      maxContext: dsMaxCtx,
      maxTokens: Math.floor(dsMaxCtx / 2),
      apiKey: cleanApiKey,
      stopStrings: dsStops,
    };

    let activePort = finalTtf.apiPort;
    let activeBaseUrl = finalTtf.apiBaseUrl || '';
    let activeModel = finalTtf.modelId;
    let activeMaxContext = finalTtf.maxContext;
    let activeMaxTokens = finalTtf.maxTokens;
    let activeTemp = finalTtf.temperature;
    let activeTopP = finalTtf.topP;
    let activeTopK: number | undefined = finalTtf.topK;
    let activeMinP: number | undefined = undefined;
    let activePresencePenalty: number | undefined = undefined;
    let activeRepPenalty: number | undefined = finalTtf.repetitionPenalty;
    let activeReasoning = finalTtf.reasoningEffort || 'default';
    let activeSeed: number | undefined = finalTtf.seed;
    let activeStopStrings: string[] = finalTtf.stopStrings;
    let activeSystemPrompt = finalTtf.systemPrompt;

    if (apiProvider === 'mference') {
      activePort = finalMference.apiPort;
      activeBaseUrl = finalMference.apiBaseUrl || '';
      activeModel = finalMference.modelId;
      activeMaxContext = finalMference.maxContext;
      activeMaxTokens = finalMference.maxTokens;
      activeTemp = finalMference.temperature;
      activeTopP = finalMference.topP;
      activeTopK = finalMference.topK;
      activeMinP = finalMference.minP;
      activePresencePenalty = finalMference.presencePenalty;
      activeRepPenalty = finalMference.repetitionPenalty;
      activeReasoning = finalMference.reasoningEffort || 'low';
      activeSeed = finalMference.seed;
      activeStopStrings = finalMference.stopStrings || [];
      activeSystemPrompt = finalMference.systemPrompt;
    } else if (apiProvider === 'custom') {
      activePort = finalCustom.apiPort;
      activeBaseUrl = finalCustom.apiBaseUrl || '';
      activeModel = finalCustom.modelId;
      activeMaxContext = finalCustom.maxContext;
      activeMaxTokens = finalCustom.maxTokens;
      activeTemp = finalCustom.temperature;
      activeTopP = 1.0;
      activeReasoning = 'high';
      activeSystemPrompt = finalCustom.systemPrompt;
      activeTopK = undefined;
      activeRepPenalty = undefined;
      activeSeed = undefined;
      activeStopStrings = [];
    } else if (apiProvider === 'deepseek') {
      activeBaseUrl = finalDs.baseUrl;
      activeModel = finalDs.modelId;
      activeMaxContext = finalDs.maxContext;
      activeMaxTokens = finalDs.maxTokens;
      activeTemp = finalDs.temperature;
      activeTopP = finalDs.topP;
      activeReasoning = finalDs.reasoningEffort;
      activeSeed = finalDs.seed;
      activeStopStrings = finalDs.stopStrings;
      activeSystemPrompt = finalDs.systemPrompt;
      activeTopK = undefined;
      activeRepPenalty = undefined;
    }

    onSave({
      ...settings,
      theme,
      language,
      spotlightResetMinutes,
      apiProvider,
      ttfConfig: finalTtf,
      mferenceConfig: finalMference,
      customConfig: finalCustom,
      deepseekConfig: finalDs,
      localConfig: finalTtf as any,

      apiPort: activePort,
      apiBaseUrl: activeBaseUrl,
      deepseekApiKey: cleanApiKey,
      deepseekModelId: finalDs.modelId,
      deepseekBaseUrl: finalDs.baseUrl,

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
    });
  };

  return (
    <div className="space-y-5 text-xs">
      {/* 1. 常规与外观 (General & Appearance) */}
      {activeTab === 'general' && (
        <div className="space-y-4">
          <div>
            <h2 className="text-xl font-bold tracking-tight text-[#1f2328] dark:text-[#f1f3f7]">
              {t('tabGeneral')}
            </h2>
          </div>

          <div className="p-4 rounded-2xl border border-black/10 dark:border-[#343740] bg-[#f8f9fb] dark:bg-[#18191c] space-y-4 shadow-xs">
            <div className="flex items-center gap-2 pb-2 border-b border-black/5 dark:border-white/5">
              <AppWindow className="w-4 h-4 text-blue-600 dark:text-blue-400" />
              <span className="font-semibold text-xs text-[#1f2328] dark:text-[#f1f3f7]">
                {t('settingsAppCard')}
              </span>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block font-medium mb-1.5 text-zinc-600 dark:text-[#9aa0ac]">
                  {t('themeLabel')}
                </label>
                <select
                  value={theme || 'system'}
                  onChange={(e) => setTheme(e.target.value as 'system' | 'light' | 'dark')}
                  className="w-full bg-white dark:bg-[#202127] border border-black/10 dark:border-[#343740] rounded-xl px-3 py-2 text-[#1f2328] dark:text-[#e2e5eb] focus:border-blue-500 focus:outline-none cursor-pointer"
                >
                  <option value="system">{t('themeSystem')}</option>
                  <option value="light">{t('themeLight')}</option>
                  <option value="dark">{t('themeDark')}</option>
                </select>
              </div>

              <div>
                <label className="block font-medium mb-1.5 text-zinc-600 dark:text-[#9aa0ac]">
                  {t('languageLabel')}
                </label>
                <select
                  value={language || 'system'}
                  onChange={(e) => setLanguage(e.target.value as 'system' | 'zh' | 'en')}
                  className="w-full bg-white dark:bg-[#202127] border border-black/10 dark:border-[#343740] rounded-xl px-3 py-2 text-[#1f2328] dark:text-[#e2e5eb] focus:border-blue-500 focus:outline-none cursor-pointer"
                >
                  <option value="system">{t('langSystem')}</option>
                  <option value="zh">{t('langZh')}</option>
                  <option value="en">{t('langEn')}</option>
                </select>
              </div>
            </div>

            <div>
              <label className="block font-medium mb-1.5 text-zinc-600 dark:text-[#9aa0ac]">
                {t('spotlightResetLabel')}
              </label>
              <select
                value={spotlightResetMinutes ?? 15}
                onChange={(e) => setSpotlightResetMinutes(Number(e.target.value))}
                className="w-full bg-white dark:bg-[#202127] border border-black/10 dark:border-[#343740] rounded-xl px-3 py-2 text-[#1f2328] dark:text-[#e2e5eb] focus:border-blue-500 focus:outline-none cursor-pointer"
              >
                <option value={5}>{t('spotlightReset5m')}</option>
                <option value={15}>{t('spotlightReset15m')}</option>
                <option value={30}>{t('spotlightReset30m')}</option>
                <option value={60}>{t('spotlightReset60m')}</option>
                <option value={0}>{t('spotlightResetNever')}</option>
              </select>
              <p className="mt-1.5 text-[11px] text-zinc-500 dark:text-zinc-400">
                {t('spotlightResetTip')}
              </p>
            </div>

            <div className="pt-2 flex items-center justify-between border-t border-black/5 dark:border-white/5">
              {cardResetButton(handleAppCardReset)}
              <button
                type="button"
                onClick={handleSave}
                className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs bg-blue-600 hover:bg-blue-500 text-white font-medium shadow-xs transition-colors cursor-pointer"
              >
                <Check className="w-3.5 h-3.5" />
                <span>{t('saveSettings')}</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 2. 聊天模型接入 (Chat Models) */}
      {activeTab === 'chat-models' && (
        <div className="space-y-4">
          <div>
            <h2 className="text-xl font-bold tracking-tight text-[#1f2328] dark:text-[#f1f3f7]">
              {t('tabChatModel')}
            </h2>
            <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
              {t('settingsModelCard')} · {t('apiProviderLabel')}
            </p>
          </div>

          <div className="p-4 rounded-2xl border border-black/10 dark:border-[#343740] bg-[#f8f9fb] dark:bg-[#18191c] space-y-4 shadow-xs">
            <div className="flex items-center gap-2 pb-2 border-b border-black/5 dark:border-white/5">
              <SlidersHorizontal className="w-4 h-4 text-amber-600 dark:text-amber-400" />
              <span className="font-semibold text-xs text-[#1f2328] dark:text-[#f1f3f7]">
                {t('settingsModelCard')}
              </span>
            </div>

            {/* Provider Switcher */}
            <div>
              <label className="block font-medium mb-2 text-zinc-600 dark:text-[#9aa0ac]">
                {t('apiProviderLabel')}
              </label>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                <button
                  type="button"
                  onClick={() => setApiProvider('ttf')}
                  className={`flex items-center justify-center gap-2 py-2 px-3 rounded-xl border text-xs font-medium transition-all cursor-pointer ${
                    apiProvider === 'ttf' || apiProvider === 'local'
                      ? 'bg-amber-500/10 border-amber-500/40 text-amber-700 dark:text-amber-400 font-semibold shadow-xs'
                      : 'bg-white dark:bg-[#202127] border-black/10 dark:border-[#343740] text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-white'
                  }`}
                >
                  <SlidersHorizontal className="w-3.5 h-3.5" />
                  <span className="whitespace-nowrap">{t('providerTTFShort')}</span>
                </button>
                <button
                  type="button"
                  onClick={() => setApiProvider('mference')}
                  className={`flex items-center justify-center gap-2 py-2 px-3 rounded-xl border text-xs font-medium transition-all cursor-pointer ${
                    apiProvider === 'mference'
                      ? 'bg-amber-500/10 border-amber-500/40 text-amber-700 dark:text-amber-400 font-semibold shadow-xs'
                      : 'bg-white dark:bg-[#202127] border-black/10 dark:border-[#343740] text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-white'
                  }`}
                >
                  <SlidersHorizontal className="w-3.5 h-3.5" />
                  <span className="whitespace-nowrap">{t('providerMferenceShort')}</span>
                </button>
                <button
                  type="button"
                  onClick={() => setApiProvider('custom')}
                  className={`flex items-center justify-center gap-2 py-2 px-3 rounded-xl border text-xs font-medium transition-all cursor-pointer ${
                    apiProvider === 'custom'
                      ? 'bg-emerald-500/10 border-emerald-500/40 text-emerald-700 dark:text-emerald-400 font-semibold shadow-xs'
                      : 'bg-white dark:bg-[#202127] border-black/10 dark:border-[#343740] text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-white'
                  }`}
                >
                  <Terminal className="w-3.5 h-3.5" />
                  <span className="whitespace-nowrap">{t('providerCustomShort')}</span>
                </button>
                <button
                  type="button"
                  onClick={() => setApiProvider('deepseek')}
                  className={`flex items-center justify-center gap-2 py-2 px-3 rounded-xl border text-xs font-medium transition-all cursor-pointer ${
                    apiProvider === 'deepseek'
                      ? 'bg-blue-500/10 border-blue-500/40 text-blue-700 dark:text-blue-400 font-semibold shadow-xs'
                      : 'bg-white dark:bg-[#202127] border-black/10 dark:border-[#343740] text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-white'
                  }`}
                >
                  <Sparkles className="w-3.5 h-3.5" />
                  <span>{t('providerDeepSeekShort')}</span>
                </button>
              </div>
            </div>

            {/* DeepSeek Specific Settings */}
            {apiProvider === 'deepseek' && (
              <div className="space-y-3 pt-2 border-t border-black/5 dark:border-white/5">
                <div className="p-3 rounded-xl bg-blue-500/10 border border-blue-500/20 text-blue-800 dark:text-blue-300 text-[11px] flex items-center gap-2">
                  <Sparkles className="w-4 h-4 flex-shrink-0 text-blue-600 dark:text-blue-400" />
                  <span>{t('deepseekNotice')}</span>
                </div>

                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <label className="font-medium text-zinc-600 dark:text-[#9aa0ac]">
                      {t('deepseekApiKeyLabel')}
                    </label>
                    <a
                      href="https://platform.deepseek.com"
                      target="_blank"
                      rel="noreferrer"
                      className="text-[10px] text-blue-600 dark:text-blue-400 hover:underline"
                    >
                      platform.deepseek.com ↗
                    </a>
                  </div>
                  <div className="relative">
                    <input
                      type={showApiKey ? 'text' : 'password'}
                      value={deepseekConfig.apiKey || ''}
                      onChange={(e) => setDeepseekConfig({ ...deepseekConfig, apiKey: e.target.value })}
                      placeholder={t('deepseekApiKeyPlaceholder')}
                      className="w-full bg-white dark:bg-[#202127] border border-black/10 dark:border-[#343740] rounded-xl pl-3 pr-10 py-2 text-[#1f2328] dark:text-[#e2e5eb] focus:border-blue-500 focus:outline-none font-mono"
                    />
                    <button
                      type="button"
                      onClick={() => setShowApiKey(!showApiKey)}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 p-1 cursor-pointer"
                    >
                      {showApiKey ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div>
                    <label className="block font-medium mb-1 text-zinc-600 dark:text-[#9aa0ac]">
                      {t('deepseekModelLabel')}
                    </label>
                    <select
                      value={
                        ['deepseek-flash', 'deepseek-v4-pro'].includes(deepseekConfig.modelId || 'deepseek-flash')
                          ? (deepseekConfig.modelId || 'deepseek-flash')
                          : 'custom'
                      }
                      onChange={(e) => {
                        const val = e.target.value;
                        if (val !== 'custom') setDeepseekConfig({ ...deepseekConfig, modelId: val });
                      }}
                      className="w-full bg-white dark:bg-[#202127] border border-black/10 dark:border-[#343740] rounded-xl px-3 py-2 text-[#1f2328] dark:text-[#e2e5eb] focus:border-blue-500 focus:outline-none cursor-pointer"
                    >
                      <option value="deepseek-flash">{t('deepseekModelFlash')}</option>
                      <option value="deepseek-v4-pro">{t('deepseekModelPro')}</option>
                      <option value="custom">{t('deepseekModelCustom')}</option>
                    </select>
                    {!['deepseek-flash', 'deepseek-v4-pro'].includes(deepseekConfig.modelId || 'deepseek-flash') && (
                      <input
                        type="text"
                        value={deepseekConfig.modelId || ''}
                        onChange={(e) => setDeepseekConfig({ ...deepseekConfig, modelId: e.target.value })}
                        placeholder="deepseek-flash"
                        className="w-full mt-2 bg-white dark:bg-[#202127] border border-black/10 dark:border-[#343740] rounded-xl px-3 py-2 text-[#1f2328] dark:text-[#e2e5eb] focus:border-blue-500 focus:outline-none font-mono"
                      />
                    )}
                  </div>

                  <div>
                    <label className="block font-medium mb-1 text-zinc-600 dark:text-[#9aa0ac]">
                      {t('maxContextLabel')}
                    </label>
                    <select
                      value={deepseekConfig.maxContext ?? 131072}
                      onChange={(e) => {
                        const val = Number(e.target.value);
                        setDeepseekConfig({ ...deepseekConfig, maxContext: val, maxTokens: Math.floor(val / 2) });
                      }}
                      className="w-full bg-white dark:bg-[#202127] border border-black/10 dark:border-[#343740] rounded-xl px-3 py-2 text-[#1f2328] dark:text-[#e2e5eb] focus:border-blue-500 focus:outline-none cursor-pointer"
                    >
                      <option value={32768}>32,768 (32K)</option>
                      <option value={65536}>65,536 (64K)</option>
                      <option value={131072}>{t('contextOption128kRecommended')}</option>
                      <option value={262144}>262,144 (256K)</option>
                      <option value={1000000}>1,000,000 (1M)</option>
                    </select>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div>
                    <label className="block font-medium mb-1 text-zinc-600 dark:text-[#9aa0ac]">
                      {t('deepseekBaseUrlLabel')}
                    </label>
                    <input
                      type="text"
                      value={deepseekConfig.baseUrl ?? 'https://api.deepseek.com'}
                      onChange={(e) => setDeepseekConfig({ ...deepseekConfig, baseUrl: e.target.value })}
                      placeholder="https://api.deepseek.com"
                      className="w-full bg-white dark:bg-[#202127] border border-black/10 dark:border-[#343740] rounded-xl px-3 py-2 text-[#1f2328] dark:text-[#e2e5eb] focus:border-blue-500 focus:outline-none font-mono"
                    />
                  </div>

                  <div>
                    <label className="block font-medium mb-1 text-zinc-600 dark:text-[#9aa0ac]">
                      {t('reasoningEffortLabel')}
                    </label>
                    <select
                      value={deepseekConfig.reasoningEffort || 'high'}
                      onChange={(e) => setDeepseekConfig({ ...deepseekConfig, reasoningEffort: e.target.value as any })}
                      className="w-full bg-white dark:bg-[#202127] border border-black/10 dark:border-[#343740] rounded-xl px-3 py-2 text-[#1f2328] dark:text-[#e2e5eb] focus:border-blue-500 focus:outline-none cursor-pointer"
                    >
                      <option value="high">{t('reasoningEffortHigh')}</option>
                      <option value="low">{t('reasoningEffortLow')}</option>
                      <option value="max">{t('reasoningEffortMax')}</option>
                    </select>
                  </div>
                </div>

                <div>
                  <label className="block font-medium mb-1 text-zinc-600 dark:text-[#9aa0ac]">
                    {t('systemPromptLabel')}
                  </label>
                  <textarea
                    rows={2}
                    value={deepseekConfig.systemPrompt ?? ''}
                    onChange={(e) => setDeepseekConfig({ ...deepseekConfig, systemPrompt: e.target.value })}
                    placeholder={t('systemPromptPlaceholderDeepSeek')}
                    className="w-full bg-white dark:bg-[#202127] border border-black/10 dark:border-[#343740] rounded-xl px-3 py-2 text-[#1f2328] dark:text-[#e2e5eb] focus:border-blue-500 focus:outline-none resize-none leading-relaxed"
                  />
                  <span className="text-[10px] text-zinc-500 dark:text-[#6f7582] mt-1 block">
                    {t('deepseekSystemPromptTip')}
                  </span>
                </div>

                {/* DeepSeek 高级采样参数折叠区 */}
                <div className="pt-2 border-t border-black/5 dark:border-white/5">
                  <button
                    type="button"
                    onClick={() => setShowAdvanced(!showAdvanced)}
                    className="flex items-center justify-between w-full py-2 px-3 rounded-xl bg-black/[0.02] hover:bg-black/[0.05] dark:bg-white/[0.02] dark:hover:bg-white/[0.05] text-xs text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-200 transition-colors cursor-pointer"
                  >
                    <div className="flex items-center gap-2 font-medium">
                      <SlidersHorizontal className="w-3.5 h-3.5 text-zinc-500" />
                      <span>{t('advancedSamplingTitle')}</span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-blue-500/10 text-blue-600 dark:text-blue-400 font-normal">
                        {t('advancedSamplingBadge')}
                      </span>
                    </div>
                    <ChevronDown className={`w-4 h-4 text-zinc-400 transition-transform duration-200 ${showAdvanced ? 'rotate-180' : ''}`} />
                  </button>

                  {showAdvanced && (
                    <div className="mt-3 space-y-3 pt-1">
                      {/* DeepSeek 采样参数: Temperature & Top-P */}
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        <div>
                          <div className="flex justify-between font-medium mb-1 text-zinc-600 dark:text-[#9aa0ac]">
                            <span>{t('temperatureLabel')}</span>
                            <span className="font-mono text-blue-500 dark:text-blue-400">{deepseekConfig.temperature ?? 1.0}</span>
                          </div>
                          <input
                            type="range"
                            min="0"
                            max="2"
                            step="0.05"
                            value={deepseekConfig.temperature ?? 1.0}
                            onChange={(e) => setDeepseekConfig({ ...deepseekConfig, temperature: Number(e.target.value) })}
                            className="w-full accent-blue-500"
                          />
                          <div className="flex flex-wrap gap-1 mt-1 mb-1">
                            <button
                              type="button"
                              onClick={() => setDeepseekConfig({ ...deepseekConfig, temperature: 1.0 })}
                              className={`px-1.5 py-0.5 rounded text-[10px] border transition-colors ${
                                deepseekConfig.temperature === 1.0
                                  ? 'bg-blue-500/10 border-blue-500/40 text-blue-600 dark:text-blue-400 font-medium'
                                  : 'bg-black/5 dark:bg-white/5 border-transparent text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200'
                              }`}
                            >
                              {t('presetGeneral')}
                            </button>
                            <button
                              type="button"
                              onClick={() => setDeepseekConfig({ ...deepseekConfig, temperature: 0.0 })}
                              className={`px-1.5 py-0.5 rounded text-[10px] border transition-colors ${
                                deepseekConfig.temperature === 0.0
                                  ? 'bg-blue-500/10 border-blue-500/40 text-blue-600 dark:text-blue-400 font-medium'
                                  : 'bg-black/5 dark:bg-white/5 border-transparent text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200'
                              }`}
                            >
                              {t('presetCoding')}
                            </button>
                            <button
                              type="button"
                              onClick={() => setDeepseekConfig({ ...deepseekConfig, temperature: 0.6 })}
                              className={`px-1.5 py-0.5 rounded text-[10px] border transition-colors ${
                                deepseekConfig.temperature === 0.6
                                  ? 'bg-blue-500/10 border-blue-500/40 text-blue-600 dark:text-blue-400 font-medium'
                                  : 'bg-black/5 dark:bg-white/5 border-transparent text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200'
                              }`}
                            >
                              {t('presetThinking')}
                            </button>
                            <button
                              type="button"
                              onClick={() => setDeepseekConfig({ ...deepseekConfig, temperature: 1.5 })}
                              className={`px-1.5 py-0.5 rounded text-[10px] border transition-colors ${
                                deepseekConfig.temperature === 1.5
                                  ? 'bg-blue-500/10 border-blue-500/40 text-blue-600 dark:text-blue-400 font-medium'
                                  : 'bg-black/5 dark:bg-white/5 border-transparent text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200'
                              }`}
                            >
                              {t('presetCreative')}
                            </button>
                          </div>
                        </div>

                        <div>
                          <div className="flex justify-between font-medium mb-1 text-zinc-600 dark:text-[#9aa0ac]">
                            <span>{t('topPLabel')}</span>
                            <span className="font-mono text-blue-500 dark:text-blue-400">{deepseekConfig.topP ?? 1.0}</span>
                          </div>
                          <input
                            type="range"
                            min="0.05"
                            max="1.0"
                            step="0.05"
                            value={deepseekConfig.topP ?? 1.0}
                            onChange={(e) => setDeepseekConfig({ ...deepseekConfig, topP: Number(e.target.value) })}
                            className="w-full accent-blue-500"
                          />
                          <div className="flex flex-wrap gap-1 mt-1 mb-1">
                            <button
                              type="button"
                              onClick={() => setDeepseekConfig({ ...deepseekConfig, topP: 1.0 })}
                              className={`px-1.5 py-0.5 rounded text-[10px] border transition-colors ${
                                deepseekConfig.topP === 1.0
                                  ? 'bg-blue-500/10 border-blue-500/40 text-blue-600 dark:text-blue-400 font-medium'
                                  : 'bg-black/5 dark:bg-white/5 border-transparent text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200'
                              }`}
                            >
                              {t('presetGeneral')}
                            </button>
                            <button
                              type="button"
                              onClick={() => setDeepseekConfig({ ...deepseekConfig, topP: 0.95 })}
                              className={`px-1.5 py-0.5 rounded text-[10px] border transition-colors ${
                                deepseekConfig.topP === 0.95
                                  ? 'bg-blue-500/10 border-blue-500/40 text-blue-600 dark:text-blue-400 font-medium'
                                  : 'bg-black/5 dark:bg-white/5 border-transparent text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200'
                              }`}
                            >
                              0.95
                            </button>
                          </div>
                          <span className="text-[10px] text-zinc-500 dark:text-[#6f7582] leading-tight block">
                            {t('deepseekTopPTip')}
                          </span>
                        </div>
                      </div>

                      {/* DeepSeek Max Tokens & Seed */}
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        <div>
                          <div className="flex items-center justify-between mb-1">
                            <label className="font-medium text-zinc-600 dark:text-[#9aa0ac]">
                              {t('maxTokensLabel')}
                            </label>
                            <span className="text-[10px] text-blue-600 dark:text-blue-400 font-medium bg-blue-500/10 px-1.5 py-0.5 rounded">
                              {t('linkedHalf')}
                            </span>
                          </div>
                          <input
                            type="text"
                            readOnly
                            value={`${Math.floor((deepseekConfig.maxContext || 131072) / 2)} tokens (${Math.round(Math.floor((deepseekConfig.maxContext || 131072) / 2) / 1024)}K)`}
                            className="w-full bg-zinc-100 dark:bg-[#18191c] border border-black/10 dark:border-[#343740] rounded-xl px-3 py-2 text-zinc-600 dark:text-[#abb0bc] cursor-not-allowed font-mono select-none"
                          />
                        </div>

                        <div>
                          <label className="block font-medium mb-1 text-zinc-600 dark:text-[#9aa0ac]">
                            {t('seedLabel')}
                          </label>
                          <input
                            type="number"
                            value={deepseekConfig.seed ?? ''}
                            onChange={(e) =>
                              setDeepseekConfig({
                                ...deepseekConfig,
                                seed: e.target.value ? Number(e.target.value) : undefined,
                              })
                            }
                            placeholder={t('seedPlaceholder')}
                            className="w-full bg-white dark:bg-[#202127] border border-black/10 dark:border-[#343740] rounded-xl px-3 py-2 text-[#1f2328] dark:text-[#e2e5eb] focus:border-blue-500 focus:outline-none font-mono"
                          />
                        </div>
                      </div>

                      {/* DeepSeek Stop Sequences */}
                      <div>
                        <label className="block font-medium mb-1 text-zinc-600 dark:text-[#9aa0ac]">
                          {t('stopLabel')}
                        </label>
                        <input
                          type="text"
                          value={deepseekStopInput}
                          onChange={(e) => setDeepseekStopInput(e.target.value)}
                          placeholder={t('stopPlaceholder')}
                          className="w-full bg-white dark:bg-[#202127] border border-black/10 dark:border-[#343740] rounded-xl px-3 py-2 text-[#1f2328] dark:text-[#e2e5eb] focus:border-blue-500 focus:outline-none font-mono"
                        />
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Custom Provider Settings */}
            {apiProvider === 'custom' && (
              <div className="space-y-3 pt-2 border-t border-black/5 dark:border-white/5">
                <div className="p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-800 dark:text-emerald-300 text-[11px] flex items-center gap-2">
                  <Terminal className="w-4 h-4 flex-shrink-0 text-emerald-600 dark:text-emerald-400" />
                  <span>{t('customNotice')}</span>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div>
                    <label className="block font-medium mb-1 text-zinc-600 dark:text-[#9aa0ac]">
                      {t('servicePortLabel')}
                    </label>
                    <select
                      value={[11434, 8000, 8080, 1234, 5000].includes(customConfig.apiPort) ? customConfig.apiPort : 'custom'}
                      onChange={(e) => {
                        const val = e.target.value;
                        if (val !== 'custom') {
                          setCustomConfig({ ...customConfig, apiPort: Number(val) });
                        }
                      }}
                      className="w-full bg-white dark:bg-[#202127] border border-black/10 dark:border-[#343740] rounded-xl px-3 py-2 text-[#1f2328] dark:text-[#e2e5eb] focus:border-emerald-500 focus:outline-none cursor-pointer"
                    >
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
                      value={customConfig.apiPort ?? 11434}
                      onChange={(e) => setCustomConfig({ ...customConfig, apiPort: Number(e.target.value) || 11434 })}
                      placeholder="11434"
                      className="w-full bg-white dark:bg-[#202127] border border-black/10 dark:border-[#343740] rounded-xl px-3 py-2 text-[#1f2328] dark:text-[#e2e5eb] focus:border-emerald-500 focus:outline-none font-mono"
                    />
                  </div>
                </div>

                <div>
                  <label className="block font-medium mb-1 text-zinc-600 dark:text-[#9aa0ac]">
                    {t('customBaseUrlLabel')}
                  </label>
                  <input
                    type="text"
                    value={customConfig.apiBaseUrl ?? ''}
                    onChange={(e) => setCustomConfig({ ...customConfig, apiBaseUrl: e.target.value })}
                    placeholder={t('customBaseUrlPlaceholder')}
                    className="w-full bg-white dark:bg-[#202127] border border-black/10 dark:border-[#343740] rounded-xl px-3 py-2 text-[#1f2328] dark:text-[#e2e5eb] focus:border-emerald-500 focus:outline-none font-mono"
                  />
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div>
                    <label className="block font-medium mb-1 text-zinc-600 dark:text-[#9aa0ac]">
                      {t('customModelLabel')}
                    </label>
                    <input
                      type="text"
                      value={customConfig.modelId ?? 'llama3'}
                      onChange={(e) => setCustomConfig({ ...customConfig, modelId: e.target.value })}
                      placeholder={t('customModelPlaceholder')}
                      className="w-full bg-white dark:bg-[#202127] border border-black/10 dark:border-[#343740] rounded-xl px-3 py-2 text-[#1f2328] dark:text-[#e2e5eb] focus:border-emerald-500 focus:outline-none font-mono"
                    />
                  </div>
                  <div>
                    <label className="block font-medium mb-1 text-zinc-600 dark:text-[#9aa0ac]">
                      {t('maxContextLabel')}
                    </label>
                    <select
                      value={customConfig.maxContext ?? 8192}
                      onChange={(e) => {
                        const val = Number(e.target.value);
                        setCustomConfig({
                          ...customConfig,
                          maxContext: val,
                          maxTokens: Math.min(customConfig.maxTokens || 4096, Math.floor(val / 2)),
                        });
                      }}
                      className="w-full bg-white dark:bg-[#202127] border border-black/10 dark:border-[#343740] rounded-xl px-3 py-2 text-[#1f2328] dark:text-[#e2e5eb] focus:border-emerald-500 focus:outline-none cursor-pointer"
                    >
                      <option value={4096}>4,096 (4K)</option>
                      <option value={8192}>8,192 (8K)</option>
                      <option value={16384}>16,384 (16K)</option>
                      <option value={32768}>32,768 (32K)</option>
                      <option value={65536}>65,536 (64K)</option>
                      <option value={131072}>131,072 (128K)</option>
                    </select>
                  </div>
                </div>

                <div>
                  <label className="block font-medium mb-1 text-zinc-600 dark:text-[#9aa0ac]">
                    {t('systemPromptLabel')}
                  </label>
                  <textarea
                    rows={2}
                    value={customConfig.systemPrompt ?? ''}
                    onChange={(e) => setCustomConfig({ ...customConfig, systemPrompt: e.target.value })}
                    placeholder={t('systemPromptPlaceholderLocal')}
                    className="w-full bg-white dark:bg-[#202127] border border-black/10 dark:border-[#343740] rounded-xl px-3 py-2 text-[#1f2328] dark:text-[#e2e5eb] focus:border-emerald-500 focus:outline-none resize-none leading-relaxed"
                  />
                </div>

                {/* Custom 高级采样参数折叠区 */}
                <div className="pt-2 border-t border-black/5 dark:border-white/5">
                  <button
                    type="button"
                    onClick={() => setShowAdvanced(!showAdvanced)}
                    className="flex items-center justify-between w-full py-2 px-3 rounded-xl bg-black/[0.02] hover:bg-black/[0.05] dark:bg-white/[0.02] dark:hover:bg-white/[0.05] text-xs text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-200 transition-colors cursor-pointer"
                  >
                    <div className="flex items-center gap-2 font-medium">
                      <SlidersHorizontal className="w-3.5 h-3.5 text-zinc-500" />
                      <span>{t('advancedSamplingTitleShort')}</span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 font-normal">
                        {t('advancedSamplingBadge')}
                      </span>
                    </div>
                    <ChevronDown className={`w-4 h-4 text-zinc-400 transition-transform duration-200 ${showAdvanced ? 'rotate-180' : ''}`} />
                  </button>

                  {showAdvanced && (
                    <div className="mt-3 space-y-3 pt-1">
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        <div>
                          <label className="block font-medium mb-1 text-zinc-600 dark:text-[#9aa0ac]">
                            {t('maxTokensLabel')}
                          </label>
                          <input
                            type="number"
                            min="256"
                            max={customConfig.maxContext ?? 8192}
                            step="256"
                            value={customConfig.maxTokens ?? 4096}
                            onChange={(e) => setCustomConfig({ ...customConfig, maxTokens: Number(e.target.value) || 4096 })}
                            className="w-full bg-white dark:bg-[#202127] border border-black/10 dark:border-[#343740] rounded-xl px-3 py-2 text-[#1f2328] dark:text-[#e2e5eb] focus:border-emerald-500 focus:outline-none font-mono"
                          />
                        </div>
                        <div>
                          <div className="flex justify-between font-medium mb-1 text-zinc-600 dark:text-[#9aa0ac]">
                            <span>{t('temperatureLabel')}</span>
                            <span className="font-mono text-emerald-500 dark:text-emerald-400">{customConfig.temperature ?? 0.7}</span>
                          </div>
                          <input
                            type="range"
                            min="0"
                            max="2"
                            step="0.05"
                            value={customConfig.temperature ?? 0.7}
                            onChange={(e) => setCustomConfig({ ...customConfig, temperature: Number(e.target.value) })}
                            className="w-full accent-emerald-500"
                          />
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* TTF (Gemma 4) Settings */}
            {(apiProvider === 'ttf' || apiProvider === 'local') && (
              <div className="space-y-3 pt-2 border-t border-black/5 dark:border-white/5">
                <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-800 dark:text-amber-300 text-[11px] flex items-center gap-2">
                  <SlidersHorizontal className="w-4 h-4 flex-shrink-0 text-amber-600 dark:text-amber-400" />
                  <span>{t('ttfServiceAutoStartDesc')}</span>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div>
                    <label className="block font-medium mb-1 text-zinc-600 dark:text-[#9aa0ac]">
                      {t('servicePortLabel')}
                    </label>
                    <input
                      type="number"
                      min="1"
                      max="65535"
                      value={ttfConfig.apiPort ?? 1235}
                      onChange={(e) => setTtfConfig({ ...ttfConfig, apiPort: Number(e.target.value) || 1235 })}
                      placeholder="1235"
                      className="w-full bg-white dark:bg-[#202127] border border-black/10 dark:border-[#343740] rounded-xl px-3 py-2 text-[#1f2328] dark:text-[#e2e5eb] focus:border-amber-500 focus:outline-none font-mono"
                    />
                  </div>
                  <div>
                    <label className="block font-medium mb-1 text-zinc-600 dark:text-[#9aa0ac]">
                      {t('customBaseUrlLabel')}
                    </label>
                    <input
                      type="text"
                      value={ttfConfig.apiBaseUrl ?? ''}
                      onChange={(e) => setTtfConfig({ ...ttfConfig, apiBaseUrl: e.target.value })}
                      placeholder="http://127.0.0.1:1235"
                      className="w-full bg-white dark:bg-[#202127] border border-black/10 dark:border-[#343740] rounded-xl px-3 py-2 text-[#1f2328] dark:text-[#e2e5eb] focus:border-amber-500 focus:outline-none font-mono"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div>
                    <label className="block font-medium mb-1 text-zinc-600 dark:text-[#9aa0ac]">
                      {t('modelLabel')}
                    </label>
                    <input
                      type="text"
                      value={ttfConfig.modelId ?? 'gemma-4-26b-a4b-it'}
                      onChange={(e) => setTtfConfig({ ...ttfConfig, modelId: e.target.value })}
                      className="w-full bg-white dark:bg-[#202127] border border-black/10 dark:border-[#343740] rounded-xl px-3 py-2 text-[#1f2328] dark:text-[#e2e5eb] focus:border-amber-500 focus:outline-none font-mono"
                    />
                  </div>
                  <div>
                    <label className="block font-medium mb-1 text-zinc-600 dark:text-[#9aa0ac]">
                      {t('maxContextLabel')}
                    </label>
                    <select
                      value={ttfConfig.maxContext ?? 16384}
                      onChange={(e) => {
                        const val = Number(e.target.value);
                        setTtfConfig({ ...ttfConfig, maxContext: val, maxTokens: Math.floor(val / 2) });
                      }}
                      className="w-full bg-white dark:bg-[#202127] border border-black/10 dark:border-[#343740] rounded-xl px-3 py-2 text-[#1f2328] dark:text-[#e2e5eb] focus:border-amber-500 focus:outline-none cursor-pointer"
                    >
                      <option value={8192}>8,192 (8K)</option>
                      <option value={16384}>{t('contextOption16kDefault')}</option>
                      <option value={32768}>32,768 (32K)</option>
                      <option value={65536}>65,536 (64K)</option>
                      <option value={131072}>131,072 (128K)</option>
                      <option value={262144}>262,144 (256K)</option>
                    </select>
                  </div>
                </div>

                <div>
                  <label className="block font-medium mb-1 text-zinc-600 dark:text-[#9aa0ac]">
                    {t('systemPromptLabel')}
                  </label>
                  <textarea
                    rows={2}
                    value={ttfConfig.systemPrompt ?? ''}
                    onChange={(e) => setTtfConfig({ ...ttfConfig, systemPrompt: e.target.value })}
                    placeholder={t('systemPromptPlaceholderLocal')}
                    className="w-full bg-white dark:bg-[#202127] border border-black/10 dark:border-[#343740] rounded-xl px-3 py-2 text-[#1f2328] dark:text-[#e2e5eb] focus:border-amber-500 focus:outline-none resize-none leading-relaxed"
                  />
                </div>

                {/* TTF 高级采样参数折叠区 */}
                <div className="pt-2 border-t border-black/5 dark:border-white/5">
                  <button
                    type="button"
                    onClick={() => setShowAdvanced(!showAdvanced)}
                    className="flex items-center justify-between w-full py-2 px-3 rounded-xl bg-black/[0.02] hover:bg-black/[0.05] dark:bg-white/[0.02] dark:hover:bg-white/[0.05] text-xs text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-200 transition-colors cursor-pointer"
                  >
                    <div className="flex items-center gap-2 font-medium">
                      <SlidersHorizontal className="w-3.5 h-3.5 text-zinc-500" />
                      <span>{t('advancedSamplingTitle')}</span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-amber-500/10 text-amber-600 dark:text-amber-400 font-normal">
                        {t('advancedSamplingBadge')}
                      </span>
                    </div>
                    <ChevronDown className={`w-4 h-4 text-zinc-400 transition-transform duration-200 ${showAdvanced ? 'rotate-180' : ''}`} />
                  </button>

                  {showAdvanced && (
                    <div className="mt-3 space-y-3 pt-1">
                      {/* Reasoning Fixed Notice */}
                      <div className="p-2.5 rounded-xl bg-black/[0.03] dark:bg-white/[0.03] border border-black/5 dark:border-white/5 text-zinc-500 dark:text-[#8c929f] text-[11px] leading-relaxed">
                        {t('ttfReasoningFixedNotice')}
                      </div>

                      {/* Temperature & Top-P */}
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        <div>
                          <div className="flex justify-between font-medium mb-1 text-zinc-600 dark:text-[#9aa0ac]">
                            <span>{t('temperatureLabel')}</span>
                            <span className="font-mono text-amber-500 dark:text-amber-400">{ttfConfig.temperature ?? 1.0}</span>
                          </div>
                          <input
                            type="range"
                            min="0"
                            max="2"
                            step="0.05"
                            value={ttfConfig.temperature ?? 1.0}
                            onChange={(e) => setTtfConfig({ ...ttfConfig, temperature: Number(e.target.value) })}
                            className="w-full accent-amber-500"
                          />
                          <span className="text-[10px] text-zinc-500 dark:text-[#6f7582]">{t('temperatureTip')}</span>
                        </div>
                        <div>
                          <div className="flex justify-between font-medium mb-1 text-zinc-600 dark:text-[#9aa0ac]">
                            <span>{t('topPLabel')}</span>
                            <span className="font-mono text-amber-500 dark:text-amber-400">{ttfConfig.topP ?? 0.95}</span>
                          </div>
                          <input
                            type="range"
                            min="0.01"
                            max="1.0"
                            step="0.01"
                            value={ttfConfig.topP ?? 0.95}
                            onChange={(e) => setTtfConfig({ ...ttfConfig, topP: Number(e.target.value) })}
                            className="w-full accent-amber-500"
                          />
                          <span className="text-[10px] text-zinc-500 dark:text-[#6f7582]">{t('topPTip')}</span>
                        </div>
                      </div>

                      {/* Top-K & Repetition Penalty */}
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        <div>
                          <div className="flex justify-between font-medium mb-1 text-zinc-600 dark:text-[#9aa0ac]">
                            <span>{t('topKLabel')}</span>
                            <span className="font-mono text-amber-500 dark:text-amber-400">{ttfConfig.topK ?? 64}</span>
                          </div>
                          <input
                            type="range"
                            min="1"
                            max="256"
                            step="1"
                            value={ttfConfig.topK ?? 64}
                            onChange={(e) => setTtfConfig({ ...ttfConfig, topK: Number(e.target.value) })}
                            className="w-full accent-amber-500"
                          />
                          <span className="text-[10px] text-zinc-500 dark:text-[#6f7582]">{t('topKTip')}</span>
                        </div>
                        <div>
                          <div className="flex justify-between font-medium mb-1 text-zinc-600 dark:text-[#9aa0ac]">
                            <span>{t('repetitionPenaltyLabel')}</span>
                            <span className="font-mono text-amber-500 dark:text-amber-400">{ttfConfig.repetitionPenalty ?? 1.0}</span>
                          </div>
                          <input
                            type="range"
                            min="0.5"
                            max="2.0"
                            step="0.05"
                            value={ttfConfig.repetitionPenalty ?? 1.0}
                            onChange={(e) => setTtfConfig({ ...ttfConfig, repetitionPenalty: Number(e.target.value) })}
                            className="w-full accent-amber-500"
                          />
                          <span className="text-[10px] text-zinc-500 dark:text-[#6f7582]">{t('repetitionPenaltyTip')}</span>
                        </div>
                      </div>

                      {/* Max Tokens & Seed */}
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
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
                            value={`${ttfConfig.maxTokens || Math.floor((ttfConfig.maxContext || 16384) / 2)} tokens (${Math.round((ttfConfig.maxTokens || Math.floor((ttfConfig.maxContext || 16384) / 2)) / 1024)}K)`}
                            className="w-full bg-zinc-100 dark:bg-[#18191c] border border-black/10 dark:border-[#343740] rounded-xl px-3 py-2 text-zinc-600 dark:text-[#abb0bc] cursor-not-allowed font-mono select-none"
                          />
                        </div>
                        <div>
                          <label className="block font-medium mb-1 text-zinc-600 dark:text-[#9aa0ac]">
                            {t('seedLabel')}
                          </label>
                          <input
                            type="number"
                            value={ttfConfig.seed ?? ''}
                            onChange={(e) =>
                              setTtfConfig({
                                ...ttfConfig,
                                seed: e.target.value ? Number(e.target.value) : undefined,
                              })
                            }
                            placeholder={t('seedPlaceholder')}
                            className="w-full bg-white dark:bg-[#202127] border border-black/10 dark:border-[#343740] rounded-xl px-3 py-2 text-[#1f2328] dark:text-[#e2e5eb] focus:border-amber-500 focus:outline-none font-mono"
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
                          value={ttfStopInput}
                          onChange={(e) => setTtfStopInput(e.target.value)}
                          placeholder={t('stopPlaceholder')}
                          className="w-full bg-white dark:bg-[#202127] border border-black/10 dark:border-[#343740] rounded-xl px-3 py-2 text-[#1f2328] dark:text-[#e2e5eb] focus:border-amber-500 focus:outline-none font-mono"
                        />
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Mference (Qwen 3.6) Settings */}
            {apiProvider === 'mference' && (
              <div className="space-y-3 pt-2 border-t border-black/5 dark:border-white/5">
                <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-800 dark:text-amber-300 text-[11px] flex items-center gap-2">
                  <SlidersHorizontal className="w-4 h-4 flex-shrink-0 text-amber-600 dark:text-amber-400" />
                  <span>{t('mferenceServiceAutoStartDesc')}</span>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div>
                    <label className="block font-medium mb-1 text-zinc-600 dark:text-[#9aa0ac]">
                      {t('servicePortLabel')}
                    </label>
                    <input
                      type="number"
                      min="1"
                      max="65535"
                      value={mferenceConfig.apiPort ?? 1241}
                      onChange={(e) => setMferenceConfig({ ...mferenceConfig, apiPort: Number(e.target.value) || 1241 })}
                      placeholder="1241"
                      className="w-full bg-white dark:bg-[#202127] border border-black/10 dark:border-[#343740] rounded-xl px-3 py-2 text-[#1f2328] dark:text-[#e2e5eb] focus:border-amber-500 focus:outline-none font-mono"
                    />
                  </div>
                  <div>
                    <label className="block font-medium mb-1 text-zinc-600 dark:text-[#9aa0ac]">
                      {t('customBaseUrlLabel')}
                    </label>
                    <input
                      type="text"
                      value={mferenceConfig.apiBaseUrl ?? ''}
                      onChange={(e) => setMferenceConfig({ ...mferenceConfig, apiBaseUrl: e.target.value })}
                      placeholder="http://127.0.0.1:1241"
                      className="w-full bg-white dark:bg-[#202127] border border-black/10 dark:border-[#343740] rounded-xl px-3 py-2 text-[#1f2328] dark:text-[#e2e5eb] focus:border-amber-500 focus:outline-none font-mono"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div>
                    <label className="block font-medium mb-1 text-zinc-600 dark:text-[#9aa0ac]">
                      {t('modelLabel')}
                    </label>
                    <input
                      type="text"
                      value={mferenceConfig.modelId ?? 'qwen3.6-35b-a3b'}
                      onChange={(e) => setMferenceConfig({ ...mferenceConfig, modelId: e.target.value })}
                      className="w-full bg-white dark:bg-[#202127] border border-black/10 dark:border-[#343740] rounded-xl px-3 py-2 text-[#1f2328] dark:text-[#e2e5eb] focus:border-amber-500 focus:outline-none font-mono"
                    />
                  </div>
                  <div>
                    <label className="block font-medium mb-1 text-zinc-600 dark:text-[#9aa0ac]">
                      {t('maxContextLabel')}
                    </label>
                    <select
                      value={mferenceConfig.maxContext ?? 16384}
                      onChange={(e) => {
                        const val = Number(e.target.value);
                        setMferenceConfig({ ...mferenceConfig, maxContext: val, maxTokens: Math.floor(val / 2) });
                      }}
                      className="w-full bg-white dark:bg-[#202127] border border-black/10 dark:border-[#343740] rounded-xl px-3 py-2 text-[#1f2328] dark:text-[#e2e5eb] focus:border-amber-500 focus:outline-none cursor-pointer"
                    >
                      <option value={8192}>8,192 (8K)</option>
                      <option value={16384}>{t('contextOption16kDefault')}</option>
                      <option value={32768}>32,768 (32K)</option>
                      <option value={65536}>65,536 (64K)</option>
                      <option value={128000}>128,000 (128K)</option>
                    </select>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div>
                    <label className="block font-medium mb-1 text-zinc-600 dark:text-[#9aa0ac]">
                      {t('reasoningEffortLabel')}
                    </label>
                    <select
                      value={mferenceConfig.reasoningEffort ?? 'low'}
                      onChange={(e) => setMferenceConfig({ ...mferenceConfig, reasoningEffort: e.target.value as any })}
                      className="w-full bg-white dark:bg-[#202127] border border-black/10 dark:border-[#343740] rounded-xl px-3 py-2 text-[#1f2328] dark:text-[#e2e5eb] focus:border-amber-500 focus:outline-none cursor-pointer"
                    >
                      <option value="low">{t('reasoningEffortLow')}</option>
                      <option value="medium">{t('reasoningEffortMed')}</option>
                      <option value="high">{t('reasoningEffortHigh')}</option>
                    </select>
                  </div>

                  <div>
                    <label className="block font-medium mb-1 text-zinc-600 dark:text-[#9aa0ac]">
                      {t('systemPromptLabel')}
                    </label>
                    <input
                      type="text"
                      value={mferenceConfig.systemPrompt ?? ''}
                      onChange={(e) => setMferenceConfig({ ...mferenceConfig, systemPrompt: e.target.value })}
                      placeholder={t('systemPromptPlaceholderMference')}
                      className="w-full bg-white dark:bg-[#202127] border border-black/10 dark:border-[#343740] rounded-xl px-3 py-2 text-[#1f2328] dark:text-[#e2e5eb] focus:border-amber-500 focus:outline-none font-mono"
                    />
                  </div>
                </div>

                {/* Mference 高级采样参数折叠区 */}
                <div className="pt-2 border-t border-black/5 dark:border-white/5">
                  <button
                    type="button"
                    onClick={() => setShowAdvanced(!showAdvanced)}
                    className="flex items-center justify-between w-full py-2 px-3 rounded-xl bg-black/[0.02] hover:bg-black/[0.05] dark:bg-white/[0.02] dark:hover:bg-white/[0.05] text-xs text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-200 transition-colors cursor-pointer"
                  >
                    <div className="flex items-center gap-2 font-medium">
                      <SlidersHorizontal className="w-3.5 h-3.5 text-zinc-500" />
                      <span>{t('advancedSamplingTitle')}</span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-amber-500/10 text-amber-600 dark:text-amber-400 font-normal">
                        {t('advancedSamplingBadge')}
                      </span>
                    </div>
                    <ChevronDown className={`w-4 h-4 text-zinc-400 transition-transform duration-200 ${showAdvanced ? 'rotate-180' : ''}`} />
                  </button>

                  {showAdvanced && (
                    <div className="mt-3 space-y-3 pt-1">
                      {/* Temperature & Top-P */}
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        <div>
                          <div className="flex justify-between font-medium mb-1 text-zinc-600 dark:text-[#9aa0ac]">
                            <span>{t('temperatureLabel')}</span>
                            <span className="font-mono text-amber-500 dark:text-amber-400">{mferenceConfig.temperature ?? 1.0}</span>
                          </div>
                          <input
                            type="range"
                            min="0"
                            max="2"
                            step="0.05"
                            value={mferenceConfig.temperature ?? 1.0}
                            onChange={(e) => setMferenceConfig({ ...mferenceConfig, temperature: Number(e.target.value) })}
                            className="w-full accent-amber-500"
                          />
                          <span className="text-[10px] text-zinc-500 dark:text-[#6f7582]">{t('temperatureTip')}</span>
                        </div>
                        <div>
                          <div className="flex justify-between font-medium mb-1 text-zinc-600 dark:text-[#9aa0ac]">
                            <span>{t('topPLabel')}</span>
                            <span className="font-mono text-amber-500 dark:text-amber-400">{mferenceConfig.topP ?? 0.95}</span>
                          </div>
                          <input
                            type="range"
                            min="0.01"
                            max="1.0"
                            step="0.01"
                            value={mferenceConfig.topP ?? 0.95}
                            onChange={(e) => setMferenceConfig({ ...mferenceConfig, topP: Number(e.target.value) })}
                            className="w-full accent-amber-500"
                          />
                          <span className="text-[10px] text-zinc-500 dark:text-[#6f7582]">{t('topPTip')}</span>
                        </div>
                      </div>

                      {/* Top-K & Min-P */}
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        <div>
                          <div className="flex justify-between font-medium mb-1 text-zinc-600 dark:text-[#9aa0ac]">
                            <span>{t('topKLabel')}</span>
                            <span className="font-mono text-amber-500 dark:text-amber-400">{mferenceConfig.topK ?? 20}</span>
                          </div>
                          <input
                            type="range"
                            min="1"
                            max="256"
                            step="1"
                            value={mferenceConfig.topK ?? 20}
                            onChange={(e) => setMferenceConfig({ ...mferenceConfig, topK: Number(e.target.value) })}
                            className="w-full accent-amber-500"
                          />
                          <span className="text-[10px] text-zinc-500 dark:text-[#6f7582]">{t('topKTip')}</span>
                        </div>
                        <div>
                          <div className="flex justify-between font-medium mb-1 text-zinc-600 dark:text-[#9aa0ac]">
                            <span>{t('minPLabel')}</span>
                            <span className="font-mono text-amber-500 dark:text-amber-400">{mferenceConfig.minP ?? 0.0}</span>
                          </div>
                          <input
                            type="range"
                            min="0.0"
                            max="1.0"
                            step="0.01"
                            value={mferenceConfig.minP ?? 0.0}
                            onChange={(e) => setMferenceConfig({ ...mferenceConfig, minP: Number(e.target.value) })}
                            className="w-full accent-amber-500"
                          />
                          <span className="text-[10px] text-zinc-500 dark:text-[#6f7582]">{t('minPTip')}</span>
                        </div>
                      </div>

                      {/* Presence Penalty & Repetition Penalty */}
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        <div>
                          <div className="flex justify-between font-medium mb-1 text-zinc-600 dark:text-[#9aa0ac]">
                            <span>{t('presencePenaltyLabel')}</span>
                            <span className="font-mono text-amber-500 dark:text-amber-400">{mferenceConfig.presencePenalty ?? 1.5}</span>
                          </div>
                          <input
                            type="range"
                            min="-2.0"
                            max="2.0"
                            step="0.05"
                            value={mferenceConfig.presencePenalty ?? 1.5}
                            onChange={(e) => setMferenceConfig({ ...mferenceConfig, presencePenalty: Number(e.target.value) })}
                            className="w-full accent-amber-500"
                          />
                          <span className="text-[10px] text-zinc-500 dark:text-[#6f7582]">{t('presencePenaltyTip')}</span>
                        </div>
                        <div>
                          <div className="flex justify-between font-medium mb-1 text-zinc-600 dark:text-[#9aa0ac]">
                            <span>{t('repetitionPenaltyLabel')}</span>
                            <span className="font-mono text-amber-500 dark:text-amber-400">{mferenceConfig.repetitionPenalty ?? 1.0}</span>
                          </div>
                          <input
                            type="range"
                            min="0.5"
                            max="2.0"
                            step="0.05"
                            value={mferenceConfig.repetitionPenalty ?? 1.0}
                            onChange={(e) => setMferenceConfig({ ...mferenceConfig, repetitionPenalty: Number(e.target.value) })}
                            className="w-full accent-amber-500"
                          />
                          <span className="text-[10px] text-zinc-500 dark:text-[#6f7582]">{t('repetitionPenaltyTip')}</span>
                        </div>
                      </div>

                      {/* Max Tokens & Seed */}
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
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
                            value={`${mferenceConfig.maxTokens || Math.floor((mferenceConfig.maxContext || 16384) / 2)} tokens (${Math.round((mferenceConfig.maxTokens || Math.floor((mferenceConfig.maxContext || 16384) / 2)) / 1024)}K)`}
                            className="w-full bg-zinc-100 dark:bg-[#18191c] border border-black/10 dark:border-[#343740] rounded-xl px-3 py-2 text-zinc-600 dark:text-[#abb0bc] cursor-not-allowed font-mono select-none"
                          />
                        </div>
                        <div>
                          <label className="block font-medium mb-1 text-zinc-600 dark:text-[#9aa0ac]">
                            {t('seedLabel')}
                          </label>
                          <input
                            type="number"
                            value={mferenceConfig.seed ?? ''}
                            onChange={(e) =>
                              setMferenceConfig({
                                ...mferenceConfig,
                                seed: e.target.value ? Number(e.target.value) : undefined,
                              })
                            }
                            placeholder={t('seedPlaceholder')}
                            className="w-full bg-white dark:bg-[#202127] border border-black/10 dark:border-[#343740] rounded-xl px-3 py-2 text-[#1f2328] dark:text-[#e2e5eb] focus:border-amber-500 focus:outline-none font-mono"
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
                          value={mferenceStopInput}
                          onChange={(e) => setMferenceStopInput(e.target.value)}
                          placeholder={t('stopPlaceholder')}
                          className="w-full bg-white dark:bg-[#202127] border border-black/10 dark:border-[#343740] rounded-xl px-3 py-2 text-[#1f2328] dark:text-[#e2e5eb] focus:border-amber-500 focus:outline-none font-mono"
                        />
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

            <div className="pt-2 flex items-center justify-between border-t border-black/5 dark:border-white/5">
              {cardResetButton(handleModelCardReset)}
              <button
                type="button"
                onClick={handleSave}
                className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs bg-blue-600 hover:bg-blue-500 text-white font-medium shadow-xs transition-colors cursor-pointer"
              >
                <Check className="w-3.5 h-3.5" />
                <span>{t('saveSettings')}</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 3. 存储与空间 (Storage & Media) */}
      {activeTab === 'storage' && (
        <div className="space-y-4">
          <div>
            <h2 className="text-xl font-bold tracking-tight text-[#1f2328] dark:text-[#f1f3f7]">
              {t('tabStorage')}
            </h2>
          </div>

          <div className="p-4 rounded-2xl border border-black/10 dark:border-[#343740] bg-[#f8f9fb] dark:bg-[#18191c] space-y-4 shadow-xs">
            <div className="flex items-center gap-2 pb-2 border-b border-black/5 dark:border-white/5">
              <HardDrive className="w-4 h-4 text-zinc-600 dark:text-zinc-400" />
              <span className="font-semibold text-xs text-[#1f2328] dark:text-[#f1f3f7]">
                {t('mediaStorageTitle')}
              </span>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
              <div className="p-3.5 rounded-xl bg-white dark:bg-[#202127] border border-black/5 dark:border-white/5">
                <div className="text-[11px] text-zinc-500 dark:text-zinc-400">
                  {t('mediaTotalFiles')}
                </div>
                <div className="text-lg font-bold text-[#1f2328] dark:text-[#f1f3f7] mt-1">
                  {mediaStats ? mediaStats.fileCount : '—'}
                </div>
              </div>

              <div className="p-3.5 rounded-xl bg-white dark:bg-[#202127] border border-black/5 dark:border-white/5">
                <div className="text-[11px] text-zinc-500 dark:text-zinc-400">
                  {t('mediaTotalSize')}
                </div>
                <div className="text-lg font-bold text-[#1f2328] dark:text-[#f1f3f7] mt-1">
                  {mediaStats ? `${mediaStats.totalMB} MB` : '—'}
                </div>
              </div>

              <div className="p-3.5 rounded-xl bg-white dark:bg-[#202127] border border-black/5 dark:border-white/5 col-span-2 md:col-span-1">
                <div className="text-[11px] text-zinc-500 dark:text-zinc-400">
                  {t('mediaOrphanFiles')}
                </div>
                <div className="text-lg font-bold text-amber-600 dark:text-amber-400 mt-1">
                  {mediaStats ? `${mediaStats.orphanCount} (${mediaStats.orphanMB} MB)` : '—'}
                </div>
              </div>
            </div>

            <p className="text-[11px] text-zinc-500 dark:text-zinc-400 leading-relaxed">
              {t('mediaStorageDesc')}
            </p>

            <div className="flex flex-wrap items-center gap-3 pt-2 border-t border-black/5 dark:border-white/5">
              <button
                type="button"
                onClick={handleOpenMediaDir}
                className="flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-medium text-zinc-700 dark:text-[#cfd3dc] bg-white dark:bg-[#202127] hover:bg-black/5 dark:hover:bg-white/10 border border-black/10 dark:border-white/10 transition-colors cursor-pointer"
              >
                <FolderOpen className="w-4 h-4 text-zinc-500" />
                <span>{t('mediaOpenDir')}</span>
              </button>

              <button
                type="button"
                onClick={handleCleanMedia}
                disabled={!mediaStats || mediaStats.orphanCount === 0 || mediaBusy !== null}
                className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-medium transition-all cursor-pointer ${
                  mediaConfirm
                    ? 'bg-red-500 hover:bg-red-600 text-white shadow-xs'
                    : 'bg-white dark:bg-[#202127] hover:bg-black/5 dark:hover:bg-white/10 text-zinc-700 dark:text-[#cfd3dc] border border-black/10 dark:border-white/10'
                } disabled:opacity-40 disabled:cursor-not-allowed`}
              >
                <Trash2 className="w-4 h-4" />
                <span>
                  {mediaBusy
                    ? t('mediaCleaning')
                    : mediaConfirm
                    ? t('mediaCleanConfirm')
                    : t('mediaCleanUnused')}
                </span>
              </button>

              {mediaMsg && (
                <span
                  className={`text-xs font-medium ${
                    mediaMsg.isError ? 'text-red-500' : 'text-emerald-600 dark:text-emerald-400'
                  }`}
                >
                  {mediaMsg.text}
                </span>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
