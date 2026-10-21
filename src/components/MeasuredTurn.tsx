import React, { useLayoutEffect, useRef } from 'react';

interface MeasuredTurnProps {
  turnKey: string;
  turnIndex: number;
  onMeasure: (key: string, height: number) => void;
  className?: string;
  children: React.ReactNode;
}

/**
 * 一轮对话的测量壳。
 *
 * 高度必须包含轮间距（padding-bottom），这样虚拟列表的 offsets 是纯前缀和，
 * spacer 与真实内容可以无缝替换。
 *
 * 用 `useLayoutEffect` 先同步测一次（避免首帧用估算高度绘制），
 * 再用 `ResizeObserver` 跟踪流式正文、图片、KaTeX、手风琴等异步高度变化。
 */
export const MeasuredTurn: React.FC<MeasuredTurnProps> = React.memo(
  ({ turnKey, turnIndex, onMeasure, className, children }) => {
    const ref = useRef<HTMLDivElement | null>(null);

    useLayoutEffect(() => {
      const el = ref.current;
      if (!el) return;

      const report = () => {
        // getBoundingClientRect 保留小数，避免长列表累计舍入误差
        onMeasure(turnKey, el.getBoundingClientRect().height);
      };

      report();
      const ro = new ResizeObserver(report);
      ro.observe(el);
      return () => ro.disconnect();
    }, [turnKey, onMeasure]);

    return (
      <div
        ref={ref}
        data-turn-key={turnKey}
        data-turn-index={turnIndex}
        className={`chat-turn ${className ?? ''}`}
      >
        {children}
      </div>
    );
  }
);

MeasuredTurn.displayName = 'MeasuredTurn';
