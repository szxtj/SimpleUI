import { useState, useEffect, useRef, useCallback } from 'react';
import {
  ChatSession,
  ChatMessage,
  AppSettings,
  TurnMetrics,
  TurnStageRecord,
  WikiCitation,
} from '../types/chat';
import {
  loadSessions,
  loadCurrentSessionId,
  createNewSession,
  hydrateSessionImages,
} from '../services/storage';
import { syncCalibrationFactors, CalibrationProvider } from '../utils/token';

export type WindowRole = 'MAIN' | 'SPOTLIGHT';

interface ServerSnapshot {
  sessions: ChatSession[];
  mainSessionId: string | null;
  generatingSessionIds: string[];
  liveStreamingTokens: Record<string, number>;
  calibrationFactors?: Partial<Record<CalibrationProvider, number>>;
  migrated?: boolean;
}

const MIGRATED_FLAG_KEY = 'tff_sessions_migrated_v2';

/**
 * 主窗口与 Spotlight 浮窗共用的唯一会话与流式状态订阅 Hook。
 *
 * 架构原则：
 * 1. 会话数据与流式生成状态由服务端 `server/session_service.js` 唯一权威持有，通过 SSE 实时推送到所有窗口。
 * 2. 彻底消除前端双写、localStorage 全量覆盖、isSyncingRef 定时器防抖与 completedTurnsRef 合并回滚。
 * 3. 视图焦点解耦：
 *    - `MAIN` 窗口跟随 `mainSessionId`（支持多会话并发生成、响应 Spotlight 新提问自动聚焦与“在主窗口打开”交接）；
 *    - `SPOTLIGHT` 窗口维护独立的 `spotlightSessionId`（启动/新建/15 分钟闲置重置仅切换自身到空白会话，绝不劫持主窗口正在查看的会话）。
 */
export function useSessionStore(
  role: WindowRole,
  defaultTitle: string = '新对话',
  onSpotlightSessionLoaded?: (isExpanded: boolean) => void
) {
  const [sessions, setSessions] = useState<ChatSession[]>(() => {
    const initial = loadSessions();
    return initial.length > 0 ? initial : [createNewSession(defaultTitle)];
  });

  const [currentSessionId, setCurrentSessionId] = useState<string | null>(() => {
    if (role === 'SPOTLIGHT') {
      const initial = loadSessions();
      const empty = initial.find((s) => !s.messages || s.messages.length === 0);
      return empty ? empty.id : null;
    }
    const initial = loadSessions();
    const savedId = loadCurrentSessionId();
    if (savedId && initial.some((s) => s.id === savedId)) {
      return savedId;
    }
    return initial.length > 0 ? initial[0].id : null;
  });

  const [generatingSessionIds, setGeneratingSessionIds] = useState<string[]>([]);
  const [liveStreamingTokens, setLiveStreamingTokens] = useState<Record<string, number>>({});
  const [lastMetrics, setLastMetrics] = useState<TurnMetrics | undefined>(undefined);

  const currentSessionIdRef = useRef<string | null>(currentSessionId);
  const sessionsRef = useRef<ChatSession[]>(sessions);
  const migrationInFlightRef = useRef(false);
  const onSpotlightSessionLoadedRef = useRef(onSpotlightSessionLoaded);

  useEffect(() => {
    currentSessionIdRef.current = currentSessionId;
  }, [currentSessionId]);

  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  useEffect(() => {
    onSpotlightSessionLoadedRef.current = onSpotlightSessionLoaded;
  }, [onSpotlightSessionLoaded]);

  /**
   * 首次升级幂等迁移：把旧版 localStorage + IndexedDB 中的历史会话迁移到服务端 sessions.json，
   * 并在迁移成功后将 localStorage 的旧 key 归档备份并移除，确保不再有两处活跃存储。
   */
  const maybeMigrateLocalStorage = useCallback(async (snap: ServerSnapshot) => {
    if (migrationInFlightRef.current) return;
    try {
      const rawActive = localStorage.getItem('tff_chat_sessions_v1');
      if (!rawActive) {
        if (snap.migrated) {
          localStorage.setItem(MIGRATED_FLAG_KEY, '1');
        }
        return;
      }

      const localList = loadSessions();
      const nonEmptyLocal = localList.filter((s) => s.messages && s.messages.length > 0);
      if (nonEmptyLocal.length === 0) {
        localStorage.removeItem('tff_chat_sessions_v1');
        localStorage.removeItem('tff_chat_current_id_v1');
        localStorage.setItem(MIGRATED_FLAG_KEY, '1');
        return;
      }

      const serverIds = new Set((snap.sessions || []).map((s) => s.id));
      const hasUnmigratedSessions = nonEmptyLocal.some((s) => !serverIds.has(s.id));
      if (
        snap.migrated &&
        localStorage.getItem(MIGRATED_FLAG_KEY) === '1' &&
        !hasUnmigratedSessions
      ) {
        localStorage.setItem('tff_chat_sessions_backup_v1', rawActive);
        localStorage.removeItem('tff_chat_sessions_v1');
        localStorage.removeItem('tff_chat_current_id_v1');
        return;
      }

      migrationInFlightRef.current = true;
      for (const s of nonEmptyLocal) {
        const hasOffloaded = s.messages?.some((m) =>
          m.images?.some((img) => img.startsWith('__idb__:'))
        );
        if (hasOffloaded) {
          await hydrateSessionImages(s).catch(() => false);
        }
      }

      const savedMainId = loadCurrentSessionId();
      const res = await fetch('/api/sessions/migrate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessions: nonEmptyLocal,
          currentSessionId: savedMainId,
        }),
      });
      if (res.ok) {
        localStorage.setItem('tff_chat_sessions_backup_v1', rawActive);
        localStorage.removeItem('tff_chat_sessions_v1');
        localStorage.removeItem('tff_chat_current_id_v1');
        localStorage.removeItem('tff_sessions_migrated_v1');
        localStorage.setItem(MIGRATED_FLAG_KEY, '1');
      }
    } catch (err) {
      console.warn('[useSessionStore] LocalStorage migration skipped:', err);
    } finally {
      migrationInFlightRef.current = false;
    }
  }, []);

  /**
   * 应用服务端全量快照
   */
  const applySnapshot = useCallback(
    (snap: ServerSnapshot) => {
      if (!snap || !Array.isArray(snap.sessions)) return;
      if (snap.calibrationFactors) {
        syncCalibrationFactors(snap.calibrationFactors);
      }
      sessionsRef.current = snap.sessions;
      setSessions(snap.sessions);
      setGeneratingSessionIds(snap.generatingSessionIds || []);
      setLiveStreamingTokens(snap.liveStreamingTokens || {});

      if (role === 'MAIN') {
        const nextMainId =
          snap.mainSessionId && snap.sessions.some((s) => s.id === snap.mainSessionId)
            ? snap.mainSessionId
            : snap.sessions[0]?.id || null;
        currentSessionIdRef.current = nextMainId;
        setCurrentSessionId(nextMainId);
      } else {
        // SPOTLIGHT 仅在当前指向的会话不存在时回退到空会话，绝不被 mainSessionId 强行带跑
        const curId = currentSessionIdRef.current;
        if (!curId || !snap.sessions.some((s) => s.id === curId)) {
          const empty = snap.sessions.find((s) => !s.messages || s.messages.length === 0);
          const nextId = empty ? empty.id : null;
          currentSessionIdRef.current = nextId;
          setCurrentSessionId(nextId);
        }
      }

      if (role === 'MAIN') {
        maybeMigrateLocalStorage(snap);
      }
    },
    [role, maybeMigrateLocalStorage]
  );

  /**
   * 主动拉取一次服务端最新快照（用于窗口获焦、原生唤醒或重连兜底）
   */
  const refreshState = useCallback(async () => {
    try {
      const res = await fetch('/api/sessions/state');
      if (res.ok) {
        const snap: ServerSnapshot = await res.json();
        applySnapshot(snap);
      }
    } catch {
      // ignore transient network error during startup
    }
  }, [applySnapshot]);

  /**
   * 建立 SSE 实时订阅连接（带自动指数退避重连）
   */
  useEffect(() => {
    let es: EventSource | null = null;
    let reconnectTimer: number | null = null;
    let unmounted = false;

    const connect = () => {
      if (unmounted) return;
      es = new EventSource('/api/sessions/events');

      es.addEventListener('snapshot', (e: MessageEvent) => {
        try {
          const data: ServerSnapshot = JSON.parse(e.data);
          applySnapshot(data);
        } catch (err) {
          console.warn('[useSessionStore] Failed to parse snapshot event:', err);
        }
      });

      es.addEventListener('session-upserted', (e: MessageEvent) => {
        try {
          const data: {
            session: ChatSession;
            mainSessionId?: string | null;
            selectInMain?: boolean;
          } = JSON.parse(e.data);
          if (!data?.session) return;

          setSessions((prev) => {
            const idx = prev.findIndex((s) => s.id === data.session.id);
            if (idx >= 0) {
              const next = [...prev];
              next[idx] = data.session;
              return next;
            }
            return [data.session, ...prev];
          });

          if (role === 'MAIN' && data.selectInMain && data.session.id) {
            setCurrentSessionId(data.session.id);
          }
        } catch (err) {
          console.warn('[useSessionStore] Failed to parse session-upserted:', err);
        }
      });

      es.addEventListener('session-deleted', (e: MessageEvent) => {
        try {
          const data: {
            sessionId: string;
            sessions: ChatSession[];
            mainSessionId: string | null;
          } = JSON.parse(e.data);
          if (!data || !Array.isArray(data.sessions)) return;

          setSessions(data.sessions);
          setGeneratingSessionIds((prev) => prev.filter((id) => id !== data.sessionId));

          if (role === 'MAIN') {
            if (data.mainSessionId) {
              setCurrentSessionId(data.mainSessionId);
            } else if (currentSessionIdRef.current === data.sessionId) {
              setCurrentSessionId(data.sessions[0]?.id || null);
            }
          } else if (currentSessionIdRef.current === data.sessionId) {
            const empty = data.sessions.find((s) => !s.messages || s.messages.length === 0);
            setCurrentSessionId(empty ? empty.id : null);
          }
        } catch (err) {
          console.warn('[useSessionStore] Failed to parse session-deleted:', err);
        }
      });

      es.addEventListener('main-session-changed', (e: MessageEvent) => {
        if (role !== 'MAIN') return;
        try {
          const data: { mainSessionId: string | null } = JSON.parse(e.data);
          if (data?.mainSessionId) {
            setCurrentSessionId(data.mainSessionId);
          }
        } catch {
          // ignore
        }
      });

      es.addEventListener('spotlight-session-changed', (e: MessageEvent) => {
        if (role !== 'SPOTLIGHT') return;
        try {
          const data: {
            sessionId: string;
            isExpanded?: boolean;
            session?: ChatSession;
          } = JSON.parse(e.data);
          if (!data?.sessionId) return;
          if (data.session) {
            setSessions((prev) => {
              const idx = prev.findIndex((s) => s.id === data.session!.id);
              const next =
                idx >= 0
                  ? prev.map((s, i) => (i === idx ? data.session! : s))
                  : [data.session!, ...prev];
              sessionsRef.current = next;
              return next;
            });
          }
          currentSessionIdRef.current = data.sessionId;
          setCurrentSessionId(data.sessionId);
          const expanded =
            data.isExpanded ?? ((data.session?.messages?.length ?? 0) > 0);
          onSpotlightSessionLoadedRef.current?.(expanded);
        } catch {
          // ignore
        }
      });

      es.addEventListener('turn-progress', (e: MessageEvent) => {
        try {
          const data: { sessionId: string; liveTokens: number } = JSON.parse(e.data);
          if (!data?.sessionId) return;
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
            citations?: WikiCitation[];
          } = JSON.parse(e.data);
          if (!data?.sessionId || !data?.messageId) return;

          setGeneratingSessionIds((prev) =>
            prev.includes(data.sessionId) ? prev : [...prev, data.sessionId]
          );

          setSessions((prev) =>
            prev.map((s) => {
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
                        ...(data.citations !== undefined ? { citations: data.citations } : {}),
                      }
                    : m
                ),
              };
            })
          );
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

          setSessions((prev) =>
            prev.map((s) => {
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
                          ...(data.citations ? { citations: data.citations } : {}),
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
                      ...(data.citations ? { citations: data.citations } : {}),
                    },
                  ];
              return {
                ...s,
                messages: nextMsgs,
              };
            })
          );
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
            setSessions((prev) =>
              prev.map((s) => {
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
              })
            );
          }
        } catch {
          // ignore
        }
      });

      es.addEventListener('turn-aborted', (e: MessageEvent) => {
        try {
          const data: {
            sessionId: string;
            messageId?: string;
            session?: ChatSession;
          } = JSON.parse(e.data);
          if (!data?.sessionId) return;

          setGeneratingSessionIds((prev) => prev.filter((id) => id !== data.sessionId));
          setLiveStreamingTokens((prev) => {
            const next = { ...prev };
            delete next[data.sessionId];
            return next;
          });

          if (data.session) {
            setSessions((prev) =>
              prev.map((s) => (s.id === data.sessionId ? data.session! : s))
            );
          } else {
            setSessions((prev) =>
              prev.map((s) =>
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
              )
            );
          }
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
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
      }
      es?.close();
    };
  }, [role, applySnapshot]);

  // ==========================================================================
  // Actions (REST Commands to Server)
  // ==========================================================================

  const selectSession = useCallback(
    async (sessionId: string) => {
      currentSessionIdRef.current = sessionId;
      setCurrentSessionId(sessionId);
      if (role === 'MAIN') {
        try {
          await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/select`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ targetWindow: 'MAIN' }),
          });
        } catch {
          // ignore
        }
      }
    },
    [role]
  );

  const createOrReuseEmptySession = useCallback(
    async (title: string = defaultTitle): Promise<ChatSession | null> => {
      try {
        const res = await fetch('/api/sessions/empty', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title, origin: role }),
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
        console.warn('[useSessionStore] createOrReuseEmptySession failed:', err);
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
    [role, defaultTitle]
  );

  const updateSessionMeta = useCallback(
    async (
      sessionId: string,
      patch: { title?: string; enableThinking?: boolean; enableWikiSearch?: boolean }
    ) => {
      setSessions((prev) =>
        prev.map((s) =>
          s.id === sessionId ? { ...s, ...patch, updatedAt: Date.now() } : s
        )
      );
      try {
        await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patch),
        });
      } catch (err) {
        console.warn('[useSessionStore] updateSessionMeta failed:', err);
      }
    },
    []
  );

  const deleteSession = useCallback(
    async (sessionId: string, fallbackTitle: string = defaultTitle) => {
      if (generatingSessionIds.includes(sessionId)) return;
      try {
        const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ defaultTitle: fallbackTitle }),
        });
        if (res.ok) {
          const snap: ServerSnapshot = await res.json();
          applySnapshot(snap);
        }
      } catch (err) {
        console.warn('[useSessionStore] deleteSession failed:', err);
      }
    },
    [generatingSessionIds, defaultTitle, applySnapshot]
  );

  const mergeSessionPreservingProgress = useCallback(
    (existing: ChatSession, incoming: ChatSession): ChatSession => {
      const existingMsgMap = new Map((existing.messages || []).map((m) => [m.id, m]));
      const mergedMessages = (incoming.messages || []).map((incMsg) => {
        const curMsg = existingMsgMap.get(incMsg.id);
        if (!curMsg || incMsg.role !== 'assistant') return incMsg;
        const curStagesLen = curMsg.stages?.length ?? 0;
        const incStagesLen = incMsg.stages?.length ?? 0;
        const curContentLen = curMsg.content?.length ?? 0;
        const incContentLen = incMsg.content?.length ?? 0;
        const curReasonLen = curMsg.reasoningContent?.length ?? 0;
        const incReasonLen = incMsg.reasoningContent?.length ?? 0;
        const curIsMoreAdvanced =
          curContentLen > incContentLen ||
          curReasonLen > incReasonLen ||
          curStagesLen > incStagesLen ||
          (curMsg.stage === 'prefill' && incMsg.stage === 'rag') ||
          (!curMsg.pending && incMsg.pending);
        if (!curIsMoreAdvanced) return incMsg;
        return {
          ...incMsg,
          ...curMsg,
          stages: curStagesLen >= incStagesLen ? curMsg.stages : incMsg.stages,
          content: curContentLen >= incContentLen ? curMsg.content : incMsg.content,
          reasoningContent:
            curReasonLen >= incReasonLen ? curMsg.reasoningContent : incMsg.reasoningContent,
        };
      });
      return {
        ...incoming,
        messages: mergedMessages,
      };
    },
    []
  );

  const sendTurn = useCallback(
    async (opts: {
      sessionId?: string | null;
      text: string;
      images: string[];
      settings: AppSettings;
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
            settings: opts.settings,
            lang: opts.lang,
            origin: role,
          }),
        });
        if (res.ok) {
          const data: {
            ok?: boolean;
            sessionId?: string;
            session?: ChatSession;
          } = await res.json();
          if (data?.session) {
            setSessions((prev) => {
              const idx = prev.findIndex((s) => s.id === data.session!.id);
              if (idx >= 0) {
                const next = [...prev];
                next[idx] = mergeSessionPreservingProgress(prev[idx], data.session!);
                sessionsRef.current = next;
                return next;
              }
              const next = [data.session!, ...prev];
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
        console.error('[useSessionStore] sendTurn failed:', err);
      }
      return null;
    },
    [role, mergeSessionPreservingProgress]
  );

  const abortTurn = useCallback(
    async (sessionIdToStop?: string | null) => {
      const targetId = sessionIdToStop || currentSessionIdRef.current;
      if (!targetId) return;
      try {
        await fetch(`/api/sessions/${encodeURIComponent(targetId)}/abort`, {
          method: 'POST',
        });
      } catch (err) {
        console.warn('[useSessionStore] abortTurn failed:', err);
      }
    },
    []
  );

  const retryTurn = useCallback(
    async (opts: {
      assistantMessageId: string;
      settings: AppSettings;
      lang: 'zh' | 'en';
      sessionId?: string | null;
    }) => {
      const targetSession =
        (opts.sessionId && sessionsRef.current.find((s) => s.id === opts.sessionId)) ||
        (currentSessionIdRef.current &&
          sessionsRef.current.find((s) => s.id === currentSessionIdRef.current)) ||
        sessionsRef.current.find((s) =>
          s.messages?.some((m) => m.id === opts.assistantMessageId)
        );
      if (!targetSession) return;

      try {
        const res = await fetch(
          `/api/sessions/${encodeURIComponent(targetSession.id)}/retry`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              assistantMessageId: opts.assistantMessageId,
              settings: opts.settings,
              lang: opts.lang,
              origin: role,
            }),
          }
        );
        if (res.ok) {
          const data: { session?: ChatSession; sessionId?: string } = await res.json();
          if (data?.session) {
            setSessions((prev) => {
              const next = prev.map((s) =>
                s.id === data.session!.id
                  ? mergeSessionPreservingProgress(s, data.session!)
                  : s
              );
              sessionsRef.current = next;
              return next;
            });
          }
        }
      } catch (err) {
        console.error('[useSessionStore] retryTurn failed:', err);
      }
    },
    [role, mergeSessionPreservingProgress]
  );

  const deleteTurn = useCallback(
    async (assistantMessageId: string, sessionId?: string | null) => {
      const targetSession =
        (sessionId && sessionsRef.current.find((s) => s.id === sessionId)) ||
        sessionsRef.current.find((s) =>
          s.messages?.some((m) => m.id === assistantMessageId)
        ) ||
        (currentSessionIdRef.current
          ? sessionsRef.current.find((s) => s.id === currentSessionIdRef.current)
          : undefined);
      if (!targetSession) return null;

      try {
        const res = await fetch(
          `/api/sessions/${encodeURIComponent(targetSession.id)}/turns/${encodeURIComponent(
            assistantMessageId
          )}`,
          { method: 'DELETE' }
        );
        if (res.ok) {
          const data: { session?: ChatSession } = await res.json();
          if (data?.session) {
            setSessions((prev) =>
              prev.map((s) => (s.id === data.session!.id ? data.session! : s))
            );
            return data.session;
          }
        }
      } catch (err) {
        console.error('[useSessionStore] deleteTurn failed:', err);
      }
      return null;
    },
    []
  );

  const handoffToSpotlight = useCallback(async (sessionId: string) => {
    try {
      await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/select`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetWindow: 'SPOTLIGHT' }),
      });
    } catch {
      // ignore
    }
  }, []);

  const handoffToMain = useCallback(async (sessionId: string) => {
    try {
      await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/select`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetWindow: 'MAIN' }),
      });
    } catch {
      // ignore
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
    setLastMetrics,
    selectSession,
    createOrReuseEmptySession,
    updateSessionMeta,
    deleteSession,
    sendTurn,
    abortTurn,
    retryTurn,
    deleteTurn,
    handoffToSpotlight,
    handoffToMain,
    refreshState,
  };
}
