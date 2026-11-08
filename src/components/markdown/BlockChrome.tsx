import React, { useCallback, useEffect, useRef, useState } from 'react';

/**
 * 对话区「块」的统一外壳 —— 代码块 / 表格 / Mermaid 三处共用这一份。
 *
 * 为什么单列一个文件：这三块原先各自手写了一份几乎逐字相同的头部（容器描边、头部底色、
 * 按钮内边距、复制定态 setTimeout），并且已经漂移出两处色差：
 *   - 头部底色：CodeBlock `#f0f2f5` vs Table/Mermaid `#f6f8fa`
 *   - 容器底色：CodeBlock `#f8f9fb` vs Table/Mermaid `#ffffff`
 * 这里把「容器 / 头部 / 按钮 / 分段切换 / 复制定态」收敛成唯一来源，新增块只组装、不再复制。
 *
 * 三条不可违反的约束：
 * 1. 头部必须带 `data-copy-ignore="true"` —— 划选转 Markdown 的序列化器靠它跳过工具条，
 *    漏掉会把「复制代码」这类按钮文案一起抄进剪贴板。
 * 2. 每个颜色都必须成对给出 `dark:` 变体（Tailwind `darkMode: 'class'`，由 `useTheme()`
 *    切 `<html class="dark">`）。裸色值在深色下会变成刺眼的白块。
 * 3. 头部容器不要加 `overflow-hidden` —— 会裁掉按钮 hover 的圆角高亮。
 */

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

/** 外壳：圆角 + 1px 描边 + 裁边。刻意不含外边距，由各块自己决定（代码块还要接输出层）。 */
export const BLOCK_SHELL_CLASS =
  'relative rounded-lg overflow-hidden border border-[#d0d7de] dark:border-[#33363d] bg-white dark:bg-[#1a1b1e]';

/** 头部一行：左标签 + 右动作，30px 高，永不被划选 */
export const BLOCK_HEADER_CLASS =
  // 固定 33px 高：分段切换（21px）会让 py 撑出头高低差，改为定高后三块逐像素对齐
  'flex items-center justify-between gap-2 h-[33px] px-3.5 bg-[#f6f8fa] dark:bg-[#22242a] text-xs text-zinc-500 dark:text-[#9aa0a6] select-none';

export const BLOCK_HEADER_BORDER_CLASS = 'border-b border-[#d0d7de] dark:border-[#33363d]';

/** 左侧语言/类型标签 */
export const BLOCK_LABEL_CLASS =
  'font-mono uppercase font-semibold text-[11px] tracking-wider text-zinc-600 dark:text-[#abb2bf]';

/**
 * 源码主体（<pre>）：外壳已经有底色，这里保持透明。
 *
 * 高度封顶与 iframe 预览统一为 480px —— 两侧切换时块高不跳；超出在块内滚动。
 * 「统一」的意思是：代码 / Mermaid 源码 / Python stdout / Traceback 全走这个上限，
 * 不再出现一段 200 行代码把整条对话顶下去的情况。
 */
export const BLOCK_CONTENT_MAX_HEIGHT = 480;

export const BLOCK_CODE_CLASS =
  '!m-0 !p-3.5 max-h-[480px] overflow-auto text-[0.88em] font-mono leading-relaxed text-[#1f2328] dark:text-[#f0f3f6] bg-transparent border-0 whitespace-pre cursor-text';

interface BlockShellProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode;
}

export const BlockShell: React.FC<BlockShellProps> = ({ children, className, ...rest }) => (
  <div className={cx(BLOCK_SHELL_CLASS, className)} {...rest}>
    {children}
  </div>
);

interface BlockHeaderProps {
  /** 左侧标签文案，如 HTML / TABLE / MERMAID */
  label: React.ReactNode;
  /** 标签前缀图标 */
  icon?: React.ReactNode;
  /** 标签右侧的附加控件（当前用于「预览/源码」「图表/源码」分段切换） */
  leading?: React.ReactNode;
  /** 右侧动作区 */
  children?: React.ReactNode;
  /** 主体被折叠时传 false，去掉分隔线，头部自己收成一个胶囊 */
  bordered?: boolean;
}

export const BlockHeader: React.FC<BlockHeaderProps> = ({
  label,
  icon,
  leading,
  children,
  bordered = true,
}) => (
  <div
    data-copy-ignore="true"
    className={cx(BLOCK_HEADER_CLASS, bordered && BLOCK_HEADER_BORDER_CLASS)}
  >
    <div className="flex items-center gap-2 min-w-0">
      <span className={cx(BLOCK_LABEL_CLASS, 'flex items-center gap-1.5 shrink-0')}>
        {icon}
        <span className="truncate">{label}</span>
      </span>
      {leading}
    </div>
    <div className="flex items-center gap-1 shrink-0">{children}</div>
  </div>
);

export type ToolButtonTone = 'default' | 'accent' | 'success' | 'danger';

const TONE_CLASS: Record<ToolButtonTone, string> = {
  default: 'text-zinc-600 dark:text-[#b0b4bd] hover:bg-black/5 dark:hover:bg-[#32363e]',
  accent:
    'text-blue-600 dark:text-blue-400 font-medium hover:bg-blue-50 dark:hover:bg-blue-950/40',
  success: 'text-emerald-600 dark:text-emerald-400',
  danger:
    'text-zinc-500 dark:text-[#9aa0a6] hover:text-rose-600 dark:hover:text-rose-400 hover:bg-rose-500/10',
};

interface ToolButtonProps {
  icon: React.ReactNode;
  label?: string;
  title?: string;
  onClick?: () => void;
  tone?: ToolButtonTone;
  /** 0.5 透明度 + 禁用交互（如「生成中不可切换」） */
  disabled?: boolean;
  className?: string;
}

export const ToolButton: React.FC<ToolButtonProps> = ({
  icon,
  label,
  title,
  onClick,
  tone = 'default',
  disabled = false,
  className,
}) => (
  <button
    type="button"
    onClick={disabled ? undefined : onClick}
    disabled={disabled}
    title={title}
    aria-disabled={disabled || undefined}
    className={cx(
      'flex items-center gap-1.5 px-2 py-0.5 rounded transition-colors text-[11px]',
      TONE_CLASS[tone],
      disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer',
      className
    )}
  >
    {icon}
    {label ? <span className="whitespace-nowrap">{label}</span> : null}
  </button>
);

export interface SegmentedOption {
  value: string;
  label: string;
  icon?: React.ReactNode;
  title?: string;
}

interface SegmentedToggleProps {
  options: SegmentedOption[];
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  /** 禁用时的悬浮说明（如「生成中，完成后可预览」） */
  disabledHint?: string;
}

/** 分段切换：先由 Mermaid 的「图表 / 源码」使用，现在 HTML 的「预览 / 源码」共用同一份 */
export const SegmentedToggle: React.FC<SegmentedToggleProps> = ({
  options,
  value,
  onChange,
  disabled = false,
  disabledHint,
}) => (
  <div
    className={cx(
      'flex items-center rounded-md p-[1px] border h-[21px] bg-black/[0.04] dark:bg-[#18191e] border-black/5 dark:border-white/5',
      disabled && 'opacity-50'
    )}
  >
    {options.map((opt) => {
      const active = opt.value === value;
      return (
        <button
          key={opt.value}
          type="button"
          onClick={disabled ? undefined : () => onChange(opt.value)}
          disabled={disabled}
          title={disabled ? disabledHint || opt.title : opt.title}
          aria-pressed={active}
          className={cx(
            'flex items-center gap-1 px-2 h-[17px] rounded text-[11px] leading-none transition-colors',
            active
              ? 'bg-white dark:bg-[#32363e] text-zinc-900 dark:text-white font-medium shadow-xs'
              : 'text-zinc-500 dark:text-[#8b929e]',
            disabled
              ? 'cursor-not-allowed'
              : active
                ? 'cursor-pointer'
                : 'cursor-pointer hover:text-zinc-900 dark:hover:text-white'
          )}
        >
          {opt.icon}
          <span>{opt.label}</span>
        </button>
      );
    })}
  </div>
);

/**
 * 复制定态（点了变「已复制」，N 秒后回弹）。
 * 三块原先各自 `setTimeout` 且都不清理——块在 2 秒内被卸载就是一次 setState on unmounted。
 */
export function useCopyFeedback(duration = 2000) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);

  const flash = useCallback(() => {
    setCopied(true);
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(false), duration);
  }, [duration]);

  useEffect(
    () => () => {
      if (timer.current) window.clearTimeout(timer.current);
    },
    []
  );

  return { copied, flash };
}
