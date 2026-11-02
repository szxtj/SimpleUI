import React, { useState, useRef, useEffect, useId } from 'react';
import { Check, Copy, Image as ImageIcon, Code2, Eye } from 'lucide-react';
import { useI18n } from '../i18n';

interface MermaidBlockProps {
  code: string;
}

type Mermaid = typeof import('mermaid')['default'];

const FONT_STACK =
  '"PingFang SC", -apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", Arial, sans-serif';

interface MermaidPalette {
  bg: string;
  nodeFill: string;
  nodeStroke: string;
  nodeText: string;
  edge: string;
  labelBg: string;
  labelBorder: string;
  labelText: string;
  clusterFill: string;
  clusterBorder: string;
  noteBg: string;
  noteBorder: string;
  noteText: string;
  pie: string[];
}

function getMermaidPalette(isDark: boolean): MermaidPalette {
  if (isDark) {
    return {
      bg: '#1a1b1e',
      nodeFill: '#232733',
      nodeStroke: '#4f8ff7',
      nodeText: '#f1f5f9',
      edge: '#64748b',
      labelBg: '#1e2028',
      labelBorder: '#3b404d',
      labelText: '#cbd5e1',
      clusterFill: 'rgba(59, 130, 246, 0.06)',
      clusterBorder: 'rgba(148, 163, 184, 0.35)',
      noteBg: '#242832',
      noteBorder: '#4a5160',
      noteText: '#dbe3ec',
      pie: ['#3b82f6', '#10b981', '#f59e0b', '#a855f7', '#ec4899', '#06b6d4', '#f97316'],
    };
  }
  return {
    bg: '#ffffff',
    nodeFill: '#f0f6ff',
    nodeStroke: '#3b82f6',
    nodeText: '#1e293b',
    edge: '#64748b',
    labelBg: '#ffffff',
    labelBorder: '#cbd5e1',
    labelText: '#334155',
    clusterFill: 'rgba(59, 130, 246, 0.035)',
    clusterBorder: 'rgba(100, 116, 139, 0.4)',
    noteBg: '#f6f8fb',
    noteBorder: '#cbd5e1',
    noteText: '#334155',
    pie: ['#3b82f6', '#10b981', '#f59e0b', '#a855f7', '#ec4899', '#06b6d4', '#f97316'],
  };
}

/** Mindmap / timeline 按层级取色：同一色相的单色梯度，避免出现彩虹色阶 */
function scaleColor(step: number, isDark: boolean): string {
  const i = Math.min(11, Math.max(0, step));
  return isDark ? `hsl(218, 17%, ${17 + i * 1.5}%)` : `hsl(214, 62%, ${97 - i * 2.2}%)`;
}

/** 单色梯度下每一级仍需可辨识的边框色 */
function scaleBorder(step: number, isDark: boolean): string {
  const i = Math.min(11, Math.max(0, step));
  return isDark ? `hsl(218, 26%, ${30 + i * 1.8}%)` : `hsl(214, 55%, ${84 - i * 2.6}%)`;
}

/**
 * 关闭 mermaid 的 useMaxWidth：默认行为会给 svg 写 inline max-width + width=100%，
 * 于是比容器窄的小图被整幅放大（字号跟着放大到 28px），比容器宽的大图反而溢出。
 * 关掉后 svg 保留 viewBox 的自然尺寸，由 .mermaid-diagram 的 CSS 统一「只缩不放」。
 */
const NO_MAX_WIDTH: Record<string, { useMaxWidth: boolean }> = Object.fromEntries(
  [
    'flowchart',
    'sequence',
    'gantt',
    'class',
    'state',
    'er',
    'journey',
    'gitGraph',
    'pie',
    'quadrantChart',
    'timeline',
    'mindmap',
    'sankey',
    'architecture',
    'requirement',
    'block',
    'packet',
    'kanban',
    'radar',
    'treemap',
    'xychart',
    'c4',
  ].map((key) => [key, { useMaxWidth: false }])
);

function buildMermaidConfig(isDark: boolean) {  const p = getMermaidPalette(isDark);
  const themeVariables: Record<string, string | boolean> = {
    darkMode: isDark,
    background: p.bg,
    primaryColor: p.nodeFill,
    primaryTextColor: p.nodeText,
    primaryBorderColor: p.nodeStroke,
    secondaryColor: p.nodeFill,
    secondaryTextColor: p.nodeText,
    secondaryBorderColor: p.nodeStroke,
    tertiaryColor: p.bg,
    tertiaryTextColor: p.nodeText,
    tertiaryBorderColor: p.nodeStroke,
    mainBkg: p.nodeFill,
    nodeBorder: p.nodeStroke,
    nodeTextColor: p.nodeText,
    textColor: p.nodeText,
    titleColor: p.nodeText,
    lineColor: p.edge,
    defaultLinkColor: p.edge,
    edgeLabelBackground: p.labelBg,
    clusterBkg: p.clusterFill,
    clusterBorder: p.clusterBorder,
    classText: p.nodeText,
    fontFamily: FONT_STACK,
    fontSize: '14px',
    // act/sequence
    actorBkg: p.nodeFill,
    actorBorder: p.nodeStroke,
    actorTextColor: p.nodeText,
    actorLineColor: p.edge,
    signalColor: p.edge,
    signalTextColor: p.labelText,
    labelBoxBkgColor: p.labelBg,
    labelBoxBorderColor: p.labelBorder,
    labelTextColor: p.labelText,
    loopTextColor: p.labelText,
    noteBkgColor: p.noteBg,
    noteBorderColor: p.noteBorder,
    noteTextColor: p.noteText,
    activationBkgColor: p.nodeFill,
    activationBorderColor: p.nodeStroke,
    sequenceNumberColor: p.labelText,
    // gantt
    sectionBkgColor: p.clusterFill,
    altSectionBkgColor: isDark ? 'rgba(148, 163, 184, 0.04)' : 'rgba(148, 163, 184, 0.06)',
    sectionBkgColor2: p.clusterFill,
    taskBkgColor: p.nodeFill,
    taskBorderColor: p.nodeStroke,
    taskTextColor: p.nodeText,
    taskTextOutsideColor: p.labelText,
    taskTextDarkColor: p.nodeText,
    taskTextLightColor: p.nodeText,
    gridColor: p.clusterBorder,
    doneTaskBkgColor: isDark ? '#2b3a2f' : '#e8f5ec',
    doneTaskBorderColor: isDark ? '#3f6b4a' : '#9dcaa9',
    activeTaskBkgColor: isDark ? '#2a3346' : '#e3eeff',
    activeTaskBorderColor: p.nodeStroke,
    critBkgColor: isDark ? '#4a2c2f' : '#fde8e8',
    critBorderColor: isDark ? '#8a4a4e' : '#d98b8b',
    todayLineColor: isDark ? '#e07b7b' : '#d94a4a',
    // journey
    fillType0: p.nodeFill,
    fillType1: isDark ? '#272c39' : '#eef4fd',
    fillType2: isDark ? '#2b3140' : '#e6eefc',
    fillType3: isDark ? '#2f3647' : '#dde8fb',
    fillType4: isDark ? '#333b4e' : '#d4e2fa',
    fillType5: isDark ? '#374055' : '#cbdcf9',
    fillType6: isDark ? '#3b455c' : '#c2d6f8',
    fillType7: isDark ? '#3f4a63' : '#b9d0f7',
    // ER
    attributeBackgroundColorOdd: p.nodeFill,
    attributeBackgroundColorEven: isDark ? '#1f232e' : '#f8fafd',
  };

  for (let i = 0; i < 12; i++) {
    themeVariables[`cScale${i}`] = scaleColor(i, isDark);
    themeVariables[`cScalePeer${i}`] = scaleBorder(i, isDark);
    themeVariables[`cScaleLabel${i}`] = p.nodeText;
    themeVariables[`cScaleInv${i}`] = scaleBorder(i, isDark);
  }
  p.pie.forEach((color, i) => {
    themeVariables[`pie${i + 1}`] = color;
  });

  // mindmap 的根节点填充/文字取自 git0 / gitBranchLabel0（gitGraph 共用同一组），
  // 不显式指定就会落到 mermaid 默认的亮蓝色。
  const gitColors = isDark
    ? ['#2c4a70', '#356089', '#2f6f63', '#6b5a2f', '#5c3f63', '#3f5566', '#4a4a63', '#5a4436']
    : ['#dbe9fd', '#cfe3fb', '#d3f0e6', '#f7ead2', '#eee0f5', '#dbe8f0', '#e3e3f4', '#f2e5d9'];
  gitColors.forEach((color, i) => {
    themeVariables[`git${i}`] = color;
    themeVariables[`gitBranchLabel${i}`] = isDark ? '#e8f1ff' : '#1e3a5f';
  });
  themeVariables.commitLabelColor = p.nodeText;
  themeVariables.commitLabelBackground = p.bg;
  themeVariables.tagLabelColor = p.labelText;
  themeVariables.tagLabelBackground = p.labelBg;
  themeVariables.tagLabelBorder = p.labelBorder;

  return {
    theme: 'base',
    look: 'classic',
    startOnLoad: false,
    securityLevel: 'strict',
    suppressErrorRendering: true,
    // 用 SVG <text> 而非 <foreignObject>：WebKit 无法把含 foreignObject 的 SVG 画进 canvas，
    // 会让「复制图像」在真实 App（WKWebView）里静默产出空白图。
    htmlLabels: false,
    fontFamily: FONT_STACK,
    themeVariables,
    // 关掉 useMaxWidth：否则 mermaid 会给 svg 写 inline max-width + width=100%，
    // 小图被拉伸放大（字号一起放大），大图又会溢出容器。交给 index.css 统一约束。
    ...NO_MAX_WIDTH,
  };
}

let mermaidLoader: Promise<Mermaid> | null = null;
let initializedTheme: boolean | null = null;

async function getMermaid(isDark: boolean): Promise<Mermaid> {
  if (!mermaidLoader) {
    mermaidLoader = import('mermaid').then((mod) => mod.default);
  }
  const mermaid = await mermaidLoader;
  if (initializedTheme !== isDark) {
    mermaid.initialize(buildMermaidConfig(isDark) as unknown as Parameters<Mermaid['initialize']>[0]);
    initializedTheme = isDark;
  }
  return mermaid;
}

export const MermaidBlock: React.FC<MermaidBlockProps> = React.memo(({ code }) => {
  const { lang } = useI18n();
  const [viewMode, setViewMode] = useState<'diagram' | 'code'>('diagram');
  const [copiedSource, setCopiedSource] = useState(false);
  const [copiedImage, setCopiedImage] = useState(false);
  const [isDark, setIsDark] = useState<boolean>(() =>
    typeof document !== 'undefined' ? document.documentElement.classList.contains('dark') : true
  );
  const [svgMarkup, setSvgMarkup] = useState<string | null>(null);
  const svgContainerRef = useRef<HTMLDivElement | null>(null);

  // 每次渲染用独立 id：mermaid 生成的 marker/style 全部以该 id 派生，
  // 同一页多张图（或同一张图多次重渲染）不会出现重复 DOM id。
  const blockId = useId().replace(/[^a-zA-Z0-9]/g, '');
  const renderSeq = useRef(0);

  // Observe html.dark class changes so switching Light/Dark theme immediately updates the SVG diagram
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    const updateTheme = () => setIsDark(root.classList.contains('dark'));
    updateTheme();
    const observer = new MutationObserver(updateTheme);
    observer.observe(root, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let alive = true;
    const seq = ++renderSeq.current;
    const renderId = `mermaid-${blockId}-${seq}`;

    const run = async () => {
      let mermaid: Mermaid;
      try {
        mermaid = await getMermaid(isDark);
      } catch (e) {
        console.error('Failed to load mermaid:', e);
        if (alive) setSvgMarkup(null);
        return;
      }
      try {
        const { svg } = await mermaid.render(renderId, code);
        // 只接受最后一次渲染的结果：代码在流式增长时，先发起的渲染可能后返回
        if (alive) setSvgMarkup(svg);
      } catch {
        // 语法不完整或不受支持：交回源码视图（与既有的代码框降级路径一致）
        if (alive) setSvgMarkup(null);
      }
    };

    void run();
    return () => {
      alive = false;
    };
  }, [code, isDark, blockId]);

  const handleCopySource = async () => {
    try {
      const fenced = `\`\`\`mermaid\n${code.replace(/\n$/, '')}\n\`\`\``;
      await navigator.clipboard.writeText(fenced);
      setCopiedSource(true);
      setTimeout(() => setCopiedSource(false), 2000);
    } catch (e) {
      console.error('Failed to copy mermaid source:', e);
    }
  };

  const handleCopyImage = async () => {
    try {
      const svgEl = svgContainerRef.current?.querySelector('svg');
      if (!svgEl) return;

      const viewBox = svgEl.getAttribute('viewBox')?.split(/\s+/).map(Number);
      const width = Math.round((viewBox && viewBox[2]) || svgEl.clientWidth || 600);
      const height = Math.round((viewBox && viewBox[3]) || svgEl.clientHeight || 400);

      const clone = svgEl.cloneNode(true) as SVGSVGElement;
      clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      clone.setAttribute('width', String(width));
      clone.setAttribute('height', String(height));
      const svgString = new XMLSerializer().serializeToString(clone);

      const scale = 2; // 2x Retina resolution
      const img = new Image();
      const svgBlob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
      const url = URL.createObjectURL(svgBlob);

      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = (err) => reject(err);
        img.src = url;
      });

      const canvas = document.createElement('canvas');
      const pad = 24;
      canvas.width = (width + pad * 2) * scale;
      canvas.height = (height + pad * 2) * scale;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        URL.revokeObjectURL(url);
        return;
      }

      ctx.scale(scale, scale);
      ctx.fillStyle = getMermaidPalette(isDark).bg;
      ctx.fillRect(0, 0, width + pad * 2, height + pad * 2);
      ctx.drawImage(img, pad, pad, width, height);
      URL.revokeObjectURL(url);

      const pngBlob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob((b) => resolve(b), 'image/png')
      );
      if (pngBlob && typeof ClipboardItem !== 'undefined') {
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob })]);
        setCopiedImage(true);
        setTimeout(() => setCopiedImage(false), 2000);
      }
    } catch (e) {
      console.error('Failed to copy mermaid image:', e);
    }
  };

  const isEn = lang === 'en';

  return (
    <div
      data-md-codeblock="true"
      data-language="mermaid"
      data-raw-code={code}
      className="relative my-3 rounded-lg overflow-hidden border border-[#d0d7de] dark:border-[#33363d] bg-white dark:bg-[#1a1b1e]"
    >
      {/* Header Toolbar (non-selectable, ignored by selection-to-markdown serializer) */}
      <div
        data-copy-ignore="true"
        className="flex items-center justify-between px-3.5 py-1.5 bg-[#f6f8fa] dark:bg-[#22242a] border-b border-[#d0d7de] dark:border-[#33363d] text-xs text-zinc-500 dark:text-[#9aa0a6] select-none"
      >
        <div className="flex items-center gap-2">
          <span className="font-mono uppercase font-semibold text-[11px] tracking-wider text-zinc-600 dark:text-[#abb2bf]">
            MERMAID
          </span>
          {svgMarkup && (
            <div className="flex items-center bg-black/[0.04] dark:bg-[#18191e] rounded-md p-0.5 border border-black/5 dark:border-white/5">
              <button
                type="button"
                onClick={() => setViewMode('diagram')}
                className={`flex items-center gap-1 px-2 py-0.5 rounded text-[11px] transition-colors cursor-pointer ${
                  viewMode === 'diagram'
                    ? 'bg-white dark:bg-[#32363e] text-zinc-900 dark:text-white font-medium shadow-xs'
                    : 'text-zinc-500 dark:text-[#8b929e] hover:text-zinc-900 dark:hover:text-white'
                }`}
              >
                <Eye className="w-3 h-3" />
                <span>{isEn ? 'Diagram' : '图表'}</span>
              </button>
              <button
                type="button"
                onClick={() => setViewMode('code')}
                className={`flex items-center gap-1 px-2 py-0.5 rounded text-[11px] transition-colors cursor-pointer ${
                  viewMode === 'code'
                    ? 'bg-white dark:bg-[#32363e] text-zinc-900 dark:text-white font-medium shadow-xs'
                    : 'text-zinc-500 dark:text-[#8b929e] hover:text-zinc-900 dark:hover:text-white'
                }`}
              >
                <Code2 className="w-3 h-3" />
                <span>{isEn ? 'Code' : '源码'}</span>
              </button>
            </div>
          )}
        </div>

        <div className="flex items-center gap-1.5">
          {svgMarkup && (
            <button
              type="button"
              onClick={handleCopyImage}
              className="flex items-center gap-1.5 px-2 py-0.5 rounded hover:bg-black/5 dark:hover:bg-[#32363e] text-zinc-600 dark:text-[#b0b4bd] transition-colors cursor-pointer"
              title={isEn ? 'Copy rendered diagram image' : '复制渲染后的图表图像'}
            >
              {copiedImage ? (
                <>
                  <Check className="w-3.5 h-3.5 text-emerald-500 dark:text-emerald-400" />
                  <span className="text-emerald-600 dark:text-emerald-400 text-[11px]">
                    {isEn ? 'Image Copied' : '已复制图像'}
                  </span>
                </>
              ) : (
                <>
                  <ImageIcon className="w-3.5 h-3.5" />
                  <span className="text-[11px]">{isEn ? 'Copy Image' : '复制图像'}</span>
                </>
              )}
            </button>
          )}

          <button
            type="button"
            onClick={handleCopySource}
            className="flex items-center gap-1.5 px-2 py-0.5 rounded hover:bg-black/5 dark:hover:bg-[#32363e] text-zinc-600 dark:text-[#b0b4bd] transition-colors cursor-pointer"
            title={isEn ? 'Copy Mermaid Markdown source' : '复制 Mermaid Markdown 源码'}
          >
            {copiedSource ? (
              <>
                <Check className="w-3.5 h-3.5 text-emerald-500 dark:text-emerald-400" />
                <span className="text-emerald-600 dark:text-emerald-400 text-[11px]">
                  {isEn ? 'Copied' : '已复制'}
                </span>
              </>
            ) : (
              <>
                <Copy className="w-3.5 h-3.5" />
                <span className="text-[11px]">{isEn ? 'Copy Source' : '复制源码'}</span>
              </>
            )}
          </button>
        </div>
      </div>

      {/* Body: Rendered SVG Diagram or Selectable Raw Code */}
      {svgMarkup && viewMode === 'diagram' ? (
        <div
          ref={svgContainerRef}
          className="mermaid-diagram p-4 overflow-x-auto overflow-y-hidden flex justify-center items-center bg-white dark:bg-[#1a1b1e]"
          dangerouslySetInnerHTML={{ __html: svgMarkup }}
        />
      ) : (
        <pre className="!m-0 !p-3.5 overflow-x-auto overflow-y-hidden text-[0.88em] font-mono leading-relaxed bg-[#f8f9fb] dark:bg-[#1a1b1e] text-[#1f2328] dark:text-[#f0f3f6] border-0 whitespace-pre cursor-text">
          <code className="!bg-transparent !p-0 !text-inherit font-mono whitespace-pre">{code}</code>
        </pre>
      )}
    </div>
  );
});

MermaidBlock.displayName = 'MermaidBlock';
