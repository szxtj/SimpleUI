/**
 * 主窗口三列布局的唯一宽度来源。
 *
 *   ┌──────────┬──────────────────┬────────────┐
 *   │ 左栏 260 │ 中部 flex(≥460)  │ 右栏 360–820│
 *   └──────────┴──────────────────┴────────────┘
 *
 * 约定：
 * - 左右两栏宽度是**自变量**（左固定 260、右由用户拖拽/持久化），中部是余量；
 * - 展开/收起任一侧时，主窗口 frame 同步伸缩（左栏向左、右栏向右），**中部数值不变**；
 * - 主窗口被拖动改变尺寸时，左右两栏锁死、只动中部；
 * - 原生侧 `MainWindowController` 里的同名常量必须与这里保持一致（最小宽度公式）。
 */
export const LEFT_SIDEBAR_WIDTH = 260;

/** 中部（对话列）最小宽度：右栏拖拽钳制、窗口最小宽度都用它 */
export const MIDDLE_MIN_WIDTH = 460;

/** 右栏宽度范围 */
export const PANEL_MIN_WIDTH = 360;
export const PANEL_MAX_WIDTH = 820;
export const PANEL_DEFAULT_WIDTH = 440;

/** 给定左右栏当前宽度，算窗口的最小内容宽度 */
export function windowMinWidth(left: number, right: number): number {
  return left + MIDDLE_MIN_WIDTH + right;
}
