import React, { useState, useEffect, useRef } from 'react';
import {
  ChatMessage,
  AppSettings,
  ServerHealthInfo,
  WikiStatusInfo,
  WikiCitation,
} from '../types/chat';
import {
  loadSettings,
  loadSessions,
  saveSessions,
  loadCurrentSessionId,
  saveCurrentSessionId,
  notifySessionUpdate,
  syncChannel,
} from '../services/storage';
import { TurboFieldfareAPI, WikiAPI } from '../services/api';
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
  BookOpen,
  Copy,
  Check,
  Maximize2,
  X,
  MessageSquarePlus,
} from 'lucide-react';
import { useI18n } from '../i18n';
import { useTheme } from '../hooks/useTheme';

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
    connected: false,
    port: 31236,
    zimPath: null,
    contentId: null,
    bookTitle: 'Knowledge Base',
    articleCount: 0,
    mediaCount: 0,
  });
  const [usedTokens, setUsedTokens] = useState<number>(0);
  const [copied, setCopied] = useState(false);
  const activeSessionIdRef = useRef<string | null>(null);
  const isGeneratingRef = useRef(false);
  const messagesRef = useRef<ChatMessage[]>(messages);
  const inputRef = useRef('');
  const settingsRef = useRef<AppSettings>(settings);
  const currentAsstMsgIdRef = useRef<string | null>(null);
  const accumulatedThoughtRef = useRef('');
  const accumulatedContentRef = useRef('');
  const thinkingStartTimeRef = useRef(0);

  // Conversation-level toggles (both default to FALSE / OFF as requested)
  const [enableThinking, setEnableThinking] = useState(false);
  const [enableWikiSearch, setEnableWikiSearch] = useState(false);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const scrollEndRef = useRef<HTMLDivElement>(null);
  const prevMessagesLengthRef = useRef(messages.length);
  const prevFirstMsgIdRef = useRef(messages[0]?.id);

  const hasMessages = messages.length > 0;

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

  // Notify native AppKit panel to resize dynamically
  const notifyResize = (expanded: boolean) => {
    // @ts-expect-error WebKit bridge
    if (window.webkit?.messageHandlers?.resizePanel) {
      if (expanded) {
        // @ts-expect-error WebKit bridge
        window.webkit.messageHandlers.resizePanel.postMessage({
          width: 500,
          height: 640,
          expanded: true,
        });
      } else {
        // @ts-expect-error WebKit bridge
        window.webkit.messageHandlers.resizePanel.postMessage({
          width: 540,
          height: 88,
          expanded: false,
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

  // Real-time synchronization of settings & streaming across windows via syncChannel
  useEffect(() => {
    if (!syncChannel) return;

    const handler = (event: MessageEvent) => {
      const data = event.data;
      if (!data) return;

      if (data.type === 'SETTINGS_CHANGED') {
        setSettings(loadSettings());
      } else if (data.type === 'STREAM_CHUNK') {
        if (data.source !== 'SPOTLIGHT') {
          recordActivity();
          const { sessionId, messageId, reasoningContent, content, isThinking, thinkingDuration } = data;
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
                      }
                    : m
                );
              }
              const all = loadSessions();
              const target = all.find((s) => s.id === sessionId);
              if (target && target.messages && target.messages.length > 0) {
                return target.messages;
              }
              return prev;
            });
          }
        }
      } else if (data.type === 'STREAM_DONE') {
        if (data.source !== 'SPOTLIGHT') {
          const { sessionId, messageId, reasoningContent, content, thinkingDuration, metrics } = data;
          if (activeSessionIdRef.current === sessionId) {
            setIsGenerating(false);
            recordActivity();
            setMessages((prev) =>
              prev.map((m) =>
                m.id === messageId
                  ? {
                      ...m,
                      reasoningContent,
                      content,
                      isThinking: false,
                      thinkingDuration,
                      metrics,
                    }
                  : m
              )
            );
          }
        }
      } else if (data.type === 'STREAM_ABORT') {
        if (data.sessionId === activeSessionIdRef.current) {
          if (abortControllerRef.current) {
            abortControllerRef.current.abort();
            abortControllerRef.current = null;
          }
          setIsGenerating(false);
        }
      } else if (data.type === 'STREAM_QUERY') {
        if (isGeneratingRef.current && abortControllerRef.current && activeSessionIdRef.current) {
          syncChannel?.postMessage({
            type: 'STREAM_CHUNK',
            sessionId: activeSessionIdRef.current,
            messageId: currentAsstMsgIdRef.current,
            reasoningContent: accumulatedThoughtRef.current,
            content: accumulatedContentRef.current,
            isThinking: !accumulatedContentRef.current && enableThinking,
            thinkingDuration: (performance.now() - thinkingStartTimeRef.current) / 1000,
            source: 'SPOTLIGHT',
          });
        }
      } else if (data.type === 'SESSIONS_CHANGED') {
        if (!isGeneratingRef.current && activeSessionIdRef.current && data.sessionId === activeSessionIdRef.current) {
          const all = loadSessions();
          const target = all.find((s) => s.id === activeSessionIdRef.current);
          if (target && target.messages) {
            setMessages(target.messages);
            setEnableThinking(target.enableThinking ?? false);
            setEnableWikiSearch(target.enableWikiSearch ?? false);
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

  // Global ESC key listener to close floating spotlight window WITHOUT stopping generation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      recordActivity();
      if (e.key === 'Escape') {
        // NOTE: Esc closes Spotlight window, but does NOT stop ongoing background generation!
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

  const handleSend = async () => {
    const textToSend = input.trim();
    if (!textToSend && images.length === 0) return;
    if (isGenerating) return;

    const currentImages = [...images];
    setInput('');
    setImages([]);

    const userMessage: ChatMessage = {
      id: 'msg-' + Date.now() + '-user',
      role: 'user',
      content: textToSend,
      images: currentImages.length > 0 ? currentImages : undefined,
      timestamp: Date.now(),
    };

    const asstMessageId = 'msg-' + (Date.now() + 1) + '-asst';
    currentAsstMsgIdRef.current = asstMessageId;
    const initialAsstMessage: ChatMessage = {
      id: asstMessageId,
      role: 'assistant',
      content: '',
      reasoningContent: '',
      isThinking: enableThinking,
      timestamp: Date.now() + 1,
    };

    const nextMessages = [...messages, userMessage, initialAsstMessage];
    setMessages(nextMessages);
    setIsGenerating(true);
    recordActivity();

    // 1. IMMEDIATELY CREATE / SYNC SESSION IN STORAGE AND BROADCAST TO MAIN WINDOW
    let currentSessionId = activeSessionIdRef.current;
    if (!currentSessionId) {
      currentSessionId = 'session-' + Date.now() + '-' + Math.random().toString(36).substring(2, 7);
      activeSessionIdRef.current = currentSessionId;
    }

    const title = (messages[0]?.content || userMessage.content).slice(0, 24) || t('quickChat');
    try {
      const allSessions = loadSessions();
      const existingIdx = allSessions.findIndex((s) => s.id === currentSessionId);
      if (existingIdx >= 0) {
        allSessions[existingIdx] = {
          ...allSessions[existingIdx],
          messages: nextMessages,
          enableThinking,
          enableWikiSearch,
          updatedAt: Date.now(),
        };
        saveSessions(allSessions);
      } else {
        const cleanSessions = allSessions.filter((s) => s.messages && s.messages.length > 0);
        cleanSessions.unshift({
          id: currentSessionId,
          title,
          messages: nextMessages,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          contextUsed: usedTokens,
          enableThinking,
          enableWikiSearch,
        });
        saveSessions(cleanSessions);
      }
      saveCurrentSessionId(currentSessionId);
      notifySessionUpdate(currentSessionId, 'SPOTLIGHT');
    } catch (e) {
      console.error('Failed to immediately sync session to main window:', e);
    }

    // 2. Offline Wiki RAG Retrieval if enabled (supports both Simplified and Traditional Chinese)
    let promptToSend = textToSend;
    let foundCitations: WikiCitation[] = [];

    if (enableWikiSearch && wikiStatus.connected && textToSend) {
      try {
        const rag = await WikiAPI.getRagContext(textToSend);
        if (rag.needsWiki && rag.citations && rag.citations.length > 0) {
          foundCitations = rag.citations;
          const userQuestionHeader = lang === 'en' ? '[User Question]' : '[用户问题]';
          const instructionHeader = lang === 'en'
            ? '[Please answer the user\'s question accurately and objectively using the knowledge base references above, providing relevant facts and data directly]'
            : '[请结合上述知识库参考资料准确客观地回答用户问题，直接给出相关数据与事实]';
          promptToSend = `${rag.promptContext}\n\n${userQuestionHeader}\n${textToSend}\n\n${instructionHeader}`;
        }
      } catch (err) {
        console.warn('Knowledge Base retrieval error in spotlight:', err);
      }
    }

    const abortController = new AbortController();
    abortControllerRef.current = abortController;
    thinkingStartTimeRef.current = performance.now();
    const thinkingStartTime = thinkingStartTimeRef.current;

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
        const currentId = activeSessionIdRef.current;
        if (!currentId) return;
        const all = loadSessions();
        const idx = all.findIndex((s) => s.id === currentId);
        if (idx >= 0) {
          const asstMsg: ChatMessage = {
            id: asstMessageId,
            role: 'assistant',
            content: accumulatedContent,
            reasoningContent: accumulatedThought,
            isThinking: isFinal ? false : (!accumulatedContent && enableThinking),
            thinkingDuration: finalThinkingDuration || (performance.now() - thinkingStartTime) / 1000,
            timestamp: Date.now(),
            metrics,
            citations: foundCitations.length > 0 ? foundCitations : undefined,
            error: err?.message,
          };
          all[idx] = {
            ...all[idx],
            messages: [...messages, userMessage, asstMsg],
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

    const messagesWithPrompt: ChatMessage[] = [
      ...messages,
      {
        ...userMessage,
        content: promptToSend,
      },
    ];

    const sessionSettings = {
      ...settings,
      enableThinking,
      enableWikiSearch,
    };

    await TurboFieldfareAPI.streamChat(
      messagesWithPrompt,
      sessionSettings,
      {
        onFirstToken: () => {},
        onThought: (delta) => {
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
            source: 'SPOTLIGHT',
          });
        },
        onContent: (delta) => {
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
            source: 'SPOTLIGHT',
          });
        },
        onDone: (metrics) => {
          setIsGenerating(false);
          abortControllerRef.current = null;
          recordActivity();
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
            citations: foundCitations.length > 0 ? foundCitations : undefined,
          };

          setMessages((prev) =>
            prev.map((m) => (m.id === asstMessageId ? finalAsstMessage : m))
          );
          persistSession(true, metrics);
          syncChannel?.postMessage({
            type: 'STREAM_DONE',
            sessionId: currentSessionId,
            messageId: asstMessageId,
            reasoningContent: accumulatedThought,
            content: accumulatedContent,
            thinkingDuration: finalThinkingDuration,
            metrics,
            source: 'SPOTLIGHT',
          });
        },
        onError: (err) => {
          setIsGenerating(false);
          abortControllerRef.current = null;
          recordActivity();
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

  const handleStop = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    setIsGenerating(false);
    syncChannel?.postMessage({
      type: 'STREAM_ABORT',
      sessionId: activeSessionIdRef.current,
      source: 'SPOTLIGHT',
    });
  };

  const handleNewChat = () => {
    if (isGenerating && abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    setIsGenerating(false);
    activeSessionIdRef.current = null;
    setMessages([]);
    setInput('');
    setImages([]);
    // Reset conversation-level toggles to default false
    setEnableThinking(false);
    setEnableWikiSearch(false);
    notifyResize(false);
    recordActivity();
  };

  const handleOpenInMain = () => {
    // If there is any content, ensure it is written to storage before transitioning
    if (messages.length > 0) {
      try {
        const title = (messages[0]?.content || '').slice(0, 24) || t('quickChat');
        const currentId =
          activeSessionIdRef.current || loadCurrentSessionId() || ('session-' + Date.now());
        activeSessionIdRef.current = currentId;
        const allSessions = loadSessions();
        const existingIdx = allSessions.findIndex((s) => s.id === currentId);
        if (existingIdx >= 0) {
          allSessions[existingIdx] = {
            ...allSessions[existingIdx],
            messages,
            contextUsed: usedTokens,
            enableThinking,
            enableWikiSearch,
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
            enableThinking,
            enableWikiSearch,
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

    // Reset Spotlight to fresh state and default position
    handleNewChat();
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

  /* ========================================================================= */
  /* STATE 1: INITIAL COMPACT INPUT CAPSULE (Clean flat surface, NO shadows)   */
  /* ========================================================================= */
  if (!hasMessages) {
    return (
      <div className="w-full h-full select-none bg-transparent">
        {/* Outer frame: gray background matching expanded bottom (bg-[#f8f9fb] / dark:bg-[#17181c]) */}
        <div className="w-full h-full bg-[#f8f9fb] dark:bg-[#17181c] border border-black/10 dark:border-white/10 rounded-[22px] p-2 overflow-hidden flex flex-col justify-center">
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
                placeholder={t('placeholderInitial')}
                autoFocus
                className="w-full bg-transparent text-[14px] text-[#1f2328] dark:text-[#f1f3f7] placeholder-zinc-400 dark:placeholder-zinc-500 focus:outline-none font-normal"
              />
            </div>

            {/* Image preview pills if pasted */}
            {images.length > 0 && (
              <div className="flex gap-1.5 px-0.5 py-0.5">
                {images.map((img, idx) => (
                  <div key={idx} className="relative group">
                    <img src={img} alt="thumb" className="w-6 h-6 rounded-md object-cover border border-black/10 dark:border-white/20" />
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

                {/* Offline Wiki Knowledge Toggle Button */}
                <button
                  type="button"
                  onClick={() => wikiStatus.connected && toggleWiki(!enableWikiSearch)}
                  disabled={!wikiStatus.connected}
                  className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium transition-all active:scale-95 border ${
                    !wikiStatus.connected
                      ? 'opacity-40 cursor-not-allowed bg-black/5 text-zinc-400 dark:bg-white/5 dark:text-zinc-500 border-transparent'
                      : enableWikiSearch
                      ? 'bg-emerald-50 text-emerald-700 border-emerald-200 hover:bg-emerald-100 dark:bg-emerald-950/70 dark:text-emerald-300 dark:border-emerald-500/40 dark:hover:bg-emerald-900/80'
                      : 'bg-black/5 text-zinc-600 border-black/5 hover:bg-black/10 hover:text-black dark:bg-white/5 dark:text-zinc-300 dark:border-white/5 dark:hover:bg-white/10 dark:hover:text-white'
                  }`}
                  title={
                    !wikiStatus.connected
                      ? t('wikiDisconnectedTooltip')
                      : enableWikiSearch
                      ? t('wikiSearchOnTooltip')
                      : t('wikiSearchOffTooltip')
                  }
                >
                  <BookOpen className={`w-3.5 h-3.5 ${enableWikiSearch && wikiStatus.connected ? 'text-emerald-600 dark:text-emerald-400' : ''}`} />
                  <span>{t('offlineWiki')}</span>
                </button>
              </div>

              {/* Right: Send Button + Context Ring to its right */}
              <div className="flex items-center gap-2">
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

                <ContextRing usedTokens={usedTokens} maxContext={settings.maxContext} placement="left" />
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  /* ========================================================================= */
  /* STATE 2: EXPANDED CONVERSATION CARD (Clean flat surface, NO shadows)      */
  /* ========================================================================= */
  return (
    <div className="w-full h-full select-none bg-transparent">
      <div className="w-full h-full flex flex-col bg-white dark:bg-[#1c1d22] border border-black/10 dark:border-white/10 rounded-[22px] overflow-hidden text-[#1f2328] dark:text-[#f1f3f7] select-none">
        {/* Top Header Row */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-black/5 dark:border-white/5 cursor-grab active:cursor-grabbing select-none">
          {/* Left: ✖ inside circle + Title + Status dot */}
          <div className="flex items-center gap-2.5">
            <button
              onClick={() => {
                // NOTE: Clicking ✖ closes Spotlight window, but does NOT stop background generation!
                // @ts-expect-error WebKit bridge
                window.webkit?.messageHandlers?.closeSpotlight?.postMessage?.({});
              }}
              className="w-5 h-5 rounded-full bg-black/5 hover:bg-black/10 dark:bg-white/10 dark:hover:bg-white/20 flex items-center justify-center text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-white transition-colors cursor-pointer"
              title={t('closeEsc')}
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

        {/* Message Scroll Area */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4 text-sm">
          {messages.map((msg) => {
            if (msg.role === 'user') {
              return (
                <div key={msg.id} className="flex justify-end">
                  <div className="max-w-[85%] bg-blue-600 text-white rounded-2xl px-4 py-2.5 text-[14.5px] leading-relaxed break-words">
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
                  <div className="text-[14.5px] leading-relaxed text-[#1f2328] dark:text-[#ecedf1]">
                    <MarkdownRenderer content={msg.content} />
                  </div>
                )}

                {/* Citations if any */}
                {msg.citations && msg.citations.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5 items-center">
                    <span className="text-[10px] text-zinc-500 font-medium">📚 {t('wikiCitations')}:</span>
                    {msg.citations.map((c, idx) => (
                      <span
                        key={idx}
                        className="text-[11px] px-2 py-0.5 rounded-md bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 font-medium"
                      >
                        {c.title}
                      </span>
                    ))}
                  </div>
                )}

                {/* Error if any */}
                {msg.error && (
                  <div className="p-2.5 rounded-lg bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-800/60 text-xs text-red-600 dark:text-red-300">
                    {msg.error}
                  </div>
                )}

                {/* Action Toolbar under message: ONLY "复制" button + Gray Prefill/tok/s metrics */}
                {msg.content && !isGenerating && (
                  <div className="flex items-center gap-3 pt-1 text-xs select-none">
                    <button
                      onClick={() => handleCopyText(msg.content)}
                      className="flex items-center gap-1.5 px-2 py-1 rounded-md text-zinc-500 hover:text-zinc-900 hover:bg-black/5 dark:text-zinc-400 dark:hover:text-white dark:hover:bg-white/5 transition-colors"
                      title={t('copyTooltip')}
                    >
                      {copied ? (
                        <>
                          <Check className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
                          <span className="text-emerald-600 dark:text-emerald-400 text-xs">{t('copied')}</span>
                        </>
                      ) : (
                        <>
                          <Copy className="w-3.5 h-3.5" />
                          <span className="text-xs">{t('copy')}</span>
                        </>
                      )}
                    </button>

                    {/* Gray Prefill & tok/s metrics */}
                    {msg.metrics && (
                      <span className="text-xs font-mono text-zinc-500 dark:text-zinc-400">
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

        {/* Bottom Input Capsule */}
        <div className="p-2.5 bg-[#f8f9fb] dark:bg-[#17181c] border-t border-black/5 dark:border-white/5">
          <ImageAttachment
            images={images}
            onRemove={(idx) => setImages((prev) => prev.filter((_, i) => i !== idx))}
          />

          <div className="bg-white dark:bg-[#25262c] border border-black/10 dark:border-white/10 rounded-[16px] p-2 flex flex-col justify-between">
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
              placeholder={t('spotlightInputPlaceholder')}
              className="w-full bg-transparent text-sm text-[#1f2328] dark:text-[#f1f3f7] placeholder-zinc-400 dark:placeholder-zinc-500 px-2 py-1 focus:outline-none"
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

                {/* Offline Wiki Knowledge Toggle Button */}
                <button
                  type="button"
                  onClick={() => wikiStatus.connected && toggleWiki(!enableWikiSearch)}
                  disabled={!wikiStatus.connected}
                  className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium transition-all active:scale-95 border ${
                    !wikiStatus.connected
                      ? 'opacity-40 cursor-not-allowed bg-black/5 text-zinc-400 dark:bg-white/5 dark:text-zinc-500 border-transparent'
                      : enableWikiSearch
                      ? 'bg-emerald-50 text-emerald-700 border-emerald-200 hover:bg-emerald-100 dark:bg-emerald-950/70 dark:text-emerald-300 dark:border-emerald-500/40 dark:hover:bg-emerald-900/80'
                      : 'bg-black/5 text-zinc-600 border-black/5 hover:bg-black/10 hover:text-black dark:bg-white/5 dark:text-zinc-300 dark:border-white/5 dark:hover:bg-white/10 dark:hover:text-white'
                  }`}
                  title={
                    !wikiStatus.connected
                      ? t('wikiDisconnectedTooltip')
                      : enableWikiSearch
                      ? t('wikiSearchOnTooltip')
                      : t('wikiSearchOffTooltip')
                  }
                >
                  <BookOpen className={`w-3.5 h-3.5 ${enableWikiSearch && wikiStatus.connected ? 'text-emerald-600 dark:text-emerald-400' : ''}`} />
                  <span>{t('offlineWiki')}</span>
                </button>
              </div>

              {/* Right: Send Button + Context Ring */}
              <div className="flex items-center gap-2">
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

                <ContextRing usedTokens={usedTokens} maxContext={settings.maxContext} />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
