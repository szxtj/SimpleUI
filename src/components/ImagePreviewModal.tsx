import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Image as ImageIcon,
  ExternalLink,
  Copy,
  Check,
  Download,
  ZoomIn,
  ZoomOut,
  RotateCcw,
  ChevronLeft,
  ChevronRight,
  X,
} from 'lucide-react';
import { useI18n } from '../i18n';

interface ImagePreviewModalProps {
  isOpen: boolean;
  onClose: () => void;
  images: string[];
  initialIndex?: number;
  isSpotlight?: boolean;
}

export const ImagePreviewModal: React.FC<ImagePreviewModalProps> = ({
  isOpen,
  onClose,
  images,
  initialIndex = 0,
  isSpotlight,
}) => {
  const { t } = useI18n();
  const [currentIndex, setCurrentIndex] = useState(initialIndex);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const dragStartRef = useRef({ x: 0, y: 0, panX: 0, panY: 0 });
  const [naturalSize, setNaturalSize] = useState<{ width: number; height: number } | null>(null);
  const [copied, setCopied] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const inSpotlight =
    isSpotlight ??
    (typeof window !== 'undefined' &&
      (window.location.hash === '#/spotlight' || window.location.search.includes('mode=spotlight')));

  // Sync initialIndex when modal opens or initialIndex changes
  useEffect(() => {
    if (isOpen) {
      setCurrentIndex(Math.max(0, Math.min(initialIndex, images.length - 1)));
      setZoom(1);
      setPan({ x: 0, y: 0 });
      setNaturalSize(null);
    }
  }, [isOpen, initialIndex, images]);

  // Reset zoom and pan when switching images
  const resetTransform = useCallback(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, []);

  const handlePrev = useCallback(() => {
    if (images.length <= 1) return;
    setCurrentIndex((prev) => (prev > 0 ? prev - 1 : images.length - 1));
    resetTransform();
  }, [images.length, resetTransform]);

  const handleNext = useCallback(() => {
    if (images.length <= 1) return;
    setCurrentIndex((prev) => (prev < images.length - 1 ? prev + 1 : 0));
    resetTransform();
  }, [images.length, resetTransform]);

  const handleZoomIn = useCallback(() => {
    setZoom((prev) => Math.min(prev + 0.25, 5));
  }, []);

  const handleZoomOut = useCallback(() => {
    setZoom((prev) => Math.max(prev - 0.25, 0.25));
  }, []);

  // Keyboard navigation & shortcuts
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        e.preventDefault();
        onClose();
      } else if (e.key === 'ArrowLeft') {
        e.stopPropagation();
        e.preventDefault();
        handlePrev();
      } else if (e.key === 'ArrowRight') {
        e.stopPropagation();
        e.preventDefault();
        handleNext();
      } else if (e.key === '+' || e.key === '=') {
        e.stopPropagation();
        e.preventDefault();
        handleZoomIn();
      } else if (e.key === '-' || e.key === '_') {
        e.stopPropagation();
        e.preventDefault();
        handleZoomOut();
      } else if (e.key === '0' || e.key === 'r') {
        e.stopPropagation();
        e.preventDefault();
        resetTransform();
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [isOpen, onClose, handlePrev, handleNext, handleZoomIn, handleZoomOut, resetTransform]);

  // Mouse wheel & trackpad pinch zoom
  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    if (e.ctrlKey) {
      // 触控板两指缩放手势（Trackpad Pinch）：大幅降低灵敏度，平滑阻尼变焦
      const factor = 1 - e.deltaY * 0.003;
      setZoom((prev) => {
        const next = Math.max(0.25, Math.min(prev * factor, 5));
        if (next === 1) setPan({ x: 0, y: 0 });
        return next;
      });
    } else if (zoom > 1) {
      // 放大状态下，两指滑动平滑平移画面 (Pan)
      setPan((prev) => ({
        x: prev.x - e.deltaX * 0.8,
        y: prev.y - e.deltaY * 0.8,
      }));
    } else {
      // 普通鼠标滚轮：轻微平滑变焦
      const delta = -Math.sign(e.deltaY) * 0.1;
      setZoom((prev) => {
        const next = Math.max(0.25, Math.min(prev + delta, 5));
        if (next === 1) setPan({ x: 0, y: 0 });
        return next;
      });
    }
  };

  // Mouse drag to pan
  const handleMouseDown = (e: React.MouseEvent) => {
    if (zoom <= 1) return;
    e.preventDefault();
    setIsDragging(true);
    dragStartRef.current = {
      x: e.clientX,
      y: e.clientY,
      panX: pan.x,
      panY: pan.y,
    };
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isDragging) return;
    e.preventDefault();
    const dx = e.clientX - dragStartRef.current.x;
    const dy = e.clientY - dragStartRef.current.y;
    setPan({
      x: dragStartRef.current.panX + dx,
      y: dragStartRef.current.panY + dy,
    });
  };

  const handleMouseUp = () => {
    setIsDragging(false);
  };

  // Double click to toggle between fit (1x) and 2x
  const handleDoubleClick = () => {
    if (zoom === 1) {
      setZoom(2);
    } else {
      resetTransform();
    }
  };

  if (!isOpen || images.length === 0) return null;

  const currentUrl = images[currentIndex] || '';

  // Copy Image to clipboard
  const handleCopyImage = async () => {
    if (!currentUrl) return;
    try {
      const res = await fetch(currentUrl);
      const blob = await res.blob();
      if (blob.type === 'image/png') {
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      } else {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.src = currentUrl;
        await new Promise((resolve, reject) => {
          img.onload = resolve;
          img.onerror = reject;
        });
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext('2d');
        ctx?.drawImage(img, 0, 0);
        const pngBlob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
        if (pngBlob) {
          await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob })]);
        } else {
          await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
        }
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.warn('Failed to copy image blob, falling back to URL:', err);
      try {
        await navigator.clipboard.writeText(currentUrl);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } catch (e) {
        console.error('Failed to copy image text:', e);
      }
    }
  };

  // Download Image (via macOS Native NSSavePanel or web fallback)
  const handleDownloadImage = () => {
    if (!currentUrl) return;
    try {
      if ((window as any).webkit?.messageHandlers?.saveImage) {
        (window as any).webkit.messageHandlers.saveImage.postMessage({
          url: currentUrl,
        });
        return;
      }
    } catch (err) {
      console.warn('Native saveImage failed, falling back to browser download:', err);
    }

    // Web fallback
    const link = document.createElement('a');
    link.href = currentUrl;
    link.download = `SimpleUI_Image_${Date.now()}.png`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  // Open with macOS Native Preview.app
  const handleOpenSystemPreview = () => {
    if (!currentUrl) return;
    try {
      if ((window as any).webkit?.messageHandlers?.openImageInPreview) {
        (window as any).webkit.messageHandlers.openImageInPreview.postMessage({
          url: currentUrl,
        });
        return;
      }
    } catch (err) {
      console.warn('Native openImageInPreview failed:', err);
    }
    // Web browser fallback
    window.open(currentUrl, '_blank');
  };

  const imageStatsText = [
    images.length > 1 ? `${currentIndex + 1} / ${images.length}` : '',
    naturalSize ? `${naturalSize.width} × ${naturalSize.height}` : '',
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <div
      className={`fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-5 select-none animate-in fade-in duration-150 ${
        inSpotlight ? 'rounded-[22px] overflow-hidden' : ''
      }`}
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60 dark:bg-black/75 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Dialog Card */}
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ containerType: 'inline-size' }}
        className={`relative z-10 w-full flex flex-col rounded-2xl bg-white dark:bg-[#1e2025] border border-black/10 dark:border-[#333640] shadow-2xl overflow-hidden transition-all ${
          inSpotlight
            ? 'max-w-[460px] h-[520px] max-h-[88vh]'
            : 'max-w-4xl h-[680px] max-h-[88vh]'
        }`}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-3 sm:px-4 py-2.5 sm:py-3 border-b border-black/5 dark:border-white/5 select-none gap-2">
          {/* Left: Icon & Title & Stats */}
          <div className="flex items-center gap-2 sm:gap-2.5 min-w-0 flex-1">
            <div className="w-7 h-7 sm:w-8 sm:h-8 rounded-lg bg-zinc-100 dark:bg-white/10 text-zinc-600 dark:text-zinc-300 flex items-center justify-center flex-shrink-0">
              <ImageIcon className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
            </div>
            <div className="flex items-baseline gap-1.5 sm:gap-2 min-w-0 overflow-hidden">
              <span className="font-semibold text-xs sm:text-sm text-[#1f2328] dark:text-[#f1f3f7] tracking-tight whitespace-nowrap flex-shrink-0">
                {t('imagePreview')}
              </span>
              {!inSpotlight && imageStatsText && (
                <span className="hidden cq-md:inline-block sm:inline-block text-[11px] font-mono text-zinc-400 dark:text-zinc-500 truncate whitespace-nowrap">
                  {imageStatsText}
                </span>
              )}
            </div>
          </div>

          {/* Right: Actions (统一全为方形图标按钮，hover 显示原生 Tooltip，彻底消除窄窗口重叠) */}
          <div className="flex items-center gap-1 sm:gap-1.5 flex-shrink-0">
            {/* Zoom Controls */}
            <div className="flex items-center rounded-lg bg-black/5 dark:bg-white/5 p-0.5 border border-black/5 dark:border-white/5">
              <button
                type="button"
                onClick={handleZoomOut}
                disabled={zoom <= 0.25}
                className="w-7 h-7 sm:w-8 sm:h-8 rounded flex items-center justify-center text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200 disabled:opacity-30 transition-colors cursor-pointer"
                title={t('zoomOut')}
              >
                <ZoomOut className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onClick={resetTransform}
                className="px-1.5 h-7 sm:h-8 flex items-center justify-center text-[11px] font-mono font-medium text-zinc-600 dark:text-zinc-300 hover:text-zinc-900 dark:hover:text-white transition-colors cursor-pointer"
                title={t('resetZoom')}
              >
                {Math.round(zoom * 100)}%
              </button>
              <button
                type="button"
                onClick={handleZoomIn}
                disabled={zoom >= 5}
                className="w-7 h-7 sm:w-8 sm:h-8 rounded flex items-center justify-center text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200 disabled:opacity-30 transition-colors cursor-pointer"
                title={t('zoomIn')}
              >
                <ZoomIn className="w-3.5 h-3.5" />
              </button>
            </div>

            {/* Reset ratio (shown if zoomed) */}
            {zoom !== 1 && (
              <button
                type="button"
                onClick={resetTransform}
                className="w-7 h-7 sm:w-8 sm:h-8 rounded-lg flex items-center justify-center text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200 hover:bg-black/5 dark:hover:bg-white/5 transition-colors cursor-pointer"
                title={t('resetZoom')}
              >
                <RotateCcw className="w-3.5 h-3.5" />
              </button>
            )}

            {/* Copy image (Square Icon Button) */}
            <button
              type="button"
              onClick={handleCopyImage}
              className={`w-7 h-7 sm:w-8 sm:h-8 rounded-lg flex items-center justify-center transition-all cursor-pointer ${
                copied
                  ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20'
                  : 'bg-black/5 hover:bg-black/10 dark:bg-white/5 dark:hover:bg-white/10 text-zinc-600 hover:text-zinc-900 dark:text-zinc-300 dark:hover:text-white border border-transparent'
              }`}
              title={copied ? t('copiedImage') : t('copyImageTooltip')}
            >
              {copied ? (
                <Check className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
              ) : (
                <Copy className="w-3.5 h-3.5" />
              )}
            </button>

            {/* Download Image (Square Icon Button) */}
            <button
              type="button"
              onClick={handleDownloadImage}
              className="w-7 h-7 sm:w-8 sm:h-8 rounded-lg flex items-center justify-center text-zinc-600 hover:text-zinc-900 dark:text-zinc-300 dark:hover:text-white bg-black/5 hover:bg-black/10 dark:bg-white/5 dark:hover:bg-white/10 transition-colors cursor-pointer border border-transparent"
              title={t('downloadImage')}
            >
              <Download className="w-3.5 h-3.5" />
            </button>

            {/* Open in macOS System Preview (Square Icon Button) */}
            <button
              type="button"
              onClick={handleOpenSystemPreview}
              className="w-7 h-7 sm:w-8 sm:h-8 rounded-lg flex items-center justify-center text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300 bg-black/5 hover:bg-black/10 dark:bg-white/5 dark:hover:bg-white/10 transition-colors cursor-pointer border border-transparent"
              title={t('systemPreviewTooltip')}
            >
              <ExternalLink className="w-3.5 h-3.5" />
            </button>

            {/* Close Button (Square Icon Button) */}
            <button
              type="button"
              onClick={onClose}
              className="w-7 h-7 sm:w-8 sm:h-8 rounded-lg flex items-center justify-center text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-black/5 dark:hover:bg-white/5 transition-colors cursor-pointer"
              title={t('close')}
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Content Body Container */}
        <div className="flex-1 min-h-0 p-3 flex flex-col">
          <div
            ref={containerRef}
            onWheel={handleWheel}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseUp}
            onDoubleClick={handleDoubleClick}
            className={`flex-1 min-h-0 rounded-xl border border-black/5 dark:border-white/5 bg-[#0f1013] dark:bg-[#0c0d10] overflow-hidden flex items-center justify-center relative select-none ${
              zoom > 1 ? (isDragging ? 'cursor-grabbing' : 'cursor-grab') : 'cursor-zoom-in'
            }`}
          >
            {/* The Image Element */}
            {currentUrl && (
              <img
                src={currentUrl}
                alt="preview"
                draggable={false}
                onLoad={(e) => {
                  const target = e.currentTarget;
                  setNaturalSize({ width: target.naturalWidth, height: target.naturalHeight });
                }}
                style={{
                  transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
                  transition: isDragging ? 'none' : 'transform 0.15s ease-out',
                  transformOrigin: 'center center',
                }}
                className="max-w-[94%] max-h-[94%] object-contain select-none pointer-events-none drop-shadow-md"
              />
            )}

            {/* Previous Image Chevron */}
            {images.length > 1 && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  handlePrev();
                }}
                className="absolute left-3 top-1/2 -translate-y-1/2 p-2 rounded-full bg-black/40 hover:bg-black/70 text-white backdrop-blur-md transition-all shadow-lg cursor-pointer border border-white/10"
                title="Previous (←)"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
            )}

            {/* Next Image Chevron */}
            {images.length > 1 && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  handleNext();
                }}
                className="absolute right-3 top-1/2 -translate-y-1/2 p-2 rounded-full bg-black/40 hover:bg-black/70 text-white backdrop-blur-md transition-all shadow-lg cursor-pointer border border-white/10"
                title="Next (→)"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>

        {/* Subtle Footer Hint: 仅在大窗口显示，小窗口 (inSpotlight) 下彻底去除，防止文字折叠挤压 */}
        {!inSpotlight && (
          <div className="px-4 pb-3 flex items-center justify-between text-[11px] text-zinc-400 dark:text-zinc-500 select-none">
            <span className="truncate mr-2">{t('imagePreviewHint')}</span>
            <span className="font-mono flex-shrink-0">{Math.round(zoom * 100)}%</span>
          </div>
        )}
      </div>
    </div>
  );
};
