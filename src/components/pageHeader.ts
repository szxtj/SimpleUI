/**
 * 面板「二级页头」的统一规格。
 *
 * 一个常量管四处：主窗口标签栏、主窗口页面头、浮窗卡片头、浮窗页面头。
 * 之前四个页面各写一遍 `h-[44px]`，而标签栏 52、浮窗卡片头 53（py-3 + 内容 28 + 底边），
 * 于是：主窗口里两条横带一高一低；浮窗里开页面时头部从 53 变 44，下面内容整体上跳 9px。
 *
 * 现在全部 52（含各自 1px 底边），材质（底色 + 模糊 + 底边）也与顶栏同一份，
 * 开合页面时顶部那条带子的高度与观感都不变。
 */
export const PAGE_HEADER_HEIGHT = 52;

export const PAGE_HEADER_MATERIAL =
  'h-[52px] flex-shrink-0 border-b border-black/5 bg-[#f8f9fb]/80 backdrop-blur dark:border-white/5 dark:bg-[#18191c]/80';

/** `tight` = 主窗口（贴着标签栏，内边距小）；`comfy` = 浮窗（与卡片头同为 px-4） */
export type PageHeaderPadding = 'tight' | 'comfy';

export function pageHeaderClass(opts: { gap?: string; padding?: PageHeaderPadding } = {}): string {
  const { gap = 'gap-2', padding = 'tight' } = opts;
  return `flex items-center ${gap} ${PAGE_HEADER_MATERIAL} ${padding === 'comfy' ? 'px-4' : 'px-2.5'}`;
}
