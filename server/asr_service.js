// ASR（语音输入识别）服务托管模块 —— Confucius4-R2T2 (GGUF) via audio.cpp
//
// 职责：把「本地高精度语音识别」作为与基础模型服务、知识库服务并列的受管服务，
// 内置到 SimpleUI 的 Node 服务层：
//   - 纯按需待命模式（与 TTS、OCR、字幕服务保持完全统一的生命周期与四态逻辑）；
//   - 启动时不常驻占用 1236 端口与 2.8GB GPU 显存，保持天蓝色「待命」状态；
//   - 用户在全系统任意位置长按右侧 Command 键录音时，由 Node 侧透明现场拉起并转写；
//   - 闲置超时（默认 10 分钟）自动安全卸载进程并释放显存，重回「待命」状态；
//   - 与字幕服务完全共用底层的 audio.cpp 原生推理引擎与 Confucius4-R2T2 Q8_0 模型文件。

import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { fileURLToPath } from 'url';
import { startWatchdog } from './watchdog.js';
import { SUBTITLE_MODELS_DIR, subtitleService } from './subtitle_service.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const HOME = os.homedir();

// ----------------------------- 路径与常量 -----------------------------

const userConfigDir = path.join(HOME, 'Library', 'Application Support', 'SimpleUI');
const CONFIG_FILE = path.join(userConfigDir, 'asr_config.json');
const MODELS_DIR = path.join(userConfigDir, 'models');
const SERVER_JSON_FILE = path.join(userConfigDir, 'asr_server.json');
const LOG_FILE = process.env.SIMPLEUI_ASR_LOG || path.join(HOME, 'Library', 'Logs', 'simpleui-asr.log');
const PID_FILE = '/tmp/simpleui_audiocpp.pid';

// 统一复用字幕服务的 Confucius4-R2T2 Q8_0 模型（~2.48 GB，约 2.31 GiB）
export const MODEL_FILENAME = 'r2t2-q8_0.gguf';
export const EXPECTED_MODEL_BYTES = 2477512064;
export const MIN_MODEL_BYTES = 2300 * 1024 * 1024;

// audiocpp 服务端里该模型的 id
export const SERVER_MODEL_ID = 'confucius_asr';
export const BINARY_BASENAME = 'audiocpp_server';

export const DEFAULT_ASR_CONFIG = {
  port: 1236,
  backend: 'metal',
  threads: 4,
  language: 'Auto',
  idleUnloadMin: 30, // 默认闲置 30 分钟自动退出进程返回待命（与 OCR 服务保持一致）
  projectDir: path.join(userConfigDir, 'runtime', 'asr'),
  binaryPath: '',
  modelPath: path.join(SUBTITLE_MODELS_DIR, MODEL_FILENAME),
};

// ----------------------------- 配置持久化 -----------------------------

function loadStoredConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const data = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
      if (data && typeof data === 'object') {
        if (data.modelPath && String(data.modelPath).toLowerCase().includes('sensevoice')) {
          data.modelPath = path.join(SUBTITLE_MODELS_DIR, MODEL_FILENAME);
        }
        return { ...DEFAULT_ASR_CONFIG, ...data };
      }
    }
  } catch (e) {
    // ignore
  }
  return { ...DEFAULT_ASR_CONFIG };
}

function expandHome(p) {
  if (typeof p !== 'string' || !p) return p;
  if (p === '~') return HOME;
  if (p.startsWith('~/')) return path.join(HOME, p.slice(2));
  return p;
}

function resolveDir(dir, fallback) {
  const expanded = expandHome(String(dir || '').trim() || fallback);
  try {
    if (fs.existsSync(expanded)) return fs.realpathSync(expanded);
  } catch (e) {
    // ignore
  }
  return expanded;
}

function bundledAsrRoot() {
  const candidates = [
    path.resolve(__dirname, '../asr'),
    '/Applications/SimpleUI.app/Contents/Resources/asr',
    path.resolve(__dirname, '../bin/audiocpp'),
    path.join(userConfigDir, 'runtime', 'asr'),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p) && fs.statSync(p).isDirectory()) return p;
    } catch (e) {
      // ignore
    }
  }
  return null;
}

function sanitizeConfig(partial) {
  const out = {};
  if (partial.enabled !== undefined) out.enabled = partial.enabled === true || partial.enabled === 'true';
  if (partial.port !== undefined) {
    const port = Number(partial.port);
    if (Number.isInteger(port) && port >= 1024 && port <= 65535) out.port = port;
  }
  if (partial.backend !== undefined && ['cpu', 'metal', 'best'].includes(partial.backend)) {
    out.backend = partial.backend;
  }
  if (partial.idleUnloadMin !== undefined) {
    const m = Number(partial.idleUnloadMin);
    if (Number.isFinite(m) && m >= 0) out.idleUnloadMin = m;
  }
  return out;
}

// ----------------------------- 资源探测 -----------------------------

function readPid() {
  try {
    const pid = parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim(), 10);
    if (Number.isInteger(pid) && pid > 0) return pid;
  } catch (e) {
    // ignore
  }
  return null;
}

function isPidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return false;
  }
}

// ----------------------------- 服务模块 -----------------------------

class AsrService {
  constructor() {
    this.config = loadStoredConfig();
    this.pendingOp = null; // 'start' | 'stop' | 'restart'
    this.lastActionLog = '';
    this.lastActionAt = 0;
    this.watchdog = null;
    this.child = null;
    this.logStream = null;
    this.childLogTail = [];
    this.idleTimer = null;
    this.lastUsedAt = 0;
    this.inFlight = 0;
    this.startingPromise = null;
    this.liveSessions = new Map();
  }

  findBinary() {
    const candidates = [];
    const custom = expandHome(String(this.config.binaryPath || '').trim());
    if (custom) candidates.push(custom);
    const bundled = bundledAsrRoot();
    if (bundled) candidates.push(path.join(bundled, 'bin', BINARY_BASENAME));
    const projectDir = resolveDir(this.config.projectDir, DEFAULT_ASR_CONFIG.projectDir);
    candidates.push(path.join(projectDir, 'build/bin', BINARY_BASENAME));
    candidates.push(path.join(projectDir, 'bin', BINARY_BASENAME));
    candidates.push('/opt/homebrew/bin/' + BINARY_BASENAME);
    candidates.push('/usr/local/bin/' + BINARY_BASENAME);
    for (const p of candidates) {
      try {
        if (p && fs.existsSync(p) && fs.statSync(p).isFile()) return p;
      } catch (e) {
        // ignore
      }
    }
    return null;
  }

  resolveRuntimeRoot() {
    const candidates = [];
    const bundled = bundledAsrRoot();
    if (bundled) candidates.push(bundled);
    candidates.push(resolveDir(this.config.projectDir, DEFAULT_ASR_CONFIG.projectDir));
    for (const dir of candidates) {
      try {
        if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) return dir;
      } catch (e) {
        // ignore
      }
    }
    return resolveDir(this.config.projectDir, DEFAULT_ASR_CONFIG.projectDir);
  }

  findModel() {
    const explicit = expandHome(String(this.config.modelPath || '').trim());
    if (explicit && !explicit.toLowerCase().includes('sensevoice')) {
      try {
        if (fs.existsSync(explicit) && fs.statSync(explicit).isFile() && fs.statSync(explicit).size >= MIN_MODEL_BYTES) {
          return explicit;
        }
      } catch (e) {
        // ignore
      }
    }
    const searchDirs = [
      SUBTITLE_MODELS_DIR,
      MODELS_DIR,
      path.join(userConfigDir, 'models'),
    ];
    for (const dir of searchDirs) {
      try {
        const candidate = path.join(dir, MODEL_FILENAME);
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile() && fs.statSync(candidate).size >= MIN_MODEL_BYTES) {
          return candidate;
        }
      } catch (e) {
        // ignore
      }
    }
    return null;
  }

  buildServerJson() {
    const modelPath = this.findModel();
    const rawLang = this.config.language || 'Auto';
    const lang = String(rawLang).toLowerCase() === 'auto' ? 'Auto' : rawLang;
    const modelEntry = {
      id: SERVER_MODEL_ID,
      family: 'confucius4_r2t2',
      path: modelPath || path.join(SUBTITLE_MODELS_DIR, MODEL_FILENAME),
      task: 'asr',
      mode: 'streaming',
      session_options: {
        'confucius4_r2t2.chunk_size_ms': '960',
        'confucius4_r2t2.unfixed_chunk_num': '1',
        'confucius4_r2t2.unfixed_token_num': '2',
        'confucius4_r2t2.rollback_punctuation': 'false',
        'confucius4_r2t2.max_tokens': '16',
      },
      default_request_options: {
        language: lang,
        max_tokens: 512,
      },
    };
    const serverJson = {
      host: '127.0.0.1',
      port: this.config.port || 1236,
      backend: this.config.backend || 'metal',
      device: 0,
      threads: this.config.threads || 4,
      lazy_load: false,
      max_loaded_models: 1,
      idle_unload_ms: 0,
      min_free_memory_mb: 0,
      busy_timeout_ms: 0,
      ui: false,
      live_ingest: { total_timeout_ms: 1800000, max_chunk_bytes: 8388608 },
      models: [modelEntry],
    };
    if (!fs.existsSync(userConfigDir)) fs.mkdirSync(userConfigDir, { recursive: true });
    fs.writeFileSync(SERVER_JSON_FILE, JSON.stringify(serverJson, null, 2));
    return { serverJsonFile: SERVER_JSON_FILE, modelPath: modelEntry.path };
  }

  checkHealth() {
    const port = this.config.port || 1236;
    return new Promise((resolve) => {
      const req = http.get(`http://127.0.0.1:${port}/health`, { timeout: 1000 }, (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => {
        req.destroy();
        resolve(false);
      });
    });
  }

  // 刷新闲置计时器，超时自动释放进程回到待命状态
  touch() {
    this.lastUsedAt = Date.now();
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const minutes = Number(this.config.idleUnloadMin ?? 30);
    if (minutes <= 0) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      const pid = readPid();
      if (!isPidAlive(pid)) return;
      if (this.inFlight > 0) {
        this.touch();
        return;
      }
      const idleMs = Date.now() - (this.lastUsedAt || 0);
      if (idleMs < minutes * 60_000) {
        this.touch();
        return;
      }
      console.log(`[AsrService] 语音输入服务闲置超过 ${minutes} 分钟，自动退出进程返回待命状态 (standby)`);
      this.stopService();
    }, minutes * 60_000);
    this.idleTimer.unref?.();
  }

  // 统一的四态返回：模型就绪但进程未开启时返回 'standby'（待命）
  async getStatus() {
    const pid = readPid();
    const alive = isPidAlive(pid);
    const healthy = alive ? await this.checkHealth() : false;

    const binaryPath = this.findBinary();
    const modelPath = this.findModel();
    const modelReady = Boolean(
      modelPath &&
      fs.existsSync(modelPath) &&
      fs.statSync(modelPath).size >= MIN_MODEL_BYTES
    );
    let modelStat = null;
    if (modelPath && fs.existsSync(modelPath)) {
      try {
        modelStat = fs.statSync(modelPath);
      } catch (e) {
        // ignore
      }
    }

    let status = 'incomplete';
    if (!modelReady || !binaryPath) {
      status = 'incomplete';
    } else if (this.pendingOp === 'start' || this.pendingOp === 'restart' || this.startingPromise) {
      status = 'loading';
    } else if (this.pendingOp === 'stop') {
      status = 'stopping';
    } else if (alive && healthy) {
      status = 'ready';
    } else if (alive && !healthy) {
      status = 'loading';
    } else {
      status = 'standby';
    }

    return {
      status,
      running: alive && healthy,
      ready: alive && healthy,
      modelsReady: modelReady,
      runtimeReady: Boolean(binaryPath),
      pid: alive ? pid : null,
      port: this.config.port || 1236,
      backend: this.config.backend || 'metal',
      language: this.config.language || 'Auto',
      idleUnloadMin: this.config.idleUnloadMin ?? 30,
      projectDir: resolveDir(this.config.projectDir, DEFAULT_ASR_CONFIG.projectDir),
      runtimeRoot: this.resolveRuntimeRoot(),
      bundled: !!bundledAsrRoot(),
      checks: {
        binary: Boolean(binaryPath),
        model: modelReady,
        binaryPath,
        modelPath: modelPath || path.join(SUBTITLE_MODELS_DIR, MODEL_FILENAME),
      },
      model: {
        name: 'Confucius4-R2T2 Q8_0 GGUF (有道真流式与离线 ASR)',
        shortName: 'Confucius4-R2T2 Q8_0',
        ready: modelReady,
        path: modelPath || path.join(SUBTITLE_MODELS_DIR, MODEL_FILENAME),
        sizeBytes: modelStat?.size || 0,
        expectedBytes: EXPECTED_MODEL_BYTES,
        sizeMb: modelStat ? (modelStat.size / (1024 * 1024)).toFixed(1) : '0',
        sizeDesc: '2.31 GB',
      },
      download: subtitleService.downloadState,
      lastActionAt: this.lastActionAt || undefined,
      lastActionLog: this.lastActionLog || undefined,
    };
  }

  ensureWatchdog() {
    if (this.watchdog) return;
    try {
      this.watchdog = startWatchdog({
        pidFile: PID_FILE,
        binaryBasename: BINARY_BASENAME,
      });
    } catch (e) {
      // ignore
    }
  }

  openLogStream() {
    if (this.logStream) return this.logStream;
    try {
      if (!fs.existsSync(path.dirname(LOG_FILE))) fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
      this.logStream = fs.createWriteStream(LOG_FILE, { flags: 'w' });
    } catch (e) {
      this.logStream = null;
    }
    return this.logStream;
  }

  async startService() {
    const binary = this.findBinary();
    if (!binary) {
      this.lastActionLog = `${BINARY_BASENAME} 未找到（请检查本地 audiocpp 构建产物）`;
      this.lastActionAt = Date.now();
      return { accepted: false, reason: 'binary_not_found' };
    }
    const model = this.findModel();
    if (!model) {
      this.lastActionLog = `Confucius4-R2T2 模型未就绪（请在服务管理面板中点击下载）`;
      this.lastActionAt = Date.now();
      return { accepted: false, reason: 'model_not_found' };
    }
    const alive = isPidAlive(readPid());
    if (alive && !this.pendingOp) {
      return { accepted: true, alreadyRunning: true };
    }

    this.pendingOp = 'start';
    this.lastActionAt = Date.now();

    let serverJsonFile;
    try {
      serverJsonFile = this.buildServerJson().serverJsonFile;
    } catch (e) {
      this.pendingOp = null;
      this.lastActionLog = `生成 server.json 失败: ${e.message}`;
      return { accepted: false, reason: 'config_write_failed' };
    }

    this.ensureWatchdog();
    const log = this.openLogStream();

    try {
      if (!fs.existsSync(userConfigDir)) fs.mkdirSync(userConfigDir, { recursive: true });
      const child = spawn(binary, ['--config', serverJsonFile], {
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: userConfigDir,
        env: { ...process.env },
      });
      this.child = child;
      try {
        fs.writeFileSync(PID_FILE, String(child.pid));
      } catch (e) {
        // ignore
      }
      if (log) {
        log.write(`[${new Date().toISOString()}] start: ${binary} --config ${serverJsonFile}\n`);
      }
      this.childLogTail = [];
      const captureTail = (d) => {
        const text = String(d);
        if (log) log.write(d);
        for (const line of text.split('\n')) {
          const t = line.trim();
          if (!t) continue;
          this.childLogTail.push(t);
          if (this.childLogTail.length > 12) this.childLogTail.shift();
        }
      };
      child.stdout.on('data', captureTail);
      child.stderr.on('data', captureTail);
      let exitedBadly = false;
      child.on('exit', (code, signal) => {
        if (log) log.write(`\n[${new Date().toISOString()}] audiocpp_server exited code=${code} signal=${signal}\n`);
        if (this.child === child) this.child = null;
        try { fs.unlinkSync(PID_FILE); } catch (e) { /* ignore */ }
        if (code !== null && code !== 0) {
          exitedBadly = true;
          this.lastActionLog = `audiocpp_server 异常退出 (code=${code})：\n${this.childLogTail.slice(-4).join('\n')}`;
          this.lastActionAt = Date.now();
        }
      });
      this.lastActionLog = `已拉起 audiocpp_server (pid=${child.pid}) · ${this.config.backend} · Confucius4-R2T2`;

      // 等待健康探测通过（冷启动加载 2.48GB 模型权重与 Metal 图最长约需 8~10 秒）
      let healthy = false;
      for (let i = 0; i < 48; i++) {
        await new Promise((r) => setTimeout(r, 250));
        if (await this.checkHealth()) {
          healthy = true;
          break;
        }
        if (!isPidAlive(readPid())) break;
      }
      this.pendingOp = null;
      if (healthy) {
        this.touch();
        return { accepted: true };
      }
      if (exitedBadly || !isPidAlive(readPid())) {
        return { accepted: false, reason: 'exited', error: this.lastActionLog };
      }
      return { accepted: false, reason: 'health_timeout' };
    } catch (e) {
      this.pendingOp = null;
      this.lastActionLog = `启动失败: ${e.message}`;
      return { accepted: false, reason: 'spawn_failed', error: e.message };
    }
  }

  // 按需唤醒入口：有录音请求来时若尚未拉起则现场拉起并重置闲置计时
  async ensureRunning() {
    const binary = this.findBinary();
    if (!binary) {
      return { ok: false, error: 'BINARY_MISSING' };
    }
    const model = this.findModel();
    if (!model) {
      return { ok: false, error: 'MODEL_MISSING' };
    }
    const pid = readPid();
    const alive = isPidAlive(pid);
    if (alive) {
      const healthy = await this.checkHealth();
      if (healthy) {
        this.touch();
        return { ok: true, existing: true };
      }
    }
    if (this.startingPromise) {
      return await this.startingPromise;
    }
    this.startingPromise = this.startService();
    try {
      const res = await this.startingPromise;
      if (res && res.accepted) {
        this.touch();
        return { ok: true, existing: false };
      }
      return { ok: false, error: res?.reason || 'SPAWN_FAILED', detail: this.lastActionLog };
    } finally {
      this.startingPromise = null;
    }
  }

  async stopService() {
    this.pendingOp = 'stop';
    this.lastActionAt = Date.now();
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    for (const session of this.liveSessions.values()) {
      try { session.abort(); } catch {}
    }
    this.liveSessions.clear();
    try {
      const pid = readPid();
      if (isPidAlive(pid)) {
        try { process.kill(pid, 'SIGTERM'); } catch (e) { /* ignore */ }
        for (let i = 0; i < 20 && isPidAlive(pid); i++) {
          await new Promise((r) => setTimeout(r, 200));
        }
        if (isPidAlive(pid)) {
          try { process.kill(pid, 'SIGKILL'); } catch (e) { /* ignore */ }
        }
      }
      try { fs.unlinkSync(PID_FILE); } catch (e) { /* ignore */ }
    } finally {
      this.child = null;
      this.pendingOp = null;
    }
    return { accepted: true };
  }

  async restartService() {
    this.pendingOp = 'restart';
    await this.stopService();
    const result = await this.startService();
    return result;
  }

  async applyConfig(partial, restartIfRunning) {
    const clean = sanitizeConfig(partial);
    if (Object.keys(clean).length === 0) {
      return { success: false, error: 'NO_VALID_FIELDS' };
    }
    const wasRunning = isPidAlive(readPid());
    this.config = { ...this.config, ...clean };
    try {
      if (!fs.existsSync(userConfigDir)) fs.mkdirSync(userConfigDir, { recursive: true });
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(this.config, null, 2));
    } catch (e) {
      return { success: false, error: e.message };
    }

    let restarted = false;
    if (restartIfRunning && wasRunning) {
      await this.restartService();
      restarted = true;
    } else if (wasRunning) {
      this.touch();
    }
    return { success: true, restarted, config: this.publicConfig() };
  }

  publicConfig() {
    return { ...this.config };
  }

  // 统一按需待命：启动时不拉起模型与进程，由录音请求现场唤醒
  init() {
    const pid = readPid();
    if (!isPidAlive(pid)) {
      try { fs.unlinkSync(PID_FILE); } catch {}
    } else {
      try { process.kill(pid, 'SIGTERM'); } catch {}
      try { fs.unlinkSync(PID_FILE); } catch {}
    }
    console.log('[AsrService] 语音输入识别服务已注册（按需待命模式：首句录音现场拉起，闲置超时自动卸载）');
  }

  shutdownSync() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const pid = readPid();
    if (isPidAlive(pid)) {
      try { process.kill(pid, 'SIGTERM'); } catch (e) { /* ignore */ }
    }
  }

  shutdownForce() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const pid = readPid();
    if (isPidAlive(pid)) {
      try { process.kill(pid, 'SIGKILL'); } catch (e) { /* ignore */ }
    }
    try { fs.unlinkSync(PID_FILE); } catch (e) { /* ignore */ }
    try { if (this.logStream) this.logStream.end(); } catch (e) { /* ignore */ }
  }

  tailLog(maxLines = 200) {
    try {
      const st = fs.statSync(LOG_FILE);
      if (!st.isFile()) return { found: false, lines: [] };
      const TAIL = 256 * 1024;
      const start = Math.max(0, st.size - TAIL);
      const len = st.size - start;
      const buf = Buffer.alloc(len);
      const fd = fs.openSync(LOG_FILE, 'r');
      try {
        fs.readSync(fd, buf, 0, len, start);
      } finally {
        fs.closeSync(fd);
      }
      const all = buf.toString('utf-8').split('\n').filter((l) => l.trim());
      return { found: true, lines: all.slice(-maxLines), size: st.size, mtime: st.mtimeMs };
    } catch (e) {
      return { found: false, lines: [] };
    }
  }

  // ----------------------------- 转写与流式引擎 -----------------------------

  createLiveSession({ language, onDelta, onDone, onError }) {
    const port = this.config.port || 1236;
    const rawLang = language || this.config.language || 'Auto';
    const lang = String(rawLang).toLowerCase() === 'auto' ? 'Auto' : rawLang;

    const session = {
      state: 'open', // 'open' | 'rotating' | 'finishing' | 'done' | 'error'
      abandoned: false,
      committedText: '',
      subStreamText: '',
      subStreamBytes: 0,
      activeReq: null,
      rotateTimer: null,
      pendingChunks: [],
      finished: false,
      sseClients: new Set(),
      onDelta,
      onDone,
      onError,
    };

    // 辅助属性：session.text 返回当前完整累积文本 (committedText + subStreamText)
    Object.defineProperty(session, 'text', {
      get() {
        return session.committedText + session.subStreamText;
      },
      set(val) {
        session.committedText = String(val || '');
        session.subStreamText = '';
      },
      configurable: true,
      enumerable: true,
    });

    session.broadcast = (msg) => {
      const payload = `data: ${JSON.stringify(msg)}\n\n`;
      for (const client of session.sseClients) {
        try {
          client.write(payload);
        } catch {
          session.sseClients.delete(client);
        }
      }
    };

    const handleSubStreamDone = (finalText) => {
      if (session.rotateTimer) {
        clearTimeout(session.rotateTimer);
        session.rotateTimer = null;
      }
      const extra = extractFinalExtra(session.subStreamText, finalText);
      session.committedText += (session.subStreamText + extra);
      session.subStreamText = '';
      session.subStreamBytes = 0;
      session.activeReq = null;

      if (session.state === 'finishing') {
        if (session.pendingChunks.length > 0) {
          openSubStream();
          while (session.pendingChunks.length > 0) {
            const c = session.pendingChunks.shift();
            try {
              session.activeReq.write(c);
              session.subStreamBytes += c.length;
            } catch {}
          }
          try {
            session.activeReq.write(Buffer.alloc(Math.floor(16000 * 0.36) * 2));
            session.activeReq.end();
          } catch {}
        } else {
          session.state = 'done';
          const fullText = session.text;
          session.onDone?.(fullText, null);
          session.broadcast({ type: 'done', text: fullText });
        }
      } else if (session.state === 'rotating') {
        session.state = 'open';
        openSubStream();
        while (session.pendingChunks.length > 0) {
          const c = session.pendingChunks.shift();
          try {
            session.activeReq.write(c);
            session.subStreamBytes += c.length;
          } catch {}
        }
      }
    };

    const openSubStream = () => {
      if (session.abandoned || session.state === 'done' || session.state === 'error') return;
      session.subStreamText = '';
      session.subStreamBytes = 0;
      let subStreamDone = false;

      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: `/v1/audio/transcriptions/live?model=${SERVER_MODEL_ID}&sample_rate=16000&channels=1&sample_format=s16le&language=${lang}`,
          method: 'POST',
          headers: {
            'Transfer-Encoding': 'chunked',
            'Content-Type': 'application/octet-stream',
          },
        },
        (res) => {
          if (res.statusCode !== 200) {
            res.resume();
            if (!session.abandoned && session.state !== 'done') {
              session.state = 'error';
              const err = new Error(`upstream_${res.statusCode}`);
              session.onError?.(err);
              session.broadcast({ type: 'error', error: err.message });
            }
            return;
          }
          let buf = '';
          res.on('data', (chunk) => {
            if (session.abandoned) return;
            buf += chunk.toString('utf-8');
            let idx;
            while ((idx = buf.indexOf('\n\n')) !== -1) {
              const rawEvent = buf.slice(0, idx);
              buf = buf.slice(idx + 2);
              for (const line of rawEvent.split('\n')) {
                if (!line.startsWith('data: ')) continue;
                const payload = line.slice(6).trim();
                if (payload === '[DONE]') continue;
                try {
                  const ev = JSON.parse(payload);
                  if (ev.type === 'transcript.text.delta' && typeof ev.delta === 'string') {
                    session.subStreamText += ev.delta;
                    const fullText = session.text;
                    session.onDelta?.(ev.delta, fullText);
                    session.broadcast({ type: 'delta', delta: ev.delta, text: fullText });
                  } else if (ev.type === 'transcript.text.done') {
                    if (!subStreamDone) {
                      subStreamDone = true;
                      handleSubStreamDone(typeof ev.text === 'string' ? ev.text : session.subStreamText);
                    }
                  }
                } catch {}
              }
            }
          });
          res.on('error', (err) => {
            if (!session.abandoned && session.state !== 'done') {
              session.state = 'error';
              session.onError?.(err);
              session.broadcast({ type: 'error', error: err.message });
            }
          });
          res.on('end', () => {
            if (session.abandoned) return;
            if (!subStreamDone && (session.state === 'rotating' || session.state === 'finishing')) {
              subStreamDone = true;
              handleSubStreamDone(session.subStreamText);
            }
          });
        }
      );

      session.activeReq = req;

      req.on('error', (err) => {
        if (!session.abandoned && session.state !== 'done') {
          session.state = 'error';
          session.onError?.(err);
          session.broadcast({ type: 'error', error: err.message });
        }
      });
    };

    const rotateSubStream = () => {
      if (session.state !== 'open' || !session.activeReq) return;
      session.state = 'rotating';
      const req = session.activeReq;
      try {
        req.write(Buffer.alloc(Math.floor(16000 * 0.36) * 2));
        req.end();
      } catch {}

      session.rotateTimer = setTimeout(() => {
        if (session.state === 'rotating') {
          console.warn('[AsrService] ⚠️ sub-stream rotation timeout, forcing next session');
          try { req.destroy(); } catch {}
          handleSubStreamDone(session.subStreamText);
        }
      }, 4000);
      session.rotateTimer.unref?.();
    };

    session.write = (pcm) => {
      if (session.abandoned || session.state === 'done' || session.state === 'error') return false;
      if (session.state === 'rotating' || session.state === 'finishing') {
        session.pendingChunks.push(pcm);
        return true;
      }

      if (!session.activeReq) {
        openSubStream();
      }

      try {
        session.activeReq.write(pcm);
        session.subStreamBytes += pcm.length;

        // 核心防积压机制：
        // 1. 单条 live 流控制在 <= 9.6s（307,200 字节 = 10 个 960ms 分块）
        // 2. 若流持续 >= 5.0s（160,000 字节）且当前分块为停顿静音帧，顺势在停顿处轮转
        const isSilent = isChunkSilent(pcm);
        if (session.subStreamBytes >= 307200 || (session.subStreamBytes >= 160000 && isSilent)) {
          rotateSubStream();
        }
        return true;
      } catch {
        return false;
      }
    };

    session.finish = () => {
      if (session.finished || session.state === 'done') return;
      session.finished = true;
      if (session.state === 'rotating') {
        session.state = 'finishing';
        return;
      }
      session.state = 'finishing';
      if (session.activeReq) {
        try {
          session.activeReq.write(Buffer.alloc(Math.floor(16000 * 0.36) * 2));
          session.activeReq.end();
        } catch {}
      } else {
        session.state = 'done';
        const fullText = session.text;
        session.onDone?.(fullText, null);
        session.broadcast({ type: 'done', text: fullText });
      }
    };

    session.abort = () => {
      if (session.state === 'done') return;
      session.abandoned = true;
      session.state = 'error';
      if (session.rotateTimer) {
        clearTimeout(session.rotateTimer);
        session.rotateTimer = null;
      }
      session.pendingChunks = [];
      try {
        session.activeReq?.destroy();
      } catch {}
    };

    return session;
  }

  transcribe(audio, language) {
    const rawLang = language || this.config.language || 'Auto';
    const lang = String(rawLang).toLowerCase() === 'auto' ? 'Auto' : rawLang;
    const pcm = extractPcm(audio);

    return new Promise((resolve) => {
      let resolved = false;
      const doneCallback = (rawText) => {
        if (resolved) return;
        resolved = true;
        const text = stripLonePunctuation(String(rawText || '').trim());
        resolve({
          ok: true,
          text,
          language: lang,
          raw: String(rawText || '').trim(),
          droppedPunctuation: text === '' && String(rawText || '').trim() !== '',
        });
      };

      const errorCallback = (err) => {
        if (resolved) return;
        resolved = true;
        resolve({ ok: false, error: err.message || 'transcribe_failed' });
      };

      const session = this.createLiveSession({
        language: lang,
        onDone: (finalText) => doneCallback(finalText),
        onError: (err) => errorCallback(err),
      });

      // 以 960ms 分块 (30720 字节) 喂入流式引擎，支持长音频自动轮转，彻底杜绝 GPU 队列积压与注意力跳字
      const CHUNK_SIZE = 30720;
      for (let offset = 0; offset < pcm.length; offset += CHUNK_SIZE) {
        session.write(pcm.slice(offset, offset + CHUNK_SIZE));
      }
      session.finish();

      setTimeout(() => {
        if (!resolved) {
          session.abort();
          errorCallback(new Error('upstream_timeout'));
        }
      }, 60000).unref?.();
    });
  }

  // ----------------------------- HTTP API -----------------------------

  async handleApi(req, res) {
    try {
      const host = req.headers.host || '127.0.0.1:31235';
      const urlObj = new URL(req.url, `http://${host}`);
      const pathname = urlObj.pathname.replace(/^\/api\/asr/, '');

      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      const sendJson = (code, obj) => {
        res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(obj));
      };
      const readBody = () => new Promise((resolve, reject) => {
        let body = '';
        req.on('data', (chunk) => (body += chunk));
        req.on('end', () => {
          try { resolve(JSON.parse(body || '{}')); } catch (e) { reject(e); }
        });
        req.on('error', reject);
      });
      const readRawBody = () => new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
      });

      if (pathname === '/status' && req.method === 'GET') {
        sendJson(200, await this.getStatus());
        return;
      }

      // 按需唤醒与预热接口：录音启动时后台静默触发，提前加载模型权重与 Metal 图
      if (pathname === '/warmup' && req.method === 'POST') {
        const r = await this.ensureRunning();
        sendJson(r.ok ? 200 : 503, r);
        return;
      }

      if (pathname === '/start' && req.method === 'POST') {
        const r = await this.startService();
        sendJson(200, { ...r, status: (await this.getStatus()).status });
        return;
      }

      if (pathname === '/stop' && req.method === 'POST') {
        const r = await this.stopService();
        sendJson(200, { ...r, status: (await this.getStatus()).status });
        return;
      }

      if (pathname === '/restart' && req.method === 'POST') {
        const alive = isPidAlive(readPid());
        const r = alive ? await this.restartService() : await this.startService();
        sendJson(200, { ...r, status: (await this.getStatus()).status });
        return;
      }

      if (pathname === '/config' && req.method === 'GET') {
        sendJson(200, this.publicConfig());
        return;
      }

      if (pathname === '/config' && req.method === 'POST') {
        const body = await readBody();
        const restartIfRunning = body.restartIfRunning === true;
        delete body.restartIfRunning;
        sendJson(200, await this.applyConfig(body, restartIfRunning));
        return;
      }

      if (pathname === '/logs' && req.method === 'GET') {
        const maxLines = Math.min(Number(urlObj.searchParams.get('lines')) || 200, 1000);
        sendJson(200, this.tailLog(maxLines));
        return;
      }

      // 模型下载控制（与字幕服务复用同一套底层下载器）
      if (pathname === '/models/download' && req.method === 'POST') {
        subtitleService.startDownload('asr').catch((err) => {
          console.error('[AsrService] start download error:', err.message);
        });
        sendJson(200, { ok: true, downloadState: subtitleService.downloadState });
        return;
      }

      if (pathname === '/models/cancel-download' && req.method === 'POST') {
        const state = subtitleService.cancelDownload();
        sendJson(200, { ok: true, downloadState: state });
        return;
      }

      if (pathname === '/open-dir' && req.method === 'POST') {
        try {
          fs.mkdirSync(SUBTITLE_MODELS_DIR, { recursive: true });
          spawn('open', [SUBTITLE_MODELS_DIR], { detached: true, stdio: 'ignore' }).unref();
          sendJson(200, { ok: true, path: SUBTITLE_MODELS_DIR });
        } catch (e) {
          sendJson(500, { ok: false, error: e.message });
        }
        return;
      }

      // 流式会话管理接口
      if (pathname === '/live/start' && req.method === 'POST') {
        const startRes = await this.ensureRunning();
        if (!startRes.ok) {
          sendJson(503, { ok: false, error: 'service_not_ready', detail: startRes.detail || startRes.error });
          return;
        }
        const lang = urlObj.searchParams.get('language') || this.config.language || 'Auto';
        const sid = 'live_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
        this.inFlight++;
        const session = this.createLiveSession({
          language: lang,
          onDone: () => {
            this.touch();
          },
        });
        session.createdAt = Date.now();
        this.liveSessions.set(sid, session);
        this.touch();
        sendJson(200, { ok: true, sessionId: sid });
        return;
      }

      if (pathname === '/live/events' && req.method === 'GET') {
        const sid = urlObj.searchParams.get('sessionId');
        const session = this.liveSessions.get(sid);
        if (!session) {
          sendJson(404, { ok: false, error: 'session_not_found' });
          return;
        }
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'Access-Control-Allow-Origin': '*',
        });
        if (session.text) {
          res.write(`data: ${JSON.stringify({ type: 'delta', delta: '', text: session.text })}\n\n`);
        }
        if (session.state === 'done') {
          res.write(`data: ${JSON.stringify({ type: 'done', text: session.text })}\n\n`);
          res.end();
          return;
        }
        session.sseClients.add(res);
        req.on('close', () => {
          session.sseClients.delete(res);
        });
        return;
      }

      if (pathname === '/live/chunk' && req.method === 'POST') {
        const sid = urlObj.searchParams.get('sessionId');
        const session = this.liveSessions.get(sid);
        if (!session) {
          sendJson(404, { ok: false, error: 'session_not_found' });
          return;
        }
        const chunk = await readRawBody();
        session.write(chunk);
        this.touch();
        sendJson(200, { ok: true, received: chunk.length });
        return;
      }

      if (pathname === '/live/finish' && req.method === 'POST') {
        const sid = urlObj.searchParams.get('sessionId');
        const session = this.liveSessions.get(sid);
        if (!session) {
          sendJson(404, { ok: false, error: 'session_not_found' });
          return;
        }
        this.touch();

        if (session.state === 'done') {
          this.inFlight = Math.max(0, this.inFlight - 1);
          this.liveSessions.delete(sid);
          const raw = (session.text || '').trim();
          const text = stripLonePunctuation(raw);
          sendJson(200, {
            ok: true,
            text,
            raw,
            droppedPunctuation: text === '' && raw !== '',
          });
          return;
        }

        let finished = false;
        const timer = setTimeout(() => {
          if (!finished) {
            finished = true;
            this.inFlight = Math.max(0, this.inFlight - 1);
            this.liveSessions.delete(sid);
            const raw = (session.text || '').trim();
            const text = stripLonePunctuation(raw);
            sendJson(200, {
              ok: true,
              text,
              raw,
              droppedPunctuation: text === '' && raw !== '',
            });
          }
        }, 60000);
        timer.unref?.();

        const origDone = session.onDone;
        session.onDone = (finalText, timing) => {
          origDone?.(finalText, timing);
          if (!finished) {
            finished = true;
            clearTimeout(timer);
            this.inFlight = Math.max(0, this.inFlight - 1);
            this.liveSessions.delete(sid);
            const raw = (typeof finalText === 'string' ? finalText : session.text).trim();
            const text = stripLonePunctuation(raw);
            sendJson(200, {
              ok: true,
              text,
              raw,
              droppedPunctuation: text === '' && raw !== '',
            });
          }
        };

        const origError = session.onError;
        session.onError = (err) => {
          origError?.(err);
          if (!finished) {
            finished = true;
            clearTimeout(timer);
            this.inFlight = Math.max(0, this.inFlight - 1);
            this.liveSessions.delete(sid);
            sendJson(502, { ok: false, error: err.message || 'live_error' });
          }
        };

        session.finish();
        return;
      }

      if (pathname === '/live/abort' && req.method === 'POST') {
        const sid = urlObj.searchParams.get('sessionId');
        const session = this.liveSessions.get(sid);
        if (session) {
          session.abort();
          this.liveSessions.delete(sid);
          this.inFlight = Math.max(0, this.inFlight - 1);
        }
        sendJson(200, { ok: true });
        return;
      }

      // 语音转写：现场按需拉起进程（若在待命中），转写完成后刷新闲置计时
      if (pathname === '/transcribe' && req.method === 'POST') {
        const audio = await readRawBody();
        if (!audio || audio.length < 256) {
          sendJson(400, { ok: false, error: 'empty_audio' });
          return;
        }
        const startRes = await this.ensureRunning();
        if (!startRes.ok) {
          sendJson(503, { ok: false, error: 'service_not_ready', detail: startRes.detail || startRes.error });
          return;
        }
        const lang = urlObj.searchParams.get('language') || undefined;
        this.inFlight++;
        try {
          const result = await this.transcribe(audio, lang);
          this.touch();
          sendJson(result.ok ? 200 : 502, result);
        } finally {
          this.inFlight = Math.max(0, this.inFlight - 1);
        }
        return;
      }

      sendJson(404, { error: 'Unknown asr endpoint' });
    } catch (err) {
      console.error('[AsrService] handleApi error:', err);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: err.message }));
      }
    }
  }
}

// ----------------------------- 工具函数 -----------------------------

function extractFinalExtra(streamText, finalText) {
  const final = String(finalText || '');
  if (!final) return '';
  if (final.startsWith(streamText)) {
    return final.slice(streamText.length);
  }
  let common = 0;
  const maxLen = Math.min(streamText.length, final.length);
  while (common < maxLen && streamText[common] === final[common]) {
    common += 1;
  }
  if (common >= streamText.length - 3) {
    return final.slice(streamText.length);
  }
  return '';
}

function isChunkSilent(pcmBuffer, threshold = 180) {
  const sampleCount = pcmBuffer.length >> 1;
  if (sampleCount === 0) return true;
  const step = sampleCount > 512 ? 4 : 1;
  for (let i = 0; i < sampleCount; i += step) {
    const val = pcmBuffer.readInt16LE(i << 1);
    if (val >= threshold || val <= -threshold) return false;
  }
  return true;
}

const PUNCTUATION_ONLY_RE =
  /^[\s,，.．。、!！?？;；:：…‥·•—–\-_~～'"“”‘’`()（）\[\]【】{}｛｝<>＜＞《》〈〉«»\/\\|｜+＋*＊=＝#＃@＆&^%％$＄￥€£]+$/u;

function stripLonePunctuation(text) {
  if (!text) return '';
  return PUNCTUATION_ONLY_RE.test(text) ? '' : text;
}

function extractPcm(buffer) {
  if (!buffer || buffer.length < 44) return buffer;
  if (buffer.slice(0, 4).toString('ascii') === 'RIFF' && buffer.slice(8, 12).toString('ascii') === 'WAVE') {
    let offset = 12;
    while (offset + 8 <= buffer.length) {
      const chunkId = buffer.slice(offset, offset + 4).toString('ascii');
      const chunkSize = buffer.readUInt32LE(offset + 4);
      if (chunkId === 'data') {
        return buffer.slice(offset + 8, offset + 8 + chunkSize);
      }
      offset += 8 + chunkSize;
    }
    return buffer.slice(44);
  }
  return buffer;
}

export const asrService = new AsrService();
