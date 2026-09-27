import React from 'react';
import { WikiPanel } from './WikiPanel';

interface WikiDrawerProps {
  isOpen: boolean;
  title: string | null;
  /** 引用胶囊传入的 RAG 注入文本（面板顶部以纯文本展示「传给模型的样子」） */
  context?: string | null;
  onClose: () => void;
}

/**
 * Spotlight 浮窗的知识库面板（**覆盖型**容器）。
 *
 * 显示机制与主窗口 WikiSidebar **完全一致**（同一份 WikiPanel 实现）：
 * 顶部注入原文块 + 完整条目富文本（公式 / 表格 / 图片 / 子标题）+ 搜索栏 + 结果列表 + 空态。
 * 仅容器不同：固定全屏覆盖 + 背景遮罩（浮窗空间有限，需要盖住整个面板）。
 */
export const WikiDrawer: React.FC<WikiDrawerProps> = ({ isOpen, title, context, onClose }) => (
  <WikiPanel
    variant="overlay"
    isOpen={isOpen}
    title={title}
    context={context}
    onClose={onClose}
  />
);
