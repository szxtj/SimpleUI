import React, { useState, useEffect, useRef, useMemo } from 'react';
import { Sidebar } from './components/Sidebar';
import { ChatView } from './components/ChatView';
import { SettingsModal } from './components/SettingsModal';
import {
  ChatSession,
  ChatMessage,
  AppSettings,
  ServerHealthInfo,
  TurnMetrics,
  WikiStatusInfo,
  WikiCitation,
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
import { TurboFieldfareAPI, WikiAPI } from './services/api';
import { SpotlightView } from './components/SpotlightView';
import { WikiSidebar } from './components/WikiSidebar';
import { I18nProvider, resolveLanguage } from './i18n';
import { useTheme } from './hooks/useTheme';
import { estimateHistoryTokens } from './utils/token';

export const App: React.FC = () => {
  const [settings, setSettings] = useState<AppSettings>(loadSettings());
  const activeLang = resolveLanguage(settings.language);

  // Real-time synchronization of settings across Main and Spotlight windows
  useEffect(() => {
    if (syncChannel) {
      const handler = (event: MessageEvent) => {
        if (event.data?.type === 'SETTINGS_CHANGED') {
          setSettings(loadSettings());
        }
      };
      syncChannel.addEventListener('message', handler);
      return () => {
        syncChannel?.removeEventListener('message', handler);
      };
    }
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

  const [sessions, setSessions] = useState<ChatSession[]>(() => {
    const loaded = loadSessions();
    return loaded.length > 0 ? loaded : [createNewSession()];
  });
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(() => {
    const loaded = loadSessions();
    const savedId = loadCurrentSessionId();
    if (savedId && loaded.some((s) => s.id === savedId)) {
      return savedId;
    }
    return loaded.length > 0 ? loaded[0].id : null;
  });
  const [input, setInput] = useState('');
  const [images, setImages] = useState<string[]>([]);
  const [generatingSessionIds, setGeneratingSessionIds] = useState<string[]>([]);
  const [liveStreamingTokens, setLiveStreamingTokens] = useState<Record<string, number>>({});
  const isGenerating = currentSessionId ? generatingSessionIds.includes(currentSessionId) : false;
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [healthInfo, setHealthInfo] = useState<ServerHealthInfo>({
    status: 'connecting',
    vision: 'missing',
    online: false,
  });
  const [availableModels, setAvailableModels] = useState<string[]>([settings.modelId]);
  const [lastMetrics, setLastMetrics] = useState<TurnMetrics | undefined>(undefined);
  const [wikiStatus, setWikiStatus] = useState<WikiStatusInfo>({
    enabled: true,
    connected: false,
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

  const abortControllersRef = useRef<Map<string, AbortController>>(new Map());
  const activeStreamsRef = useRef<Map<string, {
    messageId: string;
    reasoningContent: string;
    content: string;
    isThinking: boolean;
    thinkingDuration: number;
  }>>(new Map());
  const isSyncingRef = useRef(false);
  const generatingSessionIdsRef = useRef<string[]>([]);
  const currentSessionIdRef = useRef<string | null>(currentSessionId);

  useEffect(() => {
    generatingSessionIdsRef.current = generatingSessionIds;
  }, [generatingSessionIds]);

  useEffect(() => {
    currentSessionIdRef.current = currentSessionId;
  }, [currentSessionId]);

  // Invariant guard: Guarantee at least one session exists and currentSessionId points to a valid session
  useEffect(() => {
    if (sessions.length === 0) {
      const fresh = createNewSession();
      setSessions([fresh]);
      setCurrentSessionId(fresh.id);
      saveSessions([fresh]);
      saveCurrentSessionId(fresh.id);
    } else if (!currentSessionId || !sessions.some((s) => s.id === currentSessionId)) {
      const fallbackId = sessions[0].id;
      setCurrentSessionId(fallbackId);
      saveCurrentSessionId(fallbackId);
    }
  }, [sessions, currentSessionId]);

  // Real-time synchronization helper
  const reloadFromStorage = () => {
    if (generatingSessionIdsRef.current.length > 0) {
      // Main window is actively generating! Do not overwrite in-memory generating session!
      return;
    }
    const loaded = loadSessions();
    const safeLoaded = loaded.length > 0 ? loaded : [createNewSession()];
    isSyncingRef.current = true;
    setSessions(safeLoaded);
    const savedId = loadCurrentSessionId();
    if (savedId && safeLoaded.some((s) => s.id === savedId)) {
      setCurrentSessionId(savedId);
    } else {
      setCurrentSessionId(safeLoaded[0].id);
      saveCurrentSessionId(safeLoaded[0].id);
    }
    setTimeout(() => {
      isSyncingRef.current = false;
    }, 80);
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
        const data = event.data;
        if (!data) return;

        if (data.type === 'SESSIONS_CHANGED') {
          reloadFromStorage();
        } else if (data.type === 'SETTINGS_CHANGED') {
          setSettings(loadSettings());
        } else if (data.type === 'STREAM_TOKEN_PROGRESS') {
          if (data.source !== 'MAIN' && data.sessionId) {
            setLiveStreamingTokens((prev) => ({ ...prev, [data.sessionId]: data.liveTokens }));
          }
        } else if (data.type === 'STREAM_CHUNK') {
          if (data.source !== 'MAIN') {
            const { sessionId, messageId, reasoningContent, content, isThinking, thinkingDuration } = data;
            setGeneratingSessionIds((prev) => (prev.includes(sessionId) ? prev : [...prev, sessionId]));
            setSessions((prev) => {
              const sessionIdx = prev.findIndex((s) => s.id === sessionId);
              if (sessionIdx >= 0) {
                const targetSession = prev[sessionIdx];
                const msgIdx = targetSession.messages.findIndex((m) => m.id === messageId);
                let updatedMsgs: ChatMessage[];
                if (msgIdx >= 0) {
                  updatedMsgs = targetSession.messages.map((m) =>
                    m.id === messageId
                      ? {
                          ...m,
                          reasoningContent,
                          content,
                          isThinking,
                          thinkingDuration,
                        }
                      : m
                  );
                } else {
                  const all = loadSessions();
                  const sFromDisk = all.find((s) => s.id === sessionId);
                  if (sFromDisk) return all;
                  return prev;
                }
                const updatedSessions = [...prev];
                updatedSessions[sessionIdx] = {
                  ...targetSession,
                  messages: updatedMsgs,
                };
                return updatedSessions;
              } else {
                const all = loadSessions();
                return all.length > 0 ? all : prev;
              }
            });
          }
        } else if (data.type === 'STREAM_DONE') {
          if (data.source !== 'MAIN') {
            const { sessionId, messageId, reasoningContent, content, thinkingDuration, metrics } = data;
            setGeneratingSessionIds((prev) => prev.filter((id) => id !== sessionId));
            setLiveStreamingTokens((prev) => {
              const next = { ...prev };
              delete next[sessionId];
              return next;
            });
            setSessions((prev) =>
              prev.map((s) => {
                if (s.id !== sessionId) return s;
                const updatedMsgs = s.messages.map((m) =>
                  m.id === messageId
                    ? {
                        ...m,
                        reasoningContent,
                        content,
                        isThinking: false,
                        thinkingDuration,
                        metrics,
                      }
                    : m
                );
                const cleanHistoryTokens = estimateHistoryTokens(updatedMsgs, settings.systemPrompt);
                return {
                  ...s,
                  contextUsed: cleanHistoryTokens,
                  messages: updatedMsgs,
                };
              })
            );
            if (currentSessionIdRef.current === sessionId && metrics) {
              setLastMetrics(metrics);
            }
          }
        } else if (data.type === 'STREAM_ABORT') {
          const targetId = data.sessionId;
          if (targetId) {
            const controller = abortControllersRef.current.get(targetId);
            if (controller) {
              controller.abort();
              abortControllersRef.current.delete(targetId);
            }
            activeStreamsRef.current.delete(targetId);
            setGeneratingSessionIds((prev) => prev.filter((id) => id !== targetId));
            setLiveStreamingTokens((prev) => {
              const next = { ...prev };
              delete next[targetId];
              return next;
            });
          } else {
            abortControllersRef.current.forEach((controller) => controller.abort());
            abortControllersRef.current.clear();
            activeStreamsRef.current.clear();
            setGeneratingSessionIds([]);
            setLiveStreamingTokens({});
          }
        } else if (data.type === 'STREAM_QUERY') {
          activeStreamsRef.current.forEach((stream, sessId) => {
            syncChannel?.postMessage({
              type: 'STREAM_CHUNK',
              sessionId: sessId,
              messageId: stream.messageId,
              reasoningContent: stream.reasoningContent,
              content: stream.content,
              isThinking: stream.isThinking,
              thinkingDuration: stream.thinkingDuration,
              source: 'MAIN',
            });
          });
        }
      };
    }

    // 4. Focus and storage event listeners
    const handleFocus = () => {
      reloadFromStorage();
      setSettings(loadSettings());
      syncChannel?.postMessage({ type: 'STREAM_QUERY' });
    };
    const handleStorage = (e: StorageEvent) => {
      if (e.key === 'tff_chat_sessions_v1' || e.key === 'tff_chat_current_id_v1') {
        reloadFromStorage();
      } else if (e.key === 'tff_chat_settings_v1') {
        setSettings(loadSettings());
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
  }, [settings.apiPort, settings.modelId]);

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

  // Notify native macOS wrapper about wiki panel state (window min-size accounting)
  useEffect(() => {
    // @ts-expect-error WebKit bridge
    window.webkit?.messageHandlers?.setWikiPanelOpen?.postMessage?.(isWikiPanelOpen);
  }, [isWikiPanelOpen]);

  // Current session helper
  const currentSession = sessions.find((s) => s.id === currentSessionId);
  const messages = currentSession?.messages || [];

  // Persistent conversation history baseline tokens (excluding temporary RAG prompts & reasoning tokens)
  const persistentHistoryTokens = useMemo(() => {
    if (!messages || messages.length === 0) return 0;
    return estimateHistoryTokens(messages, settings.systemPrompt);
  }, [messages, settings.systemPrompt]);

  const currentLiveTokens = currentSessionId ? liveStreamingTokens[currentSessionId] : undefined;
  const usedTokens = (isGenerating && currentLiveTokens !== undefined) ? currentLiveTokens : persistentHistoryTokens;

  // Session management handlers
  const handleNewSession = () => {
    // If an empty session already exists, navigate to it instead of creating duplicate blank sessions
    const existingEmpty = sessions.find((s) => !s.messages || s.messages.length === 0);
    if (existingEmpty) {
      setCurrentSessionId(existingEmpty.id);
      setLastMetrics(undefined);
      setInput('');
      setImages([]);
      return;
    }
    const newSession = createNewSession(activeLang === 'en' ? 'New Chat' : '新对话');
    setSessions((prev) => [newSession, ...prev]);
    setCurrentSessionId(newSession.id);
    setLastMetrics(undefined);
    setInput('');
    setImages([]);
  };

  const handleDeleteSession = (id: string) => {
    // Forbid deleting a session that is actively generating
    if (generatingSessionIds.includes(id)) {
      return;
    }
    setSessions((prev) => {
      const target = prev.find((s) => s.id === id);
      // Lock-down: If this is the last remaining blank session, refuse deletion
      if (prev.length <= 1 && (!target?.messages || target.messages.length === 0)) {
        return prev;
      }

      const filtered = prev.filter((s) => s.id !== id);
      if (filtered.length === 0) {
        const fresh = createNewSession(activeLang === 'en' ? 'New Chat' : '新对话');
        setCurrentSessionId(fresh.id);
        saveCurrentSessionId(fresh.id);
        return [fresh];
      }
      if (currentSessionId === id) {
        const nextId = filtered[0].id;
        setCurrentSessionId(nextId);
        saveCurrentSessionId(nextId);
      }
      return filtered;
    });
  };

  const handleRenameSession = (id: string, newTitle: string) => {
    if (generatingSessionIds.includes(id)) {
      return;
    }
    setSessions((prev) =>
      prev.map((s) => (s.id === id ? { ...s, title: newTitle, updatedAt: Date.now() } : s))
    );
  };

  const handleSaveSettings = (newSettings: AppSettings) => {
    setSettings(newSettings);
    saveSettings(newSettings);
  };

  // Helper to execute chat streaming with given prompt, attachments and history
  const executeChat = async (
    textToSend: string,
    currentImages: string[],
    historyMessages: ChatMessage[],
    targetSessionId: string
  ) => {
    const targetSession = sessions.find((s) => s.id === targetSessionId);
    if (!targetSession) return;

    const abortController = new AbortController();
    abortControllersRef.current.set(targetSessionId, abortController);
    setGeneratingSessionIds((prev) => (prev.includes(targetSessionId) ? prev : [...prev, targetSessionId]));

    // Optional Offline Wiki RAG Retrieval (session-level toggle, defaults to false)
    let promptToSend = textToSend;
    let foundCitations: WikiCitation[] = [];
    let contextOverflow = false;
    const sessionEnableWiki = targetSession.enableWikiSearch ?? false;
    const sessionEnableThinking = targetSession.enableThinking ?? false;

    if (wikiStatus.enabled && sessionEnableWiki && wikiStatus.connected && textToSend) {
      try {
        // 上下文装载预算：按剩余可用上下文估算（中文字符≈1 token），
        // 由后端按检索优先级整篇取舍，绝不从中间截断。
        const usableTokens = Math.max(2000, settings.maxContext - settings.maxTokens);
        const budgetChars = Math.max(4000, Math.floor(usableTokens * 1.5));
        const rag = await WikiAPI.getRagContext(textToSend, budgetChars);
        if (rag.contextOverflow) {
          // 上下文已满，一篇原文都装不下：不注入也不生成，提示用户新开对话
          contextOverflow = true;
        } else if (rag.needsWiki && rag.citations && rag.citations.length > 0) {
          foundCitations = rag.citations;
          const isEn = activeLang === 'en';
          const groundingGuidelines = isEn
            ? `[Encyclopedia Context]\nBelow are one or more encyclopedia articles (Infobox, lead section and relevant body sections) retrieved from an offline knowledge base for the user's question.\n\n${rag.promptContext}\n\n[How to answer]\n1. [Relevance filtering]: The context may contain material that is not related to the question (e.g. infobox fields, section headings, list entries). Locate the parts that actually answer the question and ignore the rest.\n2. [Fact grounding]: Treat the facts, dates, people and numbers found there as your factual anchor. Combine them with your own knowledge when they are partial.\n3. [Reproduce when asked]: If the user asks you to enumerate or list something (e.g. all works, all awards), reproduce the corresponding list from the context faithfully — do not shorten or omit items.\n4. [Cite]: Mention which encyclopedia article(s) you used.\n\n[User Question]\n${textToSend}`
            : `[百科原文参考]\n以下是从离线知识库中检索到的与用户问题相关的百科条目内容（含基本档案、引言与相关小节）。\n\n${rag.promptContext}\n\n[回答指引]\n1. 【自行筛选】：上述原文中可能包含与问题无关的内容（例如档案中用不到的属性、其他小节、列表中的无关条目）。请自行定位其中真正与问题相关的部分，忽略其余。\n2. 【事实锚定】：将其中出现的事实、时间、人物与数据作为真实性基石；若信息不完整，可结合你自身的知识补充展开。\n3. 【按需照抄】：若用户要求列举类内容（例如"列出所有作品/所有奖项"），请忠实照抄原文中的对应列表，不要擅自删减或概括。\n4. 【注明出处】：回答中请说明引用了哪篇百科条目。\n\n[用户问题]\n${textToSend}`;
          promptToSend = groundingGuidelines;
        }
      } catch (err) {
        console.warn('Knowledge Base retrieval error:', err);
      }
    }

    if (abortController.signal.aborted) {
      abortControllersRef.current.delete(targetSessionId);
      setGeneratingSessionIds((prev) => prev.filter((id) => id !== targetSessionId));
      return;
    }

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
      isThinking: sessionEnableThinking,
      timestamp: Date.now(),
      citations: foundCitations.length > 0 ? foundCitations : undefined,
    };

    // Update session title on first message
    const isFirstUserMessage = historyMessages.length === 0;
    const sessionTitle = isFirstUserMessage
      ? textToSend.slice(0, 24) || (activeLang === 'en' ? 'Image Analysis' : '图文分析')
      : targetSession.title || (activeLang === 'en' ? 'New Chat' : '新对话');

    const updatedMessages = [...historyMessages, userMessage, assistantMessage];

    setSessions((prev) =>
      prev.map((s) => {
        if (s.id === targetSessionId) {
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

    let accumulatedReasoning = '';
    let accumulatedContent = '';
    let isThinking = sessionEnableThinking;
    let thinkingDuration = 0;
    const thinkingStartTime = performance.now();

    // 上下文已满：知识库原文一篇都装不下。不调用模型，直接提示用户新开对话。
    if (contextOverflow) {
      const hint =
        activeLang === 'en'
          ? '⚠️ The context window is full, so the knowledge base article could not be loaded. Please start a new conversation and try again.'
          : '⚠️ 当前对话的上下文窗口已满，知识库原文无法装载。请新建一个对话后再试。';
      setSessions((prev) =>
        prev.map((s) => {
          if (s.id !== targetSessionId) return s;
          return {
            ...s,
            messages: s.messages.map((m) => {
              if (m.id !== assistantMsgId) return m;
              return { ...m, content: hint, isThinking: false };
            }),
          };
        })
      );
      abortControllersRef.current.delete(targetSessionId);
      setGeneratingSessionIds((prev) => prev.filter((id) => id !== targetSessionId));
      activeStreamsRef.current.delete(targetSessionId);
      setLiveStreamingTokens((prev) => {
        const next = { ...prev };
        delete next[targetSessionId];
        return next;
      });
      return;
    }

    activeStreamsRef.current.set(targetSessionId, {
      messageId: assistantMsgId,
      reasoningContent: '',
      content: '',
      isThinking,
      thinkingDuration: 0,
    });

    const sessionSettings = {
      ...settings,
      enableThinking: sessionEnableThinking,
      enableWikiSearch: sessionEnableWiki,
    };

    const promptTokensEstimate = estimateHistoryTokens(
      [...historyMessages, { ...userMessage, content: promptToSend }],
      settings.systemPrompt
    );
    setLiveStreamingTokens((prev) => ({ ...prev, [targetSessionId]: promptTokensEstimate }));

    await TurboFieldfareAPI.streamChat(
      [...historyMessages, { ...userMessage, content: promptToSend }],
      sessionSettings,
      {
        onTokenProgress: (liveTokens) => {
          setLiveStreamingTokens((prev) => ({ ...prev, [targetSessionId]: liveTokens }));
          syncChannel?.postMessage({
            type: 'STREAM_TOKEN_PROGRESS',
            sessionId: targetSessionId,
            liveTokens,
            source: 'MAIN',
          });
        },
        onFirstToken: () => {
          // first token received
        },
        onThought: (delta) => {
          const duration = (performance.now() - thinkingStartTime) / 1000;
          accumulatedReasoning += delta;
          isThinking = true;
          thinkingDuration = duration;

          activeStreamsRef.current.set(targetSessionId, {
            messageId: assistantMsgId,
            reasoningContent: accumulatedReasoning,
            content: accumulatedContent,
            isThinking: true,
            thinkingDuration: duration,
          });

          syncChannel?.postMessage({
            type: 'STREAM_CHUNK',
            sessionId: targetSessionId,
            messageId: assistantMsgId,
            reasoningContent: accumulatedReasoning,
            content: accumulatedContent,
            isThinking: true,
            thinkingDuration: duration,
            source: 'MAIN',
          });

          setSessions((prev) =>
            prev.map((s) => {
              if (s.id !== targetSessionId) return s;
              return {
                ...s,
                messages: s.messages.map((m) => {
                  if (m.id !== assistantMsgId) return m;
                  return {
                    ...m,
                    reasoningContent: accumulatedReasoning,
                    isThinking: true,
                    thinkingDuration: duration,
                  };
                }),
              };
            })
          );
        },
        onContent: (delta) => {
          accumulatedContent += delta;
          isThinking = false;

          activeStreamsRef.current.set(targetSessionId, {
            messageId: assistantMsgId,
            reasoningContent: accumulatedReasoning,
            content: accumulatedContent,
            isThinking: false,
            thinkingDuration: thinkingDuration,
          });

          syncChannel?.postMessage({
            type: 'STREAM_CHUNK',
            sessionId: targetSessionId,
            messageId: assistantMsgId,
            reasoningContent: accumulatedReasoning,
            content: accumulatedContent,
            isThinking: false,
            thinkingDuration: thinkingDuration,
            source: 'MAIN',
          });

          setSessions((prev) =>
            prev.map((s) => {
              if (s.id !== targetSessionId) return s;
              return {
                ...s,
                messages: s.messages.map((m) => {
                  if (m.id !== assistantMsgId) return m;
                  return {
                    ...m,
                    content: accumulatedContent,
                    isThinking: false,
                    thinkingDuration: thinkingDuration,
                  };
                }),
              };
            })
          );
        },
        onDone: (metrics) => {
          abortControllersRef.current.delete(targetSessionId);
          activeStreamsRef.current.delete(targetSessionId);
          setGeneratingSessionIds((prev) => prev.filter((id) => id !== targetSessionId));
          setLiveStreamingTokens((prev) => {
            const next = { ...prev };
            delete next[targetSessionId];
            return next;
          });

          if (currentSessionIdRef.current === targetSessionId) {
            setLastMetrics(metrics);
          }

          const cleanHistoryTokens = estimateHistoryTokens(
            [
              ...historyMessages,
              userMessage,
              {
                id: assistantMsgId,
                role: 'assistant',
                content: accumulatedContent,
              },
            ],
            settings.systemPrompt
          );

          syncChannel?.postMessage({
            type: 'STREAM_DONE',
            sessionId: targetSessionId,
            messageId: assistantMsgId,
            reasoningContent: accumulatedReasoning,
            content: accumulatedContent,
            thinkingDuration: thinkingDuration,
            metrics: { ...metrics, contextUsed: cleanHistoryTokens },
            source: 'MAIN',
          });

          setSessions((prev) =>
            prev.map((s) => {
              if (s.id !== targetSessionId) return s;
              return {
                ...s,
                contextUsed: cleanHistoryTokens,
                messages: s.messages.map((m) => {
                  if (m.id !== assistantMsgId) return m;
                  return {
                    ...m,
                    reasoningContent: accumulatedReasoning,
                    content: accumulatedContent,
                    isThinking: false,
                    thinkingDuration: thinkingDuration,
                    metrics,
                  };
                }),
              };
            })
          );
        },
        onError: (err) => {
          abortControllersRef.current.delete(targetSessionId);
          activeStreamsRef.current.delete(targetSessionId);
          setGeneratingSessionIds((prev) => prev.filter((id) => id !== targetSessionId));
          setLiveStreamingTokens((prev) => {
            const next = { ...prev };
            delete next[targetSessionId];
            return next;
          });

          syncChannel?.postMessage({
            type: 'STREAM_DONE',
            sessionId: targetSessionId,
            messageId: assistantMsgId,
            reasoningContent: accumulatedReasoning,
            content: accumulatedContent,
            thinkingDuration: thinkingDuration,
            source: 'MAIN',
          });

          setSessions((prev) =>
            prev.map((s) => {
              if (s.id !== targetSessionId) return s;
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

  // Chat generation handler
  const handleSend = async (overridePrompt?: string) => {
    const textToSend = (overridePrompt ?? input).trim();
    if (!textToSend && images.length === 0) return;

    let targetSessionId = currentSessionId;
    let targetSession = sessions.find((s) => s.id === targetSessionId);

    if (!targetSession) {
      const fresh = createNewSession(activeLang === 'en' ? 'New Chat' : '新对话');
      targetSessionId = fresh.id;
      targetSession = fresh;
      setSessions((prev) => [fresh, ...prev]);
      setCurrentSessionId(fresh.id);
    }

    if (generatingSessionIds.includes(targetSession.id)) return;

    const currentImages = [...images];
    setInput('');
    setImages([]);

    const activeMessages = targetSession.messages || [];
    await executeChat(textToSend, currentImages, activeMessages, targetSession.id);
  };

  // Retry generating an assistant response
  const handleRetry = async (assistantMessageId: string) => {
    const targetSession =
      sessions.find((s) => s.id === currentSessionId) ||
      sessions.find((s) => s.messages.some((m) => m.id === assistantMessageId));
    if (!targetSession) return;

    if (generatingSessionIds.includes(targetSession.id)) {
      handleStop(targetSession.id);
    }

    const asstIdx = targetSession.messages.findIndex((m) => m.id === assistantMessageId);
    if (asstIdx === -1) return;

    let userIdx = -1;
    for (let i = asstIdx - 1; i >= 0; i--) {
      if (targetSession.messages[i].role === 'user') {
        userIdx = i;
        break;
      }
    }
    if (userIdx === -1) return;

    const userMessage = targetSession.messages[userIdx];
    const historyBeforeUser = targetSession.messages.slice(0, userIdx);

    await executeChat(
      userMessage.content,
      userMessage.images || [],
      historyBeforeUser,
      targetSession.id
    );
  };

  // Delete a turn (both question and assistant response)
  const handleDeleteTurn = (assistantMessageId: string) => {
    const targetSession = sessions.find((s) => s.messages.some((m) => m.id === assistantMessageId));
    if (targetSession && generatingSessionIds.includes(targetSession.id)) {
      handleStop(targetSession.id);
    }

    const updatedSessions = sessions.map((s) => {
      const asstIdx = s.messages.findIndex((m) => m.id === assistantMessageId);
      if (asstIdx === -1) return s;

      let userIdx = -1;
      for (let i = asstIdx - 1; i >= 0; i--) {
        if (s.messages[i].role === 'user') {
          userIdx = i;
          break;
        }
      }

      const idsToDelete = new Set<string>([assistantMessageId]);
      if (userIdx !== -1) {
        idsToDelete.add(s.messages[userIdx].id);
      }

      return {
        ...s,
        messages: s.messages.filter((m) => !idsToDelete.has(m.id)),
        updatedAt: Date.now(),
      };
    });

    setSessions(updatedSessions);
    saveSessions(updatedSessions, targetSession?.id, 'MAIN');
  };

  const handleStop = (sessionIdToStop?: string) => {
    const targetId =
      typeof sessionIdToStop === 'string' && sessionIdToStop
        ? sessionIdToStop
        : currentSessionId;
    if (!targetId) return;

    const controller = abortControllersRef.current.get(targetId);
    if (controller) {
      controller.abort();
      abortControllersRef.current.delete(targetId);
    }
    activeStreamsRef.current.delete(targetId);
    setGeneratingSessionIds((prev) => prev.filter((id) => id !== targetId));
    setLiveStreamingTokens((prev) => {
      const next = { ...prev };
      delete next[targetId];
      return next;
    });

    syncChannel?.postMessage({
      type: 'STREAM_ABORT',
      sessionId: targetId,
      source: 'MAIN',
    });
  };

  const handleShrinkToSpotlight = () => {
    // 1. Ensure current session state is saved in storage
    if (sessions.length > 0) {
      saveSessions(sessions, currentSessionId || undefined, 'MAIN');
    }
    if (currentSessionId) {
      saveCurrentSessionId(currentSessionId);
    }

    // 2. Notify Spotlight via syncChannel to load this session
    syncChannel?.postMessage({
      type: 'LOAD_SESSION_IN_SPOTLIGHT',
      sessionId: currentSessionId,
    });

    // 3. Ask native macOS container to show Spotlight with this session and hide Main Window
    // @ts-expect-error WebKit bridge
    if (window.webkit?.messageHandlers?.shrinkToSpotlight) {
      // @ts-expect-error WebKit bridge
      window.webkit.messageHandlers.shrinkToSpotlight.postMessage({
        sessionId: currentSessionId,
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
            setCurrentSessionId(id);
          }}
          onNewSession={handleNewSession}
          onDeleteSession={handleDeleteSession}
          onRenameSession={handleRenameSession}
          onOpenSettings={() => setIsSettingsOpen(true)}
          healthInfo={healthInfo}
          wikiStatus={wikiStatus}
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
            setSessions((prev) =>
              prev.map((s) => (s.id === currentSessionId ? { ...s, enableThinking: val, updatedAt: Date.now() } : s))
            );
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
          enableWikiSearch={currentSession?.enableWikiSearch ?? false}
          setEnableWikiSearch={(val) => {
            if (!currentSessionId) return;
            setSessions((prev) =>
              prev.map((s) => (s.id === currentSessionId ? { ...s, enableWikiSearch: val, updatedAt: Date.now() } : s))
            );
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
      </div>
    </I18nProvider>
  );
};
