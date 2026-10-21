import React, { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
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
import type { PageChrome } from '../types/panel';
import { pageHeaderClass } from './pageHeader';

interface ImagePreviewModalProps {
  isOpen: boolean;
  onClose: () => void;
  images: string[];
  initialIndex?: number;
  isSpotlight?: boolean;
  /**
   * 嵌入模式：作为右侧面板 / 浮窗的「图片页」渲染，而不是全屏弹窗。
   * 只换外壳（不铺背景遮罩、不居中、不投影），**缩放/平移/画廊/复制/下载全部原样保留**。
   */
  embedded?: boolean;
  /** 嵌入模式下当前页是否可见（不可见时不抢键盘快捷键、不响应滚轮） */
  active?: boolean;
  /** 嵌入模式下由外层页面注入的页头插槽（← / ✕） */
  chrome?: PageChrome;
}

// 辅助函数：计算当前缩放和尺寸下的有效平移边界
const getPanBounds = (
  targetZoom: number,
  containerW: number,
  containerH: number,
  natW: number,
  natH: number,
  fitScale: number
) => {
  const renderedW = natW * fitScale * targetZoom;
  const renderedH = natH * fitScale * targetZoom;

  let minX = 0;
  let maxX = 0;
  if (renderedW > containerW) {
    const overflowX = (renderedW - containerW) / 2;
    minX = -overflowX;
    maxX = overflowX;
  }

  let minY = 0;
  let maxY = 0;
  if (renderedH > containerH) {
    const overflowY = (renderedH - containerH) / 2;
    minY = -overflowY;
    maxY = overflowY;
  }

  return { minX, maxX, minY, maxY, renderedW, renderedH };
};

// 弹性阻尼：超出边界时产生平滑的橡皮筋拉伸手感
const applyRubberBand = (val: number, min: number, max: number, factor = 0.28) => {
  if (val < min) {
    return min - (min - val) * factor;
  }
  if (val > max) {
    return max + (val - max) * factor;
  }
  return val;
};

const clamp = (val: number, min: number, max: number) => {
  return Math.min(max, Math.max(min, val));
};

export const ImagePreviewModal: React.FC<ImagePreviewModalProps> = ({
  isOpen,
  onClose,
  images,
  initialIndex = 0,
  isSpotlight,
  embedded = false,
  active = true,
  chrome,
}) => {
  const { t } = useI18n();
  const [currentIndex, setCurrentIndex] = useState(initialIndex);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [naturalSize, setNaturalSize] = useState<{ width: number; height: number } | null>(null);
  const [copied, setCopied] = useState(false);
  const [containerSize, setContainerSize] = useState<{ width: number; height: number }>({ width: 0, height: 0 });

  const containerRef = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const transformRef = useRef({ x: 0, y: 0, zoom: 1 });
  const isDraggingRef = useRef(false);
  const dragStartRef = useRef({ clientX: 0, clientY: 0, startPanX: 0, startPanY: 0 });
  const rafIdRef = useRef<number | null>(null);
  const wheelEndTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const inSpotlight =
    isSpotlight ??
    (typeof window !== 'undefined' &&
      (window.location.hash === '#/spotlight' || window.location.search.includes('mode=spotlight')));

  const currentUrl = images[currentIndex] || '';

  // 监听容器真实尺寸变化
  useEffect(() => {
    if (!isOpen || !containerRef.current) return;
    const updateSize = () => {
      if (!containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        setContainerSize({ width: rect.width, height: rect.height });
      }
    };
    updateSize();

    const ro = new ResizeObserver(() => {
      updateSize();
    });
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, [isOpen]);

  // 计算适合视口的基础缩放比（Fit Scale）
  const getFitScale = useCallback(
    (natW: number, natH: number, contW: number, contH: number) => {
      if (!natW || !natH || !contW || !contH) return 1;
      const availW = contW * 0.94;
      const availH = contH * 0.94;
      const fitRatio = Math.min(availW / natW, availH / natH);
      // 若原图小于容器，最多适度缩放 1.5x，避免微小图标失真；若大图则缩小至适合容器
      return fitRatio < 1 ? fitRatio : Math.min(fitRatio, 1.5);
    },
    []
  );

  // 直接驱动 DOM 变换（硬件加速 3D 合成，彻底避免 React 每帧重渲染导致的卡顿）
  const applyTransform = useCallback(
    (x: number, y: number, currentZoom: number, animate = false) => {
      transformRef.current = { x, y, zoom: currentZoom };
      if (!imgRef.current || !naturalSize || !containerSize.width) return;

      const fitScale = getFitScale(
        naturalSize.width,
        naturalSize.height,
        containerSize.width,
        containerSize.height
      );
      const actualScale = fitScale * currentZoom;

      imgRef.current.style.transition = animate
        ? 'transform 0.22s cubic-bezier(0.16, 1, 0.3, 1)'
        : 'none';
      imgRef.current.style.transform = `translate3d(${x}px, ${y}px, 0px) scale(${actualScale})`;
    },
    [naturalSize, containerSize, getFitScale]
  );

  // 重置变换状态
  const resetTransform = useCallback(() => {
    applyTransform(0, 0, 1, true);
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, [applyTransform]);

  // 弹窗开启或切换索引时同步初始化（**不动 naturalSize**：
  // 它属于"当前这张图"，由下面的预读 effect 按 currentUrl 负责。
  // 早前在这里 setNaturalSize(null)，只要父级 render 让 images 换了身份，
  // 就会把已经量好的尺寸清掉 → 缩放按钮点了没反应。）
  useEffect(() => {
    if (isOpen) {
      setCurrentIndex(Math.max(0, Math.min(initialIndex, images.length - 1)));
      transformRef.current = { x: 0, y: 0, zoom: 1 };
      setZoom(1);
      setPan({ x: 0, y: 0 });
    }
  }, [isOpen, initialIndex, images]);

  // 预读并同步图片原始物理尺寸（支持缓存立即命中）
  useEffect(() => {
    if (!isOpen || !currentUrl) return;
    setNaturalSize(null); // 换图才重置
    const img = new Image();
    img.src = currentUrl;
    if (img.complete && img.naturalWidth && img.naturalHeight) {
      setNaturalSize({ width: img.naturalWidth, height: img.naturalHeight });
    } else {
      img.onload = () => {
        setNaturalSize({ width: img.naturalWidth, height: img.naturalHeight });
      };
    }
  }, [isOpen, currentUrl]);

  // 当尺寸或图片就绪时校准渲染
  useEffect(() => {
    if (isOpen && naturalSize && containerSize.width && containerSize.height) {
      applyTransform(
        transformRef.current.x,
        transformRef.current.y,
        transformRef.current.zoom,
        false
      );
    }
  }, [isOpen, naturalSize, containerSize, applyTransform]);

  const handlePrev = useCallback(() => {
    if (images.length <= 1) return;
    setCurrentIndex((prev) => (prev > 0 ? prev - 1 : images.length - 1));
    resetTransform();
    setNaturalSize(null);
  }, [images.length, resetTransform]);

  const handleNext = useCallback(() => {
    if (images.length <= 1) return;
    setCurrentIndex((prev) => (prev < images.length - 1 ? prev + 1 : 0));
    resetTransform();
    setNaturalSize(null);
  }, [images.length, resetTransform]);

  // 按钮放大：平滑递增 0.35x
  const handleZoomIn = useCallback(() => {
    if (!naturalSize || !containerSize.width) return;
    const currentZoom = transformRef.current.zoom;
    const nextZoom = Math.min(currentZoom + 0.35, 8);

    const fitScale = getFitScale(
      naturalSize.width,
      naturalSize.height,
      containerSize.width,
      containerSize.height
    );
    const bounds = getPanBounds(
      nextZoom,
      containerSize.width,
      containerSize.height,
      naturalSize.width,
      naturalSize.height,
      fitScale
    );

    const clampedX = clamp(transformRef.current.x, bounds.minX, bounds.maxX);
    const clampedY = clamp(transformRef.current.y, bounds.minY, bounds.maxY);

    applyTransform(clampedX, clampedY, nextZoom, true);
    setZoom(nextZoom);
    setPan({ x: clampedX, y: clampedY });
  }, [naturalSize, containerSize, getFitScale, applyTransform]);

  // 按钮缩小：平滑递减 0.35x，缩小到 1x 时平滑归中
  const handleZoomOut = useCallback(() => {
    if (!naturalSize || !containerSize.width) return;
    const currentZoom = transformRef.current.zoom;
    const nextZoom = Math.max(currentZoom - 0.35, 0.25);

    const fitScale = getFitScale(
      naturalSize.width,
      naturalSize.height,
      containerSize.width,
      containerSize.height
    );
    const bounds = getPanBounds(
      nextZoom,
      containerSize.width,
      containerSize.height,
      naturalSize.width,
      naturalSize.height,
      fitScale
    );

    const clampedX = nextZoom <= 1.05 ? 0 : clamp(transformRef.current.x, bounds.minX, bounds.maxX);
    const clampedY = nextZoom <= 1.05 ? 0 : clamp(transformRef.current.y, bounds.minY, bounds.maxY);

    applyTransform(clampedX, clampedY, nextZoom, true);
    setZoom(nextZoom);
    setPan({ x: clampedX, y: clampedY });
  }, [naturalSize, containerSize, getFitScale, applyTransform]);

  const interactive = isOpen && active;

  // 快捷键支持（嵌入模式下只有当前可见的图片页可以抢键盘）
  useEffect(() => {
    if (!interactive) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (embedded) return; // 页面形态由标签 ✕ / 返回键关闭，Esc 不关标签
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
  }, [interactive, embedded, onClose, handlePrev, handleNext, handleZoomIn, handleZoomOut, resetTransform]);

  // 滚轮与触控板双指缩放：以鼠标焦点为中心（Focal-point Zoom），杜绝画面漂移
  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    if (!containerRef.current || !naturalSize || !containerSize.width) return;

    const containerRect = containerRef.current.getBoundingClientRect();
    const cursorRelX = e.clientX - (containerRect.left + containerRect.width / 2);
    const cursorRelY = e.clientY - (containerRect.top + containerRect.height / 2);

    const fitScale = getFitScale(
      naturalSize.width,
      naturalSize.height,
      containerSize.width,
      containerSize.height
    );
    const currentZoom = transformRef.current.zoom;
    const currentPan = { x: transformRef.current.x, y: transformRef.current.y };

    if (e.ctrlKey) {
      // 触控板双指捏合（Trackpad Pinch）：平滑阻尼变焦，以鼠标光标所在点放大
      const factor = 1 - e.deltaY * 0.006;
      const nextZoom = clamp(currentZoom * factor, 0.25, 8);

      const zoomRatio = nextZoom / currentZoom;
      const targetPanX = cursorRelX - (cursorRelX - currentPan.x) * zoomRatio;
      const targetPanY = cursorRelY - (cursorRelY - currentPan.y) * zoomRatio;

      const bounds = getPanBounds(
        nextZoom,
        containerSize.width,
        containerSize.height,
        naturalSize.width,
        naturalSize.height,
        fitScale
      );
      const clampedX = clamp(targetPanX, bounds.minX, bounds.maxX);
      const clampedY = clamp(targetPanY, bounds.minY, bounds.maxY);

      applyTransform(clampedX, clampedY, nextZoom, false);
    } else if (currentZoom > 1.05 && (Math.abs(e.deltaX) > 0 || Math.abs(e.deltaY) > 0)) {
      // 放大状态下双指平移画面（Pan）
      const nextPanX = currentPan.x - e.deltaX * 0.9;
      const nextPanY = currentPan.y - e.deltaY * 0.9;

      const bounds = getPanBounds(
        currentZoom,
        containerSize.width,
        containerSize.height,
        naturalSize.width,
        naturalSize.height,
        fitScale
      );
      const clampedX = clamp(nextPanX, bounds.minX, bounds.maxX);
      const clampedY = clamp(nextPanY, bounds.minY, bounds.maxY);

      applyTransform(clampedX, clampedY, currentZoom, false);
    } else {
      // 普通鼠标滚轮：轻微平滑变焦（以鼠标光标为焦点）
      const step = -Math.sign(e.deltaY) * 0.15;
      const nextZoom = clamp(currentZoom + step, 0.25, 8);

      const zoomRatio = nextZoom / currentZoom;
      const targetPanX = cursorRelX - (cursorRelX - currentPan.x) * zoomRatio;
      const targetPanY = cursorRelY - (cursorRelY - currentPan.y) * zoomRatio;

      const bounds = getPanBounds(
        nextZoom,
        containerSize.width,
        containerSize.height,
        naturalSize.width,
        naturalSize.height,
        fitScale
      );
      const clampedX = clamp(targetPanX, bounds.minX, bounds.maxX);
      const clampedY = clamp(targetPanY, bounds.minY, bounds.maxY);

      applyTransform(clampedX, clampedY, nextZoom, false);
    }

    // 防抖同步 React 状态，保持顶栏缩放文字精确更新
    if (wheelEndTimeoutRef.current) {
      clearTimeout(wheelEndTimeoutRef.current);
    }
    wheelEndTimeoutRef.current = setTimeout(() => {
      setZoom(transformRef.current.zoom);
      setPan({ x: transformRef.current.x, y: transformRef.current.y });
    }, 100);
  };

  // 指针拖拽（Pointer Capture 保证移出容器外仍平稳追踪，橡皮筋边界+吸附归中）
  const handlePointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();

    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    isDraggingRef.current = true;
    setIsDragging(true);

    dragStartRef.current = {
      clientX: e.clientX,
      clientY: e.clientY,
      startPanX: transformRef.current.x,
      startPanY: transformRef.current.y,
    };

    if (imgRef.current) {
      imgRef.current.style.transition = 'none';
    }
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!isDraggingRef.current || !naturalSize || !containerSize.width) return;
    e.preventDefault();

    const dx = e.clientX - dragStartRef.current.clientX;
    const dy = e.clientY - dragStartRef.current.clientY;

    const targetX = dragStartRef.current.startPanX + dx;
    const targetY = dragStartRef.current.startPanY + dy;

    const fitScale = getFitScale(
      naturalSize.width,
      naturalSize.height,
      containerSize.width,
      containerSize.height
    );
    const bounds = getPanBounds(
      transformRef.current.zoom,
      containerSize.width,
      containerSize.height,
      naturalSize.width,
      naturalSize.height,
      fitScale
    );

    const rubberX = applyRubberBand(targetX, bounds.minX, bounds.maxX);
    const rubberY = applyRubberBand(targetY, bounds.minY, bounds.maxY);

    if (rafIdRef.current) {
      cancelAnimationFrame(rafIdRef.current);
    }

    rafIdRef.current = requestAnimationFrame(() => {
      applyTransform(rubberX, rubberY, transformRef.current.zoom, false);
    });
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    if (!isDraggingRef.current) return;
    isDraggingRef.current = false;
    setIsDragging(false);

    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {}

    if (rafIdRef.current) {
      cancelAnimationFrame(rafIdRef.current);
    }

    if (!naturalSize || !containerSize.width) return;

    const fitScale = getFitScale(
      naturalSize.width,
      naturalSize.height,
      containerSize.width,
      containerSize.height
    );
    const bounds = getPanBounds(
      transformRef.current.zoom,
      containerSize.width,
      containerSize.height,
      naturalSize.width,
      naturalSize.height,
      fitScale
    );

    const clampedX = clamp(transformRef.current.x, bounds.minX, bounds.maxX);
    const clampedY = clamp(transformRef.current.y, bounds.minY, bounds.maxY);

    const needsSnap =
      clampedX !== transformRef.current.x || clampedY !== transformRef.current.y;
    applyTransform(clampedX, clampedY, transformRef.current.zoom, needsSnap);

    setPan({ x: clampedX, y: clampedY });
  };

  // 双击交互：在 1x 适合视口与 2.5x（或原图 1:1 像素级清晰度）之间平滑切换
  const handleDoubleClick = (e: React.MouseEvent) => {
    if (!containerRef.current || !naturalSize || !containerSize.width) return;

    const currentZoom = transformRef.current.zoom;
    if (currentZoom > 1.05) {
      resetTransform();
    } else {
      const containerRect = containerRef.current.getBoundingClientRect();
      const cursorRelX = e.clientX - (containerRect.left + containerRect.width / 2);
      const cursorRelY = e.clientY - (containerRect.top + containerRect.height / 2);

      const fitScale = getFitScale(
        naturalSize.width,
        naturalSize.height,
        containerSize.width,
        containerSize.height
      );

      // 若原图被大幅缩小展示，双击还原至接近 1:1 真实像素显示，最高 4x
      const targetZoom = fitScale < 0.5 ? Math.min(4, Math.max(2, 1 / fitScale)) : 2.5;

      const zoomRatio = targetZoom / currentZoom;
      const targetPanX = cursorRelX - cursorRelX * zoomRatio;
      const targetPanY = cursorRelY - cursorRelY * zoomRatio;

      const bounds = getPanBounds(
        targetZoom,
        containerSize.width,
        containerSize.height,
        naturalSize.width,
        naturalSize.height,
        fitScale
      );
      const clampedX = clamp(targetPanX, bounds.minX, bounds.maxX);
      const clampedY = clamp(targetPanY, bounds.minY, bounds.maxY);

      applyTransform(clampedX, clampedY, targetZoom, true);
      setZoom(targetZoom);
      setPan({ x: clampedX, y: clampedY });
    }
  };

  if (!isOpen || images.length === 0) return null;

  // 复制图片到剪贴板
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
        const pngBlob = await new Promise<Blob | null>((resolve) =>
          canvas.toBlob(resolve, 'image/png')
        );
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

  // 下载图片
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

    const link = document.createElement('a');
    link.href = currentUrl;
    link.download = `SimpleUI_Image_${Date.now()}.png`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  // 使用 macOS 原生「预览」应用打开
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
    window.open(currentUrl, '_blank');
  };

  const imageStatsText = [
    images.length > 1 ? `${currentIndex + 1} / ${images.length}` : '',
    naturalSize ? `${naturalSize.width} × ${naturalSize.height}` : '',
  ]
    .filter(Boolean)
    .join(' · ');

  const fitScale =
    naturalSize && containerSize.width
      ? getFitScale(
          naturalSize.width,
          naturalSize.height,
          containerSize.width,
          containerSize.height
        )
      : 1;

  const actualScale = fitScale * zoom;

  const dialogCard = (
    <div
      onClick={(e) => e.stopPropagation()}
      style={{ containerType: 'inline-size' }}
      className={
        embedded
          ? 'relative z-10 flex h-full w-full flex-col overflow-hidden bg-[#f8f9fb] dark:bg-[#1b1c20]'
          : `relative z-10 w-full flex flex-col rounded-2xl bg-white dark:bg-[#1e2025] border border-black/10 dark:border-[#333640] shadow-2xl overflow-hidden transition-all ${
              inSpotlight ? 'max-w-[460px] h-[520px] max-h-[88vh]' : 'max-w-4xl h-[680px] max-h-[88vh]'
            }`
      }
    >
        {/* Header */}
        <div
          className={
            embedded
              ? pageHeaderClass({ gap: 'gap-2', padding: chrome?.padding })
              : 'flex items-center justify-between border-b border-black/5 dark:border-white/5 select-none gap-2 px-3 sm:px-4 py-2.5 sm:py-3'
          }
        >
          {chrome?.leading}
          {/* Left: Icon & Title & Stats */}
          <div className="flex items-center gap-2 sm:gap-2.5 min-w-0 flex-1">
            <div className="w-7 h-7 sm:w-8 sm:h-8 rounded-lg bg-zinc-100 dark:bg-white/10 text-zinc-600 dark:text-zinc-300 flex items-center justify-center flex-shrink-0">
              <ImageIcon className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
            </div>
            <div className="flex items-baseline gap-1.5 sm:gap-2 min-w-0 overflow-hidden">
              {/* 窄面板（440）里按钮很占位置：让标题先截断，尺寸信息保持完整 */}
              <span className="hidden min-w-0 truncate font-semibold text-xs sm:text-sm text-[#1f2328] tracking-tight whitespace-nowrap cq-sm:block dark:text-[#f1f3f7]">
                {/* 页面形态用短名词（与标签同名），窄面板里才放得下后面的尺寸信息 */}
                {embedded ? t('panelTabImage') : t('imagePreview')}
              </span>
              {(!inSpotlight || embedded) && imageStatsText && (
                <span className="hidden flex-shrink-0 whitespace-nowrap text-[11px] font-mono text-zinc-400 cq-sm:inline dark:text-zinc-500">
                  {imageStatsText}
                </span>
              )}
            </div>
          </div>

          {/* Right: Actions */}
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
                disabled={zoom >= 8}
                className="w-7 h-7 sm:w-8 sm:h-8 rounded flex items-center justify-center text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200 disabled:opacity-30 transition-colors cursor-pointer"
                title={t('zoomIn')}
              >
                <ZoomIn className="w-3.5 h-3.5" />
              </button>
            </div>

            {/* Reset ratio button (shown if zoomed or panned) */}
            {(zoom !== 1 || pan.x !== 0 || pan.y !== 0) && (
              <button
                type="button"
                onClick={resetTransform}
                className="w-7 h-7 sm:w-8 sm:h-8 rounded-lg flex items-center justify-center text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200 hover:bg-black/5 dark:hover:bg-white/5 transition-colors cursor-pointer"
                title={t('resetZoom')}
              >
                <RotateCcw className="w-3.5 h-3.5" />
              </button>
            )}

            {/* Copy image */}
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

            {/* Download Image */}
            <button
              type="button"
              onClick={handleDownloadImage}
              className="w-7 h-7 sm:w-8 sm:h-8 rounded-lg flex items-center justify-center text-zinc-600 hover:text-zinc-900 dark:text-zinc-300 dark:hover:text-white bg-black/5 hover:bg-black/10 dark:bg-white/5 dark:hover:bg-white/10 transition-colors cursor-pointer border border-transparent"
              title={t('downloadImage')}
            >
              <Download className="w-3.5 h-3.5" />
            </button>

            {/* Open in macOS System Preview */}
            <button
              type="button"
              onClick={handleOpenSystemPreview}
              className="w-7 h-7 sm:w-8 sm:h-8 rounded-lg flex items-center justify-center text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300 bg-black/5 hover:bg-black/10 dark:bg-white/5 dark:hover:bg-white/10 transition-colors cursor-pointer border border-transparent"
              title={t('systemPreviewTooltip')}
            >
              <ExternalLink className="w-3.5 h-3.5" />
            </button>

            {/* Close Button（嵌入模式由页头 ✕ / 标签 ✕ 关闭，不再重复一颗） */}
            {!embedded && (
              <button
                type="button"
                onClick={onClose}
                className="w-7 h-7 sm:w-8 sm:h-8 rounded-lg flex items-center justify-center text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-black/5 dark:hover:bg-white/5 transition-colors cursor-pointer"
                title={t('close')}
              >
                <X className="w-4 h-4" />
              </button>
            )}
            {chrome?.trailing}
          </div>
        </div>

        {/* Content Body Container：画板背景随深浅色模式自动切换 */}
        <div className={`flex-1 min-h-0 flex flex-col ${embedded ? 'p-0' : 'p-3'}`}>
          <div
            ref={containerRef}
            onWheel={handleWheel}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
            onDoubleClick={handleDoubleClick}
            className={`relative flex-1 min-h-0 preview-canvas-bg overflow-hidden flex items-center justify-center select-none ${embedded ? '' : 'rounded-xl border border-black/5 dark:border-white/5'} ${
              zoom > 1.05 ? (isDragging ? 'cursor-grabbing' : 'cursor-grab') : 'cursor-zoom-in'
            }`}
            style={{ touchAction: 'none' }}
          >
            {/* The Image Element：以原图物理像素布局，硬件加速无损清晰放大 */}
            {currentUrl && (
              <img
                ref={imgRef}
                src={currentUrl}
                alt="preview"
                draggable={false}
                onLoad={(e) => {
                  const target = e.currentTarget;
                  if (target.naturalWidth && target.naturalHeight) {
                    setNaturalSize({
                      width: target.naturalWidth,
                      height: target.naturalHeight,
                    });
                  }
                }}
                style={{
                  width: naturalSize ? `${Math.min(naturalSize.width, 6144)}px` : 'auto',
                  height: naturalSize ? `${Math.min(naturalSize.height, 6144)}px` : 'auto',
                  maxWidth: naturalSize ? 'none' : '94%',
                  maxHeight: naturalSize ? 'none' : '94%',
                  objectFit: 'contain',
                  transform: naturalSize
                    ? `translate3d(${pan.x}px, ${pan.y}px, 0px) scale(${actualScale})`
                    : undefined,
                  transformOrigin: 'center center',
                  WebkitBackfaceVisibility: 'hidden',
                  backfaceVisibility: 'hidden',
                  imageRendering: 'auto',
                }}
                className="select-none pointer-events-none rounded-xs shadow-[0_2px_12px_rgba(0,0,0,0.08)] dark:shadow-[0_4px_24px_rgba(0,0,0,0.45)] border border-black/5 dark:border-white/5"
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
                className="absolute left-3.5 top-1/2 -translate-y-1/2 p-2 rounded-full bg-white/85 hover:bg-white text-zinc-700 dark:bg-black/50 dark:hover:bg-black/80 dark:text-white backdrop-blur-md transition-all shadow-md hover:shadow-lg cursor-pointer border border-black/10 dark:border-white/10 z-20"
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
                className="absolute right-3.5 top-1/2 -translate-y-1/2 p-2 rounded-full bg-white/85 hover:bg-white text-zinc-700 dark:bg-black/50 dark:hover:bg-black/80 dark:text-white backdrop-blur-md transition-all shadow-md hover:shadow-lg cursor-pointer border border-black/10 dark:border-white/10 z-20"
                title="Next (→)"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>

        {/* Subtle Footer Hint */}
        {(!inSpotlight || embedded) && (
          <div className={`flex items-center justify-between text-[11px] text-zinc-400 dark:text-zinc-500 select-none ${
            embedded ? 'px-3 py-1.5 border-t border-black/5 dark:border-white/5' : 'px-4 pb-3'
          }`}>
            <span className="truncate mr-2">
              {embedded ? t('imagePreviewPageHint') : t('imagePreviewHint')}
            </span>
            <span className="font-mono flex-shrink-0">{Math.round(zoom * 100)}%</span>
          </div>
        )}
      </div>
  );

  if (embedded) {
    return (
      <div className="relative flex h-full w-full flex-col select-none">
        {dialogCard}
      </div>
    );
  }

  const modalNode = (
    <div
      className={`fixed inset-0 z-[100] flex items-center justify-center p-3 sm:p-5 select-none animate-in fade-in duration-150 ${
        inSpotlight ? 'rounded-[22px] overflow-hidden' : ''
      }`}
    >
      <div
        className="absolute inset-0 bg-black/55 dark:bg-black/75 backdrop-blur-sm"
        onClick={onClose}
      />
      {dialogCard}
    </div>
  );

  return typeof document !== 'undefined'
    ? createPortal(modalNode, document.body)
    : modalNode;
};
