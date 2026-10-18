/**
 * 程序化滚动（切会话贴底、横线跳转）期间临时关掉**原生滚动锚定**。
 *
 * 原生锚定（`overflow-anchor: auto`）正是我们想要的"上方内容自然拼接"机制：
 * 浏览器在布局管线里挑一个视口内元素当锚点，上方内容增减时自动调偏移，
 * 不打断惯性、不产生滚动事件回声 —— 所以日常滚动交给它，我们不再手写位置校准。
 *
 * 但它是"保住当前视野"的逻辑，会和我们"主动把视野挪到别处"的程序化滚动打架
 * （典型：切会话要贴底、点横线要贴顶，锚定会把位置拉回去）。所以只在这类动作的
 * 一小段时间窗里关掉，之后恢复。
 */
export function disableScrollAnchor(el: HTMLElement | null, ms = 420) {
  if (!el) return;
  el.style.overflowAnchor = 'none';
  window.setTimeout(() => {
    if (el.isConnected) el.style.overflowAnchor = '';
  }, ms);
}

/** 内容坐标：相对滚动内容顶部的位置，与 scrollTop 无关 */
export function contentYOf(el: HTMLElement, node: HTMLElement) {
  return node.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
}
