import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Languages, Volume2, Square } from 'lucide-react';
import { useI18n } from '../i18n';
import { primeSystemVoices, speakSystemTts, stopSystemTts } from '../utils/systemTts';

/**
 * 划选浮标：选区旁提供「翻译」与「朗读」两个按钮。
 *   - 翻译：走 WebKit 桥把纯文本交给原生快捷翻译窗口（自动翻译）
 *   - 朗读：走 Web Speech API（macOS 系统语音），朗读所选原文
 *
 * 注意：Qwen TTS 朗读入口只保留在回答底部的 SpeakButton（以及服务管理面板），
 * 划选浮标不再提供 Qwen 朗读，避免同一能力存在两个入口。
 */
const MIN_CHARS = 2;
const MAX_CHARS = 4000;
const TOOLBAR_WIDTH_ZH = 132;
const TOOLBAR_WIDTH_EN = 158;
const TOOLBAR_WIDTH_READONLY = 82;
const TOOLBAR_HEIGHT = 32;

/** 翻译桥只在原生 WKWebView 里存在；纯浏览器调试时隐藏「翻译」按钮 */
type TranslateBridge = { postMessage: (message: unknown) => void };

function getTranslateBridge(): TranslateBridge | null {
  const w = window as unknown as {
    webkit?: { messageHandlers?: { translateSelection?: TranslateBridge } };
  };
  return w.webkit?.messageHandlers?.translateSelection ?? null;
}

const BLOCK_TAGS = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DD', 'DIV', 'DL', 'DT', 'FIELDSET',
  'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'HEADER', 'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION', 'TABLE',
  'TBODY', 'TD', 'TFOOT', 'TH', 'THEAD', 'TR', 'UL',
]);

/**
 * 从选区内提取适合翻译的纯文本：
 * 不保留 Markdown 标记，但保留段落 / 列表 / 换行结构；
 * 跳过工具栏、KaTeX 视觉层与思考区光标标记，避免把界面文字带进翻译窗口。
 */
function extractPlainText(range: Range): string {
  const parts: string[] = [];

  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      parts.push(node.textContent || '');
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;

    const el = node as HTMLElement;
    if (el.getAttribute('data-copy-ignore') === 'true') return;
    if (el.tagName === 'SCRIPT' || el.tagName === 'STYLE') return;
    if (el.classList.contains('katex-html')) return;

    if (el.tagName === 'BR') {
      parts.push('\n');
      return;
    }

    if (
      el.classList.contains('katex') ||
      el.classList.contains('katex-display') ||
      el.tagName === 'MATH'
    ) {
      const annotation = el.querySelector('annotation[encoding="application/x-tex"]');
      if (annotation?.textContent) {
        parts.push(annotation.textContent.trim());
        return;
      }
    }

    const isBlock = BLOCK_TAGS.has(el.tagName);
    if (isBlock) parts.push('\n');
    el.childNodes.forEach(walk);
    if (isBlock) parts.push('\n');
  };

  range.cloneContents().childNodes.forEach(walk);

  return parts
    .join('')
    .replace(/▏/g, '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function isEditable(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'TEXTAREA' || tag === 'INPUT' || (el as HTMLElement).isContentEditable;
}

function inReadableArea(node: Node | null): boolean {
  let el: Element | null = node instanceof Element ? node : node?.parentElement ?? null;
  while (el) {
    if (el.matches('.markdown-body, [data-readable]')) return true;
    el = el.parentElement;
  }
  return false;
}

export function SelectionSpeak() {
  const { t, lang } = useI18n();
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [systemOn, setSystemOn] = useState(false);
  const [canTranslate] = useState(() => getTranslateBridge() !== null);
  const textRef = useRef('');
  const translateTextRef = useRef('');
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    primeSystemVoices();
  }, []);

  const stopSystem = useCallback(() => {
    stopSystemTts();
    setSystemOn(false);
  }, []);

  const evaluateSelection = useCallback(() => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
      setPos(null);
      return;
    }
    if (isEditable(document.activeElement)) {
      setPos(null);
      return;
    }
    const range = sel.getRangeAt(0);
    if (!inReadableArea(range.commonAncestorContainer)) {
      setPos(null);
      return;
    }
    const raw = sel.toString().replace(/\s+/g, ' ').trim();
    if (raw.length < MIN_CHARS || raw.length > MAX_CHARS) {
      setPos(null);
      return;
    }
    let rect = range.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0 && range.getClientRects().length) {
      rect = range.getClientRects()[range.getClientRects().length - 1];
    }
    const width = canTranslate
      ? lang === 'zh'
        ? TOOLBAR_WIDTH_ZH
        : TOOLBAR_WIDTH_EN
      : TOOLBAR_WIDTH_READONLY;
    const height = TOOLBAR_HEIGHT;
    const x = Math.min(Math.max(8, rect.right - width), window.innerWidth - width - 8);
    const above = rect.top - height - 6;
    const y = above > 8 ? above : Math.min(rect.bottom + 6, window.innerHeight - height - 8);
    textRef.current = raw;
    translateTextRef.current = extractPlainText(range);
    setPos({ x, y });
  }, [lang, canTranslate]);

  useEffect(() => {
    const onSelectionChange = () => {
      if (timerRef.current) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(evaluateSelection, 140);
    };
    const hide = () => {
      if (!systemOn) setPos(null);
    };
    document.addEventListener('selectionchange', onSelectionChange);
    window.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
    return () => {
      document.removeEventListener('selectionchange', onSelectionChange);
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('resize', hide);
      if (timerRef.current) window.clearTimeout(timerRef.current);
    };
  }, [evaluateSelection, systemOn]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        stopSystem();
        setPos(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [stopSystem]);

  useEffect(
    () => () => {
      // 组件卸载时停止朗读，避免离开后还在后台出声
      stopSystemTts();
    },
    []
  );

  const speak = useCallback(() => {
    const raw = textRef.current;
    if (!raw) return;
    if (systemOn) {
      stopSystem();
      return;
    }

    setSystemOn(true);
    speakSystemTts(raw, {
      onStart: () => setSystemOn(true),
      onEnd: () => setSystemOn(false),
      onError: () => setSystemOn(false),
    });
  }, [systemOn, stopSystem]);

  const translate = useCallback(() => {
    const raw = translateTextRef.current;
    const bridge = getTranslateBridge();
    if (!raw || !bridge) return;

    // 避免朗读与翻译同时进行
    stopSystem();
    bridge.postMessage({ text: raw });
    setPos(null);
  }, [stopSystem]);

  if (!pos) return null;

  return createPortal(
    <div
      data-tts-toolbar="true"
      onMouseDown={(e) => e.preventDefault()}
      style={{ left: pos.x, top: pos.y }}
      className="fixed z-[9999] flex items-center gap-1 p-1 rounded-xl bg-white/95 dark:bg-[#1e2025]/95 border border-black/10 dark:border-[#3a3d45] shadow-lg backdrop-blur-sm select-none"
    >
      {canTranslate && (
        <button
          type="button"
          onClick={translate}
          className="flex items-center gap-1 px-2 h-6 rounded-lg text-[11px] font-medium transition-colors cursor-pointer text-zinc-600 dark:text-zinc-300 hover:bg-black/5 dark:hover:bg-white/10"
          title={t('selectionTranslate')}
        >
          <Languages className="w-3.5 h-3.5" />
          <span>{t('selectionTranslateShort')}</span>
        </button>
      )}
      <button
        type="button"
        onClick={speak}
        className={`flex items-center gap-1 px-2 h-6 rounded-lg text-[11px] font-medium transition-colors cursor-pointer ${
          systemOn
            ? 'bg-zinc-700 text-white dark:bg-zinc-200 dark:text-zinc-900'
            : 'text-zinc-600 dark:text-zinc-300 hover:bg-black/5 dark:hover:bg-white/10'
        }`}
        title={systemOn ? t('selectionSpeakStop') : t('selectionSpeak')}
      >
        {systemOn ? <Square className="w-3 h-3" fill="currentColor" /> : <Volume2 className="w-3.5 h-3.5" />}
        <span>{t('selectionSpeakShort')}</span>
      </button>
      {systemOn && <span className="sr-only">playing</span>}
    </div>,
    document.body
  );
}
