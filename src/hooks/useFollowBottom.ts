import React, { useCallback, useEffect, useRef } from 'react';

/**
 * 生成中「跟随到底部 / 保住阅读位置」的**唯一实现**（主窗口消息流 / 浮窗消息流 / 思考框
 * 三处共用同一份，因此两个窗口的行为逐字一致）。
 *
 * 三条规则：
 *
 * 1. **跟随期**（`active`，检索 / 载入上下文 / 思考阶段）：每帧把容器钉在最底部。
 *    内容长高、布局位移、浏览器滚动锚定造成的偏移，都会在下一帧（≤16.7ms）被拉回底部。
 *
 * 2. **保位期**（`keepPosition` 且非跟随期，即正文流式阶段）：**完全不自动滚动**，
 *    正文在视口下方自然增长，阅读权交给用户。但必须守住用户的阅读位置——
 *    流式 Markdown 会整棵重排/替换节点，思考条收起等会让容器高度塌缩，浏览器随之把
 *    scrollTop 钳向上方（表现为"不停往顶上跳、看不到最新内容"）；观察器/scroll 兜底
 *    会在钳制发生时把视野拉回用户所在位置。只对抗"被拽走"，绝不替用户往下滚。
 *
 * 3. **单向闩锁**：用户一旦手动滚动（滚轮 / 触摸 / 键盘 / 拖滚动条），本轮跟随立刻、
 *    彻底停止——跟随期钉底、思考框跟随一起停（窗口级共享，`turnKey` 变化才复位）。
 *    不做"滚回底部又自动恢复"（那会让界面反复抖动）。
 *
 * 「用户滚动」的判定只认**真实输入**：wheel / touchmove / 方向键翻页键 / 命中右侧滚动条的
 * mousedown（拖拽期间持续有效）。真实输入后 ≤300ms 内的 scroll 事件才算用户滚的
 * （覆盖惯性滚动的持续 wheel）；我们自己的程序化滚动走 120ms 时间窗排除。
 * 没有这两层区分，就分不清「用户往上翻」和「重排钳制把 scrollTop 钳上去」，
 * 保位会退化成抢用户的滚动条（上一版正是栽在用 scroll 事件判定上）。
 *
 * 用法：把 `containerProps` 展开到可滚动容器上（它接管 ref 与滚动相关事件）。
 * 由**消息流容器**传入 `turnKey`（每轮生成一个唯一值，如该轮助手消息 id）负责复位闩锁；
 * 思考框不必传（它只服从闩锁）。消息流容器另传 `keepPosition = isGenerating`，
 * 让正文流式阶段进入保位期。
 */

/** 窗口级共享的"用户已接管"闩锁（同一窗口内所有跟随容器共用；每轮生成复位） */
let userTookControl = false;

/** 用户真实输入后的采样窗：窗内的 scroll 事件才算用户滚的 */
const USER_INPUT_WINDOW_MS = 300;

export function useFollowBottom(active: boolean, turnKey?: string, keepPosition = false) {
  const ref = useRef<HTMLDivElement | null>(null);
  /**
   * 程序化滚动的时间窗：窗内发生的 scroll 事件是我们自己造成的，不算用户操作。
   * 没有它就分不清「我每帧写 scrollTop」和「用户手动滚」。
   */
  const programmaticUntilRef = useRef(0);
  /** 需要守住的阅读位置：跟随期=钉底位置（或用户接管后的位置）；保位期=用户所在位置 */
  const protectedTopRef = useRef<number | null>(null);
  /** 最近一次真实用户输入的时间戳（wheel/touch/键盘/滚动条拖拽） */
  const lastUserInputAtRef = useRef(0);
  /** 正在拖拽右侧滚动条：拖拽期间的所有 scroll 都算用户操作 */
  const draggingScrollbarRef = useRef(false);
  /** active 的实时镜像：MutationObserver 回调可能带着上一轮的闭包触发
   *  （cleanup 在 passive 阶段才跑），分支判定必须读最新值，否则正文已开始
   *  还会按旧闭包钉一次底。 */
  const activeRef = useRef(active);
  activeRef.current = active;
  const lastTurnRef = useRef<string | null>(null);

  /**
   * 把视野恢复到受保护位置：只对抗"被钳向上方"，绝不替用户往下滚。
   * 锚点不可达（思考条收起 / 内容塌缩把高度砍到锚点之上）时就地重锚——
   * 否则正文增长会让 min(锚点, max) 逐块变大，恢复会把视野一路拽向旧锚点，
   * 变成正文期的"自动滚动"（实测：正文开始后视野被拖回塌缩前的位置才停下）。
   */
  const restoreToProtected = useCallback(() => {
    const box = ref.current;
    if (!box || protectedTopRef.current == null) return;
    const max = box.scrollHeight - box.clientHeight;
    if (protectedTopRef.current > max) protectedTopRef.current = max;
    if (box.scrollTop < protectedTopRef.current - 1) {
      programmaticUntilRef.current = Date.now() + 120;
      box.scrollTop = protectedTopRef.current;
    }
  }, []);

  // 新一轮生成：复位闩锁，重新开始跟随（只由传了 turnKey 的消息流容器触发）
  useEffect(() => {
    if (turnKey && lastTurnRef.current !== turnKey) {
      lastTurnRef.current = turnKey;
      userTookControl = false;
      protectedTopRef.current = null;
    }
  }, [turnKey]);

  // 跟随期：每帧钉底（闩锁生效即停），并把钉住的位置记为受保护位置
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
        protectedTopRef.current = el.scrollTop;
      }
      raf = requestAnimationFrame(pin);
    };
    raf = requestAnimationFrame(pin);
    return () => cancelAnimationFrame(raf);
  }, [active]);

  /**
   * 跟随期 + 保位期共用的观察器（DOM 变更后、绘制前先修正滚动位置）。
   *
   * 为什么光有 rAF 循环还不够：流式追加时 Markdown 会整棵重排/替换节点，
   * 容器滚动位置可能被钳到 0（或被跟随写成一棵**临时塌缩布局**的底部），
   * 等下一帧 rAF 去纠正，那一帧就会被用户看到"跳回顶部 / 差一大截"。
   * MutationObserver 的回调是微任务，在本次 DOM 变更之后、绘制之前执行；
   * ResizeObserver 负责尺寸类变化（图片/代码块撑高）。
   */
  useEffect(() => {
    if (!active && !keepPosition) return;
    const el = ref.current;
    if (!el) return;

    const pinNow = () => {
      const box = ref.current;
      if (!box) return;
      if (userTookControl) {
        // 用户已接管：**保住他的阅读位置**。流式 Markdown 整棵重排时容器滚动位置
        // 可能被钳到 0（表现为"强行滚回最上方"），这里恢复到用户刚才停的位置。
        restoreToProtected();
        return;
      }
      if (activeRef.current) {
        // 跟随期：钉底（只往下追，不往上拽）
        const bottom = box.scrollHeight - box.clientHeight;
        if (bottom - box.scrollTop > 1) {
          programmaticUntilRef.current = Date.now() + 120;
          box.scrollTop = bottom;
        }
        protectedTopRef.current = box.scrollTop;
        return;
      }
      // 保位期（正文流式）：不自动滚，只对抗"重排钳制把视野拽向顶部"
      restoreToProtected();
    };

    const mo = new MutationObserver(pinNow);
    mo.observe(el, { childList: true, subtree: true, characterData: true });
    const ro = new ResizeObserver(pinNow);
    ro.observe(el);
    return () => {
      mo.disconnect();
      ro.disconnect();
    };
  }, [active, keepPosition, restoreToProtected]);

  /** 交出控制权：用户手动滚动了（窗口级——两处跟随一起停） */
  const releaseToUser = useCallback(() => {
    userTookControl = true;
    // 不在这里记位置：wheel 等事件派发时浏览器还没真正滚动，记到的是滚动前的值。
  }, []);

  /** 记录"刚发生了真实用户输入"：紧随其后的 scroll 事件才算用户滚的 */
  const markUserInput = useCallback(() => {
    lastUserInputAtRef.current = Date.now();
  }, []);

  /** 供外部（如"新回合跳到底部"）标记"这段时间的滚动是我造成的" */
  const markProgrammatic = useCallback((ms = 700) => {
    programmaticUntilRef.current = Date.now() + ms;
  }, []);

  const containerProps = {
    ref,
    onWheel: () => {
      markUserInput();
      releaseToUser();
    },
    onTouchMove: () => {
      markUserInput();
      releaseToUser();
    },
    onKeyDown: (e: React.KeyboardEvent) => {
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(e.key)) {
        markUserInput();
        releaseToUser();
      }
    },
    onMouseDown: (e: React.MouseEvent) => {
      // 命中右侧滚动条（约 14px 宽）→ 用户接管；拖拽是持续动作，
      // 之后的一系列 scroll 都在 mousedown 与 mouseup 之间，全部记为用户操作
      const el = ref.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      if (e.clientX > rect.right - 14) {
        markUserInput();
        releaseToUser();
        draggingScrollbarRef.current = true;
        const up = () => {
          draggingScrollbarRef.current = false;
          document.removeEventListener('mouseup', up);
        };
        document.addEventListener('mouseup', up);
      }
    },
    // 只用来**区分用户滚动与异常位移**，不参与闩锁判定：
    // 程序化滚动（新回合的平滑 scrollIntoView、我们自己的跟随/恢复写入）同样派发 scroll，
    // 用它判定会把一次性闩锁在回合一开始就锁上（实测：滚动前 gap 高达 686px）。
    // 闩锁只认真实输入（wheel / touch / 键盘 / 拖滚动条），见各 on* 处理器。
    onScroll: () => {
      const el = ref.current;
      if (!el) return;
      if (Date.now() < programmaticUntilRef.current) return; // 自己造成的滚动不记录
      const recentInput =
        Date.now() - lastUserInputAtRef.current < USER_INPUT_WINDOW_MS || draggingScrollbarRef.current;
      if (recentInput) {
        // 用户滚的：更新受保护位置（保位期的锚点随用户移动）
        protectedTopRef.current = el.scrollTop;
      } else if (userTookControl || (!active && keepPosition)) {
        // 无输入的位移 = 布局钳制/重置（没有 DOM 突变时 MutationObserver 兜不到），
        // 接管期与保位期就地拉回，防止"不停往顶上跳"（与观察器共用同一套重锚规则）
        restoreToProtected();
      }
    },
  };

  return { containerProps, releaseToUser, markProgrammatic };
}
