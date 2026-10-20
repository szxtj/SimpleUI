/**
 * 系统语音朗读（Web Speech API）的健壮封装。
 *
 * macOS / WKWebView 上 speechSynthesis 有几个已知坑，直接裸用会出现
 * 「第一次点击没声音」和「播放完了 UI 还停在播放中」：
 *
 *   1. cancel() 是异步生效的，紧接着 speak() 可能把新 utterance 一起吞掉；
 *   2. getVoices() 首次通常返回空数组，音色要等 voiceschanged 才可用；
 *   3. utterance 只被局部变量引用时，可能被 GC 后中断朗读；
 *   4. onstart / onend / onerror 不接，调用方永远不知道播放结束。
 *
 * 这里统一处理：预取音色、保留 utterance 引用、cancel 后留出清队列的时间、
 * 绑定完整生命周期，并在首次静默失败时自动重试一次。
 */

export interface SystemTtsHandlers {
  /** 引擎真正开始朗读（不是点击瞬间） */
  onStart?: () => void;
  /** 正常读完，或被外部 stop() */
  onEnd?: () => void;
  /** 不支持 / 启动失败 / 播放出错 */
  onError?: (reason?: string) => void;
}

/** cancel 后给 WebKit 留出的清队列时间 */
const CANCEL_SETTLE_MS = 80;
/** 等待 onstart（或 speaking/pending 变 true）的宽限 */
const START_GRACE_MS = 900;
/** 播放状态轮询间隔 */
const WATCH_INTERVAL_MS = 300;
/** 连续多少次检测到引擎空闲就认为播放结束（兜底缺失的 onend） */
const QUIET_TICKS_TO_END = 2;

let cachedVoices: SpeechSynthesisVoice[] = [];
let voicesHooked = false;
let currentUtterance: SpeechSynthesisUtterance | null = null;
let currentCleanup: (() => void) | null = null;
let currentToken = 0;
let lastCancelAt = 0;

function getSynth(): SpeechSynthesis | null {
  if (typeof window === 'undefined') return null;
  return window.speechSynthesis ?? null;
}

function refreshVoices(): void {
  const synth = getSynth();
  if (!synth) return;
  try {
    cachedVoices = synth.getVoices();
  } catch {
    cachedVoices = [];
  }
}

/**
 * 应用启动时调用一次：预取音色并监听 voiceschanged。
 * 这样第一次点击「系统」时就能拿到正确的中文 / 英文音色。
 */
export function primeSystemVoices(): void {
  const synth = getSynth();
  if (!synth) return;
  refreshVoices();
  if (voicesHooked) return;
  voicesHooked = true;
  const onChange = () => refreshVoices();
  try {
    synth.addEventListener('voiceschanged', onChange);
  } catch {
    synth.onvoiceschanged = onChange;
  }
}

function pickVoice(text: string): { voice: SpeechSynthesisVoice | null; lang: string } {
  const isZh = /[\u3400-\u9fff]/.test(text);
  const lang = isZh ? 'zh-CN' : 'en-US';
  if (cachedVoices.length === 0) refreshVoices();
  const prefix = isZh ? 'zh' : 'en';
  const matches = cachedVoices.filter((v) => v.lang?.toLowerCase().startsWith(prefix));
  // 优先本地音色，其次系统默认音色；即使拿不到也交给 utter.lang 兜底
  const voice =
    matches.find((v) => v.localService) ??
    matches.find((v) => v.default) ??
    matches[0] ??
    null;
  return { voice, lang };
}

/** 上一段还在播时先 cancel，并返回需要等待的毫秒数 */
function cancelIfBusy(synth: SpeechSynthesis): number {
  let busy = false;
  try {
    busy = synth.speaking || synth.pending;
  } catch {
    busy = false;
  }

  if (busy) {
    try {
      synth.cancel();
    } catch {
      // ignore
    }
    lastCancelAt = performance.now();
    return CANCEL_SETTLE_MS;
  }

  // 刚刚在别处 cancel 过：同样等一小会儿，避免同一个竞态
  if (lastCancelAt > 0) {
    const elapsed = performance.now() - lastCancelAt;
    if (elapsed < CANCEL_SETTLE_MS) return CANCEL_SETTLE_MS - elapsed;
  }
  return 0;
}

/**
 * 朗读一段文本。返回一个 stop 函数。
 * handlers 只会被当前这一次朗读触发；被新朗读 / stop 取代的旧回调会被丢弃。
 */
export function speakSystemTts(text: string, handlers: SystemTtsHandlers = {}): () => void {
  const synth = getSynth();
  const payload = String(text || '').replace(/\s+/g, ' ').trim();

  if (!synth || !payload) {
    handlers.onError?.(synth ? 'EMPTY_TEXT' : 'UNSUPPORTED');
    return () => {};
  }

  primeSystemVoices();
  // 先停掉上一段并清理它的看门狗，避免新旧两次朗读的定时器叠加
  currentCleanup?.();
  currentCleanup = null;
  const token = ++currentToken;
  const { lang } = pickVoice(payload);

  let settled = false;
  let started = false;
  let attempts = 0;
  let quietTicks = 0;
  let beganAt = performance.now();
  let utter: SpeechSynthesisUtterance | null = null;
  let watchTimer: number | null = null;
  let hardTimer: number | null = null;

  const cleanup = () => {
    if (watchTimer !== null) {
      window.clearInterval(watchTimer);
      watchTimer = null;
    }
    if (hardTimer !== null) {
      window.clearTimeout(hardTimer);
      hardTimer = null;
    }
    if (currentCleanup === cleanup) currentCleanup = null;
  };
  currentCleanup = cleanup;

  const settle = (kind: 'end' | 'error', reason?: string) => {
    if (settled) return;
    settled = true;
    cleanup();
    // 已被新的朗读 / stop 取代：不要动调用方的 UI 状态
    if (token !== currentToken) return;
    if (currentUtterance === utter) currentUtterance = null;
    if (kind === 'end') handlers.onEnd?.();
    else handlers.onError?.(reason);
  };

  const markStarted = () => {
    if (settled || token !== currentToken || started) return;
    started = true;
    quietTicks = 0;
    handlers.onStart?.();
  };

  const speakOnce = () => {
    if (settled || token !== currentToken) return;
    // 每次尝试都重新挑一次音色：首次点击时 voices 可能还没加载完，重试时已经就绪
    const { voice } = pickVoice(payload);
    const u = new SpeechSynthesisUtterance(payload);
    u.lang = lang;
    if (voice) u.voice = voice;
    u.rate = 1.0;
    u.volume = 1.0;
    u.onstart = markStarted;
    u.onend = () => settle('end');
    u.onerror = (event) => settle('error', event.error);
    utter = u;
    // 模块级保留引用，避免 WebKit 在朗读过程中把 utterance GC 掉
    currentUtterance = u;
    beganAt = performance.now();
    try {
      synth.speak(u);
    } catch (err) {
      settle('error', (err as Error)?.message || 'SPEAK_FAILED');
    }
  };

  const begin = () => {
    if (settled || token !== currentToken) return;
    speakOnce();

    // 兜底：极少数 WebKit 既不派发 onend，speaking 也一直为 true。
    // 按文本长度给一个非常宽松的上限，避免 UI 永久卡在“播放中”。
    const maxMs = Math.max(15000, payload.length * 260);
    hardTimer = window.setTimeout(() => settle('end'), maxMs);

    watchTimer = window.setInterval(() => {
      if (settled || token !== currentToken) return;

      let speaking = false;
      let pending = false;
      try {
        speaking = synth.speaking;
        pending = synth.pending;
      } catch {
        // ignore
      }

      if (!started) {
        if (speaking || pending) {
          markStarted();
          return;
        }
        // 首次调用偶发静默失败：重试一次（先摘掉旧句柄再 cancel，避免它触发 onend 把重试也结束掉）
        if (performance.now() - beganAt >= START_GRACE_MS) {
          if (attempts < 1) {
            attempts += 1;
            if (utter) {
              utter.onstart = null;
              utter.onend = null;
              utter.onerror = null;
            }
            try {
              synth.cancel();
            } catch {
              // ignore
            }
            lastCancelAt = performance.now();
            window.setTimeout(() => {
              if (!settled && token === currentToken) speakOnce();
            }, CANCEL_SETTLE_MS);
          } else {
            settle('error', 'NO_START');
          }
        }
        return;
      }

      // 已经判定开始：兼容个别 WebKit 不派发 onend 的情况
      if (speaking || pending) {
        quietTicks = 0;
        return;
      }
      quietTicks += 1;
      if (quietTicks >= QUIET_TICKS_TO_END) settle('end');
    }, WATCH_INTERVAL_MS);
  };

  const wait = cancelIfBusy(synth);
  if (wait > 0) window.setTimeout(begin, wait);
  else begin();

  return () => {
    if (token === currentToken) stopSystemTts();
  };
}

/** 立即停止当前系统朗读（也会让旧的回调失效） */
export function stopSystemTts(): void {
  const cleanup = currentCleanup;
  currentCleanup = null;
  cleanup?.();
  currentToken += 1;
  currentUtterance = null;
  const synth = getSynth();
  if (!synth) return;
  try {
    synth.cancel();
  } catch {
    // ignore
  }
  lastCancelAt = performance.now();
}
