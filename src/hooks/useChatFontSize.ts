import { useState, useEffect, useCallback } from 'react';

interface UseChatFontSizeOptions {
  storageKey: string;
  defaultSize: number;
  minSize?: number;
  maxSize?: number;
  step?: number;
}

/**
 * 独立管理对话内容字号的轻量 Hook：
 *   - 捕获 Cmd + / Cmd - / Cmd 0 快捷键；
 *   - 独立持久化到 localStorage（大窗口与小窗口互不影响）；
 *   - 仅调节对话内容区域（通过 CSS 变量 --chat-font-size），侧边栏/输入框/顶部工具栏等毫不受影响。
 */
export function useChatFontSize({
  storageKey,
  defaultSize = 15,
  minSize = 12,
  maxSize = 24,
  step = 1,
}: UseChatFontSizeOptions) {
  const [fontSize, setFontSize] = useState<number>(() => {
    try {
      const saved = localStorage.getItem(storageKey);
      if (saved) {
        const parsed = parseFloat(saved);
        if (!isNaN(parsed) && parsed >= minSize && parsed <= maxSize) {
          return parsed;
        }
      }
    } catch {}
    return defaultSize;
  });

  const updateFontSize = useCallback(
    (newSize: number) => {
      const clamped = Math.min(maxSize, Math.max(minSize, Math.round(newSize * 10) / 10));
      setFontSize(clamped);
      try {
        localStorage.setItem(storageKey, String(clamped));
      } catch {}
    },
    [storageKey, minSize, maxSize]
  );

  const zoomIn = useCallback(() => {
    setFontSize((prev) => {
      const next = Math.min(maxSize, prev + step);
      try {
        localStorage.setItem(storageKey, String(next));
      } catch {}
      return next;
    });
  }, [maxSize, step, storageKey]);

  const zoomOut = useCallback(() => {
    setFontSize((prev) => {
      const next = Math.max(minSize, prev - step);
      try {
        localStorage.setItem(storageKey, String(next));
      } catch {}
      return next;
    });
  }, [minSize, step, storageKey]);

  const resetZoom = useCallback(() => {
    setFontSize(defaultSize);
    try {
      localStorage.setItem(storageKey, String(defaultSize));
    } catch {}
  }, [defaultSize, storageKey]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // 必须包含 Command (Mac) 或 Ctrl (Windows/Linux)
      if (!e.metaKey && !e.ctrlKey) return;

      // ⌘ + 或 ⌘ =
      if (e.key === '=' || e.key === '+') {
        e.preventDefault();
        e.stopPropagation();
        zoomIn();
      }
      // ⌘ - 或 ⌘ _
      else if (e.key === '-' || e.key === '_') {
        e.preventDefault();
        e.stopPropagation();
        zoomOut();
      }
      // ⌘ 0 复位
      else if (e.key === '0') {
        e.preventDefault();
        e.stopPropagation();
        resetZoom();
      }
    };

    window.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true });
  }, [zoomIn, zoomOut, resetZoom]);

  return { fontSize, setFontSize: updateFontSize, zoomIn, zoomOut, resetZoom };
}
