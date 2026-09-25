import React, { useRef, useEffect, useState } from 'react';
import { ChatMessage, TurnMetrics } from '../types/chat';
import { useI18n } from '../i18n';
import { MessageItem } from './MessageItem';
import { ChatInput } from './ChatInput';
import {
  Sparkles,
  HelpCircle,
  Code2,
  BookOpen,
  ChevronDown,
  Check,
  Settings,
  PanelLeftOpen,
} from 'lucide-react';

interface ChatViewProps {
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
  onOpenSettings: () => void;
  isSidebarOpen: boolean;
  onToggleSidebar: () => void;
  enableWikiSearch?: boolean;
  setEnableWikiSearch?: (val: boolean) => void;
  wikiConnected?: boolean;
  onOpenWiki?: (title: string) => void;
  onRetry?: (messageId: string) => void;
  onDelete?: (messageId: string) => void;
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
  onOpenSettings,
  isSidebarOpen,
  onToggleSidebar,
  enableWikiSearch,
  setEnableWikiSearch,
  wikiConnected,
  onOpenWiki,
  onRetry,
  onDelete,
}) => {
  const { t } = useI18n();
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const prevMessagesLengthRef = useRef(messages.length);
  const prevFirstMsgIdRef = useRef(messages[0]?.id);
  const [showModelMenu, setShowModelMenu] = useState(false);

  // Auto-scroll to bottom only on new turns, session change, or while actively thinking/generating
  useEffect(() => {
    const isNewMessage = messages.length > prevMessagesLengthRef.current;
    const isDifferentSession = messages[0]?.id !== prevFirstMsgIdRef.current;
    prevMessagesLengthRef.current = messages.length;
    prevFirstMsgIdRef.current = messages[0]?.id;

    const lastMsg = messages[messages.length - 1];
    const isActivelyThinking = lastMsg?.role === 'assistant' && lastMsg?.isThinking === true;

    if (isDifferentSession || isNewMessage) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    } else if (isActivelyThinking || isGenerating) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'auto' });
    }
  }, [messages, isGenerating]);

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

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden bg-[#f8f9fb] dark:bg-[#18191c]">
      {/* Top 52px Header Bar */}
      <div
        className={`h-[52px] border-b border-black/5 dark:border-white/5 bg-[#f8f9fb]/80 dark:bg-[#18191c]/80 backdrop-blur flex items-center justify-between flex-shrink-0 select-none transition-all duration-200 ${
          !isSidebarOpen ? 'pl-[78px] pr-6' : 'px-6'
        }`}
      >
        {/* Left: Open Sidebar Button (when collapsed) + Model Selector */}
        <div className="flex items-center gap-2">
          {!isSidebarOpen && (
            <button
              type="button"
              onClick={onToggleSidebar}
              className="p-1.5 rounded-lg text-zinc-500 hover:text-zinc-900 hover:bg-black/5 dark:text-zinc-400 dark:hover:text-white dark:hover:bg-white/5 transition-colors mr-1"
              title={t('expandSidebar')}
            >
              <PanelLeftOpen className="w-4 h-4" />
            </button>
          )}

          {/* Model Selector Dropdown */}
          <div className="relative">
            <button
              type="button"
              onClick={() => setShowModelMenu(!showModelMenu)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-sm font-semibold text-[#1f2328] dark:text-[#f1f3f7] hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
            >
              <span>{modelId || 'gemma-4-26b-a4b-it'}</span>
              <ChevronDown className="w-3.5 h-3.5 text-zinc-400" />
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
        <div className="flex-1 h-full" />

        {/* Right Tools: Settings */}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onOpenSettings}
            className="p-1.5 rounded-lg text-zinc-500 hover:text-zinc-900 hover:bg-black/5 dark:text-zinc-400 dark:hover:text-white dark:hover:bg-white/5 transition-colors"
            title={t('settings')}
          >
            <Settings className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Messages Stream Scroll Area */}
      <div className="flex-1 overflow-y-auto px-4 md:px-8 py-6">
        <div className="max-w-4xl mx-auto min-h-full flex flex-col justify-start">
          {messages.length === 0 ? (
            <div className="my-auto py-12 flex flex-col items-center text-center w-full max-w-lg mx-auto">
              <div className="w-12 h-12 rounded-2xl bg-gradient-to-tr from-blue-600 to-indigo-600 flex items-center justify-center shadow-lg shadow-blue-500/20 mb-4">
                <Sparkles className="w-6 h-6 text-white" />
              </div>
              <h1 className="text-xl font-semibold text-[#1f2328] dark:text-[#f3f5f8] mb-2 tracking-tight">
                {t('greetingTitle')}
              </h1>
              <p className="text-xs text-zinc-500 dark:text-zinc-400 mb-8 max-w-md">
                {t('greetingSubtitle')}
              </p>

              {/* Quick suggestion cards */}
              <div className="w-full grid grid-cols-1 gap-2.5 text-left">
                {quickPrompts.map((p, idx) => (
                  <button
                    key={idx}
                    onClick={() => {
                      setInput(p.prompt);
                    }}
                    className="flex items-start gap-3 p-3.5 rounded-2xl border border-black/5 dark:border-white/5 bg-white dark:bg-[#202126]/60 hover:bg-[#f3f4f7] dark:hover:bg-[#25272e] hover:border-black/10 dark:hover:border-white/10 shadow-sm transition-all text-left group"
                  >
                    <div className="mt-0.5 p-1.5 rounded-xl bg-black/5 dark:bg-white/5 group-hover:scale-105 transition-transform">
                      {p.icon}
                    </div>
                    <div>
                      <div className="text-xs font-medium text-zinc-800 group-hover:text-zinc-950 dark:text-zinc-200 dark:group-hover:text-white">
                        {p.title}
                      </div>
                      <div className="text-[11px] text-zinc-500 dark:text-zinc-400 mt-0.5">
                        {p.desc}
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              {messages.map((message) => (
                <MessageItem
                  key={message.id}
                  message={message}
                  onOpenWiki={onOpenWiki}
                  onRetry={onRetry}
                  onDelete={onDelete}
                />
              ))}
              <div ref={messagesEndRef} className="h-4" />
            </div>
          )}
        </div>
      </div>

      {/* Input Area (Bottom capsule + Disclaimer) */}
      <div className="w-full px-4 md:px-8 pb-4 pt-1 bg-gradient-to-t from-[#f8f9fb] via-[#f8f9fb]/95 to-transparent dark:from-[#18191c] dark:via-[#18191c]/95 dark:to-transparent">
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
