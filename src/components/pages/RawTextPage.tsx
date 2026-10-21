import React, { useMemo, useState } from 'react';
import { Check, Copy, FileText } from 'lucide-react';
import { useI18n } from '../../i18n';
import { pageHeaderClass } from '../pageHeader';
import type { PageChrome } from '../../types/panel';

interface RawTextPageProps {
  /** 打开时抓的快照：消息被删/重试也不会悬空 */
  content: string;
  chrome?: PageChrome;
}

/**
 * 回答原文页（主窗口标签）。
 *
 * 取代原先居中的 450/672px 小弹窗：整页可读、可全选、可复制全部。
 */
export const RawTextPage: React.FC<RawTextPageProps> = ({ content, chrome }) => {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);

  const stats = useMemo(() => {
    const chars = content ? content.length : 0;
    const lines = content ? content.split('\n').length : 0;
    return `${chars.toLocaleString()} ${t('charsCount')} · ${lines.toLocaleString()} ${t('linesCount')}`;
  }, [content, t]);

  const copyAll = async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      console.error('Failed to copy raw markdown:', e);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col" data-page="raw-text">
      <div className={pageHeaderClass({ gap: 'gap-2', padding: chrome?.padding })}>
        {chrome?.leading}
        <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg bg-zinc-500/10 text-zinc-600 dark:text-zinc-300">
          <FileText className="h-3.5 w-3.5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-semibold leading-tight text-[#1f2328] dark:text-[#f1f3f7]">
            {t('panelTabRaw')}
          </div>
          <div className="mt-0.5 truncate text-[10px] leading-none text-zinc-500 dark:text-zinc-400" title={stats}>
            {stats}
          </div>
        </div>

        <button
          type="button"
          onClick={copyAll}
          data-raw-copy="true"
          className={`flex flex-shrink-0 items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-medium transition-colors ${
            copied
              ? 'border-emerald-500/25 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
              : 'border-black/10 bg-black/5 text-zinc-600 hover:bg-black/10 dark:border-white/10 dark:bg-white/5 dark:text-zinc-300 dark:hover:bg-white/10'
          }`}
          title={copied ? t('copiedAll') : t('copyAll')}
        >
          {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
          <span>{copied ? t('copiedAll') : t('copyAll')}</span>
        </button>
        {chrome?.trailing}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto bg-white p-3.5 dark:bg-[#1e1f24]">
        <pre
          data-raw-body="true"
          className="whitespace-pre-wrap break-words font-mono text-[12.5px] leading-relaxed text-[#1f2328] select-text dark:text-[#dcdfe6] [overflow-anchor:none]"
        >
          {content}
        </pre>
      </div>

      {/* 与旧弹窗一致的脚注（原 RawMarkdownModal 的底部提示） */}
      <div className="flex-shrink-0 border-t border-black/5 px-3 py-1.5 text-[11px] text-zinc-400 select-none dark:border-white/5 dark:text-zinc-500">
        {t('rawMarkdownPageHint')}
      </div>
    </div>
  );
};
