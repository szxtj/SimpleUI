import React, { useState, useMemo } from 'react';
import ReactMarkdown, { Components } from 'react-markdown';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import remarkGfm from 'remark-gfm';
import remarkCjkFriendly from 'remark-cjk-friendly';
import { Check, Copy } from 'lucide-react';
import { useI18n } from '../i18n';

import { preprocessMarkdown } from '../utils/markdownPipeline';

interface MarkdownRendererProps {
  content: string;
  className?: string;
}

interface CodeBlockProps {
  language: string;
  code: string;
}

const CodeBlock: React.FC<CodeBlockProps> = React.memo(({ language, code }) => {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      console.error('Failed to copy code:', e);
    }
  };

  return (
    <div className="relative my-3 rounded-lg overflow-hidden border border-[#33363d] bg-[#1a1b1e]">
      <div className="flex items-center justify-between px-3.5 py-1.5 bg-[#22242a] border-b border-[#33363d] text-xs text-[#9aa0a6] select-none">
        <span className="font-mono uppercase font-semibold text-[11px] tracking-wider text-[#abb2bf]">
          {language || 'text'}
        </span>
        <button
          onClick={handleCopy}
          className="flex items-center gap-1.5 px-2 py-0.5 rounded hover:bg-[#32363e] text-[#b0b4bd] transition-colors"
          title={t('copyCodeTooltip')}
        >
          {copied ? (
            <>
              <Check className="w-3.5 h-3.5 text-emerald-400" />
              <span className="text-emerald-400 text-[11px]">{t('copied')}</span>
            </>
          ) : (
            <>
              <Copy className="w-3.5 h-3.5" />
              <span className="text-[11px]">{t('copy')}</span>
            </>
          )}
        </button>
      </div>
      <div className="p-3.5 overflow-x-auto overflow-y-hidden text-[0.88em] font-mono leading-relaxed text-[#f0f3f6]">
        <code>{code}</code>
      </div>
    </div>
  );
});

CodeBlock.displayName = 'CodeBlock';

// Hoisted static plugin & component configurations so ReactMarkdown never unmounts/remounts
// <CodeBlock> DOM nodes across streaming chunks or parent re-renders.
const REMARK_PLUGINS: any[] = [remarkMath, remarkGfm, remarkCjkFriendly];
const REHYPE_PLUGINS: any[] = [[rehypeKatex, { throwOnError: false, strict: false }]];

const MARKDOWN_COMPONENTS: Components = {
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
  pre({ children }) {
    // Render fenced code blocks directly without wrapping a block <div> inside <pre>
    const child = React.Children.toArray(children)[0];
    if (child && React.isValidElement(child)) {
      const childProps = (child as React.ReactElement<{ className?: string; children?: React.ReactNode }>).props;
      const childClassName = String(childProps?.className || '');
      const match = /language-([\w+-]+)/.exec(childClassName);
      const language = match ? match[1] : '';
      const rawChildren = childProps?.children;
      const codeString = String(rawChildren ?? '').replace(/\n$/, '');
      return <CodeBlock language={language} code={codeString} />;
    }
    return <pre>{children}</pre>;
  },
  code({ className, children, ...props }) {
    const match = /language-([\w+-]+)/.exec(className || '');
    const codeString = String(children ?? '').replace(/\n$/, '');

    // Fallback if a block code element is rendered outside <pre>
    if (match || codeString.includes('\n')) {
      return <CodeBlock language={match ? match[1] : ''} code={codeString} />;
    }

    return (
      <code className={className} {...props}>
        {children}
      </code>
    );
  },
};

export const MarkdownRenderer: React.FC<MarkdownRendererProps> = React.memo(
  ({ content, className }) => {
    const normalizedContent = useMemo(() => {
      return preprocessMarkdown(content);
    }, [content]);

    return (
      <div className={`markdown-body ${className || 'text-[#e0e1e4] leading-relaxed'}`}>
        <ReactMarkdown
          remarkPlugins={REMARK_PLUGINS}
          rehypePlugins={REHYPE_PLUGINS}
          components={MARKDOWN_COMPONENTS}
        >
          {normalizedContent}
        </ReactMarkdown>
      </div>
    );
  }
);

MarkdownRenderer.displayName = 'MarkdownRenderer';
