import React from 'react';
import { WikiPanel } from './WikiPanel';

interface WikiDrawerProps {
  isOpen: boolean;
  title: string | null;
  /** 引用胶囊传入的 RAG 注入文本（面板顶部以纯文本展示「传给模型的样子」） */
  context?: string | null;
  onClose: () => void;
  /** 关闭整个 Spotlight 浮窗（面板左上角的整体关闭按钮，与展开态头部同款） */
  onCloseWindow?: () => void;
  /** 知识库服务总开关（关闭时整个服务停服） */
  wikiEnabled?: boolean;
  /** 知识库是否就绪（服务开启且 ZIM 可用）——不可用时面板只给统一提醒且不发请求 */
  wikiConnected?: boolean;
}

/**
 * Spotlight 浮窗的知识库面板（**覆盖型**容器）。
 *
 * 显示机制与主窗口 WikiSidebar **完全一致**（同一份 WikiPanel 实现）：
 * 顶部注入原文块 + 完整条目富文本（公式 / 表格 / 图片 / 子标题）+ 搜索栏 + 结果列表 + 空态。
 * 仅容器不同：整块覆盖浮窗、与浮窗卡片同圆角同描边、左上角带整体关闭按钮。
 */
export const WikiDrawer: React.FC<WikiDrawerProps> = ({
  isOpen,
  title,
  context,
  onClose,
  onCloseWindow,
  wikiEnabled,
  wikiConnected,
}) => (
  <WikiPanel
    variant="overlay"
    isOpen={isOpen}
    title={title}
    context={context}
    onClose={onClose}
    onCloseWindow={onCloseWindow}
    wikiEnabled={wikiEnabled}
    wikiConnected={wikiConnected}
  />
);
