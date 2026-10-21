import React, { useState } from 'react';
import { Search, Loader2 } from 'lucide-react';
import { useI18n } from '../../i18n';
import { pageHeaderClass } from '../pageHeader';
import { WikiAPI } from '../../services/api';
import { useImeInput } from '../../hooks/useImeInput';
import { KbUnavailable } from '../KbUnavailable';
import type { PageChrome } from '../../types/panel';

interface SearchResult {
  title: string;
  exact?: boolean;
}

interface WikiSearchPageProps {
  /** 服务开启 && ZIM 就绪 && 非 DeepSeek。false 时一律不发请求 */
  kbReady: boolean;
  wikiEnabled: boolean;
  /** 点击结果：主窗口开一个新标签，浮窗压一层新页面 */
  onOpenArticle: (title: string) => void;
  /** 关键词回写（仅用于标签标题展示） */
  onQueryChange?: (q: string) => void;
  autoFocus?: boolean;
  chrome?: PageChrome;
}

/**
 * 知识库搜索页（主窗口标签 / 浮窗整页共用）。
 *
 * 搜索状态归页面自己：主窗口的标签不卸载，切走再切回关键词与结果都还在。
 * 服务不可用时**输入框仍渲染**（只是禁用），下方给统一提醒——保留页面骨架，
 * 而不是让入口看起来"消失了"。
 */
export const WikiSearchPage: React.FC<WikiSearchPageProps> = ({
  kbReady,
  wikiEnabled,
  onOpenArticle,
  onQueryChange,
  autoFocus = true,
  chrome,
}) => {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);

  const runSearch = async () => {
    const q = query.trim();
    if (!kbReady || !q || searching) return;
    setSearching(true);
    try {
      const found = await WikiAPI.search(q);
      setResults(found);
      setSearched(true);
    } finally {
      setSearching(false);
    }
  };

  const { imeBindings } = useImeInput<HTMLInputElement>({ onEnter: runSearch });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className={pageHeaderClass({ gap: 'gap-1.5', padding: chrome?.padding })}>
        {chrome?.leading}
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
          <input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              onQueryChange?.(e.target.value);
            }}
            {...imeBindings}
            disabled={!kbReady}
            autoFocus={autoFocus && kbReady}
            placeholder={t('wikiSearchPlaceholder')}
            className="w-full rounded-lg border border-black/10 bg-black/5 py-1.5 pl-8 pr-8 text-xs text-[#1f2328] placeholder-zinc-400 focus:border-emerald-500/50 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/10 dark:bg-white/5 dark:text-[#f1f3f7]"
          />
          {searching && (
            <Loader2 className="absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 animate-spin text-emerald-500" />
          )}
        </div>
        {chrome?.trailing}
      </div>

      <div className="relative min-h-0 flex-1 overflow-y-auto">
        {!kbReady ? (
          <KbUnavailable wikiEnabled={wikiEnabled} />
        ) : searched ? (
          <div className="divide-y divide-black/5 dark:divide-white/10">
            {results.length === 0 && (
              <div className="px-4 py-6 text-center text-xs text-zinc-400">{t('wikiNoResults')}</div>
            )}
            {results.map((r, i) => (
              <button
                key={`${r.title}-${i}`}
                onClick={() => onOpenArticle(r.title)}
                className="flex w-full items-center gap-2 px-4 py-2.5 text-left transition-colors hover:bg-black/5 dark:hover:bg-white/5"
              >
                <span
                  className={`flex-shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${
                    r.exact
                      ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                      : 'bg-zinc-500/15 text-zinc-500 dark:text-zinc-400'
                  }`}
                >
                  {r.exact ? t('wikiMatchExact') : t('wikiMatchContains')}
                </span>
                <span className="truncate text-[13px] text-[#1f2328] dark:text-[#f1f3f7]">{r.title}</span>
              </button>
            ))}
          </div>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center text-xs text-zinc-400 dark:text-zinc-500">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-emerald-500/10 text-emerald-500">
              <Search className="h-5 w-5" />
            </div>
            <span className="max-w-[240px] leading-relaxed">{t('wikiSearchHint')}</span>
          </div>
        )}
      </div>
    </div>
  );
};
