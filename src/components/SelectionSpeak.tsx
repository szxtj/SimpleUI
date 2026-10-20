import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Volume2, Speaker, Square, Loader2 } from 'lucide-react';
import { useI18n } from '../i18n';
import { useTtsEnabled } from '../hooks/useTtsEnabled';

/**
 * 划选朗读浮标：两个圆角矩形按钮。
 *   - Qwen：走本地 Qwen3-TTS（短选区会扩到整句，避免模型拖长音）
 *   - 系统：走 Web Speech API（macOS 系统语音），读所选原文
 */
type Phase = 'idle' | 'loading' | 'playing';

const MIN_CHARS = 2;
const MAX_CHARS = 4000;
const EXPAND_BELOW = 12;
const BLOCK_SELECTOR = 'p, li, td, th, h1, h2, h3, h4, h5, blockquote, pre';

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

function expandToSentence(selection: Selection, raw: string): string {
  if (raw.length >= EXPAND_BELOW) return raw;
  let el: Element | null =
    selection.anchorNode instanceof Element
      ? selection.anchorNode
      : selection.anchorNode?.parentElement ?? null;
  let block: Element | null = null;
  while (el) {
    if (el.matches(BLOCK_SELECTOR)) {
      block = el;
      break;
    }
    el = el.parentElement;
  }
  const blockText = (block?.textContent || '').replace(/\s+/g, ' ').trim();
  if (!blockText) return raw;
  const sentences =
    blockText.match(/[^。！？!?；;]+[。！？!?；;]?/g)?.map((s) => s.trim()).filter(Boolean) ?? [];
  const hit = sentences.find((s) => s.includes(raw));
  if (hit && hit.length <= 300) return hit;
  return blockText.slice(0, 200);
}

function speakWithSystem(text: string) {
  const synth = window.speechSynthesis;
  if (!synth) return () => {};
  synth.cancel();
  const utter = new SpeechSynthesisUtterance(text);
  const voices = synth.getVoices();
  const zh = voices.find((v) => /^zh/i.test(v.lang));
  const en = voices.find((v) => /^en/i.test(v.lang));
  const target = /[\u4e00-\u9fff]/.test(text) ? zh || en : en || zh;
  if (target) utter.voice = target;
  utter.rate = 1.0;
  synth.speak(utter);
  return () => synth.cancel();
}

export function SelectionSpeak() {
  const { t } = useI18n();
  const enabled = useTtsEnabled();
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [systemOn, setSystemOn] = useState(false);
  const textRef = useRef('');
  const qwenTextRef = useRef('');
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const urlRef = useRef<string | null>(null);
  const timerRef = useRef<number | null>(null);
  const systemStopRef = useRef<(() => void) | null>(null);

  const stopAll = useCallback(() => {
    audioRef.current?.pause();
    audioRef.current = null;
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    }
    systemStopRef.current?.();
    systemStopRef.current = null;
    window.speechSynthesis?.cancel();
    setSystemOn(false);
    setPhase('idle');
  }, []);

  const evaluateSelection = useCallback(() => {
    if (phase !== 'idle') return;
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
    const width = 148;
    const height = 32;
    const x = Math.min(Math.max(8, rect.right - width), window.innerWidth - width - 8);
    const above = rect.top - height - 6;
    const y = above > 8 ? above : Math.min(rect.bottom + 6, window.innerHeight - height - 8);
    textRef.current = raw;
    qwenTextRef.current = expandToSentence(sel, raw);
    setPos({ x, y });
  }, [phase]);

  useEffect(() => {
    const onSelectionChange = () => {
      if (timerRef.current) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(evaluateSelection, 140);
    };
    const hide = () => {
      if (phase === 'idle' && !systemOn) setPos(null);
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
  }, [evaluateSelection, phase, systemOn]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        stopAll();
        setPos(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [stopAll]);

  useEffect(() => () => stopAll(), [stopAll]);

  // 服务被关掉时立即收起浮标
  useEffect(() => {
    if (!enabled) {
      stopAll();
      setPos(null);
    }
  }, [enabled, stopAll]);

  const speakQwen = useCallback(async () => {
    const text = qwenTextRef.current;
    if (!text) return;
    if (phase !== 'idle') {
      stopAll();
      return;
    }
    setPhase('loading');
    try {
      const res = await fetch('/api/tts/speak', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      urlRef.current = url;
      const audio = new Audio(url);
      audioRef.current = audio;
      audio.onended = stopAll;
      audio.onerror = stopAll;
      await audio.play();
      setPhase('playing');
    } catch {
      stopAll();
    }
  }, [phase, stopAll]);

  const speakSystem = useCallback(() => {
    const raw = textRef.current;
    if (!raw) return;
    if (systemOn) {
      stopAll();
      return;
    }
    audioRef.current?.pause();
    audioRef.current = null;
    const stop = speakWithSystem(raw);
    systemStopRef.current = stop;
    setSystemOn(true);
  }, [systemOn, stopAll]);

  if (!enabled || !pos) return null;

  const busy = phase !== 'idle' || systemOn;
  return createPortal(
    <div
      data-tts-toolbar="true"
      onMouseDown={(e) => e.preventDefault()}
      style={{ left: pos.x, top: pos.y }}
      className="fixed z-[9999] flex items-center gap-1 p-1 rounded-xl bg-white/95 dark:bg-[#1e2025]/95 border border-black/10 dark:border-[#3a3d45] shadow-lg backdrop-blur-sm select-none"
    >
      <button
        type="button"
        onClick={speakQwen}
        className={`flex items-center gap-1 px-2 h-6 rounded-lg text-[11px] font-medium transition-colors cursor-pointer ${
          phase !== 'idle'
            ? 'bg-indigo-500 text-white'
            : 'text-zinc-600 dark:text-zinc-300 hover:bg-black/5 dark:hover:bg-white/10'
        }`}
        title={t('selectionSpeakQwen')}
      >
        {phase === 'loading' ? (
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
        ) : phase === 'playing' ? (
          <Square className="w-3 h-3" fill="currentColor" />
        ) : (
          <Volume2 className="w-3.5 h-3.5" />
        )}
        <span>Qwen</span>
      </button>
      <button
        type="button"
        onClick={speakSystem}
        className={`flex items-center gap-1 px-2 h-6 rounded-lg text-[11px] font-medium transition-colors cursor-pointer ${
          systemOn
            ? 'bg-zinc-700 text-white dark:bg-zinc-200 dark:text-zinc-900'
            : 'text-zinc-600 dark:text-zinc-300 hover:bg-black/5 dark:hover:bg-white/10'
        }`}
        title={t('selectionSpeakSystem')}
      >
        {systemOn ? <Square className="w-3 h-3" fill="currentColor" /> : <Speaker className="w-3.5 h-3.5" />}
        <span>{t('selectionSpeakSystemShort')}</span>
      </button>
      {busy && <span className="sr-only">playing</span>}
    </div>,
    document.body
  );
}
