// Maple Preview 20B-A1B · 运行时与权重下载器
//
// 为什么需要单独一份：这条链路的「框架」和「权重」都不是单个模型文件
//   * 运行时：独立的 Python venv（mlx 183MB + transformers 55MB + numpy 22MB），
//     合计约 311MB，远超随包内置的合理体积 —— 所以做成「下载按钮」；
//     但其中真正提供 Maple 支持的 Python 源码（mlx_lm wheel 437KB）与原生
//     kernel（48KB）体积很小，随 App 内置在 server/vendor/maple/ 下，
//     避免安装时再去 GitHub 拉源码。
//   * 权重：deepgrove/maple-preview-2bit-mlx，5.31GB / 14 个文件。
//
// 与 asr_model_download.js（Qwen3-ASR）刻意保持同构：
//   双源测速、断点续传、ModelStaging 暂存后原子提交、可取消、进度可查询、
//   状态字段同名（phase / progressPercent / speedBps / etaSeconds ...），
//   这样设置面板可以直接复用同一套进度条 UI。

import fs from 'fs';
import http from 'http';
import https from 'https';
import path from 'path';
import { spawn } from 'child_process';
import { DOWNLOAD_ERROR, downloadError, classifyDownloadError } from './download_errors.js';
import { ModelStaging, isModelReady, sweepStaleStaging } from './download_store.js';

export const MAPLE_REPO = 'deepgrove/maple-preview-2bit-mlx';
export const MAPLE_MODEL_NAME = 'Maple Preview 20B-A1B (2-bit MLX)';
export const MAPLE_RUNTIME_BYTES = 311 * 1024 * 1024; // 实测 311MB，用于进度估算

// 与 hf 上的实际字节数一致（minBytes 留 1% 余量，用于识别截断）
export const MAPLE_FILES = [
  { path: 'model-00001-of-00003.safetensors', expectedBytes: 2162084350, required: true },
  { path: 'model-00002-of-00003.safetensors', expectedBytes: 2187444586, required: true },
  { path: 'model-00003-of-00003.safetensors', expectedBytes: 958711742, required: true },
  { path: 'model-flashhead.safetensors', expectedBytes: 6087456, required: false },
  { path: 'model.safetensors.index.json', expectedBytes: 40054, required: false },
  { path: 'config.json', expectedBytes: 2710, required: true },
  { path: 'chat_template.jinja', expectedBytes: 3292, required: true },
  { path: 'tokenizer.json', expectedBytes: 11422654, required: true },
  { path: 'tokenizer_config.json', expectedBytes: 5432, required: true },
  { path: 'special_tokens_map.json', expectedBytes: 613, required: false },
  { path: 'added_tokens.json', expectedBytes: 707, required: false },
  { path: 'vocab.json', expectedBytes: 2776833, required: false },
  { path: 'merges.txt', expectedBytes: 1671853, required: false },
  // mlx-lm 用 trust_remote_code 加载它，缺了就 FileNotFoundError: maple.py
  { path: 'maple.py', expectedBytes: 71017, required: true },
].map((f) => ({ ...f, minBytes: Math.max(512, Math.floor(f.expectedBytes * 0.99)) }));

export const MAPLE_TOTAL_BYTES = MAPLE_FILES.reduce((a, f) => a + f.expectedBytes, 0);

const SOURCES = [
  { id: 'hf-mirror', name: '国内镜像 (hf-mirror.com)', baseUrl: 'https://hf-mirror.com' },
  { id: 'hf', name: 'HuggingFace 官方源 (huggingface.co)', baseUrl: 'https://huggingface.co' },
];

function request(urlStr, { method = 'GET', headers = {}, timeout = 30000, signal } = {}, redirects = 5) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || undefined,
        path: `${u.pathname}${u.search}`,
        method,
        headers,
        // 沙箱/系统代理对本地回环下载无意义，这里直接连
        agent: false,
      },
      (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
          res.resume();
          const next = new URL(res.headers.location, urlStr).toString();
          request(next, { method, headers, timeout, signal }, redirects - 1).then(resolve, reject);
          return;
        }
        resolve({ res, status: res.statusCode });
      }
    );
    req.setTimeout(timeout, () => {
      req.destroy(new Error('timeout'));
    });
    req.on('error', reject);
    if (signal) {
      signal.addEventListener('abort', () => req.destroy(new Error('cancelled')), { once: true });
    }
    req.end();
  });
}

function dirSize(dir) {
  let total = 0;
  const walk = (p) => {
    let entries;
    try {
      entries = fs.readdirSync(p, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(p, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) {
        try {
          total += fs.statSync(full).size;
        } catch {
          /* ignore */
        }
      }
    }
  };
  walk(dir);
  return total;
}

// ---------------------------------------------------------------------------
// 1. 权重下载（5.31GB）
// ---------------------------------------------------------------------------

export class MapleModelDownloader {
  constructor(modelDir, opts = {}) {
    this.modelDir = modelDir;
    this.sources = Array.isArray(opts.sources) && opts.sources.length > 0 ? opts.sources : SOURCES;
    this.aborter = null;
    this.state = {
      active: false,
      phase: 'idle',
      targetModel: 'maple',
      currentModelKey: 'maple',
      currentModelName: MAPLE_MODEL_NAME,
      currentFile: '',
      selectedSource: null,
      downloadedBytes: 0,
      totalBytes: MAPLE_TOTAL_BYTES,
      progressPercent: 0,
      speedBps: 0,
      etaSeconds: null,
      error: null,
      errorCode: null,
      updatedAt: 0,
    };
  }

  status() {
    return { ...this.state };
  }

  ready() {
    const filesOk = () => {
      for (const f of MAPLE_FILES) {
        if (!f.required) continue;
        const p = path.join(this.modelDir, f.path);
        if (!fs.existsSync(p) || fs.statSync(p).size < f.minBytes) return false;
      }
      return true;
    };
    return isModelReady(this.modelDir, 'maple', filesOk);
  }

  presentBytes() {
    let total = 0;
    const stagingDir = path.join(this.modelDir, '.incoming', 'maple');
    for (const f of MAPLE_FILES) {
      try {
        const p = path.join(this.modelDir, f.path);
        if (fs.existsSync(p)) {
          total += fs.statSync(p).size;
          continue;
        }
        const sp = path.join(stagingDir, f.path);
        if (fs.existsSync(sp)) total += fs.statSync(sp).size;
      } catch {
        /* ignore */
      }
    }
    return total;
  }

  async probeBestSource(signal, probeRelative) {
    const probeOne = async (source) => {
      const started = Date.now();
      try {
        const { res, status } = await request(
          `${source.baseUrl}/${probeRelative}`,
          { headers: { Range: 'bytes=0-32767' }, timeout: 5000, signal },
          4
        );
        if (status !== 200 && status !== 206) {
          res.resume();
          return { ...source, ok: false };
        }
        let bytes = 0;
        await new Promise((resolve) => {
          const done = () => resolve();
          res.on('data', (c) => (bytes += c.length));
          res.on('end', done);
          res.on('error', done);
          res.on('aborted', done);
        });
        const elapsed = Math.max(1, Date.now() - started);
        return {
          ...source,
          ok: true,
          latencyMs: elapsed,
          speedKbps: Math.round((bytes / 1024 / elapsed) * 1000),
        };
      } catch {
        return { ...source, ok: false };
      }
    };

    const results = (await Promise.all(this.sources.map(probeOne))).filter((r) => r.ok);
    if (results.length === 0) return null;
    results.sort((a, b) => a.latencyMs / Math.max(1, a.speedKbps) - b.latencyMs / Math.max(1, b.speedKbps));
    return results[0];
  }

  async start() {
    if (this.state.active) return this.status();
    if (this.ready()) return this.status();

    const aborter = new AbortController();
    this.aborter = aborter;
    const signal = aborter.signal;

    this.state = {
      ...this.state,
      active: true,
      phase: 'probing',
      currentFile: '',
      selectedSource: null,
      downloadedBytes: this.presentBytes(),
      totalBytes: MAPLE_TOTAL_BYTES,
      progressPercent: 0,
      speedBps: 0,
      etaSeconds: null,
      error: null,
      errorCode: null,
      updatedAt: Date.now(),
    };

    let staging = null;
    try {
      fs.mkdirSync(this.modelDir, { recursive: true });
      sweepStaleStaging(this.modelDir);
      staging = new ModelStaging(this.modelDir, 'maple').begin();
      const probeFile = MAPLE_FILES.reduce((a, b) => (b.expectedBytes > a.expectedBytes ? b : a));
      const best = await this.probeBestSource(signal, `${MAPLE_REPO}/resolve/main/${probeFile.path}`);
      if (signal.aborted) throw new Error('cancelled');
      if (!best) throw downloadError(DOWNLOAD_ERROR.ALL_SOURCES_UNREACHABLE, 'ALL_SOURCES_UNREACHABLE');

      this.state.selectedSource = {
        id: best.id,
        name: best.name,
        latencyMs: best.latencyMs,
        speedKbps: best.speedKbps,
      };

      const candidates = [best, ...this.sources.filter((s) => s.id !== best.id)];
      this.state.phase = 'downloading';

      // 已完成分片的累计字节。不能用「总量 − 当前文件大小 + 已收」那套公式：
      // 那是单大文件模型的近似（Qwen3-ASR 就是那样），Maple 是 3 个 2GB 级分片，
      // 套上去会在第一个分片刚开始时就把进度报到 57%。
      let completedBytes = 0;

      for (const file of MAPLE_FILES) {
        if (signal.aborted) throw new Error('cancelled');
        const finalPath = path.join(this.modelDir, file.path);
        if (fs.existsSync(finalPath) && fs.statSync(finalPath).size >= file.minBytes) continue;
        const dst = staging.pathFor(file.path);
        let done = false;
        let lastErr = null;

        for (const src of candidates) {
          if (signal.aborted) throw new Error('cancelled');
          const url = `${src.baseUrl}/${MAPLE_REPO}/resolve/main/${file.path}`;
          const offset = staging.sizeOf(file.path);

          try {
            await new Promise((resolve, reject) => {
              const headers = offset > 0 ? { Range: `bytes=${offset}-` } : {};
              request(url, { headers, timeout: 60000, signal })
                .then(({ res, status }) => {
                  if (status !== 200 && status !== 206) {
                    res.resume();
                    reject(downloadError(DOWNLOAD_ERROR.DOWNLOAD_FAILED, `HTTP ${status}`));
                    return;
                  }
                  const isResume = status === 206 && offset > 0;
                  const base = isResume ? offset : 0;
                  const contentLen = Number(res.headers['content-length'] || 0);
                  const total = contentLen > 0 ? base + contentLen : file.expectedBytes;
                  this.state.currentFile = file.path;
                  this.state.updatedAt = Date.now();

                  const out = fs.createWriteStream(dst, { flags: isResume ? 'a' : 'w' });
                  let got = base;
                  let lastTick = Date.now();
                  let lastBytes = base;

                  out.on('error', (err) => {
                    res.destroy();
                    reject(err);
                  });

                  res.on('data', (chunk) => {
                    got += chunk.length;
                    if (!out.write(chunk)) {
                      res.pause();
                      out.once('drain', () => res.resume());
                    }
                    const now = Date.now();
                    if (now - lastTick >= 400) {
                      const dt = (now - lastTick) / 1000;
                      this.state.speedBps = Math.round((got - lastBytes) / dt);
                      lastTick = now;
                      lastBytes = got;
                      const doneBytes = completedBytes + got;
                      this.state.downloadedBytes = doneBytes;
                      this.state.progressPercent = Math.min(99, Math.round((doneBytes / MAPLE_TOTAL_BYTES) * 100));
                      this.state.etaSeconds =
                        this.state.speedBps > 0 && total > got
                          ? Math.round((total - got) / this.state.speedBps)
                          : null;
                      this.state.updatedAt = now;
                    }
                  });
                  res.on('error', (err) => {
                    out.destroy();
                    reject(err);
                  });
                  res.on('aborted', () => {
                    out.destroy();
                    reject(downloadError(DOWNLOAD_ERROR.DOWNLOAD_FAILED, 'Download aborted'));
                  });
                  res.on('end', () => {
                    out.end();
                    out.on('finish', () => {
                      try {
                        const finalSize = fs.statSync(dst).size;
                        if (finalSize < file.minBytes) {
                          reject(
                            downloadError(
                              DOWNLOAD_ERROR.FILE_SIZE_MISMATCH,
                              `FILE_SIZE_MISMATCH (${finalSize} < ${file.minBytes})`
                            )
                          );
                          return;
                        }
                        resolve();
                      } catch (e) {
                        reject(e);
                      }
                    });
                  });
                })
                .catch(reject);
            });
            done = true;
            break;
          } catch (err) {
            lastErr = err;
            if (signal.aborted || err.message === 'cancelled') throw new Error('cancelled');
            console.warn(`[MapleDownload] ${src.name} 中断，切换备用源:`, err.message);
          }
        }

        if (!done) throw lastErr || new Error(`DOWNLOAD_FAILED: ${file.path}`);
        completedBytes += file.expectedBytes;
      }

      this.state.phase = 'cleaning';
      staging.commit(
        MAPLE_FILES.map((f) => ({ relPath: f.path, minBytes: f.minBytes })),
        { markKeys: ['maple'], totalBytes: MAPLE_TOTAL_BYTES }
      );
      staging = null;
      this.state.phase = 'completed';
      this.state.active = false;
      this.state.progressPercent = 100;
      this.state.downloadedBytes = MAPLE_TOTAL_BYTES;
      this.state.speedBps = 0;
      this.state.etaSeconds = null;
      this.state.updatedAt = Date.now();
      console.log('[MapleDownload] 权重下载完成:', this.modelDir);
    } catch (err) {
      const cancelled = signal.aborted || err.message === 'cancelled';
      if (staging) {
        try {
          cancelled ? staging.discard() : staging.releaseSlot();
        } catch {
          /* ignore */
        }
        staging = null;
      }
      this.state.phase = cancelled ? 'cancelled' : 'error';
      this.state.error = cancelled ? null : err.message || 'unknown';
      this.state.errorCode = cancelled ? null : classifyDownloadError(err);
      this.state.active = false;
      this.state.speedBps = 0;
      this.state.etaSeconds = null;
      this.state.updatedAt = Date.now();
      if (!cancelled) console.warn('[MapleDownload] 权重下载失败:', err.message);
    } finally {
      this.aborter = null;
    }

    return this.status();
  }

  cancel() {
    if (this.aborter) {
      this.aborter.abort();
      this.aborter = null;
    }
    this.state.phase = 'cancelled';
    this.state.active = false;
    this.state.speedBps = 0;
    this.state.etaSeconds = null;
    this.state.updatedAt = Date.now();
    return this.status();
  }
}

// ---------------------------------------------------------------------------
// 2. 运行时安装（独立 venv，311MB）
// ---------------------------------------------------------------------------
//
// 与权重下载的状态字段保持一致，但进度按「步骤 + venv 体积」估算：
// 真正耗时的只有 pip 安装依赖那一步，用目录体积映射到 15%–85% 区间，
// 比纯步骤进度条更接近真实观感。

const VENDOR_DIR = path.join(path.dirname(new URL(import.meta.url).pathname), 'vendor', 'maple');

const RUNTIME_STEPS = [
  { key: 'venv', label: '创建独立 Python 环境', percent: 12 },
  { key: 'deps', label: '安装 mlx 运行时依赖', percent: 15 },
  { key: 'wheels', label: '安装 mlx-lm 与 Maple 原生内核', percent: 88 },
  { key: 'verify', label: '校验运行时可用性', percent: 96 },
];

function findUv() {
  const candidates = [
    path.join(process.env.HOME || '', '.local', 'bin', 'uv'),
    '/opt/homebrew/bin/uv',
    '/usr/local/bin/uv',
    '/usr/bin/uv',
  ];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {
      /* ignore */
    }
  }
  return null;
}

export class MapleRuntimeInstaller {
  constructor(runtimeDir, opts = {}) {
    this.runtimeDir = runtimeDir;
    this.vendorDir = opts.vendorDir || VENDOR_DIR;
    this.proc = null;
    this.sizeTimer = null;
    this.state = {
      active: false,
      phase: 'idle',
      step: '',
      stepLabel: '',
      downloadedBytes: 0,
      totalBytes: MAPLE_RUNTIME_BYTES,
      progressPercent: 0,
      speedBps: 0,
      etaSeconds: null,
      error: null,
      errorCode: null,
      logTail: '',
      updatedAt: 0,
    };
  }

  status() {
    return { ...this.state };
  }

  get pythonPath() {
    return path.join(this.runtimeDir, 'bin', 'python');
  }

  ready() {
    if (!fs.existsSync(this.pythonPath)) return false;
    const mark = path.join(this.runtimeDir, '.ready');
    return fs.existsSync(mark);
  }

  presentBytes() {
    // /api/model/status 每 3 秒轮询一次，而 venv 里有上千个小文件：
    // 无脑递归 stat 一遍会白白吃掉 IO。加 2 秒 TTL，安装中仍能跟上进度。
    const now = Date.now();
    if (this._sizeCache && now - this._sizeCache.at < 2000) return this._sizeCache.bytes;
    const bytes = dirSize(this.runtimeDir);
    this._sizeCache = { at: now, bytes };
    return bytes;
  }

  _run(cmd, args, stepKey, stepLabel) {
    return new Promise((resolve, reject) => {
      this.state.step = stepKey;
      this.state.stepLabel = stepLabel;
      this.state.updatedAt = Date.now();

      const child = spawn(cmd, args, {
        env: {
          ...process.env,
          // 依赖安装走系统代理会慢且不稳；交给 uv 直连（国内可另设 PIP_INDEX_URL）
          NO_COLOR: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      this.proc = child;

      let tail = '';
      const collect = (d) => {
        tail = (tail + d.toString()).slice(-4000);
        this.state.logTail = tail;
      };
      child.stdout.on('data', collect);
      child.stderr.on('data', collect);

      child.on('error', (err) => {
        this.proc = null;
        reject(err);
      });
      child.on('exit', (code) => {
        this.proc = null;
        if (code === 0) resolve();
        else reject(new Error(`${stepLabel} 失败（退出码 ${code}）\n${tail.slice(-800)}`));
      });
    });
  }

  async start() {
    if (this.state.active) return this.status();
    if (this.ready()) return this.status();

    this.state = {
      ...this.state,
      active: true,
      phase: 'installing',
      step: 'prepare',
      stepLabel: '准备安装环境',
      progressPercent: 2,
      error: null,
      errorCode: null,
      logTail: '',
      downloadedBytes: this.presentBytes(),
      totalBytes: MAPLE_RUNTIME_BYTES,
      updatedAt: Date.now(),
    };

    // 依赖安装期间用 venv 体积估算进度（15% → 85%）
    this.sizeTimer = setInterval(() => {
      const bytes = this.presentBytes();
      const ratio = Math.min(1, bytes / MAPLE_RUNTIME_BYTES);
      this.state.downloadedBytes = bytes;
      this.state.progressPercent = Math.round(15 + ratio * 70);
      this.state.updatedAt = Date.now();
    }, 700);

    try {
      fs.mkdirSync(this.runtimeDir, { recursive: true });
      try {
        fs.rmSync(path.join(this.runtimeDir, '.ready'), { force: true });
      } catch {
        /* ignore */
      }

      const uv = findUv();
      if (!uv) {
        throw new Error('未找到 uv（可执行文件）。请先安装 uv：curl -LsSf https://astral.sh/uv/install.sh | sh');
      }

      const mlxLmWheel = fs
        .readdirSync(this.vendorDir)
        .find((f) => f.startsWith('mlx_lm-') && f.endsWith('.whl'));
      const kernelsWheel = fs
        .readdirSync(this.vendorDir)
        .find((f) => f.startsWith('mlx_lm_maple_kernels') && f.endsWith('.whl'));
      if (!mlxLmWheel || !kernelsWheel) {
        throw new Error(`内置 wheel 缺失：${this.vendorDir}`);
      }

      await this._run(uv, ['venv', '--python', '3.12', this.runtimeDir], 'venv', '创建独立 Python 环境');

      await this._run(
        uv,
        [
          'pip',
          'install',
          '--python',
          this.pythonPath,
          '--only-binary',
          ':all:',
          'mlx==0.32.0',
          'numpy',
          'transformers>=5.7.0',
          'tokenizers',
          'sentencepiece',
          'rich',
          'huggingface_hub',
        ],
        'deps',
        '安装 mlx 运行时依赖'
      );

      await this._run(
        uv,
        [
          'pip',
          'install',
          '--python',
          this.pythonPath,
          '--only-binary',
          ':all:',
          path.join(this.vendorDir, mlxLmWheel),
          path.join(this.vendorDir, kernelsWheel),
        ],
        'wheels',
        '安装 mlx-lm 与 Maple 原生内核'
      );

      await this._run(
        this.pythonPath,
        ['-c', 'import mlx.core as mx, mlx_lm; print("mlx", mx.__version__)'],
        'verify',
        '校验运行时可用性'
      );

      fs.writeFileSync(
        path.join(this.runtimeDir, '.ready'),
        JSON.stringify({ installedAt: new Date().toISOString(), bytes: this.presentBytes() }, null, 2)
      );

      this.state.phase = 'completed';
      this.state.progressPercent = 100;
      this.state.downloadedBytes = this.presentBytes();
      this.state.updatedAt = Date.now();
      console.log('[MapleRuntime] 运行时安装完成:', this.runtimeDir);
    } catch (err) {
      const cancelled = err.message === 'cancelled';
      this.state.phase = cancelled ? 'cancelled' : 'error';
      this.state.error = cancelled ? null : err.message || 'unknown';
      this.state.errorCode = cancelled ? null : 'RUNTIME_INSTALL_FAILED';
      if (!cancelled) console.warn('[MapleRuntime] 安装失败:', err.message);
    } finally {
      if (this.sizeTimer) {
        clearInterval(this.sizeTimer);
        this.sizeTimer = null;
      }
      this.state.active = false;
      this.state.speedBps = 0;
      this.state.etaSeconds = null;
      this.state.updatedAt = Date.now();
    }

    return this.status();
  }

  cancel() {
    if (this.proc) {
      try {
        this.proc.kill('SIGTERM');
      } catch {
        /* ignore */
      }
      this.proc = null;
    }
    if (this.sizeTimer) {
      clearInterval(this.sizeTimer);
      this.sizeTimer = null;
    }
    this.state.phase = 'cancelled';
    this.state.active = false;
    this.state.updatedAt = Date.now();
    return this.status();
  }
}
