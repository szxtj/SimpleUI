import React, { useRef, useEffect, useState, useCallback } from 'react';
import { ChatMessage, TurnMetrics, TurnStageRecord } from '../types/chat';
import { useI18n } from '../i18n';
import { useFollowBottom } from '../hooks/useFollowBottom';
import { MessageItem } from './MessageItem';
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
  messages: ChatMessage[];
  input: string;
  setInput: (val: string) => void;
  images: string[];
  setImages: React.Dispatch<React.SetStateAction<string[]>>;
  isGenerating: boolean;
  /**
   * 本轮是否由**本窗口**发起（主窗口 = 有自己的 abortController）。
   * 注意不能用 isGenerating：镜像窗口也会为"显示停止按钮"把它置 true，
   * 用它会导致两个窗口都去记录同一轮的阶段（双写、互相覆盖）。
   */
  ownsTurn: boolean;
  /** 阶段阶梯记录变化 → 回写消息（App 负责持久化 + 广播） */
  onStagesChange?: (messageId: string, stages: TurnStageRecord[]) => void;
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
}

export const ChatView: React.FC<ChatViewProps> = ({
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
  onStagesChange,
  isDeepSeek = false,
  ownsTurn,
}) => {
  const { t } = useI18n();
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const prevMessagesLengthRef = useRef(messages.length);
  const prevFirstMsgIdRef = useRef(messages[0]?.id);
  const userScrolledSinceSwitchRef = useRef(false);
  const [showModelMenu, setShowModelMenu] = useState(false);

  /**
   * 消息流容器的「思考期跟随」行为（与浮窗共用同一份 hook）。
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

  // 容器直接置底，彻底废弃 WebKit 异步 smooth scrollIntoView
  // （WebKit 的平滑滚动会在 KaTeX/图片异步排版时锁定偏上的中间坐标，并在用户下拉时强行拉回）
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

      // 应对 KaTeX 公式与媒体图片异步渲染撑高布局，在多帧与短定时器内安全校准。
      // 若用户在这几百毫秒内已主动滚轮/拖拽滚动条，则绝不再强行干预。
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
        className={`h-[52px] border-b border-black/5 dark:border-white/5 bg-[#f8f9fb]/80 dark:bg-[#18191c]/80 backdrop-blur flex items-center justify-between flex-shrink-0 select-none transition-all duration-200 ${
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

        {/* Right Tools: Knowledge Panel Toggle (hidden while open — panel has its own close) + Shrink to Spotlight */}
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
          仅在思考期由 useFollowBottom 钉底；用户一动即交还控制权。
          正文流式阶段与生成结束后完全不干预，彻底移除回正逻辑。 */}
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
        className="flex-1 min-h-0 overflow-y-auto px-3 cq-md:px-6 cq-lg:px-8 py-3 cq-md:py-6 pb-6 cq-md:pb-8 overscroll-y-contain [overflow-anchor:none]"
      >
        <div className="max-w-4xl mx-auto min-h-full flex flex-col justify-start">
          {messages.length === 0 ? (
            <div className="my-auto py-4 cq-md:py-8 cq-lg:py-10 flex flex-col items-center text-center w-full max-w-lg mx-auto">
              {/* App 图标。用 192px 的版本（`public/icon-192.png`）而不是 1024px 的源图：
                  页面最大只显示 48px（Retina 下 96 物理像素），192 已留足余量，
                  而源图有 1.17MB / 解码后 4MB，纯属浪费。两处引用同一张，运行时不再加载源图。
                  图标自带圆角与透明外框、四角为全透明，因此**不加** border-radius（会切掉外发光）
                  也**不加** box-shadow（阴影会沿矩形盒子走，在透明四角处露出直角）。
                  图形本身约占画布 85%，留白即 macOS 图标的标准边距，保持原尺寸即可。 */}
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
          ) : (
            <div className="space-y-4">
              {messages.map((message, idx) => (
                <MessageItem
                  key={message.id}
                  message={message}
                  onOpenWiki={onOpenWiki}
                  onRetry={onRetry}
                  onDelete={onDelete}
                  turnRecording={ownsTurn}
                  onStagesChange={onStagesChange}
                  // 用户气泡的重试目标：紧随其后的助手回复 id（与浮窗的用户气泡重试一致）
                  retryTargetId={
                    message.role === 'user' && messages[idx + 1]?.role === 'assistant'
                      ? messages[idx + 1].id
                      : undefined
                  }
                />
              ))}
              <div ref={messagesEndRef} className="h-8 flex-shrink-0" />
            </div>
          )}
        </div>
      </div>

      {/* Input Area (Bottom capsule + Disclaimer) */}
      <div className="w-full px-3 cq-md:px-6 cq-lg:px-8 pb-3 cq-md:pb-4 pt-1 bg-gradient-to-t from-[#f8f9fb] via-[#f8f9fb]/95 to-transparent dark:from-[#18191c] dark:via-[#18191c]/95 dark:to-transparent">
        <div className="max-w-4xl mx-auto flex flex-col items-center">
          {/* Chat Input Capsule */}
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
          />

          {/* Qianwen Style Disclaimer below input box */}
          <div className="mt-2 text-[11px] text-zinc-400 dark:text-zinc-500 select-none">
            {t('aiDisclaimer')}
          </div>
        </div>
      </div>
    </div>
  );
};
