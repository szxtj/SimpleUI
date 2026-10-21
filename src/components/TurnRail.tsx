import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ChatTurn, toPreviewText } from '../utils/turns';
import { useI18n } from '../i18n';

interface TurnRailProps {
  turns: ChatTurn[];
  centerIndex: number;
  startIndex: number;
  endIndex: number;
  /** 已经真实测量过的轮次（滚动离开后仍保持“已加载”观感） */
  visited?: ReadonlySet<string>;
  onJump: (index: number) => void;
  /** 浮窗用更窄的刻度与卡片 */
  compact?: boolean;
}

/** 固定 11 个槽位：当前轮落在正中，上下各 5 个邻居 */
const SLOTS = 11;
const HALF = (SLOTS - 1) / 2;
/** 进出动画的缓冲槽（换挡时两端的刻度能滑入/滑出，不会凭空出现） */
const BUFFER = 1;
const SLOT_H = 11;
const SLOT_H_COMPACT = 10;
const SLIDE_MS = 150;
/** 滚轮累计多少像素换一格 */
const WHEEL_UNIT = 26;
/** 滚轮停顿后再提交跳转，避免连续滚动时反复重挂载 */
const COMMIT_DELAY = 130;

/**
 * 右侧「定位横线」（Prompt Rail）。
 *
 * - 每轮问答一枚短横线，固定 11 槽：当前轮最长、已加载轮次中等、未加载最短；
 * - 悬停出「问题 + 最终回答」预览卡（不含思考过程 / 阶段 / 指标）；
 * - 点击某枚 → 跳到该轮（问题贴顶）；
 * - **滚轮 / 上下拖动都能滚动这条横线**：按整格换挡并带滑动过渡，
 *   松手（或滚轮停顿）后才真正切窗口，落点永远是整格，不会出现半格错位；
 * - 上下两端有渐隐遮罩，刻度滑进滑出不会硬切。
 */
export const TurnRail: React.FC<TurnRailProps> = ({
  turns,
  centerIndex,
  startIndex,
  endIndex,
  visited,
  onJump,
  compact = false,
}) => {
  const { t } = useI18n();
  const slotH = compact ? SLOT_H_COMPACT : SLOT_H;
  const railH = SLOTS * slotH;

  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const [pending, setPending] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const pendingRef = useRef<number | null>(null);
  const dragRef = useRef<{
    pointerId: number;
    startY: number;
    /** 拖拽基线：按下瞬间的"中心轮"（不是按下的那枚刻度，否则整盘会先跳一下） */
    baseCenter: number;
    /** 按下的那枚刻度，用于"没拖动 = 点击跳转" */
    pressedIdx: number;
    moved: boolean;
  } | null>(null);
  const railRef = useRef<HTMLDivElement | null>(null);
  const wheelAccRef = useRef(0);
  const wheelResetRef = useRef(0);
  const commitTimerRef = useRef(0);

  const total = turns.length;
  const displayCenter = Math.max(0, Math.min(total - 1, pending ?? centerIndex));

  const updatePending = useCallback((next: number | null) => {
    pendingRef.current = next;
    setPending(next);
  }, []);

  /** 换到某一格（先动刻度，等滚动/拖动停下来再提交跳转） */
  const stepTo = useCallback(
    (target: number, delay: number) => {
      if (total === 0) return;
      const clamped = Math.max(0, Math.min(total - 1, target));
      if (clamped === (pendingRef.current ?? centerIndex)) return;
      updatePending(clamped);
      window.clearTimeout(commitTimerRef.current);
      commitTimerRef.current = window.setTimeout(() => onJump(clamped), delay);
    },
    [centerIndex, onJump, total, updatePending]
  );

  // 轮次减少（删除/切会话）时把 pending 收进合法区间
  useEffect(() => {
    if (pendingRef.current != null && pendingRef.current > total - 1) {
      updatePending(Math.max(0, total - 1));
    }
  }, [total, updatePending]);

  // 落点确认后把 pending 交还给真实中心；异常情况兜底清掉，避免卡在中间态
  useEffect(() => {
    if (pending == null || dragging) return;
    if (pending === centerIndex) {
      updatePending(null);
      return;
    }
    const timer = window.setTimeout(() => updatePending(null), 900);
    return () => window.clearTimeout(timer);
  }, [pending, centerIndex, dragging, updatePending]);

  useEffect(
    () => () => {
      window.clearTimeout(commitTimerRef.current);
      window.clearTimeout(wheelResetRef.current);
    },
    []
  );

  const onWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    if (total < 2) return;
    wheelAccRef.current += e.deltaY;
    window.clearTimeout(wheelResetRef.current);
    wheelResetRef.current = window.setTimeout(() => {
      wheelAccRef.current = 0;
    }, 220);

    let steps = Math.trunc(wheelAccRef.current / WHEEL_UNIT);
    if (steps === 0) return;
    steps = Math.max(-4, Math.min(4, steps));
    wheelAccRef.current -= steps * WHEEL_UNIT;
    // 滚轮在长会话里按比例加速；**按住拖动仍然固定 1 格 = 1 轮**。
    const stepSize = total > 24 ? Math.ceil(total / 24) : 1;
    stepTo((pendingRef.current ?? centerIndex) + steps * stepSize, COMMIT_DELAY);
  };

  const onSlotPointerDown = (idx: number) => (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    // 捕获必须挂在容器上：刻度元素在换挡时会离开缓冲槽被卸载，
    // 一旦捕获挂在它身上，卸载即失捕获 → pointerup 收不到 → 永远停在"按住态"。
    railRef.current?.setPointerCapture(e.pointerId);
    dragRef.current = {
      pointerId: e.pointerId,
      startY: e.clientY,
      baseCenter: displayCenter,
      pressedIdx: idx,
      moved: false,
    };
    setDragging(true);
    setHoverIndex(null);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const dy = e.clientY - drag.startY;
    if (!drag.moved && Math.abs(dy) > 3) drag.moved = true;
    if (!drag.moved) return;
    // 当作在"转表盘"：手往下拉，刻度整体跟着往下走（内容跟手），中心轮相应后退
    const target = Math.max(
      0,
      Math.min(total - 1, drag.baseCenter - Math.round(dy / slotH))
    );
    if (target !== pendingRef.current) updatePending(target);
  };

  const endDrag = useCallback(() => {
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;
    setDragging(false);
    const target = pendingRef.current ?? drag.pressedIdx;
    onJump(target);
  }, [onJump]);

  // 兜底：拖到窗口外 / 切走焦点 / 捕获丢失时也能收尾，绝不留在"按住态"
  useEffect(() => {
    if (!dragging) return;
    window.addEventListener('pointerup', endDrag);
    window.addEventListener('pointercancel', endDrag);
    window.addEventListener('blur', endDrag);
    return () => {
      window.removeEventListener('pointerup', endDrag);
      window.removeEventListener('pointercancel', endDrag);
      window.removeEventListener('blur', endDrag);
    };
  }, [dragging, endDrag]);

  if (total < 2) return null;

  const firstIdx = Math.max(0, displayCenter - HALF - BUFFER);
  const lastIdx = Math.min(total - 1, displayCenter + HALF + BUFFER);
  const ticks: number[] = [];
  for (let i = firstIdx; i <= lastIdx; i++) ticks.push(i);

  // 按住或滚轮换挡时，预览框只跟"刻度盘中心"（= 松手后的落点），不跟鼠标
  const previewIndex = dragging || pending != null ? displayCenter : hoverIndex;
  const previewTurn = previewIndex != null ? turns[previewIndex] : undefined;
  const previewTop =
    previewIndex != null
      ? Math.min(
          railH - slotH / 2,
          Math.max(slotH / 2, (previewIndex - displayCenter + HALF) * slotH + slotH / 2)
        )
      : 0;

  return (
    <div
      ref={railRef}
      className={`absolute z-30 select-none ${compact ? 'right-1.5' : 'right-2.5'}`}
      style={{
        // 注意：不要用 translateY(-50%) 定位 —— transform 会成为 backdrop-filter 的
        // backdrop root，Safari/WKWebView 下模糊会整层失效（这正是小窗按住看不到模糊的原因）
        top: `calc(50% - ${railH / 2}px)`,
        height: railH,
        width: compact ? 16 : 20,
      }}
      role="group"
      aria-label={t('turnRailLabel')}
      data-rail-pressing={dragging ? 'true' : 'false'}
      onWheel={onWheel}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onLostPointerCapture={endDrag}
    >
      {/* 按住时的"底下模糊"：无边框、无底色，只把后面的正文糊掉。
          关键约束：mask / transform / opacity 都会创建 backdrop root，祖先上只要有一样，
          子元素的 backdrop-filter 就采不到背后的内容（Safari 与 Chromium 一致）。
          所以这里**不用遮罩**，改用三层同心、逐层收窄 + 由淡到实的模糊叠出软边。 */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{ visibility: dragging ? 'visible' : 'hidden' }}
      >
        {[
          { shrink: 0, alpha: 0.66 },
          { shrink: 5, alpha: 0.86 },
          { shrink: 10, alpha: 1 },
        ].map((layer, i) => (
          <div
            key={i}
            style={{
              position: 'absolute',
              right: 0,
              top: (railH - railH * 2) / 2 + layer.shrink,
              width: Math.max(10, (compact ? 16 : 20) * 2 - layer.shrink * 1.2),
              height: railH * 2 - layer.shrink * 2,
              borderRadius: 999,
              backdropFilter: 'blur(9px)',
              WebkitBackdropFilter: 'blur(9px)',
              opacity: layer.alpha,
            }}
          />
        ))}
      </div>

      {/* 按住时整块向左放大 */}
      <div
        className="absolute inset-0"
        style={{
          transform: dragging ? 'scale(2)' : 'scale(1)',
          transformOrigin: 'right center',
          transition: 'transform 160ms cubic-bezier(0.22,0.61,0.36,1)',
        }}
      >
      {/* 刻度层：上下渐隐，超出部分裁掉；换挡时整列滑动 */}
      <div className="rail-fade absolute inset-0 overflow-hidden">
        {ticks.map((idx) => {
          const isCurrent = idx === displayCenter;
          const isLoaded = visited
            ? visited.has(turns[idx]?.key ?? '')
            : idx >= startIndex && idx <= endIndex;
          const isHovered = hoverIndex === idx;
          const width = isCurrent ? (compact ? 12 : 14) : isLoaded ? (compact ? 8 : 10) : 6;
          const height = isCurrent ? 3 : 2;
          const tone = isCurrent
            ? 'bg-zinc-800 dark:bg-zinc-200'
            : isLoaded
              ? 'bg-zinc-500/85 dark:bg-zinc-500'
              : 'bg-zinc-400/70 dark:bg-zinc-700';
          return (
            <div
              key={idx}
              data-turn-slot={idx}
              onPointerDown={onSlotPointerDown(idx)}
              onPointerEnter={() => {
                if (!dragRef.current) setHoverIndex(idx);
              }}
              onPointerLeave={() => setHoverIndex((cur) => (cur === idx ? null : cur))}
              className={`absolute right-0 flex items-center justify-end ${
                dragRef.current ? 'cursor-grabbing' : 'cursor-pointer'
              }`}
              style={{
                top: (idx - displayCenter + HALF) * slotH,
                height: slotH,
                width: compact ? 16 : 20,
                transition: dragging ? 'none' : `top ${SLIDE_MS}ms cubic-bezier(0.22,0.61,0.36,1)`,
              }}
            >
              <div
                className={`rounded-full transition-[width,height] duration-150 ${tone}`}
                style={{ width: isHovered && !isCurrent ? width + 2 : width, height }}
              />
            </div>
          );
        })}
      </div>
      </div>

      {previewTurn && (
        <div
          className="pointer-events-none absolute"
          style={{
            right: `calc(100% + ${dragging ? (compact ? 24 : 30) : 8}px)`,
            top: previewTop,
            transform: 'translateY(-50%)',
            width: compact ? 206 : 264,
          }}
        >
          <div className="rounded-[10px] border border-black/10 bg-white/95 px-3 py-2 shadow-lg dark:border-white/10 dark:bg-[#26272e]">
            <div className="line-clamp-2 text-[12.5px] font-medium leading-snug text-zinc-800 dark:text-zinc-100">
              {toPreviewText(previewTurn.user?.content) || t('turnPreviewNoQuestion')}
            </div>
            <div className="mt-1 line-clamp-3 text-[11.5px] leading-relaxed text-zinc-500 dark:text-zinc-400">
              {toPreviewText(previewTurn.assistant?.content) || t('turnPreviewEmpty')}
            </div>
            <div className="mt-1.5 text-[10.5px] font-mono text-zinc-400 dark:text-zinc-500">
              {(previewIndex as number) + 1} / {total}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
