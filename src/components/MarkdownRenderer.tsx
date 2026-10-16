import React, { useState, useMemo, useRef } from 'react';
import ReactMarkdown, { Components } from 'react-markdown';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import remarkGfm from 'remark-gfm';
import remarkCjkFriendly from 'remark-cjk-friendly';
import { Check, Copy, Table as TableIcon, FileText } from 'lucide-react';
import { useI18n } from '../i18n';

import { preprocessMarkdown } from '../utils/markdownPipeline';
import {
  handleMarkdownCopyEvent,
  serializeTableElementToMarkdown,
  serializeTableElementToRichData,
  serializeTableElementToDocxXml,
} from '../utils/selectionToMarkdown';
import { MermaidBlock } from './MermaidBlock';
import { InteractiveMath } from './InteractiveMath';

interface MarkdownRendererProps {
  content: string;
  className?: string;
}

interface CodeBlockProps {
  language: string;
  code: string;
}

const CodeBlock: React.FC<CodeBlockProps> = React.memo(({ language, code }) => {
  const { t, lang } = useI18n();
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

  const isEn = lang === 'en';

  return (
    <div
      data-md-codeblock="true"
      data-language={language || ''}
      data-raw-code={code}
      className="relative my-3 rounded-lg overflow-hidden border border-[#d0d7de] dark:border-[#33363d] bg-[#f8f9fb] dark:bg-[#1a1b1e]"
    >
      <div
        data-copy-ignore="true"
        className="flex items-center justify-between px-3.5 py-1.5 bg-[#f0f2f5] dark:bg-[#22242a] border-b border-[#d0d7de] dark:border-[#33363d] text-xs text-zinc-500 dark:text-[#9aa0a6] select-none"
      >
        <span className="font-mono uppercase font-semibold text-[11px] tracking-wider text-zinc-600 dark:text-[#abb2bf]">
          {language || 'text'}
        </span>
        <button
          type="button"
          onClick={handleCopy}
          className="flex items-center gap-1.5 px-2 py-0.5 rounded hover:bg-black/5 dark:hover:bg-[#32363e] text-zinc-600 dark:text-[#b0b4bd] transition-colors cursor-pointer"
          title={t('copyCodeTooltip')}
        >
          {copied ? (
            <>
              <Check className="w-3.5 h-3.5 text-emerald-500 dark:text-emerald-400" />
              <span className="text-emerald-600 dark:text-emerald-400 text-[11px]">{t('copied')}</span>
            </>
          ) : (
            <>
              <Copy className="w-3.5 h-3.5" />
              <span className="text-[11px]">{isEn ? 'Copy Code' : '复制代码'}</span>
            </>
          )}
        </button>
      </div>
      <pre className="!m-0 !p-3.5 overflow-x-auto overflow-y-hidden text-[0.88em] font-mono leading-relaxed text-[#1f2328] dark:text-[#f0f3f6] bg-transparent border-0 whitespace-pre cursor-text">
        <code className="!bg-transparent !p-0 !text-inherit font-mono whitespace-pre">{code}</code>
      </pre>
    </div>
  );
});

CodeBlock.displayName = 'CodeBlock';

interface TableBlockProps {
  children?: React.ReactNode;
}

const TableBlock: React.FC<TableBlockProps> = React.memo(({ children }) => {
  const { lang } = useI18n();
  const tableRef = useRef<HTMLTableElement | null>(null);
  const [copiedMd, setCopiedMd] = useState(false);
  const [copiedRich, setCopiedRich] = useState(false);
  const [openedWord, setOpenedWord] = useState(false);

  const isEn = lang === 'en';

  const handleOpenInWord = () => {
    if (!tableRef.current) return;
    try {
      const docxXml = serializeTableElementToDocxXml(tableRef.current);
      if (!docxXml) return;
      if ((window as any).webkit?.messageHandlers?.openTableInWord) {
        (window as any).webkit.messageHandlers.openTableInWord.postMessage({
          documentXml: docxXml,
        });
        setOpenedWord(true);
        setTimeout(() => setOpenedWord(false), 2000);
      }
    } catch (e) {
      console.error('Failed to open table in Word:', e);
    }
  };

  const handleCopyMarkdown = async () => {
    if (!tableRef.current) return;
    try {
      const md = serializeTableElementToMarkdown(tableRef.current);
      if (md) {
        await navigator.clipboard.writeText(md);
        setCopiedMd(true);
        setTimeout(() => setCopiedMd(false), 2000);
      }
    } catch (e) {
      console.error('Failed to copy table markdown:', e);
    }
  };

  const handleCopyRichTable = async () => {
    if (!tableRef.current) return;
    try {
      const { tsv, html } = serializeTableElementToRichData(tableRef.current);
      let bridged = false;
      try {
        if ((window as any).webkit?.messageHandlers?.copyRichData) {
          (window as any).webkit.messageHandlers.copyRichData.postMessage({
            html,
            plainText: tsv,
          });
          bridged = true;
        }
      } catch {
        bridged = false;
      }

      if (!bridged) {
        if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
          const item = new ClipboardItem({
            'text/html': new Blob([html], { type: 'text/html' }),
            'text/plain': new Blob([tsv], { type: 'text/plain' }),
          });
          await navigator.clipboard.write([item]);
        } else {
          await navigator.clipboard.writeText(tsv);
        }
      }
      setCopiedRich(true);
      setTimeout(() => setCopiedRich(false), 2000);
    } catch (e) {
      console.error('Failed to copy rendered table:', e);
    }
  };

  return (
    <div className="my-3 rounded-lg overflow-hidden border border-[#d0d7de] dark:border-[#33363d] bg-white dark:bg-[#1a1b1e]">
      <div
        data-copy-ignore="true"
        className="flex items-center justify-between px-3 py-1.5 bg-[#f6f8fa] dark:bg-[#22242a] border-b border-[#d0d7de] dark:border-[#33363d] text-xs text-zinc-500 dark:text-[#9aa0a6] select-none"
      >
        <span className="font-mono uppercase font-semibold text-[11px] tracking-wider text-zinc-600 dark:text-[#abb2bf] flex items-center gap-1.5">
          <TableIcon className="w-3.5 h-3.5 opacity-80" />
          <span>{isEn ? 'TABLE' : '表格'}</span>
        </span>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={handleOpenInWord}
            className="flex items-center gap-1 px-2 py-0.5 rounded hover:bg-blue-50 dark:hover:bg-blue-950/40 text-blue-600 dark:text-blue-400 font-medium transition-colors cursor-pointer"
            title={
              isEn
                ? 'Open native table with editable equations directly in Microsoft Word'
                : '在 Microsoft Word 中直接打开原生表格与公式'
            }
          >
            {openedWord ? (
              <>
                <Check className="w-3.5 h-3.5 text-emerald-500 dark:text-emerald-400" />
                <span className="text-emerald-600 dark:text-emerald-400 text-[11px]">
                  {isEn ? 'Opened' : '已在 Word 打开'}
                </span>
              </>
            ) : (
              <>
                <FileText className="w-3.5 h-3.5" />
                <span className="text-[11px]">{isEn ? 'Open in Word' : '在 Word 中打开'}</span>
              </>
            )}
          </button>

          <button
            type="button"
            onClick={handleCopyRichTable}
            className="flex items-center gap-1 px-2 py-0.5 rounded hover:bg-black/5 dark:hover:bg-[#32363e] text-zinc-600 dark:text-[#b0b4bd] transition-colors cursor-pointer"
            title={
              isEn
                ? 'Copy table (formulas kept as LaTeX, for Excel / Notion / Sheets)'
                : '复制表格（公式保留为 LaTeX，支持粘贴至 Excel / Notion / 飞书）'
            }
          >
            {copiedRich ? (
              <>
                <Check className="w-3.5 h-3.5 text-emerald-500 dark:text-emerald-400" />
                <span className="text-emerald-600 dark:text-emerald-400 text-[11px]">
                  {isEn ? 'Table Copied' : '已复制表格'}
                </span>
              </>
            ) : (
              <>
                <TableIcon className="w-3.5 h-3.5" />
                <span className="text-[11px]">{isEn ? 'Copy Table' : '复制表格'}</span>
              </>
            )}
          </button>

          <button
            type="button"
            onClick={handleCopyMarkdown}
            className="flex items-center gap-1 px-2 py-0.5 rounded hover:bg-black/5 dark:hover:bg-[#32363e] text-zinc-600 dark:text-[#b0b4bd] transition-colors cursor-pointer"
            title={isEn ? 'Copy raw Markdown table' : '复制 Markdown 表格原文'}
          >
            {copiedMd ? (
              <>
                <Check className="w-3.5 h-3.5 text-emerald-500 dark:text-emerald-400" />
                <span className="text-emerald-600 dark:text-emerald-400 text-[11px]">
                  {isEn ? 'MD Copied' : '已复制 MD'}
                </span>
              </>
            ) : (
              <>
                <FileText className="w-3.5 h-3.5" />
                <span className="text-[11px]">{isEn ? 'Copy Markdown' : '复制 Markdown'}</span>
              </>
            )}
          </button>
        </div>
      </div>

      <div className="overflow-x-auto overflow-y-hidden">
        <table ref={tableRef} className="!my-0 !border-0 w-full">
          {children}
        </table>
      </div>
    </div>
  );
});

TableBlock.displayName = 'TableBlock';

// Hoisted static plugin & component configurations so ReactMarkdown never unmounts/remounts
// <CodeBlock>, <TableBlock>, or <MermaidBlock> DOM nodes across streaming chunks or parent re-renders.
const REMARK_PLUGINS: any[] = [remarkMath, remarkGfm, remarkCjkFriendly];
const REHYPE_PLUGINS: any[] = [[rehypeKatex, { throwOnError: false, strict: false }]];

const InsideDisplayMathContext = React.createContext(false);

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
      if (language === 'mermaid') {
        return <MermaidBlock code={codeString} />;
      }
      return <CodeBlock language={language} code={codeString} />;
    }
    return <pre>{children}</pre>;
  },
  code({ className, children, ...props }) {
    const match = /language-([\w+-]+)/.exec(className || '');
    const language = match ? match[1].toLowerCase() : '';
    const codeString = String(children ?? '').replace(/\n$/, '');

    // Fallback if a block code element is rendered outside <pre>
    if (match || codeString.includes('\n')) {
      if (language === 'mermaid') {
        return <MermaidBlock code={codeString} />;
      }
      return <CodeBlock language={language} code={codeString} />;
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
  ({ content, className }) => {
    const normalizedContent = useMemo(() => {
      return preprocessMarkdown(content);
    }, [content]);

    return (
      <div
        onCopy={(e) => handleMarkdownCopyEvent(e, content)}
        className={`markdown-body selectable-chat-content cursor-text ${
          className || 'text-[#1f2328] dark:text-[#e0e1e4] leading-relaxed'
        }`}
      >
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
