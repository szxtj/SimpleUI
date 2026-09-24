import React from 'react';
import { TurnMetrics } from '../types/chat';
import { useI18n } from '../i18n';
import { Zap, Clock, Cpu } from 'lucide-react';

interface PerformanceFooterProps {
  metrics?: TurnMetrics;
  turnCount?: number;
}

export const PerformanceFooter: React.FC<PerformanceFooterProps> = ({
  metrics,
  turnCount = 0,
}) => {
  const { t } = useI18n();

  if (!metrics) {
    return (
      <div className="mt-2 text-center text-[11px] text-zinc-500 dark:text-[#717682] select-none flex items-center justify-center gap-2">
        <span>{t('shortcutHint')}</span>
      </div>
    );
  }

  const formatTokens = (val: number): string => {
    if (val >= 1000) return (val / 1000).toFixed(1) + 'K';
    return val.toString();
  };

  return (
    <div className="mt-2.5 flex items-center justify-center gap-4 text-[11.5px] text-zinc-500 dark:text-[#7d8492] font-mono select-none">
      <div className="flex items-center gap-1.5">
        <Zap className="w-3.5 h-3.5 text-blue-400" />
        <span>
          {metrics.ttftMs > 0 ? `${metrics.ttftMs}ms TTFT` : ''}
          {metrics.tokensPerSecond > 0 ? ` · ${metrics.tokensPerSecond} tok/s` : ''}
        </span>
      </div>

      <div className="flex items-center gap-1.5">
        <Clock className="w-3.5 h-3.5 text-amber-400/80" />
        <span>{(metrics.decodeDurationMs / 1000).toFixed(2)}s {t('generation')}</span>
      </div>

      <div className="flex items-center gap-1.5">
        <Cpu className="w-3.5 h-3.5 text-purple-400/80" />
        <span>
          {t('remainingTokens')} {formatTokens(metrics.contextRemaining)} / {formatTokens(metrics.maxContext)} tokens
          {turnCount > 0 ? ` · ${turnCount} ${t('turnCount')}` : ''}
        </span>
      </div>
    </div>
  );
};
