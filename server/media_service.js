import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

const HOME = os.homedir();
const USER_CONFIG_DIR = path.join(HOME, 'Library', 'Application Support', 'SimpleUI');
const MEDIA_DIR = path.join(USER_CONFIG_DIR, 'media');

// Ensure media directory exists
try {
  if (!fs.existsSync(MEDIA_DIR)) {
    fs.mkdirSync(MEDIA_DIR, { recursive: true });
  }
} catch (err) {
  console.error('[MediaService] Failed to create media directory:', err);
}

const MIME_MAP = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
};

const EXT_MAP = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/heic': '.heic',
  'image/heif': '.heif',
  'image/bmp': '.bmp',
  'image/svg+xml': '.svg',
};

function detectMimeAndExt(buffer, headerMime, originalFilename) {
  // 1. Inspect magic bytes first for 100% accuracy
  if (buffer.length >= 4) {
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
      return { mime: 'image/png', ext: '.png' };
    }
    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
      return { mime: 'image/jpeg', ext: '.jpg' };
    }
    if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
      return { mime: 'image/gif', ext: '.gif' };
    }
    if (buffer.length >= 12 && buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46) {
      if (buffer.toString('utf8', 8, 12) === 'WEBP') {
        return { mime: 'image/webp', ext: '.webp' };
      }
    }
    if (buffer[0] === 0x42 && buffer[1] === 0x4d) {
      return { mime: 'image/bmp', ext: '.bmp' };
    }
    if (buffer.length >= 12 && buffer.toString('utf8', 4, 8) === 'ftyp') {
      const brand = buffer.toString('utf8', 8, 12).toLowerCase();
      if (brand.startsWith('heic') || brand.startsWith('heix') || brand.startsWith('mif1')) {
        return { mime: 'image/heic', ext: '.heic' };
      }
    }
  }

  // 2. Fall back to header MIME if valid
  if (headerMime && EXT_MAP[headerMime.toLowerCase()]) {
    return { mime: headerMime.toLowerCase(), ext: EXT_MAP[headerMime.toLowerCase()] };
  }

  // 3. Fall back to original file extension if provided
  if (originalFilename) {
    const ext = path.extname(originalFilename).toLowerCase();
    if (MIME_MAP[ext]) {
      return { mime: MIME_MAP[ext], ext };
    }
  }

  return { mime: 'application/octet-stream', ext: '.bin' };
}

class MediaService {
  constructor() {
    this.mediaDir = MEDIA_DIR;
  }

  /**
   * Main HTTP API Handler for /api/media/...
   */
  handleApi(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    const pathname = url.pathname;

    // 1. Upload endpoint: POST /api/media/upload
    if (pathname === '/api/media/upload' && req.method === 'POST') {
      this.handleUpload(req, res);
      return;
    }

    // 2. Delete endpoint: POST /api/media/delete
    if (pathname === '/api/media/delete' && req.method === 'POST') {
      this.handleDelete(req, res);
      return;
    }

    // 3. Garbage collection endpoint: POST /api/media/gc
    if (pathname === '/api/media/gc' && req.method === 'POST') {
      this.handleGC(req, res);
      return;
    }

    // 4. Stats / status endpoint: GET /api/media/stats
    if (pathname === '/api/media/stats' && req.method === 'GET') {
      this.handleStats(req, res);
      return;
    }

    // 5. Serve media asset: GET or HEAD /api/media/:filename
    if (pathname.startsWith('/api/media/') && (req.method === 'GET' || req.method === 'HEAD')) {
      const filename = pathname.replace('/api/media/', '').split('/')[0];
      this.handleServeFile(filename, req, res);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Endpoint not found' }));
  }

  /**
   * Handles binary stream or JSON base64 uploads.
   * Computes content-addressable SHA-256 hash and deduplicates on disk.
   */
  handleUpload(req, res) {
    const contentType = (req.headers['content-type'] || '').toLowerCase();
    const originalFilename = decodeURIComponent(req.headers['x-original-filename'] || '');

    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));

    req.on('end', () => {
      try {
        const bodyBuffer = Buffer.concat(chunks);

        let finalBuffer;
        let mime = '';
        let ext = '';

        // Check if payload is JSON: { data: "data:image/png;base64,...", filename?: "..." }
        if (contentType.includes('application/json')) {
          const json = JSON.parse(bodyBuffer.toString('utf-8'));
          if (!json.data || typeof json.data !== 'string') {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Missing "data" field in JSON body' }));
            return;
          }

          const match = json.data.match(/^data:([^;]+);base64,(.+)$/);
          if (match) {
            mime = match[1];
            finalBuffer = Buffer.from(match[2], 'base64');
          } else {
            // Assume raw base64 string
            finalBuffer = Buffer.from(json.data, 'base64');
          }

          const detected = detectMimeAndExt(finalBuffer, mime, json.filename || originalFilename);
          mime = detected.mime;
          ext = detected.ext;
        } else {
          // Direct binary stream
          finalBuffer = bodyBuffer;
          const detected = detectMimeAndExt(finalBuffer, contentType, originalFilename);
          mime = detected.mime;
          ext = detected.ext;
        }

        if (!finalBuffer || finalBuffer.length === 0) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Empty file payload received' }));
          return;
        }

        // Compute 32-character SHA-256 content hash
        const hash = crypto.createHash('sha256').update(finalBuffer).digest('hex').slice(0, 32);
        const filename = `${hash}${ext}`;
        const targetPath = path.join(this.mediaDir, filename);

        // Deduplicate: only write if not already present on disk
        if (!fs.existsSync(targetPath)) {
          fs.writeFileSync(targetPath, finalBuffer);
          console.log(`[MediaService] Saved new media file: ${filename} (${(finalBuffer.length / 1024).toFixed(1)} KB)`);
        } else {
          console.log(`[MediaService] Deduplicated existing media file: ${filename}`);
        }

        const responsePayload = {
          ok: true,
          url: `/api/media/${filename}`,
          filename,
          size: finalBuffer.length,
          mimeType: mime,
        };

        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        });
        res.end(JSON.stringify(responsePayload));
      } catch (err) {
        console.error('[MediaService] Upload failed:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to process media upload', details: err.message }));
      }
    });

    req.on('error', (err) => {
      console.error('[MediaService] Request stream error:', err);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Upload request stream interrupted' }));
      }
    });
  }

  /**
   * Deletes one or more media files from disk immediately.
   */
  handleDelete(req, res) {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
        const filenames = Array.isArray(body.filenames) ? body.filenames : [];
        const urls = Array.isArray(body.urls) ? body.urls : (body.url ? [body.url] : []);

        const toDelete = new Set();
        for (const f of filenames) {
          if (typeof f === 'string') toDelete.add(path.basename(f));
        }
        for (const u of urls) {
          if (typeof u === 'string') {
            const match = u.match(/\/api\/media\/([a-zA-Z0-9_\-\.]+)/);
            if (match) toDelete.add(match[1]);
          }
        }

        const deleted = [];
        for (const fname of toDelete) {
          if (!/^[a-zA-Z0-9_\-\.]+$/.test(fname)) continue;
          const targetPath = path.join(this.mediaDir, fname);
          if (fs.existsSync(targetPath)) {
            try {
              fs.unlinkSync(targetPath);
              deleted.push(fname);
              console.log(`[MediaService] Deleted media file: ${fname}`);
            } catch (err) {
              console.error(`[MediaService] Error deleting file ${fname}:`, err);
            }
          }
        }

        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        });
        res.end(JSON.stringify({ ok: true, deleted }));
      } catch (err) {
        console.error('[MediaService] Delete failed:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
  }

  /**
   * Garbage collects unreferenced media files from disk.
   * Compares all files on disk with the active referenced filenames.
   * Protects newly uploaded files within a configurable grace period (default 5 minutes).
   */
  handleGC(req, res) {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
        const activeList = Array.isArray(body.activeFilenames) ? body.activeFilenames : [];
        const activeSet = new Set(
          activeList.map((f) => {
            if (typeof f !== 'string') return '';
            const match = f.match(/\/api\/media\/([a-zA-Z0-9_\-\.]+)/);
            return match ? match[1] : path.basename(f);
          }).filter(Boolean)
        );

        // Grace period in seconds (default: 300 = 5 minutes)
        const graceMs = (typeof body.gracePeriodSeconds === 'number' ? body.gracePeriodSeconds : 300) * 1000;
        const now = Date.now();

        let deletedCount = 0;
        let freedBytes = 0;
        const deletedFiles = [];

        if (fs.existsSync(this.mediaDir)) {
          const files = fs.readdirSync(this.mediaDir);
          for (const file of files) {
            if (file.startsWith('.')) continue;
            if (activeSet.has(file)) continue;

            const filePath = path.join(this.mediaDir, file);
            try {
              const stat = fs.statSync(filePath);
              // Protect recently uploaded files within the grace period
              if (now - stat.mtimeMs < graceMs) {
                continue;
              }

              fs.unlinkSync(filePath);
              deletedCount++;
              freedBytes += stat.size;
              deletedFiles.push(file);
              console.log(`[MediaService] GC removed unreferenced media file: ${file} (${(stat.size / 1024).toFixed(1)} KB)`);
            } catch (err) {
              console.warn(`[MediaService] GC could not remove file ${file}:`, err);
            }
          }
        }

        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        });
        res.end(JSON.stringify({
          ok: true,
          deletedCount,
          freedBytes,
          freedMB: (freedBytes / (1024 * 1024)).toFixed(2),
          deletedFiles,
        }));
      } catch (err) {
        console.error('[MediaService] GC failed:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
  }

  /**
   * Serves a stored media file with immutable caching headers.
   */
  handleServeFile(filename, req, res) {
    // Validate filename against directory traversal
    if (!filename || !/^[a-zA-Z0-9_\-\.]+$/.test(filename)) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Invalid filename');
      return;
    }

    const filePath = path.join(this.mediaDir, filename);
    if (!fs.existsSync(filePath)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Media file not found');
      return;
    }

    try {
      const stat = fs.statSync(filePath);
      const ext = path.extname(filename).toLowerCase();
      const contentType = MIME_MAP[ext] || 'application/octet-stream';

      res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Length': stat.size,
        'Cache-Control': 'public, max-age=31536000, immutable',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      });

      if (req.method === 'HEAD') {
        res.end();
        return;
      }

      fs.createReadStream(filePath).pipe(res);
    } catch (err) {
      console.error(`[MediaService] Error serving file ${filename}:`, err);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Internal server error');
      }
    }
  }

  /**
   * Returns disk usage stats of the media storage.
   */
  handleStats(req, res) {
    try {
      let fileCount = 0;
      let totalBytes = 0;
      if (fs.existsSync(this.mediaDir)) {
        const files = fs.readdirSync(this.mediaDir);
        for (const file of files) {
          if (file.startsWith('.')) continue;
          try {
            const stat = fs.statSync(path.join(this.mediaDir, file));
            fileCount++;
            totalBytes += stat.size;
          } catch {
            // ignore
          }
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        mediaDir: this.mediaDir,
        fileCount,
        totalBytes,
        totalMB: (totalBytes / (1024 * 1024)).toFixed(2),
      }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  }

  /**
   * Resolves any local /api/media/<filename> pointers in wire messages to full-fidelity base64 Data URLs
   * right before forwarding to the upstream LLM inference engine.
   */
  resolveMediaUrlsInPayload(payload) {
    if (!payload || !Array.isArray(payload.messages)) return 0;
    let count = 0;

    for (const msg of payload.messages) {
      if (!Array.isArray(msg.content)) continue;

      for (const part of msg.content) {
        if (part && part.type === 'image_url' && part.image_url && typeof part.image_url.url === 'string') {
          const urlStr = part.image_url.url;
          // Matches /api/media/<filename> or http(s)://.../api/media/<filename>
          const match = urlStr.match(/\/api\/media\/([a-zA-Z0-9_\-\.]+)/);
          if (match) {
            const filename = match[1];
            const filePath = path.join(this.mediaDir, filename);

            if (fs.existsSync(filePath)) {
              try {
                const buffer = fs.readFileSync(filePath);
                const ext = path.extname(filename).toLowerCase();
                const mime = MIME_MAP[ext] || 'image/png';
                const base64 = buffer.toString('base64');
                part.image_url.url = `data:${mime};base64,${base64}`;
                count++;
                console.log(`[MediaService] Injected full-fidelity image ${filename} (${(buffer.length / 1024).toFixed(1)} KB) for upstream model`);
              } catch (readErr) {
                console.error(`[MediaService] Error reading media file ${filename}:`, readErr);
              }
            } else {
              console.warn(`[MediaService] Media file referenced in message not found on disk: ${filePath}`);
            }
          }
        }
      }
    }

    return count;
  }
}

export const mediaService = new MediaService();
