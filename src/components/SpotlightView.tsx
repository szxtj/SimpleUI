import React, { useState, useEffect, useRef, useCallback } from 'react';
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
import { ThinkingAccordion } from './ThinkingAccordion';
import { StageLadder } from './StageLadder';
import { ImageAttachment } from './ImageAttachment';
import { ContextRing } from './ContextRing';
import { WikiDrawer } from './WikiDrawer';
import { extractImagesFromPaste, fileToDataURL, isImageFile } from '../utils/image';
import { deleteUnreferencedMedia } from '../services/mediaCleanup';
import { useImeInput } from '../hooks/useImeInput';
import { useSessionStore } from '../hooks/useSessionStore';
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
  const [activeWikiArticle, setActiveWikiArticle] = useState<string | null>(null);
  const [activeWikiContext, setActiveWikiContext] = useState<string | null>(null);
  /** 小窗口「搜索」按钮打开的知识库面板（与大窗口侧边栏等价） */
  const [isWikiPanelOpen, setIsWikiPanelOpen] = useState(false);
  /** 弹出显示原 Markdown 文本的目标内容 */
  const [rawMarkdownTarget, setRawMarkdownTarget] = useState<string | null>(null);

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
  const prevMessagesLengthRef = useRef(messages.length);
  const prevFirstMsgIdRef = useRef(messages[0]?.id);

  const hasMessages = messages.length > 0;
  const isMultiline = input.includes('\n');
  const isExpanded = hasMessages || isGenerating || isMultiline;

  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const userScrolledSinceSwitchRef = useRef(false);

  /**
   * 消息流容器的「思考期跟随」行为 —— 与主窗口共用同一份 hook（useFollowBottom）。
   * 仅在思考/阶段载入中跟随底部；用户一旦手动滚动，立刻永久停止跟随。
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

  // Auto-resize textarea in Spotlight
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      const scrollHeight = textareaRef.current.scrollHeight;
      textareaRef.current.style.height = `${Math.min(Math.max(scrollHeight, 24), 160)}px`;
    }
  }, [input, isExpanded]);

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

  useEffect(() => {
    if (!isWikiPanelOpen) {
      notifyResize(isExpanded, images.length > 0, true);
    }
  }, [isExpanded, images.length, isWikiPanelOpen, notifyResize]);

  const openWikiPanel = () => {
    setIsWikiPanelOpen(true);
    if (!isExpanded) notifyResize(true, images.length > 0, true);
  };

  const closeWikiPanel = () => {
    setIsWikiPanelOpen(false);
    setActiveWikiArticle(null);
    setActiveWikiContext(null);
    if (!isExpanded) notifyResize(false, images.length > 0, true);
  };

  const closeSpotlightWindow = () => {
    // @ts-expect-error WebKit bridge
    window.webkit?.messageHandlers?.closeSpotlight?.postMessage?.({});
  };

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
  const isMference = settings.apiProvider === 'mference';

  useEffect(() => {
    if (isMference && images.length > 0) {
      setImages([]);
    }
  }, [isMference, images.length]);

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

  useEffect(() => {
    if (isDeepSeek && isWikiPanelOpen) {
      closeWikiPanel();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  // Native bridge hook: Swift `showWithSession(sessionId:isExpanded:)` calls `window.loadSessionInSpotlight`
  useEffect(() => {
    // @ts-expect-error global hook for Swift showWithSession evaluation
    window.loadSessionInSpotlight = (sessionId: string) => {
      if (!sessionId) return;
      handoffLockUntilRef.current = Date.now() + 2500;
      recordActivity();
      selectSession(sessionId);
      const target = sessionsListRef.current.find((s) => s.id === sessionId);
      const targetExpanded = Boolean(target && target.messages && target.messages.length > 0);
      notifyResize(targetExpanded || true, imagesRef.current.length > 0, true);
      refreshState();
    };
    return () => {
      // @ts-expect-error global hook
      delete window.loadSessionInSpotlight;
    };
  }, [selectSession, refreshState, recordActivity, notifyResize]);

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

  // Reload latest settings & refresh server state whenever Spotlight gains focus or is shown
  useEffect(() => {
    const handleFocusOrShown = () => {
      setSettings(loadSettings());
      WikiAPI.getStatus().then(setWikiStatus);
      if (Date.now() < handoffLockUntilRef.current) {
        recordActivity();
        refreshState();
        notifyResize(true, imagesRef.current.length > 0, true);
        return;
      }
      checkIdleReset();
      refreshState();
      const hasMsgs = messagesRef.current.length > 0 || isGeneratingRef.current;
      const isMulti = inputRef.current.includes('\n');
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

  const handleOpenInMain = useCallback(async () => {
    if (currentSessionId) {
      await handoffToMain(currentSessionId);
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

    // 浮窗解绑当前会话并恢复为空白胶囊态；
    // 若该会话仍在后台流式生成，服务端会继续推送至主窗口，浮窗完全解耦！
    await initEmptySession();
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
    const removedUrl = images[index];
    setImages((prev) => prev.filter((_, i) => i !== index));
    if (removedUrl) {
      deleteUnreferencedMedia([removedUrl], sessions);
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

        {/* Message Scroll Area */}
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
              <div key={msg.id} className="space-y-2">
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
                  <div className="text-[14.5px] leading-relaxed text-[#1f2328] dark:text-[#ecedf1]">
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
                          setActiveWikiArticle(c.title);
                          setActiveWikiContext(c.context ?? null);
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
                          onClick={() => setRawMarkdownTarget(msg.content)}
                          className="p-1.5 rounded-lg hover:text-zinc-900 hover:bg-black/5 dark:hover:text-white dark:hover:bg-white/5 transition-colors cursor-pointer"
                          title={t('viewRawMarkdown')}
                        >
                          <FileText className="w-3.5 h-3.5" />
                        </button>
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
              </div>
            );
          })}
          <div ref={scrollEndRef} className="h-6 flex-shrink-0" />
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

      {wikiDrawerNode}

      <RawMarkdownModal
        isOpen={rawMarkdownTarget !== null}
        onClose={() => setRawMarkdownTarget(null)}
        content={rawMarkdownTarget || ''}
        isSpotlight
      />
    </div>
  );
};
