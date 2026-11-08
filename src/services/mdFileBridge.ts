/**
 * Markdown 编辑器的文件读写桥（页面 ↔ 原生 MarkdownEditorPanelController）。
 *
 * 方向约定：
 *   页面 → 原生：`window.webkit.messageHandlers.mdEditor.postMessage({action, ...})`
 *   原生 → 页面：`window.__mdFileOpened / __mdFileSaved / __mdDiscardDecision / __mdRequestSaveClose`
 *
 * 所有金额都走 JSON 字典（原生侧用 JSONSerialization 序列化，顶层只能是 Array/Dictionary）。
 * 没有原生桥时（浏览器 / 无头验证）`available()` 返回 false，调用方回退到浏览器方案。
 */

export interface MdFilePayload {
  ok: boolean;
  path?: string;
  name?: string;
  content?: string;
  error?: string;
  /** 用户在弹出的系统面板里点了取消 —— 不是错误，要静默处理 */
  cancelled?: boolean;
}

interface BridgeHandlers {
  onOpened?: (payload: MdFilePayload) => void;
  onSaved?: (payload: MdFilePayload) => void;
  onDiscardDecision?: (ok: boolean) => void;
  onRequestSaveClose?: () => void;
}

declare global {
  interface Window {
    __mdFileOpened?: (payload: MdFilePayload) => void;
    __mdFileSaved?: (payload: MdFilePayload) => void;
    __mdDiscardDecision?: (payload: { ok: boolean }) => void;
    __mdRequestSaveClose?: () => void;
    /** 原生在窗口重新显示时调用，让页面把最新状态再推一次（关窗时原生会清未保存标记） */
    __mdRequestState?: () => void;
  }
}

function bridge() {
  return (window as any).webkit?.messageHandlers?.mdEditor as
    | { postMessage: (payload: Record<string, unknown>) => void }
    | undefined;
}

function post(payload: Record<string, unknown>): boolean {
  const b = bridge();
  if (!b) return false;
  try {
    b.postMessage(payload);
    return true;
  } catch {
    return false;
  }
}

/** 等待原生回话的单次 Promise（确认框这类「一问一答」用） */
let discardResolver: ((ok: boolean) => void) | null = null;

export const mdFileBridge = {
  available(): boolean {
    return !!bridge();
  },

  open(): boolean {
    return post({ action: 'open' });
  },

  save(path: string, content: string): boolean {
    return post({ action: 'save', path, content });
  },

  saveAs(content: string, suggestedName?: string): boolean {
    return post({ action: 'saveAs', content, suggestedName: suggestedName ?? '' });
  },

  /** 同步窗口标题 / 未保存圆点 / 代表文件（原生据此决定关窗时是否提示） */
  syncState(state: { name: string; edited: boolean; path: string }): boolean {
    return post({ action: 'state', ...state });
  },

  /** 「保存并关闭」流程收尾：页面落盘成功后通知原生真正关窗 */
  closeNow(): boolean {
    return post({ action: 'closeNow' });
  },

  /** 「保存并关闭」流程里用户取消了另存为 / 落盘失败：让原生撤掉挂起状态 */
  cancelClose(): boolean {
    return post({ action: 'cancelClose' });
  },

  /**
   * 顶栏功能项左边界（CSS px）报给原生。
   *
   * 原生那层 52pt 拖拽带（MarkdownTitleBarDragView）会吃掉整条带上的鼠标事件；
   * 顶栏按钮能和红绿灯并排，靠的就是它按这个值在右侧留出一个「洞」。
   * 不报也不至于点不动 —— 原生有按宽度比例的兜底，但精度差、拖拽区会被压缩。
   */
  reportChromeHit(left: number): boolean {
    return post({ action: 'chromeHit', left });
  },

  /** 覆盖未保存内容前的确认框；无桥环境直接放行 */
  confirmDiscard(): Promise<boolean> {
    if (!bridge()) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      discardResolver = resolve;
      const sent = post({ action: 'confirmDiscard' });
      if (!sent) {
        discardResolver = null;
        resolve(true);
      }
    });
  },

  /**
   * 注册原生回调，返回清理函数。
   * 回调必须挂在 window 上（原生用 evaluateJavaScript 直接调）。
   */
  install(handlers: BridgeHandlers): () => void {
    window.__mdFileOpened = (payload) => handlers.onOpened?.(payload ?? { ok: false });
    window.__mdFileSaved = (payload) => handlers.onSaved?.(payload ?? { ok: false });
    window.__mdDiscardDecision = (payload) => {
      const resolve = discardResolver;
      discardResolver = null;
      if (resolve) resolve(!!payload?.ok);
      handlers.onDiscardDecision?.(!!payload?.ok);
    };
    window.__mdRequestSaveClose = () => handlers.onRequestSaveClose?.();

    return () => {
      delete window.__mdFileOpened;
      delete window.__mdFileSaved;
      delete window.__mdDiscardDecision;
      delete window.__mdRequestSaveClose;
    };
  },
};
