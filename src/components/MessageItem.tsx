import React, { useState } from 'react';
import { ChatMessage } from '../types/chat';
import { useI18n } from '../i18n';
import { MarkdownRenderer } from './MarkdownRenderer';
import { ThinkingAccordion } from './ThinkingAccordion';
import { Check, Copy, AlertCircle, BookOpen, ExternalLink } from 'lucide-react';

interface MessageItemProps {
  message: ChatMessage;
  onOpenWiki?: (title: string) => void;
}

export const MessageItem: React.FC<MessageItemProps> = ({ message, onOpenWiki }) => {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const isUser = message.role === 'user';

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      console.error('Failed to copy message:', e);
    }
  };

  return (
    <div className={`py-3 w-full flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      {isUser ? (
        /* User Message: Rounded pill bubble on the right (Qianwen Style) */
        <div className="max-w-[85%] lg:max-w-[75%] rounded-[20px] px-4 py-2.5 bg-[#e9ebf0] text-[#1f2328] dark:bg-[#2d3037] dark:text-[#f1f3f7] border border-black/5 dark:border-white/5 shadow-sm">
          {/* User image attachments */}
          {message.images && message.images.length > 0 && (
            <div className="flex flex-wrap gap-2 mb-2">
              {message.images.map((imgUrl, i) => (
                <img
                  key={i}
                  src={imgUrl}
                  alt={`upload-${i}`}
                  className="max-w-[240px] max-h-[240px] rounded-xl object-cover border border-black/10 dark:border-white/10 shadow-sm"
                />
              ))}
            </div>
          )}
          <div className="whitespace-pre-wrap text-[15px] leading-relaxed">
            {message.content}
          </div>
        </div>
      ) : (
        /* Assistant Message: Clean full-width flow on the left (Qianwen Style) */
        <div className="w-full text-[#1f2328] dark:text-[#ecedf1]">
          {/* Thinking Process Accordion */}
          {(message.reasoningContent || message.isThinking) && (
            <ThinkingAccordion
              content={message.reasoningContent}
              isThinking={message.isThinking}
              duration={message.thinkingDuration}
            />
          )}

          {/* Assistant Text / Markdown / KaTeX */}
          <div className="text-[15px] leading-relaxed">
            {message.content ? (
              <MarkdownRenderer content={message.content} />
            ) : message.isThinking ? (
              <span className="text-xs text-zinc-500 italic">{t('thinkingNotice')}</span>
            ) : null}
          </div>

          {/* Error Message notice if any */}
          {message.error && (
            <div className="mt-2.5 flex items-center gap-1.5 text-xs text-red-500 dark:text-red-400 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800/50 px-3 py-2 rounded-xl">
              <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" />
              <span>{message.error}</span>
            </div>
          )}

          {/* Offline Wiki Citations */}
          {message.citations && message.citations.length > 0 && (
            <div className="mt-3 flex flex-wrap items-center gap-1.5 select-none animate-in fade-in duration-200">
              <span className="text-[11px] font-medium text-zinc-400 dark:text-zinc-500 mr-1 flex items-center gap-1">
                <BookOpen className="w-3.5 h-3.5 text-emerald-500" />
                {t('wikiCitations')}:
              </span>
              {message.citations.map((c, idx) => (
                <button
                  key={idx}
                  onClick={() => onOpenWiki?.(c.title)}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-700 dark:text-emerald-300 border border-emerald-500/20 transition-all hover:scale-[1.02] active:scale-[0.98]"
                  title={c.summary || c.title}
                >
                  <span className="font-medium truncate max-w-[200px]">{c.title}</span>
                  <ExternalLink className="w-3 h-3 opacity-60" />
                </button>
              ))}
            </div>
          )}

          {/* Assistant Message Footer: ONLY "复制" button + Gray Prefill and Speed Metrics */}
          {message.content && !message.isThinking && (
            <div className="mt-2.5 flex items-center gap-3 select-none">
              {/* Only "复制" button */}
              <button
                onClick={handleCopy}
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs text-zinc-500 hover:text-zinc-900 hover:bg-black/5 dark:text-zinc-400 dark:hover:text-white dark:hover:bg-white/5 transition-colors"
                title={t('copyTooltip')}
              >
                {copied ? (
                  <>
                    <Check className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
                    <span className="text-emerald-600 dark:text-emerald-400 text-xs">{t('copied')}</span>
                  </>
                ) : (
                  <>
                    <Copy className="w-3.5 h-3.5" />
                    <span className="text-xs">{t('copy')}</span>
                  </>
                )}
              </button>

              {/* Next to "复制" button: Gray Prefill & tok/s Metrics */}
              {message.metrics && (
                <span className="text-xs font-mono text-zinc-500 dark:text-zinc-400">
                  Prefill {message.metrics.ttftMs}ms · {message.metrics.tokensPerSecond} tok/s
                </span>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
