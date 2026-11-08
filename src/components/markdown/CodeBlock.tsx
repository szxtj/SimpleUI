import React, { useEffect, useState } from 'react';
import {
  Check,
  ChevronDown,
  ChevronUp,
  Code2,
  Copy,
  CornerDownRight,
  Download,
  ExternalLink,
  Eye,
  Loader2,
  Play,
  Terminal,
  X,
} from 'lucide-react';
import { useI18n } from '../../i18n';
import { pythonRunner, type PythonExecutionResult } from '../../services/pythonRunner';
import {
  BlockHeader,
  BlockShell,
  BLOCK_CODE_CLASS,
  BLOCK_CONTENT_MAX_HEIGHT,
  SegmentedToggle,
  ToolButton,
  cx,
  useCopyFeedback,
} from './BlockChrome';

/**
 * 围栏代码块（以及无语言围栏的兜底）。
 *
 * 三种形态共用这一个组件，只有「右侧动作」和「主体」不同：
 *   1. 普通代码 —— 复制 / 收起
 *   2. Python    —— 运行（Pyodide）+ 复制 / 收起，另有独立的输出层
 *   3. HTML      —— 预览 | 源码 分段切换 + 在浏览器打开 / 下载 / 复制 / 收起
 *
 * HTML 预览的三条硬约束：
 *   - 预览只读 `code`，不写回任何东西：`data-raw-code`、复制代码、复制整条回答、下载 HTML
 *     全部走原始字符串，预览里发生的一切都不会改变内容；
 *   - iframe 用 `srcDoc` + 严格沙箱（不给 allow-same-origin）：不透明源，示例脚本既摸不到
 *     父页面也摸不到原生桥。代价是 localStorage/cookie 会抛异常，这类示例请用「在浏览器打开」；
 *   - 生成中不挂 iframe：半截 HTML 渲染出来只会闪跳，还会白跑示例里的定时器。
 */

const HTML_LANGUAGES = ['html', 'htm', 'xhtml'];

export const isHtmlLanguage = (language?: string): boolean =>
  HTML_LANGUAGES.includes(String(language || '').toLowerCase().trim());

/** 预览区固定高度与源码区上限取同一个值：切换 预览/源码 时块高不跳 */
const PREVIEW_HEIGHT = BLOCK_CONTENT_MAX_HEIGHT;

/** 从 `<title>` 取下载文件名；取不到就按时间戳命名。只影响落盘名，不改内容。 */
export function htmlFileName(html: string): string {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] || '';
  const cleaned = title
    .replace(/\s+/g, ' ')
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/^[.\s-]+|[.\s-]+$/g, '')
    .slice(0, 60);
  if (cleaned) return `${cleaned}.html`;
  return `page-${Date.now()}.html`;
}

function nativeHandler(name: string): { postMessage: (msg: unknown) => void } | undefined {
  return (window as any).webkit?.messageHandlers?.[name];
}

export interface CodeBlockProps {
  language: string;
  code: string;
  /** 该块围栏尚未闭合（流式输出中）—— 此时锁定源码视图，切换按钮禁用 */
  generating?: boolean;
}

export const CodeBlock: React.FC<CodeBlockProps> = React.memo(({ language, code, generating = false }) => {
  const { t, lang } = useI18n();
  const isEn = lang === 'en';
  const isPython = ['python', 'py', 'python3'].includes((language || '').toLowerCase().trim());
  const isHtml = isHtmlLanguage(language);

  const [codeCollapsed, setCodeCollapsed] = useState(false);
  const [view, setView] = useState<'source' | 'preview'>(
    isHtml && !generating ? 'preview' : 'source'
  );
  const { copied, flash: flashCopied } = useCopyFeedback();

  // 该块输出结束 → 自动切预览（用户之后手动点回源码不会被再次拉走：effect 只依赖 generating）
  useEffect(() => {
    if (isHtml && !generating) setView('preview');
  }, [isHtml, generating]);

  const [outputCollapsed, setOutputCollapsed] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [runStatus, setRunStatus] = useState('');
  const [executionResult, setExecutionResult] = useState<PythonExecutionResult | null>(null);
  const [streamingStdout, setStreamingStdout] = useState('');

  // 生成中一律源码视图（此时不该有 iframe）
  const effectiveView: 'source' | 'preview' = isHtml && !generating ? view : 'source';

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      flashCopied();
    } catch (e) {
      console.error('Failed to copy code:', e);
    }
  };

  const handleOpenInBrowser = () => {
    const filename = htmlFileName(code);
    const bridge = nativeHandler('openHtmlInBrowser');
    if (bridge) {
      bridge.postMessage({ html: code, filename });
      return;
    }
    // 浏览器里调试时的兜底（真实 App 一定走上面那条）
    const url = URL.createObjectURL(new Blob([code], { type: 'text/html' }));
    window.open(url, '_blank');
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };

  const handleDownload = () => {
    const filename = htmlFileName(code);
    const bridge = nativeHandler('saveHtmlFile');
    if (bridge) {
      bridge.postMessage({ html: code, filename });
      return;
    }
    const url = URL.createObjectURL(new Blob([code], { type: 'text/html' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };

  const handleRunPython = async () => {
    if (isRunning) {
      pythonRunner.cancel();
      setIsRunning(false);
      setRunStatus('');
      return;
    }

    // 不自动展开代码块（尊重用户折叠状态），但确保输出层可见
    setOutputCollapsed(false);

    setIsRunning(true);
    setStreamingStdout('');
    setExecutionResult(null);
    setRunStatus(t('runStatusInit'));

    try {
      const res = await pythonRunner.run(code, {
        onStatus: (st) => {
          if (st === 'initializing') setRunStatus(t('runStatusInit'));
          else if (st === 'loading_packages') setRunStatus(t('runStatusLoadingPkgs'));
          else if (st === 'running') setRunStatus(t('runStatusExecuting'));
        },
        onStdout: (chunk) => {
          setStreamingStdout((prev) => prev + chunk + '\n');
        },
      });
      setExecutionResult(res);
    } catch (err: any) {
      setExecutionResult({
        stdout: '',
        stderr: '',
        error: err?.message || String(err),
        durationMs: 0,
      });
    } finally {
      setIsRunning(false);
      setRunStatus('');
    }
  };

  return (
    <div className="my-3 space-y-2">
      <BlockShell data-md-codeblock="true" data-language={language || ''} data-raw-code={code}>
        <BlockHeader
          label={language || 'text'}
          bordered={!codeCollapsed}
          leading={
            isHtml ? (
              <SegmentedToggle
                options={[
                  { value: 'preview', label: t('htmlPreview'), icon: <Eye className="w-3 h-3" /> },
                  { value: 'source', label: t('htmlSource'), icon: <Code2 className="w-3 h-3" /> },
                ]}
                value={effectiveView}
                onChange={(v) => setView(v as 'source' | 'preview')}
                disabled={generating}
                disabledHint={t('htmlPreviewGeneratingHint')}
              />
            ) : undefined
          }
        >
          {isHtml && effectiveView === 'preview' && (
            <>
              <ToolButton
                icon={<ExternalLink className="w-3.5 h-3.5" />}
                label={t('openInBrowser')}
                title={t('openInBrowserTooltip')}
                tone="accent"
                onClick={handleOpenInBrowser}
              />
              <ToolButton
                icon={<Download className="w-3.5 h-3.5" />}
                label={t('downloadHtml')}
                title={t('downloadHtmlTooltip')}
                onClick={handleDownload}
              />
            </>
          )}

          {isPython && (
            <button
              type="button"
              onClick={handleRunPython}
              className={cx(
                'flex items-center gap-1.5 px-2 py-0.5 rounded transition-colors cursor-pointer',
                isRunning
                  ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400 hover:bg-amber-500/20'
                  : 'hover:bg-black/5 dark:hover:bg-[#32363e] text-emerald-600 dark:text-emerald-400'
              )}
              title={isRunning ? t('cancelRun') : t('runCode')}
            >
              {isRunning ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  <span className="text-[11px] font-medium">{runStatus || t('runningCode')}</span>
                </>
              ) : (
                <>
                  <Play className="w-3.5 h-3.5 fill-current" />
                  <span className="text-[11px] font-medium">
                    {executionResult ? t('rerunCode') : t('runCode')}
                  </span>
                </>
              )}
            </button>
          )}

          <ToolButton
            icon={
              copied ? (
                <Check className="w-3.5 h-3.5 text-emerald-500 dark:text-emerald-400" />
              ) : (
                <Copy className="w-3.5 h-3.5" />
              )
            }
            label={copied ? t('copied') : isEn ? 'Copy Code' : '复制代码'}
            tone={copied ? 'success' : 'default'}
            title={t('copyCodeTooltip')}
            onClick={handleCopy}
          />

          <ToolButton
            icon={codeCollapsed ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronUp className="w-3.5 h-3.5" />}
            label={codeCollapsed ? t('expandCode') : t('collapseCode')}
            title={codeCollapsed ? t('expandCodeTooltip') : t('collapseCodeTooltip')}
            onClick={() => setCodeCollapsed(!codeCollapsed)}
          />
        </BlockHeader>

        {!codeCollapsed &&
          (effectiveView === 'preview' ? (
            <iframe
              title={t('htmlPreviewTitle')}
              srcDoc={code}
              sandbox="allow-scripts allow-forms allow-modals"
              className="block w-full border-0 bg-white"
              style={{ height: PREVIEW_HEIGHT }}
            />
          ) : (
            <pre className={BLOCK_CODE_CLASS}>
              <code className="!bg-transparent !p-0 !text-inherit font-mono whitespace-pre">{code}</code>
            </pre>
          ))}
      </BlockShell>

      {/* 独立输出层：与代码块同一套外壳，折叠时头部收成一行 */}
      {(executionResult || (isRunning && streamingStdout)) && (
        <BlockShell data-copy-ignore="true">
          <BlockHeader
            label={t('codeOutput')}
            icon={<Terminal className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />}
            bordered={!outputCollapsed}
            leading={
              executionResult && executionResult.durationMs > 0 ? (
                <span className="px-1.5 rounded-full bg-black/5 dark:bg-white/5 text-[10px] text-zinc-500 dark:text-zinc-400 font-mono">
                  {executionResult.durationMs}ms
                </span>
              ) : undefined
            }
          >
            <ToolButton
              icon={outputCollapsed ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronUp className="w-3.5 h-3.5" />}
              label={outputCollapsed ? t('expandOutput') : t('collapseOutput')}
              title={outputCollapsed ? t('expandOutputTooltip') : t('collapseOutputTooltip')}
              onClick={() => setOutputCollapsed(!outputCollapsed)}
            />
            {!isRunning && (
              <ToolButton
                icon={<X className="w-3.5 h-3.5" />}
                title={t('clearOutput')}
                onClick={() => {
                  setExecutionResult(null);
                  setStreamingStdout('');
                }}
              />
            )}
          </BlockHeader>

          {!outputCollapsed && (
            <div className="p-3 select-text space-y-2">
              {(executionResult?.stdout || streamingStdout) && (
                <pre className="!m-0 !p-0 max-h-[480px] overflow-y-auto font-mono text-[12px] leading-relaxed text-zinc-800 dark:text-zinc-200 whitespace-pre-wrap break-words bg-transparent border-0">
                  {executionResult ? executionResult.stdout : streamingStdout}
                </pre>
              )}

              {executionResult?.result && (
                <div className="pt-1.5 border-t border-black/5 dark:border-white/5 flex items-start gap-1 font-mono text-[12px] text-emerald-700 dark:text-emerald-300 font-medium whitespace-pre-wrap break-words">
                  <span className="text-[11px] opacity-60 mr-1 select-none flex items-center gap-0.5 text-zinc-500 dark:text-zinc-400">
                    <CornerDownRight className="w-3 h-3 text-emerald-500" />
                    Out:
                  </span>
                  <span>{executionResult.result}</span>
                </div>
              )}

              {executionResult?.error && (
                <pre className="!m-0 !p-2 max-h-[320px] overflow-y-auto rounded bg-rose-50 dark:bg-rose-950/30 border border-rose-200 dark:border-rose-900/50 font-mono text-[11.5px] leading-relaxed text-rose-700 dark:text-rose-300 whitespace-pre-wrap break-words">
                  {executionResult.error}
                </pre>
              )}

              {executionResult && !executionResult.stdout && !executionResult.result && !executionResult.error && (
                <div className="text-[11px] text-zinc-400 italic">{t('noOutput')}</div>
              )}
            </div>
          )}
        </BlockShell>
      )}
    </div>
  );
});

CodeBlock.displayName = 'CodeBlock';
