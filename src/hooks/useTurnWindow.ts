import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { RefObject } from 'react';
import type { ChatMessage } from '../types/chat';
import { buildTurns } from '../utils/turns';
import { contentYOf } from '../utils/scrollAnchor';
import type { Range, TurnSize } from '../utils/virtualWindow';
import {
  buildOffsets,
  coreRange,
  desiredRange,
  fillRange,
  shouldMountAll,
  tailRange,
  trimRange,
} from '../utils/virtualWindow';

/** 可见区上下各保留的轮数 */
const PAD = 2;
/** 上下各预载约 1.5 屏 */
const OVERSCAN_SCREENS = 1.5;
const OVERSCAN_MIN = 800;
/** 软上限：只裁可见区 ± PAD 之外的内容 */
const MAX_MOUNTED_TURNS = 36;
const MAX_MOUNTED_SCREENS = 8;
/** 短会话直接全量挂载 */
const ALL_MOUNT_TURNS = 20;
const ALL_MOUNT_SCREENS = 8;
/** 视口顶部往下 56px 作为“正在读哪一轮”的判定线 */
const READING_LINE = 56;
const JUMP_TOP_GAP = 24;
/** 滚动静止多久后收拢 */
const TRIM_DELAY = 1200;
/** 切会话/发送后贴底保持多久 */
const PIN_HOLD_MS = 1500;

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

interface WinState {
  sessionId: string | null;
  start: number;
  end: number;
  /** 每次主动改窗口 +1，用来驱动 layout effect 里的锚点恢复 */
  nonce: number;
}

interface CenterState {
  key: string | null;
  index: number;
}

interface AnchorSnapshot {
  key: string;
  index: number;
  /** 阅读线处命中的最深元素；换宽度/折叠等场景用它保持屏幕位置 */
  el: HTMLElement | null;
  elTop: number;
  /** 兜底：整轮的 top */
  turnTop: number;
  /** 阅读线在轮内的偏移（宽度变化时按比例恢复） */
  turnOffset: number;
  turnHeight: number;
  width: number;
  scrollTop: number;
}

function findTurnEl(container: HTMLElement, key: string): HTMLElement | null {
  const nodes = container.querySelectorAll<HTMLElement>('[data-turn-key]');
  for (let i = 0; i < nodes.length; i++) {
    if (nodes[i].dataset.turnKey === key) return nodes[i];
  }
  return null;
}

function hasSelectionInside(el: HTMLElement): boolean {
  try {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return false;
    const anchor = sel.anchorNode;
    const focus = sel.focusNode;
    return !!(
      (anchor && el.contains(anchor)) ||
      (focus && el.contains(focus))
    );
  } catch {
    return false;
  }
}

/**
 * 对话窗口化（测量式虚拟列表）。
 *
 * 架构要点（2026-10 重构）：
 * 1. **不再依赖浏览器原生 scroll anchoring**。Safari / WKWebView 在 Safari 27
 *    之前完全不支持 `overflow-anchor`，上方补内容会直接把视野顶走。
 * 2. 未挂载的轮次用上下 spacer 占位，`scrollHeight` 始终约等于全部内容，
 *    滚轮/惯性不会撞到“假底”。
 * 3. 只挂载“可见区 ± 2 轮 + 上下各约 1.2 屏”，短会话直接全量挂载。
 * 4. 任何窗口增删、高度变化、宽度变化后，都在 paint 前把“阅读线处的元素”
 *    恢复到原屏幕位置。流式生成本身不跟随滚动（产品决策）。
 */
export function useTurnWindow({ messages, sessionId, containerRef, contentRef }: Params) {
  const turns = useMemo(() => buildTurns(messages), [messages]);
  const turnsRef = useRef(turns);
  turnsRef.current = turns;
  /** 只在轮次结构变化时变（流式 chunk 更新正文不会触发锚点恢复） */
  const turnsSignature = useMemo(() => turns.map((t) => t.key).join('|'), [turns]);

  const sessionKey = sessionId ?? '__none__';

  /** 每个会话一份高度缓存（只存数字），LRU 保留 4 个会话 */
  const heightsStoreRef = useRef(new Map<string, Map<string, TurnSize>>());
  const heights = useMemo(() => {
    const store = heightsStoreRef.current;
    let map = store.get(sessionKey);
    if (!map) {
      map = new Map();
      store.set(sessionKey, map);
    }
    if (store.size > 4) {
      for (const key of store.keys()) {
        if (key !== sessionKey) {
          store.delete(key);
          break;
        }
      }
    }
    return map;
  }, [sessionKey]);
  const heightsRef = useRef(heights);
  heightsRef.current = heights;

  const aliveRef = useRef(true);
  const [version, setVersion] = useState(0);
  const bumpRafRef = useRef(0);
  const scheduleBump = useCallback(() => {
    if (bumpRafRef.current || !aliveRef.current) return;
    bumpRafRef.current = window.requestAnimationFrame(() => {
      bumpRafRef.current = 0;
      if (!aliveRef.current) return;
      setVersion((v) => v + 1);
    });
  }, []);

  const widthRef = useRef(0);
  const contentWidth = useCallback(() => {
    const content = contentRef?.current;
    if (content) return content.clientWidth || 0;
    const scroller = containerRef.current;
    if (!scroller) return 0;
    const turn = scroller.querySelector<HTMLElement>('[data-turn-key]');
    return turn?.clientWidth || scroller.clientWidth || 0;
  }, [contentRef, containerRef]);

  const { offsets } = useMemo(
    () => buildOffsets(turns, heights, widthRef.current),
    // version 用来在 Map 原地更新后触发重算
    [turns, heights, version]
  );
  const offsetsRef = useRef(offsets);
  offsetsRef.current = offsets;

  const [viewportH, setViewportH] = useState(800);
  const viewportRef = useRef(viewportH);
  viewportRef.current = viewportH;

  const [win, setWin] = useState<WinState>({
    sessionId: null,
    start: 0,
    end: -1,
    nonce: 0,
  });
  const winRef = useRef(win);
  winRef.current = win;

  const commitWin = useCallback(
    (range: Range, force = false) => {
      const prev = winRef.current;
      if (
        !force &&
        prev.sessionId === sessionKey &&
        prev.start === range.start &&
        prev.end === range.end
      ) {
        return;
      }
      const next: WinState = {
        sessionId: sessionKey,
        start: range.start,
        end: range.end,
        nonce: prev.nonce + 1,
      };
      winRef.current = next;
      setWin(next);
    },
    [sessionKey]
  );

  const [center, setCenter] = useState<CenterState>({ key: null, index: 0 });
  const centerRef = useRef(center);
  centerRef.current = center;
  const updateCenter = useCallback((key: string | null, index: number) => {
    const cur = centerRef.current;
    if (cur.key === key && cur.index === index) return;
    const next: CenterState = { key, index };
    centerRef.current = next;
    setCenter(next);
  }, []);

  const anchorRef = useRef<AnchorSnapshot | null>(null);

  /** 记录“阅读线处是什么”。滚动时同步调用，保证高度变化前拿到最新位置。 */
  const captureAnchor = useCallback((): AnchorSnapshot | null => {
    const el = containerRef.current;
    if (!el) return null;
    const sr = el.getBoundingClientRect();
    const lineY = sr.top + READING_LINE;
    const nodes = el.querySelectorAll<HTMLElement>('[data-turn-index]');
    if (nodes.length === 0) {
      anchorRef.current = null;
      return null;
    }

    let turnEl: HTMLElement = nodes[0];
    for (let i = 0; i < nodes.length; i++) {
      const rect = nodes[i].getBoundingClientRect();
      if (rect.top <= lineY) turnEl = nodes[i];
      else break;
    }
    const tr = turnEl.getBoundingClientRect();
    const key = turnEl.dataset.turnKey;
    if (!key) return null;
    const index = Number(turnEl.dataset.turnIndex ?? 0);

    let hit: HTMLElement | null = null;
    try {
      const x = sr.left + Math.min(Math.max(sr.width * 0.32, 16), 260);
      const y = Math.min(Math.max(lineY, sr.top + 1), sr.bottom - 1);
      const candidate = document.elementFromPoint(x, y) as HTMLElement | null;
      if (
        candidate &&
        el.contains(candidate) &&
        !candidate.closest('[data-chat-inner-scroll]') &&
        candidate.closest('[data-turn-index]') === turnEl
      ) {
        hit = candidate;
      }
    } catch {
      hit = null;
    }

    const snapshot: AnchorSnapshot = {
      key,
      index,
      el: hit,
      elTop: hit ? hit.getBoundingClientRect().top : tr.top,
      turnTop: tr.top,
      turnOffset: lineY - tr.top,
      turnHeight: tr.height,
      width: contentWidth(),
      scrollTop: el.scrollTop,
    };
    anchorRef.current = snapshot;
    updateCenter(key, index);
    return snapshot;
  }, [containerRef, contentWidth, updateCenter]);

  /**
   * 恢复到锚点位置。
   *
   * 高度变化：`delta = 当前 top - 记录 top + 用户自上次记录后滚动的距离`。
   * 这样既补偿了上方 DOM 增高，又不会把用户刚滚的那一下“吃掉”。
   *
   * 宽度变化：按轮内比例恢复——换宽度后文本会重排，绝对像素偏移没有意义。
   */
  const restoreAnchor = useCallback(() => {
    const el = containerRef.current;
    const a = anchorRef.current;
    if (!el || !a) return;

    const sr = el.getBoundingClientRect();
    const scrollTop = el.scrollTop;
    const currentWidth = contentWidth();

    if (a.width > 0 && Math.abs(currentWidth - a.width) > 1) {
      const node = findTurnEl(el, a.key);
      if (node) {
        const tr = node.getBoundingClientRect();
        const ratio = a.turnHeight > 0 ? a.turnOffset / a.turnHeight : 0;
        const desired = sr.top + READING_LINE;
        const delta = tr.top + ratio * tr.height - desired;
        if (Math.abs(delta) > 0.5) el.scrollTop = scrollTop + delta;
      }
      captureAnchor();
      return;
    }

    const ds = scrollTop - a.scrollTop;
    let node: HTMLElement | null = a.el;
    let oldTop = a.elTop;
    if (!node || !node.isConnected || !el.contains(node)) {
      node = findTurnEl(el, a.key);
      oldTop = a.turnTop;
    }
    if (!node) return;

    const delta = node.getBoundingClientRect().top - oldTop + ds;
    if (Math.abs(delta) > 0.5) el.scrollTop = scrollTop + delta;
    captureAnchor();
  }, [containerRef, contentWidth, captureAnchor]);

  const pinBottomRef = useRef(false);
  const pinUntilRef = useRef(0);

  const pinToBottom = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    if (Date.now() > pinUntilRef.current) {
      pinBottomRef.current = false;
      captureAnchor();
      return;
    }
    el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight);
    captureAnchor();
    // 贴底时“当前轮”明确是最后一轮；短会话内容不足一屏时尤其重要
    const list = turnsRef.current;
    if (list.length > 0) updateCenter(list[list.length - 1].key, list.length - 1);
  }, [containerRef, captureAnchor, updateCenter]);

  const pendingMeasuresRef = useRef(new Map<string, number>());
  const measureRafRef = useRef(0);

  /** 子轮次用 ResizeObserver 上报高度；同一帧内合并处理。 */
  const onMeasure = useCallback(
    (key: string, height: number) => {
      if (!aliveRef.current) return;
      pendingMeasuresRef.current.set(key, height);
      if (measureRafRef.current) return;
      measureRafRef.current = window.requestAnimationFrame(() => {
        measureRafRef.current = 0;
        if (!aliveRef.current) return;
        const map = heightsRef.current;
        const w = contentWidth();
        let changed = false;
        pendingMeasuresRef.current.forEach((h, k) => {
          const prev = map.get(k);
          if (!prev || Math.abs(prev.h - h) > 0.5 || Math.abs(prev.w - w) > 1) {
            map.set(k, { h, w, visited: true });
            changed = true;
          }
        });
        pendingMeasuresRef.current.clear();
        if (!changed) return;

        if (pinBottomRef.current) pinToBottom();
        else restoreAnchor();
        scheduleBump();
      });
    },
    [contentWidth, pinToBottom, restoreAnchor, scheduleBump]
  );

  const hasTurns = turns.length > 0;
  const totalHeight = offsets[turns.length] ?? 0;
  const allMounted = useMemo(
    () =>
      shouldMountAll(
        turns.length,
        totalHeight,
        viewportH,
        ALL_MOUNT_TURNS,
        ALL_MOUNT_SCREENS
      ),
    [turns.length, totalHeight, viewportH]
  );
  const allMountedRef = useRef(allMounted);
  allMountedRef.current = allMounted;

  const sessionChanged = win.sessionId !== sessionKey;
  const tail = useMemo(
    () =>
      tailRange(
        offsets,
        viewportH,
        PAD,
        Math.max(OVERSCAN_MIN, viewportH * OVERSCAN_SCREENS)
      ),
    [offsets, viewportH]
  );

  const rawStart = sessionChanged ? tail.start : win.start;
  const rawEnd = sessionChanged ? tail.end : win.end;
  const startIndex = hasTurns
    ? allMounted
      ? 0
      : clamp(rawStart, 0, turns.length - 1)
    : 0;
  const endIndex = hasTurns
    ? allMounted
      ? turns.length - 1
      : Math.max(startIndex, clamp(rawEnd, 0, turns.length - 1))
    : -1;

  const visibleTurns = useMemo(
    () => (hasTurns ? turns.slice(startIndex, endIndex + 1) : []),
    [turns, hasTurns, startIndex, endIndex]
  );

  const topSpacer =
    allMounted || !hasTurns ? 0 : Math.max(0, offsets[startIndex] ?? 0);
  const bottomSpacer =
    allMounted || !hasTurns
      ? 0
      : Math.max(0, totalHeight - (offsets[endIndex + 1] ?? totalHeight));

  const centerIndex = useMemo(() => {
    if (!hasTurns) return -1;
    const found = center.key
      ? turns.findIndex((t) => t.key === center.key)
      : -1;
    if (found >= 0) return found;
    return clamp(center.index, 0, turns.length - 1);
  }, [turns, center, hasTurns]);
  const effectiveCenterIndex =
    sessionChanged && hasTurns ? turns.length - 1 : centerIndex;

  const jumpRef = useRef<string | null>(null);
  const trimTimerRef = useRef(0);
  const scheduleTrimRef = useRef<() => void>(() => {});

  const maybeTrim = useCallback(() => {
    const el = containerRef.current;
    const cur = winRef.current;
    if (!el || cur.sessionId !== sessionKey) return;
    if (allMountedRef.current) return;
    if (hasSelectionInside(el)) {
      scheduleTrimRef.current();
      return;
    }
    const core = coreRange(offsetsRef.current, el.scrollTop, el.clientHeight || viewportRef.current, PAD);
    const next = trimRange({ start: cur.start, end: cur.end }, core);
    if (next) commitWin(next);
  }, [containerRef, sessionKey, commitWin]);

  const scheduleTrim = useCallback(() => {
    window.clearTimeout(trimTimerRef.current);
    if (!aliveRef.current) return;
    trimTimerRef.current = window.setTimeout(maybeTrim, TRIM_DELAY);
  }, [maybeTrim]);
  scheduleTrimRef.current = scheduleTrim;

  const centerOnLatest = useCallback(() => {
    const el = containerRef.current;
    const list = turnsRef.current;
    const n = list.length;
    pinBottomRef.current = true;
    pinUntilRef.current = Date.now() + PIN_HOLD_MS;
    jumpRef.current = null;
    if (n === 0) {
      commitWin({ start: 0, end: -1 }, true);
      updateCenter(null, -1);
      return;
    }
    const vh = el?.clientHeight || viewportRef.current;
    const tailWindow = tailRange(
      offsetsRef.current,
      vh,
      PAD,
      Math.max(OVERSCAN_MIN, vh * OVERSCAN_SCREENS),
      MAX_MOUNTED_TURNS,
      vh * MAX_MOUNTED_SCREENS
    );
    commitWin({ start: tailWindow.start, end: tailWindow.end }, true);
    updateCenter(list[n - 1].key, n - 1);
    if (el) {
      el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight);
    }
    scheduleTrim();
  }, [containerRef, commitWin, updateCenter, scheduleTrim]);

  const jumpTo = useCallback(
    (index: number) => {
      const list = turnsRef.current;
      const n = list.length;
      if (n === 0) return;
      const target = clamp(index, 0, n - 1);
      const turn = list[target];
      if (!turn) return;
      const el = containerRef.current;
      const offs = offsetsRef.current;
      const vh = el?.clientHeight || viewportRef.current;

      const maxHeight = vh * MAX_MOUNTED_SCREENS;
      let end = target;
      while (
        end < n - 1 &&
        end - target + 1 < MAX_MOUNTED_TURNS &&
        (offs[end + 1] - offs[target] < vh + OVERSCAN_MIN || end - target < PAD)
      ) {
        end++;
      }
      // 目标轮下面如果都是超高轮次，不要把 24 轮全挂上
      while (
        end > target + PAD &&
        offs[end + 1] - offs[target] > maxHeight
      ) {
        end--;
      }
      const start = Math.max(0, target - PAD);

      pinBottomRef.current = false;
      pinUntilRef.current = 0;
      jumpRef.current = turn.key;
      commitWin({ start, end }, true);
      updateCenter(turn.key, target);
      scheduleTrim();
    },
    [containerRef, commitWin, updateCenter, scheduleTrim]
  );

  /** 窗口/高度/全量切换后统一在这里恢复锚点。 */
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el || !hasTurns) return;
    if (winRef.current.sessionId !== sessionKey) return;

    if (pinBottomRef.current) {
      pinToBottom();
      return;
    }
    const jumpKey = jumpRef.current;
    if (jumpKey) {
      jumpRef.current = null;
      const node = findTurnEl(el, jumpKey);
      if (node) {
        el.scrollTop = Math.max(0, contentYOf(el, node) - JUMP_TOP_GAP);
        captureAnchor();
      }
      return;
    }
    restoreAnchor();
  }, [
    win.nonce,
    win.start,
    win.end,
    version,
    sessionKey,
    hasTurns,
    turnsSignature,
    allMounted,
    containerRef,
    pinToBottom,
    captureAnchor,
    restoreAnchor,
  ]);

  /** 同一会话内删除/截断后，把越界的窗口收回来。 */
  useLayoutEffect(() => {
    if (!hasTurns) return;
    const cur = winRef.current;
    if (cur.sessionId !== sessionKey) return;
    const last = turns.length - 1;
    if (cur.start > last || cur.end > last || cur.start < 0 || cur.end < 0) {
      const start = clamp(cur.start, 0, last);
      const end = clamp(cur.end, start, last);
      commitWin({ start, end });
    }
  }, [turnsSignature, turns.length, sessionKey, hasTurns, commitWin]);

  /** 切会话：从底部起算窗口，并保持贴底一小段时间。 */
  useLayoutEffect(() => {
    if (winRef.current.sessionId === sessionKey) return;
    centerOnLatest();
  }, [sessionKey, centerOnLatest]);

  /** 视口高度 / 测量结果变化后，保证当前窗口覆盖可见区，且挂载内容至少一屏。 */
  useLayoutEffect(() => {
    if (allMountedRef.current) return;
    if (pinBottomRef.current) return;
    const el = containerRef.current;
    if (!el) return;
    const cur = winRef.current;
    if (cur.sessionId !== sessionKey) return;
    const offs = offsetsRef.current;
    const n = turnsRef.current.length;
    if (n === 0) return;
    const vh = el.clientHeight || viewportRef.current;

    const mountedH = offs[cur.end + 1] - offs[cur.start];
    const filled =
      mountedH < vh * 1.05
        ? fillRange(offs, { start: cur.start, end: cur.end }, vh)
        : null;
    const desired =
      filled ??
      desiredRange(offs, el.scrollTop, {
        viewport: vh,
        padTurns: PAD,
        overscan: Math.max(OVERSCAN_MIN, vh * OVERSCAN_SCREENS),
        maxTurns: MAX_MOUNTED_TURNS,
        maxHeight: vh * MAX_MOUNTED_SCREENS,
      });

    const start = Math.min(cur.start, desired.start);
    const end = Math.max(cur.end, desired.end);
    if (start !== cur.start || end !== cur.end) {
      commitWin({ start, end });
    }
  }, [viewportH, version, sessionKey, containerRef, commitWin]);

  /** 滚动：rAF 里做捕获与扩窗，避免同步 DOM 回流；收拢交给静止定时器。 */
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    let raf = 0;
    const onScroll = () => {
      scheduleTrim();
      if (raf) return;
      raf = window.requestAnimationFrame(() => {
        raf = 0;
        if (!aliveRef.current) return;
        if (!pinBottomRef.current) captureAnchor();
        if (allMountedRef.current) return;
        const cur = winRef.current;
        if (cur.sessionId !== sessionKey) return;
        const offs = offsetsRef.current;
        const n = turnsRef.current.length;
        if (n === 0) return;
        const vh = el.clientHeight || viewportRef.current;
        const desired = desiredRange(offs, el.scrollTop, {
          viewport: vh,
          padTurns: PAD,
          overscan: Math.max(OVERSCAN_MIN, vh * OVERSCAN_SCREENS),
          maxTurns: MAX_MOUNTED_TURNS,
          maxHeight: vh * MAX_MOUNTED_SCREENS,
        });
        if (desired.start < cur.start || desired.end > cur.end) {
          commitWin({
            start: Math.min(cur.start, desired.start),
            end: Math.max(cur.end, desired.end),
          });
        }
      });
    };

    const onUserWheel = (e: WheelEvent) => {
      // 只有用户实际用滚轮/触控板发生有效位移时，才解除贴底锁定
      if (Math.abs(e.deltaY) > 2 || Math.abs(e.deltaX) > 2) {
        pinBottomRef.current = false;
        pinUntilRef.current = 0;
      }
      scheduleTrim();
    };

    const onUserTouch = () => {
      pinBottomRef.current = false;
      pinUntilRef.current = 0;
      scheduleTrim();
    };

    el.addEventListener('scroll', onScroll, { passive: true });
    el.addEventListener('wheel', onUserWheel as EventListener, { passive: true });
    el.addEventListener('touchstart', onUserTouch, { passive: true });
    return () => {
      el.removeEventListener('scroll', onScroll);
      el.removeEventListener('wheel', onUserWheel as EventListener);
      el.removeEventListener('touchstart', onUserTouch);
      if (raf) window.cancelAnimationFrame(raf);
    };
  }, [containerRef, sessionKey, captureAnchor, scheduleTrim, commitWin]);

  /** 容器尺寸 / 内容宽度变化：换宽度后按比例恢复锚点。 */
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const content = contentRef?.current ?? el;

    const read = () => {
      const vh = el.clientHeight || 0;
      if (vh > 0) {
        setViewportH((prev) => (Math.abs(prev - vh) > 0.5 ? vh : prev));
      }
      const w = content.clientWidth || 0;
      if (w > 0 && Math.abs(w - widthRef.current) > 1) {
        widthRef.current = w;
        restoreAnchor();
        scheduleBump();
      }
    };

    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    if (content !== el) ro.observe(content);
    window.addEventListener('resize', read);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', read);
    };
  }, [containerRef, contentRef, restoreAnchor, scheduleBump]);

  /** 初始与切会话后安排一次收拢（把预载区收回到可见 ± PAD）。 */
  useEffect(() => {
    scheduleTrim();
    return () => window.clearTimeout(trimTimerRef.current);
  }, [sessionKey, scheduleTrim]);

  /** 卸载时取消所有延迟任务，避免卸载后 setState / 滚动。 */
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      if (bumpRafRef.current) window.cancelAnimationFrame(bumpRafRef.current);
      if (measureRafRef.current) window.cancelAnimationFrame(measureRafRef.current);
      window.clearTimeout(trimTimerRef.current);
    };
  }, []);

  const visitedKeys = useMemo(() => new Set(heights.keys()), [heights, version]);

  return {
    turns,
    visibleTurns,
    centerIndex: effectiveCenterIndex,
    startIndex,
    endIndex,
    centerOnLatest,
    jumpTo,
    /** 未挂载内容占位，保证滚动几何稳定 */
    topSpacer,
    bottomSpacer,
    /** 子轮次尺寸上报 */
    onMeasure,
    /** 刻度条：哪些轮次已经真实测过（用于“已加载”样式） */
    visitedKeys,
    /** 供拖拽/开合侧栏前主动拍快照 */
    captureAnchor,
    /** 解除宽度冻结/字号变化后手动恢复一次 */
    restoreAnchor,
  };
}

interface Params {
  messages: ChatMessage[];
  sessionId?: string | null;
  containerRef: RefObject<HTMLDivElement | null>;
  contentRef?: RefObject<HTMLDivElement | null>;
}
