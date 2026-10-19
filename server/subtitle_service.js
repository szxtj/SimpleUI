// 实时双语字幕服务端托管模块（Continuous ASR + SaT SOTA segmentation + Index-Translate）
// 纯端侧离线流水线（与语音输入服务 1236 完全独立）：
//   - 专属存储目录：~/Library/Application Support/SimpleUI/models/subtitles_pipeline/
//   - 第 1 级：davidxifeng/Confucius4-R2T2-gguf (Q8_0) -> r2t2-q8_0.gguf
//             audio.cpp `confucius4_r2t2`（Metal），Longest Stable Prefix 追加式流式识别；
//             audiocpp_server 端口 1250，每条长 live 请求持续接收 PCM。
//   - 第 2 级：IndexTeam/Index-Translate-2B-GGUF Q4_K_M -> llama-server 端口 1249。
//   - 断句：segment-any-text/sat-3l-sm CoreML FP16（240MB），Swift helper 跑 ANE/CPU；
//           XLM-R fast tokenizer 提供 offset mapping，模型概率直接切原文。
//   - 语义端点：Smart Turn v3.2 CoreML FP16（16.8MB），旁路判断“这一轮说完了”，只触发 live 收尾。
//
// 关键契约：
//   - 无 VAD：所有 PCM 都直连 R2T2，不做 RMS/静音门控、不丢帧。
//   - R2T2 的 delta 是 append-only 稳定前缀；done 只在主动 close 时返回未提交尾部。
//   - 不自动重试、不自动重启、不自动重连；任何环失败 -> fatal 并停止链路。
//   - 原文只追加显示；译文只按完整句追加，收尾尾部是唯一允许的“半句”。
//
// 生命周期：App 启动不加载模型；打开字幕窗口 start() 按 ASR -> 翻译 -> CoreML helper 三阶段加载；
// 关闭窗口 stop() 立刻卸载全部模型与子进程。

import http from 'http';
import https from 'https';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawn, execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { startWatchdog } from './watchdog.js';
import { SubtitleError, SubtitleMlHelper } from './subtitles/ml_helper.js';
import { SatSegmenter } from './subtitles/segmenter.js';
import { TranslationEngine } from './subtitles/translation.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const HOME = os.homedir();
const userConfigDir = path.join(HOME, 'Library', 'Application Support', 'SimpleUI');
const CONFIG_FILE = path.join(userConfigDir, 'subtitles_config.json');

// PID 文件（与 ttf_service / asr_service 统一纳入 watchdog 与启动/退出清扫体系）
const ASR_PID_FILE = '/tmp/simpleui_subtitle_audiocpp.pid'; // audiocpp_server (R2T2 流式 ASR, 端口 1250)
const TRANS_PID_FILE = '/tmp/simpleui_subtitle_trans.pid'; // llama-server (Index-Translate, 端口 1249)
const ML_PID_FILE = '/tmp/simpleui_subtitle_ml.pid'; // Swift CoreML helper (SaT / Smart Turn)

// 字幕 ASR 服务（audio.cpp）端口与派生配置文件
const ASR_SERVER_PORT = 1250;
const ASR_SERVER_JSON = path.join(userConfigDir, 'subtitles_asr_server.json');
const ASR_SERVER_MODEL_ID = 'r2t2-asr-stream';

// 专属隔离模型目录（标准内置文件夹）
export const SUBTITLE_MODELS_DIR = path.join(userConfigDir, 'models', 'subtitles_pipeline');

// 官方源与国内高速镜像源定义
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

export const MODEL_SPECS = {
  asr: {
    name: 'Confucius4-R2T2 Q8_0 (audio.cpp 追加式流式识别)',
    shortName: 'Confucius4-R2T2 (GGUF)',
    repo: 'davidxifeng/Confucius4-R2T2-gguf',
    sizeDesc: '2.31 GB',
    expectedBytes: 2477512064,
    files: [
      {
        src: 'r2t2-q8_0.gguf',
        dst: 'r2t2-q8_0.gguf',
        minBytes: 2300 * 1024 * 1024,
        expectedBytes: 2477512064,
        optional: false,
      },
    ],
  },
  translate: {
    name: 'Index-Translate-2B Q4_K_M (专精神经机器翻译)',
    shortName: 'Index-Translate-2B (GGUF)',
    repo: 'IndexTeam/Index-Translate-2B-GGUF',
    sizeDesc: '1.25 GB',
    expectedBytes: Math.round(1251.4 * 1024 * 1024),
    files: [
      {
        src: 'Index-Translate-2B.Q4_K_M.gguf',
        dst: 'index_translate_2b_q4_k_m.gguf',
        minBytes: 1200 * 1024 * 1024,
        expectedBytes: Math.round(1251.4 * 1024 * 1024),
        optional: false,
      },
    ],
  },
  /**
   * SaT-3l-sm (Segment Any Text, SOTA) CoreML FP16 断句模型。
   * 权重与 CoreML 转换均来自 HuggingFace；分词器使用 XLM-R SentencePiece。
   * 该模型目录必须完整下载；Node 侧通过 Swift CoreML helper 调用，跑在 ANE/CPU 上。
   */
  segment: {
    name: 'SaT-3l-sm CoreML (SOTA 智能断句)',
    shortName: 'SaT-3l-sm (CoreML)',
    repo: 'smdesai/SaT',
    sizeDesc: '250 MB',
    expectedBytes: 249999974,
    dstPrefix: 'SaT.mlmodelc',
    files: [
      {
        src: 'SaT.mlmodelc/coremldata.bin',
        dst: 'SaT.mlmodelc/coremldata.bin',
        minBytes: 200,
        expectedBytes: 347,
        optional: false,
      },
      {
        src: 'SaT.mlmodelc/analytics/coremldata.bin',
        dst: 'SaT.mlmodelc/analytics/coremldata.bin',
        minBytes: 100,
        expectedBytes: 241,
        optional: false,
      },
      {
        src: 'SaT.mlmodelc/model.mil',
        dst: 'SaT.mlmodelc/model.mil',
        minBytes: 30000,
        expectedBytes: 39576,
        optional: false,
      },
      {
        src: 'SaT.mlmodelc/metadata.json',
        dst: 'SaT.mlmodelc/metadata.json',
        minBytes: 1000,
        expectedBytes: 2228,
        optional: true,
      },
      {
        src: 'SaT.mlmodelc/weights/weight.bin',
        dst: 'SaT.mlmodelc/weights/weight.bin',
        minBytes: 229 * 1024 * 1024,
        expectedBytes: 240860864,
        optional: false,
      },
      {
        // XLM-R fast tokenizer（含 SentencePiece 词表与 offset mapping）
        src: 'tokenizer.json',
        dst: 'xlmr_tokenizer.json',
        repo: 'FacebookAI/xlm-roberta-base',
        minBytes: 8 * 1024 * 1024,
        expectedBytes: 9096718,
        optional: false,
      },
    ],
  },
  /**
   * Smart Turn v3.2 CoreML FP16 语义端点模型。
   * 只做“这一轮说完了没有”的概率判断；不门控音频、不切句。
   */
  turn: {
    name: 'Smart Turn v3.2 CoreML (语义端点检测)',
    shortName: 'Smart Turn v3.2 (CoreML)',
    repo: 'aufklarer/Smart-Turn-v3.2-CoreML',
    sizeDesc: '16.8 MB',
    expectedBytes: 16775094,
    dstPrefix: 'smart_turn.mlmodelc',
    files: [
      {
        src: 'smart_turn.mlmodelc/coremldata.bin',
        dst: 'smart_turn.mlmodelc/coremldata.bin',
        minBytes: 400,
        expectedBytes: 643,
        optional: false,
      },
      {
        src: 'smart_turn.mlmodelc/analytics/coremldata.bin',
        dst: 'smart_turn.mlmodelc/analytics/coremldata.bin',
        minBytes: 100,
        expectedBytes: 243,
        optional: false,
      },
      {
        src: 'smart_turn.mlmodelc/model.mil',
        dst: 'smart_turn.mlmodelc/model.mil',
        minBytes: 50000,
        expectedBytes: 69968,
        optional: false,
      },
      {
        src: 'smart_turn.mlmodelc/weights/weight.bin',
        dst: 'smart_turn.mlmodelc/weights/weight.bin',
        minBytes: 15 * 1024 * 1024,
        expectedBytes: 16714240,
        optional: false,
      },
    ],
  },
};

export const REQUIRED_MODELS = MODEL_SPECS;

// 面板/下载/状态统一按实际链路顺序：ASR -> SaT 断句 -> 翻译；Smart Turn 为旁路端点，列最后。
export const MODEL_ORDER = ['asr', 'segment', 'translate', 'turn'];

const DEFAULT_CONFIG = {
  enabled: true,
  autoStart: false, // 严格按需启动：仅在打开字幕窗口时加载模型
  // live 流硬上限：超过直接报错，不半句强切
  utteranceMaxMs: 90000,
  // 关闭请求体后等待 done 的硬超时；超时直接 fatal
  utteranceDoneTimeoutMs: 15000,
  // SaT 句界阈值（0~1）；0.5 为官方默认附近，避免在逗号处过切
  segmentThreshold: 0.5,
  segmentLookaheadTokens: 10,
  // Smart Turn 语义端点阈值（提高至 0.62 避免换气停顿误切半句）
  turnThreshold: 0.62,
  sourceLang: 'en',
  targetLang: 'zh',
};

function readPidFile(pidFile) {
  try {
    if (fs.existsSync(pidFile)) {
      const pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);
      if (Number.isInteger(pid) && pid > 0) return pid;
    }
  } catch {}
  return null;
}

function isPidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * 解析标准内置文件夹中的 llama-server 及其动态库目录：
 *   1. App 包内内置目录: Contents/Resources/llama/{bin/llama-server, lib}
 *   2. 开发态项目内置目录: bin/llama/{bin/llama-server, lib}
 *   3. 用户级标准内置目录: ~/Library/Application Support/SimpleUI/runtime/llama/{bin/llama-server, lib}
 */
function resolveLlamaRuntime() {
  const roots = [
    path.resolve(__dirname, '../llama'),
    '/Applications/SimpleUI.app/Contents/Resources/llama',
    path.resolve(__dirname, '../bin/llama'),
    path.join(userConfigDir, 'runtime', 'llama'),
  ];

  for (const root of roots) {
    const binPath = path.join(root, 'bin', 'llama-server');
    if (fs.existsSync(binPath)) {
      const libDir = path.join(root, 'lib');
      return {
        ready: true,
        binPath,
        libDir: fs.existsSync(libDir) ? libDir : path.dirname(binPath),
        bundled: !root.startsWith(userConfigDir),
      };
    }
  }

  const standaloneCandidates = [
    '/Applications/SimpleUI.app/Contents/Resources/bin/llama-server',
    '/opt/homebrew/bin/llama-server',
    '/usr/local/bin/llama-server',
  ];
  for (const binPath of standaloneCandidates) {
    if (fs.existsSync(binPath)) {
      return {
        ready: true,
        binPath,
        libDir: path.resolve(path.dirname(binPath), '../lib'),
        bundled: binPath.startsWith('/Applications/SimpleUI.app'),
      };
    }
  }

  return {
    ready: false,
    binPath: null,
    libDir: path.join(userConfigDir, 'runtime', 'llama', 'lib'),
    bundled: false,
  };
}

function resolveAudiocppRuntime() {
  const roots = [
    path.resolve(__dirname, '../bin/audiocpp'),
    path.resolve(__dirname, '../asr'),
    '/Applications/SimpleUI.app/Contents/Resources/asr',
    path.join(userConfigDir, 'runtime', 'bin', 'audiocpp'),
  ];
  for (const root of roots) {
    const binPath = path.join(root, 'bin', 'audiocpp_server');
    if (fs.existsSync(binPath)) {
      return {
        ready: true,
        binPath,
        runtimeRoot: root,
        bundled: root.includes('.app/Contents/Resources'),
      };
    }
  }
  return { ready: false, binPath: null, runtimeRoot: null, bundled: false };
}

function stripThinkTags(text) {
  if (!text || typeof text !== 'string') return '';
  let out = text.replace(/<think>[\s\S]*?<\/think>/gi, '');
  if (out.includes('</think>')) {
    out = out.split('</think>').pop();
  }
  return out.replace(/^<think>/i, '').trim();
}

/**
 * R2T2 流式 ASR 引擎：托管 audiocpp_server（audio.cpp, Metal）并以「每话语一个 live 请求」的方式驱动。
 *
 * live 端点契约（audio.cpp）：
 *   POST /v1/audio/transcriptions/live?model=r2t2-asr-stream&sample_rate=16000&channels=1&sample_format=s16le&language=English
 *   请求体：chunked 裸 PCM（Int16LE 16kHz mono）
 *   响应：SSE
 *     data: {"type":"transcript.text.delta","delta":"..."}   （追加式增量，可多个）
 *     data: {"type":"transcript.text.done","text":"...整句终稿...","timing":{...}}
 *     data: [DONE]
 */
class SubtitleAsrEngine {
  constructor() {
    this.proc = null;
    this.ready = false;
    this.respawnAttempts = 0;
    this.startingPromise = null;
    this.logStream = null;
    this.lastLogTail = [];
  }

  resolve() {
    return resolveAudiocppRuntime();
  }

  openLogStream() {
    if (this.logStream) return this.logStream;
    try {
      const logFile = path.join(HOME, 'Library', 'Logs', 'simpleui-subtitle-asr.log');
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      this.logStream = fs.createWriteStream(logFile, { flags: 'w' });
    } catch {
      this.logStream = null;
    }
    return this.logStream;
  }

  buildServerJson() {
    const runtime = this.resolve();
    const modelPath = path.join(SUBTITLE_MODELS_DIR, 'r2t2-q8_0.gguf');
    const serverJson = {
      host: '127.0.0.1',
      port: ASR_SERVER_PORT,
      backend: 'metal',
      device: 0,
      threads: 2,
      // 启动时直接将 R2T2 模型加载进 Metal 显存，避免首次 live 请求懒加载卡顿
      lazy_load: false,
      max_loaded_models: 1,
      idle_unload_ms: 0,
      // 关键：关闭 macOS 统一内存的空闲页误判保护（macOS 文件缓存页会导致 host free memory 被低估而报 insufficient_memory）
      min_free_memory_mb: 0,
      busy_timeout_ms: 0,
      ui: false,
      // 长字幕会话：单请求总时限 30 分钟（话语级请求远小于此），单 chunk 上限 8MB
      live_ingest: { total_timeout_ms: 1800000, max_chunk_bytes: 8388608 },
      models: [
        {
          id: ASR_SERVER_MODEL_ID,
          family: 'confucius4_r2t2',
          path: modelPath,
          task: 'asr',
          mode: 'streaming',
          session_options: {
            // R2T2 在单条 live 会话内每次分块都会对 [0, t] 音频做全局峰值归一化并重算编码器特征；
            // 采用 960ms 分块 + unfixed_chunk_num=1 + unfixed_token_num=2 配合 <=9.6s 短会话轮转，
            // 既将首包延迟从 1280ms(640×2) 降至 960ms，又将每秒 Metal GPU 重算开销降低约 45%，彻底消除队列积压。
            'confucius4_r2t2.chunk_size_ms': '960',
            'confucius4_r2t2.unfixed_chunk_num': '1',
            'confucius4_r2t2.unfixed_token_num': '2',
            'confucius4_r2t2.rollback_punctuation': 'false',
            'confucius4_r2t2.max_tokens': '16',
          },
        },
      ],
    };
    if (!fs.existsSync(userConfigDir)) fs.mkdirSync(userConfigDir, { recursive: true });
    fs.writeFileSync(ASR_SERVER_JSON, JSON.stringify(serverJson, null, 2));
    return { serverJsonFile: ASR_SERVER_JSON, modelPath, runtime };
  }

  async checkHealth(port = ASR_SERVER_PORT) {
    return new Promise((resolve) => {
      const req = http.get(`http://127.0.0.1:${port}/health`, { timeout: 1500 }, (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      });
      req.on('error', () => resolve(false));
      req.setTimeout(1500, () => {
        req.destroy();
        resolve(false);
      });
    });
  }

  isAlive() {
    return Boolean(this.proc && !this.proc.killed);
  }

  /**
   * 拉起 audiocpp_server 并完成模型加载与 Metal 计算图预热（带单飞并发锁，杜绝重复拉起抢端口）。
   * 返回 true 表示服务就绪且模型已加载。
   */
  async ensureServer() {
    if (this.isAlive() && this.ready && (await this.checkHealth())) return true;
    if (this.startingPromise) return this.startingPromise;

    this.startingPromise = this._ensureServerInternal().finally(() => {
      this.startingPromise = null;
    });
    return this.startingPromise;
  }

  async _ensureServerInternal() {
    if (this.isAlive() && this.ready && (await this.checkHealth())) return true;

    // 先清理可能残留的旧 1250 进程，确保端口干净（绝不误伤 1236 语音输入服务）
    this.stopServer();
    try {
      execSync('pkill -f "audiocpp_server.*subtitles_asr_server.json"', { stdio: 'ignore' });
    } catch {}

    const { serverJsonFile, runtime } = this.buildServerJson();
    if (!runtime.ready || !runtime.binPath) {
      console.error('[Subtitles] 未找到内置 audiocpp_server 运行时 (audio.cpp)');
      return false;
    }
    const modelPath = path.join(SUBTITLE_MODELS_DIR, 'r2t2-q8_0.gguf');
    if (!fs.existsSync(modelPath)) {
      console.error('[Subtitles] R2T2 模型文件缺失:', modelPath);
      return false;
    }

    console.log('[Subtitles] [1/3] 正在加载 Confucius4-R2T2 流式识别引擎 (audio.cpp · Metal)...');
    const log = this.openLogStream();
    this.lastLogTail = [];
    const proc = spawn(runtime.binPath, ['--config', serverJsonFile], {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: runtime.runtimeRoot || path.dirname(runtime.binPath),
    });
    this.proc = proc;
    this.ready = false;

    const captureLog = (d) => {
      if (log) {
        try {
          log.write(d);
        } catch {}
      }
      for (const line of String(d).split('\n')) {
        const t = line.trim();
        if (!t) continue;
        this.lastLogTail.push(t);
        if (this.lastLogTail.length > 16) this.lastLogTail.shift();
      }
    };
    proc.stdout?.on('data', captureLog);
    proc.stderr?.on('data', captureLog);

    try {
      if (proc.pid) fs.writeFileSync(ASR_PID_FILE, String(proc.pid));
    } catch {}

    let exitedEarly = false;
    proc.on('exit', (code, sig) => {
      exitedEarly = true;
      if (this.proc === proc) {
        this.proc = null;
        this.ready = false;
        try {
          if (fs.existsSync(ASR_PID_FILE)) fs.unlinkSync(ASR_PID_FILE);
        } catch {}
      }
      if (code !== 0 && code !== null) {
        console.error(
          `[Subtitles] audiocpp_server (1250) 异常退出 (code=${code}, sig=${sig}): ${this.lastLogTail.slice(-4).join(' | ')}`
        );
      }
    });

    // 等待 health（lazy_load=false 时模型在启动阶段直接加载进 Metal，给足 60s）
    let healthy = false;
    for (let i = 0; i < 120; i++) {
      if (exitedEarly) break;
      await new Promise((r) => setTimeout(r, 500));
      if (await this.checkHealth()) {
        healthy = true;
        break;
      }
    }
    if (!healthy) {
      console.error(
        '[Subtitles] audiocpp_server 健康检查未通过:',
        this.lastLogTail.slice(-4).join(' | ') || 'timeout'
      );
      this.stopServer();
      return false;
    }

    // 预热：以标准 chunked 编码喂 480ms 静音，预热 Metal 计算图（即便预热超时也不误杀已就绪服务）
    const warmOk = await this.warmup();
    if (!warmOk) {
      console.error('[Subtitles] ❌ R2T2 预热失败，拒绝进入就绪态');
      this.stopServer();
      return false;
    }
    this.ready = true;
    this.respawnAttempts = 0;
    console.log('[Subtitles] ✅ [1/3] Confucius4-R2T2 追加式流式识别引擎已就绪 (端口 1250)');
    return true;
  }

  /**
   * 空话语预热：注意 audio.cpp 的 /v1/audio/transcriptions/live 强制要求
   * Transfer-Encoding: chunked（直接调 req.end(buf) 会发 Content-Length 导致 HTTP 400）！
   */
  async warmup() {
    return new Promise((resolve) => {
      let settled = false;
      const done = (ok) => {
        if (!settled) {
          settled = true;
          resolve(ok);
        }
      };
      try {
        const req = http.request(
          {
            hostname: '127.0.0.1',
            port: ASR_SERVER_PORT,
            path: `/v1/audio/transcriptions/live?model=${ASR_SERVER_MODEL_ID}&sample_rate=16000&channels=1&sample_format=s16le&language=English`,
            method: 'POST',
            headers: {
              'Transfer-Encoding': 'chunked',
              'Content-Type': 'application/octet-stream',
            },
          },
          (res) => {
            if (res.statusCode !== 200) {
              res.resume();
              done(false);
              return;
            }
            res.on('data', () => {});
            res.on('end', () => done(true));
            res.on('error', () => done(false));
          }
        );
        req.on('error', () => done(false));
        req.setTimeout(30000, () => {
          req.destroy();
          done(false);
        });
        const silence = Buffer.alloc(16000 * 2 * 0.48); // 480ms 16kHz s16le 静音块
        req.write(silence);
        req.end();
      } catch {
        done(false);
      }
    });
  }

  stopServer() {
    this.ready = false;
    if (this.proc) {
      try {
        this.proc.kill('SIGKILL');
      } catch {}
      this.proc = null;
    }
    const pid = readPidFile(ASR_PID_FILE);
    if (isPidAlive(pid)) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {}
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
    }
    try {
      if (fs.existsSync(ASR_PID_FILE)) fs.unlinkSync(ASR_PID_FILE);
    } catch {}
    try {
      if (this.logStream) {
        this.logStream.end();
        this.logStream = null;
      }
    } catch {}
  }

  /**
   * 开启一个话语会话（live 请求）。返回 session 对象；调用方通过 session.write(pcm) 喂流，
   * 通过 session.finish() 补 300ms 静音并结束请求体，之后等待 onDone/onError 回调。
   */
  createSession({ language, onDelta, onDone, onError }) {
    const session = {
      state: 'open', // open -> finishing -> done / error
      abandoned: false, // 被主动放弃（暂停/停止/重启）：不再触发任何回调
      text: '',
      req: null,
      finished: false,
      onDelta,
      onDone,
      onError,
    };

    const asrLang = language || 'English';

    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: ASR_SERVER_PORT,
        path: `/v1/audio/transcriptions/live?model=${ASR_SERVER_MODEL_ID}&sample_rate=16000&channels=1&sample_format=s16le&language=${asrLang}`,
        method: 'POST',
        headers: {
          'Transfer-Encoding': 'chunked',
          'Content-Type': 'application/octet-stream',
        },
      },
      (res) => {
        if (res.statusCode !== 200) {
          // 模型未就绪等错误：消费响应体后按失败处理
          res.resume();
          if (!session.abandoned && session.state !== 'done') {
            session.state = 'error';
            session.onError?.(new Error(`live endpoint HTTP ${res.statusCode}`));
          }
          return;
        }
        let buf = '';
        res.on('data', (chunk) => {
          if (session.abandoned) return;
          buf += chunk.toString('utf-8');
          let idx;
          while ((idx = buf.indexOf('\n\n')) !== -1) {
            const rawEvent = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            for (const line of rawEvent.split('\n')) {
              if (!line.startsWith('data: ')) continue;
              const payload = line.slice(6);
              if (payload === '[DONE]') continue;
              try {
                const ev = JSON.parse(payload);
                if (ev.type === 'transcript.text.delta' && typeof ev.delta === 'string') {
                  session.text += ev.delta;
                  session.onDelta?.(ev.delta, session.text);
                } else if (ev.type === 'transcript.text.done') {
                  session.state = 'done';
                  session.onDone?.(typeof ev.text === 'string' ? ev.text : session.text, ev.timing || null);
                }
              } catch {}
            }
          }
        });
        res.on('error', (err) => {
          if (!session.abandoned && session.state !== 'done') {
            session.state = 'error';
            session.onError?.(err);
          }
        });
        res.on('end', () => {
          if (session.abandoned) return;
          if (session.state === 'open' || session.state === 'finishing') {
            // R2T2 协议要求请求体结束后必须收到 transcript.text.done。
            // 缺失 done 属于协议错误，绝不拿 delta 兜底。
            session.state = 'error';
            session.onError?.(new Error('live stream ended without transcript.text.done'));
          }
        });
      }
    );
    session.req = req;

    req.on('error', (err) => {
      if (!session.abandoned && session.state !== 'done') {
        session.state = 'error';
        session.onError?.(err);
      }
    });

    session.write = (pcm) => {
      if (session.state !== 'open' || !req.writable) return false;
      try {
        req.write(pcm);
        return true;
      } catch {
        return false;
      }
    };

    session.finish = () => {
      if (session.finished) return;
      session.finished = true;
      session.state = 'finishing';
      try {
        // 官方已知问题：句尾词需要 ~300ms trailing silence 才会吐出（由 1.0s 缩减至 0.36s，降低收尾 GPU 突发解码开销）
        req.write(Buffer.alloc(Math.floor(16000 * 0.36) * 2));
        req.end();
      } catch {}
    };

    session.abort = () => {
      if (session.state === 'done') return;
      session.abandoned = true;
      session.state = 'error';
      try {
        req.destroy();
      } catch {}
    };

    return session;
  }
}

class SubtitleService {
  constructor() {
    this.config = { ...DEFAULT_CONFIG };
    this.isRunning = false; // 是否处于活动监听态
    this.isPaused = false; // 窗口打开期间用户手动点击暂停
    this.isLoadingModels = false; // 是否正在加载双级模型
    this.modelsLoaded = false; // 两个模型是否全部在内存/显存中就绪
    this.loadingStage = 0; // 0: 正在加载第 1 级 ASR, 1: 正在加载第 2 级翻译, 2: 全部就绪
    this.loadingStepKey = 'idle'; // 'idle' | 'asr' | 'translate' | 'ready' | 'error'
    this.sessionGeneration = 0; // 防止加载途中用户关闭窗口导致异步回写重新拉起模型

    this.sseClients = new Set();
    this.seqId = 1;

    // 运行状态：idle | loading | listening | finishing | paused | error
    this.state = 'idle';
    this.fatalError = null;

    // 后台服务与推理状态
    this.asrEngine = new SubtitleAsrEngine();
    this.transProc = null;
    this.transStartingPromise = null;
    this.watchdogs = new Map();
    this.healthTimer = null;
    this.transAlive = false;

    // CoreML helper + SOTA 断句 + 单句翻译
    this.mlHelper = null;
    this.segmenter = null;
    this.translator = new TranslationEngine({ port: 1249, timeoutMs: 15000 });

    // 连续的 ASR 流状态
    this.asrSession = null;
    this.asrStreamText = ''; // 所有 delta 的精确拼接（用于原文显示 + done 前缀校验）
    this.draft = ''; // 尚未提交给翻译的尾部
    this.sourceText = ''; // 前端原文流快照（最多保留最近 200k 字符）
    this.targetRecords = []; // 前端译文记录（最多 200 条）
    this.pendingFrames = []; // 收尾 waiting done 期间缓存的 PCM
    this.turnRing = []; // 最近 8s PCM Buffer 列表
    this.turnSamples = 0;
    this.lastDeltaAt = 0;
    this.lastGlobalDeltaAt = 0;
    this.lastTurnProbeAt = 0;
    this.turnProbeInFlight = false;
    this.segmentationInFlight = false;
    this.segmentationQueued = false;
    this.sessionStartedAt = 0;
    this.sentencesSinceSession = 0;
    this.closeReason = null;
    this.lastSpeechPcmAt = 0;
    this.lastSilentPreRoll = null;
    this.finishTimer = null;
    this.turnTimer = null;
    this.rotationTimer = null;
    this.asrDoneTimeoutMs = 6000;

    // 串行队列
    this.processingChain = Promise.resolve();
    this.translateChain = Promise.resolve();
    this.translatePending = 0;

    // 内置模型自动测速与下载管理器状态
    this.downloadAbortController = null;
    this.downloadState = {
      active: false,
      phase: 'idle', // 'idle' | 'probing' | 'downloading' | 'cleaning' | 'completed' | 'error' | 'cancelled'
      targetModel: null,
      currentModelKey: null,
      currentModelName: '',
      currentFile: '',
      selectedSource: null, // { id, name, baseUrl, latencyMs, speedKbps }
      probeResults: [],
      downloadedBytes: 0,
      totalBytes: 0,
      progressPercent: 0,
      speedBps: 0,
      etaSeconds: null,
      error: null,
      updatedAt: 0,
    };

    this.clearGeneration = 0;
    this.loadConfig();
    this.cleanLegacyModels({ removePartFiles: false });
  }

  loadConfig() {
    try {
      if (fs.existsSync(CONFIG_FILE)) {
        const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
        const parsed = JSON.parse(raw);
        const merged = { ...DEFAULT_CONFIG, ...parsed, autoStart: false };
        // 旧版本的 12s/4s 配置是“短话语 + 兜底定稿”时代的值；新流水线使用硬上限与 15s done 超时。
        merged.utteranceMaxMs = 90000;
        merged.utteranceDoneTimeoutMs = 15000;
        if (!merged.segmentLookaheadTokens || merged.segmentLookaheadTokens <= 4) {
          merged.segmentLookaheadTokens = 10;
        }
        if (!merged.turnThreshold || merged.turnThreshold <= 0.5) {
          merged.turnThreshold = 0.62;
        }
        delete merged.utteranceEndSilenceMs;
        delete merged.asrChunkMs;
        delete merged.sampleRate;
        this.config = merged;
      }
    } catch (e) {
      console.warn('[Subtitles] 读取配置文件失败，使用默认配置:', e.message);
    }
  }

  saveConfig() {
    try {
      if (!fs.existsSync(userConfigDir)) fs.mkdirSync(userConfigDir, { recursive: true });
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(this.config, null, 2), 'utf-8');
    } catch (e) {
      console.error('[Subtitles] 保存配置文件失败:', e.message);
    }
  }

  /**
   * 启动时与退出时清理任何上次残留的孤儿字幕进程（audiocpp_server 1250 与端口 1249 的 llama-server）
   */
  cleanStaleProcesses() {
    for (const [pidFile, sig] of [
      [ASR_PID_FILE, 'SIGKILL'],
      [TRANS_PID_FILE, 'SIGKILL'],
    ]) {
      const pid = readPidFile(pidFile);
      if (isPidAlive(pid)) {
        try {
          process.kill(pid, 'SIGTERM');
        } catch {}
        try {
          process.kill(pid, sig);
        } catch {}
      }
      try {
        if (fs.existsSync(pidFile)) fs.unlinkSync(pidFile);
      } catch {}
    }

    // CoreML helper 的 PID 文件只做回收、不按 PID 发信号：
    // helper 在 stdin EOF 时会自己退出，残留的 PID 很可能已被无关进程复用，
    // 按 PID 去 kill 反而有误杀风险；真正存活的 helper 由下面的 pkill -x 按名字精确清理。
    try {
      if (fs.existsSync(ML_PID_FILE)) fs.unlinkSync(ML_PID_FILE);
    } catch {}

    // 精确清理同名孤儿进程（不误伤其它端口的服务：按派生配置文件名匹配）
    try {
      execSync('pkill -x "subtitle_stream_asr"', { stdio: 'ignore' }); // 旧架构遗留 daemon
    } catch {}
    try {
      execSync('pkill -f "audiocpp_server.*subtitles_asr_server.json"', { stdio: 'ignore' });
    } catch {}
    try {
      execSync('pkill -f "llama-server.*--port 1249"', { stdio: 'ignore' });
    } catch {}
    try {
      execSync('pkill -x "subtitle_ml_helper"', { stdio: 'ignore' });
    } catch {}
  }

  /**
   * 为三个受管子进程各注册一个「父进程死亡」兜底看门狗（ASR / 翻译 / CoreML helper）。
   * helper 正常情况下会因 stdin EOF 自行退出，但两种情况例外：代理侧丢了 proc 引用的竞态、
   * 或 helper 卡在 CoreML prediction 里收不到 EOF —— 那时只有看门狗能收尸。
   */
  ensureWatchdogs() {
    const specs = [
      { pidFile: ASR_PID_FILE, binaryBasename: 'audiocpp_server' },
      { pidFile: TRANS_PID_FILE, binaryBasename: 'llama-server' },
      { pidFile: ML_PID_FILE, binaryBasename: 'subtitle_ml_helper' },
    ];
    for (const spec of specs) {
      if (this.watchdogs.has(spec.pidFile)) continue;
      try {
        this.watchdogs.set(spec.pidFile, startWatchdog(spec));
      } catch {}
    }
  }

  /**
   * 仅清理字幕模型目录内的下载临时缓存碎片（.part / .tmp / .download），不触碰任何外部或用户正式文件。
   * 另外：新 R2T2 模型就绪后，回收旧架构（Nemotron CoreML，580MB）占用的磁盘空间。
   */
  cleanLegacyModels(opts = { removePartFiles: true }) {
    if (!fs.existsSync(SUBTITLE_MODELS_DIR)) return { freedBytes: 0, removed: [] };
    let freedBytes = 0;
    const removed = [];

    const getSize = (p) => {
      try {
        const st = fs.statSync(p);
        if (st.isFile()) return st.size;
      } catch {}
      return 0;
    };

    const cleanTempRecursive = (dir) => {
      try {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            cleanTempRecursive(full);
          } else if (
            (opts.removePartFiles && entry.name.endsWith('.part')) ||
            entry.name.endsWith('.tmp') ||
            entry.name.endsWith('.download')
          ) {
            freedBytes += getSize(full);
            fs.rmSync(full, { force: true });
            removed.push(path.relative(SUBTITLE_MODELS_DIR, full));
          }
        }
      } catch {}
    };
    cleanTempRecursive(SUBTITLE_MODELS_DIR);

    // 旧架构模型与残留运行时回收：R2T2 GGUF 就绪后才删除旧模型目录与已废弃的 ten_vad.onnx
    const r2t2Path = path.join(SUBTITLE_MODELS_DIR, 'r2t2-q8_0.gguf');
    if (fs.existsSync(r2t2Path)) {
      for (const legacyName of ['nemotron_asr', 'qwen3_asr', 'qwen3_asr_coreml', 'qwen3_aligner', 'ten_vad.onnx']) {
        const legacyTarget = path.join(SUBTITLE_MODELS_DIR, legacyName);
        if (fs.existsSync(legacyTarget)) {
          try {
            freedBytes += getSize(legacyTarget);
            fs.rmSync(legacyTarget, { recursive: true, force: true });
            removed.push(`${legacyName} (旧架构模型残留)`);
          } catch {}
        }
      }
    }
    const legacyRuntimeBin = path.join(userConfigDir, 'runtime', 'bin', 'subtitle_stream_asr');
    if (fs.existsSync(legacyRuntimeBin)) {
      try {
        freedBytes += getSize(legacyRuntimeBin);
        fs.rmSync(legacyRuntimeBin, { force: true });
        removed.push('runtime/bin/subtitle_stream_asr');
      } catch {}
    }

    if (removed.length > 0) {
      console.log(
        `[Subtitles] 🧹 已自动清理旧模型与临时缓存: ${removed.join(', ')}`
      );
    }
    return { freedBytes, removed };
  }

  /**
   * 校验字幕服务内置运行环境（audiocpp_server + llama-server，已彻底移除冗余的 onnxruntime-node 依赖）
   */
  checkRuntimeReadiness() {
    const asrRuntime = resolveAudiocppRuntime();
    const llamaRuntime = resolveLlamaRuntime();
    const mlHelperPath = path.resolve(__dirname, '../bin/subtitle_ml_helper');
    const mlHelperReady = fs.existsSync(mlHelperPath);

    return {
      ready: asrRuntime.ready && llamaRuntime.ready && mlHelperReady,
      asrBinReady: asrRuntime.ready,
      asrBinPath: asrRuntime.binPath,
      llamaBinReady: llamaRuntime.ready,
      llamaBinPath: llamaRuntime.binPath,
      llamaLibDir: llamaRuntime.libDir,
      llamaBundled: llamaRuntime.bundled,
      mlHelperReady,
      mlHelperPath,
    };
  }

  /**
   * 完整校验四级字幕模型/运行时资产的每一个必需文件是否完整就绪
   */
  checkModelsReadiness() {
    const status = {};
    let allReady = true;
    const missing = [];

    for (const key of MODEL_ORDER) {
      const spec = MODEL_SPECS[key];
      const requiredFiles = spec.files.filter((f) => !f.optional);
      let readyFilesCount = 0;
      let totalSizeBytes = 0;

      for (const f of spec.files) {
        const fullPath = path.join(SUBTITLE_MODELS_DIR, f.dst);
        if (fs.existsSync(fullPath)) {
          try {
            const st = fs.statSync(fullPath);
            if (st.isFile()) {
              totalSizeBytes += st.size;
              if (!f.optional && st.size >= f.minBytes) {
                readyFilesCount += 1;
              }
            }
          } catch {}
        }
      }

      const ready = readyFilesCount === requiredFiles.length && requiredFiles.length > 0;
      const primaryRelPath = spec.dstPrefix || spec.files[0]?.dst || '';
      status[key] = {
        key,
        name: spec.name,
        shortName: spec.shortName,
        ready,
        readyFilesCount,
        totalRequiredFiles: requiredFiles.length,
        sizeBytes: totalSizeBytes,
        expectedBytes: spec.expectedBytes,
        sizeMb: (totalSizeBytes / (1024 * 1024)).toFixed(1),
        sizeDesc: spec.sizeDesc,
        path: path.join(SUBTITLE_MODELS_DIR, primaryRelPath),
      };
      if (!ready) {
        allReady = false;
        missing.push(spec.name);
      }
    }

    return { allReady, status, missing };
  }

  // MARK: - 自动双源测速与一键下载管理器

  /**
   * 发起支持自动重定向（301/302/307/308）的 HTTP/HTTPS 请求
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
          timeout: options.timeout || 25000,
        };

        const req = client.request(reqOpts, (res) => {
          if (
            [301, 302, 303, 307, 308].includes(res.statusCode) &&
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
  async probeBestMirror(signal, probeRelative = 'IndexTeam/Index-Translate-2B-GGUF/resolve/main/Index-Translate-2B.Q4_K_M.gguf') {
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
    this.downloadState.probeResults = results.map((r) => ({
      id: r.id,
      name: r.name,
      ok: r.ok,
      latencyMs: Number.isFinite(r.latencyMs) ? r.latencyMs : null,
      speedKbps: r.speedKbps,
    }));

    const okResults = results.filter((r) => r.ok);
    if (okResults.length === 0) return null;
    okResults.sort((a, b) => {
      const scoreA = a.latencyMs / Math.max(1, a.speedKbps);
      const scoreB = b.latencyMs / Math.max(1, b.speedKbps);
      return scoreA - scoreB;
    });
    return okResults[0];
  }

  async startDownload(targetModel = 'all') {
    if (this.downloadState.active) return this.downloadState;
    this.downloadAbortController = new AbortController();
    const signal = this.downloadAbortController.signal;

    this.downloadState = {
      ...this.downloadState,
      active: true,
      phase: 'probing',
      targetModel,
      currentModelKey: null,
      currentModelName: '',
      currentFile: '',
      selectedSource: null,
      downloadedBytes: 0,
      totalBytes: 0,
      progressPercent: 0,
      speedBps: 0,
      etaSeconds: null,
      error: null,
      updatedAt: Date.now(),
    };
    this.broadcastStatus();

    try {
      const specsToDownload =
        targetModel === 'all'
          ? MODEL_ORDER.map((key) => [key, MODEL_SPECS[key]])
          : MODEL_SPECS[targetModel]
          ? [[targetModel, MODEL_SPECS[targetModel]]]
          : [];
      const probeSpec = specsToDownload[0]?.[1] || MODEL_SPECS.translate;
      const probeFile = probeSpec.files.reduce((a, b) =>
        (Number(b.expectedBytes) || 0) > (Number(a.expectedBytes) || 0) ? b : a
      );
      const probeRelative = `${probeFile.repo || probeSpec.repo}/resolve/main/${probeFile.src}`;

      const best = await this.probeBestMirror(signal, probeRelative);
      if (signal.aborted) throw new Error('cancelled');
      if (!best) throw new Error('所有下载源均不可达，请检查网络后重试');
      this.downloadState.selectedSource = {
        id: best.id,
        name: best.name,
        latencyMs: best.latencyMs,
        speedKbps: best.speedKbps,
      };
      this.broadcastStatus();

      const backupSources = DOWNLOAD_SOURCES.filter((s) => s.id !== best.id);
      const candidateSources = [best, ...backupSources];

      for (const [key, spec] of specsToDownload) {
        const check = this.checkModelsReadiness();
        if (check.status[key]?.ready) continue; // 已就绪则跳过

        this.downloadState.currentModelKey = key;
        this.downloadState.currentModelName = spec.name;
        this.downloadState.phase = 'downloading';
        this.broadcastStatus();

        for (const file of spec.files) {
          if (signal.aborted) throw new Error('cancelled');
          const dst = path.join(SUBTITLE_MODELS_DIR, file.dst);
          if (fs.existsSync(dst) && fs.statSync(dst).size >= file.minBytes) continue;

          fs.mkdirSync(path.dirname(dst), { recursive: true });
          const partPath = `${dst}.part`;

          let fileDone = false;
          let lastErr = null;

          for (const srcNode of candidateSources) {
            if (signal.aborted) throw new Error('cancelled');
            const url = `${srcNode.baseUrl}/${file.repo || spec.repo}/resolve/main/${file.src}`;
            let existingBytes = 0;
            try {
              if (fs.existsSync(partPath)) {
                existingBytes = fs.statSync(partPath).size;
              }
            } catch {
              existingBytes = 0;
            }

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
                      reject(new Error(`HTTP ${res.statusCode}`));
                      return;
                    }
                    const isResume = res.statusCode === 206 && existingBytes > 0;
                    const baseOffset = isResume ? existingBytes : 0;
                    const contentLen = Number(res.headers['content-length'] || 0);
                    const total =
                      contentLen > 0 ? baseOffset + contentLen : Number(file.expectedBytes || 0);
                    this.downloadState.totalBytes = total;
                    this.downloadState.downloadedBytes = baseOffset;
                    this.downloadState.currentFile = file.src;
                    this.broadcastStatus();

                    const fileStream = fs.createWriteStream(partPath, {
                      flags: isResume ? 'a' : 'w',
                    });
                    let downloaded = baseOffset;
                    let lastTick = Date.now();
                    let lastBytes = baseOffset;

                    res.on('data', (chunk) => {
                      downloaded += chunk.length;
                      const now = Date.now();
                      if (now - lastTick >= 400) {
                        const dt = (now - lastTick) / 1000;
                        this.downloadState.speedBps = Math.round((downloaded - lastBytes) / dt);
                        lastTick = now;
                        lastBytes = downloaded;
                        this.downloadState.downloadedBytes = downloaded;
                        this.downloadState.progressPercent = total
                          ? Math.min(99, Math.round((downloaded / total) * 100))
                          : 0;
                        this.downloadState.etaSeconds =
                          this.downloadState.speedBps > 0 && total > downloaded
                            ? Math.round((total - downloaded) / this.downloadState.speedBps)
                            : null;
                        this.downloadState.updatedAt = now;
                        this.broadcastStatus();
                      }
                    });
                    res.on('error', (err) => {
                      fileStream.destroy();
                      reject(err);
                    });
                    res.on('end', () => {
                      fileStream.end();
                      fileStream.on('finish', () => {
                        try {
                          const finalSize = fs.statSync(partPath).size;
                          if (file.minBytes && finalSize < file.minBytes) {
                            reject(new Error(`文件未完整下载 (${finalSize} < ${file.minBytes})`));
                            return;
                          }
                          fs.renameSync(partPath, dst);
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
              break;
            } catch (err) {
              lastErr = err;
              if (signal.aborted || err.message === 'cancelled' || err.message === 'Download cancelled') {
                throw new Error('cancelled');
              }
              console.warn(`[Subtitles] 源 ${srcNode.name} 下载中断，尝试切换备用源:`, err.message);
            }
          }

          if (!fileDone) {
            throw lastErr || new Error(`下载失败: ${file.src}`);
          }
        }
      }

      this.downloadState.phase = 'cleaning';
      this.broadcastStatus();
      this.cleanLegacyModels({ removePartFiles: true });
      this.downloadState.phase = 'completed';
      this.downloadState.active = false;
      this.downloadState.progressPercent = 100;
      this.downloadState.updatedAt = Date.now();
      this.broadcastStatus();
    } catch (err) {
      const cancelled = signal.aborted || err.message === 'cancelled' || err.message === 'Download cancelled';
      this.downloadState.phase = cancelled ? 'cancelled' : 'error';
      this.downloadState.error = cancelled ? null : err.message || '下载失败';
      this.downloadState.active = false;
      this.downloadState.updatedAt = Date.now();
      this.broadcastStatus();
    }
    return this.downloadState;
  }

  cancelDownload() {
    if (this.downloadAbortController) {
      this.downloadAbortController.abort();
      this.downloadAbortController = null;
    }
    this.downloadState.phase = 'cancelled';
    this.downloadState.active = false;
    return this.downloadState;
  }

  // MARK: - 服务生命周期

  /**
   * 随代理服务 (server/proxy.js) 启动时初始化：清扫上次残留的字幕子进程并注册看门狗（不自动加载模型）
   */
  init() {
    this.cleanStaleProcesses();
    this.ensureWatchdogs();
    console.log('[Subtitles] 实时英译中流式字幕服务已注册（按需启动模式：窗口打开时加载，窗口关闭时立刻卸载）');
  }

  /**
   * 彻底清空当前会话的字幕历史与上下文缓存（在每次新开或关闭字幕窗口时调用）
   */
  resetSessionHistory({ broadcastEvent = true } = {}) {
    this.clearGeneration = (this.clearGeneration || 0) + 1;
    this.translatePending = 0;
    this.sourceText = '';
    this.targetRecords = [];
    this.asrStreamText = '';
    this.draft = '';
    this.pendingFrames = [];
    this.turnRing = [];
    this.turnSamples = 0;
    this.lastDeltaAt = 0;
    this.lastGlobalDeltaAt = 0;
    this.lastTurnProbeAt = 0;
    this.turnProbeInFlight = false;
    this.segmentationInFlight = false;
    this.segmentationQueued = false;
    this.sessionStartedAt = 0;
    this.closeReason = null;
    this.lastSpeechPcmAt = 0;
    this.lastSilentPreRoll = null;
    this.clearSessionTimers();
    this.abortAsrSession();
    if (broadcastEvent) this.broadcast('clear', { cleared: true });
  }

  clearSessionTimers() {
    if (this.finishTimer) {
      clearTimeout(this.finishTimer);
      this.finishTimer = null;
    }
    if (this.turnTimer) {
      clearInterval(this.turnTimer);
      this.turnTimer = null;
    }
    if (this.rotationTimer) {
      clearInterval(this.rotationTimer);
      this.rotationTimer = null;
    }
  }

  startSessionTimers() {
    this.clearSessionTimers();
    this.turnTimer = setInterval(() => {
      this.maybeProbeTurn().catch((err) => this.fail(err));
    }, 400);
    this.rotationTimer = setInterval(() => {
      this.checkStreamRotation();
    }, 400);
  }

  fail(err) {
    if (this.state === 'error') return;
    const e =
      err instanceof SubtitleError
        ? err
        : new SubtitleError('lifecycle', 'UNEXPECTED', err?.message || String(err));
    this.state = 'error';
    this.fatalError = {
      stage: e.stage,
      code: e.code,
      message: e.message,
      detail: e.detail ?? null,
    };
    this.isRunning = false;
    this.isPaused = false;
    this.modelsLoaded = false;
    this.isLoadingModels = false;
    this.loadingStepKey = 'error';
    this.clearSessionTimers();
    this.abortAsrSession();
    console.error(`[Subtitles] ❌ FATAL ${e.stage}/${e.code}: ${e.message}`);
    this.broadcast('fatal', this.fatalError);
    this.broadcastStatus();
  }

  /**
   * 打开字幕窗口：加载 ASR、翻译、CoreML helper（SaT + Smart Turn）。
   */
  async start() {
    if (this.state === 'loading') {
      this.broadcastStatus();
      return true;
    }
    if (this.modelsLoaded && (this.state === 'listening' || this.state === 'finishing')) {
      this.broadcastStatus();
      return true;
    }
    if (this.modelsLoaded && this.state === 'paused') {
      this.resume();
      return true;
    }
    this.resetSessionHistory({ broadcastEvent: true });

    const check = this.checkModelsReadiness();
    const runtime = this.checkRuntimeReadiness();
    if (!check.allReady) {
      this.state = 'idle';
      this.modelsLoaded = false;
      this.isRunning = false;
      this.isLoadingModels = false;
      this.loadingStage = 0;
      this.loadingStepKey = 'error';
      this.fatalError = null;
      this.broadcastStatus();
      return false;
    }
    if (!runtime.ready) {
      this.fail(
        new SubtitleError(
          'lifecycle',
          'RUNTIME_NOT_READY',
          '字幕运行环境缺失（audiocpp_server / llama-server / CoreML helper）',
          runtime
        )
      );
      return false;
    }

    this.state = 'loading';
    this.fatalError = null;
    this.isPaused = false;
    this.isRunning = false;
    this.modelsLoaded = false;
    this.isLoadingModels = true;
    this.loadingStage = 0;
    this.loadingStepKey = 'asr';
    this.broadcastStatus();

    const myGen = ++this.sessionGeneration;
    const ok = await this.ensureServersRunning(myGen);
    if (myGen !== this.sessionGeneration) {
      this.stopServers();
      return false;
    }
    if (!ok) {
      this.stopServers();
      this.fail(
        new SubtitleError('lifecycle', 'START_FAILED', '字幕模型或 CoreML helper 加载失败')
      );
      return false;
    }

    this.modelsLoaded = true;
    this.isLoadingModels = false;
    this.isRunning = true;
    this.isPaused = false;
    this.state = 'listening';
    this.loadingStage = 3;
    this.loadingStepKey = 'ready';
    this.startHealthMonitor();
    this.startSessionTimers();
    this.openAsrSession();
    this.broadcastStatus();
    console.log('[Subtitles] ✅ R2T2 + SaT + Index-Translate + Smart Turn 已全部就绪');
    return true;
  }

  stop() {
    this.sessionGeneration += 1;
    this.state = 'idle';
    this.fatalError = null;
    this.isRunning = false;
    this.isPaused = false;
    this.isLoadingModels = false;
    this.modelsLoaded = false;
    this.loadingStage = 0;
    this.loadingStepKey = 'idle';
    this.stopHealthMonitor();
    this.resetSessionHistory({ broadcastEvent: true });
    this.stopServers();
    console.log('[Subtitles] ⏹ 字幕窗口已关闭，模型与子进程已全部停止');
    this.broadcastStatus();
  }

  pause() {
    if (this.state !== 'listening' && this.state !== 'finishing') return;
    this.state = 'paused';
    this.isRunning = false;
    this.isPaused = true;
    this.clearSessionTimers();
    this.abortAsrSession();
    this.broadcastStatus();
  }

  resume() {
    if (this.state !== 'paused') return;
    if (!this.modelsLoaded) {
      this.fail(new SubtitleError('lifecycle', 'MODELS_NOT_LOADED', '模型未加载，不能继续'));
      return;
    }
    this.state = 'listening';
    this.isRunning = true;
    this.isPaused = false;
    this.startSessionTimers();
    this.openAsrSession();
    this.broadcastStatus();
  }

  stopServers() {
    this.clearSessionTimers();
    this.abortAsrSession();
    if (this.mlHelper) {
      try {
        this.mlHelper.close();
      } catch {}
      this.mlHelper = null;
    }
    this.segmenter = null;
    this.asrEngine.stopServer();
    if (this.transProc) {
      try {
        this.transProc.kill('SIGKILL');
      } catch {}
      this.transProc = null;
    }
    this.transAlive = false;
    this.transStartingPromise = null;
    try {
      if (fs.existsSync(ML_PID_FILE)) fs.unlinkSync(ML_PID_FILE);
    } catch {}
    this.cleanStaleProcesses();
  }

  async shutdownSync() {
    this.cancelDownload();
    this.sessionGeneration += 1;
    this.state = 'idle';
    this.modelsLoaded = false;
    this.stopHealthMonitor();
    this.stopServers();
  }

  async shutdownForce() {
    this.cancelDownload();
    this.stopHealthMonitor();
    this.stopServers();
  }

  async ensureMlHelper() {
    if (this.mlHelper?.ready) return true;
    if (this.mlHelper) {
      try {
        this.mlHelper.close();
      } catch {}
      this.mlHelper = null;
      this.segmenter = null;
    }
    const runtime = this.checkRuntimeReadiness();
    if (!runtime.mlHelperReady) {
      throw new SubtitleError(
        'segmentation',
        'ML_HELPER_MISSING',
        `CoreML helper 不存在: ${runtime.mlHelperPath}`
      );
    }
    console.log('[Subtitles] [2/3] 正在加载 CoreML helper（SaT 断句 + Smart Turn 端点）...');
    const helper = new SubtitleMlHelper({
      helperPath: runtime.mlHelperPath,
      modelsDir: SUBTITLE_MODELS_DIR,
      onFatal: (err) => this.fail(err),
    });
    await helper.start();
    try {
      if (helper.proc?.pid) fs.writeFileSync(ML_PID_FILE, String(helper.proc.pid));
    } catch {}
    const segmenter = new SatSegmenter({
      tokenizerPath: path.join(SUBTITLE_MODELS_DIR, 'xlmr_tokenizer.json'),
      helper,
      threshold: this.config.segmentThreshold ?? 0.5,
      lookaheadTokens: this.config.segmentLookaheadTokens ?? 10,
    });
    await segmenter.init();
    this.mlHelper = helper;
    this.segmenter = segmenter;
    return true;
  }

  checkHealth(port) {
    return new Promise((resolve) => {
      const req = http.get(`http://127.0.0.1:${port}/health`, { timeout: 1000 }, (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      });
      req.on('error', () => resolve(false));
      req.setTimeout(1000, () => {
        req.destroy();
        resolve(false);
      });
    });
  }

  async ensureTransServer() {
    if (this.transProc && !this.transProc.killed && (await this.checkHealth(1249))) {
      this.transAlive = true;
      return true;
    }
    if (this.transStartingPromise) return this.transStartingPromise;
    this.transStartingPromise = this._ensureTransServerInternal().finally(() => {
      this.transStartingPromise = null;
    });
    return this.transStartingPromise;
  }

  async _ensureTransServerInternal() {
    let transAlive = await this.checkHealth(1249);
    if (transAlive && !this.transProc) {
      this.transAlive = true;
      return true;
    }
    if (!transAlive && !this.transProc) {
      try {
        execSync('pkill -f "llama-server.*--port 1249"', { stdio: 'ignore' });
      } catch {}
      const llamaRuntime = resolveLlamaRuntime();
      if (!llamaRuntime.ready || !llamaRuntime.binPath) {
        console.error('[Subtitles] 未找到内置 llama-server 运行时');
        return false;
      }
      const fallbackLibDir = path.join(userConfigDir, 'runtime', 'llama', 'lib');
      const dyldPath = [llamaRuntime.libDir, fallbackLibDir, process.env.DYLD_LIBRARY_PATH]
        .filter(Boolean)
        .join(':');
      const transModel = path.join(SUBTITLE_MODELS_DIR, 'index_translate_2b_q4_k_m.gguf');
      console.log('[Subtitles] [3/3] 正在加载 Index-Translate-2B Metal 翻译服务 (端口 1249)...');
      const proc = spawn(
        llamaRuntime.binPath,
        [
          '-m',
          transModel,
          '--host',
          '127.0.0.1',
          '--port',
          '1249',
          '-ngl',
          '99',
          '-fa',
          'on',
          '-np',
          '1',
          '-c',
          '1024',
          '--cache-reuse',
          '64',
          '--jinja',
          '--reasoning',
          'off',
        ],
        {
          stdio: ['ignore', 'pipe', 'pipe'],
          env: {
            ...process.env,
            DYLD_LIBRARY_PATH: dyldPath,
            DYLD_FALLBACK_LIBRARY_PATH: dyldPath,
          },
        }
      );
      this.transProc = proc;
      let logStream = null;
      try {
        const logPath = path.join(HOME, 'Library', 'Logs', 'simpleui-subtitle-trans.log');
        fs.mkdirSync(path.dirname(logPath), { recursive: true });
        logStream = fs.createWriteStream(logPath, { flags: 'w' });
      } catch {}
      const capture = (d) => {
        try {
          logStream?.write(d);
        } catch {}
      };
      proc.stdout?.on('data', capture);
      proc.stderr?.on('data', capture);
      try {
        if (proc.pid) fs.writeFileSync(TRANS_PID_FILE, String(proc.pid));
      } catch {}
      let exitedEarly = false;
      proc.on('exit', () => {
        exitedEarly = true;
        if (this.transProc === proc) {
          this.transProc = null;
          this.transAlive = false;
          try {
            if (fs.existsSync(TRANS_PID_FILE)) fs.unlinkSync(TRANS_PID_FILE);
          } catch {}
        }
      });
      for (let i = 0; i < 120; i++) {
        if (exitedEarly) break;
        await new Promise((r) => setTimeout(r, 300));
        if (await this.checkHealth(1249)) {
          transAlive = true;
          break;
        }
      }
      if (!transAlive) {
        try {
          proc.kill('SIGKILL');
        } catch {}
        this.transProc = null;
        return false;
      }
    }
    this.transAlive = transAlive;
    return transAlive;
  }

  async ensureServersRunning(expectedGen = this.sessionGeneration) {
    const check = this.checkModelsReadiness();
    if (!check.allReady) return false;

    this.ensureWatchdogs();

    this.loadingStage = 0;
    this.loadingStepKey = 'asr';
    this.broadcastStatus();
    const asrOk = await this.asrEngine.ensureServer();
    if (!asrOk || expectedGen !== this.sessionGeneration) return false;

    this.loadingStage = 1;
    this.loadingStepKey = 'ml';
    this.broadcastStatus();
    try {
      await this.ensureMlHelper();
    } catch (err) {
      this.fail(err);
      return false;
    }
    if (expectedGen !== this.sessionGeneration) return false;

    this.loadingStage = 2;
    this.loadingStepKey = 'translate';
    this.broadcastStatus();
    const transOk = await this.ensureTransServer();
    if (!transOk || expectedGen !== this.sessionGeneration) return false;
    return true;
  }

  startHealthMonitor() {
    if (this.healthTimer) return;
    this.healthTimer = setInterval(() => {
      this.healthCheckLoop().catch((err) => this.fail(err));
    }, 5000);
  }

  stopHealthMonitor() {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
  }

  async healthCheckLoop() {
    if (!this.modelsLoaded || (this.state !== 'listening' && this.state !== 'finishing')) return;
    if (!(await this.checkHealth(1249))) {
      this.fail(new SubtitleError('translation', 'SERVICE_LOST', '翻译服务 (1249) 掉线'));
      return;
    }
    if (!this.asrEngine.isAlive() || !(await this.asrEngine.checkHealth())) {
      this.fail(new SubtitleError('asr', 'SERVICE_LOST', '流式识别服务 (1250) 掉线'));
      return;
    }
    if (!this.mlHelper?.ready) {
      this.fail(new SubtitleError('segmentation', 'SERVICE_LOST', 'CoreML helper 掉线'));
    }
  }

  broadcast(eventName, data) {
    const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of this.sseClients) {
      try {
        client.write(payload);
      } catch {
        this.sseClients.delete(client);
      }
    }
  }

  getFullStatusPayload() {
    const check = this.checkModelsReadiness();
    const runtime = this.checkRuntimeReadiness();
    return {
      port: 1249,
      asrPort: ASR_SERVER_PORT,
      running: this.isRunning,
      paused: this.isPaused,
      loading: this.isLoadingModels,
      modelsLoaded: this.modelsLoaded,
      loadingStage: this.loadingStage,
      loadingStepKey: this.loadingStepKey,
      allReady: check.allReady && runtime.ready,
      modelsReady: check.allReady,
      runtimeReady: runtime.ready,
      runtimeStatus: runtime,
      missingModels: check.missing,
      modelsStatus: check.status,
      downloadState: this.downloadState,
      storageDir: SUBTITLE_MODELS_DIR,
      sourceLang: this.config.sourceLang,
      targetLang: this.config.targetLang,
      config: this.config,
      clientCount: this.sseClients.size,
      state: this.state,
      fatalError: this.fatalError,
      mlReady: Boolean(this.mlHelper?.ready),
      targetCount: this.targetRecords.length,
      sourceLength: this.sourceText.length,
    };
  }

  broadcastStatus() {
    this.broadcast('status', this.getFullStatusPayload());
  }

  broadcastSnapshot() {
    this.broadcast('snapshot', {
      status: this.getFullStatusPayload(),
      sourceText: this.sourceText,
      targetRecords: this.targetRecords,
    });
  }

  // MARK: - 连续 ASR / SaT 断句 / 单句翻译

  openAsrSession() {
    if (this.asrSession || !this.isRunning || !this.modelsLoaded) return;
    if (this.state !== 'listening') return;
    // 每次 live 请求是独立 ASR 流：prefix 校验只针对本条流；未成句的 this.draft 跨会话保留拼接，杜绝半句强切。
    this.asrStreamText = '';
    this.sentencesSinceSession = 0;
    this.lastDeltaAt = 0;
    this.closeReason = null;
    const asrLang = this.config.sourceLang === 'zh' ? 'Chinese' : 'English';
    const session = this.asrEngine.createSession({
      language: asrLang,
      onDelta: (delta) => this.onAsrDelta(delta, session),
      onDone: (finalText) => {
        this.handleAsrDone(finalText, session).catch((err) => this.fail(err));
      },
      onError: (err) =>
        this.fail(new SubtitleError('asr', 'ASR_STREAM_ERROR', err?.message || String(err))),
    });
    this.asrSession = session;
    this.sessionStartedAt = Date.now();
  }

  appendToDraftAndSource(chunk) {
    if (!chunk) return;
    let piece = chunk;
    // 英文模式下自动保持词间与标点后空格，防止出现 post.By、sheet.This、optionShe'd 等粘连问题
    if (this.config.sourceLang === 'en') {
      const prevContext = this.draft || this.sourceText;
      if (
        prevContext.length > 0 &&
        !/\s$/.test(prevContext) &&
        !/^[\s.,?!;:')]/.test(piece)
      ) {
        piece = ' ' + piece;
      }
    }
    this.draft += piece;
    this.appendSourceDelta(piece);
  }

  onAsrDelta(delta, session) {
    if (session !== this.asrSession || !delta) return;
    const now = Date.now();
    this.appendToDraftAndSource(delta);
    this.asrStreamText += delta;
    this.lastDeltaAt = now;
    this.lastGlobalDeltaAt = now;
    this.scheduleSegmentation();
  }

  appendSourceDelta(text) {
    this.sourceText += text;
    if (this.sourceText.length > 200000) {
      this.sourceText = this.sourceText.slice(-200000);
    }
    this.broadcast('source_delta', { text });
  }

  scheduleSegmentation() {
    if (this.segmentationInFlight) {
      this.segmentationQueued = true;
      return;
    }
    this.segmentationInFlight = true;
    (async () => {
      do {
        this.segmentationQueued = false;
        await this.runSegmentation();
      } while (this.segmentationQueued);
    })()
      .catch((err) => this.fail(err))
      .finally(() => {
        this.segmentationInFlight = false;
      });
  }

  async runSegmentation() {
    if (!this.segmenter || !this.draft.trim()) return;
    if (this.state !== 'listening' && this.state !== 'finishing') return;
    const { sentences, consumed } = await this.segmenter.split(this.draft, { final: false });
    if (consumed > 0) this.draft = this.draft.slice(consumed);
    for (const sentence of sentences) {
      this.commitSentence(sentence);
    }
    // 断句模型断出句子后及时轮转会话：R2T2 是从首个声音累积计算到最新声音，
    // 必须在断出 2 句（或 1 句且流已持续 >= 5.2s）后立即轮转，防止长音频累积导致 GPU 显存与算力爆炸
    if (this.state === 'listening' && this.asrSession && sentences.length > 0) {
      const elapsed = this.sessionStartedAt ? Date.now() - this.sessionStartedAt : 0;
      if (this.sentencesSinceSession >= 2 || (this.sentencesSinceSession >= 1 && elapsed >= 5200)) {
        this.closeAsrSession('sentences');
      }
    }
  }

  async flushRemainingDraft() {
    if (!this.segmenter || !this.draft.trim()) return;
    const currentDraft = this.draft;
    this.draft = '';
    this.lastGlobalDeltaAt = 0;
    const { sentences } = await this.segmenter.split(currentDraft, { final: true });
    for (const sentence of sentences) {
      this.commitSentence(sentence);
    }
  }

  commitSentence(sentence) {
    const text = String(sentence || '').trim();
    if (!text) return;
    const record = {
      id: `sub_${Date.now()}_${this.seqId++}`,
      source_text: text,
      target_text: '',
      status: 'pending',
      source_lang: this.config.sourceLang,
      target_lang: this.config.targetLang,
      createdAt: Date.now(),
    };
    this.targetRecords.push(record);
    this.sentencesSinceSession += 1;
    if (this.targetRecords.length > 200) this.targetRecords.shift();
    this.broadcast('commit', { record });
    this.enqueueTranslation(record);
  }

  enqueueTranslation(record) {
    const myClearGen = this.clearGeneration;
    const mySessionGen = this.sessionGeneration;
    this.translatePending += 1;
    if (this.translatePending > 16) {
      this.fail(new SubtitleError('translation', 'TRANSLATION_BACKLOG', '翻译队列积压超过 16 句'));
      return;
    }
    this.translateChain = this.translateChain
      .then(async () => {
        this.translatePending = Math.max(0, this.translatePending - 1);
        if (
          myClearGen !== this.clearGeneration ||
          mySessionGen !== this.sessionGeneration ||
          !this.modelsLoaded
        ) {
          return;
        }
        try {
          const target = await this.translator.translate(
            record.source_text,
            this.config.sourceLang,
            this.config.targetLang
          );
          if (
            myClearGen !== this.clearGeneration ||
            mySessionGen !== this.sessionGeneration ||
            !this.modelsLoaded
          ) {
            return;
          }
          record.target_text = target;
          record.status = 'finalized';
          this.broadcast('translation', { record });
        } catch (err) {
          if (
            myClearGen !== this.clearGeneration ||
            mySessionGen !== this.sessionGeneration ||
            !this.modelsLoaded
          ) {
            return; // stop/clear/target change 导致的中断不是错误
          }
          this.fail(err);
        }
      })
      .catch((err) => {
        if (
          myClearGen !== this.clearGeneration ||
          mySessionGen !== this.sessionGeneration ||
          !this.modelsLoaded
        ) {
          return;
        }
        this.fail(err);
      });
  }

  closeAsrSession(reason) {
    if (!this.asrSession || this.state !== 'listening') return;
    const closingSession = this.asrSession;
    this.state = 'finishing';
    this.closeReason = reason;
    console.log(`[Subtitles] 收尾 live 流 (${reason})`);
    closingSession.finish();
    if (this.finishTimer) clearTimeout(this.finishTimer);
    // 若底层 audiocpp_server 因瞬时负载未在 6s 内返回 done，平滑降级回收当前流并开启新流，绝不抛出 ASR_DONE_TIMEOUT 杀死字幕窗口
    this.finishTimer = setTimeout(() => {
      this.handleAsrDoneTimeout(closingSession, reason).catch((err) => this.fail(err));
    }, 6000);
  }

  async handleAsrDoneTimeout(session, reason) {
    if (session !== this.asrSession) return;
    this.finishTimer = null;
    console.warn(`[Subtitles] ⚠️ live 流收尾超时 (${reason})，平滑回收已识别前缀并轮转新会话`);
    try {
      session.abort();
    } catch {}
    await this.finalizeSessionTransition(reason);
  }

  extractFinalExtra(streamText, finalText) {
    const final = String(finalText || '');
    if (!final) return '';
    if (final.startsWith(streamText)) {
      return final.slice(streamText.length);
    }
    // 若 final_flush 对末尾标点做了规范化微调，按最大公共前缀定位新增尾部，避免因单字符标点差异触发崩溃
    let common = 0;
    const maxLen = Math.min(streamText.length, final.length);
    while (common < maxLen && streamText[common] === final[common]) {
      common += 1;
    }
    if (common >= streamText.length - 3) {
      return final.slice(streamText.length);
    }
    return '';
  }

  async handleAsrDone(finalText, session) {
    if (session !== this.asrSession) return;
    if (this.finishTimer) {
      clearTimeout(this.finishTimer);
      this.finishTimer = null;
    }
    const reason = this.closeReason || 'rotate';
    const extra = this.extractFinalExtra(this.asrStreamText, finalText);
    if (extra) {
      const now = Date.now();
      this.appendToDraftAndSource(extra);
      this.asrStreamText += extra;
      this.lastDeltaAt = now;
      this.lastGlobalDeltaAt = now;
    }
    await this.finalizeSessionTransition(reason);
  }

  async finalizeSessionTransition(reason) {
    this.closeReason = null;
    if (this.segmenter && this.draft.trim()) {
      const trimmedDraft = this.draft.trim();
      // 仅在长静音收尾 (idle)、草稿已带句末终结标点、或草稿累积过长时才允许 final=true 落盘尾部；
      // 常规轮转 (rotate / sentences / 换气 turn) 只提取已确认的完整句，剩余半句留在 this.draft 中与下一会话无缝拼接。
      const hasTerminalPunct = /[.?!。？！…][”"'’）)\]]*$/.test(trimmedDraft);
      const forceFinal = reason === 'idle' || hasTerminalPunct || trimmedDraft.length >= 220;
      const { sentences, consumed } = await this.segmenter.split(this.draft, { final: forceFinal });
      if (forceFinal) {
        this.draft = '';
        this.lastGlobalDeltaAt = 0;
      } else if (consumed > 0) {
        this.draft = this.draft.slice(consumed);
      }
      for (const sentence of sentences) this.commitSentence(sentence);
    }
    this.asrStreamText = '';
    this.asrSession = null;
    this.state = 'listening';
    this.sessionStartedAt = 0;
    this.lastDeltaAt = 0;

    const buffered = this.pendingFrames;
    this.pendingFrames = [];
    const recentlyActive = this.lastSpeechPcmAt && Date.now() - this.lastSpeechPcmAt <= 1800;
    if (buffered.length > 0 || recentlyActive) {
      this.openAsrSession();
      for (const buf of buffered) {
        this.asrSession?.write(buf);
      }
    }
    this.broadcastStatus();
  }

  abortAsrSession() {
    if (this.finishTimer) {
      clearTimeout(this.finishTimer);
      this.finishTimer = null;
    }
    const session = this.asrSession;
    this.asrSession = null;
    this.asrStreamText = '';
    this.draft = '';
    this.closeReason = null;
    this.lastDeltaAt = 0;
    this.lastGlobalDeltaAt = 0;
    this.lastSpeechPcmAt = 0;
    this.lastSilentPreRoll = null;
    if (session) {
      try {
        session.abort();
      } catch {}
    }
    this.pendingFrames = [];
  }

  enqueueAudioFrame(rawBuffer, format = 'pcm') {
    const task = this.processingChain.then(() =>
      this.processAudioFrameInternal(rawBuffer, format).catch((err) => {
        this.fail(
          err instanceof SubtitleError
            ? err
            : new SubtitleError('capture', 'FEED_FAILED', err?.message || String(err))
        );
        return { ok: false, error: err.message };
      })
    );
    this.processingChain = task.catch(() => {});
    return task;
  }

  isFrameSilent(pcmBuffer) {
    // Int16LE 峰值检测：阈值 80 (~ -52 dBFS) 远低于轻声细语，仅过滤纯数字静音/暂停态，杜绝静音期 GPU 空转
    const sampleCount = pcmBuffer.length >> 1;
    if (sampleCount === 0) return true;
    const step = sampleCount > 512 ? 4 : 1;
    for (let i = 0; i < sampleCount; i += step) {
      const val = pcmBuffer.readInt16LE(i << 1);
      if (val >= 80 || val <= -80) return false;
    }
    return true;
  }

  async processAudioFrameInternal(rawBuffer, format = 'pcm') {
    if (!this.isRunning || !this.modelsLoaded) {
      return { ok: false, reason: 'not_running' };
    }
    let pcmBuffer = rawBuffer;
    if (format === 'wav' || (rawBuffer.length > 44 && rawBuffer.toString('ascii', 0, 4) === 'RIFF')) {
      pcmBuffer = rawBuffer.subarray(44);
    }
    if (!pcmBuffer.length) return { ok: false, reason: 'empty' };
    if (pcmBuffer.length % 2 !== 0) {
      throw new SubtitleError('capture', 'PCM_ODD_BYTES', 'PCM 字节数不是偶数');
    }

    const now = Date.now();
    const silent = this.isFrameSilent(pcmBuffer);
    if (!silent) {
      this.lastSpeechPcmAt = now;
    }

    // Smart Turn 环形缓冲：只保留最近 8s。
    this.turnRing.push(pcmBuffer);
    this.turnSamples += pcmBuffer.length / 2;
    while (this.turnSamples > 128000 && this.turnRing.length > 0) {
      const head = this.turnRing[0];
      const headSamples = head.length / 2;
      if (this.turnSamples - headSamples >= 128000) {
        this.turnRing.shift();
        this.turnSamples -= headSamples;
      } else {
        break;
      }
    }

    // 连续纯静音超过 1.8s 时进入静音休眠门控：若当前会话已有识别文本则触发收尾，否则缓存 1 帧 pre-roll 并暂停向 Metal 喂静音帧
    const silenceDurationMs = this.lastSpeechPcmAt ? now - this.lastSpeechPcmAt : Infinity;
    if (silent && silenceDurationMs > 1800) {
      this.lastSilentPreRoll = pcmBuffer;
      if (this.state === 'listening' && this.asrSession && this.asrStreamText.trim()) {
        this.closeAsrSession('idle');
      }
      return { ok: true, gated: true };
    }

    if (this.state === 'finishing') {
      this.pendingFrames.push(pcmBuffer);
      if (this.pendingFrames.length > 128) {
        throw new SubtitleError('capture', 'PENDING_FRAME_OVERFLOW', '收尾期间缓冲音频溢出');
      }
      return { ok: true };
    }
    if (!this.asrSession) {
      this.openAsrSession();
      if (this.lastSilentPreRoll && this.asrSession) {
        this.asrSession.write(this.lastSilentPreRoll);
        this.lastSilentPreRoll = null;
      }
    }
    if (!this.asrSession) {
      throw new SubtitleError('asr', 'ASR_SESSION_MISSING', 'ASR live 会话未建立');
    }
    if (!this.asrSession.write(pcmBuffer)) {
      throw new SubtitleError('asr', 'ASR_WRITE_FAILED', '写入 R2T2 live 请求失败');
    }
    return { ok: true };
  }

  getTurnPcm() {
    let merged = Buffer.concat(this.turnRing);
    if (merged.length > 128000 * 2) merged = merged.subarray(merged.length - 128000 * 2);
    if (merged.length < 128000 * 2) {
      merged = Buffer.concat([Buffer.alloc(128000 * 2 - merged.length), merged]);
    }
    return merged;
  }

  async maybeProbeTurn() {
    if (this.state !== 'listening' || !this.mlHelper?.ready) return;
    if (!this.asrStreamText.trim()) return;
    if (this.turnSamples < 16000 * 4) return; // 至少 4s 音频才有意义
    const now = Date.now();
    const elapsed = this.sessionStartedAt ? now - this.sessionStartedAt : 0;
    // 仅在会话已超过 4.5s 且出现 >= 550ms 停顿时探测一次 Smart Turn，辅助在自然语调落点处轮转会话
    if (elapsed < 4500) return;
    if (!this.lastDeltaAt || now - this.lastDeltaAt < 550) return;
    if (this.lastTurnProbeAt >= this.lastDeltaAt) return;
    if (now - this.lastTurnProbeAt < 800) return;
    if (this.turnProbeInFlight) return;
    this.turnProbeInFlight = true;
    this.lastTurnProbeAt = now;
    try {
      const prob = await this.mlHelper.turn(this.getTurnPcm());
      if (this.state !== 'listening') return;
      if (prob > (this.config.turnThreshold ?? 0.62) && this.asrSession) {
        this.closeAsrSession('turn');
      }
    } finally {
      this.turnProbeInFlight = false;
    }
  }

  checkStreamRotation() {
    if (this.state !== 'listening') return;
    const now = Date.now();
    const globalQuietMs = this.lastGlobalDeltaAt ? now - this.lastGlobalDeltaAt : 0;

    // 若说话人已停顿超过 2.2s 且仍有未提交草稿或活动流，触发 idle 收尾将最后一句完整送交翻译
    if (this.lastGlobalDeltaAt && globalQuietMs >= 2200) {
      if (this.asrSession && this.asrStreamText.trim()) {
        this.closeAsrSession('idle');
        return;
      }
      if (this.draft.trim() && !this.segmentationInFlight) {
        this.flushRemainingDraft().catch((err) => this.fail(err));
        return;
      }
    }

    if (!this.asrSession) return;
    const elapsed = this.sessionStartedAt ? now - this.sessionStartedAt : 0;

    // 核心防积压机制：R2T2 单次 live 流是从首个声音累积计算到最新声音，
    // 将单条流控制在 <= 9.6s（若已切出句子则 >= 5.2s 或累计满 2 句即刻轮转），使单次分块 GPU 耗时恒定，
    // 杜绝长音频累积导致 GPU 显存与算力爆炸。
    if (this.sentencesSinceSession >= 2 || (this.sentencesSinceSession >= 1 && elapsed >= 5200)) {
      this.closeAsrSession('sentences');
      return;
    }
    if (elapsed >= 9600) {
      this.closeAsrSession('rotate');
    }
  }

  // HTTP API 路由
  handleApi(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    const pathname = url.pathname;

    // 1. SSE 实时字幕事件流
    if (pathname === '/api/subtitles/stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });
      res.write('\n');

      this.sseClients.add(res);
      this.broadcastStatus();
      res.write(
        `event: snapshot\ndata: ${JSON.stringify({
          status: this.getFullStatusPayload(),
          sourceText: this.sourceText,
          targetRecords: this.targetRecords,
        })}\n\n`
      );

      req.on('close', () => {
        this.sseClients.delete(res);
      });
      return;
    }

    // 2. 状态查询（含运行环境校验、四级模型完整状态、自动测速下载进度）
    if (pathname === '/api/subtitles/status' && req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(JSON.stringify(this.getFullStatusPayload()));
      return;
    }

    // 3. 启动自动测速与模型一键下载
    if (pathname === '/api/subtitles/download' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', async () => {
        let targetModel = 'all';
        try {
          const parsed = JSON.parse(body || '{}');
          if (parsed && parsed.model) targetModel = parsed.model;
        } catch {}
        const state = await this.startDownload(targetModel);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ ok: true, downloadState: state }));
      });
      return;
    }

    // 4. 取消模型下载
    if (pathname === '/api/subtitles/download/cancel' && req.method === 'POST') {
      const state = this.cancelDownload();
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ ok: true, downloadState: state }));
      return;
    }

    // 5. 在访达 (Finder) 中打开字幕模型标准内置存储目录
    if (pathname === '/api/subtitles/open-dir' && req.method === 'POST') {
      try {
        fs.mkdirSync(SUBTITLE_MODELS_DIR, { recursive: true });
        spawn('open', [SUBTITLE_MODELS_DIR], { detached: true, stdio: 'ignore' }).unref();
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ ok: true, path: SUBTITLE_MODELS_DIR }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return;
    }

    // 6. 清空历史记录
    if (pathname === '/api/subtitles/clear' && req.method === 'POST') {
      this.resetSessionHistory({ broadcastEvent: true });
      if (this.state === 'listening' && this.modelsLoaded) this.openAsrSession();
      this.broadcastStatus();
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ ok: true, cleared: true }));
      return;
    }

    // 更新字幕配置（如 sourceLang, targetLang）
    if (pathname === '/api/subtitles/config' && req.method === 'POST') {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
          let changed = false;
          let sourceLangChanged = false;

          if (body.sourceLang && ['en', 'zh'].includes(body.sourceLang)) {
            if (this.config.sourceLang !== body.sourceLang) {
              this.config.sourceLang = body.sourceLang;
              changed = true;
              sourceLangChanged = true;
            }
          }

          if (body.targetLang && ['none', 'zh', 'ja', 'en'].includes(body.targetLang)) {
            if (this.config.targetLang !== body.targetLang) {
              this.config.targetLang = body.targetLang;
              changed = true;
            }
          }

          // 同语言不翻译：若 sourceLang === targetLang，自动回退到 'none'
          if (this.config.targetLang !== 'none' && this.config.sourceLang === this.config.targetLang) {
            this.config.targetLang = 'none';
            changed = true;
          }

          if (changed) {
            this.saveConfig();
            this.resetSessionHistory({ broadcastEvent: true });
            if (this.state === 'listening' && this.modelsLoaded) this.openAsrSession();
            this.broadcastStatus();
          }

          res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify({ ok: true, config: this.config }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
      });
      return;
    }

    // 7. 清理旧模型与临时缓存
    if (pathname === '/api/subtitles/clean' && req.method === 'POST') {
      const result = this.cleanLegacyModels({ removePartFiles: !this.downloadState.active });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ ok: true, ...result }));
      return;
    }

    // 8. 开启字幕窗口：按需加载全部三个模型并在就绪后启动监听
    if (pathname === '/api/subtitles/start' && req.method === 'POST') {
      this.start().catch((err) => {
        console.error('[Subtitles] start error:', err.message);
      });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(
        JSON.stringify({
          ok: true,
          running: this.isRunning,
          loading: this.isLoadingModels,
          modelsLoaded: this.modelsLoaded,
        })
      );
      return;
    }

    // 9. 窗口内暂停/继续内录（保持模型在内存中就绪，不卸载）
    if (pathname === '/api/subtitles/pause' && req.method === 'POST') {
      this.pause();
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ ok: true, running: false, paused: true, modelsLoaded: this.modelsLoaded }));
      return;
    }

    if (pathname === '/api/subtitles/resume' && req.method === 'POST') {
      this.resume();
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ ok: true, running: this.isRunning, paused: false, modelsLoaded: this.modelsLoaded }));
      return;
    }

    // 10. 关闭字幕窗口：立刻停止并卸载全部三个模型与子进程
    if (pathname === '/api/subtitles/stop' && req.method === 'POST') {
      this.stop();
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ ok: true, running: false, modelsLoaded: false }));
      return;
    }

    // 11. 模型清单
    if (pathname === '/api/subtitles/models' && req.method === 'GET') {
      const check = this.checkModelsReadiness();
      const runtime = this.checkRuntimeReadiness();
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(
        JSON.stringify({
          ok: true,
          allReady: check.allReady && runtime.ready,
          modelsReady: check.allReady,
          runtimeReady: runtime.ready,
          runtimeStatus: runtime,
          models: Object.entries(check.status).map(([k, v]) => ({ key: k, ...v })),
          downloadState: this.downloadState,
          storageDir: SUBTITLE_MODELS_DIR,
        })
      );
      return;
    }

    // 12. 实时 160ms 增量音频帧喂入端点（支持裸 PCM Int16LE 或 WAV）
    if (pathname === '/api/subtitles/feed' && req.method === 'POST') {
      const format = url.searchParams.get('format') || 'pcm';
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', async () => {
        if (this.state === 'error' || !this.modelsLoaded || !this.isRunning) {
          res.writeHead(409, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(
            JSON.stringify({
              ok: false,
              error: this.state,
              fatalError: this.fatalError,
            })
          );
          return;
        }

        try {
          const buf = Buffer.concat(chunks);
          await this.enqueueAudioFrame(buf, format);
          res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
      });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: 'not_found' }));
  }
}

export const subtitleService = new SubtitleService();
