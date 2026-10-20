import { useCallback, useEffect, useRef, useState } from 'react';
import { Volume2, Square, Loader2 } from 'lucide-react';
import { useI18n } from '../i18n';
import { useTtsEnabled } from '../hooks/useTtsEnabled';

type Phase = 'idle' | 'loading' | 'playing';

// 全局只允许一段朗读在播：新开一段前先停掉上一段。
let currentStop: (() => void) | null = null;

interface SpeakButtonProps {
  text: string;
  title?: string;
}

export function SpeakButton({ text, title }: SpeakButtonProps) {
  const { t } = useI18n();
  const enabled = useTtsEnabled();
  const [phase, setPhase] = useState<Phase>('idle');
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const urlRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const generationRef = useRef(0);

  const stop = useCallback(() => {
    generationRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    const audio = audioRef.current;
    if (audio) {
      audio.onended = null;
      audio.onerror = null;
      audio.pause();
    }
    audioRef.current = null;
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    }
    setPhase('idle');
  }, []);

  useEffect(
    () => () => {
      if (currentStop === stop) currentStop = null;
      stop();
    },
    [stop]
  );

  const toggle = useCallback(async () => {
    if (phase !== 'idle') {
      stop();
      return;
    }
    const payload = String(text || '').trim();
    if (!payload) return;

    currentStop?.();
    currentStop = stop;
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    const controller = new AbortController();
    abortRef.current = controller;
    setPhase('loading');

    try {
      const res = await fetch('/api/tts/speak', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: payload.slice(0, 4000) }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      // 下载期间用户已点停止 / 组件已卸载
      if (generation !== generationRef.current) return;

      const url = URL.createObjectURL(blob);
      urlRef.current = url;
      const audio = new Audio(url);
      audioRef.current = audio;
      audio.onended = stop;
      audio.onerror = stop;
      await audio.play();
      if (generation !== generationRef.current) {
        audio.pause();
        return;
      }
      setPhase('playing');
    } catch {
      if (generation === generationRef.current) stop();
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  }, [phase, text, stop]);

  if (!enabled) return null;

  return (
    <button
      type="button"
      onClick={toggle}
      className="p-1.5 rounded-lg hover:text-zinc-900 hover:bg-black/5 dark:hover:text-white dark:hover:bg-white/5 transition-colors cursor-pointer"
      title={title || (phase === 'idle' ? t('selectionSpeak') : t('selectionSpeakStop'))}
      aria-label={phase === 'idle' ? t('selectionSpeak') : t('selectionSpeakStop')}
    >
      {phase === 'loading' ? (
        <Loader2 className="w-3.5 h-3.5 animate-spin" />
      ) : phase === 'playing' ? (
        <Square className="w-3.5 h-3.5" />
      ) : (
        <Volume2 className="w-3.5 h-3.5" />
      )}
    </button>
  );
}
