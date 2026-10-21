import { useCallback, useMemo, useState } from 'react';

/**
 * 浮窗里的「整页浏览」模型：**没有标签栏，只有一个页面栈**。
 *
 * 主窗口是「多个标签同时存在」，浮窗是「一次只有一页，可逐级返回」——
 * 两者共享页面组件，但导航与状态完全独立（不共享 store、不共享 localStorage 键），
 * 因此大小窗口互切时没有任何"互相覆盖"的通道。
 */
export type SpotlightPage =
  | { kind: 'wiki-search'; key: 'search' }
  | { kind: 'wiki-article'; key: string; title: string; injected?: string | null }
  | { kind: 'raw-text'; key: string; title: string; content: string }
  | { kind: 'image'; key: string; images: string[]; index: number };

const MAX_DEPTH = 6;

export interface SpotlightPageApi {
  stack: SpotlightPage[];
  top: SpotlightPage | null;
  depth: number;
  open: (page: SpotlightPage) => void;
  back: () => void;
  clear: () => void;
}

export function useSpotlightPage(): SpotlightPageApi {
  const [stack, setStack] = useState<SpotlightPage[]>([]);

  const open = useCallback((page: SpotlightPage) => {
    setStack((s) => {
      const top = s[s.length - 1];
      // 栈顶同页：只替换（图片换下标、条目补注入文本），不压重复层
      if (top && top.key === page.key) {
        const next = [...s];
        next[next.length - 1] = page;
        return next;
      }
      const next = [...s, page];
      return next.length > MAX_DEPTH ? next.slice(next.length - MAX_DEPTH) : next;
    });
  }, []);

  const back = useCallback(() => setStack((s) => (s.length > 1 ? s.slice(0, -1) : [])), []);
  const clear = useCallback(() => setStack([]), []);

  const top = useMemo(() => (stack.length ? stack[stack.length - 1] : null), [stack]);

  return { stack, top, depth: stack.length, open, back, clear };
}
