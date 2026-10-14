import React, { useState, useEffect, useMemo } from 'react';
import { Sidebar } from './components/Sidebar';
import { ChatView } from './components/ChatView';
import { SettingsModal } from './components/SettingsModal';
import { ServiceManagerModal } from './components/ServiceManagerModal';
import {
  AppSettings,
  ServerHealthInfo,
  WikiStatusInfo,
  AsrServiceStatus,
} from './types/chat';
import {
  loadSettings,
  saveSettings,
  DEFAULT_LOCAL_CONFIG,
  DEFAULT_DEEPSEEK_CONFIG,
  syncChannel,
} from './services/storage';
import { TurboFieldfareAPI, WikiAPI, ASRServiceAPI, ModelServiceAPI } from './services/api';
import type { ModelServiceStatus } from './services/api';
import {
  buildSessionSettings,
  getActiveContextMessages,
} from './services/chatTurn';
import { SpotlightView } from './components/SpotlightView';
import { VoiceOverlay } from './components/VoiceOverlay';
import { SubtitleOverlay } from './components/SubtitleOverlay';
import { WikiSidebar } from './components/WikiSidebar';
import { I18nProvider, resolveLanguage } from './i18n';
import { useTheme } from './hooks/useTheme';
import { useSessionStore } from './hooks/useSessionStore';
import { estimateHistoryTokens, applyTokenCalibration } from './utils/token';
import { triggerMediaGC } from './services/mediaCleanup';

export const App: React.FC = () => {
  const [settings, setSettings] = useState<AppSettings>(loadSettings());
  const activeLang = resolveLanguage(settings.language);

  // Real-time synchronization of settings across Main and Spotlight windows
  useEffect(() => {
    if (!syncChannel) return;
    const handler = (event: MessageEvent) => {
      if (event.data?.type === 'SETTINGS_CHANGED') {
        setSettings(loadSettings());
      }
    };
    syncChannel.addEventListener('message', handler);
    return () => {
      syncChannel?.removeEventListener('message', handler);
    };
  }, []);

  useEffect(() => {
    const handleStorage = (e: StorageEvent) => {
      if (e.key === 'tff_chat_settings_v1') {
        setSettings(loadSettings());
      }
    };
    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }, []);

  // 语音输入桥：原生侧在「焦点在本 App 自身输入框」时调用，把转写结果插入当前光标处。
  // 因输入框是受控组件，需用原生 value setter + 派发 input 事件触发 React onChange。
  useEffect(() => {
    const w = window as any;
    w.__insertVoiceText = (text: string) => {
      if (!text) return;
      const isEditable = (el: Element | null): el is HTMLElement =>
        !!el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || (el as HTMLElement).isContentEditable);

      let field = document.activeElement as HTMLElement | null;
      if (!isEditable(field)) {
        const fallback = document.querySelector<HTMLElement>('[data-chat-input]');
        if (fallback) {
          fallback.focus();
          field = fallback;
        }
      }
      if (!isEditable(field)) return;

      if (field.isContentEditable) {
        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0) return;
        const range = sel.getRangeAt(0);
        range.deleteContents();
        range.insertNode(document.createTextNode(text));
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
        field.dispatchEvent(new Event('input', { bubbles: true }));
        return;
      }

      const inputEl = field as HTMLTextAreaElement & HTMLInputElement;
      const start = inputEl.selectionStart ?? inputEl.value.length;
      const end = inputEl.selectionEnd ?? start;
      const next = inputEl.value.slice(0, start) + text + inputEl.value.slice(end);
      const proto = field.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      const desc = Object.getOwnPropertyDescriptor(proto, 'value') || Object.getOwnPropertyDescriptor(Object.getPrototypeOf(inputEl), 'value');
      if (desc?.set) desc.set.call(inputEl, next);
      else inputEl.value = next;
      inputEl.dispatchEvent(new Event('input', { bubbles: true }));
      const pos = start + text.length;
      try {
        inputEl.setSelectionRange(pos, pos);
      } catch {
        /* 非受支持元素忽略 */
      }
    };
    return () => {
      w.__insertVoiceText = undefined;
    };
  }, []);

  const isSpotlight =
    window.location.hash === '#/spotlight' ||
    window.location.search.includes('mode=spotlight');

  // 语音识别悬浮胶囊（原生 VoiceOverlayPanelController 承载的独立窗口）
  const isVoiceOverlay = window.location.hash === '#/voice';

  // 实时双语字幕悬浮面板（原生 SubtitleOverlayPanelController 承载的独立窗口）
  const isSubtitleOverlay =
    window.location.hash === '#/subtitles' ||
    window.location.search.includes('mode=subtitles');

  useTheme(settings.theme, isSpotlight || isVoiceOverlay || isSubtitleOverlay);

  if (isSubtitleOverlay) {
    return (
      <I18nProvider preference={settings.language}>
        <SubtitleOverlay />
      </I18nProvider>
    );
  }

  if (isVoiceOverlay) {
    return (
      <I18nProvider preference={settings.language}>
        <VoiceOverlay />
      </I18nProvider>
    );
  }

  if (isSpotlight) {
    return (
      <I18nProvider preference={settings.language}>
        <SpotlightView />
      </I18nProvider>
    );
  }

  return <MainWindowView settings={settings} setSettings={setSettings} activeLang={activeLang} />;
};

interface MainWindowViewProps {
  settings: AppSettings;
  setSettings: React.Dispatch<React.SetStateAction<AppSettings>>;
  activeLang: 'zh' | 'en';
}

const MainWindowView: React.FC<MainWindowViewProps> = ({
  settings,
  setSettings,
  activeLang,
}) => {
  const defaultTitle = activeLang === 'en' ? 'New Chat' : '新对话';
  const {
    sessions,
    currentSessionId,
    currentSession,
    messages,
    generatingSessionIds,
    isGenerating,
    liveStreamingTokens,
    lastMetrics,
    selectSession,
    createOrReuseEmptySession,
    updateSessionMeta,
    deleteSession,
    sendTurn,
    abortTurn,
    retryTurn,
    deleteTurn,
    handoffToSpotlight,
    refreshState,
  } = useSessionStore('MAIN', defaultTitle);

  const [input, setInput] = useState('');
  const [images, setImages] = useState<string[]>([]);
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  /** 服务管理界面（三项受管服务的启停与参数，与设置界面并列的独立入口） */
  const [isServiceManagerOpen, setIsServiceManagerOpen] = useState(false);
  const [healthInfo, setHealthInfo] = useState<ServerHealthInfo>({
    status: 'connecting',
    vision: 'missing',
    online: false,
  });
  const [availableModels, setAvailableModels] = useState<string[]>([settings.modelId]);
  const [wikiStatus, setWikiStatus] = useState<WikiStatusInfo>({
    enabled: true,
    connected: false,
    status: 'stopped',
    port: 31236,
    zimPath: null,
    contentId: null,
    bookTitle: 'Knowledge Base',
    articleCount: 0,
    mediaCount: 0,
  });
  const [activeWikiArticle, setActiveWikiArticle] = useState<string | null>(null);
  const [activeWikiContext, setActiveWikiContext] = useState<string | null>(null);
  const [isWikiPanelOpen, setIsWikiPanelOpen] = useState(false);
  /** 语音识别服务状态（左下角服务行） */
  const [asrStatus, setAsrStatus] = useState<AsrServiceStatus | null>(null);
  /** 基础模型服务状态（左下角服务行；带 status 字段，可区分启动中） */
  const [modelStatus, setModelStatus] = useState<ModelServiceStatus | null>(null);

  // Expose global hook for Swift wrapper showAndFocus evaluation & focus refresh
  useEffect(() => {
    const handleFocus = () => {
      refreshState();
      setSettings(loadSettings());
    };
    // @ts-expect-error global hook
    window.reloadSessionsFromStorage = refreshState;
    // @ts-expect-error global hook
    window.__syncSessionStore = refreshState;
    window.addEventListener('focus', handleFocus);
    return () => {
      window.removeEventListener('focus', handleFocus);
      // @ts-expect-error global hook
      delete window.reloadSessionsFromStorage;
      // @ts-expect-error global hook
      delete window.__syncSessionStore;
    };
  }, [refreshState, setSettings]);

  // Poll server health & fetch models
  useEffect(() => {
    const isDeepSeek = settings.apiProvider === 'deepseek';
    const checkServer = async () => {
      const info = await TurboFieldfareAPI.checkHealth(settings);
      setHealthInfo(info);
      if (info.online) {
        const models = await TurboFieldfareAPI.fetchModels(settings);
        if (models.length > 0) {
          setAvailableModels(models);
          if (isDeepSeek) {
            const currentModel = settings.deepseekModelId || 'deepseek-flash';
            if (!models.includes(currentModel)) {
              const activeModel = models[0];
              setSettings((prev) => {
                const nextDs = { ...(prev.deepseekConfig || DEFAULT_DEEPSEEK_CONFIG), modelId: activeModel };
                const updated = { ...prev, deepseekModelId: activeModel, deepseekConfig: nextDs };
                saveSettings(updated);
                return updated;
              });
            }
          } else {
            const activeModel = info.modelId || (models.includes(settings.modelId) ? settings.modelId : models[0]);
            if (activeModel && activeModel !== settings.modelId && !models.includes(settings.modelId)) {
              setSettings((prev) => {
                const nextLocal = { ...(prev.localConfig || DEFAULT_LOCAL_CONFIG), modelId: activeModel };
                const updated = { ...prev, modelId: activeModel, localConfig: nextLocal };
                saveSettings(updated);
                return updated;
              });
            }
          }
        }
      } else if (isDeepSeek) {
        setAvailableModels(['deepseek-flash', 'deepseek-v4-pro']);
      }
    };

    checkServer();
    const timer = setInterval(checkServer, 10000);
    return () => clearInterval(timer);
  }, [
    settings.apiProvider,
    settings.apiPort,
    settings.modelId,
    settings.deepseekApiKey,
    settings.deepseekModelId,
    settings.deepseekBaseUrl,
    setSettings,
  ]);

  // DeepSeek 模式下自动关闭知识库面板
  useEffect(() => {
    if (settings.apiProvider === 'deepseek' && isWikiPanelOpen) {
      setIsWikiPanelOpen(false);
    }
  }, [settings.apiProvider, isWikiPanelOpen]);

  // Poll local offline Wiki status
  useEffect(() => {
    const checkWiki = async () => {
      const status = await WikiAPI.getStatus();
      setWikiStatus(status);
    };
    checkWiki();
    const wikiTimer = setInterval(checkWiki, 6000);
    return () => clearInterval(wikiTimer);
  }, []);

  // Poll 语音识别服务状态（左下角服务行）
  useEffect(() => {
    const checkAsr = async () => {
      const status = await ASRServiceAPI.getStatus();
      setAsrStatus(status);
    };
    checkAsr();
    const asrTimer = setInterval(checkAsr, 6000);
    return () => clearInterval(asrTimer);
  }, []);

  // Poll 基础模型服务状态（左下角服务行）
  useEffect(() => {
    const checkModel = async () => {
      const status = await ModelServiceAPI.getStatus();
      setModelStatus(status);
    };
    checkModel();
    const modelTimer = setInterval(checkModel, 6000);
    return () => clearInterval(modelTimer);
  }, []);

  // Notify native macOS wrapper to disable TitleBarDragView when a modal is open
  useEffect(() => {
    // @ts-expect-error WebKit bridge
    window.webkit?.messageHandlers?.setModalOpen?.postMessage?.(isSettingsOpen || isServiceManagerOpen);
  }, [isSettingsOpen, isServiceManagerOpen]);

  // Notify native macOS wrapper about sidebar open state for titlebar drag hit-testing
  useEffect(() => {
    // @ts-expect-error WebKit bridge
    window.webkit?.messageHandlers?.setSidebarOpen?.postMessage?.(isSidebarOpen);
  }, [isSidebarOpen]);

  // Notify native macOS wrapper about wiki panel state (window min-size accounting)
  useEffect(() => {
    // @ts-expect-error WebKit bridge
    window.webkit?.messageHandlers?.setWikiPanelOpen?.postMessage?.(isWikiPanelOpen);
  }, [isWikiPanelOpen]);

  // 后台静默执行磁盘孤立媒体文件垃圾回收（启动 3 秒后执行，5 分钟安全缓冲期）
  useEffect(() => {
    const timer = setTimeout(() => {
      if (sessions.length > 0) {
        triggerMediaGC(sessions);
      }
    }, 3000);
    return () => clearTimeout(timer);
  }, []);

  // Persistent conversation history baseline tokens (excluding temporary RAG prompts & reasoning tokens)
  const persistentHistoryTokens = useMemo(() => {
    if (!messages || messages.length === 0) return 0;
    const activeMessages = getActiveContextMessages(messages, {
      systemPrompt: settings.systemPrompt,
      maxContext: settings.maxContext,
      maxTokens: settings.maxTokens,
      provider: settings.apiProvider,
    });
    return applyTokenCalibration(
      estimateHistoryTokens(activeMessages, settings.systemPrompt, settings.apiProvider),
      settings.apiProvider
    );
  }, [messages, settings.systemPrompt, settings.maxContext, settings.maxTokens, settings.apiProvider]);

  const currentLiveTokens = currentSessionId ? liveStreamingTokens[currentSessionId] : undefined;
  const usedTokens = (isGenerating && currentLiveTokens !== undefined) ? currentLiveTokens : persistentHistoryTokens;

  // Clear unsendable image attachments if Mference is selected
  useEffect(() => {
    if (settings.apiProvider === 'mference' && images.length > 0) {
      setImages([]);
    }
  }, [settings.apiProvider, images.length]);

  const handleNewSession = async () => {
    await createOrReuseEmptySession(defaultTitle);
    setInput('');
    setImages([]);
  };

  const handleDeleteSession = async (id: string) => {
    await deleteSession(id, defaultTitle);
  };

  const handleRenameSession = async (id: string, newTitle: string) => {
    if (generatingSessionIds.includes(id)) return;
    await updateSessionMeta(id, { title: newTitle });
  };

  const handleSaveSettings = (newSettings: AppSettings) => {
    setSettings(newSettings);
    saveSettings(newSettings);
  };

  const handleServiceApiPortChange = (port: number) => {
    setSettings((prev) => {
      const nextLocal = { ...(prev.localConfig || DEFAULT_LOCAL_CONFIG), apiPort: port };
      const updated = { ...prev, apiPort: port, localConfig: nextLocal };
      saveSettings(updated);
      return updated;
    });
  };

  const handleSend = async (overridePrompt?: string) => {
    const textToSend = (overridePrompt ?? input).trim();
    if (!textToSend && images.length === 0) return;
    if (currentSessionId && generatingSessionIds.includes(currentSessionId)) return;

    const currentImages = [...images];
    setInput('');
    setImages([]);

    const isDeepSeek = settings.apiProvider === 'deepseek';
    const sessionEnableThinking = currentSession?.enableThinking ?? false;
    const sessionEnableWiki = isDeepSeek ? false : (currentSession?.enableWikiSearch ?? false);
    const sessionSettings = buildSessionSettings(settings, sessionEnableThinking, sessionEnableWiki);

    await sendTurn({
      sessionId: currentSessionId,
      text: textToSend,
      images: currentImages,
      settings: sessionSettings,
      lang: activeLang,
    });
  };

  const handleRetry = async (assistantMessageId: string) => {
    const isDeepSeek = settings.apiProvider === 'deepseek';
    const sessionEnableThinking = currentSession?.enableThinking ?? false;
    const sessionEnableWiki = isDeepSeek ? false : (currentSession?.enableWikiSearch ?? false);
    const sessionSettings = buildSessionSettings(settings, sessionEnableThinking, sessionEnableWiki);

    await retryTurn({
      assistantMessageId,
      settings: sessionSettings,
      lang: activeLang,
      sessionId: currentSessionId,
    });
  };

  const handleDeleteTurn = async (assistantMessageId: string) => {
    await deleteTurn(assistantMessageId, currentSessionId);
  };

  const handleStop = async (sessionIdToStop?: string) => {
    const targetId =
      typeof sessionIdToStop === 'string' && sessionIdToStop
        ? sessionIdToStop
        : currentSessionId;
    if (!targetId) return;
    await abortTurn(targetId);
  };

  const handleShrinkToSpotlight = () => {
    const hasMessages = (currentSession?.messages?.length ?? 0) > 0 || isGenerating;
    if (currentSessionId) {
      handoffToSpotlight(currentSessionId);
    }
    // @ts-expect-error WebKit bridge
    if (window.webkit?.messageHandlers?.shrinkToSpotlight) {
      // @ts-expect-error WebKit bridge
      window.webkit.messageHandlers.shrinkToSpotlight.postMessage({
        sessionId: currentSessionId,
        isExpanded: hasMessages,
      });
    }
  };

  return (
    <I18nProvider preference={settings.language}>
      <div className="flex h-screen w-screen overflow-hidden bg-[#f8f9fb] dark:bg-[#18191c] text-[#1f2328] dark:text-[#f1f3f7]">
        {/* Sessions Sidebar */}
        <Sidebar
          sessions={sessions}
          currentSessionId={currentSessionId}
          generatingSessionIds={generatingSessionIds}
          onSelectSession={(id) => {
            selectSession(id);
          }}
          onNewSession={handleNewSession}
          onDeleteSession={handleDeleteSession}
          onRenameSession={handleRenameSession}
          onOpenSettings={() => setIsSettingsOpen(true)}
          onOpenServiceManager={() => setIsServiceManagerOpen(true)}
          modelStatus={modelStatus}
          wikiStatus={wikiStatus}
          asrStatus={asrStatus}
          isOpen={isSidebarOpen}
          onToggleOpen={() => setIsSidebarOpen(!isSidebarOpen)}
        />

        {/* Main Chat Interface */}
        <ChatView
          messages={messages}
          input={input}
          setInput={setInput}
          images={images}
          setImages={setImages}
          isGenerating={isGenerating}
          onSend={handleSend}
          onStop={handleStop}
          usedTokens={usedTokens}
          maxContext={settings.maxContext}
          enableThinking={currentSession?.enableThinking ?? false}
          setEnableThinking={(val) => {
            if (!currentSessionId) return;
            updateSessionMeta(currentSessionId, { enableThinking: val });
          }}
          modelId={settings.apiProvider === 'deepseek' ? (settings.deepseekModelId || 'deepseek-flash') : settings.modelId}
          availableModels={availableModels}
          onSelectModel={(m) => {
            if (settings.apiProvider === 'deepseek') {
              const nextDs = { ...(settings.deepseekConfig || DEFAULT_DEEPSEEK_CONFIG), modelId: m };
              const updated = {
                ...settings,
                deepseekModelId: m,
                modelId: m,
                deepseekConfig: nextDs,
              };
              setSettings(updated);
              saveSettings(updated);
            } else {
              const nextLocal = { ...(settings.localConfig || DEFAULT_LOCAL_CONFIG), modelId: m };
              const updated = {
                ...settings,
                modelId: m,
                localConfig: nextLocal,
              };
              setSettings(updated);
              saveSettings(updated);
            }
          }}
          isDeepSeek={settings.apiProvider === 'deepseek'}
          isMference={settings.apiProvider === 'mference'}
          visionReady={healthInfo.vision === 'ready'}
          lastMetrics={lastMetrics}
          onOpenSettings={() => setIsSettingsOpen(true)}
          isSidebarOpen={isSidebarOpen}
          onToggleSidebar={() => setIsSidebarOpen(!isSidebarOpen)}
          enableWikiSearch={currentSession?.enableWikiSearch ?? false}
          setEnableWikiSearch={(val) => {
            if (!currentSessionId) return;
            updateSessionMeta(currentSessionId, { enableWikiSearch: val });
          }}
          wikiConnected={wikiStatus.connected}
          wikiEnabled={wikiStatus.enabled}
          wikiPanelOpen={isWikiPanelOpen}
          onToggleWikiPanel={() => setIsWikiPanelOpen((v) => !v)}
          onOpenWiki={(title, context) => {
            setActiveWikiArticle(title);
            setActiveWikiContext(context ?? null);
            setIsWikiPanelOpen(true);
          }}
          onRetry={handleRetry}
          onDelete={handleDeleteTurn}
          onShrinkToSpotlight={handleShrinkToSpotlight}
        />

        {/* Wikipedia Offline Article Reader — right docked sidebar */}
        <WikiSidebar
          isOpen={isWikiPanelOpen}
          title={activeWikiArticle}
          context={activeWikiContext}
          wikiEnabled={wikiStatus.enabled}
          wikiConnected={wikiStatus.connected}
          onClose={() => {
            setIsWikiPanelOpen(false);
            setActiveWikiArticle(null);
            setActiveWikiContext(null);
          }}
        />

        {/* Settings Modal */}
        <SettingsModal
          isOpen={isSettingsOpen}
          onClose={() => setIsSettingsOpen(false)}
          settings={settings}
          onSave={handleSaveSettings}
        />

        {/* 服务管理界面（三项受管服务：基础模型 / 知识库 / 语音识别） */}
        <ServiceManagerModal
          isOpen={isServiceManagerOpen}
          onClose={() => setIsServiceManagerOpen(false)}
          settings={settings}
          onApiPortChange={handleServiceApiPortChange}
        />
      </div>
    </I18nProvider>
  );
};
