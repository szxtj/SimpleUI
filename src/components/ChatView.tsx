import React, { useRef, useEffect, useState, useCallback } from 'react';
import { ChatMessage, TurnMetrics } from '../types/chat';
import { useI18n } from '../i18n';
import { useChatFontSize } from '../hooks/useChatFontSize';
import { useTurnWindow } from '../hooks/useTurnWindow';
import { disableScrollAnchor } from '../utils/scrollAnchor';
import { MessageItem } from './MessageItem';
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
  lastMetrics?: TurnMetrics;
  onOpenSettings?: () => void;
  isSidebarOpen: boolean;
  onToggleSidebar: () => void;
  enableWikiSearch?: boolean;
  setEnableWikiSearch?: (val: boolean) => void;
  wikiConnected?: boolean;
  wikiEnabled?: boolean;
  wikiPanelOpen?: boolean;
  onToggleWikiPanel?: () => void;
  onOpenWiki?: (title: string, context?: string) => void;
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
  isSidebarOpen,
  onToggleSidebar,
  enableWikiSearch,
  setEnableWikiSearch,
  wikiConnected,
  wikiEnabled,
  wikiPanelOpen,
  onToggleWikiPanel,
  onOpenWiki,
  onRetry,
  onDelete,
  onShrinkToSpotlight,
  isDeepSeek = false,
  isMference = false,
}) => {
  const { t } = useI18n();
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const prevSessionIdRef = useRef<string | null | undefined>(undefined);
  const prevLastUserMsgIdRef = useRef<string | undefined>(undefined);
  const userScrolledSinceSwitchRef = useRef(false);
  const [showModelMenu, setShowModelMenu] = useState(false);

  // 对话内容字号独立调节（大窗口快捷键 ⌘+ / ⌘-，不影响侧边栏/输入框）
  const { fontSize: chatFontSize } = useChatFontSize({
    storageKey: 'simpleui_main_chat_font_size',
    defaultSize: 15,
    minSize: 12,
    maxSize: 24,
  });

  const handleUserScrollAction = useCallback(() => {
    userScrolledSinceSwitchRef.current = true;
  }, []);

  /**
   * 对话窗口化：只挂载"当前轮 ± 2"（默认 5 轮），随滚动重算、离开即释放，
   * 同时提供右侧定位横线的跳转能力。详见 useTurnWindow。
   */
  const { visibleTurns, turns, centerIndex, startIndex, endIndex, centerOnLatest, jumpTo } =
    useTurnWindow({ messages, sessionId, containerRef: scrollContainerRef });

  /**
   * 外层消息容器滚动策略：
   * 1. 切换到不同对话时（sessionId 变化）：自动定位到该对话的最底部；
   * 2. 用户刚发出新消息时（新的 user 消息插入）：定位一次到底部以露出新提问与思考手风琴头部；
   * 3. 思考过程流式输出（由 ThinkingAccordion 内部独立跟随滚动）、正式回答流式生成中、以及平时非生成状态：
   *    外层容器完全固定、绝不自动滚动、绝不抢夺用户的滚动条。
   */
  useEffect(() => {
    const el = scrollContainerRef.current;
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

    if (!el) return;

    if (isSessionSwitch) {
      userScrolledSinceSwitchRef.current = false;
      centerOnLatest();
      disableScrollAnchor(el, 600);
      el.scrollTop = el.scrollHeight;

      let raf1 = 0;
      let raf2 = 0;
      raf1 = requestAnimationFrame(() => {
        if (!userScrolledSinceSwitchRef.current && scrollContainerRef.current) {
          scrollContainerRef.current.scrollTop = scrollContainerRef.current.scrollHeight;
        }
        raf2 = requestAnimationFrame(() => {
          if (!userScrolledSinceSwitchRef.current && scrollContainerRef.current) {
            scrollContainerRef.current.scrollTop = scrollContainerRef.current.scrollHeight;
          }
        });
      });

      const timer = setTimeout(() => {
        if (!userScrolledSinceSwitchRef.current && scrollContainerRef.current) {
          scrollContainerRef.current.scrollTop = scrollContainerRef.current.scrollHeight;
        }
      }, 80);

      return () => {
        cancelAnimationFrame(raf1);
        cancelAnimationFrame(raf2);
        clearTimeout(timer);
      };
    } else if (isNewUserTurnSent) {
      centerOnLatest();
      disableScrollAnchor(el, 600);
      el.scrollTop = el.scrollHeight;
    }
  }, [sessionId, messages, centerOnLatest]);

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
        </div>

        {/* Center Draggable Space */}
        <div className="flex-1 h-full min-w-4" />

        {/* Right Tools: Knowledge Panel Toggle + Shrink to Spotlight */}
        <div className="flex items-center gap-1.5 cq-md:gap-2 flex-shrink-0">
          {!wikiPanelOpen && (
            <button
              type="button"
              onClick={isDeepSeek ? undefined : onToggleWikiPanel}
              disabled={isDeepSeek}
              className={`p-1.5 rounded-lg transition-colors flex-shrink-0 ${
                isDeepSeek
                  ? 'opacity-40 cursor-not-allowed text-zinc-400 dark:text-zinc-500'
                  : 'text-zinc-500 hover:text-zinc-900 hover:bg-black/5 dark:text-zinc-400 dark:hover:text-white dark:hover:bg-white/5 cursor-pointer'
              }`}
              title={isDeepSeek ? t('wikiDisabledInDeepSeek') : t('expandWikiPanel')}
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
          onWheel={handleUserScrollAction}
          onTouchMove={handleUserScrollAction}
          onMouseDown={handleUserScrollAction}
          onKeyDown={handleUserScrollAction}
          className="h-full overflow-y-auto scrollbar-invisible px-3 cq-md:px-6 cq-lg:px-8 py-3 cq-md:py-6 pb-6 cq-md:pb-8 overscroll-y-contain"
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
              className={`max-w-4xl mx-auto space-y-4 text-sm pb-2 ${
                turns.length >= 2 ? 'pr-[24px]' : ''
              }`}
            >
              {visibleTurns.map((turn) => (
                <div
                  key={turn.key}
                  data-turn-key={turn.key}
                  data-turn-index={turn.index}
                  className="space-y-4"
                >
                  {messages
                    .slice(turn.startMessageIndex, turn.endMessageIndex + 1)
                    .map((message) => (
                      <MessageItem
                        key={message.id}
                        message={message}
                        onOpenWiki={onOpenWiki}
                        onRetry={onRetry}
                        onDelete={onDelete}
                        retryTargetId={
                          message.role === 'user' ? turn.assistant?.id : undefined
                        }
                      />
                    ))}
                </div>
              ))}
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
