import React, { useState } from 'react';
import { useI18n } from '../i18n';

interface ContextRingProps {
  usedTokens: number;
  maxContext: number;
  placement?: 'top' | 'bottom' | 'left';
  showRemainingPercent?: boolean;
}

export const ContextRing: React.FC<ContextRingProps> = ({
  usedTokens,
  maxContext,
  placement = 'top',
  showRemainingPercent = false,
}) => {
  const { t } = useI18n();
  const [showTooltip, setShowTooltip] = useState(false);

  const safeMax = Math.max(1, maxContext || 32768);
  const safeUsed = Math.max(0, usedTokens || 0);
  const percent = Math.min(100, (safeUsed / safeMax) * 100);
  const remaining = Math.max(0, safeMax - safeUsed);
  const remainingPercent = Math.max(0, 100 - percent);

  // SVG ring parameters (sleek 22px ring)
  const size = 22;
  const strokeWidth = 2.4;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const strokeDashoffset = circumference - (percent / 100) * circumference;

  // Ring color depending on consumption
  let progressColor = '#9ca3af'; // elegant zinc gray
  if (percent > 90) {
    progressColor = '#ef4444'; // Red warning
  } else if (percent > 75) {
    progressColor = '#f59e0b'; // Amber caution
  } else if (percent > 30) {
    progressColor = '#60a5fa'; // Blue active
  }

  const formatTokens = (val: number): string => {
    if (val >= 1000) {
      return (val / 1000).toFixed(1) + 'K';
    }
    return val.toLocaleString();
  };

  const getPlacementClass = () => {
    switch (placement) {
      case 'left':
        return 'right-full top-1/2 -translate-y-1/2 mr-2.5';
      case 'bottom':
        return 'top-full right-0 mt-2.5';
      case 'top':
      default:
        return 'bottom-full right-0 mb-2.5';
    }
  };

  return (
    <div
      className="relative flex items-center justify-center cursor-pointer select-none p-1"
      onMouseEnter={() => setShowTooltip(true)}
      onMouseLeave={() => setShowTooltip(false)}
      aria-label={`${t('contextOccupancy')} ${percent.toFixed(1)}%`}
    >
      <div className="flex items-center gap-1.5">
        <svg width={size} height={size} className="transform -rotate-90 shrink-0">
          {/* Background track circle */}
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="transparent"
            strokeWidth={strokeWidth}
            className="stroke-black/15 dark:stroke-[#383a42]"
          />
          {/* Active progress arc */}
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="transparent"
            stroke={progressColor}
            strokeWidth={strokeWidth}
            strokeDasharray={circumference}
            strokeDashoffset={strokeDashoffset}
            strokeLinecap="round"
            className="transition-all duration-300 ease-out"
          />
        </svg>

        {showRemainingPercent && (
          <span className="text-[11px] font-mono font-medium tracking-tight text-zinc-500 dark:text-zinc-400 select-none tabular-nums leading-none">
            {remainingPercent >= 99.95 ? '100%' : `${remainingPercent.toFixed(1)}%`}
          </span>
        )}
      </div>

      {/* Floating Detailed Context Tooltip */}
      {showTooltip && (
        <div className={`absolute ${getPlacementClass()} z-50 pointer-events-none`}>
          <div className="bg-white dark:bg-[#1e2025] text-zinc-900 dark:text-white text-[11px] font-sans px-3 py-2 rounded-xl shadow-2xl border border-black/10 dark:border-white/10 whitespace-nowrap animate-in fade-in zoom-in-95">
            <div className="flex items-center gap-2 mb-1">
              <span
                className="w-2 h-2 rounded-full"
                style={{ backgroundColor: progressColor }}
              />
              <span className="font-semibold text-zinc-800 dark:text-zinc-200">
                {t('contextRemaining')}: {formatTokens(remaining)} {t('tokens')}
              </span>
            </div>
            <div className="text-zinc-500 dark:text-zinc-400 font-mono text-[10px]">
              {t('contextUsed')} {safeUsed.toLocaleString()} / {safeMax.toLocaleString()} ({percent.toFixed(1)}%)
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
