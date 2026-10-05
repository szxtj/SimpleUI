import { ChatSession, AppSettings, ChatMessage } from '../types/chat';
import { saveImageToDB, getImagesFromDB } from './imageStore';
import { uploadDataUrl } from '../utils/image';

const SESSIONS_KEY = 'tff_chat_sessions_v1';
const CURRENT_ID_KEY = 'tff_chat_current_id_v1';
const SETTINGS_KEY = 'tff_chat_settings_v1';

// Cross-window BroadcastChannel for instant real-time sync between Main and Spotlight windows
export const syncChannel =
  typeof BroadcastChannel !== 'undefined'
    ? new BroadcastChannel('tff_session_sync')
    : null;

export function notifySessionUpdate(sessionId?: string, source: string = 'UNKNOWN'): void {
  try {
    syncChannel?.postMessage({ type: 'SESSIONS_CHANGED', sessionId, source });
  } catch (e) {
    console.error('BroadcastChannel postMessage error:', e);
  }
}

export function notifySettingsUpdate(): void {
  try {
    syncChannel?.postMessage({ type: 'SETTINGS_CHANGED' });
  } catch (e) {
    console.error('BroadcastChannel postMessage error:', e);
  }
}

export const DEFAULT_SETTINGS: AppSettings = {
  apiPort: 1235,
  apiBaseUrl: '',
  modelId: 'gemma-4-26b-a4b-it',
  maxContext: 16384, // 16K default
  enableThinking: false, // Default OFF
  reasoningEffort: 'high',
  temperature: 1.0, // Gemma 4 26B-A4B official recommended default
  topP: 0.95,
  topK: 64,
  repetitionPenalty: 1.0,
  maxTokens: 8192, // Linked: half of maxContext (16384 / 2)
  stopStrings: [],
  systemPrompt: 'You are a helpful assistant.', // Google Gemma official canonical prompt
  language: 'system',
  theme: 'system',
  enableWikiSearch: false, // Default OFF
  customWikiDir: '',
  spotlightResetMinutes: 15, // Default 15 minutes
};

export function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw);
    const maxContext = parsed?.maxContext || DEFAULT_SETTINGS.maxContext;
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      language: parsed?.language || 'system',
      theme: parsed?.theme || 'system',
      enableThinking: parsed?.enableThinking !== undefined ? parsed.enableThinking : false,
      enableWikiSearch: parsed?.enableWikiSearch !== undefined ? parsed.enableWikiSearch : false,
      customWikiDir: parsed?.customWikiDir || '',
      spotlightResetMinutes: parsed?.spotlightResetMinutes !== undefined ? Number(parsed.spotlightResetMinutes) : 15,
      apiPort: parsed?.apiPort || 1235,
      maxContext,
      maxTokens: Math.floor(maxContext / 2),
      stopStrings: Array.isArray(parsed?.stopStrings) ? parsed.stopStrings : [],
    };
  } catch (e) {
    console.error('Failed to load settings from localStorage:', e);
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(settings: AppSettings): void {
  try {
    const maxContext = settings?.maxContext || DEFAULT_SETTINGS.maxContext;
    const sanitized: AppSettings = {
      ...DEFAULT_SETTINGS,
      ...settings,
      language: settings?.language || 'system',
      theme: settings?.theme || 'system',
      enableThinking: settings?.enableThinking !== undefined ? settings.enableThinking : false,
      enableWikiSearch: settings?.enableWikiSearch !== undefined ? settings.enableWikiSearch : false,
      customWikiDir: settings?.customWikiDir || '',
      spotlightResetMinutes: settings?.spotlightResetMinutes !== undefined ? Number(settings.spotlightResetMinutes) : 15,
      apiPort: settings?.apiPort || 1235,
      maxContext,
      maxTokens: Math.floor(maxContext / 2),
      stopStrings: Array.isArray(settings?.stopStrings) ? settings.stopStrings : [],
    };
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(sanitized));
    notifySettingsUpdate();
  } catch (e) {
    console.error('Failed to save settings:', e);
  }
}

export function loadSessions(): ChatSession[] {
  try {
    const raw = localStorage.getItem(SESSIONS_KEY);
    if (!raw) {
      const initial = createNewSession();
      saveSessions([initial]);
      saveCurrentSessionId(initial.id);
      return [initial];
    }
    const list = JSON.parse(raw);
    if (!Array.isArray(list) || list.length === 0) {
      const initial = createNewSession();
      saveSessions([initial]);
      saveCurrentSessionId(initial.id);
      return [initial];
    }
    // Guarantee loaded history messages never remain in an active thinking/spinning state
    const mapped = list.map((session) => {
      let title = session?.title;
      if (
        (!title || title === '新对话' || title === 'New Chat') &&
        Array.isArray(session?.messages) &&
        session.messages.length > 0
      ) {
        title = deriveSessionTitleFromMessages(session.messages, title || '新对话');
      }
      return {
        ...session,
        title: title || '新对话',
        enableThinking: session?.enableThinking ?? false,
        enableWikiSearch: session?.enableWikiSearch ?? false,
        messages: Array.isArray(session?.messages)
          ? session.messages.map((m: any) => ({
              ...m,
              isThinking: false,
            }))
          : [],
      };
    });

    const hasLegacyImages = mapped.some((s) =>
      s.messages?.some((m: ChatMessage) => m.images?.some((img: string) => img.startsWith('data:')))
    );
    if (hasLegacyImages) {
      scheduleLegacyImageMigration(mapped);
    }

    return mapped;
  } catch (e) {
    console.error('Failed to load sessions:', e);
    const initial = createNewSession();
    saveSessions([initial]);
    saveCurrentSessionId(initial.id);
    return [initial];
  }
}

/**
 * Asynchronously migrates legacy inline Data URLs to the local media store
 */
let migrationScheduled = false;
export function scheduleLegacyImageMigration(sessions: ChatSession[]): void {
  if (migrationScheduled) return;
  migrationScheduled = true;
  setTimeout(async () => {
    let hasChanges = false;
    for (const session of sessions) {
      if (!session.messages) continue;
      for (const msg of session.messages) {
        if (!msg.images || msg.images.length === 0) continue;
        for (let i = 0; i < msg.images.length; i++) {
          const img = msg.images[i];
          if (img.startsWith('data:')) {
            try {
              const url = await uploadDataUrl(img);
              if (url && url !== img) {
                msg.images[i] = url;
                hasChanges = true;
              }
            } catch (err) {
              // ignore
            }
          }
        }
      }
    }
    if (hasChanges) {
      console.log('[storage] Migrated legacy data URLs to local media store');
      saveSessions(sessions);
    }
    migrationScheduled = false;
  }, 1000);
}

/**
 * Asynchronously persist all image Data URLs to IndexedDB for permanent durability
 */
function persistImagesToIndexedDB(sessions: ChatSession[]): void {
  for (const session of sessions) {
    if (!session.messages) continue;
    for (const msg of session.messages) {
      if (!msg.images || msg.images.length === 0) continue;
      msg.images.forEach((imgUrl, idx) => {
        if (imgUrl.startsWith('data:')) {
          const key = `img_${session.id}_${msg.id}_${idx}`;
          saveImageToDB(key, imgUrl).catch(() => {});
        }
      });
    }
  }
}

function offloadOlderImagesForStorage(sessions: ChatSession[], updatedSessionId?: string): ChatSession[] {
  return sessions.map((session) => {
    const isTarget = updatedSessionId ? session.id === updatedSessionId : false;
    return {
      ...session,
      messages: session.messages.map((m, msgIdx) => {
        if (!m.images || m.images.length === 0) return m;
        // Keep actual images for the most recent message in the active session
        if (isTarget && msgIdx >= session.messages.length - 2) {
          return m;
        }
        return {
          ...m,
          images: m.images.map((img, idx) =>
            img.startsWith('data:') ? `__idb__:img_${session.id}_${m.id}_${idx}` : img
          ),
        };
      }),
    };
  });
}

function stripAllImagesForStorage(sessions: ChatSession[]): ChatSession[] {
  return sessions.map((session) => ({
    ...session,
    messages: session.messages.map((m) => {
      if (!m.images || m.images.length === 0) return m;
      return {
        ...m,
        images: m.images.map((img, idx) =>
          img.startsWith('data:') ? `__idb__:img_${session.id}_${m.id}_${idx}` : img
        ),
      };
    }),
  }));
}

export async function hydrateSessionImages(session: ChatSession): Promise<boolean> {
  let changed = false;
  if (!session.messages) return false;
  const keysToFetch: { msgIdx: number; imgIdx: number; key: string }[] = [];
  session.messages.forEach((m, msgIdx) => {
    if (!m.images) return;
    m.images.forEach((img, imgIdx) => {
      if (img.startsWith('__idb__:')) {
        keysToFetch.push({ msgIdx, imgIdx, key: img.slice(8) });
      }
    });
  });
  if (keysToFetch.length === 0) return false;
  const dbImages = await getImagesFromDB(keysToFetch.map((k) => k.key));
  for (const item of keysToFetch) {
    const dataUrl = dbImages[item.key];
    if (dataUrl && session.messages[item.msgIdx]?.images) {
      session.messages[item.msgIdx].images![item.imgIdx] = dataUrl;
      changed = true;
    }
  }
  return changed;
}

export function saveSessions(sessions: ChatSession[], updatedSessionId?: string, source: string = 'UNKNOWN'): void {
  const safeSessions = sessions.length > 0 ? sessions : [createNewSession()];

  // 1. Durably backup all images in IndexedDB asynchronously
  persistImagesToIndexedDB(safeSessions);

  // 2. Direct save attempt to localStorage
  try {
    localStorage.setItem(SESSIONS_KEY, JSON.stringify(safeSessions));
    notifySessionUpdate(updatedSessionId, source);
    return;
  } catch (e) {
    console.warn('[storage] Direct localStorage save failed (quota exceeded), offloading older images...', e);
  }

  // 3. Fallback: offload older images to IndexedDB keys, preserving recent messages
  try {
    const stripped = offloadOlderImagesForStorage(safeSessions, updatedSessionId);
    localStorage.setItem(SESSIONS_KEY, JSON.stringify(stripped));
    notifySessionUpdate(updatedSessionId, source);
    return;
  } catch (e2) {
    console.warn('[storage] Secondary save failed, stripping all images from localStorage payload...', e2);
  }

  // 4. Ultimate fallback: strip all images to guarantee text sessions and titles are never lost
  try {
    const textOnly = stripAllImagesForStorage(safeSessions);
    localStorage.setItem(SESSIONS_KEY, JSON.stringify(textOnly));
    notifySessionUpdate(updatedSessionId, source);
  } catch (e3) {
    console.error('[storage] Fatal localStorage write error:', e3);
  }
}

/**
 * 跨窗口「请求中止本轮生成」。
 *
 * 为什么要走 localStorage 而不是 BroadcastChannel：主窗口与浮窗是**两个独立 WKWebView**，
 * BroadcastChannel 不一定跨实例投递（实测镜像能看到内容靠的是落盘 + storage 事件，
 * 不是 BroadcastChannel）。storage 事件在同源的其他浏览上下文里必定触发，因此用它传播中止请求。
 * 发起方与接收方是不同窗口，`storage` 事件不会在写入方自己触发，正好。
 */
const ABORT_KEY = 'tff_abort_request_v1';

export function requestAbort(sessionId: string): void {
  try {
    localStorage.setItem(ABORT_KEY, JSON.stringify({ sessionId, at: Date.now() }));
  } catch {
    // 写失败不影响
  }
}

export function readAbortRequest(): { sessionId: string; at: number } | null {
  try {
    const raw = localStorage.getItem(ABORT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed.sessionId === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * 清理「被中断的回合」残留的 pending 标记。
 *
 * 场景：生成中被退出 App / 强杀进程，`pending: true` 会随消息落盘；下次打开时
 * 没有任何窗口在生成，若不清掉，阶段阶梯会一直停在"展开 + 转圈"的假进行中状态。
 * 只在**App 启动时**（主窗口首次装载会话）调用一次 —— 生成中的会话不能清
 * （浮窗会在回合进行中反复 loadSessions 做持久化，那里清掉会把真实进行中的状态抹掉）。
 *
 * @returns 是否发生了修改（发生了就应回写 + 广播）
 */
export function clearStalePending(sessions: ChatSession[]): boolean {
  let changed = false;
  for (const s of sessions) {
    for (const m of s.messages) {
      if (m.pending || m.isThinking || m.stage) {
        m.pending = false;
        m.isThinking = false;
        delete m.stage;
        changed = true;
      }
    }
  }
  return changed;
}

export function loadCurrentSessionId(): string | null {
  return localStorage.getItem(CURRENT_ID_KEY);
}

export function saveCurrentSessionId(id: string | null): void {
  try {
    if (id) {
      localStorage.setItem(CURRENT_ID_KEY, id);
    } else {
      localStorage.removeItem(CURRENT_ID_KEY);
    }
    notifySessionUpdate(id || undefined);
  } catch (e) {
    console.error('Failed to save current session ID:', e);
  }
}

export function createNewSession(title?: string): ChatSession {
  let defaultTitle = '新对话';
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) {
      const s = JSON.parse(raw);
      if (s?.language === 'en') {
        defaultTitle = 'New Chat';
      } else if (s?.language === 'system') {
        if (typeof navigator !== 'undefined' && navigator.language && !navigator.language.toLowerCase().startsWith('zh')) {
          defaultTitle = 'New Chat';
        }
      }
    }
  } catch (e) {}

  return {
    id: 'session-' + Date.now() + '-' + Math.random().toString(36).substring(2, 7),
    title: title || defaultTitle,
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    contextUsed: 0,
    enableThinking: false,   // Default OFF
    enableWikiSearch: false, // Default OFF
  };
}

/**
 * 查找已存在的空会话，若无则新建一个空白会话。
 * 主窗口（新建对话）与 Spotlight 浮窗（初始化/刷新/点击新建）完全复用该逻辑：
 * 如果已经有空会话就不新建，直接切换过去。
 */
export function getOrCreateEmptySession(
  title?: string,
  source: string = 'UNKNOWN'
): { session: ChatSession; isNew: boolean; allSessions: ChatSession[] } {
  const allSessions = loadSessions();
  const existingEmpty = allSessions.find((s) => !s.messages || s.messages.length === 0);
  if (existingEmpty) {
    saveCurrentSessionId(existingEmpty.id);
    return { session: existingEmpty, isNew: false, allSessions };
  }
  const newSession = createNewSession(title);
  const nextSessions = [newSession, ...allSessions];
  saveSessions(nextSessions, newSession.id, source);
  saveCurrentSessionId(newSession.id);
  notifySessionUpdate(newSession.id, source);
  return { session: newSession, isNew: true, allSessions: nextSessions };
}

/**
 * 根据发送消息的文本与图片生成会话标题。
 * 规则：
 * 1. 取文字部分（换行转空格，截取前 24 字符）；
 * 2. 如果只有图片（文字为空但图片数量 > 0），标题为 '[picture]'；
 * 3. 否则回退为默认标题（如 '新对话' 或 'New Chat'）。
 */
export function generateSessionTitle(
  text: string,
  hasImages: boolean = false,
  fallbackTitle: string = '新对话'
): string {
  const singleLineText = (text || '').replace(/\r?\n/g, ' ').trim();
  if (singleLineText) {
    return singleLineText.slice(0, 24);
  }
  if (hasImages) {
    return '[picture]';
  }
  return fallbackTitle;
}

/**
 * 从消息列表中提取首条用户消息并生成会话标题。
 */
export function deriveSessionTitleFromMessages(
  messages: ChatMessage[],
  fallbackTitle: string = '新对话'
): string {
  if (!Array.isArray(messages)) return fallbackTitle;
  const firstUser = messages.find((m) => m.role === 'user');
  if (!firstUser) return fallbackTitle;
  const hasImages = Array.isArray(firstUser.images) && firstUser.images.length > 0;
  return generateSessionTitle(firstUser.content, hasImages, fallbackTitle);
}


