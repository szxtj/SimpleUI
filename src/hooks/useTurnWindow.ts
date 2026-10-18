import { startTransition, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChatMessage } from '../types/chat';
import { buildTurns } from '../utils/turns';
import { contentYOf, disableScrollAnchor } from '../utils/scrollAnchor';

/** 当前轮次上下各保留的轮数（用户口径：默认 5 轮 = 1 + 2 + 2） */
const PAD = 2;
/** 兜底填充视口时的渲染上限（连续短消息不至于把整段会话全挂上去） */
const MAX_RENDERED_TURNS = 9;
/** 视口顶部往下 56px 作为"正在读哪一轮"的判定线 */
const READING_LINE = 56;
/** 贴顶跳转时留的余量 */
const JUMP_TOP_GAP = 24;
/** 滚动停止多久后把窗口收回到"中心 ± PAD" */
const TRIM_DELAY = 700;

/**
 * 一屏内挂载的轮次窗口。
 *
 * 2026-10-18 架构调整：**位置校准交给浏览器原生滚动锚定**（`overflow-anchor: auto`）。
 *
 * 只要容器允许锚定，往视口上方插/删内容时浏览器会在布局管线里自动调偏移，
 * 既不打断滚动惯性、也不产生"写 scrollTop → 触发 scroll 事件 → 再补偿"的反馈环。
 * 本 hook 因此**不再写任何 scrollTop**（只有用户点/拖横线跳转时写一次，且那一下临时关掉锚定）。
 *
 * 职责缩到两件：
 * 1. 统计"正在读哪一轮"（给横线高亮，纯 UI）；
 * 2. 维护挂载区间：贴边才补、只增不减、停下 700ms 才收回 ±2。
 */
export function useTurnWindow({ messages, sessionId, containerRef }: Params) {
  const turns = useMemo(() => buildTurns(messages), [messages]);
  const turnsRef = useRef(turns);
  turnsRef.current = turns;

  const [win, setWin] = useState<WinState>({
    sessionId: sessionId ?? null,
    centerId: null,
    centerIndex: 0,
    viewStart: -1,
    viewEnd: -1,
  });

  const sessionKey = sessionId ?? null;
  const sameSession = win.sessionId === sessionKey;

  const centerIndex = useMemo(() => {
    if (turns.length === 0) return -1;
    const id = sameSession ? win.centerId : null;
    if (!id) return turns.length - 1;
    const found = turns.findIndex((t) => t.key === id);
    if (found >= 0) return found;
    return Math.min(Math.max(win.centerIndex, 0), turns.length - 1);
  }, [turns, sameSession, win.centerId, win.centerIndex]);

  const lastIndex = Math.max(0, turns.length - 1);
  const hasView = sameSession && win.viewStart >= 0;
  const startIndex = Math.min(
    hasView ? Math.max(0, Math.min(win.viewStart, lastIndex)) : Math.max(0, lastIndex - PAD),
    lastIndex
  );
  const endIndex = Math.max(
    startIndex,
    hasView ? Math.max(0, Math.min(win.viewEnd, lastIndex)) : lastIndex
  );
  // 依赖里**不能带 centerIndex**：中心每变一次就生成新数组，会让整棵列表白重渲染
  const visibleTurns = useMemo(
    () => (turns.length === 0 ? [] : turns.slice(startIndex, endIndex + 1)),
    [turns, startIndex, endIndex]
  );

  const jumpRef = useRef<string | null>(null);
  const scrollRafRef = useRef(0);

  /** 视口判定线处是哪一轮（返回 turns 下标） */
  const readCurrentTurn = useCallback((): number => {
    const el = containerRef.current;
    if (!el) return centerIndex;
    const nodes = el.querySelectorAll<HTMLElement>('[data-turn-index]');
    if (nodes.length === 0) return centerIndex;
    const lineY = el.getBoundingClientRect().top + READING_LINE;
    let current = Number(nodes[0].dataset.turnIndex ?? 0);
    for (let i = 0; i < nodes.length; i++) {
      const rect = nodes[i].getBoundingClientRect();
      const idx = Number(nodes[i].dataset.turnIndex ?? 0);
      if (rect.top <= lineY) current = idx;
      else break;
    }
    return current;
  }, [containerRef, centerIndex]);

  /** 只改"中心"（横线高亮），不动已挂载区间 */
  const setCenter = useCallback(
    (key: string | null, index: number) => {
      setWin((prev) => ({
        sessionId: sessionKey,
        centerId: key,
        centerIndex: Math.max(0, index),
        viewStart: prev.sessionId === sessionKey ? prev.viewStart : -1,
        viewEnd: prev.sessionId === sessionKey ? prev.viewEnd : -1,
      }));
    },
    [sessionKey]
  );

  /** 把区间设到"某轮 ± PAD"（跳转 / 切会话 / 收拢时用） */
  const setViewAround = useCallback(
    (index: number, key?: string | null) => {
      const list = turnsRef.current;
      const last = Math.max(0, list.length - 1);
      const center = Math.max(0, Math.min(index, last));
      setWin({
        sessionId: sessionKey,
        centerId: key !== undefined ? key : (list[center]?.key ?? null),
        centerIndex: center,
        viewStart: Math.max(0, center - PAD),
        viewEnd: Math.min(last, center + PAD),
      });
    },
    [sessionKey]
  );

  const centerOnLatest = useCallback(() => {
    const list = turnsRef.current;
    if (list.length === 0) {
      setViewAround(0, null);
      return;
    }
    setViewAround(list.length - 1);
  }, [setViewAround]);

  const jumpTo = useCallback(
    (index: number) => {
      const list = turnsRef.current;
      const turn = list[Math.max(0, Math.min(index, list.length - 1))];
      if (!turn) return;
      const el = containerRef.current;
      if (!el) return;

      // 跳转是"主动挪视野"，先关掉锚定，等位置落定再恢复
      disableScrollAnchor(el);

      if (index === centerIndex && sameSession) {
        const node = el.querySelector<HTMLElement>(
          `[data-turn-key="${typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(turn.key) : turn.key}"]`
        );
        if (node) el.scrollTop = Math.max(0, contentYOf(el, node) - JUMP_TOP_GAP);
        return;
      }
      jumpRef.current = turn.key;
      setViewAround(index, turn.key);
    },
    [centerIndex, sameSession, containerRef, setViewAround]
  );

  /** 窗口变化后执行跳转定位（唯一一处写 scrollTop） */
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const jumpKey = jumpRef.current;
    if (!jumpKey) return;
    jumpRef.current = null;
    const node = el.querySelector<HTMLElement>(
      `[data-turn-key="${typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(jumpKey) : jumpKey}"]`
    );
    if (node) el.scrollTop = Math.max(0, contentYOf(el, node) - JUMP_TOP_GAP);
  }, [startIndex, endIndex, centerIndex, sessionKey, containerRef]);

  /** 滚动 → 横线高亮跟随；贴边才补 2 轮，其余一律不碰 DOM */
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const onScroll = () => {
      if (scrollRafRef.current) return;
      scrollRafRef.current = requestAnimationFrame(() => {
        scrollRafRef.current = 0;
        const list = turnsRef.current;
        if (list.length === 0) return;

        // 1) 横线高亮：纯 UI，跟着视口读数
        const next = readCurrentTurn();
        const turn = list[next];
        if (turn && next !== centerIndex) startTransition(() => setCenter(turn.key, next));

        // 2) 只有真正贴近已挂载区域边缘才补 2 轮；普通翻页一次 DOM 都不动。
        //    补/删都在视口外发生，位置由浏览器原生锚定自动接住 —— 我们不写 scrollTop。
        const viewport = el.clientHeight;
        const nearTop = el.scrollTop < viewport * 0.6;
        const nearBottom = el.scrollHeight - viewport - el.scrollTop < viewport * 0.6;
        const lastIdx = list.length - 1;
        if (nearTop && startIndex > 0) {
          setWin((prev) => ({
            ...prev,
            sessionId: sessionKey,
            viewStart: Math.max(0, startIndex - PAD),
          }));
        } else if (nearBottom && endIndex < lastIdx) {
          setWin((prev) => ({
            ...prev,
            sessionId: sessionKey,
            viewEnd: Math.min(lastIdx, endIndex + PAD),
          }));
        }
      });
    };

    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      el.removeEventListener('scroll', onScroll);
      if (scrollRafRef.current) cancelAnimationFrame(scrollRafRef.current);
    };
  }, [containerRef, centerIndex, startIndex, endIndex, sessionKey, readCurrentTurn, setCenter]);

  /** 滚动停下 TRIM_DELAY 后收回"中心 ± PAD"（删除的内容都在视口外，锚定会接住） */
  useEffect(() => {
    if (!hasView || centerIndex < 0 || turns.length === 0) return;
    const targetStart = Math.max(0, centerIndex - PAD);
    const targetEnd = Math.min(turns.length - 1, centerIndex + PAD);
    if (startIndex === targetStart && endIndex === targetEnd) return;
    const timer = window.setTimeout(() => setViewAround(centerIndex), TRIM_DELAY);
    return () => window.clearTimeout(timer);
  }, [centerIndex, startIndex, endIndex, hasView, turns.length, sessionKey, setViewAround]);

  /** 挂载内容不足一屏时继续补（否则短会话会留一大片空白且无法滚动） */
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el || turns.length === 0) return;
    if (endIndex - startIndex + 1 >= MAX_RENDERED_TURNS) return;
    if (el.scrollHeight >= el.clientHeight * 1.06) return;
    const last = turns.length - 1;
    if (endIndex < last) {
      setWin((prev) => ({
        ...prev,
        sessionId: sessionKey,
        viewEnd: Math.min(last, Math.max(prev.viewEnd, endIndex) + 1),
      }));
    } else if (startIndex > 0) {
      setWin((prev) => ({
        ...prev,
        sessionId: sessionKey,
        viewStart: Math.max(0, Math.min(prev.viewStart, startIndex) - 1),
      }));
    }
  }, [startIndex, endIndex, turns.length, sessionKey, containerRef]);

  return {
    turns,
    visibleTurns,
    centerIndex,
    startIndex,
    endIndex,
    centerOnLatest,
    jumpTo,
  };
}

interface WinState {
  sessionId: string | null;
  /** 居中轮次的 key；null 表示"末尾" */
  centerId: string | null;
  /** centerId 失效时的下标兜底（删除轮次后不至于跳到末尾） */
  centerIndex: number;
  /** 实际挂载区间（显式保存，滚动中只增不减，停下才收拢） */
  viewStart: number;
  viewEnd: number;
}

interface Params {
  messages: ChatMessage[];
  sessionId?: string | null;
  containerRef: React.RefObject<HTMLDivElement | null>;
}
