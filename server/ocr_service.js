// OCR（视觉文档识别）服务托管模块 —— PaddleOCR-VL 1.6 (MLX 8bit) via mlx-vlm
//
// 职责：把「截屏框选识别为 Markdown」所用的本地多模态 OCR 作为受管服务：
//   - 按需启动：第一次识别时拉起 Python 常驻进程，闲置超时（默认 5 分钟）自动卸载并释放统一显存；
//   - SimpleUI 退出时一并终止（与 TTS、ASR 等受管服务对齐）；
//   - 配置持久化在 ocr_config.json（识别任务 / 分辨率档位 / 闲置卸载），
//     模型固定放在 ~/Library/Application Support/SimpleUI/models/ocr/。
//
// 架构设计：与 tts_service.js 同构：
//   - 纯按需生命周期，无常驻内存负担；
//   - 模型下载采用双源自动测速（hf-mirror.com vs huggingface.co）+ 断点续传 + 可取消 + 实时进度；
//   - 服务面板展示内置运行环境、模型完备状态与下载进度，并提供「打开模型目录」。
//
// 接口（Node 侧）：
//   GET  /api/ocr/status
//   POST /api/ocr/{start,stop}
//   GET  /api/ocr/config | POST /api/ocr/config
//   POST /api/ocr/recognize   {imagePath, task?, maxPixels?} -> {ok, text, durationMs}
//   GET  /api/ocr/download/status | POST /api/ocr/download | POST /api/ocr/download/cancel
//   POST /api/ocr/open-dir

import { spawn, spawnSync } from 'child_process';
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
const CONFIG_FILE = path.join(USER_DIR, 'ocr_config.json');
const MODEL_DIR = path.join(USER_DIR, 'models', 'ocr');
const LOG_FILE = process.env.SIMPLEUI_OCR_LOG || path.join(HOME, 'Library', 'Logs', 'simpleui-ocr.log');
const PID_FILE = '/tmp/simpleui_ocr.pid';
const SCRIPT = path.join(__dirname, 'ocr', 'ocr_server.py');

const PORT = 1256;
const TASKS = ['ocr', 'table', 'formula', 'chart', 'spotting', 'seal'];
const RESOLUTIONS = {
  balanced: 1016064, // ~100万像素，速度优先
  high: 1806336,     // ~180万像素，默认平衡档
  max: 4064256,      // ~406万像素，最高精度档
};

const DEFAULT_CONFIG = {
  task: 'ocr',
  resolution: 'high',
  maxPixels: 1806336,
  idleUnloadMin: 30,
};

// ---- 模型清单 ----
const MODEL_KEY = 'ocr';
const MODEL_NAME = 'PaddleOCR-VL 1.6 (MLX 8bit)';
const MODEL_SHORT_NAME = 'PaddleOCR-VL 1.6';
const MODEL_SIZE_DESC = '1.09 GB';
const MODEL_REPO = 'OpenGryd/PaddleOCR-VL-1.6-MLX-8bit';

const MODEL_FILES = [
  { path: 'model.safetensors', expectedBytes: 1088866630, minBytes: 1080000000, required: true },
  { path: 'tokenizer.json', expectedBytes: 11189060, minBytes: 11000000, required: true },
  { path: 'modeling_paddleocr_vl.py', expectedBytes: 103889, minBytes: 90000, required: true },
  { path: 'configuration_paddleocr_vl.py', expectedBytes: 8104, minBytes: 7000, required: true },
  { path: 'processing_paddleocr_vl.py', expectedBytes: 12253, minBytes: 10000, required: true },
  { path: 'image_processing_paddleocr_vl.py', expectedBytes: 25032, minBytes: 20000, required: true },
  { path: 'config.json', expectedBytes: 2676, minBytes: 2000, required: true },
  { path: 'preprocessor_config.json', expectedBytes: 641, minBytes: 500, required: true },
  { path: 'processor_config.json', expectedBytes: 609, minBytes: 500, required: true },
  { path: 'tokenizer_config.json', expectedBytes: 803, minBytes: 600, required: true },
  { path: 'chat_template.jinja', expectedBytes: 1474, minBytes: 1000, required: true },
  { path: 'added_tokens.json', expectedBytes: 25381, minBytes: 20000, required: false },
  { path: 'special_tokens_map.json', expectedBytes: 1151, minBytes: 800, required: false },
  { path: 'generation_config.json', expectedBytes: 133, minBytes: 100, required: false },
  { path: 'model.safetensors.index.json', expectedBytes: 69880, minBytes: 50000, required: false },
];
const MODEL_TOTAL_BYTES = MODEL_FILES.reduce((a, f) => a + f.expectedBytes, 0);

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

class OcrService {
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
        this.config = { ...DEFAULT_CONFIG, ...parsed };
      }
    } catch (e) {
      console.warn('[OCR] 读取配置失败，使用默认值:', e.message);
    }
  }

  saveConfig() {
    try {
      if (!fs.existsSync(USER_DIR)) fs.mkdirSync(USER_DIR, { recursive: true });
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(this.config, null, 2));
    } catch (e) {
      console.warn('[OCR] 保存配置失败:', e.message);
    }
  }

  // ----------------------------- 模型下载 -----------------------------

  downloadStatus() {
    return { ...this.download };
  }

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
      console.log(`[OCR] 🧹 已自动清理临时文件: ${removed.join(', ')}`);
    }
    return { removed };
  }

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
      const probeFile = MODEL_FILES[0];
      const probeRelative = `${MODEL_REPO}/resolve/main/${probeFile.path}`;

      const best = await this.probeBestMirror(signal, probeRelative);
      if (signal.aborted) throw new Error('cancelled');
      if (!best) throw new Error('ALL_SOURCES_UNREACHABLE');

      const backup = DOWNLOAD_SOURCES.find((s) => s.id !== best.id);
      const orderedSources = [best, ...(backup ? [backup] : [])];

      this.download.selectedSource = best;
      this.download.phase = 'downloading';
      this.download.updatedAt = Date.now();

      fs.mkdirSync(MODEL_DIR, { recursive: true });

      const filesToDownload = MODEL_FILES.filter((f) => {
        const full = path.join(MODEL_DIR, f.path);
        if (!fs.existsSync(full)) return true;
        try {
          const sz = fs.statSync(full).size;
          return sz < (f.minBytes || f.expectedBytes || 1);
        } catch {
          return true;
        }
      });

      const getExistingBytes = () => {
        let total = 0;
        for (const f of MODEL_FILES) {
          const full = path.join(MODEL_DIR, f.path);
          const part = `${full}.part`;
          if (fs.existsSync(full)) {
            try {
              total += fs.statSync(full).size;
              continue;
            } catch {}
          }
          if (fs.existsSync(part)) {
            try {
              total += fs.statSync(part).size;
            } catch {}
          }
        }
        return total;
      };

      let downloadedBytes = getExistingBytes();
      this.download.downloadedBytes = downloadedBytes;
      this.download.progressPercent = Math.min(
        99.9,
        (downloadedBytes / Math.max(1, MODEL_TOTAL_BYTES)) * 100
      );

      let lastBytes = downloadedBytes;
      let lastTime = Date.now();

      for (const fileDef of filesToDownload) {
        if (signal.aborted) throw new Error('cancelled');

        const destFile = path.join(MODEL_DIR, fileDef.path);
        const partFile = `${destFile}.part`;
        fs.mkdirSync(path.dirname(destFile), { recursive: true });

        this.download.currentFile = fileDef.path;
        this.download.updatedAt = Date.now();

        let fileSuccess = false;
        let lastError = null;

        for (const source of orderedSources) {
          if (signal.aborted) throw new Error('cancelled');

          try {
            let startOffset = 0;
            if (fs.existsSync(partFile)) {
              try {
                startOffset = fs.statSync(partFile).size;
                if (fileDef.expectedBytes && startOffset > fileDef.expectedBytes) {
                  fs.unlinkSync(partFile);
                  startOffset = 0;
                }
              } catch {
                startOffset = 0;
              }
            }

            const downloadUrl = `${source.baseUrl}/${MODEL_REPO}/resolve/main/${fileDef.path}`;
            const headers = {};
            if (startOffset > 0) {
              headers.Range = `bytes=${startOffset}-`;
            }

            const { res } = await this.httpRequestWithRedirects(
              downloadUrl,
              { method: 'GET', headers, signal },
              5
            );

            if (res.statusCode !== 200 && res.statusCode !== 206) {
              res.resume();
              throw new Error(`HTTP ${res.statusCode} from ${source.name}`);
            }

            const writeStream = fs.createWriteStream(partFile, {
              flags: startOffset > 0 && res.statusCode === 206 ? 'a' : 'w',
            });

            await new Promise((resolve, reject) => {
              let streamBytes = 0;
              const onData = (chunk) => {
                streamBytes += chunk.length;
                downloadedBytes += chunk.length;
                const now = Date.now();
                const deltaMs = now - lastTime;
                if (deltaMs >= 500) {
                  const deltaBytes = downloadedBytes - lastBytes;
                  const speed = Math.round((deltaBytes / Math.max(1, deltaMs)) * 1000);
                  const remainingBytes = Math.max(0, MODEL_TOTAL_BYTES - downloadedBytes);
                  this.download.speedBps = speed;
                  this.download.etaSeconds = speed > 0 ? Math.round(remainingBytes / speed) : null;
                  this.download.downloadedBytes = downloadedBytes;
                  this.download.progressPercent = Math.min(
                    99.9,
                    (downloadedBytes / Math.max(1, MODEL_TOTAL_BYTES)) * 100
                  );
                  this.download.updatedAt = now;
                  lastBytes = downloadedBytes;
                  lastTime = now;
                }
              };

              res.on('data', onData);
              res.pipe(writeStream);
              writeStream.on('finish', resolve);
              writeStream.on('error', reject);
              res.on('error', reject);
              if (signal) {
                signal.addEventListener(
                  'abort',
                  () => {
                    res.destroy();
                    writeStream.destroy();
                    reject(new Error('cancelled'));
                  },
                  { once: true }
                );
              }
            });

            const stat = fs.statSync(partFile);
            if (fileDef.minBytes && stat.size < fileDef.minBytes) {
              throw new Error(`FILE_SIZE_MISMATCH: ${stat.size} < ${fileDef.minBytes}`);
            }

            fs.renameSync(partFile, destFile);
            fileSuccess = true;
            break;
          } catch (err) {
            lastError = err;
            if (signal.aborted) break;
            console.warn(`[OCR] Source ${source.name} failed for ${fileDef.path}: ${err.message}, trying backup...`);
          }
        }

        if (!fileSuccess) {
          throw lastError || new Error(`DOWNLOAD_FAILED: ${fileDef.path}`);
        }
      }

      this.download.phase = 'cleaning';
      this.download.updatedAt = Date.now();
      this.cleanTempFiles({ removePartFiles: true });

      this.download = {
        ...this.download,
        active: false,
        phase: 'completed',
        currentFile: '',
        progressPercent: 100,
        speedBps: 0,
        etaSeconds: 0,
        error: null,
        updatedAt: Date.now(),
      };
      return this.downloadStatus();
    } catch (err) {
      const isCancel = err.message === 'cancelled' || signal?.aborted;
      this.download = {
        ...this.download,
        active: false,
        phase: isCancel ? 'cancelled' : 'error',
        speedBps: 0,
        etaSeconds: null,
        error: isCancel ? null : err.message || '下载失败',
        updatedAt: Date.now(),
      };
      return this.downloadStatus();
    } finally {
      this.downloadAbortController = null;
    }
  }

  cancelDownload() {
    if (this.downloadAbortController) {
      try {
        this.downloadAbortController.abort();
      } catch {}
      this.downloadAbortController = null;
    }
    this.download = {
      ...this.download,
      active: false,
      phase: 'cancelled',
      speedBps: 0,
      etaSeconds: null,
      updatedAt: Date.now(),
    };
    return this.downloadStatus();
  }

  // ----------------------------- 状态查询 -----------------------------

  modelStatus() {
    let missing = [];
    let bytes = 0;
    let expected = 0;
    const fileStatuses = [];

    for (const f of MODEL_FILES) {
      const full = path.join(MODEL_DIR, f.path);
      expected += f.expectedBytes || 0;
      let exists = false;
      let sz = 0;
      let ready = false;
      if (fs.existsSync(full)) {
        try {
          sz = fs.statSync(full).size;
          exists = true;
          ready = sz >= (f.minBytes || f.expectedBytes || 1);
        } catch {}
      }
      bytes += sz;
      if (f.required && !ready) {
        missing.push(f.path);
      }
      fileStatuses.push({
        path: f.path,
        exists,
        size: sz,
        minBytes: f.minBytes || 0,
        expectedBytes: f.expectedBytes || 0,
        required: f.required !== false,
        ready,
      });
    }

    const ready = missing.length === 0;
    return {
      key: MODEL_KEY,
      name: MODEL_NAME,
      shortName: MODEL_SHORT_NAME,
      dir: MODEL_DIR,
      ready,
      missing,
      bytes,
      expectedBytes: expected,
      sizeDesc: MODEL_SIZE_DESC,
      path: MODEL_DIR,
      files: fileStatuses,
    };
  }

  resolvePython() {
    const candidates = [
      path.join(__dirname, 'ocr', 'python', 'bin', 'python3'),
      path.join(__dirname, 'tts', 'python', 'bin', 'python3'),
      path.join(process.resourcesPath || '', 'ocr', 'python', 'bin', 'python3'),
      path.join(process.resourcesPath || '', 'tts', 'python', 'bin', 'python3'),
      path.resolve(__dirname, '..', 'bin', 'ocr_runtime', 'python', 'bin', 'python3'),
      path.resolve(__dirname, '..', 'bin', 'tts_runtime', 'python', 'bin', 'python3'),
      path.join(HOME, '.workbuddy', 'binaries', 'python', 'envs', 'default', 'bin', 'python3'),
    ];
    for (const c of candidates) {
      try {
        if (fs.existsSync(c)) return c;
      } catch {}
    }
    return 'python3';
  }

  runtimeStatus() {
    const python = this.resolvePython();
    const isFallback = python === 'python3';
    const now = Date.now();
    // 成功检测后保持有效；如果此前失败，隔 3 秒允许重新探测
    if (this._runtimeReady === true) {
      return { ready: true, path: python, bundled: !isFallback };
    }
    if (this._lastCheckTime && now - this._lastCheckTime < 3000) {
      return { ready: false, path: python, bundled: !isFallback };
    }
    this._lastCheckTime = now;
    let ready = false;
    try {
      const check = spawnSync(python, ['-c', 'import mlx_vlm, PIL'], { timeout: 3000 });
      ready = check.status === 0;
      this._runtimeReady = ready;
    } catch {
      ready = false;
    }
    return {
      ready,
      path: python,
      bundled: !isFallback,
    };
  }

  isRunning() {
    if (this.proc && isPidAlive(this.proc.pid)) return true;
    const pid = readPid();
    return pid !== null && isPidAlive(pid);
  }

  async pingHealth(timeoutMs = 1500) {
    return new Promise((resolve) => {
      const req = http.get(
        { host: '127.0.0.1', port: PORT, path: '/health', timeout: timeoutMs },
        (res) => {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => {
            try {
              const obj = JSON.parse(body);
              resolve({ alive: true, ready: Boolean(obj.ready) });
            } catch {
              resolve({ alive: true, ready: false });
            }
          });
        }
      );
      req.on('error', () => resolve({ alive: false, ready: false }));
      req.on('timeout', () => {
        req.destroy();
        resolve({ alive: false, ready: false });
      });
    });
  }

  async getStatus() {
    const model = this.modelStatus();
    const runtime = this.runtimeStatus();
    const running = this.isRunning();
    const health = running ? await this.pingHealth(800) : { alive: false, ready: false };

    let status = 'incomplete';
    if (!model.ready) {
      status = 'incomplete';
    } else if (this.starting) {
      status = 'loading';
    } else if (running && health.ready) {
      status = 'ready';
    } else {
      status = 'standby';
    }

    return {
      status,
      running,
      ready: status === 'ready',
      modelsReady: model.ready,
      runtimeReady: runtime.ready,
      model,
      runtime,
      config: { ...this.config },
      python: runtime.path,
      port: PORT,
      logFile: LOG_FILE,
      download: this.downloadStatus(),
    };
  }

  // ----------------------------- 进程启停 -----------------------------

  ensureWatchdog() {
    if (this.watchdog) return;
    try {
      this.watchdog = startWatchdog({
        pidFile: PID_FILE,
        binaryBasename: 'ocr_server.py',
      });
    } catch (e) {
      console.warn('[OCR] 启动看门狗失败:', e.message);
    }
  }

  async ensureRunning() {
    if (this.starting) return this.starting;
    if (this.isRunning()) {
      const health = await this.pingHealth(1000);
      if (health.ready) return { ok: true, existing: true };
    }
    return this.start();
  }

  async start() {
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

      // 轮询 /health 直到 ready
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
      console.log(`[OCR] 闲置 ${minutes} 分钟，卸载模型并停止服务`);
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
    }
    this.proc = null;
    clearPid();
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  shutdownSync() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const pid = this.proc?.pid || readPid();
    if (isPidAlive(pid)) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {}
    }
    clearPid();
  }

  shutdownForce() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const pid = this.proc?.pid || readPid();
    if (isPidAlive(pid)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
    }
    clearPid();
  }

  // ----------------------------- 识别调用 -----------------------------

  async recognize(imagePath, options = {}) {
    if (!imagePath || !fs.existsSync(imagePath)) {
      return { ok: false, error: 'IMAGE_NOT_FOUND', imagePath };
    }

    const startRes = await this.ensureRunning();
    if (!startRes.ok) {
      return { ok: false, error: startRes.error, missing: startRes.missing };
    }

    this.touch();

    const task = options.task || this.config.task || 'ocr';
    const resolutionKey = options.resolution || this.config.resolution || 'high';
    const maxPixels = RESOLUTIONS[resolutionKey] || this.config.maxPixels || RESOLUTIONS.high;

    const payload = JSON.stringify({
      image_path: imagePath,
      task,
      max_pixels: maxPixels,
    });

    return new Promise((resolve) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: PORT,
          path: '/recognize',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
          },
          timeout: 60000,
        },
        (res) => {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => {
            try {
              const parsed = JSON.parse(body);
              if (res.statusCode === 200 && parsed.ok) {
                resolve({
                  ok: true,
                  text: parsed.text,
                  durationMs: parsed.duration_ms,
                  task: parsed.task,
                });
              } else {
                resolve({ ok: false, error: parsed.error || `HTTP_${res.statusCode}` });
              }
            } catch (e) {
              resolve({ ok: false, error: 'INVALID_JSON_RESPONSE', raw: body });
            }
          });
        }
      );

      req.on('error', (e) => resolve({ ok: false, error: e.message }));
      req.on('timeout', () => {
        req.destroy();
        resolve({ ok: false, error: 'TIMEOUT' });
      });
      req.write(payload);
      req.end();
    });
  }

  init() {
    this.loadConfig();
  }

  // ----------------------------- HTTP API 路由 -----------------------------

  async handleApi(req, res) {
    const host = req.headers.host || '127.0.0.1:31235';
    const urlObj = new URL(req.url, `http://${host}`);
    const pathname = urlObj.pathname.replace(/^\/api\/ocr/, '');

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
        if (body.task && !TASKS.includes(body.task)) {
          sendJson(400, { ok: false, error: 'UNKNOWN_TASK' });
          return;
        }
        const resKey = body.resolution && RESOLUTIONS[body.resolution] ? body.resolution : this.config.resolution;
        this.config = {
          ...this.config,
          ...(body.task ? { task: body.task } : {}),
          resolution: resKey,
          maxPixels: RESOLUTIONS[resKey],
          ...(body.idleUnloadMin !== undefined ? { idleUnloadMin: Math.max(0, Number(body.idleUnloadMin) || 0) } : {}),
        };
        this.saveConfig();
        if (this.isRunning()) this.touch();
        sendJson(200, { ok: true, config: { ...this.config } });
        return;
      }
      if (pathname === '/download' && req.method === 'POST') {
        this.startDownload().catch((err) => {
          console.warn('[OCR] download error:', err.message);
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
      if (pathname === '/recognize' && req.method === 'POST') {
        const body = await readJson();
        const result = await this.recognize(body.imagePath || body.image, {
          task: body.task,
          resolution: body.resolution,
        });
        if (!result.ok) {
          const code = result.error === 'MODEL_MISSING' ? 409 : 500;
          sendJson(code, result);
          return;
        }
        sendJson(200, result);
        return;
      }
      sendJson(404, { error: 'NOT_FOUND' });
    } catch (e) {
      sendJson(500, { error: 'OCR_API_FAILED', message: e.message });
    }
  }
}

export const ocrService = new OcrService();
