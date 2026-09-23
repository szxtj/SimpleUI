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

export const DEFAULT_SETTINGS: AppSettings = {
  apiPort: 1235,
  apiBaseUrl: '',
  modelId: 'gemma-4-26b-a4b-it',
  maxContext: 16384, // 16K default
  enableThinking: true,
  reasoningEffort: 'high',
  temperature: 1.0, // Gemma 4 26B-A4B official recommended default
  topP: 0.95,
  topK: 64,
  repetitionPenalty: 1.0,
  maxTokens: 8192, // Linked: half of maxContext (16384 / 2)
  stopStrings: [],
  systemPrompt: 'You are a helpful assistant.', // Google Gemma official canonical prompt
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
      apiPort: settings?.apiPort || 1235,
      maxContext,
      maxTokens: Math.floor(maxContext / 2),
      stopStrings: Array.isArray(settings?.stopStrings) ? settings.stopStrings : [],
    };
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(sanitized));
  } catch (e) {
    console.error('Failed to save settings:', e);
  }
}

export function loadSessions(): ChatSession[] {
  try {
    const raw = localStorage.getItem(SESSIONS_KEY);
    if (!raw) return [];
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) return [];
    // Guarantee loaded history messages never remain in an active thinking/spinning state
    return list.map((session) => ({
      ...session,
      messages: Array.isArray(session?.messages)
        ? session.messages.map((m: any) => ({
            ...m,
            isThinking: false,
          }))
        : [],
    }));
  } catch (e) {
    console.error('Failed to load sessions:', e);
    return [];
  }
}

export function saveSessions(sessions: ChatSession[]): void {
  try {
    localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions));
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
  };
}
