import React, { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { useI18n } from '../i18n';
import { usePanelWidth } from '../hooks/usePanelWidth';
import { useFadeOverlay } from '../hooks/useFadeOverlay';
import { resizeHud } from '../utils/resizeHud';
import { PanelTabStrip } from './PanelTabStrip';
import { WikiSearchPage } from './pages/WikiSearchPage';
import { WikiArticlePage } from './pages/WikiArticlePage';
import { RawTextPage } from './pages/RawTextPage';
import { ImagePage } from './pages/ImagePage';
import type { PanelTab } from '../types/panel';

interface SidePanelProps {
  tabs: PanelTab[];
  activeId: string | null;
  visible: boolean;
  /** 知识库是否可用（服务开启 + ZIM 就绪 + 非 DeepSeek） */
  kbReady: boolean;
  wikiEnabled: boolean;
  onActivate: (id: string) => void;
  onCloseTab: (id: string) => void;
  onNewTab: () => void;
  onCollapse: () => void;
  onOpenArticle: (title: string) => void;
  onQueryChange: (id: string, query: string) => void;
  /** 拖拽开始/结束（用于给对话区也盖上遮罩、并冻结它的重排） */
  onResizeStateChange?: (resizing: boolean) => void;
  /** 拖拽过程中每帧的面板宽度（App 用它更新两块遮罩上的数字） */
  onLiveWidth?: (width: number) => void;
  /** 左栏当前宽度（0 / 260），用于右栏拖拽钳制 */
  reservedLeft?: number;
  /** 提交后的面板宽度（松手/复位的终值），App 用它算窗口伸缩与最小宽度 */
  onWidthChange?: (width: number) => void;
}

/**
 * 主窗口右侧面板：一条标签栏 + 若干互相独立的页面。
 *
 * 所有页面**常驻挂载**，非激活页用 `hidden` 隐藏（`display:none`）——
 * 这样搜索关键词、结果列表、滚动位置在切换标签后都原样保留；
 * 关闭标签才真正卸载。
 */
export const SidePanel: React.FC<SidePanelProps> = ({
  tabs,
  activeId,
  visible,
  kbReady,
  wikiEnabled,
  onActivate,
  onCloseTab,
  onNewTab,
  onCollapse,
  onOpenArticle,
  onQueryChange,
  onResizeStateChange,
  onLiveWidth,
  reservedLeft = 0,
  onWidthChange,
}) => {
  const { t } = useI18n();
  const renderPage = (tab: PanelTab) => {
    switch (tab.kind) {
      case 'wiki-search':
        return (
          <WikiSearchPage
            kbReady={kbReady}
            wikiEnabled={wikiEnabled}
            onOpenArticle={onOpenArticle}
            onQueryChange={(q) => onQueryChange(tab.id, q)}
          />
        );
      case 'wiki-article':
        return (
          <WikiArticlePage
            title={tab.title}
            injected={tab.injected}
            kbReady={kbReady}
            wikiEnabled={wikiEnabled}
          />
        );
      case 'raw-text':
        return <RawTextPage content={tab.content} />;
      case 'image':
        return <ImagePage images={tab.images} index={tab.index} active={tab.id === activeId} />;
      default:
        return null;
    }
  };

  const asideRef = useRef<HTMLElement | null>(null);
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const pillRef = useRef<HTMLSpanElement | null>(null);

  /**
   * 拖拽时唯一的每帧动作：把宽度直接写进 DOM、更新胶囊数字。
   * **不经过 React 状态** —— 否则整个面板（含所有常驻页面、图片画布的 ResizeObserver）
   * 会逐帧重渲染重排，图片页在场时明显卡顿。
   */
  const applyLiveWidth = useCallback(
    (w: number) => {
      const el = asideRef.current;
      if (el) {
        el.style.width = `${w}px`;
        el.style.minWidth = `${w}px`;
      }
      // 内层是固定宽度的整块：拖拽时同步，避免"整块"与容器宽度脱节
      if (surfaceRef.current) surfaceRef.current.style.width = `${w}px`;
      onLiveWidth?.(w);
    },
    [onLiveWidth]
  );

  const { width, dragging, liveWidthRef, onPointerDown, onPointerMove, onPointerUp, reset } =
    usePanelWidth({ onLiveWidth: applyLiveWidth, reservedLeft });

  // 遮罩不随松手立刻消失：等内容重新适配完（80ms），再淡出（270ms），与原生窗口缩放一致。
  // 与中部同一条时间轴：松手先保持 100ms，再 280ms 淡出
  const veil = useFadeOverlay(dragging, 100, 280);

  // 把胶囊注册进 HUD（拖拽与开合两种来源都写这一个元素，零重渲染）
  useLayoutEffect(() => resizeHud.attachPanelPill(pillRef.current), [veil.mounted]);

  // 把提交后的宽度上报给 App（窗口伸缩差值、最小宽度都要用）
  useEffect(() => {
    onWidthChange?.(width);
  }, [width, onWidthChange]);

  // 万一拖拽期间因为别的原因重渲染了一遍（React 会按 state 重写 width），这里把实时宽度补回去
  useLayoutEffect(() => {
    if (dragging) applyLiveWidth(liveWidthRef.current);
  });

  return (
    <aside
      ref={asideRef}
      data-side-panel="true"
      style={{
        width: visible ? width : 0,
        minWidth: visible ? width : 0,
        // 拖拽中不要过渡（否则像拉橡皮）；开合仍然走 200ms
        transition: dragging ? 'none' : undefined,
      }}
      className={`relative flex h-full flex-shrink-0 flex-col select-none overflow-hidden border-l bg-[#f8f9fb] transition-all duration-200 ease-in-out dark:bg-[#1b1c20] ${
        visible
          ? 'border-black/10 opacity-100 dark:border-white/10'
          : 'pointer-events-none border-l-0 opacity-0'
      }`}
    >
      {/* 左沿拖拽把手：只在可见时存在（宽 0 时点不到，也无所谓） */}
      {visible && (
        <div
          data-panel-resize="true"
          onPointerDown={(e) => {
            onResizeStateChange?.(true);
            onPointerDown(e);
          }}
          onPointerMove={onPointerMove}
          onPointerUp={(e) => {
            onPointerUp(e);
            onResizeStateChange?.(false);
          }}
          onPointerCancel={(e) => {
            onPointerUp(e);
            onResizeStateChange?.(false);
          }}
          onLostPointerCapture={() => onResizeStateChange?.(false)}
          onDoubleClick={reset}
          title={t('panelResizeHint')}
          className="absolute inset-y-0 -left-[3px] z-40 w-[6px] cursor-col-resize touch-none bg-transparent"
        />
      )}
      {/* 内层 = 固定宽度的整块：开合时只做 translateX（合成层动画），内容一次都不重排 */}
      <div
        ref={surfaceRef}
        data-panel-surface="true"
        style={{ width }}
        className={`absolute right-0 top-0 flex h-full flex-col transition-transform duration-200 ease-in-out ${
          visible ? 'translate-x-0' : 'translate-x-full'
        }`}
      >
      <PanelTabStrip
        tabs={tabs}
        activeId={activeId}
        onActivate={onActivate}
        onClose={onCloseTab}
        onNewTab={onNewTab}
        onCollapse={onCollapse}
      />

      {/* 拖拽中整块内容暂停渲染（content-visibility 跳过内部布局与绘制），
          上面盖一层与主窗口"调窗口尺寸"同款的不透明遮罩 + 尺寸胶囊。
          松手才恢复渲染 —— 一次重排，拖的时候只动外框。 */}
      <div
        className="relative min-h-0 flex-1"
        style={dragging ? { contentVisibility: 'hidden' } : undefined}
      >
        {tabs.map((tab) => (
          <div
            key={tab.id}
            data-page-host={tab.kind}
            // 用内联 display 而不是 hidden 属性/类名：`flex` 这类 Tailwind 工具类会覆盖
            // 浏览器对 [hidden] 的 `display:none`，导致非激活页仍叠在下面显示。
            style={{ display: tab.id === activeId ? 'flex' : 'none' }}
            className="absolute inset-0 flex-col"
          >
            {renderPage(tab)}
          </div>
        ))}
      </div>
      </div>

      {veil.mounted && (
        <div
          data-panel-resize-veil="true"
          data-veil-visible={veil.visible ? 'true' : 'false'}
          className={`pointer-events-none absolute inset-0 z-30 flex items-center justify-center bg-[#f8f9fb] transition-opacity ease-in-out dark:bg-[#18191c] ${
            veil.visible ? 'opacity-100' : 'opacity-0'
          }`}
          style={{ transitionDuration: `${veil.durationMs}ms` }}
        >
          <div className="flex h-[38px] items-center rounded-[19px] border border-black/[0.08] bg-white/[0.96] px-5 shadow-lg dark:border-white/[0.12] dark:bg-[#22242a]/95">
            <span
              ref={pillRef}
              data-panel-size-pill="true"
              className="font-mono text-[15px] font-semibold tabular-nums text-[#1f2328] dark:text-[#f1f3f7]"
            >
              —
            </span>
          </div>
        </div>
      )}
    </aside>
  );
};
