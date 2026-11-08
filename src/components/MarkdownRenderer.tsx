import React, { useState, useMemo } from 'react';
import ReactMarkdown, { Components } from 'react-markdown';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import remarkGfm from 'remark-gfm';
import remarkCjkFriendly from 'remark-cjk-friendly';
import remarkBreaks from 'remark-breaks';

import { preprocessMarkdown } from '../utils/markdownPipeline';
import { handleMarkdownCopyEvent } from '../utils/selectionToMarkdown';
import { MermaidBlock } from './MermaidBlock';
import { InteractiveMath } from './InteractiveMath';
import { ImagePreviewModal } from './ImagePreviewModal';
import { CodeBlock } from './markdown/CodeBlock';
import { TableBlock } from './markdown/TableBlock';

interface MarkdownRendererProps {
  content: string;
  className?: string;
  breaks?: boolean;
  /**
   * 该条消息仍在流式输出（`message.pending`）。
   * 只用于判断「围栏代码块是否还在长」——见 findOpenFenceBody。
   */
  streaming?: boolean;
}

interface StreamInfo {
  /** 最后一个尚未闭合的围栏代码块的正文；没有就是 null */
  generatingTail: string | null;
}

const IDLE_STREAM: StreamInfo = { generatingTail: null };

/** 「这块还在生成」只通过 Context 下发 —— MARKDOWN_COMPONENTS 必须保持模块级 hoist，不能改成闭包 */
const StreamContext = React.createContext<StreamInfo>(IDLE_STREAM);

/**
 * 找出「最后一个未闭合围栏」的正文。
 *
 * 为什么不用消息级 pending 一刀切：一条消息里可能有多个代码块，前面的早就写完了，
 * 那时就应该能预览；只有末尾那个还在长的块需要锁定。
 *
 * 判定依据是围栏是否闭合：闭合围栏必须同字符、长度不短于开启围栏、后面除空格外无内容。
 * mdast 会把「未闭合到文件末尾」的内容照样解析成 code 节点，所以只能靠这段扫描区分。
 */
export function findOpenFenceBody(markdown: string): string | null {
  const lines = markdown.split('\n');
  let fenceChar = '';
  let fenceLen = 0;
  let open = false;
  let body: string[] = [];

  for (const line of lines) {
    const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (!open) {
      // 反引号围栏的 info string 不允许再出现反引号（CommonMark）
      if (m && !(m[1][0] === '`' && m[2].includes('`'))) {
        open = true;
        fenceChar = m[1][0];
        fenceLen = m[1].length;
        body = [];
      }
      continue;
    }
    if (m && m[1][0] === fenceChar && m[1].length >= fenceLen && m[2].trim() === '') {
      open = false;
      body = [];
      continue;
    }
    body.push(line);
  }

  return open ? body.join('\n') : null;
}

const normalizeFence = (value: string): string => value.replace(/\s+$/, '');

/**
 * 围栏代码块分发：mermaid 走专用组件，其余走 CodeBlock。
 * generating 的判定吃 StreamContext —— 所以这里必须是独立组件，不能用内联函数。
 */
const CodeFence: React.FC<{ language: string; code: string }> = ({ language, code }) => {
  const { generatingTail } = React.useContext(StreamContext);
  const generating =
    generatingTail !== null && normalizeFence(code) === normalizeFence(generatingTail);

  if (language === 'mermaid') {
    return <MermaidBlock code={code} />;
  }
  return <CodeBlock language={language} code={code} generating={generating} />;
};

// Hoisted static plugin & component configurations so ReactMarkdown never unmounts/remounts
// <CodeBlock>, <TableBlock>, or <MermaidBlock> DOM nodes across streaming chunks or parent re-renders.
const REMARK_PLUGINS: any[] = [remarkMath, remarkGfm, remarkCjkFriendly];
const BREAKS_REMARK_PLUGINS: any[] = [remarkMath, remarkGfm, remarkCjkFriendly, remarkBreaks];
const REHYPE_PLUGINS: any[] = [[rehypeKatex, { throwOnError: false, strict: false }]];

const InsideDisplayMathContext = React.createContext(false);

const MarkdownImage: React.FC<React.ImgHTMLAttributes<HTMLImageElement>> = ({ src, alt, ...props }) => {
  const [isOpen, setIsOpen] = useState(false);
  if (!src) return null;
  return (
    <>
      <img
        src={src}
        alt={alt}
        onClick={() => setIsOpen(true)}
        className="max-w-full rounded-xl border border-black/10 dark:border-white/10 shadow-sm cursor-zoom-in hover:opacity-95 active:scale-[0.99] transition-all my-2 select-none"
        loading="lazy"
        {...props}
      />
      {isOpen && (
        <ImagePreviewModal
          isOpen={isOpen}
          onClose={() => setIsOpen(false)}
          images={[src]}
          initialIndex={0}
        />
      )}
    </>
  );
};

const MARKDOWN_COMPONENTS: Components = {
  img({ src, alt, ...props }) {
    return <MarkdownImage src={src} alt={alt} {...props} />;
  },
  a({ href, children, ...props }) {
    const external = /^https?:\/\//i.test(href || '');
    return (
      <a
        href={href}
        {...(external ? { target: '_blank', rel: 'noreferrer' } : {})}
        {...props}
      >
        {children}
      </a>
    );
  },
  table({ children }) {
    return <TableBlock>{children}</TableBlock>;
  },
  pre({ children }) {
    // Render fenced code blocks directly without wrapping a block <div> inside <pre>
    const child = React.Children.toArray(children)[0];
    if (child && React.isValidElement(child)) {
      const childProps = (
        child as React.ReactElement<{ className?: string; children?: React.ReactNode }>
      ).props;
      const childClassName = String(childProps?.className || '');
      const match = /language-([\w+-]+)/.exec(childClassName);
      const language = match ? match[1].toLowerCase() : '';
      const rawChildren = childProps?.children;
      const codeString = String(rawChildren ?? '').replace(/\n$/, '');
      return <CodeFence language={language} code={codeString} />;
    }
    return <pre>{children}</pre>;
  },
  code({ className, children, ...props }) {
    const match = /language-([\w+-]+)/.exec(className || '');
    const language = match ? match[1].toLowerCase() : '';
    const codeString = String(children ?? '').replace(/\n$/, '');

    // Fallback if a block code element is rendered outside <pre>
    if (match || codeString.includes('\n')) {
      return <CodeFence language={language} code={codeString} />;
    }

    return (
      <code className={className} {...props}>
        {children}
      </code>
    );
  },
  span({ className, children, ...props }) {
    const isInsideDisplay = React.useContext(InsideDisplayMathContext);

    if (className?.includes('katex-display')) {
      return (
        <InsideDisplayMathContext.Provider value={true}>
          <InteractiveMath display={true}>
            <span className={className} {...props}>
              {children}
            </span>
          </InteractiveMath>
        </InsideDisplayMathContext.Provider>
      );
    }

    if (
      className?.includes('katex') &&
      !isInsideDisplay &&
      !className?.includes('katex-mathml') &&
      !className?.includes('katex-html')
    ) {
      return (
        <InteractiveMath display={false}>
          <span className={className} {...props}>
            {children}
          </span>
        </InteractiveMath>
      );
    }

    return (
      <span className={className} {...props}>
        {children}
      </span>
    );
  },
};

export const MarkdownRenderer: React.FC<MarkdownRendererProps> = React.memo(
  ({ content, className, breaks = false, streaming = false }) => {
    const normalizedContent = useMemo(() => {
      return preprocessMarkdown(content);
    }, [content]);

    // 只有消息还在流式时才扫描；value 按字符串本身记忆，避免每个 token 都换一次 Context 身份
    const openFenceBody = streaming ? findOpenFenceBody(normalizedContent) : null;
    const streamInfo = useMemo<StreamInfo>(
      () => (openFenceBody === null ? IDLE_STREAM : { generatingTail: openFenceBody }),
      [openFenceBody]
    );

    const remarkPlugins = breaks ? BREAKS_REMARK_PLUGINS : REMARK_PLUGINS;

    return (
      <div
        onCopy={(e) => handleMarkdownCopyEvent(e, content)}
        className={`markdown-body selectable-chat-content cursor-text ${
          className || 'text-[#1f2328] dark:text-[#e0e1e4] leading-relaxed'
        }`}
      >
        <StreamContext.Provider value={streamInfo}>
          <ReactMarkdown
            remarkPlugins={remarkPlugins}
            rehypePlugins={REHYPE_PLUGINS}
            components={MARKDOWN_COMPONENTS}
          >
            {normalizedContent}
          </ReactMarkdown>
        </StreamContext.Provider>
      </div>
    );
  }
);

MarkdownRenderer.displayName = 'MarkdownRenderer';
