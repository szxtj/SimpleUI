import { useSyncExternalStore } from 'react';

/**
 * Qwen TTS 服务是否启用（服务管理面板里的 Qwen 开关）。
 *
 * 注意：它只代表本地 Qwen3-TTS 服务，不影响「系统语音」。
 *
 * 实现要点：
 *   - 全局只有一个 store + 一个轮询器，避免每条消息的 SpeakButton 各发一个请求；
 *   - 服务面板切换后调用 setTtsEnabled() 立即广播，入口不用等下一次轮询；
 *   - BroadcastChannel 让主窗口 / Spotlight 两个 WebView 保持同步；
 *   - 用 revision 丢弃「切换前发出、切换后才返回」的旧状态响应。
 */

interface TtsState {
  enabled: boolean;
}

const STORAGE_KEY = 'simpleui_qwen_tts_enabled';
const POLL_INTERVAL_MS = 15000;
const CHANNEL_NAME = 'simpleui_tts_sync';

function readCache(): boolean | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw === null ? null : raw === '1';
  } catch {
    return null;
  }
}

function writeCache(enabled: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, enabled ? '1' : '0');
  } catch {
    // ignore
  }
}

const channel =
  typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(CHANNEL_NAME) : null;

let state: TtsState = { enabled: readCache() ?? true };
let revision = 0;
const listeners = new Set<() => void>();
let subscriberCount = 0;
let pollTimer: number | null = null;
let inflight: { rev: number; promise: Promise<void> } | null = null;

function emit(): void {
  for (const listener of listeners) listener();
}

function applyEnabled(enabled: boolean): void {
  if (state.enabled === enabled) return;
  state = { enabled };
  writeCache(enabled);
  emit();
}

async function fetchStatus(rev: number): Promise<void> {
  try {
    const res = await fetch('/api/tts/status', { cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json();
    // 请求发出后本地又切换过：以本地 / 服务面板的结果为准
    if (rev !== revision) return;
    applyEnabled(data?.enabled !== false);
  } catch {
    // 服务不可达时保留上一次的已知状态
  }
}

/** 主动刷新；同一 revision 下的并发请求会合并 */
export function refreshTtsEnabled(): Promise<void> {
  if (inflight && inflight.rev === revision) return inflight.promise;

  const rev = revision;
  let promise: Promise<void>;
  promise = fetchStatus(rev).finally(() => {
    if (inflight?.promise === promise) inflight = null;
  });
  inflight = { rev, promise };
  return promise;
}

/**
 * 服务面板切换后立即调用：更新所有已挂载入口，并广播到其它窗口。
 * 服务端仍是最终事实来源，随后可再调用 refreshTtsEnabled() 校准。
 */
export function setTtsEnabled(enabled: boolean): void {
  revision += 1;
  applyEnabled(enabled);
  try {
    channel?.postMessage({ type: 'QWEN_TTS_ENABLED', enabled });
  } catch {
    // ignore
  }
}

const handleFocus = () => {
  void refreshTtsEnabled();
};

function startPolling(): void {
  if (pollTimer !== null) return;
  void refreshTtsEnabled();
  pollTimer = window.setInterval(() => {
    void refreshTtsEnabled();
  }, POLL_INTERVAL_MS);
  window.addEventListener('focus', handleFocus);
}

function stopPolling(): void {
  if (pollTimer !== null) {
    window.clearInterval(pollTimer);
    pollTimer = null;
  }
  window.removeEventListener('focus', handleFocus);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  subscriberCount += 1;
  if (subscriberCount === 1) startPolling();
  return () => {
    listeners.delete(listener);
    subscriberCount -= 1;
    if (subscriberCount === 0) stopPolling();
  };
}

const getSnapshot = () => state.enabled;

/** Qwen 朗读入口是否可用 */
export function useTtsEnabled(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

channel?.addEventListener('message', (event: MessageEvent) => {
  const data = event.data as { type?: string; enabled?: boolean } | null;
  if (!data || data.type !== 'QWEN_TTS_ENABLED') return;
  revision += 1;
  applyEnabled(data.enabled !== false);
});
