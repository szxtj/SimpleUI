import React, { useCallback, useEffect, useRef } from 'react';

/**
 * 思考过程手风琴滚动跟随 Hook：
 *
 * 1. 当处于思考流式输出阶段（active = true）且未脱离底部时，自动向下跟随滚动展示最新思考内容。
 * 2. 当用户手动向上滚动（滚轮上滚 / 拖动滚动条 / 触摸上滑 / 向上按键）离开底部时，立即释放滚动控制权。
 * 3. 当用户再次手动将思考内容滚动到底部贴底（距底部 <= 10px）时，自动恢复跟随滚动。
 */
export function useFollowBottom(
  active: boolean,
  turnKey?: string,
  externalRef?: React.RefObject<HTMLDivElement | null>
) {
  const internalRef = useRef<HTMLDivElement | null>(null);
  const ref = externalRef ?? internalRef;

  /** 实例级"用户已脱离底部接管"状态（false = 自动跟随底部，true = 已释放给用户） */
  const userTookControlRef = useRef(false);

  /** 自身写 scrollTop 的静默时间窗，区分程序化滚动与用户主动滚动 */
  const programmaticUntilRef = useRef(0);

  const lastTurnRef = useRef<string | null>(null);
  const prevActiveRef = useRef(active);

  // 新一轮生成或手风琴重新展开进入 active 时：默认跟随底部
  useEffect(() => {
    if (turnKey) {
      if (lastTurnRef.current !== turnKey) {
        lastTurnRef.current = turnKey;
        userTookControlRef.current = false;
      }
    } else {
      if (active && !prevActiveRef.current) {
        userTookControlRef.current = false;
      }
      lastTurnRef.current = null;
    }
    prevActiveRef.current = active;
  }, [turnKey, active]);

  // 思考期跟随：rAF 持续运行，当处于跟随状态（!userTookControlRef.current）时贴底，
  // 一旦用户手动滚回底部将 userTookControlRef.current 置回 false，立即无缝恢复跟随
  useEffect(() => {
    if (!active) return;

    let raf = 0;
    const pin = () => {
      const el = ref.current;
      if (el && !userTookControlRef.current) {
        const bottom = Math.max(0, el.scrollHeight - el.clientHeight);
        if (bottom - el.scrollTop > 1) {
          programmaticUntilRef.current = Date.now() + 60;
          el.scrollTop = bottom;
        }
      }
      raf = requestAnimationFrame(pin);
    };

    raf = requestAnimationFrame(pin);
    return () => cancelAnimationFrame(raf);
  }, [active, ref]);

  const releaseToUser = useCallback(() => {
    userTookControlRef.current = true;
  }, []);

  const resumeFollow = useCallback(() => {
    userTookControlRef.current = false;
  }, []);

  const markProgrammatic = useCallback((ms = 700) => {
    programmaticUntilRef.current = Date.now() + ms;
  }, []);

  const containerProps = {
    ref,
    onWheel: (e: React.WheelEvent<HTMLDivElement>) => {
      if (!active) return;
      if (e.deltaY < -0.5) {
        // 用户向上滚动，立即释放
        releaseToUser();
      } else if (e.deltaY > 0.5) {
        // 用户向下滚动，若已贴底则恢复跟随
        const el = ref.current;
        if (el) {
          const distanceToBottom = el.scrollHeight - el.clientHeight - el.scrollTop;
          if (distanceToBottom <= 12) {
            resumeFollow();
          }
        }
      }
    },
    onTouchMove: () => {
      // 触摸滑动由 onScroll 根据与底部的距离实时判定释放或恢复跟随
    },
    onKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (!active) return;
      if (['ArrowUp', 'PageUp', 'Home'].includes(e.key)) {
        releaseToUser();
      } else if (e.key === 'End') {
        resumeFollow();
      }
    },
    onMouseDown: (e: React.MouseEvent<HTMLDivElement>) => {
      if (!active) return;
      const el = ref.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      // 点击右侧滚动条拖拽时先释放，待拖到底部时由 onScroll 自动恢复
      if (e.clientX >= rect.right - 24) {
        releaseToUser();
      }
    },
    onScroll: () => {
      if (!active) return;
      const el = ref.current;
      if (!el) return;
      if (Date.now() < programmaticUntilRef.current) return;

      const distanceToBottom = el.scrollHeight - el.clientHeight - el.scrollTop;
      if (distanceToBottom <= 10) {
        // 用户再次手动滚回贴底位置，恢复自动跟随
        resumeFollow();
      } else if (distanceToBottom > 14) {
        // 用户手动滚离底部，释放控制权
        releaseToUser();
      }
    },
  };

  return { containerProps, releaseToUser, resumeFollow, markProgrammatic };
}
