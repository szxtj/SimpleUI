import React from 'react';
import { Brain, Zap } from 'lucide-react';
import { useI18n } from '../i18n';
import { ApiProvider } from '../types/chat';
import { isThinkingForced } from '../utils/providerCapabilities';

interface ThinkingToggleProps {
  /** 当前对话用的是哪个 provider —— 决定这个开关是否可点 */
  provider?: ApiProvider;
  /** 当前会话的思考开关状态 */
  thinking: boolean;
  onToggle: (next: boolean) => void;
  /** 浮窗用的紧凑尺寸（字号/内边距略小） */
  compact?: boolean;
  className?: string;
}

/**
 * 思考开关（主窗口与浮窗共用同一份实现）。
 *
 * 为什么抽成组件：主窗 1 处、浮窗 2 处（胶囊态 / 展开态）原本各写一份一模一样的 JSX，
 * 加「Maple 强制思考」时只改了一处，另外两处就漏了。现在锁定判定与视觉都只有这一份，
 * 不可能再出现「大窗锁了、小窗还能点」。
 */
export const ThinkingToggle: React.FC<ThinkingToggleProps> = ({
  provider,
  thinking,
  onToggle,
  compact = false,
  className = '',
}) => {
  const { t } = useI18n();
  const locked = isThinkingForced(provider);
  // 强制思考的引擎：无论会话里存的是什么，都按「开」显示
  const on = locked ? true : thinking;

  const size = compact ? 'px-2.5 py-1' : 'px-2 cq-md:px-3 py-1.5';
  const base = `flex items-center gap-1.5 ${size} rounded-full text-xs font-medium transition-all border flex-shrink-0`;

  const tone = locked
    ? 'bg-blue-50/70 text-blue-700 border-blue-200/70 dark:bg-blue-950/50 dark:text-blue-300 dark:border-blue-500/30 cursor-not-allowed opacity-80'
    : on
    ? 'bg-blue-50 text-blue-700 border-blue-200 hover:bg-blue-100 dark:bg-blue-950/70 dark:text-blue-300 dark:border-blue-500/40 dark:hover:bg-blue-900/80 shadow-sm active:scale-95'
    : 'bg-black/5 text-zinc-600 border-black/5 hover:bg-black/10 hover:text-black dark:bg-white/5 dark:text-zinc-300 dark:border-white/5 dark:hover:bg-white/10 dark:hover:text-white active:scale-95';

  return (
    <button
      type="button"
      onClick={() => {
        if (locked) return;
        onToggle(!thinking);
      }}
      aria-disabled={locked}
      title={locked ? t('thinkingLockedMaple') : on ? t('thinkingOnTooltip') : t('thinkingOffTooltip')}
      className={`${base} ${tone} ${className}`}
    >
      {on ? (
        <>
          <Brain className="w-3.5 h-3.5 text-blue-500 dark:text-blue-400" />
          <span className={compact ? '' : 'hidden cq-md:inline'}>{t('thinkingOn')}</span>
        </>
      ) : (
        <>
          <Zap className="w-3.5 h-3.5 text-amber-500 dark:text-amber-400" />
          <span className={compact ? '' : 'hidden cq-md:inline'}>{t('thinkingOff')}</span>
        </>
      )}
    </button>
  );
};
