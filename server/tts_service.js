// TTS（文字转语音）服务托管模块 —— Qwen3-TTS 0.6B CustomVoice (MLX 4bit) via mlx-audio
//
// 职责：把「划选朗读」所用的语音合成作为与基础模型、知识库、ASR、字幕并列的受管服务：
//   - 按需启动：第一次朗读时拉起 Python 常驻进程（模型加载约 12–15s），闲置超时自动卸载；
//   - SimpleUI 退出时一并终止（与其它受管服务行为对齐）；
//   - 配置持久化在 tts_config.json（音色 / 语速 / 语言 / 闲置卸载），
//     模型固定放在 ~/Library/Application Support/SimpleUI/models/tts/。
//
// 模型与运行时：
//   - 模型：mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-4bit（964MB，talker 4bit、codec bf16）
//   - 运行时：mlx-audio（Python）。qwen3_tts 族在 audio.cpp 里只有 1.7B CustomVoice 的打包格式，
//     与 cstr / mlx-community 的产物不兼容，因此这里走 Python 侧的自有 HTTP 包装
//     （server/tts/tts_server.py），对 Node 暴露极简接口。
//   - 采样参数保持默认：实测下调 temperature/top_k 会让生成失控；语气只能用 instruct 调，
//     而本功能不需要情绪修饰，故不下发 instruct。
//
// 接口（Node 侧）：
//   GET  /api/tts/status
//   POST /api/tts/{start,stop}
//   GET  /api/tts/config | POST /api/tts/config
//   GET  /api/tts/voices
//   POST /api/tts/speak   {text, voice?, speed?} -> audio/wav

import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import https from 'https';
import { fileURLToPath } from 'url';
import { startWatchdog } from './watchdog.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const HOME = os.homedir();

const USER_DIR = path.join(HOME, 'Library', 'Application Support', 'SimpleUI');
const CONFIG_FILE = path.join(USER_DIR, 'tts_config.json');
const MODEL_DIR = path.join(USER_DIR, 'models', 'tts');
const LOG_FILE = process.env.SIMPLEUI_TTS_LOG || path.join(HOME, 'Library', 'Logs', 'simpleui-tts.log');
const PID_FILE = '/tmp/simpleui_tts.pid';
const SCRIPT = path.join(__dirname, 'tts', 'tts_server.py');

const PORT = 1255;
const VOICES = ['serena', 'vivian', 'aiden', 'ryan', 'sohee', 'ono_anna', 'uncle_fu', 'dylan', 'eric'];

const DEFAULT_CONFIG = {
  enabled: true,
  voice: 'serena',
  speed: 1.0,
  language: 'auto',
  idleUnloadMin: 5,
};

const REQUIRED_FILES = ['config.json', 'model.safetensors', 'tokenizer_config.json', 'vocab.json'];

// 模型来源：mlx-community 的 4bit 转换。根目录是 talker，speech_tokenizer/ 是独立 codec，
// 两者缺一不可（缺 codec 会报 Speech tokenizer not loaded）。
const MODEL_REPO = 'mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-4bit';
const MODEL_FILES = [
  { path: 'model.safetensors', size: 1006772520 },
  { path: 'speech_tokenizer/model.safetensors', size: 682293092 },
  { path: 'vocab.json', size: 2776833 },
  { path: 'merges.txt', size: 1671839 },
  { path: 'model.safetensors.index.json', size: 71447 },
  { path: 'tokenizer_config.json', size: 7344 },
  { path: 'config.json', size: 6058 },
  { path: 'generation_config.json', size: 288 },
  { path: 'preprocessor_config.json', size: 127 },
  { path: 'speech_tokenizer/config.json', size: 2336 },
  { path: 'speech_tokenizer/preprocessor_config.json', size: 234 },
  { path: 'speech_tokenizer/configuration.json', size: 76 },
];

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readPid() {
  try {
    const raw = fs.readFileSync(PID_FILE, 'utf-8').trim();
    const pid = parseInt(raw, 10);
    return Number.isInteger(pid) ? pid : null;
  } catch {
    return null;
  }
}

function writePid(pid) {
  try {
    fs.writeFileSync(PID_FILE, String(pid));
  } catch {}
}

function clearPid() {
  try {
    if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE);
  } catch {}
}

class TtsService {
  constructor() {
    this.proc = null;
    this.starting = null;
    this.config = { ...DEFAULT_CONFIG };
    this.lastUsedAt = 0;
    this.idleTimer = null;
    this.watchdog = null;
    this.loadError = null;
    this.download = { active: false, doneBytes: 0, currentFile: null, error: null, updatedAt: 0 };
  }

  // ----------------------------- 配置 -----------------------------

  loadConfig() {
    try {
      if (fs.existsSync(CONFIG_FILE)) {
        const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
        this.config = { ...DEFAULT_CONFIG, ...parsed };
      }
    } catch (e) {
      console.warn('[TTS] 读取配置失败，使用默认值:', e.message);
    }
  }

  saveConfig() {
    try {
      if (!fs.existsSync(USER_DIR)) fs.mkdirSync(USER_DIR, { recursive: true });
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(this.config, null, 2));
    } catch (e) {
      console.warn('[TTS] 保存配置失败:', e.message);
    }
  }

  // ----------------------------- 模型下载 -----------------------------

  downloadStatus() {
    const totalBytes = MODEL_FILES.reduce((a, f) => a + f.size, 0);
    return { ...this.download, totalBytes };
  }

  async startDownload() {
    if (this.download.active) return { ok: true, alreadyRunning: true };
    this.download = { active: true, doneBytes: 0, currentFile: MODEL_FILES[0]?.path || null, error: null, updatedAt: Date.now() };

    (async () => {
      try {
        for (const file of MODEL_FILES) {
          const dest = path.join(MODEL_DIR, file.path);
          const dir = path.dirname(dest);
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
          let existing = 0;
          try {
            existing = fs.statSync(dest).size;
          } catch {}
          if (existing === file.size) {
            this.download.doneBytes += existing;
            continue;
          }
          this.download.currentFile = file.path;
          this.download.updatedAt = Date.now();
          await this.downloadFile(file, dest, existing > 0 && existing < file.size);
        }
        this.download = { ...this.download, active: false, currentFile: null, updatedAt: Date.now() };
      } catch (e) {
        this.download = { ...this.download, active: false, error: e.message, updatedAt: Date.now() };
        console.warn('[TTS] 模型下载失败:', e.message);
      }
    })();

    return { ok: true, started: true };
  }

  downloadFile(file, dest, resume) {
    const url = `https://huggingface.co/${MODEL_REPO}/resolve/main/${file.path}`;
    const already = resume ? fs.statSync(dest).size : 0;
    const target = dest + (resume ? '.part' : '');
    if (resume) {
      try {
        fs.renameSync(dest, target);
      } catch {}
    }

    const fetchOnce = (u, redirects, done) => {
      const mod = u.startsWith('https') ? https : http;
      const req = mod.get(u, { headers: already ? { Range: `bytes=${already}-` } : {} }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
          res.resume();
          fetchOnce(new URL(res.headers.location, u).toString(), redirects - 1, done);
          return;
        }
        if (res.statusCode !== 200 && res.statusCode !== 206) {
          res.resume();
          done(new Error(`HTTP ${res.statusCode} for ${file.path}`));
          return;
        }
        const sink = fs.createWriteStream(target, { flags: already ? 'a' : 'w' });
        res.on('data', (chunk) => {
          this.download.doneBytes += chunk.length;
          this.download.updatedAt = Date.now();
        });
        res.pipe(sink);
        sink.on('finish', () => {
          try {
            fs.renameSync(target, dest);
            done(null);
          } catch (e) {
            done(e);
          }
        });
        sink.on('error', done);
      });
      req.on('error', done);
      req.setTimeout(60000, () => {
        req.destroy(new Error('download timeout'));
      });
    };

    return new Promise((resolve, reject) => {
      fetchOnce(url, 5, (err) => (err ? reject(err) : resolve()));
    });
  }

  // ----------------------------- 运行时探测 -----------------------------

  resolvePython() {
    const candidates = [
      process.env.SIMPLEUI_TTS_PYTHON,
      path.join(__dirname, 'tts', 'python', 'bin', 'python3'),
      path.join(process.resourcesPath || '', 'tts', 'python', 'bin', 'python3'),
      path.join(HOME, '.workbuddy', 'binaries', 'python', 'envs', 'default', 'bin', 'python3'),
    ].filter(Boolean);
    for (const c of candidates) {
      try {
        if (fs.existsSync(c)) return c;
      } catch {}
    }
    return 'python3';
  }

  modelStatus() {
    const missing = REQUIRED_FILES.filter((f) => {
      try {
        return !fs.existsSync(path.join(MODEL_DIR, f));
      } catch {
        return true;
      }
    });
    let bytes = 0;
    const walk = (dir) => {
      try {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(full);
          else {
            try {
              bytes += fs.statSync(full).size;
            } catch {}
          }
        }
      } catch {}
    };
    walk(MODEL_DIR);
    return { dir: MODEL_DIR, ready: missing.length === 0, missing, bytes };
  }

  isRunning() {
    return isPidAlive(this.proc?.pid || readPid());
  }

  // ----------------------------- 生命周期 -----------------------------

  /**
   * 兜底守护：与 ttf / asr 同一套实现（server/watchdog.js）。
   * 代理被 SIGKILL 时由它按 PID 精确终止 tts_server.py；正常退出走 proxy 的退出钩子。
   */
  ensureWatchdog() {
    if (this.watchdog) return;
    try {
      this.watchdog = startWatchdog({
        pidFile: PID_FILE,
        binaryBasename: 'tts_server.py',
      });
    } catch {
      // watchdog 失败不阻断启动
    }
  }

  async start() {
    if (this.config.enabled === false) return { ok: false, error: 'DISABLED' };
    if (this.isRunning()) return { ok: true, alreadyRunning: true };
    if (this.starting) return this.starting;

    const model = this.modelStatus();
    if (!model.ready) {
      return { ok: false, error: 'MODEL_MISSING', missing: model.missing, dir: model.dir };
    }

    const python = this.resolvePython();
    const startedAt = Date.now();
    this.loadError = null;

    this.starting = new Promise((resolve) => {
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        this.starting = null;
        resolve(result);
      };

      let logStream = null;
      try {
        if (!fs.existsSync(path.dirname(LOG_FILE))) fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
        logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
      } catch {}

      const child = spawn(python, [SCRIPT, '--model-dir', MODEL_DIR, '--port', String(PORT)], {
        cwd: __dirname,
        env: { ...process.env, PYTHONUNBUFFERED: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      this.proc = child;
      if (child.pid) writePid(child.pid);
      this.ensureWatchdog();

      const onData = (buf) => {
        try {
          logStream?.write(buf);
        } catch {}
      };
      child.stdout?.on('data', onData);
      child.stderr?.on('data', onData);

      child.on('exit', (code, signal) => {
        this.proc = null;
        clearPid();
        try {
          logStream?.end();
        } catch {}
        if (!settled) {
          finish({ ok: false, error: 'EXITED', code, signal, log: LOG_FILE });
        }
      });

      // 轮询 /health，直到 ready（模型加载 12–15s，留足余量）
      const deadline = Date.now() + 180000;
      const poll = () => {
        if (settled) return;
        if (Date.now() > deadline) {
          finish({ ok: false, error: 'TIMEOUT', log: LOG_FILE });
          return;
        }
        http
          .get({ host: '127.0.0.1', port: PORT, path: '/health', timeout: 2000 }, (res) => {
            let body = '';
            res.on('data', (c) => (body += c));
            res.on('end', () => {
              try {
                const obj = JSON.parse(body);
                if (obj.ready) {
                  finish({ ok: true, loadMs: Date.now() - startedAt });
                  return;
                }
              } catch {}
              setTimeout(poll, 400);
            });
          })
          .on('error', () => setTimeout(poll, 400));
      };
      poll();
    });

    const result = await this.starting;
    if (result.ok) this.touch();
    return result;
  }

  /**
   * 每次成功合成后重置闲置计时；到点仍无请求就卸载模型（懒加载的配套回收）。
   * idleUnloadMin = 0 表示不自动卸载。
   */
  touch() {
    this.lastUsedAt = Date.now();
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const minutes = Number(this.config.idleUnloadMin) || 0;
    if (minutes <= 0) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (!this.isRunning()) return;
      const idleMs = Date.now() - this.lastUsedAt;
      if (idleMs < minutes * 60_000) {
        this.touch();
        return;
      }
      console.log(`[TTS] 闲置 ${minutes} 分钟，卸载模型并停止服务`);
      this.stop();
    }, minutes * 60_000);
    this.idleTimer.unref?.();
  }

  stop() {
    const pid = this.proc?.pid || readPid();
    if (isPidAlive(pid)) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {}
      setTimeout(() => {
        if (!isPidAlive(pid)) return;
        try {
          process.kill(pid, 'SIGKILL');
        } catch {}
      }, 1500).unref?.();
    }
    this.proc = null;
    clearPid();
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    return { ok: true };
  }

  // 正常退出：与 asr/ttf 一致，只发 SIGTERM，由子进程自行收尾
  shutdownSync() {
    const pid = this.proc?.pid || readPid();
    if (isPidAlive(pid)) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {}
    }
    this.proc = null;
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  // 最后一道：进程已退出时兜底 SIGKILL 并清 PID 文件
  shutdownForce() {
    const pid = this.proc?.pid || readPid();
    if (isPidAlive(pid)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
    }
    this.proc = null;
    clearPid();
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  // ----------------------------- 合成 -----------------------------

  async speak(text, { voice, speed } = {}) {
    if (this.config.enabled === false) return { ok: false, error: 'DISABLED' };
    const trimmed = String(text || '').trim();
    if (!trimmed) return { ok: false, error: 'EMPTY_TEXT' };

    if (!this.isRunning()) {
      const started = await this.start();
      if (!started.ok) return started;
    }

    const payload = JSON.stringify({
      text: trimmed.slice(0, 4000),
      voice: voice || this.config.voice || DEFAULT_CONFIG.voice,
      language: this.config.language || 'auto',
      speed: Number(speed ?? this.config.speed) || 1.0,
    });

    const result = await new Promise((resolve) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: PORT,
          path: '/speak',
          method: 'POST',
          timeout: 180000,
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const buf = Buffer.concat(chunks);
            if (res.statusCode === 200) resolve({ ok: true, wav: buf });
            else resolve({ ok: false, error: 'SPEAK_FAILED', status: res.statusCode, body: buf.toString('utf-8').slice(0, 400) });
          });
        }
      );
      req.on('error', (e) => resolve({ ok: false, error: 'SPEAK_ERROR', message: e.message }));
      req.on('timeout', () => {
        req.destroy();
        resolve({ ok: false, error: 'SPEAK_TIMEOUT' });
      });
      req.write(payload);
      req.end();
    });

    if (result.ok) this.touch();
    return result;
  }

  async getStatus() {
    const model = this.modelStatus();
    const running = this.isRunning();
    let ready = false;
    let voices = VOICES;
    if (running) {
      ready = await new Promise((resolve) => {
        http
          .get({ host: '127.0.0.1', port: PORT, path: '/health', timeout: 1500 }, (res) => {
            let body = '';
            res.on('data', (c) => (body += c));
            res.on('end', () => {
              try {
                const obj = JSON.parse(body);
                if (Array.isArray(obj.voices) && obj.voices.length) voices = obj.voices;
                resolve(Boolean(obj.ready));
              } catch {
                resolve(false);
              }
            });
          })
          .on('error', () => resolve(false));
      });
    }
    return {
      enabled: this.config.enabled !== false,
      status:
        this.config.enabled === false
          ? 'disabled'
          : !model.ready
          ? 'incomplete'
          : running
          ? ready
            ? 'ready'
            : 'loading'
          : 'standby',
      running,
      ready,
      model,
      voices,
      config: { ...this.config },
      python: this.resolvePython(),
      port: PORT,
      logFile: LOG_FILE,
    };
  }

  // ----------------------------- HTTP API -----------------------------

  async handleApi(req, res) {
    const host = req.headers.host || '127.0.0.1:31235';
    const urlObj = new URL(req.url, `http://${host}`);
    const pathname = urlObj.pathname.replace(/^\/api\/tts/, '');

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
    const readJson = () =>
      new Promise((resolve, reject) => {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          try {
            resolve(JSON.parse(body || '{}'));
          } catch (e) {
            reject(e);
          }
        });
        req.on('error', reject);
      });

    try {
      if (pathname === '/status' && req.method === 'GET') {
        sendJson(200, await this.getStatus());
        return;
      }
      if (pathname === '/start' && req.method === 'POST') {
        const r = await this.start();
        sendJson(200, { ...r, status: (await this.getStatus()).status });
        return;
      }
      if (pathname === '/stop' && req.method === 'POST') {
        this.stop();
        sendJson(200, { ok: true, status: (await this.getStatus()).status });
        return;
      }
      if (pathname === '/config') {
        if (req.method === 'GET') {
          sendJson(200, { ...this.config });
          return;
        }
        const body = await readJson();
        if (body.voice && !VOICES.includes(body.voice)) {
          sendJson(400, { ok: false, error: 'UNKNOWN_VOICE' });
          return;
        }
        this.config = {
          ...this.config,
          ...(body.enabled !== undefined ? { enabled: Boolean(body.enabled) } : {}),
          ...(body.voice ? { voice: body.voice } : {}),
          ...(body.speed !== undefined ? { speed: Math.min(2, Math.max(0.5, Number(body.speed) || 1)) } : {}),
          ...(body.language ? { language: String(body.language) } : {}),
          ...(body.idleUnloadMin !== undefined ? { idleUnloadMin: Math.max(0, Number(body.idleUnloadMin) || 0) } : {}),
        };
        this.saveConfig();
        // 关闭服务时立即释放常驻模型（否则 1.9GB 会一直占着）
        if (this.config.enabled === false) this.stop();
        sendJson(200, { ok: true, config: { ...this.config } });
        return;
      }
      if (pathname === '/voices' && req.method === 'GET') {
        const status = await this.getStatus();
        sendJson(200, { voices: status.voices });
        return;
      }
      if (pathname === '/download' && req.method === 'POST') {
        const r = await this.startDownload();
        sendJson(200, { ...r, download: this.downloadStatus() });
        return;
      }
      if (pathname === '/download/status' && req.method === 'GET') {
        sendJson(200, this.downloadStatus());
        return;
      }
      if (pathname === '/speak' && req.method === 'POST') {
        const body = await readJson();
        const result = await this.speak(body.text, { voice: body.voice, speed: body.speed });
        if (!result.ok) {
          const code = result.error === 'DISABLED' ? 403 : result.error === 'MODEL_MISSING' ? 409 : 500;
          sendJson(code, result);
          return;
        }
        res.writeHead(200, {
          'Content-Type': 'audio/wav',
          'Content-Length': result.wav.length,
          'Cache-Control': 'no-store',
        });
        res.end(result.wav);
        return;
      }
      sendJson(404, { error: 'NOT_FOUND' });
    } catch (e) {
      sendJson(500, { error: 'TTS_API_FAILED', message: e.message });
    }
  }

  init() {
    this.loadConfig();
    // 懒加载：启动时不拉起模型（首次朗读才加载，闲置 5 分钟自动卸载）。
    // 上次运行残留的进程由 App 启动前的 cleanStaleProcessesBeforeLaunch（managedPidFiles）统一清理，
    // 这里只清掉已失效的 PID 文件。
    const pid = readPid();
    if (!isPidAlive(pid)) clearPid();
  }
}

export const ttsService = new TtsService();
