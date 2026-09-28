import React, { useCallback, useEffect, useRef } from 'react';

/**
 * 生成中「跟随到底部」的**唯一实现**（主窗口消息流 / 浮窗消息流 / 思考框三处共用同一份，
 * 因此两个窗口的行为逐字一致）。
 *
 * 两条规则：
 *
 * 1. `active` 期间**每帧**把容器钉在最底部。比"内容变了就滚一次"更稳：内容长高、布局位移、
 *    浏览器滚动锚定造成的偏移，都会在下一帧（≤16.7ms）被拉回底部。
 *
 * 2. **用户一旦手动滚动（滚轮 / 触摸 / 键盘 / 拖滚动条），本轮立刻、彻底停止自动聚焦** ——
 *    单向闩锁，不做"滚回底部又自动恢复跟随"（那会让界面反复抖动）。
 *    闩锁是**窗口级共享**的：消息流和思考框两处跟随都会一起停（用户滚的是哪一处都算），
 *    只有下一轮生成开始（`turnKey` 变化）才复位。
 *
 * 用法：把 `containerProps` 展开到可滚动容器上（它接管 ref 与滚动相关事件）。
 * 由**消息流容器**传入 `turnKey`（每轮生成一个唯一值，如该轮助手消息 id）负责复位闩锁；
 * 思考框不必传（它只服从闩锁）。
 */

/** 窗口级共享的"用户已接管"闩锁（同一窗口内所有跟随容器共用；每轮生成复位） */
let userTookControl = false;

export function useFollowBottom(active: boolean, turnKey?: string) {
  const ref = useRef<HTMLDivElement | null>(null);
  /**
   * 程序化滚动的时间窗：窗内发生的 scroll 事件是我们自己造成的，不算用户操作。
   * 没有它就分不清「我每帧写 scrollTop」和「用户手动滚」——上一版正是栽在这里。
   */
  const programmaticUntilRef = useRef(0);
  /** 用户手动滚动后停留的位置：接管期间用它对抗"重排把位置清零" */
  const userScrollTopRef = useRef<number | null>(null);
  const lastTurnRef = useRef<string | null>(null);

  // 新一轮生成：复位闩锁，重新开始跟随（只由传了 turnKey 的消息流容器触发）
  useEffect(() => {
    if (turnKey && lastTurnRef.current !== turnKey) {
      lastTurnRef.current = turnKey;
      userTookControl = false;
      userScrollTopRef.current = null;
    }
  }, [turnKey]);

  // 每帧钉底（闩锁生效即停）
  useEffect(() => {
    if (!active) return;
    let raf = 0;
    const pin = () => {
      const el = ref.current;
      if (el && !userTookControl) {
        const bottom = el.scrollHeight - el.clientHeight;
        if (bottom - el.scrollTop > 1) {
          programmaticUntilRef.current = Date.now() + 120;
          el.scrollTop = bottom;
        }
      }
      raf = requestAnimationFrame(pin);
    };
    raf = requestAnimationFrame(pin);
    return () => cancelAnimationFrame(raf);
  }, [active]);

  /**
   * 内容一变就立刻钉底（**在浏览器绘制之前**）。
   *
   * 为什么光有 rAF 循环还不够：流式追加时 Markdown 会整棵重排/替换节点，
   * 容器滚动位置可能被重置（或临时被钳到 0），如果只等下一帧的 rAF 去纠正，
   * 那一帧就会被用户看到"跳回顶部 / 差一大截"。MutationObserver 的回调是微任务，
   * 在本次 DOM 变更之后、绘制之前执行，正好把位置补回去；ResizeObserver 负责
   * 尺寸类变化（图片/代码块撑高）。
   */
  useEffect(() => {
    if (!active) return;
    const el = ref.current;
    if (!el) return;
    const pinNow = () => {
      const box = ref.current;
      if (!box) return;
      if (userTookControl) {
        // 用户已接管：**保住他的阅读位置**。流式追加时 Markdown 会整棵重排/替换节点，
        // 容器滚动位置可能被钳到 0（表现为"强行滚回最上方"）；这里把它恢复到用户刚才的位置。
        const want = userScrollTopRef.current;
        if (want != null && box.scrollTop < want) {
          programmaticUntilRef.current = Date.now() + 120;
          box.scrollTop = want;
        }
        return;
      }
      const bottom = box.scrollHeight - box.clientHeight;
      if (bottom - box.scrollTop > 1) {
        programmaticUntilRef.current = Date.now() + 120;
        box.scrollTop = bottom;
      }
    };
    const mo = new MutationObserver(pinNow);
    mo.observe(el, { childList: true, subtree: true, characterData: true });
    const ro = new ResizeObserver(pinNow);
    ro.observe(el);
    return () => {
      mo.disconnect();
      ro.disconnect();
    };
  }, [active]);

  /** 交出控制权：用户手动滚动了（窗口级——两处跟随一起停） */
  const releaseToUser = useCallback(() => {
    userTookControl = true;
    // 不在这里记位置：wheel 等事件派发时浏览器还没真正滚动，记到的是滚动前的值。
  }, []);

  /** 供外部（如"新回合跳到底部"）标记"这段时间的滚动是我造成的" */
  const markProgrammatic = useCallback((ms = 700) => {
    programmaticUntilRef.current = Date.now() + ms;
  }, []);

  const containerProps = {
    ref,
    onWheel: releaseToUser,
    onTouchMove: releaseToUser,
    onKeyDown: (e: React.KeyboardEvent) => {
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(e.key)) {
        releaseToUser();
      }
    },
    onMouseDown: (e: React.MouseEvent) => {
      // 命中右侧滚动条（约 14px 宽）→ 用户接管
      const el = ref.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      if (e.clientX > rect.right - 14) releaseToUser();
    },
    // 只用来**记录用户停留的位置**（滚动真正发生之后才准确），**不参与闩锁判定**：
    // 程序化滚动（新回合的平滑 scrollIntoView、我们自己的跟随写入）同样派发 scroll，
    // 用它判定会把一次性闩锁在回合一开始就锁上（实测：滚动前 gap 高达 686px）。
    // 真实用户输入（wheel / touch / 键盘 / 拖滚动条）已全部覆盖闩锁判定。
    onScroll: () => {
      const el = ref.current;
      if (!el) return;
      if (Date.now() < programmaticUntilRef.current) return; // 自己造成的滚动不记录
      if (userTookControl) userScrollTopRef.current = el.scrollTop;
    },
  };

  return { containerProps, releaseToUser, markProgrammatic };
}

