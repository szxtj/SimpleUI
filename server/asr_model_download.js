// 语音输入 · Qwen3-ASR 模型下载器（mlx-community/Qwen3-ASR-0.6B-8bit）
//
// 与 TTS 的下载器同构（官方源 + 国内镜像双源测速、断点续传、可取消、进度可查询），
// 但只服务这一个模型，所以独立成模块而不是搬动 tts_service.js —— 后者仍在正常服务
// 朗读链路，任何改动都要额外回归，这里没有复用它的必要。
//
// 状态字段刻意与 TTS 的 downloadState 保持一致（phase / progressPercent / speedBps /
// etaSeconds / currentModelKey / selectedSource ...），这样设置面板可以直接复用同一套
// 进度条组件，不需要为新引擎另写一份 UI。

import fs from 'fs';
import http from 'http';
import https from 'https';
import path from 'path';
import { DOWNLOAD_ERROR, downloadError, classifyDownloadError } from './download_errors.js';
import { ModelStaging, isModelReady, sweepStaleStaging } from './download_store.js';

export const QWEN3_REPO = 'mlx-community/Qwen3-ASR-0.6B-8bit';
export const QWEN3_MODEL_NAME = 'Qwen3-ASR-0.6B-8bit (MLX)';

// 与 hf 上的实际字节数一致（minBytes 留 1–2% 余量，用于识别截断的坏文件）
export const QWEN3_FILES = [
  { path: 'model.safetensors', expectedBytes: 1006229426, minBytes: 985661440, required: true },
  { path: 'config.json', expectedBytes: 7187, minBytes: 5000, required: true },
  { path: 'model.safetensors.index.json', expectedBytes: 71815, minBytes: 60000, required: false },
  { path: 'tokenizer_config.json', expectedBytes: 12487, minBytes: 10000, required: true },
  { path: 'vocab.json', expectedBytes: 2776833, minBytes: 2700000, required: true },
  { path: 'merges.txt', expectedBytes: 1671853, minBytes: 1600000, required: true },
  { path: 'chat_template.json', expectedBytes: 1161, minBytes: 800, required: false },
  { path: 'generation_config.json', expectedBytes: 142, minBytes: 100, required: false },
  { path: 'preprocessor_config.json', expectedBytes: 330, minBytes: 200, required: false },
];

export const QWEN3_TOTAL_BYTES = QWEN3_FILES.reduce((a, f) => a + f.expectedBytes, 0);

// 官方源与国内镜像：镜像仅换 host，路径规则一致
const SOURCES = [
  { id: 'hf', name: 'HuggingFace 官方源 (huggingface.co)', baseUrl: 'https://huggingface.co' },
  { id: 'hf-mirror', name: '国内镜像 (hf-mirror.com)', baseUrl: 'https://hf-mirror.com' },
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
        headers: { 'User-Agent': 'SimpleUI/1.0', ...headers },
        timeout,
      },
      (res) => {
        const status = res.statusCode || 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          if (redirects <= 0) {
            reject(downloadError(DOWNLOAD_ERROR.DOWNLOAD_FAILED, 'too_many_redirects'));
            return;
          }
          const next = new URL(res.headers.location, urlStr).toString();
          request(next, { method, headers, timeout, signal }, redirects - 1).then(resolve, reject);
          return;
        }
        resolve({ res, status });
      }
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (signal) {
      const onAbort = () => req.destroy(new Error('cancelled'));
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    req.end();
  });
}

export class Qwen3ModelDownloader {
  /**
   * @param {string} modelDir                 模型落盘目录
   * @param {{sources?: {id:string,name:string,baseUrl:string}[]}} [opts]
   *        sources 缺省用 HF 官方 + 国内镜像；显式传入用于「自建镜像 / 局域网源」，
   *        也让下载器的探测、断点续传、进度逻辑可以脱离外网被验证。
   */
  constructor(modelDir, opts = {}) {
    this.modelDir = modelDir;
    this.sources = Array.isArray(opts.sources) && opts.sources.length > 0 ? opts.sources : SOURCES;
    this.aborter = null;
    this.state = {
      active: false,
      phase: 'idle',
      targetModel: 'asr',
      currentModelKey: 'asr',
      currentModelName: QWEN3_MODEL_NAME,
      currentFile: '',
      selectedSource: null,
      downloadedBytes: 0,
      totalBytes: QWEN3_TOTAL_BYTES,
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

  /** 目录内是否已有完整可用的权重（只校验必需文件 + 提交封条） */
  ready() {
    const filesOk = () => {
      for (const f of QWEN3_FILES) {
        if (!f.required) continue;
        const p = path.join(this.modelDir, f.path);
        if (!fs.existsSync(p) || fs.statSync(p).size < f.minBytes) return false;
      }
      return true;
    };
    return isModelReady(this.modelDir, 'qwen3', filesOk);
  }

  /** 已存在的总字节数，用于面板展示「已下载 x / 964MB」 */
  presentBytes() {
    let total = 0;
    const stagingDir = path.join(this.modelDir, '.incoming', 'qwen3');
    for (const f of QWEN3_FILES) {
      try {
        const p = path.join(this.modelDir, f.path);
        if (fs.existsSync(p)) {
          total += fs.statSync(p).size;
          continue; // 已在目标目录的不会再有暂存副本
        }
        const sp = path.join(stagingDir, f.path);
        if (fs.existsSync(sp)) total += fs.statSync(sp).size;
      } catch {
        // ignore
      }
    }
    return total;
  }

  cleanTempFiles({ removePartFiles = false } = {}) {
    if (!fs.existsSync(this.modelDir)) return;
    try {
      for (const name of fs.readdirSync(this.modelDir)) {
        const full = path.join(this.modelDir, name);
        const isTemp =
          name.endsWith('.tmp') ||
          name.endsWith('.download') ||
          (removePartFiles && name.endsWith('.part'));
        if (isTemp) {
          try { fs.rmSync(full, { force: true }); } catch {}
        }
      }
    } catch {
      // ignore
    }
  }

  async probeBestSource(signal, probeRelative) {
    const probeOne = async (source) => {
      const started = Date.now();
      try {
        const { res, status } = await request(
          `${source.baseUrl}/${probeRelative}`,
          { headers: { Range: 'bytes=0-32767' }, timeout: 4000, signal },
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
      totalBytes: QWEN3_TOTAL_BYTES,
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
      staging = new ModelStaging(this.modelDir, 'qwen3').begin();
      const probeFile = QWEN3_FILES.reduce((a, b) => (b.expectedBytes > a.expectedBytes ? b : a));
      const best = await this.probeBestSource(signal, `${QWEN3_REPO}/resolve/main/${probeFile.path}`);
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

      for (const file of QWEN3_FILES) {
        if (signal.aborted) throw new Error('cancelled');
        // 目标目录已达标就不重下；否则写进暂存区（提交前目标目录保持原样）
        const finalPath = path.join(this.modelDir, file.path);
        if (fs.existsSync(finalPath) && fs.statSync(finalPath).size >= file.minBytes) continue;
        const dst = staging.pathFor(file.path);
        let done = false;
        let lastErr = null;

        for (const src of candidates) {
          if (signal.aborted) throw new Error('cancelled');
          const url = `${src.baseUrl}/${QWEN3_REPO}/resolve/main/${file.path}`;
          let offset = 0;
          offset = staging.sizeOf(file.path);

          try {
            await new Promise((resolve, reject) => {
              const headers = offset > 0 ? { Range: `bytes=${offset}-` } : {};
              request(url, { headers, timeout: 30000, signal })
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
                  this.state.totalBytes = QWEN3_TOTAL_BYTES;
                  this.state.currentFile = file.path;
                  this.state.updatedAt = Date.now();

                  const out = fs.createWriteStream(dst, { flags: isResume ? 'a' : 'w' });
                  out.on('error', (err) => {
                    res.destroy();
                    reject(err);
                  });

                  let got = base;
                  let lastTick = Date.now();
                  let lastBytes = base;

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
                      // 面板显示的是「整个模型」的进度，所以用其它文件已完成量做基数
                      const doneBytes = QWEN3_TOTAL_BYTES - file.expectedBytes + got;
                      this.state.downloadedBytes = doneBytes;
                      this.state.progressPercent = Math.min(
                        99,
                        Math.round((doneBytes / QWEN3_TOTAL_BYTES) * 100)
                      );
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
                          reject(downloadError(DOWNLOAD_ERROR.FILE_SIZE_MISMATCH, `FILE_SIZE_MISMATCH (${finalSize} < ${file.minBytes})`));
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
            console.warn(`[Qwen3Download] ${src.name} 中断，切换备用源:`, err.message);
          }
        }

        if (!done) throw lastErr || new Error(`DOWNLOAD_FAILED: ${file.path}`);
      }

      this.state.phase = 'cleaning';
      staging.commit(
        QWEN3_FILES.map((f) => ({ relPath: f.path, minBytes: f.minBytes })),
        { markKeys: ['qwen3'], totalBytes: QWEN3_TOTAL_BYTES }
      );
      staging = null;
      this.cleanTempFiles({ removePartFiles: true });
      this.state.phase = 'completed';
      this.state.active = false;
      this.state.progressPercent = 100;
      this.state.downloadedBytes = QWEN3_TOTAL_BYTES;
      this.state.speedBps = 0;
      this.state.etaSeconds = null;
      this.state.updatedAt = Date.now();
      console.log('[Qwen3Download] 模型下载完成:', this.modelDir);
    } catch (err) {
      const cancelled = signal.aborted || err.message === 'cancelled';
      if (staging) {
        // 取消 = 不留残片；失败 = 保留暂存区供续传，但释放锁，否则下次下载会被判「已在下载中」
        try { cancelled ? staging.discard() : staging.releaseSlot(); } catch {}
        staging = null;
      }
      if (err.code === 'DOWNLOAD_IN_PROGRESS') this.state.errorCode = 'DOWNLOAD_IN_PROGRESS';
      this.state.phase = cancelled ? 'cancelled' : 'error';
      this.state.error = cancelled ? null : err.message || 'unknown';
      this.state.errorCode = cancelled ? null : classifyDownloadError(err);
      this.state.active = false;
      this.state.speedBps = 0;
      this.state.etaSeconds = null;
      this.state.updatedAt = Date.now();
      if (!cancelled) console.warn('[Qwen3Download] 模型下载失败:', err.message);
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
