import http from 'http';
import https from 'https';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

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
  // 推理请求的转发时刻：SSE 首块（携带 id）可能到 prefill 结束才出现，
  // 归属兜底需要知道"我们刚刚发出过推理请求"（见 ttf_log.js prefillStatus）
  if (req.url.includes('/v1/chat/completions')) noteChatForward();

  const isChatCompletions = req.url.includes('/v1/chat/completions') && req.method === 'POST';

  const sendRequest = (bodyBuffer) => {
    const urlObj = new URL(targetUrl);
    const headers = {
      ...req.headers,
      host: `${urlObj.hostname}:${urlObj.port}`,
    };

    // Remove origin to prevent upstream confusion
    delete headers['origin'];
    delete headers['referer'];

    if (bodyBuffer) {
      headers['content-length'] = Buffer.byteLength(bodyBuffer);
    }

    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
      path: req.url,
      method: req.method,
      headers,
    };

    let completed = false;
    let upstreamRes = null;

    const transport = urlObj.protocol === 'https:' ? https : http;
    const proxyReq = transport.request(options, (proxyRes) => {
      upstreamRes = proxyRes;
      // 记录本代理转发的推理请求 id（SSE 首块的 id 字段）——供 /api/ttf/prefill 做归属判定：
      // TTF 日志是全局的，其他客户端的任务不能显示在本 APP 的阶段指示器里
      const respCt = String(proxyRes.headers['content-type'] || '');
      if (respCt.includes('text/event-stream')) {
        proxyRes.once('data', (chunk) => {
          try {
            const line = String(chunk).split('\n').find((l) => l.startsWith('data:'));
            if (!line) return;
            const j = JSON.parse(line.slice(5).trim());
            if (j && typeof j.id === 'string') noteForwardedRequest(j.id);
          } catch {
            // 非 JSON 行忽略
          }
        });
      }
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
            message: `Failed to connect to model server at ${targetUrl}. Please ensure it is running.`,
            code: 'upstream_unavailable',
          },
        }));
      }
    });

    if (bodyBuffer) {
      proxyReq.end(bodyBuffer);
    } else {
      req.pipe(proxyReq);
    }
  };

  if (isChatCompletions) {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      let buf = Buffer.concat(chunks);
      const str = buf.toString('utf-8');
      if (str.includes('/api/media/')) {
        try {
          const payload = JSON.parse(str);
          const resolved = mediaService.resolveMediaUrlsInPayload(payload);
          if (resolved > 0) {
            buf = Buffer.from(JSON.stringify(payload), 'utf-8');
          }
        } catch (e) {
          console.error('[Proxy] Failed to resolve media URLs in payload:', e);
        }
      }
      sendRequest(buf);
    });
  } else {
    sendRequest(null);
  }
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

import { wikiService } from './wiki_service.js';
import { ttfLogService, noteForwardedRequest, noteChatForward } from './ttf_log.js';
import { ttfService } from './ttf_service.js';
import { asrService } from './asr_service.js';
import { mediaService } from './media_service.js';

// 本进程是否成功抢到端口、从而成为受管服务的管理方。
// 见 server.listen 回调与 server.on('error')：失败的重复实例不得清理别人的服务。
let ownsServices = false;

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

  // ----------------------------- 代理自身的管理端点 -----------------------------

  // 身份探针：App 用它判断「31235 上跑的确实是 SimpleUI 代理」。
  // 不能用 /health —— 它会被转发给基础模型服务（见下方路由），模型未就绪时返回 502，
  // App 会误判成「代理没在跑」而重复拉起一个注定 EADDRINUSE 的 node；更糟的是
  // 那个进程会成为 App 眼里的「代理」，退出时自然也就停不掉真正的代理与三个服务。
  if (req.url === '/api/system/ping') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ app: 'SimpleUI', role: 'proxy', pid: process.pid }));
    return;
  }

  // 远程退出：代理不是本 App 拉起时（例如先在终端跑过 ./start.sh），
  // App 仍要能把它连同三个受管服务一起停掉 —— 满足「退出即全停」。
  // 只接受非浏览器发起的 POST：带 Origin 的一律拒绝，否则任意网页都能
  // POST 到 127.0.0.1 把用户的服务关掉（CSRF）。
  if (req.url === '/api/system/quit') {
    const origin = req.headers['origin'];
    if (req.method !== 'POST' || (origin && origin !== `http://127.0.0.1:${PORT}`)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'forbidden' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    // 先把响应发出去，再走与 SIGTERM 完全相同的退出钩子
    setTimeout(() => cleanupAndExit(0), 30);
    return;
  }

  // Handle Wiki Knowledge Base APIs
  if (req.url.startsWith('/api/wiki/')) {
    wikiService.handleApi(req, res);
    return;
  }

  // TTF 日志只读探针：供前端在生成过程中取真实的 prompt token 数
  if (req.url.startsWith('/api/ttf/')) {
    ttfLogService.handleApi(req, res);
    return;
  }

  // 模型服务管理 API（启停 / 运行参数 / 路径 / 日志）：
  // SimpleUI 作为 TTF 服务的唯一管理方，随 App 自动拉起、退出一并终止。
  if (req.url.startsWith('/api/model/')) {
    ttfService.handleApi(req, res);
    return;
  }

  // 语音识别服务 API（SenseVoice / audio.cpp 托管 + 转写）：
  // 与基础模型服务并列的第三个受管服务，随 App 自动拉起、退出一并终止。
  if (req.url.startsWith('/api/asr/')) {
    asrService.handleApi(req, res);
    return;
  }

  // 本地媒体资源存储 API（上传、按哈希寻址获取、持久化图片库）
  if (req.url.startsWith('/api/media/')) {
    mediaService.handleApi(req, res);
    return;
  }

  // Handle Wiki content proxy (for iframe embedding on the same origin)
  if (req.url.startsWith('/wiki-content/')) {
    const targetPath = req.url.replace('/wiki-content/', '/');
    proxyRequest(req, res, `http://127.0.0.1:${wikiService.port}${targetPath}`);
    return;
  }

  // Kiwix 条目内容同源转发：
  // 让知识库 iframe 以 /content/{id}/{title} 加载（与应用同源），从而允许父页面
  // 向 iframe 注入「抽取正文」，并与条目内的 ./_mw_/... 相对资源路径天然兼容。
  if (req.url.startsWith('/content/')) {
    proxyRequest(req, res, `http://127.0.0.1:${wikiService.port}${req.url}`);
    return;
  }

  // Forward API calls（默认目标跟随当前基础模型服务激活引擎的端口，改端口无需重启代理）
  if (req.url.startsWith('/v1/') || req.url === '/health' || req.url.startsWith('/health?')) {
    const customPort = req.headers['x-target-port'];
    const defaultPort = ttfService?.getActivePort ? ttfService.getActivePort() : (ttfService?.config?.port || 1235);
    const targetUrl = customPort ? `http://127.0.0.1:${customPort}` : `http://127.0.0.1:${defaultPort}`;
    proxyRequest(req, res, targetUrl);
    return;
  }

  // Serve static UI
  serveStatic(req, res);
});

// 说明：LAYA 意图门禁已移除（实测误判率约 1/3，会把知识类提问拦在链路外），
// 1236 端口的 LAYA 服务不再被自动拉起；server/laya_mlx_server.py 保留在原处以备后用。

server.listen(PORT, '127.0.0.1', () => {
  // 只有真正抢到端口的实例才有资格管理/清理受管服务。
  // 否则重复拉起的代理在 EADDRINUSE 退出时，会顺着退出钩子把**正在运行的**
  // 那个实例的服务（共用同一批 PID 文件）一起杀掉。
  ownsServices = true;
  console.log(`🚀 SimpleUI running at http://127.0.0.1:${PORT}`);
  console.log(`🔗 Upstream API configured to ${TARGET_API}`);
  wikiService.initWatcher();
  // 模型服务随 SimpleUI 自动启动（enabled 开关在设置页模型卡片中控制）
  ttfService.init();
  // 语音识别服务随 SimpleUI 自动启动（enabled 开关在设置页语音卡片中控制）
  asrService.init();

  // Automatically exit if parent process (e.g. SimpleUI app) terminates
  if (process.ppid && process.ppid > 1) {
    setInterval(() => {
      try {
        process.kill(process.ppid, 0);
      } catch (e) {
        console.log('[Proxy] Parent process no longer running, exiting.');
        cleanupAndExit(0);
      }
    }, 2500);
  }
});

// 端口被占用说明已有实例在跑：干净退出，且**不触碰**受管服务（ownsServices 仍为 false）
server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error(`[Proxy] 端口 ${PORT} 已被占用，另一个 SimpleUI 代理正在运行；本进程直接退出。`);
  } else {
    console.error('[Proxy] server error:', err && err.message);
  }
  process.exit(1);
});

let exiting = false;

function cleanupAndExit(code = 0) {
  if (exiting) return;
  exiting = true;
  // 没抢到端口的实例不是服务的管理方，绝不能去杀别人的服务
  if (!ownsServices) process.exit(code);
  if (wikiService && wikiService.kiwixProcess) {
    try {
      wikiService.kiwixProcess.kill('SIGTERM');
    } catch (e) {
      // ignore
    }
  }
  // 模型服务随 SimpleUI 退出一并终止（watchdog 作为 SIGKILL 场景的兜底）
  if (ttfService) {
    try {
      ttfService.shutdownSync();
    } catch (e) {
      // ignore
    }
  }
  // 语音识别服务同样随退出一并终止
  if (asrService) {
    try {
      asrService.shutdownSync();
    } catch (e) {
      // ignore
    }
  }
  process.exit(code);
}

process.on('SIGINT', () => cleanupAndExit(0));
process.on('SIGTERM', () => cleanupAndExit(0));
process.on('exit', () => {
  if (!ownsServices) return;
  if (wikiService && wikiService.kiwixProcess) {
    try {
      wikiService.kiwixProcess.kill('SIGKILL');
    } catch (e) {
      // ignore
    }
  }
  if (ttfService) {
    try {
      ttfService.shutdownForce();
    } catch (e) {
      // ignore
    }
  }
  if (asrService) {
    try {
      asrService.shutdownForce();
    } catch (e) {
      // ignore
    }
  }
});
