import React, { useState } from 'react';
import { ChatMessage } from '../types/chat';
import { MarkdownRenderer } from './MarkdownRenderer';
import { ThinkingAccordion } from './ThinkingAccordion';
import { Check, Copy, AlertCircle } from 'lucide-react';

interface MessageItemProps {
  message: ChatMessage;
}

export const MessageItem: React.FC<MessageItemProps> = ({ message }) => {
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
        <div className="max-w-[85%] lg:max-w-[75%] rounded-[20px] px-4 py-2.5 bg-[#2d3037] text-[#f1f3f7] border border-white/5 shadow-sm">
          {/* User image attachments */}
          {message.images && message.images.length > 0 && (
            <div className="flex flex-wrap gap-2 mb-2">
              {message.images.map((imgUrl, i) => (
                <img
                  key={i}
                  src={imgUrl}
                  alt={`upload-${i}`}
                  className="max-w-[240px] max-h-[240px] rounded-xl object-cover border border-white/10 shadow-sm"
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
        <div className="w-full text-[#ecedf1]">
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
              <span className="text-xs text-zinc-500 italic">正在思考...</span>
            ) : null}
          </div>

          {/* Error Message notice if any */}
          {message.error && (
            <div className="mt-2.5 flex items-center gap-1.5 text-xs text-red-400 bg-red-950/40 border border-red-800/50 px-3 py-2 rounded-xl">
              <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" />
              <span>{message.error}</span>
            </div>
          )}

          {/* Assistant Message Footer: ONLY "复制" button + Gray Prefill and Speed Metrics */}
          {message.content && !message.isThinking && (
            <div className="mt-2.5 flex items-center gap-3 select-none">
              {/* Only "复制" button */}
              <button
                onClick={handleCopy}
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs text-zinc-400 hover:text-white hover:bg-white/5 transition-colors"
                title="复制回复"
              >
                {copied ? (
                  <>
                    <Check className="w-3.5 h-3.5 text-emerald-400" />
                    <span className="text-emerald-400 text-xs">已复制</span>
                  </>
                ) : (
                  <>
                    <Copy className="w-3.5 h-3.5" />
                    <span className="text-xs">复制</span>
                  </>
                )}
              </button>

              {/* Next to "复制" button: Gray Prefill & tok/s Metrics */}
              {message.metrics && (
                <span className="text-xs font-mono text-zinc-500">
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
