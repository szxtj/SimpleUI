import React, { useState, useEffect, useCallback } from 'react';
import { AppSettings } from '../../types/chat';
import { useI18n } from '../../i18n';
import { SettingsTabId } from './types';
import {
  deriveServiceState,
  SERVICE_STATE_CARD_DOT_CLASS,
  ServiceState,
} from '../../utils/serviceState';
import {
  WikiAPI,
  ModelServiceAPI,
  ASRServiceAPI,
  TtsServiceAPI,
  SubtitleServiceAPI,
  TranslateServiceAPI,
  OcrServiceAPI,
} from '../../services/api';
import { AppSettingsPanel } from './AppSettingsPanel';
import { ServicesPanel } from './ServicesPanel';
import { X } from 'lucide-react';

interface UnifiedSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  settings: AppSettings;
  onSave: (settings: AppSettings) => void;
  onApiPortChange?: (port: number) => void;
  initialTab?: SettingsTabId;
}

export const UnifiedSettingsModal: React.FC<UnifiedSettingsModalProps> = ({
  isOpen,
  onClose,
  settings,
  onSave,
  onApiPortChange,
  initialTab = 'general',
}) => {
  const { t } = useI18n();
  const [activeTab, setActiveTab] = useState<SettingsTabId>(initialTab);

  // Sync initial tab if passed or changed
  useEffect(() => {
    if (isOpen) {
      if (typeof window !== 'undefined') {
        if (window.location.search.includes('panel=services')) {
          setActiveTab('svc-model');
        } else if (window.location.search.includes('only=translate')) {
          setActiveTab('svc-translate');
        } else if (initialTab) {
          setActiveTab(initialTab);
        }
      }
    }
  }, [isOpen, initialTab]);

  // Tell native macOS dragView to yield clicks when modal is open
  useEffect(() => {
    try {
      const w = window as any;
      w.webkit?.messageHandlers?.setModalOpen?.postMessage?.(isOpen);
    } catch {}
  }, [isOpen]);

  // Close on Escape key
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  // Live service states for sidebar dots
  const [kbDot, setKbDot] = useState<'online' | 'offline' | 'starting' | 'standby'>('offline');
  const [modelDot, setModelDot] = useState<'online' | 'offline' | 'starting' | 'standby'>('offline');
  const [asrDot, setAsrDot] = useState<'online' | 'offline' | 'starting' | 'standby'>('offline');
  const [ttsDot, setTtsDot] = useState<'online' | 'offline' | 'starting' | 'standby'>('offline');
  const [subtitlesDot, setSubtitlesDot] = useState<'online' | 'offline' | 'starting' | 'standby'>('offline');
  const [translateDot, setTranslateDot] = useState<'online' | 'offline' | 'starting' | 'standby'>('offline');
  const [ocrDot, setOcrDot] = useState<'online' | 'offline' | 'starting' | 'standby'>('offline');

  const pollServiceStatuses = useCallback(async () => {
    try {
      const [kb, model, asr, tts, sub, trans, ocr] = await Promise.all([
        WikiAPI.getStatus().catch(() => null),
        ModelServiceAPI.getStatus().catch(() => null),
        ASRServiceAPI.getStatus().catch(() => null),
        TtsServiceAPI.getStatus().catch(() => null),
        SubtitleServiceAPI.getStatus().catch(() => null),
        TranslateServiceAPI.getStatus().catch(() => null),
        OcrServiceAPI.getStatus().catch(() => null),
      ]);

      if (kb) setKbDot(deriveServiceState({ status: kb.status }));
      if (model) setModelDot(deriveServiceState({ status: model.status }));
      if (asr) {
        setAsrDot(
          deriveServiceState({
            status: asr.status,
            running: asr.running,
            loaded: Boolean(asr.model?.ready ?? asr.checks?.model),
          })
        );
      }
      if (tts) {
        setTtsDot(
          deriveServiceState({
            status: tts.status,
            running: tts.running,
            loaded: Boolean(tts.model?.ready),
          })
        );
      }
      if (sub) {
        const isAllReady = Boolean(
          sub.modelsStatus?.asr?.ready &&
            sub.modelsStatus?.segment?.ready &&
            sub.modelsStatus?.translate?.ready
        );
        setSubtitlesDot(
          deriveServiceState({
            running: sub.running,
            loading: Boolean(sub.downloadState?.active || sub.loading),
            loaded: isAllReady,
            paused: sub.paused,
          })
        );
      }
      if (trans) {
        const quick = trans.quick;
        setTranslateDot(
          deriveServiceState({
            running: quick?.serverReady,
            loading: Boolean(quick?.starting),
            loaded: Boolean(quick?.modelReady),
          })
        );
      }
      if (ocr) {
        setOcrDot(
          deriveServiceState({
            status: ocr.status,
            running: ocr.running,
            loaded: Boolean(ocr.model?.ready),
          })
        );
      }
    } catch {}
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    pollServiceStatuses();
    const interval = setInterval(pollServiceStatuses, 3000);
    return () => clearInterval(interval);
  }, [isOpen, pollServiceStatuses]);

  const handleServiceStatusUpdate = useCallback(
    (statuses: {
      model?: ServiceState;
      kb?: ServiceState;
      asr?: ServiceState;
      tts?: ServiceState;
      subtitles?: ServiceState;
      translate?: ServiceState;
      ocr?: ServiceState;
    }) => {
      if (statuses.kb) setKbDot(statuses.kb);
      if (statuses.model) setModelDot(statuses.model);
      if (statuses.asr) setAsrDot(statuses.asr);
      if (statuses.tts) setTtsDot(statuses.tts);
      if (statuses.subtitles) setSubtitlesDot(statuses.subtitles);
      if (statuses.translate) setTranslateDot(statuses.translate);
      if (statuses.ocr) setOcrDot(statuses.ocr);
    },
    []
  );

  if (!isOpen) return null;

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-center justify-center p-4 md:p-6 bg-black/60 backdrop-blur-sm select-none"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="relative w-[94vw] max-w-5xl h-[85vh] max-h-[850px] rounded-2xl bg-white dark:bg-[#1f2025] border border-black/10 dark:border-[#353842] shadow-2xl flex overflow-hidden text-[#1f2328] dark:text-[#cfd3dc]"
      >
        {/* Top Right Close Button */}
        <button
          type="button"
          onClick={onClose}
          className="absolute top-4 right-4 z-20 p-1.5 rounded-xl text-zinc-400 hover:text-zinc-800 hover:bg-black/5 dark:text-zinc-500 dark:hover:text-white dark:hover:bg-white/10 transition-colors cursor-pointer"
          title={t('cancel')}
        >
          <X className="w-5 h-5" />
        </button>

        {/* Left Navigation Sidebar */}
        <div className="w-56 md:w-60 flex-shrink-0 border-r border-black/5 dark:border-white/5 bg-[#f8f9fb] dark:bg-[#18191c] flex flex-col p-3 overflow-y-auto select-none">
          {/* Header Title */}
          <div className="px-2 pt-1 pb-3">
            <span className="text-sm font-bold text-[#1f2328] dark:text-[#f1f3f7]">
              {t('settingsTitle')}
            </span>
          </div>

          {/* Upper Tier: app设置 */}
          <div className="space-y-0.5">
            <div className="px-2 py-1 text-[11px] font-semibold text-zinc-400 dark:text-zinc-500 uppercase tracking-wider">
              {t('settingsGroupApp')}
            </div>

            <button
              type="button"
              data-tab-id="general"
              onClick={() => setActiveTab('general')}
              className={`w-full flex items-center px-3 py-2 rounded-xl text-xs transition-colors cursor-pointer text-left ${
                activeTab === 'general'
                  ? 'bg-black/5 dark:bg-white/10 text-zinc-900 dark:text-white font-semibold'
                  : 'text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200 hover:bg-black/[0.03] dark:hover:bg-white/[0.04]'
              }`}
            >
              <span>{t('tabGeneral')}</span>
            </button>

            <button
              type="button"
              data-tab-id="chat-models"
              onClick={() => setActiveTab('chat-models')}
              className={`w-full flex items-center px-3 py-2 rounded-xl text-xs transition-colors cursor-pointer text-left ${
                activeTab === 'chat-models'
                  ? 'bg-black/5 dark:bg-white/10 text-zinc-900 dark:text-white font-semibold'
                  : 'text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200 hover:bg-black/[0.03] dark:hover:bg-white/[0.04]'
              }`}
            >
              <span>{t('tabChatModel')}</span>
            </button>

            <button
              type="button"
              data-tab-id="storage"
              onClick={() => setActiveTab('storage')}
              className={`w-full flex items-center px-3 py-2 rounded-xl text-xs transition-colors cursor-pointer text-left ${
                activeTab === 'storage'
                  ? 'bg-black/5 dark:bg-white/10 text-zinc-900 dark:text-white font-semibold'
                  : 'text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200 hover:bg-black/[0.03] dark:hover:bg-white/[0.04]'
              }`}
            >
              <span>{t('tabStorage')}</span>
            </button>
          </div>

          {/* Lower Tier: 服务设置 */}
          <div className="space-y-0.5 mt-4">
            <div className="px-2 py-1 text-[11px] font-semibold text-zinc-400 dark:text-zinc-500 uppercase tracking-wider">
              {t('settingsGroupService')}
            </div>

            {/* 1. 基础模型服务 */}
            <button
              type="button"
              data-tab-id="svc-model"
              onClick={() => setActiveTab('svc-model')}
              className={`w-full flex items-center justify-between px-3 py-2 rounded-xl text-xs transition-colors cursor-pointer text-left ${
                activeTab === 'svc-model'
                  ? 'bg-black/5 dark:bg-white/10 text-zinc-900 dark:text-white font-semibold'
                  : 'text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200 hover:bg-black/[0.03] dark:hover:bg-white/[0.04]'
              }`}
            >
              <span className="truncate mr-2">{t('modelServiceTitle')}</span>
              <span className={`w-2 h-2 rounded-full flex-shrink-0 ${SERVICE_STATE_CARD_DOT_CLASS[modelDot]}`} />
            </button>

            {/* 2. 本地知识库 */}
            <button
              type="button"
              data-tab-id="svc-kb"
              onClick={() => setActiveTab('svc-kb')}
              className={`w-full flex items-center justify-between px-3 py-2 rounded-xl text-xs transition-colors cursor-pointer text-left ${
                activeTab === 'svc-kb'
                  ? 'bg-black/5 dark:bg-white/10 text-zinc-900 dark:text-white font-semibold'
                  : 'text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200 hover:bg-black/[0.03] dark:hover:bg-white/[0.04]'
              }`}
            >
              <span className="truncate mr-2">{t('wikiKnowledgeBase')}</span>
              <span className={`w-2 h-2 rounded-full flex-shrink-0 ${SERVICE_STATE_CARD_DOT_CLASS[kbDot]}`} />
            </button>

            {/* 3. 语音输入识别 */}
            <button
              type="button"
              data-tab-id="svc-asr"
              onClick={() => setActiveTab('svc-asr')}
              className={`w-full flex items-center justify-between px-3 py-2 rounded-xl text-xs transition-colors cursor-pointer text-left ${
                activeTab === 'svc-asr'
                  ? 'bg-black/5 dark:bg-white/10 text-zinc-900 dark:text-white font-semibold'
                  : 'text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200 hover:bg-black/[0.03] dark:hover:bg-white/[0.04]'
              }`}
            >
              <span className="truncate mr-2">{t('asrServiceTitle')}</span>
              <span className={`w-2 h-2 rounded-full flex-shrink-0 ${SERVICE_STATE_CARD_DOT_CLASS[asrDot]}`} />
            </button>

            {/* 4. 文字转语音 */}
            <button
              type="button"
              data-tab-id="svc-tts"
              onClick={() => setActiveTab('svc-tts')}
              className={`w-full flex items-center justify-between px-3 py-2 rounded-xl text-xs transition-colors cursor-pointer text-left ${
                activeTab === 'svc-tts'
                  ? 'bg-black/5 dark:bg-white/10 text-zinc-900 dark:text-white font-semibold'
                  : 'text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200 hover:bg-black/[0.03] dark:hover:bg-white/[0.04]'
              }`}
            >
              <span className="truncate mr-2">{t('ttsServiceTitle')}</span>
              <span className={`w-2 h-2 rounded-full flex-shrink-0 ${SERVICE_STATE_CARD_DOT_CLASS[ttsDot]}`} />
            </button>

            {/* 5. 实时双语字幕 */}
            <button
              type="button"
              data-tab-id="svc-subtitles"
              onClick={() => setActiveTab('svc-subtitles')}
              className={`w-full flex items-center justify-between px-3 py-2 rounded-xl text-xs transition-colors cursor-pointer text-left ${
                activeTab === 'svc-subtitles'
                  ? 'bg-black/5 dark:bg-white/10 text-zinc-900 dark:text-white font-semibold'
                  : 'text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200 hover:bg-black/[0.03] dark:hover:bg-white/[0.04]'
              }`}
            >
              <span className="truncate mr-2">{t('subtitleServiceTitle')}</span>
              <span className={`w-2 h-2 rounded-full flex-shrink-0 ${SERVICE_STATE_CARD_DOT_CLASS[subtitlesDot]}`} />
            </button>

            {/* 6. 快捷翻译 */}
            <button
              type="button"
              data-tab-id="svc-translate"
              onClick={() => setActiveTab('svc-translate')}
              className={`w-full flex items-center justify-between px-3 py-2 rounded-xl text-xs transition-colors cursor-pointer text-left ${
                activeTab === 'svc-translate'
                  ? 'bg-black/5 dark:bg-white/10 text-zinc-900 dark:text-white font-semibold'
                  : 'text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200 hover:bg-black/[0.03] dark:hover:bg-white/[0.04]'
              }`}
            >
              <span className="truncate mr-2">{t('translateServiceTitle')}</span>
              <span className={`w-2 h-2 rounded-full flex-shrink-0 ${SERVICE_STATE_CARD_DOT_CLASS[translateDot]}`} />
            </button>

            {/* 7. 视觉文档识别 */}
            <button
              type="button"
              data-tab-id="svc-ocr"
              onClick={() => setActiveTab('svc-ocr')}
              className={`w-full flex items-center justify-between px-3 py-2 rounded-xl text-xs transition-colors cursor-pointer text-left ${
                activeTab === 'svc-ocr'
                  ? 'bg-black/5 dark:bg-white/10 text-zinc-900 dark:text-white font-semibold'
                  : 'text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200 hover:bg-black/[0.03] dark:hover:bg-white/[0.04]'
              }`}
            >
              <span className="truncate mr-2">{t('ocrServiceTitle')}</span>
              <span className={`w-2 h-2 rounded-full flex-shrink-0 ${SERVICE_STATE_CARD_DOT_CLASS[ocrDot]}`} />
            </button>
          </div>
        </div>

        {/* Right Content Area */}
        <div className="flex-1 h-full overflow-y-auto p-6 md:p-8 bg-[#fdfdfd] dark:bg-[#1a1b1e]">
          <div className="max-w-3xl">
            <div className={['general', 'chat-models', 'storage'].includes(activeTab) ? 'block' : 'hidden'}>
              <AppSettingsPanel
                activeTab={activeTab}
                settings={settings}
                onSave={onSave}
              />
            </div>
            <div className={activeTab.startsWith('svc-') ? 'block' : 'hidden'}>
              <ServicesPanel
                activeTab={activeTab}
                settings={settings}
                isOpen={isOpen}
                onApiPortChange={onApiPortChange}
                onStatusChange={handleServiceStatusUpdate}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
