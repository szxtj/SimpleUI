// 实时双语字幕服务端托管模块 (Subtitle Service — 两级极速流式架构 · 纯按需启停与统一进程看门狗管理)
// 纯端侧离线两级专属流水线（与语音输入服务 1236 完全独立）：
//   - 专属存储目录：~/Library/Application Support/SimpleUI/models/subtitles_pipeline/
//   - 第 1 级：davidxifeng/Confucius4-R2T2-gguf (Q8_0)            -> r2t2-q8_0.gguf
//             (audio.cpp `confucius4_r2t2` 家族，Metal 后端，Longest Stable Prefix 追加式流式识别)
//             由内置 audiocpp_server (端口 1250) 托管；每个话语一个 /v1/audio/transcriptions/live 请求，
//             chunked PCM 流入、SSE `transcript.text.delta/done` 流出；done 即话语权威终稿。
//   - 第 2 级：IndexTeam/Index-Translate-2B-GGUF                  -> index_translate_2b_q4_k_m.gguf (llama-server 1249 极速翻译)
//
// 与旧架构的关键差异：
//   - R2T2 的 Longest Stable Prefix 保证「已提交文字永不回改」（append-only），标点/大小写由模型原生输出。
//   - 话语（utterance）由系统数字音频静音计时驱动：有声开启 live 请求，静音满 utteranceEndSilenceMs
//     补 300ms 静音后关闭请求体，done 事件带回整句终稿 → 按句末标点切分定稿并送翻译。
//   - 两个后台服务（audiocpp_server / llama-server）均有健康巡检 + 崩溃自愈（限次重拉），翻译失败有重试与可见化。
//
// 生命周期契约：
//   - App 启动时绝不自动拉起字幕模型（0 后台常驻显存/内存），且启动时自动清扫上次残留的旧进程与无用缓存；
//   - 仅当用户从状态栏菜单开启字幕窗口（POST /api/subtitles/start）时，按阶段依次加载两级模型并实时广播加载进度；
//   - 两个模型全部就绪（modelsLoaded = true）后，才进入就绪监听态；
//   - 关闭字幕窗口（POST /api/subtitles/stop）或退出 App（shutdownSync / shutdownForce）时，立刻终止并卸载全部模型与子进程。

import http from 'http';
import https from 'https';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawn, execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { startWatchdog } from './watchdog.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const HOME = os.homedir();
const userConfigDir = path.join(HOME, 'Library', 'Application Support', 'SimpleUI');
const CONFIG_FILE = path.join(userConfigDir, 'subtitles_config.json');

// PID 文件（与 ttf_service / asr_service 统一纳入 watchdog 与启动/退出清扫体系）
const ASR_PID_FILE = '/tmp/simpleui_subtitle_audiocpp.pid'; // audiocpp_server (R2T2 流式 ASR, 端口 1250)
const TRANS_PID_FILE = '/tmp/simpleui_subtitle_trans.pid'; // llama-server (Index-Translate, 端口 1249)

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
};

export const REQUIRED_MODELS = MODEL_SPECS;

const DEFAULT_CONFIG = {
  enabled: true,
  autoStart: false, // 严格按需启动：仅在打开字幕窗口时加载模型
  sampleRate: 16000,
  // R2T2 流式块大小（ms）
  asrChunkMs: 640,
  // 话语边界：连续静音满该值 → 补 300ms 静音关闭 live 请求，收取 done 终稿
  utteranceEndSilenceMs: 640,
  // 单话语最长时长上限（防止长视频背景音下会话无限累积导致 O(t) 预填充膨胀）
  utteranceMaxMs: 12000,
  // done 事件兜底超时：关闭请求体后该时限内未收到终稿，则按已收到的增量文本定稿
  utteranceDoneTimeoutMs: 4000,
  sourceLang: 'en',
  targetLang: 'zh',
};

function cleanWordToken(w) {
  return String(w || '')
    .toLowerCase()
    .replace(/^[^a-z0-9']+|[^a-z0-9']+$/g, '');
}

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

const ABBREVIATIONS_WITH_DOT = new Set([
  'mr.',
  'mrs.',
  'ms.',
  'dr.',
  'prof.',
  'sr.',
  'jr.',
  'vs.',
  'st.',
  'etc.',
  'e.g.',
  'i.e.',
  'u.s.',
  'u.k.',
  'fig.',
  'inc.',
  'ltd.',
  'co.',
  'no.',
]);

const FALSE_PUNCT_HANGING_WORDS = new Set([
  'a',
  'an',
  'the',
  'this',
  'that',
  'these',
  'those',
  'my',
  'your',
  'his',
  'her',
  'its',
  'our',
  'their',
  'to',
  'of',
  'in',
  'on',
  'for',
  'with',
  'at',
  'by',
  'from',
  'about',
  'into',
  'up',
  'and',
  'or',
  'but',
  'so',
  'because',
  'if',
  'when',
  'while',
  'is',
  'am',
  'are',
  'was',
  'were',
  'be',
  'been',
  'have',
  'has',
  'had',
  'do',
  'does',
  'did',
  'will',
  'would',
  'can',
  'could',
  'should',
  'very',
  'too',
  'more',
  'most',
  'hundred',
  'thousand',
  'million',
  'billion',
]);

/**
 * 解析标准内置文件夹中的 audio.cpp 服务端 (audiocpp_server) 及其运行时根目录。
 * 兼容开发态 (../bin/audiocpp)、build/SimpleUI.app 打包态 (../asr) 与 /Applications 安装态。
 */
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
 * 系统数字音频有声检测器：
 * ScreenCaptureKit 采集的是纯净数字内录流，无系统音频播放时为绝对静音（RMS 接近 0）。
 * 因此无需任何花哨频带门控或 ONNX 模型，只要系统有声音输出（rms >= 0.0005）即直接送入流式 ASR 模型！
 */
class SystemAudioDetector {
  detectVoice(pcmBuffer, activeSession = false) {
    const sampleCount = Math.floor(pcmBuffer.length / 2);
    if (sampleCount === 0) return { isSpeech: false, rms: 0, voiceScore: 0 };

    let sumSq = 0;
    for (let i = 0; i < sampleCount; i++) {
      const s = pcmBuffer.readInt16LE(i * 2) / 32768.0;
      sumSq += s * s;
    }

    const rms = Math.sqrt(sumSq / sampleCount);
    // 未建会话时极低门限 (0.0008, -62dBFS) 立即触发录入；已建会话中将微弱视频底噪 (<0.002, -54dBFS) 视为句间停顿以便自然收尾重置上下文
    const threshold = activeSession ? 0.002 : 0.0008;
    const isSpeech = rms >= threshold;
    return { isSpeech, rms, voiceScore: isSpeech ? Math.min(1, rms * 20) : 0 };
  }
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
            'confucius4_r2t2.chunk_size_ms': '640',
            'confucius4_r2t2.unfixed_chunk_num': '0',
            'confucius4_r2t2.unfixed_token_num': '1',
            'confucius4_r2t2.rollback_punctuation': 'true',
            'confucius4_r2t2.max_tokens': '6',
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

    console.log('[Subtitles] [1/2] 正在加载 Confucius4-R2T2 流式识别引擎 (audio.cpp · Metal)...');
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
      console.warn('[Subtitles] ⚠ R2T2 预热请求未返回 200，但 /health 已就绪，继续启用流式识别');
    }
    this.ready = true;
    this.respawnAttempts = 0;
    console.log('[Subtitles] ✅ [1/2] Confucius4-R2T2 追加式流式识别引擎已就绪 (端口 1250)');
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
  createSession({ onDelta, onDone, onError }) {
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
            // 请求体已结束但未收到 done：按已累积增量定稿（兜底）
            session.state = 'done';
            session.onDone?.(session.text, null);
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
        // 官方已知问题：句尾词需要 ~300ms trailing silence 才会吐出
        req.write(Buffer.alloc(16000 * 2 * 0.3));
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
    this.history = [];
    this.seqId = 1;

    // 后台服务与推理状态
    this.asrEngine = new SubtitleAsrEngine();
    this.transProc = null;
    this.vad = new SystemAudioDetector();
    this.watchdogs = new Map();

    // 翻译健康巡检与自愈
    this.healthTimer = null;
    this.transAlive = false;
    this.transRespawnAttempts = 0;
    this.translationFailures = 0;

    // 串行处理锁，杜绝并发帧乱序
    this.processingChain = Promise.resolve();

    // 串行翻译锁（llama-server 单实例，串行避免并发争用）
    this.translateChain = Promise.resolve();
    this.translatePending = 0;

    // 流式断句状态机（话语级）
    this.asrSession = null; // 当前话语会话
    this.currentDraft = ''; // 当前话语已提交的增量文本（英文连续流尾部）
    this.silenceMs = 0; // 连续静音毫秒数
    this.speechMs = 0; // 当前话语累积人声毫秒数
    this.utteranceStartedAt = 0;
    this.lastCommittedEn = ''; // 上一句定稿英文（供翻译模型做上下文消歧）
    this.lastCommittedZh = ''; // 上一句定稿中文
    this.pendingResumeFrames = []; // 话语关闭等待 done 期间缓存的音频帧（防丢字）

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
        this.config = { ...DEFAULT_CONFIG, ...parsed, autoStart: false, utteranceMaxMs: Math.min(Number(parsed.utteranceMaxMs) || 12000, 12000) };
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
  }

  ensureWatchdogs() {
    if (!this.watchdogs.has(ASR_PID_FILE)) {
      try {
        this.watchdogs.set(
          ASR_PID_FILE,
          startWatchdog({
            pidFile: ASR_PID_FILE,
            binaryBasename: 'audiocpp_server',
          })
        );
      } catch {}
    }
    if (!this.watchdogs.has(TRANS_PID_FILE)) {
      try {
        this.watchdogs.set(
          TRANS_PID_FILE,
          startWatchdog({
            pidFile: TRANS_PID_FILE,
            binaryBasename: 'llama-server',
          })
        );
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
      for (const legacyName of ['nemotron_asr', 'qwen3_asr', 'qwen3_aligner', 'ten_vad.onnx']) {
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

    return {
      ready: asrRuntime.ready && llamaRuntime.ready,
      asrBinReady: asrRuntime.ready,
      asrBinPath: asrRuntime.binPath,
      llamaBinReady: llamaRuntime.ready,
      llamaBinPath: llamaRuntime.binPath,
      llamaLibDir: llamaRuntime.libDir,
      llamaBundled: llamaRuntime.bundled,
    };
  }

  /**
   * 完整校验三级流式字幕模型的每一个必需文件是否完整就绪
   */
  checkModelsReadiness() {
    const status = {};
    let allReady = true;
    const missing = [];

    for (const [key, spec] of Object.entries(MODEL_SPECS)) {
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
  async probeBestMirror(signal) {
    const probeSingleSource = async (source) => {
      const testUrl = `${source.baseUrl}/IndexTeam/Index-Translate-2B-GGUF/resolve/main/Index-Translate-2B.Q4_K_M.gguf`;
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
      const best = await this.probeBestMirror(signal);
      if (signal.aborted) throw new Error('cancelled');
      if (!best) throw new Error('所有下载源均不可达，请检查网络后重试');
      this.downloadState.selectedSource = {
        id: best.id,
        name: best.name,
        latencyMs: best.latencyMs,
        speedKbps: best.speedKbps,
      };
      this.broadcastStatus();

      const specsToDownload = Object.entries(MODEL_SPECS).filter(([key]) => {
        if (targetModel === 'all') return true;
        return key === targetModel;
      });

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
            const url = `${srcNode.baseUrl}/${spec.repo}/resolve/main/${file.src}`;
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
  resetSessionHistory() {
    this.clearGeneration = (this.clearGeneration || 0) + 1;
    this.translatePending = 0;
    this.history = [];
    this.currentDraft = '';
    this.silenceMs = 0;
    this.speechMs = 0;
    this.lastCommittedEn = '';
    this.lastCommittedZh = '';
    this.translationFailures = 0;
    this.pendingResumeFrames = [];
    this.preRollFrames = [];
    this.broadcast('clear', { cleared: true });
    this.broadcastDraft();
  }

  /**
   * 打开字幕窗口时调用：首先清空上次残留历史，再依次加载 3 个模型并实时广播加载阶段
   */
  async start() {
    // 若当前已在加载模型途中（例如窗口刚打开时 show() 与 WebView ready 同时触发 start），
    // 直接广播当前加载进度并返回，绝不重复触发第二轮进程拉起或中途清空！
    if (this.isLoadingModels) {
      this.broadcastStatus();
      return true;
    }

    // 每次新开字幕框必须清理历史记录与旧上下文
    this.resetSessionHistory();

    const check = this.checkModelsReadiness();
    const runtime = this.checkRuntimeReadiness();
    if (!check.allReady || !runtime.ready) {
      this.isRunning = false;
      this.isLoadingModels = false;
      this.modelsLoaded = false;
      this.loadingStage = 0;
      this.loadingStepKey = 'error';
      this.broadcastStatus();
      return false;
    }

    // 若两个模型均已就绪且进程存活，直接恢复监听
    if (
      this.modelsLoaded &&
      this.asrEngine.isAlive() &&
      this.asrEngine.ready &&
      (await this.checkHealth(1249))
    ) {
      this.isPaused = false;
      this.isRunning = true;
      this.isLoadingModels = false;
      this.loadingStage = 2;
      this.loadingStepKey = 'ready';
      this.startHealthMonitor();
      this.broadcastStatus();
      return true;
    }

    const myGen = ++this.sessionGeneration;
    this.isPaused = false;
    this.isRunning = false;
    this.isLoadingModels = true;
    this.modelsLoaded = false;
    this.loadingStage = 0;
    this.loadingStepKey = 'asr';
    this.broadcastStatus();

    const ok = await this.ensureServersRunning(myGen);
    if (myGen !== this.sessionGeneration) {
      this.stopServers();
      return false;
    }

    if (!ok) {
      this.isLoadingModels = false;
      this.modelsLoaded = false;
      this.isRunning = false;
      this.loadingStepKey = 'error';
      this.stopServers();
      this.broadcastStatus();
      return false;
    }

    // 关键修复：必须将 modelsLoaded 置为 true，否则前端将卡在加载界面且拒绝启动音频内录
    this.modelsLoaded = true;
    this.isRunning = true;
    this.isPaused = false;
    this.isLoadingModels = false;
    this.loadingStage = 2;
    this.loadingStepKey = 'ready';
    this.startHealthMonitor();
    console.log('[Subtitles] ✅ 双级流式字幕模型 (Confucius4-R2T2 + Index-Translate-2B) 已全部就绪');
    this.broadcastStatus();
    return true;
  }

  /**
   * 关闭字幕窗口时调用：立刻清空历史记录并停止卸载全部模型与子进程，释放全部内存/显存
   */
  stop() {
    this.sessionGeneration += 1;
    this.isRunning = false;
    this.isPaused = false;
    this.isLoadingModels = false;
    this.modelsLoaded = false;
    this.loadingStage = 0;
    this.loadingStepKey = 'idle';
    this.stopHealthMonitor();
    this.resetSessionHistory();
    this.stopServers();
    console.log('[Subtitles] ⏹ 字幕窗口已关闭，历史已清空，双级模型与后台子进程已全部停止并卸载');
    this.broadcastStatus();
  }

  pause() {
    this.isRunning = false;
    this.isPaused = true;
    this.abortCurrentSession('paused');
    this.broadcastStatus();
  }

  resume() {
    if (!this.modelsLoaded) {
      return this.start();
    }
    this.isRunning = true;
    this.isPaused = false;
    this.broadcastStatus();
  }

  stopServers() {
    this.abortCurrentSession('stop');
    if (this.asrEngine) this.asrEngine.stopServer();
    if (this.transProc) {
      try {
        this.transProc.kill('SIGKILL');
      } catch {}
      this.transProc = null;
    }
    this.transAlive = false;
    this.cleanStaleProcesses();
  }

  /**
   * 随 SimpleUI 退出时同步优雅停止（供 server/proxy.js 调用）
   */
  shutdownSync() {
    this.cancelDownload();
    this.sessionGeneration += 1;
    this.isRunning = false;
    this.modelsLoaded = false;
    this.stopHealthMonitor();
    this.stopServers();
  }

  /**
   * 随 SimpleUI 进程退出时强制清扫（供 server/proxy.js 调用）
   */
  shutdownForce() {
    this.cancelDownload();
    this.stopHealthMonitor();
    this.stopServers();
  }

  async checkHealth(port) {
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

  /**
   * 拉起 Index-Translate-2B (llama-server 端口 1249)，带单飞并发锁
   */
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
      const llamaEnv = {
        ...process.env,
        DYLD_LIBRARY_PATH: dyldPath,
        DYLD_FALLBACK_LIBRARY_PATH: dyldPath,
      };
      const transModel = path.join(SUBTITLE_MODELS_DIR, 'index_translate_2b_q4_k_m.gguf');
      console.log(`[Subtitles] [2/2] 正在加载 Index-Translate-2B Metal 翻译服务 (端口 1249)...`);
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
          '--cache-reuse',
          '64',
          '-np',
          '1',
          '--no-warmup',
          '-c',
          '512',
          '--jinja',
          '--chat-template-kwargs',
          '{"enable_thinking":false}',
        ],
        { stdio: 'ignore', env: llamaEnv }
      );
      this.transProc = proc;

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

      for (let i = 0; i < 60; i++) {
        if (exitedEarly) break;
        await new Promise((r) => setTimeout(r, 300));
        if (await this.checkHealth(1249)) {
          transAlive = true;
          break;
        }
      }
    } else if (transAlive) {
      this.transAlive = true;
    }

    this.transAlive = transAlive;
    this.transRespawnAttempts = transAlive ? 0 : this.transRespawnAttempts;
    return transAlive;
  }

  /**
   * 按阶段拉起双级模型并实时推送加载进度（第 1 级：Confucius4-R2T2 · 第 2 级：Index-Translate-2B）
   */
  async ensureServersRunning(expectedGen = this.sessionGeneration) {
    const check = this.checkModelsReadiness();
    if (!check.allReady) return false;

    this.ensureWatchdogs();

    // 阶段 1/2：加载 Confucius4-R2T2 (audio.cpp · Metal · 端口 1250)
    this.loadingStage = 0;
    this.loadingStepKey = 'asr';
    this.broadcastStatus();
    const asrOk = await this.asrEngine.ensureServer();
    if (!asrOk || expectedGen !== this.sessionGeneration) return false;

    // 阶段 2/2：加载 Index-Translate-2B (llama-server 端口 1249)
    this.loadingStage = 1;
    this.loadingStepKey = 'translate';
    this.broadcastStatus();
    const transOk = await this.ensureTransServer();

    return asrOk && transOk;
  }

  /**
   * 健康巡检：任一双生服务掉线时按限次尝试自愈（翻译服务 / ASR 服务各自独立计数）
   */
  startHealthMonitor() {
    if (this.healthTimer) return;
    this.healthTimer = setInterval(() => {
      this.healthCheckLoop().catch(() => {});
    }, 3000);
  }

  stopHealthMonitor() {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
  }

  async healthCheckLoop() {
    if (!this.modelsLoaded || !this.isRunning) return;

    // 翻译服务自愈
    const transHealthy = await this.checkHealth(1249);
    this.transAlive = transHealthy;
    if (!transHealthy) {
      if (this.transRespawnAttempts < 3) {
        this.transRespawnAttempts += 1;
        console.warn(
          `[Subtitles] ⚠ 翻译服务 (1249) 掉线，第 ${this.transRespawnAttempts}/3 次尝试重启...`
        );
        const ok = await this.ensureTransServer();
        if (ok) {
          this.transRespawnAttempts = 0;
          console.log('[Subtitles] ✅ 翻译服务已自愈重启');
        }
      } else {
        console.error('[Subtitles] ❌ 翻译服务多次重启失败，请关闭并重开字幕窗口');
      }
    } else {
      this.transRespawnAttempts = 0;
    }

    // ASR 服务自愈
    if (!this.asrEngine.isAlive() || !(await this.asrEngine.checkHealth())) {
      if (this.asrEngine.respawnAttempts < 3) {
        this.asrEngine.respawnAttempts += 1;
        console.warn(
          `[Subtitles] ⚠ 流式识别服务 (1250) 掉线，第 ${this.asrEngine.respawnAttempts}/3 次尝试重启...`
        );
        this.abortCurrentSession('asr-restart');
        const ok = await this.asrEngine.ensureServer();
        if (ok) {
          this.asrEngine.respawnAttempts = 0;
          console.log('[Subtitles] ✅ 流式识别服务已自愈重启');
        }
      } else {
        console.error('[Subtitles] ❌ 流式识别服务多次重启失败，请关闭并重开字幕窗口');
      }
    } else {
      this.asrEngine.respawnAttempts = 0;
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
      historyCount: this.history.length,
      translationFailures: this.translationFailures,
      recent: this.history.slice(-20),
    };
  }

  broadcastStatus() {
    this.broadcast('status', this.getFullStatusPayload());
  }

  broadcastDraft() {
    this.broadcast('draft', {
      stable: (this.currentDraft || '').trim(),
      pending: '',
    });
  }

  // MARK: - R2T2 实时增量断句与话语状态机

  /**
   * 开启一个新话语（live 请求）：
   * R2T2 的 delta 是 Longest Stable Prefix 追加流（已吐出的词和标点不会回滚修改）。
   * 因此在 onDelta 中一旦检测到已形成完整的句号句或逗号子句，立即切出并送往翻译，
   * 无需等到整个 45 秒话语结束或静音才翻译！
   */
  openUtterance() {
    const session = this.asrEngine.createSession({
      onDelta: (delta) => {
        if (!delta || this.asrSession !== session) return;
        this.currentDraft += delta;
        this.drainCompletedClausesFromDraft();
        this.broadcastDraft();
      },
      onDone: (finalText) => this.onUtteranceDone(finalText, session),
      onError: (err) => this.onUtteranceError(err, session),
    });
    session.committedCharCount = 0;
    this.asrSession = session;
    this.currentDraft = '';
    this.speechMs = 0;
    this.silenceMs = 0;
    this.utteranceStartedAt = Date.now();

    // 将开启话语前缓存的 320ms 前置音频帧一并写入，杜绝句首吞字
    if (this.preRollFrames && this.preRollFrames.length > 0) {
      for (const preBuf of this.preRollFrames) {
        session.write(preBuf);
      }
      this.preRollFrames = [];
    }

    this.broadcastDraft();
  }

  /**
   * 从正在流式增长的 currentDraft 中实时提取已完成的句子或意群子句并立即提交翻译：
   *   1. 句末停止符（. ? ! …）：满 4 词且后面已跟出新词（确保标点 token 已完整）
   *   2. 逗号/分号子句（, ; : —）：满 7 词且非悬挂词、后面已跟出新词
   *   3. 超长无标点意群保护：满 20 词时在非悬挂词边界切出前段，防止长句无限积压
   */
  drainCompletedClausesFromDraft() {
    let safety = 0;
    while (safety++ < 5) {
      const trimmed = (this.currentDraft || '').trimStart();
      if (!trimmed) break;

      const words = trimmed.split(/\s+/).filter(Boolean);
      const n = words.length;
      if (n < 4) break;

      let cutWordCount = 0;
      let cutReason = null;

      for (let i = 0; i < n - 1; i++) {
        const rawW = String(words[i] || '');
        const strippedQuotes = rawW.replace(/["')\]}]+$/, '');
        const lowerW = strippedQuotes.toLowerCase();
        const bareW = cleanWordToken(strippedQuotes);
        const wordsUpToHere = i + 1;

        if (FALSE_PUNCT_HANGING_WORDS.has(bareW)) continue;

        // 1. 句末标点（. ? ! …），满 4 词且后面已有新词 (i < n - 1)
        if (
          /[.?!…]$/.test(strippedQuotes) &&
          wordsUpToHere >= 4 &&
          !ABBREVIATIONS_WITH_DOT.has(lowerW) &&
          !/^\d+\.\d+$/.test(strippedQuotes)
        ) {
          cutWordCount = wordsUpToHere;
          cutReason = 'sentence-end';
          break;
        }

        // 2. 逗号/分号/破折号（, ; : — –），满 7 词且后面已有新词
        if (/[,;:—–]$/.test(strippedQuotes) && wordsUpToHere >= 7) {
          cutWordCount = wordsUpToHere;
          cutReason = 'comma-stop';
          break;
        }
      }

      // 3. 若连续 20 词未出现任何标点，在非悬挂词边界切出前 16~18 词送翻
      if (cutWordCount === 0 && n >= 20) {
        let idx = 18;
        while (idx > 10 && FALSE_PUNCT_HANGING_WORDS.has(cleanWordToken(words[idx - 1]))) {
          idx--;
        }
        cutWordCount = idx;
        cutReason = 'clause-cap';
      }

      if (cutWordCount <= 0) break;

      const committedClause = words.slice(0, cutWordCount).join(' ');
      const remainingTail = words.slice(cutWordCount).join(' ');
      this.currentDraft = remainingTail ? remainingTail + ' ' : '';
      if (this.asrSession) {
        this.asrSession.committedCharCount =
          (this.asrSession.committedCharCount || 0) + committedClause.length + 1;
      }
      this.commitSentence(committedClause, cutReason);

      // 消除随时间累加的 O(t) 计算量膨胀：当完整句子/意群已切出且当前会话已持续 >= 10s、currentDraft 为空时，
      // 立即无损轮转新会话以清空 audiocpp 内部累积的音频帧与 Prefix KV 重算开销
      if (
        this.asrSession &&
        this.asrSession.state === 'open' &&
        !this.currentDraft.trim() &&
        Date.now() - this.utteranceStartedAt >= 4500
      ) {
        this.rotateSessionCleanly();
        break;
      }
    }
  }

  /** 在完整句/子句定稿边界（currentDraft 为空）处无损轮转会话，彻底重置 audiocpp 随时间增长的音频与 Prefix 上下文 */
  rotateSessionCleanly() {
    const oldSession = this.asrSession;
    if (!oldSession) return;
    oldSession.abort();
    this.asrSession = null;
    this.currentDraft = '';
    if (this.isRunning && this.modelsLoaded && this.asrEngine.isAlive() && this.asrEngine.ready) {
      this.openUtterance();
    }
  }

  /** 关闭当前话语：补 300ms 静音结束请求体，等待 done 终稿冲刷出句尾最后几个词 */
  closeUtterance(reason) {
    const session = this.asrSession;
    if (!session || session.state !== 'open') return;
    console.log(`[Subtitles] 话语收尾 (${reason})，冲刷尾部终稿...`);
    session.finish();

    const timeoutMs = this.config.utteranceDoneTimeoutMs || 4000;
    setTimeout(() => {
      if (this.asrSession === session && session.state !== 'done' && !session.abandoned) {
        console.warn('[Subtitles] ⚠ done 终稿超时，按已接收增量定稿');
        const collectedText = session.text;
        session.abort();
        this.onUtteranceDone(collectedText, session);
      }
    }, timeoutMs);
  }

  /** 放弃当前话语（暂停/停止/服务重启时）：不提交任何文本 */
  abortCurrentSession(reason) {
    const session = this.asrSession;
    this.asrSession = null;
    this.currentDraft = '';
    if (session) {
      session.abort();
    }
    this.broadcastDraft();
  }

  onUtteranceDone(finalText, sessionRef = null) {
    const session = sessionRef || this.asrSession;
    if (sessionRef && this.asrSession !== sessionRef) return;
    // 在 done 事件中，R2T2 可能会比最后一次 delta 多吐出句尾最后 1~2 个词；
    // 计算终稿相较于已通过 delta 接收的文本增量，追加到 currentDraft 后再将剩余尾部定稿！
    const fullFinal = String(finalText || '').trim();
    const streamedSoFar = String(session?.text || '').trim();
    if (fullFinal.length > streamedSoFar.length && fullFinal.startsWith(streamedSoFar)) {
      const extraTail = fullFinal.slice(streamedSoFar.length);
      this.currentDraft = (this.currentDraft || '') + extraTail;
    } else if (!streamedSoFar && fullFinal && !this.currentDraft) {
      this.currentDraft = fullFinal;
    }

    const remainingText = (this.currentDraft || '').trim();
    this.asrSession = null;
    this.currentDraft = '';
    this.broadcastDraft();

    if (remainingText) {
      const sentences = this.splitSentences(remainingText);
      for (const sentence of sentences) {
        this.commitSentence(sentence, 'sentence-end');
      }
      console.log(
        `[Subtitles] 🎯 话语尾部定稿 (${sentences.length} 句): "${remainingText.slice(0, 80)}${remainingText.length > 80 ? '…' : ''}"`
      );
    }

    // 关闭等待期间缓存的帧：立即开启新话语无缝补喂，绝不丢弃轻音帧
    const buffered = this.pendingResumeFrames;
    this.pendingResumeFrames = [];
    if (buffered.length > 0 && this.isRunning && this.modelsLoaded) {
      const hasAnySpeech = buffered.some((b) => this.vad.detectVoice(b).isSpeech);
      if (hasAnySpeech && this.asrEngine.isAlive() && this.asrEngine.ready) {
        this.openUtterance();
        for (const buf of buffered) {
          if (this.asrSession) {
            const frameMs = Math.round((buf.length / 2 / 16000) * 1000);
            if (this.vad.detectVoice(buf).isSpeech) {
              this.silenceMs = 0;
              this.speechMs += frameMs;
            } else {
              this.silenceMs += frameMs;
            }
            this.asrSession.write(buf);
          }
        }
      }
    }
  }

  onUtteranceError(err, sessionRef = null) {
    if (sessionRef && this.asrSession !== sessionRef) return;
    console.error('[Subtitles] 话语请求异常:', err?.message || err);
    const remainingText = (this.currentDraft || '').trim();
    this.asrSession = null;
    this.currentDraft = '';
    this.broadcastDraft();
    if (remainingText) {
      for (const sentence of this.splitSentences(remainingText)) {
        this.commitSentence(sentence, 'sentence-end');
      }
    }
  }

  /** 按句末标点切分终稿；若单段超过 24 词则进一步按逗号或非悬挂词边界切分，防止单次翻译过长 */
  splitSentences(text) {
    const rawParts = (text.match(/[^.!?…]+[.!?…]+["'”’)\]]*|[^.!?…]+$/g) || [])
      .map((s) => s.trim())
      .filter(Boolean);
    const out = [];
    for (const part of rawParts) {
      const words = part.split(/\s+/).filter(Boolean);
      if (words.length <= 24) {
        out.push(part);
        continue;
      }
      let cur = [];
      for (let i = 0; i < words.length; i++) {
        cur.push(words[i]);
        const rawW = words[i].replace(/["')\]}]+$/, '');
        const bareW = cleanWordToken(rawW);
        const atComma = /[,;:—–]$/.test(rawW) && cur.length >= 8 && !FALSE_PUNCT_HANGING_WORDS.has(bareW);
        const atCap = cur.length >= 18 && !FALSE_PUNCT_HANGING_WORDS.has(bareW);
        if ((atComma || atCap) && i < words.length - 1) {
          out.push(cur.join(' '));
          cur = [];
        }
      }
      if (cur.length > 0) out.push(cur.join(' '));
    }
    return out;
  }

  /**
   * 串行入队处理每个流式音频帧（160ms 裸 PCM 或 WAV）
   */
  enqueueAudioFrame(rawBuffer, isFinal = false, format = 'pcm') {
    const task = this.processingChain.then(() =>
      this.processAudioFrameInternal(rawBuffer, isFinal, format).catch((err) => {
        console.error('[Subtitles] 处理音频帧异常:', err.message);
        return { ok: false, error: err.message };
      })
    );
    this.processingChain = task.catch(() => {});
    return task;
  }

  async processAudioFrameInternal(rawBuffer, isFinal = false, format = 'pcm') {
    if (!this.isRunning || !this.modelsLoaded) {
      return { ok: false, reason: this.isLoadingModels ? 'loading' : 'paused' };
    }

    // 提取纯 16kHz Int16 PCM 字节
    let pcmBuffer = rawBuffer;
    if (format === 'wav' || (rawBuffer.length > 44 && rawBuffer.toString('ascii', 0, 4) === 'RIFF')) {
      pcmBuffer = rawBuffer.subarray(44);
    }
    if (pcmBuffer.length === 0) return { ok: true, committed: false };

    const durationMs = Math.round((pcmBuffer.length / 2 / 16000) * 1000);
    const vadRes = this.vad.detectVoice(pcmBuffer, Boolean(this.asrSession));

    if (vadRes.isSpeech) {
      this.silenceMs = 0;
      this.speechMs += durationMs;
    } else {
      this.silenceMs += durationMs;
    }

    // 无活动话语：人声出现 → 携带前置缓冲开启新话语；静默期保留最近 2 帧前置缓冲防吞字
    if (!this.asrSession) {
      if (vadRes.isSpeech && this.asrEngine.isAlive() && this.asrEngine.ready) {
        this.openUtterance();
      } else {
        if (!this.preRollFrames) this.preRollFrames = [];
        this.preRollFrames.push(pcmBuffer);
        if (this.preRollFrames.length > 2) this.preRollFrames.shift();
        return { ok: true, committed: false };
      }
    }

    // 话语关闭等待 done 期间：缓存全部到达帧（不丢弃轻音帧），done 到达后无缝补喂
    const session = this.asrSession;
    if (session.state !== 'open') {
      this.pendingResumeFrames.push(pcmBuffer);
      if (this.pendingResumeFrames.length > 64) this.pendingResumeFrames.shift();
      return { ok: true, committed: false };
    }

    // 喂入 R2T2 流式会话
    session.write(pcmBuffer);

    // 话语收尾判定：
    //   1. 自然停顿（>= 640ms 静音）
    //   2. 会话满 10s 且草稿刚好在句末标点（. ? ! …）结束且当前处于微停顿（>= 160ms）：在句界平滑收尾重置上下文，防止 O(t) 计算累积
    //   3. 单次连接满 18s 兜底收尾重置
    const utteranceMs = Date.now() - this.utteranceStartedAt;
    const endBySilence = this.silenceMs >= (this.config.utteranceEndSilenceMs || 640) && this.speechMs > 0;
    const draftTrimmed = (this.currentDraft || '').trim();
    const endBySentenceBoundary =
      utteranceMs >= 4500 &&
      this.silenceMs >= 160 &&
      (!draftTrimmed || /[.?!…]["')\]}]*$/.test(draftTrimmed));
    const endByLength = utteranceMs >= (this.config.utteranceMaxMs || 12000);
    if (endBySilence || endBySentenceBoundary || endByLength) {
      this.closeUtterance(endByLength ? 'length' : endBySentenceBoundary ? 'sentence-reset' : 'silence');
    }

    if (isFinal) {
      this.closeUtterance('final');
    }

    return {
      ok: true,
      committed: false,
      reason: 'streaming',
    };
  }

  // MARK: - 定稿与翻译

  /** 将一句话/子句定稿（入历史 + 广播 + 以前句为上文送翻译） */
  commitSentence(sentence, reason = 'sentence-end') {
    const text = (sentence || '').trim();
    if (!text) return;

    const segId = `sub_${Date.now()}_${this.seqId++}`;
    const record = {
      id: segId,
      status: 'translating',
      source_lang: 'en',
      target_lang: 'zh',
      source_text: text,
      target_text: '',
      reason,
      createdAt: Date.now(),
    };

    this.history.push(record);
    if (this.history.length > 200) this.history.shift();

    // 第 0ms：立刻广播 commit 事件，前端英文连续流无缝衔接
    this.broadcast('commit', record);
    this.enqueueTranslation(record);
  }

  /**
   * 翻译入队（串行链）。上下文在**执行时**读取，保证前序句子翻译已完成；
   * 积压超过 2 句时自动跳过上下文以追上进度；关闭或清空后自动丢弃过期任务。
   */
  enqueueTranslation(record) {
    const mySessionGen = this.sessionGeneration;
    const myClearGen = this.clearGeneration;
    this.translatePending += 1;
    const task = this.translateChain.then(async () => {
      this.translatePending = Math.max(0, this.translatePending - 1);
      if (
        mySessionGen !== this.sessionGeneration ||
        myClearGen !== this.clearGeneration ||
        !this.modelsLoaded
      ) {
        return;
      }

      const skipContext = this.translatePending > 2;
      const prevEn = skipContext ? '' : this.lastCommittedEn;
      const prevZh = skipContext ? '' : this.lastCommittedZh;

      const result = await this.callTranslate(record.source_text, prevEn, prevZh);
      if (
        mySessionGen !== this.sessionGeneration ||
        myClearGen !== this.clearGeneration ||
        !this.modelsLoaded
      ) {
        return;
      }

      if (result.ok && result.text) {
        record.target_text = this.harmonizeChinesePunctuation(
          record.source_text,
          result.text,
          record.reason || 'sentence-end'
        );
        record.status = 'finalized';
        this.lastCommittedEn = record.source_text;
        this.lastCommittedZh = record.target_text;
        this.broadcast('translated', record);
        this.broadcast('finalized', record);
      } else {
        record.status = 'failed';
        this.translationFailures += 1;
        this.lastCommittedEn = record.source_text;
        this.lastCommittedZh = '';
        console.error(`[Subtitles] ❌ 翻译失败(已重试): "${record.source_text.slice(0, 60)}"`);
        this.broadcast('translation_failed', record);
        this.broadcastStatus();
      }
    });
    this.translateChain = task.catch(() => {});
  }

  /**
   * 调用 Index-Translate-2B 极速神经机器翻译：
   * - 严格限制单句与上文长度，杜绝长上下文累积导致模型崩溃或复读英文；
   * - 有上文参考时走三轮上下文；若超时/失败/意外复述英文 → 立即以单轮模式重试一次（若服务掉线则先自愈拉起）。
   */
  async callTranslate(enText, prevEn = '', prevZh = '') {
    const boundedEn = String(enText || '').trim().slice(0, 420);
    if (!boundedEn) return { ok: false, text: '' };

    const singleTurnMessages = [
      {
        role: 'user',
        content: `请将以下文本翻译为中文，直接输出翻译结果，不要进行任何解释。\n\n${boundedEn}`,
      },
    ];

    const canUseContext =
      prevEn &&
      prevZh &&
      prevEn.length <= 220 &&
      prevZh.length <= 150 &&
      boundedEn.length <= 260;

    const contextMessages = canUseContext
      ? [
          {
            role: 'user',
            content: `请将以下文本翻译为中文，直接输出翻译结果，不要进行任何解释。\n\n${prevEn}`,
          },
          {
            role: 'assistant',
            content: prevZh,
          },
          {
            role: 'user',
            content: `请结合上文语境，将以下文本翻译为中文，直接输出当前句的翻译结果，不要重复上文，不要进行任何解释。\n\n${boundedEn}`,
          },
        ]
      : null;

    const sendOnce = (messages) =>
      new Promise((resolve) => {
        const body = JSON.stringify({
          messages,
          max_tokens: 180,
          temperature: 0,
          chat_template_kwargs: { enable_thinking: false },
        });

        const req = http.request(
          {
            hostname: '127.0.0.1',
            port: 1249,
            path: '/v1/chat/completions',
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(body),
            },
            timeout: 6000,
          },
          (res) => {
            let data = '';
            res.on('data', (chunk) => (data += chunk));
            res.on('end', () => {
              try {
                const json = JSON.parse(data);
                const rawZh = json.choices?.[0]?.message?.content || '';
                resolve(stripThinkTags(rawZh));
              } catch {
                resolve('');
              }
            });
          }
        );

        req.on('error', () => resolve(''));
        req.setTimeout(6000, () => {
          req.destroy();
          resolve('');
        });
        req.write(body);
        req.end();
      });

    const isEnglishEcho = (candidate) => {
      if (!candidate) return false;
      const enWords = boundedEn.split(/\s+/).filter((w) => /[a-zA-Z]{2,}/.test(w));
      return enWords.length >= 3 && !/[\u4e00-\u9fff]/.test(candidate);
    };

    // 第一次：优先上下文（消歧），无上下文则单轮
    let outZh = contextMessages ? await sendOnce(contextMessages) : await sendOnce(singleTurnMessages);

    // 失败/超时/空，或模型在多轮模式下意外复读英文 → 单轮重试一次（若 1249 掉线则立即自愈）
    if (!outZh || (contextMessages && isEnglishEcho(outZh))) {
      if (!outZh && this.modelsLoaded && !(await this.checkHealth(1249))) {
        await this.ensureTransServer();
      }
      outZh = await sendOnce(singleTurnMessages);
    }

    // 若模型意外把上文译文重复拼在开头，自动剥离上文译文前缀
    if (outZh && prevZh && prevZh.length >= 2 && outZh.startsWith(prevZh) && outZh.length > prevZh.length) {
      outZh = outZh.slice(prevZh.length).replace(/^[，。、；：\s]+/, '');
    }

    return { ok: Boolean(outZh), text: (outZh || '').trim() };
  }

  /**
   * 根据英文子句末尾的停止符号类型，协调中文译文末尾标点，使多段子句在连续流中无缝拼接成自然段落
   */
  harmonizeChinesePunctuation(enSentence, zhText, reason) {
    let zh = String(zhText || '').trim();
    if (!zh) return '';

    const cleanEn = String(enSentence || '').trim().replace(/["')\]}]+$/, '');
    const isCommaStop =
      reason === 'comma-stop' ||
      reason === 'clause-pause' ||
      reason === 'clause-cap' ||
      /[,;:—–]$/.test(cleanEn);
    const isQuestion = /\?$/.test(cleanEn);
    const isExclaim = /!$/.test(cleanEn);

    if (isCommaStop) {
      zh = zh.replace(/[。.!！,，;；:：]+$/, '，');
      if (!/[，；：？！…—]$/.test(zh)) {
        zh += '，';
      }
    } else if (isQuestion) {
      zh = zh.replace(/[。.!！?？,，;；]+$/, '？');
      if (!/[？！…]$/.test(zh)) {
        zh += '？';
      }
    } else if (isExclaim) {
      zh = zh.replace(/[。.!！?？,，;；]+$/, '！');
      if (!/[！…]$/.test(zh)) {
        zh += '！';
      }
    } else {
      zh = zh.replace(/[.,，;；]+$/, '。');
      if (!/[。？！…—”’》）\]}]/.test(zh.slice(-1))) {
        zh += '。';
      }
    }
    return zh;
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
      this.broadcastDraft();

      req.on('close', () => {
        this.sseClients.delete(res);
      });
      return;
    }

    // 2. 状态查询（含运行环境校验、三级模型完整状态、自动测速下载进度）
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
      this.abortCurrentSession('clear');
      this.resetSessionHistory();
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ ok: true, cleared: true }));
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
      const isFinal = url.searchParams.get('is_final') === '1';
      const format = url.searchParams.get('format') || 'pcm';
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', async () => {
        if (!this.modelsLoaded || !this.isRunning) {
          res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(
            JSON.stringify({
              ok: false,
              status: this.isLoadingModels ? 'loading' : 'stopped',
            })
          );
          return;
        }

        try {
          const buf = Buffer.concat(chunks);
          const result = await this.enqueueAudioFrame(buf, isFinal, format);
          res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(
            JSON.stringify({
              ok: true,
              status: 'done',
              isFinal,
              committed: Boolean(result && result.committed),
              reason: (result && result.reason) || 'streaming',
            })
          );
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: 'not_found' }));
  }
}

export const subtitleService = new SubtitleService();
