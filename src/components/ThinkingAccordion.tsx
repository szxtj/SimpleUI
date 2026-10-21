import React, { useState, useEffect } from 'react';
import { ChevronRight, Loader2, Sparkles } from 'lucide-react';
import { useI18n } from '../i18n';
import { useFollowBottom } from '../hooks/useFollowBottom';
import { MarkdownRenderer } from './MarkdownRenderer';

interface ThinkingAccordionProps {
  content?: string;
  isThinking?: boolean;
  duration?: number;
}

/**
 * 思考过程折叠区（手风琴式独立滚动容器）：
 *   - 折叠态：小图标 + 「深度思考 · Ns」+ 右向箭头（保持 select-none）
 *   - 展开态：内容以左侧细竖线 + 弱化文字呈现（开放 selectable-chat-content 支持自由划选与复制 Markdown 原文）
 * 思考中自动展开并向下跟随滚动；用户手动向上滚动时释放，再次滚回贴底后自动恢复跟随；思考结束后自动折叠。
 */
export const ThinkingAccordion: React.FC<ThinkingAccordionProps> = ({
  content,
  isThinking = false,
  duration = 0,
}) => {
  const { t } = useI18n();
  const [isOpen, setIsOpen] = useState(isThinking);

  // Auto expand when thinking starts, and auto collapse when thinking finishes
  useEffect(() => {
    setIsOpen(isThinking);
  }, [isThinking]);

  const { containerProps: boxProps } = useFollowBottom(isThinking && isOpen);

  if (!content && !isThinking) return null;

  const CURSOR = '▏';
  const displayContent =
    isThinking && content ? content.replace(/\n+$/, '') + CURSOR : content;

  const headerText = `${t('thinkingLabel')} · ${Math.max(0, duration).toFixed(1)}s`;

  return (
    <div className="my-2.5 text-sm select-none">
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="w-full flex items-center gap-2 group/select text-left cursor-pointer select-none"
      >
        {isThinking ? (
          <Loader2 className="w-4 h-4 text-blue-500 dark:text-blue-400 animate-spin flex-shrink-0" />
        ) : (
          <Sparkles className="w-4 h-4 text-blue-500 dark:text-blue-400 flex-shrink-0" />
        )}
        <span
          className={`text-[13px] font-medium transition-colors ${
            isThinking
              ? 'text-blue-600 dark:text-blue-400'
              : 'text-zinc-500 dark:text-zinc-400 group-hover/select:text-zinc-700 dark:group-hover/select:text-zinc-300'
          }`}
        >
          {headerText}
        </span>
        <ChevronRight
          className={`w-4 h-4 text-zinc-400 dark:text-zinc-500 transition-transform duration-200 ${
            isOpen ? 'rotate-90' : ''
          }`}
        />
      </button>

      {isOpen && (
        <div
          {...boxProps}
          data-chat-inner-scroll="true"
          className="mt-1.5 mb-1 ml-[7px] pl-3.5 border-l-2 border-black/[0.07] dark:border-white/[0.09] max-h-48 overflow-y-auto overscroll-contain selectable-chat-content cursor-text [overflow-anchor:none]"
        >
          {displayContent ? (
            <MarkdownRenderer
              content={displayContent}
              className="markdown-thinking text-xs leading-relaxed text-zinc-600 dark:text-zinc-400"
            />
          ) : (
            <span className="text-xs text-zinc-500 italic select-none">
              {t('organizingThoughts')}
            </span>
          )}
        </div>
      )}
    </div>
  );
};
