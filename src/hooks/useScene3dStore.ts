import { useState, useEffect, useRef, useCallback } from 'react';
import {
  ChatSession,
  ChatMessage,
  AppSettings,
  TurnMetrics,
  TurnStageRecord,
  WikiCitation,
} from '../types/chat';
import { syncCalibrationFactors, CalibrationProvider } from '../utils/token';

/**
 * 3D 场景构建窗口专用的会话与流式状态 Hook。
 *
 * 与 useSessionStore 完全同构（同一个服务端 SSE 总线 /api/sessions/events），
 * 但**只消费 kind === 'scene3d' 的会话**——主窗口/浮窗在 useSessionStore 里
 * 已把这些会话整体排除，两边互不可见。
 *
 * 会话指针是本窗口私有的（同 SPOTLIGHT 模式）：server 端的 mainSessionId 永远
 * 只归属主窗口的普通对话，3D 窗口绝不读它。
 */

/** 模型卡官方系统提示词：钉死 Three.js 版本与唯一 CDN 引用（离线重写依赖它） */
export const SCENE3D_SYSTEM_PROMPT = [
  'Use only the Three.js core ES module from',
  'https://cdnjs.cloudflare.com/ajax/libs/three.js/0.160.0/three.module.min.js.',
  'Do not import addons or legacy examples/js paths;',
  'implement any camera controls directly inside the HTML.',
].join(' ');

/** 3D 场景服务的端口（server/scene3d_service.js PORT 的前端镜像） */
export const SCENE3D_PORT = 1257;

/**
 * 每轮提问随请求发送的引擎设置。
 *
 * 走 custom provider + apiPort 1257 的既有本地引擎通路（server 端 startTurn 会
 * 据此拼 enable_thinking 并把端点指到 1257）；上下文按 hybrid GDN 的极小 KV
 * 余量给满 128K，生成预算 64K（一个完整场景 HTML 约 15–30K token，多轮修改
 * 时历史里有多份场景 HTML）。
 */
export function buildScene3dSettings(): AppSettings {
  return {
    apiProvider: 'custom',
    apiPort: SCENE3D_PORT,
    modelId: 'Qwen3.5-4B-3D-Coder',
    maxContext: 131072,
    maxTokens: 65536,
    enableThinking: true, // 模型按 thinking 轨迹训练，恒开（服务端 scene3d 会话也会强制 true）
    reasoningEffort: 'default',
    temperature: 0.7,
    topP: 0.95,
    topK: 20,
    repetitionPenalty: 1.0,
    stopStrings: [],
    systemPrompt: SCENE3D_SYSTEM_PROMPT,
  };
}

const isScene3dSession = (s: ChatSession) => s?.kind === 'scene3d';

interface ServerSnapshot {
  sessions: ChatSession[];
  mainSessionId: string | null;
  generatingSessionIds: string[];
  liveStreamingTokens: Record<string, number>;
  calibrationFactors?: Partial<Record<CalibrationProvider, number>>;
}

export function useScene3dStore(defaultTitle: string = '新场景') {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [generatingSessionIds, setGeneratingSessionIds] = useState<string[]>([]);
  const [liveStreamingTokens, setLiveStreamingTokens] = useState<Record<string, number>>({});
  const [lastMetrics, setLastMetrics] = useState<TurnMetrics | undefined>(undefined);

  const currentSessionIdRef = useRef<string | null>(currentSessionId);
  const sessionsRef = useRef<ChatSession[]>(sessions);

  useEffect(() => {
    currentSessionIdRef.current = currentSessionId;
  }, [currentSessionId]);

  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  const applySnapshot = useCallback((snap: ServerSnapshot) => {
    if (!snap || !Array.isArray(snap.sessions)) return;
    if (snap.calibrationFactors) {
      syncCalibrationFactors(snap.calibrationFactors);
    }
    const visible = snap.sessions.filter(isScene3dSession);
    sessionsRef.current = visible;
    setSessions(visible);
    setGeneratingSessionIds(snap.generatingSessionIds || []);
    setLiveStreamingTokens(snap.liveStreamingTokens || {});

    // 指针仅在指向的会话消失时回退到空会话；绝不跟随 mainSessionId
    const curId = currentSessionIdRef.current;
    if (!curId || !visible.some((s) => s.id === curId)) {
      const empty = visible.find((s) => !s.messages || s.messages.length === 0);
      const nextId = empty ? empty.id : null;
      currentSessionIdRef.current = nextId;
      setCurrentSessionId(nextId);
    }
  }, []);

  const refreshState = useCallback(async () => {
    try {
      const res = await fetch('/api/sessions/state');
      if (res.ok) {
        applySnapshot(await res.json());
      }
    } catch {
      // ignore transient network error during startup
    }
  }, [applySnapshot]);

  // SSE 订阅：与 useSessionStore 同一条总线，事件处理只保留 scene3d 相关分支
  useEffect(() => {
    let es: EventSource | null = null;
    let reconnectTimer: number | null = null;
    let chunkRafId: number | null = null;
    let unmounted = false;

    const scheduleSessionsCommit = () => {
      if (chunkRafId !== null) return;
      chunkRafId = window.requestAnimationFrame(() => {
        chunkRafId = null;
        if (!unmounted) {
          setSessions([...sessionsRef.current]);
        }
      });
    };

    const flushSessionsCommitNow = () => {
      if (chunkRafId !== null) {
        window.cancelAnimationFrame(chunkRafId);
        chunkRafId = null;
      }
      if (!unmounted) {
        setSessions([...sessionsRef.current]);
      }
    };

    const connect = () => {
      if (unmounted) return;
      es = new EventSource('/api/sessions/events');

      es.addEventListener('snapshot', (e: MessageEvent) => {
        try {
          applySnapshot(JSON.parse(e.data));
        } catch {
          // ignore
        }
      });

      es.addEventListener('session-upserted', (e: MessageEvent) => {
        try {
          const data: { session: ChatSession; moveToTop?: boolean } = JSON.parse(e.data);
          if (!data?.session || !isScene3dSession(data.session)) return;

          const prev = sessionsRef.current;
          const idx = prev.findIndex((s) => s.id === data.session.id);
          const next = data.moveToTop
            ? [data.session, ...prev.filter((s) => s.id !== data.session.id)]
            : idx >= 0
              ? prev.map((s, i) => (i === idx ? data.session : s))
              : [data.session, ...prev];
          sessionsRef.current = next;
          flushSessionsCommitNow();
        } catch {
          // ignore
        }
      });

      es.addEventListener('session-deleted', (e: MessageEvent) => {
        try {
          const data: { sessionId: string; sessions: ChatSession[] } = JSON.parse(e.data);
          if (!data || !Array.isArray(data.sessions)) return;

          const visible = data.sessions.filter(isScene3dSession);
          sessionsRef.current = visible;
          flushSessionsCommitNow();
          setGeneratingSessionIds((prev) => prev.filter((id) => id !== data.sessionId));

          if (currentSessionIdRef.current === data.sessionId) {
            const empty = visible.find((s) => !s.messages || s.messages.length === 0);
            const nextId = empty ? empty.id : null;
            currentSessionIdRef.current = nextId;
            setCurrentSessionId(nextId);
          }
        } catch {
          // ignore
        }
      });

      es.addEventListener('turn-progress', (e: MessageEvent) => {
        try {
          const data: { sessionId: string; liveTokens: number } = JSON.parse(e.data);
          if (!data?.sessionId || !sessionsRef.current.some((s) => s.id === data.sessionId))
            return;
          setGeneratingSessionIds((prev) =>
            prev.includes(data.sessionId) ? prev : [...prev, data.sessionId]
          );
          if (typeof data.liveTokens === 'number') {
            setLiveStreamingTokens((prev) => ({
              ...prev,
              [data.sessionId]: data.liveTokens,
            }));
          }
        } catch {
          // ignore
        }
      });

      es.addEventListener('turn-stage', (e: MessageEvent) => {
        try {
          const data: {
            sessionId: string;
            messageId: string;
            stage?: 'rag' | 'prefill';
            pending?: boolean;
            prefillStartedAt?: number;
            stages?: TurnStageRecord[];
          } = JSON.parse(e.data);
          if (!data?.sessionId || !data?.messageId) return;

          setGeneratingSessionIds((prev) =>
            prev.includes(data.sessionId) ? prev : [...prev, data.sessionId]
          );

          sessionsRef.current = sessionsRef.current.map((s) => {
            if (s.id !== data.sessionId) return s;
            return {
              ...s,
              messages: s.messages.map((m) =>
                m.id === data.messageId
                  ? {
                      ...m,
                      ...(data.stage !== undefined ? { stage: data.stage } : {}),
                      ...(data.pending !== undefined ? { pending: data.pending } : {}),
                      ...(data.prefillStartedAt !== undefined
                        ? { prefillStartedAt: data.prefillStartedAt }
                        : {}),
                      ...(data.stages !== undefined ? { stages: data.stages } : {}),
                    }
                  : m
              ),
            };
          });

          if (currentSessionIdRef.current !== data.sessionId) return;
          flushSessionsCommitNow();
        } catch {
          // ignore
        }
      });

      es.addEventListener('turn-chunk', (e: MessageEvent) => {
        try {
          const data: {
            sessionId: string;
            messageId: string;
            reasoningContent: string;
            content: string;
            isThinking: boolean;
            thinkingDuration: number;
            pending: boolean;
            stages?: TurnStageRecord[];
            citations?: WikiCitation[];
            liveTokens?: number;
          } = JSON.parse(e.data);
          if (!data?.sessionId || !data?.messageId) return;

          setGeneratingSessionIds((prev) =>
            prev.includes(data.sessionId) ? prev : [...prev, data.sessionId]
          );
          if (typeof data.liveTokens === 'number') {
            setLiveStreamingTokens((prev) => ({
              ...prev,
              [data.sessionId]: data.liveTokens!,
            }));
          }

          sessionsRef.current = sessionsRef.current.map((s) => {
            if (s.id !== data.sessionId) return s;
            const exists = s.messages.some((m) => m.id === data.messageId);
            const nextMsgs = exists
              ? s.messages.map((m) =>
                  m.id === data.messageId
                    ? {
                        ...m,
                        reasoningContent: data.reasoningContent,
                        content: data.content,
                        isThinking: data.isThinking,
                        thinkingDuration: data.thinkingDuration,
                        pending: false,
                        stage: undefined,
                        ...(data.stages ? { stages: data.stages } : {}),
                      }
                    : m
                )
              : [
                  ...s.messages,
                  {
                    id: data.messageId,
                    role: 'assistant' as const,
                    reasoningContent: data.reasoningContent,
                    content: data.content,
                    isThinking: data.isThinking,
                    thinkingDuration: data.thinkingDuration,
                    pending: false,
                    timestamp: Date.now(),
                    ...(data.stages ? { stages: data.stages } : {}),
                  },
                ];
            return {
              ...s,
              messages: nextMsgs,
            };
          });

          if (currentSessionIdRef.current === data.sessionId) {
            scheduleSessionsCommit();
          }
        } catch {
          // ignore
        }
      });

      es.addEventListener('turn-finished', (e: MessageEvent) => {
        try {
          const data: {
            sessionId: string;
            messageId: string;
            message?: ChatMessage;
            contextUsed?: number;
            lastMetrics?: TurnMetrics;
            calibrationFactors?: Partial<Record<CalibrationProvider, number>>;
          } = JSON.parse(e.data);
          if (!data?.sessionId) return;

          if (data.calibrationFactors) {
            syncCalibrationFactors(data.calibrationFactors);
          }

          setGeneratingSessionIds((prev) => prev.filter((id) => id !== data.sessionId));
          setLiveStreamingTokens((prev) => {
            const next = { ...prev };
            delete next[data.sessionId];
            return next;
          });

          if (data.lastMetrics && currentSessionIdRef.current === data.sessionId) {
            setLastMetrics(data.lastMetrics);
          }

          if (data.message) {
            sessionsRef.current = sessionsRef.current.map((s) => {
              if (s.id !== data.sessionId) return s;
              const exists = s.messages.some((m) => m.id === data.messageId);
              const nextMsgs = exists
                ? s.messages.map((m) => (m.id === data.messageId ? data.message! : m))
                : [...s.messages, data.message!];
              return {
                ...s,
                contextUsed: data.contextUsed ?? s.contextUsed,
                messages: nextMsgs,
              };
            });
            flushSessionsCommitNow();
          }
        } catch {
          // ignore
        }
      });

      es.addEventListener('turn-aborted', (e: MessageEvent) => {
        try {
          const data: { sessionId: string; session?: ChatSession } = JSON.parse(e.data);
          if (!data?.sessionId) return;

          setGeneratingSessionIds((prev) => prev.filter((id) => id !== data.sessionId));
          setLiveStreamingTokens((prev) => {
            const next = { ...prev };
            delete next[data.sessionId];
            return next;
          });

          if (data.session) {
            sessionsRef.current = sessionsRef.current.map((s) =>
              s.id === data.sessionId ? data.session! : s
            );
          } else {
            sessionsRef.current = sessionsRef.current.map((s) =>
              s.id !== data.sessionId
                ? s
                : {
                    ...s,
                    messages: s.messages.map((m) =>
                      m.pending || m.isThinking || m.stage
                        ? { ...m, pending: false, isThinking: false, stage: undefined }
                        : m
                    ),
                  }
            );
          }
          flushSessionsCommitNow();
        } catch {
          // ignore
        }
      });

      es.onerror = () => {
        es?.close();
        es = null;
        if (!unmounted && reconnectTimer === null) {
          reconnectTimer = window.setTimeout(() => {
            reconnectTimer = null;
            connect();
          }, 1200);
        }
      };
    };

    connect();

    return () => {
      unmounted = true;
      if (chunkRafId !== null) {
        window.cancelAnimationFrame(chunkRafId);
      }
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
      }
      es?.close();
    };
  }, [applySnapshot]);

  // ==========================================================================
  // Actions (REST Commands to Server)
  // ==========================================================================

  const selectSession = useCallback((sessionId: string) => {
    currentSessionIdRef.current = sessionId;
    setSessions([...sessionsRef.current]);
    setCurrentSessionId(sessionId);
  }, []);

  const createOrReuseEmptySession = useCallback(
    async (title: string = defaultTitle): Promise<ChatSession | null> => {
      try {
        const res = await fetch('/api/sessions/empty', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title, origin: 'SCENE3D', kind: 'scene3d' }),
        });
        if (res.ok) {
          const data: { session: ChatSession; isNew: boolean } = await res.json();
          if (data?.session) {
            setSessions((prev) => {
              const exists = prev.some((s) => s.id === data.session.id);
              const next = exists
                ? prev.map((s) => (s.id === data.session.id ? data.session : s))
                : [data.session, ...prev];
              sessionsRef.current = next;
              return next;
            });
            currentSessionIdRef.current = data.session.id;
            setCurrentSessionId(data.session.id);
            setLastMetrics(undefined);
            return data.session;
          }
        }
      } catch (err) {
        console.warn('[useScene3dStore] createOrReuseEmptySession failed:', err);
      }
      const existingEmpty = sessionsRef.current.find(
        (s) => !s.messages || s.messages.length === 0
      );
      if (existingEmpty) {
        currentSessionIdRef.current = existingEmpty.id;
        setCurrentSessionId(existingEmpty.id);
        return existingEmpty;
      }
      return null;
    },
    [defaultTitle]
  );

  const deleteSession = useCallback(
    async (sessionId: string, fallbackTitle: string = defaultTitle) => {
      if (generatingSessionIds.includes(sessionId)) return;
      try {
        const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ defaultTitle: fallbackTitle, kind: 'scene3d' }),
        });
        if (res.ok) {
          const snap: ServerSnapshot = await res.json();
          applySnapshot(snap);
        }
      } catch (err) {
        console.warn('[useScene3dStore] deleteSession failed:', err);
      }
    },
    [generatingSessionIds, defaultTitle, applySnapshot]
  );

  const sendTurn = useCallback(
    async (opts: {
      sessionId?: string | null;
      text: string;
      images: string[];
      lang: 'zh' | 'en';
    }) => {
      const targetId = opts.sessionId || currentSessionIdRef.current || 'new';
      try {
        const res = await fetch(`/api/sessions/${encodeURIComponent(targetId)}/turns`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text: opts.text,
            images: opts.images,
            settings: buildScene3dSettings(),
            lang: opts.lang,
            origin: 'SCENE3D',
          }),
        });
        if (res.ok) {
          const data: { ok?: boolean; sessionId?: string; session?: ChatSession } =
            await res.json();
          if (data?.session) {
            setSessions((prev) => {
              const next = [data.session!, ...prev.filter((s) => s.id !== data.session!.id)];
              sessionsRef.current = next;
              return next;
            });
          }
          if (data?.sessionId) {
            currentSessionIdRef.current = data.sessionId;
            setCurrentSessionId(data.sessionId);
            setGeneratingSessionIds((prev) =>
              prev.includes(data.sessionId!) ? prev : [...prev, data.sessionId!]
            );
          }
          return data;
        }
      } catch (err) {
        console.error('[useScene3dStore] sendTurn failed:', err);
      }
      return null;
    },
    []
  );

  const abortTurn = useCallback(async (sessionIdToStop?: string | null) => {
    const targetId = sessionIdToStop || currentSessionIdRef.current;
    if (!targetId) return;
    try {
      await fetch(`/api/sessions/${encodeURIComponent(targetId)}/abort`, {
        method: 'POST',
      });
    } catch (err) {
      console.warn('[useScene3dStore] abortTurn failed:', err);
    }
  }, []);

  const currentSession = sessions.find((s) => s.id === currentSessionId);

  return {
    sessions,
    currentSessionId,
    setCurrentSessionId,
    currentSession,
    messages: currentSession?.messages || [],
    generatingSessionIds,
    isGenerating: currentSessionId ? generatingSessionIds.includes(currentSessionId) : false,
    liveStreamingTokens,
    lastMetrics,
    selectSession,
    createOrReuseEmptySession,
    deleteSession,
    sendTurn,
    abortTurn,
    refreshState,
  };
}
