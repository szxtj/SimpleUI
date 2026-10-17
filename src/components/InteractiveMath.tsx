import React, { useState, useRef, useEffect, useCallback, useId } from 'react';
import { FileCode, Sigma, Check } from 'lucide-react';
import { useI18n } from '../i18n';
import {
  extractCleanMathMlForWord,
  extractOmmlForWord,
  combineMathMlsForWord,
} from '../utils/selectionToMarkdown';

interface FormulaEntry {
  id: string;
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
    }, [id, getRawLatex, getCleanMathMl, getOmml]);

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

        const latexs = formulaStore.getSelectedLatexs(id);
        if (latexs.length === 0) return;

        const combinedLatex = latexs
          .map((raw) => (display ? `$$\n${raw}\n$$` : `$${raw}$`))
          .join('\n\n');

        try {
          await navigator.clipboard.writeText(combinedLatex);
        } catch (err) {
          console.error('Failed to copy LaTeX:', err);
        }

        setCopiedType('latex');
        if (copiedTimeoutRef.current) clearTimeout(copiedTimeoutRef.current);
        copiedTimeoutRef.current = setTimeout(() => {
          setCopiedType(null);
        }, 2000);
      },
      [display, id]
    );

    // Global listener: Click outside to deselect, or Cmd+C / Escape
    useEffect(() => {
      const handleGlobalMouseDown = (e: MouseEvent) => {
        const target = e.target as HTMLElement | null;
        if (target && target.closest?.('.interactive-math')) {
          return;
        }
        formulaStore.clearSelection();
      };

      const handleGlobalKeyDown = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
          formulaStore.clearSelection();
          return;
        }

        // Cmd + C when formula(s) are selected and no text is selected
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'c') {
          const sel = window.getSelection();
          if (formulaStore.isToolbarActive(id) && (!sel || sel.isCollapsed)) {
            e.preventDefault();
            e.stopPropagation();
            handleCopyWord();
          }
        }
      };

      document.addEventListener('mousedown', handleGlobalMouseDown);
      window.addEventListener('keydown', handleGlobalKeyDown);

      return () => {
        document.removeEventListener('mousedown', handleGlobalMouseDown);
        window.removeEventListener('keydown', handleGlobalKeyDown);
      };
    }, [id, handleCopyWord]);

    // Cleanup timeout on unmount
    useEffect(() => {
      return () => {
        if (copiedTimeoutRef.current) clearTimeout(copiedTimeoutRef.current);
      };
    }, []);

    // Calculate smart popover placement for inline math
    useEffect(() => {
      if (showToolbar && containerRef.current && !display) {
        const rect = containerRef.current.getBoundingClientRect();
        if (rect.top < 65) {
          setPopoverPlacement('bottom');
        } else {
          setPopoverPlacement('top');
        }
      }
    }, [showToolbar, display]);

    const handleClick = (e: React.MouseEvent) => {
      e.stopPropagation();
      formulaStore.select(id, e.shiftKey || e.metaKey);
    };

    const isEffectiveSelected = isSelected || isCrossedBySelection;

    const toolbarContent = (
      <div
        data-copy-ignore="true"
        onClick={(e) => e.stopPropagation()}
        className="flex items-center gap-1 select-none"
      >
        {/* Copy LaTeX button */}
        <button
          type="button"
          onClick={handleCopyLatex}
          title={
            isEn
              ? `Copy ${selectedCount > 1 ? selectedCount + ' ' : ''}LaTeX source`
              : `复制 ${selectedCount > 1 ? selectedCount + ' 个 ' : ''}LaTeX 原文`
          }
          className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-medium text-zinc-600 dark:text-zinc-300 hover:text-zinc-900 dark:hover:text-white hover:bg-black/5 dark:hover:bg-white/10 transition-colors cursor-pointer"
        >
          {copiedType === 'latex' ? (
            <>
              <Check className="w-3.5 h-3.5 text-emerald-500" />
              <span className="text-emerald-600 dark:text-emerald-400 font-semibold text-[10px]">
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

        {/* Copy Word Equation block button */}
        <button
          type="button"
          onClick={handleCopyWord}
          title={
            isEn
              ? `Copy ${selectedCount > 1 ? selectedCount + ' ' : ''}Word Equation Block(s)`
              : `复制 ${selectedCount > 1 ? selectedCount + ' 个 ' : ''}Word 原生公式块（直接在 Word / PPT 中粘贴）`
          }
          className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-medium text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 hover:bg-blue-50 dark:hover:bg-blue-950/50 transition-colors cursor-pointer"
        >
          {copiedType === 'word' ? (
            <>
              <Check className="w-3.5 h-3.5 text-emerald-500" />
              <span className="text-emerald-600 dark:text-emerald-400 font-semibold text-[10px]">
                {isEn ? 'Word Copied' : '已复制公式块'}
              </span>
            </>
          ) : (
            <>
              <Sigma className="w-3.5 h-3.5 text-blue-500" />
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
          onMouseEnter={() => setIsHovered(true)}
          onMouseLeave={() => setIsHovered(false)}
          onClick={handleClick}
          className={`interactive-math relative my-2.5 rounded-lg py-2.5 px-3 transition-all duration-150 select-none cursor-pointer ${
            isEffectiveSelected
              ? 'border border-solid border-blue-500 bg-blue-50/70 dark:border-blue-400 dark:bg-blue-950/40 shadow-xs'
              : isHovered
              ? 'border border-dashed border-zinc-400 dark:border-zinc-500 bg-black/[0.02] dark:bg-white/[0.02]'
              : 'border border-transparent'
          }`}
        >
          {showToolbar && (
            <div className="absolute top-2 right-2 z-20 px-1 py-0.5 rounded-md bg-white/95 dark:bg-[#1e2025]/95 border border-[#d0d7de] dark:border-[#383b42] shadow-sm backdrop-blur-xs">
              {toolbarContent}
            </div>
          )}
          <div className="overflow-x-auto overflow-y-hidden text-center">{children}</div>
        </div>
      );
    }

    return (
      <span
        ref={containerRef as React.RefObject<HTMLSpanElement>}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
        onClick={handleClick}
        className={`interactive-math relative inline-block align-baseline rounded px-1 py-0.5 mx-0.5 transition-all duration-150 select-none cursor-pointer ${
          isEffectiveSelected
            ? 'border border-solid border-blue-500 bg-blue-50/80 dark:border-blue-400 dark:bg-blue-950/40 shadow-xs'
            : isHovered
            ? 'border border-dashed border-zinc-400 dark:border-zinc-500 bg-black/[0.02] dark:bg-white/[0.02]'
            : 'border border-transparent'
        }`}
      >
        {showToolbar && (
          <span
            className={`absolute left-1/2 -translate-x-1/2 z-30 px-1 py-0.5 rounded-md bg-white dark:bg-[#1e2025] border border-[#d0d7de] dark:border-[#383b42] shadow-md text-xs whitespace-nowrap ${
              popoverPlacement === 'bottom' ? 'top-full mt-1.5' : 'bottom-full mb-1.5'
            }`}
          >
            {toolbarContent}
          </span>
        )}
        <span className="inline-block align-baseline">{children}</span>
      </span>
    );
  }
);

InteractiveMath.displayName = 'InteractiveMath';
