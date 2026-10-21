import fs from 'fs';
import path from 'path';
import os from 'os';
import http from 'http';
import https from 'https';
import { performance } from 'perf_hooks';
import { wikiService, onRagStageChange } from './wiki_service.js';
import { lookupRequest, noteForwardedRequest, noteChatForward } from './ttf_log.js';
import { ttfService } from './ttf_service.js';
import { mediaService } from './media_service.js';

const HOME = os.homedir();
const DATA_DIR =
  process.env.SIMPLEUI_DATA_DIR ||
  path.join(HOME, 'Library', 'Application Support', 'SimpleUI');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

const RECORDABLE_RAG_STAGES = ['planning', 'resolving', 'sense', 'fetching', 'routing'];

try {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
} catch (err) {
  console.error('[SessionService] Failed to create data directory:', err);
}

// ============================================================================
// Token Estimation & Sliding Window Helpers (ported from token.ts & chatTurn.ts)
// ============================================================================

export function estimateTextTokens(text, provider = 'local') {
  if (!text || typeof text !== 'string') return 0;
  const trimmed = text.trim();
  if (!trimmed) return 0;

  const cjkMatches = trimmed.match(/[\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af]/g);
  const cjkCount = cjkMatches ? cjkMatches.length : 0;
  const nonCjkLength = trimmed.length - cjkCount;

  if (provider === 'deepseek') {
    const cjkTokens = Math.ceil(cjkCount * 0.6);
    const nonCjkTokens = Math.ceil(nonCjkLength / 3.5);
    return Math.max(1, cjkTokens + nonCjkTokens);
  } else if (provider === 'mference') {
    const cjkTokens = Math.ceil(cjkCount * 0.62);
    const nonCjkTokens = Math.ceil(nonCjkLength / 3.6);
    return Math.max(1, cjkTokens + nonCjkTokens);
  } else {
    const cjkTokens = Math.ceil(cjkCount * 0.75);
    const nonCjkTokens = Math.ceil(nonCjkLength / 3.8);
    return Math.max(1, cjkTokens + nonCjkTokens);
  }
}

export function estimateHistoryTokens(messages, systemPrompt = '', provider = 'local') {
  let total = 0;
  if (systemPrompt && typeof systemPrompt === 'string' && systemPrompt.trim()) {
    total += estimateTextTokens(systemPrompt.trim(), provider) + 4;
  }
  if (!messages || !Array.isArray(messages)) return total;

  for (const msg of messages) {
    if (!msg) continue;
    if (msg.role === 'user' || msg.role === 'assistant') {
      const text = msg.content || '';
      total += estimateTextTokens(text, provider) + 4;
      if (Array.isArray(msg.images) && msg.images.length > 0) {
        const perImageTokens = provider === 'deepseek' ? 1400 : 576;
        total += msg.images.length * perImageTokens;
      }
    }
  }
  return total;
}

export function buildGroundingPrompt(promptContext, question, lang = 'zh') {
  if (lang === 'en') {
    return `[Encyclopedia Context]
Below are one or more encyclopedia articles (Infobox, lead section and relevant body sections) retrieved from an offline knowledge base for the user's question.

${promptContext}

[How to answer]
1. [Relevance filtering]: The context may contain material that is not related to the question (e.g. infobox fields, section headings, list entries). Locate the parts that actually answer the question and ignore the rest.
2. [Fact grounding]: Treat the facts, dates, people and numbers found there as your factual anchor. Combine them with your own knowledge when they are partial.
3. [Reproduce when asked]: If the user asks you to enumerate or list something (e.g. all works, all awards), reproduce the corresponding list from the context faithfully — do not shorten or omit items.
4. [Cite]: Mention which encyclopedia article(s) you used.

[User Question]
${question}`;
  }

  return `[百科原文参考]
以下是从离线知识库中检索到的与用户问题相关的百科条目内容（含基本档案、引言与相关小节）。

${promptContext}

[回答指引]
1. 【自行筛选】：上述原文中可能包含与问题无关的内容（例如档案中用不到的属性、其他小节、列表中的无关条目）。请自行定位其中真正与问题相关的部分，忽略其余。
2. 【事实锚定】：将其中出现的事实、时间、人物与数据作为真实性基石；若信息不完整，可结合你自身的知识补充展开。
3. 【按需照抄】：若用户要求列举类内容（例如"列出所有作品/所有奖项"），请忠实照抄原文中的对应列表，不要擅自删减或概括。
4. 【注明出处】：回答中请说明引用了哪篇百科条目。

[用户问题]
${question}`;
}

export function generateSessionTitle(text, hasImages = false, fallbackTitle = '新对话') {
  const singleLineText = (text || '').replace(/\r?\n/g, ' ').trim();
  if (singleLineText) {
    return singleLineText.slice(0, 24);
  }
  if (hasImages) {
    return '[picture]';
  }
  return fallbackTitle;
}

export function deriveSessionTitleFromMessages(messages, fallbackTitle = '新对话') {
  if (!Array.isArray(messages)) return fallbackTitle;
  const firstUser = messages.find((m) => m && m.role === 'user');
  if (!firstUser) return fallbackTitle;
  const hasImages = Array.isArray(firstUser.images) && firstUser.images.length > 0;
  return generateSessionTitle(firstUser.content, hasImages, fallbackTitle);
}

// ============================================================================
// SessionService: Single Source of Truth for Sessions & Streaming Turns
// ============================================================================

class SessionService {
  constructor() {
    this.sessions = [];
    this.mainSessionId = null;
    this.settings = null;
    this.calibrationFactors = {
      ttf: 1.0,
      mference: 1.0,
      custom: 1.0,
      local: 1.0,
      deepseek: 1.0,
    };

    /** @type {Map<string, { sessionId: string, messageId: string, abortController: AbortController, liveTokens: number }>} */
    this.activeTurns = new Map();
    /** @type {Set<http.ServerResponse>} */
    this.sseClients = new Set();

    this.saveTimer = null;
    this.lastSaveTime = 0;

    // Bind authoritative session reference provider to MediaService before loading
    mediaService.setReferenceProvider(() => this.getReferencedMediaFilenames());

    this.loadSettingsFromDisk();
    this.loadFromDisk();

    // Keep SSE connections alive across WKWebView instances
    this.heartbeatTimer = setInterval(() => {
      for (const client of this.sseClients) {
        try {
          client.write(': ping\n\n');
        } catch {
          this.sseClients.delete(client);
        }
      }
    }, 15000);
  }

  applyTokenCalibration(tokens, provider = 'local') {
    const factor = this.calibrationFactors[provider] || this.calibrationFactors.local || 1.0;
    return Math.max(0, Math.round(tokens * factor));
  }

  setTokenCalibration(realTokens, rawEstimatedTokens, provider = 'local') {
    if (!(realTokens > 0) || !(rawEstimatedTokens > 0)) return;
    const ratio = realTokens / rawEstimatedTokens;
    const clamped = Math.min(2.5, Math.max(0.5, ratio));
    this.calibrationFactors[provider] = clamped;
    if (provider === 'ttf' || provider === 'mference') {
      this.calibrationFactors.local = clamped;
    }
  }

  buildWireMessages(historyMessages, userMessage, promptToSend, opts = {}) {
    const currentTurnUser = { ...userMessage, content: promptToSend };
    if (!opts.maxContext) {
      return [...historyMessages, currentTurnUser];
    }

    const { systemPrompt = '', maxContext, maxTokens = 8192, provider = 'local' } = opts;
    const availablePromptBudget = Math.max(1024, maxContext - maxTokens);
    const triggerThreshold = Math.floor(availablePromptBudget * 0.85);
    const targetThreshold = Math.floor(availablePromptBudget * 0.70);

    let candidateHistory = [...historyMessages];
    let fullCandidate = [...candidateHistory, currentTurnUser];
    let currentTokens = this.applyTokenCalibration(
      estimateHistoryTokens(fullCandidate, systemPrompt, provider),
      provider
    );

    if (currentTokens <= triggerThreshold) {
      return fullCandidate;
    }

    while (candidateHistory.length >= 2 && currentTokens > targetThreshold) {
      const removeCount =
        candidateHistory[0]?.role === 'user' && candidateHistory[1]?.role === 'assistant' ? 2 : 1;
      candidateHistory = candidateHistory.slice(removeCount);
      fullCandidate = [...candidateHistory, currentTurnUser];
      currentTokens = this.applyTokenCalibration(
        estimateHistoryTokens(fullCandidate, systemPrompt, provider),
        provider
      );
    }

    return fullCandidate;
  }

  createNewSessionObject(title = '新对话') {
    const now = Date.now();
    return {
      id: 'session-' + now + '-' + Math.random().toString(36).substring(2, 7),
      title: title || '新对话',
      messages: [],
      createdAt: now,
      updatedAt: now,
      contextUsed: 0,
      enableThinking: false,
      enableWikiSearch: false,
    };
  }

  /**
   * Recency used to order the sidebar list: the timestamp of the last message.
   * Metadata-only changes (rename / per-session toggles / deleting a turn) must not
   * move a chat, so empty sessions fall back to their creation time.
   */
  getSessionRecency(session) {
    const messages = Array.isArray(session?.messages) ? session.messages : [];
    const last = messages.length > 0 ? messages[messages.length - 1] : null;
    return (
      (last && typeof last.timestamp === 'number' ? last.timestamp : 0) ||
      session?.createdAt ||
      session?.updatedAt ||
      0
    );
  }

  /**
   * Moves a session to the head of the list. The sidebar renders `this.sessions`
   * in array order, so every write that makes a chat "newer" must update it.
   */
  promoteSessionToFront(sessionId) {
    const idx = this.sessions.findIndex((s) => s.id === sessionId);
    if (idx <= 0) return;
    const [session] = this.sessions.splice(idx, 1);
    this.sessions.unshift(session);
  }

  /**
   * Cleans up any stale pending/thinking flags from interrupted runs on startup
   */
  sanitizeLoadedSessions(list) {
    if (!Array.isArray(list)) return [];
    return list.map((session) => {
      let title = session?.title;
      if (
        (!title || title === '新对话' || title === 'New Chat') &&
        Array.isArray(session?.messages) &&
        session.messages.length > 0
      ) {
        title = deriveSessionTitleFromMessages(session.messages, title || '新对话');
      }
      const messages = Array.isArray(session?.messages)
        ? session.messages.map((m) => {
            const cleanStages = Array.isArray(m?.stages)
              ? m.stages.map((st) =>
                  st.endedAt === undefined
                    ? {
                        ...st,
                        endedAt: st.startedAt + (st.durationMs || 0),
                        durationMs: st.durationMs || 0,
                      }
                    : st
                )
              : undefined;
            const nextMsg = {
              ...m,
              isThinking: false,
              pending: false,
              ...(cleanStages ? { stages: cleanStages } : {}),
            };
            delete nextMsg.stage;
            return nextMsg;
          })
        : [];

      return {
        ...session,
        id: session?.id || ('session-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7)),
        title: title || '新对话',
        createdAt: session?.createdAt || Date.now(),
        updatedAt: session?.updatedAt || Date.now(),
        contextUsed: session?.contextUsed || 0,
        enableThinking: session?.enableThinking ?? false,
        enableWikiSearch: session?.enableWikiSearch ?? false,
        messages,
      };
    });
  }

  /**
   * Converts any inline data:image/... URLs into content-addressed files in mediaService
   * so sessions.json is not bloated with huge base64 strings.
   * Never removes or alters user image references.
   */
  normalizeSessionImages(sessions) {
    if (!Array.isArray(sessions)) return;
    for (const s of sessions) {
      if (!Array.isArray(s.messages)) continue;
      for (const m of s.messages) {
        if (!Array.isArray(m.images) || m.images.length === 0) continue;
        const normalized = [];
        for (const rawImg of m.images) {
          if (!rawImg || typeof rawImg !== 'string') continue;
          const persisted = this.persistDataUrlIfNeeded(rawImg);
          normalized.push(persisted || rawImg);
        }
        m.images = normalized;
      }
    }
  }

  persistDataUrlIfNeeded(imgStr) {
    if (!imgStr || typeof imgStr !== 'string' || !imgStr.startsWith('data:')) {
      return imgStr;
    }
    try {
      const match = imgStr.match(/^data:([^;]+);base64,(.+)$/);
      if (!match) return imgStr;
      const mime = match[1].toLowerCase();
      const buf = Buffer.from(match[2], 'base64');
      if (!buf || buf.length === 0) return imgStr;
      const saved = mediaService.saveBuffer(buf, mime);
      return saved.url;
    } catch (e) {
      console.warn('[SessionService] Failed to offload inline data URL to media store:', e);
      return imgStr;
    }
  }

  loadSettingsFromDisk() {
    if (!fs.existsSync(SETTINGS_FILE)) {
      this.settings = null;
      return;
    }
    try {
      const raw = fs.readFileSync(SETTINGS_FILE, 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        this.settings = parsed;
      }
    } catch (err) {
      console.error('[SessionService] Failed to read settings.json:', err);
      this.settings = null;
    }
  }

  saveSettingsToDisk(nextSettings) {
    if (!nextSettings || typeof nextSettings !== 'object') return null;
    this.settings = {
      ...(this.settings || {}),
      ...nextSettings,
    };
    try {
      const tmpFile = `${SETTINGS_FILE}.tmp`;
      fs.writeFileSync(tmpFile, JSON.stringify(this.settings, null, 2), 'utf-8');
      fs.renameSync(tmpFile, SETTINGS_FILE);
    } catch (err) {
      console.error('[SessionService] Failed to write settings.json:', err);
    }
    this.broadcast('settings-updated', { settings: this.settings });
    return this.settings;
  }

  loadFromDisk() {
    if (!fs.existsSync(SESSIONS_FILE)) {
      const initial = this.createNewSessionObject('新对话');
      this.sessions = [initial];
      this.mainSessionId = initial.id;
      return;
    }

    try {
      const raw = fs.readFileSync(SESSIONS_FILE, 'utf-8');
      const parsed = JSON.parse(raw);
      const rawList = Array.isArray(parsed) ? parsed : (parsed?.sessions || []);
      const sanitized = this.sanitizeLoadedSessions(rawList);
      this.normalizeSessionImages(sanitized);
      // Normalize the order once on load: older builds left a chat in its old slot
      // when it received new messages, so the persisted array may be out of recency order.
      sanitized.sort((a, b) => this.getSessionRecency(b) - this.getSessionRecency(a));

      if (sanitized.length === 0) {
        const initial = this.createNewSessionObject('新对话');
        this.sessions = [initial];
        this.mainSessionId = initial.id;
      } else {
        this.sessions = sanitized;
        const savedMainId = parsed?.mainSessionId;
        this.mainSessionId =
          savedMainId && this.sessions.some((s) => s.id === savedMainId)
            ? savedMainId
            : this.sessions[0].id;
      }

      if (parsed?.calibrationFactors && typeof parsed.calibrationFactors === 'object') {
        this.calibrationFactors = {
          ...this.calibrationFactors,
          ...parsed.calibrationFactors,
        };
      }
      this.flushSync();
    } catch (err) {
      console.error('[SessionService] Corrupt sessions.json, backing up and starting clean:', err);
      try {
        const backupPath = path.join(DATA_DIR, `sessions.corrupt-${Date.now()}.json`);
        fs.copyFileSync(SESSIONS_FILE, backupPath);
      } catch {
        // ignore backup error
      }
      const initial = this.createNewSessionObject('新对话');
      this.sessions = [initial];
      this.mainSessionId = initial.id;
    }
  }

  scheduleSave() {
    const now = Date.now();
    if (now - this.lastSaveTime >= 350) {
      this.flushSync();
      return;
    }
    if (!this.saveTimer) {
      this.saveTimer = setTimeout(() => {
        this.saveTimer = null;
        this.flushSync();
      }, 350);
    }
  }

  flushSync() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.lastSaveTime = Date.now();
    try {
      if (this.sessions.length === 0) {
        const fresh = this.createNewSessionObject('新对话');
        this.sessions = [fresh];
        this.mainSessionId = fresh.id;
      }
      if (!this.mainSessionId || !this.sessions.some((s) => s.id === this.mainSessionId)) {
        this.mainSessionId = this.sessions[0].id;
      }
      const payload = {
        version: 2,
        mainSessionId: this.mainSessionId,
        calibrationFactors: this.calibrationFactors,
        sessions: this.sessions,
      };
      const tmpFile = `${SESSIONS_FILE}.tmp`;
      fs.writeFileSync(tmpFile, JSON.stringify(payload), 'utf-8');
      fs.renameSync(tmpFile, SESSIONS_FILE);
    } catch (err) {
      console.error('[SessionService] Failed to write sessions.json:', err);
    }
  }

  getSnapshotPayload() {
    const generatingSessionIds = Array.from(this.activeTurns.keys());
    const liveStreamingTokens = {};
    for (const [sid, turn] of this.activeTurns.entries()) {
      if (typeof turn.liveTokens === 'number') {
        liveStreamingTokens[sid] = turn.liveTokens;
      }
    }
    return {
      sessions: this.sessions,
      mainSessionId: this.mainSessionId,
      generatingSessionIds,
      liveStreamingTokens,
      calibrationFactors: this.calibrationFactors,
      settings: this.settings,
    };
  }

  broadcast(event, data) {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of this.sseClients) {
      try {
        client.write(msg);
      } catch {
        this.sseClients.delete(client);
      }
    }
  }

  /**
   * Returns the authoritative set of all media filenames currently referenced across all sessions.
   */
  getReferencedMediaFilenames() {
    const referenced = new Set();
    for (const s of this.sessions) {
      if (!Array.isArray(s.messages)) continue;
      for (const m of s.messages) {
        if (!Array.isArray(m.images)) continue;
        for (const imgUrl of m.images) {
          const fname = mediaService.extractFilename(imgUrl);
          if (fname) referenced.add(fname);
        }
      }
    }
    return referenced;
  }

  /**
   * Deletes media files on disk that are no longer referenced by any remaining session
   */
  cleanupUnreferencedMedia(candidateUrls) {
    if (!Array.isArray(candidateUrls) || candidateUrls.length === 0) return;
    mediaService.deleteUnreferencedFiles(candidateUrls);
  }

  // ==========================================================================
  // Session CRUD & Window Focus Operations
  // ==========================================================================

  getOrCreateEmptySession(title = '新对话', origin = 'MAIN') {
    const existingEmpty = this.sessions.find(
      (s) => (!s.messages || s.messages.length === 0) && !this.activeTurns.has(s.id)
    );
    if (existingEmpty) {
      if (origin === 'MAIN') {
        this.mainSessionId = existingEmpty.id;
        this.flushSync();
        this.broadcast('main-session-changed', { mainSessionId: this.mainSessionId });
      }
      return { session: existingEmpty, isNew: false };
    }

    const newSession = this.createNewSessionObject(title);
    this.sessions.unshift(newSession);
    if (origin === 'MAIN' || !this.mainSessionId) {
      this.mainSessionId = newSession.id;
    }
    this.flushSync();
    this.broadcast('session-upserted', {
      session: newSession,
      mainSessionId: this.mainSessionId,
      selectInMain: origin === 'MAIN',
    });
    return { session: newSession, isNew: true };
  }

  updateSessionMeta(sessionId, patch = {}) {
    const idx = this.sessions.findIndex((s) => s.id === sessionId);
    if (idx === -1) return null;
    const cur = this.sessions[idx];
    const updated = {
      ...cur,
      ...(patch.title !== undefined ? { title: String(patch.title) } : {}),
      ...(patch.enableThinking !== undefined ? { enableThinking: Boolean(patch.enableThinking) } : {}),
      ...(patch.enableWikiSearch !== undefined ? { enableWikiSearch: Boolean(patch.enableWikiSearch) } : {}),
      updatedAt: Date.now(),
    };
    this.sessions[idx] = updated;
    this.flushSync();
    this.broadcast('session-upserted', {
      session: updated,
      mainSessionId: this.mainSessionId,
      selectInMain: false,
    });
    return updated;
  }

  deleteSession(sessionId, defaultTitle = '新对话') {
    if (this.activeTurns.has(sessionId)) {
      this.abortTurn(sessionId);
    }
    const target = this.sessions.find((s) => s.id === sessionId);
    if (!target) return this.getSnapshotPayload();

    // Refuse deleting the last remaining blank session
    if (this.sessions.length <= 1 && (!target.messages || target.messages.length === 0)) {
      return this.getSnapshotPayload();
    }

    const deletedImages = [];
    target.messages?.forEach((m) => {
      if (Array.isArray(m.images)) deletedImages.push(...m.images);
    });

    this.sessions = this.sessions.filter((s) => s.id !== sessionId);
    if (this.sessions.length === 0) {
      const fresh = this.createNewSessionObject(defaultTitle);
      this.sessions = [fresh];
      this.mainSessionId = fresh.id;
    } else if (this.mainSessionId === sessionId) {
      this.mainSessionId = this.sessions[0].id;
    }

    this.flushSync();
    this.cleanupUnreferencedMedia(deletedImages);
    this.broadcast('session-deleted', {
      sessionId,
      sessions: this.sessions,
      mainSessionId: this.mainSessionId,
    });
    return this.getSnapshotPayload();
  }

  deleteTurn(sessionId, assistantMessageId) {
    const sIdx = this.sessions.findIndex(
      (s) => s.id === sessionId || s.messages?.some((m) => m.id === assistantMessageId)
    );
    if (sIdx === -1) return null;
    const session = this.sessions[sIdx];

    const active = this.activeTurns.get(session.id);
    if (active && active.messageId === assistantMessageId) {
      this.abortTurn(session.id);
    }

    const asstIdx = session.messages.findIndex((m) => m.id === assistantMessageId);
    if (asstIdx === -1) return session;

    let userIdx = -1;
    for (let i = asstIdx - 1; i >= 0; i--) {
      if (session.messages[i].role === 'user') {
        userIdx = i;
        break;
      }
    }

    const idsToDelete = new Set([assistantMessageId]);
    const deletedImages = [];
    if (userIdx !== -1) {
      idsToDelete.add(session.messages[userIdx].id);
      if (Array.isArray(session.messages[userIdx].images)) {
        deletedImages.push(...session.messages[userIdx].images);
      }
    }

    const updatedSession = {
      ...session,
      messages: session.messages.filter((m) => !idsToDelete.has(m.id)),
      updatedAt: Date.now(),
    };
    this.sessions[sIdx] = updatedSession;
    this.flushSync();
    this.cleanupUnreferencedMedia(deletedImages);
    this.broadcast('session-upserted', {
      session: updatedSession,
      mainSessionId: this.mainSessionId,
      selectInMain: false,
    });
    return updatedSession;
  }

  // ==========================================================================
  // Turn Streaming & RAG Orchestration
  // ==========================================================================

  abortTurn(sessionId) {
    const active = this.activeTurns.get(sessionId);
    if (active) {
      try {
        active.abortController.abort();
      } catch {
        // ignore
      }
      this.activeTurns.delete(sessionId);
    }

    const sIdx = this.sessions.findIndex((s) => s.id === sessionId);
    if (sIdx >= 0) {
      const now = Date.now();
      const s = this.sessions[sIdx];
      const updatedMsgs = s.messages.map((m) => {
        if (m.pending || m.isThinking || m.stage) {
          const closedStages = Array.isArray(m.stages)
            ? m.stages.map((st) =>
                st.endedAt === undefined
                  ? { ...st, endedAt: now, durationMs: Math.max(0, now - st.startedAt) }
                  : st
              )
            : m.stages;
          const next = {
            ...m,
            pending: false,
            isThinking: false,
            ...(closedStages ? { stages: closedStages } : {}),
          };
          delete next.stage;
          return next;
        }
        return m;
      });
      const updatedSession = {
        ...s,
        messages: updatedMsgs,
        updatedAt: now,
      };
      this.sessions[sIdx] = updatedSession;
      this.flushSync();
      this.broadcast('turn-aborted', {
        sessionId,
        messageId: active?.messageId,
        session: updatedSession,
      });
    } else {
      this.broadcast('turn-aborted', { sessionId });
    }
  }

  async startTurn({ sessionId, text, images = [], settings = {}, lang = 'zh', origin = 'MAIN', retryAssistantMessageId = null }) {
    let targetSession = this.sessions.find((s) => s.id === sessionId);

    if (!targetSession) {
      const empty = this.getOrCreateEmptySession(lang === 'en' ? 'New Chat' : '新对话', origin);
      targetSession = empty.session;
      sessionId = targetSession.id;
    }

    // If this session already has an active turn running, abort it first
    if (this.activeTurns.has(sessionId)) {
      this.abortTurn(sessionId);
      targetSession = this.sessions.find((s) => s.id === sessionId) || targetSession;
    }

    let historyMessages = Array.isArray(targetSession.messages) ? [...targetSession.messages] : [];
    let textToSend = (text || '').trim();
    let currentImages = Array.isArray(images)
      ? images.map((img) => this.persistDataUrlIfNeeded(img)).filter(Boolean)
      : [];

    // Handle Retry: slice history before the user message of the target assistant turn
    if (retryAssistantMessageId) {
      const asstIdx = historyMessages.findIndex((m) => m.id === retryAssistantMessageId);
      if (asstIdx !== -1) {
        let userIdx = -1;
        for (let i = asstIdx - 1; i >= 0; i--) {
          if (historyMessages[i].role === 'user') {
            userIdx = i;
            break;
          }
        }
        if (userIdx !== -1) {
          const origUser = historyMessages[userIdx];
          textToSend = origUser.content || '';
          currentImages = Array.isArray(origUser.images) ? [...origUser.images] : [];
          historyMessages = historyMessages.slice(0, userIdx);
        }
      } else if (historyMessages.length > 0 && historyMessages[historyMessages.length - 1].role === 'user') {
        const origUser = historyMessages[historyMessages.length - 1];
        textToSend = origUser.content || '';
        currentImages = Array.isArray(origUser.images) ? [...origUser.images] : [];
        historyMessages = historyMessages.slice(0, -1);
      }
    }

    if (!textToSend && currentImages.length === 0) {
      return { error: 'Empty message' };
    }

    const isDeepSeek = settings.apiProvider === 'deepseek';
    const sessionEnableThinking = targetSession.enableThinking ?? settings.enableThinking ?? false;
    const sessionEnableWiki = isDeepSeek ? false : (targetSession.enableWikiSearch ?? settings.enableWikiSearch ?? false);
    const shouldRunWiki =
      !isDeepSeek &&
      wikiService.enabled &&
      sessionEnableWiki &&
      wikiService.isOnline &&
      Boolean(textToSend);

    const now = Date.now();
    const userMessage = {
      id: 'msg-user-' + now,
      role: 'user',
      content: textToSend,
      images: currentImages.length > 0 ? currentImages : undefined,
      timestamp: now,
    };

    const assistantMessageId = 'msg-asst-' + (now + 1);
    const initialStages = shouldRunWiki
      ? [{ kind: 'planning', startedAt: now }]
      : [{ kind: 'prefill', startedAt: now }];
    const assistantMessage = {
      id: assistantMessageId,
      role: 'assistant',
      content: '',
      reasoningContent: '',
      isThinking: false,
      pending: true,
      stage: shouldRunWiki ? 'rag' : 'prefill',
      prefillStartedAt: shouldRunWiki ? undefined : now,
      stages: initialStages,
      timestamp: now + 1,
    };

    const isFirstUserMessage = historyMessages.length === 0;
    const defaultTitle = lang === 'en' ? 'New Chat' : '新对话';
    const computedTitle = generateSessionTitle(textToSend, currentImages.length > 0, defaultTitle);
    const sessionTitle = isFirstUserMessage
      ? computedTitle
      : (!targetSession.title || targetSession.title === '新对话' || targetSession.title === 'New Chat')
      ? (historyMessages.length > 0 ? deriveSessionTitleFromMessages(historyMessages, defaultTitle) : computedTitle)
      : targetSession.title;

    const updatedMessages = [...historyMessages, userMessage, assistantMessage];
    const updatedSession = {
      ...targetSession,
      title: sessionTitle,
      messages: updatedMessages,
      updatedAt: now,
    };

    const sIdx = this.sessions.findIndex((s) => s.id === sessionId);
    if (sIdx >= 0) {
      this.sessions[sIdx] = updatedSession;
    } else {
      this.sessions.unshift(updatedSession);
    }
    // A chat that receives a new message is now the most recent one and leads the list.
    this.promoteSessionToFront(sessionId);

    // Send requests from Spotlight must NEVER hijack the session the Main Window is viewing.
    // Only mirror the new turn into Main when Main is already showing this very session
    // (e.g. Main -> Spotlight handoff on the same chat); otherwise the Main Window keeps
    // its current pointer untouched. Use the explicit "Open in Main" handoff to switch it.
    const selectInMain = this.mainSessionId === sessionId;

    const abortController = new AbortController();
    const rawInitialEstimate = estimateHistoryTokens(
      updatedMessages,
      settings.systemPrompt,
      settings.apiProvider
    );
    const calibratedInitialTokens = this.applyTokenCalibration(rawInitialEstimate, settings.apiProvider);

    this.activeTurns.set(sessionId, {
      sessionId,
      messageId: assistantMessageId,
      abortController,
      liveTokens: calibratedInitialTokens,
    });

    this.flushSync();
    this.broadcast('session-upserted', {
      session: updatedSession,
      mainSessionId: this.mainSessionId,
      selectInMain,
      moveToTop: true,
    });
    this.broadcast('turn-progress', {
      sessionId,
      liveTokens: calibratedInitialTokens,
    });

    // Execute RAG + LLM Streaming asynchronously in background
    this.executeTurnPipeline({
      sessionId,
      assistantMessageId,
      historyMessages,
      userMessage,
      textToSend,
      settings: {
        ...settings,
        enableThinking: sessionEnableThinking,
        enableWikiSearch: sessionEnableWiki,
      },
      lang,
      isDeepSeek,
      sessionEnableWiki,
      initialStages,
      abortController,
    }).catch((err) => {
      console.error('[SessionService] Unhandled error in executeTurnPipeline:', err);
    });

    const latestSession = this.sessions.find((s) => s.id === sessionId) || updatedSession;
    return {
      ok: true,
      sessionId,
      messageId: assistantMessageId,
      session: latestSession,
    };
  }

  updateMessageInSession(sessionId, messageId, updater) {
    const sIdx = this.sessions.findIndex((s) => s.id === sessionId);
    if (sIdx === -1) return null;
    const session = this.sessions[sIdx];
    let updatedMsg = null;
    const nextMsgs = session.messages.map((m) => {
      if (m.id === messageId) {
        updatedMsg = updater(m);
        return updatedMsg;
      }
      return m;
    });
    this.sessions[sIdx] = {
      ...session,
      messages: nextMsgs,
      updatedAt: Date.now(),
    };
    return updatedMsg;
  }

  async executeTurnPipeline({
    sessionId,
    assistantMessageId,
    historyMessages,
    userMessage,
    textToSend,
    settings,
    lang,
    isDeepSeek,
    sessionEnableWiki,
    initialStages,
    abortController,
  }) {
    const signal = abortController.signal;
    let stages = Array.isArray(initialStages) && initialStages.length > 0
      ? [...initialStages]
      : [{ kind: 'prefill', startedAt: Date.now() }];
    let promptToSend = textToSend;
    let foundCitations = [];

    // 1. Offline Wiki RAG Phase
    const shouldRunWiki =
      !isDeepSeek &&
      wikiService.enabled &&
      sessionEnableWiki &&
      wikiService.isOnline &&
      Boolean(textToSend);

    if (shouldRunWiki) {
      const unsubscribeStage = onRagStageChange(({ stage, detail, at }) => {
        if (signal.aborted) return;
        if (!RECORDABLE_RAG_STAGES.includes(stage)) return;
        const last = stages[stages.length - 1];
        const nextDetail = detail ? String(detail) : undefined;
        if (!last || last.kind !== stage || last.detail !== nextDetail) {
          const closed =
            last && last.endedAt === undefined
              ? [
                  ...stages.slice(0, -1),
                  { ...last, endedAt: at, durationMs: Math.max(0, at - last.startedAt) },
                ]
              : stages;
          stages = [...closed, { kind: stage, detail: nextDetail, startedAt: at }];
          this.updateMessageInSession(sessionId, assistantMessageId, (m) => ({
            ...m,
            stages,
          }));
          this.scheduleSave();
          this.broadcast('turn-stage', {
            sessionId,
            messageId: assistantMessageId,
            stage: 'rag',
            pending: true,
            stages,
          });
        }
      });

      try {
        const rag = await wikiService.getRagContext(textToSend, signal);
        if (rag && rag.needsWiki && Array.isArray(rag.citations) && rag.citations.length > 0) {
          promptToSend = buildGroundingPrompt(rag.promptContext, textToSend, lang);
          foundCitations = rag.citations;
        }
      } catch (err) {
        if (err?.name === 'AbortError' || signal.aborted) {
          unsubscribeStage();
          return;
        }
        console.warn('[SessionService] Wiki RAG retrieval error:', err);
      } finally {
        unsubscribeStage();
      }
    }

    if (signal.aborted) return;

    // 2. Transition to Prefill Phase
    const prefillStartedAt = Date.now();
    const lastStage = stages[stages.length - 1];
    if (!lastStage || lastStage.kind !== 'prefill') {
      const closed =
        lastStage && lastStage.endedAt === undefined
          ? [
              ...stages.slice(0, -1),
              {
                ...lastStage,
                endedAt: prefillStartedAt,
                durationMs: Math.max(0, prefillStartedAt - lastStage.startedAt),
              },
            ]
          : stages;
      stages = [...closed, { kind: 'prefill', startedAt: prefillStartedAt }];
    }

    this.updateMessageInSession(sessionId, assistantMessageId, (m) => ({
      ...m,
      stage: 'prefill',
      prefillStartedAt,
      stages,
      citations: foundCitations.length > 0 ? foundCitations : undefined,
    }));
    this.scheduleSave();
    this.broadcast('turn-stage', {
      sessionId,
      messageId: assistantMessageId,
      stage: 'prefill',
      pending: true,
      prefillStartedAt,
      stages,
      citations: foundCitations.length > 0 ? foundCitations : undefined,
    });

    // 3. Build Wire Messages (with Sliding Window Context Pruning)
    const wireMessages = this.buildWireMessages(historyMessages, userMessage, promptToSend, {
      systemPrompt: settings.systemPrompt,
      maxContext: settings.maxContext,
      maxTokens: settings.maxTokens,
      provider: settings.apiProvider,
    });

    const initialPromptTokens = estimateHistoryTokens(
      wireMessages,
      settings.systemPrompt,
      settings.apiProvider
    );
    const calibratedPromptTokens = this.applyTokenCalibration(
      initialPromptTokens,
      settings.apiProvider
    );

    const activeTurn = this.activeTurns.get(sessionId);
    if (activeTurn) {
      activeTurn.liveTokens = calibratedPromptTokens;
    }
    this.broadcast('turn-progress', {
      sessionId,
      liveTokens: calibratedPromptTokens,
    });

    // 4. Stream from LLM Engine
    await this.streamFromEngine({
      sessionId,
      assistantMessageId,
      historyMessages,
      userMessage,
      wireMessages,
      settings,
      isDeepSeek,
      initialPromptTokens,
      foundCitations,
      stages,
      signal,
    });
  }

  async streamFromEngine({
    sessionId,
    assistantMessageId,
    historyMessages,
    userMessage,
    wireMessages,
    settings,
    isDeepSeek,
    initialPromptTokens,
    foundCitations,
    stages,
    signal,
  }) {
    const failTurn = (errMsg) => {
      if (signal.aborted) return;
      this.activeTurns.delete(sessionId);
      const tEnd = Date.now();
      const closedStages = stages.map((st) =>
        st.endedAt === undefined
          ? { ...st, endedAt: tEnd, durationMs: Math.max(0, tEnd - st.startedAt) }
          : st
      );
      const cleanHistoryTokens = estimateHistoryTokens(
        [...historyMessages, userMessage],
        settings.systemPrompt,
        settings.apiProvider
      );
      let finalMsg = null;
      this.updateMessageInSession(sessionId, assistantMessageId, (m) => {
        finalMsg = {
          ...m,
          isThinking: false,
          pending: false,
          stages: closedStages,
          citations: foundCitations.length > 0 ? foundCitations : m.citations,
          error: errMsg,
        };
        delete finalMsg.stage;
        return finalMsg;
      });
      const sIdx = this.sessions.findIndex((s) => s.id === sessionId);
      if (sIdx >= 0) {
        this.sessions[sIdx].contextUsed = cleanHistoryTokens;
      }
      this.flushSync();
      this.broadcast('turn-finished', {
        sessionId,
        messageId: assistantMessageId,
        message: finalMsg,
        contextUsed: cleanHistoryTokens,
        calibrationFactors: this.calibrationFactors,
      });
    };

    if (isDeepSeek && !settings.deepseekApiKey?.trim()) {
      failTurn('请在设置中配置 DeepSeek API Key');
      return;
    }

    // Build OpenAI-compatible wire messages array
    const formattedMessages = [];
    if (settings.systemPrompt?.trim()) {
      formattedMessages.push({
        role: 'system',
        content: settings.systemPrompt.trim(),
      });
    }

    for (const msg of wireMessages) {
      if (msg.role === 'user') {
        if (Array.isArray(msg.images) && msg.images.length > 0) {
          const parts = [];
          if (msg.content && msg.content.trim()) {
            parts.push({ type: 'text', text: msg.content.trim() });
          } else {
            parts.push({ type: 'text', text: ' ' });
          }
          for (const imgUrl of msg.images) {
            parts.push({
              type: 'image_url',
              image_url: { url: imgUrl, detail: 'auto' },
            });
          }
          formattedMessages.push({ role: 'user', content: parts });
        } else {
          formattedMessages.push({ role: 'user', content: msg.content || '' });
        }
      } else if (msg.role === 'assistant') {
        formattedMessages.push({ role: 'assistant', content: msg.content || '' });
      }
    }

    let payload;
    if (isDeepSeek) {
      payload = {
        model: settings.deepseekModelId || 'deepseek-flash',
        messages: formattedMessages,
        stream: true,
        stream_options: { include_usage: true },
        max_tokens: settings.maxTokens,
      };
      if (settings.enableThinking) {
        payload.thinking = { type: 'enabled' };
        const effort = settings.reasoningEffort;
        payload.reasoning_effort =
          effort === 'low' || effort === 'high' || effort === 'max' ? effort : 'high';
        if (settings.topP !== undefined) {
          payload.top_p = Math.max(0.95, settings.topP);
        }
      } else {
        payload.thinking = { type: 'disabled' };
        if (settings.temperature !== undefined) payload.temperature = settings.temperature;
        if (settings.topP !== undefined) payload.top_p = settings.topP;
      }
      if (Array.isArray(settings.stopStrings) && settings.stopStrings.length > 0) {
        payload.stop = settings.stopStrings;
      }
    } else {
      payload = {
        model: settings.modelId || 'gemma-4-26b-a4b-it',
        messages: formattedMessages,
        stream: true,
        stream_options: { include_usage: true },
        temperature: settings.temperature,
        top_p: settings.topP,
        top_k: settings.topK,
        repetition_penalty: settings.repetitionPenalty,
        max_tokens: settings.maxTokens,
      };

      const isMference =
        settings.apiProvider === 'mference' ||
        settings.apiPort === 1241 ||
        (typeof settings.modelId === 'string' && settings.modelId.toLowerCase().includes('qwen'));

      if (settings.apiProvider === 'custom') {
        if (settings.enableThinking) {
          payload.chat_template_kwargs = { enable_thinking: true };
          if (settings.reasoningEffort && settings.reasoningEffort !== 'default') {
            payload.reasoning_effort = settings.reasoningEffort;
          }
        }
      } else if (settings.enableThinking) {
        payload.chat_template_kwargs = { enable_thinking: true };
        if (isMference) {
          const effort = settings.reasoningEffort;
          payload.reasoning_effort = effort === 'low' || effort === 'medium' ? effort : 'xhigh';
        } else {
          payload.reasoning_effort = settings.reasoningEffort || 'high';
        }
      } else {
        payload.chat_template_kwargs = { enable_thinking: false };
        payload.reasoning_effort = 'none';
      }

      if (settings.seed !== undefined && settings.seed !== null && !Number.isNaN(Number(settings.seed))) {
        payload.seed = Number(settings.seed);
      }
      if (settings.minP !== undefined && settings.minP !== null && !Number.isNaN(Number(settings.minP))) {
        payload.min_p = Number(settings.minP);
      }
      if (
        settings.presencePenalty !== undefined &&
        settings.presencePenalty !== null &&
        !Number.isNaN(Number(settings.presencePenalty))
      ) {
        payload.presence_penalty = Number(settings.presencePenalty);
      }
      if (Array.isArray(settings.stopStrings) && settings.stopStrings.length > 0) {
        payload.stop = settings.stopStrings;
      }
    }

    // Resolve all local /api/media/<filename> URLs to full-fidelity Base64 Data URLs in-process
    mediaService.resolveMediaUrlsInPayload(payload);

    // Resolve target endpoint URL & headers
    let endpoint;
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    };

    if (isDeepSeek) {
      const rawUrl = (settings.deepseekBaseUrl || 'https://api.deepseek.com').trim();
      const cleanBase = rawUrl.replace(/\/chat\/completions\/?$/, '').replace(/\/+$/, '');
      endpoint = `${cleanBase}/chat/completions`;
      headers.Authorization = `Bearer ${settings.deepseekApiKey.trim()}`;
    } else if (settings.apiBaseUrl && settings.apiBaseUrl.trim().startsWith('http')) {
      const cleanBase = settings.apiBaseUrl.trim().replace(/\/chat\/completions\/?$/, '').replace(/\/+$/, '');
      endpoint = cleanBase.endsWith('/v1')
        ? `${cleanBase}/chat/completions`
        : `${cleanBase}/v1/chat/completions`;
    } else {
      const defaultPort = ttfService?.getActivePort
        ? ttfService.getActivePort()
        : ttfService?.config?.port || 1235;
      const targetPort = settings.apiPort || defaultPort;
      endpoint = `http://127.0.0.1:${targetPort}/v1/chat/completions`;
      noteChatForward();
    }

    const startTime = performance.now();
    const thinkingStartTime = performance.now();
    let firstTokenTime = null;
    let generatedTokensCount = 0;
    let lastReportedMilestone = 0;
    let finalUsage = null;
    let realPromptTokens = null;
    let probeStarted = false;
    let streamClosed = false;

    const probeRealPromptTokens = (reqId) => {
      if (!reqId) return;
      noteForwardedRequest(reqId);
      let tries = 0;
      const tick = () => {
        if (streamClosed || signal.aborted || realPromptTokens !== null) return;
        tries++;
        try {
          const rec = lookupRequest(reqId);
          if (rec && rec.found && typeof rec.promptTokens === 'number') {
            realPromptTokens = rec.promptTokens;
            const live = realPromptTokens + generatedTokensCount;
            const turn = this.activeTurns.get(sessionId);
            if (turn) turn.liveTokens = live;
            this.broadcast('turn-progress', { sessionId, liveTokens: live });
            return;
          }
        } catch {
          // ignore
        }
        if (tries < 15) setTimeout(tick, 200);
      };
      setTimeout(tick, 120);
    };

    let response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal,
      });
    } catch (err) {
      if (err?.name === 'AbortError' || signal.aborted) return;
      failTurn(
        err?.message?.includes('fetch failed')
          ? `Failed to connect to model server at ${endpoint}. Please ensure it is running.`
          : err?.message || 'Network request failed'
      );
      return;
    }

    if (!response.ok) {
      let errorMsg = `Server error ${response.status} ${response.statusText}`;
      try {
        const errJson = await response.json();
        if (errJson?.error?.message) errorMsg = errJson.error.message;
      } catch {
        // use fallback
      }
      failTurn(errorMsg);
      return;
    }

    const reader = response.body?.getReader();
    if (!reader) {
      failTurn('ReadableStream not supported by upstream response');
      return;
    }

    const abortHandler = () => {
      reader.cancel().catch(() => {});
    };
    signal.addEventListener('abort', abortHandler, { once: true });

    let accumulatedReasoning = '';
    let accumulatedContent = '';
    let isThinking = false;
    let thinkingDuration = 0;
    let lastChunkBroadcastTime = 0;
    let chunkBroadcastTimer = null;

    const flushChunkState = (forceBroadcast = false) => {
      if (signal.aborted) return;
      this.updateMessageInSession(sessionId, assistantMessageId, (m) => {
        const next = {
          ...m,
          reasoningContent: accumulatedReasoning,
          content: accumulatedContent,
          isThinking,
          thinkingDuration,
          pending: false,
          stages,
          citations: foundCitations.length > 0 ? foundCitations : m.citations,
        };
        delete next.stage;
        return next;
      });
      this.scheduleSave();

      const now = performance.now();
      const sendBroadcast = () => {
        chunkBroadcastTimer = null;
        lastChunkBroadcastTime = performance.now();
        const turn = this.activeTurns.get(sessionId);
        this.broadcast('turn-chunk', {
          sessionId,
          messageId: assistantMessageId,
          reasoningContent: accumulatedReasoning,
          content: accumulatedContent,
          isThinking,
          thinkingDuration,
          pending: false,
          stages,
          citations: foundCitations.length > 0 ? foundCitations : undefined,
          liveTokens: turn?.liveTokens,
        });
      };

      if (forceBroadcast || now - lastChunkBroadcastTime >= 25) {
        if (chunkBroadcastTimer) {
          clearTimeout(chunkBroadcastTimer);
          chunkBroadcastTimer = null;
        }
        sendBroadcast();
      } else if (!chunkBroadcastTimer) {
        chunkBroadcastTimer = setTimeout(sendBroadcast, 25);
      }
    };

    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    try {
      while (true) {
        if (signal.aborted) break;
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith(':')) continue;
          if (!trimmed.startsWith('data:')) continue;

          const dataStr = trimmed.slice(5).trim();
          if (dataStr === '[DONE]') continue;

          try {
            const parsed = JSON.parse(dataStr);
            if (parsed.usage) {
              finalUsage = parsed.usage;
            }
            if (parsed.id && !probeStarted && !isDeepSeek) {
              probeStarted = true;
              probeRealPromptTokens(String(parsed.id));
            }

            const choice = parsed.choices?.[0];
            if (!choice || !choice.delta) continue;
            const delta = choice.delta;

            let isFirst = false;
            if (!firstTokenTime && (delta.content || delta.reasoning_content)) {
              firstTokenTime = performance.now();
              isFirst = true;
              const tEnd = Date.now();
              stages = stages.map((st) =>
                st.endedAt === undefined
                  ? { ...st, endedAt: tEnd, durationMs: Math.max(0, tEnd - st.startedAt) }
                  : st
              );
              const promptBase =
                realPromptTokens ??
                this.applyTokenCalibration(initialPromptTokens, settings.apiProvider);
              const turn = this.activeTurns.get(sessionId);
              if (turn) turn.liveTokens = promptBase;
            }

            if (delta.reasoning_content) {
              generatedTokensCount++;
              accumulatedReasoning += delta.reasoning_content;
              isThinking = true;
              thinkingDuration = (performance.now() - thinkingStartTime) / 1000;
              if (generatedTokensCount - lastReportedMilestone >= 20) {
                lastReportedMilestone = generatedTokensCount;
                const livePrompt =
                  finalUsage?.prompt_tokens ??
                  realPromptTokens ??
                  this.applyTokenCalibration(initialPromptTokens, settings.apiProvider);
                const turn = this.activeTurns.get(sessionId);
                if (turn) turn.liveTokens = livePrompt + generatedTokensCount;
              }
              flushChunkState(isFirst);
            }

            if (delta.content) {
              generatedTokensCount++;
              const wasThinking = isThinking;
              accumulatedContent += delta.content;
              isThinking = false;
              if (generatedTokensCount - lastReportedMilestone >= 20) {
                lastReportedMilestone = generatedTokensCount;
                const livePrompt =
                  finalUsage?.prompt_tokens ??
                  realPromptTokens ??
                  this.applyTokenCalibration(initialPromptTokens, settings.apiProvider);
                const turn = this.activeTurns.get(sessionId);
                if (turn) turn.liveTokens = livePrompt + generatedTokensCount;
              }
              flushChunkState(isFirst || wasThinking);
            }
          } catch {
            // ignore malformed JSON chunk
          }
        }
      }
    } catch (streamErr) {
      if (streamErr?.name !== 'AbortError' && !signal.aborted) {
        if (chunkBroadcastTimer) clearTimeout(chunkBroadcastTimer);
        signal.removeEventListener('abort', abortHandler);
        streamClosed = true;
        failTurn(streamErr?.message || 'Stream interrupted');
        return;
      }
    } finally {
      if (chunkBroadcastTimer) {
        clearTimeout(chunkBroadcastTimer);
        chunkBroadcastTimer = null;
      }
      signal.removeEventListener('abort', abortHandler);
      streamClosed = true;
      try {
        await reader.cancel();
      } catch {
        // ignore
      }
      reader.releaseLock();
    }

    if (signal.aborted) return;

    // 5. Finalize Turn Metrics & Calibrate Tokenizer
    if (finalUsage?.prompt_tokens) {
      const calibProvider = isDeepSeek ? 'deepseek' : settings.apiProvider || 'local';
      this.setTokenCalibration(finalUsage.prompt_tokens, initialPromptTokens, calibProvider);
    }

    const endTime = performance.now();
    const ttftMs = firstTokenTime
      ? Math.round(firstTokenTime - startTime)
      : Math.round(endTime - startTime);
    const decodeDurationMs = firstTokenTime
      ? Math.max(1, Math.round(endTime - firstTokenTime))
      : 1;
    const completionTokens = finalUsage?.completion_tokens ?? generatedTokensCount;
    const tokensPerSecond = Number((completionTokens / (decodeDurationMs / 1000)).toFixed(1));
    const promptTokens = finalUsage?.prompt_tokens ?? realPromptTokens ?? initialPromptTokens;
    const totalTokens = finalUsage?.total_tokens ?? promptTokens + completionTokens;
    const maxContext = settings.maxContext || 32768;
    const contextRemaining = Math.max(0, maxContext - totalTokens);
    const contextPercent = Math.min(100, Number(((totalTokens / maxContext) * 100).toFixed(1)));

    const cleanHistoryTokens = estimateHistoryTokens(
      [
        ...historyMessages,
        userMessage,
        {
          id: assistantMessageId,
          role: 'assistant',
          content: accumulatedContent,
        },
      ],
      settings.systemPrompt,
      settings.apiProvider
    );

    const metrics = {
      ttftMs,
      decodeDurationMs,
      tokensPerSecond,
      promptTokens,
      completionTokens,
      totalTokens,
      cachedTokens:
        finalUsage?.prompt_cache_hit_tokens ??
        finalUsage?.prompt_tokens_details?.cached_tokens ??
        finalUsage?.cached_tokens,
      reasoningTokens: finalUsage?.completion_tokens_details?.reasoning_tokens,
      contextUsed: cleanHistoryTokens,
      maxContext,
      contextRemaining,
      contextPercent,
    };

    const tEnd = Date.now();
    const closedStages = stages.map((st) =>
      st.endedAt === undefined
        ? { ...st, endedAt: tEnd, durationMs: Math.max(0, tEnd - st.startedAt) }
        : st
    );

    let finalMessage = null;
    this.updateMessageInSession(sessionId, assistantMessageId, (m) => {
      finalMessage = {
        ...m,
        reasoningContent: accumulatedReasoning,
        content: accumulatedContent,
        isThinking: false,
        thinkingDuration,
        pending: false,
        stages: closedStages,
        citations: foundCitations.length > 0 ? foundCitations : m.citations,
        metrics,
      };
      delete finalMessage.stage;
      return finalMessage;
    });

    const sIdx = this.sessions.findIndex((s) => s.id === sessionId);
    if (sIdx >= 0) {
      this.sessions[sIdx].contextUsed = cleanHistoryTokens;
    }

    this.activeTurns.delete(sessionId);
    this.flushSync();

    this.broadcast('turn-finished', {
      sessionId,
      messageId: assistantMessageId,
      message: finalMessage,
      contextUsed: cleanHistoryTokens,
      lastMetrics: metrics,
      calibrationFactors: this.calibrationFactors,
    });
  }

  // ==========================================================================
  // HTTP Route Handler (/api/sessions/*)
  // ==========================================================================

  handleApi(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const urlObj = new URL(req.url, 'http://127.0.0.1:31235');
    const pathname = urlObj.pathname;

    // 1. SSE Event Stream: GET /api/sessions/events
    if (pathname === '/api/sessions/events' && req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });
      res.write(`event: snapshot\ndata: ${JSON.stringify(this.getSnapshotPayload())}\n\n`);
      this.sseClients.add(res);
      req.on('close', () => {
        this.sseClients.delete(res);
      });
      return;
    }

    // 2. Full State Snapshot: GET /api/sessions/state
    if (pathname === '/api/sessions/state' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(this.getSnapshotPayload()));
      return;
    }

    // 2b. App Settings on Disk: GET /api/sessions/settings
    if (pathname === '/api/sessions/settings' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, settings: this.settings }));
      return;
    }

    // Read JSON body for POST / PATCH / DELETE
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      let body = {};
      if (chunks.length > 0) {
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
        } catch {
          body = {};
        }
      }

      try {
        // 2c. Save App Settings to Disk: POST /api/sessions/settings
        if (pathname === '/api/sessions/settings' && req.method === 'POST') {
          const saved = this.saveSettingsToDisk(body.settings || body);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true, settings: saved }));
          return;
        }

        // 3. Get or Create Empty Session: POST /api/sessions/empty
        if (pathname === '/api/sessions/empty' && req.method === 'POST') {
          const result = this.getOrCreateEmptySession(body.title || '新对话', body.origin || 'MAIN');
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true, ...result, mainSessionId: this.mainSessionId }));
          return;
        }

        // 4. Select Main Window Session or Handoff: POST /api/sessions/:id/select
        const selectMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/select$/);
        if (selectMatch && req.method === 'POST') {
          const sid = decodeURIComponent(selectMatch[1]);
          const target = this.sessions.find((s) => s.id === sid);
          if (target) {
            if (body.targetWindow === 'SPOTLIGHT') {
              const hasMessages = (target.messages?.length ?? 0) > 0;
              this.broadcast('spotlight-session-changed', {
                sessionId: sid,
                isExpanded: hasMessages,
                session: target,
              });
            } else {
              this.mainSessionId = sid;
              this.flushSync();
              this.broadcast('main-session-changed', { mainSessionId: sid });
            }
          }
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true, mainSessionId: this.mainSessionId }));
          return;
        }

        // 5. Start a Turn (Send Message): POST /api/sessions/:id/turns
        const turnsMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/turns$/);
        if (turnsMatch && req.method === 'POST') {
          const sid = decodeURIComponent(turnsMatch[1]);
          const result = await this.startTurn({
            sessionId: sid === 'new' ? null : sid,
            text: body.text,
            images: body.images,
            settings: body.settings,
            lang: body.lang,
            origin: body.origin || 'MAIN',
          });
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(result));
          return;
        }

        // 6. Abort a Turn: POST /api/sessions/:id/abort
        const abortMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/abort$/);
        if (abortMatch && req.method === 'POST') {
          const sid = decodeURIComponent(abortMatch[1]);
          if (sid === 'all') {
            for (const activeId of Array.from(this.activeTurns.keys())) {
              this.abortTurn(activeId);
            }
          } else {
            this.abortTurn(sid);
          }
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true }));
          return;
        }

        // 7. Retry a Turn: POST /api/sessions/:id/retry
        const retryMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/retry$/);
        if (retryMatch && req.method === 'POST') {
          const sid = decodeURIComponent(retryMatch[1]);
          const result = await this.startTurn({
            sessionId: sid,
            settings: body.settings,
            lang: body.lang,
            origin: body.origin || 'MAIN',
            retryAssistantMessageId: body.assistantMessageId,
          });
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(result));
          return;
        }

        // 8. Delete a Single Turn: DELETE /api/sessions/:id/turns/:messageId
        const deleteTurnMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/turns\/([^/]+)$/);
        if (deleteTurnMatch && req.method === 'DELETE') {
          const sid = decodeURIComponent(deleteTurnMatch[1]);
          const msgId = decodeURIComponent(deleteTurnMatch[2]);
          const updatedSession = this.deleteTurn(sid, msgId);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true, session: updatedSession }));
          return;
        }

        // 9. Update or Delete a Session: PATCH / DELETE /api/sessions/:id
        const sessionMatch = pathname.match(/^\/api\/sessions\/([^/]+)$/);
        if (sessionMatch) {
          const sid = decodeURIComponent(sessionMatch[1]);
          if (req.method === 'PATCH') {
            const updated = this.updateSessionMeta(sid, body);
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: true, session: updated }));
            return;
          }
          if (req.method === 'DELETE') {
            const snap = this.deleteSession(sid, body.defaultTitle || '新对话');
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: true, ...snap }));
            return;
          }
        }

        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'Unknown session endpoint' }));
      } catch (err) {
        console.error('[SessionService] API error:', err);
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
  }
}

export const sessionService = new SessionService();
