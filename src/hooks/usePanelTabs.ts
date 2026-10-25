import { useCallback, useMemo, useState } from 'react';
import {
  PanelTab,
  WikiSearchTab,
  WIKI_SEARCH_TAB_ID,
  wikiArticleTabId,
  rawTextTabId,
  imageTabId,
} from '../types/panel';

interface PanelState {
  tabs: PanelTab[];
  activeId: string | null;
  /** 面板可见性：与「有没有标签」解耦，收起后再展开仍回到原激活项 */
  visible: boolean;
}

const EMPTY: PanelState = { tabs: [], activeId: null, visible: false };

/**
 * 同一个 id 再次打开时的合并策略：
 *   - 条目页：已有注入原文就保留（从搜索进过一次、再从胶囊进，不应把上下文降级掉）
 *   - 图片页：索引跟着最后点的走
 *   - 其余：保持原对象，避免无谓重渲染
 */
function mergeTab(prev: PanelTab, next: PanelTab): PanelTab {
  if (prev.kind === 'wiki-article' && next.kind === 'wiki-article') {
    const injected = prev.injected ?? next.injected ?? null;
    return injected === prev.injected ? prev : { ...prev, injected };
  }
  if (prev.kind === 'image' && next.kind === 'image') {
    return prev.index === next.index && prev.images === next.images
      ? prev
      : { ...prev, index: next.index, images: next.images };
  }
  return prev;
}

export interface PanelTabsApi {
  tabs: PanelTab[];
  activeId: string | null;
  visible: boolean;
  activeTab: PanelTab | null;
  /** `+` / 面板开关（无标签时）：复用单例搜索页 */
  openSearch: () => void;
  openArticle: (title: string, injected?: string | null) => void;
  openRawText: (input: { messageId: string; content: string; title?: string }) => void;
  openImage: (input: { messageId: string; images: string[]; index: number }) => void;
  closeTab: (id: string) => void;
  activateTab: (id: string) => void;
  /** 图片页在页内切了图（左右箭头 / 循环）→ 让标签标题上的「n/总数」跟着走 */
  setImageIndex: (id: string, index: number) => void;
  /** 搜索页把当前关键词回写到标签标题（仅展示用） */
  setSearchQuery: (id: string, query: string) => void;
  toggleVisible: () => void;
}

/**
 * 主窗口右侧面板的标签状态机。
 *
 * 所有转移都在一个 updater 里完成（纯函数），不做「先算 next 再在 updater 里 setActiveId」
 * 那种嵌套状态更新——StrictMode 下重复调用会算错。
 */
export function usePanelTabs(): PanelTabsApi {
  const [state, setState] = useState<PanelState>(EMPTY);

  const open = useCallback((tab: PanelTab) => {
    setState((s) => {
      const exists = s.tabs.some((t) => t.id === tab.id);
      const tabs = exists ? s.tabs.map((t) => (t.id === tab.id ? mergeTab(t, tab) : t)) : [...s.tabs, tab];
      return { tabs, activeId: tab.id, visible: true };
    });
  }, []);

  const openSearch = useCallback(() => {
    const tab: WikiSearchTab = { id: WIKI_SEARCH_TAB_ID, kind: 'wiki-search' };
    open(tab);
  }, [open]);

  const openArticle = useCallback(
    (title: string, injected?: string | null) => {
      open({ id: wikiArticleTabId(title), kind: 'wiki-article', title, injected: injected ?? null });
    },
    [open]
  );

  const openRawText = useCallback(
    (input: { messageId: string; content: string; title?: string }) => {
      open({
        id: rawTextTabId(input.messageId),
        kind: 'raw-text',
        title: input.title ?? '',
        content: input.content,
      });
    },
    [open]
  );

  const openImage = useCallback(
    (input: { messageId: string; images: string[]; index: number }) => {
      open({
        id: imageTabId(input.messageId),
        kind: 'image',
        title: '',
        images: input.images,
        index: input.index,
      });
    },
    [open]
  );

  const closeTab = useCallback((id: string) => {
    setState((s) => {
      const idx = s.tabs.findIndex((t) => t.id === id);
      if (idx === -1) return s;
      const tabs = s.tabs.filter((t) => t.id !== id);
      // 关完最后一个 = 收起面板（浏览器语义）
      if (tabs.length === 0) return { tabs, activeId: null, visible: false };
      const activeId =
        s.activeId === id ? tabs[Math.min(idx, tabs.length - 1)].id : s.activeId;
      return { tabs, activeId, visible: s.visible };
    });
  }, []);

  const activateTab = useCallback((id: string) => {
    setState((s) =>
      s.tabs.some((t) => t.id === id) && (s.activeId !== id || !s.visible)
        ? { ...s, activeId: id, visible: true }
        : s
    );
  }, []);

  /**
   * 图片页翻到第几张：只改 index（`images` 数组身份保持不变，图片页不会因此重新装载）。
   * 值没变时返回原 state，避免无谓重渲染。
   */
  const setImageIndex = useCallback((id: string, index: number) => {
    setState((s) => {
      let changed = false;
      const tabs = s.tabs.map((t) => {
        if (t.id !== id || t.kind !== 'image' || t.index === index) return t;
        changed = true;
        return { ...t, index };
      });
      return changed ? { ...s, tabs } : s;
    });
  }, []);

  const setSearchQuery = useCallback((id: string, query: string) => {
    setState((s) => {
      let changed = false;
      const tabs = s.tabs.map((t) => {
        if (t.id !== id || t.kind !== 'wiki-search' || (t.query ?? '') === query) return t;
        changed = true;
        return { ...t, query };
      });
      return changed ? { ...s, tabs } : s;
    });
  }, []);

  const toggleVisible = useCallback(() => {
    setState((s) => {
      if (s.visible) return { ...s, visible: false };
      // 没有任何标签时，展开 = 新建一个搜索页（与 `+` 同一入口语义）
      if (s.tabs.length === 0) {
        const tab: WikiSearchTab = { id: WIKI_SEARCH_TAB_ID, kind: 'wiki-search' };
        return { tabs: [tab], activeId: tab.id, visible: true };
      }
      return { ...s, visible: true };
    });
  }, []);

  const activeTab = useMemo(
    () => state.tabs.find((t) => t.id === state.activeId) ?? null,
    [state.tabs, state.activeId]
  );

  return {
    tabs: state.tabs,
    activeId: state.activeId,
    visible: state.visible,
    activeTab,
    openSearch,
    openArticle,
    openRawText,
    openImage,
    closeTab,
    activateTab,
    setImageIndex,
    setSearchQuery,
    toggleVisible,
  };
}
