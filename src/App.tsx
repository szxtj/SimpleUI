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
import { WikiDrawer } from './components/WikiDrawer';
import { I18nProvider, resolveLanguage } from './i18n';
import { useTheme } from './hooks/useTheme';

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
    connected: false,
    port: 31236,
    zimPath: null,
    contentId: null,
    bookTitle: 'Knowledge Base',
    articleCount: 0,
    mediaCount: 0,
  });
  const [activeWikiArticle, setActiveWikiArticle] = useState<string | null>(null);

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
            setSessions((prev) =>
              prev.map((s) =>
                s.id === sessionId
                  ? {
                      ...s,
                      contextUsed: metrics?.contextUsed ?? s.contextUsed,
                      messages: s.messages.map((m) =>
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
                      ),
                    }
                  : s
              )
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
          } else {
            abortControllersRef.current.forEach((controller) => controller.abort());
            abortControllersRef.current.clear();
            activeStreamsRef.current.clear();
            setGeneratingSessionIds([]);
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

  // Current session helper
  const currentSession = sessions.find((s) => s.id === currentSessionId);
  const messages = currentSession?.messages || [];
  const usedTokens = currentSession?.contextUsed || 0;

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
    const sessionEnableWiki = targetSession.enableWikiSearch ?? false;
    const sessionEnableThinking = targetSession.enableThinking ?? false;

    if (sessionEnableWiki && wikiStatus.connected && textToSend) {
      try {
        const rag = await WikiAPI.getRagContext(textToSend);
        if (rag.needsWiki && rag.citations && rag.citations.length > 0) {
          foundCitations = rag.citations;
          const isEn = activeLang === 'en';
          const groundingGuidelines = isEn
            ? `[Background Reference Facts]\n${rag.promptContext}\n\n[Instruction & Guidelines]\nPlease answer the user's question based on the following principles:\n1. [Fact Grounding]: Use the objective facts, dates, and numbers provided in the [Background Reference Facts] as your factual anchor.\n2. [Deep Reasoning & Synthesis]: The facts serve as your baseline; please fully unleash your analytical reasoning, logical synthesis, and broad world knowledge to provide an in-depth, structured, and insightful response.\n3. [Natural & Expressive]: Keep the tone natural, clear, and articulate. Do not mechanically copy the source verbatim.\n\n[User Question]\n${textToSend}`
            : `[背景事实参考]\n${rag.promptContext}\n\n[回答指引与准则]\n请按以下原则回答用户问题：\n1. 【事实锚定】：优先将上述[背景事实参考]中提及的客观事实、时间、人物与数据作为真实性基石。\n2. 【深度推导与发散】：参考事实仅作为基础支撑，请充分发挥你的深度逻辑分析、综合归纳与通用常识储备。若事实仅为局部信息，鼓励主动进行深层推论、背景对比与全面展开。\n3. 【自然生动】：保持自然清晰、有深度的表达风格，严禁机械式照抄或受限于参考资料的行文。\n\n[用户问题]\n${textToSend}`;
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

    await TurboFieldfareAPI.streamChat(
      [...historyMessages, { ...userMessage, content: promptToSend }],
      sessionSettings,
      {
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

          if (currentSessionIdRef.current === targetSessionId) {
            setLastMetrics(metrics);
          }

          syncChannel?.postMessage({
            type: 'STREAM_DONE',
            sessionId: targetSessionId,
            messageId: assistantMsgId,
            reasoningContent: accumulatedReasoning,
            content: accumulatedContent,
            thinkingDuration: thinkingDuration,
            metrics,
            source: 'MAIN',
          });

          setSessions((prev) =>
            prev.map((s) => {
              if (s.id !== targetSessionId) return s;
              return {
                ...s,
                contextUsed: metrics.contextUsed,
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
          onOpenWiki={(title) => setActiveWikiArticle(title)}
          onRetry={handleRetry}
          onDelete={handleDeleteTurn}
          onShrinkToSpotlight={handleShrinkToSpotlight}
        />

        {/* Wikipedia Offline Article Reader Drawer */}
        <WikiDrawer
          isOpen={!!activeWikiArticle}
          title={activeWikiArticle}
          onClose={() => setActiveWikiArticle(null)}
          theme={settings.theme}
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
