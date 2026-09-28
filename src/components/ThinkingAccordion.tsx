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
 * 思考过程折叠区（现代聊天式样，参考 Claude/GPT 的思考条）：
 *   - 折叠态只有一行：小图标 + 「深度思考 · Ns」（进行中/结束后同款，仅图标与时长的值不同）
 *     + 右向箭头，无边框无底色
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

  // Auto expand when thinking starts, and auto collapse when thinking finishes
  useEffect(() => {
    setIsOpen(isThinking);
  }, [isThinking]);

  /**
   * 思考内容跟随滚动 —— 与两个窗口的消息流**共用同一份 hook**：
   * 思考中每帧钉在最底部；**用户一旦手动滚动（滚轮/触摸/键盘/拖滚动条），本轮立即彻底停止自动聚焦**，
   * 不再"滚回底部又自动恢复"（那样会让正在读前文的用户被反复拽动、界面抖动）。
   * 重新展开思考条（active 由 false 变 true）时重新开始跟随。
   */
  const { containerProps: boxProps } = useFollowBottom(isThinking && isOpen);

  if (!content && !isThinking) return null;

  // 思考中把"细光标"字符直接拼到最后一个 token 后面——它会随文本自然移动，
  // 真正落在正在生成的位置；而不是作为独立块挂在容器底部（那样永远在左下角，非常突兀）。
  const CURSOR = '▏'; // U+258F LEFT ONE EIGHTH BLOCK：比常规光标细
  const displayContent =
    isThinking && content ? content.replace(/\n+$/, '') + CURSOR : content;

  // 进行中 / 结束后**共用同一格式**（与阶段阶梯汇总行同款语法）：
  //   进行中（转圈）: 深度思考 · 1.4s（时长随思考块实时跳动）
  //   结束后（✦）  : 深度思考 · 3.2s
  const headerText = `${t('thinkingLabel')} · ${Math.max(0, duration).toFixed(1)}s`;

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

      {/* 展开内容：左侧细竖线 + 弱化文字；生成中由 useFollowBottom 每帧钉在底部，
          用户一滚即交还控制权（本轮不再自动聚焦）。
          `[overflow-anchor:none]`：关掉浏览器的滚动锚定——流式追加时它会把视口锚在旧位置，
          正是"用户滚到最后一行却被滚回去"的元凶。 */}
      {isOpen && (
        <div
          {...boxProps}
          className="mt-1.5 mb-1 ml-[7px] pl-3.5 border-l-2 border-black/[0.07] dark:border-white/[0.09] max-h-48 overflow-y-auto select-text [overflow-anchor:none]"
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
