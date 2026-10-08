import React, { useState, useEffect, useMemo, useRef } from 'react';
import {
  AppSettings,
  DeepSeekProviderConfig,
  ApiProvider,
  TtfProviderConfig,
  MferenceProviderConfig,
  CustomProviderConfig,
} from '../types/chat';
import {
  DEFAULT_SETTINGS,
  DEFAULT_DEEPSEEK_CONFIG,
  DEFAULT_TTF_CONFIG,
  DEFAULT_MFERENCE_CONFIG,
  DEFAULT_CUSTOM_CONFIG,
} from '../services/storage';
import { resolveLanguage, translations, Language, TranslationKeys } from '../i18n';
import { X, RotateCcw, Check, AppWindow, SlidersHorizontal, Eye, EyeOff, Sparkles, Terminal } from 'lucide-react';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  settings: AppSettings;
  onSave: (settings: AppSettings) => void;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
  isOpen,
  onClose,
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
  // TTF (TurboFieldfare / Gemma 4)
  const [ttfConfig, setTtfConfig] = useState<TtfProviderConfig>(() => ({
    ...DEFAULT_TTF_CONFIG,
    ...(settings?.ttfConfig || settings?.localConfig || {}),
  }));
  const [ttfStopInput, setTtfStopInput] = useState<string>(() =>
    (settings?.ttfConfig?.stopStrings || settings?.localConfig?.stopStrings || settings?.stopStrings || []).join(', ')
  );

  // Mference (Qwen 3.6 35B-A3B)
  const [mferenceConfig, setMferenceConfig] = useState<MferenceProviderConfig>(() => ({
    ...DEFAULT_MFERENCE_CONFIG,
    ...(settings?.mferenceConfig || {}),
  }));
  const [mferenceStopInput, setMferenceStopInput] = useState<string>(() =>
    (settings?.mferenceConfig?.stopStrings || []).join(', ')
  );

  // Custom (自定义 / OpenAI 兼容极简模式)
  const [customConfig, setCustomConfig] = useState<CustomProviderConfig>(() => ({
    ...DEFAULT_CUSTOM_CONFIG,
    ...(settings?.customConfig || {}),
  }));

  // DeepSeek 官方 API
  const [deepseekConfig, setDeepseekConfig] = useState<DeepSeekProviderConfig>(() => ({
    ...DEFAULT_DEEPSEEK_CONFIG,
    ...(settings?.deepseekConfig || {}),
  }));
  const [deepseekStopInput, setDeepseekStopInput] = useState<string>(() =>
    (settings?.deepseekConfig?.stopStrings || []).join(', ')
  );

  const [showApiKey, setShowApiKey] = useState(false);
  const prevIsOpenRef = useRef(false);

  const activeLang: Language = useMemo(() => {
    return resolveLanguage(language);
  }, [language]);

  const t = useMemo(() => {
    return (key: TranslationKeys) => {
      const dict = translations[activeLang] || translations.zh;
      return dict[key] || translations.zh[key] || key;
    };
  }, [activeLang]);

  // 仅在弹窗打开的一瞬间（从 false 变为 true）从外部同步最新设置
  useEffect(() => {
    if (isOpen && !prevIsOpenRef.current) {
      const p = settings?.apiProvider || 'ttf';
      setApiProvider(p === 'local' ? 'ttf' : p);
      setTheme(settings?.theme || 'system');
      setLanguage(settings?.language || 'system');
      setSpotlightResetMinutes(settings?.spotlightResetMinutes ?? 15);

      const tCfg: TtfProviderConfig = {
        ...DEFAULT_TTF_CONFIG,
        ...(settings?.ttfConfig || settings?.localConfig || {}),
      };
      setTtfConfig(tCfg);
      setTtfStopInput((tCfg.stopStrings || []).join(', '));

      const mCfg: MferenceProviderConfig = {
        ...DEFAULT_MFERENCE_CONFIG,
        ...(settings?.mferenceConfig || {}),
      };
      setMferenceConfig(mCfg);
      setMferenceStopInput((mCfg.stopStrings || []).join(', '));

      const cCfg: CustomProviderConfig = {
        ...DEFAULT_CUSTOM_CONFIG,
        ...(settings?.customConfig || {}),
      };
      setCustomConfig(cCfg);

      const storedApiKey = typeof localStorage !== 'undefined' ? localStorage.getItem('tff_deepseek_api_key_v1') || '' : '';
      const resolvedApiKey = (
        settings?.deepseekConfig?.apiKey ||
        settings?.deepseekApiKey ||
        storedApiKey ||
        ''
      ).trim();

      const dsCfg: DeepSeekProviderConfig = {
        ...DEFAULT_DEEPSEEK_CONFIG,
        ...(settings?.deepseekConfig || {}),
        apiKey: resolvedApiKey,
      };
      setDeepseekConfig(dsCfg);
      setDeepseekStopInput((dsCfg.stopStrings || []).join(', '));
    }
    prevIsOpenRef.current = isOpen;
  }, [isOpen, settings]);

  // ---- 各卡片独立的「恢复默认」----
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

  /** 模型卡片恢复默认：严格根据当前激活的提供商进行独立恢复，互不干扰 */
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
        apiKey: prev.apiKey || storedApiKey, // API Key 固定保留，恢复默认时不重置
      }));
      setDeepseekStopInput('');
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
    const storedApiKey = typeof localStorage !== 'undefined' ? localStorage.getItem('tff_deepseek_api_key_v1') || '' : '';
    setTheme(DEFAULT_SETTINGS.theme || 'system');
    setLanguage(DEFAULT_SETTINGS.language || 'system');
    setSpotlightResetMinutes(DEFAULT_SETTINGS.spotlightResetMinutes ?? 15);
    setApiProvider('ttf');
    setTtfConfig({ ...DEFAULT_TTF_CONFIG });
    setTtfStopInput(DEFAULT_TTF_CONFIG.stopStrings.join(', '));
    setMferenceConfig({ ...DEFAULT_MFERENCE_CONFIG });
    setMferenceStopInput((DEFAULT_MFERENCE_CONFIG.stopStrings || []).join(', '));
    setCustomConfig({ ...DEFAULT_CUSTOM_CONFIG });
    setDeepseekConfig((prev) => ({
      ...DEFAULT_DEEPSEEK_CONFIG,
      apiKey: prev.apiKey || storedApiKey,
    }));
    setDeepseekStopInput('');
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
      } catch {
        /* ignore */
      }
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
    const finalDs: DeepSeekProviderConfig = {
      ...deepseekConfig,
      apiKey: cleanApiKey,
      stopStrings: dsStops,
    };

    // 活跃配置投影
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

      // 同步当前活跃提供商的扁平字段
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
                value={theme || 'system'}
                onChange={(e) => setTheme(e.target.value as 'system' | 'light' | 'dark')}
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
                value={language || 'system'}
                onChange={(e) => setLanguage(e.target.value as 'system' | 'zh' | 'en')}
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
              value={spotlightResetMinutes ?? 15}
              onChange={(e) => setSpotlightResetMinutes(Number(e.target.value))}
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

          {/* 模型设置卡片（提供商选择 / 本地独立配置 / DeepSeek独立配置） */}
          <div className="p-3.5 rounded-xl border border-black/10 dark:border-[#343740] bg-[#f8f9fb] dark:bg-[#18191c]">
            <div className="flex items-center gap-2 mb-3">
              <SlidersHorizontal className="w-4 h-4 text-amber-600 dark:text-amber-400" />
              <span className="font-semibold text-xs text-[#1f2328] dark:text-[#f1f3f7]">
                {t('settingsModelCard')}
              </span>
            </div>

            {/* Provider Switcher: 4 大独立模型接入模块 */}
            <div className="mb-3.5">
              <label className="block font-medium mb-1.5 text-zinc-600 dark:text-[#9aa0ac]">
                {t('apiProviderLabel')}
              </label>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setApiProvider('ttf')}
                  className={`flex items-center justify-center gap-2 py-2 px-3 rounded-lg border text-xs font-medium transition-all ${
                    apiProvider === 'ttf' || apiProvider === 'local'
                      ? 'bg-amber-500/10 border-amber-500/40 text-amber-700 dark:text-amber-400 font-semibold shadow-sm'
                      : 'bg-[#f6f8fa] dark:bg-[#18191c] border-black/10 dark:border-[#343740] text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-white'
                  }`}
                >
                  <SlidersHorizontal className="w-3.5 h-3.5" />
                  <span>{t('providerTTFShort')}</span>
                </button>
                <button
                  type="button"
                  onClick={() => setApiProvider('mference')}
                  className={`flex items-center justify-center gap-2 py-2 px-3 rounded-lg border text-xs font-medium transition-all ${
                    apiProvider === 'mference'
                      ? 'bg-amber-500/10 border-amber-500/40 text-amber-700 dark:text-amber-400 font-semibold shadow-sm'
                      : 'bg-[#f6f8fa] dark:bg-[#18191c] border-black/10 dark:border-[#343740] text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-white'
                  }`}
                >
                  <SlidersHorizontal className="w-3.5 h-3.5" />
                  <span>{t('providerMferenceShort')}</span>
                </button>
                <button
                  type="button"
                  onClick={() => setApiProvider('custom')}
                  className={`flex items-center justify-center gap-2 py-2 px-3 rounded-lg border text-xs font-medium transition-all ${
                    apiProvider === 'custom'
                      ? 'bg-emerald-500/10 border-emerald-500/40 text-emerald-700 dark:text-emerald-400 font-semibold shadow-sm'
                      : 'bg-[#f6f8fa] dark:bg-[#18191c] border-black/10 dark:border-[#343740] text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-white'
                  }`}
                >
                  <Terminal className="w-3.5 h-3.5" />
                  <span>{t('providerCustomShort')}</span>
                </button>
                <button
                  type="button"
                  onClick={() => setApiProvider('deepseek')}
                  className={`flex items-center justify-center gap-2 py-2 px-3 rounded-lg border text-xs font-medium transition-all ${
                    apiProvider === 'deepseek'
                      ? 'bg-blue-500/10 border-blue-500/40 text-blue-700 dark:text-blue-400 font-semibold shadow-sm'
                      : 'bg-[#f6f8fa] dark:bg-[#18191c] border-black/10 dark:border-[#343740] text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-white'
                  }`}
                >
                  <Sparkles className="w-3.5 h-3.5" />
                  <span>{t('providerDeepSeekShort')}</span>
                </button>
              </div>
            </div>

            {/* DeepSeek Specific Settings */}
            {apiProvider === 'deepseek' ? (
              <div className="space-y-3 pt-1">
                {/* DeepSeek Notice Banner */}
                <div className="p-2.5 rounded-lg bg-blue-500/10 border border-blue-500/20 text-blue-800 dark:text-blue-300 text-[11px] leading-relaxed flex items-start gap-2">
                  <Sparkles className="w-4 h-4 flex-shrink-0 mt-0.5 text-blue-600 dark:text-blue-400" />
                  <span>{t('deepseekNotice')}</span>
                </div>

                {/* API Key */}
                <div>
                  <div className="flex items-center justify-between mb-1">
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
                      className="w-full bg-[#f6f8fa] dark:bg-[#18191c] border border-black/10 dark:border-[#343740] rounded-lg pl-3 pr-10 py-2 text-[#1f2328] dark:text-[#e2e5eb] focus:border-blue-500 focus:outline-none font-mono"
                    />
                    <button
                      type="button"
                      onClick={() => setShowApiKey(!showApiKey)}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 p-1"
                    >
                      {showApiKey ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                    </button>
                  </div>
                  <span className="text-[10px] text-zinc-500 dark:text-[#6f7582] mt-1 block">
                    {t('deepseekApiKeyTip')}
                  </span>
                </div>

                {/* Model ID & Max Context */}
                <div className="grid grid-cols-2 gap-3">
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
                        if (val !== 'custom') {
                          setDeepseekConfig({ ...deepseekConfig, modelId: val });
                        }
                      }}
                      className="w-full bg-[#f6f8fa] dark:bg-[#18191c] border border-black/10 dark:border-[#343740] rounded-lg px-3 py-2 text-[#1f2328] dark:text-[#e2e5eb] focus:border-blue-500 focus:outline-none"
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
                        className="w-full mt-2 bg-[#f6f8fa] dark:bg-[#18191c] border border-black/10 dark:border-[#343740] rounded-lg px-3 py-2 text-[#1f2328] dark:text-[#e2e5eb] focus:border-blue-500 focus:outline-none font-mono"
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
                        setDeepseekConfig({
                          ...deepseekConfig,
                          maxContext: val,
                        });
                      }}
                      className="w-full bg-[#f6f8fa] dark:bg-[#18191c] border border-black/10 dark:border-[#343740] rounded-lg px-3 py-2 text-[#1f2328] dark:text-[#e2e5eb] focus:border-blue-500 focus:outline-none"
                    >
                      <option value={32768}>32,768 (32K)</option>
                      <option value={65536}>65,536 (64K)</option>
                      <option value={131072}>131,072 (128K - 推荐)</option>
                      <option value={262144}>262,144 (256K)</option>
                      <option value={1000000}>1,000,000 (1M)</option>
                    </select>
                  </div>
                </div>

                {/* API Base URL */}
                <div>
                  <label className="block font-medium mb-1 text-zinc-600 dark:text-[#9aa0ac]">
                    {t('deepseekBaseUrlLabel')}
                  </label>
                  <input
                    type="text"
                    value={deepseekConfig.baseUrl ?? 'https://api.deepseek.com'}
                    onChange={(e) => setDeepseekConfig({ ...deepseekConfig, baseUrl: e.target.value })}
                    placeholder="https://api.deepseek.com"
                    className="w-full bg-[#f6f8fa] dark:bg-[#18191c] border border-black/10 dark:border-[#343740] rounded-lg px-3 py-2 text-[#1f2328] dark:text-[#e2e5eb] focus:border-blue-500 focus:outline-none font-mono"
                  />
                  <span className="text-[10px] text-zinc-500 dark:text-[#6f7582] mt-1 block">
                    {t('deepseekBaseUrlTip')}
                  </span>
                </div>

                {/* Reasoning Effort (深度思考参数) */}
                <div>
                  <label className="block font-medium mb-1 text-zinc-600 dark:text-[#9aa0ac]">
                    {t('reasoningEffortLabel')}
                  </label>
                  <select
                    value={deepseekConfig.reasoningEffort || 'high'}
                    onChange={(e) =>
                      setDeepseekConfig({
                        ...deepseekConfig,
                        reasoningEffort: e.target.value as any,
                      })
                    }
                    className="w-full bg-[#f6f8fa] dark:bg-[#18191c] border border-black/10 dark:border-[#343740] rounded-lg px-3 py-2 text-[#1f2328] dark:text-[#e2e5eb] focus:border-blue-500 focus:outline-none"
                  >
                    <option value="high">{t('reasoningEffortHigh')}</option>
                    <option value="low">{t('reasoningEffortLow')}</option>
                    <option value="max">{t('reasoningEffortMax')}</option>
                  </select>
                </div>

                {/* DeepSeek 采样参数: Temperature & Top-P */}
                <div className="grid grid-cols-2 gap-3 pt-1">
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
                    <span className="text-[10px] text-zinc-500 dark:text-[#6f7582] leading-tight block">
                      {t('deepseekTemperatureTip')}
                    </span>
                  </div>

                  <div>
                    <div className="flex justify-between font-medium mb-1 text-zinc-600 dark:text-[#9aa0ac]">
                      <span>{t('topPLabel')}</span>
                      <span className="font-mono text-blue-500 dark:text-blue-400">{deepseekConfig.topP ?? 1.0}</span>
                    </div>
                    <input
                      type="range"
                      min="0.01"
                      max="1.0"
                      step="0.01"
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
                <div className="grid grid-cols-2 gap-3 pt-1">
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label className="font-medium text-zinc-600 dark:text-[#9aa0ac]">
                        {t('maxTokensLabel')}
                      </label>
                      <span className="text-[10px] text-blue-600 dark:text-blue-400 font-medium bg-blue-500/10 px-1.5 py-0.5 rounded">
                        {t('deepseekMaxTokensLinked')}
                      </span>
                    </div>
                    <input
                      type="text"
                      readOnly
                      value={`${deepseekConfig.maxTokens || 8192} tokens (8K)`}
                      className="w-full bg-zinc-100 dark:bg-[#151619] border border-black/10 dark:border-[#2d3038] rounded-lg px-3 py-2 text-zinc-600 dark:text-[#abb0bc] cursor-not-allowed font-mono select-none"
                    />
                    <span className="text-[10px] text-zinc-500 dark:text-[#6f7582] mt-1 block">
                      {t('maxTokensTip')}
                    </span>
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
                      className="w-full bg-[#f6f8fa] dark:bg-[#18191c] border border-black/10 dark:border-[#343740] rounded-lg px-3 py-2 text-[#1f2328] dark:text-[#e2e5eb] focus:border-blue-500 focus:outline-none font-mono"
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
                    className="w-full bg-[#f6f8fa] dark:bg-[#18191c] border border-black/10 dark:border-[#343740] rounded-lg px-3 py-2 text-[#1f2328] dark:text-[#e2e5eb] focus:border-blue-500 focus:outline-none font-mono"
                  />
                </div>

                {/* DeepSeek System Prompt */}
                <div>
                  <label className="block font-medium mb-1 text-zinc-600 dark:text-[#9aa0ac]">
                    {t('systemPromptLabel')}
                  </label>
                  <textarea
                    rows={3}
                    value={deepseekConfig.systemPrompt ?? ''}
                    onChange={(e) => setDeepseekConfig({ ...deepseekConfig, systemPrompt: e.target.value })}
                    placeholder={t('systemPromptPlaceholderDeepSeek')}
                    className="w-full bg-[#f6f8fa] dark:bg-[#18191c] border border-black/10 dark:border-[#343740] rounded-lg px-3 py-2 text-[#1f2328] dark:text-[#e2e5eb] focus:border-blue-500 focus:outline-none resize-none leading-relaxed"
                  />
                  <span className="text-[10px] text-zinc-500 dark:text-[#6f7582] mt-1 block">
                    {t('deepseekSystemPromptTip')}
                  </span>
                </div>

                {cardResetButton(handleModelCardReset)}
              </div>
            ) : apiProvider === 'mference' ? (
              /* Mference (Qwen 3.6 35B-A3B) 专属设置 */
              <div className="space-y-3 pt-1">
                {/* Notice Banner */}
                <div className="p-2.5 rounded-lg bg-amber-500/10 border border-amber-500/20 text-amber-800 dark:text-amber-300 text-[11px] leading-relaxed flex items-start gap-2">
                  <SlidersHorizontal className="w-4 h-4 flex-shrink-0 mt-0.5 text-amber-600 dark:text-amber-400" />
                  <span>{t('mferenceServiceAutoStartDesc')}</span>
                </div>

                {/* Service Port & Base URL */}
                <div className="grid grid-cols-2 gap-3">
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
                      className="w-full bg-[#f6f8fa] dark:bg-[#18191c] border border-black/10 dark:border-[#343740] rounded-lg px-3 py-2 text-[#1f2328] dark:text-[#e2e5eb] focus:border-amber-500 focus:outline-none font-mono"
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
                      className="w-full bg-[#f6f8fa] dark:bg-[#18191c] border border-black/10 dark:border-[#343740] rounded-lg px-3 py-2 text-[#1f2328] dark:text-[#e2e5eb] focus:border-amber-500 focus:outline-none font-mono text-[11px]"
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
                      value={mferenceConfig.modelId ?? 'qwen3.6-35b-a3b'}
                      onChange={(e) => setMferenceConfig({ ...mferenceConfig, modelId: e.target.value })}
                      className="w-full bg-[#f6f8fa] dark:bg-[#18191c] border border-black/10 dark:border-[#343740] rounded-lg px-3 py-2 text-[#1f2328] dark:text-[#e2e5eb] focus:border-amber-500 focus:outline-none font-mono"
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
                        setMferenceConfig({
                          ...mferenceConfig,
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
                      <option value={128000}>128,000 (128K)</option>
                    </select>
                  </div>
                </div>

                {/* Reasoning Effort (深度思考推理深度) */}
                <div>
                  <label className="block font-medium mb-1 text-zinc-600 dark:text-[#9aa0ac]">
                    {t('reasoningEffortLabel')}
                  </label>
                  <select
                    value={mferenceConfig.reasoningEffort ?? 'low'}
                    onChange={(e) => setMferenceConfig({ ...mferenceConfig, reasoningEffort: e.target.value as any })}
                    className="w-full bg-[#f6f8fa] dark:bg-[#18191c] border border-black/10 dark:border-[#343740] rounded-lg px-3 py-2 text-[#1f2328] dark:text-[#e2e5eb] focus:border-amber-500 focus:outline-none"
                  >
                    <option value="low">{t('reasoningEffortLow')}</option>
                    <option value="medium">{t('reasoningEffortMed')}</option>
                    <option value="high">{t('reasoningEffortHigh')}</option>
                    <option value="none">{t('reasoningEffortNone')}</option>
                  </select>
                </div>

                {/* Sampling Parameters: Temperature & Top-P */}
                <div className="grid grid-cols-2 gap-3 pt-1">
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
                <div className="grid grid-cols-2 gap-3 pt-1">
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
                <div className="grid grid-cols-2 gap-3 pt-1">
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

                {/* Max Completion Tokens & Seed */}
                <div className="grid grid-cols-2 gap-3 pt-1">
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
                      value={mferenceConfig.seed ?? ''}
                      onChange={(e) =>
                        setMferenceConfig({
                          ...mferenceConfig,
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
                    value={mferenceStopInput}
                    onChange={(e) => setMferenceStopInput(e.target.value)}
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
                    value={mferenceConfig.systemPrompt ?? ''}
                    onChange={(e) => setMferenceConfig({ ...mferenceConfig, systemPrompt: e.target.value })}
                    placeholder={t('systemPromptPlaceholderMference')}
                    className="w-full bg-[#f6f8fa] dark:bg-[#18191c] border border-black/10 dark:border-[#343740] rounded-lg px-3 py-2 text-[#1f2328] dark:text-[#e2e5eb] focus:border-amber-500 focus:outline-none resize-none leading-relaxed"
                  />
                  <span className="text-[10px] text-zinc-500 dark:text-[#6f7582] mt-1 block">
                    {t('mferenceSystemPromptTip')}
                  </span>
                </div>

                {cardResetButton(handleModelCardReset)}
              </div>
            ) : apiProvider === 'custom' ? (
              /* 自定义 (Custom / OpenAI 兼容极简模式) */
              <div className="space-y-3 pt-1">
                {/* Notice Banner */}
                <div className="p-2.5 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-800 dark:text-emerald-300 text-[11px] leading-relaxed flex items-start gap-2">
                  <Terminal className="w-4 h-4 flex-shrink-0 mt-0.5 text-emerald-600 dark:text-emerald-400" />
                  <span>{t('customNotice')}</span>
                </div>

                {/* Service Port Selection */}
                <div className="grid grid-cols-2 gap-3">
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
                      className="w-full bg-[#f6f8fa] dark:bg-[#18191c] border border-black/10 dark:border-[#343740] rounded-lg px-3 py-2 text-[#1f2328] dark:text-[#e2e5eb] focus:border-emerald-500 focus:outline-none"
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
                      className="w-full bg-[#f6f8fa] dark:bg-[#18191c] border border-black/10 dark:border-[#343740] rounded-lg px-3 py-2 text-[#1f2328] dark:text-[#e2e5eb] focus:border-emerald-500 focus:outline-none font-mono"
                    />
                  </div>
                </div>

                {/* Base URL (Optional) */}
                <div>
                  <label className="block font-medium mb-1 text-zinc-600 dark:text-[#9aa0ac]">
                    {t('customBaseUrlLabel')}
                  </label>
                  <input
                    type="text"
                    value={customConfig.apiBaseUrl ?? ''}
                    onChange={(e) => setCustomConfig({ ...customConfig, apiBaseUrl: e.target.value })}
                    placeholder={t('customBaseUrlPlaceholder')}
                    className="w-full bg-[#f6f8fa] dark:bg-[#18191c] border border-black/10 dark:border-[#343740] rounded-lg px-3 py-2 text-[#1f2328] dark:text-[#e2e5eb] focus:border-emerald-500 focus:outline-none font-mono text-[11px]"
                  />
                </div>

                {/* Model ID & Max Context */}
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block font-medium mb-1 text-zinc-600 dark:text-[#9aa0ac]">
                      {t('customModelLabel')}
                    </label>
                    <input
                      type="text"
                      value={customConfig.modelId ?? 'llama3'}
                      onChange={(e) => setCustomConfig({ ...customConfig, modelId: e.target.value })}
                      placeholder={t('customModelPlaceholder')}
                      className="w-full bg-[#f6f8fa] dark:bg-[#18191c] border border-black/10 dark:border-[#343740] rounded-lg px-3 py-2 text-[#1f2328] dark:text-[#e2e5eb] focus:border-emerald-500 focus:outline-none font-mono"
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
                      className="w-full bg-[#f6f8fa] dark:bg-[#18191c] border border-black/10 dark:border-[#343740] rounded-lg px-3 py-2 text-[#1f2328] dark:text-[#e2e5eb] focus:border-emerald-500 focus:outline-none"
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

                {/* Max Tokens & Temperature (最基础参数) */}
                <div className="grid grid-cols-2 gap-3 pt-1">
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
                      className="w-full bg-[#f6f8fa] dark:bg-[#18191c] border border-black/10 dark:border-[#343740] rounded-lg px-3 py-2 text-[#1f2328] dark:text-[#e2e5eb] focus:border-emerald-500 focus:outline-none font-mono"
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

                {/* System Prompt */}
                <div>
                  <label className="block font-medium mb-1 text-zinc-600 dark:text-[#9aa0ac]">
                    {t('systemPromptLabel')}
                  </label>
                  <textarea
                    rows={3}
                    value={customConfig.systemPrompt ?? ''}
                    onChange={(e) => setCustomConfig({ ...customConfig, systemPrompt: e.target.value })}
                    placeholder={t('systemPromptPlaceholderLocal')}
                    className="w-full bg-[#f6f8fa] dark:bg-[#18191c] border border-black/10 dark:border-[#343740] rounded-lg px-3 py-2 text-[#1f2328] dark:text-[#e2e5eb] focus:border-emerald-500 focus:outline-none resize-none leading-relaxed"
                  />
                </div>

                {cardResetButton(handleModelCardReset)}
              </div>
            ) : (
              /* TTF (TurboFieldfare / Gemma 4) 专属设置 */
              <div className="space-y-3 pt-1">
                {/* Notice Banner */}
                <div className="p-2.5 rounded-lg bg-amber-500/10 border border-amber-500/20 text-amber-800 dark:text-amber-300 text-[11px] leading-relaxed flex items-start gap-2">
                  <SlidersHorizontal className="w-4 h-4 flex-shrink-0 mt-0.5 text-amber-600 dark:text-amber-400" />
                  <span>{t('ttfServiceAutoStartDesc')}</span>
                </div>

                {/* Service Port & Base URL */}
                <div className="grid grid-cols-2 gap-3">
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
                      className="w-full bg-[#f6f8fa] dark:bg-[#18191c] border border-black/10 dark:border-[#343740] rounded-lg px-3 py-2 text-[#1f2328] dark:text-[#e2e5eb] focus:border-amber-500 focus:outline-none font-mono"
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
                      className="w-full bg-[#f6f8fa] dark:bg-[#18191c] border border-black/10 dark:border-[#343740] rounded-lg px-3 py-2 text-[#1f2328] dark:text-[#e2e5eb] focus:border-amber-500 focus:outline-none font-mono text-[11px]"
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
                      value={ttfConfig.modelId ?? 'gemma-4-26b-a4b-it'}
                      onChange={(e) => setTtfConfig({ ...ttfConfig, modelId: e.target.value })}
                      className="w-full bg-[#f6f8fa] dark:bg-[#18191c] border border-black/10 dark:border-[#343740] rounded-lg px-3 py-2 text-[#1f2328] dark:text-[#e2e5eb] focus:border-amber-500 focus:outline-none font-mono"
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
                        setTtfConfig({
                          ...ttfConfig,
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

                {/* Local Sampling Parameters: Temperature & Top-P */}
                <div className="grid grid-cols-2 gap-3 pt-1">
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
                <div className="grid grid-cols-2 gap-3 pt-1">
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

                {/* Max Completion Tokens & Seed */}
                <div className="grid grid-cols-2 gap-3 pt-1">
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
                      value={ttfConfig.seed ?? ''}
                      onChange={(e) =>
                        setTtfConfig({
                          ...ttfConfig,
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
                    value={ttfStopInput}
                    onChange={(e) => setTtfStopInput(e.target.value)}
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
                    value={ttfConfig.systemPrompt ?? ''}
                    onChange={(e) => setTtfConfig({ ...ttfConfig, systemPrompt: e.target.value })}
                    placeholder={t('systemPromptPlaceholderLocal')}
                    className="w-full bg-[#f6f8fa] dark:bg-[#18191c] border border-black/10 dark:border-[#343740] rounded-lg px-3 py-2 text-[#1f2328] dark:text-[#e2e5eb] focus:border-amber-500 focus:outline-none resize-none leading-relaxed"
                  />
                </div>

                {cardResetButton(handleModelCardReset)}
              </div>
            )}
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
