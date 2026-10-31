// TTS（文字转语音）服务托管模块 —— Qwen3-TTS 1.7B CustomVoice (MLX 6bit) via mlx-audio
//
// 职责：把「朗读回答」所用的语音合成作为与基础模型、知识库、ASR、字幕并列的受管服务：
//   - **每次生成现场加载**：收到合成请求才拉起 Python 进程，整篇合成结束立即卸载（无闲置策略）；
//   - SimpleUI 退出时一并终止（与其它受管服务行为对齐）；
//   - 配置持久化在 tts_config.json（音色 / 语言 / 采样参数），
//     模型固定放在 ~/Library/Application Support/SimpleUI/models/tts/。
//
// 与「实时字幕服务」（server/subtitle_service.js）同构：模型下载采用「双源自动测速 + 断点续传 +
// 可取消 + 实时进度」，服务面板展示内置运行环境、模型完备状态与下载进度。
//
// 「整篇朗读」= 前端按段落切好的 segments 逐段送来，Node 逐段调用 Python、逐段回传进度，
// 全部完成后把 PCM 拼成一条 WAV 落盘到 tts_output/，前端拿到稳定的 /api/tts/audio/... URL 播放。
//
// 模型与运行时：
//   - 模型：mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-6bit（约 2.7GB，talker 6bit、codec bf16）
//   - 运行时：mlx-audio（Python）。qwen3_tts 族在 audio.cpp 里只有 1.7B CustomVoice 的打包格式，
//     与 cstr / mlx-community 的产物不兼容，因此这里走 Python 侧的自有 HTTP 包装
//     （server/tts/tts_server.py），对 Node 暴露极简接口。
//
// 接口（Node 侧）：
//   GET  /api/tts/status
//   POST /api/tts/{start,stop}
//   GET  /api/tts/config | POST /api/tts/config
//   GET  /api/tts/voices
//   POST /api/tts/speak      {text, voice?, ...} -> audio/wav（单段，调试用）
//   POST /api/tts/article    {messageId, text, segments[]} -> application/x-ndjson 进度流
//   GET  /api/tts/audio/list -> 已落盘音频索引
//   GET  /api/tts/audio/file/<name> -> audio/wav（支持 Range）
//   POST /api/tts/audio/delete {messageId}
//   GET  /api/tts/download/status | POST /api/tts/download | POST /api/tts/download/cancel
//   POST /api/tts/open-dir

import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import https from 'https';
import { fileURLToPath } from 'url';
import { startWatchdog } from './watchdog.js';
import { formatBytes } from './format_bytes.js';
import { DOWNLOAD_ERROR, downloadError, classifyDownloadError } from './download_errors.js';
import { ModelStaging, sweepStaleStaging } from './download_store.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const HOME = os.homedir();

const USER_DIR = path.join(HOME, 'Library', 'Application Support', 'SimpleUI');
const CONFIG_FILE = path.join(USER_DIR, 'tts_config.json');
const MODEL_DIR = path.join(USER_DIR, 'models', 'tts');
const OUTPUT_DIR = path.join(USER_DIR, 'tts_output');
const OUTPUT_INDEX = path.join(OUTPUT_DIR, 'index.json');
const LOG_FILE = process.env.SIMPLEUI_TTS_LOG || path.join(HOME, 'Library', 'Logs', 'simpleui-tts.log');
const PID_FILE = '/tmp/simpleui_tts.pid';
const SCRIPT = path.join(__dirname, 'tts', 'tts_server.py');

const PORT = 1255;
const VOICES = ['serena', 'vivian', 'aiden', 'ryan', 'sohee', 'ono_anna', 'uncle_fu', 'dylan', 'eric'];

// 段间静音（毫秒）：分段合成拼成整篇时，段落之间留一点呼吸，避免句子粘在一起。
const SEGMENT_GAP_MS = 150;
// 单次「整篇朗读」的输入上限，避免一次点朗读把几万字塞给模型。
const MAX_ARTICLE_CHARS = 12000;
const MAX_SEGMENTS = 400;

const DEFAULT_CONFIG = {
  voice: 'serena',
  language: 'auto',
  temperature: 0.85,
  top_p: 0.95,
  top_k: 50,
  repetitionPenalty: 1.05,
  maxTokens: 1024,
};

// 采样参数的合法区间（面板输入与 API 共用，越界即夹取）
const PARAM_RANGES = {
  temperature: [0.1, 2],
  top_p: [0.05, 1],
  top_k: [1, 200],
  repetitionPenalty: [1, 1.5],
  maxTokens: [128, 4096],
};

// ---- 模型清单（与字幕服务对齐：每个文件带 minBytes，按磁盘实际大小校验完整性）----

const MODEL_KEY = 'tts';
const MODEL_NAME = 'Qwen3-TTS 1.7B CustomVoice (MLX 6bit)';
const MODEL_SHORT_NAME = 'Qwen3-TTS 1.7B';

// 模型来源：mlx-community 的 1.7B 6bit 转换。根目录是 talker，speech_tokenizer/ 是独立 codec，
// 两者缺一不可（缺 codec 会报 Speech tokenizer not loaded）。codec 与 0.6B 版本字节完全一致，
// 换模型时会被完整性校验直接复用，只需重下 model.safetensors。
const MODEL_REPO = 'mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-6bit';
const MODEL_FILES = [
  { path: 'model.safetensors', expectedBytes: 2009267875, minBytes: 1990000000, required: true },
  { path: 'speech_tokenizer/model.safetensors', expectedBytes: 682293092, minBytes: 670000000, required: true },
  { path: 'vocab.json', expectedBytes: 2776833, minBytes: 2700000, required: true },
  { path: 'merges.txt', expectedBytes: 1671839, minBytes: 1600000, required: true },
  { path: 'model.safetensors.index.json', expectedBytes: 71786, minBytes: 70000, required: false },
  { path: 'tokenizer_config.json', expectedBytes: 7344, minBytes: 7000, required: true },
  { path: 'config.json', expectedBytes: 6058, minBytes: 5000, required: true },
  { path: 'generation_config.json', expectedBytes: 245, minBytes: 200, required: false },
  { path: 'preprocessor_config.json', expectedBytes: 127, minBytes: 100, required: false },
  { path: 'speech_tokenizer/config.json', expectedBytes: 2336, minBytes: 2000, required: true },
  { path: 'speech_tokenizer/preprocessor_config.json', expectedBytes: 234, minBytes: 200, required: false },
  { path: 'speech_tokenizer/configuration.json', expectedBytes: 76, minBytes: 50, required: false },
];
const MODEL_TOTAL_BYTES = MODEL_FILES.reduce((a, f) => a + f.expectedBytes, 0);

// 官方源与国内高速镜像源定义（与字幕服务保持同一套双源策略）
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

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readPid() {
  try {
    const raw = fs.readFileSync(PID_FILE, 'utf-8').trim();
    const pid = parseInt(raw, 10);
    return Number.isInteger(pid) ? pid : null;
  } catch {
    return null;
  }
}

function writePid(pid) {
  try {
    fs.writeFileSync(PID_FILE, String(pid));
  } catch {}
}

function clearPid() {
  try {
    if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE);
  } catch {}
}

// ---- WAV / 音频落盘工具 ----

/** 解析 16bit 单声道 WAV（tts_server.py 的输出格式），返回 PCM 与时长。 */
function parseWav(buf) {
  if (!buf || buf.length < 44) return null;
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null;
  let off = 12;
  let fmt = null;
  let data = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ') {
      fmt = {
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bits: buf.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      data = buf.subarray(body, Math.min(body + size, buf.length));
    }
    off = body + size + (size % 2);
  }
  if (!fmt || !data || fmt.channels !== 1 || fmt.bits !== 16) return null;
  const frames = Math.floor(data.length / 2);
  return {
    pcm: data.subarray(0, frames * 2),
    sampleRate: fmt.sampleRate,
    duration: frames / fmt.sampleRate,
  };
}

/** 把 PCM(s16le/单声道) 包成标准 44 字节头的 WAV。 */
function buildWav(pcm, sampleRate) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** FNV-1a 32bit（与前端 src/utils/speechText.ts 里的实现必须逐字节一致）。 */
function fnv1a32(str) {
  const bytes = Buffer.from(String(str), 'utf8');
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function safeId(id) {
  return String(id).replace(/[^\w.-]+/g, '_').slice(0, 64) || 'msg';
}

function fileForAudio(id, hash) {
  return `${safeId(id)}-${hash.toString(16).padStart(8, '0')}.wav`;
}

function readAudioIndex() {
  try {
    if (!fs.existsSync(OUTPUT_INDEX)) return {};
    const raw = JSON.parse(fs.readFileSync(OUTPUT_INDEX, 'utf-8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

function writeAudioIndex(map) {
  try {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    fs.writeFileSync(OUTPUT_INDEX, JSON.stringify(map, null, 2));
  } catch (e) {
    console.warn('[TTS] 写入音频索引失败:', e.message);
  }
}

/** 落盘一条整篇音频，并把它写进索引（同一 messageId 覆盖旧的）。 */
function saveAudioFile(messageId, text, wav, durationSec, chars) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const hash = fnv1a32(text);
  const file = fileForAudio(messageId, hash);
  const abs = path.join(OUTPUT_DIR, file);

  const index = readAudioIndex();
  // 同一 messageId 的旧文件（内容已变）删掉，避免 tts_output 越攒越多
  const prev = index[messageId];
  if (prev?.file && prev.file !== file) {
    try {
      fs.rmSync(path.join(OUTPUT_DIR, prev.file), { force: true });
    } catch {}
  }

  fs.writeFileSync(abs, wav);
  index[messageId] = {
    id: messageId,
    h: hash,
    file,
    dur: Number(durationSec.toFixed(3)),
    chars,
    bytes: wav.length,
    createdAt: Date.now(),
  };
  writeAudioIndex(index);
  console.log(`[TTS] 音频已落盘 ${file}（${durationSec.toFixed(1)}s, ${(wav.length / 1024).toFixed(0)}KB）`);

  return {
    messageId,
    hash,
    file,
    url: `/api/tts/audio/file/${encodeURIComponent(file)}`,
    durationSec: Number(durationSec.toFixed(3)),
    bytes: wav.length,
  };
}

/** 索引里只返回磁盘上确实存在的条目（用户手删文件后不会出现"假播放条"）。 */
function listAudio() {
  const index = readAudioIndex();
  const items = [];
  let dirty = false;
  for (const [id, entry] of Object.entries(index)) {
    if (!entry?.file) {
      delete index[id];
      dirty = true;
      continue;
    }
    if (!fs.existsSync(path.join(OUTPUT_DIR, entry.file))) {
      delete index[id];
      dirty = true;
      continue;
    }
    items.push({
      id,
      h: entry.h,
      dur: entry.dur,
      url: `/api/tts/audio/file/${encodeURIComponent(entry.file)}`,
      createdAt: entry.createdAt,
    });
  }
  if (dirty) writeAudioIndex(index);
  return items;
}

function deleteAudio(messageId) {
  const index = readAudioIndex();
  const entry = index[messageId];
  if (!entry) return { ok: true, removed: false };
  try {
    fs.rmSync(path.join(OUTPUT_DIR, entry.file), { force: true });
  } catch {}
  delete index[messageId];
  writeAudioIndex(index);
  return { ok: true, removed: true };
}

class TtsService {
  constructor() {
    this.proc = null;
    this.starting = null;
    this.config = { ...DEFAULT_CONFIG };
    this.watchdog = null;
    this.loadError = null;
    this.downloadAbortController = null;
    /** 当前整篇朗读任务：{ id, cancelled } —— 同一时刻只允许一个（单 GPU 串行） */
    this.articleJob = null;
    /** 正在进行的单段 HTTP 请求（用户取消时直接 destroy，缩短等待） */
    this.pyReq = null;
    this.download = {
      active: false,
      errorCode: null,
      phase: 'idle',
      targetModel: null,
      currentModelKey: null,
      currentModelName: '',
      currentFile: '',
      selectedSource: null,
      downloadedBytes: 0,
      totalBytes: MODEL_TOTAL_BYTES,
      progressPercent: 0,
      speedBps: 0,
      etaSeconds: null,
      error: null,
      updatedAt: 0,
    };
  }

  // ----------------------------- 配置 -----------------------------

  /** 把任意来源（旧配置文件 / 面板表单 / API）的参数夹到合法区间。 */
  normalizeConfig(input = {}) {
    const out = {};
    if (typeof input.voice === 'string' && VOICES.includes(input.voice)) out.voice = input.voice;
    if (typeof input.language === 'string' && input.language) out.language = input.language;
    for (const [key, [min, max]] of Object.entries(PARAM_RANGES)) {
      const raw = input[key];
      if (raw === undefined || raw === null || raw === '') continue;
      const num = Number(raw);
      if (!Number.isFinite(num)) continue;
      const clamped = Math.min(max, Math.max(min, num));
      out[key] = key === 'top_k' || key === 'maxTokens' ? Math.round(clamped) : clamped;
    }
    return out;
  }

  loadConfig() {
    try {
      if (fs.existsSync(CONFIG_FILE)) {
        const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
        // 旧字段：enabled（服务总开关）、idleUnloadMin（闲置卸载）、speed（上游 no-op）都不再使用。
        delete parsed.enabled;
        delete parsed.idleUnloadMin;
        delete parsed.speed;
        this.config = { ...DEFAULT_CONFIG, ...this.normalizeConfig(parsed) };
        // 顺手把清理后的配置写回，避免旧键长期滞留
        this.saveConfig();
      }
    } catch (e) {
      console.warn('[TTS] 读取配置失败，使用默认值:', e.message);
    }
  }

  saveConfig() {
    try {
      if (!fs.existsSync(USER_DIR)) fs.mkdirSync(USER_DIR, { recursive: true });
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(this.config, null, 2));
    } catch (e) {
      console.warn('[TTS] 保存配置失败:', e.message);
    }
  }

  // ----------------------------- 模型下载 -----------------------------

  downloadStatus() {
    return { ...this.download };
  }

  /**
   * 发起支持自动重定向（301/302/307/308）的 HTTP/HTTPS 请求。
   * 与字幕服务同一实现，供测速与断点续传下载共用。
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

  /**
   * 清理模型目录内的下载临时碎片（.part / .tmp / .download）。
   * 仅在下载成功收尾时移除 .part；中途取消/失败保留 .part 以支持断点续传。
   */
  cleanTempFiles({ removePartFiles = false } = {}) {
    if (!fs.existsSync(MODEL_DIR)) return { removed: [] };
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
            removed.push(path.relative(MODEL_DIR, full));
          }
        }
      } catch {}
    };
    walk(MODEL_DIR);
    if (removed.length > 0) {
      console.log(`[TTS] 🧹 已自动清理下载临时文件: ${removed.join(', ')}`);
    }
    return { removed };
  }

  /**
   * 一键测速并下载缺失模型（双源自动选优 + 断点续传 + 可取消）。
   */
  async startDownload() {
    if (this.download.active) return this.downloadStatus();
    if (this.modelStatus().ready) return this.downloadStatus();

    this.downloadAbortController = new AbortController();
    const signal = this.downloadAbortController.signal;

    this.download = {
      ...this.download,
      active: true,
      phase: 'probing',
      targetModel: MODEL_KEY,
      currentModelKey: MODEL_KEY,
      currentModelName: MODEL_NAME,
      currentFile: '',
      selectedSource: null,
      downloadedBytes: 0,
      totalBytes: MODEL_TOTAL_BYTES,
      progressPercent: 0,
      speedBps: 0,
      etaSeconds: null,
      error: null,
      errorCode: null,
      updatedAt: Date.now(),
    };

    // 先把文件全部下到 <模型目录>/.incoming/tts/，全部到齐再一次性 rename 到正式目录
    let staging = null;
    const commitEntries = [];
    try {
      sweepStaleStaging(MODEL_DIR);
      staging = new ModelStaging(MODEL_DIR, 'tts').begin();
      const probeFile = MODEL_FILES.reduce((a, b) =>
        (Number(b.expectedBytes) || 0) > (Number(a.expectedBytes) || 0) ? b : a
      );
      const probeRelative = `${MODEL_REPO}/resolve/main/${probeFile.path}`;

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

      for (const file of MODEL_FILES) {
        if (signal.aborted) throw new Error('cancelled');
        const finalPath = path.join(MODEL_DIR, file.path);
        if (fs.existsSync(finalPath) && fs.statSync(finalPath).size >= file.minBytes) continue;
        const dst = staging.pathFor(file.path);

        let fileDone = false;
        let lastErr = null;

        for (const srcNode of candidateSources) {
          if (signal.aborted) throw new Error('cancelled');
          const url = `${srcNode.baseUrl}/${MODEL_REPO}/resolve/main/${file.path}`;
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
            console.warn(`[TTS] Source ${srcNode.name} interrupted, trying backup:`, err.message);
          }
        }

        if (!fileDone) {
          throw lastErr || new Error(`DOWNLOAD_FAILED: ${file.path}`);
        }
      }

      this.download.phase = 'cleaning';
      staging.commit(commitEntries, { markKeys: ['tts'] });
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
      if (!cancelled) console.warn('[TTS] 模型下载失败:', err.message);
    } finally {
      this.downloadAbortController = null;
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

  resolvePython() {
    const candidates = [
      process.env.SIMPLEUI_TTS_PYTHON,
      path.join(__dirname, 'tts', 'python', 'bin', 'python3'),
      path.join(process.resourcesPath || '', 'tts', 'python', 'bin', 'python3'),
      // 开发态项目内置运行时（与 build_mac_app.sh 打包来源一致）
      path.resolve(__dirname, '..', 'bin', 'tts_runtime', 'python', 'bin', 'python3'),
      path.join(HOME, '.workbuddy', 'binaries', 'python', 'envs', 'default', 'bin', 'python3'),
    ].filter(Boolean);
    for (const c of candidates) {
      try {
        if (fs.existsSync(c)) return c;
      } catch {}
    }
    return 'python3';
  }

  /** 内置运行环境（可移植 Python + mlx-audio）是否就绪 */
  runtimeStatus() {
    const python = this.resolvePython();
    const isFallback = python === 'python3';
    return {
      ready: isFallback ? false : fs.existsSync(python),
      path: python,
      bundled: !isFallback,
    };
  }

  modelStatus() {
    const files = MODEL_FILES.map((f) => {
      const full = path.join(MODEL_DIR, f.path);
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

    let bytes = 0;
    const walk = (dir) => {
      try {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(full);
          else {
            try {
              bytes += fs.statSync(full).size;
            } catch {}
          }
        }
      } catch {}
    };
    walk(MODEL_DIR);

    return {
      key: MODEL_KEY,
      name: MODEL_NAME,
      shortName: MODEL_SHORT_NAME,
      dir: MODEL_DIR,
      ready: missing.length === 0,
      missing,
      bytes,
      expectedBytes: MODEL_TOTAL_BYTES,
      sizeDesc: formatBytes(MODEL_TOTAL_BYTES),
      path: path.join(MODEL_DIR, MODEL_FILES[0]?.path || ''),
    };
  }

  isRunning() {
    return isPidAlive(this.proc?.pid || readPid());
  }

  // ----------------------------- 生命周期 -----------------------------

  /**
   * 兜底守护：与 ttf / asr 同一套实现（server/watchdog.js）。
   * 代理被 SIGKILL 时由它按 PID 精确终止 tts_server.py；正常退出走 proxy 的退出钩子。
   */
  ensureWatchdog() {
    if (this.watchdog) return;
    try {
      this.watchdog = startWatchdog({
        pidFile: PID_FILE,
        binaryBasename: 'tts_server.py',
      });
    } catch {
      // watchdog 失败不阻断启动
    }
  }

  async start(signal) {
    if (this.isRunning()) return { ok: true, alreadyRunning: true };
    if (this.starting) return this.starting;

    const model = this.modelStatus();
    if (!model.ready) {
      return { ok: false, error: 'MODEL_MISSING', missing: model.missing, dir: model.dir };
    }

    const runtime = this.runtimeStatus();
    const python = runtime.path;
    const startedAt = Date.now();
    this.loadError = null;

    this.starting = new Promise((resolve) => {
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        this.starting = null;
        resolve(result);
      };

      let logStream = null;
      try {
        if (!fs.existsSync(path.dirname(LOG_FILE))) fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
        logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
      } catch {}

      const child = spawn(python, [SCRIPT, '--model-dir', MODEL_DIR, '--port', String(PORT)], {
        cwd: __dirname,
        env: { ...process.env, PYTHONUNBUFFERED: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      this.proc = child;
      if (child.pid) writePid(child.pid);
      this.ensureWatchdog();

      const onData = (buf) => {
        try {
          logStream?.write(buf);
        } catch {}
      };
      child.stdout?.on('data', onData);
      child.stderr?.on('data', onData);

      child.on('exit', (code, signal) => {
        this.proc = null;
        clearPid();
        try {
          logStream?.end();
        } catch {}
        if (!settled) {
          finish({ ok: false, error: 'EXITED', code, signal, log: LOG_FILE });
        }
      });

      // 轮询 /health，直到 ready（模型加载 15–20s，留足余量）
      const deadline = Date.now() + 180000;
      const poll = () => {
        if (settled) return;
        // 加载期间用户取消：直接把进程杀掉，不必等模型加载完
        if (signal?.aborted) {
          try {
            child.kill('SIGKILL');
          } catch {}
          this.proc = null;
          clearPid();
          finish({ ok: false, error: 'CANCELLED' });
          return;
        }
        if (Date.now() > deadline) {
          finish({ ok: false, error: 'TIMEOUT', log: LOG_FILE });
          return;
        }
        http
          .get({ host: '127.0.0.1', port: PORT, path: '/health', timeout: 2000 }, (res) => {
            let body = '';
            res.on('data', (c) => (body += c));
            res.on('end', () => {
              try {
                const obj = JSON.parse(body);
                if (obj.ready) {
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

    const result = await this.starting;
    return result;
  }

  stop() {
    const pid = this.proc?.pid || readPid();
    if (isPidAlive(pid)) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {}
      setTimeout(() => {
        // 已被下一次生成的新进程顶替就不要误杀（PID 可能复用）
        if (this.proc?.pid === pid) return;
        if (!isPidAlive(pid)) return;
        try {
          process.kill(pid, 'SIGKILL');
        } catch {}
      }, 1500).unref?.();
    }
    this.proc = null;
    clearPid();
    return { ok: true };
  }

  // 正常退出：与 asr/ttf 一致，只发 SIGTERM，由子进程自行收尾
  shutdownSync() {
    const pid = this.proc?.pid || readPid();
    if (isPidAlive(pid)) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {}
    }
    this.proc = null;
  }

  // 最后一道：进程已退出时兜底 SIGKILL 并清 PID 文件
  shutdownForce() {
    const pid = this.proc?.pid || readPid();
    if (isPidAlive(pid)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
    }
    this.proc = null;
    clearPid();
  }

  // ----------------------------- 合成 -----------------------------

  /** 单段合成（调用方负责保证 Python 已就绪）：返回 { ok, wav, duration } */
  speakSegment(text, overrides = {}) {
    const trimmed = String(text || '').trim();
    if (!trimmed) return Promise.resolve({ ok: false, error: 'EMPTY_TEXT' });
    const cfg = { ...this.config, ...this.normalizeConfig(overrides) };
    const payload = JSON.stringify({
      text: trimmed.slice(0, 4000),
      voice: cfg.voice || DEFAULT_CONFIG.voice,
      language: cfg.language || 'auto',
      temperature: cfg.temperature,
      top_p: cfg.top_p,
      top_k: cfg.top_k,
      repetition_penalty: cfg.repetitionPenalty,
      max_tokens: cfg.maxTokens,
    });

    return new Promise((resolve) => {
      let settled = false;
      const settle = (value) => {
        if (settled) return;
        settled = true;
        if (this.pyReq === req) this.pyReq = null;
        resolve(value);
      };

      const req = http.request(
        {
          host: '127.0.0.1',
          port: PORT,
          path: '/speak',
          method: 'POST',
          timeout: 180000,
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const buf = Buffer.concat(chunks);
            if (res.statusCode === 200) {
              settle({
                ok: true,
                wav: buf,
                duration: Number(res.headers['x-tts-duration']) || 0,
              });
            } else {
              settle({
                ok: false,
                error: 'SPEAK_FAILED',
                status: res.statusCode,
                body: buf.toString('utf-8').slice(0, 400),
              });
            }
          });
        }
      );
      this.pyReq = req;
      req.on('error', (e) => settle({ ok: false, error: 'SPEAK_ERROR', message: e.message }));
      req.on('timeout', () => {
        req.destroy();
        settle({ ok: false, error: 'SPEAK_TIMEOUT' });
      });
      req.write(payload);
      req.end();
    });
  }

  /** 打断正在进行的单段请求（用户取消 / 切到另一条朗读时用）。 */
  abortSegment() {
    const req = this.pyReq;
    if (!req) return;
    this.pyReq = null;
    try {
      req.destroy(new Error('cancelled'));
    } catch {}
  }

  /** 兼容旧接口：单段合成（自己保证服务就绪）。 */
  async speak(text, overrides = {}) {
    if (!this.isRunning()) {
      const started = await this.start();
      if (!started.ok) return started;
    }
    return this.speakSegment(text, overrides);
  }

  /**
   * 整篇朗读：逐段合成 → 拼成一条 WAV → 落盘 → 更新索引。
   *
   * 分段由前端按段落/句读切好传进来（Node 不复刻切分规则，避免两套实现漂移）。
   * 进度通过 onEvent 回传（NDJSON 流），每完成一段一次。结束后无论成败都卸载模型。
   */
  async synthesizeArticle({ messageId, text, segments, onEvent, signal }) {
    const emit = (evt) => {
      try {
        onEvent?.(evt);
      } catch {}
    };

    const id = String(messageId || '').trim();
    if (!id) return { ok: false, error: 'MISSING_MESSAGE_ID' };

    const segs = (Array.isArray(segments) ? segments : [])
      .map((s) => String(s || '').replace(/\s+/g, ' ').trim())
      .filter(Boolean);
    if (segs.length === 0) return { ok: false, error: 'EMPTY_TEXT' };
    if (segs.length > MAX_SEGMENTS) return { ok: false, error: 'TOO_MANY_SEGMENTS' };

    const totalChars = segs.reduce((a, s) => a + s.length, 0);
    if (totalChars > MAX_ARTICLE_CHARS) {
      return { ok: false, error: 'TEXT_TOO_LONG', totalChars, limit: MAX_ARTICLE_CHARS };
    }

    emit({ t: 'phase', phase: 'loading', total: segs.length, chars: totalChars });

    const started = await this.start(signal);
    if (!started.ok) return { ok: false, ...started };

    emit({ t: 'phase', phase: 'generating', total: segs.length, chars: totalChars });

    const pcmChunks = [];
    let sampleRate = 24000;
    let durationSec = 0;

    try {
      for (let i = 0; i < segs.length; i++) {
        if (signal?.aborted) return { ok: false, error: 'CANCELLED' };
        const r = await this.speakSegment(segs[i]);
        if (!r.ok) return { ok: false, ...r };
        const parsed = parseWav(r.wav);
        if (!parsed) return { ok: false, error: 'BAD_AUDIO' };

        sampleRate = parsed.sampleRate;
        pcmChunks.push(parsed.pcm);
        durationSec += parsed.duration;
        if (i < segs.length - 1) {
          const gapSamples = Math.round((sampleRate * SEGMENT_GAP_MS) / 1000);
          pcmChunks.push(Buffer.alloc(gapSamples * 2));
          durationSec += gapSamples / sampleRate;
        }
        emit({ t: 'progress', done: i + 1, total: segs.length });
      }
    } finally {
      // 每次生成都现场加载、生成完即卸载（不再有闲置计时）。
      // 取消时用 SIGKILL：模型正忙着推理，SIGTERM 要等这次 generate() 跑完才生效。
      if (signal?.aborted) this.shutdownForce();
      else this.stop();
    }

    if (signal?.aborted) return { ok: false, error: 'CANCELLED' };

    const pcm = Buffer.concat(pcmChunks);
    const wav = buildWav(pcm, sampleRate);
    const entry = saveAudioFile(id, String(text || segs.join(' ')), wav, durationSec, totalChars);

    emit({ t: 'done', ...entry });
    return { ok: true, ...entry };
  }

  async getStatus() {
    const model = this.modelStatus();
    const runtime = this.runtimeStatus();
    const running = this.isRunning();
    let ready = false;
    let voices = VOICES;
    if (running) {
      ready = await new Promise((resolve) => {
        http
          .get({ host: '127.0.0.1', port: PORT, path: '/health', timeout: 1500 }, (res) => {
            let body = '';
            res.on('data', (c) => (body += c));
            res.on('end', () => {
              try {
                const obj = JSON.parse(body);
                if (Array.isArray(obj.voices) && obj.voices.length) voices = obj.voices;
                resolve(Boolean(obj.ready));
              } catch {
                resolve(false);
              }
            });
          })
          .on('error', () => resolve(false));
      });
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
      model,
      runtime,
      voices,
      config: { ...this.config },
      python: runtime.path,
      port: PORT,
      logFile: LOG_FILE,
      download: this.downloadStatus(),
    };
  }

  // ----------------------------- HTTP API -----------------------------

  async handleApi(req, res) {
    const host = req.headers.host || '127.0.0.1:31235';
    const urlObj = new URL(req.url, `http://${host}`);
    const pathname = urlObj.pathname.replace(/^\/api\/tts/, '');

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
    const readJson = () =>
      new Promise((resolve, reject) => {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          try {
            resolve(JSON.parse(body || '{}'));
          } catch (e) {
            reject(e);
          }
        });
        req.on('error', reject);
      });

    try {
      if (pathname === '/status' && req.method === 'GET') {
        sendJson(200, await this.getStatus());
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
      if (pathname === '/config') {
        if (req.method === 'GET') {
          sendJson(200, { ...this.config });
          return;
        }
        const body = await readJson();
        if (body.voice && !VOICES.includes(body.voice)) {
          sendJson(400, { ok: false, error: 'UNKNOWN_VOICE' });
          return;
        }
        this.config = { ...this.config, ...this.normalizeConfig(body) };
        this.saveConfig();
        sendJson(200, { ok: true, config: { ...this.config } });
        return;
      }
      if (pathname === '/voices' && req.method === 'GET') {
        const status = await this.getStatus();
        sendJson(200, { voices: status.voices });
        return;
      }
      // 已落盘音频索引：前端启动时拉一次，给"生成过的回答"恢复播放条。
      if (pathname === '/audio/list' && req.method === 'GET') {
        sendJson(200, { items: listAudio() });
        return;
      }
      if (pathname === '/audio/delete' && req.method === 'POST') {
        const body = await readJson();
        sendJson(200, deleteAudio(String(body.messageId || '')));
        return;
      }
      // 音频文件：支持 Range，<audio> 拖动进度条才不会退回从头加载。
      if (pathname.startsWith('/audio/file/') && req.method === 'GET') {
        const name = decodeURIComponent(pathname.slice('/audio/file/'.length));
        if (!/^[\w.-]+\.wav$/.test(name) || name.includes('..')) {
          sendJson(400, { error: 'BAD_NAME' });
          return;
        }
        const abs = path.join(OUTPUT_DIR, name);
        let stat = null;
        try {
          stat = fs.statSync(abs);
        } catch {}
        if (!stat || !stat.isFile()) {
          sendJson(404, { error: 'NOT_FOUND' });
          return;
        }
        const total = stat.size;
        const range = req.headers.range;
        if (range) {
          const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
          let start = m && m[1] ? parseInt(m[1], 10) : 0;
          let end = m && m[2] ? parseInt(m[2], 10) : total - 1;
          if (!Number.isFinite(start) || start < 0) start = 0;
          if (!Number.isFinite(end) || end >= total) end = total - 1;
          if (start > end) {
            res.writeHead(416, { 'Content-Range': `bytes */${total}` });
            res.end();
            return;
          }
          res.writeHead(206, {
            'Content-Type': 'audio/wav',
            'Content-Length': end - start + 1,
            'Content-Range': `bytes ${start}-${end}/${total}`,
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'no-store',
          });
          fs.createReadStream(abs, { start, end }).pipe(res);
          return;
        }
        res.writeHead(200, {
          'Content-Type': 'audio/wav',
          'Content-Length': total,
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'no-store',
        });
        fs.createReadStream(abs).pipe(res);
        return;
      }
      // 显式取消：不依赖连接断开事件（WKWebView 里可能延后），前端 abort 之前会先打这一枪
      if (pathname === '/article/cancel' && req.method === 'POST') {
        const body = await readJson().catch(() => ({}));
        const target = String(body.messageId || '');
        if (this.articleJob && (!target || this.articleJob.messageId === target)) {
          this.articleJob.aborted = true;
        }
        this.abortSegment();
        sendJson(200, { ok: true });
        return;
      }
      // 整篇朗读：NDJSON 进度流（phase / progress / done / error）
      if (pathname === '/article' && req.method === 'POST') {
        const body = await readJson();

        // 同一时刻只允许一个整篇任务。新任务进来时先让上一个收尾——它的 finally 会卸载
        // Python 进程，如果直接并行，会把新任务正在使用的进程一起 SIGTERM 掉。
        if (this.articleJob) {
          this.articleJob.aborted = true;
          this.abortSegment();
          const deadline = Date.now() + 20000;
          while (this.articleJob && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 120));
          }
          if (this.articleJob) {
            sendJson(409, { ok: false, error: 'BUSY' });
            return;
          }
        }

        const job = { aborted: false, messageId: String(body.messageId || '') };
        this.articleJob = job;

        res.writeHead(200, {
          'Content-Type': 'application/x-ndjson; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Accel-Buffering': 'no',
        });
        const write = (obj) => {
          if (res.writableEnded || res.destroyed) return;
          try {
            res.write(`${JSON.stringify(obj)}\n`);
          } catch {}
        };

        // 前端取消（切走 / 再点一次 / 关窗）→ 打断当前段并卸载模型
        req.on('close', () => {
          if (!res.writableEnded) {
            job.aborted = true;
            this.abortSegment();
          }
        });
        const controller = { get aborted() { return job.aborted; } };

        try {
          const result = await this.synthesizeArticle({
            messageId: body.messageId,
            text: body.text,
            segments: body.segments,
            onEvent: write,
            signal: controller,
          });
          if (!result.ok) write({ t: 'error', ...result });
        } catch (e) {
          write({ t: 'error', error: 'ARTICLE_FAILED', message: e.message });
        } finally {
          this.articleJob = null;
          if (!res.writableEnded) res.end();
        }
        return;
      }
      if (pathname === '/download' && req.method === 'POST') {
        // 立即返回，后台继续下载；进度由 /api/tts/status 轮询获取。
        this.startDownload().catch((err) => {
          console.warn('[TTS] download error:', err.message);
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
      if (pathname === '/open-output-dir' && req.method === 'POST') {
        try {
          fs.mkdirSync(OUTPUT_DIR, { recursive: true });
          spawn('open', [OUTPUT_DIR], { detached: true, stdio: 'ignore' }).unref();
          sendJson(200, { ok: true, path: OUTPUT_DIR });
        } catch (e) {
          sendJson(500, { ok: false, error: e.message });
        }
        return;
      }
      if (pathname === '/open-dir' && req.method === 'POST') {
        try {
          fs.mkdirSync(MODEL_DIR, { recursive: true });
          spawn('open', [MODEL_DIR], { detached: true, stdio: 'ignore' }).unref();
          sendJson(200, { ok: true, path: MODEL_DIR });
        } catch (e) {
          sendJson(500, { ok: false, error: e.message });
        }
        return;
      }
      if (pathname === '/speak' && req.method === 'POST') {
        const body = await readJson();
        const result = await this.speak(body.text, body);
        if (!result.ok) {
          const code = result.error === 'MODEL_MISSING' ? 409 : 500;
          sendJson(code, result);
          return;
        }
        res.writeHead(200, {
          'Content-Type': 'audio/wav',
          'Content-Length': result.wav.length,
          'Cache-Control': 'no-store',
        });
        res.end(result.wav);
        return;
      }
      sendJson(404, { error: 'NOT_FOUND' });
    } catch (e) {
      sendJson(500, { error: 'TTS_API_FAILED', message: e.message });
    }
  }

  init() {
    this.loadConfig();
    // 启动时不拉起模型：每次「整篇朗读」现场加载、生成结束即卸载。
    // 上次运行残留的进程由 App 启动前的 cleanStaleProcessesBeforeLaunch（managedPidFiles）统一清理，
    // 这里只清掉已失效的 PID 文件，并清掉上次遗留在模型目录里的临时碎片。
    const pid = readPid();
    if (!isPidAlive(pid)) clearPid();
    this.cleanTempFiles({ removePartFiles: false });
    // 音频输出目录：不存在就建；索引里指向已删文件的条目顺手清掉。
    try {
      fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    } catch {}
    listAudio();
  }
}

export const ttsService = new TtsService();
