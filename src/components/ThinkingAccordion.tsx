import React, { useState, useEffect, useRef } from 'react';
import { Brain, ChevronDown, ChevronRight, Loader2 } from 'lucide-react';
import { MarkdownRenderer } from './MarkdownRenderer';

interface ThinkingAccordionProps {
  content?: string;
  isThinking?: boolean;
  duration?: number;
}

export const ThinkingAccordion: React.FC<ThinkingAccordionProps> = ({
  content,
  isThinking = false,
  duration = 0,
}) => {
  const [isOpen, setIsOpen] = useState(isThinking);
  const prevIsThinkingRef = useRef(isThinking);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // Auto expand when thinking starts, and auto collapse when thinking finishes
  useEffect(() => {
    if (isThinking && !prevIsThinkingRef.current) {
      // Thinking started -> auto expand
      setIsOpen(true);
    } else if (!isThinking && prevIsThinkingRef.current) {
      // Thinking finished -> auto collapse
      setIsOpen(false);
    }
    prevIsThinkingRef.current = isThinking;
  }, [isThinking]);

  // While thinking, auto scroll to the latest line of thought
  useEffect(() => {
    if (isThinking && isOpen && scrollContainerRef.current) {
      scrollContainerRef.current.scrollTop = scrollContainerRef.current.scrollHeight;
    }
  }, [content, isThinking, isOpen]);

  if (!content && !isThinking) return null;

  return (
    <div className="my-2.5 rounded-xl border border-[#30333b] bg-[#1e2025]/80 overflow-hidden text-sm transition-all duration-200 shadow-sm">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="w-full flex items-center justify-between px-3.5 py-2 hover:bg-[#252830] transition-colors select-none text-left cursor-pointer"
      >
        <div className="flex items-center gap-2 text-xs font-medium text-[#9aa2b1]">
          {isThinking ? (
            <Loader2 className="w-3.5 h-3.5 text-blue-400 animate-spin" />
          ) : (
            <Brain className="w-3.5 h-3.5 text-indigo-400" />
          )}
          <span>
            {isThinking
              ? '正在深度思考中...'
              : `思考过程 ${duration > 0 ? `(${duration.toFixed(1)} 秒)` : ''}`}
          </span>
        </div>
        <div className="text-[#757c8a]">
          {isOpen ? (
            <ChevronDown className="w-3.5 h-3.5" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5" />
          )}
        </div>
      </button>

      {isOpen && (
        <div
          ref={scrollContainerRef}
          className="px-3.5 pb-3 pt-2 text-xs border-t border-[#292c34] bg-[#17181c]/70 max-h-96 overflow-y-auto select-text"
        >
          {content ? (
            <MarkdownRenderer
              content={content}
              className="markdown-thinking text-xs leading-relaxed"
            />
          ) : (
            <span className="text-zinc-500 italic">组织思绪中...</span>
          )}
          {isThinking && (
            <span className="inline-block w-1.5 h-3 ml-1 bg-blue-400 animate-pulse align-middle" />
          )}
        </div>
      )}
    </div>
  );
};
