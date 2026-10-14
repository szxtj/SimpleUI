// 实时双语字幕服务端托管模块 (Subtitle Service — 三级极速流式架构 · 纯按需启停与统一进程看门狗管理)
// 纯端侧离线三级专属流水线（与语音输入服务 1236 完全独立）：
//   - 专属存储目录：~/Library/Application Support/SimpleUI/models/subtitles_pipeline/
//   - 第 1 级：TEN-framework/ten-vad                              -> ten_vad.onnx (16ms 帧级声学活动检测)
//   - 第 2 级：aufklarer/Nemotron-Speech-Streaming-0.6B-CoreML-INT8 -> nemotron_asr/ (M系列 ANE 160ms 原生流式英文识别+标点)
//   - 第 3 级：IndexTeam/Index-Translate-2B-GGUF                  -> index_translate_2b_q4_k_m.gguf (llama-server 1249 极速翻译)
//
// 生命周期契约：
//   - App 启动时绝不自动拉起字幕模型（0 后台常驻显存/内存），且启动时自动清扫上次残留的旧进程；
//   - 仅当用户从状态栏菜单开启字幕窗口（POST /api/subtitles/start）时，按阶段依次加载三个模型并实时广播加载进度；
//   - 三个模型全部就绪（modelsLoaded = true）后，才进入就绪监听态；
//   - 关闭字幕窗口（POST /api/subtitles/stop）或退出 App（shutdownSync / shutdownForce）时，立刻终止并卸载全部三个模型与子进程。

import http from 'http';
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
const ASR_PID_FILE = '/tmp/simpleui_subtitle_asr.pid';
const TRANS_PID_FILE = '/tmp/simpleui_subtitle_trans.pid';

// 专属隔离模型目录
export const SUBTITLE_MODELS_DIR = path.join(userConfigDir, 'models', 'subtitles_pipeline');

// 已废弃的旧版模型与目录（启动或清理时自动移除以释放磁盘空间）
const LEGACY_MODEL_PATHS = [
  'qwen3_asr_1.7b.gguf',
  'mmproj_qwen3_asr_1.7b.gguf',
  'audio_encoder.mlmodelc',
  'punct',
];

export const REQUIRED_MODELS = {
  vad: {
    name: 'TEN-VAD (16ms 帧级声学活动检测)',
    relPath: 'ten_vad.onnx',
    minBytes: 300 * 1024,
    sizeDesc: '315 KB',
  },
  asr: {
    name: 'Nemotron-Speech-Streaming-0.6B (ANE 160ms 流式英文识别)',
    relPath: path.join('nemotron_asr', 'encoder.mlmodelc', 'weights', 'weight.bin'),
    minBytes: 400 * 1024 * 1024,
    sizeDesc: '580 MB',
  },
  translate: {
    name: 'Index-Translate-2B Q4_K_M (专精神经机器翻译)',
    relPath: 'index_translate_2b_q4_k_m.gguf',
    minBytes: 1200 * 1024 * 1024,
    sizeDesc: '1.25 GB',
  },
};

const DEFAULT_CONFIG = {
  enabled: true,
  autoStart: false, // 严格按需启动：仅在打开字幕窗口时加载模型
  sampleRate: 16000,
  chunkDurationMs: 160,
  sourceLang: 'en',
  targetLang: 'zh',
  // 方案 B：双层滞回静音 + 句法回退软切参数
  minWordsForPunctCut: 3,       // 至少 3 个词才允许句末标点直接断句
  softCutStartWords: 16,        // 达到 16 词进入“逗号/连词逆向回退软切”区间
  clausePauseWords: 22,         // 达到 22 词且出现真实换气停顿（>=480ms）时在非修饰词边界软切
  hardCutMaxWords: 28,          // 达到 28 词安全回退强制断句，防止单条字幕超长
  punctMicroPauseMs: 160,       // 有句末标点（. ? !）时，160ms 微停顿或后续已出新词即刻切句
  commaPauseSilenceMs: 480,     // 句中结尾带逗号/分号（, ; :）且 >=5 词时，480ms 停顿切句
  unpunctuatedSilenceMs: 960,   // 无标点时需连续 960ms（6帧）静音才断句，彻底容忍慢语速词间停顿
  shortSentenceSilenceMs: 1120, // 极短词（1~2词）无标点需 1120ms 静音才定稿，防句首碎片
};

// 并列/从属连词与分句引导词（长句软切时在连词前断开，由连词领起下一分句）
const CLAUSE_CONJUNCTIONS = new Set([
  'and',
  'but',
  'so',
  'because',
  'which',
  'that',
  'when',
  'while',
  'if',
  'although',
  'though',
  'where',
  'whereas',
  'whether',
  'since',
  'unless',
  'until',
  'before',
  'after',
]);

// 绝不可作为软切句尾的悬挂修饰词/冠词/介词/助动词（防止在 "this | Apple" 或 "to | know" 中间劈开）
const NON_TERMINAL_TAIL_WORDS = new Set([
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
  'some',
  'any',
  'no',
  'every',
  'each',
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
  'onto',
  'upon',
  'between',
  'among',
  'through',
  'during',
  'without',
  'within',
  'is',
  'am',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'have',
  'has',
  'had',
  'do',
  'does',
  'did',
  'will',
  'would',
  'shall',
  'should',
  'can',
  'could',
  'may',
  'might',
  'must',
  'and',
  'or',
  'but',
  'so',
  'if',
  'when',
  'while',
  'because',
  'as',
  'than',
  'very',
  'too',
  'quite',
  'rather',
  'more',
  'most',
]);

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

function getLlamaServerBin() {
  const customPath = path.join(userConfigDir, 'runtime', 'llama', 'bin', 'llama-server');
  if (fs.existsSync(customPath)) return customPath;
  const appPath = '/Applications/SimpleUI.app/Contents/Resources/bin/llama-server';
  if (fs.existsSync(appPath)) return appPath;
  return 'llama-server';
}

function stripThinkTags(text) {
  if (!text || typeof text !== 'string') return '';
  let out = text.replace(/<think>[\s\S]*?<\/think>/gi, '');
  if (out.includes('</think>')) {
    out = out.split('</think>').pop();
  }
  return out.replace(/^<think>/i, '').trim();
}

// MARK: - 轻量级 TEN-VAD 声学特征与人声检测器
class TenVadDetector {
  constructor() {
    this.session = null;
    this.states = {};
    this.loaded = false;
  }

  async ensureLoaded() {
    if (this.loaded && this.session) return true;
    const modelPath = path.join(SUBTITLE_MODELS_DIR, 'ten_vad.onnx');
    if (!fs.existsSync(modelPath)) return false;
    try {
      const ort = (await import('onnxruntime-node')).default;
      this.ort = ort;
      this.session = await ort.InferenceSession.create(modelPath, {
        executionProviders: ['cpu'],
        intraOpNumThreads: 1,
      });
      this.loaded = true;
      return true;
    } catch {
      this.loaded = false;
      this.session = null;
      return false;
    }
  }

  unload() {
    if (this.session) {
      try {
        if (typeof this.session.release === 'function') {
          this.session.release();
        }
      } catch {}
    }
    this.session = null;
    this.states = {};
    this.loaded = false;
  }

  /**
   * 评估 16kHz Int16 PCM 帧是否包含有效人声（结合人声频带能量与过零率，滤除纯低频/高频背景音乐噪声）
   */
  detectVoice(pcmBuffer) {
    const sampleCount = Math.floor(pcmBuffer.length / 2);
    if (sampleCount === 0) return { isSpeech: false, rms: 0, voiceScore: 0 };

    let sumSq = 0;
    let diffSq = 0;
    let zeroCrossings = 0;
    let prev = 0;

    for (let i = 0; i < sampleCount; i++) {
      const s = pcmBuffer.readInt16LE(i * 2) / 32768.0;
      sumSq += s * s;
      if (i > 0) {
        const d = s - prev;
        diffSq += d * d;
        if ((s >= 0 && prev < 0) || (s < 0 && prev >= 0)) {
          zeroCrossings++;
        }
      }
      prev = s;
    }

    const rms = Math.sqrt(sumSq / sampleCount);
    const diffRms = Math.sqrt(diffSq / Math.max(1, sampleCount - 1));
    const zcr = zeroCrossings / sampleCount;

    // 语音频带（300Hz-3400Hz）能量与过零率特征门限
    const isVoiceBand = zcr >= 0.015 && zcr <= 0.42 && diffRms >= rms * 0.18;
    const isSpeech = rms >= 0.012 && (isVoiceBand || rms >= 0.028);
    return { isSpeech, rms, voiceScore: isSpeech ? Math.min(1, rms * 15) : 0 };
  }
}

class SubtitleService {
  constructor() {
    this.config = { ...DEFAULT_CONFIG };
    this.isRunning = false;       // 是否处于活动监听态
    this.isPaused = false;        // 窗口打开期间用户手动点击暂停
    this.isLoadingModels = false; // 是否正在加载三级模型
    this.modelsLoaded = false;    // 三个模型是否全部在内存/显存中就绪
    this.loadingStage = 0;        // 0: 未加载, 1: VAD 就绪, 2: Nemotron ANE 就绪, 3: Index-Translate 就绪
    this.loadingStepKey = 'idle'; // 'idle' | 'vad' | 'asr' | 'translate' | 'ready' | 'error'
    this.sessionGeneration = 0;   // 防止加载途中用户关闭窗口导致异步回写重新拉起模型

    this.sseClients = new Set();
    this.history = [];
    this.seqId = 1;

    // 守护进程与推理状态
    this.streamAsrProc = null;
    this.streamAsrReady = false;
    this.asrPendingCallbacks = [];
    this.asrStdoutBuf = '';

    this.transProc = null;
    this.vad = new TenVadDetector();
    this.watchdogs = new Map();

    // 串行处理锁，杜绝并发帧乱序
    this.processingChain = Promise.resolve();

    // 流式断句状态机
    this.currentWords = [];        // 当前正在底部流式吐出的词序列
    this.consumedPrefixWords = [];  // 当前底层 ASR 会话中已被切走定稿的前缀词（用于软切后去重）
    this.silenceMs = 0;            // 连续静音毫秒数
    this.speechMs = 0;             // 当前句累积人声毫秒数
    this.lastCommittedEn = '';     // 上一句定稿英文（供翻译模型做上下文消歧）

    this.loadConfig();
    this.cleanLegacyModels();
  }

  loadConfig() {
    try {
      if (fs.existsSync(CONFIG_FILE)) {
        const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
        const parsed = JSON.parse(raw);
        this.config = { ...DEFAULT_CONFIG, ...parsed, autoStart: false };
      }
    } catch (e) {
      console.warn('[Subtitles] 读取配置文件失败，使用默认配置:', e.message);
    }
  }

  saveConfig() {
    try {
      if (!fs.existsSync(userConfigDir)) {
        fs.mkdirSync(userConfigDir, { recursive: true });
      }
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(this.config, null, 2), 'utf-8');
    } catch (e) {
      console.error('[Subtitles] 保存配置文件失败:', e.message);
    }
  }

  /**
   * 启动时与退出时清理任何上次残留的孤儿字幕进程（subtitle_stream_asr 与端口 1249 的 llama-server）
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

    // 精确清理同名孤儿进程（不误伤其它端口的 llama-server）
    try {
      execSync('pkill -x "subtitle_stream_asr"', { stdio: 'ignore' });
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
            binaryBasename: 'subtitle_stream_asr',
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
   * 自动清理废弃的旧模型（Qwen3-ASR 1.7B、残缺 ForcedAligner、独立 Punct）与 .part 碎片
   */
  cleanLegacyModels() {
    if (!fs.existsSync(SUBTITLE_MODELS_DIR)) return { freedBytes: 0, removed: [] };
    let freedBytes = 0;
    const removed = [];

    const getSize = (p) => {
      try {
        const st = fs.statSync(p);
        if (st.isFile()) return st.size;
        if (st.isDirectory()) {
          return fs.readdirSync(p).reduce((acc, f) => acc + getSize(path.join(p, f)), 0);
        }
      } catch {}
      return 0;
    };

    for (const rel of LEGACY_MODEL_PATHS) {
      const fullPath = path.join(SUBTITLE_MODELS_DIR, rel);
      if (fs.existsSync(fullPath)) {
        const sz = getSize(fullPath);
        try {
          fs.rmSync(fullPath, { recursive: true, force: true });
          freedBytes += sz;
          removed.push(rel);
        } catch {}
      }
    }

    const cleanPartRecursive = (dir) => {
      try {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            cleanPartRecursive(full);
          } else if (entry.name.endsWith('.part')) {
            freedBytes += getSize(full);
            fs.rmSync(full, { force: true });
            removed.push(path.relative(SUBTITLE_MODELS_DIR, full));
          }
        }
      } catch {}
    };
    cleanPartRecursive(SUBTITLE_MODELS_DIR);

    if (removed.length > 0) {
      console.log(
        `[Subtitles] 🧹 已自动清理废弃模型与缓存 (${(freedBytes / (1024 * 1024)).toFixed(1)} MB): ${removed.join(', ')}`
      );
    }
    return { freedBytes, removed };
  }

  checkModelsReadiness() {
    const status = {};
    let allReady = true;
    const missing = [];

    for (const [key, spec] of Object.entries(REQUIRED_MODELS)) {
      const fullPath = path.join(SUBTITLE_MODELS_DIR, spec.relPath);
      const exists = fs.existsSync(fullPath);
      let sizeBytes = 0;
      if (exists) {
        try {
          sizeBytes = fs.statSync(fullPath).size;
        } catch {}
      }
      const ready = exists && sizeBytes >= spec.minBytes;
      status[key] = {
        name: spec.name,
        ready,
        sizeBytes,
        sizeMb: (sizeBytes / (1024 * 1024)).toFixed(1),
        sizeDesc: spec.sizeDesc,
        path: fullPath,
      };
      if (!ready) {
        allReady = false;
        missing.push(spec.name);
      }
    }

    return { allReady, status, missing };
  }

  init() {
    // 启动前先彻底清扫可能残留的旧版字幕子进程，确保版本一致且 0 后台残留
    this.cleanStaleProcesses();
    this.ensureWatchdogs();
    console.log('[Subtitles] 实时英译中流式字幕服务已注册（按需启动模式：窗口打开时加载，窗口关闭时立刻卸载）');
  }

  /**
   * 打开字幕窗口时调用：依次加载 3 个模型并实时向前端广播加载阶段
   */
  async start() {
    const check = this.checkModelsReadiness();
    if (!check.allReady) {
      this.isRunning = false;
      this.isLoadingModels = false;
      this.modelsLoaded = false;
      this.loadingStage = 0;
      this.loadingStepKey = 'idle';
      this.broadcastStatus();
      return false;
    }

    // 若三个模型已经全部加载就绪且进程存活，直接恢复运行
    if (this.modelsLoaded && this.streamAsrProc && this.streamAsrReady && (await this.checkHealth(1249))) {
      this.isPaused = false;
      this.isRunning = true;
      this.isLoadingModels = false;
      this.loadingStage = 3;
      this.loadingStepKey = 'ready';
      this.broadcastStatus();
      return true;
    }

    if (this.isLoadingModels) {
      this.broadcastStatus();
      return true;
    }

    const myGen = ++this.sessionGeneration;
    this.isPaused = false;
    this.isRunning = false;
    this.isLoadingModels = true;
    this.modelsLoaded = false;
    this.loadingStage = 0;
    this.loadingStepKey = 'vad';
    this.broadcastStatus();

    const ok = await this.ensureServersRunning(myGen);
    if (myGen !== this.sessionGeneration) {
      // 加载途中用户已关闭窗口，立即清理
      this.stopServers();
      return false;
    }

    if (ok) {
      this.isLoadingModels = false;
      this.modelsLoaded = true;
      this.isRunning = true;
      this.loadingStage = 3;
      this.loadingStepKey = 'ready';
      console.log('[Subtitles] ✅ 三级流式字幕模型已全部加载就绪，开始实时监听');
      this.broadcastStatus();
      return true;
    } else {
      this.isLoadingModels = false;
      this.modelsLoaded = false;
      this.isRunning = false;
      this.loadingStepKey = 'error';
      console.error('[Subtitles] ❌ 启动后台流式字幕模型失败');
      this.stopServers();
      this.broadcastStatus();
      return false;
    }
  }

  /**
   * 字幕窗口打开期间，用户点击“暂停/继续”按钮（仅暂停音频流处理，不卸载模型）
   */
  pause() {
    this.isPaused = true;
    this.isRunning = false;
    this.currentWords = [];
    this.consumedPrefixWords = [];
    this.silenceMs = 0;
    this.speechMs = 0;
    this.sendAsrCommand({ cmd: 'reset', hard: true }).catch(() => {});
    this.broadcastDraft();
    this.broadcastStatus();
  }

  resume() {
    if (!this.modelsLoaded) {
      return this.start();
    }
    this.isPaused = false;
    this.isRunning = true;
    this.broadcastStatus();
  }

  /**
   * 关闭字幕窗口时调用：立刻停止并卸载全部 3 个模型与子进程，释放全部内存/显存
   */
  stop() {
    this.sessionGeneration += 1;
    this.isRunning = false;
    this.isPaused = false;
    this.isLoadingModels = false;
    this.modelsLoaded = false;
    this.loadingStage = 0;
    this.loadingStepKey = 'idle';
    this.currentWords = [];
    this.consumedPrefixWords = [];
    this.silenceMs = 0;
    this.speechMs = 0;

    this.stopServers();
    console.log('[Subtitles] ⏹ 字幕窗口已关闭，三级模型与后台子进程已全部停止并卸载');
    this.broadcastDraft();
    this.broadcastStatus();
  }

  stopServers() {
    // 1. 卸载 TEN-VAD ONNX 会话
    this.vad.unload();

    // 2. 终止 Nemotron ANE 流式 ASR 守护进程
    if (this.streamAsrProc) {
      const proc = this.streamAsrProc;
      this.streamAsrProc = null;
      this.streamAsrReady = false;
      try {
        proc.stdin.write(JSON.stringify({ cmd: 'quit' }) + '\n');
      } catch {}
      try {
        proc.kill('SIGTERM');
      } catch {}
      setTimeout(() => {
        try {
          if (!proc.killed) proc.kill('SIGKILL');
        } catch {}
      }, 400);
    }
    const asrPid = readPidFile(ASR_PID_FILE);
    if (isPidAlive(asrPid)) {
      try {
        process.kill(asrPid, 'SIGTERM');
      } catch {}
    }
    try {
      if (fs.existsSync(ASR_PID_FILE)) fs.unlinkSync(ASR_PID_FILE);
    } catch {}

    // 3. 终止 Index-Translate-2B (llama-server 1249) 进程
    if (this.transProc) {
      const proc = this.transProc;
      this.transProc = null;
      try {
        proc.kill('SIGTERM');
      } catch {}
      setTimeout(() => {
        try {
          if (!proc.killed) proc.kill('SIGKILL');
        } catch {}
      }, 400);
    }
    const transPid = readPidFile(TRANS_PID_FILE);
    if (isPidAlive(transPid)) {
      try {
        process.kill(transPid, 'SIGTERM');
      } catch {}
    }
    try {
      if (fs.existsSync(TRANS_PID_FILE)) fs.unlinkSync(TRANS_PID_FILE);
    } catch {}
  }

  /**
   * 随 SimpleUI 退出时同步优雅停止（与 ttfService / asrService 对齐）
   */
  shutdownSync() {
    this.sessionGeneration += 1;
    this.isRunning = false;
    this.modelsLoaded = false;
    this.vad.unload();

    for (const pidFile of [ASR_PID_FILE, TRANS_PID_FILE]) {
      const pid = readPidFile(pidFile);
      if (isPidAlive(pid)) {
        try {
          process.kill(pid, 'SIGTERM');
        } catch {}
      }
    }
    if (this.streamAsrProc) {
      try {
        this.streamAsrProc.kill('SIGTERM');
      } catch {}
      this.streamAsrProc = null;
      this.streamAsrReady = false;
    }
    if (this.transProc) {
      try {
        this.transProc.kill('SIGTERM');
      } catch {}
      this.transProc = null;
    }
  }

  /**
   * 随 SimpleUI 进程退出时强制清扫（SIGKILL 双保险）
   */
  shutdownForce() {
    this.vad.unload();
    if (this.streamAsrProc) {
      try {
        this.streamAsrProc.kill('SIGKILL');
      } catch {}
      this.streamAsrProc = null;
      this.streamAsrReady = false;
    }
    if (this.transProc) {
      try {
        this.transProc.kill('SIGKILL');
      } catch {}
      this.transProc = null;
    }
    this.cleanStaleProcesses();
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
   * 拉起原生 CoreML 流式语音识别守护进程 (bin/subtitle_stream_asr)
   */
  async ensureStreamAsrDaemon() {
    if (this.streamAsrProc && !this.streamAsrProc.killed && this.streamAsrReady) {
      return true;
    }
    const possiblePaths = [
      path.join(__dirname, '../bin/subtitle_stream_asr'),
      path.join(__dirname, '../../bin/subtitle_stream_asr'),
      path.join(process.cwd(), 'bin/subtitle_stream_asr'),
      '/Applications/SimpleUI.app/Contents/Resources/bin/subtitle_stream_asr',
    ];
    const binPath = possiblePaths.find((p) => fs.existsSync(p));
    if (!binPath) {
      console.warn('[Subtitles] 未找到 bin/subtitle_stream_asr 可执行文件');
      return false;
    }

    return new Promise((resolve) => {
      try {
        console.log('[Subtitles] [2/3] 正在加载 M系列 ANE 原生流式 ASR 引擎 (Nemotron-Speech-Streaming-0.6B)...');
        const proc = spawn(binPath, [], { stdio: ['pipe', 'pipe', 'pipe'] });
        this.streamAsrProc = proc;
        this.streamAsrReady = false;
        this.asrStdoutBuf = '';

        try {
          if (proc.pid) fs.writeFileSync(ASR_PID_FILE, String(proc.pid));
        } catch {}

        let resolvedInit = false;
        proc.stdout.on('data', (chunk) => {
          this.asrStdoutBuf += chunk.toString('utf-8');
          let nlIdx;
          while ((nlIdx = this.asrStdoutBuf.indexOf('\n')) !== -1) {
            const line = this.asrStdoutBuf.slice(0, nlIdx).trim();
            this.asrStdoutBuf = this.asrStdoutBuf.slice(nlIdx + 1);
            if (!line) continue;

            if (line === 'READY') {
              this.streamAsrReady = true;
              console.log('[Subtitles] ✅ [2/3] ANE 原生 160ms 流式 ASR 引擎已就绪');
              if (!resolvedInit) {
                resolvedInit = true;
                resolve(true);
              }
              continue;
            }

            const cb = this.asrPendingCallbacks.shift();
            if (cb) {
              try {
                cb(JSON.parse(line));
              } catch {
                cb({ ok: false, text: '', delta: '', eou: false });
              }
            }
          }
        });

        proc.on('exit', () => {
          if (this.streamAsrProc === proc) {
            this.streamAsrProc = null;
            this.streamAsrReady = false;
            try {
              if (fs.existsSync(ASR_PID_FILE)) fs.unlinkSync(ASR_PID_FILE);
            } catch {}
          }
          while (this.asrPendingCallbacks.length > 0) {
            const cb = this.asrPendingCallbacks.shift();
            cb({ ok: false, text: '', delta: '', eou: false });
          }
          if (!resolvedInit) {
            resolvedInit = true;
            resolve(false);
          }
        });

        setTimeout(() => {
          if (!resolvedInit) {
            resolvedInit = true;
            resolve(this.streamAsrReady);
          }
        }, 10000);
      } catch {
        resolve(false);
      }
    });
  }

  /**
   * 向 ANE 流式守护进程发送单帧命令
   */
  async sendAsrCommand(payloadObj) {
    if (!this.streamAsrProc || this.streamAsrProc.killed || !this.streamAsrReady || !this.streamAsrProc.stdin.writable) {
      return { ok: false, text: '', delta: '', eou: false };
    }

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const idx = this.asrPendingCallbacks.indexOf(onResp);
        if (idx !== -1) this.asrPendingCallbacks.splice(idx, 1);
        resolve({ ok: false, text: '', delta: '', eou: false, timeout: true });
      }, 3000);

      const onResp = (res) => {
        clearTimeout(timer);
        resolve(res);
      };

      this.asrPendingCallbacks.push(onResp);
      this.streamAsrProc.stdin.write(JSON.stringify(payloadObj) + '\n');
    });
  }

  /**
   * 按阶段拉起三级模型并实时推送加载进度
   */
  async ensureServersRunning(expectedGen = this.sessionGeneration) {
    const check = this.checkModelsReadiness();
    if (!check.allReady) return false;

    this.ensureWatchdogs();

    // 阶段 1/3：加载 TEN-VAD (ONNX)
    this.loadingStage = 0;
    this.loadingStepKey = 'vad';
    this.broadcastStatus();
    const vadOk = await this.vad.ensureLoaded();
    if (!vadOk || expectedGen !== this.sessionGeneration) return false;

    // 阶段 2/3：加载 Nemotron-Speech-Streaming-0.6B (CoreML ANE)
    this.loadingStage = 1;
    this.loadingStepKey = 'asr';
    this.broadcastStatus();
    const asrOk = await this.ensureStreamAsrDaemon();
    if (!asrOk || expectedGen !== this.sessionGeneration) return false;

    // 阶段 3/3：加载 Index-Translate-2B (llama-server 端口 1249)
    this.loadingStage = 2;
    this.loadingStepKey = 'translate';
    this.broadcastStatus();

    let transAlive = await this.checkHealth(1249);
    if (!transAlive && !this.transProc) {
      const llamaBin = getLlamaServerBin();
      const llamaEnv = {
        ...process.env,
        DYLD_LIBRARY_PATH: path.join(userConfigDir, 'runtime', 'llama', 'lib'),
      };
      const transModel = path.join(SUBTITLE_MODELS_DIR, 'index_translate_2b_q4_k_m.gguf');
      console.log(`[Subtitles] [3/3] 正在加载 Index-Translate-2B Metal 翻译服务 (端口 1249)...`);
      const proc = spawn(
        llamaBin,
        [
          '-m',
          transModel,
          '--port',
          '1249',
          '-ngl',
          '99',
          '--no-warmup',
          '-c',
          '2048',
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

      proc.on('exit', () => {
        if (this.transProc === proc) {
          this.transProc = null;
          try {
            if (fs.existsSync(TRANS_PID_FILE)) fs.unlinkSync(TRANS_PID_FILE);
          } catch {}
        }
      });

      for (let i = 0; i < 30; i++) {
        if (expectedGen !== this.sessionGeneration) return false;
        await new Promise((r) => setTimeout(r, 300));
        if (await this.checkHealth(1249)) {
          transAlive = true;
          break;
        }
      }
    }

    return vadOk && asrOk && transAlive;
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

  broadcastStatus() {
    const check = this.checkModelsReadiness();
    this.broadcast('status', {
      running: this.isRunning,
      paused: this.isPaused,
      loading: this.isLoadingModels,
      modelsLoaded: this.modelsLoaded,
      loadingStage: this.loadingStage,
      loadingStepKey: this.loadingStepKey,
      allReady: check.allReady,
      missingModels: check.missing,
      modelsStatus: check.status,
      sourceLang: this.config.sourceLang,
      targetLang: this.config.targetLang,
      clientCount: this.sseClients.size,
      recent: this.history.slice(-20),
    });
  }

  /**
   * 调用 Index-Translate-2B 极速神经机器翻译（严格对齐官方单句中文指令模板 + 禁用思考块 + 串行队列防并发乱序）
   */
  async callTranslate(enText) {
    if (!this.translateChain) {
      this.translateChain = Promise.resolve();
    }
    const runTask = () =>
      new Promise((resolve) => {
        const prompt = `请将以下文本翻译为中文，直接输出翻译结果，不要进行任何解释。\n\n${enText}`;
        const body = JSON.stringify({
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 200,
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

    const p = this.translateChain.then(runTask, runTask);
    this.translateChain = p.catch(() => {});
    return p;
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

    const durationMs = Math.round((pcmBuffer.length / 2 / 16000) * 1000);
    const vadRes = this.vad.detectVoice(pcmBuffer);

    if (vadRes.isSpeech && !isFinal) {
      this.silenceMs = 0;
      this.speechMs += durationMs;
    } else {
      this.silenceMs += durationMs;
    }

    // 即使当前帧静音，只要句子尚未定稿（currentWords 非空），仍推送静音给 RNN-T 以触发尾部词和标点吐出
    const shouldFeedAsr = vadRes.isSpeech || this.currentWords.length > 0 || isFinal;
    let eouSignal = false;

    if (shouldFeedAsr && pcmBuffer.length > 0) {
      const asrResp = await this.sendAsrCommand({
        cmd: 'push',
        pcm_b64: pcmBuffer.toString('base64'),
      });

      if (asrResp && asrResp.ok) {
        eouSignal = Boolean(asrResp.eou);
        const fullText = (asrResp.text || '').trim();
        if (fullText) {
          const allWords = fullText.split(/\s+/).filter(Boolean);
          // 剥离本轮底层会话中已因意群软切而消费掉的前缀词
          const skipCount = Math.min(this.consumedPrefixWords.length, allWords.length);
          this.currentWords = allWords.slice(skipCount);
        }
      }
    }

    if (isFinal) {
      this.silenceMs = Math.max(this.silenceMs, this.config.shortSentenceSilenceMs + 100);
    }

    // 执行方案 B 双层滞回静音 + 句法回退软切判定
    const cutDecision = this.evaluateEndpointing(eouSignal, isFinal);
    if (cutDecision.cutCount > 0) {
      const committedWords = this.currentWords.slice(0, cutDecision.cutCount);
      const remainingWords = this.currentWords.slice(cutDecision.cutCount);

      this.currentWords = remainingWords;
      this.consumedPrefixWords.push(...committedWords);

      // 若切完后无剩余词：重置文本缓冲；仅在真正长静音结束（isFinal）或句末标点+静音时才 hard reset 解码器，
      // 句中软切或短停顿保持 RNN-T 声学上下文不断开！
      if (remainingWords.length === 0) {
        this.consumedPrefixWords = [];
        this.speechMs = 0;
        const shouldHardReset = isFinal || (cutDecision.reason === 'sentence-end' && this.silenceMs >= 480);
        await this.sendAsrCommand({ cmd: 'reset', hard: shouldHardReset });
      }

      // 0ms 乐观上推原句 + 异步极速翻译回填
      this.commitAndTranslateAsync(committedWords, cutDecision.reason);
    }

    // 实时更新底部流式字幕区
    this.broadcastDraft();
    return {
      ok: true,
      committed: cutDecision.cutCount > 0,
      reason: cutDecision.reason || 'streaming',
    };
  }

  /**
   * 方案 B：双层滞回静音 + 句法回退软切状态机
   *   第 1 层（有句末标点 . ? !）：满 3 词且（后续已出词 或 160ms 微停顿）即刻切句
   *   第 2 层（16~28 词长句意群回退软切）：优先找逗号/分号，其次找并列/从属连词前切开，避开冠词/介词悬挂尾词
   *   第 3 层（无句末标点双层滞回静音）：带逗号需 480ms 静音；纯无标点需连续 960ms 静音才切，彻底容忍慢语速
   */
  evaluateEndpointing(eouSignal = false, isFinal = false) {
    const words = this.currentWords;
    const n = words.length;
    if (n === 0) return { cutCount: 0, reason: null };

    // 1. 第 1 层：查找句内已出现的句末标点（. ? !）
    for (let i = 0; i < n; i++) {
      if (/[.?!]$/.test(words[i])) {
        const wordsUpToPunct = i + 1;
        const hasFollowingWord = i < n - 1;
        const hasMicroPause = this.silenceMs >= this.config.punctMicroPauseMs;

        if (
          wordsUpToPunct >= this.config.minWordsForPunctCut &&
          (hasFollowingWord || hasMicroPause || eouSignal || isFinal)
        ) {
          return { cutCount: wordsUpToPunct, reason: 'sentence-end' };
        }
        // 1~2 词的短句（如 "Got it." / "Thank you."）需确认静音 >= 640ms 或后面已跟出 >=2 个新词才切
        if (
          wordsUpToPunct < this.config.minWordsForPunctCut &&
          (this.silenceMs >= 640 || n - wordsUpToPunct >= 2 || isFinal)
        ) {
          return { cutCount: wordsUpToPunct, reason: 'short-sentence' };
        }
      }
    }

    // 2. 第 2 层：长句防超长句法回退软切（16 ~ 28 词）
    if (n >= this.config.softCutStartWords) {
      // 2a. 优先逆向寻找第 6 词之后的最后一个逗号/分号/冒号/破折号
      for (let i = n - 1; i >= 6; i--) {
        if (/[,;:—]$/.test(words[i])) {
          return { cutCount: i + 1, reason: 'clause-comma' };
        }
      }
      // 2b. 满 18 词时，逆向寻找第 8 词之后的并列/从属连词边界（在连词前切开，让连词领起下一分句）
      if (n >= 18) {
        for (let i = n - 2; i >= 8; i--) {
          const cleanW = cleanWordToken(words[i]);
          const prevClean = cleanWordToken(words[i - 1]);
          if (CLAUSE_CONJUNCTIONS.has(cleanW) && !NON_TERMINAL_TAIL_WORDS.has(prevClean)) {
            return { cutCount: i, reason: 'clause-conjunction' };
          }
        }
      }
      // 2c. 满 22 词且出现 >= 480ms 真实换气停顿时，若末尾词不是冠词/代词/介词/助动词，才允许在换气处软切
      if (n >= this.config.clausePauseWords && this.silenceMs >= 480) {
        const lastClean = cleanWordToken(words[n - 1]);
        if (!NON_TERMINAL_TAIL_WORDS.has(lastClean)) {
          return { cutCount: n, reason: 'clause-pause' };
        }
      }
    }

    // 3. 达到绝对硬上限（28 词）：逆向回退避开冠词/介词/代词（绝不在 "this | Apple" 中间切断）
    if (n >= this.config.hardCutMaxWords) {
      let cutIdx = this.config.hardCutMaxWords;
      while (cutIdx > 14 && NON_TERMINAL_TAIL_WORDS.has(cleanWordToken(words[cutIdx - 1]))) {
        cutIdx--;
      }
      return { cutCount: cutIdx, reason: 'length-cap' };
    }

    // 4. 第 3 层：无句末标点时的双层滞回静音门限
    const lastWord = words[n - 1] || '';
    // 4a. 若当前词末尾本身带有逗号/分号，且满 5 词、停顿满 480ms，顺势按子句切开
    if (n >= 5 && /[,;:—]$/.test(lastWord) && this.silenceMs >= this.config.commaPauseSilenceMs) {
      return { cutCount: n, reason: 'comma-pause' };
    }

    // 4b. 纯无标点状态：必须连续静音满 960ms（6帧）或收到客户端 1.44s 最终静音信号才切句
    if (n >= this.config.minWordsForPunctCut && (this.silenceMs >= this.config.unpunctuatedSilenceMs || isFinal)) {
      return { cutCount: n, reason: 'silence' };
    }
    if (n > 0 && (this.silenceMs >= this.config.shortSentenceSilenceMs || isFinal)) {
      return { cutCount: n, reason: 'short-silence' };
    }

    return { cutCount: 0, reason: null };
  }

  /**
   * 0ms 乐观上推原句至上方历史区，并异步调用 Index-Translate-2B 回填中文译文
   * （保留模型原生标点，绝不向无标点软切分句强行补假句号 '.'）
   */
  commitAndTranslateAsync(words, reason) {
    const sentence = words.join(' ').trim();
    if (!sentence) return;

    const segId = `sub_${Date.now()}_${this.seqId++}`;
    this.lastCommittedEn = sentence;

    const record = {
      id: segId,
      status: 'translating',
      source_lang: 'en',
      target_lang: 'zh',
      source_text: sentence,
      target_text: '',
      reason,
      createdAt: Date.now(),
    };

    this.history.push(record);
    if (this.history.length > 200) this.history.shift();

    // 第 0ms：立刻广播 commit 事件，前端将原句瞬间推至上方，底部即刻清空继续流式吐字
    this.broadcast('commit', record);

    // 异步极速翻译并在 ~180ms 后广播 translated 回填译文
    this.callTranslate(sentence)
      .then((zhText) => {
        record.target_text = zhText || sentence;
        record.status = 'finalized';
        this.broadcast('translated', record);
        this.broadcast('finalized', record);
        console.log(`[Subtitles] 🎯 定稿(${reason}): "${sentence}" -> "${record.target_text}"`);
      })
      .catch(() => {
        record.target_text = sentence;
        record.status = 'finalized';
        this.broadcast('translated', record);
      });
  }

  broadcastDraft() {
    const stable = this.currentWords.join(' ');
    this.broadcast('draft', { stable, pending: '' });
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

    // 2. 状态查询
    if (pathname === '/api/subtitles/status' && req.method === 'GET') {
      const check = this.checkModelsReadiness();
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(
        JSON.stringify({
          running: this.isRunning,
          paused: this.isPaused,
          loading: this.isLoadingModels,
          modelsLoaded: this.modelsLoaded,
          loadingStage: this.loadingStage,
          loadingStepKey: this.loadingStepKey,
          allReady: check.allReady,
          missingModels: check.missing,
          modelsStatus: check.status,
          config: this.config,
          clientCount: this.sseClients.size,
          historyCount: this.history.length,
          recent: this.history.slice(-30),
        })
      );
      return;
    }

    // 3. 清空历史记录
    if (pathname === '/api/subtitles/clear' && req.method === 'POST') {
      this.history = [];
      this.currentWords = [];
      this.consumedPrefixWords = [];
      this.lastCommittedEn = '';
      this.sendAsrCommand({ cmd: 'reset', hard: true }).catch(() => {});
      this.broadcastDraft();
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ ok: true, cleared: true }));
      return;
    }

    // 4. 清理旧模型与临时缓存
    if (pathname === '/api/subtitles/clean' && req.method === 'POST') {
      const result = this.cleanLegacyModels();
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ ok: true, ...result }));
      return;
    }

    // 5. 开启字幕窗口：按需加载全部三个模型并在就绪后启动监听
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

    // 6. 窗口内暂停/继续内录（保持模型在内存中就绪，不卸载）
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

    // 7. 关闭字幕窗口：立刻停止并卸载全部三个模型与后台子进程
    if (pathname === '/api/subtitles/stop' && req.method === 'POST') {
      this.stop();
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ ok: true, running: false, modelsLoaded: false }));
      return;
    }

    // 8. 模型清单
    if (pathname === '/api/subtitles/models' && req.method === 'GET') {
      const check = this.checkModelsReadiness();
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(
        JSON.stringify({
          ok: true,
          allReady: check.allReady,
          models: Object.entries(check.status).map(([k, v]) => ({ key: k, ...v })),
          storageDir: SUBTITLE_MODELS_DIR,
        })
      );
      return;
    }

    // 9. 实时 160ms 增量音频帧喂入端点（支持裸 PCM Int16LE 或 WAV）
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

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
  }
}

export const subtitleService = new SubtitleService();
