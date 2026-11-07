import { URL } from 'url';
import fs from 'fs';
import path from 'path';
import { folderIndex } from './folder_index/engine.js';
import { embedService } from './embed_service.js';

/**
 * 文件夹快速检索服务（/api/folder_index/*）。
 *
 * 与其它受管服务的区别：这里没有独立子进程、没有端口，模型和索引都在 proxy 进程里。
 * 生命周期靠窗口驱动：
 *   - 窗口打开 → /open（标记窗口活着，按需续建，暂停态不动）
 *   - 窗口关闭 → /close（停止建索引，等当前批落盘后卸载模型）
 */
class FolderIndexService {
  constructor() {
    this.windowOpen = false;
    this.activeId = null;
  }

  init() {
    // 上次进程被强杀时可能有半条记录，这里把全部索引回滚到水位线（顺带修好磁盘）
    try {
      for (const item of folderIndex.list()) folderIndex.getStore(item.id);
      console.log('[FolderIndex] 索引已就绪');
    } catch (err) {
      console.warn('[FolderIndex] 初始化失败:', err.message);
    }
  }

  async handleApi(req, res) {
    const host = req.headers.host || '127.0.0.1:31235';
    const urlObj = new URL(req.url, `http://${host}`);
    const pathname = urlObj.pathname.replace(/^\/api\/folder_index/, '');

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
    const readBody = () => new Promise((resolve) => {
      if (req.method !== 'POST') return resolve({});
      let raw = '';
      req.on('data', (c) => { raw += c; if (raw.length > 1e6) req.destroy(); });
      req.on('end', () => {
        try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); }
      });
    });

    try {
      const body = await readBody();

      if (pathname === '/list' && req.method === 'GET') {
        sendJson(200, { items: folderIndex.list(), embed: embedService.status() });
        return;
      }

      if (pathname === '/add' && req.method === 'POST') {
        if (!body.path) return sendJson(400, { error: '缺少路径' });
        const item = await folderIndex.addFolder(body.path);
        sendJson(200, { item });
        return;
      }

      if (pathname === '/remove' && req.method === 'POST') {
        const ok = folderIndex.remove(body.id);
        sendJson(200, { ok });
        return;
      }

      if (pathname === '/pause' && req.method === 'POST') {
        const ok = folderIndex.setPaused(body.id, !!body.paused);
        sendJson(200, { ok, item: folderIndex.list().find((x) => x.id === body.id) });
        return;
      }

      if (pathname === '/start' && req.method === 'POST') {
        // 用户点「继续」：先解除暂停，再开跑
        folderIndex.setPaused(body.id, false);
        folderIndex.start(body.id, { reason: 'manual' }).catch((e) => {
          console.warn('[FolderIndex] 建索引失败:', e.message);
        });
        sendJson(200, { ok: true });
        return;
      }

      if (pathname === '/open' && req.method === 'POST') {
        this.windowOpen = true;
        this.activeId = body.id || null;
        // 与 3D 建模服务同构：开窗即后台把模型读进内存（loading → running），
        // 关窗（/close）卸载。模型没下载完时静默跳过——前端自己拉下载。
        if (embedService.missingFiles(true).length === 0) {
          embedService.load(true).catch((e) => {
            console.warn('[FolderIndex] 开窗预载模型失败:', e.message);
          });
        }
        // 打开窗口不阻塞：模型没装就先不建，前端自己拉下载
        if (this.activeId) {
          const item = folderIndex.list().find((x) => x.id === this.activeId);
          if (item && !item.paused) {
            folderIndex.start(this.activeId, { reason: 'open' }).catch(() => {});
          }
        }
        sendJson(200, { ok: true });
        return;
      }

      if (pathname === '/close' && req.method === 'POST') {
        this.windowOpen = false;
        const id = body.id || this.activeId;
        if (id) await folderIndex.stop(id);
        await embedService.unload();
        sendJson(200, { ok: true });
        return;
      }

      if (pathname === '/status' && req.method === 'GET') {
        const id = urlObj.searchParams.get('id');
        const item = folderIndex.list().find((x) => x.id === id);
        sendJson(200, { item: item || null, embed: embedService.status() });
        return;
      }

      // 图片缩略图：直接把原图吐给页面（WKWebView 不能加载 file://）
      if (pathname === '/thumb' && req.method === 'GET') {
        const id = urlObj.searchParams.get('id');
        const rel = urlObj.searchParams.get('rel') || '';
        const store = folderIndex.getStore(id);
        if (!store) return sendJson(404, { error: 'no index' });
        const abs = path.join(store.meta.root, rel);
        const normalized = path.resolve(abs);
        if (!normalized.startsWith(path.resolve(store.meta.root))) return sendJson(403, { error: 'forbidden' });
        const ext = path.extname(normalized).toLowerCase();
        const mime = {
          '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
          '.heic': 'image/heic', '.heif': 'image/heif', '.webp': 'image/webp',
          '.gif': 'image/gif', '.bmp': 'image/bmp', '.tiff': 'image/tiff', '.tif': 'image/tiff',
        }[ext];
        if (!mime) return sendJson(415, { error: 'not an image' });
        try {
          const stat = fs.statSync(normalized);
          if (stat.size > 24 * 1024 * 1024) return sendJson(413, { error: 'too large' });
          res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'max-age=60' });
          fs.createReadStream(normalized).pipe(res);
        } catch {
          sendJson(404, { error: 'not found' });
        }
        return;
      }

      if (pathname === '/search' && req.method === 'GET') {
        const id = urlObj.searchParams.get('id');
        const q = urlObj.searchParams.get('q') || '';
        const limit = Math.min(parseInt(urlObj.searchParams.get('limit') || '40', 10) || 40, 100);
        const result = await folderIndex.search(id, q, limit);
        sendJson(200, result);
        return;
      }

      // 模型准备：后台下载，前端轮询 /model
      if (pathname === '/model' && req.method === 'GET') {
        sendJson(200, embedService.status());
        return;
      }
      if (pathname === '/model/prepare' && req.method === 'POST') {
        const needVision = body.needVision !== false;
        embedService.ensureFiles(needVision).catch((e) => {
          console.warn('[FolderIndex] 模型下载失败:', e.message);
        });
        sendJson(200, embedService.status());
        return;
      }
      if (pathname === '/model/load' && req.method === 'POST') {
        embedService.load(body.needVision !== false)
          .then(() => sendJson(200, { ok: true }))
          .catch((e) => sendJson(500, { error: e.message }));
        return;
      }

      sendJson(404, { error: 'not found' });
    } catch (err) {
      sendJson(500, { error: String(err.message || err) });
    }
  }
}

export const folderIndexService = new FolderIndexService();
