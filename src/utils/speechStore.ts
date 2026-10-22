import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import { fnv1a32 } from './speechText';
import { resetAudio } from './audioPlayer';

/**
 * 「整篇朗读」状态仓库（模块级单例）。
 *
 * 一次朗读 = 一个按 messageId 记录的作业：
 *   idle → loading（拉起模型）→ generating（逐段合成，带 n/total）→ ready（音频已落盘）
 * 失败进 error。作业互斥：点另一条回答的喇叭会取消上一条。
 *
 * 已落盘的音频通过 `/api/tts/audio/list` 索引恢复：条目的内容指纹（FNV-1a）
 * 与本条消息当前文本一致才认，避免"回答重新生成后还挂着旧音频"。
 */
export type SpeechPhase = 'idle' | 'loading' | 'generating' | 'ready' | 'error';

export interface SpeechState {
  phase: SpeechPhase;
  /** 已合成段数 */
  done: number;
  /** 总段数 */
  total: number;
  chars: number;
  durationSec: number;
  url: string | null;
  error: string | null;
  /** 后端给的错误详情（截断后的原始信息，便于排查） */
  detail?: string;
  startedAt: number;
  /** 点击时用户是否贴在底部：挂载进度条后要把它滚进视野 */
  pinAfterMount: boolean;
}

const IDLE: SpeechState = {
  phase: 'idle',
  done: 0,
  total: 0,
  chars: 0,
  durationSec: 0,
  url: null,
  error: null,
  startedAt: 0,
  pinAfterMount: false,
};

const states = new Map<string, SpeechState>();
const listeners = new Set<() => void>();

function notify() {
  listeners.forEach((fn) => fn());
}

function getState(id: string): SpeechState {
  return states.get(id) ?? IDLE;
}

function setState(id: string, patch: Partial<SpeechState>) {
  states.set(id, { ...getState(id), ...patch });
  notify();
}

export function subscribeSpeech(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

// ----------------------------- 已落盘音频索引 -----------------------------

interface IndexEntry {
  h: number;
  dur: number;
  url: string;
}

let audioIndex = new Map<string, IndexEntry>();
let indexLoaded = false;
let indexPromise: Promise<void> | null = null;

/** messageId → 本条消息当前文本指纹（挂载时登记，索引回来后统一认领） */
const wantedHash = new Map<string, number>();

function applyIndex(id: string, hash: number) {
  const entry = audioIndex.get(id);
  if (!entry || entry.h !== hash) return;
  const cur = getState(id);
  if (cur.phase !== 'idle') return;
  setState(id, { phase: 'ready', url: entry.url, durationSec: entry.dur });
}

function hydrateAll() {
  wantedHash.forEach((hash, id) => applyIndex(id, hash));
}

export function ensureAudioIndex(): Promise<void> {
  if (indexPromise) return indexPromise;
  indexPromise = (async () => {
    try {
      const res = await fetch('/api/tts/audio/list', { cache: 'no-store' });
      if (res.ok) {
        const data = (await res.json()) as { items?: Array<{ id: string; h: number; dur: number; url: string }> };
        audioIndex = new Map(
          (data.items ?? []).map((it) => [it.id, { h: Number(it.h) >>> 0, dur: Number(it.dur) || 0, url: it.url }])
        );
      }
    } catch {
      // 索引拿不到就当作"没有历史音频"，不影响本次生成
    }
    indexLoaded = true;
    hydrateAll();
  })();
  return indexPromise;
}

/** 音频被重新生成 / 删除后，让下一次挂载重新拉索引。 */
export function invalidateAudioIndex() {
  indexPromise = null;
  indexLoaded = false;
}

// ----------------------------- 作业控制 -----------------------------

let activeJob: { id: string; ac: AbortController } | null = null;

/**
 * 「点击瞬间贴底 → 挂载后滚进视野」只允许每个作业发生一次。
 * 否则切走会话再切回来、或条子因窗口化重新挂载时，会把视野又拽一次。
 */
const pinConsumed = new Set<string>();

export function consumePinAfterMount(messageId: string): boolean {
  if (pinConsumed.has(messageId)) return false;
  pinConsumed.add(messageId);
  return true;
}

/** 显式通知后端取消：只靠 abort 断开连接时，服务端可能还在忙着当前这一段。 */
function requestCancel(messageId: string) {
  try {
    void fetch('/api/tts/article/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messageId }),
      keepalive: true,
    }).catch(() => {});
  } catch {}
}

function abortActive() {
  if (!activeJob) return null;
  const { id, ac } = activeJob;
  activeJob = null;
  requestCancel(id);
  try {
    ac.abort();
  } catch {}
  return id;
}

export function cancelSpeech(messageId: string) {
  if (activeJob?.id === messageId) abortActive();
  // 兜底：任务其实已经断了（流没给 done/error 就结束），状态也要能收回来
  const cur = getState(messageId);
  if (cur.phase === 'loading' || cur.phase === 'generating') {
    setState(messageId, { phase: 'idle', done: 0, total: 0, error: null });
  }
}

function handleEvent(id: string, evt: Record<string, unknown>) {
  const t = evt.t;
  if (t === 'phase') {
    const phase = evt.phase === 'loading' ? 'loading' : 'generating';
    setState(id, {
      phase,
      total: Number(evt.total) || getState(id).total,
      chars: Number(evt.chars) || getState(id).chars,
    });
    return;
  }
  if (t === 'progress') {
    setState(id, {
      phase: 'generating',
      done: Number(evt.done) || 0,
      total: Number(evt.total) || getState(id).total,
    });
    return;
  }
  if (t === 'done') {
    const url = String(evt.url || '');
    const dur = Number(evt.durationSec) || 0;
    const hash = Number(evt.hash) >>> 0;
    audioIndex.set(id, { h: hash, dur, url });
    wantedHash.set(id, hash);
    setState(id, { phase: 'ready', url, durationSec: dur, error: null });
    return;
  }
  if (t === 'error') {
    setState(id, {
      phase: 'error',
      error: String(evt.error || 'FAILED'),
      detail: evt.message ? String(evt.message).slice(0, 300) : undefined,
    });
  }
}

async function startSpeech(id: string, segments: string[], pinAfterMount: boolean) {
  const list = segments.filter((s) => s && s.trim());
  if (!list.length || !id) return;

  // 全局互斥：上一条还在生成就先停掉
  const prev = abortActive();
  if (prev && prev !== id) {
    setState(prev, { phase: 'idle', done: 0, total: 0, error: null });
  }

  // 重新生成时先把旧音频停掉，避免"看着在生成、耳朵里还是旧的"
  const prevState = getState(id);
  if (prevState.url) resetAudio(prevState.url);

  const ac = new AbortController();
  activeJob = { id, ac };
  pinConsumed.delete(id);

  setState(id, {
    phase: 'loading',
    done: 0,
    total: list.length,
    chars: list.reduce((a, s) => a + s.length, 0),
    durationSec: 0,
    url: null,
    error: null,
    detail: undefined,
    startedAt: Date.now(),
    pinAfterMount,
  });

  try {
    const res = await fetch('/api/tts/article', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messageId: id, text: list.join('\n'), segments: list }),
      signal: ac.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw Object.assign(new Error(`HTTP ${res.status}`), { code: body.slice(0, 200) });
    }
    if (!res.body) throw new Error('NO_STREAM');

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl = buffer.indexOf('\n');
      while (nl >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line) {
          try {
            handleEvent(id, JSON.parse(line) as Record<string, unknown>);
          } catch {
            // 半行 / 脏行直接跳过，不影响后续事件
          }
        }
        nl = buffer.indexOf('\n');
      }
    }

    // 流结束却没有 done/error（后端被杀、网络断）→ 不要让界面永远停在"生成中"
    const tail = getState(id);
    if (!ac.signal.aborted && (tail.phase === 'loading' || tail.phase === 'generating')) {
      setState(id, { phase: 'error', error: 'STREAM_INTERRUPTED' });
    }
  } catch (e) {
    if (ac.signal.aborted) return; // 用户主动取消：状态已归零
    setState(id, {
      phase: 'error',
      error: e instanceof Error ? e.message : 'FAILED',
    });
  } finally {
    if (activeJob?.ac === ac) activeJob = null;
  }
}

/** 删除本条消息的落盘音频。 */
export async function deleteSpeech(messageId: string) {
  if (activeJob?.id === messageId) abortActive();
  const prevUrl = getState(messageId).url;
  try {
    await fetch('/api/tts/audio/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messageId }),
    });
  } catch {
    // 删除失败也把本地状态清掉：下次挂载会由索引兜底纠正
  }
  audioIndex.delete(messageId);
  wantedHash.delete(messageId);
  states.delete(messageId);
  if (prevUrl) resetAudio(prevUrl);
  notify();
}

// ----------------------------- React 绑定 -----------------------------

export interface UseSpeechAudio {
  state: SpeechState;
  start: (pinAfterMount: boolean) => void;
  cancel: () => void;
  remove: () => void;
  segments: string[];
}

/**
 * @param messageId 消息 id（落盘文件名与索引的键）
 * @param segments  已切好的朗读片段（splitSpeechSegments 的输出）
 */
export function useSpeechAudio(messageId: string, segments: string[]): UseSpeechAudio {
  const hash = useMemo(() => fnv1a32(segments.join('\n')), [segments]);
  const state = useSyncExternalStore(
    subscribeSpeech,
    () => getState(messageId),
    () => getState(messageId)
  );

  useEffect(() => {
    if (!messageId || !segments.length) return;
    wantedHash.set(messageId, hash);
    if (indexLoaded) applyIndex(messageId, hash);
    else void ensureAudioIndex();
  }, [messageId, hash, segments.length]);

  const start = useCallback(
    (pinAfterMount: boolean) => {
      void startSpeech(messageId, segments, pinAfterMount);
    },
    [messageId, segments]
  );

  const cancel = useCallback(() => cancelSpeech(messageId), [messageId]);

  const remove = useCallback(() => {
    void deleteSpeech(messageId);
  }, [messageId]);

  return { state, start, cancel, remove, segments };
}
