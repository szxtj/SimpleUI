import { useCallback, useEffect, useRef, useState } from 'react';
import {
  MIDDLE_MIN_WIDTH,
  PANEL_DEFAULT_WIDTH,
  PANEL_MAX_WIDTH,
  PANEL_MIN_WIDTH,
} from '../layout';

const STORAGE_KEY = 'simpleui_side_panel_width';
const DEFAULT_WIDTH = PANEL_DEFAULT_WIDTH;
const MIN_WIDTH = PANEL_MIN_WIDTH;
const MAX_WIDTH = PANEL_MAX_WIDTH;

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

/**
 * 右栏能拖到多宽：窗口宽 − 左栏 − 中部最小宽度。
 * 早前没减去左栏 → 左栏开着时中部能被压到 200 左右（违背"中部有最小宽度"）。
 */
function maxForViewport(reservedLeft: number): number {
  if (typeof window === 'undefined') return MAX_WIDTH;
  return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, window.innerWidth - reservedLeft - MIDDLE_MIN_WIDTH));
}

interface UsePanelWidthOptions {
  /**
   * 拖拽过程中每帧回调（**不经过 React 状态**）。
   * 由容器把宽度直接写进 DOM、同时更新遮罩上的尺寸胶囊；页面内容保持不渲染。
   */
  onLiveWidth?: (w: number) => void;
  /** 左栏当前宽度（0 或 260）：拖拽钳制要用它算中部最小宽度 */
  reservedLeft?: number;
}

/**
 * 右侧面板宽度（左沿可拖拽）。
 *
 * 关键设计：**拖拽期间不 setState**。
 * 早期版本每次 pointermove 都 `setWidth` → 整个 SidePanel（含所有常驻标签页、
 * 图片画布的 ResizeObserver）逐帧重渲染，图片页在场时明显卡顿。
 * 现在拖拽只做「改 DOM 宽度 + 更新胶囊数字」，松手才提交一次 state、
 * 写 localStorage、通知原生 `setPanelWidth`。
 *
 * 宽度键只属于主窗口，浮窗从不读写（浮窗尺寸由 resizePanel 独立管理）。
 */
export function usePanelWidth({ onLiveWidth, reservedLeft = 0 }: UsePanelWidthOptions = {}) {
  const [width, setWidth] = useState(() => {
    if (typeof window === 'undefined') return DEFAULT_WIDTH;
    const saved = Number(localStorage.getItem(STORAGE_KEY));
    return Number.isFinite(saved) && saved >= MIN_WIDTH ? clamp(saved, MIN_WIDTH, MAX_WIDTH) : DEFAULT_WIDTH;
  });
  const [dragging, setDragging] = useState(false);
  const widthRef = useRef(width);
  widthRef.current = width;
  /** 拖拽中的实时宽度（松手时用它提交） */
  const liveWidthRef = useRef(width);
  const draggingRef = useRef(false);
  /** 按下点相对面板左沿的偏移（抓在把手中间时，面板不会先跳 3px） */
  const grabOffsetRef = useRef(0);
  const liveCbRef = useRef(onLiveWidth);
  liveCbRef.current = onLiveWidth;
  const reservedLeftRef = useRef(reservedLeft);
  reservedLeftRef.current = reservedLeft;

  const notifyNative = useCallback((w: number) => {
    try {
      // @ts-expect-error WebKit bridge
      window.webkit?.messageHandlers?.setPanelWidth?.postMessage?.(Math.round(w));
    } catch {
      /* 非 macOS / 测试环境无桥 */
    }
  }, []);

  // 启动时把持久化宽度同步给原生（否则原生仍按 440 算最小窗口宽度）
  useEffect(() => {
    notifyNative(widthRef.current);
  }, [notifyNative]);

  const persist = (w: number) => {
    try {
      localStorage.setItem(STORAGE_KEY, String(w));
    } catch {
      /* 忽略存储失败 */
    }
    notifyNative(w);
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    grabOffsetRef.current = e.clientX - (window.innerWidth - widthRef.current);
    liveWidthRef.current = widthRef.current;
    draggingRef.current = true;
    setDragging(true);
    liveCbRef.current?.(widthRef.current);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    const edge = e.clientX - grabOffsetRef.current;
    const next = clamp(Math.round(window.innerWidth - edge), MIN_WIDTH, maxForViewport(reservedLeftRef.current));
    liveWidthRef.current = next;
    // 只改 DOM，不触发 React 渲染
    liveCbRef.current?.(next);
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* 已释放 */
    }
    const finalWidth = liveWidthRef.current;
    setDragging(false);
    setWidth(finalWidth); // 唯一一次提交，只重排一次
    persist(finalWidth);
  };

  /** 双击把手：回到默认宽度 */
  const reset = () => {
    liveWidthRef.current = DEFAULT_WIDTH;
    setWidth(DEFAULT_WIDTH);
    persist(DEFAULT_WIDTH);
  };

  return { width, dragging, liveWidthRef, onPointerDown, onPointerMove, onPointerUp, reset };
}
