import http from 'http';
import https from 'https';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DIST_DIR = path.resolve(__dirname, '../dist');

const PORT = parseInt(process.env.PORT || '31235', 10);
const TARGET_API = process.env.TURBO_API_URL || 'http://127.0.0.1:1235';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.ico': 'image/x-icon',
};

function proxyRequest(req, res, targetUrl) {
  const urlObj = new URL(targetUrl);
  const options = {
    hostname: urlObj.hostname,
    port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
    path: req.url,
    method: req.method,
    headers: {
      ...req.headers,
      host: `${urlObj.hostname}:${urlObj.port}`,
    },
  };

  // Remove origin to prevent upstream confusion
  delete options.headers['origin'];
  delete options.headers['referer'];

  let completed = false;
  let upstreamRes = null;

  const transport = urlObj.protocol === 'https:' ? https : http;
  const proxyReq = transport.request(options, (proxyRes) => {
    upstreamRes = proxyRes;
    // Add CORS headers for good measure
    res.writeHead(proxyRes.statusCode, {
      ...proxyRes.headers,
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-target-port',
    });
    proxyRes.pipe(res);
  });

  const abortUpstream = () => {
    if (!completed) {
      if (!proxyReq.destroyed) proxyReq.destroy();
      if (upstreamRes && !upstreamRes.destroyed) upstreamRes.destroy();
    }
  };

  res.on('finish', () => {
    completed = true;
  });

  res.on('close', () => {
    if (!completed) abortUpstream();
  });

  req.on('aborted', abortUpstream);

  proxyReq.on('error', (err) => {
    if (err.code === 'ECONNRESET' || proxyReq.destroyed) {
      return;
    }
    console.error('[Proxy Error]:', err.message);
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: {
          message: `Failed to connect to TurboFieldfare server at ${TARGET_API}. Please ensure it is running.`,
          code: 'upstream_unavailable',
        },
      }));
    }
  });

  req.pipe(proxyReq);
}

function serveStatic(req, res) {
  let reqPath = req.url.split('?')[0];
  if (reqPath === '/') reqPath = '/index.html';

  let filePath = path.join(DIST_DIR, reqPath);
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(DIST_DIR, 'index.html');
  }

  if (!fs.existsSync(filePath)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found. Please run `npm run build` first.');
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  res.writeHead(200, {
    'Content-Type': contentType,
    'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=31536000',
  });
  fs.createReadStream(filePath).pipe(res);
}

import { wikiService, KIWIX_PORT } from './wiki_service.js';

const server = http.createServer((req, res) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-target-port',
      'Access-Control-Max-Age': '86400',
    });
    res.end();
    return;
  }

  // Handle Wiki Knowledge Base APIs
  if (req.url.startsWith('/api/wiki/')) {
    wikiService.handleApi(req, res);
    return;
  }

  // Handle Wiki content proxy (for iframe embedding on the same origin)
  if (req.url.startsWith('/wiki-content/')) {
    const targetPath = req.url.replace('/wiki-content/', '/');
    proxyRequest(req, res, `http://127.0.0.1:${KIWIX_PORT}${targetPath}`);
    return;
  }

  // Forward API calls
  if (req.url.startsWith('/v1/') || req.url === '/health' || req.url.startsWith('/health?')) {
    const customPort = req.headers['x-target-port'];
    const targetUrl = customPort ? `http://127.0.0.1:${customPort}` : TARGET_API;
    proxyRequest(req, res, targetUrl);
    return;
  }

  // Serve static UI
  serveStatic(req, res);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`🚀 SimpleUI running at http://127.0.0.1:${PORT}`);
  console.log(`🔗 Upstream API configured to ${TARGET_API}`);
  wikiService.initWatcher();
});
