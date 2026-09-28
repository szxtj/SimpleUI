import React, { useState, useEffect, useRef } from 'react';
import { ExternalLink, Search, Loader2, BookOpen, PanelRightClose, X, BookX } from 'lucide-react';
import { useI18n } from '../i18n';
import { WikiAPI } from '../services/api';
import { buildWikiExternalUrl } from '../utils/wikiFrame';
import { WikiContextView } from './WikiContextView';

/**
 * 知识库面板的唯一实现——主窗口（docked 停靠侧栏）与 Spotlight 浮窗（overlay 覆盖抽屉）
 * **共用同一份显示机制**：空态 / 搜索结果 / 条目阅读三种状态、顶部注入原文块、
 * 完整条目富文本渲染（公式 · 表格 · 图片 · 子标题）、搜索栏、外部打开。
 *
 * 两个窗口此前各写一份（WikiSidebar / WikiDrawer），导致小窗口只显示注入原文纯文本、
 * 没有完整条目与搜索。现在统一到这里，两个窗口只在**容器形式**上不同：
 *   docked  → 相对定位、宽度滑入滑出（不遮挡对话区，随窗口布局）
 *   overlay → 固定定位全屏覆盖 + 背景遮罩（浮窗空间有限，需要盖住整个面板）
 */

interface SearchResult {
  title: string;
  exact?: boolean;
}

interface WikiPanelProps {
  variant: 'docked' | 'overlay';
  isOpen: boolean;
  title: string | null;
  /** 引用胶囊传入的 RAG 注入文本（面板顶部以纯文本展示「传给模型的样子」） */
  context?: string | null;
  onClose: () => void;
  /**
   * 仅浮窗覆盖型传入：关闭**整个 Spotlight 浮窗**（而非只收起面板）。
   * 传入后面板左上角会渲染与小窗口展开态头部同款的圆形 ✖ 整体关闭按钮——
   * 面板整块盖住了头部，没有它就没法一步关掉浮窗。
   */
  onCloseWindow?: () => void;
  /**
   * 知识库服务级总开关（关闭时整个服务停服）。默认 true 时保持旧行为。
   */
  wikiEnabled?: boolean;
  /**
   * 知识库是否就绪（服务开启且 ZIM 可用）。
   */
  wikiConnected?: boolean;
}

type PanelMode = 'empty' | 'results' | 'article';

export const WikiPanel: React.FC<WikiPanelProps> = ({
  variant,
  isOpen,
  title,
  context,
  onClose,
  onCloseWindow,
  wikiEnabled = true,
  wikiConnected = true,
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

  /**
   * 知识库是否可用。服务总开关关闭、或服务开启但未就绪（没找到 ZIM 等）时都算不可用。
   *
   * 不可用时面板**一律不发起任何知识库请求**（不取全文、不搜索）——服务不在，
   * 请求只会报连接错误；界面改为：搜索栏 + 正文区统一换成同一条提醒，
   * 而引用胶囊自带的注入原文（纯本地数据）仍照常展示在最上方。
   */
  const kbReady = wikiEnabled && wikiConnected;

  // 引用胶囊点击：外部回填 title(条目名) + context(本次注入给模型的原文)。
  // 注入文本与完整条目文本是两份独立状态：注入块只在此来源时展示。
  useEffect(() => {
    if (title) {
      setActiveTitle(title);
      setInjectedText(context ?? null);
      setMode('article');
      setResults([]);
      if (kbReady) {
        loadFull(title);
      } else {
        // 服务不可用：不请求全文，也不残留上一次的正文（下方由提醒替代）
        setActiveContext(null);
        setFullLoading(false);
      }
    }
  }, [title, context, kbReady]);

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
    // 服务不可用：不发起请求（搜索栏此时也不渲染，这里再兜一层）
    if (!kbReady || !q || searching) return;
    setSearching(true);
    try {
      const found = await WikiAPI.search(q);
      setResults(found);
      setMode('results');
    } finally {
      setSearching(false);
    }
  };

  const openResult = async (r: SearchResult) => {
    if (!kbReady) return; // 服务不可用：不发起请求
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

  /**
   * 知识库不可用（服务未开启 / 未就绪）时的统一提醒。
   *
   * 两个窗口（主窗口停靠栏、浮窗覆盖抽屉）与所有入口（侧边栏开关、浮窗搜索按钮、
   * 引用胶囊）都渲染**这同一份**，风格与面板空态一致：同尺寸图标底 + 同字色字号的说明。
   */
  const kbUnavailableNotice = (
    <div className="flex flex-col items-center justify-center min-h-[240px] text-zinc-400 dark:text-zinc-500 text-xs px-8 text-center gap-3">
      <div className="w-12 h-12 rounded-2xl bg-amber-500/10 text-amber-500 flex items-center justify-center">
        <BookX className="w-5 h-5" />
      </div>
      <span className="max-w-[260px] leading-relaxed">
        {wikiEnabled ? t('wikiPanelNotReady') : t('wikiPanelServiceOff')}
      </span>
    </div>
  );

  // 浮窗覆盖型：关闭时不渲染任何东西（避免遮挡）
  if (variant === 'overlay' && !isOpen) return null;

  const content = (
    <>
      {/* Header Toolbar */}
      <div className="h-[52px] px-3 flex items-center justify-between border-b border-black/5 dark:border-white/5 bg-[#f8f9fb]/80 dark:bg-[#18191c]/80 backdrop-blur flex-shrink-0 select-none">
        <div className="flex items-center gap-2.5 min-w-0">
          {/* 浮窗覆盖型：整体关闭浮窗（与小窗口展开态头部的 ✖ 同款同色，同一处理函数）。
              位置也必须与小窗口展开态**逐像素一致**（实测展开态 ✖ 圆底为 x=17/y=17/20×20，
              含卡片 1px 描边）：
                · 横向：展开态头部 px-4 → 16，本头部 px-3 → 12，故补 ml-1(4px) 使其同为 16；
                · 纵向：展开态内容行高 28（右侧 p-1.5 按钮撑起），✖ 居中正好落在 16；
                  本头部固定 h-[52px]，✖ 居中会落在 15.5，故补 mt-px(1px) 使其同为 16。
              随后的图标/标题因此同样从 x=47 起，与展开态标题逐像素对齐。 */}
          {onCloseWindow && (
            <button
              type="button"
              onClick={onCloseWindow}
              className="ml-1 mt-px w-5 h-5 rounded-full bg-black/5 hover:bg-black/10 dark:bg-white/10 dark:hover:bg-white/20 flex items-center justify-center text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-white transition-colors cursor-pointer flex-shrink-0"
              title={t('closeEsc')}
            >
              <X className="w-3 h-3" />
            </button>
          )}
          <div className="w-8 h-8 rounded-lg bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 flex items-center justify-center flex-shrink-0">
            <BookOpen className="w-4 h-4" />
          </div>
          <div className="min-w-0">
            <div className="text-[11px] text-zinc-500 dark:text-zinc-400 font-medium leading-none flex items-center gap-1.5">
              <span>{t('offlineWikiTitle')}</span>
              {kbReady && mode === 'article' && activeTitle && (
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 inline-block" />
              )}
            </div>
            <h2 className="text-sm font-semibold text-[#1f2328] dark:text-[#f1f3f7] truncate mt-0.5">
              {mode === 'results' ? t('wikiSearchResults') : activeTitle || t('wikiPanelEmptyTitle')}
            </h2>
          </div>
        </div>

        <div className="flex items-center gap-1">
          {/* 停靠侧栏（主窗口）=「收起侧边栏」语义；浮窗覆盖型（小窗口）= 关闭按钮 */}
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-zinc-500 hover:text-zinc-900 hover:bg-black/5 dark:text-zinc-400 dark:hover:text-white dark:hover:bg-white/5 transition-colors"
            title={variant === 'overlay' ? t('closeWikiPanel') : t('collapseWikiPanel')}
          >
            {variant === 'overlay' ? <X className="w-4 h-4" /> : <PanelRightClose className="w-4 h-4" />}
          </button>
          {/* 服务不可用时不提供「在浏览器中打开」：它指向的就是本地 kiwix，点了也是连接失败 */}
          {kbReady && mode === 'article' && activeTitle && (
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

      {/* Search Bar —— 服务不可用时不渲染：搜也搜不了，改为下方统一提醒 */}
      {kbReady && (
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
      )}

      {/* Body */}
      <div className="relative flex-1 w-full overflow-y-auto bg-white dark:bg-[#1e1f24]">
        {/* 本次实际传给模型的注入原文（纯文本，仅胶囊点击时展示）。
            这是引用胶囊自带的**本地数据**，与服务是否可用无关，故始终置顶保留——
            服务不可用时，它上方照常显示，其余部分统一换成下面的提醒。 */}
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

        {!kbReady ? (
          kbUnavailableNotice
        ) : mode === 'results' ? (
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
            {/* 完整条目正文（原生渲染，主题跟随 APP；公式/表格/图片/子标题均可渲染）
                —— 注入原文块已上移到 Body 顶部（胶囊来源时展示） */}
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
    </>
  );

  // 浮窗覆盖型：整块覆盖浮窗。
  //
  // 圆角必须与浮窗自身卡片**完全一致**（SpotlightView 里胶囊态/展开态都是
  // `rounded-[22px] border-black/10 overflow-hidden`）：Spotlight 的 NSPanel 背景是透明的，
  // 窗口的圆角轮廓完全由 Web 内容自己画出来。面板若没有圆角，直角会顶到窗口圆角之外，
  // 在透明窗口上就表现为「四角被硬切了一刀」。这里由外层容器统一 `rounded-[22px] +
  // overflow-hidden` 裁切，并补上与窗口卡片同色同宽的描边，使面板与浮窗严丝合缝。
  if (variant === 'overlay') {
    return (
      <div className="fixed inset-0 z-50 overflow-hidden rounded-[22px] border border-black/10 dark:border-white/10">
        <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" onClick={onClose} />
        <div className="relative z-10 flex h-full w-full select-none flex-col overflow-hidden bg-[#f8f9fb] dark:bg-[#1b1c20]">
          {content}
        </div>
      </div>
    );
  }

  // 主窗口停靠型：宽度滑入滑出，随窗口布局
  return (
    <div
      className={`relative flex-shrink-0 h-full flex flex-col select-none overflow-hidden transition-all duration-200 ease-in-out border-l bg-[#f8f9fb] dark:bg-[#1b1c20] ${
        isOpen
          ? 'w-[440px] min-w-[440px] opacity-100 border-black/10 dark:border-white/10'
          : 'w-0 min-w-0 opacity-0 pointer-events-none border-l-0'
      }`}
    >
      {content}
    </div>
  );
};
