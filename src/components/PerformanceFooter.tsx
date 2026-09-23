import React from 'react';
import { TurnMetrics } from '../types/chat';
import { Zap, Clock, Cpu } from 'lucide-react';

interface PerformanceFooterProps {
  metrics?: TurnMetrics;
  turnCount?: number;
}

export const PerformanceFooter: React.FC<PerformanceFooterProps> = ({
  metrics,
  turnCount = 0,
}) => {
  if (!metrics) {
    return (
      <div className="mt-2 text-center text-[11px] text-[#717682] select-none flex items-center justify-center gap-2">
        <span>Enter 发送，Shift + Enter 换行 · 支持粘贴截图 (Cmd + V) 或拖入图片</span>
      </div>
    );
  }

  const formatTokens = (val: number): string => {
    if (val >= 1000) return (val / 1000).toFixed(1) + 'K';
    return val.toString();
  };

  return (
    <div className="mt-2.5 flex items-center justify-center gap-4 text-[11.5px] text-[#7d8492] font-mono select-none">
      <div className="flex items-center gap-1.5">
        <Zap className="w-3.5 h-3.5 text-blue-400" />
        <span>
          {metrics.ttftMs > 0 ? `${metrics.ttftMs}ms TTFT` : ''}
          {metrics.tokensPerSecond > 0 ? ` · ${metrics.tokensPerSecond} tok/s` : ''}
        </span>
      </div>

      <div className="flex items-center gap-1.5">
        <Clock className="w-3.5 h-3.5 text-amber-400/80" />
        <span>{(metrics.decodeDurationMs / 1000).toFixed(2)}s 生成</span>
      </div>

      <div className="flex items-center gap-1.5">
        <Cpu className="w-3.5 h-3.5 text-purple-400/80" />
        <span>
          剩余 {formatTokens(metrics.contextRemaining)} / {formatTokens(metrics.maxContext)} tokens
          {turnCount > 0 ? ` · ${turnCount} 轮对话` : ''}
        </span>
      </div>
    </div>
  );
};
