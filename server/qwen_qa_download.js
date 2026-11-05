/**
 * Qwen 3.5 9B（4-bit MLX）权重下载器
 *
 * 与 maple_download.js 同一套「受管资源」形态：只暴露 ready / presentBytes / status /
 * start / cancel，网络与磁盘细节全部收在这里，ttf_service.js 只做转发。
 *
 * 和 Maple 的区别：Maple 有自建镜像列表与运行时安装器；这里运行时直接复用 Maple 那份
 * Python（mlx-lm 已内置 qwen3_5），所以**只下权重**，来源按 HF 官方 API 的文件清单走，
 * 支持 HF_ENDPOINT 切镜像（国内网络）。
 *
 * 目录结构：
 *   <modelDir>/            config.json / *.safetensors / tokenizer...
 *   <modelDir>/_manifest.json   文件清单与期望字节数（ready() 的判据）
 */
import fs from 'fs';
import path from 'path';
import https from 'https';
import http from 'http';

export const QWEN_QA_REPO = 'mlx-community/Qwen3.5-9B-4bit';
export const QWEN_QA_MODEL_NAME = 'Qwen 3.5 9B (4-bit MLX)';
/** 仓库标称体积，仅在拿不到逐文件大小时用于进度百分比 */
export const QWEN_QA_TOTAL_BYTES = Math.round(5.95 * 1024 * 1024 * 1024);

/** 不参与下载的文件（文档、git 元数据） */
const SKIP_PATTERNS = [/^\./i, /\.md$/i, /^README/i, /^LICENSE/i];

function endpoints() {
  const list = [];
  if (process.env.HF_ENDPOINT) list.push(process.env.HF_ENDPOINT.replace(/\/+$/, ''));
  list.push('https://huggingface.co');
  list.push('https://hf-mirror.com');
  return [...new Set(list)];
}

function httpGet(urlStr, { timeout = 20000, redirects = 5 } = {}) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(urlStr);
    } catch (e) {
      reject(e);
      return;
    }
    const mod = parsed.protocol === 'http:' ? http : https;
    const req = mod.get(
      urlStr,
      { headers: { 'User-Agent': 'SimpleUI/qwen-qa-downloader' }, timeout },
      (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          if (redirects <= 0) {
            reject(new Error('too many redirects'));
            return;
          }
          const next = new URL(res.headers.location, urlStr).toString();
          httpGet(next, { timeout, redirects: redirects - 1 }).then(resolve, reject);
          return;
        }
        resolve(res);
      }
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

function readJsonBody(res, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let buf = '';
    res.setEncoding('utf8');
    res.on('data', (d) => {
      buf += d;
      if (buf.length > limit) {
        res.destroy();
        reject(new Error('response too large'));
      }
    });
    res.on('end', () => {
      try {
        resolve(JSON.parse(buf));
      } catch (e) {
        reject(e);
      }
    });
    res.on('error', reject);
  });
}

function fileSize(p) {
  try {
    return fs.statSync(p).size;
  } catch (e) {
    return 0;
  }
}

function dirSize(dir) {
  let total = 0;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) total += dirSize(p);
      else if (entry.isFile()) total += fileSize(p);
    }
  } catch (e) {
    /* ignore */
  }
  return total;
}

export class QwenQaModelDownloader {
  constructor(modelDir) {
    this.modelDir = modelDir;
    this.manifestFile = path.join(modelDir, '_manifest.json');
    this.state = {
      active: false,
      phase: 'idle', // idle | listing | downloading | done | error | cancelled
      error: null,
      currentFile: '',
      fileIndex: 0,
      fileCount: 0,
      totalBytes: 0,
      downloadedBytes: 0,
      speedBps: 0,
      etaSeconds: null,
      startedAt: null,
      finishedAt: null,
    };
    this._cancel = false;
    this._res = null;
  }

  status() {
    const total = this.state.totalBytes || 0;
    const done = this.state.downloadedBytes || 0;
    return {
      ...this.state,
      repo: QWEN_QA_REPO,
      modelName: QWEN_QA_MODEL_NAME,
      progressPercent: total > 0 ? Math.min(100, (done / total) * 100) : 0,
      updatedAt: Date.now(),
    };
  }

  presentBytes() {
    return dirSize(this.modelDir);
  }

  /** 读缓存清单（没有就返回 null） */
  readManifest() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.manifestFile, 'utf8'));
      if (!raw || !Array.isArray(raw.files) || raw.repo !== QWEN_QA_REPO) return null;
      return raw;
    } catch (e) {
      return null;
    }
  }

  /**
   * 权重是否完整：清单里每个文件都存在且字节数一致。
   * 没有清单时退化为「config.json + 至少一个 safetensors」，避免用户手工放权重时永远不可用。
   */
  ready() {
    const manifest = this.readManifest();
    if (!manifest) {
      if (!fs.existsSync(path.join(this.modelDir, 'config.json'))) return false;
      try {
        return fs.readdirSync(this.modelDir).some((f) => f.endsWith('.safetensors'));
      } catch (e) {
        return false;
      }
    }
    for (const f of manifest.files) {
      if (fileSize(path.join(this.modelDir, f.name)) !== f.bytes) return false;
    }
    return true;
  }

  cancel() {
    this._cancel = true;
    try {
      this._res?.destroy();
    } catch (e) {
      /* ignore */
    }
  }

  /** 拉取仓库文件清单（走 HF API，切源时按顺序尝试） */
  async listFiles() {
    let lastErr = null;
    for (const base of endpoints()) {
      try {
        const res = await httpGet(`${base}/api/models/${QWEN_QA_REPO}`, { timeout: 25000 });
        if (res.statusCode !== 200) {
          res.resume();
          throw new Error(`HTTP ${res.statusCode}`);
        }
        const json = await readJsonBody(res);
        const siblings = Array.isArray(json?.siblings) ? json.siblings : [];
        const files = siblings
          .map((s) => s.rfilename)
          .filter((name) => name && !SKIP_PATTERNS.some((re) => re.test(name)));
        if (!files.length) throw new Error('empty file list');
        this.endpoint = base;
        return files;
      } catch (e) {
        lastErr = e;
        console.warn(`[QwenQA] 清单获取失败 (${base}): ${e.message}`);
      }
    }
    throw lastErr || new Error('无法获取权重文件清单');
  }

  async downloadOne(name, expectedBytes) {
    const dest = path.join(this.modelDir, name);
    const part = `${dest}.part`;
    fs.mkdirSync(path.dirname(dest), { recursive: true });

    if (expectedBytes && fileSize(dest) === expectedBytes) {
      this.state.downloadedBytes += expectedBytes;
      return;
    }

    const url = `${this.endpoint}/${QWEN_QA_REPO}/resolve/main/${encodeURI(name)}?download=true`;
    const res = await httpGet(url, { timeout: 30000 });
    if (res.statusCode !== 200) {
      res.resume();
      throw new Error(`${name}: HTTP ${res.statusCode}`);
    }
    const total = Number(res.headers['content-length']) || expectedBytes || 0;

    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(part);
      this._res = res;
      const startedAt = Date.now();
      let written = 0;
      const baseDone = this.state.downloadedBytes;

      res.on('data', (chunk) => {
        written += chunk.length;
        this.state.downloadedBytes = baseDone + written;
        const elapsed = (Date.now() - startedAt) / 1000;
        if (elapsed > 0.5) {
          this.state.speedBps = Math.round(written / elapsed);
          const remain = total - written;
          this.state.etaSeconds =
            this.state.speedBps > 0 ? Math.round(remain / this.state.speedBps) : null;
        }
      });
      res.on('error', reject);
      out.on('error', reject);
      out.on('finish', () => {
        if (this._cancel) {
          try {
            fs.unlinkSync(part);
          } catch (e) {
            /* ignore */
          }
          reject(new Error('cancelled'));
          return;
        }
        try {
          fs.renameSync(part, dest);
        } catch (e) {
          reject(e);
          return;
        }
        this.state.downloadedBytes = baseDone + written;
        resolve();
      });
      res.pipe(out);
    });
  }

  async start() {
    if (this.state.active) return;
    this._cancel = false;
    this.state = {
      active: true,
      phase: 'listing',
      error: null,
      currentFile: '',
      fileIndex: 0,
      fileCount: 0,
      totalBytes: QWEN_QA_TOTAL_BYTES,
      downloadedBytes: 0,
      speedBps: 0,
      etaSeconds: null,
      startedAt: Date.now(),
      finishedAt: null,
    };

    try {
      fs.mkdirSync(this.modelDir, { recursive: true });
      const names = await this.listFiles();
      this.state.fileCount = names.length;
      this.state.phase = 'downloading';

      // 先写清单骨架（字节数边下边补），下完再落最终版
      const manifest = { repo: QWEN_QA_REPO, endpoint: this.endpoint, files: [] };
      let totalBytes = 0;

      for (let i = 0; i < names.length; i++) {
        if (this._cancel) throw new Error('cancelled');
        const name = names[i];
        this.state.currentFile = name;
        this.state.fileIndex = i + 1;

        // 已存在的文件不必再发 HEAD，直接按本地大小记账
        const localSize = fileSize(path.join(this.modelDir, name));
        if (localSize > 0) {
          manifest.files.push({ name, bytes: localSize });
          totalBytes += localSize;
          this.state.downloadedBytes += localSize;
          continue;
        }

        await this.downloadOne(name, 0);
        const bytes = fileSize(path.join(this.modelDir, name));
        manifest.files.push({ name, bytes });
        totalBytes += bytes;
        this.state.totalBytes = Math.max(totalBytes, this.state.downloadedBytes);
      }

      manifest.totalBytes = totalBytes;
      manifest.updatedAt = Date.now();
      fs.writeFileSync(this.manifestFile, JSON.stringify(manifest, null, 2));

      this.state.phase = 'done';
      this.state.currentFile = '';
      this.state.totalBytes = totalBytes;
      this.state.downloadedBytes = totalBytes;
      this.state.finishedAt = Date.now();
    } catch (e) {
      this.state.phase = this._cancel ? 'cancelled' : 'error';
      this.state.error = this._cancel ? null : e.message;
      this.state.finishedAt = Date.now();
      if (!this._cancel) console.error('[QwenQA] 下载失败:', e.message);
    } finally {
      this.state.active = false;
      this._res = null;
    }
  }
}
