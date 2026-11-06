import React, {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Columns2,
  Eye,
  FileText,
  FolderOpen,
  Pencil,
  Save,
  SaveAll,
  Sparkles,
} from 'lucide-react';
import { useI18n } from '../../i18n';
import { MarkdownRenderer } from '../MarkdownRenderer';
import { SelectionSpeak } from '../SelectionSpeak';
import { useChatFontSize } from '../../hooks/useChatFontSize';
import { mdFileBridge, type MdFilePayload } from '../../services/mdFileBridge';

/**
 * Markdown 编辑器独立窗口（原生 MarkdownEditorPanelController 承载，hash 路由 #/markdown）。
 *
 * 三态布局：编辑 / 分栏 / 浏览。预览侧**直接复用** <MarkdownRenderer>，
 * 与对话区共享同一套 remark/rehype 插件、KaTeX、Mermaid、代码块与表格工具条，
 * 因此「渲染能力完全照搬」不靠复制代码，靠共用组件。
 *
 * 文件读写一律走原生桥（NSOpenPanel / NSSavePanel），没有桥时回退到浏览器方案
 * （file input 打开、Blob 下载保存），保证无头验证也能跑通。
 */

type EditorMode = 'edit' | 'split' | 'preview';

const MODES: { id: EditorMode; labelKey: 'mdModeEdit' | 'mdModeSplit' | 'mdModePreview'; Icon: typeof Pencil }[] = [
  { id: 'edit', labelKey: 'mdModeEdit', Icon: Pencil },
  { id: 'split', labelKey: 'mdModeSplit', Icon: Columns2 },
  { id: 'preview', labelKey: 'mdModePreview', Icon: Eye },
];

const SAMPLE_DOC = [
  '# Markdown 编辑器',
  '',
  '这份窗口的渲染能力与对话区**完全一致**，下面逐项验证。',
  '',
  '## 文本与列表',
  '',
  '- **加粗**、*斜体*、~~删除线~~、`行内代码`',
  '- 中文标点可以直接被强调包住：**「引号里的加粗」**',
  '- 嵌套列表：',
  '  1. 第一层',
  '  2. 第二层',
  '',
  '> 引用块里的公式同样成立：',
  '> $$E = mc^2$$',
  '',
  '## 表格',
  '',
  '| 能力 | 状态 |',
  '| --- | --- |',
  '| 公式 | ✅ |',
  '| 表格工具条 | ✅ |',
  '| Mermaid | ✅ |',
  '',
  '## 数学公式',
  '',
  '行内 $a^2 + b^2 = c^2$，块级：',
  '',
  '$$',
  '\\int_{-\\infty}^{\\infty} e^{-x^2}\\,dx = \\sqrt{\\pi}',
  '$$',
  '',
  '## 代码块',
  '',
  '```python',
  'print("Python 代码块可以直接运行")',
  '```',
  '',
  '## Mermaid',
  '',
  '```mermaid',
  'graph LR',
  '  A[编辑] --> B[预览]',
  '  B --> C[保存]',
  '```',
].join('\n');

const UNTITLED_ZH = '未命名.md';
const UNTITLED_EN = 'Untitled.md';

export const MarkdownEditorWindow: React.FC = () => {
  const { t, lang } = useI18n();
  const { fontSize: chatFontSize } = useChatFontSize({
    storageKey: 'simpleui_md_editor_font_size',
    defaultSize: 15,
    minSize: 12,
    maxSize: 24,
  });

  const [mode, setMode] = useState<EditorMode>('split');
  const [text, setText] = useState('');
  const [savedText, setSavedText] = useState('');
  const [filePath, setFilePath] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  /**
   * 顶部 52px 是原生拖拽带（`MarkdownTitleBarDragView` 会把整条带的鼠标事件吃掉）。
   * 浮层（划选浮标、公式工具条）据此避让，规则与主窗口共用 `utils/floatingPanel`：
   * 主窗口不设这个变量 → inset 为 0，行为与改前一致。
   */
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty('--window-top-inset', '52px');
    return () => {
      root.style.removeProperty('--window-top-inset');
    };
  }, []);

  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const previewRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const textRef = useRef(text);
  textRef.current = text;
  const pathRef = useRef<string | null>(null);
  const pendingSaveTextRef = useRef<string | null>(null);
  const closeAfterSaveRef = useRef(false);
  const syncingScrollRef = useRef(false);

  const isDirty = text !== savedText;
  const untitled = lang === 'en' ? UNTITLED_EN : UNTITLED_ZH;
  const displayName = fileName || untitled;

  /** 预览用延迟值：长文档连续输入时，编辑区不被整篇重新渲染拖住（与聊天流式同一策略） */
  const deferredText = useDeferredValue(text);

  // ---------------------------------------------------------------- 文件读写

  const suggestedName = useCallback(() => {
    if (fileName) return fileName;
    const firstLine = textRef.current.split('\n').find((line) => line.trim());
    const heading = firstLine?.replace(/^#+\s*/, '').trim();
    if (heading) {
      const safe = heading.replace(/[\\/:*?"<>|]/g, ' ').slice(0, 40).trim();
      if (safe) return `${safe}.md`;
    }
    return untitled;
  }, [fileName, untitled]);

  const handleSave = useCallback(
    (saveAs = false) => {
      const content = textRef.current;
      if (!mdFileBridge.available()) {
        // 浏览器回退：直接下载当前内容
        const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName || untitled;
        a.click();
        URL.revokeObjectURL(url);
        setSavedText(content);
        return;
      }

      pendingSaveTextRef.current = content;
      if (!saveAs && pathRef.current) {
        mdFileBridge.save(pathRef.current, content);
      } else {
        mdFileBridge.saveAs(content, suggestedName());
      }
    },
    [fileName, suggestedName, untitled]
  );

  const handleOpen = useCallback(async () => {
    if (isDirty) {
      const ok = await mdFileBridge.confirmDiscard();
      if (!ok) return;
    }
    if (mdFileBridge.available()) {
      mdFileBridge.open();
    } else {
      fileInputRef.current?.click();
    }
  }, [isDirty]);

  const applyLoadedFile = useCallback((name: string, content: string, path: string | null) => {
    setText(content);
    setSavedText(content);
    setFilePath(path);
    pathRef.current = path;
    setFileName(name);
    // 打开新文件后回到编辑态，光标落到开头
    requestAnimationFrame(() => {
      const el = taRef.current;
      if (!el) return;
      el.focus();
      el.selectionStart = el.selectionEnd = 0;
      el.scrollTop = 0;
    });
  }, []);

  useEffect(() => {
    return mdFileBridge.install({
      onOpened: (payload: MdFilePayload) => {
        if (payload.ok) {
          applyLoadedFile(payload.name || untitled, payload.content ?? '', payload.path ?? null);
        } else if (payload.error) {
          setError(payload.error);
        }
      },
      onSaved: (payload: MdFilePayload) => {
        const written = pendingSaveTextRef.current;
        pendingSaveTextRef.current = null;

        if (!payload.ok) {
          if (closeAfterSaveRef.current) {
            closeAfterSaveRef.current = false;
            mdFileBridge.cancelClose();
          }
          if (payload.error) setError(payload.error);
          return;
        }

        // 没有对应写入请求的迟到回包：直接忽略。否则会把「打字但还没保存」的内容标成已保存，
        // 未保存标记消失、关窗也不再提醒 —— 那是真的会丢东西。
        if (written === null) return;

        setSavedText(written);
        if (payload.path) {
          pathRef.current = payload.path;
          setFilePath(payload.path);
        }
        if (payload.name) setFileName(payload.name);
        if (closeAfterSaveRef.current) {
          closeAfterSaveRef.current = false;
          mdFileBridge.closeNow();
        }
      },
      onRequestSaveClose: () => {
        closeAfterSaveRef.current = true;
        handleSave(false);
      },
    });
  }, [applyLoadedFile, handleSave, untitled]);

  /** 把文件名 / 未保存标记 / 代表文件同步给原生（窗口标题、关闭按钮小圆点、关窗提示都靠它） */
  useEffect(() => {
    const push = () =>
      mdFileBridge.syncState({
        name: displayName,
        edited: text !== savedText,
        path: filePath ?? '',
      });
    // 原生重开窗口时会调一次，避免「不保存关闭后重开」时原生与页面状态脱钩
    window.__mdRequestState = push;
    const timer = window.setTimeout(push, 120);
    return () => {
      delete window.__mdRequestState;
      window.clearTimeout(timer);
    };
  }, [displayName, text, savedText, filePath]);

  // ---------------------------------------------------------------- 快捷键

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!e.metaKey && !e.ctrlKey) return;
      const key = e.key.toLowerCase();
      if (key === 's') {
        e.preventDefault();
        handleSave(e.shiftKey);
      } else if (key === 'o') {
        e.preventDefault();
        void handleOpen();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [handleOpen, handleSave]);

  /** 用定界符包住选区（Cmd+B / Cmd+I / Cmd+K） */
  const wrapSelection = useCallback((before: string, after: string, placeholder: string) => {
    const el = taRef.current;
    if (!el) return;
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const selected = text.slice(start, end) || placeholder;
    const next = text.slice(0, start) + before + selected + after + text.slice(end);
    setText(next);
    requestAnimationFrame(() => {
      el.focus();
      el.selectionStart = start + before.length;
      el.selectionEnd = start + before.length + selected.length;
    });
  }, [text]);

  const handleEditorKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const el = e.currentTarget;
      const start = el.selectionStart;
      const end = el.selectionEnd;
      const next = el.value.slice(0, start) + '  ' + el.value.slice(end);
      setText(next);
      requestAnimationFrame(() => {
        el.selectionStart = el.selectionEnd = start + 2;
      });
      return;
    }
    if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
    const key = e.key.toLowerCase();
    if (key === 'b') {
      e.preventDefault();
      wrapSelection('**', '**', t('mdBoldPlaceholder'));
    } else if (key === 'i') {
      e.preventDefault();
      wrapSelection('*', '*', t('mdItalicPlaceholder'));
    } else if (key === 'k') {
      e.preventDefault();
      wrapSelection('[', '](url)', t('mdLinkPlaceholder'));
    }
  };

  /** 分栏时编辑区滚动按比例带动预览（单向，避免两边互相打架） */
  const handleEditorScroll = () => {
    const el = taRef.current;
    const pv = previewRef.current;
    if (!el || !pv || syncingScrollRef.current) return;
    const max = el.scrollHeight - el.clientHeight;
    const ratio = max > 0 ? el.scrollTop / max : 0;
    syncingScrollRef.current = true;
    pv.scrollTop = ratio * (pv.scrollHeight - pv.clientHeight);
    requestAnimationFrame(() => {
      syncingScrollRef.current = false;
    });
  };

  const loadSample = useCallback(() => {
    setText(SAMPLE_DOC);
    setSavedText('');
    setFileName(null);
    setFilePath(null);
    pathRef.current = null;
    setMode('split');
  }, []);

  const lineCount = useMemo(() => text.split('\n').length, [text]);

  const previewFontStyle = useMemo(
    () => ({ '--chat-font-size': `${chatFontSize}px` }) as React.CSSProperties,
    [chatFontSize]
  );

  const previewPane = (
    <div ref={previewRef} className="h-full overflow-y-auto overscroll-y-contain">
      <div className="mx-auto w-full max-w-[820px] px-8 py-6" style={previewFontStyle}>
        {deferredText.trim() ? (
          <MarkdownRenderer content={deferredText} />
        ) : (
          <div className="flex flex-col items-center justify-center gap-3 pt-24 text-center select-none">
            <FileText className="w-8 h-8 text-zinc-300 dark:text-zinc-600" />
            <p className="text-sm text-zinc-500 dark:text-zinc-400">{t('mdEmptyPreview')}</p>
            <button
              type="button"
              data-md-sample="true"
              onClick={loadSample}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border border-black/10 dark:border-white/10 text-zinc-600 dark:text-zinc-300 hover:bg-black/[0.04] dark:hover:bg-white/[0.06] transition-colors"
            >
              <Sparkles className="w-3.5 h-3.5" />
              {t('mdLoadSample')}
            </button>
          </div>
        )}
      </div>
    </div>
  );

  const editorPane = (
    <textarea
      ref={taRef}
      data-md-editor="true"
      value={text}
      onChange={(e) => setText(e.target.value)}
      onKeyDown={handleEditorKeyDown}
      onScroll={handleEditorScroll}
      spellCheck={false}
      autoCorrect="off"
      autoCapitalize="off"
      className="w-full h-full resize-none outline-none bg-transparent px-7 py-6 font-mono text-[13.5px] leading-[1.75] text-[#1f2328] dark:text-[#e6e8ec] placeholder:text-zinc-400 dark:placeholder:text-zinc-600 selection:bg-blue-500/20"
      placeholder={t('mdEditorPlaceholder')}
    />
  );

  return (
    <div className="h-screen w-screen flex flex-col overflow-hidden bg-[#f8f9fb] dark:bg-[#18191c] text-[#1f2328] dark:text-[#e6e8ec]">
      {/* 开放式顶栏：顶部 52px 全留给原生拖拽带（左侧 78px 是红绿灯），这里只放留白 */}
      <div className="h-[52px] flex-shrink-0" aria-hidden="true" />

      {/* 工具条：必须排在 52px 以下，否则按钮会被拖拽层吃掉 */}
      <div className="h-[46px] flex-shrink-0 flex items-center gap-1 px-3 border-b border-black/[0.06] dark:border-white/[0.07] select-none">
        <button
          type="button"
          data-md-action="open"
          onClick={() => void handleOpen()}
          title={t('mdOpenHint')}
          className="flex items-center gap-1.5 h-8 px-2.5 rounded-lg text-xs text-zinc-600 dark:text-zinc-300 hover:bg-black/[0.05] dark:hover:bg-white/[0.07] transition-colors"
        >
          <FolderOpen className="w-3.5 h-3.5" />
          <span>{t('mdOpen')}</span>
        </button>
        <button
          type="button"
          data-md-action="save"
          onClick={() => handleSave(false)}
          title={t('mdSaveHint')}
          className="flex items-center gap-1.5 h-8 px-2.5 rounded-lg text-xs text-zinc-600 dark:text-zinc-300 hover:bg-black/[0.05] dark:hover:bg-white/[0.07] transition-colors"
        >
          <Save className="w-3.5 h-3.5" />
          <span>{t('mdSave')}</span>
        </button>
        <button
          type="button"
          data-md-action="saveAs"
          onClick={() => handleSave(true)}
          title={t('mdSaveAsHint')}
          className="flex items-center gap-1.5 h-8 px-2.5 rounded-lg text-xs text-zinc-600 dark:text-zinc-300 hover:bg-black/[0.05] dark:hover:bg-white/[0.07] transition-colors"
        >
          <SaveAll className="w-3.5 h-3.5" />
          <span>{t('mdSaveAs')}</span>
        </button>

        <div className="w-px h-4 bg-black/10 dark:bg-white/10 mx-1.5" />

        <div className="flex items-center gap-1.5 min-w-0" title={filePath || undefined}>
          <FileText className="w-3.5 h-3.5 flex-shrink-0 text-zinc-400 dark:text-zinc-500" />
          <span className="text-xs font-medium truncate max-w-[280px]">{displayName}</span>
          {isDirty && (
            <span
              className="w-1.5 h-1.5 rounded-full bg-amber-500 flex-shrink-0"
              title={t('mdUnsaved')}
            />
          )}
        </div>

        <div className="flex-1" />

        <div className="flex items-center gap-0.5 p-0.5 rounded-lg bg-black/[0.04] dark:bg-white/[0.06]">
          {MODES.map(({ id, labelKey, Icon }) => {
            const active = mode === id;
            return (
              <button
                key={id}
                type="button"
                onClick={() => setMode(id)}
                data-md-mode={id}
                title={t(labelKey)}
                className={`flex items-center gap-1.5 h-7 px-2.5 rounded-md text-[11.5px] font-medium transition-colors ${
                  active
                    ? 'bg-white dark:bg-[#2b2d33] text-zinc-900 dark:text-white shadow-sm'
                    : 'text-zinc-500 dark:text-zinc-400 hover:text-zinc-800 dark:hover:text-zinc-200'
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                <span>{t(labelKey)}</span>
              </button>
            );
          })}
        </div>
      </div>

      {error && (
        <div className="flex-shrink-0 flex items-center justify-between gap-3 px-4 py-1.5 text-[11.5px] text-rose-600 dark:text-rose-300 bg-rose-50 dark:bg-rose-950/40 border-b border-rose-200/70 dark:border-rose-900/50">
          <span className="truncate">{error}</span>
          <button
            type="button"
            onClick={() => setError(null)}
            className="flex-shrink-0 hover:underline"
          >
            {t('mdDismiss')}
          </button>
        </div>
      )}

      <div className="flex-1 min-h-0 flex">
        {mode !== 'preview' && (
          <div
            className={`min-w-0 h-full ${
              mode === 'split' ? 'w-1/2 border-r border-black/[0.06] dark:border-white/[0.07]' : 'w-full'
            }`}
          >
            {editorPane}
          </div>
        )}
        {mode !== 'edit' && <div className="min-w-0 h-full flex-1">{previewPane}</div>}
      </div>

      <div className="h-[26px] flex-shrink-0 flex items-center justify-between gap-4 px-4 border-t border-black/[0.06] dark:border-white/[0.07] text-[11px] text-zinc-500 dark:text-zinc-500 select-none">
        <span>
          {t('mdStats')
            .replace('{chars}', String(text.length))
            .replace('{lines}', String(lineCount))}
        </span>
        <span className="truncate max-w-[60%] text-right opacity-70">
          {isDirty ? t('mdUnsaved') : filePath || t('mdNotSavedYet')}
        </span>
      </div>

      {/* 划选浮标：与主窗口 / 浮窗同一个组件（翻译 / 朗读 / 复制），
          没有它预览区划选就只剩系统原生菜单 */}
      <SelectionSpeak />

      {/* 浏览器回退：没有原生桥时用 file input 打开 .md */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".md,.markdown,.txt,text/markdown,text/plain"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (!file) return;
          const reader = new FileReader();
          reader.onload = () => applyLoadedFile(file.name, String(reader.result ?? ''), null);
          reader.readAsText(file);
        }}
      />
    </div>
  );
};

export default MarkdownEditorWindow;
