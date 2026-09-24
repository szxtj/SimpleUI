import React, { useState, useEffect, useRef } from 'react';
import { Sidebar } from './components/Sidebar';
import { ChatView } from './components/ChatView';
import { SettingsModal } from './components/SettingsModal';
import {
  ChatSession,
  ChatMessage,
  AppSettings,
  ServerHealthInfo,
  TurnMetrics,
} from './types/chat';
import {
  loadSessions,
  saveSessions,
  loadCurrentSessionId,
  saveCurrentSessionId,
  loadSettings,
  saveSettings,
  createNewSession,
  syncChannel,
} from './services/storage';
import { TurboFieldfareAPI } from './services/api';
import { SpotlightView } from './components/SpotlightView';
import { I18nProvider } from './i18n';
import { useTheme } from './hooks/useTheme';

export const App: React.FC = () => {
  const [settings, setSettings] = useState<AppSettings>(loadSettings());

  const isSpotlight =
    window.location.hash === '#/spotlight' ||
    window.location.search.includes('mode=spotlight');

  useTheme(settings.theme, isSpotlight);

  if (isSpotlight) {
    return (
      <I18nProvider preference={settings.language}>
        <SpotlightView />
      </I18nProvider>
    );
  }

  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [images, setImages] = useState<string[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [healthInfo, setHealthInfo] = useState<ServerHealthInfo>({
    status: 'connecting',
    vision: 'missing',
    online: false,
  });
  const [availableModels, setAvailableModels] = useState<string[]>([settings.modelId]);
  const [lastMetrics, setLastMetrics] = useState<TurnMetrics | undefined>(undefined);

  const abortControllerRef = useRef<AbortController | null>(null);
  const isSyncingRef = useRef(false);

  // Real-time synchronization helper
  const reloadFromStorage = () => {
    const loaded = loadSessions();
    if (loaded.length > 0) {
      isSyncingRef.current = true;
      setSessions(loaded);
      const savedId = loadCurrentSessionId();
      if (savedId && loaded.some((s) => s.id === savedId)) {
        setCurrentSessionId(savedId);
      } else {
        setCurrentSessionId(loaded[0].id);
      }
      setTimeout(() => {
        isSyncingRef.current = false;
      }, 80);
    }
  };

  // Initialize sessions and hook up cross-window sync
  useEffect(() => {
    // 1. Initial load
    reloadFromStorage();

    // 2. Expose global hook for Swift wrapper showAndFocus evaluation
    // @ts-expect-error global hook
    window.reloadSessionsFromStorage = reloadFromStorage;

    // 3. BroadcastChannel listener (instant real-time sync with Spotlight)
    if (syncChannel) {
      syncChannel.onmessage = (event) => {
        if (event.data?.type === 'SESSIONS_CHANGED') {
          reloadFromStorage();
        }
      };
    }

    // 4. Focus and storage event listeners
    const handleFocus = () => reloadFromStorage();
    const handleStorage = (e: StorageEvent) => {
      if (e.key === 'tff_chat_sessions_v1' || e.key === 'tff_chat_current_id_v1') {
        reloadFromStorage();
      }
    };

    window.addEventListener('focus', handleFocus);
    window.addEventListener('storage', handleStorage);

    return () => {
      window.removeEventListener('focus', handleFocus);
      window.removeEventListener('storage', handleStorage);
      // @ts-expect-error global hook
      delete window.reloadSessionsFromStorage;
    };
  }, []);

  // Poll server health & fetch models
  useEffect(() => {
    const checkServer = async () => {
      const info = await TurboFieldfareAPI.checkHealth(settings);
      setHealthInfo(info);
      if (info.online) {
        const models = await TurboFieldfareAPI.fetchModels(settings);
        if (models.length > 0) {
          setAvailableModels(models);
          const activeModel = info.modelId || (models.includes(settings.modelId) ? settings.modelId : models[0]);
          if (activeModel && activeModel !== settings.modelId && !models.includes(settings.modelId)) {
            setSettings((prev) => {
              const updated = { ...prev, modelId: activeModel };
              saveSettings(updated);
              return updated;
            });
          }
        }
      }
    };

    checkServer();
    const timer = setInterval(checkServer, 10000);
    return () => clearInterval(timer);
  }, [settings]);

  // Save sessions on change only when not syncing from outside
  useEffect(() => {
    if (sessions.length > 0 && !isSyncingRef.current) {
      saveSessions(sessions);
    }
  }, [sessions]);

  // Save current session ID on change
  useEffect(() => {
    if (!isSyncingRef.current) {
      saveCurrentSessionId(currentSessionId);
    }
  }, [currentSessionId]);

  // Notify native macOS wrapper to disable TitleBarDragView when SettingsModal is open
  useEffect(() => {
    // @ts-expect-error WebKit bridge
    window.webkit?.messageHandlers?.setModalOpen?.postMessage?.(isSettingsOpen);
  }, [isSettingsOpen]);

  // Notify native macOS wrapper about sidebar open state for titlebar drag hit-testing
  useEffect(() => {
    // @ts-expect-error WebKit bridge
    window.webkit?.messageHandlers?.setSidebarOpen?.postMessage?.(isSidebarOpen);
  }, [isSidebarOpen]);

  // Current session helper
  const currentSession = sessions.find((s) => s.id === currentSessionId);
  const messages = currentSession?.messages || [];
  const usedTokens = currentSession?.contextUsed || 0;

  // Session management handlers
  const handleNewSession = () => {
    const newSession = createNewSession();
    setSessions((prev) => [newSession, ...prev]);
    setCurrentSessionId(newSession.id);
    setLastMetrics(undefined);
    setInput('');
    setImages([]);
  };

  const handleDeleteSession = (id: string) => {
    setSessions((prev) => {
      const filtered = prev.filter((s) => s.id !== id);
      if (filtered.length === 0) {
        const fresh = createNewSession();
        setCurrentSessionId(fresh.id);
        return [fresh];
      }
      if (currentSessionId === id) {
        setCurrentSessionId(filtered[0].id);
      }
      return filtered;
    });
  };

  const handleRenameSession = (id: string, newTitle: string) => {
    setSessions((prev) =>
      prev.map((s) => (s.id === id ? { ...s, title: newTitle, updatedAt: Date.now() } : s))
    );
  };

  const handleSaveSettings = (newSettings: AppSettings) => {
    setSettings(newSettings);
    saveSettings(newSettings);
  };

  // Chat generation handler
  const handleSend = async (overridePrompt?: string) => {
    const textToSend = (overridePrompt ?? input).trim();
    if (!textToSend && images.length === 0) return;
    if (isGenerating) return;

    const currentImages = [...images];
    setInput('');
    setImages([]);

    const userMessage: ChatMessage = {
      id: 'msg-user-' + Date.now(),
      role: 'user',
      content: textToSend,
      images: currentImages.length > 0 ? currentImages : undefined,
      timestamp: Date.now(),
    };

    const assistantMsgId = 'msg-asst-' + (Date.now() + 1);
    const assistantMessage: ChatMessage = {
      id: assistantMsgId,
      role: 'assistant',
      content: '',
      reasoningContent: '',
      isThinking: settings.enableThinking,
      timestamp: Date.now(),
    };

    // Update session title on first message
    const isFirstUserMessage = messages.length === 0;
    const sessionTitle = isFirstUserMessage
      ? textToSend.slice(0, 24) || '图文分析'
      : currentSession?.title || '新对话';

    const updatedMessages = [...messages, userMessage, assistantMessage];

    setSessions((prev) =>
      prev.map((s) => {
        if (s.id === currentSessionId) {
          return {
            ...s,
            title: sessionTitle,
            messages: updatedMessages,
            updatedAt: Date.now(),
          };
        }
        return s;
      })
    );

    setIsGenerating(true);
    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    const thinkingStartTime = performance.now();

    await TurboFieldfareAPI.streamChat(
      [...messages, userMessage],
      settings,
      {
        onFirstToken: () => {
          // first token received
        },
        onThought: (delta) => {
          setSessions((prev) =>
            prev.map((s) => {
              if (s.id !== currentSessionId) return s;
              return {
                ...s,
                messages: s.messages.map((m) => {
                  if (m.id !== assistantMsgId) return m;
                  const newThought = (m.reasoningContent || '') + delta;
                  const duration = (performance.now() - thinkingStartTime) / 1000;
                  return {
                    ...m,
                    reasoningContent: newThought,
                    isThinking: true,
                    thinkingDuration: duration,
                  };
                }),
              };
            })
          );
        },
        onContent: (delta) => {
          setSessions((prev) =>
            prev.map((s) => {
              if (s.id !== currentSessionId) return s;
              return {
                ...s,
                messages: s.messages.map((m) => {
                  if (m.id !== assistantMsgId) return m;
                  const newContent = (m.content || '') + delta;
                  return {
                    ...m,
                    content: newContent,
                    isThinking: false, // content started, thinking ended
                  };
                }),
              };
            })
          );
        },
        onDone: (metrics) => {
          setIsGenerating(false);
          abortControllerRef.current = null;
          setLastMetrics(metrics);

          setSessions((prev) =>
            prev.map((s) => {
              if (s.id !== currentSessionId) return s;
              return {
                ...s,
                contextUsed: metrics.contextUsed,
                messages: s.messages.map((m) => {
                  if (m.id !== assistantMsgId) return m;
                  return {
                    ...m,
                    isThinking: false,
                    metrics,
                  };
                }),
              };
            })
          );
        },
        onError: (err) => {
          setIsGenerating(false);
          abortControllerRef.current = null;
          setSessions((prev) =>
            prev.map((s) => {
              if (s.id !== currentSessionId) return s;
              return {
                ...s,
                messages: s.messages.map((m) => {
                  if (m.id !== assistantMsgId) return m;
                  return {
                    ...m,
                    isThinking: false,
                    error: err.message,
                  };
                }),
              };
            })
          );
        },
      },
      abortController.signal
    );
  };

  const handleStop = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
      setIsGenerating(false);
    }
  };

  return (
    <I18nProvider preference={settings.language}>
      <div className="flex h-screen w-screen overflow-hidden bg-[#f8f9fb] dark:bg-[#18191c] text-[#1f2328] dark:text-[#f1f3f7]">
        {/* Sessions Sidebar */}
        <Sidebar
          sessions={sessions}
          currentSessionId={currentSessionId}
          onSelectSession={(id) => {
            setCurrentSessionId(id);
          }}
          onNewSession={handleNewSession}
          onDeleteSession={handleDeleteSession}
          onRenameSession={handleRenameSession}
          onOpenSettings={() => setIsSettingsOpen(true)}
          healthInfo={healthInfo}
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
          enableThinking={settings.enableThinking}
          setEnableThinking={(val) => {
            setSettings((prev) => ({ ...prev, enableThinking: val }));
            saveSettings({ ...settings, enableThinking: val });
          }}
          modelId={settings.modelId}
          availableModels={availableModels}
          onSelectModel={(m) => {
            setSettings((prev) => ({ ...prev, modelId: m }));
            saveSettings({ ...settings, modelId: m });
          }}
          visionReady={healthInfo.vision === 'ready'}
          lastMetrics={lastMetrics}
          onOpenSettings={() => setIsSettingsOpen(true)}
          isSidebarOpen={isSidebarOpen}
          onToggleSidebar={() => setIsSidebarOpen(!isSidebarOpen)}
        />

        {/* Settings Modal */}
        <SettingsModal
          isOpen={isSettingsOpen}
          onClose={() => setIsSettingsOpen(false)}
          settings={settings}
          onSave={handleSaveSettings}
        />
      </div>
    </I18nProvider>
  );
};
