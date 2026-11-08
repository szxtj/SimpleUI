// 3D 场景构建服务托管模块 —— 双模型 / 双运行时
//
// 两个模型对外都叫「3D 场景构建」，但产物不同，因此运行时、端口、请求通路都不同：
//
//   code  : ccore/Qwen3.5-4B-3D-Coder (GGUF Q4_K_M + BF16 mmproj) via 官方 llama.cpp
//           文字（可贴参考图）→ 整页自包含 Three.js HTML，沙箱 iframe 直接渲染。
//   idol  : ddalcu/Idol-MLX-Serve-fp16 via 随包 mlx-serve（MLX / Zig 原生服务器）
//           单张图片 → GLB（高斯泼溅烘成的「贴图圆盘网格」，KHR_materials_unlit），
//           前端用 GLTFLoader 渲染；**不是**代码生成，没有多轮修改。
//
// 二者互斥：同一时刻只有一个运行时在跑（端口 1257 / 1258 各自固定，内存也无法并存），
// 当前用哪个由设置里的 modelKey 决定（scene3d_config.json，默认 code）。
//
// 职责：把「3D 场景构建」作为与基础模型、知识库、ASR、字幕、TTS、OCR 并列的受管服务：
//   - **消息发出才加载、闲置卸载**：beginUse() 阻塞到就绪，endUse() 之后按 idleUnloadMin
//     卸载；关窗 /release 立即终止（与字幕管线「关窗卸全部」语义一致）；
//   - SimpleUI 退出时一并终止（与其它受管服务对齐）；
//   - 模型不随包分发：首次使用时由下载管理器拉取（双源测速 + 断点续传 + 可取消，
//     与 TTS/OCR/字幕同一套实现）。
//
// 运行时：
//   - code：官方 llama.cpp（b12040+），打包在 bin/llama3d/（Resources/llama3d/）。
//     内置自研 fork（bin/llama，b11429）不认识 Qwen3.5 的 `qwen35` GGUF 架构，两套物理隔离。
//   - idol：mlx-serve 发行版（MIT），打包在 bin/mlxserve/（Resources/mlxserve/），
//     含主程序 + lib/（libmlx / libllama / mlx.metallib）。**二进制 minos 26.2**，
//     更老的系统上必须隐藏/禁用该模型（前端按 status.runtime.supported 判断）。
//
// 本服务不参与基础模型三引擎的互斥管理（ttf_service.ALL_ENGINES 不含它），也不占用 1235。

import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import https from 'https';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { startWatchdog } from './watchdog.js';
import { formatBytesSI } from './format_bytes.js';
import { DOWNLOAD_ERROR, downloadError, classifyDownloadError } from './download_errors.js';
import { ModelStaging, sweepStaleStaging } from './download_store.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const HOME = os.homedir();

const USER_DIR = path.join(HOME, 'Library', 'Application Support', 'SimpleUI');
const MODEL_ROOT = path.join(USER_DIR, 'models', 'scene3d');
const MEDIA_DIR = path.join(USER_DIR, 'media');
const OUTPUT_DIR = path.join(USER_DIR, 'scene3d-outputs');
const CONFIG_FILE = path.join(USER_DIR, 'scene3d_config.json');
const LOG_FILE = process.env.SIMPLEUI_SCENE3D_LOG || path.join(HOME, 'Library', 'Logs', 'simpleui-scene3d.log');
const THREE_VENDOR_DIR = path.join(__dirname, 'vendor', 'three');

// 生成参数固定值（官方推荐区间中点；v1 不暴露给用户）
const GEN_PARAMS = {
  temperature: 0.7,
  top_p: 0.95,
  top_k: 20,
  repetition_penalty: 1.0,
};

// Idol 生成参数：本机（Air M4 / 16GB）实测约 19s/denoise step，取 16 步 + 64k splats
// ≈ 5 分钟、GLB 约 7MB，与窗口里「5–30 分钟」的既有预期一致。
const GEN_IMAGE = {
  steps: Number(process.env.SIMPLEUI_SCENE3D_STEPS || 16),
  gaussians: Number(process.env.SIMPLEUI_SCENE3D_GAUSSIANS || 65536),
};

const IDOL_TIMEOUT_MS = 45 * 60_000; // 单次出图上限（慢机器也要留足）
const IDLE_DEFAULT_MIN = 3;

// ---- 模型清单（与 TTS/字幕/OCR 同一套 minBytes 完整性校验）----

const MODEL_DEFS = {
  code: {
    key: 'code',
    kind: 'code',
    name: 'Qwen3.5-4B-3D-Coder (GGUF Q4_K_M)',
    shortName: 'Qwen3.5-4B-3D-Coder',
    tag: 'llama.cpp · GGUF Q4_K_M',
    runtime: 'llama3d',
    port: 1257,
    pidFile: '/tmp/simpleui_scene3d.pid',
    // 兼容既有下载：这个模型的权重就平铺在 models/scene3d/ 根下
    dir: MODEL_ROOT,
    repo: 'ccore/Qwen3.5-4B-3D-Coder',
    stagingKey: 'scene3d',
    modelId: 'Qwen3.5-4B-3D-Coder',
    files: [
      { path: 'Qwen3.5-4B-3D-Coder-Q4_K_M.gguf', expectedBytes: 2708804096, minBytes: 2700000000, required: true },
      { path: 'mmproj-Qwen3.5-4B-BF16.gguf', expectedBytes: 675568768, minBytes: 670000000, required: true },
    ],
  },
  idol: {
    key: 'idol',
    kind: 'image',
    name: 'Idol (MLX fp16)',
    shortName: 'Idol',
    tag: 'mlx-serve · MLX fp16',
    runtime: 'mlxserve',
    port: 1258,
    pidFile: '/tmp/simpleui_scene3d_idol.pid',
    // mlx-serve 按「子目录 = 一个模型」发现，所以模型放在 idol/<modelId>/ 下
    dir: path.join(MODEL_ROOT, 'idol'),
    repo: 'ddalcu/Idol-MLX-Serve-fp16',
    stagingKey: 'scene3d_idol',
    modelId: 'Idol-MLX-Serve-fp16',
    files: [
      { path: 'Idol-MLX-Serve-fp16/config.json', expectedBytes: 1359, minBytes: 800, required: true },
      { path: 'Idol-MLX-Serve-fp16/denoiser.safetensors', expectedBytes: 777098387, minBytes: 769000000, required: true },
      { path: 'Idol-MLX-Serve-fp16/decoder.safetensors', expectedBytes: 118949711, minBytes: 118000000, required: true },
      { path: 'Idol-MLX-Serve-fp16/decoder_gs.safetensors', expectedBytes: 477846416, minBytes: 473000000, required: true },
      { path: 'Idol-MLX-Serve-fp16/birefnet.safetensors', expectedBytes: 444466856, minBytes: 440000000, required: true },
      { path: 'Idol-MLX-Serve-fp16/dinov3/config.json', expectedBytes: 744, minBytes: 400, required: true },
      { path: 'Idol-MLX-Serve-fp16/dinov3/model.safetensors', expectedBytes: 1682729248, minBytes: 1665000000, required: true },
      { path: 'Idol-MLX-Serve-fp16/vae/config.json', expectedBytes: 821, minBytes: 400, required: true },
      { path: 'Idol-MLX-Serve-fp16/vae/model.safetensors', expectedBytes: 67882866, minBytes: 67000000, required: true },
      // 许可证随权重走（Apache-2.0 + Meta DINOv3 License），不是加载必需，但必须一起落地
      { path: 'Idol-MLX-Serve-fp16/LICENSE', expectedBytes: 11358, minBytes: 1000, required: false },
      { path: 'Idol-MLX-Serve-fp16/NOTICE', expectedBytes: 657, minBytes: 200, required: false },
      { path: 'Idol-MLX-Serve-fp16/dinov3/LICENSE.md', expectedBytes: 7503, minBytes: 1000, required: false },
    ],
  },
};

for (const def of Object.values(MODEL_DEFS)) {
  def.totalBytes = def.files.reduce((a, f) => a + f.expectedBytes, 0);
}

const MODEL_KEYS = Object.keys(MODEL_DEFS);

// 官方源与国内高速镜像源定义（与字幕/TTS 服务保持同一套双源策略）
const DOWNLOAD_SOURCES = [
  {
    id: 'mirror',
    name: '国内高速镜像源 (hf-mirror.com)',
    baseUrl: 'https://hf-mirror.com',
  },
  {
    id: 'official',
    name: 'HuggingFace 官方源 (huggingface.co)',
    baseUrl: 'https://huggingface.co',
  },
];

// 可经 /api/scene3d/vendor/* 取用的内置模块（沙箱 iframe 的 module script 会来拉）
const VENDOR_FILES = {
  'three.module.min.js': 'three.module.min.js',
  'GLTFLoader.js': 'GLTFLoader.js',
  'BufferGeometryUtils.js': 'BufferGeometryUtils.js',
};

/** 读本机 macOS 版本（sw_vers 一次，进程内缓存）；失败返回 null */
function readHostMacOS() {
  try {
    const r = spawnSync('sw_vers', ['-productVersion'], { encoding: 'utf-8', timeout: 3000 });
    const v = (r.stdout || '').trim();
    return /^\d+(\.\d+)*$/.test(v) ? v : null;
  } catch {
    return null;
  }
}

/** 版本号逐段比较：versionAtLeast('27.0.1','26.2') === true */
function versionAtLeast(version, min) {
  if (!version) return null; // 读不到就别拦，交给运行时自己报错
  const a = version.split('.').map((n) => parseInt(n, 10) || 0);
  const b = min.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] || 0;
    const y = b[i] || 0;
    if (x !== y) return x > y;
  }
  return true;
}

/**
 * 文件在 HuggingFace 仓库里的相对路径。
 *
 * 本地路径可能多一层 `<modelId>/`（mlx-serve 按「子目录 = 一个模型」发现权重），
 * 但仓库根目录就是模型目录**里面**的内容 —— 把前缀拼进 URL 会 404。
 * 这条踩过：idol 两个源都 200 不到 → ALL_SOURCES_UNREACHABLE。
 */
function remotePathOf(def, file) {
  if (file.remote) return file.remote;
  const prefix = `${def.modelId}/`;
  return file.path.startsWith(prefix) ? file.path.slice(prefix.length) : file.path;
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readPid(pidFile) {
  try {
    const raw = fs.readFileSync(pidFile, 'utf-8').trim();
    const pid = parseInt(raw, 10);
    return Number.isInteger(pid) ? pid : null;
  } catch {
    return null;
  }
}

function writePid(pidFile, pid) {
  try {
    fs.writeFileSync(pidFile, String(pid));
  } catch {}
}

function clearPid(pidFile) {
  try {
    if (fs.existsSync(pidFile)) fs.unlinkSync(pidFile);
  } catch {}
}

class Scene3dService {
  constructor() {
    // 生成用计数 + 闲置卸载：消息发出 → beginUse（拉起并阻塞到模型就绪）；
    // 输出结束（成功/失败/中止）→ endUse → 闲置 N 分钟杀进程
    this.useCount = 0;
    this.idleTimer = null;
    this.proc = null;
    this.runningKey = null; // 当前进程属于哪个模型（stop 时按它找 PID 文件）
    this.starting = null;
    this.watchdog = null;
    this.downloadAbortController = null;
    this.config = this.loadConfig();
    this.downloadingKey = null;
    this.download = this.freshDownloadState();
    // mlx-serve 发行版二进制 minos = 26.2；本机版本只用于「这个模型能不能用」的提示，
    // 读不到时按支持处理（不拦，让运行时自己报错）
    this.hostMacOS = readHostMacOS();
    this.mlxSupported = versionAtLeast(this.hostMacOS, '26.2') !== false;
    this.mlxMinMacOS = '26.2';
  }

  freshDownloadState() {
    return {
      active: false,
      errorCode: null,
      phase: 'idle',
      targetModel: null,
      currentModelKey: null,
      currentModelName: '',
      currentFile: '',
      selectedSource: null,
      downloadedBytes: 0,
      totalBytes: MODEL_DEFS[this.selectedKey()]?.totalBytes || 0,
      progressPercent: 0,
      speedBps: 0,
      etaSeconds: null,
      error: null,
      updatedAt: 0,
    };
  }

  // ----------------------------- 配置 -----------------------------

  loadConfig() {
    const fallback = { modelKey: 'code', idleUnloadMin: IDLE_DEFAULT_MIN };
    try {
      const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
      const modelKey = MODEL_KEYS.includes(raw?.modelKey) ? raw.modelKey : fallback.modelKey;
      let idleUnloadMin = Number(raw?.idleUnloadMin);
      if (!Number.isFinite(idleUnloadMin) || idleUnloadMin < 0) idleUnloadMin = fallback.idleUnloadMin;
      idleUnloadMin = Math.min(idleUnloadMin, 120);
      return { modelKey, idleUnloadMin };
    } catch {
      return fallback;
    }
  }

  saveConfig() {
    try {
      fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(this.config, null, 2));
      return true;
    } catch (err) {
      console.warn('[Scene3D] 写配置失败:', err.message);
      return false;
    }
  }

  selectedKey() {
    return MODEL_DEFS[this.config.modelKey] ? this.config.modelKey : 'code';
  }

  selectedModel() {
    return MODEL_DEFS[this.selectedKey()];
  }

  /** 设置页切换模型：写盘 + 若进程在跑就换掉（两个运行时无法共存） */
  async setConfig(patch = {}) {
    const prevKey = this.config.modelKey;
    let changedModel = false;
    if (patch.modelKey && MODEL_DEFS[patch.modelKey] && patch.modelKey !== this.config.modelKey) {
      // 正在生成时不允许切模型：切模型意味着必须杀掉当前运行时，会把在途回合打断成 EXITED。
      // 宁可拒绝并让设置页提示「完成后再切换」，也不静默毁掉用户正在等的产出。
      if (this.useCount > 0 || this.starting) {
        return { ...this.config, rejected: 'BUSY' };
      }
      this.config.modelKey = patch.modelKey;
      changedModel = true;
    }
    if (patch.idleUnloadMin !== undefined) {
      const n = Number(patch.idleUnloadMin);
      if (Number.isFinite(n) && n >= 0) this.config.idleUnloadMin = Math.min(n, 120);
    }
    this.saveConfig();

    if (changedModel) {
      if (this.download.active) this.cancelDownload();
      // 互斥：切完模型这个 key 就成了「另一个」，必须等它真的退出再返回，
      // 否则下一次发送会在旧进程还占着内存时把新模型拉起来（16GB 上直接 OOM）。
      const killed = await this.evictOtherRuntimes(this.config.modelKey);
      console.log(
        `[Scene3D] 切换模型 ${prevKey} → ${this.config.modelKey}` +
          (killed.length ? `，已终止 ${killed.join(',')}` : '，无需终止其它运行时')
      );
    }
    return this.config;
  }

  // ----------------------------- 模型下载 -----------------------------

  downloadStatus() {
    return { ...this.download };
  }

  /**
   * 发起支持自动重定向（301/302/307/308）的 HTTP/HTTPS 请求。
   * 与字幕/TTS 服务同一实现，供测速与断点续传下载共用。
   */
  httpRequestWithRedirects(urlStr, options = {}, maxRedirects = 5) {
    return new Promise((resolve, reject) => {
      const follow = (currentUrl, redirectsLeft) => {
        let parsedUrl;
        try {
          parsedUrl = new URL(currentUrl);
        } catch (err) {
          reject(err);
          return;
        }

        const client = parsedUrl.protocol === 'https:' ? https : http;
        const reqOpts = {
          hostname: parsedUrl.hostname,
          port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
          path: parsedUrl.pathname + parsedUrl.search,
          method: options.method || 'GET',
          headers: {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) SimpleUI/1.0',
            ...(options.headers || {}),
          },
        };

        const req = client.request(reqOpts, (res) => {
          if (
            res.statusCode >= 300 &&
            res.statusCode < 400 &&
            res.headers.location &&
            redirectsLeft > 0
          ) {
            res.resume();
            const nextUrl = new URL(res.headers.location, currentUrl).toString();
            follow(nextUrl, redirectsLeft - 1);
            return;
          }
          resolve({ req, res, finalUrl: currentUrl });
        });

        if (options.signal) {
          if (options.signal.aborted) {
            req.destroy(new Error('Download cancelled'));
            return;
          }
          options.signal.addEventListener(
            'abort',
            () => {
              req.destroy(new Error('Download cancelled'));
            },
            { once: true }
          );
        }

        req.on('timeout', () => {
          req.destroy(new Error('Request timeout'));
        });
        req.on('error', (err) => {
          reject(err);
        });
        req.end();
      };

      follow(urlStr, maxRedirects);
    });
  }

  /**
   * 并发对官方源 (huggingface.co) 与国内镜像源 (hf-mirror.com) 进行真实数据块拉取测速，
   * 选出延迟最低、吞吐最快的源作为主下载源，另一源作为故障自动切换备份。
   */
  async probeBestMirror(signal, probeRelative) {
    const probeSingleSource = async (source) => {
      const testUrl = `${source.baseUrl}/${probeRelative}`;
      const startTime = Date.now();
      try {
        const { res } = await this.httpRequestWithRedirects(
          testUrl,
          {
            method: 'GET',
            headers: { Range: 'bytes=0-32767' },
            timeout: 4000,
            signal,
          },
          4
        );

        if (res.statusCode !== 200 && res.statusCode !== 206) {
          res.resume();
          return { ...source, ok: false, latencyMs: Infinity, speedKbps: 0 };
        }

        let bytes = 0;
        await new Promise((resolve) => {
          const onEnd = () => resolve();
          res.on('data', (c) => (bytes += c.length));
          res.on('end', onEnd);
          res.on('error', onEnd);
          res.on('aborted', onEnd);
        });
        const elapsedMs = Date.now() - startTime;
        const speedKbps = elapsedMs > 0 ? Math.round((bytes / 1024 / elapsedMs) * 1000) : 0;
        return { ...source, ok: true, latencyMs: elapsedMs, speedKbps };
      } catch {
        return { ...source, ok: false, latencyMs: Infinity, speedKbps: 0 };
      }
    };

    const results = await Promise.all(DOWNLOAD_SOURCES.map((s) => probeSingleSource(s)));
    const okResults = results.filter((r) => r.ok);
    if (okResults.length === 0) return null;
    okResults.sort((a, b) => {
      const scoreA = a.latencyMs / Math.max(1, a.speedKbps);
      const scoreB = b.latencyMs / Math.max(1, b.speedKbps);
      return scoreA - scoreB;
    });
    return okResults[0];
  }

  cleanTempFiles({ removePartFiles = false } = {}) {
    if (!fs.existsSync(MODEL_ROOT)) return { removed: [] };
    const removed = [];
    const walk = (dir) => {
      try {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            walk(full);
          } else if (
            (removePartFiles && entry.name.endsWith('.part')) ||
            entry.name.endsWith('.tmp') ||
            entry.name.endsWith('.download')
          ) {
            fs.rmSync(full, { force: true });
            removed.push(path.relative(MODEL_ROOT, full));
          }
        }
      } catch {}
    };
    walk(MODEL_ROOT);
    if (removed.length > 0) {
      console.log(`[Scene3D] 🧹 已自动清理下载临时文件: ${removed.join(', ')}`);
    }
    return { removed };
  }

  /** 一键测速并下载缺失模型（双源自动选优 + 断点续传 + 可取消）。 */
  async startDownload(modelKey = this.selectedKey()) {
    const def = MODEL_DEFS[modelKey] || this.selectedModel();
    if (this.download.active) return this.downloadStatus();
    if (this.modelStatus(def).ready) return this.downloadStatus();

    this.downloadAbortController = new AbortController();
    const signal = this.downloadAbortController.signal;
    this.downloadingKey = def.key;

    this.download = {
      ...this.freshDownloadState(),
      active: true,
      phase: 'probing',
      targetModel: def.key,
      currentModelKey: def.key,
      currentModelName: def.name,
      totalBytes: def.totalBytes,
      updatedAt: Date.now(),
    };

    let staging = null;
    const commitEntries = [];
    try {
      fs.mkdirSync(def.dir, { recursive: true });
      sweepStaleStaging(def.dir);
      staging = new ModelStaging(def.dir, def.stagingKey).begin();
      const probeFile = def.files.reduce((a, b) =>
        (Number(b.expectedBytes) || 0) > (Number(a.expectedBytes) || 0) ? b : a
      );
      const probeRelative = `${def.repo}/resolve/main/${remotePathOf(def, probeFile)}`;

      const best = await this.probeBestMirror(signal, probeRelative);
      if (signal.aborted) throw new Error('cancelled');
      if (!best) throw downloadError(DOWNLOAD_ERROR.ALL_SOURCES_UNREACHABLE, 'ALL_SOURCES_UNREACHABLE');
      this.download.selectedSource = {
        id: best.id,
        name: best.name,
        latencyMs: best.latencyMs,
        speedKbps: best.speedKbps,
      };

      const backupSources = DOWNLOAD_SOURCES.filter((s) => s.id !== best.id);
      const candidateSources = [best, ...backupSources];

      this.download.phase = 'downloading';

      for (const file of def.files) {
        if (signal.aborted) throw new Error('cancelled');
        const finalPath = path.join(def.dir, file.path);
        if (fs.existsSync(finalPath) && fs.statSync(finalPath).size >= file.minBytes) continue;
        const dst = staging.pathFor(file.path);

        let fileDone = false;
        let lastErr = null;

        for (const srcNode of candidateSources) {
          if (signal.aborted) throw new Error('cancelled');
          const url = `${srcNode.baseUrl}/${def.repo}/resolve/main/${remotePathOf(def, file)}`;
          const existingBytes = staging.sizeOf(file.path);

          try {
            await new Promise((resolve, reject) => {
              const headers = existingBytes > 0 ? { Range: `bytes=${existingBytes}-` } : {};
              this.httpRequestWithRedirects(
                url,
                { method: 'GET', headers, timeout: 30000, signal },
                5
              )
                .then(({ res }) => {
                  if (res.statusCode !== 200 && res.statusCode !== 206) {
                    res.resume();
                    reject(downloadError(DOWNLOAD_ERROR.DOWNLOAD_FAILED, `HTTP ${res.statusCode}`));
                    return;
                  }
                  const isResume = res.statusCode === 206 && existingBytes > 0;
                  const baseOffset = isResume ? existingBytes : 0;
                  const contentLen = Number(res.headers['content-length'] || 0);
                  const total =
                    contentLen > 0 ? baseOffset + contentLen : Number(file.expectedBytes || 0);
                  this.download.totalBytes = total;
                  this.download.downloadedBytes = baseOffset;
                  this.download.currentFile = file.path;
                  this.download.updatedAt = Date.now();

                  const fileStream = fs.createWriteStream(dst, {
                    flags: isResume ? 'a' : 'w',
                  });
                  fileStream.on('error', (err) => {
                    res.destroy();
                    reject(err);
                  });
                  let downloaded = baseOffset;
                  let lastTick = Date.now();
                  let lastBytes = baseOffset;

                  res.on('data', (chunk) => {
                    downloaded += chunk.length;
                    if (!fileStream.write(chunk)) {
                      res.pause();
                      fileStream.once('drain', () => res.resume());
                    }
                    const now = Date.now();
                    if (now - lastTick >= 400) {
                      const dt = (now - lastTick) / 1000;
                      this.download.speedBps = Math.round((downloaded - lastBytes) / dt);
                      lastTick = now;
                      lastBytes = downloaded;
                      this.download.downloadedBytes = downloaded;
                      this.download.progressPercent = total
                        ? Math.min(99, Math.round((downloaded / total) * 100))
                        : 0;
                      this.download.etaSeconds =
                        this.download.speedBps > 0 && total > downloaded
                          ? Math.round((total - downloaded) / this.download.speedBps)
                          : null;
                      this.download.updatedAt = now;
                    }
                  });
                  res.on('error', (err) => {
                    fileStream.destroy();
                    reject(err);
                  });
                  res.on('aborted', () => {
                    fileStream.destroy();
                    reject(downloadError(DOWNLOAD_ERROR.DOWNLOAD_FAILED, 'Download aborted'));
                  });
                  res.on('end', () => {
                    fileStream.end();
                    fileStream.on('finish', () => {
                      try {
                        const finalSize = fs.statSync(dst).size;
                        if (finalSize < file.minBytes) {
                          reject(downloadError(DOWNLOAD_ERROR.FILE_SIZE_MISMATCH, `FILE_SIZE_MISMATCH (${finalSize} < ${file.minBytes})`));
                          return;
                        }
                        resolve();
                      } catch (e) {
                        reject(e);
                      }
                    });
                    fileStream.on('error', (err) => {
                      reject(err);
                    });
                  });
                })
                .catch(reject);
            });
            fileDone = true;
            commitEntries.push({ relPath: file.path, minBytes: file.minBytes });
            break;
          } catch (err) {
            lastErr = err;
            if (
              signal.aborted ||
              err.message === 'cancelled' ||
              err.message === 'Download cancelled'
            ) {
              throw new Error('cancelled');
            }
            console.warn(`[Scene3D] Source ${srcNode.name} interrupted, trying backup:`, err.message);
          }
        }

        if (!fileDone) {
          throw lastErr || new Error(`DOWNLOAD_FAILED: ${file.path}`);
        }
      }

      this.download.phase = 'cleaning';
      staging.commit(commitEntries, { markKeys: [def.key] });
      staging = null;
      this.cleanTempFiles({ removePartFiles: true });
      this.download.phase = 'completed';
      this.download.active = false;
      this.download.progressPercent = 100;
      this.download.updatedAt = Date.now();
    } catch (err) {
      const cancelled =
        signal.aborted || err.message === 'cancelled' || err.message === 'Download cancelled';
      if (staging) {
        try { cancelled ? staging.discard() : staging.releaseSlot(); } catch {}
        staging = null;
      }
      this.download.phase = cancelled ? 'cancelled' : 'error';
      this.download.error = cancelled ? null : err.message || 'unknown';
      this.download.errorCode = cancelled ? null : classifyDownloadError(err);
      this.download.active = false;
      this.download.updatedAt = Date.now();
      if (!cancelled) console.warn('[Scene3D] 模型下载失败:', err.message);
    } finally {
      this.downloadAbortController = null;
      this.downloadingKey = null;
    }

    return this.downloadStatus();
  }

  cancelDownload() {
    if (this.downloadAbortController) {
      this.downloadAbortController.abort();
      this.downloadAbortController = null;
    }
    this.download.phase = 'cancelled';
    this.download.active = false;
    this.download.updatedAt = Date.now();
    return this.downloadStatus();
  }

  // ----------------------------- 运行时探测 -----------------------------

  /**
   * 解析官方 llama.cpp 运行时（llama-server b12040+，含同目录平铺 dylib）。
   * 打包态在 Contents/Resources/llama3d/，开发态在项目 bin/llama3d/。
   *
   * 只返回**绝对路径**：spawn 的可执行文件若是相对路径，会按 cwd 选项（本服务是
   * 'llama3d'）而不是 Node 进程 cwd 解析，实测报 ENOENT——打包态曾因此静默起不来。
   */
  resolveLlamaServer() {
    const candidates = [
      process.env.SIMPLEUI_SCENE3D_LLAMA_SERVER,
      // 打包态：Resources/server 的上一级就是 Resources（纯 Node 没有 process.resourcesPath）
      path.resolve(__dirname, '..', 'llama3d', 'llama-server'),
      // 开发态：server/ 的上一级是项目根
      path.resolve(__dirname, '..', 'bin', 'llama3d', 'llama-server'),
    ].filter(Boolean);
    for (const c of candidates) {
      try {
        if (fs.existsSync(c)) return c;
      } catch {}
    }
    return null;
  }

  /** 解析 mlx-serve 运行时（MIT，Zig 原生二进制 + lib/ 内的 dylib 与 metallib） */
  resolveMlxServe() {
    const candidates = [
      process.env.SIMPLEUI_SCENE3D_MLXSERVE,
      path.resolve(__dirname, '..', 'mlxserve', 'mlx-serve'),
      path.resolve(__dirname, '..', 'bin', 'mlxserve', 'mlx-serve'),
    ].filter(Boolean);
    for (const c of candidates) {
      try {
        if (fs.existsSync(c)) return c;
      } catch {}
    }
    return null;
  }

  /** 内置运行环境是否就绪（按当前选中的模型判定） */
  runtimeStatus(def = this.selectedModel()) {
    if (def.runtime === 'mlxserve') {
      const bin = this.resolveMlxServe();
      return {
        id: 'mlxserve',
        label: 'mlx-serve · MLX',
        ready: Boolean(bin),
        path: bin,
        bundled: Boolean(bin),
        // mlx-serve 发行版二进制 minos 26.2：更老的 macOS 上装不了
        minMacOS: this.mlxMinMacOS,
        hostMacOS: this.hostMacOS,
        supported: this.mlxSupported,
      };
    }
    const bin = this.resolveLlamaServer();
    return {
      id: 'llama3d',
      label: 'llama.cpp · llama-server',
      ready: Boolean(bin),
      path: bin,
      bundled: Boolean(bin),
      minMacOS: '15.0',
      hostMacOS: this.hostMacOS,
      supported: true,
    };
  }

  modelStatus(def = this.selectedModel()) {
    const files = def.files.map((f) => {
      const full = path.join(def.dir, f.path);
      let size = 0;
      let exists = false;
      try {
        const st = fs.statSync(full);
        exists = st.isFile();
        size = exists ? st.size : 0;
      } catch {
        exists = false;
      }
      return {
        path: f.path,
        exists,
        size,
        minBytes: f.minBytes,
        expectedBytes: f.expectedBytes,
        required: Boolean(f.required),
        ready: exists && size >= f.minBytes,
      };
    });

    const required = files.filter((f) => f.required);
    const missing = required.filter((f) => !f.ready).map((f) => f.path);
    const bytes = files.reduce((a, f) => a + (f.exists ? f.size : 0), 0);

    return {
      key: def.key,
      kind: def.kind,
      name: def.name,
      shortName: def.shortName,
      tag: def.tag,
      dir: def.dir,
      ready: missing.length === 0,
      missing,
      bytes,
      expectedBytes: def.totalBytes,
      // 模型体积用十进制（3.57 GB），与 HuggingFace 页面 / 访达一致；
      // 1024 进制会显示成 3.32，用户拿外部数字一对就"对不上"
      sizeDesc: formatBytesSI(def.totalBytes),
      path: path.join(def.dir, def.files[0]?.path || ''),
      port: def.port,
      runtime: def.runtime,
    };
  }

  /** 设置页/窗口要的「有哪些模型可选」 */
  modelEntries() {
    return MODEL_KEYS.map((key) => {
      const def = MODEL_DEFS[key];
      const st = this.modelStatus(def);
      return {
        key: def.key,
        kind: def.kind,
        name: def.name,
        shortName: def.shortName,
        tag: def.tag,
        port: def.port,
        runtime: def.runtime,
        ready: st.ready,
        bytes: st.bytes,
        expectedBytes: st.expectedBytes,
        sizeDesc: st.sizeDesc,
        missing: st.missing.length,
        // 顶部那条 macOS 提示只在系统真不支持时出现（idol 走 mlx-serve，minOS 26.2）
        supported: def.runtime === 'mlxserve' ? this.mlxSupported : true,
        minMacOS: def.runtime === 'mlxserve' ? this.mlxMinMacOS : null,
        downloading: this.download.active && this.downloadingKey === def.key,
      };
    });
  }

  /** 某个模型的运行时进程 PID（内存里跟踪的优先，其次 pid 文件） */
  pidOf(key) {
    const def = MODEL_DEFS[key];
    if (!def) return null;
    if (this.runningKey === key && isPidAlive(this.proc?.pid)) return this.proc.pid;
    return readPid(def.pidFile);
  }

  /** 某个模型的运行时是否还活着（不看是否「当前选中」，只看进程） */
  runtimeAlive(key) {
    return isPidAlive(this.pidOf(key));
  }

  /** 当前选中模型的运行时是否在跑（status 用） */
  isRunning() {
    if (!this.runningKey) return false;
    return this.runtimeAlive(this.runningKey);
  }

  /**
   * 互斥核心：把「除 keepKey 以外」的运行时全部干掉，并**等它们真的退出**。
   *
   * 为什么必须等：两个模型的内存占用是 3.15GB（llama.cpp）与 4.27GB（Idol），
   * 在 16GB 机器上同时驻留必然 OOM。stop() 里那个 1.5s 后的 SIGKILL 兜底是异步的，
   * 如果只发信号不等待，紧接着的 spawn 就会和还没退干净的旧进程抢内存。
   *
   * @returns {Promise<string[]>} 实际被终止的模型 key
   */
  async evictOtherRuntimes(keepKey, { waitMs = 3000 } = {}) {
    const killed = [];
    for (const key of MODEL_KEYS) {
      if (key === keepKey) continue;
      const def = MODEL_DEFS[key];
      const pid = this.pidOf(key);
      if (!isPidAlive(pid)) {
        clearPid(def.pidFile);
        continue;
      }
      killed.push(key);
      console.log(`[Scene3D] 互斥：终止 ${key} 的运行时 (pid ${pid})`);
      try {
        process.kill(pid, 'SIGTERM');
      } catch {}
      const deadline = Date.now() + waitMs;
      while (Date.now() < deadline && isPidAlive(pid)) {
        await new Promise((r) => setTimeout(r, 100));
      }
      if (isPidAlive(pid)) {
        console.warn(`[Scene3D] 互斥：${key} 未响应 SIGTERM，改用 SIGKILL`);
        try {
          process.kill(pid, 'SIGKILL');
        } catch {}
        const hardDeadline = Date.now() + 1500;
        while (Date.now() < hardDeadline && isPidAlive(pid)) {
          await new Promise((r) => setTimeout(r, 50));
        }
      }
      clearPid(def.pidFile);
      if (this.runningKey === key) {
        this.runningKey = null;
        this.proc = null;
      }
    }
    return killed;
  }

  // ----------------------------- 生命周期 -----------------------------

  /**
   * 兜底守护：与 ttf / asr / tts / ocr 同一套实现（server/watchdog.js）。
   * 看门狗只按 PID 精确动手（无 pkill），与字幕翻译、3D 另一个运行时的
   * llama-server（同名不同路径）都不会互相误伤。
   */
  ensureWatchdog(def) {
    if (this.watchdog) return;
    try {
      this.watchdog = startWatchdog({
        pidFile: def.pidFile,
        binaryBasename: def.runtime === 'mlxserve' ? 'mlx-serve' : 'llama-server',
      });
    } catch {
      // watchdog 失败不阻断启动
    }
  }

  /** 极简 HTTP JSON POST（只给 mlx-serve 的 /v1/load-model 用） */
  httpJsonPost(port, pathname, body, timeoutMs = 20000) {
    return new Promise((resolve) => {
      const payload = Buffer.from(JSON.stringify(body));
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path: pathname,
          method: 'POST',
          timeout: timeoutMs,
          headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length },
        },
        (res) => {
          let raw = '';
          res.on('data', (c) => (raw += c));
          res.on('end', () => {
            let json = null;
            try {
              json = JSON.parse(raw);
            } catch {}
            resolve({ status: res.statusCode, json, raw });
          });
        }
      );
      req.on('error', (err) => resolve({ status: 0, json: null, raw: err.message }));
      req.on('timeout', () => {
        req.destroy(new Error('timeout'));
      });
      req.write(payload);
      req.end();
    });
  }

  healthOk(port, timeoutMs = 2000) {
    return new Promise((resolve) => {
      http
        .get({ host: '127.0.0.1', port, path: '/health', timeout: timeoutMs }, (res) => {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => {
            try {
              resolve(JSON.parse(body).status === 'ok');
            } catch {
              resolve(false);
            }
          });
        })
        .on('error', () => resolve(false));
    });
  }

  /**
   * 启动当前选中模型的运行时。
   *
   * 并发契约：`this.starting` 必须**同步**赋值。互斥驱逐里有 await，如果把赋值放在
   * 驱逐之后，两次并发的 start（例如连发两条消息）会双双通过检查 → 同一端口被 spawn
   * 两次。所以这里只做检查 + 赋一个 promise，真正的活儿交给 startRun()。
   */
  start() {
    if (this.starting) return this.starting;
    if (this.isRunning()) return Promise.resolve({ ok: true, alreadyRunning: true });
    // 同步占位；无论成功/失败/提前返回，都在 finally 里清掉（只清自己那一个，
    // 避免把后一次 start 的占位抹掉）
    const p = this.startRun().finally(() => {
      if (this.starting === p) this.starting = null;
    });
    this.starting = p;
    return p;
  }

  async startRun() {
    const def = this.selectedModel();
    const model = this.modelStatus(def);
    if (!model.ready) {
      return { ok: false, error: 'MODEL_MISSING', missing: model.missing, dir: model.dir };
    }
    const runtime = this.runtimeStatus(def);
    if (!runtime.ready) {
      return { ok: false, error: 'RUNTIME_MISSING', runtime: def.runtime };
    }

    // **互斥硬保证**：真正 spawn 之前先把另一个模型的运行时清干净并等它退出。
    // 不能只在切模型时做 —— 上次会话残留、崩溃重开、pid 文件被手工删掉等情况下，
    // 这里才是唯一能拦住「两个模型同时驻留」的地方。
    const evicted = await this.evictOtherRuntimes(def.key);
    if (evicted.length) {
      console.log(`[Scene3D] 启动 ${def.key} 前已腾空：${evicted.join(', ')}`);
    }

    const bin = runtime.path;
    const port = def.port;
    const startedAt = Date.now();

    const result = await new Promise((resolve) => {
      let settled = false;
      const finish = (r) => {
        if (settled) return;
        settled = true;
        resolve(r);
      };

      let logStream = null;
      try {
        if (!fs.existsSync(path.dirname(LOG_FILE))) fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
        logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
        logStream.write(`\n[Scene3D] === ${def.key} via ${def.runtime} @ ${new Date().toISOString()} ===\n`);
      } catch {}

      let args;
      if (def.runtime === 'mlxserve') {
        // mlx-serve：按「子目录 = 一个模型」扫描，具体模型由下面的 /v1/load-model 显式加载。
        // 不加 --skip-mem-preflight：内存不够时宁可明确报错，也不要静默 swap 拖死整机。
        args = [
          '--serve',
          '--model-dir', def.dir,
          '--host', '127.0.0.1',
          '--port', String(port),
          '--log-level', 'info',
        ];
      } else {
        const weights = path.join(def.dir, def.files[0].path);
        const mmproj = path.join(def.dir, def.files[1].path);
        args = [
          '-m', weights,
          '--mmproj', mmproj,
          '--host', '127.0.0.1',
          '--port', String(port),
          '-ngl', '99',
          '--flash-attn', 'on',
          '--ctx-size', '131072',
          '--jinja',
        ];
      }

      const child = spawn(bin, args, {
        cwd: path.dirname(bin),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      this.proc = child;
      this.runningKey = def.key;
      if (child.pid) writePid(def.pidFile, child.pid);
      this.watchdog = null;
      this.ensureWatchdog(def);

      const onData = (buf) => {
        try {
          logStream?.write(buf);
        } catch {}
      };
      child.stdout?.on('data', onData);
      child.stderr?.on('data', onData);

      child.on('exit', (code, sig) => {
        this.proc = null;
        if (this.runningKey === def.key) this.runningKey = null;
        clearPid(def.pidFile);
        try {
          logStream?.end();
        } catch {}
        if (!settled) {
          finish({ ok: false, error: 'EXITED', code, signal: sig, log: LOG_FILE });
        }
      });

      // spawn 本身失败（ENOENT / 权限）不会触发 exit，只有 error 事件；
      // 不挂 handler 会变成 uncaughtException 或被 ensure 的空 catch 吞掉。
      child.on('error', (err) => {
        this.proc = null;
        this.runningKey = null;
        clearPid(def.pidFile);
        try {
          logStream?.write(`\n[Scene3D] spawn 失败: ${err.message}\n`);
          logStream?.end();
        } catch {}
        console.error('[Scene3D] spawn 失败:', err.message);
        if (!settled) {
          finish({ ok: false, error: 'SPAWN_FAILED', message: err.message, log: LOG_FILE });
        }
      });

      const deadline = Date.now() + 180000;
      const poll = () => {
        if (settled) return;
        if (Date.now() > deadline) {
          finish({ ok: false, error: 'TIMEOUT', log: LOG_FILE });
          return;
        }
        http
          .get({ host: '127.0.0.1', port, path: '/health', timeout: 2000 }, (res) => {
            let body = '';
            res.on('data', (c) => (body += c));
            res.on('end', () => {
              try {
                const obj = JSON.parse(body);
                if (obj.status === 'ok') {
                  if (def.runtime === 'mlxserve') {
                    // 健康 ≠ 模型就位：再让服务器把模型读进内存
                    this.loadMlxModel(def)
                      .then((r) => {
                        if (r.ok) {
                          console.log(`[Scene3D] ✅ mlx-serve 就绪（${((Date.now() - startedAt) / 1000).toFixed(1)}s，常驻 ${r.residentMiB || '?'}MB）`);
                        }
                        finish(r);
                      })
                      .catch((err) => finish({ ok: false, error: 'LOAD_FAILED', message: err.message }));
                    return;
                  }
                  console.log(`[Scene3D] ✅ llama-server 就绪（${((Date.now() - startedAt) / 1000).toFixed(1)}s）`);
                  finish({ ok: true, loadMs: Date.now() - startedAt });
                  return;
                }
              } catch {}
              setTimeout(poll, 400);
            });
          })
          .on('error', () => setTimeout(poll, 400));
      };
      poll();
    });

    return result;
  }

  /**
   * 让 mlx-serve 把 Idol 权重读进内存，并等它变成 ready。
   * 内存不足时服务器回 503 out_of_memory（它自带预检），这里把原文抛上去，
   * 由前端提示用户「先关掉几个应用」——而不是我们自己偷偷 swap。
   */
  async loadMlxModel(def) {
    const modelDir = path.join(def.dir, def.modelId);
    const r = await this.httpJsonPost(def.port, '/v1/load-model', { model: modelDir }, 240000);
    if (r.status === 200 && r.json?.model?.state === 'ready') {
      const residentMiB = Math.round((r.json.model.bytes_resident || 0) / 2 ** 20);
      return { ok: true, loadMs: 0, residentMiB };
    }
    const msg = r.json?.error?.message || r.raw || `HTTP ${r.status}`;
    if (/not enough free memory|out_of_memory|insufficientmemory/i.test(msg)) {
      return { ok: false, error: 'OUT_OF_MEMORY', message: msg };
    }
    return { ok: false, error: 'LOAD_FAILED', message: msg };
  }

  /**
   * 消息发出时调用：拉起运行时并阻塞到模型加载完成。
   * 模型缺失 → 自动补下载并等待（首次使用的消息会等下载，窗口头部有进度）。
   * 就绪后 useCount++，挂住闲置卸载，直到输出结束 endUse。
   */
  async beginUse() {
    let r = await this.start();
    if (!r.ok && r.error === 'MODEL_MISSING') {
      if (!this.download.active) {
        this.startDownload().catch((err) => {
          console.warn('[Scene3D] beginUse 自动下载失败:', err.message);
        });
      }
      // 等模型就绪（下载可能长达数十分钟；窗口头部 / 设置卡片有实时进度）
      const deadline = Date.now() + 45 * 60_000;
      while (!this.modelStatus().ready && Date.now() < deadline) {
        await new Promise((res) => setTimeout(res, 2000));
        r = await this.start().catch(() => ({ ok: false, error: 'RETRY' }));
        if (r.ok) break;
      }
      if (!r.ok) r = await this.start();
      if (!r.ok) throw new Error(r.error || 'MODEL_NOT_READY');
    } else if (!r.ok) {
      const err = new Error(r.message || r.error || 'start failed');
      err.code = r.error || 'START_FAILED';
      throw err;
    }
    this.useCount++;
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    return this.getStatus();
  }

  /** 一次输出结束（成功 / 失败 / 用户中止）后调用：递减在途计数并安排闲置卸载 */
  endUse() {
    this.useCount = Math.max(0, this.useCount - 1);
    this.scheduleIdleUnload();
  }

  scheduleIdleUnload() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const mins = Number(this.config.idleUnloadMin);
    if (!Number.isFinite(mins) || mins <= 0) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.useCount > 0) return;              // 仍有在途生成
      if (this.download.active) { this.scheduleIdleUnload(); return; } // 下载中顺延
      if (!this.isRunning()) return;
      console.log(`[Scene3D] 闲置 ${mins} 分钟，卸载模型并停止服务`);
      this.stop();
    }, mins * 60_000);
    this.idleTimer.unref?.();
  }

  stop() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    // 两个模型的运行时都清：互斥前提下只会有一个在跑，但「上次残留 / pid 文件被手工删掉」
    // 这类情况下另一个也可能活着，关窗（/release）是最后一道能保证内存被还回去的地方。
    for (const key of MODEL_KEYS) {
      const def = MODEL_DEFS[key];
      const pid = this.pidOf(key);
      if (isPidAlive(pid)) {
        try {
          process.kill(pid, 'SIGTERM');
        } catch {}
        setTimeout(() => {
          // 已被下一次开窗的新进程顶替就不要误杀（PID 可能复用）
          if (this.proc?.pid === pid) return;
          if (!isPidAlive(pid)) return;
          try {
            process.kill(pid, 'SIGKILL');
          } catch {}
        }, 1500).unref?.();
      }
      clearPid(def.pidFile);
    }
    this.proc = null;
    this.runningKey = null;
    return { ok: true };
  }

  // 正常退出：与 tts/ocr 一致，只发 SIGTERM（两个模型都清，互斥前提下最多只有一个活着）
  shutdownSync() {
    for (const key of MODEL_KEYS) {
      const pid = this.pidOf(key);
      if (isPidAlive(pid)) {
        try {
          process.kill(pid, 'SIGTERM');
        } catch {}
      }
    }
    this.proc = null;
  }

  // 最后一道：进程已退出时兜底 SIGKILL 并清 PID 文件
  shutdownForce() {
    for (const key of MODEL_KEYS) {
      const def = MODEL_DEFS[key];
      const pid = this.pidOf(key);
      if (isPidAlive(pid)) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {}
      }
      clearPid(def.pidFile);
    }
    this.proc = null;
  }

  // ----------------------------- 单图 → GLB（Idol） -----------------------------

  /** 把会话里的图片引用（data URL 或 /api/media/<file>）变成 Buffer */
  resolveImageBuffer(imgRef) {
    if (!imgRef || typeof imgRef !== 'string') return null;
    try {
      if (imgRef.startsWith('data:')) {
        const idx = imgRef.indexOf(',');
        if (idx < 0) return null;
        return Buffer.from(imgRef.slice(idx + 1), 'base64');
      }
      const name = path.basename(imgRef.split('?')[0]);
      if (!name) return null;
      const full = path.join(MEDIA_DIR, name);
      if (!fs.existsSync(full)) return null;
      return fs.readFileSync(full);
    } catch {
      return null;
    }
  }

  /**
   * 生成一次 GLB。只有选中 idol 时可用；调用方负责 beginUse/endUse。
   * @returns {Promise<{ok:true, url:string, bytes:number, ms:number, name:string}>}
   */
  async generateFromImage({ image, steps = GEN_IMAGE.steps, gaussians = GEN_IMAGE.gaussians, signal } = {}) {
    const def = MODEL_DEFS.idol;
    const buf = this.resolveImageBuffer(image);
    if (!buf || buf.length === 0) {
      const err = new Error('IMAGE_REQUIRED');
      err.code = 'IMAGE_REQUIRED';
      throw err;
    }
    if (!this.isRunning()) {
      const r = await this.start();
      if (!r.ok) {
        const err = new Error(r.message || r.error || 'start failed');
        err.code = r.error || 'START_FAILED';
        throw err;
      }
    }

    const payload = JSON.stringify({
      model: def.modelId,
      image: buf.toString('base64'),
      steps,
      num_gaussians: gaussians,
    });
    const startedAt = Date.now();

    const raw = await new Promise((resolve, reject) => {
      let settled = false;
      const done = (fn, arg) => {
        if (settled) return;
        settled = true;
        clearTimeout(hardTimeout);
        fn(arg);
      };
      const req = http.request(
        {
          host: '127.0.0.1',
          port: def.port,
          path: '/v1/3d/generations',
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const body = Buffer.concat(chunks).toString('utf-8');
            if (res.statusCode !== 200) {
              let msg = body.slice(0, 400);
              try {
                msg = JSON.parse(body)?.error?.message || msg;
              } catch {}
              const err = new Error(msg);
              err.code = res.statusCode === 503 ? 'OUT_OF_MEMORY' : 'GENERATE_FAILED';
              done(reject, err);
              return;
            }
            done(resolve, body);
          });
          res.on('error', (err) => done(reject, err));
        }
      );
      // 整体上限（不是 idle 超时）：长任务期间不会被切断
      const hardTimeout = setTimeout(() => {
        req.destroy(new Error('timeout'));
      }, IDOL_TIMEOUT_MS);
      hardTimeout.unref?.();
      req.on('error', (err) => done(reject, err));
      if (signal) {
        if (signal.aborted) req.destroy(new Error('aborted'));
        else signal.addEventListener('abort', () => {
          try {
            req.destroy(new Error('aborted'));
          } catch {}
        }, { once: true });
      }
      req.write(payload);
      req.end();
    });

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('GENERATE_FAILED: 返回不是 JSON');
    }
    if (!parsed?.data) throw new Error('GENERATE_FAILED: 响应缺少 GLB 数据');

    const glb = Buffer.from(parsed.data, 'base64');
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    const name = `idol-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.glb`;
    fs.writeFileSync(path.join(OUTPUT_DIR, name), glb);

    return {
      ok: true,
      url: `/api/scene3d/asset/${name}`,
      name,
      bytes: glb.length,
      ms: Date.now() - startedAt,
      steps,
      gaussians,
    };
  }

  /** 清掉过期的产物（会话里只存 URL，文件久了没人看就回收） */
  cleanupOutputs(maxAgeDays = 30) {
    try {
      if (!fs.existsSync(OUTPUT_DIR)) return;
      const cutoff = Date.now() - maxAgeDays * 24 * 3600_000;
      for (const name of fs.readdirSync(OUTPUT_DIR)) {
        const full = path.join(OUTPUT_DIR, name);
        try {
          if (fs.statSync(full).mtimeMs < cutoff) fs.rmSync(full, { force: true });
        } catch {}
      }
    } catch {}
  }

  async getStatus() {
    const def = this.selectedModel();
    const model = this.modelStatus(def);
    const runtime = this.runtimeStatus(def);
    const running = this.isRunning();
    let ready = false;
    if (running) {
      ready = await this.healthOk(def.port, 1500);
    }
    return {
      status: !model.ready
        ? 'incomplete'
        : running
        ? ready
        ? 'ready'
        : 'loading'
        : 'standby',
      running,
      ready,
      modelsReady: model.ready,
      runtimeReady: runtime.ready,
      selectedKey: def.key,
      model: { ...model, runtime },
      models: this.modelEntries(),
      runtime,
      /** 每个模型各自的进程存活情况（互斥自查用：正常情况下最多一个为 true） */
      runtimes: MODEL_KEYS.reduce((acc, key) => {
        acc[key] = this.runtimeAlive(key);
        return acc;
      }, {}),
      config: { ...this.config },
      hostMacOS: this.hostMacOS,
      params: { ...GEN_PARAMS },
      imageParams: { ...GEN_IMAGE },
      port: def.port,
      logFile: LOG_FILE,
      download: this.downloadStatus(),
    };
  }

  // ----------------------------- HTTP API -----------------------------

  async handleApi(req, res) {
    const host = req.headers.host || '127.0.0.1:31235';
    const urlObj = new URL(req.url, `http://${host}`);
    const pathname = urlObj.pathname.replace(/^\/api\/scene3d/, '');

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

    const readBody = () =>
      new Promise((resolve) => {
        let raw = '';
        req.on('data', (c) => {
          raw += c;
          if (raw.length > 1_000_000) req.destroy();
        });
        req.on('end', () => {
          try {
            resolve(JSON.parse(raw || '{}'));
          } catch {
            resolve({});
          }
        });
        req.on('error', () => resolve({}));
      });

    try {
      if (pathname === '/status' && req.method === 'GET') {
        sendJson(200, await this.getStatus());
        return;
      }
      // /ensure 已删除：开窗只读 /status，**加载一律由消息触发的 beginUse 驱动**
      // （与「发送之后再加载」的契约一致，避免留一条「开窗就拽起 4GB 模型」的暗门）。
      // 关窗调用：终止进程（幂等）
      if (pathname === '/release' && req.method === 'POST') {
        this.stop();
        sendJson(200, { ok: true, status: (await this.getStatus()).status });
        return;
      }
      if (pathname === '/start' && req.method === 'POST') {
        const r = await this.start();
        sendJson(200, { ...r, status: (await this.getStatus()).status });
        return;
      }
      if (pathname === '/stop' && req.method === 'POST') {
        this.stop();
        sendJson(200, { ok: true, status: (await this.getStatus()).status });
        return;
      }
      // 模型选择 / 闲置卸载时长（设置页 Save 时提交）
      if (pathname === '/config' && req.method === 'GET') {
        sendJson(200, { ok: true, config: { ...this.config }, models: this.modelEntries() });
        return;
      }
      if (pathname === '/config' && req.method === 'POST') {
        const body = await readBody();
        const config = await this.setConfig(body || {});
        // rejected:'BUSY' = 有生成任务在跑，这次切换被拒绝（config 原样返回）
        sendJson(200, {
          ok: !config.rejected,
          rejected: config.rejected || null,
          config: { modelKey: config.modelKey, idleUnloadMin: config.idleUnloadMin },
          status: (await this.getStatus()).status,
        });
        return;
      }
      if (pathname === '/download' && req.method === 'POST') {
        // 立即返回，后台继续下载；进度由 /api/scene3d/status 轮询获取。
        this.startDownload().catch((err) => {
          console.warn('[Scene3D] download error:', err.message);
        });
        sendJson(200, { ok: true, downloadState: this.downloadStatus() });
        return;
      }
      if (pathname === '/download/status' && req.method === 'GET') {
        sendJson(200, this.downloadStatus());
        return;
      }
      if (pathname === '/download/cancel' && req.method === 'POST') {
        const state = this.cancelDownload();
        sendJson(200, { ok: true, downloadState: state });
        return;
      }
      if (pathname === '/open-dir' && req.method === 'POST') {
        try {
          fs.mkdirSync(MODEL_ROOT, { recursive: true });
          spawn('open', [MODEL_ROOT], { detached: true, stdio: 'ignore' }).unref();
          sendJson(200, { ok: true, path: MODEL_ROOT });
        } catch (e) {
          sendJson(500, { ok: false, error: e.message });
        }
        return;
      }
      // 产物 GLB（沙箱 iframe 里的 GLTFLoader 来取，必须带 CORS）
      if (pathname.startsWith('/asset/') && req.method === 'GET') {
        const name = path.basename(decodeURIComponent(pathname.slice('/asset/'.length)));
        if (!/^[\w.-]+\.glb$/.test(name)) {
          sendJson(400, { error: 'BAD_ASSET_NAME' });
          return;
        }
        const full = path.join(OUTPUT_DIR, name);
        let stat = null;
        try {
          stat = fs.statSync(full);
        } catch {}
        if (!stat || !stat.isFile()) {
          sendJson(404, { error: 'ASSET_MISSING' });
          return;
        }
        res.writeHead(200, {
          'Content-Type': 'model/gltf-binary',
          'Content-Length': stat.size,
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'public, max-age=86400',
        });
        fs.createReadStream(full).pipe(res);
        return;
      }
      // 内置前端模块（three 核心 / GLTFLoader）：供沙箱 iframe（opaque origin）以
      // module script 拉取，必须带 CORS 头与正确的 JS MIME。
      if (pathname.startsWith('/vendor/') && req.method === 'GET') {
        const rel = path.basename(pathname.slice('/vendor/'.length));
        const target = VENDOR_FILES[rel];
        if (!target) {
          sendJson(404, { error: 'VENDOR_UNKNOWN' });
          return;
        }
        const full = path.join(THREE_VENDOR_DIR, target);
        let stat = null;
        try {
          stat = fs.statSync(full);
        } catch {}
        if (!stat || !stat.isFile()) {
          sendJson(404, { error: 'VENDOR_MISSING' });
          return;
        }
        res.writeHead(200, {
          'Content-Type': 'application/javascript; charset=utf-8',
          'Content-Length': stat.size,
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'public, max-age=31536000',
        });
        fs.createReadStream(full).pipe(res);
        return;
      }
      sendJson(404, { error: 'NOT_FOUND' });
    } catch (e) {
      sendJson(500, { error: 'SCENE3D_API_FAILED', message: e.message });
    }
  }

  init() {
    // 启动时不拉起模型：消息发出才加载、闲置卸载。
    // 上次运行残留的进程由 App 启动前的 cleanStaleProcessesBeforeLaunch（managedPidFiles）
    // 统一清理，这里只清掉已失效的 PID 文件、下载临时碎片与过期产物。
    for (const key of MODEL_KEYS) {
      const def = MODEL_DEFS[key];
      const pid = readPid(def.pidFile);
      if (!isPidAlive(pid)) clearPid(def.pidFile);
    }
    this.cleanTempFiles({ removePartFiles: false });
    this.cleanupOutputs();
  }
}

export const scene3dService = new Scene3dService();
