import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import os from 'os';
import { IndexStore } from './store.js';
import { extractFile, chunkPages, IMAGE_EXTS } from './extract.js';
import { embedService } from '../embed_service.js';

/**
 * 文件夹索引管理器：扫描 → 抽取 → 分块 → 向量化 → 落盘，以及检索。
 *
 * 三条硬约束（与产品约定一致）：
 *   1. 一个「用户指定的根目录」= 一个索引，按 realpath 唯一确定；子目录全部递归读。
 *   2. 关窗即停：`stop()` 只在**当前批**完成后退出（≤8 块），退出前必落盘，
 *      所以任何时候被杀都不会留下半个索引。
 *   3. 暂停是持久的：写进 meta.paused，重开窗口不会自动续，必须用户点「继续」。
 */

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', 'Library', '.Trash', '__pycache__',
  '.venv', 'venv', 'dist', 'build', '.next', '.cache', 'Pods',
]);
/** 单文件上限：超过只索引文件名，不解析内容 */
const MAX_FILE_BYTES = 200 * 1024 * 1024;
const BATCH_CHUNKS = 24;

function appSupportDir() {
  return path.join(os.homedir(), 'Library', 'Application Support', 'SimpleUI');
}

function isHidden(name) {
  return name.startsWith('.');
}

function kindOf(absPath) {
  const ext = path.extname(absPath).toLowerCase();
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (ext === '.pdf') return 'pdf';
  if (['.docx', '.pptx', '.xlsx', '.txt', '.md', '.markdown', '.csv', '.tsv', '.json',
       '.yaml', '.yml', '.log', '.xml', '.html', '.htm', '.rtf', '.tex', '.srt', '.vtt',
       '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.swift', '.c', '.h', '.cpp',
       '.hpp', '.java', '.go', '.rs', '.sh', '.zsh', '.css', '.sql', '.toml', '.ini'].includes(ext)) return 'text';
  return 'other';
}

async function scanDir(root) {
  const out = [];
  const walk = async (dir) => {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (isHidden(e.name) || e.name === '.DS_Store') continue;
      const abs = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        if (e.name.endsWith('.app') || e.name.endsWith('.photoslibrary')) continue;
        await walk(abs);
        continue;
      }
      if (!e.isFile()) continue;
      let st;
      try { st = await fsp.stat(abs); } catch { continue; }
      if (st.size > MAX_FILE_BYTES) continue;
      out.push({
        abs,
        rel: path.relative(root, abs),
        size: st.size,
        mtime: Math.floor(st.mtimeMs),
        kind: kindOf(abs),
      });
    }
  };
  await walk(root);
  return out;
}

export class FolderIndexManager {
  constructor() {
    this.baseDir = process.env.SIMPLEUI_INDEX_DIR || path.join(appSupportDir(), 'folder-index');
    this.stores = new Map(); // id -> IndexStore
    this.jobs = new Map(); // id -> { running, paused, cancel, progress }
  }

  // ---------- 索引管理 ----------

  list() {
    const ids = [];
    try {
      for (const e of fs.readdirSync(this.baseDir, { withFileTypes: true })) {
        if (e.isDirectory()) ids.push(e.name);
      }
    } catch {
      return [];
    }
    return ids
      .map((id) => this.getStore(id))
      .filter(Boolean)
      .map((s) => this.describe(s))
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  }

  getStore(id) {
    if (this.stores.has(id)) return this.stores.get(id);
    const store = IndexStore.open(path.join(this.baseDir, id));
    if (store) this.stores.set(id, store);
    return store;
  }

  describe(store) {
    const stats = store.stats();
    const job = this.jobs.get(store.meta.id);
    return {
      id: store.meta.id,
      root: store.meta.root,
      name: store.meta.name,
      paused: !!store.meta.paused,
      createdAt: store.meta.createdAt,
      lastIndexedAt: store.meta.lastIndexedAt,
      dim: store.dim,
      ...stats,
      running: !!job?.running,
      progress: job?.progress || null,
      exists: fs.existsSync(store.meta.root),
    };
  }

  async addFolder(rootPath) {
    const real = await fsp.realpath(rootPath).catch(() => null);
    if (!real) throw new Error('路径不存在或无法访问');
    const st = await fsp.stat(real).catch(() => null);
    if (!st || !st.isDirectory()) throw new Error('不是文件夹');

    const existing = this.list().find((x) => x.root === real);
    if (existing) return existing;

    const store = IndexStore.create(this.baseDir, real, path.basename(real));
    this.stores.set(store.meta.id, store);
    return this.describe(store);
  }

  remove(id) {
    const store = this.getStore(id);
    if (!store) return false;
    const job = this.jobs.get(id);
    if (job) job.cancel = true;
    this.jobs.delete(id);
    this.stores.delete(id);
    store.drop();
    return true;
  }

  setPaused(id, paused) {
    const store = this.getStore(id);
    if (!store) return false;
    store.meta.paused = !!paused;
    store.saveMeta();
    const job = this.jobs.get(id);
    if (paused && job) job.stopRequested = true;
    return true;
  }

  // ---------- 建索引 ----------

  isRunning(id) {
    return !!this.jobs.get(id)?.running;
  }

  /**
   * 开始/继续建索引。已经跑着就直接返回。
   * @param {string} id
   * @param {{ reason?: 'open'|'manual' }} opts  open = 窗口打开时触发；已暂停则不动
   */
  async start(id, opts = {}) {
    const store = this.getStore(id);
    if (!store) throw new Error('索引不存在');
    if (this.isRunning(id)) return;
    if (opts.reason === 'open' && store.meta.paused) return;

    const job = { running: true, stopRequested: false, cancel: false, progress: null };
    this.jobs.set(id, job);

    try {
      await this.run(store, job);
    } finally {
      job.running = false;
      store.meta.lastIndexedAt = Date.now();
      store.saveFiles();
      store.saveMeta();
      if (this.jobs.get(id) === job) this.jobs.delete(id);
    }
  }

  /** 关窗调用：让当前批做完再退（不写坏文件），并释放模型 */
  async stop(id) {
    const job = this.jobs.get(id);
    if (job) job.stopRequested = true;
    // 等它自然收尾，最多 10s
    const started = Date.now();
    while (this.jobs.get(id)?.running && Date.now() - started < 10000) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  async stopAll() {
    for (const id of this.jobs.keys()) {
      const job = this.jobs.get(id);
      if (job) job.stopRequested = true;
    }
  }

  async run(store, job) {
    const root = store.meta.root;
    if (!fs.existsSync(root)) {
      job.progress = { phase: 'error', error: '文件夹不存在（可能被移动或删除）' };
      return;
    }

    job.progress = { phase: 'scan' };
    const files = await scanDir(root);

    // 差异：新增 / 修改 / 删除
    const seen = new Set();
    const pending = [];
    for (const f of files) {
      seen.add(f.rel);
      const prev = store.files[f.rel];
      if (!prev || prev.size !== f.size || prev.mtime !== f.mtime || prev.state !== 'done') {
        pending.push(f);
      }
    }
    const removed = Object.keys(store.files).filter((rel) => !seen.has(rel));
    for (const rel of removed) delete store.files[rel];
    if (removed.length) store.dirtyFiles = true;

    const total = pending.length;
    job.progress = { phase: 'index', total, done: 0, chunks: 0 };

    let buffer = [];
    const flush = () => {
      if (!buffer.length) return;
      store.appendBatch(buffer);
      buffer = [];
      store.saveFiles();
    };

    for (let i = 0; i < pending.length; i++) {
      if (job.stopRequested || job.cancel) break;
      const f = pending[i];
      store.setFile(f.rel, {
        size: f.size, mtime: f.mtime, kind: f.kind, state: 'indexing', chunks: 0,
      });

      try {
        if (f.kind === 'image') {
          const vec = await embedService.embedImage(f.abs, store.dim);
          buffer.push({ relPath: f.rel, page: 0, text: `[图片] ${path.basename(f.rel)}`, vector: vec });
          store.setFile(f.rel, { state: 'done', chunks: 1, pages: 0, kind: 'image' });
        } else {
          const { kind, pages } = await extractFile(f.abs);
          if (kind === 'text') {
            const chunks = chunkPages(pages);
            const prefix = `title: ${path.basename(f.rel)} | text: `;
            const vectors = await embedService.embedTexts(chunks.map((c) => prefix + c.text), store.dim);
            chunks.forEach((c, k) => buffer.push({ relPath: f.rel, page: c.page, text: c.text, vector: vectors[k] }));
            store.setFile(f.rel, {
              state: 'done', chunks: chunks.length, pages: pages.length, kind: 'text',
            });
          } else {
            // 抽不出正文：至少把文件名做成一块，保证还能按名字搜到
            const vec = (await embedService.embedTexts(
              [`title: ${path.basename(f.rel)} | text: 文件名`], store.dim
            ))[0];
            buffer.push({ relPath: f.rel, page: 0, text: `[文件] ${path.basename(f.rel)}`, vector: vec });
            store.setFile(f.rel, { state: 'done', chunks: 1, pages: 0, kind: 'other' });
          }
        }
      } catch (err) {
        store.setFile(f.rel, { state: 'failed', error: String(err.message || err).slice(0, 200) });
      }

      if (buffer.length >= BATCH_CHUNKS) flush();

      job.progress = {
        phase: 'index',
        total,
        done: i + 1,
        chunks: store.chunks.length,
        current: f.rel,
      };
      // 让出事件循环，保证窗口查询不被索引任务饿死
      if (i % 4 === 3) await new Promise((r) => setImmediate(r));
    }

    flush();
    job.progress = {
      phase: job.stopRequested || job.cancel ? 'stopped' : 'done',
      total,
      done: job.progress?.done || 0,
      chunks: store.chunks.length,
    };
    store.saveFiles();
    store.saveMeta();

    // 索引停下来了：把模型从内存里还回去（用户要求关窗省性能）
    if (job.stopRequested || job.cancel) await embedService.unload();
  }

  // ---------- 检索 ----------

  /**
   * 语义检索 + 文件名加分。
   * 文件名命中的块会被顶到前面：用户经常记得「那个文件叫什么」，
   * 纯向量的相对排序在这类查询上不如字面匹配可靠。
   */
  async search(id, query, limit = 40) {
    const store = this.getStore(id);
    if (!store) return { items: [], error: '索引不存在' };
    const q = String(query || '').trim();
    if (!q) return { items: [], stats: store.stats() };

    const started = Date.now();
    let semantic = [];
    if (store.chunks.length) {
      const [vec] = await embedService.embedTexts([`task: search result | query: ${q}`], store.dim);
      semantic = store.search(vec, Math.max(limit * 2, 60));
    }

    const lower = q.toLowerCase();
    const nameHits = new Map();
    for (const [rel] of Object.entries(store.files)) {
      const base = path.basename(rel).toLowerCase();
      if (base.includes(lower)) nameHits.set(rel, 1);
    }

    const merged = new Map();
    for (const hit of semantic) {
      const prev = merged.get(hit.relPath);
      const score = hit.score + (nameHits.has(hit.relPath) ? 0.06 : 0);
      if (!prev || score > prev.score) {
        merged.set(hit.relPath, {
          relPath: hit.relPath,
          name: path.basename(hit.relPath),
          dir: path.dirname(hit.relPath) === '.' ? '' : path.dirname(hit.relPath),
          page: hit.page,
          text: hit.text,
          score,
        });
      }
    }
    for (const rel of nameHits.keys()) {
      if (!merged.has(rel)) {
        merged.set(rel, {
          relPath: rel,
          name: path.basename(rel),
          dir: path.dirname(rel) === '.' ? '' : path.dirname(rel),
          page: 0,
          text: '[文件名命中]',
          score: 0.5,
        });
      }
    }

    const items = [...merged.values()].sort((a, b) => b.score - a.score).slice(0, limit);
    return { items, stats: store.stats(), elapsedMs: Date.now() - started };
  }
}

export const folderIndex = new FolderIndexManager();
