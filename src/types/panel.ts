import type { ReactNode } from 'react';

/**
 * 主窗口右侧面板的标签模型。
 *
 * 每种标签 = 一个独立页面，**以 id 作为去重键**：同一个条目 / 同一条消息的图片 / 同一份原文
 * 重复点击只激活已有标签，不新建。详见 hooks/usePanelTabs。
 */
export type PanelTabKind = 'wiki-search' | 'wiki-article' | 'raw-text' | 'image';

interface PanelTabBase {
  id: string;
  kind: PanelTabKind;
}

export interface WikiSearchTab extends PanelTabBase {
  kind: 'wiki-search';
  /** 仅用于标签标题显示；页面内部自己持有输入状态，不回灌（避免受控回环） */
  query?: string;
}

export interface WikiArticleTab extends PanelTabBase {
  kind: 'wiki-article';
  title: string;
  /** 引用胶囊携带的 RAG 注入原文（纯本地数据，与服务是否可用无关） */
  injected?: string | null;
}

export interface RawTextTab extends PanelTabBase {
  kind: 'raw-text';
  title: string;
  content: string;
}

export interface ImageTab extends PanelTabBase {
  kind: 'image';
  title: string;
  images: string[];
  index: number;
}

export type PanelTab = WikiSearchTab | WikiArticleTab | RawTextTab | ImageTab;

/** 搜索页全局单例：知识库只有一个，多开无意义 */
export const WIKI_SEARCH_TAB_ID = 'wiki:search';

export const wikiArticleTabId = (title: string) => `wiki:article:${title}`;
export const rawTextTabId = (messageId: string) => `raw:${messageId}`;
export const imageTabId = (messageId: string) => `img:${messageId}`;

/**
 * 页面级「外壳插槽」：主窗口不传（上面就是标签栏），Spotlight 传 ← 与 ✕。
 * 两个窗口因此都只有一层页头，不会出现 44+44 双层。
 */
export interface PageChrome {
  leading?: ReactNode;
  trailing?: ReactNode;
  /**
   * 页头内边距：`tight`（默认，主窗口，贴着标签栏）/ `comfy`（浮窗，与卡片头同为 px-4）。
   * 只影响左右内边距，高度由 pageHeader.ts 统一控制。
   */
  padding?: 'tight' | 'comfy';
}
