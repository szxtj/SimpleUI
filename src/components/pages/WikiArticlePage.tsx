import React, { useEffect, useRef, useState } from 'react';
import { BookOpen, ExternalLink, Loader2 } from 'lucide-react';
import { useI18n } from '../../i18n';
import { pageHeaderClass } from '../pageHeader';
import { WikiAPI } from '../../services/api';
import { buildWikiExternalUrl } from '../../utils/wikiFrame';
import { WikiContextView } from '../WikiContextView';
import { KbUnavailable } from '../KbUnavailable';
import type { PageChrome } from '../../types/panel';

/**
 * 条目全文缓存：模块级 → 同一条目开两个标签也只拉一次。
 *
 * 主窗口与浮窗是两个独立 WKWebView（各自 JS 运行时），这份 Map 天然各存一份，
 * 不是跨窗口共享状态。
 */
const articleCache = new Map<string, string>();

interface WikiArticlePageProps {
  title: string;
  /** 引用胶囊携带的注入原文；只显示在正文**之后**（下侧） */
  injected?: string | null;
  kbReady: boolean;
  wikiEnabled: boolean;
  chrome?: PageChrome;
}

/**
 * 条目阅读页（主窗口标签 / 浮窗整页共用）。
 *
 * 版式顺序（用户明确要求）：完整条目正文在上，`本次传给模型的参考文本` 在下。
 * 长条目容易让底部内容显得"没显示"，故页头给一颗 `参考文本 ↓` 直接滚过去。
 */
export const WikiArticlePage: React.FC<WikiArticlePageProps> = ({
  title,
  injected,
  kbReady,
  wikiEnabled,
  chrome,
}) => {
  const { t } = useI18n();
  const [text, setText] = useState<string | null>(() => articleCache.get(title) ?? null);
  const [loading, setLoading] = useState(false);
  const injectedRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    const cached = articleCache.get(title);
    if (cached) {
      setText(cached);
      setLoading(false);
      return;
    }
    // 服务不可用：不请求全文，也不残留上一次的正文
    if (!kbReady) {
      setText(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setText(null);
    WikiAPI.getFullArticle(title)
      .then((data) => {
        if (cancelled) return;
        if (data?.context) {
          articleCache.set(title, data.context);
          setText(data.context);
        } else {
          setText(null);
        }
      })
      .catch(() => {
        if (!cancelled) setText(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [title, kbReady]);

  const jumpToInjected = () => {
    injectedRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' });
  };

  const injectedBlock = injected ? `【${title}】\n${injected}` : null;

  return (
    <div className="flex h-full min-h-0 flex-col" data-page="wiki-article">
      <div className={pageHeaderClass({ gap: 'gap-2', padding: chrome?.padding })}>
        {chrome?.leading}
        <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
          <BookOpen className="h-3.5 w-3.5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[10px] leading-none text-zinc-500 dark:text-zinc-400">
            {t('offlineWikiTitle')}
          </div>
          <div
            className="mt-0.5 truncate text-[13px] font-semibold leading-tight text-[#1f2328] dark:text-[#f1f3f7]"
            title={title}
          >
            {title}
          </div>
        </div>

        {injectedBlock && (
          <button
            type="button"
            onClick={jumpToInjected}
            data-jump-injected="true"
            className="flex-shrink-0 rounded-md border border-emerald-500/25 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 transition-colors hover:bg-emerald-500/20 dark:text-emerald-300"
            title={t('panelJumpToInjected')}
          >
            {t('panelJumpToInjected')}
          </button>
        )}

        {kbReady && (
          <a
            href={buildWikiExternalUrl(title)}
            target="_blank"
            rel="noreferrer"
            className="flex-shrink-0 rounded-lg p-1.5 text-zinc-500 transition-colors hover:bg-black/5 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-white/5 dark:hover:text-white"
            title={t('openExternal')}
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        )}
        {chrome?.trailing}
      </div>

      <div className="min-h-0 flex-1 select-text overflow-y-auto bg-white dark:bg-[#1e1f24]">
        <div className="border-b border-black/5 px-4 py-1.5 select-none dark:border-white/10">
          <span className="text-[11px] font-medium leading-none text-zinc-500 dark:text-zinc-400">
            {t('wikiFullArticle')}
          </span>
        </div>

        {loading ? (
          <div className="flex flex-col items-center justify-center gap-3 py-16 text-zinc-400">
            <Loader2 className="h-6 w-6 animate-spin text-emerald-500" />
            <span className="text-xs">{t('wikiLoading')}</span>
          </div>
        ) : text ? (
          <div data-wiki-body="true">
            <WikiContextView text={text} />
          </div>
        ) : kbReady ? (
          <div className="px-4 py-8 text-center text-xs text-zinc-400">{t('wikiNoResults')}</div>
        ) : (
          <KbUnavailable wikiEnabled={wikiEnabled} />
        )}

        {/* 本次实际传给模型的注入原文：永远在正文之后（下侧）。
            它是引用胶囊自带的本地数据，与服务是否可用无关，故不可用时也照常显示。 */}
        {injectedBlock && (
          <div
            ref={injectedRef}
            data-injected="true"
            className="border-t-2 border-emerald-500/40 bg-black/[0.03] dark:bg-white/[0.04]"
          >
            <div className="px-4 pb-1 pt-2 select-none">
              <span className="text-[11px] font-medium leading-none text-zinc-500 dark:text-zinc-400">
                {t('wikiInjectedLabel')}
              </span>
            </div>
            <pre className="whitespace-pre-wrap break-words px-4 pb-3 font-mono text-[12px] leading-relaxed text-zinc-600 select-text dark:text-zinc-400">
              {injectedBlock}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
};
