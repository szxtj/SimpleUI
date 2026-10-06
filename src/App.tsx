import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { Sidebar } from './components/Sidebar';
import { ChatView } from './components/ChatView';
import { SettingsModal } from './components/SettingsModal';
import { ServiceManagerModal } from './components/ServiceManagerModal';
import {
  ChatSession,
  ChatMessage,
  AppSettings,
  ServerHealthInfo,
  TurnMetrics,
  WikiCitation,
  WikiStatusInfo,
  TurnStageRecord,
  AsrServiceStatus,
} from './types/chat';
import {
  loadSessions,
  saveSessions,
  loadCurrentSessionId,
  saveCurrentSessionId,
  loadSettings,
  saveSettings,
  DEFAULT_LOCAL_CONFIG,
  DEFAULT_DEEPSEEK_CONFIG,
  createNewSession,
  getOrCreateEmptySession,
  clearStalePending,
  requestAbort,
  readAbortRequest,
  notifySessionUpdate,
  syncChannel,
  hydrateSessionImages,
  generateSessionTitle,
  deriveSessionTitleFromMessages,
} from './services/storage';
import { TurboFieldfareAPI, WikiAPI, ASRServiceAPI, ModelServiceAPI } from './services/api';
import type { ModelServiceStatus } from './services/api';
import {
  buildPromptWithWiki,
  buildTurnMessages,
  buildWireMessages,
  buildSessionSettings,
} from './services/chatTurn';
import { SpotlightView } from './components/SpotlightView';
import { VoiceOverlay } from './components/VoiceOverlay';
import { WikiSidebar } from './components/WikiSidebar';
import { I18nProvider, resolveLanguage } from './i18n';
import { useTheme } from './hooks/useTheme';
import { estimateHistoryTokens, applyTokenCalibration } from './utils/token';
import { deleteUnreferencedMedia, triggerMediaGC } from './services/mediaCleanup';

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

  // 语音输入桥：原生侧在「焦点在本 App 自身输入框」时调用，把转写结果插入当前光标处。
  // 因输入框是受控组件，需用原生 value setter + 派发 input 事件触发 React onChange。
  useEffect(() => {
    const w = window as any;
    w.__insertVoiceText = (text: string) => {
      if (!text) return;
      const isEditable = (el: Element | null): el is HTMLElement =>
        !!el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || (el as HTMLElement).isContentEditable);

      // 优先插入当前焦点输入框；焦点不在输入框时回退到聊天输入框
      // （在本 App 内长按右 ⌘ 说话，通常就是想往聊天框里写）
      let field = document.activeElement as HTMLElement | null;
      if (!isEditable(field)) {
        const fallback = document.querySelector<HTMLElement>('[data-chat-input]');
        if (fallback) {
          fallback.focus();
          field = fallback;
        }
      }
      if (!isEditable(field)) return;

      // contentEditable：在当前选区插入文本（当前 App 无此场景，作通用兜底）
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

      const input = field as HTMLTextAreaElement & HTMLInputElement;
      const start = input.selectionStart ?? input.value.length;
      const end = input.selectionEnd ?? start;
      const next = input.value.slice(0, start) + text + input.value.slice(end);
      const proto = field.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      const desc = Object.getOwnPropertyDescriptor(proto, 'value') || Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value');
      if (desc?.set) desc.set.call(input, next);
      else input.value = next;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      const pos = start + text.length;
      try {
        input.setSelectionRange(pos, pos);
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

  useTheme(settings.theme, isSpotlight || isVoiceOverlay);

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

  const [sessions, setSessions] = useState<ChatSession[]>(() => {
    const loaded = loadSessions();
    const safe = loaded.length > 0 ? loaded : [createNewSession()];
    // App 启动时清掉「被中断的回合」残留的 pending（生成中被退出/强杀）：
    // 否则阶段阶梯会永远停在"假进行中"的展开态。
    if (clearStalePending(safe)) {
      try {
        saveSessions(safe, undefined, 'MAIN');
      } catch {
        // 回写失败不影响本次会话
      }
    }
    return safe;
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
  /** 服务管理界面（三项受管服务的启停与参数，与设置界面并列的独立入口） */
  const [isServiceManagerOpen, setIsServiceManagerOpen] = useState(false);
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

  const abortControllersRef = useRef<Map<string, AbortController>>(new Map());
  /** 本轮阶段阶梯记录的最新快照：随流式广播带给镜像窗口（浮窗），使它也能实时长出阶梯行 */
  const stagesRef = useRef<TurnStageRecord[]>([]);
  const activeStreamsRef = useRef<Map<string, {
    messageId: string;
    reasoningContent: string;
    content: string;
    isThinking: boolean;
    thinkingDuration: number;
    /** 该回合是否仍处于「检索 / 载入上下文」阶段（首个 token 前为 true） */
    pending: boolean;
  }>>(new Map());
  const isSyncingRef = useRef(false);
  const generatingSessionIdsRef = useRef<string[]>([]);
  const currentSessionIdRef = useRef<string | null>(currentSessionId);
  const sessionsRef = useRef<ChatSession[]>(sessions);
  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

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
    const loaded = loadSessions();
    // Safety guard: If storage returns empty or blank default chat, but in-memory state
    // has active conversation messages, DO NOT overwrite memory with empty!
    const memoryHasContent = sessionsRef.current.some(
      (s) => s.messages && s.messages.length > 0
    );
    const loadedHasContent = loaded.some(
      (s) => s.messages && s.messages.length > 0
    );
    if (!loadedHasContent && memoryHasContent) {
      saveSessions(sessionsRef.current, currentSessionIdRef.current || undefined, 'MAIN');
      return;
    }

    const safeLoaded = loaded.length > 0 ? loaded : [createNewSession()];

    // Merge: for any session that is actively generating, preserve its latest in-memory messages
    // so incoming live stream chunks are never rolled back or lost.
    const mergedSessions = safeLoaded.map((s) => {
      if (generatingSessionIdsRef.current.includes(s.id)) {
        const inMem = sessionsRef.current.find((m) => m.id === s.id);
        if (inMem && inMem.messages.length > 0) {
          return {
            ...s,
            messages: inMem.messages,
          };
        }
      }
      return s;
    });

    // Also include any generating session that might exist in memory but not yet flushed to disk
    for (const inMem of sessionsRef.current) {
      if (generatingSessionIdsRef.current.includes(inMem.id) && !mergedSessions.some((s) => s.id === inMem.id)) {
        mergedSessions.unshift(inMem);
      }
    }

    isSyncingRef.current = true;
    setSessions(mergedSessions);
    const savedId = loadCurrentSessionId();
    if (savedId && mergedSessions.some((s) => s.id === savedId)) {
      setCurrentSessionId(savedId);
    } else if (!currentSessionIdRef.current || !mergedSessions.some((s) => s.id === currentSessionIdRef.current)) {
      setCurrentSessionId(mergedSessions[0].id);
      saveCurrentSessionId(mergedSessions[0].id);
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
            const { sessionId, messageId, reasoningContent, content, isThinking, thinkingDuration, stage, pending, citations, stages: incomingStages } = data;
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
                          // 浮窗的阶段机同步：rag/prefill 转换与 pending 清理由广播驱动，
                          // 主窗口据此显示同一套阶段指示器与"停止"按钮
                          ...(stage !== undefined ? { stage } : {}),
                          ...(pending !== undefined ? { pending } : {}),
                          // 引用胶囊随载荷同步（浮窗 RAG 完成即已知）
                          ...(citations !== undefined ? { citations } : {}),
                          // 阶段阶梯记录随载荷同步：镜像窗口的行数/耗时与生成方实时一致
                          ...(incomingStages !== undefined ? { stages: incomingStages } : {}),
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
        } else if (data.type === 'STAGES_CHANGED') {
          // 镜像窗口（浮窗）的阶段阶梯记录：实时并入本窗口消息
          if (data.source !== 'MAIN' && data.sessionId && data.messageId) {
            setSessions((prev) =>
              prev.map((s) =>
                s.id !== data.sessionId
                  ? s
                  : {
                      ...s,
                      messages: s.messages.map((m) => (m.id === data.messageId ? { ...m, stages: data.stages } : m)),
                    }
              )
            );
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
                        // 生成结束：prefill 指示器必须撤下（兜底）
                        pending: false,
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
            // Also defensively clear pending / isThinking and sync from storage if placeholder was deleted
            const all = loadSessions();
            const sFromDisk = all.find((s) => s.id === targetId);
            setSessions((prev) =>
              prev.map((s) => {
                if (s.id !== targetId) return s;
                if (sFromDisk) return sFromDisk;
                return {
                  ...s,
                  messages: s.messages.map((m) =>
                    m.pending || m.isThinking ? { ...m, pending: false, isThinking: false } : m
                  ),
                };
              })
            );
          } else {
            abortControllersRef.current.forEach((controller) => controller.abort());
            abortControllersRef.current.clear();
            activeStreamsRef.current.clear();
            setGeneratingSessionIds([]);
            setLiveStreamingTokens({});
            setSessions((prev) =>
              prev.map((s) => ({
                ...s,
                messages: s.messages.map((m) =>
                  m.pending || m.isThinking ? { ...m, pending: false, isThinking: false } : m
                ),
              }))
            );
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
              // 用真实状态：回合刚开始就登记了（此时 pending=true），
              // 硬编码 false 会让浮窗在检索/载入阶段误判成"阶段已结束"
              pending: stream.pending,
              stages: stagesRef.current,
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
      } else if (e.key === 'tff_abort_request_v1') {
        // 浮窗点了「停止」：本窗口若正持有该回合，就地中止
        const req = readAbortRequest();
        if (req) handleStop(req.sessionId);
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

  // Poll 基础模型服务状态（左下角服务行）。
  // 用 /api/model/status 而不是 /health 探测：前者带 status 字段，能区分
  // running / loading / stopped，左下角才能显示黄灯「启动中」。
  useEffect(() => {
    const checkModel = async () => {
      const status = await ModelServiceAPI.getStatus();
      setModelStatus(status);
    };
    checkModel();
    const modelTimer = setInterval(checkModel, 6000);
    return () => clearInterval(modelTimer);
  }, []);

  /**
   * 阶段阶梯记录回写（由 StageLadder 在生成期间回调，一轮只写几次，开销可忽略）。
   *
   * 两步都做：① 更新本窗口状态；② **立即落盘 + 广播**——阶梯记录挂在消息上，
   * 落盘后另一窗口（浮窗）会通过 SESSIONS_CHANGED 镜像过来，退出 App 再打开也还在。
   */
  const handleStagesChange = useCallback((messageId: string, stages: TurnStageRecord[]) => {
    const sid = currentSessionIdRef.current;
    if (!sid) return;
    stagesRef.current = stages; // 供流式广播携带（镜像窗口据此实时长出阶梯行）
    // 阶段可能发生在"一个 token 都还没有"的检索/载入阶段——那时没有 STREAM_CHUNK，
    // 所以专门广播一条 STAGES_CHANGED，保证镜像窗口实时长出同样的阶梯行。
    try {
      syncChannel?.postMessage({ type: 'STAGES_CHANGED', sessionId: sid, messageId, stages, source: 'MAIN' });
    } catch {
      // 广播失败不影响本窗口
    }
    setSessions((prev) =>
      prev.map((s) =>
        s.id !== sid
          ? s
          : { ...s, messages: s.messages.map((m) => (m.id === messageId ? { ...m, stages } : m)) }
      )
    );
    try {
      const all = loadSessions();
      const idx = all.findIndex((s) => s.id === sid);
      if (idx >= 0) {
        all[idx] = {
          ...all[idx],
          messages: all[idx].messages.map((m) => (m.id === messageId ? { ...m, stages } : m)),
        };
        saveSessions(all, sid, 'MAIN');
      }
    } catch {
      // 落盘失败不影响本窗口显示
    }
  }, []);

  const lastSaveTimeRef = useRef(0);
  const saveTimeoutRef = useRef<any>(null);

  // Save sessions on change only when not syncing from outside (throttled during generation)
  useEffect(() => {
    if (sessions.length === 0 || isSyncingRef.current) return;

    const isGeneratingNow = generatingSessionIdsRef.current.length > 0;
    if (isGeneratingNow) {
      const now = Date.now();
      if (now - lastSaveTimeRef.current < 300) {
        if (!saveTimeoutRef.current) {
          saveTimeoutRef.current = setTimeout(() => {
            saveTimeoutRef.current = null;
            lastSaveTimeRef.current = Date.now();
            saveSessions(sessionsRef.current, currentSessionIdRef.current || undefined, 'MAIN');
          }, 300);
        }
        return;
      }
      lastSaveTimeRef.current = now;
      saveSessions(sessions, currentSessionIdRef.current || undefined, 'MAIN');
    } else {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
        saveTimeoutRef.current = null;
      }
      saveSessions(sessions, currentSessionIdRef.current || undefined, 'MAIN');
    }
  }, [sessions]);

  // Save current session ID on change
  useEffect(() => {
    if (!isSyncingRef.current) {
      saveCurrentSessionId(currentSessionId);
    }
  }, [currentSessionId]);

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
      triggerMediaGC(loadSessions());
    }, 3000);
    return () => clearTimeout(timer);
  }, []);

  // Current session helper
  const currentSession = sessions.find((s) => s.id === currentSessionId);
  const messages = currentSession?.messages || [];

  // Persistent conversation history baseline tokens (excluding temporary RAG prompts & reasoning tokens)
  const persistentHistoryTokens = useMemo(() => {
    if (!messages || messages.length === 0) return 0;
    // 展示层施加校准系数（系数由上一轮真实 usage.prompt_tokens 反推）
    return applyTokenCalibration(estimateHistoryTokens(messages, settings.systemPrompt));
  }, [messages, settings.systemPrompt]);

  const currentLiveTokens = currentSessionId ? liveStreamingTokens[currentSessionId] : undefined;
  const usedTokens = (isGenerating && currentLiveTokens !== undefined) ? currentLiveTokens : persistentHistoryTokens;

  // Hydrate any offloaded images from IndexedDB for the current session
  useEffect(() => {
    if (!currentSession) return;
    const hasOffloadedImages = currentSession.messages?.some((m) =>
      m.images?.some((img) => img.startsWith('__idb__:'))
    );
    if (hasOffloadedImages) {
      hydrateSessionImages(currentSession).then((changed) => {
        if (changed) {
          setSessions((prev) =>
            prev.map((s) => (s.id === currentSession.id ? { ...currentSession } : s))
          );
        }
      });
    }
  }, [currentSessionId]);

  // Session management handlers
  const handleNewSession = () => {
    const { session, allSessions, isNew } = getOrCreateEmptySession(
      activeLang === 'en' ? 'New Chat' : '新对话',
      'MAIN'
    );
    if (isNew) {
      setSessions(allSessions);
    }
    setCurrentSessionId(session.id);
    setLastMetrics(undefined);
    setInput('');
    setImages([]);
  };

  const handleDeleteSession = (id: string) => {
    // Forbid deleting a session that is actively generating
    if (generatingSessionIds.includes(id)) {
      return;
    }
    const target = sessions.find((s) => s.id === id);
    // Lock-down: If this is the last remaining blank session, refuse deletion
    if (sessions.length <= 1 && (!target?.messages || target.messages.length === 0)) {
      return;
    }

    const deletedImages: string[] = [];
    target?.messages?.forEach((m) => {
      if (m.images) deletedImages.push(...m.images);
    });

    setSessions((prev) => {
      const filtered = prev.filter((s) => s.id !== id);
      if (filtered.length === 0) {
        const fresh = createNewSession(activeLang === 'en' ? 'New Chat' : '新对话');
        setCurrentSessionId(fresh.id);
        saveCurrentSessionId(fresh.id);
        deleteUnreferencedMedia(deletedImages, [fresh]);
        return [fresh];
      }
      if (currentSessionId === id) {
        const nextId = filtered[0].id;
        setCurrentSessionId(nextId);
        saveCurrentSessionId(nextId);
      }
      deleteUnreferencedMedia(deletedImages, filtered);
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

  /**
   * 服务管理界面里改了基础模型监听端口后，同步本地的请求端口并立即持久化。
   * 否则用户改完端口直接关弹窗，对话请求（x-target-port）会打不到服务。
   */
  const handleServiceApiPortChange = (port: number) => {
    setSettings((prev) => {
      const nextLocal = { ...(prev.localConfig || DEFAULT_LOCAL_CONFIG), apiPort: port };
      const updated = { ...prev, apiPort: port, localConfig: nextLocal };
      saveSettings(updated);
      return updated;
    });
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
    stagesRef.current = []; // 新一轮：清空阶段快照
    setGeneratingSessionIds((prev) => (prev.includes(targetSessionId) ? prev : [...prev, targetSessionId]));

    // 会话级开关（DeepSeek模式下禁用知识库）
    const isDeepSeek = settings.apiProvider === 'deepseek';
    const sessionEnableWiki = isDeepSeek ? false : (targetSession.enableWikiSearch ?? false);
    const sessionEnableThinking = targetSession.enableThinking ?? false;

    // 占位消息：DeepSeek模式直接进入prefill；本地模式先进入stage='rag'
    const { userMessage, assistantMessage } = buildTurnMessages({
      historyMessages,
      textToSend,
      images: currentImages,
      enableThinking: sessionEnableThinking,
      isDeepSeek,
    });
    const assistantMsgId = assistantMessage.id;

    // Update session title on first message
    const isFirstUserMessage = historyMessages.length === 0;
    const defaultTitle = activeLang === 'en' ? 'New Chat' : '新对话';
    const computedTitle = generateSessionTitle(textToSend, currentImages.length > 0, defaultTitle);
    const sessionTitle = isFirstUserMessage
      ? computedTitle
      : (!targetSession.title || targetSession.title === '新对话' || targetSession.title === 'New Chat')
      ? (historyMessages.length > 0 ? deriveSessionTitleFromMessages(historyMessages, defaultTitle) : computedTitle)
      : targetSession.title;

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

    // 离线维基 RAG：检索 + Grounding Prompt 包装（DeepSeek 模式自动跳过）。
    let ragResult: { promptToSend: string; citations: WikiCitation[] };
    try {
      ragResult = await buildPromptWithWiki({
        textToSend,
        lang: activeLang,
        wikiMasterEnabled: wikiStatus.enabled,
        sessionEnableWiki,
        wikiConnected: wikiStatus.connected,
        isDeepSeek,
        signal: abortController.signal,
      });
    } catch (e) {
      if ((e as Error).name === 'AbortError' || abortController.signal.aborted) {
        // 检索期间被叫停：撤下本轮占位消息，无任何后续调用
        abortControllersRef.current.delete(targetSessionId);
        setGeneratingSessionIds((prev) => prev.filter((id) => id !== targetSessionId));
        setSessions((prev) =>
          prev.map((s) =>
            s.id === targetSessionId
              // 只撤下助理占位消息，**保留用户的提问**（整轮删除会让会话变空 → 被当成新对话）
              ? { ...s, messages: s.messages.filter((m) => m.id !== assistantMsgId) }
              : s
          )
        );
        // 明确通知浮窗"已停止"，否则镜像侧会一直停在生成中
        syncChannel?.postMessage({ type: 'STREAM_ABORT', sessionId: targetSessionId, source: 'MAIN' });
        return;
      }
      throw e;
    }
    const { promptToSend, citations: foundCitations } = ragResult;

    if (abortController.signal.aborted) {
      // 检索期间被叫停：撤下本轮占位消息
      abortControllersRef.current.delete(targetSessionId);
      setGeneratingSessionIds((prev) => prev.filter((id) => id !== targetSessionId));
      setSessions((prev) =>
        prev.map((s) =>
          s.id === targetSessionId
            // 同上：只撤占位消息，保留提问
            ? { ...s, messages: s.messages.filter((m) => m.id !== assistantMsgId) }
            : s
        )
      );
      syncChannel?.postMessage({ type: 'STREAM_ABORT', sessionId: targetSessionId, source: 'MAIN' });
      return;
    }

    // RAG 解析完成 → 进入 prefill 阶段；引用胶囊数据此时才确定，一并挂上
    setSessions((prev) =>
      prev.map((s) =>
        s.id === targetSessionId
          ? {
              ...s,
              messages: s.messages.map((m) =>
                m.id === assistantMsgId
                  ? {
                      ...m,
                      stage: 'prefill',
                      // 估算百分比以此为计时起点：RAG 阶段的等待不计入 prefill
                      prefillStartedAt: Date.now(),
                      citations: foundCitations.length > 0 ? foundCitations : undefined,
                    }
                  : m
              ),
            }
          : s
      )
    );

    let accumulatedReasoning = '';
    let accumulatedContent = '';
    // prefill 阶段不算"思考中"——首个思考 token 到达（onThought）后才置 true
    let isThinking = false;
    let thinkingDuration = 0;
    const thinkingStartTime = performance.now();

    activeStreamsRef.current.set(targetSessionId, {
      messageId: assistantMsgId,
      reasoningContent: '',
      content: '',
      isThinking,
      thinkingDuration: 0,
      pending: true, // 尚未收到任何 token：仍处于检索/载入阶段
    });

    const sessionSettings = buildSessionSettings(settings, sessionEnableThinking, sessionEnableWiki);
    const wireMessages = buildWireMessages(historyMessages, userMessage, promptToSend);

    const promptTokensEstimate = applyTokenCalibration(
      estimateHistoryTokens(wireMessages, settings.systemPrompt)
    );
    setLiveStreamingTokens((prev) => ({ ...prev, [targetSessionId]: promptTokensEstimate }));

    await TurboFieldfareAPI.streamChat(
      wireMessages,
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
          // 首个 token 到达：prefill 结束，撤下"载入上下文"指示
          setSessions((prev) =>
            prev.map((s) =>
              s.id === targetSessionId
                ? {
                    ...s,
                    messages: s.messages.map((m) =>
                      m.id === assistantMsgId ? { ...m, pending: false } : m
                    ),
                  }
                : s
            )
          );
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
            pending: false, // 已有 token：阶段结束
          });

          syncChannel?.postMessage({
            type: 'STREAM_CHUNK',
            sessionId: targetSessionId,
            messageId: assistantMsgId,
            reasoningContent: accumulatedReasoning,
            content: accumulatedContent,
            isThinking: true,
            thinkingDuration: duration,
            // 首个 token 已到达 → 检索/prefill 阶段结束：把 pending 一并广播，
            // 否则镜像窗口（浮窗）会一直停在"阶段进行中"的展开态。
            pending: false,
            stages: stagesRef.current,
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
            pending: false, // 已有 token：阶段结束
          });

          syncChannel?.postMessage({
            type: 'STREAM_CHUNK',
            sessionId: targetSessionId,
            messageId: assistantMsgId,
            reasoningContent: accumulatedReasoning,
            content: accumulatedContent,
            isThinking: false,
            thinkingDuration: thinkingDuration,
            // 同上：正文已开始 → 阶段结束，镜像窗口同步收起阶段阶梯
            pending: false,
            stages: stagesRef.current,
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

    const deletedTurnImages: string[] = [];

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
        if (s.messages[userIdx].images) {
          deletedTurnImages.push(...s.messages[userIdx].images!);
        }
      }

      return {
        ...s,
        messages: s.messages.filter((m) => !idsToDelete.has(m.id)),
        updatedAt: Date.now(),
      };
    });

    setSessions(updatedSessions);
    saveSessions(updatedSessions, targetSession?.id, 'MAIN');
    deleteUnreferencedMedia(deletedTurnImages, updatedSessions);
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

    // Also defensively clear pending and isThinking in this session's messages
    setSessions((prev) =>
      prev.map((s) => {
        if (s.id !== targetId) return s;
        return {
          ...s,
          messages: s.messages.map((m) =>
            m.pending || m.isThinking ? { ...m, pending: false, isThinking: false } : m
          ),
        };
      })
    );

    // BroadcastChannel 不一定能跨两个 WKWebView 投递，中止请求额外走一次 localStorage
    requestAbort(targetId);
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
    const targetSession = sessions.find((s) => s.id === currentSessionId);
    syncChannel?.postMessage({
      type: 'LOAD_SESSION_IN_SPOTLIGHT',
      sessionId: currentSessionId,
      session: targetSession,
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
          ownsTurn={isGenerating}
          onStagesChange={handleStagesChange}
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
            // 立即广播，保证 Spotlight 浮窗同步到同一会话的同名开关
            notifySessionUpdate(currentSessionId, 'MAIN');
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
            // 立即广播，保证 Spotlight 浮窗同步到同一会话的同名开关
            notifySessionUpdate(currentSessionId, 'MAIN');
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
