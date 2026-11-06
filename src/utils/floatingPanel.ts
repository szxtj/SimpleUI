/**
 * 浮动面板（划选浮标 / 公式工具条）的定位与边界避让。
 *
 * 两个窗口共用这一份：主窗口对话区、Markdown 编辑器窗口的预览区，
 * 以及浮窗（Spotlight）。三条规则：
 *
 *   1. **可见区 = 视口（− 顶部原生 chrome）**，可选再与「最近的裁剪祖先」求交。
 *      - 公式工具条是 `absolute`、挂在公式盒子里，**会被滚动容器裁掉**，必须用 `clip: 'nearest'`；
 *      - 划选浮标是 `fixed` + portal 到 body，不会被任何容器裁剪，只需避开窗口边缘，
 *        用 `clip: 'none'`（对话区思考框那种 192px 高的小裁剪盒会把浮标挤没）。
 *
 *   2. **顶部安全区来自 `--window-top-inset`**。Markdown 编辑器窗口顶部 52px 是原生拖拽带
 *      （`MarkdownTitleBarDragView` 会把整条带的鼠标事件吃掉），浮层落进去就是「看得见点不到」。
 *      主窗口不设该变量 → inset = 0，行为与改前逐像素一致。
 *
 *   3. 垂直方向先上后下：上方放得下就放上方，否则放下方，两边都放不下才夹进可见区。
 */

export interface VisibleBounds {
  left: number;
  right: number;
  top: number;
  bottom: number;
  /** 最近的裁剪祖先（用于 ResizeObserver 观察它的尺寸变化）；clip: 'none' 时为 null */
  clipNode: HTMLElement | null;
}

/** 窗口顶部被原生 chrome（拖拽带）占掉的高度，未设置时为 0 */
export function getWindowTopInset(): number {
  if (typeof window === 'undefined' || !document.documentElement) return 0;
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--window-top-inset').trim();
  const value = parseFloat(raw);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export interface VisibleBoundsOptions {
  margin?: number;
  /** 'nearest'：再与最近的裁剪祖先求交（absolute 定位的浮层必须用）；'none'：只看视口 */
  clip?: 'nearest' | 'none';
}

/**
 * 计算浮层可用区。
 * @param host 浮层挂靠的元素（用于向上找裁剪祖先）；`clip: 'none'` 时可传 null
 */
export function getVisibleBounds(host: Element | null, opts: VisibleBoundsOptions = {}): VisibleBounds {
  const margin = opts.margin ?? 8;
  const clip = opts.clip ?? 'nearest';
  const inset = getWindowTopInset();

  let left = margin;
  let right = document.documentElement.clientWidth - margin;
  let top = Math.max(margin, inset + margin);
  let bottom = document.documentElement.clientHeight - margin;
  let clipNode: HTMLElement | null = null;

  if (clip === 'nearest') {
    for (let node = host?.parentElement ?? null; node && node !== document.body; node = node.parentElement) {
      const cs = getComputedStyle(node);
      // overflow 任一轴不是 visible 即为裁剪容器（overflow-y:auto 会让 overflow-x 计算成 auto）
      if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') {
        clipNode = node;
        const r = node.getBoundingClientRect();
        left = Math.max(left, r.left + margin);
        right = Math.min(right, r.right - margin);
        top = Math.max(top, r.top + margin);
        bottom = Math.min(bottom, r.bottom - margin);
        break;
      }
    }
  }

  return { left, right, top, bottom, clipNode };
}

export interface AnchorRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/**
 * 把浮层摆到锚点（选区）旁边并夹进可见区。
 * @param align 'right'：浮层右缘对齐锚点右缘（划选浮标的既有行为）；'center'：水平居中于锚点
 */
export function placeNearAnchor(
  anchor: AnchorRect,
  size: { width: number; height: number },
  bounds: VisibleBounds,
  opts: { gap?: number; align?: 'right' | 'center' } = {}
): { x: number; y: number } {
  const gap = opts.gap ?? 6;
  const align = opts.align ?? 'right';

  const maxX = Math.max(bounds.left, bounds.right - size.width);
  const naturalX =
    align === 'center'
      ? anchor.left + (anchor.right - anchor.left) / 2 - size.width / 2
      : anchor.right - size.width;
  const x = Math.min(Math.max(bounds.left, naturalX), maxX);

  const above = anchor.top - size.height - gap;
  const below = anchor.bottom + gap;
  const maxY = Math.max(bounds.top, bounds.bottom - size.height);

  let y: number;
  if (above >= bounds.top) {
    y = above;
  } else if (below + size.height <= bounds.bottom) {
    y = below;
  } else {
    // 上下都塞不下（大段选区）：优先贴住可见区顶部，至少让浮层完整露出
    y = Math.min(Math.max(bounds.top, above), maxY);
  }
  return { x, y: Math.min(Math.max(bounds.top, y), maxY) };
}

/** 垂直方向放上还是放下：上方放得下就放上方 */
export function pickVerticalPlacement(
  anchor: AnchorRect,
  height: number,
  bounds: VisibleBounds,
  gap = 10
): 'top' | 'bottom' {
  const spaceAbove = anchor.top - bounds.top;
  if (spaceAbove >= height + gap) return 'top';
  const spaceBelow = bounds.bottom - anchor.bottom;
  if (spaceBelow >= height + gap) return 'bottom';
  return 'top';
}
