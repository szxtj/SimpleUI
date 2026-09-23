import React, { useState, useEffect } from 'react';
import { AppSettings } from '../types/chat';
import { DEFAULT_SETTINGS } from '../services/storage';
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
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 select-none"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="relative w-full max-w-lg rounded-2xl bg-[#202227] border border-[#353842] shadow-2xl overflow-hidden flex flex-col max-h-[90vh]"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-[#2d3038]">
          <h2 className="text-sm font-semibold text-[#f1f3f7]">
            SimpleUI 本地服务与生成参数设置
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded-lg text-[#888e9b] hover:text-white hover:bg-[#2d3038] transition-colors cursor-pointer"
            title="关闭设置 (Esc)"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Form Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-4 text-xs text-[#cfd3dc]">
          {/* Local Service Port Selection */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block font-medium mb-1 text-[#9aa0ac]">
                本地推理服务端口 (OpenAI 兼容)
              </label>
              <select
                value={[1235, 11434, 8000, 8080, 1234, 5000].includes(formData.apiPort) ? formData.apiPort : 'custom'}
                onChange={(e) => {
                  const val = e.target.value;
                  if (val !== 'custom') {
                    setFormData({ ...formData, apiPort: Number(val) });
                  }
                }}
                className="w-full bg-[#18191c] border border-[#343740] rounded-lg px-3 py-2 text-[#e2e5eb] focus:border-blue-500 focus:outline-none"
              >
                <option value={1235}>1235 (TurboFieldfare 默认)</option>
                <option value={11434}>11434 (Ollama)</option>
                <option value={8000}>8000 (vLLM)</option>
                <option value={8080}>8080 (llama.cpp server)</option>
                <option value={1234}>1234 (LM Studio)</option>
                <option value={5000}>5000 (TextGen WebUI)</option>
                <option value="custom">自定义端口...</option>
              </select>
            </div>

            <div>
              <label className="block font-medium mb-1 text-[#9aa0ac]">
                端口数值 (http://127.0.0.1:端口)
              </label>
              <input
                type="number"
                min="1"
                max="65535"
                value={formData.apiPort ?? 1235}
                onChange={(e) => setFormData({ ...formData, apiPort: Number(e.target.value) || 1235 })}
                placeholder="1235"
                className="w-full bg-[#18191c] border border-[#343740] rounded-lg px-3 py-2 text-[#e2e5eb] focus:border-blue-500 focus:outline-none font-mono"
              />
            </div>
          </div>

          {/* Model ID & Max Context */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block font-medium mb-1 text-[#9aa0ac]">
                模型标识符 (model)
              </label>
              <input
                type="text"
                value={formData.modelId ?? 'gemma-4-26b-a4b-it'}
                onChange={(e) => setFormData({ ...formData, modelId: e.target.value })}
                className="w-full bg-[#18191c] border border-[#343740] rounded-lg px-3 py-2 text-[#e2e5eb] focus:border-blue-500 focus:outline-none font-mono"
              />
            </div>

            <div>
              <label className="block font-medium mb-1 text-[#9aa0ac]">
                上下文窗口 (tokens)
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
                className="w-full bg-[#18191c] border border-[#343740] rounded-lg px-3 py-2 text-[#e2e5eb] focus:border-blue-500 focus:outline-none"
              >
                <option value={8192}>8,192 (8K)</option>
                <option value={16384}>16,384 (16K 默认)</option>
                <option value={32768}>32,768 (32K)</option>
                <option value={65536}>65,536 (64K)</option>
                <option value={131072}>131,072 (128K)</option>
                <option value={262144}>262,144 (256K 极限)</option>
              </select>
            </div>
          </div>

          {/* Temperature & Top-P */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className="flex justify-between font-medium mb-1 text-[#9aa0ac]">
                <span>Temperature (采样温度)</span>
                <span className="font-mono text-blue-400">{formData.temperature ?? 1.0}</span>
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
              <span className="text-[10px] text-[#6f7582]">Gemma 4 官方基准 1.0，越低越严谨</span>
            </div>

            <div>
              <div className="flex justify-between font-medium mb-1 text-[#9aa0ac]">
                <span>Top-P (核采样)</span>
                <span className="font-mono text-blue-400">{formData.topP ?? 0.95}</span>
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
              <span className="text-[10px] text-[#6f7582]">候选词累积概率阀值 (默认 0.95)</span>
            </div>
          </div>

          {/* Top-K & Repetition Penalty */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className="flex justify-between font-medium mb-1 text-[#9aa0ac]">
                <span>Top-K (采样窗口)</span>
                <span className="font-mono text-blue-400">{formData.topK ?? 64}</span>
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
              <span className="text-[10px] text-[#6f7582]">限制前 K 个概率最大词 (1-256)</span>
            </div>

            <div>
              <div className="flex justify-between font-medium mb-1 text-[#9aa0ac]">
                <span>重复惩罚 (Repetition Penalty)</span>
                <span className="font-mono text-blue-400">{formData.repetitionPenalty ?? 1.0}</span>
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
              <span className="text-[10px] text-[#6f7582]">抑制文字重复循环 (默认 1.0)</span>
            </div>
          </div>

          {/* Max Completion Tokens & Seed */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="font-medium text-[#9aa0ac]">
                  单次最大生成长度 (max_tokens)
                </label>
                <span className="text-[10px] text-blue-400 font-medium bg-blue-500/10 px-1.5 py-0.5 rounded">
                  自动联动 50%
                </span>
              </div>
              <input
                type="text"
                readOnly
                value={`${formData.maxTokens || Math.floor((formData.maxContext || 16384) / 2)} tokens (${Math.round((formData.maxTokens || Math.floor((formData.maxContext || 16384) / 2)) / 1024)}K)`}
                className="w-full bg-[#151619] border border-[#2d3038] rounded-lg px-3 py-2 text-[#abb0bc] cursor-not-allowed font-mono select-none"
              />
              <span className="text-[10px] text-[#6f7582] mt-1 block">自动固定为上下文窗口的一半，保障推理与正文充足空间</span>
            </div>

            <div>
              <label className="block font-medium mb-1 text-[#9aa0ac]">
                随机种子 (seed，可选固定输出)
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
                placeholder="留空表示随机"
                className="w-full bg-[#18191c] border border-[#343740] rounded-lg px-3 py-2 text-[#e2e5eb] focus:border-blue-500 focus:outline-none font-mono"
              />
            </div>
          </div>

          {/* Stop Sequences */}
          <div>
            <label className="block font-medium mb-1 text-[#9aa0ac]">
              自定义停止序列 (英文逗号分隔)
            </label>
            <input
              type="text"
              value={stopInput}
              onChange={(e) => setStopInput(e.target.value)}
              placeholder="例如: <end_of_turn>, User:"
              className="w-full bg-[#18191c] border border-[#343740] rounded-lg px-3 py-2 text-[#e2e5eb] focus:border-blue-500 focus:outline-none font-mono"
            />
          </div>

          {/* System Prompt */}
          <div>
            <label className="block font-medium mb-1 text-[#9aa0ac]">
              系统提示词 (System Prompt)
            </label>
            <textarea
              rows={3}
              value={formData.systemPrompt ?? ''}
              onChange={(e) => setFormData({ ...formData, systemPrompt: e.target.value })}
              className="w-full bg-[#18191c] border border-[#343740] rounded-lg px-3 py-2 text-[#e2e5eb] focus:border-blue-500 focus:outline-none resize-none leading-relaxed"
            />
          </div>
        </div>

        {/* Footer actions */}
        <div className="flex items-center justify-between px-5 py-3 border-t border-[#2d3038] bg-[#1a1b1e]">
          <button
            type="button"
            onClick={handleReset}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs text-[#8c929f] hover:text-white hover:bg-[#2b2d35] transition-colors"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>恢复官方默认</span>
          </button>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3.5 py-1.5 rounded-lg text-xs text-[#a2a8b5] hover:bg-[#2b2d35] transition-colors"
            >
              取消
            </button>
            <button
              type="button"
              onClick={handleSave}
              className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-xs bg-blue-600 hover:bg-blue-500 text-white font-medium shadow transition-colors"
            >
              <Check className="w-3.5 h-3.5" />
              <span>保存配置</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
