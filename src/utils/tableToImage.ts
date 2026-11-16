/**
 * 将渲染后的 DOM <table>（含 KaTeX 公式、粗体/行内代码、单元格边框与深浅色主题）
 * 直接绘制到 2x Retina Canvas 并导出为 PNG Blob。
 *
 * 为什么不走 SVG <foreignObject>：
 * WebKit / WKWebView 无法把含 foreignObject 的 SVG 画进 canvas（会静默产出空白图），
 * 与 MermaidBlock 禁用 htmlLabels 的原因相同。直接用 Canvas 2D 遍历已排版的 DOM
 * 节点坐标绘制，在 WKWebView 与桌面浏览器中均可稳定输出清晰图像。
 */

const SKIP_SELECTOR = '.katex-mathml, [data-copy-ignore="true"], .sr-only';

function isTransparent(color: string | null | undefined): boolean {
  if (!color || color === 'transparent') return true;
  const m = color.match(/^rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*([\d.]+)\s*\)$/i);
  return m ? parseFloat(m[1]) === 0 : false;
}

function isHiddenElement(el: Element, cs: CSSStyleDeclaration): boolean {
  if (el.matches(SKIP_SELECTOR)) return true;
  if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) {
    return true;
  }
  return false;
}

function drawRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
): void {
  const radius = Math.min(r, w / 2, h / 2);
  if (radius <= 0) {
    ctx.fillRect(x, y, w, h);
    return;
  }
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
  ctx.fill();
}

function applyTextTransform(text: string, transform: string): string {
  if (transform === 'uppercase') return text.toUpperCase();
  if (transform === 'lowercase') return text.toLowerCase();
  return text;
}

interface TextSegment {
  text: string;
  left: number;
  top: number;
  width: number;
  height: number;
}

function collectTextSegments(textNode: Text, originX: number, originY: number): TextSegment[] {
  const raw = textNode.nodeValue;
  if (!raw || !raw.trim()) return [];

  const range = document.createRange();
  range.selectNodeContents(textNode);
  const rects = range.getClientRects();
  if (rects.length === 0) return [];

  if (rects.length === 1) {
    const r = rects[0];
    if (r.width <= 0 || r.height <= 0) return [];
    return [
      {
        text: raw,
        left: r.left - originX,
        top: r.top - originY,
        width: r.width,
        height: r.height,
      },
    ];
  }

  // 多行换行文本：按字符的 clientRect.top 分组归并到每一行
  const segments: TextSegment[] = [];
  let curText = '';
  let minLeft = Infinity;
  let minTop = Infinity;
  let maxRight = -Infinity;
  let maxBottom = -Infinity;
  let lineTop: number | null = null;

  const flush = () => {
    if (curText && lineTop !== null && maxRight > minLeft) {
      segments.push({
        text: curText,
        left: minLeft - originX,
        top: minTop - originY,
        width: maxRight - minLeft,
        height: maxBottom - minTop,
      });
    }
    curText = '';
    minLeft = Infinity;
    minTop = Infinity;
    maxRight = -Infinity;
    maxBottom = -Infinity;
    lineTop = null;
  };

  for (let i = 0; i < raw.length; i++) {
    range.setStart(textNode, i);
    range.setEnd(textNode, i + 1);
    const charRects = range.getClientRects();
    if (charRects.length === 0) {
      curText += raw[i];
      continue;
    }
    const r = charRects[0];
    if (r.width === 0 && r.height === 0) {
      curText += raw[i];
      continue;
    }
    if (lineTop !== null && Math.abs(r.top - lineTop) > 3) {
      flush();
    }
    if (lineTop === null) lineTop = r.top;
    curText += raw[i];
    if (r.left < minLeft) minLeft = r.left;
    if (r.top < minTop) minTop = r.top;
    if (r.right > maxRight) maxRight = r.right;
    if (r.bottom > maxBottom) maxBottom = r.bottom;
  }
  flush();

  return segments;
}

interface PendingSvg {
  svg: SVGSVGElement;
  color: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

async function drawSvgToCanvas(ctx: CanvasRenderingContext2D, item: PendingSvg): Promise<void> {
  const clone = item.svg.cloneNode(true) as SVGSVGElement;
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('width', String(item.width));
  clone.setAttribute('height', String(item.height));
  clone.style.color = item.color;

  const svgString = new XMLSerializer().serializeToString(clone);
  const blob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);

  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = (err) => reject(err);
      img.src = url;
    });
    ctx.drawImage(img, item.x, item.y, item.width, item.height);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function drawTextSegment(
  ctx: CanvasRenderingContext2D,
  seg: TextSegment,
  cs: CSSStyleDeclaration
): void {
  const text = applyTextTransform(seg.text, cs.textTransform);
  if (!text.trim()) return;

  ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  ctx.fillStyle = cs.color;

  const metrics = ctx.measureText(text);
  const ascent = (metrics as unknown as { fontBoundingBoxAscent?: number }).fontBoundingBoxAscent;
  const descent = (metrics as unknown as { fontBoundingBoxDescent?: number }).fontBoundingBoxDescent;

  if (typeof ascent === 'number' && typeof descent === 'number') {
    ctx.textBaseline = 'alphabetic';
    const boxHeight = ascent + descent;
    const y = seg.top + (seg.height - boxHeight) / 2 + ascent;
    ctx.fillText(text, seg.left, y);
  } else {
    ctx.textBaseline = 'middle';
    ctx.fillText(text, seg.left, seg.top + seg.height / 2);
  }

  if (cs.textDecorationLine.includes('line-through')) {
    ctx.fillRect(seg.left, seg.top + seg.height / 2, seg.width, 1);
  }
  if (cs.textDecorationLine.includes('underline')) {
    ctx.fillRect(seg.left, seg.top + seg.height - 1.5, seg.width, 1);
  }
}

export async function renderTableToPngBlob(
  tableEl: HTMLTableElement,
  isDark: boolean
): Promise<Blob | null> {
  if (document.fonts?.ready) {
    await document.fonts.ready;
  }

  const tableRect = tableEl.getBoundingClientRect();
  const width = Math.ceil(tableRect.width);
  const height = Math.ceil(tableRect.height);
  if (width <= 0 || height <= 0) return null;

  const scale = 2; // 2x Retina resolution (与 MermaidBlock 一致)
  const pad = 24;
  const canvas = document.createElement('canvas');
  canvas.width = (width + pad * 2) * scale;
  canvas.height = (height + pad * 2) * scale;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  ctx.scale(scale, scale);
  ctx.fillStyle = isDark ? '#1a1b1e' : '#ffffff';
  ctx.fillRect(0, 0, width + pad * 2, height + pad * 2);
  ctx.translate(pad, pad);

  const originX = tableRect.left;
  const originY = tableRect.top;

  // 1. 绘制单元格背景与边框
  const cells = tableEl.querySelectorAll('th, td');
  cells.forEach((cell) => {
    const cs = getComputedStyle(cell);
    if (isHiddenElement(cell, cs)) return;
    const r = cell.getBoundingClientRect();
    const x = r.left - originX;
    const y = r.top - originY;

    if (!isTransparent(cs.backgroundColor)) {
      ctx.fillStyle = cs.backgroundColor;
      ctx.fillRect(x, y, r.width, r.height);
    }
  });

  cells.forEach((cell) => {
    const cs = getComputedStyle(cell);
    if (isHiddenElement(cell, cs)) return;
    const r = cell.getBoundingClientRect();
    const x = Math.round(r.left - originX) + 0.5;
    const y = Math.round(r.top - originY) + 0.5;
    const w = Math.round(r.width) - (r.right - originX >= width - 0.5 ? 1 : 0);
    const h = Math.round(r.height) - (r.bottom - originY >= height - 0.5 ? 1 : 0);
    const borderColor = !isTransparent(cs.borderBottomColor)
      ? cs.borderBottomColor
      : isDark
        ? '#36373d'
        : '#d0d7de';

    ctx.strokeStyle = borderColor;
    ctx.lineWidth = 1;
    ctx.strokeRect(x, y, Math.max(0, w), Math.max(0, h));
  });

  // 2. 遍历单元格内部：绘制行内元素背景/边框（如 code 徽标、KaTeX 分数线）、文本与内联 SVG
  const pendingSvgs: PendingSvg[] = [];

  const walk = (node: Node, parentCs: CSSStyleDeclaration) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const segments = collectTextSegments(node as Text, originX, originY);
      for (const seg of segments) {
        drawTextSegment(ctx, seg, parentCs);
      }
      return;
    }

    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as Element;
    const cs = getComputedStyle(el);
    if (isHiddenElement(el, cs)) return;

    if (el instanceof SVGSVGElement) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        pendingSvgs.push({
          svg: el,
          color: cs.color,
          x: r.left - originX,
          y: r.top - originY,
          width: r.width,
          height: r.height,
        });
      }
      return;
    }

    const tag = el.tagName;
    const isCellOrRow =
      tag === 'TABLE' ||
      tag === 'THEAD' ||
      tag === 'TBODY' ||
      tag === 'TFOOT' ||
      tag === 'TR' ||
      tag === 'TH' ||
      tag === 'TD';

    if (!isCellOrRow) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        const x = r.left - originX;
        const y = r.top - originY;

        if (!isTransparent(cs.backgroundColor)) {
          ctx.fillStyle = cs.backgroundColor;
          const radius = parseFloat(cs.borderTopLeftRadius) || 0;
          drawRoundedRect(ctx, x, y, r.width, r.height, radius);
        }

        const bt = parseFloat(cs.borderTopWidth) || 0;
        const bb = parseFloat(cs.borderBottomWidth) || 0;
        const bl = parseFloat(cs.borderLeftWidth) || 0;
        const br = parseFloat(cs.borderRightWidth) || 0;

        if (bt > 0 && cs.borderTopStyle !== 'none' && !isTransparent(cs.borderTopColor)) {
          ctx.fillStyle = cs.borderTopColor;
          ctx.fillRect(x, y, r.width, bt);
        }
        if (bb > 0 && cs.borderBottomStyle !== 'none' && !isTransparent(cs.borderBottomColor)) {
          ctx.fillStyle = cs.borderBottomColor;
          ctx.fillRect(x, y + r.height - bb, r.width, bb);
        }
        if (bl > 0 && cs.borderLeftStyle !== 'none' && !isTransparent(cs.borderLeftColor)) {
          ctx.fillStyle = cs.borderLeftColor;
          ctx.fillRect(x, y, bl, r.height);
        }
        if (br > 0 && cs.borderRightStyle !== 'none' && !isTransparent(cs.borderRightColor)) {
          ctx.fillStyle = cs.borderRightColor;
          ctx.fillRect(x + r.width - br, y, br, r.height);
        }
      }
    }

    for (let i = 0; i < el.childNodes.length; i++) {
      walk(el.childNodes[i], cs);
    }
  };

  cells.forEach((cell) => {
    const cs = getComputedStyle(cell);
    if (isHiddenElement(cell, cs)) return;
    for (let i = 0; i < cell.childNodes.length; i++) {
      walk(cell.childNodes[i], cs);
    }
  });

  if (pendingSvgs.length > 0) {
    await Promise.all(pendingSvgs.map((item) => drawSvgToCanvas(ctx, item)));
  }

  return new Promise<Blob | null>((resolve) => canvas.toBlob((b) => resolve(b), 'image/png'));
}
