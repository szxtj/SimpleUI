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
    isComposingRef.current = false;
    compositionEndTimeRef.current = Date.now();
  }, []);

  const handleBlur = useCallback((_e: React.FocusEvent<T>) => {
    isComposingRef.current = false;
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
    // 3. 输入法合成专用 keyCode 229（Process）
    if (e.keyCode === 229 || e.which === 229) {
      return true;
    }
    // 4. Safari/WebKit 缺陷防御：在 WebKit 内核中，按回车确认合成时，
    //    compositionend 会先于 keydown(Enter) 触发，导致 keydown 到达时 isComposing 已为 false。
    //    由同一次回车物理按键级联触发的 compositionend 与 keydown 时间间隔通常在 0~5ms 内。
    if (Date.now() - compositionEndTimeRef.current < 60) {
      return true;
    }
    // 5. 若底层事件已明确不在合成态且距离上次 compositionend 超过 60ms，
    //    自动清理可能因组件卸载/焦点切换而残留的 isComposingRef 锁，防止回车永久失效变换行。
    if (isComposingRef.current) {
      isComposingRef.current = false;
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

      const nativeComposing =
        Boolean(e.nativeEvent?.isComposing) ||
        Boolean((e as unknown as { isComposing?: boolean }).isComposing) ||
        e.keyCode === 229 ||
        e.which === 229;

      // 正在输入法合成中：完全放行给系统输入法处理
      if (nativeComposing) {
        return;
      }

      // WebKit/Safari 特有时序：按回车确认英文/拼音上屏时，compositionend 先于 keydown(Enter) 触发。
      // 此时候选词已经由 compositionend 提交上屏，紧随其后的这次级联 keydown(Enter) 既不能触发发送，
      // 也必须 preventDefault() 阻止 <textarea> 插入多余的换行符！
      if (Date.now() - compositionEndTimeRef.current < 60) {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
        }
        return;
      }

      isComposingRef.current = false;

      // 单独回车（且非 Shift+Enter 换行）：触发发送并阻止换行
      if (e.key === 'Enter' && !e.shiftKey) {
        if (preventDefault) {
          e.preventDefault();
        }
        onEnter?.(e);
      }
    },
    [onEnter, preventDefault, onKeyDown]
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
      onBlur: handleBlur,
    },
  };
}
