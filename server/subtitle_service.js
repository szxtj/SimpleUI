// 实时双语字幕服务端托管模块 (Subtitle Service — 三级极速流式架构)
// 纯端侧离线三级专属流水线（与语音输入服务 1236 完全独立）：
//   - 专属存储目录：~/Library/Application Support/SimpleUI/models/subtitles_pipeline/
//   - 第 1 级：TEN-framework/ten-vad                              -> ten_vad.onnx (16ms 帧级声学活动检测)
//   - 第 2 级：aufklarer/Nemotron-Speech-Streaming-0.6B-CoreML-INT8 -> nemotron_asr/ (M系列 ANE 160ms 原生流式英文识别+标点)
//   - 第 3 级：IndexTeam/Index-Translate-2B-GGUF                  -> index_translate_2b_q4_k_m.gguf (llama-server 1249 极速翻译)

import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const HOME = os.homedir();
const userConfigDir = path.join(HOME, 'Library', 'Application Support', 'SimpleUI');
const CONFIG_FILE = path.join(userConfigDir, 'subtitles_config.json');

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
  autoStart: true,
  sampleRate: 16000,
  chunkDurationMs: 160,
  sourceLang: 'en',
  targetLang: 'zh',
  // 三级智能断句参数（兼顾句末即停与防止单句过长）
  minWordsForPunctCut: 3,      // 至少 3 个词才允许标点直接断句
  softCutStartWords: 14,       // 达到 14 词进入“意群/逗号/连词软切”模式
  hardCutMaxWords: 22,         // 达到 22 词强制断句，确保单条字幕不超过 1~2 行
  shortSentenceSilenceMs: 680, // 短句（1~2词）需 680ms 静音才定稿，防句首碎片
  normalPauseSilenceMs: 450,   // 标准句（>=3词）450ms 自然换气停顿即定稿
  punctMicroPauseMs: 160,      // 句末标点配合 160ms 微停顿（或后续已出新词）即刻断句
};

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
]);

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
    if (this.loaded) return true;
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
      return false;
    }
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
    this.isRunning = false;
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

    // 串行处理锁，杜绝并发帧乱序
    this.processingChain = Promise.resolve();

    // 流式断句状态机
    this.currentWords = [];       // 当前正在底部流式吐出的词序列
    this.consumedPrefixWords = []; // 当前底层 ASR 会话中已被切走定稿的前缀词（用于软切后去重）
    this.silenceMs = 0;           // 连续静音毫秒数
    this.speechMs = 0;            // 当前句累积人声毫秒数
    this.lastCommittedEn = '';    // 上一句定稿英文（供翻译模型做上下文消歧）

    this.loadConfig();
    this.cleanLegacyModels();

    process.on('exit', () => this.stopServers());
    process.on('SIGINT', () => this.stopServers());
    process.on('SIGTERM', () => this.stopServers());
  }

  loadConfig() {
    try {
      if (fs.existsSync(CONFIG_FILE)) {
        const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
        const parsed = JSON.parse(raw);
        this.config = { ...DEFAULT_CONFIG, ...parsed };
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

    // 清理残留的 .part 文件
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
    console.log('[Subtitles] 实时英译中流式字幕服务已挂载 (TEN-VAD + Nemotron ANE + Index-Translate)');
    if (this.config.autoStart) {
      this.start();
    }
  }

  async start() {
    this.isRunning = true;
    console.log('[Subtitles] 实时双语字幕监听已启动');
    this.broadcastStatus();

    this.ensureServersRunning().catch((err) => {
      console.error('[Subtitles] 启动后台流式推演服务失败:', err.message);
    });
  }

  stop() {
    this.isRunning = false;
    console.log('[Subtitles] 实时双语字幕监听已暂停');
    this.broadcastStatus();
  }

  stopServers() {
    if (this.streamAsrProc) {
      try {
        this.streamAsrProc.kill();
      } catch {}
      this.streamAsrProc = null;
      this.streamAsrReady = false;
    }
    if (this.transProc) {
      try {
        this.transProc.kill();
      } catch {}
      this.transProc = null;
    }
  }

  async checkHealth(port) {
    return new Promise((resolve) => {
      const req = http.get(`http://127.0.0.1:${port}/health`, { timeout: 1200 }, (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      });
      req.on('error', () => resolve(false));
      req.setTimeout(1200, () => {
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
        console.log('[Subtitles] 正在拉起 M系列 ANE 原生流式 ASR 引擎 (Nemotron-Speech-Streaming-0.6B)...');
        const proc = spawn(binPath, [], { stdio: ['pipe', 'pipe', 'pipe'] });
        this.streamAsrProc = proc;
        this.streamAsrReady = false;
        this.asrStdoutBuf = '';

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
              console.log('[Subtitles] ✅ ANE 原生 160ms 流式 ASR 引擎已就绪');
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
          this.streamAsrProc = null;
          this.streamAsrReady = false;
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
        }, 8000);
      } catch {
        resolve(false);
      }
    });
  }

  /**
   * 向 ANE 流式守护进程发送单帧命令
   */
  async sendAsrCommand(payloadObj) {
    const ok = await this.ensureStreamAsrDaemon();
    if (!ok || !this.streamAsrProc || !this.streamAsrProc.stdin.writable) {
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

  async ensureServersRunning() {
    const check = this.checkModelsReadiness();
    if (!check.allReady) return false;

    await this.vad.ensureLoaded();
    const asrOk = await this.ensureStreamAsrDaemon();

    // 确保 Index-Translate-2B 服务 (端口 1249)
    let transAlive = await this.checkHealth(1249);
    if (!transAlive && !this.transProc) {
      const llamaBin = getLlamaServerBin();
      const llamaEnv = {
        ...process.env,
        DYLD_LIBRARY_PATH: path.join(userConfigDir, 'runtime', 'llama', 'lib'),
      };
      const transModel = path.join(SUBTITLE_MODELS_DIR, 'index_translate_2b_q4_k_m.gguf');
      console.log(`[Subtitles] 正在拉起 Index-Translate-2B Metal 翻译服务 (端口 1249, 关闭 Thinking)...`);
      this.transProc = spawn(
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

      this.transProc.on('exit', () => {
        this.transProc = null;
      });

      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 350));
        if (await this.checkHealth(1249)) {
          transAlive = true;
          break;
        }
      }
    }

    return asrOk && transAlive;
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
   * 调用 Index-Translate-2B 极速神经机器翻译（严格对齐官方中文指令模板 + 禁用思考块 + 1句上文消歧）
   */
  async callTranslate(enText, prevEnContext = '') {
    const prompt = prevEnContext
      ? `请结合上文语境，将以下【当前英文】翻译为自然流畅的中文，直接输出【当前英文】的中文译文，不要进行任何解释。\n【上文】：${prevEnContext}\n【当前英文】：${enText}`
      : `请将以下文本翻译为中文，直接输出翻译结果，不要进行任何解释。\n\n${enText}`;

    return new Promise((resolve) => {
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
    if (!this.isRunning) return { ok: false, reason: 'paused' };
    const check = this.checkModelsReadiness();
    if (!check.allReady) {
      return { ok: false, error: 'MODELS_NOT_READY', missing: check.missing };
    }

    const ready = await this.ensureServersRunning();
    if (!ready) {
      return { ok: false, error: 'SERVERS_STARTING' };
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

    // 即使当前帧静音，只要句子尚未定稿（currentWords 非空），仍推送一小段静音给 RNN-T 以触发尾部词吐出
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

    // 执行三级智能断句判定
    const cutDecision = this.evaluateEndpointing(eouSignal, isFinal);
    if (cutDecision.cutCount > 0) {
      const committedWords = this.currentWords.slice(0, cutDecision.cutCount);
      const remainingWords = this.currentWords.slice(cutDecision.cutCount);

      this.currentWords = remainingWords;
      this.consumedPrefixWords.push(...committedWords);

      // 若在静音处完整断句（无剩余词），重置底层 ASR 文本缓冲以便下一句清爽开始
      if (remainingWords.length === 0) {
        this.consumedPrefixWords = [];
        this.speechMs = 0;
        await this.sendAsrCommand({ cmd: 'reset', hard: cutDecision.reason === 'silence' || isFinal });
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
   * 三级智能断句状态机：
   *   1) 标准句末（. ? !）即停
   *   2) 14~22 词意群/逗号/连词软切（防止单句过长）
   *   3) 静音与短句保护兜底
   */
  evaluateEndpointing(eouSignal = false, isFinal = false) {
    const words = this.currentWords;
    const n = words.length;
    if (n === 0) return { cutCount: 0, reason: null };

    // 1. 查找句内已出现的句末标点（. ? !）
    for (let i = 0; i < n; i++) {
      if (/[.?!]$/.test(words[i])) {
        const wordsUpToPunct = i + 1;
        const hasFollowingWord = i < n - 1;
        const hasMicroPause = this.silenceMs >= this.config.punctMicroPauseMs;

        // 满 3 词且（后面已跟出新词 或 有微停顿 或 收到 EOU/Final），立即在句号处切开
        if (
          wordsUpToPunct >= this.config.minWordsForPunctCut &&
          (hasFollowingWord || hasMicroPause || eouSignal || isFinal)
        ) {
          return { cutCount: wordsUpToPunct, reason: 'sentence-end' };
        }
        // 1~2 词的极短句（如 "Got it." / "Thank you."）需确认静音 >= 680ms 才切，防句首缩写误切
        if (
          wordsUpToPunct < this.config.minWordsForPunctCut &&
          (this.silenceMs >= this.config.shortSentenceSilenceMs || isFinal)
        ) {
          return { cutCount: wordsUpToPunct, reason: 'short-sentence' };
        }
      }
    }

    // 2. 达到防超长软切区间（14 ~ 22 词）：寻找逗号、分号或并列/从属连词优雅停住
    if (n >= this.config.softCutStartWords) {
      // 优先找第 6 词之后的最后一个逗号/分号/冒号
      for (let i = n - 1; i >= 6; i--) {
        if (/[,;:]$/.test(words[i])) {
          return { cutCount: i + 1, reason: 'clause-comma' };
        }
      }
      // 其次找第 8 词之后的连词边界（在连词前切开，让连词领起下一句）
      for (let i = n - 1; i >= 8; i--) {
        const cleanW = words[i].toLowerCase().replace(/^[^a-z]+|[^a-z]+$/g, '');
        if (CLAUSE_CONJUNCTIONS.has(cleanW) && i >= 10) {
          return { cutCount: i, reason: 'clause-conjunction' };
        }
      }
      // 若在长句期间出现 >= 220ms 的微换气停顿，立即在当前词尾断开
      if (this.silenceMs >= 220) {
        return { cutCount: n, reason: 'clause-pause' };
      }
    }

    // 3. 达到绝对硬上限（22 词）：立即截断，保证每条字幕绝不超长
    if (n >= this.config.hardCutMaxWords) {
      return { cutCount: this.config.hardCutMaxWords, reason: 'length-cap' };
    }

    // 4. 自然换气静音兜底
    if (n >= this.config.minWordsForPunctCut && (this.silenceMs >= this.config.normalPauseSilenceMs || eouSignal || isFinal)) {
      return { cutCount: n, reason: 'silence' };
    }
    if (n > 0 && (this.silenceMs >= this.config.shortSentenceSilenceMs || isFinal)) {
      return { cutCount: n, reason: 'short-silence' };
    }

    return { cutCount: 0, reason: null };
  }

  /**
   * 0ms 乐观上推原句至上方历史区，并异步调用 Index-Translate-2B 回填中文译文
   */
  commitAndTranslateAsync(words, reason) {
    let sentence = words.join(' ').trim();
    if (!sentence) return;

    // 若结尾无标点，补上句号使展示与翻译更规范
    if (!/[.?!,;—\-]$/.test(sentence)) {
      sentence += '.';
    }

    const segId = `sub_${Date.now()}_${this.seqId++}`;
    const prevContext = this.lastCommittedEn;
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
    this.callTranslate(sentence, prevContext)
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

    // 5. 启动监听
    if (pathname === '/api/subtitles/start' && req.method === 'POST') {
      this.start();
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ ok: true, running: true }));
      return;
    }

    // 6. 停止监听
    if (pathname === '/api/subtitles/stop' && req.method === 'POST') {
      this.stop();
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ ok: true, running: false }));
      return;
    }

    // 7. 模型清单
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

    // 8. 实时 160ms 增量音频帧喂入端点（支持裸 PCM Int16LE 或 WAV）
    if (pathname === '/api/subtitles/feed' && req.method === 'POST') {
      const isFinal = url.searchParams.get('is_final') === '1';
      const format = url.searchParams.get('format') || 'pcm';
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', async () => {
        const check = this.checkModelsReadiness();
        if (!check.allReady) {
          res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(
            JSON.stringify({
              ok: false,
              error: 'MODELS_NOT_READY',
              missing: check.missing,
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
