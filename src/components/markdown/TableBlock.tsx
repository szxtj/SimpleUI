import React, { useRef } from 'react';
import { Check, FileText, Table as TableIcon } from 'lucide-react';
import { useI18n } from '../../i18n';
import {
  serializeTableElementToDocxXml,
  serializeTableElementToMarkdown,
  serializeTableElementToRichData,
} from '../../utils/selectionToMarkdown';
import { BlockHeader, BlockShell, ToolButton, useCopyFeedback } from './BlockChrome';

/**
 * GFM 表格块：头部三个动作（在 Word 打开 / 复制表格 / 复制 Markdown 原文）。
 * 外壳与按钮全部来自 BlockChrome —— 与代码块、Mermaid 保持同一套描边、底色、按钮尺寸。
 */
interface TableBlockProps {
  children?: React.ReactNode;
}

export const TableBlock: React.FC<TableBlockProps> = React.memo(({ children }) => {
  const { lang } = useI18n();
  const tableRef = useRef<HTMLTableElement | null>(null);
  const { copied: copiedMd, flash: flashMd } = useCopyFeedback();
  const { copied: copiedRich, flash: flashRich } = useCopyFeedback();
  const { copied: openedWord, flash: flashWord } = useCopyFeedback();

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
        flashWord();
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
        flashMd();
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
      flashRich();
    } catch (e) {
      console.error('Failed to copy rendered table:', e);
    }
  };

  return (
    <BlockShell className="my-3">
      <BlockHeader label={isEn ? 'TABLE' : '表格'} icon={<TableIcon className="w-3.5 h-3.5 opacity-80" />}>
        <ToolButton
          icon={
            openedWord ? (
              <Check className="w-3.5 h-3.5 text-emerald-500 dark:text-emerald-400" />
            ) : (
              <FileText className="w-3.5 h-3.5" />
            )
          }
          label={openedWord ? (isEn ? 'Opened' : '已在 Word 打开') : isEn ? 'Open in Word' : '在 Word 中打开'}
          tone={openedWord ? 'success' : 'accent'}
          title={
            isEn
              ? 'Open native table with editable equations directly in Microsoft Word'
              : '在 Microsoft Word 中直接打开原生表格与公式'
          }
          onClick={handleOpenInWord}
        />

        <ToolButton
          icon={
            copiedRich ? (
              <Check className="w-3.5 h-3.5 text-emerald-500 dark:text-emerald-400" />
            ) : (
              <TableIcon className="w-3.5 h-3.5" />
            )
          }
          label={copiedRich ? (isEn ? 'Table Copied' : '已复制表格') : isEn ? 'Copy Table' : '复制表格'}
          tone={copiedRich ? 'success' : 'default'}
          title={
            isEn
              ? 'Copy table (formulas kept as LaTeX, for Excel / Notion / Sheets)'
              : '复制表格（公式保留为 LaTeX，支持粘贴至 Excel / Notion / 飞书）'
          }
          onClick={handleCopyRichTable}
        />

        <ToolButton
          icon={
            copiedMd ? (
              <Check className="w-3.5 h-3.5 text-emerald-500 dark:text-emerald-400" />
            ) : (
              <FileText className="w-3.5 h-3.5" />
            )
          }
          label={copiedMd ? (isEn ? 'MD Copied' : '已复制 MD') : isEn ? 'Copy Markdown' : '复制 Markdown'}
          tone={copiedMd ? 'success' : 'default'}
          title={isEn ? 'Copy raw Markdown table' : '复制 Markdown 表格原文'}
          onClick={handleCopyMarkdown}
        />
      </BlockHeader>

      <div className="overflow-x-auto overflow-y-hidden">
        <table ref={tableRef} className="!my-0 !border-0 w-full">
          {children}
        </table>
      </div>
    </BlockShell>
  );
});

TableBlock.displayName = 'TableBlock';
