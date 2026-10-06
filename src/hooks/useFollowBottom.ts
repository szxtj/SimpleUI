import React, { useCallback, useEffect, useRef } from 'react';

/**
 * 思考期滚动跟随 Hook：
 *
 * 1. 仅在思考期（active = true）且用户未接管时，保持容器跟随在最底部，展示最新思考内容。
 * 2. 用户一动（滚轮 / 触摸 / 键盘 / 拖动滚动条 / 手动滚动），立即永久释放控制权（单向闩锁），
 *    本轮绝不再碰滚动条，绝不抢夺、绝不反复拉回。
 * 3. 彻底去除所有保位/回正机制（绝无 restoreToProtected 或强制写 scrollTop 纠偏），
 *    正文流式阶段与生成结束后 100% 交由原生滚动，绝不干预。
 */
export function useFollowBottom(
  active: boolean,
  turnKey?: string,
  externalRef?: React.RefObject<HTMLDivElement | null>
) {
  const internalRef = useRef<HTMLDivElement | null>(null);
  const ref = externalRef ?? internalRef;

  /** 实例级"用户已接管"闩锁（每个容器独立，避免不同实例或历史思考条相互干扰） */
  const userTookControlRef = useRef(false);

  /** 自身写 scrollTop 的静默时间窗，避免自身触发的 scroll 事件误识别为用户操作 */
  const programmaticUntilRef = useRef(0);

  const lastTurnRef = useRef<string | null>(null);
  const prevActiveRef = useRef(active);

  // 新一轮生成或 active 重新被拉起：复位闩锁
  useEffect(() => {
    if (turnKey) {
      if (lastTurnRef.current !== turnKey) {
        lastTurnRef.current = turnKey;
        userTookControlRef.current = false;
      }
    } else {
      // 未传 turnKey 的容器（如思考折叠框）：当 active 从 false 变 true 时复位
      if (active && !prevActiveRef.current) {
        userTookControlRef.current = false;
      }
      lastTurnRef.current = null;
    }
    prevActiveRef.current = active;
  }, [turnKey, active]);

  // 思考期跟随：rAF 钉底循环
  useEffect(() => {
    if (!active) return;

    let raf = 0;
    const pin = () => {
      const el = ref.current;
      if (el && !userTookControlRef.current) {
        const bottom = el.scrollHeight - el.clientHeight;
        if (bottom - el.scrollTop > 1) {
          programmaticUntilRef.current = Date.now() + 50;
          el.scrollTop = bottom;
        }
        raf = requestAnimationFrame(pin);
      }
    };

    raf = requestAnimationFrame(pin);
    return () => cancelAnimationFrame(raf);
  }, [active]);

  /** 释放控制权：用户一动，本轮思考期立刻、彻底停止自动跟随，永不再碰滚动条 */
  const releaseToUser = useCallback(() => {
    userTookControlRef.current = true;
  }, []);

  /** 供外部（如新回合跳底）标记"这段时间内的滚动是程序化的" */
  const markProgrammatic = useCallback((ms = 700) => {
    programmaticUntilRef.current = Date.now() + ms;
  }, []);

  const containerProps = {
    ref,
    onWheel: (_e?: React.WheelEvent) => releaseToUser(),
    onTouchMove: (_e?: React.TouchEvent) => releaseToUser(),
    onKeyDown: (e: React.KeyboardEvent) => {
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(e.key)) {
        releaseToUser();
      }
    },
    onMouseDown: (e: React.MouseEvent) => {
      // 命中右侧滚动条（约 16px 宽）
      const el = ref.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      if (e.clientX > rect.right - 16) {
        releaseToUser();
      }
    },
    onScroll: () => {
      // 仅在思考期有效；若当前不是自己触发的滚动，则视为用户滚动，立刻交出控制权
      if (!active) return;
      if (Date.now() < programmaticUntilRef.current) return;
      releaseToUser();
    },
  };

  return { containerProps, releaseToUser, markProgrammatic };
}
