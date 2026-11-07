import fs from 'fs';
import path from 'path';
import https from 'https';
import os from 'os';
import { fork } from 'child_process';
import { fileURLToPath } from 'url';

/**
 * EmbeddingGemma-2 端侧嵌入服务（独立工作进程承载，进程管理与 tts / ocr 同构）。
 *
 * 模型：`onnx-community/embeddinggemma-2-ONNX`，int8 文本 + int8 视觉编码器。
 *       M4 实测（2026-11）：文本批 8 约 20~50 块/s，单条查询 ~60ms；
 *       视觉 max_soft_tokens=64 约 400ms/图。q4f16 / fp16 在 CPU 上更慢，一律 int8。
 *
 * 为什么是**独立子进程**而不是代理进程内的会话：
 *   1. 内存释放必须有确定性 —— onnxruntime-node 的会话 `dispose()` 之后再重建会
 *      永久挂起（promise 不落地、无报错，实测踩过），所以「闲置卸载 / 关窗卸载 /
 *      退出清理」统一用「杀掉工作进程」来保证 ~500MB 必然归还操作系统。
 *   2. 故障隔离：原生崩溃不拖垮代理进程。
 *
 * 生命周期（与 tts / ocr 同一套四态语义）：
 *   standby（模型已下载、工作进程未拉起）→ loading（开窗 / 首次使用，拉起 + 加载）
 *   → running（已驻留）→ 闲置超时 / 关窗 / 退出 → 杀工作进程 → 回到 standby。
 */

const REPO = 'onnx-community/embeddinggemma-2-ONNX';
const HF_BASE = `https://huggingface.co/${REPO}/resolve/main/`;

const COMMON_FILES = [
  'config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'preprocessor_config.json',
  'processor_config.json',
];
const TEXT_FILES = [
  'onnx/model_quantized.onnx',
  'onnx/model_quantized.onnx_data',
];
const VISION_FILES = [
  'onnx/vision_encoder_quantized.onnx',
  'onnx/vision_encoder_quantized.onnx_data',
];

/** 图片软 token 上限：280 是满配（2520 patch ≈ 2.2s/图），64 是实测速度/质量拐点 */
const DEFAULT_IMAGE_SOFT_TOKENS = 64;
/** 闲置卸载（分钟）：0 = 只有退出才卸载。索引完成 / 检索后 60s 无活动即卸载；
 *  工作进程重新拉起 + 加载模型只要 ~1s，不值得为省这 1s 让 500MB 常驻。 */
const IDLE_UNLOAD_MIN = 1;
/** 单条工作进程请求的超时（冷启动含模型加载也在其中） */
const WORKER_REQUEST_TIMEOUT_MS = 120_000;

function appSupportDir() {
  return path.join(os.homedir(), 'Library', 'Application Support', 'SimpleUI');
}
export function modelDir() {
  // 允许用环境变量指向已就绪的模型目录（自测/离线场景）
  return process.env.SIMPLEUI_EMBED_DIR || path.join(appSupportDir(), 'models', 'embeddinggemma2');
}

function fetchToFile(url, dest, onProgress, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('too many redirects'));
    const req = https.get(url, { headers: { 'user-agent': 'SimpleUI/1.0' } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        return resolve(fetchToFile(next, dest, onProgress, redirects + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const total = parseInt(res.headers['content-length'] || '0', 10);
      let received = 0;
      const tmp = `${dest}.part`;
      const out = fs.createWriteStream(tmp);
      res.on('data', (d) => {
        received += d.length;
        if (onProgress) onProgress(received, total);
      });
      res.pipe(out);
      out.on('finish', () => {
        out.close(() => {
          fs.renameSync(tmp, dest);
          resolve();
        });
      });
      out.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(60000, () => { req.destroy(new Error('timeout')); });
  });
}

class EmbedService {
  constructor() {
    this.child = null;        // embed_worker 子进程（含 ONNX 会话）
    this.pending = new Map(); // id -> { resolve, reject, timer }
    this.reqId = 0;
    this.loading = null;      // 拉起 + 预热的进行中 promise
    this.lastUsed = 0;
    this.progress = null;     // 模型下载进度
    this.downloading = false;
    this.idleTimer = null;
  }

  get dir() { return modelDir(); }

  /** 需要哪些文件（按是否要用图片决定要不要视觉编码器） */
  requiredFiles(needVision) {
    return [...COMMON_FILES, ...TEXT_FILES, ...(needVision ? VISION_FILES : [])];
  }

  missingFiles(needVision) {
    const dir = this.dir;
    return this.requiredFiles(needVision).filter((rel) => {
      const p = path.join(dir, rel);
      try {
        const st = fs.statSync(p);
        // 配置文件很小（preprocessor_config.json 只有 560 字节），
        // 只有权重才用体积判定，否则会把正常的配置误判成缺失。
        if (rel.endsWith('.onnx') || rel.endsWith('.onnx_data')) return st.size < 64 * 1024;
        return st.size === 0;
      } catch {
        return true;
      }
    });
  }

  /** 已安装体积（用于设置页展示） */
  installedBytes() {
    let total = 0;
    const walk = (d) => {
      let ents = [];
      try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else { try { total += fs.statSync(p).size; } catch {} }
      }
    };
    walk(this.dir);
    return total;
  }

  async ensureFiles(needVision, onProgress) {
    if (this.downloading) throw new Error('model download already in progress');
    const missing = this.missingFiles(needVision);
    if (!missing.length) return { downloaded: 0 };
    this.downloading = true;
    fs.mkdirSync(this.dir, { recursive: true });
    let done = 0;
    try {
      for (const rel of missing) {
        const dest = path.join(this.dir, rel);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        this.progress = { file: rel, received: 0, total: 0, index: done + 1, count: missing.length };
        await fetchToFile(HF_BASE + rel, dest, (received, total) => {
          this.progress = { file: rel, received, total, index: done + 1, count: missing.length };
          if (onProgress) onProgress(this.progress);
        });
        done++;
      }
      this.progress = null;
      return { downloaded: done };
    } finally {
      this.downloading = false;
    }
  }

  // ---------- 工作进程管理 ----------

  get workerAlive() {
    return !!this.child && this.child.exitCode === null && !this.child.killed;
  }

  /** 拉起工作进程（幂等） */
  ensureWorker() {
    if (this.workerAlive) return;
    const workerPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'embed_worker.js');
    const child = fork(workerPath, ['--model-dir', this.dir], {
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    child.on('message', (msg) => {
      if (!msg || !msg.id) return;
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.vectors);
      else p.reject(new Error(msg.error || 'worker error'));
    });
    child.on('exit', () => {
      // 工作进程死亡（闲置被杀 / 崩溃 / 退出链）：它名下的在途请求立即失败，
      // 下次使用会重新拉起一个全新进程 —— 不存在「dispose 后挂起」的问题。
      // 注意：必须按实例归属清理。killWorker 后新进程可能已经拉起，而旧进程的
      // exit 事件是异步迟到的 —— 无条件 this.child = null 会把新进程的句柄抹掉、
      // 并把新进程的预热请求一起拒掉（与 watchdog.js 记录过的「误杀新服务」同类竞态）。
      if (this.child === child) this.child = null;
      for (const [id, p] of this.pending) {
        if (p.child !== child) continue;
        clearTimeout(p.timer);
        this.pending.delete(id);
        p.reject(new Error('embed worker exited'));
      }
    });
    this.child = child;
  }

  /** 向工作进程发一条请求；超时或进程死亡都会 reject */
  request(op, payload = {}) {
    if (!this.workerAlive) this.ensureWorker();
    const id = ++this.reqId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`embed worker request timeout: ${op}`));
      }, WORKER_REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer, child: this.child });
      try {
        this.child.send({ id, op, ...payload });
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  /** 拉起工作进程并把模型读进内存（开窗预载 / 首次使用都会走到这里） */
  async load(needVision) {
    if (this.workerAlive) return;
    if (this.loading) return this.loading;
    this.loading = (async () => {
      const missing = this.missingFiles(needVision);
      if (missing.length) throw new Error(`model files missing: ${missing.slice(0, 3).join(', ')}`);
      this.ensureWorker();
      // 预热：让工作进程完成 tokenizer + 双会话加载（文本 + 视觉）
      await this.request('embedTexts', { texts: ['warmup'], dim: 768 });
      this.touch();
    })().finally(() => { this.loading = null; });
    return this.loading;
  }

  /** 卸载 = 杀掉工作进程。内存由操作系统保证归还，不存在 dispose 后挂起的问题 */
  async unload() {
    this.killWorker();
  }

  killWorker() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.child) {
      try { this.child.kill(); } catch {}
      this.child = null;
    }
  }

  /** 每次使用后调用：重置闲置计时；到点且无在途请求时杀掉工作进程 */
  touch() {
    this.lastUsed = Date.now();
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const minutes = IDLE_UNLOAD_MIN;
    if (minutes <= 0) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (!this.workerAlive) return;
      if (this.pending.size > 0) {
        this.touch();
        return;
      }
      const idleMs = Date.now() - this.lastUsed;
      if (idleMs < minutes * 60_000) {
        this.touch();
        return;
      }
      console.log(`[Embed] 闲置 ${minutes} 分钟，卸载嵌入模型`);
      this.killWorker();
    }, minutes * 60_000);
    this.idleTimer.unref?.();
  }

  /** 统一退出链接口：杀工作进程 + 清计时器（进程退出本身也会释放一切） */
  shutdownSync() {
    this.killWorker();
  }

  // ---------- 嵌入接口（对 folder_index 引擎的 API 保持不变） ----------

  /**
   * 文本批量编码。input 是已经带好前缀的整串（文档用 `title: … | text: …`，
   * 查询用 `task: search result | query: …`）—— 前缀决定召回质量，别省。
   */
  async embedTexts(texts, dim = 768) {
    await this.load(false);
    const vectors = await this.request('embedTexts', { texts, dim });
    this.touch();
    return vectors.map((v) => EmbedService.l2normalize(v, Math.min(dim, v.length)));
  }

  /** 单张图片编码（走视觉编码器 → 与文本同一 768 维空间） */
  async embedImage(filePath, dim = 768) {
    await this.load(true);
    const vectors = await this.request('embedImage', { path: filePath, dim });
    this.touch();
    return EmbedService.l2normalize(vectors[0], Math.min(dim, vectors[0].length));
  }

  static l2normalize(vec, dim) {
    const out = new Float32Array(dim);
    let sum = 0;
    for (let i = 0; i < dim; i++) {
      const v = vec[i] || 0;
      out[i] = v;
      sum += v * v;
    }
    const n = Math.sqrt(sum) || 1;
    for (let i = 0; i < dim; i++) out[i] /= n;
    return out;
  }

  status() {
    const full = this.missingFiles(true).length === 0;
    const text = this.missingFiles(false).length === 0;
    const installed = full ? 'full' : text ? 'text' : 'none';
    const p = this.progress;
    const loading = !!this.loading;
    const progressPercent = p
      ? Math.min(100, ((p.index - 1) + (p.total ? p.received / p.total : 0)) / Math.max(p.count, 1) * 100)
      : 0;
    return {
      dir: this.dir,
      installed,
      installedBytes: this.installedBytes(),
      loaded: this.workerAlive,
      downloading: this.downloading,
      progress: p,
      // —— 卡片/状态栏用 ——
      // idle：模型还没下载；loading：窗口打开后正在把模型读进内存；running：已驻留；
      // standby：模型已下载但未驻留。与 3D 建模服务同一套四态语义。
      status: installed === 'none' ? 'idle' : loading ? 'loading' : this.workerAlive ? 'running' : 'standby',
      running: this.workerAlive,
      loading,
      runtimeReady: true,
      model: {
        ready: installed === 'full',
        partial: installed === 'text',
        name: 'EmbeddingGemma-2',
        sizeDesc: '314 MB + 186 MB · int8',
      },
      download: {
        active: this.downloading,
        progressPercent,
        currentFile: p?.file || '',
        downloadedBytes: p?.received || 0,
        totalBytes: p?.total || 0,
      },
    };
  }
}

export const embedService = new EmbedService();
