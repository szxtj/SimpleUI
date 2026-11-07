import fs from 'fs';
import path from 'path';
import https from 'https';
import os from 'os';

/**
 * EmbeddingGemma-2 端侧嵌入服务（ONNX / onnxruntime-node）。
 *
 * 模型：`onnx-community/embeddinggemma-2-ONNX`，取 int8（quantized）文本编码器
 *       与 int8 视觉编码器。M4 实测（2026-11）：
 *         文本 int8：批 8 时约 20~50 块/s（视块长），单块查询 ~60ms
 *         视觉 int8：max_soft_tokens=64（576 patch）约 400ms/图，与骁龙 8 Gen 2 手机持平
 *       q4f16 更小但 CPU 上更慢（MatMulNBits 走的是参考实现），fp16 最慢，故一律 int8。
 *
 * 运行时选择：macOS 上 ORT 没有 NPU 通路（CoreML EP 对本图只认 11/1042 个节点，
 * 实测等于全 CPU），所以这里就是 CPU 推理，不设 device 参数。
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

/** 图片软 token 上限：280 是模型满配（2520 patch ≈ 2.2s/图），64 是实测的速度/质量拐点 */
const DEFAULT_IMAGE_SOFT_TOKENS = 64;
/** 一批最多多少段一起编码（再大收益递减，还会顶满内存） */
const TEXT_BATCH = 8;

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
    this.model = null;
    this.processor = null;
    this.AutoModel = null;
    this.loading = null;
    this.lastUsed = 0;
    this.progress = null; // { file, received, total, index, count }
    this.downloading = false;
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

  async load(needVision) {
    if (this.model) return this.model;
    if (this.loading) return this.loading;
    this.loading = (async () => {
      const missing = this.missingFiles(needVision);
      if (missing.length) throw new Error(`model files missing: ${missing.slice(0, 3).join(', ')}`);
      const tf = await import('@huggingface/transformers');
      tf.env.allowRemoteModels = false;
      tf.env.allowLocalModels = true;
      tf.env.localModelPath = path.dirname(this.dir);
      tf.env.cacheDir = path.join(appSupportDir(), 'models', '.cache');

      this.processor = await tf.AutoProcessor.from_pretrained(path.basename(this.dir));
      const config = await tf.AutoConfig.from_pretrained(path.basename(this.dir));
      config.audio_config = null; // 音频编码器不下载、不加载
      this.model = await tf.AutoModel.from_pretrained(path.basename(this.dir), {
        config,
        dtype: needVision ? { model: 'q8', vision_encoder: 'q8' } : 'q8',
      });
      this.RawImage = tf.RawImage;
      this.lastUsed = Date.now();
      return this.model;
    })().finally(() => { this.loading = null; });
    return this.loading;
  }

  async unload() {
    if (!this.model) return;
    try { await this.model.dispose?.(); } catch {}
    this.model = null;
    this.processor = null;
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

  /**
   * 文本批量编码。input 是已经带好前缀的整串（文档用 `title: … | text: …`，
   * 查询用 `task: search result | query: …`）—— 前缀决定召回质量，别省。
   */
  async embedTexts(texts, dim = 768) {
    const model = await this.load(false);
    const out = [];
    for (let i = 0; i < texts.length; i += TEXT_BATCH) {
      const batch = texts.slice(i, i + TEXT_BATCH);
      const inputs = await this.processor(batch);
      const res = await model(inputs);
      const data = res.sentence_embedding.data;
      const d = res.sentence_embedding.dims[1];
      for (let b = 0; b < batch.length; b++) {
        out.push(EmbedService.l2normalize(data.subarray(b * d, (b + 1) * d), Math.min(dim, d)));
      }
    }
    this.lastUsed = Date.now();
    return out;
  }

  /** 单张图片编码（走视觉编码器 → 与文本同一 768 维空间） */
  async embedImage(filePath, dim = 768) {
    const model = await this.load(true);
    const img = await this.RawImage.read(filePath);
    const prev = this.processor.image_processor.max_soft_tokens;
    this.processor.image_processor.max_soft_tokens = DEFAULT_IMAGE_SOFT_TOKENS;
    try {
      const inputs = await this.processor(null, img);
      const res = await model(inputs);
      const d = res.sentence_embedding.dims[1];
      this.lastUsed = Date.now();
      return EmbedService.l2normalize(res.sentence_embedding.data.subarray(0, d), Math.min(dim, d));
    } finally {
      this.processor.image_processor.max_soft_tokens = prev;
    }
  }

  /**
   * 给设置卡片 / 状态栏 / 窗口共用的一份状态。
   * 形状对齐 scene3d：{ status, running, model:{ready} }，方便复用同一套
   * deriveServiceState 与状态文案。
   */
  status() {
    const full = this.missingFiles(true).length === 0;
    const text = this.missingFiles(false).length === 0;
    const installed = full ? 'full' : text ? 'text' : 'none';
    const p = this.progress;
    const progressPercent = p
      ? Math.min(100, ((p.index - 1) + (p.total ? p.received / p.total : 0)) / Math.max(p.count, 1) * 100)
      : 0;
    return {
      dir: this.dir,
      installed,
      installedBytes: this.installedBytes(),
      loaded: !!this.model,
      downloading: this.downloading,
      progress: p,
      // —— 卡片/状态栏用 ——
      status: installed === 'none' ? 'idle' : this.model ? 'running' : 'standby',
      running: !!this.model,
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
