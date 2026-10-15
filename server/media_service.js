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
    /** @type {(() => Iterable<string>) | null} */
    this.referenceProvider = null;
  }

  /**
   * Registers a callback that returns all media filenames/URLs currently referenced
   * by authoritative server sessions.
   */
  setReferenceProvider(providerFn) {
    this.referenceProvider = typeof providerFn === 'function' ? providerFn : null;
  }

  /**
   * Extracts a clean media filename from a URL (/api/media/<filename>) or filename string.
   */
  extractFilename(item) {
    if (!item || typeof item !== 'string') return '';
    const match = item.match(/\/api\/media\/([a-zA-Z0-9_\-\.]+)/);
    const fname = match ? match[1] : path.basename(item);
    return /^[a-zA-Z0-9_\-\.]+$/.test(fname) ? fname : '';
  }

  /**
   * Checks whether a media file exists on disk.
   */
  hasFile(urlOrFilename) {
    const fname = this.extractFilename(urlOrFilename);
    if (!fname) return false;
    return fs.existsSync(path.join(this.mediaDir, fname));
  }

  /**
   * Builds the authoritative set of all media filenames currently referenced by sessions
   * plus any additional protected URLs/filenames (e.g. draft images in the input box).
   */
  getReferencedFilenames(extraProtected = []) {
    const activeSet = new Set();
    if (this.referenceProvider) {
      try {
        const refs = this.referenceProvider();
        if (refs) {
          for (const item of refs) {
            const fname = this.extractFilename(item);
            if (fname) activeSet.add(fname);
          }
        }
      } catch (err) {
        console.warn('[MediaService] Failed to query referenceProvider:', err);
      }
    }
    if (Array.isArray(extraProtected)) {
      for (const item of extraProtected) {
        const fname = this.extractFilename(item);
        if (fname) activeSet.add(fname);
      }
    }
    return activeSet;
  }

  /**
   * Saves a raw Buffer to the content-addressed media store using 32-char SHA-256 hash.
   */
  saveBuffer(buffer, headerMime = '', originalFilename = '') {
    if (!buffer || buffer.length === 0) {
      throw new Error('Empty file payload received');
    }
    const detected = detectMimeAndExt(buffer, headerMime, originalFilename);
    const mime = detected.mime;
    const ext = detected.ext;
    const hash = crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 32);
    const filename = `${hash}${ext}`;
    const targetPath = path.join(this.mediaDir, filename);

    if (!fs.existsSync(targetPath)) {
      fs.writeFileSync(targetPath, buffer);
      console.log(`[MediaService] Saved new media file: ${filename} (${(buffer.length / 1024).toFixed(1)} KB)`);
    } else {
      console.log(`[MediaService] Deduplicated existing media file: ${filename}`);
    }

    return {
      ok: true,
      url: `/api/media/${filename}`,
      filename,
      size: buffer.length,
      mimeType: mime,
    };
  }

  /**
   * Deletes candidate media files ONLY if they are not referenced by any session
   * or protected draft list.
   */
  deleteUnreferencedFiles(candidateUrlsOrFilenames = [], extraProtected = []) {
    if (!Array.isArray(candidateUrlsOrFilenames) || candidateUrlsOrFilenames.length === 0) {
      return [];
    }
    const protectedSet = this.getReferencedFilenames(extraProtected);
    const candidates = new Set();
    for (const item of candidateUrlsOrFilenames) {
      const fname = this.extractFilename(item);
      if (fname && !protectedSet.has(fname)) {
        candidates.add(fname);
      }
    }

    const deleted = [];
    for (const fname of candidates) {
      const targetPath = path.join(this.mediaDir, fname);
      if (fs.existsSync(targetPath)) {
        try {
          fs.unlinkSync(targetPath);
          deleted.push(fname);
          console.log(`[MediaService] Deleted unreferenced media file: ${fname}`);
        } catch (err) {
          console.error(`[MediaService] Error deleting file ${fname}:`, err);
        }
      }
    }
    return deleted;
  }

  /**
   * Runs garbage collection on disk, always protecting files referenced by server sessions
   * as well as any recently uploaded files within the grace period.
   */
  runGC(extraActiveFilenames = [], gracePeriodSeconds = 300) {
    const activeSet = this.getReferencedFilenames(extraActiveFilenames);
    const graceMs = (typeof gracePeriodSeconds === 'number' ? gracePeriodSeconds : 300) * 1000;
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

    return {
      ok: true,
      deletedCount,
      freedBytes,
      freedMB: (freedBytes / (1024 * 1024)).toFixed(2),
      deletedFiles,
    };
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
        let headerMime = contentType;
        let origName = originalFilename;

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
            headerMime = match[1];
            finalBuffer = Buffer.from(match[2], 'base64');
          } else {
            finalBuffer = Buffer.from(json.data, 'base64');
          }
          origName = json.filename || originalFilename;
        } else {
          finalBuffer = bodyBuffer;
        }

        if (!finalBuffer || finalBuffer.length === 0) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Empty file payload received' }));
          return;
        }

        const responsePayload = this.saveBuffer(finalBuffer, headerMime, origName);

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
   * Deletes one or more media files from disk immediately, ONLY if unreferenced by sessions.
   */
  handleDelete(req, res) {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
        const filenames = Array.isArray(body.filenames) ? body.filenames : [];
        const urls = Array.isArray(body.urls) ? body.urls : (body.url ? [body.url] : []);
        const protectedUrls = Array.isArray(body.protectedUrls) ? body.protectedUrls : [];

        const deleted = this.deleteUnreferencedFiles([...filenames, ...urls], protectedUrls);

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
   * Always merges active session references from the server with any client-provided filenames.
   */
  handleGC(req, res) {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      try {
        const body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString('utf-8')) : {};
        const activeList = Array.isArray(body.activeFilenames) ? body.activeFilenames : [];
        const gracePeriodSeconds =
          typeof body.gracePeriodSeconds === 'number' ? body.gracePeriodSeconds : 300;

        const result = this.runGC(activeList, gracePeriodSeconds);

        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        });
        res.end(JSON.stringify(result));
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
   * If a referenced local file is missing or malformed, safely removes the invalid image_url part
   * so upstream APIs never fail with "Unsupported image_url format".
   */
  resolveMediaUrlsInPayload(payload) {
    if (!payload || !Array.isArray(payload.messages)) return 0;
    let count = 0;

    for (const msg of payload.messages) {
      if (!Array.isArray(msg.content)) continue;

      const validParts = [];
      for (const part of msg.content) {
        if (part && part.type === 'image_url' && part.image_url && typeof part.image_url.url === 'string') {
          const urlStr = part.image_url.url;
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
                validParts.push(part);
                count++;
                console.log(`[MediaService] Injected full-fidelity image ${filename} (${(buffer.length / 1024).toFixed(1)} KB) for upstream model`);
              } catch (readErr) {
                console.error(`[MediaService] Error reading media file ${filename}, skipping part:`, readErr);
              }
            } else {
              console.warn(`[MediaService] Media file missing on disk (${filePath}), stripping broken image_url from wire payload`);
            }
          } else if (
            urlStr.startsWith('data:image/') ||
            urlStr.startsWith('http://') ||
            urlStr.startsWith('https://')
          ) {
            validParts.push(part);
          } else {
            console.warn(`[MediaService] Stripping unsupported image_url format from wire payload: ${urlStr.slice(0, 48)}`);
          }
        } else {
          validParts.push(part);
        }
      }

      if (validParts.length === 0) {
        msg.content = '[图片已丢失]';
      } else if (validParts.length === 1 && validParts[0].type === 'text') {
        msg.content = validParts[0].text || '';
      } else {
        msg.content = validParts;
      }
    }

    return count;
  }
}

export const mediaService = new MediaService();
