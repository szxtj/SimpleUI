import React, { useState, useRef, useEffect, useLayoutEffect, useCallback, useId } from 'react';
import { FileCode, Sigma, Check } from 'lucide-react';
import { useI18n } from '../i18n';
import {
  extractCleanMathMlForWord,
  extractOmmlForWord,
  combineMathMlsForWord,
} from '../utils/selectionToMarkdown';
import { getVisibleBounds, pickVerticalPlacement } from '../utils/floatingPanel';

interface FormulaEntry {
  id: string;
  display: boolean;
  element: HTMLElement;
  getRawLatex: () => string;
  getCleanMathMl: () => string;
  getOmml: () => string;
}

// Global registry for coordinating multi-formula selections
class FormulaSelectionStore {
  private entries = new Map<string, FormulaEntry>();
  private selectedIds = new Set<string>();
  private activeToolbarId: string | null = null;
  private listeners = new Set<() => void>();

  public register(id: string, entry: FormulaEntry) {
    this.entries.set(id, entry);
  }

  public unregister(id: string) {
    this.entries.delete(id);
    this.selectedIds.delete(id);
    if (this.activeToolbarId === id) {
      this.activeToolbarId = null;
    }
  }

  public subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify() {
    this.listeners.forEach((l) => l());
  }

  public isSelected(id: string): boolean {
    return this.selectedIds.has(id);
  }

  public isToolbarActive(id: string): boolean {
    return this.activeToolbarId === id;
  }

  public getSelectedCount(): number {
    return this.selectedIds.size;
  }

  public select(id: string, isMulti: boolean = false) {
    if (isMulti) {
      if (this.selectedIds.has(id)) {
        this.selectedIds.delete(id);
        if (this.activeToolbarId === id) {
          this.activeToolbarId = Array.from(this.selectedIds).pop() || null;
        }
      } else {
        this.selectedIds.add(id);
        this.activeToolbarId = id;
      }
    } else {
      this.selectedIds.clear();
      this.selectedIds.add(id);
      this.activeToolbarId = id;
    }
    this.notify();
  }

  public clearSelection() {
    if (this.selectedIds.size > 0 || this.activeToolbarId !== null) {
      this.selectedIds.clear();
      this.activeToolbarId = null;
      this.notify();
    }
  }

  public getSelectedMathMls(fallbackId?: string): string[] {
    const ids = this.selectedIds.size > 0 ? Array.from(this.selectedIds) : fallbackId ? [fallbackId] : [];
    return ids.map((id) => this.entries.get(id)?.getCleanMathMl() || '').filter(Boolean);
  }

  public getSelectedOmmls(fallbackId?: string): string[] {
    const ids = this.selectedIds.size > 0 ? Array.from(this.selectedIds) : fallbackId ? [fallbackId] : [];
    return ids.map((id) => this.entries.get(id)?.getOmml() || '').filter(Boolean);
  }

  public getSelectedLatexs(fallbackId?: string): string[] {
    const ids = this.selectedIds.size > 0 ? Array.from(this.selectedIds) : fallbackId ? [fallbackId] : [];
    return ids.map((id) => this.entries.get(id)?.getRawLatex() || '').filter(Boolean);
  }

  public getSelectedFormattedLatexs(fallbackId?: string): string[] {
    const ids = this.selectedIds.size > 0 ? Array.from(this.selectedIds) : fallbackId ? [fallbackId] : [];
    return ids
      .map((id) => {
        const entry = this.entries.get(id);
        if (!entry) return '';
        const raw = entry.getRawLatex();
        if (!raw) return '';
        return entry.display ? `$$\n${raw}\n$$` : `$${raw}$`;
      })
      .filter(Boolean);
  }
}

const formulaStore = new FormulaSelectionStore();

interface InteractiveMathProps {
  children?: React.ReactNode;
  display?: boolean;
}

export const InteractiveMath: React.FC<InteractiveMathProps> = React.memo(
  ({ children, display = false }) => {
    const { lang } = useI18n();
    const isEn = lang === 'en';

    const id = useId();
    const containerRef = useRef<HTMLDivElement | HTMLSpanElement | null>(null);

    const [isHovered, setIsHovered] = useState(false);
    const [isCrossedBySelection, setIsCrossedBySelection] = useState(false);
    const [copiedType, setCopiedType] = useState<'latex' | 'word' | null>(null);
    const [popoverPlacement, setPopoverPlacement] = useState<'top' | 'bottom'>('top');
    /**
     * 水平方向的夹紧偏移（px）。内联工具条是「以公式为中心」浮起来的，
     * 小窗口里靠边（或公式很宽）时会被窗口边缘切掉，这里只补差值。
     */
    const [popoverShift, setPopoverShift] = useState(0);
    const copiedTimeoutRef = useRef<NodeJS.Timeout | null>(null);

    // Sync state with global store
    const [isSelected, setIsSelected] = useState(false);
    const [showToolbar, setShowToolbar] = useState(false);
    const [selectedCount, setSelectedCount] = useState(1);

    const getRawLatex = useCallback((): string => {
      if (!containerRef.current) return '';
      const ann = containerRef.current.querySelector('annotation[encoding="application/x-tex"]');
      return ann?.textContent?.trim() || '';
    }, []);

    const getCleanMathMl = useCallback((): string => {
      if (!containerRef.current) return '';
      return extractCleanMathMlForWord(containerRef.current as HTMLElement);
    }, []);

    const getOmml = useCallback((): string => {
      if (!containerRef.current) return '';
      return extractOmmlForWord(containerRef.current as HTMLElement);
    }, []);

    // Register into formula store
    useEffect(() => {
      if (!containerRef.current) return;
      formulaStore.register(id, {
        id,
        display,
        element: containerRef.current as HTMLElement,
        getRawLatex,
        getCleanMathMl,
        getOmml,
      });

      const unsubscribe = formulaStore.subscribe(() => {
        setIsSelected(formulaStore.isSelected(id));
        setShowToolbar(formulaStore.isToolbarActive(id));
        setSelectedCount(formulaStore.getSelectedCount() || 1);
      });

      return () => {
        formulaStore.unregister(id);
        unsubscribe();
      };
    }, [id, display, getRawLatex, getCleanMathMl, getOmml]);

    // Check if intersected by native document text selection
    useEffect(() => {
      const handleSelectionChange = () => {
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed || sel.rangeCount === 0 || !containerRef.current) {
          setIsCrossedBySelection(false);
          return;
        }

        try {
          const range = sel.getRangeAt(0);
          const intersects = range.intersectsNode(containerRef.current);
          setIsCrossedBySelection(intersects);
        } catch {
          setIsCrossedBySelection(false);
        }
      };

      document.addEventListener('selectionchange', handleSelectionChange);
      return () => {
        document.removeEventListener('selectionchange', handleSelectionChange);
      };
    }, []);

    // Copy Word equation block(s)
    const handleCopyWord = useCallback(
      async (e?: React.MouseEvent) => {
        if (e) e.stopPropagation();

        const mathmls = formulaStore.getSelectedMathMls(id);
        const ommls = formulaStore.getSelectedOmmls(id);
        if (mathmls.length === 0) return;

        // Clean Presentation MathML XML payload (合并为合法的单根 XML，支持 Word/WPS 解析多行公式)
        const combinedMathMl = combineMathMlsForWord(mathmls);
        // Combined OMML XML blocks
        const combinedOmml = ommls.join('\n');

        // Microsoft Word / WPS Office native HTML payload containing OMML
        const wordHtml = `<!DOCTYPE html><html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"><head><meta charset="utf-8"/></head><body><!--StartFragment--><p class="MsoNormal"><m:oMathPara>${combinedOmml}</m:oMathPara></p><!--EndFragment--></body></html>`;

        // 1. Send to native macOS App bridge (NSPasteboard) with public.html, public.mathml, public.mathml.presentation, and application/mathml+xml
        let bridged = false;
        try {
          if ((window as any).webkit?.messageHandlers?.copyWordEquation) {
            (window as any).webkit.messageHandlers.copyWordEquation.postMessage({
              html: wordHtml,
              mathml: combinedMathMl,
              plainText: combinedMathMl,
            });
            bridged = true;
          }
        } catch {
          bridged = false;
        }

        // 2. Fallback to web clipboard if not running in native Mac app
        if (!bridged) {
          try {
            if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
              const item = new ClipboardItem({
                'text/html': new Blob([wordHtml], { type: 'text/html' }),
                'text/plain': new Blob([combinedMathMl], { type: 'text/plain' }),
              });
              await navigator.clipboard.write([item]);
            } else {
              await navigator.clipboard.writeText(combinedMathMl);
            }
          } catch (err) {
            console.error('Failed to copy MathML:', err);
          }
        }

        setCopiedType('word');
        if (copiedTimeoutRef.current) clearTimeout(copiedTimeoutRef.current);
        copiedTimeoutRef.current = setTimeout(() => {
          setCopiedType(null);
        }, 2000);
      },
      [id]
    );

    // Copy LaTeX source ($...$ or $$...$$)
    const handleCopyLatex = useCallback(
      async (e?: React.MouseEvent) => {
        if (e) e.stopPropagation();

        const formattedLatexs = formulaStore.getSelectedFormattedLatexs(id);
        if (formattedLatexs.length === 0) return;

        const combinedLatex = formattedLatexs.join('\n\n');

        // 1. Send to native macOS App bridge if available
        let bridged = false;
        try {
          if ((window as any).webkit?.messageHandlers?.copyRichData) {
            (window as any).webkit.messageHandlers.copyRichData.postMessage({
              plainText: combinedLatex,
            });
            bridged = true;
          }
        } catch {
          bridged = false;
        }

        // 2. Web Clipboard API fallback
        if (!bridged) {
          try {
            await navigator.clipboard.writeText(combinedLatex);
          } catch (err) {
            console.error('Failed to copy LaTeX:', err);
          }
        }

        setCopiedType('latex');
        if (copiedTimeoutRef.current) clearTimeout(copiedTimeoutRef.current);
        copiedTimeoutRef.current = setTimeout(() => {
          setCopiedType(null);
        }, 2000);
      },
      [id]
    );

    // Global listener: Click outside to deselect, or Cmd+C / Escape
    useEffect(() => {
      const handleGlobalMouseDown = (e: MouseEvent) => {
        const target = e.target as HTMLElement | null;
        if (target && target.closest?.('.interactive-math')) {
          return;
        }
        // 如果按住 Command/Ctrl/Shift 键，用户是在进行跨区域多选（如选中公式后 ⌘-划选文本），不应清除公式选中
        if (e.metaKey || e.ctrlKey || e.shiftKey) {
          return;
        }
        formulaStore.clearSelection();
      };

      const handleGlobalKeyDown = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
          formulaStore.clearSelection();
          return;
        }

        // Cmd + Shift + C: 快捷键复制 Word 原生公式块 (MathML / OMML)
        if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'c') {
          const sel = window.getSelection();
          if (formulaStore.isToolbarActive(id) && (!sel || sel.isCollapsed)) {
            e.preventDefault();
            e.stopPropagation();
            handleCopyWord();
            return;
          }
        }

        // Cmd + C: 默认快捷键复制 LaTeX 原文源码 ($...$ 或 $$...$$)
        if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'c') {
          const sel = window.getSelection();
          if (formulaStore.isToolbarActive(id) && (!sel || sel.isCollapsed)) {
            e.preventDefault();
            e.stopPropagation();
            handleCopyLatex();
            return;
          }
        }
      };

      document.addEventListener('mousedown', handleGlobalMouseDown);
      window.addEventListener('keydown', handleGlobalKeyDown);

      return () => {
        document.removeEventListener('mousedown', handleGlobalMouseDown);
        window.removeEventListener('keydown', handleGlobalKeyDown);
      };
    }, [id, handleCopyLatex, handleCopyWord]);

    // Cleanup timeout on unmount
    useEffect(() => {
      return () => {
        if (copiedTimeoutRef.current) clearTimeout(copiedTimeoutRef.current);
      };
    }, []);

    /** 当前可用区（工具条显示期间有效），供 measureToolbar 复用 */
    const boundsRef = useRef<ReturnType<typeof getVisibleBounds> | null>(null);

    /** 量一次并夹紧 / 换边。可被「每次渲染后」与「滚动 / resize」两条路径调用，必须幂等。 */
    const measureToolbar = useCallback(() => {
      const host = containerRef.current;
      const bounds = boundsRef.current;
      if (!host || !bounds) return;
      const el = host.querySelector('[data-math-toolbar]') as HTMLElement | null;
      if (!el) return;

      const hostRect = host.getBoundingClientRect();
      const barRect = el.getBoundingClientRect();
      const width = barRect.width;
      // 容器比工具条还窄的极端情况：至少保证左侧（贴近容器左缘）可见
      const rightLimit = bounds.right - bounds.left < width ? bounds.left + width : bounds.right;
      const naturalLeft = hostRect.left + hostRect.width / 2 - width / 2;
      const naturalRight = naturalLeft + width;
      let shift = 0;
      if (naturalLeft < bounds.left) {
        shift = bounds.left - naturalLeft;
      } else if (naturalRight > rightLimit) {
        shift = rightLimit - naturalRight;
      }
      setPopoverShift((prev) => (Math.abs(prev - shift) < 0.5 ? prev : shift));

      // 上方放不下（贴住裁剪容器顶边或原生拖拽带）就翻到公式下方
      const placement = pickVerticalPlacement(hostRect, barRect.height, bounds);
      setPopoverPlacement((prev) => (prev === placement ? prev : placement));
    }, []);

    /**
     * 内联工具条的**边界夹紧 + 垂直翻转**：只在会越出「可见区」时补偏移 / 换边。
     *
     * 可见区的定义与划选浮标**同一份实现**（`utils/floatingPanel`）：
     * 视口 ∩ 最近裁剪祖先的 padding box ∩ 窗口顶部原生 chrome。
     *
     * 为什么不能只看视口：主窗口对话列是 `.chat-scroller`（`overflow-x-hidden`，左侧还有 260px 侧栏），
     * Markdown 编辑器窗口的预览区在分栏时只占右半边、顶部还有 52px 原生拖拽带。
     * 公式贴着内容左/右缘时工具条会伸进被裁掉的一侧；贴顶时向上弹会被容器顶边切掉。
     *
     * 约束：
     *  - 用**自然几何**（公式中心 ± 半宽）算，与当前已应用的偏移无关，重复测量不会累加；
     *  - 不越界时 shift 恒为 0、placement 恒为 top → 渲染与改前逐像素相同；
     *  - 裁剪祖先只在开启时找一次（滚动时它的 rect 不变），滚动/尺寸变化只重量位置；
     *  - 工具条关闭即解绑全部监听/观察器。
     */
    useLayoutEffect(() => {
      if (!showToolbar || display || !containerRef.current) {
        boundsRef.current = null;
        setPopoverShift((prev) => (prev === 0 ? prev : 0));
        return;
      }
      const host = containerRef.current;

      const refreshBounds = () => {
        boundsRef.current = getVisibleBounds(host);
        measureToolbar();
      };

      boundsRef.current = getVisibleBounds(host);
      measureToolbar();
      window.addEventListener('resize', refreshBounds);
      window.addEventListener('scroll', measureToolbar, true);
      // 侧栏拖动 / 面板开合 / 分栏比例变化会让裁剪容器变宽变窄，没有 resize 事件，用观察器补
      const ro = new ResizeObserver(refreshBounds);
      ro.observe(boundsRef.current.clipNode ?? document.documentElement);
      return () => {
        window.removeEventListener('resize', refreshBounds);
        window.removeEventListener('scroll', measureToolbar, true);
        ro.disconnect();
      };
    }, [showToolbar, display, copiedType, selectedCount, measureToolbar]);

    /**
     * 每次渲染补量一次。
     *
     * 理由：公式在**选中状态下**被内容变化挪了位置（编辑器里改上方的文字最典型），
     * React 会复用同一个组件实例、`showToolbar` 也没变，上面那个带依赖的 effect 不会重跑，
     * 工具条就会停在旧的「上/下」判定上 —— 贴顶时仍然向上弹，被滚动容器整条裁掉。
     * 这里无依赖跑一次即可自愈；`measureToolbar` 的两个 setState 都带相等判断，不会死循环。
     */
    useLayoutEffect(() => {
      if (showToolbar && !display) measureToolbar();
    });

    const handleClick = (e: React.MouseEvent) => {
      e.stopPropagation();
      // 普通单选公式时清空原生文本选区，与普通文本点击逻辑统一（按住 Command/Ctrl/Shift 时支持多选并存）
      if (!e.metaKey && !e.ctrlKey && !e.shiftKey) {
        window.getSelection()?.removeAllRanges();
      }
      formulaStore.select(id, e.shiftKey || e.metaKey);
    };

    const handleContainerMouseDown = (e: React.MouseEvent) => {
      if (!e.metaKey && !e.ctrlKey && !e.shiftKey) {
        window.getSelection()?.removeAllRanges();
      }
    };

    const isEffectiveSelected = isSelected || isCrossedBySelection;

    const toolbarContent = (
      <div
        data-copy-ignore="true"
        onClick={(e) => e.stopPropagation()}
        className="flex items-center gap-1 select-none"
      >
        {/* Copy LaTeX button (Default primary action, Cmd+C) */}
        <button
          type="button"
          onClick={handleCopyLatex}
          title={
            isEn
              ? `Copy ${selectedCount > 1 ? selectedCount + ' ' : ''}LaTeX source (⌘C)`
              : `复制 ${selectedCount > 1 ? selectedCount + ' 个 ' : ''}LaTeX 原文 (⌘C)`
          }
          className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-medium text-zinc-600 dark:text-zinc-300 hover:text-zinc-900 dark:hover:text-white hover:bg-black/5 dark:hover:bg-white/10 transition-colors cursor-pointer"
        >
          {copiedType === 'latex' ? (
            <>
              <Check className="w-3.5 h-3.5 text-zinc-700 dark:text-zinc-200" />
              <span className="text-zinc-700 dark:text-zinc-200 font-semibold text-[10px]">
                {isEn ? 'Copied' : '已复制'}
              </span>
            </>
          ) : (
            <>
              <FileCode className="w-3.5 h-3.5 opacity-80" />
              <span>
                {isEn
                  ? selectedCount > 1
                    ? `LaTeX (${selectedCount})`
                    : 'LaTeX'
                  : selectedCount > 1
                  ? `原文 (${selectedCount})`
                  : '原文'}
              </span>
            </>
          )}
        </button>

        <span className="w-px h-3 bg-zinc-200 dark:bg-zinc-700 mx-0.5" />

        {/* Copy Word Equation block button (Secondary action, Shift+Cmd+C) */}
        <button
          type="button"
          onClick={handleCopyWord}
          title={
            isEn
              ? `Copy ${selectedCount > 1 ? selectedCount + ' ' : ''}Word Equation Block(s) (⇧⌘C)`
              : `复制 ${selectedCount > 1 ? selectedCount + ' 个 ' : ''}Word 原生公式块 (⇧⌘C)`
          }
          className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-medium text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 hover:bg-blue-50 dark:hover:bg-blue-950/50 transition-colors cursor-pointer"
        >
          {copiedType === 'word' ? (
            <>
              <Check className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400" />
              <span className="text-blue-600 dark:text-blue-400 font-semibold text-[10px]">
                {isEn ? 'Word Copied' : '已复制公式块'}
              </span>
            </>
          ) : (
            <>
              <Sigma className="w-3.5 h-3.5 text-blue-500 dark:text-blue-400" />
              <span>
                {isEn
                  ? selectedCount > 1
                    ? `Word (${selectedCount})`
                    : 'Word Equation'
                  : selectedCount > 1
                  ? `公式块 (${selectedCount})`
                  : '公式块'}
              </span>
            </>
          )}
        </button>
      </div>
    );

    if (display) {
      return (
        <div
          ref={containerRef as React.RefObject<HTMLDivElement>}
          data-math-selected={isSelected ? 'true' : undefined}
          onMouseEnter={() => setIsHovered(true)}
          onMouseLeave={() => setIsHovered(false)}
          onMouseDown={handleContainerMouseDown}
          onClick={handleClick}
          className={`interactive-math relative my-2.5 rounded-lg py-2.5 px-3 transition-all duration-150 select-none cursor-pointer max-w-full min-w-0 ${
            isEffectiveSelected
              ? 'border border-solid border-blue-500 bg-blue-50/70 dark:border-blue-400 dark:bg-blue-950/40 shadow-xs'
              : isHovered
              ? 'border border-dashed border-zinc-400 dark:border-zinc-500 bg-black/[0.02] dark:bg-white/[0.02]'
              : 'border border-dashed border-transparent'
          }`}
        >
          {showToolbar && (
            <div className="absolute top-2 right-2 z-20 px-1 py-0.5 rounded-md bg-white/95 dark:bg-[#1e2025]/95 border border-[#d0d7de] dark:border-[#383b42] shadow-sm backdrop-blur-xs">
              {toolbarContent}
            </div>
          )}
          <div className="overflow-x-auto overflow-y-hidden text-center max-w-full">{children}</div>
        </div>
      );
    }

    return (
      <span
        ref={containerRef as React.RefObject<HTMLSpanElement>}
        data-math-selected={isSelected ? 'true' : undefined}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
        onMouseDown={handleContainerMouseDown}
        onClick={handleClick}
        className={`interactive-math relative inline-block align-baseline rounded pl-1 pr-0.5 py-0.5 mx-0.5 transition-all duration-150 select-none cursor-pointer max-w-full ${
          isEffectiveSelected
            ? 'border border-solid border-blue-500 bg-blue-50/80 dark:border-blue-400 dark:bg-blue-950/40 shadow-xs'
            : isHovered
            ? 'border border-dashed border-zinc-400 dark:border-zinc-500 bg-black/[0.02] dark:bg-white/[0.02]'
            : 'border border-dashed border-transparent'
        }`}
      >
        {showToolbar && (
          <span
            data-math-toolbar="true"
            className={`absolute left-1/2 z-30 px-1 py-0.5 rounded-md bg-white dark:bg-[#1e2025] border border-[#d0d7de] dark:border-[#383b42] shadow-md text-xs whitespace-nowrap ${
              popoverPlacement === 'bottom' ? 'top-full mt-1.5' : 'bottom-full mb-1.5'
            }`}
            style={{ transform: `translateX(calc(-50% + ${popoverShift}px))` }}
          >
            {toolbarContent}
          </span>
        )}
        {/* KaTeX 的上下标 vlist 内部带有一个 2px 宽的定位占位（.vlist-s，配合 .vlist-t2 的
            margin-right:-2px 抵消布局），它会不可见地越出公式盒子右缘 2px。滚动容器一旦设了
            overflow-x:auto，这 2px 就会被当成"内容溢出"，导致每个小公式下方都出现一条无意义的
            横向滚动条。这里让滚动容器补 2px 右内边距（外层同步减少 2px，视觉与排版完全不变）来
            吸收该占位；真正的长公式仍会超出并正常横向滚动。 */}
        <span className="inline-block align-baseline max-w-full overflow-x-auto overflow-y-hidden align-bottom pr-0.5">{children}</span>
      </span>
    );
  }
);

InteractiveMath.displayName = 'InteractiveMath';
