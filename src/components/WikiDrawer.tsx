import React from 'react';
import { ExternalLink, BookOpen, PanelRightClose } from 'lucide-react';
import { useI18n } from '../i18n';
import { buildWikiExternalUrl } from '../utils/wikiFrame';
import { WikiContextView } from './WikiContextView';

interface WikiDrawerProps {
  isOpen: boolean;
  title: string | null;
  context?: string | null;
  onClose: () => void;
  theme?: 'light' | 'dark' | 'system';
}

/**
 * Spotlight 浮窗的知识库阅读面板（全屏覆盖，原生渲染）。
 * 「抽取正文」以原生版式展示，主题跟随 APP；原版页面一键外部打开。
 */
export const WikiDrawer: React.FC<WikiDrawerProps> = ({
  isOpen,
  title,
  context,
  onClose,
}) => {
  const { t } = useI18n();
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="fixed inset-0 bg-black/30 backdrop-blur-sm" onClick={onClose} />

      <div className="relative z-10 w-full max-w-[680px] h-full bg-[#f8f9fb] dark:bg-[#1b1c20] border-l border-black/10 dark:border-white/10 shadow-2xl flex flex-col">
        <div className="h-14 px-4 flex items-center justify-between border-b border-black/5 dark:border-white/10 bg-white/70 dark:bg-[#202126]/70 backdrop-blur-md flex-shrink-0 select-none">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-8 h-8 rounded-lg bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 flex items-center justify-center flex-shrink-0">
              <BookOpen className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <div className="text-[11px] text-zinc-500 dark:text-zinc-400 font-medium leading-none">
                <span>{t('offlineWikiTitle')}</span>
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 inline-block ml-1.5" />
              </div>
              <h2 className="text-sm font-semibold text-[#1f2328] dark:text-[#f1f3f7] truncate mt-0.5">
                {title || t('wikiArticleDefault')}
              </h2>
            </div>
          </div>

          <div className="flex items-center gap-1">
            {title && (
              <a
                href={buildWikiExternalUrl(title)}
                target="_blank"
                rel="noreferrer"
                className="p-1.5 rounded-lg text-zinc-500 hover:text-zinc-900 hover:bg-black/5 dark:text-zinc-400 dark:hover:text-white dark:hover:bg-white/5 transition-colors"
                title={t('openExternal')}
              >
                <ExternalLink className="w-4 h-4" />
              </a>
            )}
            <div className="h-4 w-px bg-zinc-300 dark:bg-zinc-700 mx-1" />
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg text-zinc-500 hover:text-zinc-900 hover:bg-black/5 dark:text-zinc-400 dark:hover:text-white dark:hover:bg-white/5 transition-colors"
              title={t('close')}
            >
              <PanelRightClose className="w-4 h-4" />
            </button>
          </div>
        </div>

        <div className="relative flex-1 w-full overflow-y-auto bg-white dark:bg-[#1e1f24]">
          {context ? (
            <WikiContextView text={context} />
          ) : (
            <div className="flex flex-col items-center justify-center h-full text-zinc-400 text-xs gap-3">
              <BookOpen className="w-8 h-8 opacity-50" />
              <span>{t('wikiPanelEmpty')}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
