import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import './index.css';

/**
 * 屏蔽浏览器原生右键菜单。
 *
 * 这是装在原生 macOS 壳里的桌面应用（WKWebView），原生菜单里的 Reload / Back / Inspect
 * 之类项不属于本应用该有的交互——尤其 Reload 会直接把 SPA 冲掉。
 * 但**输入框、文本域、contenteditable 内保留**原生菜单，否则用户没法正常复制/粘贴/选词。
 */
function suppressNativeContextMenu(): void {
  document.addEventListener(
    'contextmenu',
    (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      const editable = target?.closest?.('input, textarea, [contenteditable="true"], [contenteditable=""]');
      if (editable) return; // 输入区域：保留原生菜单
      event.preventDefault();
    },
    false
  );
}

suppressNativeContextMenu();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
