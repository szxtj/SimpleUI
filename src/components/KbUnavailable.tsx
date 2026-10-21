import React from 'react';
import { BookX } from 'lucide-react';
import { useI18n } from '../i18n';

/**
 * 知识库不可用（服务总开关关闭 / 未就绪 / DeepSeek 模式）时的统一提醒。
 *
 * 主窗口的搜索页、条目页与 Spotlight 的整页视图都渲染**这同一份**，
 * 保证「为什么看不了」在任何入口都是同一句话、同一个样子。
 */
export const KbUnavailable: React.FC<{ wikiEnabled?: boolean; className?: string }> = ({
  wikiEnabled = true,
  className = '',
}) => {
  const { t } = useI18n();
  return (
    <div
      className={`flex flex-col items-center justify-center min-h-[240px] text-zinc-400 dark:text-zinc-500 text-xs px-8 py-10 text-center gap-3 ${className}`}
    >
      <div className="w-12 h-12 rounded-2xl bg-amber-500/10 text-amber-500 flex items-center justify-center">
        <BookX className="w-5 h-5" />
      </div>
      <span className="max-w-[260px] leading-relaxed">
        {wikiEnabled ? t('wikiPanelNotReady') : t('wikiPanelServiceOff')}
      </span>
    </div>
  );
};
