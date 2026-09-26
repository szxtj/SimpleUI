import React, { useState, useEffect, useRef } from 'react';
import { ExternalLink, Search, Loader2, BookOpen, PanelRightClose } from 'lucide-react';
import { useI18n } from '../i18n';
import { WikiAPI } from '../services/api';
import { buildWikiExternalUrl } from '../utils/wikiFrame';
import { WikiContextView } from './WikiContextView';

interface SearchResult {
  title: string;
  exact?: boolean;
}

interface WikiSidebarProps {
  isOpen: boolean;
  title: string | null;
  /** 引用胶囊传入的 RAG 注入文本（面板顶部以纯文本展示「传给模型的样子」） */
  context?: string | null;
  onClose: () => void;
}

type PanelMode = 'empty' | 'results' | 'article';

/**
 * 主窗口右侧知识库面板：悬浮覆盖层（transform 滑入滑出，GPU 合成，零重排）。
 * 三种状态：
 *   empty    未点胶囊未搜索 → 空态提示
 *   results  搜索后         → 全部命中列表（完全命中在前，包含在后）
 *   article  点胶囊/点词条   → 顶部纯文本（本次传给模型的注入原文，
 *                             仅胶囊点击时展示）+ 渲染好的完整词条文章
 * 主题跟随 APP（Tailwind dark: 类）；原版页面一键外部打开。
 */
export const WikiSidebar: React.FC<WikiSidebarProps> = ({
  isOpen,
  title,
  context,
  onClose,
}) => {
  const { t } = useI18n();
  const [mode, setMode] = useState<PanelMode>('empty');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searchQ, setSearchQ] = useState('');
  const [searching, setSearching] = useState(false);
  const [activeTitle, setActiveTitle] = useState<string | null>(null);
  const [activeContext, setActiveContext] = useState<string | null>(null);
  /** 引用胶囊传入的「本次传给模型的注入文本」——仅胶囊来源时非空 */
  const [injectedText, setInjectedText] = useState<string | null>(null);
  const [fullLoading, setFullLoading] = useState(false);
  const articleCacheRef = useRef<Map<string, string>>(new Map());

  // 引用胶囊点击：App 回填 title(条目名) + context(本次注入给模型的原文)。
  // 注入文本与完整条目文本是两份独立状态：注入块只在此来源时展示。
  useEffect(() => {
    if (title) {
      setActiveTitle(title);
      setInjectedText(context ?? null);
      setMode('article');
      setResults([]);
      loadFull(title);
    }
  }, [title, context]);

  // 空态重置（面板以无胶囊方式打开）
  useEffect(() => {
    if (isOpen && !title) {
      setMode('empty');
      setResults([]);
      setActiveTitle(null);
      setActiveContext(null);
      setInjectedText(null);
      setFullLoading(false);
    }
  }, [isOpen, title]);

  const loadFull = async (t: string) => {
    setFullLoading(true);
    try {
      const cached = articleCacheRef.current.get(t);
      if (cached) {
        setActiveContext(cached);
        setFullLoading(false);
        return;
      }
      const data = await WikiAPI.getFullArticle(t);
      if (data && data.context) {
        articleCacheRef.current.set(t, data.context);
        setActiveContext(data.context);
      } else {
        setActiveContext(null);
      }
    } finally {
      setFullLoading(false);
    }
  };

  const handleSearch = async () => {
    const q = searchQ.trim();
    if (!q || searching) return;
    setSearching(true);
    try {
      const results = await WikiAPI.search(q);
      setResults(results);
      setMode('results');
    } finally {
      setSearching(false);
    }
  };

  const openResult = async (r: SearchResult) => {
    setActiveTitle(r.title);
    setMode('article');
    setInjectedText(null);
    setActiveContext(null);
    setFullLoading(true);
    try {
      const cached = articleCacheRef.current.get(r.title);
      if (cached) {
        setActiveContext(cached);
        setFullLoading(false);
        return;
      }
      const data = await WikiAPI.getFullArticle(r.title);
      if (data && data.context) {
        articleCacheRef.current.set(r.title, data.context);
        setActiveContext(data.context);
      }
    } finally {
      setFullLoading(false);
    }
  };

  const injectedBlock =
    mode === 'article' && injectedText && activeTitle
      ? `【${activeTitle}】\n${injectedText}`
      : null;

  return (
    <div
      className={`relative flex-shrink-0 h-full flex flex-col select-none overflow-hidden transition-all duration-200 ease-in-out border-l bg-[#f8f9fb] dark:bg-[#1b1c20] ${
        isOpen
          ? 'w-[440px] min-w-[440px] opacity-100 border-black/10 dark:border-white/10'
          : 'w-0 min-w-0 opacity-0 pointer-events-none border-l-0'
      }`}
    >
      {/* Header Toolbar — height/背景/分隔线 must match the ChatView header
          (52px + bg-[#f8f9fb]/80) so the three top bars read as one band. */}
      <div className="h-[52px] px-3 flex items-center justify-between border-b border-black/5 dark:border-white/5 bg-[#f8f9fb]/80 dark:bg-[#18191c]/80 backdrop-blur flex-shrink-0 select-none">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-8 h-8 rounded-lg bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 flex items-center justify-center flex-shrink-0">
            <BookOpen className="w-4 h-4" />
          </div>
          <div className="min-w-0">
            <div className="text-[11px] text-zinc-500 dark:text-zinc-400 font-medium leading-none flex items-center gap-1.5">
              <span>{t('offlineWikiTitle')}</span>
              {mode === 'article' && activeTitle && (
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 inline-block" />
              )}
            </div>
            <h2 className="text-sm font-semibold text-[#1f2328] dark:text-[#f1f3f7] truncate mt-0.5">
              {mode === 'results' ? t('wikiSearchResults') : activeTitle || t('wikiPanelEmptyTitle')}
            </h2>
          </div>
        </div>

        <div className="flex items-center gap-1">
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-zinc-500 hover:text-zinc-900 hover:bg-black/5 dark:text-zinc-400 dark:hover:text-white dark:hover:bg-white/5 transition-colors"
            title={t('collapseWikiPanel')}
          >
            <PanelRightClose className="w-4 h-4" />
          </button>
          {mode === 'article' && activeTitle && (
            <a
              href={buildWikiExternalUrl(activeTitle)}
              target="_blank"
              rel="noreferrer"
              className="p-1.5 rounded-lg text-zinc-500 hover:text-zinc-900 hover:bg-black/5 dark:text-zinc-400 dark:hover:text-white dark:hover:bg-white/5 transition-colors"
              title={t('openExternal')}
            >
              <ExternalLink className="w-4 h-4" />
            </a>
          )}
        </div>
      </div>

      {/* Search Bar */}
      <div className="px-3 py-2 border-b border-black/5 dark:border-white/10 flex-shrink-0">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-zinc-400 pointer-events-none" />
          <input
            value={searchQ}
            onChange={(e) => setSearchQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleSearch();
            }}
            placeholder={t('wikiSearchPlaceholder')}
            className="w-full pl-8 pr-3 py-1.5 rounded-lg text-xs bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 text-[#1f2328] dark:text-[#f1f3f7] placeholder-zinc-400 focus:outline-none focus:border-emerald-500/50"
          />
          {searching && (
            <Loader2 className="absolute right-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-emerald-500 animate-spin" />
          )}
        </div>
      </div>

      {/* Body */}
      <div className="relative flex-1 w-full overflow-y-auto bg-white dark:bg-[#1e1f24]">
        {mode === 'results' ? (
          <div className="divide-y divide-black/5 dark:divide-white/10">
            {results.length === 0 && (
              <div className="px-4 py-6 text-center text-xs text-zinc-400">{t('wikiNoResults')}</div>
            )}
            {results.map((r, i) => (
              <button
                key={i}
                onClick={() => openResult(r)}
                className="w-full text-left px-4 py-2.5 hover:bg-black/5 dark:hover:bg-white/5 transition-colors flex items-center gap-2"
              >
                <span
                  className={`text-[10px] px-1.5 py-0.5 rounded flex-shrink-0 font-medium ${
                    r.exact
                      ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                      : 'bg-zinc-500/15 text-zinc-500 dark:text-zinc-400'
                  }`}
                >
                  {r.exact ? t('wikiMatchExact') : t('wikiMatchContains')}
                </span>
                <span className="text-[13px] text-[#1f2328] dark:text-[#f1f3f7] truncate">{r.title}</span>
              </button>
            ))}
          </div>
        ) : mode === 'article' && activeTitle ? (
          <div>
            {/* 本次实际传给模型的注入原文（纯文本，仅胶囊点击时展示） */}
            {injectedBlock && (
              <div className="border-b-2 border-emerald-500/40 bg-black/[0.03] dark:bg-white/[0.04]">
                <div className="px-4 pt-3 pb-1 select-none">
                  <span className="text-[11px] font-medium text-zinc-500 dark:text-zinc-400">
                    {t('wikiInjectedLabel')}
                  </span>
                </div>
                <pre className="px-4 pb-3 whitespace-pre-wrap break-words text-[12px] leading-relaxed text-zinc-600 dark:text-zinc-400 font-mono select-text">
                  {injectedBlock}
                </pre>
              </div>
            )}
            {/* 完整条目正文（原生渲染，主题跟随 APP） */}
            <div className="border-t border-black/5 dark:border-white/10">
              <div className="px-4 pt-3 pb-1 select-none">
                <span className="text-[11px] font-medium text-zinc-500 dark:text-zinc-400">
                  {t('wikiFullArticle')}
                </span>
              </div>
            </div>
            <div className="select-text">
              {fullLoading ? (
                <div className="flex flex-col items-center justify-center py-16 text-zinc-400 gap-3">
                  <Loader2 className="w-6 h-6 animate-spin text-emerald-500" />
                  <span className="text-xs">{t('wikiLoading')}</span>
                </div>
              ) : activeContext ? (
                <WikiContextView text={activeContext} />
              ) : (
                <div className="px-4 py-8 text-center text-xs text-zinc-400">{t('wikiNoResults')}</div>
              )}
            </div>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center h-full text-zinc-400 dark:text-zinc-500 text-xs px-8 text-center gap-3">
            <div className="w-12 h-12 rounded-2xl bg-emerald-500/10 text-emerald-500 flex items-center justify-center">
              <Search className="w-5 h-5" />
            </div>
            <span className="max-w-[240px] leading-relaxed">{t('wikiPanelEmpty')}</span>
          </div>
        )}
      </div>
    </div>
  );
};
