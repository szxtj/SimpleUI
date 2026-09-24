import React, { useState, useEffect, useRef } from 'react';
import { X, ExternalLink, RefreshCw, BookOpen, Loader2 } from 'lucide-react';
import { useI18n } from '../i18n';

interface WikiDrawerProps {
  isOpen: boolean;
  title: string | null;
  onClose: () => void;
  theme?: 'light' | 'dark' | 'system';
}

export const WikiDrawer: React.FC<WikiDrawerProps> = ({
  isOpen,
  title,
  onClose,
  theme = 'system',
}) => {
  const { t } = useI18n();
  const [isLoading, setIsLoading] = useState(true);
  const [currentTitle, setCurrentTitle] = useState<string>('');
  const iframeRef = useRef<HTMLIFrameElement>(null);

  // Sync title when opened
  useEffect(() => {
    if (title) {
      setCurrentTitle(title);
      setIsLoading(true);
    }
  }, [title]);

  // Handle escape key to close
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen && !title) return null;

  const contentId = 'wikipedia_zh_all_maxi';
  const iframeSrc = currentTitle
    ? `http://127.0.0.1:31236/content/${contentId}/${encodeURIComponent(currentTitle)}`
    : '';

  const handleIframeLoad = () => {
    setIsLoading(false);
    // Try to inject dark mode CSS if current app theme is dark
    try {
      const isDark =
        theme === 'dark' ||
        (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);

      const doc = iframeRef.current?.contentDocument;
      if (doc && isDark) {
        let style = doc.getElementById('simpleui-dark-mode');
        if (!style) {
          style = doc.createElement('style');
          style.id = 'simpleui-dark-mode';
          style.innerHTML = `
            html {
              filter: invert(0.9) hue-rotate(180deg) !important;
              background-color: #f8f9fa !important;
            }
            img, video, svg, .mwe-math-fallback-image-inline, .mw-file-element {
              filter: invert(1.1) hue-rotate(180deg) !important;
            }
          `;
          doc.head.appendChild(style);
        }
      }
    } catch (e) {
      // Cross-origin access might be blocked if different origin, fallback to normal styling
    }
  };

  const handleOpenExternal = () => {
    if (iframeSrc) {
      window.open(iframeSrc, '_blank');
    }
  };

  const handleReload = () => {
    setIsLoading(true);
    if (iframeRef.current) {
      iframeRef.current.src = iframeSrc;
    }
  };

  return (
    <div
      className={`fixed inset-0 z-50 flex justify-end transition-opacity duration-300 ${
        isOpen ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'
      }`}
    >
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/30 backdrop-blur-sm transition-opacity"
        onClick={onClose}
      />

      {/* Slide-over Drawer Panel */}
      <div
        className={`relative z-10 w-full max-w-[680px] h-full bg-[#f8f9fb] dark:bg-[#1b1c20] border-l border-black/10 dark:border-white/10 shadow-2xl flex flex-col transform transition-transform duration-300 ease-out ${
          isOpen ? 'translate-x-0' : 'translate-x-full'
        }`}
      >
        {/* Header Toolbar */}
        <div className="h-14 px-4 flex items-center justify-between border-b border-black/5 dark:border-white/10 bg-white/70 dark:bg-[#202126]/70 backdrop-blur-md flex-shrink-0 select-none">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-8 h-8 rounded-lg bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 flex items-center justify-center flex-shrink-0">
              <BookOpen className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <div className="text-[11px] text-zinc-500 dark:text-zinc-400 font-medium leading-none flex items-center gap-1.5">
                <span>{t('offlineWikiTitle') || '离线维基百科'}</span>
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 inline-block" />
                <span className="text-[10px] text-emerald-600 dark:text-emerald-400">SSD 已连接</span>
              </div>
              <h2 className="text-sm font-semibold text-[#1f2328] dark:text-[#f1f3f7] truncate mt-0.5">
                {currentTitle || '维基百科词条'}
              </h2>
            </div>
          </div>

          {/* Action buttons */}
          <div className="flex items-center gap-1">
            <button
              onClick={handleReload}
              className="p-1.5 rounded-lg text-zinc-500 hover:text-zinc-900 hover:bg-black/5 dark:text-zinc-400 dark:hover:text-white dark:hover:bg-white/5 transition-colors"
              title={t('reload') || '刷新'}
            >
              <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
            </button>
            <button
              onClick={handleOpenExternal}
              className="p-1.5 rounded-lg text-zinc-500 hover:text-zinc-900 hover:bg-black/5 dark:text-zinc-400 dark:hover:text-white dark:hover:bg-white/5 transition-colors"
              title={t('openExternal') || '新窗口打开'}
            >
              <ExternalLink className="w-4 h-4" />
            </button>
            <div className="h-4 w-px bg-zinc-300 dark:bg-zinc-700 mx-1" />
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg text-zinc-500 hover:text-zinc-900 hover:bg-black/5 dark:text-zinc-400 dark:hover:text-white dark:hover:bg-white/5 transition-colors"
              title={t('close') || '关闭 (Esc)'}
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Content Viewer (iframe to local kiwix-serve) */}
        <div className="relative flex-1 w-full h-full overflow-hidden bg-white dark:bg-[#1e1f24]">
          {isLoading && (
            <div className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-white/80 dark:bg-[#1b1c20]/80 backdrop-blur-sm text-zinc-500 gap-3">
              <Loader2 className="w-6 h-6 animate-spin text-emerald-500" />
              <span className="text-xs font-medium">正在读取离线维基数据...</span>
            </div>
          )}

          {iframeSrc ? (
            <iframe
              ref={iframeRef}
              src={iframeSrc}
              onLoad={handleIframeLoad}
              title={currentTitle}
              className="w-full h-full border-0 select-text"
              sandbox="allow-same-origin allow-scripts allow-popups"
            />
          ) : (
            <div className="flex flex-col items-center justify-center h-full text-zinc-400 text-xs">
              <BookOpen className="w-8 h-8 mb-2 opacity-50" />
              <span>请选择要阅读的维基词条</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
