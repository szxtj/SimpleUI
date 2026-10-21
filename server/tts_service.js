// TTS（文字转语音）服务托管模块 —— Qwen3-TTS 0.6B CustomVoice (MLX 4bit) via mlx-audio
//
// 职责：把「朗读回答」所用的语音合成作为与基础模型、知识库、ASR、字幕并列的受管服务：
//   - 按需启动：第一次朗读时拉起 Python 常驻进程（模型加载约 12–15s），闲置超时自动卸载；
//   - SimpleUI 退出时一并终止（与其它受管服务行为对齐）；
//   - 配置持久化在 tts_config.json（音色 / 语速 / 语言 / 闲置卸载），
//     模型固定放在 ~/Library/Application Support/SimpleUI/models/tts/。
//
// 与「实时字幕服务」（server/subtitle_service.js）同构 —— 两者都是纯按需生命周期，
// 服务面板里不再留常驻启停开关：
//   - 没有 enabled 总开关：朗读入口常驻；模型只在首次朗读时加载，闲置自动卸载；
//   - 模型下载采用与字幕一致的「双源自动测速 + 断点续传 + 可取消 + 实时进度」；
//   - 服务面板展示内置运行环境、模型完备状态与下载进度，并提供「打开模型目录」。
//
// 模型与运行时：
//   - 模型：mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-4bit（约 1.6GB，talker 4bit、codec bf16）
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
//   GET  /api/tts/download/status | POST /api/tts/download | POST /api/tts/download/cancel
//   POST /api/tts/open-dir

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
  voice: 'serena',
  speed: 1.0,
  language: 'auto',
  idleUnloadMin: 5,
};

// ---- 模型清单（与字幕服务对齐：每个文件带 minBytes，按磁盘实际大小校验完整性）----

const MODEL_KEY = 'tts';
const MODEL_NAME = 'Qwen3-TTS 0.6B CustomVoice (MLX 4bit)';
const MODEL_SHORT_NAME = 'Qwen3-TTS 0.6B';
const MODEL_SIZE_DESC = '1.6 GB';

// 模型来源：mlx-community 的 4bit 转换。根目录是 talker，speech_tokenizer/ 是独立 codec，
// 两者缺一不可（缺 codec 会报 Speech tokenizer not loaded）。
const MODEL_REPO = 'mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-4bit';
const MODEL_FILES = [
  { path: 'model.safetensors', expectedBytes: 1006772520, minBytes: 990000000, required: true },
  { path: 'speech_tokenizer/model.safetensors', expectedBytes: 682293092, minBytes: 670000000, required: true },
  { path: 'vocab.json', expectedBytes: 2776833, minBytes: 2700000, required: true },
  { path: 'merges.txt', expectedBytes: 1671839, minBytes: 1600000, required: true },
  { path: 'model.safetensors.index.json', expectedBytes: 71447, minBytes: 70000, required: false },
  { path: 'tokenizer_config.json', expectedBytes: 7344, minBytes: 7000, required: true },
  { path: 'config.json', expectedBytes: 6058, minBytes: 5000, required: true },
  { path: 'generation_config.json', expectedBytes: 245, minBytes: 200, required: false },
  { path: 'preprocessor_config.json', expectedBytes: 127, minBytes: 100, required: false },
  { path: 'speech_tokenizer/config.json', expectedBytes: 2336, minBytes: 2000, required: true },
  { path: 'speech_tokenizer/preprocessor_config.json', expectedBytes: 234, minBytes: 200, required: false },
  { path: 'speech_tokenizer/configuration.json', expectedBytes: 76, minBytes: 50, required: false },
];
const MODEL_TOTAL_BYTES = MODEL_FILES.reduce((a, f) => a + f.expectedBytes, 0);

// 官方源与国内高速镜像源定义（与字幕服务保持同一套双源策略）
const DOWNLOAD_SOURCES = [
  {
    id: 'mirror',
    name: '国内高速镜像源 (hf-mirror.com)',
    baseUrl: 'https://hf-mirror.com',
  },
  {
    id: 'official',
    name: 'HuggingFace 官方源 (huggingface.co)',
    baseUrl: 'https://huggingface.co',
  },
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
    this.downloadAbortController = null;
    this.download = {
      active: false,
      phase: 'idle',
      targetModel: null,
      currentModelKey: null,
      currentModelName: '',
      currentFile: '',
      selectedSource: null,
      downloadedBytes: 0,
      totalBytes: MODEL_TOTAL_BYTES,
      progressPercent: 0,
      speedBps: 0,
      etaSeconds: null,
      error: null,
      updatedAt: 0,
    };
  }

  // ----------------------------- 配置 -----------------------------

  loadConfig() {
    try {
      if (fs.existsSync(CONFIG_FILE)) {
        const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
        // 旧版本可能有 enabled 字段：不再作为服务开关，加载时直接丢弃。
        delete parsed.enabled;
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
    return { ...this.download };
  }

  /**
   * 发起支持自动重定向（301/302/307/308）的 HTTP/HTTPS 请求。
   * 与字幕服务同一实现，供测速与断点续传下载共用。
   */
  httpRequestWithRedirects(urlStr, options = {}, maxRedirects = 5) {
    return new Promise((resolve, reject) => {
      const follow = (currentUrl, redirectsLeft) => {
        let parsedUrl;
        try {
          parsedUrl = new URL(currentUrl);
        } catch (err) {
          reject(err);
          return;
        }

        const client = parsedUrl.protocol === 'https:' ? https : http;
        const reqOpts = {
          hostname: parsedUrl.hostname,
          port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
          path: parsedUrl.pathname + parsedUrl.search,
          method: options.method || 'GET',
          headers: {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) SimpleUI/1.0',
            ...(options.headers || {}),
          },
        };

        const req = client.request(reqOpts, (res) => {
          if (
            res.statusCode >= 300 &&
            res.statusCode < 400 &&
            res.headers.location &&
            redirectsLeft > 0
          ) {
            res.resume();
            const nextUrl = new URL(res.headers.location, currentUrl).toString();
            follow(nextUrl, redirectsLeft - 1);
            return;
          }
          resolve({ req, res, finalUrl: currentUrl });
        });

        if (options.signal) {
          if (options.signal.aborted) {
            req.destroy(new Error('Download cancelled'));
            return;
          }
          options.signal.addEventListener(
            'abort',
            () => {
              req.destroy(new Error('Download cancelled'));
            },
            { once: true }
          );
        }

        req.on('timeout', () => {
          req.destroy(new Error('Request timeout'));
        });
        req.on('error', (err) => {
          reject(err);
        });
        req.end();
      };

      follow(urlStr, maxRedirects);
    });
  }

  /**
   * 并发对官方源 (huggingface.co) 与国内镜像源 (hf-mirror.com) 进行真实数据块拉取测速，
   * 选出延迟最低、吞吐最快的源作为主下载源，另一源作为故障自动切换备份。
   */
  async probeBestMirror(signal, probeRelative) {
    const probeSingleSource = async (source) => {
      const testUrl = `${source.baseUrl}/${probeRelative}`;
      const startTime = Date.now();
      try {
        const { res } = await this.httpRequestWithRedirects(
          testUrl,
          {
            method: 'GET',
            headers: { Range: 'bytes=0-32767' },
            timeout: 4000,
            signal,
          },
          4
        );

        if (res.statusCode !== 200 && res.statusCode !== 206) {
          res.resume();
          return { ...source, ok: false, latencyMs: Infinity, speedKbps: 0 };
        }

        let bytes = 0;
        await new Promise((resolve) => {
          const onEnd = () => resolve();
          res.on('data', (c) => (bytes += c.length));
          res.on('end', onEnd);
          res.on('error', onEnd);
          res.on('aborted', onEnd);
        });
        const elapsedMs = Date.now() - startTime;
        const speedKbps = elapsedMs > 0 ? Math.round((bytes / 1024 / elapsedMs) * 1000) : 0;
        return { ...source, ok: true, latencyMs: elapsedMs, speedKbps };
      } catch {
        return { ...source, ok: false, latencyMs: Infinity, speedKbps: 0 };
      }
    };

    const results = await Promise.all(DOWNLOAD_SOURCES.map((s) => probeSingleSource(s)));
    const okResults = results.filter((r) => r.ok);
    if (okResults.length === 0) return null;
    okResults.sort((a, b) => {
      const scoreA = a.latencyMs / Math.max(1, a.speedKbps);
      const scoreB = b.latencyMs / Math.max(1, b.speedKbps);
      return scoreA - scoreB;
    });
    return okResults[0];
  }

  /**
   * 清理模型目录内的下载临时碎片（.part / .tmp / .download）。
   * 仅在下载成功收尾时移除 .part；中途取消/失败保留 .part 以支持断点续传。
   */
  cleanTempFiles({ removePartFiles = false } = {}) {
    if (!fs.existsSync(MODEL_DIR)) return { removed: [] };
    const removed = [];
    const walk = (dir) => {
      try {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            walk(full);
          } else if (
            (removePartFiles && entry.name.endsWith('.part')) ||
            entry.name.endsWith('.tmp') ||
            entry.name.endsWith('.download')
          ) {
            fs.rmSync(full, { force: true });
            removed.push(path.relative(MODEL_DIR, full));
          }
        }
      } catch {}
    };
    walk(MODEL_DIR);
    if (removed.length > 0) {
      console.log(`[TTS] 🧹 已自动清理下载临时文件: ${removed.join(', ')}`);
    }
    return { removed };
  }

  /**
   * 一键测速并下载缺失模型（双源自动选优 + 断点续传 + 可取消）。
   */
  async startDownload() {
    if (this.download.active) return this.downloadStatus();
    if (this.modelStatus().ready) return this.downloadStatus();

    this.downloadAbortController = new AbortController();
    const signal = this.downloadAbortController.signal;

    this.download = {
      ...this.download,
      active: true,
      phase: 'probing',
      targetModel: MODEL_KEY,
      currentModelKey: MODEL_KEY,
      currentModelName: MODEL_NAME,
      currentFile: '',
      selectedSource: null,
      downloadedBytes: 0,
      totalBytes: MODEL_TOTAL_BYTES,
      progressPercent: 0,
      speedBps: 0,
      etaSeconds: null,
      error: null,
      updatedAt: Date.now(),
    };

    try {
      const probeFile = MODEL_FILES.reduce((a, b) =>
        (Number(b.expectedBytes) || 0) > (Number(a.expectedBytes) || 0) ? b : a
      );
      const probeRelative = `${MODEL_REPO}/resolve/main/${probeFile.path}`;

      const best = await this.probeBestMirror(signal, probeRelative);
      if (signal.aborted) throw new Error('cancelled');
      if (!best) throw new Error('所有下载源均不可达，请检查网络后重试');
      this.download.selectedSource = {
        id: best.id,
        name: best.name,
        latencyMs: best.latencyMs,
        speedKbps: best.speedKbps,
      };

      const backupSources = DOWNLOAD_SOURCES.filter((s) => s.id !== best.id);
      const candidateSources = [best, ...backupSources];

      this.download.phase = 'downloading';

      for (const file of MODEL_FILES) {
        if (signal.aborted) throw new Error('cancelled');
        const dst = path.join(MODEL_DIR, file.path);
        if (fs.existsSync(dst) && fs.statSync(dst).size >= file.minBytes) continue;

        fs.mkdirSync(path.dirname(dst), { recursive: true });
        const partPath = `${dst}.part`;

        let fileDone = false;
        let lastErr = null;

        for (const srcNode of candidateSources) {
          if (signal.aborted) throw new Error('cancelled');
          const url = `${srcNode.baseUrl}/${MODEL_REPO}/resolve/main/${file.path}`;
          let existingBytes = 0;
          try {
            if (fs.existsSync(partPath)) {
              existingBytes = fs.statSync(partPath).size;
            }
          } catch {
            existingBytes = 0;
          }

          try {
            await new Promise((resolve, reject) => {
              const headers = existingBytes > 0 ? { Range: `bytes=${existingBytes}-` } : {};
              this.httpRequestWithRedirects(
                url,
                { method: 'GET', headers, timeout: 30000, signal },
                5
              )
                .then(({ res }) => {
                  if (res.statusCode !== 200 && res.statusCode !== 206) {
                    res.resume();
                    reject(new Error(`HTTP ${res.statusCode}`));
                    return;
                  }
                  const isResume = res.statusCode === 206 && existingBytes > 0;
                  const baseOffset = isResume ? existingBytes : 0;
                  const contentLen = Number(res.headers['content-length'] || 0);
                  const total =
                    contentLen > 0 ? baseOffset + contentLen : Number(file.expectedBytes || 0);
                  this.download.totalBytes = total;
                  this.download.downloadedBytes = baseOffset;
                  this.download.currentFile = file.path;
                  this.download.updatedAt = Date.now();

                  const fileStream = fs.createWriteStream(partPath, {
                    flags: isResume ? 'a' : 'w',
                  });
                  fileStream.on('error', (err) => {
                    res.destroy();
                    reject(err);
                  });
                  let downloaded = baseOffset;
                  let lastTick = Date.now();
                  let lastBytes = baseOffset;

                  res.on('data', (chunk) => {
                    downloaded += chunk.length;
                    if (!fileStream.write(chunk)) {
                      res.pause();
                      fileStream.once('drain', () => res.resume());
                    }
                    const now = Date.now();
                    if (now - lastTick >= 400) {
                      const dt = (now - lastTick) / 1000;
                      this.download.speedBps = Math.round((downloaded - lastBytes) / dt);
                      lastTick = now;
                      lastBytes = downloaded;
                      this.download.downloadedBytes = downloaded;
                      this.download.progressPercent = total
                        ? Math.min(99, Math.round((downloaded / total) * 100))
                        : 0;
                      this.download.etaSeconds =
                        this.download.speedBps > 0 && total > downloaded
                          ? Math.round((total - downloaded) / this.download.speedBps)
                          : null;
                      this.download.updatedAt = now;
                    }
                  });
                  res.on('error', (err) => {
                    fileStream.destroy();
                    reject(err);
                  });
                  res.on('aborted', () => {
                    fileStream.destroy();
                    reject(new Error('Download aborted'));
                  });
                  res.on('end', () => {
                    fileStream.end();
                    fileStream.on('finish', () => {
                      try {
                        const finalSize = fs.statSync(partPath).size;
                        if (finalSize < file.minBytes) {
                          reject(new Error(`文件未完整下载 (${finalSize} < ${file.minBytes})`));
                          return;
                        }
                        fs.renameSync(partPath, dst);
                        resolve();
                      } catch (e) {
                        reject(e);
                      }
                    });
                    fileStream.on('error', (err) => {
                      reject(err);
                    });
                  });
                })
                .catch(reject);
            });
            fileDone = true;
            break;
          } catch (err) {
            lastErr = err;
            if (
              signal.aborted ||
              err.message === 'cancelled' ||
              err.message === 'Download cancelled'
            ) {
              throw new Error('cancelled');
            }
            console.warn(`[TTS] 源 ${srcNode.name} 下载中断，尝试切换备用源:`, err.message);
          }
        }

        if (!fileDone) {
          throw lastErr || new Error(`下载失败: ${file.path}`);
        }
      }

      this.download.phase = 'cleaning';
      this.cleanTempFiles({ removePartFiles: true });
      this.download.phase = 'completed';
      this.download.active = false;
      this.download.progressPercent = 100;
      this.download.updatedAt = Date.now();
    } catch (err) {
      const cancelled =
        signal.aborted || err.message === 'cancelled' || err.message === 'Download cancelled';
      this.download.phase = cancelled ? 'cancelled' : 'error';
      this.download.error = cancelled ? null : err.message || '下载失败';
      this.download.active = false;
      this.download.updatedAt = Date.now();
      if (!cancelled) console.warn('[TTS] 模型下载失败:', err.message);
    } finally {
      this.downloadAbortController = null;
    }

    return this.downloadStatus();
  }

  cancelDownload() {
    if (this.downloadAbortController) {
      this.downloadAbortController.abort();
      this.downloadAbortController = null;
    }
    this.download.phase = 'cancelled';
    this.download.active = false;
    this.download.updatedAt = Date.now();
    return this.downloadStatus();
  }

  // ----------------------------- 运行时探测 -----------------------------

  resolvePython() {
    const candidates = [
      process.env.SIMPLEUI_TTS_PYTHON,
      path.join(__dirname, 'tts', 'python', 'bin', 'python3'),
      path.join(process.resourcesPath || '', 'tts', 'python', 'bin', 'python3'),
      // 开发态项目内置运行时（与 build_mac_app.sh 打包来源一致）
      path.resolve(__dirname, '..', 'bin', 'tts_runtime', 'python', 'bin', 'python3'),
      path.join(HOME, '.workbuddy', 'binaries', 'python', 'envs', 'default', 'bin', 'python3'),
    ].filter(Boolean);
    for (const c of candidates) {
      try {
        if (fs.existsSync(c)) return c;
      } catch {}
    }
    return 'python3';
  }

  /** 内置运行环境（可移植 Python + mlx-audio）是否就绪 */
  runtimeStatus() {
    const python = this.resolvePython();
    const isFallback = python === 'python3';
    return {
      ready: isFallback ? false : fs.existsSync(python),
      path: python,
      bundled: !isFallback,
    };
  }

  modelStatus() {
    const files = MODEL_FILES.map((f) => {
      const full = path.join(MODEL_DIR, f.path);
      let size = 0;
      let exists = false;
      try {
        const st = fs.statSync(full);
        exists = st.isFile();
        size = exists ? st.size : 0;
      } catch {
        exists = false;
      }
      return {
        path: f.path,
        exists,
        size,
        minBytes: f.minBytes,
        expectedBytes: f.expectedBytes,
        required: Boolean(f.required),
        ready: exists && size >= f.minBytes,
      };
    });

    const required = files.filter((f) => f.required);
    const missing = required.filter((f) => !f.ready).map((f) => f.path);

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

    return {
      key: MODEL_KEY,
      name: MODEL_NAME,
      shortName: MODEL_SHORT_NAME,
      dir: MODEL_DIR,
      ready: missing.length === 0,
      missing,
      bytes,
      expectedBytes: MODEL_TOTAL_BYTES,
      sizeDesc: MODEL_SIZE_DESC,
      path: path.join(MODEL_DIR, MODEL_FILES[0]?.path || ''),
    };
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
    if (this.isRunning()) return { ok: true, alreadyRunning: true };
    if (this.starting) return this.starting;

    const model = this.modelStatus();
    if (!model.ready) {
      return { ok: false, error: 'MODEL_MISSING', missing: model.missing, dir: model.dir };
    }

    const runtime = this.runtimeStatus();
    const python = runtime.path;
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
    const runtime = this.runtimeStatus();
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
      status: !model.ready
        ? 'incomplete'
        : running
        ? ready
          ? 'ready'
          : 'loading'
        : 'standby',
      running,
      ready,
      modelsReady: model.ready,
      runtimeReady: runtime.ready,
      model,
      runtime,
      voices,
      config: { ...this.config },
      python: runtime.path,
      port: PORT,
      logFile: LOG_FILE,
      download: this.downloadStatus(),
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
          ...(body.voice ? { voice: body.voice } : {}),
          ...(body.speed !== undefined ? { speed: Math.min(2, Math.max(0.5, Number(body.speed) || 1)) } : {}),
          ...(body.language ? { language: String(body.language) } : {}),
          ...(body.idleUnloadMin !== undefined ? { idleUnloadMin: Math.max(0, Number(body.idleUnloadMin) || 0) } : {}),
        };
        this.saveConfig();
        sendJson(200, { ok: true, config: { ...this.config } });
        return;
      }
      if (pathname === '/voices' && req.method === 'GET') {
        const status = await this.getStatus();
        sendJson(200, { voices: status.voices });
        return;
      }
      if (pathname === '/download' && req.method === 'POST') {
        // 立即返回，后台继续下载；进度由 /api/tts/status 轮询获取。
        this.startDownload().catch((err) => {
          console.warn('[TTS] download error:', err.message);
        });
        sendJson(200, { ok: true, downloadState: this.downloadStatus() });
        return;
      }
      if (pathname === '/download/status' && req.method === 'GET') {
        sendJson(200, this.downloadStatus());
        return;
      }
      if (pathname === '/download/cancel' && req.method === 'POST') {
        const state = this.cancelDownload();
        sendJson(200, { ok: true, downloadState: state });
        return;
      }
      if (pathname === '/open-dir' && req.method === 'POST') {
        try {
          fs.mkdirSync(MODEL_DIR, { recursive: true });
          spawn('open', [MODEL_DIR], { detached: true, stdio: 'ignore' }).unref();
          sendJson(200, { ok: true, path: MODEL_DIR });
        } catch (e) {
          sendJson(500, { ok: false, error: e.message });
        }
        return;
      }
      if (pathname === '/speak' && req.method === 'POST') {
        const body = await readJson();
        const result = await this.speak(body.text, { voice: body.voice, speed: body.speed });
        if (!result.ok) {
          const code = result.error === 'MODEL_MISSING' ? 409 : 500;
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
    // 这里只清掉已失效的 PID 文件，并清掉上次遗留在模型目录里的临时碎片。
    const pid = readPid();
    if (!isPidAlive(pid)) clearPid();
    this.cleanTempFiles({ removePartFiles: false });
  }
}

export const ttsService = new TtsService();
