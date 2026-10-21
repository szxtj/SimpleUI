import React, { useCallback, useEffect, useRef, useState } from 'react';
import { BookOpen, FileText, Image as ImageIcon, PanelRightClose, Plus, Search, X } from 'lucide-react';
import { useI18n } from '../i18n';
import type { PanelTab } from '../types/panel';

interface PanelTabStripProps {
  tabs: PanelTab[];
  activeId: string | null;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  /** `+`：打开知识库搜索页（单例复用） */
  onNewTab: () => void;
  /** 收起整个面板（标签与状态保留，再展开回到原激活项） */
  onCollapse: () => void;
}

const TabIcon: React.FC<{ tab: PanelTab }> = ({ tab }) => {
  const cls = 'w-3.5 h-3.5 flex-shrink-0';
  if (tab.kind === 'wiki-search') return <Search className={cls} />;
  if (tab.kind === 'wiki-article') return <BookOpen className={cls} />;
  if (tab.kind === 'raw-text') return <FileText className={cls} />;
  return <ImageIcon className={cls} />;
};

/**
 * 面板顶部的浏览器式标签栏。
 *
 * 尺寸与 ChatView 顶栏同为 52px，底部与对话区顶栏的分隔线连成一条。
 * 标签区可横向滚动（隐藏滚动条），`+` 与「收起面板」固定在最右，永不被滚走。
 */
export const PanelTabStrip: React.FC<PanelTabStripProps> = ({
  tabs,
  activeId,
  onActivate,
  onClose,
  onNewTab,
  onCollapse,
}) => {
  const { t } = useI18n();
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  /**
   * 自定义横向滚动条（3px 滑块）。
   *
   * 不依赖原生滚动条：macOS 默认是 overlay 滚动条，不占位也常驻不可见，
   * 标签一多就完全看不出「右边还有」。这里只在真正溢出时显示一条细滑轨。
   */
  const [bar, setBar] = useState({ visible: false, left: 0, width: 0 });
  const thumbDragRef = useRef<{ startX: number; startLeft: number } | null>(null);

  const measure = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const overflow = el.scrollWidth - el.clientWidth;
    if (overflow <= 1) {
      setBar((b) => (b.visible ? { visible: false, left: 0, width: 0 } : b));
      return;
    }
    const width = Math.max(28, Math.round((el.clientWidth / el.scrollWidth) * el.clientWidth));
    const left = Math.round((el.scrollLeft / overflow) * (el.clientWidth - width));
    setBar((b) => (b.visible && b.left === left && b.width === width ? b : { visible: true, left, width }));
  }, []);

  useEffect(() => {
    const el = scrollerRef.current;
    const raf = requestAnimationFrame(measure);
    const ro = el ? new ResizeObserver(measure) : null;
    if (el && ro) ro.observe(el);
    window.addEventListener('resize', measure);
    return () => {
      cancelAnimationFrame(raf);
      ro?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [measure]);

  useEffect(() => {
    const raf = requestAnimationFrame(measure);
    return () => cancelAnimationFrame(raf);
  }, [tabs.length, activeId, measure]);

  // 激活项始终可见（从引用胶囊跳到末尾标签时不会"藏在滚动区外"）
  useEffect(() => {
    if (!activeId) return;
    const el = scrollerRef.current?.querySelector<HTMLElement>(
      `[data-tab-id="${CSS.escape(activeId)}"]`
    );
    el?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  }, [activeId, tabs.length]);

  const titleOf = (tab: PanelTab): string => {
    if (tab.kind === 'wiki-search') {
      const q = (tab.query ?? '').trim();
      return q || t('panelTabSearch');
    }
    if (tab.kind === 'wiki-article') return tab.title;
    if (tab.kind === 'raw-text') return t('panelTabRaw');
    return `${t('panelTabImage')} ${tab.index + 1}/${tab.images.length}`;
  };

  return (
    <div
      data-tab-strip="true"
      className="flex h-[52px] flex-shrink-0 select-none items-center gap-1.5 border-b border-black/5 bg-[#f8f9fb]/80 px-2 backdrop-blur dark:border-white/5 dark:bg-[#18191c]/80"
    >
      <div className="relative flex h-full min-w-0 flex-1 items-center">
      <div
        ref={scrollerRef}
        onScroll={measure}
        className="scrollbar-invisible flex w-full items-center gap-1 overflow-x-auto"
      >
        {tabs.map((tab) => {
          const active = tab.id === activeId;
          return (
            <div
              key={tab.id}
              role="tab"
              aria-selected={active}
              data-tab-id={tab.id}
              title={titleOf(tab)}
              onClick={() => onActivate(tab.id)}
              onAuxClick={(e) => {
                if (e.button === 1) {
                  e.preventDefault();
                  onClose(tab.id);
                }
              }}
              className={`group flex h-[30px] min-w-[92px] max-w-[170px] flex-shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border pl-2 pr-1 transition-colors ${
                active
                  ? 'border-black/[0.06] bg-white text-[#1f2328] shadow-sm dark:border-white/[0.06] dark:bg-[#2a2c33] dark:text-[#f1f3f7] dark:shadow-none'
                  : 'border-transparent text-zinc-500 hover:bg-black/5 hover:text-zinc-800 dark:text-zinc-400 dark:hover:bg-white/5 dark:hover:text-zinc-100'
              }`}
            >
              <TabIcon tab={tab} />
              <span className="min-w-0 flex-1 truncate text-[12px] font-medium">{titleOf(tab)}</span>
              <button
                type="button"
                data-tab-close="true"
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(tab.id);
                }}
                title={t('panelTabClose')}
                className={`flex-shrink-0 rounded p-0.5 transition-opacity hover:bg-black/10 hover:text-zinc-900 dark:hover:bg-white/10 dark:hover:text-white ${
                  active ? 'opacity-60 hover:opacity-100' : 'opacity-0 group-hover:opacity-60'
                }`}
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          );
        })}
      </div>

        {bar.visible && (
          <div
            data-tab-scrollbar="true"
            className="pointer-events-none absolute inset-x-0 bottom-[4px] h-[3px] rounded-full bg-black/[0.06] dark:bg-white/[0.08]"
          >
            <div
              data-tab-scrollbar-thumb="true"
              onPointerDown={(e) => {
                e.preventDefault();
                e.currentTarget.setPointerCapture(e.pointerId);
                thumbDragRef.current = { startX: e.clientX, startLeft: scrollerRef.current?.scrollLeft ?? 0 };
              }}
              onPointerMove={(e) => {
                const drag = thumbDragRef.current;
                const el = scrollerRef.current;
                if (!drag || !el) return;
                const overflow = el.scrollWidth - el.clientWidth;
                if (overflow <= 0) return;
                const ratio = overflow / Math.max(1, el.clientWidth - bar.width);
                el.scrollLeft = drag.startLeft + (e.clientX - drag.startX) * ratio;
              }}
              onPointerUp={(e) => {
                thumbDragRef.current = null;
                try {
                  e.currentTarget.releasePointerCapture(e.pointerId);
                } catch {
                  /* 已释放 */
                }
              }}
              style={{ left: bar.left, width: bar.width }}
              className="pointer-events-auto absolute top-0 h-full cursor-pointer rounded-full bg-zinc-400/60 transition-colors hover:bg-zinc-400/85 dark:bg-zinc-500/60 dark:hover:bg-zinc-400/80"
            />
          </div>
        )}
      </div>

      <button
        type="button"
        onClick={onNewTab}
        data-new-tab="true"
        title={t('panelTabNew')}
        className="flex h-[26px] w-[26px] flex-shrink-0 items-center justify-center rounded-lg text-zinc-500 transition-colors hover:bg-black/5 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-white/5 dark:hover:text-white"
      >
        <Plus className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        onClick={onCollapse}
        data-panel-collapse="true"
        title={t('panelCollapse')}
        className="flex h-[26px] w-[26px] flex-shrink-0 items-center justify-center rounded-lg text-zinc-500 transition-colors hover:bg-black/5 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-white/5 dark:hover:text-white"
      >
        <PanelRightClose className="h-3.5 w-3.5" />
      </button>
    </div>
  );
};
