import React from 'react';
import { WikiPanel } from './WikiPanel';

interface WikiSidebarProps {
  isOpen: boolean;
  title: string | null;
  /** 引用胶囊传入的 RAG 注入文本（面板顶部以纯文本展示「传给模型的样子」） */
  context?: string | null;
  onClose: () => void;
}

/**
 * 主窗口右侧知识库面板（**停靠型**容器）。
 *
 * 显示机制的唯一实现在 WikiPanel —— 与 Spotlight 浮窗的 WikiDrawer 共用同一份，
 * 两个窗口只在容器形式上不同（停靠侧栏 vs 全屏覆盖抽屉）。
 */
export const WikiSidebar: React.FC<WikiSidebarProps> = ({ isOpen, title, context, onClose }) => (
  <WikiPanel
    variant="docked"
    isOpen={isOpen}
    title={title}
    context={context}
    onClose={onClose}
  />
);
