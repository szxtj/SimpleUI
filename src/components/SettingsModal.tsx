import React, { useState, useEffect } from 'react';
import { AppSettings } from '../types/chat';
import { DEFAULT_SETTINGS } from '../services/storage';
import { useI18n } from '../i18n';
import { X, RotateCcw, Check } from 'lucide-react';

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
  const { t } = useI18n();
  const getSafeSettings = (s?: AppSettings): AppSettings => ({
    ...DEFAULT_SETTINGS,
    ...(s || {}),
    stopStrings: Array.isArray(s?.stopStrings) ? s.stopStrings : [],
  });

  const [formData, setFormData] = useState<AppSettings>(() => getSafeSettings(settings));
  const [stopInput, setStopInput] = useState<string>(() =>
    (settings?.stopStrings || []).join(', ')
  );

  // Sync state whenever modal is opened
  useEffect(() => {
    if (isOpen) {
      const safe = getSafeSettings(settings);
      setFormData(safe);
      setStopInput((safe.stopStrings || []).join(', '));
    }
  }, [isOpen, settings]);

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
      onClick={onClose}
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
                className="w-full bg-[#f6f8fa] dark:bg-[#18191c] border border-black/10 dark:border-[#343740] rounded-lg px-3 py-2 text-[#1f2328] dark:text-[#e2e5eb] focus:border-blue-500 focus:outline-none"
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
                className="w-full bg-[#f6f8fa] dark:bg-[#18191c] border border-black/10 dark:border-[#343740] rounded-lg px-3 py-2 text-[#1f2328] dark:text-[#e2e5eb] focus:border-blue-500 focus:outline-none font-mono"
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
                className="w-full bg-[#f6f8fa] dark:bg-[#18191c] border border-black/10 dark:border-[#343740] rounded-lg px-3 py-2 text-[#1f2328] dark:text-[#e2e5eb] focus:border-blue-500 focus:outline-none font-mono"
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
                className="w-full bg-[#f6f8fa] dark:bg-[#18191c] border border-black/10 dark:border-[#343740] rounded-lg px-3 py-2 text-[#1f2328] dark:text-[#e2e5eb] focus:border-blue-500 focus:outline-none"
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
                <span className="font-mono text-blue-500 dark:text-blue-400">{formData.temperature ?? 1.0}</span>
              </div>
              <input
                type="range"
                min="0"
                max="2"
                step="0.05"
                value={formData.temperature ?? 1.0}
                onChange={(e) => setFormData({ ...formData, temperature: Number(e.target.value) })}
                className="w-full accent-blue-500"
              />
              <span className="text-[10px] text-zinc-500 dark:text-[#6f7582]">{t('temperatureTip')}</span>
            </div>

            <div>
              <div className="flex justify-between font-medium mb-1 text-zinc-600 dark:text-[#9aa0ac]">
                <span>{t('topPLabel')}</span>
                <span className="font-mono text-blue-500 dark:text-blue-400">{formData.topP ?? 0.95}</span>
              </div>
              <input
                type="range"
                min="0.01"
                max="1.0"
                step="0.01"
                value={formData.topP ?? 0.95}
                onChange={(e) => setFormData({ ...formData, topP: Number(e.target.value) })}
                className="w-full accent-blue-500"
              />
              <span className="text-[10px] text-zinc-500 dark:text-[#6f7582]">{t('topPTip')}</span>
            </div>
          </div>

          {/* Top-K & Repetition Penalty */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className="flex justify-between font-medium mb-1 text-zinc-600 dark:text-[#9aa0ac]">
                <span>{t('topKLabel')}</span>
                <span className="font-mono text-blue-500 dark:text-blue-400">{formData.topK ?? 64}</span>
              </div>
              <input
                type="range"
                min="1"
                max="256"
                step="1"
                value={formData.topK ?? 64}
                onChange={(e) => setFormData({ ...formData, topK: Number(e.target.value) })}
                className="w-full accent-blue-500"
              />
              <span className="text-[10px] text-zinc-500 dark:text-[#6f7582]">{t('topKTip')}</span>
            </div>

            <div>
              <div className="flex justify-between font-medium mb-1 text-zinc-600 dark:text-[#9aa0ac]">
                <span>{t('repetitionPenaltyLabel')}</span>
                <span className="font-mono text-blue-500 dark:text-blue-400">{formData.repetitionPenalty ?? 1.0}</span>
              </div>
              <input
                type="range"
                min="0.5"
                max="2.0"
                step="0.05"
                value={formData.repetitionPenalty ?? 1.0}
                onChange={(e) => setFormData({ ...formData, repetitionPenalty: Number(e.target.value) })}
                className="w-full accent-blue-500"
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
                <span className="text-[10px] text-blue-600 dark:text-blue-400 font-medium bg-blue-500/10 px-1.5 py-0.5 rounded">
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
                className="w-full bg-[#f6f8fa] dark:bg-[#18191c] border border-black/10 dark:border-[#343740] rounded-lg px-3 py-2 text-[#1f2328] dark:text-[#e2e5eb] focus:border-blue-500 focus:outline-none font-mono"
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
              className="w-full bg-[#f6f8fa] dark:bg-[#18191c] border border-black/10 dark:border-[#343740] rounded-lg px-3 py-2 text-[#1f2328] dark:text-[#e2e5eb] focus:border-blue-500 focus:outline-none font-mono"
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
              className="w-full bg-[#f6f8fa] dark:bg-[#18191c] border border-black/10 dark:border-[#343740] rounded-lg px-3 py-2 text-[#1f2328] dark:text-[#e2e5eb] focus:border-blue-500 focus:outline-none resize-none leading-relaxed"
            />
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
