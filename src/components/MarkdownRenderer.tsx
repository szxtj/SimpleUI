import React, { useState, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import remarkGfm from 'remark-gfm';
import remarkCjkFriendly from 'remark-cjk-friendly';
import { Check, Copy } from 'lucide-react';
import { useI18n } from '../i18n';

interface MarkdownRendererProps {
  content: string;
  className?: string;
}

/**
 * 唯一保留的一处预处理：**定界符内侧带空格**的写法（`** 加粗 **`）。
 * CommonMark 规定定界符串不能以空白开头或结尾，所以这种写法在解析层**根本不成强调**，
 * 插件也无从修复 —— 只能先把这两侧空白摘掉再交给解析器。
 *
 * 代码块 / 行内代码 / LaTeX 里的 `** x **` 是**内容**，先摘出来占位、事后原样放回。
 *
 * 其余中文标点的加粗问题（`**自动语音识别（ASR）**模型`、`**【中文】**`、`**注意：**不要`……）
 * 已改为由 `remark-cjk-friendly` 在**解析层**按 CJK 友好规范处理：定界符的 flanking 规则
 * 按中文语境放宽，括号/引号**连同文字一起**加粗，与模型本意一致。
 * （旧实现用正则把括号、标点挪到加粗范围之外，等于改写语义；且跨行加粗一律失效，已删。）
 */
function trimInnerSpacesInBold(content: string): string {
  if (!content) return '';

  const tokens: string[] = [];
  const placeholder = (idx: number) => `__PROTECTED_BLOCK_${idx}__`;

  // Protect code blocks, inline code, and LaTeX math ($$ and $)
  const protectedContent = content.replace(
    /(```[\s\S]*?```|`[^`\n]+`|\$\$[\s\S]*?\$\$|\$[^\$\n]+\$)/g,
    (match) => {
      tokens.push(match);
      return placeholder(tokens.length - 1);
    }
  );

  /*
   * 一次匹配一对定界符，同时吃掉两侧空白：`**$2**`。
   * 正文（$2）不允许包含 `*` 或换行 —— 这样绝不会跨过一对正常的 `**…**`
   * 去跟后面那对配对（旧实现的两个独立替换就会：`**a** 文本 **b**` 里的空格被吃掉）。
   * 正文全为空白（`** **`）时原样返回，不制造一个空强调。
   */
  const trimmed = protectedContent.replace(
    /\*\*([ \t]*)([^\*\n]*?)([ \t]*)\*\*/g,
    (match, _lead: string, body: string) => (body.trim() ? `**${body}**` : match)
  );

  // Restore protected blocks
  return trimmed.replace(/__PROTECTED_BLOCK_(\d+)__/g, (_, idx) => tokens[parseInt(idx, 10)]);
}

export const MarkdownRenderer: React.FC<MarkdownRendererProps> = ({ content, className }) => {
  const normalizedContent = useMemo(() => trimInnerSpacesInBold(content), [content]);

  return (
    <div className={`markdown-body ${className || 'text-[#e0e1e4] leading-relaxed'}`}>
      <ReactMarkdown
        remarkPlugins={[remarkMath, remarkGfm, remarkCjkFriendly]}
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
