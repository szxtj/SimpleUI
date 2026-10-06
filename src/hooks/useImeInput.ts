import React, { useCallback, useRef } from 'react';

export interface UseImeInputOptions<T extends HTMLElement = HTMLTextAreaElement> {
  /**
   * 回车触发的回调（非输入法合成状态且未按 Shift 时触发）
   */
  onEnter?: (e: React.KeyboardEvent<T>) => void;
  /**
   * 是否在满足回车发送条件时自动执行 e.preventDefault()，默认为 true
   */
  preventDefault?: boolean;
  /**
   * 透传的自定义 keydown 处理函数
   */
  onKeyDown?: (e: React.KeyboardEvent<T>) => void;
}

/**
 * 现代 AI 客户端风格的输入框 IME（中文/日文/韩文输入法）回车处理 Hook。
 *
 * 参考 ChatGPT / Claude / Cursor 等现代 AI 网页客户端设计逻辑：
 * 1. 当用户处于输入法拼音/选词合成态（isComposing 为 true、keyCode 为 229 等）时，
 *    按下 Enter 键的预期行为是将当前拼音或未确认内容直接上屏提交到输入框中，绝不能触发消息发送。
 * 2. 彻底解决 macOS WebKit / Safari 的关键事件时序缺陷：
 *    在 WebKit 内核中，按回车确认合成时，`compositionend` 会先于 `keydown` 触发，
 *    导致随后的 `keydown` 事件中 `e.nativeEvent.isComposing` 已经提前被置为 false。
 *    通过时间戳微阈值（< 50ms）与 ref 双重锁机制，精准识别并拦截该次级联回车。
 * 3. 当用户不在输入法合成态中正常按下回车（且非 Shift+Enter）时，触发发送并阻止默认换行。
 * 4. 用户按下 Shift+Enter 时，正常放行原生换行行为。
 */
export function useImeInput<T extends HTMLElement = HTMLTextAreaElement>(
  options: UseImeInputOptions<T> = {}
) {
  const { onEnter, preventDefault = true, onKeyDown } = options;

  const isComposingRef = useRef(false);
  const compositionEndTimeRef = useRef(0);

  const handleCompositionStart = useCallback((_e: React.CompositionEvent<T>) => {
    isComposingRef.current = true;
  }, []);

  const handleCompositionEnd = useCallback((_e: React.CompositionEvent<T>) => {
    compositionEndTimeRef.current = Date.now();
    // 延迟重置 ref，确保在 Safari 紧随其后的 keydown 宏任务/事件派发中，ref 也能起到兜底保护
    setTimeout(() => {
      isComposingRef.current = false;
    }, 50);
  }, []);

  const isComposing = useCallback((e: React.KeyboardEvent<T>): boolean => {
    // 1. 标准 nativeEvent.isComposing（Chromium / Firefox / W3C 标准）
    if (e.nativeEvent?.isComposing) {
      return true;
    }
    // 2. React 合成事件层上的 isComposing
    if ((e as unknown as { isComposing?: boolean }).isComposing) {
      return true;
    }
    // 3. 本地 ref 追踪状态（从 compositionstart 到 compositionend）
    if (isComposingRef.current) {
      return true;
    }
    // 4. 输入法合成专用 keyCode 229（Process）
    if (e.keyCode === 229 || e.which === 229) {
      return true;
    }
    // 5. Safari/WebKit 缺陷防御：在 WebKit 内核中，按回车确认合成时，
    //    compositionend 会先于 keydown(Enter) 触发，导致 keydown 到达时 isComposing 已为 false。
    //    由同一次回车物理按键级联触发的 compositionend 与 keydown 时间间隔通常在 0~2ms 内。
    //    这里设置 50ms 阈值可 100% 拦截该次非预期的发送，同时绝不影响后续正常回车发送。
    if (Date.now() - compositionEndTimeRef.current < 50) {
      return true;
    }
    return false;
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<T>) => {
      // 透传自定义 onKeyDown 处理
      onKeyDown?.(e);
      if (e.defaultPrevented) {
        return;
      }

      // 如果处于输入法合成状态或刚结束合成（确认候选词/直接上屏），
      // 绝对不作为发送消息的回车，直接放行让输入法完成文字上屏。
      if (isComposing(e)) {
        return;
      }

      // 单独回车（且非 Shift+Enter 换行）
      if (e.key === 'Enter' && !e.shiftKey) {
        if (preventDefault) {
          e.preventDefault();
        }
        onEnter?.(e);
      }
    },
    [isComposing, onEnter, preventDefault, onKeyDown]
  );

  return {
    isComposing,
    handleCompositionStart,
    handleCompositionEnd,
    handleKeyDown,
    imeBindings: {
      onKeyDown: handleKeyDown,
      onCompositionStart: handleCompositionStart,
      onCompositionEnd: handleCompositionEnd,
    },
  };
}
