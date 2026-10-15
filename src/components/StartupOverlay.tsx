import React, { useState, useEffect, useRef } from 'react';
import { useI18n } from '../i18n';
import { Loader2, Check } from 'lucide-react';

export interface StartupOverlayProps {
  onFinished: () => void;
}

export const StartupOverlay: React.FC<StartupOverlayProps> = ({ onFinished }) => {
  const { t } = useI18n();
  const [isFading, setIsFading] = useState(false);
  const [isPortReady, setIsPortReady] = useState(false);
  const onFinishedRef = useRef(onFinished);
  onFinishedRef.current = onFinished;

  useEffect(() => {
    let finished = false;

    const finish = () => {
      if (finished) return;
      finished = true;
      setIsFading(true);
      setTimeout(() => {
        onFinishedRef.current();
      }, 400);
    };

    // 探测主界面服务端口（31235）
    const checkPort = async () => {
      try {
        const res = await fetch('/api/system/ping', { cache: 'no-store' });
        if (res.ok && !finished) {
          setIsPortReady(true);
          // 端口初始化就绪后，等待 0.5s（500ms），再渐变淡出
          setTimeout(finish, 500);
          return true;
        }
      } catch {
        // 端口正在初始化
      }
      return false;
    };

    checkPort();

    const interval = setInterval(async () => {
      if (finished) {
        clearInterval(interval);
        return;
      }
      const ok = await checkPort();
      if (ok) {
        clearInterval(interval);
      }
    }, 120);

    // 绝对安全兜底：最多 1.5 秒必须退出遮罩，绝不卡住用户
    const safety = setTimeout(finish, 1500);

    return () => {
      clearInterval(interval);
      clearTimeout(safety);
    };
  }, []);

  return (
    <div
      className={`fixed inset-0 z-50 flex flex-col items-center justify-center select-none bg-[#f8f9fb] dark:bg-[#18191c] text-[#1f2328] dark:text-[#f1f3f7] transition-opacity duration-400 ease-out ${
        isFading ? 'opacity-0 pointer-events-none' : 'opacity-100'
      }`}
      style={{
        width: '100vw',
        height: '100vh',
      }}
    >
      <div className="flex flex-col items-center max-w-sm w-full px-6 text-center">
        {/* 标题 */}
        <h1 className="text-3xl font-bold tracking-tight mb-2 text-zinc-900 dark:text-zinc-100">
          SimpleUI
        </h1>
        <p className="text-xs text-zinc-500 dark:text-zinc-400 mb-6 font-normal">
          {t('startupTagline')}
        </p>

        {/* 极简状态展示（无大图标，无卡片面板） */}
        <div className="flex items-center justify-center gap-2 h-6">
          {isPortReady ? (
            <>
              <Check className="w-4 h-4 text-emerald-500 flex-shrink-0" />
              <span className="text-xs font-medium text-emerald-600 dark:text-emerald-400">
                {t('startupReady')}
              </span>
            </>
          ) : (
            <>
              <Loader2 className="w-3.5 h-3.5 animate-spin text-blue-500 flex-shrink-0" />
              <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
                {t('startupInitializing')}
              </span>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
