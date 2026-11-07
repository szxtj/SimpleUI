// 3D 场景构建服务托管模块 —— ccore/Qwen3.5-4B-3D-Coder (GGUF Q4_K_M + BF16 mmproj) via 官方 llama.cpp
//
// 职责：把「3D 场景构建」作为与基础模型、知识库、ASR、字幕、TTS、OCR 并列的受管服务：
//   - **开窗即加载、关窗即卸载**：独立 3D 窗口打开时调 /ensure 拉起 llama-server，
//     关闭窗口时调 /release 终止进程（与字幕管线「关窗卸全部」的语义一致）；
//   - SimpleUI 退出时一并终止（与其它受管服务行为对齐）；
//   - 模型不随包分发：首次使用时由下载管理器拉取权重（双源自动测速 + 断点续传 + 可取消，
//     与 TTS/OCR/字幕同一套实现），放在 ~/Library/Application Support/SimpleUI/models/scene3d/。
//
// 运行时：**官方 llama.cpp（b12040+）**，打包在 bin/llama3d/（Resources/llama3d/）。
// 内置自研 fork（bin/llama，b11429）不认识 Qwen3.5 的 `qwen35` GGUF 架构（实测
// unknown architecture），两套运行时物理隔离、互不影响。本服务不参与基础模型
// 三引擎的互斥管理（ttf_service.ALL_ENGINES 不含它），也不占用 1235 端口。
//
// 启动参数（本机 M4 实测验证）：-ngl 99 --flash-attn on --ctx-size 131072 --jinja。
// ctx 取 131072：Qwen3.5 混合注意力（Gated DeltaNet）KV 占用极小，第三方在 16GB
// 显存上以 262K 实测通过；多轮编辑时历史里携带 1.5~3 万 token 的场景 HTML，
// 需要足够的上下文预算。
//
// 附带能力：内置 three.js r160（server/vendor/three/three.module.min.js），
// 经 /api/scene3d/vendor/three.module.min.js 提供（带 CORS，供沙箱 iframe 的
// module script 拉取）。模型被训练为只在产物里引用 cdnjs 的这一个固定 URL，
// session_service 在 turn 结束时做**常量字符串重写**指向本地路径，场景即可完全离线渲染。
//
// 接口（Node 侧）：
//   GET  /api/scene3d/status
//   POST /api/scene3d/ensure    开窗调用：未运行则后台拉起（含自动补下载），立即返回状态
//   POST /api/scene3d/release   关窗调用：终止进程
//   POST /api/scene3d/{start,stop}
//   GET  /api/scene3d/download/status | POST /api/scene3d/download | POST /api/scene3d/download/cancel
//   POST /api/scene3d/open-dir
//   GET  /api/scene3d/vendor/three.module.min.js

import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import https from 'https';
import { fileURLToPath } from 'url';
import { startWatchdog } from './watchdog.js';
import { formatBytes } from './format_bytes.js';
import { DOWNLOAD_ERROR, downloadError, classifyDownloadError } from './download_errors.js';
import { ModelStaging, sweepStaleStaging } from './download_store.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const IDLE_UNLOAD_MIN = 3; // 一次输出结束后，闲置 3 分钟卸载模型（0 = 不自动卸载）
const HOME = os.homedir();

const USER_DIR = path.join(HOME, 'Library', 'Application Support', 'SimpleUI');
const MODEL_DIR = path.join(USER_DIR, 'models', 'scene3d');
const LOG_FILE = process.env.SIMPLEUI_SCENE3D_LOG || path.join(HOME, 'Library', 'Logs', 'simpleui-scene3d.log');
const PID_FILE = '/tmp/simpleui_scene3d.pid';
const THREE_VENDOR_FILE = path.join(__dirname, 'vendor', 'three', 'three.module.min.js');

const PORT = 1257;

// ---- 模型清单（与 TTS/字幕同一套 minBytes 完整性校验）----

const MODEL_KEY = 'scene3d';
const MODEL_NAME = 'Qwen3.5-4B-3D-Coder (GGUF Q4_K_M)';
const MODEL_SHORT_NAME = 'Qwen3.5-4B-3D-Coder';

const MODEL_REPO = 'ccore/Qwen3.5-4B-3D-Coder';
const MODEL_FILES = [
  { path: 'Qwen3.5-4B-3D-Coder-Q4_K_M.gguf', expectedBytes: 2708804096, minBytes: 2700000000, required: true },
  { path: 'mmproj-Qwen3.5-4B-BF16.gguf', expectedBytes: 675568768, minBytes: 670000000, required: true },
];
const MODEL_TOTAL_BYTES = MODEL_FILES.reduce((a, f) => a + f.expectedBytes, 0);

// 官方源与国内高速镜像源定义（与字幕/TTS 服务保持同一套双源策略）
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

// 生成参数固定值（官方推荐区间中点；v1 不暴露给用户）
const GEN_PARAMS = {
  temperature: 0.7,
  top_p: 0.95,
  top_k: 20,
  repetition_penalty: 1.0,
};

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

class Scene3dService {
  constructor() {
    // 生成用计数 + 闲置卸载：消息发出 → beginUse（拉起并阻塞到模型就绪）；
    // 输出结束（成功/失败/中止）→ endUse → 闲置 3 分钟杀 llama-server
    this.useCount = 0;
    this.idleTimer = null;
    this.proc = null;
    this.starting = null;
    this.watchdog = null;
    this.downloadAbortController = null;
    this.download = {
      active: false,
      errorCode: null,
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

  // ----------------------------- 模型下载 -----------------------------

  downloadStatus() {
    return { ...this.download };
  }

  /**
   * 发起支持自动重定向（301/302/307/308）的 HTTP/HTTPS 请求。
   * 与字幕/TTS 服务同一实现，供测速与断点续传下载共用。
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
      console.log(`[Scene3D] 🧹 已自动清理下载临时文件: ${removed.join(', ')}`);
    }
    return { removed };
  }

  /** 一键测速并下载缺失模型（双源自动选优 + 断点续传 + 可取消）。 */
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
      errorCode: null,
      updatedAt: Date.now(),
    };

    let staging = null;
    const commitEntries = [];
    try {
      sweepStaleStaging(MODEL_DIR);
      staging = new ModelStaging(MODEL_DIR, 'scene3d').begin();
      const probeFile = MODEL_FILES.reduce((a, b) =>
        (Number(b.expectedBytes) || 0) > (Number(a.expectedBytes) || 0) ? b : a
      );
      const probeRelative = `${MODEL_REPO}/resolve/main/${probeFile.path}`;

      const best = await this.probeBestMirror(signal, probeRelative);
      if (signal.aborted) throw new Error('cancelled');
      if (!best) throw downloadError(DOWNLOAD_ERROR.ALL_SOURCES_UNREACHABLE, 'ALL_SOURCES_UNREACHABLE');
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
        const finalPath = path.join(MODEL_DIR, file.path);
        if (fs.existsSync(finalPath) && fs.statSync(finalPath).size >= file.minBytes) continue;
        const dst = staging.pathFor(file.path);

        let fileDone = false;
        let lastErr = null;

        for (const srcNode of candidateSources) {
          if (signal.aborted) throw new Error('cancelled');
          const url = `${srcNode.baseUrl}/${MODEL_REPO}/resolve/main/${file.path}`;
          const existingBytes = staging.sizeOf(file.path);

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
                    reject(downloadError(DOWNLOAD_ERROR.DOWNLOAD_FAILED, `HTTP ${res.statusCode}`));
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

                  const fileStream = fs.createWriteStream(dst, {
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
                    reject(downloadError(DOWNLOAD_ERROR.DOWNLOAD_FAILED, 'Download aborted'));
                  });
                  res.on('end', () => {
                    fileStream.end();
                    fileStream.on('finish', () => {
                      try {
                        const finalSize = fs.statSync(dst).size;
                        if (finalSize < file.minBytes) {
                          reject(downloadError(DOWNLOAD_ERROR.FILE_SIZE_MISMATCH, `FILE_SIZE_MISMATCH (${finalSize} < ${file.minBytes})`));
                          return;
                        }
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
            commitEntries.push({ relPath: file.path, minBytes: file.minBytes });
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
            console.warn(`[Scene3D] Source ${srcNode.name} interrupted, trying backup:`, err.message);
          }
        }

        if (!fileDone) {
          throw lastErr || new Error(`DOWNLOAD_FAILED: ${file.path}`);
        }
      }

      this.download.phase = 'cleaning';
      staging.commit(commitEntries, { markKeys: ['scene3d'] });
      staging = null;
      this.cleanTempFiles({ removePartFiles: true });
      this.download.phase = 'completed';
      this.download.active = false;
      this.download.progressPercent = 100;
      this.download.updatedAt = Date.now();
    } catch (err) {
      const cancelled =
        signal.aborted || err.message === 'cancelled' || err.message === 'Download cancelled';
      if (staging) {
        try { cancelled ? staging.discard() : staging.releaseSlot(); } catch {}
        staging = null;
      }
      this.download.phase = cancelled ? 'cancelled' : 'error';
      this.download.error = cancelled ? null : err.message || 'unknown';
      this.download.errorCode = cancelled ? null : classifyDownloadError(err);
      this.download.active = false;
      this.download.updatedAt = Date.now();
      if (!cancelled) console.warn('[Scene3D] 模型下载失败:', err.message);
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

  /**
   * 解析官方 llama.cpp 运行时（llama-server b12040+，含同目录平铺 dylib）。
   * 打包态在 Contents/Resources/llama3d/，开发态在项目 bin/llama3d/。
   *
   * 只返回**绝对路径**：spawn 的可执行文件若是相对路径，会按 cwd 选项（本服务是
   * 'llama3d'）而不是 Node 进程 cwd 解析，实测报 ENOENT——打包态曾因此静默起不来。
   */
  resolveLlamaServer() {
    const candidates = [
      process.env.SIMPLEUI_SCENE3D_LLAMA_SERVER,
      // 打包态：Resources/server 的上一级就是 Resources（纯 Node 没有 process.resourcesPath）
      path.resolve(__dirname, '..', 'llama3d', 'llama-server'),
      // 开发态：server/ 的上一级是项目根
      path.resolve(__dirname, '..', 'bin', 'llama3d', 'llama-server'),
    ].filter(Boolean);
    for (const c of candidates) {
      try {
        if (fs.existsSync(c)) return c;
      } catch {}
    }
    return null;
  }

  /** 内置运行环境（官方 llama.cpp qwen35）是否就绪 */
  runtimeStatus() {
    const bin = this.resolveLlamaServer();
    return {
      ready: Boolean(bin),
      path: bin,
      bundled: Boolean(bin),
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
      sizeDesc: formatBytes(MODEL_TOTAL_BYTES),
      path: path.join(MODEL_DIR, MODEL_FILES[0]?.path || ''),
    };
  }

  isRunning() {
    return isPidAlive(this.proc?.pid || readPid());
  }

  // ----------------------------- 生命周期 -----------------------------

  /**
   * 兜底守护：与 ttf / asr / tts 同一套实现（server/watchdog.js）。
   * 看门狗只按 PID 精确动手（无 pkill），与字幕翻译的 llama-server（同名不同路径）
   * 不会互相误伤。
   */
  ensureWatchdog() {
    if (this.watchdog) return;
    try {
      this.watchdog = startWatchdog({
        pidFile: PID_FILE,
        binaryBasename: 'llama-server',
      });
    } catch {
      // watchdog 失败不阻断启动
    }
  }

  async start(signal) {
    if (this.isRunning()) return { ok: true, alreadyRunning: true };
    if (this.starting) return this.starting;

    const model = this.modelStatus();
    if (!model.ready) {
      return { ok: false, error: 'MODEL_MISSING', missing: model.missing, dir: model.dir };
    }
    const runtime = this.runtimeStatus();
    if (!runtime.ready) {
      return { ok: false, error: 'RUNTIME_MISSING' };
    }

    const bin = runtime.path;
    const weights = path.join(MODEL_DIR, MODEL_FILES[0].path);
    const mmproj = path.join(MODEL_DIR, MODEL_FILES[1].path);
    const startedAt = Date.now();

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

      const args = [
        '-m', weights,
        '--mmproj', mmproj,
        '--host', '127.0.0.1',
        '--port', String(PORT),
        '-ngl', '99',
        '--flash-attn', 'on',
        '--ctx-size', '131072',
        '--jinja',
      ];
      const child = spawn(bin, args, {
        cwd: path.dirname(bin),
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

      child.on('exit', (code, sig) => {
        this.proc = null;
        clearPid();
        try {
          logStream?.end();
        } catch {}
        if (!settled) {
          finish({ ok: false, error: 'EXITED', code, signal: sig, log: LOG_FILE });
        }
      });

      // spawn 本身失败（ENOENT / 权限）不会触发 exit，只有 error 事件；
      // 不挂 handler 会变成 uncaughtException 或被 ensure 的空 catch 吞掉。
      child.on('error', (err) => {
        this.proc = null;
        clearPid();
        try {
          logStream?.write(`\n[Scene3D] spawn 失败: ${err.message}\n`);
          logStream?.end();
        } catch {}
        console.error('[Scene3D] spawn 失败:', err.message);
        if (!settled) {
          finish({ ok: false, error: 'SPAWN_FAILED', message: err.message, log: LOG_FILE });
        }
      });

      // 轮询 /health：llama-server 加载期返回 503 {"error":...}，就绪后 {"status":"ok"}
      const deadline = Date.now() + 180000;
      const poll = () => {
        if (settled) return;
        if (signal?.aborted) {
          try {
            child.kill('SIGKILL');
          } catch {}
          this.proc = null;
          clearPid();
          finish({ ok: false, error: 'CANCELLED' });
          return;
        }
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
                if (obj.status === 'ok') {
                  console.log(`[Scene3D] ✅ llama-server 就绪（${((Date.now() - startedAt) / 1000).toFixed(1)}s）`);
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
    return result;
  }

  /**
   * 开窗入口：确保服务就绪。缺模型 → 自动后台补下载；待命 → 后台拉起。
   * 不等待加载完成，立即返回当前状态（前端轮询 /status 跟踪）。
   */
  async ensure() {
    const model = this.modelStatus();
    if (!model.ready && !this.download.active) {
      // 后台补下载，不阻塞返回
      this.startDownload().catch((err) => {
        console.warn('[Scene3D] ensure 自动下载失败:', err.message);
      });
    } else if (model.ready && !this.isRunning() && !this.starting) {
      // 后台拉起，不阻塞返回
      this.start().then((r) => {
        if (!r.ok && r.error !== 'CANCELLED') {
          console.warn('[Scene3D] ensure 拉起失败:', r.error);
        }
      }).catch((err) => {
        console.warn('[Scene3D] ensure 拉起异常:', err.message);
      });
    }
    return this.getStatus();
  }

  /**
   * 消息发出时调用（不再开窗即加载）：拉起 llama-server 并阻塞到模型加载完成。
   * 模型缺失 → 自动补下载并等待（首次使用的消息会等下载，窗口头部有进度）。
   * 就绪后 useCount++，挂住闲置卸载，直到输出结束 endUse。
   */
  async beginUse() {
    let r = await this.start();
    if (!r.ok && r.error === 'MODEL_MISSING') {
      if (!this.download.active) {
        this.startDownload().catch((err) => {
          console.warn('[Scene3D] beginUse 自动下载失败:', err.message);
        });
      }
      // 等模型就绪（下载可能长达数分钟；窗口头部 / 设置卡片有实时进度）
      const deadline = Date.now() + 45 * 60_000;
      while (!this.modelStatus().ready && Date.now() < deadline) {
        await new Promise((res) => setTimeout(res, 2000));
        r = await this.start().catch(() => ({ ok: false, error: 'RETRY' }));
        if (r.ok) break;
      }
      if (!r.ok) r = await this.start();
      if (!r.ok) throw new Error(r.error || 'MODEL_NOT_READY');
    } else if (!r.ok) {
      throw new Error(r.error || 'start failed');
    }
    this.useCount++;
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    return this.getStatus();
  }

  /** 一次输出结束（成功 / 失败 / 用户中止）后调用：递减在途计数并安排闲置卸载 */
  endUse() {
    this.useCount = Math.max(0, this.useCount - 1);
    this.scheduleIdleUnload();
  }

  scheduleIdleUnload() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (IDLE_UNLOAD_MIN <= 0) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.useCount > 0) return;              // 仍有在途生成
      if (this.download.active) { this.scheduleIdleUnload(); return; } // 下载中顺延
      if (!this.isRunning()) return;
      console.log(`[Scene3D] 闲置 ${IDLE_UNLOAD_MIN} 分钟，卸载模型并停止服务`);
      this.stop();
    }, IDLE_UNLOAD_MIN * 60_000);
    this.idleTimer.unref?.();
  }

  stop() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    const pid = this.proc?.pid || readPid();
    if (isPidAlive(pid)) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {}
      setTimeout(() => {
        // 已被下一次开窗的新进程顶替就不要误杀（PID 可能复用）
        if (this.proc?.pid === pid) return;
        if (!isPidAlive(pid)) return;
        try {
          process.kill(pid, 'SIGKILL');
        } catch {}
      }, 1500).unref?.();
    }
    this.proc = null;
    clearPid();
    return { ok: true };
  }

  // 正常退出：与 tts/ocr 一致，只发 SIGTERM
  shutdownSync() {
    const pid = this.proc?.pid || readPid();
    if (isPidAlive(pid)) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {}
    }
    this.proc = null;
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
  }

  async getStatus() {
    const model = this.modelStatus();
    const runtime = this.runtimeStatus();
    const running = this.isRunning();
    let ready = false;
    if (running) {
      ready = await new Promise((resolve) => {
        http
          .get({ host: '127.0.0.1', port: PORT, path: '/health', timeout: 1500 }, (res) => {
            let body = '';
            res.on('data', (c) => (body += c));
            res.on('end', () => {
              try {
                const obj = JSON.parse(body);
                resolve(obj.status === 'ok');
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
      params: { ...GEN_PARAMS },
      port: PORT,
      logFile: LOG_FILE,
      download: this.downloadStatus(),
    };
  }

  // ----------------------------- HTTP API -----------------------------

  async handleApi(req, res) {
    const host = req.headers.host || '127.0.0.1:31235';
    const urlObj = new URL(req.url, `http://${host}`);
    const pathname = urlObj.pathname.replace(/^\/api\/scene3d/, '');

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

    try {
      if (pathname === '/status' && req.method === 'GET') {
        sendJson(200, await this.getStatus());
        return;
      }
      // 开窗调用：确保模型已下载并后台拉起，立即返回（前端轮询 /status）
      if (pathname === '/ensure' && req.method === 'POST') {
        sendJson(200, await this.ensure());
        return;
      }
      // 关窗调用：终止进程（幂等）
      if (pathname === '/release' && req.method === 'POST') {
        this.stop();
        sendJson(200, { ok: true, status: (await this.getStatus()).status });
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
      if (pathname === '/download' && req.method === 'POST') {
        // 立即返回，后台继续下载；进度由 /api/scene3d/status 轮询获取。
        this.startDownload().catch((err) => {
          console.warn('[Scene3D] download error:', err.message);
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
      // 内置 three.js r160：供沙箱 iframe（opaque origin）以 module script 拉取，
      // 必须带 CORS 头与正确的 JS MIME。
      if (pathname === '/vendor/three.module.min.js' && req.method === 'GET') {
        let stat = null;
        try {
          stat = fs.statSync(THREE_VENDOR_FILE);
        } catch {}
        if (!stat || !stat.isFile()) {
          sendJson(404, { error: 'VENDOR_MISSING' });
          return;
        }
        res.writeHead(200, {
          'Content-Type': 'application/javascript; charset=utf-8',
          'Content-Length': stat.size,
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'public, max-age=31536000',
        });
        fs.createReadStream(THREE_VENDOR_FILE).pipe(res);
        return;
      }
      sendJson(404, { error: 'NOT_FOUND' });
    } catch (e) {
      sendJson(500, { error: 'SCENE3D_API_FAILED', message: e.message });
    }
  }

  init() {
    // 启动时不拉起模型：开窗即加载、关窗即卸载。
    // 上次运行残留的进程由 App 启动前的 cleanStaleProcessesBeforeLaunch（managedPidFiles）
    // 统一清理，这里只清掉已失效的 PID 文件与下载临时碎片。
    const pid = readPid();
    if (!isPidAlive(pid)) clearPid();
    this.cleanTempFiles({ removePartFiles: false });
  }
}

export const scene3dService = new Scene3dService();
