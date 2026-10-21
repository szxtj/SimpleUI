import React from 'react';
import { ImagePreviewModal } from '../ImagePreviewModal';
import type { PageChrome } from '../../types/panel';

interface ImagePageProps {
  images: string[];
  /** 打开时的初始下标；同一消息的另一张图被点时会被切过来 */
  index: number;
  chrome?: PageChrome;
  /** 是否当前可见（不可见的页面不抢键盘快捷键） */
  active?: boolean;
}

/**
 * 图片页（主窗口标签 / 浮窗整页）。
 *
 * **直接复用 `ImagePreviewModal` 的嵌入模式**，而不是另写一个简化查看器：
 * 缩放（按钮 / 滚轮 / 触控板捏合）、拖拽平移 + 橡皮筋、双击缩放、画廊前后、
 * 复制图片、下载、在「预览」中打开，全部与原来的弹窗逐字一致。
 * 页头由外层页面注入（主窗口无、浮窗有 ← ✕），不再出现双层头部。
 */
export const ImagePage: React.FC<ImagePageProps> = ({ images, index, chrome, active = true }) => (
  <ImagePreviewModal
    embedded
    active={active}
    isOpen
    onClose={() => {
      /* 页面形态由标签 ✕ / 浮窗页头 ✕ 关闭 */
    }}
    images={images}
    initialIndex={index}
    chrome={chrome}
  />
);
