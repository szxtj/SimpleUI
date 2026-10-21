import { useEffect, useState } from 'react';

/**
 * 「遮罩淡出」状态机：活动结束时不要立刻卸载，而是先等 `delayMs` 再淡出 `durationMs`。
 *
 * 延时口径与主窗口原生遮罩 (`ResizeOverlayView.hideAnimated`) 一致：
 * 位移停止后内容还要重新适配（重排 + Markdown 重渲染），遮罩必须盖到它做完为止，
 * 否则会看到"内容还在跳、遮罩先没了"。
 */
export function useFadeOverlay(active: boolean, delayMs = 120, durationMs = 280) {
  const [mounted, setMounted] = useState(active);
  /** 不透明度开关：结束时先**保持不透明** delayMs，再开始淡出（native 的 hideAnimated 就是这样） */
  const [visible, setVisible] = useState(active);

  useEffect(() => {
    if (active) {
      setMounted(true);
      setVisible(true);
      return;
    }
    if (!mounted) return;

    // ① 先完整盖住 delayMs：给内容在遮罩底下完成那一次重排
    const holdTimer = setTimeout(() => setVisible(false), delayMs);
    // ② 再淡出 durationMs 后卸载
    const unmountTimer = setTimeout(() => setMounted(false), delayMs + durationMs);
    return () => {
      clearTimeout(holdTimer);
      clearTimeout(unmountTimer);
    };
  }, [active, mounted, delayMs, durationMs]);

  return { mounted, visible, durationMs };
}
