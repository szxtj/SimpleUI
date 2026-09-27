import React, { useState, useEffect, useRef } from 'react';
import { ChevronRight, Loader2, Sparkles } from 'lucide-react';
import { useI18n } from '../i18n';
import { MarkdownRenderer } from './MarkdownRenderer';

interface ThinkingAccordionProps {
  content?: string;
  isThinking?: boolean;
  duration?: number;
}

/**
 * 思考过程折叠区（现代聊天式样，参考 Claude/GPT 的思考条）：
 *   - 折叠态只有一行：小图标 + 「思考了 N 秒」+ 右向箭头，无边框无底色
 *   - 展开态：内容以左侧细竖线 + 弱化文字呈现，不再是"框中框"
 * 思考中自动展开并跟随滚动；结束后自动折叠。
 */
export const ThinkingAccordion: React.FC<ThinkingAccordionProps> = ({
  content,
  isThinking = false,
  duration = 0,
}) => {
  const { t } = useI18n();
  const [isOpen, setIsOpen] = useState(isThinking);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  // 用户是否"贴底"：只有贴底时才跟随滚动；一旦手动上滚就停止，不与用户抢滚动条
  const pinnedRef = useRef(true);

  // Auto expand when thinking starts, and auto collapse when thinking finishes
  useEffect(() => {
    setIsOpen(isThinking);
  }, [isThinking]);

  // While thinking, keep the latest line of thought in view —
  // 节流到每帧一次（rAF），且只在贴底时跟随：避免每个 token 都强制滚动把整个界面带着抖。
  useEffect(() => {
    if (!isThinking || !isOpen) return;
    const el = scrollContainerRef.current;
    if (!el || !pinnedRef.current) return;
    const id = requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
    return () => cancelAnimationFrame(id);
  }, [content, isThinking, isOpen]);

  if (!content && !isThinking) return null;

  // 思考中把"细光标"字符直接拼到最后一个 token 后面——它会随文本自然移动，
  // 真正落在正在生成的位置；而不是作为独立块挂在容器底部（那样永远在左下角，非常突兀）。
  const CURSOR = '▏'; // U+258F LEFT ONE EIGHTH BLOCK：比常规光标细
  const displayContent =
    isThinking && content ? content.replace(/\n+$/, '') + CURSOR : content;

  const headerText = isThinking
    ? t('thinkingActive')
    : `${t('thoughtForPrefix')} ${duration > 0 ? duration.toFixed(1) : '0'} ${t('seconds')}`;

  return (
    <div className="my-2.5 text-sm">
      {/* 头部行：无边框，靠留白和层级表达 */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="w-full flex items-center gap-2 py-0.5 group/select text-left cursor-pointer select-none"
      >
        {isThinking ? (
          <Loader2 className="w-4 h-4 text-blue-500 dark:text-blue-400 animate-spin flex-shrink-0" />
        ) : (
          <Sparkles className="w-4 h-4 text-indigo-400 dark:text-indigo-300 flex-shrink-0" />
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

      {/* 展开内容：左侧细竖线 + 弱化文字；最大高度减半，滚动只在贴底时跟随 */}
      {isOpen && (
        <div
          ref={scrollContainerRef}
          onScroll={() => {
            const el = scrollContainerRef.current;
            if (!el) return;
            pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
          }}
          className="mt-1.5 mb-1 ml-[7px] pl-3.5 border-l-2 border-black/[0.07] dark:border-white/[0.09] max-h-48 overflow-y-auto select-text"
        >
          {displayContent ? (
            <MarkdownRenderer
              content={displayContent}
              className="markdown-thinking text-xs leading-relaxed text-zinc-600 dark:text-zinc-400"
            />
          ) : (
            <span className="text-xs text-zinc-500 italic">{t('organizingThoughts')}</span>
          )}
          {/* 光标以「细块字符」直接拼在内容末尾（见上方 displayContent），
              因此它随文本自然移动、真正落在正在生成的 token 后面，
              而不是像旧实现那样作为独立元素挂在容器底部（永远停在左下角） */}
        </div>
      )}
    </div>
  );
};
