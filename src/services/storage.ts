import { ChatSession, AppSettings } from '../types/chat';

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
    return list.map((session) => ({
      ...session,
      enableThinking: session?.enableThinking ?? false,
      enableWikiSearch: session?.enableWikiSearch ?? false,
      messages: Array.isArray(session?.messages)
        ? session.messages.map((m: any) => ({
            ...m,
            isThinking: false,
          }))
        : [],
    }));
  } catch (e) {
    console.error('Failed to load sessions:', e);
    const initial = createNewSession();
    saveSessions([initial]);
    saveCurrentSessionId(initial.id);
    return [initial];
  }
}

export function saveSessions(sessions: ChatSession[]): void {
  try {
    const safeSessions = sessions.length > 0 ? sessions : [createNewSession()];
    localStorage.setItem(SESSIONS_KEY, JSON.stringify(safeSessions));
    notifySessionUpdate();
  } catch (e) {
    console.error('Failed to save sessions:', e);
  }
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

export function createNewSession(title = '新对话'): ChatSession {
  return {
    id: 'session-' + Date.now() + '-' + Math.random().toString(36).substring(2, 7),
    title,
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    contextUsed: 0,
    enableThinking: false,   // Default OFF
    enableWikiSearch: false, // Default OFF
  };
}
