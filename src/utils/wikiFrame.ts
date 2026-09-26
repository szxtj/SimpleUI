// 知识库原文展示的工具函数
//
// 设计决定：不再在 APP 内嵌维基页面 iframe。
// 原因：完整 MediaWiki 页面（Vector 2022 皮肤 + 自带 JS + 自带主题）嵌入
// 440px 面板会带来——MediaWiki JS 与父页面共享主线程导致全界面冻结、
// 页面主题跟随系统而非 APP 无法覆盖、巨型页面在窄面板中发热卡顿。
// 因此：抽取正文以原生 React 组件渲染（主题天然跟随 APP）；
// 原版页面通过系统浏览器打开（一键可达）。

import { useState, useEffect } from 'react';

export const WIKI_CONTENT_ID = 'wikipedia_zh_all_maxi';

export const WIKI_BASE_URL = `http://127.0.0.1:31236/content/${WIKI_CONTENT_ID}/`;

/** 原版条目页（系统浏览器打开） */
export function buildWikiExternalUrl(title?: string | null): string {
  if (!title) return WIKI_BASE_URL;
  return `${WIKI_BASE_URL}${encodeURIComponent(title)}`;
}

/** 跟随主题的 isDark（system 模式下监听系统切换，避免 matchMedia 取值滞留） */
export function useResolvedIsDark(theme?: 'light' | 'dark' | 'system'): boolean {
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia('(prefers-color-scheme: dark)').matches
  );
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);
  if (theme === 'dark') return true;
  if (theme === 'light') return false;
  return systemDark;
}
