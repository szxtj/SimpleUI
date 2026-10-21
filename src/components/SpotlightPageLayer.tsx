import React, { useEffect } from 'react';
import { ChevronLeft, X } from 'lucide-react';
import { useI18n } from '../i18n';
import { WikiSearchPage } from './pages/WikiSearchPage';
import { WikiArticlePage } from './pages/WikiArticlePage';
import { RawTextPage } from './pages/RawTextPage';
import { ImagePage } from './pages/ImagePage';
import type { SpotlightPage } from '../hooks/useSpotlightPage';
import type { PageChrome } from '../types/panel';

interface SpotlightPageLayerProps {
  /** 页面栈：**全部常驻挂载**，只显示栈顶 → 返回时搜索关键词/结果/滚动位置都还在 */
  stack: SpotlightPage[];
  kbReady: boolean;
  wikiEnabled: boolean;
  /** 搜索结果点条目：再压一层（返回可回到结果页） */
  onOpenArticle: (title: string) => void;
  onBack: () => void;
  onClose: () => void;
}

/**
 * 浮窗的整页层：**盖满整张卡片**（含卡片自己的头部），只有一层页头 `← 图标 标题 ✕`。
 *
 * 与旧实现（半透明遮罩 + 450×520 居中弹窗）的区别：图片与原文也是整页，
 * 不再出现"小窗套小窗"；关闭语义只有两级——返回上一层 / 关掉回对话。
 */
export const SpotlightPageLayer: React.FC<SpotlightPageLayerProps> = ({
  stack,
  kbReady,
  wikiEnabled,
  onOpenArticle,
  onBack,
  onClose,
}) => {
  const { t } = useI18n();
  const depth = stack.length;

  // Esc：逐级返回；已在最底一层则关闭回对话
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      e.preventDefault();
      if (depth > 1) onBack();
      else onClose();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [depth, onBack, onClose]);

  const chromeFor = (level: number): PageChrome => ({
    // 与浮窗卡片头同一份左右内边距，页头内容不会突然左移
    padding: 'comfy',
    leading: (
      <div className="flex flex-shrink-0 items-center">
        {level > 1 && (
          <button
            type="button"
            onClick={onBack}
            data-page-back="true"
            className="flex h-6 w-6 items-center justify-center rounded-lg text-zinc-500 transition-colors hover:bg-black/5 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-white/5 dark:hover:text-white"
            title={t('panelBack')}
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
        )}
      </div>
    ),
    trailing: (
      <button
        type="button"
        onClick={onClose}
        data-page-close="true"
        className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-lg text-zinc-500 transition-colors hover:bg-black/5 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-white/5 dark:hover:text-white"
        title={t('closeWikiPanel')}
      >
        <X className="h-3.5 w-3.5" />
      </button>
    ),
  });

  const renderPage = (page: SpotlightPage, level: number, isTop: boolean) => {
    const chrome = chromeFor(level);
    switch (page.kind) {
      case 'wiki-search':
        return (
          <WikiSearchPage
            kbReady={kbReady}
            wikiEnabled={wikiEnabled}
            onOpenArticle={onOpenArticle}
            chrome={chrome}
          />
        );
      case 'wiki-article':
        return (
          <WikiArticlePage
            title={page.title}
            injected={page.injected}
            kbReady={kbReady}
            wikiEnabled={wikiEnabled}
            chrome={chrome}
          />
        );
      case 'raw-text':
        return <RawTextPage content={page.content} chrome={chrome} />;
      case 'image':
        return <ImagePage images={page.images} index={page.index} chrome={chrome} active={isTop} />;
      default:
        return null;
    }
  };

  const topKind = stack[depth - 1]?.kind ?? '';

  return (
    <div
      data-spotlight-layer="true"
      data-spotlight-page={topKind}
      data-page-depth={depth}
      // fixed（而非 absolute）：这段 JSX 在浮窗卡片内部，absolute 会被卡片的 1px 描边内缩成
      // 498×638 并露出双层描边；fixed 直接对齐整个 webview（= 整个原生面板）且不受嵌套影响。
      // 圆角仍与卡片一致：NSPanel 背景透明，圆角完全由 Web 内容画出来。
      className="fixed inset-0 z-40 flex flex-col overflow-hidden rounded-[22px] border border-black/10 bg-[#f8f9fb] select-none dark:border-white/10 dark:bg-[#1b1c20]"
    >
      {stack.map((page, i) => {
        const isTop = i === depth - 1;
        return (
          <div
            key={page.key}
            data-spotlight-page={page.kind}
            data-page-depth={i + 1}
            data-page-active={isTop ? 'true' : 'false'}
            style={{ display: isTop ? 'flex' : 'none' }}
            className="absolute inset-0 flex-col"
          >
            {renderPage(page, i + 1, isTop)}
          </div>
        );
      })}
    </div>
  );
};
