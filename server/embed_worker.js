import path from 'path';

/**
 * 嵌入模型工作进程（由 embed_service fork，进程内驻留 ONNX 会话）。
 *
 * 为什么是独立进程而不是代理进程内的会话：
 *   1. **内存释放必须有确定性**。onnxruntime-node 的会话在 `dispose()` 之后再重建会
 *      永久挂起（promise 不落地、无任何报错，实测踩过），所以「闲置卸载」只能靠
 *      杀进程来保证内存真正归还 —— 子进程一死，~500MB 必然归还操作系统。
 *   2. **故障隔离**。原生崩溃不该拖垮代理进程。
 *
 * 协议（stdin/stdout 不用，走 fork 的 IPC，每条消息一个 JSON）：
 *   → { id, op: 'embedTexts', texts: string[], dim }
 *   → { id, op: 'embedImage', path: string, dim }
 *   ← { id, ok: true, vectors: number[][] }   （已 L2 归一化）
 *   ← { id, ok: false, error: string }
 *
 * 生命周期：父进程断开 IPC（父死亡或主动 kill）→ 自动退出。
 */

const args = process.argv.slice(2);
const argOf = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};
const modelDir = argOf('--model-dir') || '';
/** 图片软 token 上限：280 是满配（2520 patch ≈ 2.2s/图），64 是速度/质量拐点 */
const IMAGE_SOFT_TOKENS = 64;
const TEXT_BATCH = 8;

let processor = null;
let model = null;
let RawImage = null;
let loading = null;

function l2normalize(vec, dim) {
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

async function ensureLoaded() {
  if (model) return;
  if (loading) return loading;
  loading = (async () => {
    const tf = await import('@huggingface/transformers');
    tf.env.allowRemoteModels = false;
    tf.env.allowLocalModels = true;
    tf.env.localModelPath = path.dirname(modelDir);
    tf.env.cacheDir = path.join(path.dirname(modelDir), '.cache');

    processor = await tf.AutoProcessor.from_pretrained(path.basename(modelDir));
    const config = await tf.AutoConfig.from_pretrained(path.basename(modelDir));
    config.audio_config = null; // 音频编码器不下载、不加载
    model = await tf.AutoModel.from_pretrained(path.basename(modelDir), {
      config,
      dtype: { model: 'q8', vision_encoder: 'q8' },
    });
    RawImage = tf.RawImage;
    return model;
  })();
  return loading;
}

async function embedTexts(texts, dim) {
  await ensureLoaded();
  const out = [];
  for (let i = 0; i < texts.length; i += TEXT_BATCH) {
    const batch = texts.slice(i, i + TEXT_BATCH);
    const inputs = await processor(batch);
    const res = await model(inputs);
    const data = res.sentence_embedding.data;
    const d = res.sentence_embedding.dims[1];
    for (let b = 0; b < batch.length; b++) {
      out.push(Array.from(l2normalize(data.subarray(b * d, (b + 1) * d), Math.min(dim, d))));
    }
  }
  return out;
}

async function embedImage(filePath, dim) {
  await ensureLoaded();
  const img = await RawImage.read(filePath);
  const prev = processor.image_processor.max_soft_tokens;
  processor.image_processor.max_soft_tokens = IMAGE_SOFT_TOKENS;
  try {
    const inputs = await processor(null, img);
    const res = await model(inputs);
    const d = res.sentence_embedding.dims[1];
    return Array.from(l2normalize(res.sentence_embedding.data.subarray(0, d), Math.min(dim, d)));
  } finally {
    processor.image_processor.max_soft_tokens = prev;
  }
}

process.on('message', async (msg) => {
  if (!msg || !msg.id) return;
  try {
    let vectors;
    if (msg.op === 'embedTexts') {
      vectors = await embedTexts(msg.texts || [], msg.dim || 768);
    } else if (msg.op === 'embedImage') {
      vectors = [await embedImage(msg.path, msg.dim || 768)];
    } else {
      throw new Error(`unknown op: ${msg.op}`);
    }
    process.send({ id: msg.id, ok: true, vectors });
  } catch (err) {
    process.send({ id: msg.id, ok: false, error: String((err && err.message) || err) });
  }
});

// 父进程（代理）死亡或主动断开 IPC → 立即退出，绝不残留孤儿进程
process.on('disconnect', () => process.exit(0));
