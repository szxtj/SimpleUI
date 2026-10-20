import { useEffect, useState } from 'react';

/**
 * TTS 服务是否启用（服务管理面板的总开关）。
 * 关闭时，划选浮标与消息朗读按钮一并隐藏。
 */
let cached: boolean | null = null;

export function useTtsEnabled(): boolean {
  const [enabled, setEnabled] = useState(cached ?? true);

  useEffect(() => {
    let alive = true;
    const load = () => {
      fetch('/api/tts/status')
        .then((r) => r.json())
        .then((d) => {
          const next = d?.enabled !== false;
          cached = next;
          if (alive) setEnabled(next);
        })
        .catch(() => {});
    };
    load();
    const timer = window.setInterval(load, 15000);
    window.addEventListener('focus', load);
    return () => {
      alive = false;
      window.clearInterval(timer);
      window.removeEventListener('focus', load);
    };
  }, []);

  return enabled;
}
