import { useSyncExternalStore } from 'react';

/**
 * 全局唯一的朗读播放器（单例）。
 *
 * 为什么不用组件内的 `<audio>`：对话区只挂载「当前轮 ± 2」，往下翻两屏消息就卸载了，
 * 组件持有的播放器会随之一并停止。这里把播放能力放到模块级，条子只做视图，
 * 滚走再滚回来仍然接着播。
 */
export interface AudioPlayerState {
  /** 当前装载的音轨 URL（/api/tts/audio/...） */
  url: string | null;
  playing: boolean;
  time: number;
  duration: number;
  muted: boolean;
  error: string | null;
}

const INITIAL: AudioPlayerState = {
  url: null,
  playing: false,
  time: 0,
  duration: 0,
  muted: false,
  error: null,
};

let state: AudioPlayerState = INITIAL;
const listeners = new Set<() => void>();
let audio: HTMLAudioElement | null = null;
let raf = 0;

function emit(patch: Partial<AudioPlayerState>) {
  state = { ...state, ...patch };
  listeners.forEach((fn) => fn());
}

export function subscribeAudio(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function getAudioState() {
  return state;
}

function stopTick() {
  if (raf) cancelAnimationFrame(raf);
  raf = 0;
}

/** 播放中每帧推进进度（timeupdate 只有 4Hz，进度条会一格一格跳） */
function startTick() {
  stopTick();
  const tick = () => {
    if (!audio || audio.paused) {
      raf = 0;
      return;
    }
    // ~15fps 足够顺滑，又不至于把整棵树按 60fps 唤起来
    if (Math.abs(audio.currentTime - state.time) > 1 / 15) {
      emit({ time: audio.currentTime });
    }
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
}

function ensureAudio(): HTMLAudioElement {
  if (audio) return audio;
  const el = new Audio();
  el.preload = 'auto';
  el.addEventListener('loadedmetadata', () => {
    if (Number.isFinite(el.duration) && el.duration > 0) emit({ duration: el.duration });
  });
  el.addEventListener('play', () => {
    emit({ playing: true, error: null });
    startTick();
  });
  el.addEventListener('pause', () => {
    emit({ playing: false, time: el.currentTime });
    stopTick();
  });
  el.addEventListener('ended', () => {
    emit({ playing: false, time: 0 });
    stopTick();
    try {
      el.currentTime = 0;
    } catch {}
  });
  el.addEventListener('error', () => {
    emit({ playing: false, error: 'AUDIO_ERROR' });
    stopTick();
  });
  audio = el;
  return el;
}

/** 播放指定音轨（若正在播别的会先切过去）。durationHint 来自索引，避免首帧 0:00/0:00。 */
export function playAudio(url: string, durationHint = 0) {
  if (!url) return;
  const el = ensureAudio();
  if (state.url !== url) {
    el.src = url;
    el.load();
    emit({ url, time: 0, duration: durationHint, error: null });
  } else if (!state.duration && durationHint) {
    emit({ duration: durationHint });
  }
  el.muted = state.muted;
  const p = el.play();
  if (p && typeof p.catch === 'function') {
    p.catch((e: unknown) => {
      emit({ playing: false, error: e instanceof Error ? e.message : 'PLAY_FAILED' });
    });
  }
}

export function pauseAudio() {
  if (audio && !audio.paused) audio.pause();
}

/** 同一条音轨：在播就暂停，没播就播放。 */
export function toggleAudio(url: string, durationHint = 0) {
  if (state.url === url && state.playing) {
    pauseAudio();
    return;
  }
  playAudio(url, durationHint);
}

export function seekAudio(url: string, seconds: number, durationHint = 0) {
  const el = ensureAudio();
  const target = Math.max(0, seconds);
  if (state.url !== url) {
    el.src = url;
    el.load();
    emit({ url, time: target, duration: durationHint, error: null });
    el.addEventListener(
      'loadedmetadata',
      () => {
        try {
          el.currentTime = target;
        } catch {}
        const p = el.play();
        if (p && typeof p.catch === 'function') p.catch(() => {});
      },
      { once: true }
    );
    return;
  }
  try {
    el.currentTime = target;
  } catch {}
  emit({ time: target });
  if (el.paused) {
    const p = el.play();
    if (p && typeof p.catch === 'function') p.catch(() => {});
  }
}

export function setAudioMuted(muted: boolean) {
  const el = ensureAudio();
  el.muted = muted;
  emit({ muted });
}

/** 停掉并卸载当前音轨（删除音频 / 重新生成时用）。 */
export function resetAudio(url?: string) {
  if (!audio) return;
  if (url && state.url !== url) return;
  try {
    audio.pause();
  } catch {}
  stopTick();
  emit({ url: null, playing: false, time: 0, duration: 0, error: null });
}

export function useAudioPlayer(): AudioPlayerState {
  return useSyncExternalStore(subscribeAudio, getAudioState, getAudioState);
}

export function formatClock(seconds: number): string {
  const total = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
