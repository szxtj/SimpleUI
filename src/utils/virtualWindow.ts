import type { ChatTurn } from './turns';

/**
 * 可测试的虚拟窗口纯计算。
 *
 * 约定：`offsets[i]` 是第 i 轮**内容顶部**相对滚动内容起点的 Y 坐标，
 * `offsets[n]` 是全部内容的总高度。每一轮的高度里已经包含轮间距
 * （由渲染层的 padding-bottom 承担），因此这里不再额外加 gap。
 */
export interface TurnSize {
  /** 实测高度（border-box，含轮间距） */
  h: number;
  /** 实测时的内容宽度，用于换宽度后按比例估算 */
  w: number;
  /** 是否已经被真实测量过（刻度条用） */
  visited?: boolean;
}

export interface OffsetsResult {
  offsets: number[];
  total: number;
}

export interface VirtualConfig {
  viewport: number;
  padTurns: number;
  overscan: number;
  maxTurns: number;
  maxHeight: number;
}

/** 未知轮次的高度估算：按“用户气泡 + 助手正文”的常见形态给一个中位数。 */
const DEFAULT_USER_H = 72;
const DEFAULT_ASSISTANT_H = 320;
const TURN_GAP = 16;

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/**
 * 生成 offsets。已测量轮次优先；换宽度后用 `oldH * oldW / newW` 估算，
 * 并钳在 0.5–2 倍，避免一次极端缩放把占位高度算飞。
 */
export function buildOffsets(
  turns: ChatTurn[],
  sizes: Map<string, TurnSize>,
  width: number
): OffsetsResult {
  const userHeights: number[] = [];
  const assistantHeights: number[] = [];
  for (const turn of turns) {
    const rec = sizes.get(turn.key);
    if (!rec) continue;
    if (turn.assistant) assistantHeights.push(rec.h);
    else userHeights.push(rec.h);
  }
  const userBase = median(userHeights) ?? DEFAULT_USER_H;
  const assistantBase = median(assistantHeights) ?? DEFAULT_ASSISTANT_H;

  const offsets: number[] = new Array(turns.length + 1);
  offsets[0] = 0;

  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i];
    const rec = sizes.get(turn.key);
    let h: number;
    if (rec && rec.h > 0) {
      const scale = rec.w > 0 && width > 0 ? clamp(width / rec.w, 0.5, 2) : 1;
      h = Math.max(24, rec.h * scale);
    } else {
      h = TURN_GAP;
      if (turn.user) {
        h += userBase;
        if (turn.user.images && turn.user.images.length > 0) {
          h += Math.min(600, turn.user.images.length * 200);
        }
      }
      if (turn.assistant) {
        h += assistantBase;
        if (turn.assistant.reasoningContent) h += 80;
        if (turn.assistant.images && turn.assistant.images.length > 0) {
          h += Math.min(600, turn.assistant.images.length * 200);
        }
        const len = turn.assistant.content?.length ?? 0;
        if (len > 1200) h += 100;
        if (len > 4000) h += 180;
      }
      h = Math.max(40, h);
    }
    offsets[i + 1] = offsets[i] + h;
  }

  return { offsets, total: offsets[turns.length] ?? 0 };
}

/** 返回包含 y 的轮次下标（0 起），越界时夹到首/尾。 */
export function findIndexAtOffset(offsets: number[], y: number): number {
  const n = offsets.length - 1;
  if (n <= 0) return -1;
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (offsets[mid] <= y) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export interface Range {
  start: number;
  end: number;
}

/** 可见区（不含 overscan）上下各留 padTurns 轮。 */
export function coreRange(
  offsets: number[],
  scrollTop: number,
  viewport: number,
  padTurns: number
): Range {
  const n = offsets.length - 1;
  if (n <= 0) return { start: 0, end: -1 };
  const visibleStart = findIndexAtOffset(offsets, scrollTop + 1);
  const visibleEnd = findIndexAtOffset(offsets, scrollTop + Math.max(1, viewport) - 1);
  return {
    start: clamp(visibleStart - padTurns, 0, n - 1),
    end: clamp(visibleEnd + padTurns, 0, n - 1),
  };
}

/**
 * 目标挂载区间：可见区 ± padTurns，再按像素向上下扩 overscan，
 * 最后在“绝不裁掉可见区 ± padTurns”的前提下应用轮数/高度上限。
 */
export function desiredRange(
  offsets: number[],
  scrollTop: number,
  cfg: VirtualConfig
): Range {
  const n = offsets.length - 1;
  if (n <= 0) return { start: 0, end: -1 };

  const viewport = Math.max(1, cfg.viewport);
  const visibleStart = findIndexAtOffset(offsets, scrollTop + 1);
  const visibleEnd = findIndexAtOffset(offsets, scrollTop + viewport - 1);

  let start = clamp(visibleStart - cfg.padTurns, 0, n - 1);
  let end = clamp(visibleEnd + cfg.padTurns, 0, n - 1);

  while (start > 0 && offsets[start] > scrollTop - cfg.overscan) start--;
  while (end < n - 1 && offsets[end + 1] < scrollTop + viewport + cfg.overscan) end++;

  const protectedStart = clamp(visibleStart - cfg.padTurns, 0, n - 1);
  const protectedEnd = clamp(visibleEnd + cfg.padTurns, 0, n - 1);

  // 轮数上限：从离可见区更远的一侧开始裁。
  while (end - start + 1 > cfg.maxTurns) {
    const leftSlack = protectedStart - start;
    const rightSlack = end - protectedEnd;
    if (leftSlack <= 0 && rightSlack <= 0) break;
    if (leftSlack >= rightSlack) start++;
    else end--;
  }

  // 高度上限：同上，但绝不裁进保护区间。
  while (offsets[end + 1] - offsets[start] > cfg.maxHeight) {
    const leftSlack = protectedStart - start;
    const rightSlack = end - protectedEnd;
    if (leftSlack <= 0 && rightSlack <= 0) break;
    if (leftSlack >= rightSlack) start++;
    else end--;
  }

  return { start, end };
}

/** 尾部窗口：从最后一轮向前累计，直到覆盖“视口 + overscan + padTurns 轮”。 */
export function tailRange(
  offsets: number[],
  viewport: number,
  padTurns: number,
  overscan: number,
  maxTurns = Number.POSITIVE_INFINITY,
  maxHeight = Number.POSITIVE_INFINITY
): Range {
  const n = offsets.length - 1;
  if (n <= 0) return { start: 0, end: -1 };
  const viewportH = Math.max(1, viewport);
  let start = n - 1;
  while (
    start > 0 &&
    (offsets[n] - offsets[start] < viewportH + overscan || n - 1 - start < padTurns)
  ) {
    start--;
  }
  // 预算是软上限：至少保留 padTurns 轮，尾部单轮超高时也只能保留它。
  if (Number.isFinite(maxTurns)) {
    start = Math.max(start, Math.max(0, n - Math.max(1, maxTurns)));
  }
  while (
    start < n - 1 &&
    n - 1 - start > padTurns &&
    offsets[n] - offsets[start] > maxHeight
  ) {
    start++;
  }
  return { start, end: n - 1 };
}

/**
 * 挂载内容不足一屏时向两侧补。返回新的区间；没有变化时返回 null。
 * 只用于初始/极端短会话兜底，正常滚动由 desiredRange 接管。
 */
export function fillRange(
  offsets: number[],
  range: Range,
  viewport: number
): Range | null {
  const n = offsets.length - 1;
  if (n <= 0) return null;
  let { start, end } = range;
  const target = Math.max(1, viewport) * 1.05;
  let guard = 0;
  while (offsets[end + 1] - offsets[start] < target && guard++ < n + 2) {
    const canUp = start > 0;
    const canDown = end < n - 1;
    if (!canUp && !canDown) break;
    // 优先补离视口更远的一侧不划算；这里简单地先上后下，保证尾部会话也能填满。
    if (canUp) start--;
    else end++;
  }
  return start === range.start && end === range.end ? null : { start, end };
}

/** 收拢只缩不放：返回 null 表示不需要改。 */
export function trimRange(current: Range, core: Range): Range | null {
  const start = Math.max(current.start, core.start);
  const end = Math.min(current.end, core.end);
  if (start > end) return null;
  if (start === current.start && end === current.end) return null;
  return { start, end };
}

/** 短会话/矮内容直接全量挂载，彻底绕开虚拟化。 */
export function shouldMountAll(
  turnCount: number,
  totalHeight: number,
  viewport: number,
  allTurns: number,
  allScreens: number
): boolean {
  if (turnCount <= 0) return true;
  if (turnCount <= allTurns) return true;
  return totalHeight <= Math.max(1, viewport) * allScreens;
}
