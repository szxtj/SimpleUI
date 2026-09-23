import React, { useState, useEffect, useRef } from 'react';
import {
  ChatMessage,
  AppSettings,
  ServerHealthInfo,
} from '../types/chat';
import {
  loadSettings,
  saveSettings,
  loadSessions,
  saveSessions,
  loadCurrentSessionId,
  saveCurrentSessionId,
  notifySessionUpdate,
} from '../services/storage';
import { TurboFieldfareAPI } from '../services/api';
import { MarkdownRenderer } from './MarkdownRenderer';
import { ThinkingAccordion } from './ThinkingAccordion';
import { ImageAttachment } from './ImageAttachment';
import { ContextRing } from './ContextRing';
import { extractImagesFromPaste, fileToDataURL } from '../utils/image';
import {
  ArrowUp,
  Square,
  Plus,
  Zap,
  Brain,
  Copy,
  Check,
  Maximize2,
  X,
  MessageSquarePlus,
} from 'lucide-react';

export const SpotlightView: React.FC = () => {
  const [settings, setSettings] = useState<AppSettings>(loadSettings());
  const [input, setInput] = useState('');
  const [images, setImages] = useState<string[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [healthInfo, setHealthInfo] = useState<ServerHealthInfo>({
    status: 'connecting',
    vision: 'missing',
    online: false,
  });
  const [usedTokens, setUsedTokens] = useState<number>(0);
  const [copied, setCopied] = useState(false);
  const activeSessionIdRef = useRef<string | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const scrollEndRef = useRef<HTMLDivElement>(null);
  const prevMessagesLengthRef = useRef(messages.length);
  const prevFirstMsgIdRef = useRef(messages[0]?.id);

  const hasMessages = messages.length > 0;

  // Notify native AppKit panel to resize dynamically
  const notifyResize = (expanded: boolean) => {
    // @ts-expect-error WebKit bridge
    if (window.webkit?.messageHandlers?.resizePanel) {
      if (expanded) {
        // @ts-expect-error WebKit bridge
        window.webkit.messageHandlers.resizePanel.postMessage({
          width: 500,
          height: 640,
        });
      } else {
        // @ts-expect-error WebKit bridge
        window.webkit.messageHandlers.resizePanel.postMessage({
          width: 540,
          height: 88,
        });
      }
    }
  };

  useEffect(() => {
    notifyResize(hasMessages);
  }, [hasMessages]);

  useEffect(() => {
    const isNewMessage = messages.length > prevMessagesLengthRef.current;
    const isDifferentSession = messages[0]?.id !== prevFirstMsgIdRef.current;
    prevMessagesLengthRef.current = messages.length;
    prevFirstMsgIdRef.current = messages[0]?.id;

    const lastMsg = messages[messages.length - 1];
    const isActivelyThinking = lastMsg?.role === 'assistant' && lastMsg?.isThinking === true;

    if (isDifferentSession || isNewMessage || isActivelyThinking) {
      scrollEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages]);

  // Check backend health
  useEffect(() => {
    const checkServer = async () => {
      const info = await TurboFieldfareAPI.checkHealth(settings);
      setHealthInfo(info);
    };
    checkServer();
  }, [settings]);

  // Reload latest settings whenever Spotlight gains focus
  useEffect(() => {
    const handleFocus = () => {
      setSettings(loadSettings());
    };
    window.addEventListener('focus', handleFocus);
    return () => window.removeEventListener('focus', handleFocus);
  }, []);

  // Global ESC key listener to close floating spotlight window
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // @ts-expect-error WebKit bridge
        window.webkit?.messageHandlers?.closeSpotlight?.postMessage?.({});
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'o') {
        e.preventDefault();
        handleOpenInMain();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [messages, input]);

  const handleSend = async () => {
    const textToSend = input.trim();
    if (!textToSend && images.length === 0) return;
    if (isGenerating) return;

    const currentImages = [...images];
    setInput('');
    setImages([]);

    const userMessage: ChatMessage = {
      id: 'spot-user-' + Date.now(),
      role: 'user',
      content: textToSend,
      images: currentImages.length > 0 ? currentImages : undefined,
      timestamp: Date.now(),
    };

    const asstMessageId = 'spot-asst-' + (Date.now() + 1);
    const initialAsstMessage: ChatMessage = {
      id: asstMessageId,
      role: 'assistant',
      content: '',
      reasoningContent: '',
      isThinking: settings.enableThinking,
      timestamp: Date.now(),
    };

    setMessages((prev) => [...prev, userMessage, initialAsstMessage]);
    setIsGenerating(true);

    const abortController = new AbortController();
    abortControllerRef.current = abortController;
    const thinkingStartTime = performance.now();

    let accumulatedThought = '';
    let accumulatedContent = '';
    let finalThinkingDuration = 0;

    await TurboFieldfareAPI.streamChat(
      [...messages, userMessage],
      settings,
      {
        onFirstToken: () => {},
        onThought: (delta) => {
          accumulatedThought += delta;
          finalThinkingDuration = (performance.now() - thinkingStartTime) / 1000;
          setMessages((prev) =>
            prev.map((m) =>
              m.id === asstMessageId
                ? {
                    ...m,
                    reasoningContent: accumulatedThought,
                    isThinking: true,
                    thinkingDuration: finalThinkingDuration,
                  }
                : m
            )
          );
        },
        onContent: (delta) => {
          accumulatedContent += delta;
          setMessages((prev) =>
            prev.map((m) =>
              m.id === asstMessageId
                ? {
                    ...m,
                    content: accumulatedContent,
                    isThinking: false,
                  }
                : m
            )
          );
        },
        onDone: (metrics) => {
          setIsGenerating(false);
          abortControllerRef.current = null;
          setUsedTokens(metrics.contextUsed);

          const finalAsstMessage: ChatMessage = {
            id: asstMessageId,
            role: 'assistant',
            content: accumulatedContent,
            reasoningContent: accumulatedThought,
            isThinking: false,
            thinkingDuration: finalThinkingDuration,
            timestamp: Date.now(),
            metrics,
          };

          setMessages((prev) =>
            prev.map((m) => (m.id === asstMessageId ? finalAsstMessage : m))
          );

          // Persist current session into storage for Main Window sync
          try {
            const allSessions = loadSessions();
            const title = (messages[0]?.content || userMessage.content).slice(0, 24) || '快捷问答';
            const sessionId = activeSessionIdRef.current || ('sess-' + Date.now());
            activeSessionIdRef.current = sessionId;

            const existingIdx = allSessions.findIndex((s) => s.id === sessionId);
            const fullHistory = [...messages, userMessage, finalAsstMessage];

            if (existingIdx >= 0) {
              allSessions[existingIdx] = {
                ...allSessions[existingIdx],
                title: allSessions[existingIdx].title || title,
                messages: fullHistory,
                contextUsed: metrics.contextUsed,
                updatedAt: Date.now(),
              };
            } else {
              allSessions.unshift({
                id: sessionId,
                title,
                messages: fullHistory,
                createdAt: Date.now(),
                updatedAt: Date.now(),
                contextUsed: metrics.contextUsed,
              });
            }

            saveSessions(allSessions);
            saveCurrentSessionId(sessionId);
            notifySessionUpdate(sessionId, 'SPOTLIGHT');
          } catch (e) {
            console.error('Failed to sync spotlight session:', e);
          }
        },
        onError: (err) => {
          setIsGenerating(false);
          abortControllerRef.current = null;
          const finalAsstMessage: ChatMessage = {
            id: asstMessageId,
            role: 'assistant',
            content: accumulatedContent,
            reasoningContent: accumulatedThought,
            isThinking: false,
            thinkingDuration: (performance.now() - thinkingStartTime) / 1000,
            timestamp: Date.now(),
            error: err.message,
          };

          setMessages((prev) =>
            prev.map((m) => (m.id === asstMessageId ? finalAsstMessage : m))
          );

          try {
            const allSessions = loadSessions();
            const title = (messages[0]?.content || userMessage.content).slice(0, 24) || '快捷问答';
            const sessionId = activeSessionIdRef.current || ('sess-' + Date.now());
            activeSessionIdRef.current = sessionId;

            const existingIdx = allSessions.findIndex((s) => s.id === sessionId);
            const fullHistory = [...messages, userMessage, finalAsstMessage];

            if (existingIdx >= 0) {
              allSessions[existingIdx] = {
                ...allSessions[existingIdx],
                messages: fullHistory,
                updatedAt: Date.now(),
              };
            } else {
              allSessions.unshift({
                id: sessionId,
                title,
                messages: fullHistory,
                createdAt: Date.now(),
                updatedAt: Date.now(),
                contextUsed: 0,
              });
            }

            saveSessions(allSessions);
            saveCurrentSessionId(sessionId);
            notifySessionUpdate(sessionId, 'SPOTLIGHT');
          } catch (e) {
            console.error('Failed to sync spotlight error session:', e);
          }
        },
      },
      abortController.signal
    );
  };

  const handleStop = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
      setIsGenerating(false);
      setMessages((prev) =>
        prev.map((m) => (m.isThinking ? { ...m, isThinking: false } : m))
      );
    }
  };

  const handleNewChat = () => {
    activeSessionIdRef.current = null;
    setMessages([]);
    setInput('');
    setImages([]);
    notifyResize(false);
  };

  const handleOpenInMain = () => {
    // If there is any content, ensure it is written to storage before transitioning
    if (messages.length > 0) {
      try {
        const title = (messages[0]?.content || '').slice(0, 24) || '快捷问答';
        const currentId =
          activeSessionIdRef.current || loadCurrentSessionId() || ('sess-' + Date.now());
        activeSessionIdRef.current = currentId;
        const allSessions = loadSessions();
        const existingIdx = allSessions.findIndex((s) => s.id === currentId);
        if (existingIdx >= 0) {
          allSessions[existingIdx] = {
            ...allSessions[existingIdx],
            messages,
            contextUsed: usedTokens,
            updatedAt: Date.now(),
          };
        } else {
          allSessions.unshift({
            id: currentId,
            title,
            messages,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            contextUsed: usedTokens,
          });
        }
        saveSessions(allSessions);
        saveCurrentSessionId(currentId);
        notifySessionUpdate(currentId, 'SPOTLIGHT');
      } catch (e) {
        console.error('Failed to sync before open in main:', e);
      }
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
  };

  const handleCopyText = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
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

  const toggleThinking = (enabled: boolean) => {
    setSettings((prev) => ({ ...prev, enableThinking: enabled }));
    saveSettings({ ...settings, enableThinking: enabled });
  };

  /* ========================================================================= */
  /* STATE 1: INITIAL COMPACT INPUT CAPSULE (Matching Main Window Input)       */
  /* ========================================================================= */
  if (!hasMessages) {
    return (
      <div className="w-full h-full select-none bg-transparent">
        <div className="w-full h-full bg-[#25262c] border border-white/10 rounded-[28px] shadow-2xl px-4 py-2 flex flex-col justify-between">
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

          {/* Top text input row */}
          <div className="px-1 pt-0.5">
            <input
              ref={textareaRef as unknown as React.RefObject<HTMLInputElement>}
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  handleSend();
                }
              }}
              onPaste={handlePaste}
              placeholder="向 SimpleUI 提问..."
              autoFocus
              className="w-full bg-transparent text-[15px] text-[#f1f3f7] placeholder-zinc-500 focus:outline-none font-normal"
            />
          </div>

          {/* Image preview pills if pasted */}
          {images.length > 0 && (
            <div className="flex gap-1.5 px-1 py-0.5">
              {images.map((img, idx) => (
                <div key={idx} className="relative group">
                  <img src={img} alt="thumb" className="w-6 h-6 rounded-md object-cover border border-white/20" />
                  <button
                    onClick={() => setImages((prev) => prev.filter((_, i) => i !== idx))}
                    className="absolute -top-1 -right-1 w-3 h-3 bg-red-500 rounded-full text-[8px] text-white flex items-center justify-center"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Bottom actions row: Left (Attachment + Quick/Thinking), Right (Send + ContextRing) */}
          <div className="flex items-center justify-between pt-1">
            {/* Left: Attachment + Dual Mode Dropdown */}
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className={`w-7 h-7 rounded-full flex items-center justify-center transition-colors ${
                  images.length > 0
                    ? 'bg-blue-600 text-white shadow-sm'
                    : 'bg-white/5 hover:bg-white/10 text-zinc-300 hover:text-white'
                }`}
                title="添加附件或图片"
              >
                <Plus className="w-4 h-4 stroke-[2.5]" />
              </button>

              {/* Direct Toggle Button (⚡ 快速 / 🧠 思考) */}
              <button
                type="button"
                onClick={() => toggleThinking(!settings.enableThinking)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-all active:scale-95 border ${
                  settings.enableThinking
                    ? 'bg-blue-950/70 text-blue-300 border-blue-500/40 hover:bg-blue-900/80 shadow-sm'
                    : 'bg-white/5 text-zinc-300 border-white/5 hover:bg-white/10 hover:text-white'
                }`}
                title={settings.enableThinking ? '深度思考模式（点击切换为快速）' : '极速回复模式（点击切换为思考）'}
              >
                {settings.enableThinking ? (
                  <>
                    <Brain className="w-3.5 h-3.5 text-blue-400" />
                    <span>思考</span>
                  </>
                ) : (
                  <>
                    <Zap className="w-3.5 h-3.5 text-amber-400" />
                    <span>快速</span>
                  </>
                )}
              </button>
            </div>

            {/* Right: Send Button + Context Ring to its right */}
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleSend}
                disabled={!input.trim() && images.length === 0}
                className={`w-8 h-8 rounded-full flex items-center justify-center transition-all ${
                  input.trim() || images.length > 0
                    ? 'bg-white hover:bg-zinc-200 text-black shadow-md active:scale-95'
                    : 'bg-[#35363d] text-zinc-500 cursor-not-allowed'
                }`}
                title="发送 (Enter)"
              >
                <ArrowUp className="w-4 h-4 stroke-[2.5]" />
              </button>

              <ContextRing usedTokens={usedTokens} maxContext={settings.maxContext} placement="left" />
            </div>
          </div>
        </div>
      </div>
    );
  }

  /* ========================================================================= */
  /* STATE 2: EXPANDED CONVERSATION CARD                                       */
  /* ========================================================================= */
  return (
    <div className="w-full h-full flex flex-col bg-[#1c1d22] border border-white/10 rounded-[26px] shadow-2xl overflow-hidden text-[#f1f3f7] select-none">
      {/* Top Header Row */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-white/5">
        {/* Left: ✖ inside circle + Title + Status dot */}
        <div className="flex items-center gap-2.5">
          <button
            onClick={() => {
              // @ts-expect-error WebKit bridge
              window.webkit?.messageHandlers?.closeSpotlight?.postMessage?.({});
            }}
            className="w-5 h-5 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center text-zinc-400 hover:text-white transition-colors"
            title="关闭 (Esc)"
          >
            <X className="w-3 h-3" />
          </button>
          <span className="font-semibold text-sm text-[#f1f3f7] tracking-tight">
            SimpleUI
          </span>
          <span
            className={`w-1.5 h-1.5 rounded-full ${
              healthInfo.online ? 'bg-emerald-400' : 'bg-red-400'
            }`}
            title={healthInfo.online ? '服务就绪' : '服务未就绪'}
          />
        </div>

        {/* Right: New Chat + Expand to Main Window */}
        <div className="flex items-center gap-1.5 text-zinc-400">
          <button
            onClick={handleNewChat}
            className="p-1.5 rounded-lg hover:bg-white/5 hover:text-white transition-colors"
            title="新对话"
          >
            <MessageSquarePlus className="w-4 h-4" />
          </button>

          <button
            onClick={handleOpenInMain}
            className="p-1.5 rounded-lg hover:bg-white/5 hover:text-white transition-colors"
            title="在主窗口中打开 (⌘O)"
          >
            <Maximize2 className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Middle Messages Flow */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.map((msg) => {
          const isUser = msg.role === 'user';

          if (isUser) {
            return (
              <div key={msg.id} className="flex justify-end">
                <div className="max-w-[85%] px-4 py-2.5 rounded-[18px] bg-[#2d3037] text-sm text-white leading-relaxed shadow-sm">
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
              </div>
            );
          }

          // Assistant message
          return (
            <div key={msg.id} className="space-y-2">
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
                <div className="text-[14.5px] leading-relaxed text-[#ecedf1]">
                  <MarkdownRenderer content={msg.content} />
                </div>
              )}

              {/* Error if any */}
              {msg.error && (
                <div className="p-2.5 rounded-lg bg-red-950/50 border border-red-800/60 text-xs text-red-300">
                  {msg.error}
                </div>
              )}

              {/* Action Toolbar under message: ONLY "复制" button + Gray Prefill/tok/s metrics */}
              {msg.content && !isGenerating && (
                <div className="flex items-center gap-3 pt-1 text-xs select-none">
                  <button
                    onClick={() => handleCopyText(msg.content)}
                    className="flex items-center gap-1.5 px-2 py-1 rounded-md text-zinc-400 hover:text-white hover:bg-white/5 transition-colors"
                    title="复制回复"
                  >
                    {copied ? (
                      <>
                        <Check className="w-3.5 h-3.5 text-emerald-400" />
                        <span className="text-emerald-400 text-xs">已复制</span>
                      </>
                    ) : (
                      <>
                        <Copy className="w-3.5 h-3.5" />
                        <span className="text-xs">复制</span>
                      </>
                    )}
                  </button>

                  {/* Gray Prefill & tok/s metrics */}
                  {msg.metrics && (
                    <span className="text-xs font-mono text-zinc-500">
                      Prefill {msg.metrics.ttftMs}ms · {msg.metrics.tokensPerSecond} tok/s
                    </span>
                  )}
                </div>
              )}
            </div>
          );
        })}
        <div ref={scrollEndRef} />
      </div>

      {/* Bottom Input Capsule (Consistent with Main Window Input) */}
      <div className="p-3 bg-[#17181c] border-t border-white/5">
        <ImageAttachment
          images={images}
          onRemove={(idx) => setImages((prev) => prev.filter((_, i) => i !== idx))}
        />

        <div className="bg-[#25262c] border border-white/10 rounded-[22px] p-2.5 flex flex-col justify-between">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                handleSend();
              }
            }}
            placeholder="追问 SimpleUI..."
            className="w-full bg-transparent text-sm text-[#f1f3f7] placeholder-zinc-500 px-2 py-1 focus:outline-none"
          />

          <div className="flex items-center justify-between pt-1">
            {/* Left: Attachment + Dual Mode Dropdown */}
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="w-6 h-6 rounded-full flex items-center justify-center bg-white/5 hover:bg-white/10 text-zinc-300 hover:text-white transition-colors"
                title="添加图片"
              >
                <Plus className="w-3.5 h-3.5 stroke-[2.5]" />
              </button>

              <button
                type="button"
                onClick={() => toggleThinking(!settings.enableThinking)}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium transition-all active:scale-95 border ${
                  settings.enableThinking
                    ? 'bg-blue-950/70 text-blue-300 border-blue-500/40 hover:bg-blue-900/80 shadow-sm'
                    : 'bg-white/5 text-zinc-300 border-white/5 hover:bg-white/10 hover:text-white'
                }`}
                title={settings.enableThinking ? '深度思考模式（点击切换为快速）' : '极速回复模式（点击切换为思考）'}
              >
                {settings.enableThinking ? (
                  <>
                    <Brain className="w-3.5 h-3.5 text-blue-400" />
                    <span>思考</span>
                  </>
                ) : (
                  <>
                    <Zap className="w-3.5 h-3.5 text-amber-400" />
                    <span>快速</span>
                  </>
                )}
              </button>
            </div>

            {/* Right: Send Button + Context Ring */}
            <div className="flex items-center gap-2">
              {isGenerating ? (
                <button
                  type="button"
                  onClick={handleStop}
                  className="w-7 h-7 rounded-full bg-red-500 hover:bg-red-600 text-white flex items-center justify-center transition-transform active:scale-95"
                  title="停止生成"
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
                      ? 'bg-white hover:bg-zinc-200 text-black shadow-md active:scale-95'
                      : 'bg-[#35363d] text-zinc-500 cursor-not-allowed'
                  }`}
                  title="发送 (Enter)"
                >
                  <ArrowUp className="w-3.5 h-3.5 stroke-[2.5]" />
                </button>
              )}

              <ContextRing usedTokens={usedTokens} maxContext={settings.maxContext} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
