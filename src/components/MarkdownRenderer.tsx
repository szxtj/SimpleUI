import React, { useState, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import remarkGfm from 'remark-gfm';
import { Check, Copy } from 'lucide-react';
import { useI18n } from '../i18n';

interface MarkdownRendererProps {
  content: string;
  className?: string;
}

/**
 * Preprocess markdown content to solve CommonMark bold (**) parsing failures
 * with CJK punctuation, trailing colons, and internal spaces without altering code blocks or math.
 */
function preprocessMarkdownBold(content: string): string {
  if (!content) return '';

  const tokens: string[] = [];
  const placeholder = (idx: number) => `__PROTECTED_BLOCK_${idx}__`;

  // Protect code blocks, inline code, and LaTeX math ($$ and $)
  let protectedContent = content.replace(
    /(```[\s\S]*?```|`[^`\n]+`|\$\$[\s\S]*?\$\$|\$[^\$\n]+\$)/g,
    (match) => {
      tokens.push(match);
      return placeholder(tokens.length - 1);
    }
  );

  // 1. Trim inner spaces inside **...**: ** text ** -> **text**
  protectedContent = protectedContent.replace(/\*\*([ \t]+)(.+?)\*\*/g, '**$2**');
  protectedContent = protectedContent.replace(/\*\*(.+?)([ \t]+)\*\*/g, '**$1**');

  // 2. Bracket pairs inside **: **【xxx】** -> 【**xxx**】, etc.
  const bracketPairs: [string, string][] = [
    ['【', '】'],
    ['（', '）'],
    ['(', ')'],
    ['[', ']'],
    ['“', '”'],
    ['「', '」'],
    ['《', '》'],
    ['『', '』'],
  ];
  for (const [open, close] of bracketPairs) {
    const escOpen = open.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const escClose = close.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`\\*\\*${escOpen}([^\\*\\n]+?)${escClose}\\*\\*`, 'g');
    protectedContent = protectedContent.replace(re, `${open}**$1**${close}`);
  }

  // 3. Trailing punctuation inside ** followed immediately by non-space/non-punctuation (CommonMark 6.2 right-flanking issue)
  // e.g. **注意：**不要关闭 -> **注意**：不要关闭
  protectedContent = protectedContent.replace(
    /\*\*([^\*\n]+?)([：:，,。\.！!？\?；;、~～]+)\*\*([^\s：:，,。\.！!？\?；;、\*\n])/g,
    '**$1**$2$3'
  );

  // Restore protected blocks
  return protectedContent.replace(/__PROTECTED_BLOCK_(\d+)__/g, (_, idx) => tokens[parseInt(idx, 10)]);
}

export const MarkdownRenderer: React.FC<MarkdownRendererProps> = ({ content, className }) => {
  const normalizedContent = useMemo(() => preprocessMarkdownBold(content), [content]);

  return (
    <div className={`markdown-body ${className || 'text-[#e0e1e4] leading-relaxed'}`}>
      <ReactMarkdown
        remarkPlugins={[remarkMath, remarkGfm]}
        rehypePlugins={[[rehypeKatex, { throwOnError: false, strict: false }]]}
        components={{
          // Assistant answers routinely contain links. Without target="_blank" the
          // WebView would navigate away from the app UI (and there is no back
          // button) — external links are routed to the macOS default browser by
          // the native WKUIDelegate (see MainWindowController).
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
          code({ className, children, ...props }) {
            const match = /language-(\w+)/.exec(className || '');
            const language = match ? match[1] : '';
            const codeString = String(children).replace(/\n$/, '');

            // Multiline block code with header and copy button
            if (match || codeString.includes('\n')) {
              return <CodeBlock language={language} code={codeString} />;
            }

            // Inline code
            return (
              <code className={className} {...props}>
                {children}
              </code>
            );
          },
        }}
      >
        {normalizedContent}
      </ReactMarkdown>
    </div>
  );
};

interface CodeBlockProps {
  language: string;
  code: string;
}

const CodeBlock: React.FC<CodeBlockProps> = ({ language, code }) => {
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
      <div className="p-3.5 overflow-x-auto text-[13px] font-mono leading-relaxed text-[#f0f3f6]">
        <code>{code}</code>
      </div>
    </div>
  );
};
