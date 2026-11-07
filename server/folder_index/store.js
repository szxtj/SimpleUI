import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

/**
 * 单文件夹索引的磁盘格式与读写。
 *
 * 目录结构（`~/Library/Application Support/SimpleUI/folder-index/<id>/`）：
 *   meta.json    索引身份与参数（root / dim / 模型版本 / 暂停状态）
 *   files.json   每个文件的指纹与状态（断点续建就靠它）
 *   chunks.jsonl 追加式文本块，一行一块
 *   vectors.bin  追加式向量，与 chunks.jsonl 的行一一对齐
 *   commit.json  已提交的行数与字节数 —— 唯一可信的「水位线」
 *
 * 原子性约定（用户要求「不要有残损索引」）：
 *   1. 先写 chunks/vectors（可能是半条），再写 commit.json（临时文件 + rename）；
 *   2. 启动时按 commit.json 把两个文件截断到水位线，半条记录一律丢弃；
 *   3. meta/files 同样走临时文件 + rename，永远不会读到半个 JSON。
 */
export const INDEX_DIR_NAME = 'folder-index';

const META_VERSION = 1;

function atomicWriteJson(file, obj) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, file);
}

export class IndexStore {
  constructor(dir, meta, files, chunks, vectors, committed) {
    this.dir = dir;
    this.meta = meta;
    this.files = files; // relPath -> { size, mtime, state, chunks, pages }
    this.chunks = chunks; // [{ relPath, page, text }]
    this.vectors = vectors; // Float32Array（chunks.length * dim）
    this.committed = committed; // { lines, bytes }
    this.dirtyFiles = false;
  }

  get dim() { return this.meta.dim; }

  static create(baseDir, rootPath, name) {
    const id = crypto.createHash('sha1').update(rootPath).digest('hex').slice(0, 16);
    const dir = path.join(baseDir, id);
    fs.mkdirSync(dir, { recursive: true });
    const meta = {
      version: META_VERSION,
      id,
      root: rootPath,
      name,
      dim: 256,
      model: 'embeddinggemma-2-q8',
      createdAt: Date.now(),
      paused: false,
      lastIndexedAt: null,
    };
    atomicWriteJson(path.join(dir, 'meta.json'), meta);
    fs.writeFileSync(path.join(dir, 'chunks.jsonl'), '');
    fs.writeFileSync(path.join(dir, 'vectors.bin'), '');
    atomicWriteJson(path.join(dir, 'commit.json'), { lines: 0, bytes: 0 });
    atomicWriteJson(path.join(dir, 'files.json'), {});
    return new IndexStore(dir, meta, {}, [], new Float32Array(0), { lines: 0, bytes: 0 });
  }

  static open(dir) {
    const metaPath = path.join(dir, 'meta.json');
    if (!fs.existsSync(metaPath)) return null;
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    const filesPath = path.join(dir, 'files.json');
    const files = fs.existsSync(filesPath) ? JSON.parse(fs.readFileSync(filesPath, 'utf8')) : {};
    const commitPath = path.join(dir, 'commit.json');
    let committed = fs.existsSync(commitPath) ? JSON.parse(fs.readFileSync(commitPath, 'utf8')) : { lines: 0, bytes: 0 };

    // —— 回滚到水位线：丢掉上次进程被杀时写了一半的尾巴 ——
    const chunksPath = path.join(dir, 'chunks.jsonl');
    const vectorsPath = path.join(dir, 'vectors.bin');
    const rawChunks = fs.existsSync(chunksPath) ? fs.readFileSync(chunksPath, 'utf8') : '';
    const lines = rawChunks.split('\n').filter(Boolean).slice(0, committed.lines);
    const chunks = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const dim = meta.dim || 256;
    const expectBytes = chunks.length * dim * 4;
    const vbuf = fs.existsSync(vectorsPath) ? fs.readFileSync(vectorsPath) : Buffer.alloc(0);
    const useBytes = Math.min(vbuf.length, expectBytes);
    const vectors = new Float32Array(useBytes / 4);
    Buffer.from(vectors.buffer, 0, useBytes).set(vbuf.subarray(0, useBytes));

    // 文件位置不合法（被截断）时顺手把磁盘也修好，避免下次再算一遍
    if (lines.length !== committed.lines || useBytes !== (committed.bytes || 0)) {
      fs.writeFileSync(chunksPath, lines.length ? lines.join('\n') + '\n' : '');
      fs.writeFileSync(vectorsPath, Buffer.from(vectors.buffer, 0, useBytes));
      atomicWriteJson(commitPath, { lines: chunks.length, bytes: useBytes });
      committed = { lines: chunks.length, bytes: useBytes };
    }

    return new IndexStore(dir, meta, files, chunks, vectors, committed);
  }

  saveMeta() { atomicWriteJson(path.join(this.dir, 'meta.json'), this.meta); }
  saveFiles() {
    if (!this.dirtyFiles) return;
    atomicWriteJson(path.join(this.dir, 'files.json'), this.files);
    this.dirtyFiles = false;
  }

  setFile(relPath, patch) {
    const prev = this.files[relPath] || {};
    this.files[relPath] = { ...prev, ...patch };
    this.dirtyFiles = true;
  }

  /** 追加一批块（文本 + 已归一化向量），一次落盘并推进水位线 */
  appendBatch(records) {
    if (!records.length) return;
    const dim = this.dim;
    let chunkBuf = '';
    const vecBuf = Buffer.alloc(records.length * dim * 4);
    records.forEach((r, i) => {
      chunkBuf += JSON.stringify({ relPath: r.relPath, page: r.page, text: r.text }) + '\n';
      const v = r.vector;
      const off = i * dim * 4;
      for (let d = 0; d < dim; d++) vecBuf.writeFloatLE(v[d] || 0, off + d * 4);
    });

    fs.appendFileSync(path.join(this.dir, 'chunks.jsonl'), chunkBuf);
    fs.appendFileSync(path.join(this.dir, 'vectors.bin'), vecBuf);

    // 内存副本同步（检索读的是这一份）
    for (const r of records) this.chunks.push({ relPath: r.relPath, page: r.page, text: r.text });
    this.ensureVectorCapacity(this.chunks.length * dim);
    this.vectors.set(new Float32Array(vecBuf.buffer, vecBuf.byteOffset, records.length * dim), (this.chunks.length - records.length) * dim);

    this.committed = {
      lines: this.chunks.length,
      bytes: this.chunks.length * dim * 4,
    };
    atomicWriteJson(path.join(this.dir, 'commit.json'), this.committed);
  }

  ensureVectorCapacity(n) {
    if (this.vectors.length >= n) return;
    let cap = Math.max(1024 * this.dim, this.vectors.length * 2);
    while (cap < n) cap *= 2;
    const next = new Float32Array(cap);
    next.set(this.vectors);
    this.vectors = next;
  }

  /** 前 k 个块（按余弦相似度）。向量都是归一化过的，点积即余弦 */
  search(queryVec, limit = 40) {
    const dim = this.dim;
    const n = this.chunks.length;
    const scored = [];
    for (let i = 0; i < n; i++) {
      let dot = 0;
      const off = i * dim;
      for (let d = 0; d < dim; d++) dot += queryVec[d] * this.vectors[off + d];
      scored.push({ i, score: dot });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map(({ i, score }) => ({ ...this.chunks[i], score }));
  }

  stats() {
    const fileList = Object.values(this.files);
    return {
      files: fileList.length,
      done: fileList.filter((f) => f.state === 'done').length,
      pages: fileList.reduce((s, f) => s + (f.pages || 0), 0),
      chunks: this.chunks.length,
      images: fileList.filter((f) => f.kind === 'image').length,
    };
  }

  drop() {
    fs.rmSync(this.dir, { recursive: true, force: true });
  }
}
