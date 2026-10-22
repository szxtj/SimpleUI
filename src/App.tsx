import React, { useState, useEffect, useLayoutEffect, useMemo, useCallback, useRef } from 'react';
import { Sidebar } from './components/Sidebar';
import { ChatView } from './components/ChatView';
import { SettingsModal } from './components/SettingsModal';
import { ServiceManagerModal } from './components/ServiceManagerModal';
import {
  AppSettings,
  ServerHealthInfo,
  WikiStatusInfo,
} from './types/chat';
import {
  loadSettings,
  saveSettings,
  syncSettingsFromServer,
  DEFAULT_LOCAL_CONFIG,
  DEFAULT_DEEPSEEK_CONFIG,
  syncChannel,
  buildTranslatorGatewayPayload,
} from './services/storage';
import { TurboFieldfareAPI, WikiAPI } from './services/api';
import {
  buildSessionSettings,
  getActiveContextMessages,
} from './services/chatTurn';
import { SpotlightView } from './components/SpotlightView';
import { SelectionSpeak } from './components/SelectionSpeak';
import { VoiceOverlay } from './components/VoiceOverlay';
import { SubtitleOverlay } from './components/SubtitleOverlay';
import { SidePanel } from './components/SidePanel';
import { StartupOverlay } from './components/StartupOverlay';
import { I18nProvider, resolveLanguage } from './i18n';
import { useTheme } from './hooks/useTheme';
import { useSessionStore } from './hooks/useSessionStore';
import { usePanelTabs } from './hooks/usePanelTabs';
import { LEFT_SIDEBAR_WIDTH, MIDDLE_MIN_WIDTH, PANEL_DEFAULT_WIDTH } from './layout';
import { resizeHud } from './utils/resizeHud';
import { estimateHistoryTokens, applyTokenCalibration } from './utils/token';

export const App: React.FC = () => {
  const [settings, setSettings] = useState<AppSettings>(loadSettings());
  const activeLang = resolveLanguage(settings.language);

  // Sync settings from ~/Library/Application Support/SimpleUI/settings.json on startup
  useEffect(() => {
    syncSettingsFromServer((loaded) => {
      setSettings(loaded);
    });
  }, []);

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

  // Sync language setting with native macOS application menu and dialogs
  useEffect(() => {
    try {
      (window as any).webkit?.messageHandlers?.setAppLanguage?.postMessage({
        lang: settings.language,
      });
    } catch {
      // non-macOS or test environment without native bridge
    }
  }, [settings.language]);

  // 快捷翻译：原生悬浮窗固定走本机网关（服务端按 mode 决定用字幕翻译小模型还是 DeepSeek/基础模型）。
  // 模型、密钥、采样参数全部由「服务控制面板 → 快速翻译服务」管理，前端不再下发任何模型配置。
  useEffect(() => {
    try {
      (window as any).webkit?.messageHandlers?.setTranslatorConfig?.postMessage(
        buildTranslatorGatewayPayload()
      );
    } catch {
      // non-macOS or test environment without native bridge
    }
  }, []);

  useEffect(() => {
    const refreshSettings = () => {
      syncSettingsFromServer((latest) => {
        setSettings((prev) =>
          prev.language !== latest.language || prev.theme !== latest.theme ? latest : prev
        );
      });
    };
    (window as any).onSubtitleOverlayShown = refreshSettings;
    const pollId =
      window.location.hash === '#/subtitles' || window.location.hash === '#/voice'
        ? window.setInterval(refreshSettings, 2000)
        : undefined;
    return () => {
      delete (window as any).onSubtitleOverlayShown;
      if (pollId !== undefined) window.clearInterval(pollId);
    };
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
        <SelectionSpeak />
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
  const [isServiceManagerOpen, setIsServiceManagerOpen] = useState(() => typeof window !== 'undefined' && window.location.search.includes('panel=services'));
  useEffect(() => {
    if (typeof document !== 'undefined' && window.location.search.includes('only=translate')) {
      document.body.classList.add('only-translate');
    }
  }, []);
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
  /**
   * 右侧面板：浏览器式多标签。
   *
   * 取代此前的「单布尔 isWikiPanelOpen + 单个 activeWikiArticle/Context 槽位」——
   * 那个模型同一时刻只能显示一件事，后开的会把先开的顶掉。
   */
  const panel = usePanelTabs();
  /** 正在拖拽右侧面板宽度：对话列同时冻结并盖遮罩（拖拽期间谁都不重排） */
  const [panelResizing, setPanelResizing] = useState(false);
  /**
   * 正在展开/收起某一侧侧边栏。
   * 与拖拽共用同一套遮罩（中部 + 右栏）与淡出时间轴：只要中部或右栏的尺寸在变，就一定有遮罩盖着。
   */
  const [layoutBusy, setLayoutBusy] = useState<null | 'left' | 'right'>(null);
  const layoutTimerRef = useRef<number | null>(null);
  const leftWidth = isSidebarOpen ? LEFT_SIDEBAR_WIDTH : 0;
  const leftWidthRef = useRef(leftWidth);
  leftWidthRef.current = leftWidth;
  /** 右栏「提交后」的宽度（拖拽松手/复位才更新；拖拽中走 onLiveWidth 的 DOM 路径） */
  const [panelW, setPanelW] = useState(PANEL_DEFAULT_WIDTH);
  const panelWidthRef = useRef(panelW);
  panelWidthRef.current = panelW;
  const handlePanelWidthCommit = useCallback((w: number) => setPanelW(w), []);

  useEffect(
    () => () => {
      if (layoutTimerRef.current) window.clearTimeout(layoutTimerRef.current);
    },
    []
  );

  /** 通知原生按差值伸缩窗口 frame（左栏向左、右栏向右），中部因此保持原宽度 */
  const growWindow = useCallback((delta: number, anchor: 'left' | 'right') => {
    if (!delta) return;
    try {
      // @ts-expect-error WebKit bridge
      window.webkit?.messageHandlers?.growWindow?.postMessage({ delta, anchor });
    } catch {
      /* 非 macOS / 测试环境无桥 */
    }
  }, []);

  const beginLayoutTransition = useCallback((which: 'left' | 'right') => {
    setLayoutBusy(which);
    if (layoutTimerRef.current) window.clearTimeout(layoutTimerRef.current);
    // 略长于 200ms 过渡：让遮罩盖到内容重新适配完，之后走统一淡出
    layoutTimerRef.current = window.setTimeout(() => setLayoutBusy(null), 240);
  }, []);

  /** 拖拽右栏：中部宽度 = 窗口宽 − 左栏 − 右栏（纯算术，不读布局，零渲染） */
  const handleLivePanelWidth = useCallback((w: number) => {
    resizeHud.setPanel(w);
    resizeHud.setMiddle(window.innerWidth - leftWidthRef.current - w);
  }, []);

  const toggleLeftSidebar = useCallback(() => {
    beginLayoutTransition('left'); // 先上遮罩，再改布局（同一帧内，不会闪）
    setIsSidebarOpen((v) => !v);
  }, [beginLayoutTransition]);

  const toggleRightPanel = useCallback(() => {
    beginLayoutTransition('right');
    panel.toggleVisible();
  }, [beginLayoutTransition, panel]);

  /**
   * 窗口几何的唯一出口：**任何**导致左/右栏宽度变化的路径（开合、关掉最后一个标签、
   * 双击复位…）都会走到这里，按差值让原生伸缩窗口，中部因此保持原宽度。
   * 用 layout effect：在绘制前把 growWindow 发出去，和 CSS 过渡同帧起步。
   */
  /**
   * 侧边栏开合的布局规则（现代常见做法）：
   *   1. **窗口尺寸尽量不动** —— 侧边栏向中间挤，中部让出空间；
   *   2. 左右两栏各自保持自身宽度（右栏用它记住的宽度）；
   *   3. 只有当「中部会被压到小于最小宽度」时，才把**整个窗口**扩出缺口那一段；
   *   4. 收起侧边栏时窗口不缩回（中部自己长回来）。
   *
   * 全屏态由原生直接忽略 frame 变更：不会退出全屏、也不会还原成原始尺寸。
   * 拖拽右栏宽度是**有意让中部吸收**的，同样不动窗口。
   */
  const visRef = useRef<{ left: boolean; right: boolean } | null>(null);
  useLayoutEffect(() => {
    const prev = visRef.current;
    if (!prev) {
      visRef.current = { left: isSidebarOpen, right: panel.visible };
      return;
    }
    const dLeft = (isSidebarOpen ? 1 : 0) - (prev.left ? 1 : 0);
    const dRight = (panel.visible ? 1 : 0) - (prev.right ? 1 : 0);
    if (!dLeft && !dRight) return;
    visRef.current = { left: isSidebarOpen, right: panel.visible };

    const right = panel.visible ? panelW : 0;
    const middleAfter = window.innerWidth - leftWidth - right;

    // 开合是瞬时的整块滑入：遮罩只负责盖住中部的重排，不显示数字（也就不用逐帧算）
    beginLayoutTransition(dLeft ? 'left' : 'right');

    // 只有缺口才扩窗口：中部永远不窄于最小宽度；房间够就完全不动窗口
    const shortfall = MIDDLE_MIN_WIDTH - middleAfter;
    if (shortfall > 0) growWindow(shortfall, dLeft ? 'left' : 'right');
  }, [isSidebarOpen, panel.visible, leftWidth, panelW, beginLayoutTransition, growWindow]);

  /**
   * 知识库是否可用：服务总开关 && ZIM 就绪 && 非 DeepSeek。
   * 不可用时页面照常能打开，只是显示统一「未连接」提示且不发任何请求。
   */
  const kbReady = wikiStatus.enabled && wikiStatus.connected && settings.apiProvider !== 'deepseek';
  /** 启动冷态遮罩展示状态（直到所需服务完全启动，再等半秒淡出） */
  const [showStartupOverlay, setShowStartupOverlay] = useState(true);
  const handleStartupFinished = useCallback(() => {
    setShowStartupOverlay(false);
  }, []);

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

  // Poll server health & fetch models (only trigger state updates when values actually change)
  useEffect(() => {
    const isDeepSeek = settings.apiProvider === 'deepseek';
    const checkServer = async () => {
      const info = await TurboFieldfareAPI.checkHealth(settings);
      setHealthInfo((prev) =>
        prev.status === info.status &&
        prev.vision === info.vision &&
        prev.online === info.online &&
        prev.modelId === info.modelId
          ? prev
          : info
      );
      if (info.online) {
        const models = await TurboFieldfareAPI.fetchModels(settings);
        if (models.length > 0) {
          setAvailableModels((prev) =>
            prev.length === models.length && prev.every((m, i) => m === models[i]) ? prev : models
          );
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
        const fallback = ['deepseek-flash', 'deepseek-v4-pro'];
        setAvailableModels((prev) =>
          prev.length === fallback.length && prev.every((m, i) => m === fallback[i]) ? prev : fallback
        );
      }
    };

    checkServer();
    const interval = showStartupOverlay ? 500 : 10000;
    const timer = setInterval(checkServer, interval);
    return () => clearInterval(timer);
  }, [
    settings.apiProvider,
    settings.apiPort,
    settings.modelId,
    settings.deepseekApiKey,
    settings.deepseekModelId,
    settings.deepseekBaseUrl,
    showStartupOverlay,
    setSettings,
  ]);

  // 面板可见性通知原生侧（用于窗口最小宽度与顶栏拖拽区判定）。
  // 注意：DeepSeek 模式下**不再自动关闭面板**——现在页面可以打开、只是显示「未连接」提示。
  useEffect(() => {
    // @ts-expect-error WebKit bridge
    window.webkit?.messageHandlers?.setWikiPanelOpen?.postMessage?.(panel.visible);
  }, [panel.visible]);

  // Poll local offline Wiki status (bail out if unchanged to avoid idle re-renders)
  useEffect(() => {
    const checkWiki = async () => {
      const status = await WikiAPI.getStatus();
      setWikiStatus((prev) =>
        JSON.stringify(prev) === JSON.stringify(status) ? prev : status
      );
    };
    checkWiki();
    const interval = showStartupOverlay ? 500 : 6000;
    const wikiTimer = setInterval(checkWiki, interval);
    return () => clearInterval(wikiTimer);
  }, [showStartupOverlay]);

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
  }, [settings.apiProvider, images]);

  const handleNewSession = async () => {
    if (images.length > 0) {
      setImages([]);
    }
    await createOrReuseEmptySession(defaultTitle);
    setInput('');
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

  // 注意：依赖只取原始值。流式 chunk 会让 currentSession 对象每帧变化，
  // 直接依赖对象会让 MessageItem 的 memo 全部失效。
  const sessionThinking = currentSession?.enableThinking ?? false;
  const sessionWiki = currentSession?.enableWikiSearch ?? false;

  const handleRetry = useCallback(
    async (assistantMessageId: string) => {
      const isDeepSeek = settings.apiProvider === 'deepseek';
      const sessionSettings = buildSessionSettings(
        settings,
        sessionThinking,
        isDeepSeek ? false : sessionWiki
      );

      await retryTurn({
        assistantMessageId,
        settings: sessionSettings,
        lang: activeLang,
        sessionId: currentSessionId,
      });
    },
    [settings, sessionThinking, sessionWiki, retryTurn, activeLang, currentSessionId]
  );

  const handleDeleteTurn = useCallback(
    async (assistantMessageId: string) => {
      await deleteTurn(assistantMessageId, currentSessionId);
    },
    [deleteTurn, currentSessionId]
  );

  const handleOpenWiki = useCallback(
    (title: string, context?: string) => {
      panel.openArticle(title, context ?? null);
    },
    [panel.openArticle]
  );

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

  /**
   * 会话列表右键 →「用小窗口打开」。
   *
   * 与「缩小为快捷悬浮窗」不同：主窗口**保持原会话与原滚动位置**（不 selectSession、不隐藏），
   * 只把目标会话指针交给小窗口。这样回到主窗口时看到的仍是刚才的对话和阅读位置。
   */
  const handleOpenSessionInSpotlight = (sessionId: string) => {
    const target = sessions.find((s) => s.id === sessionId);
    const isExpanded =
      (target?.messages?.length ?? 0) > 0 || generatingSessionIds.includes(sessionId);
    handoffToSpotlight(sessionId);
    try {
      // @ts-expect-error WebKit bridge
      window.webkit?.messageHandlers?.openSessionInSpotlight?.postMessage({
        sessionId,
        isExpanded,
      });
    } catch {
      /* 非 macOS / 测试环境无桥 */
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
          onOpenSessionInSpotlight={handleOpenSessionInSpotlight}
          onNewSession={handleNewSession}
          onDeleteSession={handleDeleteSession}
          onRenameSession={handleRenameSession}
          onOpenSettings={() => setIsSettingsOpen(true)}
          onOpenServiceManager={() => setIsServiceManagerOpen(true)}
          isOpen={isSidebarOpen}
          onToggleOpen={toggleLeftSidebar}
        />

        {/* Main Chat Interface */}
        <ChatView
          sessionId={currentSessionId}
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
          serviceOnline={healthInfo.online}
          lastMetrics={lastMetrics}
          onOpenSettings={() => setIsSettingsOpen(true)}
          isSidebarOpen={isSidebarOpen}
          onToggleSidebar={toggleLeftSidebar}
          resizing={panelResizing}
          layoutMask={layoutBusy !== null}
          enableWikiSearch={currentSession?.enableWikiSearch ?? false}
          setEnableWikiSearch={(val) => {
            if (!currentSessionId) return;
            updateSessionMeta(currentSessionId, { enableWikiSearch: val });
          }}
          wikiConnected={wikiStatus.connected}
          wikiEnabled={wikiStatus.enabled}
          wikiPanelOpen={panel.visible}
          onToggleWikiPanel={toggleRightPanel}
          onOpenWiki={handleOpenWiki}
          onOpenRawText={panel.openRawText}
          onOpenImage={panel.openImage}
          onRetry={handleRetry}
          onDelete={handleDeleteTurn}
          onShrinkToSpotlight={handleShrinkToSpotlight}
        />

        {/* 右侧面板：浏览器式多标签（知识库搜索 / 条目 / 原文 / 图片） */}
        <SidePanel
          tabs={panel.tabs}
          activeId={panel.activeId}
          visible={panel.visible}
          kbReady={kbReady}
          wikiEnabled={wikiStatus.enabled}
          onActivate={panel.activateTab}
          onCloseTab={panel.closeTab}
          onNewTab={panel.openSearch}
          onCollapse={toggleRightPanel}
          onOpenArticle={(title) => panel.openArticle(title, null)}
          onQueryChange={panel.setSearchQuery}
          onResizeStateChange={setPanelResizing}
          onLiveWidth={handleLivePanelWidth}
          onWidthChange={handlePanelWidthCommit}
          reservedLeft={leftWidth}
        />

        {/* Settings Modal */}
        <SettingsModal
          isOpen={isSettingsOpen}
          onClose={() => setIsSettingsOpen(false)}
          settings={settings}
          onSave={handleSaveSettings}
        />

        {/* 服务管理界面（基础模型 / 知识库 / 语音识别 / 语音合成 / 字幕 / 快速翻译 / 视觉识别） */}
        <ServiceManagerModal
          isOpen={isServiceManagerOpen}
          onClose={() => setIsServiceManagerOpen(false)}
          settings={settings}
          onApiPortChange={handleServiceApiPortChange}
        />

        {/* 应用启动遮罩（主界面进程端口初始化完成后，多等 0.5s 平滑淡出） */}
        {showStartupOverlay && (
          <StartupOverlay
            onFinished={handleStartupFinished}
          />
        )}

        {/* 划选朗读浮标（正文选区旁的按钮） */}
        <SelectionSpeak />
      </div>
    </I18nProvider>
  );
};
