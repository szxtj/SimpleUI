import React, { useState, useEffect, useMemo } from 'react';
import { FileText, Copy, Check, X } from 'lucide-react';
import { useI18n } from '../i18n';

interface RawMarkdownModalProps {
  isOpen: boolean;
  onClose: () => void;
  content: string;
  isSpotlight?: boolean;
}

export const RawMarkdownModal: React.FC<RawMarkdownModalProps> = ({
  isOpen,
  onClose,
  content,
  isSpotlight,
}) => {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);

  const inSpotlight =
    isSpotlight ??
    (typeof window !== 'undefined' &&
      (window.location.hash === '#/spotlight' || window.location.search.includes('mode=spotlight')));

  const charCount = useMemo(() => (content ? content.length : 0), [content]);
  const lineCount = useMemo(() => (content ? content.split('\n').length : 0), [content]);

  // Handle escape key (capture phase to ensure modal consumes it)
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const handleCopyAll = async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      console.error('Failed to copy raw markdown:', e);
    }
  };

  const statsText = `${charCount.toLocaleString()} ${t('charsCount')} · ${lineCount.toLocaleString()} ${t('linesCount')}`;

  return (
    <div
      className={`fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-5 select-none animate-in fade-in duration-150 ${
        inSpotlight ? 'rounded-[22px] overflow-hidden' : ''
      }`}
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50 dark:bg-black/70 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Dialog Card */}
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ containerType: 'inline-size' }}
        className={`relative z-10 w-full flex flex-col rounded-2xl bg-white dark:bg-[#1e2025] border border-black/10 dark:border-[#333640] shadow-2xl overflow-hidden transition-all ${
          inSpotlight
            ? 'max-w-[450px] h-[520px] max-h-[88vh]'
            : 'max-w-2xl h-[560px] max-h-[85vh]'
        }`}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-black/5 dark:border-white/5 select-none">
          <div className="flex items-center gap-2.5 min-w-0" title={statsText}>
            <div className="w-7 h-7 rounded-lg bg-zinc-100 dark:bg-white/10 text-zinc-600 dark:text-zinc-300 flex items-center justify-center flex-shrink-0">
              <FileText className="w-3.5 h-3.5" />
            </div>
            <div className="flex items-baseline gap-2 min-w-0">
              <span className="font-semibold text-sm text-[#1f2328] dark:text-[#f1f3f7] tracking-tight whitespace-nowrap flex-shrink-0">
                {t('rawMarkdownTitle')}
              </span>
              {!inSpotlight && (
                <span className="hidden cq-md:inline-block sm:inline-block text-[11px] font-mono text-zinc-400 dark:text-zinc-500 whitespace-nowrap">
                  {statsText}
                </span>
              )}
            </div>
          </div>

          <div className="flex items-center gap-1.5 flex-shrink-0">
            {/* Copy All Button */}
            <button
              type="button"
              onClick={handleCopyAll}
              className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-all cursor-pointer ${
                copied
                  ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20'
                  : 'bg-black/5 hover:bg-black/10 dark:bg-white/5 dark:hover:bg-white/10 text-zinc-600 hover:text-zinc-900 dark:text-zinc-300 dark:hover:text-white border border-transparent'
              }`}
              title={copied ? t('copiedAll') : t('copyAll')}
            >
              {copied ? (
                <>
                  <Check className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
                  <span>{t('copiedAll')}</span>
                </>
              ) : (
                <>
                  <Copy className="w-3.5 h-3.5" />
                  <span>{t('copyAll')}</span>
                </>
              )}
            </button>

            {/* Close Button */}
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-black/5 dark:hover:bg-white/5 transition-colors cursor-pointer"
              title={t('close')}
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Content Body Container */}
        <div className="flex-1 min-h-0 p-3 flex flex-col">
          <div className="flex-1 min-h-0 rounded-xl border border-black/5 dark:border-white/5 bg-[#f8f9fb] dark:bg-[#141518] overflow-hidden flex flex-col">
            <div className="flex-1 overflow-auto p-3.5 font-mono text-[13px] leading-relaxed text-[#1f2328] dark:text-[#dcdfe6] whitespace-pre-wrap break-words select-text cursor-text [overflow-anchor:none]">
              {content}
            </div>
          </div>
        </div>

        {/* Subtle Footer Hint */}
        <div className="px-4 pb-3 flex items-center justify-between text-[11px] text-zinc-400 dark:text-zinc-500 select-none">
          <span>{t('rawMarkdownHint')}</span>
        </div>
      </div>
    </div>
  );
};
