import React, { useState, useEffect, useLayoutEffect, useRef, useCallback } from 'react';
import {
  AppSettings,
  ServerHealthInfo,
  WikiStatusInfo,
} from '../types/chat';
import {
  loadSettings,
  syncChannel,
} from '../services/storage';
import { TurboFieldfareAPI, WikiAPI } from '../services/api';
import {
  buildSessionSettings,
  getActiveContextMessages,
} from '../services/chatTurn';
import { MarkdownRenderer } from './MarkdownRenderer';
import { MessageSpeechBar, MessageSpeechTrigger } from './MessageSpeech';
import { ThinkingAccordion } from './ThinkingAccordion';
import { StageLadder } from './StageLadder';
import { ImageAttachment } from './ImageAttachment';
import { ContextRing } from './ContextRing';
import { extractImagesFromPaste, fileToDataURL, isImageFile } from '../utils/image';
import { useImeInput } from '../hooks/useImeInput';
import { useSessionStore } from '../hooks/useSessionStore';
import { useChatFontSize } from '../hooks/useChatFontSize';
import { useTurnWindow } from '../hooks/useTurnWindow';
import { TurnRail } from './TurnRail';
import { MeasuredTurn } from './MeasuredTurn';
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
import { SpotlightPageLayer } from './SpotlightPageLayer';
import { useSpotlightPage } from '../hooks/useSpotlightPage';
import { useI18n } from '../i18n';
import { useTheme } from '../hooks/useTheme';
import { estimateHistoryTokens, applyTokenCalibration } from '../utils/token';

export const SpotlightView: React.FC = () => {
  const { t, lang } = useI18n();
  const defaultTitle = lang === 'en' ? 'New Chat' : '新对话';
  const [settings, setSettings] = useState<AppSettings>(loadSettings());
  useTheme(settings.theme, true);

  const [input, setInput] = useState('');
  const [images, setImages] = useState<string[]>([]);
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
  const [copiedMsgId, setCopiedMsgId] = useState<string | null>(null);
  /**
   * 浮窗的整页浏览：搜索 / 条目 / 原文 / 图片共用一条页面栈。
   * **没有标签栏**（500px 宽放不下），也不与主窗口共享任何状态。
   */
  const page = useSpotlightPage();

  // 页面模式改变时通知原生 AppKit 顶栏拖拽遮罩（SpotlightDragView）切换对应的可拖拽区域与光标
  useEffect(() => {
    // @ts-expect-error WebKit bridge
    if (window.webkit?.messageHandlers?.spotlightPageStateChanged) {
      const pageKind = page.top?.kind ?? 'chat';
      const depth = page.depth;
      // @ts-expect-error WebKit bridge
      window.webkit.messageHandlers.spotlightPageStateChanged.postMessage({
        page: pageKind,
        depth,
      });
    }
  }, [page.top?.kind, page.depth]);

  // 对话内容字号独立调节（小窗口快捷键 ⌘+ / ⌘-，不影响其他区域）
  const { fontSize: chatFontSize } = useChatFontSize({
    storageKey: 'simpleui_spotlight_chat_font_size',
    defaultSize: 14.5,
    minSize: 12,
    maxSize: 22,
  });

  // Track last resize payload sent to native bridge to avoid redundant postMessages
  const lastResizeSentRef = useRef<{ width: number; height: number; expanded: boolean } | null>(null);
  // Protect Spotlight from stale focus/shown collapse or idle reset during Main -> Spotlight handoff
  const handoffLockUntilRef = useRef<number>(0);
  const imagesRef = useRef<string[]>(images);
  imagesRef.current = images;

  // Notify native AppKit panel to resize dynamically
  const notifyResize = useCallback((expanded: boolean, hasImages: boolean = false, force: boolean = false) => {
    // During an active Main -> Spotlight handoff window, never allow a stale false resize to shrink the panel
    if (!expanded && Date.now() < handoffLockUntilRef.current) {
      return;
    }
    // @ts-expect-error WebKit bridge
    if (window.webkit?.messageHandlers?.resizePanel) {
      const width = expanded ? 500 : 540;
      const height = expanded ? 640 : (hasImages ? 138 : 88);
      const last = lastResizeSentRef.current;
      if (!force && last && last.width === width && last.height === height && last.expanded === expanded) {
        return;
      }
      lastResizeSentRef.current = { width, height, expanded };
      // @ts-expect-error WebKit bridge
      window.webkit.messageHandlers.resizePanel.postMessage({
        width,
        height,
        expanded,
      });
    }
  }, []);

  // Record user activity timestamp in localStorage
  const recordActivity = useCallback(() => {
    try {
      localStorage.setItem('tff_spotlight_last_active_v1', Date.now().toString());
    } catch {
      // ignore
    }
  }, []);

  const {
    sessions,
    currentSessionId,
    currentSession,
    messages,
    isGenerating,
    liveStreamingTokens,
    selectSession,
    createOrReuseEmptySession,
    updateSessionMeta,
    sendTurn,
    abortTurn,
    retryTurn,
    deleteTurn,
    handoffToMain,
    refreshState,
  } = useSessionStore('SPOTLIGHT', defaultTitle, (expanded) => {
    if (expanded) {
      handoffLockUntilRef.current = Date.now() + 2500;
    }
    recordActivity();
    notifyResize(expanded, imagesRef.current.length > 0, true);
  });

  // Fallback local toggles when currentSession is not yet bound
  const [localThinking, setLocalThinking] = useState(false);
  const [localWiki, setLocalWiki] = useState(false);
  const enableThinking = currentSession ? (currentSession.enableThinking ?? false) : localThinking;
  const enableWikiSearch = currentSession ? (currentSession.enableWikiSearch ?? false) : localWiki;

  // Clean persistent conversation history tokens (user text + assistant text only)
  const persistentHistoryTokens = React.useMemo(() => {
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
  const displayTokens =
    isGenerating && currentLiveTokens !== undefined ? currentLiveTokens : persistentHistoryTokens;

  const isGeneratingRef = useRef(false);
  isGeneratingRef.current = isGenerating;
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const sessionsListRef = useRef(sessions);
  sessionsListRef.current = sessions;
  const inputRef = useRef('');
  inputRef.current = input;
  const settingsRef = useRef<AppSettings>(settings);
  settingsRef.current = settings;
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const cursorPositionRef = useRef<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const scrollEndRef = useRef<HTMLDivElement>(null);
  const prevSessionIdRef = useRef<string | null | undefined>(undefined);
  const prevLastUserMsgIdRef = useRef<string | undefined>(undefined);

  const hasMessages = messages.length > 0;
  /**
   * 「多行输入」= 有换行符 **或** 已经自然折行。
   *
   * 只判 `input.includes('\n')` 是不够的：不打 Shift+Enter 的长句同样会折行，而胶囊（540×88）
   * 装不下它就溢出到按钮行。折行是排版事实，只能**量**（见下面 `inputWrapped` 的测量 effect）。
   */
  const [inputWrapped, setInputWrapped] = useState(false);
  /**
   * 输入法合成态：合成期间**只量高度、不切换形态**。
   * 切换形态会换掉 `<textarea>` 实例 → 合成被中断、未上屏的拼音直接丢。
   * 用 capture 阶段的原生事件跟踪（不覆盖 `inputImeBindings` 里的 React 处理器）。
   */
  const composingRef = useRef(false);
  const [composeTick, setComposeTick] = useState(0);
  useEffect(() => {
    const onStart = () => {
      composingRef.current = true;
    };
    const onEnd = () => {
      composingRef.current = false;
      setComposeTick((t) => t + 1); // 合成结束补一次判定（有时没有后续 input 事件）
    };
    document.addEventListener('compositionstart', onStart, true);
    document.addEventListener('compositionend', onEnd, true);
    return () => {
      document.removeEventListener('compositionstart', onStart, true);
      document.removeEventListener('compositionend', onEnd, true);
    };
  }, []);

  const isMultiline = input.includes('\n') || inputWrapped;
  const isExpanded = hasMessages || isGenerating || isMultiline;

  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);

  /** 与主窗口同一套窗口化 + 定位横线（浮窗用紧凑刻度） */
  const {
    visibleTurns,
    turns,
    centerIndex,
    startIndex,
    endIndex,
    centerOnLatest,
    jumpTo,
    topSpacer,
    bottomSpacer,
    onMeasure,
    visitedKeys,
  } = useTurnWindow({
    messages,
    sessionId: currentSessionId,
    containerRef: scrollContainerRef,
    contentRef,
  });

  /**
   * 自动切入空白会话（复用已有空会话，若无则新建）。
   * 注意：origin='SPOTLIGHT' 仅改变浮窗自身的会话指针，绝不劫持主窗口正在查看的会话。
   */
  const initEmptySession = useCallback(async () => {
    handoffLockUntilRef.current = 0;
    await createOrReuseEmptySession(defaultTitle);
    setInput('');
    setImages([]);
    setLocalThinking(false);
    setLocalWiki(false);
    lastResizeSentRef.current = null;
    // 先清页面栈再缩窗口：顺序反了会出现「640 高的页面塞进 88px 胶囊」
    page.clear();
    notifyResize(false, false, true);
    recordActivity();
  }, [createOrReuseEmptySession, defaultTitle, notifyResize, recordActivity]);

  const handleNewChat = useCallback(async () => {
    if (isGeneratingRef.current && currentSessionId) {
      await abortTurn(currentSessionId);
    }
    await initEmptySession();
  }, [currentSessionId, abortTurn, initEmptySession]);

  // Auto-reset Spotlight to clean new chat after configured idle timeout
  const checkIdleReset = useCallback(() => {
    const resetMinutes = settingsRef.current.spotlightResetMinutes ?? 15;
    if (resetMinutes <= 0) return;

    if (isGeneratingRef.current || Date.now() < handoffLockUntilRef.current) {
      recordActivity();
      return;
    }

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
      console.log(
        `[Spotlight] Inactivity timeout (${Math.round(elapsedMs / 1000)}s >= ${resetMinutes * 60}s). Resetting to new chat.`
      );
      initEmptySession();
    }
  }, [initEmptySession, recordActivity]);

  // Periodic idle check
  useEffect(() => {
    recordActivity();
    const interval = setInterval(() => {
      checkIdleReset();
    }, 15000);
    return () => clearInterval(interval);
  }, [checkIdleReset, recordActivity]);

  // 首次挂载：进入空白会话胶囊态
  useEffect(() => {
    initEmptySession();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * 文本框自适应高度，**顺便量出「是否已经折行」**（胶囊 ↔ 展开卡的判据）。
   *
   * - 用 `useLayoutEffect`：量完立刻 setState，避免「先按 88px 画一帧胶囊、下一帧才展开」的闪跳；
   * - 行数用**计算样式里的 line-height 反推**（扣掉 padding），不写死像素 —— 字号设置变了也准；
   * - 两种形态的文本框宽度不同（胶囊 ~496 / 展开 ~448，展开更窄），所以"折行就展开、展开后只会更折"，
   *   不会出现「展开→不折→缩回→又折」的抖动。
   */
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const scrollHeight = el.scrollHeight;
    el.style.height = `${Math.min(Math.max(scrollHeight, 24), 160)}px`;

    // 输入法合成中不判折行：换 DOM 会打断拼音
    if (composingRef.current) return;

    const cs = getComputedStyle(el);
    const lineHeight = parseFloat(cs.lineHeight) || 22;
    const padY = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
    const lines = Math.round((scrollHeight - padY) / lineHeight);
    setInputWrapped(lines > 1);
  }, [input, isExpanded, composeTick]);

  // Retain focus and cursor position ONLY when transitioning between capsule and expanded card
  // (NEVER trigger on input.length changes, which corrupts active macOS WebKit IME composition!)
  const prevIsExpandedRef = useRef(isExpanded);
  useEffect(() => {
    const didTransition = prevIsExpandedRef.current !== isExpanded;
    prevIsExpandedRef.current = isExpanded;
    if (didTransition && textareaRef.current && messages.length === 0) {
      textareaRef.current.focus();
      const pos =
        cursorPositionRef.current !== null ? cursorPositionRef.current : inputRef.current.length;
      try {
        textareaRef.current.setSelectionRange(pos, pos);
      } catch {
        // ignore
      }
    }
  }, [isExpanded, messages.length]);

  // 页面开着的时候不要缩回胶囊：否则 640 高的页面会被塞进 88px 的窗口
  useEffect(() => {
    if (!page.top) {
      notifyResize(isExpanded, images.length > 0, true);
    }
  }, [isExpanded, images.length, page.top, notifyResize]);

  const closeSpotlightWindow = () => {
    // @ts-expect-error WebKit bridge
    window.webkit?.messageHandlers?.closeSpotlight?.postMessage?.({});
  };

  /** 打开整页前先确保窗口是展开态（胶囊 88px 高装不下页面） */
  const ensurePageExpanded = () => {
    if (!isExpanded) notifyResize(true, images.length > 0, true);
  };

  const openWikiSearchPage = () => {
    ensurePageExpanded();
    page.open({ kind: 'wiki-search', key: 'search' });
  };

  const openWikiArticlePage = (title: string, injected?: string | null) => {
    ensurePageExpanded();
    page.open({ kind: 'wiki-article', key: `article:${title}`, title, injected: injected ?? null });
  };

  const openRawTextPage = (messageId: string, content: string) => {
    ensurePageExpanded();
    page.open({ kind: 'raw-text', key: `raw:${messageId}`, title: '', content });
  };

  const openImagePage = (messageId: string, images: string[], index: number) => {
    ensurePageExpanded();
    page.open({ kind: 'image', key: `img:${messageId}`, images, index });
  };

  /** 会话切换 / 清空会话时收起页面栈（否则会盖在另一段对话上） */
  useEffect(() => {
    page.clear();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentSessionId]);

  const isDeepSeek = settings.apiProvider === 'deepseek';
  const isMference = settings.apiProvider === 'mference';

  useEffect(() => {
    if (isMference && images.length > 0) {
      setImages([]);
    }
  }, [isMference, images]);

  /** 知识库是否可用：服务开启 && ZIM 就绪 && 非 DeepSeek（与主窗口口径一致） */
  const kbReady = wikiStatus.enabled && wikiStatus.connected && !isDeepSeek;

  /**
   * 搜索按钮：整页打开搜索界面。
   * 不再随供应商置灰——DeepSeek / 未就绪时页面照开，内部显示统一「未连接」提示。
   */
  const wikiSearchButton = (
    <button
      type="button"
      onClick={openWikiSearchPage}
      data-spotlight-search="true"
      className="w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 transition-colors bg-black/5 hover:bg-black/10 text-zinc-600 hover:text-black dark:bg-white/5 dark:hover:bg-white/10 dark:text-zinc-300 dark:hover:text-white cursor-pointer"
      title={t('expandWikiPanel')}
    >
      <Search className="w-3.5 h-3.5 stroke-[2.5]" />
    </button>
  );

  /** 整页层：盖满卡片，渲染页面栈顶（没有栈就没有这个节点） */
  const pageLayerNode = page.top ? (
    <SpotlightPageLayer
      stack={page.stack}
      kbReady={kbReady}
      wikiEnabled={wikiStatus.enabled}
      onOpenArticle={(title) => openWikiArticlePage(title)}
      onBack={page.back}
      onClose={page.clear}
    />
  ) : null;

  /**
   * 浮窗外层消息容器滚动策略（与主窗口完全一致）：
   * 1. 切换到不同对话时（currentSessionId 变化）：自动定位到该对话的最底部；
   * 2. 用户刚发出新消息时（新的 user 消息插入）：定位一次到底部以露出新提问与思考手风琴头部；
   * 3. 思考过程流式输出（由 ThinkingAccordion 内部独立跟随滚动）、正式回答流式生成中、以及平时非生成状态：
   *    外层容器完全固定、绝不自动滚动、绝不抢夺用户的滚动条。
   */
  useEffect(() => {
    const isSessionSwitch = currentSessionId !== prevSessionIdRef.current;

    let lastUserMsgId: string | undefined = undefined;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') {
        lastUserMsgId = messages[i].id;
        break;
      }
    }
    const isNewUserTurnSent =
      !isSessionSwitch &&
      lastUserMsgId !== undefined &&
      lastUserMsgId !== prevLastUserMsgIdRef.current;

    prevSessionIdRef.current = currentSessionId;
    prevLastUserMsgIdRef.current = lastUserMsgId;

    // 会话切换由 useTurnWindow 统一贴底；这里只处理“刚发出新问题”
    if (isNewUserTurnSent) centerOnLatest();
  }, [currentSessionId, messages, centerOnLatest]);

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

  // Native bridge hook: Swift `showWithSession(sessionId:isExpanded:)` calls `window.loadSessionInSpotlight`
  useEffect(() => {
    // @ts-expect-error global hook for Swift showWithSession evaluation
    window.loadSessionInSpotlight = (sessionId: string, isExpandedHint?: boolean) => {
      if (!sessionId) return;
      recordActivity();
      selectSession(sessionId);
      const target = sessionsListRef.current.find((s) => s.id === sessionId);
      const hasMsgs = Boolean(target && target.messages && target.messages.length > 0);
      const targetExpanded = typeof isExpandedHint === 'boolean' ? isExpandedHint : hasMsgs;
      handoffLockUntilRef.current = targetExpanded ? Date.now() + 1200 : 0;
      lastResizeSentRef.current = null;
      notifyResize(targetExpanded, imagesRef.current.length > 0, true);
    };
    return () => {
      // @ts-expect-error global hook
      delete window.loadSessionInSpotlight;
    };
  }, [selectSession, recordActivity, notifyResize]);

  // Real-time synchronization of settings across windows
  useEffect(() => {
    if (!syncChannel) return;
    const handler = (event: MessageEvent) => {
      const data = event.data;
      if (!data) return;
      if (data.type === 'SETTINGS_CHANGED') {
        setSettings(loadSettings());
      }
    };
    syncChannel.addEventListener('message', handler);
    return () => syncChannel?.removeEventListener('message', handler);
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

  // Reload latest settings & sync in-memory state whenever Spotlight gains focus or is shown
  useEffect(() => {
    const handleFocusOrShown = () => {
      setSettings(loadSettings());
      WikiAPI.getStatus().then(setWikiStatus);
      if (Date.now() < handoffLockUntilRef.current) {
        recordActivity();
        refreshState(false);
        lastResizeSentRef.current = null;
        notifyResize(true, imagesRef.current.length > 0, true);
        return;
      }
      checkIdleReset();
      refreshState(false);
      const hasMsgs = messagesRef.current.length > 0 || isGeneratingRef.current;
      const isMulti = inputRef.current.includes('\n');
      lastResizeSentRef.current = null;
      notifyResize(hasMsgs || isMulti, imagesRef.current.length > 0, true);
    };

    // @ts-expect-error global hook for Swift show()
    window.onSpotlightShown = handleFocusOrShown;
    window.addEventListener('focus', handleFocusOrShown);

    return () => {
      // @ts-expect-error global hook
      delete window.onSpotlightShown;
      window.removeEventListener('focus', handleFocusOrShown);
    };
  }, [checkIdleReset, refreshState, notifyResize, recordActivity]);

  const toggleThinking = (enabled: boolean) => {
    setLocalThinking(enabled);
    if (currentSessionId) {
      updateSessionMeta(currentSessionId, { enableThinking: enabled });
    }
  };

  const toggleWiki = (enabled: boolean) => {
    setLocalWiki(enabled);
    if (currentSessionId) {
      updateSessionMeta(currentSessionId, { enableWikiSearch: enabled });
    }
  };

  const handleSend = async () => {
    const textToSend = input.trim();
    if (!textToSend && images.length === 0) return;
    if (isGenerating) return;

    const currentImages = [...images];
    setInput('');
    setImages([]);
    recordActivity();

    const effectiveEnableWiki = isDeepSeek ? false : enableWikiSearch;
    const sessionSettings = buildSessionSettings(settings, enableThinking, effectiveEnableWiki);

    await sendTurn({
      sessionId: currentSessionId,
      text: textToSend,
      images: currentImages,
      settings: sessionSettings,
      lang,
    });
  };

  const { imeBindings: inputImeBindings } = useImeInput<HTMLTextAreaElement>({
    onEnter: () => {
      handleSend();
    },
  });

  const handleRetry = async (assistantMessageId: string) => {
    recordActivity();
    const effectiveEnableWiki = isDeepSeek ? false : enableWikiSearch;
    const sessionSettings = buildSessionSettings(settings, enableThinking, effectiveEnableWiki);

    await retryTurn({
      assistantMessageId,
      settings: sessionSettings,
      lang,
      sessionId: currentSessionId,
    });
  };

  const handleDeleteTurn = async (assistantMessageId: string) => {
    recordActivity();
    const updated = await deleteTurn(assistantMessageId, currentSessionId);
    if (updated && (!updated.messages || updated.messages.length === 0)) {
      notifyResize(false, images.length > 0);
    }
  };

  const handleStop = async () => {
    recordActivity();
    if (currentSessionId) {
      await abortTurn(currentSessionId);
    }
  };

  const handleOpenInMain = useCallback(() => {
    if (currentSessionId) {
      handoffToMain(currentSessionId);
    }

    // 立即通知原生隐藏浮窗并唤起主窗口（只发一次，不阻塞等待 HTTP）
    // @ts-expect-error WebKit bridge
    if (window.webkit?.messageHandlers?.openMainWindow) {
      // @ts-expect-error WebKit bridge
      window.webkit.messageHandlers.openMainWindow.postMessage({});
    } else {
      // @ts-expect-error WebKit bridge
      window.webkit?.messageHandlers?.openMainFromSpotlight?.postMessage?.({});
    }

    // 延迟到浮窗隐藏动画后再静默解绑并恢复为空白胶囊态，避免与主窗口切入抢占算力
    window.setTimeout(() => {
      initEmptySession();
    }, 120);
  }, [currentSessionId, handoffToMain, initEmptySession]);

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
  }, [handleOpenInMain, recordActivity]);

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
    if (isMference) return;
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
    if (isMference) return;
    if (e.dataTransfer.types.includes('Files')) {
      dragCounterRef.current++;
      setIsDragOver(true);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    if (isMference) return;
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
    if (isMference) return;

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
    setImages((prev) => prev.filter((_, i) => i !== index));
  };

  /* ========================================================================= */
  /* STATE 1: INITIAL COMPACT INPUT CAPSULE (Clean flat surface, NO shadows)   */
  /* ========================================================================= */
  if (!isExpanded) {
    return (
      <div
        data-spot-view="capsule"
        className="w-full h-full select-none bg-transparent relative flex flex-col justify-end"
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
        <div className={`w-full h-full ${images.length > 0 ? 'max-h-[138px]' : 'max-h-[88px]'} bg-[#f8f9fb] dark:bg-[#17181c] border border-black/10 dark:border-white/10 rounded-[22px] p-2 overflow-hidden flex flex-col justify-center`}>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={async (e) => {
              if (isMference) return;
              const files = Array.from(e.target.files || []);
              if (files.length > 0) {
                const urls = await Promise.all(files.map(fileToDataURL));
                setImages((prev) => [...prev, ...urls]);
              }
            }}
          />

          <div className="w-full h-full bg-white dark:bg-[#25262c] border border-black/10 dark:border-white/10 rounded-[14px] px-3 py-1 flex flex-col justify-between">
            <div className="px-0.5 pt-0.5">
              <textarea
                ref={textareaRef}
                rows={1}
                value={input}
                onChange={(e) => {
                  setInput(e.target.value);
                  if (!(e.nativeEvent as InputEvent)?.isComposing) {
                    cursorPositionRef.current = e.target.selectionStart;
                  }
                }}
                {...inputImeBindings}
                onPaste={handlePaste}
                placeholder={t('placeholderInitial')}
                data-chat-input="true"
                autoFocus
                className="w-full bg-transparent text-[14px] text-[#1f2328] dark:text-[#f1f3f7] placeholder-zinc-400 dark:placeholder-zinc-500 focus:outline-none font-normal resize-none leading-relaxed min-h-[22px] max-h-[160px] [overflow-anchor:none]"
              />
            </div>

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

            <div className="flex items-center justify-between px-0.5 pb-0.5 select-none">
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  disabled={isMference}
                  onClick={isMference ? undefined : () => fileInputRef.current?.click()}
                  className={`w-6 h-6 rounded-full flex items-center justify-center transition-colors ${
                    isMference
                      ? 'opacity-40 text-zinc-400 dark:text-zinc-600 bg-black/5 dark:bg-white/5 cursor-not-allowed'
                      : images.length > 0
                      ? 'bg-blue-600 text-white cursor-pointer'
                      : 'bg-black/5 hover:bg-black/10 text-zinc-600 hover:text-black dark:bg-white/5 dark:hover:bg-white/10 dark:text-zinc-300 dark:hover:text-white cursor-pointer'
                  }`}
                  title={isMference ? t('visionDisabledMference') : t('attachImage')}
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

                {wikiStatus.enabled && (
                  <button
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
                    <BookOpen
                      className={`w-3.5 h-3.5 ${
                        !isDeepSeek && enableWikiSearch && wikiStatus.connected
                          ? 'text-emerald-600 dark:text-emerald-400'
                          : ''
                      }`}
                    />
                    <span>{t('offlineWiki')}</span>
                  </button>
                )}
              </div>

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

                <ContextRing
                  usedTokens={displayTokens}
                  maxContext={settings.maxContext}
                  placement="left"
                  showTooltip={false}
                />
              </div>
            </div>
          </div>
        </div>

        {pageLayerNode}
      </div>
    );
  }

  /* ========================================================================= */
  /* STATE 2: EXPANDED CONVERSATION CARD (Clean flat surface, NO shadows)      */
  /* ========================================================================= */
  return (
    <div
      data-spot-view="expanded"
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
        {/* 高度与页面二级头严格一致（52 含底边）：开页面时顶部带子不换厚度 → 内容不上跳 */}
        <div className="flex h-[52px] items-center justify-between px-4 border-b border-black/5 dark:border-white/5 cursor-grab active:cursor-grabbing select-none">
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

        {/* Message Scroll Area（只挂载当前轮 ± 2 轮，右侧紧凑版定位横线） */}
        <div className="relative flex-1 min-h-0">
        <div
          ref={scrollContainerRef}
          style={{
            '--chat-font-size': `${chatFontSize}px`,
          } as React.CSSProperties}
          className="chat-scroller h-full overflow-y-auto overflow-x-hidden scrollbar-invisible p-4 pr-[22px] pb-6 text-sm overscroll-y-contain"
        >
          <div ref={contentRef} data-chat-content="true">
          {topSpacer > 0 && (
            <div aria-hidden="true" style={{ height: topSpacer }} />
          )}
          {visibleTurns.map((turn) => (
          <MeasuredTurn
            key={turn.key}
            turnKey={turn.key}
            turnIndex={turn.index}
            onMeasure={onMeasure}
            className="space-y-4 pb-4"
          >
          {messages.slice(turn.startMessageIndex, turn.endMessageIndex + 1).map((msg) => {
            if (msg.role === 'user') {
              const isCopied = copiedMsgId === msg.id;
              return (
                <div key={msg.id} className="w-full min-w-0 flex flex-col items-end group">
                  <div
                    className="max-w-[85%] min-w-0 w-fit rounded-[20px] px-3.5 py-2 bg-[#e9ebf0] text-[#1f2328] dark:bg-[#2d3037] dark:text-[#f1f3f7] border border-black/5 dark:border-white/5 shadow-sm leading-relaxed break-words"
                    style={{ fontSize: 'var(--chat-font-size, 14.5px)' }}
                  >
                    {msg.images && msg.images.length > 0 && (
                      <div data-copy-ignore="true" className="flex flex-wrap gap-2 mb-2 select-none">
                        {msg.images.map((url, i) => (
                          <img
                            key={i}
                            src={url}
                            alt="preview"
                            draggable={false}
                            data-message-image="true"
                            onClick={() => openImagePage(msg.id, msg.images || [], i)}
                            className="max-w-[180px] max-h-[180px] rounded-xl object-cover border border-black/10 dark:border-white/10 shadow-sm select-none cursor-zoom-in hover:opacity-90 active:scale-[0.98] transition-all"
                          />
                        ))}
                      </div>
                    )}
                    <div data-readable="true" className="break-words leading-relaxed max-w-full min-w-0">
                      <MarkdownRenderer
                        content={msg.content}
                        breaks={true}
                        className="markdown-user text-[#1f2328] dark:text-[#f1f3f7] max-w-full min-w-0"
                      />
                    </div>
                  </div>

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
              <div key={msg.id} className="space-y-2 w-full min-w-0">
                <StageLadder
                  messageId={msg.id}
                  records={msg.stages}
                  phasesActive={!!msg.pending && !msg.error}
                  turnStage={msg.stage}
                  prefillStartedAt={msg.prefillStartedAt}
                />

                {(msg.reasoningContent || msg.isThinking) && (
                  <ThinkingAccordion
                    content={msg.reasoningContent}
                    isThinking={msg.isThinking}
                    duration={msg.thinkingDuration}
                  />
                )}

                {msg.content && (
                  <div
                    data-readable="true"
                    className="leading-relaxed min-w-0 max-w-full text-[#1f2328] dark:text-[#ecedf1]"
                    style={{ fontSize: 'var(--chat-font-size, 14.5px)' }}
                  >
                    <MarkdownRenderer content={msg.content} />
                  </div>
                )}

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
                          openWikiArticlePage(c.title, c.context ?? null);
                        }}
                        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs bg-emerald-500/10 hover:bg-emerald-500/20 active:bg-emerald-500/30 text-emerald-700 dark:text-emerald-300 border border-emerald-500/20 hover:border-emerald-500/35 transition-all hover:scale-[1.02] active:scale-[0.98] cursor-pointer select-none"
                        title={c.title}
                      >
                        <span className="font-medium truncate max-w-[200px] pointer-events-none select-none">
                          {c.title}
                        </span>
                        <ExternalLink className="w-3 h-3 opacity-60 pointer-events-none flex-shrink-0" />
                      </button>
                    ))}
                  </div>
                )}

                {msg.error && (
                  <div className="p-2.5 rounded-lg bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-800/60 text-xs text-red-600 dark:text-red-300">
                    {msg.error}
                  </div>
                )}

                {!msg.isThinking && !msg.pending && (
                  <div className="mt-2 flex items-center gap-3 select-none">
                    <div className="flex items-center gap-0.5 text-zinc-500 dark:text-zinc-400">
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

                      {msg.content && (
                        <button
                          data-open-raw="true"
                          onClick={() => openRawTextPage(msg.id, msg.content)}
                          className="p-1.5 rounded-lg hover:text-zinc-900 hover:bg-black/5 dark:hover:text-white dark:hover:bg-white/5 transition-colors cursor-pointer"
                          title={t('viewRawMarkdown')}
                        >
                          <FileText className="w-3.5 h-3.5" />
                        </button>
                      )}

                      {msg.content && (
                        <MessageSpeechTrigger
                          messageId={msg.id}
                          content={msg.content}
                          title={t('speakMessage')}
                        />
                      )}

                      <button
                        onClick={() => handleRetry(msg.id)}
                        className="p-1.5 rounded-lg hover:text-zinc-900 hover:bg-black/5 dark:hover:text-white dark:hover:bg-white/5 transition-colors cursor-pointer"
                        title={t('retryTooltip')}
                      >
                        <RotateCcw className="w-3.5 h-3.5" />
                      </button>

                      <button
                        onClick={() => handleDeleteTurn(msg.id)}
                        className="p-1.5 rounded-lg hover:text-red-600 hover:bg-red-500/10 dark:hover:text-red-400 dark:hover:bg-red-500/10 transition-colors cursor-pointer"
                        title={t('deleteTurnTooltip')}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>

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

                {/* 朗读进度 / 播放条（与主窗口同一份状态） */}
                {msg.content && (
                  <MessageSpeechBar messageId={msg.id} content={msg.content} />
                )}
              </div>
            );
          })}
          </MeasuredTurn>
          ))}
          {bottomSpacer > 0 && (
            <div aria-hidden="true" style={{ height: bottomSpacer }} />
          )}
          <div ref={scrollEndRef} className="h-6 flex-shrink-0" />
          </div>
        </div>

        <TurnRail
          turns={turns}
          centerIndex={centerIndex}
          startIndex={startIndex}
          endIndex={endIndex}
          visited={visitedKeys}
          onJump={jumpTo}
          compact
        />
        </div>

        {/* Bottom Input Capsule */}
        <div className="p-2.5 bg-[#f8f9fb] dark:bg-[#17181c] border-t border-black/5 dark:border-white/5">
          <div className="bg-white dark:bg-[#25262c] border border-black/10 dark:border-white/10 rounded-[16px] overflow-hidden flex flex-col justify-between">
            <ImageAttachment images={images} onRemove={handleRemoveDraftImage} />

            <div className="p-2 flex flex-col justify-between">
              <textarea
                ref={textareaRef}
                rows={1}
                value={input}
                onChange={(e) => {
                  setInput(e.target.value);
                  if (!(e.nativeEvent as InputEvent)?.isComposing) {
                    cursorPositionRef.current = e.target.selectionStart;
                  }
                }}
                {...inputImeBindings}
                onPaste={handlePaste}
                placeholder={hasMessages ? t('spotlightInputPlaceholder') : t('placeholderInitial')}
                data-chat-input="true"
                autoFocus
                className="w-full bg-transparent text-sm text-[#1f2328] dark:text-[#f1f3f7] placeholder-zinc-400 dark:placeholder-zinc-500 px-2 py-1 focus:outline-none resize-none leading-relaxed min-h-[26px] max-h-[160px] [overflow-anchor:none]"
              />

              <div className="flex items-center justify-between pt-1">
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    disabled={isMference}
                    onClick={isMference ? undefined : () => fileInputRef.current?.click()}
                    className={`w-6 h-6 rounded-full flex items-center justify-center transition-colors ${
                      isMference
                        ? 'opacity-40 text-zinc-400 dark:text-zinc-600 bg-black/5 dark:bg-white/5 cursor-not-allowed'
                        : 'bg-black/5 hover:bg-black/10 text-zinc-600 hover:text-black dark:bg-white/5 dark:hover:bg-white/10 dark:text-zinc-300 dark:hover:text-white cursor-pointer'
                    }`}
                    title={isMference ? t('visionDisabledMference') : t('spotlightAddImage')}
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

                  {wikiStatus.enabled && (
                    <button
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
                      <BookOpen
                        className={`w-3.5 h-3.5 ${
                          !isDeepSeek && enableWikiSearch && wikiStatus.connected
                            ? 'text-emerald-600 dark:text-emerald-400'
                            : ''
                        }`}
                      />
                      <span>{t('offlineWiki')}</span>
                    </button>
                  )}
                </div>

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

                  <ContextRing
                    usedTokens={displayTokens}
                    maxContext={settings.maxContext}
                    showTooltip={false}
                  />
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {pageLayerNode}
    </div>
  );
};
