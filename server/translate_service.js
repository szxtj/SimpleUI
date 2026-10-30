// 快速翻译服务托管模块 —— 独立的端侧翻译小模型进程 + 详解模式（DeepSeek / 基础模型服务）
//
// 定位：把「快捷翻译」从应用设置里独立出来，作为与基础模型 / 语音识别 / 实时字幕并列的
// 受管服务，配置与运行状态全部收归服务控制面板。
//
// 与实时字幕服务的关系（参照「语音输入 ↔ 实时字幕」的既有做法）：
//   **两个服务、两个进程、并行运行，只共用同一份模型文件与同一套下载器。**
//   - 模型文件：SUBTITLE_MODELS_DIR/index_translate_2b_q4_k_m.gguf（同一份，不复制）
//   - 下载/取消/进度/完整性校验：直接调用 subtitleService.startDownload('translate')，
//     并直接读 subtitleService.downloadState —— 与字幕服务天然同步，不复制任何下载逻辑。
//   - 运行进程：本服务自己拉一个 llama-server（端口 1248、自己的 PID 文件与看门狗），
//     字幕服务的 1249 由它自己管；任一方启停都不影响另一方。
//
// 两条模式：
//   1) 快速模式：上面的 Index-Translate-2B，调用参数与该模型的推荐基准完全一致
//      （复用 subtitles/translation.js 的 TranslationEngine：官方基准提示词、
//       temperature 0、关闭思考；只有 max_tokens 按整段选区的长度放大）。
//   2) 详解模式：DeepSeek 官方 API 或「基础模型服务」（当前激活引擎），
//      采样参数取各自在应用里的默认值，只是不提供配置项。
//
// 对原生快捷翻译窗口的契约：本模块在 31235 上暴露一个 OpenAI 兼容网关
// POST /api/translate/v1/chat/completions，请求体额外带 mode=quick|detail。
// 原生侧只认识 endpoint/model，不需要知道后面到底是小模型还是 DeepSeek。

import http from 'http';
import https from 'https';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { startWatchdog } from './watchdog.js';
import { subtitleService, SUBTITLE_MODELS_DIR, resolveLlamaRuntime } from './subtitle_service.js';
import { TranslationEngine } from './subtitles/translation.js';
import { ttfService } from './ttf_service.js';

const HOME = os.homedir();
const userConfigDir = path.join(HOME, 'Library', 'Application Support', 'SimpleUI');
const CONFIG_FILE = path.join(userConfigDir, 'translate_config.json');

// 快速模式专属的 llama-server（与字幕的 1249 并行、互不影响）
const QUICK_PORT = 1248;
const QUICK_PID_FILE = '/tmp/simpleui_translate_quick.pid';
const QUICK_LOG_FILE = path.join(HOME, 'Library', 'Logs', 'simpleui-translate.log');
const QUICK_MODEL_FILE = 'index_translate_2b_q4_k_m.gguf';

function readQuickPid() {
  try {
    if (!fs.existsSync(QUICK_PID_FILE)) return null;
    const raw = fs.readFileSync(QUICK_PID_FILE, 'utf-8').trim();
    const pid = parseInt(raw, 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isPidAlive(pid) {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// 单次请求的文本上限（按字符切块，保证不撑爆 4096 上下文）
const QUICK_CHUNK_CHARS = 1200;

/**
 * 详解模式内置锁定参数：DeepSeek 官方 API。
 * temperature / top_p 取 DeepSeek 官方默认（也是「模型设置」里的默认值）；
 * max_tokens 沿用快捷翻译原有的 4096 上限（DeepSeek 128K 的 65536 是对话预算，不是翻译输出预算）。
 */
const DETAIL_DEEPSEEK_PARAMS = {
  temperature: 1.0,
  top_p: 1.0,
  max_tokens: 4096,
};

/**
 * 详解模式内置锁定参数：基础模型服务。
 * 取值与「模型设置」里 TTF / Mference 的默认参数逐项一致（含 maxTokens 8192），
 * 只是不再提供配置项；思考一律关闭，翻译不需要思考链。
 */
const DETAIL_BASE_PARAMS = {
  'turbo-fieldfare': {
    temperature: 1.0,
    top_p: 0.95,
    top_k: 64,
    repetition_penalty: 1.0,
    max_tokens: 8192,
  },
  mference: {
    temperature: 1.0,
    top_p: 0.95,
    top_k: 20,
    min_p: 0.0,
    presence_penalty: 1.5,
    repetition_penalty: 1.0,
    max_tokens: 8192,
  },
};

/** 基础模型服务各引擎的请求模型名（与前端默认值一致） */
const BASE_MODEL_IDS = {
  'turbo-fieldfare': 'gemma-4-26b-a4b-it',
  mference: 'qwen3.6-35b-a3b',
};

export const DEFAULT_TRANSLATE_CONFIG = {
  // 基准语言视角：决定「中译英」还是「英译中」的目标语言
  baseLang: 'zh',
  // 详解模式后端：deepseek（官方 API） | base（基础模型服务）
  detailProvider: 'deepseek',
  // 唯一一份 DeepSeek 配置，与模型设置里的 DeepSeek 完全独立
  deepseek: {
    apiKey: '',
    baseUrl: 'https://api.deepseek.com',
    modelId: 'deepseek-flash',
  },
  // 快速模式空闲多久卸载自己的 1248 进程（分钟，0 = 不自动卸载）
  quickIdleUnloadMin: 30,
};

export class TranslateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'TranslateError';
    this.code = code;
  }
}

// ----------------------------- 配置持久化 -----------------------------

function loadStoredConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const data = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
      if (data && typeof data === 'object') {
        return {
          ...DEFAULT_TRANSLATE_CONFIG,
          ...data,
          deepseek: { ...DEFAULT_TRANSLATE_CONFIG.deepseek, ...(data.deepseek || {}) },
        };
      }
    }
  } catch {
    // ignore
  }
  return {
    ...DEFAULT_TRANSLATE_CONFIG,
    deepseek: { ...DEFAULT_TRANSLATE_CONFIG.deepseek },
  };
}

function persistConfig(config) {
  try {
    fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
  } catch (e) {
    console.error('[Translate] 配置写入失败:', e.message);
  }
}

function maskApiKey(key) {
  const raw = String(key || '');
  if (!raw) return '';
  if (raw.length <= 8) return '••••';
  return `${raw.slice(0, 4)}••••${raw.slice(-4)}`;
}

// ----------------------------- 语言判定与切块 -----------------------------

function detectSourceLang(text) {
  const s = String(text || '');
  if (/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/.test(s)) return 'zh';
  if (/[\u3040-\u30ff]/.test(s)) return 'ja';
  return 'en';
}

/** 目标语言由基准语言决定；同语言时自动反向（与字幕服务「同语言不翻译」的口径一致） */
function resolveLangPair(text, baseLang) {
  const source = detectSourceLang(text);
  let target = baseLang === 'en' ? 'en' : 'zh';
  if (source === target) target = source === 'zh' ? 'en' : 'zh';
  return { source, target };
}

/** 把长文本按段落 / 句末标点切成不超过 limit 字符的块（小模型上下文有限） */
function splitForQuick(text, limit = QUICK_CHUNK_CHARS) {
  const source = String(text || '').trim();
  if (source.length <= limit) return [source];

  const chunks = [];
  const paragraphs = source.split(/\n{2,}/);
  let buf = '';
  const push = () => {
    if (buf.trim()) chunks.push(buf.trim());
    buf = '';
  };

  for (const para of paragraphs) {
    if (para.length <= limit) {
      if ((buf + '\n\n' + para).trim().length > limit) push();
      buf = buf ? `${buf}\n\n${para}` : para;
      continue;
    }
    const sentences = para.split(/(?<=[。！？!?.;；\n])/);
    for (const sentence of sentences) {
      if (!sentence) continue;
      if ((buf + sentence).length > limit) push();
      if (sentence.length > limit) {
        for (let i = 0; i < sentence.length; i += limit) {
          const part = sentence.slice(i, i + limit);
          if ((buf + part).length > limit) push();
          buf += part;
        }
      } else {
        buf += sentence;
      }
    }
    push();
  }
  push();
  return chunks.length ? chunks : [source];
}

/** 输出 token 上限：按块长度放大，128 起步（字幕的推荐值）、2048 封顶 */
function quickMaxTokens(chunk) {
  return Math.min(2048, Math.max(128, Math.ceil(chunk.length * 1.6) + 48));
}

/** 详解模式提示词（与原生 TranslationService.makeSystemInstruction 的 detail 分支一致） */
function buildDetailInstruction(text, baseLang) {
  const hasChinese = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/.test(String(text || ''));
  const isZhBase = baseLang !== 'en';
  if (isZhBase) {
    if (hasChinese) {
      return [
        '请将输入的中文解析为地道英文表达，Markdown 格式：',
        '1. 表达推荐：优先美式日常表达，尽量展示全面不同表达；英式特有表达前标注【英】。',
        '2. 简要辨析：注明词性、语境及正式程度差异。',
        '3. 双语例句：为主要表达提供 1-2 个实用英文例句及中文对照。',
        '注意：不输出音标，不输出寒暄或多余前言。',
      ].join('\n');
    }
    return [
      '请解析输入的英文单词或短语，Markdown 格式：',
      '1. 词性及准确中文释义（分点列出）。',
      '2. 2 个实用的英文例句及中文对照翻译。',
      '注意：不输出音标，不输出寒暄或多余前言。',
    ].join('\n');
  }
  if (hasChinese) {
    return [
      'Analyze the Chinese input for English speakers in Markdown:',
      '1. Pinyin with tone marks and part of speech.',
      '2. Clear English definitions.',
      '3. Usage and context notes.',
      '4. 2 authentic example sentences (Chinese, Pinyin, English).',
      'Output only the analysis without conversational filler.',
    ].join('\n');
  }
  return [
    'Provide authentic Chinese equivalents for English speakers in Markdown:',
    '1. Chinese expressions with Pinyin.',
    '2. Nuance and register differences in English.',
    '3. 1-2 bilingual example sentences.',
    'Output only the analysis without conversational filler.',
  ].join('\n');
}

// ----------------------------- HTTP 工具 -----------------------------

function postJson(urlStr, payload, { headers = {}, timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(urlStr);
    } catch {
      reject(new TranslateError('INVALID_URL', `无效的服务地址: ${urlStr}`));
      return;
    }
    const body = JSON.stringify(payload);
    const transport = url.protocol === 'https:' ? https : http;
    const req = transport.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          ...headers,
        },
        timeout: timeoutMs,
      },
      (res) => {
        let data = '';
        res.setEncoding('utf-8');
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
      }
    );
    req.on('timeout', () => {
      req.destroy(new Error('请求超时'));
    });
    req.on('error', (err) => reject(err));
    req.write(body);
    req.end();
  });
}

function extractChatContent(raw) {
  try {
    const json = JSON.parse(raw);
    const choice = json.choices?.[0];
    const content = choice?.message?.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      const joined = content
        .map((c) => (typeof c === 'string' ? c : c?.text || ''))
        .join('')
        .trim();
      if (joined) return joined;
    }
    if (typeof json.output_text === 'string') return json.output_text;
  } catch {
    // ignore
  }
  return '';
}

function cleanOutput(text) {
  let out = String(text || '');
  out = out.replace(/<think>[\s\S]*?<\/think>/gi, '');
  if (out.includes('</think>')) out = out.split('</think>').pop();
  return out.replace(/^<think>/i, '').trim();
}

// ----------------------------- 服务主体 -----------------------------

class TranslateService {
  constructor() {
    this.config = loadStoredConfig();
    this.proc = null;
    this.startingPromise = null;
    this.watchdog = null;
    this.lastUsedAt = 0;
    this.inFlight = 0;
    this.idleTimer = null;
    // 与字幕服务同一个引擎实现（官方基准提示词 / temperature 0 / 关闭思考），
    // 只是指向自己的 1248 端口。
    this.engine = new TranslationEngine({ port: QUICK_PORT, timeoutMs: 60000, maxTokens: 128 });
  }

  init() {
    this.ensureWatchdog();
    if (!this.idleTimer) {
      this.idleTimer = setInterval(() => this.reapIdle(), 60 * 1000);
      if (this.idleTimer.unref) this.idleTimer.unref();
    }
  }

  ensureWatchdog() {
    if (this.watchdog) return;
    try {
      this.watchdog = startWatchdog({ pidFile: QUICK_PID_FILE, binaryBasename: 'llama-server' });
    } catch {
      this.watchdog = null;
    }
  }

  // ---- 快速模式进程 ----

  checkHealth(port = QUICK_PORT) {
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

  checkQuickReadiness() {
    const models = subtitleService.checkModelsReadiness();
    const runtime = resolveLlamaRuntime();
    const model = models.status.translate;
    return {
      modelReady: Boolean(model?.ready),
      modelName: model?.name || 'Index-Translate-2B Q4_K_M',
      sizeMb: model?.sizeMb || '0.0',
      sizeDesc: model?.sizeDesc || '—',
      path: model?.path || path.join(SUBTITLE_MODELS_DIR, QUICK_MODEL_FILE),
      runtimeReady: Boolean(runtime.ready),
      runtimePath: runtime.binPath || null,
    };
  }

  async ensureQuickServer() {
    const quick = this.checkQuickReadiness();
    if (!quick.modelReady) {
      throw new TranslateError(
        'QUICK_MODEL_MISSING',
        '翻译模型尚未下载，请在「服务控制面板 → 快速翻译服务」中下载。'
      );
    }
    if (!quick.runtimeReady) {
      throw new TranslateError('QUICK_RUNTIME_MISSING', '未找到内置 llama-server 运行时。');
    }
    if (await this.checkHealth()) {
      this.touch();
      return true;
    }
    if (this.startingPromise) return this.startingPromise;
    this.startingPromise = this._spawnQuickServer().finally(() => {
      this.startingPromise = null;
    });
    return this.startingPromise;
  }

  async _spawnQuickServer() {
    const runtime = resolveLlamaRuntime();
    const modelPath = path.join(SUBTITLE_MODELS_DIR, QUICK_MODEL_FILE);
    const fallbackLibDir = path.join(userConfigDir, 'runtime', 'llama', 'lib');
    const dyldPath = [runtime.libDir, fallbackLibDir, process.env.DYLD_LIBRARY_PATH]
      .filter(Boolean)
      .join(':');

    const proc = spawn(
      runtime.binPath,
      [
        '-m',
        modelPath,
        '--host',
        '127.0.0.1',
        '--port',
        String(QUICK_PORT),
        '-ngl',
        '99',
        '-fa',
        'on',
        '-np',
        '1',
        // 整段选区翻译比字幕单句长，4096 留足余量
        '-c',
        '4096',
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
    this.proc = proc;

    let logStream = null;
    try {
      fs.mkdirSync(path.dirname(QUICK_LOG_FILE), { recursive: true });
      logStream = fs.createWriteStream(QUICK_LOG_FILE, { flags: 'w' });
    } catch {}
    const capture = (d) => {
      try {
        logStream?.write(d);
      } catch {}
    };
    proc.stdout?.on('data', capture);
    proc.stderr?.on('data', capture);
    try {
      if (proc.pid) fs.writeFileSync(QUICK_PID_FILE, String(proc.pid));
    } catch {}

    let exitedEarly = false;
    proc.on('exit', () => {
      exitedEarly = true;
      if (this.proc === proc) {
        this.proc = null;
        try {
          if (fs.existsSync(QUICK_PID_FILE)) fs.unlinkSync(QUICK_PID_FILE);
        } catch {}
      }
    });

    for (let i = 0; i < 160; i++) {
      if (exitedEarly) break;
      await new Promise((r) => setTimeout(r, 300));
      if (await this.checkHealth()) {
        this.touch();
        return true;
      }
    }
    try {
      proc.kill('SIGKILL');
    } catch {}
    if (this.proc === proc) this.proc = null;
    throw new TranslateError('QUICK_SERVER_FAILED', '翻译模型加载失败，请稍后重试。');
  }

  stopQuickServer() {
    if (this.proc) {
      try {
        this.proc.kill('SIGKILL');
      } catch {}
      this.proc = null;
    }
    this.startingPromise = null;
    try {
      if (fs.existsSync(QUICK_PID_FILE)) fs.unlinkSync(QUICK_PID_FILE);
    } catch {}
  }

  // ---- 状态 ----

  async getStatus() {
    const quick = this.checkQuickReadiness();
    const quickServerUp = quick.modelReady && (await this.checkHealth());
    let base = null;
    try {
      const st = await ttfService.getStatus();
      base = {
        engine: st.activeEngine,
        status: st.status,
        port: st.port,
        running: st.status === 'running',
        modelId: BASE_MODEL_IDS[st.activeEngine] || '',
      };
    } catch {
      base = null;
    }
    const ds = this.config.deepseek || {};
    return {
      baseLang: this.config.baseLang === 'en' ? 'en' : 'zh',
      detailProvider: this.config.detailProvider === 'base' ? 'base' : 'deepseek',
      deepseek: {
        configured: Boolean(String(ds.apiKey || '').trim()),
        apiKeyMasked: maskApiKey(ds.apiKey),
        baseUrl: ds.baseUrl || DEFAULT_TRANSLATE_CONFIG.deepseek.baseUrl,
        modelId: ds.modelId || DEFAULT_TRANSLATE_CONFIG.deepseek.modelId,
      },
      quick: {
        ...quick,
        serverReady: quickServerUp,
        // 冷启动（拉起 llama-server 并等健康检查）期间给面板/菜单一个「启动中」
        starting: Boolean(this.startingPromise),
        port: QUICK_PORT,
        // 直接引用字幕服务的下载进度对象：同一个下载器、同一份进度，天然同步
        downloadState: subtitleService.downloadState,
      },
      base,
      baseService: base,
      storageDir: SUBTITLE_MODELS_DIR,
      idleUnloadMin: this.config.quickIdleUnloadMin,
    };
  }

  // ---- 配置 ----

  applyConfig(partial = {}) {
    const next = { ...this.config };
    if (partial.baseLang !== undefined) {
      next.baseLang = partial.baseLang === 'en' ? 'en' : 'zh';
    }
    if (partial.detailProvider !== undefined) {
      next.detailProvider = partial.detailProvider === 'base' ? 'base' : 'deepseek';
    }
    if (partial.quickIdleUnloadMin !== undefined) {
      const m = Number(partial.quickIdleUnloadMin);
      if (Number.isFinite(m) && m >= 0) next.quickIdleUnloadMin = m;
    }
    if (partial.deepseek && typeof partial.deepseek === 'object') {
      const ds = { ...next.deepseek };
      if (partial.deepseek.apiKey !== undefined) ds.apiKey = String(partial.deepseek.apiKey || '').trim();
      if (partial.deepseek.baseUrl !== undefined) {
        const url = String(partial.deepseek.baseUrl || '').trim();
        ds.baseUrl = url || DEFAULT_TRANSLATE_CONFIG.deepseek.baseUrl;
      }
      if (partial.deepseek.modelId !== undefined) {
        const id = String(partial.deepseek.modelId || '').trim();
        ds.modelId = id || DEFAULT_TRANSLATE_CONFIG.deepseek.modelId;
      }
      next.deepseek = ds;
    }
    this.config = next;
    persistConfig(this.config);
    if (this.proc || isPidAlive(readQuickPid())) {
      this.touch();
    }
    return this.publicConfig();
  }

  publicConfig() {
    const ds = this.config.deepseek || {};
    return {
      baseLang: this.config.baseLang,
      detailProvider: this.config.detailProvider,
      deepseek: {
        configured: Boolean(String(ds.apiKey || '').trim()),
        apiKeyMasked: maskApiKey(ds.apiKey),
        baseUrl: ds.baseUrl,
        modelId: ds.modelId,
      },
      quickIdleUnloadMin: this.config.quickIdleUnloadMin,
    };
  }

  // ---- 快速模式：端侧小模型 ----

  async translateQuick(text) {
    const baseLang = this.config.baseLang === 'en' ? 'en' : 'zh';
    await this.ensureQuickServer();
    const chunks = splitForQuick(text);
    const parts = [];
    for (const chunk of chunks) {
      const { source, target } = resolveLangPair(chunk, baseLang);
      try {
        const out = await this.engine.translate(chunk, source, target, {
          maxTokens: quickMaxTokens(chunk),
        });
        if (out) parts.push(out);
      } catch (err) {
        throw new TranslateError(
          err?.code || 'QUICK_REQUEST_FAILED',
          `翻译模型请求失败: ${err?.message || String(err)}`
        );
      }
    }
    this.touch();
    return { text: parts.join('\n\n'), provider: 'quick', chunks: chunks.length };
  }

  // ---- 详解模式：DeepSeek 官方 API 或基础模型服务 ----

  async translateDetail(text) {
    const baseLang = this.config.baseLang === 'en' ? 'en' : 'zh';
    const instruction = buildDetailInstruction(text, baseLang);
    const provider = this.config.detailProvider === 'base' ? 'base' : 'deepseek';
    const messages = [
      { role: 'system', content: instruction },
      { role: 'user', content: text },
    ];

    if (provider === 'base') {
      const engine = ttfService.getActiveEngine();
      const port = ttfService.getActivePort();
      const params = DETAIL_BASE_PARAMS[engine] || DETAIL_BASE_PARAMS['turbo-fieldfare'];
      const payload = {
        model: BASE_MODEL_IDS[engine] || 'local-model',
        messages,
        stream: false,
        ...params,
        // 翻译不需要思考链，与「模型设置」关闭思考时发送的协议字段一致
        reasoning_effort: 'none',
        chat_template_kwargs: { enable_thinking: false },
        thinking: { type: 'disabled' },
      };
      let res;
      try {
        res = await postJson(`http://127.0.0.1:${port}/v1/chat/completions`, payload, {
          timeoutMs: 120000,
        });
      } catch {
        throw new TranslateError(
          'BASE_UNREACHABLE',
          `无法连接基础模型服务（端口 ${port}），请先在服务控制面板启动它。`
        );
      }
      if (res.statusCode !== 200) {
        throw new TranslateError(
          'BASE_HTTP_ERROR',
          `基础模型服务返回 HTTP ${res.statusCode}: ${String(res.body).slice(0, 200)}`
        );
      }
      const out = cleanOutput(extractChatContent(res.body));
      if (!out) throw new TranslateError('BASE_EMPTY', '基础模型服务返回了空结果。');
      return { text: out, provider: 'base', engine, port };
    }

    const ds = this.config.deepseek || {};
    const apiKey = String(ds.apiKey || '').trim();
    if (!apiKey) {
      throw new TranslateError(
        'DEEPSEEK_KEY_MISSING',
        '尚未配置 DeepSeek API Key，请在「服务控制面板 → 快速翻译服务」中填写。'
      );
    }
    const baseUrl = String(ds.baseUrl || DEFAULT_TRANSLATE_CONFIG.deepseek.baseUrl).replace(/\/+$/, '');
    const endpoint = baseUrl.endsWith('/v1') ? `${baseUrl}/chat/completions` : `${baseUrl}/v1/chat/completions`;
    const payload = {
      model: ds.modelId || DEFAULT_TRANSLATE_CONFIG.deepseek.modelId,
      messages,
      stream: false,
      ...DETAIL_DEEPSEEK_PARAMS,
    };
    let res;
    try {
      res = await postJson(endpoint, payload, {
        headers: { Authorization: `Bearer ${apiKey}` },
        timeoutMs: 120000,
      });
    } catch (err) {
      throw new TranslateError('DEEPSEEK_UNREACHABLE', `无法连接 DeepSeek API: ${err.message}`);
    }
    if (res.statusCode === 401) {
      throw new TranslateError('DEEPSEEK_UNAUTHORIZED', 'DeepSeek API Key 无效或已过期。');
    }
    if (res.statusCode !== 200) {
      throw new TranslateError(
        'DEEPSEEK_HTTP_ERROR',
        `DeepSeek API 返回 HTTP ${res.statusCode}: ${String(res.body).slice(0, 200)}`
      );
    }
    const out = cleanOutput(extractChatContent(res.body));
    if (!out) throw new TranslateError('DEEPSEEK_EMPTY', 'DeepSeek 返回了空结果。');
    return { text: out, provider: 'deepseek', model: payload.model };
  }

  async translate(text, mode) {
    const source = String(text || '').trim();
    if (!source) throw new TranslateError('EMPTY_SOURCE', '待翻译文本为空。');
    this.inFlight += 1;
    try {
      const startedAt = Date.now();
      const result = mode === 'detail' ? await this.translateDetail(source) : await this.translateQuick(source);
      this.touch();
      return { ...result, mode: mode === 'detail' ? 'detail' : 'quick', elapsedMs: Date.now() - startedAt };
    } finally {
      this.inFlight = Math.max(0, this.inFlight - 1);
    }
  }

  // ---- 生命周期 ----

  touch() {
    this.lastUsedAt = Date.now();
  }

  /** 空闲回收：只回收自己拉起的 1248，不碰字幕服务的 1249 */
  reapIdle() {
    const idleMin = Number(this.config.quickIdleUnloadMin ?? 30);
    if (!idleMin || idleMin <= 0) return;
    if (this.inFlight > 0) return;
    const pid = this.proc?.pid || readQuickPid();
    if (!isPidAlive(pid)) return;
    if (!this.lastUsedAt) {
      this.touch();
      return;
    }
    if (Date.now() - this.lastUsedAt < idleMin * 60 * 1000) return;
    this.stopQuickServer();
  }

  shutdownSync() {
    if (this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = null;
    }
    this.stopQuickServer();
  }

  shutdownForce() {
    this.shutdownSync();
  }

  // ---- HTTP API ----

  handleApi(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    const pathname = url.pathname;

    const sendJson = (code, obj) => {
      if (res.headersSent) return;
      res.writeHead(code, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify(obj));
    };

    const readJson = () =>
      new Promise((resolve) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}'));
          } catch {
            resolve({});
          }
        });
      });

    (async () => {
      // 1. 聚合状态（运行环境 / 模型完备性 / 下载进度 / 基础模型服务 / DeepSeek 配置）
      if (pathname === '/api/translate/status' && req.method === 'GET') {
        sendJson(200, await this.getStatus());
        return;
      }

      // 2. 更新配置（基准语言 / 详解后端 / DeepSeek）
      if (pathname === '/api/translate/config' && req.method === 'POST') {
        const body = await readJson();
        sendJson(200, { ok: true, config: this.applyConfig(body) });
        return;
      }

      // 3. 下载翻译模型：复用字幕服务的双源测速下载器与同一份模型文件
      if (pathname === '/api/translate/download' && req.method === 'POST') {
        subtitleService.startDownload('translate').catch((err) => {
          console.error('[Translate] start download error:', err.message);
        });
        sendJson(200, { ok: true, downloadState: subtitleService.downloadState });
        return;
      }

      if (pathname === '/api/translate/download/cancel' && req.method === 'POST') {
        const state = subtitleService.cancelDownload();
        sendJson(200, { ok: true, downloadState: state });
        return;
      }

      // 4. 打开模型目录：与字幕服务同一个标准内置文件夹
      if (pathname === '/api/translate/open-dir' && req.method === 'POST') {
        try {
          fs.mkdirSync(SUBTITLE_MODELS_DIR, { recursive: true });
          spawn('open', [SUBTITLE_MODELS_DIR], { detached: true, stdio: 'ignore' }).unref();
          sendJson(200, { ok: true, path: SUBTITLE_MODELS_DIR });
        } catch (e) {
          sendJson(500, { ok: false, error: e.message });
        }
        return;
      }

      // 5. 预热 / 卸载快速模式进程
      if (pathname === '/api/translate/warmup' && req.method === 'POST') {
        try {
          await this.ensureQuickServer();
          this.touch();
          sendJson(200, { ok: true, status: await this.getStatus() });
        } catch (err) {
          sendJson(503, { ok: false, error: err.message, code: err.code || 'WARMUP_FAILED' });
        }
        return;
      }

      if (pathname === '/api/translate/unload' && req.method === 'POST') {
        if (this.inFlight > 0) {
          sendJson(409, { ok: false, reason: 'busy' });
          return;
        }
        this.stopQuickServer();
        sendJson(200, { ok: true, status: await this.getStatus() });
        return;
      }

      // 6. 直接调用（面板自检 / 其它入口）
      if (pathname === '/api/translate/run' && req.method === 'POST') {
        const body = await readJson();
        try {
          const result = await this.translate(body.text, body.mode === 'detail' ? 'detail' : 'quick');
          sendJson(200, { ok: true, ...result });
        } catch (err) {
          sendJson(400, { ok: false, code: err.code || 'TRANSLATE_FAILED', error: err.message });
        }
        return;
      }

      // 7. OpenAI 兼容网关：原生快捷翻译窗口的唯一入口
      //    请求体除标准字段外可带 mode=quick|detail，由本服务决定走小模型还是 DeepSeek/基础模型。
      if (pathname === '/api/translate/v1/chat/completions' && req.method === 'POST') {
        const body = await readJson();
        const messages = Array.isArray(body.messages) ? body.messages : [];
        const userMsg = [...messages].reverse().find((m) => m?.role === 'user');
        let text = typeof userMsg?.content === 'string' ? userMsg.content : '';
        if (!text && typeof body.input === 'string') text = body.input;
        const mode = body.mode === 'detail' ? 'detail' : 'quick';
        try {
          const result = await this.translate(text, mode);
          sendJson(200, {
            id: `chatcmpl-translate-${Date.now()}`,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: result.provider === 'quick' ? 'index-translate-2b' : result.model || result.provider,
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: result.text },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
            simpleui: { provider: result.provider, elapsedMs: result.elapsedMs, mode },
          });
        } catch (err) {
          // 保持 OpenAI 错误结构，原生侧能显示可读的原因
          sendJson(err.code === 'EMPTY_SOURCE' ? 400 : 502, {
            error: {
              message: err.message,
              code: err.code || 'TRANSLATE_FAILED',
            },
          });
        }
        return;
      }

      sendJson(404, { error: 'Unknown translate endpoint' });
    })().catch((err) => {
      console.error('[Translate] handleApi error:', err);
      sendJson(500, { error: err.message });
    });
  }
}

export const translateService = new TranslateService();
