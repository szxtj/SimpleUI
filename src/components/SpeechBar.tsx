import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  Loader2,
  Play,
  Pause,
  Volume2,
  VolumeX,
  MoreVertical,
  RotateCcw,
  Trash2,
  X,
  AlertCircle,
} from 'lucide-react';
import { useI18n } from '../i18n';
import { consumePinAfterMount, type SpeechState } from '../utils/speechStore';
import {
  formatClock,
  seekAudio,
  setAudioMuted,
  toggleAudio,
  useAudioPlayer,
} from '../utils/audioPlayer';

interface SpeechBarProps {
  state: SpeechState;
  messageId: string;
  onRegenerate: () => void;
  onDelete: () => void;
  onCancel: () => void;
}

/**
 * 消息下方的朗读条：生成中显示分段进度，生成完变成播放器（播放/暂停、进度、
 * 音量、重新生成/删除）。
 *
 * **高度恒定 44px**：进度态与播放态同高，状态切换不会让对话区跳动一下。
 * 只挂在消息流的正常文档流里，不脱离文档流、不遮挡正文。
 */
export function SpeechBar({ state, messageId, onRegenerate, onDelete, onCancel }: SpeechBarProps) {
  const { t } = useI18n();
  const player = useAudioPlayer();
  const barRef = useRef<HTMLDivElement | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);
  const [menuOpen, setMenuOpen] = useState(false);

  const busy = state.phase === 'loading' || state.phase === 'generating';
  const ready = state.phase === 'ready' && !!state.url;
  const isThisTrack = !!state.url && player.url === state.url;

  // 点击时用户贴在底部 → 进度条插进来后把它滚进视野（否则条子出现在屏幕外，等于没反应）。
  // 每个作业只做一次：切走会话再切回来、或因窗口化重新挂载时，不该再拽一次视野。
  useLayoutEffect(() => {
    if (!state.pinAfterMount) return;
    if (state.phase !== 'loading' && state.phase !== 'generating') return;
    if (!consumePinAfterMount(messageId)) return;
    const el = barRef.current;
    if (!el) return;
    el.scrollIntoView({ block: 'nearest' });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // 「更多」菜单：状态一变（重新生成 → 进度态 → 再回到播放态）就收起，别一直挂着
  useEffect(() => {
    setMenuOpen(false);
  }, [state.phase, state.url]);

  // 点栏外收起菜单（点栏内不关，方便连续操作）
  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      const el = barRef.current;
      if (el && e.target instanceof Node && el.contains(e.target)) return;
      setMenuOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [menuOpen]);

  const duration = isThisTrack && player.duration > 0 ? player.duration : state.durationSec;
  const time = isThisTrack ? player.time : 0;
  const playing = isThisTrack && player.playing;
  const pct = duration > 0 ? Math.min(100, Math.max(0, (time / duration) * 100)) : 0;
  const progressPct = state.total > 0 ? Math.min(100, (state.done / state.total) * 100) : 0;

  const seekFromClientX = (clientX: number) => {
    const el = trackRef.current;
    if (!el || !state.url || duration <= 0) return;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0) return;
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    seekAudio(state.url, ratio * duration, state.durationSec);
  };

  const shell =
    'mt-2 flex items-center gap-2.5 h-11 px-3 rounded-full border border-black/[0.07] dark:border-white/[0.09] bg-black/[0.035] dark:bg-white/[0.055] select-none';

  // ---- 生成中：分段进度 ----
  if (busy) {
    const label = state.phase === 'loading' ? t('ttsLoadingModel') : t('ttsGenerating');
    return (
      <div ref={barRef} data-tts-bar="generating" className={shell}>
        <Loader2 className="w-3.5 h-3.5 animate-spin text-sky-500 dark:text-sky-400 flex-shrink-0" />
        <span className="text-[11px] font-medium text-zinc-600 dark:text-zinc-300 whitespace-nowrap">
          {label}
        </span>
        <span className="text-[11px] font-mono tabular-nums text-zinc-400 dark:text-zinc-500 whitespace-nowrap">
          {state.phase === 'loading' ? '—' : `${state.done}/${state.total}`}
        </span>
        <div className="flex-1 h-1 rounded-full bg-black/10 dark:bg-white/15 overflow-hidden min-w-[40px]">
          {state.phase === 'loading' ? (
            // 加载模型阶段没有真实百分比：整条做呼吸感，不假装进度
            <div className="h-full w-full animate-pulse rounded-full bg-gradient-to-r from-sky-500/40 via-emerald-500/50 to-sky-500/40" />
          ) : (
            <div
              className="h-full rounded-full bg-gradient-to-r from-sky-500 to-emerald-500 transition-[width] duration-300"
              style={{ width: `${progressPct}%` }}
            />
          )}
        </div>
        <button
          type="button"
          onClick={onCancel}
          title={t('ttsCancelGenerate')}
          aria-label={t('ttsCancelGenerate')}
          className="p-1 rounded-full text-zinc-400 hover:text-zinc-700 hover:bg-black/5 dark:text-zinc-500 dark:hover:text-zinc-200 dark:hover:bg-white/10 transition-colors cursor-pointer flex-shrink-0"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    );
  }

  // ---- 失败 ----
  if (state.phase === 'error') {
    const message =
      state.error === 'MODEL_MISSING'
        ? t('ttsErrorModelMissing')
        : state.error === 'TEXT_TOO_LONG' || state.error === 'TOO_MANY_SEGMENTS'
        ? t('ttsErrorTooLong')
        : t('ttsErrorGeneric');
    return (
      <div
        ref={barRef}
        data-tts-bar="error"
        className={`${shell} border-red-500/25 dark:border-red-500/25 bg-red-500/[0.06] dark:bg-red-500/10`}
      >
        <AlertCircle className="w-3.5 h-3.5 text-red-500 dark:text-red-400 flex-shrink-0" />
        <span className="text-[11px] text-red-600 dark:text-red-300 truncate" title={state.detail || message}>
          {message}
        </span>
        <div className="flex-1" />
        <button
          type="button"
          onClick={onRegenerate}
          className="px-2 py-1 rounded-full text-[11px] font-medium text-red-600 dark:text-red-300 hover:bg-red-500/10 transition-colors cursor-pointer flex-shrink-0"
        >
          {t('ttsRegenerate')}
        </button>
      </div>
    );
  }

  if (!ready) return null;

  // ---- 播放器 ----
  return (
    <div ref={barRef} data-tts-bar="ready" data-audio-url={state.url || ''} className={shell}>
      <button
        type="button"
        onClick={() => state.url && toggleAudio(state.url, state.durationSec)}
        title={playing ? t('ttsPauseAudio') : t('ttsPlayAudio')}
        aria-label={playing ? t('ttsPauseAudio') : t('ttsPlayAudio')}
        className="w-7 h-7 -ml-1 rounded-full flex items-center justify-center flex-shrink-0 text-zinc-700 dark:text-zinc-100 hover:bg-black/[0.06] dark:hover:bg-white/10 active:scale-95 transition-all cursor-pointer"
      >
        {playing ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5 ml-[1px]" />}
      </button>

      <span className="text-[11px] font-mono tabular-nums text-zinc-500 dark:text-zinc-400 whitespace-nowrap">
        {formatClock(time)} / {formatClock(duration)}
      </span>

      <div
        ref={trackRef}
        data-tts-track="true"
        className="relative flex-1 h-1.5 min-w-[40px] rounded-full bg-black/10 dark:bg-white/20 cursor-pointer touch-none"
        onPointerDown={(e) => {
          e.preventDefault();
          e.stopPropagation();
          draggingRef.current = true;
          try {
            e.currentTarget.setPointerCapture(e.pointerId);
          } catch {}
          seekFromClientX(e.clientX);
        }}
        onPointerMove={(e) => {
          if (!draggingRef.current) return;
          e.stopPropagation();
          seekFromClientX(e.clientX);
        }}
        onPointerUp={(e) => {
          draggingRef.current = false;
          try {
            e.currentTarget.releasePointerCapture(e.pointerId);
          } catch {}
        }}
        onPointerCancel={(e) => {
          draggingRef.current = false;
          try {
            e.currentTarget.releasePointerCapture(e.pointerId);
          } catch {}
        }}
      >
        <div
          className="absolute inset-y-0 left-0 rounded-full bg-zinc-700 dark:bg-zinc-100"
          style={{ width: `${pct}%` }}
        />
        <span
          className="absolute top-1/2 -translate-y-1/2 w-2.5 h-2.5 rounded-full bg-zinc-700 dark:bg-white shadow-sm pointer-events-none"
          style={{ left: `calc(${pct}% - 5px)` }}
        />
      </div>

      {menuOpen ? (
        <div className="flex items-center gap-0.5 flex-shrink-0">
          <button
            type="button"
            onClick={() => {
              setMenuOpen(false);
              onRegenerate();
            }}
            title={t('ttsRegenerate')}
            aria-label={t('ttsRegenerate')}
            className="p-1 rounded-full text-zinc-500 hover:text-zinc-800 hover:bg-black/5 dark:text-zinc-400 dark:hover:text-zinc-100 dark:hover:bg-white/10 transition-colors cursor-pointer"
          >
            <RotateCcw className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={() => {
              setMenuOpen(false);
              onDelete();
            }}
            title={t('ttsDeleteAudio')}
            aria-label={t('ttsDeleteAudio')}
            className="p-1 rounded-full text-zinc-500 hover:text-red-600 hover:bg-red-500/10 dark:text-zinc-400 dark:hover:text-red-400 dark:hover:bg-red-500/10 transition-colors cursor-pointer"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-0.5 flex-shrink-0">
          <button
            type="button"
            onClick={() => setAudioMuted(!player.muted)}
            title={player.muted ? t('ttsUnmute') : t('ttsMute')}
            aria-label={player.muted ? t('ttsUnmute') : t('ttsMute')}
            className="p-1 rounded-full text-zinc-500 hover:text-zinc-800 hover:bg-black/5 dark:text-zinc-400 dark:hover:text-zinc-100 dark:hover:bg-white/10 transition-colors cursor-pointer"
          >
            {player.muted ? <VolumeX className="w-3.5 h-3.5" /> : <Volume2 className="w-3.5 h-3.5" />}
          </button>
          <button
            type="button"
            onClick={() => setMenuOpen(true)}
            title={t('ttsMoreActions')}
            aria-label={t('ttsMoreActions')}
            className="p-1 rounded-full text-zinc-500 hover:text-zinc-800 hover:bg-black/5 dark:text-zinc-400 dark:hover:text-zinc-100 dark:hover:bg-white/10 transition-colors cursor-pointer"
          >
            <MoreVertical className="w-3.5 h-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}
