/**
 * 尺寸 HUD：两块遮罩中间的「1234 px」数字。
 *
 * 为什么用模块级注册表 + 直接改 textContent：
 * 拖拽/开合期间每帧都要更新数字，如果走 React state 就等于把"零渲染"又毁了。
 * 这里只做两件事——记下当前值、把值写进已挂载的 pill 元素；元素挂载时立即回填，
 * 所以 App 先算、组件后挂载也不会丢首次数值。
 *
 * 每个窗口一个 JS 运行时（主窗口 / 浮窗各一份），互不影响。
 */

interface HudState {
  middle: number | null;
  panel: number | null;
  chatEl: HTMLElement | null;
  panelEl: HTMLElement | null;
}

const state: HudState = { middle: null, panel: null, chatEl: null, panelEl: null };

const fmt = (v: number) => `${Math.round(v)} px`;

function paint() {
  if (state.chatEl && state.middle != null) state.chatEl.textContent = fmt(state.middle);
  if (state.panelEl && state.panel != null) state.panelEl.textContent = fmt(state.panel);
}

export const resizeHud = {
  setMiddle(width: number) {
    state.middle = width;
    paint();
  },
  setPanel(width: number) {
    state.panel = width;
    paint();
  },
  attachChatPill(el: HTMLElement | null) {
    state.chatEl = el;
    paint();
    return () => {
      if (state.chatEl === el) state.chatEl = null;
    };
  },
  attachPanelPill(el: HTMLElement | null) {
    state.panelEl = el;
    paint();
    return () => {
      if (state.panelEl === el) state.panelEl = null;
    };
  },
  reset() {
    state.middle = null;
    state.panel = null;
    paint();
  },
};
