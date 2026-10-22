import { useCallback } from 'react';
import { Volume2, Square, Loader2, AlertCircle } from 'lucide-react';
import { useI18n } from '../i18n';
import type { SpeechState } from '../utils/speechStore';
import { toggleAudio, useAudioPlayer } from '../utils/audioPlayer';

interface SpeakButtonProps {
  state: SpeechState;
  /** 开始整篇朗读：参数表示点击时用户是否贴在底部（决定进度条挂载后是否滚进视野） */
  onStart: (pinAfterMount: boolean) => void;
  onCancel: () => void;
  title?: string;
}

/**
 * 消息底部的朗读按钮 —— 触发语音合成的**唯一**入口。
 *
 * 状态与按钮语义：
 *   idle      → 点击开始（现场加载模型 + 逐段合成分段进度）
 *   loading   → 加载模型中，点击取消
 *   generating→ 合成中，点击取消
 *   ready     → 点击播放 / 暂停已落盘的音频
 *   error     → 点击重试
 */
export function SpeakButton({ state, onStart, onCancel, title }: SpeakButtonProps) {
  const { t } = useI18n();
  const player = useAudioPlayer();

  const isThisTrack = !!state.url && player.url === state.url;
  const playing = isThisTrack && player.playing;
  const busy = state.phase === 'loading' || state.phase === 'generating';

  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLButtonElement>) => {
      if (busy) {
        onCancel();
        return;
      }
      if (state.phase === 'ready' && state.url) {
        toggleAudio(state.url, state.durationSec);
        return;
      }
      // 贴底判定必须在插入进度条之前取，否则高度已经变了
      const scroller = e.currentTarget.closest('.chat-scroller') as HTMLElement | null;
      const atBottom = scroller
        ? scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop <= 48
        : false;
      onStart(atBottom);
    },
    [busy, onCancel, onStart, state.phase, state.url, state.durationSec]
  );

  const label = busy
    ? t('ttsCancelGenerate')
    : state.phase === 'error'
    ? t('ttsErrorRetry')
    : state.phase === 'ready'
    ? playing
      ? t('ttsPauseAudio')
      : t('ttsPlayAudio')
    : title || t('speakMessage');

  return (
    <button
      type="button"
      onClick={handleClick}
      data-tts-trigger="true"
      className="p-1.5 rounded-lg hover:text-zinc-900 hover:bg-black/5 dark:hover:text-white dark:hover:bg-white/5 transition-colors cursor-pointer"
      title={label}
      aria-label={label}
      aria-pressed={playing}
    >
      {busy ? (
        <Loader2 className="w-3.5 h-3.5 animate-spin" />
      ) : state.phase === 'error' ? (
        <AlertCircle className="w-3.5 h-3.5 text-red-500 dark:text-red-400" />
      ) : playing ? (
        <Square className="w-3.5 h-3.5" />
      ) : (
        <Volume2 className="w-3.5 h-3.5" />
      )}
    </button>
  );
}
