import React, { useRef, useEffect, useLayoutEffect, useState } from 'react';
import { ChatMessage, TurnMetrics } from '../types/chat';
import { useI18n } from '../i18n';
import { useChatFontSize } from '../hooks/useChatFontSize';
import { useFadeOverlay } from '../hooks/useFadeOverlay';
import { resizeHud } from '../utils/resizeHud';
import { useTurnWindow } from '../hooks/useTurnWindow';
import { MessageItem } from './MessageItem';
import { MeasuredTurn } from './MeasuredTurn';
import { TurnRail } from './TurnRail';
import { ChatInput } from './ChatInput';
import {
  HelpCircle,
  Code2,
  BookOpen,
  ChevronDown,
  Check,
  PanelLeftOpen,
  PanelRightOpen,
  Minimize2,
  ImageUp,
} from 'lucide-react';
import { isImageFile, fileToDataURL } from '../utils/image';

interface ChatViewProps {
  sessionId?: string | null;
  messages: ChatMessage[];
  input: string;
  setInput: (val: string) => void;
  images: string[];
  setImages: React.Dispatch<React.SetStateAction<string[]>>;
  isGenerating: boolean;
  onSend: (promptText?: string) => void;
  onStop: () => void;
  usedTokens: number;
  maxContext: number;
  enableThinking: boolean;
  setEnableThinking: (val: boolean) => void;
  modelId: string;
  availableModels: string[];
  onSelectModel: (model: string) => void;
  visionReady: boolean;
  serviceOnline?: boolean;
  lastMetrics?: TurnMetrics;
  onOpenSettings?: () => void;
  isSidebarOpen: boolean;
  onToggleSidebar: () => void;
  /** 正在拖拽右侧面板宽度：整列冻结（不重排、不重渲染）+ 盖遮罩并显示中部宽度 */
  resizing?: boolean;
  /** 正在开合侧边栏：同样冻结 + 盖遮罩，但**不显示数字**（整块滑入，尺寸不连续变化） */
  layoutMask?: boolean;
  enableWikiSearch?: boolean;
  setEnableWikiSearch?: (val: boolean) => void;
  wikiConnected?: boolean;
  wikiEnabled?: boolean;
  wikiPanelOpen?: boolean;
  onToggleWikiPanel?: () => void;
  onOpenWiki?: (title: string, context?: string) => void;
  /** 回答原文 / 发送图片：交给右侧面板开标签页（不传则走消息内部的旧弹窗） */
  onOpenRawText?: (payload: { messageId: string; content: string }) => void;
  onOpenImage?: (payload: { messageId: string; images: string[]; index: number }) => void;
  onRetry?: (messageId: string) => void;
  onDelete?: (messageId: string) => void;
  onShrinkToSpotlight?: () => void;
  isDeepSeek?: boolean;
  isMference?: boolean;
}

export const ChatView: React.FC<ChatViewProps> = ({
  sessionId,
  messages,
  input,
  setInput,
  images,
  setImages,
  isGenerating,
  onSend,
  onStop,
  usedTokens,
  maxContext,
  enableThinking,
  setEnableThinking,
  modelId,
  availableModels,
  onSelectModel,
  visionReady,
  serviceOnline = false,
  isSidebarOpen,
  onToggleSidebar,
  resizing = false,
  layoutMask = false,
  enableWikiSearch,
  setEnableWikiSearch,
  wikiConnected,
  wikiEnabled,
  wikiPanelOpen,
  onToggleWikiPanel,
  onOpenWiki,
  onOpenRawText,
  onOpenImage,
  onRetry,
  onDelete,
  onShrinkToSpotlight,
  isDeepSeek = false,
  isMference = false,
}) => {
  const { t } = useI18n();
  const masked = resizing || layoutMask;
  // 拖拽松手：先保持 100ms 再淡 280ms（内容在遮罩下完成一次重排）
  // 开合侧栏：滑入/滑出本身 200ms，结束后再多盖 140ms 才开始淡出，避免"闪现"
  const mask = useFadeOverlay(
    masked,
    layoutMask ? 140 : 100,
    layoutMask ? 300 : 280
  );
  const pillRef = useRef<HTMLSpanElement | null>(null);
  // 遮罩上的中部宽度数字由 HUD 直接写 textContent（拖拽时每帧更新，不走 React）
  useLayoutEffect(() => resizeHud.attachChatPill(pillRef.current), [mask.mounted, resizing]);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const prevSessionIdRef = useRef<string | null | undefined>(undefined);
  const prevLastUserMsgIdRef = useRef<string | undefined>(undefined);
  const [showModelMenu, setShowModelMenu] = useState(false);
  /**
   * 拖拽右栏 / 开合侧栏期间冻结内容宽度：
   * 遮罩盖着的时候不做逐帧重排，松手后一次性重排并恢复锚点。
   */
  const [frozenWidth, setFrozenWidth] = useState<number | null>(null);
  const frozenWidthRef = useRef<number | null>(null);

  // 对话内容字号独立调节（大窗口快捷键 ⌘+ / ⌘-，不影响侧边栏/输入框）
  const { fontSize: chatFontSize } = useChatFontSize({
    storageKey: 'simpleui_main_chat_font_size',
    defaultSize: 15,
    minSize: 12,
    maxSize: 24,
  });

  /**
   * 对话窗口化：可见区 ± 2 轮 + 上下各约 1.2 屏预载；短会话全量挂载。
   * 未挂载部分用 spacer 占位，任何窗口变化都在 paint 前恢复锚点。
   * 详见 useTurnWindow。
   */
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
    captureAnchor,
    restoreAnchor,
  } = useTurnWindow({
    messages,
    sessionId,
    containerRef: scrollContainerRef,
    contentRef,
  });

  /**
   * 外层消息容器滚动策略：
   * 1. 切换会话由 useTurnWindow 统一贴底；
   * 2. 用户刚发出新消息时定位一次到底部；
   * 3. 生成过程中外层完全固定、绝不跟随、绝不抢夺滚动条（产品决策）。
   */
  useEffect(() => {
    const isSessionSwitch = sessionId !== prevSessionIdRef.current;

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

    prevSessionIdRef.current = sessionId;
    prevLastUserMsgIdRef.current = lastUserMsgId;

    if (isNewUserTurnSent) centerOnLatest();
  }, [sessionId, messages, centerOnLatest]);

  /**
   * 拖拽右栏 / 开合侧栏：冻结内容宽度（遮罩下面不逐帧重排），
   * 结束后解除冻结并恢复锚点。
   */
  useLayoutEffect(() => {
    const shouldFreeze = resizing || layoutMask;
    if (shouldFreeze) {
      if (frozenWidthRef.current == null) {
        const w = contentRef.current?.offsetWidth ?? 0;
        if (w > 0) {
          frozenWidthRef.current = w;
          setFrozenWidth(w);
        }
        captureAnchor();
      }
      return;
    }
    if (frozenWidthRef.current != null) {
      frozenWidthRef.current = null;
      setFrozenWidth(null);
    }
  }, [resizing, layoutMask, captureAnchor]);

  /** 解除冻结后的第一次布局完成：强制读一次布局，再把阅读线恢复到原位置。 */
  const prevFrozenWidthRef = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (prevFrozenWidthRef.current != null && frozenWidth == null) {
      const el = scrollContainerRef.current;
      if (el) void el.offsetHeight;
      restoreAnchor();
    }
    prevFrozenWidthRef.current = frozenWidth;
  }, [frozenWidth, restoreAnchor]);

  const quickPrompts = [
    {
      title: t('defaultPrompt1Title'),
      desc: t('defaultPrompt1Desc'),
      prompt: t('defaultPrompt1Content'),
      icon: <HelpCircle className="w-4 h-4 text-purple-400" />,
    },
    {
      title: t('defaultPrompt2Title'),
      desc: t('defaultPrompt2Desc'),
      prompt: t('defaultPrompt2Content'),
      icon: <Code2 className="w-4 h-4 text-emerald-400" />,
    },
    {
      title: t('defaultPrompt3Title'),
      desc: t('defaultPrompt3Desc'),
      prompt: t('defaultPrompt3Content'),
      icon: <BookOpen className="w-4 h-4 text-blue-400" />,
    },
  ];

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
        console.error('Failed to process dropped images:', err);
      }
    }
  };

  return (
    <div
      className="chat-container relative flex-1 min-w-0 flex flex-col h-full overflow-hidden bg-[#f8f9fb] dark:bg-[#18191c]"
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* 拖拽面板宽度：整列盖遮罩（与右侧面板同一套延时淡出）。
          配合 freeze-children，遮罩存在期间聊天内容不做任何重排/重渲染。 */}
      {mask.mounted && (
        <div
          data-chat-resize-veil="true"
          data-veil-visible={mask.visible ? 'true' : 'false'}
          className={`pointer-events-none absolute inset-0 z-40 flex items-center justify-center bg-[#f8f9fb] transition-opacity ease-in-out dark:bg-[#18191c] ${
            mask.visible ? 'opacity-100' : 'opacity-0'
          }`}
          style={{ transitionDuration: `${mask.durationMs}ms` }}
        >
          {/* 只有「拖右栏」才显示中部宽度；开合是整块滑入，数字没有意义 */}
          {resizing && (
            <div className="flex h-[38px] items-center rounded-[19px] border border-black/[0.08] bg-white/[0.96] px-5 shadow-lg dark:border-white/[0.12] dark:bg-[#24262c]">
              <span
                ref={pillRef}
                data-chat-size-pill="true"
                className="font-mono text-[15px] font-semibold tabular-nums text-[#1f2328] dark:text-[#f1f3f7]"
              >
                —
              </span>
            </div>
          )}
        </div>
      )}

      {/* 全窗口拖拽图片吸附提示遮罩 */}
      {isDragOver && (
        <div className="absolute inset-0 z-50 bg-blue-500/10 dark:bg-blue-400/10 backdrop-blur-[2px] border-2 border-dashed border-blue-500/80 dark:border-blue-400/80 rounded-2xl m-3 flex flex-col items-center justify-center pointer-events-none transition-all">
          <div className="p-5 rounded-2xl bg-white/95 dark:bg-[#202126]/95 shadow-2xl flex flex-col items-center gap-2 border border-blue-500/30">
            <div className="w-12 h-12 rounded-xl bg-blue-500/15 text-blue-600 dark:text-blue-400 flex items-center justify-center">
              <ImageUp className="w-6 h-6 stroke-[2.2]" />
            </div>
            <span className="text-sm font-semibold text-zinc-800 dark:text-zinc-100">
              {t('dropImagesHere')}
            </span>
            <span className="text-xs text-zinc-500 dark:text-zinc-400">
              {t('dropImagesHint')}
            </span>
          </div>
        </div>
      )}

      {/* Top 52px Header Bar */}
      <div
        className={`relative z-20 h-[52px] border-b border-black/5 dark:border-white/5 bg-[#f8f9fb]/80 dark:bg-[#18191c]/80 backdrop-blur flex items-center justify-between flex-shrink-0 select-none transition-all duration-200 ${
          !isSidebarOpen ? 'pl-[78px] pr-4 cq-md:pr-6' : 'px-4 cq-md:px-6'
        }`}
      >
        {/* Left: Open Sidebar Button (when collapsed) + Model Selector */}
        <div className="flex items-center gap-1.5 cq-md:gap-2 min-w-0">
          {!isSidebarOpen && (
            <button
              type="button"
              onClick={onToggleSidebar}
              data-sidebar-toggle="true"
              className="p-1.5 rounded-lg text-zinc-500 hover:text-zinc-900 hover:bg-black/5 dark:text-zinc-400 dark:hover:text-white dark:hover:bg-white/5 transition-colors mr-1 flex-shrink-0"
              title={t('expandSidebar')}
            >
              <PanelLeftOpen className="w-4 h-4" />
            </button>
          )}

          {/* Model Selector Dropdown */}
          <div className="relative min-w-0">
            <button
              type="button"
              onClick={() => setShowModelMenu(!showModelMenu)}
              className="flex items-center gap-1.5 px-2.5 cq-md:px-3 py-1.5 rounded-xl text-sm font-semibold text-[#1f2328] dark:text-[#f1f3f7] hover:bg-black/5 dark:hover:bg-white/5 transition-colors max-w-full"
            >
              <span className="truncate max-w-[130px] cq-lg:max-w-[220px]" title={modelId || 'gemma-4-26b-a4b-it'}>
                {modelId || 'gemma-4-26b-a4b-it'}
              </span>
              <ChevronDown className="w-3.5 h-3.5 text-zinc-400 flex-shrink-0" />
            </button>

            {/* Model Selection Dropdown Menu */}
            {showModelMenu && (
              <div className="absolute top-full left-0 mt-1.5 w-56 py-1.5 rounded-2xl bg-white dark:bg-[#202126] border border-black/10 dark:border-white/10 shadow-xl z-50 animate-in fade-in zoom-in-95">
                <div className="px-3.5 py-1.5 text-[10px] font-semibold text-zinc-400 dark:text-zinc-500 uppercase tracking-wider">
                  {t('activeModel')}
                </div>
                {availableModels.map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => {
                      onSelectModel(m);
                      setShowModelMenu(false);
                    }}
                    className={`w-full text-left px-3.5 py-2 text-xs flex items-center justify-between hover:bg-black/5 dark:hover:bg-white/5 transition-colors ${
                      m === modelId ? 'text-blue-600 dark:text-blue-400 font-medium' : 'text-zinc-700 dark:text-zinc-300'
                    }`}
                  >
                    <span className="truncate">{m}</span>
                    {m === modelId && <Check className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400" />}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Model Service Health Indicator */}
          <span
            className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
              serviceOnline ? 'bg-emerald-500' : 'bg-red-400'
            }`}
            title={serviceOnline ? t('serviceReady') : t('serviceNotReady')}
          />
        </div>

        {/* Center Draggable Space */}
        <div className="flex-1 h-full min-w-4" />

        {/* Right Tools: Knowledge Panel Toggle + Shrink to Spotlight
            知识库面板开关**不再**随供应商变化置灰：DeepSeek 下也能打开面板，
            只是里面的页面会显示统一「未连接」提示（服务未开启 / 无 ZIM 同理）。 */}
        <div className="flex items-center gap-1.5 cq-md:gap-2 flex-shrink-0">
          {!wikiPanelOpen && (
            <button
              type="button"
              onClick={onToggleWikiPanel}
              data-panel-toggle="true"
              className="p-1.5 rounded-lg transition-colors flex-shrink-0 text-zinc-500 hover:text-zinc-900 hover:bg-black/5 dark:text-zinc-400 dark:hover:text-white dark:hover:bg-white/5 cursor-pointer"
              title={t('expandWikiPanel')}
            >
              <PanelRightOpen className="w-4 h-4" />
            </button>
          )}
          <button
            type="button"
            onClick={onShrinkToSpotlight}
            className="p-1.5 rounded-lg text-zinc-500 hover:text-zinc-900 hover:bg-black/5 dark:text-zinc-400 dark:hover:text-white dark:hover:bg-white/5 transition-colors cursor-pointer"
            title={t('shrinkToSpotlight')}
          >
            <Minimize2 className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Messages Stream Scroll Area
          外层回答容器完全固定，流式生成期间与闲置期间绝不自动滚动；仅切换会话时定位到底部。
          只挂载"当前轮 ± 2"，右侧定位横线承担定位与长距离滚动（原生滚动条已隐去）。 */}
      <div className="relative flex-1 min-h-0">
        <div
          ref={scrollContainerRef}
          style={{
            '--chat-font-size': `${chatFontSize}px`,
          } as React.CSSProperties}
          className="chat-scroller h-full overflow-y-auto overflow-x-hidden scrollbar-invisible px-3 cq-md:px-6 cq-lg:px-8 py-3 cq-md:py-6 pb-6 cq-md:pb-8 overscroll-y-contain"
        >
          {messages.length === 0 ? (
            <div className="max-w-4xl mx-auto min-h-full flex flex-col justify-center">
              <div className="my-auto py-4 cq-md:py-8 cq-lg:py-10 flex flex-col items-center text-center w-full max-w-lg mx-auto">
                <img
                  src="/icon-192.png"
                  alt="SimpleUI"
                  draggable={false}
                  className="w-10 h-10 cq-md:w-12 cq-md:h-12 mb-3 cq-md:mb-4 flex-shrink-0 select-none"
                />
                <h1 className="text-lg cq-md:text-xl font-semibold text-[#1f2328] dark:text-[#f3f5f8] mb-1.5 cq-md:mb-2 tracking-tight">
                  {t('greetingTitle')}
                </h1>
                <p className="text-xs text-zinc-500 dark:text-zinc-400 mb-4 cq-md:mb-6 max-w-md px-2">
                  {t('greetingSubtitle')}
                </p>

                {/* Quick suggestion cards */}
                <div className="w-full grid grid-cols-1 gap-2 cq-md:gap-2.5 text-left">
                  {quickPrompts.map((p, idx) => (
                    <button
                      key={idx}
                      onClick={() => {
                        setInput(p.prompt);
                      }}
                      className="flex items-start gap-2.5 cq-md:gap-3 p-2.5 cq-md:p-3.5 rounded-xl cq-md:rounded-2xl border border-black/5 dark:border-white/5 bg-white dark:bg-[#202126]/60 hover:bg-[#f3f4f7] dark:hover:bg-[#25272e] hover:border-black/10 dark:hover:border-white/10 shadow-sm transition-all text-left group"
                    >
                      <div className="mt-0.5 p-1 cq-md:p-1.5 rounded-xl bg-black/5 dark:bg-white/5 group-hover:scale-105 transition-transform flex-shrink-0">
                        {p.icon}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="text-xs font-medium text-zinc-800 group-hover:text-zinc-950 dark:text-zinc-200 dark:group-hover:text-white truncate">
                          {p.title}
                        </div>
                        <div className="text-[11px] text-zinc-500 dark:text-zinc-400 mt-0.5 line-clamp-1 cq-md:line-clamp-2">
                          {p.desc}
                        </div>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          ) : (
            <div
              ref={contentRef}
              data-chat-content="true"
              className="max-w-4xl mx-auto text-sm pb-2 pr-[24px]"
              style={
                frozenWidth != null
                  ? { width: `${frozenWidth}px`, maxWidth: 'none', flex: 'none' }
                  : undefined
              }
            >
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
                  {messages
                    .slice(turn.startMessageIndex, turn.endMessageIndex + 1)
                    .map((message) => (
                      <MessageItem
                        key={message.id}
                        message={message}
                        onOpenWiki={onOpenWiki}
                        onOpenRawText={onOpenRawText}
                        onOpenImage={onOpenImage}
                        onRetry={onRetry}
                        onDelete={onDelete}
                        retryTargetId={
                          message.role === 'user' ? turn.assistant?.id : undefined
                        }
                      />
                    ))}
                </MeasuredTurn>
              ))}
              {bottomSpacer > 0 && (
                <div aria-hidden="true" style={{ height: bottomSpacer }} />
              )}
              <div ref={messagesEndRef} className="h-6 flex-shrink-0" />
            </div>
          )}
        </div>

        {/* 右侧定位横线：每轮一枚刻度，悬停预览、点击贴顶跳转、上下拖动连续翻轮 */}
        <TurnRail
          turns={turns}
          centerIndex={centerIndex}
          startIndex={startIndex}
          endIndex={endIndex}
          visited={visitedKeys}
          onJump={jumpTo}
        />
      </div>

      {/* Input Area (Bottom capsule + Disclaimer) */}
      <div className="relative z-10 w-full px-3 cq-md:px-6 cq-lg:px-8 pb-3 cq-md:pb-4 pt-1 bg-gradient-to-t from-[#f8f9fb] via-[#f8f9fb]/95 to-transparent dark:from-[#18191c] dark:via-[#18191c]/95 dark:to-transparent">
        <div className="max-w-4xl mx-auto flex flex-col items-center">
          <ChatInput
            input={input}
            setInput={setInput}
            images={images}
            setImages={setImages}
            isGenerating={isGenerating}
            onSend={() => onSend()}
            onStop={onStop}
            usedTokens={usedTokens}
            maxContext={maxContext}
            enableThinking={enableThinking}
            setEnableThinking={setEnableThinking}
            visionReady={visionReady}
            hasMessages={messages.length > 0}
            enableWikiSearch={enableWikiSearch}
            setEnableWikiSearch={setEnableWikiSearch}
            wikiConnected={wikiConnected}
            wikiEnabled={wikiEnabled}
            isDeepSeek={isDeepSeek}
            isMference={isMference}
          />
        </div>
      </div>
    </div>
  );
};
