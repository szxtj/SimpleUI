// 实时双语字幕服务端托管模块 (Subtitle Service)
// 纯端侧离线四级专属流水线：
//   - 专属存储目录：~/Library/Application Support/SimpleUI/models/subtitles_pipeline/
//   - 第 1 级：TEN-framework/ten-vad                    -> ten_vad.onnx
//   - 第 2 级：ggml-org/Qwen3-ASR-1.7B-GGUF             -> qwen3_asr_1.7b.gguf + mmproj (llama-server 1248)
//   - 第 3 级：aufklarer/Qwen3-ForcedAligner-0.6B-CoreML -> audio_encoder.mlmodelc (词级对齐)
//   - 第 4 级：IndexTeam/Index-Translate-2B-GGUF        -> index_translate_2b_q4_k_m.gguf (llama-server 1249)

import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import {
  punctuationEngine,
  stripTerminalPunctuation,
  PUNCT_PERIOD,
  PUNCT_QUESTION,
} from './punctuation.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const HOME = os.homedir();
const userConfigDir = path.join(HOME, 'Library', 'Application Support', 'SimpleUI');
const CONFIG_FILE = path.join(userConfigDir, 'subtitles_config.json');

// 专属隔离模型目录
export const SUBTITLE_MODELS_DIR = path.join(userConfigDir, 'models', 'subtitles_pipeline');

export const REQUIRED_MODELS = {
  vad: {
    name: 'TEN-VAD (声学活动检测)',
    relPath: 'ten_vad.onnx',
    minBytes: 300 * 1024,
    sizeDesc: '315 KB',
  },
  asr: {
    name: 'Qwen3-ASR-1.7B (高精语音识别)',
    relPath: 'qwen3_asr_1.7b.gguf',
    minBytes: 2000 * 1024 * 1024,
    sizeDesc: '2.06 GB',
  },
  asr_proj: {
    name: 'Qwen3-ASR 声学编码投影',
    relPath: 'mmproj_qwen3_asr_1.7b.gguf',
    minBytes: 300 * 1024 * 1024,
    sizeDesc: '339 MB',
  },
  aligner: {
    name: 'Qwen3-ForcedAligner-0.6B (ANE 词级毫秒对齐)',
    relPath: path.join('audio_encoder.mlmodelc', 'weights', 'weight.bin'),
    minBytes: 310 * 1024 * 1024,
    sizeDesc: '302.3 MB',
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
  frameDurationMs: 30,
  prePaddingMs: 120,
  hangoverNormalMs: 350,
  hangoverSoftMs: 150,
  maxChunkDurationMs: 3800,
  sourceLang: 'auto',
  targetLang: 'zh',
  karaokeEnabled: true,
  // —— 句末判定（取代原先按静音时长机械切分）——
  // 句末右侧至少要有这么多个「已稳定字符」才采信该处的句末判定。
  // 独立标点模型在文本被截断处会拒绝表态（实测 engine[NONE 0.54]），
  // 必须等它看到下一段右上下文后仍然判句末，才算数。
  rightContextChars: 8,
  // 独立标点模型给出句末的最低置信度
  punctMinProb: 0.5,
  // 句末之后至少还要有这么多「已稳定词」，才采信该处的句末。
  // 为什么不能只看右上下文字符数：ASR 在音频被截断处会自动补句号（伪句末），
  // 实测 "placed. over it." 里 "placed." 之后刚好有 9 个字符，字符数判据会被骗过去，
  // 于是整句被切成 "A light-sensitive film is put on is placed." + "over it." 两块碎片。
  // 要求后面还有 3 个稳定词，才能证明音频确实没有在那里截断。
  minWordsAfterEnd: 3,
  // 长句兜底：说到这么多词还没有句末信号时，在**最后一个逗号**处断开。
  // 不是妥协而是必需 —— ASR 耗时随音频长度线性增长（实测 6s 音频要 1030ms），
  // 放任音频累积会让字幕越来越滞后；而逗号本来就是句内自然停顿，
  // 比「到字数就任意硬切」合理得多。字幕一行也放不下超长句。
  maxWordsCommaCut: 20,
  // 连逗号都没有时的最后手段
  maxWordsHardLimit: 32,
};

// 归一化后用于比较的词形：ASR 会在稳定文本上补标点 / 改大小写，
// 若按字面比较，稳定前缀会在每次 ASR 补标点时断裂，稳定前缀永远长不大。
function normWord(w) {
  return String(w).toLowerCase().replace(/^[.,!?;:。？！，]+|[.,!?;:。？！，]+$/g, '');
}

// 按词取两条 ASR 假设的最长公共前缀（Local-Agreement LA-2 的骨架）
function commonPrefixLen(aWords, bWords) {
  const n = Math.min(aWords.length, bWords.length);
  let i = 0;
  while (i < n && normWord(aWords[i]) === normWord(bWords[i])) i++;
  return i;
}

function cleanAsrText(raw) {
  if (!raw || typeof raw !== 'string') return '';
  let text = raw;
  const asrIdx = text.indexOf('<asr_text>');
  if (asrIdx !== -1) {
    text = text.substring(asrIdx + 10);
  } else {
    text = text.replace(/^language\s+\w+\s*/i, '');
  }
  // 过滤多余特殊符号
  text = text.replace(/<\|.*?\|>/g, '').replace(/<\/?[^>]+(>|$)/g, '').trim();
  // 过滤纯占位语
  if (/^none$/i.test(text)) return '';
  return text;
}

function getLlamaServerBin() {
  const customPath = path.join(userConfigDir, 'runtime', 'llama', 'bin', 'llama-server');
  if (fs.existsSync(customPath)) return customPath;
  const appPath = '/Applications/SimpleUI.app/Contents/Resources/bin/llama-server';
  if (fs.existsSync(appPath)) return appPath;
  return 'llama-server';
}

class SubtitleService {
  constructor() {
    this.config = { ...DEFAULT_CONFIG };
    this.isRunning = false;
    this.sseClients = new Set();
    this.history = [];
    this.seqId = 1;
    this.asrProc = null;
    this.transProc = null;
    this.isProcessing = false;
    this.chunkQueue = [];
    this.isAsrBusy = false;
    this.finalizedSentenceKeys = new Set();
    // 当前正在成句的增量状态：
    //   lastCur   上一轮 ASR 输出（已剔除已消费部分），用于 LA-2 比对
    //   committed 已被确认、绝不再改写的稳定词序列
    //   consumed  已经成稿切走的词，下一轮 ASR 若仍吐出它们则跳过
    this.segment = { lastCur: [], committed: [], consumed: [] };
    this.loadConfig();

    // 进程退出时兜底清理子进程
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
    console.log('[Subtitles] 实时双语字幕服务已挂载 (四级专属架构)');
    if (this.config.autoStart) {
      this.start();
    }
  }

  async start() {
    this.isRunning = true;
    console.log('[Subtitles] 实时双语字幕监听已启动');
    this.broadcastStatus();

    // 确保后台推演服务器就位
    this.ensureServersRunning().catch((err) => {
      console.error('[Subtitles] 启动模型后台推演服务失败:', err.message);
    });
  }

  stop() {
    this.isRunning = false;
    console.log('[Subtitles] 实时双语字幕监听已暂停');
    this.broadcastStatus();
  }

  stopServers() {
    if (this.asrProc) {
      try { this.asrProc.kill(); } catch {}
      this.asrProc = null;
    }
    if (this.transProc) {
      try { this.transProc.kill(); } catch {}
      this.transProc = null;
    }
    if (this.aneProc) {
      try { this.aneProc.kill(); } catch {}
      this.aneProc = null;
    }
  }

  async checkHealth(port) {
    return new Promise((resolve) => {
      const req = http.get(`http://127.0.0.1:${port}/health`, { timeout: 1200 }, (res) => {
        resolve(res.statusCode === 200);
      });
      req.on('error', () => resolve(false));
      req.setTimeout(1200, () => {
        req.destroy();
        resolve(false);
      });
    });
  }

  async ensureAneAligner() {
    if (this.aneProc && !this.aneProc.killed) return true;
    const possiblePaths = [
      path.join(__dirname, '../bin/ane_aligner'),
      path.join(__dirname, '../../bin/ane_aligner'),
      path.join(process.cwd(), 'bin/ane_aligner'),
      '/Applications/SimpleUI.app/Contents/Resources/bin/ane_aligner',
    ];
    let binPath = possiblePaths.find(p => fs.existsSync(p));
    if (!binPath) return false;

    return new Promise((resolve) => {
      try {
        console.log('[Subtitles] 正在拉起 M4 NPU 专属 ANE 词级毫秒强制对齐引擎...');
        this.aneProc = spawn(binPath, [], { stdio: ['pipe', 'pipe', 'ignore'] });
        this.aneProc.stdout.once('data', (d) => {
          if (d.toString().includes('READY')) {
            console.log('[Subtitles] ✅ M4 16核 NPU 强制对齐引擎已就绪 (Apple Neural Engine)');
            resolve(true);
          }
        });
        this.aneProc.on('exit', () => {
          this.aneProc = null;
        });
        setTimeout(() => resolve(false), 5000);
      } catch (e) {
        resolve(false);
      }
    });
  }

  async callAneAligner(wavBuffer, enText, duration) {
    if (!this.aneProc || this.aneProc.killed) {
      await this.ensureAneAligner();
    }
    if (!this.aneProc) {
      const words = enText.split(/\s+/).filter(Boolean);
      const step = duration / Math.max(1, words.length);
      return {
        words: words.map((w, idx) => ({
          word: w,
          start: Number((idx * step).toFixed(3)),
          end: Number(((idx + 1) * step).toFixed(3)),
        })),
        npu_latency_ms: 0,
      };
    }

    const tmpWav = path.join(os.tmpdir(), `ane_${Date.now()}_${Math.random().toString(36).substring(2)}.wav`);
    fs.writeFileSync(tmpWav, wavBuffer);

    return new Promise((resolve) => {
      const onData = (data) => {
        try { fs.unlinkSync(tmpWav); } catch {}
        try {
          const json = JSON.parse(data.toString().trim());
          if (json.ok && Array.isArray(json.words) && json.words.length > 0) {
            resolve({ words: json.words, npu_latency_ms: json.npu_latency_ms, hardware: json.hardware });
            return;
          }
        } catch {}
        resolve(null);
      };

      this.aneProc.stdout.once('data', onData);
      const req = JSON.stringify({ wav: tmpWav, text: enText }) + '\n';
      this.aneProc.stdin.write(req);

      setTimeout(() => {
        try { fs.unlinkSync(tmpWav); } catch {}
        this.aneProc?.stdout.removeListener('data', onData);
        resolve(null);
      }, 1500);
    }).then((res) => {
      if (res && res.words) return res;
      const words = enText.split(/\s+/).filter(Boolean);
      const step = duration / Math.max(1, words.length);
      return {
        words: words.map((w, idx) => ({
          word: w,
          start: Number((idx * step).toFixed(3)),
          end: Number(((idx + 1) * step).toFixed(3)),
        })),
        npu_latency_ms: 0,
      };
    });
  }

  async ensureServersRunning() {
    const check = this.checkModelsReadiness();
    if (!check.allReady) return false;

    // 句末判定模型（缺失时上层自动降级为「仅 ASR 标点 + 静音兜底」，不阻断字幕）
    if (!punctuationEngine.isReady && !punctuationEngine.loadError) {
      const ok = await punctuationEngine.load();
      console.log(
        ok
          ? '[Subtitles] ✅ 独立句末判定引擎已就绪 (Edge-Punct-Casing)'
          : `[Subtitles] ⚠️ 句末判定引擎不可用，降级为静音兜底: ${punctuationEngine.loadError}`
      );
    }

    const llamaBin = getLlamaServerBin();
    const llamaEnv = {
      ...process.env,
      DYLD_LIBRARY_PATH: path.join(userConfigDir, 'runtime', 'llama', 'lib'),
    };

    // 0. 确保 M4 NPU ANE 强制对齐引擎
    this.ensureAneAligner().catch(() => {});

    // 1. 确保 ASR 服务 (端口 1248)
    const asrAlive = await this.checkHealth(1248);
    if (!asrAlive && !this.asrProc) {
      const asrModel = path.join(SUBTITLE_MODELS_DIR, 'qwen3_asr_1.7b.gguf');
      const mmprojModel = path.join(SUBTITLE_MODELS_DIR, 'mmproj_qwen3_asr_1.7b.gguf');
      console.log(`[Subtitles] 正在拉起 Qwen3-ASR Metal 推理服务 (端口 1248, 专属环境: ${llamaBin})...`);
      this.asrProc = spawn(llamaBin, [
        '-m', asrModel,
        '--mmproj', mmprojModel,
        '--port', '1248',
        '-ngl', '99',
        '--no-warmup',
        '-c', '4096',
      ], { stdio: 'ignore', env: llamaEnv });

      this.asrProc.on('exit', () => {
        this.asrProc = null;
      });
    }

    // 2. 确保 Index-Translate 服务 (端口 1249)
    const transAlive = await this.checkHealth(1249);
    if (!transAlive && !this.transProc) {
      const transModel = path.join(SUBTITLE_MODELS_DIR, 'index_translate_2b_q4_k_m.gguf');
      console.log(`[Subtitles] 正在拉起 Index-Translate Metal 机器翻译服务 (端口 1249, 专属环境: ${llamaBin})...`);
      this.transProc = spawn(llamaBin, [
        '-m', transModel,
        '--port', '1249',
        '-ngl', '99',
        '--no-warmup',
        '-c', '4096',
      ], { stdio: 'ignore', env: llamaEnv });

      this.transProc.on('exit', () => {
        this.transProc = null;
      });
    }

    // 等待就绪
    for (let i = 0; i < 20; i++) {
      const ok1 = await this.checkHealth(1248);
      const ok2 = await this.checkHealth(1249);
      if (ok1 && ok2) return true;
      await new Promise((r) => setTimeout(r, 400));
    }

    return false;
  }

  broadcast(eventName, data) {
    const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of this.sseClients) {
      try {
        client.write(payload);
      } catch (err) {
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
      karaokeEnabled: this.config.karaokeEnabled,
      clientCount: this.sseClients.size,
    });
  }

  // 向 ASR 发送语音转录请求 (waitIfBusy: 是否在忙碌时排队等待，final 必须等待，partial 直接跳过防堆积)
  async callAsr(wavBuffer, waitIfBusy = false) {
    if (this.isAsrBusy) {
      if (!waitIfBusy) return '';
      // 等待当前请求完成 (最多等 1200ms)
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 40));
        if (!this.isAsrBusy) break;
      }
    }
    this.isAsrBusy = true;
    try {
      return await new Promise((resolve) => {
        const boundary = '----WebKitFormBoundary' + Math.random().toString(36).substring(2);
        const pre = Buffer.from(
          `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="file"; filename="audio.wav"\r\n` +
          `Content-Type: audio/wav\r\n\r\n`
        );
        const post = Buffer.from(`\r\n--${boundary}--\r\n`);
        const body = Buffer.concat([pre, wavBuffer, post]);

        const req = http.request({
          hostname: '127.0.0.1',
          port: 1248,
          path: '/v1/audio/transcriptions',
          method: 'POST',
          headers: {
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'Content-Length': body.length,
          },
          timeout: 8000,
        }, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            try {
              const json = JSON.parse(data);
              resolve(cleanAsrText(json.text));
            } catch (e) {
              resolve('');
            }
          });
        });

        req.on('error', () => resolve(''));
        req.setTimeout(8000, () => {
          req.destroy();
          resolve('');
        });
        req.write(body);
        req.end();
      });
    } finally {
      this.isAsrBusy = false;
    }
  }

  // 向 Index-Translate 发送神经机器翻译请求
  async callTranslate(enText) {
    return new Promise((resolve) => {
      const body = JSON.stringify({
        messages: [
          {
            role: 'user',
            content: `Translate into Chinese (output only the translated sentence without extra explanation): ${enText}`,
          },
        ],
        max_tokens: 128,
        temperature: 0,
      });

      const req = http.request({
        hostname: '127.0.0.1',
        port: 1249,
        path: '/v1/chat/completions',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: 8000,
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            const zh = json.choices?.[0]?.message?.content?.trim() || '';
            resolve(zh);
          } catch (e) {
            resolve('');
          }
        });
      });

      req.on('error', () => resolve(''));
      req.setTimeout(8000, () => {
        req.destroy();
        resolve('');
      });
      req.write(body);
      req.end();
    });
  }

  // 处理接收到的音频块并广播给前端 (isFinal = true 表示整句定稿，false 表示正在讲话的流式增量)
  async processAudioChunk(wavBuffer, isFinal = true) {
    if (!this.isRunning) return { ok: false, reason: 'paused' };
    const check = this.checkModelsReadiness();
    if (!check.allReady) {
      return { ok: false, error: 'MODELS_NOT_READY', missing: check.missing };
    }

    // 确保推理后台就位
    const ready = await this.ensureServersRunning();
    if (!ready) {
      return { ok: false, error: 'SERVERS_STARTING' };
    }

    // —— 稳定前缀 + 句末判定（取代原先「按静音时长机械切分」）——
    // partial 与 final 走同一条路：final 只额外表示「说话人已停下」，用于 L2 静音兜底。
    const rawAsr = await this.callAsr(wavBuffer, isFinal);
    const enText = cleanAsrText(rawAsr);
    if (!enText || enText.trim().length < 2) {
      if (isFinal) this.broadcastDraft([], 0, 0);
      return { ok: true, empty: true };
    }

    const words = enText.trim().split(/\s+/).filter(Boolean);

    // 跳过已经成稿切走的部分。采集端可能还没来得及截断音频，这一轮 ASR 会把旧句子
    // 重新吐一遍；用归一化词序列判断已消费内容是否仍是其前缀，是就跳过。
    // 这样「采集端已截断」与「还没截断」两种情况都成立，不依赖 trimAudio 一定送达。
    const normCur = words.map(normWord);
    const normConsumed = this.segment.consumed.map(normWord);
    // 用 consumed 的「最长后缀」去匹配当前输出的「前缀」。
    // 为什么不能用整段前缀匹配：采集端截断音频时会留一小截上一句的尾巴，
    // 于是这一轮 ASR 的开头是「上句尾部 + 新句」，而 consumed 是「上句全部」，
    // 整段前缀永远匹配不上，旧内容就会被当成新句子的开头（实测切出过
    // "the first the middle" 这种上一句的残渣）。改成后缀匹配即可对齐。
    let skip = 0;
    if (normConsumed.length > 0) {
      const maxK = Math.min(normConsumed.length, normCur.length);
      for (let k = maxK; k >= 2; k--) { // 至少匹配 2 个词，避免单词巧合误跳
        let ok = true;
        for (let i = 0; i < k; i++) {
          if (normConsumed[normConsumed.length - k + i] !== normCur[i]) {
            ok = false;
            break;
          }
        }
        if (ok) {
          skip = k;
          break;
        }
      }
    }
    if (skip === 0 && this.segment.consumed.length > 0) {
      // 这一轮输出已经不含已消费内容 —— 采集端已截断，重新累积
      this.segment.consumed = [];
    }
    const curWords = words.slice(skip);

    // Local-Agreement(LA-2)：与上一轮 ASR 假设取最长公共前缀，只有这一段被认定为稳定。
    // committed 只追加、不回改 —— 这是「已吐出的字被改回来」的根治点。
    const stableLen = commonPrefixLen(this.segment.lastCur, curWords);
    this.segment.lastCur = curWords;
    for (let i = this.segment.committed.length; i < stableLen && i < curWords.length; i++) {
      this.segment.committed.push(curWords[i]);
    }
    // 词干不变时，接受 ASR **补上**句末标点（. ? !），但不接受它撤销任何标点。
    // 必要性：LA 的「只增不改」会把后补的句点挡在外面，committed 里永远是 "engine"
    // 而不是 "engine."，句末信号 A 就永远命中不了，切点会被推到下一个词上。
    // 为什么只补不撤：ASR 在中途加逗号又删掉是家常便饭（实测 "So," -> "So"），
    // 跟着撤销就会让已上屏的文字闪动；而它一旦标了句号，撤销的概率远低于逗号。
    for (let i = 0; i < this.segment.committed.length && i < stableLen; i++) {
      const old = this.segment.committed[i];
      const cur = curWords[i];
      if (old === cur) continue;
      if (normWord(old) !== normWord(cur)) continue; // 词干变了：绝不改
      if (/[.?!。？！]$/.test(cur) && !/[.?!。？！]$/.test(old)) {
        this.segment.committed[i] = cur;
      }
    }

    // L1：稳定前缀内部出现句末信号 —— 与说话人是否停顿无关，一口气讲三句就连断三次
    let cut = await this.findSentenceEnd();
    let reason = 'sentence-end';

    // L2：静音兜底。标点模型在文本截断处会拒绝表态（实测末尾词常被判 NONE），
    // 说话人确实停下时必须有这条兜底，否则句子永远无法定稿。
    if (cut < 0 && isFinal && this.segment.committed.length > 0) {
      cut = this.segment.committed.length;
      reason = 'silence';
    }

    // 保险丝：一口气不停顿且始终无句末信号时的无界增长保护（仅极端情况触发）
    if (cut < 0 && this.segment.committed.length >= this.config.maxWordsHardLimit) {
      cut = this.segment.committed.length;
      reason = 'hard-limit';
    }

    let trimAudio = false;
    if (cut > 0) {
      const outWords = this.segment.committed.slice(0, cut);
      this.segment.committed = this.segment.committed.slice(cut);
      // 两个基准同步切走，保证下一轮索引仍与 curWords 对齐
      this.segment.lastCur = curWords.slice(cut);
      this.segment.consumed = this.segment.consumed.concat(curWords.slice(0, cut));
      if (this.segment.consumed.length > 300) this.segment.consumed = [];
      await this.finalizeWords(outWords, reason);
      trimAudio = true;
    }

    this.broadcastDraft(curWords, stableLen, cut);
    return { ok: true, trimAudio, reason: cut > 0 ? reason : 'streaming' };
  }

  /**
   * 在「已稳定前缀」中寻找句末切点。
   * @returns {number} 切点词数（把前 N 个词作为一整句切出）；-1 表示还没到句末
   */
  async findSentenceEnd() {
    const words = this.segment.committed;
    if (words.length < 2) return -1;
    const text = words.join(' ');
    const textLen = text.length;
    const needCtx = this.config.rightContextChars;

    let modelTags = null;
    for (let i = 0; i < words.length; i++) {
      // 双重右上下文判据，两条都要满足：
      //   a) 该词末尾之后还有 needCtx 个稳定字符 —— 标点模型要看到下文才肯表态
      //   b) 该词之后还有 minWordsAfterEnd 个稳定词 —— 证明音频没有在这里被截断。
      //      只满足 (a) 会被 ASR 在截断处补的伪句末骗过（实测切出过 "over it." 这种碎片）。
      const endOff = words.slice(0, i + 1).join(' ').length;
      if (textLen - endOff < needCtx) break;
      if (words.length - (i + 1) < this.config.minWordsAfterEnd) break;

      // 信号 A：ASR 自带的句末标点。它在稳定前缀里已被连续两次 ASR 输出确认，可信。
      if (/[.?!。？！]$/.test(words[i])) return i + 1;

      // 信号 B：独立标点模型（不读 ASR 的标点，只看文本本身）
      if (punctuationEngine.isReady && modelTags === null) {
        const bare = stripTerminalPunctuation(text);
        modelTags = await punctuationEngine.predict(bare);
        if (modelTags.length !== words.length) modelTags = null; // 词不对齐则弃用，绝不猜
      }
      if (modelTags) {
        const t = modelTags[i];
        if ((t.tag === PUNCT_PERIOD || t.tag === PUNCT_QUESTION) && t.prob >= this.config.punctMinProb) {
          return i + 1;
        }
      }
    }

    // 长句兜底：始终没有句末信号时，退到最后一个逗号处断开。
    // 逗号是句内自然停顿，比任意位置硬切可读得多，也能让音频不再继续变长。
    const lastComma = (() => {
      for (let i = words.length - 1; i >= 1; i--) {
        if (/[,，;；:：]$/.test(words[i])) return i + 1;
      }
      return -1;
    })();

    if (words.length >= this.config.maxWordsHardLimit) {
      return lastComma > 0 ? lastComma : words.length;
    }
    if (words.length >= this.config.maxWordsCommaCut && lastComma > 0) {
      return lastComma;
    }
    return -1;
  }

  async finalizeWords(words, reason) {
    const sentence = words.join(' ').trim();
    if (!sentence || sentence.length < 2) return;
    const segId = `sub_${Date.now()}_${this.seqId++}`;
    const zhText = await this.callTranslate(sentence);
    const payload = {
      id: segId,
      status: 'finalized',
      source_lang: 'en',
      target_lang: 'zh',
      source_text: sentence,
      target_text: zhText || sentence,
      reason,
      timeline: { start_time: Date.now() / 1000 - 2, end_time: Date.now() / 1000, duration: 2 },
      karaoke_words: [],
      metrics: { hardware: 'Apple Silicon Heterogeneous (M4 Metal + ANE)' },
    };
    this.broadcast('finalized', payload);
    console.log(`[Subtitles] 🎯 定稿(${reason}): "${sentence}" -> "${zhText}"`);
    this.history.push(payload);
    if (this.history.length > 100) this.history.shift();
  }

  // 草稿分两段：stable 是已被 LA-2 确认、不会再被改写的部分；pending 是正在说、还会变的尾巴
  broadcastDraft(words, stableLen, cut = 0) {
    const stable = this.segment.committed.join(' ');
    const from = cut > 0 ? cut : stableLen;
    const pending = Array.isArray(words) ? words.slice(from).join(' ') : '';
    this.broadcast('draft', { stable, pending });
  }

  // HTTP API 处理入口
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
          recent: this.history.slice(-10),
        })
      );
      return;
    }

    // 清空历史记录
    if (pathname === '/api/subtitles/clear' && req.method === 'POST') {
      this.history = [];
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ ok: true, cleared: true }));
      return;
    }

    // 3. 启动监听
    if (pathname === '/api/subtitles/start' && req.method === 'POST') {
      this.start();
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ ok: true, running: true }));
      return;
    }

    // 4. 停止监听
    if (pathname === '/api/subtitles/stop' && req.method === 'POST') {
      this.stop();
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ ok: true, running: false }));
      return;
    }

    // 5. 模型清单
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

    // 6. 实时音频喂入端点
    if (pathname === '/api/subtitles/feed' && req.method === 'POST') {
      const isFinal = url.searchParams.get('is_final') === '1' || url.searchParams.get('is_partial') !== '1';
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
          const wavBuffer = Buffer.concat(chunks);
          // 同步等待结果：响应里的 trimAudio 告诉采集端「这一句已经成稿，可以把对应音频丢掉了」。
          // 不拿到这个信号，采集端只能无限累积音频，长句会让 ASR 越来越慢。
          const result = await this.processAudioChunk(wavBuffer, isFinal);
          res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(
            JSON.stringify({
              ok: true,
              status: 'done',
              isFinal,
              trimAudio: Boolean(result && result.trimAudio),
              reason: (result && result.reason) || 'skip',
            })
          );
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    // 404
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
  }
}

export const subtitleService = new SubtitleService();
