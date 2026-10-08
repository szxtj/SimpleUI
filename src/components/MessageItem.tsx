import React, { useState } from 'react';
import { ChatMessage, TurnStageRecord } from '../types/chat';
import { useI18n } from '../i18n';
import { MarkdownRenderer } from './MarkdownRenderer';
import { ThinkingAccordion } from './ThinkingAccordion';
import { StageLadder } from './StageLadder';
import { Check, Copy, AlertCircle, BookOpen, ExternalLink, RotateCcw, Trash2, FileText } from 'lucide-react';
import { RawMarkdownModal } from './RawMarkdownModal';

interface MessageItemProps {
  message: ChatMessage;
  onOpenWiki?: (title: string, context?: string) => void;
  onRetry?: (messageId: string) => void;
  onDelete?: (messageId: string) => void;
  /** 用户气泡的重试目标：紧随其后的助手回复 id（与浮窗的用户气泡重试一致） */
  retryTargetId?: string;
  /** 本轮是否由**本窗口**负责生成（阶段阶梯只由生成方记录，镜像窗口只渲染） */
  turnRecording?: boolean;
  /** 阶段阶梯记录变化 → 回写消息（持久化 + 广播，两窗口共用同一条路径） */
  onStagesChange?: (messageId: string, stages: TurnStageRecord[]) => void;
}

export const MessageItem: React.FC<MessageItemProps> = ({
  message,
  onOpenWiki,
  onRetry,
  onDelete,
  retryTargetId,
  turnRecording,
  onStagesChange,
}) => {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const [showRawModal, setShowRawModal] = useState(false);
  const isUser = message.role === 'user';
  /**
   * 记录阶段阶梯的条件：本窗口生成中 + 本轮尚未收到任何 token
   * （检索 / 载入上下文两个阶段；首个思考或正文字符一到即收尾）。
   */
  const recordingStages =
    !!turnRecording && !!message.pending && !message.content && !message.reasoningContent && !message.error;
  /**
   * 阶段是否仍在进行 —— 只看消息自身的 pending（广播会把它同步到另一窗口），
   * 因此**两个窗口的展开/收起时机完全一致**：没结束就不收起，结束了就收起。
   */
  const phasesActive = !!message.pending && !message.error;

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
    <div className={`w-full ${isUser ? 'flex justify-end' : ''}`}>
      {isUser ? (
        /* User Message: Rounded pill bubble on the right with icon-only copy button below */
        <div className="flex flex-col items-end max-w-[90%] cq-md:max-w-[85%] cq-lg:max-w-[75%] group">
          <div className="rounded-[20px] px-3.5 cq-md:px-4 py-2 cq-md:py-2.5 bg-[#e9ebf0] text-[#1f2328] dark:bg-[#2d3037] dark:text-[#f1f3f7] border border-black/5 dark:border-white/5 shadow-sm">
            {/* User image attachments */}
            {message.images && message.images.length > 0 && (
              <div className="flex flex-wrap gap-2 mb-2">
                {message.images.map((imgUrl, i) => (
                  <img
                    key={i}
                    src={imgUrl}
                    alt={`upload-${i}`}
                    className="max-w-[200px] cq-md:max-w-[240px] max-h-[200px] cq-md:max-h-[240px] rounded-xl object-cover border border-black/10 dark:border-white/10 shadow-sm"
                  />
                ))}
              </div>
            )}
            <div className="whitespace-pre-wrap break-words text-[14.5px] cq-md:text-[15px] leading-relaxed">
              {message.content}
            </div>
          </div>

          {/* User question action bar: icon-only Copy + Retry（与浮窗一致；重试=重新发送本轮，生成中先停止） */}
          <div className="mt-1 flex items-center pr-1.5 opacity-60 group-hover:opacity-100 transition-opacity">
            <button
              onClick={handleCopy}
              className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-700 hover:bg-black/5 dark:text-zinc-500 dark:hover:text-zinc-200 dark:hover:bg-white/5 transition-colors"
              title={copied ? t('copied') : t('copyQuestionTooltip')}
            >
              {copied ? (
                <Check className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
              ) : (
                <Copy className="w-3.5 h-3.5" />
              )}
            </button>
            {onRetry && retryTargetId && (
              <button
                onClick={() => onRetry(retryTargetId)}
                className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-700 hover:bg-black/5 dark:text-zinc-500 dark:hover:text-zinc-200 dark:hover:bg-white/5 transition-colors"
                title={t('retryTooltip')}
              >
                <RotateCcw className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>
      ) : (
        /* Assistant Message: Clean full-width flow on the left (Qianwen Style) */
        <div className="space-y-2 w-full text-[#1f2328] dark:text-[#ecedf1]">
          {/* 知识库 / 引擎阶段阶梯（一层一层往下固化，带各阶段耗时）——
              渲染在思考条**上方**，思考条始终在最下面（用户要求）。两窗口共用本组件。 */}
          <StageLadder
            messageId={message.id}
            records={message.stages}
            recording={recordingStages}
            phasesActive={phasesActive}
            turnStage={message.stage}
            prefillStartedAt={message.prefillStartedAt}
            onRecordsChange={onStagesChange}
          />
          {/* Thinking Process Accordion */}
          {(message.reasoningContent || message.isThinking) && (
            <ThinkingAccordion
              content={message.reasoningContent}
              isThinking={message.isThinking}
              duration={message.thinkingDuration}
            />
          )}

          {/* Assistant Text / Markdown / KaTeX
              （思考中且尚无正文时不再额外渲染"Thinking..."——折叠条头部已表达同样状态） */}
          {message.content ? (
            <div className="text-[15px] leading-relaxed">
              <MarkdownRenderer content={message.content} />
            </div>
          ) : null}

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
                  type="button"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    onOpenWiki?.(c.title, c.context);
                  }}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs bg-emerald-500/10 hover:bg-emerald-500/20 active:bg-emerald-500/30 text-emerald-700 dark:text-emerald-300 border border-emerald-500/20 hover:border-emerald-500/35 transition-all hover:scale-[1.02] active:scale-[0.98] cursor-pointer select-none"
                  title={c.title}
                >
                  <span className="font-medium truncate max-w-[200px] pointer-events-none select-none">{c.title}</span>
                  <ExternalLink className="w-3 h-3 opacity-60 pointer-events-none flex-shrink-0" />
                </button>
              ))}
            </div>
          )}

          {/* Assistant Message Footer: Action buttons (Copy, Retry, Delete) - NO TEXT + Metrics
              条件不用 content：思考/prefill 阶段中断时 content 为空，但回合已结束，
              操作按钮与指标同样应该显示。生成中（isThinking/pending）则不显示。 */}
          {!message.isThinking && !message.pending && (
            <div className="mt-2.5 flex items-center gap-3 select-none">
              <div className="flex items-center gap-0.5 text-zinc-500 dark:text-zinc-400">
                {/* 复制 */}
                <button
                  onClick={handleCopy}
                  className="p-1.5 rounded-lg hover:text-zinc-900 hover:bg-black/5 dark:hover:text-white dark:hover:bg-white/5 transition-colors cursor-pointer"
                  title={copied ? t('copied') : t('copyTooltip')}
                >
                  {copied ? (
                    <Check className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
                  ) : (
                    <Copy className="w-3.5 h-3.5" />
                  )}
                </button>

                {/* 查看原始 Markdown */}
                {message.content && (
                  <button
                    onClick={() => setShowRawModal(true)}
                    className="p-1.5 rounded-lg hover:text-zinc-900 hover:bg-black/5 dark:hover:text-white dark:hover:bg-white/5 transition-colors cursor-pointer"
                    title={t('viewRawMarkdown')}
                  >
                    <FileText className="w-3.5 h-3.5" />
                  </button>
                )}

                {/* 重试 */}
                {onRetry && (
                  <button
                    onClick={() => onRetry(message.id)}
                    className="p-1.5 rounded-lg hover:text-zinc-900 hover:bg-black/5 dark:hover:text-white dark:hover:bg-white/5 transition-colors cursor-pointer"
                    title={t('retryTooltip')}
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                  </button>
                )}

                {/* 删除此轮对话 (连带删除问和答) */}
                {onDelete && (
                  <button
                    onClick={() => onDelete(message.id)}
                    className="p-1.5 rounded-lg hover:text-red-600 hover:bg-red-500/10 dark:hover:text-red-400 dark:hover:bg-red-500/10 transition-colors cursor-pointer"
                    title={t('deleteTurnTooltip')}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>

              {/* Next to action buttons: Gray Prefill & tok/s Metrics
                  prefill 只留速度、不再显示耗时——耗时已由上方阶段阶梯的
                  「正在载入上下文 X.Xs」那行承担，避免同一信息重复两处。 */}
              {message.metrics && (
                <span className="text-xs font-mono text-zinc-500 dark:text-zinc-400">
                  {message.metrics.ttftMs > 0 && message.metrics.promptTokens > 0
                    ? `${t('metricsPrefill')} ${(message.metrics.promptTokens / (message.metrics.ttftMs / 1000)).toFixed(1)} tok/s · `
                    : ''}
                  {`${t('metricsDecode')} ${message.metrics.tokensPerSecond} tok/s`}
                </span>
              )}
            </div>
          )}

          {/* 原始 Markdown 弹窗 */}
          <RawMarkdownModal
            isOpen={showRawModal}
            onClose={() => setShowRawModal(false)}
            content={message.content || ''}
          />
        </div>
      )}
    </div>
  );
};
