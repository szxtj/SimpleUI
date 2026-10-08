import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  ChatMessage,
  AppSettings,
  ServerHealthInfo,
  WikiStatusInfo,
  WikiCitation,
  TurnStageRecord,
} from '../types/chat';
import {
  loadSettings,
  readAbortRequest,
  requestAbort,
  loadSessions,
  saveSessions,
  loadCurrentSessionId,
  saveCurrentSessionId,
  getOrCreateEmptySession,
  notifySessionUpdate,
  syncChannel,
  hydrateSessionImages,
  generateSessionTitle,
  deriveSessionTitleFromMessages,
} from '../services/storage';
import { TurboFieldfareAPI, WikiAPI } from '../services/api';
import {
  buildPromptWithWiki,
  buildTurnMessages,
  buildWireMessages,
  buildSessionSettings,
  getActiveContextMessages,
} from '../services/chatTurn';
import { MarkdownRenderer } from './MarkdownRenderer';
import { ThinkingAccordion } from './ThinkingAccordion';
import { StageLadder } from './StageLadder';
import { ImageAttachment } from './ImageAttachment';
import { ContextRing } from './ContextRing';
import { WikiDrawer } from './WikiDrawer';
import { extractImagesFromPaste, fileToDataURL, isImageFile } from '../utils/image';
import { deleteUnreferencedMedia } from '../services/mediaCleanup';
import { useImeInput } from '../hooks/useImeInput';
import {
  ArrowUp,
  Square,
  Plus,
  Zap,
  Brain,
  BookOpen,
  Search,
  Copy,
  Check,
  Maximize2,
  X,
  MessageSquarePlus,
  RotateCcw,
  Trash2,
  ExternalLink,
  FileText,
} from 'lucide-react';
import { RawMarkdownModal } from './RawMarkdownModal';
import { useI18n } from '../i18n';
import { useTheme } from '../hooks/useTheme';
import { useFollowBottom } from '../hooks/useFollowBottom';
import { estimateHistoryTokens, applyTokenCalibration } from '../utils/token';

export const SpotlightView: React.FC = () => {
  const { t, lang } = useI18n();
  const [settings, setSettings] = useState<AppSettings>(loadSettings());
  useTheme(settings.theme, true);
  const [input, setInput] = useState('');
  const [images, setImages] = useState<string[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [healthInfo, setHealthInfo] = useState<ServerHealthInfo>({
    status: 'connecting',
    vision: 'missing',
    online: false,
  });
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
  const [usedTokens, setUsedTokens] = useState<number>(0);
  const [liveStreamingTokens, setLiveStreamingTokens] = useState<number | null>(null);

  // Clean persistent conversation history tokens (user text + assistant text only)
  const persistentHistoryTokens = React.useMemo(() => {
    if (!messages || messages.length === 0) return 0;
    const activeMessages = getActiveContextMessages(messages, {
      systemPrompt: settings.systemPrompt,
      maxContext: settings.maxContext,
      maxTokens: settings.maxTokens,
      provider: settings.apiProvider,
    });
    // 展示层施加校准系数（与主窗口同一套系数）
    return applyTokenCalibration(
      estimateHistoryTokens(activeMessages, settings.systemPrompt, settings.apiProvider),
      settings.apiProvider
    );
  }, [messages, settings.systemPrompt, settings.maxContext, settings.maxTokens, settings.apiProvider]);

  const displayTokens = (isGenerating && liveStreamingTokens !== null) ? liveStreamingTokens : persistentHistoryTokens;
  const [copiedMsgId, setCopiedMsgId] = useState<string | null>(null);
  const [activeWikiArticle, setActiveWikiArticle] = useState<string | null>(null);
  const [activeWikiContext, setActiveWikiContext] = useState<string | null>(null);
  /** 小窗口「搜索」按钮打开的知识库面板（与大窗口侧边栏等价，见 openWikiPanel） */
  const [isWikiPanelOpen, setIsWikiPanelOpen] = useState(false);
  /** 弹出显示原 Markdown 文本的目标内容 */
  const [rawMarkdownTarget, setRawMarkdownTarget] = useState<string | null>(null);
  const activeSessionIdRef = useRef<string | null>(null);
  const isGeneratingRef = useRef(false);
  const messagesRef = useRef<ChatMessage[]>(messages);
  const inputRef = useRef('');
  const settingsRef = useRef<AppSettings>(settings);
  const currentAsstMsgIdRef = useRef<string | null>(null);
  const accumulatedThoughtRef = useRef('');
  const accumulatedContentRef = useRef('');
  const thinkingStartTimeRef = useRef(0);
  /** 本轮阶段阶梯记录快照：随流式广播带给镜像窗口（主窗口） */
  const stagesRef = useRef<TurnStageRecord[]>([]);

  // Conversation-level toggles (both default to FALSE / OFF as requested)
  const [enableThinking, setEnableThinking] = useState(false);
  const [enableWikiSearch, setEnableWikiSearch] = useState(false);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const cursorPositionRef = useRef<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const generatingSessionIdRef = useRef<string | null>(null);
  const scrollEndRef = useRef<HTMLDivElement>(null);
  const prevMessagesLengthRef = useRef(messages.length);
  const prevFirstMsgIdRef = useRef(messages[0]?.id);

  /**
   * 阶段阶梯记录回写（仅浮窗自己生成的回合会调用）。
   * 与主窗口同一条路径：① 更新本窗口消息；② 立即落盘 + 广播（主窗口镜像 / 退出重开都在）。
   */
  const handleStagesChange = useCallback((messageId: string, stages: TurnStageRecord[]) => {
    stagesRef.current = stages;
    setMessages((prev) => prev.map((m) => (m.id === messageId ? { ...m, stages } : m)));
    // 检索/载入阶段没有任何 token → 不会有 STREAM_CHUNK，专门广播阶段变化给主窗口
    const curSid = generatingSessionIdRef.current || activeSessionIdRef.current;
    try {
      syncChannel?.postMessage({
        type: 'STAGES_CHANGED',
        sessionId: curSid,
        messageId,
        stages,
        source: 'SPOTLIGHT',
      });
    } catch {
      // 广播失败不影响本窗口
    }
    try {
      if (!curSid) return;
      const all = loadSessions();
      const idx = all.findIndex((s) => s.id === curSid);
      if (idx < 0) return;
      all[idx] = {
        ...all[idx],
        messages: all[idx].messages.map((m) => (m.id === messageId ? { ...m, stages } : m)),
      };
      saveSessions(all, curSid, 'SPOTLIGHT');
    } catch {
      // 落盘失败不影响本窗口显示
    }
  }, []);

  const hasMessages = messages.length > 0;
  const isMultiline = input.includes('\n');
  const isExpanded = hasMessages || isMultiline;

  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const userScrolledSinceSwitchRef = useRef(false);

  /**
   * 消息流容器的「思考期跟随」行为 —— 与主窗口共用同一份 hook（useFollowBottom）。
   * 仅在思考/阶段载入中跟随底部；用户一旦手动滚动，立刻永久停止跟随。
   * 正文开始流式输出或生成结束后完全不干预，彻底移除回正逻辑。
   */
  const lastMsg = messages[messages.length - 1];
  const answerStreaming = !!lastMsg && lastMsg.role === 'assistant' && !!lastMsg.content;
  const isThinkingPhase = isGenerating && !answerStreaming;
  const { containerProps: streamProps, markProgrammatic } = useFollowBottom(
    isThinkingPhase,
    isGenerating ? lastMsg?.id : undefined,
    scrollContainerRef
  );

  const handleUserScrollAction = useCallback(() => {
    userScrolledSinceSwitchRef.current = true;
  }, []);

  // Track latest state in refs for listeners and intervals
  useEffect(() => {
    isGeneratingRef.current = isGenerating;
  }, [isGenerating]);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    inputRef.current = input;
  }, [input]);

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  // Record user activity timestamp in localStorage
  const recordActivity = () => {
    try {
      localStorage.setItem('tff_spotlight_last_active_v1', Date.now().toString());
    } catch (e) {
      // ignore
    }
  };

  // Auto-reset Spotlight to clean new chat after configured idle timeout
  const checkIdleReset = () => {
    const resetMinutes = settingsRef.current.spotlightResetMinutes ?? 15;
    if (resetMinutes <= 0) return; // 0 = never auto-reset

    // Never auto-reset while actively generating!
    if (isGeneratingRef.current) {
      recordActivity();
      return;
    }

    // Already blank, no need to reset
    if (messagesRef.current.length === 0 && !inputRef.current) {
      return;
    }

    const rawLastActive = localStorage.getItem('tff_spotlight_last_active_v1');
    if (!rawLastActive) {
      recordActivity();
      return;
    }

    const lastActive = parseInt(rawLastActive, 10);
    if (isNaN(lastActive) || lastActive <= 0) {
      recordActivity();
      return;
    }

    const elapsedMs = Date.now() - lastActive;
    if (elapsedMs >= resetMinutes * 60 * 1000) {
      console.log(`[Spotlight] Inactivity timeout (${Math.round(elapsedMs / 1000)}s >= ${resetMinutes * 60}s). Resetting to new chat.`);
      handleNewChat();
      recordActivity();
    }
  };

  // Periodic idle check
  useEffect(() => {
    recordActivity();
    const interval = setInterval(() => {
      checkIdleReset();
    }, 15000);
    return () => clearInterval(interval);
  }, []);

  // Track last resize payload sent to native bridge to avoid redundant postMessages
  const lastResizeSentRef = useRef<{ width: number; height: number; expanded: boolean } | null>(null);

  // Notify native AppKit panel to resize dynamically
  const notifyResize = (expanded: boolean, hasImages: boolean = false) => {
    // @ts-expect-error WebKit bridge
    if (window.webkit?.messageHandlers?.resizePanel) {
      const width = expanded ? 500 : 540;
      const height = expanded ? 640 : (hasImages ? 138 : 88);
      const last = lastResizeSentRef.current;
      if (last && last.width === width && last.height === height && last.expanded === expanded) {
        return; // Skip duplicate message to native panel
      }
      lastResizeSentRef.current = { width, height, expanded };
      // @ts-expect-error WebKit bridge
      window.webkit.messageHandlers.resizePanel.postMessage({
        width,
        height,
        expanded,
      });
    }
  };

  /**
   * 自动切入空白会话（复用已有空会话，若无则新建）。
   * 保证 Spotlight 每次启动 / 刷新 / 点击新建对话时，始终落在干净的胶囊态。
   */
  const initEmptySession = useCallback(() => {
    const { session } = getOrCreateEmptySession(
      lang === 'en' ? 'New Chat' : '新对话',
      'SPOTLIGHT'
    );
    activeSessionIdRef.current = session.id;
    setMessages([]);
    setInput('');
    setImages([]);
    setUsedTokens(0);
    setLiveStreamingTokens(null);
    setEnableThinking(session.enableThinking ?? false);
    setEnableWikiSearch(session.enableWikiSearch ?? false);
    notifyResize(false);
    recordActivity();
  }, [lang]);

  const handleNewChat = useCallback(() => {
    if (isGeneratingRef.current && abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    generatingSessionIdRef.current = null;
    setIsGenerating(false);
    initEmptySession();
  }, [initEmptySession]);

  // 首次挂载 / 刷新：直接进入空白会话（复用已有空会话，没有则新建），坚决不展示旧历史
  useEffect(() => {
    initEmptySession();
  }, [initEmptySession]);

  // Auto-resize textarea in Spotlight
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      const scrollHeight = textareaRef.current.scrollHeight;
      textareaRef.current.style.height = `${Math.min(Math.max(scrollHeight, 24), 160)}px`;
    }
  }, [input, isExpanded]);

  // Retain focus and cursor position when transitioning between capsule and expanded card
  useEffect(() => {
    if (textareaRef.current && messages.length === 0) {
      textareaRef.current.focus();
      const pos = cursorPositionRef.current !== null ? cursorPositionRef.current : input.length;
      textareaRef.current.setSelectionRange(pos, pos);
    }
  }, [isExpanded]);

  useEffect(() => {
    if (!isWikiPanelOpen) {
      notifyResize(isExpanded, images.length > 0);
    }
  }, [isExpanded, images.length, isWikiPanelOpen]);

  /* ========================================================================= */
  /* 输入框「搜索」按钮 → 小窗口内的知识库面板                                   */
  /*                                                                          */
  /* 效果与大窗口直接打开右侧侧边栏完全一致：小窗口空间有限，用**覆盖型抽屉**    */
  /* （WikiDrawer → WikiPanel，同一份实现）承载同一个面板（可搜索维基条目、      */
  /* 也能看引用条目的完整正文）。展开态与胶囊态都渲染这个按钮，两种状态下         */
  /* 的容器形式也一样。                                                        */
  /*                                                                          */
  /* 唯一的差异是**窗口尺寸**：胶囊态窗口只有 88px 高，面板根本放不下，故打开    */
  /* 时先把面板撑到可阅读尺寸（复用展开态尺寸），关闭时再收回输入胶囊。           */
  /* ========================================================================= */
  const openWikiPanel = () => {
    setIsWikiPanelOpen(true);
    if (!isExpanded) notifyResize(true);
  };

  const closeWikiPanel = () => {
    setIsWikiPanelOpen(false);
    setActiveWikiArticle(null);
    setActiveWikiContext(null);
    // 胶囊态打开过 → 面板关闭后窗口收回输入胶囊尺寸
    if (!isExpanded) notifyResize(false, images.length > 0);
  };

  /**
   * 关闭整个浮窗（原生桥）。展开态头部左上角的 ✖ 与知识库面板左上角的 ✖ 共用同一实现，
   * 两处外观也刻意保持一致。
   *
   * NOTE: 关闭浮窗**不会**中止后台生成。
   */
  const closeSpotlightWindow = () => {
    // @ts-expect-error WebKit bridge
    window.webkit?.messageHandlers?.closeSpotlight?.postMessage?.({});
  };

  /**
   * 面板打开条件 = 「搜索」按钮打开（无条目 → 搜索页）或点击引用胶囊（有条目 → 正文页）。
   * 两处共用同一个抽屉节点，保证展开/胶囊两种状态的显示机制逐字一致。
   */
  const wikiDrawerNode = (
    <WikiDrawer
      isOpen={isWikiPanelOpen || !!activeWikiArticle}
      title={activeWikiArticle}
      context={activeWikiContext}
      onClose={closeWikiPanel}
      onCloseWindow={closeSpotlightWindow}
      wikiEnabled={wikiStatus.enabled}
      wikiConnected={wikiStatus.connected}
    />
  );

  const isDeepSeek = settings.apiProvider === 'deepseek';

  /** 输入框发送按钮左侧的「搜索」小按钮（胶囊态 / 展开态共用同一份外观）
   *  尺寸与右侧发送按钮完全一致：w-7 h-7 圆 + w-3.5 h-3.5 图标（发送是 ArrowUp 同尺寸）。
   *  仅配色更轻（浅底幽灵按钮），避免抢发送这个主操作的视觉权重。
   *
   *  DeepSeek 模式下设为不可用；本地模式下未开启时照样能打开面板查看提醒。 */
  const wikiSearchButton = (
    <button
      type="button"
      onClick={isDeepSeek ? undefined : openWikiPanel}
      disabled={isDeepSeek}
      className={`w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 transition-colors ${
        isDeepSeek
          ? 'opacity-40 cursor-not-allowed bg-black/5 text-zinc-400 dark:bg-white/5 dark:text-zinc-500'
          : 'bg-black/5 hover:bg-black/10 text-zinc-600 hover:text-black dark:bg-white/5 dark:hover:bg-white/10 dark:text-zinc-300 dark:hover:text-white cursor-pointer'
      }`}
      title={isDeepSeek ? t('wikiDisabledInDeepSeek') : t('expandWikiPanel')}
    >
      <Search className="w-3.5 h-3.5 stroke-[2.5]" />
    </button>
  );

  // DeepSeek 模式下自动关闭知识库面板
  useEffect(() => {
    if (isDeepSeek && isWikiPanelOpen) {
      closeWikiPanel();
    }
  }, [isDeepSeek, isWikiPanelOpen]);

  useEffect(() => {
    const isNewMessage = messages.length > prevMessagesLengthRef.current;
    const isDifferentSession = messages[0]?.id !== prevFirstMsgIdRef.current;
    prevMessagesLengthRef.current = messages.length;
    prevFirstMsgIdRef.current = messages[0]?.id;

    const el = scrollContainerRef.current;
    if (!el) return;

    if (isDifferentSession) {
      userScrolledSinceSwitchRef.current = false;
      markProgrammatic(400);
      el.scrollTop = el.scrollHeight;

      requestAnimationFrame(() => {
        if (!userScrolledSinceSwitchRef.current && el) {
          el.scrollTop = el.scrollHeight;
        }
        requestAnimationFrame(() => {
          if (!userScrolledSinceSwitchRef.current && el) {
            el.scrollTop = el.scrollHeight;
          }
        });
      });

      const t1 = setTimeout(() => {
        if (!userScrolledSinceSwitchRef.current && el) {
          el.scrollTop = el.scrollHeight;
        }
      }, 120);

      const t2 = setTimeout(() => {
        if (!userScrolledSinceSwitchRef.current && el) {
          el.scrollTop = el.scrollHeight;
        }
      }, 350);

      return () => {
        clearTimeout(t1);
        clearTimeout(t2);
      };
    } else if (isNewMessage) {
      markProgrammatic(300);
      el.scrollTop = el.scrollHeight;
    }
  }, [messages, markProgrammatic]);

  // Check backend health & Wiki status
  useEffect(() => {
    const checkServer = async () => {
      const info = await TurboFieldfareAPI.checkHealth(settings);
      setHealthInfo(info);
    };
    checkServer();
  }, [settings]);

  useEffect(() => {
    const checkWiki = async () => {
      const s = await WikiAPI.getStatus();
      setWikiStatus(s);
    };
    checkWiki();
  }, []);

  const loadSessionById = (sessionId: string) => {
    const all = loadSessions();
    const target = all.find((s) => s.id === sessionId);
    if (target) {
      activeSessionIdRef.current = sessionId;
      setMessages(target.messages || []);
      const cleanTokens = estimateHistoryTokens(target.messages || [], settings.systemPrompt, settings.apiProvider);
      setUsedTokens(cleanTokens);
      setLiveStreamingTokens(null);
      setEnableThinking(target.enableThinking ?? false);
      setEnableWikiSearch(target.enableWikiSearch ?? false);
      notifyResize((target.messages && target.messages.length > 0) || false, images.length > 0);
      recordActivity();

      // Hydrate any offloaded images from IndexedDB
      const hasOffloaded = target.messages?.some((m) =>
        m.images?.some((img) => img.startsWith('__idb__:'))
      );
      if (hasOffloaded) {
        hydrateSessionImages(target).then((changed) => {
          if (changed && activeSessionIdRef.current === sessionId) {
            setMessages([...target.messages]);
          }
        });
      }
    }
  };

  useEffect(() => {
    // @ts-expect-error global hook for Swift showWithSession evaluation
    window.loadSessionInSpotlight = (sessionId: string) => {
      loadSessionById(sessionId);
    };
    return () => {
      // @ts-expect-error global hook
      delete window.loadSessionInSpotlight;
    };
  }, []);

  // Real-time synchronization of settings & streaming across windows via syncChannel
  useEffect(() => {
    if (!syncChannel) return;

    const handler = (event: MessageEvent) => {
      const data = event.data;
      if (!data) return;

      if (data.type === 'SETTINGS_CHANGED') {
        setSettings(loadSettings());
      } else if (data.type === 'LOAD_SESSION_IN_SPOTLIGHT') {
        if (data.sessionId) {
          if (data.session && Array.isArray(data.session.messages)) {
            activeSessionIdRef.current = data.sessionId;
            setMessages(data.session.messages);
            const cleanTokens = estimateHistoryTokens(data.session.messages, settings.systemPrompt, settings.apiProvider);
            setUsedTokens(cleanTokens);
            setLiveStreamingTokens(null);
            setEnableThinking(data.session.enableThinking ?? false);
            setEnableWikiSearch(data.session.enableWikiSearch ?? false);
            notifyResize(data.session.messages.length > 0, images.length > 0);
            recordActivity();
          } else {
            loadSessionById(data.sessionId);
          }
        }
      } else if (data.type === 'STREAM_TOKEN_PROGRESS') {
        if (data.source !== 'SPOTLIGHT' && activeSessionIdRef.current === data.sessionId) {
          setLiveStreamingTokens(data.liveTokens);
        }
      } else if (data.type === 'STREAM_CHUNK') {
        if (data.source !== 'SPOTLIGHT') {
          recordActivity();
          const { sessionId, messageId, reasoningContent, content, isThinking, thinkingDuration, stage, pending, citations, stages: incomingStages } = data;
          // 阶段字段一并从广播同步（主窗口已在首个 token 时广播 pending:false）：
          // 阶段阶梯的展开/收起时机因此与生成方窗口完全一致，不会出现"主窗已收起、浮窗还展开"。
          const stagePatch = {
            ...(stage !== undefined ? { stage } : {}),
            ...(pending !== undefined ? { pending } : {}),
            ...(citations !== undefined ? { citations } : {}),
            ...(incomingStages !== undefined ? { stages: incomingStages } : {}),
          };
          if (!activeSessionIdRef.current || activeSessionIdRef.current === sessionId) {
            activeSessionIdRef.current = sessionId;
            setIsGenerating(true);

            setMessages((prev) => {
              const msgIdx = prev.findIndex((m) => m.id === messageId);
              if (msgIdx >= 0) {
                return prev.map((m) =>
                  m.id === messageId
                    ? {
                        ...m,
                        reasoningContent,
                        content,
                        isThinking,
                        thinkingDuration,
                        ...stagePatch,
                      }
                    : m
                );
              }
              // 若 prev 已有当前会话的消息但尚未含有本轮助手消息，直接追加
              if (prev.length > 0) {
                return [
                  ...prev,
                  {
                    id: messageId,
                    role: 'assistant' as const,
                    content,
                    reasoningContent,
                    isThinking,
                    thinkingDuration,
                    timestamp: Date.now(),
                    ...stagePatch,
                  },
                ];
              }
              const all = loadSessions();
              const targetIdx = all.findIndex((s) => s.id === sessionId);
              if (targetIdx >= 0 && all[targetIdx].messages && all[targetIdx].messages.length > 0) {
                const targetMsgs = all[targetIdx].messages;
                const existingIdx = targetMsgs.findIndex((m) => m.id === messageId);
                if (existingIdx >= 0) {
                  return targetMsgs.map((m) =>
                    m.id === messageId
                      ? { ...m, reasoningContent, content, isThinking, thinkingDuration, ...stagePatch }
                      : m
                  );
                }
                return [
                  ...targetMsgs,
                  {
                    id: messageId,
                    role: 'assistant' as const,
                    content,
                    reasoningContent,
                    isThinking,
                    thinkingDuration,
                    timestamp: Date.now(),
                    ...stagePatch,
                  },
                ];
              }
              // 磁盘与内存皆空时创建最小助手占位
              return [
                {
                  id: messageId,
                  role: 'assistant' as const,
                  content,
                  reasoningContent,
                  isThinking,
                  thinkingDuration,
                  timestamp: Date.now(),
                  ...stagePatch,
                },
              ];
            });
            if (messagesRef.current.length === 0) {
              notifyResize(true);
            }
          }
        }
      } else if (data.type === 'STAGES_CHANGED') {
        // 镜像窗口（主窗口）的阶段阶梯记录：实时并入本窗口消息
        if (data.source !== 'SPOTLIGHT' && data.messageId) {
          setMessages((prev) => prev.map((m) => (m.id === data.messageId ? { ...m, stages: data.stages } : m)));
        }
      } else if (data.type === 'STREAM_DONE') {
        if (data.source !== 'SPOTLIGHT') {
          const { sessionId, messageId, reasoningContent, content, thinkingDuration, metrics } = data;
          if (activeSessionIdRef.current === sessionId) {
            setIsGenerating(false);
            setLiveStreamingTokens(null);
            recordActivity();
            setMessages((prev) => {
              const msgIdx = prev.findIndex((m) => m.id === messageId);
              if (msgIdx >= 0) {
                const updated = prev.map((m) =>
                  m.id === messageId
                    ? {
                        ...m,
                        reasoningContent,
                        content,
                        isThinking: false,
                        thinkingDuration,
                        metrics,
                        pending: false,
                      }
                    : m
                );
                const cleanTokens = estimateHistoryTokens(updated, settings.systemPrompt, settings.apiProvider);
                setUsedTokens(cleanTokens);
                return updated;
              }
              const all = loadSessions();
              const target = all.find((s) => s.id === sessionId);
              if (target && target.messages) {
                return target.messages;
              }
              return prev;
            });
          }
        }
      } else if (data.type === 'STREAM_ABORT') {
        const isTarget =
          !data.sessionId ||
          data.sessionId === generatingSessionIdRef.current ||
          data.sessionId === activeSessionIdRef.current;
        if (isTarget) {
          if (abortControllerRef.current) {
            abortControllerRef.current.abort();
            abortControllerRef.current = null;
          }
          generatingSessionIdRef.current = null;
          setIsGenerating(false);
          setLiveStreamingTokens(null);
        }
      } else if (data.type === 'STREAM_QUERY') {
        const curGenId = generatingSessionIdRef.current || activeSessionIdRef.current;
        if (isGeneratingRef.current && abortControllerRef.current && curGenId) {
          syncChannel?.postMessage({
            type: 'STREAM_CHUNK',
            sessionId: curGenId,
            messageId: currentAsstMsgIdRef.current,
            reasoningContent: accumulatedThoughtRef.current,
            content: accumulatedContentRef.current,
            // 只有思考真的开始（已有思考 token）才算"思考中"，prefill 阶段不算
            isThinking: accumulatedThoughtRef.current.length > 0,
            thinkingDuration: (performance.now() - thinkingStartTimeRef.current) / 1000,
            // 尚未收到任何 token 即为仍在「检索 / 载入上下文」阶段——重放必须带上，
            // 否则主窗口镜像会在检索阶段误判成"阶段已结束"（汇总行提前显示已完成）
            pending: !accumulatedThoughtRef.current && !accumulatedContentRef.current,
            stages: stagesRef.current,
            source: 'SPOTLIGHT',
          });
        }
      } else if (data.type === 'SESSIONS_CHANGED') {
        if (!isGeneratingRef.current && activeSessionIdRef.current && (!data.sessionId || data.sessionId === activeSessionIdRef.current)) {
          const all = loadSessions();
          const target = all.find((s) => s.id === activeSessionIdRef.current);
          if (target) {
            setMessages(target.messages || []);
            setEnableThinking(target.enableThinking ?? false);
            setEnableWikiSearch(target.enableWikiSearch ?? false);
            if (!target.messages || target.messages.length === 0) {
              notifyResize(false, images.length > 0);
            }
          }
        }
      }
    };

    syncChannel.addEventListener('message', handler);
    return () => syncChannel?.removeEventListener('message', handler);
  }, [enableThinking]);

  useEffect(() => {
    const handleStorage = (e: StorageEvent) => {
      if (e.key === 'tff_chat_settings_v1') {
        setSettings(loadSettings());
      } else if (e.key === 'tff_abort_request_v1') {
        // 主窗口点了「停止」：本窗口若正持有该回合，就地中止
        const req = readAbortRequest();
        if (!req) return;
        const isTarget =
          !req.sessionId ||
          req.sessionId === generatingSessionIdRef.current ||
          req.sessionId === activeSessionIdRef.current;
        if (isTarget && abortControllerRef.current) {
          abortControllerRef.current.abort();
          abortControllerRef.current = null;
          generatingSessionIdRef.current = null;
          setIsGenerating(false);
          setLiveStreamingTokens(null);
        }
      } else if (e.key === 'tff_chat_sessions_v1') {
        // 生成中的回合由广播驱动，这里不重载，避免把流式内容回滚
      }
    };
    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }, []);

  // Reload latest settings whenever Spotlight gains focus or is shown
  useEffect(() => {
    const handleFocusOrShown = () => {
      checkIdleReset();
      setSettings(loadSettings());
      WikiAPI.getStatus().then(setWikiStatus);
      syncChannel?.postMessage({ type: 'STREAM_QUERY' });
    };

    // @ts-expect-error global hook for Swift show()
    window.onSpotlightShown = handleFocusOrShown;
    window.addEventListener('focus', handleFocusOrShown);

    return () => {
      // @ts-expect-error global hook
      delete window.onSpotlightShown;
      window.removeEventListener('focus', handleFocusOrShown);
    };
  }, []);

  // Global shortcut listener (Cmd+O to open in main window)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      recordActivity();
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'o') {
        e.preventDefault();
        handleOpenInMain();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [messages, input, isGenerating]);

  // Helper to persist toggle state to current active session if one exists
  const updateActiveSessionToggles = (thinking: boolean, wiki: boolean) => {
    try {
      const currentId = activeSessionIdRef.current;
      if (!currentId) return;
      const all = loadSessions();
      const idx = all.findIndex((s) => s.id === currentId);
      if (idx >= 0) {
        all[idx] = {
          ...all[idx],
          enableThinking: thinking,
          enableWikiSearch: wiki,
          updatedAt: Date.now(),
        };
        saveSessions(all);
        notifySessionUpdate(currentId, 'SPOTLIGHT');
      }
    } catch (e) {
      // ignore
    }
  };

  const toggleThinking = (enabled: boolean) => {
    setEnableThinking(enabled);
    updateActiveSessionToggles(enabled, enableWikiSearch);
  };

  const toggleWiki = (enabled: boolean) => {
    setEnableWikiSearch(enabled);
    updateActiveSessionToggles(enableThinking, enabled);
  };

  const executeSend = async (
    textToSend: string,
    currentImages: string[],
    historyMessages: ChatMessage[]
  ) => {
    const isDeepSeek = settings.apiProvider === 'deepseek';
    const effectiveEnableWiki = isDeepSeek ? false : enableWikiSearch;

    // 与主窗口共用同一套消息构造（形状与 ID 规则一致）
    const { userMessage, assistantMessage: initialAsstMessage, nextMessages } = buildTurnMessages({
      historyMessages,
      textToSend,
      images: currentImages,
      enableThinking,
      isDeepSeek,
    });
    const asstMessageId = initialAsstMessage.id;
    currentAsstMsgIdRef.current = asstMessageId;
    setMessages(nextMessages);
    setIsGenerating(true);
    recordActivity();

    // 1. IMMEDIATELY CREATE / SYNC SESSION IN STORAGE AND BROADCAST TO MAIN WINDOW
    let currentSessionId = activeSessionIdRef.current;
    if (!currentSessionId) {
      currentSessionId = 'session-' + Date.now() + '-' + Math.random().toString(36).substring(2, 7);
      activeSessionIdRef.current = currentSessionId;
    }
    generatingSessionIdRef.current = currentSessionId;

    // 向主窗口广播回合阶段（DeepSeek 模式直接 prefill，本地模式先 stage='rag'）
    const broadcastStage = (stage: 'rag' | 'prefill', pending: boolean, citations?: WikiCitation[]) => {
      syncChannel?.postMessage({
        type: 'STREAM_CHUNK',
        sessionId: currentSessionId,
        messageId: asstMessageId,
        reasoningContent: '',
        content: '',
        isThinking: false,
        thinkingDuration: 0,
        stage,
        pending,
        ...(citations && citations.length > 0 ? { citations } : {}),
        source: 'SPOTLIGHT',
      });
    };
    try {
      broadcastStage(isDeepSeek ? 'prefill' : 'rag', true);
    } catch (e) {
      // 广播失败不中止本轮：主窗口的阶段同步会缺席，但生成流程继续
      console.error('[Spotlight] stage broadcast failed:', e);
    }

    const isFirstUserMessage = historyMessages.length === 0;
    const defaultTitle = lang === 'en' ? 'New Chat' : '新对话';
    const computedTitle = generateSessionTitle(textToSend, currentImages.length > 0, defaultTitle);

    try {
      const allSessions = loadSessions();
      const existingIdx = allSessions.findIndex((s) => s.id === currentSessionId);
      if (existingIdx >= 0) {
        const currentTitle = allSessions[existingIdx].title;
        const nextTitle =
          isFirstUserMessage || !currentTitle || currentTitle === '新对话' || currentTitle === 'New Chat'
            ? computedTitle
            : currentTitle;
        allSessions[existingIdx] = {
          ...allSessions[existingIdx],
          title: nextTitle,
          messages: nextMessages,
          enableThinking,
          enableWikiSearch: effectiveEnableWiki,
          updatedAt: Date.now(),
        };
        saveSessions(allSessions);
      } else {
        const cleanSessions = allSessions.filter((s) => s.messages && s.messages.length > 0);
        cleanSessions.unshift({
          id: currentSessionId,
          title: computedTitle,
          messages: nextMessages,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          contextUsed: usedTokens,
          enableThinking,
          enableWikiSearch: effectiveEnableWiki,
        });
        saveSessions(cleanSessions);
      }
      saveCurrentSessionId(currentSessionId);
      notifySessionUpdate(currentSessionId, 'SPOTLIGHT');
    } catch (e) {
      console.error('Failed to immediately sync session to main window:', e);
    }

    // 2. 离线维基 RAG：与主窗口共用 services/chatTurn 的同一实现（DeepSeek 模式自动跳过）。
    const abortController = new AbortController();
    abortControllerRef.current = abortController;
    stagesRef.current = []; // 新一轮：清空阶段快照
    thinkingStartTimeRef.current = performance.now();
    const thinkingStartTime = thinkingStartTimeRef.current;

    let promptToSend = textToSend;
    let foundCitations: WikiCitation[] = [];
    try {
      const rag = await buildPromptWithWiki({
        textToSend,
        lang,
        wikiMasterEnabled: wikiStatus.enabled,
        sessionEnableWiki: effectiveEnableWiki,
        wikiConnected: wikiStatus.connected,
        isDeepSeek,
        signal: abortController.signal,
      });
      promptToSend = rag.promptToSend;
      foundCitations = rag.citations;
    } catch (e) {
      if ((e as Error).name === 'AbortError' || abortController.signal.aborted) {
        // 检索期间被叫停：撤下本轮占位消息，无任何后续调用。
        // ⚠️ 若已被重试取代（currentAsstMsgIdRef 指向新回合），本清理必须跳过，
        // 否则会清空新流的控制器引用与生成状态（实测：停止按钮失灵、状态错乱）
        if (asstMessageId !== currentAsstMsgIdRef.current) return;
        abortControllerRef.current = null;
        generatingSessionIdRef.current = null;
        setIsGenerating(false);
        setLiveStreamingTokens(null);
        // ⚠️ 只撤下助理占位消息，**必须保留用户的提问**：
        // 整轮删除会让会话变空 → 被当成"新对话"，用户以为聊天记录丢了。
        setMessages((prev) => prev.filter((m) => m.id !== asstMessageId));
        try {
          const sid = currentSessionId;
          if (sid) {
            const all = loadSessions();
            const idx = all.findIndex((s) => s.id === sid);
            if (idx >= 0) {
              all[idx] = {
                ...all[idx],
                messages: all[idx].messages.filter((m) => m.id !== asstMessageId),
                updatedAt: Date.now(),
              };
              saveSessions(all, sid, 'SPOTLIGHT');
            }
          }
          // 明确告诉另一个窗口"已停止"，否则镜像侧会一直停在生成中（看着像点了没反应）
          syncChannel?.postMessage({
            type: 'STREAM_ABORT',
            sessionId: sid,
            source: 'SPOTLIGHT',
          });
        } catch {
          // 广播失败不影响本窗口
        }
        recordActivity();
        return;
      }
      throw e;
    }

    // RAG 解析完成 → 进入 prefill 阶段（与主窗口同一阶段机）
    // 引用胶囊此刻已知，一并挂上（与主窗口一致，避免"胶囊延迟到生成结束才出现"）
    broadcastStage('prefill', true, foundCitations);
    setMessages((prev) =>
      prev.map((m) =>
        m.id === asstMessageId
          ? {
              ...m,
              stage: 'prefill',
              prefillStartedAt: Date.now(),
              citations: foundCitations.length > 0 ? foundCitations : undefined,
            }
          : m
      )
    );

    let accumulatedThought = '';
    let accumulatedContent = '';
    let finalThinkingDuration = 0;
    accumulatedThoughtRef.current = '';
    accumulatedContentRef.current = '';

    // Helper to persist streaming tokens to storage and mirror in Main Window
    let lastSaveTime = 0;
    const persistSession = (isFinal = false, metrics?: any, err?: any) => {
      const now = performance.now();
      if (!isFinal && now - lastSaveTime < 350) return;
      lastSaveTime = now;

      try {
        const currentId = currentSessionId;
        if (!currentId) return;
        const all = loadSessions();
        const idx = all.findIndex((s) => s.id === currentId);
        if (idx >= 0) {
          // 保留既有的 stage/prefillStartedAt：重建对象若丢弃这些字段，
          // 主窗口镜像的回合会丢失阶段阶梯（同步经 notifySessionUpdate → 主窗口重载）。
          // pending **不能**照抄旧值：中止/出错后若落盘仍是 pending:true，
          // 一次同步就会把"永远在转圈的僵尸回合"带回到两个窗口。
          const prevAsst = all[idx].messages.find((m) => m.id === asstMessageId);
          const asstMsg: ChatMessage = {
            ...(prevAsst ?? {}),
            id: asstMessageId,
            role: 'assistant',
            content: accumulatedContent,
            reasoningContent: accumulatedThought,
            isThinking: isFinal ? false : (accumulatedThought.length > 0 && !accumulatedContent),
            pending: isFinal ? false : (prevAsst?.pending ?? true),
            thinkingDuration: finalThinkingDuration || (performance.now() - thinkingStartTime) / 1000,
            timestamp: Date.now(),
            metrics,
            citations: foundCitations.length > 0 ? foundCitations : undefined,
            error: err?.message,
          };
          const currentTitle = all[idx].title;
          const resolvedTitle =
            isFirstUserMessage || !currentTitle || currentTitle === '新对话' || currentTitle === 'New Chat'
              ? computedTitle
              : currentTitle;
          all[idx] = {
            ...all[idx],
            title: resolvedTitle,
            messages: [...historyMessages, userMessage, asstMsg],
            contextUsed: metrics?.contextUsed ?? all[idx].contextUsed,
            updatedAt: Date.now(),
          };
          saveSessions(all);
          notifySessionUpdate(currentId, 'SPOTLIGHT');
        }
      } catch (e) {
        // ignore
      }
    };

    const messagesWithPrompt: ChatMessage[] = buildWireMessages(historyMessages, userMessage, promptToSend, {
      systemPrompt: settings.systemPrompt,
      maxContext: settings.maxContext,
      maxTokens: settings.maxTokens,
      provider: settings.apiProvider,
    });
    const sessionSettings = buildSessionSettings(settings, enableThinking, enableWikiSearch);

    const promptTokensEstimate = applyTokenCalibration(
      estimateHistoryTokens(messagesWithPrompt, settings.systemPrompt, settings.apiProvider),
      settings.apiProvider
    );
    setLiveStreamingTokens(promptTokensEstimate);

    await TurboFieldfareAPI.streamChat(
      messagesWithPrompt,
      sessionSettings,
      {
        onTokenProgress: (liveTokens) => {
          setLiveStreamingTokens(liveTokens);
          syncChannel?.postMessage({
            type: 'STREAM_TOKEN_PROGRESS',
            sessionId: currentSessionId,
            liveTokens,
            source: 'SPOTLIGHT',
          });
        },
        onFirstToken: () => {
          if (asstMessageId !== currentAsstMsgIdRef.current) return; // 过期流：已被重试取代
          // 首个 token 到达：prefill 结束，撤下"载入上下文"指示并闭合阶段打点
          const tEnd = Date.now();
          const closedStages = (stagesRef.current ?? []).map((st) =>
            st.endedAt === undefined
              ? { ...st, endedAt: tEnd, durationMs: Math.max(0, tEnd - st.startedAt) }
              : st
          );
          stagesRef.current = closedStages;
          setMessages((prev) =>
            prev.map((m) => (m.id === asstMessageId ? { ...m, pending: false, stages: closedStages } : m))
          );
        },
        onThought: (delta) => {
          if (asstMessageId !== currentAsstMsgIdRef.current) return; // 过期流：已被重试取代
          accumulatedThought += delta;
          accumulatedThoughtRef.current = accumulatedThought;
          finalThinkingDuration = (performance.now() - thinkingStartTime) / 1000;
          recordActivity();
          setMessages((prev) =>
            prev.map((m) =>
              m.id === asstMessageId
                ? {
                    ...m,
                    reasoningContent: accumulatedThought,
                    isThinking: true,
                    thinkingDuration: finalThinkingDuration,
                    // 首个 token 已到：prefill 指示器必须撤下（兜底，防 onFirstToken 竞态遗漏）
                    pending: false,
                  }
                : m
            )
          );
          persistSession(false);
          syncChannel?.postMessage({
            type: 'STREAM_CHUNK',
            sessionId: currentSessionId,
            messageId: asstMessageId,
            reasoningContent: accumulatedThought,
            content: accumulatedContent,
            isThinking: true,
            thinkingDuration: finalThinkingDuration,
            // pending:false 随载荷同步：主窗口镜像的 prefill 指示器同步撤下
            pending: false,
            stages: stagesRef.current,
            // 引用胶囊随载荷同步：主窗口镜像与磁盘存档不至于丢失引用
            citations: foundCitations.length > 0 ? foundCitations : undefined,
            source: 'SPOTLIGHT',
          });
        },
        onContent: (delta) => {
          if (asstMessageId !== currentAsstMsgIdRef.current) return; // 过期流：已被重试取代
          accumulatedContent += delta;
          accumulatedContentRef.current = accumulatedContent;
          recordActivity();
          setMessages((prev) =>
            prev.map((m) =>
              m.id === asstMessageId
                ? {
                    ...m,
                    content: accumulatedContent,
                    isThinking: false,
                    thinkingDuration: finalThinkingDuration,
                    // 兜底：内容流式开始 = prefill 必然已结束
                    pending: false,
                  }
                : m
            )
          );
          persistSession(false);
          syncChannel?.postMessage({
            type: 'STREAM_CHUNK',
            sessionId: currentSessionId,
            messageId: asstMessageId,
            reasoningContent: accumulatedThought,
            content: accumulatedContent,
            isThinking: false,
            thinkingDuration: finalThinkingDuration,
            pending: false,
            stages: stagesRef.current,
            citations: foundCitations.length > 0 ? foundCitations : undefined,
            source: 'SPOTLIGHT',
          });
        },
        onDone: (metrics) => {
          if (asstMessageId !== currentAsstMsgIdRef.current) return; // 过期流：已被重试取代
          setIsGenerating(false);
          setLiveStreamingTokens(null);
          abortControllerRef.current = null;
          generatingSessionIdRef.current = null;
          recordActivity();

          const finalAsstMessage: ChatMessage = {
            id: asstMessageId,
            role: 'assistant',
            content: accumulatedContent,
            reasoningContent: accumulatedThought,
            isThinking: false,
            thinkingDuration: finalThinkingDuration,
            timestamp: Date.now(),
            metrics,
            citations: foundCitations.length > 0 ? foundCitations : undefined,
            stages: (stagesRef.current ?? []).map((st) =>
              st.endedAt === undefined
                ? { ...st, endedAt: Date.now(), durationMs: Math.max(0, Date.now() - st.startedAt) }
                : st
            ),
          };

          const cleanHistoryTokens = estimateHistoryTokens(
            [...historyMessages, userMessage, finalAsstMessage],
            settings.systemPrompt,
            settings.apiProvider
          );
          setUsedTokens(cleanHistoryTokens);

          setMessages((prev) =>
            prev.map((m) => (m.id === asstMessageId ? finalAsstMessage : m))
          );
          persistSession(true, { ...metrics, contextUsed: cleanHistoryTokens });
          syncChannel?.postMessage({
            type: 'STREAM_DONE',
            sessionId: currentSessionId,
            messageId: asstMessageId,
            reasoningContent: accumulatedThought,
            content: accumulatedContent,
            thinkingDuration: finalThinkingDuration,
            metrics: { ...metrics, contextUsed: cleanHistoryTokens },
            source: 'SPOTLIGHT',
          });
        },
        onError: (err) => {
          if (asstMessageId !== currentAsstMsgIdRef.current) return; // 过期流：已被重试取代
          setIsGenerating(false);
          setLiveStreamingTokens(null);
          abortControllerRef.current = null;
          generatingSessionIdRef.current = null;
          recordActivity();

          const cleanHistoryTokens = estimateHistoryTokens(
            [...historyMessages, userMessage],
            settings.systemPrompt,
            settings.apiProvider
          );
          setUsedTokens(cleanHistoryTokens);

          const finalAsstMessage: ChatMessage = {
            id: asstMessageId,
            role: 'assistant',
            content: accumulatedContent,
            reasoningContent: accumulatedThought,
            isThinking: false,
            thinkingDuration: (performance.now() - thinkingStartTime) / 1000,
            timestamp: Date.now(),
            citations: foundCitations.length > 0 ? foundCitations : undefined,
            error: err.message,
          };

          setMessages((prev) =>
            prev.map((m) => (m.id === asstMessageId ? finalAsstMessage : m))
          );
          persistSession(true, undefined, err);
          syncChannel?.postMessage({
            type: 'STREAM_DONE',
            sessionId: currentSessionId,
            messageId: asstMessageId,
            reasoningContent: accumulatedThought,
            content: accumulatedContent,
            thinkingDuration: (performance.now() - thinkingStartTime) / 1000,
            source: 'SPOTLIGHT',
          });
        },
      },
      abortController.signal
    );
  };

  const handleSend = async () => {
    const textToSend = input.trim();
    if (!textToSend && images.length === 0) return;
    if (isGenerating) return;

    const currentImages = [...images];
    setInput('');
    setImages([]);

    await executeSend(textToSend, currentImages, messages);
  };

  const { imeBindings: inputImeBindings } = useImeInput<HTMLTextAreaElement>({
    onEnter: () => {
      handleSend();
    },
  });

  const handleRetry = async (assistantMessageId: string) => {
    if (isGenerating) {
      handleStop();
    }

    const asstIdx = messages.findIndex((m) => m.id === assistantMessageId);
    if (asstIdx === -1) return;

    let userIdx = -1;
    for (let i = asstIdx - 1; i >= 0; i--) {
      if (messages[i].role === 'user') {
        userIdx = i;
        break;
      }
    }
    if (userIdx === -1) return;

    const userMessage = messages[userIdx];
    const historyBeforeUser = messages.slice(0, userIdx);

    await executeSend(userMessage.content, userMessage.images || [], historyBeforeUser);
  };

  const handleDeleteTurn = (assistantMessageId: string) => {
    if (isGenerating && currentAsstMsgIdRef.current === assistantMessageId) {
      handleStop();
    }

    const asstIdx = messages.findIndex((m) => m.id === assistantMessageId);
    if (asstIdx === -1) return;

    let userIdx = -1;
    for (let i = asstIdx - 1; i >= 0; i--) {
      if (messages[i].role === 'user') {
        userIdx = i;
        break;
      }
    }

    const idsToDelete = new Set<string>([assistantMessageId]);
    const deletedImages: string[] = [];
    if (userIdx !== -1) {
      idsToDelete.add(messages[userIdx].id);
      if (messages[userIdx]?.images) {
        deletedImages.push(...messages[userIdx].images!);
      }
    }

    const nextMessages = messages.filter((m) => !idsToDelete.has(m.id));
    setMessages(nextMessages);

    const currentSessionId = activeSessionIdRef.current;
    if (currentSessionId) {
      try {
        const all = loadSessions();
        const idx = all.findIndex((s) => s.id === currentSessionId);
        if (idx >= 0) {
          all[idx] = {
            ...all[idx],
            messages: nextMessages,
            updatedAt: Date.now(),
          };
          saveSessions(all, currentSessionId, 'SPOTLIGHT');
          notifySessionUpdate(currentSessionId, 'SPOTLIGHT');
          deleteUnreferencedMedia(deletedImages, all);
        }
      } catch (e) {
        console.error('Failed to sync deleted turn in spotlight:', e);
      }
    }
    if (nextMessages.length === 0) {
      notifyResize(false, images.length > 0);
    }
    recordActivity();
  };

  const handleStop = () => {
    const curSid = generatingSessionIdRef.current || activeSessionIdRef.current;
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    generatingSessionIdRef.current = null;
    setIsGenerating(false);
    setLiveStreamingTokens(null);
    setMessages((prev) =>
      prev.map((m) =>
        m.pending || m.isThinking ? { ...m, pending: false, isThinking: false } : m
      )
    );
    // 同上：额外走一次 localStorage，保证主窗口一定能收到
    if (curSid) requestAbort(curSid);
    syncChannel?.postMessage({
      type: 'STREAM_ABORT',
      sessionId: curSid,
      source: 'SPOTLIGHT',
    });
  };

  const handleOpenInMain = () => {
    const currentId =
      generatingSessionIdRef.current ||
      activeSessionIdRef.current ||
      loadCurrentSessionId() ||
      ('session-' + Date.now());

    // If there is any content, ensure it is written to storage before transitioning
    if (messages.length > 0) {
      try {
        const defaultTitle = lang === 'en' ? 'New Chat' : '新对话';
        const derivedTitle = deriveSessionTitleFromMessages(messages, defaultTitle);
        activeSessionIdRef.current = currentId;
        const allSessions = loadSessions();
        const existingIdx = allSessions.findIndex((s) => s.id === currentId);
        if (existingIdx >= 0) {
          const currentTitle = allSessions[existingIdx].title;
          const nextTitle =
            !currentTitle || currentTitle === '新对话' || currentTitle === 'New Chat'
              ? derivedTitle
              : currentTitle;
          allSessions[existingIdx] = {
            ...allSessions[existingIdx],
            title: nextTitle,
            messages,
            contextUsed: usedTokens,
            enableThinking,
            enableWikiSearch,
            updatedAt: Date.now(),
          };
        } else {
          allSessions.unshift({
            id: currentId,
            title: derivedTitle,
            messages,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            contextUsed: usedTokens,
            enableThinking,
            enableWikiSearch,
          });
        }
        saveSessions(allSessions, currentId, 'SPOTLIGHT');
        saveCurrentSessionId(currentId);
        notifySessionUpdate(currentId, 'SPOTLIGHT');
      } catch (e) {
        console.error('Failed to sync before open in main:', e);
      }
    } else if (currentId) {
      saveCurrentSessionId(currentId);
    }

    // @ts-expect-error WebKit bridge
    if (window.webkit?.messageHandlers?.openMainWindow) {
      // @ts-expect-error WebKit bridge
      window.webkit.messageHandlers.openMainWindow.postMessage({});
    }
    // @ts-expect-error WebKit bridge
    if (window.webkit?.messageHandlers?.openMainFromSpotlight) {
      // @ts-expect-error WebKit bridge
      window.webkit.messageHandlers.openMainFromSpotlight.postMessage({});
    }

    // Reset Spotlight UI WITHOUT aborting generation!
    // If actively generating in the background, DO NOT abort!
    // The background stream will keep running and sending STREAM_CHUNK to Main window!
    activeSessionIdRef.current = null;
    setMessages([]);
    setInput('');
    setImages([]);
    setLiveStreamingTokens(null);
    setUsedTokens(0);
    setEnableThinking(false);
    setEnableWikiSearch(false);
    notifyResize(false);
    recordActivity();
  };

  const handleCopyText = async (id: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedMsgId(id);
      setTimeout(() => setCopiedMsgId((cur) => (cur === id ? null : cur)), 2000);
    } catch (e) {
      console.error(e);
    }
  };

  const handlePaste = async (e: React.ClipboardEvent) => {
    const files = extractImagesFromPaste(e);
    if (files.length > 0) {
      e.preventDefault();
      try {
        const urls = await Promise.all(files.map(fileToDataURL));
        setImages((prev) => [...prev, ...urls]);
      } catch (err) {
        console.error(err);
      }
    }
  };

  const [isDragOver, setIsDragOver] = useState(false);
  const dragCounterRef = useRef(0);

  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer.types.includes('Files')) {
      dragCounterRef.current++;
      setIsDragOver(true);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer.types.includes('Files')) {
      e.dataTransfer.dropEffect = 'copy';
      setIsDragOver(true);
    }
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    dragCounterRef.current--;
    if (dragCounterRef.current <= 0) {
      dragCounterRef.current = 0;
      setIsDragOver(false);
    }
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    dragCounterRef.current = 0;
    setIsDragOver(false);

    const droppedFiles = Array.from(e.dataTransfer.files).filter(isImageFile);
    if (droppedFiles.length > 0) {
      try {
        const urls = await Promise.all(droppedFiles.map(fileToDataURL));
        setImages((prev) => [...prev, ...urls]);
      } catch (err) {
        console.error('Failed to process dropped images in spotlight:', err);
      }
    }
  };

  const handleRemoveDraftImage = (index: number) => {
    const removedUrl = images[index];
    setImages((prev) => prev.filter((_, i) => i !== index));
    if (removedUrl) {
      const all = loadSessions();
      deleteUnreferencedMedia([removedUrl], all);
    }
  };

  /* ========================================================================= */
  /* STATE 1: INITIAL COMPACT INPUT CAPSULE (Clean flat surface, NO shadows)   */
  /* ========================================================================= */
  if (!isExpanded) {
    return (
      <div
        className="w-full h-full select-none bg-transparent relative"
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {isDragOver && (
          <div className="absolute inset-0 z-50 bg-blue-500/20 dark:bg-blue-400/20 backdrop-blur-[2px] border-2 border-dashed border-blue-500 dark:border-blue-400 rounded-[22px] flex items-center justify-center pointer-events-none">
            <span className="text-xs font-semibold text-blue-600 dark:text-blue-300 bg-white/95 dark:bg-[#1f2024]/95 px-3 py-1 rounded-full shadow-md border border-blue-500/30">
              {t('dropImagesHere')}
            </span>
          </div>
        )}
        {/* Outer frame: gray background matching expanded bottom (bg-[#f8f9fb] / dark:bg-[#17181c])
            max-h 钉住胶囊高度（无图 88px，有图 138px）：打开知识库面板时原生窗口会被撑高，
            胶囊本身不该跟着拉伸（面板是覆盖型抽屉，不参与胶囊布局） */}
        <div className={`w-full h-full ${images.length > 0 ? 'max-h-[138px]' : 'max-h-[88px]'} bg-[#f8f9fb] dark:bg-[#17181c] border border-black/10 dark:border-white/10 rounded-[22px] p-2 overflow-hidden flex flex-col justify-center`}>
          {/* Hidden file input */}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={async (e) => {
              const files = Array.from(e.target.files || []);
              if (files.length > 0) {
                const urls = await Promise.all(files.map(fileToDataURL));
                setImages((prev) => [...prev, ...urls]);
              }
            }}
          />

          {/* Inner Input Card (concentric radius: 22px - 8px = 14px) */}
          <div className="w-full h-full bg-white dark:bg-[#25262c] border border-black/10 dark:border-white/10 rounded-[14px] px-3 py-1 flex flex-col justify-between">
            {/* Top text input row */}
            <div className="px-0.5 pt-0.5">
              <textarea
                ref={textareaRef}
                rows={1}
                value={input}
                onChange={(e) => {
                  setInput(e.target.value);
                  cursorPositionRef.current = e.target.selectionStart;
                }}
                onSelect={(e) => {
                  cursorPositionRef.current = (e.target as HTMLTextAreaElement).selectionStart;
                }}
                {...inputImeBindings}
                onPaste={handlePaste}
                placeholder={t('placeholderInitial')}
                data-chat-input="true"
                autoFocus
                className="w-full bg-transparent text-[14px] text-[#1f2328] dark:text-[#f1f3f7] placeholder-zinc-400 dark:placeholder-zinc-500 focus:outline-none font-normal resize-none leading-relaxed min-h-[22px] max-h-[160px] [overflow-anchor:none]"
              />
            </div>

            {/* Image preview pills if pasted / dropped */}
            {images.length > 0 && (
              <div className="flex items-center gap-2.5 px-1 pt-2.5 pb-1 overflow-x-auto no-scrollbar">
                {images.map((img, idx) => (
                  <div key={idx} className="relative group flex-shrink-0 mt-0.5 mr-1">
                    <img
                      src={img}
                      alt={`draft-${idx}`}
                      className="w-8 h-8 rounded-lg object-cover border border-black/10 dark:border-white/20 bg-zinc-100 dark:bg-zinc-800"
                    />
                    <button
                      type="button"
                      onClick={() => handleRemoveDraftImage(idx)}
                      className="absolute -top-1.5 -right-1.5 w-4 h-4 bg-black/70 hover:bg-red-500 text-white rounded-full flex items-center justify-center transition-colors shadow-xs cursor-pointer z-10"
                      title={t('removeImage')}
                    >
                      <X className="w-2.5 h-2.5 stroke-[2.5]" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* Bottom actions row: Left (Attachment + Think + Wiki), Right (Send + ContextRing) */}
            <div className="flex items-center justify-between px-0.5 pb-0.5 select-none">
              {/* Left: Attachment + Thinking Toggle + Offline Wiki Toggle */}
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className={`w-6 h-6 rounded-full flex items-center justify-center transition-colors ${
                    images.length > 0
                      ? 'bg-blue-600 text-white'
                      : 'bg-black/5 hover:bg-black/10 text-zinc-600 hover:text-black dark:bg-white/5 dark:hover:bg-white/10 dark:text-zinc-300 dark:hover:text-white'
                  }`}
                  title={t('attachImage')}
                >
                  <Plus className="w-3.5 h-3.5 stroke-[2.5]" />
                </button>

                {/* Direct Toggle Button (⚡ 快速 / 🧠 思考) */}
                <button
                  type="button"
                  onClick={() => toggleThinking(!enableThinking)}
                  className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium transition-all active:scale-95 border ${
                    enableThinking
                      ? 'bg-blue-50 text-blue-700 border-blue-200 hover:bg-blue-100 dark:bg-blue-950/70 dark:text-blue-300 dark:border-blue-500/40 dark:hover:bg-blue-900/80'
                      : 'bg-black/5 text-zinc-600 border-black/5 hover:bg-black/10 hover:text-black dark:bg-white/5 dark:text-zinc-300 dark:border-white/5 dark:hover:bg-white/10 dark:hover:text-white'
                  }`}
                  title={enableThinking ? t('thinkingOnTooltip') : t('thinkingOffTooltip')}
                >
                  {enableThinking ? (
                    <>
                      <Brain className="w-3.5 h-3.5 text-blue-500 dark:text-blue-400" />
                      <span>{t('thinkingOn')}</span>
                    </>
                  ) : (
                    <>
                      <Zap className="w-3.5 h-3.5 text-amber-500 dark:text-amber-400" />
                      <span>{t('thinkingOff')}</span>
                    </>
                  )}
                </button>

                {/* Offline Wiki Knowledge Toggle Button — 服务总开关关闭时完全不渲染，DeepSeek模式下显示不可用 */}
                {wikiStatus.enabled && (<button
                  type="button"
                  onClick={() => !isDeepSeek && wikiStatus.connected && toggleWiki(!enableWikiSearch)}
                  disabled={isDeepSeek || !wikiStatus.connected}
                  className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium transition-all active:scale-95 border ${
                    isDeepSeek || !wikiStatus.connected
                      ? 'opacity-40 cursor-not-allowed bg-black/5 text-zinc-400 dark:bg-white/5 dark:text-zinc-500 border-transparent'
                      : enableWikiSearch
                      ? 'bg-emerald-50 text-emerald-700 border-emerald-200 hover:bg-emerald-100 dark:bg-emerald-950/70 dark:text-emerald-300 dark:border-emerald-500/40 dark:hover:bg-emerald-900/80'
                      : 'bg-black/5 text-zinc-600 border-black/5 hover:bg-black/10 hover:text-black dark:bg-white/5 dark:text-zinc-300 dark:border-white/5 dark:hover:bg-white/10 dark:hover:text-white'
                  }`}
                  title={
                    isDeepSeek
                      ? t('wikiDisabledInDeepSeek')
                      : !wikiStatus.connected
                      ? t('wikiDisconnectedTooltip')
                      : enableWikiSearch
                      ? t('wikiSearchOnTooltip')
                      : t('wikiSearchOffTooltip')
                  }
                >
                  <BookOpen className={`w-3.5 h-3.5 ${!isDeepSeek && enableWikiSearch && wikiStatus.connected ? 'text-emerald-600 dark:text-emerald-400' : ''}`} />
                  <span>{t('offlineWiki')}</span>
                </button>)}
              </div>

              {/* Right: Search (opens knowledge panel) + Send Button + Context Ring to its right */}
              <div className="flex items-center gap-2">
                {wikiSearchButton}

                <button
                  type="button"
                  onClick={handleSend}
                  disabled={!input.trim() && images.length === 0}
                  className={`w-7 h-7 rounded-full flex items-center justify-center transition-all ${
                    input.trim() || images.length > 0
                      ? 'bg-zinc-900 hover:bg-black text-white dark:bg-white dark:hover:bg-zinc-200 dark:text-black active:scale-95'
                      : 'bg-zinc-200 text-zinc-400 dark:bg-[#35363d] dark:text-zinc-500 cursor-not-allowed'
                  }`}
                  title={t('spotlightSend')}
                >
                  <ArrowUp className="w-3.5 h-3.5 stroke-[2.5]" />
                </button>

                <ContextRing usedTokens={displayTokens} maxContext={settings.maxContext} placement="left" />
              </div>
            </div>
          </div>
        </div>

        {/* Wikipedia Offline Article Reader Drawer (胶囊态同样可搜索) */}
        {wikiDrawerNode}
      </div>
    );
  }

  /* ========================================================================= */
  /* STATE 2: EXPANDED CONVERSATION CARD (Clean flat surface, NO shadows)      */
  /* ========================================================================= */
  return (
    <div
      className="w-full h-full select-none bg-transparent relative"
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {isDragOver && (
        <div className="absolute inset-0 z-50 bg-blue-500/20 dark:bg-blue-400/20 backdrop-blur-[2px] border-2 border-dashed border-blue-500 dark:border-blue-400 rounded-[22px] flex items-center justify-center pointer-events-none">
          <span className="text-xs font-semibold text-blue-600 dark:text-blue-300 bg-white/95 dark:bg-[#1f2024]/95 px-3 py-1 rounded-full shadow-md border border-blue-500/30">
            {t('dropImagesHere')}
          </span>
        </div>
      )}
      <div className="w-full h-full flex flex-col bg-white dark:bg-[#1c1d22] border border-black/10 dark:border-white/10 rounded-[22px] overflow-hidden text-[#1f2328] dark:text-[#f1f3f7] select-none">
        {/* Top Header Row */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-black/5 dark:border-white/5 cursor-grab active:cursor-grabbing select-none">
          {/* Left: ✖ inside circle + Title + Status dot */}
          <div className="flex items-center gap-2.5">
            <button
              onClick={closeSpotlightWindow}
              className="w-5 h-5 rounded-full bg-black/5 hover:bg-black/10 dark:bg-white/10 dark:hover:bg-white/20 flex items-center justify-center text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-white transition-colors cursor-pointer"
              title={t('close')}
            >
              <X className="w-3 h-3" />
            </button>
            <span className="font-semibold text-sm text-[#1f2328] dark:text-[#f1f3f7] tracking-tight">
              SimpleUI
            </span>
            <span
              className={`w-1.5 h-1.5 rounded-full ${
                healthInfo.online ? 'bg-emerald-500' : 'bg-red-400'
              }`}
              title={healthInfo.online ? t('serviceReady') : t('serviceNotReady')}
            />
          </div>

          {/* Right: New Chat + Expand to Main Window */}
          <div className="flex items-center gap-1.5 text-zinc-500 dark:text-zinc-400">
            <button
              onClick={handleNewChat}
              className="p-1.5 rounded-lg hover:bg-black/5 dark:hover:bg-white/5 hover:text-zinc-900 dark:hover:text-white transition-colors cursor-pointer"
              title={t('newChat')}
            >
              <MessageSquarePlus className="w-4 h-4" />
            </button>

            <button
              onClick={handleOpenInMain}
              className="p-1.5 rounded-lg hover:bg-black/5 dark:hover:bg-white/5 hover:text-zinc-900 dark:hover:text-white transition-colors cursor-pointer"
              title={t('openInMainWindow')}
            >
              <Maximize2 className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Message Scroll Area（仅在思考期由 useFollowBottom 钉底，用户一动即释放，与主窗口一致） */}
        <div
          {...streamProps}
          onWheel={(e) => {
            handleUserScrollAction();
            streamProps.onWheel?.(e);
          }}
          onTouchMove={(e) => {
            handleUserScrollAction();
            streamProps.onTouchMove?.(e);
          }}
          onMouseDown={(e) => {
            handleUserScrollAction();
            streamProps.onMouseDown?.(e);
          }}
          onKeyDown={(e) => {
            handleUserScrollAction();
            streamProps.onKeyDown?.(e);
          }}
          className="flex-1 min-h-0 overflow-y-auto p-4 pb-6 space-y-4 text-sm overscroll-y-contain [overflow-anchor:none]"
        >
          {messages.map((msg) => {
            if (msg.role === 'user') {
              const isCopied = copiedMsgId === msg.id;
              return (
                <div key={msg.id} className="flex flex-col items-end group">
                  <div className="max-w-[85%] bg-blue-600 text-white rounded-2xl px-4 py-2.5 text-[14.5px] leading-relaxed break-words shadow-sm">
                    {msg.images && msg.images.length > 0 && (
                      <div className="flex flex-wrap gap-2 mb-2">
                        {msg.images.map((url, i) => (
                          <img
                            key={i}
                            src={url}
                            alt="preview"
                            className="max-w-[180px] max-h-[180px] rounded-lg object-cover"
                          />
                        ))}
                      </div>
                    )}
                    {msg.content}
                  </div>

                  {/* User question action bar: icon-only Copy + Retry（重新发送本轮，生成中先停止） */}
                  <div className="mt-1 flex items-center pr-1.5 opacity-60 group-hover:opacity-100 transition-opacity">
                    <button
                      onClick={() => handleCopyText(msg.id, msg.content)}
                      className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-700 hover:bg-black/5 dark:text-zinc-500 dark:hover:text-zinc-200 dark:hover:bg-white/5 transition-colors cursor-pointer"
                      title={isCopied ? t('copied') : t('copyQuestionTooltip')}
                    >
                      {isCopied ? (
                        <Check className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
                      ) : (
                        <Copy className="w-3.5 h-3.5" />
                      )}
                    </button>
                    <button
                      onClick={() => {
                        // 重试本轮：找到紧随其后的助手回复，走统一的 handleRetry
                        // （内部会先停止正在进行的生成，再重新发送）
                        const idx = messages.findIndex((m) => m.id === msg.id);
                        const replyId = messages[idx + 1]?.id;
                        if (replyId) handleRetry(replyId);
                      }}
                      className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-700 hover:bg-black/5 dark:text-zinc-500 dark:hover:text-zinc-200 dark:hover:bg-white/5 transition-colors cursor-pointer"
                      title={t('retryTooltip')}
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              );
            }

            // Assistant message
            return (
              <div key={msg.id} className="space-y-2">
                {/* 知识库 / 引擎阶段阶梯 —— 与主窗口**同一个组件**（StageLadder），
                    渲染在思考条上方，思考条始终在最下面。 */}
                <StageLadder
                  messageId={msg.id}
                  records={msg.stages}
                  recording={
                    // 只有本窗口发起的回合才记录（abortControllerRef 仅在本窗口发起时非空）；
                    // 用 isGenerating 会把镜像过来的回合也当成自己的、两个窗口双写
                    !!abortControllerRef.current &&
                    !!msg.pending &&
                    !msg.content &&
                    !msg.reasoningContent &&
                    !msg.error
                  }
                  phasesActive={!!msg.pending && !msg.error}
                  turnStage={msg.stage}
                  prefillStartedAt={msg.prefillStartedAt}
                  onRecordsChange={handleStagesChange}
                />
                {/* Thinking accordion */}
                {(msg.reasoningContent || msg.isThinking) && (
                  <ThinkingAccordion
                    content={msg.reasoningContent}
                    isThinking={msg.isThinking}
                    duration={msg.thinkingDuration}
                  />
                )}

                {/* Message Markdown content */}
                {msg.content && (
                  <div className="text-[14.5px] leading-relaxed text-[#1f2328] dark:text-[#ecedf1]">
                    <MarkdownRenderer content={msg.content} />
                  </div>
                )}

                {/* Citations if any */}
                {msg.citations && msg.citations.length > 0 && (
                  <div className="mt-2.5 flex flex-wrap items-center gap-1.5 select-none animate-in fade-in duration-200">
                    <span className="text-[11px] font-medium text-zinc-400 dark:text-zinc-500 mr-1 flex items-center gap-1">
                      <BookOpen className="w-3.5 h-3.5 text-emerald-500" />
                      {t('wikiCitations')}:
                    </span>
                    {msg.citations.map((c, idx) => (
                      <button
                        key={idx}
                        type="button"
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          setActiveWikiArticle(c.title);
                          setActiveWikiContext(c.context ?? null);
                        }}
                        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs bg-emerald-500/10 hover:bg-emerald-500/20 active:bg-emerald-500/30 text-emerald-700 dark:text-emerald-300 border border-emerald-500/20 hover:border-emerald-500/35 transition-all hover:scale-[1.02] active:scale-[0.98] cursor-pointer select-none"
                        title={c.title}
                      >
                        <span className="font-medium truncate max-w-[200px] pointer-events-none select-none">{c.title}</span>
                        <ExternalLink className="w-3 h-3 opacity-60 pointer-events-none flex-shrink-0" />
                      </button>
                    ))}
                  </div>
                )}

                {/* Error if any */}
                {msg.error && (
                  <div className="p-2.5 rounded-lg bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-800/60 text-xs text-red-600 dark:text-red-300">
                    {msg.error}
                  </div>
                )}

                {/* Action Toolbar under message: Action buttons (Copy, Retry, Delete) - NO TEXT + Metrics
                    条件不用 content：思考/prefill 阶段中断时 content 为空，但回合已结束，
                    操作按钮与指标同样应该显示。生成中（isGenerating）则不显示。 */}
                {/* 页脚按消息判断（与主窗口一致）：生成中历史回合的页脚不受影响，
                    仅当前回合在 prefill/思考期隐藏；修复"生成中所有页脚消失" */}
                {!msg.isThinking && !msg.pending && (
                  <div className="mt-2 flex items-center gap-3 select-none">
                    <div className="flex items-center gap-0.5 text-zinc-500 dark:text-zinc-400">
                      {/* 复制 */}
                      <button
                        onClick={() => handleCopyText(msg.id, msg.content)}
                        className="p-1.5 rounded-lg hover:text-zinc-900 hover:bg-black/5 dark:hover:text-white dark:hover:bg-white/5 transition-colors cursor-pointer"
                        title={copiedMsgId === msg.id ? t('copied') : t('copyTooltip')}
                      >
                        {copiedMsgId === msg.id ? (
                          <Check className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
                        ) : (
                          <Copy className="w-3.5 h-3.5" />
                        )}
                      </button>

                      {/* 查看原始 Markdown */}
                      {msg.content && (
                        <button
                          onClick={() => setRawMarkdownTarget(msg.content)}
                          className="p-1.5 rounded-lg hover:text-zinc-900 hover:bg-black/5 dark:hover:text-white dark:hover:bg-white/5 transition-colors cursor-pointer"
                          title={t('viewRawMarkdown')}
                        >
                          <FileText className="w-3.5 h-3.5" />
                        </button>
                      )}

                      {/* 重试 */}
                      <button
                        onClick={() => handleRetry(msg.id)}
                        className="p-1.5 rounded-lg hover:text-zinc-900 hover:bg-black/5 dark:hover:text-white dark:hover:bg-white/5 transition-colors cursor-pointer"
                        title={t('retryTooltip')}
                      >
                        <RotateCcw className="w-3.5 h-3.5" />
                      </button>

                      {/* 删除此轮对话 (连带删除问和答) */}
                      <button
                        onClick={() => handleDeleteTurn(msg.id)}
                        className="p-1.5 rounded-lg hover:text-red-600 hover:bg-red-500/10 dark:hover:text-red-400 dark:hover:bg-red-500/10 transition-colors cursor-pointer"
                        title={t('deleteTurnTooltip')}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>

                    {/* Gray Prefill & tok/s metrics —— 与主窗口一致：prefill 只留速度不留耗时
                        （耗时由上方阶段阶梯的「正在载入上下文」那行承担） */}
                    {msg.metrics && (
                      <span className="text-xs font-mono text-zinc-500 dark:text-zinc-400">
                        {msg.metrics.ttftMs > 0 && msg.metrics.promptTokens > 0
                          ? `${t('metricsPrefill')} ${(msg.metrics.promptTokens / (msg.metrics.ttftMs / 1000)).toFixed(1)} tok/s · `
                          : ''}
                        {`${t('metricsDecode')} ${msg.metrics.tokensPerSecond} tok/s`}
                      </span>
                    )}
                  </div>
                )}
              </div>
            );
          })}
          <div ref={scrollEndRef} className="h-6 flex-shrink-0" />
        </div>

        {/* Bottom Input Capsule */}
        <div className="p-2.5 bg-[#f8f9fb] dark:bg-[#17181c] border-t border-black/5 dark:border-white/5">
          <div className="bg-white dark:bg-[#25262c] border border-black/10 dark:border-white/10 rounded-[16px] overflow-hidden flex flex-col justify-between">
            <ImageAttachment
              images={images}
              onRemove={handleRemoveDraftImage}
            />

            <div className="p-2 flex flex-col justify-between">
              <textarea
                ref={textareaRef}
                rows={1}
                value={input}
                onChange={(e) => {
                  setInput(e.target.value);
                  cursorPositionRef.current = e.target.selectionStart;
                }}
                onSelect={(e) => {
                  cursorPositionRef.current = (e.target as HTMLTextAreaElement).selectionStart;
                }}
                {...inputImeBindings}
                onPaste={handlePaste}
                placeholder={hasMessages ? t('spotlightInputPlaceholder') : t('placeholderInitial')}
                data-chat-input="true"
                autoFocus
                className="w-full bg-transparent text-sm text-[#1f2328] dark:text-[#f1f3f7] placeholder-zinc-400 dark:placeholder-zinc-500 px-2 py-1 focus:outline-none resize-none leading-relaxed min-h-[26px] max-h-[160px] [overflow-anchor:none]"
              />

            <div className="flex items-center justify-between pt-1">
              {/* Left: Attachment + Dual Mode Thinking + Offline Wiki */}
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="w-6 h-6 rounded-full flex items-center justify-center bg-black/5 hover:bg-black/10 text-zinc-600 hover:text-black dark:bg-white/5 dark:hover:bg-white/10 dark:text-zinc-300 dark:hover:text-white transition-colors"
                  title={t('spotlightAddImage')}
                >
                  <Plus className="w-3.5 h-3.5 stroke-[2.5]" />
                </button>

                <button
                  type="button"
                  onClick={() => toggleThinking(!enableThinking)}
                  className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium transition-all active:scale-95 border ${
                    enableThinking
                      ? 'bg-blue-50 text-blue-700 border-blue-200 hover:bg-blue-100 dark:bg-blue-950/70 dark:text-blue-300 dark:border-blue-500/40 dark:hover:bg-blue-900/80'
                      : 'bg-black/5 text-zinc-600 border-black/5 hover:bg-black/10 hover:text-black dark:bg-white/5 dark:text-zinc-300 dark:border-white/5 dark:hover:bg-white/10 dark:hover:text-white'
                  }`}
                  title={enableThinking ? t('thinkingOnTooltip') : t('thinkingOffTooltip')}
                >
                  {enableThinking ? (
                    <>
                      <Brain className="w-3.5 h-3.5 text-blue-500 dark:text-blue-400" />
                      <span>{t('thinkingOn')}</span>
                    </>
                  ) : (
                    <>
                      <Zap className="w-3.5 h-3.5 text-amber-500 dark:text-amber-400" />
                      <span>{t('thinkingOff')}</span>
                    </>
                  )}
                </button>

                {/* Offline Wiki Knowledge Toggle Button — 服务总开关关闭时完全不渲染，DeepSeek模式下显示不可用 */}
                {wikiStatus.enabled && (<button
                  type="button"
                  onClick={() => !isDeepSeek && wikiStatus.connected && toggleWiki(!enableWikiSearch)}
                  disabled={isDeepSeek || !wikiStatus.connected}
                  className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium transition-all active:scale-95 border ${
                    isDeepSeek || !wikiStatus.connected
                      ? 'opacity-40 cursor-not-allowed bg-black/5 text-zinc-400 dark:bg-white/5 dark:text-zinc-500 border-transparent'
                      : enableWikiSearch
                      ? 'bg-emerald-50 text-emerald-700 border-emerald-200 hover:bg-emerald-100 dark:bg-emerald-950/70 dark:text-emerald-300 dark:border-emerald-500/40 dark:hover:bg-emerald-900/80'
                      : 'bg-black/5 text-zinc-600 border-black/5 hover:bg-black/10 hover:text-black dark:bg-white/5 dark:text-zinc-300 dark:border-white/5 dark:hover:bg-white/10 dark:hover:text-white'
                  }`}
                  title={
                    isDeepSeek
                      ? t('wikiDisabledInDeepSeek')
                      : !wikiStatus.connected
                      ? t('wikiDisconnectedTooltip')
                      : enableWikiSearch
                      ? t('wikiSearchOnTooltip')
                      : t('wikiSearchOffTooltip')
                  }
                >
                  <BookOpen className={`w-3.5 h-3.5 ${!isDeepSeek && enableWikiSearch && wikiStatus.connected ? 'text-emerald-600 dark:text-emerald-400' : ''}`} />
                  <span>{t('offlineWiki')}</span>
                </button>)}
              </div>

              {/* Right: Search (opens knowledge panel) + Send Button + Context Ring */}
              <div className="flex items-center gap-2">
                {wikiSearchButton}

                {isGenerating ? (
                  <button
                    type="button"
                    onClick={handleStop}
                    className="w-7 h-7 rounded-full bg-red-500 hover:bg-red-600 text-white flex items-center justify-center transition-transform active:scale-95"
                    title={t('stop')}
                  >
                    <Square className="w-3 h-3 fill-white" />
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={handleSend}
                    disabled={!input.trim() && images.length === 0}
                    className={`w-7 h-7 rounded-full flex items-center justify-center transition-all ${
                      input.trim() || images.length > 0
                        ? 'bg-zinc-900 hover:bg-black text-white dark:bg-white dark:hover:bg-zinc-200 dark:text-black active:scale-95'
                        : 'bg-zinc-200 text-zinc-400 dark:bg-[#35363d] dark:text-zinc-500 cursor-not-allowed'
                    }`}
                    title={t('spotlightSend')}
                  >
                    <ArrowUp className="w-3.5 h-3.5 stroke-[2.5]" />
                  </button>
                )}

                <ContextRing usedTokens={displayTokens} maxContext={settings.maxContext} />
              </div>
            </div>
          </div>
        </div>
      </div>
      </div>

      {/* Wikipedia Offline Article Reader Drawer */}
      {wikiDrawerNode}

      {/* 原始 Markdown 弹窗 */}
      <RawMarkdownModal
        isOpen={rawMarkdownTarget !== null}
        onClose={() => setRawMarkdownTarget(null)}
        content={rawMarkdownTarget || ''}
        isSpotlight
      />
    </div>
  );
};
